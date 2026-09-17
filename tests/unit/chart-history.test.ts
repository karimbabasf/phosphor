// History behind the left edge: the window pans as far back as the venue goes, in pages, and
// the chart says where the venue's history begins rather than pretending the pan hit a wall.
//
// The old shape served "the newest N bars" and clamped the pan at four hundred: a drag to the
// left ran off the array and printed "history ends at N bars" about a venue that had years more.
// These pin the two doors that replace it: /api/candles?before= for the window's own backfill,
// and the chart payload following a view panned deep, with the venue's floor on both.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';
import { LIMITS } from '../../src/chart.ts';

type Bar = { t: number };

function assertContiguous(bars: Bar[], stepSec: number): void {
  const seen = new Set<number>();
  for (let i = 0; i < bars.length; i++) {
    const t = (bars[i] as Bar).t;
    assert.ok(!seen.has(t), `no duplicate open time at ${t}`);
    seen.add(t);
    if (i > 0) assert.equal(t - (bars[i - 1] as Bar).t, stepSec, `bar ${i} follows bar ${i - 1} with no gap`);
  }
}

test('panning three thousand bars back receives the older windows in pages, with no duplicate open time', async () => {
  const h = await bootChartServer();
  try {
    // The render path never waits on a venue; the agent's read does, and warms the cache.
    await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: {} });
    const first = await h.get('/api/chart');
    assert.equal(first.status, 200);
    const held: Bar[] = first.json.candles;
    assert.ok(held.length >= 120, `the first payload holds the window, got ${held.length}`);

    // The window's own backfill: the bars before the oldest it holds, a page at a time, until
    // it has three thousand more than it started with.
    let oldest = (held[0] as Bar).t;
    let all: Bar[] = held.slice();
    while (all.length < held.length + 3000) {
      const res = await fetch(`${h.url}/api/candles?product=BTC-USD&granularity=60&before=${oldest}&limit=2000`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-candle-exhausted-back'), 'false', 'the synthetic venue is bottomless');
      const page = (await res.json()) as Bar[];
      assert.equal(page.length, 2000, 'a full page');
      assert.ok((page[page.length - 1] as Bar).t < oldest, 'every bar is older than the one asked before');
      all = page.concat(all);
      oldest = (page[0] as Bar).t;
    }
    assertContiguous(all, 60);
    assert.ok(all.length >= 3120);

    // The venue was asked behind the oldest bar, never for the newest window again.
    const behind = h.fetches().filter((f) => f.endSec !== null);
    assert.ok(behind.length >= 2, `the backfill pages reached the venue: ${JSON.stringify(h.fetches().map((f) => [f.bars, f.endSec]))}`);
    for (const f of behind) assert.ok((f.endSec as number) < (held[0] as Bar).t);
  } finally {
    await h.close();
  }
});

test('the chart payload follows a view panned deep, and an agent read waits for the history it needs', async () => {
  const h = await bootChartServer();
  try {
    await h.get('/api/chart');
    const moved = await h.post('/api/chart', { token: h.token, view: { panOffset: 3000 } });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal(moved.json.view.panOffset, 3000, 'the pan is not clamped at four hundred any more');

    // The agent's read waits for the fill behind the pan rather than answering with the one bar
    // left under the window.
    const read = await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: { full: true } });
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.ok(read.json.data.barsLoaded >= 3120, `the series covers the pan: ${read.json.data.barsLoaded}`);
    assert.equal(read.json.window.barsShown, 120);
    assert.equal(read.json.window.barsBackFromNewest, 3000);

    const payload = await h.get('/api/chart');
    assert.ok(payload.json.series.count >= 3120, `the payload serves the window the view shows: ${payload.json.series.count}`);
    assertContiguous(payload.json.candles, 60);
    assert.equal(payload.json.limits.barCountMax, 20000);
    assert.equal(payload.json.limits.panMax, LIMITS.panMax);
    assert.equal(payload.json.meta.exhaustedBack, false);
  } finally {
    await h.close();
  }
});

test('a venue with a floor says so: the backfill answers short and marks the history exhausted, and the payload carries where it begins', async () => {
  // Six hundred minutes of history in all.
  const oldestSec = Math.floor(Date.now() / 1000 / 60) * 60 - 599 * 60;
  const h = await bootChartServer({ oldestSec });
  try {
    await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: {} });
    const first = await h.get('/api/chart');
    const held: Bar[] = first.json.candles;
    const res = await fetch(`${h.url}/api/candles?product=BTC-USD&granularity=60&before=${(held[0] as Bar).t}&limit=2000`);
    assert.equal(res.status, 200);
    const page = (await res.json()) as Bar[];
    assert.ok(page.length < 2000 && page.length > 0, `the venue ran out: ${page.length} bars`);
    assert.equal((page[0] as Bar).t, oldestSec, 'the first bar the venue has');
    assert.equal(res.headers.get('x-candle-exhausted-back'), 'true');
    assert.equal(res.headers.get('x-candle-oldest'), String(oldestSec));

    // Asked again, the store knows and the venue is not.
    const calls = h.fetches().length;
    const again = await fetch(`${h.url}/api/candles?product=BTC-USD&granularity=60&before=${oldestSec}&limit=2000`);
    assert.deepEqual(await again.json(), []);
    assert.equal(again.headers.get('x-candle-exhausted-back'), 'true');
    assert.equal(h.fetches().length, calls, 'a venue that said it has no more is not asked again');

    const payload = await h.get('/api/chart');
    assert.equal(payload.json.meta.exhaustedBack, true);
    assert.equal(payload.json.meta.oldest, oldestSec);
  } finally {
    await h.close();
  }
});

test('before must be a time, and the route still serves the newest window without it', async () => {
  const h = await bootChartServer();
  try {
    const bad = await h.get('/api/candles?before=soon');
    assert.equal(bad.status, 400);
    const plain = await fetch(`${h.url}/api/candles?product=ETH-USD&granularity=300&limit=50`);
    assert.equal(plain.status, 200);
    const bars = (await plain.json()) as Bar[];
    assert.equal(bars.length, 50);
    assert.equal(plain.headers.get('x-candle-exhausted-back'), 'false');
    const week = await fetch(`${h.url}/api/candles?product=ETH-USD&granularity=604800&limit=5`);
    assert.equal(week.status, 200, 'the granularity clamp reaches the top of the timeframe range');
  } finally {
    await h.close();
  }
});
