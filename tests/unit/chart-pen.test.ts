// chart_draw, chart_layout and the drawing store under attack: what someone who wants the money
// or wants the human to click on a lie would send. Every case is one attack: what was sent, and
// what the code must answer. The ones the code already held are kept beside the ones it did
// not, so the next reader sees what was tried and not only what was fixed.
//
// The one that mattered for money: drawing ids were minted per chart, so a line drawn on a
// comparison chart was `tl_1` exactly like the primary's, and the watcher resolves a plan's
// `{ line: 'tl_1' }` on the primary only. A plan waiting on the comparison chart's line would
// have fired on the primary's, at a different price, without anything saying so. Beside it: a
// clear, a product switch or the drawing cap could take the line a waiting plan is anchored to,
// which left a plan the human approved that could never fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { bootChartServer } from '../fixtures/chart-server.ts';
import { createDrawingStore, DRAWINGS_PER_MARKET } from '../../src/drawings.ts';
import { LIMITS } from '../../src/chart.ts';

const T0 = 1_760_000_000;
const LINE_ID = /^tl_\d+$/;

// A request with a body no JSON client can build, sent by hand.
function raw(urlBase: string, route: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  const u = new URL(urlBase + route);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function draw(h: Awaited<ReturnType<typeof bootChartServer>>, args: unknown, session = 'a') {
  return h.mcp({ op: 'view', tool: 'chart_draw', session, args });
}

// ---------- chart_layout ----------

test('chart_layout: none, five, garbage entries, a product of ten thousand characters and a timeframe of a thousand days are refused, and nothing moves', async () => {
  const h = await bootChartServer();
  try {
    const layout = (charts: unknown) => h.mcp({ op: 'view', tool: 'chart_layout', session: 'a', args: { charts } });
    const one = { product: 'BTC-USD', timeframe: '1h' };
    for (const [name, charts, why] of [
      ['none', [], /1 to 4/],
      ['five', Array.from({ length: 5 }, () => one), /1 to 4/],
      ['not a list', 'BTC-USD', /1 to 4/],
      ['numbers', [1, 2], /1 to 4/],
      ['empty entry', [{}], /needs a product/],
      ['no product', [{ timeframe: '1h' }], /needs a product/],
      // Over a kilobyte the agent door refuses the string by its path before the tool sees it
      // (src/http/mcp.ts); under it, the tool refuses the product by name.
      ['ten thousand characters', [{ product: 'A'.repeat(10_000), timeframe: '1h' }], /charts\[0\]\.product is 10000 characters, over the 1024/],
      ['a thousand characters', [{ product: 'A'.repeat(1_000), timeframe: '1h' }], /no market listed/],
      ['a thousand days', [{ product: 'BTC-USD', timeframe: '1000d' }], /not a timeframe/],
      ['a second', [one, { product: 'ETH-USD', timeframe: '1s' }], /not a timeframe/],
    ] as [string, unknown, RegExp][]) {
      const started = Date.now();
      const out = await layout(charts);
      assert.equal(out.status, 400, `${name}: ${JSON.stringify(out.json).slice(0, 120)}`);
      assert.match(String(out.json.error), why, name);
      assert.ok(Date.now() - started < 2000, `${name} answered in time`);
    }
    const state = await h.get('/api/chart');
    assert.equal(state.json.view.product, 'BTC-USD');
    assert.equal(state.json.view.granularitySec, 60, 'the primary never moved');
    assert.equal((await h.get('/api/chart?slot=1')).status, 404);
  } finally {
    await h.close();
  }
});

test('chart_layout: the same product four times is four charts on four stores, and a drawing lands on one of them only', async () => {
  const h = await bootChartServer();
  try {
    const one = { product: 'btc', timeframe: '1h' };
    const out = await h.mcp({ op: 'view', tool: 'chart_layout', session: 'a', args: { charts: [one, one, one, one] } });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.charts.length, 4);
    assert.ok(out.json.charts.every((c: { product: string }) => c.product === 'BTC-USD'));
    const drawn = await draw(h, { chart: 2, levels: [{ px: 5 }], zones: [{ p1: 1, p2: 2 }] });
    assert.equal(drawn.status, 200);
    for (const slot of [0, 1, 3]) {
      const other = await h.get(`/api/chart?slot=${slot}`);
      assert.equal(other.json.levels.length, 0, `slot ${slot} has no level`);
      assert.equal(other.json.drawings.length, 0, `slot ${slot} has no zone`);
    }
    const two = await h.get('/api/chart?slot=2');
    assert.equal(two.json.levels.length, 1);
    assert.equal(two.json.drawings.length, 1);
  } finally {
    await h.close();
  }
});

test('drawing ids never collide across charts, so a plan can only ever name a line on the primary', async () => {
  const h = await bootChartServer();
  try {
    await h.mcp({ op: 'view', tool: 'chart_layout', session: 'a', args: { charts: [{ product: 'BTC-USD', timeframe: '1h' }, { product: 'ETH-USD', timeframe: '4h' }] } });
    const line = { t1: T0, p1: 1, t2: T0 + 3600, p2: 2 };
    await draw(h, { chart: 1, lines: [line], zones: [{ p1: 1, p2: 2 }] });
    await draw(h, { chart: 0, lines: [line] });
    const primary = (await h.get('/api/chart?slot=0')).json.drawings as { id: string }[];
    const compare = (await h.get('/api/chart?slot=1')).json.drawings as { id: string }[];
    assert.equal(primary.length, 1);
    assert.equal(compare.length, 2);
    const primaryLine = primary[0]?.id ?? '';
    assert.match(primaryLine, LINE_ID, 'the primary mints the ids a plan may name');
    for (const d of compare) {
      assert.notEqual(d.id, primaryLine);
      assert.doesNotMatch(d.id, LINE_ID, `${d.id} on a comparison chart is not a shape a plan can name`);
      // Stripping the chart off the id must not land on a primary id either: the numbers are
      // minted once across every chart, so `tl_1` exists in exactly one place.
      const stripped = d.id.replace(/^c\d+_/, '');
      assert.ok(!primary.some((p) => p.id === stripped), `${stripped} would be a second ${d.id}`);
    }
    // And the store holds the rule on its own, with no server around it.
    const counters: Record<string, number> = {};
    const zero = createDrawingStore({ counters });
    const one = createDrawingStore({ counters, prefix: 'c1_' });
    const a = zero.add({ kind: 'trendline', label: 'a', source: 'agent', line: { a: { t: 0, price: 1 }, b: { t: 1, price: 2 } } });
    const b = one.add({ kind: 'trendline', label: 'b', source: 'agent', line: { a: { t: 0, price: 1 }, b: { t: 1, price: 2 } } });
    assert.equal(a.id, 'tl_1');
    assert.equal(b.id, 'c1_tl_2');
  } finally {
    await h.close();
  }
});

// ---------- chart_draw ----------

test('chart_draw: ten thousand levels, a 100 KB label and two hundred indicators land at the caps and the answer stays small', async () => {
  const h = await bootChartServer();
  try {
    const levels = Array.from({ length: 10_000 }, (_, i) => ({ px: i + 1 }));
    const flood = await draw(h, { levels });
    assert.equal(flood.status, 200);
    assert.equal(flood.json.counts.levels, LIMITS.maxLevels);
    const refused: string[] = flood.json.refused;
    assert.ok(refused.length <= 25, `${refused.length} refusal lines for one cap`);
    assert.ok(refused.some((r) => /24 price levels/.test(r) && /x9976/.test(r)), JSON.stringify(refused).slice(0, 200));
    assert.ok(JSON.stringify(flood.json).length < 4096, `the digest is ${JSON.stringify(flood.json).length} bytes`);

    // A 100 KB label never reaches the pen: the agent door refuses any string over a kilobyte
    // by its path (src/http/mcp.ts). A kilobyte one does, and the pen cuts it at 48.
    const refusedLabel = await draw(h, { clear: 'mine', levels: [{ px: 7, label: 'L'.repeat(100_000) }] });
    assert.equal(refusedLabel.status, 400);
    assert.match(String(refusedLabel.json.error), /levels\[0\]\.label is 100000 characters, over the 1024/);
    const label = 'L'.repeat(1_000);
    const labelled = await draw(h, { clear: 'mine', levels: [{ px: 7, label }], zones: [{ p1: 1, p2: 2, label }] });
    assert.equal(labelled.status, 200);
    const payload = await h.get('/api/chart');
    assert.ok(payload.json.levels[0].label.length <= 8 + 48, 'a level label is cut at 48');
    assert.ok(payload.json.drawings[0].label.length <= 8 + 48, 'a zone label is cut at 48');
    assert.ok(payload.json.levels[0].label.startsWith('[agent] '), 'and the tag survives');

    const emas = Array.from({ length: 200 }, (_, i) => ({ type: 'ema', params: { period: i + 2 } }));
    const many = await draw(h, { indicators: { set: emas } });
    assert.equal(many.status, 200);
    assert.equal(many.json.indicators.length, LIMITS.maxOverlays);
    assert.ok(many.json.refused.length <= 25, `${many.json.refused.length} refusal lines`);
    assert.ok(JSON.stringify(many.json).length < 4096, `the digest is ${JSON.stringify(many.json).length} bytes`);

    const same = await draw(h, { indicators: { set: Array.from({ length: 200 }, () => ({ type: 'rsi' })) } });
    assert.equal(same.json.indicators.length, 1);
    assert.ok((same.json.notes ?? []).length <= 25, `${(same.json.notes ?? []).length} note lines for one repeated study`);
  } finally {
    await h.close();
  }
});

test('chart_draw: NaN, Infinity, strings and nulls in a price or a time are refused by name and nothing is drawn', async () => {
  const h = await bootChartServer();
  try {
    const out = await draw(h, {
      levels: [{ px: 'NaN' }, { px: null }, { px: '100' }],
      marks: [{ t: 'now' }],
      zones: [{ p1: 'NaN', p2: 1 }, { p1: null, p2: 1 }],
      lines: [{ t1: T0, p1: 1, t2: T0 + 60, p2: 'x' }, { t1: T0, p1: 1, t2: T0, p2: 2 }],
    });
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.counts, { levels: 0, marks: 0, lines: 0, zones: 0, plans: 0 });
    for (const why of [/level needs px/, /mark needs t/, /zone needs p1 and p2/, /line needs t1, p1, t2 and p2/, /two different times/]) {
      assert.ok(out.json.refused.some((r: string) => why.test(r)), `${why}: ${JSON.stringify(out.json.refused)}`);
    }
    // 1e999 is not a JSON number a client can build, so it goes down the wire by hand.
    const body = JSON.stringify({ op: 'view', tool: 'chart_draw', session: 'a', secret: h.seat, args: { zones: [{ p1: 1, p2: 2 }], levels: [{ px: 1 }] } })
      .replace('"p1":1', '"p1":1e999')
      .replace('"px":1', '"px":-1e999');
    const inf = await raw(h.url, '/api/mcp', { 'content-type': 'application/json', origin: h.url }, body);
    assert.equal(inf.status, 200);
    const parsed = JSON.parse(inf.body);
    assert.deepEqual(parsed.counts, { levels: 0, marks: 0, lines: 0, zones: 0, plans: 0 }, 'an infinity is not a price');
  } finally {
    await h.close();
  }
});

test('chart_draw: custom:../../x, an empty slug, a slash, a prototype name and a 33 character slug are refused by name', async () => {
  const h = await bootChartServer();
  try {
    const types = ['custom:../../x', 'custom:', 'CUSTOM:../X', 'custom:a/b', 'custom:a b', `custom:${'a'.repeat(33)}`, '__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const out = await draw(h, { indicators: { add: types.map((type) => ({ type })) } });
    assert.equal(out.status, 200);
    assert.equal(out.json.indicators.length, 0);
    for (const type of types) {
      assert.ok(out.json.refused.some((r: string) => r.startsWith(`unknown indicator: ${type.toLowerCase()}`)), `${type}: ${JSON.stringify(out.json.refused)}`);
    }
  } finally {
    await h.close();
  }
});

test('chart_draw: a chart index outside the four is refused by name, and one inside that no layout filled names the tool', async () => {
  const h = await bootChartServer();
  try {
    for (const chart of [-1, 4, 1.5, 'x', '2abc']) {
      const out = await draw(h, { chart, levels: [{ px: 1 }] });
      assert.equal(out.status, 400, String(chart));
      assert.match(String(out.json.error), /chart must be 0 to 3/);
    }
    const empty = await draw(h, { chart: 1, levels: [{ px: 1 }] });
    assert.equal(empty.status, 400);
    assert.match(String(empty.json.error), /chart_layout/);
    assert.equal((await h.get('/api/chart')).json.levels.length, 0, 'none of it reached the primary');
  } finally {
    await h.close();
  }
});

test('chart_draw: clear leaves a line a waiting plan is anchored to and names the plan; an idea holds nothing', async () => {
  const h = await bootChartServer();
  try {
    const line = { t1: T0, p1: 1, t2: T0 + 3600, p2: 2 };
    await draw(h, { lines: [line, line], zones: [{ p1: 1, p2: 2 }] });
    h.setPlans([
      { id: 'pl_1', symbol: 'BTC', status: 'waiting', when: [{ type: 'close', tf: '1h', is: 'above', at: { line: 'tl_1' } }] },
      { id: 'pl_2', symbol: 'BTC', status: 'idea', when: [{ type: 'close', tf: '1h', is: 'above', at: { line: 'tl_2' } }] },
    ]);
    const out = await draw(h, { clear: 'all' });
    assert.equal(out.status, 200);
    const left = (await h.get('/api/chart')).json.drawings as { id: string }[];
    assert.deepEqual(left.map((d) => d.id), ['tl_1'], 'the held line stays, the idea\'s line and the zone go');
    assert.ok(out.json.refused.some((r: string) => /pl_1/.test(r) && /tl_1/.test(r)), JSON.stringify(out.json.refused));
    assert.equal(out.json.counts.lines, 1);
    // 'mine' by the session that drew it: same answer.
    const mine = await draw(h, { clear: 'mine' });
    assert.equal((await h.get('/api/chart')).json.drawings.length, 1);
    assert.ok(mine.json.refused.some((r: string) => /pl_1/.test(r)));
    // Once the plan has fired the venue holds its orders and the line is the agent's again.
    h.setPlans([{ id: 'pl_1', symbol: 'BTC', status: 'placed', when: [{ type: 'close', tf: '1h', is: 'above', at: { line: 'tl_1' } }] }]);
    const after = await draw(h, { clear: 'mine' });
    assert.ok(!after.json.refused.some((r: string) => /tl_1/.test(r)), JSON.stringify(after.json.refused));
    assert.ok(after.json.refused.some((r: string) => /pl_1 is placed/.test(r)), 'the plan itself is still named as left alone');
    assert.equal((await h.get('/api/chart')).json.drawings.length, 0);
  } finally {
    await h.close();
  }
});

test('chart_draw: a product switch and a layout keep every drawing with its market, and the cap leaves a held line alone', async () => {
  const h = await bootChartServer();
  try {
    const line = { t1: T0, p1: 1, t2: T0 + 3600, p2: 2 };
    await draw(h, { lines: [line], zones: [{ p1: 1, p2: 2 }] });
    h.setPlans([{ id: 'pl_1', symbol: 'BTC', status: 'waiting', when: [{ type: 'close', tf: '1h', is: 'above', at: { line: 'tl_1' } }] }]);
    const onScreen = async (): Promise<string[]> => (await h.get('/api/chart')).json.drawings.map((d: { id: string }) => d.id);

    const moved = await draw(h, { view: { product: 'eth' } });
    assert.equal(moved.json.product, 'ETH-USD');
    assert.deepEqual(await onScreen(), [], "Bitcoin's line and zone are not drawn on Ethereum");
    assert.ok((moved.json.notes ?? []).some((n: string) => /2 lines and zones stay with BTC-USD/.test(n)), JSON.stringify(moved.json.notes));

    const layout = await h.mcp({ op: 'view', tool: 'chart_layout', session: 'a', args: { charts: [{ product: 'sol', timeframe: '1h' }] } });
    assert.equal(layout.status, 200);
    assert.deepEqual(await onScreen(), []);

    // A flood on another market takes nothing from this one.
    const zones = Array.from({ length: DRAWINGS_PER_MARKET + 20 }, (_, i) => ({ p1: i + 1, p2: i + 2 }));
    assert.equal((await draw(h, { zones })).status, 200);
    assert.equal((await onScreen()).length, DRAWINGS_PER_MARKET, 'the per-market cap holds');
    await h.mcp({ op: 'view', tool: 'chart_layout', session: 'a', args: { charts: [{ product: 'btc', timeframe: '1h' }] } });
    assert.deepEqual(await onScreen(), ['tl_1', 'zn_1'], 'back on Bitcoin, both are where they were');

    // A flood on this market evicts the oldest agent drawing that no plan holds.
    assert.equal((await draw(h, { zones })).status, 200);
    const here = await onScreen();
    assert.equal(here.length, DRAWINGS_PER_MARKET);
    assert.ok(here.includes('tl_1'), 'the held line stays');
    assert.ok(!here.includes('zn_1'), 'the zone nobody holds was the oldest');
  } finally {
    await h.close();
  }
});

test('chart_draw: a session id longer than the roster keeps is one agent to both stores', async () => {
  const h = await bootChartServer();
  try {
    const session = 'x'.repeat(100);
    await draw(h, { levels: [{ px: 1 }], zones: [{ p1: 1, p2: 2 }] }, session);
    const out = await draw(h, { clear: 'mine' }, session);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.refused, []);
    assert.deepEqual(out.json.counts, { levels: 0, marks: 0, lines: 0, zones: 0, plans: 0 }, 'both the level and the zone were this agent\'s');
  } finally {
    await h.close();
  }
});
