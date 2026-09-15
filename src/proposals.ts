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
// fund move is planned and priced, rails.ts holds the four drafts that move money somewhere
// else, trade.ts the two that touch a position, and reconcile.ts what becomes of a
// proposal the process died in the middle of. Everything anything outside this directory imports
// is re-exported here, so no caller changed.

import type { Proposal, ProposalService } from './types.ts';
import { within } from './shutdown.ts';
import {
  approve,
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
import { executeApproved, land } from './proposals/execute.ts';
import { chainTxLookup, reconcileOnBoot, reconcileOpen, reconcileProposal } from './proposals/reconcile.ts';
import { proposeConsolidate, proposePolicyChange } from './proposals/draft.ts';
import { proposeHlDeposit, proposeHlWithdraw, proposeIntentsDeposit, proposeIntentsWithdraw, proposeSwap } from './proposals/rails.ts';
import { proposeTrade, proposeTradeChange } from './proposals/trade.ts';

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
    txLookup: deps.txLookup ?? chainTxLookup(),
    afterTouch: (id, result) => serialise(() => finishTouch(ctx, id, result)),
    inflight: new Map(),
  };

  const serialise = createSerialiser();

  return {
    proposeConsolidate: (p) => serialise(() => proposeConsolidate(ctx, p)),
    proposePolicyChange: (p) => serialise(() => proposePolicyChange(ctx, p)),
    proposeSwap: (p) => serialise(() => proposeSwap(ctx, p)),
    proposeHlDeposit: (p) => serialise(() => proposeHlDeposit(ctx, p)),
    proposeHlWithdraw: (p) => serialise(() => proposeHlWithdraw(ctx, p)),
    proposeIntentsDeposit: (p) => serialise(() => proposeIntentsDeposit(ctx, p)),
    proposeIntentsWithdraw: (p) => serialise(() => proposeIntentsWithdraw(ctx, p)),
    proposeTrade: (p) => serialise(() => proposeTrade(ctx, p)),
    proposeTradeChange: (p) => serialise(() => proposeTradeChange(ctx, p)),
    // approve() executes, so it shares the queue: a human click landing next to an
    // auto-approval must not be able to double-spend the cap either.
    approve: (id: string) => serialise(() => approve(ctx, id)),
    refuse: (id: string) => refuse(ctx, id),
    // Shares the queue for the same reason approve does: releasing several proposals at once
    // is several things that may execute, and the daily cap has to see them one at a time.
    releaseQueued: () => serialise(() => releaseQueued(ctx)),
    get: (id: string) => deps.store.get(id),
    list: () => deps.store.list(),
    sessionSpentUsd: () => sessionSpentUsd(ctx),
    reconcileOnBoot: () => reconcileOnBoot(ctx),
    // Outside the serialiser on purpose. It reads the chain and writes one row, it never
    // reserves budget, and holding the spend queue open for a network read is the thing task
    // 13 exists to stop.
    reconcile: (id: string) => reconcileProposal(ctx, id),
    // Outside the serialiser, like reconcile: it reads the venue and writes rows, reserves no
    // budget, and holding the spend queue open for a network sweep is the thing task 13 stopped.
    reconcileOpen: () => reconcileOpen(ctx),
    settled: (id: string, capMs: number) => settled(ctx, id, capMs),
    // The queue AND every rail still out: the queue moves on at the reservation and a rail runs
    // behind its reply now, so the queue alone would drain while a signature was in flight.
    settle: (capMs: number) => within(capMs, Promise.all([serialise.idle(), ...ctx.inflight.values()])),
    dailyLimit: (capUsd: number) => dailyLimit(ctx, capUsd),
  };
}
