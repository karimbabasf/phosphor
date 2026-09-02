// The propose door: what an agent gets back, the four boundary checks every kind shares, and
// the eleven kinds themselves.
//
// The checks here are boundaries only. A wrong type or an unknown chain is answered here, and
// every question about the VALUE of a number (too big, zero, negative) is left to the policy
// engine and the rails, so money rules stay in one place.

import type http from 'node:http';

import type { ChainId, Proposal } from '../types.ts';
import { asRecord, errText, fail, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { bestYieldChain, heldYieldChain } from './state.ts';
import { CHAINS, PROPOSE_KINDS } from './context.ts';
import type { Ctx } from './context.ts';

// What the agent gets back from any propose: the id to poll, what the policy decided,
// and what the simulation said. Never the draft itself, so the app's resolved addresses
// are not echoed to the caller that was deliberately not allowed to name them.
export function sendProposal(ctx: Ctx, res: http.ServerResponse, proposal: Proposal): void {
  ctx.sse.broadcastState();
  sendJson(res, 200, {
    id: proposal.id,
    status: proposal.status,
    verdict: proposal.verdict,
    simulation: proposal.simulation,
  });
}

// Boundary checks only: a wrong type or an unknown chain is answered here, and every
// question about the value of a number (too big, zero, negative) is left to the policy
// engine and the rails, so money rules stay in one place.
export function numField(params: JsonBody, name: string, problems: string[]): number {
  const raw = params[name];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    problems.push(`${name} must be a finite number`);
    return NaN;
  }
  return raw;
}

export function strField(params: JsonBody, name: string, problems: string[]): string {
  const raw = params[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    problems.push(`${name} is required`);
    return '';
  }
  return raw.trim();
}

export function chainField(params: JsonBody, name: string, problems: string[]): ChainId {
  const raw = String(params[name] ?? '');
  if (!CHAINS.includes(raw)) {
    problems.push(`${name} must be one of: ${CHAINS.join(', ')}`);
    return 'eth';
  }
  return raw as ChainId;
}

export async function handlePropose(ctx: Ctx, body: JsonBody, res: http.ServerResponse): Promise<void> {
  const kind = String(body.kind ?? '');
  const params = asRecord(body.params);
  const session = String(body.session ?? 'unnamed-session');
  const clash = ctx.duplicates.find(kind, params, session);
  if (clash !== null) {
    ctx.audit.append('agent_rejected', 'a duplicate proposal from a second agent was refused', {
      kind,
      existing: clash.id,
      by: clash.session,
    });
    fail(
      res,
      409,
      `another agent proposed exactly this ${kind} moments ago (proposal ${clash.id}). It has not been ` +
        'superseded, so this one is refused rather than doubling it. Read it with proposal_status, and ' +
        'use agent_board to say what you are taking on before you start.',
      { duplicate: clash.id },
    );
    return;
  }
  const problems: string[] = [];

  /* Every branch below answers through this rather than through sendProposal, so a proposal
     that actually landed is the thing the duplicate guard remembers. Recording it at the top
     of the function instead would fingerprint drafts that were then refused for a bad amount,
     and block the corrected retry as a duplicate of a proposal that never existed. */
  const respond = (proposal: Proposal): void => {
    ctx.duplicates.remember(kind, params, session, proposal.id);
    sendProposal(ctx, res, proposal);
  };

  try {
    if (kind === 'swap') {
      const venueRaw = params.venue === undefined ? 'uniswap-v3' : String(params.venue);
      if (venueRaw !== 'uniswap-v3' && venueRaw !== 'oneclick' && venueRaw !== 'intents-native') {
        problems.push('venue must be uniswap-v3, oneclick or intents-native');
      }
      const chain = chainField(params, 'chain', problems);
      const toChain = params.toChain === undefined ? chain : chainField(params, 'toChain', problems);
      // uniswap-v3 is an on-chain DEX and cannot cross chains. Caught HERE, at draft time, with
      // a message that names the fix, rather than deep in the rail as "no verified deployment"
      // that reads like a missing config. This is also the guard against the silent default: a
      // cross-chain swap that names no venue defaults to uniswap-v3 and lands here, told to pick
      // oneclick or intents-native, instead of building an on-chain draft nobody asked for.
      if (venueRaw === 'uniswap-v3' && chain !== toChain) {
        problems.push(
          `uniswap-v3 is a same-chain venue and cannot swap ${chain} to ${toChain}. ` +
            'For a cross-chain swap set venue to "oneclick" or "intents-native".',
        );
      }
      const fromSymbol = strField(params, 'fromSymbol', problems);
      const toSymbol = strField(params, 'toSymbol', problems);
      const amountIn = numField(params, 'amountIn', problems);
      // A negative or zero input has no honest swap. Rejected at the edge so it never reaches
      // usdOf, where a negative amount became "$Infinity ... cannot be checked against a limit"
      // and only failed closed by accident of the arithmetic.
      if (amountIn <= 0) problems.push('amountIn must be greater than 0');
      const minAmountOut = numField(params, 'minAmountOut', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(
        await ctx.proposals.proposeSwap({
          venue: venueRaw as 'uniswap-v3' | 'oneclick' | 'intents-native',
          chain,
          toChain,
          fromSymbol,
          toSymbol,
          amountIn,
          minAmountOut,
        }),
      );
      return;
    }
    if (kind === 'mandate_arm') {
      const symbol = strField(params, 'symbol', problems);
      const maxNotionalUsd = numField(params, 'maxNotionalUsd', problems);
      const maxLeverage = numField(params, 'maxLeverage', problems);
      const maxOrdersPerMin = numField(params, 'maxOrdersPerMin', problems);
      const maxLossUsd = numField(params, 'maxLossUsd', problems);
      const expiresAt = strField(params, 'expiresAt', problems);
      const allowedActions = Array.isArray(params.allowedActions)
        ? params.allowedActions.map((v) => String(v))
        : [];
      if (allowedActions.length === 0) problems.push('allowedActions must list at least one verb');
      if (params.program === undefined) problems.push('program is required');
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(
        await ctx.proposals.proposeMandate({
          symbol,
          program: params.program,
          maxNotionalUsd,
          maxLeverage,
          maxOrdersPerMin,
          maxLossUsd,
          expiresAt,
          allowedActions,
        }),
      );
      return;
    }
    if (kind === 'hl_deposit') {
      // chain and symbol are optional and both default inside proposeHlDeposit: the money
      // used to have to be USDC on Arbitrum, and now the origin is a choice, so omitting it
      // keeps the old call shape working and naming it is the new capability.
      const chain = params.chain === undefined ? undefined : chainField(params, 'chain', problems);
      const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
      const amount = numField(params, 'amount', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeHlDeposit({ chain, symbol, amount }));
      return;
    }
    if (kind === 'intents_deposit') {
      const chain = chainField(params, 'chain', problems);
      // symbol is optional: absent means the chain's gas asset, which is the common case
      // and the one the ERC-20 path could not serve.
      const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
      const amount = numField(params, 'amount', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeIntentsDeposit({ chain, symbol, amount }));
      return;
    }
    if (kind === 'intents_withdraw') {
      const chain = chainField(params, 'chain', problems);
      // Same optional symbol as the deposit: absent means the destination chain's gas asset.
      // There is no field here for the address, and there must never be one: the wallet the
      // payout lands in is resolved from config by the proposal service and re-derived by the
      // rail. tests/injection.test.ts holds this schema to that.
      const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
      const amount = numField(params, 'amount', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeIntentsWithdraw({ chain, symbol, amount }));
      return;
    }
    if (kind === 'yield_deposit' || kind === 'yield_withdraw') {
      // Both rails take EVM chains only, and chainField accepts sol and near because four
      // other kinds need them. Narrowing here rather than there keeps the message specific:
      // "sol is not a chain this rail supplies on" beats a generic list five items long.
      let chain: ChainId | null = null;
      if (params.chain === undefined) {
        // Omitted on purpose, and it is the common case. A deposit goes where the loop
        // would send it, and a withdrawal comes from wherever the position actually is.
        // Both answers live in the allocator's view, so neither is a guess.
        const picked = kind === 'yield_deposit' ? bestYieldChain(ctx) : heldYieldChain(ctx);
        if (!picked.ok) {
          fail(res, 400, picked.reason);
          return;
        }
        chain = picked.chain;
      } else {
        const named = chainField(params, 'chain', problems);
        if (named !== 'eth' && named !== 'base' && named !== 'arb') {
          problems.push(`chain must be one of eth, base, arb for ${kind}; got '${String(params.chain)}'`);
        } else {
          chain = named;
        }
      }
      const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
      // The asymmetry is the whole design of the withdrawal. An amount is REQUIRED going in
      // and OPTIONAL coming out, because the receipt token rebases: a number the caller
      // computed a block ago is already short of the position by whatever interest landed
      // while the proposal waited for a click, and omitting it means all of it, dust
      // included. See the comment on YieldWithdrawParams in src/types.ts.
      const amount =
        kind === 'yield_deposit'
          ? numField(params, 'amount', problems)
          : params.amount === undefined
            ? undefined
            : numField(params, 'amount', problems);
      if (kind === 'yield_deposit' && amount !== undefined && amount <= 0) {
        problems.push('amount must be greater than 0');
      }
      if (problems.length > 0 || chain === null) {
        fail(res, 400, problems.join('; ') || 'chain could not be resolved');
        return;
      }
      sendProposal(
        ctx,
        res,
        kind === 'yield_deposit'
          ? await ctx.proposals.proposeYieldDeposit({ chain, symbol, amount: amount as number })
          : await ctx.proposals.proposeYieldWithdraw({ chain, symbol, amount }),
      );
      return;
    }
    if (kind === 'lp_add') {
      const chain = chainField(params, 'chain', problems);
      const token0Symbol = strField(params, 'token0Symbol', problems);
      const token1Symbol = strField(params, 'token1Symbol', problems);
      const amount0 = numField(params, 'amount0', problems);
      const amount1 = numField(params, 'amount1', problems);
      const feeTier = numField(params, 'feeTier', problems);
      const tickLower = numField(params, 'tickLower', problems);
      const tickUpper = numField(params, 'tickUpper', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(
        await ctx.proposals.proposeLpAdd({
          chain,
          token0Symbol,
          token1Symbol,
          amount0,
          amount1,
          feeTier,
          tickLower,
          tickUpper,
        }),
      );
      return;
    }
    if (kind === 'lp_remove') {
      const positionId = strField(params, 'positionId', problems);
      const liquidityPct = numField(params, 'liquidityPct', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeLpRemove({ positionId, liquidityPct }));
      return;
    }
    if (kind === 'consolidate') {
      const toChain = String(params.toChain ?? '');
      const symbol = typeof params.symbol === 'string' ? params.symbol.trim() : '';
      if (!CHAINS.includes(toChain)) {
        fail(res, 400, `toChain must be one of: ${CHAINS.join(', ')}`);
        return;
      }
      if (symbol.length === 0) {
        fail(res, 400, 'symbol is required');
        return;
      }
      const fromChains = Array.isArray(params.fromChains)
        ? (params.fromChains.filter((c) => typeof c === 'string' && CHAINS.includes(c)) as ChainId[])
        : undefined;
      const maxTotalUsd = typeof params.maxTotalUsd === 'number' && Number.isFinite(params.maxTotalUsd)
        ? params.maxTotalUsd
        : undefined;
      respond(
        await ctx.proposals.proposeConsolidate({
          toChain: toChain as ChainId,
          symbol,
          ...(fromChains !== undefined && fromChains.length > 0 ? { fromChains } : {}),
          ...(maxTotalUsd !== undefined ? { maxTotalUsd } : {}),
        }),
      );
      return;
    }
    if (kind === 'policy_change') {
      // patch and sentence are passed through as authored: the engine validates
      // the patch, and the sentence is stored as data, never read as instruction.
      const sentence = typeof params.sentence === 'string' ? params.sentence : '';
      respond(await ctx.proposals.proposePolicyChange({ patch: asRecord(params.patch), sentence }));
      return;
    }
    fail(res, 400, `unknown propose kind: ${kind}. known kinds: ${PROPOSE_KINDS.join(', ')}`);
  } catch (err) {
    fail(res, 400, errText(err));
  }
}
