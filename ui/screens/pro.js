/* Pro: the statement.

   Pro is the NEAR money in detail (Karim's pick, 2026-09-23, the "statement"
   mockup): the coins' total with a small ring of how it splits and the two
   things a person does with it, Swap and Add money; the trading account in one
   line that leads to Trade, where everything about Hyperliquid lives; the
   coins as a ledger, each with its price, the line that price drew over the
   last 24 hours, the change, the amount and the value; and under it the
   Policies (three soft dials) beside the recent moves.

   Everything comes off what the backend already keeps: the wallet's NEAR
   Intents rows and the Hyperliquid row (state.wallet), the policy and the two
   rolling 24 hour totals (state.policy, state.dailyLimit, state.autoLimit),
   the moves still under way (state.proposals), the ones that ended
   (/api/receipts) and each coin's day. The day comes off the backend's day
   feed (/api/day), which covers every coin the NEAR Intents token list names
   a CoinGecko id for, read live (2026-09-25: a held VVV had no line while the
   day came off candles alone); 25 hourly candles (/api/candles) stand in only
   for a coin the feed has no day for whose market the app lists. A coin with
   neither shows no line and no change, never a made-up one, and a figure the
   app does not have is left out rather than written as zero. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;
  var net = window.PhosphorNet;

  /* The ring: Basic's allocation ring at the statement's size. The geometry is
     Basic's scaled to a 120 unit box. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var R = 52;
  var C = 2 * Math.PI * R;
  var GAP = 9;
  var MIN_DASH = 3;
  var SLIVER = 0.02;
  var STAGGER_MS = 70;

  /* The tints are Basic's (ui/screens/basic.js): a coin whose brand colour is
     green, or that has none, wears the neutral, because green is the app's
     own light; the three blue to violet brands are lifted apart by eye. */
  var NEUTRAL = '#e6ddd2';
  var TINTS = { USDC: '#3b8cff', 'USDC.E': '#3b8cff', USDCX: '#3b8cff', ETH: '#b0b4ff', WETH: '#b0b4ff', SOL: '#a86dff' };

  /* The coins that hold a dollar. Their line is drawn when the candles come,
     like any other coin's; the day across the coins counts them as holding
     still when they do not. */
  var STABLES = { USDC: true, 'USDC.E': true, USDCX: true, USDT: true, DAI: true, USDE: true, PYUSD: true, FDUSD: true, USDS: true };

  /* A wrapped coin is priced as the coin it wraps. */
  var UNDER = { WBTC: 'BTC', CBBTC: 'BTC', WETH: 'ETH', WNEAR: 'NEAR', WSOL: 'SOL' };

  /* How many legend entries the ring carries before it folds the rest into
     one, and how many moves the panel lists. */
  var LEGEND_SHOWN = 4;
  var MOVES_SHOWN = 4;

  /* The shortest arc a dial shows for a share above nothing: 8 of its 100,
     from the top, a sweep that reads as begun. $100 of a $10,000 cap is 1, and
     at 1 the round caps met in a dot centred on the top that read as a knob;
     at 6 with a round cap at both ends the arc was still mostly its two caps,
     a capsule that read as a knob too (the finish reviews, 2026-09-24). So an
     arc leaves the top square and only its head is round. The head is half
     the 9 wide stroke on the 42 radius, 1.7 of the 100. */
  var MIN_SWEEP = 8;
  var ARC_CAP = 1.7;

  /* A coin's day is read when Pro comes up, and again on the first frame that
     finds it five minutes old while Pro stays up: a line a person reads at a
     glance, not a ticker, and never on a timer of its own. */
  var LINES_MS = 5 * 60 * 1000;
  /* An answer from a day feed that has not landed yet (its `at` is null: the
     backend's first read is still out, or demo mode, which keeps no feed) is
     no day read: it is asked again on the first frame this long after, never
     from its own render. */
  var FEED_SOON_MS = 15 * 1000;
  var MOVES_MS = 30 * 1000;

  /* The words a move under way wears, by kind: the card's own
     (ui/screens/cards.js), so the list and the thread never say it two ways. */
  var WORKING_WORDS = { swap: 'Swapping', intents_send: 'Sending', intents_pay: 'Paying out', hl_deposit: 'Funding trading', hl_withdraw: 'Bringing it back' };

  var refs = {};
  var mounted = false;
  var ringDrawn = false;
  var lines = {};
  /* The day feed's days by asset id, when the last read landed, whether one
     is out, the asset ids it named, and when the last read came back at all. */
  var feed = { entries: Object.create(null), at: 0, pending: false, asked: Object.create(null), tried: 0 };
  var receipts = [];
  var movesAt = 0;
  var flowSteps = null;

  function boot() {
    var host = document.getElementById('view-pro');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
    window.addEventListener('phosphor:view', function (event) {
      var view = event && event.detail ? event.detail.view : null;
      if (view === 'pro') onScreen();
    });
    if (window.PhosphorShell && typeof window.PhosphorShell.view === 'function' && window.PhosphorShell.view() === 'pro') onScreen();
    render();
  }

  /* Pro is up: the ended moves are read if they are old, and the render reads
     any coin's day that is missing or five minutes old (ensureDay, then
     ensureLines for a coin the feed has none for). The state frames that keep
     coming while it is up (a heartbeat every 15 s at the least) are what bring
     an old line back to be read. */
  function onScreen() {
    if (Date.now() - movesAt > MOVES_MS) loadMoves();
    render();
  }

  function isUp() {
    var shell = window.PhosphorShell;
    return !!(shell && typeof shell.view === 'function' && shell.view() === 'pro');
  }

  /* ---------- the build ---------- */

  function build(host) {
    var root = dom.el('section', 'stmt');
    root.setAttribute('aria-label', 'Your money');

    /* The hero: the total with its day, the ring and its legend, the actions. */
    var hero = dom.el('header', 'stmt-hero');
    var lead = dom.el('div', 'stmt-lead');
    var total = dom.el('p', 'stmt-total num tick');
    total.hidden = true;
    var skel = dom.el('span', 'skel stmt-total-skel');
    skel.setAttribute('aria-hidden', 'true');
    var sub = dom.el('p', 'stmt-sub');
    var caption = dom.el('span', 'stmt-caption');
    var today = dom.el('span', 'stmt-today num');
    today.hidden = true;
    sub.appendChild(caption);
    sub.appendChild(today);
    lead.appendChild(total);
    lead.appendChild(skel);
    lead.appendChild(sub);
    hero.appendChild(lead);

    var mix = dom.el('div', 'stmt-mix');
    var ring = ringSvg();
    var ringBox = dom.el('div', 'stmt-ring-box');
    if (ring) ringBox.appendChild(ring.svg);
    /* The largest share on the disc, for when the legend steps off (pro.css). */
    var ringLabel = dom.el('p', 'stmt-ring-label');
    var ringShare = dom.el('span', 'stmt-ring-share num');
    var ringCoin = dom.el('span', 'stmt-ring-coin');
    ringLabel.appendChild(ringShare);
    ringLabel.appendChild(ringCoin);
    ringLabel.hidden = true;
    ringBox.appendChild(ringLabel);
    mix.appendChild(ringBox);
    var legend = dom.el('ul', 'stmt-legend');
    legend.setAttribute('aria-label', 'How your coins split');
    mix.appendChild(legend);
    hero.appendChild(mix);

    var actions = dom.el('div', 'stmt-actions');
    var swap = button('Swap', 'swap');
    var add = button('Add money', 'deposit');
    actions.appendChild(swap);
    actions.appendChild(add);
    hero.appendChild(actions);
    var note = dom.el('p', 'stmt-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    hero.appendChild(note);
    root.appendChild(hero);

    /* The trading account, one line, the way to Trade. */
    var trade = dom.el('button', 'stmt-trade');
    trade.type = 'button';
    var marks = window.PhosphorMarks;
    if (marks && typeof marks.logo === 'function') trade.appendChild(marks.logo('HYPE', 28));
    var tradeMain = dom.el('span', 'stmt-trade-main');
    tradeMain.appendChild(dom.el('b', '', 'Trading account'));
    var tradeFigure = dom.el('span', 'stmt-trade-figure num');
    tradeMain.appendChild(tradeFigure);
    trade.appendChild(tradeMain);
    var go = dom.el('span', 'stmt-trade-go');
    go.appendChild(dom.el('span', '', 'Open Trade'));
    var chevron = glyph('chevron-right');
    if (chevron) go.appendChild(chevron);
    trade.appendChild(go);
    trade.hidden = true;
    root.appendChild(trade);

    /* The ledger. Where the price's figure steps out and its column is the
       line alone, the head says so in fewer words (pro.css). */
    var ledger = dom.el('section', 'stmt-panel stmt-ledger');
    ledger.setAttribute('aria-label', 'Your coins');
    var head = dom.el('div', 'l-row l-head');
    head.setAttribute('aria-hidden', 'true');
    head.appendChild(dom.el('span', '', 'Coin'));
    var priceHead = dom.el('span', 'l-head-price');
    priceHead.appendChild(dom.el('span', 'l-head-long', 'Price, last 24 hours'));
    priceHead.appendChild(dom.el('span', 'l-head-short', 'Last 24 hours'));
    head.appendChild(priceHead);
    ['24h', 'Amount', 'Value'].forEach(function (word) {
      head.appendChild(dom.el('span', '', word));
    });
    ledger.appendChild(head);
    var rows = dom.el('ul', 'l-rows');
    for (var i = 0; i < 3; i += 1) rows.appendChild(skeletonRow());
    ledger.appendChild(rows);
    var empty = dom.el('p', 'stmt-empty');
    empty.hidden = true;
    ledger.appendChild(empty);
    root.appendChild(ledger);

    /* The policies beside the recent moves. */
    var duo = dom.el('div', 'stmt-duo');
    duo.appendChild(buildPolicies());
    var moves = dom.el('section', 'stmt-panel stmt-moves');
    moves.setAttribute('aria-label', 'Recent moves');
    var movesHead = dom.el('header', 'stmt-panel-head');
    movesHead.appendChild(dom.el('h3', '', 'Recent moves'));
    moves.appendChild(movesHead);
    var movesList = dom.el('ul', 'moves');
    moves.appendChild(movesList);
    var movesEmpty = dom.el('p', 'stmt-empty', 'Nothing has moved yet.');
    movesEmpty.hidden = true;
    moves.appendChild(movesEmpty);
    duo.appendChild(moves);
    root.appendChild(duo);

    /* Add money runs its steps here, in place of the ledger and the panels
       under it, the way it runs in Basic's slab. */
    var flow = dom.el('section', 'stmt-panel stmt-flow');
    flow.hidden = true;
    var flowHead = dom.el('header', 'stmt-panel-head');
    var flowTitle = dom.el('h3', '', 'Add money');
    flowTitle.setAttribute('tabindex', '-1');
    var flowClose = dom.el('button', 'btn btn-quiet btn-sm');
    flowClose.type = 'button';
    flowClose.appendChild(dom.el('span', 'btn-label', 'Close'));
    flowHead.appendChild(flowTitle);
    flowHead.appendChild(flowClose);
    var flowBody = dom.el('div', 'stmt-flow-body');
    flow.appendChild(flowHead);
    flow.appendChild(flowBody);
    root.appendChild(flow);

    host.appendChild(root);

    refs.host = host;
    refs.root = root;
    refs.total = total;
    refs.skel = skel;
    refs.caption = caption;
    refs.today = today;
    refs.ring = ring;
    refs.ringLabel = ringLabel;
    refs.ringShare = ringShare;
    refs.ringCoin = ringCoin;
    refs.legend = legend;
    refs.swap = swap;
    refs.add = add;
    refs.note = note;
    refs.trade = trade;
    refs.tradeFigure = tradeFigure;
    refs.ledger = ledger;
    refs.rows = rows;
    refs.empty = empty;
    refs.duo = duo;
    refs.moves = movesList;
    refs.movesEmpty = movesEmpty;
    refs.flow = flow;
    refs.flowTitle = flowTitle;
    refs.flowBody = flowBody;
    refs.flowClose = flowClose;

    dom.on(swap, 'click', askToSwap);
    dom.on(add, 'click', openFlow);
    dom.on(flowClose, 'click', closeFlow);
    dom.on(trade, 'click', function () {
      var shell = window.PhosphorShell;
      if (shell && typeof shell.setView === 'function') shell.setView('trade', { fromClick: true });
    });
    dom.on(movesList, 'click', onMovePress);
  }

  function button(label, icon) {
    var node = dom.el('button', 'btn stmt-act');
    node.type = 'button';
    var g = glyph(icon);
    if (g) node.appendChild(g);
    node.appendChild(dom.el('span', 'btn-label', label));
    return node;
  }

  /* A glyph from the icon family, or the bar's own freeze symbol. Nothing where
     there is no svg to build in (the unit harness). */
  function glyph(name, className) {
    if (name === 'freeze') {
      if (typeof document.createElementNS !== 'function') return null;
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'icon' + (className ? ' ' + className : ''));
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      var use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', '#i-freeze');
      svg.appendChild(use);
      return svg;
    }
    var icons = window.PhosphorIcons;
    return icons && typeof icons.svg === 'function' ? icons.svg(name, className) : null;
  }

  function skeletonRow() {
    var li = dom.el('li', 'l-row l-skel');
    li.setAttribute('aria-hidden', 'true');
    li.appendChild(dom.el('span', 'skel l-skel-coin'));
    li.appendChild(dom.el('span', 'skel l-skel-line'));
    return li;
  }

  /* ---------- the render ---------- */

  function render() {
    if (!mounted || !store.loaded()) return;
    var state = store.get() || {};
    var coins = coinsOf(state.wallet);
    if (coins && isUp()) {
      ensureDay(coins);
      ensureLines(coins);
    }
    renderHero(state, coins);
    renderTrade(state.wallet);
    renderLedger(state, coins);
    renderPolicies(state);
    renderMoves(state);
  }

  /* The NEAR money, one entry per coin: the intents rows of every chain
     summed by symbol, largest first, a coin with no price last, with the
     asset ids behind it, largest row first, for its day. Null while the
     intents balance has not been read, which is a different fact from
     holding nothing. */
  function coinsOf(wallet) {
    if (!wallet || !Array.isArray(wallet.rows)) return null;
    if (Array.isArray(wallet.stale) && wallet.stale.indexOf('intents') >= 0) return null;
    var by = {};
    var order = [];
    wallet.rows.forEach(function (row) {
      if (!row || row.kind !== 'intents') return;
      var key = String(row.symbol || '').toUpperCase();
      if (!key) return;
      var at = by[key];
      if (!at) {
        at = by[key] = { symbol: String(row.symbol), key: key, assets: [], quantity: 0, valueUsd: 0, priceUsd: null, priced: false };
        order.push(key);
      }
      var asset = assetOf(row);
      if (asset && at.assets.indexOf(asset) < 0) at.assets.push(asset);
      var qty = Number(row.quantity);
      if (isFinite(qty)) at.quantity += qty;
      if (row.priced !== false && isFinite(Number(row.valueUsd))) {
        at.valueUsd += Number(row.valueUsd);
        at.priced = true;
        if (isFinite(Number(row.priceUsd)) && Number(row.priceUsd) > 0) at.priceUsd = Number(row.priceUsd);
      }
    });
    var list = order.map(function (key) { return by[key]; });
    list.sort(function (a, b) {
      if (a.priced !== b.priced) return a.priced ? -1 : 1;
      return b.valueUsd - a.valueUsd;
    });
    return list;
  }

  /* The verifier's id for an intents row, which the day feed is keyed by. */
  function assetOf(row) {
    var id = row.intents && row.intents.assetId ? row.intents.assetId : row.tokenId;
    return id ? String(id) : '';
  }

  function totalOf(coins) {
    var sum = 0;
    coins.forEach(function (c) { if (c.priced) sum += c.valueUsd; });
    return sum;
  }

  function renderHero(state, coins) {
    if (refs.skel.parentNode && coins !== null) refs.skel.parentNode.removeChild(refs.skel);
    if (coins === null) {
      dom.setHidden(refs.total, true);
      dom.setText(refs.caption, state.wallet ? 'Still reading your coins.' : '');
      dom.setHidden(refs.today, true);
      paintRing([]);
      renderLegend([]);
      return;
    }
    var unpriced = coins.filter(function (c) { return !c.priced; }).map(function (c) { return c.symbol; });
    var priced = coins.some(function (c) { return c.priced; });
    dom.setNumber(refs.total, priced || !coins.length ? dom.usd(totalOf(coins)) : '');
    dom.setHidden(refs.total, !(priced || !coins.length));
    dom.setText(refs.caption, unpriced.length ? 'in your coins, not counting ' + unpriced.join(', ') : 'in your coins');
    // No "+$X today" beside the total: price moves times today's amounts reads as profit while it
    // ignores deposits and swaps. Each coin's own 24h change in the ledger is the true signal.
    dom.setHidden(refs.today, true);
    paintRing(coins);
    renderLegend(coins);
  }

  /* The legend: each coin's share of the priced total beside its tint, the
     largest first, the rest folded into one entry past four. */
  function renderLegend(coins) {
    var priced = coins.filter(function (c) { return c.priced && c.valueUsd > 0; });
    var sum = totalOf(priced);
    var items = [];
    if (sum > 0) {
      var shown = priced.length > LEGEND_SHOWN ? priced.slice(0, LEGEND_SHOWN - 1) : priced;
      shown.forEach(function (c) { items.push({ key: c.key, word: c.symbol, share: c.valueUsd / sum, tint: tintOf(c.symbol) }); });
      if (priced.length > shown.length) {
        var rest = 0;
        priced.slice(shown.length).forEach(function (c) { rest += c.valueUsd; });
        items.push({ key: ':rest', word: 'Other', share: rest / sum, tint: NEUTRAL });
      }
    }
    dom.reconcile(refs.legend, items, function (item) {
      return item.key;
    }, function () {
      var li = dom.el('li', 'stmt-legend-item');
      li.appendChild(dom.el('i', 'stmt-swatch'));
      li.appendChild(dom.el('span', ''));
      return li;
    }, function (li, item) {
      if (li.style && typeof li.style.setProperty === 'function') li.style.setProperty('--tint', item.tint);
      dom.setText(li.children[1], item.word + ' ' + shareText(item.share));
    });
    dom.setHidden(refs.legend, !items.length);
    /* On the disc, the largest coin's share: the legend's first entry, never the fold. */
    var top = items.length && items[0].key !== ':rest' ? items[0] : null;
    dom.setText(refs.ringShare, top ? shareText(top.share) : '');
    dom.setText(refs.ringCoin, top ? top.word : '');
    dom.setHidden(refs.ringLabel, !top);
  }

  function shareText(share) {
    var pct = share * 100;
    return (pct > 0 && pct < 1 ? '<1' : String(Math.round(pct))) + '%';
  }

  /* ---------- the trading account ---------- */

  function renderTrade(wallet) {
    var row = null;
    var rows = wallet && Array.isArray(wallet.rows) ? wallet.rows : [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].kind === 'hyperliquid') row = rows[i];
    }
    var stale = wallet && Array.isArray(wallet.stale) && wallet.stale.indexOf('hyperliquid') >= 0;
    var funded = wallet && wallet.hyperliquid ? wallet.hyperliquid.funded : null;
    var text = '';
    if (stale) text = 'not answering right now';
    else if (row && isFinite(Number(row.valueUsd))) {
      var open = row.hyperliquid && typeof row.hyperliquid.openPositions === 'number' ? row.hyperliquid.openPositions : null;
      text = dom.usd(Number(row.valueUsd)) + (open === null ? '' : ' · ' + (open === 0 ? 'no positions' : open === 1 ? '1 position' : open + ' positions'));
    } else if (funded === false) text = 'no money in it yet';
    dom.setText(refs.tradeFigure, text);
    dom.setHidden(refs.tradeFigure, !text);
    /* No trading account read at all (none set up, or none read yet): no line,
       rather than a name with nothing after it. */
    dom.setHidden(refs.trade, !text);
    dom.setAttr(refs.trade, 'aria-label', text ? 'Trading account, ' + text + '. Open Trade' : null);
  }

  /* ---------- the ledger ---------- */

  function renderLedger(state, coins) {
    if (coins === null) return;
    var items = coins;
    dom.reconcile(refs.rows, items, function (c) {
      return c.key;
    }, makeRow, fillRow);
    var small = state.basic && state.basic.smallLine ? String(state.basic.smallLine) : '';
    var word = !items.length ? 'No coins in your balance yet. Add money and they show here.' : small;
    dom.setText(refs.empty, word);
    dom.setHidden(refs.empty, !word);
    dom.setAttr(refs.ledger, 'data-empty', items.length ? null : 'true');
  }

  function makeRow(c) {
    var li = dom.el('li', 'l-row');
    var coin = dom.el('div', 'l-coin');
    var marks = window.PhosphorMarks;
    if (marks && typeof marks.logo === 'function') coin.appendChild(marks.logo(c.symbol, 32));
    var who = dom.el('div', 'l-who');
    who.appendChild(dom.el('p', 'l-sym'));
    who.appendChild(dom.el('p', 'l-amt-under num'));
    coin.appendChild(who);
    li.appendChild(coin);
    var price = dom.el('div', 'l-price');
    price.appendChild(dom.el('span', 'l-price-figure num'));
    price.appendChild(dom.el('span', 'l-spark'));
    li.appendChild(price);
    li.appendChild(dom.el('p', 'l-num l-chg num'));
    li.appendChild(dom.el('p', 'l-num l-amt num'));
    li.appendChild(dom.el('p', 'l-num l-val num tick'));
    return li;
  }

  function fillRow(li, c) {
    var who = li.children[0].children[li.children[0].children.length - 1];
    dom.setText(who.children[0], c.symbol);
    var amountText = dom.amount(c.quantity);
    dom.setText(who.children[1], amountText);
    var price = li.children[1];
    dom.setText(price.children[0], c.priceUsd === null ? '' : priceText(c.priceUsd));
    var line = lineFor(c);
    paintSpark(price.children[1], line);
    var chg = li.children[2];
    if (line) {
      dom.setText(chg, changeText(line.change));
      dom.setAttr(chg, 'data-dir', line.change > 0.05 ? 'up' : (line.change < -0.05 ? 'down' : 'flat'));
    } else {
      dom.setText(chg, '');
      dom.setAttr(chg, 'data-dir', null);
    }
    dom.setText(li.children[3], amountText);
    dom.setNumber(li.children[4], c.priced ? dom.usd(c.valueUsd) : 'No price');
    dom.setAttr(li.children[4], 'data-unpriced', c.priced ? null : 'true');
  }

  /* A price in the places it needs: two at a dollar and up, more below, so a
     coin at a fraction of a cent is not printed as $0.00. */
  function priceText(n) {
    var abs = Math.abs(n);
    var places = abs >= 1 ? 2 : (abs >= 0.01 ? 4 : 6);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
  }

  function changeText(pct) {
    var rounded = Math.abs(pct) < 0.05 ? 0 : pct;
    return (rounded > 0 ? '+' : (rounded < 0 ? '-' : '')) + Math.abs(rounded).toFixed(1) + '%';
  }

  /* The price line: the day's hourly prices as one stroke, drawn in once, in
     the tone of the day. Nothing at all for a coin with no day. */
  function paintSpark(host, line) {
    var key = line ? line.path : '';
    if (host.dataset.path === key) return;
    host.dataset.path = key;
    dom.clear(host);
    if (!line || typeof document.createElementNS !== 'function') return;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 100 28');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('data-dir', line.change > 0.05 ? 'up' : (line.change < -0.05 ? 'down' : 'flat'));
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('pathLength', '1');
    path.setAttribute('d', line.path);
    svg.appendChild(path);
    host.appendChild(svg);
  }

  /* A coin's day off the day feed (/api/day). The backend asks for every
     coin the token list names, on its own clock, never for the held ones; the
     window names what it holds to its own backend alone, and reads again on
     the first frame that finds the last read five minutes old or a coin held
     that the read never named. A read that fails keeps the last good days and
     waits its five minutes like any other. */
  function ensureDay(coins) {
    if (!net || typeof net.getJson !== 'function' || feed.pending) return;
    var ids = [];
    coins.forEach(function (c) {
      c.assets.forEach(function (id) {
        if (ids.indexOf(id) < 0) ids.push(id);
      });
    });
    if (!ids.length) return;
    var covered = ids.every(function (id) { return feed.asked[id] === true; });
    if (covered && (Date.now() - feed.at < LINES_MS || Date.now() - feed.tried < FEED_SOON_MS)) return;
    ids.sort();
    var asked = Object.create(null);
    ids.forEach(function (id) { asked[id] = true; });
    var landed = true;
    feed.pending = true;
    net.getJson('/api/day?assets=' + encodeURIComponent(ids.join(',')))
      .then(function (result) {
        var data = result && result.data ? result.data : null;
        feed.entries = daysOf(data ? data.entries : null);
        landed = !data || data.at !== null;
      })
      .catch(function () {})
      .then(function () {
        feed.pending = false;
        feed.tried = Date.now();
        /* A feed that has not landed makes nothing fresh (FEED_SOON_MS). A
           read that failed waits its five minutes like any other. */
        if (landed) feed.at = feed.tried;
        feed.asked = asked;
        render();
      });
  }

  /* The feed's days the window can draw, by asset id: a change that is a
     number and a line of at least two prices, every one of them above zero.
     Anything else is no day, and the coin falls back to its candles or shows
     none. */
  function daysOf(entries) {
    var out = Object.create(null);
    if (!entries || typeof entries !== 'object') return out;
    Object.keys(entries).forEach(function (id) {
      var e = entries[id];
      var points = e && Array.isArray(e.line) ? e.line.slice(-25) : [];
      var drawn = points.length >= 2 && points.every(function (p) { return typeof p === 'number' && isFinite(p) && p > 0; });
      if (drawn && typeof e.change24 === 'number' && isFinite(e.change24)) {
        out[id] = { ok: true, change: e.change24, path: pathThrough(points) };
      }
    });
    return out;
  }

  /* A coin's day from the feed: the first of its assets, largest first, that
     the feed has one for. */
  function dayOf(c) {
    for (var i = 0; i < c.assets.length; i += 1) {
      var found = feed.entries[c.assets[i]];
      if (found) return found;
    }
    return null;
  }

  /* The day a coin's row draws: the feed's, else its candles', else none. */
  function lineFor(c) {
    var fed = dayOf(c);
    if (fed) return fed;
    var line = lines[c.key];
    return line && line.ok ? line : null;
  }

  /* 25 hourly candles for a coin the feed has no day for: the close 24 bars
     back is the price a day ago, the same reading the Trade strip makes. Not
     before the feed has answered once, so a coin it covers is never read
     twice over; and only for a coin whose market the app lists
     (state.candleProducts): a stablecoin has none, and asking anyway was a
     502 and a console error on every opening. A line being read again stays
     up until the new one lands; a read that fails keeps the last good line,
     and a coin with none shows none. */
  function ensureLines(coins) {
    if (!net || typeof net.getJson !== 'function') return;
    if (feed.pending && !feed.at) return;
    var now = Date.now();
    coins.forEach(function (c) {
      if (dayOf(c)) return;
      var product = productOf(c.key);
      if (!product) return;
      var had = lines[c.key];
      if (had && (had.pending || now - had.at < LINES_MS)) return;
      lines[c.key] = had && had.ok ? assign(had, { pending: true }) : { ok: false, pending: true, at: 0 };
      net.getJson('/api/candles?product=' + encodeURIComponent(product) + '&granularity=3600&limit=25')
        .then(function (result) {
          lines[c.key] = assign(lineOf(result && Array.isArray(result.data) ? result.data : []), { at: Date.now() });
        })
        .catch(function () {
          lines[c.key] = assign(had && had.ok ? had : { ok: false }, { pending: false, at: Date.now() });
        })
        .then(render);
    });
  }

  /* The market a coin's day is read from: the coin's own, or the coin a
     wrapper stands for, when the app lists it. */
  function productOf(key) {
    var products = (store.get() || {}).candleProducts;
    if (!Array.isArray(products)) return null;
    var want = (UNDER[key] || key) + '-USD';
    for (var i = 0; i < products.length; i += 1) {
      if (String(products[i]).toUpperCase() === want) return String(products[i]);
    }
    return null;
  }

  function assign(into, from) {
    var out = {};
    var key;
    for (key in into) if (Object.prototype.hasOwnProperty.call(into, key)) out[key] = into[key];
    for (key in from) if (Object.prototype.hasOwnProperty.call(from, key)) out[key] = from[key];
    return out;
  }

  function lineOf(candles) {
    var closes = [];
    for (var i = 0; i < candles.length; i += 1) {
      var close = Number(candles[i] && candles[i].c);
      if (isFinite(close) && close > 0) closes.push(close);
    }
    if (closes.length < 2) return { ok: false };
    var day = closes.slice(-25);
    var first = day[0];
    var last = day[day.length - 1];
    return { ok: true, change: ((last - first) / first) * 100, path: pathThrough(day) };
  }

  /* A day's prices as one stroke in the spark's 100 by 28 box. */
  function pathThrough(points) {
    var lo = Math.min.apply(null, points);
    var hi = Math.max.apply(null, points);
    var span = hi - lo || 1;
    var d = '';
    for (var k = 0; k < points.length; k += 1) {
      var x = (k / (points.length - 1)) * 100;
      var y = 26 - ((points[k] - lo) / span) * 24;
      d += (k ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    return d;
  }

  /* ---------- the policies ---------- */

  function buildPolicies() {
    var card = dom.el('section', 'stmt-policies');
    card.setAttribute('aria-label', 'Policies');
    var head = dom.el('header', 'stmt-panel-head');
    head.appendChild(dom.el('h3', '', 'Policies'));
    var freeze = dom.el('span', 'stmt-freeze');
    var g = glyph('freeze');
    if (g) freeze.appendChild(g);
    freeze.appendChild(dom.el('span', ''));
    head.appendChild(freeze);
    card.appendChild(head);
    var dials = dom.el('div', 'dials');
    refs.dialAsk = dial('agent', 'Asks you above');
    refs.dialCap = dial('cap', 'Never more in one move');
    refs.dialAuto = dial('agent', 'On its own today, then it asks again');
    dials.appendChild(refs.dialAsk.node);
    dials.appendChild(refs.dialCap.node);
    dials.appendChild(refs.dialAuto.node);
    card.appendChild(dials);
    var foot = dom.el('p', 'stmt-policies-foot');
    card.appendChild(foot);
    var unread = dom.el('p', 'stmt-empty');
    unread.hidden = true;
    card.appendChild(unread);
    refs.policies = card;
    refs.freeze = freeze;
    refs.policiesFoot = foot;
    refs.policiesUnread = unread;
    refs.dials = dials;
    return card;
  }

  /* One soft dial: a pressed track, the arc of how full it is with its round
     head, the figure on the raised disc in the middle and the words under it. */
  function dial(tone, caption) {
    var node = dom.el('figure', 'dial dial-' + tone);
    var disc = dom.el('div', 'dial-disc');
    var arc = null;
    var head = null;
    if (typeof document.createElementNS === 'function') {
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('aria-hidden', 'true');
      var track = document.createElementNS(SVG_NS, 'circle');
      track.setAttribute('class', 'dial-track');
      track.setAttribute('cx', '50');
      track.setAttribute('cy', '50');
      track.setAttribute('r', '42');
      arc = dialCircle('dial-arc');
      head = dialCircle('dial-head');
      svg.appendChild(track);
      svg.appendChild(arc);
      svg.appendChild(head);
      disc.appendChild(svg);
    }
    var num = dom.el('span', 'dial-num');
    var figure = dom.el('span', 'dial-figure num tick');
    var of = dom.el('small', 'dial-of num');
    num.appendChild(figure);
    num.appendChild(of);
    disc.appendChild(num);
    node.appendChild(disc);
    node.appendChild(dom.el('figcaption', '', caption));
    return { node: node, arc: arc, head: head, figure: figure, of: of, caption: node.children[1] };
  }

  /* The dial's circle measured in hundredths, for a dash that says how full. */
  function dialCircle(className) {
    var circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('class', className);
    circle.setAttribute('cx', '50');
    circle.setAttribute('cy', '50');
    circle.setAttribute('r', '42');
    circle.setAttribute('pathLength', '100');
    return circle;
  }

  /* The arc sweeps in the first time it has a figure and springs to a new
     one after that, its head riding its end; no arc at all where there is no
     figure to draw. */
  function setDial(d, fraction, figure, of, caption) {
    dom.setNumber(d.figure, figure);
    dom.setAttr(d.figure, 'data-long', String(figure).length > 6 ? 'true' : null);
    dom.setText(d.of, of || '');
    dom.setHidden(d.of, !of);
    if (caption) dom.setText(d.caption, caption);
    var shown = fraction === null ? 0 : Math.max(0, Math.min(1, fraction));
    /* Nothing yet is an empty track: a round cap on a zero dash would draw a
       dot that reads as a little spent. */
    dom.setAttr(d.node, 'data-empty', fraction === null || shown === 0 ? 'true' : null);
    if (!d.arc) return;
    /* What shows runs from the top to the value: the arc leaves the top square and stops a
       head short, and the head, a dot the stroke's width, sits on its end, so its round
       edge lands on the value. A full dial is the whole ring, its head where it closes. */
    var sweep = shown > 0 ? Math.max(shown * 100, MIN_SWEEP) : 0;
    var whole = sweep >= 100;
    var reach = !sweep ? 0 : (whole ? 100 : sweep - ARC_CAP);
    var dash = !sweep ? '0 100' : (whole ? '100 100' : reach.toFixed(2) + ' 100');
    var at = !sweep ? '0' : (whole ? '-99.99' : (-reach).toFixed(2));
    if (d.arc.getAttribute('data-drawn') !== 'true') {
      d.arc.setAttribute('data-drawn', 'true');
      d.arc.style.strokeDasharray = '0 100';
      d.head.style.strokeDashoffset = '0';
      forceStyle(d.arc);
      frame(function () {
        d.arc.style.strokeDasharray = dash;
        d.head.style.strokeDashoffset = at;
      });
      return;
    }
    d.arc.style.strokeDasharray = dash;
    d.head.style.strokeDashoffset = at;
  }

  function renderPolicies(state) {
    var policy = state.policy;
    var out = policy && policy.outbound ? policy.outbound : null;
    dom.setHidden(refs.dials, !out);
    dom.setHidden(refs.policiesFoot, !out);
    dom.setText(refs.policiesUnread, out ? '' : 'Your policies could not be read, so nothing moves until they can.');
    dom.setHidden(refs.policiesUnread, !!out);
    var frozen = !!(policy && policy.killSwitch);
    dom.setText(refs.freeze.lastChild, frozen ? 'Freeze is on' : 'Freeze is off');
    dom.setAttr(refs.freeze, 'data-on', frozen ? 'true' : null);
    if (!out) return;
    var ask = num(out.humanClickAboveUsd);
    var cap = num(out.maxPerTransactionUsd);
    setDial(refs.dialAsk, ask !== null && cap ? ask / cap : null, short(ask), '');
    setDial(refs.dialCap, cap === null ? null : 1, short(cap), '');
    var auto = state.autoLimit;
    var allowance = auto && num(auto.capUsd) !== null ? num(auto.capUsd) : num(out.autoApproveDailyUsd);
    if (auto && num(auto.spentUsd) !== null && allowance) {
      setDial(refs.dialAuto, num(auto.spentUsd) / allowance, dom.usd(num(auto.spentUsd)), 'of ' + short(allowance), 'On its own today, then it asks again');
    } else {
      setDial(refs.dialAuto, null, short(allowance), allowance === null ? '' : 'a day', 'On its own each day, then it asks again');
    }
    var daily = num(out.maxPerSessionUsd);
    dom.setText(refs.policiesFoot, daily === null ? '' : 'Up to ' + short(daily) + ' a day');
  }

  function num(v) {
    var n = Number(v);
    return v === null || v === undefined || !isFinite(n) ? null : n;
  }

  /* Whole dollars when the figure is whole, and a hundred thousand and up as
     "$100k" so it keeps to the dial. */
  function short(n) {
    if (n === null) return '';
    if (Math.abs(n) >= 100000) return '$' + Math.round(n / 1000).toLocaleString('en-US') + 'k';
    return dom.usd(n, n % 1 === 0 ? 0 : 2);
  }

  /* ---------- the recent moves ---------- */

  /* The moves still under way come off the state frame, which pushes their
     every change; the ones that ended come off the receipts, read when Pro
     comes up and when a move ends. Trading on Hyperliquid is Trade's. */
  function loadMoves() {
    if (!net || typeof net.getJson !== 'function') return;
    movesAt = Date.now();
    net.getJson('/api/receipts?limit=12')
      .then(function (result) {
        var page = result && result.data ? result.data : null;
        receipts = page && Array.isArray(page.receipts) ? page.receipts : [];
        render();
      })
      .catch(function () { /* the panel keeps what it had */ });
  }

  var endedSeen = {};

  /* The moves under way that the list shows: the ones that move the NEAR
     money. A trade is Trade's and a policy change is not a move. */
  var LIVE_KINDS = { swap: true, intents_send: true, intents_pay: true, hl_deposit: true, hl_withdraw: true };

  function renderMoves(state) {
    var proposals = Array.isArray(state.proposals) ? state.proposals : [];
    var byId = {};
    var live = [];
    var ended = false;
    proposals.forEach(function (p) {
      if (!p) return;
      byId[p.id] = p;
      if (!LIVE_KINDS[p.kind]) return;
      var view = p.view || {};
      /* A late move has stopped expecting the venue and has not ended: it
         stays in the list as under way, never dropped as if it were over. */
      if (view.terminal && view.stage !== 'stalled') {
        if (!endedSeen[p.id]) ended = true;
        endedSeen[p.id] = true;
        return;
      }
      var now = liveOf(p, view);
      var since = view.decidedAt || view.createdAt || p.createdAt;
      live.push({
        key: p.id,
        at: p.createdAt,
        kind: p.kind,
        title: titleOf(p.kind, moneyOfRow(p, view), false) || view.sentence || '',
        state: now.word,
        dir: now.dir,
        meta: now.dir === 'going' ? 'Started ' + dom.ago(since) : upper(dom.ago(p.createdAt)),
        proposal: p
      });
    });
    if (ended && isUp() && Date.now() - movesAt > 1500) loadMoves();
    var done = receipts.filter(function (r) {
      return r && r.kind !== 'trade' && r.kind !== 'bot' && r.kind !== 'policy_change' && !live.some(function (m) { return m.key === r.id; });
    }).map(function (r) {
      var p = byId[r.id];
      var own = p && p.decidedBy === 'policy';
      return {
        key: r.id,
        at: r.at,
        kind: r.kind,
        title: titleOf(r.kind, moneyOfReceipt(r, p), r.status === 'executed') || r.headline || r.summary || 'Something moved',
        state: endWord(r),
        dir: endDir(r),
        meta: upper(dom.ago(r.at)) + (own ? ', on its own' : ''),
        receipt: r
      };
    });
    var items = live.concat(done).sort(function (a, b) {
      return Date.parse(b.at || 0) - Date.parse(a.at || 0);
    }).slice(0, MOVES_SHOWN);
    dom.reconcile(refs.moves, items, function (m) {
      return m.key;
    }, makeMove, fillMove);
    dom.setHidden(refs.movesEmpty, !!items.length);
  }

  /* Where a move under way stands, in the card's own words (ui/screens/cards.js
     plainState): waiting on the person, and on what; working; or coming back. */
  function liveOf(p, view) {
    var cards = window.PhosphorCards;
    var state = cards && typeof cards.plainState === 'function' ? cards.plainState(p) : (view.waitingOn === 'You' ? 'needs_you' : 'working');
    if (state === 'needs_you') {
      if (p.status === 'pending_unlock' || view.stage === 'waiting_for_unlock') return { word: 'Unlock to decide', dir: 'ask' };
      if (p.status === 'awaiting_touch' || view.stage === 'waiting_for_touch') return { word: 'Confirm on your Mac', dir: 'ask' };
      return { word: 'Needs your OK', dir: 'ask' };
    }
    if (state === 'coming_back') return { word: 'Refund on its way', dir: 'going' };
    if (state === 'done') return { word: 'Done', dir: 'done' };
    if (state === 'didnt_go_through') return { word: 'Didn\'t go through', dir: 'no' };
    if (view.stage === 'stalled' || view.late) return { word: 'Taking longer', dir: 'going' };
    return { word: WORKING_WORDS[p.kind] || 'Working', dir: 'going' };
  }

  /* A move in a few words, the way the list reads: what, how much, where to.
     A move that went through says it in the past; the rest say what was asked.
     The server's own sentence is the fallback for a kind this does not name. */
  function titleOf(kind, m, done) {
    if (!m.symbol) return '';
    var what = (m.amount ? m.amount + ' ' : '') + m.symbol;
    if (kind === 'swap') return (done ? 'Swapped ' : 'Swap ') + what + (m.toSymbol ? ' to ' + (done && m.got ? m.got + ' ' : '') + m.toSymbol : '');
    if (kind === 'intents_send' || kind === 'intents_pay') return (done ? 'Sent ' : 'Send ') + what + (m.to ? ' to ' + m.to : '');
    if (kind === 'hl_deposit') return (done ? 'Moved ' : 'Move ') + what + ' to trading';
    if (kind === 'hl_withdraw') return (done ? 'Moved ' : 'Move ') + what + ' back from trading';
    return '';
  }

  function moneyOfRow(p, view) {
    var money = view.money || {};
    var draft = p.draft || {};
    var asked = money.amountIn !== undefined && money.amountIn !== null ? money.amountIn : (p.kind === 'swap' ? draft.amountIn : draft.amount);
    return {
      amount: figureOf(asked),
      symbol: String(money.symbol || draft.fromSymbol || draft.symbol || ''),
      toSymbol: String(money.toSymbol || draft.toSymbol || ''),
      got: figureOf(money.amountOut),
      to: typeof draft.to === 'string' ? draft.to : ''
    };
  }

  /* A receipt names what left and what arrived; the receiver of a send is on
     its proposal, while the window still holds it. */
  function moneyOfReceipt(r, p) {
    var draft = p && p.draft ? p.draft : {};
    return {
      amount: figureOf(r.amount),
      symbol: String(r.symbol || draft.fromSymbol || draft.symbol || ''),
      toSymbol: String(r.received && r.received.symbol ? r.received.symbol : (draft.toSymbol || '')),
      got: r.received ? figureOf(r.received.amount) : '',
      to: typeof draft.to === 'string' ? draft.to : ''
    };
  }

  function figureOf(value) {
    if (value === null || value === undefined || value === '') return '';
    var n = Number(value);
    return isFinite(n) && n > 0 ? n.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '';
  }

  function upper(words) {
    var text = String(words || '');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function endWord(r) {
    if (r.status === 'failed') return 'Didn\'t go through';
    if (r.status === 'needs_reconciliation') return 'Not confirmed';
    return r.kind === 'intents_deposit' ? 'Arrived' : 'Done';
  }

  function endDir(r) {
    if (r.status === 'failed') return 'no';
    if (r.status === 'needs_reconciliation') return 'unsure';
    return 'done';
  }

  var MOVE_ICONS = { swap: 'swap', intents_deposit: 'deposit', hl_deposit: 'send', hl_withdraw: 'deposit', intents_withdraw: 'withdraw', intents_send: 'send', intents_pay: 'send', transfer: 'send' };

  function makeMove(m) {
    var li = dom.el('li', 'move');
    var tile = dom.el('span', 'move-icon');
    li.appendChild(tile);
    var words = dom.el('div', 'move-words');
    words.appendChild(dom.el('p', 'move-title'));
    words.appendChild(dom.el('p', 'move-meta'));
    li.appendChild(words);
    var st = dom.el('span', 'move-state');
    st.appendChild(dom.el('span', 'move-state-icon'));
    st.appendChild(dom.el('span', ''));
    li.appendChild(st);
    return li;
  }

  function fillMove(li, m) {
    var icon = MOVE_ICONS[m.kind] || 'swap';
    var tile = li.children[0];
    if (tile.dataset.icon !== icon) {
      tile.dataset.icon = icon;
      dom.clear(tile);
      var g = glyph(icon);
      if (g) tile.appendChild(g);
    }
    dom.setText(li.children[1].children[0], m.title);
    dom.setAttr(li.children[1].children[0], 'title', m.title);
    dom.setText(li.children[1].children[1], m.meta);
    var st = li.children[2];
    var mark = { ask: 'waiting', going: 'spin', done: 'check', no: 'refused', unsure: 'warning' }[m.dir] || 'check';
    if (st.dataset.mark !== mark) {
      st.dataset.mark = mark;
      dom.clear(st.children[0]);
      var s = glyph(mark);
      if (s) st.children[0].appendChild(s);
    }
    dom.setText(st.children[1], m.state);
    dom.setAttr(st, 'data-dir', m.dir);
    dom.setAttr(li, 'data-receipt', m.receipt ? 'true' : null);
    li.__move = m;
  }

  /* An ended move opens its receipt, the way an Activity row does. */
  function onMovePress(event) {
    for (var at = event.target; at && at !== refs.moves; at = at.parentNode) {
      if (at.__move && at.__move.receipt) {
        var events = window.PhosphorEvents;
        if (events && typeof events.emit === 'function') events.emit('receipt:open', { receipt: at.__move.receipt, source: 'pro' });
        return;
      }
    }
  }

  /* ---------- the actions ---------- */

  /* Swap is said to the assistant: the word goes into the message field and
     the person says what, from what, how much. Words already in the field are
     the person's and stay. With no agent to say it to, the note says what to
     do first. */
  function askToSwap() {
    var input = document.querySelector ? document.querySelector('.composer-input') : null;
    if (input && !input.disabled && typeof input.focus === 'function') {
      if (!String(input.value || '').trim()) {
        input.value = 'Swap ';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.focus();
      if (typeof input.setSelectionRange === 'function') input.setSelectionRange(input.value.length, input.value.length);
      say('');
      return;
    }
    say('Start your agent, then tell it what to swap.');
  }

  function say(words) {
    dom.setText(refs.note, words);
    dom.setHidden(refs.note, !words);
  }

  /* Add money runs its steps in place of the ledger and the panels under it,
     and Close puts them back, both on the morph, the focus following. */
  function openFlow() {
    if (flowSteps) return;
    if (window.PhosphorLazy) window.PhosphorLazy.load('qr');
    swapIn(function () {
      dom.setHidden(refs.ledger, true);
      dom.setHidden(refs.duo, true);
      dom.setHidden(refs.flow, false);
      flowSteps = window.PhosphorMoneyIn ? (window.PhosphorMoneyIn.render(refs.flowBody, { context: 'basic' }) || {}) : {};
      if (refs.flowTitle.focus) refs.flowTitle.focus({ preventScroll: true });
    });
  }

  function closeFlow() {
    if (!flowSteps) return;
    var closing = flowSteps;
    flowSteps = null;
    swapIn(function () {
      if (typeof closing.destroy === 'function') closing.destroy();
      dom.clear(refs.flowBody);
      dom.setHidden(refs.flow, true);
      dom.setHidden(refs.ledger, false);
      dom.setHidden(refs.duo, false);
      if (refs.add.focus) refs.add.focus({ preventScroll: true });
    });
  }

  function swapIn(change) {
    var motion = window.PhosphorMotion;
    if (motion && typeof motion.morph === 'function') motion.morph(refs.root, change);
    else change();
  }

  /* ---------- the ring ---------- */

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var name in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, name)) node.setAttribute(name, attrs[name]);
    }
    return node;
  }

  /* Built in the svg namespace, never from markup. Null where there is no
     svg namespace (the unit harness), and every caller reads that as "no
     ring". */
  function ringSvg() {
    if (typeof document.createElementNS !== 'function') return null;
    var svg = svgEl('svg', { class: 'stmt-ring', viewBox: '0 0 120 120', 'aria-hidden': 'true', focusable: 'false' });
    var defs = svgEl('defs', {});
    var disc = svgEl('radialGradient', { id: 'stmt-disc', cx: '50%', cy: '36%', r: '62%' });
    disc.appendChild(svgEl('stop', { offset: '0', class: 'stmt-disc-top' }));
    disc.appendChild(svgEl('stop', { offset: '1', class: 'stmt-disc-foot' }));
    defs.appendChild(disc);
    svg.appendChild(defs);
    svg.appendChild(svgEl('circle', { class: 'stmt-ring-disc', cx: '60', cy: '60', r: '46' }));
    svg.appendChild(svgEl('circle', { class: 'stmt-ring-track', cx: '60', cy: '60', r: String(R) }));
    var pieces = svgEl('g', { class: 'stmt-ring-pieces', transform: 'rotate(-90 60 60)' });
    svg.appendChild(pieces);
    return { svg: svg, pieces: pieces, byKey: {} };
  }

  function piecesOf(coins) {
    var out = [];
    var priced = coins.filter(function (c) { return c.priced && c.valueUsd > 0; });
    var sum = totalOf(priced);
    if (!(sum > 0)) return out;
    var rest = 0;
    priced.forEach(function (c) {
      if (c.valueUsd / sum < SLIVER) {
        rest += c.valueUsd;
        return;
      }
      out.push({ key: c.key, usd: c.valueUsd, colour: tintOf(c.symbol) });
    });
    if (rest > 0) out.push({ key: ':rest', usd: rest, colour: NEUTRAL });
    return out;
  }

  /* Each piece springs to its share when the money moves; the first draw
     grows them out of their places a beat apart, as Basic's does. */
  function paintRing(coins) {
    var ring = refs.ring;
    if (!ring) return;
    var pieces = piecesOf(coins);
    var sum = 0;
    for (var i = 0; i < pieces.length; i += 1) sum += pieces[i].usd;
    var still = reduced();
    var intro = !ringDrawn && !still && pieces.length > 0;
    var seen = {};
    var at = 0;
    for (var k = 0; k < pieces.length; k += 1) {
      var piece = pieces[k];
      var len = pieces.length === 1 ? C : piece.usd / sum * C;
      var dash = pieces.length === 1 ? C : Math.max(MIN_DASH, len - GAP);
      var start = pieces.length === 1 ? 0 : at + GAP / 2;
      var node = ring.byKey[piece.key];
      var born = !node;
      if (born) {
        node = svgEl('circle', { class: 'stmt-ring-piece', cx: '60', cy: '60', r: String(R) });
        ring.byKey[piece.key] = node;
        if (!intro && !still && ringDrawn) setDash(node, 0.001, start, false);
      }
      node.style.stroke = piece.colour;
      if (node.parentNode !== ring.pieces || ring.pieces.children[k] !== node) ring.pieces.insertBefore(node, ring.pieces.children[k] || null);
      if (intro) {
        setDash(node, 0.001, start, false);
        growLater(node, dash, start, k * STAGGER_MS);
      } else {
        if (born && !still && ringDrawn) forceStyle(node);
        setDash(node, dash, start, !still && ringDrawn);
      }
      seen[piece.key] = true;
      at += len;
    }
    for (var key in ring.byKey) {
      if (!Object.prototype.hasOwnProperty.call(ring.byKey, key) || seen[key]) continue;
      var gone = ring.byKey[key];
      if (gone.parentNode) gone.parentNode.removeChild(gone);
      delete ring.byKey[key];
    }
    if (pieces.length) ringDrawn = true;
  }

  function setDash(node, dash, start, animate) {
    node.style.transition = animate ? '' : 'none';
    node.style.transitionDelay = '0ms';
    node.style.strokeDasharray = dash.toFixed(3) + ' ' + C.toFixed(3);
    node.style.strokeDashoffset = (-start).toFixed(3);
  }

  function growLater(node, dash, start, delay) {
    forceStyle(node);
    frame(function () {
      node.style.transition = '';
      node.style.transitionDelay = delay + 'ms';
      node.style.strokeDasharray = dash.toFixed(3) + ' ' + C.toFixed(3);
      node.style.strokeDashoffset = (-start).toFixed(3);
    });
  }

  function forceStyle(node) {
    if (typeof node.getBoundingClientRect === 'function') node.getBoundingClientRect();
  }

  function frame(fn) {
    var raf = window.requestAnimationFrame;
    if (typeof raf === 'function') raf(function () { raf(fn); });
    else fn();
  }

  function reduced() {
    var motion = window.PhosphorMotion;
    return !!(motion && typeof motion.reduced === 'function' && motion.reduced());
  }

  function tintOf(symbol) {
    var key = String(symbol || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(TINTS, key)) return TINTS[key];
    var marks = window.PhosphorMarks;
    var hex = marks && typeof marks.colourFor === 'function' ? marks.colourFor(symbol) : '';
    var hsl = hslOf(hex);
    if (!hsl) return NEUTRAL;
    if (hsl.s > 0.35 && hsl.h >= 80 && hsl.h <= 170) return NEUTRAL;
    var l = Math.min(0.88, Math.max(0.64, hsl.l));
    var s = Math.min(0.95, hsl.s);
    return 'hsl(' + Math.round(hsl.h) + ', ' + Math.round(s * 100) + '%, ' + Math.round(l * 100) + '%)';
  }

  function hslOf(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return null;
    var r = parseInt(m[1].slice(0, 2), 16) / 255;
    var g = parseInt(m[1].slice(2, 4), 16) / 255;
    var b = parseInt(m[1].slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    if (d === 0) return { h: 0, s: 0, l: l };
    var s = d / (1 - Math.abs(2 * l - 1));
    var h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return { h: h, s: s, l: l };
  }

  window.PhosphorPro = { boot: boot };
})();
