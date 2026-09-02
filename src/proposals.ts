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
// else, and positions.ts the five that open or close a position. Everything
// anything outside this directory imports is re-exported here, so no caller changed.

import type { Proposal, ProposalService } from './types.ts';
import {
  approve,
  createSerialiser,
  NO_RAILS,
  refuse,
  releaseQueued,
  sessionSpentUsd,
  stableSymbols,
} from './proposals/lifecycle.ts';
import type { PCtx, ProposalDeps } from './proposals/lifecycle.ts';
import { executeApproved, land } from './proposals/execute.ts';
import { proposeConsolidate, proposePolicyChange } from './proposals/draft.ts';
import { proposeHlDeposit, proposeIntentsDeposit, proposeIntentsWithdraw, proposeSwap } from './proposals/rails.ts';
import {
  proposeLpAdd,
  proposeLpRemove,
  proposeMandate,
  proposeYieldDeposit,
  proposeYieldWithdraw,
} from './proposals/positions.ts';

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
  };

  const serialise = createSerialiser();

  return {
    proposeConsolidate: (p) => serialise(() => proposeConsolidate(ctx, p)),
    proposePolicyChange: (p) => serialise(() => proposePolicyChange(ctx, p)),
    proposeSwap: (p) => serialise(() => proposeSwap(ctx, p)),
    proposeHlDeposit: (p) => serialise(() => proposeHlDeposit(ctx, p)),
    proposeIntentsDeposit: (p) => serialise(() => proposeIntentsDeposit(ctx, p)),
    proposeIntentsWithdraw: (p) => serialise(() => proposeIntentsWithdraw(ctx, p)),
    proposeMandate: (p) => serialise(() => proposeMandate(ctx, p)),
    proposeLpAdd: (p) => serialise(() => proposeLpAdd(ctx, p)),
    proposeLpRemove: (p) => serialise(() => proposeLpRemove(ctx, p)),
    proposeYieldDeposit: (p) => serialise(() => proposeYieldDeposit(ctx, p)),
    proposeYieldWithdraw: (p) => serialise(() => proposeYieldWithdraw(ctx, p)),
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
  };
}
