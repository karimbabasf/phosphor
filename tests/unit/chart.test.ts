// The chart view model: the clamps, the pane budget, the agent tag, and the ruler.
//
// The pane budget is the interesting one. The ask was a chart where nothing looks squeezed,
// and the only way to keep that promise is to refuse the pane that would not fit rather than
// shrink everything to make room. These tests are that promise, written down.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import {
  buildRead,
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
  assert.equal(snapTimeframe(3), 60, 'nothing under a minute exists any more, so it snaps up to the floor');
  assert.equal(snapTimeframe(90000), 86400);
  assert.equal(timeframeLabel(14400), '4h');
});

test('a sub-minute timeframe is refused, because no venue serves one', () => {
  const chart = createChartStore('BTC-USD');
  for (const tf of ['1s', '5s', '30s']) {
    const out = chart.setView({ timeframe: tf }, 'agent');
    assert.equal(out.ok, false, `${tf} should be refused`);
    assert.match(String(out.error), /one minute floor/);
  }
  assert.equal(chart.setView({ granularitySec: 30 }, 'agent').ok, false);
  assert.equal(chart.state().view.granularitySec, 60, 'and the view is left where it was');
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

test('history fetched covers the longest indicator warmup', () => {
  const chart = createChartStore('BTC-USD');
  chart.setView({ barCount: 120 }, 'human');
  chart.addIndicator({ type: 'ema', params: { period: 200 } }, 'agent');

  // The promise is that a 200 period line does not start in the middle of the screen.
  // It used to be kept by fetching exactly the window plus the warmup, which meant the
  // whole chart only ever held about 150 bars and a pan to the left ran off the end of
  // the data. The floor keeps the same promise with room behind the left edge.
  assert.ok(chart.historyNeeded() >= 120 + 200, 'the window and the warmup both fit');
  assert.ok(chart.historyNeeded() >= LIMITS.historyFloor, 'and there is history behind the left edge');
  assert.ok(chart.historyNeeded() <= LIMITS.historyMax);
});

test('history fetched still grows when a warmup asks for more than the floor', () => {
  const chart = createChartStore('BTC-USD');
  chart.setView({ barCount: 1600 }, 'human');
  const plain = chart.historyNeeded();
  chart.addIndicator({ type: 'ema', params: { period: 200 } }, 'agent');
  assert.ok(chart.historyNeeded() > plain, 'past the floor the warmup still moves the number');
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

test('a timeframe no venue serves natively is still charted', () => {
  // This used to be refused. No venue has a 7m candle, but the market layer folds seven
  // 1m bars into one, so there is no reason for the chart to say no. See src/market/aggregate.ts.
  const chart = createChartStore('BTC-USD');
  const out = chart.setView({ timeframe: '7m' }, 'agent');
  assert.equal(out.ok, true);
  assert.equal(chart.state().view.granularitySec, 420);

  assert.equal(chart.setView({ timeframe: '90s' }, 'agent').ok, true);
  assert.equal(chart.state().view.granularitySec, 90);
});

test('a timeframe that is not a timeframe is still refused, with a usable message', () => {
  const chart = createChartStore('BTC-USD');
  const out = chart.setView({ timeframe: 'banana' }, 'agent');
  assert.equal(out.ok, false);
  assert.match(String(out.error), /count and a unit/);

  const tooBig = chart.setView({ granularitySec: 60 * 60 * 24 * 400 }, 'agent');
  assert.equal(tooBig.ok, false, 'a year per bar is past anything the rails hold');
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

// The third drawing primitive. A level is horizontal and a mark is vertical, so before this
// the chart could name a price or a moment but not a trend, which is the commonest thing
// anyone draws. These tests pin the parts that are easy to get wrong once and never notice:
// the endpoints are stored oldest first, a zero-width line is refused instead of dividing by
// zero in the renderer, and the read reports where the line sits NOW rather than making the
// caller redo the arithmetic from two anchors.
test('a trendline keeps both endpoints and reports its slope and where it sits now', () => {
  const chart = createChartStore('SOL-USD');
  const t0 = 1_700_000_000;

  const out = chart.setTrendline({ t1: t0, p1: 100, t2: t0 + 3600, p2: 101, label: 'support' }, 'agent');
  assert.equal(out.ok, true);

  const tl = chart.state().trendlines[0];
  assert.equal(tl?.p1, 100);
  assert.equal(tl?.p2, 101);
  assert.equal(tl?.label, '[agent] support');
  assert.equal(chart.agentObjects(), 1, 'the human is told the agent drew something');

  // Three hourly bars, so the newest sits an hour past the second anchor and the line should
  // read 102 there: extended forward, not stopped at the last touch.
  const candles = series([100, 101, 102], 3600).map((c, i) => ({ ...c, t: t0 + i * 3600 }));
  const view = buildRead({
    state: chart.state(),
    candles,
    meta: { source: 'test', stale: false, built: 'test' },
    computed: [],
    nowSec: t0 + 2 * 3600,
  }) as { trendlines: { direction: string; slopePerHour: number; priceNow: number | null }[] };
  const read = view.trendlines[0];
  assert.equal(read?.direction, 'rising');
  assert.ok(Math.abs((read?.slopePerHour ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((read?.priceNow ?? 0) - 102) < 1e-9, 'the line is extended past its second anchor');
});

test('a trendline given its endpoints backwards stores them oldest first', () => {
  const chart = createChartStore('SOL-USD');
  const t0 = 1_700_000_000;

  chart.setTrendline({ t1: t0 + 3600, p1: 101, t2: t0, p2: 100 }, 'agent');

  const tl = chart.state().trendlines[0];
  assert.equal(tl?.t1, t0, 'the older anchor is first whichever order it arrived in');
  assert.equal(tl?.p1, 100);
  assert.equal(tl?.t2, t0 + 3600);
  assert.equal(tl?.p2, 101);
});

test('a trendline with one time for both endpoints is refused, not drawn vertical', () => {
  const chart = createChartStore('SOL-USD');
  const t0 = 1_700_000_000;

  const out = chart.setTrendline({ t1: t0, p1: 100, t2: t0, p2: 110 }, 'agent');

  assert.equal(out.ok, false);
  assert.match(String(out.error), /chart_mark/, 'the refusal names the tool that does want one moment');
  assert.equal(chart.state().trendlines.length, 0);
});

test('trendlines obey the clear targets, including the human way out of agent drawings', () => {
  const chart = createChartStore('SOL-USD');
  const t0 = 1_700_000_000;

  chart.setTrendline({ t1: t0, p1: 100, t2: t0 + 3600, p2: 101 }, 'agent');
  chart.setTrendline({ t1: t0, p1: 90, t2: t0 + 3600, p2: 91 }, 'human');

  chart.clear('agent');
  assert.equal(chart.state().trendlines.length, 1, 'clearing agent drawings leaves the human theirs');
  assert.equal(chart.state().trendlines[0]?.source, 'human');

  chart.clear('trendlines');
  assert.equal(chart.state().trendlines.length, 0);
});

// The symbol switch, with the patch the BROWSER actually sends.
//
// The test above this one passes and always did, because it sends `{product}` alone. The real
// client never sends that: ui/chart.js pushChart serialises the WHOLE view on every change,
// so a symbol switch arrives carrying the outgoing instrument's pan and price scale in the
// same object. The reset ran and then those two fields wrote themselves straight back over
// it, which is both of the complaints about this chart, from one line each.
test('a full-view push on a symbol switch cannot carry the old price scale across', () => {
  const chart = createChartStore('BTC-USD');
  // The human drags the price axis on BTC, so the scale is manual and in the 63k band.
  chart.setView({ priceLow: 63000, priceHigh: 64000 }, 'human');
  assert.equal(chart.state().view.priceScale.mode, 'manual');

  // Exactly what pushChart builds: every field, including the ones describing the old market.
  const out = chart.setView(
    {
      product: 'sol-usd',
      granularitySec: 60,
      barCount: 120,
      panOffset: 0,
      priceScale: 'manual',
      priceLow: 63000,
      priceHigh: 64000,
    },
    'human',
  );

  assert.equal(out.ok, true);
  assert.equal(chart.state().view.product, 'SOL-USD');
  // SOL trades near 150. A 63k axis draws every candle off the pane, which is "off-scale".
  assert.equal(chart.state().view.priceScale.mode, 'auto');
  assert.ok(out.ok && out.notes.some((n) => n.includes('price scale ignored')), 'and it says why');
});

test('a full-view push on a symbol switch cannot carry a stale pan across', () => {
  // This one bites even in auto mode. Panned back on a long series and switched to a shorter
  // one, the right edge goes negative, start passes end, no candle is scanned, and the domain
  // falls through to the degenerate 0..1 fallback in buildLayout. That is "compressed".
  const chart = createChartStore('BTC-USD');
  chart.setView({ panOffset: 300 }, 'human');
  assert.equal(chart.state().view.panOffset, 300);

  const out = chart.setView(
    { product: 'sol-usd', granularitySec: 60, barCount: 120, panOffset: 300, priceScale: 'auto' },
    'human',
  );

  assert.equal(chart.state().view.panOffset, 0);
  assert.ok(out.ok && out.notes.some((n) => n.includes('panOffset ignored')));
});

test('a pan sent WITHOUT a symbol change is still honoured', () => {
  // The guard is scoped to the switch itself. An agent that pans deliberately must still pan,
  // or the fix above would have cost a feature to buy a bug.
  const chart = createChartStore('BTC-USD');
  const out = chart.setView({ panOffset: 40 }, 'agent');
  assert.equal(out.ok, true);
  assert.equal(chart.state().view.panOffset, 40);
  assert.ok(out.ok && !out.notes.some((n) => n.includes('ignored')));
});

test('re-sending the SAME product is not a switch, so the window is left alone', () => {
  // pushChart names the product on every write, including a plain zoom. Treating every push
  // that mentions a product as a switch would reset the view on every drag.
  const chart = createChartStore('BTC-USD');
  chart.setView({ panOffset: 25, priceLow: 100, priceHigh: 200 }, 'human');
  chart.setView({ product: 'BTC-USD', panOffset: 25, priceScale: 'manual', priceLow: 100, priceHigh: 200 }, 'human');
  assert.equal(chart.state().view.panOffset, 25);
  assert.equal(chart.state().view.priceScale.mode, 'manual');
});
