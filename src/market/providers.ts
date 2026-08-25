// Where candles come from, and how a request for one timeframe becomes a request a venue
// will actually answer.
//
// Two rails, picked by which venue lists the market rather than by a config flag:
//
//   a Hyperliquid listing : candleSnapshot, which serves deep history in one call
//   a Coinbase-only pair  : the candles endpoint, paged backward
//
// There is no sub-minute rail. No venue serves a candle under a minute, so one had to be
// assembled from a trade tape, and the tape and the live stream were different venues,
// which spliced two markets into one line. Removed 2026-08-13, floor is one minute.
//
// The paging matters for Coinbase and not for Hyperliquid, which is worth writing down
// because it is not obvious. Measured 2026-08-13: Hyperliquid returns two thousand 1m bars
// in a single call and five and a half years of daily bars. Coinbase caps a response around
// three hundred and fifty rows and ignores a larger limit, so the only way to reach further
// back is to walk the window backward with start and end. The old code never did, which put
// a hard ceiling on Coinbase history that nothing in the app admitted to.

import type { Candle } from '../types.ts';
import type { Catalog, MarketRef } from './catalog.ts';
import { chooseBase } from './aggregate.ts';

// What each venue will answer to natively. Anything else is folded from one of these.
export const HYPERLIQUID_NATIVES = [60, 180, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 43_200, 86_400, 259_200, 604_800];
export const COINBASE_NATIVES = [60, 300, 900, 3600, 21_600, 86_400];

const COINBASE_MAX_ROWS = 300;

// A minute is the floor. See the note on MIN_TIMEFRAME_SEC in src/chart.ts.
const MIN_BASE_SEC = 60;

export type BasePlan = {
  baseSec: number;
  provider: MarketRef['provider'];
  ref: MarketRef | null;
  // Set when the ask could not be served exactly and something close was used instead.
  note: string | null;
};

/* Decide what to actually fetch for a requested timeframe.
   Returns the base interval and the venue, leaving the folding to the store. */
export function planBase(ref: MarketRef | null, targetSec: number): BasePlan {
  // Belt and braces: the chart refuses anything under a minute before it reaches here.
  const wanted = Math.max(MIN_BASE_SEC, targetSec);

  const natives = ref?.provider === 'coinbase' ? COINBASE_NATIVES : HYPERLIQUID_NATIVES;
  const base = chooseBase(wanted, natives) ?? MIN_BASE_SEC;

  const note = wanted % base === 0 ? null : `${wanted}s does not divide evenly by ${base}s, buckets may straddle`;
  return { baseSec: base, provider: ref?.provider ?? 'hyperliquid', ref, note };
}

/* Walk a window backward until the bar count is met or the venue stops giving new bars.
   The two stop conditions that are not the bar count: a page that returns nothing, and a
   page whose oldest bar is not older than the last one seen, which is how a venue says it
   has no more history without saying so. */
export async function pageBackward(
  fetchRange: (startSec: number, endSec: number) => Promise<Candle[]>,
  opts: { baseSec: number; bars: number; maxRowsPerCall: number; nowSec: number; maxPages?: number },
): Promise<Candle[]> {
  const { baseSec, bars, maxRowsPerCall, nowSec } = opts;
  const maxPages = opts.maxPages ?? 12;

  const held = new Map<number, Candle>();
  let endSec = nowSec;
  let oldestSeen = Infinity;

  for (let page = 0; page < maxPages && held.size < bars; page++) {
    const span = maxRowsPerCall * baseSec;
    const startSec = endSec - span;

    const rows = await fetchRange(startSec, endSec);
    if (rows.length === 0) break;

    let pageOldest = Infinity;
    for (const row of rows) {
      held.set(row.t, row);
      if (row.t < pageOldest) pageOldest = row.t;
    }
    if (!Number.isFinite(pageOldest) || pageOldest >= oldestSeen) break;

    oldestSeen = pageOldest;
    endSec = pageOldest - baseSec;
  }

  const out = [...held.values()].sort((a, b) => a.t - b.t);
  return out.length > bars ? out.slice(-bars) : out;
}

export type ProviderDeps = {
  catalog: Catalog;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function createProviders(deps: ProviderDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  async function hyperliquidRange(coin: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
    const res = await fetchImpl('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: startMs, endTime: endMs } }),
    });
    if (!res.ok) throw new Error(`hyperliquid candles failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as { t: number; o: string; h: string; l: string; c: string; v: string }[];
    if (!Array.isArray(rows)) throw new Error('hyperliquid candles: unexpected body');
    return rows.map((r) => ({
      t: Math.floor(r.t / 1000),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      v: Number(r.v),
    }));
  }

  async function coinbaseRange(product: string, baseSec: number, startSec: number, endSec: number): Promise<Candle[]> {
    const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles`);
    url.searchParams.set('granularity', String(baseSec));
    url.searchParams.set('start', new Date(startSec * 1000).toISOString());
    url.searchParams.set('end', new Date(endSec * 1000).toISOString());

    const res = await fetchImpl(url.toString());
    if (!res.ok) throw new Error(`coinbase candles failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as [number, number, number, number, number, number][];
    if (!Array.isArray(rows)) throw new Error('coinbase candles: unexpected body');
    // Coinbase orders newest first and packs as time,low,high,open,close,volume.
    return rows
      .map(([t, low, high, open, close, volume]) => ({ t, o: open, h: high, l: low, c: close, v: volume }))
      .sort((a, b) => a.t - b.t);
  }

  /* Hyperliquid's own spelling, which is not the same as the obvious one. A week is "1w"
     in its enum and never "7d": asking for 7d gets an empty array rather than an error,
     which is how this shipped as a blank weekly chart the first time. */
  const intervalLabel = (sec: number): string => {
    if (sec === 604_800) return '1w';
    if (sec % 86_400 === 0) return `${sec / 86_400}d`;
    if (sec % 3600 === 0) return `${sec / 3600}h`;
    return `${sec / 60}m`;
  };

  /* The one function the store calls. Everything above is the routing behind it.
     `provider` is the venue the store keyed this series under, so the routing here has to
     agree with it exactly: resolving the product freely and landing somewhere else would
     write one venue's bars under another venue's key, which is the splice the store's own
     keyOf comment exists to prevent. */
  async function fetchWindow(product: string, baseSec: number, bars: number, provider: string): Promise<Candle[]> {
    const nowSec = Math.floor(now() / 1000);
    const ref =
      provider === 'coinbase' || provider === 'hyperliquid'
        ? deps.catalog.resolveOn(product, provider)
        : deps.catalog.resolve(product);

    if (provider === 'coinbase' && ref === null) {
      throw new Error(`coinbase does not list ${product}`);
    }

    if (ref === null || ref.provider === 'hyperliquid') {
      const coin = product.split('-')[0]?.toUpperCase() ?? product;
      const interval = intervalLabel(baseSec);
      // Hyperliquid answers a wide window in one call, so ask for the whole thing and
      // only page if it comes up short.
      return pageBackward(
        (startSec, endSec) => hyperliquidRange(coin, interval, startSec * 1000, endSec * 1000),
        { baseSec, bars, maxRowsPerCall: Math.max(bars, 500), nowSec, maxPages: 4 },
      );
    }

    return pageBackward((startSec, endSec) => coinbaseRange(ref.product, baseSec, startSec, endSec), {
      baseSec,
      bars,
      maxRowsPerCall: COINBASE_MAX_ROWS,
      nowSec,
    });
  }

  return { fetchWindow, planBase };
}
