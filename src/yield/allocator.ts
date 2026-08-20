// The loop that watches the yield venues and decides whether money should move.
//
// It is a timer inside the app process, not a child, and that is a deliberate difference
// from src/runner/host.ts. The mandate runner is a child process because a perp order must
// not queue behind an SSE broadcast and a stop has to be absolute. Neither applies here:
// lending rates move on the scale of hours, and the only thing this loop can do is file a
// proposal that something else decides on.
//
// THE LOOP NEVER EXECUTES. It calls proposeYieldDeposit and nothing else. What happens next
// is the policy engine's call and, above the click threshold, a human's. That is the whole
// architecture of this app and an automated allocator is exactly the component that would be
// most tempting to give an exception to, which is why it does not get one.
//
// It also owns the read side. buildState() in src/server.ts is synchronous and a position
// lives on a chain, so something has to hold a recent answer for the window to render. The
// ledger already solves this the same way for balances and LP positions: a background refresh
// fills a snapshot, and a failed read marks stale rather than reporting zero. A yield panel
// that showed $0.00 because an RPC blinked would be the worst possible lie for this feature.

import type { AppConfig, ChainId, Proposal } from '../types.ts';
import { erc20Balance, evmAddress } from '../chain/evm.ts';
import { getAddress } from 'viem';
import { aaveAsset, aaveChains, aaveHealth, aavePosition, aaveRate } from './aave.ts';
import type { VenueId, VenueRate } from './venue.ts';
import { fromBaseUnits } from './venue.ts';
import { creditsFor, openedAtFrom, principalFrom, realizedFrom } from './positions.ts';
import type { YieldHolding } from './positions.ts';

export type VenueQuote = {
  venue: VenueId;
  chain: ChainId;
  symbol: string;
  rate: VenueRate | null;
  healthy: boolean;
  note: string; // why it is not healthy, when it is not
  idleBase: string; // wallet balance of the asset on this chain, not yet working
  idleUsd: number;
};

// What the loop decided this tick, in words, so the window can show its reasoning rather
// than only its actions. A loop whose refusals are invisible looks broken when it is right.
export type AllocatorDecision = {
  at: string;
  action: 'deposited' | 'proposed' | 'rebalance_refused' | 'idle' | 'error';
  detail: string;
  proposalId: string | null;
};

export type YieldView = {
  network: string;
  chain: ChainId | null; // where the money currently is, when it is anywhere
  positions: YieldHolding[];
  venues: VenueQuote[];
  totalPrincipalUsd: number;
  totalValueUsd: number;
  totalEarnedUsd: number;
  best: { chain: ChainId; apy: number } | null;
  autoAllocate: boolean;
  lastTickAt: string | null;
  decisions: AllocatorDecision[]; // newest first, capped
  stale: boolean; // the last refresh failed; the numbers below are the previous good read
  error: string | null;
};

export type Allocator = {
  view(): YieldView;
  refresh(): Promise<YieldView>;
  tick(): Promise<AllocatorDecision>;
  start(): void;
  stop(): void;
};

export type AllocatorDeps = {
  cfg: AppConfig;
  // Only the two methods this loop is allowed to reach. Handing it the whole proposal
  // service would put propose_policy_change and approve() one dot away from an automated
  // loop, and a narrow handle is cheaper than trusting it not to.
  propose: {
    yieldDeposit(params: { chain: ChainId; symbol?: string; amount: number }): Promise<Proposal>;
  };
  listProposals(): Proposal[];
  onChange?: () => void;
  intervalMs?: number;
  // Below this, an idle balance is not worth a transaction. Gas on an L2 is cents, but a
  // deposit is two transactions and a dust deposit still costs a human an approval click.
  dustUsd?: number;
  autoAllocate?: boolean;
  nowMs?: () => number;
};

const SYMBOL = 'USDC';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_DUST_USD = 5;
const MAX_DECISIONS = 20;

// The horizon a rebalance has to pay back inside. Thirty days is not a guess about how long
// the money stays; it is the length of time over which a rate difference is allowed to be
// treated as durable. A spread that needs longer than a month to repay its own gas is a
// spread the loop should not be chasing, because it will have changed.
export const REBALANCE_HORIZON_DAYS = 30;

// The cheapest possible statement of the economics, and it is the whole reason this loop is
// not just "always move to the highest rate". Exported and tested on its own.
export function rebalanceWorthIt(args: {
  principalUsd: number;
  currentApy: number;
  bestApy: number;
  moveCostUsd: number;
  horizonDays?: number;
}): { worth: boolean; gainUsd: number; reason: string } {
  const horizon = args.horizonDays ?? REBALANCE_HORIZON_DAYS;
  const spread = args.bestApy - args.currentApy;
  const gainUsd = args.principalUsd * spread * (horizon / 365);
  if (spread <= 0) {
    return { worth: false, gainUsd, reason: 'the venue we are in is already the best one reachable' };
  }
  if (gainUsd <= args.moveCostUsd) {
    return {
      worth: false,
      gainUsd,
      reason:
        `moving would earn about $${gainUsd.toFixed(4)} more over ${horizon} days and cost about ` +
        `$${args.moveCostUsd.toFixed(4)} to do, so it loses money`,
    };
  }
  return {
    worth: true,
    gainUsd,
    reason: `moving earns about $${gainUsd.toFixed(4)} more over ${horizon} days against about $${args.moveCostUsd.toFixed(4)} of cost`,
  };
}

export function createAllocator(deps: AllocatorDeps): Allocator {
  const cfg = deps.cfg;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const dustUsd = deps.dustUsd ?? DEFAULT_DUST_USD;
  const autoAllocate = deps.autoAllocate ?? false;
  const now = deps.nowMs ?? (() => Date.now());

  let timer: NodeJS.Timeout | null = null;
  const decisions: AllocatorDecision[] = [];

  let current: YieldView = {
    network: cfg.network,
    chain: null,
    positions: [],
    venues: [],
    totalPrincipalUsd: 0,
    totalValueUsd: 0,
    totalEarnedUsd: 0,
    best: null,
    autoAllocate,
    lastTickAt: null,
    decisions: [],
    stale: false,
    error: null,
  };

  function record(d: AllocatorDecision): AllocatorDecision {
    decisions.unshift(d);
    if (decisions.length > MAX_DECISIONS) decisions.length = MAX_DECISIONS;
    current = { ...current, decisions: [...decisions] };
    return d;
  }

  // One chain's worth of truth, read live. Errors are caught per chain rather than for the
  // whole sweep: one dead RPC must not blank a position on a chain that answered.
  async function readChain(chain: ChainId, owner: string, proposals: Proposal[]): Promise<{ quote: VenueQuote; holding: YieldHolding | null }> {
    const asset = aaveAsset(cfg.network, chain, SYMBOL);
    if (asset === null) {
      return {
        quote: { venue: 'aave-v3', chain, symbol: SYMBOL, rate: null, healthy: false, note: 'no verified market', idleBase: '0', idleUsd: 0 },
        holding: null,
      };
    }

    let rate: VenueRate | null = null;
    let healthy = false;
    let note = '';
    let position = { balanceBase: 0n, scaledBase: 0n, indexRay: 0n };
    let idleBase = 0n;

    try {
      const [r, health, pos, idle] = await Promise.all([
        aaveRate(cfg.network, chain, SYMBOL),
        aaveHealth(cfg.network, chain, SYMBOL),
        aavePosition(cfg.network, chain, SYMBOL, owner),
        erc20Balance(cfg.network, chain, getAddress(asset.address), getAddress(owner)),
      ]);
      rate = r;
      position = pos;
      idleBase = idle;
      healthy = health.active && !health.frozen && !health.paused;
      note = healthy ? '' : !health.active ? 'reserve not active' : health.paused ? 'reserve paused' : 'reserve frozen';
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    }

    const quote: VenueQuote = {
      venue: 'aave-v3',
      chain,
      symbol: SYMBOL,
      rate,
      healthy,
      note,
      idleBase: idleBase.toString(),
      idleUsd: fromBaseUnits(idleBase, asset.decimals),
    };

    if (position.balanceBase === 0n) return { quote, holding: null };

    const credits = creditsFor(proposals, 'aave-v3', chain, SYMBOL);
    const principal = principalFrom(credits);
    const openedAt = openedAtFrom(credits);
    const earned = position.balanceBase - principal;

    const holding: YieldHolding = {
      venue: 'aave-v3',
      chain,
      symbol: SYMBOL,
      decimals: asset.decimals,
      receiptSymbol: asset.receiptSymbol,
      receipt: asset.receipt,
      principalBase: principal.toString(),
      valueBase: position.balanceBase.toString(),
      earnedBase: earned.toString(),
      principalUsd: fromBaseUnits(principal, asset.decimals),
      valueUsd: fromBaseUnits(position.balanceBase, asset.decimals),
      earnedUsd: fromBaseUnits(earned, asset.decimals),
      openedAt,
      credits: [...credits].reverse(),
      rate,
      realized: realizedFrom({
        credits,
        openedAt,
        earnedBase: earned,
        decimals: asset.decimals,
        // Stables are priced at exactly 1.0 here, which is what the rest of the app does and
        // is stated rather than assumed: a depegged dollar would make this figure wrong in
        // the same direction as every other dollar number on the screen.
        priceUsd: 1,
        nowMs: now(),
      }),
    };
    return { quote, holding };
  }

  async function refresh(): Promise<YieldView> {
    let owner: string;
    try {
      owner = evmAddress(cfg.keysPath);
    } catch (err) {
      current = { ...current, stale: true, error: err instanceof Error ? err.message : String(err) };
      return current;
    }

    const chains = aaveChains(cfg.network);
    const proposals = deps.listProposals();

    try {
      const results = await Promise.all(chains.map((c) => readChain(c, owner, proposals)));
      const venues = results.map((r) => r.quote);
      const positions = results.map((r) => r.holding).filter((h): h is YieldHolding => h !== null);

      const healthy = venues.filter((v) => v.healthy && v.rate !== null);
      const best =
        healthy.length === 0
          ? null
          : healthy.reduce((a, b) => ((b.rate as VenueRate).apy > (a.rate as VenueRate).apy ? b : a));

      current = {
        network: cfg.network,
        chain: positions[0]?.chain ?? null,
        positions,
        venues,
        totalPrincipalUsd: positions.reduce((s, p) => s + p.principalUsd, 0),
        totalValueUsd: positions.reduce((s, p) => s + p.valueUsd, 0),
        totalEarnedUsd: positions.reduce((s, p) => s + p.earnedUsd, 0),
        best: best === null ? null : { chain: best.chain, apy: (best.rate as VenueRate).apy },
        autoAllocate,
        lastTickAt: new Date(now()).toISOString(),
        decisions: [...decisions],
        stale: false,
        error: null,
      };
      deps.onChange?.();
      return current;
    } catch (err) {
      // Keep the previous numbers and mark them stale. A blanked panel reads as "you have
      // nothing", which is the one thing this panel must never say by accident.
      current = { ...current, stale: true, error: err instanceof Error ? err.message : String(err) };
      deps.onChange?.();
      return current;
    }
  }

  async function tick(): Promise<AllocatorDecision> {
    const view = await refresh();
    const at = new Date(now()).toISOString();

    if (view.error !== null) {
      return record({ at, action: 'error', detail: view.error, proposalId: null });
    }
    if (view.best === null) {
      return record({ at, action: 'idle', detail: 'no healthy venue is reachable right now', proposalId: null });
    }

    // 1. Idle money first. Money sitting in the wallet earns nothing, and that is the
    //    largest and most certain improvement available at any tick.
    const idleHere = view.venues.find((v) => v.chain === view.best?.chain && v.idleUsd >= dustUsd);
    if (idleHere !== undefined) {
      if (!autoAllocate) {
        return record({
          at,
          action: 'idle',
          detail:
            `$${idleHere.idleUsd.toFixed(2)} of ${SYMBOL} is idle on ${idleHere.chain} and the best venue pays ` +
            `${((view.best.apy) * 100).toFixed(2)}%, but automatic allocation is off, so nothing was proposed.`,
          proposalId: null,
        });
      }
      try {
        const p = await deps.propose.yieldDeposit({ chain: idleHere.chain, symbol: SYMBOL, amount: idleHere.idleUsd });
        return record({
          at,
          action: p.status === 'executed' ? 'deposited' : 'proposed',
          detail:
            `$${idleHere.idleUsd.toFixed(2)} idle on ${idleHere.chain}, proposed into Aave v3 at ` +
            `${((view.best.apy) * 100).toFixed(2)}%. Proposal is ${p.status}.`,
          proposalId: p.id,
        });
      } catch (err) {
        return record({ at, action: 'error', detail: err instanceof Error ? err.message : String(err), proposalId: null });
      }
    }

    // 2. Then the question of whether the money that IS working is in the right place.
    const held = view.positions[0];
    if (held === undefined) {
      return record({ at, action: 'idle', detail: 'nothing is deposited and nothing above the dust floor is idle', proposalId: null });
    }
    if (held.chain === view.best.chain) {
      return record({
        at,
        action: 'idle',
        detail: `already in the best reachable venue (${held.chain} at ${((held.rate?.apy ?? 0) * 100).toFixed(2)}%)`,
        proposalId: null,
      });
    }

    // A cross-chain move needs a bridge, and on testnet this app does not have one.
    //
    // NEAR Intents is the rail it would use, and it has no testnet: src/rails/index.ts says
    // so and the oneclick rail is mainnet-only. So the honest tick here reports the better
    // venue and refuses the move, which is a real refusal with a real reason rather than a
    // gap in the loop. The economics are computed anyway, because "we could not move" and
    // "moving would have lost money" are different facts and the window should show which.
    const verdict = rebalanceWorthIt({
      principalUsd: held.principalUsd,
      currentApy: held.rate?.apy ?? 0,
      bestApy: view.best.apy,
      moveCostUsd: crossChainCostUsd(held.principalUsd),
    });

    const bridge =
      cfg.network === 'testnet'
        ? ' There is no cross-chain rail on testnet: NEAR Intents is mainnet only, so this move cannot be made here at all.'
        : '';

    return record({
      at,
      action: 'rebalance_refused',
      detail:
        `${view.best.chain} pays ${(view.best.apy * 100).toFixed(2)}% against ${((held.rate?.apy ?? 0) * 100).toFixed(2)}% ` +
        `on ${held.chain}, but ${verdict.reason}.${bridge}`,
      proposalId: null,
    });
  }

  // What it costs to take money off one chain and put it on another, in dollars.
  //
  // Deliberately crude and deliberately pessimistic. It is two withdrawals, two deposits and
  // a bridge fee, and the bridge is the part that dominates: NEAR Intents charges roughly
  // 12 basis points on a stablecoin hop plus a gas leg on each side. Being wrong high here
  // means the loop sits still when it might have moved, and being wrong low means it churns
  // the money away in fees. One of those is recoverable.
  function crossChainCostUsd(principalUsd: number): number {
    const bridgeBps = 12;
    const gasLegsUsd = 0.4;
    return (principalUsd * bridgeBps) / 10_000 + gasLegsUsd;
  }

  return {
    view: () => current,
    refresh,
    tick,
    start(): void {
      if (timer !== null) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      // Never hold the process open for a rate check.
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
