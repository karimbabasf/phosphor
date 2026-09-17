// The drafts that move money from one place to another: a swap inside the verifier, the
// Hyperliquid deposit and withdrawal, and the two sends: to another intents account, or out
// to an address on a real chain.
//
// Each one resolves its own addresses and amounts from what the app already knows, never from
// the caller, and then hands the draft to proposeRail, which evaluates, simulates and lands it.

import type {
  HlDepositDraft,
  HlDepositParams,
  HlWithdrawDraft,
  HlWithdrawParams,
  IntentsPayDraft,
  IntentsSendDraft,
  Proposal,
  SendParams,
  SendRecipient,
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
import { INTENTS_PAY_COUNTERPARTY, minReceivedForPay } from '../rails/intents-pay.ts';
import { isChainNetwork, validateAddress } from '../chainscan/index.ts';
import type { ChainNetwork } from '../chainscan/index.ts';
import { recipientFor } from '../recipients.ts';
import { oneLine } from '../intents.ts';
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
  const from = ourIntentsAddress(ctx, problems);

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
  const from = ourIntentsAddress(ctx, problems).toLowerCase();

  // The trading account is the app's own EVM address. Hyperliquid identifies an account by
  // the address that signs for it, so crediting anything else funds a book this app cannot
  // trade. Derived here, never taken from a caller: the whole point of the propose surface
  // is that an agent cannot name where money goes.
  const hlAccount = ourEvmAddress(ctx, problems);

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

  const from = ourEvmAddress(ctx, problems);
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

// The flavor of `symbol` the verifier holds for us: the largest matching balance. It refuses
// where it is certain and lets the contract answer otherwise, for the reason the deposit
// builder gives. Shared by both send drafts.
function heldFlavor(ctx: PCtx, from: string, symbol: string, amount: number, verb: string, problems: string[]): string {
  const read = ctx.ledger.intents();
  if (read === undefined || !read.ok) {
    problems.push(
      `The balance inside intents.near could not be read${read?.error ? ` (${read.error})` : ''}, so this cannot tell ` +
        `which ${symbol} it would ${verb}. Read the wallet again and propose once it shows.`,
    );
    return '';
  }
  const held = read.holdings
    .filter((h) => h.symbol.toUpperCase() === symbol && h.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  if (held.length === 0) {
    problems.push(`intents.near holds no ${symbol} for ${from}, so there is nothing to ${verb}.`);
    return '';
  }
  if (held[0].amount < amount) {
    problems.push(
      `intents.near holds ${held[0].amount} ${symbol} (from ${held[0].originChain}) for ${from}, which is less ` +
        `than the ${amount} this would ${verb}.`,
    );
  }
  return held[0].assetId;
}

// What the book and the chain know about the receiver. The book is read here, on the app's
// own disk; the chain read is the injected `recipientActivity` (chainscan in live mode, nothing
// in demo mode and in tests), bounded, and a failure is null: an address the chain would not
// answer about is still a send the person can decide, with the card saying it was not checked.
async function recipientOf(ctx: PCtx, where: string, address: string, network: ChainNetwork | null, ownAddress: boolean, note: unknown): Promise<SendRecipient> {
  const row = recipientFor(ctx.dataDir, where, address);
  let activity: SendRecipient['activity'] = null;
  if (network !== null && ctx.recipientActivity !== undefined) {
    try {
      activity = await ctx.recipientActivity(network, address);
    } catch {
      activity = null;
    }
  }
  const clean = typeof note === 'string' ? oneLine(note, 64) : '';
  return {
    known: row !== null,
    count: row === null ? 0 : row.count,
    lastAt: row === null ? null : row.lastAt,
    activity,
    ownAddress,
    ...(clean === '' ? {} : { note: clean }),
  };
}

// "Send 3.78 USDC to 0xd7b2...5050 inside NEAR Intents", or "Pay 0.01 ETH to 0xd7b2...5050 on
// Ethereum". One door, two drafts, and `where` decides which with no default: 'intents' keeps
// the money inside the verifier (an intents_send draft, the same asset arriving in another
// intents account), a network id pays it out on that chain (an intents_pay draft, the money
// leaving the verifier for good). `to` is the ONE field on the propose surface that names where
// money ends up, and it is not resolved here from anything the app knows: it is decoded for the
// place it is going (an intents account id, or an address as that chain spells it), never
// allowlisted, and shown in full on the card and in the Touch ID sentence, which are the gate.
// Both drafts always wait for that click (src/proposals/execute.ts). See the headers of
// src/rails/intents-send.ts and src/rails/intents-pay.ts.
export async function proposeSend(ctx: PCtx, params: SendParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const symbol = String(params.symbol ?? '').trim().toUpperCase();
  if (symbol === '') problems.push('The send has to name a symbol: which balance inside intents.near to move.');
  const where = String(params.where ?? '').trim();

  const from = ourIntentsAddress(ctx, problems).toLowerCase();

  if (where === 'intents') {
    const receiver = intentsAccountProblem(params.to);
    let to = '';
    if (!receiver.ok) {
      problems.push(`The receiving account is unusable: ${receiver.problem}.`);
    } else if (receiver.id === from) {
      problems.push(`${receiver.id} is this app's own intents account; a send to ourselves pays a fee to move nothing.`);
    } else {
      to = receiver.id;
    }
    const originAsset = heldFlavor(ctx, from, symbol, params.amount, 'send', problems);
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
      recipient: await recipientOf(ctx, 'intents', to, null, false, params.note),
    };
    return problems.length > 0
      ? refuseDraft(ctx, 'intents_send', draft, problems, params.clientKey)
      : proposeRail(ctx, 'intents_send', draft, params.clientKey);
  }

  if (!isChainNetwork(where)) {
    problems.push(`"${where.slice(0, 40)}" is not a place this app can send to: say 'intents', or a network id such as ethereum, base, arbitrum, solana or near.`);
  }
  const network: ChainNetwork = isChainNetwork(where) ? where : 'ethereum';
  const checked = validateAddress(network, String(params.to ?? ''));
  let to = '';
  let toChecksum: IntentsPayDraft['toChecksum'] = null;
  if (!checked.ok) {
    problems.push(`The receiving address is unusable: ${checked.reason}.`);
  } else {
    to = checked.normalized;
    toChecksum = checked.checksum ?? null;
  }
  // Our own wallet on that chain is allowed (it is what the old withdraw did) and named as
  // such. The comparison is EVM only: the key signs on no other chain.
  const ownAddress = to !== '' && /^0x/i.test(to) && to.toLowerCase() === from;
  const originAsset = heldFlavor(ctx, from, symbol, params.amount, 'pay out', problems);
  const draft: IntentsPayDraft = {
    kind: 'intents_pay',
    symbol,
    originAsset,
    network,
    amount: params.amount,
    amountUsd: usdOf(ctx, symbol, params.amount, snapshot),
    minReceived: minReceivedForPay(params.amount),
    from,
    to,
    toChecksum,
    counterparty: INTENTS_PAY_COUNTERPARTY,
    recipient: await recipientOf(ctx, network, to, to === '' ? null : network, ownAddress, params.note),
  };
  return problems.length > 0
    ? refuseDraft(ctx, 'intents_pay', draft, problems, params.clientKey)
    : proposeRail(ctx, 'intents_pay', draft, params.clientKey);
}
