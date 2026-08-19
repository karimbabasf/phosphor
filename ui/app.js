/* PHOSPHOR one-page client. Plain browser JS, no imports, no framework.
   Every dynamic string reaches the DOM through textContent. Audit lines, policy
   sentences and proposal summaries carry agent-authored text verbatim by design,
   so innerHTML is never used anywhere in this file. */

'use strict';

/* A second agent turned away is a refusal like any other, and the log is where a refusal
   is supposed to be visible. */
var REFUSAL_TYPES = { policy_refused: 1, refused: 1, approve_attempt_rejected: 1, agent_rejected: 1 };
var EPS = 1e-9;
var LOG_MAX_LINES = 400;

/* The chart's own state, timeframes and colours live in ui/chart.js. It is loaded first and
   keeps its view on the server, so an agent can read and drive the same chart. */

/* Donut. Karim, 2026-08-13: "a little more diverse color scheme". It used to be one hue
   ramped by rank, which put eighteen positions on one green gradient and made the ring
   unreadable below the top three: two points of lightness apart is not a difference you
   can point at.

   Still not a rainbow chart. These are CRT phosphor colours (P1 green, P3 amber, the
   RGB triad), the biggest holding keeps the app's own green, and every one of them is
   saturated enough to hold on a near-black ground. The table carries the same colour as
   a chip per row, so the ring is decodable without a legend. */
var DONUT_COLOURS = [
  '#33ff66', /* phosphor green: the identity, and always the largest slice */
  '#22d3ee', /* cyan */
  '#ffb03a', /* amber */
  '#ff5f8f', /* rose */
  '#a78bfa', /* violet */
  '#a3e635', /* lime */
  '#2dd4a7', /* teal */
  '#ffe45c', /* yellow */
  '#ff8a3d', /* orange */
  '#7aa2ff'  /* blue */
];
/* Past the tenth position the list wraps and each lap is darker, so slice 11 is a dark
   green rather than a second bright one. Anything that deep into the ring is a sliver. */
var DONUT_LAP_DIM = 0.42;
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
  // Dust is still held, and printing 0.00000085 ETH as "0" in a column headed QTY is the
  // same lie the empty rows were. Four places is right for everything a person counts in;
  // below that the number becomes its own scale.
  if (v !== 0 && Math.abs(v) < 0.0001) {
    var fixed = v.toFixed(8);
    return Number(fixed) === 0 ? v.toPrecision(2) : fixed;
  }
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/* A gas fee is often a fraction of a cent, and "$0.00" in a column headed GAS reads as
   free. Same rule as price(): the precision follows the magnitude. */
function usdSmall(n) {
  var v = Number(n);
  if (!isFinite(v)) return 'n/a';
  if (v !== 0 && Math.abs(v) < 0.01) return '$' + v.toFixed(4);
  return usd(v);
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
  // Half-shade, not the light one: at a quarter of the ink the blocks fall under the dimmest
  // real text on the page and stop reading as a placeholder at all.
  var span = el('span', cls ? 'skel ' + cls : 'skel', repeat('▒', width));
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

  // One agent at a time by design (src/agents.ts), so this says WHICH one rather than how
  // many. The client name is agent-authored and arrives cleaned and capped by the server;
  // it reaches the DOM through textContent like every other dynamic string on this page.
  var agents = s.agents || {};
  var holder = agents.holder || null;
  var agentNode = $('stat-agent');
  agentNode.textContent = !agents.connected ? 'none' : holder ? holder.client : 'connected';
  agentNode.className = !agents.connected ? 'v faint' : 'v';
  agentNode.title = holder ? 'connected since ' + clock(holder.since) : 'no agent is connected';
  // Feed the presence light: whether an agent holds the seat, and when it last did real work.
  // Live 'activity' pings (below) keep it bright between state pushes; this seeds it on load.
  if (window.PhosphorPresence) PhosphorPresence.setState(agents.connected, agents.lastActivityAt);

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
    if (stale[row.chain]) stale[row.chain] = 'shown';
    var tr = document.createElement('tr');
    tr.dataset.index = String(i);
    // An LP row carries the pair as its symbol and reads as one ordinary line.
    // The chip is what makes the ring readable: same colour, same rank, same row.
    var token = el('td', 'token');
    var chip = el('span', 'chip');
    chip.style.background = sliceColour(i);
    chip.setAttribute('aria-hidden', 'true');
    token.appendChild(chip);
    token.appendChild(document.createTextNode(row.symbol));
    tr.appendChild(token);
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
  // A place whose read failed holds an unknown amount, not zero, and the table no longer
  // lists zeroes to hang a STALE badge on. It gets a line of its own instead: dropping
  // empty rows must never turn "we could not look" into "there is nothing there".
  for (var s = 0; s < WALLET.stale.length; s++) {
    if (stale[WALLET.stale[s]] === 'shown') continue;
    var unread = document.createElement('tr');
    var unreadCell = el('td', 'faint');
    unreadCell.colSpan = 6;
    unreadCell.appendChild(el('span', 'stale', 'STALE'));
    unreadCell.appendChild(document.createTextNode(' ' + WALLET.stale[s] + ' would not answer: holdings there are unknown, not zero'));
    unread.appendChild(unreadCell);
    tbody.appendChild(unread);
  }

  if (!WALLET.rows.length && !WALLET.stale.length) {
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

  // The list above is what is held. This is the only place that says how much was looked
  // at and found empty, which is the difference between a short list and a shallow read.
  var empty = Number(WALLET.emptyCount) || 0;
  if (empty > 0) {
    node.appendChild(el('span', 'faint', '   ' + empty + (empty === 1 ? ' token' : ' tokens') + ' empty, not listed'));
  }
}

/* ---------- 2b. the donut ---------- */

function hexParts(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/* Mix toward black (k < 0) or toward white (k > 0). One helper for both, because a
   palette needs to go darker for the second lap and brighter under the pointer. */
function shade(hex, k) {
  var p = hexParts(hex);
  var target = k > 0 ? 255 : 0;
  var amount = Math.abs(k);
  var out = 'rgb(';
  for (var i = 0; i < 3; i++) {
    out += Math.round(p[i] + (target - p[i]) * amount) + (i < 2 ? ',' : ')');
  }
  return out;
}

/* Colour by rank: position 1 is phosphor green, then down the palette. Wrapping laps
   darken, so a twelfth position never reads as brighter than the third. */
function sliceColour(rank) {
  var lap = Math.floor(rank / DONUT_COLOURS.length);
  var base = DONUT_COLOURS[rank % DONUT_COLOURS.length];
  return lap === 0 ? base : shade(base, -Math.min(0.8, lap * DONUT_LAP_DIM));
}

/* The Ethereum mark, drawn rather than fetched: this page loads no images and the one
   font it preloads has no such glyph. Official proportions (a 256x417 box), scaled to
   the height asked for, with the lower half at full ink and the upper half lighter so
   the facets read at 12px. */
function drawEthMark(ctx, x, y, height, colour) {
  var s = height / 417;
  var w = 256 * s;
  var left = x;
  var top = y - height / 2;
  function poly(points, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(left + points[0] * s, top + points[1] * s);
    for (var i = 2; i < points.length; i += 2) ctx.lineTo(left + points[i] * s, top + points[i + 1] * s);
    ctx.closePath();
    ctx.fill();
  }
  poly([127.9, 0, 0, 212.3, 127.9, 287.9, 255.9, 212.3], 0.62);
  poly([127.9, 312.2, 0, 236.6, 127.9, 416.9, 255.9, 236.6], 1);
  ctx.globalAlpha = 1;
  return w;
}

/* What one dollar of the total is worth in ETH. Read off the ledger's own price table,
   with a held ETH row as the fallback. Never guessed: no price, no line. */
function ethPrice() {
  var prices = STATE && STATE.ledger ? STATE.ledger.prices : null;
  if (prices && prices.ETH > 0) return prices.ETH;
  for (var i = 0; i < WALLET.rows.length; i++) {
    if (WALLET.rows[i].symbol === 'ETH' && WALLET.rows[i].priceUsd > 0) return WALLET.rows[i].priceUsd;
  }
  return 0;
}

function ethAmount(usdTotal) {
  var price = ethPrice();
  if (!(price > 0) || !(usdTotal > 0)) return null;
  var v = usdTotal / price;
  return v >= 1 ? v.toFixed(4) : v.toFixed(5);
}

/* The hole in the middle. Karim, 2026-08-13: not a rounded number. It is the total to
   the cent, and under it the same total in ETH beside the Ethereum mark, because the
   wallet is denominated in two things a person actually thinks in. */
function drawDonutCentre(ctx, cx, cy, total) {
  var eth = ethAmount(total);
  var dollars = usd(total);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8cffab';
  ctx.font = '600 15px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(dollars, cx, eth === null ? cy : cy - 8);
  if (eth === null) return;

  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  var text = ' ' + eth;
  var markHeight = 12;
  var markWidth = (256 / 417) * markHeight;
  var totalWidth = markWidth + ctx.measureText(text).width;
  var left = cx - totalWidth / 2;
  drawEthMark(ctx, left, cy + 10, markHeight, 'rgba(51, 255, 102, 0.82)');
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(51, 255, 102, 0.62)';
  ctx.fillText(text, left + markWidth, cy + 10);
  ctx.textAlign = 'center';
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
    // Lit means the slice's OWN colour lifted toward white, not one shared highlight:
    // with ten hues on the ring a single bright green would look like a different
    // holding rather than like this one being pointed at.
    ctx.fillStyle = lit ? shade(sliceColour(i), 0.45) : sliceColour(i);
    ctx.fill();
    angle += sweep;
  }

  drawDonutCentre(ctx, cx, cy, WALLET.totalUsd);
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

/* ---------- 2c. transactions ----------

   The history of what this app actually did with the money: one row per executed
   proposal, newest first. Everything in it is derived by the server from the proposal
   store and the hashes the rails produced (src/transactions.ts); this file formats and
   never computes, which is why a value here can be checked against the audit log line
   for the same id.

   Interactive means three things, and no more than three: the filters narrow the list,
   a row expands in place to its full detail, and every address and hash is a link to the
   explorer that owns it. No modal, no route: the brief allows neither. */

var TX = { entries: [], gasPending: 0 };
var TX_FILTER = 'all';
var TX_OPEN = {};
var TX_LOADED = false;

var TX_FILTERS = [
  { key: 'all', label: 'ALL' },
  { key: 'swap', label: 'SWAPS' },
  { key: 'deposit', label: 'DEPOSITS' },
  { key: 'withdraw', label: 'WITHDRAWALS' },
  { key: 'transfer', label: 'TRANSFERS' }
];

/* Addresses are shown short in the table and never short in the detail: a truncated
   address is fine to point at and not enough to check. */
function shortAddress(address) {
  var a = String(address);
  if (a.length <= 13) return a;
  return a.slice(0, 6) + '…' + a.slice(-4);
}

function txTime(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var today = new Date();
  var sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toTimeString().slice(0, 5) : (d.getMonth() + 1) + '/' + d.getDate();
}

/* What this move cost in gas, added up over its own transactions. Three outcomes, and
   they are three different sentences: a figure, still reading, or nobody can tell us.
   A move that only ever signed an intent burned no gas at all, which is a fourth. */
function gasOf(entry) {
  var totalUsd = 0;
  var seen = false;
  var pending = false;
  var unknown = false;
  for (var i = 0; i < entry.hashes.length; i++) {
    var tx = entry.hashes[i];
    if (tx.kind !== 'chain') continue;
    if (tx.gas === null) {
      if (tx.gasPending) pending = true;
      else unknown = true;
      continue;
    }
    seen = true;
    if (tx.gas.feeUsd !== null) totalUsd += tx.gas.feeUsd;
  }
  return { usd: seen ? totalUsd : null, pending: pending, unknown: unknown, onChain: seen || pending || unknown };
}

/* A link, or plain text when the chain has no explorer we can name. Never a dead <a>:
   a link that goes nowhere is worse than a value that does not pretend to be one. */
function explorerLink(text, url, cls) {
  if (!url) return el('span', cls, text);
  var a = el('a', cls ? 'link ' + cls : 'link', text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = url;
  return a;
}

function partyCell(party, cls) {
  var td = el('td', cls ? 'addr ' + cls : 'addr');
  if (!party) {
    td.appendChild(el('span', 'faint', '--'));
    return td;
  }
  var node = explorerLink(shortAddress(party.address), party.url, party.self ? 'self' : '');
  node.title = party.address + (party.self ? ' (our own wallet)' : '');
  td.appendChild(node);
  return td;
}

function movementOf(entry) {
  if (!entry.sent) return entry.note || '--';
  var sent = amount(entry.sent.amount) + ' ' + entry.sent.symbol;
  if (!entry.received) return sent;
  return sent + ' → ' + amount(entry.received.amount) + ' ' + entry.received.symbol;
}

function copyButton(text) {
  var btn = el('button', 'copy', '[copy]');
  btn.type = 'button';
  btn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = '[copied]';
      setTimeout(function () {
        btn.textContent = '[copy]';
      }, 1200);
    }, function () {
      btn.textContent = '[no]';
    });
  });
  return btn;
}

function detailLine(label, node) {
  var line = el('div', 'txd-line');
  line.appendChild(el('span', 'txd-k', padEnd(label, 14)));
  line.appendChild(node);
  return line;
}

/* The expansion. Everything the row had to leave out: full addresses, every hash with
   the gas it actually burned, the venue's own fee, and the verdict that let it through. */
function txDetail(entry) {
  var box = el('div', 'txd');

  if (entry.detail) box.appendChild(el('div', 'txd-detail', entry.detail));

  var parties = [entry.from, entry.to, entry.counterparty];
  var labels = ['from', 'to', 'via'];
  for (var p = 0; p < parties.length; p++) {
    if (!parties[p]) continue;
    var wrap = el('span', 'txd-addr');
    wrap.appendChild(explorerLink(parties[p].address, parties[p].url, parties[p].self ? 'self' : ''));
    if (parties[p].self) wrap.appendChild(el('span', 'faint', '  our own wallet'));
    wrap.appendChild(copyButton(parties[p].address));
    box.appendChild(detailLine(labels[p] + ' (' + parties[p].place + ')', wrap));
  }

  for (var h = 0; h < entry.hashes.length; h++) {
    var tx = entry.hashes[h];
    var line = el('span', 'txd-hash');
    line.appendChild(explorerLink(tx.hash, tx.url, ''));
    line.appendChild(copyButton(tx.hash));
    box.appendChild(detailLine(tx.kind === 'intent' ? 'intent' : 'tx ' + tx.place, line));
    if (tx.gas) {
      var g = el('span', 'txd-gas');
      g.appendChild(document.createTextNode(
        Number(tx.gas.gasUsed).toLocaleString('en-US') + ' gas × ' +
        (Number(tx.gas.gasPriceWei) / 1e9).toFixed(4) + ' gwei = ' +
        tx.gas.feeNative.toFixed(8) + ' ' + tx.gas.feeSymbol +
        (tx.gas.feeUsd === null ? '' : '  (' + usdSmall(tx.gas.feeUsd) + ')')
      ));
      if (tx.gas.status === 'reverted') g.appendChild(el('span', 'red', '  REVERTED'));
      box.appendChild(detailLine('gas', g));
    } else if (tx.kind === 'intent') {
      // Not a gap in the data: an intent is signed, not broadcast, so there is no gas of
      // ours to report and the fee that WAS paid is the solver's, below.
      box.appendChild(detailLine('gas', el('span', 'faint', 'none: signed as an intent, settled by a solver')));
    } else if (!tx.gasPending) {
      box.appendChild(detailLine('gas', el('span', 'faint', 'unknown: no chain this app can reach has this hash')));
    }
  }

  if (entry.venueFeeUsd !== null) {
    box.appendChild(detailLine('venue fee', el('span', null, usd(entry.venueFeeUsd) + '  (quoted at approval)')));
  }
  if (entry.decidedBy) {
    var decided = entry.decidedBy === 'human' ? 'a human clicked approve'
      : entry.decidedBy === 'policy' ? 'the policy engine, under the click threshold'
      : 'auto-approved: the approval gate was disabled';
    box.appendChild(detailLine('decided by', el('span', null, decided)));
  }
  for (var r = 0; r < entry.reasons.length; r++) {
    box.appendChild(detailLine(r === 0 ? 'why' : '', el('span', 'dim', entry.reasons[r])));
  }
  box.appendChild(detailLine('proposal', el('span', 'faint', entry.id)));
  return box;
}

function txRow(entry) {
  var tr = document.createElement('tr');
  tr.className = 'txrow' + (entry.status === 'failed' ? ' failed' : '');
  tr.dataset.id = entry.id;
  tr.tabIndex = 0;
  tr.setAttribute('role', 'button');
  tr.setAttribute('aria-expanded', TX_OPEN[entry.id] ? 'true' : 'false');

  tr.appendChild(el('td', 'time', txTime(entry.ts)));

  var action = el('td', 'action');
  action.appendChild(el('span', 'caret', TX_OPEN[entry.id] ? '▾ ' : '▸ '));
  action.appendChild(document.createTextNode(entry.action));
  if (entry.status === 'failed') action.appendChild(el('span', 'red', ' FAILED'));
  if (entry.status === 'executing') action.appendChild(el('span', 'hi', ' RUNNING'));
  tr.appendChild(action);

  var move = el('td', 'move');
  move.appendChild(document.createTextNode(movementOf(entry)));
  // The route, and only the route. The venue is a word per row that pushes gas and the
  // hash off the right edge, and it is one line down in the detail.
  var route = entry.place === entry.toPlace ? entry.place : entry.place + '→' + entry.toPlace;
  move.appendChild(el('span', 'faint', '  ' + route));
  move.title = movementOf(entry) + '  ' + route + (entry.venue ? ' via ' + entry.venue : '');
  tr.appendChild(move);

  tr.appendChild(el('td', 'num', usd(entry.valueUsd)));
  tr.appendChild(partyCell(entry.from, 'from'));
  tr.appendChild(partyCell(entry.to));

  var gas = gasOf(entry);
  var gasCell = el('td', 'num gas');
  if (gas.usd !== null) gasCell.appendChild(document.createTextNode(usdSmall(gas.usd)));
  else if (gas.pending) gasCell.appendChild(el('span', 'faint', 'reading'));
  else if (gas.unknown) gasCell.appendChild(el('span', 'faint', 'unknown'));
  else gasCell.appendChild(el('span', 'faint', 'no gas'));
  tr.appendChild(gasCell);

  var txCell = el('td', 'txh');
  if (!entry.hashes.length) txCell.appendChild(el('span', 'faint', '--'));
  else {
    txCell.appendChild(explorerLink(shortAddress(entry.hashes[0].hash), entry.hashes[0].url, ''));
    if (entry.hashes.length > 1) txCell.appendChild(el('span', 'faint', ' +' + (entry.hashes.length - 1)));
  }
  tr.appendChild(txCell);
  return tr;
}

function txMatches(entry) {
  if (TX_FILTER === 'all') return true;
  if (TX_FILTER === 'transfer') return entry.action === 'transfer' || entry.action === 'consolidate';
  return entry.action === TX_FILTER;
}

function renderTransactions() {
  var tbody = $('tx-rows');
  tbody.textContent = '';
  var shown = 0;
  for (var i = 0; i < TX.entries.length; i++) {
    var entry = TX.entries[i];
    if (!txMatches(entry)) continue;
    shown++;
    tbody.appendChild(txRow(entry));
    if (TX_OPEN[entry.id]) {
      var open = document.createElement('tr');
      open.className = 'txopen';
      var cell = document.createElement('td');
      cell.colSpan = 8;
      cell.appendChild(txDetail(entry));
      open.appendChild(cell);
      tbody.appendChild(open);
    }
  }

  if (!shown) {
    var empty = document.createElement('tr');
    var cell2 = el('td', 'faint', TX.entries.length
      ? 'nothing under this filter'
      : 'no transactions yet: nothing has been executed from this app');
    cell2.colSpan = 8;
    empty.appendChild(cell2);
    tbody.appendChild(empty);
  }

  var meta = $('tx-meta');
  meta.textContent = '';
  meta.appendChild(document.createTextNode(shown + (shown === 1 ? ' transaction' : ' transactions')));
  // Said out loud rather than left as a blank cell: a fee that has not been read yet and
  // a fee of zero are different facts.
  if (TX.gasPending > 0) meta.appendChild(el('span', 'faint', '   reading gas for ' + TX.gasPending + '...'));
  $('tab-meta').textContent = TX.entries.length ? TX.entries.length + ' recorded' : '';
}

function renderTxFilters() {
  var box = $('tx-filters');
  box.textContent = '';
  for (var i = 0; i < TX_FILTERS.length; i++) {
    (function (filter) {
      var btn = el('button', 'tf' + (TX_FILTER === filter.key ? ' on' : ''), filter.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        TX_FILTER = filter.key;
        renderTxFilters();
        renderTransactions();
      });
      box.appendChild(btn);
    })(TX_FILTERS[i]);
  }
}

async function refreshTransactions() {
  try {
    var payload = await getJson('/api/transactions');
    TX = { entries: payload.entries || [], gasPending: payload.gasPending || 0 };
    TX_LOADED = true;
    renderTransactions();
  } catch (err) {
    alertLine('cannot read the transaction history: ' + (err.message || String(err)));
  }
}

function wireTransactions() {
  renderTxFilters();

  var tbody = $('tx-rows');
  function toggle(tr) {
    if (!tr || !tr.dataset.id) return;
    var id = tr.dataset.id;
    if (TX_OPEN[id]) delete TX_OPEN[id];
    else TX_OPEN[id] = true;
    renderTransactions();
  }
  tbody.addEventListener('click', function (ev) {
    // A click on a link is a click on the link, not on the row behind it.
    if (ev.target.closest('a') || ev.target.closest('button')) return;
    toggle(ev.target.closest ? ev.target.closest('tr.txrow') : null);
  });
  tbody.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var tr = ev.target.closest ? ev.target.closest('tr.txrow') : null;
    if (!tr) return;
    ev.preventDefault();
    toggle(tr);
  });
}

/* The two views of the wallet. The holdings pane keeps its canvas, so switching back
   redraws it: a canvas that was display:none has no size to draw into. */
function showWalletPane(pane) {
  var holdings = pane !== 'activity';
  $('pane-holdings').hidden = !holdings;
  $('pane-activity').hidden = holdings;
  $('tab-holdings').classList.toggle('on', holdings);
  $('tab-activity').classList.toggle('on', !holdings);
  $('tab-holdings').setAttribute('aria-selected', holdings ? 'true' : 'false');
  $('tab-activity').setAttribute('aria-selected', holdings ? 'false' : 'true');
  // The totals line belongs to the holdings: "14 tokens empty, not listed" under a list of
  // transactions is a sentence about the wrong table.
  $('wallet-total').hidden = !holdings;
  if (holdings) drawDonut();
  else if (!TX_LOADED) refreshTransactions();
}

function wireTabs() {
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    (function (tab) {
      tab.addEventListener('click', function () {
        showWalletPane(tab.dataset.pane);
      });
    })(tabs[i]);
  }
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

/* headlineFor, diffOf, pendingBlock and decide now live in ui/approvals.js, which the
   trade window loads too. One renderer, so neither screen can show a thinner story than
   the other before the same click. */

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

/* How this page talks to the server, handed to the shared renderer. The token is read
   through a function rather than passed by value: it is null until boot finishes, and a
   captured null would outlive the fetch that fills it. */
function approvalDeps() {
  return {
    postJson: postJson,
    token: function () { return TOKEN; },
    onDecided: refreshState,
  };
}

function decide(route, id, buttons, errorNode) {
  return APPROVALS.decide(route, id, buttons, errorNode, approvalDeps());
}

function renderGate(s) {
  APPROVALS.render($('gate'), s, approvalDeps());
}

/* ---------- 6b. basic view ----------

   NOTE ON NAMES: applyView() and setViewCount() further up this file are the
   CHART's candle window and have nothing to do with view mode. Everything here
   is prefixed basic* or ViewMode for that reason.

   This section composes no sentence about money. Every string comes from
   src/view/basic.ts and is rendered verbatim, which is what lets the two modes be
   asserted to agree in tests rather than assumed to. */

/* The last view this page has seen, so a CHANGE can be told from a first sighting. Null
   until the first state frame lands. */
var lastSeenView = null;

/* What the DOM is actually showing, which is not the same question as what the server last
   said. A change is dressed by ui/transition.js and lands about a third of a second after it
   is announced, so during a fall these two disagree on purpose. Null until the first frame,
   which is how the first sighting is told from a switch: a page that has just opened shows
   its mode outright rather than raining onto it. */
var appliedMode = null;

/* Missing only if /transition.js failed to load. Switching modes then still has to work, so
   the fallback runs the change on the spot and the screen cuts, exactly as it used to. */
function rain() {
  return window.PHOSPHOR_RAIN || { swap: function (f) { f(); }, leave: function (f) { f(); } };
}

function setViewModeNow(mode) {
  $('page').dataset.view = mode;
  // Also on body, because basic.css replaces the ground and the family, and both
  // of those are set on body by style.css.
  document.body.dataset.view = mode;
  /* The panel frames are box-drawing characters measured against the live layout, and the
     two modes do not lay out the same. refreshState() calls layoutFrames() right after this
     function returns, which was enough while the change was synchronous; behind a fall it
     would measure the mode that is leaving. */
  layoutFrames();
  /* Basic's ring, marks and lines are canvases, and a canvas in the mode that is not on
     screen has no box: everything drawn into it while pro was up went nowhere. This is
     the first moment it has a size, so it is the moment to draw. */
  if (mode === 'basic') redrawBasicCanvases();
}

function applyViewMode(s) {
  // Server-driven only. The browser never decides which mode it is in, so a
  // stale or failed state read cannot silently simplify what a human sees.

  /* 'trade' is a different PAGE, not a different rendering of this one, so the only way to
     honour it is to go there. It fires on a transition and never on a first sighting: a
     human who opened this page by hand while the app happened to be in trade mode must not
     be thrown off the screen they deliberately asked for. An agent's switch is always a
     transition, so the one-word switch still lands. */
  if (s.view === 'trade' && lastSeenView !== null && lastSeenView !== 'trade') {
    lastSeenView = s.view;
    rain().leave(function () {
      window.location.href = '/trade';
    });
    return;
  }
  lastSeenView = s.view;

  var mode = s.view === 'basic' ? 'basic' : 'pro';
  if (mode === appliedMode) return;
  var first = appliedMode === null;
  appliedMode = mode;
  if (first) {
    setViewModeNow(mode);
    return;
  }
  rain().swap(function () {
    setViewModeNow(mode);
  });
}

/* The last basic view this page drew, kept because three of its parts are canvases.
   A canvas is wiped by a resize and there is no state on it to restore from, so the
   redraw needs the numbers again. Null until the first frame. */
var lastBasic = null;

/* Sizes a canvas to the box CSS gave it and hands back a context already scaled, so
   everything below draws in CSS pixels. Returns null when the canvas has no box yet,
   which happens on the mode that is not on screen: drawing into a zero-width canvas
   throws nothing and shows nothing, and getting it back on the switch is what the
   redraw in setViewModeNow is for. */
function basicCanvas(canvas) {
  if (!canvas) return null;
  var rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx: ctx, w: rect.width, h: rect.height };
}

/* The ring. It is the holdings list as a picture: same rows, same order, and the chip
   on each row is the key between them. Shares come from the server (BasicHolding.share)
   rather than from a sum done here, so the ring cannot disagree with the figures under
   it. Five slices and a rest, because a sixth slice on a 148px ring is a hairline. */
var BASIC_SLICES = 5;

// Named apart from sliceColour deliberately. Both are top-level declarations in one
// classic script, so the later one would win for every caller, and the donut above
// feeds its result to shade(), which parses hex and cannot read an oklch string.
function basicSliceColour(index) {
  var name = index < BASIC_SLICES ? '--slice-' + (index + 1) : '--slice-rest';
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function drawBasicDonut(holdings) {
  var fit = basicCanvas($('basic-donut'));
  if (fit === null) return;
  var ctx = fit.ctx;
  var cx = fit.w / 2;
  var cy = fit.h / 2;
  var outer = Math.min(cx, cy) - 2;
  var width = Math.max(14, outer * 0.30);
  var radius = outer - width / 2;

  // An empty or unreadable wallet still gets a ring, in the ground's own grey. A blank
  // square where a picture was reads as a failure to draw rather than as nothing owned.
  var rows = holdings || [];
  var total = 0;
  for (var i = 0; i < rows.length; i++) total += rows[i].share || 0;
  if (rows.length === 0 || !(total > 0)) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--rule').trim();
    ctx.lineWidth = width;
    ctx.stroke();
    return;
  }

  // From twelve o'clock, clockwise, biggest first: the same order as the rows, so the
  // eye can walk down the list and around the ring together.
  var from = -Math.PI / 2;
  for (var j = 0; j < rows.length; j++) {
    var share = rows[j].share || 0;
    if (share <= 0) continue;
    var to = from + share * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, from, to);
    ctx.strokeStyle = basicSliceColour(j);
    ctx.lineWidth = width;
    // Butt caps, deliberately: a round cap on a 1% slice draws a lozenge wider than the
    // share it stands for, which is a picture that overstates a number.
    ctx.lineCap = 'butt';
    ctx.stroke();
    from = to;
  }
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
    drawBasicDonut([]);
    return;
  }

  for (var i = 0; i < holdings.length; i++) {
    var h = holdings[i];
    var row = el('div', 'basic-row');
    var chip = el('span', 'basic-row-chip');
    chip.style.background = basicSliceColour(i);
    row.appendChild(chip);
    row.appendChild(el('span', 'basic-row-name', h.name));
    row.appendChild(el('span', 'basic-row-qty', h.quantityLine));
    row.appendChild(el('span', 'basic-row-value', h.valueLine));
    rows.appendChild(row);
  }
  drawBasicDonut(holdings);
}

/* ---------- the chain marks ----------

   The official outlines, as path data, on a 24 by 24 box. The first cut drew them by
   hand from a stem, some lobes and a few ticks; Karim, 2026-08-14: "they look a little
   bit wonky ... I want official pictures". A logo is a shape people already know, so an
   approximation of one is not a simplification, it is a wrong drawing.

   Inline SVG rather than the canvas the first cut used, and rather than a file: the
   no-images rule is about what this page LOADS, and markup loads nothing. Painting the
   shape as markup also makes it exact at any size, takes the row's ink through
   currentColor, and deletes the redraw-on-resize this needed as a canvas. */
var MARK_PATH = {
  btc:
    'M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z',
  sol:
    'm23.8764 18.0313-3.962 4.1393a.9201.9201 0 0 1-.306.2106.9407.9407 0 0 1-.367.0742H.4599a.4689.4689 0 0 1-.2522-.0733.4513.4513 0 0 1-.1696-.1962.4375.4375 0 0 1-.0314-.2545.4438.4438 0 0 1 .117-.2298l3.9649-4.1393a.92.92 0 0 1 .3052-.2102.9407.9407 0 0 1 .3658-.0746H23.54a.4692.4692 0 0 1 .2523.0734.4531.4531 0 0 1 .1697.196.438.438 0 0 1 .0313.2547.4442.4442 0 0 1-.1169.2297zm-3.962-8.3355a.9202.9202 0 0 0-.306-.2106.941.941 0 0 0-.367-.0742H.4599a.4687.4687 0 0 0-.2522.0734.4513.4513 0 0 0-.1696.1961.4376.4376 0 0 0-.0314.2546.444.444 0 0 0 .117.2297l3.9649 4.1394a.9204.9204 0 0 0 .3052.2102c.1154.049.24.0744.3658.0746H23.54a.469.469 0 0 0 .2523-.0734.453.453 0 0 0 .1697-.1961.4382.4382 0 0 0 .0313-.2546.4444.4444 0 0 0-.1169-.2297zM.46 6.7225h18.7815a.9411.9411 0 0 0 .367-.0742.9202.9202 0 0 0 .306-.2106l3.962-4.1394a.4442.4442 0 0 0 .117-.2297.4378.4378 0 0 0-.0314-.2546.453.453 0 0 0-.1697-.196.469.469 0 0 0-.2523-.0734H4.7596a.941.941 0 0 0-.3658.0745.9203.9203 0 0 0-.3052.2102L.1246 5.9687a.4438.4438 0 0 0-.1169.2295.4375.4375 0 0 0 .0312.2544.4512.4512 0 0 0 .1692.196.4689.4689 0 0 0 .2518.0739z',
  eth: 'M11.944 17.97L4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0L4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z',
};

var SVG_NS = 'http://www.w3.org/2000/svg';

/* Null for a coin nothing has been drawn for. A mark nobody drew is worse than no mark:
   the row still says which coin it is, in words. */
function chainMarkNode(kind) {
  var d = MARK_PATH[kind];
  if (!d) return null;
  var svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'basic-price-mark');
  svg.setAttribute('viewBox', '0 0 24 24');
  // The name is beside it in words, so the mark is decoration to a reader who cannot
  // see it, and announcing "Bitcoin" twice is worse than announcing it once.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  var path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

/* The line. One stroke over the same 24 hours the percentage beside it is measured
   over, so the two can never disagree. No axis, no grid, no fill: the figures are the
   facts and this is their shape. */
function drawSpark(canvas, points) {
  var fit = basicCanvas(canvas);
  if (fit === null || !points || points.length < 2) return;
  var ctx = fit.ctx;

  var low = points[0];
  var high = points[0];
  for (var i = 1; i < points.length; i++) {
    if (points[i] < low) low = points[i];
    if (points[i] > high) high = points[i];
  }

  var pad = 3;
  var span = high - low;
  var width = fit.w - pad * 2;
  var height = fit.h - pad * 2;
  ctx.beginPath();
  for (var j = 0; j < points.length; j++) {
    var x = pad + (width * j) / (points.length - 1);
    // A day that did not move is a straight line through the middle, not a line pinned
    // to the floor of the box: dividing by a zero span would put it there.
    var y = span > 0 ? pad + height - ((points[j] - low) / span) * height : pad + height / 2;
    if (j === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = getComputedStyle(canvas).color;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/* Three coins, or however many could be read. A coin the server could not price is
   absent from the list rather than present and blank: no price is a fact, and the last
   price that worked would be a stale figure with nothing beside it saying so. */
function renderBasicPrices(prices) {
  var section = $('basic-prices');
  var list = $('basic-price-rows');
  list.textContent = '';

  if (!prices || prices.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  for (var i = 0; i < prices.length; i++) {
    var p = prices[i];
    var row = el('div', 'basic-price');
    row.dataset.direction = p.direction;
    if (p.mark) row.dataset.mark = p.mark;

    // An empty cell rather than no cell when there is no mark: the grid has a column for
    // it, and a row that loses a column puts its name where the other rows' marks are.
    var mark = chainMarkNode(p.mark);
    row.appendChild(mark === null ? el('span', 'basic-price-mark') : mark);

    row.appendChild(el('span', 'basic-price-name', p.name));

    var spark = document.createElement('canvas');
    spark.className = 'basic-spark';
    // The line carries no fact the row does not already state in words, so it is not
    // announced twice: the price and the direction beside it are the readable version.
    spark.setAttribute('aria-hidden', 'true');
    row.appendChild(spark);

    var figures = el('span', 'basic-price-figures');
    figures.appendChild(el('span', 'basic-price-value', p.priceLine));
    figures.appendChild(el('span', 'basic-price-change', p.changeLine));
    row.appendChild(figures);

    list.appendChild(row);

    // After the row is in the document: the canvas takes its size from CSS, and a canvas
    // that is not laid out yet has no box to be sized against. The mark is markup and
    // needs no such thing.
    drawSpark(spark, p.points);
  }
}

function basicEventRow(line, timeLine, repeat) {
  var row = el('div', 'basic-event');
  row.appendChild(el('span', 'basic-event-line', line));
  // Always appended, empty when it happened once: the row is a three-column grid and a
  // row that grows a column when a number arrives puts the clock on its own line.
  row.appendChild(el('span', 'basic-event-repeat', repeat > 1 ? repeat + ' times' : ''));
  row.appendChild(el('span', 'basic-event-time', timeLine));
  return row;
}

/* Whether either list has more in it than its box shows. Read after the rows are in the
   document, because the answer is a measurement and there is nothing to measure before
   that. Called again on a resize: the boxes change height and the answer with them. */
function markHistoryOverflow() {
  var lists = [$('basic-events'), $('basic-actions')];
  for (var i = 0; i < lists.length; i++) {
    var list = lists[i];
    if (!list) continue;
    list.dataset.more = list.scrollHeight > list.clientHeight + 1 ? '1' : '';
  }
}

/* The two histories, one per column. Each hides on its own when it has nothing in it:
   they are in different columns, so an empty one leaves nothing behind and moves nothing
   across. Empty is a real state here, not a failure, and it is a common one on a screen
   whose whole point is that most days nothing happens. */
function renderBasicHistory(recent, actions) {
  var events = $('basic-events');
  var acts = $('basic-actions');
  events.textContent = '';
  acts.textContent = '';

  var moves = recent || [];
  var did = actions || [];
  $('basic-moves').hidden = moves.length === 0;
  $('basic-doings').hidden = did.length === 0;

  for (var i = 0; i < moves.length; i++) {
    var e = moves[i];
    var row = basicEventRow(e.headline, e.timeLine, 1);
    row.dataset.outcome = e.outcome;
    events.appendChild(row);
  }

  for (var j = 0; j < did.length; j++) {
    var a = did[j];
    acts.appendChild(basicEventRow(a.line, a.timeLine, a.repeat));
  }

  markHistoryOverflow();
}

/* Everything on this screen that is a canvas, redrawn from the last state. Called on a
   resize and on the switch INTO basic: a canvas in a hidden mode has no box, so what it
   drew while the other screen was up was nothing. */
function redrawBasicCanvases() {
  if (lastBasic === null) return;
  if (document.body.dataset.view !== 'basic') return;
  markHistoryOverflow();
  drawBasicDonut(lastBasic.totalUsd === null ? [] : lastBasic.holdings);
  var rows = $('basic-price-rows').children;
  var prices = lastBasic.prices || [];
  for (var i = 0; i < rows.length && i < prices.length; i++) {
    drawSpark(rows[i].querySelector('.basic-spark'), prices[i].points);
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

  lastBasic = b;
  renderBasicHoldings(b.holdings, b.totalUsd === null);
  renderBasicPrices(b.prices);
  renderBasicHistory(b.recent, b.actions);

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

  // Start the assistant without leaving the calm screen. Same /api/summon the pro window uses,
  // worded plainly because this screen never says "agent".
  var summon = $('basic-summon');
  if (summon) {
    summon.addEventListener('click', function () {
      runSummon(summon, 'Start the assistant in a new window? Any assistant connected now is stopped.');
    });
  }

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
    // The agent just made a tool call. Brighten the presence light now; it dulls itself when
    // the calls stop. Carries nothing, so there is nothing to refetch.
    else if (payload.type === 'activity') { if (window.PhosphorPresence) PhosphorPresence.note(); }
    else if (payload.type === 'log' && payload.event) appendLog(payload.event);
    // Only refetched once the panel has been opened: a gas receipt landing behind a tab
    // nobody is looking at is not worth a round trip.
    else if (payload.type === 'transactions') {
      if (TX_LOADED) refreshTransactions();
    }
    else if (payload.type === 'candles') candlesPushed();
    // A chart change from an agent. Our own writes come back with a revision we already
    // know, and chartPushed drops those rather than repainting over the hand.
    else if (payload.type === 'chart') chartPushed(payload.rev);
  });
}

/* ---------- wiring ---------- */

/* Start a fresh agent in a new terminal, and take the seat off whatever held it.

   The window could already STOP an agent in three ways and start one in none, so the first
   step of using this product was leaving it. The confirm is not ceremony: the agent that gets
   dropped may be mid-conversation, and losing that is not recoverable from here.

   The response is not awaited for effect on this page. The seat change arrives as a state
   push and the new agent announces itself on its first heartbeat, so the bar updates through
   the same path it always does rather than through a special case for this button. */
/* One summon path, called from the pro button and the basic START button. The seat change
   arrives as a state push and the new agent announces itself on its first heartbeat, so the
   bar updates through the same path it always does rather than a special case for the button. */
async function runSummon(btn, question) {
  if (SUMMON_PENDING) return;
  if (question && !window.confirm(question)) return;
  SUMMON_PENDING = true;
  btn.disabled = true;
  try {
    var answer = await postJson('/api/summon', { token: TOKEN });
    alertLine(answer && answer.dropped
      ? 'new agent starting; dropped ' + answer.dropped
      : 'new agent starting in a terminal window');
  } catch (err) {
    alertLine('summon failed: ' + (err.message || String(err)));
  } finally {
    SUMMON_PENDING = false;
    btn.disabled = false;
  }
}

function wireSummon() {
  var btn = document.getElementById('summon-btn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    runSummon(btn, 'Start a new agent in a terminal window? Any agent connected now is dropped and loses its conversation.');
  });
}
var SUMMON_PENDING = false;

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
      // Basic's canvases go with it. Whichever mode is up, the other one's canvases are
      // sized from a box it does not have yet, so each redraws for itself.
      redrawBasicCanvases();
    }, 120);
  });
}

async function boot() {
  applyCollapse();
  // Before the first fetch, not after: the point of it is the second the page is on screen
  // with nothing in it, and paint order is the whole feature.
  paintWaiting();
  wireKill();
  wireSummon();
  wireCollapse();
  wireWallet();
  wireTabs();
  wireTransactions();
  wireResize();
  wireBasic();
  // The chart owns its own fetch loop and its own timers (see ui/chart.js), so it boots
  // before the awaits below rather than after them. Booting it last left the largest panel
  // on the page as a black rectangle for as long as the wallet read took, which is the one
  // place a reader is most likely to read a wait as a failure.
  chartBoot();
  try {
    TOKEN = (await getJson('/api/session')).token;
  } catch (err) {
    alertLine('no approval token: ' + (err.message || String(err)));
  }
  await refreshState();
  await refreshLog();
  openEvents();
}

boot();
