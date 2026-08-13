// Volume-weighted average price from a bar the agent picks.
//
// The anchor is the whole feature. A session VWAP needs a session, and crypto does not
// have one, so any daily anchor is an arbitrary choice dressed as a convention. Letting
// the agent anchor to a bar it can justify (the swing low, the news candle, the range
// break) is both more honest and more useful.

import type { Candle } from '../types.ts';

export function anchoredVwap(candles: Candle[], anchorIndex: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (anchorIndex < 0 || anchorIndex >= candles.length) return out;

  let volume = 0;
  let notional = 0;
  for (let i = anchorIndex; i < candles.length; i++) {
    const c = candles[i];
    const typical = (c.h + c.l + c.c) / 3;
    volume += c.v;
    notional += typical * c.v;
    // A stretch with no volume has no volume-weighted price. Reporting null beats
    // reporting the unweighted mean under a name that claims weighting.
    out[i] = volume > 0 ? notional / volume : null;
  }
  return out;
}
