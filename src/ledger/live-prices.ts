/* THE BALANCE'S LIVE PRICES. Hyperliquid's mid for each coin the person holds, over one socket.

   The ledger prices a coin off Coinbase (ETH, SOL, NEAR) or, for everything else, off 1Click's
   token list, which re-prices in one batch about once a minute and to two or three digits (GRAM
   read 1.46 while its market moved through 1.4554 to 1.4606). Karim, 2026-10-09, holding GRAM:
   "i want to see the price change live". Hyperliquid's activeAssetCtx channel sends a coin's mid
   about once a second, its first one within half a second of the subscribe; allMids sent its first
   after 3.5 s and then one every five, 22 KB each, so it is the wrong channel for this.

   DISPLAY ONLY. What this holds reaches the window's balance and the agent's wallet read through
   src/wallet.ts (live), and nothing else: every price that governs a move (src/proposals/draft.ts)
   still comes from the ledger's snapshot and its age rule. A mid is a perp's, and the wallet takes
   it only within a band of the coin's own price, so a different token under the same ticker never
   borrows it. A price older than FRESH_MS is no answer, so a dead socket falls back to the
   ledger's price on its own. */

import { nativeSocket, type FeedSocket } from '../trade/feed-ws.ts';

// A mid this old is no longer live. Hyperliquid sends one about every second on a listed market.
export const FRESH_MS = 15_000;
// The window is told at most once a second: a state frame rebuilds the whole payload.
export const PUSH_MS = 1_000;
const OPEN = 1;
const PING_MS = 30_000;
const RETRY_CAP_MS = 15_000;

export type LivePrices = {
  // The coins to keep a price for, as the wallet keys them (src/wallet.ts liveCoins). Others drop.
  track(coins: string[]): void;
  // The coin's mid, or null when there is none younger than FRESH_MS.
  price(coin: string): number | null;
  // Moves whenever a tracked coin's mid moves, so a cache keyed on it rebuilds (src/http/state.ts).
  revision(): number;
  // Told when mids moved, at most once per PUSH_MS.
  onChange(fn: () => void): void;
  stop(): void;
};

export function createLivePrices(deps: { wsUrl: string; wsImpl?: (url: string) => FeedSocket; now?: () => number }): LivePrices {
  const now = deps.now ?? Date.now;
  const makeSocket = deps.wsImpl ?? nativeSocket;
  const tracked = new Set<string>();
  const mids = new Map<string, { px: number; at: number }>();
  const listeners: Array<() => void> = [];
  let rev = 0;
  let told = 0;
  let socket: FeedSocket | null = null;
  let closed = false;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;

  const subscription = (coin: string) => ({ type: 'activeAssetCtx', coin });

  function send(sock: FeedSocket, msg: unknown): void {
    try {
      sock.send(JSON.stringify(msg));
    } catch {
      // A socket that cannot send is closing; its onclose reconnects and subscribes again.
    }
  }

  function open(): FeedSocket | null {
    return socket !== null && socket.readyState === OPEN ? socket : null;
  }

  // Leading edge, then at most one more per window, and only when a mid moved since the last.
  function changed(): void {
    if (pushTimer !== null) return;
    if (rev !== told) {
      told = rev;
      for (const fn of listeners) fn();
    }
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (rev !== told) changed();
    }, PUSH_MS);
    pushTimer.unref?.();
  }

  function handle(raw: unknown): void {
    let msg: { channel?: unknown; data?: unknown };
    try {
      msg = JSON.parse(String(raw)) as { channel?: unknown; data?: unknown };
    } catch {
      return;
    }
    if (msg.channel !== 'activeAssetCtx' || msg.data === null || typeof msg.data !== 'object') return;
    const data = msg.data as { coin?: unknown; ctx?: { midPx?: unknown; markPx?: unknown } };
    const coin = typeof data.coin === 'string' ? data.coin.toUpperCase() : '';
    if (!tracked.has(coin)) return;
    // The book's mid; the mark when the book is one-sided and the venue sends no mid.
    const px = Number(data.ctx?.midPx ?? data.ctx?.markPx);
    if (!Number.isFinite(px) || px <= 0) return;
    const last = mids.get(coin);
    mids.set(coin, { px, at: now() });
    if (last?.px === px) return;
    rev += 1;
    changed();
  }

  function connect(): void {
    if (closed || socket !== null || tracked.size === 0) return;
    let sock: FeedSocket;
    try {
      sock = makeSocket(deps.wsUrl);
    } catch {
      scheduleRetry();
      return;
    }
    socket = sock;
    sock.onopen = () => {
      if (socket !== sock) return;
      retry = 0;
      for (const coin of tracked) send(sock, { method: 'subscribe', subscription: subscription(coin) });
      if (pingTimer === null) {
        pingTimer = setInterval(() => {
          const live = open();
          if (live !== null) send(live, { method: 'ping' });
        }, PING_MS);
        pingTimer.unref?.();
      }
    };
    sock.onmessage = (ev) => {
      if (socket === sock) handle(ev.data);
    };
    sock.onclose = () => {
      if (socket !== sock) return;
      socket = null;
      scheduleRetry();
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* already closing */
      }
    };
  }

  function scheduleRetry(): void {
    if (closed || retryTimer !== null) return;
    const delay = Math.min(RETRY_CAP_MS, 1000 * 2 ** retry);
    retry += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
    retryTimer.unref?.();
  }

  function track(coins: string[]): void {
    const next = new Set(coins.map((c) => String(c).toUpperCase()).filter((c) => c !== ''));
    const live = open();
    for (const coin of [...tracked]) {
      if (next.has(coin)) continue;
      tracked.delete(coin);
      mids.delete(coin);
      if (live !== null) send(live, { method: 'unsubscribe', subscription: subscription(coin) });
    }
    for (const coin of next) {
      if (tracked.has(coin)) continue;
      tracked.add(coin);
      if (live !== null) send(live, { method: 'subscribe', subscription: subscription(coin) });
    }
    connect();
  }

  function price(coin: string): number | null {
    const mid = mids.get(String(coin).toUpperCase());
    if (mid === undefined || now() - mid.at > FRESH_MS) return null;
    return mid.px;
  }

  function stop(): void {
    closed = true;
    for (const timer of [retryTimer, pushTimer]) if (timer !== null) clearTimeout(timer);
    if (pingTimer !== null) clearInterval(pingTimer);
    retryTimer = null;
    pushTimer = null;
    pingTimer = null;
    const sock = socket;
    socket = null;
    if (sock !== null) {
      try {
        sock.close();
      } catch {
        /* shutting down anyway */
      }
    }
  }

  return {
    track,
    price,
    revision: () => rev,
    onChange: (fn) => {
      listeners.push(fn);
    },
    stop,
  };
}
