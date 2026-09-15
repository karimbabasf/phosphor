/* The comparison charts: one read-only canvas per slot 1 to 3, beside the primary.

   chart_layout puts up to four charts side by side. Slot 0 is the engine in
   ui/chart/chart.js, the one the human interacts with. The others are these:
   candles, the server's price plots, its levels, and the lines and zones the
   agent drew on that slot, drawn from /api/chart?slot=n and nothing else. No
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
  var PAD_TOP = 6;
  var PRICE_PAD = 0.06;
  var FONT = '11px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var tokens = {
    bg1: '#151619',
    line: '#262729',
    text: '#ECEEF1',
    text2: '#9BA1AB',
    text3: '#5E656F',
    up: '#3FFF6C',
    down: '#FF5A6E',
    agent: '#B79CFF'
  };

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
    var names = { bg1: 'bg-1', line: 'line', text: 'text', text2: 'text-2', text3: 'text-3', up: 'up', down: 'down', agent: 'agent' };
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

  /* Bars of an hour or more span days, so their stamps carry the day: three
     times of day across a week of 4h bars name nothing. */
  function stampOf(tSec, granularity) {
    var d = new Date(tSec * 1000);
    var day = d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (granularity >= 86400) return day;
    var hh = d.getHours();
    var mm = d.getMinutes();
    var time = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    return granularity >= 3600 ? day + ' ' + time : time;
  }

  function alpha(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
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
    ctx.fillStyle = tokens.bg1;
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;

    var candles = Array.isArray(payload.candles) ? payload.candles : [];
    if (!candles.length) {
      ctx.fillStyle = tokens.text3;
      ctx.fillText(payload.meta && payload.meta.error ? 'No candles' : 'Waiting for candles', 8, 16);
      return;
    }

    var view = payload.view || {};
    var granularity = Number(view.granularitySec) || 60;
    var want = Math.max(10, Math.min(candles.length, Number(view.barCount) || 120));
    var start = candles.length - want;
    var end = candles.length - 1;

    var lo = Infinity;
    var hi = -Infinity;
    for (var i = start; i <= end; i += 1) {
      if (candles[i].l < lo) lo = candles[i].l;
      if (candles[i].h > hi) hi = candles[i].h;
    }
    if (!isFinite(lo) || !isFinite(hi)) return;
    var span = hi - lo || Math.abs(hi) * 0.01 || 1;
    lo -= span * PRICE_PAD;
    hi += span * PRICE_PAD;
    span = hi - lo;

    var decimals = decimalsOf(hi);
    /* The axis is as wide as its widest label, so a four figure price with
       cents is never clipped at the edge of a narrow cell. */
    var axisW = AXIS_MIN_W;
    for (var g0 = 0; g0 <= 3; g0 += 1) {
      var labelW = ctx.measureText(priceText(lo + (span * g0) / 3, decimals)).width + 12;
      if (labelW > axisW) axisW = labelW;
    }
    var plotW = w - axisW;
    var plotH = h - AXIS_H - PAD_TOP;
    var slot = plotW / want;
    function xOf(index) {
      return (index - start + 0.5) * slot;
    }
    function yOf(price) {
      return PAD_TOP + ((hi - price) / span) * plotH;
    }
    var top = PAD_TOP;
    var bottom = PAD_TOP + plotH;

    /* The price grid and its labels down the right. */
    ctx.strokeStyle = alpha(tokens.line, 0.9);
    ctx.fillStyle = tokens.text3;
    for (var g = 0; g <= 3; g += 1) {
      var price = lo + (span * g) / 3;
      var gy = hair(yOf(price), dpr);
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(plotW, gy);
      ctx.stroke();
      ctx.fillText(priceText(price, decimals), plotW + 6, Math.max(top + 6, Math.min(bottom - 6, yOf(price))));
    }

    /* The time axis: the first bar, the middle one and the last. */
    var stamps = [start, Math.round((start + end) / 2), end];
    for (var s = 0; s < stamps.length; s += 1) {
      var label = stampOf(candles[stamps[s]].t, granularity);
      var tx = xOf(stamps[s]);
      ctx.textAlign = s === 0 ? 'left' : s === stamps.length - 1 ? 'right' : 'center';
      ctx.fillText(label, s === 0 ? Math.max(2, tx) : s === stamps.length - 1 ? Math.min(plotW - 2, tx) : tx, bottom + AXIS_H / 2 + 1);
    }
    ctx.textAlign = 'left';

    drawZones(ctx, payload, xOf, yOf, top, bottom, plotW);
    drawCandles(ctx, candles, start, end, xOf, yOf, slot, dpr);
    drawPlots(ctx, payload, start, end, xOf, yOf);
    drawLevels(ctx, payload, yOf, top, bottom, plotW, decimals, dpr);
    drawLines(ctx, payload, candles, granularity, start, slot, yOf, top, bottom, plotW);
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

  /* The server's price plots only. A sub-pane series (rsi, macd, volume) has
     its own scale and no room here: a comparison chart is the price and what
     sits on the price. */
  function drawPlots(ctx, payload, start, end, xOf, yOf) {
    var list = Array.isArray(payload.indicators) ? payload.indicators : [];
    var n = 0;
    for (var i = 0; i < list.length; i += 1) {
      var ind = list[i];
      if (ind.pane !== 'price' || !Array.isArray(ind.plots)) continue;
      for (var p = 0; p < ind.plots.length; p += 1) {
        var plot = ind.plots[p];
        if (plot.style === 'histogram' || !Array.isArray(plot.values)) continue;
        ctx.strokeStyle = alpha(ind.source === 'agent' ? tokens.agent : tokens.up, 0.75);
        ctx.setLineDash(n > 2 ? [4, 3] : []);
        ctx.beginPath();
        var pen = false;
        for (var k = start; k <= end; k += 1) {
          var v = plot.values[k];
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
        n += 1;
      }
    }
    ctx.setLineDash([]);
  }

  /* Levels, dotted for the agent's and dashed for a person's, the same reading
     the primary gives them. Off the pane means off the chart here: a comparison
     chart does not pin labels to its edges. */
  function drawLevels(ctx, payload, yOf, top, bottom, plotW, decimals, dpr) {
    var list = Array.isArray(payload.levels) ? payload.levels : [];
    for (var i = 0; i < list.length; i += 1) {
      var level = list[i];
      var y = yOf(level.price);
      if (!isFinite(y) || y < top || y > bottom) continue;
      var fromAgent = level.source === 'agent';
      var ink = fromAgent ? tokens.agent : tokens.up;
      ctx.strokeStyle = alpha(ink, fromAgent ? 0.6 : 0.7);
      ctx.setLineDash(fromAgent ? [2, 3] : [6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, hair(y, dpr));
      ctx.lineTo(plotW, hair(y, dpr));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = alpha(ink, 0.9);
      ctx.fillText(String(level.label || '') + ' ' + priceText(level.price, decimals), 5, Math.max(top + 7, y - 8));
    }
  }

  function drawZones(ctx, payload, xOf, yOf, top, bottom, plotW) {
    var list = Array.isArray(payload.drawings) ? payload.drawings : [];
    for (var i = 0; i < list.length; i += 1) {
      var d = list[i];
      if (d.kind !== 'zone' || !d.zone) continue;
      var yHigh = yOf(d.zone.high);
      var yLow = yOf(d.zone.low);
      var boxTop = Math.max(top, Math.min(yHigh, yLow));
      var boxBottom = Math.min(bottom, Math.max(yHigh, yLow));
      if (boxBottom <= top || boxTop >= bottom) continue;
      var ink = d.source === 'agent' ? tokens.agent : tokens.up;
      ctx.fillStyle = alpha(ink, 0.12);
      ctx.fillRect(0, boxTop, plotW, boxBottom - boxTop);
      ctx.fillStyle = alpha(ink, 0.8);
      ctx.textAlign = 'right';
      ctx.fillText(String(d.label || ''), plotW - 4, boxTop + 9);
      ctx.textAlign = 'left';
    }
  }

  /* Trend lines, by time and price like the primary's: the value the agent
     measured against is the value on this glass too. Extended to both edges. */
  function drawLines(ctx, payload, candles, granularity, start, slot, yOf, top, bottom, plotW) {
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
      var ink = d.source === 'agent' ? tokens.agent : tokens.up;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, plotW, bottom - top);
      ctx.clip();
      ctx.strokeStyle = alpha(ink, 0.7);
      ctx.setLineDash(d.source === 'agent' ? [2, 3] : [6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(plotW, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      ctx.fillStyle = alpha(ink, 0.85);
      ctx.textAlign = 'right';
      ctx.fillText(String(d.label || ''), plotW - 4, Math.max(top + 8, Math.min(bottom - 4, y1 - 6)));
      ctx.textAlign = 'left';
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
