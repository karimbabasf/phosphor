// The trading surface as one object the server can call.
//
// Three things are joined here and nowhere else: the view state the agent and the human both
// write, the venue feed, and the runner that holds the armed mandates. The server does not know
// about any of them individually, which keeps the HTTP layer a router rather than a second
// place where trading logic lives.
//
// The split that matters is in `action`. Disarm goes to the runner host, because stopping a bot
// is bookkeeping the app owns. Cancel, close and flatten go through the runner CHILD, because
// the child is the only process in the tree holding a key that can place an order. Signing a
// human's close in this process would put a second copy of that key in a second process to save
// one IPC hop, which is a bad trade.

import { createTradeView, type TradeViewState } from './view.ts';
import { buildTradePayload, buildTradeRead, type TradePayload } from './state.ts';
import { createTradeFeed } from './feed-ws.ts';
import type { InfoClient } from '../hl/info.ts';
import type { ManualAction, RunnerEvent } from '../runner/host.ts';
import type { Mandate } from '../strategy/envelope.ts';
import type { Program } from '../strategy/grammar.ts';
import type { Network } from '../types.ts';

export type AssetMeta = { name: string; szDecimals: number; maxLeverage: number; assetId: number };

// What the service needs from the runner. Deliberately narrower than the host's full surface:
// this module can stop a bot and reduce a position, and there is no way to ask it to arm one.
// Arming goes through the proposal path and a human click, and the type says so.
export type TradeRunner = {
  status(): { armed: { id: string; symbol: string; since: string }[]; running: boolean };
  disarm(id: string, reason: string): Promise<{ ok: boolean; detail: string }>;
  manual(action: ManualAction): Promise<{ ok: boolean; detail: string }>;
  events(): RunnerEvent[];
  armedDetail(): { mandate: Mandate; program: Program | null; since: string }[];
};

export type TradeService = {
  view: ReturnType<typeof createTradeView>;
  payload(): TradePayload;
  read(symbol?: string): unknown;
  batch(ops: unknown[]): unknown;
  action(a: { action: string; id?: string; coin?: string }): Promise<{ ok: boolean; detail: string }>;
  onUpdate(fn: () => void): void;
  stop(): void;
};

export type TradeServiceDeps = {
  wsUrl: string;
  user: string;
  // The TRADING network, cfg.tradingNetwork, which is the one value the runner and this
  // surface both read. The page prints it beside the collateral because a balance means
  // nothing without the venue it is on, and testnet money read as mainnet money is the
  // cheapest way to arm a bot against nothing.
  network: Network;
  info: InfoClient;
  runner: TradeRunner;
  products: string[];
  // Volatility for the liquidation-distance figure. Supplied by the app so the risk panel and
  // the chart cannot disagree about how much a market moves: one ATR implementation, two
  // consumers, which is the same rule the indicators already follow.
  atrFor: (coin: string) => number | null;
  initialSymbol: string;
};

const BATCH_OPS = ['account', 'positions', 'orders', 'fills', 'mandates', 'market', 'venue_health'] as const;

function coinOf(product: string): string {
  return product.split('-')[0].toUpperCase();
}

export function createTradeService(deps: TradeServiceDeps): TradeService {
  const view = createTradeView(deps.initialSymbol);
  const feed = createTradeFeed({ wsUrl: deps.wsUrl, user: deps.user, info: deps.info });
  const meta = new Map<string, AssetMeta>();
  const listeners: Array<() => void> = [];

  // Asset ids and decimals are constant under a running process, so they are read once over
  // REST rather than re-read on a socket that is carrying price. A failure here is not fatal:
  // the surface renders without them and says so, because a missing szDecimals stops an order
  // from being placed and does not stop a human from seeing their position.
  void deps.info
    .post<{ universe: { name: string; szDecimals: number; maxLeverage: number }[] }>({ type: 'meta' })
    .then((m) => {
      m.universe.forEach((a, assetId) => {
        meta.set(a.name.toUpperCase(), { ...a, assetId });
      });
      notify();
    })
    .catch(() => undefined);

  function notify(): void {
    for (const fn of listeners) fn();
  }

  feed.onUpdate(notify);

  // Subscribed at construction rather than on the first render.
  //
  // watch() used to be called only from payload(), so the per-coin subscriptions did not exist
  // until something asked for a payload, and the first thing to ask got a snapshot with no
  // market and no collateral in it. That is the browser's very first paint. Subscribing here
  // means the socket has been asking since boot and the first render has real numbers.
  feed.watch([view.state().symbol]);

  // Every armed symbol, plus whatever the human is looking at. Watching only the armed ones
  // would leave the screen blank on a market the person is deciding about, which is exactly
  // when they want the numbers.
  function watched(): string[] {
    const set = new Set<string>([view.state().symbol]);
    for (const a of deps.runner.status().armed) set.add(a.symbol.toUpperCase());
    return [...set].filter((s) => s !== '');
  }

  // What each armed mandate has actually done since it armed.
  //
  // Realised profit is summed from the venue's own fills rather than tracked in the app, and
  // that is the point: the number the loss bar fills against is the number the exchange booked,
  // not our arithmetic about what we think we did. The window is the mandate's arm time, so a
  // position carried in from before it armed does not count against its allowance.
  //
  // The last rule fired and the reason a bot halted come off the runner's event ring, which is
  // the only place either exists: the child reports them and nothing else stores them.
  function mandateStatuses() {
    const running = deps.runner.status().running;
    const events = deps.runner.events();
    const fills = feed.fills();

    return deps.runner.armedDetail().map((a) => {
      const sinceMs = Date.parse(a.since);
      const realisedUsd = fills
        .filter((f) => f.coin.toUpperCase() === a.mandate.symbol.toUpperCase() && f.atMs >= sinceMs)
        .reduce((sum, f) => sum + (f.closedPnlUsd ?? 0) - f.feeUsd, 0);

      let lastRule: { id: string; at: string; action: string } | null = null;
      let haltedReason: string | null = null;
      // Walked newest first so the first match is the most recent, which is what both fields
      // mean. The ring is 200 entries, so this is cheap enough to do on every render.
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (lastRule === null && e.type === 'rule' && e.id === a.mandate.id) {
          lastRule = { id: e.ruleId, at: e.at, action: 'fired' };
        }
        if (haltedReason === null && e.type === 'halted' && e.id === a.mandate.id) {
          haltedReason = e.reason;
        }
        if (lastRule !== null && haltedReason !== null) break;
      }

      return {
        mandate: a.mandate,
        program: a.program,
        armed: true,
        running,
        since: a.since,
        realisedUsd,
        lastRule,
        haltedReason,
      };
    });
  }

  function payload(): TradePayload {
    feed.watch(watched());
    return buildTradePayload({
      view: view.state() as TradeViewState,
      feed,
      mandates: mandateStatuses(),
      meta,
      atrFor: deps.atrFor,
      products: deps.products,
      nowMs: Date.now(),
      network: deps.network,
      address: deps.user,
    });
  }

  // Resolving a human's click into something the child can sign. The order list comes from the
  // feed rather than from the browser, so a stale page cannot cancel an order that is no longer
  // the one it was looking at: the oid is checked against what is actually resting now.
  function cancelsFor(p: TradePayload, opts: { oid?: number; coin?: string }): { assetId: number; oid: number }[] {
    return p.orders
      .filter((o) => (opts.oid !== undefined ? o.oid === opts.oid : coinOf(o.coin) === opts.coin))
      .map((o) => {
        const m = meta.get(coinOf(o.coin));
        return m === undefined ? null : { assetId: m.assetId, oid: o.oid };
      })
      .filter((c): c is { assetId: number; oid: number } => c !== null);
  }

  return {
    view,

    payload,

    read(symbol) {
      const p = payload();
      if (symbol === undefined) return buildTradeRead(p);
      const coin = coinOf(symbol);
      return buildTradeRead({
        ...p,
        positions: p.positions.filter((x) => coinOf(x.coin) === coin),
        orders: p.orders.filter((x) => coinOf(x.coin) === coin),
        fills: p.fills.filter((x) => coinOf(x.coin) === coin),
        mandates: p.mandates.filter((x) => coinOf(x.symbol) === coin),
      });
    },

    // Same shape as chart_batch: one failing entry does not stop the rest, and each result
    // carries the op that produced it so an agent reading the array back knows what it is
    // looking at without counting positions.
    batch(ops) {
      const p = payload();
      return {
        results: ops.map((raw, i) => {
          const entry = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          const op = String(entry.op ?? '');
          const args = (entry.args !== null && typeof entry.args === 'object' ? entry.args : {}) as Record<string, unknown>;
          const as = typeof entry.as === 'string' ? entry.as : `r${i}`;
          if (!(BATCH_OPS as readonly string[]).includes(op)) {
            return { as, op, error: `unknown op: ${op}. known ops: ${BATCH_OPS.join(', ')}` };
          }
          const coin = typeof args.coin === 'string' ? coinOf(args.coin) : typeof args.symbol === 'string' ? coinOf(args.symbol) : null;
          const only = <T extends { coin: string }>(rows: T[]): T[] =>
            coin === null ? rows : rows.filter((r) => coinOf(r.coin) === coin);

          if (op === 'account') return { as, op, account: p.account };
          if (op === 'positions') return { as, op, positions: only(p.positions) };
          if (op === 'orders') return { as, op, orders: only(p.orders) };
          if (op === 'fills') {
            const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : 50;
            return { as, op, fills: only(p.fills).slice(0, limit) };
          }
          if (op === 'mandates') {
            return { as, op, mandates: coin === null ? p.mandates : p.mandates.filter((m) => coinOf(m.symbol) === coin) };
          }
          if (op === 'market') return { as, op, markets: coin === null ? p.markets : p.markets.filter((m) => coinOf(m.coin) === coin) };
          return { as, op, venue: p.venue };
        }),
      };
    },

    async action({ action, id, coin }) {
      if (action === 'disarm') {
        if (id === undefined) return { ok: false, detail: 'disarm needs a mandate id' };
        return await deps.runner.disarm(id, 'stopped by the human');
      }

      if (action === 'flatten') {
        // Name every market currently holding a position. The runner child can only close a
        // coin it has a book for, and its book pump follows ARMED mandates, so a flatten with
        // nothing armed would otherwise reach an empty book and report success having closed
        // nothing. Observed live, which is the worst way to learn that a brake reports itself.
        const coins = [...new Set(payload().positions.map((p) => coinOf(p.coin)))];
        return await deps.runner.manual({ verb: 'flatten', coins });
      }

      if (action === 'close') {
        if (coin === undefined) return { ok: false, detail: 'close needs a market' };
        return await deps.runner.manual({ verb: 'close', coin: coinOf(coin) });
      }

      const p = payload();
      if (action === 'cancel') {
        const oid = Number(id);
        if (!Number.isFinite(oid)) return { ok: false, detail: 'cancel needs an order id' };
        const cancels = cancelsFor(p, { oid });
        if (cancels.length === 0) return { ok: false, detail: `order ${id} is not resting: it filled or was already cancelled` };
        return await deps.runner.manual({ verb: 'cancel', cancels });
      }

      // cancel_all
      if (coin === undefined) return { ok: false, detail: 'cancel all needs a market' };
      const cancels = cancelsFor(p, { coin: coinOf(coin) });
      if (cancels.length === 0) return { ok: true, detail: `nothing working on ${coinOf(coin)}` };
      return await deps.runner.manual({ verb: 'cancel_all', cancels });
    },

    onUpdate(fn) {
      listeners.push(fn);
    },

    stop() {
      feed.stop();
    },
  };
}
