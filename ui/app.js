/* PHOSPHOR one-page client. Plain browser JS, no imports, no framework.
   Every dynamic string reaches the DOM through textContent. Audit lines, policy
   sentences and proposal summaries carry agent-authored text verbatim by design,
   so innerHTML is never used anywhere in this file. */

'use strict';

var REFUSAL_TYPES = { policy_refused: 1, refused: 1, approve_attempt_rejected: 1 };
var EPS = 1e-9;
var CANDLE_POLL_MS = 20000;
var GRANULARITY_SEC = 60;
var CANDLE_LIMIT = 120;
var LOG_MAX_LINES = 400;

var TOKEN = null;
var STATE = null;
var CANDLES = [];
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
    if (title) {
      var head = '┌─ ' + title + ' ';
      frame.textContent = head + repeat('─', Math.max(1, cols - head.length - 1)) + '┐';
    } else {
      frame.textContent = '└' + repeat('─', Math.max(1, cols - 2)) + '┘';
    }
  }
}

function repeat(ch, n) {
  var out = '';
  for (var i = 0; i < n; i++) out += ch;
  return out;
}

/* ---------- 1. status ---------- */

function renderStatus(s) {
  var stableUsd = s.composition ? s.composition.totalUsd : 0;
  var gasUsd = 0;
  var holdings = (s.ledger && s.ledger.holdings) || [];
  for (var i = 0; i < holdings.length; i++) {
    if (holdings[i].native) gasUsd += holdings[i].usd;
  }
  $('stat-total').textContent = usd(stableUsd);
  $('stat-gas').textContent = '+' + usdWhole(gasUsd) + ' gas';

  var connected = (s.agents && s.agents.connected) || 0;
  var agentNode = $('stat-agent');
  agentNode.textContent = connected === 0 ? 'none' : connected === 1 ? 'connected' : connected + ' connected';
  agentNode.className = connected === 0 ? 'v faint' : 'v';

  $('stat-mode').textContent = s.mode || '--';

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

/* ---------- 2. composition ---------- */

function issuerCap(policy, issuer) {
  if (!policy) return 1;
  var caps = policy.composition.maxIssuerShare || {};
  if (typeof caps[issuer] === 'number') return caps[issuer];
  if (typeof caps.default === 'number') return caps.default;
  return 1;
}

function renderComposition(s) {
  var comp = s.composition || { rows: [], byIssuer: {}, totalUsd: 0, freezableShare: 0, unclassified: [] };
  var freezeCap = s.policy ? s.policy.composition.maxFreezableShare : 1;
  var freezeBreach = comp.freezableShare > freezeCap + EPS;

  var tbody = $('comp-rows');
  tbody.textContent = '';
  for (var i = 0; i < comp.rows.length; i++) {
    var row = comp.rows[i];
    var issuerBreach = (comp.byIssuer[row.issuer] || 0) > issuerCap(s.policy, row.issuer) + EPS;
    var tr = document.createElement('tr');
    tr.appendChild(el('td', row.classified ? null : 'unclassified', row.issuer));
    tr.appendChild(el('td', null, row.chain));
    tr.appendChild(el('td', null, row.symbol));
    tr.appendChild(el('td', 'num', amount(row.amount)));
    tr.appendChild(el('td', 'num', usd(row.usd)));
    // The share cell is where a policy violation becomes visible.
    var breach = issuerBreach || (row.freezable && freezeBreach);
    tr.appendChild(el('td', breach ? 'num share breach' : 'num share', pct(row.share)));
    tr.appendChild(el('td', row.freezable ? 'frz' : 'frz off', row.freezable ? 'FRZ' : '-'));
    tbody.appendChild(tr);
  }

  var totals = $('comp-total');
  totals.textContent = '';
  totals.appendChild(el('span', null, 'TOTAL ' + usd(comp.totalUsd) + '   freezable '));
  totals.appendChild(el('span', freezeBreach ? 'red' : null, pct(comp.freezableShare)));
  if (freezeBreach) totals.appendChild(el('span', 'red', ' over cap ' + pct(freezeCap)));
  if (comp.unclassified && comp.unclassified.length) {
    totals.appendChild(el('span', 'faint', '   unclassified: ' + comp.unclassified.join(', ')));
  }
}

/* ---------- 3. cost ---------- */

function renderCost(s) {
  var cost = s.cost || { totalUsd: 0, lines: [] };
  $('cost-total').textContent = usd(cost.totalUsd);
  var box = $('cost-lines');
  box.textContent = '';
  for (var i = 0; i < cost.lines.length; i++) {
    var line = cost.lines[i];
    var row = el('div', 'costline');
    row.appendChild(el('span', 'label', line.label));
    row.appendChild(el('span', 'fill', repeat('.', 160)));
    row.appendChild(el('span', 'usd', line.usd === null ? 'n/a' : usd(line.usd)));
    box.appendChild(row);
    if (line.note) box.appendChild(el('div', 'costnote', line.note));
  }
}

/* ---------- 4. chart ---------- */

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

function setChartMeta(source, count, fetchedAt, stale, error) {
  var meta = $('chart-meta');
  meta.textContent = '';
  if (error) {
    meta.appendChild(el('span', 'faint', 'no candle data: ' + error));
    return;
  }
  meta.appendChild(el('span', 'faint', source + '  ' + GRANULARITY_SEC + 's  ' + count + ' candles  ' + clock(fetchedAt)));
  if (stale) meta.appendChild(el('span', 'hi', '   STALE: source unreachable, showing last known'));
}

async function refreshCandles() {
  var product = $('product').value;
  if (!product) return;
  var url = '/api/candles?product=' + encodeURIComponent(product) +
    '&granularity=' + GRANULARITY_SEC + '&limit=' + CANDLE_LIMIT;
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
    CANDLES = await res.json();
    setChartMeta(
      res.headers.get('x-candle-source') || 'unknown',
      CANDLES.length,
      res.headers.get('x-candle-fetched-at') || '',
      res.headers.get('x-candle-stale') === 'true',
      null
    );
    drawChart();
  } catch (err) {
    CANDLES = [];
    drawChart();
    setChartMeta(null, 0, '', true, err.message || String(err));
  }
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

  var green = '#33ff66';
  var dim = 'rgba(51,255,102,0.45)';
  var faint = 'rgba(51,255,102,0.30)';

  if (!CANDLES.length) {
    ctx.fillStyle = faint;
    ctx.fillText('no candle data', 0, 14);
    return;
  }

  var padRight = 70;
  var padBottom = 14;
  var padTop = 4;
  var plotWidth = Math.max(10, width - padRight);
  var plotHeight = Math.max(10, height - padBottom - padTop);

  var low = Infinity;
  var high = -Infinity;
  for (var i = 0; i < CANDLES.length; i++) {
    if (CANDLES[i].l < low) low = CANDLES[i].l;
    if (CANDLES[i].h > high) high = CANDLES[i].h;
  }
  if (!(high > low)) {
    high = low + Math.max(1, Math.abs(low) * 0.001);
  }
  var span = high - low;

  function yOf(value) {
    return padTop + ((high - value) / span) * plotHeight;
  }

  var slot = plotWidth / CANDLES.length;
  var bodyWidth = Math.max(1, Math.floor(slot * 0.62));

  for (var j = 0; j < CANDLES.length; j++) {
    var candle = CANDLES[j];
    var centre = Math.round(j * slot + slot / 2) + 0.5;
    var up = candle.c >= candle.o;
    ctx.strokeStyle = up ? green : dim;
    ctx.fillStyle = green;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(centre, yOf(candle.h));
    ctx.lineTo(centre, yOf(candle.l));
    ctx.stroke();

    var top = Math.min(yOf(candle.o), yOf(candle.c));
    var bodyHeight = Math.max(1, Math.abs(yOf(candle.c) - yOf(candle.o)));
    var left = Math.round(centre - bodyWidth / 2) + 0.5;
    // Up solid, down hollow: one hue, direction carried by fill and brightness.
    if (up) ctx.fillRect(left, top, bodyWidth, bodyHeight);
    else ctx.strokeRect(left, top, bodyWidth, bodyHeight);
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
  var marks = [0, Math.floor(CANDLES.length / 2), CANDLES.length - 1];
  for (var m = 0; m < marks.length; m++) {
    var index = marks[m];
    if (index < 0 || index >= CANDLES.length) continue;
    var x = Math.round(index * slot + slot / 2) + 0.5;
    ctx.strokeStyle = faint;
    ctx.beginPath();
    ctx.moveTo(x, padTop + plotHeight);
    ctx.lineTo(x, padTop + plotHeight + 3);
    ctx.stroke();
    ctx.fillStyle = dim;
    ctx.textAlign = m === 0 ? 'left' : m === marks.length - 1 ? 'right' : 'center';
    ctx.fillText(clock(CANDLES[index].t * 1000).slice(0, 5), x, padTop + plotHeight + 9);
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

function renderGate(s) {
  var box = $('gate');
  box.textContent = '';
  var pending = [];
  var proposals = s.proposals || [];
  for (var i = 0; i < proposals.length; i++) {
    if (proposals[i].status === 'pending') pending.push(proposals[i]);
  }
  if (!pending.length) {
    box.appendChild(el('div', 'gate-empty', 'no pending approvals'));
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
    renderStatus(STATE);
    renderComposition(STATE);
    renderCost(STATE);
    renderProducts(STATE);
    renderPolicy(STATE);
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

function wireResize() {
  var timer = null;
  window.addEventListener('resize', function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      layoutFrames();
      drawChart();
    }, 120);
  });
}

async function boot() {
  layoutFrames();
  wireKill();
  wireProduct();
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
  setInterval(refreshCandles, CANDLE_POLL_MS);
}

boot();
