// The live rail: the price on screen moves because a venue pushed it, not because a timer
// went off.
//
// Measured 2026-09-01, before this file existed: the painted close was 4.0 s old at p50 and
// 5.6 s at p90, and network latency contributed none of it. Three poll throttles sat in
// series (the cache's staleness gate, the server's push timer, the browser's refetch floor)
// with no push rail anywhere between the venue and the canvas, and polls compose by addition.
// Cutting the constants bought about three seconds. This file is what buys the rest.
//
// Two venues, chosen by measurement rather than preference:
//
//   HYPERLIQUID  the `candle` channel. It pushes the forming 1m bar with o/h/l/c/v already
//                assembled, every 421 ms at p50, and within 24 ms of the trade that moved it.
//                So there is no trade bucketing to write and no chance of the splice bug that
//                killed the last live rail: history and the live bar come from one venue on
//                one interval.
//   COINBASE     the Exchange `matches` tape, 5.7 msgs/sec at 38 ms p50, the lowest lag
//                measured anywhere. Folded into the minute here, because Coinbase has no
//                candle channel on the same host that serves this repo's history, and mixing
//                hosts is how the splice class of bug gets back in.
//
// Three properties cost real money when they are wrong:
//
//   ONE MINUTE   the base interval is always 60 s and nothing here may change that. Every
//                other timeframe folds from it (src/market/aggregate.ts), and no venue serves
//                a candle under a minute, so a sub-minute rail would have to be assembled from
//                one venue's tape and drawn over another venue's history. That was removed on
//                2026-08-13 and is not coming back through this door.
//   ONE VENUE    a subscription is keyed provider AND product, and the candle it produces is
//                put under the same key. The store's keyOf comment says why: one venue's bars
//                under another venue's key is a price that is simply wrong in a way that looks
//                like a real move.
//   SEEDING      Coinbase attaches mid-minute. A bar opened at the first trade this process
//                happened to see is not the minute's open, and store.put lets the incoming
//                copy win, so an unseeded fold REPLACES a correct REST bar with a wrong one.
//                Every fold reconciles against the cached bar for the same minute.
//
// The socket seam mirrors FeedSocket in src/trade/feed-ws.ts: same shape, kept local rather
// than imported so the market layer does not depend on the trading layer. It exists so the
// tests drive connect, message, close and reconnect with no network at all.

import type { Candle } from '../types.ts';

export type LiveProvider = 'hyperliquid' | 'coinbase';

export type LiveRef = { product: string; provider: LiveProvider };

export type LiveSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err?: unknown) => void) | null;
};

export type VenueStatus = {
  provider: LiveProvider;
  connected: boolean;
  since: string | null;
  lastMessageMs: number | null;
  reconnects: number;
  lastError: string | null;
  products: string[];
};

// The only interval this rail carries. See the ONE MINUTE note above.
export const LIVE_BASE_SEC = 60;

const OPEN = 1;
// Hyperliquid cuts a connection it has not sent to in 60 s. A candle subscription on a quiet
// coin idles for whole minutes, so the ping is not optional here the way it was for a trades
// subscription on a busy one.
const PING_MS = 30_000;
const RETRY_CAP_MS = 15_000;
// A socket that never opens never fires onclose either, so backoff alone cannot recover from
// a hung connect. This is the timeout that makes the retry chain reachable.
const OPEN_TIMEOUT_MS = 10_000;

const VENUE_URL: Readonly<Record<LiveProvider, string>> = {
  hyperliquid: 'wss://api.hyperliquid.xyz/ws',
  coinbase: 'wss://ws-feed.exchange.coinbase.com',
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* Every number on both venues arrives as a string. An unreadable one is null and never 0:
   a volume of 0 printed as a fact is a lie about the market, and a price of 0 would redraw
   the whole axis. The empty-string check is the one that matters and is easy to leave out:
   Number('') is 0, and it is finite, so a venue sending an empty field would otherwise open
   the bar at zero and take the low of the whole chart with it. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/* The default socket, wrapped rather than passed through, so the seam stays free of the
   runtime's event objects. Same shape as feed-ws.ts's nativeSocket, and for the same reason. */
function nativeSocket(url: string): LiveSocket {
  const ws = new WebSocket(url);
  const sock: LiveSocket = {
    get readyState(): number {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => sock.onopen?.();
  ws.onmessage = (ev: MessageEvent) => sock.onmessage?.({ data: ev.data });
  ws.onclose = () => sock.onclose?.();
  ws.onerror = () => sock.onerror?.();
  return sock;
}

/* Hyperliquid names a perp by its coin; this app names every market BASE-QUOTE. */
export function coinOf(product: string): string {
  return (product.split('-')[0] ?? product).toUpperCase();
}

/* Map one row of the Hyperliquid candle channel. `t` is the bar's OPEN in milliseconds, which
   is worth saying out loud: reading it as a send time makes the feed look 44 s late at p50
   when it is 24 ms behind the tape. Returns null rather than a half-built bar, because a
   candle with one unreadable leg would draw a wick to nowhere. */
export function hyperliquidCandle(data: unknown): { coin: string; interval: string; candle: Candle } | null {
  if (!isRecord(data)) return null;
  const coin = typeof data.s === 'string' ? data.s.toUpperCase() : null;
  const interval = typeof data.i === 'string' ? data.i : null;
  const openMs = num(data.t);
  const o = num(data.o);
  const h = num(data.h);
  const l = num(data.l);
  const c = num(data.c);
  const v = num(data.v);
  if (coin === null || interval === null || openMs === null) return null;
  if (o === null || h === null || l === null || c === null || v === null) return null;
  return { coin, interval, candle: { t: Math.floor(openMs / 1000), o, h, l, c, v } };
}

/* Fold one trade into the minute it belongs to.
   `held` is what this process has accumulated, `cached` the newest bar the store holds for
   the same minute, which is the venue's own answer and therefore authoritative about the open.
   Volume takes the larger of the two: it only grows inside a bucket, so the larger figure is
   the one that saw more of it, and a message this process dropped cannot make the bar shrink. */
export function foldMatch(
  held: Candle | null,
  cached: Candle | null,
  tradeSec: number,
  price: number,
  size: number,
): Candle {
  const bucket = Math.floor(tradeSec / LIVE_BASE_SEC) * LIVE_BASE_SEC;
  const seed = cached !== null && cached.t === bucket ? cached : null;
  const base =
    held !== null && held.t === bucket
      ? { ...held }
      : seed !== null
        ? { ...seed }
        : { t: bucket, o: price, h: price, l: price, c: price, v: 0 };

  if (seed !== null) {
    base.o = seed.o;
    if (seed.h > base.h) base.h = seed.h;
    if (seed.l < base.l) base.l = seed.l;
    if (seed.v > base.v) base.v = seed.v;
  }

  if (price > base.h) base.h = price;
  if (price < base.l) base.l = price;
  base.c = price;
  base.v += size;
  return base;
}

function sameCandle(a: Candle | undefined, b: Candle): boolean {
  return a !== undefined && a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;
}

export type MarketLiveDeps = {
  // Where a folded bar goes. One call per changed bar, never for a repeat of the same one.
  onCandle: (product: string, baseSec: number, candle: Candle, provider: LiveProvider) => void;
  // The newest cached bar for a series, read without triggering a fetch. Coinbase needs it to
  // open its bucket at the minute's real open; Hyperliquid does not use it.
  seedBar?: (product: string, provider: LiveProvider) => Candle | null;
  // Test seam. The socket is the only thing here that cannot be reasoned about offline.
  wsImpl?: (url: string) => LiveSocket;
  urls?: Partial<Record<LiveProvider, string>>;
  now?: () => number;
};

type Venue = {
  provider: LiveProvider;
  url: string;
  socket: LiveSocket | null;
  // What the owners between them want subscribed, and what the current socket has been told.
  wanted: Set<string>;
  sent: Set<string>;
  retry: number;
  opens: number;
  reconnects: number;
  since: string | null;
  lastMessageMs: number | null;
  lastError: string | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  openTimer: ReturnType<typeof setTimeout> | null;
};

export function createMarketLive(deps: MarketLiveDeps) {
  const makeSocket = deps.wsImpl ?? nativeSocket;
  const now = deps.now ?? (() => Date.now());
  const seedBar = deps.seedBar ?? (() => null);

  // owner -> what that owner wants. The chart and the trading window both watch markets and
  // neither knows about the other, so the union is the subscription set and a refcount that
  // could leak is never written.
  const owners = new Map<string, LiveRef[]>();
  const venues = new Map<LiveProvider, Venue>();
  // provider:product -> when a live bar last arrived, and the last one emitted.
  const lastLiveAt = new Map<string, number>();
  const lastEmitted = new Map<string, Candle>();
  // Coinbase's forming bucket, per product. Hyperliquid keeps none: the channel is the bar.
  const folding = new Map<string, Candle>();
  let stopped = false;

  function keyOf(product: string, provider: LiveProvider): string {
    return `${provider}:${product}`;
  }

  function venueOf(provider: LiveProvider): Venue {
    const held = venues.get(provider);
    if (held !== undefined) return held;
    const made: Venue = {
      provider,
      url: deps.urls?.[provider] ?? VENUE_URL[provider],
      socket: null,
      wanted: new Set(),
      sent: new Set(),
      retry: 0,
      opens: 0,
      reconnects: 0,
      since: null,
      lastMessageMs: null,
      lastError: null,
      retryTimer: null,
      pingTimer: null,
      openTimer: null,
    };
    venues.set(provider, made);
    return made;
  }

  // ---------- sending ----------

  function send(venue: Venue, msg: unknown): void {
    const sock = venue.socket;
    if (sock === null || sock.readyState !== OPEN) return;
    try {
      sock.send(JSON.stringify(msg));
    } catch (err) {
      venue.lastError = errText(err);
    }
  }

  function subscribeMsg(provider: LiveProvider, product: string, on: boolean): unknown {
    if (provider === 'hyperliquid') {
      return {
        method: on ? 'subscribe' : 'unsubscribe',
        subscription: { type: 'candle', coin: coinOf(product), interval: '1m' },
      };
    }
    // The heartbeat channel rides along on purpose. A quiet product's matches channel can idle
    // past the venue's cut, and a heartbeat every second is both the keepalive and proof the
    // socket is carrying this product rather than merely being open.
    return {
      type: on ? 'subscribe' : 'unsubscribe',
      product_ids: [product],
      channels: ['matches', 'heartbeat'],
    };
  }

  function syncSubscriptions(venue: Venue): void {
    const sock = venue.socket;
    if (sock === null || sock.readyState !== OPEN) return;
    for (const product of venue.wanted) {
      if (venue.sent.has(product)) continue;
      send(venue, subscribeMsg(venue.provider, product, true));
      venue.sent.add(product);
    }
    for (const product of [...venue.sent]) {
      if (venue.wanted.has(product)) continue;
      send(venue, subscribeMsg(venue.provider, product, false));
      venue.sent.delete(product);
      folding.delete(product);
    }
  }

  // ---------- connection ----------

  function connect(venue: Venue): void {
    if (stopped || venue.socket !== null || venue.wanted.size === 0) return;
    let sock: LiveSocket;
    try {
      sock = makeSocket(venue.url);
    } catch (err) {
      venue.lastError = errText(err);
      scheduleRetry(venue);
      return;
    }
    venue.socket = sock;
    venue.sent.clear();

    // A connect that hangs holds the venue open forever with no price and no complaint.
    venue.openTimer = setTimeout(() => {
      venue.openTimer = null;
      if (venue.socket !== sock || sock.readyState === OPEN) return;
      venue.lastError = 'connect timed out';
      try {
        sock.close();
      } catch {
        /* closing a socket that never opened is not worth reporting */
      }
      if (venue.socket === sock) {
        venue.socket = null;
        scheduleRetry(venue);
      }
    }, OPEN_TIMEOUT_MS);
    venue.openTimer.unref?.();

    sock.onopen = () => {
      if (venue.socket !== sock) return;
      clearOpenTimer(venue);
      venue.opens += 1;
      if (venue.opens > 1) venue.reconnects += 1;
      venue.since = new Date(now()).toISOString();
      // Errors live for one connection. A complaint from an hour ago sitting on the screen
      // looking current is worse than no complaint at all.
      venue.lastError = null;
      // A reconnect has missed whatever moved while it was down, and Coinbase's bucket is now
      // a bar from before the gap. Drop it and let the next fold re-seed from the cache.
      if (venue.provider === 'coinbase') for (const product of venue.wanted) folding.delete(product);
      syncSubscriptions(venue);
      startPing(venue);
    };

    sock.onmessage = (ev: { data: unknown }) => {
      if (venue.socket !== sock) return;
      /* The backoff is cleared by a MESSAGE, never by an open. A venue that completes the
         handshake and then closes at once, which is what a rate limit and a ban both look like,
         reset it on every cycle and reconnected once a second forever. A connection that has
         carried data is a connection that worked; one that only opened proved nothing. */
      venue.retry = 0;
      venue.lastMessageMs = now();
      handle(venue, ev.data);
    };

    sock.onclose = () => {
      if (venue.socket !== sock) return;
      clearOpenTimer(venue);
      venue.socket = null;
      venue.since = null;
      venue.sent.clear();
      stopPing(venue);
      scheduleRetry(venue);
    };

    sock.onerror = (err?: unknown) => {
      venue.lastError = err === undefined ? 'websocket error' : errText(err);
      try {
        sock.close();
      } catch {
        /* close() on an already-dead socket is not worth reporting */
      }
    };
  }

  function scheduleRetry(venue: Venue): void {
    if (stopped || venue.retryTimer !== null || venue.wanted.size === 0) return;
    // 1s, 2s, 4s, 8s, capped at 15s, the same shape as src/trade/feed-ws.ts. The chart falls
    // back to REST for the whole gap, so a longer cap would cost the price nothing and a
    // shorter one would hammer a venue that is already having a bad day.
    const delay = Math.min(RETRY_CAP_MS, 1000 * 2 ** venue.retry);
    venue.retry += 1;
    venue.retryTimer = setTimeout(() => {
      venue.retryTimer = null;
      connect(venue);
    }, delay);
    venue.retryTimer.unref?.();
  }

  function clearOpenTimer(venue: Venue): void {
    if (venue.openTimer !== null) clearTimeout(venue.openTimer);
    venue.openTimer = null;
  }

  function startPing(venue: Venue): void {
    if (venue.pingTimer !== null) return;
    // Coinbase Exchange answers its own heartbeat channel and wants no client ping; sending
    // one is a protocol error there, so only Hyperliquid gets a timer.
    if (venue.provider !== 'hyperliquid') return;
    venue.pingTimer = setInterval(() => {
      send(venue, { method: 'ping' });
    }, PING_MS);
    venue.pingTimer.unref?.();
  }

  function stopPing(venue: Venue): void {
    if (venue.pingTimer !== null) clearInterval(venue.pingTimer);
    venue.pingTimer = null;
  }

  function closeVenue(venue: Venue): void {
    const sock = venue.socket;
    venue.socket = null;
    venue.since = null;
    venue.sent.clear();
    stopPing(venue);
    clearOpenTimer(venue);
    if (venue.retryTimer !== null) clearTimeout(venue.retryTimer);
    venue.retryTimer = null;
    if (sock === null) return;
    try {
      sock.close();
    } catch {
      /* a venue with no subscribers is being dropped either way */
    }
  }

  // ---------- messages ----------

  function emit(venue: Venue, product: string, candle: Candle): void {
    const key = keyOf(product, venue.provider);
    if (sameCandle(lastEmitted.get(key), candle)) return;
    lastEmitted.set(key, candle);
    lastLiveAt.set(key, now());
    deps.onCandle(product, LIVE_BASE_SEC, candle, venue.provider);
  }

  function handle(venue: Venue, raw: unknown): void {
    let msg: unknown;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      venue.lastError = errText(err);
      return;
    }
    if (!isRecord(msg)) return;
    if (venue.provider === 'hyperliquid') handleHyperliquid(venue, msg);
    else handleCoinbase(venue, msg);
  }

  function handleHyperliquid(venue: Venue, msg: Record<string, unknown>): void {
    if (msg.channel === 'error') {
      venue.lastError = typeof msg.data === 'string' ? msg.data : 'hyperliquid websocket error';
      return;
    }
    if (msg.channel !== 'candle') return;
    const row = hyperliquidCandle(msg.data);
    if (row === null || row.interval !== '1m') return;
    // The venue answers with a coin; the subscription set is keyed by product, and only a
    // product this rail asked for may reach the store.
    for (const product of venue.wanted) {
      if (coinOf(product) !== row.coin) continue;
      emit(venue, product, row.candle);
      return;
    }
  }

  function handleCoinbase(venue: Venue, msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === 'error') {
      venue.lastError = typeof msg.message === 'string' ? msg.message : 'coinbase websocket error';
      return;
    }
    // last_match is the trade that happened before this socket attached. It is already inside
    // the cached bar, so folding its size in would double-count the minute's volume.
    if (type !== 'match') return;
    const product = typeof msg.product_id === 'string' ? msg.product_id : null;
    if (product === null || !venue.wanted.has(product)) return;
    const price = num(msg.price);
    const size = num(msg.size);
    if (price === null || size === null) return;
    const stamp = typeof msg.time === 'string' ? Date.parse(msg.time) : NaN;
    const tradeSec = Math.floor((Number.isFinite(stamp) ? stamp : now()) / 1000);

    const cached = seedBar(product, 'coinbase');
    const folded = foldMatch(folding.get(product) ?? null, cached, tradeSec, price, size);
    folding.set(product, folded);
    emit(venue, product, folded);
  }

  // ---------- the surface ----------

  /* What one owner wants watched. Declarative on purpose: the caller states the whole set it
     cares about and this diffs it, so a window that closes without saying so cannot leave a
     subscription behind. */
  function track(owner: string, refs: readonly LiveRef[]): void {
    if (stopped) return;
    owners.set(owner, refs.map((ref) => ({ product: ref.product, provider: ref.provider })));

    const union = new Map<LiveProvider, Set<string>>();
    for (const list of owners.values()) {
      for (const ref of list) {
        const held = union.get(ref.provider) ?? new Set<string>();
        held.add(ref.product);
        union.set(ref.provider, held);
      }
    }

    for (const provider of ['hyperliquid', 'coinbase'] as const) {
      const want = union.get(provider) ?? new Set<string>();
      const existing = venues.get(provider);
      if (want.size === 0 && existing === undefined) continue;
      const venue = venueOf(provider);
      venue.wanted = want;
      // A venue nobody is watching keeps no socket. The chart is normally one market and the
      // trading window one more, so this is two connections and never the catalogue.
      if (want.size === 0) {
        closeVenue(venue);
        continue;
      }
      if (venue.socket === null) connect(venue);
      else syncSubscriptions(venue);
    }
  }

  /* Milliseconds since a live bar last arrived for a series, or null if none ever has.
     The feed state is derived from this in src/market/push.ts, not here: this module knows
     what it heard and when, and nothing about what counts as late. */
  function ageMs(product: string, provider: LiveProvider): number | null {
    const at = lastLiveAt.get(keyOf(product, provider));
    return at === undefined ? null : now() - at;
  }

  function connected(provider: LiveProvider): boolean {
    const venue = venues.get(provider);
    return venue !== undefined && venue.socket !== null && venue.socket.readyState === OPEN;
  }

  function status(): VenueStatus[] {
    const out: VenueStatus[] = [];
    for (const venue of venues.values()) {
      out.push({
        provider: venue.provider,
        connected: venue.socket !== null && venue.socket.readyState === OPEN,
        since: venue.since,
        lastMessageMs: venue.lastMessageMs,
        reconnects: venue.reconnects,
        lastError: venue.lastError,
        products: [...venue.wanted].sort(),
      });
    }
    return out;
  }

  function stop(): void {
    stopped = true;
    for (const venue of venues.values()) {
      venue.wanted.clear();
      closeVenue(venue);
    }
    owners.clear();
    folding.clear();
  }

  return { track, ageMs, connected, status, stop };
}

export type MarketLive = ReturnType<typeof createMarketLive>;
