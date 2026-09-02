// The chart's chrome: the palette it is drawn in, and the volume pane it now shows by default.
//
// buildLayout is called directly. It is the function that decides what fits, and everything
// visible follows from what it returns, so it is the honest unit to test: a fake 2d context
// only has to answer measureText, which is all the geometry depends on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME } from '../../src/view/theme.ts';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

function loadChartUi(): Sandbox {
  const source = readFileSync(new URL('../../ui/chart/chart.js', import.meta.url), 'utf8');
  const store: Record<string, string> = {};
  const sandbox: Sandbox = {
    window: {
      requestAnimationFrame: () => 1,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      localStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
      },
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

// Only measureText is read out of the context, and only to size the price axis.
const fakeCtx = { font: '', measureText: (text: string) => ({ width: text.length * 6 }) };

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function bars(count: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const up = i % 2 === 0;
    out.push({
      t: 1_760_000_400 + i * 60,
      o: 100,
      h: 104,
      l: 96,
      c: up ? 102 : 98,
      v: 10 + i,
    });
  }
  return out;
}

function ready(sandbox: Sandbox, over: Record<string, unknown> = {}): void {
  sandbox.CHART.candles = bars(40);
  sandbox.CHART.view = {
    product: 'BTC-USD',
    provider: 'auto',
    granularitySec: 60,
    barCount: 40,
    panOffset: 0,
    priceScale: { mode: 'auto' },
  };
  sandbox.CHART.dataView = { product: 'BTC-USD', granularitySec: 60 };
  Object.assign(sandbox.CHART, over);
}

const paneOf = (layout: any, label: string) =>
  layout.panes.find((p: any) => p.indicator.label === label);

// ---------- the palette ----------

test('the chart is not green any more, and every ink is a design token', () => {
  const s = loadChartUi();
  assert.equal(s.C_UP, '#5B8DEF');
  assert.equal(s.C_DOWN, '#FF5A6E');
  assert.equal(s.CHART_TOKENS.line, '#22242A');
  assert.equal(s.CHART_TOKENS.text2, '#9A9EA8');
  // The four inks the engine mixes from, named for meaning rather than for a colour.
  assert.equal(s.accent(0.5), 'rgba(91, 141, 239, 0.5)');
  assert.equal(s.danger(1), 'rgba(255, 90, 110, 1)');
  assert.equal(s.lineInk(1), 'rgba(34, 36, 42, 1)');
  assert.equal(s.text2(0.7), 'rgba(154, 158, 168, 0.7)');
  assert.equal(typeof s.green, 'undefined', 'a function called green() returning blue is a lie');
});

test('the shipped defaults leave the chart on its tokens, and a chosen colour wins', () => {
  const s = loadChartUi();
  // The transitional guard that used to sit here compared each slot against the
  // old green defaults and refused them. src/view/theme.ts now ships the design
  // tokens, so a default state frame carries the same values the chart already
  // holds and there is nothing left to refuse.
  s.chartTheme(DEFAULT_THEME);
  assert.equal(s.C_UP, 'rgb(91, 141, 239)');
  assert.equal(s.RGB_ACCENT, '91, 141, 239');

  // A colour somebody actually picked still wins. That is what the tool is for.
  s.chartTheme({ ...DEFAULT_THEME, up: '#ffaa00' });
  assert.equal(s.C_UP, 'rgb(255, 170, 0)');
});

// ---------- the volume pane ----------

test('volume is a default, not a word you have to know', () => {
  const s = loadChartUi();
  ready(s);
  const layout = s.buildLayout(900, 600, fakeCtx);
  const pane = paneOf(layout, 'volume');
  assert.ok(pane, 'every chart a trader compares this one to shows volume without being asked');
  assert.equal(layout.panes[0].indicator.label, 'volume', 'it sits directly under the price');
  // About 14 percent of the usable height: read as a shape beside the price, not as a series
  // with values to pick off. Capped at the same ceiling every other pane has, so volume cannot
  // eat a tall chart.
  const usable = 600 - 18 - 3;
  const want = Math.min(usable * 0.14, 96);
  assert.ok(Math.abs(pane.height - want) < 1, `expected ~${want}, got ${pane.height}`);
  assert.equal(layout.priceHeight, usable - pane.height);
});

test('the histogram is the candles being drawn, direction beside it rather than folded in', () => {
  const s = loadChartUi();
  ready(s);
  const plot = paneOf(s.buildLayout(900, 600, fakeCtx), 'volume').indicator.plots[0];
  assert.equal(plot.style, 'histogram');
  assert.deepEqual([...plot.values.slice(0, 3)], [10, 11, 12]);
  // Volume is never negative, so folding the direction into the value would put half the bars
  // under an axis that does not exist.
  assert.deepEqual([...plot.signs.slice(0, 3)], [1, -1, 1]);
});

test('a live bar moves the histogram in the same frame it moves the price', () => {
  const s = loadChartUi();
  ready(s);
  s.CHART.meta = { source: 'hyperliquid', stale: false, built: 'candles', error: null };
  const last = s.CHART.candles[s.CHART.candles.length - 1];
  s.candleLive({
    type: 'candle',
    product: 'BTC-USD',
    provider: 'hyperliquid',
    baseSec: 60,
    candle: { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c, v: 999 },
  });
  const plot = paneOf(s.buildLayout(900, 600, fakeCtx), 'volume').indicator.plots[0];
  assert.equal(plot.values[plot.values.length - 1], 999);
});

test('a volume indicator somebody actually added wins, so the histogram is not drawn twice', () => {
  const s = loadChartUi();
  ready(s, {
    indicators: [
      { id: 'volume', label: 'volume', pane: 'volume', source: 'human', plots: [{ style: 'histogram', values: [] }] },
    ],
  });
  const layout = s.buildLayout(900, 600, fakeCtx);
  const volumes = layout.panes.filter((p: any) => p.indicator.label === 'volume');
  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].indicator.source, 'human', 'the real one, computed by src/indicators.ts');
});

test('volume is dropped, silently, before the price pane stops being readable', () => {
  const s = loadChartUi();
  ready(s);
  // A short panel. A chart that quietly squashes everything to fit is worse than one that
  // says what it could not show, and volume is the one pane nobody asked for.
  const layout = s.buildLayout(900, 170, fakeCtx);
  assert.equal(paneOf(layout, 'volume'), undefined);
  assert.deepEqual([...layout.dropped], [], 'dropping the pane nobody asked for is not worth a complaint');
});

test('an indicator pane keeps its room and volume gives up its own first', () => {
  const s = loadChartUi();
  ready(s, {
    indicators: [{ id: 'rsi', label: 'rsi 14', pane: 'rsi', source: 'human', plots: [{ style: 'line', values: [] }] }],
  });
  const tight = s.buildLayout(900, 260, fakeCtx);
  assert.ok(paneOf(tight, 'rsi 14'), 'the pane somebody asked for outranks the default');
  assert.equal(paneOf(tight, 'volume'), undefined);

  const roomy = s.buildLayout(900, 600, fakeCtx);
  assert.ok(paneOf(roomy, 'volume'));
  assert.ok(paneOf(roomy, 'rsi 14'));
});

test('the pane can be put away and offers the way back', () => {
  const s = loadChartUi();
  ready(s);
  assert.ok(paneOf(s.buildLayout(900, 600, fakeCtx), 'volume'));
  s.toggleVolume();
  assert.equal(paneOf(s.buildLayout(900, 600, fakeCtx), 'volume'), undefined);
  // Remembered, so a person who put it away does not put it away again every morning.
  assert.equal(s.window.localStorage.getItem('phosphor.chart.volume'), '0');
  s.toggleVolume();
  assert.ok(paneOf(s.buildLayout(900, 600, fakeCtx), 'volume'));
});

// ---------- the gutter ----------

test('the right gutter is wide enough for the tag and the countdown to stop competing', () => {
  const s = loadChartUi();
  ready(s);
  s.buildLayout(900, 600, fakeCtx);
  // The tag sits in this column and the draining rule sits under it. At the old floor of 48
  // they were fighting for the same pixels.
  assert.ok(s.CHART_AXIS_W >= 66, `expected a floor of 66, got ${s.CHART_AXIS_W}`);
});
