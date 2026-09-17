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
import { aggregate, baseBarsNeeded, bucketStart, foldsInto } from './aggregate.ts';

// `endSec` is the newest open time wanted, for a window behind the ones held. Absent, the
// window ends now, which is every fill that is not a backfill.
type FetchWindow = (product: string, baseSec: number, bars: number, provider: string, endSec?: number) => Promise<Candle[]>;

type ReadResult = {
  candles: Candle[];
  // Seconds since the newest bar in the cache was refreshed. The chart shows this.
  ageSec: number;
  // Seconds since a live bar was folded into this product on this venue, or null if none ever
  // has. This is what the feed dot is derived from, and it is deliberately not a boolean: the
  // difference between "a socket is open" and "a socket is open and sent something recently"
  // is the whole difference between a chart that is live and one that only claims to be.
  liveAgeSec: number | null;
  // True while a fill for this series is in flight, so the UI can say "filling" rather
  // than showing a stalled chart and letting the human guess.
  filling: boolean;
  // True while older bars are on their way in behind the ones held.
  backfilling: boolean;
  // The venue has nothing older than `oldestSec`. Set by a backfill that came back short, or by
  // a first fill that did; it is what stops the store asking a bottomed venue on every read and
  // what lets the chart say "history begins here" rather than "loading".
  exhaustedBack: boolean;
  // The oldest base bar the cache holds for this series, or null on a cold one.
  oldestSec: number | null;
  // How much history the cache actually holds, which is not always what was asked for.
  bars: number;
  source: string;
  error: string | null;
};

type MarketStoreOptions = {
  fetchWindow: FetchWindow;
  // Told after a fill changes a series, so the server can push one SSE frame instead of
  // the browser polling. Never called for a fill that changed nothing.
  onUpdate?: (product: string, baseSec: number) => void;
  // Told when a live bar is folded in, carrying the bar rather than a nudge. One emission
  // point for anything that reaches the cache without a network call, so the SSE frame is
  // wired once here rather than at each caller of put().
  onLive?: (product: string, baseSec: number, candle: Candle, provider: string) => void;
  // Bars kept per series, newest kept when it is over. Fifty thousand is the pan depth the
  // chart offers: a backfill behind the left edge grows a series to it, and the venues stop
  // well short of it on every interval but the slow ones (Hyperliquid serves the newest five
  // thousand bars of an interval and nothing older, measured 2026-09-16).
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
  // Set when a window asked for behind the oldest bar held came back short or empty: the
  // venue has nothing older, and no read asks it for older bars again.
  exhaustedBack: boolean;
  // When a live bar was last folded into this series. Zero means never.
  liveAt: number;
};

// How long after the last live bar a series still counts as being driven by a socket.
// The audit's threshold: under 5 s is live, 5 to 30 s is delayed, past that the socket is not
// serving this market whatever its readyState says.
const LIVE_FRESH_MS = 5000;

// What the REST gate relaxes to while a series is live. The rail is what moves the price, so
// REST becomes a correctness backstop reconciling the closed bar rather than the thing driving
// the screen. When the socket goes down the gate below resumes and behaviour is exactly what
// it was before the rail existed.
const LIVE_RELAXED_STALE_SEC = 30;

/* A copy of a window in open-time order with one bar per open time, the later copy winning.
   The venues answer in order and pageBackward sorts, so this is a scan and no copy almost
   always; a venue that answered newest first still merges correctly. */
function ordered(candles: readonly Candle[]): readonly Candle[] {
  let sorted = true;
  for (let i = 1; i < candles.length && sorted; i++) sorted = (candles[i] as Candle).t > (candles[i - 1] as Candle).t;
  if (sorted) return candles;
  const byTime = new Map<number, Candle>();
  for (const candle of candles) byTime.set(candle.t, candle);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/* Union two oldest-first series by open time, letting the incoming bar win.
   The incoming copy is fresher by definition: it is either the same closed bar or the
   newest bar with more trades folded into it.

   A walk over both rather than a map and a sort: a series is fifty thousand bars now, and a
   backfill landing behind it or a tail landing after it is a concat, which the walk does in
   one pass and the sort did in n log n with a map of every bar built first. */
export function mergeSeries(existing: readonly Candle[], incoming: readonly Candle[], maxBars: number): Candle[] {
  if (existing.length === 0) return ordered(incoming).slice(-maxBars);
  if (incoming.length === 0) return existing.slice(-maxBars);
  const fresh = ordered(incoming);

  const out: Candle[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length || j < fresh.length) {
    const held = existing[i];
    const next = fresh[j];
    if (next === undefined) {
      out.push(held as Candle);
      i++;
    } else if (held === undefined || held.t > next.t) {
      out.push(next);
      j++;
    } else if (held.t < next.t) {
      out.push(held);
      i++;
    } else {
      out.push(next);
      i++;
      j++;
    }
  }
  return out.length > maxBars ? out.slice(-maxBars) : out;
}

/* How long a series may sit before the newest bar is worth refetching.
   A closed bar never changes, so the only thing aging is the bar still forming. Refreshing
   a 1d chart every few seconds is pure waste, so the coarse timeframes keep their long gates.

   The 1m gate was 3 s and is 1 s. Measured 2026-09-01: three poll throttles sat in series
   with no push rail (this gate, CANDLE_PUSH_MS in the server, minGap in the browser) and
   polls compose by addition, so the price on screen was 4.0 s old at p50 while every hop
   looked individually defensible. One second costs about four calls a minute per series,
   which is well inside both venues' budgets. The live rail in live.ts is what actually moves
   the price now; this is the fallback's cadence, not the screen's. */
export function staleAfterSec(baseSec: number): number {
  if (baseSec <= 60) return 1;
  if (baseSec <= 900) return 15;
  if (baseSec <= 3600) return 30;
  return 60;
}

// Bars a backfill asks for at once, in base bars. Two thousand is what the deep venue answers
// in one call and about what one pan gesture can cross.
const BACKFILL_BARS = 2000;

export function createMarketStore(options: MarketStoreOptions) {
  const { fetchWindow, onUpdate, onLive } = options;
  const maxBars = options.maxBars ?? 50000;
  const maxSeries = options.maxSeries ?? 24;
  const now = options.now ?? (() => Date.now());

  const series = new Map<string, Series>();
  // One in-flight fill per series. A hundred reads during a drag collapse into one call.
  const inflight = new Map<string, Promise<void>>();

  // The venue is part of the key, not a detail of the fetch.
  //
  // Without it, forcing a product onto the other venue writes that venue's bars into the
  // series the first one already filled, and mergeSeries splices a perp and a spot market
  // into one line by timestamp. Nothing downstream could tell: both are candles, both are
  // the right shape, and the price is simply wrong in a way that looks like a real move.
  // The provider argument is defaulted for the same reason it is documented here: a caller
  // that forgets it lands on the venue the catalogue prefers anyway, so a mistake is a
  // duplicate series and never a spliced one.
  function keyOf(product: string, baseSec: number, provider: string): string {
    return `${provider}:${product}:${baseSec}`;
  }

  /* When this product last had a live bar on this venue, at any base interval.
     Deliberately not per-series: the rail only ever puts 1m bars (see live.ts), so a 5m
     series would report itself dead while the socket driving the very same market is wide
     awake, and the dot beside the price would go hollow on every timeframe but one. */
  function liveAtFor(product: string, provider: string): number {
    let at = 0;
    for (const [key, entry] of series) {
      if (entry.liveAt <= at) continue;
      if (!key.startsWith(`${provider}:${product}:`)) continue;
      at = entry.liveAt;
    }
    return at;
  }

  /* Bars for a timeframe, folded from a finer base this cache already holds.

     Two problems, one answer. The visible one is the blank: clicking 1m to 5m keys a fresh
     series, whose first read returns an empty array with filling true, which draws the
     skeleton, while the 1m bars needed to build every one of those 5m bars are already in
     memory. The second is that the live rail only ever carries minutes (see live.ts), so
     without this a 5m chart would sit still while a socket drove the very same market.

     The fold has to be exact or it is a lie, so only a base that divides the target is used,
     and the oldest bucket is dropped unless the bars feeding it start on a boundary: half a
     bucket drawn as a whole one is a bar that never happened. The coarsest qualifying base
     wins rather than the finest, because coarser bars reach further back for the same count
     and the fold is exact either way. */
  function bridge(product: string, provider: string, baseSec: number, targetSec: number, bars: number): Candle[] {
    const prefix = `${provider}:${product}:`;
    let fromSec = 0;
    let source: Series | null = null;
    for (const [key, entry] of series) {
      if (!key.startsWith(prefix)) continue;
      const held = Number(key.slice(prefix.length));
      if (!Number.isFinite(held) || held >= baseSec || held <= fromSec) continue;
      if (!foldsInto(held, targetSec) || entry.candles.length === 0) continue;
      fromSec = held;
      source = entry;
    }
    if (source === null) return [];

    const need = baseBarsNeeded(bars, fromSec, targetSec);
    const tail = source.candles.length > need ? source.candles.slice(-need) : source.candles;
    const folded = aggregate(tail, fromSec, targetSec);
    const first = tail[0] as Candle;
    if (folded.length > 0 && bucketStart(first.t, targetSec) !== first.t) folded.shift();
    return folded;
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
  function fill(product: string, baseSec: number, bars: number, provider = 'hyperliquid'): Promise<void> {
    const key = keyOf(product, baseSec, provider);
    const running = inflight.get(key);
    if (running !== undefined) return running;

    const entry = series.get(key);
    if (entry !== undefined) entry.filling = true;

    const task = (async () => {
      try {
        const fetched = await fetchWindow(product, baseSec, bars, provider);
        const current = series.get(key);
        const merged = mergeSeries(current?.candles ?? [], fetched, maxBars);
        const changed =
          current === undefined ||
          merged.length !== current.candles.length ||
          (merged.length > 0 &&
            current.candles.length > 0 &&
            merged[merged.length - 1]?.c !== current.candles[current.candles.length - 1]?.c);

        // A newest window that came back short is the venue's whole history: nothing is
        // older either, and a backfill would only confirm it with a round trip.
        const short = fetched.length < bars;
        series.set(key, {
          candles: merged,
          fetchedAt: now(),
          lastReadAt: current?.lastReadAt ?? now(),
          filling: false,
          source: 'live',
          error: null,
          exhausted: short,
          exhaustedBack: (current?.exhaustedBack ?? false) || (short && (current === undefined || current.candles.length === 0)),
          liveAt: current?.liveAt ?? 0,
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
          exhaustedBack: current?.exhaustedBack ?? false,
          liveAt: current?.liveAt ?? 0,
        });
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, task);
    return task;
  }

  /* Fill the bars behind the oldest one held, deduped like fill and keyed apart from it, so a
     stale refresh at the newest end and a pan into history never wait on each other. The
     window asked for ends one base bar before the oldest held; a venue that answers fewer
     than asked, or nothing at all, has no more, and the series says so. */
  function fillBefore(product: string, baseSec: number, bars: number, provider = 'hyperliquid'): Promise<void> {
    const key = keyOf(product, baseSec, provider);
    const backKey = `${key}:back`;
    const running = inflight.get(backKey);
    if (running !== undefined) return running;
    const entry = series.get(key);
    const oldest = entry?.candles[0];
    if (entry === undefined || oldest === undefined || entry.exhaustedBack) return Promise.resolve();

    const task = (async () => {
      try {
        const fetched = await fetchWindow(product, baseSec, bars, provider, oldest.t - baseSec);
        const older = fetched.filter((c) => c.t < oldest.t);
        const current = series.get(key);
        if (current === undefined) return;
        current.candles = mergeSeries(current.candles, older, maxBars);
        current.exhaustedBack = older.length < bars;
        if (older.length > 0 && onUpdate) onUpdate(product, baseSec);
      } catch (err) {
        const current = series.get(key);
        if (current !== undefined) current.error = err instanceof Error ? err.message : String(err);
      } finally {
        inflight.delete(backKey);
      }
    })();

    inflight.set(backKey, task);
    return task;
  }

  /* The read the render path uses. Never awaits, never throws.
     Returns what the cache holds folded to the timeframe asked for, and quietly starts a
     fill if the newest bar has aged out or the window is short. */
  function read(product: string, baseSec: number, targetSec: number, bars: number, provider = 'hyperliquid'): ReadResult {
    const key = keyOf(product, baseSec, provider);
    const entry = series.get(key);
    const at = now();
    const needBase = baseBarsNeeded(bars, baseSec, targetSec);

    const liveAt = liveAtFor(product, provider);
    const liveAgeSec = liveAt === 0 ? null : (at - liveAt) / 1000;

    const bridged = bridge(product, provider, baseSec, targetSec, bars);

    if (entry === undefined || entry.candles.length === 0) {
      void fill(product, baseSec, needBase, provider);
      // A cold series with a warm finer one is not a blank chart, it is the same market at a
      // different bucket size, and the human clicked one timeframe rather than asking for a
      // skeleton. The real fill lands behind this and replaces it.
      const held = bridged.length > bars ? bridged.slice(-bars) : bridged;
      if (entry !== undefined) entry.lastReadAt = at;
      return {
        candles: held,
        ageSec: 0,
        liveAgeSec,
        filling: true,
        backfilling: false,
        exhaustedBack: false,
        oldestSec: null,
        bars: held.length,
        source: held.length > 0 ? 'bridged' : 'filling',
        error: entry?.error ?? null,
      };
    }

    entry.lastReadAt = at;
    const ageSec = (at - entry.fetchedAt) / 1000;
    // A series a socket is driving does not need REST every second. The rail moves the price
    // and REST reconciles the closed bar, so the gate relaxes while the deltas keep landing
    // and snaps back the moment they stop.
    const gateSec = at - liveAt < LIVE_FRESH_MS ? LIVE_RELAXED_STALE_SEC : staleAfterSec(baseSec);
    if (ageSec >= gateSec) {
      // Background only, and only the tail: the bars that can have changed since the last
      // fill are the forming one and whatever closed in the meantime. The whole window used
      // to be refetched here, which was two thousand bars a second on a quiet socket and
      // would be fifty thousand now.
      const tail = Math.min(needBase, Math.ceil(ageSec / baseSec) + 2);
      void fill(product, baseSec, tail, provider);
    }
    // Short at the back, and the venue has not said it is out of history: the missing bars
    // are all older than the oldest held, so they are asked for behind it rather than by
    // refetching the newest window with a bigger number, which never reached them.
    const missing = needBase - entry.candles.length;
    if (missing > 0 && !entry.exhaustedBack) {
      void fillBefore(product, baseSec, Math.max(missing, Math.min(BACKFILL_BARS, needBase)), provider);
    }

    // The finer bars win where the two overlap. They are fresher by construction: the rail
    // folds into the 1m series several times a second and this series is refetched at best
    // once. This is also the only thing that makes a 5m chart move between REST fills.
    const own = aggregate(entry.candles, baseSec, targetSec);
    const folded = bridged.length === 0 ? own : mergeSeries(own, bridged, maxBars);
    const windowed = folded.length > bars ? folded.slice(-bars) : folded;

    return {
      candles: windowed,
      ageSec,
      liveAgeSec,
      filling: inflight.has(key),
      backfilling: inflight.has(`${key}:back`),
      exhaustedBack: entry.exhaustedBack,
      oldestSec: (entry.candles[0] as Candle).t,
      bars: windowed.length,
      source: entry.source,
      error: entry.error,
    };
  }

  /* The bars of a timeframe older than a moment, for the chart panning into history: what the
     cache holds before `beforeSec`, folded, and when that is short, the venue behind it,
     awaited. The window asks for these when its left edge nears the oldest bar it holds. */
  async function before(
    product: string,
    baseSec: number,
    targetSec: number,
    beforeSec: number,
    bars: number,
    provider = 'hyperliquid',
  ): Promise<{ candles: Candle[]; exhaustedBack: boolean; oldestSec: number | null }> {
    const key = keyOf(product, baseSec, provider);
    const needBase = baseBarsNeeded(bars, baseSec, targetSec);
    if (series.get(key) === undefined || (series.get(key) as Series).candles.length === 0) {
      await fill(product, baseSec, needBase, provider);
    }
    const heldBase = (): number => {
      const entry = series.get(key);
      if (entry === undefined) return 0;
      let n = 0;
      while (n < entry.candles.length && (entry.candles[n] as Candle).t < beforeSec) n++;
      return n;
    };
    // Page until the cache holds enough behind the moment or the venue has no more. Four
    // pages of the biggest ask is the deepest one call to this reaches; the window asks again.
    for (let page = 0; page < 4; page++) {
      const entry = series.get(key);
      if (entry === undefined || entry.exhaustedBack || heldBase() >= needBase) break;
      await fillBefore(product, baseSec, Math.max(BACKFILL_BARS, needBase - heldBase()), provider);
    }
    const entry = series.get(key);
    if (entry === undefined) return { candles: [], exhaustedBack: false, oldestSec: null };
    const olderBase = entry.candles.filter((c) => c.t < beforeSec);
    const folded = aggregate(olderBase, baseSec, targetSec).filter((c) => c.t < beforeSec);
    return {
      candles: folded.length > bars ? folded.slice(-bars) : folded,
      exhaustedBack: entry.exhaustedBack,
      oldestSec: entry.candles.length > 0 ? (entry.candles[0] as Candle).t : null,
    };
  }

  /* The newest bar held for a series, with no fill, no eviction and no bookkeeping.
     The live rail's Coinbase fold needs the venue's own open for the minute it is attaching
     to, and it asks per trade, so this must stay free of side effects. */
  function peek(product: string, baseSec: number, provider = 'hyperliquid'): Candle | null {
    const entry = series.get(keyOf(product, baseSec, provider));
    if (entry === undefined || entry.candles.length === 0) return null;
    return entry.candles[entry.candles.length - 1] as Candle;
  }

  /* Wait for a series to be usable. Only for callers that genuinely cannot draw without
     data, which is the first paint and an agent read, never the render loop. A series that
     is there but short, with the bars behind it on their way, is waited for too: an agent
     reading a chart panned into history wants the history, not the one bar left on screen. */
  async function warm(
    product: string,
    baseSec: number,
    targetSec: number,
    bars: number,
    provider = 'hyperliquid',
  ): Promise<ReadResult> {
    const first = read(product, baseSec, targetSec, bars, provider);
    const key = keyOf(product, baseSec, provider);
    if (first.candles.length > 0 && (first.bars >= bars || !inflight.has(`${key}:back`))) return first;
    const pending = first.candles.length === 0 ? inflight.get(key) : inflight.get(`${key}:back`);
    if (pending !== undefined) await pending;
    return read(product, baseSec, targetSec, bars, provider);
  }

  /* Fold a freshly built bar in without a network call. The live rail uses this so the
     forming bar moves at socket speed while the REST rail stays on its slow cadence.

     The fast path matters here in a way it does not for a fill. mergeSeries builds a Map of
     every bar it holds and sorts the result, which is the right shape for a five hundred bar
     window landing from a venue and the wrong one for a single bar arriving six times a
     second: five thousand entries hashed and sorted to move one close. The overwhelmingly
     common cases are the bar that is already newest and the bar one step past it, and both
     are a copy and an assignment. The array is copied rather than mutated because a reader
     may still be holding the one it was given, and a candle changing under a caller that
     already returned it is the kind of bug that only shows up as a wrong number on a screen. */
  function put(product: string, baseSec: number, candles: readonly Candle[], provider = 'hyperliquid'): void {
    if (candles.length === 0) return;
    const key = keyOf(product, baseSec, provider);
    const current = series.get(key);
    const at = now();

    let next: Candle[];
    const held = current?.candles;
    const newest = held !== undefined && held.length > 0 ? (held[held.length - 1] as Candle) : null;
    const only = candles.length === 1 ? (candles[0] as Candle) : null;
    if (held !== undefined && only !== null && newest !== null && only.t === newest.t) {
      next = held.slice();
      next[next.length - 1] = only;
    } else if (held !== undefined && only !== null && newest !== null && only.t > newest.t) {
      next = held.slice();
      next.push(only);
      if (next.length > maxBars) next = next.slice(-maxBars);
    } else {
      next = mergeSeries(held ?? [], candles, maxBars);
    }

    series.set(key, {
      candles: next,
      fetchedAt: at,
      lastReadAt: current?.lastReadAt ?? at,
      filling: current?.filling ?? false,
      source: current?.source ?? 'live',
      error: null,
      exhausted: current?.exhausted ?? false,
      exhaustedBack: current?.exhaustedBack ?? false,
      liveAt: at,
    });
    evictIfNeeded();
    if (onLive) {
      for (const candle of candles) onLive(product, baseSec, candle, provider);
    }
  }

  function stats(): { series: number; inflight: number; bars: number } {
    let bars = 0;
    for (const entry of series.values()) bars += entry.candles.length;
    return { series: series.size, inflight: inflight.size, bars };
  }

  return { read, warm, fill, before, put, peek, stats };
}

export type MarketStore = ReturnType<typeof createMarketStore>;
