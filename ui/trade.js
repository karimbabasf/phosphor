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

/* How many rows the tape keeps. Past this it is not history a person reads, it is a file,
   and /api/log is where a file belongs. */
var HISTORY_MAX_ROWS = 300;

/* The manual controls on this page, by the name the server logs them under. A log line
   carrying one of these acted on the book, so it belongs on this tape whatever else the
   app was doing at the time. */
var TRADE_ACTIONS = { close: 'close', cancel: 'cancel', cancel_all: 'cancel all', flatten: 'flatten', disarm: 'disarm' };

/* The proposal kinds that reach this venue, and the word each one goes under once it has
   executed. Every other kind the app can propose is treasury (swap, intents deposit and
   withdraw, lp, consolidate, transfer) and belongs to the pro window's TRANSACTIONS tab,
   which has the columns for it. Matching on the kind's own name is why a withdrawal cannot
   land on this tape.

   There are two of them and there were one. `hl_deposit` joined on 2026-08-20 for a reason
   that is a property of the account rather than of the ledger: it is the only treasury-shaped
   kind whose money lands INSIDE this venue, and a bot armed against an unfunded account can
   never fire. A human watching a mandate do nothing has to be able to see, on this page, that
   the collateral it needs was proposed at 14:02 and is still waiting for a click. Sending them
   to the other window to find that out is how a proposal sits unread while the market moves.

   Exactly these two. The rule is not "anything that touches money", it is "the two kinds that
   change what this venue's account can do", and a third one has to earn its place the same way. */
var TRADE_PROPOSAL_KINDS = { mandate_arm: 'armed', hl_deposit: 'funded' };

/* The closed overlay set, in the order src/trade/view.ts declares it. trade.html authors the
   buttons; this list is the fallback when the container is empty and the order they draw in. */
var OVERLAY_NAMES = ['position', 'liquidation', 'stops', 'targets', 'orders', 'fills', 'mandateWall'];

/* Column counts for the two tables, needed only by the rows that span the full width.
   HISTORY_NUM_COLS is the run of columns a fill fills with figures; an event that is not a
   fill says what happened across that run instead. */
var BOOK_COLS = 7;
var HISTORY_COLS = 7;
var HISTORY_NUM_COLS = 4;

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
/* The audit tail as this page last saw it. HISTORY merges three sources that arrive on
   three different channels, so the two that are not the payload are held here and the
   whole tape is rebuilt whenever any of them moves. Newest first, the order it is read in. */
var LOG_EVENTS = [];
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
  // A figure that rounds to nothing is nothing, and it never carries a sign. A funding
  // accrual of -0.0004 printed as `-$0.00`, which reads as a loss the account has not made
  // and, on a signed figure, as a direction it is not moving in.
  if (Math.abs(v) < 0.005) v = 0;
  return (v < 0 ? '-' : '') + '$' +
    Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Whether a figure is one the screen will actually print as a number. usd() rounds at half a
   cent, so anything under that reaches the glass as `$0.00`, and a line of prose ABOUT that
   figure has to appear on the same condition. Otherwise a venue's rounding dust, and the live
   mainnet account carries two millionths of a dollar of it, buys a caveat about money nobody
   has. Not the same question as known(): a null is unknown, and this is known to be nothing. */
function nonZero(n) {
  return known(n) && Math.abs(Number(n)) >= 0.005;
}

/* PnL and net exposure are read for their direction before their size, so the sign is always
   printed, including the plus. */
function signedUsd(n) {
  if (!known(n)) return '--';
  return (Number(n) >= 0.005 ? '+' : '') + usd(n);
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

/* A distance to a wall, where precision follows magnitude the way price() already does it.
   A live account printed `1705.38% away` and `3998.3 ATR`: two decimal places on a figure
   in the thousands is four characters of noise on the one number this page is read for, and
   the thousands separator it lacked is what tells a reader at a glance that the number has
   four digits rather than three. Under ten percent the decimals are the whole point, and
   that is the only case where the position is actually close to the wall. */
function distancePct(n) {
  if (!known(n)) return '--';
  var v = Number(n);
  var a = Math.abs(v);
  var digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + '%';
}

function atrCount(n) {
  if (!known(n)) return '--';
  var v = Number(n);
  return v.toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(v) >= 100 ? 0 : 1,
    maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1
  });
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

/* Box-drawing weights, the same two ui/app.js carries. The agent column is the one surface
   on either deck drawn in double rules, which is how a terminal says "this is a different
   kind of thing" without reaching for a second colour. A panel asks for one by carrying
   data-frame on its frame element; everything else is single. */
var FRAME_SETS = {
  single: { open: '┌', shut: '├', close: '┐', tee: '┤', end: '└', foot: '┘', rule: '─' },
  double: { open: '╔', shut: '╠', close: '╗', tee: '╣', end: '╚', foot: '╝', rule: '═' },
};

function layoutFrames() {
  var cw = charWidth();
  if (!cw) return;
  var frames = document.querySelectorAll('.frame');
  for (var i = 0; i < frames.length; i++) {
    var frame = frames[i];
    var cols = Math.max(24, Math.floor(frame.parentElement.clientWidth / cw));
    var set = FRAME_SETS[frame.getAttribute('data-frame')] || FRAME_SETS.single;
    var title = frame.getAttribute('data-title');
    if (!title) {
      frame.textContent = set.end + repeat(set.rule, Math.max(1, cols - 2)) + set.foot;
      continue;
    }
    var name = frame.getAttribute('data-collapse');
    var shut = name ? isCollapsed(name) : false;
    var head = (shut ? set.shut : set.open) + set.rule + ' ' + title + ' ';
    var tail = name ? ' [' + (shut ? '+' : '-') + '] ' + set.rule + (shut ? set.tee : set.close) : set.close;
    frame.textContent = head + repeat(set.rule, Math.max(1, cols - head.length - tail.length)) + tail;
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
  setClass($('t-history-rows'), 'stale', stale);

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

/* The share of the scale still standing between this position and the venue's wall.

   This was inverted, and inverted the wrong way: it returned `1 - distance/scale`, so a
   position far from its liquidation produced a negative fill, clamped to zero, and left the
   bar showing its red track end to end. A live account 1,607 ATR clear of the wall drew the
   picture of an account at it. The bar is a reverse meter by design (green covers red, and
   the red still showing is the ground left to lose), so the fill IS the distance and never
   the danger: full green far away, empty at the wall, which is also what the stylesheet
   above it says out loud. */
function liqFill(pos) {
  if (known(pos.liqDistanceAtr)) return (Number(pos.liqDistanceAtr) / LIQ_ATR_FULL) * 100;
  if (known(pos.liqDistancePct)) return (Number(pos.liqDistancePct) / LIQ_PCT_FULL) * 100;
  return null;
}

/* The wall the human approved, for whichever market the distance block is about. Only an
   armed mandate has one: a program nobody armed is not holding a stop-out over anything. */
function armedWall(p, coin) {
  var list = (p && Array.isArray(p.mandates)) ? p.mandates : [];
  var want = String(coin || '').toUpperCase();
  for (var i = 0; i < list.length; i++) {
    if (!list[i].armed) continue;
    if (want && String(list[i].symbol).toUpperCase() !== want) continue;
    return list[i].wallPx;
  }
  return null;
}

/* Both prices that can end a position, in one block.
   The venue's liquidation and the mandate stop-out are the same class of fact from two
   different authorities, and a screen that puts them in separate panels makes the reader
   hold one in their head while they find the other. No ordering is asserted between them:
   live numbers have put a stop-out at $1,133 under a liquidation at $1,422 and above one
   on another day, so which comes first is a reading and never a layout. */
/* One wrapper hides the whole reading, rather than each figure walking up to find a line of
   its own to hide. The walk this replaces got the bar wrong: the bar's parent IS the block,
   so hiding the bar hid the section and took the stop-out line down with it, on exactly the
   account the stop-out line exists for. */
function renderLiqBlock(pos, wallPx) {
  var body = $('t-liq-body');
  if (body) body.hidden = !pos;
  // Flat with a mandate armed there is still a wall to state, so the stop-out line is shown
  // whenever a mandate holds one, on its own terms and not on the position's.
  var wall = $('t-wall-line');
  if (wall) wall.hidden = !known(wallPx);
  setText('t-wall-price', price(wallPx));
  // Neither wall exists: the section goes with its contents rather than heading an empty
  // block. The account block below says what is true instead, in a sentence.
  var block = $('t-liq-block');
  if (block) block.hidden = !pos && !known(wallPx);
  if (!pos) {
    setText('t-liq-price', '--');
    setText('t-liq-pct', '--');
    setText('t-liq-usd', '--');
    setText('t-liq-atr', '--');
    // Flat, so the readout is back and empty. Without this the sentence from the last position
    // outlives the position it was about.
    if ($('t-liq-body')) $('t-liq-body').hidden = false;
    if ($('t-liq-none')) $('t-liq-none').hidden = true;
    fillBar($('t-liq-bar'), null);
    return;
  }
  /* A wall exists and nothing can reach it, which is not the same as no wall and not the same
     as a far one. state.ts has already blanked the three distances for this case, so without
     this branch the section prints "-- away, at 84636" and reads as a panel that lost half its
     numbers. The sentence replaces the whole readout rather than sitting beside it: the venue's
     price is still on the payload for anyone reading the log, and on screen beside the words
     "no wall in reach" it only invites the reader to work out whether the two agree. */
  var reachable = pos.liqReachable !== false;
  var body = $('t-liq-body');
  var none = $('t-liq-none');
  if (body) body.hidden = !reachable;
  if (none) none.hidden = reachable;
  if (!reachable) {
    fillBar($('t-liq-bar'), null);
    return;
  }
  setText('t-liq-price', price(pos.liqPx));
  setText('t-liq-pct', distancePct(pos.liqDistancePct));
  setText('t-liq-usd', usd(pos.liqDistanceUsd));
  setText('t-liq-atr', atrCount(pos.liqDistanceAtr));
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
      't-mkt-funding8', 't-mkt-atr', 't-mkt-atrpct'].forEach(function (id) {
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
  // Open interest and 24h volume used to print here. They describe the market's health and
  // never this position's, and nothing a person does at this desk changes on either, so
  // they went with the panel frame rather than into the panel that replaced it.
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
  // An unpublished health gets words and no meter at all. A hatched track beside `health --`
  // reads as a broken widget rather than as a missing reading, and on a unified account,
  // where the venue does not publish what the figure needs, that is the normal state and
  // not an edge one.
  var healthKnown = known(account.healthPct);
  setClass(setText('t-risk-health', healthKnown ? pctOfShare(account.healthPct) : 'not published'),
    'faint', !healthKnown);
  var healthBar = $('t-risk-healthbar');
  if (healthBar) healthBar.hidden = !healthKnown;
  fillBar(healthBar, healthKnown ? Number(account.healthPct) * 100 : null);

  setText('t-exp-net', signedUsd(account.netNotionalUsd));
  setText('t-exp-gross', usd(account.grossNotionalUsd));
  // A sentence, not a figure: a bare number here reads as a balance rather than as what is
  // left after a move that has not happened yet. The line is never hidden, because the
  // absence of this number is itself news on a unified account. Absent, it says what is
  // missing: the sentence used to end "leaves --.", which reads as a broken template rather
  // than as a fact the venue has not published.
  setText('t-exp-shock', known(account.equityAtFivePctAdverse)
    ? 'A 5% move against you leaves ' + usd(account.equityAtFivePctAdverse) + '.'
    : 'A 5% move against you: the venue has not published enough to say.');

  var positions = Array.isArray(d.positions) ? d.positions : null;
  // accountKnown is false until the feed has settled what kind of account this is, and every
  // figure above is null while it is. Flat and not-yet-known are different facts, so an
  // unsettled account never gets the sentence that says there is nothing at risk.
  var settled = account.accountKnown !== false;
  var empty = $('t-risk-empty');
  if (!positions || (!positions.length && !settled)) {
    setText('t-risk-empty', 'No account data yet.');
    if (empty) empty.hidden = false;
    renderLiqBlock(null, armedWall(p, d.symbol));
    return;
  }
  if (!positions.length) {
    setText('t-risk-empty', 'Nothing at risk. No open position.');
    if (empty) empty.hidden = false;
    renderLiqBlock(null, armedWall(p, d.symbol));
    return;
  }
  if (empty) empty.hidden = true;
  var at = riskPosition(positions, d.symbol);
  renderLiqBlock(at, armedWall(p, at ? at.coin : d.symbol));
}

/* ---------- 3b. collateral ----------

   What a mandate can actually spend, where it is, and what it costs to send more.

   THIS BLOCK CONTAINS NO CONTROL. Every manual control on this page stops something, and
   starting is what a mandate is for, so there is no deposit button here and no field to type
   an amount into. The agent proposes funding with propose_hl_deposit and a human decides it in
   APPROVALS, one panel down, which is where every other decision that spends money on this
   page is already taken. What is written here is the capability, so that a person looking at
   an empty account knows what would fill it and what that would cost. */

/* "arb, base or eth". A list a person reads, not a comma run: the last separator is a word
   because that is how the rest of the copy on this page joins things. */
function orList(items) {
  if (!items || !items.length) return null;
  if (items.length === 1) return String(items[0]);
  return items.slice(0, -1).join(', ') + ' or ' + String(items[items.length - 1]);
}

/* The rail in one sentence, built from the numbers the payload carries rather than from a
   remembered figure. The cost is quoted at TWO sizes on purpose. The routing fee is close to
   flat, so a single percentage would be a fact about the amount pretending to be a fact about
   the rail: the same deposit is under a percent at fifty dollars and a tenth of one at a
   thousand, and a reader who was told one number would size the wrong deposit.

   The rail is mainnet only, and on any other trading network this says so rather than
   advertising a capability the rail refuses. That refusal is the most valuable one in the app:
   the deposit would take real money, land it correctly on the MAINNET account, report success,
   and leave the testnet account this app is trading empty. */
function fundingLine(f) {
  if (!f) return 'The funding rail has not reported its shape.';
  if (f.available === false) {
    var where = f.faucet ? ' Take testnet collateral from the venue faucet at ' + String(f.faucet) + '.' : '';
    return 'The rail is mainnet only: it delivers mainnet USDC and one address names an account on both networks.' + where;
  }
  var origins = orList(f.origins);
  var parts = [];
  parts.push(origins && known(f.etaSec)
    ? 'In from ' + origins + ' in about ' + count(f.etaSec) + 's'
    : 'In from any chain this app signs for');
  var costs = [];
  var at = Array.isArray(f.costAt) ? f.costAt : [];
  for (var i = 0; i < at.length; i++) {
    if (!known(at[i].pct) || !known(at[i].usd)) continue;
    costs.push(pct(at[i].pct) + ' of $' + amount(at[i].usd));
  }
  if (costs.length) parts.push('near flat at ' + costs.join(' and ' ));
  if (known(f.minUsd)) parts.push('min $' + amount(f.minUsd));
  // The safety property, and the last clause on purpose: it is what a reader is left holding.
  return parts.join(', ') + '. One way in: out is a signed withdraw3.';
}

function renderCollateral(p) {
  var d = p || {};
  var coll = d.collateral || {};
  var account = d.account || {};

  setText('t-coll-perp', usd(coll.perpUsd));
  setText('t-coll-spot', usd(coll.spotUsdcUsd));
  setText('t-coll-network', coll.network ? 'hyperliquid ' + String(coll.network) : '--');

  // What that spot figure MEANS, which is a different answer on the two kinds of account this
  // venue has, and getting it wrong is worse than saying nothing.
  //
  // On a classic account the two books are separate: spot USDC is real, a mandate cannot draw
  // on it, and a bot armed against it opens nothing. That is the sentence the block exists for.
  //
  // On a UNIFIED account the books are merged and there is no spot side to be stuck on. The
  // same sentence there would tell somebody their money was unusable while it sat in free
  // collateral on the line above. That is exactly the wrong claim the rail's settle step was
  // corrected for on 2026-08-20, and it must not come back in on the screen.
  //
  // Nothing at all until the feed has settled which kind this is, because `unified: false` is
  // also what "not known yet" looks like from here. accountKnown is the flag that tells them
  // apart, and one render of silence is cheaper than one render of the wrong sentence.
  //
  // Drawn only when the figure it is about is drawn: nonZero is the same half-cent rule usd()
  // rounds by, so venue dust does not buy a caveat about money nobody has.
  var spotNote = $('t-coll-spot-note');
  if (spotNote) {
    var settled = account.accountKnown === true;
    var say = settled && nonZero(coll.spotUsdcUsd);
    if (say) {
      setText('t-coll-spot-note', account.unified === true
        ? 'This account is unified: the books are merged, so that USDC is already collateral.'
        : 'Spot USDC is real money and is not margin. A mandate cannot draw on it.');
    }
    spotNote.hidden = !say;
  }

  // funded is three-valued. False is an account that has answered and has nothing, which is
  // the state that needs a next action written next to it. Null is the venue not having
  // answered yet, and the dashes above already say that; a page that printed "nothing to trade
  // with" during a reconnect would be telling a funded account it was empty.
  //
  // The next action follows the rail rather than being one fixed sentence. On a network the
  // rail cannot serve, "ask your agent to fund this account" sends a person to ask for
  // something that will be refused, which is a dead end wearing the clothes of a next step.
  var empty = $('t-coll-empty');
  if (empty) {
    var canFund = !coll.funding || coll.funding.available !== false;
    setText('t-coll-empty', canFund
      ? 'Nothing to trade with. Ask your agent to fund this account.'
      : 'Nothing to trade with. Take collateral from the venue faucet.');
    empty.hidden = coll.funded !== false;
  }

  setText('t-coll-rail', fundingLine(coll.funding));
}

/* ---------- 4. mandates ---------- */

/* The four bounds, as the classes trade.css documents above the .mrow rules and not as a
   near miss of them. This emitted .mbar-text and .mbar-track where the stylesheet draws
   .mbar-k, .track and .fill, so nothing matched: the bounds rendered as four lines of
   plain text with no meter at all, and the one rule that turns the loss bar red past its
   threshold could never fire. A spent envelope is the thing on this page most worth
   seeing before it is read, so the contract is kept here rather than loosened there. */
function meter(bound, label, value, percent, hot) {
  var bar = el('div', 'mbar');
  bar.dataset.bound = bound;
  bar.appendChild(el('span', 'mbar-k', label));
  var track = el('span', 'track');
  fillBar(track, percent);
  bar.appendChild(track);
  bar.appendChild(el('span', 'mbar-v', value));
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
  // The stop-out price left this row for the risk block above it, beside the venue's own
  // wall, because the two prices that can end a position are read together or not at all.
  // What the last rule did left this row for HISTORY, where the rest of the sequence is.
  if (m.haltedReason) head.appendChild(el('span', 'meta red', String(m.haltedReason)));
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
      'notional',
      usd(used.notionalUsd) + ' of ' + usd(env.maxNotionalUsd),
      share(used.notionalUsd, env.maxNotionalUsd),
      false
    ));
    var lost = share(used.lossUsd, env.maxLossUsd);
    bars.appendChild(meter(
      'loss',
      'loss',
      usd(used.lossUsd) + ' of ' + usd(env.maxLossUsd),
      lost,
      known(lost) && lost > HOT_AT
    ));
    bars.appendChild(meter(
      'orders',
      'orders/min',
      count(used.ordersLastMin) + ' of ' + count(env.maxOrdersPerMin),
      share(used.ordersLastMin, env.maxOrdersPerMin),
      false
    ));
    bars.appendChild(meter('time', 'expires', duration(used.msToExpiry), lifeShare(m), false));
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
  var head = el('div', 'pnl-net', signedUsd(net) + ' ' + pct(pos.roePct));
  setClass(head, 'up', known(net) && Number(net) >= 0);
  setClass(head, 'down', known(net) && Number(net) < 0);
  td.appendChild(head);
  return td;
}

/* The two parts of the result, on the row under the net rather than inside its cell.

   Retail shows one PnL number. A position's result is price plus funding minus fees, and a
   carry trade that is green on price can be red once it has paid for itself, so the net is
   the headline and the two parts sit under it. They used to sit under it INSIDE the cell,
   which made the profit column twenty-seven characters wide and pushed the controls off the
   right of a table that already did not fit. The table has an idiom for a fact that belongs
   to the position above it, and the orders already use it, so the split uses it too. */
function splitRow(pos) {
  if (!known(pos.pnlPriceUsd) && !known(pos.pnlFundingUsd)) return null;
  // Nothing to split. With no funding paid and a price part equal to the net, this line
  // reprints the figure on the row above it, and that repetition is what made one position
  // take three lines of the book. Funding is never the hidden one: any carry that has
  // actually moved brings the line straight back.
  var carry = known(pos.pnlFundingUsd) ? Number(pos.pnlFundingUsd) : 0;
  var priced = known(pos.pnlPriceUsd) ? Number(pos.pnlPriceUsd) : null;
  var net = known(pos.pnlNetUsd) ? Number(pos.pnlNetUsd) : null;
  if (Math.abs(carry) < 0.005 && priced !== null && net !== null && Math.abs(priced - net) < 0.005) return null;
  var tr = el('tr', 'srow');
  var td = el('td', 'faint',
    'price ' + signedUsd(pos.pnlPriceUsd) + ', funding ' + signedUsd(pos.pnlFundingUsd));
  td.colSpan = BOOK_COLS;
  tr.appendChild(td);
  return tr;
}

function positionRow(pos, p, working) {
  var tr = el('tr', 'prow');
  tr.dataset.coin = String(pos.coin);
  markHighlight(tr, p, 'position', pos.coin);
  tr.appendChild(el('td', 'sym', String(pos.coin)));

  // Direction, leverage and margin mode on one line: `SHORT 10x cross`. The mode had a line
  // of its own under the direction, which made every position row two lines tall before its
  // orders and its profit split added any more, and the two are not peers anyway: cross
  // against isolated qualifies the leverage sitting next to it.
  var short = pos.side === 'short';
  var side = el('td', short ? 'side short' : 'side long');
  side.appendChild(el('span', 'side-dir',
    (short ? 'SHORT' : 'LONG') + ' ' + (known(pos.leverage) ? pos.leverage + 'x' : '--')));
  // `iso`, because `isolated` is three characters longer than the whole column can spare
  // and it is the trader's own shorthand for it, not an invention of this page.
  var mode = pos.leverageType ? String(pos.leverageType) : '--';
  side.appendChild(el('span', 'side-mode', mode === 'isolated' ? 'iso' : mode));
  tr.appendChild(side);

  tr.appendChild(el('td', 'num', usd(pos.notionalUsd)));
  tr.appendChild(el('td', 'num', price(pos.entryPx)));
  tr.appendChild(el('td', 'num liq', price(pos.liqPx)));
  tr.appendChild(pnlCell(pos));

  // Short labels, because this column is pinned to the right edge of a table that scrolls
  // sideways under it and every character it spends is taken from the numbers. The
  // confirmation dialog is where the full sentence belongs and already carries it.
  var acts = el('td', 'acts');
  acts.appendChild(actionButton('[ CLOSE ]', 'close', { coin: String(pos.coin) }));
  // CANCEL ALL cancels this market's working orders, so it is drawn when there are some to
  // cancel. On a position with nothing resting under it, it was a control that could only
  // ever do nothing, wearing the widest label in the narrowest column on the page. Drawn
  // too when the venue has not answered about orders: unknown is not the same as none, and
  // a brake is not the thing to remove on a guess.
  if (working) acts.appendChild(actionButton('[ CANCEL ALL ]', 'cancel_all', { coin: String(pos.coin) }));
  tr.appendChild(acts);
  return tr;
}

/* Seven cells, matching the position row above it column for column. An order's quantity
   rides its SIDE cell (`sell 0.66`) now that the book carries no coin column: the position
   above it is measured in dollars, but a resting instruction is placed in coins and losing
   that would leave a stop nobody could size. */
function orderRow(o, p) {
  var tr = el('tr', 'orow');
  tr.dataset.oid = String(o.oid);
  markHighlight(tr, p, 'order', o.oid);
  tr.appendChild(el('td', 'nest', String(o.role || o.kind) + ' ' + String(o.coin)));
  tr.appendChild(el('td', o.side === 'sell' ? 'side short' : 'side long',
    String(o.side) + ' ' + amount(o.sizeCoin)));
  tr.appendChild(el('td', 'num', usd(o.notionalUsd)));
  tr.appendChild(el('td', 'num', price(o.kind === 'trigger' ? o.triggerPx : o.px)));
  tr.appendChild(el('td', 'faint', String(o.kind) + (o.tif ? ' ' + String(o.tif) : '')));
  // `reduce`, not `reduce-only`: the pair with a timestamp beside it is twenty characters in a
  // nineteen character column, and the flag is the half a reader needs.
  tr.appendChild(el('td', 'faint', (o.reduceOnly ? 'reduce ' : '') + clock(o.atMs)));
  var acts = el('td', 'acts');
  acts.appendChild(actionButton('[ CANCEL ]', 'cancel', { id: String(o.oid) }));
  tr.appendChild(acts);
  return tr;
}

/* FLATTEN ALL is a book-wide control and it lives in the panel footer, under the table and
   outside it. It used to ride the last row of the table, which put the one control that
   closes every position and stops every bot inside the box that scrolls: on a long book it
   was below the fold, and on a short one it read as one more position. */
function renderFlatten(anything) {
  var foot = $('t-book-foot');
  if (!foot) return;
  foot.textContent = '';
  if (anything) foot.appendChild(actionButton('[ FLATTEN ALL ]', 'flatten', {}));
  foot.hidden = !anything;
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
    var coin = String(pos.coin).toUpperCase();
    var mine = [];
    for (var j = 0; j < orders.length; j++) {
      if (String(orders[j].coin).toUpperCase() !== coin) continue;
      placed[String(orders[j].oid)] = true;
      mine.push(orders[j]);
    }
    rows.appendChild(positionRow(pos, p, mine.length > 0 || !ordersKnown));
    var split = splitRow(pos);
    if (split) rows.appendChild(split);
    for (var k = 0; k < mine.length; k++) rows.appendChild(orderRow(mine[k], p));
    // A position with nothing resting under it used to get a row saying "No orders
    // working.". The absent child row already says it, and on a book of several positions
    // that was one grey line of nothing per position. The venue not having answered keeps
    // its row: unknown is news, and none is not.
    if (!ordersKnown) rows.appendChild(spanRow(BOOK_COLS, 'orders unavailable', 'orow note'));
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
  renderFlatten(anything);
}

/* ---------- 6. history ---------- */

/* One tape, three sources. Fills come from the venue through the trade payload, the mandate's
   own lifecycle comes from the armed rows in that same payload, and everything a human or a
   policy did comes from the audit log. They were three panels and they are one sequence: a
   refusal at 14:31 and the fill that did not happen at 14:31 only mean something together.

   Scoped to trading, and the scoping is the whole reason this can be one panel. The audit log
   is the app's log, so it also carries treasury swaps, intents deposits and withdrawals, which
   have different columns, a different ledger and their own tab on the pro window. Nothing
   reaches this tape unless it named a market, named a trade action, or named one of the two
   proposal kinds in TRADE_PROPOSAL_KINDS: the one that arms a program on this venue, and the
   one that puts the collateral the program needs inside it. */

/* Which proposal kind each id on this log tail is, for the two kinds this page claims. Only
   proposal_created spells the kind out, so the id it carries is what lets the later lines about
   the same proposal (the approval, the refusal at approval time, the execution) be recognised
   as trading rather than as treasury. A proposal whose creation has already scrolled off the
   tail is not claimed: dropping a line is a gap, and calling a swap a trade is a lie.

   The kind is kept rather than a boolean, because the two kinds do not end in the same word. A
   mandate that executes is ARMED and a deposit that executes is FUNDED, and one word for both
   would put a bot on the tape where the money went. */
function tradeProposalKinds(events) {
  var kinds = {};
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.type !== 'proposal_created') continue;
    var msg = String(ev.msg || '');
    var id = ev.data && ev.data.id;
    if (!id) continue;
    for (var kind in TRADE_PROPOSAL_KINDS) {
      if (msg.indexOf(kind) !== -1) kinds[String(id)] = kind;
    }
  }
  return kinds;
}

/* Which of this page's kinds an event is about, or null. The id decides it whenever the tail
   still holds the creation line; otherwise the message is read for a kind's own name, which is
   what covers the first paint after a reload. */
function proposalKindOf(ev, kinds) {
  var data = ev.data || {};
  var id = data.id ? String(data.id) : null;
  if (id && kinds[id]) return kinds[id];
  var msg = String(ev.msg || '');
  for (var kind in TRADE_PROPOSAL_KINDS) {
    if (msg.indexOf(kind) !== -1) return kind;
  }
  return null;
}

/* The short word this event goes under in the KIND column. Null means it is not this page's
   business and never reaches the tape. */
function historyKind(ev, kinds) {
  var data = ev.data || {};
  var action = data.action ? String(data.action) : null;
  // A human pressed one of this page's buttons. tool_call is dropped on purpose: the server
  // writes one before the action and one after it, and a tape that prints both says every
  // manual close twice.
  if (action && TRADE_ACTIONS[action]) {
    if (ev.type === 'tool_call') return null;
    if (ev.type === 'error' || ev.type === 'execution_failed') return 'failed';
    return TRADE_ACTIONS[action];
  }
  if (action) return null;
  var mine = proposalKindOf(ev, kinds);
  if (ev.type === 'kill_switch') return 'kill';
  if (!mine) return null;
  if (ev.type === 'proposal_created') return 'proposed';
  if (ev.type === 'approved') return 'approved';
  if (REFUSAL_TYPES[ev.type]) return 'refused';
  if (ev.type === 'executed') return TRADE_PROPOSAL_KINDS[mine];
  if (ev.type === 'execution_failed') return 'failed';
  return null;
}

/* A market name only when the event actually carries one. The log's data is unknown shape by
   type, so nothing is inferred from the message text: an unnamed market prints as unknown. */
function historyCoin(ev) {
  var coin = ev.data && ev.data.coin;
  return coin ? String(coin).toUpperCase() : null;
}

function fillEntry(f) {
  return { at: Number(f.atMs) || 0, kind: f.liquidation ? 'liq' : 'fill', coin: String(f.coin), fill: f };
}

/* What the armed programs are doing, taken from the payload rather than from the log, because
   the log never sees a rule fire: the runner acts on the venue directly and the mandate row is
   where that shows up. Only armed mandates are read, so nothing here can duplicate the log's
   record of a program that has already stood down. */
function mandateEntries(p) {
  var list = (p && Array.isArray(p.mandates)) ? p.mandates : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (!m.armed) continue;
    var since = Date.parse(m.since);
    if (isFinite(since)) {
      out.push({
        at: since,
        kind: 'armed',
        coin: String(m.symbol),
        text: 'mandate ' + String(m.id) + ' armed: ' + usd(m.envelope ? m.envelope.maxNotionalUsd : null) +
          ' notional, ' + usd(m.envelope ? m.envelope.maxLossUsd : null) + ' loss allowed'
      });
    }
    if (m.lastRule) {
      var fired = Date.parse(m.lastRule.at);
      if (isFinite(fired)) {
        out.push({
          at: fired,
          kind: 'fired',
          coin: String(m.symbol),
          text: 'rule ' + String(m.lastRule.id) + ': ' + String(m.lastRule.action)
        });
      }
    }
    // A halt has no timestamp of its own, so it is stamped now and sorts to the top, which is
    // where a program that has stopped itself belongs anyway.
    if (m.haltedReason) {
      out.push({ at: Date.now(), kind: 'halted', coin: String(m.symbol), text: String(m.haltedReason), bad: true });
    }
  }
  return out;
}

function logEntries(events) {
  var kinds = tradeProposalKinds(events);
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var kind = historyKind(ev, kinds);
    if (!kind) continue;
    var at = Date.parse(ev.ts);
    out.push({
      at: isFinite(at) ? at : 0,
      kind: kind,
      coin: historyCoin(ev),
      // The app's own sentence, agent-authored or venue-authored, carried verbatim as text.
      text: String(ev.msg),
      bad: Boolean(REFUSAL_TYPES[ev.type]) || kind === 'failed'
    });
  }
  return out;
}

/* A fill row fills the numeric columns; every other event says what happened across them. Both
   share TIME, KIND and MARKET, so the tape is scanned down those three whatever each row is. */
function historyRow(entry, p) {
  var f = entry.fill;
  var tr = el('tr', f ? 'hrow' : 'hrow ev');
  if (f) {
    if (f.liquidation) tr.classList.add('liquidation');
    tr.dataset.tid = String(f.tid);
    markHighlight(tr, p, 'fill', f.tid);
  }
  if (entry.bad) tr.classList.add('bad');

  tr.appendChild(el('td', 'ts', clock(entry.at)));
  tr.appendChild(el('td', 'kind', entry.kind));
  tr.appendChild(el('td', 'sym', entry.coin ? entry.coin : '--'));

  if (!f) {
    var said = el('td', 'said', entry.text);
    said.colSpan = HISTORY_NUM_COLS;
    // A tape does not wrap, so a long sentence is cut and the whole of it rides the title,
    // which is an attribute holding text and never markup.
    said.title = entry.text;
    tr.appendChild(said);
    return tr;
  }

  var side = el('td', f.side === 'sell' ? 'side short' : 'side long', String(f.side));
  // The venue closing this for you is not the same event as you closing it, and the two must
  // never read alike. The KIND column already says `liq`, and the row is ringed besides.
  tr.appendChild(side);
  tr.appendChild(el('td', 'num', price(f.px)));
  tr.appendChild(el('td', 'num', amount(f.sizeCoin)));
  // Closed PnL is absent on an opening fill and on any fill the venue did not price, so it
  // stays unknown rather than becoming zero.
  tr.appendChild(el('td', 'num', signedUsd(f.closedPnlUsd)));
  return tr;
}

function renderHistory(p) {
  var rows = resetRows('t-history-rows', 't-history-empty');
  if (!rows) return;
  var d = p || {};
  var entries = [];
  var fills = Array.isArray(d.fills) ? d.fills : [];
  for (var i = 0; i < fills.length; i++) entries.push(fillEntry(fills[i]));
  entries = entries.concat(mandateEntries(p), logEntries(LOG_EVENTS));
  entries.sort(function (a, b) {
    return b.at - a.at;
  });
  if (entries.length > HISTORY_MAX_ROWS) entries.length = HISTORY_MAX_ROWS;
  for (var j = 0; j < entries.length; j++) rows.appendChild(historyRow(entries[j], p));

  var empty = $('t-history-empty');
  if (empty) {
    // Before anything has answered, an empty tape is not yet a fact about the account.
    empty.textContent = p ? 'Nothing yet. Fills, mandate events and refusals land here.' : 'Waiting for the venue.';
    empty.hidden = entries.length > 0;
  }
  if (!entries.length && !empty) rows.appendChild(spanRow(HISTORY_COLS, 'Nothing yet.', 'hrow note'));
}

/* The audit tail arrives whole on a refresh and one line at a time over SSE. Both land in the
   same store and redraw the same tape, so a line pushed while the page is open sorts into the
   sequence by its own timestamp instead of being stapled to the top of a different list.

   The store has a second reader now. The tape shows the trading slice of this list and drops
   the rest on purpose; the LOG overlay shows all of it, in the app's own log lines, and the
   two read from the one array so they can never disagree about what was recorded. */
function setLog(events) {
  LOG_EVENTS = Array.isArray(events) ? events.slice(0, LOG_MAX_LINES) : [];
  renderHistory(PAYLOAD);
  renderLogView();
}

function appendLog(event) {
  LOG_EVENTS.unshift(event);
  if (LOG_EVENTS.length > LOG_MAX_LINES) LOG_EVENTS.length = LOG_MAX_LINES;
  renderHistory(PAYLOAD);
  if (!LOG_VIEW) return;
  /* One line, prepended, rather than a rebuild of four hundred: the overlay is open in front
     of somebody who is reading it, and rebuilding the list under them would throw away their
     scroll position on every event the app records. */
  LOG_VIEW.insertBefore(PhosphorViews.logLine(event), LOG_VIEW.firstChild);
  while (LOG_VIEW.childElementCount > LOG_MAX_LINES) LOG_VIEW.removeChild(LOG_VIEW.lastChild);
}

/* The list element inside the open LOG overlay, or null. */
var LOG_VIEW = null;

function renderLogView() {
  if (!LOG_VIEW) return;
  LOG_VIEW.textContent = '';
  if (!LOG_EVENTS.length) {
    LOG_VIEW.appendChild(el('div', 'faint', 'nothing recorded yet'));
    return;
  }
  for (var i = 0; i < LOG_EVENTS.length; i++) LOG_VIEW.appendChild(PhosphorViews.logLine(LOG_EVENTS[i]));
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
  renderCollateral(p);
  renderMarket(p);
  renderMandates(p);
  renderBook(p);
  renderHistory(p);
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
    // Feed the presence light: seat state plus when the agent last did real work. Live
    // 'activity' pings keep it bright between state pushes; this seeds it on load.
    if (window.PhosphorPresence && POLICY.agents) {
      PhosphorPresence.setState(POLICY.agents.connected, POLICY.agents.lastActivityAt);
    }
    followViewMode(POLICY);
    renderKill(POLICY);
    renderGate(POLICY);
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

/* The other half of the one-word switch. ui/app.js sends the custody page here when the view
   becomes 'trade'; this sends it back when the view becomes anything else.

   Transition only, never on a first sighting, for the same reason as its sibling: a human who
   typed /trade while the app sat in pro must keep the page they asked for. LAST_SEEN_VIEW is
   null until the first state frame, so the first frame only records. */
var LAST_SEEN_VIEW = null;

function followViewMode(s) {
  if (!s || typeof s.view !== 'string') return;
  var view = s.view;
  if (view !== 'trade' && LAST_SEEN_VIEW !== null && LAST_SEEN_VIEW === 'trade') {
    LAST_SEEN_VIEW = view;
    /* Dressed by ui/transition.js, and it has to be the same fall the custody page uses on
       the way here or the round trip reads as two different products. Absent that file the
       navigation still happens, it just cuts. */
    var rain = window.PHOSPHOR_RAIN;
    if (rain) {
      rain.leave(function () {
        window.location.href = '/';
      });
    } else {
      window.location.href = '/';
    }
    return;
  }
  LAST_SEEN_VIEW = view;
}

/* The gate, drawn by ui/approvals.js from the same /api/state this page already reads for
   the kill switch. A trading screen is where the human already is, and sending them to the
   other window to click APPROVE is how a proposal sits unread while the market moves.
   The approval itself still needs the token, which is the same one every write here uses. */
function renderGate(s) {
  var box = $('t-gate');
  if (!box) return;
  APPROVALS.render(box, s, {
    postJson: postJson,
    token: function () { return TOKEN; },
    // An approved mandate arms, and an armed mandate is a row in the panel below this one,
    // so both surfaces are re-read rather than just the one that was clicked.
    onDecided: function () { return Promise.all([refreshState(), refreshTrade()]); },
  });
}

async function refreshLog() {
  try {
    setLog(await getJson('/api/log?limit=200'));
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
    // A tool call just happened: brighten the presence light now. It dulls itself when the
    // calls stop. Carries nothing, so there is nothing to refetch.
    else if (payload.type === 'activity') { if (window.PhosphorPresence) PhosphorPresence.note(); }
    else if (payload.type === 'log' && payload.event) appendLog(payload.event);
    // The in-app driver talking. Forwarded rather than handled here: the transcript is owned by
    // driver-chat.js, which is mounted on both the pro deck and the basic screen.
    else if (payload.type === 'driver' && payload.event) { if (window.PhosphorChat) PhosphorChat.push(payload.event); }
    // A gas receipt landed on the treasury ledger. The call is a no-op unless the HISTORY
    // overlay is open, which is where that decision belongs.
    else if (payload.type === 'transactions') PhosphorViews.transactionsRefresh();
    else if (payload.type === 'candles') candlesPushed();
    // A chart change from an agent. Our own writes come back with a revision we already know,
    // and chartPushed drops those rather than repainting over the hand.
    else if (payload.type === 'chart') chartPushed(payload.rev);
  });
  // There was a second listener here for a NAMED 'trade' event, described as a belt-and-braces
  // path in case the JSON body one stopped firing. It could never have fired: the server
  // writes bare `data:` frames with no `event:` field (src/server.ts sseSend), so every frame
  // arrives as 'message' and a named listener is unreachable. Removed rather than left in
  // place, because a fallback that cannot run is worse than none: it reads as covered.
}

/* ---------- the deck bar and its overlays ----------

   Three buttons above the deck, one modal behind them (ui/overlay.js), and the three views
   themselves in ui/deck-views.js so this window and the custody window cannot drift into
   showing different amounts of the same record.

   None of the three duplicates a panel on this page.
   - LOG is the app's WHOLE audit trail. The tape below carries the trading slice of it and
     drops everything else by design: a withdrawal is not a trade and has no business on a
     blotter. Read the log when the question is what the app did, not what this account did.
   - POLICY has never been on this screen at all. The status bar carries one word for it.
   - HISTORY is the treasury ledger: swaps, intents deposits, withdrawals. Different columns
     and a different ledger. It used to share no row at all with the tape, and now it shares
     exactly one kind: a Hyperliquid deposit is a movement of money, so it is a ledger row,
     AND it is the collateral this account trades on, so its proposal and its execution are
     on the tape too. The same event, read for two different questions. Everything else in
     the ledger still stops at the door, which is why the tape keeps its panel and its room,
     and why the panel is titled TAPE: two records cannot share one word on one screen. */

function openLogOverlay(trigger) {
  PhosphorOverlay.open({
    title: 'LOG',
    trigger: trigger,
    build: function (box) {
      box.appendChild(el('p', 'ovl-note', 'Everything this app recorded, newest first, not just this venue. Nothing here is shortened.'));
      LOG_VIEW = el('div', 'log');
      box.appendChild(LOG_VIEW);
      // Draw the tail already held, then read again: never empty while a fetch is in
      // flight, never stale once it lands.
      renderLogView();
      refreshLog();
    },
    onClose: function () {
      LOG_VIEW = null;
    }
  });
}

function openPolicyOverlay(trigger) {
  PhosphorOverlay.open({
    title: 'POLICY',
    trigger: trigger,
    build: function (box) {
      PhosphorViews.policy(box, POLICY);
    }
  });
}

function openHistoryOverlay(trigger) {
  PhosphorOverlay.open({
    title: 'HISTORY',
    trigger: trigger,
    build: function (box) {
      box.appendChild(el('p', 'ovl-note', 'The treasury ledger: swaps, intents deposits and withdrawals. Trades are on the TAPE panel, and a Hyperliquid deposit is on both.'));
      PhosphorViews.transactions(box, alertLine);
    },
    onClose: PhosphorViews.transactionsClosed
  });
}

function wireDeckBar() {
  var buttons = [
    { id: 'open-log', open: openLogOverlay },
    { id: 'open-policy', open: openPolicyOverlay },
    { id: 'open-history', open: openHistoryOverlay }
  ];
  for (var i = 0; i < buttons.length; i++) {
    (function (spec) {
      var btn = $(spec.id);
      if (!btn) return;
      btn.addEventListener('click', function () {
        spec.open(btn);
      });
    })(buttons[i]);
  }
}

/* The agent panel, under the book. driver-chat.js owns everything inside it, including the
   rule that it never renders an approval: the gate is one column over.

   Every fact in the intro is a true statement about the agent being started, checked against
   operator/driver.settings.json and against the runtime check in src/driver.ts: the deny list
   there takes Bash, Read, Write, WebFetch and WebSearch away, and assertSurface kills the
   session if the tool list the child announces holds anything outside mcp__phosphor__. It is
   a boot print, not a loading animation, so what it says has to keep being true.

   THE SHAPE CHANGED AND THE CONTENT DID NOT. The three facts below are the three lines this
   used to print, as label and value: driver-chat.js draws them as one card whose values sit
   beside their labels on a wide panel and under them on a narrow one, which is the only way a
   print like this survives a column a person can drag. "web of its own" is precise and is not
   padding: the agent holds no WebFetch and no WebSearch, and phosphor's own research tool,
   which does leave this machine, announces itself as "reading the news" when it runs. */
var AGENT_INTRO = {
  mark: 'PHOSPHOR',
  title: 'AGENT LINK',
  facts: [
    { label: 'proc', value: 'a local agent, spawned under this window' },
    { label: 'tools', value: 'phosphor only, checked on connect' },
    { label: 'denied', value: 'shell, files, web of its own' },
  ],
};

function mountChat() {
  if (!window.PhosphorChat) return;
  PhosphorChat.mount($('agent-chat'), {
    intro: AGENT_INTRO,
    /* The character fall, the same one every other change on this surface runs through.
       ui/basic.css states why the calm screen is handed 'fade' instead. */
    veil: 'rain',
    /* The oscilloscope trace out of the badge, the same as the pro deck. This window is a
       terminal all the way down; the calm screen is the one that does not ask for a scope. */
    trace: true,
    colorVar: '--green',
    startLabel: 'START THE AGENT',
    idleNote: 'no agent is running',
    stopLabel: 'STOP AGENT',
    stopQuestion: 'stop the agent? the conversation is lost.',
    stopYes: 'YES, STOP',
    stopNo: 'CANCEL',
    jumpLabel: 'LATEST',
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
  /* A splitter drag resizes two panels without resizing the window, and the frames are box
     drawing measured in characters: they have to be redrawn on the frame the boundary moved,
     not 120ms after it stops. ui/split.js fires this once per animation frame while a handle
     is moving, and a plain resize once on release. */
  window.addEventListener('phosphor:split', layoutFrames);

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
  /* Before applyCollapse, and the order matters: a panel's height depends on how wide its
     column is, so the columns are restored to what a person left them at before anything
     measures a panel. Guarded because a missing splitter is a deck that cannot be resized,
     not a deck that fails to draw. */
  if (window.splitBoot) window.splitBoot();
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
  wireDeckBar();
  mountChat();
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
  // The transcript and the driver's own state, once. Everything after this arrives on the
  // event stream and is pushed into the chat by openEvents() below.
  if (window.PhosphorChat) PhosphorChat.load();
  openEvents();
  // The chart owns its own fetch loop and its own timers; see ui/chart.js.
  chartBoot();
}

boot();
