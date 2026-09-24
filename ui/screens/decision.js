/* The decision: the part of a move card that asks.

   A move that needs the person is one card in the thread (ui/screens/cards.js), and this
   file draws the part of that card that decides: the figures a rule change or a trade is
   judged on, the lock and Touch ID lines, and Cancel and Approve. There is no dock any more.
   Karim, 2026-09-23: a status card covered the whole chat, and he did not know where to
   look. The card is where the move lives, so the question is asked there and nowhere else.

   The card calls ask() when a row first waits on the person and again only when askKey()
   changes, so a heartbeat never rebuilds a button under a finger. It reads the server's row
   and nothing else, and this is the only file that calls approve or refuse: nothing an
   assistant writes can draw these buttons.

   The policy diff logic is carried over from ui/approvals.js. It is real domain logic: a
   rendered sentence that carries a LIST is why an approval box used to fill with addresses,
   and a reader who has to spot one changed token inside twenty lines of hex is a reader who
   approves without checking. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  /* The sentence src/view/basic.ts uses for the same address, word for word. A
     quoter-chosen address is never described as the person's own wallet. */
  var VENUE_CHOSE = 'an address the swap service chose, not your wallet';

  /* A venue id is an enum. The one live venue is already in the card, so a line naming it
     again would say the same thing twice and in the rail's spelling; the retired ones that
     older rows still carry get their words. */
  var VENUE_WORDS = { 'intents-native': null, 'intents-relay': null, 'oneclick': '1Click, on NEAR Intents', 'uniswap-v3': 'Uniswap v3' };

  /* Long enough that a tap already on its way down lands on nothing when a card appears
     under the pointer, short enough that a person who meant to press does not notice. */
  var ARM_MS = 600;

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
       additions, to pair by eye. Anything left over pairs on the sentence's own
       opening words instead, and prints as one line: what it was, then what it
       becomes. */
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
    if (draft.kind === 'trade' || draft.kind === 'trade_change') return tradeHeadline(draft);
    if (draft.kind === 'policy_change') return 'Change your limits';
    if (draft.kind === 'hl_deposit') return 'Fund the trading account';
    if (draft.kind === 'hl_withdraw') return 'Bring collateral back from trading';
    return kindWords(draft.kind || proposal.kind);
  }

  /* The plan's own words: what opens, or what changes on a plan by its id. */
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

  /* A kind nobody wrote a sentence for still has to read as a sentence: the store keeps rows
     naming kinds this app can no longer propose. Underscores taken out is English, and the
     raw enum is not. */
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

  /* ---------- the trade's risk ---------- */

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

  /* One fact for the risk grid. A figure the engine did not price prints nothing (dom.usd),
     and a sentence built around the gap ("up to  more") is left out rather than shown with a
     hole in it. */
  function addFact(host, label, value) {
    var text = String(value || '');
    if (!text || text.charAt(0) === ' ' || /\s\s/.test(text) || /\sto\s*$/.test(text)) return;
    host.push([label, text]);
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

  /* Label at the left, the figure at the right, no rule between the rows. */
  function factGrid(facts) {
    var grid = dom.el('div', 'mcard-grid');
    for (var i = 0; i < facts.length; i += 1) {
      grid.appendChild(dom.el('span', 'mcard-grid-label', facts[i][0]));
      grid.appendChild(dom.el('span', 'mcard-grid-value num', facts[i][1]));
    }
    return grid;
  }

  /* ---------- whose row, and whether it waits ---------- */

  /* awaiting_touch is still waiting on the person: the click landed and the Touch ID dialog
     that names the move is up. */
  function isWaiting(p) {
    return !!p && (p.status === 'pending' || p.status === 'pending_unlock' || p.status === 'awaiting_touch');
  }

  /* Whether this wallet asks for a finger on a click: the vault slice says which custody the
     keystore has. Absent means the password path. */
  function enclave() {
    var state = store.get() || {};
    var vault = state.vault || {};
    return vault.custody === 'secure-enclave';
  }

  /* What the Touch ID dialog says, as the backend composed it, so the window and the dialog
     can be checked against each other. */
  function touchReason() {
    var state = store.get() || {};
    var waiting = state.vault && state.vault.waiting;
    return waiting && typeof waiting.reason === 'string' ? waiting.reason : '';
  }

  /* A Touch ID dialog that closes without an answer puts the row back to pending and writes
     nothing on it. The last row seen on the sensor is remembered, so its next ask can say the
     dialog closed and nothing moved, instead of coming back blank. */
  var touchSeen = null;
  var touchNote = null;

  function noteTouch(proposal) {
    if (proposal.status === 'awaiting_touch') {
      touchSeen = proposal.id;
      return;
    }
    if (proposal.status === 'pending' && touchSeen === proposal.id) touchNote = proposal.id;
    if (touchSeen === proposal.id) touchSeen = null;
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

  /* Everything the ask draws that a later state frame can change. A frame that rebuilt the
     buttons would restart their breath and drop the focus a person had put on Cancel. */
  function askKey(proposal) {
    var p = proposal || {};
    if (!isWaiting(p)) return '';
    noteTouch(p);
    var sim = p.simulation || {};
    var diff = sim.policyDiff ? (sim.policyDiff.after || []).length : 0;
    var view = p.view || {};
    return [p.id, p.status, sim.feeUsd, sim.summary || '', diff,
      (Array.isArray(view.changes) ? view.changes.length : 0),
      (Array.isArray(p.verdict && p.verdict.reasons) ? p.verdict.reasons.join(' ') : ''),
      touchNote === p.id ? 'touch-note' : '',
      expiryWords(quoteOf(p)) === 'expired' ? 'expired' : ''].join('|');
  }

  /* ---------- the ask ---------- */

  /* THE APP'S OWN WORDS FOR THE MONEY AXES. The engine names them as fields; these are the
     same limits in the words the Basic screen already uses. */
  var AXIS_WORDS = {
    humanClickAboveUsd: 'Asks you above',
    maxPerTransactionUsd: 'Refuses above, at once',
    maxPerSessionUsd: 'Refuses above, in a day',
    autoApproveDailyUsd: 'Asks again once auto-approved moves pass'
  };

  /* THE APP'S OWN ARITHMETIC, BESIDE THE AGENT'S WORDS. One row per axis the patch moves,
     off the view's changes: what it is, what it was, what it becomes, and the multiple when
     the jump is ten times or more. The engine computes these, so this is the one part of a
     rule-change card the agent cannot write. */
  function buildChanges(host, changes) {
    if (!Array.isArray(changes) || !changes.length) return false;
    var wrap = dom.el('div', 'policy-diff');
    for (var i = 0; i < changes.length; i += 1) {
      var c = changes[i];
      if (!c || typeof c.axis !== 'string') continue;
      var row = dom.el('div', 'axis-row');
      row.appendChild(dom.el('span', 'axis-name', AXIS_WORDS[c.axis] || c.axis));
      var figures = dom.el('span', 'axis-figures');
      figures.appendChild(dom.el('span', 'num axis-before', dom.usd(c.before, 0)));
      figures.appendChild(dom.el('span', 'axis-to', 'to'));
      var after = dom.el('span', 'num axis-after', dom.usd(c.after, 0));
      dom.setAttr(after, 'data-tone', c.after > c.before ? 'looser' : 'tighter');
      figures.appendChild(after);
      /* Ten times or more is the jump a person has to be told about in one word. */
      if (typeof c.factor === 'number' && c.factor >= 10) {
        figures.appendChild(dom.el('span', 'num axis-factor', Math.round(c.factor) + 'x'));
      }
      row.appendChild(figures);
      wrap.appendChild(row);
    }
    host.appendChild(wrap);
    return true;
  }

  /* The agent's sentence, under the app's arithmetic and named as the agent's. */
  function buildSaid(host, sentence) {
    if (typeof sentence !== 'string' || sentence.trim() === '') return;
    var wrap = dom.el('div', 'mcard-said');
    wrap.appendChild(dom.el('span', 'mcard-said-who', 'The assistant said'));
    wrap.appendChild(dom.el('p', 'mcard-said-text', sentence));
    host.appendChild(wrap);
  }

  /* The rule change, as the engine rendered it either side of the patch. It comes off
     `simulation.policyDiff`. The draft's own `sentence` is the assistant's wording and is
     deliberately NOT drawn here: the assistant does not get to write the ask it is asking
     about. The store's sentences are the fallback for the before. */
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

    var wrap = dom.el('div', 'policy-diff');
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      if (entry.kind === 'swapped') {
        var swapped = dom.el('div', 'axis-row');
        swapped.appendChild(dom.el('span', 'axis-name', entry.before));
        var toWrap = dom.el('span', 'axis-figures');
        toWrap.appendChild(dom.el('span', 'axis-to', 'to'));
        toWrap.appendChild(dom.el('span', 'axis-after', entry.after));
        swapped.appendChild(toWrap);
        wrap.appendChild(swapped);
        continue;
      }
      if (entry.kind === 'line') {
        var line = dom.el('p', 'policy-line');
        dom.setAttr(line, 'data-sign', entry.sign === '+' ? 'added' : 'removed');
        dom.setText(line, (entry.sign === '+' ? 'Added: ' : 'Removed: ') + entry.text);
        wrap.appendChild(line);
        continue;
      }
      var block = dom.el('div', 'policy-rule');
      block.appendChild(dom.el('p', 'policy-rule-name', entry.label));
      for (var g = 0; g < entry.gained.length; g += 1) {
        block.appendChild(dom.el('p', 'addr policy-gained', '+ ' + entry.gained[g]));
      }
      for (var l = 0; l < entry.lost.length; l += 1) {
        block.appendChild(dom.el('p', 'addr policy-lost', '- ' + entry.lost[l]));
      }
      if (entry.unchanged > 0) {
        block.appendChild(dom.el('p', 'policy-same', entry.unchanged + ' unchanged'));
      }
      wrap.appendChild(block);
    }
    host.appendChild(wrap);
  }

  /* The engine writes `reasons`, an array: a restatement of the move first, then the rule
     that fired. The card is asking why, so it shows the rule, which is the last line. */
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
    var limit = dom.usd(threshold, 0);
    if (amount !== null && typeof threshold === 'number' && amount > threshold && limit) {
      return 'It is above the ' + limit + ' you said to ask about.';
    }
    return 'Your limits say this one needs a click.';
  }

  /* Where the money actually lands, every address in full, labelled by who chose it. The
     venue mints a fresh deposit address per quote, which is why it can never sit on an
     allowlist, and it is the address the funds are signed over to: showing the allowlisted
     leg while hiding that one is the exact shape of F2, an amount that was correct while the
     screen named the wrong destination. */
  function destinationsOf(proposal) {
    var draft = proposal.draft || {};
    var out = [];
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
      /* An address that is both is still one the venue minted, and under disclosing is the
         failure this whole function exists to prevent. */
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
      label: chosenBy === 'venue' ? VENUE_CHOSE : (isOwn ? 'your balance, where it already is' : 'the destination this app chose')
    });
  }

  /* The address in the groups Add money prints it in (ui/screens/netpick.js chunks: "0x" and
     then fours for an EVM address, fours for a Solana key, a NEAR name whole), so it wraps as a
     set and a lone digit never sits on its own line. The first and the last group, the ones a
     person checks, are in the text colour and the rest a step quieter. */
  function addressLine(address) {
    var line = dom.el('p', 'addr sendcard-address');
    dom.setAttr(line, 'data-address', address);
    var groups = addressGroups(String(address));
    var first = groups[0] === '0x' ? 1 : 0;
    for (var i = 0; i < groups.length; i += 1) {
      var end = groups.length > 1 && (i === first || i === groups.length - 1);
      var tone = i < first ? ' addr-prefix' : (end ? ' addr-end' : ' addr-mid');
      line.appendChild(dom.el('span', 'sendcard-group' + (groups.length > 1 ? tone : ''), groups[i]));
    }
    return line;
  }

  function addressGroups(address) {
    var pick = window.PhosphorNetPick;
    if (pick && typeof pick.chunks === 'function') return pick.chunks(address);
    var out = [];
    var hex = /^0x[0-9a-fA-F]{40}$/.test(address);
    if (!hex && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return [address];
    if (hex) out.push('0x');
    for (var i = hex ? 2 : 0; i < address.length; i += 4) out.push(address.slice(i, i + 4));
    return out;
  }

  function venueWords(venue) {
    var id = String(venue);
    if (Object.prototype.hasOwnProperty.call(VENUE_WORDS, id)) return VENUE_WORDS[id];
    return id.replace(/[-_]+/g, ' ');
  }

  /* A sentence stands under its label and breaks between words; a figure or a name sits at the
     line's end. */
  function detailLine(label, value, sentence) {
    var row = dom.el('div', sentence ? 'tcard-line tcard-sentence' : 'tcard-line');
    row.setAttribute('data-wrap', 'true');
    row.appendChild(dom.el('span', 'tcard-line-label', label));
    row.appendChild(dom.el('span', 'tcard-line-value', value));
    return row;
  }

  /* The secondary lines, for the card's Details: why it asks, where the money goes, how long
     the price holds, the route, and the rail's own summary. True, and one click away. */
  function askDetails(proposal) {
    var draft = proposal.draft || {};
    var out = [detailLine('Why it asks', whyLine(proposal), true)];
    var destinations = destinationsOf(proposal);
    for (var d = 0; d < destinations.length; d += 1) {
      var where = dom.el('div', 'destination');
      dom.setAttr(where, 'data-chosen', destinations[d].chosenBy);
      where.appendChild(dom.el('span', 'tcard-line-label', destinations[d].own ? 'Stays in' : 'Goes to'));
      where.appendChild(addressLine(destinations[d].address));
      where.appendChild(dom.el('span', 'destination-who', destinations[d].label));
      out.push(where);
    }
    var left = expiryWords(quoteOf(proposal));
    if (left && left !== 'expired') out.push(detailLine('The price holds for', left));
    var through = draft.venue ? venueWords(draft.venue) : null;
    if (through) out.push(detailLine('Through', through));
    var summary = typeof (proposal.simulation || {}).summary === 'string' ? proposal.simulation.summary.trim() : '';
    if (summary && draft.kind !== 'policy_change') out.push(dom.el('p', 'tcard-note mcard-summary', summary));
    return out;
  }

  /* One line in the ask, under the buttons: the problem and the recovery after a click that
     did not land. One node, reused, so two errors in a row do not stack. */
  function say(note, text) {
    dom.setText(note, text);
    note.hidden = false;
  }

  function hush(note) {
    note.hidden = true;
  }

  /* Rows that have been asked about, and when, for the re-arm. */
  var firstAsked = {};

  /* THE ASK. What the card adds to its face for this kind, the row of buttons, and the lines
     for its Details. Cancel first, so the harmless answer is the one the hand reaches, and
     the two share the row rather than filling it. Approve breathes while the answer is the
     person's to give (components.css), and only then. */
  function ask(proposal) {
    var p = proposal || {};
    var draft = p.draft || {};
    var view = p.view || {};
    var locked = p.status === 'pending_unlock';
    var touching = p.status === 'awaiting_touch';
    var face = dom.el('div', 'mcard-ask-face');

    if (draft.kind === 'policy_change') {
      if (!buildChanges(face, view.changes)) buildPolicyDiff(face, p);
      if (view.sentence && view.sentence !== headlineOf(p)) buildSaid(face, view.sentence);
    }
    if (draft.kind === 'trade' || draft.kind === 'trade_change') {
      var risk = [];
      tradeFacts(risk, draft);
      if (risk.length) face.appendChild(factGrid(risk));
    }
    if (locked) face.appendChild(dom.el('p', 'mcard-ask-line', 'The app is locked, so this is waiting. Nothing moves until you unlock and decide.'));
    if (touching) face.appendChild(dom.el('p', 'mcard-ask-line mcard-touch', touchReason() || 'The Touch ID dialog is up. Confirm it there, or cancel it to come back here.'));
    if (!touching && touchNote === p.id) face.appendChild(dom.el('p', 'mcard-ask-line', 'Touch ID closed without an answer. Nothing moved. Approve asks again.'));
    if (expiryWords(quoteOf(p)) === 'expired') face.appendChild(dom.el('p', 'mcard-ask-line', 'This price has run out. Approve asks for a fresh one.'));

    var buttons = dom.el('div', 'mcard-buttons');
    var note = dom.el('p', 'mcard-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    var cancel = dom.el('button', 'btn btn-ghost mcard-cancel');
    cancel.type = 'button';
    cancel.appendChild(dom.el('span', 'btn-label', 'Cancel'));
    dom.setAttr(cancel, 'data-pending-label', 'Cancelling');
    var yes = dom.el('button', 'btn btn-primary mcard-approve');
    yes.type = 'button';
    buttons.appendChild(cancel);
    buttons.appendChild(yes);

    dom.on(cancel, 'click', function () {
      decide(api.refuse, p.id, [yes, cancel], cancel, note);
    });

    if (locked) {
      /* A request that arrived while the wallet was shut. It was checked against the limits;
         what is missing is the ability to sign, so the card asks for the lock first and offers
         no Approve it could not act on. */
      yes.appendChild(dom.el('span', 'btn-label', 'Unlock'));
      dom.on(yes, 'click', function () {
        if (window.PhosphorLock && typeof window.PhosphorLock.focus === 'function') window.PhosphorLock.focus();
      });
    } else if (touching) {
      /* The click has landed and the system dialog owns the moment. Both buttons go dead: a
         second Approve would be a second ask. It all comes back on the next frame. */
      yes.appendChild(dom.el('span', 'btn-label', 'Confirm on your Mac'));
      dom.setAttr(yes, 'data-touch', 'true');
      yes.disabled = true;
      cancel.disabled = true;
    } else {
      yes.appendChild(dom.el('span', 'btn-label', 'Approve'));
      dom.setAttr(yes, 'data-pending-label', enclave() ? 'Waiting for Touch ID' : 'Approving');
      dom.setAttr(yes, 'data-live', 'true');
      dom.on(yes, 'click', function () {
        touchNote = null;
        decide(api.approve, p.id, [yes, cancel], yes, note);
      });
    }

    /* A card that appears under a pointer holds its buttons for a beat, so a tap already on
       its way down cannot land on a request nobody read. */
    if (!Object.prototype.hasOwnProperty.call(firstAsked, p.id)) firstAsked[p.id] = Date.now();
    var wait = firstAsked[p.id] + ARM_MS - Date.now();
    if (wait > 0 && !touching) {
      yes.disabled = true;
      cancel.disabled = true;
      window.setTimeout(function () {
        if (yes.isConnected === false) return;
        yes.disabled = false;
        cancel.disabled = false;
      }, wait);
    }

    return { face: face.firstChild ? face : null, buttons: buttons, note: note, details: askDetails(p) };
  }

  /* ---------- deciding ---------- */

  /* The click and nothing after it: no flash, no receipt to close. The next state frame
     repaints the card in its new state (working, then done), where the person is already
     looking. The buttons stay dead after a click that landed, so a second click cannot ride
     on a stale render; they come back only on a failure, beside the line that says why. */
  function decide(route, id, buttons, pressed, note) {
    if (pressed && pressed.disabled) return;
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    hush(note);
    window.PhosphorShell.setPending(pressed, true);
    var landed = false;
    route(id)
      .then(function () {
        landed = true;
        return window.PhosphorShell.refresh({});
      })
      .catch(function (err) {
        if (landed) return;
        say(note, net.readable(err, true));
        for (var j = 0; j < buttons.length; j += 1) buttons[j].disabled = false;
      })
      .finally(function () {
        /* Letting go of the wait turns the button back on; a click that landed keeps both
           off until the frame that answers it redraws the card. */
        window.PhosphorShell.setPending(pressed, false);
        if (landed) for (var k = 0; k < buttons.length; k += 1) buttons[k].disabled = true;
      });
  }

  /* "Try again", where the view offers it: a quiet button that asks the assistant for the
     same move again, as the person's own message in the thread. The card never re-proposes on
     its own, and a new move is a new card with its own Approve. */
  function retryButton(proposal) {
    var agent = window.PhosphorAgent;
    if (!agent || typeof agent.send !== 'function') return null;
    var again = dom.el('button', 'btn btn-ghost btn-sm mcard-retry');
    again.type = 'button';
    again.appendChild(dom.el('span', 'btn-label', 'Try again'));
    dom.on(again, 'click', function () {
      again.disabled = true;
      agent.send(retryWords(proposal));
    });
    return again;
  }

  function retryWords(proposal) {
    var draft = (proposal && proposal.draft) || {};
    if (draft.kind === 'swap' && draft.fromSymbol && draft.toSymbol) {
      var amount = draft.amountInExact !== undefined ? draft.amountInExact : draft.amountIn;
      return 'Try that again: swap ' + (amount !== undefined ? amount + ' ' : '') + draft.fromSymbol + ' into ' + draft.toSymbol + '.';
    }
    return 'Try that again.';
  }

  /* ---------- a move the checks are holding ---------- */

  /* The newest preflight a row carries: the checks the app ran before it would sign. */
  function preflightOf(proposal) {
    var p = proposal && typeof proposal === 'object' ? proposal : {};
    var list = Array.isArray(p.preflight) ? p.preflight : [];
    for (var i = list.length - 1; i >= 0; i -= 1) {
      if (list[i] && typeof list[i] === 'object' && !Array.isArray(list[i])) return list[i];
    }
    return null;
  }

  /* What a held move waits on: an approved row the preflight is holding, nothing signed,
     stamped with when the hold began, and the newest preflight's reason, with how long it has
     waited in whole minutes. */
  function heldLine(proposal, now) {
    var p = proposal && typeof proposal === 'object' ? proposal : {};
    var fallback = 'Waiting for the checks to clear. Nothing is signed until they do.';
    if (p.status !== 'approved' || typeof p.heldSince !== 'string') return fallback;
    var preflight = preflightOf(p);
    var reason = preflight && preflight.holdReason ? String(preflight.holdReason) : 'Waiting for the checks to clear';
    var since = Date.parse(p.heldSince);
    if (!isFinite(since)) return reason + '. Nothing is signed until it clears.';
    var at = typeof now === 'number' && isFinite(now) ? now : Date.now();
    var minutes = Math.max(0, Math.floor((at - since) / 60000));
    return reason + ' (' + (minutes < 1 ? 'under a minute' : minutes + ' min') + '). Nothing is signed until it clears.';
  }

  /* ---------- a card another screen shows ---------- */

  /* The backup nudge, the recovery words and Turn off the assistant are cards other screens
     build. They sit in the thread, at its end, as the move cards do: nothing covers the
     conversation any more. `build(host, close)` fills the card and calls close when it is
     done with it. */
  function showCard(build, opts) {
    var agent = window.PhosphorAgent;
    if (agent && typeof agent.showCard === 'function') agent.showCard(build, opts);
  }

  /* The Touch ID sentence can move on its own when the dialog opens: the vault slice carries
     it, and every card waiting on the sensor takes the new words where it stands. */
  function boot() {
    if (!store || typeof store.select !== 'function') return;
    store.select('vault', function () {
      var reason = touchReason();
      if (!reason || typeof document.querySelectorAll !== 'function') return;
      var lines = document.querySelectorAll('.mcard-touch');
      for (var i = 0; i < lines.length; i += 1) dom.setText(lines[i], reason);
    });
  }

  window.PhosphorDecision = {
    boot: boot,
    ask: ask,
    askKey: askKey,
    retryButton: retryButton,
    heldLine: heldLine,
    preflightOf: preflightOf,
    showCard: showCard,
    diffOf: diffOf,
    refineDiff: refineDiff,
    headlineOf: headlineOf
  };
})();
