// The market data service: one door in front of the catalogue, the rails, the cache and
// the live stream.
//
// The split that matters is who waits. The browser never waits: a render reads whatever is
// in memory and the fill happens behind it, which is what took the exchange round trip out
// of the render path. An agent does wait, because an agent asking "what is BTC doing" and
// getting an empty array while the cache warms would be a worse answer than a slow one.
//
// So: read() for pixels, warm() for answers.

import type { Candle } from '../types.ts';
import { createCatalog, type Catalog, type MarketRef } from './catalog.ts';
import { createProviders, planBase } from './providers.ts';
import { createMarketStore, staleAfterSec, type MarketStore } from './store.ts';
import { coverageSec } from './seconds.ts';
import { formatTimeframe, parseTimeframe } from './aggregate.ts';

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

export type LiveSeconds = {
  watch(product: string): void;
  seconds(product: string, granularitySec: number, limit: number): Candle[];
  connected(): boolean;
};

export type MarketDeps = {
  catalog?: Catalog;
  store?: MarketStore;
  live?: LiveSeconds;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  onUpdate?: (product: string, baseSec: number) => void;
  now?: () => number;
};

function humanSpan(sec: number): string {
  if (sec >= 86_400) return `${(sec / 86_400).toFixed(1)} days`;
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)} hours`;
  if (sec >= 60) return `${Math.round(sec / 60)} minutes`;
  return `${Math.round(sec)} seconds`;
}

export function createMarketData(deps: MarketDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const catalog = deps.catalog ?? createCatalog({ fetchImpl: deps.fetchImpl, cachePath: deps.cachePath, now });
  const providers = createProviders({ catalog, fetchImpl: deps.fetchImpl, now });
  const store =
    deps.store ?? createMarketStore({ fetchWindow: providers.fetchWindow, onUpdate: deps.onUpdate, now });
  const live = deps.live;

  /* Keep the trade stream pointed at what is being charted, and fold whatever it has
     collected into the cache. Only ever called for a series the live stream actually
     prices: see the venue rule in plan(). */
  function pumpLive(product: string, baseSec: number): void {
    if (live === undefined || baseSec >= 60) return;
    live.watch(product);
    const built = live.seconds(product, baseSec, 5000);
    if (built.length > 0) store.put(product, baseSec, built);
  }

  /* Which venue answers, and on what interval.
     The rule that matters is on the sub-minute rail: one series, one venue, never a
     splice. The historical trade tape only exists on Coinbase, and the live trade stream
     is Hyperliquid, so the obvious implementation pages Coinbase spot for the past and
     streams a Hyperliquid perp for the present. Those are two different markets. It draws
     as a clean chart with a step in the middle where the basis between them lands, which
     is worse than a short chart because it looks like a real move.
     So: if Coinbase lists it, the whole sub-minute series is Coinbase and the live stream
     is left out of it. If only Hyperliquid lists it, there is no tape, and it stays
     live-only with no history, which is the honest answer rather than a spliced one. */
  function plan(query: string, timeframe: string | number) {
    const targetSec = parseTimeframe(timeframe) ?? 60;
    const ref = catalog.resolve(query);
    const product = ref?.product ?? query.toUpperCase();

    if (targetSec < 60) {
      const tape = catalog.resolveOn(query, 'coinbase');
      if (tape !== null) {
        const base = planBase(tape, targetSec);
        const note =
          ref !== null && ref.provider !== 'coinbase'
            ? `seconds come from ${tape.product} on coinbase, the only venue here with a historical trade tape`
            : base.note;
        return { ref: tape, product: tape.product, fetchProduct: tape.product, targetSec, base: { ...base, note }, live: false };
      }
      const base = planBase(ref, targetSec);
      return {
        ref,
        product,
        fetchProduct: product,
        targetSec,
        base: { ...base, note: 'no historical trade tape for this market, so seconds start empty and fill from now' },
        live: true,
      };
    }

    const base = planBase(ref, targetSec);
    return { ref, product, fetchProduct: product, targetSec, base, live: false };
  }

  /* The render path. Synchronous, never throws, never waits on a venue. */
  function read(query: string, timeframe: string | number, bars: number): MarketRead {
    const plan_ = plan(query, timeframe);
    const { ref, product, fetchProduct, targetSec, base } = plan_;
    if (plan_.live) pumpLive(fetchProduct, base.baseSec);

    const held = store.read(fetchProduct, base.baseSec, targetSec, bars);
    const reached = coverageSec(held.candles, targetSec);

    // Say when the window could not be filled instead of drawing a short series as though
    // it were the whole story. Sub-minute history comes from paging a trade tape, and a
    // busy book only goes back so far before the page budget stops it.
    let note = base.note;
    if (base.provider === 'trades' && held.candles.length > 0 && reached < targetSec * bars * 0.9) {
      note = `seconds history reaches ${humanSpan(reached)}, which is as far back as the trade tape was paged`;
    }

    return {
      candles: held.candles,
      ref,
      product,
      timeframe: formatTimeframe(targetSec),
      granularitySec: targetSec,
      baseSec: base.baseSec,
      // Name the venue, not just the rail. A chart that says "trade tape" without saying
      // whose tape is one splice away from being wrong and nobody noticing.
      source:
        base.provider !== 'trades'
          ? base.provider
          : plan_.live
            ? 'hyperliquid live trades'
            : 'coinbase trades',
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
  async function warm(query: string, timeframe: string | number, bars: number): Promise<MarketRead> {
    const plan_ = plan(query, timeframe);
    if (plan_.live) pumpLive(plan_.fetchProduct, plan_.base.baseSec);
    await store.warm(plan_.fetchProduct, plan_.base.baseSec, plan_.targetSec, bars);
    return read(query, timeframe, bars);
  }

  return {
    read,
    warm,
    resolve: (query: string) => catalog.resolve(query),
    search: (query: string, limit?: number) => catalog.search(query, limit),
    refreshCatalog: () => catalog.refresh(),
    catalogLoadedAt: () => catalog.loadedAt(),
    all: () => catalog.all(),
    stats: () => store.stats(),
  };
}

export type MarketData = ReturnType<typeof createMarketData>;
