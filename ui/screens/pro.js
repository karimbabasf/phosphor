/* Pro's header: your money, then your trading account, over the positions.

   Pro is your money and your positions: this header over the positions,
   orders and the last day's trades, stacked in one scroll (ui/screens/trade.js
   builds that deck into #view-trade; ui/design/pro.css decides which parts
   each view shows). Trade has no header of its own: the market leads there,
   and the trading account sits at its deck's tab row.

   Your money is the balance total with what it is, from the same server view
   the Basic panel draws (state.basic), and the coins it holds in brief. The
   trading account is what it holds, what is free, what the open plans have in
   them and the most they can lose if every stop fills. Those come off the trade
   payload, which trade.js reads on every `trade` frame of the stream and hands
   over as a `phosphor:trade` event, so nothing here polls. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;

  /* The sentence the one action on an empty trading account sends: the
     assistant proposes the move, and the card in the thread asks for the
     click. It never names an amount for the person. */
  var FUND_ASK = 'Help me add money to my trading account.';

  /* How many coins the header names before it counts the rest. */
  var COINS_SHOWN = 3;

  /* The ring: Basic's allocation ring at Pro's size, the world's one
     signature, so the two modes show the same money the same way. The
     geometry is Basic's scaled to a 120 unit box. */
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

  var refs = {};
  var mounted = false;
  var ringDrawn = false;

  /* The last trade payload trade.js read, or null before the trade bundle has
     loaded or its first read has landed. */
  var trade = null;

  function boot() {
    var host = document.getElementById('view-pro');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(renderBalance);

    window.addEventListener('phosphor:trade', function (event) {
      trade = event && event.detail ? event.detail : null;
      renderTrading();
    });

    /* The chart and the deck are a late load (ui/core/lazy.js), fetched the
       first time Pro or Trade is on screen. */
    window.addEventListener('phosphor:view', function (event) {
      var view = event && event.detail ? event.detail.view : null;
      if (view === 'pro' || view === 'trade') loadTrading();
    });

    renderBalance();
    renderTrading();
  }

  function loadTrading() {
    if (window.PhosphorLazy && typeof window.PhosphorLazy.load === 'function') window.PhosphorLazy.load('trade');
  }

  function build(host) {
    var head = dom.el('section', 'pro-sum');
    head.setAttribute('aria-label', 'Your money');

    /* The balance: the ring of what it holds, the one lead figure on Pro
       with the server's words for it, and the coins in brief under it, each
       on a tile washed in its own colour, the ring's colour. */
    var money = dom.el('div', 'pro-sum-money');
    money.dataset.surface = 'holdings';
    var ring = ringSvg();
    if (ring) {
      /* On the disc: the largest coin's share, so the ring reads as where the
         money sits and not as something loading. */
      var box = dom.el('div', 'pro-ring-box');
      box.appendChild(ring.svg);
      var share = dom.el('div', 'pro-ring-share');
      share.appendChild(dom.el('span', 'pro-ring-pct num'));
      share.appendChild(dom.el('span', 'pro-ring-coin'));
      box.appendChild(share);
      ring.share = share;
      money.appendChild(box);
    }
    var main = dom.el('div', 'pro-sum-main');
    money.appendChild(main);
    var lead = dom.el('div', 'pro-sum-lead');
    var total = dom.el('p', 'pro-sum-total num tick');
    total.hidden = true;
    var skel = dom.el('span', 'skel pro-sum-skel');
    skel.setAttribute('aria-hidden', 'true');
    var caption = dom.el('p', 'pro-sum-caption');
    lead.appendChild(total);
    lead.appendChild(skel);
    lead.appendChild(caption);
    main.appendChild(lead);
    var coins = dom.el('ul', 'pro-coins');
    coins.setAttribute('aria-label', 'What your balance holds');
    coins.hidden = true;
    main.appendChild(coins);
    head.appendChild(money);

    /* The trading account: one card, its money as the lead figure and what
       is free, in trades and at most at risk quiet beside it, or one
       sentence and the way to fill it when there is nothing on it. */
    var account = dom.el('div', 'pro-sum-account');
    account.dataset.surface = 'account';
    account.setAttribute('aria-label', 'Your trading account');
    account.appendChild(dom.el('h3', 'pro-sum-head', 'Trading account'));
    var wait = dom.el('span', 'skel pro-sum-wait');
    wait.setAttribute('aria-hidden', 'true');
    account.appendChild(wait);
    var figures = dom.el('dl', 'pro-sum-figures');
    var note = dom.el('p', 'pro-sum-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    var fund = dom.el('button', 'btn btn-sm pro-sum-fund');
    fund.type = 'button';
    fund.appendChild(dom.el('span', 'btn-label', 'Add trading money'));
    fund.hidden = true;
    account.appendChild(figures);
    account.appendChild(note);
    account.appendChild(fund);
    head.appendChild(account);

    host.appendChild(head);

    refs = {
      host: host,
      ring: ring,
      total: total,
      skel: skel,
      caption: caption,
      coins: coins,
      account: account,
      wait: wait,
      figures: figures,
      note: note,
      fund: fund
    };

    dom.on(fund, 'click', askToFund);
  }

  /* ---------- the balance ---------- */

  /* The figure and the words under it are the server's, the same two the
     Basic panel prints, so the two modes never disagree about the total. */
  function renderBalance() {
    if (!mounted || !store.loaded()) return;
    var basic = (store.get() || {}).basic || {};
    if (refs.skel.parentNode) refs.skel.parentNode.removeChild(refs.skel);
    dom.setNumber(refs.total, basic.totalLine || '');
    dom.setHidden(refs.total, !basic.totalLine);
    dom.setText(refs.caption, basic.caption || '');
    dom.setAttr(refs.caption, 'data-alone', basic.totalLine ? null : 'true');
    var holdings = Array.isArray(basic.holdings) ? basic.holdings : [];
    renderCoins(holdings);
    paintRing(holdings);
  }

  /* The coins in brief: the largest first, each with its logo and what it is
     worth, and a count of the rest. The full list is Basic's. Where the
     header is narrow the third coin gives way to the count (pro.css), so the
     count carries both numbers and the sheet shows the one that is true. */
  function renderCoins(holdings) {
    var shown = holdings.slice(0, COINS_SHOWN);
    var rest = holdings.length - shown.length;
    var restNarrow = holdings.length - Math.min(holdings.length, COINS_SHOWN - 1);
    var items = shown.map(function (h, i) { return { key: String(h.symbol), h: h, third: i === COINS_SHOWN - 1 }; });
    if (restNarrow > 0) items.push({ key: '+rest', rest: rest, restNarrow: restNarrow });
    dom.reconcile(refs.coins, items, function (item) {
      return item.key;
    }, function (item) {
      var li = dom.el('li', item.restNarrow ? 'pro-coin pro-coin-rest' : 'pro-coin');
      if (!item.restNarrow) {
        var marks = window.PhosphorMarks;
        if (marks && typeof marks.logo === 'function') li.appendChild(marks.logo(String(item.h.symbol), 20));
        li.appendChild(dom.el('span', 'pro-coin-name'));
        li.appendChild(dom.el('span', 'pro-coin-value num'));
      } else {
        li.appendChild(dom.el('span', 'pro-coin-name pro-coin-wide'));
        li.appendChild(dom.el('span', 'pro-coin-name pro-coin-narrow'));
      }
      return li;
    }, function (li, item) {
      if (item.restNarrow) {
        dom.setText(li.children[0], item.rest > 0 ? '+' + item.rest + ' more' : '');
        dom.setHidden(li.children[0], !(item.rest > 0));
        dom.setText(li.children[1], '+' + item.restNarrow + ' more');
        dom.setAttr(li, 'data-narrow-only', item.rest > 0 ? null : 'true');
        return;
      }
      dom.setAttr(li, 'data-third', item.third ? 'true' : null);
      if (li.style && typeof li.style.setProperty === 'function') li.style.setProperty('--tint', tintOf(item.h.symbol));
      dom.setText(li.children[1], String(item.h.symbol));
      dom.setAttr(li, 'title', item.h.name && item.h.name !== item.h.symbol ? String(item.h.name) : null);
      dom.setText(li.children[2], item.h.valueLine || '');
    });
    dom.setHidden(refs.coins, items.length === 0);
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
    var svg = svgEl('svg', { class: 'pro-ring', viewBox: '0 0 120 120', 'aria-hidden': 'true', focusable: 'false' });
    var defs = svgEl('defs', {});
    var disc = svgEl('radialGradient', { id: 'pro-disc', cx: '50%', cy: '38%', r: '62%' });
    disc.appendChild(svgEl('stop', { offset: '0', class: 'pro-disc-top' }));
    disc.appendChild(svgEl('stop', { offset: '1', class: 'pro-disc-foot' }));
    defs.appendChild(disc);
    svg.appendChild(defs);
    svg.appendChild(svgEl('circle', { class: 'pro-ring-disc', cx: '60', cy: '60', r: '44' }));
    svg.appendChild(svgEl('circle', { class: 'pro-ring-track', cx: '60', cy: '60', r: String(R) }));
    var pieces = svgEl('g', { class: 'pro-ring-pieces', transform: 'rotate(-90 60 60)' });
    svg.appendChild(pieces);
    return { svg: svg, pieces: pieces, byKey: {} };
  }

  /* The pieces, from the priced coins in the order the list reads (largest
     first); slivers under two percent share one neutral piece. */
  function piecesOf(holdings) {
    var out = [];
    var sum = 0;
    var rest = 0;
    for (var i = 0; i < holdings.length; i += 1) {
      var usd = Number(holdings[i].valueUsd);
      if (isFinite(usd) && usd > 0) sum += usd;
    }
    if (!(sum > 0)) return out;
    for (var j = 0; j < holdings.length; j += 1) {
      var value = Number(holdings[j].valueUsd);
      if (!isFinite(value) || value <= 0) continue;
      if (value / sum < SLIVER) {
        rest += value;
        continue;
      }
      out.push({ key: String(holdings[j].symbol), usd: value, colour: tintOf(holdings[j].symbol) });
    }
    if (rest > 0) out.push({ key: ':rest', usd: rest, colour: NEUTRAL });
    return out;
  }

  /* Each piece springs to its share when the money moves; the first draw
     grows them out of their places a beat apart, as Basic's does. */
  function paintRing(holdings) {
    var ring = refs.ring;
    if (!ring) return;
    var pieces = piecesOf(holdings);
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
        node = svgEl('circle', { class: 'pro-ring-piece', cx: '60', cy: '60', r: String(R) });
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
    dom.setAttr(ring.svg, 'data-empty', pieces.length ? null : 'true');
    var top = pieces.length && pieces[0].key !== ':rest' ? pieces[0] : null;
    dom.setText(ring.share.children[0], top ? Math.round(top.usd / sum * 100) + '%' : '');
    dom.setText(ring.share.children[1], top ? top.key : '');
    dom.setHidden(ring.share, !top);
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

  /* ---------- the trading account ---------- */

  /* Four answers, each its own sentence, because they mean different things
     to a person deciding a trade:
       no read yet, or the venue has not answered (collateral.funded null)
       the venue is not answering now: the figures read as unknown, never zero
       nothing on the account, or only dust (collateral.funded false)
       money on it: what it holds, what is free, what the plans have in them
       and the most they can lose. */
  function renderTrading() {
    if (!mounted) return;
    var data = trade && trade.data ? trade.data : null;
    var account = data && data.account ? data.account : null;
    var collateral = data && data.collateral ? data.collateral : null;
    var funded = collateral && typeof collateral.funded === 'boolean' ? collateral.funded : null;

    dom.setAttr(refs.host, 'data-quiet', quiet(data) ? 'true' : null);

    if (!data) return say('', [], false, null);

    if (venueDown(data)) {
      return say('Hyperliquid is not answering. These come back on their own.', [
        { key: 'equity', label: 'Trading money', value: '--', dim: true },
        { key: 'free', label: 'Free', value: '--', dim: true }
      ], false, null);
    }

    if (funded === null || (account && account.accountKnown === false)) {
      return say('Checking your trading account.', [], false, null);
    }

    if (funded === false) {
      return say('No trading money yet. Once there is some, Pro shows your positions, your orders and what they made.', [], true, false);
    }

    var items = [];
    items.push({ key: 'equity', label: 'Trading money', value: usdOr(account && account.equityUsd), dim: !isNum(account && account.equityUsd) });
    items.push({ key: 'free', label: 'Free', value: usdOr(account && account.freeUsd), dim: !isNum(account && account.freeUsd) });
    /* What the app's own open plans have posted, and what their stops cap the
       loss at. Both are the app's sums over its own plans, so they are only
       worth a tile once a plan is live; a position opened elsewhere is not in
       them, which the title says. */
    var inTrades = account && isNum(account.atRiskUsd) ? account.atRiskUsd : 0;
    if (inTrades > 0) {
      items.push({ key: 'margin', label: 'In trades', value: dom.usd(inTrades), dim: false, title: 'What your open plans have posted as margin.' });
      var maxLoss = account && isNum(account.maxLossUsd) ? account.maxLossUsd : null;
      if (maxLoss !== null && maxLoss > 0) {
        items.push({ key: 'loss', label: 'Max loss', value: dom.usd(maxLoss), dim: false, title: 'The most your open plans lose if every stop fills, fees in. Positions opened outside Phosphor are not counted.' });
      }
    }
    return say('', items, false, true);
  }

  function say(note, items, offerFund, funded) {
    /* Before the first read the card holds the shape of its figure, not an
       empty head. */
    dom.setHidden(refs.wait, !!(note || items.length || offerFund));
    dom.setText(refs.note, note);
    dom.setHidden(refs.note, !note);
    dom.setHidden(refs.fund, !offerFund);
    dom.setAttr(refs.host, 'data-funded', funded === null ? null : (funded ? 'true' : 'false'));
    dom.reconcile(refs.figures, items, function (item) {
      return item.key;
    }, function () {
      var cell = dom.el('div', 'pro-sum-figure');
      cell.appendChild(dom.el('dt', 'pro-sum-label'));
      cell.appendChild(dom.el('dd', 'pro-sum-value num tick'));
      return cell;
    }, function (cell, item) {
      dom.setText(cell.children[0], item.label);
      dom.setNumber(cell.children[1], item.value);
      dom.setAttr(cell.children[1], 'data-dim', item.dim ? 'true' : null);
      dom.setAttr(cell, 'title', item.title || null);
    });
    dom.setHidden(refs.figures, !items.length);
  }

  /* Nothing on the deck to list: no position, no plan and no fill. Pro then
     draws its header alone, calm, rather than three empty sections. */
  function quiet(data) {
    if (!data) return false;
    var none = function (list) { return !Array.isArray(list) || list.length === 0; };
    return none(data.positions) && none(data.plans) && none(data.fills);
  }

  /* The one action on an empty account: ask the assistant, in the thread, in
     the person's own words. The move it proposes waits for the click on its
     card like every other. With no agent running the button says what to do
     first rather than failing quietly. */
  function askToFund() {
    var agent = window.PhosphorAgent;
    var sent = !!(agent && typeof agent.send === 'function' && agent.send(FUND_ASK));
    if (sent) return;
    dom.setText(refs.note, 'Start your agent, then ask it to add money to your trading account.');
    dom.setHidden(refs.note, false);
  }

  function venueDown(data) {
    var venue = data && data.venue;
    if (!venue) return false;
    return venue.connected === false || !!venue.error;
  }

  function isNum(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /* A figure the venue did not state is a dash, never $0.00. */
  function usdOr(value) {
    return isNum(value) ? dom.usd(value) : '--';
  }

  window.PhosphorPro = { boot: boot };
})();
