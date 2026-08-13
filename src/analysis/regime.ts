// Average true range, and where the current reading sits in its own recent history.
//
// The percentile is the part that carries the meaning and also the part that lies if you
// let it. It is relative to the lookback window, so a 252-bar window that happens to cover
// a wilder stretch will call an objectively violent market "normal". There is no fix for
// that inside the primitive, so the result carries `lookback` and `period` and the agent
// gets to decide whether the window was fair.
//
// Direction is deliberately absent. Average true range does not know which way price went
// and a regime that implied a direction would be a conclusion, not a measurement.

import type { Candle } from '../types.ts';

function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out.push(c.h - c.l);
      continue;
    }
    const prev = candles[i - 1].c;
    out.push(Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev)));
  }
  return out;
}

export function atr(candles: Candle[], period: number): (number | null)[] {
  const tr = trueRanges(candles);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period || period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let current = sum / period;
  out[period - 1] = current;

  // Wilder smoothing: the conventional average true range, not an exponential moving
  // average with the same period. They differ and the difference shows up in stop distance.
  for (let i = period; i < candles.length; i++) {
    current = (current * (period - 1) + tr[i]) / period;
    out[i] = current;
  }
  return out;
}

export type Regime = {
  atr: number;
  percentile: number;
  bucket: 'compressed' | 'normal' | 'elevated' | 'extreme';
  period: number;
  lookback: number;
};

function bucketFor(p: number): Regime['bucket'] {
  if (p < 0.2) return 'compressed';
  if (p > 0.95) return 'extreme';
  if (p > 0.8) return 'elevated';
  return 'normal';
}

export function regime(
  candles: Candle[],
  opts: { period: number; lookback: number },
): Regime | null {
  const { period, lookback } = opts;
  const series = atr(candles, period);
  const defined = series.filter((v): v is number => v !== null);
  if (defined.length < 2) return null;

  const current = defined[defined.length - 1];
  const window = defined.slice(-lookback);
  if (window.length < 2) return null;

  const below = window.filter((v) => v < current).length;
  const percentile = below / (window.length - 1);

  return { atr: current, percentile, bucket: bucketFor(percentile), period, lookback };
}
