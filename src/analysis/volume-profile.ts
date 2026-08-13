// Volume by price: the point of control and the value area.
//
// Four things about this primitive are worth knowing before trusting a number it returns,
// and all four are reasons it reports its parameters rather than reasons to skip it:
//
//   1. Bin width dominates the result. Too fine and the point of control jitters between
//      adjacent ticks; too coarse and the value area swallows the whole range.
//   2. This is volume at price, not time at price. They disagree, sometimes sharply, when
//      size trades fast at one level. `basis` says which one you are looking at.
//   3. Crypto has no session, so any daily anchor is arbitrary. This function profiles the
//      candles it is handed and takes no view on where a session starts.
//   4. Perpetual volume reflects positioning, not accepted value. That is a caveat for the
//      agent reading the level, not something the maths can correct.
//
// Volume is spread evenly across the bins a bar's range covers. A bar's true distribution
// within its own range is not knowable from OHLCV, and pretending otherwise (all volume at
// the close, say) puts a sharp fake peak into the profile.

import type { Candle } from '../types.ts';

export type Bin = { low: number; high: number; volume: number };

export type Profile = {
  bins: Bin[];
  poc: number;
  valueArea: { low: number; high: number };
  binWidth: number;
  valueAreaPct: number;
  basis: 'volume';
};

export function volumeProfile(
  candles: Candle[],
  opts: { bins: number; valueAreaPct: number },
): Profile | null {
  const { bins: binCount, valueAreaPct } = opts;
  if (candles.length === 0 || binCount <= 0) return null;

  const low = Math.min(...candles.map((c) => c.l));
  const high = Math.max(...candles.map((c) => c.h));
  if (!(high > low)) return null;

  const binWidth = (high - low) / binCount;
  const bins: Bin[] = Array.from({ length: binCount }, (_, i) => ({
    low: low + i * binWidth,
    high: low + (i + 1) * binWidth,
    volume: 0,
  }));

  for (const c of candles) {
    const first = Math.min(binCount - 1, Math.max(0, Math.floor((c.l - low) / binWidth)));
    const last = Math.min(binCount - 1, Math.max(0, Math.floor((c.h - low) / binWidth)));
    const span = last - first + 1;
    const share = c.v / span;
    for (let i = first; i <= last; i++) bins[i].volume += share;
  }

  let pocIndex = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i].volume > bins[pocIndex].volume) pocIndex = i;
  const poc = (bins[pocIndex].low + bins[pocIndex].high) / 2;

  // Grow out from the point of control, taking the heavier neighbour each step, until the
  // requested share of volume is enclosed. This is the standard market-profile procedure.
  const total = bins.reduce((s, b) => s + b.volume, 0);
  const target = total * valueAreaPct;
  let lo = pocIndex;
  let hi = pocIndex;
  let held = bins[pocIndex].volume;
  while (held < target && (lo > 0 || hi < bins.length - 1)) {
    const below = lo > 0 ? bins[lo - 1].volume : -1;
    const above = hi < bins.length - 1 ? bins[hi + 1].volume : -1;
    if (above >= below) {
      hi += 1;
      held += bins[hi].volume;
    } else {
      lo -= 1;
      held += bins[lo].volume;
    }
  }

  return {
    bins,
    poc,
    valueArea: { low: bins[lo].low, high: bins[hi].high },
    binWidth,
    valueAreaPct,
    basis: 'volume',
  };
}
