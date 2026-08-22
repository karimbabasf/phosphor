// The second catalogue: the wave, trend and volatility family a trader actually asks for.
//
// WHY THIS FILE EXISTS. src/indicators.ts shipped the twelve everybody agrees on, and the
// first real session made the gap obvious: asked for a wave oscillator, a squeeze or a
// SuperTrend, the agent had to say the chart could not draw it and then describe it in prose.
// A number in prose cannot be measured against, cannot anchor a trend line and cannot be a
// mandate trigger. So these are drawn by the same renderer, read by the same `chart_read`, and
// reachable by the same `indicator_series` op as everything else.
//
// WHAT THESE ARE, PRECISELY. Every indicator here is written from its published formula. There
// is no vendored code, no third-party dependency, and no affiliation with, or endorsement by,
// the authors of any charting product. Where a well-known TradingView study is a named
// arrangement of public maths, the maths is what is implemented and the name used here says
// what it measures rather than whose product it is:
//
//   `wave`         the WaveTrend oscillator, published by LazyBear in 2014. It is the engine
//                  inside the paid "market cipher B" style dashboards; the channel index, the
//                  two averages and the 53/60 bands are the whole of it.
//   `moneyflow`    the candle-body money flow ribbon those same dashboards draw under price.
//   `squeeze`      Squeeze Momentum, LazyBear's arrangement of Bollinger inside Keltner.
//   `supertrend`   the ATR trend flip that most "smart trend" overlays are built on.
//   `structure`    lives in src/analysis/structure.ts, not here, because order blocks and gaps
//                  are boxes and measurements rather than series.
//
// NONE OF THEM IS A SIGNAL. Every `state` line here reports where the number is and what it
// just did. It never says buy, sell, long, short, or "bullish". That line is the same one
// src/analysis holds and it is the design: the agent reads, the app measures. An indicator
// that shipped an opinion would be replacing the judgment the agent exists to provide.

import type { Candle } from './types.ts';
import type { IndicatorSpec, ParamSpec, Plot } from './indicators.ts';
import {
  atrSeries,
  barsSinceCross,
  closes,
  crossState,
  drift,
  ema,
  emaSparse,
  highs,
  lastValue,
  linregSeries,
  lows,
  nulls,
  num,
  rollingHigh,
  rollingLow,
  rsiSeries,
  sma,
  smaSparse,
  stdev,
  typical,
  versusPrice,
  wma,
} from './indicators-kit.ts';

const int = (name: string, def: number, min: number, max: number): ParamSpec => ({
  name,
  def,
  min,
  max,
  int: true,
});

const real = (name: string, def: number, min: number, max: number): ParamSpec => ({
  name,
  def,
  min,
  max,
  int: false,
});

// How far a value sits inside a band, as a percentage of the band. The one sentence every
// oscillator state line wants and none of them should compute twice.
function place(value: number, low: number, high: number): string {
  if (!(high > low)) return 'flat band';
  return `${(((value - low) / (high - low)) * 100).toFixed(0)}% of the band`;
}

function crossWords(
  a: (number | null)[],
  b: (number | null)[],
  aName: string,
  bName: string,
): string {
  const side = crossState(a, b);
  if (side === null) return 'not enough history yet';
  const age = barsSinceCross(a, b);
  const since = age === null ? '' : `, ${age} ${age === 1 ? 'bar' : 'bars'} since the last cross`;
  if (side === 'up') return `${aName} crossed above ${bName} on this bar`;
  if (side === 'down') return `${aName} crossed below ${bName} on this bar`;
  return `${aName} ${side} ${bName}${since}`;
}

/* ---------- the wave family ---------- */

// WaveTrend, LazyBear 2014. Channel index of the typical price against its own EMA, smoothed
// twice. The 53 and 60 bands are the author's, not this app's, and they are drawn as guides so
// the agent reads the same reference lines the human does.
function waveSeries(
  candles: Candle[],
  channel: number,
  average: number,
  signal: number,
): { wt1: (number | null)[]; wt2: (number | null)[]; hist: (number | null)[] } {
  const ap = typical(candles);
  const esa = ema(ap, channel);
  const dev = nulls(candles.length);
  for (let i = 0; i < ap.length; i++) {
    const e = esa[i];
    if (e === null) continue;
    dev[i] = Math.abs((ap[i] as number) - e);
  }
  const d = emaSparse(dev, channel);
  const ci = nulls(candles.length);
  for (let i = 0; i < ap.length; i++) {
    const e = esa[i];
    const dd = d[i];
    if (e === null || dd === null) continue;
    // A dead-flat window divides by zero. Zero deviation means the price has not left its own
    // average, which is a channel index of zero, not an infinity.
    ci[i] = dd === 0 ? 0 : ((ap[i] as number) - e) / (0.015 * dd);
  }
  const wt1 = emaSparse(ci, average);
  const wt2 = smaSparse(wt1, signal);
  const hist = nulls(candles.length);
  for (let i = 0; i < wt1.length; i++) {
    const a = wt1[i];
    const b = wt2[i];
    if (a === null || b === null) continue;
    hist[i] = a - b;
  }
  return { wt1, wt2, hist };
}

const WAVE: IndicatorSpec = {
  type: 'wave',
  pane: 'own',
  summary:
    'WaveTrend oscillator (LazyBear): the typical price as a channel index, smoothed twice, with its signal line and their difference. The engine inside the "market cipher B" style dashboards. Overbought and oversold bands at 53 and 60.',
  params: [int('channel', 9, 2, 100), int('average', 12, 2, 100), int('signal', 4, 1, 50)],
  label: (p) => `WAVE ${p.channel}/${p.average}`,
  warmup: (p) => p.channel * 2 + p.average + p.signal,
  compute(candles, p) {
    const { wt1, wt2, hist } = waveSeries(candles, p.channel, p.average, p.signal);
    const value = lastValue(wt1);
    const state =
      value === null
        ? 'wave: not enough history yet'
        : `wave ${value.toFixed(1)}, ${drift(wt1, 4)}, ` +
          (value >= 60
            ? 'above the 60 band'
            : value <= -60
              ? 'below the -60 band'
              : 'inside the bands') +
          `. ${crossWords(wt1, wt2, 'wave', 'its signal')}`;
    return {
      plots: [
        { key: 'hist', label: 'difference', style: 'histogram', emphasis: 0.4, signed: true, values: hist },
        { key: 'wt1', label: 'wave', style: 'line', emphasis: 1, values: wt1 },
        { key: 'wt2', label: 'signal', style: 'line', emphasis: 0.6, values: wt2 },
      ],
      guides: [
        { value: 60, label: '60' },
        { value: 53, label: '53' },
        { value: 0, label: '0' },
        { value: -53, label: '-53' },
        { value: -60, label: '-60' },
      ],
      range: null,
      state,
    };
  },
};

// The money flow ribbon those same dashboards draw: the share of each candle's range that the
// body took, averaged. It is not the Money Flow Index (that is `mfi` below, and it is
// volume-weighted); this one is body geometry and needs no volume, which is why it still works
// on a venue that reports none.
const MONEYFLOW: IndicatorSpec = {
  type: 'moneyflow',
  pane: 'own',
  summary:
    'Candle-body money flow: how much of each bar\'s range the body took, averaged and scaled. Positive is buying pressure inside the range, negative is selling. Needs no volume, so it works on any venue.',
  params: [int('period', 60, 2, 400), real('multiplier', 150, 1, 1000)],
  label: (p) => `MF ${p.period}`,
  compute(candles, p) {
    const raw: number[] = candles.map((c) => {
      const range = c.h - c.l;
      // A doji with no range at all took no share of anything. Zero, not a division by zero.
      return range === 0 ? 0 : ((c.c - c.o) / range) * p.multiplier;
    });
    const line = sma(raw, p.period);
    const value = lastValue(line);
    const state =
      value === null
        ? 'money flow: not enough history yet'
        : `money flow ${value.toFixed(1)}, ${drift(line, 5)}, ${value >= 0 ? 'above' : 'below'} the zero line`;
    return {
      plots: [
        { key: 'mf', label: 'money flow', style: 'histogram', emphasis: 0.8, signed: true, values: line },
      ],
      guides: [{ value: 0, label: '0' }],
      range: null,
      state,
    };
  },
};

/* ---------- trend overlays ---------- */

const SUPERTREND: IndicatorSpec = {
  type: 'supertrend',
  pane: 'price',
  summary:
    'SuperTrend: an ATR band that only ever moves towards price, and flips side when price closes through it. The line is the stop; the flip is the event. PATH DEPENDENT: the band ratchets from the first bar it was given, so reading it over 200 bars and over 400 bars can disagree about the current side. Every other indicator here is a pure function of the last N bars; this one is not. Keep the window fixed when comparing two reads.',
  params: [int('period', 10, 2, 100), real('multiplier', 3, 0.5, 20)],
  label: (p) => `ST ${p.period}/${p.multiplier}`,
  compute(candles, p) {
    const atr = atrSeries(candles, p.period);
    const line = nulls(candles.length);
    const dir = nulls(candles.length);
    let upper = Number.NaN;
    let lower = Number.NaN;
    let trend = 1;
    for (let i = 0; i < candles.length; i++) {
      const a = atr[i];
      const c = candles[i] as Candle;
      if (a === null) continue;
      const mid = (c.h + c.l) / 2;
      const rawUpper = mid + p.multiplier * a;
      const rawLower = mid - p.multiplier * a;
      const prevClose = i > 0 ? (candles[i - 1] as Candle).c : c.c;
      // The ratchet: a band only tightens while the trend holds, and resets on the flip. Without
      // it the line chases price back and forth and stops being a stop.
      upper = Number.isFinite(upper) && prevClose <= upper ? Math.min(rawUpper, upper) : rawUpper;
      lower = Number.isFinite(lower) && prevClose >= lower ? Math.max(rawLower, lower) : rawLower;
      if (c.c > upper) trend = 1;
      else if (c.c < lower) trend = -1;
      line[i] = trend === 1 ? lower : upper;
      dir[i] = trend;
    }
    const value = lastValue(line);
    const side = lastValue(dir);
    const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : null;
    let flipAge: number | null = null;
    for (let i = dir.length - 1; i > 0; i--) {
      if (dir[i] === null || dir[i - 1] === null) continue;
      if (dir[i] !== dir[i - 1]) {
        flipAge = dir.length - 1 - i;
        break;
      }
    }
    const state =
      value === null || side === null || last === null
        ? 'supertrend: not enough history yet'
        : `supertrend ${num(value)}, line ${side === 1 ? 'below' : 'above'} price, ` +
          `${Math.abs(((last - value) / value) * 100).toFixed(2)}% away` +
          (flipAge === null ? ', no flip inside the window' : `, ${flipAge} ${flipAge === 1 ? 'bar' : 'bars'} since the flip`);
    return {
      plots: [{ key: 'supertrend', label: 'supertrend', style: 'line', emphasis: 0.95, values: line }],
      guides: [],
      range: null,
      state,
    };
  },
};

const HMA: IndicatorSpec = {
  type: 'hma',
  pane: 'price',
  summary:
    'Hull moving average: a weighted average of two weighted averages, which turns far sooner than an EMA of the same length and overshoots less.',
  params: [int('period', 55, 4, 400)],
  label: (p) => `HMA ${p.period}`,
  compute(candles, p) {
    const src = closes(candles);
    const half = Math.max(2, Math.round(p.period / 2));
    const sqrt = Math.max(2, Math.round(Math.sqrt(p.period)));
    const fast = wma(src, half);
    const slow = wma(src, p.period);
    const raw: number[] = new Array(src.length).fill(Number.NaN);
    for (let i = 0; i < src.length; i++) {
      const f = fast[i];
      const s = slow[i];
      if (f === null || s === null) continue;
      raw[i] = 2 * f - s;
    }
    // wma() cannot read a NaN, so the final smoothing runs over the defined tail only and is
    // written back at the right index. A shifted Hull is a wrong Hull.
    const firstDefined = raw.findIndex((v) => Number.isFinite(v));
    const line = nulls(src.length);
    if (firstDefined >= 0) {
      const tail = wma(raw.slice(firstDefined), sqrt);
      for (let i = 0; i < tail.length; i++) line[firstDefined + i] = tail[i];
    }
    return {
      plots: [{ key: 'hma', label: `HMA ${p.period}`, style: 'line', emphasis: 0.9, values: line }],
      guides: [],
      range: null,
      state: versusPrice(candles, line, `HMA(${p.period})`),
    };
  },
};

// Four EMAs in one overlay slot. The cap is eight overlays and a ribbon is the commonest reason
// to want more than that, so this spends one slot instead of four.
const RIBBON: IndicatorSpec = {
  type: 'ribbon',
  pane: 'price',
  summary:
    'A four EMA ribbon in one overlay slot: fast, then three multiples of it. Read the spacing and the order, not any single line.',
  params: [int('fast', 8, 2, 200), int('step', 3, 1, 20)],
  label: (p) => `RIBBON ${p.fast}x${p.step}`,
  warmup: (p) => p.fast * p.step * 3,
  compute(candles, p) {
    const src = closes(candles);
    const lengths = [p.fast, p.fast * p.step, p.fast * p.step * 2, p.fast * p.step * 3];
    const plots: Plot[] = lengths.map((len, i) => ({
      key: `ema${len}`,
      label: `EMA ${len}`,
      style: 'line' as const,
      emphasis: 0.95 - i * 0.18,
      values: ema(src, len),
    }));
    const values = plots.map((plot) => lastValue(plot.values));
    const ordered = values.every((v, i) => v !== null && (i === 0 || (values[i - 1] as number) > v));
    const inverted = values.every((v, i) => v !== null && (i === 0 || (values[i - 1] as number) < v));
    const first = values[0];
    const last = values[values.length - 1];
    const spread =
      first === null || last === null || last === 0 ? null : Math.abs(((first - last) / last) * 100);
    const state =
      values.some((v) => v === null)
        ? 'ribbon: not enough history yet'
        : `ribbon ${ordered ? 'stacked fast over slow' : inverted ? 'stacked slow over fast' : 'crossed, no order'}` +
          (spread === null ? '' : `, ${spread.toFixed(2)}% between the fastest and the slowest`);
    return { plots, guides: [], range: null, state };
  },
};

const ICHIMOKU: IndicatorSpec = {
  type: 'ichimoku',
  pane: 'price',
  summary:
    'Ichimoku: conversion and base lines, and the two cloud edges. The cloud is drawn where it is computed rather than pushed forward, so every value on screen belongs to the bar under it.',
  params: [int('conversion', 9, 2, 100), int('base', 26, 2, 200), int('span', 52, 2, 400)],
  label: (p) => `ICHI ${p.conversion}/${p.base}/${p.span}`,
  warmup: (p) => p.span + p.base,
  compute(candles, p) {
    const h = highs(candles);
    const l = lows(candles);
    const mid = (period: number): (number | null)[] => {
      const hi = rollingHigh(h, period);
      const lo = rollingLow(l, period);
      const out = nulls(candles.length);
      for (let i = 0; i < out.length; i++) {
        const a = hi[i];
        const b = lo[i];
        if (a === null || b === null) continue;
        out[i] = (a + b) / 2;
      }
      return out;
    };
    const tenkan = mid(p.conversion);
    const kijun = mid(p.base);
    const spanA = nulls(candles.length);
    for (let i = 0; i < spanA.length; i++) {
      const a = tenkan[i];
      const b = kijun[i];
      if (a === null || b === null) continue;
      spanA[i] = (a + b) / 2;
    }
    const spanB = mid(p.span);
    const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : null;
    const a = lastValue(spanA);
    const b = lastValue(spanB);
    const state =
      last === null || a === null || b === null
        ? 'ichimoku: not enough history yet'
        : `cloud ${num(Math.min(a, b))} to ${num(Math.max(a, b))}, price ` +
          (last > Math.max(a, b) ? 'above it' : last < Math.min(a, b) ? 'below it' : 'inside it') +
          `. ${crossWords(tenkan, kijun, 'conversion', 'base')}`;
    return {
      plots: [
        { key: 'spanA', label: 'span A', style: 'band', emphasis: 0.35, fillTo: 'spanB', values: spanA },
        { key: 'spanB', label: 'span B', style: 'line', emphasis: 0.35, values: spanB },
        { key: 'tenkan', label: 'conversion', style: 'line', emphasis: 0.9, values: tenkan },
        { key: 'kijun', label: 'base', style: 'line', emphasis: 0.7, values: kijun },
      ],
      guides: [],
      range: null,
      state,
    };
  },
};

/* ---------- volatility ---------- */

const KELTNER: IndicatorSpec = {
  type: 'keltner',
  pane: 'price',
  summary:
    'Keltner channel: an EMA basis with an ATR envelope. Wider than Bollinger in a trend and narrower in chop, which is the pair the squeeze is read from.',
  params: [int('period', 20, 2, 400), real('multiplier', 1.5, 0.1, 10), int('atrPeriod', 10, 2, 100)],
  label: (p) => `KC ${p.period}/${p.multiplier}`,
  warmup: (p) => Math.max(p.period, p.atrPeriod) + p.atrPeriod,
  compute(candles, p) {
    const basis = ema(closes(candles), p.period);
    const atr = atrSeries(candles, p.atrPeriod);
    const upper = nulls(candles.length);
    const lower = nulls(candles.length);
    for (let i = 0; i < candles.length; i++) {
      const m = basis[i];
      const a = atr[i];
      if (m === null || a === null) continue;
      upper[i] = m + a * p.multiplier;
      lower[i] = m - a * p.multiplier;
    }
    const up = lastValue(upper);
    const lo = lastValue(lower);
    const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : null;
    const state =
      up === null || lo === null || last === null
        ? 'keltner: not enough history yet'
        : `keltner ${num(lo)} to ${num(up)}, price at ${place(last, lo, up)}`;
    return {
      plots: [
        { key: 'upper', label: 'upper', style: 'band', emphasis: 0.45, fillTo: 'lower', values: upper },
        { key: 'basis', label: 'basis', style: 'line', emphasis: 0.7, values: basis },
        { key: 'lower', label: 'lower', style: 'line', emphasis: 0.45, values: lower },
      ],
      guides: [],
      range: null,
      state,
    };
  },
};

// Squeeze Momentum, LazyBear. Two facts on one pane: whether Bollinger is inside Keltner (the
// squeeze), and the regression of price against its own mid-range (the momentum).
const SQUEEZE: IndicatorSpec = {
  type: 'squeeze',
  pane: 'own',
  summary:
    'Squeeze momentum (LazyBear): the histogram is a linear regression of price against its own mid-range; the squeeze is on while the Bollinger bands sit inside the Keltner channel. Reports how many bars the squeeze has lasted.',
  params: [
    int('period', 20, 4, 400),
    real('bbMult', 2, 0.1, 6),
    real('kcMult', 1.5, 0.1, 6),
  ],
  label: (p) => `SQZ ${p.period}`,
  warmup: (p) => p.period * 2,
  compute(candles, p) {
    const src = closes(candles);
    const basis = sma(src, p.period);
    const dev = stdev(src, p.period);
    const range = sma(
      candles.map((c) => c.h - c.l),
      p.period,
    );
    const on = nulls(candles.length);
    for (let i = 0; i < candles.length; i++) {
      const m = basis[i];
      const d = dev[i];
      const r = range[i];
      if (m === null || d === null || r === null) continue;
      const bbUpper = m + d * p.bbMult;
      const bbLower = m - d * p.bbMult;
      const kcUpper = m + r * p.kcMult;
      const kcLower = m - r * p.kcMult;
      on[i] = bbLower > kcLower && bbUpper < kcUpper ? 1 : 0;
    }
    const hi = rollingHigh(highs(candles), p.period);
    const lo = rollingLow(lows(candles), p.period);
    const source = nulls(candles.length);
    for (let i = 0; i < candles.length; i++) {
      const a = hi[i];
      const b = lo[i];
      const m = basis[i];
      if (a === null || b === null || m === null) continue;
      source[i] = (src[i] as number) - ((a + b) / 2 + m) / 2;
    }
    const mom = linregSeries(source, p.period);
    // The squeeze is drawn as the zero-line dots every version of this indicator has: one bar
    // per state, so the human sees the compression band without a second pane.
    const dots = nulls(candles.length);
    for (let i = 0; i < on.length; i++) if (on[i] !== null) dots[i] = 0;
    let run = 0;
    for (let i = on.length - 1; i >= 0; i--) {
      if (on[i] === null) break;
      if (on[i] !== (on[on.length - 1] ?? null)) break;
      run += 1;
    }
    const nowOn = lastValue(on);
    const value = lastValue(mom);
    const state =
      value === null || nowOn === null
        ? 'squeeze: not enough history yet'
        : `squeeze ${nowOn === 1 ? 'on' : 'off'} for ${run} ${run === 1 ? 'bar' : 'bars'}, ` +
          `momentum ${value.toFixed(4)}, ${drift(mom, 4)}, ${value >= 0 ? 'above' : 'below'} zero`;
    return {
      plots: [
        { key: 'momentum', label: 'momentum', style: 'histogram', emphasis: 0.85, signed: true, values: mom },
        { key: 'squeeze', label: 'squeeze', style: 'line', emphasis: 0.4, values: dots },
      ],
      guides: [{ value: 0, label: '0' }],
      range: null,
      state,
    };
  },
};

const VWAPBANDS: IndicatorSpec = {
  type: 'vwapbands',
  pane: 'price',
  summary:
    'Session VWAP with a standard deviation envelope, re-anchored at each UTC day. The bands are where the day\'s volume actually traded, not a moving average of price.',
  params: [real('multiplier', 1, 0.1, 6)],
  label: (p) => `VWAP±${p.multiplier}`,
  compute(candles, p) {
    const tp = typical(candles);
    const mid = nulls(candles.length);
    const upper = nulls(candles.length);
    const lower = nulls(candles.length);
    let day = -1;
    let pv = 0;
    let vol = 0;
    let pv2 = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i] as Candle;
      const thisDay = Math.floor(c.t / 86400);
      if (thisDay !== day) {
        day = thisDay;
        pv = 0;
        vol = 0;
        pv2 = 0;
      }
      const price = tp[i] as number;
      pv += price * c.v;
      pv2 += price * price * c.v;
      vol += c.v;
      if (vol <= 0) continue;
      const mean = pv / vol;
      // Volume-weighted variance. Clamped at zero because floating point can make a variance
      // of a single-price session very slightly negative, and a NaN band draws nothing.
      const variance = Math.max(0, pv2 / vol - mean * mean);
      const sd = Math.sqrt(variance);
      mid[i] = mean;
      upper[i] = mean + sd * p.multiplier;
      lower[i] = mean - sd * p.multiplier;
    }
    const up = lastValue(upper);
    const lo = lastValue(lower);
    const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : null;
    const state =
      up === null || lo === null || last === null
        ? 'vwap bands: not enough history yet'
        : `${versusPrice(candles, mid, 'VWAP')}, band ${num(lo)} to ${num(up)}, price at ${place(last, lo, up)}`;
    return {
      plots: [
        { key: 'upper', label: 'upper', style: 'band', emphasis: 0.4, fillTo: 'lower', values: upper },
        { key: 'vwap', label: 'VWAP', style: 'line', emphasis: 0.9, values: mid },
        { key: 'lower', label: 'lower', style: 'line', emphasis: 0.4, values: lower },
      ],
      guides: [],
      range: null,
      state,
    };
  },
};

/* ---------- momentum panes ---------- */

const ADX: IndicatorSpec = {
  type: 'adx',
  pane: 'own',
  summary:
    'Directional movement: +DI, -DI and the ADX that measures how strongly either of them is winning. ADX says how much trend there is, never which way.',
  params: [int('period', 14, 2, 200)],
  label: (p) => `ADX ${p.period}`,
  warmup: (p) => p.period * 3,
  compute(candles, p) {
    const n = candles.length;
    const plusDM: number[] = [0];
    const minusDM: number[] = [0];
    const tr: number[] = [0];
    for (let i = 1; i < n; i++) {
      const c = candles[i] as Candle;
      const prev = candles[i - 1] as Candle;
      const up = c.h - prev.h;
      const down = prev.l - c.l;
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
      tr.push(Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)));
    }
    // Wilder's own smoothing, expressed as a running sum rather than an average, which is how
    // the original is defined and is what keeps +DI and -DI on the same 0..100 scale.
    const smooth = (values: number[]): (number | null)[] => {
      const out = nulls(n);
      if (n <= p.period) return out;
      let acc = 0;
      for (let i = 1; i <= p.period; i++) acc += values[i] as number;
      out[p.period] = acc;
      for (let i = p.period + 1; i < n; i++) {
        acc = acc - acc / p.period + (values[i] as number);
        out[i] = acc;
      }
      return out;
    };
    const sTr = smooth(tr);
    const sPlus = smooth(plusDM);
    const sMinus = smooth(minusDM);
    const plus = nulls(n);
    const minus = nulls(n);
    const dx = nulls(n);
    for (let i = 0; i < n; i++) {
      const t = sTr[i];
      const a = sPlus[i];
      const b = sMinus[i];
      if (t === null || a === null || b === null || t === 0) continue;
      const pdi = (a / t) * 100;
      const mdi = (b / t) * 100;
      plus[i] = pdi;
      minus[i] = mdi;
      const sum = pdi + mdi;
      dx[i] = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
    }
    const adx = smaSparse(dx, p.period);
    const value = lastValue(adx);
    const state =
      value === null
        ? `ADX(${p.period}): not enough history yet`
        : `ADX ${value.toFixed(1)}, ${drift(adx, 4)}, ` +
          (value >= 25 ? 'above the 25 line' : 'below the 25 line') +
          `. ${crossWords(plus, minus, '+DI', '-DI')}`;
    return {
      plots: [
        { key: 'adx', label: 'ADX', style: 'line', emphasis: 1, values: adx },
        { key: 'plus', label: '+DI', style: 'line', emphasis: 0.6, values: plus },
        { key: 'minus', label: '-DI', style: 'line', emphasis: 0.4, values: minus },
      ],
      guides: [
        { value: 25, label: '25' },
        { value: 20, label: '20' },
      ],
      range: [0, 100],
      state,
    };
  },
};

const STOCHRSI: IndicatorSpec = {
  type: 'stochrsi',
  pane: 'own',
  summary:
    'Stochastic RSI: where the RSI sits inside its own recent range, smoothed. Moves far sooner than the RSI and spends much longer pinned at the extremes.',
  params: [int('rsiPeriod', 14, 2, 200), int('stochPeriod', 14, 2, 200), int('k', 3, 1, 50), int('d', 3, 1, 50)],
  label: (p) => `STOCHRSI ${p.rsiPeriod}`,
  warmup: (p) => p.rsiPeriod + p.stochPeriod + p.k + p.d,
  compute(candles, p) {
    const rsi = rsiSeries(closes(candles), p.rsiPeriod);
    const raw = nulls(candles.length);
    for (let i = p.stochPeriod - 1; i < rsi.length; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      let complete = true;
      for (let k = 0; k < p.stochPeriod; k++) {
        const v = rsi[i - k];
        if (v === null) {
          complete = false;
          break;
        }
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
      const now = rsi[i];
      if (!complete || now === null) continue;
      // A flat RSI window has no range to place anything inside. Fifty is the honest answer:
      // neither extreme, which is exactly what a flat window means.
      raw[i] = hi === lo ? 50 : ((now - lo) / (hi - lo)) * 100;
    }
    const kLine = smaSparse(raw, p.k);
    const dLine = smaSparse(kLine, p.d);
    const value = lastValue(kLine);
    const state =
      value === null
        ? 'stochastic RSI: not enough history yet'
        : `stoch RSI %K ${value.toFixed(1)}, ${drift(kLine, 3)}, ` +
          (value >= 80 ? 'above the 80 line' : value <= 20 ? 'below the 20 line' : 'between the 20 and 80 lines') +
          `. ${crossWords(kLine, dLine, '%K', '%D')}`;
    return {
      plots: [
        { key: 'k', label: '%K', style: 'line', emphasis: 0.95, values: kLine },
        { key: 'd', label: '%D', style: 'line', emphasis: 0.55, values: dLine },
      ],
      guides: [
        { value: 80, label: '80' },
        { value: 50, label: '50' },
        { value: 20, label: '20' },
      ],
      range: [0, 100],
      state,
    };
  },
};

const MFI: IndicatorSpec = {
  type: 'mfi',
  pane: 'own',
  summary:
    'Money Flow Index: the RSI weighted by volume, so a push on no volume counts for less. Returns nothing on a venue that reports no volume, rather than a flat 50.',
  params: [int('period', 14, 2, 200)],
  label: (p) => `MFI ${p.period}`,
  compute(candles, p) {
    const tp = typical(candles);
    const pos: number[] = [0];
    const neg: number[] = [0];
    for (let i = 1; i < candles.length; i++) {
      const flow = (tp[i] as number) * (candles[i] as Candle).v;
      const up = (tp[i] as number) > (tp[i - 1] as number);
      pos.push(up ? flow : 0);
      neg.push(up ? 0 : flow);
    }
    const out = nulls(candles.length);
    for (let i = p.period; i < candles.length; i++) {
      let up = 0;
      let down = 0;
      for (let k = 0; k < p.period; k++) {
        up += pos[i - k] as number;
        down += neg[i - k] as number;
      }
      // No volume at all is not a reading. Leaving it null says so; a 50 would look like a
      // measurement of a market this venue never reported.
      if (up === 0 && down === 0) continue;
      out[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
    }
    const value = lastValue(out);
    const state =
      value === null
        ? `MFI(${p.period}): no volume in this window, or not enough history`
        : `MFI ${value.toFixed(1)}, ${drift(out, 4)}, ` +
          (value >= 80 ? 'above the 80 line' : value <= 20 ? 'below the 20 line' : 'between the 20 and 80 lines');
    return {
      plots: [{ key: 'mfi', label: `MFI ${p.period}`, style: 'line', emphasis: 0.9, values: out }],
      guides: [
        { value: 80, label: '80' },
        { value: 50, label: '50' },
        { value: 20, label: '20' },
      ],
      range: [0, 100],
      state,
    };
  },
};

const CCI: IndicatorSpec = {
  type: 'cci',
  pane: 'own',
  summary:
    'Commodity channel index: how far the typical price sits from its own average, in mean deviations. Unbounded, so the 100 lines are convention and not a ceiling.',
  params: [int('period', 20, 2, 400)],
  label: (p) => `CCI ${p.period}`,
  compute(candles, p) {
    const tp = typical(candles);
    const mean = sma(tp, p.period);
    const out = nulls(candles.length);
    for (let i = p.period - 1; i < tp.length; i++) {
      const m = mean[i] as number;
      let acc = 0;
      for (let k = 0; k < p.period; k++) acc += Math.abs((tp[i - k] as number) - m);
      const md = acc / p.period;
      out[i] = md === 0 ? 0 : ((tp[i] as number) - m) / (0.015 * md);
    }
    const value = lastValue(out);
    const state =
      value === null
        ? `CCI(${p.period}): not enough history yet`
        : `CCI ${value.toFixed(1)}, ${drift(out, 4)}, ` +
          (value >= 100 ? 'above the 100 line' : value <= -100 ? 'below the -100 line' : 'between the 100 lines');
    return {
      plots: [{ key: 'cci', label: `CCI ${p.period}`, style: 'line', emphasis: 0.9, values: out }],
      guides: [
        { value: 100, label: '100' },
        { value: 0, label: '0' },
        { value: -100, label: '-100' },
      ],
      range: null,
      state,
    };
  },
};

// Volume with its own average over it, which is the whole of "is this bar's volume unusual".
// Kept here rather than folded into the plain volume pane so the existing one stays what it is.
const RELVOL: IndicatorSpec = {
  type: 'relvolume',
  pane: 'own',
  summary:
    'Volume against its own moving average, as a multiple. 1 is an ordinary bar for this market; 3 is three times the recent average.',
  params: [int('period', 20, 2, 400)],
  label: (p) => `RVOL ${p.period}`,
  compute(candles, p) {
    const vols = candles.map((c) => c.v);
    const avg = sma(vols, p.period);
    const out = nulls(candles.length);
    const signs: number[] = candles.map((c) => (c.c >= c.o ? 1 : -1));
    for (let i = 0; i < candles.length; i++) {
      const a = avg[i];
      if (a === null || a === 0) continue;
      out[i] = (vols[i] as number) / a;
    }
    const value = lastValue(out);
    const state =
      value === null
        ? 'relative volume: no volume in this window, or not enough history'
        : `relative volume ${value.toFixed(2)}x the ${p.period} bar average, ${drift(out, 3)}`;
    return {
      plots: [
        { key: 'rvol', label: 'relative volume', style: 'histogram', emphasis: 0.8, signs, values: out },
      ],
      guides: [
        { value: 1, label: '1x' },
        { value: 2, label: '2x' },
      ],
      range: null,
      state,
    };
  },
};

export const LIBRARY_SPECS: IndicatorSpec[] = [
  WAVE,
  MONEYFLOW,
  SUPERTREND,
  HMA,
  RIBBON,
  ICHIMOKU,
  KELTNER,
  SQUEEZE,
  VWAPBANDS,
  ADX,
  STOCHRSI,
  MFI,
  CCI,
  RELVOL,
];

// Exported for the study packages in src/presets.ts, which name indicators by type and would
// otherwise be able to name one that does not exist.
export const LIBRARY_TYPES: readonly string[] = LIBRARY_SPECS.map((s) => s.type);
