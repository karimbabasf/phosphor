// Hyperliquid market data. Phosphor charts what Hyperliquid charts, because that is
// where the high-frequency execution goes and a chart that disagrees with the venue
// is worse than no chart.
//
// Two rails, because the exchange has no sub-minute candle:
//   >= 1m : POST /info candleSnapshot, using the native interval enum
//   <  1m : built here, by bucketing the live trades websocket into seconds
//
// Verified live 2026-08-11: candleSnapshot rejects "1s" and "5s" with HTTP 422
// ("Failed to deserialize the JSON body into the target type"), so second candles
// cannot come from the REST rail at any price. There is also no public market-wide
// historical trades endpoint, so sub-minute history starts empty and fills from the
// moment we subscribe. The UI says so rather than pretending the gap is data.

import type { Candle, CandleSource } from './types.ts';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';

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

export const SUB_MINUTE_SECONDS = [1, 5, 15, 30] as const;

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

type HlTrade = { coin: string; px: string; sz: string; time: number; side: string };

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

// ---------- live rail: seconds built from the trade stream ----------

export type LiveCandles = {
  // Ask for a coin to be streamed. Idempotent; switching coins drops the old subscription.
  watch(product: string): void;
  // Second-resolution candles for the watched coin, oldest first, gaps carried forward.
  seconds(product: string, granularitySec: number, limit: number): Candle[];
  // How long we have been collecting for this coin, in seconds. 0 means nothing yet.
  collectedSec(product: string): number;
  connected(): boolean;
  onUpdate(fn: () => void): void;
  stop(): void;
};

export function hyperliquidLive(deps?: { wsUrl?: string; maxSeconds?: number }): LiveCandles {
  const wsUrl = deps?.wsUrl ?? WS_URL;
  // 3600 one-second buckets is an hour of history per coin, which covers any
  // sub-minute window the chart can show while staying small in memory.
  const maxSeconds = deps?.maxSeconds ?? 3600;

  // coin -> second-epoch -> bucket
  const books = new Map<string, Map<number, Candle>>();
  const startedAt = new Map<string, number>();
  const listeners: Array<() => void> = [];
  let socket: WebSocket | null = null;
  let current: string | null = null;
  let closed = false;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;

  function notify(): void {
    // Coalesce: a busy coin fires many trades per second and every listener
    // hop costs an SSE write to every browser.
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const fn of listeners) fn();
    }, 100);
  }

  function bookFor(coin: string): Map<number, Candle> {
    let book = books.get(coin);
    if (!book) {
      book = new Map();
      books.set(coin, book);
      startedAt.set(coin, Math.floor(Date.now() / 1000));
    }
    return book;
  }

  function ingest(trade: HlTrade): void {
    const coin = trade.coin.toUpperCase();
    const book = bookFor(coin);
    const sec = Math.floor(trade.time / 1000);
    const px = Number(trade.px);
    const sz = Number(trade.sz);
    if (!Number.isFinite(px)) return;
    const bucket = book.get(sec);
    if (bucket) {
      bucket.h = Math.max(bucket.h, px);
      bucket.l = Math.min(bucket.l, px);
      bucket.c = px;
      bucket.v += Number.isFinite(sz) ? sz : 0;
    } else {
      book.set(sec, { t: sec, o: px, h: px, l: px, c: px, v: Number.isFinite(sz) ? sz : 0 });
    }
    if (book.size > maxSeconds * 2) {
      const cutoff = Math.floor(Date.now() / 1000) - maxSeconds;
      for (const key of book.keys()) {
        if (key < cutoff) book.delete(key);
      }
    }
    notify();
  }

  function connect(): void {
    if (closed || !current) return;
    const coin = current;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
      notify();
    };
    ws.onmessage = (ev: MessageEvent) => {
      let msg: { channel?: string; data?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.channel === 'trades' && Array.isArray(msg.data)) {
        for (const t of msg.data as HlTrade[]) ingest(t);
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* close() on an already-dead socket is not worth reporting */
      }
    };
  }

  function scheduleRetry(): void {
    if (closed || retryTimer) return;
    // 1s, 2s, 4s, 8s, capped at 15s. The chart shows the disconnect meanwhile.
    const delay = Math.min(15000, 1000 * 2 ** retry);
    retry++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
    notify();
  }

  function watch(product: string): void {
    const coin = coinOf(product);
    if (coin === current && socket) return;
    current = coin;
    bookFor(coin);
    if (socket) {
      try {
        socket.close();
      } catch {
        /* replaced below regardless */
      }
      socket = null;
    }
    connect();
  }

  // Roll the 1s book up into the requested step, carrying the last close across
  // seconds with no trade. A second with no trade is a real flat candle, not a hole.
  function seconds(product: string, granularitySec: number, limit: number): Candle[] {
    const coin = coinOf(product);
    const book = books.get(coin);
    if (!book || book.size === 0) return [];
    const step = Math.max(1, Math.floor(granularitySec));
    const keys = [...book.keys()].sort((a, b) => a - b);
    const firstSec = keys[0];
    const nowSec = Math.floor(Date.now() / 1000);

    const out: Candle[] = [];
    let carry = book.get(firstSec)!.o;
    const firstSlot = Math.floor(firstSec / step) * step;
    for (let slot = firstSlot; slot <= nowSec; slot += step) {
      let o: number | null = null;
      let h = -Infinity;
      let l = Infinity;
      let c: number | null = null;
      let v = 0;
      for (let s = slot; s < slot + step; s++) {
        const b = book.get(s);
        if (!b) continue;
        if (o === null) o = b.o;
        h = Math.max(h, b.h);
        l = Math.min(l, b.l);
        c = b.c;
        v += b.v;
      }
      if (o === null) {
        // No trade in the whole slot: a flat doji at the carried close.
        out.push({ t: slot, o: carry, h: carry, l: carry, c: carry, v: 0 });
      } else {
        out.push({ t: slot, o, h, l, c: c as number, v });
        carry = c as number;
      }
    }
    return out.slice(-limit);
  }

  function collectedSec(product: string): number {
    const began = startedAt.get(coinOf(product));
    if (began === undefined) return 0;
    return Math.max(0, Math.floor(Date.now() / 1000) - began);
  }

  function connected(): boolean {
    return socket !== null && socket.readyState === 1;
  }

  function onUpdate(fn: () => void): void {
    listeners.push(fn);
  }

  function stop(): void {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (notifyTimer) clearTimeout(notifyTimer);
    retryTimer = null;
    notifyTimer = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* shutting down anyway */
      }
    }
    socket = null;
  }

  return { watch, seconds, collectedSec, connected, onUpdate, stop };
}
