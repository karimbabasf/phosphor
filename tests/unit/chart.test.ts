// The chart view model: the clamps, the pane budget, the agent tag, and the ruler.
//
// The pane budget is the interesting one. The ask was a chart where nothing looks squeezed,
// and the only way to keep that promise is to refuse the pane that would not fit rather than
// shrink everything to make room. These tests are that promise, written down.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import {
  clampPan,
  createChartStore,
  digestSeries,
  LIMITS,
  measure,
  priceDecimals,
  snapTimeframe,
  timeframeLabel,
  visibleRange,
} from '../../src/chart.ts';

function series(closes: number[], step = 60): Candle[] {
  return closes.map((c, i) => ({
    t: 1_700_000_000 + i * step,
    o: i === 0 ? c : (closes[i - 1] as number),
    h: c + 1,
    l: c - 1,
    c,
    v: 10,
  }));
}

test('an odd timeframe snaps to one the rails can serve', () => {
  assert.equal(snapTimeframe(47), 60);
  assert.equal(snapTimeframe(3), 5);
  assert.equal(snapTimeframe(90000), 86400);
  assert.equal(timeframeLabel(14400), '4h');
});

test('pan is capped back and allowed a little past the newest bar', () => {
  assert.equal(clampPan(9999, 120), LIMITS.panMax);
  // Walling at the last bar makes a chart feel stuck, so a quarter window of forward room.
  assert.equal(clampPan(-9999, 120), -30);
  assert.equal(clampPan(12, 120), 12);
});

test('the visible window includes a partially visible bar at either edge', () => {
  const view = { product: 'BTC-USD', granularitySec: 60, barCount: 10.5, panOffset: 2.5, priceScale: { mode: 'auto' } as const };
  const range = visibleRange(100, view);
  assert.equal(range.end, 98);
  assert.equal(range.start, 87);
  assert.equal(range.count, 11);
});

test('price precision follows the span, not the magnitude alone', () => {
  // A 600 point span on a 60,000 price does not want four decimals.
  assert.equal(priceDecimals(600, 63000), 0);
  // A stablecoin pair moving in ten-thousandths does.
  assert.ok(priceDecimals(0.002, 1) >= 4);
});

test('a fourth sub-pane is refused, and the refusal names what to remove', () => {
  const chart = createChartStore('BTC-USD');
  for (const type of ['rsi', 'macd', 'atr']) {
    assert.equal(chart.addIndicator({ type }, 'agent').ok, true, `${type} should fit`);
  }
  const fourth = chart.addIndicator({ type: 'obv' }, 'agent');
  assert.equal(fourth.ok, false);
  assert.match(String(fourth.error), /sub-panes/);
  assert.match(String(fourth.error), /RSI 14/);
  assert.match(String(fourth.error), /chart_remove_indicator/);
  // The refusal has to leave the chart exactly as it was.
  assert.equal(chart.state().indicators.length, 3);
});

test('overlays have their own budget and do not eat the pane budget', () => {
  const chart = createChartStore('BTC-USD');
  for (let i = 1; i <= LIMITS.maxOverlays; i++) {
    assert.equal(chart.addIndicator({ type: 'ema', params: { period: i + 4 } }, 'agent').ok, true);
  }
  assert.equal(chart.addIndicator({ type: 'sma' }, 'agent').ok, false);
  // A sub-pane still fits: the two budgets are separate.
  assert.equal(chart.addIndicator({ type: 'rsi' }, 'agent').ok, true);
});

test('the same indicator twice is a no-op, not a duplicate', () => {
  const chart = createChartStore('BTC-USD');
  const first = chart.addIndicator({ type: 'ema', params: { period: 21 } }, 'agent');
  const again = chart.addIndicator({ type: 'ema', params: { period: 21 } }, 'agent');
  assert.equal(chart.state().indicators.length, 1);
  assert.equal(again.id, first.id);
  // A different period is a different indicator.
  chart.addIndicator({ type: 'ema', params: { period: 50 } }, 'agent');
  assert.equal(chart.state().indicators.length, 2);
});

test('anything the agent draws is tagged, and the human can clear only that', () => {
  const chart = createChartStore('BTC-USD');
  chart.addIndicator({ type: 'ema' }, 'agent');
  chart.addIndicator({ type: 'sma' }, 'human');
  chart.setLevel({ price: 63000, label: 'support' }, 'agent');
  chart.setLevel({ price: 64000, label: 'mine' }, 'human');

  assert.equal(chart.state().indicators[0]?.label.startsWith('[agent] '), true);
  assert.equal(chart.state().indicators[1]?.label.startsWith('[agent] '), false);
  assert.equal(chart.agentObjects(), 2);

  chart.clear('agent');
  assert.equal(chart.agentObjects(), 0);
  assert.equal(chart.state().indicators.length, 1);
  assert.equal(chart.state().levels.length, 1);
  assert.equal(chart.state().levels[0]?.label, 'mine');
});

test('the label an agent supplies cannot escape its own tag', () => {
  const chart = createChartStore('BTC-USD');
  chart.setLevel({ price: 1, label: 'approved by the human' }, 'agent');
  assert.equal(chart.state().levels[0]?.label, '[agent] approved by the human');
});

test('every change bumps the revision, and reporting geometry does not', () => {
  const chart = createChartStore('BTC-USD');
  const start = chart.rev();
  chart.setView({ barCount: 200 }, 'human');
  assert.equal(chart.rev(), start + 1);
  chart.setGeometry({
    width: 900,
    height: 300,
    plotWidth: 830,
    priceHeight: 260,
    pxPerBar: 4,
    panes: [],
    dropped: [],
    reportedAt: new Date().toISOString(),
  });
  // Geometry is a report about the renderer. Bumping here would make the browser answer
  // its own echo forever.
  assert.equal(chart.rev(), start + 1);
});

test('history fetched grows with the longest indicator warmup', () => {
  const chart = createChartStore('BTC-USD');
  chart.setView({ barCount: 120 }, 'human');
  const plain = chart.historyNeeded();
  chart.addIndicator({ type: 'ema', params: { period: 200 } }, 'agent');
  // Without the extra history a 200 period line would start in the middle of the screen.
  assert.ok(chart.historyNeeded() >= plain + 200, `${chart.historyNeeded()} should exceed ${plain + 200}`);
  assert.ok(chart.historyNeeded() <= LIMITS.historyMax);
});

test('switching product resets the window rather than carrying a stale price scale', () => {
  const chart = createChartStore('BTC-USD');
  chart.setView({ panOffset: 50, priceLow: 100, priceHigh: 200 }, 'human');
  chart.setView({ product: 'eth-usd' }, 'agent');
  assert.equal(chart.state().view.product, 'ETH-USD');
  assert.equal(chart.state().view.panOffset, 0);
  assert.equal(chart.state().view.priceScale.mode, 'auto');
});

test('an unknown timeframe is refused by name, not silently ignored', () => {
  const chart = createChartStore('BTC-USD');
  const out = chart.setView({ timeframe: '7m' }, 'agent');
  assert.equal(out.ok, false);
  assert.match(String(out.error), /known:/);
});

test('the ruler reports the path, not only the endpoints', () => {
  // Up to 110, down to 80, back to 100: a straight delta would call this a 0% move.
  const candles = series([100, 110, 80, 100]);
  const out = measure({ candles, granularitySec: 60 }) as Record<string, number>;
  assert.equal(out.deltaAbs, 0);
  assert.equal(out.deltaPct, 0);
  assert.equal(out.bars, 3);
  assert.equal(out.pathHigh, 111);
  assert.equal(out.pathLow, 79);
  assert.ok((out.maxDrawdownPct as number) < -28);
});

test('the ruler accepts prices the chart never printed', () => {
  const candles = series([100, 110, 120]);
  const out = measure({ candles, granularitySec: 60, fromPrice: 100, toPrice: 150 }) as Record<string, unknown>;
  assert.equal(out.deltaAbs, 50);
  assert.equal(out.deltaPct, 50);
  assert.equal(out.direction, 'up');
});

test('a timeframe digest answers without moving the chart', () => {
  const candles = series(Array.from({ length: 60 }, (_, i) => 100 + i));
  const nowSec = (candles[candles.length - 1] as Candle).t + 20;
  const digest = digestSeries(candles, 60, nowSec);
  assert.equal(digest.trend, 'up');
  assert.equal(digest.bars, 60);
  assert.equal(digest.barClosesInSec, 40);
  assert.ok((digest.changePct as number) > 0);
});

test('a digest of nothing says so instead of inventing a trend', () => {
  const digest = digestSeries([], 60, 1_700_000_000);
  assert.equal(digest.trend, 'no data');
  assert.equal(digest.last, null);
});
