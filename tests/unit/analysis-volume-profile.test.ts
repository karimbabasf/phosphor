import { test } from 'node:test';
import assert from 'node:assert/strict';
import { volumeProfile } from '../../src/analysis/volume-profile.ts';
import type { Candle } from '../../src/types.ts';

const bar = (l: number, h: number, v: number, i: number): Candle => ({
  t: i * 60,
  o: (l + h) / 2,
  h,
  l,
  c: (l + h) / 2,
  v,
});

test('point of control is the price bin holding the most volume', () => {
  const candles = [bar(10, 11, 1, 0), bar(12, 13, 50, 1), bar(14, 15, 1, 2)];
  const p = volumeProfile(candles, { bins: 5, valueAreaPct: 0.7 });
  assert.ok(p);
  assert.ok(p.poc >= 12 && p.poc <= 13, `poc ${p.poc} should sit in the heavy bin`);
});

test('value area encloses the requested share of volume and contains the poc', () => {
  const candles = [bar(10, 11, 5, 0), bar(11, 12, 40, 1), bar(12, 13, 5, 2), bar(13, 14, 1, 3)];
  const p = volumeProfile(candles, { bins: 8, valueAreaPct: 0.7 });
  assert.ok(p);
  assert.ok(p.valueArea.low <= p.poc && p.poc <= p.valueArea.high);
  const total = p.bins.reduce((s, b) => s + b.volume, 0);
  const inside = p.bins
    .filter((b) => b.low >= p.valueArea.low && b.high <= p.valueArea.high)
    .reduce((s, b) => s + b.volume, 0);
  assert.ok(inside / total >= 0.7, `value area holds ${inside / total}`);
});

test('echoes the parameters that produced the levels', () => {
  const p = volumeProfile([bar(10, 11, 1, 0), bar(10, 11, 1, 1)], { bins: 4, valueAreaPct: 0.7 });
  assert.ok(p);
  assert.equal(p.valueAreaPct, 0.7);
  assert.equal(p.basis, 'volume');
  assert.ok(p.binWidth > 0);
});

test('returns null for an empty series or a zero-width range', () => {
  assert.equal(volumeProfile([], { bins: 4, valueAreaPct: 0.7 }), null);
  const flat = [bar(10, 10, 1, 0), bar(10, 10, 1, 1)];
  assert.equal(volumeProfile(flat, { bins: 4, valueAreaPct: 0.7 }), null);
});
