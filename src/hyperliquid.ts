// Hyperliquid market data. Phosphor charts what Hyperliquid charts, because that is
// where the high-frequency execution goes and a chart that disagrees with the venue
// is worse than no chart.
//
// One rail: POST /info candleSnapshot, using the native interval enum, one minute and up.
//
// There used to be a second rail that bucketed the live trades websocket into seconds,
// because candleSnapshot rejects "1s" and "5s" with an HTTP 422 and there is no public
// historical trades endpoint here. It was removed 2026-08-13 along with every sub-minute
// timeframe: a second candle could only be assembled from a venue other than the one it
// named, and a spliced line is worse than no line.

import type { Candle, CandleSource } from './types.ts';

const INFO_URL = 'https://api.hyperliquid.xyz/info';

// Hyperliquid's interval enum, as seconds -> label. Anything under 60s is ours to build.
const NATIVE_INTERVALS: ReadonlyArray<readonly [number, string]> = [
  [60, '1m'],
  [180, '3m'],
  [300, '5m'],
  [900, '15m'],
  [1800, '30m'],
  [3600, '1h'],
  [7200, '2h'],
  [14400, '4h'],
  [28800, '8h'],
  [43200, '12h'],
  [86400, '1d'],
  [259200, '3d'],
  [604800, '1w'],
];

type HlCandle = {
  t: number; // open time, ms
  T: number; // close time, ms
  s: string; // coin
  i: string; // interval label
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
};

// 'BTC-USD' -> 'BTC'. Hyperliquid names perps by base asset alone.
export function coinOf(product: string): string {
  return product.split('-')[0].toUpperCase();
}

export function nativeInterval(granularitySec: number): string | null {
  for (const [secs, label] of NATIVE_INTERVALS) {
    if (secs === granularitySec) return label;
  }
  return null;
}

// Nearest native interval at or below the request, so an odd granularity still charts.
function nearestNative(granularitySec: number): [number, string] {
  let best = NATIVE_INTERVALS[0];
  for (const entry of NATIVE_INTERVALS) {
    if (entry[0] <= granularitySec) best = entry;
  }
  return [best[0], best[1]];
}

export function hyperliquidSource(deps?: { fetchImpl?: typeof fetch }): CandleSource {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  async function candles(product: string, granularitySec: number, limit: number): Promise<Candle[]> {
    const coin = coinOf(product);
    const [stepSec, interval] = nativeInterval(granularitySec)
      ? [granularitySec, nativeInterval(granularitySec) as string]
      : nearestNative(Math.max(60, granularitySec));

    const endTime = Date.now();
    // Ask for a margin over the window so thin books still return `limit` candles.
    const startTime = endTime - stepSec * 1000 * Math.max(limit * 2, limit + 10);

    const res = await fetchImpl(INFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }),
    });
    if (!res.ok) {
      throw new Error(`hyperliquid candles failed: ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as HlCandle[];
    if (!Array.isArray(rows)) throw new Error('hyperliquid candles: unexpected body');
    // Already oldest-first, which is the CandleSource contract.
    return rows.slice(-limit).map((r) => ({
      t: Math.floor(r.t / 1000),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      v: Number(r.v),
    }));
  }

  async function spot(product: string): Promise<number> {
    const res = await fetchImpl(INFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    });
    if (!res.ok) throw new Error(`hyperliquid spot failed: ${res.status}`);
    const mids = (await res.json()) as Record<string, string>;
    const mid = mids[coinOf(product)];
    if (mid === undefined) throw new Error(`hyperliquid spot: no mid for ${product}`);
    return Number(mid);
  }

  return { name: 'hyperliquid', candles, spot };
}
