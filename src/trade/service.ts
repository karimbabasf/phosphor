// The trading surface as one object the server can call.
//
// Three things are joined here and nowhere else: the view state the agent and the human both
// write, the venue feed, and the runner that holds the plans. The server does not know about
// any of them individually, which keeps the HTTP layer a router rather than a second place
// where trading logic lives.
//
// The feed is pushed INTO the runner from here on every update: positions, resting orders and
// fills, which is what moves a plan from placed to open to done. The runner never reads the
// venue for that on its own, so there is one view of the account across the process tree and
// the screen and the thing that acts cannot disagree about what is open.
//
// The human's buttons (cancel, close, flatten) go through the runner too, because the runner
// child is the only process in the tree holding a key that can place an order.

import { createTradeView, type TradeViewState } from './view.ts';
import { buildTradePayload, buildTradeRead, type TradePayload } from './state.ts';
import { createTradeFeed } from './feed-ws.ts';
import type { FeedSocket } from './feed-ws.ts';
import type { InfoClient } from '../hl/info.ts';
import type { AccountView, PlanRunner } from '../runner/host.ts';
import type { AssetMeta as RunnerMeta } from '../runner/protocol.ts';
import { validatePlanInput } from './plan.ts';
import type { PlanRow } from './plans.ts';
import { planRisk } from './risk.ts';
import { riskInputsFor } from './rail.ts';
import type { PricingDeps } from './rail.ts';

export type AssetMeta = { name: string; szDecimals: number; maxLeverage: number; assetId: number };

// What the service needs from the runner. Deliberately narrower than the host's full surface:
// this module can draw an idea, and reduce or cancel a plan, and there is no way to ask it to
// arm one. Arming goes through the proposal path and the policy, and the type says so.
export type TradeRunner = Pick<
  PlanRunner,
  'status' | 'plans' | 'get' | 'draw' | 'redraw' | 'erase' | 'cancel' | 'close' | 'flatten' | 'onAccount' | 'events'
>;

// The human door's close bound. Wide on purpose: a person pressing close means out, not out at
// a good price, and a fill that does not happen because the bound was tight is the worse outcome.
export const HUMAN_CLOSE_BPS = 100;

export type TradeService = {
  view: ReturnType<typeof createTradeView>;
  payload(): TradePayload;
  read(symbol?: string): unknown;
  batch(ops: unknown[]): unknown;
  // The agent's idea: draw, change or remove a plan that has no authority.
  plan(args: Record<string, unknown>, by: string | null): { ok: true; notes: string[]; row: PlanRow | null } | { ok: false; error: string };
  action(a: { action: string; id?: string }): Promise<{ ok: boolean; detail: string }>;
  // The venue facts a plan is priced against, for the rail and the proposal service.
  meta(coin: string): RunnerMeta | null;
  mark(coin: string): number | null;
  free(): number | null;
  onUpdate(fn: () => void): void;
  stop(): void;
};

export type TradeServiceDeps = {
  wsUrl: string;
  // A function is asked per read, so the account follows a wallet created after boot (see
  // createTradeFeed); a string is fixed for the life of the process.
  user: string | (() => string);
  info: InfoClient;
  runner: TradeRunner;
  products: string[];
  // Volatility for the liquidation-distance figure. Supplied by the app so the risk panel and
  // the chart cannot disagree about how much a market moves: one ATR implementation, two
  // consumers, which is the same rule the indicators already follow.
  atrFor: (coin: string) => number | null;
  initialSymbol: string;
  now?: () => number;
  // Test seam, handed straight to the feed: the socket is the one thing in here a test cannot
  // reason about offline.
  wsImpl?: (url: string) => FeedSocket;
};

export const IDEAS_PER_SESSION = 20;

const BATCH_OPS = ['account', 'positions', 'orders', 'fills', 'plans', 'market', 'venue_health'] as const;

function coinOf(product: string): string {
  return product.split('-')[0].toUpperCase();
}

export function createTradeService(deps: TradeServiceDeps): TradeService {
  const now = deps.now ?? Date.now;
  const view = createTradeView(deps.initialSymbol);
  const feed = createTradeFeed({ wsUrl: deps.wsUrl, user: deps.user, info: deps.info, ...(deps.wsImpl !== undefined ? { wsImpl: deps.wsImpl } : {}) });
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

  /* THE ACCOUNT, HANDED TO THE THING THAT ACTS ON IT.
     Pushed on every feed update rather than read inside a render, because a plan whose entry
     filled while nobody was looking at the trading screen still has to be protected. This is
     the one input the runner has for positions, resting orders and fills. */
  function pushAccount(): void {
    const snapshot = feed.account();
    if (snapshot === null) return;
    const account: AccountView = {
      atMs: snapshot.atMs,
      freeUsd: snapshot.freeUsd,
      positions: snapshot.positions.map((p) => ({ coin: p.coin, szi: p.szi, entryPx: p.entryPx })),
      orders: feed.orders().map((o) => ({ coin: o.coin, cloid: o.cloid })),
      fills: feed.fills().map((f) => ({ coin: f.coin, px: f.px, sizeCoin: f.sizeCoin, atMs: f.atMs, closedPnlUsd: f.closedPnlUsd })),
    };
    deps.runner.onAccount(account);
  }

  function notify(): void {
    pushAccount();
    for (const fn of listeners) fn();
  }

  feed.onUpdate(notify);

  // Subscribed at construction rather than on the first render, so the socket has been asking
  // since boot and the first paint has real numbers.
  feed.watch([view.state().symbol]);

  // Every live plan's coin, plus whatever the human is looking at. Watching only the plan coins
  // would leave the screen blank on a market the person is deciding about, which is exactly
  // when they want the numbers.
  function watched(): string[] {
    const set = new Set<string>([view.state().symbol]);
    for (const coin of deps.runner.status().watching) set.add(coin.toUpperCase());
    return [...set].filter((s) => s !== '');
  }

  function markOf(coin: string): number | null {
    const ctx = feed.market(coin.toUpperCase());
    return ctx === null || !Number.isFinite(ctx.markPx) ? null : ctx.markPx;
  }

  function metaOf(coin: string): RunnerMeta | null {
    const m = meta.get(coin.toUpperCase());
    return m === undefined ? null : { assetId: m.assetId, szDecimals: m.szDecimals, maxLeverage: m.maxLeverage };
  }

  function freeUsd(): number | null {
    const snapshot = feed.account();
    return snapshot === null ? null : snapshot.freeUsd;
  }

  function payload(): TradePayload {
    feed.watch(watched());
    return buildTradePayload({
      view: view.state() as TradeViewState,
      feed,
      plans: deps.runner.plans(),
      meta,
      atrFor: deps.atrFor,
      products: deps.products,
      nowMs: now(),
      address: typeof deps.user === 'function' ? deps.user() : deps.user,
    });
  }

  const pricing: PricingDeps = { runner: deps.runner, meta: metaOf, mark: markOf, free: freeUsd };

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
        plans: p.plans.filter((x) => coinOf(x.symbol) === coin),
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
          if (op === 'plans') {
            const read = buildTradeRead(p).plans;
            return { as, op, plans: coin === null ? read : read.filter((r) => coinOf(r.symbol) === coin) };
          }
          if (op === 'market') return { as, op, markets: coin === null ? p.markets : p.markets.filter((m) => coinOf(m.coin) === coin) };
          return { as, op, venue: p.venue };
        }),
      };
    },

    /* An idea: a plan drawn on the chart with no authority. `plan` draws a new one, `planId`
       plus `changes` edits a drawn one, `planId` plus `remove` takes it off. Only an idea can
       be edited or removed here: once armed, every change goes through propose_trade_change.
       The risk figure is priced where a mark is known, so the idea shows what it would cost
       before anyone proposes it. */
    plan(args, by) {
      const planId = typeof args.planId === 'string' ? args.planId : null;
      if (planId !== null) {
        if (args.remove === true) {
          const out = deps.runner.erase(planId);
          return out.ok ? { ok: true, notes: [out.reason], row: null } : { ok: false, error: out.reason };
        }
        const changes = args.changes !== null && typeof args.changes === 'object' ? (args.changes as Record<string, unknown>) : null;
        if (changes === null) return { ok: false, error: 'planId needs changes to apply, or remove: true' };
        const out = deps.runner.redraw(planId, changes);
        if (!out.ok) return { ok: false, error: out.reason };
        priceIdea(out.row);
        return { ok: true, notes: [`${planId} redrawn`], row: out.row };
      }
      const parsed = validatePlanInput(args.plan, now());
      if (!parsed.ok) return { ok: false, error: parsed.errors.join('; ') };
      // Ideas are the one row an agent can mint without a wall, so they are capped per session:
      // every draw rewrites plans.json and rides in every payload, and twenty is more than a
      // person can read on one chart.
      const mine = deps.runner.plans().filter((r) => r.status === 'idea' && r.by === by).length;
      if (mine >= IDEAS_PER_SESSION) return { ok: false, error: `${IDEAS_PER_SESSION} ideas are drawn already; remove one with trade_plan { planId, remove: true } first` };
      const row = deps.runner.draw(parsed.plan, by);
      const notes = [`${row.id} drawn on ${row.symbol}`];
      const priced = priceIdea(row);
      if (priced !== null) notes.push(priced);
      return { ok: true, notes, row };
    },

    // The human's buttons. Every verb only reduces, which is why none of them consults the
    // policy and none waits on an approval. Close is at a hundred basis points, the human's
    // own bound; the agent's close goes through a proposal at the plan's bound.
    async action({ action, id }) {
      if (action === 'flatten') return deps.runner.flatten();
      if (id === undefined) return { ok: false, detail: `${action} needs a plan id` };
      if (action === 'cancel') return deps.runner.cancel(id);
      if (action === 'close') return deps.runner.close(id, HUMAN_CLOSE_BPS);
      return { ok: false, detail: `unknown action ${action}` };
    },

    meta: metaOf,
    mark: markOf,
    free: freeUsd,

    onUpdate(fn) {
      listeners.push(fn);
    },

    stop() {
      feed.stop();
    },
  };

  // An idea carries the risk figure the card would show, when the market is known; a refusal
  // is a note on the idea rather than a reason not to draw it, because a plan can be drawn
  // before its coin has answered.
  function priceIdea(row: PlanRow): string | null {
    const plan = { id: row.id, symbol: row.symbol, side: row.side, sizeUsd: row.sizeUsd, leverage: row.leverage, entry: row.entry, stop: row.stop, target: row.target, when: row.when, expiresAt: row.expiresAt, note: row.note };
    const out = planRisk(plan, riskInputsFor(pricing, plan, row.id));
    if (out.ok) {
      row.risk = out.risk;
      return null;
    }
    delete row.risk;
    return `not yet placeable: ${out.refusal}`;
  }
}
