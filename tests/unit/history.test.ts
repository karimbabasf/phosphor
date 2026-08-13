import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../../src/history.ts';
import type { Candle } from '../../src/types.ts';

function fakeSeries(count: number, granularity: number, endSec: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const t = endSec - (count - i) * granularity;
    return { t, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 };
  });
}

test('returns a page and a cursor pointing before its oldest bar', async () => {
  const h = createHistory(async (_p, g, end, limit) => fakeSeries(limit, g, end));
  const page = await h.page('ETH', 60, null, 10);
  assert.equal(page.candles.length, 10);
  assert.equal(page.complete, false);
  assert.equal(page.cursor, page.candles[0].t, 'cursor is the oldest bar time, exclusive next call');
});

test('a short page means the venue ran out of history', async () => {
  const h = createHistory(async (_p, g, end) => fakeSeries(3, g, end));
  const page = await h.page('ETH', 60, null, 10);
  assert.equal(page.candles.length, 3);
  assert.equal(page.complete, true);
  assert.equal(page.cursor, null);
});

test('an empty page is complete and carries no cursor', async () => {
  const h = createHistory(async () => []);
  const page = await h.page('ETH', 60, 5000, 10);
  assert.deepEqual(page, { candles: [], cursor: null, complete: true });
});

test('passes the cursor through as the end bound', async () => {
  let seenEnd = -1;
  const h = createHistory(async (_p, g, end, limit) => {
    seenEnd = end;
    return fakeSeries(limit, g, end);
  });
  await h.page('ETH', 60, 12345, 5);
  assert.equal(seenEnd, 12345);
});

test('sorts and de-duplicates whatever the venue returns', async () => {
  const h = createHistory(async () => [
    { t: 300, o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: 100, o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: 300, o: 9, h: 9, l: 9, c: 9, v: 9 },
    { t: 200, o: 1, h: 1, l: 1, c: 1, v: 1 },
  ]);
  const page = await h.page('ETH', 60, null, 10);
  assert.deepEqual(page.candles.map((c) => c.t), [100, 200, 300]);
  assert.equal(page.candles[2].o, 9, 'the later duplicate wins, since it is the fresher read');
});

test('walks backwards across pages without repeating a bar', async () => {
  // Ten bars of history in total, served three at a time from the end bound.
  const all = fakeSeries(10, 60, 10_000);
  const h = createHistory(async (_p, _g, end, limit) =>
    all.filter((c) => c.t < end).slice(-limit),
  );

  const seen: number[] = [];
  let cursor: number | null = null;
  for (let i = 0; i < 5; i++) {
    const page = await h.page('ETH', 60, cursor, 3);
    seen.push(...page.candles.map((c) => c.t));
    if (page.complete) break;
    cursor = page.cursor;
  }

  assert.equal(new Set(seen).size, seen.length, 'no bar came back twice');
  assert.equal(seen.length, 10, 'and the walk reached the start of history');
});
