// The chart's view state and its read model.
//
// This state is on the SERVER, not in the browser, and that is the load-bearing decision of
// the whole feature. An agent has to be able to read what the chart shows and drive it while
// the window may not even be open, so a browser-owned view could not answer a read. The
// browser is a renderer: it draws this state and writes its own pan and zoom back.
//
// Nothing here touches money. Chart writes never reach the proposal path and never need an
// approval, but they are audit-logged like every other op, because an agent that can change
// what the human sees while that human is approving a transfer is a security surface. That
// is also why everything an agent draws carries an [agent] tag it cannot remove.

import type { Candle } from './types.ts';
import { indicatorSpec, normaliseParams, warmupBars, pctChange, trueRange } from './indicators.ts';
import type { IndicatorResult } from './indicators.ts';
import { MAX_TIMEFRAME_SEC, MIN_TIMEFRAME_SEC, parseTimeframe, formatTimeframe } from './market/aggregate.ts';

export type PriceScale = { mode: 'auto' } | { mode: 'manual'; low: number; high: number };

export type ChartView = {
  product: string;
  granularitySec: number;
  // Bars across the plot. Fractional so a squeeze tracks the pointer instead of notching.
  barCount: number;
  // Bars back from the newest. Negative pushes the newest bar left of the axis, which is
  // what a trading chart does when you drag past the end.
  panOffset: number;
  priceScale: PriceScale;
};

export type Source = 'human' | 'agent';

export type ChartIndicator = {
  id: string;
  type: string;
  params: Record<string, number>;
  label: string;
  pane: 'price' | 'own';
  source: Source;
};

export type ChartLevel = { id: string; price: number; label: string; source: Source };
export type ChartMark = { id: string; t: number; label: string; source: Source };

// A sloped line between two points in time. The third drawing primitive, and the one that
// took an actual request to notice was missing: a level is a horizontal line and a mark is a
// vertical one, so between them they could describe a support price or a moment but never a
// trend, which is the commonest thing anyone draws on a chart. Anchored to (time, price)
// pairs rather than to bar indices, so panning and changing timeframe move it with the data
// instead of leaving it stuck to the screen.
export type ChartTrendline = {
  id: string;
  t1: number;
  p1: number;
  t2: number;
  p2: number;
  label: string;
  source: Source;
};

// What the browser reports back about its own size, so the agent can tell whether what it
// asked for is actually readable rather than assuming it is.
export type ChartGeometry = {
  width: number;
  height: number;
  plotWidth: number;
  priceHeight: number;
  pxPerBar: number;
  panes: { id: string; label: string; height: number }[];
  dropped: string[];
  reportedAt: string;
};

export type ChartState = {
  view: ChartView;
  indicators: ChartIndicator[];
  levels: ChartLevel[];
  marks: ChartMark[];
  trendlines: ChartTrendline[];
  geometry: ChartGeometry | null;
  rev: number;
  lastDriver: Source;
  lastChangeAt: string;
};

export type Outcome = { ok: boolean; notes: string[]; error?: string; id?: string; label?: string };

// The timeframe vocabulary lives in the market layer, because that is what has to serve it.
export { MAX_TIMEFRAME_SEC, MIN_TIMEFRAME_SEC, parseTimeframe, formatTimeframe };

export const TIMEFRAMES: readonly { label: string; sec: number }[] = [
  { label: '1m', sec: 60 },
  { label: '5m', sec: 300 },
  { label: '15m', sec: 900 },
  { label: '30m', sec: 1800 },
  { label: '1h', sec: 3600 },
  { label: '4h', sec: 14400 },
  { label: '8h', sec: 28800 },
  { label: '1d', sec: 86400 },
];

// The window is allowed to squeeze until the renderer stops being able to say anything, not
// until a round number runs out. Two thousand one-minute bars is a day and a half on screen;
// past that the bars are thinner than the hairline that separates them. What the window can
// actually be filled with is a separate question, and the sources answer it: the chart draws
// the history it was given and leaves the rest of the window empty rather than pretending.
export const LIMITS = {
  barCountMin: 10,
  barCountMax: 2000,
  barCountDefault: 120,
  panMax: 400,
  historyMax: 2000,
  // The floor exists because asking only for what is on screen is what made history look
  // broken. The default window is 120 bars, so the old request was about 150, and a pan to
  // the left ran off the end of the data within one gesture. The rails serve two thousand
  // bars in one call, the cache keeps them, and the fill happens behind the render, so
  // depth now costs a background request rather than a wait.
  historyFloor: 1500,
  fetchMargin: 30,
  maxOverlays: 8,
  maxPanes: 3,
  maxLevels: 24,
  maxMarks: 24,
  maxTrendlines: 12,
};

export function timeframeLabel(sec: number): string {
  for (const tf of TIMEFRAMES) if (tf.sec === sec) return tf.label;
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/* One entry of a chart_scan timeframe list, resolved to seconds, or null if it is not a
   timeframe at all.
 *
 * The button-bar list stops at 1d, so matching against TIMEFRAMES alone cannot see `1w`. The
 * scan handler used to fall back to snapTimeframe(Number(entry)) for a miss, and Number('1w')
 * is NaN: every comparison inside the snap is then false, so it returned the first entry in the
 * list and a weekly scan silently answered with a MINUTE chart under whatever label was asked
 * for. Nothing downstream could tell that the higher timeframe had never been read.
 *
 * Null rather than a nearest guess, because the caller needs to be able to say "that is not a
 * timeframe" out loud. Snapping is right for a number that is merely unservable (47 seconds);
 * it is wrong for a string that was never understood. */
export function resolveScanTimeframe(entry: string | number): number | null {
  const found = TIMEFRAMES.find((tf) => tf.label === String(entry));
  if (found !== undefined) return found.sec;
  return parseTimeframe(entry);
}

// Snap to a timeframe the data rails can actually serve. An agent that asks for 47 seconds
// gets the nearest real one and is told, rather than a chart of nothing.
export function snapTimeframe(sec: number): number {
  let best = TIMEFRAMES[0] as { label: string; sec: number };
  let bestGap = Infinity;
  for (const tf of TIMEFRAMES) {
    const gap = Math.abs(Math.log(tf.sec) - Math.log(Math.max(1, sec)));
    if (gap < bestGap) {
      bestGap = gap;
      best = tf;
    }
  }
  return best.sec;
}

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// Enough decimals that two neighbouring grid lines never print the same number, capped so a
// stablecoin pair does not show eight zeros. One precision is used everywhere on the chart:
// labels that change digit count between frames read as a bug.
export function priceDecimals(span: number, reference: number): number {
  const step = span > 0 ? span / 6 : Math.abs(reference) / 1000;
  if (!(step > 0)) return 2;
  return clamp(Math.ceil(-Math.log10(step)) + 1, 0, 8);
}

// How many decimals the venue itself quotes in. A span-derived precision alone rounds
// 63,434.5 to 63,434 on a wide window, which is the last price reading a digit short.
function tickDecimals(candles: Candle[]): number {
  let most = 0;
  for (let i = Math.max(0, candles.length - 20); i < candles.length; i++) {
    const text = String((candles[i] as Candle).c);
    const dot = text.indexOf('.');
    // A float that printed in exponent form, or with a long tail, is arithmetic noise
    // rather than the venue's tick, so it does not get a vote.
    if (dot < 0 || text.includes('e')) continue;
    const places = text.length - dot - 1;
    if (places <= 6 && places > most) most = places;
  }
  return most;
}

export function displayDecimals(span: number, candles: Candle[]): number {
  const reference = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : 1;
  return clamp(Math.max(priceDecimals(span, reference), tickDecimals(candles)), 0, 8);
}

export function createChartStore(initialProduct: string): {
  state(): ChartState;
  rev(): number;
  historyNeeded(): number;
  setView(patch: Record<string, unknown>, source: Source): Outcome;
  addIndicator(args: Record<string, unknown>, source: Source): Outcome;
  removeIndicator(ref: string): Outcome;
  setLevel(args: Record<string, unknown>, source: Source): Outcome;
  setMark(args: Record<string, unknown>, source: Source): Outcome;
  setTrendline(args: Record<string, unknown>, source: Source): Outcome;
  clear(what: string): Outcome;
  setGeometry(geometry: ChartGeometry): void;
  agentObjects(): number;
} {
  let seq = 0;
  const state: ChartState = {
    view: {
      product: initialProduct,
      granularitySec: 60,
      barCount: LIMITS.barCountDefault,
      panOffset: 0,
      priceScale: { mode: 'auto' },
    },
    indicators: [],
    levels: [],
    marks: [],
    trendlines: [],
    geometry: null,
    rev: 1,
    lastDriver: 'human',
    lastChangeAt: new Date().toISOString(),
  };

  function bump(source: Source): void {
    state.rev++;
    state.lastDriver = source;
    state.lastChangeAt = new Date().toISOString();
  }

  function nextId(prefix: string): string {
    seq++;
    return `${prefix}-${seq}`;
  }

  function tag(label: string, source: Source): string {
    const trimmed = label.trim().slice(0, 48);
    if (source !== 'agent') return trimmed;
    // Attribution the agent cannot write its way out of: the tag is added here, after the
    // label it supplied, and the UI reads it from this string.
    return `[agent] ${trimmed}`;
  }

  function setView(patch: Record<string, unknown>, source: Source): Outcome {
    const notes: string[] = [];
    const view = state.view;

    // Set when THIS patch changes the instrument. The pan and the price scale carried in the
    // same patch describe the instrument being left, so they are dropped below rather than
    // applied on top of the reset this branch just did.
    let switchedProduct = false;

    if (typeof patch.product === 'string' && patch.product.trim().length > 0) {
      const next = patch.product.trim().toUpperCase();
      if (next !== view.product) {
        view.product = next;
        // A different instrument is a different price range: nothing about the old window
        // carries over except how many bars are on screen.
        view.panOffset = 0;
        view.priceScale = { mode: 'auto' };
        switchedProduct = true;
      }
    }

    // Any timeframe from a second to a week, not just the twelve on the button bar.
    // The twelve are what a hand can click; an agent asked for 7m or 90s and used to be
    // refused or silently snapped to something it did not ask for. The market layer folds
    // a base interval the venue does serve into whatever was requested, so the enum is a
    // convenience now and not a constraint. See src/market/aggregate.ts.
    if (typeof patch.granularitySec === 'number' && Number.isFinite(patch.granularitySec)) {
      const asked = Math.floor(patch.granularitySec);
      if (asked < MIN_TIMEFRAME_SEC || asked > MAX_TIMEFRAME_SEC) {
        return { ok: false, notes, error: `timeframe out of range: ${asked}s. between 1m and 1w` };
      }
      if (asked !== view.granularitySec) {
        view.granularitySec = asked;
        view.panOffset = 0;
      }
    } else if (typeof patch.timeframe === 'string') {
      const parsed = parseTimeframe(patch.timeframe);
      if (parsed === null) {
        return {
          ok: false,
          notes,
          error: `unknown timeframe: ${patch.timeframe}. use a count and a unit, like 7m, 4h or 1w`,
        };
      }
      if (parsed < MIN_TIMEFRAME_SEC) {
        return {
          ok: false,
          notes,
          error: `${patch.timeframe} is below the one minute floor. no venue serves a candle under a minute`,
        };
      }
      if (parsed !== view.granularitySec) {
        view.granularitySec = parsed;
        view.panOffset = 0;
      }
    }

    if (typeof patch.barCount === 'number' && Number.isFinite(patch.barCount)) {
      const clamped = clamp(patch.barCount, LIMITS.barCountMin, LIMITS.barCountMax);
      if (clamped !== patch.barCount) notes.push(`barCount clamped to ${clamped}`);
      view.barCount = clamped;
    }

    // The two fields below used to undo the product reset above, in the same call, because the
    // browser pushes the WHOLE view on any change (ui/chart.js pushChart) and not a minimal
    // patch. Switching BTC to SOL therefore arrived as {product:'SOL-USD', panOffset:300,
    // priceLow:63000, priceHigh:64000}: the reset ran, then line-for-line the old instrument's
    // window was written back over it. Two visible failures came out of that, and they are the
    // two complaints about this chart.
    //
    //   Manual scale carried across. SOL trades near 150 and the axis still spanned 63k, so
    //   every candle drew off the pane. This is "off-scale".
    //
    //   Stale pan carried across, which happens even in auto mode. Panned 300 bars back on
    //   BTC and switched to a shorter SOL series, the right edge goes negative, start passes
    //   end, no candle is scanned, and the domain falls through to the degenerate 0..1
    //   fallback in buildLayout. This is "compressed".
    //
    // A patch that changes the instrument cannot also be describing that instrument's window,
    // because the caller wrote it while looking at a different one. Dropped, with a note, so
    // an agent that meant it can see why it did not take and ask again in a second call.
    if (typeof patch.panOffset === 'number' && Number.isFinite(patch.panOffset)) {
      if (switchedProduct) notes.push('panOffset ignored: it described the previous instrument');
      else view.panOffset = clampPan(patch.panOffset, view.barCount);
    }
    if (patch.live === true) view.panOffset = 0;

    if (patch.priceScale === 'auto' || patch.priceAuto === true) {
      view.priceScale = { mode: 'auto' };
    } else if (typeof patch.priceLow === 'number' && typeof patch.priceHigh === 'number') {
      const low = Math.min(patch.priceLow, patch.priceHigh);
      const high = Math.max(patch.priceLow, patch.priceHigh);
      if (!(high > low)) return { ok: false, notes, error: 'priceHigh must be above priceLow' };
      if (switchedProduct) notes.push('price scale ignored: it described the previous instrument');
      else view.priceScale = { mode: 'manual', low, high };
    }

    bump(source);
    return { ok: true, notes };
  }

  function addIndicator(args: Record<string, unknown>, source: Source): Outcome {
    const type = String(args.type ?? '').toLowerCase().trim();
    const spec = indicatorSpec(type);
    if (spec === undefined) {
      return { ok: false, notes: [], error: `unknown indicator: ${type || '(none given)'}. Call indicator_catalog for the list.` };
    }
    const given = args.params !== null && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : args;
    const { params, notes } = normaliseParams(spec, given);
    const label = spec.label(params);

    const already = state.indicators.find((ind) => ind.type === type && sameParams(ind.params, params));
    if (already !== undefined) {
      return { ok: true, notes: [`${label} is already on the chart`], id: already.id, label: already.label };
    }

    if (spec.pane === 'own') {
      const panes = state.indicators.filter((ind) => ind.pane === 'own');
      if (panes.length >= LIMITS.maxPanes) {
        // Refuse rather than squash. Four panes in this box would leave the price a strip,
        // and a chart that cannot be read is worse than one that says no.
        return {
          ok: false,
          notes,
          error:
            `the chart already has ${panes.length} sub-panes (${panes.map((p) => p.label).join(', ')}) and ` +
            `${LIMITS.maxPanes} is the maximum that leaves the price pane readable. ` +
            `Remove one with chart_remove_indicator first.`,
        };
      }
    } else {
      const overlays = state.indicators.filter((ind) => ind.pane === 'price');
      if (overlays.length >= LIMITS.maxOverlays) {
        return {
          ok: false,
          notes,
          error: `the price pane already carries ${overlays.length} overlays, which is the maximum. Remove one first.`,
        };
      }
    }

    const id = nextId(type);
    state.indicators.push({ id, type, params, label: tag(label, source), pane: spec.pane, source });
    bump(source);
    const warmup = warmupBars(spec, params);
    if (warmup > state.view.barCount) {
      notes.push(`${label} needs ${warmup} bars of history and the window shows ${Math.round(state.view.barCount)}; the extra history is fetched behind the left edge`);
    }
    return { ok: true, notes, id, label };
  }

  function removeIndicator(ref: string): Outcome {
    const key = String(ref ?? '').toLowerCase().trim();
    const before = state.indicators.length;
    const kept = state.indicators.filter((ind) => ind.id !== key && ind.type !== key && ind.label.toLowerCase() !== key);
    if (kept.length === before) {
      return { ok: false, notes: [], error: `no indicator matching ${ref}. On the chart: ${state.indicators.map((i) => `${i.id} (${i.label})`).join(', ') || 'none'}` };
    }
    state.indicators = kept;
    bump('agent');
    return { ok: true, notes: [`removed ${before - kept.length}`] };
  }

  function setLevel(args: Record<string, unknown>, source: Source): Outcome {
    const price = Number(args.price);
    if (!Number.isFinite(price)) return { ok: false, notes: [], error: 'price must be a finite number' };
    if (state.levels.length >= LIMITS.maxLevels) {
      return { ok: false, notes: [], error: `${LIMITS.maxLevels} price levels is the maximum. Clear some with chart_clear.` };
    }
    const id = nextId('level');
    state.levels.push({ id, price, label: tag(String(args.label ?? '') || `level ${price}`, source), source });
    bump(source);
    return { ok: true, notes: [], id };
  }

  function setMark(args: Record<string, unknown>, source: Source): Outcome {
    const t = Number(args.t ?? args.time);
    if (!Number.isFinite(t)) return { ok: false, notes: [], error: 't must be a unix timestamp in seconds' };
    if (state.marks.length >= LIMITS.maxMarks) {
      return { ok: false, notes: [], error: `${LIMITS.maxMarks} marks is the maximum. Clear some with chart_clear.` };
    }
    const id = nextId('mark');
    state.marks.push({ id, t: Math.round(t), label: tag(String(args.label ?? '') || 'mark', source), source });
    bump(source);
    return { ok: true, notes: [], id };
  }

  function setTrendline(args: Record<string, unknown>, source: Source): Outcome {
    const t1 = Number(args.t1);
    const p1 = Number(args.p1);
    const t2 = Number(args.t2);
    const p2 = Number(args.p2);
    for (const [name, value] of [['t1', t1], ['p1', p1], ['t2', t2], ['p2', p2]] as const) {
      if (!Number.isFinite(value)) {
        return { ok: false, notes: [], error: `${name} must be a finite number; a trendline needs both endpoints as (time, price)` };
      }
    }
    // Two anchors at the same instant describe a vertical line, which is a mark, and the
    // renderer would divide by zero working out the slope. Refusing names the tool that does
    // want that rather than drawing something misleading.
    if (t1 === t2) {
      return { ok: false, notes: [], error: 'a trendline needs two different times; for a vertical line at one moment use chart_mark' };
    }
    if (state.trendlines.length >= LIMITS.maxTrendlines) {
      return { ok: false, notes: [], error: `${LIMITS.maxTrendlines} trendlines is the maximum. Clear some with chart_clear.` };
    }
    // Stored oldest endpoint first, so the renderer and the read never have to care which
    // order the two anchors arrived in.
    const flip = t2 < t1;
    const id = nextId('trend');
    state.trendlines.push({
      id,
      t1: Math.round(flip ? t2 : t1),
      p1: flip ? p2 : p1,
      t2: Math.round(flip ? t1 : t2),
      p2: flip ? p1 : p2,
      label: tag(String(args.label ?? '') || 'trendline', source),
      source,
    });
    bump(source);
    return { ok: true, notes: [], id };
  }

  function clear(what: string): Outcome {
    const key = String(what ?? 'all').toLowerCase().trim();
    if (key === 'indicators') state.indicators = [];
    else if (key === 'levels') state.levels = [];
    else if (key === 'marks') state.marks = [];
    else if (key === 'trendlines') state.trendlines = [];
    else if (key === 'agent') {
      // The human's one-click way out of anything the agent put on the surface.
      state.indicators = state.indicators.filter((i) => i.source !== 'agent');
      state.levels = state.levels.filter((l) => l.source !== 'agent');
      state.marks = state.marks.filter((m) => m.source !== 'agent');
      state.trendlines = state.trendlines.filter((t) => t.source !== 'agent');
    } else if (key === 'all') {
      state.indicators = [];
      state.levels = [];
      state.marks = [];
      state.trendlines = [];
    } else {
      return { ok: false, notes: [], error: `unknown target: ${key}. known: indicators, levels, marks, trendlines, agent, all` };
    }
    bump('human');
    return { ok: true, notes: [`cleared ${key}`] };
  }

  // Bars to fetch: the window, the pan, a margin, and the longest indicator warmup so an
  // overlay is drawn all the way to the left edge instead of starting mid screen.
  function historyNeeded(): number {
    let warmup = 0;
    for (const ind of state.indicators) {
      const spec = indicatorSpec(ind.type);
      if (spec === undefined) continue;
      const need = warmupBars(spec, ind.params);
      if (need > warmup) warmup = need;
    }
    const want = state.view.barCount + Math.max(0, state.view.panOffset) + LIMITS.fetchMargin + warmup;
    return Math.min(LIMITS.historyMax, Math.max(LIMITS.historyFloor, Math.ceil(want)));
  }

  return {
    state: () => state,
    rev: () => state.rev,
    historyNeeded,
    setView,
    addIndicator,
    removeIndicator,
    setLevel,
    setMark,
    setTrendline,
    clear,
    setGeometry(geometry: ChartGeometry): void {
      // Geometry is a report about the renderer, not a change to the chart, so it does not
      // bump the revision. Bumping it here would make the browser answer its own echo.
      state.geometry = geometry;
    },
    agentObjects(): number {
      return (
        state.indicators.filter((i) => i.source === 'agent').length +
        state.levels.filter((l) => l.source === 'agent').length +
        state.marks.filter((m) => m.source === 'agent').length +
        state.trendlines.filter((t) => t.source === 'agent').length
      );
    },
  };
}

function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

export function clampPan(value: number, barCount: number): number {
  // Forward past the newest bar is allowed, up to a quarter of the window, because a chart
  // that walls at the last bar feels stuck. Back is capped by what the rails will serve.
  const forward = -Math.round(barCount * 0.25);
  return clamp(value, forward, LIMITS.panMax);
}

export type VisibleRange = { start: number; end: number; count: number };

// The candles under the plot. `end` is exclusive. Fractional pan and bar counts are rounded
// outward so a partially visible bar at either edge is still included.
export function visibleRange(total: number, view: ChartView): VisibleRange {
  if (total <= 0) return { start: 0, end: 0, count: 0 };
  const end = clamp(Math.ceil(total - view.panOffset), 1, total);
  const start = clamp(Math.floor(end - view.barCount), 0, Math.max(0, end - 1));
  return { start, end, count: end - start };
}

export type SeriesDigest = {
  timeframe: string;
  granularitySec: number;
  bars: number;
  last: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  rangePct: number | null;
  atr: number | null;
  atrPct: number | null;
  trend: string;
  barClosesInSec: number | null;
  newestBarTime: string | null;
};

// One timeframe boiled down to what a trader glances at. Used by chart_scan so the agent can
// hold several timeframes at once without moving the chart the human is looking at.
export function digestSeries(candles: Candle[], granularitySec: number, nowSec: number): SeriesDigest {
  const bars = candles.length;
  if (bars === 0) {
    return {
      timeframe: timeframeLabel(granularitySec),
      granularitySec,
      bars: 0,
      last: null,
      changePct: null,
      high: null,
      low: null,
      rangePct: null,
      atr: null,
      atrPct: null,
      trend: 'no data',
      barClosesInSec: null,
      newestBarTime: null,
    };
  }
  const first = candles[0] as Candle;
  const newest = candles[bars - 1] as Candle;
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
  }
  const tr = trueRange(candles);
  const window = Math.min(14, tr.length);
  let atr = 0;
  for (let i = tr.length - window; i < tr.length; i++) atr += tr[i] as number;
  atr = window > 0 ? atr / window : 0;

  // Trend without an indicator on the chart: where the close sits against two averages of
  // the series itself. Cheap, and it answers the only question chart_scan is asked.
  const fastLen = Math.min(21, Math.max(2, Math.floor(bars / 4)));
  const slowLen = Math.min(55, Math.max(fastLen + 1, Math.floor(bars / 2)));
  const avg = (len: number): number => {
    let sum = 0;
    for (let i = bars - len; i < bars; i++) sum += (candles[i] as Candle).c;
    return sum / len;
  };
  const fast = avg(fastLen);
  const slow = avg(slowLen);
  const trend =
    fast > slow && newest.c > fast ? 'up' : fast < slow && newest.c < fast ? 'down' : 'sideways';

  return {
    timeframe: timeframeLabel(granularitySec),
    granularitySec,
    bars,
    last: newest.c,
    changePct: pctChange(first.o, newest.c),
    high,
    low,
    rangePct: low > 0 ? ((high - low) / low) * 100 : null,
    atr,
    atrPct: newest.c > 0 ? (atr / newest.c) * 100 : null,
    trend,
    barClosesInSec: Math.max(0, newest.t + granularitySec - nowSec),
    newestBarTime: isoOf(newest.t),
  };
}

export type ReadArgs = {
  state: ChartState;
  candles: Candle[];
  meta: { source: string; stale: boolean; built: string };
  computed: { indicator: ChartIndicator; result: IndicatorResult }[];
  nowSec: number;
};

// Everything the agent can ask about what is on the chart, in one object. Written to be
// answered without a follow-up: times in epoch and ISO, prices with the precision actually
// drawn, and every indicator with its own plain sentence.
export function buildRead(args: ReadArgs): unknown {
  const { state, candles, meta, computed, nowSec } = args;
  const view = state.view;
  const range = visibleRange(candles.length, view);
  const window = candles.slice(range.start, range.end);
  const newest = candles.length > 0 ? (candles[candles.length - 1] as Candle) : null;

  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const c of window) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
    volume += c.v;
  }
  const hasWindow = window.length > 0;
  const firstBar = hasWindow ? (window[0] as Candle) : null;
  const lastBar = hasWindow ? (window[window.length - 1] as Candle) : null;

  const shownLow = view.priceScale.mode === 'manual' ? view.priceScale.low : hasWindow ? low : 0;
  const shownHigh = view.priceScale.mode === 'manual' ? view.priceScale.high : hasWindow ? high : 0;
  const decimals = displayDecimals(shownHigh - shownLow, window);

  const highBar = hasWindow ? window.reduce((best, c) => (c.h > best.h ? c : best), window[0] as Candle) : null;
  const lowBar = hasWindow ? window.reduce((best, c) => (c.l < best.l ? c : best), window[0] as Candle) : null;

  return {
    product: view.product,
    timeframe: timeframeLabel(view.granularitySec),
    granularitySec: view.granularitySec,
    barDurationSec: view.granularitySec,
    serverTime: { epochSec: nowSec, iso: isoOf(nowSec), zone: 'UTC' },

    data: {
      source: meta.source,
      stale: meta.stale,
      builtFrom: meta.built === 'trades' ? 'live trade stream (no exchange candle exists below 1m)' : 'exchange candles',
      barsLoaded: candles.length,
      oldestLoaded: candles.length > 0 ? isoOf((candles[0] as Candle).t) : null,
    },

    window: {
      barsShown: range.count,
      barsBackFromNewest: Math.round(view.panOffset),
      live: view.panOffset <= 0,
      from: firstBar === null ? null : { epochSec: firstBar.t, iso: isoOf(firstBar.t) },
      to: lastBar === null ? null : { epochSec: lastBar.t, iso: isoOf(lastBar.t) },
      spansSec: firstBar !== null && lastBar !== null ? lastBar.t + view.granularitySec - firstBar.t : null,
    },

    price: {
      decimals,
      last: newest === null ? null : newest.c,
      changeOverWindowPct: firstBar !== null && newest !== null ? pctChange(firstBar.o, newest.c) : null,
      changeOverWindowAbs: firstBar !== null && newest !== null ? newest.c - firstBar.o : null,
      high: hasWindow ? high : null,
      highAt: highBar === null ? null : isoOf(highBar.t),
      low: hasWindow ? low : null,
      lowAt: lowBar === null ? null : isoOf(lowBar.t),
      rangePct: hasWindow && low > 0 ? ((high - low) / low) * 100 : null,
      volumeOverWindow: volume,
      scale: view.priceScale.mode === 'manual'
        ? { mode: 'manual', low: view.priceScale.low, high: view.priceScale.high }
        : { mode: 'auto', low: hasWindow ? low : null, high: hasWindow ? high : null },
    },

    currentBar:
      newest === null
        ? null
        : {
            openTime: { epochSec: newest.t, iso: isoOf(newest.t) },
            o: newest.o,
            h: newest.h,
            l: newest.l,
            c: newest.c,
            v: newest.v,
            direction: newest.c >= newest.o ? 'up' : 'down',
            closesInSec: Math.max(0, newest.t + view.granularitySec - nowSec),
          },

    indicators: computed.map(({ indicator, result }) => ({
      id: indicator.id,
      type: indicator.type,
      label: indicator.label,
      params: indicator.params,
      pane: indicator.pane === 'price' ? 'price' : 'own',
      source: indicator.source,
      state: result.state,
      last: result.plots.map((plot) => ({ key: plot.key, value: lastDefined(plot.values) })),
    })),

    levels: state.levels.map((l) => ({
      id: l.id,
      price: l.price,
      label: l.label,
      source: l.source,
      distanceFromLastPct: newest === null ? null : pctChange(newest.c, l.price),
      side: newest === null ? null : l.price > newest.c ? 'above price' : 'below price',
    })),
    marks: state.marks.map((m) => ({ id: m.id, label: m.label, source: m.source, epochSec: m.t, iso: isoOf(m.t) })),

    // priceNow and distanceFromLastPct are the whole reason to read a trendline back: a
    // sloped line's useful value is where it sits at this instant, and recomputing that from
    // two anchors is exactly the arithmetic the reader should not have to repeat. Extended
    // past its second anchor, which is what makes it a trend line rather than a segment.
    trendlines: state.trendlines.map((tl) => {
      const slopePerSec = (tl.p2 - tl.p1) / (tl.t2 - tl.t1);
      const priceNow = newest === null ? null : tl.p1 + slopePerSec * (newest.t - tl.t1);
      return {
        id: tl.id,
        label: tl.label,
        source: tl.source,
        from: { epochSec: tl.t1, iso: isoOf(tl.t1), price: tl.p1 },
        to: { epochSec: tl.t2, iso: isoOf(tl.t2), price: tl.p2 },
        slopePerHour: slopePerSec * 3600,
        direction: tl.p2 > tl.p1 ? 'rising' : tl.p2 < tl.p1 ? 'falling' : 'flat',
        priceNow,
        distanceFromLastPct: newest === null || priceNow === null ? null : pctChange(newest.c, priceNow),
        side: newest === null || priceNow === null ? null : priceNow > newest.c ? 'above price' : 'below price',
      };
    }),

    geometry: state.geometry,
    rev: state.rev,
    lastDriver: state.lastDriver,
    lastChangeAt: state.lastChangeAt,
  };
}

function lastDefined(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

export type MeasureArgs = {
  candles: Candle[];
  granularitySec: number;
  fromTime?: number;
  toTime?: number;
  fromPrice?: number;
  toPrice?: number;
};

// The ruler. Either two times (and it reads the closes there), two prices, or one of each.
export function measure(args: MeasureArgs): unknown {
  const { candles, granularitySec } = args;
  if (candles.length === 0) return { error: 'no candle data loaded' };

  const at = (t: number): Candle => {
    let best = candles[0] as Candle;
    let bestGap = Infinity;
    for (const c of candles) {
      const gap = Math.abs(c.t - t);
      if (gap < bestGap) {
        bestGap = gap;
        best = c;
      }
    }
    return best;
  };

  const newest = candles[candles.length - 1] as Candle;
  const fromBar = args.fromTime !== undefined ? at(args.fromTime) : (candles[0] as Candle);
  const toBar = args.toTime !== undefined ? at(args.toTime) : newest;
  const from = args.fromPrice !== undefined ? args.fromPrice : fromBar.c;
  const to = args.toPrice !== undefined ? args.toPrice : toBar.c;

  const elapsedSec = Math.abs(toBar.t - fromBar.t);
  const bars = granularitySec > 0 ? Math.round(elapsedSec / granularitySec) : 0;

  // The path between the two bars, which is the part a straight delta hides: an 8% move that
  // drew 14% down first is not the same trade.
  const startIdx = candles.findIndex((c) => c.t === fromBar.t);
  const endIdx = candles.findIndex((c) => c.t === toBar.t);
  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);
  let pathHigh = -Infinity;
  let pathLow = Infinity;
  for (let i = lo; i <= hi && i < candles.length; i++) {
    const c = candles[i] as Candle;
    if (c.h > pathHigh) pathHigh = c.h;
    if (c.l < pathLow) pathLow = c.l;
  }

  return {
    from: { price: from, epochSec: fromBar.t, iso: isoOf(fromBar.t) },
    to: { price: to, epochSec: toBar.t, iso: isoOf(toBar.t) },
    deltaAbs: to - from,
    deltaPct: pctChange(from, to),
    direction: to >= from ? 'up' : 'down',
    bars,
    elapsedSec,
    elapsedHuman: humanDuration(elapsedSec),
    perBarPct: bars > 0 ? pctChange(from, to) / bars : null,
    pathHigh: Number.isFinite(pathHigh) ? pathHigh : null,
    pathLow: Number.isFinite(pathLow) ? pathLow : null,
    maxDrawdownPct: Number.isFinite(pathHigh) && pathHigh > 0 ? ((pathLow - pathHigh) / pathHigh) * 100 : null,
  };
}

function humanDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
