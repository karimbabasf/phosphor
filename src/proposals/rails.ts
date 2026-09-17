// The four drafts that move money from one place to another: a swap, the Hyperliquid deposit,
// and the two intents moves in and out of the verifier.
//
// Each one resolves its own addresses and amounts from what the app already knows, never from
// the caller, and then hands the draft to proposeRail, which evaluates, simulates and lands it.

import type {
  HlDepositDraft,
  HlDepositParams,
  HlWithdrawDraft,
  HlWithdrawParams,
  IntentsDepositDraft,
  IntentsDepositParams,
  IntentsWithdrawDraft,
  IntentsWithdrawParams,
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
import { ONECLICK_COUNTERPARTY } from '../rails/oneclick.ts';
import { HL_WITHDRAW_COUNTERPARTY, minReceivedForHlWithdraw } from '../rails/hypercore-withdraw.ts';
import { INTENTS_DEPOSIT_COUNTERPARTY, minCreditedFor } from '../rails/intents-deposit.ts';
import { INTENTS_NATIVE_COUNTERPARTY } from '../rails/intents-native.ts';
import {
  INTENTS_WITHDRAW_COUNTERPARTY,
  WITHDRAW_DESTINATIONS,
  minReceivedFor,
  ourWalletOn,
} from '../rails/intents-withdraw.ts';
import { INTENTS_SEND_COUNTERPARTY, intentsAccountProblem, minReceivedForSend } from '../rails/intents-send.ts';
import { NATIVE_ASSET, NATIVE_TOKEN_ID } from '../intents.ts';
import { ourAddress, ourIntentsAddress, proposeRail, refuseDraft, usdOf } from './draft.ts';
import type { PCtx } from './lifecycle.ts';

export async function proposeSwap(ctx: PCtx, params: SwapParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  // Two venues, and no default. There used to be a third (an on-chain DEX) that anything
  // unrecognised fell through to, so a name this app did not run was silently swapped
  // somewhere else. It refuses by name now, which is the only honest answer once the
  // fallback is gone.
  const venue = params.venue === 'intents-native' ? 'intents-native' : 'oneclick';
  if (params.venue !== undefined && params.venue !== 'oneclick' && params.venue !== 'intents-native') {
    problems.push(
      `'${params.venue}' is not a venue this app swaps on. It swaps through 1Click ('oneclick') or ` +
        "inside the NEAR Intents verifier ('intents-native').",
    );
  }
  const toChain = params.toChain ?? params.chain;

  // Both sides are our own wallet. The agent picks the chains and the symbols; it has no
  // way to say who receives the output.
  //
  // toChain means two different things depending on the venue, and conflating them made the
  // intents-native rail unreachable for every pair it exists to serve. On an on-chain venue
  // it names where the output LANDS, so the recipient is that chain's address. On
  // intents-native nothing lands on a chain at all: the proceeds are credited to our own
  // account inside the verifier, so toChain names only the destination ASSET's home chain
  // and the recipient stays the origin address. Deriving `to` from toChain regardless sent
  // a sol address into a draft whose own rail requires from === to, so the swap was refused
  // as unsimulatable while omitting toChain failed asset lookup instead. No argument
  // combination worked. Note this is strictly narrowing: intents-native can now only ever
  // pay ourselves, which is what the rail already asserted in requireVenue.
  // `from` carried the same bug as `to` above, and it was found the same way: a swap that
  // passed simulation and was refused at execution, after the policy engine had already
  // allowed it. On intents-native, chain names the origin ASSET's home chain, not a wallet,
  // for exactly the reason toChain does not name a destination wallet. Deriving `from` from
  // params.chain authored a SOL-in-intents draft for our Solana address, which execute()
  // refuses because the configured key is the EVM one. The pair was unsellable either way:
  // chain 'sol' resolved the asset and the wrong owner, and any EVM chain resolved the right
  // owner but could not name SOL at all.
  const from =
    venue === 'intents-native'
      ? ourIntentsAddress(ctx, snapshot, problems)
      : ourAddress(ctx, params.chain, snapshot, problems);
  const to =
    venue === 'intents-native' || params.chain === toChain
      ? from
      : ourAddress(ctx, toChain, snapshot, problems);

  const counterparty = venue === 'intents-native' ? INTENTS_NATIVE_COUNTERPARTY : ONECLICK_COUNTERPARTY;

  const draft: SwapDraft = {
    kind: 'swap',
    venue,
    chain: params.chain,
    toChain,
    fromSymbol: params.fromSymbol,
    toSymbol: params.toSymbol,
    amountIn: params.amountIn,
    amountUsd: usdOf(ctx, params.fromSymbol, params.amountIn, snapshot),
    minAmountOut: params.minAmountOut,
    from,
    to,
    counterparty,
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
  // the same way the deposit rail credits it and the withdraw rail spends it.
  const from = ourIntentsAddress(ctx, snapshot, problems).toLowerCase();

  // The trading account is the app's own EVM address. Hyperliquid identifies an account by
  // the address that signs for it, so crediting anything else funds a book this app cannot
  // trade. Derived here, never taken from a caller: the whole point of the propose surface
  // is that an agent cannot name where money goes.
  const hlAccount = ourAddress(ctx, 'eth', snapshot, problems);

  // Which flavor of the asset to spend. A balance inside intents.near is keyed by the bridged
  // asset it arrived as (USDC from eth and USDC from arb are two ids), so the builder reads
  // what is held and spends the largest matching one. It refuses only where it is certain:
  // no read at all, nothing matching, or a balance it can name as too small. Anything else is
  // left for the contract to answer, for the reason the withdraw builder gives below.
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

  const from = ourAddress(ctx, 'eth', snapshot, problems);
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

// "Deposit $10 onto NEAR Intents." The agent names a chain, optionally a symbol, and an
// amount. Everything that decides where the money ends up is resolved here from the app's
// own state: the wallet it leaves, the account credited inside the verifier, the loss floor
// and the counterparty. There is deliberately no argument for any of them.
export async function proposeIntentsDeposit(ctx: PCtx, params: IntentsDepositParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const from = ourAddress(ctx, params.chain, snapshot, problems);

  // Default to the chain's gas asset, because that is what a bare "deposit $10 from
  // ethereum" means and it is the case the ERC-20 path could not serve.
  const native = NATIVE_ASSET[params.chain];
  const symbol = params.symbol ?? native?.symbol ?? '';
  if (symbol === '') {
    problems.push(`No default asset for ${params.chain}, so the deposit has to name a symbol.`);
  }
  const tokenId = native !== undefined && symbol === native.symbol ? NATIVE_TOKEN_ID : symbol;

  // The verifier derives an account id from the erc191 signer, and that id is the EVM
  // address lowercased. Credit anything else and the balance is real but unspendable by
  // this app, so it is derived here and never taken from a caller.
  const intentsAccount = from.toLowerCase();

  const draft: IntentsDepositDraft = {
    kind: 'intents_deposit',
    chain: params.chain,
    symbol,
    tokenId,
    amount: params.amount,
    amountUsd: usdOf(ctx, symbol, params.amount, snapshot),
    minCredited: minCreditedFor(params.amount),
    from,
    intentsAccount,
    counterparty: INTENTS_DEPOSIT_COUNTERPARTY,
  };

  return problems.length > 0
    ? refuseDraft(ctx, 'intents_deposit', draft, problems, params.clientKey)
    : proposeRail(ctx, 'intents_deposit', draft, params.clientKey);
}

export async function proposeIntentsWithdraw(ctx: PCtx, params: IntentsWithdrawParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];

  // The account whose balance is spent inside the verifier. Derived the same way the deposit
  // rail credits it, from our own EVM address lowercased, so a deposit and the withdrawal
  // that undoes it name the same account by construction. 'eth' only picks which chain's
  // address row to read; the three EVM chains share one address.
  const from = ourAddress(ctx, 'eth', snapshot, problems).toLowerCase();

  // Where it lands. Read from config here and again inside the rail, which refuses a draft
  // naming anything else. There is no argument that can reach this.
  const to = ourWalletOn(params.chain, ctx.cfg.addresses) ?? '';
  if (!WITHDRAW_DESTINATIONS.includes(params.chain)) {
    problems.push(
      `Withdrawals go to ${WITHDRAW_DESTINATIONS.join(', ')} only. A NEAR payout would go to an account id ` +
        'nobody signed for.',
    );
  } else if (to === '') {
    problems.push(`No ${params.chain} address is configured, so there is no wallet of ours to withdraw to.`);
  }

  const native = NATIVE_ASSET[params.chain];
  const symbol = params.symbol ?? native?.symbol ?? '';
  if (symbol === '') {
    problems.push(`No default asset for ${params.chain}, so the withdrawal has to name a symbol.`);
  }

  // What the verifier actually holds, from the same read the wallet panel shows. A withdrawal
  // for more than that gets signed, submitted and rejected by the contract: no money is lost,
  // but the human learns nothing, so naming the number here is worth doing.
  //
  // It refuses only where it is CERTAIN, and that restraint is the point. The symbol and the
  // chain on an intents holding are labels looked up in the 1Click token list, and
  // src/ledger/intents.ts degrades them to the raw asset id at zero decimals when that list
  // momentarily fails to load, which it does (seen live 2026-08-13). Keying a refusal on a
  // label that can degrade would silently block every withdrawal whenever a remote list
  // blipped, which is a worse failure than the one this check prevents. So: an empty verifier
  // is unambiguous and refuses, a positively identified balance that is too small refuses and
  // names itself, and anything else says nothing and lets the contract answer.
  const read = ctx.ledger.intents();
  if (read !== undefined && read.ok) {
    if (read.holdings.length === 0) {
      problems.push(`intents.near holds nothing for ${from}, so there is nothing to withdraw.`);
    } else {
      const held = read.holdings.find((h) => h.symbol === symbol && h.originChain === params.chain);
      if (held !== undefined && held.amount < params.amount) {
        problems.push(
          `intents.near holds ${held.amount} ${symbol} from ${params.chain} for ${from}, which is less than ` +
            `the ${params.amount} this would withdraw.`,
        );
      }
    }
  }

  const draft: IntentsWithdrawDraft = {
    kind: 'intents_withdraw',
    chain: params.chain,
    symbol,
    amount: params.amount,
    amountUsd: usdOf(ctx, symbol, params.amount, snapshot),
    minReceived: minReceivedFor(params.amount),
    from,
    to,
    counterparty: INTENTS_WITHDRAW_COUNTERPARTY,
  };

  return problems.length > 0
    ? refuseDraft(ctx, 'intents_withdraw', draft, problems, params.clientKey)
    : proposeRail(ctx, 'intents_withdraw', draft, params.clientKey);
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
  // certain and lets the contract answer otherwise, for the reason the withdraw builder gives.
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
