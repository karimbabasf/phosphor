// The market data service: one door in front of the catalogue, the rails and the cache.
//
// The split that matters is who waits. The browser never waits: a render reads whatever is
// in memory and the fill happens behind it, which is what took the exchange round trip out
// of the render path. An agent does wait, because an agent asking "what is BTC doing" and
// getting an empty array while the cache warms would be a worse answer than a slow one.
//
// So: read() for pixels, warm() for answers.

import type { Candle } from '../types.ts';
import { createCatalog, type Catalog, type MarketRef, type Provider } from './catalog.ts';
import { createProviders, planBase } from './providers.ts';
import { createMarketStore, staleAfterSec, type MarketStore } from './store.ts';
import { formatTimeframe, parseTimeframe, MIN_TIMEFRAME_SEC } from './aggregate.ts';

/* How far back the bars in hand actually reach. */
function coverage(candles: readonly Candle[], stepSec: number): number {
  if (candles.length === 0) return 0;
  const first = candles[0] as Candle;
  const last = candles[candles.length - 1] as Candle;
  return last.t + stepSec - first.t;
}

export type MarketRead = {
  candles: Candle[];
  ref: MarketRef | null;
  product: string;
  timeframe: string;
  granularitySec: number;
  baseSec: number;
  source: string;
  ageSec: number;
  filling: boolean;
  // Old enough that what is on screen may no longer be the market. A refresh being in
  // flight is not staleness: the bars in hand are still the right bars, and calling that
  // stale puts a warning on a chart that is perfectly current.
  stale: boolean;
  // How far back the bars in hand actually reach. The sub-minute rails cannot always fill
  // the window, and a chart that does not say so is pretending.
  coverageSec: number;
  bars: number;
  note: string | null;
  error: string | null;
};

export type MarketDeps = {
  catalog?: Catalog;
  store?: MarketStore;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  onUpdate?: (product: string, baseSec: number) => void;
  now?: () => number;
};

export function createMarketData(deps: MarketDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const catalog = deps.catalog ?? createCatalog({ fetchImpl: deps.fetchImpl, cachePath: deps.cachePath, now });
  const providers = createProviders({ catalog, fetchImpl: deps.fetchImpl, now });
  const store =
    deps.store ?? createMarketStore({ fetchWindow: providers.fetchWindow, onUpdate: deps.onUpdate, now });

  /* Which venue answers, and on what interval. One series, one venue, always.

     `want` names a venue to pin to. 'auto' is the catalogue's own preference, which is
     Hyperliquid wherever it lists the coin. A pinned venue that does not list the product
     resolves to null, and the read below reports that rather than falling back: a chart
     that says coinbase while drawing Hyperliquid's perp is worse than an empty one. */
  function plan(query: string, timeframe: string | number, want: Provider | 'auto' = 'auto') {
    const targetSec = Math.max(MIN_TIMEFRAME_SEC, parseTimeframe(timeframe) ?? 60);
    const ref = want === 'auto' ? catalog.resolve(query) : catalog.resolveOn(query, want);
    const product = ref?.product ?? query.toUpperCase();
    const unlisted = want !== 'auto' && ref === null;
    return { ref, product, targetSec, unlisted, want, base: planBase(ref, targetSec) };
  }

  /* The render path. Synchronous, never throws, never waits on a venue. */
  function read(query: string, timeframe: string | number, bars: number, want: Provider | 'auto' = 'auto'): MarketRead {
    const { ref, product, targetSec, base, unlisted } = plan(query, timeframe, want);
    // A venue that does not list the coin is answered here, without a fetch and without a
    // cache entry, so the pinned name never sits over another venue's bars.
    if (unlisted) {
      return {
        candles: [],
        ref: null,
        product,
        timeframe: formatTimeframe(targetSec),
        granularitySec: targetSec,
        baseSec: base.baseSec,
        source: String(want),
        ageSec: 0,
        filling: false,
        stale: false,
        coverageSec: 0,
        bars: 0,
        note: null,
        error: `${want} does not list ${product}`,
      };
    }
    const venue = ref?.provider ?? 'hyperliquid';
    const held = store.read(product, base.baseSec, targetSec, bars, venue);
    const reached = coverage(held.candles, targetSec);
    const note = base.note;

    return {
      candles: held.candles,
      ref,
      product,
      timeframe: formatTimeframe(targetSec),
      granularitySec: targetSec,
      baseSec: base.baseSec,
      // Name the venue. One series is only ever one venue now.
      source: base.provider,
      ageSec: held.ageSec,
      filling: held.filling,
      stale: held.error !== null || held.ageSec > staleAfterSec(base.baseSec) * 4,
      coverageSec: reached,
      bars: held.candles.length,
      note,
      error: held.error,
    };
  }

  /* The agent path. Waits for a cold cache, because an empty answer is worse than a slow
     one when something is going to reason over it. */
  async function warm(
    query: string,
    timeframe: string | number,
    bars: number,
    want: Provider | 'auto' = 'auto',
  ): Promise<MarketRead> {
    const { ref, product, targetSec, base, unlisted } = plan(query, timeframe, want);
    if (unlisted) return read(query, timeframe, bars, want);
    await store.warm(product, base.baseSec, targetSec, bars, ref?.provider ?? 'hyperliquid');
    return read(query, timeframe, bars, want);
  }

  return {
    read,
    warm,
    resolve: (query: string) => catalog.resolve(query),
    resolveOn: (query: string, provider: Provider) => catalog.resolveOn(query, provider),
    search: (query: string, limit?: number) => catalog.search(query, limit),
    refreshCatalog: () => catalog.refresh(),
    catalogLoadedAt: () => catalog.loadedAt(),
    all: () => catalog.all(),
    stats: () => store.stats(),
  };
}

export type MarketData = ReturnType<typeof createMarketData>;
