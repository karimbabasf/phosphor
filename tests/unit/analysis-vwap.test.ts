import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchoredVwap } from '../../src/analysis/vwap.ts';
import type { Candle } from '../../src/types.ts';

const bar = (price: number, v: number, i: number): Candle => ({
  t: i * 60,
  o: price,
  h: price,
  l: price,
  c: price,
  v,
});

test('is null before the anchor and starts at the anchor bar price', () => {
  const out = anchoredVwap([bar(10, 1, 0), bar(20, 1, 1), bar(30, 1, 2)], 1);
  assert.equal(out[0], null);
  assert.equal(out[1], 20);
});

test('weights by volume, not by bar count', () => {
  // Typical price is h+l+c over 3, which equals the price for these flat bars.
  const out = anchoredVwap([bar(10, 1, 0), bar(20, 9, 1)], 0);
  assert.equal(out[1], 19, '(10*1 + 20*9) / 10');
});

test('a zero-volume stretch does not divide by zero', () => {
  const out = anchoredVwap([bar(10, 0, 0), bar(20, 0, 1)], 0);
  assert.ok(out.every((v) => v === null || Number.isFinite(v)));
});

test('an out-of-range anchor yields all nulls', () => {
  const out = anchoredVwap([bar(10, 1, 0)], 5);
  assert.deepEqual(out, [null]);
});
