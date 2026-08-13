import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineAt, touches, fitThroughPivots } from '../../src/analysis/trendline.ts';
import type { Candle } from '../../src/types.ts';

test('evaluates a rising line at any time, including outside its anchors', () => {
  const line = { a: { t: 100, price: 10 }, b: { t: 200, price: 20 } };
  assert.equal(lineAt(line, 100), 10);
  assert.equal(lineAt(line, 200), 20);
  assert.equal(lineAt(line, 150), 15, 'between the anchors');
  assert.equal(lineAt(line, 300), 30, 'extended forward');
  assert.equal(lineAt(line, 0), 0, 'extended backward');
});

test('a horizontal line is flat everywhere', () => {
  const line = { a: { t: 100, price: 42 }, b: { t: 500, price: 42 } };
  assert.equal(lineAt(line, 1e9), 42);
});

test('a vertical pair does not divide by zero', () => {
  const line = { a: { t: 100, price: 10 }, b: { t: 100, price: 20 } };
  assert.ok(Number.isFinite(lineAt(line, 150)));
});

test('records every bar that came within tolerance, and which side it was', () => {
  const line = { a: { t: 0, price: 10 }, b: { t: 100, price: 10 } };
  const candles: Candle[] = [
    { t: 0, o: 10, h: 10.4, l: 9.6, c: 10, v: 1 }, // straddles, distance 0
    { t: 50, o: 20, h: 20, l: 19, c: 20, v: 1 }, // far above
    { t: 100, o: 10.3, h: 10.5, l: 10.2, c: 10.3, v: 1 }, // just above, within 0.5
  ];
  const found = touches(line, candles, 0.5);
  assert.deepEqual(found.map((x) => x.index), [0, 2]);
  assert.equal(found[0].distance, 0, 'a bar spanning the line touches it exactly');
  assert.equal(found[1].side, 'above');
});

test('fits through the two most recent pivots of the requested kind', () => {
  const ps = [
    { index: 0, t: 0, price: 5, kind: 'high' as const, prominence: 1 },
    { index: 1, t: 100, price: 10, kind: 'low' as const, prominence: 1 },
    { index: 2, t: 200, price: 15, kind: 'high' as const, prominence: 1 },
    { index: 3, t: 300, price: 25, kind: 'high' as const, prominence: 1 },
  ];
  const line = fitThroughPivots(ps, 'high');
  assert.ok(line);
  assert.equal(line.a.t, 200, 'the two most recent highs, oldest first');
  assert.equal(line.b.t, 300);
  assert.equal(lineAt(line, 400), 35);
});

test('returns null when there are not two pivots of that kind', () => {
  const ps = [{ index: 0, t: 0, price: 5, kind: 'high' as const, prominence: 1 }];
  assert.equal(fitThroughPivots(ps, 'high'), null);
  assert.equal(fitThroughPivots(ps, 'low'), null);
});
