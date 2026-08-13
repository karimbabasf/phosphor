// Indicator maths against hand-checked series.
//
// The agent reads these numbers to decide what to propose, and the browser draws the same
// arrays. A quiet arithmetic bug here is a wrong number on a money surface with nothing
// downstream to catch it, so every series in this file was worked out by hand first.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import {
  ema,
  indicatorCatalog,
  indicatorSpec,
  normaliseParams,
  sma,
  trueRange,
  warmupBars,
  wma,
} from '../../src/indicators.ts';

// A candle series from closes, with the high and low straddling each close by a fixed band
// so range-based indicators have something to chew on.
function series(closes: number[], step = 60, band = 0): Candle[] {
  return closes.map((c, i) => ({
    t: 1_700_000_000 + i * step,
    o: i === 0 ? c : (closes[i - 1] as number),
    h: c + band,
    l: c - band,
    c,
    v: 10,
  }));
}

function compute(type: string, closes: number[], params: Record<string, number> = {}, band = 0) {
  const spec = indicatorSpec(type);
  assert.ok(spec, `no spec for ${type}`);
  const normalised = normaliseParams(spec, params).params;
  return spec.compute(series(closes, 60, band), normalised);
}

function plot(result: { plots: { key: string; values: (number | null)[] }[] }, key: string): (number | null)[] {
  const found = result.plots.find((p) => p.key === key);
  assert.ok(found, `no plot ${key}`);
  return found.values;
}

test('sma is null until the window fills, then the plain average', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema seeds on the simple average of the first window', () => {
  // period 3 means alpha 0.5: seed 2, then 4*0.5 + 2*0.5 = 3, then 5*0.5 + 3*0.5 = 4.
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('wma weights the newest bar hardest', () => {
  const out = wma([1, 2, 3, 4, 5], 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.ok(Math.abs((out[2] as number) - 14 / 6) < 1e-9);
  assert.ok(Math.abs((out[4] as number) - 26 / 6) < 1e-9);
});

test('a leading null means no history, never zero', () => {
  // MACD and OBV both produce real zeroes, so the two cannot share a representation.
  const macd = compute('macd', Array.from({ length: 60 }, (_, i) => 100 + i));
  const values = plot(macd, 'macd');
  assert.equal(values[0], null);
  assert.equal(values[10], null);
  assert.ok(typeof values[59] === 'number');
});

test('rsi is 100 on an unbroken climb and 50 on a flat book', () => {
  const climbing = compute('rsi', Array.from({ length: 40 }, (_, i) => 100 + i));
  const rsi = plot(climbing, 'rsi');
  assert.equal(rsi[39], 100);

  const flat = compute('rsi', new Array(40).fill(100));
  assert.equal(plot(flat, 'rsi')[39], 50);
});

test('rsi lands mid-range on a market that gives back what it takes', () => {
  const closes: number[] = [];
  for (let i = 0; i < 60; i++) closes.push(100 + (i % 2 === 0 ? 1 : 0));
  const value = plot(compute('rsi', closes), 'rsi')[59] as number;
  assert.ok(value > 40 && value < 60, `expected a middling rsi, got ${value}`);
});

test('true range takes the previous close into account', () => {
  const candles: Candle[] = [
    { t: 1, o: 10, h: 12, l: 9, c: 11, v: 1 },
    { t: 2, o: 11, h: 20, l: 18, c: 19, v: 1 },
  ];
  // The gap from 11 up to a 18 low is the real range of the second bar, not its 2 point body.
  assert.deepEqual(trueRange(candles), [3, 9]);
});

test('atr on a constant range is that range', () => {
  const result = compute('atr', new Array(40).fill(100), { period: 14 }, 5);
  assert.equal(plot(result, 'atr')[39], 10);
});

test('bollinger collapses onto the average when nothing moves', () => {
  const result = compute('bbands', new Array(40).fill(100), { period: 20, mult: 2 });
  assert.equal(plot(result, 'upper')[39], 100);
  assert.equal(plot(result, 'lower')[39], 100);
  assert.equal(plot(result, 'mid')[39], 100);
});

test('bollinger width matches a hand-computed deviation', () => {
  // Four closes, period 4: mean 3, squared deviations 4+1+1+4 = 10, population sd sqrt(2.5).
  const result = compute('bbands', [1, 2, 4, 5], { period: 4, mult: 1 });
  const sd = Math.sqrt(2.5);
  assert.ok(Math.abs((plot(result, 'upper')[3] as number) - (3 + sd)) < 1e-9);
  assert.ok(Math.abs((plot(result, 'lower')[3] as number) - (3 - sd)) < 1e-9);
});

test('donchian reports the extremes of its window', () => {
  const result = compute('donchian', [5, 1, 9, 4, 7], { period: 3 }, 0);
  assert.equal(plot(result, 'upper')[4], 9);
  assert.equal(plot(result, 'lower')[4], 4);
  assert.equal(plot(result, 'mid')[4], 6.5);
});

test('stochastic is 100 when the close is the top of its range', () => {
  const result = compute('stoch', [1, 2, 3, 4, 5, 6, 7, 8], { k: 4, smooth: 1, d: 1 });
  assert.equal(plot(result, 'k')[7], 100);
});

test('obv adds volume on up bars and takes it off on down bars', () => {
  const result = compute('obv', [10, 11, 10, 10]);
  // +0 on the first bar, +10, -10, unchanged on a flat close.
  assert.deepEqual(plot(result, 'obv'), [0, 10, 0, 0]);
});

test('vwap re-anchors at the UTC day boundary', () => {
  const spec = indicatorSpec('vwap');
  assert.ok(spec);
  const dayOne = 86400 * 19700; // midnight UTC
  const candles: Candle[] = [
    { t: dayOne, o: 10, h: 10, l: 10, c: 10, v: 1 },
    { t: dayOne + 3600, o: 20, h: 20, l: 20, c: 20, v: 1 },
    { t: dayOne + 86400, o: 50, h: 50, l: 50, c: 50, v: 1 },
  ];
  const values = spec.compute(candles, {}).plots[0]?.values;
  assert.equal(values?.[1], 15);
  // The new day starts over rather than carrying yesterday's average into today.
  assert.equal(values?.[2], 50);
});

test('volume stays positive and carries direction beside the value, not inside it', () => {
  const spec = indicatorSpec('volume');
  assert.ok(spec);
  const candles: Candle[] = [
    { t: 1, o: 10, h: 11, l: 9, c: 11, v: 5 },
    { t: 2, o: 11, h: 11, l: 8, c: 9, v: 7 },
  ];
  const plot = spec.compute(candles, { average: 0 }).plots[0];
  // Folding the direction into the value would put the down bar under an axis volume has no
  // business crossing, and it would drag the pane's own scale negative with it.
  assert.deepEqual(plot?.values, [5, 7]);
  assert.deepEqual(plot?.signs, [1, -1]);
});

test('macd histogram is the gap between the line and its signal', () => {
  const result = compute('macd', Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10));
  const macd = plot(result, 'macd');
  const signal = plot(result, 'signal');
  const hist = plot(result, 'hist');
  const i = 79;
  assert.ok(Math.abs((hist[i] as number) - ((macd[i] as number) - (signal[i] as number))) < 1e-9);
});

test('parameters clamp instead of failing, and say so', () => {
  const spec = indicatorSpec('ema');
  assert.ok(spec);
  const out = normaliseParams(spec, { period: 5000 });
  assert.equal(out.params.period, 400);
  assert.equal(out.notes.length, 1);
});

test('warmup reports the history an indicator needs before it draws', () => {
  const macd = indicatorSpec('macd');
  assert.ok(macd);
  assert.equal(warmupBars(macd, { fast: 12, slow: 26, signal: 9 }), 35);
});

test('every catalogue entry computes on a short series without throwing', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 7));
  for (const entry of indicatorCatalog() as { type: string }[]) {
    const result = compute(entry.type, closes, {}, 2);
    assert.ok(result.plots.length > 0, `${entry.type} produced no plots`);
    assert.equal(typeof result.state, 'string');
    assert.ok(result.state.length > 0, `${entry.type} produced no state line`);
    for (const p of result.plots) {
      assert.equal(p.values.length, closes.length, `${entry.type}.${p.key} is not index aligned`);
    }
  }
});
