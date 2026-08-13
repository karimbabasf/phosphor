import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pivots } from '../../src/analysis/pivots.ts';
import type { Candle } from '../../src/types.ts';

// Build candles from a list of closes. Highs and lows sit one unit either side,
// which keeps the fixture readable while still exercising high/low separately.
function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: 1000 + i * 60, o: c, h: c + 1, l: c - 1, c, v: 10 }));
}

test('finds a clear peak and trough, ignoring the shoulders', () => {
  //                     0   1   2   3   4    5    6  7     8
  const candles = series([10, 11, 20, 11, 10, 10.5, 4, 10.5, 10]);
  const found = pivots(candles, { window: 2, minProminence: 3 });

  const highs = found.filter((p) => p.kind === 'high');
  const lows = found.filter((p) => p.kind === 'low');

  assert.equal(highs.length, 1, 'one prominent high');
  assert.equal(highs[0].index, 2);
  assert.equal(highs[0].price, 21); // high = close + 1

  assert.equal(lows.length, 1, 'one prominent low');
  assert.equal(lows[0].index, 6);
  assert.equal(lows[0].price, 3); // low = close - 1
});

test('a double top reports both highs, because that is what it is', () => {
  // Two equal highs either side of a deep trough. A naive reading calls the second one a
  // shoulder of the first; topographic prominence measures each against the ground it
  // rises from, and with a deep trough between them both genuinely stand clear. A trader
  // drawing a double top wants both, so this behaviour is pinned rather than tuned away.
  //                     0   1   2   3   4   5  6   7   8
  const candles = series([10, 12, 20, 12, 10, 12, 4, 12, 10]);
  const highs = pivots(candles, { window: 2, minProminence: 3 }).filter((p) => p.kind === 'high');

  assert.deepEqual(highs.map((p) => p.index), [2, 5, 7]);
  assert.equal(highs[1].price, highs[2].price, 'the pair sits at one price');
  assert.ok(
    highs[0].prominence > highs[1].prominence,
    'and the real peak still outranks them both',
  );
});

test('prominence filters micro noise a rolling max would keep', () => {
  // Two peaks: index 2 stands 10 above its surroundings, index 6 stands 0.5.
  const candles = series([10, 12, 20, 12, 10, 10.2, 10.5, 10.2, 10]);
  const loose = pivots(candles, { window: 2, minProminence: 0 });
  const strict = pivots(candles, { window: 2, minProminence: 3 });

  const loosePeaks = loose.filter((p) => p.kind === 'high').map((p) => p.index);
  const strictPeaks = strict.filter((p) => p.kind === 'high').map((p) => p.index);

  assert.ok(loosePeaks.includes(6), 'the small bump is a local max');
  assert.ok(!strictPeaks.includes(6), 'and prominence removes it');
  assert.ok(strictPeaks.includes(2), 'while the real peak survives');
});

test('reports prominence as a number the caller can threshold on', () => {
  const candles = series([10, 12, 20, 12, 10]);
  const [peak] = pivots(candles, { window: 2, minProminence: 0 }).filter((p) => p.kind === 'high');
  // Peak high is 21. The deepest low on each side is 9 (close 10 minus 1).
  assert.equal(peak.prominence, 12);
});

test('returns nothing for a series shorter than the window allows', () => {
  assert.deepEqual(pivots(series([1, 2, 3]), { window: 5, minProminence: 0 }), []);
});

test('sorts results by index regardless of kind', () => {
  const candles = series([10, 12, 20, 12, 10, 12, 4, 12, 10]);
  const found = pivots(candles, { window: 2, minProminence: 3 });
  const indexes = found.map((p) => p.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});
