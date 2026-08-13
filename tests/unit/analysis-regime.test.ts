import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atr, regime } from '../../src/analysis/regime.ts';
import type { Candle } from '../../src/types.ts';

function bars(ranges: number[]): Candle[] {
  // Each bar spans `range` around 100, with no gaps, so true range equals `range`.
  return ranges.map((r, i) => ({ t: i * 60, o: 100, h: 100 + r / 2, l: 100 - r / 2, c: 100, v: 1 }));
}

test('atr is null until the period fills, then equals a flat true range', () => {
  const out = atr(bars([2, 2, 2, 2, 2]), 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 2, 'first value is the simple mean of the first `period` true ranges');
  assert.equal(out[4], 2, 'and Wilder smoothing of a constant stays constant');
});

test('atr rises when range expands', () => {
  const out = atr(bars([2, 2, 2, 10, 10]), 3);
  assert.ok((out[4] as number) > (out[2] as number));
});

test('regime buckets by percentile rank over the stated lookback', () => {
  // 40 quiet bars then 10 wild ones: the last bar should rank at the top.
  const quiet = new Array(40).fill(2);
  const wild = new Array(10).fill(20);
  const r = regime(bars([...quiet, ...wild]), { period: 14, lookback: 50 });
  assert.ok(r);
  assert.equal(r.bucket, 'extreme');
  assert.ok(r.percentile > 0.95);
  assert.equal(r.period, 14, 'echoes the parameters that produced it');
  assert.equal(r.lookback, 50);
});

test('a compressed tail ranks low', () => {
  const wild = new Array(40).fill(20);
  const quiet = new Array(20).fill(1);
  const r = regime(bars([...wild, ...quiet]), { period: 14, lookback: 50 });
  assert.ok(r);
  assert.equal(r.bucket, 'compressed');
  assert.ok(r.percentile < 0.2);
});

test('returns null when there is not enough history to rank against', () => {
  assert.equal(regime(bars([2, 2, 2]), { period: 14, lookback: 50 }), null);
});
