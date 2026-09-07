/* Waiting for you: the decision dock.

   One request at a time, in plain English, with what it costs and why it is
   being asked. It sits inside the conversation column between the transcript and
   the composer, so a person can ask the assistant about a request before
   deciding it, and it follows them across every mode because the column does.

   It is a region and not a modal. There is no Escape and no focus trap: the only
   ways out of a pending ask are No and Yes, and a card that stole the caret out
   of the composer every time a request landed would be taking the keyboard away
   from the one person it is asking.

   It draws from the server's pending list and from nothing else. It is the one
   region in the column in amber, so a transcript row cannot impersonate it.

   The policy diff logic is carried over from ui/approvals.js. It is real domain
   logic: a rendered sentence that carries a LIST is why an approval box used to
   fill with addresses, and a reader who has to spot one changed token inside
   twenty lines of hex is a reader who approves without checking. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  /* How long the answer stays on screen. Long enough after a yes for the receipt
     to arrive and be worth showing, short enough after a no that the dock is not
     sitting on a decision already made. */
  var DONE_MS = 6000;
  var REFUSED_MS = 2000;

  var refs = {};
  var showing = null;
  var held = null;
  var flashTimer = 0;

  /* ---------- the policy diff, carried over ---------- */

  function diffOf(before, after) {
    var b = before || [];
    var a = after || [];
    var removed = [];
    var added = [];
    var i;
    for (i = 0; i < b.length; i += 1) if (a.indexOf(b[i]) === -1) removed.push(b[i]);
    for (i = 0; i < a.length; i += 1) if (b.indexOf(a[i]) === -1) added.push(a[i]);
    return { removed: removed, added: added };
  }

  /* Splitting on the first colon is enough: every sentence the server writes
     puts the rule name before it and the values after. Anything that does not
     fit that shape falls through and is printed whole, the safe direction. */
  function splitRule(line) {
    var text = String(line);
    var at = text.indexOf(':');
    if (at === -1) return null;
    var items = text.slice(at + 1).split(',');
    var cleaned = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i].trim().replace(/\.$/, '');
      if (item.length > 0) cleaned.push(item);
    }
    if (cleaned.length < 2) return null;
    return { label: text.slice(0, at).trim(), items: cleaned };
  }

  function refineDiff(diff) {
    var out = [];
    var removed = diff.removed.slice();
    var added = diff.added.slice();
    var usedAdded = {};

    for (var r = 0; r < removed.length; r += 1) {
      var beforeRule = splitRule(removed[r]);
      var matched = -1;
      if (beforeRule) {
        for (var a = 0; a < added.length; a += 1) {
          if (usedAdded[a]) continue;
          var afterRule = splitRule(added[a]);
          if (afterRule && afterRule.label === beforeRule.label) {
            matched = a;
            break;
          }
        }
      }
      if (matched === -1) {
        out.push({ kind: 'line', sign: '-', text: removed[r] });
        continue;
      }
      usedAdded[matched] = true;
      var afterItems = splitRule(added[matched]).items;
      var gained = [];
      var lost = [];
      var j;
      for (j = 0; j < afterItems.length; j += 1) {
        if (beforeRule.items.indexOf(afterItems[j]) === -1) gained.push(afterItems[j]);
      }
      for (j = 0; j < beforeRule.items.length; j += 1) {
        if (afterItems.indexOf(beforeRule.items[j]) === -1) lost.push(beforeRule.items[j]);
      }
      out.push({
        kind: 'changed',
        label: beforeRule.label,
        gained: gained,
        lost: lost,
        unchanged: afterItems.length - gained.length
      });
    }
    for (var k = 0; k < added.length; k += 1) {
      if (!usedAdded[k]) out.push({ kind: 'line', sign: '+', text: added[k] });
    }
    return out;
  }

  /* ---------- headline ---------- */

  function headlineOf(proposal) {
    var draft = proposal.draft || {};
    if (draft.kind === 'consolidate') {
      return 'Gather ' + draft.symbol + ' onto ' + draft.toChain;
    }
    if (draft.kind === 'transfer' && draft.leg) {
      return 'Move ' + draft.leg.symbol + ' from ' + draft.leg.fromChain + ' to ' + draft.leg.toChain;
    }
    if (draft.kind === 'swap') {
      var where = draft.chain === draft.toChain
        ? 'on ' + draft.chain
        : draft.chain + ' to ' + draft.toChain;
      return 'Swap ' + draft.fromSymbol + ' for ' + draft.toSymbol + ' ' + where;
    }
    if (draft.kind === 'mandate') return 'Arm a rule';
    if (draft.kind === 'policy_change') return 'Change your limits';
    if (draft.kind === 'yield_deposit') return 'Put money to work';
    if (draft.kind === 'yield_withdraw') return 'Bring earnings back';
    if (draft.kind === 'hl_deposit') return 'Fund the trading account';
    return String(proposal.kind || 'A request');
  }

  function amountOf(proposal) {
    var draft = proposal.draft || {};
    if (typeof draft.amountUsd === 'number') return draft.amountUsd;
    if (draft.leg && typeof draft.leg.amountUsd === 'number') return draft.leg.amountUsd;
    if (typeof draft.maxTotalUsd === 'number') return draft.maxTotalUsd;
    return null;
  }

  /* ---------- what is on the dock ---------- */

  function boot() {
    refs.dock = document.getElementById('overlay');
    refs.card = document.getElementById('overlay-card');
    store.select('proposals', render);
  }

  function isWaiting(p) {
    return p && (p.status === 'pending' || p.status === 'pending_unlock');
  }

  function isUnread(p) {
    return p && p.status === 'needs_reconciliation';
  }

  /* Newest on top. A request the assistant filed a second ago is the one the
     person is looking for; an older one that has waited this long can wait for
     the next click. */
  function newestFirst(list) {
    return list.slice().sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  function render() {
    /* An answer already given owns the dock until its own timer runs out, and a
       receipt or a recovery card is something a person is reading. */
    if (flashTimer) return;
    if (showing && showing.kind !== 'ask' && showing.kind !== 'unread') return;

    var state = store.get() || {};
    var list = Array.isArray(state.proposals) ? state.proposals : [];

    var waiting = newestFirst(list.filter(isWaiting));
    if (waiting.length) {
      open({ kind: 'ask', proposal: waiting[0], queued: waiting.length - 1 });
      return;
    }

    var unread = newestFirst(list.filter(isUnread));
    if (unread.length) {
      open({ kind: 'unread', proposal: unread[0], queued: 0 });
      return;
    }

    if (showing) close();
  }

  /* Everything the card draws that a later state frame can change. A heartbeat
     that rebuilt the card would restart its enter and drop the focus a person
     had put on No. */
  function signature(entry) {
    var p = entry.proposal || {};
    var sim = p.simulation || {};
    var destinations = Array.isArray(sim.destinations) ? sim.destinations.length : 0;
    return [entry.kind, p.id, p.status, entry.queued, sim.feeUsd, sim.gasUsd,
      sim.priceImpact, sim.amountOut, destinations,
      (p.verdict && p.verdict.reason) || ''].join('|');
  }

  function open(next) {
    var keyed = next.kind === 'ask' || next.kind === 'unread';
    if (keyed && showing && showing.signature === signature(next)) return;
    next.signature = keyed ? signature(next) : null;
    showing = next;
    dom.clear(refs.card);
    if (next.kind === 'ask') buildAsk(next);
    else if (next.kind === 'unread') buildUnread(next.proposal);
    else if (next.kind === 'receipt') buildReceipt(next.receipt);
    else if (next.kind === 'card') next.build(refs.card, close);
    /* Amber means a person still has to answer. A receipt and a recovery card
       are things to read, so they take the quiet edge instead. */
    dom.setAttr(refs.dock, 'data-state', dockState(next.kind));
    dom.setHidden(refs.dock, false);
    window.PhosphorShell.updateField();
    hold(next.proposal);
  }

  function dockState(kind) {
    if (kind === 'receipt' || kind === 'card') return 'read';
    return null;
  }

  function close() {
    showing = null;
    dom.setHidden(refs.dock, true);
    dom.setAttr(refs.dock, 'data-state', null);
    dom.clear(refs.card);
    hold(null);
    window.PhosphorShell.updateField();
    render();
  }

  /* The world surface this request would touch holds an amber glow while the
     card is up, so the thing being decided is lit in the place it lives. Both
     halves are guarded: the beam is a separate file and the dock is the half a
     person cannot do without. */
  function hold(proposal) {
    var trace = window.PhosphorTrace;
    var beam = window.PhosphorBeam;
    var want = null;
    if (proposal && trace && typeof trace.surfaceForProposal === 'function') {
      var draft = proposal.draft || {};
      want = trace.surfaceForProposal(draft.kind || proposal.kind) || null;
    }
    if (want === held) return;
    if (beam && typeof beam.wait === 'function') {
      if (held) beam.wait(held, false);
      if (want) beam.wait(want, true);
    }
    held = want;
  }

  /* ---------- the ask ---------- */

  function buildAsk(entry) {
    var proposal = entry.proposal;
    var draft = proposal.draft || {};
    var locked = proposal.status === 'pending_unlock';

    refs.card.appendChild(dom.el('p', 'label', locked ? 'Unlock to decide' : 'Waiting for you'));
    refs.card.appendChild(dom.el('h2', 'title', headlineOf(proposal)));

    var amount = amountOf(proposal);
    if (amount !== null) {
      var big = dom.el('p', 'headline mono');
      dom.setText(big, dom.usd(amount));
      refs.card.appendChild(big);
    }

    var facts = dom.el('div', 'facts');
    var sim = proposal.simulation || {};
    /* A rule change and an armed mandate move nothing, so they have no cost, and
       "No fee was quoted." on a card about limits reads as a missing number
       rather than as an absent one. */
    if (draft.kind !== 'policy_change' && draft.kind !== 'mandate') {
      addFact(facts, 'What it costs', costLine(proposal));
    }
    if (draft.venue) addFact(facts, 'Through', String(draft.venue));
    if (sim && typeof sim.amountOut === 'number') {
      addFact(facts, 'You get about', dom.qty(sim.amountOut) + ' ' + (draft.toSymbol || ''));
    }
    addFact(facts, 'Why you are being asked', whyLine(proposal));
    refs.card.appendChild(facts);

    /* Where the money actually lands. This is the field with a track record:
       an amount that was correct while the screen said "your wallet" and the
       funds went to a solver-chosen address. It is never abbreviated. */
    var destinations = destinationsOf(proposal);
    if (destinations.length) {
      var dwrap = dom.el('div', 'stack-2 destinations');
      dwrap.appendChild(dom.el('p', 'label', 'Where it goes'));
      for (var d = 0; d < destinations.length; d += 1) {
        dwrap.appendChild(dom.el('p', 'addr', destinations[d]));
      }
      refs.card.appendChild(dwrap);
    }

    if (draft.kind === 'policy_change') buildPolicyDiff(proposal);

    var error = dom.el('p', 'body down');
    error.hidden = true;
    refs.card.appendChild(error);

    /* A request that arrived while the wallet was shut. It was authored and
       checked against the limits; what is missing is the ability to sign. So the
       card asks for the lock first and does not offer Yes, because a Yes it
       could not act on would be a click that did nothing. */
    if (locked) {
      var banner = dom.el('div', 'banner');
      banner.dataset.tone = 'warn';
      banner.appendChild(dom.el('span', '', 'The app is locked, so this is waiting. Nothing has moved and nothing will until you unlock and decide.'));
      refs.card.insertBefore(banner, error);

      var lockedActions = dom.el('div', 'dock-actions');
      var lockedNo = dom.el('button', 'btn btn-ghost');
      lockedNo.appendChild(dom.el('span', 'btn-label', 'No'));
      var unlock = dom.el('button', 'btn btn-primary');
      unlock.appendChild(dom.el('span', 'btn-label', 'Unlock'));
      lockedActions.appendChild(lockedNo);
      lockedActions.appendChild(unlock);
      refs.card.appendChild(lockedActions);

      dom.on(lockedNo, 'click', function () {
        decide(api.refuse, proposal.id, [lockedNo, unlock], error, lockedNo, 'Refusing', 'Refused.', REFUSED_MS, null);
      });
      dom.on(unlock, 'click', function () {
        /* The dock steps aside for the lock screen. It comes back on its own:
           render() runs on the next state frame, and by then this request is
           pending rather than pending_unlock. */
        showing = null;
        dom.setHidden(refs.dock, true);
        hold(null);
        window.PhosphorLock.focus();
      });
      return;
    }

    var actions = dom.el('div', 'dock-actions');
    var no = dom.el('button', 'btn btn-ghost');
    no.appendChild(dom.el('span', 'btn-label', 'No'));
    var yes = dom.el('button', 'btn btn-primary');
    yes.appendChild(dom.el('span', 'btn-label', 'Yes'));
    actions.appendChild(no);
    actions.appendChild(yes);
    refs.card.appendChild(actions);

    if (entry.queued > 0) {
      refs.card.appendChild(dom.el('p', 'meta', entry.queued === 1
        ? 'One more request after this one.'
        : entry.queued + ' more requests after this one.'));
    }

    dom.on(yes, 'click', function () {
      decide(api.approve, proposal.id, [yes, no], error, yes, 'Approving', 'Done.', DONE_MS, proposal.id);
    });
    dom.on(no, 'click', function () {
      decide(api.refuse, proposal.id, [yes, no], error, no, 'Refusing', 'Refused.', REFUSED_MS, null);
    });
  }

  /* ---------- the unread outcome ---------- */

  /* The one state a person cannot act on alone: the process died between
     "executing" and the rail's answer, so money may have left the wallet and may
     not have. The dock keeps it up rather than filing it away, because the only
     thing that clears it is asking the chain again. */
  function buildUnread(proposal) {
    refs.card.appendChild(dom.el('p', 'label', 'Checking what happened.'));
    refs.card.appendChild(dom.el('h2', 'title', headlineOf(proposal)));

    var banner = dom.el('div', 'banner');
    banner.dataset.tone = 'warn';
    banner.appendChild(dom.el('span', '', 'We sent this and we cannot read what happened to it. Do not send it again.'));
    refs.card.appendChild(banner);

    var error = dom.el('p', 'body down');
    error.hidden = true;
    refs.card.appendChild(error);

    var actions = dom.el('div', 'dock-actions');
    var again = dom.el('button', 'btn btn-primary');
    again.appendChild(dom.el('span', 'btn-label', 'Reconcile'));
    actions.appendChild(again);
    refs.card.appendChild(actions);

    dom.on(again, 'click', function () {
      window.PhosphorShell.setPending(again, true, 'Checking');
      api.reconcile(proposal.id)
        .then(function (answer) {
          /* Still unreadable is an answer, and the card stays up on it: closing
             would look like it had been settled. */
          if (answer && answer.status === 'needs_reconciliation') {
            dom.setText(error, 'Still no answer from the chain. Nothing has changed. Do not send it again.');
            error.hidden = false;
            return null;
          }
          return window.PhosphorShell.refresh({}).then(function () {
            showing = null;
            render();
          });
        })
        .catch(function (err) {
          dom.setText(error, net.readable(err));
          error.hidden = false;
        })
        .finally(function () {
          window.PhosphorShell.setPending(again, false);
        });
    });
  }

  /* ---------- deciding ---------- */

  function decide(route, id, buttons, errorNode, pressed, verb, word, ms, receiptId) {
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    errorNode.hidden = true;
    window.PhosphorShell.setPending(pressed, true, verb);
    route(id)
      .then(function () {
        return window.PhosphorShell.refresh({});
      })
      .then(function () {
        flash(word, ms, receiptId);
      })
      .catch(function (err) {
        dom.setText(errorNode, net.readable(err, true));
        errorNode.hidden = false;
        /* Re-enable only on failure. A click that landed leaves the buttons
           dead until the next state frame, so a second click cannot ride on a
           stale render. */
        for (var j = 0; j < buttons.length; j += 1) buttons[j].disabled = false;
      })
      .finally(function () {
        window.PhosphorShell.setPending(pressed, false);
      });
  }

  /* The answer, held on the dock for its own beat. A card that vanished on the
     click would leave a person unsure which button had landed, and the receipt
     is worth waiting a few seconds for. */
  function flash(word, ms, receiptId) {
    if (flashTimer) window.clearTimeout(flashTimer);
    showing = { kind: 'flash' };
    hold(null);
    dom.clear(refs.card);
    dom.setAttr(refs.dock, 'data-state', receiptId ? 'done' : 'refused');
    refs.card.appendChild(dom.el('h2', 'title', word));
    dom.setHidden(refs.dock, false);
    window.PhosphorShell.updateField();
    flashTimer = window.setTimeout(function () {
      flashTimer = 0;
      showing = null;
      if (receiptId) {
        showReceiptFor(receiptId);
        return;
      }
      close();
    }, ms);
  }

  /* The receipt carries the proposal's own id, so the row this dock just decided
     is the one that opens. Nothing to show is not a failure: a rail can take
     longer than the beat, and Activity has the row either way. */
  function showReceiptFor(id) {
    var receipts = window.PhosphorReceipts;
    if (!receipts || typeof receipts.load !== 'function') {
      close();
      return;
    }
    receipts.load().then(function (list) {
      var found = null;
      for (var i = 0; i < (list || []).length; i += 1) {
        if (list[i] && list[i].id === id) { found = list[i]; break; }
      }
      if (found) showReceipt(found);
      else close();
    }).catch(function () { close(); });
  }

  /* ---------- the card's parts ---------- */

  function addFact(host, label, value) {
    if (!value) return;
    var row = dom.el('div', 'fact');
    row.appendChild(dom.el('span', 'label', label));
    row.appendChild(dom.el('span', 'body', value));
    host.appendChild(row);
  }

  function costLine(proposal) {
    var sim = proposal.simulation;
    if (!sim) return 'Still working out what this costs.';
    var parts = [];
    if (typeof sim.feeUsd === 'number') parts.push(dom.usd(sim.feeUsd) + ' in fees');
    if (typeof sim.gasUsd === 'number') parts.push(dom.usd(sim.gasUsd) + ' in network fees');
    if (typeof sim.priceImpact === 'number') parts.push(dom.pct(sim.priceImpact) + ' price impact');
    return parts.length ? parts.join(', ') : 'No fee was quoted.';
  }

  /* The engine writes `reasons`, an array, and has since the verdict type was
     written. This asked for `reason` and always fell through to the guess below,
     so a card built on a rule the person had never seen said "your limits say
     so" instead of naming the rule. */
  function whyLine(proposal) {
    var verdict = proposal.verdict || {};
    if (Array.isArray(verdict.reasons) && verdict.reasons.length) {
      return verdict.reasons.join(' ');
    }
    if (verdict.reason) return String(verdict.reason);
    var amount = amountOf(proposal);
    var state = store.get() || {};
    var threshold = state.policy && state.policy.outbound
      ? state.policy.outbound.humanClickAboveUsd
      : null;
    if (amount !== null && typeof threshold === 'number' && amount > threshold) {
      return 'It is above the ' + dom.usd(threshold, 0) + ' you said to ask about.';
    }
    return 'Your limits say this one needs a click.';
  }

  function destinationsOf(proposal) {
    var draft = proposal.draft || {};
    var out = [];
    if (typeof draft.to === 'string') out.push(draft.to);
    if (draft.leg && typeof draft.leg.to === 'string') out.push(draft.leg.to);
    var sim = proposal.simulation;
    if (sim && Array.isArray(sim.destinations)) {
      for (var i = 0; i < sim.destinations.length; i += 1) {
        var value = sim.destinations[i];
        var text = typeof value === 'string' ? value : (value && value.address);
        if (text && out.indexOf(text) === -1) out.push(text);
      }
    }
    return out;
  }

  /* The rule change, as the engine rendered it either side of the patch.

     It comes off `simulation.policyDiff`, which is where the server has always
     put it. This read `draft.sentences`, a field no proposal has ever carried,
     so the one card in the window whose whole job is to show what a rule change
     does was showing nothing at all. The draft's own `sentence` is the
     assistant's wording and is deliberately NOT rendered here: the assistant
     does not get to write the ask it is asking about.

     The store's sentences are the fallback for the before, so a diff still
     renders if a simulation arrives without one. */
  function buildPolicyDiff(proposal) {
    var state = store.get() || {};
    var draft = proposal.draft || {};
    var sim = proposal.simulation || {};
    var rendered = sim.policyDiff || {};
    var before = rendered.before
      || state.sentences
      || (state.policy && state.policy.sentences)
      || [];
    var after = rendered.after || draft.sentences || draft.afterSentences || [];
    if (!after.length) return;
    var entries = refineDiff(diffOf(before, after));
    if (!entries.length) return;

    var wrap = dom.el('div', 'stack-2 policy-diff');
    wrap.appendChild(dom.el('p', 'label', 'What changes'));
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      if (entry.kind === 'line') {
        var line = dom.el('p', 'body ' + (entry.sign === '+' ? 'up' : 'down'));
        dom.setText(line, (entry.sign === '+' ? 'Added: ' : 'Removed: ') + entry.text);
        wrap.appendChild(line);
        continue;
      }
      var block = dom.el('div', 'stack-2');
      block.appendChild(dom.el('p', 'body strong', entry.label));
      for (var g = 0; g < entry.gained.length; g += 1) {
        block.appendChild(dom.el('p', 'addr up', '+ ' + entry.gained[g]));
      }
      for (var l = 0; l < entry.lost.length; l += 1) {
        block.appendChild(dom.el('p', 'addr down', '- ' + entry.lost[l]));
      }
      if (entry.unchanged > 0) {
        block.appendChild(dom.el('p', 'meta', entry.unchanged + ' unchanged'));
      }
      wrap.appendChild(block);
    }
    refs.card.appendChild(wrap);
  }

  /* ---------- the receipt ---------- */

  function buildReceipt(receipt) {
    window.PhosphorReceipt.fill(refs.card, receipt, close);
  }

  function showReceipt(receipt) {
    open({ kind: 'receipt', receipt: receipt, queued: 0 });
  }

  /* The same slot, filled by a caller. A request still outranks it: render()
     puts the decision back the moment this closes. */
  function showCard(build) {
    open({ kind: 'card', build: build, queued: 0 });
  }

  window.PhosphorDecision = {
    boot: boot,
    render: render,
    showReceipt: showReceipt,
    showCard: showCard,
    close: close,
    diffOf: diffOf,
    refineDiff: refineDiff,
    headlineOf: headlineOf
  };
})();
