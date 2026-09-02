/* Waiting for you: the decision overlay.

   One request at a time, in plain English, with what it costs and why it is
   being asked. It renders on all three views in the same slot, so a pending
   click follows the person instead of being left on the screen they came from.
   The receipt card and the unknown-outcome card land here too.

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

  var refs = {};
  var showing = null;
  var card = null;

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

  /* ---------- render ---------- */

  function boot() {
    refs.overlay = document.getElementById('overlay');
    refs.card = document.getElementById('overlay-card');
    store.select('proposals', render);
    dom.on(document, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      /* A pending ask cannot be dismissed with a key: the only ways out are Yes
         and No. A receipt can, because reading one changes nothing. */
      if (showing && showing.kind === 'ask') return;
      close();
    });
  }

  function render() {
    if (showing && showing.kind !== 'ask') return;
    var state = store.get() || {};
    var pending = (state.proposals || []).filter(function (p) {
      return p && (p.status === 'pending' || p.status === 'pending_unlock');
    });
    if (!pending.length) {
      if (showing && showing.kind === 'ask') close();
      return;
    }
    open({ kind: 'ask', proposal: pending[0], queued: pending.length - 1 });
  }

  function open(next) {
    showing = next;
    dom.clear(refs.card);
    if (next.kind === 'ask') buildAsk(next);
    else if (next.kind === 'receipt') buildReceipt(next.receipt);
    dom.setHidden(refs.overlay, false);
    window.PhosphorShell.updateField();
    var focusable = refs.card.querySelector('button');
    if (focusable) focusable.focus();
  }

  function close() {
    showing = null;
    dom.setHidden(refs.overlay, true);
    dom.clear(refs.card);
    window.PhosphorShell.updateField();
    render();
  }

  function buildAsk(entry) {
    var proposal = entry.proposal;
    var draft = proposal.draft || {};

    refs.card.appendChild(dom.el('p', 'label', 'Waiting for you'));
    refs.card.appendChild(dom.el('h2', 'title', headlineOf(proposal)));

    var amount = amountOf(proposal);
    if (amount !== null) {
      var big = dom.el('p', 'headline mono');
      dom.setText(big, dom.usd(amount));
      refs.card.appendChild(big);
    }

    var facts = dom.el('div', 'facts');
    var sim = proposal.simulation || {};
    addFact(facts, 'What it costs', costLine(proposal));
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

    if (draft.kind === 'policy_change') buildPolicyDiff(draft);

    if (proposal.status === 'pending_unlock') {
      var banner = dom.el('div', 'banner');
      banner.dataset.tone = 'warn';
      banner.appendChild(dom.el('span', '', 'The app is locked. This is queued and nothing happens until you unlock and decide.'));
      refs.card.appendChild(banner);
    }

    var error = dom.el('p', 'body down');
    error.hidden = true;
    refs.card.appendChild(error);

    var actions = dom.el('div', 'screen-actions');
    var no = dom.el('button', 'btn btn-danger');
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

    dom.on(yes, 'click', function () { decide(api.approve, proposal.id, [yes, no], error, yes, 'Approving'); });
    dom.on(no, 'click', function () { decide(api.refuse, proposal.id, [yes, no], error, no, 'Refusing'); });
  }

  function decide(route, id, buttons, errorNode, pressed, verb) {
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    errorNode.hidden = true;
    window.PhosphorShell.setPending(pressed, true, verb);
    route(id)
      .then(function () {
        return window.PhosphorShell.refresh({});
      })
      .then(function () {
        showing = null;
        dom.setHidden(refs.overlay, true);
        render();
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

  function whyLine(proposal) {
    var verdict = proposal.verdict || {};
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

  function buildPolicyDiff(draft) {
    var state = store.get() || {};
    var before = state.sentences || (state.policy && state.policy.sentences) || [];
    var after = draft.sentences || draft.afterSentences || [];
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

  /* ---------- the receipt and the unknown outcome ---------- */

  function buildReceipt(receipt) {
    window.PhosphorReceipt.fill(refs.card, receipt, close);
  }

  function showReceipt(receipt) {
    open({ kind: 'receipt', receipt: receipt });
  }

  window.PhosphorDecision = {
    boot: boot,
    showReceipt: showReceipt,
    close: close,
    diffOf: diffOf,
    refineDiff: refineDiff,
    headlineOf: headlineOf
  };
})();
