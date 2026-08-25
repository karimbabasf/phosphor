// The series maths every indicator is built out of. Pure functions, no state, no I/O.
//
// This file exists because src/indicators.ts stopped being the only place indicators are
// written. src/indicators-library.ts holds the second catalogue (the wave and structure
// family) and needs the same averages, and two copies of an EMA is exactly the defect the
// header of src/indicators.ts warns about, one file further out: the number the agent reads
// and the pixel the human sees would come from different arithmetic.
//
// Every series returned here is index-aligned with its input: values[i] belongs to input[i],
// and a leading null means "not enough history yet", never zero. Zero is a real value for a
// MACD histogram and for OBV, so the two must never be confused.

import type { Candle } from './types.ts';

export function nulls(n: number): (number | null)[] {
  return new Array<number | null>(n).fill(null);
}

export function lastValue(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

// The value `back` defined entries before the newest one, which is what a cross test needs:
// "did these two lines swap sides on the last bar" is a question about two bars, not one.
export function valueBefore(values: (number | null)[], back: number): number | null {
  let seen = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (seen === back) return v;
    seen += 1;
  }
  return null;
}

// Direction over the last `back` defined values. Used for the state line: a level with no
// direction reads the same whether it is climbing or falling, which is half the information.
export function drift(values: (number | null)[], back: number): 'rising' | 'falling' | 'flat' {
  const defined: number[] = [];
  for (let i = values.length - 1; i >= 0 && defined.length <= back; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) defined.push(v);
  }
  if (defined.length < 2) return 'flat';
  const now = defined[0] as number;
  const then = defined[defined.length - 1] as number;
  const span = Math.abs(then) > 0 ? Math.abs((now - then) / then) : 0;
  if (span < 0.0002) return 'flat';
  return now > then ? 'rising' : 'falling';
}

export function sma(source: number[], period: number): (number | null)[] {
  const out = nulls(source.length);
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    sum += source[i] as number;
    if (i >= period) sum -= source[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(source: number[], period: number): (number | null)[] {
  const out = nulls(source.length);
  if (source.length < period) return out;
  const alpha = 2 / (period + 1);
  // Seeded with the simple average of the first window, which is the convention every
  // charting package uses. Seeding with source[0] instead shifts the whole line.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += source[i] as number;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < source.length; i++) {
    prev = (source[i] as number) * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

export function wma(source: number[], period: number): (number | null)[] {
  const out = nulls(source.length);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < source.length; i++) {
    let acc = 0;
    for (let k = 0; k < period; k++) acc += (source[i - period + 1 + k] as number) * (k + 1);
    out[i] = acc / denom;
  }
  return out;
}

// Wilder's smoothing: the RSI and ATR average, which is an EMA with alpha 1/period.
export function wilder(source: number[], period: number): (number | null)[] {
  const out = nulls(source.length);
  if (source.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += source[i] as number;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < source.length; i++) {
    prev = (prev * (period - 1) + (source[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}

// The same EMA over a series that already has holes in it. The wave family stacks averages on
// averages (an EMA of an EMA of a deviation), and the plain ema() above cannot be handed a
// sparse array without reading a null as a number. Nulls pass through and the average resumes
// from the first defined value after them.
export function emaSparse(source: (number | null)[], period: number): (number | null)[] {
  const out = nulls(source.length);
  const alpha = 2 / (period + 1);
  let prev: number | null = null;
  let seeded = 0;
  let seedSum = 0;
  for (let i = 0; i < source.length; i++) {
    const v = source[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (prev === null) {
      seedSum += v;
      seeded += 1;
      if (seeded < period) continue;
      prev = seedSum / period;
      out[i] = prev;
      continue;
    }
    prev = v * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

// A rolling mean over a series with holes, same reason as emaSparse.
export function smaSparse(source: (number | null)[], period: number): (number | null)[] {
  const out = nulls(source.length);
  const window: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const v = source[i];
    if (v === null || !Number.isFinite(v)) continue;
    window.push(v);
    if (window.length > period) window.shift();
    if (window.length === period) out[i] = window.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

// Population standard deviation over a rolling window, which is what every band indicator
// (Bollinger, the VWAP envelope) uses. Sample deviation would widen every band by a hair and
// disagree with the chart the human is comparing against.
export function stdev(source: number[], period: number): (number | null)[] {
  const out = nulls(source.length);
  const mean = sma(source, period);
  for (let i = period - 1; i < source.length; i++) {
    const m = mean[i] as number;
    let acc = 0;
    for (let k = 0; k < period; k++) {
      const d = (source[i - k] as number) - m;
      acc += d * d;
    }
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.c);
}

export function opens(candles: Candle[]): number[] {
  return candles.map((c) => c.o);
}

export function highs(candles: Candle[]): number[] {
  return candles.map((c) => c.h);
}

export function lows(candles: Candle[]): number[] {
  return candles.map((c) => c.l);
}

// (high + low + close) / 3. Called the typical price by every source that uses it, and it is
// the input to CCI, MFI, the money flow ribbon and the wave oscillator.
export function typical(candles: Candle[]): number[] {
  return candles.map((c) => (c.h + c.l + c.c) / 3);
}

export function trueRange(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i] as Candle;
    if (i === 0) {
      out.push(c.h - c.l);
      continue;
    }
    const prev = (candles[i - 1] as Candle).c;
    out.push(Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev)));
  }
  return out;
}

// Average true range as Wilder wrote it, which is the version every ATR stop and every
// SuperTrend is drawn from. src/analysis/regime.ts has its own for the measurement surface;
// this one exists so an indicator pane does not have to import the analysis layer.
export function atrSeries(candles: Candle[], period: number): (number | null)[] {
  return wilder(trueRange(candles), period);
}

// Did `a` cross above `b` on the last bar that has both. Returns null when either series is
// still warming up, which is different from "no cross" and has to stay different: a warmup is
// not evidence of anything.
export function crossState(
  a: (number | null)[],
  b: (number | null)[],
): 'up' | 'down' | 'above' | 'below' | null {
  const aNow = lastValue(a);
  const bNow = lastValue(b);
  const aPrev = valueBefore(a, 1);
  const bPrev = valueBefore(b, 1);
  if (aNow === null || bNow === null) return null;
  if (aPrev === null || bPrev === null) return aNow > bNow ? 'above' : 'below';
  if (aPrev <= bPrev && aNow > bNow) return 'up';
  if (aPrev >= bPrev && aNow < bNow) return 'down';
  return aNow > bNow ? 'above' : 'below';
}

// How many bars ago the two series last swapped sides, or null if they never did inside the
// window. A cross with no age is half an answer: "wave crossed up" reads as news whether it
// happened on this bar or forty bars ago.
export function barsSinceCross(a: (number | null)[], b: (number | null)[]): number | null {
  let side: number | null = null;
  for (let i = a.length - 1; i >= 0; i--) {
    const av = a[i];
    const bv = b[i];
    if (av === null || bv === null || !Number.isFinite(av) || !Number.isFinite(bv)) continue;
    const now = av > bv ? 1 : -1;
    if (side === null) {
      side = now;
      continue;
    }
    if (now !== side) return a.length - 1 - i;
  }
  return null;
}

// Compact number for a state line. Big prices do not want four decimals and small ones are
// unreadable without them.
export function num(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return Number(value.toFixed(digits)).toString();
}

export function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

// Where price sits against an overlay line, which is the only question anyone asks of a
// moving average or a band edge.
export function versusPrice(candles: Candle[], line: (number | null)[], name: string): string {
  const value = lastValue(line);
  const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : null;
  if (value === null || last === null) return `${name}: not enough history yet`;
  const gap = ((last - value) / value) * 100;
  const side = gap >= 0 ? 'above' : 'below';
  return `${name} ${num(value)}, ${drift(line, 5)}, price ${side} by ${Math.abs(gap).toFixed(2)}%`;
}

// Wilder's relative strength index over the closes. Lifted out of the RSI spec in
// src/indicators.ts when the stochastic RSI and the wave family needed the same array: two
// RSIs in one app would eventually disagree by a rounding rule and nothing would fail loudly.
export function rsiSeries(source: number[], period: number): (number | null)[] {
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < source.length; i++) {
    const change = (source[i] as number) - (source[i - 1] as number);
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  // The first change is at index 1, so both averages start one bar late.
  const avgGain = wilder(gains.slice(1), period);
  const avgLoss = wilder(losses.slice(1), period);
  const out = nulls(source.length);
  for (let i = 0; i < avgGain.length; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g === null || l === null) continue;
    // No losses at all is 100 by the formula, but no movement at all is neither strong nor
    // weak, and reporting 100 for a flat book would read as a breakout to an agent.
    out[i + 1] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}

// Least-squares value of a rolling regression at its own last point. The squeeze momentum
// histogram is defined as this and nothing else; a plain average would draw a different shape.
export function linregSeries(source: (number | null)[], period: number): (number | null)[] {
  const out = nulls(source.length);
  for (let i = period - 1; i < source.length; i++) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    let complete = true;
    for (let k = 0; k < period; k++) {
      const v = source[i - period + 1 + k];
      if (v === null || !Number.isFinite(v)) {
        complete = false;
        break;
      }
      const x = k;
      n += 1;
      sx += x;
      sy += v;
      sxy += x * v;
      sxx += x * x;
    }
    if (!complete || n < 2) continue;
    const denom = n * sxx - sx * sx;
    if (denom === 0) continue;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    out[i] = intercept + slope * (period - 1);
  }
  return out;
}

// Highest high and lowest low over a rolling window. Donchian, Ichimoku, the stochastic and
// the liquidity sweep all ask the same question, so they ask it in one place.
export function rollingHigh(values: number[], period: number): (number | null)[] {
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let hi = -Infinity;
    for (let k = 0; k < period; k++) hi = Math.max(hi, values[i - k] as number);
    out[i] = hi;
  }
  return out;
}

export function rollingLow(values: number[], period: number): (number | null)[] {
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let lo = Infinity;
    for (let k = 0; k < period; k++) lo = Math.min(lo, values[i - k] as number);
    out[i] = lo;
  }
  return out;
}
