/* PHOSPHOR one-page client. Plain browser JS, no imports, no framework.
   Every dynamic string reaches the DOM through textContent. Audit lines, policy
   sentences and proposal summaries carry agent-authored text verbatim by design,
   so innerHTML is never used anywhere in this file. */

'use strict';

var REFUSAL_TYPES = { policy_refused: 1, refused: 1, approve_attempt_rejected: 1 };
var EPS = 1e-9;
var LOG_MAX_LINES = 400;

/* Timeframes. Anything under 60s has no exchange candle behind it: Hyperliquid's
   interval enum starts at 1m, so the server builds those from the trade stream and
   they are live-only. See src/hyperliquid.ts. */
var TIMEFRAMES = [
  { label: '1s', sec: 1 },
  { label: '5s', sec: 5 },
  { label: '15s', sec: 15 },
  { label: '1m', sec: 60 },
  { label: '5m', sec: 300 },
  { label: '15m', sec: 900 },
  { label: '1h', sec: 3600 },
  { label: '4h', sec: 14400 },
  { label: '1d', sec: 86400 }
];
var TIMEFRAME_SEC = 60;

/* Chart view state, TradingView semantics:
     VIEW_COUNT   how many candles are on screen  (bottom axis drag, or wheel)
     PAN_OFFSET   how far back from the newest candle the window sits (plot drag)
     PRICE_ZOOM   multiplier on the auto-fitted price span (right axis drag)
   The fetch pulls VIEW_COUNT + PAN_OFFSET + margin so panning has history to move
   through, capped at the server's own limit. */
var VIEW_COUNT = 120;
var VIEW_COUNT_MIN = 20;
var VIEW_COUNT_MAX = 500;
var PAN_OFFSET = 0;
var PAN_MAX = 400;
var PRICE_ZOOM = 1;
var PRICE_ZOOM_MIN = 0.15;
var PRICE_ZOOM_MAX = 8;
var FETCH_MARGIN = 60;
var FETCH_LIMIT_MAX = 1000;

/* Canvas hit regions. The right strip is the price axis, the bottom strip is the
   time axis, everything else is the plot. Kept here so drawing and hit-testing
   cannot drift apart. */
var PAD_RIGHT = 70;
var PAD_BOTTOM = 20;
var PAD_TOP = 4;

/* Direction colour. Down is deliberately darker than the approval gate's #ff3b30
   so the gate stays the only alarm red on the page even though the chart now uses
   red at all. */
var CHART_UP = '#33ff66';
var CHART_DOWN = '#cc3a30';

/* Donut. One hue, brightness by rank: the biggest slice is the brightest. The
   ramp stops short of --green-hi (hsl 136 100% 77.5%) so the hover highlight is
   brighter than any resting slice and cannot be mistaken for one. */
var DONUT_HUE = 135;
var DONUT_L_TOP = 72;
var DONUT_L_BOTTOM = 24;
/* A straight rank ramp spends most of its range on slices too thin to see: with
   eighteen positions the six that own the ring would separate by two points of
   lightness each and read as one flat band. The ease front-loads the range onto
   the ranks that are actually wide enough to tell apart. */
var DONUT_L_EASE = 0.55;
var DONUT_HI = '#8cffab';
var DONUT_INNER = 0.58;

var COLLAPSE_PREFIX = 'phosphor.collapse.';

var TOKEN = null;
var WALLET = { rows: [], totalUsd: 0, byChain: {}, stale: [] };
var DONUT_SLICES = [];
var DONUT_GEOM = null;
var HOVER_ROW = -1;
var COLLAPSE_MEM = {};
var STATE = null;
var CANDLES = [];
var CANDLE_META = { source: '', collected: 0, built: '', stale: false };
var CANDLE_LAST_FETCH = 0;
var CANDLE_FETCH_INFLIGHT = false;
var CHART_DRAGGING = false;
var SSE_SEEN_OPEN = false;
var REFRESH_INFLIGHT = false;
var REFRESH_QUEUED = false;

/* ---------- small helpers ---------- */

function $(id) {
  return document.getElementById(id);
}

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function usd(n) {
  var v = Number(n);
  if (!isFinite(v)) return 'n/a';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function usdWhole(n) {
  var v = Number(n);
  if (!isFinite(v)) return 'n/a';
  return '$' + Math.round(v).toLocaleString('en-US');
}

function pct(share) {
  var v = Number(share);
  if (!isFinite(v)) return 'n/a';
  return (v * 100).toFixed(2) + '%';
}

function amount(n) {
  var v = Number(n);
  if (!isFinite(v)) return 'n/a';
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/* A wallet prices a stable at 1.00 and a cheap token at six places. One column
   has to hold both, so the precision follows the magnitude. */
function price(n) {
  var v = Number(n);
  if (!isFinite(v)) return 'n/a';
  var digits = v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function clock(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toTimeString().slice(0, 8);
}

function padEnd(s, n) {
  var out = String(s);
  while (out.length < n) out += ' ';
  return out;
}

function alertLine(text) {
  var node = $('alert');
  if (!text) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = 'client: ' + text;
  node.hidden = false;
}

async function getJson(url) {
  var res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(url + ' returned ' + res.status);
  return res.json();
}

async function postJson(url, body) {
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  var payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    throw new Error((payload && payload.error) || (url + ' returned ' + res.status));
  }
  return payload;
}

/* ---------- box-drawing frames ---------- */

function charWidth() {
  var probe = $('__probe');
  if (!probe) {
    probe = el('span', null, '0000000000000000000000000000000000000000000000000000000000000000');
    probe.id = '__probe';
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre';
    document.body.appendChild(probe);
  }
  return probe.getBoundingClientRect().width / probe.textContent.length;
}

function layoutFrames() {
  var cw = charWidth();
  if (!cw) return;
  var frames = document.querySelectorAll('.frame');
  for (var i = 0; i < frames.length; i++) {
    var frame = frames[i];
    var cols = Math.max(24, Math.floor(frame.parentElement.clientWidth / cw));
    var title = frame.getAttribute('data-title');
    if (!title) {
      frame.textContent = '└' + repeat('─', Math.max(1, cols - 2)) + '┘';
      continue;
    }
    // A collapsible panel draws its own control into the frame line: [-] open,
    // [+] shut. Shut, the corners become tees, because there is no body left
    // below to corner off.
    var name = frame.getAttribute('data-collapse');
    var shut = name ? isCollapsed(name) : false;
    var head = (shut ? '├' : '┌') + '─ ' + title + ' ';
    var tail = name ? ' [' + (shut ? '+' : '-') + '] ─' + (shut ? '┤' : '┐') : '┐';
    frame.textContent = head + repeat('─', Math.max(1, cols - head.length - tail.length)) + tail;
  }
}

/* ---------- collapsible panels ---------- */

/* The layout Karim leaves is the layout he returns to, so the state lives in
   localStorage. The in-memory copy is what keeps the control working when
   storage throws, which it does in a locked-down browser profile. */
function isCollapsed(name) {
  if (COLLAPSE_MEM[name] !== undefined) return COLLAPSE_MEM[name];
  try {
    return window.localStorage.getItem(COLLAPSE_PREFIX + name) === '1';
  } catch (err) {
    return false;
  }
}

function setCollapsed(name, shut) {
  COLLAPSE_MEM[name] = shut;
  try {
    window.localStorage.setItem(COLLAPSE_PREFIX + name, shut ? '1' : '0');
  } catch (err) {
    // Nothing to do: the in-memory copy above still carries this session.
  }
}

function applyCollapse() {
  var controls = document.querySelectorAll('[data-collapse]');
  for (var i = 0; i < controls.length; i++) {
    var name = controls[i].getAttribute('data-collapse');
    var shut = isCollapsed(name);
    var panel = controls[i].parentElement;
    panel.classList.toggle('collapsed', shut);
    controls[i].setAttribute('aria-expanded', shut ? 'false' : 'true');
    // The sibling that should take the released space is a CSS question, so the
    // answer goes on the body where CSS can reach it.
    document.body.classList.toggle(name + '-collapsed', shut);
  }
  layoutFrames();
}

function wireCollapse() {
  var controls = document.querySelectorAll('[data-collapse]');
  for (var i = 0; i < controls.length; i++) {
    controls[i].addEventListener('click', function () {
      var name = this.getAttribute('data-collapse');
      setCollapsed(name, !isCollapsed(name));
      applyCollapse();
    });
  }
}

function repeat(ch, n) {
  var out = '';
  for (var i = 0; i < n; i++) out += ch;
  return out;
}

/* ---------- 1. status ---------- */

function renderStatus(s) {
  // Held is the whole wallet now: natives and LP positions included, not the
  // stable subset the composition view used to report.
  var count = WALLET.rows.length;
  $('stat-total').textContent = usd(WALLET.totalUsd);
  $('stat-positions').textContent = count + (count === 1 ? ' position' : ' positions');

  var connected = (s.agents && s.agents.connected) || 0;
  var agentNode = $('stat-agent');
  agentNode.textContent = connected === 0 ? 'none' : connected === 1 ? 'connected' : connected + ' connected';
  agentNode.className = connected === 0 ? 'v faint' : 'v';

  // Which world this is running against matters more than demo/live, and the
  // gate banner below only makes sense next to it.
  $('stat-mode').textContent = (s.mode || '--') + (s.network ? ' / ' + s.network : '');

  var kill = s.policy ? s.policy.killSwitch === true : false;
  var policyNode = $('stat-policy');
  if (!s.policy) {
    policyNode.textContent = 'UNREADABLE';
    policyNode.className = 'v red';
  } else if (kill) {
    policyNode.textContent = 'KILL SWITCH ON';
    policyNode.className = 'v red';
  } else {
    policyNode.textContent = ((s.sentences && s.sentences.length) || 0) + ' rules';
    policyNode.className = 'v';
  }
  $('policy-banner').hidden = Boolean(s.policy);

  var btn = $('kill-btn');
  btn.textContent = '[ KILL SWITCH: ' + (kill ? 'ON' : 'OFF') + ' ]';
  btn.className = kill ? 'btn on' : 'btn';
  btn.dataset.on = kill ? '1' : '0';
  btn.disabled = false;
}

/* ---------- 2. wallet ---------- */

function issuerCap(policy, issuer) {
  if (!policy) return 1;
  var caps = policy.composition.maxIssuerShare || {};
  if (typeof caps[issuer] === 'number') return caps[issuer];
  if (typeof caps.default === 'number') return caps.default;
  return 1;
}

/* The wallet view is the server's to build: it owns the prices, the LP
   positions and which chains went stale. The client renders it and does not
   reconstruct it, so a chain that failed to read shows as stale rather than as
   a wallet that quietly got smaller. */
function walletOf(s) {
  if (s.wallet && Array.isArray(s.wallet.rows)) return s.wallet;
  return { rows: [], totalUsd: 0, byChain: {}, stale: [] };
}

/* Which wallet rows sit over a policy cap. Composition is still the authority:
   it carries the issuer of every classified token and the freezable total. The
   table stopped showing issuer and FRZ, but a breach still lands on the SHARE
   cell of the row that caused it (spec 3.4). */
function breachedRows(s) {
  var comp = s.composition;
  var out = {};
  if (!comp) return out;
  var freezeCap = s.policy ? s.policy.composition.maxFreezableShare : 1;
  var freezeBreach = comp.freezableShare > freezeCap + EPS;
  var rows = comp.rows || [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var issuerBreach = (comp.byIssuer[row.issuer] || 0) > issuerCap(s.policy, row.issuer) + EPS;
    if (issuerBreach || (row.freezable && freezeBreach)) out[row.chain + '|' + row.symbol] = true;
  }
  return out;
}

function renderWallet(s) {
  WALLET = walletOf(s);
  var breach = breachedRows(s);
  var stale = {};
  for (var st = 0; st < WALLET.stale.length; st++) stale[WALLET.stale[st]] = true;

  var tbody = $('wallet-rows');
  tbody.textContent = '';
  for (var i = 0; i < WALLET.rows.length; i++) {
    var row = WALLET.rows[i];
    var tr = document.createElement('tr');
    tr.dataset.index = String(i);
    // An LP row carries the pair as its symbol and reads as one ordinary line.
    tr.appendChild(el('td', 'token', row.symbol));
    var chain = el('td', 'chain');
    chain.appendChild(document.createTextNode(row.chain));
    if (stale[row.chain]) {
      chain.appendChild(document.createTextNode(' '));
      chain.appendChild(el('span', 'stale', 'STALE'));
    }
    tr.appendChild(chain);
    tr.appendChild(el('td', 'num', amount(row.quantity)));
    tr.appendChild(el('td', 'num', price(row.priceUsd)));
    tr.appendChild(el('td', 'num', usd(row.valueUsd)));
    var hit = breach[row.chain + '|' + row.symbol];
    tr.appendChild(el('td', hit ? 'num share breach' : 'num share', pct(row.share)));
    tbody.appendChild(tr);
  }
  if (!WALLET.rows.length) {
    var empty = document.createElement('tr');
    var cell = el('td', 'faint', 'wallet empty: nothing held on any chain');
    cell.colSpan = 6;
    empty.appendChild(cell);
    tbody.appendChild(empty);
  }

  renderWalletTotals(s);
  if (HOVER_ROW >= WALLET.rows.length) HOVER_ROW = -1;
  drawDonut();
  renderReadout();
}

function renderWalletTotals(s) {
  var node = $('wallet-total');
  node.textContent = '';
  node.appendChild(el('span', null, 'TOTAL '));
  node.appendChild(el('span', 'hi', usd(WALLET.totalUsd)));

  var chains = Object.keys(WALLET.byChain);
  chains.sort(function (a, b) { return WALLET.byChain[b] - WALLET.byChain[a]; });
  for (var i = 0; i < chains.length; i++) {
    node.appendChild(el('span', 'faint', '   ' + chains[i] + ' ' + usdWhole(WALLET.byChain[chains[i]])));
  }

  // Freezable is what turns a SHARE cell red, so the number that decides it
  // stays on the page next to the cells it marks.
  var comp = s.composition;
  if (comp) {
    var freezeCap = s.policy ? s.policy.composition.maxFreezableShare : 1;
    var freezeBreach = comp.freezableShare > freezeCap + EPS;
    node.appendChild(el('span', 'dim', '   freezable '));
    node.appendChild(el('span', freezeBreach ? 'red' : 'dim', pct(comp.freezableShare)));
    if (freezeBreach) node.appendChild(el('span', 'red', ' over cap ' + pct(freezeCap)));
  }
  if (WALLET.stale.length) {
    node.appendChild(el('span', 'hi', '   STALE: ' + WALLET.stale.join(', ')));
  }
}

/* ---------- 2b. the donut ---------- */

/* Rank, not category: the biggest slice is the brightest and the ramp falls to
   the smallest. Same hue throughout, which is the whole page's rule. */
function sliceColour(rank, count) {
  var t = count < 2 ? 0 : Math.pow(rank / (count - 1), DONUT_L_EASE);
  var lightness = DONUT_L_TOP - (DONUT_L_TOP - DONUT_L_BOTTOM) * t;
  return 'hsl(' + DONUT_HUE + ', 100%, ' + lightness.toFixed(1) + '%)';
}

function drawDonut() {
  var canvas = $('donut');
  DONUT_SLICES = [];
  DONUT_GEOM = null;
  var width = canvas.clientWidth;
  var height = canvas.clientHeight;
  if (!width || !height) return;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  var cx = width / 2;
  var cy = height / 2;
  var outer = Math.min(width, height) / 2 - 5;
  if (outer <= 6) return;
  var inner = outer * DONUT_INNER;
  DONUT_GEOM = { cx: cx, cy: cy, outer: outer, inner: inner };

  var rows = WALLET.rows;
  if (!rows.length || !(WALLET.totalUsd > 0)) {
    ctx.strokeStyle = 'rgba(51, 255, 102, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(51, 255, 102, 0.38)';
    ctx.fillText('empty', cx, cy);
    ctx.textAlign = 'left';
    return;
  }

  // A gap of about 1.5px at the outer edge, expressed as an angle, so two
  // neighbouring ranks never merge into one unreadable ring.
  var gap = 1.5 / outer;
  var angle = -Math.PI / 2;
  for (var i = 0; i < rows.length; i++) {
    var sweep = (rows[i].valueUsd / WALLET.totalUsd) * Math.PI * 2;
    DONUT_SLICES.push({ start: angle, end: angle + sweep });
    var lit = i === HOVER_ROW;
    var edge = lit ? outer + 3 : outer;
    var trim = sweep > gap * 3 ? gap : 0;
    ctx.beginPath();
    ctx.arc(cx, cy, edge, angle + trim / 2, angle + sweep - trim / 2);
    ctx.arc(cx, cy, inner, angle + sweep - trim / 2, angle + trim / 2, true);
    ctx.closePath();
    ctx.fillStyle = lit ? DONUT_HI : sliceColour(i, rows.length);
    ctx.fill();
    angle += sweep;
  }

  ctx.fillStyle = 'rgba(51, 255, 102, 0.62)';
  ctx.fillText(usdWhole(WALLET.totalUsd), cx, cy);
  ctx.textAlign = 'left';
}

function renderReadout() {
  var node = $('donut-readout');
  node.textContent = '';
  var row = HOVER_ROW >= 0 && HOVER_ROW < WALLET.rows.length ? WALLET.rows[HOVER_ROW] : null;
  if (!row) {
    var count = WALLET.rows.length;
    var chains = Object.keys(WALLET.byChain).length;
    node.appendChild(el('span', 'line faint', count + (count === 1 ? ' position' : ' positions')));
    node.appendChild(el('span', 'line faint', chains + (chains === 1 ? ' chain' : ' chains')));
    return;
  }
  node.appendChild(el('span', 'line sym', row.symbol + '  ' + row.chain));
  node.appendChild(el('span', 'line', usd(row.valueUsd) + '  ' + pct(row.share)));
}

/* Which slice a point on the canvas is inside. Slices are laid out from -PI/2
   clockwise, so an atan2 angle below -PI/2 belongs to the far end of the ring. */
function donutIndexAt(x, y) {
  if (!DONUT_GEOM || !DONUT_SLICES.length) return -1;
  var dx = x - DONUT_GEOM.cx;
  var dy = y - DONUT_GEOM.cy;
  var r = Math.sqrt(dx * dx + dy * dy);
  if (r < DONUT_GEOM.inner || r > DONUT_GEOM.outer + 3) return -1;
  var a = Math.atan2(dy, dx);
  if (a < -Math.PI / 2) a += Math.PI * 2;
  for (var i = 0; i < DONUT_SLICES.length; i++) {
    if (a >= DONUT_SLICES[i].start && a < DONUT_SLICES[i].end) return i;
  }
  return -1;
}

/* One hover state, two surfaces: point at a slice and its row lights up, point
   at a row and its slice does. Click does nothing, because on a one-page app
   there is nowhere for a click to go. */
function setHover(index) {
  if (index === HOVER_ROW) return;
  HOVER_ROW = index;
  var rows = $('wallet-rows').children;
  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('hi-row', i === index);
  }
  drawDonut();
  renderReadout();
}

/* ---------- 3. chart ---------- */

function renderProducts(s) {
  var select = $('product');
  var products = s.candleProducts || [];
  var key = products.join(',');
  if (select.dataset.filled === key) return;
  var current = select.value;
  select.textContent = '';
  for (var i = 0; i < products.length; i++) {
    var option = el('option', null, products[i]);
    option.value = products[i];
    select.appendChild(option);
  }
  select.dataset.filled = key;
  if (products.indexOf(current) !== -1) select.value = current;
}

function timeframeLabel() {
  for (var i = 0; i < TIMEFRAMES.length; i++) {
    if (TIMEFRAMES[i].sec === TIMEFRAME_SEC) return TIMEFRAMES[i].label;
  }
  return TIMEFRAME_SEC + 's';
}

function renderTimeframes() {
  var box = $('timeframes');
  if (box.dataset.filled === '1') {
    var kids = box.childNodes;
    for (var k = 0; k < kids.length; k++) {
      var on = Number(kids[k].dataset.sec) === TIMEFRAME_SEC;
      kids[k].className = on ? 'tf on' : 'tf';
    }
    return;
  }
  box.textContent = '';
  for (var i = 0; i < TIMEFRAMES.length; i++) {
    var tf = TIMEFRAMES[i];
    var b = el('button', tf.sec === TIMEFRAME_SEC ? 'tf on' : 'tf', tf.label);
    b.type = 'button';
    b.dataset.sec = String(tf.sec);
    box.appendChild(b);
  }
  box.dataset.filled = '1';
}

function setChartMeta(error) {
  var meta = $('chart-meta');
  meta.textContent = '';
  if (error) {
    meta.appendChild(el('span', 'faint', 'no candle data: ' + error));
    return;
  }
  meta.appendChild(el('span', 'faint', CANDLE_META.source + '  ' + VIEW_COUNT + ' candles'));
  if (PAN_OFFSET > 0) meta.appendChild(el('span', 'faint', '  panned back ' + PAN_OFFSET));
  if (PRICE_ZOOM !== 1) meta.appendChild(el('span', 'faint', '  price x' + (1 / PRICE_ZOOM).toFixed(2)));
  if (CANDLE_META.built === 'trades') {
    // Sub-minute history does not exist to be fetched, it accumulates. Say so,
    // rather than letting a short chart read as a broken one.
    var want = TIMEFRAME_SEC * VIEW_COUNT;
    if (CANDLE_META.collected < want) {
      meta.appendChild(el('span', 'faint', '  building from live trades: ' + CANDLE_META.collected + 's of ' + want + 's'));
    }
  }
  if (CANDLE_META.stale) meta.appendChild(el('span', 'hi', '   STALE: source unreachable, showing last known'));
}

async function refreshCandles() {
  var product = $('product').value;
  if (!product) return;
  if (CANDLE_FETCH_INFLIGHT) return;
  CANDLE_FETCH_INFLIGHT = true;
  CANDLE_LAST_FETCH = Date.now();
  var fetchLimit = Math.min(FETCH_LIMIT_MAX, VIEW_COUNT + PAN_OFFSET + FETCH_MARGIN);
  var url = '/api/candles?product=' + encodeURIComponent(product) +
    '&granularity=' + TIMEFRAME_SEC + '&limit=' + fetchLimit;
  try {
    var res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      var detail = null;
      try {
        detail = await res.json();
      } catch (err) {
        detail = null;
      }
      throw new Error((detail && detail.error) || ('candles returned ' + res.status));
    }
    var prevNewest = CANDLES.length ? CANDLES[CANDLES.length - 1].t : null;
    CANDLES = await res.json();
    // Panned back? Hold the window over the same candles as new ones arrive.
    // Without this the chart slides out from under the drag on every push.
    if (PAN_OFFSET > 0 && prevNewest !== null) {
      var added = 0;
      for (var ci = CANDLES.length - 1; ci >= 0; ci--) {
        if (CANDLES[ci].t > prevNewest) added++;
        else break;
      }
      if (added > 0) PAN_OFFSET = Math.min(PAN_MAX, PAN_OFFSET + added);
    }
    CANDLE_META = {
      source: res.headers.get('x-candle-source') || 'unknown',
      collected: Number(res.headers.get('x-candle-collected') || 0),
      built: res.headers.get('x-candle-built') || '',
      stale: res.headers.get('x-candle-stale') === 'true'
    };
    setChartMeta(null);
    drawChart();
  } catch (err) {
    CANDLES = [];
    drawChart();
    setChartMeta(err.message || String(err));
  } finally {
    CANDLE_FETCH_INFLIGHT = false;
  }
}

/* The trade stream pushes on every batch. Sub-minute candles are served from
   memory so they can refresh fast; a minute-and-above candle comes from the
   exchange over REST and must not be refetched at trade rate. */
function candlesPushed() {
  // A refetch mid-drag fights the hand that is moving the chart.
  if (CHART_DRAGGING) return;
  var minGap = TIMEFRAME_SEC < 60 ? 250 : 5000;
  if (Date.now() - CANDLE_LAST_FETCH < minGap) return;
  void refreshCandles();
}

function setTimeframe(sec) {
  if (sec === TIMEFRAME_SEC) return;
  TIMEFRAME_SEC = sec;
  CANDLES = [];
  // A new timeframe is a new scale; carrying the old pan would land nowhere useful.
  PAN_OFFSET = 0;
  renderTimeframes();
  drawChart();
  void refreshCandles();
}

// Redraw now from the candles already in hand, and refetch only if the window
// has moved past what was fetched. Keeps dragging at frame rate instead of at
// network rate.
function applyView(needsFetch) {
  setChartMeta(null);
  drawChart();
  if (needsFetch) void refreshCandles();
}

function setViewCount(next) {
  var clamped = Math.max(VIEW_COUNT_MIN, Math.min(VIEW_COUNT_MAX, Math.round(next)));
  if (clamped === VIEW_COUNT) return;
  VIEW_COUNT = clamped;
  applyView(VIEW_COUNT + PAN_OFFSET + 1 > CANDLES.length);
}

function setPanOffset(next) {
  var maxBack = Math.max(0, Math.min(PAN_MAX, FETCH_LIMIT_MAX - VIEW_COUNT));
  var clamped = Math.max(0, Math.min(maxBack, Math.round(next)));
  if (clamped === PAN_OFFSET) return;
  PAN_OFFSET = clamped;
  applyView(VIEW_COUNT + PAN_OFFSET + 1 > CANDLES.length);
}

function setPriceZoom(next) {
  var clamped = Math.max(PRICE_ZOOM_MIN, Math.min(PRICE_ZOOM_MAX, next));
  if (Math.abs(clamped - PRICE_ZOOM) < 0.0001) return;
  PRICE_ZOOM = clamped;
  // Price scale is pure presentation: never costs a fetch.
  applyView(false);
}

// The candles actually on screen: the window of VIEW_COUNT ending PAN_OFFSET
// back from the newest.
function visibleCandles() {
  var end = Math.max(1, CANDLES.length - PAN_OFFSET);
  var start = Math.max(0, end - VIEW_COUNT);
  return CANDLES.slice(start, end);
}

// Which control a point on the canvas belongs to.
function chartRegionAt(x, y, width, height) {
  if (x >= width - PAD_RIGHT) return 'price';
  if (y >= height - PAD_BOTTOM) return 'time';
  return 'plot';
}

function drawChart() {
  var canvas = $('chart');
  var width = canvas.clientWidth;
  var height = canvas.clientHeight;
  if (!width || !height) return;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';

  var dim = 'rgba(51,255,102,0.45)';
  var faint = 'rgba(51,255,102,0.30)';

  if (!CANDLES.length) {
    ctx.fillStyle = faint;
    ctx.fillText('no candle data', 0, 14);
    return;
  }

  var view = visibleCandles();
  if (!view.length) {
    ctx.fillStyle = faint;
    ctx.fillText('no candles in this window', 0, 14);
    return;
  }

  var padRight = PAD_RIGHT;
  var padBottom = PAD_BOTTOM;
  var padTop = PAD_TOP;
  var plotWidth = Math.max(10, width - padRight);
  var plotHeight = Math.max(10, height - padBottom - padTop);

  var low = Infinity;
  var high = -Infinity;
  for (var i = 0; i < view.length; i++) {
    if (view[i].l < low) low = view[i].l;
    if (view[i].h > high) high = view[i].h;
  }
  if (!(high > low)) {
    high = low + Math.max(1, Math.abs(low) * 0.001);
  }
  // Price zoom expands or compresses the auto-fitted span about its midpoint,
  // which is what dragging the right axis does on a trading chart.
  if (PRICE_ZOOM !== 1) {
    var mid = (high + low) / 2;
    var half = ((high - low) / 2) * PRICE_ZOOM;
    low = mid - half;
    high = mid + half;
  }
  var span = high - low;

  function yOf(value) {
    return padTop + ((high - value) / span) * plotHeight;
  }

  var slot = plotWidth / view.length;
  var bodyWidth = Math.max(1, Math.floor(slot * 0.62));

  for (var j = 0; j < view.length; j++) {
    var candle = view[j];
    var centre = Math.round(j * slot + slot / 2) + 0.5;
    var up = candle.c >= candle.o;
    // Direction is carried by hue now, not by fill. Both bodies are solid.
    var colour = up ? CHART_UP : CHART_DOWN;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(centre, yOf(candle.h));
    ctx.lineTo(centre, yOf(candle.l));
    ctx.stroke();

    var top = Math.min(yOf(candle.o), yOf(candle.c));
    var bodyHeight = Math.max(1, Math.abs(yOf(candle.c) - yOf(candle.o)));
    var left = Math.round(centre - bodyWidth / 2) + 0.5;
    ctx.fillRect(left, top, bodyWidth, bodyHeight);
  }

  // Y axis: ticks only, labels on the right, no grid lines.
  ctx.strokeStyle = faint;
  ctx.fillStyle = dim;
  for (var t = 0; t <= 3; t++) {
    var value = high - (span * t) / 3;
    var y = Math.round(yOf(value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plotWidth, y);
    ctx.lineTo(plotWidth + 4, y);
    ctx.stroke();
    ctx.fillText(formatTick(value), plotWidth + 8, y);
  }

  // X axis: three time ticks under the plot.
  var marks = [0, Math.floor(view.length / 2), view.length - 1];
  for (var m = 0; m < marks.length; m++) {
    var index = marks[m];
    if (index < 0 || index >= view.length) continue;
    var x = Math.round(index * slot + slot / 2) + 0.5;
    ctx.strokeStyle = faint;
    ctx.beginPath();
    ctx.moveTo(x, padTop + plotHeight);
    ctx.lineTo(x, padTop + plotHeight + 3);
    ctx.stroke();
    ctx.fillStyle = dim;
    ctx.textAlign = m === 0 ? 'left' : m === marks.length - 1 ? 'right' : 'center';
    // Seconds matter below the minute and are noise above it.
    var stamp = clock(view[index].t * 1000);
    ctx.fillText(TIMEFRAME_SEC < 60 ? stamp : stamp.slice(0, 5), x, padTop + plotHeight + 9);
  }
  ctx.textAlign = 'left';
}

function formatTick(value) {
  var abs = Math.abs(value);
  var digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : 4;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/* ---------- 5. policy ---------- */

function renderPolicy(s) {
  var box = $('policy-lines');
  box.textContent = '';
  if (!s.policy) {
    box.appendChild(el('div', 'rule red', 'POLICY FILE UNREADABLE: ALL WRITES REFUSED'));
    return;
  }
  var lines = s.sentences || [];
  if (!lines.length) {
    box.appendChild(el('div', 'rule faint', 'no rules authored'));
    return;
  }
  for (var i = 0; i < lines.length; i++) {
    var refusalState = lines[i].indexOf('KILL SWITCH ON') === 0;
    var rule = el('div', refusalState ? 'rule red' : 'rule');
    rule.appendChild(el('span', 'prompt', '$ '));
    rule.appendChild(document.createTextNode(lines[i]));
    box.appendChild(rule);
  }
}

/* ---------- 6. approval gate ---------- */

function headlineFor(proposal) {
  var draft = proposal.draft || {};
  if (draft.kind === 'consolidate') {
    var legs = (draft.legs || []).length;
    return 'consolidate ' + draft.symbol + ' to ' + draft.toChain + '  ' + usd(draft.totalUsd) +
      '  (' + legs + (legs === 1 ? ' leg)' : ' legs)');
  }
  if (draft.kind === 'policy_change') return 'policy change: ' + draft.sentence;
  if (draft.kind === 'transfer' && draft.leg) {
    return 'transfer ' + draft.leg.symbol + ' ' + draft.leg.fromChain + ' to ' + draft.leg.toChain +
      '  ' + usd(draft.leg.amountUsd);
  }
  return String(proposal.kind);
}

function diffOf(before, after) {
  var b = before || [];
  var a = after || [];
  var removed = [];
  var added = [];
  var i;
  for (i = 0; i < b.length; i++) if (a.indexOf(b[i]) === -1) removed.push(b[i]);
  for (i = 0; i < a.length; i++) if (b.indexOf(a[i]) === -1) added.push(a[i]);
  return { removed: removed, added: added };
}

function pendingBlock(proposal) {
  var wrap = el('div', 'pending');

  var head = el('div');
  head.appendChild(el('span', 'tag', 'PENDING  '));
  head.appendChild(el('span', 'head', headlineFor(proposal)));
  wrap.appendChild(head);
  wrap.appendChild(el('div', 'meta', proposal.id + '   created ' + clock(proposal.createdAt)));

  var simulation = proposal.simulation;
  if (simulation) {
    if (simulation.summary) {
      var summaryLines = String(simulation.summary).split('\n');
      for (var i = 0; i < summaryLines.length; i++) wrap.appendChild(el('div', 'sim', summaryLines[i]));
    }
    if (simulation.error) wrap.appendChild(el('div', 'sim red', simulation.error));
    if (simulation.policyDiff) {
      var diff = diffOf(simulation.policyDiff.before, simulation.policyDiff.after);
      for (var r = 0; r < diff.removed.length; r++) {
        wrap.appendChild(el('div', 'diff-before', '- ' + diff.removed[r]));
      }
      for (var a = 0; a < diff.added.length; a++) {
        wrap.appendChild(el('div', 'diff-after', '+ ' + diff.added[a]));
      }
      if (!diff.removed.length && !diff.added.length) {
        wrap.appendChild(el('div', 'diff-before', 'no visible rule change'));
      }
    }
  }

  var reasons = (proposal.verdict && proposal.verdict.reasons) || [];
  for (var n = 0; n < reasons.length; n++) wrap.appendChild(el('div', 'reason', 'why: ' + reasons[n]));

  var error = el('div', 'sim red');
  error.hidden = true;

  var approve = el('button', 'btn approve', '[ APPROVE ]');
  approve.type = 'button';
  var refuse = el('button', 'btn refuse', '[ REFUSE ]');
  refuse.type = 'button';
  approve.addEventListener('click', function () {
    decide('/api/approve', proposal.id, [approve, refuse], error);
  });
  refuse.addEventListener('click', function () {
    decide('/api/refuse', proposal.id, [approve, refuse], error);
  });

  var actions = el('div', 'actions');
  actions.appendChild(approve);
  actions.appendChild(refuse);
  wrap.appendChild(actions);
  wrap.appendChild(error);
  return wrap;
}

async function decide(route, id, buttons, errorNode) {
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  errorNode.hidden = true;
  try {
    await postJson(route, { id: id, token: TOKEN });
    await refreshState();
  } catch (err) {
    errorNode.textContent = err.message || String(err);
    errorNode.hidden = false;
    for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
  }
}

/* The gate can be switched off on testnet, and a machine that approves for you
   has to say so where you cannot miss it. Rendered only from what the server
   reports: the client never decides that the gate is off. */
function renderGateBanner(s) {
  var node = $('gate-banner');
  var banner = s.gate && s.gate.banner ? String(s.gate.banner) : '';
  node.textContent = banner;
  node.hidden = !banner;
  document.body.classList.toggle('gate-off', Boolean(banner));
}

function renderGate(s) {
  var box = $('gate');
  box.textContent = '';
  var pending = [];
  var proposals = s.proposals || [];
  for (var i = 0; i < proposals.length; i++) {
    if (proposals[i].status === 'pending') pending.push(proposals[i]);
  }
  if (!pending.length) {
    var empty = el('div', 'gate-empty', 'no pending approvals');
    // An empty gate means two different things depending on whether the gate is
    // on. Say which one this is.
    if (s.gate && s.gate.required === false) {
      empty.textContent = 'no pending approvals: ';
      empty.appendChild(el('span', 'off', 'the gate is disabled, every proposal auto-approves'));
    }
    box.appendChild(empty);
    return;
  }
  pending.sort(function (a, b) {
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
  for (var j = 0; j < pending.length; j++) box.appendChild(pendingBlock(pending[j]));
}

/* ---------- 7. log ---------- */

function logLine(event) {
  var line = el('div', REFUSAL_TYPES[event.type] ? 'logline refusal' : 'logline');
  line.appendChild(el('span', 'ts', '[' + clock(event.ts) + '] '));
  line.appendChild(el('span', 'type', padEnd(event.type, 25)));
  line.appendChild(el('span', 'msg', event.msg));
  return line;
}

function renderLog(events) {
  var box = $('log');
  box.textContent = '';
  for (var i = 0; i < events.length; i++) box.appendChild(logLine(events[i]));
}

function appendLog(event) {
  var box = $('log');
  box.insertBefore(logLine(event), box.firstChild);
  while (box.childElementCount > LOG_MAX_LINES) box.removeChild(box.lastChild);
}

/* ---------- refresh and events ---------- */

async function refreshState() {
  if (REFRESH_INFLIGHT) {
    REFRESH_QUEUED = true;
    return;
  }
  REFRESH_INFLIGHT = true;
  try {
    STATE = await getJson('/api/state');
    // Wallet first: the status bar reports its total.
    renderWallet(STATE);
    renderStatus(STATE);
    renderProducts(STATE);
    renderPolicy(STATE);
    renderGateBanner(STATE);
    renderGate(STATE);
    layoutFrames();
    alertLine(null);
  } catch (err) {
    alertLine('cannot reach the app: ' + (err.message || String(err)));
  } finally {
    REFRESH_INFLIGHT = false;
    if (REFRESH_QUEUED) {
      REFRESH_QUEUED = false;
      refreshState();
    }
  }
}

async function refreshLog() {
  try {
    renderLog(await getJson('/api/log?limit=200'));
  } catch (err) {
    alertLine('cannot read the log: ' + (err.message || String(err)));
  }
}

function openEvents() {
  var stream = new EventSource('/api/events');
  stream.addEventListener('open', function () {
    // A reconnect may have missed log lines, so replay the tail once reattached.
    if (SSE_SEEN_OPEN) {
      refreshState();
      refreshLog();
    }
    SSE_SEEN_OPEN = true;
  });
  stream.addEventListener('message', function (message) {
    var payload;
    try {
      payload = JSON.parse(message.data);
    } catch (err) {
      return;
    }
    if (payload.type === 'state') refreshState();
    else if (payload.type === 'log' && payload.event) appendLog(payload.event);
    else if (payload.type === 'candles') candlesPushed();
  });
}

/* ---------- wiring ---------- */

function wireKill() {
  $('kill-btn').addEventListener('click', async function () {
    var btn = $('kill-btn');
    var turnOn = btn.dataset.on !== '1';
    var question = turnOn
      ? 'Turn the kill switch ON? Every write will be refused until you turn it off.'
      : 'Turn the kill switch OFF? Writes will be allowed again, subject to policy.';
    if (!window.confirm(question)) return;
    btn.disabled = true;
    try {
      await postJson('/api/kill', { on: turnOn, token: TOKEN });
      await refreshState();
    } catch (err) {
      alertLine('kill switch failed: ' + (err.message || String(err)));
      btn.disabled = false;
    }
  });
}

function wireProduct() {
  $('product').addEventListener('change', function () {
    CANDLES = [];
    drawChart();
    refreshCandles();
  });
}

/* The only two things a human may do to this chart: pick a timeframe, and change
   how many candles are on screen. No indicators, no drawing tools, no crosshair. */
function wireTimeframes() {
  $('timeframes').addEventListener('click', function (ev) {
    var sec = ev.target && ev.target.dataset ? Number(ev.target.dataset.sec) : NaN;
    if (Number.isFinite(sec) && sec > 0) setTimeframe(sec);
  });
}

/* Chart controls, TradingView semantics:
     plot        drag left/right pans through history
     right axis  drag up/down compresses or expands the price scale
     bottom axis drag left/right compresses or expands the time scale
     wheel       zooms the time scale, same capability as the bottom axis
   Double click on either axis resets that axis. Nothing else: no indicators,
   no drawing tools, no crosshair. */
function wireChartControls() {
  var canvas = $('chart');
  var drag = null;

  function localPoint(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, w: rect.width, h: rect.height };
  }

  function cursorFor(region) {
    if (region === 'price') return 'ns-resize';
    if (region === 'time') return 'ew-resize';
    return 'grab';
  }

  canvas.addEventListener('mousedown', function (ev) {
    var p = localPoint(ev);
    var region = chartRegionAt(p.x, p.y, p.w, p.h);
    drag = {
      region: region,
      x: ev.clientX,
      y: ev.clientY,
      pan: PAN_OFFSET,
      count: VIEW_COUNT,
      zoom: PRICE_ZOOM,
      slot: Math.max(1, (p.w - PAD_RIGHT) / Math.max(1, VIEW_COUNT))
    };
    CHART_DRAGGING = true;
    canvas.style.cursor = region === 'plot' ? 'grabbing' : cursorFor(region);
    ev.preventDefault();
  });

  window.addEventListener('mousemove', function (ev) {
    if (!drag) {
      var q = localPoint(ev);
      if (q.x < 0 || q.y < 0 || q.x > q.w || q.y > q.h) return;
      canvas.style.cursor = cursorFor(chartRegionAt(q.x, q.y, q.w, q.h));
      return;
    }
    var dx = ev.clientX - drag.x;
    var dy = ev.clientY - drag.y;

    if (drag.region === 'plot') {
      // Pan by whole candles, using the slot width at grab time so the candle
      // under the cursor stays under the cursor. Drag right goes back in time.
      setPanOffset(drag.pan + dx / drag.slot);
      return;
    }
    if (drag.region === 'price') {
      // Drag down compresses the price scale, which is a bigger visible span.
      setPriceZoom(drag.zoom * (1 + dy / 220));
      return;
    }
    // Bottom axis: drag left squeezes more candles in, right spreads them out.
    setViewCount(drag.count * (1 - dx / 320));
  });

  window.addEventListener('mouseup', function () {
    if (!drag) return;
    canvas.style.cursor = cursorFor(drag.region);
    drag = null;
    CHART_DRAGGING = false;
    // Catch up on whatever the stream pushed while the hand was down.
    void refreshCandles();
  });

  canvas.addEventListener('dblclick', function (ev) {
    var p = localPoint(ev);
    var region = chartRegionAt(p.x, p.y, p.w, p.h);
    if (region === 'price') setPriceZoom(1);
    else if (region === 'time') setViewCount(120);
    else setPanOffset(0);
  });

  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    setViewCount(VIEW_COUNT * (ev.deltaY > 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });

  canvas.addEventListener('mouseleave', function () {
    if (!drag) canvas.style.cursor = '';
  });
}

/* The donut and the table are two views of one row set, so pointing at either
   lights both. Hover only: there is nothing to click through to. */
function wireWallet() {
  var canvas = $('donut');
  canvas.addEventListener('mousemove', function (ev) {
    var rect = canvas.getBoundingClientRect();
    setHover(donutIndexAt(ev.clientX - rect.left, ev.clientY - rect.top));
  });
  canvas.addEventListener('mouseleave', function () {
    setHover(-1);
  });

  var tbody = $('wallet-rows');
  tbody.addEventListener('mouseover', function (ev) {
    var tr = ev.target && ev.target.closest ? ev.target.closest('tr') : null;
    if (!tr || tr.dataset.index === undefined) return;
    setHover(Number(tr.dataset.index));
  });
  tbody.addEventListener('mouseleave', function () {
    setHover(-1);
  });
}

function wireResize() {
  var timer = null;
  window.addEventListener('resize', function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      layoutFrames();
      drawChart();
      drawDonut();
    }, 120);
  });
}

async function boot() {
  applyCollapse();
  renderTimeframes();
  wireKill();
  wireProduct();
  wireTimeframes();
  wireChartControls();
  wireCollapse();
  wireWallet();
  wireResize();
  try {
    TOKEN = (await getJson('/api/session')).token;
  } catch (err) {
    alertLine('no approval token: ' + (err.message || String(err)));
  }
  await refreshState();
  await refreshLog();
  openEvents();
  await refreshCandles();
  // The trade stream drives the chart now. This interval is only a floor, so a
  // dead socket or an idle book still refreshes the minute-and-above rail.
  setInterval(function () {
    if (Date.now() - CANDLE_LAST_FETCH > 15000) void refreshCandles();
  }, 5000);
}

boot();
