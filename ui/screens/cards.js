/* The cards the conversation draws from a tool's answer.

   When the assistant reads the wallet, the window used to see the reply the
   model typed: a table in white letters, the same numbers the app already
   holds. Karim, 2026-09-15: "when I ask how much I won it just prints a boring
   white table". Now the driver hands the window the answer itself
   (src/driver.ts, the tool_data event) and this file turns it into a card:
   holdings with their marks, positions with their profit, a deposit address
   with a button that opens the real card, and one card per move that changes
   in place as the move runs. The assistant's words stay short around it.

   Every card is built with PhosphorDom and strings set as text. Nothing here
   reads a value as markup. The one card that decides anything is the move card,
   and its buttons are ui/screens/decision.js's, drawn from the server's row. The
   look lives in ui/design/cards.css and ui/design/chatcard.css: this file writes
   classes and data attributes, never a style. */
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
    ],
    /* The check a done move pops, drawn heavier than the line glyphs because it sits on a
       filled disc at a small size. */
    tick: [
      '',
      'M6.5 12.5l3.6 3.6L17.5 8.5',
      2.8
    ],
    /* What leaves, then what arrives: the arrow between the two legs of a move. */
    arrow: [
      '',
      'M5 12h14M13 6l6 6-6 6'
    ]
  };

  /* The two pockets are this window's own words; every real chain comes off the frame's table. */
  var POCKETS = { intents: 'NEAR Intents', hyperliquid: 'Hyperliquid' };

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

  /* The watch's phase as the deposit card's one word (src/vault/watch.ts), said only while the
     watch the card started is the one running. */
  var DEPOSIT_WORDS = {
    watching: 'Watching',
    seen: 'Arriving',
    bridged: 'Almost there',
    credited: 'In your balance'
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
    NOT_FOUND_OR_NOT_VALID: 'stalled',
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
    if (POCKETS[id]) return POCKETS[id];
    return window.PhosphorChains ? window.PhosphorChains.nameOf(id) : String(id || '');
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
    stroke.setAttribute('stroke-width', String(parts[2] || 1.5));
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

  /* A figure, in the words' face with tabular numerals, and an id, hash or address, in the mono
     face because each of its characters is read on its own. */
  function fig(className, text) {
    return dom.el('span', 'num ' + (className || ''), text);
  }

  function ident(className, text) {
    return dom.el('span', 'id ' + (className || ''), text);
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
     has a title, a state word and a figure to fit beside it in a 440 px column. */
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
     whole thing (the icon, the title, a state word, the figure, how long ago,
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
    var figure = dom.el('span', 'tcard-figure num', o.amount || '');
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
      row.appendChild(logo(h.symbol, 24));
      var name = dom.el('span', 'tcard-row-name');
      name.appendChild(dom.el('span', 'tcard-symbol', h.symbol));
      /* Only money outside the balance names its place: inside NEAR Intents is the balance. */
      if (h.place && h.place !== 'intents') name.appendChild(dom.el('span', 'tcard-place', chainName(h.place)));
      row.appendChild(name);
      /* The panel's words and figures for the same holding: its quantity, "under $0.01" rather
         than a $0.00 that says the coin is worth nothing, "price unavailable" for no price. */
      row.appendChild(fig('tcard-qty', dom.amount(h.quantity)));
      var worth = !h.priced ? 'price unavailable' : (h.usd > 0 && h.usd < 0.005 ? 'under $0.01' : dom.usd(h.usd));
      row.appendChild(fig('tcard-usd' + (h.priced ? '' : ' tcard-unpriced'), worth));
      list.appendChild(row);
    }
    body.appendChild(list);
    moreLine(body, held.rows.length - shown.length + held.dropped, 'assets');

    /* The total is the head's figure, once. A Total row under the list said it twice. */
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

    var facts = dom.el('span', 'tcard-row-facts num');
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
    value.appendChild(fig('tcard-pnl-usd', pnl === null ? '' : signed(pnl)));
    var roe = num(p.roePct);
    if (roe !== null) value.appendChild(fig('tcard-pnl-pct', (roe > 0 ? '+' : '') + roe.toFixed(1) + '%'));
    row.appendChild(value);
    return row;
  }

  function closedRow(f) {
    var row = dom.el('div', 'tcard-row tcard-closed');
    var coin = String(f.coin || '?');
    row.appendChild(logo(coin, 20));
    var name = dom.el('span', 'tcard-row-name');
    name.appendChild(dom.el('span', 'tcard-symbol', coin));
    var facts = dom.el('span', 'tcard-row-facts num');
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
    value.appendChild(fig('tcard-pnl-usd', pnl === null ? '' : signed(pnl)));
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
        summary.appendChild(fig('tcard-summary-value', dom.usd(Math.abs(sum))));
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

  /* ---------- the move card: a swap, a send, a trade, a rule change ---------- */

  /* THE CARD READS THE VIEW. src/proposals/view.ts builds one ProposalView per row,
     proposal_status returns it and /api/state carries it on every proposal, so the card and
     the assistant read the same truth. The view comes beside the row as `view` (a propose
     reply, a state frame row, `show`) or as the whole payload (proposal_status). Null where
     neither is there, which is a payload older than the view. */
  function viewOf(data) {
    if (!isObject(data)) return null;
    if (isObject(data.view)) return data.view;
    if (typeof data.stage === 'string' && typeof data.stageLabel === 'string') return data;
    return null;
  }

  /* How long a finished move took, in the fewest characters that still read. */
  function spanWords(seconds) {
    var n = Math.max(0, Math.round(Number(seconds) || 0));
    if (n < 60) return n + 's';
    var minutes = Math.floor(n / 60);
    if (minutes < 60) return minutes + 'm ' + String(n % 60).padStart(2, '0') + 's';
    return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
  }

  /* The one clock the card ever shows, and only once a move is late. It moves in steps a
     person reads rather than as a stopwatch: five seconds at a time under a minute, whole
     minutes after that. */
  function lateWords(seconds) {
    var n = Math.max(0, Math.floor(Number(seconds) || 0));
    if (n < 60) return (n - (n % 5)) + 's';
    if (n < 3600) return Math.floor(n / 60) + 'm';
    return Math.floor(n / 3600) + 'h ' + String(Math.floor((n % 3600) / 60)).padStart(2, '0') + 'm';
  }

  /* A duration a person would say: "about a minute", "about 2 minutes", "45 seconds". */
  function roughWords(seconds) {
    var n = Math.max(0, Math.round(Number(seconds) || 0));
    if (n >= 50 && n <= 75) return 'about a minute';
    if (n < 60) return n + ' seconds';
    return 'about ' + Math.round(n / 60) + ' minutes';
  }

  function secondsSince(iso) {
    var then = new Date(String(iso || '')).getTime();
    if (!isFinite(then)) return null;
    return Math.max(0, (Date.now() - then) / 1000);
  }

  /* One label at the left, one figure at the right. */
  function factLine(body, label, value, tone, wrap) {
    if (value === '' || value === null || value === undefined) return null;
    var row = dom.el('div', 'tcard-line');
    if (wrap) row.setAttribute('data-wrap', 'true');
    row.appendChild(dom.el('span', 'tcard-line-label', label));
    var figure = fig('tcard-line-value', value);
    if (tone) figure.setAttribute('data-tone', tone);
    row.appendChild(figure);
    body.appendChild(row);
    return figure;
  }

  /* An id a person can read past: the two ends, eight characters each, and the
     whole thing one click away on the Copy beside it. */
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
      var link = dom.el('a', 'id tcard-line-value tcard-link');
      setHref(link, url);
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.appendChild(dom.el('span', '', shortId(id)));
      link.appendChild(icon('external', 'tcard-link-glyph'));
      right.appendChild(link);
    } else {
      right.appendChild(ident('tcard-line-value', shortId(id)));
    }
    right.appendChild(copyButton(id));
    row.appendChild(right);
    body.appendChild(row);
    return row;
  }

  /* A line of evidence with every hash in it cut to its two ends. A hash is 64 hex characters
     (66 with its 0x) or a base58 signature of 64 or more; an address is 40 hex or a shorter
     base58 run and stays whole, because a shortened receiver is what a substituted one hides
     behind. */
  function shortenIds(text) {
    return String(text || '').replace(/0x[0-9a-fA-F]{64}\b|\b[0-9a-fA-F]{64}\b|\b[1-9A-HJ-NP-Za-km-z]{64,}\b/g, function (id) { return shortId(id); });
  }

  /* The vendor's word for a phase, in lower case with its underscores gone: evidence for
     Details, never a headline. */
  function vendorWord(stage) {
    return String(stage || '').toLowerCase().replace(/_/g, ' ');
  }

  /* The first sentence of a rail's or a rule's line, with any brace, bracket or quote run
     stripped and the rest cut. The whole line stays behind Details. */
  function reasonSentence(text) {
    var s = String(text || '').replace(/[{}\[\]"`]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var first = s.search(/[.!?](\s|$)/);
    if (first !== -1) {
      /* Two short sentences read better than one cut: "Nobody offered a price for this swap
         right now. Nothing moved." */
      var rest = s.slice(first + 1).trim();
      var second = rest.search(/[.!?](\s|$)/);
      s = second !== -1 && first + second < 150 ? s.slice(0, first + 1) + ' ' + rest.slice(0, second + 1) : s.slice(0, first + 1);
    }
    if (s.length > 160) s = s.slice(0, 157).replace(/\s+\S*$/, '') + '...';
    return s;
  }

  /* Everything the card needs, from any of the shapes a move arrives in: the answer to a
     propose (an id, a status, a verdict and a simulation, with the tool's own input beside
     it), a proposal read back with its draft, a state frame row, or a placeholder drawn from
     the propose call itself before any row exists. */
  function moveOf(name, input, data) {
    var args = isObject(input) ? input : {};
    var draft = isObject(data.draft) ? data.draft : null;
    /* A send's reply names its rail kind on the `send` facts (src/http/propose.ts), because
       one tool, propose_send, drafts either of two kinds and the tool name cannot say which. */
    var sendFacts = isObject(data.send) ? data.send : null;
    var view = viewOf(data);
    var kind = String((draft && draft.kind) || (view && view.kind) || data.kind || (sendFacts && sendFacts.kind) || bare(name).replace(/^propose_/, '') || 'move');
    var move = {
      kind: kind,
      title: TITLES[kind] || kindWords(kind),
      id: typeof data.id === 'string' ? data.id : (view && typeof view.id === 'string' ? view.id : ''),
      from: null,
      to: null,
      feeUsd: null,
      floor: null,
      quote: '',
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
    if (view && typeof view.sentence === 'string' && view.sentence) move.summary = view.sentence;

    /* The reason a move did not happen, in the plainest words on hand: the view's reason (the
       cause's one sentence, and the engineer's line behind it), else its error, else what the
       row itself carries. The rail's whole line goes behind Details. */
    var rail = result && typeof result.detail === 'string' ? result.detail : (sim && typeof sim.error === 'string' ? sim.error : '');
    var why = view && isObject(view.reason) && typeof view.reason.sentence === 'string' && view.reason.sentence ? view.reason : null;
    if (why && why.code !== 'needs_approval') {
      move.reason = String(why.sentence);
      move.detail = typeof why.details === 'string' ? why.details : '';
    } else if (view && isObject(view.error) && view.error.message) {
      move.detail = String(view.error.message);
      move.reason = view.stage === 'stalled' ? '' : reasonSentence(view.error.message);
    } else if (status === 'policy_refused' && verdict && Array.isArray(verdict.reasons) && verdict.reasons.length) {
      move.reason = reasonSentence(verdict.reasons[verdict.reasons.length - 1]);
    } else if (!view && verdict && verdict.outcome === 'refuse') {
      move.reason = reasonSentence(Array.isArray(verdict.reasons) && verdict.reasons.length ? verdict.reasons[verdict.reasons.length - 1] : 'A rule in the policy refused it.');
    } else if (status === 'failed' || (!view && sim && sim.ok === false)) {
      move.detail = rail;
      move.reason = reasonSentence(rail || 'The venue did not take it.');
    }
    if (!move.detail && rail) move.detail = rail;

    var d = draft || {};
    if (kind === 'swap') {
      var q = isObject(d.quote) ? d.quote : null;
      move.from = { symbol: d.fromSymbol || args.fromSymbol, place: 'intents', amount: num(d.amountIn !== undefined ? d.amountIn : args.amountIn) };
      move.to = { symbol: d.toSymbol || args.toSymbol, place: 'intents', amount: q ? num(q.amountOut) : null, about: true };
      if (q) move.feeUsd = num(q.feeUsd);
      /* The floor the fill is held to: the protection on a swap, whether the rail quoted it
         or the draft named it. */
      var floor = sim && isObject(sim.swap) && num(sim.swap.receivesAtLeast) !== null ? num(sim.swap.receivesAtLeast) : null;
      if (floor === null && num(args.minAmountOut) !== null) floor = num(args.minAmountOut);
      if (floor === null && d.minAmountOut !== undefined && num(d.minAmountOut) !== null) floor = num(d.minAmountOut);
      move.floor = floor;
      if (floor !== null) move.quote = 'at least ' + floorText(floor) + ' ' + String(move.to.symbol || '');
      if (move.to.amount === null && sim && isObject(sim.swap) && num(sim.swap.receives) !== null) move.to.amount = num(sim.swap.receives);
      if (move.feeUsd === null && sim && isObject(sim.swap) && num(sim.swap.feeUsd) !== null) move.feeUsd = num(sim.swap.feeUsd);
    } else if (kind === 'intents_deposit') {
      move.from = { symbol: d.symbol || args.symbol, place: d.chain || args.chain, amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: d.symbol || args.symbol, place: 'intents', amount: num(d.minCredited), floor: true };
      move.floor = num(d.minCredited);
    } else if (kind === 'intents_withdraw') {
      move.from = { symbol: d.symbol || args.symbol, place: 'intents', amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = { symbol: d.symbol || args.symbol, place: d.chain || args.chain, amount: num(d.minReceived), floor: true };
      move.floor = num(d.minReceived);
    } else if (kind === 'intents_send' || kind === 'intents_pay') {
      /* The receiver is the fact this card exists to show: the whole address, never
         shortened, where the decision is made. */
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
      move.floor = move.to.amount;
      if (sendSim && num(sendSim.feeUsd) !== null) move.feeUsd = num(sendSim.feeUsd);
      move.recipient = isObject(d.recipient) ? d.recipient : (isObject(send.recipient) ? send.recipient : null);
      move.activity = sendSim && sendSim.activity ? String(sendSim.activity) : '';
      move.preflight = Array.isArray(data.preflight) && data.preflight.length ? data.preflight[data.preflight.length - 1] : null;
    } else if (kind === 'hl_deposit' || kind === 'hl_withdraw') {
      /* The leg says what the quote expects ("about"), the facts hold the floor the rail
         holds the venue to ("at least"), and the settled figure replaces both once it lands. */
      var hlSim = sim && isObject(sim.send) ? sim.send : null;
      var hlFloor = hlSim && num(hlSim.arrivesAtLeast) !== null ? num(hlSim.arrivesAtLeast) : num(kind === 'hl_deposit' ? d.minCredited : d.minReceived);
      var hlArrives = hlSim && num(hlSim.arrives) !== null ? num(hlSim.arrives) : null;
      var inPocket = kind === 'hl_deposit' ? 'intents' : 'hyperliquid';
      var outPocket = kind === 'hl_deposit' ? 'hyperliquid' : 'intents';
      move.from = { symbol: d.symbol || args.symbol || 'USDC', place: inPocket, amount: num(d.amount !== undefined ? d.amount : args.amount) };
      move.to = hlArrives !== null
        ? { symbol: 'USDC', place: outPocket, amount: hlArrives, about: true }
        : { symbol: 'USDC', place: outPocket, amount: hlFloor, floor: true };
      move.floor = hlFloor;
      if (hlArrives !== null && hlFloor !== null) move.quote = 'at least ' + floorText(hlFloor) + ' USDC';
      if (hlSim && num(hlSim.feeUsd) !== null) move.feeUsd = num(hlSim.feeUsd);
    } else if (kind === 'trade' || kind === 'trade_change') {
      var plan = isObject(d.plan) ? d.plan : (isObject(args.plan) ? args.plan : null);
      if (plan) {
        move.title = (plan.side === 'short' ? 'Short ' : 'Long ') + String(plan.symbol || '');
        move.coin = String(plan.symbol || '');
        /* The collateral, not the notional: the figure the policy governs and the one that
           can be lost. */
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
    /* A rule change's sentence is the one string on a proposal that the agent types rather
       than the app composes, so the view's line wins wherever there is one. */
    if (kind === 'policy_change' && !(view && view.sentence)) {
      move.summary = String(d.sentence || args.sentence || move.summary || '');
    }
    return move;
  }

  /* A kind nobody wrote a word for still reads as words, never as the raw enum. */
  function kindWords(kind) {
    var words = String(kind === null || kind === undefined ? '' : kind).replace(/_/g, ' ').trim();
    if (!words) return 'Move';
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /* A floor to six significant figures, CUT rather than rounded. It is a promise the rail holds
     the venue to, so it never says more than the rail does: rounding half-up printed 5.934637
     as 5.93464, a floor the venue could legally land under. */
  function floorText(value) {
    var n = Number(value);
    if (!isFinite(n)) return '';
    if (n === 0) return '0';
    var scale = Math.pow(10, 5 - Math.floor(Math.log10(Math.abs(n))));
    var cut = Math.floor(n * scale) / scale;
    return cut.toLocaleString('en-US', { maximumSignificantDigits: 6 });
  }

  /* An amount on the card's face: four places for a whole coin, four significant figures under
     one, so 0.00149 ETH reads as 0.00149 and not as 0.0015. */
  function amountText(value) {
    var n = num(value);
    if (n === null) return '';
    if (Math.abs(n) >= 1 || n === 0) return dom.qty(n);
    return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  }

  /* The address in groups of four so a person can check it against what they typed, group
     by group. A named NEAR account stays whole: splitting alice.near helps nobody. */
  /* A hex address is "0x" and then its forty characters in tens of four, so the groups a
     person compares start where the address does; a base58 key is fours from its start. */
  function groupsOf(address) {
    var s = String(address || '');
    if (s === '') return [];
    var hex = /^0x[0-9a-fA-F]{40}$/.test(s);
    if (!hex && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return [s];
    var out = hex ? ['0x'] : [];
    for (var i = hex ? 2 : 0; i < s.length; i += 4) out.push(s.slice(i, i + 4));
    return out;
  }

  /* A NEAR account or a similar name reads as itself: alice.near is its own check. */
  function isNamedAccount(address) {
    return /^(?!0x)[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(String(address || ''));
  }

  /* A receiver on the face of a send: every character in groups with the first and the last
     group, the ones a person checks, a step heavier, and its Copy at the line's end; the explorer
     link when the server built one; the network it lands on; and whether this is the first send
     to it: a first send to an address is the one a person should look at twice. A named account
     is already whole in the card's head, so it is not printed a second time. */
  /* An address's groups in the tones Add money prints them in (ui/design/deposit.css): the
     "0x" quiet, the first and the last group, the ones a person checks, in the text colour, and
     the rest a step quieter. */
  function groupTone(i, first, count) {
    if (i < first) return 'addr-prefix';
    return count - first > 2 && i !== first && i !== count - 1 ? 'addr-mid' : 'addr-end';
  }

  function addressBlock(address, explorer, recipient, place) {
    var wrap = dom.el('div', 'mcard-address');
    if (!isNamedAccount(address)) {
      var row = dom.el('div', 'mcard-address-row');
      var line = dom.el('p', 'mcard-address-line id');
      var groups = groupsOf(address);
      var first = groups[0] === '0x' ? 1 : 0;
      for (var i = 0; i < groups.length; i += 1) {
        line.appendChild(dom.el('span', 'tcard-leg-group ' + groupTone(i, first, groups.length), groups[i]));
      }
      dom.setAttr(line, 'data-address', address);
      row.appendChild(line);
      row.appendChild(copyButton(address));
      wrap.appendChild(row);
    }
    var actions = dom.el('div', 'tcard-leg-actions');
    if (explorerUrl(explorer)) {
      var link = dom.el('a', 'btn btn-quiet btn-sm tcard-leg-explorer');
      setHref(link, explorer);
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.appendChild(dom.el('span', 'btn-label', 'Explorer'));
      link.appendChild(icon('external'));
      actions.appendChild(link);
    }
    if (actions.firstChild) wrap.appendChild(actions);
    var known = isObject(recipient) && recipient.known === true;
    var count = known ? (num(recipient.count) || 0) : 0;
    var network = place ? (/^[aeiou]/i.test(place) ? 'An ' : 'A ') + place + ' address. ' : '';
    var note = dom.el('p', 'mcard-address-note', network + (known
      ? 'Sent here ' + count + (count === 1 ? ' time before.' : ' times before.')
      : 'First send to this address.'));
    dom.setAttr(note, 'data-first', known ? null : 'true');
    wrap.appendChild(note);
    return wrap;
  }

  function moveIcon(kind) {
    if (kind === 'trade' || kind === 'trade_change') return icon('long');
    if (kind === 'intents_deposit' || kind === 'hl_deposit') return icon('deposit');
    if (kind === 'intents_withdraw' || kind === 'intents_send' || kind === 'intents_pay' || kind === 'hl_withdraw') return icon('withdraw');
    if (kind === 'policy_change') return icon('armed');
    return icon('swap');
  }

  /* The legs, off the view's money: what left, what arrives, and the two pockets by name. A
     view is the only place that knows both sides after the rail has answered, so it wins over
     the draft wherever it has the figure. */
  function viewLegs(view, fallback) {
    var money = isObject(view.money) ? view.money : {};
    var symbol = String(money.symbol || (fallback.from && fallback.from.symbol) || '');
    var toSymbol = String(money.toSymbol || (fallback.to && fallback.to.symbol) || symbol);
    var from = money.amountIn === null || money.amountIn === undefined ? fallback.from : {
      symbol: symbol,
      place: pocketId(money.fromPocket) || (fallback.from && fallback.from.place) || '',
      amount: num(money.amountIn),
      usd: fallback.from ? fallback.from.usd : undefined,
      label: fallback.from ? fallback.from.label : undefined
    };
    var base = fallback.to || {};
    var landed = view.stage === 'confirmed' || view.state === 'done';
    /* Landed, the figure is what arrived and it is a fact. Before that a leg that carries a
       floor keeps the floor, and one without shows the quote's expected figure as "about". */
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

  /* The view names a pocket by its label ("NEAR Intents", "Hyperliquid") and a draft by its id. */
  function pocketId(pocket) {
    if (!pocket) return '';
    var text = String(pocket);
    for (var id in POCKETS) {
      if (Object.prototype.hasOwnProperty.call(POCKETS, id) && POCKETS[id] === text) return id;
    }
    return window.PhosphorChains ? window.PhosphorChains.idOf(text) : text;
  }

  function reducedMotion() {
    var motion = window.PhosphorMotion;
    return !!(motion && typeof motion.reduced === 'function' && motion.reduced());
  }

  /* A card that changes state eases to its new height rather than jumping (criterion 5.3): the
     facts and the buttons leaving after a yes, a late line arriving, a working card's two lines
     becoming the done card's one. The height is held where it was for a frame and let go to
     where it is now; the column's follow keeps its end in view through it. */
  var EASE_MS = 240;

  /* A fold closing: its fade, on the exit curve (--ease-exit, --dur-close). */
  var CLOSE_FADE_MS = 200;
  var EXIT_EASE = 'cubic-bezier(0.4, 0, 0.6, 1)';

  function easeHeight(card, from, memo) {
    if (!(from > 0) || reducedMotion() || typeof card.getBoundingClientRect !== 'function') return;
    var to = card.getBoundingClientRect().height;
    if (!(Math.abs(to - from) > 1)) return;
    window.clearTimeout(memo.easeTimer);
    card.style.transition = 'none';
    card.style.overflow = 'hidden';
    card.style.height = from + 'px';
    card.getBoundingClientRect();
    card.style.transition = 'height ' + EASE_MS + 'ms var(--ease-out)';
    card.style.height = to + 'px';
    memo.easeTimer = window.setTimeout(function () {
      card.style.height = '';
      card.style.overflow = '';
      card.style.transition = '';
    }, EASE_MS + 40);
  }

  /* A text that changes with a fade rather than a cut. The attribute alternates between two
     names so the animation restarts on every change and never on a repaint that changed
     nothing. The first paint sets no fade: the card's own entrance already carries it in. */
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

  /* THE ONE FOLD: who decided and when, the reference support asks for, the hash where the
     money is, the venue's own words on a move that stopped, and a send's checks. Closed until
     a person opens it, and the open state is the caller's so it survives every repaint. */
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
    }
    function set(next, tell) {
      open = !!next;
      apply();
      if (tell && typeof o.onToggle === 'function') o.onToggle(open);
    }
    dom.on(head, 'click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      set(!open, true);
    });
    apply();
    return {
      wrap: wrap,
      head: head,
      body: body,
      isOpen: function () { return open; },
      setOpen: function (next) { set(next, false); },
      toggle: function () { set(!open, true); }
    };
  }

  /* ---------- the plain state ---------- */

  /* FIVE STATES, NOT TWENTY-THREE. Karim, 2026-09-23: statuses felt delayed, three clocks
     ticked and a person did not know where to look. A move is working, needs you, done, did not
     go through, or is coming back (money that left and is on its way back: not over, and never
     "Didn't go through", which reads as nothing moved), and a working move is late once it runs
     past its usual time. The view names the state (contract 5); a view from before that field is
     read through its stage. */
  var PLAIN_STATES = { working: true, needs_you: true, done: true, didnt_go_through: true, coming_back: true };
  var WAITING_STAGES = { waiting_for_you: true, waiting_for_unlock: true, waiting_for_touch: true };
  var WAITING_STATUS = { pending: true, pending_unlock: true, awaiting_touch: true };

  /* The word a working card wears, by kind. Only the kind: which vendor phase the rail is in is
     evidence for Details, never the face. */
  var WORKING_WORDS = {
    swap: 'Swapping',
    intents_send: 'Sending',
    intents_pay: 'Paying out',
    intents_withdraw: 'Withdrawing',
    intents_deposit: 'Depositing',
    hl_deposit: 'Funding trading',
    hl_withdraw: 'Bringing it back',
    trade: 'Placing the trade',
    trade_change: 'Changing the trade',
    policy_change: 'Saving the change'
  };

  /* A usual duration for a kind whose view names none, so the progress track has a pace. */
  var USUAL_SEC = 45;

  function rowState(row, status) {
    if (row.placeholder === true) return row.failed === true ? 'didnt_go_through' : 'working';
    if (WAITING_STATUS[status]) return 'needs_you';
    if (status === 'executed') return 'done';
    if (status === 'failed' || status === 'refused' || status === 'policy_refused') return 'didnt_go_through';
    if (isObject(row.verdict) && row.verdict.outcome === 'refuse') return 'didnt_go_through';
    if (isObject(row.simulation) && row.simulation.ok === false && !row.status) return 'didnt_go_through';
    return 'working';
  }

  /* The sentence under a move that did not go through: what happened, where the money is,
     what to do. The view's reason when it has one, else the plainest line on hand. */
  function didntSentence(row, view, move) {
    if (view && isObject(view.reason) && typeof view.reason.sentence === 'string' && view.reason.sentence) return String(view.reason.sentence);
    if (view && view.state === 'coming_back') return 'This did not go through. Your money is on its way back to your balance, and this card changes when it lands.';
    if (row.placeholder === true) return 'This did not reach your wallet. Nothing moved.';
    var stage = view ? view.stage : '';
    if (stage === 'declined' || row.status === 'refused') return 'You said no. Nothing moved.';
    /* A rule's refusal is the app's own sentence about its own rule, and it is true to the
       cause (no price, a cap, a failed check). A venue's failure is the venue's words, which
       stay behind Details: the face gets the app's plain copy for that end instead. */
    if ((stage === 'refused' || row.status === 'policy_refused' || (!view && isObject(row.verdict) && row.verdict.outcome === 'refuse')) && move.reason) return move.reason;
    if (stage === 'failed') return 'It did not go through, and nothing more will be signed. Check your balance before you try again.';
    if (view && view.stageCopy) return String(view.stageCopy);
    return 'It did not go through. Check your balance before you try again.';
  }

  function plainOf(row, view, move) {
    var status = typeof row.status === 'string' ? row.status : '';
    var state = view && PLAIN_STATES[view.state] ? view.state : null;
    if (!state && view) {
      if (WAITING_STAGES[view.stage]) state = 'needs_you';
      else if (view.stage === 'confirmed') state = 'done';
      else if (view.terminal === true && view.stage !== 'stalled') state = 'didnt_go_through';
      else state = 'working';
    }
    if (!state) state = rowState(row, status);
    var stage = view ? String(view.stage || '') : '';
    var start = (view && (view.decidedAt || view.createdAt)) || row.decidedAt || row.createdAt || null;
    /* `late` is the view's { elapsedSec, typicalSec } once a working move runs past its usual
       time. The elapsed figure is counted here from the click, so the words move between
       frames. */
    var lateView = view && isObject(view.late) ? view.late : null;
    var typical = view && num(view.typicalSec) !== null && num(view.typicalSec) > 0 ? num(view.typicalSec) : (lateView && num(lateView.typicalSec) > 0 ? num(lateView.typicalSec) : null);
    var elapsed = secondsSince(start);
    if (elapsed === null && lateView && num(lateView.elapsedSec) !== null) elapsed = num(lateView.elapsedSec);
    var flagged = !!view && (view.late === true || lateView !== null || stage === 'stalled');
    var late = state === 'working' && !row.placeholder && (flagged || (typical !== null && elapsed !== null && elapsed > typical));
    return {
      state: state,
      stage: stage,
      late: late,
      start: start,
      typical: typical,
      elapsed: elapsed,
      took: view && num(view.tookSec) !== null && num(view.tookSec) > 0 ? num(view.tookSec) : null,
      held: stage === 'held' || (status === 'approved' && typeof row.heldSince === 'string'),
      locked: status === 'pending_unlock' || stage === 'waiting_for_unlock',
      touching: status === 'awaiting_touch' || stage === 'waiting_for_touch',
      declined: stage === 'declined',
      placeholder: row.placeholder === true,
      retry: !!view && isObject(view.reason) && view.reason.retry === true,
      sentence: state === 'didnt_go_through' || state === 'coming_back' ? didntSentence(row, view, move) : '',
      /* A finished move with a catch: less arrived than was approved (view.note). */
      note: state === 'done' && view && typeof view.note === 'string' ? view.note : ''
    };
  }

  function stateWords(plain, move) {
    if (plain.state === 'needs_you') {
      if (plain.locked) return 'Unlock to decide';
      if (plain.touching) return 'Confirm on your Mac';
      return 'Needs your OK';
    }
    if (plain.state === 'done') return plain.took !== null ? 'Done · ' + spanWords(plain.took) : 'Done';
    if (plain.state === 'didnt_go_through') return plain.declined ? 'Cancelled' : "Didn't go through";
    if (plain.state === 'coming_back') return 'Refund on its way';
    if (plain.placeholder) return move.kind === 'swap' ? 'Checking prices' : 'Getting ready';
    if (plain.late) return 'Taking longer · ' + lateWords(plain.elapsed);
    if (plain.held) return 'Waiting to start';
    return WORKING_WORDS[move.kind] || 'Working';
  }

  /* ---------- the live cards' one clock ---------- */

  /* One timer for every working card on screen, at a second, and only while one is working:
     it moves the late words and nothing else. Each card says when it is done with it. */
  var liveCards = [];
  var liveTimer = 0;

  function watchLive(fn) {
    if (liveCards.indexOf(fn) === -1) liveCards.push(fn);
    if (!liveTimer && typeof window.setInterval === 'function') liveTimer = window.setInterval(tickLive, 1000);
  }

  function tickLive() {
    for (var i = liveCards.length - 1; i >= 0; i -= 1) {
      if (liveCards[i]() === false) liveCards.splice(i, 1);
    }
    if (!liveCards.length && liveTimer) {
      window.clearInterval(liveTimer);
      liveTimer = 0;
    }
  }

  /* ---------- the move card ---------- */

  /* The figures a decision is made on, side by side and read at a glance: each its label
     over its figure ("You pay" over "500 USDC", "You get at least" over "0.1843 ETH", "Fee"
     over "$0.21"), the figure in the words' face with tabular numerals. They wrap to a second
     row, never under each other's words, when the card is narrow. Built once per shape, and
     the numbers roll (dom.setNumber) when a later frame moves them. */
  /* What a person calls a coin. wNEAR is the name the verifier stores for NEAR held inside
     NEAR Intents, the same coin (src/proposals/view.ts plainSymbol); the mark still looks up
     the stored name. */
  function coinWord(symbol) {
    var s = String(symbol || '');
    return s.toUpperCase() === 'WNEAR' ? 'NEAR' : s;
  }

  function factsFor(move, legs) {
    var from = legs.from || move.from;
    var out = [];
    var kind = move.kind;
    var toSymbol = coinWord((legs.to && legs.to.symbol) || (move.to && move.to.symbol) || '');
    var inFact = null;
    if (from && from.amount !== null && from.amount !== undefined) {
      inFact = from.usd ? [dom.usd(from.amount), ''] : [amountText(from.amount), coinWord(from.symbol)];
    }
    var floorFact = move.floor !== null && move.floor !== undefined ? [floorText(move.floor), toSymbol] : null;
    var words;
    if (kind === 'swap') words = ['You pay', 'You get at least'];
    else if (kind === 'intents_send' || kind === 'intents_pay') words = ['You send', 'They get at least'];
    else if (kind === 'intents_withdraw' || kind === 'intents_deposit' || kind === 'hl_deposit' || kind === 'hl_withdraw') words = ['You move', 'Arrives at least'];
    else return out;
    if (inFact) out.push([words[0], inFact[0], inFact[1]]);
    if (floorFact) out.push([words[1], floorFact[0], floorFact[1]]);
    /* A fee of nothing is said in words, quietly, not as a bold $0.00. */
    var feeUsd = legs.feeUsd !== null && legs.feeUsd !== undefined ? num(legs.feeUsd) : null;
    if (feeUsd === 0) out.push(['Fee', 'No fee', '', 'quiet']);
    else if (feeUsd !== null) out.push(['Fee', dom.fee(feeUsd), '']);
    return out;
  }

  function paintFacts(host, facts, memo) {
    var shape = facts.map(function (f) { return f[0] + ':' + f[2] + ':' + (f[3] || ''); }).join('|');
    if (memo.factShape !== shape) {
      memo.factShape = shape;
      dom.clear(host);
      memo.factValues = [];
      for (var i = 0; i < facts.length; i += 1) {
        var part = dom.el('span', 'mcard-fact');
        part.appendChild(dom.el('span', 'mcard-fact-label', facts[i][0]));
        var value = dom.el('b', 'mcard-fact-value');
        if (facts[i][3] === 'quiet') value.setAttribute('data-quiet', 'true');
        var figure = dom.el('span', 'num');
        value.appendChild(figure);
        if (facts[i][2]) value.appendChild(dom.el('span', '', ' ' + facts[i][2]));
        part.appendChild(value);
        host.appendChild(part);
        memo.factValues.push(figure);
      }
    }
    for (var j = 0; j < facts.length; j += 1) dom.setNumber(memo.factValues[j], facts[j][1]);
    dom.setHidden(host, !facts.length);
  }

  /* The coin marks at the head: the two a swap moves between, overlapped, or the one coin a
     send or a trade is about, or the kind's own glyph in a disc when no coin says it. */
  function paintMarks(host, move, legs, memo) {
    var from = (legs.from && legs.from.symbol) || (move.from && move.from.symbol) || '';
    var to = (legs.to && legs.to.symbol) || (move.to && move.to.symbol) || '';
    var key;
    if (move.kind === 'swap' && from && to) key = 'pair:' + from + ':' + to;
    else if (move.coin) key = 'coin:' + move.coin;
    else if (from && move.kind !== 'policy_change' && move.kind !== 'trade_change') key = 'coin:' + from;
    else key = 'glyph:' + move.kind;
    if (memo.marks === key) return;
    memo.marks = key;
    dom.clear(host);
    var parts = key.split(':');
    /* The size is the head's (chatcard.css .mcard-marks .logo), so none is passed here. */
    if (parts[0] === 'pair') {
      host.appendChild(logo(parts[1]));
      host.appendChild(logo(parts[2]));
      dom.setAttr(host, 'data-pair', 'true');
      return;
    }
    dom.setAttr(host, 'data-pair', null);
    if (parts[0] === 'coin') {
      host.appendChild(logo(parts[1]));
      return;
    }
    var disc = dom.el('span', 'mcard-glyph');
    disc.appendChild(moveIcon(move.kind));
    host.appendChild(disc);
  }

  /* What the move is, in one line: "Swap 4 USDC to ETH" for a swap until it lands and
     "4 USDC -> 0.00149 ETH" once it has, "5 USDC -> alice.near" for a send, the plan's own words
     for a trade or a rule. The amounts roll. */
  /* A payout's network by name ("Base"): its receiver is outside the balance, and the same
     address on another chain is somebody else's money. A send to a NEAR account stays inside
     NEAR Intents and names none. */
  var CHAIN_WORDS = { eth: 'Ethereum', ethereum: 'Ethereum', arb: 'Arbitrum', arbitrum: 'Arbitrum', base: 'Base', op: 'Optimism', pol: 'Polygon', avax: 'Avalanche', bsc: 'BNB Chain', sol: 'Solana', solana: 'Solana', btc: 'Bitcoin', bitcoin: 'Bitcoin', near: 'NEAR', ton: 'TON', sui: 'Sui', tron: 'Tron', doge: 'Dogecoin', xrp: 'XRP Ledger' };

  function payoutPlace(move, legs) {
    if (move.kind !== 'intents_pay') return '';
    var to = legs.to || move.to || {};
    var place = String(to.place || '');
    if (!place || place === 'intents') return '';
    /* The state frame's chain table names it; before that frame lands, the common ids have
       their names here rather than printing "eth". */
    var name = String(chainName(place) || '');
    if (name && name !== place) return name;
    return Object.prototype.hasOwnProperty.call(CHAIN_WORDS, place.toLowerCase()) ? CHAIN_WORDS[place.toLowerCase()] : place;
  }

  function destinationWord(move, legs) {
    var kind = move.kind;
    var to = legs.to || move.to || {};
    if (kind === 'intents_send' || kind === 'intents_pay') {
      var address = String(to.address || '');
      var short = address.length > 24 ? shortId(address) : address;
      var where = payoutPlace(move, legs);
      return where ? short + ' on ' + where : short;
    }
    if (kind === 'hl_deposit') return 'trading account';
    if (kind === 'hl_withdraw' || kind === 'intents_deposit') return 'your balance';
    if (kind === 'intents_withdraw') return to.place ? chainName(to.place) : '';
    return '';
  }

  function paintMove(host, move, legs, plain, memo, headline) {
    var from = legs.from || move.from;
    var to = legs.to || move.to;
    var parts = [];
    var twoLegs = move.kind === 'swap' || move.kind === 'intents_send' || move.kind === 'intents_pay'
      || move.kind === 'intents_withdraw' || move.kind === 'intents_deposit' || move.kind === 'hl_deposit' || move.kind === 'hl_withdraw';
    var words = false;
    if (move.kind === 'swap' && plain.state !== 'done' && from && from.symbol) {
      /* Until it lands, a swap's line is words: what it is, from what, to what. What comes
         back is a figure, and figures stand in the facts under it, never guessed at here. */
      words = true;
      parts.push({ kind: 'title', value: 'Swap' });
      parts.push({ kind: 'amount', value: from.amount !== null && from.amount !== undefined ? amountText(from.amount) : '', symbol: coinWord(from.symbol) });
      if (to && to.symbol) parts.push({ kind: 'word', value: 'to ' + coinWord(to.symbol) });
    } else if (twoLegs && from && from.symbol) {
      var fromAmount = from.amount !== null && from.amount !== undefined ? amountText(from.amount) : '';
      parts.push({ kind: 'amount', value: fromAmount, symbol: coinWord(from.symbol) });
      parts.push({ kind: 'arrow' });
      var word = destinationWord(move, legs);
      if (move.kind === 'swap') {
        var toAmount = to && to.amount !== null && to.amount !== undefined ? amountText(to.amount) : '';
        parts.push({ kind: 'amount', value: toAmount, symbol: coinWord(to && to.symbol) });
      } else if (word) {
        parts.push({ kind: 'word', value: word });
      }
    } else {
      parts.push({ kind: 'title', value: headline || move.title });
      if (from && from.usd && from.amount !== null && from.amount !== undefined) parts.push({ kind: 'amount', value: dom.usd(from.amount), symbol: '', bare: true });
    }
    var shape = parts.map(function (p) {
      return p.kind === 'amount' ? 'a:' + p.symbol + ':' + (p.value ? '1' : '0') : p.kind + ':' + (p.kind === 'arrow' ? '' : p.value);
    }).join('|');
    if (memo.moveShape !== shape) {
      memo.moveShape = shape;
      dom.setAttr(host, 'data-words', words ? 'true' : null);
      dom.clear(host);
      memo.moveNumbers = [];
      for (var i = 0; i < parts.length; i += 1) {
        var p = parts[i];
        if (p.kind === 'arrow') {
          host.appendChild(glyph('arrow', 'mcard-arrow'));
          continue;
        }
        if (p.kind === 'title' || p.kind === 'word') {
          host.appendChild(dom.el('span', p.kind === 'title' ? 'mcard-title' : 'mcard-word', p.value));
          continue;
        }
        var leg = dom.el('span', 'mcard-leg');
        var figure = dom.el('span', 'num mcard-num');
        leg.appendChild(figure);
        if (p.symbol) leg.appendChild(dom.el('span', 'mcard-sym', (p.value ? ' ' : '') + p.symbol));
        host.appendChild(leg);
        memo.moveNumbers.push(figure);
      }
    }
    var n = 0;
    for (var k = 0; k < parts.length; k += 1) {
      if (parts[k].kind !== 'amount') continue;
      var node = memo.moveNumbers[n];
      n += 1;
      if (node) dom.setNumber(node, parts[k].value);
    }
  }

  /* ONE CARD PER MOVE, AND IT CHANGES IN PLACE.

     Karim, 2026-09-23: a status card covered the whole chat, statuses felt late, three clocks
     ticked and tool steps cluttered the thread. The move lives here and nowhere else: one
     compact card in the thread, built once and repainted by `node.__paint(row, extra)` on
     every state frame. Working, it is one line with a hairline track easing along its bottom
     edge at the move's usual pace; needing the person, it opens one line of figures and the
     two buttons, and Approve breathes; done, it folds to "Done · 6s"; did not go through, it
     says what happened, where the money is and what to do. The venue's own words and the ids
     sit behind Details. No clock shows until a move is late. */
  function moveCard(data, extra) {
    var meta = extra || {};
    var card = dom.el('section', 'tcard mcard');
    card.setAttribute('data-card', 'move');

    var head = dom.el('div', 'mcard-head');
    var marks = dom.el('span', 'mcard-marks');
    var moveLine = dom.el('span', 'mcard-move');
    var stateBox = dom.el('span', 'mcard-state');
    var stateIcon = dom.el('span', 'mcard-state-icon');
    var stateWord = dom.el('span', 'mcard-state-word');
    stateBox.appendChild(stateIcon);
    stateBox.appendChild(stateWord);
    head.appendChild(marks);
    head.appendChild(moveLine);
    head.appendChild(stateBox);
    card.appendChild(head);

    var body = dom.el('div', 'mcard-body');
    var line = dom.el('p', 'mcard-line');
    var facts = dom.el('div', 'mcard-facts');
    var address = dom.el('div', 'mcard-extra mcard-to');
    var decide = dom.el('div', 'mcard-extra mcard-decide');
    /* One row for what can be pressed: Details at the left, the answers at the right. */
    var bar = dom.el('div', 'mcard-bar');
    var toggle = dom.el('button', 'mcard-details-toggle');
    toggle.type = 'button';
    toggle.appendChild(glyph('chevron', 'mcard-details-chevron'));
    toggle.appendChild(dom.el('span', '', 'Details'));
    var actions = dom.el('div', 'mcard-actions');
    bar.appendChild(toggle);
    bar.appendChild(actions);
    var note = dom.el('div', 'mcard-note-slot');
    var details = detailsFold({ open: meta.detailsOpen === true, onToggle: meta.onDetailsToggle });
    body.appendChild(line);
    body.appendChild(facts);
    body.appendChild(address);
    body.appendChild(decide);
    body.appendChild(bar);
    body.appendChild(note);
    body.appendChild(details.wrap);
    card.appendChild(body);

    /* The hairline along the bottom edge while the move works, easing toward the end over the
       move's usual time and holding short of it until the move lands. */
    var track = dom.el('span', 'mcard-track');
    track.setAttribute('aria-hidden', 'true');
    track.appendChild(dom.el('span', 'mcard-track-fill'));
    card.appendChild(track);

    var memo = {};
    var last = { row: data, meta: meta };
    var ask = null;

    /* Working and done cards fold to their head, and the head opens the Details under it. A
       card that asks or that did not go through shows Details as its own quiet line instead,
       so the head of a card with buttons on it is never itself a button. */
    function headToggles() {
      return card.getAttribute('data-state') === 'working' || card.getAttribute('data-state') === 'done';
    }
    dom.on(head, 'click', function () {
      if (!headToggles()) return;
      flipDetails();
    });
    dom.on(head, 'keydown', function (event) {
      if (!headToggles()) return;
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      flipDetails();
    });
    dom.on(toggle, 'click', flipDetails);

    /* Details open as the card grows to hold them, fading in (ui/design/motion.js). They close
       at once: the fold collapses on its own grid transition while it fades on the exit curve,
       and the last few pixels (the body's padding, once nothing is left in it) ease at the end.
       Fading out first and shrinking after left the click a quarter of a second with nothing
       moving (hunt A, 2026-09-23). */
    function flipDetails() {
      var motion = window.PhosphorMotion;
      var opening = !details.isOpen();
      var change = function () {
        details.toggle();
        paint(last.row, last.meta);
      };
      if (!motion || typeof motion.morph !== 'function') change();
      else if (opening) motion.morph(card, change, { fade: details.wrap });
      else closeDetails(change);
    }

    function closeDetails(change) {
      if (reducedMotion() || typeof details.wrap.animate !== 'function') {
        change();
        return;
      }
      memo.closing = true;
      var fade = details.wrap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_FADE_MS, easing: EXIT_EASE, fill: 'forwards' });
      change();
      window.setTimeout(function () {
        memo.closing = false;
        var from = typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect().height : 0;
        paint(last.row, last.meta);
        fade.cancel();
        easeHeight(card, from, memo);
      }, CLOSE_FADE_MS + 10);
    }

    /* The line under the head: why it did not go through, what a held move waits on, what a
       late one is doing. One sentence, never the venue's raw words. */
    function lineFor(plain, view, row, stale) {
      var decision = window.PhosphorDecision;
      if (plain.state === 'didnt_go_through' || plain.state === 'coming_back') return plain.sentence;
      if (plain.state === 'done') return plain.note;
      if (stale) return 'This is no longer waiting on you.';
      if (plain.state !== 'working') return '';
      if (plain.held) return decision && typeof decision.heldLine === 'function' ? decision.heldLine(row) : 'Waiting for the checks to clear. Nothing is signed until they do.';
      if (plain.late) {
        /* A late move the app cannot vouch for yet ("we can't confirm yet whether this went
           through") says so in the view's words; a plain slow one says it is only slow. */
        if (view && isObject(view.reason) && view.reason.code !== 'needs_approval' && view.reason.sentence) return String(view.reason.sentence);
        return view && view.stage === 'stalled' && view.stageCopy ? String(view.stageCopy) : 'This is taking longer than usual. Nothing needs you, and this card changes the moment it lands.';
      }
      return '';
    }

    /* The second's work on a working card: the late word and its line, nothing else. */
    function liveTick() {
      if (!card.isConnected || card.getAttribute('data-state') !== 'working') return false;
      var row = isObject(last.row) ? last.row : {};
      var move = moveOf(last.meta.name, last.meta.input, row);
      var view = viewOf(row);
      var plain = plainOf(row, view, move);
      if (plain.state !== 'working') return false;
      var wasLate = card.getAttribute('data-late') === 'true';
      fadeText(stateWord, stateWords(plain, move), memo, 'word');
      if (plain.late !== wasLate) paint(last.row, last.meta);
      return true;
    }

    function paint(next, more) {
      var m = more || meta;
      last = { row: next, meta: m };
      var row = isObject(next) ? next : {};
      /* The caller's open state wins only when the caller changed it: a head click toggles the
         fold between two frames, and the frame after it still carries the old value. */
      if (typeof m.detailsOpen === 'boolean' && m.detailsOpen !== memo.metaOpen) {
        memo.metaOpen = m.detailsOpen;
        if (details.isOpen() !== m.detailsOpen) details.setOpen(m.detailsOpen);
      }
      var move = moveOf(m.name, m.input, row);
      var view = viewOf(row);
      var legs = view ? viewLegs(view, move) : move;
      var plain = plainOf(row, view, move);
      var decision = window.PhosphorDecision;
      if (move.id) card.id = 'card-proposal-' + move.id;
      var state = plain.state;
      /* THE BUTTONS ARE THE SERVER'S. A card offers Cancel and Approve only on the state
         frame's own row, and only while that frame lists it as waiting: a reply that came
         through the conversation can draw the move and never the question, and a stored reply
         from last week says pending forever. Until the frame lands (a few milliseconds) the card
         shows the move without buttons. */
      var asking = state === 'needs_you' && m.waiting === true && m.live === true;
      var stale = state === 'needs_you' && m.waiting === false;
      var fresh = card.getAttribute('data-state') === 'working' && state === 'done' && memo.painted === true;
      /* The height before a change of state, read only then: a repaint that changes nothing
         never forces a layout. */
      var turning = memo.painted === true && card.isConnected && (card.getAttribute('data-state') !== state || (card.getAttribute('data-late') === 'true') !== plain.late);
      var fromHeight = turning && typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect().height : 0;
      /* Where the working fill stood the moment the move landed, so it finishes from there. */
      if (fresh && typeof window.getComputedStyle === 'function') {
        var at = /^matrix\(([-0-9.e]+)/.exec(window.getComputedStyle(track.firstChild).transform || '');
        if (at) track.style.setProperty('--track-from', at[1]);
      }
      dom.setAttr(card, 'data-state', state);
      dom.setAttr(card, 'data-kind', move.kind);
      dom.setAttr(card, 'data-late', plain.late ? 'true' : null);
      dom.setAttr(card, 'data-note', plain.note ? 'true' : null);
      dom.setAttr(card, 'data-lit', fresh ? 'true' : (state === 'done' ? card.getAttribute('data-lit') : null));
      memo.painted = true;

      paintMarks(marks, move, legs, memo);
      /* A rule change and a change to a trade are said in the app's own sentence; an open
         trade by its plan ("Long BTC") and its stake. */
      var draftOp = isObject(row.draft) ? row.draft.op : undefined;
      var sentenceKind = move.kind === 'policy_change' || move.kind === 'trade_change' || (move.kind === 'trade' && draftOp !== undefined && draftOp !== 'open');
      var headline = decision && typeof decision.headlineOf === 'function' && sentenceKind
        ? decision.headlineOf(Object.assign({}, row, { draft: row.draft || { kind: move.kind } }))
        : '';
      paintMove(moveLine, move, legs, plain, memo, headline);

      var word = stale ? 'No longer waiting' : stateWords(plain, move);
      fadeText(stateWord, word, memo, 'word');
      /* Done is a check on a green disc, and it pops the moment the move lands on screen
         (chatcard.css, keyed on data-lit); waiting is the clock of the icon set. */
      var iconName = state === 'done' ? 'done' : (asking && !plain.locked ? 'waiting' : '');
      if (memo.icon !== iconName) {
        memo.icon = iconName;
        dom.clear(stateIcon);
        if (iconName === 'done') stateIcon.appendChild(glyph('tick', 'mcard-state-tick'));
        else if (iconName) stateIcon.appendChild(icon(iconName, 'mcard-state-glyph'));
        dom.setAttr(stateIcon, 'data-icon', iconName || null);
      }
      dom.setHidden(stateIcon, !iconName);

      var lineText = lineFor(plain, view, row, stale);
      fadeText(line, lineText, memo, 'line');
      dom.setHidden(line, !lineText);

      /* The figures a decision is made on, only while it is being made. */
      paintFacts(facts, state === 'needs_you' ? factsFor(move, legs) : [], memo);

      /* A send names its receiver on the face, whole, while the person decides. */
      var receiver = state === 'needs_you' && legs.to && legs.to.address ? String(legs.to.address) : '';
      if (memo.receiver !== receiver) {
        memo.receiver = receiver;
        dom.clear(address);
        if (receiver) address.appendChild(addressBlock(receiver, legs.to.explorer, move.recipient, payoutPlace(move, legs)));
      }
      dom.setHidden(address, !receiver);

      /* The deciding parts (decision.js): a rule change's arithmetic, a trade's risk, the lock
         and Touch ID lines, and the two buttons. Rebuilt only when what they say changes, so a
         heartbeat never rebuilds a button under a finger. */
      var askKey = asking && decision && typeof decision.askKey === 'function' ? decision.askKey(row) : '';
      /* "Try again" only where the view offers it, and never beside an ask. */
      var retryKey = !asking && state === 'didnt_go_through' && plain.retry && decision && typeof decision.retryButton === 'function' ? 'retry:' + move.id : '';
      if (memo.askKey !== askKey || memo.retryKey !== retryKey) {
        memo.askKey = askKey;
        memo.retryKey = retryKey;
        dom.clear(decide);
        dom.clear(actions);
        dom.clear(note);
        ask = null;
        if (askKey) {
          ask = decision.ask(row);
          if (ask.face) decide.appendChild(ask.face);
          actions.appendChild(ask.buttons);
          note.appendChild(ask.note);
        } else if (retryKey) {
          var again = decision.retryButton(row);
          if (again) actions.appendChild(again);
        }
      }
      dom.setHidden(decide, !decide.firstChild);

      paintDetails(details.body, move, view, row, ask, state);
      var hasDetails = !!details.body.firstChild;
      var folds = headToggles();
      /* A card that folds to its head opens its Details from the head; one that asks, or did
         not go through, has the quiet Details toggle in its bar. The fold's own head is never
         drawn on a move card. */
      dom.setHidden(details.head, true);
      dom.setHidden(details.wrap, !hasDetails || (folds && !details.isOpen() && !memo.closing));
      var toggled = !folds && hasDetails;
      dom.setHidden(toggle, !toggled);
      dom.setAttr(toggle, 'aria-expanded', details.isOpen() ? 'true' : 'false');
      dom.setAttr(bar, 'data-open', details.isOpen() ? 'true' : null);
      dom.setHidden(bar, !toggled && !actions.firstChild);
      dom.setHidden(note, !note.firstChild);
      var bodyShown = !!lineText || !facts.hidden || !!receiver || !!decide.firstChild || !bar.hidden || !details.wrap.hidden;
      dom.setHidden(body, !bodyShown);

      var toggles = folds && hasDetails;
      dom.setAttr(head, 'role', toggles ? 'button' : null);
      dom.setAttr(head, 'tabindex', toggles ? '0' : null);
      dom.setAttr(head, 'aria-expanded', toggles ? (details.isOpen() ? 'true' : 'false') : null);

      /* The track: a pace off the usual time, resumed from where the move is, so a repaint
         never restarts it. Off the moment the move stops working. */
      var usual = plain.typical || USUAL_SEC;
      var into = plain.elapsed === null ? 0 : Math.min(plain.elapsed, usual);
      track.style.setProperty('--track-dur', usual + 's');
      track.style.setProperty('--track-at', '-' + into.toFixed(1) + 's');
      if (state === 'working') watchLive(liveTick);
      if (turning) easeHeight(card, fromHeight, memo);
    }

    card.__paint = paint;
    card.__details = details;
    paint(data, meta);
    return card;
  }

  /* The Details lines, rebuilt each paint: a handful of lines, and the fold's open state lives
     on the fold rather than in them. */
  function paintDetails(fold, move, view, row, ask, state) {
    dom.clear(fold);
    var ended = state === 'done' || state === 'didnt_go_through' || state === 'coming_back';
    if (ask && ask.details) {
      for (var a = 0; a < ask.details.length; a += 1) fold.appendChild(ask.details[a]);
    }
    if (view) {
      if (view.decidedAt && view.decidedBy === 'human') factLine(fold, 'You approved it at', clock(view.decidedAt));
      else if (view.decidedAt && view.decidedBy === 'policy' && view.stage !== 'refused') factLine(fold, 'Your rules allowed it at', clock(view.decidedAt));
      if (view.settledAt) {
        var done = view.stage === 'confirmed';
        factLine(fold, done ? 'Landed at' : 'Ended at', clock(view.settledAt));
      }
      var txs = Array.isArray(view.txs) ? view.txs : [];
      for (var i = 0; i < txs.length; i += 1) {
        var leg = txs[i];
        if (!leg || !leg.hash) continue;
        referenceLine(fold, leg.running ? 'Where it is now' : (LEG_WORD[leg.leg] || 'Hash'), leg.hash, leg.explorer);
      }
      if (view.correlationId) referenceLine(fold, 'Reference', view.correlationId, null);
      /* The service's own word for where the move is is evidence for an engineer, in developer
         mode only. A person reads the plain line when the service refused the move. */
      if (view.providerStage && view.stage !== 'confirmed') {
        var said = vendorWord(view.providerStage);
        var stageLine = dom.el('div', 'tcard-line');
        stageLine.setAttribute('data-dev-only', '');
        stageLine.appendChild(dom.el('span', 'tcard-line-label', move.kind === 'swap' ? 'The swap service said' : 'The service said'));
        stageLine.appendChild(fig('tcard-line-value', said.charAt(0).toUpperCase() + said.slice(1)));
        fold.appendChild(stageLine);
        if (ended && /^(FAILED|REFUNDED)$/i.test(String(view.providerStage))) {
          fold.appendChild(dom.el('div', 'tcard-note', move.kind === 'swap' ? 'The swap service turned it down.' : 'The service turned it down.'));
        }
      }
    } else if (move.id) {
      referenceLine(fold, 'Reference', move.id, null);
    }
    var priceFor = view && view.stage === 'waiting_for_you' && isObject(row.simulation) && isObject(row.simulation.swap) ? num(row.simulation.swap.priceGoodForSec) : null;
    if (priceFor !== null && priceFor > 0) fold.appendChild(dom.el('div', 'tcard-note', 'Price good for ' + roughWords(priceFor) + ', checked again when you approve.'));
    if (ended && move.detail && move.detail !== move.reason) {
      /* The rail's own line is evidence for an engineer: it shows in developer mode only, and
         only once the move has ended. */
      var recorded = dom.el('div', 'tcard-line tcard-recorded');
      recorded.setAttribute('data-wrap', 'true');
      recorded.setAttribute('data-dev-only', '');
      recorded.appendChild(dom.el('span', 'tcard-line-label', 'The full record'));
      recorded.appendChild(dom.el('span', 'tcard-line-value', shortenIds(String(move.detail).replace(/\s+/g, ' ').trim())));
      fold.appendChild(recorded);
    }
    if (move.kind === 'intents_send' || move.kind === 'intents_pay') {
      var r = move.recipient;
      var known = r && r.known === true;
      var count = known ? (num(r.count) || 0) : 0;
      factLine(fold, 'This address', known ? 'sent to ' + count + (count === 1 ? ' time before' : ' times before') : 'first send');
      if (move.activity) fold.appendChild(dom.el('div', 'tcard-note', move.activity));
    }
    /* The checks the app ran before signing, folded: every kind that runs a preflight carries
       them, and a held move is waiting on them. */
    var decision = window.PhosphorDecision;
    var checks = decision && typeof decision.preflightOf === 'function' ? decision.preflightOf(row) : move.preflight;
    if (checks && window.PhosphorChecks && typeof window.PhosphorChecks.fold === 'function') {
      window.PhosphorChecks.fold(fold, checks, { open: false });
    }
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
    intent: 'What was signed',
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
      row.appendChild(ident('tcard-line-value', text));
      body.appendChild(row);
      return row;
    }
    var link = dom.el('a', 'id tcard-line-value tcard-link');
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
        if (row.other && !isAddress(row.other)) left.appendChild(fig('tcard-line-other', ' ' + String(row.other)));
        line.appendChild(left);
        line.appendChild(fig('tcard-line-value', (row.amount ? row.amount + ' ' + row.symbol : '') + (row.time ? '  ' + clock(row.time) : '')));
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

  /* The agent is told only the address's ends; the card draws the whole address from the
     window's own read of the wallet, and says in words where it cannot. */
  function depositCard(data, extra) {
    var ok = data.ok !== false;
    var chain = String(data.chain || '');
    var symbol = String(data.asset || data.symbol || '');
    var place = String(data.network || chainName(chain));
    var parts = shell('deposit', icon('deposit'), ok ? 'Deposit ' + symbol + ' on ' + place : 'Deposit', {
      state: ok ? { tone: 'watching', label: '' } : { tone: 'failed', label: 'Not shown' },
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
    name.appendChild(dom.el('span', 'tcard-symbol', place));
    var print = String(data.addressFingerprint || '');
    var m = /([A-Za-z0-9]{4})$/.exec(print);
    var ends = null;
    if (m) {
      ends = dom.el('span', 'tcard-place');
      ends.appendChild(dom.el('span', '', 'address ends in '));
      ends.appendChild(ident('tcard-tail', m[1]));
      name.appendChild(ends);
    }
    row.appendChild(name);
    body.appendChild(row);

    /* What the network asks of a deposit, on the row's own text column, in words. */
    var facts = [];
    var min = num(data.minDeposit);
    if (min !== null && min > 0) facts.push('At least ' + dom.qty(min) + ' ' + symbol);
    if (data.memo) facts.push('a memo is required');
    if (facts.length) body.appendChild(dom.el('div', 'tcard-facts tcard-deposit-facts', facts.join(', ') + '.'));

    var slot = dom.el('div', 'tcard-deposit');
    body.appendChild(slot);

    depositAddress(chain, print).then(function (found) {
      if (found.address) {
        /* The agent's card shows what can be sent and waits for the same tick Add money does
           before the address (Karim, 2026-09-25), with the same list and the same words. */
        var pick = window.PhosphorNetPick;
        var reveal = function () {
          if (slot.__netpick && typeof slot.__netpick.destroy === 'function') slot.__netpick.destroy();
          dom.clear(slot);
          if (ends) dom.setHidden(ends, true);
          drawDeposit(slot, found, chain);
        };
        if (pick && typeof pick.render === 'function') {
          pick.render(slot, { context: 'chat', stage: 'tokens', network: chain, symbol: symbol || null, onAddress: reveal });
        } else {
          slot.appendChild(dom.el('p', 'tcard-note', 'The address shows in Add money.'));
        }
      } else {
        refuseDeposit(slot, found, chain, symbol);
      }
    });
    followWatch(parts, data, extra.at);
    return parts.card;
  }

  /* The short form src/http/read/wallet.ts gives the agent. */
  function printOf(address) {
    return address.length > 12 ? address.slice(0, 6) + '...' + address.slice(-4) : address;
  }

  function watchNow() {
    var store = window.PhosphorState;
    var now = store && typeof store.get === 'function' ? store.get() : null;
    return now && isObject(now.deposit) ? now.deposit : null;
  }

  /* The address is drawn only where Add money would draw it (ui/screens/netpick.js): the wallet
     file unedited, the wallet open, the network's address unchanged and the one the watch
     holds, and its ends the ones the agent was told. */
  function depositAddress(chain, print) {
    var moneyIn = window.PhosphorMoneyIn;
    var api = window.PhosphorApi;
    var read = moneyIn && typeof moneyIn.load === 'function'
      ? moneyIn.load()
      : (api && typeof api.intentsReceive === 'function' ? api.intentsReceive().then(function (r) { return r && r.data ? r.data : null; }) : null);
    var unread = { refused: 'The address could not be read here. Add money shows it.', open: true };
    return Promise.resolve(read).then(function (report) {
      if (!isObject(report)) return unread;
      if (report.tampered) return { refused: 'The wallet file on this Mac has been edited, so no address in it can be trusted.' };
      var networks = Array.isArray(report.networks) ? report.networks : [];
      var network = null;
      for (var i = 0; i < networks.length; i += 1) {
        if (isObject(networks[i]) && networks[i].id === chain) network = networks[i];
      }
      if (network && typeof network.changed === 'string' && network.changed) return { refused: network.changed };
      if (!network || network.unavailable || typeof network.address !== 'string' || !network.address) {
        return { refused: 'No deposit address on this network right now.' };
      }
      if (report.verified !== true) return { refused: 'The whole address shows once the wallet is open.', open: true };
      var watch = watchNow();
      var held = watch && watch.chain === chain && typeof watch.address === 'string' && watch.address ? watch.address : network.address;
      if (printOf(network.address) !== print || held !== network.address) {
        return { refused: 'This address is not the one your agent was given, so nothing is shown.' };
      }
      return { address: network.address, memo: typeof network.memo === 'string' && network.memo ? network.memo : null };
    }, function () { return unread; });
  }

  /* The address in a well, Copy and the QR code under it, and one line that says what the last
     press found. A memo network gets no QR code: a scanned address leaves the memo out. */
  function drawDeposit(slot, found, chain) {
    var pick = window.PhosphorNetPick;
    var said = dom.el('p', 'tcard-note tcard-deposit-said');
    said.setAttribute('role', 'status');
    dom.setHidden(said, true);
    function say(text) {
      dom.setText(said, text || '');
      dom.setHidden(said, !text);
    }

    var row = dom.el('div', 'mcard-address-row');
    var well = dom.el('div', 'mcard-address-line tcard-deposit-well');
    well.appendChild(pick && typeof pick.addressBlock === 'function'
      ? pick.addressBlock(found.address, typeof pick.kindOf === 'function' ? pick.kindOf(chain) : undefined)
      : dom.el('span', 'addr', found.address));
    row.appendChild(well);
    row.appendChild(checkedCopy(found.address, 'address', say));
    slot.appendChild(row);

    var qr = null;
    var actions = null;
    if (found.memo) {
      var memo = dom.el('div', 'mcard-address-row tcard-deposit-memo');
      var memoLine = dom.el('p', 'mcard-address-line id');
      memoLine.appendChild(dom.el('span', 'tcard-deposit-memo-label', 'Memo '));
      memoLine.appendChild(dom.el('span', 'addr-end', found.memo));
      memo.appendChild(memoLine);
      memo.appendChild(checkedCopy(found.memo, 'memo', say));
      slot.appendChild(memo);
      slot.appendChild(said);
      slot.appendChild(dom.el('p', 'tcard-note', 'Put the memo in the memo or tag field when you send. Without it the money reaches nobody and is not refunded.'));
    } else {
      slot.appendChild(said);
      actions = dom.el('div', 'tcard-actions tcard-deposit-actions');
      qr = dom.el('div', 'qr tcard-qr');
      var canvas = dom.el('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'QR code of the deposit address');
      qr.appendChild(canvas);
      dom.setHidden(qr, true);
      var show = dom.el('button', 'btn btn-quiet btn-sm tcard-show-qr');
      show.type = 'button';
      var label = dom.el('span', 'btn-label', 'Show QR code');
      show.appendChild(label);
      var drawn = false;
      dom.on(show, 'click', function () {
        if (!qr.hidden) {
          dom.setHidden(qr, true);
          dom.setText(label, 'Show QR code');
          return;
        }
        var lazy = window.PhosphorLazy;
        Promise.resolve(lazy && typeof lazy.load === 'function' ? lazy.load('qr') : true).then(function () {
          var check = drawn ? { ok: true } : (pick && typeof pick.drawChecked === 'function'
            ? pick.drawChecked(canvas, found.address, 128)
            : { ok: false, why: 'The QR code cannot be drawn here.' });
          if (!check.ok) {
            say(check.why + ' Copy the address instead.');
            return;
          }
          drawn = true;
          say('');
          dom.setHidden(qr, false);
          dom.setText(label, 'Hide QR code');
        });
      });
      actions.appendChild(show);
      slot.appendChild(actions);
      slot.appendChild(qr);
    }
  }

  /* Copy that reads the clipboard back and says what it found (ui/screens/netpick.js). */
  function checkedCopy(value, what, say) {
    var copy = dom.el('button', 'btn btn-quiet btn-sm tcard-copy');
    copy.type = 'button';
    var label = dom.el('span', 'btn-label', what === 'memo' ? 'Copy memo' : 'Copy');
    copy.appendChild(label);
    dom.on(copy, 'click', function () {
      var pick = window.PhosphorNetPick;
      if (pick && typeof pick.copyChecked === 'function') pick.copyChecked(value, say, what);
      else copyToClipboard(value, label);
    });
    return copy;
  }

  /* Where the card cannot draw the address, the sentence takes its place; where Add money can
     still get there (the wallet to open, a read to try again), the way there is one press. */
  function refuseDeposit(slot, found, chain, symbol) {
    slot.appendChild(dom.el('p', 'tcard-note', found.refused));
    var deposit = window.PhosphorDeposit;
    if (!found.open || !deposit || typeof deposit.open !== 'function') return;
    var actions = dom.el('div', 'tcard-actions tcard-deposit-actions');
    var open = dom.el('button', 'btn btn-ghost btn-sm tcard-open');
    open.type = 'button';
    open.appendChild(dom.el('span', 'btn-label', 'Open in Add money'));
    dom.on(open, 'click', function () { deposit.open({ chain: chain, symbol: symbol }); });
    actions.appendChild(open);
    slot.appendChild(actions);
  }

  /* The word follows the running watch while it is this card's own: the same network and coin,
     begun around when the card was. A card drawn again from a stored conversation is older than
     any watch running now, and says nothing. Until the first frame of its watch arrives, a new
     card says what the tool answered. */
  function followWatch(parts, data, at) {
    var word = parts.state;
    if (!word) return;
    var when = typeof at === 'number' ? at : Date.now();
    var chain = String(data.chain || '');
    var symbol = String(data.asset || data.symbol || '').toUpperCase();
    var followed = false;
    function paint(watch) {
      var started = isObject(watch) ? Date.parse(watch.startedAt) : NaN;
      var mine = isObject(watch) && watch.chain === chain && String(watch.symbol || '').toUpperCase() === symbol
        && started >= when - 120000 && started <= when + 10000;
      var phase = null;
      if (mine) {
        followed = true;
        phase = watch.phase;
      } else if (!followed && Date.now() - when < 120000) {
        phase = data.watching;
      }
      var label = DEPOSIT_WORDS[phase] || '';
      dom.setText(word, label);
      word.setAttribute('data-state', phase === 'credited' ? 'landed' : 'watching');
      dom.setHidden(word, !label);
    }
    paint(null);
    var store = window.PhosphorState;
    if (!store || typeof store.select !== 'function') return;
    var off = null;
    off = store.select('deposit', function (watch) {
      if (off && parts.card.isConnected === false) {
        off();
        return;
      }
      paint(watch);
    });
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
      grid.appendChild(dom.el('span', 'tcard-kv-value' + (shown[i].numeric ? ' num' : ''), shown[i].value));
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

  /* A row's plain state, for the conversation around the card: which cards wait on the
     person, and whether anything is still working. */
  function plainState(data) {
    var row = isObject(data) ? data : {};
    return plainOf(row, viewOf(row), moveOf('', null, row)).state;
  }

  window.PhosphorCards = {
    render: render,
    kindFor: kindFor,
    plainState: plainState,
    foldOf: foldOf,
    floorText: floorText,
    glyph: glyph,
    foldNames: foldNames
  };
})();
