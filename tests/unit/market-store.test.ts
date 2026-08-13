// The cache, which is the whole latency fix.
//
// The promise these tests hold: a read never waits on the network, a burst of reads makes
// one fetch and not a hundred, and an exchange outage returns the last good chart marked
// old rather than an empty one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import { createMarketStore, mergeSeries, staleAfterSec } from '../../src/market/store.ts';

function minutes(count: number, startSec = 1_699_999_200, close = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ t: startSec + i * 60, o: close, h: close + 1, l: close - 1, c: close + i, v: 1 });
  }
  return out;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a read never waits on the network', () => {
  let started = 0;
  const store = createMarketStore({
    fetchWindow: async () => {
      started++;
      // Never settles, and holds no timer, so the suite does not wait on it.
      await new Promise<void>(() => {});
      return [];
    },
  });

  // The very first read has nothing to give, but it returns rather than blocking.
  const result = store.read('BTC-USD', 60, 60, 100);
  assert.equal(result.candles.length, 0);
  assert.equal(result.filling, true, 'the caller is told a fill is running');
  assert.equal(started, 1);
});

test('a burst of reads collapses into one fetch', async () => {
  let calls = 0;
  const store = createMarketStore({
    fetchWindow: async () => {
      calls++;
      await tick();
      return minutes(200);
    },
  });

  // What a drag does: many reads in one frame budget.
  for (let i = 0; i < 100; i++) store.read('BTC-USD', 60, 60, 100);
  await tick();
  await tick();

  assert.equal(calls, 1, 'one hundred reads, one exchange call');
});

test('a second read after the fill lands is served from memory', async () => {
  let calls = 0;
  const store = createMarketStore({
    fetchWindow: async () => {
      calls++;
      return minutes(200);
    },
  });

  await store.warm('BTC-USD', 60, 60, 100);
  assert.equal(calls, 1);

  const result = store.read('BTC-USD', 60, 60, 100);
  assert.equal(result.candles.length, 100);
  assert.equal(calls, 1, 'nothing was refetched for a read inside the freshness window');
});

test('closed bars survive an outage and are marked old rather than dropped', async () => {
  let calls = 0;
  const store = createMarketStore({
    fetchWindow: async () => {
      calls++;
      if (calls === 1) return minutes(200);
      throw new Error('hyperliquid candles failed: 429');
    },
    now: () => 0,
  });

  await store.warm('BTC-USD', 60, 60, 100);
  await store.fill('BTC-USD', 60, 200); // the failing one

  const result = store.read('BTC-USD', 60, 60, 100);
  assert.equal(result.candles.length, 100, 'the chart still has its candles');
  assert.match(String(result.error), /429/, 'and it says why they stopped updating');
});

test('a read folds the cached base into the timeframe asked for', async () => {
  const store = createMarketStore({ fetchWindow: async () => minutes(600) });

  await store.warm('BTC-USD', 60, 300, 50);
  const folded = store.read('BTC-USD', 60, 300, 50);

  assert.equal(folded.candles.length, 50);
  for (const bar of folded.candles) {
    assert.equal(bar.t % 300, 0, 'every 5m bar opens on a 5m boundary');
  }
});

test('one base series serves every timeframe folded from it', async () => {
  let calls = 0;
  const store = createMarketStore({
    fetchWindow: async () => {
      calls++;
      return minutes(3000);
    },
  });

  await store.warm('BTC-USD', 60, 300, 20);
  const before = calls;
  // Flipping 5m to 15m to 7m costs nothing: they all fold from the 1m already held.
  store.read('BTC-USD', 60, 900, 20);
  store.read('BTC-USD', 60, 420, 20);
  assert.equal(calls, before, 'switching timeframes did not touch the network');
});

test('merging keeps closed bars and lets the fresher copy of the forming bar win', () => {
  const held = minutes(3);
  const fresher: Candle[] = [{ ...(held[2] as Candle), c: 999, v: 50 }];
  const merged = mergeSeries(held, fresher, 5000);

  assert.equal(merged.length, 3, 'no duplicate bar for the same open time');
  assert.equal((merged[2] as Candle).c, 999, 'the newer copy of the forming bar wins');
  assert.equal((merged[0] as Candle).c, (held[0] as Candle).c, 'closed bars are untouched');
});

test('merging keeps the series ordered oldest first', () => {
  const merged = mergeSeries(minutes(3, 1_699_999_200), minutes(3, 1_699_999_020), 5000);
  for (let i = 1; i < merged.length; i++) {
    assert.ok((merged[i] as Candle).t > (merged[i - 1] as Candle).t, 'time only moves forward');
  }
});

test('a series is capped so a long session cannot grow without bound', () => {
  const merged = mergeSeries(minutes(4000), minutes(100, 1_699_999_200 + 4000 * 60), 500);
  assert.equal(merged.length, 500);
});

test('a slow timeframe is not refreshed on a fast cadence', () => {
  assert.ok(staleAfterSec(1) <= 1, 'a one second chart refreshes every second');
  assert.ok(staleAfterSec(86_400) >= 60, 'a daily chart does not refresh every second');
  assert.ok(staleAfterSec(60) < staleAfterSec(3600), 'faster timeframes refresh sooner');
});

test('a live bar folded in does not cost a network call', async () => {
  let calls = 0;
  const store = createMarketStore({
    fetchWindow: async () => {
      calls++;
      return minutes(100);
    },
  });

  await store.warm('BTC-USD', 1, 1, 50);
  const after = calls;

  store.put('BTC-USD', 1, [{ t: 1_699_999_200 + 100 * 60, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
  assert.equal(calls, after, 'the trade stream feeds the cache directly');
});
