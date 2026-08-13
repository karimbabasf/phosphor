// Second candles built from the trade tape, which is what gives a 1s chart a past.
//
// The behaviour worth pinning: a second with no trade is a flat bar and not a hole, the
// tape is paged backward until the window is covered, and pages already in hand survive a
// refused page rather than being thrown away.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import { bucketTrades, coinbaseSeconds, coverageSec, type TradeRow } from '../../src/market/seconds.ts';

function tape(entries: [number, number, number][]): TradeRow[] {
  return entries.map(([timeSec, price, size]) => ({ timeSec, price, size }));
}

test('trades in the same second become one bar', () => {
  const bars = bucketTrades(
    tape([
      [1000, 100, 1],
      [1000.2, 105, 2],
      [1000.9, 102, 3],
    ]),
    1,
  );

  assert.equal(bars.length, 1);
  const bar = bars[0] as Candle;
  assert.equal(bar.o, 100, 'open is the first trade in the second');
  assert.equal(bar.c, 102, 'close is the last trade in the second');
  assert.equal(bar.h, 105);
  assert.equal(bar.l, 100);
  assert.equal(bar.v, 6, 'size sums');
});

test('a second with no trade is a flat bar, not a hole', () => {
  const bars = bucketTrades(
    tape([
      [1000, 100, 1],
      [1003, 110, 1],
    ]),
    1,
  );

  assert.equal(bars.length, 4, 'seconds 1000 through 1003 are all present');
  const quiet = bars[1] as Candle;
  assert.equal(quiet.o, 100);
  assert.equal(quiet.c, 100, 'the quiet second carries the last close');
  assert.equal(quiet.h, quiet.l, 'and it is flat');
  assert.equal(quiet.v, 0, 'with no volume, because nothing traded');
});

test('nothing is carried before the first trade', () => {
  const bars = bucketTrades(tape([[5000, 42, 1]]), 1);
  assert.equal(bars.length, 1);
  assert.equal((bars[0] as Candle).t, 5000);
});

test('a five second bar folds five seconds of tape', () => {
  const bars = bucketTrades(
    tape([
      [1000, 100, 1],
      [1002, 120, 1],
      [1004, 90, 1],
      [1005, 95, 1],
    ]),
    5,
  );

  assert.equal(bars.length, 2);
  const first = bars[0] as Candle;
  assert.equal(first.t, 1000);
  assert.equal(first.o, 100, 'open is the trade at 1000');
  assert.equal(first.h, 120, 'high is the trade at 1002');
  assert.equal(first.l, 90, 'low is the trade at 1004, which is still inside this bucket');
  assert.equal(first.c, 90, 'close is the last trade in the bucket');
  assert.equal((bars[1] as Candle).o, 95, 'the trade at 1005 opens the next bucket');
});

test('the tape is paged backward until the window is covered', async () => {
  const nowMs = 2_000_000_000_000;
  const nowSec = nowMs / 1000;
  let pages = 0;

  const fetchImpl = (async (url: string) => {
    pages++;
    // Each page is sixty seconds older than the last.
    const base = nowSec - pages * 60;
    const rows: { trade_id: number; price: string; size: string; time: string }[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({ trade_id: pages * 1000 + i, price: '100', size: '1', time: new Date((base + i) * 1000).toISOString() });
    }
    return {
      ok: true,
      json: async () => rows,
      headers: new Headers({ 'cb-after': String(pages) }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;

  const backfill = coinbaseSeconds({ fetchImpl, now: () => nowMs, maxPages: 24 });
  // Five minutes of 1s bars needs five pages of sixty seconds.
  const bars = await backfill('BTC-USD', 1, 300);

  assert.ok(pages >= 5, `expected at least five pages, took ${pages}`);
  assert.ok(bars.length > 240, `expected a few hundred bars, got ${bars.length}`);
});

test('the page budget stops an unbounded crawl against a public endpoint', async () => {
  let pages = 0;
  const fetchImpl = (async () => {
    pages++;
    return {
      ok: true,
      // Always the same recent second, so the window never fills and only the budget stops it.
      json: async () => [{ trade_id: pages, price: '100', size: '1', time: new Date(2_000_000_000_000).toISOString() }],
      headers: new Headers({ 'cb-after': String(pages) }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;

  const backfill = coinbaseSeconds({ fetchImpl, now: () => 2_000_000_000_000, maxPages: 4 });
  await backfill('BTC-USD', 1, 100_000);

  assert.equal(pages, 4, 'the budget is the stop, and it is respected');
});

test('a refused page keeps the pages already in hand', async () => {
  let pages = 0;
  const fetchImpl = (async () => {
    pages++;
    if (pages === 1) {
      return {
        ok: true,
        json: async () => [{ trade_id: 1, price: '100', size: '1', time: new Date(2_000_000_000_000).toISOString() }],
        headers: new Headers({ 'cb-after': '1' }),
        text: async () => '',
      };
    }
    return { ok: false, status: 429, json: async () => [], headers: new Headers(), text: async () => 'slow down' };
  }) as unknown as typeof fetch;

  const backfill = coinbaseSeconds({ fetchImpl, now: () => 2_000_000_000_000, maxPages: 8 });
  const bars = await backfill('BTC-USD', 1, 1000);

  assert.equal(bars.length, 1, 'the good page survived the refused one');
});

test('a first page that is refused is an error, because there is nothing to show', async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 429,
    json: async () => [],
    headers: new Headers(),
    text: async () => 'slow down',
  })) as unknown as typeof fetch;

  const backfill = coinbaseSeconds({ fetchImpl, now: () => 2_000_000_000_000 });
  await assert.rejects(() => backfill('BTC-USD', 1, 100), /coinbase trades failed: 429/);
});

test('coverage reports the span the seconds actually reach', () => {
  const bars = bucketTrades(
    tape([
      [1000, 100, 1],
      [1060, 100, 1],
    ]),
    1,
  );
  assert.equal(coverageSec(bars, 1), 61);
  assert.equal(coverageSec([], 1), 0);
});
