// The candle cache, and the reason the chart stops being late.
//
// The old shape put an exchange round trip inside the render path: every GET /api/chart
// awaited Hyperliquid before the browser could draw a pixel, and the trade stream asked
// the browser to refetch about one and a half times a second. That is roughly ninety
// exchange calls a minute to draw a chart that changed by one bar, and it is why a
// timeframe click felt like a freeze.
//
// The fix is the ordinary one: closed candles are immutable, so they are worth keeping.
// Only the newest bar can change. Reads are synchronous and come from memory. A read that
// finds the newest bar stale asks for a refill in the background and returns anyway, so
// the human sees the chart they already had instead of a spinner, and sees the new bar a
// moment later when the fill lands.
//
// Everything here is provider-agnostic on purpose. The store knows how to keep a series,
// not where candles come from, which is what lets the same cache serve Hyperliquid perps,
// Coinbase spot and second candles bucketed from trades.

import type { Candle } from '../types.ts';
import { aggregate, baseBarsNeeded } from './aggregate.ts';

export type FetchWindow = (product: string, baseSec: number, bars: number) => Promise<Candle[]>;

export type ReadResult = {
  candles: Candle[];
  // Seconds since the newest bar in the cache was refreshed. The chart shows this.
  ageSec: number;
  // True while a fill for this series is in flight, so the UI can say "filling" rather
  // than showing a stalled chart and letting the human guess.
  filling: boolean;
  // How much history the cache actually holds, which is not always what was asked for.
  bars: number;
  source: string;
  error: string | null;
};

export type MarketStoreOptions = {
  fetchWindow: FetchWindow;
  // Told after a fill changes a series, so the server can push one SSE frame instead of
  // the browser polling. Never called for a fill that changed nothing.
  onUpdate?: (product: string, baseSec: number) => void;
  // Most recent bars kept per series. Five thousand 1m bars is about three and a half
  // days, and the deepest window the chart offers is two thousand.
  maxBars?: number;
  // Series kept at once, oldest read evicted first. Twenty four covers a person flipping
  // through timeframes on two or three products without unbounded growth.
  maxSeries?: number;
  now?: () => number;
};

type Series = {
  candles: Candle[];
  fetchedAt: number;
  lastReadAt: number;
  filling: boolean;
  source: string;
  error: string | null;
  // Set when a fill came back with less than it was asked for, which is how a venue says
  // it has no more history. Without this the store reads a short series as "not filled
  // yet" and refetches forever: the margin in baseBarsNeeded means the ask is always a
  // couple of bars past what exists, so the window is never technically full.
  exhausted: boolean;
};

/* Union two oldest-first series by open time, letting the incoming bar win.
   The incoming copy is fresher by definition: it is either the same closed bar or the
   newest bar with more trades folded into it. */
export function mergeSeries(existing: readonly Candle[], incoming: readonly Candle[], maxBars: number): Candle[] {
  if (existing.length === 0) return incoming.slice(-maxBars);
  if (incoming.length === 0) return existing.slice(-maxBars);

  const byTime = new Map<number, Candle>();
  for (const candle of existing) byTime.set(candle.t, candle);
  for (const candle of incoming) byTime.set(candle.t, candle);

  const out = [...byTime.values()].sort((a, b) => a.t - b.t);
  return out.length > maxBars ? out.slice(-maxBars) : out;
}

/* How long a series may sit before the newest bar is worth refetching.
   A closed bar never changes, so the only thing aging is the bar still forming. Refreshing
   a 1m chart more than once every few seconds buys nothing a person can see, and refreshing
   a 1d chart every few seconds is pure waste. */
export function staleAfterSec(baseSec: number): number {
  if (baseSec <= 1) return 1;
  if (baseSec <= 60) return 3;
  if (baseSec <= 900) return 15;
  if (baseSec <= 3600) return 30;
  return 60;
}

export function createMarketStore(options: MarketStoreOptions) {
  const { fetchWindow, onUpdate } = options;
  const maxBars = options.maxBars ?? 5000;
  const maxSeries = options.maxSeries ?? 24;
  const now = options.now ?? (() => Date.now());

  const series = new Map<string, Series>();
  // One in-flight fill per series. A hundred reads during a drag collapse into one call.
  const inflight = new Map<string, Promise<void>>();

  function keyOf(product: string, baseSec: number): string {
    return `${product}:${baseSec}`;
  }

  function evictIfNeeded(): void {
    if (series.size <= maxSeries) return;
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of series) {
      if (entry.filling) continue;
      if (entry.lastReadAt < oldestAt) {
        oldestAt = entry.lastReadAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) series.delete(oldestKey);
  }

  /* Fill a base series, deduped. Errors are kept on the series rather than thrown: a read
     during an outage should return the last good candles and say they are old, which is
     what the chart already knows how to draw. */
  function fill(product: string, baseSec: number, bars: number): Promise<void> {
    const key = keyOf(product, baseSec);
    const running = inflight.get(key);
    if (running !== undefined) return running;

    const entry = series.get(key);
    if (entry !== undefined) entry.filling = true;

    const task = (async () => {
      try {
        const fetched = await fetchWindow(product, baseSec, bars);
        const current = series.get(key);
        const merged = mergeSeries(current?.candles ?? [], fetched, maxBars);
        const changed =
          current === undefined ||
          merged.length !== current.candles.length ||
          (merged.length > 0 &&
            current.candles.length > 0 &&
            merged[merged.length - 1]?.c !== current.candles[current.candles.length - 1]?.c);

        series.set(key, {
          candles: merged,
          fetchedAt: now(),
          lastReadAt: current?.lastReadAt ?? now(),
          filling: false,
          source: 'live',
          error: null,
          exhausted: fetched.length < bars,
        });
        evictIfNeeded();
        if (changed && onUpdate) onUpdate(product, baseSec);
      } catch (err) {
        const current = series.get(key);
        const message = err instanceof Error ? err.message : String(err);
        series.set(key, {
          candles: current?.candles ?? [],
          fetchedAt: current?.fetchedAt ?? 0,
          lastReadAt: current?.lastReadAt ?? now(),
          filling: false,
          source: current?.source ?? 'unavailable',
          error: message,
          exhausted: current?.exhausted ?? false,
        });
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, task);
    return task;
  }

  /* The read the render path uses. Never awaits, never throws.
     Returns what the cache holds folded to the timeframe asked for, and quietly starts a
     fill if the newest bar has aged out or the window is short. */
  function read(product: string, baseSec: number, targetSec: number, bars: number): ReadResult {
    const key = keyOf(product, baseSec);
    const entry = series.get(key);
    const at = now();
    const needBase = baseBarsNeeded(bars, baseSec, targetSec);

    if (entry === undefined) {
      void fill(product, baseSec, needBase);
      return { candles: [], ageSec: 0, filling: true, bars: 0, source: 'filling', error: null };
    }

    entry.lastReadAt = at;
    const ageSec = (at - entry.fetchedAt) / 1000;
    // Short only counts when the venue has not already said it is out of history.
    const short = !entry.exhausted && entry.candles.length < needBase;
    if (ageSec >= staleAfterSec(baseSec) || short) {
      // Background only. The caller gets the bars already in hand.
      void fill(product, baseSec, needBase);
    }

    const folded = aggregate(entry.candles, baseSec, targetSec);
    const windowed = folded.length > bars ? folded.slice(-bars) : folded;

    return {
      candles: windowed,
      ageSec,
      filling: inflight.has(key),
      bars: windowed.length,
      source: entry.source,
      error: entry.error,
    };
  }

  /* Wait for a series to be usable. Only for callers that genuinely cannot draw without
     data, which is the first paint and an agent read, never the render loop. */
  async function warm(product: string, baseSec: number, targetSec: number, bars: number): Promise<ReadResult> {
    const first = read(product, baseSec, targetSec, bars);
    if (first.candles.length > 0) return first;
    const pending = inflight.get(keyOf(product, baseSec));
    if (pending !== undefined) await pending;
    return read(product, baseSec, targetSec, bars);
  }

  /* Fold a freshly built bar in without a network call. The trade stream uses this so the
     forming bar moves at trade speed while the REST rail stays on its slow cadence. */
  function put(product: string, baseSec: number, candles: readonly Candle[]): void {
    if (candles.length === 0) return;
    const key = keyOf(product, baseSec);
    const current = series.get(key);
    series.set(key, {
      candles: mergeSeries(current?.candles ?? [], candles, maxBars),
      fetchedAt: now(),
      lastReadAt: current?.lastReadAt ?? now(),
      filling: current?.filling ?? false,
      source: current?.source ?? 'live',
      error: null,
      exhausted: current?.exhausted ?? false,
    });
    evictIfNeeded();
  }

  function stats(): { series: number; inflight: number; bars: number } {
    let bars = 0;
    for (const entry of series.values()) bars += entry.candles.length;
    return { series: series.size, inflight: inflight.size, bars };
  }

  return { read, warm, fill, put, stats };
}

export type MarketStore = ReturnType<typeof createMarketStore>;
