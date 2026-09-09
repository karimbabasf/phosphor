// The four drafts that move money from one place to another: a swap, the Hyperliquid deposit,
// and the two intents moves in and out of the verifier.
//
// Each one resolves its own addresses and amounts from what the app already knows, never from
// the caller, and then hands the draft to proposeRail, which evaluates, simulates and lands it.

import type {
  HlDepositDraft,
  HlDepositParams,
  IntentsDepositDraft,
  IntentsDepositParams,
  IntentsWithdrawDraft,
  IntentsWithdrawParams,
  Proposal,
  SwapDraft,
  SwapParams,
} from '../types.ts';
import {
  HYPERCORE_COUNTERPARTY,
  minCreditedFor as minCreditedForHypercore,
} from '../rails/hypercore-deposit.ts';
import { ONECLICK_COUNTERPARTY } from '../rails/oneclick.ts';
import { INTENTS_DEPOSIT_COUNTERPARTY, minCreditedFor } from '../rails/intents-deposit.ts';
import { INTENTS_NATIVE_COUNTERPARTY } from '../rails/intents-native.ts';
import {
  INTENTS_WITHDRAW_COUNTERPARTY,
  WITHDRAW_DESTINATIONS,
  minReceivedFor,
  ourWalletOn,
} from '../rails/intents-withdraw.ts';
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

  return problems.length > 0 ? refuseDraft(ctx, 'swap', draft, problems) : proposeRail(ctx, 'swap', draft);
}

// "Put $200 into the trading account, from base." The origin chain is now the caller's
// choice rather than a fact about the bridge, because 1Click reaches all of them. What is
// still not the caller's choice: the wallet it leaves, the Hyperliquid account it credits,
// the loss floor and the counterparty. Those are resolved here from the app's own state,
// exactly as the Intents deposit does it.
export async function proposeHlDeposit(ctx: PCtx, params: HlDepositParams): Promise<Proposal> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  const chain = params.chain ?? 'arb';
  const from = ourAddress(ctx, chain, snapshot, problems);

  const native = NATIVE_ASSET[chain];
  const symbol = params.symbol ?? 'USDC';
  const tokenId = native !== undefined && symbol === native.symbol ? NATIVE_TOKEN_ID : symbol;

  // The trading account is the app's own EVM address. Hyperliquid identifies an account by
  // the address that signs for it, so crediting anything else funds a book this app cannot
  // trade. Derived here, never taken from a caller: the whole point of the propose surface
  // is that an agent cannot name where money goes.
  const hlAccount = ourAddress(ctx, 'eth', snapshot, problems);

  const draft: HlDepositDraft = {
    kind: 'hl_deposit',
    chain,
    symbol,
    tokenId,
    amount: params.amount,
    amountUsd: usdOf(ctx, symbol, params.amount, snapshot),
    // The hypercore floor, NOT the Intents one. That fee is proportional and this one is
    // nearly flat, so the 200 bps rule refuses honest quotes under about $17.
    minCredited: minCreditedForHypercore(params.amount),
    from,
    hlAccount,
    counterparty: HYPERCORE_COUNTERPARTY,
  };

  return problems.length > 0 ? refuseDraft(ctx, 'hl_deposit', draft, problems) : proposeRail(ctx, 'hl_deposit', draft);
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
    ? refuseDraft(ctx, 'intents_deposit', draft, problems)
    : proposeRail(ctx, 'intents_deposit', draft);
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
    ? refuseDraft(ctx, 'intents_withdraw', draft, problems)
    : proposeRail(ctx, 'intents_withdraw', draft);
}
