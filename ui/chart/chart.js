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

/* The chart's palette, and where it comes from.

   The design system owns these values (ui/design/tokens.css, and the token table in the v1
   spec). They are written out here as well because a canvas cannot read a CSS variable while
   it draws, and because the first frame is painted before any stylesheet has been consulted:
   a chart drawn black on black for one frame is worse than one duplicated constant. readTokens
   below pulls the live values off the document at boot, so the stylesheet stays the source of
   truth and this table is only the floor.

   Up is #3FFF6C, the phosphor green the app is named for and the accent slot for the whole
   application; down is #FF5A6E. The chart is not the one surface with its own hue, because the
   green is the window's green.

   This pair was blue and red for a while, chosen because blue against red is separable by the
   roughly one person in twelve who cannot separate green from red. It cost the product its
   identity and read to its owner as a filter laid over the app, so green is the default again.
   The accessible pairing is not gone: up and down are theme slots, so set_theme up #5B8DEF
   restores it in one call, and no code has to change. What keeps this readable for everyone
   meanwhile is that the two are far apart in luminance rather than only in hue, and that a
   candle's meaning is carried by where it sits, not by what colour it is.

   Down is still lighter than the approval gate's alarm red so the gate stays the only alarm on
   the page. Nothing here can repaint that gate: it is a CSS token this file never touches. */
var CHART_TOKENS = {
  bg0: '#161210',
  bg1: '#1e1917',
  line: '#302a26',
  text: '#f8f0e8',
  text2: '#bcaea1',
  up: '#52e893',
  down: '#ff6b5b',
  agent: '#B79CFF',
  warn: '#F5B942'
};

// The panel, not the window ground. The chart sits inside a panel and painting it --bg-0
// would make it a hole rather than a surface.
var C_BG = CHART_TOKENS.bg1;
var C_UP = CHART_TOKENS.up;
var C_DOWN = CHART_TOKENS.down;
var C_HI = '#a2f2c4';

/* The ramps every ink in the engine is mixed from. Triples rather than hex, because every
   call site wants an alpha and building "rgba(...)" from a triple is one concatenation. */
var RGB_ACCENT = '82, 232, 147';
var RGB_DOWN = '255, 107, 91';
var RGB_AGENT = '183, 156, 255';
var RGB_LINE = '48, 42, 38';
var RGB_TEXT = '248, 240, 232';
var RGB_TEXT2 = '188, 174, 161';

/* "#5b8def" or "#5be" to "91, 141, 239". Returns null on anything else, and every caller
   treats null as "leave the colour alone": a bad value from the server must never be able to
   blank the chart. The server refuses non-hex before it ever gets here; this is the second
   wall, because a colour is the one agent-supplied string that reaches a canvas.

   "rgb(246, 246, 246)" is read too, because that is the shape theme.js writes every token in
   once a theme has been applied. Until it was, a token read off the document after the first
   theme frame was refused here and the dark fallback stood: invisible on graphite, and a dark
   chart on any light ground an agent set. */
function rgbTriple(hex) {
  if (typeof hex !== 'string') return null;
  var value = hex.trim().toLowerCase();
  var rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(value);
  if (rgb) {
    var parts = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (parts[0] > 255 || parts[1] > 255 || parts[2] > 255) return null;
    return parts.join(', ');
  }
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(value)) return null;
  if (value.length === 4) {
    value = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
  }
  return parseInt(value.slice(1, 3), 16) + ', ' + parseInt(value.slice(3, 5), 16) + ', ' + parseInt(value.slice(5, 7), 16);
}

/* The bright tint, mixed from the accent toward white rather than carried as a sixth slot.
   One accent has to recolour the whole terminal coherently, and a highlight that stayed green
   while everything else turned amber would read as a fault rather than a choice. */
function lighten(hex, amount) {
  var triple = rgbTriple(hex);
  if (triple === null) return hex;
  var parts = triple.split(', ');
  var out = [];
  for (var i = 0; i < 3; i++) {
    out.push(Math.round(Number(parts[i]) + (255 - Number(parts[i])) * amount));
  }
  return 'rgb(' + out.join(', ') + ')';
}

/* A slot the window is actually carrying. The guard that used to sit here compared each slot
   against the old green defaults and refused them, because a state frame carrying DEFAULT_THEME
   would have repainted this canvas green on the first tick. src/view/theme.ts now ships the
   design tokens, so there is nothing left to refuse: every slot that arrives is either the
   token this file already uses or a colour somebody chose. */
function chosen(value) {
  if (typeof value !== 'string') return null;
  return rgbTriple(value);
}

/* Called by app.js on every state frame. Cheap and idempotent: it compares before it repaints,
   so the once-a-second state read does not force a full scene redraw for nothing.

   What a theme may repaint is narrower than it was. The candles, the ground and the agent's own
   ink are per-window choices and stay. The grids, the axes and the labels are not: they are
   --line and --text-2, structure rather than accent, and a window whose chrome tracked whatever
   hue somebody typed is what made this engine one colour at edit time instead of a chart with a
   palette. The bright highlight follows the chosen accent, because it is a highlight. */
function chartTheme(theme) {
  if (!theme) return;
  var accent = chosen(theme.accent);
  var ground = chosen(theme.background);
  var up = chosen(theme.up);
  var down = chosen(theme.down);
  var agent = chosen(theme.agent);
  var before = [C_BG, C_UP, C_DOWN, C_HI, RGB_ACCENT, RGB_DOWN, RGB_AGENT, RGB_LINE, RGB_TEXT, RGB_TEXT2].join('|');

  /* The structure first. The grid, the axes and the labels come from tokens no slot carries,
     so they are read off the document again here rather than once at boot. The slots below
     then land on top, as they always did. */
  readTokens();

  if (accent !== null) C_HI = lighten(theme.accent, 0.45);
  if (ground !== null) C_BG = 'rgb(' + ground + ')';
  if (up !== null) {
    C_UP = 'rgb(' + up + ')';
    RGB_ACCENT = up;
  }
  if (down !== null) {
    C_DOWN = 'rgb(' + down + ')';
    RGB_DOWN = down;
  }
  if (agent !== null) RGB_AGENT = agent;

  if ([C_BG, C_UP, C_DOWN, C_HI, RGB_ACCENT, RGB_DOWN, RGB_AGENT, RGB_LINE, RGB_TEXT, RGB_TEXT2].join('|') === before) return;
  if (typeof chartInvalidate === 'function') chartInvalidate(true);
}
window.chartTheme = chartTheme;

/* Geist, the face every word and every figure in the window is set in, at 11 px on the
   canvas: the axis, the legend, the time labels and the price tag are figures on the text's
   own line, as they are everywhere else in the window. */
var CHART_FONT = '11px "Geist", ui-sans-serif, system-ui, sans-serif';
var CHART_FONT_SMALL = '9px "Geist", ui-sans-serif, system-ui, sans-serif';

/* Tabular figures on a canvas. A canvas cannot turn font-variant-numeric on, and Geist's own
   digits are proportional (a 1 is half an 8), so a price that ticked moved everything beside
   it. A run of digits is drawn one digit to a cell as wide as the face's widest digit, each
   centred in its cell, and everything else is drawn as the words it is, so a column of prices
   reads down its decimal point and the words keep their own spacing. Every figure the engine
   and the label column draw goes through these two. */
var CHART_TEXT_CELLS = {};
function digitCell(ctx) {
  var key = ctx.font;
  if (CHART_TEXT_CELLS[key] === undefined) {
    var wide = 0;
    var narrow = Infinity;
    for (var d = 0; d <= 9; d++) {
      var w = ctx.measureText(String(d)).width;
      wide = Math.max(wide, w);
      narrow = Math.min(narrow, w);
    }
    // A face whose digits are one width already (a fallback, a mono) is drawn as it is.
    CHART_TEXT_CELLS[key] = { cell: wide, even: wide - narrow < 0.01 };
  }
  return CHART_TEXT_CELLS[key];
}

function textRuns(text) {
  return String(text).match(/[0-9]+|[^0-9]+/g) || [];
}

function textWidth(ctx, text) {
  var s = String(text);
  var digits = digitCell(ctx);
  if (digits.even || !/[0-9]/.test(s)) return ctx.measureText(s).width;
  var runs = textRuns(s);
  var width = 0;
  for (var i = 0; i < runs.length; i++) {
    width += /^[0-9]/.test(runs[i]) ? runs[i].length * digits.cell : ctx.measureText(runs[i]).width;
  }
  return width;
}

function drawText(ctx, text, x, y) {
  var s = String(text);
  var digits = digitCell(ctx);
  if (digits.even || !/[0-9]/.test(s)) {
    ctx.fillText(s, x, y);
    return;
  }
  var align = ctx.textAlign;
  var total = textWidth(ctx, s);
  var at = align === 'right' || align === 'end' ? x - total : (align === 'center' ? x - total / 2 : x);
  var runs = textRuns(s);
  ctx.textAlign = 'left';
  for (var i = 0; i < runs.length; i++) {
    if (/^[0-9]/.test(runs[i])) {
      for (var k = 0; k < runs[i].length; k++) {
        var ch = runs[i].charAt(k);
        ctx.fillText(ch, at + (digits.cell - ctx.measureText(ch).width) / 2, y);
        at += digits.cell;
      }
    } else {
      ctx.fillText(runs[i], at, y);
      at += ctx.measureText(runs[i]).width;
    }
  }
  ctx.textAlign = align;
}
window.chartText = { draw: drawText, width: textWidth };
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Geometry, in CSS pixels. PRICE_MIN is the promise that nothing gets squeezed: a pane that
   would push the price pane under it is dropped and reported, never crammed in. */
var AXIS_BOTTOM = 18;
/* The legend's own strip above the plot. The market line used to print over the top candles;
   it has 22 px of its own now, centred on LEGEND_Y, and the pane starts under it. */
var PAD_TOP = 22;
var LEGEND_Y = 11;
/* The first line of the label column, measured down from the top of the price pane. */
var COLUMN_Y = 10;
var PRICE_MIN = 150;
var PANE_MIN = 56;
var PANE_MAX = 96;
var PRICE_PAD = 0.06; // headroom above and below the auto-fitted range
var GRID_PRICE_GAP = 46; // target pixels between price grid lines
var GRID_TIME_GAP = 96;
/* A date is a short label (`16 Sep` is six characters) and a day tick is worth having a little
   closer than a clock tick: a five day chart in a half width pane used to climb to the week
   rung at 90 px a day and print one Monday. */
var GRID_DATE_GAP = 72;

/* The server's sentinel for a calendar month: the mean Gregorian month in seconds. A month is
   not a fixed number of seconds, so it travels as this number and every place that buckets by
   it uses the calendar instead (liveBucket, the axis). Mirrors MONTH_SEC in src/market/aggregate.ts. */
var MONTH_SEC = 2629746;
var YEAR_SEC = 31556952;

/* The rungs of the time axis, coarsest last. A rung under a day is a fixed number of seconds on
   the clock of the zone the axis prints in; the rest are calendar units, because a month is not
   a number of seconds and a week that opens on Thursday is not a week anyone trades. `sec` is
   only the rung's nominal size, for choosing one that leaves GRID_TIME_GAP between ticks. */
var TIME_RUNGS = [
  { sec: 60 }, { sec: 300 }, { sec: 900 }, { sec: 1800 }, { sec: 3600 }, { sec: 7200 }, { sec: 14400 }, { sec: 21600 }, { sec: 43200 },
  { sec: 86400, unit: 'day' },
  { sec: 604800, unit: 'week', n: 1 },
  { sec: 604800 * 2, unit: 'week', n: 2 },
  { sec: MONTH_SEC, unit: 'month', n: 1 },
  { sec: MONTH_SEC * 3, unit: 'month', n: 3 },
  { sec: YEAR_SEC, unit: 'year', n: 1 },
  { sec: YEAR_SEC * 2, unit: 'year', n: 2 },
  { sec: YEAR_SEC * 5, unit: 'year', n: 5 },
  { sec: YEAR_SEC * 10, unit: 'year', n: 10 },
  { sec: YEAR_SEC * 25, unit: 'year', n: 25 }
];

// False until the first /api/chart payload lands. Guards the view write-back: see
// queueChartPush for what pushing before the server has been heard from costs.
var CHART_READY = false;

var CHART = {
  rev: 0,
  view: { product: '', provider: 'auto', granularitySec: 60, barCount: 120, panOffset: 0, priceScale: { mode: 'auto' } },
  candles: [],
  /* The series the indicator values on screen were computed over, as the server names it: its
     first and last open time and its length, plus the same fact hashed to one number. The array
     above is not that series: it keeps older bars backfilled behind the left edge and newer ones
     folded in off the live rail. See applyChart for how a plot is laid over it. */
  candlesRev: 0,
  series: null,
  /* What the candles on screen actually are, which is not always what the controls ask for.
     The view is a request and can run ahead of the data by a round trip, or sit on an
     instrument the server has stopped serving. The legend names this instead, so a price
     can never be printed under another market's name. */
  dataView: null,
  meta: { source: '', stale: false, built: '', error: null },
  indicators: [],
  levels: [],
  marks: [],
  drawings: [],
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
/* `at` is the last FULL fetch: the floor poll and the candle nudge read it to decide whether the
   candles are due, and a markup part refreshes no candle. A queued refresh is the widest part
   anyone asked for while the wire was busy. */
var CHART_FETCH = { inflight: false, at: 0, queued: false, queuedPart: '', bytes: 0 };
/* Candles the window keeps at most. Well past anything one payload carries: the array grows by
   backfill behind the left edge and by live bars at the right, and only the oldest go when it
   is over, and only while the window sits at the live edge. */
var CHART_KEEP_MAX = 50000;
var CHART_PUSH = null; // debounce timer for writing the view back
/* Writes of ours that are on the wire. A payload that left the server before our write
   arrived cannot answer it, so it is not allowed to overrule the hand that just moved. */
var CHART_PUSH_WAIT = 0;
var CHART_DRAG = null;
/* The price axis, and the gutter the tag and its countdown live in. It is measured from the
   labels it carries, but the floor is not about labels: the last price tag and the draining
   rule under it both sit in this column, and at 48 the two were competing for it. */
var CHART_AXIS_W = 72;
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

/* Four inks, named for what they mean rather than for a colour, which is the whole reason the
   engine could not be recoloured before: a function called green() returning blue is a comment
   that lies, and there were thirty eight of them. */
function accent(alpha) {
  return 'rgba(' + RGB_ACCENT + ', ' + alpha + ')';
}
function danger(alpha) {
  return 'rgba(' + RGB_DOWN + ', ' + alpha + ')';
}
// Hairlines and separators: --line. It is a colour, not a tint of the accent, so the alphas
// beside it are higher than the ones the accent ramp used for the same lines.
function lineInk(alpha) {
  return 'rgba(' + RGB_LINE + ', ' + alpha + ')';
}
function textInk(alpha) {
  return 'rgba(' + RGB_TEXT + ', ' + alpha + ')';
}
function text2(alpha) {
  return 'rgba(' + RGB_TEXT2 + ', ' + alpha + ')';
}

/* The live values, read off the document once the stylesheet is in. Called from chartBoot, so
   a token Track E changes moves the canvas without this file being edited. Anything missing or
   malformed leaves the constant above in place: a stylesheet that has not loaded must not be
   able to blank the chart. */
function readTokens() {
  if (typeof window.getComputedStyle !== 'function' || !document.documentElement) return;
  var style = window.getComputedStyle(document.documentElement);
  var slots = [
    ['bg1', 'bg-1'],
    ['line', 'line'],
    ['text', 'text'],
    ['text2', 'text-2'],
    ['up', 'up'],
    ['down', 'down'],
    ['agent', 'agent'],
    ['warn', 'warn']
  ];
  for (var i = 0; i < slots.length; i++) {
    var value = String(style.getPropertyValue('--' + slots[i][1]) || '').trim();
    if (rgbTriple(value) !== null) CHART_TOKENS[slots[i][0]] = value;
  }
  C_BG = CHART_TOKENS.bg1;
  C_UP = CHART_TOKENS.up;
  C_DOWN = CHART_TOKENS.down;
  C_HI = lighten(CHART_TOKENS.up, 0.45);
  RGB_ACCENT = rgbTriple(CHART_TOKENS.up) || RGB_ACCENT;
  RGB_DOWN = rgbTriple(CHART_TOKENS.down) || RGB_DOWN;
  RGB_AGENT = rgbTriple(CHART_TOKENS.agent) || RGB_AGENT;
  RGB_LINE = rgbTriple(CHART_TOKENS.line) || RGB_LINE;
  RGB_TEXT = rgbTriple(CHART_TOKENS.text) || RGB_TEXT;
  RGB_TEXT2 = rgbTriple(CHART_TOKENS.text2) || RGB_TEXT2;
}
/* The ink the agent's own drawings are in. Defaults to the accent, so until someone sets it
   the chart looks exactly as it did and the dash pattern is still what tells the two apart. */
function agentInk(alpha) {
  return 'rgba(' + RGB_AGENT + ', ' + alpha + ')';
}
function warnInk(alpha) {
  return 'rgba(' + (rgbTriple(CHART_TOKENS.warn) || '245, 185, 66') + ', ' + alpha + ')';
}

/* One palette for every label on the canvas, named by meaning. The label column and the trade
   overlays ask for a tone and get the token behind it, so nothing drawn over the candles carries
   a colour of its own: liquidation is --down, a wall is --warn, the agent's objects are --agent. */
function chartInk(tone, alpha) {
  var a = alpha === undefined ? 0.9 : alpha;
  if (tone === 'up' || tone === 'ink') return accent(a);
  if (tone === 'down') return danger(a);
  if (tone === 'agent') return agentInk(a);
  if (tone === 'warn') return warnInk(a);
  if (tone === 'text2') return text2(a);
  if (tone === 'hi') return C_HI;
  return textInk(a);
}

/* The ground behind a label that sits over candles, mixed from the panel's own colour. */
function chartLabelPad() {
  return 'rgba(' + (rgbTriple(CHART_TOKENS.bg1) || '17, 20, 24') + ', 0.72)';
}

/* Everything the scene wants written down the left edge, collected while it draws and placed
   by the hud in one pass with the legend (see ui/chart/labels.js). Reset per scene draw; a hud
   redraw between two scenes reuses the last set, which is the set the lines on screen have. */
var CHART_SCENE_LABELS = [];
function chartLabel(item) {
  CHART_SCENE_LABELS.push(item);
}

/* A level off the top or the bottom of the pane has no line to draw, and a label pinned to the
   plot's edge printed over the candles. It becomes a chip on the price axis instead, at the edge
   it went off: a short word, an arrow and the price, in the line's own ink. Collected while the
   scene draws, stacked once it has (chipLayout), drawn by the hud. Item: {price, edge 'top' or
   'bottom', word, tone, ring}. */
var CHART_AXIS_CHIPS = [];
function chartAxisChip(item) {
  CHART_AXIS_CHIPS.push(item);
}

/* Whether the agent is pointing at this object right now. ui/screens/trade.js owns the
   spotlight and answers through this hook; a page without it has nothing pointed at. */
function chartSpotOn(kind, id) {
  return typeof window.chartSpotActive === 'function' && window.chartSpotActive(kind, id) === true;
}

/* The label as the human reads it. The server tags everything an agent draws with a literal
   `[agent] ` it cannot write its way out of (src/chart.ts), and that tag is what the agent
   reads back; on the canvas the word became a wall of brackets down the left edge. Here the
   word comes off and the agent's own ink and a drawn dot say the same thing (labelGlyph
   'agent'). The bare label is what is drawn; the source field is what decides the dot. */
function labelText(label) {
  var text = String(label || '');
  if (text.indexOf('[agent] ') === 0) text = text.slice(8);
  else if (text.indexOf('[agent]') === 0) text = text.slice(7).replace(/^\s+/, '');
  if (text.slice(-8) === ' [agent]') text = text.slice(0, -8);
  return text;
}

/* The parts that open every label of an object: the agent's dot when the agent drew it. */
function labelLead(source, alpha) {
  return source === 'agent' ? [{ glyph: 'agent', tone: 'agent', alpha: alpha === undefined ? 0.9 : alpha }] : [];
}

/* The boxes the label column drew last frame, by the id of the object a cross would remove,
   so the cross can be shown only under the pointer: a column of crosses beside every study
   read as controls where the reader wanted the numbers. The hit target is the cross, and the
   cross is there when the pointer is on the label; the box is widened by the cross's own
   advance so reaching for it does not make it vanish. */
var CHART_LABEL_BOXES = {};

function labelHovered(id) {
  if (!CHART_HOVER || !id) return false;
  var box = CHART_LABEL_BOXES[id];
  if (!box) return false;
  return CHART_HOVER.x >= box.x && CHART_HOVER.x <= box.x + box.w + 20 && CHART_HOVER.y >= box.y && CHART_HOVER.y <= box.y + box.h;
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

/* ---------- the calendar behind the time axis ----------

   Intraday bars are read in the zone the person is in: a 1m chart at midnight is midnight on
   their wall clock. A daily bar is the venue's day, opened at 00:00 UTC and named by that date
   wherever it is read, so from a day up the axis and the crosshair use UTC. Every stamp on the
   chart comes through these two so the two calendars can never meet on one label. */
function axisZoneUtc(granularity) {
  return granularity >= 86400;
}

function timeParts(tSec, utc) {
  var d = new Date(tSec * 1000);
  if (utc) return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), wd: d.getUTCDay(), clock: tSec };
  return { y: d.getFullYear(), m: d.getMonth(), day: d.getDate(), hh: d.getHours(), mm: d.getMinutes(), wd: d.getDay(), clock: tSec - d.getTimezoneOffset() * 60 };
}

function clockText(parts) {
  return pad2(parts.hh) + ':' + pad2(parts.mm);
}

function dayText(parts) {
  return parts.day + ' ' + MONTHS[parts.m];
}

/* What the crosshair prints for the bar under the pointer: the date on every timeframe, the
   time too under a day, the year from a day up. A stamp that only said 14:07 left the reader
   working out which day a panned chart was on. */
function crosshairStamp(tSec, granularity) {
  var parts = timeParts(tSec, axisZoneUtc(granularity));
  if (granularity >= MONTH_SEC) return MONTHS[parts.m] + ' ' + parts.y;
  if (granularity >= 86400) return dayText(parts) + ' ' + parts.y;
  return dayText(parts) + ' ' + clockText(parts);
}

/* Which bucket of a rung a bar falls in, so a tick is the first bar of a new bucket. Weeks
   open on Monday like bucketStart in src/market/aggregate.ts, not on the Thursday the epoch
   started on. */
function rungKey(rung, parts) {
  if (rung.unit === 'day') return Math.floor(parts.clock / 86400);
  if (rung.unit === 'week') return Math.floor((parts.clock - 345600) / (604800 * rung.n));
  if (rung.unit === 'month') return Math.floor((parts.y * 12 + parts.m) / rung.n);
  if (rung.unit === 'year') return Math.floor(parts.y / rung.n);
  return Math.floor(parts.clock / rung.sec);
}

/* Which rung of the calendar a step lives on: 0 the clock, 1 the day, 2 the month, 3 the year. */
function rungLevel(rung) {
  if (rung.unit === 'year') return 3;
  if (rung.unit === 'month') return 2;
  if (rung.unit) return 1;
  return 0;
}

/* The largest unit that changed between two moments, on the same scale. */
function changedLevel(prev, next) {
  if (prev.y !== next.y) return 3;
  if (prev.m !== next.m) return 2;
  if (prev.day !== next.day) return 1;
  return 0;
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
  /* Mid-tween this is a blend of where the view was and where it is going. Everywhere else in
     the file that needs the view for a WRITE still reads CHART.view, which is already the
     target: see tweenedView above for why the two are deliberately different. */
  var view = tweenedView();
  var candles = CHART.candles;

  var overlays = [];
  var paneIndicators = [];
  var hasVolume = false;
  for (var i = 0; i < CHART.indicators.length; i++) {
    var ind = CHART.indicators[i];
    if (ind.pane === 'price') overlays.push(ind);
    else paneIndicators.push(ind);
    if (isVolumeIndicator(ind)) hasVolume = true;
  }
  // Volume is a default, not something to type. Every chart a trader compares this one to
  // shows it without being asked, and it was an indicator you had to know the word for.
  // Built here rather than fetched, so it is exactly the candles being drawn: a socket bar
  // folded in by candleLive moves the histogram in the same frame it moves the price.
  var volumePane = VOLUME_ON && !hasVolume ? volumeIndicator(candles) : null;

  var usable = height - AXIS_BOTTOM - PAD_TOP;
  var paneCount = paneIndicators.length;
  var paneHeight = clampNum(usable * 0.19, PANE_MIN, PANE_MAX);
  // Volume is shorter than an indicator pane. It is read as a shape beside the price, not as
  // a series with values to pick off, so it gets the 14 percent the design calls for.
  var volumeHeight = volumePane === null ? 0 : clampNum(usable * 0.14, 40, PANE_MAX);
  /* Drop panes off the bottom until the price pane is readable again. A chart that quietly
     squashes everything to fit is worse than one that says what it could not show.

     Volume goes FIRST, and silently. It is the only pane on the chart nobody asked for, so a
     short panel that can hold one indicator has to hold the indicator: taking a typed pane off
     to keep a default would be the chart overruling the person using it. */
  if (volumePane !== null && usable - volumeHeight - paneCount * paneHeight < PRICE_MIN) {
    volumePane = null;
    volumeHeight = 0;
  }
  while (paneCount > 0 && usable - volumeHeight - paneCount * paneHeight < PRICE_MIN) paneCount--;
  var dropped = paneIndicators.slice(paneCount).map(function (p) {
    return p.label;
  });
  var shownPanes = paneIndicators.slice(0, paneCount);
  if (volumePane !== null) shownPanes = [volumePane].concat(shownPanes);

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

  var priceHeight = usable - volumeHeight - paneCount * paneHeight;
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
    // Volume is the one pane with a height of its own; every other one shares the budget.
    var tall = pane === volumePane ? volumeHeight : paneHeight;
    panes.push({ indicator: pane, top: top, height: tall, low: lo, high: hi });
    top += tall;
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
    textWidth(ctx, priceText(high, decimals)),
    textWidth(ctx, priceText(low, decimals))
  );
  var wanted = clampNum(Math.ceil(widest) + 16, 66, 112);
  /* The axis is measured from the frame just drawn and applied to the next one, which is fine
     for a static chart and visibly wrong during a tween: a price magnitude crossing a digit
     boundary makes the whole plot width step sideways a frame late, mid-motion. So while a
     tween runs the axis may only GROW. It settles to the real width on the frame after the
     tween lands, by which point nothing is moving for it to drag. */
  var shrinking = wanted < CHART_AXIS_W;
  if (Math.abs(wanted - CHART_AXIS_W) > 2 && !(CHART_TWEEN && shrinking)) {
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
    axisTop: PAD_TOP + priceHeight + volumeHeight + paneCount * paneHeight,
    xOf: xOf,
    yOf: yOf,
    indexAt: indexAt,
    priceAt: priceAt
  };
}

/* ---------- the volume pane ----------

   Not an indicator. It is built in the window from the candles being drawn, which is what makes
   it default-on without the agent's indicator list growing an entry nobody added, and what makes
   it move with a live bar instead of with the next server payload.

   An indicator the human or the agent actually typed still wins: a `volume` command puts a real
   one on the chart, computed by src/indicators.ts alongside every other, and this steps aside so
   the same histogram is not drawn twice. */
var VOLUME_ON = true;
var VOLUME_ID = '__volume';

function isVolumeIndicator(ind) {
  if (!ind || ind.pane === 'price') return false;
  var label = String(ind.label || ind.id || '').toLowerCase();
  return label === 'volume' || label.indexOf('volume') === 0;
}

/* The histogram, plus the direction beside it. They are separate series on purpose: volume is
   never negative, so folding the direction into the value would put half the bars under an axis
   that does not exist. drawPaneHistogram already knows this shape. */
function volumeIndicator(candles) {
  var values = new Array(candles.length);
  var signs = new Array(candles.length);
  for (var i = 0; i < candles.length; i++) {
    var bar = candles[i];
    values[i] = typeof bar.v === 'number' && isFinite(bar.v) ? bar.v : null;
    signs[i] = bar.c >= bar.o ? 1 : -1;
  }
  return {
    id: VOLUME_ID,
    label: 'volume',
    pane: 'volume',
    source: 'window',
    plots: [{ key: 'v', style: 'histogram', values: values, signs: signs }]
  };
}

/* Collapsible, from the pane's own label. There is no room on the control row for a switch
   nobody will touch twice, and the label is already drawn where a person would look for it. */
function toggleVolume() {
  VOLUME_ON = !VOLUME_ON;
  try {
    window.localStorage.setItem('phosphor.chart.volume', VOLUME_ON ? '1' : '0');
  } catch (err) {
    // A window with storage blocked still draws a chart; it just forgets this between loads.
  }
  chartInvalidate(true);
}

/* The Layers popover's own switch for the pane, and the answer it draws its check from. */
function chartSetVolume(on) {
  if (VOLUME_ON === !!on) return;
  toggleVolume();
}
function chartVolumeOn() {
  return VOLUME_ON;
}
window.chartSetVolume = chartSetVolume;
window.chartVolumeOn = chartVolumeOn;

function readVolumePreference() {
  try {
    if (window.localStorage.getItem('phosphor.chart.volume') === '0') VOLUME_ON = false;
  } catch (err) {
    /* see toggleVolume */
  }
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
  var running = tweenStep();
  if (chartResize()) CHART_DIRTY.scene = true;
  if (CHART_DIRTY.scene) {
    CHART_DIRTY.scene = false;
    drawScene();
  }
  if (CHART_DIRTY.hud) {
    CHART_DIRTY.hud = false;
    drawHud();
  }
  /* The rAF above is self-cancelling: chartFrame clears CHART_FRAME on entry and nothing
     re-arms it, which is correct for a chart that only redraws on input. A tween is the one
     thing here that has to keep drawing with no input at all, so it re-arms its own loop and
     stops the moment it lands. Re-armed directly rather than through chartInvalidate, because
     that would mark the scene dirty on behalf of a tween that may only own the hud. */
  if (running && !CHART_FRAME) CHART_FRAME = window.requestAnimationFrame(chartFrame);
}

/* ---------- the view tween ----------

   The agent moves this chart, and until now every move it made was an instant assignment: the
   window was at 120 bars and then it was at 400, with no frame in between. On a surface whose
   whole claim is that you watch a machine work, a jump cut is the one thing that reads as the
   screen being redrawn rather than the instrument being driven.

   What is tweened is deliberately small. The pan, the zoom, and a manual price scale are the
   three things that are the SAME data seen through a different window, so interpolating them
   is honest: every intermediate frame is a real view of real candles. The product and the
   timeframe are not tweened and must not be, because the candles themselves change. Sliding
   BTC's bars into SOL's would be an animation of something that never happened. Those two
   clear the pane and let the existing waiting skeleton carry the gap, and the auto-fit in
   src/chart.ts is what makes the new instrument land correctly scaled instead of off-axis.

   Timing is the servo kind: quick off the mark, hard settle, no overshoot. There is no easing
   token on this surface to borrow (--ease-out is basic-only) and none is introduced: this
   lives in the canvas, alongside the drag and the wheel, which have always moved continuously
   without reading as a second design language. */

var CHART_TWEEN = null;
var TWEEN_MS = 320;

/* The last price tag and its line, eased.

   This is the smallest of the three tweens and the one a person notices, because the tag is
   the only filled block on the surface and a live rail moves it several times a second. Before
   the rail it teleported every four seconds, which reads as a screen being redrawn; eased over
   120 ms it reads as an instrument moving. The token is --dur-enter's smaller sibling in the
   design system: 120 ms for the chart's last-price tag and line.

   What is eased is the POSITION, never the figure. An interpolated price is a price that never
   traded, and this tag is the one number on the chart a person reads without looking for it. */
var CHART_PRICE_TWEEN = null;
var PRICE_TWEEN_MS = 120;

function startPriceTween(next) {
  if (typeof next !== 'number' || !isFinite(next)) return;
  var from = shownPrice();
  if (from === null || from === next || reducedMotion()) {
    CHART_PRICE_TWEEN = null;
    return;
  }
  CHART_PRICE_TWEEN = {
    from: from,
    to: next,
    t0: window.performance && performance.now ? performance.now() : Date.now()
  };
}

/* Where the tag is drawn right now, which mid-ease is between two real prices and everywhere
   else is the close itself. Null before there is anything to draw. */
function shownPrice() {
  if (CHART_PRICE_TWEEN) {
    var now = window.performance && performance.now ? performance.now() : Date.now();
    var t = (now - CHART_PRICE_TWEEN.t0) / PRICE_TWEEN_MS;
    if (t >= 1) return CHART_PRICE_TWEEN.to;
    return CHART_PRICE_TWEEN.from + (CHART_PRICE_TWEEN.to - CHART_PRICE_TWEEN.from) * easeServo(t < 0 ? 0 : t);
  }
  var candles = CHART.candles;
  return candles.length ? candles[candles.length - 1].c : null;
}

function easeServo(t) {
  /* easeOutCubic. Reaches 90% in the first half, then settles. */
  var u = 1 - t;
  return 1 - u * u * u;
}

/* Only the three window fields, and only when both ends agree on the price mode. A change of
   mode (auto to manual or back) snaps, because the two are different meanings of the axis and
   a blend between them is not a view anyone asked for. */
function startViewTween(next) {
  if (!next) return false;
  if (reducedMotion()) return false;
  var from = CHART.view;
  if (!from || from.product !== next.product) return false;
  if (from.granularitySec !== next.granularitySec) return false;
  var fromMode = from.priceScale ? from.priceScale.mode : 'auto';
  var nextMode = next.priceScale ? next.priceScale.mode : 'auto';
  if (fromMode !== nextMode) return false;

  var manual = fromMode === 'manual';
  var moved =
    from.barCount !== next.barCount ||
    from.panOffset !== next.panOffset ||
    (manual && (from.priceScale.low !== next.priceScale.low || from.priceScale.high !== next.priceScale.high));
  if (!moved) return false;

  CHART_TWEEN = {
    t0: (window.performance && performance.now ? performance.now() : Date.now()),
    ms: TWEEN_MS,
    manual: manual,
    barCount0: from.barCount,
    panOffset0: from.panOffset,
    low0: manual ? from.priceScale.low : 0,
    high0: manual ? from.priceScale.high : 0,
    to: next
  };
  chartInvalidate(true);
  return true;
}

/* Advances the clock and returns whether another frame is owed. The tween holds only the
   START values plus the target: CHART.view is set to the target the moment the tween begins,
   so anything that reads the view for a write (pushChart, chart_read) sees where the chart is
   GOING, never a half-way number that was never a real request. */
function tweenStep() {
  var now = window.performance && performance.now ? performance.now() : Date.now();
  var running = false;

  // The price tag lives on the hud, so an ease on it costs a nearly empty canvas rather than
  // five hundred candles. Marking the scene here instead would redraw the whole chart at frame
  // rate every time the price moved, which on a live rail is several times a second.
  if (CHART_PRICE_TWEEN) {
    CHART_DIRTY.hud = true;
    if (now - CHART_PRICE_TWEEN.t0 >= PRICE_TWEEN_MS) CHART_PRICE_TWEEN = null;
    else running = true;
  }

  if (!CHART_TWEEN) return running;
  var t = (now - CHART_TWEEN.t0) / CHART_TWEEN.ms;
  if (t >= 1) {
    CHART_TWEEN = null;
    CHART_DIRTY.scene = true;
    return running;
  }
  CHART_DIRTY.scene = true;
  return true;
}

/* The view buildLayout should draw this frame. Mid-tween it is a blend; otherwise it is just
   the view. Nothing else in the file may read CHART.view for geometry, or the tween will draw
   half its pane at the target and half at the start. */
function tweenedView() {
  if (!CHART_TWEEN) return CHART.view;
  var now = window.performance && performance.now ? performance.now() : Date.now();
  var raw = (now - CHART_TWEEN.t0) / CHART_TWEEN.ms;
  var e = easeServo(raw < 0 ? 0 : raw > 1 ? 1 : raw);
  var to = CHART_TWEEN.to;
  var mix = function (a, b) {
    return a + (b - a) * e;
  };
  var scale = { mode: 'auto' };
  if (CHART_TWEEN.manual) {
    scale = {
      mode: 'manual',
      low: mix(CHART_TWEEN.low0, to.priceScale.low),
      high: mix(CHART_TWEEN.high0, to.priceScale.high)
    };
  }
  return {
    product: to.product,
    granularitySec: to.granularitySec,
    barCount: mix(CHART_TWEEN.barCount0, to.barCount),
    panOffset: mix(CHART_TWEEN.panOffset0, to.panOffset),
    priceScale: scale
  };
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
  /* The chart sits on the world's slab, whose ground is a soft gradient: a
     canvas that painted a flat panel over it drew a rectangle on the slab. */
  var ctx = prepare(canvas, false);
  var width = CHART_SIZE.w;
  var height = CHART_SIZE.h;

  if (!CHART.candles.length) {
    drawWaiting(ctx, width, height);
    CHART_LAYOUT = null;
    return;
  }

  var L = buildLayout(width, height, ctx);
  CHART_LAYOUT = L;
  CHART_SCENE_LABELS = [];
  CHART_AXIS_CHIPS = [];
  maybeBackfill(L);

  drawPriceGrid(ctx, L);
  drawTimeGrid(ctx, L);
  drawMarks(ctx, L);
  drawOverlayBands(ctx, L);
  drawCandles(ctx, L);
  drawOverlayLines(ctx, L);
  drawLevels(ctx, L);
  // After the levels so a zone's fill sits under the horizontal lines rather than washing
  // them out, and before the panes so nothing leaks into a sub-pane's box.
  drawDrawings(ctx, L);
  // The trading page's account overlays: entries, liquidation, the mandate wall, working
  // orders, fills. Defined in ui/trade-overlay.js, which only the trading page loads, so on
  // the pro page this is one typeof check and the chart is exactly what it was before.
  if (typeof drawTradeOverlays === 'function') drawTradeOverlays(ctx, L);
  // The axis prices go down last, once every off-pane level has asked for a chip, so a price
  // under a chip is left out rather than half covered by it.
  L.chips = chipLayout(L);
  drawPriceLabels(ctx, L);
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
  var product = CHART.view.product ? coinOf(CHART.view.product) : 'the market';
  var tf = timeframeOf(CHART.view.granularitySec);
  if (CHART.meta.error) {
    return { head: 'Chart unreachable', sub: CHART.meta.error + '  retrying', live: CHART_FETCH.inflight };
  }
  if (!CHART_READY) {
    // Before the first payload there is no product and no timeframe to name, and naming the
    // defaults would put a market on screen that nobody has confirmed is the one being read.
    if (!CHART.view.product) return { head: 'Connecting', sub: 'waiting for prices', live: true };
    return { head: 'Loading ' + product + ' ' + tf, sub: 'waiting for the first prices', live: true };
  }
  return {
    head: 'No prices for ' + product + ' ' + tf,
    sub: sourceName(CHART.meta.source) + ' has nothing for this window',
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
  ctx.strokeStyle = lineInk(0.7);
  ctx.beginPath();
  for (var g = 1; g < 5; g++) {
    var y = hair(top + (area * g) / 5);
    ctx.moveTo(0, y);
    ctx.lineTo(plotWidth, y);
  }
  ctx.stroke();
  ctx.strokeStyle = lineInk(1);
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
    ctx.strokeStyle = accent(alpha * 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hair(x), cy - area * bar.wick);
    ctx.lineTo(hair(x), cy + area * bar.wick);
    ctx.stroke();
    ctx.fillStyle = accent(alpha);
    ctx.fillRect(Math.round(x - bodyWidth / 2), Math.round(cy - area * bar.body), bodyWidth, Math.max(1, Math.round(area * bar.body * 2)));
  }

  // The scan column itself, so the eye has one thing to follow instead of a field of flicker.
  if (state.live && !still && sweep >= 0 && sweep <= 1) {
    var sx = hair(6 + sweep * (count - 1) * slot);
    ctx.strokeStyle = accent(0.3);
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
  var headWidth = textWidth(ctx, headText);
  var subWidth = textWidth(ctx, state.sub);
  ctx.fillStyle = C_BG;
  ctx.fillRect(cx - Math.max(headWidth, subWidth) / 2 - 8, midY - 15, Math.max(headWidth, subWidth) + 16, 30);
  ctx.fillStyle = CHART.meta.error ? danger(0.9) : textInk(0.85);
  drawText(ctx, headText, cx, midY - 6);
  ctx.fillStyle = text2(0.85);
  drawText(ctx, state.sub, cx, midY + 8);
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
  ctx.strokeStyle = lineInk(0.7);
  ctx.fillStyle = text2(0.8);
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
  L.gridLabels = labels;
}

/* The prices down the axis, beside the grid lines drawPriceGrid laid. None prints inside the
   last price's band or under a chip: two numbers stacked in one place is the one thing that
   would make the price that matters harder to read. */
function drawPriceLabels(ctx, L) {
  var labels = L.gridLabels || [];
  var chips = L.chips || [];
  ctx.fillStyle = text2(0.8);
  ctx.textAlign = 'left';
  for (var i = 0; i < labels.length; i++) {
    var y = labels[i][1];
    if (L.reserved && y > L.reserved.top && y < L.reserved.bottom) continue;
    var covered = false;
    for (var c = 0; c < chips.length; c++) {
      if (y > chips[c].y - 7 && y < chips[c].y + CHIP_H + 7) covered = true;
    }
    if (covered) continue;
    drawText(ctx, priceText(labels[i][0], L.decimals), L.plotWidth + 6, y);
  }
}

/* ---------- the axis chips ---------- */

var CHIP_H = 29;
var CHIP_GAP = 3;
var CHIP_MAX = 3;
var CHIP_FONT = '10px "Geist", ui-sans-serif, system-ui, sans-serif';

/* Stack the chips at the edge each went off, in price order (the highest at the top of either
   stack), clear of the last price's band, three to an edge. A fourth is not dropped in silence:
   the outermost chip then says how many more sit past it. */
function chipLayout(L) {
  var top = L.priceTop;
  var bottom = L.priceTop + L.priceHeight;
  var reserved = L.reserved;
  function clash(y) {
    return reserved && y < reserved.bottom && y + CHIP_H > reserved.top;
  }
  function edge(name) {
    var list = CHART_AXIS_CHIPS.filter(function (chip) {
      return chip.edge === name;
    });
    // Nearest the pane first, so a cut keeps the levels the price will reach soonest.
    list.sort(function (a, b) {
      return name === 'top' ? a.price - b.price : b.price - a.price;
    });
    var more = Math.max(0, list.length - CHIP_MAX);
    list = list.slice(0, CHIP_MAX);
    if (more && list.length) list[list.length - 1] = Object.assign({}, list[list.length - 1], { more: more });
    return list;
  }
  var laid = [];
  var ups = edge('top').reverse();
  var y = top + 2;
  var upFloor = top;
  for (var i = 0; i < ups.length; i++) {
    if (clash(y)) y = reserved.bottom + CHIP_GAP;
    if (y + CHIP_H > bottom) break;
    laid.push(Object.assign({}, ups[i], { y: y }));
    upFloor = y + CHIP_H;
    y += CHIP_H + CHIP_GAP;
  }
  var downs = edge('bottom').reverse();
  y = bottom - 2 - CHIP_H;
  for (var j = 0; j < downs.length; j++) {
    if (clash(y)) y = reserved.top - CHIP_GAP - CHIP_H;
    if (y < upFloor + CHIP_GAP) break;
    laid.push(Object.assign({}, downs[j], { y: y }));
    y -= CHIP_H + CHIP_GAP;
  }
  return laid;
}

/* The word as wide as the room, cut with an ellipsis when it is not. */
function fitWord(ctx, word, room) {
  var text = String(word || '');
  if (textWidth(ctx, text) <= room) return text;
  while (text.length > 1 && textWidth(ctx, text + '\u2026') > room) text = text.slice(0, -1);
  return text.replace(/\s+$/, '') + '\u2026';
}

/* A chip is two lines on a tinted ground: the word over the price, with the arrow beside the
   word saying which way the level went off. Tinted, never filled: the last price tag stays
   the one solid block on the axis. */
function drawAxisChips(ctx, L) {
  var chips = L.chips || [];
  if (!chips.length) return;
  var x = L.plotWidth + 3;
  var w = L.padRight - 5;
  for (var i = 0; i < chips.length; i++) {
    var chip = chips[i];
    var ink = chartInk(chip.tone, 0.95);
    ctx.fillStyle = chartInk(chip.tone, 0.14);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, chip.y, w, CHIP_H, 5);
      ctx.fill();
    } else {
      ctx.fillRect(x, chip.y, w, CHIP_H);
    }
    if (chip.ring) {
      ctx.strokeStyle = chartInk('warn', 0.95);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 0.5, chip.y - 0.5, w + 1, CHIP_H + 1);
      ctx.lineWidth = 1;
    }
    ctx.font = CHIP_FONT;
    ctx.textAlign = 'left';
    var word = chip.more ? chip.word + ' +' + chip.more : chip.word;
    var room = w - 8;
    // The arrow gives way to the word when both do not fit: the chip's edge already says which
    // way the level went, the word is the only thing that says what it is.
    var arrow = textWidth(ctx, word) + LABEL_GLYPH_W + 3 <= room;
    if (arrow) labelGlyph(ctx, chip.edge === 'top' ? 'up' : 'down', x + 3, chip.y + 14, ink);
    ctx.fillStyle = chartInk(chip.tone, 0.8);
    drawText(ctx, fitWord(ctx, word, arrow ? room - LABEL_GLYPH_W - 3 : room), x + (arrow ? LABEL_GLYPH_W + 6 : 4), chip.y + 10);
    ctx.font = CHART_FONT;
    ctx.fillStyle = ink;
    drawText(ctx, priceText(chip.price, L.decimals), L.plotWidth + 6, chip.y + 21);
  }
}

/* The ticks of the time axis for one layout: the first bar of every bucket of the coarsest
   rung that still leaves GRID_TIME_GAP between them, with the label each one gets.

   Two rungs on one row. A tick is labelled by the largest unit that changed since the tick
   before it: a clock time, then `16 Sep` where the day turns, `Sep` where the month does,
   `2026` where the year does, and the date-bearing ones are drawn brighter. The first visible
   tick always carries the date, and the year when the window spans two, so a chart panned into
   last week never shows a row of times that could be any day. Ticks fall on the first bar of a
   bucket rather than on a clock modulus: a 4h bar opens on no local midnight, and a modulus
   found nothing to label. */
function timeTicks(L) {
  var granularity = CHART.view.granularitySec;
  var utc = axisZoneUtc(granularity);
  var rung = null;
  for (var r = 0; r < TIME_RUNGS.length; r++) {
    if (TIME_RUNGS[r].sec < granularity) continue;
    if ((TIME_RUNGS[r].sec / granularity) * L.slot >= (TIME_RUNGS[r].unit ? GRID_DATE_GAP : GRID_TIME_GAP)) {
      rung = TIME_RUNGS[r];
      break;
    }
  }
  if (rung === null) return [];

  var candles = CHART.candles;
  var first = candles[L.start] ? timeParts(candles[L.start].t, utc) : null;
  var last = candles[L.end] ? timeParts(candles[L.end].t, utc) : null;
  var spansYears = first !== null && last !== null && first.y !== last.y;
  var level = rungLevel(rung);

  var ticks = [];
  var prevKey = null;
  var prevParts = null;
  for (var i = L.start; i <= L.end; i++) {
    var candle = candles[i];
    if (!candle) continue;
    var parts = timeParts(candle.t, utc);
    var key = rungKey(rung, parts);
    if (prevKey === null) {
      // The bucket the window opens in: the bar before the window says whether this bar starts it.
      var before = candles[i - 1];
      prevKey = before ? rungKey(rung, timeParts(before.t, utc)) : null;
    }
    var starts = prevKey === null || key !== prevKey;
    prevKey = key;
    if (!starts) continue;
    var x = L.xOf(i);
    if (x < 0 || x > L.plotWidth) continue;

    var text;
    var changed = prevParts === null ? 3 : Math.max(level, changedLevel(prevParts, parts));
    if (prevParts === null) {
      // The first tick names where the window is.
      if (level >= 3) text = String(parts.y);
      else if (level === 2) text = MONTHS[parts.m] + ' ' + parts.y;
      else text = dayText(parts) + (spansYears ? ' ' + parts.y : '');
    } else if (changed >= 3) text = String(parts.y);
    else if (changed === 2) text = level >= 1 ? MONTHS[parts.m] : dayText(parts);
    else if (changed === 1) text = dayText(parts);
    else text = clockText(parts);
    prevParts = parts;
    ticks.push({ x: x, index: i, text: text, major: changed >= 1 });
  }
  return ticks;
}

function drawTimeGrid(ctx, L) {
  var ticks = timeTicks(L);
  var bottom = L.axisTop;
  ctx.lineWidth = 1 / DPR;
  ctx.strokeStyle = lineInk(0.7);
  ctx.beginPath();
  for (var i = 0; i < ticks.length; i++) {
    ctx.moveTo(hair(ticks[i].x), PAD_TOP);
    ctx.lineTo(hair(ticks[i].x), bottom);
  }
  ctx.stroke();

  ctx.textAlign = 'center';
  for (var k = 0; k < ticks.length; k++) {
    var tick = ticks[k];
    ctx.fillStyle = tick.major ? textInk(0.8) : text2(0.8);
    // A label centred on a tick at the edge would lose half of itself; it is slid inside.
    var half = textWidth(ctx, tick.text) / 2;
    drawText(ctx, tick.text, clampNum(tick.x, half + 1, L.plotWidth - half - 1), bottom + 9);
  }
  ctx.textAlign = 'left';
}

/* Below this many pixels per bar the bars are folded per pixel column before they are drawn. */
var LOD_SLOT_PX = 2;

/* The visible bars folded one per pixel column: the first open, the last close, the extremes,
   the volume summed. Twenty thousand bars across an 800 px plot is 800 columns, each one an
   honest bar of what happened in the minutes under that pixel, and a column is what a squeezed
   chart could show anyway: a wick per bar at a fifth of a pixel each is a smear. Bounded by the
   plot's width, whatever the window holds. */
function candleColumns(L) {
  var columns = [];
  var current = null;
  for (var i = L.start; i <= L.end; i++) {
    var c = CHART.candles[i];
    if (!c) continue;
    var x = Math.floor(L.xOf(i));
    if (current && current.x === x) {
      if (c.h > current.h) current.h = c.h;
      if (c.l < current.l) current.l = c.l;
      current.c = c.c;
      current.v += c.v || 0;
      current.last = i;
      continue;
    }
    current = { x: x, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, first: i, last: i };
    columns.push(current);
  }
  return columns;
}

/* Four paths for the whole series instead of two calls per candle. At five hundred bars that
   is the difference between a draw that keeps up with a drag and one that does not. */
function drawCandles(ctx, L) {
  if (L.slot < LOD_SLOT_PX) {
    drawCandleColumns(ctx, L, candleColumns(L));
    return;
  }
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

/* One wick per column, in the column's own direction, and a one pixel body only where the
   open and close are a pixel apart: below that a body is a dot on the wick that says nothing. */
function drawCandleColumns(ctx, L, columns) {
  var sets = [
    { colour: C_UP, up: true },
    { colour: C_DOWN, up: false }
  ];
  for (var s = 0; s < sets.length; s++) {
    var set = sets[s];
    ctx.strokeStyle = set.colour;
    ctx.fillStyle = set.colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < columns.length; i++) {
      var col = columns[i];
      if (col.c >= col.o !== set.up) continue;
      var x = col.x + 0.5;
      ctx.moveTo(x, L.yOf(col.h));
      ctx.lineTo(x, L.yOf(col.l));
    }
    ctx.stroke();
    ctx.beginPath();
    for (var j = 0; j < columns.length; j++) {
      var body = columns[j];
      if (body.c >= body.o !== set.up) continue;
      var top = Math.min(L.yOf(body.o), L.yOf(body.c));
      var h = Math.abs(L.yOf(body.o) - L.yOf(body.c));
      if (h < 1) continue;
      ctx.rect(body.x, Math.round(top), 1, Math.round(h));
    }
    ctx.fill();
  }
}

function plotColour(plot, alphaScale) {
  var alpha = clampNum((plot.emphasis === undefined ? 0.8 : plot.emphasis) * (alphaScale || 1), 0.08, 1);
  return accent(alpha);
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
      ctx.fillStyle = accent(0.08);
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

    ctx.strokeStyle = lineInk(1);
    ctx.lineWidth = 1 / DPR;
    ctx.beginPath();
    ctx.moveTo(0, hair(pane.top));
    ctx.lineTo(L.plotWidth, hair(pane.top));
    ctx.stroke();

    var guides = ind.guides || [];
    ctx.strokeStyle = lineInk(0.6);
    ctx.fillStyle = text2(0.7);
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
      drawText(ctx, guides[gl].label, L.plotWidth + 6, ly);
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
      ctx.fillStyle = text2(0.7);
      drawText(ctx, paneText(pane.high), L.plotWidth + 6, pane.top + 7);
      drawText(ctx, paneText(pane.low), L.plotWidth + 6, pane.top + pane.height - 6);
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
  // Squeezed below a pixel a bar, the tallest bar under each column stands for the column:
  // a sum would leave the pane's scale, and one rect per column is what a pixel can hold.
  var folded = L.slot < LOD_SLOT_PX;
  for (var s = 0; s < sets.length; s++) {
    var sign = sets[s];
    ctx.fillStyle = sets.length === 1 ? accent(0.34) : sign > 0 ? accent(0.4) : danger(0.45);
    ctx.beginPath();
    var lastX = null;
    var lastTop = 0;
    for (var i = L.start; i <= L.end; i++) {
      var v = plot.values[i];
      if (v === null || v === undefined || !isFinite(v)) continue;
      var direction = signs ? (signs[i] >= 0 ? 1 : -1) : v >= 0 ? 1 : -1;
      if (sets.length > 1 && direction !== sign) continue;
      var y = paneYOf(pane, v);
      var top = Math.min(y, base);
      var height = Math.max(1, Math.abs(base - y));
      if (folded) {
        var x = Math.floor(L.xOf(i));
        if (x === lastX && top >= lastTop) continue;
        lastX = x;
        lastTop = top;
        ctx.rect(x, Math.round(top), 1, Math.round(height));
        continue;
      }
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
    var tone = fromAgent ? 'agent' : 'ink';
    var ring = chartSpotOn('level', level.id);
    if (y < top || y > bottom) {
      // Off the top or the bottom of what is on screen. The line cannot be drawn where it
      // belongs, so it becomes a chip on the price axis at the edge it went off.
      chartAxisChip({ price: level.price, edge: y < top ? 'top' : 'bottom', word: labelText(level.label), tone: tone, ring: ring });
      continue;
    }
    ctx.strokeStyle = fromAgent ? agentInk(0.5) : accent(0.7);
    // Agent lines are dotted, human lines are dashed. Attribution is in the label as well,
    // but the eye reads the dash first.
    ctx.setLineDash(fromAgent ? [2, 3] : [6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, hair(y));
    ctx.lineTo(L.plotWidth, hair(y));
    ctx.stroke();
    ctx.setLineDash([]);
    chartLabel({
      y: y - 7,
      parts: labelLead(level.source).concat([{ text: labelText(level.label) + ' ' + priceText(level.price, L.decimals), tone: tone }]),
      ring: ring
    });
  }
}

// Trend lines and zones the agent drew, or the human did. These are stored by TIME and
// PRICE rather than by pixel, so they stay where they belong through a pan and a zoom, and
// so the value the agent measured against is the value drawn here. One computation, two
// consumers: the number in the agent's answer and the pixel on this canvas cannot disagree.
//
// No new hue. Red belongs to the approval gate alone, so an agent drawing is the same
// phosphor green at a lower brightness tier, dotted the way agent levels already are.
function drawDrawings(ctx, L) {
  var list = CHART.drawings;
  if (!list || !list.length) return;
  var granularity = CHART.view.granularitySec;
  var candles = CHART.candles;
  if (!candles.length) return;
  var firstT = candles[0].t;

  // A drawing's price at a given time. Two anchors at one instant have no slope, so they
  // read as horizontal: finite beats correct here, since a NaN would vanish silently.
  function valueAt(line, tSec) {
    var dt = line.b.t - line.a.t;
    if (dt === 0) return line.a.price;
    return line.a.price + ((line.b.price - line.a.price) / dt) * (tSec - line.a.t);
  }
  function timeOfX(x) {
    return firstT + L.indexAt(x) * granularity;
  }

  var top = L.priceTop;
  var bottom = L.priceTop + L.priceHeight;

  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    var fromAgent = d.source === 'agent';
    // The server tags an agent's drawing "[agent] trend" as it lands (tagLabel in
    // src/http/view.ts); on the canvas the word comes off and the dot says it.
    var label = labelText(d.label);

    if (d.kind === 'zone' && d.zone) {
      var yHigh = L.yOf(d.zone.high);
      var yLow = L.yOf(d.zone.low);
      var boxTop = Math.max(top, Math.min(yHigh, yLow));
      var boxBottom = Math.min(bottom, Math.max(yHigh, yLow));
      if (boxBottom <= top || boxTop >= bottom) continue;
      ctx.fillStyle = accent(0.14);
      ctx.fillRect(0, boxTop, L.plotWidth, boxBottom - boxTop);
      // Right-aligned, like the trend line labels. Left-aligning collided with the OHLC
      // legend whenever a zone reached the top of the plot, which is exactly what a wide
      // zone does, so the collision was the common case rather than an edge one.
      drawEdgeLabel(ctx, label, fromAgent, L.plotWidth - 4, boxTop + 11, chartSpotOn('line', d.id));
      continue;
    }

    if (!d.line) continue;
    // Extended to both plot edges: a trend line that stopped at its anchors would be a
    // segment, and the whole reason to draw one is where it goes next.
    var x0 = 0;
    var x1 = L.plotWidth;
    var y0 = L.yOf(valueAt(d.line, timeOfX(x0)));
    var y1 = L.yOf(valueAt(d.line, timeOfX(x1)));
    if ((y0 < top && y1 < top) || (y0 > bottom && y1 > bottom)) continue;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, L.plotWidth, L.priceHeight);
    ctx.clip();
    ctx.lineWidth = 1;
    ctx.strokeStyle = accent(fromAgent ? 0.5 : 0.7);
    ctx.setLineDash(fromAgent ? [2, 3] : [6, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // The label rides the right end, where the line is heading.
    var labelY = Math.max(top + 10, Math.min(bottom - 3, y1 - 5));
    drawEdgeLabel(ctx, label, fromAgent, L.plotWidth - 4, labelY, chartSpotOn('line', d.id));
  }
}

/* A label against the right edge of the plot, for a line or a zone: right-aligned text in the
   accent, the agent's dot in front when the agent drew it, the spotlight ring around both. */
function drawEdgeLabel(ctx, label, fromAgent, right, y, spot) {
  ctx.fillStyle = accent(fromAgent ? 0.6 : 0.85);
  ctx.textAlign = 'right';
  drawText(ctx, label, right, y);
  ctx.textAlign = 'left';
  var width = textWidth(ctx, label);
  var left = right - width;
  if (fromAgent) {
    left -= LABEL_GLYPH_W + 2;
    labelGlyph(ctx, 'agent', left, y, agentInk(0.85));
  }
  drawSpotRing(ctx, left, y, right - left, spot);
}

/* The spotlight on a label drawn outside the column: the same amber ring the column draws. */
function drawSpotRing(ctx, x, y, width, on) {
  if (!on) return;
  ctx.strokeStyle = warnInk(0.95);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - 4.5, y - 9.5, width + 9, 18);
  ctx.lineWidth = 1;
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
    var markInk = mark.source === 'agent' ? agentInk : accent;
    ctx.strokeStyle = markInk(0.34);
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(hair(x), PAD_TOP);
    ctx.lineTo(hair(x), L.axisTop);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.translate(x - 3, L.axisTop - 4);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = markInk(0.55);
    drawText(ctx, labelText(mark.label), 0, 0);
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
  ctx.strokeStyle = lineInk(1);
  ctx.lineWidth = 1 / DPR;
  ctx.beginPath();
  ctx.moveTo(hair(L.plotWidth), L.priceTop);
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

  drawAxisChips(ctx, L);
  drawLastPrice(ctx, L);
  drawCrosshair(ctx, L);
  drawLegend(ctx, L);
}

function drawLastPrice(ctx, L) {
  var candles = CHART.candles;
  if (!candles.length) return;
  var last = candles[candles.length - 1];
  var up = last.c >= last.o;
  // The tag slides; the figure it carries does not lie about where it is going. shownPrice is
  // the eased position, last.c is the price that actually traded, and they are different
  // things for 120 ms at a time.
  var shown = shownPrice();
  var y = L.yOf(shown === null ? last.c : shown);
  if (y >= L.priceTop && y <= L.priceTop + L.priceHeight) {
    ctx.strokeStyle = up ? accent(0.5) : danger(0.6);
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
  drawText(ctx, text, L.plotWidth + 5, boxTop + 8);

  /* The countdown is not a second price and must not read as one. Sharing the tag's left edge
     and its type size was the whole problem: two numbers in one column, stacked, and the eye
     files the lower one as another tag. So it hangs off the tag as something running out,
     which is what it is: a rule that empties toward the close, and the figure under it at
     nine pixels, centred, unfilled. Nothing in the price column is allowed to look filled
     except the price. */
  var closesIn = CHART.meta.barCloseSec;
  if (typeof closesIn === 'number' && closesIn >= 0) {
    var left = L.plotWidth + 1;
    var wide = L.padRight - 1;
    var ruleTop = boxTop + 18;
    // Under fifteen seconds to a bar the rule has nothing to show that the stepping figure
    // does not already say, and it would spend most of its life empty.
    if (CHART.view.granularitySec >= 15) {
      // The unlit track carries the whole width at every moment. Without it the last few
      // seconds are a stub floating under the tag, which reads as a stray mark rather than
      // as a rule that has nearly emptied.
      ctx.fillStyle = lineInk(0.9);
      ctx.fillRect(left, ruleTop, wide, 2);
      var run = clampNum(closesIn / barSpanOf(last.t, CHART.view.granularitySec), 0, 1) * wide;
      ctx.fillStyle = up ? accent(0.45) : danger(0.55);
      ctx.fillRect(left, ruleTop, Math.max(1, Math.round(run)), 2);
    }
    ctx.font = CHART_FONT_SMALL;
    ctx.fillStyle = text2(0.75);
    ctx.textAlign = 'center';
    drawText(ctx, countdownText(closesIn), left + wide / 2, ruleTop + 7);
    ctx.textAlign = 'left';
    ctx.font = CHART_FONT;
  }
}

function drawCrosshair(ctx, L) {
  if (!CHART_HOVER) return;
  var index = Math.round(CHART_HOVER.index);
  if (index < 0 || index >= CHART.candles.length) return;
  var x = L.xOf(index);
  var y = CHART_HOVER.y;
  if (x < 0 || x > L.plotWidth) return;

  ctx.strokeStyle = text2(0.5);
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
    drawText(ctx, label, L.plotWidth + 5, top + 8);
  }

  var candle = CHART.candles[index];
  var stamp = crosshairStamp(candle.t, CHART.view.granularitySec);
  ctx.font = CHART_FONT;
  var width = textWidth(ctx, stamp) + 10;
  var boxX = clampNum(x - width / 2, 0, L.plotWidth - width);
  ctx.fillStyle = C_HI;
  ctx.fillRect(boxX, L.axisTop + 1, width, 15);
  ctx.fillStyle = C_BG;
  drawText(ctx, stamp, boxX + 5, L.axisTop + 9);
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

  // The name belongs to the bars being drawn, never to the request that may still be in
  // flight. A window asking for one market while the payload on screen holds another is a
  // second of a switch, or a write the server never took: either way the price under this
  // name has to be the price this name means.
  var identity = CHART.dataView || CHART.view;
  var dir = up ? 'up' : 'down';

  /* The legend is the head of the one label column: the market line first, then one line per
     price overlay, then everything the scene collected (levels, the account's lines, plans),
     placed together so no two of them can print on one y. Sub-pane lines stay in their panes.

     The four prices sit in columns as wide as the widest price on the axis, so a close that
     ticks from 999.99 to 1,000.01 moves nothing to its right: a legend that jittered on every
     tick was the one thing on the surface that looked cheaper than the numbers on it. */
  var items = [];
  var valueW = Math.max(textWidth(ctx, priceText(L.high, L.decimals)), textWidth(ctx, priceText(L.low, L.decimals)));
  var head = [
    { text: coinOf(identity.product), tone: 'hi' },
    { text: timeframeOf(identity.granularitySec), tone: 'text2', alpha: 0.85 }
  ];
  var ohlc = [['O', candle.o], ['H', candle.h], ['L', candle.l], ['C', candle.c]];
  for (var v = 0; v < ohlc.length; v++) {
    head.push({ text: ohlc[v][0], tone: 'text2', alpha: 0.7 });
    head.push({ text: priceText(ohlc[v][1], L.decimals), tone: dir, alpha: 1, width: valueW });
  }
  // Round before choosing the sign, or a bar that moved a hundredth of a percent down
  // prints "-0.00%", which reads as a rendering fault rather than as a flat bar.
  var rounded = Math.abs(change) < 0.005 ? 0 : change;
  head.push({ text: (rounded > 0 ? '+' : rounded < 0 ? '' : ' ') + rounded.toFixed(2) + '%', tone: dir, alpha: 1, width: textWidth(ctx, '+00.00%') });
  // The market line has the strip above the plot to itself, so nothing is under it to pad.
  labelDraw(ctx, [{ y: LEGEND_Y, labelY: LEGEND_Y, parts: head, legend: true }], chartInk, null);

  var columnTop = L.priceTop + COLUMN_Y;
  for (var o = 0; o < L.overlays.length; o++) {
    items.push(legendItem(L, L.overlays[o], index, columnTop + LABEL_PITCH * o));
  }
  for (var s = 0; s < CHART_SCENE_LABELS.length; s++) items.push(CHART_SCENE_LABELS[s]);

  var laid = labelLayout(items, columnTop - LABEL_TOP, L.priceTop + L.priceHeight);
  var boxes = labelDraw(ctx, laid.placed, chartInk, chartLabelPad());
  for (var b = 0; b < boxes.length; b++) {
    var placed = boxes[b].item;
    if (!placed.id) continue;
    CHART_LABEL_BOXES[placed.id] = boxes[b];
    if (!placed.remove) continue;
    // The cross is the last part of the line, so the hit is the tail of the box.
    CHART_HITS.push({ x: boxes[b].x + boxes[b].w - 16, y: boxes[b].y, w: 18, h: boxes[b].h, remove: placed.remove });
  }

  for (var p = 0; p < L.panes.length; p++) {
    drawIndicatorLine(ctx, L, L.panes[p].indicator, L.panes[p].top + 9, index);
  }

  drawChartNotes(ctx, L);
}

/* One legend line for a study: the agent's dot when the agent added it, the label, its values
   at the hovered bar, and, under the pointer only, the cross that removes it. The same line
   serves a price overlay in the column and a sub-pane at the top of its pane. */
function studyParts(L, indicator, index) {
  var parts = labelLead(indicator.source, 0.85);
  parts.push({ text: labelText(indicator.label), tone: indicator.source === 'agent' ? 'agent' : 'text', alpha: 0.85 });
  var plots = indicator.plots || [];
  for (var i = 0; i < plots.length; i++) {
    var value = plots[i].values[index];
    if (value === null || value === undefined || !isFinite(value)) continue;
    parts.push({ text: indicator.pane === 'price' ? priceText(value, L.decimals) : paneText(value), tone: 'text2', alpha: 0.9 });
  }
  var hovered = labelHovered(indicator.id);
  if (hovered) parts.push({ glyph: 'close', tone: 'text2', alpha: 0.7 });
  return { parts: parts, hovered: hovered };
}

function legendItem(L, indicator, index, y) {
  var study = studyParts(L, indicator, index);
  return {
    y: y,
    parts: study.parts,
    id: indicator.id,
    remove: study.hovered ? indicator.id : null,
    ring: chartSpotOn('indicator', indicator.id),
    legend: true
  };
}

/* The bottom rule of the plot, where the chart says what it could not do and offers back the
   one pane it lets you put away.

   These notes used to live on the control row above the canvas. They are facts about the bars
   on screen, not controls, and reading them meant looking away from the thing they described
   while the row they sat on grew into a toolbar. They are here now, in the same ink as the
   legend, next to the bars they are about. */
function drawChartNotes(ctx, L) {
  var x = LABEL_X;
  var y = L.axisTop - 6;

  if (!VOLUME_ON) {
    var back = '+ volume';
    ctx.fillStyle = text2(0.55);
    drawText(ctx, back, x, y);
    var wide = textWidth(ctx, back);
    // The only way back once the pane is put away, so it is a hit target rather than a label.
    CHART_HITS.push({ x: x - 2, y: y - 7, w: wide + 4, h: 14, remove: VOLUME_ID });
    x += wide + 12;
  }

  if (L.dropped.length) {
    var full = 'no room for: ' + L.dropped.join(', ');
    ctx.fillStyle = C_DOWN;
    drawText(ctx, full, x, y);
    x += textWidth(ctx, full) + 12;
  }

  // The left edge of history: older bars on their way, or the venue's own first bar on screen.
  // A fact about the exchange rather than a fault in the chart, said beside the bars.
  var notes = [];
  if (CHART_BACKFILL.inflight) notes.push('Loading earlier prices');
  else if (historyBegins() && L.start === 0) notes.push('History starts here');
  if (notes.length === 0) return;
  ctx.fillStyle = text2(0.55);
  drawText(ctx, notes.join('   '), x, y);
}

/* The title line of a sub-pane: the same line a price overlay gets in the column, drawn at
   the top of its own pane through the same column painter, so the two cannot drift in style.
   The cross is the human's way out of anything an agent put on the chart, and it shows under
   the pointer. */
function drawIndicatorLine(ctx, L, indicator, y, index) {
  var study = studyParts(L, indicator, index);
  var boxes = labelDraw(ctx, [{ labelY: y, parts: study.parts, ring: chartSpotOn('indicator', indicator.id) }], chartInk, chartLabelPad());
  var box = boxes[0];
  if (!box) return y + LABEL_PITCH;
  CHART_LABEL_BOXES[indicator.id] = box;
  if (study.hovered) CHART_HITS.push({ x: box.x + box.w - 16, y: box.y, w: 18, h: box.h, remove: indicator.id });
  return y + LABEL_PITCH;
}

function timeframeOf(sec) {
  for (var i = 0; i < CHART.timeframes.length; i++) {
    if (CHART.timeframes[i].sec === sec) return CHART.timeframes[i].label;
  }
  // Anything off the button bar, which an agent can now ask for: 7m, 2h, 3d. Falling
  // straight to seconds printed a weekly chart as "604800s".
  if (sec === MONTH_SEC) return '1M';
  if (sec % 604800 === 0) return sec / 604800 + 'w';
  if (sec % 86400 === 0) return sec / 86400 + 'd';
  if (sec % 3600 === 0) return sec / 3600 + 'h';
  if (sec % 60 === 0) return sec / 60 + 'm';
  return sec + 's';
}

/* ---------- talking to the server ---------- */

/* `opts.part` is which part of the payload to ask for. The markup part is the answer to a chart
   frame: the view, the studies, the levels, the marks and the drawings, without the candles the
   window already holds. Everything else (a nudge, a gesture, the floor poll) asks for the whole
   thing. */
async function refreshChart(opts) {
  var part = opts && opts.part === 'markup' ? 'markup' : 'full';
  if (CHART_FETCH.inflight) {
    CHART_FETCH.queued = true;
    if (part === 'full' || CHART_FETCH.queuedPart === '') CHART_FETCH.queuedPart = part;
    return;
  }
  CHART_FETCH.inflight = true;
  if (part === 'full') CHART_FETCH.at = Date.now();
  chartBusy(true);
  try {
    var res = await fetch(part === 'markup' ? '/api/chart?part=markup' : '/api/chart', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('chart returned ' + res.status);
    if (part === 'full' && res.headers && typeof res.headers.get === 'function') {
      CHART_FETCH.bytes = Number(res.headers.get('content-length')) || 0;
    }
    var payload = await res.json();
    applyChart(payload);
  } catch (err) {
    CHART.meta.error = err.message || String(err);
    chartInvalidate(true);
  } finally {
    CHART_FETCH.inflight = false;
    chartBusy(false);
    if (CHART_FETCH.queued) {
      var next = CHART_FETCH.queuedPart;
      CHART_FETCH.queued = false;
      CHART_FETCH.queuedPart = '';
      void refreshChart({ part: next });
    }
  }
}

/* The one thing on the bar that says a read is in flight. It lives next to the meta line
   rather than inside it, because renderChartBar rebuilds that line from scratch and a
   marker that disappears whenever the data it is waiting for arrives is no marker at all.
   A chart that already has candles keeps them: this is the only sign of a refresh, which is
   what stops a timeframe switch looking like a freeze. */
function chartBusy(on) {
  var node = document.getElementById('chart-feed');
  if (node) node.dataset.busy = on ? '1' : '0';
}

/* Whether a payload names a different market or a different bar length than the window is
   asking for. Pan, zoom and price scale are deliberately not in here: those the hand owns. */
function chartIdentityDiffers(view) {
  if (!view) return false;
  // The venue is part of which market this is, not a preference about it. Two venues price
  // the same coin differently and one of them is a perp against the other's spot, so a view
  // still naming the venue the candles did NOT come from is the same failure as a view still
  // naming the wrong product: one market's price under another market's name.
  return (
    view.product !== CHART.view.product ||
    view.granularitySec !== CHART.view.granularitySec ||
    view.provider !== CHART.view.provider
  );
}

/* Where a bar opening at `tSec` sits in a series sorted by open time, or -1. Exact: a bar the
   array does not hold is not a bar it can lay a value on. */
function indexOfExact(candles, tSec) {
  var lo = 0;
  var hi = candles.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var t = candles[mid].t;
    if (t === tSec) return mid;
    if (t < tSec) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/* Whether the candles held are the series a markup part's values were computed over, and
   where that series starts in them. Null when they are not: another market, another bar
   length, a venue that changed, or a bar the server has and this window does not. The window
   answers null by asking for the full part rather than drawing a plot one bar off. */
function markupOffset(payload) {
  var series = payload.series;
  var view = payload.view;
  if (!series || !view || !CHART.dataView) return null;
  if (view.product !== CHART.dataView.product || view.granularitySec !== CHART.dataView.granularitySec) return null;
  if (payload.meta && CHART.meta.source && payload.meta.source !== CHART.meta.source) return null;
  if (series.count === 0) return CHART.candles.length === 0 ? 0 : null;
  var first = indexOfExact(CHART.candles, series.first);
  var last = indexOfExact(CHART.candles, series.last);
  if (first < 0 || last < 0 || last - first + 1 !== series.count) return null;
  return first;
}

/* A payload's candles over the ones held. The bars older than the payload's first stay: they
   were backfilled behind the left edge on purpose, and a window that dropped them on every
   refresh would jump to the right the moment a study was added. A different market shares
   nothing with the old one, so its candles replace the array outright. */
function mergeCandles(held, incoming, sameIdentity) {
  if (!sameIdentity || !held.length || !incoming.length) return incoming;
  var firstT = incoming[0].t;
  var keep = 0;
  while (keep < held.length && held[keep].t < firstT) keep += 1;
  return keep === 0 ? incoming : held.slice(0, keep).concat(incoming);
}

/* Lay each plot down over the candles held, starting at `offset`: value k of a plot is the
   value of bar k of the series it was computed over, which is bar offset + k here. The common
   case, the same series, is the arrays as they came. */
function rebaseIndicators(list, offset, total) {
  if (offset === 0) return list;
  function shift(values) {
    var out = new Array(total);
    for (var i = 0; i < total; i++) out[i] = null;
    for (var k = 0; k < values.length && offset + k < total; k++) out[offset + k] = values[k];
    return out;
  }
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var ind = list[i];
    var plots = [];
    for (var p = 0; p < (ind.plots || []).length; p++) {
      var plot = ind.plots[p];
      var copy = {};
      for (var key in plot) if (Object.prototype.hasOwnProperty.call(plot, key)) copy[key] = plot[key];
      copy.values = shift(plot.values || []);
      plots.push(copy);
    }
    var next = {};
    for (var field in ind) if (Object.prototype.hasOwnProperty.call(ind, field)) next[field] = ind[field];
    next.plots = plots;
    out.push(next);
  }
  return out;
}

function applyChart(payload) {
  // The server has now been heard from, so writing our view back is safe.
  CHART_READY = true;
  // Another market or another bucket size is another price. The live rail's volume memo and
  // the tag's ease are both about one series, and carrying either across would fold one
  // market's volume into another's bar and slide the tag between two unrelated prices.
  var wasIdentity = CHART.dataView ? CHART.dataView.product + '|' + CHART.dataView.granularitySec : '';
  var sameIdentity = Boolean(payload.view) && payload.view.product + '|' + payload.view.granularitySec === wasIdentity;
  var offset = 0;
  if (payload.candles) {
    CHART.candles = mergeCandles(CHART.candles, payload.candles, sameIdentity);
    if (CHART.view.panOffset <= 0 && CHART.candles.length > CHART_KEEP_MAX) CHART.candles = CHART.candles.slice(-CHART_KEEP_MAX);
    offset = payload.series ? Math.max(0, indexOfExact(CHART.candles, payload.series.first)) : 0;
  } else {
    // The markup part. It was computed over a series; if that is not the one held here, the
    // whole payload is the answer, and this one is not applied half way.
    var found = markupOffset(payload);
    if (found === null) {
      void refreshChart({ part: 'full' });
      return;
    }
    offset = found;
  }
  CHART.rev = payload.rev;
  CHART.candlesRev = typeof payload.candlesRev === 'number' ? payload.candlesRev : CHART.candlesRev;
  CHART.series = payload.series || CHART.series;
  CHART.meta = payload.meta || CHART.meta;
  CHART.indicators = rebaseIndicators(payload.indicators || [], offset, CHART.candles.length);
  CHART.levels = payload.levels || [];
  CHART.marks = payload.marks || [];
  CHART.drawings = payload.drawings || [];
  CHART.products = payload.products || [];
  CHART.timeframes = payload.timeframes || [];
  CHART.agentObjects = payload.agentObjects || 0;
  CHART.lastDriver = payload.lastDriver || 'human';
  if (payload.limits && typeof payload.limits.barCountMax === 'number') {
    CHART_BARS = {
      min: payload.limits.barCountMin,
      max: payload.limits.barCountMax,
      panMax: typeof payload.limits.panMax === 'number' ? payload.limits.panMax : CHART_BARS.panMax
    };
    if (typeof payload.limits.fetchMargin === 'number') CHART_FETCH_MARGIN = payload.limits.fetchMargin;
  }
  /* Who owns the view. The hand in the window owns it while the hand is on it, and the only
     thing that may move the chart out from under that hand is the agent. Adopting the
     server's view on every refresh instead looks correct and is not: a refresh fired by our
     own write can land before that write does, and the gesture the human just made snaps
     back. The server's answer to our own write is applied in pushChart, where it is an
     answer and not a race. */
  if (CHART_FIRST_LOAD || (payload.lastDriver === 'agent' && CHART_DRAG === null && CHART_PUSH === null)) {
    /* The agent moving the chart is the one case worth animating, and the first load is the
       one case that must not be: there is no previous window to travel from, only an empty
       pane. startViewTween decides for itself whether the change is even animatable (same
       instrument, same timeframe, same price mode) and returns false when it is not, so the
       assignment below always happens and the tween is purely how it is drawn on the way. */
    if (!CHART_FIRST_LOAD) startViewTween(payload.view);
    CHART.view = payload.view;
    CHART_FIRST_LOAD = false;
  } else if (chartIdentityDiffers(payload.view) && CHART_DRAG === null && CHART_PUSH === null && CHART_PUSH_WAIT === 0) {
    /* Which instrument and which timeframe is not the human's to hold against the payload.
       The candles here were read for the server's product, so a view still naming another
       one puts one market's price under another market's name. A lost view write and a
       restarted server both land here, lastDriver reading 'human' in each case, and that
       used to leave the wrong name on the chart until the page was reloaded. Nothing of
       ours is on the wire at this point, so the server is the answer. The whole view comes
       across: another instrument shares nothing with the old one, which is the same
       reasoning setView uses in src/chart.ts. */
    CHART.view = payload.view;
  }
  CHART.dataView = payload.view
    ? { product: payload.view.product, granularitySec: payload.view.granularitySec }
    : CHART.dataView;

  var isIdentity = CHART.dataView ? CHART.dataView.product + '|' + CHART.dataView.granularitySec : '';
  if (isIdentity !== wasIdentity) {
    CHART_LIVE = null;
    CHART_LIVE_HELD = null;
    CHART_PRICE_TWEEN = null;
  }

  var last = CHART.candles.length ? CHART.candles[CHART.candles.length - 1] : null;
  CHART.meta.barCloseSec = last ? Math.max(0, bucketCloseOf(last.t, CHART.view.granularitySec) - Date.now() / 1000) : null;
  // The fallback rail moves the tag too. A REST refresh is slower than a socket frame and it
  // teleports harder, so it is the path that most needs the ease.
  if (last && isIdentity === wasIdentity) startPriceTween(last.c);

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
  // Nothing is written back until the first server payload has been applied.
  //
  // Without this the canvas getting its initial size fires a push carrying the CHART.view
  // literal at the top of this file, 1m and 120 bars, before /api/chart has answered. That
  // push wins, so an agent that moved the chart while the window was closed watched its
  // change silently revert the moment the human opened the window. Measured: set 4h with
  // 150 bars over MCP against a closed window, server held 14400s/150, opening the page put
  // it back to 60s/120.
  //
  // That defeats the decision the whole chart turns on, that state lives on the server so
  // the agent and the human cannot disagree about what is on screen. The geometry this push
  // also carries is not lost: the next invalidate after applyChart sends it.
  if (!CHART_READY) return;
  if (CHART_PUSH) clearTimeout(CHART_PUSH);
  CHART_PUSH = setTimeout(pushChart, 150);
}

async function pushChart(extra) {
  CHART_PUSH = null;
  var body = {
    token: typeof TOKEN === 'string' ? TOKEN : null,
    view: {
      product: CHART.view.product,
      provider: CHART.view.provider || 'auto',
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
  CHART_PUSH_WAIT++;
  try {
    var res = await fetch('/api/chart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    var answer = await res.json();
    if (answer && typeof answer.rev === 'number') CHART_MY_REV = answer.rev;
    if (answer && answer.error && typeof body.token === 'string' && body.token.length) {
      chartNote(answer.error);
    }
    // The answer to our own write, so the clamps the server applied land here rather than
    // leaving the window showing something the agent's read does not agree with.
    if (answer && answer.view && CHART_DRAG === null && CHART_PUSH === null) CHART.view = answer.view;
    // The server's series follows the view just written. A pan into bars the plots were not
    // computed over is answered by fetching them again, now that the server knows the window.
    if (extra || plotsShortOnScreen()) void refreshChart();
    else chartInvalidate(true);
  } catch (err) {
    // A failed view write is not worth an alert line: the chart still draws, and the window
    // falls back to the server's view on the next read rather than keeping a name the
    // server never accepted.
  } finally {
    CHART_PUSH_WAIT--;
  }
}

/* Whether a plot on screen starts to the right of the left edge: the series it was computed
   over began after the bars now in view, which a pan into backfilled history does. */
function plotsShortOnScreen() {
  var L = CHART_LAYOUT;
  if (!L || !CHART.series || !CHART.indicators.length || !CHART.candles.length) return false;
  var first = indexOfExact(CHART.candles, CHART.series.first);
  return first > L.start;
}

/* A one-line answer under the chart bar, for a refused indicator or a clamped parameter.
   It clears itself: nothing on this page is allowed to accumulate chrome. */
function chartNote(text) {
  var meta = document.getElementById('chart-status');
  if (!meta) return;
  var note = chartSpan('chart-note', text);
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
  // Our own echo. Anything newer came from an agent and has to repaint. What moved is the
  // markup, so the markup is what is fetched: the candles under it are the same bytes.
  if (typeof rev === 'number' && rev <= CHART_MY_REV) return;
  void refreshChart({ part: 'markup' });
}

/* ---------- the snapshot ----------

   chart_snapshot asks the window for what the human sees, over SSE, with a request id, and
   waits three seconds. The answer is the scene and the hud of slot 0 (or a comparison chart's
   own canvas) composed into an offscreen canvas at most 1024 px wide, encoded as a JPEG at a
   fixed quality, and posted back through the one fetch path every window write uses, which
   is what adds the window token. The server keeps nothing and hands the bytes to the one
   tool call waiting on that id.

   Nothing here blocks the paint. The compose runs on the next frame, so it reads a scene that
   has been drawn rather than one the SSE message interrupted, and the encode is toBlob, which
   is asynchronous by design. A chart with no size, or a slot with no chart, posts nothing and
   lets the server's timeout say so. */
var SNAPSHOT_MAX_W = 1024;
var SNAPSHOT_QUALITY = 0.7;

function chartSnapshot(slot, reqId) {
  var id = String(reqId || '');
  if (!id) return;
  var n = Number(slot) || 0;
  window.requestAnimationFrame(function () {
    var sources = snapshotSources(n);
    if (!sources) return;
    var out = document.createElement('canvas');
    out.width = Math.round(sources.w);
    out.height = Math.round(sources.h);
    var ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, out.width, out.height);
    for (var i = 0; i < sources.canvases.length; i++) {
      ctx.drawImage(sources.canvases[i], 0, 0, out.width, out.height);
    }
    if (typeof out.toBlob !== 'function') return;
    out.toBlob(function (blob) {
      if (!blob) return;
      blob.arrayBuffer()
        .then(function (buffer) {
          return window.PhosphorNet.postJson('/api/chart/snapshot', { reqId: id, jpeg: base64Of(new Uint8Array(buffer)) });
        })
        .catch(function (err) {
          console.error('[chart] snapshot', err);
        });
    }, 'image/jpeg', SNAPSHOT_QUALITY);
  });
}

/* What to draw and how big. Slot 0 is the engine's two canvases at the size the human sees
   them; a comparison chart is its one canvas at its own pixel size. Never scaled up: a small
   chart is a small picture. */
function snapshotSources(slot) {
  if (slot === 0) {
    var scene = chartCanvas();
    var hud = chartHud();
    if (!scene || !hud || !CHART_SIZE.w || !CHART_SIZE.h) return null;
    var scale = Math.min(1, SNAPSHOT_MAX_W / CHART_SIZE.w);
    return { canvases: [scene, hud], w: CHART_SIZE.w * scale, h: CHART_SIZE.h * scale };
  }
  var mini = window.PhosphorMini && typeof window.PhosphorMini.canvasOf === 'function' ? window.PhosphorMini.canvasOf(slot) : null;
  if (!mini || !mini.width || !mini.height) return null;
  var fit = Math.min(1, SNAPSHOT_MAX_W / mini.width);
  return { canvases: [mini], w: mini.width * fit, h: mini.height * fit };
}

function base64Of(bytes) {
  var binary = '';
  var CHUNK = 0x8000;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
window.chartSnapshot = chartSnapshot;

/* ---------- the live rail ----------

   A candle frame off the SSE stream, carrying one 1m bar rather than asking this window to
   come back for the whole array. That refetch was 102 to 137 KB of JSON, parsed and thrown
   away every two to three seconds to move one close, and deleting it is most of why the
   price on screen went from four seconds old to under half a second.

   Everything here is defensive about identity. A frame names a product, a venue and a base
   interval, and all three have to match what is actually being drawn before a number off it
   reaches a pixel. The venue is checked against meta.source rather than the view's provider
   because the view can say 'auto': what matters is which venue served these candles, not
   which one was asked for. */

// The last 1m bar folded in, so a frame for a minute already counted adds only what is new.
// The venue resends the whole minute, not a delta, and adding its volume each time would make
// the bar's volume climb with the message rate rather than with the market.
var CHART_LIVE = null;
// A frame that arrived while the hand was on the chart. Only the newest is worth keeping: an
// older one is a price that has already been superseded.
var CHART_LIVE_HELD = null;

/* Which bucket a moment belongs to. The same arithmetic as bucketStart in
   src/market/aggregate.ts: a month opens on the first at UTC midnight, and weeks carry an
   offset to open on Monday, because epoch second zero was a Thursday and a chart that skips
   the offset disagrees with every venue. */
function liveBucket(tSec, stepSec) {
  if (stepSec === MONTH_SEC) {
    var d = new Date(tSec * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  if (stepSec >= 604800 && stepSec % 604800 === 0) {
    return Math.floor((tSec - 345600) / stepSec) * stepSec + 345600;
  }
  return Math.floor(tSec / stepSec) * stepSec;
}

/* When the bar opening at `openSec` closes: the next first of the month for a month bar, one
   step on for every other. Mirrors bucketEnd in src/market/aggregate.ts. */
function bucketCloseOf(openSec, stepSec) {
  if (stepSec === MONTH_SEC) {
    var d = new Date(openSec * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  }
  return openSec + stepSec;
}

/* How long the bar under the tag lasts, for the countdown's rule. */
function barSpanOf(openSec, stepSec) {
  return bucketCloseOf(openSec, stepSec) - openSec;
}

function liveFrameMatches(frame) {
  if (!frame || !frame.candle || !CHART.dataView) return false;
  if (frame.product !== CHART.dataView.product) return false;
  // The venue that served the bars on screen, which is not always the one the view asked for.
  if (CHART.meta.source && frame.provider !== CHART.meta.source) return false;
  var step = CHART.dataView.granularitySec;
  if (!(step > 0) || !(frame.baseSec > 0)) return false;
  // A base that does not divide the bucket cannot be folded into it without straddling, and
  // a bar built from bars that straddle it is a price that never traded. A month is whole
  // days, so any base that divides a day folds into it.
  return step === MONTH_SEC ? 86400 % frame.baseSec === 0 : step % frame.baseSec === 0;
}

function candleLive(frame) {
  if (!liveFrameMatches(frame)) return;
  // The vault already records that a live chart slides out from under a drag. The newest frame
  // is held and applied on endDrag, so the hand keeps the chart and the price is not lost.
  if (CHART_DRAG) {
    CHART_LIVE_HELD = frame;
    return;
  }
  applyLiveCandle(frame);
}

function applyLiveCandle(frame) {
  var step = CHART.dataView.granularitySec;
  var bar = frame.candle;
  var slot = liveBucket(bar.t, step);
  var list = CHART.candles;
  var last = list.length ? list[list.length - 1] : null;

  // A frame for a bucket older than the newest one drawn is a straggler from a reconnect, and
  // rewriting a closed bar from one minute of it would be worse than ignoring it.
  if (last && slot < last.t) return;

  var key = frame.product + '|' + frame.provider + '|' + step;
  var held = CHART_LIVE && CHART_LIVE.key === key ? CHART_LIVE : null;
  // How much of this minute's volume is new. A repeat of a minute already counted contributes
  // only the difference; a minute never seen contributes all of it.
  var dv = held && held.minute === bar.t ? Math.max(0, bar.v - held.v) : bar.v;
  CHART_LIVE = { key: key, minute: bar.t, v: bar.v };

  if (last && slot === last.t) {
    // The bucket on screen is the one this bar belongs to. When the timeframe IS the base the
    // bar simply replaces it; otherwise the other minutes already folded into this bucket have
    // to survive, so only the parts a later minute can move are moved.
    if (step === frame.baseSec) {
      list[list.length - 1] = { t: slot, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v };
    } else {
      list[list.length - 1] = {
        t: slot,
        o: last.o,
        h: bar.h > last.h ? bar.h : last.h,
        l: bar.l < last.l ? bar.l : last.l,
        c: bar.c,
        v: last.v + dv
      };
    }
  } else {
    list.push({ t: slot, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    // A window panned back is anchored by index from the newest bar, so a bar appended under
    // it would walk the whole view one bar to the right. Anchor by the bar the human is
    // actually looking at instead.
    if (CHART.view.panOffset > 0) CHART.view.panOffset += 1;
    // The array only ever grows here, and a window left open for hours would grow it without
    // bound. Only the oldest go, only over the cap, and only at the live edge: a window panned
    // into history is looking at exactly the bars a trim would take.
    else if (list.length > CHART_KEEP_MAX) CHART.candles = list.slice(list.length - CHART_KEEP_MAX);
  }

  var newest = CHART.candles[CHART.candles.length - 1];
  CHART.meta.barCloseSec = Math.max(0, bucketCloseOf(newest.t, step) - Date.now() / 1000);
  startPriceTween(newest.c);
  chartInvalidate(true);
}

/* Applied when the hand comes off. Anything held is by definition the newest thing the venue
   said, so it is not stale, only late. */
function flushLiveCandle() {
  var held = CHART_LIVE_HELD;
  CHART_LIVE_HELD = null;
  if (held && liveFrameMatches(held)) applyLiveCandle(held);
}

function candlesPushed() {
  if (CHART_DRAG) return;
  // A floor on refetch rate, not a poll interval. It was 2000 ms, matched to a cache that
  // refreshed every 3 s, and the two throttles plus the server's own push timer stacked into
  // a price 4.0 s old at p50 (measured 2026-09-01). It is 250 ms now, matching staleAfterSec
  // in src/market/store.ts. This path is the REST fallback: the live rail moves the price
  // through candleLive() with no fetch at all. The floor grows with the payload, because the
  // series follows the view: a window squeezed to twenty thousand bars is megabytes per
  // refetch, and four of those a second would be all this window did.
  var minGap = clampNum(250 + CHART_FETCH.bytes / 2000, 250, 2500);
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
    if (box.dataset.filled !== String(CHART.timeframes.length)) fillTimeframes(box);
    var kids = box.childNodes;
    var picked = null;
    for (var k = 0; k < kids.length; k++) paintTimeframe(kids[k]);
    var menu = timeframeMenu(box);
    if (menu) {
      for (var m = 0; m < menu.childNodes.length; m++) {
        if (paintTimeframe(menu.childNodes[m])) picked = menu.childNodes[m].textContent;
      }
      var toggle = menu.parentNode && menu.parentNode.childNodes[0];
      if (toggle) {
        toggle.textContent = picked || 'More';
        toggle.className = picked ? 'timeframe tf-more on' : 'timeframe tf-more';
      }
    }
  }

  renderChartStatus();
}

/* The timeframes as cells: the six everyday ones always, the rest inline
   where the chart is wide and behind a More cell where it is not (the
   stylesheet decides which by the chart's width, on data-tier). The More
   cell wears the picked timeframe's name when the pick is one of the rest. */
var EVERYDAY_TF = { '1m': true, '5m': true, '15m': true, '1h': true, '4h': true, '1d': true };

function fillTimeframes(box) {
  box.textContent = '';
  var rest = [];
  for (var t = 0; t < CHART.timeframes.length; t++) {
    var tf = CHART.timeframes[t];
    var tier = EVERYDAY_TF[tf.label] ? 'day' : 'more';
    box.appendChild(timeframeButton(tf, tier));
    if (tier === 'more') rest.push(tf);
  }
  if (rest.length) {
    var wrap = document.createElement('span');
    wrap.className = 'tf-more-wrap';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'timeframe tf-more';
    toggle.textContent = 'More';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    var menu = document.createElement('span');
    menu.className = 'tf-menu pop';
    for (var r = 0; r < rest.length; r++) menu.appendChild(timeframeButton(rest[r], 'menu'));
    wrap.appendChild(toggle);
    wrap.appendChild(menu);
    box.appendChild(wrap);
    toggle.addEventListener('click', function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      setTimeframeMenu(box, menu.dataset.open !== 'true');
    });
    menu.addEventListener('click', function () { setTimeframeMenu(box, false); });
    document.addEventListener('click', function (ev) {
      if (menu.dataset.open === 'true' && ev.target !== toggle) setTimeframeMenu(box, false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && menu.dataset.open === 'true') {
        setTimeframeMenu(box, false);
        if (toggle.focus) toggle.focus();
      }
    });
  }
  box.dataset.filled = String(CHART.timeframes.length);
}

function timeframeButton(tf, tier) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'timeframe';
  button.dataset.sec = String(tf.sec);
  button.dataset.tier = tier;
  button.textContent = tf.label;
  return button;
}

function timeframeMenu(box) {
  var kids = box.childNodes;
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].className === 'tf-more-wrap') return kids[i].childNodes[1] || null;
  }
  return null;
}

function setTimeframeMenu(box, open) {
  var menu = timeframeMenu(box);
  if (!menu) return;
  if (open) menu.dataset.open = 'true';
  else delete menu.dataset.open;
  var toggle = menu.parentNode.childNodes[0];
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/* One cell painted against the timeframe on screen. True when it is it. */
function paintTimeframe(node) {
  if (!node || !node.dataset || node.dataset.sec === undefined) return false;
  var on = Number(node.dataset.sec) === CHART.view.granularitySec;
  node.className = on ? 'timeframe on' : 'timeframe';
  if (node.setAttribute) node.setAttribute('aria-pressed', on ? 'true' : 'false');
  return on;
}

/* "BTC-USD" is the chart's id for a market; the legend and the empty chart
   name the coin, the way the strip does. */
function coinOf(product) {
  return String(product || '').split('-')[0] || String(product || '');
}

/* Where the prices come from, as a name. */
function sourceName(source) {
  var names = { hyperliquid: 'Hyperliquid', coinbase: 'Coinbase', binance: 'Binance', kraken: 'Kraken', okx: 'OKX', bybit: 'Bybit' };
  var key = String(source || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(names, key)) return names[key];
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : 'the exchange';
}

/* What the data is doing, in one place.

   Three states and no more, because a person reading a chart has one question about the feed
   and it is "can I trust this number now". The server derives them (see meta.feed) from the
   socket and the age of the last delta; the fallback below is for a payload that predates the
   field, and it is the same reading made from what such a payload does carry. */
function feedState() {
  var feed = CHART.meta.feed;
  if (feed === 'live' || feed === 'delayed' || feed === 'offline') return feed;
  if (CHART.meta.error || CHART.meta.stale) return 'offline';
  if (!CHART.candles.length) return 'offline';
  return 'delayed';
}

/* The words for each state, the way a person needs them: live says so and
   nothing else; a slow feed says how often it moves; a paused one says the
   prices on screen are the last ones, which is the thing to know before
   trusting them. */
var FEED_WORDS = {
  live: 'Live',
  delayed: 'Updates every few seconds',
  offline: 'Prices paused, showing the last ones'
};
var FEED_TITLE = {
  live: 'Prices arrive as they trade.',
  delayed: 'There is no live feed right now, so the chart reads prices every few seconds.',
  offline: 'The price source is not answering. The chart shows the last prices it had and tries again.'
};

function renderChartStatus() {
  var cluster = document.getElementById('chart-status');
  if (!cluster) return;

  var state = feedState();
  var feed = document.getElementById('chart-feed');
  if (feed) {
    feed.dataset.feed = state;
    // The one loading sign on the surface. It used to be three blocks of its own beside a
    // separate meta line, which is two places saying halves of one thing.
    feed.dataset.busy = CHART_FETCH.inflight ? '1' : '0';
    var label = feed.querySelector('b');
    if (label) label.textContent = FEED_WORDS[state];
    feed.title = FEED_TITLE[state];
  }

  /* The venue's delay on the socket serving these bars, beside the state word. The server
     only sends it while the feed is live, and the stylesheet only shows it then: a delay on a
     feed that REST is serving would be a number about the wrong socket. It is a delay and not
     an age, so it does not climb between payloads; the number this replaced was the age of
     the trading socket's account snapshot, which the venue pushes every 5 s, so it ran from
     0 to 5000 ms and reset while the price moved every half second. */
  /* The socket's round trip is an engineer's number, so it is not written:
     "Live" is the whole answer a person needs. The slot stays for the
     stylesheet and is left empty. */
  var latency = document.getElementById('chart-latency');
  if (latency) latency.textContent = '';

  /* The venue word, in the Layers popover's foot. It prints what is actually SERVING the
     candles, and says "pinned" only when the choice was made rather than inherited, so a pin
     can never be mistaken for the default. It used to be a button that cycled the venue on
     click; the agent's chart_draw view is the one way to pin one now. */
  var venue = document.getElementById('chart-provider');
  if (venue) {
    var pinned = CHART.view.provider !== 'auto';
    venue.textContent = sourceName(CHART.meta.source) + (pinned ? ', chosen by your assistant' : '');
    venue.dataset.pinned = pinned ? '1' : '0';
    venue.title = pinned ? 'Your assistant chose where these prices come from.' : 'Phosphor picks the source that is answering.';
  }

  // Two controls that only exist when there is something to act on. Neither is a note about
  // the data: a note goes on the chart, beside the bars it is about.
  var extras = cluster.querySelectorAll('[data-extra]');
  for (var i = 0; i < extras.length; i++) extras[i].remove();

  if (CHART.view.panOffset > 0) {
    var live = chartButton('chart-extra', 'Back to now');
    live.id = 'chart-live';
    live.dataset.extra = '1';
    live.title = 'Scroll back to the newest prices';
    cluster.appendChild(live);
  }
  if (CHART.agentObjects > 0) {
    // One control carrying the count, not a count and a control: the bar has one row and the
    // status line shares it with the segment, the command and Layers.
    var many = CHART.agentObjects === 1 ? ' drawing' : ' drawings';
    var clear = chartButton('chart-extra', 'Clear ' + CHART.agentObjects + many);
    clear.id = 'chart-clear-agent';
    clear.dataset.extra = '1';
    clear.title = 'Your assistant drew ' + CHART.agentObjects + many + ' on this chart. Clear them.';
    cluster.appendChild(clear);
  }
}

/* The two situational controls are buttons, so the keyboard reaches them. */
function chartButton(className, text) {
  var button = document.createElement('button');
  button.type = 'button';
  if (className) button.className = className;
  button.textContent = text;
  return button;
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

/* The ceilings are the server's, taken from the payload rather than restated here, so a drag
   that has run out of room stops where the write would have clamped it instead of springing
   back a frame later. The values below are only what holds before the first payload lands. */
var CHART_BARS = { min: 10, max: 20000, panMax: 50000 };
/* How near the oldest bar held the left edge may come before older bars are asked for. The
   server serves this many bars beyond the edge, and the window asks when it is inside them. */
var CHART_FETCH_MARGIN = 30;

function setBarCount(next) {
  CHART.view.barCount = clampNum(next, CHART_BARS.min, CHART_BARS.max);
}

/* Back is unbounded until the venue's own first bar is on screen: the pan used to stop at four
   hundred bars, which read as the chart hitting a wall while the venue had years more. Once the
   series has said it has nothing older, the first bar may come as far as the last quarter of the
   plot, the same room the newest bar has on the other side. */
function setPan(next) {
  var back = CHART_BARS.panMax;
  if (CHART.meta.exhaustedBack && CHART.candles.length && typeof CHART.meta.oldest === 'number' && CHART.candles[0].t <= CHART.meta.oldest) {
    back = Math.max(0, CHART.candles.length - Math.ceil(CHART.view.barCount * 0.25));
  }
  CHART.view.panOffset = clampNum(next, -CHART.view.barCount * 0.25, back);
}

/* ---------- history behind the left edge ----------

   The payload carries the window the view shows and a margin, never the whole history: a
   window that asked for everything it might ever pan into would be megabytes on every refresh.
   So the window fetches older bars itself, a page at a time, when its left edge nears the
   oldest bar it holds, and prepends them. The pan is anchored at the newest bar, so a prepend
   moves nothing on screen; the plots are laid down again over the longer array and the server's
   own series follows the pushed view, which brings their values for the new region. */
var BACKFILL_BARS = 2000;
var CHART_BACKFILL = { inflight: false, key: '' };

function backfillKey() {
  var view = CHART.dataView || CHART.view;
  return view.product + '|' + view.granularitySec + '|' + (CHART.meta.source || '') + '|' + (CHART.view.provider || 'auto');
}

/* Whether the bars held reach the venue's first bar, which is the one place a pan may stop. */
function historyBegins() {
  return Boolean(CHART.meta.exhaustedBack && CHART.candles.length && typeof CHART.meta.oldest === 'number' && CHART.candles[0].t <= CHART.meta.oldest);
}

function maybeBackfill(L) {
  if (CHART_BACKFILL.inflight || !CHART.candles.length || !CHART_READY) return;
  if (historyBegins()) return;
  if (L.start > CHART_FETCH_MARGIN) return;
  void fetchOlder();
}

async function fetchOlder() {
  var first = CHART.candles[0];
  var key = backfillKey();
  var view = CHART.dataView || CHART.view;
  CHART_BACKFILL = { inflight: true, key: key };
  chartInvalidate(false);
  try {
    var url =
      '/api/candles?product=' + encodeURIComponent(view.product) +
      '&granularity=' + view.granularitySec +
      '&before=' + first.t +
      '&limit=' + BACKFILL_BARS +
      '&provider=' + encodeURIComponent(CHART.view.provider || 'auto');
    var res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('candles returned ' + res.status);
    var older = await res.json();
    var exhausted = res.headers.get('x-candle-exhausted-back') === 'true';
    var oldest = Number(res.headers.get('x-candle-oldest'));
    // Another market or bar length while this was on the wire: these bars are someone else's.
    if (backfillKey() !== key || !CHART.candles.length) return;
    prependCandles(older);
    CHART.meta.exhaustedBack = exhausted;
    if (isFinite(oldest) && oldest > 0) CHART.meta.oldest = oldest;
    else if (exhausted) CHART.meta.oldest = CHART.candles[0].t;
  } catch (err) {
    // The chart still draws what it holds; the next frame near the edge asks again.
  } finally {
    CHART_BACKFILL.inflight = false;
    chartInvalidate(true);
  }
}

/* Older bars in front of the ones held. Only the ones actually older go in, in case the two
   windows overlap by a bar, and every plot is laid down again over the longer array. */
function prependCandles(older) {
  if (!older || !older.length) return;
  var firstT = CHART.candles[0].t;
  var fresh = [];
  for (var i = 0; i < older.length; i++) if (older[i].t < firstT) fresh.push(older[i]);
  if (!fresh.length) return;
  CHART.candles = fresh.concat(CHART.candles);
  CHART.indicators = rebaseIndicators(CHART.indicators, fresh.length, CHART.candles.length);
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
        // The volume pane is built in this window and the server has never heard of it, so
        // asking the server to remove it would be a round trip that answers "remove what?".
        if (hit.remove === VOLUME_ID) toggleVolume();
        else void pushChart({ removeIndicator: hit.remove });
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
    // Whatever the venue said while the hand was down. Applied before the fetch below so the
    // price is right immediately rather than a round trip later, and harmless if the fetch
    // lands first: applyChart replaces the array either way.
    flushLiveCandle();
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
      /* The timeframe handler below has always reset the pan and this one never did, which is
         half of why a symbol switch drew off-scale. The server drops both fields on a product
         change now, but resetting here too means the pane is correct on the very first frame
         rather than on the round trip back, and the tween has a sane place to start from. */
      CHART.view.panOffset = 0;
      CHART.view.priceScale = { mode: 'auto' };
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

  var meta = document.getElementById('chart-status');
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

  // The chart's indicator field is ui/screens/trade.js's: it lists what can be added and
  // hands the words here (window.chartCommand), in the same vocabulary the agent uses,
  // "ema 50", "rsi", "bbands 20 2.5", "clear".

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
    CHART.meta.barCloseSec = last ? Math.max(0, bucketCloseOf(last.t, CHART.view.granularitySec) - Date.now() / 1000) : null;
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

/* The words from the indicator field. True when they named something the
   chart can do, which is then pushed; false leaves the field as it was. */
function chartCommand(raw) {
  var parsed = parseCommand(raw);
  if (!parsed) return false;
  void pushChart(parsed);
  return true;
}
window.chartCommand = chartCommand;

function chartBoot() {
  // The stylesheet is in by now, so the canvas can take its palette from the same tokens the
  // rest of the window is painted with rather than from the copy at the top of this file.
  readTokens();
  readVolumePreference();
  wireChart();
  chartInvalidate(true);
  // A canvas draws with whatever face is loaded when it draws, and the first frame can land
  // before the vendored face is. One repaint once it is in, so the axis is not left in the
  // fallback face until something else moves.
  if (document.fonts && typeof document.fonts.load === 'function') {
    document.fonts.load(CHART_FONT).then(function () {
      // The digit cells were measured in whatever face was in; measure them again in Geist.
      CHART_TEXT_CELLS = {};
      chartInvalidate(true);
    }, function () {});
  }
  void refreshChart();
  // A floor under the push stream: a dead socket or an idle book still refreshes.
  setInterval(function () {
    if (Date.now() - CHART_FETCH.at > 15000) void refreshChart();
  }, 5000);
}
