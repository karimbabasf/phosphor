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
  SimulationResult,
  SwapDraft,
  SwapParams,
  SwapSpend,
} from '../types.ts';
import {
  HYPERCORE_COUNTERPARTY,
  minCreditedFor as minCreditedForHypercore,
} from '../rails/hypercore-deposit.ts';
import { HL_WITHDRAW_COUNTERPARTY, minReceivedForHlWithdraw } from '../rails/hypercore-withdraw.ts';
import { INTENTS_NATIVE_COUNTERPARTY } from '../rails/intents-native.ts';
import { INTENTS_RELAY_COUNTERPARTY, INTENTS_RELAY_VENUE } from '../rails/intents-relay.ts';
import { swapRailOf } from '../config.ts';
import { floorUnderQuote } from '../rails/slippage.ts';
import { INTENTS_SEND_COUNTERPARTY, intentsAccountProblem, minReceivedForSend } from '../rails/intents-send.ts';
import { INTENTS_PAY_COUNTERPARTY, minReceivedForPay, payFamilyOf, payLabel, payRefusal } from '../rails/intents-pay.ts';
import { scanNetworkOf, validateAddressForFamily } from '../chainscan/index.ts';
import type { ChainNetwork } from '../chainscan/index.ts';
import { recipientFor } from '../recipients.ts';
import { amountAsk, baseUnitsToDecimal, canonicalSymbol, decimalToBaseUnits, heldSymbol, oneLine } from '../intents.ts';
import type { AmountAsk } from '../intents.ts';
import { reasonOf } from '../rails/reasons.ts';
import type { ReasonCode } from '../rails/reasons.ts';
import { ourEvmAddress, ourIntentsAddress, presimulate, pricing, proposeRail, refuseDraft, usdOf } from './draft.ts';
import { errText } from './lifecycle.ts';
import type { PCtx } from './lifecycle.ts';
import { RELAY_DEADLINE_GRACE_MS } from './reconcile.ts';
import { draftSymbolOf, pickSwapSides } from './swap-reads.ts';
import type { SidePick, SwapSide } from './swap-reads.ts';

/* A SWAP PROPOSAL IN TWO HALVES, so the spend queue never waits on the network.
   prepareSwap reads the world: the balance, the price the floor is cut from, the simulation.
   It holds no lock and reserves nothing, so a second propose, an approve or a refuse is not
   queued behind its seconds of RPC and quotes (R5 B2). decideSwap runs inside the queue: the
   engine against the policy and the day's spend as they stand at that moment, and the landing
   that reserves. Read, decide, reserve stays one step where it has to be one: deciding and
   reserving. */
export type PreparedSwap = {
  params: SwapParams;
  draft: SwapDraft;
  refusal: { problems: string[]; code: ReasonCode | undefined } | null;
  simulation: SimulationResult | null;
  // Why this swap waits for a click whatever its size, when the builder found a reason.
  ask?: string | null;
};

export function decideSwap(ctx: PCtx, prepared: PreparedSwap): Promise<Proposal> {
  const { params, draft, refusal } = prepared;
  if (refusal !== null) return refuseDraft(ctx, 'swap', draft, refusal.problems, params, refusal.code);
  return proposeRail(ctx, 'swap', draft, params, prepared.simulation, prepared.ask ?? earlierSwapMayRun(ctx, draft));
}

/* AN EARLIER SWAP OF THE SAME COIN THAT MAY STILL GO THROUGH. An open swap that signed a transfer (a
   nonce or a handle on the row) can still run until its deadline, whether 1Click answered FAILED
   (venue_failed_watching, audit finding 9) or never answered (stuck_unknown, finding 11), so a new
   swap from the same coin could land beside it: that one waits for a click, whatever its size. The
   deadline is judged as reconcile judges it, with the clock-skew grace, and a row with no deadline
   never signed a transfer. Read inside the spend queue, so two asks cannot both miss the same row. */
export const EARLIER_SWAP_ASK = 'An earlier swap of this coin may still go through, so this one waits for your OK.';

function earlierSwapMayRun(ctx: PCtx, draft: SwapDraft): string | null {
  const coin = (d: SwapDraft): string => `${d.chain.toLowerCase()}|${d.fromSymbol.toUpperCase()}`;
  const now = Date.now();
  const signedAndLive = (p: Proposal): boolean => {
    const evidence = p.result?.evidence;
    return (evidence?.nonce !== undefined || evidence?.handle !== undefined) && now < Date.parse(evidence?.deadline ?? '') + RELAY_DEADLINE_GRACE_MS;
  };
  const live = ctx.store
    .list()
    .some((p) => p.status === 'needs_reconciliation' && p.draft.kind === 'swap' && signedAndLive(p) && coin(p.draft) === coin(draft));
  return live ? EARLIER_SWAP_ASK : null;
}

export async function prepareSwap(ctx: PCtx, params: SwapParams): Promise<PreparedSwap> {
  const snapshot = ctx.ledger.snapshot();
  const problems: string[] = [];
  // The cause of the first problem, which is the one the card and the agent read.
  let code: ReasonCode | undefined;
  const refuse = (why: string, cause: ReasonCode): void => {
    problems.push(why);
    code ??= cause;
  };
  /* A COIN NAMED WITHOUT ITS NETWORK is picked by the rule swap_quote uses (pickSwapSides): the
     coin spent is the one the balance holds; the coin bought is the one held, else the one that
     would get the most of up to four asked, else the one on NEAR. A coin named with its network is
     taken as named. With no venue list to read (a hand-built registry) the bought coin is on the
     sold coin's network, as it always was. */
  let chain = params.chain ?? '';
  let toChain = params.toChain ?? '';
  let fromAsked = params.fromSymbol;
  let toAsked = params.toSymbol;
  if (params.chain === undefined || params.toChain === undefined) {
    const sideAsk = (asked: string, named: string | undefined) => (named === undefined ? { asked } : { asked, chain: named });
    let picked: Awaited<ReturnType<typeof pickSwapSides>> = null;
    try {
      picked = await pickSwapSides(ctx, sideAsk(params.fromSymbol, params.chain), sideAsk(params.toSymbol, params.toChain), params.amountIn);
    } catch (err) {
      refuse(`The swap service's coin list could not be read, so the coin could not be found (${errText(err)}). Try again in a minute.`, 'no_price');
    }
    const settle = (pick: SidePick, which: string): SwapSide | null => {
      if (pick.kind === 'one') return pick.side;
      if (pick.kind === 'many') {
        const named = pick.candidates.map((c) => `${c.symbol} on ${c.network} (${c.assetId})`).join(', ');
        refuse(`Several coins go by that name for ${which}: ${named}. Name one by its id.`, 'ambiguous_asset');
      } else refuse(pick.why, pick.code ?? 'unsupported_asset');
      return null;
    };
    if (picked !== null) {
      const sold = params.chain === undefined ? settle(picked.from, 'the coin you sell') : null;
      if (sold !== null) [chain, fromAsked] = [sold.network, draftSymbolOf(sold, picked.list)];
      const bought = params.toChain === undefined ? settle(picked.to, 'the coin you buy') : null;
      if (bought !== null) [toChain, toAsked] = [bought.network, draftSymbolOf(bought, picked.list)];
    } else if (problems.length === 0) {
      if (params.chain === undefined) refuse('Say which network the coin you sell is on, such as near or eth.', 'invalid_request');
      toChain = params.toChain ?? chain;
    }
  }

  // Both sides are our own account inside the verifier. The agent picks the assets; it has
  // no way to say who receives the output.
  //
  // chain and toChain name the home chains of the two ASSETS, never a wallet: "USDC from eth"
  // and "USDC from arb" are two ids in the 1Click token list, and nothing here lands on a
  // chain. Deriving an address from either used to author a SOL-in-intents draft for a
  // Solana address the app never signed with, so the pair was unsellable; the account is the
  // EVM address for every asset.
  const from = ourIntentsAddress(ctx, problems);

  // The name the verifier and the wallet row use, not the one the agent typed: NEAR inside
  // intents is wNEAR (src/intents.ts, canonicalSymbol). Booked here so the card, the policy and
  // the balance watch all read the same word.
  const fromSymbol = canonicalSymbol(chain, fromAsked);
  const toSymbol = canonicalSymbol(toChain, toAsked);

  // The venue is the config switch's word at the moment of the ask (`swap.rail`), pinned into
  // the draft so the row is executed, retried and reconciled by the rail it was drafted for
  // whatever the switch says later. Both rails share the one counterparty: the verifier.
  const relay = swapRailOf(ctx.cfg) === 'relay';
  const ask = amountAsk(params.amountIn);
  const draft: SwapDraft = {
    kind: 'swap',
    venue: relay ? INTENTS_RELAY_VENUE : 'intents-native',
    chain,
    toChain,
    fromSymbol,
    toSymbol,
    amountIn: ask === null || ask.all ? 0 : Number(ask.text),
    ...(ask === null || ask.all ? {} : { amountInExact: ask.text }),
    amountUsd: 0,
    minAmountOut: params.minAmountOut ?? 0,
    from,
    to: from,
    counterparty: relay ? INTENTS_RELAY_COUNTERPARTY : INTENTS_NATIVE_COUNTERPARTY,
    quote: null,
  };
  if (ask === null) refuse('The amount has to be "all" or a number above zero, like 1.5.', 'invalid_request');
  const rail = ctx.rails.for(draft);

  /* THE EXACT AMOUNT, AND NEVER MORE THAN IS HELD. The rail names the coin spent and reads what
     the verifier holds of it; "all" is that figure to the last base unit, an amount is cut to
     the coin's own decimals, and one larger than the balance is refused here, before any price
     is asked for. The whole wNEAR balance travelled as a double on 2026-09-23 and came back
     67,589,776 yocto larger than it was: three signed transfers that could never run. */
  // The coin spent, by id, once the rail has named it: what it is priced by when only 1Click prices it.
  let spentAsset: string | undefined;
  if (problems.length === 0 && ask !== null) {
    if (rail !== null && typeof rail.spend === 'function') {
      try {
        const spent = await rail.spend(draft);
        spentAsset = spent.assetId;
        const exact = exactSpend(ask, spent, fromSymbol);
        if ('why' in exact) refuse(exact.why, exact.cause);
        else {
          draft.amountInExact = baseUnitsToDecimal(exact.base, spent.decimals);
          draft.amountIn = Number(draft.amountInExact);
        }
      } catch (err) {
        refuse(errText(err), reasonOf(err) ?? 'simulation_failed');
      }
    } else if (ask.all) {
      refuse(`This app cannot read the ${fromSymbol} balance here, so it cannot tell how much all of it is. Name an amount instead.`, 'balance_unread');
    }
  }
  draft.amountUsd = usdOf(ctx, fromSymbol, draft.amountIn, snapshot, spentAsset);

  /* THE FLOOR COMES OFF THE QUOTE. An agent that names none is not guessing one for us: the
     rail is asked for its floor-free price now and the floor is set one percent under it
     (floorUnderQuote), pinned into the draft before the engine or a person sees the row, so
     what is approved is what is held. No price is a refusal, never a floor of zero, and a
     refusal says its real cause: the venue not listing a coin used to read as "nobody offered a
     price" because every error here was swallowed (R1, 2026-09-23). */
  if (params.minAmountOut === undefined && problems.length === 0) {
    let priced: number | null = null;
    let failure: unknown = null;
    if (rail !== null && typeof rail.quote === 'function') {
      try {
        priced = await rail.quote(draft);
      } catch (err) {
        failure = err;
      }
    }
    if (failure !== null) refuse(`No floor could be set for ${fromSymbol} to ${toSymbol}: ${errText(failure)}`, reasonOf(failure) ?? 'simulation_failed');
    else if (priced === null || !(priced > 0)) {
      refuse(`Nobody offered a price for ${fromSymbol} to ${toSymbol} right now, so no floor could be set. Try again in a minute.`, 'no_price');
    } else {
      draft.minAmountOut = floorUnderQuote(priced);
    }
  }

  if (problems.length > 0) return { params, draft, refusal: { problems, code }, simulation: null };
  const simulation = await presimulate(ctx, 'swap', draft);

  /* A LISTED PRICE IS BOUNDED BY THE QUOTE. A coin priced only by 1Click's list is governed at the
     larger of the list's value and the quote's own value of what arrives: 1 WBTC listed at $84, a
     thousandfold slip, ran with no click while the quote said 84,000 USDC arrives (audit, finding
     7). With nothing off the quote to check the list by, the swap waits for a click. A bought coin
     priced by the list too is nothing to check by: 1Click prices the whole BTC family off one
     number, so WBTC to cbBTC read $84 on both sides and ran (audit, finding 10). */
  let unchecked: string | null = null;
  if (spentAsset !== undefined && pricing(ctx, fromSymbol, snapshot, spentAsset)?.source === 'list') {
    const receives = Number(simulation?.swap?.receives);
    const quoted = Number.isFinite(receives) ? usdOf(ctx, toSymbol, receives, snapshot) : Infinity;
    if (Number.isFinite(quoted)) draft.amountUsd = Math.max(draft.amountUsd, quoted);
    if (!Number.isFinite(quoted) || pricing(ctx, toSymbol, snapshot)?.source === 'list') {
      unchecked = `This swap spends ${fromSymbol} at 1Click's listed price, and nothing in its quote can check that price, so it waits for your OK.`;
    }
  }
  return { params, draft, refusal: null, simulation, ask: unchecked };
}

/* The base units a swap spends, or why it cannot: "all" is the balance read a moment ago, an
   amount is cut to the coin's decimals and has to fit inside that balance when it was read. An
   amount with no read is let through here and held to the balance again before signing. */
function exactSpend(ask: AmountAsk, spent: SwapSpend, symbol: string): { base: bigint } | { why: string; cause: ReasonCode } {
  const held = spent.heldBase;
  const heldText = held === null ? '' : baseUnitsToDecimal(held, spent.decimals);
  if (ask.all) {
    if (held === null) return { why: `The ${symbol} balance could not be read just now, so this cannot tell how much all of it is. Try again in a moment.`, cause: 'balance_unread' };
    if (held === 0n) return { why: `The balance inside NEAR Intents holds no ${symbol}.`, cause: 'insufficient_balance' };
    return { base: held };
  }
  const base = decimalToBaseUnits(ask.text, spent.decimals);
  if (base === 0n) return { why: `${ask.text} ${symbol} is smaller than the smallest amount of ${symbol} (${spent.decimals} decimals).`, cause: 'invalid_request' };
  if (held !== null && base > held) {
    return { why: `The balance inside NEAR Intents holds ${heldText} ${symbol}, less than the ${ask.text} this swap asks for.`, cause: 'insufficient_balance' };
  }
  return { base };
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

  return problems.length > 0 ? refuseDraft(ctx, 'hl_deposit', draft, problems, params) : proposeRail(ctx, 'hl_deposit', draft, params);
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

  return problems.length > 0 ? refuseDraft(ctx, 'hl_withdraw', draft, problems, params) : proposeRail(ctx, 'hl_withdraw', draft, params);
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
    .filter((h) => h.symbol.toUpperCase() === symbol.toUpperCase() && h.amount > 0)
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

// "Send 3.78 USDC to 0xb583...5DB0 inside NEAR Intents", or "Pay 0.01 ETH to 0xb583...5DB0 on
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
  // Uppercased like every ticker on this surface, then aliased: "NEAR" inside the verifier is
  // the wNEAR row, and the draft carries that name so heldFlavor and the card agree with the
  // swap that booked it.
  const symbol = heldSymbol(String(params.symbol ?? '').trim().toUpperCase());
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
      ? refuseDraft(ctx, 'intents_send', draft, problems, params)
      : proposeRail(ctx, 'intents_send', draft, params);
  }

  /* A chain this app can decode an address for. The refusal names what is missing rather than
     calling the chain unknown: it is on the deposit card, a person can see it there, and the
     money can still come in on it and be swapped. */
  const refused = where === ''
    ? "The send has to say where it lands: 'intents' to keep it inside NEAR Intents, or a chain id such as eth, base, arb, sol or near."
    : payRefusal(where);
  if (refused !== null) problems.push(refused.endsWith('.') ? refused : `${refused}.`);
  const network = refused === null ? where : 'eth';
  const family = payFamilyOf(network) ?? 'evm';
  const checked = validateAddressForFamily(family, String(params.to ?? ''), payLabel(network));
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
    // The chain is asked only about a draft that can still be sent: a refused one is a sentence,
    // not a lookup.
    recipient: await recipientOf(ctx, network, to, to === '' || problems.length > 0 ? null : scanNetworkOf(network), ownAddress, params.note),
  };
  return problems.length > 0
    ? refuseDraft(ctx, 'intents_pay', draft, problems, params)
    : proposeRail(ctx, 'intents_pay', draft, params);
}
