// The drafts that move money from one place to another: a swap inside the verifier, the
// Hyperliquid deposit and withdrawal, and the send to another intents account.
//
// Each one resolves its own addresses and amounts from what the app already knows, never from
// the caller, and then hands the draft to proposeRail, which evaluates, simulates and lands it.

import type {
  HlDepositDraft,
  HlDepositParams,
  HlWithdrawDraft,
  HlWithdrawParams,
  IntentsSendDraft,
  IntentsSendParams,
  Proposal,
  SwapDraft,
  SwapParams,
} from '../types.ts';
import {
  HYPERCORE_COUNTERPARTY,
  minCreditedFor as minCreditedForHypercore,
} from '../rails/hypercore-deposit.ts';
import { HL_WITHDRAW_COUNTERPARTY, minReceivedForHlWithdraw } from '../rails/hypercore-withdraw.ts';
import { INTENTS_NATIVE_COUNTERPARTY } from '../rails/intents-native.ts';
import { INTENTS_SEND_COUNTERPARTY, intentsAccountProblem, minReceivedForSend } from '../rails/intents-send.ts';
import { ourEvmAddress, ourIntentsAddress, proposeRail, refuseDraft, usdOf } from './draft.ts';
import type { PCtx } from './lifecycle.ts';

export async function proposeSwap(ctx: PCtx, params: SwapParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const toChain = params.toChain ?? params.chain;

  // Both sides are our own account inside the verifier. The agent picks the assets; it has
  // no way to say who receives the output.
  //
  // chain and toChain name the home chains of the two ASSETS, never a wallet: "USDC from eth"
  // and "USDC from arb" are two ids in the 1Click token list, and nothing here lands on a
  // chain. Deriving an address from either used to author a SOL-in-intents draft for a
  // Solana address the app never signed with, so the pair was unsellable; the account is the
  // EVM address for every asset.
  const from = ourIntentsAddress(ctx, snapshot, problems);

  const draft: SwapDraft = {
    kind: 'swap',
    venue: 'intents-native',
    chain: params.chain,
    toChain,
    fromSymbol: params.fromSymbol,
    toSymbol: params.toSymbol,
    amountIn: params.amountIn,
    amountUsd: usdOf(ctx, params.fromSymbol, params.amountIn, snapshot),
    minAmountOut: params.minAmountOut,
    from,
    to: from,
    counterparty: INTENTS_NATIVE_COUNTERPARTY,
    quote: null,
  };

  return problems.length > 0 ? refuseDraft(ctx, 'swap', draft, problems, params.clientKey) : proposeRail(ctx, 'swap', draft, params.clientKey);
}

// "Put $40 into the trading account." The money leaves the intents balance and nowhere else,
// so the caller names an amount and, at most, which asset to spend. Everything else is resolved
// here from the app's own state: the account spent, the flavor of that asset actually held, the
// Hyperliquid account credited, the loss floor and the counterparty.
export async function proposeHlDeposit(ctx: PCtx, params: HlDepositParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const symbol = (params.symbol ?? 'USDC').trim();

  // The account whose balance is spent inside the verifier: our own EVM address lowercased,
  // the way the verifier names it.
  const from = ourIntentsAddress(ctx, snapshot, problems).toLowerCase();

  // The trading account is the app's own EVM address. Hyperliquid identifies an account by
  // the address that signs for it, so crediting anything else funds a book this app cannot
  // trade. Derived here, never taken from a caller: the whole point of the propose surface
  // is that an agent cannot name where money goes.
  const hlAccount = ourEvmAddress(ctx, snapshot, problems);

  // Which flavor of the asset to spend. A balance inside intents.near is keyed by the bridged
  // asset it arrived as (USDC from eth and USDC from arb are two ids), so the builder reads
  // what is held and spends the largest matching one. It refuses only where it is certain:
  // no read at all, nothing matching, or a balance it can name as too small. Anything else is
  // left for the contract to answer: the symbol on an intents holding is a label looked up in
  // the 1Click token list, and src/ledger/intents.ts degrades it to the raw asset id when that
  // list momentarily fails to load (seen live 2026-08-13). A refusal keyed on a label that can
  // degrade would silently block every move whenever a remote list blipped.
  const read = ctx.ledger.intents();
  let originAsset = '';
  if (read === undefined || !read.ok) {
    problems.push(
      `The balance inside intents.near could not be read${read?.error ? ` (${read.error})` : ''}, so this cannot tell ` +
        `which ${symbol} it would spend. Read the wallet again and propose once it shows.`,
    );
  } else {
    const held = read.holdings
      .filter((h) => h.symbol.toUpperCase() === symbol.toUpperCase() && h.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    if (held.length === 0) {
      problems.push(`intents.near holds no ${symbol} for ${from}, so there is nothing to fund the trading account with.`);
    } else {
      originAsset = held[0].assetId;
      if (held[0].amount < params.amount) {
        problems.push(
          `intents.near holds ${held[0].amount} ${symbol} (from ${held[0].originChain}) for ${from}, which is less ` +
            `than the ${params.amount} this would deposit.`,
        );
      }
    }
  }

  const draft: HlDepositDraft = {
    kind: 'hl_deposit',
    symbol,
    originAsset,
    amount: params.amount,
    amountUsd: usdOf(ctx, symbol, params.amount, snapshot),
    // The hypercore floor, NOT the Intents one. That fee is proportional and this one is
    // nearly flat, so the 200 bps rule refuses honest quotes under about $17.
    minCredited: minCreditedForHypercore(usdOf(ctx, symbol, params.amount, snapshot)),
    from,
    hlAccount,
    counterparty: HYPERCORE_COUNTERPARTY,
  };

  return problems.length > 0 ? refuseDraft(ctx, 'hl_deposit', draft, problems, params.clientKey) : proposeRail(ctx, 'hl_deposit', draft, params.clientKey);
}

// "Bring $40 back from the trading account." One number. The venue account is the app's own
// EVM address, the intents account credited is that address lowercased, and neither can be
// named by a caller: there is no field for either, and the rail and the engine both refuse a
// draft that carries anything else. The position check is the rail's, because it needs the
// venue; what is decided here is only what the draft says.
export async function proposeHlWithdraw(ctx: PCtx, params: HlWithdrawParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];

  const from = ourEvmAddress(ctx, snapshot, problems);
  const to = from.toLowerCase();

  const draft: HlWithdrawDraft = {
    kind: 'hl_withdraw',
    symbol: 'USDC',
    amount: params.amount,
    amountUsd: usdOf(ctx, 'USDC', params.amount, snapshot),
    // What must land inside the verifier. The venue's 1 USDC activation fee is on top of the
    // amount and outside this floor; the rail's summary states it.
    minReceived: minReceivedForHlWithdraw(params.amount),
    from,
    to,
    counterparty: HL_WITHDRAW_COUNTERPARTY,
  };

  return problems.length > 0 ? refuseDraft(ctx, 'hl_withdraw', draft, problems, params.clientKey) : proposeRail(ctx, 'hl_withdraw', draft, params.clientKey);
}

// "Send 3.78 USDC to 0xd7b2...5050 inside NEAR Intents." The balance moves to another account
// inside the verifier and nowhere else: no chain, no wallet, the same asset arriving less the
// solver's fee. `to` is the ONE field on the propose surface that names where money ends up,
// and it is not resolved here from anything the app knows: it is decoded, refused if it is
// ours, and then held to the destination allowlist by the policy engine, which refuses any
// account a human has not put there with a click. The send itself always waits for a second
// click (src/proposals/execute.ts). See the header of src/rails/intents-send.ts.
export async function proposeIntentsSend(ctx: PCtx, params: IntentsSendParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const symbol = String(params.symbol ?? '').trim().toUpperCase();
  if (symbol === '') problems.push('The send has to name a symbol: which balance inside intents.near to move.');

  const from = ourIntentsAddress(ctx, snapshot, problems).toLowerCase();

  const receiver = intentsAccountProblem(params.to);
  let to = '';
  if (!receiver.ok) {
    problems.push(`The receiving account is unusable: ${receiver.problem}.`);
  } else if (receiver.id === from) {
    problems.push(`${receiver.id} is this app's own intents account; a send to ourselves pays a fee to move nothing.`);
  } else {
    to = receiver.id;
  }

  // The flavor spent: the largest matching balance the verifier holds. It refuses where it is
  // certain and lets the contract answer otherwise, for the reason the deposit builder gives.
  const read = ctx.ledger.intents();
  let originAsset = '';
  if (read === undefined || !read.ok) {
    problems.push(
      `The balance inside intents.near could not be read${read?.error ? ` (${read.error})` : ''}, so this cannot tell ` +
        `which ${symbol} it would send. Read the wallet again and propose once it shows.`,
    );
  } else {
    const held = read.holdings
      .filter((h) => h.symbol.toUpperCase() === symbol && h.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    if (held.length === 0) {
      problems.push(`intents.near holds no ${symbol} for ${from}, so there is nothing to send.`);
    } else {
      originAsset = held[0].assetId;
      if (held[0].amount < params.amount) {
        problems.push(
          `intents.near holds ${held[0].amount} ${symbol} (from ${held[0].originChain}) for ${from}, which is less ` +
            `than the ${params.amount} this would send.`,
        );
      }
    }
  }

  const draft: IntentsSendDraft = {
    kind: 'intents_send',
    symbol,
    originAsset,
    amount: params.amount,
    amountUsd: usdOf(ctx, symbol, params.amount, snapshot),
    minReceived: minReceivedForSend(params.amount),
    from,
    to,
    counterparty: INTENTS_SEND_COUNTERPARTY,
  };

  return problems.length > 0
    ? refuseDraft(ctx, 'intents_send', draft, problems, params.clientKey)
    : proposeRail(ctx, 'intents_send', draft, params.clientKey);
}
