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

   Two parts, whatever it shows: a body that scrolls and a foot that does not.
   The buttons, the queue line and any error live in the foot, so they are on
   screen however long the card above them runs. A card that put Yes and No at
   the bottom of a scrolling region, behind a scrollbar macOS hides, was a card
   with no visible way to answer it (2026-09-18).

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

  /* The sentence src/view/basic.ts uses for the same address, word for word. A
     quoter-chosen address is never described as the person's own wallet. */
  var VENUE_CHOSE = 'an address the swap service chose, not your wallet';

  var refs = {};
  var showing = null;
  var held = null;
  var flashTimer = 0;

  /* A Touch ID dialog that closes without an answer puts the row back to
     pending and writes nothing on it. The dock remembers which row it last
     drew waiting on the sensor, so that row's next pending card can say the
     dialog closed and nothing moved, instead of coming back blank. */
  var touchSeen = null;
  var touchNote = null;

  /* A venue id is an enum. The one live venue is already in the headline
     ("inside NEAR Intents"), so a row naming it again would say the same thing
     twice and in the rail's spelling; the retired ones that older rows still
     carry get their words. */
  var VENUE_WORDS = { 'intents-native': null, 'oneclick': '1Click, on NEAR Intents', 'uniswap-v3': 'Uniswap v3' };

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
    /* A USD cap line carries no colon (src/policy/render.ts), so the pass above
       cannot pair it and four raised caps printed as four removals and then four
       additions, to pair by eye at the bottom of a scrolling card. Anything left
       over pairs on the sentence's own opening words instead, and prints as one
       line: what it was, then what it becomes. */
    var leftover = [];
    for (var k = 0; k < added.length; k += 1) if (!usedAdded[k]) leftover.push(added[k]);
    var loose = [];
    for (var m = 0; m < out.length; m += 1) {
      if (out[m].kind !== 'line' || out[m].sign !== '-') continue;
      var mate = -1;
      for (var n = 0; n < leftover.length; n += 1) {
        if (leftover[n] !== null && sharePrefix(out[m].text, leftover[n])) {
          mate = n;
          break;
        }
      }
      if (mate === -1) continue;
      out[m] = { kind: 'swapped', before: out[m].text, after: leftover[mate] };
      leftover[mate] = null;
    }
    for (var q = 0; q < leftover.length; q += 1) {
      if (leftover[q] !== null) loose.push({ kind: 'line', sign: '+', text: leftover[q] });
    }
    return out.concat(loose);
  }

  /* Two sentences about the same rule open with the same words and differ at the
     figure: "Refuse any single transaction above $100." against "... above
     $10,000.". Twelve characters is past every opening verb this app writes and
     short enough that a rule with one clause still matches. */
  var PREFIX_CHARS = 12;

  function sharePrefix(a, b) {
    var x = String(a);
    var y = String(b);
    if (x.length < PREFIX_CHARS || y.length < PREFIX_CHARS) return false;
    return x.slice(0, PREFIX_CHARS) === y.slice(0, PREFIX_CHARS);
  }

  /* ---------- headline ---------- */

  function headlineOf(proposal) {
    var draft = proposal.draft || {};
    if (draft.kind === 'swap') {
      /* Both legs sit inside NEAR Intents; chain and toChain name the assets'
         home chains, never a place the money goes. */
      return 'Swap ' + draft.fromSymbol + ' for ' + draft.toSymbol + ' inside NEAR Intents';
    }
    if (draft.kind === 'trade') return tradeHeadline(draft);
    /* Rows an older build wrote. Nothing proposes these any more; they still
       have to read as a sentence when the store hands one back. */
    if (draft.kind === 'consolidate') {
      return 'Gather ' + draft.symbol + ' onto ' + draft.toChain;
    }
    if (draft.kind === 'transfer' && draft.leg) {
      return 'Move ' + draft.leg.symbol + ' from ' + draft.leg.fromChain + ' to ' + draft.leg.toChain;
    }
    if (draft.kind === 'mandate_arm') {
      return draft.symbol ? 'Arm a trading rule on ' + draft.symbol : 'Arm a trading rule';
    }
    if (draft.kind === 'mandate') return 'Arm a rule';
    if (draft.kind === 'policy_change') return 'Change your limits';
    if (draft.kind === 'hl_deposit') return 'Fund the trading account';
    if (draft.kind === 'hl_withdraw') return 'Bring collateral back from trading';
    return kindWords(proposal.kind);
  }

  /* ---------- the trade card ---------- */

  /* The plan's own words: what opens, or what changes on a plan by its id. The
     numbers a person decides on are in tradeFacts below; the headline is the verb. */
  function tradeHeadline(draft) {
    if (draft.op === 'open') {
      var plan = draft.plan || {};
      var side = plan.side === 'short' ? 'short' : 'long';
      return plan.symbol ? 'Open a ' + side + ' on ' + plan.symbol : 'Open a ' + side;
    }
    var id = draft.id || 'the plan';
    if (draft.cancel === true) return 'Cancel ' + id;
    if (draft.close === true) return 'Close ' + id;
    var stop = typeof draft.stop === 'number';
    var target = typeof draft.target === 'number';
    if (stop && target) return 'Change the exits on ' + id;
    if (target) return 'Change the target on ' + id;
    return 'Change the stop on ' + id;
  }

  function px(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '';
    return String(value);
  }

  function entryText(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (entry.type === 'limit') return 'limit at ' + px(entry.px) + ', held by the exchange';
    if (entry.type === 'stop') return 'stop entry at ' + px(entry.px) + ', then up to ' + (entry.maxSlippageBps || 30) + ' bps';
    return 'market, up to ' + (entry.maxSlippageBps || 30) + ' bps slippage';
  }

  /* The risk facts, on every trade card. An open shows what the plan puts at
     stake and where it dies; a change shows the old figure and the new one side
     by side, because the difference is the whole decision. */
  function tradeFacts(host, draft) {
    if (draft.op === 'open') {
      var plan = draft.plan || {};
      var risk = draft.risk || {};
      addFact(host, 'Collateral at stake', dom.usd(risk.marginUsd) + ' isolated, at ' + (plan.leverage || '?') + 'x');
      addFact(host, 'Max loss at the stop', dom.usd(risk.maxLossUsd) + ' with fees');
      addFact(host, 'If the stop slips 10%', 'up to ' + dom.usd(risk.stopSlipUsd) + ' more');
      addFact(host, 'Entry', entryText(plan.entry));
      addFact(host, 'Stop', px(plan.stop));
      addFact(host, 'Target', typeof plan.target === 'number' ? px(plan.target) : 'none');
      addFact(host, 'Liquidation near', px(typeof risk.liquidationPx === 'number' ? Math.round(risk.liquidationPx * 100) / 100 : NaN));
      addFact(host, 'Expires', plan.expiresAt || '');
      return;
    }
    var before = draft.before || {};
    var after = draft.after || {};
    if (draft.cancel === true) {
      addFact(host, 'After this', 'Nothing is at risk.');
      return;
    }
    if (draft.close === true) {
      addFact(host, 'Collateral at stake', dom.usd(before.marginUsd));
      addFact(host, 'How', 'reduce only, at the market, within the plan bound');
      return;
    }
    if (typeof draft.stop === 'number') addFact(host, 'Stop', 'new ' + px(draft.stop));
    if (typeof draft.target === 'number') addFact(host, 'Target', 'new ' + px(draft.target));
    addFact(host, 'Max loss at the stop', 'from ' + dom.usd(before.maxLossUsd) + ' to ' + dom.usd(after.maxLossUsd));
    addFact(host, 'Liquidation near', px(typeof after.liquidationPx === 'number' ? Math.round(after.liquidationPx * 100) / 100 : NaN));
  }

  /* A kind nobody wrote a sentence for still has to read as a sentence. This is
     reachable: the store keeps rows naming kinds this app can no longer propose,
     yield_deposit and the two pool kinds among them, and one of those can still
     reach the unknown-outcome card. Underscores taken out is not a headline
     somebody wrote, but it is English, and the raw enum is not. */
  function kindWords(kind) {
    var words = String(kind === null || kind === undefined ? '' : kind).replace(/_/g, ' ').trim();
    if (!words) return 'A request';
    return words.charAt(0).toUpperCase() + words.slice(1);
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
    /* The Touch ID sentence under a card that is waiting on the sensor comes off
       the vault slice, which can move on its own when the dialog closes. */
    store.select('vault', function () {
      if (showing && showing.kind === 'ask') render();
    });
  }

  /* awaiting_touch is still waiting on the person: the click landed and the
     Touch ID dialog that names the move is up. The card stays, with its buttons
     dead, until the enclave answers or the dialog is cancelled. */
  function isWaiting(p) {
    return p && (p.status === 'pending' || p.status === 'pending_unlock' || p.status === 'awaiting_touch');
  }

  /* Filed rows ("Got it") stay unconfirmed in Activity and in the day's total; the dock
     just stops asking about them until the venue's word changes and the server unfiles them.
     A row that is still moving is not unread yet, however long it has taken: the live card
     below counts it, and this one only takes over once the view has stopped. */
  function isUnread(p) {
    if (!p || p.status !== 'needs_reconciliation' || p.acknowledgedAt) return false;
    return !p.view || p.view.terminal === true;
  }

  /* ASK 1: EVERY PENDING MOVE IS ON SCREEN WHILE IT RUNS.

     Karim, 2026-09-18, after approving a deposit: "the window showed no pending
     or animated feedback anywhere. No way to watch what was happening live."
     The dock used to go dark the moment a click landed, and the only thing that
     knew anything was the assistant's last read. A row whose view has not
     reached an end keeps the dock, drawn as the same card the conversation
     draws, so the two cannot say different things. */
  function isLive(p) {
    return !!(p && p.view && p.view.terminal !== true && !isWaiting(p) && !isHeld(p));
  }

  /* A row the preflight is holding: approved, nothing signed, the app retrying
     on its own. The dock shows it so the person who just clicked can see what
     it is waiting for; it asks nothing and offers no button. */
  function isHeld(p) {
    return p && p.status === 'approved' && typeof p.heldSince === 'string';
  }

  /* Newest on top. A request the assistant filed a second ago is the one the
     person is looking for; an older one that has waited this long can wait for
     the next click. */
  function newestFirst(list) {
    return list.slice().sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  /* The row the dock is holding, and the moment its buttons come back after a
     replacement. Both live here rather than on the entry, because they outlive
     any one card. */
  var pinned = null;
  var armAt = 0;
  var lastDrawn = null;

  function render() {
    /* An answer already given owns the dock until its own timer runs out, and a
       receipt or a recovery card is something a person is reading. */
    if (flashTimer) return;
    if (showing && showing.kind !== 'ask' && showing.kind !== 'unread' && showing.kind !== 'held' && showing.kind !== 'live') return;

    var state = store.get() || {};
    var list = Array.isArray(state.proposals) ? state.proposals : [];

    /* THE DOCK DOES NOT SWAP A CARD UNDER THE READER.

       It used to draw the newest waiting row, so a second request arriving while
       somebody read the first replaced it in place: the amount, the address and
       the kind all changed under a live Yes, with nothing saying so. A person
       reaching for the button approved a request they had never seen.

       The row the dock drew is pinned until it is answered or leaves the list.
       Anything newer is counted, and the count is a line at the top of the card
       that moves to the next one when it is tapped. */
    var waiting = newestFirst(list.filter(isWaiting));
    if (waiting.length) {
      var at = 0;
      for (var w = 0; w < waiting.length; w += 1) {
        if (waiting[w].id === pinned) at = w;
      }
      pinned = waiting[at].id;
      open({ kind: 'ask', proposal: waiting[at], queued: waiting.length - 1 });
      return;
    }
    pinned = null;

    var held = newestFirst(list.filter(isHeld));
    if (held.length) {
      open({ kind: 'held', proposal: held[0], queued: 0 });
      return;
    }

    var live = newestFirst(list.filter(isLive));
    if (live.length) {
      open({ kind: 'live', proposal: live[0], queued: 0 });
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
    /* The deposit address and the summary both arrive with the quote, which can
       land after the card is already up. A signature that ignored them would
       leave a person reading a card that had since learned where the money goes. */
    var deposits = Array.isArray(sim.depositAddresses) ? sim.depositAddresses.length : 0;
    var diff = sim.policyDiff ? (sim.policyDiff.after || []).length : 0;
    /* A held row redraws on every retry: each one appends its checks. */
    var checks = Array.isArray(p.preflight) ? p.preflight.length : 0;
    var swap = sim.swap || {};
    /* The view is what the live card draws, so a stage that moved is a redraw.
       The counter inside it runs on its own and needs no frame. */
    var view = p.view || {};
    return [entry.kind, p.id, p.status, view.stage || '', view.lastChangeAt || '', view.providerStage || '',
      entry.queued, sim.feeUsd, sim.gasUsd, p.heldSince || '', checks,
      sim.priceImpact, sim.amountOut, deposits, diff, sim.summary || '',
      swap.receives || '', swap.receivesAtLeast || '', swap.feeUsd, swap.etaSeconds,
      (Array.isArray(p.verdict && p.verdict.reasons) ? p.verdict.reasons.join(' ') : ''),
      (p.verdict && p.verdict.reason) || '',
      p.status === 'awaiting_touch' ? touchReason() : '',
      touchNote === p.id ? 'touch-note' : ''].join('|');
  }

  /* What the Touch ID dialog says, as the backend composed it. Shown under the
     dead Yes so the person can check the window and the dialog agree. */
  function touchReason() {
    var state = store.get() || {};
    var waiting = state.vault && state.vault.waiting;
    return waiting && typeof waiting.reason === 'string' ? waiting.reason : '';
  }

  function open(next) {
    if (next.kind === 'ask') noteTouch(next.proposal);
    var drawing = next.proposal ? String(next.proposal.id) : null;
    if (drawing !== null && lastDrawn !== null && drawing !== lastDrawn) armAt = Date.now() + REARM_MS;
    if (drawing !== null) lastDrawn = drawing;
    var keyed = next.kind === 'ask' || next.kind === 'unread' || next.kind === 'held' || next.kind === 'live';
    if (keyed && showing && showing.signature === signature(next)) return;
    next.signature = keyed ? signature(next) : null;
    showing = next;
    frame();
    if (next.kind === 'ask') buildAsk(next);
    else if (next.kind === 'live') buildLive(next.proposal);
    else if (next.kind === 'held') buildHeld(next.proposal);
    else if (next.kind === 'unread') buildUnread(next.proposal);
    else if (next.kind === 'receipt') buildReceipt(next.receipt);
    else if (next.kind === 'card') next.build(refs.body, close);
    /* Amber means a person still has to answer. A receipt and a recovery card
       are things to read, so they take the quiet edge instead. */
    dom.setAttr(refs.dock, 'data-state', dockState(next.kind));
    dom.setHidden(refs.dock, false);
    settle();
    window.PhosphorShell.updateField();
    hold(next.proposal);
  }

  function dockState(kind) {
    if (kind === 'receipt' || kind === 'card' || kind === 'held' || kind === 'live') return 'read';
    return null;
  }

  function close() {
    showing = null;
    touchSeen = null;
    touchNote = null;
    dom.setHidden(refs.dock, true);
    dom.setAttr(refs.dock, 'data-state', null);
    dom.setAttr(refs.card, 'data-more', null);
    dom.clear(refs.card);
    refs.body = null;
    refs.foot = null;
    refs.note = null;
    hold(null);
    window.PhosphorShell.updateField();
    render();
  }

  /* The dock holds an amber edge while a card is up, so the thing being decided
     is lit in the place it lives. The edge is one attribute on the surface
     (design/agent.css draws it), written here rather than by a separate layer
     that used to fly a dot to it. */
  function hold(proposal) {
    var want = proposal ? refs.dock : null;
    if (want === held) return;
    if (held) {
      dom.setAttr(held, 'data-glow', null);
      dom.setAttr(held, 'data-glow-tone', null);
    }
    if (want) {
      dom.setAttr(want, 'data-glow-tone', 'wait');
      dom.setAttr(want, 'data-glow', 'on');
    }
    held = want;
  }

  /* ---------- the ask ---------- */

  /* A send is the one ask whose card is drawn by another file: the same card
     the thread shows (ui/screens/sendcard.js), with the full address in
     groups, the chain, the fees and the receiver's history. The dock keeps
     what is its own: the lock banner, the error line and the buttons. */
  function isSend(draft) {
    return (draft.kind === 'intents_send' || draft.kind === 'intents_pay') && !!window.PhosphorSendCard;
  }

  /* Long enough that a tap already on its way down lands on nothing, short
     enough that a person who meant to press does not notice. */
  var REARM_MS = 600;

  function buildAsk(entry) {
    var proposal = entry.proposal;
    var draft = proposal.draft || {};
    var locked = proposal.status === 'pending_unlock';
    var touching = proposal.status === 'awaiting_touch';
    var send = isSend(draft);
    var body = refs.body;
    /* THE ANSWER COMES AFTER THE FACTS.

       The buttons used to live in the foot, which does not scroll, so at 390 a
       live Yes sat under a card whose recipient address and whose rule diff were
       both below the fold: the one control that mattered was reachable without
       reading the one fact that decided it. They are in the body now, in flow,
       under the amount, the pockets, the address and the changes. A person at
       390 scrolls past the address to reach Yes. The foot keeps what has to stay
       on screen whatever the scroll: what went wrong with a click. */
    var foot = body;

    /* One quiet line, at the top, for everything else that is waiting. It is the
       only way another request reaches this card, and it takes a tap. */
    if (entry.queued > 0) {
      var next = dom.el('button', 'dock-next');
      next.type = 'button';
      next.appendChild(dom.el('span', '', entry.queued === 1
        ? '1 more waiting, next'
        : entry.queued + ' more waiting, next'));
      next.appendChild(dom.el('span', 'chev'));
      dom.on(next, 'click', function () { showNext(proposal.id); });
      body.appendChild(next);
    }

    var rest = [];
    if (send) {
      var sendCard = window.PhosphorSendCard;
      body.id = 'dock-ask';
      body.appendChild(dom.el('p', 'label dock-kicker', locked ? 'Unlock to decide' : (touching ? 'Confirm on your Mac' : 'Waiting for you')));
      sendCard.build(body, sendCard.viewOf(proposal), { width: body.clientWidth });
      if (locked) body.appendChild(lockBanner());
    } else {
      rest = buildAskBody(body, proposal, draft, locked, touching) || [];
    }

    /* A request that arrived while the wallet was shut. It was authored and
       checked against the limits; what is missing is the ability to sign. So the
       card asks for the lock first and does not offer Yes, because a Yes it
       could not act on would be a click that did nothing. */
    if (locked) {
      var lockedActions = dom.el('div', 'dock-actions');
      var lockedNo = dom.el('button', 'btn btn-ghost');
      lockedNo.appendChild(dom.el('span', 'btn-label', 'No'));
      dom.setAttr(lockedNo, 'data-pending-label', 'Refusing');
      var unlock = dom.el('button', 'btn btn-primary');
      unlock.appendChild(dom.el('span', 'btn-label', 'Unlock'));
      lockedActions.appendChild(lockedNo);
      lockedActions.appendChild(unlock);
      foot.appendChild(lockedActions);

      dom.on(lockedNo, 'click', function () {
        decide(api.refuse, proposal.id, [lockedNo, unlock], lockedNo, 'Refused.', REFUSED_MS, null);
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
    dom.setAttr(no, 'data-pending-label', 'Refusing');
    var yes = dom.el('button', 'btn btn-primary');
    /* On a send the primary says what the click starts: the Touch ID dialog
       that names the receiver, on an enclave wallet, and plain approval on a
       password wallet. Every other ask keeps its one-word Yes. */
    var yesLabel = dom.el('span', 'btn-label', send ? (enclave() ? 'Approve, then Touch ID' : 'Approve') : 'Yes');
    yes.appendChild(yesLabel);
    dom.setAttr(yes, 'data-pending-label', 'Approving');
    /* The one thing in the window that breathes, and only while the answer is
       the person's to give: design/components.css draws it. */
    if (!locked && !touching) dom.setAttr(yes, 'data-live', 'true');
    actions.appendChild(no);
    actions.appendChild(yes);
    foot.appendChild(actions);
    /* The secondary lines come under the answer, closed. */
    if (rest.length) buildReport(body, 'The rest of it', rest.join('\n'), false);

    /* A card that has just replaced another one holds its buttons for 600 ms,
       so a tap already on its way down cannot land on a request nobody read.
       See render(): the dock pins a row, and this covers the moment it lets go. */
    if (armAt > Date.now()) {
      yes.disabled = true;
      no.disabled = true;
      var wait = armAt - Date.now();
      window.setTimeout(function () {
        if (!yes.isConnected) return;
        yes.disabled = false;
        no.disabled = false;
      }, wait);
    }

    /* The click has landed and the system dialog owns the moment. Both buttons
       go dead: a second Yes would be a second ask, and the backend only takes a
       No on a row that is pending. The dialog's own sentence sits under them so
       the window and the dialog can be checked against each other. It all comes
       back on the next frame, as approved or as pending again. */
    if (touching) {
      if (send) {
        /* The button is the waiting state now, so it stops reserving room for
           a swap it will not make and holds the fingerprint beside the word. */
        dom.setAttr(yes, 'data-pending-label', null);
        dom.clear(yes);
        yes.appendChild(window.PhosphorSendCard.fingerprint());
        yes.appendChild(dom.el('span', 'btn-label', 'Waiting for Touch ID'));
      } else {
        dom.setText(yesLabel, 'Touch ID: confirm on your Mac');
      }
      yes.disabled = true;
      no.disabled = true;
      dom.setAttr(yes, 'data-touch', 'true');
      foot.appendChild(dom.el('p', 'meta touch-reason',
        touchReason() || 'The Touch ID dialog is up. Confirm it there, or cancel to come back here.'));
      return;
    }

    /* Back from the sensor with no answer: the dialog was cancelled, timed out
       or the relay died. The row is pending again and the audit log knows why;
       the person who reached for the sensor gets told here, over live buttons. */
    if (touchNote === proposal.id) {
      say('warn', 'Touch ID closed without an answer. Nothing moved. Yes asks again.');
    }

    dom.on(yes, 'click', function () {
      decide(api.approve, proposal.id, [yes, no], yes, 'Approved.', DONE_MS, proposal.id);
    });
    dom.on(no, 'click', function () {
      decide(api.refuse, proposal.id, [yes, no], no, 'Refused.', REFUSED_MS, null);
    });
  }

  /* The reader asked for the next one. The pin moves on, the card is rebuilt
     from the next state frame's rows, and its buttons come back after the
     re-arm like any other replacement. */
  function showNext(currentId) {
    var state = store.get() || {};
    var list = Array.isArray(state.proposals) ? state.proposals : [];
    var waiting = newestFirst(list.filter(isWaiting));
    if (waiting.length < 2) return;
    var at = 0;
    for (var i = 0; i < waiting.length; i += 1) {
      if (waiting[i].id === currentId) at = i;
    }
    pinned = waiting[(at + 1) % waiting.length].id;
    showing = null;
    render();
  }

  /* Whether this wallet asks for a finger on a click: the vault slice says
     which custody the keystore has. Absent means the password path. */
  function enclave() {
    var state = store.get() || {};
    var vault = state.vault || {};
    return vault.custody === 'secure-enclave';
  }

  /* THE ASK IS THE CARD.

     Karim, 2026-09-18: the confirmation cards are "too noisy, badly formatted".
     The dock had its own grammar, so the same move looked like one thing while
     it was being decided and another thing while it ran.

     One shape for both. The dock draws the move card (screens/cards.js), with
     its two pockets, its figures in mono and its state word, and adds only what
     the decision needs: the fee, when the quote runs out, the address in full,
     and the two buttons. Everything the venue said folds. */
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function quoteOf(proposal) {
    var sim = proposal.simulation || {};
    return sim.quote && typeof sim.quote === 'object' ? sim.quote : null;
  }

  function expiryWords(quote) {
    if (!quote || !quote.expiresAt) return '';
    var left = Math.round((new Date(quote.expiresAt).getTime() - Date.now()) / 1000);
    if (!isFinite(left)) return '';
    if (left <= 0) return 'expired';
    return left < 90 ? left + 's' : Math.round(left / 60) + 'm';
  }

  /* The card wants a view. A proposal waiting on a person has not moved yet, so
     the window builds the one the backend would: waiting_for_you, the draft's
     own figures, and the quote's fee frozen as it was drawn. */
  function askView(proposal, draft) {
    /* The backend builds this for every row on the state frame, and it is the
       one that carries the sentence and the real clocks. The window only builds
       its own for a propose answer that has not reached a state frame yet. */
    if (isObject(proposal.view)) return proposal.view;
    var quote = quoteOf(proposal) || {};
    var sim = proposal.simulation || {};
    return {
      sentence: headlineOf(proposal),
      id: proposal.id, kind: draft.kind, stage: 'waiting_for_you',
      stageLabel: 'Waiting for you', providerStage: null, waitingOn: 'You',
      terminal: false, outcome: 'pending',
      createdAt: proposal.createdAt, decidedAt: null, settledAt: null,
      lastChangeAt: proposal.createdAt, elapsedSec: 0, sinceChangeSec: 0,
      typicalSec: typeof quote.etaSeconds === 'number' ? quote.etaSeconds : null,
      deadlineAt: null, correlationId: quote.handle || null, error: null, txs: [],
      money: {
        symbol: String(draft.symbol || draft.fromSymbol || ''),
        amountIn: typeof draft.amount === 'number' ? dom.qty(draft.amount) : null,
        feeUsd: typeof sim.feeUsd === 'number' ? sim.feeUsd : null,
        amountOut: typeof quote.amountOut === 'number' ? dom.qty(quote.amountOut) : null,
        fromPocket: null, toPocket: null, beforeUsd: null, afterUsd: null
      }
    };
  }

  /* THE APP'S OWN WORDS FOR THE MONEY AXES. The engine names them as fields;
     these are the same limits in the words the Basic screen already uses. */
  var AXIS_WORDS = {
    humanClickAboveUsd: 'Asks you above',
    maxPerTransactionUsd: 'Refuses above, at once',
    maxPerSessionUsd: 'Refuses above, in a day',
    autoApproveDailyUsd: 'Asks again once auto-approved moves pass'
  };

  /* THE APP'S OWN ARITHMETIC, BESIDE THE AGENT'S WORDS.

     One row per axis the patch moves, off verdict.changes: what it is, what it
     was, what it becomes, and the multiple when the jump is ten times or more.
     The engine computes these from the patch and the policy in force, so this
     is the one part of a rule-change card the agent cannot write. */
  function buildChanges(host, changes) {
    if (!Array.isArray(changes) || !changes.length) return false;
    var wrap = dom.el('div', 'stack-2 policy-diff');
    wrap.appendChild(dom.el('p', 'label', 'What changes'));
    for (var i = 0; i < changes.length; i += 1) {
      var c = changes[i];
      if (!c || typeof c.axis !== 'string') continue;
      var row = dom.el('div', 'axis-row');
      row.appendChild(dom.el('span', 'axis-name', AXIS_WORDS[c.axis] || c.axis));
      var figures = dom.el('span', 'axis-figures');
      figures.appendChild(dom.el('span', 'mono axis-before', dom.usd(c.before, 0)));
      figures.appendChild(dom.el('span', 'axis-to', 'to'));
      var after = dom.el('span', 'mono axis-after', dom.usd(c.after, 0));
      dom.setAttr(after, 'data-tone', c.after > c.before ? 'down' : 'up');
      figures.appendChild(after);
      /* Ten times or more is the jump a person has to be told about in one
         word, because four figures apart read as four figures. */
      if (typeof c.factor === 'number' && c.factor >= 10) {
        figures.appendChild(dom.el('span', 'mono axis-factor', Math.round(c.factor) + 'x'));
      }
      row.appendChild(figures);
      wrap.appendChild(row);
    }
    host.appendChild(wrap);
    return true;
  }

  /* The agent's sentence, under the app's arithmetic and named as the agent's.
     It used to be the first line on the card, which put the wording of the
     thing being judged above the judgement. */
  function buildSaid(host, sentence) {
    if (typeof sentence !== 'string' || sentence.trim() === '') return;
    var wrap = dom.el('div', 'stack-2 dock-said');
    wrap.appendChild(dom.el('p', 'label', 'The assistant said'));
    wrap.appendChild(dom.el('p', 'body dim', sentence));
    host.appendChild(wrap);
  }

  function buildAskBody(host, proposal, draft, locked, touching) {
    host.id = 'dock-ask';
    var cards = window.PhosphorCards;

    /* No kicker above the card. The dock's own amber edge says a person is being
       waited on, and the card says it again in its state word: three times in
       one card was the noise this rewrite exists to cut. The two states the
       edge cannot say get one line, because they are instructions. */
    if (locked || touching) {
      host.appendChild(dom.el('p', 'label dock-kicker', locked ? 'Unlock to decide' : 'Confirm on your Mac'));
    }

    var view = askView(proposal, draft);
    /* A rule change's first line is the app's, always. Every other kind keeps
       view.sentence, because the backend builds that one out of the draft's own
       fields; only a policy change's sentence is text the agent typed. */
    var policy = draft.kind === 'policy_change';
    var shown = policy ? Object.assign({}, view, { sentence: headlineOf(proposal) }) : view;
    if (cards && typeof cards.render === 'function') {
      var row = Object.assign({}, proposal, { view: shown });
      host.appendChild(cards.render('move', row, {
        name: 'proposal_status', input: { id: proposal.id }, at: proposal.createdAt, open: true
      }));
    } else {
      host.appendChild(dom.el('h2', 'title', shown.sentence || headlineOf(proposal)));
    }

    /* The arithmetic first, then the words that asked for it. */
    if (policy) {
      if (!buildChanges(host, view.changes)) buildPolicyDiff(host, proposal);
      buildSaid(host, view.sentence);
    }

    if (locked) host.appendChild(lockBanner());

    var left = expiryWords(quoteOf(proposal));
    if (left) {
      var note = dom.el('p', 'meta ask-expiry', left === 'expired'
        ? 'This quote has run out. Yes asks for a fresh one.'
        : 'This quote holds for ' + left + '.');
      if (left === 'expired') dom.setAttr(note, 'data-tone', 'down');
      host.appendChild(note);
    }

    if (draft.kind === 'trade' || draft.kind === 'trade_change') {
      var risk = dom.el('div', 'facts');
      tradeFacts(risk, draft);
      host.appendChild(risk);
    }

    var destinations = destinationsOf(proposal);
    if (destinations.length) {
      var dwrap = dom.el('div', 'stack-2 destinations');
      var stays = destinations.length === 1 && destinations[0].own;
      dwrap.appendChild(dom.el('p', 'label', stays ? 'Stays in your account' : 'Where it goes'));
      for (var d = 0; d < destinations.length; d += 1) {
        var drow = dom.el('div', 'destination');
        dom.setAttr(drow, 'data-chosen', destinations[d].chosenBy);
        drow.appendChild(dom.el('p', 'addr', destinations[d].address));
        drow.appendChild(dom.el('p', 'meta', destinations[d].label));
        dwrap.appendChild(drow);
      }
      host.appendChild(dwrap);
    }

    /* Handed back rather than drawn, because the fold holds only the secondary
       lines and it belongs under the answer, not between the facts and it. */
    var more = [];
    more.push('Why you are being asked: ' + whyLine(proposal));
    if (draft.venue) more.push('Through ' + venueWords(draft.venue));
    var summary = typeof (proposal.simulation || {}).summary === 'string' ? proposal.simulation.summary.trim() : '';
    if (summary && draft.kind !== 'policy_change') more.push(summary);
    return more;
  }

  function lockBanner() {
    var banner = dom.el('div', 'banner');
    banner.dataset.tone = 'warn';
    banner.appendChild(dom.el('span', '', 'The app is locked, so this is waiting. Nothing has moved and nothing will until you unlock and decide.'));
    return banner;
  }

  /* ---------- the venue's report ---------- */

  /* The rail's lines, whole, behind a toggle that says how many there are. The
     same fold the checks use: height through a grid track, so it opens as a
     motion. `open` is the starting state. The text stays one node: a plan's
     note rides inside the summary, and the card must not lift it out into a
     line of its own that could pass for a label. */
  function buildReport(host, word, summary, open) {
    var count = summary.split('\n').length;
    var section = dom.el('div', 'dock-report');
    var toggle = dom.el('button', 'dock-report-toggle');
    toggle.type = 'button';
    toggle.appendChild(dom.el('span', 'dock-report-word', word));
    toggle.appendChild(dom.el('span', 'dock-report-count', count === 1 ? '1 line' : count + ' lines'));
    toggle.appendChild(dom.el('span', 'dock-report-chevron'));
    section.appendChild(toggle);

    var fold = dom.el('div', 'dock-report-fold');
    var inner = dom.el('div', 'dock-report-inner');
    inner.appendChild(dom.el('p', 'body dock-summary', summary));
    fold.appendChild(inner);
    section.appendChild(fold);

    function apply() {
      dom.setAttr(section, 'data-open', open ? 'true' : 'false');
      dom.setAttr(toggle, 'aria-expanded', open ? 'true' : 'false');
    }
    dom.on(toggle, 'click', function () {
      open = !open;
      apply();
      /* The fold runs for 200 ms; the fade under the body follows it. */
      settle();
      window.setTimeout(settle, 240);
    });
    apply();
    host.appendChild(section);
  }

  /* ---------- the held row ---------- */

  /* A send draws its own card, which already carries the hold line and the
     folded checks. Any other kind gets the headline, the same hold line, and
     the checks under it. No buttons: there is nothing to decide. */
  /* ---------- the live row ---------- */

  /* The same card the conversation draws, in the dock, with nothing to press.
     One object, one set of words: the card and the assistant read the same view,
     so they cannot disagree about what stage this is at or when it settled. */
  function buildLive(proposal) {
    var host = refs.body;
    var cards = window.PhosphorCards;
    var view = proposal.view || {};
    host.appendChild(dom.el('p', 'label dock-kicker', view.waitingOn ? 'Waiting on ' + String(view.waitingOn) : 'Working'));
    if (!cards || typeof cards.render !== 'function') {
      host.appendChild(dom.el('h2', 'title', headlineOf(proposal)));
      host.appendChild(dom.el('p', 'body', String(view.stageLabel || '')));
      return;
    }
    host.appendChild(cards.render('move', proposal, {
      name: 'proposal_status',
      input: { id: proposal.id },
      at: proposal.createdAt,
      open: true
    }));
  }

  function buildHeld(proposal) {
    var draft = proposal.draft || {};
    var sendCard = window.PhosphorSendCard;
    var host = refs.body;
    if (isSend(draft)) {
      sendCard.build(host, sendCard.viewOf(proposal), { width: host.clientWidth });
      return;
    }
    host.appendChild(dom.el('p', 'label dock-kicker', 'Holding'));
    /* The move as a card rather than a headline, so the figures, the stage word
       and the counter are the same ones the conversation shows. */
    var cards = window.PhosphorCards;
    if (proposal.view && cards && typeof cards.render === 'function') {
      host.appendChild(cards.render('move', proposal, {
        name: 'proposal_status', input: { id: proposal.id }, at: proposal.createdAt, open: true
      }));
    } else {
      host.appendChild(dom.el('h2', 'title', headlineOf(proposal)));
    }
    var line = dom.el('p', 'body dock-hold');
    dom.setAttr(line, 'data-tone', 'warn');
    dom.setText(line, sendCard && typeof sendCard.heldLine === 'function' ? sendCard.heldLine(proposal) : 'Waiting for the checks to clear. Nothing is signed until they do.');
    host.appendChild(line);
    var checks = window.PhosphorChecks;
    var preflight = sendCard && typeof sendCard.preflightOf === 'function' ? sendCard.preflightOf(proposal) : null;
    if (preflight && checks && typeof checks.fold === 'function') checks.fold(host, preflight, {});
  }

  /* ---------- the unread outcome ---------- */

  /* The one state a person cannot act on alone: money may have left and the venue has not
     said where it landed. The dock keeps it up rather than filing it away, because the only
     thing that clears it is the venue: Reconcile asks again, and "Got it" files the card
     without settling anything (the row stays unconfirmed in Activity and in the day's total,
     and comes back the moment the venue says something new).

     THE CARD SAYS WHAT THE ROW KNOWS. The row's own sentence is the rail's observation plus
     the venue's last word ("1click reported FAILED and refunded 0 so far; the input is held
     by 1Click under handle ..."). A generic "we cannot read what happened" on top of that is
     a lie by omission, and it is what a person read on 2026-09-15 while the row underneath
     already knew. The generic line is kept only for a row that carries no sentence at all. */
  function unreadSentence(proposal) {
    var said = proposal && proposal.result && proposal.result.detail;
    if (typeof said === 'string' && said.trim()) return said.trim();
    return 'We sent this and we cannot read what happened to it. Do not send it again.';
  }

  function buildUnread(proposal) {
    var body = refs.body;
    var foot = refs.foot;
    body.appendChild(dom.el('p', 'label dock-kicker', 'Not confirmed.'));
    body.appendChild(dom.el('h2', 'title', headlineOf(proposal)));

    var banner = dom.el('div', 'banner');
    banner.dataset.tone = 'warn';
    banner.appendChild(dom.el('span', '', unreadSentence(proposal)));
    body.appendChild(banner);

    var handle = proposal.result && proposal.result.evidence && proposal.result.evidence.handle;
    if (handle) {
      var where = dom.el('p', 'body dim');
      dom.setText(where, 'Do not send it again. Quote handle ' + handle);
      body.appendChild(where);
    }

    var actions = dom.el('div', 'dock-actions');
    var again = dom.el('button', 'btn btn-primary');
    again.appendChild(dom.el('span', 'btn-label', 'Reconcile'));
    dom.setAttr(again, 'data-pending-label', 'Checking');
    actions.appendChild(again);
    var gotIt = dom.el('button', 'btn');
    gotIt.appendChild(dom.el('span', 'btn-label', 'Got it'));
    dom.setAttr(gotIt, 'data-pending-label', 'Filing');
    actions.appendChild(gotIt);
    foot.appendChild(actions);

    dom.on(again, 'click', function () {
      hush();
      window.PhosphorShell.setPending(again, true);
      api.reconcile(proposal.id)
        .then(function (answer) {
          /* Still unconfirmed is an answer, and the card stays up on it: closing would look
             like it had been settled. What it shows is the venue's word from this check, not
             a stock sentence about the chain. */
          if (answer && answer.status === 'needs_reconciliation') {
            var said = typeof answer.detail === 'string' && answer.detail.trim() ? answer.detail.trim() : null;
            dom.setText(banner.firstChild, said || unreadSentence(proposal));
            say('warn', said ? 'Checked again just now. Still unconfirmed, nothing to do here until the venue moves.' : 'Still no answer. Nothing has changed. Do not send it again.');
            return null;
          }
          return window.PhosphorShell.refresh({}).then(function () {
            showing = null;
            render();
          });
        })
        .catch(function (err) {
          say('down', net.readable(err));
        })
        .finally(function () {
          window.PhosphorShell.setPending(again, false);
        });
    });

    dom.on(gotIt, 'click', function () {
      hush();
      window.PhosphorShell.setPending(gotIt, true);
      api.acknowledge(proposal.id)
        .then(function () {
          return window.PhosphorShell.refresh({}).then(function () {
            showing = null;
            render();
          });
        })
        .catch(function (err) {
          say('down', net.readable(err));
        })
        .finally(function () {
          window.PhosphorShell.setPending(gotIt, false);
        });
    });
  }

  /* ---------- deciding ---------- */

  function decide(route, id, buttons, pressed, word, ms, receiptId) {
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    hush();
    touchNote = null;
    window.PhosphorShell.setPending(pressed, true);
    route(id)
      .then(function (answer) {
        return window.PhosphorShell.refresh({}).then(function () { return answer; });
      })
      .then(function (answer) {
        /* An enclave wallet answers a Yes with awaiting_touch: the dialog is up
           and nothing is decided. There is nothing to flash. The refreshed frame
           redraws this card in its waiting state, and render() is called again
           here in case that frame was one the cache had already seen. */
        if (answer && answer.status === 'awaiting_touch') {
          showing = null;
          render();
          return;
        }
        flash(word, ms, receiptId);
      })
      .catch(function (err) {
        /* The problem and the recovery, in the foot where the buttons are, so
           a card however long shows it without a scroll. The buttons come back
           only on failure: a click that landed leaves them dead until the next
           state frame, so a second click cannot ride on a stale render. */
        say('down', net.readable(err, true));
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
    frame();
    dom.setAttr(refs.dock, 'data-state', receiptId ? 'done' : 'refused');
    refs.body.appendChild(dom.el('h2', 'title', word));
    dom.setHidden(refs.dock, false);
    window.PhosphorShell.updateField();
    settle();
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

  /* ---------- the frame: a body that scrolls, a foot that does not ---------- */

  /* Every card the dock draws is built into these two. The body holds what a
     person reads and scrolls when the card is taller than its share of the
     column; the foot holds the answer (the note, the queue line, the buttons)
     and is always on screen. Rebuilt on every open: the reconciler's idea of
     what is on screen goes with the nodes it named. */
  function frame() {
    dom.clear(refs.card);
    dom.setAttr(refs.card, 'data-more', null);
    refs.body = dom.el('div', 'dock-body');
    refs.foot = dom.el('div', 'dock-foot');
    refs.note = null;
    refs.card.appendChild(refs.body);
    refs.card.appendChild(refs.foot);
    dom.on(refs.body, 'scroll', settle, { passive: true });
    if (typeof ResizeObserver === 'function') {
      if (!refs.sizes) refs.sizes = new ResizeObserver(settle);
      refs.sizes.disconnect();
      refs.sizes.observe(refs.body);
    }
  }

  /* Whether there is more card below the body's bottom edge. The card carries
     the answer as data-more, and the stylesheet fades the last lines into the
     foot while it is true: that fade is what tells a person the buttons sit
     under more card, on a platform whose scrollbars hide until touched. A
     document without layout (the tests) measures nothing and says nothing. */
  function settle() {
    var body = refs.body;
    if (!body || typeof body.scrollHeight !== 'number') return;
    var more = body.scrollHeight - body.clientHeight - body.scrollTop > 4;
    dom.setAttr(refs.card, 'data-more', more ? 'true' : null);
  }

  /* One line in the foot, above the buttons: the problem and the recovery,
     red for a click that did not land, amber for a state worth knowing. One
     node, reused, so two errors in a row do not stack. */
  function say(tone, text) {
    var foot = refs.foot;
    if (!foot) return;
    if (!refs.note) {
      refs.note = dom.el('div', 'banner dock-note');
      refs.note.setAttribute('role', 'status');
      refs.note.appendChild(dom.el('span', ''));
      foot.insertBefore(refs.note, foot.firstChild);
    }
    dom.setAttr(refs.note, 'data-tone', tone);
    dom.setText(refs.note.firstChild, text);
    refs.note.hidden = false;
  }

  function hush() {
    if (refs.note) refs.note.hidden = true;
  }

  /* The dock's memory of the sensor. A row drawn while awaiting_touch that
     comes back pending is a dialog that closed without an answer. */
  function noteTouch(proposal) {
    if (!proposal) return;
    if (proposal.status === 'awaiting_touch') {
      touchSeen = proposal.id;
      return;
    }
    if (proposal.status === 'pending' && touchSeen === proposal.id) touchNote = proposal.id;
    touchSeen = null;
  }

  /* ---------- the card's parts ---------- */

  /* A fact is a label and a value on one grid row, the value on the right. A
     wide one (a sentence, not a number) takes the row for itself, label over
     value, so it wraps as prose instead of as a ragged right-aligned column. */
  function addFact(host, label, value, tone, wide) {
    if (!value) return;
    var row = dom.el('div', wide ? 'fact fact--wide' : 'fact');
    row.appendChild(dom.el('span', 'label', label));
    var body = dom.el('span', 'body', value);
    if (tone) dom.setAttr(body, 'data-tone', tone);
    row.appendChild(body);
    host.appendChild(row);
  }

  /* A fee that can be under a cent keeps its digits (dom.fee); the rest of
     the card rounds to cents. */
  function money(value) {
    return typeof dom.fee === 'function' ? dom.fee(value) : dom.usd(value);
  }

  function etaWords(seconds) {
    var s = Math.max(0, Math.round(seconds));
    if (s < 60) return s + ' seconds';
    var m = Math.round(s / 60);
    return m === 1 ? 'a minute' : m + ' minutes';
  }

  /* The fee row. It reads the swap fields first, then the older slots a
     simulation might carry. When the rail priced nothing as a number the row
     says so in those words: "No fee was quoted." sat over a summary line that
     named the fee, and a card that contradicts itself is a card nobody can
     check. No simulation at all is its own sentence. */
  function costLine(proposal) {
    var sim = proposal.simulation;
    if (!sim) return 'Not quoted.';
    var swap = sim.swap || {};
    var parts = [];
    if (typeof swap.feeUsd === 'number') parts.push(money(swap.feeUsd) + ' in fees');
    else if (typeof sim.feeUsd === 'number') parts.push(money(sim.feeUsd) + ' in fees');
    if (typeof sim.gasUsd === 'number') parts.push(money(sim.gasUsd) + ' in network fees');
    if (typeof sim.priceImpact === 'number') parts.push(dom.pct(sim.priceImpact) + ' price impact');
    if (parts.length) return parts.join(', ');
    return sim.swap ? 'The venue did not price a fee.' : 'See what the venue reports, below.';
  }

  function venueWords(venue) {
    var id = String(venue);
    if (Object.prototype.hasOwnProperty.call(VENUE_WORDS, id)) return VENUE_WORDS[id];
    return id.replace(/[-_]+/g, ' ');
  }

  /* The engine writes `reasons`, an array, and has since the verdict type was
     written. This asked for `reason` and always fell through to the guess below,
     so a card built on a rule the person had never seen said "your limits say
     so" instead of naming the rule.

     The array is the engine's trail: a restatement of the move first ("swap of
     $2.00 to intents.near."), then the rule that fired. The card is asking why,
     so it shows the rule, which is the last line, and leaves the restatement
     to the headline that already says it. */
  function whyLine(proposal) {
    var verdict = proposal.verdict || {};
    if (Array.isArray(verdict.reasons) && verdict.reasons.length) {
      var last = String(verdict.reasons[verdict.reasons.length - 1]).trim();
      return last.charAt(0).toUpperCase() + last.slice(1);
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

  /* Where the money actually lands, every address in full, labelled by who chose
     it.

     This read `simulation.destinations`, a field no simulation has ever carried,
     so the only addresses on the card were the ones this app picked. The venue
     mints a fresh deposit address per quote, which is why it can never sit on an
     allowlist, and it is the address the funds are signed over to. The backend
     records it in `depositAddresses` for this card and says so in a comment.
     Showing the allowlisted leg while hiding that one is the exact shape of F2:
     an amount that was correct while the screen named the wrong destination. */
  function destinationsOf(proposal) {
    var draft = proposal.draft || {};
    var out = [];
    /* A swap inside the verifier credits the account it spends from: `to` is
       `from`. The address still goes on the card in full, but under words that
       say the money is not leaving, because a full 0x address under "Where it
       goes" reads as a send to somebody. */
    var own = typeof draft.from === 'string' ? draft.from.trim().toLowerCase() : '';
    pushDestination(out, draft.to, 'app', own);
    if (draft.leg) pushDestination(out, draft.leg.to, 'app', own);
    if (Array.isArray(draft.legs)) {
      for (var l = 0; l < draft.legs.length; l += 1) {
        pushDestination(out, draft.legs[l] && draft.legs[l].to, 'app', own);
      }
    }
    var sim = proposal.simulation;
    var deposits = sim && Array.isArray(sim.depositAddresses) ? sim.depositAddresses : [];
    for (var i = 0; i < deposits.length; i += 1) {
      pushDestination(out, deposits[i] && deposits[i].address, 'venue', own);
    }
    return out;
  }

  function pushDestination(out, address, chosenBy, own) {
    if (typeof address !== 'string') return;
    var clean = address.trim();
    if (!clean.length) return;
    for (var i = 0; i < out.length; i += 1) {
      if (out[i].address.toLowerCase() !== clean.toLowerCase()) continue;
      /* An address that is both is still one the venue minted, and under
         disclosing is the failure this whole function exists to prevent. */
      if (chosenBy === 'venue') {
        out[i].chosenBy = 'venue';
        out[i].own = false;
        out[i].label = VENUE_CHOSE;
      }
      return;
    }
    var isOwn = chosenBy === 'app' && !!own && clean.toLowerCase() === own;
    out.push({
      address: clean,
      chosenBy: chosenBy,
      own: isOwn,
      label: chosenBy === 'venue' ? VENUE_CHOSE : (isOwn ? 'your NEAR Intents account, the one it spends from' : 'the destination this app chose')
    });
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
  function buildPolicyDiff(host, proposal) {
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
      if (entry.kind === 'swapped') {
        var swapped = dom.el('div', 'axis-row');
        swapped.appendChild(dom.el('span', 'axis-name down', entry.before));
        var toWrap = dom.el('span', 'axis-figures');
        toWrap.appendChild(dom.el('span', 'axis-to', 'to'));
        toWrap.appendChild(dom.el('span', 'axis-after up', entry.after));
        swapped.appendChild(toWrap);
        wrap.appendChild(swapped);
        continue;
      }
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
    host.appendChild(wrap);
  }

  /* ---------- the receipt ---------- */

  function buildReceipt(receipt) {
    window.PhosphorReceipt.fill(refs.body, receipt, close);
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
