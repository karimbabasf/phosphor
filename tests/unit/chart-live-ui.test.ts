// The window folding a socket bar into whatever bucket size is on screen.
//
// These tests are about the two things a delta frame can get wrong that a full refetch never
// could. The first is identity: a frame names a product, a venue and a base interval, and a
// number off the wrong one reaching the canvas is one market's price under another market's
// name, which reads as correct. The second is arithmetic: the venue resends the whole forming
// minute rather than a delta, so a fold that adds its volume each time makes the bar climb
// with the message rate instead of with the market.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

function loadChartUi(): Sandbox {
  const source = readFileSync(new URL('../../ui/chart/chart.js', import.meta.url), 'utf8');
  const sandbox: Sandbox = {
    window: {
      requestAnimationFrame: () => 1,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
    },
    document: { getElementById: () => null, addEventListener: () => {} },
    fetch: async () => {
      throw new Error('these tests never reach the network');
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    console,
  };
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'ui/chart/chart.js' });
  return sandbox;
}

const MINUTE = 1_760_000_400;

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function bars(count: number, stepSec: number, startSec = MINUTE): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ t: startSec + i * stepSec, o: 100, h: 101, l: 99, c: 100, v: 2 });
  }
  return out;
}

/* A window already drawing a market, which is the only state a live frame is applied into. */
function drawing(sandbox: Sandbox, over: Record<string, unknown> = {}): void {
  sandbox.applyChart({
    rev: 1,
    lastDriver: 'human',
    view: {
      product: 'BTC-USD',
      provider: 'auto',
      granularitySec: 60,
      barCount: 120,
      panOffset: 0,
      priceScale: { mode: 'auto' },
    },
    candles: bars(10, 60),
    meta: { source: 'hyperliquid', stale: false, built: 'candles' },
    indicators: [],
    levels: [],
    marks: [],
    products: ['BTC-USD'],
    timeframes: [{ sec: 60, label: '1m' }],
    ...over,
  });
}

const frame = (over: Record<string, unknown> = {}) => ({
  type: 'candle',
  product: 'BTC-USD',
  provider: 'hyperliquid',
  baseSec: 60,
  candle: { t: MINUTE + 9 * 60, o: 100, h: 104, l: 98, c: 103, v: 5 },
  ...over,
});

/* Copied out of the sandbox, because a candle built inside it carries that realm's prototype
   and a strict deep comparison against a literal here fails on identity alone. */
function newest(sandbox: Sandbox): Bar {
  const held = sandbox.CHART.candles;
  return { ...(held[held.length - 1] as Bar) };
}

// ---------- identity ----------

test('a frame for another market never reaches the canvas', () => {
  const s = loadChartUi();
  drawing(s);
  s.candleLive(frame({ product: 'SOL-USD' }));
  assert.equal(newest(s).c, 100, 'one price under another market name is worse than no price');
});

test('a frame from a venue that is not serving these bars is dropped', () => {
  const s = loadChartUi();
  drawing(s);
  // Two venues price the same coin differently and one of them is a perp against the other's
  // spot. meta.source is what is actually serving, which is not always what the view asked for.
  s.candleLive(frame({ provider: 'coinbase' }));
  assert.equal(newest(s).c, 100);
});

test('a base that does not divide the bucket is dropped rather than straddled', () => {
  const s = loadChartUi();
  drawing(s, {
    view: {
      product: 'BTC-USD',
      provider: 'auto',
      granularitySec: 300,
      barCount: 120,
      panOffset: 0,
      priceScale: { mode: 'auto' },
    },
    candles: bars(10, 300),
  });
  s.candleLive(frame({ baseSec: 180, candle: { t: MINUTE + 9 * 300, o: 100, h: 104, l: 98, c: 103, v: 5 } }));
  assert.equal(newest(s).c, 100);
});

test('a frame for a bar older than the newest one drawn is ignored', () => {
  const s = loadChartUi();
  drawing(s);
  // A straggler after a reconnect. Rewriting a closed bar from one late minute of it would be
  // worse than losing the frame.
  s.candleLive(frame({ candle: { t: MINUTE + 3 * 60, o: 1, h: 1, l: 1, c: 1, v: 1 } }));
  assert.equal(newest(s).c, 100);
  assert.equal(s.CHART.candles.length, 10);
});

// ---------- the fold ----------

test('on the timeframe the frame is native to, the bar is replaced outright', () => {
  const s = loadChartUi();
  drawing(s);
  s.candleLive(frame());
  assert.deepEqual(newest(s), { t: MINUTE + 9 * 60, o: 100, h: 104, l: 98, c: 103, v: 5 });
  assert.equal(s.CHART.candles.length, 10, 'the same bar is not a new bar');
});

test('on a coarser timeframe the minute folds in without losing the minutes already in the bucket', () => {
  const s = loadChartUi();
  drawing(s, {
    view: {
      product: 'BTC-USD',
      provider: 'auto',
      granularitySec: 300,
      barCount: 120,
      panOffset: 0,
      priceScale: { mode: 'auto' },
    },
    candles: [{ t: MINUTE, o: 90, h: 95, l: 88, c: 92, v: 20 }],
  });
  // A minute inside the 09:00 bucket. The bucket's open belongs to the first minute of it and
  // must survive; only the parts a later minute can move are moved.
  s.candleLive(frame({ candle: { t: MINUTE + 120, o: 92, h: 99, l: 85, c: 97, v: 4 } }));
  assert.deepEqual(newest(s), { t: MINUTE, o: 90, h: 99, l: 85, c: 97, v: 24 });
});

test('a minute resent carries the whole minute, so only what is new is added to the bucket', () => {
  const s = loadChartUi();
  drawing(s, {
    view: {
      product: 'BTC-USD',
      provider: 'auto',
      granularitySec: 300,
      barCount: 120,
      panOffset: 0,
      priceScale: { mode: 'auto' },
    },
    candles: [{ t: MINUTE, o: 90, h: 95, l: 88, c: 92, v: 20 }],
  });
  s.candleLive(frame({ candle: { t: MINUTE + 120, o: 92, h: 96, l: 90, c: 94, v: 3 } }));
  assert.equal(newest(s).v, 23);
  // Same minute, more volume in it. Adding 7 again rather than the 4 that is new is how a
  // bar's volume ends up tracking the venue's message rate.
  s.candleLive(frame({ candle: { t: MINUTE + 120, o: 92, h: 96, l: 90, c: 95, v: 7 } }));
  assert.equal(newest(s).v, 27);
  assert.equal(newest(s).c, 95);
});

test('a frame for the next bucket appends rather than overwriting the one that just closed', () => {
  const s = loadChartUi();
  drawing(s);
  s.candleLive(frame({ candle: { t: MINUTE + 10 * 60, o: 103, h: 105, l: 103, c: 104, v: 2 } }));
  assert.equal(s.CHART.candles.length, 11);
  assert.deepEqual(newest(s), { t: MINUTE + 10 * 60, o: 103, h: 105, l: 103, c: 104, v: 2 });
  assert.equal((s.CHART.candles[9] as Bar).c, 100, 'the bar that closed keeps the close it closed at');
});

// ---------- the hand on the chart ----------

test('a window panned back does not walk when a bar is appended under it', () => {
  const s = loadChartUi();
  drawing(s);
  s.CHART.view.panOffset = 4;
  s.candleLive(frame({ candle: { t: MINUTE + 10 * 60, o: 103, h: 105, l: 103, c: 104, v: 2 } }));
  // The window is anchored by index from the newest bar, so appending one without this moves
  // the whole view a bar to the right under a hand that has not touched it.
  assert.equal(s.CHART.view.panOffset, 5);
});

test('a frame arriving mid-drag is held, not dropped, and lands when the hand comes off', () => {
  const s = loadChartUi();
  drawing(s);
  s.CHART_DRAG = { moved: true };
  s.candleLive(frame());
  assert.equal(newest(s).c, 100, 'a live chart must not slide out from under a drag');

  s.CHART_DRAG = null;
  s.flushLiveCandle();
  assert.equal(newest(s).c, 103, 'the newest thing the venue said is late, not stale');
});

test('only the newest held frame survives a drag', () => {
  const s = loadChartUi();
  drawing(s);
  s.CHART_DRAG = { moved: true };
  s.candleLive(frame({ candle: { t: MINUTE + 9 * 60, o: 100, h: 101, l: 99, c: 101, v: 1 } }));
  s.candleLive(frame({ candle: { t: MINUTE + 9 * 60, o: 100, h: 106, l: 97, c: 106, v: 8 } }));
  s.CHART_DRAG = null;
  s.flushLiveCandle();
  assert.equal(newest(s).c, 106);
  assert.equal(newest(s).v, 8);
});

// ---------- the tag ----------

test('the tag eases toward the new price and the figure it carries never lies', () => {
  const s = loadChartUi();
  drawing(s);
  s.candleLive(frame());
  // Mid-ease the drawn position sits between the two prices, and the close is already the new
  // one: an interpolated price is a price that never traded.
  const shown = s.shownPrice();
  assert.ok(shown > 100 && shown <= 103, `expected a position between the two prices, got ${shown}`);
  assert.equal(newest(s).c, 103);
});

test('switching market drops the volume memo and the ease, so nothing carries across', () => {
  const s = loadChartUi();
  drawing(s, {
    view: {
      product: 'BTC-USD',
      provider: 'auto',
      granularitySec: 300,
      barCount: 120,
      panOffset: 0,
      priceScale: { mode: 'auto' },
    },
    candles: [{ t: MINUTE, o: 90, h: 95, l: 88, c: 92, v: 20 }],
  });
  s.candleLive(frame({ candle: { t: MINUTE + 120, o: 92, h: 96, l: 90, c: 94, v: 3 } }));
  assert.equal(newest(s).v, 23);

  drawing(s, {
    rev: 2,
    view: {
      product: 'SOL-USD',
      provider: 'auto',
      granularitySec: 300,
      barCount: 120,
      panOffset: 0,
      priceScale: { mode: 'auto' },
    },
    candles: [{ t: MINUTE, o: 10, h: 11, l: 9, c: 10, v: 1 }],
    products: ['BTC-USD', 'SOL-USD'],
  });
  assert.equal(s.CHART_LIVE, null);
  assert.equal(s.CHART_PRICE_TWEEN, null);
  // And a frame for the market that is gone is refused on identity, not on the memo.
  s.candleLive(frame({ candle: { t: MINUTE + 120, o: 92, h: 96, l: 90, c: 94, v: 9 } }));
  assert.equal(newest(s).v, 1);
});

test('a week bucket opens on Monday, the one bucket the epoch does not divide cleanly', () => {
  const s = loadChartUi();
  // Epoch second zero was a Thursday. A chart that skips the offset disagrees with every venue.
  assert.equal(s.liveBucket(1_760_000_400, 60), 1_760_000_400);
  assert.equal(s.liveBucket(1_760_000_400, 604800) % 604800, 345600 % 604800);
});
