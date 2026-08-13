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

/* ui/chart.js is a browser script, not a module: it declares vars and functions and does
   nothing until chartBoot is called. Running it in a context makes every one of those a
   property of the sandbox, which is the whole test surface. */
function loadChartUi(): Sandbox {
  const source = readFileSync(new URL('../../ui/chart.js', import.meta.url), 'utf8');
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
  runInContext(source, sandbox, { filename: 'ui/chart.js' });
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

test('an agent switching product still owns the view', () => {
  const s = loadChartUi();
  s.applyChart(payload({ view: viewOf('BTC-USD') }));
  s.applyChart(payload({ lastDriver: 'agent', view: viewOf('SOL-USD', 300, { panOffset: 12 }) }));

  assert.equal(s.CHART.view.product, 'SOL-USD');
  assert.equal(s.CHART.view.panOffset, 12);
  assert.equal(legendWords(s)[0], 'SOL-USD');
});
