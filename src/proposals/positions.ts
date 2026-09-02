// The five drafts that open or close a position: an armed mandate, the two liquidity positions
// and the two lending moves.
//
// Same shape as the moves in rails.ts and the same tail: everything is resolved from what the
// app already knows, then handed to proposeRail. Arming a mandate is the one draft in this
// directory that never auto-approves whatever its size, and land() is where that is enforced.

import type {
  LpAddDraft,
  LpAddParams,
  LpRemoveDraft,
  LpRemoveParams,
  MandateDraft,
  MandateParams,
  Proposal,
  YieldDepositDraft,
  YieldDepositParams,
  YieldWithdrawDraft,
  YieldWithdrawParams,
} from '../types.ts';
import { VENUE as UNISWAP_VENUE } from '../rails/uniswap.ts';
import { chainsWithDeployment, deploymentFor, tokenFor } from '../rails/uniswap-abi.ts';
import { YIELD_VENUE } from '../rails/yield.ts';
import { aaveAsset, aavePosition, marketFor } from '../yield/aave.ts';
import { toBaseUnits } from '../yield/venue.ts';
import { HYPERLIQUID_PERPS_COUNTERPARTY } from '../rails/mandate.ts';
import { actionVerbs, programHash, validateProgram } from '../strategy/grammar.ts';
import { errText } from './lifecycle.ts';
import { ourAddress, positionUsd, proposeRail, refuseDraft, resolve, usdOf } from './draft.ts';
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

export async function proposeLpAdd(ctx: PCtx, params: LpAddParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const from = ourAddress(ctx, params.chain, snapshot, problems);

  // Token addresses and decimals come from the venue's own verified registry, never from
  // the agent: a token id on the wire is a contract this app would then approve.
  const token0 = resolve(() => tokenFor(params.chain, params.token0Symbol), problems, null);
  const token1 = resolve(() => tokenFor(params.chain, params.token1Symbol), problems, null);
  const counterparty = resolve(
    () => String(deploymentFor(params.chain).positionManager),
    problems,
    '',
  );

  const draft: LpAddDraft = {
    kind: 'lp_add',
    chain: params.chain,
    venue: UNISWAP_VENUE,
    // Empty on purpose: the rail asks the factory which pool this pair and fee resolve to,
    // and a pool id from the agent would be a second answer to that question.
    poolId: '',
    token0: {
      symbol: token0?.symbol ?? params.token0Symbol,
      tokenId: token0?.address ?? '',
      amount: params.amount0,
      decimals: token0?.decimals ?? 0,
    },
    token1: {
      symbol: token1?.symbol ?? params.token1Symbol,
      tokenId: token1?.address ?? '',
      amount: params.amount1,
      decimals: token1?.decimals ?? 0,
    },
    feeTier: params.feeTier,
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
    amountUsd:
      usdOf(ctx, token0?.symbol ?? params.token0Symbol, params.amount0, snapshot) +
      usdOf(ctx, token1?.symbol ?? params.token1Symbol, params.amount1, snapshot),
    from,
    counterparty,
  };

  return problems.length > 0 ? refuseDraft(ctx, 'lp_add', draft, problems) : proposeRail(ctx, 'lp_add', draft);
}

export async function proposeLpRemove(ctx: PCtx, params: LpRemoveParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];

  // The wallet decides which position this is. Reading the chain, the venue and the value
  // off a position we already hold means an id we do not hold cannot be turned into a
  // draft at all, and no field of the draft is the agent's word for it.
  const position = ctx.ledger.positions().find(p => p.positionId === params.positionId);
  if (position === undefined) {
    problems.push(
      `No pool position ${params.positionId} in the wallet. Read the wallet first: only positions this app can see can be pulled.`,
    );
  }

  const chain = position?.chain ?? chainsWithDeployment()[0] ?? 'arb';
  const from = position === undefined ? '' : ourAddress(ctx, chain, snapshot, problems);
  const counterparty =
    position === undefined ? '' : resolve(() => String(deploymentFor(chain).positionManager), problems, '');

  const draft: LpRemoveDraft = {
    kind: 'lp_remove',
    chain,
    venue: position?.venue ?? UNISWAP_VENUE,
    positionId: params.positionId,
    liquidityPct: params.liquidityPct,
    // Pessimistic on purpose: pulling liquidity brings funds back, but the engine budgets
    // every rail draft the same way, and over-counting a move costs a delay where
    // under-counting it costs money.
    amountUsd: position === undefined ? Infinity : positionUsd(ctx, position, snapshot) * params.liquidityPct,
    from,
    counterparty,
  };

  return problems.length > 0 ? refuseDraft(ctx, 'lp_remove', draft, problems) : proposeRail(ctx, 'lp_remove', draft);
}

// Park a stablecoin where it earns. The default symbol is USDC because that is the only
// asset the verified Aave table carries, and defaulting rather than requiring keeps the
// call site honest: a caller who names a symbol we do not have gets the table's own error
// rather than a silent substitution.
export async function proposeYieldDeposit(ctx: PCtx, params: YieldDepositParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const symbol = params.symbol ?? 'USDC';
  const from = ourAddress(ctx, params.chain, snapshot, problems);

  // Decimals come from the venue's verified table, never from the caller and never from
  // the token contract at propose time. The same rule the LP rail keeps: a decimals value
  // on the wire is a multiplier on an amount this app is about to sign for.
  const asset = aaveAsset(params.chain, symbol);
  if (asset === null) {
    problems.push(
      `Aave v3 has no verified ${symbol} market on ${params.chain}. ` +
        'Only chains in the verified table can be proposed.',
    );
  }
  const counterparty = resolve(() => String(marketFor(params.chain).pool), problems, '');

  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    problems.push(`Deposit amount must be a positive number, got ${params.amount}.`);
  }

  const decimals = asset?.decimals ?? 6;
  const amountBase = resolve(() => toBaseUnits(params.amount, decimals).toString(), problems, '0');

  const draft: YieldDepositDraft = {
    kind: 'yield_deposit',
    venue: YIELD_VENUE,
    chain: params.chain,
    symbol,
    amount: params.amount,
    amountBase,
    decimals,
    amountUsd: usdOf(ctx, symbol, params.amount, snapshot),
    from,
    counterparty,
  };

  return problems.length > 0 ? refuseDraft(ctx, 'yield_deposit', draft, problems) : proposeRail(ctx, 'yield_deposit', draft);
}

// Take it back out. Omitting the amount means the whole position, and that is the case the
// withdraw button in the window uses, because it is the only one that cannot leave dust: a
// rebasing balance read here is already stale by the time the transaction lands.
export async function proposeYieldWithdraw(ctx: PCtx, params: YieldWithdrawParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const symbol = params.symbol ?? 'USDC';
  const from = ourAddress(ctx, params.chain, snapshot, problems);

  const asset = aaveAsset(params.chain, symbol);
  if (asset === null) {
    problems.push(`Aave v3 has no verified ${symbol} market on ${params.chain}.`);
  }
  const counterparty = resolve(() => String(marketFor(params.chain).pool), problems, '');

  const whole = params.amount === undefined;
  if (!whole && (!Number.isFinite(params.amount) || (params.amount as number) <= 0)) {
    problems.push(`Withdrawal amount must be a positive number, got ${params.amount}.`);
  }

  const decimals = asset?.decimals ?? 6;

  // The position is read here so the draft carries a real dollar figure, which is what the
  // policy engine budgets on and what the approval gate shows. A read failure is a problem
  // rather than a zero: a withdrawal priced at zero would slip under every cap in the
  // policy and be approved without anyone seeing a number.
  let positionBase = 0n;
  if (asset !== null && from !== '') {
    try {
      positionBase = (await aavePosition(params.chain, symbol, from)).balanceBase;
    } catch (err) {
      problems.push(`Could not read the Aave position on ${params.chain}: ${errText(err)}`);
    }
  }

  const amount = whole ? Number(positionBase) / 10 ** decimals : (params.amount as number);
  const amountBase = whole ? null : toBaseUnits(amount, decimals).toString();

  if (problems.length === 0 && positionBase === 0n) {
    problems.push(`There is no Aave v3 ${symbol} position on ${params.chain} to withdraw.`);
  }

  const draft: YieldWithdrawDraft = {
    kind: 'yield_withdraw',
    venue: YIELD_VENUE,
    chain: params.chain,
    symbol,
    amount,
    amountBase,
    decimals,
    amountUsd: usdOf(ctx, symbol, amount, snapshot),
    from,
    counterparty,
  };

  return problems.length > 0 ? refuseDraft(ctx, 'yield_withdraw', draft, problems) : proposeRail(ctx, 'yield_withdraw', draft);
}
