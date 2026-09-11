// One ATR in the app.
//
// There were three: the Wilder series in src/analysis/regime.ts, a second Wilder in the
// indicator kit, and a plain 14-bar mean inside the chart's scan digest, and the trade
// payload's liquidation distance fetched its own hourly bars through a second candle cache
// and a second venue client to feed one of them. So chart_scan's "atr" and chart_batch's
// "atr" were different numbers under one name, and the skill quotes every distance in ATR.
// The market store now answers the trade payload over the same cache the chart draws from,
// with the one Wilder smoothing, and the scan digest uses it too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMarketData } from '../../src/market/index.ts';
import { createMarketStore } from '../../src/market/store.ts';
import { atr } from '../../src/analysis/regime.ts';
import { digestSeries } from '../../src/chart.ts';
import { fakeCatalog, syntheticBars } from '../fixtures/chart-server.ts';
import type { Candle } from '../../src/types.ts';

// Bars whose range swings, so a Wilder-smoothed ATR and a plain mean of the last fourteen true
// ranges are visibly different numbers. The synthetic bars the chart tests use have a constant
// range, which would make the two agree by accident.
function swingingBars(count: number): Candle[] {
  const out: Candle[] = [];
  let c = 100;
  for (let i = 0; i < count; i++) {
    const range = 1 + (i % 7) * 1.5 + (i % 3 === 0 ? 4 : 0);
    c += Math.sin(i / 5) * 2;
    out.push({ t: 1_700_000_000 + i * 3600, o: c - 0.2, h: c + range / 2, l: c - range / 2, c, v: 10 });
  }
  return out;
}

test('the market answers the Wilder ATR over the bars it holds, for the trade payload', async () => {
  const bars = syntheticBars('BTC-USD', 3600, 120);
  const store = createMarketStore({ fetchWindow: async () => bars });
  const market = createMarketData({ store, catalog: fakeCatalog() });

  const got = await market.atr('BTC-USD', 3600, 120, 14);
  const series = atr(bars, 14);
  const expected = series[series.length - 1] as number;
  assert.ok(got !== null);
  assert.ok(Math.abs(got - expected) < 1e-9, `market ${got} against regime ${expected}`);
});

test('a market with no bars answers null rather than zero', async () => {
  const store = createMarketStore({ fetchWindow: async () => [] });
  const market = createMarketData({ store, catalog: fakeCatalog() });
  assert.equal(await market.atr('BTC-USD', 3600, 120, 14), null);
});

test('the scan digest carries the same Wilder ATR, not a plain mean of true ranges', () => {
  const bars = swingingBars(60);
  const digest = digestSeries(bars, 3600, bars[bars.length - 1]!.t + 10);
  const series = atr(bars, 14);
  const expected = series[series.length - 1] as number;
  assert.ok(Math.abs((digest.atr ?? 0) - expected) < 1e-9, `digest ${digest.atr} against regime ${expected}`);
  // A plain mean over the last fourteen true ranges is a different number on a moving series.
  let mean = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const c = bars[i]!;
    const prev = bars[i - 1]!.c;
    mean += Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  }
  mean /= 14;
  assert.notEqual(Number((digest.atr ?? 0).toFixed(9)), Number(mean.toFixed(9)));
});
