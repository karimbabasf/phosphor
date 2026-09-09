// The one draft that opens a position: an armed mandate.
//
// Same shape as the moves in rails.ts and the same tail: everything is resolved from what the
// app already knows, then handed to proposeRail. Arming a mandate is the one draft in this
// directory that never auto-approves whatever its size, and land() is where that is enforced.

import type { MandateDraft, MandateParams, Proposal } from '../types.ts';
import { HYPERLIQUID_PERPS_COUNTERPARTY } from '../rails/mandate.ts';
import { actionVerbs, programHash, validateProgram } from '../strategy/grammar.ts';
import { proposeRail, refuseDraft } from './draft.ts';
import type { PCtx } from './lifecycle.ts';

export async function proposeMandate(ctx: PCtx, params: MandateParams): Promise<Proposal> {
  const problems: string[] = [];

  // The program is validated HERE, before a draft exists, so an invalid one never reaches
  // the approval screen. A human clicking on a program the app could not parse would be
  // approving something nobody, including the app, has read.
  const parsed = validateProgram(params.program);
  if (!parsed.ok) problems.push(...parsed.errors);

  if (!Number.isFinite(params.maxNotionalUsd) || params.maxNotionalUsd <= 0) {
    problems.push('maxNotionalUsd must be a positive number');
  }
  if (!Number.isFinite(params.maxLossUsd) || params.maxLossUsd <= 0) {
    problems.push('maxLossUsd must be a positive number');
  }
  // A mandate that cannot lose less than it can hold is not a bounded mandate.
  if (params.maxLossUsd > params.maxNotionalUsd) {
    problems.push('maxLossUsd cannot exceed maxNotionalUsd');
  }
  if (Number.isNaN(Date.parse(params.expiresAt))) problems.push('expiresAt must be an ISO timestamp');
  else if (Date.parse(params.expiresAt) <= Date.now()) problems.push('expiresAt is already in the past');

  const draft: MandateDraft = {
    kind: 'mandate_arm',
    symbol: params.symbol,
    // The PARSED program, not the raw one. A program that arrived as JSON text validates
    // (validateProgram accepts that wire) but would be stored as a string, and everything
    // downstream reads this field: the approval screen renders it in English, the runner is
    // armed from it, the hash is taken over it. Storing what was actually understood is what
    // keeps "the thing on screen is the thing running" true when the two arrived in
    // different shapes.
    program: parsed.ok ? parsed.program : params.program,
    programHash: parsed.ok ? programHash(parsed.program) : '',
    maxNotionalUsd: params.maxNotionalUsd,
    maxLeverage: params.maxLeverage,
    maxOrdersPerMin: params.maxOrdersPerMin,
    maxLossUsd: params.maxLossUsd,
    expiresAt: params.expiresAt,
    // Intersected with what the program actually uses, so a mandate cannot grant a verb the
    // program never asked for. Granting spare authority "just in case" is how an envelope
    // stops describing the thing inside it.
    allowedActions: parsed.ok
      ? actionVerbs(parsed.program).filter((v) => params.allowedActions.includes(v))
      : [],
    // The maximum notional IS the amount at risk, and it is what the budget rules read.
    amountUsd:
      Number.isFinite(params.maxNotionalUsd) && params.maxNotionalUsd > 0
        ? params.maxNotionalUsd
        : Infinity,
    counterparty: HYPERLIQUID_PERPS_COUNTERPARTY,
  };

  return problems.length > 0
    ? refuseDraft(ctx, 'mandate_arm', draft, problems)
    : proposeRail(ctx, 'mandate_arm', draft);
}
