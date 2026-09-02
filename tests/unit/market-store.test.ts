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

test('a live bar reaches the emitter, carrying the bar rather than a nudge', async () => {
  const seen: { product: string; baseSec: number; candle: Candle; provider: string }[] = [];
  const store = createMarketStore({
    fetchWindow: async () => minutes(100),
    onLive: (product, baseSec, candle, provider) => seen.push({ product, baseSec, candle, provider }),
  });

  await store.warm('BTC-USD', 60, 60, 50, 'coinbase');
  const bar: Candle = { t: 1_699_999_200 + 100 * 60, o: 1, h: 2, l: 0.5, c: 1.5, v: 9 };
  store.put('BTC-USD', 60, [bar], 'coinbase');

  assert.equal(seen.length, 1);
  // The venue rides along, because one venue's bar landing under another venue's name is the
  // splice this store's keyOf comment exists to prevent, and the SSE frame carries the key.
  assert.deepEqual(seen[0], { product: 'BTC-USD', baseSec: 60, candle: bar, provider: 'coinbase' });
});

test('a fill is not a live bar, so it does not reach the live emitter', async () => {
  let live = 0;
  const store = createMarketStore({ fetchWindow: async () => minutes(100), onLive: () => (live += 1) });
  await store.warm('BTC-USD', 60, 60, 50);
  assert.equal(live, 0, 'the REST rail has its own signal and it is onUpdate');
});

test('while a socket is feeding a series, REST relaxes instead of polling every second', async () => {
  let clock = 1_800_000_000_000;
  let calls = 0;
  const store = createMarketStore({
    fetchWindow: async () => {
      calls++;
      return minutes(100);
    },
    now: () => clock,
  });

  await store.warm('BTC-USD', 60, 60, 50);
  const filled = calls;

  // No live bar: the 1 s gate applies and a read two seconds later refills.
  clock += 2000;
  store.read('BTC-USD', 60, 60, 50);
  assert.equal(calls, filled + 1, 'the fallback cadence is unchanged when nothing is live');

  await new Promise((resolve) => setImmediate(resolve));
  store.put('BTC-USD', 60, [{ t: 1_699_999_200 + 100 * 60, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
  const afterLive = calls;

  clock += 4000;
  store.read('BTC-USD', 60, 60, 50);
  assert.equal(calls, afterLive, 'the rail is moving the price, so REST stays out of the way');

  // The relaxed gate is 30 s, not forever. Past it the backstop reconciles the closed bar.
  clock += 40_000;
  store.read('BTC-USD', 60, 60, 50);
  assert.equal(calls, afterLive + 1);
});

test('a series stops counting as live the moment the deltas stop', async () => {
  let clock = 1_800_000_000_000;
  const store = createMarketStore({ fetchWindow: async () => minutes(100), now: () => clock });
  await store.warm('BTC-USD', 60, 60, 50);

  assert.equal(store.read('BTC-USD', 60, 60, 50).liveAgeSec, null, 'nothing has ever been live');
  store.put('BTC-USD', 60, [{ t: 1_699_999_200 + 100 * 60, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
  assert.equal(store.read('BTC-USD', 60, 60, 50).liveAgeSec, 0);
  clock += 9000;
  assert.equal(store.read('BTC-USD', 60, 60, 50).liveAgeSec, 9);
});

test('a coarser timeframe of a live market reads as live, because the rail only carries minutes', async () => {
  let clock = 1_800_000_000_000;
  const store = createMarketStore({ fetchWindow: async () => minutes(400), now: () => clock });
  await store.warm('BTC-USD', 60, 60, 50);
  await store.warm('BTC-USD', 300, 300, 50);

  store.put('BTC-USD', 60, [{ t: 1_699_999_200 + 400 * 60, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
  // Without this the dot beside the price would go hollow on every timeframe but one, while
  // the socket driving that very market is wide awake.
  assert.equal(store.read('BTC-USD', 300, 300, 50).liveAgeSec, 0);
});

test('peek returns the newest bar and starts nothing', () => {
  let calls = 0;
  const store = createMarketStore({
    fetchWindow: async () => {
      calls++;
      return minutes(10);
    },
  });

  // The Coinbase fold asks per trade, several times a second, so a peek that filled or
  // reordered the eviction queue would turn a read into a rate limit.
  assert.equal(store.peek('BTC-USD', 60, 'coinbase'), null);
  assert.equal(calls, 0);
});

test('a single bar folded onto the newest one replaces it rather than rebuilding the series', async () => {
  const store = createMarketStore({ fetchWindow: async () => minutes(100) });
  await store.warm('BTC-USD', 60, 60, 200);
  const before = store.read('BTC-USD', 60, 60, 200);
  const held = before.candles;
  const last = held[held.length - 1] as Candle;

  store.put('BTC-USD', 60, [{ ...last, c: 999 }]);
  const after = store.read('BTC-USD', 60, 60, 200);
  assert.equal(after.candles.length, before.candles.length, 'the same bar is not a new bar');
  assert.equal((after.candles[after.candles.length - 1] as Candle).c, 999);
  // The array a caller already holds must not change under it.
  assert.equal(last.c, (held[held.length - 1] as Candle).c);
  assert.notEqual(last.c, 999);

  store.put('BTC-USD', 60, [{ t: last.t + 60, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
  assert.equal(store.read('BTC-USD', 60, 60, 200).candles.length, before.candles.length + 1);
});

test('switching timeframe with a warm cache draws bars, not a skeleton', async () => {
  let calls = 0;
  const store = createMarketStore({
    fetchWindow: async (_product, baseSec) => {
      calls++;
      // The 5m fill never settles, so what comes back can only have been bridged.
      if (baseSec !== 60) await new Promise<void>(() => {});
      return minutes(600);
    },
  });

  await store.warm('BTC-USD', 60, 60, 500);
  const cold = store.read('BTC-USD', 300, 300, 100);

  assert.ok(cold.candles.length > 0, 'the 1m bars that build these 5m bars were already here');
  assert.equal(cold.filling, true, 'the real fill is still on its way');
  assert.equal(cold.source, 'bridged');
  // The fold is exact or it is a lie, so every bucket has to open on a boundary.
  for (const candle of cold.candles) assert.equal(candle.t % 300, 0);
  assert.ok(calls >= 2);
});

test('the oldest bridged bucket is dropped rather than drawn half built', async () => {
  // A 1m series that starts at 09:03, three minutes into a 5m bucket. Folding it whole would
  // draw the 09:00 bucket from two of its five minutes and call it a bar.
  const store = createMarketStore({
    fetchWindow: async (_product, baseSec) => {
      if (baseSec !== 60) await new Promise<void>(() => {});
      return minutes(60, 1_699_999_200 + 180);
    },
  });
  await store.warm('BTC-USD', 60, 60, 60);
  const cold = store.read('BTC-USD', 300, 300, 100);
  const first = cold.candles[0] as Candle;
  assert.ok(first.t >= 1_699_999_200 + 300, 'the partial bucket at the old end is not drawn');
});

test('a bridged bar wins over a stale coarse one, which is what makes a 5m chart move', async () => {
  const store = createMarketStore({
    fetchWindow: async (_product, baseSec) => (baseSec === 60 ? minutes(600) : minutes(120, 1_699_999_200, 100)),
  });
  await store.warm('BTC-USD', 60, 60, 500);
  await store.warm('BTC-USD', 300, 300, 100);

  // A socket bar lands on the 1m series only. Without the bridge the 5m chart would sit still
  // while the very same market is being pushed at it several times a second.
  const newest = store.read('BTC-USD', 60, 60, 1).candles[0] as Candle;
  store.put('BTC-USD', 60, [{ ...newest, c: 4242 }]);
  const held = store.read('BTC-USD', 300, 300, 50);
  assert.equal((held.candles[held.candles.length - 1] as Candle).c, 4242);
});

test('a base that does not divide the timeframe is never bridged from', async () => {
  const store = createMarketStore({
    fetchWindow: async (_product, baseSec) => {
      if (baseSec !== 180) await new Promise<void>(() => {});
      return minutes(600);
    },
  });
  // 3m bars fold into 9m but not into 5m, and a bucket built from bars that straddle it is a
  // price that never traded.
  await store.warm('BTC-USD', 180, 180, 100);
  const cold = store.read('BTC-USD', 300, 300, 50);
  assert.equal(cold.candles.length, 0);
  assert.equal(cold.source, 'filling');
});
