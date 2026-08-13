// Swing points by topographic prominence.
//
// A rolling maximum answers "is this bar the highest nearby", which is true of every
// small bump in a quiet stretch. Prominence answers "how far does this stand above the
// ground it rises from", which is the question a trader is actually asking when they
// call something a swing high. Concretely: walk out from the candidate in both
// directions until a higher bar is found or the series ends, take the deepest low seen
// on each side, and measure down to the shallower of those two. That is the standard
// definition and it is what scipy's find_peaks calls prominence.
//
// The window parameter still does useful work: it is the cheap local-max pre-filter that
// keeps the prominence walk from running over every bar in the series.

import type { Candle } from '../types.ts';

export type Pivot = {
  index: number;
  t: number;
  price: number;
  kind: 'high' | 'low';
  prominence: number;
};

function isLocalMax(values: number[], i: number, window: number): boolean {
  const lo = Math.max(0, i - window);
  const hi = Math.min(values.length - 1, i + window);
  for (let j = lo; j <= hi; j++) if (j !== i && values[j] > values[i]) return false;
  return true;
}

// Prominence of a peak in `values`, measured against `floors` (the lows for a high).
// Walking outward until a strictly higher value appears is what makes this a measure of
// standing-above-surroundings rather than of local rank.
function peakProminence(values: number[], floors: number[], i: number): number {
  let leftFloor = floors[i];
  for (let j = i - 1; j >= 0; j--) {
    if (values[j] > values[i]) break;
    if (floors[j] < leftFloor) leftFloor = floors[j];
  }
  let rightFloor = floors[i];
  for (let j = i + 1; j < values.length; j++) {
    if (values[j] > values[i]) break;
    if (floors[j] < rightFloor) rightFloor = floors[j];
  }
  // The shallower side is the one that bounds how far this peak really stands out.
  return values[i] - Math.max(leftFloor, rightFloor);
}

export function pivots(
  candles: Candle[],
  opts: { window: number; minProminence: number },
): Pivot[] {
  const { window, minProminence } = opts;
  if (candles.length < window * 2 + 1) return [];

  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  // Troughs are peaks of the negated series, so one routine covers both directions.
  const negLows = lows.map((v) => -v);
  const negHighs = highs.map((v) => -v);

  const out: Pivot[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (isLocalMax(highs, i, window)) {
      const prominence = peakProminence(highs, lows, i);
      if (prominence >= minProminence) {
        out.push({ index: i, t: candles[i].t, price: highs[i], kind: 'high', prominence });
      }
    }
    if (isLocalMax(negLows, i, window)) {
      const prominence = peakProminence(negLows, negHighs, i);
      if (prominence >= minProminence) {
        out.push({ index: i, t: candles[i].t, price: lows[i], kind: 'low', prominence });
      }
    }
  }

  return out.sort((a, b) => a.index - b.index);
}
