// Candle data sources: Coinbase Exchange (primary) and Kraken (fallback), unified
// behind CandleSource, plus cachedCandles which adds staleness fallback caching.
// Endpoint shapes verified 2026-08-11; see docs/superpowers/plans/2026-08-11-acc-v1-plan.md,
// Global Constraints and Task C. Binance is geo-blocked from this machine, never used.

import type { Candle, CandleSource } from './types.ts';

export type CandleService = {
  get(
    product: string,
    granularitySec: number,
    limit: number,
  ): Promise<{ candles: Candle[]; stale: boolean; source: string; fetchedAt: string }>;
  spot(product: string): Promise<number>;
};

type CoinbaseRow = [number, number, number, number, number, number]; // time,low,high,open,close,volume
type KrakenRow = [number, string, string, string, string, string, string, number]; // time,open,high,low,close,vwap,volume,count

export function coinbaseSource(deps?: { fetchImpl?: typeof fetch }): CandleSource {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  async function candles(product: string, granularitySec: number, limit: number): Promise<Candle[]> {
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularitySec}`;
    const res = await fetchImpl(url);
    if (!res.ok) {
      throw new Error(`coinbase candles failed: ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as CoinbaseRow[];
    const newestFirst = rows.slice(0, limit);
    const out: Candle[] = newestFirst.map(([t, low, high, open, close, volume]) => ({
      t,
      o: open,
      h: high,
      l: low,
      c: close,
      v: volume,
    }));
    out.reverse(); // coinbase returns newest first; CandleSource contract is oldest first
    return out;
  }

  async function spot(product: string): Promise<number> {
    const recent = await candles(product, 60, 1);
    const last = recent[recent.length - 1];
    if (!last) throw new Error(`coinbase spot: no candle data for ${product}`);
    return last.c;
  }

  return { name: 'coinbase', candles, spot };
}

// BTC-USD -> XBTUSD, otherwise plain concatenation (NEAR-USD -> NEARUSD).
function krakenPair(product: string): string {
  const [base, quote] = product.split('-');
  const krakenBase = base === 'BTC' ? 'XBT' : base;
  return `${krakenBase}${quote}`;
}

export function krakenSource(deps?: { fetchImpl?: typeof fetch }): CandleSource {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  async function candles(product: string, granularitySec: number, limit: number): Promise<Candle[]> {
    const pair = krakenPair(product);
    const intervalMin = Math.max(1, Math.round(granularitySec / 60));
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMin}`;
    const res = await fetchImpl(url);
    if (!res.ok) {
      throw new Error(`kraken candles failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { error?: string[]; result?: Record<string, unknown> };
    if (data.error && data.error.length > 0) {
      throw new Error(data.error.join('; '));
    }
    const result = data.result ?? {};
    // Kraken sometimes keys the result by a prefixed pair name (e.g. XXBTZUSD) rather
    // than the requested pair; fall back to the one non-'last' key when it differs.
    const keys = Object.keys(result).filter((k) => k !== 'last');
    const rowsKey = keys.includes(pair) ? pair : keys[0];
    const rows = result[rowsKey] as KrakenRow[] | undefined;
    if (!rows) {
      throw new Error(`kraken candles: no data for pair ${pair}`);
    }
    const oldestFirst = rows.slice(-limit); // kraken already returns oldest first
    return oldestFirst.map(([t, open, high, low, close, , volume]) => ({
      t,
      o: Number(open),
      h: Number(high),
      l: Number(low),
      c: Number(close),
      v: Number(volume),
    }));
  }

  async function spot(product: string): Promise<number> {
    const recent = await candles(product, 60, 1);
    const last = recent[recent.length - 1];
    if (!last) throw new Error(`kraken spot: no candle data for ${product}`);
    return last.c;
  }

  return { name: 'kraken', candles, spot };
}

export function cachedCandles(primary: CandleSource, fallback: CandleSource): CandleService {
  const cache = new Map<string, { candles: Candle[]; source: string; fetchedAt: string }>();

  async function get(product: string, granularitySec: number, limit: number) {
    const key = `${product}:${granularitySec}:${limit}`;
    try {
      const candles = await primary.candles(product, granularitySec, limit);
      const fetchedAt = new Date().toISOString();
      cache.set(key, { candles, source: primary.name, fetchedAt });
      return { candles, stale: false, source: primary.name, fetchedAt };
    } catch (primaryErr) {
      try {
        const candles = await fallback.candles(product, granularitySec, limit);
        const fetchedAt = new Date().toISOString();
        cache.set(key, { candles, source: fallback.name, fetchedAt });
        return { candles, stale: false, source: fallback.name, fetchedAt };
      } catch (fallbackErr) {
        const cached = cache.get(key);
        if (cached) {
          return { candles: cached.candles, stale: true, source: cached.source, fetchedAt: cached.fetchedAt };
        }
        throw new Error(
          `candles unavailable: ${primary.name} failed (${(primaryErr as Error).message}); ` +
            `${fallback.name} failed (${(fallbackErr as Error).message})`,
        );
      }
    }
  }

  async function spot(product: string): Promise<number> {
    try {
      return await primary.spot(product);
    } catch (primaryErr) {
      try {
        return await fallback.spot(product);
      } catch (fallbackErr) {
        throw new Error(
          `spot unavailable: ${primary.name} failed (${(primaryErr as Error).message}); ` +
            `${fallback.name} failed (${(fallbackErr as Error).message})`,
        );
      }
    }
  }

  return { get, spot };
}
