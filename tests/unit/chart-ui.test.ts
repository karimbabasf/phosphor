// The window draws candles the server sent and a name the window itself is holding, and
// those two can disagree. These tests are about the disagreement: a name over a price is a
// claim about which market that price belongs to, and a wrong one is worse than a blank
// chart, because it reads as correct.
//
// The bug they lock down: the window sat on SOL-USD while every payload carried BTC-USD
// bars, and the label stayed on SOL-USD until the page was reloaded. Both halves of it are
// here, the durable one (a restarted server, a lost view write) and the one-second one (a
// payload crossing a switch on the wire).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

/* ui/chart/chart.js is a browser script, not a module: it declares vars and functions and does
   nothing until chartBoot is called. Running it in a context makes every one of those a
   property of the sandbox, which is the whole test surface. */
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
  // The label column the engine draws its legend through lives in its own file.
  runInContext(readFileSync(new URL('../../ui/chart/labels.js', import.meta.url), 'utf8'), sandbox, { filename: 'ui/chart/labels.js' });
  return sandbox;
}

const TIMEFRAMES = [
  { sec: 60, label: '1m' },
  { sec: 300, label: '5m' },
];

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rev: 2,
    lastDriver: 'human',
    view: { product: 'BTC-USD', granularitySec: 60, barCount: 120, panOffset: 0, priceScale: { mode: 'auto' } },
    candles: [{ t: 1_760_000_000, o: 63893, h: 63903, l: 63893, c: 63900, v: 12 }],
    meta: { source: 'hyperliquid', stale: false, built: 'candles' },
    indicators: [],
    levels: [],
    marks: [],
    products: ['BTC-USD', 'SOL-USD'],
    timeframes: TIMEFRAMES,
    ...over,
  };
}

function viewOf(product: string, granularitySec = 60, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { product, granularitySec, barCount: 120, panOffset: 0, priceScale: { mode: 'auto' }, ...over };
}

/* Everything the legend printed, in order. The first word is the name of the market it just
   claimed those prices belong to. */
function legendWords(sandbox: Sandbox): string[] {
  const printed: string[] = [];
  const ctx = {
    fillStyle: '',
    fillText: (text: string) => {
      printed.push(String(text));
    },
    fillRect: () => {},
    strokeRect: () => {},
    measureText: (text: string) => ({ width: String(text).length * 6 }),
  };
  const layout = { decimals: 1, overlays: [], panes: [], dropped: [], axisTop: 100 };
  sandbox.drawLegend(ctx, layout);
  return printed;
}

test('a payload naming another market moves the window onto it', () => {
  const s = loadChartUi();
  // The window is on SOL-USD and settled: nothing of ours is on the wire.
  s.applyChart(payload({ view: viewOf('SOL-USD') }));
  assert.equal(s.CHART.view.product, 'SOL-USD');

  // The server comes back on its default product, which is what a restart looks like from
  // here. lastDriver is 'human' in that payload, so the old rule kept the SOL-USD name.
  s.applyChart(payload({ view: viewOf('BTC-USD') }));

  assert.equal(s.CHART.view.product, 'BTC-USD');
  assert.equal(legendWords(s)[0], 'BTC-USD');
});

test('the legend names the bars on screen, not the switch still in flight', () => {
  const s = loadChartUi();
  s.applyChart(payload({ view: viewOf('BTC-USD') }));

  // The hand has just picked SOL-USD and the write is on the wire. A BTC-USD payload that
  // left before it landed is not an answer to it.
  s.CHART.view.product = 'SOL-USD';
  s.CHART_PUSH_WAIT = 1;
  s.applyChart(payload({ view: viewOf('BTC-USD', 300) }));

  assert.equal(s.CHART.view.product, 'SOL-USD', 'the hand is not overruled by a payload that crossed it');
  const words = legendWords(s);
  assert.equal(words[0], 'BTC-USD', 'the prices drawn are BTC-USD, so the name has to be');
  assert.equal(words[1], '5m', 'the bar length follows the same payload as the bars');
});

test('pan and price scale stay with the hand', () => {
  const s = loadChartUi();
  s.applyChart(payload({ view: viewOf('BTC-USD') }));

  s.CHART.view.panOffset = 40;
  s.CHART.view.priceScale = { mode: 'manual', low: 63_000, high: 64_000 };
  s.applyChart(payload({ view: viewOf('BTC-USD') }));

  assert.equal(s.CHART.view.panOffset, 40);
  assert.equal(s.CHART.view.priceScale.mode, 'manual');
});

// ---------- the markup part ----------

const T0 = 1_760_000_000;

function bar(t: number, c = 100): Record<string, number> {
  return { t, o: c - 1, h: c + 1, l: c - 2, c, v: 1 };
}

function series(first: number, count: number): Record<string, number> {
  return { first, last: first + (count - 1) * 60, count };
}

test('a markup part keeps the candles held and lays its plots over them by time', () => {
  const s = loadChartUi();
  const held = [0, 1, 2, 3, 4].map((i) => bar(T0 + i * 60));
  s.applyChart(payload({ candles: held, series: series(T0, 5), candlesRev: 7 }));
  assert.equal(s.CHART.candlesRev, 7);
  // Two older bars backfilled behind the left edge since, so the array is longer than any
  // series the server will name.
  s.CHART.candles = [bar(T0 - 120), bar(T0 - 60)].concat(s.CHART.candles);

  // The server's window has moved on by a bar: its series starts at the second bar held.
  const markup = payload({
    rev: 3,
    series: series(T0 + 60, 4),
    candlesRev: 8,
    indicators: [{ id: 'ema-1', type: 'ema', label: '[agent] ema 2', pane: 'price', source: 'agent', plots: [{ key: 'ema', values: [1, 2, 3, 4] }] }],
    levels: [{ id: 'level-1', price: 101, label: '[agent] ceiling', source: 'agent' }],
  });
  delete markup.candles;
  s.applyChart(markup);

  assert.equal(s.CHART.candles.length, 7, 'no candle moved');
  assert.equal(s.CHART.rev, 3);
  assert.equal(s.CHART.candlesRev, 8);
  assert.equal(s.CHART.levels.length, 1, 'the level landed');
  assert.deepEqual([...s.CHART.indicators[0].plots[0].values], [null, null, null, 1, 2, 3, 4], 'value k of the plot sits on bar k of the series it was computed over');
});

test('a markup part over a series the window does not hold asks for the full part instead of drawing it', async () => {
  const s = loadChartUi();
  s.applyChart(payload({ candles: [bar(T0), bar(T0 + 60)], series: series(T0, 2), candlesRev: 1 }));
  const asked: string[] = [];
  s.fetch = async (url: string) => {
    asked.push(url);
    return { ok: true, json: async () => payload({ candles: [bar(T0 - 60), bar(T0), bar(T0 + 60)], series: series(T0 - 60, 3), candlesRev: 2, levels: [{ id: 'level-1', price: 1, label: 'x', source: 'agent' }] }) };
  };
  // A study with a long warmup made the server's series reach further back than this window has.
  const markup = payload({ series: series(T0 - 60, 3), candlesRev: 2, levels: [{ id: 'level-1', price: 1, label: 'x', source: 'agent' }] });
  delete markup.candles;
  s.applyChart(markup);
  assert.equal(s.CHART.levels.length, 0, 'nothing of it is applied half way');
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['/api/chart'], 'the whole payload is fetched');
  assert.equal(s.CHART.candles.length, 3);
  assert.equal(s.CHART.levels.length, 1);
});

test('a full payload keeps the older bars backfilled behind the left edge, and drops them for another market', () => {
  const s = loadChartUi();
  s.applyChart(payload({ candles: [bar(T0), bar(T0 + 60)], series: series(T0, 2) }));
  s.CHART.candles = [bar(T0 - 120), bar(T0 - 60)].concat(s.CHART.candles);
  s.applyChart(payload({ candles: [bar(T0 + 60), bar(T0 + 120)], series: series(T0 + 60, 2) }));
  assert.deepEqual(s.CHART.candles.map((c: { t: number }) => c.t), [T0 - 120, T0 - 60, T0, T0 + 60, T0 + 120]);
  s.applyChart(payload({ view: viewOf('SOL-USD'), candles: [bar(T0 + 120)], series: series(T0 + 120, 1) }));
  assert.deepEqual(s.CHART.candles.map((c: { t: number }) => c.t), [T0 + 120], 'another instrument shares nothing with the old one');
});

test('a chart frame fetches the markup part, and a nudge the whole thing', async () => {
  const s = loadChartUi();
  const asked: string[] = [];
  s.fetch = async (url: string) => {
    asked.push(url);
    return { ok: true, json: async () => payload({ series: series(T0, 1) }) };
  };
  s.CHART_MY_REV = 1;
  s.chartPushed(2);
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['/api/chart?part=markup']);
  s.chartPushed(1);
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['/api/chart?part=markup'], 'the echo of our own write is dropped');
  s.candlesPushed();
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['/api/chart?part=markup', '/api/chart']);
});

test('an agent switching product still owns the view', () => {
  const s = loadChartUi();
  s.applyChart(payload({ view: viewOf('BTC-USD') }));
  s.applyChart(payload({ lastDriver: 'agent', view: viewOf('SOL-USD', 300, { panOffset: 12 }) }));

  assert.equal(s.CHART.view.product, 'SOL-USD');
  assert.equal(s.CHART.view.panOffset, 12);
  assert.equal(legendWords(s)[0], 'SOL-USD');
});
