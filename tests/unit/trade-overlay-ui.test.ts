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

test('the axis grows to fit the widest chip on one line, from a floor for a short word to a fifth of the chart', () => {
  const s = load();
  const { ctx } = fakeCtx();
  assert.equal(s.chipAxisWidth(ctx, [], 1), 0, 'no chips, no growth: the axis follows its own labels');
  assert.equal(s.chipAxisWidth(ctx, [{ edge: 'at', price: 100, word: 'Pivot' }], 1), s.CHIP_AXIS_MIN);
  // "Liquidity below" beside an arrow and a price, the chip the review saw cut to "Liquidity belo...".
  const chip = { edge: 'bottom', price: 80312, word: 'Liquidity below' };
  const wanted = s.chipWidthWanted(ctx, chip, 0);
  assert.equal(s.chipAxisWidth(ctx, [chip], 0, s.chipAxisCap(900)), wanted, 'the axis takes what the chip asks for while it is under the cap');
  // The cap is a fifth of the chart, never under the old ceiling and never past the new one.
  assert.equal(s.chipAxisCap(900), 180);
  assert.equal(s.chipAxisCap(500), s.CHIP_AXIS_LOW_CAP);
  assert.equal(s.chipAxisCap(2400), s.CHIP_AXIS_MAX);
  const long = s.chipAxisWidth(ctx, [{ edge: 'top', price: 100, word: 'A name far longer than any axis should grow for' }], 1);
  assert.equal(long, s.CHIP_AXIS_MAX);
  s.CHART_CHIP_W = long;
  s.CHART.candles = bars(40);
  s.CHART.view = { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: 40, panOffset: 0, priceScale: { mode: 'auto' } };
  s.buildLayout(900, 600, ctx);
  assert.equal(s.buildLayout(900, 600, ctx).padRight, s.CHIP_AXIS_MAX);
});

test('no name on the axis is ever cut: a name wider than the axis wraps whole words onto a second line', () => {
  const s = load();
  const { ctx } = fakeCtx();
  // The longest a label can be stored (src/chart-label.ts LABEL_MAX), on the narrowest axis.
  const name = 'Prior week value area high and the monthly open';
  assert.ok(name.length <= 48);
  const L = ready(s, { symbol: 'BTC', overlays: {}, positions: [], orders: [], fills: [], plans: [] });
  L.padRight = s.CHIP_AXIS_LOW_CAP;
  s.chartAxisChip({ edge: 'at', y: L.yOf(102), price: 102, word: name, tone: 'text', prio: 6 });
  s.chartAxisChip({ edge: 'bottom', price: 80, word: 'Liquidity below', tone: 'agent', prio: 6, fold: true });
  const laid = s.chipLayout(L, ctx);
  const wrapped = laid.find((c: Any) => c.word === name);
  assert.ok(wrapped.lines.length === 2 || wrapped.lines.length === 3, JSON.stringify(wrapped.lines));
  assert.equal(wrapped.lines.join(' '), name, 'the lines put back together are the whole name, word for word');
  assert.ok(wrapped.h > s.CHIP_H, 'the chip is as tall as its lines');
  const hud = fakeCtx();
  s.drawAxisChips(hud.ctx, { ...L, chips: laid });
  const drawn = hud.texts.map((t) => t.text);
  assert.ok(!drawn.some((t) => t.includes(s.ELLIPSIS)), `a name was cut: ${JSON.stringify(drawn)}`);
  for (const line of wrapped.lines) assert.ok(drawn.includes(line), `${line} is not on the axis`);
  // Every line of a chip stays inside the axis: none runs past the chip's right edge.
  const right = L.plotWidth + L.padRight - 7;
  for (const t of hud.texts) assert.ok(t.x + t.text.length * 6 <= right + 0.5, `${t.text} runs past the axis`);
  // The axis asks for the little more that keeps the name to two lines, and gets it next frame.
  const asked = s.chipAxisWidth(ctx, [wrapped], L.decimals, s.CHIP_AXIS_LOW_CAP);
  assert.ok(asked > s.CHIP_AXIS_LOW_CAP && asked <= s.CHIP_AXIS_MAX, String(asked));
  L.padRight = asked;
  const wider = s.chipLayout(L, ctx).find((c: Any) => c.word === name);
  assert.equal(wider.lines.length, 2, JSON.stringify(wider.lines));
  assert.equal(wider.lines.join(' '), name);
  // A word wider than a whole line is broken inside itself rather than cut, every letter kept.
  const one = s.wrapWords(ctx, 'Supercalifragilistic', 60, 60);
  assert.equal(one.join(''), 'Supercalifragilistic');
  assert.ok(one.every((line: string) => line.length * 6 <= 60), JSON.stringify(one));
});

test("chips never overlap, stay clear of the last price, and keep to their line's side of it", () => {
  const s = load();
  const L = ready(s, { symbol: 'BTC', overlays: {}, positions: [], orders: [], fills: [], plans: [] });
  // Forty of the agent's levels crowded around the price, half above and half below it.
  for (let i = 0; i < 40; i += 1) {
    const price = i < 20 ? 100.5 + i * 0.05 : 99.5 - (i - 20) * 0.05;
    s.chartAxisChip({ edge: 'at', y: L.yOf(price), price, word: `level ${i}`, tone: 'agent', prio: 6, fold: true });
  }
  L.reserved = { top: L.yOf(100) - 10, bottom: L.yOf(100) + 26 };
  const laid = s.chipLayout(L);
  const sorted = [...laid].sort((a: Any, b: Any) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].h, 'two chips overlap');
  for (const c of laid) {
    assert.ok(c.y + c.h <= L.reserved.top || c.y >= L.reserved.bottom, `${c.word} covers the last price`);
    const above = c.price > 100;
    assert.equal(c.y + c.h <= L.reserved.top, above, `${c.word} is on the wrong side of the price`);
    assert.ok(!c.more, 'no chip carries a count of others');
  }
  assert.ok(L.fold && L.fold.items.length > 0, 'a crowded axis folds the agent levels into the count');
  assert.equal(laid.length + L.fold.items.length, 40, 'what did not fit is counted, not lost');
});

/* A trading account and a crowd of the agent's levels on a pane as short as Trade's at 1180 x 780:
   the review's screenshot folded the plan's stop into "Stop +7". */
function crowded(s: Any, height: number): Any {
  s.CHART.candles = bars(40);
  s.CHART.view = { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: 40, panOffset: 0, priceScale: { mode: 'auto' } };
  s.CHART.dataView = { product: 'BTC-USD', granularitySec: 60 };
  s.CHART.levels = [101, 101.5, 102, 102.5, 103, 97, 97.5, 98.5, 99.5, 110, 120, 80, 70].map((price, i) => ({ id: `level-${i}`, price, label: `[agent] level ${i}`, source: 'agent' }));
  s.window.TRADE = {
    symbol: 'BTC',
    overlays: { position: true, liquidation: true, stops: true, targets: true, orders: true, planStop: true },
    positions: [{ coin: 'BTC', side: 'long', notionalUsd: 1000, entryPx: 101.2, liqPx: 60, unrealisedUsd: 0 }],
    orders: [
      { oid: 1, coin: 'BTC', side: 'sell', kind: 'trigger', role: 'stop', triggerPx: 99.1, notionalUsd: 1000, reduceOnly: true },
      { oid: 2, coin: 'BTC', side: 'sell', kind: 'trigger', role: 'target', triggerPx: 140, notionalUsd: 1000, reduceOnly: true },
      { oid: 3, coin: 'BTC', side: 'buy', kind: 'limit', px: 98, notionalUsd: 40, reduceOnly: false },
    ],
    fills: [],
    plans: [plan({ entry: { type: 'limit', px: 100.8 }, stop: 98.2, target: 103.4 })],
  };
  s.CHART_CHIP_W = 0;
  const { ctx } = fakeCtx();
  // Frames as the engine draws them: the axis the chips ask for on one is applied on the next.
  let L: Any = {};
  for (let frame = 0; frame < 3; frame += 1) {
    s.buildLayout(560, height, ctx);
    L = s.buildLayout(560, height, ctx);
    s.CHART_AXIS_CHIPS = [];
    s.drawLevels(ctx, L);
    s.drawTradeOverlays(ctx, L);
    L.chips = s.chipLayout(L, ctx);
    s.CHART_CHIP_W = s.chipAxisWidth(ctx, L.chips, L.decimals, s.chipAxisCap(560));
  }
  return L;
}

test('a stop is never folded into a count: every price money is lost or made at keeps its own chip, and only the agent levels fold', () => {
  for (const height of [200, 276, 396]) {
    const s = load();
    const L = crowded(s, height);
    const risk = s.CHART_AXIS_CHIPS.filter((c: Any) => c.risk);
    assert.deepEqual(
      [...new Set<string>(risk.map((c: Any) => c.word))].sort(),
      ['Liquidation', 'Long', 'Plan long', 'Stop', 'Target'],
      'the account names its stops, liquidation, entry and the plan'
    );
    for (const c of risk) {
      const own = L.chips.find((k: Any) => k.word === c.word && k.price === c.price);
      assert.ok(own, `${c.word} at ${c.price} has no chip of its own at height ${height}`);
    }
    assert.ok(L.chips.some((k: Any) => k.word === 'Buy $40.00'), 'a resting order is not the agent\'s to fold either');
    assert.ok(L.fold && L.fold.items.length > 0, `the agent's levels fold at height ${height}`);
    assert.ok(L.fold.items.every((c: Any) => c.tone === 'agent' && c.fold === true), 'only the agent folds');
    assert.equal(L.fold.tone, 'agent');
    // The count is its own chip in the strip above the axis, never a number added to a stop's name.
    const hud = fakeCtx();
    s.foldLayout(hud.ctx, L);
    s.drawAxisChips(hud.ctx, L);
    const drawn = hud.texts.map((t) => t.text);
    const count = `+${L.fold.items.length} more`;
    assert.ok(drawn.includes(count), JSON.stringify(drawn));
    const at = hud.texts.find((t) => t.text === count)!;
    assert.ok(at.y < L.priceTop, 'the count sits above the price pane');
    assert.ok(!drawn.some((t) => /^(Stop|Liquidation|Target|Long|Plan long)\s*\+/.test(t)), JSON.stringify(drawn));
    const sorted = [...L.chips].sort((a: Any, b: Any) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].h - 0.01, `two chips overlap at height ${height}`);
    for (const c of L.chips) assert.ok(c.y + c.h <= L.reserved.top + 0.01 || c.y >= L.reserved.bottom - 0.01, `${c.word} covers the last price`);
  }
});

test('the edges rank like the rest of the axis: agent levels just past the pane cannot push an off-scale stop and liquidation off it', () => {
  // The final audit's probe (scratchpad/secscan/r0100/probe-chips.mjs, finding 14), as it ran: a
  // 400 px pane showing 60,000 to 62,000, the stop (57,000) and the liquidation (55,000) below it,
  // and three agent levels at 59,880 to 59,900 just past the bottom edge.
  const s = load();
  const L: Any = { priceTop: 22, priceHeight: 400, reserved: { top: 212, bottom: 232 } };
  const risk = [
    { price: 57000, word: 'Stop', tone: 'down', prio: 8, edge: 'bottom' },
    { price: 55000, word: 'Liquidation', tone: 'down', prio: 9, edge: 'bottom' },
  ];
  const agent = [0, 1, 2].map((k) => ({ price: 59900 - k * 10, word: 'support', tone: 'agent', prio: 6, edge: 'bottom' }));
  const bottomOf = (laid: Any[]) => laid.filter((c) => c.edge === 'bottom').map((c) => `${c.word} ${c.price}`);

  // The probe's chips as it wrote them, with no flags: nothing is the agent's to fold.
  s.CHART_AXIS_CHIPS = [...risk, ...agent];
  const plain = bottomOf(s.chipLayout(L));
  assert.ok(plain.includes('Stop 57000') && plain.includes('Liquidation 55000'), JSON.stringify(plain));

  // As the engine hands them over: the account's lines say they are risk, the agent's levels that
  // they may fold. The edge holds three, the account's first, and the rest of the agent's fold.
  s.CHART_AXIS_CHIPS = [...risk.map((c) => ({ ...c, risk: true })), ...agent.map((c) => ({ ...c, fold: true }))];
  const laid = s.chipLayout(L);
  const bottom = bottomOf(laid);
  assert.deepEqual([...bottom], ['support 59900', 'Stop 57000', 'Liquidation 55000'], 'the nearest agent level, then the stop, then the liquidation');
  assert.deepEqual([...L.fold.items.map((c: Any) => `${c.word} ${c.price}`)], ['support 59890', 'support 59880'], 'the agent levels that did not fit are in the count');
  const ys = laid.filter((c: Any) => c.edge === 'bottom').map((c: Any) => c.y);
  assert.ok(ys.every((y: number, i: number) => i === 0 || y > ys[i - 1]), 'the edge reads top to bottom as its prices do');
  assert.ok(laid.every((c: Any) => c.y + c.h <= L.priceTop + L.priceHeight), 'all inside the pane');

  // Six agent levels at the edge change nothing for the account's.
  s.CHART_AXIS_CHIPS = [...risk.map((c) => ({ ...c, risk: true })), ...[0, 1, 2, 3, 4, 5].map((k) => ({ price: 59900 - k * 10, word: 'support', tone: 'agent', prio: 6, edge: 'bottom', fold: true }))];
  const many = bottomOf(s.chipLayout(L));
  assert.ok(many.includes('Stop 57000') && many.includes('Liquidation 55000'), JSON.stringify(many));
  assert.equal(L.fold.items.length, 5);
});

test('the level the agent points at takes the first free place among its own, and never one of the account\'s', () => {
  const s = load();
  const L: Any = { priceTop: 22, priceHeight: 180, reserved: { top: 150, bottom: 170 } };
  const account = [
    { edge: 'at', y: 40, price: 110, word: 'Target', tone: 'up', prio: 8, risk: true },
    { edge: 'at', y: 70, price: 108, word: 'Long', tone: 'text', prio: 9, risk: true },
    { edge: 'at', y: 100, price: 106, word: 'Buy $40.00', tone: 'text2', prio: 3 },
    { edge: 'at', y: 130, price: 104, word: 'Stop', tone: 'down', prio: 8, risk: true },
  ];
  const agent = [45, 60, 85, 115, 125].map((y, i) => ({ edge: 'at', y, price: 111 - i, word: `level ${i}`, tone: 'agent', prio: 6, fold: true }));
  // Room above the price for six chips: the four of the account's and two of the agent's.
  s.CHART_AXIS_CHIPS = [...account, ...agent.map((c, i) => (i === 4 ? { ...c, ring: true } : c))];
  const laid = s.chipLayout(L);
  const words = laid.map((c: Any) => c.word);
  for (const c of account) assert.ok(words.includes(c.word), `${c.word} lost its chip: ${JSON.stringify(words)}`);
  assert.ok(words.includes('level 4'), 'the level being pointed at is on the axis');
  assert.equal(L.fold.ring, false);
  // With no room left for any of the agent's, it folds like the rest and the count wears the ring.
  s.CHART_AXIS_CHIPS = [...account, ...account.map((c) => ({ ...c, y: c.y + 5, price: c.price - 0.5 })), { ...agent[4], ring: true }];
  const full = s.chipLayout(L);
  assert.equal(full.filter((c: Any) => c.word === 'Buy $40.00').length, 2, 'both orders keep their chips');
  assert.ok(!full.some((c: Any) => c.word === 'level 4'));
  assert.deepEqual([...L.fold.items.map((c: Any) => c.word)], ['level 4']);
  assert.equal(L.fold.ring, true, 'the count that holds it is ringed');
});

test('a short pane with the last price at its foot hands the stop and the liquidation across the price, never away', () => {
  const s = load();
  // The review's 1180 frame: the tag sits at the bottom of the pane, so under it there is no room.
  const L: Any = { priceTop: 22, priceHeight: 180, reserved: { top: 190, bottom: 226 } };
  s.CHART_AXIS_CHIPS = [
    { edge: 'bottom', price: 68000, word: 'Liquidation', tone: 'down', prio: 9, risk: true },
    { edge: 'bottom', price: 80000, word: 'Liquidity below', tone: 'agent', prio: 6, fold: true },
    { edge: 'at', y: 60, price: 87000, word: 'Target', tone: 'up', prio: 8, risk: true },
    { edge: 'at', y: 150, price: 84000, word: 'Stop', tone: 'down', prio: 8, risk: true },
    { edge: 'at', y: 196, price: 83400, word: 'Stop', tone: 'down', prio: 8, risk: true },
  ];
  const laid = s.chipLayout(L);
  const words = laid.map((c: Any) => `${c.word} ${c.price}`);
  for (const want of ['Liquidation 68000', 'Target 87000', 'Stop 84000', 'Stop 83400']) assert.ok(words.includes(want), `${want} is gone: ${JSON.stringify(words)}`);
  for (const c of laid) assert.ok(c.y + c.h <= L.reserved.top, `${c.word} ${c.price} covers the last price`);
  // Handed across, they keep the ladder's order: the lowest price sits lowest, right above the tag.
  const byY = [...laid].sort((a: Any, b: Any) => a.y - b.y).map((c: Any) => c.price);
  assert.deepEqual([...byY], [87000, 84000, 83400, 68000]);
  assert.deepEqual([...L.fold.items.map((c: Any) => c.word)], ['Liquidity below']);
});

/* Just enough of a document for the count's button and its list. */
function fakeDocument() {
  const byId: Record<string, Any> = {};
  const make = (tag: string): Any => {
    const node: Any = {
      tagName: tag,
      children: [] as Any[],
      attrs: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
      listeners: {} as Record<string, (ev: Any) => void>,
      textContent: '',
      parentNode: null,
      clientHeight: 400,
      setAttribute(k: string, v: string) {
        node.attrs[k] = String(v);
        if (k === 'id') byId[v] = node;
      },
      getAttribute(k: string) {
        return k in node.attrs ? node.attrs[k] : null;
      },
      appendChild(child: Any) {
        child.parentNode = node;
        node.children.push(child);
        if (child.id) byId[child.id] = child;
        return child;
      },
      removeChild(child: Any) {
        node.children = node.children.filter((c: Any) => c !== child);
        if (child.id) delete byId[child.id];
        child.parentNode = null;
      },
      addEventListener(type: string, fn: (ev: Any) => void) {
        node.listeners[type] = fn;
      },
    };
    return node;
  };
  const layer = make('div');
  layer.id = 'chart-folds';
  byId['chart-folds'] = layer;
  const doc: Any = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: (tag: string) => make(tag),
    createTextNode: (text: string) => ({ tagName: '#text', textContent: text }),
    addEventListener: () => {},
  };
  return { doc, layer, byId };
}

const textOf = (node: Any): string => (node.tagName === '#text' ? node.textContent : node.textContent + (node.children || []).map(textOf).join(''));

test('the count names what it holds on hover and on focus: a real button over it, and a list of every folded marking', () => {
  const s = load();
  const { doc, layer, byId } = fakeDocument();
  s.document = doc;
  const L = crowded(s, 276);
  const hud = fakeCtx();
  s.foldLayout(hud.ctx, L);
  s.syncAxisFold(L);
  const button = byId['chart-fold-axis'];
  const tip = byId['chart-fold-tip-axis'];
  assert.ok(button && tip, 'a button and its list are laid over the count');
  assert.equal(button.tagName, 'button', 'a real button, so the keyboard reaches it');
  assert.equal(layer.children.length, 2);
  assert.equal(tip.attrs.role, 'tooltip');
  assert.equal(button.attrs['aria-describedby'], tip.id);
  const n = L.fold.items.length;
  assert.equal(button.attrs['aria-label'], `${n} more markings from your assistant, not shown on the axis`);
  // Over the count's chip, to the pixel the canvas drew it at.
  assert.equal(button.style.left, `${Math.round(L.fold.rect.x)}px`);
  assert.equal(button.style.top, `${Math.round(L.fold.rect.y)}px`);
  // The list names every folded marking, top to bottom, with its price.
  const rows = tip.children[1].children;
  assert.equal(rows.length, n);
  L.fold.items.forEach((c: Any, i: number) => {
    const row = textOf(rows[i]);
    assert.ok(row.includes(c.word), `${c.word} is not named: ${row}`);
    if (typeof c.price === 'number') assert.ok(row.includes(s.priceText(c.price, L.decimals)), row);
    assert.equal(rows[i].dataset.tone, 'agent');
  });
  // An off-scale level says which edge it went off, in words as well as the arrow.
  const off = L.fold.items.findIndex((c: Any) => c.edge === 'bottom');
  if (off >= 0) assert.ok(textOf(rows[off]).includes('below the chart'), textOf(rows[off]));
  // Escape puts the list away while the focus stays; leaving and coming back brings it again.
  button.listeners.keydown({ key: 'Escape', stopPropagation() {} });
  assert.equal(button.dataset.hush, '1');
  button.listeners.blur({});
  assert.equal(button.dataset.hush, undefined);
  // The stylesheet shows the list on hover and on focus, and keeps it while the pointer is on it.
  const css = readFileSync(new URL('../../ui/design/trade.css', import.meta.url), 'utf8');
  for (const rule of ['.chart-fold:hover:not([data-hush]) + .chart-fold-tip', '.chart-fold:focus:not([data-hush]) + .chart-fold-tip', '.chart-fold-tip:hover']) {
    assert.ok(css.includes(rule), `${rule} is gone from trade.css`);
  }
  // Nothing folded, nothing laid over the chart.
  L.fold = null;
  s.syncAxisFold(L);
  assert.equal(byId['chart-fold-axis'], undefined);
  assert.equal(layer.children.length, 0);
});
