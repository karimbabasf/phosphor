// The account drawn over the price: what the trading overlays hand the chart's chips on the
// price axis, and in which ink.
//
// Three things are held here. Every ink is a token asked for by meaning, no hex lives in the
// overlay file, and red is a loss: the liquidation and a stop, never a sell or a short. A plan is
// drawn as its shape, entry and target in green and the stop in the loss colour, with the two
// washes between them at a twentieth of full strength, dashed until the venue holds its orders.
// And nothing the account draws prints over the candles: every line names itself in a chip on
// the price axis, and the chips never overlap one another or the last price.
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
  const strokes: Array<{ style: string; dash: number[]; width: number }> = [];
  const texts: Array<{ text: string; x: number; y: number; ink: string }> = [];
  let dash: number[] = [];
  const ctx: Any = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    fillRect: (_x: number, y: number, _w: number, h: number) => fills.push({ style: String(ctx.fillStyle), y, h }),
    fillText: (t: string, x: number, y: number) => texts.push({ text: String(t), x, y, ink: String(ctx.fillStyle) }),
    strokeRect: () => {},
    setLineDash: (d: number[]) => {
      dash = d.slice();
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    rect: () => {},
    fill: () => {},
    arc: () => {},
    save: () => {},
    restore: () => {},
    clip: () => {},
    stroke: () => strokes.push({ style: String(ctx.strokeStyle), dash, width: ctx.lineWidth }),
  };
  return { ctx, fills, strokes, texts };
}

/* A chart already carrying chips: the axis has grown to name them, which the engine measures on
   one frame and applies from the next, so the layout is built twice. */
function ready(s: Any, trade: Any): Any {
  s.CHART.candles = bars(40);
  s.CHART.view = { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: 40, panOffset: 0, priceScale: { mode: 'auto' } };
  s.CHART.dataView = { product: 'BTC-USD', granularitySec: 60 };
  s.window.TRADE = trade;
  s.CHART_CHIP_W = s.CHIP_AXIS_MAX;
  const { ctx } = fakeCtx();
  s.buildLayout(900, 600, ctx);
  const L = s.buildLayout(900, 600, ctx);
  s.CHART_AXIS_CHIPS = [];
  return L;
}

const chips = (s: Any): Array<[string, string, string]> => s.CHART_AXIS_CHIPS.map((c: Any) => [c.word, c.tone, c.edge]);

const plan = (over: Any = {}) => ({
  id: 'pl_1',
  symbol: 'BTC',
  side: 'long',
  sizeUsd: 200,
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

test('a plan is drawn as its shape: entry and target in green, the stop in the loss colour, washes at 0.05, dashed until it is live', () => {
  const s = load();
  const L = ready(s, { symbol: 'BTC', overlays: { planStop: true }, positions: [], orders: [], fills: [], plans: [plan()] });
  const { ctx, fills, strokes } = fakeCtx();
  s.drawTradeOverlays(ctx, L);

  assert.deepEqual(chips(s), [
    ['Plan long', 'up', 'at'],
    ['Stop', 'down', 'at'],
    ['Target', 'up', 'at'],
  ]);
  assert.deepEqual(s.CHART_AXIS_CHIPS.map((c: Any) => c.price), [100, 97, 103], 'each chip carries its own price');
  // Two washes, one each side of the entry, both at a twentieth of full strength.
  const washes = fills.filter((f) => f.style.endsWith('0.05)'));
  assert.equal(washes.length, 2, JSON.stringify(fills));
  assert.ok(washes[0].style.startsWith('rgba(' + s.RGB_DOWN), 'the stop side is the down token');
  assert.ok(washes[1].style.startsWith('rgba(' + s.RGB_ACCENT), 'the target side is the green');
  assert.ok(washes[0].h > 0 && washes[0].h < L.priceHeight);
  // Waiting is not live: every leg is dashed.
  assert.equal(strokes.length, 3);
  assert.ok(strokes.every((st) => st.dash.length === 2), JSON.stringify(strokes));
  assert.ok(strokes[0].style.startsWith('rgba(' + s.RGB_ACCENT), 'the entry is green, not the agent violet');
});

test('the plan stop overlay hides the stop leg and nothing else', () => {
  const s = load();
  const L = ready(s, { symbol: 'BTC', overlays: { planStop: false }, positions: [], orders: [], fills: [], plans: [plan()] });
  const { ctx, fills } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  assert.deepEqual(chips(s).map((c) => c[0]), ['Plan long', 'Target']);
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
  assert.equal(s.CHART_AXIS_CHIPS.length, 0);
});

test('an open plan draws from the fill it got, solid, because the venue holds its orders now', () => {
  const s = load();
  const L = ready(s, { symbol: 'BTC', overlays: {}, positions: [], orders: [], fills: [], plans: [plan({ status: 'open', fillPx: 101 })] });
  const { ctx, strokes } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  assert.equal(s.CHART_AXIS_CHIPS[0].word, 'Plan long');
  assert.equal(s.CHART_AXIS_CHIPS[0].price, 101);
  assert.ok(strokes.every((st) => st.dash.length === 0), JSON.stringify(strokes));
});

test('a position names its side in the text ink, and its liquidation is the one red wall', () => {
  const s = load();
  const L = ready(s, {
    symbol: 'BTC',
    overlays: { position: true, liquidation: true },
    positions: [{ coin: 'BTC', side: 'long', notionalUsd: 30000, entryPx: 100, liqPx: 97, unrealisedUsd: 1000 }],
    orders: [],
    fills: [],
    plans: [],
  });
  const { ctx, strokes } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  assert.deepEqual(chips(s), [
    ['Liquidation', 'down', 'at'],
    ['Long', 'text', 'at'],
  ]);
  assert.ok(strokes[0].style.startsWith('rgba(' + s.RGB_DOWN), 'the liquidation line is the one red on the canvas');
  assert.ok(strokes.every((st) => st.dash.length === 0), 'both are facts, so both are solid');
});

test('a sell order and a sell fill are not red: a direction is not a loss', () => {
  const s = load();
  const L = ready(s, {
    symbol: 'BTC',
    overlays: { orders: true, fills: true },
    positions: [],
    orders: [{ oid: 7, coin: 'BTC', side: 'sell', kind: 'limit', px: 101, notionalUsd: 250, reduceOnly: false }],
    fills: [{ tid: 't1', coin: 'BTC', side: 'sell', px: 101, notionalUsd: 250, tSec: 1_760_000_400 + 20 * 60, liquidation: false }],
    plans: [],
  });
  const { ctx, strokes } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  assert.deepEqual(chips(s), [['Sell $250.00', 'text2', 'at']]);
  assert.ok(!strokes.some((st) => st.style.startsWith('rgba(' + s.RGB_DOWN)), JSON.stringify(strokes));
});

test('the spotlight rings the object the agent is pointing at', () => {
  const s = load();
  s.window.chartSpotActive = (kind: string, id: string) => kind === 'plan' && id === 'pl_1';
  const L = ready(s, { symbol: 'BTC', overlays: {}, positions: [], orders: [], fills: [], plans: [plan()] });
  const { ctx } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  const rings = s.CHART_AXIS_CHIPS.filter((c: Any) => c.ring === true).map((c: Any) => c.word);
  assert.deepEqual(rings, ['Plan long']);
});

test('nothing the account draws prints over the candles: the column is the legend, every name is a chip on the axis', () => {
  const s = load();
  const L = ready(s, {
    symbol: 'BTC',
    overlays: { position: true, liquidation: true },
    positions: [{ coin: 'BTC', side: 'long', notionalUsd: 30000, entryPx: 100, liqPx: 99.9, unrealisedUsd: 0 }],
    orders: [],
    fills: [],
    plans: [plan()],
  });
  const scene = fakeCtx();
  s.drawTradeOverlays(scene.ctx, L);
  L.chips = s.chipLayout(L);
  const hud = fakeCtx();
  s.CHART_HITS = [];
  s.drawLegend(hud.ctx, L);
  assert.equal(hud.texts[0]?.text, 'BTC');
  assert.equal(hud.texts[0]?.y, s.LEGEND_Y, 'the market line sits in its strip');
  assert.ok(!hud.texts.some((t) => /Long|Liquidation|Plan|Stop|Target/.test(t.text)), JSON.stringify(hud.texts));
  const axis = fakeCtx();
  s.drawAxisChips(axis.ctx, L);
  for (const word of ['Long', 'Liquidation', 'Plan long', 'Stop', 'Target']) {
    const at = axis.texts.find((t) => t.text === word);
    assert.ok(at, `${word} is named: ${JSON.stringify(axis.texts.map((t) => t.text))}`);
    assert.ok(at.x > L.plotWidth, `${word} is on the axis, not over the candles`);
  }
});

test('a plan line off the pane is a chip at the edge it went off, inside the pane on the axis', () => {
  const s = load();
  // Candles run 96 to 104: the stop at 80 and the target at 120 are both off the pane.
  const L = ready(s, { symbol: 'BTC', overlays: { planStop: true }, positions: [], orders: [], fills: [], plans: [plan({ stop: 80, target: 120 })] });
  const { ctx } = fakeCtx();
  s.drawTradeOverlays(ctx, L);
  assert.deepEqual(chips(s), [
    ['Plan long', 'up', 'at'],
    ['Stop', 'down', 'bottom'],
    ['Target', 'up', 'top'],
  ]);
  const laid = s.chipLayout(L);
  const top = laid.find((c: Any) => c.edge === 'top');
  const bottom = laid.find((c: Any) => c.edge === 'bottom');
  assert.ok(top.y >= L.priceTop && bottom.y + bottom.h <= L.priceTop + L.priceHeight, 'both inside the pane on the axis');
  const hud = fakeCtx();
  s.drawAxisChips(hud.ctx, { ...L, chips: laid });
  const drawn = hud.texts.map((t) => t.text);
  assert.ok(drawn.includes('Stop') && drawn.includes('80.0'), JSON.stringify(drawn));
});

test('the axis grows to name its chips, from a floor that fits a short word to a ceiling a long one is cut at', () => {
  const s = load();
  const { ctx } = fakeCtx();
  assert.equal(s.chipAxisWidth(ctx, [], 1), 0, 'no chips, no growth: the axis follows its own labels');
  assert.equal(s.chipAxisWidth(ctx, [{ edge: 'at', price: 100, word: 'Pivot' }], 1), s.CHIP_AXIS_MIN);
  const long = s.chipAxisWidth(ctx, [{ edge: 'top', price: 100, word: 'A name far longer than any axis should grow for' }], 1);
  assert.equal(long, s.CHIP_AXIS_MAX);
  s.CHART_CHIP_W = long;
  s.CHART.candles = bars(40);
  s.CHART.view = { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: 40, panOffset: 0, priceScale: { mode: 'auto' } };
  s.buildLayout(900, 600, ctx);
  assert.equal(s.buildLayout(900, 600, ctx).padRight, s.CHIP_AXIS_MAX);
});

test("chips never overlap, stay clear of the last price, and keep to their line's side of it", () => {
  const s = load();
  const L = ready(s, { symbol: 'BTC', overlays: {}, positions: [], orders: [], fills: [], plans: [] });
  // Twenty levels crowded around the price, half above and half below it.
  for (let i = 0; i < 20; i += 1) {
    const price = i < 10 ? 100.5 + i * 0.05 : 99.5 - (i - 10) * 0.05;
    s.chartAxisChip({ edge: 'at', y: L.yOf(price), price, word: `level ${i}`, tone: 'agent', prio: 6 });
  }
  L.reserved = { top: L.yOf(100) - 10, bottom: L.yOf(100) + 26 };
  const laid = s.chipLayout(L);
  const sorted = [...laid].sort((a: Any, b: Any) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].h, 'two chips overlap');
  for (const c of laid) {
    assert.ok(c.y + c.h <= L.reserved.top || c.y >= L.reserved.bottom, `${c.word} covers the last price`);
    const above = c.price > 100;
    assert.equal(c.y + c.h <= L.reserved.top, above, `${c.word} is on the wrong side of the price`);
  }
  const counted = laid.reduce((n: number, c: Any) => n + (c.more || 0), 0);
  assert.equal(laid.length + counted, 20, 'what did not fit is counted, not lost');
});
