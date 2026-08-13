/* PHOSPHOR trading page client. Plain browser JS, no imports, no framework.

   Sibling of ui/app.js, which serves the custody page and is NOT loaded here. The two files
   share their helper shapes on purpose: one page's habits should read as the other's.

   Every dynamic string reaches the DOM through textContent. The pinned note, the mandate
   English, the log lines and the venue's own errors are agent-authored or venue-authored text
   carried verbatim by design, so no line in this file ever assigns markup. Text nodes only,
   everywhere, without exception. This is a security property of the app, not a house style.

   NULL IS UNKNOWN AND PRINTS AS `--`. It is never printed as zero and never left blank. The
   venue reports accountValue 0.0 on a unified account that is holding real money, so a screen
   that prints that zero as a fact is a screen telling the human they have nothing while they
   carry a leveraged position. Every number on this page goes through one of the formatters
   below, and each of them answers `--` for anything that is not a finite number. */

'use strict';

var REFUSAL_TYPES = { policy_refused: 1, refused: 1, approve_attempt_rejected: 1 };
var LOG_MAX_LINES = 400;
var COLLAPSE_PREFIX = 'phosphor.collapse.';

/* The closed overlay set, in the order src/trade/view.ts declares it. trade.html authors the
   buttons; this list is the fallback when the container is empty and the order they draw in. */
var OVERLAY_NAMES = ['position', 'liquidation', 'stops', 'targets', 'orders', 'fills', 'mandateWall'];

/* Column counts for the two tables, needed only by the rows that span the full width. */
var BOOK_COLS = 9;
var FILL_COLS = 8;

/* Ten seconds of silence on an account subscription means the screen is behind the market.
   Hyperliquid pushes mark and account updates continuously, so a gap that size is a stall
   rather than a quiet moment, and the feed says DEGRADED whatever the socket believes. */
var STALE_AGE_MS = 10000;

/* How near the venue's wall is, as a bar. Percent alone is the number that lies: twelve
   percent is not far on something that moves eight percent in a day. The bar reads full at
   the wall and empty five ATR away, and falls back to a twenty percent scale with no ATR. */
var LIQ_ATR_FULL = 5;
var LIQ_PCT_FULL = 20;

/* Where a loss meter turns hot. Seventy percent of the approved loss is spent. */
var HOT_AT = 70;

var TOKEN = null;
var PAYLOAD = null;
var POLICY = null;
var COLLAPSE_MEM = {};
var PENDING = {};
var SSE_SEEN_OPEN = false;
var TRADE_INFLIGHT = false;
var TRADE_QUEUED = false;
var STATE_INFLIGHT = false;
var STATE_QUEUED = false;

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

/* trade.html is written beside this file by another hand. One id that has not landed yet must
   not throw and take the whole risk surface down with it, so every write goes through here. */
function setText(id, value) {
  var node = $(id);
  if (node) node.textContent = value;
  return node;
}

function setClass(node, name, on) {
  if (node) node.classList.toggle(name, Boolean(on));
}

function known(n) {
  return typeof n === 'number' && isFinite(n);
}

function usd(n) {
  if (!known(n)) return '--';
  var v = Number(n);
  return (v < 0 ? '-' : '') + '$' +
    Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function usdWhole(n) {
  if (!known(n)) return '--';
  var v = Number(n);
  return (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
}

/* PnL and net exposure are read for their direction before their size, so the sign is always
   printed, including the plus. */
function signedUsd(n) {
  if (!known(n)) return '--';
  return (Number(n) > 0 ? '+' : '') + usd(n);
}

/* One column holds a four figure mark and a sub-cent alt, so the precision follows the
   magnitude, the same way the wallet table does it. */
function price(n) {
  if (!known(n)) return '--';
  var v = Number(n);
  var digits = v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/* Two scales arrive in the payload and they are not the same number. roePct and
   liqDistancePct are already in percent, because src/trade/state.ts multiplies them by a
   hundred when it builds them. healthPct is a share of equity clamped to zero and one. One
   formatter each, named for what it takes, so neither is ever read on the other's scale. */
function pct(n) {
  if (!known(n)) return '--';
  return Number(n).toFixed(2) + '%';
}

function pctOfShare(share) {
  if (!known(share)) return '--';
  return (Number(share) * 100).toFixed(2) + '%';
}

/* Funding is a rate per hour, a fraction of the position each hour. Two decimal places of
   percent round every real funding rate to 0.00%, so it gets four. */
function funding(rate) {
  if (!known(rate)) return '--';
  return (Number(rate) * 100).toFixed(4) + '%';
}

function amount(n) {
  if (!known(n)) return '--';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function count(n) {
  if (!known(n)) return '--';
  return String(Math.round(Number(n)));
}

function clock(at) {
  var d = new Date(at);
  if (isNaN(d.getTime())) return '--';
  return d.toTimeString().slice(0, 8);
}

/* Ages and expiries. Seconds under a minute, then the two units that matter and no more,
   because "1h 04m" is read at a glance and "1h 4m 12s" is read twice. */
function duration(ms) {
  if (!known(ms)) return '--';
  var v = Math.max(0, Math.floor(Number(ms) / 1000));
  if (v < 60) return v + 's';
  var minutes = Math.floor(v / 60);
  if (minutes < 60) return minutes + 'm ' + (v % 60) + 's';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
  return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
}

function padEnd(s, n) {
  var out = String(s);
  while (out.length < n) out += ' ';
  return out;
}

function repeat(ch, n) {
  var out = '';
  for (var i = 0; i < n; i++) out += ch;
  return out;
}

/* One alert node, two voices. The client speaks when it cannot reach its own app; the venue's
   own words are printed as the venue's, because labelling a socket failure as a refusal is a
   lie about who said no. */
function alertText(text) {
  var node = $('t-alert');
  if (!node) return;
  if (!text) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = text;
  node.hidden = false;
}

function alertLine(text) {
  alertText(text ? 'client: ' + text : null);
}

function refusedLine(text) {
  alertText('The venue refused: ' + text);
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
    var failure = new Error((payload && payload.error) || (url + ' returned ' + res.status));
    // Whether the words came from the server decides whose voice reports them upstairs.
    failure.fromServer = Boolean(payload && payload.error);
    throw failure;
  }
  return payload;
}

/* ---------- box-drawing frames and collapse ---------- */

/* Carried over from ui/app.js rather than shared, because app.js is not loaded on this page
   and this file is the only script that knows the trading panels exist. */

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
    var name = frame.getAttribute('data-collapse');
    var shut = name ? isCollapsed(name) : false;
    var head = (shut ? '├' : '┌') + '─ ' + title + ' ';
    var tail = name ? ' [' + (shut ? '+' : '-') + '] ─' + (shut ? '┤' : '┐') : '┐';
    frame.textContent = head + repeat('─', Math.max(1, cols - head.length - tail.length)) + tail;
  }
}

/* The layout Karim leaves is the layout he returns to, so the state lives in localStorage.
   The in-memory copy keeps the control working when storage throws, which it does in a
   locked-down browser profile. */
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

/* ---------- shared readers over the payload ---------- */

function marketFor(p, coin) {
  var markets = (p && p.markets) || [];
  var want = String(coin || '').toUpperCase();
  for (var i = 0; i < markets.length; i++) {
    if (String(markets[i].coin).toUpperCase() === want) return markets[i];
  }
  return null;
}

/* The risk panel has one distance block and there may be several positions. The focused
   symbol wins, because that is what the human is looking at; with no position on it, the one
   nearest its wall wins, because that is the one that can end the day. */
function riskPosition(positions, symbol) {
  var want = String(symbol || '').toUpperCase();
  var nearest = null;
  for (var i = 0; i < positions.length; i++) {
    var pos = positions[i];
    if (String(pos.coin).toUpperCase() === want) return pos;
    if (!nearest) {
      nearest = pos;
      continue;
    }
    if (known(pos.liqDistanceAtr) && known(nearest.liqDistanceAtr)) {
      if (pos.liqDistanceAtr < nearest.liqDistanceAtr) nearest = pos;
    } else if (known(pos.liqDistancePct) && known(nearest.liqDistancePct)) {
      if (pos.liqDistancePct < nearest.liqDistancePct) nearest = pos;
    }
  }
  return nearest;
}

function feedState(venue) {
  if (!venue || venue.connected !== true) return 'offline';
  if (venue.degraded === true) return 'degraded';
  if (known(venue.ageMs) && venue.ageMs > STALE_AGE_MS) return 'degraded';
  return 'live';
}

function agentObjects(p) {
  var list = (p && p.highlights) || [];
  var n = 0;
  for (var i = 0; i < list.length; i++) if (list[i].source === 'agent') n++;
  if (p && p.noteSource === 'agent') n++;
  return n;
}

/* The agent points at a row and the row lights up: that is what makes the attention shared
   rather than merely described. The pointer's note rides the title attribute, which is text
   and never markup. */
function markHighlight(node, p, kind, id) {
  var list = (p && p.highlights) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].kind !== kind || String(list[i].id) !== String(id)) continue;
    node.classList.add('hi-row');
    if (list[i].note) node.title = String(list[i].note);
    return;
  }
}

/* A meter is only meaningful when both ends are known. An unknown cap under a known spend is
   not a full bar, it is no bar. */
function share(used, cap) {
  if (!known(used) || !known(cap) || Number(cap) <= 0) return null;
  return Math.max(0, Math.min(100, (Number(used) / Number(cap)) * 100));
}

/* One meter, filled by percentage on its inner span. The span is made once and reused, so a
   redraw moves a width instead of rebuilding the DOM under the pointer. */
/* A meter with an unknown value is NOT a meter reading zero.

   An empty track beside "health --" is read as health at zero, which on a risk panel is the
   single worst thing this page could imply: it says you are at your liquidation when the truth
   is that nobody has told us yet. It happens on every unified account, where health is not
   computable from what the venue publishes, so it is the common case rather than an edge one.

   The track carries a class instead, and trade.css draws it as unreadable rather than as empty.
   Same rule as every number on this page: unknown has its own appearance and never borrows
   zero's. */
function fillBar(node, percent) {
  if (!node) return;
  var span = node.firstElementChild;
  if (!span) {
    span = el('span');
    node.appendChild(span);
  }
  var unknown = !known(percent);
  node.classList.toggle('unknown', unknown);
  span.style.width = unknown ? '0%' : Math.max(0, Math.min(100, Number(percent))).toFixed(1) + '%';
}

/* The empty line may be authored inside the tbody as a row or beside the table; the DOM
   contract does not say which. It is detached before the wipe and put back after, so both
   markups keep working. */
function resetRows(rowsId, emptyId) {
  var rows = $(rowsId);
  if (!rows) return null;
  var empty = $(emptyId);
  var keep = null;
  if (empty && rows.contains(empty)) {
    keep = (empty.closest ? empty.closest('tr') : null) || empty;
    if (keep.parentNode) keep.parentNode.removeChild(keep);
  }
  rows.textContent = '';
  if (keep) rows.appendChild(keep);
  return rows;
}

function spanRow(cols, text, cls) {
  var tr = el('tr', cls);
  var td = el('td', 'faint', text);
  td.colSpan = cols;
  tr.appendChild(td);
  return tr;
}

/* ---------- 1. status bar ---------- */

function feedText(venue, state) {
  var word = state === 'live' ? 'LIVE' : state === 'degraded' ? 'DEGRADED' : 'OFFLINE';
  var out = word;
  if (venue && venue.source && venue.source !== 'none') out += ' ' + venue.source;
  if (venue && known(venue.ageMs)) out += ' ' + duration(venue.ageMs);
  if (state !== 'live' && venue && known(venue.latencyMs)) out += ' ' + duration(venue.latencyMs) + ' per call';
  return out;
}

function renderStatus(p) {
  var d = p || {};
  var venue = d.venue || {};
  var account = d.account || {};
  var market = marketFor(d, d.symbol);
  var state = feedState(d.venue);
  // A stale price rendered as a live one is the failure this whole indicator exists to stop,
  // so the marking rides the price nodes themselves and not only the banner.
  var stale = Boolean(p) && state !== 'live';

  setText('t-symbol', d.symbol ? String(d.symbol) : '--');
  setClass(setText('t-mark', price(market ? market.markPx : null)), 'stale', stale);
  setText('t-funding', funding(market ? market.fundingRateHourly : null));
  setClass(setText('t-equity', usd(account.equityUsd)), 'stale', stale);
  setClass(setText('t-free', usd(account.freeUsd)), 'stale', stale);
  setClass($('t-book-rows'), 'stale', stale);
  setClass($('t-fill-rows'), 'stale', stale);

  var feed = setText('t-feed', p ? feedText(venue, state) : '--');
  setClass(feed, 'hi', state === 'degraded');
  setClass(feed, 'red', state === 'offline');

  // Agent objects, not connected agents: what matters here is how much of this screen the
  // agent drew, because that is what trade_clear takes away in one call.
  var objects = agentObjects(p);
  var agent = setText('t-agent', objects === 0 ? 'none' : objects + (objects === 1 ? ' object' : ' objects'));
  setClass(agent, 'faint', objects === 0);
}

/* The kill switch and the policy banner are the pro page's facts, not the trading payload's:
   TradePayload carries no policy, so this page reads /api/state for those two and nothing
   else. */
function renderKill(s) {
  var banner = $('t-banner-policy');
  var readable = Boolean(s && s.policy);
  if (banner) {
    if (!banner.textContent) banner.textContent = 'POLICY FILE UNREADABLE: ALL WRITES REFUSED';
    banner.hidden = !s || readable;
  }
  var btn = $('kill-btn');
  if (!btn) return;
  btn.disabled = PENDING.kill === true;
  if (!s) {
    // Nothing has answered yet. The label stays as trade.html authored it, and the first
    // click turns the switch ON, which is the safe direction to guess in.
    btn.dataset.on = '0';
    return;
  }
  var kill = readable ? s.policy.killSwitch === true : false;
  btn.textContent = '[ KILL SWITCH: ' + (kill ? 'ON' : 'OFF') + ' ]';
  btn.classList.toggle('on', kill);
  btn.dataset.on = kill ? '1' : '0';
}

function killOn() {
  return Boolean(POLICY && POLICY.policy && POLICY.policy.killSwitch === true);
}

/* ---------- 2. venue banner ---------- */

function slowSeconds(venue) {
  var ms = known(venue.latencyMs) ? venue.latencyMs : venue.ageMs;
  if (!known(ms)) return '--';
  return String(Math.max(1, Math.round(Number(ms) / 1000)));
}

function renderVenueBanner(p) {
  var node = $('t-banner-venue');
  if (!node) return;
  node.textContent = '';
  if (!p) {
    // Cold start. The shell says what it is waiting for rather than implying the venue is fine.
    node.appendChild(el('span', 'line', 'Waiting for the venue.'));
    node.hidden = false;
    return;
  }
  var venue = p.venue || {};
  var state = feedState(venue);
  if (state === 'live') {
    node.hidden = true;
    return;
  }
  if (state === 'offline') {
    node.appendChild(el('span', 'line', 'No route to the venue. Showing the last numbers with their age.'));
  } else {
    node.appendChild(el('span', 'line',
      'The venue is slow: ' + slowSeconds(venue) + 's per call. This screen is behind the market.'));
  }
  // The venue's own sentence, verbatim and as text.
  if (venue.error) node.appendChild(el('span', 'line err', String(venue.error)));
  var retry = el('button', 'btn', '[ RETRY ]');
  retry.type = 'button';
  retry.dataset.act = 'retry';
  retry.disabled = PENDING.retry === true;
  node.appendChild(retry);
  node.hidden = false;
}

/* ---------- 3. risk ---------- */

/* The DOM contract names the five distance nodes and no wrapper around them, and the copy
   puts static words beside each one ("LIQ at <price>, <n>% away"). Hiding the span alone
   would leave those words with nothing after them, so the line holding the span is hidden
   instead. Guarded: a line that also carries the collateral figures or the empty sentence is
   left alone, because the risk panel keeps showing free collateral when it is flat. */
function holdsKeeper(node) {
  if (!node.querySelector) return true;
  return Boolean(node.querySelector(
    '#t-risk-equity, #t-risk-margin, #t-risk-free, #t-risk-maint, #t-risk-empty,' +
    '#t-exp-net, #t-exp-gross, #t-exp-shock'
  ));
}

function hideLiqLine(id, shut) {
  var node = $(id);
  if (!node) return;
  var target = node.parentElement;
  if (!target || target === document.body || holdsKeeper(target)) target = node;
  target.hidden = shut;
}

function liqFill(pos) {
  if (known(pos.liqDistanceAtr)) return (1 - Number(pos.liqDistanceAtr) / LIQ_ATR_FULL) * 100;
  if (known(pos.liqDistancePct)) return (1 - Number(pos.liqDistancePct) / LIQ_PCT_FULL) * 100;
  return null;
}

function renderLiqBlock(pos) {
  var ids = ['t-liq-price', 't-liq-pct', 't-liq-usd', 't-liq-atr', 't-liq-bar'];
  for (var i = 0; i < ids.length; i++) hideLiqLine(ids[i], !pos);
  if (!pos) {
    setText('t-liq-price', '--');
    setText('t-liq-pct', '--');
    setText('t-liq-usd', '--');
    setText('t-liq-atr', '--');
    fillBar($('t-liq-bar'), null);
    return;
  }
  setText('t-liq-price', price(pos.liqPx));
  setText('t-liq-pct', pct(pos.liqDistancePct));
  setText('t-liq-usd', usd(pos.liqDistanceUsd));
  setText('t-liq-atr', known(pos.liqDistanceAtr) ? Number(pos.liqDistanceAtr).toFixed(1) : '--');
  fillBar($('t-liq-bar'), liqFill(pos));
}

/* The instrument, as opposed to the account.

   Mark and oracle get separate lines because they are separate prices doing separate jobs:
   mark decides a liquidation and the profit on screen, oracle decides funding. They normally
   sit within a few basis points of each other, and the moment they do not is the moment a
   position can be liquidated at a price no exchange is trading at. That gap has no name on
   most screens; here it is a line called basis.

   The ATR pair is the same idea one level up. An absolute ATR means nothing without the price
   beside it, so the percent is printed next to it: that single figure is what turns "twelve
   percent from liquidation" into either a comfortable distance or a bad afternoon. */
function renderMarket(p) {
  var d = p || {};
  var symbol = String(d.symbol || '').toUpperCase();
  var list = d.markets || [];
  var m = null;
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].coin || '').toUpperCase() === symbol) { m = list[i]; break; }
  }

  var empty = $('t-market-empty');
  if (empty) empty.hidden = m !== null;
  if (!m) {
    ['t-mkt-mark', 't-mkt-oracle', 't-mkt-spread', 't-mkt-premium', 't-mkt-funding',
      't-mkt-funding8', 't-mkt-oi', 't-mkt-vol', 't-mkt-atr', 't-mkt-atrpct'].forEach(function (id) {
      setText(id, '--');
    });
    return;
  }

  setText('t-mkt-mark', price(m.markPx));
  setText('t-mkt-oracle', price(m.oraclePx));
  // In basis points, because the number is small enough that percent renders it as 0.00 and a
  // reader would conclude the two prices agree exactly.
  var basis = known(m.oraclePx) && known(m.markPx) && Number(m.oraclePx) !== 0
    ? ((Number(m.markPx) - Number(m.oraclePx)) / Number(m.oraclePx)) * 10000
    : null;
  setText('t-mkt-spread', known(basis) ? (basis > 0 ? '+' : '') + basis.toFixed(1) + ' bps' : '--');
  setText('t-mkt-premium', pct(m.premiumPct));
  setText('t-mkt-funding', funding(m.fundingRateHourly));
  // The venue publishes an hourly rate; every exchange quotes an eight hour one. Both are
  // printed rather than one converted silently, because an unlabelled funding number read on
  // the wrong period is off by a factor of eight.
  setText('t-mkt-funding8', known(m.fundingRateHourly) ? funding(Number(m.fundingRateHourly) * 8) : '--');
  setText('t-mkt-oi', usdWhole(m.openInterestUsd));
  setText('t-mkt-vol', usdWhole(m.volume24hUsd));
  setText('t-mkt-atr', price(m.atr));
  setText('t-mkt-atrpct', known(m.atr) && known(m.markPx) && Number(m.markPx) !== 0
    ? pct((Number(m.atr) / Number(m.markPx)) * 100)
    : '--');
}

function renderRisk(p) {
  var d = p || {};
  var account = d.account || {};
  setText('t-risk-equity', usd(account.equityUsd));
  setText('t-risk-margin', usd(account.marginUsedUsd));
  setText('t-risk-free', usd(account.freeUsd));
  setText('t-risk-maint', usd(account.maintenanceUsd));
  setText('t-risk-health', pctOfShare(account.healthPct));
  fillBar($('t-risk-healthbar'), known(account.healthPct) ? Number(account.healthPct) * 100 : null);

  setText('t-exp-net', signedUsd(account.netNotionalUsd));
  setText('t-exp-gross', usd(account.grossNotionalUsd));
  // A sentence, not a figure: a bare number here reads as a balance rather than as what is
  // left after a move that has not happened yet. The line is never hidden, because the
  // absence of this number is itself news on a unified account.
  setText('t-exp-shock', 'A 5% move against you leaves ' + usd(account.equityAtFivePctAdverse) + '.');

  var positions = Array.isArray(d.positions) ? d.positions : null;
  // accountKnown is false until the feed has settled what kind of account this is, and every
  // figure above is null while it is. Flat and not-yet-known are different facts, so an
  // unsettled account never gets the sentence that says there is nothing at risk.
  var settled = account.accountKnown !== false;
  var empty = $('t-risk-empty');
  if (!positions || (!positions.length && !settled)) {
    setText('t-risk-empty', 'No account data yet.');
    if (empty) empty.hidden = false;
    renderLiqBlock(null);
    return;
  }
  if (!positions.length) {
    setText('t-risk-empty', 'Nothing at risk. No open position.');
    if (empty) empty.hidden = false;
    renderLiqBlock(null);
    return;
  }
  if (empty) empty.hidden = true;
  renderLiqBlock(riskPosition(positions, d.symbol));
}

/* ---------- 4. mandates ---------- */

function meter(bound, text, percent, hot) {
  var bar = el('div', 'mbar');
  bar.dataset.bound = bound;
  bar.appendChild(el('div', 'mbar-text', text));
  var track = el('div', 'mbar-track');
  fillBar(track, percent);
  bar.appendChild(track);
  if (hot) bar.classList.add('hot');
  return bar;
}

/* How much of the mandate's life is spent, drawn from the two timestamps rather than from a
   countdown, so a paused clock cannot make an expiring mandate look young. */
function lifeShare(m) {
  var start = Date.parse(m.since);
  var end = Date.parse(m.expiresAt);
  if (!isFinite(start) || !isFinite(end) || end <= start) return null;
  var left = m.used && known(m.used.msToExpiry) ? Number(m.used.msToExpiry) : end - Date.now();
  return Math.max(0, Math.min(100, (1 - left / (end - start)) * 100));
}

/* The arm receipt refuses a zero as well as a null. It answers "if this program opens the
   biggest position its envelope allows, what becomes true", and it sits on the screen the
   human approves from, so a wrong figure here is worse than a missing one. The venue writes
   0.0 where it means "I do not know", and $0 of margin required is exactly the wrong number
   to be confident about. */
function projUsd(n) {
  return known(n) && Number(n) !== 0 ? usd(n) : '--';
}

function projPrice(n) {
  return known(n) && Number(n) > 0 ? price(n) : '--';
}

function receiptLine(cls, label, value) {
  var line = el('div', cls);
  line.appendChild(el('span', 'k', label + ' '));
  line.appendChild(el('span', 'v', value));
  return line;
}

function projectedBlock(m) {
  var box = el('div', 'mrow-projected');
  var proj = m.projected;
  if (!proj) {
    box.appendChild(el('div', 'proj-none', 'Projection unavailable: the venue has not reported collateral.'));
    return box;
  }
  box.appendChild(receiptLine('proj-size', 'opens at most', projUsd(proj.maxPositionUsd)));
  box.appendChild(receiptLine('proj-liq', 'liquidation at', projPrice(proj.liqPxAtMax)));
  box.appendChild(receiptLine('proj-free', 'free after', projUsd(proj.freeAfterUsd)));
  box.appendChild(receiptLine('proj-margin', 'margin required', projUsd(proj.marginRequiredUsd)));
  return box;
}

function mandateRow(m, p) {
  var wrap = el('div', 'mrow');
  wrap.dataset.id = String(m.id);
  markHighlight(wrap, p, 'mandate', m.id);

  var head = el('div', 'mrow-head');
  head.appendChild(el('span', 'sym', String(m.symbol)));
  // Armed and not running is the runner having died under a live mandate. It is said in
  // words, in the row, and DISARM stays enabled underneath it.
  head.appendChild(el('span', m.running ? 'state' : 'state red', m.running ? 'ARMED' : 'NOT RUNNING'));
  head.appendChild(el('span', 'meta', 'Expires in ' + duration(m.used ? m.used.msToExpiry : null)));
  // Flat with a mandate armed there is no wall yet, so the price is unknown and prints as --
  // rather than as a line drawn at a number that means nothing.
  head.appendChild(el('span', 'meta', 'MANDATE STOP-OUT at ' + price(m.wallPx) + ', the loss you approved'));
  if (m.haltedReason) head.appendChild(el('span', 'meta red', String(m.haltedReason)));
  if (m.lastRule) {
    head.appendChild(el('span', 'meta',
      clock(m.lastRule.at) + ' ' + String(m.lastRule.action) + ' ' + String(m.lastRule.id)));
  }
  wrap.appendChild(head);

  // Agent-authored sentences, one line each, carried verbatim as text.
  var english = el('div', 'mrow-english');
  var lines = m.english || [];
  for (var i = 0; i < lines.length; i++) english.appendChild(el('div', 'eline', String(lines[i])));
  wrap.appendChild(english);

  var bars = el('div', 'mrow-bars');
  var env = m.envelope || {};
  var used = m.used;
  // Armed before the runner has reported: the row shows, the bars wait. A bar at zero would
  // claim nothing has been spent, which is not what "not yet reported" means.
  if (used) {
    bars.appendChild(meter(
      'notional',
      'Used ' + usd(used.notionalUsd) + ' of ' + usd(env.maxNotionalUsd) + ' notional',
      share(used.notionalUsd, env.maxNotionalUsd),
      false
    ));
    var lost = share(used.lossUsd, env.maxLossUsd);
    bars.appendChild(meter(
      'loss',
      'Lost ' + usd(used.lossUsd) + ' of ' + usd(env.maxLossUsd) + ' allowed',
      lost,
      known(lost) && lost > HOT_AT
    ));
    bars.appendChild(meter(
      'orders',
      count(used.ordersLastMin) + ' of ' + count(env.maxOrdersPerMin) + ' orders this minute',
      share(used.ordersLastMin, env.maxOrdersPerMin),
      false
    ));
    bars.appendChild(meter('time', 'Expires in ' + duration(used.msToExpiry), lifeShare(m), false));
  }
  wrap.appendChild(bars);
  wrap.appendChild(projectedBlock(m));

  var actions = el('div', 'mrow-actions');
  actions.appendChild(actionButton('[ DISARM ]', 'disarm', { id: String(m.id) }));
  wrap.appendChild(actions);
  return wrap;
}

function renderMandates(p) {
  var list = $('t-mandate-list');
  if (!list) return;
  var all = (p && Array.isArray(p.mandates)) ? p.mandates : [];
  var armed = [];
  for (var i = 0; i < all.length; i++) if (all[i].armed) armed.push(all[i]);

  list.textContent = '';
  var empty = $('t-mandate-empty');
  if (!armed.length) {
    if (empty) {
      // When the kill switch is why nothing is armed, that is the more useful sentence.
      empty.textContent = killOn()
        ? 'Nothing armed: the kill switch is on.'
        : 'Nothing armed. Ask your agent for a proposal.';
      empty.hidden = false;
    }
    return;
  }
  if (empty) empty.hidden = true;
  for (var j = 0; j < armed.length; j++) list.appendChild(mandateRow(armed[j], p));
}

/* ---------- 5. book ---------- */

/* Retail shows one PnL number. A position's result is price plus funding minus fees, and a
   carry trade that is green on price can be red once it has paid for itself, so the net is
   the headline and the two parts sit under it. Funding is never the hidden one. */
function pnlCell(pos) {
  var td = el('td', 'num pnl');
  var split = known(pos.pnlNetUsd) || known(pos.pnlPriceUsd) || known(pos.pnlFundingUsd);
  // With no split reported, the venue's own unrealised number is the honest headline. The
  // two are never mixed: a price-only figure labelled net would be the wrong number.
  var net = split ? pos.pnlNetUsd : pos.unrealisedUsd;
  var head = el('div', 'pnl-net', signedUsd(net) + '  ' + pct(pos.roePct));
  setClass(head, 'up', known(net) && Number(net) >= 0);
  setClass(head, 'down', known(net) && Number(net) < 0);
  td.appendChild(head);
  td.appendChild(el('div', 'pnl-parts',
    'price ' + signedUsd(pos.pnlPriceUsd) + '  funding ' + signedUsd(pos.pnlFundingUsd)));
  return td;
}

function positionRow(pos, p) {
  var tr = el('tr', 'prow');
  tr.dataset.coin = String(pos.coin);
  markHighlight(tr, p, 'position', pos.coin);
  tr.appendChild(el('td', 'sym', String(pos.coin)));

  var short = pos.side === 'short';
  var side = el('td', short ? 'side short' : 'side long');
  side.appendChild(document.createTextNode(short ? 'SHORT' : 'LONG'));
  side.appendChild(document.createTextNode(' ' + (known(pos.leverage) ? pos.leverage + 'x' : '--')));
  if (pos.leverageType) side.appendChild(document.createTextNode(' ' + String(pos.leverageType)));
  tr.appendChild(side);

  tr.appendChild(el('td', 'num', amount(pos.sizeCoin)));
  tr.appendChild(el('td', 'num', usd(pos.notionalUsd)));
  tr.appendChild(el('td', 'num', price(pos.entryPx)));
  tr.appendChild(el('td', 'num', price(pos.markPx)));
  tr.appendChild(el('td', 'num liq', price(pos.liqPx)));
  tr.appendChild(pnlCell(pos));

  var acts = el('td', 'acts');
  acts.appendChild(actionButton('[ CLOSE POSITION ]', 'close', { coin: String(pos.coin) }));
  acts.appendChild(actionButton('[ CANCEL ALL ]', 'cancel_all', { coin: String(pos.coin) }));
  tr.appendChild(acts);
  return tr;
}

function orderRow(o, p) {
  var tr = el('tr', 'orow');
  tr.dataset.oid = String(o.oid);
  markHighlight(tr, p, 'order', o.oid);
  tr.appendChild(el('td', 'nest', String(o.role || o.kind) + ' ' + String(o.coin)));
  tr.appendChild(el('td', o.side === 'sell' ? 'side short' : 'side long', String(o.side)));
  tr.appendChild(el('td', 'num', amount(o.sizeCoin)));
  tr.appendChild(el('td', 'num', usd(o.notionalUsd)));
  tr.appendChild(el('td', 'num', price(o.kind === 'trigger' ? o.triggerPx : o.px)));
  tr.appendChild(el('td', 'faint', o.tif ? String(o.tif) : '--'));
  tr.appendChild(el('td', 'faint', String(o.kind)));
  tr.appendChild(el('td', 'faint', (o.reduceOnly ? 'reduce-only ' : '') + clock(o.atMs)));
  var acts = el('td', 'acts');
  acts.appendChild(actionButton('[ CANCEL ]', 'cancel', { id: String(o.oid) }));
  tr.appendChild(acts);
  return tr;
}

/* FLATTEN ALL has no home of its own in the DOM contract and it is a book-wide control, so it
   rides the last row of the book, under the positions it would close. */
function flattenRow() {
  var tr = el('tr', 'frow');
  var td = el('td');
  td.colSpan = BOOK_COLS;
  td.appendChild(actionButton('[ FLATTEN ALL ]', 'flatten', {}));
  tr.appendChild(td);
  return tr;
}

function renderBook(p) {
  var rows = resetRows('t-book-rows', 't-book-empty');
  if (!rows) return;
  var d = p || {};
  var positions = Array.isArray(d.positions) ? d.positions : [];
  // undefined orders is the venue not having answered; an empty array is a real answer.
  var ordersKnown = Array.isArray(d.orders);
  var orders = ordersKnown ? d.orders : [];
  var placed = {};

  for (var i = 0; i < positions.length; i++) {
    var pos = positions[i];
    rows.appendChild(positionRow(pos, p));
    var coin = String(pos.coin).toUpperCase();
    var mine = [];
    for (var j = 0; j < orders.length; j++) {
      if (String(orders[j].coin).toUpperCase() !== coin) continue;
      placed[String(orders[j].oid)] = true;
      mine.push(orders[j]);
    }
    for (var k = 0; k < mine.length; k++) rows.appendChild(orderRow(mine[k], p));
    if (!ordersKnown) rows.appendChild(spanRow(BOOK_COLS, 'orders unavailable', 'orow note'));
    else if (!mine.length) rows.appendChild(spanRow(BOOK_COLS, 'No orders working.', 'orow note'));
  }

  // A resting entry belongs to no position yet, so it sorts to the bottom under its own line
  // rather than pretending to be a property of something that does not exist.
  var loose = [];
  for (var n = 0; n < orders.length; n++) if (!placed[String(orders[n].oid)]) loose.push(orders[n]);
  if (loose.length) {
    rows.appendChild(spanRow(BOOK_COLS, 'orders with no position', 'ohead'));
    for (var q = 0; q < loose.length; q++) rows.appendChild(orderRow(loose[q], p));
  }

  var anything = positions.length > 0 || loose.length > 0;
  var empty = $('t-book-empty');
  if (empty) {
    // Before the payload lands, flat is not yet a fact about the account.
    empty.textContent = p ? 'Flat. No position on any market.' : 'Waiting for the venue.';
    empty.hidden = anything;
  }
  if (anything) rows.appendChild(flattenRow());
}

/* ---------- 6. fills ---------- */

function fillRow(f, p) {
  var tr = el('tr', f.liquidation ? 'flrow liq' : 'flrow');
  tr.dataset.tid = String(f.tid);
  markHighlight(tr, p, 'fill', f.tid);
  tr.appendChild(el('td', 'ts', clock(f.atMs)));
  tr.appendChild(el('td', 'sym', String(f.coin)));
  var side = el('td', f.side === 'sell' ? 'side short' : 'side long');
  side.appendChild(document.createTextNode(String(f.side)));
  // The venue closing this for you is not the same event as you closing it, and the two must
  // never read alike.
  if (f.liquidation) {
    side.appendChild(document.createTextNode(' '));
    side.appendChild(el('span', 'liq', 'LIQ'));
  }
  tr.appendChild(side);
  tr.appendChild(el('td', 'num', price(f.px)));
  tr.appendChild(el('td', 'num', amount(f.sizeCoin)));
  tr.appendChild(el('td', 'num', usd(f.notionalUsd)));
  tr.appendChild(el('td', 'num', usd(f.feeUsd)));
  // Closed PnL is absent on an opening fill and on any fill the venue did not price, so it
  // stays unknown rather than becoming zero.
  tr.appendChild(el('td', 'num', signedUsd(f.closedPnlUsd)));
  return tr;
}

function renderFills(p) {
  var rows = resetRows('t-fill-rows', 't-fills-empty');
  if (!rows) return;
  var d = p || {};
  var fills = (Array.isArray(d.fills) ? d.fills : []).slice();
  fills.sort(function (a, b) {
    return (b.atMs || 0) - (a.atMs || 0);
  });
  for (var i = 0; i < fills.length; i++) rows.appendChild(fillRow(fills[i], p));
  var empty = $('t-fills-empty');
  if (empty) {
    empty.textContent = p ? 'No fills yet.' : 'Waiting for the venue.';
    empty.hidden = fills.length > 0;
  }
  if (!rows.childElementCount && !empty) rows.appendChild(spanRow(FILL_COLS, 'No fills yet.', 'flrow note'));
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
  var box = $('t-log');
  if (!box) return;
  box.textContent = '';
  if (!events.length) {
    box.appendChild(el('div', 'logline empty faint', 'Nothing yet.'));
    return;
  }
  for (var i = 0; i < events.length; i++) box.appendChild(logLine(events[i]));
}

function appendLog(event) {
  var box = $('t-log');
  if (!box) return;
  var first = box.firstChild;
  if (first && first.classList && first.classList.contains('empty')) box.textContent = '';
  box.insertBefore(logLine(event), box.firstChild);
  while (box.childElementCount > LOG_MAX_LINES) box.removeChild(box.lastChild);
}

/* ---------- 8. note and overlays ---------- */

function renderNote(p) {
  var text = p && typeof p.note === 'string' ? p.note : null;
  var note = $('t-note');
  if (note) {
    // The agent's own reasoning, one line, verbatim and as text.
    note.textContent = text === null ? '' : text;
    note.hidden = text === null;
  }
  var src = $('t-note-src');
  if (src) {
    // Attribution is never inferred: the payload says who wrote it, and "you" is the word
    // for the human on this page.
    var who = p && p.noteSource === 'agent' ? 'agent' : p && p.noteSource === 'human' ? 'you' : '';
    src.textContent = who;
    src.hidden = text === null;
  }
}

function renderOverlays(p) {
  var box = $('t-overlays');
  if (!box) return;
  var state = (p && p.overlays) || {};
  var buttons = box.querySelectorAll('button[data-overlay]');
  if (!buttons.length) {
    for (var i = 0; i < OVERLAY_NAMES.length; i++) {
      var made = el('button', 'btn', OVERLAY_NAMES[i]);
      made.type = 'button';
      made.dataset.overlay = OVERLAY_NAMES[i];
      box.appendChild(made);
    }
    buttons = box.querySelectorAll('button[data-overlay]');
  }
  for (var j = 0; j < buttons.length; j++) {
    var btn = buttons[j];
    var name = btn.getAttribute('data-overlay');
    var on = state[name] === true;
    // The label trade.html authored is its own; only the state belongs to this file.
    if (!btn.textContent) btn.textContent = name;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.disabled = PENDING['overlay:' + name] === true;
  }
}

/* ---------- human controls ---------- */

/* Every control on this page stops something. Each one carries the approval token, each one
   is disabled the moment it is clicked, and each stays disabled through a redraw that lands
   while the request is out, because two clicks must never become two closes. */

function actionKey(action, args) {
  return action + ':' + (args.id !== undefined ? args.id : args.coin !== undefined ? args.coin : '');
}

function actionButton(label, action, args) {
  var btn = el('button', 'btn', label);
  btn.type = 'button';
  btn.dataset.act = action;
  if (args.id !== undefined) btn.dataset.id = args.id;
  if (args.coin !== undefined) btn.dataset.coin = args.coin;
  btn.disabled = PENDING[actionKey(action, args)] === true;
  return btn;
}

/* Non-happy path B: the app restarted under a page that has been open all night. The refusal
   is shown and the token is reloaded, because a silent no-op is the dangerous outcome. */
async function reportWriteFailure(err) {
  var message = err && err.message ? err.message : String(err);
  if (/token/i.test(message)) {
    try {
      TOKEN = (await getJson('/api/session')).token;
    } catch (err2) {
      TOKEN = null;
    }
    alertText('Approval token is stale. The page reloaded it, try again.');
    return;
  }
  if (err && err.fromServer) refusedLine(message);
  else alertLine(message);
}

async function sendAction(btn, action, args, question) {
  var key = actionKey(action, args);
  if (PENDING[key]) return;
  if (question && !window.confirm(question)) return;
  PENDING[key] = true;
  btn.disabled = true;
  var body = { token: TOKEN, action: action };
  // Order ids are numbers on the venue and mandate ids are strings; the dataset flattens both
  // to text, so the digits go back as a number.
  if (args.id !== undefined) body.id = /^[0-9]+$/.test(args.id) ? Number(args.id) : args.id;
  if (args.coin !== undefined) body.coin = args.coin;
  try {
    await postJson('/api/trade/action', body);
    delete PENDING[key];
    await refreshTrade();
  } catch (err) {
    delete PENDING[key];
    btn.disabled = false;
    await reportWriteFailure(err);
  }
}

async function sendView(key, body, btn) {
  if (PENDING[key]) return;
  PENDING[key] = true;
  if (btn) btn.disabled = true;
  body.token = TOKEN;
  try {
    await postJson('/api/trade', body);
    delete PENDING[key];
    await refreshTrade();
  } catch (err) {
    delete PENDING[key];
    if (btn) btn.disabled = false;
    await reportWriteFailure(err);
  }
}

function onActionClick(btn) {
  var act = btn.dataset.act;
  if (act === 'flatten') {
    sendAction(btn, 'flatten', {}, 'Close every position and stop every bot?');
  } else if (act === 'close') {
    sendAction(btn, 'close', { coin: btn.dataset.coin },
      'Close this position at market? This spends real collateral.');
  } else if (act === 'disarm') {
    sendAction(btn, 'disarm', { id: btn.dataset.id }, 'Stop this bot? Any position it opened stays open.');
  } else if (act === 'cancel') {
    // ux/flow.md writes no confirmation for either cancel, so none is invented here.
    sendAction(btn, 'cancel', { id: btn.dataset.id }, null);
  } else if (act === 'cancel_all') {
    sendAction(btn, 'cancel_all', { coin: btn.dataset.coin }, null);
  }
}

function focusSymbol(coin) {
  var want = String(coin || '').trim().toUpperCase();
  if (!want) return;
  var products = PAYLOAD && Array.isArray(PAYLOAD.products) ? PAYLOAD.products : null;
  if (products && products.length) {
    // The venue's list may be spelled as coins or as the chart's pairs, so a coin matches
    // either. Rejecting ETH because the list says ETH-USD would refuse a real market.
    var ok = false;
    for (var i = 0; i < products.length; i++) {
      var name = String(products[i]).toUpperCase();
      if (name === want || name.split('-')[0] === want) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      alertText('That market is not on this venue.');
      return;
    }
  }
  sendView('focus', { focus: { symbol: want } }, null);
}

/* ---------- refresh and events ---------- */

function renderAll(p) {
  renderStatus(p);
  renderVenueBanner(p);
  renderRisk(p);
  renderMarket(p);
  renderMandates(p);
  renderBook(p);
  renderFills(p);
  renderNote(p);
  renderOverlays(p);
  layoutFrames();
}

/* The chart is another file and owns its own canvases. A page that lost it still has to
   render the account, so the call in is guarded. */
function chartRedraw() {
  if (typeof chartInvalidate === 'function') chartInvalidate(true);
}

async function refreshTrade() {
  if (TRADE_INFLIGHT) {
    TRADE_QUEUED = true;
    return;
  }
  TRADE_INFLIGHT = true;
  try {
    var payload = await getJson('/api/trade');
    PAYLOAD = payload;
    // ui/trade-overlay.js reads window.TRADE and nothing else, so the global moves before the
    // chart is asked to repaint. The other order draws this tick's candles under last tick's
    // account.
    window.TRADE = payload;
    renderAll(payload);
    chartRedraw();
    alertLine(null);
  } catch (err) {
    // The last good numbers stay on the glass with the banner saying how old they are. A
    // blank risk panel is less use than an old one that admits its age.
    alertLine('cannot reach the app: ' + (err.message || String(err)));
  } finally {
    TRADE_INFLIGHT = false;
    if (TRADE_QUEUED) {
      TRADE_QUEUED = false;
      refreshTrade();
    }
  }
}

async function refreshState() {
  if (STATE_INFLIGHT) {
    STATE_QUEUED = true;
    return;
  }
  STATE_INFLIGHT = true;
  try {
    POLICY = await getJson('/api/state');
    renderKill(POLICY);
    // The mandate empty line names the kill switch when the kill switch is the reason.
    renderMandates(PAYLOAD);
  } catch (err) {
    alertLine('cannot read the policy: ' + (err.message || String(err)));
  } finally {
    STATE_INFLIGHT = false;
    if (STATE_QUEUED) {
      STATE_QUEUED = false;
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
    // A reconnect may have missed both log lines and payload changes, so replay once attached.
    if (SSE_SEEN_OPEN) {
      refreshTrade();
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
    if (payload.type === 'trade') refreshTrade();
    else if (payload.type === 'state') refreshState();
    else if (payload.type === 'log' && payload.event) appendLog(payload.event);
    else if (payload.type === 'candles') candlesPushed();
    // A chart change from an agent. Our own writes come back with a revision we already know,
    // and chartPushed drops those rather than repainting over the hand.
    else if (payload.type === 'chart') chartPushed(payload.rev);
  });
  // The spec names the event 'trade' and the pro page's channel puts the kind in the JSON
  // body. Both are accepted, because a surface that silently stops updating is the one
  // failure this page cannot have.
  stream.addEventListener('trade', function () {
    refreshTrade();
  });
}

/* ---------- wiring ---------- */

/* Listeners are attached once, to parents that outlive every redraw. The rows underneath are
   rebuilt on every event and carry no listeners of their own. */

function wireKill() {
  var btn = $('kill-btn');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    var turnOn = btn.dataset.on !== '1';
    var question = turnOn
      ? 'Turn the kill switch ON? Every write is refused and every bot stops.'
      : 'Turn the kill switch OFF? Writes are allowed again, subject to policy.';
    if (PENDING.kill) return;
    if (!window.confirm(question)) return;
    PENDING.kill = true;
    btn.disabled = true;
    try {
      await postJson('/api/kill', { on: turnOn, token: TOKEN });
      delete PENDING.kill;
      await refreshState();
      await refreshTrade();
    } catch (err) {
      delete PENDING.kill;
      btn.disabled = false;
      await reportWriteFailure(err);
    }
  });
}

function wireRows(id) {
  var box = $(id);
  if (!box) return;
  box.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
    if (!btn || btn.disabled) return;
    onActionClick(btn);
  });
}

function wireOverlays() {
  var box = $('t-overlays');
  if (!box) return;
  box.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-overlay]') : null;
    if (!btn || btn.disabled) return;
    var name = btn.getAttribute('data-overlay');
    var on = btn.classList.contains('on');
    sendView('overlay:' + name, { overlay: { name: name, on: !on } }, btn);
  });
}

function wireBanner() {
  var box = $('t-banner-venue');
  if (!box) return;
  box.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-act="retry"]') : null;
    if (!btn || btn.disabled) return;
    PENDING.retry = true;
    btn.disabled = true;
    Promise.all([refreshTrade(), refreshState(), refreshLog()]).then(function () {
      delete PENDING.retry;
      // The refresh above rebuilt this banner, so the control is handed back on the node
      // that is actually on screen now and not on the one that was clicked.
      renderVenueBanner(PAYLOAD);
    });
  });
}

/* The chart's product select is the only market picker in the DOM contract, so changing the
   chart is what moves the focus. chart.js keeps its own listener on this element; this one
   only tells the server which market the human is looking at. */
function wireProduct() {
  var select = $('product');
  if (!select) return;
  select.addEventListener('change', function () {
    focusSymbol(String(select.value || '').split('-')[0]);
  });
}

/* One command line, two vocabularies.

   The input is `chart-cmd`, the same id the pro page uses, because ui/chart.js binds to it by
   id for "ema 21" and this page loads that file unchanged. Rather than a second box beside it,
   the trading verbs share it: "focus eth", "overlay fills on", "clear agent".

   Bound in the CAPTURE phase, so this handler sees Enter before chart.js does. A word it
   recognises is consumed with stopPropagation, and anything else is left alone to reach the
   chart's own parser. Without the capture phase both handlers would fire on every line and one
   of them would always be complaining about a command meant for the other.

   The vocabulary is closed, like the chart's and like the strategy grammar: an unknown word is
   refused with the alternatives rather than guessed at. */
function wireCommand() {
  var input = $('chart-cmd');
  if (!input) return;
  input.addEventListener(
    'keydown',
    function (ev) {
      if (ev.key !== 'Enter') return;
      var words = String(input.value || '').trim().toLowerCase().split(/\s+/);
      var head = words[0] || '';
      if (head !== 'focus' && head !== 'overlay' && head !== 'clear') return;

      /* From here the line is ours, so the chart never sees it. `clear` is deliberately in both
         vocabularies and resolves here: on this page it means the agent's highlights and note,
         which is what a person looking at a trading screen means by it. */
      ev.stopPropagation();
      ev.preventDefault();

      if (head === 'focus' && words[1]) {
        focusSymbol(words[1]);
      } else if (
        head === 'overlay' &&
        OVERLAY_NAMES.indexOf(words[1]) !== -1 &&
        (words[2] === 'on' || words[2] === 'off')
      ) {
        sendView('overlay:' + words[1], { overlay: { name: words[1], on: words[2] === 'on' } }, null);
      } else if (head === 'clear') {
        var target = words[1] || 'agent';
        if (['agent', 'all', 'highlights', 'note'].indexOf(target) === -1) {
          alertText('Not a command. Try: focus eth, overlay fills on, clear agent.');
          return;
        }
        sendView('clear', { clear: target }, null);
      } else {
        alertText('Not a command. Try: focus eth, overlay fills on, clear agent.');
        return;
      }
      input.value = '';
    },
    true,
  );
}

function wireResize() {
  var timer = null;
  window.addEventListener('resize', function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      layoutFrames();
    }, 120);
  });
}

async function boot() {
  applyCollapse();
  wireKill();
  wireCollapse();
  wireRows('t-book-rows');
  wireRows('t-mandate-list');
  wireOverlays();
  wireBanner();
  wireProduct();
  wireCommand();
  wireResize();
  // The frame and every label go up before the first fetch answers, with every number at --
  // and the banner saying what is being waited on. No spinner: the shell is the answer.
  renderKill(null);
  renderAll(null);
  try {
    TOKEN = (await getJson('/api/session')).token;
  } catch (err) {
    alertLine('no approval token: ' + (err.message || String(err)));
  }
  await refreshState();
  await refreshTrade();
  await refreshLog();
  openEvents();
  // The chart owns its own fetch loop and its own timers; see ui/chart.js.
  chartBoot();
}

boot();
