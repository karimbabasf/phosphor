import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRange } from '../../src/analysis/range.ts';
import type { Candle } from '../../src/types.ts';

const bar = (c: number, i: number): Candle => ({ t: i * 60, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 });

test('a clean oscillation between two prices is a range', () => {
  // This is the case the old containment metric got backwards: every close sits at an
  // edge of the band, which is what bouncing off support and resistance looks like.
  const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const r = detectRange(closes.map(bar), { lookback: 40, maxEfficiency: 0.3 });
  assert.ok(r, 'a tight oscillation is a range');
  assert.equal(r.bars, 40);
  assert.ok(r.high > r.low);
  assert.ok(r.efficiency < 0.1, `travelled far and arrived nowhere, got ${r.efficiency}`);
});

test('a clean trend is not a range', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 3);
  assert.equal(detectRange(closes.map(bar), { lookback: 40, maxEfficiency: 0.3 }), null);
});

test('a perfect trend has efficiency 1', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 3);
  const r = detectRange(closes.map(bar), { lookback: 40, maxEfficiency: 1 });
  assert.ok(r);
  assert.ok(Math.abs(r.efficiency - 1) < 1e-9, 'every step went the same direction');
});

test('reports where the last close sits inside the band', () => {
  const closes = Array.from({ length: 20 }, (_, i) => (i === 19 ? 101 : 99 + (i % 2)));
  const r = detectRange(closes.map(bar), { lookback: 20, maxEfficiency: 0.5 });
  assert.ok(r);
  assert.ok(r.positionInRange > 0.5, 'a close near the top ranks high');
  assert.ok(r.positionInRange <= 1);
});

test('echoes the threshold that produced the verdict', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const r = detectRange(closes.map(bar), { lookback: 40, maxEfficiency: 0.3 });
  assert.ok(r);
  assert.equal(r.maxEfficiency, 0.3);
});

test('a flat window is maximally ranging, not a division by zero', () => {
  const closes = new Array(20).fill(100);
  const r = detectRange(closes.map(bar), { lookback: 20, maxEfficiency: 0.3 });
  assert.ok(r);
  assert.equal(r.efficiency, 0);
});

test('returns null without enough bars', () => {
  assert.equal(detectRange([bar(100, 0)], { lookback: 40, maxEfficiency: 0.3 }), null);
});
