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
    deposit: 'deposit',
    chain_transaction: 'transaction',
    chain_transactions: 'transaction',
    intents_activity: 'transaction'
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
    transfer: 'Transfer'
  };

  var DEPOSIT_STATES = {
    show: ['watching', 'Ready'],
    watching: ['watching', 'Watching'],
    seen: ['seen', 'Seen'],
    landed: ['landed', 'Landed'],
    stopped: ['watching', 'Not watching']
  };

  /* The stage names the colour, not a second vocabulary: waiting is on the
     person, failed and confirmed are ends, stalled is late, everything else is
     the world working. */
  var STAGE_TONE = {
    waiting_for_you: 'waiting',
    waiting_for_unlock: 'waiting',
    waiting_for_touch: 'waiting',
    confirmed: 'confirmed',
    failed: 'failed',
    FAILED: 'failed',
    declined: 'failed',
    refused: 'failed',
    REFUNDED: 'failed',
    stalled: 'stalled'
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
    var titleNode = dom.el('span', 'tcard-title', title);
    head.appendChild(titleNode);
    if (o.chip) head.appendChild(o.chip);
    var figure = dom.el('span', 'tcard-figure mono', o.amount || '');
    if (o.tone) figure.setAttribute('data-tone', o.tone);
    dom.setHidden(figure, !o.amount);
    head.appendChild(figure);
    /* The state, as one word at the right. No pill and no dot: a card is the
       app's own object, so the word is the state and the tone is the colour.
       The node is there whenever a caller asks for the slot, empty and hidden
       until the view names a stage, so a repaint can fill it in place. */
    var word = null;
    if (o.state) {
      word = dom.el('span', 'tcard-state', o.state.label);
      word.setAttribute('data-state', o.state.tone);
      dom.setHidden(word, !o.state.label);
      head.appendChild(word);
    }
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
    return { card: card, body: body, head: head, fold: handle, title: titleNode, figure: figure, state: word };
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

  /* The dollar figure for a wallet with something in it the app could not price. A number
     alone over an unpriced holding reads as "you have nothing" (Karim's window, 2026-09-20:
     $0.00 over 2.0097 wNEAR), so the figure says what it is: a floor, or no figure at all. */
  function totalText(total, unpriced) {
    if (!unpriced.length) return dom.usd(total);
    return total > 0 ? 'at least ' + dom.usd(total) : 'not priced';
  }

  function balanceCard(data, extra) {
    var held = holdingsOf(data);
    var total = num(data.totalUsd);
    if (total === null) {
      total = 0;
      for (var t = 0; t < held.rows.length; t += 1) total += held.rows[t].usd;
    }
    var unpriced = Array.isArray(data.unpriced) ? data.unpriced.map(String) : [];
    if (!unpriced.length) {
      for (var u = 0; u < held.rows.length; u += 1) if (!held.rows[u].priced) unpriced.push(held.rows[u].symbol);
    }
    var parts = shell('balance', glyph('wallet'), 'What you hold', {
      amount: held.rows.length ? totalText(total, unpriced) : '',
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
    foot.appendChild(mono('tcard-total-value', totalText(total, unpriced)));
    body.appendChild(foot);
    if (unpriced.length) body.appendChild(dom.el('div', 'tcard-note', unpriced.join(', ') + ' not priced, so the total leaves it out.'));

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

  /* THE CARD READS THE VIEW.

     Karim, 2026-09-18: the card said "Confirmed at 14:20" while the assistant
     said the deposit was still settling, and the clock on the card was the
     moment he clicked, not the moment the money landed. Two maps of the same
     truth, a step out of order. There is one now: src/proposals/view.ts builds
     a ProposalView, proposal_status returns it, /api/state carries it on every
     proposal, and everything below reads it. */
  /* The view, from either shape it reaches the window in: beside the row as `view` (a
     propose reply, a state frame row, `show`), or as the whole payload, which is how
     proposal_status answers. Null where neither is there, which is a payload older than the
     view, and the card then draws the facts it has and no stage word: the state frame fills
     it in a moment, and a word made up here meanwhile would be the second stage table this
     file must not keep. */
  function viewOf(data) {
    if (!isObject(data)) return null;
    if (isObject(data.view)) return data.view;
    if (typeof data.stage === 'string' && typeof data.stageLabel === 'string') return data;
    return null;
  }

  function stateOf(view) {
    if (!view) return { tone: 'running', label: '' };
    return { tone: STAGE_TONE[view.stage] || 'running', label: String(view.stageLabel || '') };
  }

  /* How long, in the fewest characters that still carry the seconds: this
     number ticks once a second on a live card, so it is the one figure on the
     window that has to stay narrow and readable at the same time. */
  function spanWords(seconds) {
    var n = Math.max(0, Math.round(Number(seconds) || 0));
    if (n < 60) return n + 's';
    var minutes = Math.floor(n / 60);
    if (minutes < 60) return minutes + 'm ' + String(n % 60).padStart(2, '0') + 's';
    return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
  }

  /* The same duration, rounded, for a typical figure nobody times to the second. */
  function aboutWords(seconds) {
    var n = Math.max(0, Math.round(Number(seconds) || 0));
    if (n < 60) return n + 's';
    if (n < 3600) return Math.round(n / 60) + 'm';
    return Math.round(n / 3600) + 'h';
  }

  function secondsSince(iso) {
    var then = new Date(String(iso || '')).getTime();
    if (!isFinite(then)) return null;
    return Math.max(0, (Date.now() - then) / 1000);
  }

  /* One label at the left, one figure at the right, in mono. The figure is
     right anchored so a counter that grows a digit takes the gap rather than
     pushing the label, which is what keeps a ticking card still. */
  function factLine(body, label, value, tone, wrap) {
    if (value === '' || value === null || value === undefined) return null;
    var row = dom.el('div', 'tcard-line');
    if (wrap) row.setAttribute('data-wrap', 'true');
    row.appendChild(dom.el('span', 'tcard-line-label', label));
    var figure = mono('tcard-line-value', value);
    if (tone) figure.setAttribute('data-tone', tone);
    row.appendChild(figure);
    body.appendChild(row);
    return figure;
  }

  /* A second is the beat, and only the digits move. The timer stops itself the
     first time it wakes up outside the document, which is every re-render, so a
     conversation that has drawn a hundred cards is running one timer per card
     that is still on screen and none for the rest. */
  function tick(node, paint) {
    paint();
    if (typeof window.setInterval !== 'function') return;
    var id = window.setInterval(function () {
      if (!node.isConnected) {
        window.clearInterval(id);
        return;
      }
      paint();
    }, 1000);
  }

  /* An id a person can read past: the two ends, eight characters each, and the
     whole thing one click away on the Copy beside it. A hash printed whole is
     the line that pushed every other fact off a 400 px card. */
  function shortId(value) {
    var s = String(value || '');
    if (s.length <= 20) return s;
    return s.slice(0, 8) + '...' + s.slice(-8);
  }

  function copyToClipboard(value, label) {
    if (!(navigator.clipboard && typeof navigator.clipboard.writeText === 'function')) return;
    navigator.clipboard.writeText(String(value)).then(function () {
      dom.setText(label, 'Copied');
      window.setTimeout(function () { dom.setText(label, 'Copy'); }, 1500);
    }).catch(function () { /* the value is on screen to read */ });
  }

  function copyButton(value) {
    var copy = dom.el('button', 'btn btn-quiet btn-sm tcard-copy');
    copy.type = 'button';
    var label = dom.el('span', 'btn-label', 'Copy');
    copy.appendChild(label);
    dom.setAttr(copy, 'aria-label', 'Copy ' + shortId(value));
    dom.on(copy, 'click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      copyToClipboard(value, label);
    });
    return copy;
  }

  /* A reference line: the label, the shortened id in mono, a Copy that carries the whole
     id, and a link out when the server built one. Every id on a card goes through here. */
  function referenceLine(body, label, value, url) {
    var id = String(value || '');
    if (!id) return null;
    var row = dom.el('div', 'tcard-line tcard-ref');
    row.appendChild(dom.el('span', 'tcard-line-label', label));
    var right = dom.el('span', 'tcard-ref-value');
    var href = explorerUrl(url);
    if (href) {
      var link = dom.el('a', 'mono tcard-line-value tcard-link');
      setHref(link, url);
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.appendChild(dom.el('span', '', shortId(id)));
      link.appendChild(icon('external', 'tcard-link-glyph'));
      right.appendChild(link);
    } else {
      right.appendChild(mono('tcard-line-value', shortId(id)));
    }
    right.appendChild(copyButton(id));
    row.appendChild(right);
    body.appendChild(row);
    return row;
  }

  /* The vendor's word for a phase, in lower case with its underscores gone: evidence for a
     support ticket, never a headline. KNOWN_DEPOSIT_TX reads "known deposit tx". */
  function vendorWord(stage) {
    return String(stage || '').toLowerCase().replace(/_/g, ' ');
  }

  /* The reason a move stopped, as one plain sentence for the face of the card: the rule that
     refused it in the policy's own words, or the first sentence of what the rail said, with
     any brace, bracket or quote run stripped and the rest cut. The rail's whole line stays
     behind Details, where it is evidence rather than the thing a person reads first. */
  function reasonSentence(text) {
    var s = String(text || '').replace(/[{}\[\]"`]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var end = s.search(/[.!?](\s|$)/);
    if (end !== -1) s = s.slice(0, end + 1);
    if (s.length > 140) s = s.slice(0, 137).replace(/\s+\S*$/, '') + '...';
    return s;
  }

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
    var view = viewOf(data);
    var kind = String((draft && draft.kind) || (view && view.kind) || data.kind || (sendFacts && sendFacts.kind) || bare(name).replace(/^propose_/, '') || 'move');
    var state = stateOf(view);
    var move = {
      kind: kind,
      title: TITLES[kind] || 'Move',
      id: typeof data.id === 'string' ? data.id : (view && typeof view.id === 'string' ? view.id : ''),
      from: null,
      to: null,
      feeUsd: null,
      quote: '',
      stage: state.tone,
      label: state.label,
      reason: '',
      detail: '',
      summary: ''
    };

    var status = typeof data.status === 'string' ? data.status : 'pending';
    var sim = isObject(data.simulation) ? data.simulation : null;
    var verdict = isObject(data.verdict) ? data.verdict : null;
    var result = isObject(data.result) ? data.result : null;
    if (sim && typeof sim.summary === 'string') move.summary = sim.summary;
    if (typeof data.headline === 'string') move.summary = data.headline;
    /* The view's own line wins over anything the window would compose: one
       sentence per move, written once, printed by the card and quoted by the
       assistant, so the two cannot describe the same move differently. */
    if (view && typeof view.sentence === 'string' && view.sentence) move.summary = view.sentence;

    /* The reason a move did not happen, in the plainest words on hand: the view's own error
       for a refusal or a failure, else what the row itself carries. The stage word says that
       it stopped; this says why, in one sentence; the rail's whole line goes behind Details. */
    var rail = result && typeof result.detail === 'string' ? result.detail : (sim && typeof sim.error === 'string' ? sim.error : '');
    if (view && isObject(view.error) && view.error.message) {
      move.detail = String(view.error.message);
      /* A late row's reason is its clock, which the stage line already counts. */
      move.reason = view.stage === 'stalled' ? '' : reasonSentence(view.error.message);
    } else if (status === 'policy_refused' && verdict && Array.isArray(verdict.reasons) && verdict.reasons.length) {
      move.reason = reasonSentence(verdict.reasons[verdict.reasons.length - 1]);
    } else if (!view && verdict && verdict.outcome === 'refuse') {
      move.reason = reasonSentence(Array.isArray(verdict.reasons) && verdict.reasons.length ? verdict.reasons[verdict.reasons.length - 1] : 'A rule in the policy refused it.');
    } else if (status === 'failed' || (!view && sim && sim.ok === false)) {
      move.detail = rail;
      move.reason = reasonSentence(rail || 'The venue did not take it.');
    }

    /* The legs. A draft names them exactly; a propose's own arguments name
       them well enough; a receipt names them as what left and what arrived. */
    var d = draft || {};
    if (kind === 'swap') {
      var q = isObject(d.quote) ? d.quote : null;
      /* Both legs sit inside NEAR Intents: chain and toChain on a swap name the
         assets' home chains, not places the money goes. */
      move.from = { symbol: d.fromSymbol || args.fromSymbol, place: 'intents', amount: num(d.amountIn !== undefined ? d.amountIn : args.amountIn) };
      move.to = { symbol: d.toSymbol || args.toSymbol, place: 'intents', amount: q ? num(q.amountOut) : null, about: true };
      if (q) move.feeUsd = num(q.feeUsd);
      /* The floor the fill is held to. It is the protection on a swap, so it
         stays on the card whether the rail quoted it or the draft named it. */
      /* Through floorText whichever source names it: the rail's floor is a string in base
         precision, and a 24-place wNEAR figure printed whole (2026-09-20). */
      var floor = sim && isObject(sim.swap) && num(sim.swap.receivesAtLeast) !== null ? floorText(num(sim.swap.receivesAtLeast)) : null;
      if (floor === null && num(args.minAmountOut) !== null) floor = floorText(num(args.minAmountOut));
      if (floor === null && d.minAmountOut !== undefined && num(d.minAmountOut) !== null) floor = floorText(num(d.minAmountOut));
      if (floor !== null) move.quote = 'at least ' + floor + ' ' + String(move.to.symbol || '');
      if (move.to.amount === null && sim && isObject(sim.swap) && num(sim.swap.receives) !== null) move.to.amount = num(sim.swap.receives);
      if (move.feeUsd === null && sim && isObject(sim.swap) && num(sim.swap.feeUsd) !== null) move.feeUsd = num(sim.swap.feeUsd);
    } else if (kind === 'intents_deposit') {
      move.from = { symbol: d.symbol || args.symbol, place: d.chain || args.chain, amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: d.symbol || args.symbol, place: 'intents', amount: num(d.minCredited), floor: true };
    } else if (kind === 'intents_withdraw') {
      move.from = { symbol: d.symbol || args.symbol, place: 'intents', amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: d.symbol || args.symbol, place: d.chain || args.chain, amount: num(d.minReceived), floor: true };
    } else if (kind === 'intents_send' || kind === 'intents_pay') {
      /* The receiver is the fact this card exists to show: the whole address, never
         shortened, on the leg the money lands on, with where it lands beside it. */
      var send = sendFacts || {};
      var sendSim = sim && isObject(sim.send) ? sim.send : null;
      var where = kind === 'intents_send' ? 'intents' : String(d.network || send.where || args.where || '');
      move.from = { symbol: d.symbol || send.symbol || args.symbol, place: 'intents', amount: num(d.amount !== undefined ? d.amount : (send.amount !== undefined ? send.amount : args.amount)) };
      move.to = {
        symbol: d.symbol || send.symbol || args.symbol,
        place: where,
        amount: sendSim && num(sendSim.arrivesAtLeast) !== null ? num(sendSim.arrivesAtLeast) : num(d.minReceived),
        floor: true,
        address: String(d.to || send.to || args.to || ''),
        explorer: sendSim && sendSim.explorer ? sendSim.explorer : null
      };
      if (sendSim && num(sendSim.feeUsd) !== null) move.feeUsd = num(sendSim.feeUsd);
      move.recipient = isObject(d.recipient) ? d.recipient : (isObject(send.recipient) ? send.recipient : null);
      move.activity = sendSim && sendSim.activity ? String(sendSim.activity) : '';
      move.preflight = Array.isArray(data.preflight) && data.preflight.length ? data.preflight[data.preflight.length - 1] : null;
    } else if (kind === 'hl_deposit') {
      move.from = { symbol: d.symbol || args.symbol || 'USDC', place: 'intents', amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: 'USDC', place: 'hyperliquid', amount: num(d.minCredited), floor: true };
    } else if (kind === 'hl_withdraw') {
      /* The out leg of every rail below is the FLOOR the rail holds the venue to, not a quote,
         and it drew as a plain figure while the agent quoted the expected amount: two numbers
         and no reason on one card (2026-09-20). `floor` makes the leg say "at least". */
      move.from = { symbol: 'USDC', place: 'hyperliquid', amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: 'USDC', place: 'intents', amount: num(d.minReceived), floor: true };
    } else if (kind === 'trade' || kind === 'trade_change') {
      var plan = isObject(d.plan) ? d.plan : (isObject(args.plan) ? args.plan : null);
      if (plan) {
        move.title = (plan.side === 'short' ? 'Short ' : 'Long ') + String(plan.symbol || '');
        /* The collateral, not the notional. The figure that leads a trade card is
           the one the policy governs and the one that can be lost; the notional
           is a multiple of it and reads beside that multiple. */
        var stake = num(d.amountUsd !== undefined ? d.amountUsd : (isObject(d.risk) ? d.risk.marginUsd : null));
        move.from = { symbol: 'USDC', place: 'hyperliquid', amount: stake === null ? num(plan.sizeUsd) : stake, usd: true, label: 'at stake' };
        var stop = num(plan.stop);
        var target = num(plan.target);
        var bits = [];
        if (num(plan.sizeUsd) !== null) bits.push(dom.usd(num(plan.sizeUsd)) + ' notional');
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
    }
    /* A rule change's sentence is the one string on a proposal that the agent
       types rather than the app composes, so the view's line wins wherever there
       is one and the draft's own words are the fallback for a payload with no
       view. The dock passes the app's fixed line in that slot, and the dock is
       the card that decides whether to trust what the agent wrote. */
    if (kind === 'policy_change' && !(view && view.sentence)) {
      move.summary = String(d.sentence || args.sentence || move.summary || '');
    }
    return move;
  }

  /* A floor to six significant figures, CUT rather than rounded. It is a promise the rail holds
     the venue to, so it keeps more places than a balance does and never says more than the
     rail does: rounding half-up printed 5.934637 as 5.93464, a floor the venue could legally
     land under (review, 2026-09-20). Read by a person, so it does not keep all twenty-four of
     a NEAR figure's places either. */
  function floorText(value) {
    var n = Number(value);
    if (!isFinite(n)) return '';
    if (n === 0) return '0';
    var scale = Math.pow(10, 5 - Math.floor(Math.log10(Math.abs(n))));
    var cut = Math.floor(n * scale) / scale;
    return cut.toLocaleString('en-US', { maximumSignificantDigits: 6 });
  }

  /* The address in groups of four so a person can check it against what they
     typed, group by group. A named NEAR account stays whole: splitting
     alice.near into syllables helps nobody. */
  function groupsOf(address) {
    var s = String(address || '');
    if (s === '') return [];
    if (!/^0x[0-9a-fA-F]{40}$/.test(s) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return [s];
    var out = [];
    for (var i = 0; i < s.length; i += 4) out.push(s.slice(i, i + 4));
    return out;
  }

  function legRow(leg, role) {
    var row = dom.el('div', 'tcard-leg');
    row.setAttribute('data-leg', role);
    row.appendChild(logo(leg.symbol || '', 20));
    var text = dom.el('span', 'tcard-leg-text');
    var amount = dom.el('span', 'tcard-leg-amount');
    if (leg.amount !== null && leg.amount !== undefined) {
      if (leg.floor) amount.appendChild(dom.el('span', 'tcard-leg-floor', 'at least '));
      else if (leg.about) amount.appendChild(dom.el('span', 'tcard-leg-floor', 'about '));
      amount.appendChild(mono('', leg.usd ? dom.usd(leg.amount) : (leg.floor ? floorText(leg.amount) : dom.qty(leg.amount))));
      amount.appendChild(dom.el('span', 'tcard-leg-symbol', leg.usd ? String(leg.symbol || '') : ' ' + String(leg.symbol || '')));
    } else {
      amount.appendChild(dom.el('span', 'tcard-leg-symbol', String(leg.symbol || '')));
    }
    text.appendChild(amount);
    var where = leg.place ? chainName(leg.place) : '';
    var placeText = where ? (leg.place === 'intents' ? 'inside ' : role === 'from' ? 'from ' : 'to ') + where : '';
    if (leg.label) placeText = placeText ? leg.label + ', ' + placeText : leg.label;
    if (placeText) text.appendChild(dom.el('span', 'tcard-leg-place', placeText));
    /* A send lands on an address, and the address is the whole point: every character,
       in groups of four, a Copy, and the explorer link when the server built one. */
    if (leg.address) {
      var address = dom.el('p', 'tcard-leg-address mono');
      var groups = groupsOf(leg.address);
      for (var i = 0; i < groups.length; i += 1) address.appendChild(dom.el('span', 'tcard-leg-group', groups[i]));
      dom.setAttr(address, 'data-address', leg.address);
      text.appendChild(address);
      var actions = dom.el('div', 'tcard-leg-actions');
      actions.appendChild(copyButton(leg.address));
      if (explorerUrl(leg.explorer)) {
        var link = dom.el('a', 'btn btn-quiet btn-sm tcard-leg-explorer');
        setHref(link, leg.explorer);
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.appendChild(dom.el('span', 'btn-label', 'Explorer'));
        link.appendChild(icon('external'));
        actions.appendChild(link);
      }
      text.appendChild(actions);
    }
    row.appendChild(text);
    return row;
  }

  function headFigure(leg) {
    if (!leg || leg.amount === null || leg.amount === undefined) return '';
    return leg.usd ? dom.usd(leg.amount) : dom.qty(leg.amount) + ' ' + String(leg.symbol || '');
  }

  function moveIcon(kind) {
    if (kind === 'trade' || kind === 'trade_change') return icon('long');
    if (kind === 'intents_deposit' || kind === 'hl_deposit') return icon('deposit');
    if (kind === 'intents_withdraw' || kind === 'intents_send' || kind === 'intents_pay' || kind === 'hl_withdraw') return icon('withdraw');
    return icon('swap');
  }

  /* The legs, off the view's money: what left, what arrives, and the two
     pockets by name. A view is the only place that knows both sides after the
     rail has answered, so it wins over the draft wherever it has the figure. */
  function viewLegs(view, fallback) {
    var money = isObject(view.money) ? view.money : {};
    var symbol = String(money.symbol || (fallback.from && fallback.from.symbol) || '');
    /* The coin that arrives is not the coin spent on a swap. Both legs used to read the one
       symbol, so a confirmed swap into wNEAR said "2.0097 USDC" (2026-09-20). */
    var toSymbol = String(money.toSymbol || (fallback.to && fallback.to.symbol) || symbol);
    var from = money.amountIn === null || money.amountIn === undefined ? fallback.from : {
      symbol: symbol,
      place: pocketId(money.fromPocket) || (fallback.from && fallback.from.place) || '',
      amount: num(money.amountIn),
      usd: fallback.from ? fallback.from.usd : undefined,
      label: fallback.from ? fallback.from.label : undefined
    };
    var base = fallback.to || {};
    var landed = view.stage === 'confirmed';
    /* Confirmed, the figure is what arrived and it is a fact. Before that a leg that carries
       a floor keeps the floor ("at least"), because the view's figure is the quote's expected
       amount and printing that under "at least" promised more than the rail holds the venue
       to; a leg without a floor shows the expected figure as "about". */
    var keepFloor = base.floor === true && !landed && base.amount !== null && base.amount !== undefined;
    var to = (money.amountOut === null || money.amountOut === undefined) && !keepFloor ? fallback.to : {
      symbol: toSymbol,
      place: pocketId(money.toPocket) || base.place || '',
      amount: keepFloor ? base.amount : num(money.amountOut),
      floor: keepFloor,
      about: !keepFloor && base.floor !== true && !landed,
      address: base.address,
      explorer: base.explorer
    };
    return { from: from, to: to, feeUsd: money.feeUsd === null || money.feeUsd === undefined ? fallback.feeUsd : num(money.feeUsd) };
  }

  /* The view names a pocket by its label ("NEAR Intents", "Hyperliquid") and a draft names it
     by its id; legRow decides "inside" against the id, so a label has to come back to one or
     the out leg of a swap reads "to NEAR Intents" over money that never left it. */
  function pocketId(pocket) {
    if (!pocket) return '';
    var text = String(pocket);
    for (var id in CHAIN_NAMES) {
      if (Object.prototype.hasOwnProperty.call(CHAIN_NAMES, id) && CHAIN_NAMES[id] === text) return id;
    }
    return text;
  }

  /* A text that changes with a fade rather than a cut. The new words are set at once and
     fade in over 240 ms (ui/design/chatcard.css); the attribute alternates between two names
     so the animation restarts on every change and never on a repaint that changed nothing.
     The first paint sets no fade: the card's own entrance already carries it in. */
  function fadeText(node, text, memo, key) {
    var next = String(text || '');
    if (memo[key] === next) return false;
    var first = memo[key] === undefined;
    memo[key] = next;
    dom.setText(node, next);
    if (!first) {
      var flip = key + ':fade';
      memo[flip] = memo[flip] === 'a' ? 'b' : 'a';
      dom.setAttr(node, 'data-fade', memo[flip]);
    }
    return true;
  }

  /* THE ONE FOLD under the facts: who decided and when, the reference support asks for, the
     hash where the money is, the vendor's own word on a move that stopped, and a send's
     checks. Closed until a person opens it, and the open state is the caller's so it
     survives every repaint. */
  function detailsFold(opts) {
    var o = opts || {};
    var wrap = dom.el('div', 'tcard-details');
    var open = o.open === true;
    var head = dom.el('button', 'tcard-details-head');
    head.type = 'button';
    head.appendChild(glyph('chevron', 'tcard-details-chevron'));
    head.appendChild(dom.el('span', 'tcard-details-word', 'Details'));
    wrap.appendChild(head);
    var fold = dom.el('div', 'tcard-details-fold');
    var inner = dom.el('div', 'tcard-details-inner');
    var body = dom.el('div', 'tcard-details-body');
    inner.appendChild(body);
    fold.appendChild(inner);
    wrap.appendChild(fold);
    function apply() {
      dom.setAttr(wrap, 'data-open', open ? 'true' : 'false');
      dom.setAttr(head, 'aria-expanded', open ? 'true' : 'false');
      dom.setAttr(head, 'aria-label', (open ? 'Close' : 'Open') + ' the details');
    }
    dom.on(head, 'click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      open = !open;
      apply();
      if (typeof o.onToggle === 'function') o.onToggle(open);
    });
    apply();
    return { wrap: wrap, body: body, isOpen: function () { return open; }, setOpen: function (next) { open = !!next; apply(); } };
  }

  /* ONE CARD PER MOVE, ONE SKELETON FOR EVERY KIND, REPAINTED IN PLACE.

     The head: what it is, how much, and the stage word. The body: the two legs (what leaves,
     what arrives and the two pockets), the facts (at least, fee), the stage line (the one
     sentence of copy for the stage and the clock since it last changed), the reason when it
     stopped, and one fold for the checks and the reference. A swap, a deposit, a payout and
     a rule change differ in their facts and never in their shape.

     The card is built once and painted: `node.__paint(data, extra)` takes the next row and
     changes the words that changed, so a stage change is a fade on the state word and the
     stage line, the clock moves, the legs keep their place and a fold a person closed stays
     closed. Rebuilding the card on every frame replayed its entrance and dropped the folds
     (Karim, 2026-09-18, on a card that jumped every time its row moved). */
  function moveCard(data, extra) {
    var meta = extra || {};
    var first = moveOf(meta.name, meta.input, data);
    var parts = shell('move', moveIcon(first.kind), first.title, {
      state: { tone: 'running', label: '' },
      amount: '',
      open: meta.open,
      onToggle: meta.onToggle
    });
    var card = parts.card;
    var body = parts.body;

    var legsHost = dom.el('div', 'tcard-legs');
    var sentence = dom.el('div', 'tcard-sentence');
    var facts = dom.el('div', 'tcard-facts mono');
    var stage = dom.el('div', 'tcard-stage');
    var copy = dom.el('span', 'tcard-stage-copy');
    var clockCell = dom.el('span', 'tcard-stage-clock');
    var clockFigure = mono('tcard-stage-since', '');
    var clockUsual = dom.el('span', 'tcard-stage-usual', '');
    clockCell.appendChild(clockFigure);
    clockCell.appendChild(clockUsual);
    stage.appendChild(copy);
    stage.appendChild(clockCell);
    var reason = dom.el('div', 'tcard-note tcard-note-down');
    var details = detailsFold({ open: meta.detailsOpen === true, onToggle: meta.onDetailsToggle });
    body.appendChild(legsHost);
    body.appendChild(sentence);
    body.appendChild(facts);
    body.appendChild(stage);
    body.appendChild(reason);
    body.appendChild(details.wrap);

    var memo = {};
    var live = { since: null, fallback: 0, running: false };
    var ticking = false;

    function paintClock() {
      if (!live.running) return;
      var seconds = secondsSince(live.since);
      dom.setText(clockFigure, spanWords(seconds === null ? live.fallback : seconds));
    }

    function paint(next, more) {
      var m = more || meta;
      if (typeof m.detailsOpen === 'boolean' && details.isOpen() !== m.detailsOpen) details.setOpen(m.detailsOpen);
      var move = moveOf(m.name, m.input, next);
      var view = viewOf(next);
      var legs = view ? viewLegs(view, move) : move;
      var state = stateOf(view);
      if (move.id) card.id = 'card-proposal-' + move.id;

      dom.setText(parts.title, move.title);
      var figure = headFigure(legs.from);
      dom.setText(parts.figure, figure);
      dom.setHidden(parts.figure, !figure);
      fadeText(parts.state, state.label, memo, 'label');
      dom.setAttr(parts.state, 'data-state', state.tone);
      dom.setHidden(parts.state, !state.label);

      /* The legs are rebuilt only when what they say changes, so a tick or a stage that
         moved nothing about the money leaves them alone. */
      var legKey = JSON.stringify([legs.from, legs.to]);
      if (memo.legs !== legKey) {
        memo.legs = legKey;
        dom.clear(legsHost);
        if (legs.from) legsHost.appendChild(legRow(legs.from, 'from'));
        if (legs.to) legsHost.appendChild(legRow(legs.to, 'to'));
      }
      dom.setHidden(legsHost, !(legs.from || legs.to));
      /* The sentence, unless both pockets are already drawn: a card that shows what
         left and what lands does not need a line saying the same thing again. */
      var line = move.summary && !(legs.from && legs.to) ? move.summary : '';
      dom.setText(sentence, line);
      dom.setHidden(sentence, !line);

      var factBits = [];
      if (move.quote) factBits.push(move.quote);
      if (legs.feeUsd !== null && legs.feeUsd !== undefined) factBits.push('fee ' + dom.fee(legs.feeUsd));
      dom.setText(facts, factBits.join(', '));
      dom.setHidden(facts, !factBits.length);

      /* The stage line: the one sentence the table gives this stage, and the clock since it
         last changed. A stalled row is terminal and still counting, which is the whole
         statement it makes; every other end stops the clock. */
      var open = !!view && (!view.terminal || view.stage === 'stalled');
      fadeText(copy, view ? String(view.stageCopy || '') : '', memo, 'copy');
      live.running = open;
      live.since = view ? view.lastChangeAt : null;
      live.fallback = view ? Number(view.sinceChangeSec) || 0 : 0;
      var usual = open && typeof view.typicalSec === 'number' && view.typicalSec > 0 ? ' of about ' + aboutWords(view.typicalSec) : '';
      dom.setText(clockUsual, usual);
      dom.setHidden(clockCell, !open);
      dom.setHidden(stage, !view);
      if (open) {
        paintClock();
        if (!ticking) {
          ticking = true;
          tick(clockFigure, paintClock);
        }
      }

      dom.setText(reason, move.reason);
      dom.setHidden(reason, !move.reason);

      /* The fold: rebuilt each paint, it is a handful of lines and the state of the fold
         lives on the fold rather than in them. */
      var fold = details.body;
      dom.clear(fold);
      if (view) {
        /* Who decided is the fact, and the clock is only its time. A policy decision carries
           a decidedAt too (an auto-run under the ask line, a refusal by a rule), and reading
           the clock alone said the human had clicked on every one of them (Karim's transcript,
           2026-09-20). A refusal by a rule names no decider. */
        if (view.decidedAt && view.decidedBy === 'human') factLine(fold, 'You clicked at', clock(view.decidedAt));
        else if (view.decidedAt && view.decidedBy === 'policy' && view.stage !== 'refused') factLine(fold, 'Your rules allowed it at', clock(view.decidedAt));
        /* "Confirmed at" belongs to a move that was confirmed. A refusal, a failure and a
           refund all carry the moment they ended, and the word for that is not confirmed. */
        if (view.settledAt) {
          var done = view.stage === 'confirmed';
          factLine(fold, done ? 'Confirmed at' : 'Ended at', clock(view.settledAt), done ? 'up' : null);
        }
        if (typeof view.tookSec === 'number' && view.tookSec > 0) factLine(fold, 'Took', spanWords(view.tookSec));
        var txs = Array.isArray(view.txs) ? view.txs : [];
        for (var i = 0; i < txs.length; i += 1) {
          var leg = txs[i];
          if (!leg || !leg.hash) continue;
          referenceLine(fold, leg.running ? 'Where it is now' : (LEG_WORD[leg.leg] || 'Hash'), leg.hash, leg.explorer);
        }
        if (view.correlationId) referenceLine(fold, 'Reference', view.correlationId, null);
        /* The vendor's own word is evidence on a move that stopped or is late and noise under
           a word that already says Confirmed: it sits here, in the app's case, never on the
           face of the card (5.4). */
        if (view.providerStage && view.stage !== 'confirmed') factLine(fold, 'The transfer calls this', vendorWord(view.providerStage));
        if (move.detail && move.detail !== move.reason) {
          var recorded = dom.el('div', 'tcard-line tcard-recorded');
          recorded.setAttribute('data-wrap', 'true');
          recorded.appendChild(dom.el('span', 'tcard-line-label', 'What the app recorded'));
          recorded.appendChild(dom.el('span', 'tcard-line-value', String(move.detail).replace(/\s+/g, ' ').trim()));
          fold.appendChild(recorded);
        }
      } else if (move.id) {
        referenceLine(fold, 'Reference', move.id, null);
      }
      if (move.kind === 'intents_send' || move.kind === 'intents_pay') {
        var r = move.recipient;
        var known = r && r.known === true;
        var count = known ? (num(r.count) || 0) : 0;
        factLine(fold, 'This address', known ? 'sent to ' + count + (count === 1 ? ' time before' : ' times before') : 'first send', known ? null : 'down');
        if (move.activity) fold.appendChild(dom.el('div', 'tcard-note', move.activity));
        if (move.preflight && window.PhosphorChecks && typeof window.PhosphorChecks.fold === 'function') {
          window.PhosphorChecks.fold(fold, move.preflight, { open: false });
        }
      }
      dom.setHidden(details.wrap, !fold.children.length);
    }

    card.__paint = paint;
    card.__details = details;
    paint(data, meta);
    return card;
  }

  /* ---------- the transaction card ---------- */

  /* "Show me that transaction" draws this, not a paragraph. Three read tools
     answer with it (chain_transaction, chain_transactions, intents_activity)
     and `show` asks for it by name with { card: 'transaction' }, carrying the
     same fields plus the proposal's view when a proposal is what is being
     shown. One leg is the one the money is inside right now, and it is the only
     hash that is a link: the rest are here to be read, not followed. */
  /* `show` hands the window a card by name and nests the thing to draw under
     it (src/http/view.ts showBody). One place unwraps that, so every builder
     below reads the shape its own tool answers with and none of them knows
     `show` exists.

     The nesting is easy to get wrong in the direction that matters: `show`'s
     transaction payload carries the whole chain read under `tx`, not the one
     transaction inside it, so the builder wants `data.tx` hoisted and not
     read a level too shallow. */
  var SHOWN = { proposal: 'move', transaction: 'transaction', position: 'position', deposit: 'deposit' };

  function shownCard(data) {
    if (!isObject(data) || typeof data.card !== 'string' || !SHOWN[data.card]) return null;
    if (data.card === 'proposal') {
      var view = isObject(data.view) ? data.view : {};
      return { kind: 'move', data: { id: data.id, kind: view.kind, view: data.view } };
    }
    if (data.card === 'transaction') {
      return { kind: 'transaction', data: isObject(data.tx) ? data.tx : { ok: false, error: 'The chain did not answer.' } };
    }
    if (data.card === 'position') return { kind: 'position', data: { positions: [data.position] } };
    return { kind: 'deposit', data: isObject(data.deposit) ? data.deposit : {} };
  }

  var TX_STATE = {
    success: ['confirmed', 'Confirmed'],
    failed: ['failed', 'Failed'],
    pending: ['running', 'Still going'],
    unknown: ['running', 'Not known yet']
  };

  /* NearBlocks' own words for what moved on the intents ledger. */
  var CAUSE_WORD = { MINT: 'In', BURN: 'Out', TRANSFER: 'Moved' };

  /* The four legs a move can have, in the words a person would use for them. */
  var LEG_WORD = {
    origin: 'The chain it left',
    near: 'On NEAR',
    intent: 'The intent',
    destination: 'The chain it lands on'
  };

  /* An address or a hash rather than the name of a pocket. Either wraps and is
     never shortened; a pocket's name is a word and sits on one line. */
  function isAddress(text) {
    var value = String(text || '');
    return value.length > 24 && value.indexOf(' ') === -1;
  }

  function explorerUrl(url) {
    var links = window.PhosphorLinks;
    return links && typeof links.explorerUrl === 'function' ? links.explorerUrl(url) : null;
  }

  function setHref(anchor, url) {
    var links = window.PhosphorLinks;
    return !!links && typeof links.setHref === 'function' && links.setHref(anchor, url);
  }

  function linkRow(body, label, text, url) {
    var row = dom.el('div', 'tcard-line');
    row.setAttribute('data-wrap', 'true');
    row.appendChild(dom.el('span', 'tcard-line-label', label));
    var href = explorerUrl(url);
    if (!href) {
      row.appendChild(mono('tcard-line-value', text));
      body.appendChild(row);
      return row;
    }
    var link = dom.el('a', 'mono tcard-line-value tcard-link');
    setHref(link, url);
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.appendChild(dom.el('span', '', text));
    link.appendChild(icon('external', 'tcard-link-glyph'));
    row.appendChild(link);
    body.appendChild(row);
    return row;
  }

  /* The leg the money is inside right now, off the view. At most one is true,
     and a view with none means nothing is in flight. */
  function runningLeg(view) {
    var legs = view && Array.isArray(view.txs) ? view.txs : [];
    for (var i = 0; i < legs.length; i += 1) {
      if (legs[i] && legs[i].running) return legs[i];
    }
    return legs.length ? legs[0] : null;
  }

  /* One transaction, from whichever of the four answers carried it. */
  function txOf(data) {
    var detail = isObject(data.tx) ? data.tx : null;
    var view = viewOf(data);
    var leg = runningLeg(view);
    var money = view && isObject(view.money) ? view.money : {};
    var hash = String((detail && detail.hash) || (leg && leg.hash) || data.hash || '');
    var state = view
      ? { tone: STAGE_TONE[view.stage] || 'running', label: String(view.stageLabel || '') }
      : (TX_STATE[String(detail && detail.status)] || TX_STATE.unknown);
    return {
      hash: hash,
      network: String((leg && leg.network) || data.network || ''),
      explorer: (leg && leg.explorer) || data.explorer || null,
      time: (detail && detail.time) || (view && (view.settledAt || view.lastChangeAt)) || null,
      state: view ? state : { tone: state[0], label: state[1] },
      amount: detail && detail.value !== null && detail.value !== undefined ? String(detail.value) : (money.amountIn === undefined ? null : money.amountIn),
      symbol: String((detail && detail.symbol) || money.symbol || ''),
      fee: detail && detail.fee ? String(detail.fee) : (money.feeUsd === null || money.feeUsd === undefined ? null : dom.fee(num(money.feeUsd))),
      from: (money.fromPocket) || (detail && detail.from) || null,
      to: (money.toPocket) || (detail && detail.to) || null,
      method: (detail && detail.method) || null,
      legs: view && Array.isArray(view.txs) ? view.txs : [],
      running: leg
    };
  }

  /* The rows of a list answer, from either shape: a chain's transactions or the
     intents ledger. One row is a time, what it was, how much, and with whom. */
  function txRows(data) {
    var parts = split(Array.isArray(data.rows) ? data.rows : []);
    var out = [];
    for (var i = 0; i < parts.rows.length; i += 1) {
      var r = parts.rows[i];
      if (!isObject(r)) continue;
      var intents = typeof r.cause === 'string';
      out.push({
        hash: String(r.hash || ''),
        time: r.time || null,
        word: intents ? (CAUSE_WORD[r.cause] || String(r.cause)) : (r.method || 'Transfer'),
        amount: intents ? String(r.delta || '') : (r.value === null || r.value === undefined ? '' : String(r.value)),
        symbol: String(r.token || r.symbol || ''),
        other: intents ? r.counterparty : r.to,
        state: intents ? null : (TX_STATE[String(r.status)] || TX_STATE.unknown)
      });
    }
    return { rows: out, dropped: parts.dropped };
  }

  function transactionCard(data, extra) {
    var list = Array.isArray(data.rows);
    var tx = list ? null : txOf(data);
    var where = String(data.network || data.account || (tx && tx.network) || '');
    var title = list
      ? (typeof data.account === 'string' && data.account ? 'Activity inside NEAR Intents' : 'Transactions on ' + chainName(where))
      : (tx.method ? String(tx.method) : 'Transaction');
    var parts = shell('transaction', icon('swap'), title, {
      state: list ? null : tx.state,
      amount: list ? '' : (tx.amount === null ? '' : tx.amount + ' ' + tx.symbol),
      open: extra.open,
      onToggle: extra.onToggle
    });
    if (!list && tx.hash) parts.card.id = 'card-tx-' + tx.hash;
    var body = parts.body;

    if (data.ok === false) {
      body.appendChild(dom.el('div', 'tcard-note tcard-note-down', String(data.error || data.note || 'The chain could not be read.')));
      return parts.card;
    }

    if (list) {
      var found = txRows(data);
      if (!found.rows.length) {
        emptyLine(body, 'Nothing here yet', String(data.note || ''));
        return parts.card;
      }
      var shown = found.rows.slice(0, MAX_ROWS);
      for (var i = 0; i < shown.length; i += 1) {
        var row = shown[i];
        var line = dom.el('div', 'tcard-line');
        var left = dom.el('span', 'tcard-line-label');
        left.appendChild(dom.el('span', '', row.word));
        if (row.other && !isAddress(row.other)) left.appendChild(mono('tcard-line-other', ' ' + String(row.other)));
        line.appendChild(left);
        line.appendChild(mono('tcard-line-value', (row.amount ? row.amount + ' ' + row.symbol : '') + (row.time ? '  ' + clock(row.time) : '')));
        body.appendChild(line);
      }
      moreLine(body, found.rows.length - shown.length + found.dropped, 'rows');
      return parts.card;
    }

    /* The pockets in the words the app uses for them, so the question a person
       actually has, where is my money right now, is answered on the card. */
    if (tx.from) factLine(body, 'From', chainName(tx.from), null, isAddress(tx.from));
    if (tx.to) factLine(body, 'To', chainName(tx.to), null, isAddress(tx.to));
    if (tx.fee) factLine(body, 'Fee', tx.fee);
    if (tx.time) factLine(body, tx.state.tone === 'confirmed' ? 'Confirmed at' : 'Last moved at', clock(tx.time), tx.state.tone === 'confirmed' ? 'up' : null);

    var running = tx.running;
    if (running && running.hash) linkRow(body, 'Where it is now', running.hash, running.explorer);
    else if (tx.hash) linkRow(body, 'Hash', tx.hash, tx.explorer);

    for (var j = 0; j < tx.legs.length; j += 1) {
      var leg = tx.legs[j];
      if (!leg || leg === running || !leg.hash) continue;
      linkRow(body, LEG_WORD[leg.leg] || String(leg.leg), leg.hash, null);
    }
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
    /* `show` names the card it wants, because one tool draws four of them. */
    var shown = shownCard(data);
    if (shown) return shown.kind;
    if (KINDS[name]) return KINDS[name];
    if (name === 'watch' && isObject(data) && typeof data.chain === 'string' && (data.asset !== undefined || data.watching !== undefined)) return 'deposit';
    return 'kv';
  }

  /* `extra` is the block's context: the tool name and input the answer came
     from, when it landed, whether the card starts open, and where to say so
     when a person toggles it. All optional. */
  function render(kind, data, extra) {
    var safe = isObject(data) ? data : {};
    var shown = shownCard(safe);
    if (shown) {
      kind = shown.kind;
      safe = shown.data;
    }
    var meta = extra || {};
    if (kind === 'balance') return balanceCard(safe, meta);
    if (kind === 'position') return positionCard(safe, meta);
    if (kind === 'move') return moveCard(safe, meta);
    if (kind === 'transaction') return transactionCard(safe, meta);
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
    var amount = num(r.amount);
    var figure = amount === null ? '' : dom.qty(amount) + ' ' + String(r.symbol || '');
    /* No stage word on this head: the receipt inside carries its own outcome, and the words
       for a stage live in src/proposals/view.ts, which a receipt does not carry. */
    var parts = shell('receipt', moveIcon(kind), TITLES[kind] || 'Move', {
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
    floorText: floorText,
    glyph: glyph,
    foldNames: foldNames
  };
})();
