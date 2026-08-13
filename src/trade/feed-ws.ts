// One websocket carrying everything the trading surface reads: account, positions, orders,
// fills, and per-coin market state.
//
// Polling was the alternative and it is the wrong one here. Hyperliquid's IP budget is 1200
// weight per minute and most /info calls weigh 20, so a screen refreshing positions, orders,
// fills, mark and funding spends the whole budget asking for answers the venue pushes for free.
// src/hl/info.ts made REST survivable after the testnet went to ~16s per call; it did not make
// REST right for a live screen. REST stays for the one-shot reads at boot and for the state the
// socket does not carry.
//
// Three properties of this socket cost real money when they are wrong:
//
//   HEARTBEAT  the venue closes any connection it has not sent to in 60 seconds. hyperliquidLive
//              gets away with sending no ping because a trades subscription on a busy coin never
//              idles. An account subscription on a quiet account idles constantly, so this client
//              pings every 30s and expects a pong. Without it the socket dies without a word.
//   SNAPSHOTS  a (re)connect replays state with isSnapshot: true. A snapshot REPLACES what is
//              held, anything else appends. Backwards, and every reconnect doubles the fills.
//   UNKNOWNS   every number arrives as a string and an unreadable one becomes null, never 0. A
//              screen printing 0 as a fact tells a human they hold nothing while they are
//              carrying a position, which is the worst lie this app could tell.
//
// The unified-account trap, found live and already written down in src/runner/feed.ts:
// clearinghouseState is the legacy perp-only view. On a unified account with no position it
// reports accountValue 0.0; with a position open it reports position equity only, and
// totalRawUsd goes negative because perp margin is drawn from the spot balance. `withdrawable`
// reads 0.0 either way. So on such an account the perp view is never the account's money.
// activeAssetData is the authority for what there is to trade with, spotClearinghouseState holds
// the balance that backs it, and `unified` on the snapshot tells the caller which reading it has.

import type { InfoClient } from '../hl/info.ts';

export type FeedStatus = {
  connected: boolean;
  since: string | null;
  // Epoch ms of the last message of any kind, pongs included, matching the atMs convention used
  // across these types. Age is the caller's subtraction; the raw instant is the fact.
  lastMessageMs: number | null;
  // Connections re-established after the first one. A feed that has reconnected forty times in
  // an hour is degraded even though it is connected right now.
  reconnects: number;
  lastError: string | null;
};

export type AccountSnapshot = {
  atMs: number;
  equityUsd: number | null;
  marginUsedUsd: number | null;
  maintenanceUsd: number | null;
  withdrawableUsd: number | null;
  freeUsd: number | null;
  unified: boolean;
  positions: RawPosition[];
};

export type RawPosition = {
  coin: string;
  szi: number; // signed: negative is short
  entryPx: number;
  positionValueUsd: number;
  unrealisedUsd: number;
  liqPx: number | null;
  leverage: number;
  leverageType: 'cross' | 'isolated';
  marginUsedUsd: number;
  fundingPaidUsd: number;
};

export type RawOrder = {
  oid: number;
  cloid: string | null;
  coin: string;
  side: 'buy' | 'sell';
  limitPx: number | null;
  triggerPx: number | null;
  sizeCoin: number;
  isTrigger: boolean;
  reduceOnly: boolean;
  tif: string | null;
  atMs: number;
  orderType: string;
};

export type RawFill = {
  tid: string;
  coin: string;
  side: 'buy' | 'sell';
  px: number;
  sizeCoin: number;
  feeUsd: number;
  closedPnlUsd: number | null;
  atMs: number;
  liquidation: boolean;
};

export type MarketCtx = {
  coin: string;
  markPx: number;
  oraclePx: number | null;
  midPx: number | null;
  fundingRateHourly: number | null;
  openInterestUsd: number | null;
  volume24hUsd: number | null;
  premiumPct: number | null;
};

export type TradeFeed = {
  watch(coins: string[]): void;
  account(): AccountSnapshot | null;
  orders(): RawOrder[];
  fills(): RawFill[];
  market(coin: string): MarketCtx | null;
  status(): FeedStatus;
  onUpdate(fn: () => void): void;
  stop(): void;
};

// The slice of a WebSocket this client actually uses. It exists so a test can drive connect,
// message, close and reconnect without a network, and so nothing here depends on the parts of
// the browser interface that have no bearing on reading a venue.
export type FeedSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err?: unknown) => void) | null;
};

const OPEN = 1;
// The venue's idle timeout is 60s, so a 30s ping survives one lost frame before the cut.
const PING_MS = 30_000;
const NOTIFY_MS = 100;
const RETRY_CAP_MS = 15_000;
const DEFAULT_MAX_FILLS = 200;
// Spot backs perp margin on a unified account and no subscription carries it, so it is the one
// number this client polls. Every 30s is 40 weight per minute against a budget of 1200.
const SPOT_REFRESH_MS = 30_000;

type AssetMeta = { assetId: number; szDecimals: number | null; maxLeverage: number | null };

type ClearingState = {
  accountValueUsd: number | null;
  rawUsd: number | null;
  marginUsedUsd: number | null;
  maintenanceUsd: number | null;
  withdrawableUsd: number | null;
};

type ActiveAsset = { availableUsd: number | null; markPx: number | null };

type SpotState = { totalUsd: number | null; holdUsd: number | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// The venue sends every number as a string. An empty string, a null, a missing key and a word
// all mean the same thing here: this number is not known. None of them mean zero.
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function coinOf(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

// 'B' is bid and 'A' is ask. Anything else is read as a buy because the locked row type has no
// null for a side, and a wrong side on an unreadable row is visible where a dropped row is not.
function sideOf(v: unknown): 'buy' | 'sell' {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return s === 'A' || s === 'S' || s === 'SELL' ? 'sell' : 'buy';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Payloads arrive either as a bare array or wrapped under a name, depending on the channel.
function listOf(data: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return null;
  for (const key of keys) {
    const v = data[key];
    if (Array.isArray(v)) return v;
  }
  return null;
}

function snapshotFlag(data: unknown): boolean {
  return isRecord(data) && data.isSnapshot === true;
}

// The default socket, wrapped rather than passed through, so the seam above stays free of the
// browser's event objects and nothing in this file needs a cast to talk to the runtime.
function nativeSocket(url: string): FeedSocket {
  const ws = new WebSocket(url);
  const sock: FeedSocket = {
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

export function createTradeFeed(deps: {
  wsUrl: string;
  user: string;
  info: InfoClient; // src/hl/info.ts, for meta at boot and as the fallback
  maxFills?: number; // default 200
  // Test seam. The socket is the only thing in here that cannot be reasoned about offline.
  wsImpl?: (url: string) => FeedSocket;
}): TradeFeed {
  const user = deps.user;
  const maxFills = deps.maxFills ?? DEFAULT_MAX_FILLS;
  const makeSocket = deps.wsImpl ?? nativeSocket;

  const listeners: Array<() => void> = [];
  const watched = new Set<string>();
  const markets = new Map<string, MarketCtx>();
  const activeAssets = new Map<string, ActiveAsset>();

  let universe: Map<string, AssetMeta> | null = null;
  let clearing: ClearingState | null = null;
  let positions: RawPosition[] = [];
  let orders: RawOrder[] = [];
  let held: RawFill[] = [];
  let spot: SpotState | null = null;
  let accountAtMs = 0;

  let socket: FeedSocket | null = null;
  let closed = false;
  let retry = 0;
  let opens = 0;
  let reconnects = 0;
  let since: string | null = null;
  let lastMessageMs: number | null = null;
  let lastError: string | null = null;

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let spotTimer: ReturnType<typeof setInterval> | null = null;

  function notify(): void {
    // Coalesce: a busy market pushes several messages per second and every listener hop costs
    // an SSE write to every browser attached to the surface.
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const fn of listeners) fn();
    }, NOTIFY_MS);
  }

  // ---------- REST at boot: the constants, and the balance no subscription carries ----------

  // Asset ids and decimals do not change under a running process, so they are read once. The
  // asset id IS the index in `universe`: metaAndAssetCtxs pairs its contexts to this array
  // positionally with no coin key on them, so anything zipping the two must zip by index or it
  // will quietly hang one coin's mark price on another.
  async function readMeta(): Promise<void> {
    try {
      const res = await deps.info.post<unknown>({ type: 'meta' });
      const rows = isRecord(res) && Array.isArray(res.universe) ? res.universe : [];
      const map = new Map<string, AssetMeta>();
      rows.forEach((row, index) => {
        if (!isRecord(row)) return;
        const name = coinOf(row.name);
        if (name === '') return;
        map.set(name, {
          assetId: index,
          szDecimals: num(row.szDecimals),
          maxLeverage: num(row.maxLeverage),
        });
      });
      if (map.size > 0) universe = map;
      for (const coin of watched) warnUnknown(coin);
    } catch (err) {
      // A failed meta read costs the coin check below and nothing else, so it does not stop
      // the socket. It is named in status() rather than thrown at a caller who cannot act.
      lastError = `meta read failed: ${errText(err)}`;
    }
  }

  // A coin the venue does not list subscribes to a channel that will never send, which looks
  // exactly like a quiet market. Naming it is the whole reason meta is read here.
  function warnUnknown(coin: string): void {
    if (universe !== null && !universe.has(coin)) lastError = `unknown coin ${coin}`;
  }

  // Only USDC backs perps. `total` includes the part working as perp margin and `hold` is the
  // reserved slice, so total - hold is what is genuinely free.
  async function readSpot(): Promise<void> {
    try {
      const res = await deps.info.post<unknown>({ type: 'spotClearinghouseState', user });
      const rows = isRecord(res) && Array.isArray(res.balances) ? res.balances : [];
      let total: number | null = null;
      let hold: number | null = null;
      for (const row of rows) {
        if (!isRecord(row) || coinOf(row.coin) !== 'USDC') continue;
        total = num(row.total);
        hold = num(row.hold);
      }
      spot = { totalUsd: total, holdUsd: hold };
      if (accountAtMs === 0) accountAtMs = Date.now();
      notify();
    } catch (err) {
      lastError = `spot read failed: ${errText(err)}`;
    }
  }

  // Skipped once the account is known to be a plain perp account, where spot backs nothing and
  // the socket already carries every number the surface shows.
  function maybeReadSpot(): void {
    if (closed) return;
    if (clearing !== null && !detectUnified()) return;
    void readSpot();
  }

  // ---------- subscriptions ----------

  function accountSubs(): Array<Record<string, unknown>> {
    return [
      { type: 'clearinghouseState', user, dex: '' },
      { type: 'openOrders', user, dex: '' },
      { type: 'userFills', user },
      { type: 'userEvents', user },
    ];
  }

  function coinSubs(coin: string): Array<Record<string, unknown>> {
    return [
      { type: 'activeAssetData', user, coin },
      { type: 'activeAssetCtx', coin },
    ];
  }

  function send(sock: FeedSocket, msg: unknown): void {
    try {
      sock.send(JSON.stringify(msg));
    } catch (err) {
      lastError = errText(err);
    }
  }

  function sub(sock: FeedSocket, subscription: Record<string, unknown>): void {
    send(sock, { method: 'subscribe', subscription });
  }

  function unsub(sock: FeedSocket, subscription: Record<string, unknown>): void {
    send(sock, { method: 'unsubscribe', subscription });
  }

  // ---------- connection ----------

  function connect(): void {
    if (closed || socket) return;
    let sock: FeedSocket;
    try {
      sock = makeSocket(deps.wsUrl);
    } catch (err) {
      lastError = errText(err);
      scheduleRetry();
      return;
    }
    socket = sock;

    sock.onopen = () => {
      if (socket !== sock) return;
      retry = 0;
      opens += 1;
      if (opens > 1) reconnects += 1;
      since = new Date().toISOString();
      // Errors are kept for the life of a connection and cleared by the next one, so a stale
      // complaint from an hour ago does not sit on the screen looking current.
      lastError = null;
      for (const s of accountSubs()) sub(sock, s);
      for (const coin of watched) {
        for (const s of coinSubs(coin)) sub(sock, s);
      }
      startPing();
      // State can have moved while the socket was down and spot is not on it.
      maybeReadSpot();
      notify();
    };

    sock.onmessage = (ev: { data: unknown }) => {
      if (socket === sock) handle(ev.data);
    };

    sock.onclose = () => {
      if (socket !== sock) return;
      socket = null;
      since = null;
      stopPing();
      scheduleRetry();
    };

    sock.onerror = (err?: unknown) => {
      lastError = err === undefined ? 'websocket error' : errText(err);
      try {
        sock.close();
      } catch {
        /* close() on an already-dead socket is not worth reporting */
      }
    };
  }

  function scheduleRetry(): void {
    if (closed || retryTimer) return;
    // 1s, 2s, 4s, 8s, capped at 15s, same as the market socket. status() shows the gap meanwhile.
    const delay = Math.min(RETRY_CAP_MS, 1000 * 2 ** retry);
    retry++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
    notify();
  }

  function startPing(): void {
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      const sock = socket;
      if (!sock || sock.readyState !== OPEN) return;
      send(sock, { method: 'ping' });
    }, PING_MS);
    if (typeof pingTimer.unref === 'function') pingTimer.unref();
  }

  function stopPing(): void {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  // ---------- message handling ----------

  function handle(raw: unknown): void {
    lastMessageMs = Date.now();
    let msg: { channel?: unknown; data?: unknown };
    try {
      msg = JSON.parse(String(raw)) as { channel?: unknown; data?: unknown };
    } catch {
      return;
    }
    const channel = typeof msg.channel === 'string' ? msg.channel : '';
    const data = msg.data;
    switch (channel) {
      case 'pong':
        // A pong carries no data key at all. Its only job is the timestamp taken above.
        return;
      case 'subscriptionResponse':
        return;
      case 'error':
        lastError = typeof data === 'string' ? data : JSON.stringify(data ?? null);
        break;
      case 'clearinghouseState':
        onClearing(data);
        break;
      case 'openOrders':
        onOrders(data);
        break;
      case 'userFills':
        onFills(data);
        break;
      case 'user':
        // userEvents replies on a channel named `user`, not `userEvents`.
        onUserEvent(data);
        break;
      case 'activeAssetData':
        onActiveAsset(data);
        break;
      case 'activeAssetCtx':
        onAssetCtx(data);
        break;
      default:
        return;
    }
    notify();
  }

  function onClearing(data: unknown): void {
    if (!isRecord(data)) return;
    const st = isRecord(data.clearinghouseState) ? data.clearinghouseState : data;
    const summary = isRecord(st.marginSummary) ? st.marginSummary : {};
    const cross = isRecord(st.crossMarginSummary) ? st.crossMarginSummary : {};
    if (!Array.isArray(st.assetPositions) && summary.accountValue === undefined) return;
    clearing = {
      accountValueUsd: num(summary.accountValue),
      rawUsd: num(summary.totalRawUsd) ?? num(cross.totalRawUsd),
      marginUsedUsd: num(summary.totalMarginUsed),
      // The account's maintenance requirement. There is no per-position field for it: a single
      // position's share is positionValue / (2 * maxLeverage) of its margin tier, derived by
      // whoever needs it rather than invented here.
      maintenanceUsd: num(st.crossMaintenanceMarginUsed),
      withdrawableUsd: num(st.withdrawable),
    };
    positions = parsePositions(st.assetPositions);
    accountAtMs = num(st.time) ?? Date.now();
  }

  function parsePositions(rows: unknown): RawPosition[] {
    if (!Array.isArray(rows)) return [];
    const out: RawPosition[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const p = isRecord(row.position) ? row.position : row;
      const coin = coinOf(p.coin);
      const szi = num(p.szi);
      const entryPx = num(p.entryPx);
      const positionValueUsd = num(p.positionValue);
      const unrealisedUsd = num(p.unrealizedPnl);
      const marginUsedUsd = num(p.marginUsed);
      const lev = isRecord(p.leverage) ? p.leverage : {};
      const leverage = num(lev.value);
      const funding = isRecord(p.cumFunding) ? p.cumFunding : {};
      const fundingPaidUsd = num(funding.sinceOpen);
      if (
        coin === '' ||
        szi === null ||
        entryPx === null ||
        positionValueUsd === null ||
        unrealisedUsd === null ||
        marginUsedUsd === null ||
        leverage === null ||
        fundingPaidUsd === null
      ) {
        // None of these are nullable on the locked row, so a row that cannot be read in full is
        // dropped and named in status(). Zero-filling it would put a fake position on the screen.
        lastError = `position ${coin || '?'} dropped: a field could not be read as a number`;
        continue;
      }
      out.push({
        coin,
        szi,
        entryPx,
        positionValueUsd,
        unrealisedUsd,
        // Null on a cross position, seen live. Never coerced: a 0 here draws the liquidation
        // line at zero, which reads as infinite room and is the most dangerous wrong number on
        // the screen.
        liqPx: num(p.liquidationPx),
        leverage,
        leverageType: lev.type === 'isolated' ? 'isolated' : 'cross',
        marginUsedUsd,
        fundingPaidUsd,
      });
    }
    return out;
  }

  function onOrders(data: unknown): void {
    const rows = listOf(data, ['openOrders', 'orders']);
    if (rows === null) return;
    const next: RawOrder[] = [];
    for (const row of rows) {
      const order = parseOrder(row);
      if (order !== null) next.push(order);
    }
    // The resting set is whole in every message, so it replaces rather than merges.
    orders = next;
  }

  function parseOrder(row: unknown): RawOrder | null {
    if (!isRecord(row)) return null;
    const oid = num(row.oid);
    const sizeCoin = num(row.sz);
    const atMs = num(row.timestamp);
    const coin = coinOf(row.coin);
    if (oid === null || sizeCoin === null || atMs === null || coin === '') {
      lastError = `order ${coin || '?'} dropped: a field could not be read as a number`;
      return null;
    }
    const condition = typeof row.triggerCondition === 'string' ? row.triggerCondition : '';
    const isTrigger = row.isTrigger === true || (condition !== '' && condition !== 'N/A');
    const triggerPx = num(row.triggerPx);
    return {
      oid,
      cloid: text(row.cloid),
      coin,
      side: sideOf(row.side),
      // On a trigger order this is NOT the line the order waits at. It is the 10 percent
      // slippage bound the venue attaches to the market order the trigger fires. The line is
      // triggerPx, and the venue compares it against MARK price, not last trade. This pair is
      // the field people misread.
      limitPx: num(row.limitPx),
      // A resting limit order carries triggerPx "0.0", which would draw a trigger line at zero.
      triggerPx: isTrigger && triggerPx !== null && triggerPx !== 0 ? triggerPx : null,
      sizeCoin,
      isTrigger,
      reduceOnly: row.reduceOnly === true,
      tif: text(row.tif),
      atMs,
      // Empty means the venue did not say. Plain /info openOrders omits this and every other
      // trigger field, so any REST read behind this feed has to ask for frontendOpenOrders.
      orderType: typeof row.orderType === 'string' ? row.orderType : '',
    };
  }

  function onFills(data: unknown): void {
    const rows = listOf(data, ['fills']);
    if (rows === null) return;
    const incoming: RawFill[] = [];
    for (const row of rows) {
      const fill = parseFill(row);
      if (fill !== null) incoming.push(fill);
    }
    if (incoming.length === 0) return;
    // The reconnect replay arrives as a snapshot and contains what was missed, so it replaces
    // the held list. Appending it instead is what doubles every fill on every reconnect.
    held = mergeFills(incoming, snapshotFlag(data) ? [] : held);
  }

  function onUserEvent(data: unknown): void {
    // userEvents carries fills, funding and liquidations. Fills are the part with a home in
    // these types; a funding payment shows up in the next clearinghouseState as cumFunding, and
    // a liquidation shows up as its own fills with `liquidation` set.
    if (isRecord(data) && Array.isArray(data.fills)) onFills(data);
  }

  function mergeFills(incoming: RawFill[], keep: RawFill[]): RawFill[] {
    const seen = new Set<string>();
    const out: RawFill[] = [];
    for (const fill of [...incoming, ...keep]) {
      // tid is the venue's own id for a fill. `hash` cannot serve here: it is 0x000...0 on a
      // great many fills, which would collapse unrelated trades into one.
      if (seen.has(fill.tid)) continue;
      seen.add(fill.tid);
      out.push(fill);
    }
    out.sort((a, b) => b.atMs - a.atMs);
    return out.slice(0, maxFills);
  }

  function parseFill(row: unknown): RawFill | null {
    if (!isRecord(row)) return null;
    const rawTid = row.tid;
    const tid =
      typeof rawTid === 'number' && Number.isFinite(rawTid)
        ? String(rawTid)
        : typeof rawTid === 'string' && rawTid !== ''
          ? rawTid
          : null;
    const coin = coinOf(row.coin);
    const px = num(row.px);
    const sizeCoin = num(row.sz);
    const feeUsd = num(row.fee);
    const atMs = num(row.time);
    if (tid === null || coin === '' || px === null || sizeCoin === null || feeUsd === null || atMs === null) {
      lastError = `fill ${coin || '?'} dropped: a field could not be read as a number`;
      return null;
    }
    return {
      tid,
      coin,
      side: sideOf(row.side),
      px,
      sizeCoin,
      feeUsd,
      closedPnlUsd: num(row.closedPnl),
      atMs,
      // There is no boolean for this. A liquidated fill carries a `liquidation` object holding
      // the liquidated user, the mark and the method; an ordinary fill has no such key.
      liquidation: isRecord(row.liquidation),
    };
  }

  function onActiveAsset(data: unknown): void {
    if (!isRecord(data)) return;
    const coin = coinOf(data.coin);
    if (coin === '' || !watched.has(coin)) return;
    // availableToTrade is a two-element array the venue ships with no labels on it. Live
    // behaviour is [buy, sell], and index 0 is the side this screen sizes against.
    const available = Array.isArray(data.availableToTrade) ? num(data.availableToTrade[0]) : null;
    const markPx = num(data.markPx);
    activeAssets.set(coin, { availableUsd: available, markPx });
    // A mark from here fills the gap before the first activeAssetCtx lands, and never overwrites
    // it: the context is the authority for market state.
    if (markPx !== null && !markets.has(coin)) {
      markets.set(coin, {
        coin,
        markPx,
        oraclePx: null,
        midPx: null,
        fundingRateHourly: null,
        openInterestUsd: null,
        volume24hUsd: null,
        premiumPct: null,
      });
    }
  }

  function onAssetCtx(data: unknown): void {
    if (!isRecord(data)) return;
    const coin = coinOf(data.coin);
    if (coin === '' || !watched.has(coin)) return;
    const ctx = isRecord(data.ctx) ? data.ctx : data;
    const markPx = num(ctx.markPx);
    if (markPx === null) {
      lastError = `market ${coin} dropped: no readable mark price`;
      return;
    }
    const openInterest = num(ctx.openInterest);
    const premium = num(ctx.premium);
    markets.set(coin, {
      coin,
      markPx,
      oraclePx: num(ctx.oraclePx),
      // The context's own mid. A `bbo` subscription is the cheap upgrade if a tighter one is
      // ever wanted; l2Book costs far more for the same top of book.
      midPx: num(ctx.midPx),
      // `funding` is already the hourly rate on this venue, not an annualised one.
      fundingRateHourly: num(ctx.funding),
      // openInterest is quoted in coins, so USD needs the mark. Null when either half is
      // unknown, because a 0 here reads as an empty book.
      openInterestUsd: openInterest === null ? null : openInterest * markPx,
      volume24hUsd: num(ctx.dayNtlVlm),
      // `premium` is a fraction of the oracle price; the panel prints percent.
      premiumPct: premium === null ? null : premium * 100,
    });
  }

  // ---------- reads ----------

  // The shared collateral pool as activeAssetData reports it. Every coin on a unified account
  // reports the same number, so the maximum is taken: an isolated coin reports only its own
  // position's margin, which would understate the pool if it happened to be read last.
  function bestAvailable(): number | null {
    let best: number | null = null;
    for (const asset of activeAssets.values()) {
      if (asset.availableUsd === null) continue;
      best = best === null ? asset.availableUsd : Math.max(best, asset.availableUsd);
    }
    return best;
  }

  // Two independent tells, either one is enough:
  //   totalRawUsd below zero, which is the perp side borrowing its margin from the spot balance
  //   accountValue at exactly zero while activeAssetData still reports collateral to trade with
  // The first catches a funded unified account holding a position, the second catches one that
  // is flat. Neither reads as true on a plain perp account.
  function detectUnified(): boolean {
    if (clearing === null) return false;
    if (clearing.rawUsd !== null && clearing.rawUsd < 0) return true;
    const available = bestAvailable();
    return clearing.accountValueUsd === 0 && available !== null && available > 0;
  }

  function freeSpot(): number | null {
    if (spot === null || spot.totalUsd === null || spot.holdUsd === null) return null;
    return spot.totalUsd - spot.holdUsd;
  }

  function account(): AccountSnapshot | null {
    // Nothing has been heard yet. A blank snapshot would render as a funded account holding
    // nothing, which is a statement rather than the silence it actually is.
    if (clearing === null) return null;
    const unified = detectUnified();
    const spotFree = freeSpot();
    return {
      atMs: accountAtMs,
      // On a unified account `accountValue` is position equity and `withdrawable` reads 0.0
      // while the account is funded, so both come from spot instead, and stay null until spot
      // answers rather than being reported as zero.
      equityUsd: unified ? (spot === null ? null : spot.totalUsd) : clearing.accountValueUsd,
      marginUsedUsd: clearing.marginUsedUsd,
      maintenanceUsd: clearing.maintenanceUsd,
      withdrawableUsd: unified ? spotFree : clearing.withdrawableUsd,
      freeUsd: unified
        ? (bestAvailable() ?? spotFree)
        : clearing.accountValueUsd === null || clearing.marginUsedUsd === null
          ? null
          : clearing.accountValueUsd - clearing.marginUsedUsd,
      unified,
      positions: positions.slice(),
    };
  }

  // ---------- surface ----------

  function watch(coins: string[]): void {
    const next = new Set<string>();
    for (const raw of coins) {
      const coin = coinOf(raw);
      if (coin !== '') next.add(coin);
    }
    const added: string[] = [];
    const removed: string[] = [];
    for (const coin of next) if (!watched.has(coin)) added.push(coin);
    for (const coin of watched) if (!next.has(coin)) removed.push(coin);
    // Idempotent: the same set twice sends nothing, and one coin changing never costs the
    // socket. Tearing the connection down to change a subscription would drop the account
    // channels too and buy a reconnect storm.
    if (added.length === 0 && removed.length === 0) return;

    for (const coin of removed) {
      watched.delete(coin);
      // State for a coin nobody watches stops being updated. A stale mark that still renders
      // is worse than a blank one.
      markets.delete(coin);
      activeAssets.delete(coin);
    }
    for (const coin of added) {
      watched.add(coin);
      warnUnknown(coin);
    }

    const sock = socket;
    if (sock && sock.readyState === OPEN) {
      for (const coin of removed) for (const s of coinSubs(coin)) unsub(sock, s);
      for (const coin of added) for (const s of coinSubs(coin)) sub(sock, s);
    } else if (!sock && !retryTimer) {
      // Nothing is connected and nothing is pending. A retry already in flight covers itself,
      // and the open handler subscribes the whole watched set.
      connect();
    }
    notify();
  }

  function stop(): void {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (notifyTimer) clearTimeout(notifyTimer);
    if (spotTimer) clearInterval(spotTimer);
    retryTimer = null;
    notifyTimer = null;
    spotTimer = null;
    stopPing();
    since = null;
    if (socket) {
      const sock = socket;
      socket = null;
      try {
        sock.close();
      } catch {
        /* shutting down anyway */
      }
    }
  }

  // The account channels need no coin, so the socket comes up at boot rather than waiting for
  // the first watch(). A surface that shows positions has them before it is told what to chart.
  void readMeta();
  maybeReadSpot();
  spotTimer = setInterval(maybeReadSpot, SPOT_REFRESH_MS);
  if (typeof spotTimer.unref === 'function') spotTimer.unref();
  connect();

  return {
    watch,
    account,
    orders: () => orders.slice(),
    fills: () => held.slice(),
    market: (coin: string) => markets.get(coinOf(coin)) ?? null,
    status: () => ({
      connected: socket !== null && socket.readyState === OPEN,
      since,
      lastMessageMs,
      reconnects,
      lastError,
    }),
    onUpdate: (fn: () => void) => {
      listeners.push(fn);
    },
    stop,
  };
}
