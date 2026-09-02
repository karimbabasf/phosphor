// What the window is told about a bar, and how often.
//
// This is the second half of the live rail. src/market/live.ts gets a bar off a venue; this
// decides what reaches the browser and at what rate, and it derives the one thing a person
// actually wants to know about a feed: whether the number on screen can be trusted right now.
//
// It lives here rather than in the server for a reason worth writing down. The server file is
// where cross-cutting things go to become untestable: it owns sockets, routes, tokens and
// state, and a coalescer buried in it can only be exercised by standing an HTTP server up.
// The whole surface the server needs is `push` and `feedFor`, so the server keeps two calls and
// the arithmetic that decides what a person sees is a unit test.
//
// THE FRAME. Additive, and every existing consumer ignores it:
//
//   { type: 'candle', product: 'BTC-USD', provider: 'hyperliquid',
//     baseSec: 60, candle: { t, o, h, l, c, v } }
//
// About 120 bytes, against the 102 to 137 KB the browser used to refetch to move one close.
// The old contentless nudge stays exactly as it was and is what the REST fallback still sends:
// this is not a replacement for that path, it is the path that means the fallback is a
// fallback.

import type { Candle } from '../types.ts';

export type CandleFrame = {
  type: 'candle';
  product: string;
  provider: string;
  baseSec: number;
  candle: Candle;
};

export type FeedState = 'live' | 'delayed' | 'offline';

/* Coalesce at 120 ms.
   Hyperliquid pushes a candle every 421 ms at p50 and Coinbase's tape runs at 5.7 messages a
   second, so this is not a throttle on the normal case; it is a cap on a burst. Slower would
   start to be the thing the price is waiting for, which is the mistake the 1000 ms nudge timer
   made, and faster would send several frames carrying the same bar. */
const PUSH_MS = 120;

// Under this, the socket is carrying the price. The audit's threshold.
const LIVE_FRESH_SEC = 5;

// A scheduled flush, and the only thing needed to call it off.
export type PushTimer = { cancel(): void };

/* The real clock and the real timer, wrapped so a test can supply its own.

   The seam exists for the same reason FeedSocket does in src/trade/feed-ws.ts: the one thing in
   this module that cannot be reasoned about offline is the part that happens LATER. A test that
   proves a coalescer by sleeping is asserting on the machine's load, and it passes four times
   and fails the fifth, which is exactly what this one did. */
function realTimer(fn: () => void, ms: number): PushTimer {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

export type CandlePushDeps = {
  // Where a frame goes. The server hands its SSE fan-out in; a caller with no clients hands in
  // something that drops, and nothing here needs to know which.
  send: (frame: CandleFrame) => void;
  intervalMs?: number;
  // Test seam. See realTimer above.
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => PushTimer;
};

export function createCandlePush(deps: CandlePushDeps) {
  const intervalMs = deps.intervalMs ?? PUSH_MS;
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? realTimer;
  // The newest bar per series. A burst on one market collapses to the last of it, because an
  // earlier bar in the same window is a price that has already been superseded.
  const pending = new Map<string, CandleFrame>();
  let timer: PushTimer | null = null;
  let sent = 0;
  let sentAt = 0;
  let stopped = false;

  function flush(): void {
    timer = null;
    if (pending.size === 0) return;
    const frames = [...pending.values()];
    pending.clear();
    sentAt = now();
    for (const frame of frames) {
      sent += 1;
      deps.send(frame);
    }
  }

  /* Whether the rail has gone quiet, which is what makes REST the fallback rather than a
     second path running beside it.

     The server's nudge timer asks this before firing. While bars are arriving the browser is
     already current, and a nudge would only make it refetch a hundred kilobytes of JSON to
     arrive where it already is: that refetch is the thing the delta frame exists to delete, and
     leaving the timer unconditional would have kept it. Two seconds is four Hyperliquid candle
     intervals at p50, so a rail that is merely between bars is not mistaken for one that has
     stopped, and a rail that has genuinely stopped hands over within one tick. */
  function quiet(withinMs = 2000): boolean {
    return sentAt === 0 || now() - sentAt > withinMs;
  }

  /* One bar, coalesced. Wired to the store's onLive, so it fires for anything that reaches the
     cache without a network call rather than only for the socket. */
  function push(product: string, baseSec: number, candle: Candle, provider: string): void {
    if (stopped) return;
    pending.set(`${provider}:${product}:${baseSec}`, {
      type: 'candle',
      product,
      provider,
      baseSec,
      candle,
    });
    if (timer !== null) return;
    timer = schedule(flush, intervalMs);
  }

  function stop(): void {
    stopped = true;
    if (timer !== null) timer.cancel();
    timer = null;
    pending.clear();
  }

  return { push, quiet, stop, stats: () => ({ pending: pending.size, sent }) };
}

export type CandlePush = ReturnType<typeof createCandlePush>;

/* The dot beside the price, in three states and no more.

   A person reading a chart has one question about the feed and it is whether the number can be
   trusted now, so the answer is one of three things rather than a set of flags to interpret.

     live      a socket is open for this market and a bar arrived in the last five seconds
     delayed   no socket, or one that has gone quiet, and REST is serving
     offline   the source is unreachable, or there is nothing to draw

   Two properties this has that a naive version does not.

   It is per SERIES, not per venue. A socket carrying BTC says nothing about SOL, and a venue
   flag would light the dot green on a market nothing is subscribed to.

   And `connected` alone is never enough. A socket can be open and silent: the venue accepted
   the subscription and is sending nothing, which looks identical to a healthy feed from the
   readyState and nothing like one on the screen. The age of the last delta is what separates
   them, so both have to be true. */
export function feedStateFrom(input: {
  liveAgeSec: number | null;
  connected: boolean;
  stale: boolean;
  hasBars: boolean;
}): FeedState {
  // Nothing to draw, or what is drawn is old enough that it may no longer be the market. This
  // is the state the existing STALE warning already described, now with somewhere to live.
  if (!input.hasBars || input.stale) return 'offline';
  if (input.connected && input.liveAgeSec !== null && input.liveAgeSec < LIVE_FRESH_SEC) return 'live';
  return 'delayed';
}

/* The one call the server makes per chart payload. `read` is a MarketRead and `connected` asks
   the live rail about that read's venue, which the read itself names. */
export function feedFor(
  read: { liveAgeSec: number | null; stale: boolean; bars: number; source: string },
  connected: (provider: string) => boolean,
): FeedState {
  return feedStateFrom({
    liveAgeSec: read.liveAgeSec,
    connected: connected(read.source),
    stale: read.stale,
    hasBars: read.bars > 0,
  });
}
