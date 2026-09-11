// chart_read compact by default, chart_scan in parallel.
//
// The read was 4.5 KB with a preset on the chart and it was echoed after every write, so the
// agent paid for the same chart on every turn. Compact is the default now: last values and
// state lines, counts, a short geometry, and nothing per bar. `full: true` is the old shape for
// the call that actually wants it. The scan used to load its timeframes one after another, so a
// cold five-timeframe scan was five venue round trips in series.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';

test('a compact read with four indicators is under 1.5 KB and still says what is on the chart', async () => {
  const h = await bootChartServer();
  try {
    await h.mcp({
      op: 'view',
      tool: 'chart_draw',
      session: 'a',
      args: {
        indicators: { preset: 'momentum', add: [{ type: 'ema', params: { period: 21 } }] },
        levels: [{ px: 170, label: 'range high' }],
        marks: [{ t: 1_760_000_000, label: 'entry' }],
        lines: [{ t1: 1_760_000_000, p1: 150, t2: 1_760_003_600, p2: 151, label: 'support' }],
      },
    });
    const out = await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: {} });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    const r = out.json;
    const bytes = JSON.stringify(r).length;
    assert.ok(bytes < 1500, `compact read is ${bytes} bytes`);
    assert.equal(r.chart, 0);
    assert.equal(r.product, 'BTC-USD');
    assert.equal(r.timeframe, '1m');
    assert.equal(typeof r.price.last, 'number');
    assert.equal(typeof r.bar.closesInSec, 'number');
    assert.equal(r.indicators.length, 4);
    for (const ind of r.indicators) {
      assert.equal(typeof ind.id, 'string');
      assert.equal(typeof ind.state, 'string');
      assert.ok(Object.keys(ind.last).length > 0);
    }
    assert.equal(r.levels.length, 1);
    assert.equal(r.levels[0].px, 170);
    assert.equal(r.marks.length, 1);
    assert.equal(r.drawings.length, 1);
    assert.equal(r.drawings[0].kind, 'line');
    assert.equal(typeof r.drawings[0].priceNow, 'number');
    assert.equal(r.housekeeping.mine, 7, 'four studies, a level, a mark and a line');
    // Nothing per bar and none of the full read's prose blocks.
    assert.equal(r.candles, undefined);
    assert.equal(r.currentBar, undefined);
    assert.equal(r.serverTime, undefined);
  } finally {
    await h.close();
  }
});

test('full: true is the old shape, with the drawings from the one store', async () => {
  const h = await bootChartServer();
  try {
    await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { zones: [{ p1: 1, p2: 2 }] } });
    const out = await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: { full: true } });
    assert.equal(out.status, 200);
    const r = out.json;
    assert.ok(r.serverTime !== undefined, 'the full read carries the server time block');
    assert.ok(r.currentBar !== undefined);
    assert.equal(r.trendlines, undefined, 'the second store is gone from the read');
    assert.equal(r.drawings.length, 1);
    assert.equal(r.drawings[0].kind, 'zone');
    assert.equal(r.housekeeping.mine, 1);
  } finally {
    await h.close();
  }
});

test('chart: n reads a comparison chart, and a slot nobody filled is refused by name', async () => {
  const h = await bootChartServer();
  try {
    await h.mcp({
      op: 'view',
      tool: 'chart_layout',
      session: 'a',
      args: { charts: [{ product: 'BTC-USD', timeframe: '1h' }, { product: 'ETH-USD', timeframe: '4h' }] },
    });
    const out = await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: { chart: 1 } });
    assert.equal(out.status, 200);
    assert.equal(out.json.chart, 1);
    assert.equal(out.json.product, 'ETH-USD');
    assert.equal(out.json.timeframe, '4h');
    const missing = await h.mcp({ op: 'read', tool: 'chart_read', session: 'a', args: { chart: 3 } });
    assert.equal(missing.status, 400);
    assert.match(String(missing.json.error), /chart_layout/);
  } finally {
    await h.close();
  }
});

test('a scan of five timeframes fetches them at the same time, not one after another', async () => {
  const h = await bootChartServer({ fetchDelayMs: 40 });
  try {
    const started = Date.now();
    const out = await h.mcp({
      op: 'read',
      tool: 'chart_scan',
      session: 'a',
      args: { timeframes: ['5m', '15m', '1h', '4h', '1d'], bars: 50 },
    });
    const elapsed = Date.now() - started;
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.timeframes.length, 5);
    for (const row of out.json.timeframes) assert.equal(row.error, undefined, JSON.stringify(row));
    const fetches = h.fetches();
    assert.ok(fetches.length >= 2, `expected several fetches, got ${fetches.length}`);
    // Overlap is the proof: some fetch started before an earlier one had finished.
    const sorted = [...fetches].sort((a, b) => a.startedAt - b.startedAt);
    const overlapped = sorted.some((f, i) => i > 0 && f.startedAt < (sorted[i - 1] as { endedAt: number }).endedAt);
    assert.ok(overlapped, 'the fetches ran in series');
    assert.ok(elapsed < 40 * fetches.length, `${fetches.length} fetches of 40 ms took ${elapsed} ms`);
  } finally {
    await h.close();
  }
});

test('the scan keeps refusing a timeframe that is not one, by name, beside the rows that answered', async () => {
  const h = await bootChartServer();
  try {
    const out = await h.mcp({ op: 'read', tool: 'chart_scan', session: 'a', args: { timeframes: ['1h', 'banana'] } });
    assert.equal(out.status, 200);
    assert.equal(out.json.timeframes[0].timeframe, '1h');
    assert.equal(out.json.timeframes[0].error, undefined);
    assert.match(String(out.json.timeframes[1].error), /banana is not a timeframe/);
    assert.equal(out.json.chartUnchanged, true);
  } finally {
    await h.close();
  }
});
