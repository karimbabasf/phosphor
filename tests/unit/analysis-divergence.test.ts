import { test } from 'node:test';
import assert from 'node:assert/strict';
import { divergences } from '../../src/analysis/divergence.ts';
import type { Pivot } from '../../src/analysis/pivots.ts';

const hi = (index: number, price: number): Pivot => ({
  index,
  t: index * 60,
  price,
  kind: 'high',
  prominence: 1,
});
const lo = (index: number, price: number): Pivot => ({
  index,
  t: index * 60,
  price,
  kind: 'low',
  prominence: 1,
});

test('price makes a higher high while the oscillator makes a lower high', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[2] = 80;
  osc[8] = 60;
  const out = divergences([hi(2, 100), hi(8, 110)], osc);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'bearish');
  assert.equal(out[0].priceA.index, 2);
  assert.equal(out[0].priceB.index, 8);
  assert.equal(out[0].oscA, 80);
  assert.equal(out[0].oscB, 60);
});

test('price makes a lower low while the oscillator makes a higher low', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[2] = 20;
  osc[8] = 35;
  const out = divergences([lo(2, 100), lo(8, 90)], osc);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'bullish');
});

test('agreement between price and oscillator is not a divergence', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[2] = 60;
  osc[8] = 80;
  assert.deepEqual(divergences([hi(2, 100), hi(8, 110)], osc), []);
});

test('skips pivots where the oscillator has no value', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[8] = 60;
  assert.deepEqual(divergences([hi(2, 100), hi(8, 110)], osc), []);
});

test('compares consecutive pivots of the same kind only', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[2] = 80;
  osc[5] = 10;
  osc[8] = 60;
  const out = divergences([hi(2, 100), lo(5, 50), hi(8, 110)], osc);
  assert.equal(out.length, 1, 'the low between them does not break the pair');
  assert.equal(out[0].kind, 'bearish');
});
