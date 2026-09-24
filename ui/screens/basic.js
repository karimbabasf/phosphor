/* Basic: the balances slab beside the conversation.

   One job: say where the money is, calmly, and let a person add more. A ring
   that splits the total by coin with the total inside it, what that figure is
   in words, one soft tile per coin tinted by the coin's own colour, and one
   way to add money. Every sentence arrives from the server (src/view/basic.ts);
   this file places them and moves the numbers.

   When the money moves, the ring's pieces spring to the new split, and a tile
   whose figure moved rolls to the new one and lights once, the way phosphor
   does: the light arrives fast and decays slow. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var store = window.PhosphorState;
  var marks = window.PhosphorMarks;

  /* How long a tile's light takes to arrive (--dur-glow-in in tokens.css).
     Taking the attribute away hands the tile to the stylesheet's slow decay
     (--dur-glow-out). */
  var GLOW_IN_MS = 120;

  /* THE RING. One circle of radius 108 in a 244 box, 14 thick, round ended,
     with the disc the total sits on inside it. Each coin's piece is a dash of
     that circle, clockwise from the top in the order the list reads, with a
     gap of GAP between pieces; a coin under SLIVER of the total joins "the
     rest" rather than drawing a dot. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var R = 108;
  var C = 2 * Math.PI * R;
  var GAP = 24;
  var SLIVER = 0.02;
  /* The shortest piece drawn: a short arc, never a lone dot. */
  var MIN_DASH = 6;
  var STAGGER_MS = 70;

  /* A caption longer than this leaves the disc and sits under the ring. */
  var CAPTION_IN = 26;

  /* A coin whose brand colour is green wears this instead: green is the
     app's own light (the mark, a live move, success, Approve). So does a coin
     with no colour of its own, and the rest of the ring. */
  var NEUTRAL = '#e6ddd2';

  /* The coins most wallets hold, lifted by eye so the three that are all blue to violet in
     their brands (USDC, ETH, SOL) still tell apart on the ring. */
  var TINTS = { USDC: '#3b8cff', 'USDC.E': '#3b8cff', USDCX: '#3b8cff', ETH: '#b0b4ff', WETH: '#b0b4ff', SOL: '#a86dff' };

  var refs = {};
  var mounted = false;
  var filled = false;
  var steps = null;
  /* How the tiles fit the slab (fitRows): how many show whole, of how many, a tile apart. */
  var shown = null;
  var ringDrawn = false;

  function boot() {
    var host = document.getElementById('view-basic');
    if (!host) return;
    build(host);
    mounted = true;
    store.subscribe(render);
  }

  function build(host) {
    var panel = dom.el('section', 'bal');
    panel.dataset.surface = 'holdings';
    panel.setAttribute('aria-label', 'Your balance');

    var head = dom.el('div', 'bal-head');
    var ring = ringSvg();
    var centre = dom.el('div', 'bal-centre');
    var total = dom.el('p', 'bal-total num tick');
    var totalSkel = dom.el('span', 'skel bal-total-skel');
    var caption = dom.el('p', 'bal-caption');
    centre.appendChild(total);
    centre.appendChild(totalSkel);
    centre.appendChild(caption);
    if (ring) head.appendChild(ring.svg);
    head.appendChild(centre);
    var under = dom.el('div', 'bal-under');
    panel.appendChild(head);
    panel.appendChild(under);

    var list = dom.el('div', 'bal-list');
    var room = dom.el('div', 'bal-room');
    var scroll = dom.el('div', 'bal-scroll');
    var rows = dom.el('ul', 'bal-rows');
    rows.setAttribute('aria-label', 'What you hold');
    for (var i = 0; i < 3; i += 1) rows.appendChild(skeletonRow());
    /* Under the tiles: how many more there are, when the slab cannot show them all, and the
       balances too small to list. */
    var foot = dom.el('div', 'bal-foot');
    foot.hidden = true;
    var more = dom.el('button', 'bal-more');
    more.type = 'button';
    more.hidden = true;
    var moreLabel = dom.el('span', 'bal-more-label');
    more.appendChild(moreLabel);
    more.appendChild(window.PhosphorIcons.svg('chevron-down', 'bal-more-chev'));
    var small = dom.el('p', 'bal-small');
    small.hidden = true;
    foot.appendChild(more);
    foot.appendChild(small);
    var empty = dom.el('p', 'bal-empty');
    empty.hidden = true;
    var add = dom.el('button', 'bal-add');
    add.type = 'button';
    add.appendChild(window.PhosphorIcons.svg('deposit'));
    add.appendChild(dom.el('span', '', 'Add money'));
    /* Beside Add money, the second key of its pair: the Policies, which live on
       the Vault. It goes there and lands on them (ui/screens/shell.js reveal). */
    var rules = dom.el('button', 'btn btn-ghost btn-lg bal-rules');
    rules.type = 'button';
    rules.appendChild(window.PhosphorIcons.svg('gauge'));
    rules.appendChild(dom.el('span', 'btn-label', 'Policies'));
    var actions = dom.el('div', 'bal-actions');
    actions.appendChild(add);
    actions.appendChild(rules);
    scroll.appendChild(rows);
    scroll.appendChild(empty);
    room.appendChild(scroll);
    room.appendChild(foot);
    list.appendChild(room);
    list.appendChild(actions);
    panel.appendChild(list);

    /* The deposit steps (ui/screens/moneyin.js) run here, in the slab, rather
       than in a dialog over the window: nothing covers the conversation, and
       the total stays in view to watch the money land. */
    var flow = dom.el('div', 'bal-flow');
    flow.hidden = true;
    var flowHead = dom.el('div', 'bal-flow-head');
    var title = dom.el('h2', 'bal-flow-title', 'Add money');
    title.setAttribute('tabindex', '-1');
    var done = dom.el('button', 'btn btn-quiet btn-sm bal-done');
    done.type = 'button';
    done.appendChild(dom.el('span', 'btn-label', 'Close'));
    flowHead.appendChild(title);
    flowHead.appendChild(done);
    var flowBody = dom.el('div', 'bal-flow-body');
    flow.appendChild(flowHead);
    flow.appendChild(flowBody);
    panel.appendChild(flow);

    host.appendChild(panel);

    refs = {
      panel: panel,
      head: head,
      ring: ring,
      centre: centre,
      under: under,
      total: total,
      totalSkel: totalSkel,
      caption: caption,
      list: list,
      room: room,
      scroll: scroll,
      foot: foot,
      more: more,
      moreLabel: moreLabel,
      rows: rows,
      small: small,
      empty: empty,
      add: add,
      rules: rules,
      keys: actions,
      flow: flow,
      title: title,
      flowBody: flowBody
    };

    dom.on(add, 'click', openSteps);
    dom.on(rules, 'click', function () {
      var shell = window.PhosphorShell;
      if (shell && typeof shell.setView === 'function') shell.setView('vault', { fromClick: true, reveal: 'policies' });
    });
    dom.on(done, 'click', closeSteps);
    /* Escape on the network tiles asks whoever holds the picker to close it (ui/screens/netpick.js). */
    dom.on(flowBody, 'netpick:dismiss', function (event) {
      if (!steps) return;
      event.preventDefault();
      closeSteps();
    });
    dom.on(scroll, 'scroll', paintMore);
    dom.on(more, 'click', turnPage);
    /* The room the tiles have changes with the window, the notice under the slab and the
       caption over the list; every change is a new count of whole tiles. The list is watched,
       not the room: the room is only as tall as the tiles it shows. */
    if (typeof window.ResizeObserver === 'function') new window.ResizeObserver(fitSoon).observe(list);
    else window.addEventListener('resize', fitSoon);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSoon);
  }

  function skeletonRow() {
    var row = dom.el('li', 'bal-row bal-row-skel');
    row.setAttribute('aria-hidden', 'true');
    row.appendChild(dom.el('span', 'skel bal-coin-skel'));
    row.appendChild(dom.el('span', 'skel grow'));
    return row;
  }

  /* ---------- the ring ---------- */

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var name in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, name)) node.setAttribute(name, attrs[name]);
    }
    return node;
  }

  /* Built in the svg namespace, never from markup. Null where there is no svg
     namespace to build in (the unit harness), and every caller treats that as
     "no ring". */
  function ringSvg() {
    if (typeof document.createElementNS !== 'function') return null;
    var svg = svgEl('svg', { class: 'bal-ring', viewBox: '0 0 244 244', 'aria-hidden': 'true', focusable: 'false' });
    var defs = svgEl('defs', {});
    var disc = svgEl('radialGradient', { id: 'bal-disc', cx: '50%', cy: '38%', r: '62%' });
    disc.appendChild(svgEl('stop', { offset: '0', class: 'bal-disc-top' }));
    disc.appendChild(svgEl('stop', { offset: '1', class: 'bal-disc-foot' }));
    defs.appendChild(disc);
    svg.appendChild(defs);
    svg.appendChild(svgEl('circle', { class: 'bal-ring-disc', cx: '122', cy: '122', r: '92' }));
    svg.appendChild(svgEl('circle', { class: 'bal-ring-track', cx: '122', cy: '122', r: String(R) }));
    var pieces = svgEl('g', { class: 'bal-ring-pieces', transform: 'rotate(-90 122 122)' });
    svg.appendChild(pieces);
    return { svg: svg, pieces: pieces, byKey: {} };
  }

  /* The pieces, from the priced coins in the order the list reads (largest
     first). Each is { key, usd, colour }. */
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
      var h = holdings[j];
      var value = Number(h.valueUsd);
      if (!isFinite(value) || value <= 0) continue;
      if (value / sum < SLIVER) {
        rest += value;
        continue;
      }
      out.push({ key: h.symbol, usd: value, colour: tintOf(h.symbol) });
    }
    if (rest > 0) out.push({ key: ':rest', usd: rest, colour: NEUTRAL });
    return out;
  }

  function paintRing(holdings) {
    var ring = refs.ring;
    if (!ring) return;
    var pieces = piecesOf(holdings);
    var sum = 0;
    for (var i = 0; i < pieces.length; i += 1) sum += pieces[i].usd;
    var still = reduced() || !ringDrawn;
    var intro = !ringDrawn && !reduced() && pieces.length > 0;
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
        node = svgEl('circle', { class: 'bal-ring-piece', cx: '122', cy: '122', r: String(R) });
        ring.byKey[piece.key] = node;
        /* A coin that arrives after the first draw grows out of its own place. */
        if (!intro && !still) setDash(node, 0.001, start, false);
      }
      node.style.stroke = piece.colour;
      if (node.parentNode !== ring.pieces || ring.pieces.children[k] !== node) ring.pieces.insertBefore(node, ring.pieces.children[k] || null);
      if (intro) {
        setDash(node, 0.001, start, false);
        growLater(node, dash, start, k * STAGGER_MS);
      } else {
        if (born && !still) forceStyle(node);
        setDash(node, dash, start, !still);
      }
      seen[piece.key] = true;
      at += len;
    }
    for (var key in ring.byKey) {
      if (!Object.prototype.hasOwnProperty.call(ring.byKey, key) || seen[key]) continue;
      shrinkAway(ring.byKey[key], still);
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

  /* The first draw: every piece at nothing on its own place, then, a frame
     later, each grows out to its share, a beat after the one before. */
  function growLater(node, dash, start, delay) {
    forceStyle(node);
    frame(function () {
      node.style.transition = '';
      node.style.transitionDelay = delay + 'ms';
      node.style.strokeDasharray = dash.toFixed(3) + ' ' + C.toFixed(3);
      node.style.strokeDashoffset = (-start).toFixed(3);
    });
  }

  function shrinkAway(node, still) {
    if (still || typeof node.getBoundingClientRect !== 'function') {
      if (node.parentNode) node.parentNode.removeChild(node);
      return;
    }
    var offset = node.style.strokeDashoffset;
    node.style.transition = '';
    node.style.strokeDasharray = '0.001 ' + C.toFixed(3);
    node.style.strokeDashoffset = offset;
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 1100);
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

  /* ---------- a coin's own colour ---------- */

  /* The coin's brand colour (marks.js), lifted so it reads on the charcoal:
     at least 64 percent lightness, never pure white. A green brand wears the
     neutral, and so does a coin with no colour of its own. */
  function tintOf(symbol) {
    var key = String(symbol || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(TINTS, key)) return TINTS[key];
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

  /* ---------- adding money ---------- */

  /* The steps take the list's place and the slab's height slides between the
     two (ui/design/motion.js); the ring steps back to a small one beside the
     total, so the steps have the room. Done fades the steps out first; they
     are torn down only once they are off screen, and the focus goes back to
     Add money. */
  function openSteps() {
    if (steps) return;
    if (window.PhosphorLazy) window.PhosphorLazy.load('qr');
    inPanel(null, function () {
      dom.setHidden(refs.list, true);
      dom.setHidden(refs.flow, false);
      dom.setAttr(refs.panel, 'data-flow', 'true');
      steps = window.PhosphorMoneyIn.render(refs.flowBody, { context: 'basic' }) || {};
      fitTotal();
      if (refs.title.focus) refs.title.focus();
    }, refs.flow);
  }

  function closeSteps() {
    if (!steps) return;
    var closing = steps;
    steps = null;
    inPanel(refs.flow, function () {
      if (typeof closing.destroy === 'function') closing.destroy();
      dom.clear(refs.flowBody);
      dom.setHidden(refs.flow, true);
      dom.setHidden(refs.list, false);
      dom.setAttr(refs.panel, 'data-flow', null);
      fitTotal();
      fitRows();
      if (refs.add.focus) refs.add.focus();
    }, refs.list);
  }

  function inPanel(leaving, change, shown) {
    var motion = window.PhosphorMotion;
    if (motion && typeof motion.swap === 'function') motion.swap(refs.panel, leaving, change, { fade: shown });
    else change();
  }

  /* ---------- render ---------- */

  function render() {
    if (!mounted || !store.loaded()) return;
    var basic = (store.get() || {}).basic || {};

    if (refs.totalSkel.parentNode) refs.totalSkel.parentNode.removeChild(refs.totalSkel);
    var hadTotal = refs.total.textContent;
    dom.setNumber(refs.total, basic.totalLine || '');
    dom.setHidden(refs.total, !basic.totalLine);
    if (filled && hadTotal && basic.totalLine && hadTotal !== basic.totalLine) lightHead();

    /* The words under the figure sit in the disc while they are a few words;
       a longer caption, or a whole sentence standing in for the figure, sits
       under the ring where it has a line's width. */
    var words = basic.caption || '';
    var outside = words.length > CAPTION_IN;
    var home = outside ? refs.under : refs.centre;
    if (refs.caption.parentNode !== home) home.appendChild(refs.caption);
    dom.setText(refs.caption, words);
    dom.setAttr(refs.caption, 'data-alone', basic.totalLine ? null : 'true');
    dom.setHidden(refs.under, !outside);

    var holdings = Array.isArray(basic.holdings) ? basic.holdings : [];
    dom.reconcile(refs.rows, holdings, keyOf, createRow, fillRow);
    filled = true;
    paintRing(holdings);

    dom.setText(refs.small, basic.smallLine || '');
    dom.setHidden(refs.small, !basic.smallLine);
    dom.setHidden(refs.foot, !basic.smallLine && refs.more.hidden);
    dom.setText(refs.empty, basic.emptyLine || '');
    dom.setHidden(refs.empty, !basic.emptyLine);
    /* An empty wallet's one thing to do is add money, so Add money is the slab's main key. */
    dom.setAttr(refs.panel, 'data-empty', basic.emptyLine && !holdings.length ? 'true' : null);

    fitTotal();
    fitRows();
  }

  /* The total stays inside the disc whatever its length: past what the disc
     holds at the full size, it steps down until it fits. */
  function fitTotal() {
    var total = refs.total;
    if (!total || typeof total.getBoundingClientRect !== 'function' || !refs.centre.getBoundingClientRect) return;
    total.style.removeProperty('--fit');
    var room = refs.centre.getBoundingClientRect().width;
    var need = total.scrollWidth;
    if (room > 0 && need > room) total.style.setProperty('--fit', (Math.floor(room / need * 100) / 100).toFixed(2));
  }

  /* The slab shows whole tiles only, never one cut by its edge: as many as it has room for,
     and under them how many more there are, which the list turns to a tile at a time. */
  function fitRows() {
    var scroll = refs.scroll;
    if (!scroll || refs.list.hidden || typeof refs.list.getBoundingClientRect !== 'function') return;
    var tiles = [];
    for (var i = 0; i < refs.rows.children.length; i += 1) {
      var tile = refs.rows.children[i];
      if (!tile.hidden && String(tile.className).indexOf('bal-row-skel') < 0) tiles.push(tile);
    }
    /* Measured without touching the scroller: the room is the slab's to give, the tiles keep
       their places, and a list half way through a turn stays where it is. The room box is only
       as tall as the tiles it shows (Add money follows them, basic.css), so what the slab gives
       is read off the list, which the slab sizes: its height less the keys and the gap over
       them. */
    var room = refs.list.getBoundingClientRect().height
      - refs.keys.getBoundingClientRect().height
      - (parseFloat(window.getComputedStyle(refs.keys).marginTop) || 0)
      - (parseFloat(window.getComputedStyle(refs.list).rowGap) || 0);
    dom.setHidden(refs.more, true);
    dom.setHidden(refs.foot, refs.small.hidden);
    if (!tiles.length || !(room > 0)) {
      scroll.style.removeProperty('height');
      shown = null;
      return paintMore();
    }

    var style = window.getComputedStyle(scroll);
    var pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    var lead = parseFloat(style.marginTop) || 0;
    var gap = parseFloat(window.getComputedStyle(refs.room).rowGap) || 0;
    var top = tiles[0].getBoundingClientRect().top;
    var reach = function (k) { return tiles[k - 1].getBoundingClientRect().bottom - top + pad + lead; };
    var pitch = tiles.length > 1 ? tiles[1].getBoundingClientRect().top - top : reach(1) - pad - lead;
    var footUsed = function () {
      if (refs.foot.hidden) return 0;
      return gap + (parseFloat(window.getComputedStyle(refs.foot).marginTop) || 0) + refs.foot.getBoundingClientRect().height;
    };

    var n = tiles.length;
    if (reach(n) + footUsed() > room + 0.5) {
      dom.setHidden(refs.more, false);
      dom.setHidden(refs.foot, false);
      var fits = room - footUsed();
      n = 1;
      while (n < tiles.length && reach(n + 1) <= fits + 0.5) n += 1;
    }
    var height = n < tiles.length ? (reach(n) - lead) + 'px' : '';
    if (scroll.style.height !== height) scroll.style.height = height;
    shown = { n: n, count: tiles.length, pitch: pitch };
    paintMore();
  }

  var fitAsked = false;

  function fitSoon() {
    if (fitAsked) return;
    fitAsked = true;
    window.requestAnimationFrame(function () {
      fitAsked = false;
      fitRows();
    });
  }

  /* The count of the tiles out of view, the way the list turns to them: down while there
     are more below, back up once the last is in view. */
  function paintMore() {
    var more = refs.more;
    if (!shown || shown.n >= shown.count) {
      dom.setHidden(more, true);
      return;
    }
    var first = Math.round(refs.scroll.scrollTop / shown.pitch);
    var below = Math.max(0, shown.count - shown.n - first);
    var up = below === 0;
    var count = up ? Math.min(first, shown.count - shown.n) : below;
    dom.setText(refs.moreLabel, '+' + count + ' more');
    dom.setAttr(more, 'data-dir', up ? 'up' : 'down');
    dom.setAttr(more, 'aria-label', up
      ? 'Show the ' + (count === 1 ? 'coin' : count + ' coins') + ' above'
      : 'Show ' + count + ' more ' + (count === 1 ? 'coin' : 'coins'));
    dom.setHidden(more, false);
  }

  function turnPage() {
    if (!shown) return;
    var scroll = refs.scroll;
    var down = refs.more.getAttribute('data-dir') !== 'up';
    var to = down ? scroll.scrollTop + shown.n * shown.pitch : 0;
    var still = !!(window.PhosphorMotion && window.PhosphorMotion.reduced && window.PhosphorMotion.reduced());
    if (typeof scroll.scrollTo === 'function') scroll.scrollTo({ top: to, behavior: still ? 'auto' : 'smooth' });
    else scroll.scrollTop = to;
  }

  function keyOf(holding) {
    return holding.symbol;
  }

  /* A tile: the coin's logo as its brand draws it, its symbol and how much of
     it on the left, the dollars on the right. The dollars wrap under the
     symbol, still at the right, when a long name and a large figure cannot
     share one line. */
  function createRow(holding) {
    var row = dom.el('li', 'bal-row');
    var mark = marks.logo(holding.symbol);
    mark.className += ' bal-coin';
    var body = dom.el('span', 'bal-body');
    var who = dom.el('span', 'bal-who');
    who.appendChild(dom.el('span', 'bal-sym'));
    who.appendChild(dom.el('span', 'bal-amt num tick'));
    body.appendChild(who);
    body.appendChild(dom.el('span', 'bal-usd num tick'));
    row.appendChild(mark);
    row.appendChild(body);
    var tint = tintOf(holding.symbol);
    row.style.setProperty('--tint', tint);
    /* The neutral is nearly white, so it washes in at half the strength. */
    if (tint === NEUTRAL) row.style.setProperty('--tint-share', '12%');
    /* A coin that arrives after the panel has drawn once is a tile that moved:
       it lights like one. The first fill of all is not a change. */
    if (filled) row.__shown = '';
    return row;
  }

  function fillRow(row, holding) {
    var body = row.children[1];
    var who = body.children[0];
    var usd = body.children[1];
    var priced = holding.valueLine !== null && holding.valueLine !== undefined;
    dom.setText(who.children[0], holding.symbol);
    dom.setAttr(who.children[0], 'title', holding.name && holding.name !== holding.symbol ? holding.name : null);
    dom.setNumber(who.children[1], holding.quantityLine);
    if (!priced) {
      dom.setText(usd, 'price unavailable');
    } else if (usd.getAttribute('data-unpriced') === 'true') {
      dom.setText(usd, holding.valueLine);
    } else {
      dom.setNumber(usd, holding.valueLine);
    }
    dom.setAttr(usd, 'data-unpriced', priced ? null : 'true');
    row.setAttribute('aria-label', [holding.name || holding.symbol, holding.quantityLine,
      priced ? holding.valueLine : 'price unavailable'].join(', '));
    light(row, holding);
  }

  function light(row, holding) {
    var shown = holding.quantityLine + '|' + (holding.valueLine || '');
    var had = row.__shown;
    row.__shown = shown;
    if (had === undefined || had === shown) return;
    lit(row);
  }

  function lightHead() {
    lit(refs.head);
  }

  function lit(node) {
    node.dataset.lit = 'true';
    if (node.__litTimer) window.clearTimeout(node.__litTimer);
    node.__litTimer = window.setTimeout(function () {
      delete node.dataset.lit;
      node.__litTimer = 0;
    }, GLOW_IN_MS);
  }

  window.PhosphorBasic = { boot: boot };
})();
