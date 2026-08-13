// What turns "pull up xyz" into a product a venue recognises.
//
// The chart used to offer seven products, because config.json listed seven. Anything else
// was unreachable: an agent asking for WIF or PENGU got nothing, and asking for "bitcoin"
// got nothing either, because the venue calls it BTC. That is a small hardcoded list
// standing in for a market of thousands.
//
// So the venues are asked what they list, once, and the answer is cached. Hyperliquid is
// preferred when it lists the coin, because the rest of this app trades there and a chart
// that disagrees with the venue you execute on is worse than no chart. Coinbase covers the
// spot pairs Hyperliquid has no perp for.
//
// Resolution is deliberately forgiving on the way in and exact on the way out: a person
// types "btc", "Bitcoin", "BTC-USD" or "btcusd" and means one thing, and the chart should
// not make them learn a venue's naming scheme. What it will not do is guess between two
// real candidates: an ambiguous query comes back as a list, so the agent asks rather than
// charting the wrong asset.

import fs from 'node:fs';
import path from 'node:path';

export type Provider = 'hyperliquid' | 'coinbase';

export type MarketRef = {
  // The id this app uses everywhere else, always BASE-QUOTE.
  product: string;
  provider: Provider;
  symbol: string;
  quote: string;
  // 'perp' or 'spot', so the chart can say which one it is drawing.
  kind: 'perp' | 'spot';
};

export type Catalog = {
  refresh(): Promise<void>;
  resolve(query: string): MarketRef | null;
  search(query: string, limit?: number): MarketRef[];
  all(): MarketRef[];
  loadedAt(): string | null;
};

// Common names for the same asset. Small on purpose: this is for the handful of coins a
// person calls by their full name, not a translation layer for every listing.
const ALIASES: Readonly<Record<string, string>> = {
  BITCOIN: 'BTC',
  XBT: 'BTC',
  ETHER: 'ETH',
  ETHEREUM: 'ETH',
  SOLANA: 'SOL',
  DOGECOIN: 'DOGE',
  RIPPLE: 'XRP',
  CARDANO: 'ADA',
  AVALANCHE: 'AVAX',
  POLKADOT: 'DOT',
  CHAINLINK: 'LINK',
  LITECOIN: 'LTC',
  POLYGON: 'MATIC',
  ARBITRUM: 'ARB',
  OPTIMISM: 'OP',
  HYPERLIQUID: 'HYPE',
  NEAR: 'NEAR',
};

// Quotes worth carrying. USD leads because everything else in this app prices in it, but
// dropping the rest would put back exactly the kind of arbitrary ceiling this module exists
// to remove.
const QUOTES = new Set(['USD', 'USDC', 'USDT', 'EUR', 'GBP']);

type HlMeta = { universe: { name: string; isDelisted?: boolean }[] };
type CoinbaseProduct = {
  id: string;
  base_currency: string;
  quote_currency: string;
  status: string;
  trading_disabled?: boolean;
};

/* Strip a query down to the shape the tables are keyed by.
   "btc-usd", "BTC/USD", "btcusd" and " btc " all land on BTC. */
export function normalizeQuery(query: string): { symbol: string; quote: string | null } {
  const raw = String(query ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (raw === '') return { symbol: '', quote: null };

  const split = /^([A-Z0-9]+)[-/_:]([A-Z]+)$/.exec(raw);
  if (split) {
    const base = split[1] as string;
    return { symbol: ALIASES[base] ?? base, quote: split[2] as string };
  }

  // A bare "BTCUSD" or "BTCUSDT": peel a known quote off the end.
  const glued = /^([A-Z0-9]{2,})(USDT|USDC|USD|EUR|GBP|BTC|ETH)$/.exec(raw);
  if (glued && (glued[1] as string).length >= 2) {
    const base = glued[1] as string;
    return { symbol: ALIASES[base] ?? base, quote: glued[2] as string };
  }

  return { symbol: ALIASES[raw] ?? raw, quote: null };
}

export function createCatalog(options?: {
  fetchImpl?: typeof fetch;
  cachePath?: string;
  // How long a cached listing is trusted before the venues are asked again.
  maxAgeMs?: number;
  now?: () => number;
}): Catalog {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const cachePath = options?.cachePath;
  const maxAgeMs = options?.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = options?.now ?? (() => Date.now());

  let refs: MarketRef[] = [];
  let bySymbol = new Map<string, MarketRef[]>();
  let loadedAtMs = 0;

  function index(next: MarketRef[]): void {
    refs = next;
    bySymbol = new Map();
    for (const ref of next) {
      const held = bySymbol.get(ref.symbol);
      if (held === undefined) bySymbol.set(ref.symbol, [ref]);
      else held.push(ref);
    }
  }

  function readCache(): boolean {
    if (cachePath === undefined) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { at: number; refs: MarketRef[] };
      if (!Array.isArray(raw.refs) || raw.refs.length === 0) return false;
      if (now() - raw.at > maxAgeMs) return false;
      loadedAtMs = raw.at;
      index(raw.refs);
      return true;
    } catch {
      return false;
    }
  }

  function writeCache(): void {
    if (cachePath === undefined) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ at: loadedAtMs, refs }), 'utf8');
    } catch {
      // A listing that cannot be cached still works, it just costs a fetch next start.
    }
  }

  async function hyperliquid(): Promise<MarketRef[]> {
    const res = await fetchImpl('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    });
    if (!res.ok) throw new Error(`hyperliquid meta failed: ${res.status}`);
    const body = (await res.json()) as HlMeta;
    if (!Array.isArray(body?.universe)) throw new Error('hyperliquid meta: unexpected body');

    return body.universe
      .filter((asset) => asset.isDelisted !== true && typeof asset.name === 'string')
      .map((asset) => ({
        product: `${asset.name.toUpperCase()}-USD`,
        provider: 'hyperliquid' as const,
        symbol: asset.name.toUpperCase(),
        quote: 'USD',
        kind: 'perp' as const,
      }));
  }

  async function coinbase(): Promise<MarketRef[]> {
    const res = await fetchImpl('https://api.exchange.coinbase.com/products');
    if (!res.ok) throw new Error(`coinbase products failed: ${res.status}`);
    const body = (await res.json()) as CoinbaseProduct[];
    if (!Array.isArray(body)) throw new Error('coinbase products: unexpected body');

    return body
      .filter((p) => p.status === 'online' && p.trading_disabled !== true)
      .filter((p) => QUOTES.has(p.quote_currency))
      .map((p) => ({
        product: `${p.base_currency.toUpperCase()}-${p.quote_currency.toUpperCase()}`,
        provider: 'coinbase' as const,
        symbol: p.base_currency.toUpperCase(),
        quote: p.quote_currency.toUpperCase(),
        kind: 'spot' as const,
      }));
  }

  async function refresh(): Promise<void> {
    // One venue being down is not a reason to have no catalogue at all.
    const [hl, cb] = await Promise.allSettled([hyperliquid(), coinbase()]);
    const next: MarketRef[] = [];
    if (hl.status === 'fulfilled') next.push(...hl.value);
    if (cb.status === 'fulfilled') next.push(...cb.value);

    if (next.length === 0) {
      if (refs.length > 0) return; // keep whatever is already loaded
      const why = [hl, cb]
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => String(r.reason))
        .join('; ');
      throw new Error(`no market catalogue available: ${why}`);
    }

    loadedAtMs = now();
    index(next);
    writeCache();
  }

  /* Hyperliquid first when both list the coin: that is where this app executes.
     An explicit quote wins over that preference, because someone who typed BTC-EUR asked
     for euros and should not be handed dollars. With no quote given, USD is the default
     this app prices everything else in. */
  function pick(candidates: MarketRef[], quote: string | null): MarketRef | null {
    if (candidates.length === 0) return null;

    if (quote !== null) {
      const exact = candidates.filter((c) => c.quote === quote);
      if (exact.length > 0) {
        return exact.find((c) => c.provider === 'hyperliquid') ?? (exact[0] as MarketRef);
      }
    }

    const usd = candidates.filter((c) => c.quote === 'USD');
    const pool = usd.length > 0 ? usd : candidates;
    return pool.find((c) => c.provider === 'hyperliquid') ?? (pool[0] as MarketRef);
  }

  function resolve(query: string): MarketRef | null {
    const { symbol, quote } = normalizeQuery(query);
    if (symbol === '') return null;
    return pick(bySymbol.get(symbol) ?? [], quote);
  }

  /* Ranked candidates for a query that did not resolve cleanly, so an agent can offer a
     choice instead of charting the wrong asset. */
  function search(query: string, limit = 8): MarketRef[] {
    const { symbol } = normalizeQuery(query);
    if (symbol === '') return [];

    const scored: { ref: MarketRef; score: number }[] = [];
    for (const ref of refs) {
      let score = 0;
      if (ref.symbol === symbol) score = 100;
      else if (ref.symbol.startsWith(symbol)) score = 60 - ref.symbol.length;
      else if (ref.symbol.includes(symbol)) score = 30 - ref.symbol.length;
      else continue;
      if (ref.provider === 'hyperliquid') score += 5;
      scored.push({ ref, score });
    }

    scored.sort((a, b) => b.score - a.score || a.ref.symbol.localeCompare(b.ref.symbol));

    // One row per product id. Both venues list BTC-USD, and offering it twice reads as a
    // choice when it is not one: resolve() would pick the same row either way.
    const seen = new Set<string>();
    const unique: MarketRef[] = [];
    for (const { ref } of scored) {
      if (seen.has(ref.product)) continue;
      seen.add(ref.product);
      unique.push(ref);
      if (unique.length >= limit) break;
    }
    return unique;
  }

  if (!readCache()) {
    // Left to the caller to await. A cold catalogue still resolves once refresh lands.
  }

  return {
    refresh,
    resolve,
    search,
    all: () => refs.slice(),
    loadedAt: () => (loadedAtMs === 0 ? null : new Date(loadedAtMs).toISOString()),
  };
}
