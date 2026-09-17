/* The cards the conversation draws from a tool's answer.

   When the assistant reads the wallet, the window used to see the reply the
   model typed: a table in white letters, the same numbers the app already
   holds. Karim, 2026-09-15: "when I ask how much I won it just prints a boring
   white table". Now the driver hands the window the answer itself
   (src/driver.ts, the tool_data event) and this file turns it into a card:
   holdings with their marks, positions with their profit in tone, a swap with
   a status chip, a deposit address with a button that opens the real card.
   The assistant's words stay short around it.

   Every card is built with PhosphorDom and strings set as text. Nothing here
   reads a value as markup, and the one button this file draws opens the
   deposit card, which decides nothing. The look lives in ui/design/cards.css:
   this file writes classes and data attributes, never a style. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PREFIX = 'mcp__phosphor__';

  /* The card glyphs, on the same 24 grid as ui/design/icons.js: a 1.5 px stroke,
     round caps, a soft fill under it. Drawn here rather than added to the shared
     sprite, because the sprite belongs to the foundation and a card should be
     able to draw its own head. */
  var GLYPHS = {
    /* A wallet: the fold and the clasp. */
    wallet: [
      'M3 8a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 19 8v9.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 3 17.5z',
      'M3 8a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 19 8v9.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 3 17.5zM14 10.5h7v5h-7a2.5 2.5 0 0 1 0-5zM16.5 13h.01'
    ],
    /* A line that goes somewhere, and the point it is at. */
    position: [
      'M3 17l5-6 4 3 4-6 5 3v9H3z',
      'M3 17l5-6 4 3 4-6 5 3M21 11a1.5 1.5 0 1 1 0 .01'
    ],
    /* Three lines and their dots: a list of facts. */
    list: [
      'M3 5h18v14H3z',
      'M8 7.5h12M8 12h12M8 16.5h12M4 7.5h.01M4 12h.01M4 16.5h.01'
    ],
    /* A chevron pointing right: the fold's own handle. */
    chevron: [
      '',
      'M9 6l6 6-6 6'
    ]
  };

  var CHAIN_NAMES = {
    eth: 'Ethereum',
    base: 'Base',
    arb: 'Arbitrum',
    sol: 'Solana',
    near: 'NEAR',
    intents: 'NEAR Intents',
    hyperliquid: 'Hyperliquid'
  };

  /* The cards, by the tool that answered. */
  var KINDS = {
    wallet: 'balance',
    trade_read: 'position',
    trade_batch: 'position',
    proposal_status: 'move',
    receipts: 'move',
    deposit: 'deposit'
  };

  var TITLES = {
    swap: 'Swap',
    trade: 'Trade',
    trade_change: 'Trade change',
    intents_deposit: 'Deposit',
    intents_withdraw: 'Withdraw',
    intents_send: 'Send',
    intents_pay: 'Pay',
    hl_deposit: 'Fund trading',
    hl_withdraw: 'Collateral back',
    policy_change: 'Rule change',
    consolidate: 'Consolidate',
    transfer: 'Transfer',
    lp_add: 'Add to a pool',
    lp_remove: 'Leave a pool',
    yield_deposit: 'Put to work',
    yield_withdraw: 'Take back'
  };

  /* The proposal's own states, as three the card can draw and the words for each. */
  var STAGES = {
    pending: ['pending', 'Waiting for you'],
    pending_unlock: ['pending', 'Needs the unlock'],
    awaiting_touch: ['pending', 'Touch ID'],
    approved: ['pending', 'Settling'],
    executing: ['pending', 'Settling'],
    needs_reconciliation: ['pending', 'Checking'],
    executed: ['confirmed', 'Confirmed'],
    failed: ['failed', 'Failed'],
    refused: ['failed', 'Declined'],
    policy_refused: ['failed', 'Refused']
  };

  var DEPOSIT_STATES = {
    show: ['watching', 'Ready'],
    watching: ['watching', 'Watching'],
    seen: ['seen', 'Seen'],
    landed: ['landed', 'Landed'],
    stopped: ['watching', 'Not watching']
  };

  var MAX_ROWS = 8;
  var MAX_FACTS = 10;

  /* ---------- small helpers ---------- */

  function bare(name) {
    var s = String(name || '');
    return s.indexOf(PREFIX) === 0 ? s.slice(PREFIX.length) : s;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function num(value) {
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function chainName(id) {
    var receipt = window.PhosphorReceipt;
    if (receipt && typeof receipt.chainName === 'function') return receipt.chainName(id);
    return CHAIN_NAMES[id] || String(id || '');
  }

  function glyph(name, className) {
    var parts = GLYPHS[name];
    if (typeof document.createElementNS !== 'function' || !parts) return dom.el('span', 'tcard-glyph');
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'tcard-glyph' + (className ? ' ' + className : ''));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (parts[0]) {
      var fill = document.createElementNS(SVG_NS, 'path');
      fill.setAttribute('fill', 'currentColor');
      fill.setAttribute('fill-opacity', '0.2');
      fill.setAttribute('stroke', 'none');
      fill.setAttribute('d', parts[0]);
      svg.appendChild(fill);
    }
    var stroke = document.createElementNS(SVG_NS, 'path');
    stroke.setAttribute('fill', 'none');
    stroke.setAttribute('stroke', 'currentColor');
    stroke.setAttribute('stroke-width', '1.5');
    stroke.setAttribute('stroke-linecap', 'round');
    stroke.setAttribute('stroke-linejoin', 'round');
    stroke.setAttribute('d', parts[1]);
    svg.appendChild(stroke);
    return svg;
  }

  /* The shared icon set, for the heads that already have a drawn shape there. */
  function icon(name, className) {
    var icons = window.PhosphorIcons;
    if (icons && typeof icons.svg === 'function') return icons.svg(name, className);
    return dom.el('span', 'icon ' + (className || ''));
  }

  function logo(symbol, size) {
    var marks = window.PhosphorMarks;
    if (marks && typeof marks.logo === 'function') return marks.logo(symbol, size);
    return dom.el('span', 'logo', String(symbol || '').charAt(0));
  }

  function mono(className, text) {
    return dom.el('span', 'mono ' + (className || ''), text);
  }

  function signed(value) {
    var n = num(value);
    if (n === null) return '';
    return (n > 0 ? '+' : n < 0 ? '-' : '') + dom.usd(Math.abs(n));
  }

  function tone(value) {
    var n = num(value);
    if (n === null || n === 0) return 'flat';
    return n > 0 ? 'up' : 'down';
  }

  function clock(at) {
    var when = at instanceof Date ? at : new Date(typeof at === 'number' ? at : String(at || ''));
    if (isNaN(when.getTime())) return '';
    return when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  /* How long ago, in the fewest characters that still read: the head line
     has a title, a chip and a figure to fit beside it in a 440 px column. */
  function relative(at) {
    if (at === null || at === undefined || at === '') return '';
    var when = at instanceof Date ? at : new Date(typeof at === 'number' ? at : String(at));
    if (isNaN(when.getTime())) return '';
    var seconds = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000));
    if (seconds < 60) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.round(hours / 24);
    return days + 'd ago';
  }

  /* ONE CARD, AND IT FOLDS.

     Karim, 2026-09-15: "when a card is open in chat I cannot for some reason
     close it, bad UX again." So every card is a one-line head that says the
     whole thing (the icon, the title, a status chip, the figure, how long ago,
     a chevron) over a body that opens and closes under it. The head is the
     control: a click, Enter or Space toggles it, and the body's height runs
     through a grid track rather than a jump. The open state is the caller's
     (`opts.open`, `opts.onToggle`), so the conversation can keep it per block
     across every re-render. */
  function shell(kind, headIcon, title, opts) {
    var o = opts || {};
    var card = dom.el('section', 'tcard');
    card.setAttribute('data-card', kind);
    var open = o.open !== false;

    var head = dom.el('div', 'tcard-head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.appendChild(headIcon);
    head.appendChild(dom.el('span', 'tcard-title', title));
    if (o.chip) head.appendChild(o.chip);
    var figure = dom.el('span', 'tcard-figure mono', o.amount || '');
    if (o.tone) figure.setAttribute('data-tone', o.tone);
    dom.setHidden(figure, !o.amount);
    head.appendChild(figure);
    var when = dom.el('span', 'tcard-when', relative(o.at));
    dom.setHidden(when, !when.textContent);
    head.appendChild(when);
    head.appendChild(glyph('chevron', 'tcard-chevron'));
    card.appendChild(head);

    var fold = dom.el('div', 'tcard-fold');
    var inner = dom.el('div', 'tcard-fold-inner');
    var body = dom.el('div', 'tcard-body');
    inner.appendChild(body);
    fold.appendChild(inner);
    card.appendChild(fold);

    function apply() {
      card.setAttribute('data-open', open ? 'true' : 'false');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head.setAttribute('aria-label', (open ? 'Close ' : 'Open ') + title);
    }
    function setOpen(next) {
      var value = !!next;
      if (value === open) return;
      open = value;
      apply();
      if (typeof o.onToggle === 'function') o.onToggle(open);
    }
    function toggle() {
      setOpen(!open);
    }
    dom.on(head, 'click', toggle);
    dom.on(head, 'keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      toggle();
    });
    apply();

    var handle = { setOpen: setOpen, isOpen: function () { return open; }, toggle: toggle };
    card.__fold = handle;
    return { card: card, body: body, head: head, fold: handle };
  }

  function chip(state, label, withIcon) {
    var node = dom.el('span', 'tcard-chip');
    node.setAttribute('data-state', state);
    if (state === 'pending' || state === 'watching' || state === 'seen') {
      node.appendChild(dom.el('span', 'tcard-chip-dot'));
    } else if (withIcon) {
      node.appendChild(icon(withIcon, 'tcard-chip-icon'));
    }
    node.appendChild(dom.el('span', 'tcard-chip-label', label));
    return node;
  }

  function emptyLine(body, title, hint) {
    var wrap = dom.el('div', 'tcard-empty');
    wrap.appendChild(dom.el('div', 'tcard-empty-title', title));
    if (hint) wrap.appendChild(dom.el('div', 'tcard-empty-hint', hint));
    body.appendChild(wrap);
  }

  function moreLine(body, count, what) {
    if (count <= 0) return;
    body.appendChild(dom.el('div', 'tcard-more', 'and ' + count + ' more ' + what));
  }

  /* The count a cut array carries: src/driver.ts leaves `{ truncated: n }` as
     the last element of any list it shortened. The rows above never see it. */
  function split(list) {
    var rows = [];
    var dropped = 0;
    if (!Array.isArray(list)) return { rows: rows, dropped: dropped };
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (isObject(item) && typeof item.truncated === 'number' && Object.keys(item).length === 1) {
        dropped += item.truncated;
        continue;
      }
      rows.push(item);
    }
    return { rows: rows, dropped: dropped };
  }

  /* ---------- the balance card ---------- */

  /* One row per thing held, off the wallet report's rows (src/wallet.ts): a
     place, a quantity and a value. */
  function holdingsOf(data) {
    var parts = split(Array.isArray(data.rows) ? data.rows : []);
    var out = [];
    for (var i = 0; i < parts.rows.length; i += 1) {
      var h = parts.rows[i];
      if (!isObject(h)) continue;
      var quantity = num(h.quantity);
      var usd = num(h.valueUsd);
      if (quantity === null && usd === null) continue;
      out.push({
        symbol: String(h.symbol || '?'),
        place: String(h.chain || ''),
        quantity: quantity === null ? 0 : quantity,
        usd: usd === null ? 0 : usd,
        priced: h.priced !== false
      });
    }
    out.sort(function (a, b) { return b.usd - a.usd; });
    return { rows: out, dropped: parts.dropped };
  }

  function balanceCard(data, extra) {
    var held = holdingsOf(data);
    var total = num(data.totalUsd);
    if (total === null) {
      total = 0;
      for (var t = 0; t < held.rows.length; t += 1) total += held.rows[t].usd;
    }
    var parts = shell('balance', glyph('wallet'), 'What you hold', {
      amount: held.rows.length ? dom.usd(total) : '',
      at: extra.at,
      open: extra.open,
      onToggle: extra.onToggle
    });
    var body = parts.body;

    if (!held.rows.length) {
      emptyLine(body, 'Nothing here yet', 'Send USDC on Base or Solana to start. Ask for a deposit address and the window shows it.');
      return parts.card;
    }

    var list = dom.el('div', 'tcard-rows');
    var shown = held.rows.slice(0, MAX_ROWS);
    for (var i = 0; i < shown.length; i += 1) {
      var h = shown[i];
      var row = dom.el('div', 'tcard-row tcard-holding');
      row.appendChild(logo(h.symbol, 20));
      var name = dom.el('span', 'tcard-row-name');
      name.appendChild(dom.el('span', 'tcard-symbol', h.symbol));
      if (h.place) name.appendChild(dom.el('span', 'tcard-place', chainName(h.place)));
      row.appendChild(name);
      row.appendChild(mono('tcard-qty', dom.qty(h.quantity)));
      row.appendChild(mono('tcard-usd' + (h.priced ? '' : ' tcard-unpriced'), h.priced ? dom.usd(h.usd) : 'not priced'));
      list.appendChild(row);
    }
    body.appendChild(list);
    moreLine(body, held.rows.length - shown.length + held.dropped, 'assets');

    var foot = dom.el('div', 'tcard-total');
    foot.appendChild(dom.el('span', 'tcard-total-label', 'Total'));
    foot.appendChild(mono('tcard-total-value', dom.usd(total)));
    body.appendChild(foot);

    var stale = Array.isArray(data.stale) ? data.stale : [];
    if (stale.length) {
      var names = [];
      for (var s = 0; s < stale.length; s += 1) names.push(chainName(stale[s]));
      body.appendChild(dom.el('div', 'tcard-note tcard-note-warn', 'Could not read ' + names.join(', ') + ' just now.'));
    }
    return parts.card;
  }

  /* ---------- the position card ---------- */

  /* Positions, fills and the account, from a single read or from a batch whose
     entries each carry one of them. */
  function bookOf(data) {
    var positions = [];
    var fills = [];
    var account = null;
    var dropped = 0;
    function take(entry) {
      if (!isObject(entry)) return;
      if (Array.isArray(entry.positions)) {
        var p = split(entry.positions);
        positions = positions.concat(p.rows);
        dropped += p.dropped;
      }
      if (Array.isArray(entry.fills)) {
        var f = split(entry.fills);
        fills = fills.concat(f.rows);
      } else if (isObject(entry.fills) && Array.isArray(entry.fills.recent)) {
        fills = fills.concat(split(entry.fills.recent).rows);
      }
      if (isObject(entry.account)) account = entry.account;
    }
    take(data);
    if (Array.isArray(data.results)) {
      var results = split(data.results).rows;
      for (var i = 0; i < results.length; i += 1) take(results[i]);
    }
    return { positions: positions, fills: fills, account: account, dropped: dropped };
  }

  function positionRow(p) {
    var row = dom.el('div', 'tcard-row tcard-position');
    var coin = String(p.coin || p.symbol || '?');
    var side = p.side === 'short' ? 'short' : 'long';
    row.appendChild(logo(coin, 20));

    var name = dom.el('span', 'tcard-row-name');
    var line = dom.el('span', 'tcard-row-line');
    line.appendChild(dom.el('span', 'tcard-symbol', coin));
    var pill = dom.el('span', 'tcard-side', side);
    pill.setAttribute('data-side', side);
    line.appendChild(pill);
    name.appendChild(line);

    var facts = dom.el('span', 'tcard-row-facts mono');
    var size = num(p.sizeCoin);
    var notional = num(p.notionalUsd);
    var entry = num(p.entryPx);
    var mark = num(p.markPx);
    var lev = num(p.leverage);
    if (size !== null) facts.appendChild(dom.el('span', 'tcard-fact', dom.qty(size) + ' ' + coin + (notional !== null ? ' (' + dom.usd(notional, 0) + ')' : '')));
    if (entry !== null) facts.appendChild(dom.el('span', 'tcard-fact', 'in at ' + dom.qty(entry)));
    if (mark !== null) facts.appendChild(dom.el('span', 'tcard-fact', 'now ' + dom.qty(mark)));
    if (lev !== null && lev > 0) facts.appendChild(dom.el('span', 'tcard-fact', lev + 'x'));
    name.appendChild(facts);
    row.appendChild(name);

    var pnl = num(p.unrealisedUsd);
    var value = dom.el('span', 'tcard-pnl');
    value.setAttribute('data-tone', tone(pnl));
    value.appendChild(mono('tcard-pnl-usd', pnl === null ? '' : signed(pnl)));
    var roe = num(p.roePct);
    if (roe !== null) value.appendChild(mono('tcard-pnl-pct', (roe > 0 ? '+' : '') + roe.toFixed(1) + '%'));
    row.appendChild(value);
    return row;
  }

  function closedRow(f) {
    var row = dom.el('div', 'tcard-row tcard-closed');
    var coin = String(f.coin || '?');
    row.appendChild(logo(coin, 20));
    var name = dom.el('span', 'tcard-row-name');
    name.appendChild(dom.el('span', 'tcard-symbol', coin));
    var facts = dom.el('span', 'tcard-row-facts mono');
    var size = num(f.sizeCoin);
    var px = num(f.px);
    facts.appendChild(dom.el('span', 'tcard-fact', (f.side === 'sell' ? 'sold ' : 'bought ') + (size === null ? '' : dom.qty(size) + ' ') + coin));
    if (px !== null) facts.appendChild(dom.el('span', 'tcard-fact', 'at ' + dom.qty(px)));
    if (f.liquidation === true) facts.appendChild(dom.el('span', 'tcard-fact tcard-fact-warn', 'liquidated'));
    name.appendChild(facts);
    row.appendChild(name);
    var pnl = num(f.closedPnlUsd);
    var value = dom.el('span', 'tcard-pnl');
    value.setAttribute('data-tone', tone(pnl));
    value.appendChild(mono('tcard-pnl-usd', pnl === null ? '' : signed(pnl)));
    row.appendChild(value);
    return row;
  }

  function positionCard(data, extra) {
    var book = bookOf(data);
    var open = book.positions.filter(isObject);
    var closed = [];
    for (var c = 0; c < book.fills.length; c += 1) {
      var f = book.fills[c];
      if (isObject(f) && num(f.closedPnlUsd) !== null && num(f.closedPnlUsd) !== 0) closed.push(f);
    }
    var sum = 0;
    var priced = 0;
    for (var i = 0; i < open.length; i += 1) {
      var pnl = num(open[i].unrealisedUsd);
      if (pnl !== null) { sum += pnl; priced += 1; }
    }
    var parts = shell('position', glyph('position'), open.length ? 'Your positions' : 'Positions', {
      amount: priced > 0 ? signed(sum) : '',
      tone: priced > 0 ? tone(sum) : '',
      at: extra.at,
      open: extra.open,
      onToggle: extra.onToggle
    });
    var body = parts.body;

    if (!open.length && !closed.length) {
      var equity = book.account ? num(book.account.equityUsd) : null;
      emptyLine(body, 'No open positions', equity === null ? 'Nothing is at risk right now.' : dom.usd(equity) + ' of equity, nothing at risk.');
      return parts.card;
    }

    if (open.length) {
      var summary = dom.el('div', 'tcard-summary');
      summary.setAttribute('data-tone', tone(sum));
      if (priced > 0) {
        summary.appendChild(dom.el('span', 'tcard-summary-word', sum >= 0 ? 'Up' : 'Down'));
        summary.appendChild(mono('tcard-summary-value', dom.usd(Math.abs(sum))));
        summary.appendChild(dom.el('span', 'tcard-summary-tail', 'on ' + open.length + (open.length === 1 ? ' open position' : ' open positions')));
      } else {
        summary.appendChild(dom.el('span', 'tcard-summary-word', open.length + (open.length === 1 ? ' open position' : ' open positions')));
      }
      body.appendChild(summary);

      var list = dom.el('div', 'tcard-rows');
      var shown = open.slice(0, MAX_ROWS);
      for (var r = 0; r < shown.length; r += 1) list.appendChild(positionRow(shown[r]));
      body.appendChild(list);
      moreLine(body, open.length - shown.length + book.dropped, 'positions');
    }

    if (closed.length) {
      body.appendChild(dom.el('div', 'tcard-section', 'Closed'));
      var done = dom.el('div', 'tcard-rows');
      var recent = closed.slice(0, 5);
      for (var k = 0; k < recent.length; k += 1) done.appendChild(closedRow(recent[k]));
      body.appendChild(done);
      moreLine(body, closed.length - recent.length, 'closed');
    }
    return parts.card;
  }

  /* ---------- the move card: a swap, a trade, a deposit or a withdrawal ---------- */

  /* Everything the card needs, from any of the three shapes a move arrives in:
     the answer to a propose (an id, a status, a verdict and a simulation, with
     the tool's own input beside it), a proposal read back with its draft, or a
     receipt from the history surface. */
  function moveOf(name, input, data) {
    var args = isObject(input) ? input : {};
    var draft = isObject(data.draft) ? data.draft : null;
    /* A send's reply names its rail kind on the `send` facts (src/http/propose.ts), because
       one tool, propose_send, drafts either of two kinds and the tool name cannot say which. */
    var sendFacts = isObject(data.send) ? data.send : null;
    var kind = String((draft && draft.kind) || data.kind || (sendFacts && sendFacts.kind) || bare(name).replace(/^propose_/, '') || 'move');
    var move = {
      kind: kind,
      title: TITLES[kind] || 'Move',
      id: typeof data.id === 'string' ? data.id : '',
      from: null,
      to: null,
      feeUsd: null,
      quote: '',
      stage: 'pending',
      label: 'Waiting for your click',
      reason: '',
      at: data.decidedAt || data.at || data.createdAt || null,
      summary: ''
    };

    var status = typeof data.status === 'string' ? data.status : 'pending';
    var stage = STAGES[status] || STAGES.pending;
    move.stage = stage[0];
    move.label = stage[1];

    var sim = isObject(data.simulation) ? data.simulation : null;
    var verdict = isObject(data.verdict) ? data.verdict : null;
    var result = isObject(data.result) ? data.result : null;
    if (sim && typeof sim.summary === 'string') move.summary = sim.summary;
    if (typeof data.headline === 'string') move.summary = data.headline;

    /* The reason a move did not happen, in the plainest words on hand: the
       rule that refused it, the simulation that failed, or the rail's own line. */
    if (move.stage === 'failed') {
      if (status === 'policy_refused' && verdict && Array.isArray(verdict.reasons) && verdict.reasons.length) move.reason = String(verdict.reasons[0]);
      else if (status === 'refused') move.reason = 'You said no.';
      else if (result && typeof result.detail === 'string' && result.detail) move.reason = result.detail;
      else if (sim && typeof sim.error === 'string' && sim.error) move.reason = sim.error;
      else move.reason = 'The venue did not take it.';
    } else if (verdict && verdict.outcome === 'refuse') {
      move.stage = 'failed';
      move.label = 'Refused by a rule';
      move.reason = Array.isArray(verdict.reasons) && verdict.reasons.length ? String(verdict.reasons[0]) : 'A rule in the policy refused it.';
    } else if (sim && sim.ok === false && move.stage === 'pending') {
      move.stage = 'failed';
      move.label = 'Failed';
      move.reason = typeof sim.error === 'string' && sim.error ? sim.error : 'The simulation did not pass.';
    }

    /* The legs. A draft names them exactly; a propose's own arguments name
       them well enough; a receipt names them as what left and what arrived. */
    var d = draft || {};
    if (kind === 'swap') {
      var q = isObject(d.quote) ? d.quote : null;
      /* Both legs sit inside NEAR Intents: chain and toChain on a swap name the
         assets' home chains, not places the money goes. */
      move.from = { symbol: d.fromSymbol || args.fromSymbol, place: 'intents', amount: num(d.amountIn !== undefined ? d.amountIn : args.amountIn) };
      move.to = { symbol: d.toSymbol || args.toSymbol, place: 'intents', amount: q ? num(q.amountOut) : num(args.minAmountOut) };
      if (q) move.feeUsd = num(q.feeUsd);
      if (!q && num(args.minAmountOut) !== null) move.quote = 'at least ' + dom.qty(num(args.minAmountOut)) + ' ' + String(move.to.symbol || '');
    } else if (kind === 'intents_deposit') {
      move.from = { symbol: d.symbol || args.symbol, place: d.chain || args.chain, amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: d.symbol || args.symbol, place: 'intents', amount: num(d.minCredited) };
    } else if (kind === 'intents_withdraw') {
      move.from = { symbol: d.symbol || args.symbol, place: 'intents', amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: d.symbol || args.symbol, place: d.chain || args.chain, amount: num(d.minReceived) };
    } else if (kind === 'intents_send') {
      /* Both ends inside intents; the receiver's account is the fact this card exists to show. */
      move.from = { symbol: d.symbol || args.symbol, place: 'intents', amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: d.symbol || args.symbol, place: 'intents', amount: num(d.minReceived) };
      if (d.to || args.to) move.quote = 'to ' + String(d.to || args.to);
    } else if (kind === 'intents_pay') {
      /* Out of intents and onto a chain: the send card draws the address, this is the head. */
      var send = isObject(data.send) ? data.send : {};
      move.from = { symbol: d.symbol || send.symbol || args.symbol, place: 'intents', amount: num(d.amount !== undefined ? d.amount : (send.amount !== undefined ? send.amount : args.amount)) };
      move.to = { symbol: d.symbol || send.symbol || args.symbol, place: d.network || send.where || args.where, amount: num(d.minReceived) };
    } else if (kind === 'hl_deposit') {
      move.from = { symbol: d.symbol || args.symbol || 'USDC', place: 'intents', amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: 'USDC', place: 'hyperliquid', amount: num(d.minCredited) };
    } else if (kind === 'hl_withdraw') {
      move.from = { symbol: 'USDC', place: 'hyperliquid', amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: 'USDC', place: 'intents', amount: num(d.minReceived) };
    } else if (kind === 'trade' || kind === 'trade_change') {
      var plan = isObject(d.plan) ? d.plan : (isObject(args.plan) ? args.plan : null);
      if (plan) {
        move.title = (plan.side === 'short' ? 'Short ' : 'Long ') + String(plan.symbol || '');
        move.from = { symbol: 'USDC', place: 'hyperliquid', amount: num(plan.sizeUsd), usd: true, label: 'size' };
        var stop = num(plan.stop);
        var target = num(plan.target);
        var bits = [];
        if (num(plan.leverage) !== null) bits.push(num(plan.leverage) + 'x');
        if (stop !== null) bits.push('stop ' + dom.qty(stop));
        if (target !== null) bits.push('target ' + dom.qty(target));
        move.quote = bits.join(', ');
      } else if (kind === 'trade_change') {
        var changes = [];
        if (args.cancel === true || d.cancel === true) changes.push('cancel');
        if (args.close === true || d.close === true) changes.push('close');
        if (num(args.stop) !== null || num(d.stop) !== null) changes.push('stop ' + dom.qty(num(d.stop !== undefined ? d.stop : args.stop)));
        if (num(args.target) !== null || num(d.target) !== null) changes.push('target ' + dom.qty(num(d.target !== undefined ? d.target : args.target)));
        move.quote = changes.join(', ');
      }
    } else if (typeof data.headline === 'string') {
      /* A receipt. */
      move.from = { symbol: data.symbol, place: data.fromChain, amount: num(data.amount) };
      if (isObject(data.received)) move.to = { symbol: data.received.symbol, place: data.toChain, amount: num(data.received.amount) };
      move.feeUsd = num(data.feesUsd);
      if (data.status === 'executed') { move.stage = 'confirmed'; move.label = 'Confirmed'; }
    }
    if (kind === 'policy_change') move.summary = String(d.sentence || args.sentence || move.summary || '');
    return move;
  }

  function legRow(leg, role) {
    var row = dom.el('div', 'tcard-leg');
    row.setAttribute('data-leg', role);
    row.appendChild(logo(leg.symbol || '', 20));
    var text = dom.el('span', 'tcard-leg-text');
    var amount = dom.el('span', 'tcard-leg-amount');
    if (leg.amount !== null && leg.amount !== undefined) {
      amount.appendChild(mono('', leg.usd ? dom.usd(leg.amount) : dom.qty(leg.amount)));
      amount.appendChild(dom.el('span', 'tcard-leg-symbol', leg.usd ? String(leg.symbol || '') : ' ' + String(leg.symbol || '')));
    } else {
      amount.appendChild(dom.el('span', 'tcard-leg-symbol', String(leg.symbol || '')));
    }
    text.appendChild(amount);
    var where = leg.place ? chainName(leg.place) : '';
    var placeText = where ? (leg.place === 'intents' ? 'inside ' : role === 'from' ? 'from ' : 'to ') + where : '';
    if (leg.label) placeText = placeText ? leg.label + ', ' + placeText : leg.label;
    if (placeText) text.appendChild(dom.el('span', 'tcard-leg-place', placeText));
    row.appendChild(text);
    return row;
  }

  function headFigure(leg) {
    if (!leg || leg.amount === null || leg.amount === undefined) return '';
    return leg.usd ? dom.usd(leg.amount) : dom.qty(leg.amount) + ' ' + String(leg.symbol || '');
  }

  function moveIcon(kind) {
    if (kind === 'trade' || kind === 'trade_change') return icon('long');
    if (kind === 'intents_deposit' || kind === 'hl_deposit' || kind === 'yield_deposit' || kind === 'lp_add') return icon('deposit');
    if (kind === 'intents_withdraw' || kind === 'intents_send' || kind === 'intents_pay' || kind === 'hl_withdraw' || kind === 'yield_withdraw' || kind === 'lp_remove') return icon('withdraw');
    return icon('swap');
  }

  function moveCard(data, extra) {
    var move = moveOf(extra.name, extra.input, data);
    var parts = shell('move', moveIcon(move.kind), move.title, {
      chip: chip(move.stage, move.label, move.stage === 'confirmed' ? 'done' : (move.stage === 'failed' ? 'refused' : '')),
      amount: headFigure(move.from),
      at: move.at || extra.at,
      open: extra.open,
      onToggle: extra.onToggle
    });
    var body = parts.body;

    /* A send draws the shared send card under the head: the same card the
       dock asks with, minus its buttons. The tool answer carries no draft, so
       the view comes from the reply's `send` facts and the tool's arguments. */
    var sendCard = window.PhosphorSendCard;
    if ((move.kind === 'intents_pay' || move.kind === 'intents_send') && sendCard) {
      var view = isObject(data.draft) ? sendCard.viewOf(data) : sendCard.viewOfToolData(extra.input, data);
      sendCard.build(body, view, {});
      return parts.card;
    }

    if (move.from || move.to) {
      var legs = dom.el('div', 'tcard-legs');
      if (move.from) legs.appendChild(legRow(move.from, 'from'));
      if (move.to) legs.appendChild(legRow(move.to, 'to'));
      body.appendChild(legs);
    } else if (move.summary) {
      body.appendChild(dom.el('div', 'tcard-sentence', move.summary));
    }

    var facts = [];
    if (move.quote) facts.push(move.quote);
    if (move.feeUsd !== null) facts.push('fee ' + dom.fee(move.feeUsd));
    if (facts.length) body.appendChild(dom.el('div', 'tcard-facts mono', facts.join(', ')));

    /* The head already carries the chip. The body says what the chip cannot
       in two words: the reason a move did not happen, and the clock. */
    var status = dom.el('div', 'tcard-status');
    var word = move.stage === 'confirmed' ? 'Confirmed' : (move.stage === 'failed' ? 'Stopped' : 'Proposed');
    status.appendChild(dom.el('span', 'tcard-note', move.stage === 'failed' && move.reason ? move.reason : word + ' at'));
    if (move.stage === 'failed' && move.reason) status.children[0].className = 'tcard-note tcard-note-down';
    var when = clock(move.at || extra.at || Date.now());
    if (when) status.appendChild(mono('tcard-time', when));
    body.appendChild(status);
    return parts.card;
  }

  /* ---------- the deposit card ---------- */

  function depositCard(data, extra) {
    var ok = data.ok !== false;
    var chain = String(data.chain || '');
    var symbol = String(data.asset || data.symbol || '');
    var state = DEPOSIT_STATES[String(data.watching)] || DEPOSIT_STATES.show;
    var parts = shell('deposit', icon('deposit'), ok ? 'Deposit ' + symbol + ' on ' + (data.network || chainName(chain)) : 'Deposit', {
      chip: ok ? chip(state[0], state[1], state[0] === 'landed' ? 'done' : '') : chip('failed', 'Not shown', 'refused'),
      at: extra.at,
      open: extra.open,
      onToggle: extra.onToggle
    });
    var body = parts.body;

    if (!ok) {
      body.appendChild(dom.el('div', 'tcard-note tcard-note-down', String(data.reason || 'The deposit address could not be shown.')));
      return parts.card;
    }

    var row = dom.el('div', 'tcard-row tcard-deposit-row');
    row.appendChild(logo(chain, 20));
    var name = dom.el('span', 'tcard-row-name');
    name.appendChild(dom.el('span', 'tcard-symbol', String(data.network || chainName(chain))));
    var tail = '';
    var print = String(data.addressFingerprint || '');
    var m = /([A-Za-z0-9]{4})$/.exec(print);
    if (m) tail = m[1];
    if (tail) {
      var ends = dom.el('span', 'tcard-place');
      ends.appendChild(dom.el('span', '', 'address ends in '));
      ends.appendChild(mono('tcard-tail', tail));
      name.appendChild(ends);
    }
    row.appendChild(name);
    row.appendChild(dom.el('span', 'tcard-note', data.addressVerified === true ? 'verified' : ''));
    body.appendChild(row);

    var facts = [];
    var min = num(data.minDeposit);
    if (min !== null && min > 0) facts.push('at least ' + dom.qty(min) + ' ' + symbol);
    if (data.memo) facts.push('memo required');
    if (facts.length) body.appendChild(dom.el('div', 'tcard-facts mono', facts.join(', ')));

    var actions = dom.el('div', 'tcard-actions');
    var open = dom.el('button', 'btn btn-ghost btn-sm tcard-open');
    open.type = 'button';
    open.appendChild(dom.el('span', 'btn-label', 'Open the deposit card'));
    dom.on(open, 'click', function () {
      var deposit = window.PhosphorDeposit;
      if (deposit && typeof deposit.open === 'function') deposit.open({ chain: chain, symbol: symbol });
    });
    actions.appendChild(open);
    body.appendChild(actions);
    return parts.card;
  }

  /* ---------- the key-value card ---------- */

  var SKIP_KEYS = { screen: true, ok: true, mode: true };

  function words(key) {
    return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  }

  function flatten(data, prefix, out) {
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length && out.length < MAX_FACTS * 2; i += 1) {
      var key = keys[i];
      if (!prefix && SKIP_KEYS[key]) continue;
      var value = data[key];
      var label = prefix ? prefix + ' ' + words(key) : words(key);
      if (isObject(value)) {
        if (!prefix) flatten(value, label, out);
        continue;
      }
      if (Array.isArray(value)) {
        var scalars = [];
        for (var j = 0; j < value.length; j += 1) {
          if (typeof value[j] === 'string' || typeof value[j] === 'number') scalars.push(String(value[j]));
        }
        out.push({ key: label, value: scalars.length === value.length ? scalars.join(', ') : value.length + ' items', numeric: false });
        continue;
      }
      if (value === null || value === undefined) continue;
      out.push({ key: label, value: typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value), numeric: typeof value === 'number' });
    }
    return out;
  }

  function kvCard(data, extra) {
    var title = extra.title ? extra.title : 'Details';
    var parts = shell('kv', glyph('list'), title, { at: extra.at, open: extra.open, onToggle: extra.onToggle });
    var facts = flatten(data, '', []);
    if (!facts.length) {
      emptyLine(parts.body, 'Nothing to show', '');
      return parts.card;
    }
    var grid = dom.el('div', 'tcard-kv');
    var shown = facts.slice(0, MAX_FACTS);
    for (var i = 0; i < shown.length; i += 1) {
      grid.appendChild(dom.el('span', 'tcard-kv-key', shown[i].key));
      grid.appendChild(dom.el('span', 'tcard-kv-value' + (shown[i].numeric ? ' mono' : ''), shown[i].value));
    }
    parts.body.appendChild(grid);
    moreLine(parts.body, facts.length - shown.length, 'facts');
    return parts.card;
  }

  /* ---------- the door ---------- */

  function kindFor(toolName, data) {
    var name = bare(toolName);
    if (name.indexOf('propose_') === 0) return 'move';
    if (KINDS[name]) return KINDS[name];
    if (name === 'watch' && isObject(data) && typeof data.chain === 'string' && (data.asset !== undefined || data.watching !== undefined)) return 'deposit';
    return 'kv';
  }

  /* `extra` is the block's context: the tool name and input the answer came
     from, when it landed, whether the card starts open, and where to say so
     when a person toggles it. All optional. */
  function render(kind, data, extra) {
    var safe = isObject(data) ? data : {};
    var meta = extra || {};
    if (kind === 'balance') return balanceCard(safe, meta);
    if (kind === 'position') return positionCard(safe, meta);
    if (kind === 'move') return moveCard(safe, meta);
    if (kind === 'deposit') return depositCard(safe, meta);
    return kvCard(safe, meta);
  }

  /* THE RECEIPT, IN A SHELL IT CAN CLOSE.

     The shared receipt card (ui/screens/receipt.js) is the whole record of a
     move: the amount, the fee, the chain, the hash, the explorer link. It is
     right in a popover and too tall for a thread, and it had no way to close.
     Wrapped here, unchanged, under a one-line head that says the move, its
     outcome, the amount and how long ago. The head folds it. */
  function wrapReceipt(receipt, node, extra) {
    var r = isObject(receipt) ? receipt : {};
    var meta = extra || {};
    var kind = String(r.kind || 'move');
    var status = String(r.status || 'executed');
    var stage = STAGES[status] || STAGES.executed;
    var amount = num(r.amount);
    var figure = amount === null ? '' : dom.qty(amount) + ' ' + String(r.symbol || '');
    var parts = shell('receipt', moveIcon(kind), TITLES[kind] || 'Move', {
      chip: chip(stage[0], stage[1], stage[0] === 'confirmed' ? 'done' : (stage[0] === 'failed' ? 'refused' : '')),
      amount: figure,
      at: r.at || meta.at,
      open: meta.open,
      onToggle: meta.onToggle
    });
    if (node) parts.body.appendChild(node);
    return parts.card;
  }

  /* The fold handle of a card built here, for whoever holds the node. */
  function foldOf(node) {
    return node && node.__fold ? node.__fold : null;
  }

  /* The names in a folded turn, once each, in the order they ran. */
  function foldNames(steps) {
    var seen = {};
    var out = [];
    for (var i = 0; i < (steps || []).length; i += 1) {
      var label = String(steps[i].label || steps[i].name || '');
      if (!label || seen[label]) continue;
      seen[label] = true;
      out.push(label);
    }
    if (out.length > 3) return out.slice(0, 3).join(', ') + ' and ' + (out.length - 3) + ' more';
    return out.join(', ');
  }

  window.PhosphorCards = {
    render: render,
    kindFor: kindFor,
    wrapReceipt: wrapReceipt,
    foldOf: foldOf,
    glyph: glyph,
    foldNames: foldNames
  };
})();
