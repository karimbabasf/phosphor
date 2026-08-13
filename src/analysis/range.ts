// Is the recent window a range, and if so where in it are we.
//
// The first version of this measured "containment": what share of closes sat inside the
// middle of the window's high-low band. That was wrong, and wrong in an instructive way.
// A range is exactly where price bounces off the EDGES of its band, so a clean oscillation
// between support and resistance scores near zero containment and would be reported as a
// trend. The metric measured the opposite of the thing it was named for.
//
// What actually separates a range from a trend is how much net progress the travel bought.
// Kaufman's efficiency ratio: net move divided by total path length. A trend goes more or
// less straight, so the two are close and the ratio approaches 1. Chop travels a long way
// and arrives nowhere, so the ratio approaches 0. That is one number, it needs one
// caller-set threshold, and it does not care where in the band the closes sat.
//
// This returns boundaries, an efficiency and a position. It does not say "consolidation
// before a breakout" or anything else about what happens next, because that is a conclusion
// and this file only makes measurements.

import type { Candle } from '../types.ts';

export type Range = {
  start: number;
  end: number;
  low: number;
  high: number;
  bars: number;
  efficiency: number;
  positionInRange: number;
  maxEfficiency: number;
};

export function detectRange(
  candles: Candle[],
  opts: { lookback: number; maxEfficiency: number },
): Range | null {
  const { lookback, maxEfficiency } = opts;
  if (candles.length < Math.min(lookback, 10)) return null;

  const window = candles.slice(-lookback);
  const low = Math.min(...window.map((c) => c.l));
  const high = Math.max(...window.map((c) => c.h));
  if (!(high > low)) return null;

  const first = window[0].c;
  const last = window[window.length - 1].c;

  let travel = 0;
  for (let i = 1; i < window.length; i++) travel += Math.abs(window[i].c - window[i - 1].c);

  // A perfectly flat window travelled nowhere and went nowhere. That is the most ranging a
  // series can be, so it scores 0 rather than dividing by zero.
  const efficiency = travel === 0 ? 0 : Math.abs(last - first) / travel;
  if (efficiency > maxEfficiency) return null;

  return {
    start: window[0].t,
    end: window[window.length - 1].t,
    low,
    high,
    bars: window.length,
    efficiency,
    positionInRange: (last - low) / (high - low),
    maxEfficiency,
  };
}
