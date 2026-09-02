// What reaches the window, and what the dot beside the price says.
//
// Both halves are here because both are arithmetic that decides what a person sees, and both
// were going to end up inside the server file where the only way to exercise them is to stand
// an HTTP server up and watch a stream.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import { createCandlePush, feedFor, feedStateFrom, type CandleFrame } from '../../src/market/push.ts';

const bar = (over: Partial<Candle> = {}): Candle => ({ t: 1_760_000_400, o: 100, h: 101, l: 99, c: 100, v: 1, ...over });

function harness(intervalMs = 10) {
  const frames: CandleFrame[] = [];
  const push = createCandlePush({ send: (frame) => frames.push(frame), intervalMs });
  return { push, frames };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- the frame ----------

test('a bar goes out as a frame carrying the bar, not as a nudge to come back for it', async () => {
  const { push, frames } = harness();
  push.push('BTC-USD', 60, bar({ c: 103 }), 'hyperliquid');
  await settle();

  assert.equal(frames.length, 1);
  // The exact shape the spec's API table names, and the exact shape ui/chart.js matches on.
  // 120 bytes against the 102 to 137 KB the browser used to refetch to move one close.
  assert.deepEqual(frames[0], {
    type: 'candle',
    product: 'BTC-USD',
    provider: 'hyperliquid',
    baseSec: 60,
    candle: bar({ c: 103 }),
  });
});

test('a burst on one market collapses to the last bar in it', async () => {
  const { push, frames } = harness();
  for (const close of [100, 101, 102, 103]) push.push('BTC-USD', 60, bar({ c: close }), 'hyperliquid');
  await settle();

  // An earlier bar inside the same window is a price that has already been superseded, so
  // sending it would be four repaints to arrive where one would have.
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.candle.c, 103);
});

test('two markets are two frames, and the same coin on two venues is two series', async () => {
  const { push, frames } = harness();
  push.push('BTC-USD', 60, bar({ c: 100 }), 'hyperliquid');
  push.push('ETH-USD', 60, bar({ c: 20 }), 'hyperliquid');
  push.push('BTC-USD', 60, bar({ c: 99 }), 'coinbase');
  await settle();

  assert.equal(frames.length, 3);
  // Coalescing across venues would put a perp's price under a spot market's name, which is the
  // splice the store's own key exists to prevent.
  const keys = frames.map((f) => `${f.provider}:${f.product}`).sort();
  assert.deepEqual(keys, ['coinbase:BTC-USD', 'hyperliquid:BTC-USD', 'hyperliquid:ETH-USD']);
});

test('the coalescer opens a new window rather than staying shut after a flush', async () => {
  const { push, frames } = harness();
  push.push('BTC-USD', 60, bar({ c: 100 }), 'hyperliquid');
  await settle();
  push.push('BTC-USD', 60, bar({ c: 105 }), 'hyperliquid');
  await settle();

  assert.equal(frames.length, 2);
  assert.equal(frames[1]?.candle.c, 105);
});

test('a stopped push sends nothing and holds no timer', async () => {
  const { push, frames } = harness();
  push.push('BTC-USD', 60, bar(), 'hyperliquid');
  push.stop();
  await settle();
  assert.equal(frames.length, 0);
  assert.equal(push.stats().pending, 0);
});

// ---------- the dot ----------

test('live needs a socket AND a bar off it, because an open socket can be silent', () => {
  assert.equal(feedStateFrom({ liveAgeSec: 0.4, connected: true, stale: false, hasBars: true }), 'live');
  // The venue accepted the subscription and is sending nothing. From readyState that is
  // indistinguishable from a healthy feed, and on the screen it is nothing like one.
  assert.equal(feedStateFrom({ liveAgeSec: null, connected: true, stale: false, hasBars: true }), 'delayed');
  assert.equal(feedStateFrom({ liveAgeSec: 22, connected: true, stale: false, hasBars: true }), 'delayed');
});

test('a socket that went down reads delayed while REST is still serving', () => {
  assert.equal(feedStateFrom({ liveAgeSec: 0.2, connected: false, stale: false, hasBars: true }), 'delayed');
});

test('offline is about the data, not about the socket', () => {
  // Nothing to draw, or what is drawn is old enough that it may no longer be the market.
  assert.equal(feedStateFrom({ liveAgeSec: 0.1, connected: true, stale: true, hasBars: true }), 'offline');
  assert.equal(feedStateFrom({ liveAgeSec: null, connected: false, stale: false, hasBars: false }), 'offline');
});

test('the state is per series, so one market being live says nothing about another', () => {
  const connected = (provider: string) => provider === 'hyperliquid';
  const btc = { liveAgeSec: 1, stale: false, bars: 500, source: 'hyperliquid' };
  const doge = { liveAgeSec: null, stale: false, bars: 500, source: 'coinbase' };
  assert.equal(feedFor(btc, connected), 'live');
  assert.equal(feedFor(doge, connected), 'delayed');
});

test('the boundary is five seconds, which is where the audit put it', () => {
  const base = { connected: true, stale: false, hasBars: true };
  assert.equal(feedStateFrom({ ...base, liveAgeSec: 4.9 }), 'live');
  assert.equal(feedStateFrom({ ...base, liveAgeSec: 5 }), 'delayed');
});

// ---------- handing over to the fallback ----------

test('a rail that has never sent is quiet, so the nudge timer runs exactly as it did before', () => {
  const { push } = harness();
  assert.equal(push.quiet(), true);
});

test('a rail that is pushing is not quiet, which is what stops the browser refetching', async () => {
  const { push } = harness();
  push.push('BTC-USD', 60, bar(), 'hyperliquid');
  await settle();
  // The nudge would make the window refetch the whole candle array to arrive where the frame
  // just put it, and that refetch is the thing this rail exists to delete.
  assert.equal(push.quiet(), false);
});

test('a rail that stops hands back within one window rather than leaving the chart on its own', async () => {
  const { push } = harness();
  push.push('BTC-USD', 60, bar(), 'hyperliquid');
  await settle();
  assert.equal(push.quiet(20), false, 'two bars apart is not a rail that stopped');
  await settle(40);
  assert.equal(push.quiet(20), true, 'a socket that died gives REST the chart back');
});
