import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterLevels } from '../../src/analysis/levels.ts';
import type { Pivot } from '../../src/analysis/pivots.ts';

const p = (index: number, price: number): Pivot => ({
  index,
  t: index * 60,
  price,
  kind: 'high',
  prominence: 1,
});

test('groups pivots that sit within tolerance of each other', () => {
  const out = clusterLevels([p(0, 100), p(1, 100.4), p(2, 120)], 1);
  assert.equal(out.length, 2);
  assert.equal(out[0].count, 2, 'the pair leads because clusters sort by count');
  assert.deepEqual(out[0].members, [0, 1]);
  assert.equal(out[0].price, 100.2, 'the cluster price is the mean of its members');
});

test('reports spread and the tolerance that produced the grouping', () => {
  const out = clusterLevels([p(0, 100), p(1, 100.4)], 1);
  assert.ok(Math.abs(out[0].spread - 0.4) < 1e-9);
  assert.equal(out[0].tolerance, 1);
});

test('a tighter tolerance splits a cluster apart', () => {
  const loose = clusterLevels([p(0, 100), p(1, 100.4)], 1);
  const tight = clusterLevels([p(0, 100), p(1, 100.4)], 0.1);
  assert.equal(loose.length, 1);
  assert.equal(tight.length, 2, 'the same pivots, a different answer, hence tolerance is reported');
});

test('handles an empty list', () => {
  assert.deepEqual(clusterLevels([], 1), []);
});

test('ties on count break by price ascending, so the order is stable', () => {
  const out = clusterLevels([p(0, 50), p(1, 150)], 1);
  assert.deepEqual(out.map((c) => c.price), [50, 150]);
});
