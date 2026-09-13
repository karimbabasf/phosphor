// The account drawn over the price: what the trading overlays hand the chart's one label
// column, and in which ink.
//
// Two things are held here. Every ink is a token asked for by meaning (liquidation is down, the
// agent's plan is agent, the wall is warn) and no hex lives in the overlay file. And a plan that
// has not fired is drawn as its shape: entry, stop and target as three labelled lines and the
// two washes between them at a twentieth of full strength, which is how a strategy is shown
// without prose.
//
// Runs the real chart.js, labels.js and trade-overlay.js in one context over a fake 2d
// context that records what it was asked to paint.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

function load(): Any {
  const sandbox: Any = {
    window: {
      requestAnimationFrame: () => 1,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {} },
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
  for (const file of ['../../ui/chart/chart.js', '../../ui/chart/labels.js', '../../ui/chart/trade-overlay.js']) {
    runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

function bars(count: number): Any[] {
  const out: Any[] = [];
  for (let i = 0; i < count; i++) out.push({ t: 1_760_000_400 + i * 60, o: 100, h: 104, l: 96, c: i % 2 ? 98 : 102, v: 10 });
  return out;
}

function fakeCtx() {
  const fills: Array<{ style: string; y: number; h: number }> = [];
  const strokes: string[] = [];
  const ctx: Any = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    fillRect: (_x: number, y: number, _w: number, h: number) => fills.push({ style: ctx.fillStyle, y, h }),
    fillText: () => {},
    strokeRect: () => {},
    setLineDash: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: () => {},
    arc: () => {},
    stroke: () => strokes.push(ctx.strokeStyle),
  };
  return { ctx, fills, strokes };
}

function ready(s: Any, trade: Any): Any {
  s.CHART.candles = bars(40);
  s.CHART.view = { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: 40, panOffset: 0, priceScale: { mode: 'auto' } };
  s.CHART.dataView = { product: 'BTC-USD', granularitySec: 60 };
  s.window.TRADE = trade;
  const { ctx } = fakeCtx();
  const L = s.buildLayout(900, 600, ctx);
  s.CHART_SCENE_LABELS = [];
  return L;
}

const plan = (over: Any = {}) => ({
  id: 'pl_1',
  symbol: 'BTC',
  side: 'long',
  sizeUsd: 200,
  leverage: 3,
  entry: { type: 'limit', px: 100 },
  stop: 97,
  target: 103,
  status: 'waiting',
  cloids: {},
  gen: 0,
  hash: 'h',
  createdAt: '',
  updatedAt: '',
  ...over,
});

test('no hex colour lives in the overlay: every ink is a token asked for by meaning', () => {
  const source = readFileSync(new URL('../../ui/chart/trade-overlay.js', import.meta.url), 'utf8');
  assert.equal(/#[0-9a-fA-F]{6}\b/.test(source), false, 'a hex colour in the overlay');
  assert.ok(source.includes("chartInk('down'"), 'the liquidation and the stop draw in the down token');
  assert.ok(!/[A-Z]{3,}\s+[A-Z]{2,}/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'a tracked-caps label survives');
});

test('a plan is drawn as its band: entry in the agent ink, stop in down, target in ink, washes at 0.05', () => {
  const s = load();
  const L = ready(s, { symbol: 'BTC', overlays: { planStop: true }, positions: [], orders: [], fills: [], plans: [plan()] });
  const { ctx, fills } = fakeCtx();
  s.drawTradeOverlays(ctx, L);

  const labels = s.CHART_SCENE_LABELS.map((l: Any) => [l.text, l.tone]);
  assert.deepEqual(labels, [
    ['Plan long  100.0', 'agent'],
    ['Stop  97.0', 'down'],
    ['Target  103.0', 'ink'],
  ]);
  // Two washes, one each side of the entry, both at a twentieth of full strength.
  const washes = fills.filter((f) => f.style.endsWith('0.05)'));
  assert.equal(washes.length, 2, JSON.stringify(fills));
  assert.ok(washes[0].style.startsWith('rgba(255, 90, 110'), 'the stop side is the down token');
  assert.ok(washes[1].style.startsWith('rgba(' + s.RGB_ACCENT), 'the target side is the ink');
  // The stop wash covers entry to stop: a 3 point band, taller than nothing and under the pane.
  assert.ok(washes[0].h > 0 && washes[0].h < L.priceHeight);
});

test('the plan stop overlay hides the stop leg and nothing else', () => {
  const s = load();
  const L = ready(s, { symbol: 'BTC', overlays: { planStop: false }, positions: [], orders: [], fills: [], plans: [plan()] });
  const { ctx, fills } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  const labels = s.CHART_SCENE_LABELS.map((l: Any) => l.text);
  assert.deepEqual(labels, ['Plan long  100.0', 'Target  103.0']);
  assert.equal(fills.filter((f) => f.style.endsWith('0.05)')).length, 1);
});

test('a done plan is not on the chart, and a plan on another coin is not either', () => {
  const s = load();
  const L = ready(s, {
    symbol: 'BTC',
    overlays: { planStop: true },
    positions: [],
    orders: [],
    fills: [],
    plans: [plan({ status: 'done', endReason: 'stopped' }), plan({ id: 'pl_2', symbol: 'ETH' })],
  });
  const { ctx } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  assert.equal(s.CHART_SCENE_LABELS.length, 0);
});

test('an open plan draws from the fill it got, not the price it asked for', () => {
  const s = load();
  const L = ready(s, { symbol: 'BTC', overlays: {}, positions: [], orders: [], fills: [], plans: [plan({ status: 'open', fillPx: 101 })] });
  const { ctx } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  assert.equal(s.CHART_SCENE_LABELS[0].text, 'Plan long  101.0');
});

test('a position prints in sentence case with its entry in the text ink and its liquidation in down', () => {
  const s = load();
  const L = ready(s, {
    symbol: 'BTC',
    overlays: { position: true, liquidation: true },
    positions: [{ coin: 'BTC', side: 'long', notionalUsd: 30000, entryPx: 100, liqPx: 97, unrealisedUsd: 1000, leverage: 10 }],
    orders: [],
    fills: [],
    plans: [],
  });
  const { ctx, strokes } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  const labels = s.CHART_SCENE_LABELS.map((l: Any) => [l.text, l.tone]);
  assert.deepEqual(labels, [
    ['Liquidation BTC  97.0', 'down'],
    ['Long $30,000 at 10x  +$1,000  100.0', 'text'],
  ]);
  assert.ok(strokes[0].startsWith('rgba(255, 90, 110'), 'the liquidation line is the one red on the canvas');
});

test('the spotlight rings the object the agent is pointing at', () => {
  const s = load();
  s.window.chartSpotActive = (kind: string, id: string) => kind === 'plan' && id === 'pl_1';
  const L = ready(s, { symbol: 'BTC', overlays: {}, positions: [], orders: [], fills: [], plans: [plan()] });
  const { ctx } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  const rings = s.CHART_SCENE_LABELS.filter((l: Any) => l.ring === true).map((l: Any) => l.text);
  assert.deepEqual(rings, ['Plan long  100.0']);
});

test('the legend and the overlays share one column, so no two labels print on one y', () => {
  const s = load();
  const L = ready(s, {
    symbol: 'BTC',
    overlays: { position: true, liquidation: true },
    positions: [{ coin: 'BTC', side: 'long', notionalUsd: 30000, entryPx: 100, liqPx: 99.9, unrealisedUsd: 0, leverage: 10 }],
    orders: [],
    fills: [],
    plans: [],
  });
  const { ctx } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  const printed: Array<[string, number]> = [];
  const hud: Any = {
    ...fakeCtx().ctx,
    fillText: (t: string, _x: number, y: number) => printed.push([String(t), y]),
  };
  s.CHART_HITS = [];
  s.drawLegend(hud, L);
  const ys = printed.map(([, y]) => y);
  const distinct = new Set(ys.map((y) => Math.round(y)));
  // The market line, the liquidation and the entry: three lines, three ys, none shared.
  assert.ok(distinct.size >= 3, JSON.stringify(printed));
  const sorted = [...distinct].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i] - sorted[i - 1] >= 13, `two labels ${sorted[i] - sorted[i - 1]} px apart`);
  assert.equal(printed[0][0], 'BTC-USD');
  assert.equal(printed[0][1], 16, 'the column starts at y 16');
});
