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
import { chainSpec, erc20Balance, evmAddress } from '../chain/evm.ts';
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
  // The floor between two proposals, whatever the tick rate is. See the comment on
  // PROPOSE_COOLDOWN_MS.
  proposeCooldownMs?: number;
  // A cross-venue move may not happen more often than this, whatever the spread says.
  minRebalanceHours?: number;
  nowMs?: () => number;
};

const SYMBOL = 'USDC';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_DUST_USD = 5;
const MAX_DECISIONS = 20;

// The tick rate is how often the loop LOOKS. This is how often it may ACT, and they have to
// be different numbers.
//
// Without this the loop re-files the same proposal every single tick for as long as the
// condition holds. A deposit that keeps failing (a frozen reserve, gas exhausted, an RPC
// flapping, the session cap reached) leaves the idle balance exactly where it was, so the
// next tick sees the same money and proposes again, once a minute, forever. Three things go
// wrong and none of them announces itself: proposals.json rewrites its whole array on every
// put, so the disk cost is quadratic; the audit log fills with identical lines; and if the
// approve lands and only the supply reverts, that is one real gas payment per minute for as
// long as nobody is watching.
//
// Fifteen minutes because a lending rate does not move faster than that, so nothing is lost
// by waiting, and a human who is watching gets a legible loop rather than a firehose.
export const PROPOSE_COOLDOWN_MS = 15 * 60_000;

// Consecutive failures back the loop off further, doubling to a four hour ceiling. A loop
// that cannot act is a loop that should ask less often, and the state it is waiting on
// (a thawed reserve, a refilled gas balance) is not one that changes in a minute.
export const MAX_BACKOFF_MS = 4 * 60 * 60_000;

// A cross-venue move may not happen more often than this, whatever the spread says. The
// economics test below already refuses a move that does not pay for itself, and this is the
// second brake: two rates that cross back and forth over a threshold would otherwise have
// the loop paying to chase them each way.
const DEFAULT_MIN_REBALANCE_HOURS = 24;

// How long the loop must wait before acting again, given how many times acting has just
// failed. Exported so a test can pin the curve rather than infer it.
export function backoffMs(failureStreak: number, base = PROPOSE_COOLDOWN_MS): number {
  if (failureStreak <= 0) return base;
  return Math.min(base * 2 ** Math.min(failureStreak, 5), MAX_BACKOFF_MS);
}

// May the loop file something right now?
//
// A separate function rather than an inline check inside tick(), because it is the rule that
// stops the loop spending money in a circle and a rule like that should be assertable without
// standing up a chain, a key and a proposal service. tick() calls exactly this.
export type ActionGate = { allowed: boolean; waitMs: number; sinceMs: number };

export function actionGate(args: {
  lastProposalAtMs: number | null;
  failureStreak: number;
  nowMs: number;
  baseCooldownMs?: number;
}): ActionGate {
  const waitMs = backoffMs(args.failureStreak, args.baseCooldownMs ?? PROPOSE_COOLDOWN_MS);
  const sinceMs = args.lastProposalAtMs === null ? Infinity : args.nowMs - args.lastProposalAtMs;
  return { allowed: sinceMs >= waitMs, waitMs, sinceMs };
}

// Whether a proposal coming back means "do not immediately try that again".
//
// 'pending' is NOT a failure: it means a human was asked and has not answered yet, and backing
// off on it would punish the approval gate for working exactly as designed.
export function countsAsFailure(status: string): boolean {
  return status !== 'executed' && status !== 'pending';
}

// Where idle money should go, given what every venue is paying and how much is sitting on
// each chain doing nothing.
//
// ANY healthy chain, not only the best-paying one. Depositing where the money already IS
// needs no bridge and is purely local, so refusing it because a different chain pays ten
// basis points more leaves the money earning zero to protect a rounding error. Best-paying
// first among the candidates, so a tie still lands in the right place. Where to move money
// that is ALREADY working is a different question with a different answer.
export function pickIdleVenue(venues: VenueQuote[], dustUsd: number): VenueQuote | undefined {
  return venues
    .filter((v) => v.healthy && v.rate !== null && v.idleUsd >= dustUsd)
    .sort((a, b) => (b.rate as VenueRate).apy - (a.rate as VenueRate).apy)[0];
}

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
  const proposeCooldownMs = deps.proposeCooldownMs ?? PROPOSE_COOLDOWN_MS;
  const minRebalanceHours = deps.minRebalanceHours ?? DEFAULT_MIN_REBALANCE_HOURS;
  const now = deps.nowMs ?? (() => Date.now());

  let timer: NodeJS.Timeout | null = null;
  // When the loop last FILED something, and how many times in a row that has not worked.
  // Both are deliberately in memory rather than on disk: a restart is a human intervening,
  // and a human who has just restarted the app should not be made to wait out a backoff.
  let lastProposalAtMs: number | null = null;
  let lastMoveAtMs: number | null = null;
  let failureStreak = 0;
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
    // Broadcast here as well as in refresh(). refresh() runs BEFORE the decision is recorded,
    // so without this the panel always showed the PREVIOUS tick's reasoning and the current
    // one arrived up to a minute late, which reads as a loop that is not thinking.
    deps.onChange?.();
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
      explorerTx: chainSpec(cfg.network, chain).explorerTx,
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

    // The cooldown is checked BEFORE any branch that could file something, so it covers the
    // deposit path and the rebalance path with one rule rather than two that can disagree.
    const gate = actionGate({ lastProposalAtMs, failureStreak, nowMs: now(), baseCooldownMs: proposeCooldownMs });
    const wait = gate.waitMs;
    const since = gate.sinceMs;
    const cooling = !gate.allowed;

    // 1. Idle money first. Money sitting in the wallet earns nothing, and that is the
    //    largest and most certain improvement available at any tick.
    //
    //    Any healthy chain, not only the best-paying one. Depositing where the money already
    //    IS needs no bridge and is purely local, so refusing it because a different chain pays
    //    ten basis points more leaves the money earning zero to protect a rounding error. The
    //    old version also then reported "nothing above the dust floor is idle", which was
    //    simply false while $500 sat on the wrong chain. Best-paying first among equals, so a
    //    tie still lands in the right place; where to move money that is ALREADY working is a
    //    separate question, handled below.
    const idleHere = pickIdleVenue(view.venues, dustUsd);
    if (idleHere !== undefined) {
      if (cooling) {
        return record({
          at,
          action: 'idle',
          detail:
            `$${idleHere.idleUsd.toFixed(2)} is idle on ${idleHere.chain}, but the last proposal was ` +
            `${Math.round(since / 60_000)} minutes ago and the loop waits ${Math.round(wait / 60_000)} ` +
            `minutes between actions${failureStreak > 0 ? ` (backed off after ${failureStreak} failed attempt(s))` : ''}.`,
          proposalId: null,
        });
      }
      if (!autoAllocate) {
        return record({
          at,
          action: 'idle',
          detail:
            `$${idleHere.idleUsd.toFixed(2)} of ${SYMBOL} is idle on ${idleHere.chain}, where Aave pays ` +
            `${(((idleHere.rate as VenueRate).apy) * 100).toFixed(2)}%, but automatic allocation is off, so nothing was proposed.`,
          proposalId: null,
        });
      }
      try {
        const p = await deps.propose.yieldDeposit({ chain: idleHere.chain, symbol: SYMBOL, amount: idleHere.idleUsd });
        lastProposalAtMs = now();
        failureStreak = countsAsFailure(p.status) ? failureStreak + 1 : 0;
        return record({
          at,
          action: p.status === 'executed' ? 'deposited' : 'proposed',
          detail:
            `$${idleHere.idleUsd.toFixed(2)} idle on ${idleHere.chain}, proposed into Aave v3 at ` +
            `${(((idleHere.rate as VenueRate).apy) * 100).toFixed(2)}%. Proposal is ${p.status}.`,
          proposalId: p.id,
        });
      } catch (err) {
        lastProposalAtMs = now();
        failureStreak += 1;
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
    // The second brake on a move, independent of whether it pays. Two rates that cross back
    // and forth over a threshold would otherwise have the loop paying to chase them each way.
    const sinceMove = lastMoveAtMs === null ? Infinity : now() - lastMoveAtMs;
    if (sinceMove < minRebalanceHours * 3_600_000) {
      return record({
        at,
        action: 'rebalance_refused',
        detail: `moved venues ${Math.round(sinceMove / 3_600_000)} hours ago; the loop moves at most once every ${minRebalanceHours} hours.`,
        proposalId: null,
      });
    }

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
