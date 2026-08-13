/* PHOSPHOR chart engine. Plain browser JS, no imports, no framework, no chart library.
   Loaded before app.js, which calls chartBoot() from its own boot.

   Two canvases, one pointer surface:
     scene  candles, volume-style panes, grids, axes, levels, marks.
            Redrawn only when the data or the view changes.
     hud    crosshair, axis tags, the legend, the last price line and its tag, the countdown.
            Redrawn on pointer move and once a second.

   That split is the whole latency story. Moving the mouse repaints an almost empty canvas
   instead of five hundred candles. Everything else follows from three rules: coalesce every
   redraw into one animation frame, only reallocate the backing store when the element really
   changed size, and draw candles as four batched paths instead of two calls each.

   The view state itself lives on the server (see src/chart.ts). This file renders it and
   writes the human's own pan and zoom back. Nothing here computes an indicator: the numbers
   an agent reads and the pixels drawn here come from one implementation, on purpose. */

'use strict';

var C_BG = '#0b0d0b';
var C_UP = '#33ff66';
/* Down is deliberately darker than the approval gate's #ff3b30 so the gate stays the only
   alarm red on the page even though the chart uses red at all. */
var C_DOWN = '#cc3a30';
var C_HI = '#8cffab';

var CHART_FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Geometry, in CSS pixels. PRICE_MIN is the promise that nothing gets squeezed: a pane that
   would push the price pane under it is dropped and reported, never crammed in. */
var AXIS_BOTTOM = 18;
var PAD_TOP = 3;
var PRICE_MIN = 150;
var PANE_MIN = 56;
var PANE_MAX = 96;
var PRICE_PAD = 0.06; // headroom above and below the auto-fitted range
var GRID_PRICE_GAP = 46; // target pixels between price grid lines
var GRID_TIME_GAP = 96;

var TIME_STEPS = [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 604800];

var CHART = {
  rev: 0,
  view: { product: '', granularitySec: 60, barCount: 120, panOffset: 0, priceScale: { mode: 'auto' } },
  candles: [],
  meta: { source: '', stale: false, built: '', collectedSec: 0, error: null },
  indicators: [],
  levels: [],
  marks: [],
  products: [],
  timeframes: [],
  agentObjects: 0,
  lastDriver: 'human'
};

/* The revision this client last wrote. Anything at or below it coming back over SSE is our
   own echo and is ignored, which is what stops a round trip fighting the hand on the mouse. */
var CHART_MY_REV = 0;
var CHART_FIRST_LOAD = true;
/* Nothing has come back from the server yet. Separate from CHART_FIRST_LOAD, which is about
   who owns the view: this one is about whether the panel has anything true to draw. */
var CHART_READY = false;
var CHART_SKELETON = null;
var CHART_LAYOUT = null;
var CHART_HOVER = null; // {x, y, index}
var CHART_HITS = []; // clickable rectangles built while drawing the hud
var CHART_DIRTY = { scene: false, hud: false };
var CHART_FRAME = 0;
var CHART_SIZE = { w: 0, h: 0, dpr: 0 };
var CHART_FETCH = { inflight: false, at: 0, queued: false };
var CHART_PUSH = null; // debounce timer for writing the view back
var CHART_DRAG = null;
var CHART_AXIS_W = 62; // price axis width, measured from the labels it actually carries
var DPR = 1;

function chartCanvas() {
  return document.getElementById('chart');
}
function chartHud() {
  return document.getElementById('chart-hud');
}
function chartWrap() {
  return document.getElementById('chartwrap');
}

function green(alpha) {
  return 'rgba(51, 255, 102, ' + alpha + ')';
}
function red(alpha) {
  return 'rgba(204, 58, 48, ' + alpha + ')';
}

function clampNum(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/* ---------- formatting ---------- */

function priceText(value, decimals) {
  if (value === null || value === undefined || !isFinite(value)) return '--';
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/* Pane values are not prices: an OBV in the millions and an RSI between 0 and 100 cannot
   share a rule, so the digits follow the size of the number. */
function paneText(value) {
  if (value === null || !isFinite(value)) return '--';
  if (value === 0) return '0';
  var abs = Math.abs(value);
  if (abs >= 1e9) return (value / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (abs >= 1e4) return Math.round(value).toLocaleString('en-US');
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function stampOf(tSec, granularity, withDate) {
  var d = new Date(tSec * 1000);
  if (withDate) return d.getDate() + ' ' + MONTHS[d.getMonth()];
  if (granularity < 60) return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  if (granularity < 86400) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return d.getDate() + ' ' + MONTHS[d.getMonth()];
}

function countdownText(seconds) {
  if (seconds === null || seconds < 0) return '';
  var s = Math.floor(seconds);
  if (s >= 3600) return Math.floor(s / 3600) + 'h' + pad2(Math.floor((s % 3600) / 60));
  if (s >= 60) return Math.floor(s / 60) + ':' + pad2(s % 60);
  return '0:' + pad2(s);
}

/* Grid steps a human reads without decoding: 1, 2, 2.5 and 5 times a power of ten. */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  var exp = Math.pow(10, Math.floor(Math.log10(raw)));
  var f = raw / exp;
  var nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/* One precision for the whole chart: grid, tag, crosshair and legend. Labels that change
   digit count between frames read as a bug, and a span-derived precision on its own rounds
   63,434.5 to 63,434 on a wide window, which is the last price a digit short. So the venue's
   own tick sets the floor. Mirrors displayDecimals in src/chart.ts. */
function decimalsFor(span, candles, from, to) {
  var reference = candles.length ? candles[candles.length - 1].c : 1;
  var step = span > 0 ? span / 6 : Math.abs(reference) / 1000;
  var bySpan = step > 0 ? clampNum(Math.ceil(-Math.log10(step)) + 1, 0, 8) : 2;
  var byTick = 0;
  for (var i = Math.max(from, to - 20); i <= to; i++) {
    var candle = candles[i];
    if (!candle) continue;
    var text = String(candle.c);
    var dot = text.indexOf('.');
    if (dot < 0 || text.indexOf('e') >= 0) continue;
    var places = text.length - dot - 1;
    if (places <= 6 && places > byTick) byTick = places;
  }
  return clampNum(Math.max(bySpan, byTick), 0, 8);
}

/* ---------- layout ---------- */

/* One layout object per scene draw, reused by the hud and by hit testing, so what is drawn
   and what the pointer hits cannot drift apart. */
function buildLayout(width, height, ctx) {
  var view = CHART.view;
  var candles = CHART.candles;

  var overlays = [];
  var paneIndicators = [];
  for (var i = 0; i < CHART.indicators.length; i++) {
    var ind = CHART.indicators[i];
    if (ind.pane === 'price') overlays.push(ind);
    else paneIndicators.push(ind);
  }

  var usable = height - AXIS_BOTTOM - PAD_TOP;
  var paneCount = paneIndicators.length;
  var paneHeight = clampNum(usable * 0.19, PANE_MIN, PANE_MAX);
  // Drop panes off the bottom until the price pane is readable again. A chart that quietly
  // squashes everything to fit is worse than one that says what it could not show.
  while (paneCount > 0 && usable - paneCount * paneHeight < PRICE_MIN) paneCount--;
  var dropped = paneIndicators.slice(paneCount).map(function (p) {
    return p.label;
  });
  var shownPanes = paneIndicators.slice(0, paneCount);

  // The price axis is as wide as the widest label it has to carry. The width feeds the
  // plot width, which feeds the visible range, which decides the labels, so it is measured
  // from the frame just drawn and settles on the next one rather than chasing itself.
  ctx.font = CHART_FONT;
  var padRight = CHART_AXIS_W;

  var plotWidth = Math.max(40, width - padRight);
  var rightGap = clampNum(plotWidth * 0.045, 10, 46);
  var barArea = Math.max(20, plotWidth - rightGap);
  var slot = barArea / Math.max(1, view.barCount);
  var lastIndex = candles.length - 1;
  var rightBar = lastIndex - view.panOffset;

  function xOf(index) {
    return barArea - (rightBar - index) * slot;
  }
  function indexAt(x) {
    return rightBar - (barArea - x) / slot;
  }

  var start = Math.max(0, Math.floor(indexAt(0)));
  var end = Math.min(lastIndex, Math.ceil(indexAt(plotWidth)));

  var low = Infinity;
  var high = -Infinity;
  for (var j = start; j <= end; j++) {
    var c = candles[j];
    if (!c) continue;
    if (c.l < low) low = c.l;
    if (c.h > high) high = c.h;
  }
  // An overlay that leaves the candles behind still has to be on screen, or the line the
  // agent just added is invisible and the chart is lying about what it carries.
  for (var o = 0; o < overlays.length; o++) {
    var plots = overlays[o].plots || [];
    for (var p = 0; p < plots.length; p++) {
      var values = plots[p].values;
      for (var k = start; k <= end; k++) {
        var v = values[k];
        if (v === null || v === undefined || !isFinite(v)) continue;
        if (v < low) low = v;
        if (v > high) high = v;
      }
    }
  }
  /* Levels deliberately do not fit. One line at a silly price would otherwise squash every
     candle into a hairline, and a chart that any single drawn object can destroy is a chart
     an agent can destroy. An off-range level is tagged at the edge of the axis instead, so
     nothing it says is lost. */

  if (!isFinite(low) || !isFinite(high)) {
    low = 0;
    high = 1;
  }
  if (!(high > low)) {
    var bump = Math.max(1e-8, Math.abs(low) * 0.001);
    high = low + bump;
    low = low - bump;
  }

  if (view.priceScale && view.priceScale.mode === 'manual') {
    low = view.priceScale.low;
    high = view.priceScale.high;
  } else {
    var margin = (high - low) * PRICE_PAD;
    low -= margin;
    high += margin;
  }

  var priceHeight = usable - paneCount * paneHeight;
  var priceTop = PAD_TOP;
  var span = high - low;

  function yOf(value) {
    return priceTop + ((high - value) / span) * priceHeight;
  }
  function priceAt(y) {
    return high - ((y - priceTop) / priceHeight) * span;
  }

  var panes = [];
  var top = priceTop + priceHeight;
  for (var q = 0; q < shownPanes.length; q++) {
    var pane = shownPanes[q];
    var lo = Infinity;
    var hi = -Infinity;
    if (pane.range) {
      lo = pane.range[0];
      hi = pane.range[1];
    } else {
      var pplots = pane.plots || [];
      for (var pp = 0; pp < pplots.length; pp++) {
        var pv = pplots[pp].values;
        for (var pk = start; pk <= end; pk++) {
          var value = pv[pk];
          if (value === null || value === undefined || !isFinite(value)) continue;
          if (value < lo) lo = value;
          if (value > hi) hi = value;
        }
      }
      var guides = pane.guides || [];
      for (var gg = 0; gg < guides.length; gg++) {
        if (guides[gg].value < lo) lo = guides[gg].value;
        if (guides[gg].value > hi) hi = guides[gg].value;
      }
      // A histogram is measured from a floor, so the floor has to be inside the pane or the
      // bars are drawn from an edge that means nothing.
      for (var hb = 0; hb < pplots.length; hb++) {
        if (pplots[hb].style !== 'histogram') continue;
        if (lo > 0) lo = 0;
        if (hi < 0) hi = 0;
      }
      if (!isFinite(lo) || !isFinite(hi)) {
        lo = 0;
        hi = 1;
      }
      if (!(hi > lo)) {
        hi = lo + Math.max(1e-8, Math.abs(lo) * 0.01);
      }
      var pmargin = (hi - lo) * 0.08;
      var floored = lo === 0;
      lo -= pmargin;
      hi += pmargin;
      // Headroom belongs above a histogram, never below its floor: volume does not go
      // negative, and an axis that says it might is simply wrong.
      if (floored) lo = 0;
    }
    panes.push({ indicator: pane, top: top, height: paneHeight, low: lo, high: hi });
    top += paneHeight;
  }

  // The band the last price tag and its countdown occupy on the axis. The grid draws its
  // line through it but not its label: two numbers stacked on top of each other is the one
  // thing that would make the most important price on the chart harder to read, not easier.
  var reserved = null;
  var newest = candles[candles.length - 1];
  if (newest) {
    var tagY = clampNum(priceTop + ((high - newest.c) / (high - low)) * priceHeight, priceTop + 7, priceTop + priceHeight - 7);
    reserved = { top: tagY - 10, bottom: tagY + (typeof CHART.meta.barCloseSec === 'number' ? 26 : 10) };
  }

  var decimals = decimalsFor(span, candles, start, end);
  var widest = Math.max(
    ctx.measureText(priceText(high, decimals)).width,
    ctx.measureText(priceText(low, decimals)).width
  );
  var wanted = clampNum(Math.ceil(widest) + 12, 48, 104);
  if (Math.abs(wanted - CHART_AXIS_W) > 2) {
    CHART_AXIS_W = wanted;
    CHART_DIRTY.scene = true;
  }

  return {
    width: width,
    height: height,
    plotWidth: plotWidth,
    barArea: barArea,
    padRight: padRight,
    slot: slot,
    rightBar: rightBar,
    start: start,
    end: end,
    low: low,
    high: high,
    span: span,
    priceTop: priceTop,
    priceHeight: priceHeight,
    reserved: reserved,
    decimals: decimals,
    overlays: overlays,
    panes: panes,
    dropped: dropped,
    axisTop: PAD_TOP + priceHeight + paneCount * paneHeight,
    xOf: xOf,
    yOf: yOf,
    indexAt: indexAt,
    priceAt: priceAt
  };
}

function paneYOf(pane, value) {
  var span = pane.high - pane.low;
  if (!(span > 0)) return pane.top + pane.height / 2;
  return pane.top + ((pane.high - value) / span) * pane.height;
}

/* ---------- the frame loop ---------- */

function chartInvalidate(scene) {
  if (scene) CHART_DIRTY.scene = true;
  CHART_DIRTY.hud = true;
  if (CHART_FRAME) return;
  CHART_FRAME = window.requestAnimationFrame(chartFrame);
}

function chartFrame() {
  CHART_FRAME = 0;
  if (chartResize()) CHART_DIRTY.scene = true;
  if (CHART_DIRTY.scene) {
    CHART_DIRTY.scene = false;
    drawScene();
  }
  if (CHART_DIRTY.hud) {
    CHART_DIRTY.hud = false;
    drawHud();
  }
}

/* The backing store is only reallocated when the element actually changed size. Doing it per
   frame, which is the obvious way to write this, costs a full buffer allocation and a clear
   on every mouse move. */
function chartResize() {
  var wrap = chartWrap();
  if (!wrap) return false;
  var width = wrap.clientWidth;
  var height = wrap.clientHeight;
  var dpr = window.devicePixelRatio || 1;
  if (!width || !height) return false;
  if (width === CHART_SIZE.w && height === CHART_SIZE.h && dpr === CHART_SIZE.dpr) return false;
  CHART_SIZE = { w: width, h: height, dpr: dpr };
  DPR = dpr;
  var pair = [chartCanvas(), chartHud()];
  for (var i = 0; i < pair.length; i++) {
    var canvas = pair[i];
    if (!canvas) continue;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  queueChartPush();
  return true;
}

function hair(value) {
  return Math.round(value * DPR) / DPR + 0.5 / DPR;
}

function prepare(canvas, opaque) {
  var ctx = canvas.getContext('2d', { alpha: !opaque });
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (opaque) {
    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, CHART_SIZE.w, CHART_SIZE.h);
  } else {
    ctx.clearRect(0, 0, CHART_SIZE.w, CHART_SIZE.h);
  }
  ctx.font = CHART_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  return ctx;
}

/* ---------- the scene ---------- */

function drawScene() {
  var canvas = chartCanvas();
  if (!canvas || !CHART_SIZE.w) return;
  var ctx = prepare(canvas, true);
  var width = CHART_SIZE.w;
  var height = CHART_SIZE.h;

  if (!CHART.candles.length) {
    drawWaiting(ctx, width, height);
    CHART_LAYOUT = null;
    return;
  }

  var L = buildLayout(width, height, ctx);
  CHART_LAYOUT = L;

  drawPriceGrid(ctx, L);
  drawTimeGrid(ctx, L);
  drawMarks(ctx, L);
  drawOverlayBands(ctx, L);
  drawCandles(ctx, L);
  drawOverlayLines(ctx, L);
  drawLevels(ctx, L);
  drawPanes(ctx, L);
  drawAxisFrame(ctx, L);
}

/* ---------- the waiting scene ---------- */

/* An empty panel with "no candle data" in the corner reads as a chart that broke, not as one
   that has not arrived. So while there is nothing to draw, the panel draws the chart it is
   about to have: the axis frame, a ghost grid, and a run of skeleton bars that light up
   behind a column sweeping left to right.

   The bars come from one fixed pseudo-random walk, not a fresh one per frame. A skeleton that
   reshuffles every 16ms is noise, and noise reads as broken too. */
function skeletonBars(count) {
  if (CHART_SKELETON && CHART_SKELETON.length === count) return CHART_SKELETON;
  var bars = [];
  var mid = 0.5;
  var seed = 20260812;
  for (var i = 0; i < count; i++) {
    // xorshift32: same walk on every frame and every reload, no Math.random in a draw path.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed |= 0;
    var a = ((seed >>> 9) % 1000) / 1000;
    var b = ((seed >>> 19) % 1000) / 1000;
    mid = clampNum(mid + (a - 0.5) * 0.16, 0.16, 0.84);
    var body = 0.012 + b * 0.05;
    bars.push({ mid: mid, body: body, wick: body + 0.01 + a * 0.045 });
  }
  CHART_SKELETON = bars;
  return bars;
}

function reducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* What the panel is waiting for, said in the words the rest of the bar uses. An error is a
   state, not a wait: it says so and stops moving. */
function waitingState() {
  var product = CHART.view.product || 'MARKET';
  var tf = timeframeOf(CHART.view.granularitySec);
  if (CHART.meta.error) {
    return { head: 'CHART UNREACHABLE', sub: CHART.meta.error + '  retrying', live: CHART_FETCH.inflight };
  }
  if (!CHART_READY) {
    // Before the first payload there is no product and no timeframe to name, and naming the
    // defaults would put a market on screen that nobody has confirmed is the one being read.
    if (!CHART.view.product) return { head: 'CONNECTING', sub: 'waiting for the first chart payload', live: true };
    return { head: 'ACQUIRING ' + product + ' ' + tf, sub: 'waiting for the first candles', live: true };
  }
  if (CHART.meta.built === 'trades') {
    var want = CHART.view.granularitySec * Math.round(CHART.view.barCount);
    return {
      head: 'BUILDING ' + product + ' ' + tf,
      sub: 'from live trades: ' + CHART.meta.collectedSec + 's of ' + want + 's',
      live: true
    };
  }
  return {
    head: 'NO CANDLES ' + product + ' ' + tf,
    sub: (CHART.meta.source || 'the source') + ' returned nothing for this window',
    live: CHART_FETCH.inflight
  };
}

function drawWaiting(ctx, width, height) {
  var state = waitingState();
  var still = reducedMotion();
  var plotWidth = Math.max(40, width - CHART_AXIS_W);
  var bottom = height - AXIS_BOTTOM;
  var top = PAD_TOP;
  var area = Math.max(1, bottom - top);

  // The frame first, so the panel has the shape of a chart before it has the contents of one.
  ctx.lineWidth = 1 / DPR;
  ctx.strokeStyle = green(0.07);
  ctx.beginPath();
  for (var g = 1; g < 5; g++) {
    var y = hair(top + (area * g) / 5);
    ctx.moveTo(0, y);
    ctx.lineTo(plotWidth, y);
  }
  ctx.stroke();
  ctx.strokeStyle = green(0.16);
  ctx.beginPath();
  ctx.moveTo(hair(plotWidth), top);
  ctx.lineTo(hair(plotWidth), bottom);
  ctx.moveTo(0, hair(bottom));
  ctx.lineTo(width, hair(bottom));
  ctx.stroke();

  var slot = 7;
  var count = Math.max(8, Math.floor((plotWidth - 8) / slot));
  var bars = skeletonBars(count);
  // One pass over a 2.2 second cycle, with the head running off both edges so the sweep
  // enters and leaves rather than popping into existence at x=0.
  var sweep = state.live && !still ? ((Date.now() % 2200) / 2200) * 1.3 - 0.15 : 2;
  var bodyWidth = 3;

  for (var i = 0; i < count; i++) {
    var bar = bars[i];
    var u = i / (count - 1);
    var lead = sweep - u;
    var alpha;
    if (!state.live || still) alpha = 0.1;
    else if (lead < 0) alpha = 0.04; // ahead of the sweep: barely there
    else alpha = 0.1 + 0.42 * Math.exp(-(lead * 7) * (lead * 7));
    var x = 6 + i * slot;
    var cy = top + area * bar.mid;
    ctx.strokeStyle = green(alpha * 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hair(x), cy - area * bar.wick);
    ctx.lineTo(hair(x), cy + area * bar.wick);
    ctx.stroke();
    ctx.fillStyle = green(alpha);
    ctx.fillRect(Math.round(x - bodyWidth / 2), Math.round(cy - area * bar.body), bodyWidth, Math.max(1, Math.round(area * bar.body * 2)));
  }

  // The scan column itself, so the eye has one thing to follow instead of a field of flicker.
  if (state.live && !still && sweep >= 0 && sweep <= 1) {
    var sx = hair(6 + sweep * (count - 1) * slot);
    ctx.strokeStyle = green(0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx, top);
    ctx.lineTo(sx, bottom);
    ctx.stroke();
  }

  // The two lines sit on a cut-out of the background: the skeleton is behind them and text
  // over a picket fence of bars is the one thing here that would be hard to read.
  ctx.textAlign = 'center';
  var cx = plotWidth / 2;
  var midY = top + area / 2;
  var block = state.live && !still && Date.now() % 1000 < 500 ? ' █' : '  ';
  var headText = state.head + block;
  var headWidth = ctx.measureText(headText).width;
  var subWidth = ctx.measureText(state.sub).width;
  ctx.fillStyle = C_BG;
  ctx.fillRect(cx - Math.max(headWidth, subWidth) / 2 - 8, midY - 15, Math.max(headWidth, subWidth) + 16, 30);
  ctx.fillStyle = CHART.meta.error ? red(0.9) : green(0.72);
  ctx.fillText(headText, cx, midY - 6);
  ctx.fillStyle = green(0.38);
  ctx.fillText(state.sub, cx, midY + 8);
  ctx.textAlign = 'left';

  // The loop, and its own stop condition: the moment there is something true to draw, this
  // scene is not reached and the frame chain ends by itself.
  if (state.live && !still) chartInvalidate(true);
}

function drawPriceGrid(ctx, L) {
  var lines = Math.max(2, Math.round(L.priceHeight / GRID_PRICE_GAP));
  var step = niceStep(L.span / lines);
  var first = Math.ceil(L.low / step) * step;
  ctx.lineWidth = 1 / DPR;
  ctx.strokeStyle = green(0.07);
  ctx.fillStyle = green(0.42);
  ctx.textAlign = 'left';
  ctx.beginPath();
  var labels = [];
  for (var value = first; value <= L.high; value += step) {
    var y = L.yOf(value);
    if (y < L.priceTop + 6 || y > L.priceTop + L.priceHeight - 4) continue;
    ctx.moveTo(0, hair(y));
    ctx.lineTo(L.plotWidth, hair(y));
    labels.push([value, y]);
  }
  ctx.stroke();
  for (var i = 0; i < labels.length; i++) {
    var y = labels[i][1];
    if (L.reserved && y > L.reserved.top && y < L.reserved.bottom) continue;
    ctx.fillText(priceText(labels[i][0], L.decimals), L.plotWidth + 6, y);
  }
}

/* Grid lines land on round clock times, never on arbitrary bars, because a chart where the
   labels read 14:07 and 14:22 makes the reader do arithmetic to place anything. */
function drawTimeGrid(ctx, L) {
  var granularity = CHART.view.granularitySec;
  var step = TIME_STEPS[TIME_STEPS.length - 1];
  for (var s = 0; s < TIME_STEPS.length; s++) {
    if (TIME_STEPS[s] < granularity) continue;
    if ((TIME_STEPS[s] / granularity) * L.slot >= GRID_TIME_GAP) {
      step = TIME_STEPS[s];
      break;
    }
  }
  var bottom = L.axisTop;
  ctx.lineWidth = 1 / DPR;
  ctx.strokeStyle = green(0.07);
  ctx.beginPath();
  var ticks = [];
  var prevDay = null;
  for (var i = L.start; i <= L.end; i++) {
    var candle = CHART.candles[i];
    if (!candle) continue;
    if (candle.t % step !== 0) continue;
    var x = L.xOf(i);
    if (x < 0 || x > L.plotWidth) continue;
    var day = Math.floor(candle.t / 86400);
    var isNewDay = prevDay !== null && day !== prevDay;
    prevDay = day;
    ctx.moveTo(hair(x), PAD_TOP);
    ctx.lineTo(hair(x), bottom);
    ticks.push([x, candle.t, isNewDay]);
  }
  ctx.stroke();

  ctx.textAlign = 'center';
  for (var k = 0; k < ticks.length; k++) {
    var newDay = ticks[k][2];
    ctx.fillStyle = newDay ? green(0.7) : green(0.42);
    ctx.fillText(stampOf(ticks[k][1], granularity, newDay), ticks[k][0], bottom + 9);
  }
  ctx.textAlign = 'left';
}

/* Four paths for the whole series instead of two calls per candle. At five hundred bars that
   is the difference between a draw that keeps up with a drag and one that does not. */
function drawCandles(ctx, L) {
  var bodyWidth = Math.max(1, Math.floor(L.slot * 0.68));
  if (bodyWidth % 2 === 0 && L.slot > 3) bodyWidth -= 1;
  var wickWidth = L.slot > 6 ? Math.max(1, Math.round(L.slot * 0.1)) : 1;
  var half = bodyWidth / 2;

  var sets = [
    { colour: C_UP, up: true },
    { colour: C_DOWN, up: false }
  ];
  for (var s = 0; s < sets.length; s++) {
    var set = sets[s];
    ctx.strokeStyle = set.colour;
    ctx.fillStyle = set.colour;

    ctx.lineWidth = wickWidth;
    ctx.beginPath();
    for (var i = L.start; i <= L.end; i++) {
      var c = CHART.candles[i];
      if (!c || c.c >= c.o !== set.up) continue;
      var x = hair(L.xOf(i));
      ctx.moveTo(x, L.yOf(c.h));
      ctx.lineTo(x, L.yOf(c.l));
    }
    ctx.stroke();

    ctx.beginPath();
    for (var j = L.start; j <= L.end; j++) {
      var b = CHART.candles[j];
      if (!b || b.c >= b.o !== set.up) continue;
      var cx = L.xOf(j);
      var top = Math.min(L.yOf(b.o), L.yOf(b.c));
      var bottom = Math.max(L.yOf(b.o), L.yOf(b.c));
      // A doji still has to be a mark on the screen, so the body has a floor of one pixel.
      var h = Math.max(1, bottom - top);
      ctx.rect(Math.round(cx - half), Math.round(top), bodyWidth, Math.round(h));
    }
    ctx.fill();
  }
}

function plotColour(plot, alphaScale) {
  var alpha = clampNum((plot.emphasis === undefined ? 0.8 : plot.emphasis) * (alphaScale || 1), 0.08, 1);
  return green(alpha);
}

function strokeSeries(ctx, values, from, to, xOf, yOf) {
  ctx.beginPath();
  var pen = false;
  for (var i = from; i <= to; i++) {
    var v = values[i];
    if (v === null || v === undefined || !isFinite(v)) {
      pen = false;
      continue;
    }
    var x = xOf(i);
    var y = yOf(v);
    if (!pen) {
      ctx.moveTo(x, y);
      pen = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

function drawOverlayBands(ctx, L) {
  for (var i = 0; i < L.overlays.length; i++) {
    var plots = L.overlays[i].plots || [];
    for (var p = 0; p < plots.length; p++) {
      var plot = plots[p];
      if (plot.style !== 'band' || !plot.fillTo) continue;
      var other = null;
      for (var q = 0; q < plots.length; q++) {
        if (plots[q].key === plot.fillTo) other = plots[q];
      }
      if (!other) continue;
      ctx.fillStyle = green(0.05);
      ctx.beginPath();
      var open = false;
      var k;
      for (k = L.start; k <= L.end; k++) {
        var top = plot.values[k];
        if (top === null || top === undefined || !isFinite(top)) continue;
        if (!open) {
          ctx.moveTo(L.xOf(k), L.yOf(top));
          open = true;
        } else ctx.lineTo(L.xOf(k), L.yOf(top));
      }
      if (!open) continue;
      for (k = L.end; k >= L.start; k--) {
        var bottom = other.values[k];
        if (bottom === null || bottom === undefined || !isFinite(bottom)) continue;
        ctx.lineTo(L.xOf(k), L.yOf(bottom));
      }
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawOverlayLines(ctx, L) {
  ctx.lineWidth = 1;
  for (var i = 0; i < L.overlays.length; i++) {
    var plots = L.overlays[i].plots || [];
    for (var p = 0; p < plots.length; p++) {
      var plot = plots[p];
      if (plot.style === 'histogram') continue;
      ctx.strokeStyle = plotColour(plot, plot.style === 'band' ? 0.7 : 1);
      // Overlays past the third separate by dash as well as by brightness: on one hue,
      // brightness alone runs out after about three lines.
      ctx.setLineDash(i > 2 ? [4, 3] : []);
      strokeSeries(ctx, plot.values, L.start, L.end, L.xOf, L.yOf);
    }
  }
  ctx.setLineDash([]);
}

function drawPanes(ctx, L) {
  for (var i = 0; i < L.panes.length; i++) {
    var pane = L.panes[i];
    var ind = pane.indicator;

    ctx.strokeStyle = green(0.16);
    ctx.lineWidth = 1 / DPR;
    ctx.beginPath();
    ctx.moveTo(0, hair(pane.top));
    ctx.lineTo(L.plotWidth, hair(pane.top));
    ctx.stroke();

    var guides = ind.guides || [];
    ctx.strokeStyle = green(0.1);
    ctx.fillStyle = green(0.34);
    ctx.beginPath();
    for (var g = 0; g < guides.length; g++) {
      var gy = paneYOf(pane, guides[g].value);
      if (gy < pane.top + 2 || gy > pane.top + pane.height - 2) continue;
      ctx.moveTo(0, hair(gy));
      ctx.lineTo(L.plotWidth, hair(gy));
    }
    ctx.stroke();
    for (var gl = 0; gl < guides.length; gl++) {
      var ly = paneYOf(pane, guides[gl].value);
      if (ly < pane.top + 2 || ly > pane.top + pane.height - 2) continue;
      ctx.fillText(guides[gl].label, L.plotWidth + 6, ly);
    }

    var plots = ind.plots || [];
    for (var p = 0; p < plots.length; p++) {
      var plot = plots[p];
      if (plot.style === 'histogram') {
        drawPaneHistogram(ctx, L, pane, plot);
        continue;
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = plotColour(plot, 1);
      strokeSeries(ctx, plot.values, L.start, L.end, L.xOf, function (v) {
        return paneYOf(pane, v);
      });
    }

    // The pane's own scale: two numbers, at its edges, so a value can be placed without a
    // grid cutting the pane into strips. A pane with a fixed domain already says 0 to 100
    // through its guides, and printing the edges again only collides with them.
    if (!ind.range) {
      ctx.fillStyle = green(0.34);
      ctx.fillText(paneText(pane.high), L.plotWidth + 6, pane.top + 7);
      ctx.fillText(paneText(pane.low), L.plotWidth + 6, pane.top + pane.height - 6);
    }
  }
}

/* Two kinds of histogram share this. A signed one (MACD) draws from the zero line and takes
   its colour from the value. A magnitude one (volume) draws from the floor of the pane and
   takes its colour from a direction series beside it: volume is never negative, and folding
   the direction into the value would put half the bars under an axis. */
function drawPaneHistogram(ctx, L, pane, plot) {
  var width = Math.max(1, Math.floor(L.slot * 0.6));
  var base = paneYOf(pane, clampNum(0, pane.low, pane.high));
  var signs = plot.signs;
  var sets = plot.signed === true || signs ? [1, -1] : [1];
  for (var s = 0; s < sets.length; s++) {
    var sign = sets[s];
    ctx.fillStyle = sets.length === 1 ? green(0.3) : sign > 0 ? green(0.34) : red(0.4);
    ctx.beginPath();
    for (var i = L.start; i <= L.end; i++) {
      var v = plot.values[i];
      if (v === null || v === undefined || !isFinite(v)) continue;
      var direction = signs ? (signs[i] >= 0 ? 1 : -1) : v >= 0 ? 1 : -1;
      if (sets.length > 1 && direction !== sign) continue;
      var y = paneYOf(pane, v);
      var top = Math.min(y, base);
      var height = Math.max(1, Math.abs(base - y));
      ctx.rect(Math.round(L.xOf(i) - width / 2), Math.round(top), width, Math.round(height));
    }
    ctx.fill();
  }
}

function drawLevels(ctx, L) {
  if (!CHART.levels.length) return;
  ctx.lineWidth = 1;
  var top = L.priceTop;
  var bottom = L.priceTop + L.priceHeight;
  for (var i = 0; i < CHART.levels.length; i++) {
    var level = CHART.levels[i];
    var y = L.yOf(level.price);
    var fromAgent = level.source === 'agent';
    if (y < top || y > bottom) {
      // Off the top or the bottom of what is on screen. The line cannot be drawn where it
      // belongs, so it is pinned to the edge it went off, with an arrow saying which way.
      var edge = y < top ? top + 6 : bottom - 6;
      ctx.fillStyle = green(0.4);
      ctx.fillText((y < top ? '↑ ' : '↓ ') + level.label + ' ' + priceText(level.price, L.decimals), 4, edge);
      continue;
    }
    ctx.strokeStyle = green(fromAgent ? 0.5 : 0.7);
    // Agent lines are dotted, human lines are dashed. Attribution is in the label as well,
    // but the eye reads the dash first.
    ctx.setLineDash(fromAgent ? [2, 3] : [6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, hair(y));
    ctx.lineTo(L.plotWidth, hair(y));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = green(fromAgent ? 0.6 : 0.85);
    ctx.fillText(level.label, 4, y - 7);
  }
}

function drawMarks(ctx, L) {
  if (!CHART.marks.length) return;
  var granularity = CHART.view.granularitySec;
  ctx.lineWidth = 1;
  for (var i = 0; i < CHART.marks.length; i++) {
    var mark = CHART.marks[i];
    // Marks land on the bar that contains them, not between two bars.
    var index = indexOfTime(mark.t, granularity);
    if (index < L.start - 1 || index > L.end + 1) continue;
    var x = L.xOf(index);
    if (x < 0 || x > L.plotWidth) continue;
    ctx.strokeStyle = green(0.34);
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(hair(x), PAD_TOP);
    ctx.lineTo(hair(x), L.axisTop);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.translate(x - 3, L.axisTop - 4);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = green(0.55);
    ctx.fillText(mark.label, 0, 0);
    ctx.restore();
  }
}

function indexOfTime(tSec, granularity) {
  var candles = CHART.candles;
  if (!candles.length) return -1;
  var first = candles[0].t;
  return Math.round((tSec - first) / granularity);
}

function drawAxisFrame(ctx, L) {
  ctx.strokeStyle = green(0.16);
  ctx.lineWidth = 1 / DPR;
  ctx.beginPath();
  ctx.moveTo(hair(L.plotWidth), 0);
  ctx.lineTo(hair(L.plotWidth), L.axisTop);
  ctx.moveTo(0, hair(L.axisTop));
  ctx.lineTo(L.width, hair(L.axisTop));
  ctx.stroke();
}

/* ---------- the hud ---------- */

function drawHud() {
  var canvas = chartHud();
  if (!canvas || !CHART_SIZE.w) return;
  var ctx = prepare(canvas, false);
  CHART_HITS = [];
  var L = CHART_LAYOUT;
  if (!L) return;

  drawLastPrice(ctx, L);
  drawCrosshair(ctx, L);
  drawLegend(ctx, L);
}

function drawLastPrice(ctx, L) {
  var candles = CHART.candles;
  if (!candles.length) return;
  var last = candles[candles.length - 1];
  var up = last.c >= last.o;
  var y = L.yOf(last.c);
  if (y >= L.priceTop && y <= L.priceTop + L.priceHeight) {
    ctx.strokeStyle = up ? green(0.45) : red(0.55);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, hair(y));
    ctx.lineTo(L.plotWidth, hair(y));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The price tag. This is the one thing on the chart that has to be readable without
  // looking for it, so it is the only filled block on the surface.
  var text = priceText(last.c, L.decimals);
  var tagY = clampNum(y, L.priceTop + 7, L.priceTop + L.priceHeight - 7);
  var boxTop = Math.round(tagY - 8);
  ctx.fillStyle = up ? C_UP : C_DOWN;
  ctx.fillRect(L.plotWidth + 1, boxTop, L.padRight - 1, 16);
  ctx.fillStyle = C_BG;
  ctx.fillText(text, L.plotWidth + 5, boxTop + 8);

  var closesIn = CHART.meta.barCloseSec;
  if (typeof closesIn === 'number' && closesIn >= 0) {
    ctx.fillStyle = green(0.45);
    ctx.fillText(countdownText(closesIn), L.plotWidth + 5, boxTop + 24);
  }
}

function drawCrosshair(ctx, L) {
  if (!CHART_HOVER) return;
  var index = Math.round(CHART_HOVER.index);
  if (index < 0 || index >= CHART.candles.length) return;
  var x = L.xOf(index);
  var y = CHART_HOVER.y;
  if (x < 0 || x > L.plotWidth) return;

  ctx.strokeStyle = green(0.3);
  ctx.lineWidth = 1 / DPR;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  // Snapped to the bar on x, free on y: the price under the pointer is a reading, the bar
  // under the pointer is a fact.
  ctx.moveTo(hair(x), PAD_TOP);
  ctx.lineTo(hair(x), L.axisTop);
  ctx.moveTo(0, hair(y));
  ctx.lineTo(L.plotWidth, hair(y));
  ctx.stroke();
  ctx.setLineDash([]);

  var inPrice = y <= L.priceTop + L.priceHeight;
  var label = inPrice ? priceText(L.priceAt(y), L.decimals) : paneValueAt(L, y);
  if (label !== null) {
    var top = Math.round(clampNum(y, 8, L.axisTop - 8) - 8);
    ctx.fillStyle = C_HI;
    ctx.fillRect(L.plotWidth + 1, top, L.padRight - 1, 16);
    ctx.fillStyle = C_BG;
    ctx.fillText(label, L.plotWidth + 5, top + 8);
  }

  var candle = CHART.candles[index];
  var stamp = stampOf(candle.t, CHART.view.granularitySec, false);
  ctx.font = CHART_FONT;
  var width = ctx.measureText(stamp).width + 10;
  var boxX = clampNum(x - width / 2, 0, L.plotWidth - width);
  ctx.fillStyle = C_HI;
  ctx.fillRect(boxX, L.axisTop + 1, width, 15);
  ctx.fillStyle = C_BG;
  ctx.fillText(stamp, boxX + 5, L.axisTop + 9);
}

function paneValueAt(L, y) {
  for (var i = 0; i < L.panes.length; i++) {
    var pane = L.panes[i];
    if (y < pane.top || y > pane.top + pane.height) continue;
    var span = pane.high - pane.low;
    return paneText(pane.high - ((y - pane.top) / pane.height) * span);
  }
  return null;
}

/* The legend reads the bar under the pointer, or the newest bar when the pointer is away.
   It is the answer to "what is the price": OHLC, the change, and every indicator's value at
   that same bar rather than at the end of the series. */
function drawLegend(ctx, L) {
  var candles = CHART.candles;
  if (!candles.length) return;
  var index = CHART_HOVER ? clampNum(Math.round(CHART_HOVER.index), 0, candles.length - 1) : candles.length - 1;
  var candle = candles[index];
  var up = candle.c >= candle.o;
  var change = candle.o !== 0 ? ((candle.c - candle.o) / candle.o) * 100 : 0;

  var x = 3;
  var y = PAD_TOP + 8;
  ctx.fillStyle = C_HI;
  ctx.fillText(CHART.view.product, x, y);
  x += ctx.measureText(CHART.view.product).width + 6;
  ctx.fillStyle = green(0.5);
  var tf = timeframeOf(CHART.view.granularitySec);
  ctx.fillText(tf, x, y);
  x += ctx.measureText(tf).width + 10;

  var parts = [
    ['O', priceText(candle.o, L.decimals)],
    ['H', priceText(candle.h, L.decimals)],
    ['L', priceText(candle.l, L.decimals)],
    ['C', priceText(candle.c, L.decimals)]
  ];
  for (var i = 0; i < parts.length; i++) {
    ctx.fillStyle = green(0.4);
    ctx.fillText(parts[i][0], x, y);
    x += ctx.measureText(parts[i][0]).width + 3;
    ctx.fillStyle = up ? C_UP : C_DOWN;
    ctx.fillText(parts[i][1], x, y);
    x += ctx.measureText(parts[i][1]).width + 8;
  }
  ctx.fillStyle = up ? C_UP : C_DOWN;
  // Round before choosing the sign, or a bar that moved a hundredth of a percent down
  // prints "-0.00%", which reads as a rendering fault rather than as a flat bar.
  var rounded = Math.abs(change) < 0.005 ? 0 : change;
  ctx.fillText((rounded > 0 ? '+' : rounded < 0 ? '' : ' ') + rounded.toFixed(2) + '%', x, y);

  var row = y + 13;
  for (var o = 0; o < L.overlays.length; o++) {
    row = drawIndicatorLine(ctx, L, L.overlays[o], 3, row, index);
  }
  for (var p = 0; p < L.panes.length; p++) {
    drawIndicatorLine(ctx, L, L.panes[p].indicator, 3, L.panes[p].top + 9, index);
  }

  if (L.dropped.length) {
    ctx.fillStyle = C_DOWN;
    ctx.fillText('no room for: ' + L.dropped.join(', '), 3, L.axisTop - 6);
  }
}

/* One line per indicator, with the values at the hovered bar and a cross that removes it.
   The cross is the human's way out of anything an agent put on the chart. */
function drawIndicatorLine(ctx, L, indicator, x, y, index) {
  ctx.fillStyle = indicator.source === 'agent' ? green(0.62) : green(0.8);
  ctx.fillText(indicator.label, x, y);
  var cursor = x + ctx.measureText(indicator.label).width + 8;
  var plots = indicator.plots || [];
  for (var i = 0; i < plots.length; i++) {
    var value = plots[i].values[index];
    if (value === null || value === undefined || !isFinite(value)) continue;
    var text = indicator.pane === 'price' ? priceText(value, L.decimals) : paneText(value);
    ctx.fillStyle = green(0.55);
    ctx.fillText(text, cursor, y);
    cursor += ctx.measureText(text).width + 7;
  }
  ctx.fillStyle = green(0.4);
  ctx.fillText('×', cursor, y);
  CHART_HITS.push({ x: cursor - 4, y: y - 7, w: 14, h: 14, remove: indicator.id });
  return y + 13;
}

function timeframeOf(sec) {
  for (var i = 0; i < CHART.timeframes.length; i++) {
    if (CHART.timeframes[i].sec === sec) return CHART.timeframes[i].label;
  }
  return sec + 's';
}

/* ---------- talking to the server ---------- */

async function refreshChart() {
  if (CHART_FETCH.inflight) {
    CHART_FETCH.queued = true;
    return;
  }
  CHART_FETCH.inflight = true;
  CHART_FETCH.at = Date.now();
  chartBusy(true);
  try {
    var res = await fetch('/api/chart', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('chart returned ' + res.status);
    var payload = await res.json();
    applyChart(payload);
  } catch (err) {
    CHART.meta.error = err.message || String(err);
    chartInvalidate(true);
  } finally {
    CHART_FETCH.inflight = false;
    chartBusy(false);
    if (CHART_FETCH.queued) {
      CHART_FETCH.queued = false;
      void refreshChart();
    }
  }
}

/* The one thing on the bar that says a read is in flight. It lives next to the meta line
   rather than inside it, because renderChartBar rebuilds that line from scratch and a
   marker that disappears whenever the data it is waiting for arrives is no marker at all.
   A chart that already has candles keeps them: this is the only sign of a refresh, which is
   what stops a timeframe switch looking like a freeze. */
function chartBusy(on) {
  var node = document.getElementById('chart-wait');
  if (node) node.hidden = !on;
}

function applyChart(payload) {
  CHART_READY = true;
  CHART.rev = payload.rev;
  CHART.candles = payload.candles || [];
  CHART.meta = payload.meta || CHART.meta;
  CHART.indicators = payload.indicators || [];
  CHART.levels = payload.levels || [];
  CHART.marks = payload.marks || [];
  CHART.products = payload.products || [];
  CHART.timeframes = payload.timeframes || [];
  CHART.agentObjects = payload.agentObjects || 0;
  CHART.lastDriver = payload.lastDriver || 'human';
  if (payload.limits && typeof payload.limits.barCountMax === 'number') {
    CHART_BARS = { min: payload.limits.barCountMin, max: payload.limits.barCountMax };
  }
  /* Who owns the view. The hand in the window owns it while the hand is on it, and the only
     thing that may move the chart out from under that hand is the agent. Adopting the
     server's view on every refresh instead looks correct and is not: a refresh fired by our
     own write can land before that write does, and the gesture the human just made snaps
     back. The server's answer to our own write is applied in pushChart, where it is an
     answer and not a race. */
  if (CHART_FIRST_LOAD || (payload.lastDriver === 'agent' && CHART_DRAG === null && CHART_PUSH === null)) {
    CHART.view = payload.view;
    CHART_FIRST_LOAD = false;
  }

  var last = CHART.candles.length ? CHART.candles[CHART.candles.length - 1] : null;
  CHART.meta.barCloseSec = last ? Math.max(0, last.t + CHART.view.granularitySec - Date.now() / 1000) : null;

  // Panes need height from somewhere, and the panel is the only place it can come from.
  var panes = 0;
  for (var i = 0; i < CHART.indicators.length; i++) if (CHART.indicators[i].pane !== 'price') panes++;
  var panel = document.getElementById('panel-chart');
  if (panel) panel.style.setProperty('--panes', String(panes));

  renderChartBar();
  chartInvalidate(true);
}

/* Writing the human's own view back, once the hand settles. Posting at pointer rate would
   put a network round trip inside the drag loop, which is exactly what makes a chart feel
   slow. An agent reading mid-drag sees the last settled view, which is documented. */
function queueChartPush() {
  if (CHART_PUSH) clearTimeout(CHART_PUSH);
  CHART_PUSH = setTimeout(pushChart, 150);
}

async function pushChart(extra) {
  CHART_PUSH = null;
  var body = {
    token: typeof TOKEN === 'string' ? TOKEN : null,
    view: {
      product: CHART.view.product,
      granularitySec: CHART.view.granularitySec,
      barCount: CHART.view.barCount,
      panOffset: CHART.view.panOffset,
      priceScale: CHART.view.priceScale.mode,
      priceLow: CHART.view.priceScale.mode === 'manual' ? CHART.view.priceScale.low : undefined,
      priceHigh: CHART.view.priceScale.mode === 'manual' ? CHART.view.priceScale.high : undefined
    },
    geometry: chartGeometry()
  };
  if (extra) {
    for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key];
  }
  try {
    var res = await fetch('/api/chart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    var answer = await res.json();
    if (answer && typeof answer.rev === 'number') CHART_MY_REV = answer.rev;
    if (answer && answer.error) chartNote(answer.error);
    // The answer to our own write, so the clamps the server applied land here rather than
    // leaving the window showing something the agent's read does not agree with.
    if (answer && answer.view && CHART_DRAG === null && CHART_PUSH === null) CHART.view = answer.view;
    if (extra) void refreshChart();
    else chartInvalidate(true);
  } catch (err) {
    // A failed view write is not worth an alert line: the chart still draws, and the only
    // cost is that an agent's read is one interaction behind.
  }
}

/* A one-line answer under the chart bar, for a refused indicator or a clamped parameter.
   It clears itself: nothing on this page is allowed to accumulate chrome. */
function chartNote(text) {
  var meta = document.getElementById('chart-meta');
  if (!meta) return;
  var note = chartSpan('hi', '   ' + text);
  meta.appendChild(note);
  setTimeout(function () {
    if (note.parentNode) note.parentNode.removeChild(note);
  }, 6000);
}

/* What the renderer can actually show, reported so an agent can tell whether what it asked
   for is readable rather than assuming it is. */
function chartGeometry() {
  var L = CHART_LAYOUT;
  if (!L) return null;
  var panes = [];
  for (var i = 0; i < L.panes.length; i++) {
    panes.push({ id: L.panes[i].indicator.id, label: L.panes[i].indicator.label, height: Math.round(L.panes[i].height) });
  }
  return {
    width: Math.round(L.width),
    height: Math.round(L.height),
    plotWidth: Math.round(L.plotWidth),
    priceHeight: Math.round(L.priceHeight),
    pxPerBar: Number(L.slot.toFixed(2)),
    panes: panes,
    dropped: L.dropped,
    reportedAt: new Date().toISOString()
  };
}

function chartPushed(rev) {
  // Our own echo. Anything newer came from an agent and has to repaint.
  if (typeof rev === 'number' && rev <= CHART_MY_REV) return;
  void refreshChart();
}

function candlesPushed() {
  if (CHART_DRAG) return;
  var minGap = CHART.view.granularitySec < 60 ? 200 : 5000;
  if (Date.now() - CHART_FETCH.at < minGap) return;
  void refreshChart();
}

/* ---------- the bar above the chart ---------- */

function renderChartBar() {
  var select = document.getElementById('product');
  var key = CHART.products.join(',');
  if (select && select.dataset.filled !== key) {
    select.textContent = '';
    for (var i = 0; i < CHART.products.length; i++) {
      var option = document.createElement('option');
      option.value = CHART.products[i];
      option.textContent = CHART.products[i];
      select.appendChild(option);
    }
    select.dataset.filled = key;
  }
  if (select && select.value !== CHART.view.product) select.value = CHART.view.product;

  var box = document.getElementById('timeframes');
  if (box) {
    if (box.dataset.filled !== String(CHART.timeframes.length)) {
      box.textContent = '';
      for (var t = 0; t < CHART.timeframes.length; t++) {
        var tf = CHART.timeframes[t];
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'tf';
        button.dataset.sec = String(tf.sec);
        button.textContent = tf.label;
        box.appendChild(button);
      }
      box.dataset.filled = String(CHART.timeframes.length);
    }
    var kids = box.childNodes;
    for (var k = 0; k < kids.length; k++) {
      kids[k].className = Number(kids[k].dataset.sec) === CHART.view.granularitySec ? 'tf on' : 'tf';
    }
  }

  var meta = document.getElementById('chart-meta');
  if (!meta) return;
  var line = CHART.meta.source;
  if (CHART.meta.built === 'trades') {
    var want = CHART.view.granularitySec * Math.round(CHART.view.barCount);
    if (CHART.meta.collectedSec < want) {
      // Sub-minute history does not exist to be fetched, it accumulates. Say so, rather than
      // letting a short chart read as a broken one.
      line += '  building from live trades: ' + CHART.meta.collectedSec + 's of ' + want + 's';
    }
  }
  // Squeezed past the end of what the source will serve. The window is wider than the data,
  // which is a fact about the exchange and not a fault in the chart, so it is reported in the
  // same line as the source rather than left to look like bars that failed to draw.
  var asked = Math.round(CHART.view.barCount);
  if (CHART.candles.length && CHART.candles.length < asked) {
    line += '  history ends at ' + CHART.candles.length + ' bars';
  }
  if (CHART.view.panOffset > 0) line += '  panned back ' + Math.round(CHART.view.panOffset);
  meta.textContent = '';
  // Warnings first. This line gives up its width before the controls do, so anything that
  // truncates has to be the source name, never the reason the price might be wrong.
  if (CHART.meta.stale) meta.appendChild(chartSpan('hi', 'STALE: source unreachable, showing last known   '));
  if (CHART.meta.error) meta.appendChild(chartSpan('hi', CHART.meta.error + '   '));
  meta.appendChild(chartSpan('faint', line));
  if (CHART.view.panOffset > 0) {
    var live = chartSpan('tf', '» live');
    live.id = 'chart-live';
    meta.appendChild(live);
  }
  if (CHART.agentObjects > 0) {
    meta.appendChild(chartSpan('faint', '  agent drew ' + CHART.agentObjects + ' '));
    var clear = chartSpan('tf', '[clear]');
    clear.id = 'chart-clear-agent';
    meta.appendChild(clear);
  }
}

function chartSpan(className, text) {
  var span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

/* ---------- interaction ---------- */

function localPoint(ev) {
  var rect = chartHud().getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, w: rect.width, h: rect.height };
}

function regionAt(point) {
  var L = CHART_LAYOUT;
  if (!L) return 'plot';
  if (point.x >= L.plotWidth) return 'price';
  if (point.y >= L.axisTop) return 'time';
  return 'plot';
}

/* The ceiling is the server's, taken from the payload rather than restated here, so a drag
   that has run out of room stops where the write would have clamped it instead of springing
   back a frame later. The pair below is only what holds before the first payload lands. */
var CHART_BARS = { min: 10, max: 2000 };

function setBarCount(next) {
  CHART.view.barCount = clampNum(next, CHART_BARS.min, CHART_BARS.max);
}

function setPan(next) {
  CHART.view.panOffset = clampNum(next, -CHART.view.barCount * 0.25, 400);
}

/* The range in force right now. Reading it from the view once the scale is manual, rather
   than from the last drawn layout, is what lets two pointer moves inside one animation
   frame both land: the layout is a frame behind, the view is not. */
function currentRange() {
  var scale = CHART.view.priceScale;
  if (scale && scale.mode === 'manual') return { low: scale.low, high: scale.high };
  var L = CHART_LAYOUT;
  return L ? { low: L.low, high: L.high } : { low: 0, high: 1 };
}

/* Manual price scaling keeps the price under the pointer where it is. Scaling about the
   middle instead, which is the easy version, slides the whole chart under the hand. */
function scalePriceAbout(anchorPrice, factor) {
  var range = currentRange();
  var span = range.high - range.low;
  if (!(span > 0)) return;
  var newSpan = clampNum(span * factor, 1e-9, Math.abs(anchorPrice || 1) * 1e6);
  var ratio = (range.high - anchorPrice) / span;
  var newHigh = anchorPrice + newSpan * ratio;
  CHART.view.priceScale = { mode: 'manual', low: newHigh - newSpan, high: newHigh };
}

function shiftPrice(deltaPx) {
  var L = CHART_LAYOUT;
  if (!L) return;
  var range = currentRange();
  var move = deltaPx * ((range.high - range.low) / Math.max(1, L.priceHeight));
  CHART.view.priceScale = { mode: 'manual', low: range.low + move, high: range.high + move };
}

/* Zoom about the pointer: the bar under the cursor is still under the cursor afterwards.
   Zooming about the right edge instead, which is the easy version, makes the reader chase
   whatever they were looking at across the screen. */
function zoomAboutX(x, factor) {
  var L = CHART_LAYOUT;
  if (!L) return;
  var anchor = L.indexAt(x);
  setBarCount(CHART.view.barCount * factor);
  var slot = L.barArea / CHART.view.barCount;
  var rightBar = anchor + (L.barArea - x) / slot;
  setPan(CHART.candles.length - 1 - rightBar);
}

function wireChart() {
  var hud = chartHud();
  var wrap = chartWrap();
  if (!hud || !wrap) return;

  hud.addEventListener('pointerdown', function (ev) {
    var point = localPoint(ev);
    for (var i = 0; i < CHART_HITS.length; i++) {
      var hit = CHART_HITS[i];
      if (point.x >= hit.x && point.x <= hit.x + hit.w && point.y >= hit.y && point.y <= hit.y + hit.h) {
        void pushChart({ removeIndicator: hit.remove });
        return;
      }
    }
    var region = regionAt(point);
    CHART_DRAG = {
      region: region,
      x: ev.clientX,
      y: ev.clientY,
      barCount: CHART.view.barCount,
      pan: CHART.view.panOffset,
      slot: CHART_LAYOUT ? CHART_LAYOUT.slot : 6,
      anchorPrice: CHART_LAYOUT ? CHART_LAYOUT.priceAt(point.y) : 0,
      priceMoved: false
    };
    // Capture keeps the drag alive when the pointer leaves the canvas, which is most of a
    // long pan. It throws for a pointer id the browser is not tracking, and losing the whole
    // gesture to that would be a worse bug than dragging without capture.
    try {
      hud.setPointerCapture(ev.pointerId);
    } catch (err) {
      /* no capture: the drag still runs, it just stops at the edge of the canvas */
    }
    wrap.focus();
    hud.style.cursor = region === 'plot' ? 'grabbing' : region === 'price' ? 'ns-resize' : 'ew-resize';
    ev.preventDefault();
  });

  hud.addEventListener('pointermove', function (ev) {
    var point = localPoint(ev);
    if (!CHART_DRAG) {
      var region = regionAt(point);
      hud.style.cursor = region === 'price' ? 'ns-resize' : region === 'time' ? 'ew-resize' : 'crosshair';
      if (CHART_LAYOUT && region === 'plot') {
        CHART_HOVER = { x: point.x, y: point.y, index: CHART_LAYOUT.indexAt(point.x) };
      } else {
        CHART_HOVER = null;
      }
      chartInvalidate(false);
      return;
    }

    var dx = ev.clientX - CHART_DRAG.x;
    var dy = ev.clientY - CHART_DRAG.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) CHART_DRAG.moved = true;

    if (CHART_DRAG.region === 'plot') {
      // Fractional bars, so the chart tracks the pointer instead of notching from bar to bar.
      setPan(CHART_DRAG.pan + dx / CHART_DRAG.slot);
      if (Math.abs(dy) > 3) {
        // Dragging the plot up and down takes the price scale off auto, the same way a
        // trading chart does, rather than ignoring half the gesture.
        if (!CHART_DRAG.priceMoved) {
          CHART_DRAG.priceMoved = true;
          CHART_DRAG.y = ev.clientY;
        } else {
          shiftPrice(ev.clientY - CHART_DRAG.y);
          CHART_DRAG.y = ev.clientY;
        }
      }
    } else if (CHART_DRAG.region === 'price') {
      scalePriceAbout(CHART_DRAG.anchorPrice, 1 + dy / 220);
      CHART_DRAG.y = ev.clientY;
    } else {
      /* Drag the time axis and the axis follows the hand: pull it left and the window it
         spans narrows onto fewer, wider bars, push it right and the window stretches and the
         bars squeeze. The right edge is the anchor, so the other direction moves the axis
         opposite to the pointer, which is the wrong way round however natural it looks in
         the arithmetic. */
      setBarCount(CHART_DRAG.barCount * (1 + dx / 320));
    }
    CHART_HOVER = null;
    chartInvalidate(true);
  });

  function endDrag(ev) {
    if (!CHART_DRAG) return;
    var moved = CHART_DRAG.moved === true;
    CHART_DRAG = null;
    hud.style.cursor = 'crosshair';
    if (ev && ev.pointerId !== undefined && hud.hasPointerCapture(ev.pointerId)) hud.releasePointerCapture(ev.pointerId);
    // A press that moved nothing is a click, not a gesture: it costs neither a write nor a
    // fetch. Catch up on the stream only after a real one.
    if (!moved) return;
    queueChartPush();
    void refreshChart();
  }
  hud.addEventListener('pointerup', endDrag);
  hud.addEventListener('pointercancel', endDrag);

  hud.addEventListener('pointerleave', function () {
    if (CHART_DRAG) return;
    CHART_HOVER = null;
    hud.style.cursor = '';
    chartInvalidate(false);
  });

  hud.addEventListener(
    'wheel',
    function (ev) {
      ev.preventDefault();
      var point = localPoint(ev);
      // A trackpad sends a stream of small deltas and a wheel sends few large ones, so the
      // factor comes from the size of the delta rather than only its sign.
      var magnitude = clampNum(Math.abs(ev.deltaY) / 100, 0.02, 1.2);
      if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
        var move = (ev.deltaX !== 0 ? ev.deltaX : ev.deltaY) / (CHART_LAYOUT ? CHART_LAYOUT.slot : 6);
        setPan(CHART.view.panOffset + move);
      } else {
        var factor = ev.deltaY > 0 ? 1 + magnitude * 0.3 : 1 / (1 + magnitude * 0.3);
        zoomAboutX(point.x, factor);
      }
      chartInvalidate(true);
      queueChartPush();
    },
    { passive: false }
  );

  hud.addEventListener('dblclick', function (ev) {
    var region = regionAt(localPoint(ev));
    if (region === 'price') CHART.view.priceScale = { mode: 'auto' };
    else if (region === 'time') setBarCount(120);
    else {
      setPan(0);
      CHART.view.priceScale = { mode: 'auto' };
    }
    chartInvalidate(true);
    queueChartPush();
  });

  wrap.addEventListener('keydown', function (ev) {
    var step = Math.max(1, Math.round(CHART.view.barCount * 0.1));
    if (ev.key === 'ArrowLeft') setPan(CHART.view.panOffset + step);
    else if (ev.key === 'ArrowRight') setPan(CHART.view.panOffset - step);
    else if (ev.key === '+' || ev.key === '=') setBarCount(CHART.view.barCount / 1.3);
    else if (ev.key === '-') setBarCount(CHART.view.barCount * 1.3);
    else if (ev.key === '0') {
      setPan(0);
      CHART.view.priceScale = { mode: 'auto' };
    } else return;
    ev.preventDefault();
    chartInvalidate(true);
    queueChartPush();
  });

  var product = document.getElementById('product');
  if (product) {
    product.addEventListener('change', function () {
      CHART.view.product = product.value;
      CHART.candles = [];
      chartInvalidate(true);
      void pushChart({});
    });
  }

  var timeframes = document.getElementById('timeframes');
  if (timeframes) {
    timeframes.addEventListener('click', function (ev) {
      var sec = ev.target && ev.target.dataset ? Number(ev.target.dataset.sec) : NaN;
      if (!isFinite(sec) || sec <= 0 || sec === CHART.view.granularitySec) return;
      CHART.view.granularitySec = sec;
      CHART.view.panOffset = 0;
      CHART.candles = [];
      chartInvalidate(true);
      void pushChart({});
    });
  }

  var meta = document.getElementById('chart-meta');
  if (meta) {
    meta.addEventListener('click', function (ev) {
      var id = ev.target && ev.target.id;
      if (id === 'chart-live') {
        setPan(0);
        chartInvalidate(true);
        queueChartPush();
      } else if (id === 'chart-clear-agent') {
        void pushChart({ clear: 'agent' });
      }
    });
  }

  // The chart's control surface is a command line, not a toolbar: the same vocabulary the
  // agent uses, typed. "ema 50", "rsi", "bbands 20 2.5", "clear".
  var command = document.getElementById('chart-cmd');
  if (command) {
    command.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var parsed = parseCommand(command.value);
      command.value = '';
      if (!parsed) return;
      void pushChart(parsed);
    });
  }

  if (window.ResizeObserver) {
    var observer = new ResizeObserver(function () {
      chartInvalidate(true);
    });
    observer.observe(wrap);
  } else {
    window.addEventListener('resize', function () {
      chartInvalidate(true);
    });
  }

  // The countdown in the price tag is the only thing on the chart that changes without an
  // event, and it only touches the hud.
  setInterval(function () {
    var last = CHART.candles.length ? CHART.candles[CHART.candles.length - 1] : null;
    CHART.meta.barCloseSec = last ? Math.max(0, last.t + CHART.view.granularitySec - Date.now() / 1000) : null;
    chartInvalidate(false);
  }, 1000);
}

/* "ema 50" or "bbands 20 2.5" or "remove rsi" or "clear". Positional arguments follow the
   order the catalogue declares, which is the order anyone writes them in anyway. */
var COMMAND_PARAMS = {
  sma: ['period'],
  ema: ['period'],
  wma: ['period'],
  vwap: [],
  bbands: ['period', 'mult'],
  donchian: ['period'],
  volume: ['average'],
  rsi: ['period'],
  macd: ['fast', 'slow', 'signal'],
  atr: ['period'],
  stoch: ['k', 'smooth', 'd'],
  obv: []
};

function parseCommand(raw) {
  var words = String(raw || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  var head = words[0];
  if (head === 'clear') return { clear: words[1] || 'all' };
  if (head === 'remove' || head === 'rm' || head === '-') {
    return words[1] ? { removeIndicator: words[1] } : null;
  }
  var names = COMMAND_PARAMS[head];
  if (!names) return null;
  var params = {};
  for (var i = 0; i < names.length && i + 1 < words.length; i++) {
    var value = Number(words[i + 1]);
    if (isFinite(value)) params[names[i]] = value;
  }
  return { addIndicator: { type: head, params: params } };
}

function chartBoot() {
  wireChart();
  chartInvalidate(true);
  void refreshChart();
  // A floor under the push stream: a dead socket or an idle book still refreshes.
  setInterval(function () {
    if (Date.now() - CHART_FETCH.at > 15000) void refreshChart();
  }, 5000);
}
