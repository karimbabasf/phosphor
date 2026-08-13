/* PHOSPHOR one-page client. Plain browser JS, no imports, no framework.
   Every dynamic string reaches the DOM through textContent. Audit lines, policy
   sentences and proposal summaries carry agent-authored text verbatim by design,
   so innerHTML is never used anywhere in this file. */

'use strict';

var REFUSAL_TYPES = { policy_refused: 1, refused: 1, approve_attempt_rejected: 1 };
var EPS = 1e-9;
var LOG_MAX_LINES = 400;

/* The chart's own state, timeframes and colours live in ui/chart.js. It is loaded first and
   keeps its view on the server, so an agent can read and drive the same chart. */

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
var SSE_SEEN_OPEN = false;
var REFRESH_INFLIGHT = false;
var REFRESH_QUEUED = false;
/* Which panels have never had an answer yet. Not "is a request in flight": a panel that has
   real numbers in it and is refreshing them must not fall back to blocks. */
var WAITING = { state: true, log: true };
var DONUT_ANIM = 0;

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

/* ---------- 0. waiting ---------- */

/* Every panel on this page is empty until an answer comes back, and an empty panel and a
   broken one look the same. So the boot paints each one with the shape of what is coming:
   blocks where the numbers go, one row per row it expects. They are replaced by the first
   render, never merged with it, so nothing here can survive into a panel that has data.

   Blocks, not a sweeping gradient: this surface is a terminal and a skeleton that shimmers
   would be the only soft thing on the page. The wave comes from a per-line delay on a hard
   two-state blink instead, which is the same trick the cursor already uses. */
function skelCell(width, cls) {
  var span = el('span', cls ? 'skel ' + cls : 'skel', repeat('░', width));
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function skelLine(index, width, cls) {
  var line = el('div', cls || 'skelline');
  line.style.setProperty('--i', String(index));
  line.appendChild(skelCell(width));
  return line;
}

function paintWaiting() {
  document.body.classList.add('waiting');

  var widths = [5, 7, 8, 9, 8, 5];
  var tbody = $('wallet-rows');
  tbody.textContent = '';
  for (var r = 0; r < 5; r++) {
    var tr = document.createElement('tr');
    tr.style.setProperty('--i', String(r));
    for (var c = 0; c < widths.length; c++) {
      var td = el('td', c >= 2 ? 'num' : null);
      td.appendChild(skelCell(widths[c]));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  var totals = $('wallet-total');
  totals.textContent = '';
  totals.appendChild(skelCell(28));

  var readout = $('donut-readout');
  readout.textContent = '';
  readout.appendChild(skelLine(0, 9, 'line'));
  readout.appendChild(skelLine(1, 7, 'line'));

  var gate = $('gate');
  gate.textContent = '';
  gate.appendChild(skelLine(0, 34));
  gate.appendChild(skelLine(1, 21));

  var policy = $('policy-lines');
  policy.textContent = '';
  for (var p = 0; p < 4; p++) policy.appendChild(skelLine(p, 30 - p * 4, 'rule skelline'));

  var log = $('log');
  log.textContent = '';
  // Plain skelline, not logline: the log's hanging indent would pull a block row 36ch off
  // the left edge of the panel.
  for (var g = 0; g < 8; g++) log.appendChild(skelLine(g, 46 - ((g * 7) % 20)));

  drawDonutWaiting();
}

/* A panel stops waiting the moment its own answer lands, not when the last one does: the log
   and the state come back separately and a panel that has its numbers should not sit under
   blocks because a different fetch is slow. */
function settled(which) {
  if (!WAITING[which]) return;
  WAITING[which] = false;
  if (WAITING.state || WAITING.log) return;
  document.body.classList.remove('waiting');
}

/* The donut has no rows to lay blocks over, so it waits as a ring with an arc running round
   it. Same loop discipline as the chart: the tick stops itself as soon as the wait is over. */
function drawDonutWaiting() {
  if (DONUT_ANIM) window.cancelAnimationFrame(DONUT_ANIM);
  DONUT_ANIM = 0;
  if (!WAITING.state) return;

  var canvas = $('donut');
  var width = canvas.clientWidth;
  var height = canvas.clientHeight;
  if (!width || !height) return;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  var cx = width / 2;
  var cy = height / 2;
  var outer = Math.min(width, height) / 2 - 5;
  if (outer <= 6) return;
  var mid = outer * (1 + DONUT_INNER) / 2;
  var band = outer * (1 - DONUT_INNER);

  ctx.lineWidth = band;
  ctx.strokeStyle = 'rgba(51, 255, 102, 0.08)';
  ctx.beginPath();
  ctx.arc(cx, cy, mid, 0, Math.PI * 2);
  ctx.stroke();

  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var head = still ? -Math.PI / 2 : ((Date.now() % 1500) / 1500) * Math.PI * 2 - Math.PI / 2;
  ctx.strokeStyle = 'rgba(51, 255, 102, 0.30)';
  ctx.beginPath();
  ctx.arc(cx, cy, mid, head, head + Math.PI / 3);
  ctx.stroke();

  if (still) return;
  DONUT_ANIM = window.requestAnimationFrame(drawDonutWaiting);
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
  // Before the first wallet, the ring is the waiting animation's to own. This is the guard
  // that keeps a window resize from wiping it back to an empty square.
  if (WAITING.state) return drawDonutWaiting();
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

/* The chart is its own file, ui/chart.js, loaded before this one. It owns the two canvases,
   the pointer surface, and the talk to /api/chart. The only thing left here is the boot
   call, in boot() below, and candlesPushed() and chartPushed() reached from the event
   stream. Its view state lives on the server so an agent can read and drive it. */

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

/* ---------- 6b. basic view ----------

   NOTE ON NAMES: applyView() and setViewCount() further up this file are the
   CHART's candle window and have nothing to do with view mode. Everything here
   is prefixed basic* or ViewMode for that reason.

   This section composes no sentence about money. Every string comes from
   src/view/basic.ts and is rendered verbatim, which is what lets the two modes be
   asserted to agree in tests rather than assumed to. */

function applyViewMode(s) {
  // Server-driven only. The browser never decides which mode it is in, so a
  // stale or failed state read cannot silently simplify what a human sees.
  var mode = s.view === 'basic' ? 'basic' : 'pro';
  $('page').dataset.view = mode;
  // Also on body, because basic.css replaces the ground and the family, and both
  // of those are set on body by style.css.
  document.body.dataset.view = mode;
}

/* The holdings table. One row per thing owned; the server already merged the
   chains together. Empty is a real state here, not a failure: a wallet with
   nothing in it and a wallet nobody could read say different things, and the
   server decides which by handing back an empty list or a null total. */
function renderBasicHoldings(holdings, unknown) {
  var section = $('basic-holdings');
  var rows = $('basic-rows');
  rows.textContent = '';

  // Nothing to say while the total is unknown: a partial list of holdings looks
  // exactly like the full holdings of someone who owns less.
  if (unknown) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  if (!holdings || holdings.length === 0) {
    rows.appendChild(el('p', 'basic-empty', 'Nothing yet.'));
    return;
  }

  for (var i = 0; i < holdings.length; i++) {
    var h = holdings[i];
    var row = el('div', 'basic-row');
    row.appendChild(el('span', 'basic-row-name', h.name));
    row.appendChild(el('span', 'basic-row-qty', h.quantityLine));
    row.appendChild(el('span', 'basic-row-value', h.valueLine));
    rows.appendChild(row);
  }
}

function renderBasicPrice(price) {
  var section = $('basic-price');
  if (!price) {
    // No price rather than the last one that worked. A stale figure and a current
    // one look identical, and this reader has nothing to check it against.
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $('basic-price-name').textContent = price.name;
  $('basic-price-value').textContent = price.priceLine;
  var change = $('basic-price-change');
  change.textContent = price.changeLine;
  change.dataset.direction = price.direction;
}

function renderBasicRecent(recent) {
  var section = $('basic-recent');
  var list = $('basic-events');
  list.textContent = '';

  if (!recent || recent.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  for (var i = 0; i < recent.length; i++) {
    var e = recent[i];
    var row = el('div', 'basic-event');
    row.dataset.outcome = e.outcome;
    row.appendChild(el('span', 'basic-event-line', e.headline));
    row.appendChild(el('span', 'basic-event-time', e.timeLine));
    list.appendChild(row);
  }
}

function basicDestNode(dest) {
  var foreign = dest.chosenBy === 'quoter' || dest.label.indexOf('NOT your wallet') !== -1;
  var wrap = el('div', 'basic-dest' + (dest.chosenBy === 'quoter' ? ' quoter' : foreign ? ' foreign' : ''));
  wrap.appendChild(el('p', 'basic-dest-label', dest.label));
  // Full address, wrapped by CSS. Never shortened: a truncated address is a
  // hidden fact and this screen may not hide facts.
  wrap.appendChild(el('p', 'basic-dest-address', dest.address));
  return wrap;
}

function renderBasicAsk(ask) {
  var box = $('basic-ask');
  if (!ask) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('basic-ask-headline').textContent = ask.headline;
  $('basic-ask-after').textContent = ask.afterLine;

  var facts = $('basic-facts');
  facts.textContent = '';
  for (var i = 0; i < (ask.facts || []).length; i++) {
    var text = ask.facts[i];
    var warn = /not your own wallet|chosen by the swap service/.test(text);
    facts.appendChild(el('li', warn ? 'warn' : '', text));
  }

  var dests = $('basic-dests');
  dests.textContent = '';
  for (var d = 0; d < (ask.destinations || []).length; d++) {
    dests.appendChild(basicDestNode(ask.destinations[d]));
  }

  var yes = $('basic-yes');
  var no = $('basic-no');
  yes.disabled = false;
  no.disabled = false;
  yes.dataset.id = ask.proposalId;
  no.dataset.id = ask.proposalId;
  $('basic-error').hidden = true;
}

function renderBasic(s) {
  var b = s.basic;
  if (!b) return;
  $('basic').dataset.tone = b.tone;

  var total = $('basic-total');
  total.textContent = b.totalLine;
  // An unknown balance must not look like a figure. b.totalUsd is null exactly
  // when the server refused to state one.
  total.classList.toggle('unknown', b.totalUsd === null);

  // The calm bar. Same tone the section carries, on an element that spans the
  // window rather than the column.
  $('basic-state').dataset.tone = b.tone;

  // "spread across 4 places, all normal" is the app talking about itself while
  // nothing is wrong, which is the noise this screen was rebuilt to remove. The
  // line stays for the cases it was written for: a chain that would not answer,
  // and a balance not yet recounted after a move.
  var places = $('basic-places');
  var worthSaying = b.totalUsd === null;
  places.textContent = worthSaying ? b.placesLine : '';
  places.hidden = !worthSaying;

  $('basic-headline').textContent = b.headline;
  $('basic-agent').textContent = b.agentLine;
  $('basic-footer').textContent = b.footer;

  renderBasicHoldings(b.holdings, b.totalUsd === null);
  renderBasicPrice(b.price);
  renderBasicRecent(b.recent);

  var warning = $('basic-warning');
  warning.textContent = b.warning || '';
  warning.hidden = !b.warning;

  var frozen = Boolean(s.policy && s.policy.killSwitch);
  var kill = $('basic-kill');
  kill.dataset.on = frozen ? '1' : '0';
  kill.textContent = frozen ? 'LET THINGS MOVE AGAIN' : 'STOP EVERYTHING';

  renderBasicAsk(b.ask);
}

function wireBasic() {
  var yes = $('basic-yes');
  var no = $('basic-no');
  var error = $('basic-error');

  // The same decide() the pro gate calls. One approval code path in both modes,
  // so the two screens cannot drift on what a click actually does.
  yes.addEventListener('click', function () {
    if (yes.dataset.id) decide('/api/approve', yes.dataset.id, [yes, no], error);
  });
  no.addEventListener('click', function () {
    if (no.dataset.id) decide('/api/refuse', no.dataset.id, [yes, no], error);
  });

  // Two presses, and the confirm is a real control rather than window.confirm,
  // because a native dialog is the easiest thing on this screen to dismiss by reflex.
  var kill = $('basic-kill');
  var confirm = $('basic-stop-confirm');
  var killYes = $('basic-kill-yes');
  var killCancel = $('basic-kill-cancel');

  function closeConfirm() {
    confirm.hidden = true;
    kill.hidden = false;
  }

  kill.addEventListener('click', function () {
    var on = kill.dataset.on !== '1';
    $('basic-stop-question').textContent = on
      ? 'Are you sure? Nothing will be able to move until you turn this back on.'
      : 'Let things move again?';
    kill.hidden = true;
    confirm.hidden = false;
  });
  killCancel.addEventListener('click', closeConfirm);
  killYes.addEventListener('click', async function () {
    killYes.disabled = true;
    try {
      await postJson('/api/kill', { on: kill.dataset.on !== '1', token: TOKEN });
      await refreshState();
      closeConfirm();
    } catch (err) {
      error.textContent = err.message || String(err);
      error.hidden = false;
      closeConfirm();
    } finally {
      killYes.disabled = false;
    }
  });
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
    // Settled before the renders, not after: drawDonut asks whether the panel is still
    // waiting, and it must already have the answer by the time the wallet draws.
    settled('state');
    // Wallet first: the status bar reports its total.
    renderWallet(STATE);
    renderStatus(STATE);
    renderPolicy(STATE);
    renderGateBanner(STATE);
    renderGate(STATE);
    // Basic renders on every state read regardless of mode, so switching into it
    // never shows a frame of stale or empty copy.
    renderBasic(STATE);
    applyViewMode(STATE);
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
    var events = await getJson('/api/log?limit=200');
    settled('log');
    renderLog(events);
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
    // A chart change from an agent. Our own writes come back with a revision we already
    // know, and chartPushed drops those rather than repainting over the hand.
    else if (payload.type === 'chart') chartPushed(payload.rev);
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
      drawDonut();
    }, 120);
  });
}

async function boot() {
  applyCollapse();
  // Before the first fetch, not after: the point of it is the second the page is on screen
  // with nothing in it, and paint order is the whole feature.
  paintWaiting();
  wireKill();
  wireCollapse();
  wireWallet();
  wireResize();
  wireBasic();
  try {
    TOKEN = (await getJson('/api/session')).token;
  } catch (err) {
    alertLine('no approval token: ' + (err.message || String(err)));
  }
  await refreshState();
  await refreshLog();
  openEvents();
  // The chart owns its own fetch loop and its own timers; see ui/chart.js.
  chartBoot();
}

boot();
