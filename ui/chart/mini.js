/* The comparison charts: one read-only canvas per slot 1 to 3, beside the primary.

   chart_layout puts up to four charts side by side. Slot 0 is the engine in
   ui/chart/chart.js, the one the human interacts with. The others are these:
   candles, the live price and its tag, the server's studies (on the price and
   in panes under it), its levels, and the lines and zones the agent drew on
   that slot, drawn from /api/chart?slot=n and nothing else. No
   drag, no zoom, no crosshair. A comparison chart is something to look at
   while the primary is worked on, and the one thing it must never do is
   disagree with the server about what is on it, which is why it holds no state
   of its own beyond the last payload.

   Nothing tells the window the layout as a list. A slot no layout has filled
   answers 404, so the window probes the three slots in order on boot and on a
   timer while any are up, stops at the first that is empty, and the grid
   follows: one chart fills the column, two sit side by side, three and four go
   two by two. The stage carries the count as data-n and the stylesheet draws
   the grid. A chart frame names its slot, so a frame for slot 1 to 3 fetches
   that one chart and nothing else: a 404 is a console line in the browser, and
   a probe on every frame of the primary would print one per frame.

   Plain browser script like the engine beside it: no imports, no framework,
   no hex of its own. The inks are the window's tokens, read once at boot. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var events = window.PhosphorEvents;

  var SLOT_MAX = 3;
  /* A write to one slot can arrive as a burst of frames. One fetch answers it. */
  var PROBE_MS = 50;
  /* Between frames a comparison chart still moves: the primary rides the live
     rail, these ride a timer. Five seconds keeps them within a bar of true, and
     the same pass is what notices a layout that shrank, since a slot that is
     gone sends no frame to say so. */
  var REFRESH_MS = 5000;
  /* The price axis is measured from its own labels each draw, with this floor. */
  var AXIS_MIN_W = 48;
  var AXIS_H = 16;
  var PAD_TOP = 10;
  var PRICE_PAD = 0.06;
  /* The sub-panes, budgeted like the primary's (chart.js buildLayout) at a comparison chart's
     size: volume goes first when the price would get too short, then studies off the bottom. */
  var PRICE_MIN = 80;
  var PRICE_SHARE = 0.4;
  var PANE_MIN = 36;
  var PANE_MAX = 96;
  var TAG_H = 16;
  var LEGEND_PITCH = 14;
  var FONT = '11px "Geist", ui-sans-serif, system-ui, sans-serif';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* The tokens' shipped values (ui/design/tokens.css), for the frame drawn
     before the stylesheet is read. */
  var tokens = {
    bg0: '#161210',
    bg1: '#1e1917',
    line: '#302a26',
    text: '#f8f0e8',
    text2: '#bcaea1',
    text3: '#9a8c7f',
    up: '#52e893',
    down: '#ff6b5b',
    agent: '#B79CFF',
    warn: '#F5B942',
    // The studies' hues, the primary's own (--study-1 to --study-5).
    study1: '#7EB6F6',
    study2: '#F2A47C',
    study3: '#EADCC8',
    study4: '#EC8DBB',
    study5: '#5CC8D6'
  };
  var STUDIES = ['study1', 'study2', 'study3', 'study4', 'study5'];

  /* Figures in the engine's tabular Geist (chart.js chartText), or plain canvas text where the
     engine is not loaded. */
  function text(ctx, words, x, y) {
    var t = window.chartText;
    if (t && typeof t.draw === 'function') t.draw(ctx, words, x, y);
    else ctx.fillText(words, x, y);
  }

  function textWidth(ctx, words) {
    var t = window.chartText;
    return t && typeof t.width === 'function' ? t.width(ctx, words) : ctx.measureText(words).width;
  }

  var stage = null;
  var minis = {};
  var booted = false;
  var pending = {};
  var probing = false;
  var probeAgain = false;

  function boot() {
    if (booted) return;
    stage = document.getElementById('panel-chart');
    if (!stage) return;
    booted = true;
    readTokens();
    if (events) events.on('chart', onChart);
    window.setInterval(function () {
      if (count() > 0) void probe();
    }, REFRESH_MS);
    void probe();
  }

  function readTokens() {
    if (typeof window.getComputedStyle !== 'function' || !document.documentElement) return;
    var style = window.getComputedStyle(document.documentElement);
    var names = { bg0: 'bg-0', bg1: 'bg-1', line: 'line', text: 'text', text2: 'text-2', text3: 'text-3', up: 'up', down: 'down', agent: 'agent', warn: 'warn', study1: 'study-1', study2: 'study-2', study3: 'study-3', study4: 'study-4', study5: 'study-5' };
    for (var key in names) {
      if (!Object.prototype.hasOwnProperty.call(names, key)) continue;
      var value = String(style.getPropertyValue('--' + names[key]) || '').trim();
      if (value) tokens[key] = value;
    }
  }

  function count() {
    var n = 0;
    for (var slot = 1; slot <= SLOT_MAX; slot += 1) if (minis[slot]) n += 1;
    return n;
  }

  /* ---------- the slots ---------- */

  /* A frame for one of the comparison slots. The primary's frames (slot 0, or
     a frame from before slots existed) are the engine's business. */
  function onChart(frame) {
    var slot = frame && typeof frame.slot === 'number' ? frame.slot : 0;
    if (slot < 1 || slot > SLOT_MAX) return;
    if (pending[slot]) return;
    pending[slot] = window.setTimeout(function () {
      delete pending[slot];
      void fetchSlot(slot);
    }, PROBE_MS);
  }

  function fetchSlot(slot) {
    return net.getJson('/api/chart?slot=' + slot).then(function (result) {
      if (result.fresh || !minis[slot]) apply(slot, result.data);
      settle();
    }, function (err) {
      if (err && err.status === 404 && minis[slot]) {
        remove(slot);
        settle();
      }
    });
  }

  /* Slot by slot, in order, until one answers 404: the server truncates its
     slot list on a layout, so the first empty slot is the end of the layout. A
     probe that finds the chain already running asks for one more pass rather
     than racing it, so two answers can never land out of order. */
  function probe() {
    if (probing) {
      probeAgain = true;
      return Promise.resolve();
    }
    probing = true;
    var found = [];
    function step(slot) {
      if (slot > SLOT_MAX) return finish(found, true);
      return net.getJson('/api/chart?slot=' + slot).then(function (result) {
        found.push(slot);
        if (result.fresh || !minis[slot]) apply(slot, result.data);
        return step(slot + 1);
      }, function (err) {
        /* 404 is the layout's edge. Anything else is the app not answering,
           and a chart that is on screen stays on screen until it does. */
        return finish(found, !!(err && err.status === 404));
      });
    }
    return step(1).then(function () {
      probing = false;
      if (probeAgain) {
        probeAgain = false;
        return probe();
      }
      return undefined;
    });
  }

  function finish(found, settled) {
    if (settled) {
      for (var slot = 1; slot <= SLOT_MAX; slot += 1) {
        if (found.indexOf(slot) < 0 && minis[slot]) remove(slot);
      }
    }
    settle();
    return Promise.resolve();
  }

  function settle() {
    if (stage) stage.dataset.n = String(1 + count());
  }

  function create(slot) {
    var node = dom.el('div', 'mini');
    node.dataset.slot = String(slot);
    var head = dom.el('div', 'mini-head');
    var coin = dom.el('span', 'mini-coin');
    var tf = dom.el('span', 'mini-tf');
    var last = dom.el('span', 'mini-last mono');
    head.appendChild(coin);
    head.appendChild(tf);
    head.appendChild(last);
    var body = dom.el('div', 'mini-body');
    var canvas = dom.el('canvas', 'mini-canvas');
    body.appendChild(canvas);
    node.appendChild(head);
    node.appendChild(body);

    /* In slot order after the primary, whatever order the answers arrived. */
    var before = null;
    for (var next = slot + 1; next <= SLOT_MAX && !before; next += 1) {
      if (minis[next]) before = minis[next].node;
    }
    if (before) stage.insertBefore(node, before);
    else stage.appendChild(node);

    var m = { slot: slot, node: node, coin: coin, tf: tf, last: last, body: body, canvas: canvas, payload: null };
    if (window.ResizeObserver) {
      m.observer = new window.ResizeObserver(function () { draw(m); });
      m.observer.observe(body);
    }
    minis[slot] = m;
    return m;
  }

  function remove(slot) {
    var m = minis[slot];
    if (!m) return;
    if (m.observer) m.observer.disconnect();
    if (m.node.parentNode) m.node.parentNode.removeChild(m.node);
    delete minis[slot];
  }

  function apply(slot, payload) {
    if (!payload || typeof payload !== 'object') return;
    var m = minis[slot] || create(slot);
    m.payload = payload;
    var view = payload.view || {};
    dom.setText(m.coin, String(view.product || '').split('-')[0].toUpperCase() || '--');
    dom.setText(m.tf, timeframeLabel(payload));
    var candles = Array.isArray(payload.candles) ? payload.candles : [];
    var last = candles.length ? candles[candles.length - 1] : null;
    dom.setText(m.last, last ? priceText(last.c, decimalsOf(last.c)) : '--');
    draw(m);
  }

  function timeframeLabel(payload) {
    var sec = payload.view ? Number(payload.view.granularitySec) : NaN;
    var list = Array.isArray(payload.timeframes) ? payload.timeframes : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].sec === sec) return String(list[i].label);
    }
    if (!isFinite(sec)) return '';
    if (sec === 2629746) return '1M';
    if (sec % 604800 === 0) return sec / 604800 + 'w';
    if (sec % 86400 === 0) return sec / 86400 + 'd';
    if (sec % 3600 === 0) return sec / 3600 + 'h';
    if (sec % 60 === 0) return sec / 60 + 'm';
    return sec + 's';
  }

  /* ---------- the picture ---------- */

  function decimalsOf(price) {
    var abs = Math.abs(Number(price));
    if (!isFinite(abs)) return 2;
    if (abs >= 1) return 2;
    if (abs >= 0.01) return 4;
    return 6;
  }

  function priceText(value, decimals) {
    var n = Number(value);
    if (!isFinite(n)) return '--';
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  /* The three stamps under a comparison chart: the first always names its day, and
     a later one names its day again only when it is a different day, so three times
     of day across a week of 4h bars can never read as one afternoon. Intraday bars
     are read on the person's clock; a daily bar is the venue's day, in UTC, like the
     engine's own axis (ui/chart/chart.js). */
  function stampOf(tSec, granularity, firstSec) {
    var utc = granularity >= 86400;
    var d = new Date(tSec * 1000);
    var f = new Date(firstSec * 1000);
    var y = utc ? d.getUTCFullYear() : d.getFullYear();
    var m = utc ? d.getUTCMonth() : d.getMonth();
    var day = (utc ? d.getUTCDate() : d.getDate()) + ' ' + MONTHS[m];
    var sameDay = utc
      ? d.getUTCFullYear() === f.getUTCFullYear() && d.getUTCMonth() === f.getUTCMonth() && d.getUTCDate() === f.getUTCDate()
      : d.getFullYear() === f.getFullYear() && d.getMonth() === f.getMonth() && d.getDate() === f.getDate();
    if (granularity >= 2629746) return MONTHS[m] + ' ' + y;
    if (granularity >= 86400) return tSec === firstSec || y !== f.getUTCFullYear() ? day + ' ' + y : day;
    var hh = utc ? d.getUTCHours() : d.getHours();
    var mm = utc ? d.getUTCMinutes() : d.getMinutes();
    var time = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    return tSec === firstSec || !sameDay ? day + ' ' + time : time;
  }

  /* A token at a strength. ui/theme.js writes the themed tokens as rgb(r, g, b), not hex, so
     both are read here: a colour this could not parse used to come back whole, which drew
     every wash and chip ground at full strength over the candles. */
  function alpha(color, a) {
    var value = String(color).trim();
    var hex = /^#?([0-9a-f]{6})$/i.exec(value);
    if (hex) {
      var n = parseInt(hex[1], 16);
      return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
    }
    var rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(value);
    if (rgb) return 'rgba(' + rgb[1] + ', ' + rgb[2] + ', ' + rgb[3] + ', ' + a + ')';
    return value;
  }

  function hair(value, dpr) {
    return Math.round(value * dpr) / dpr + 0.5 / dpr;
  }

  function draw(m) {
    var body = m.body;
    var canvas = m.canvas;
    var payload = m.payload;
    if (!payload) return;
    var w = body.clientWidth;
    var h = body.clientHeight;
    if (!w || !h) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* The mini sits on its own tile (trade.css .mini): the canvas lets it show. */
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;

    var candles = Array.isArray(payload.candles) ? payload.candles : [];
    if (!candles.length) {
      ctx.fillStyle = tokens.text3;
      text(ctx, payload.meta && payload.meta.error ? 'No candles' : 'Waiting for candles', 8, 16);
      return;
    }

    var view = payload.view || {};
    var granularity = Number(view.granularitySec) || 60;
    var want = Math.max(10, Math.min(candles.length, Number(view.barCount) || 120));
    var start = candles.length - want;
    var end = candles.length - 1;

    var studies = Array.isArray(payload.indicators) ? payload.indicators : [];
    var overlays = [];
    var own = [];
    var hasVolume = false;
    for (var si = 0; si < studies.length; si += 1) {
      var study = studies[si];
      if (!study || !Array.isArray(study.plots)) continue;
      if (study.pane === 'price') overlays.push(study);
      else own.push(study);
      if (isVolumeStudy(study)) hasVolume = true;
    }

    var lo = Infinity;
    var hi = -Infinity;
    for (var i = start; i <= end; i += 1) {
      if (candles[i].l < lo) lo = candles[i].l;
      if (candles[i].h > hi) hi = candles[i].h;
    }
    if (!isFinite(lo) || !isFinite(hi)) return;
    // An overlay that leaves the candles is still fitted, as on the primary: a study the
    // agent added must never be off the glass.
    for (var o = 0; o < overlays.length; o += 1) {
      for (var op = 0; op < overlays[o].plots.length; op += 1) {
        var ov = overlays[o].plots[op].values || [];
        for (var ok = start; ok <= end; ok += 1) {
          if (typeof ov[ok] !== 'number' || !isFinite(ov[ok])) continue;
          if (ov[ok] < lo) lo = ov[ok];
          if (ov[ok] > hi) hi = ov[ok];
        }
      }
    }
    var span = hi - lo || Math.abs(hi) * 0.01 || 1;
    lo -= span * PRICE_PAD;
    hi += span * PRICE_PAD;
    span = hi - lo;

    /* The sub-panes under the price, the primary's budget at this size. */
    var usable = h - AXIS_H - PAD_TOP;
    var volume = !hasVolume && volumeOn() ? volumeStudy(candles) : null;
    var paneH = Math.max(PANE_MIN, Math.min(PANE_MAX, usable * 0.19));
    var volumeH = volume ? Math.max(28, Math.min(PANE_MAX, usable * 0.14)) : 0;
    var paneCount = own.length;
    var priceMin = Math.max(PRICE_MIN, usable * PRICE_SHARE);
    if (volume && usable - volumeH - paneCount * paneH < priceMin) {
      volume = null;
      volumeH = 0;
    }
    while (paneCount > 0 && usable - volumeH - paneCount * paneH < priceMin) paneCount -= 1;
    var hidden = own.length - paneCount;
    var shown = own.slice(0, paneCount);
    if (volume) shown.unshift(volume);

    var top = PAD_TOP;
    var plotH = usable - volumeH - paneCount * paneH;
    var bottom = top + plotH;
    var panes = [];
    var paneTop = bottom;
    for (var pi = 0; pi < shown.length; pi += 1) {
      var ph = shown[pi] === volume ? volumeH : paneH;
      panes.push(paneOf(shown[pi], paneTop, ph, start, end));
      paneTop += ph;
    }
    var floor = paneTop;

    var decimals = decimalsOf(hi);
    var lastBar = candles[end];
    /* The axis is as wide as its widest label, the price tag and the panes' scales among
       them, so a four figure price with cents is never clipped at the edge of a narrow cell. */
    var axisW = AXIS_MIN_W;
    var widest = [priceText(lastBar.c, decimalsOf(lastBar.c))];
    for (var g0 = 0; g0 <= 3; g0 += 1) widest.push(priceText(lo + (span * g0) / 3, decimals));
    for (var pw = 0; pw < panes.length; pw += 1) widest = widest.concat(panes[pw].labels);
    for (var wi = 0; wi < widest.length; wi += 1) {
      var labelW = textWidth(ctx, widest[wi]) + 12;
      if (labelW > axisW) axisW = labelW;
    }
    var plotW = w - axisW;
    var slot = plotW / want;
    function xOf(index) {
      return (index - start + 0.5) * slot;
    }
    function yOf(price) {
      return top + ((hi - price) / span) * plotH;
    }

    /* The price grid; its labels go on after the chips and the tag are placed. */
    ctx.strokeStyle = alpha(tokens.line, 0.9);
    for (var g = 0; g <= 3; g += 1) {
      var gy = hair(yOf(lo + (span * g) / 3), dpr);
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(plotW, gy);
      ctx.stroke();
    }

    /* The time axis under the last pane: the first bar, the middle one and the last. The
       middle one is left out when the cell is too narrow to hold it clear of the others. */
    ctx.fillStyle = tokens.text3;
    var stamps = [start, Math.round((start + end) / 2), end];
    var firstW = textWidth(ctx, stampOf(candles[start].t, granularity, candles[start].t));
    var lastW = textWidth(ctx, stampOf(candles[end].t, granularity, candles[start].t));
    for (var s = 0; s < stamps.length; s += 1) {
      var label = stampOf(candles[stamps[s]].t, granularity, candles[start].t);
      var tx = xOf(stamps[s]);
      if (s === 1) {
        var half = textWidth(ctx, label) / 2 + 8;
        if (tx - half < Math.max(2, xOf(start)) + firstW || tx + half > Math.min(plotW - 2, xOf(end)) - lastW) continue;
      }
      ctx.textAlign = s === 0 ? 'left' : s === stamps.length - 1 ? 'right' : 'center';
      text(ctx, label, s === 0 ? Math.max(2, tx) : s === stamps.length - 1 ? Math.min(plotW - 2, tx) : tx, floor + AXIS_H / 2 + 1);
    }
    ctx.textAlign = 'left';

    // Under the candles: the zones, then the overlays' bands.
    drawZones(ctx, payload, xOf, yOf, top, bottom, plotW, dpr);
    drawBands(ctx, overlays, start, end, xOf, yOf, top, bottom, plotW);
    drawCandles(ctx, candles, start, end, xOf, yOf, slot, dpr);
    drawOverlays(ctx, overlays, start, end, xOf, yOf, top, bottom, plotW);
    drawPanes(ctx, panes, start, end, xOf, slot, plotW, dpr);
    var chips = [];
    drawLevels(ctx, payload, yOf, top, bottom, plotW, dpr, chips);
    drawLines(ctx, payload, candles, granularity, start, slot, yOf, top, bottom, plotW, chips);

    /* The live price, as the primary draws it: a dotted guide across the plot and the one
       filled tag on the axis, in the direction of the bar, carrying the price. */
    var up = lastBar.c >= lastBar.o;
    var lastY = yOf(lastBar.c);
    if (lastY >= top && lastY <= bottom) {
      ctx.strokeStyle = up ? alpha(tokens.up, 0.55) : alpha(tokens.down, 0.6);
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(0, hair(lastY, dpr));
      ctx.lineTo(plotW, hair(lastY, dpr));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    var tagY = Math.max(top + TAG_H / 2, Math.min(bottom - TAG_H / 2, lastY));

    var taken = [{ top: tagY - TAG_H / 2 - 1, bottom: tagY + TAG_H / 2 + 1 }];
    // The first pane's own scale sits just under the price; the price's lowest label gives way.
    if (panes.length) taken.push({ top: bottom - 4, bottom: bottom + 14 });
    var placed = placeChips(chips, top, bottom, taken);
    ctx.fillStyle = tokens.text3;
    for (var gl = 0; gl <= 3; gl += 1) {
      var price = lo + (span * gl) / 3;
      var ly = Math.max(top + 6, Math.min(bottom - 6, yOf(price)));
      if (clashes(taken, ly - 6, ly + 6)) continue;
      text(ctx, priceText(price, decimals), plotW + 6, ly);
    }
    drawChips(ctx, placed, plotW, w, decimals);

    var tagTop = Math.round(tagY - TAG_H / 2);
    ctx.fillStyle = up ? tokens.up : tokens.down;
    ctx.fillRect(plotW + 1, tagTop, axisW - 1, TAG_H);
    ctx.fillStyle = tokens.bg0;
    text(ctx, priceText(lastBar.c, decimalsOf(lastBar.c)), plotW + 5, tagTop + TAG_H / 2);

    drawLegend(ctx, overlays, end, top, bottom, plotW, decimals, hidden, own.slice(paneCount));
  }

  /* ---------- the studies ---------- */

  function volumeOn() {
    try {
      return window.localStorage.getItem('phosphor.chart.volume') !== '0';
    } catch (err) {
      return true;
    }
  }

  function isVolumeStudy(ind) {
    if (!ind || ind.pane === 'price') return false;
    return String(ind.label || ind.id || '').toLowerCase().indexOf('volume') === 0;
  }

  /* The volume pane the primary shows unasked (chart.js volumeIndicator), from these candles. */
  function volumeStudy(candles) {
    var values = new Array(candles.length);
    var signs = new Array(candles.length);
    var any = false;
    for (var i = 0; i < candles.length; i += 1) {
      var bar = candles[i];
      values[i] = typeof bar.v === 'number' && isFinite(bar.v) ? bar.v : null;
      if (values[i] !== null) any = true;
      signs[i] = bar.c >= bar.o ? 1 : -1;
    }
    if (!any) return null;
    return { id: 'volume', label: 'volume', pane: 'own', plots: [{ key: 'v', style: 'histogram', values: values, signs: signs }] };
  }

  /* One pane's scale, from its fixed range or from what is in view, as the primary fits it. */
  function paneOf(ind, top, height, start, end) {
    var lo = Infinity;
    var hi = -Infinity;
    var plots = ind.plots || [];
    var guides = Array.isArray(ind.guides) ? ind.guides : [];
    if (Array.isArray(ind.range)) {
      lo = ind.range[0];
      hi = ind.range[1];
    } else {
      var histogram = false;
      for (var p = 0; p < plots.length; p += 1) {
        if (plots[p].style === 'histogram') histogram = true;
        var values = plots[p].values || [];
        for (var k = start; k <= end; k += 1) {
          if (typeof values[k] !== 'number' || !isFinite(values[k])) continue;
          if (values[k] < lo) lo = values[k];
          if (values[k] > hi) hi = values[k];
        }
      }
      for (var g = 0; g < guides.length; g += 1) {
        if (guides[g].value < lo) lo = guides[g].value;
        if (guides[g].value > hi) hi = guides[g].value;
      }
      if (histogram) {
        if (lo > 0) lo = 0;
        if (hi < 0) hi = 0;
      }
      if (!isFinite(lo) || !isFinite(hi)) {
        lo = 0;
        hi = 1;
      }
      if (!(hi > lo)) hi = lo + Math.max(1e-8, Math.abs(lo) * 0.01);
      var floored = lo === 0;
      var margin = (hi - lo) * 0.08;
      lo -= margin;
      hi += margin;
      if (floored) lo = 0;
    }
    var labels = [];
    if (!Array.isArray(ind.range)) labels.push(paneText(hi), paneText(lo));
    for (var gl = 0; gl < guides.length; gl += 1) labels.push(String(guides[gl].label));
    return {
      ind: ind,
      top: top,
      height: height,
      low: lo,
      high: hi,
      labels: labels,
      yOf: function (v) {
        var span = hi - lo;
        if (!(span > 0)) return top + height / 2;
        return top + ((hi - v) / span) * height;
      }
    };
  }

  /* Pane figures grouped by size, the primary's rule (chart.js paneText). */
  function paneText(value) {
    if (value === null || value === undefined || !isFinite(value)) return '--';
    if (value === 0) return '0';
    var abs = Math.abs(value);
    if (abs >= 1e9) return priceText(value / 1e9, 2) + 'B';
    if (abs >= 1e6) return priceText(value / 1e6, 2) + 'M';
    if (abs >= 1000) return priceText(value, 0);
    if (abs >= 100) return priceText(value, 1);
    if (abs >= 1) return priceText(value, 2);
    return priceText(value, 4);
  }

  /* A plot's ink and weight, the primary's three tiers (chart.js plotInk): a custom study's
     named token wins over the hue. */
  var PLOT_WIDTH = [1.5, 1, 1];
  var PLOT_ALPHA = [0.95, 0.72, 0.5];
  function plotTier(plot) {
    var e = plot && typeof plot.emphasis === 'number' ? plot.emphasis : 0.8;
    return e >= 0.85 ? 0 : e >= 0.5 ? 1 : 2;
  }
  function toneInk(tone) {
    if (tone === 'up' || tone === 'ink') return tokens.up;
    if (tone === 'down') return tokens.down;
    if (tone === 'agent') return tokens.agent;
    if (tone === 'warn') return tokens.warn;
    if (tone === 'text2') return tokens.text2;
    return tokens.text;
  }
  function hueOf(index) {
    return tokens[STUDIES[index % STUDIES.length]];
  }
  function plotInk(plot, hue, scale) {
    var a = PLOT_ALPHA[plotTier(plot)] * (scale === undefined ? 1 : scale);
    return alpha(typeof plot.tone === 'string' ? toneInk(plot.tone) : hueOf(hue), a);
  }

  function valueInk(plot, hue) {
    return alpha(typeof plot.tone === 'string' ? toneInk(plot.tone) : hueOf(hue), 0.95);
  }

  /* A study's name as the primary prints it (chart.js labelText): the server's [agent] tag
     comes off and the agent's violet says it instead. */
  function labelText(label) {
    var words = String(label || '');
    if (words.indexOf('[agent] ') === 0) words = words.slice(8);
    else if (words.indexOf('[agent]') === 0) words = words.slice(7).replace(/^\s+/, '');
    if (words.slice(-8) === ' [agent]') words = words.slice(0, -8);
    return words;
  }

  function studyName(ind) {
    return { words: labelText(ind.label || ind.type), ink: ind.source === 'agent' ? alpha(tokens.agent, 0.95) : alpha(tokens.text2, 0.95) };
  }

  function strokeSeries(ctx, values, start, end, xOf, yOf) {
    ctx.beginPath();
    var pen = false;
    for (var k = start; k <= end; k += 1) {
      var v = values[k];
      if (v === null || v === undefined || !isFinite(v)) {
        pen = false;
        continue;
      }
      if (!pen) {
        ctx.moveTo(xOf(k), yOf(v));
        pen = true;
      } else {
        ctx.lineTo(xOf(k), yOf(v));
      }
    }
    ctx.stroke();
  }

  /* The owner's ink: the agent's violet, the person's text. */
  function ownerInk(source) {
    return source === 'agent' ? tokens.agent : tokens.text;
  }

  /* A marking's name on this small canvas is its price, in a soft chip on the axis beside its
     line, in the owner's ink, the way the primary docks it: nothing is printed over the candles.
     Chips that would overlap the one above, or the price tag, are left out, the lower price
     first. */
  var CHIP_H = 15;
  function clashes(taken, a, b) {
    for (var i = 0; i < taken.length; i += 1) {
      if (a < taken[i].bottom && b > taken[i].top) return true;
    }
    return false;
  }

  function placeChips(chips, top, bottom, taken) {
    chips.sort(function (a, b) {
      return a.y - b.y;
    });
    var placed = [];
    for (var i = 0; i < chips.length; i += 1) {
      var y = Math.max(top + CHIP_H / 2, Math.min(bottom - CHIP_H / 2, chips[i].y));
      if (clashes(taken, y - CHIP_H / 2 - 1, y + CHIP_H / 2 + 1)) continue;
      taken.push({ top: y - CHIP_H / 2 - 1, bottom: y + CHIP_H / 2 + 1 });
      placed.push({ y: y, price: chips[i].price, ink: chips[i].ink });
    }
    return placed;
  }

  function drawChips(ctx, chips, plotW, w, decimals) {
    var h = CHIP_H;
    for (var i = 0; i < chips.length; i += 1) {
      var y = chips[i].y;
      var x = plotW + 2;
      var cw = w - plotW - 3;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y - h / 2, cw, h, 5);
      else ctx.rect(x, y - h / 2, cw, h);
      ctx.fillStyle = alpha(tokens.bg1, 0.94);
      ctx.fill();
      ctx.fillStyle = alpha(chips[i].ink, 0.16);
      ctx.fill();
      ctx.fillStyle = chips[i].ink;
      text(ctx, priceText(chips[i].price, decimals), plotW + 6, y);
    }
  }

  function drawCandles(ctx, candles, start, end, xOf, yOf, slot, dpr) {
    var bodyW = Math.max(1, Math.min(slot * 0.62, 9));
    for (var i = start; i <= end; i += 1) {
      var c = candles[i];
      var up = c.c >= c.o;
      var ink = up ? tokens.up : tokens.down;
      var x = xOf(i);
      ctx.strokeStyle = alpha(ink, 0.9);
      ctx.beginPath();
      ctx.moveTo(hair(x, dpr), yOf(c.h));
      ctx.lineTo(hair(x, dpr), yOf(c.l));
      ctx.stroke();
      var y0 = yOf(Math.max(c.o, c.c));
      var y1 = yOf(Math.min(c.o, c.c));
      ctx.fillStyle = up ? alpha(ink, 0.9) : alpha(ink, 0.85);
      ctx.fillRect(x - bodyW / 2, y0, bodyW, Math.max(1, y1 - y0));
    }
  }

  /* A band study's range (Bollinger, Keltner, VWAP bands) washed faintly in its hue, under
     the candles, the primary's strength (chart.js drawOverlayBands). */
  function drawBands(ctx, overlays, start, end, xOf, yOf, top, bottom, plotW) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, plotW, bottom - top);
    ctx.clip();
    for (var i = 0; i < overlays.length; i += 1) {
      var plots = overlays[i].plots;
      for (var p = 0; p < plots.length; p += 1) {
        var plot = plots[p];
        if (plot.style !== 'band' || !plot.fillTo || !Array.isArray(plot.values)) continue;
        var other = null;
        for (var q = 0; q < plots.length; q += 1) if (plots[q].key === plot.fillTo) other = plots[q];
        if (!other || !Array.isArray(other.values)) continue;
        ctx.fillStyle = alpha(typeof plot.tone === 'string' ? toneInk(plot.tone) : hueOf(i), 0.06);
        ctx.beginPath();
        var open = false;
        var k;
        for (k = start; k <= end; k += 1) {
          var hiV = plot.values[k];
          if (typeof hiV !== 'number' || !isFinite(hiV)) continue;
          if (!open) ctx.moveTo(xOf(k), yOf(hiV));
          else ctx.lineTo(xOf(k), yOf(hiV));
          open = true;
        }
        if (!open) continue;
        for (k = end; k >= start; k -= 1) {
          var loV = other.values[k];
          if (typeof loV !== 'number' || !isFinite(loV)) continue;
          ctx.lineTo(xOf(k), yOf(loV));
        }
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /* The price overlays, each study in its hue by its place, as on the primary; past five the
     hues come round dashed. */
  function drawOverlays(ctx, overlays, start, end, xOf, yOf, top, bottom, plotW) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, plotW, bottom - top);
    ctx.clip();
    ctx.lineCap = 'round';
    for (var i = 0; i < overlays.length; i += 1) {
      var plots = overlays[i].plots;
      ctx.setLineDash(i >= STUDIES.length ? [5, 3] : []);
      for (var p = 0; p < plots.length; p += 1) {
        var plot = plots[p];
        if (plot.style === 'histogram' || !Array.isArray(plot.values)) continue;
        ctx.lineWidth = PLOT_WIDTH[plotTier(plot)];
        ctx.strokeStyle = plotInk(plot, i);
        strokeSeries(ctx, plot.values, start, end, xOf, yOf);
      }
    }
    ctx.restore();
    ctx.lineWidth = 1;
  }

  /* The sub-panes, drawn the way the primary draws them (chart.js drawPanes): a rule on top,
     the guides with the stretch between two of them washed, each line in its own hue, a
     histogram as the quiet layer, the scale at the edges when there is no fixed range, and
     the study's name and last values in its top corner. */
  function drawPanes(ctx, panes, start, end, xOf, slot, plotW, dpr) {
    for (var i = 0; i < panes.length; i += 1) {
      var pane = panes[i];
      var ind = pane.ind;
      var guides = Array.isArray(ind.guides) ? ind.guides : [];
      var inside = function (y) {
        return y >= pane.top + 2 && y <= pane.top + pane.height - 2;
      };

      ctx.strokeStyle = tokens.line;
      ctx.beginPath();
      ctx.moveTo(0, hair(pane.top, dpr));
      ctx.lineTo(plotW, hair(pane.top, dpr));
      ctx.stroke();

      if (Array.isArray(ind.range) && guides.length === 2) {
        var ga = pane.yOf(guides[0].value);
        var gb = pane.yOf(guides[1].value);
        ctx.fillStyle = alpha(tokens.text2, 0.035);
        ctx.fillRect(0, Math.min(ga, gb), plotW, Math.abs(gb - ga));
      }
      /* The scale's two edges first, then each guide's figure where it clears them and the
         one above: a short pane keeps its lines and drops the figures it cannot fit. */
      var used = [];
      if (!Array.isArray(ind.range)) {
        used.push({ top: pane.top + 1, bottom: pane.top + 13 }, { top: pane.top + pane.height - 12, bottom: pane.top + pane.height });
      }
      ctx.strokeStyle = alpha(tokens.line, 0.9);
      ctx.fillStyle = alpha(tokens.text2, 0.7);
      for (var g = 0; g < guides.length; g += 1) {
        var gy = pane.yOf(guides[g].value);
        if (!inside(gy)) continue;
        ctx.beginPath();
        ctx.moveTo(0, hair(gy, dpr));
        ctx.lineTo(plotW, hair(gy, dpr));
        ctx.stroke();
        if (clashes(used, gy - 6, gy + 6)) continue;
        used.push({ top: gy - 6, bottom: gy + 6 });
        text(ctx, String(guides[g].label), plotW + 6, gy);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, pane.top, plotW, pane.height);
      ctx.clip();
      var plots = ind.plots || [];
      var hue = 0;
      var hues = [];
      ctx.lineCap = 'round';
      for (var p = 0; p < plots.length; p += 1) {
        var plot = plots[p];
        if (!Array.isArray(plot.values)) continue;
        if (plot.style === 'histogram') {
          drawHistogram(ctx, pane, plot, start, end, xOf, slot);
          hues.push(-1);
          continue;
        }
        ctx.lineWidth = PLOT_WIDTH[plotTier(plot)];
        ctx.strokeStyle = plotInk(plot, hue);
        hues.push(hue);
        hue += 1;
        strokeSeries(ctx, plot.values, start, end, xOf, pane.yOf);
      }
      ctx.restore();
      ctx.lineWidth = 1;

      if (!Array.isArray(ind.range)) {
        ctx.fillStyle = alpha(tokens.text2, 0.7);
        text(ctx, paneText(pane.high), plotW + 6, pane.top + 7);
        text(ctx, paneText(pane.low), plotW + 6, pane.top + pane.height - 6);
      }

      // The name, then each plot's last value in the ink it is drawn in (chart.js studyParts).
      var parts = [studyName(ind)];
      for (var v = 0; v < plots.length; v += 1) {
        var values = plots[v].values || [];
        var last = values[end];
        if (typeof last !== 'number' || !isFinite(last)) continue;
        parts.push({ words: paneText(last), ink: valueInk(plots[v], hues[v] > 0 ? hues[v] : 0) });
      }
      drawLabel(ctx, parts, 6, pane.top + 9, plotW - 12);
    }
  }

  /* A signed histogram (MACD) draws from zero in the direction's ink; a magnitude one (volume)
     draws from the floor and takes its colour from the bar beside it. */
  function drawHistogram(ctx, pane, plot, start, end, xOf, slot) {
    var width = Math.max(1, Math.floor(slot * 0.6));
    var base = pane.yOf(Math.max(pane.low, Math.min(pane.high, 0)));
    var signs = plot.signs;
    var sets = plot.signed === true || signs ? [1, -1] : [1];
    for (var s = 0; s < sets.length; s += 1) {
      var sign = sets[s];
      ctx.fillStyle = sets.length === 1 ? alpha(tokens.text2, 0.3) : sign > 0 ? alpha(tokens.up, 0.3) : alpha(tokens.down, 0.34);
      ctx.beginPath();
      for (var i = start; i <= end; i += 1) {
        var v = plot.values[i];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        var direction = signs ? (signs[i] >= 0 ? 1 : -1) : v >= 0 ? 1 : -1;
        if (sets.length > 1 && direction !== sign) continue;
        var y = pane.yOf(v);
        var top = Math.min(y, base);
        ctx.rect(Math.round(xOf(i) - width / 2), Math.round(top), width, Math.max(1, Math.round(Math.abs(base - y))));
      }
      ctx.fill();
    }
  }

  /* One line of words in several inks on the panel's own ground, so a legend over the
     candles reads (chart.js chartLabelPad). Cut at the plot's edge. */
  function drawLabel(ctx, parts, x, y, room) {
    var gap = 5;
    var widths = [];
    var total = 0;
    var n = 0;
    for (var i = 0; i < parts.length; i += 1) {
      var pw = textWidth(ctx, parts[i].words);
      if (total + pw > room && n > 0) break;
      widths.push(pw);
      total += pw + (n > 0 ? gap : 0);
      n += 1;
    }
    if (!n) return;
    ctx.fillStyle = alpha(tokens.bg1, 0.78);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x - 4, y - 7, total + 8, 14, 4);
    else ctx.rect(x - 4, y - 7, total + 8, 14);
    ctx.fill();
    var at = x;
    for (var k = 0; k < n; k += 1) {
      ctx.fillStyle = parts[k].ink;
      text(ctx, parts[k].words, at, y);
      at += widths[k] + gap;
    }
  }

  /* The overlays' names and last values down the top left of the price, as the primary's
     legend has them, and a line that says which studies had no room for a pane. */
  function drawLegend(ctx, overlays, end, top, bottom, plotW, decimals, hidden, dropped) {
    var y = top + 8;
    for (var i = 0; i < overlays.length; i += 1) {
      var ind = overlays[i];
      var parts = [studyName(ind)];
      for (var p = 0; p < ind.plots.length; p += 1) {
        var values = ind.plots[p].values || [];
        var last = values[end];
        if (typeof last !== 'number' || !isFinite(last)) continue;
        parts.push({ words: priceText(last, decimals), ink: valueInk(ind.plots[p], i) });
      }
      drawLabel(ctx, parts, 8, y, plotW - 16);
      y += LEGEND_PITCH;
    }
    // Said at the foot of the price, in the primary's words (chart.js drawChartNotes).
    if (hidden > 0) {
      var names = [];
      for (var d = 0; d < dropped.length; d += 1) names.push(labelText(dropped[d].label || dropped[d].type));
      drawLabel(ctx, [{ words: 'No room for ' + names.join(', '), ink: tokens.text3 }], 8, bottom - 9, plotW - 16);
    }
  }

  /* Levels, solid in the owner's ink, the same reading the primary gives them.
     Off the pane means off the chart here: a comparison chart does not pin
     chips to its edges. */
  function drawLevels(ctx, payload, yOf, top, bottom, plotW, dpr, chips) {
    var list = Array.isArray(payload.levels) ? payload.levels : [];
    for (var i = 0; i < list.length; i += 1) {
      var level = list[i];
      var y = yOf(level.price);
      if (!isFinite(y) || y < top || y > bottom) continue;
      var ink = ownerInk(level.source);
      ctx.strokeStyle = alpha(ink, 0.7);
      ctx.beginPath();
      ctx.moveTo(0, hair(y, dpr));
      ctx.lineTo(plotW, hair(y, dpr));
      ctx.stroke();
      chips.push({ y: y, price: level.price, ink: ink });
    }
  }

  function drawZones(ctx, payload, xOf, yOf, top, bottom, plotW, dpr) {
    var list = Array.isArray(payload.drawings) ? payload.drawings : [];
    for (var i = 0; i < list.length; i += 1) {
      var d = list[i];
      if (d.kind !== 'zone' || !d.zone) continue;
      var yHigh = yOf(d.zone.high);
      var yLow = yOf(d.zone.low);
      var boxTop = Math.max(top, Math.min(yHigh, yLow));
      var boxBottom = Math.min(bottom, Math.max(yHigh, yLow));
      if (boxBottom <= top || boxTop >= bottom) continue;
      var ink = ownerInk(d.source);
      ctx.fillStyle = alpha(ink, 0.1);
      ctx.fillRect(0, boxTop, plotW, boxBottom - boxTop);
      ctx.strokeStyle = alpha(ink, 0.42);
      ctx.beginPath();
      if (yHigh >= top) {
        ctx.moveTo(0, hair(yHigh, dpr));
        ctx.lineTo(plotW, hair(yHigh, dpr));
      }
      if (yLow <= bottom) {
        ctx.moveTo(0, hair(yLow, dpr));
        ctx.lineTo(plotW, hair(yLow, dpr));
      }
      ctx.stroke();
    }
  }

  /* Trend lines, by time and price like the primary's: the value the agent
     measured against is the value on this glass too. Extended to both edges. */
  function drawLines(ctx, payload, candles, granularity, start, slot, yOf, top, bottom, plotW, chips) {
    var list = Array.isArray(payload.drawings) ? payload.drawings : [];
    /* The moment under a pixel column: the first visible bar's open time plus
       the bars between, fractional so a line's slope is not notched. */
    function timeOfX(x) {
      return candles[start].t + (x / slot - 0.5) * granularity;
    }
    function valueAt(line, tSec) {
      var dt = line.b.t - line.a.t;
      if (dt === 0) return line.a.price;
      return line.a.price + ((line.b.price - line.a.price) / dt) * (tSec - line.a.t);
    }
    for (var i = 0; i < list.length; i += 1) {
      var d = list[i];
      if (d.kind === 'zone' || !d.line) continue;
      var t0 = timeOfX(0);
      var t1 = timeOfX(plotW);
      var y0 = yOf(valueAt(d.line, t0));
      var y1 = yOf(valueAt(d.line, t1));
      if (!isFinite(y0) || !isFinite(y1)) continue;
      if ((y0 < top && y1 < top) || (y0 > bottom && y1 > bottom)) continue;
      var ink = ownerInk(d.source);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, plotW, bottom - top);
      ctx.clip();
      ctx.strokeStyle = alpha(ink, 0.85);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(plotW, y1);
      ctx.stroke();
      ctx.restore();
      ctx.lineWidth = 1;
      if (y1 >= top && y1 <= bottom) chips.push({ y: y1, price: valueAt(d.line, t1), ink: ink });
    }
  }

  /* The canvas for a slot, for the snapshot the server asks for. Null for the
     primary (that is the engine's) and for a slot no layout filled. */
  function canvasOf(slot) {
    var m = minis[Number(slot)];
    return m ? m.canvas : null;
  }

  /* A theme moved the tokens under every mounted mini. Read them again and repaint what
     is up; a slot with no payload yet paints itself when its candles arrive. */
  function retheme() {
    readTokens();
    for (var slot = 1; slot <= SLOT_MAX; slot += 1) {
      if (minis[slot]) draw(minis[slot]);
    }
  }

  window.PhosphorMini = { boot: boot, probe: probe, canvasOf: canvasOf, retheme: retheme };
})();
