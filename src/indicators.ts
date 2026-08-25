// Indicator maths. Pure functions over a candle series, no state and no I/O.
//
// This file runs on the server and only on the server. The agent reads these numbers
// through chart_read and the browser draws these same arrays, so a second implementation
// in the client would let the number and the pixel disagree. On a surface a human uses to
// decide whether to approve a transfer, that is a defect.
//
// Every series is index-aligned with the candle array it was built from: values[i] belongs
// to candles[i], and a leading null means "not enough history yet", never zero. Zero is a
// real value for MACD and OBV, so the two must not be confused.

import type { Candle } from './types.ts';
import {
  nulls,
  lastValue,
  drift,
  sma,
  ema,
  wma,
  wilder,
  closes,
  typical,
  trueRange,
  rsiSeries,
  num,
  pct,
  versusPrice,
} from './indicators-kit.ts';
import { LIBRARY_SPECS } from './indicators-library.ts';

export type PlotStyle = 'line' | 'histogram' | 'band';

export type Plot = {
  key: string;
  label: string;
  style: PlotStyle;
  // 0..1. The palette is one hue, so brightness is the only way plots separate.
  emphasis: number;
  // Histogram only: the value is signed, so it is drawn from the zero line and coloured by
  // its own sign. MACD's histogram is the case this exists for.
  signed?: boolean;
  // Histogram only: the value is a magnitude and this carries the direction. Volume is
  // always positive and only its colour is directional, so folding the direction into the
  // value would put half the bars below an axis they have no business crossing.
  signs?: number[];
  // Band only: the key of the plot this one fills down to.
  fillTo?: string;
  values: (number | null)[];
};

export type Guide = { value: number; label: string };

export type IndicatorResult = {
  plots: Plot[];
  guides: Guide[];
  // A pane with a fixed domain (RSI, Stochastic) says so; null means fit to the data.
  range: [number, number] | null;
  // One line of plain English for the agent. Never a number on its own: a number without
  // its relation to price is something the agent has to guess at.
  state: string;
};

export type ParamSpec = { name: string; def: number; min: number; max: number; int: boolean };

export type IndicatorSpec = {
  type: string;
  // 'price' overlays the candles, 'own' takes a pane under them.
  pane: 'price' | 'own';
  summary: string;
  params: ParamSpec[];
  label(params: Record<string, number>): string;
  // How many bars this indicator needs before it draws anything, when the answer is not simply
  // its longest integer parameter. A wave oscillator stacks three averages, so it needs their
  // sum; without this it would claim to be ready a hundred bars before it is, and the agent
  // would read a warmup artefact as a reading. Optional: most indicators do not need it.
  warmup?(params: Record<string, number>): number;
  compute(candles: Candle[], params: Record<string, number>): IndicatorResult;
};

// ---------- series helpers ----------
//
// They moved to src/indicators-kit.ts when a second catalogue started needing them. They are
// re-exported here rather than merely imported, because callers outside this file (the
// analysis layer, the chart) have always taken them from this module and a moved function is
// not a reason to rewrite their imports.

export { sma, ema, wma, trueRange };

// ---------- the catalogue ----------

const PERIOD = (def: number, min: number, max: number): ParamSpec => ({ name: 'period', def, min, max, int: true });

function movingAverage(
  type: string,
  summary: string,
  fn: (source: number[], period: number) => (number | null)[],
  def: number,
): IndicatorSpec {
  return {
    type,
    pane: 'price',
    summary,
    params: [PERIOD(def, 2, 400)],
    label: (p) => `${type.toUpperCase()} ${p.period}`,
    compute(candles, p) {
      const line = fn(closes(candles), p.period);
      return {
        plots: [{ key: type, label: `${type.toUpperCase()} ${p.period}`, style: 'line', emphasis: 0.9, values: line }],
        guides: [],
        range: null,
        state: versusPrice(candles, line, `${type.toUpperCase()}(${p.period})`),
      };
    },
  };
}

const SPECS: IndicatorSpec[] = [
  movingAverage('sma', 'Simple moving average of the close.', sma, 20),
  movingAverage('ema', 'Exponentially weighted moving average of the close.', ema, 21),
  movingAverage('wma', 'Linearly weighted moving average of the close.', wma, 20),

  {
    type: 'vwap',
    pane: 'price',
    summary: 'Volume weighted average price, re-anchored at each UTC day boundary.',
    params: [],
    label: () => 'VWAP',
    compute(candles) {
      const out = nulls(candles.length);
      const tp = typical(candles);
      let day = -1;
      let pv = 0;
      let vol = 0;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i] as Candle;
        const thisDay = Math.floor(c.t / 86400);
        if (thisDay !== day) {
          day = thisDay;
          pv = 0;
          vol = 0;
        }
        pv += (tp[i] as number) * c.v;
        vol += c.v;
        out[i] = vol > 0 ? pv / vol : null;
      }
      return {
        plots: [{ key: 'vwap', label: 'VWAP', style: 'line', emphasis: 0.85, values: out }],
        guides: [],
        range: null,
        state: versusPrice(candles, out, 'VWAP'),
      };
    },
  },

  {
    type: 'bbands',
    pane: 'price',
    summary: 'Bollinger bands: a moving average with a standard deviation envelope.',
    params: [PERIOD(20, 2, 400), { name: 'mult', def: 2, min: 0.1, max: 6, int: false }],
    label: (p) => `BB ${p.period}/${p.mult}`,
    compute(candles, p) {
      const source = closes(candles);
      const mid = sma(source, p.period);
      const upper = nulls(candles.length);
      const lower = nulls(candles.length);
      for (let i = p.period - 1; i < source.length; i++) {
        const mean = mid[i] as number;
        let acc = 0;
        for (let k = 0; k < p.period; k++) {
          const d = (source[i - k] as number) - mean;
          acc += d * d;
        }
        // Population deviation over the window, which is what the original indicator uses.
        const sd = Math.sqrt(acc / p.period);
        upper[i] = mean + sd * p.mult;
        lower[i] = mean - sd * p.mult;
      }
      const up = lastValue(upper);
      const lo = lastValue(lower);
      const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : null;
      let state = 'Bollinger: not enough history yet';
      if (up !== null && lo !== null && last !== null) {
        const width = up - lo;
        const place = width > 0 ? ((last - lo) / width) * 100 : 50;
        const mean = lastValue(mid);
        const widthPct = mean !== null && mean !== 0 ? (width / mean) * 100 : 0;
        state =
          `Bollinger(${p.period}, ${p.mult}) band ${num(lo)} to ${num(up)}, ` +
          `price at ${place.toFixed(0)}% of the band, width ${widthPct.toFixed(2)}% of price`;
      }
      return {
        plots: [
          { key: 'upper', label: 'upper', style: 'band', emphasis: 0.5, fillTo: 'lower', values: upper },
          { key: 'mid', label: 'basis', style: 'line', emphasis: 0.7, values: mid },
          { key: 'lower', label: 'lower', style: 'line', emphasis: 0.5, values: lower },
        ],
        guides: [],
        range: null,
        state,
      };
    },
  },

  {
    type: 'donchian',
    pane: 'price',
    summary: 'Donchian channel: the highest high and lowest low over the window.',
    params: [PERIOD(20, 2, 400)],
    label: (p) => `DC ${p.period}`,
    compute(candles, p) {
      const upper = nulls(candles.length);
      const lower = nulls(candles.length);
      const mid = nulls(candles.length);
      for (let i = p.period - 1; i < candles.length; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let k = 0; k < p.period; k++) {
          const c = candles[i - k] as Candle;
          if (c.h > hi) hi = c.h;
          if (c.l < lo) lo = c.l;
        }
        upper[i] = hi;
        lower[i] = lo;
        mid[i] = (hi + lo) / 2;
      }
      const up = lastValue(upper);
      const lo = lastValue(lower);
      const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : null;
      const state =
        up === null || lo === null || last === null
          ? 'Donchian: not enough history yet'
          : `Donchian(${p.period}) ${num(lo)} to ${num(up)}, ` +
            (last >= up ? 'price at a new high' : last <= lo ? 'price at a new low' : 'price inside the channel');
      return {
        plots: [
          { key: 'upper', label: 'upper', style: 'band', emphasis: 0.5, fillTo: 'lower', values: upper },
          { key: 'mid', label: 'mid', style: 'line', emphasis: 0.45, values: mid },
          { key: 'lower', label: 'lower', style: 'line', emphasis: 0.5, values: lower },
        ],
        guides: [],
        range: null,
        state,
      };
    },
  },

  {
    type: 'volume',
    pane: 'own',
    summary: 'Traded volume per bar, coloured by the direction of the bar.',
    params: [{ name: 'average', def: 20, min: 0, max: 400, int: true }],
    label: () => 'VOLUME',
    compute(candles, p) {
      const values = candles.map((c) => c.v);
      const signs = candles.map((c) => (c.c >= c.o ? 1 : -1));
      const plots: Plot[] = [
        { key: 'volume', label: 'volume', style: 'histogram', emphasis: 0.55, signs, values },
      ];
      if (p.average > 0) {
        plots.push({ key: 'avg', label: `avg ${p.average}`, style: 'line', emphasis: 0.8, values: sma(values, p.average) });
      }
      const last = values.length > 0 ? (values[values.length - 1] as number) : 0;
      const avg = p.average > 0 ? lastValue(sma(values, p.average)) : null;
      const state =
        avg === null || avg === 0
          ? `volume ${num(last)} on the last bar`
          : `volume ${num(last)} on the last bar, ${(last / avg).toFixed(2)}x its ${p.average} bar average`;
      return { plots, guides: [], range: null, state };
    },
  },

  {
    type: 'rsi',
    pane: 'own',
    summary: 'Relative strength index, Wilder smoothing. Bounded 0 to 100.',
    params: [PERIOD(14, 2, 400)],
    label: (p) => `RSI ${p.period}`,
    compute(candles, p) {
      // One RSI in this app, in src/indicators-kit.ts, because the stochastic RSI and the
      // wave family read the same array and two copies would drift apart in silence.
      const out = rsiSeries(closes(candles), p.period);
      const value = lastValue(out);
      const state =
        value === null
          ? `RSI(${p.period}): not enough history yet`
          : `RSI(${p.period}) ${value.toFixed(1)}, ${drift(out, 4)}, ` +
            (value >= 70 ? 'above the 70 line' : value <= 30 ? 'below the 30 line' : 'between the 30 and 70 lines');
      return {
        plots: [{ key: 'rsi', label: `RSI ${p.period}`, style: 'line', emphasis: 0.9, values: out }],
        guides: [
          { value: 70, label: '70' },
          { value: 50, label: '50' },
          { value: 30, label: '30' },
        ],
        range: [0, 100],
        state,
      };
    },
  },

  {
    type: 'macd',
    pane: 'own',
    summary: 'Moving average convergence divergence, with its signal line and histogram.',
    params: [
      { name: 'fast', def: 12, min: 1, max: 200, int: true },
      { name: 'slow', def: 26, min: 2, max: 400, int: true },
      { name: 'signal', def: 9, min: 1, max: 200, int: true },
    ],
    label: (p) => `MACD ${p.fast}/${p.slow}/${p.signal}`,
    compute(candles, p) {
      const source = closes(candles);
      const fast = ema(source, p.fast);
      const slow = ema(source, p.slow);
      const macd = nulls(source.length);
      const dense: number[] = [];
      let firstDense = -1;
      for (let i = 0; i < source.length; i++) {
        const f = fast[i];
        const s = slow[i];
        if (f === null || s === null) continue;
        macd[i] = f - s;
        if (firstDense < 0) firstDense = i;
        dense.push(f - s);
      }
      const signalDense = ema(dense, p.signal);
      const signal = nulls(source.length);
      const hist = nulls(source.length);
      for (let k = 0; k < signalDense.length; k++) {
        const v = signalDense[k];
        if (v === null) continue;
        const i = firstDense + k;
        signal[i] = v;
        hist[i] = (macd[i] as number) - v;
      }
      const m = lastValue(macd);
      const s = lastValue(signal);
      const h = lastValue(hist);
      const state =
        m === null || s === null || h === null
          ? 'MACD: not enough history yet'
          : `MACD ${num(m)} against signal ${num(s)}, histogram ${num(h)} and ${drift(hist, 3)}, ` +
            (m >= s ? 'macd above signal' : 'macd below signal');
      return {
        plots: [
          { key: 'hist', label: 'histogram', style: 'histogram', emphasis: 0.5, signed: true, values: hist },
          { key: 'macd', label: 'macd', style: 'line', emphasis: 0.95, values: macd },
          { key: 'signal', label: 'signal', style: 'line', emphasis: 0.6, values: signal },
        ],
        guides: [{ value: 0, label: '0' }],
        range: null,
        state,
      };
    },
  },

  {
    type: 'atr',
    pane: 'own',
    summary: 'Average true range: how far this market moves per bar, in price.',
    params: [PERIOD(14, 2, 400)],
    label: (p) => `ATR ${p.period}`,
    compute(candles, p) {
      const tr = trueRange(candles);
      const out = wilder(tr, p.period);
      const value = lastValue(out);
      const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : null;
      const state =
        value === null || last === null || last === 0
          ? `ATR(${p.period}): not enough history yet`
          : `ATR(${p.period}) ${num(value)}, which is ${((value / last) * 100).toFixed(2)}% of price, ${drift(out, 5)}`;
      return {
        plots: [{ key: 'atr', label: `ATR ${p.period}`, style: 'line', emphasis: 0.9, values: out }],
        guides: [],
        range: null,
        state,
      };
    },
  },

  {
    type: 'stoch',
    pane: 'own',
    summary: 'Stochastic oscillator: where the close sits inside the recent range.',
    params: [
      { name: 'k', def: 14, min: 1, max: 400, int: true },
      { name: 'smooth', def: 3, min: 1, max: 100, int: true },
      { name: 'd', def: 3, min: 1, max: 100, int: true },
    ],
    label: (p) => `STOCH ${p.k}/${p.smooth}/${p.d}`,
    compute(candles, p) {
      const raw = nulls(candles.length);
      for (let i = p.k - 1; i < candles.length; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let n = 0; n < p.k; n++) {
          const c = candles[i - n] as Candle;
          if (c.h > hi) hi = c.h;
          if (c.l < lo) lo = c.l;
        }
        const c = candles[i] as Candle;
        raw[i] = hi > lo ? ((c.c - lo) / (hi - lo)) * 100 : 50;
      }
      const kLine = smoothNullable(raw, p.smooth);
      const dLine = smoothNullable(kLine, p.d);
      const value = lastValue(kLine);
      const state =
        value === null
          ? 'Stochastic: not enough history yet'
          : `Stochastic %K ${value.toFixed(1)}, ${drift(kLine, 4)}, ` +
            (value >= 80 ? 'above the 80 line' : value <= 20 ? 'below the 20 line' : 'between the 20 and 80 lines');
      return {
        plots: [
          { key: 'k', label: '%K', style: 'line', emphasis: 0.95, values: kLine },
          { key: 'd', label: '%D', style: 'line', emphasis: 0.6, values: dLine },
        ],
        guides: [
          { value: 80, label: '80' },
          { value: 20, label: '20' },
        ],
        range: [0, 100],
        state,
      };
    },
  },

  {
    type: 'obv',
    pane: 'own',
    summary: 'On balance volume: volume added on up bars and taken off on down bars.',
    params: [],
    label: () => 'OBV',
    compute(candles) {
      const out = nulls(candles.length);
      let acc = 0;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i] as Candle;
        if (i > 0) {
          const prev = candles[i - 1] as Candle;
          if (c.c > prev.c) acc += c.v;
          else if (c.c < prev.c) acc -= c.v;
        }
        out[i] = acc;
      }
      const value = lastValue(out);
      return {
        plots: [{ key: 'obv', label: 'OBV', style: 'line', emphasis: 0.9, values: out }],
        guides: [{ value: 0, label: '0' }],
        range: null,
        state: value === null ? 'OBV: no data' : `OBV ${num(value)}, ${drift(out, 6)} over the last bars`,
      };
    },
  },
];

// SMA over a series that already has leading nulls, which is what the stochastic needs.
function smoothNullable(values: (number | null)[], period: number): (number | null)[] {
  const out = nulls(values.length);
  if (period <= 1) return values.slice();
  let sum = 0;
  let have = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) {
      sum = 0;
      have = 0;
      continue;
    }
    sum += v;
    have++;
    if (have > period) {
      const drop = values[i - period];
      sum -= drop === null ? 0 : drop;
      have = period;
    }
    if (have === period) out[i] = sum / period;
  }
  return out;
}

// The catalogue the rest of the app sees: the classics above, then the library beside them.
//
// One list rather than two surfaces. An agent asking indicator_catalog what it can draw should
// not have to learn that a wave oscillator lives behind a different door from an EMA, and the
// chart, the warmup calculation and the divergence op all resolve a type through this one map.
// src/indicators-library.ts owns the second half only because one file holding thirty
// indicators is a file nobody can read.
const ALL_SPECS: IndicatorSpec[] = [...SPECS, ...LIBRARY_SPECS];

const BY_TYPE = new Map<string, IndicatorSpec>(ALL_SPECS.map((s) => [s.type, s]));

export function indicatorSpec(type: string): IndicatorSpec | undefined {
  return BY_TYPE.get(type.toLowerCase().trim());
}

export function indicatorCatalog(): unknown[] {
  return ALL_SPECS.map((s) => ({
    type: s.type,
    pane: s.pane === 'price' ? 'overlays the price' : 'takes its own pane',
    summary: s.summary,
    params: s.params.map((p) => ({ name: p.name, default: p.def, min: p.min, max: p.max, integer: p.int })),
  }));
}

// Clamp rather than reject: an agent asking for a 900 period EMA on a 200 bar window gets
// the longest one that fits, with the clamp reported, instead of an error it has to parse.
export function normaliseParams(
  spec: IndicatorSpec,
  given: Record<string, unknown>,
): { params: Record<string, number>; notes: string[] } {
  const params: Record<string, number> = {};
  const notes: string[] = [];
  for (const p of spec.params) {
    const raw = given[p.name];
    let value = typeof raw === 'number' && Number.isFinite(raw) ? raw : p.def;
    if (p.int) value = Math.round(value);
    const clamped = Math.min(p.max, Math.max(p.min, value));
    if (clamped !== value) notes.push(`${p.name} clamped to ${clamped} (allowed ${p.min} to ${p.max})`);
    params[p.name] = clamped;
  }
  return { params, notes };
}

// How many bars this indicator needs before it produces anything. The agent is told when
// the window it asked for is too short to draw the thing it just added.
export function warmupBars(spec: IndicatorSpec, params: Record<string, number>): number {
  if (spec.warmup !== undefined) return Math.max(1, Math.round(spec.warmup(params)));
  let longest = 1;
  for (const p of spec.params) {
    if (!p.int) continue;
    const value = params[p.name] ?? p.def;
    if (value > longest) longest = value;
  }
  if (spec.type === 'macd') return (params.slow ?? 26) + (params.signal ?? 9);
  if (spec.type === 'stoch') return (params.k ?? 14) + (params.smooth ?? 3) + (params.d ?? 3);
  return longest;
}

export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

export { lastValue, num as formatLoose, pct as formatPct };
