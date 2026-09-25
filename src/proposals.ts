// The proposal service: the only path from an agent's intent to a signed transaction.
//
// An agent can author and propose. It cannot execute. Every proposal lands in exactly one of
// three places, decided by the policy engine and nothing else:
//   allow           -> executed immediately (only below the human click threshold)
//   needs_approval  -> pending, and it moves only when a human clicks approve
//   refuse          -> policy_refused, terminal
// There is no override, no force flag and no fourth path. Approval re-runs the engine against
// the policy and balances as they are at that moment, so a kill switch flipped after the
// proposal was created still stops it. Every transition appends one line to the audit log.
//
// This file is the door. The work is in src/proposals/, split by job: lifecycle.ts is what a
// proposal is and what a click does to it, execute.ts is what actually runs, draft.ts is how a
// draft is priced and landed, rails.ts holds the drafts that move money somewhere else,
// trade.ts the two that touch a position, and reconcile.ts what becomes of a
// proposal the process died in the middle of. Everything anything outside this directory imports
// is re-exported here, so no caller changed.

import type { Proposal, ProposalService } from './types.ts';
import { proposalView } from './proposals/view.ts';
import type { ViewCtx } from './proposals/view.ts';
import { judgeSettling } from './proposals/execute.ts';
import type { PlanFate } from './proposals/lifecycle.ts';
import { within } from './shutdown.ts';
import {
  approve,
  autoLimit,
  createSerialiser,
  dailyLimit,
  NO_RAILS,
  refuse,
  releaseQueued,
  sessionSpentUsd,
  settled,
  stableSymbols,
} from './proposals/lifecycle.ts';
import type { PCtx, ProposalDeps } from './proposals/lifecycle.ts';
import { finishTouch } from './proposals/lifecycle.ts';
import { executeApproved, land, markStalled, watchSettling } from './proposals/execute.ts';
import { acknowledge, reconcileOnBoot, reconcileOpen, reconcileProposal, watchDeadlines } from './proposals/reconcile.ts';
import { proposePolicyChange } from './proposals/draft.ts';
import { decideSwap, prepareSwap, proposeHlDeposit, proposeHlWithdraw, proposeSend } from './proposals/rails.ts';
import { proposeTrade, proposeTradeChange } from './proposals/trade.ts';
import { swapAssets, swapCheck, swapQuote } from './proposals/swap-reads.ts';
import { webReadBy } from './web-read.ts';
import { appTurnBy } from './app-turn.ts';

export type { ProposalDeps };

export function createProposalService(deps: ProposalDeps): ProposalService {
  /* The context every handler reads, assembled once. `execute` is the indirection that lets
     lifecycle.ts stay the leaf of this directory: approve() reaches the executor through it
     rather than importing the module that imports lifecycle. */
  const ctx: PCtx = {
    ...deps,
    rails: deps.rails ?? NO_RAILS,
    stables: stableSymbols(deps.riskRows),
    notify: () => deps.onChange?.(),
    execute: (p: Proposal) => executeApproved(ctx, p),
    land: (p: Proposal) => land(ctx, p),
    afterTouch: (id, result) => serialise(() => finishTouch(ctx, id, result)),
    inflight: new Map(),
  };

  const serialise = createSerialiser();
  // Rows left settling by a process that stopped are re-judged on the ledger's next refresh, and
  // a FAILED swap waiting out its transfer's deadline is asked again once the deadline has passed.
  watchSettling(ctx);
  watchDeadlines(ctx);

  /* THE VIEW'S TWO SEAMS, and the settle one is the fix for two sources of truth.
     A row still waiting on a venue's credit is re-judged against the balance the ledger last
     read, but only when that read is NEWER than the moment the row last moved: an older read
     cannot say anything the row does not already know, and re-judging on it would write a line
     per call for nothing. It reads and it may write a row the ledger already proved; it signs
     nothing, sends nothing and asks nobody, which is why a plain read can do it. */
  const readAt = (p: Proposal): number => {
    const stamp = p.pocket?.venue === 'hyperliquid' ? ctx.ledger.hyperliquid()?.fetchedAt : ctx.ledger.intents()?.fetchedAt;
    return Date.parse(stamp ?? '');
  };
  const viewCtx: ViewCtx = {
    settle: (p) => {
      if (p.status !== 'needs_reconciliation' || p.pocket === undefined) return p;
      const read = readAt(p);
      if (!Number.isFinite(read) || read <= Date.parse(p.lastChangeAt ?? p.createdAt)) return p;
      return judgeSettling(ctx, p);
    },
    plan: (p) => {
      if (p.kind !== 'trade' || ctx.trade === undefined) return null;
      try {
        return (ctx.trade.runner.plans() as Array<PlanFate & { proposalId?: string }>).find((row) => row.proposalId === p.id) ?? null;
      } catch {
        return null;
      }
    },
  };

  /* The web-read stamp, taken the moment a move is asked for and before anything is awaited or
     queued: the params travel as the proposal's origin to newProposal, which puts it on the row,
     and land() reads the row (src/web-read.ts). Whatever the mark does while the reads run or the
     queue waits, the move is judged by what its agent had read when it asked. The app-turn stamp
     rides the same way: whether it was asked inside a turn the app started (src/app-turn.ts). */
  const stamped = <T extends { by?: string | null }>(p: T): T & { webRead: boolean; appTurn: boolean } => ({
    ...p,
    webRead: webReadBy(p.by ?? undefined),
    appTurn: appTurnBy(p.by ?? undefined),
  });

  return {
    proposePolicyChange: (p) => serialise(() => proposePolicyChange(ctx, p)),
    /* The reads (the balance, the price, the simulation) run before the queue and the decision
       runs in it: the engine against the day's spend as it stands, and the landing that reserves.
       A swap's seconds of quotes used to hold every approve and refuse behind them. */
    proposeSwap: async (p) => {
      const prepared = await prepareSwap(ctx, stamped(p));
      return serialise(() => decideSwap(ctx, prepared));
    },
    proposeHlDeposit: (p) => {
      const asked = stamped(p);
      return serialise(() => proposeHlDeposit(ctx, asked));
    },
    proposeHlWithdraw: (p) => {
      const asked = stamped(p);
      return serialise(() => proposeHlWithdraw(ctx, asked));
    },
    proposeSend: (p) => {
      const asked = stamped(p);
      return serialise(() => proposeSend(ctx, asked));
    },
    proposeTrade: (p) => {
      const asked = stamped(p);
      return serialise(() => proposeTrade(ctx, asked));
    },
    proposeTradeChange: (p) => {
      const asked = stamped(p);
      return serialise(() => proposeTradeChange(ctx, asked));
    },
    // approve() executes, so it shares the queue: a human click landing next to an
    // auto-approval must not be able to double-spend the cap either.
    approve: (id: string) => serialise(() => approve(ctx, id)),
    refuse: (id: string) => refuse(ctx, id),
    // Shares the queue for the same reason approve does: releasing several proposals at once
    // is several things that may execute, and the daily cap has to see them one at a time.
    releaseQueued: () => serialise(() => releaseQueued(ctx)),
    get: (id: string) => deps.store.get(id),
    list: () => deps.store.list(),
    view: (p: Proposal, now?: number) => proposalView(viewCtx, p, now),
    // Outside the serialiser, like reconcile: it writes a stamp on rows nobody is executing
    // and reserves no budget, so holding the spend queue open for it buys nothing.
    markStalled: (now?: number) => markStalled(ctx, now),
    sessionSpentUsd: () => sessionSpentUsd(ctx),
    reconcileOnBoot: () => reconcileOnBoot(ctx),
    // Outside the serialiser on purpose. It reads the chain and writes one row, it never
    // reserves budget, and holding the spend queue open for a network read is the thing task
    // 13 exists to stop.
    reconcile: (id: string) => reconcileProposal(ctx, id),
    acknowledge: (id: string) => acknowledge(ctx, id),
    // Outside the serialiser, like reconcile: it reads the venue and writes rows, reserves no
    // budget, and holding the spend queue open for a network sweep is the thing task 13 stopped.
    reconcileOpen: () => reconcileOpen(ctx),
    settled: (id: string, capMs: number) => settled(ctx, id, capMs),
    // The queue AND every rail still out: the queue moves on at the reservation and a rail runs
    // behind its reply now, so the queue alone would drain while a signature was in flight.
    settle: (capMs: number) => within(capMs, Promise.all([serialise.idle(), ...ctx.inflight.values()])),
    dailyLimit: (capUsd: number) => dailyLimit(ctx, capUsd),
    autoLimit: (capUsd: number) => autoLimit(ctx, capUsd),
    // Reads, outside the serialiser: none reserves budget or writes a row.
    swapAssets: (params) => swapAssets(ctx, params),
    swapQuote: (params) => swapQuote(ctx, params),
    swapCheck: (id: string) => swapCheck(ctx, id),
  };
}
