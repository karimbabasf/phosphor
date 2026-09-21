// The Hyperliquid exit: collateral leaves the perps account and lands back in the intents
// balance. The mirror of hypercore-deposit.ts, and the only rail in this app whose signature
// is a Hyperliquid user-signed action rather than a chain transaction or an intent.
//
// Until 2026-09-11 there was no exit at all. 1Click refused HyperCore as an origin, the
// terminal withdraw3 script had been deleted, and three surfaces still promised it. Now 1Click
// lists HyperCore spot USDC (`hip1`) as an origin, so the round trip closes without touching
// Arbitrum or the venue's bridge.
//
// THE SEQUENCE, one signature, nothing sent on any chain by us:
//   1. POST /v0/quote, depositType ORIGIN_CHAIN, recipientType INTENTS -> a fresh HyperCore
//      address 1Click minted for this quote
//   2. one sendAsset of exactly the quoted amount, from the venue account to that address,
//      signed with the master key. sendAsset and not spotSend: a unified account, which is the
//      venue's recommended mode and Karim's, refuses spotSend and usdSend outright ("Action
//      disabled when unified account is active", live 2026-09-20), and sendAsset is the one
//      transfer both account modes accept. 1Click lists it as a supported way in
//      (docs.near-intents.org, 1click-api/hyperliquid: "sendAsset: Supported. Spot or perp").
//   3. GET /v0/status until SUCCESS, REFUNDED or FAILED
//   4. read both sides: the venue ledger for the send, the verifier for the credit, and the
//      row is confirmed only once the verifier shows the credit. 1Click's SUCCESS is the
//      solver's word; until the balance rose the row sits in `crediting` with its handle,
//      nonce and ledger hash, and the next balance read that shows the rise settles it.
//
// WHAT IS DIFFERENT ABOUT THIS RAIL, and each is a refusal rather than a feature:
//
//   THE DESTINATION IS FIXED BY CONSTRUCTION. The intents account credited is the same key
//   that signs the send, lowercased. There is no argument for it on the tool, the proposal
//   service derives it, the rail re-derives it and refuses a mismatch, and the policy engine
//   checks it is ours a third time. An agent can move collateral between the app's own
//   pockets and cannot point it anywhere else.
//
//   IT IS ALWAYS A CLICK. The proposal pipeline downgrades an `allow` to `needs_approval`
//   for this kind whatever the size (src/proposals/execute.ts), beside the same rule for
//   arming a bot. Collateral leaves the venue only by hand.
//
//   IT REFUSES UNDER AN OPEN POSITION. Pulling margin from under a position is how a
//   liquidation gets manufactured, so any position or any margin in use refuses before a
//   quote is even asked for.
//
//   THE COST HAS THREE PARTS AND TWO OF THEM ARE INVISIBLE IN THE QUOTE. 1Click's routing
//   fee (about 0.20 flat) and its 25 bp app fee (present on every quote without a partner key,
//   echoed back as quoteRequest.appFees) both come out of what lands. The venue's activation
//   fee does not: every address 1Click mints is new to HyperCore, and the venue charges the
//   SENDER 1 USDC on top for the first transaction into a new account. So a withdrawal of 8
//   costs the account 9 and credits 7.78, which is 15 percent, and a withdrawal of 100 costs
//   101 and credits 99.5, which is 1.5 percent. The summary states every part as a number and
//   the total as a rate, the card carries the total as its fee fact and the floor as its
//   "arrives at least", and the floor refuses sizes where the flat part is most of it.
//
//   A REFUSAL FOR A SHORT BALANCE NAMES THE MOST THE ACCOUNT COULD SEND, so the person hears a
//   number to try rather than a wall: what is free less the activation fee.

import { formatUnits, isAddress } from 'viem';
import type { HlWithdrawDraft, Rail, RailHooks, RailResult, SimulationResult } from '../types.ts';
import { ONECLICK_TERMINAL, baseUnits, oneClickClient, oneLine, quoteEchoProblems, toBaseUnits } from '../intents.ts';
import type { OneClickClient, OneClickQuote, OneClickStatus, OneClickToken, QuoteEcho } from '../intents.ts';
import { deliveredAmount, deliveredNote, describeIncompleteDeposit, describeRefund, settledEvidence, tell, uniqueTxids } from './oneclick-words.ts';
import { quoteSignatureProblems, signedQuoteRecord } from '../quote-signature.ts';
import { fetchIntentsAssetBalance } from '../ledger/intents.ts';
import { nearChainSpec } from '../chain/near.ts';
import { readTimeout } from '../net.ts';
import { ONECLICK_COUNTERPARTY } from '../intents.ts';
import { HL_ACTIVATION_FEE_USDC, accountSummary, liveSignPort, maxSendableUsdc, sendAsset, toAmountString, usdClassTransfer } from './hl-user-signed.ts';
import type { HlAccountSummary, HlUserSignedDeps } from './hl-user-signed.ts';
import { HYPERCORE_USDC_ASSET_ID, HYPERCORE_USDC_DECIMALS } from './hypercore-deposit.ts';
import { INTENTS_SETTLE, watchRise } from '../ledger/settle.ts';
import type { PocketRead, RiseSchedule } from '../ledger/settle.ts';
import { appFeeBpsOf } from './intents-spend.ts';
import { TYPICAL_SEC } from '../proposals/view.ts';

// ---------- the two ends ----------

// The origin is the same pinned asset the deposit rail lands on: the documented HyperCore spot
// USDC, and the only hypercore id 1Click accepts as an origin. Verified against the live list on
// every quote, never replaced from it.
export const HYPERCORE_ORIGIN_ASSET_ID = HYPERCORE_USDC_ASSET_ID;
export const HYPERCORE_ORIGIN_DECIMALS = HYPERCORE_USDC_DECIMALS;

// Where it lands: USDC on NEAR, the canonical flavor inside the verifier. Pinned for the same
// reason as the origin. Any later move out of the balance quotes from this id.
export const INTENTS_USDC_ASSET_ID = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const INTENTS_USDC_DECIMALS = 6;

// The deposit address is per quote, so the venue string is the allowlist entry: the one the
// swap rail already has.
export const HL_WITHDRAW_COUNTERPARTY = ONECLICK_COUNTERPARTY;

// The fee inside the quote: measured 0.20 flat plus about 26 bp (10 route, 25 app, rounding)
// on 2026-09-11 and again 2026-09-20 (5 in, 4.787511 out), with headroom on both terms, for
// the same reason the deposit rail gives.
export const HL_WITHDRAW_FLAT_USDC = 0.25; // measured 0.20
export const HL_WITHDRAW_FEE_BPS = 40; // measured about 26
export const HL_WITHDRAW_SLIPPAGE_BPS = 10;

// The fee outside the quote, paid by the venue account on top of the amount.
export const HL_ACTIVATION_USDC = HL_ACTIVATION_FEE_USDC;

// Below this the 1.2 USDC of flat cost is most of the withdrawal. 5 is where the refusal can
// say "you would pay a quarter of it" and be right.
export const MIN_HL_WITHDRAW_USDC = 5;

// The rail's sentence for a send the router confirmed and the verifier has not shown. Never the
// word "failed": the money is a block away, and "failed" is how a second copy gets signed. The
// boot sweep reads "has not shown" and keeps the row waiting on the venue (src/proposals/reconcile.ts).
export const SETTLING_WITHDRAW =
  'The router reports the withdrawal settled and the intents balance has not shown it yet. ' +
  'Nothing more will be signed until the next balance read confirms it.';

// A USDC figure as money: six places, trailing zeros off. A sum of two doubles printed raw put
// "8.209399000000001 USDC" in front of a person (2026-09-20).
function usdc(amount: number): string {
  return Number.isFinite(amount) ? amount.toFixed(6).replace(/\.?0+$/, '') : String(amount);
}

// What must land inside the verifier. The activation fee is not subtracted here: it never
// enters the route, the venue takes it from the sender beside the amount.
export function minReceivedForHlWithdraw(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount - (HL_WITHDRAW_FLAT_USDC + (amount * HL_WITHDRAW_FEE_BPS) / 10_000);
}

// ---------- the seams ----------

export type HypercoreWithdrawDeps = {
  keysPath: string;
  client?: OneClickClient; // the registry's shared 1Click client, so the token list is fetched once
  hl?: HlUserSignedDeps; // the venue reads and the send; defaults to the live key
  // The verifier's balance of one asset for one account, in base units, or null when it would
  // not answer. Defaults to the NEAR RPC read the ledger uses.
  intentsBalance?: (accountId: string, assetId: string) => Promise<bigint | null>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  // The key 1Click signs quotes with. Left unset it is the production key; a test hands the
  // key its own fake signs with, and nothing else ever sets it.
  quoteKey?: string;
  // How long, and how often, the verifier is re-read once 1Click says SUCCESS. Defaults to
  // INTENTS_SETTLE (ninety seconds); the tests shorten it.
  settleSchedule?: RiseSchedule;
};

export type HypercoreWithdrawRail = Rail<HlWithdrawDraft>;

type Plan = {
  amountBase: bigint; // in the origin's 8 decimals
  minReceivedBase: bigint; // in the destination's 6 decimals
  account: HlAccountSummary;
  // On a standard account, how much has to move from the perp book to spot before the send.
  moveToSpot: number;
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function hypercoreWithdrawRail(deps: HypercoreWithdrawDeps): HypercoreWithdrawRail {
  const { keysPath } = deps;
  const client = deps.client ?? oneClickClient({ fetchImpl: deps.fetchImpl });
  const hl: HlUserSignedDeps = deps.hl ?? { keysPath, fetchImpl: deps.fetchImpl, now: deps.now };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const intentsBalance =
    deps.intentsBalance ??
    ((accountId: string, assetId: string) =>
      fetchIntentsAssetBalance({ rpcUrl: nearChainSpec().rpcUrl, accountId, assetId, fetchImpl }));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? 3000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 180_000;
  const quoteKey = deps.quoteKey;
  const settleSchedule = deps.settleSchedule ?? INTENTS_SETTLE;

  function refusal(draft: HlWithdrawDraft, reasons: string[], lines: string[] = []): SimulationResult {
    const joined = reasons.join('; ');
    return {
      ok: false,
      summary: [`REFUSED: withdraw ${draft.amount} USDC from Hyperliquid - ${joined}`, ...lines].join('\n'),
      error: joined,
    };
  }

  // The venue account is the key that signs the send, and the intents account credited is
  // that same key lowercased. Both read from the key, never from the draft, and compared
  // against it: this is the check that makes "the agent cannot name a destination" a property
  // of the rail rather than of the tool schema.
  function requireOwner(draft: HlWithdrawDraft): string {
    const owner = (hl.sign ?? liveSignPort).address(keysPath).toLowerCase();
    if (draft.from.toLowerCase() !== owner) {
      throw new Error(`draft withdraws from ${draft.from} but the configured key is ${owner}`);
    }
    if (draft.to.toLowerCase() !== owner) {
      throw new Error(
        `draft credits ${oneLine(draft.to, 60)}, which is not our own intents account (${owner}); ` +
          'collateral leaving the venue lands in that balance and nowhere else',
      );
    }
    return owner;
  }

  function pinProblems(list: OneClickToken[]): string[] {
    const problems: string[] = [];
    const origin = list.find((t) => t.assetId === HYPERCORE_ORIGIN_ASSET_ID);
    if (origin === undefined) {
      const hypercore = list.filter((t) => t.blockchain.toLowerCase() === 'hypercore').map((t) => t.assetId);
      problems.push(
        `the pinned HyperCore USDC asset id is no longer in the 1Click token list. Pinned: ${HYPERCORE_ORIGIN_ASSET_ID}. ` +
          `Live hypercore assets: ${hypercore.length > 0 ? hypercore.join(', ') : 'none'}. This rail will not take a ` +
          'replacement id from the API; update the constant deliberately',
      );
    } else if (origin.decimals !== HYPERCORE_ORIGIN_DECIMALS) {
      problems.push(
        `HyperCore USDC decimals changed: pinned ${HYPERCORE_ORIGIN_DECIMALS}, live ${origin.decimals}. ` +
          'Every amount this rail sends would be wrong by a factor of ten',
      );
    }
    const dest = list.find((t) => t.assetId === INTENTS_USDC_ASSET_ID);
    if (dest === undefined) {
      problems.push(`1click does not list ${INTENTS_USDC_ASSET_ID}, the USDC this rail lands inside the verifier`);
    } else if (dest.decimals !== INTENTS_USDC_DECIMALS) {
      problems.push(`intents USDC decimals changed: pinned ${INTENTS_USDC_DECIMALS}, live ${dest.decimals}`);
    }
    return problems;
  }

  // Everything decidable BEFORE a quote, and in this rail that includes the venue account,
  // because an open position refuses whatever the price is.
  async function plan(draft: HlWithdrawDraft): Promise<{ plan?: Plan; reasons: string[] }> {
    if (draft.counterparty !== HL_WITHDRAW_COUNTERPARTY) {
      return { reasons: [`counterparty ${oneLine(draft.counterparty, 60)} is not ${HL_WITHDRAW_COUNTERPARTY}, the routing venue`] };
    }
    if (!isAddress(draft.from.trim())) {
      return { reasons: [`the venue account ${oneLine(draft.from, 60)} is not an EVM address`] };
    }
    if (draft.to.trim().toLowerCase() !== draft.from.trim().toLowerCase()) {
      return {
        reasons: [
          `the destination ${oneLine(draft.to, 60)} is not our own intents account: a withdrawal lands in the balance ` +
            'owned by the key that signs it and nowhere else',
        ],
      };
    }
    if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
      return { reasons: [`amount ${draft.amount} is not a positive number`] };
    }
    if (draft.amount < MIN_HL_WITHDRAW_USDC) {
      return {
        reasons: [
          `${draft.amount} USDC is below the ${MIN_HL_WITHDRAW_USDC} USDC floor. The cost is nearly flat, about ` +
            `${HL_WITHDRAW_FLAT_USDC} USDC of routing plus the ${HL_ACTIVATION_USDC} USDC activation fee the venue charges for ` +
            'the fresh deposit address, so at this size it would be most of the withdrawal; withdraw more at once',
        ],
      };
    }
    if (!Number.isFinite(draft.minReceived) || draft.minReceived <= 0) {
      return { reasons: [`the draft floors at ${draft.minReceived} USDC, which is no floor at all`] };
    }
    // The send takes a decimal string, and a number it cannot spell exactly is refused by
    // sendAsset after the live quote has been minted. Refuse it here instead, before any quote.
    try {
      toAmountString(draft.amount);
    } catch (err) {
      return { reasons: [errText(err)] };
    }

    let account: HlAccountSummary;
    try {
      account = await accountSummary(hl, draft.from);
    } catch (err) {
      return { reasons: [`could not read the Hyperliquid account: ${errText(err)}`] };
    }
    if (account.openPositions > 0) {
      return {
        reasons: [
          `the account has ${account.openPositions} open position${account.openPositions === 1 ? '' : 's'}; collateral ` +
            'leaves the venue only when it is flat, because pulling margin from under a position is how a liquidation ' +
            'gets manufactured. Close the position first',
        ],
      };
    }
    if (account.marginUsedUsd > 0) {
      return { reasons: [`the account has ${account.marginUsedUsd} USDC of margin in use; collateral leaves the venue only when it is flat`] };
    }

    // What the send can draw on, plus the activation fee the venue takes beside it. A unified
    // account has one balance; a standard one has two books and the rail moves between them.
    const needed = draft.amount + HL_ACTIVATION_USDC;
    const sendable = account.unified ? account.availableUsdc : account.spotUsdc + account.perpWithdrawableUsd;
    if (sendable < needed) {
      // The most that could go: free collateral less the activation fee, the same arithmetic
      // sendAsset would refuse on. Under the floor there is nothing to try, and the sentence
      // says so rather than offering a number the next line would refuse.
      const most = maxSendableUsdc(sendable, HL_ACTIVATION_USDC);
      const offer =
        most >= MIN_HL_WITHDRAW_USDC
          ? `The most that can come back now is ${usdc(most)} USDC`
          : `After the fee at most ${usdc(most)} USDC could come back, under the ${MIN_HL_WITHDRAW_USDC} USDC floor, so nothing can leave until more is on the account`;
      return {
        reasons: [
          `the account has ${usdc(sendable)} USDC and the withdrawal needs ${usdc(needed)} USDC: ${draft.amount} plus the ` +
            `${HL_ACTIVATION_USDC} USDC activation fee the venue charges the sender for a destination it has never seen. ${offer}`,
        ],
      };
    }
    const moveToSpot = account.unified ? 0 : Math.max(0, needed - account.spotUsdc);

    let list: OneClickToken[];
    try {
      list = await client.tokens();
    } catch (err) {
      return { reasons: [`could not read the 1Click token list: ${errText(err)}`] };
    }
    const pins = pinProblems(list);
    if (pins.length > 0) return { reasons: pins };

    return {
      plan: {
        amountBase: toBaseUnits(draft.amount, HYPERCORE_ORIGIN_DECIMALS),
        minReceivedBase: toBaseUnits(draft.minReceived, INTENTS_USDC_DECIMALS),
        account,
        moveToSpot,
      },
      reasons: [],
    };
  }

  function quoteParams(draft: HlWithdrawDraft, p: Plan, dry: boolean) {
    return {
      dry,
      originAsset: HYPERCORE_ORIGIN_ASSET_ID,
      destinationAsset: INTENTS_USDC_ASSET_ID,
      amount: p.amountBase.toString(),
      refundTo: draft.from,
      recipient: draft.to,
      recipientType: 'INTENTS' as const,
      refundType: 'ORIGIN_CHAIN' as const,
      depositType: 'ORIGIN_CHAIN' as const,
      // Named, not inherited. checkQuote gates on the guarantee this tolerance produces.
      slippageToleranceBps: HL_WITHDRAW_SLIPPAGE_BPS,
    };
  }

  /* What the human reads before clicking: every part of the cost as a number, and the total as
     a rate, because the number that decides is the total against THIS amount. Three parts:
     the routing leg and the 25 bp app fee sit inside the quote (what lands is already net of
     them), the activation fee sits outside it (the venue takes it from the sender beside the
     amount). The app fee is read off the quote's own echo, never assumed: a partner key removes
     it and the sentence must say 0 that day. */
  type Priced = {
    lines: string[];
    feePct: number;
    // The facts the card draws, in the shape the send card already reads (SendSimulation).
    facts: NonNullable<SimulationResult['send']>;
  };

  function priceLines(draft: HlWithdrawDraft, p: Plan, quote: OneClickQuote, raw: unknown): Priced {
    const out = Number(quote.amountOutFormatted);
    // The floor as the card prints it: the base-unit floor checkQuote holds the guarantee to,
    // formatted from that integer, so the card and the check cannot disagree by a rounding
    // (toFixed on the draft's double read 4.8541265 as 4.854126 where the check demanded
    // 4.854127; review, 2026-09-20). Six places on this side, so nothing is cut.
    const floor = formatUnits(p.minReceivedBase, INTENTS_USDC_DECIMALS);
    const insideQuote = Number.isFinite(out) ? draft.amount - out : NaN;
    const appBps = appFeeBpsOf(raw);
    const appFee = Number.isFinite(insideQuote) ? Math.min(insideQuote, (draft.amount * appBps) / 10_000) : NaN;
    const routing = Number.isFinite(insideQuote) ? insideQuote - appFee : NaN;
    const total = Number.isFinite(insideQuote) ? insideQuote + HL_ACTIVATION_USDC : NaN;
    const feePct = Number.isFinite(total) ? (total / draft.amount) * 100 : NaN;
    const books = p.account.unified
      ? ''
      : p.moveToSpot > 0
        ? `\n  first     ${p.moveToSpot.toFixed(4)} USDC moves from the perp side to spot first, same account, same key`
        : '';
    // The router's estimate covers its own leg; the venue shows the money after it. The card
    // counts the whole move against TYPICAL_SEC (src/proposals/view.ts), so that is the figure
    // here too, and the router's leg is named for what it is.
    const routerEta = typeof quote.timeEstimate === 'number' && Number.isFinite(quote.timeEstimate) ? quote.timeEstimate : null;
    const eta = TYPICAL_SEC['hl_withdraw'];
    return {
      feePct,
      facts: {
        destinationAsset: INTENTS_USDC_ASSET_ID,
        /* THE FLOOR, IN BOTH SLOTS. The view's amountOut is what the chat card draws as the
           landing leg, and the card has no "at least" line for this kind yet (ui/screens/cards.js
           draws one for a swap only), so a quote's expected figure there would print a promise
           above the one the rail holds the venue to. The floor is the number the rubric calls
           "receive at least" and the number the signed guarantee is checked against (criterion
           8.1); the expected figure stays in the summary, and a settled row replaces this with
           what landed. When the card draws arrivesAtLeast, `arrives` can carry the quote. */
        arrives: floor,
        arrivesAtLeast: floor,
        feeUsd: Number.isFinite(total) ? Number(total.toFixed(6)) : null,
        bridgeFee: null,
        etaSeconds: eta,
        activity:
          `Three fees. Routing ${usdc(routing)} USDC and a ${appBps} bp app fee (${usdc(appFee)} USDC) come out of the quote. ` +
          `Hyperliquid charges ${HL_ACTIVATION_USDC} USDC on top to open the fresh address 1Click mints, paid by the venue account.`,
        explorer: null,
      },
      lines: [
        `Bring collateral back from Hyperliquid into the intents balance.`,
        `  send      ${draft.amount} USDC from the venue account ${draft.from}`,
        `  credited  ${oneLine(quote.amountOutFormatted, 40)} USDC to this app's own NEAR Intents balance (${draft.to}); no other destination can be named`,
        `  at least  ${floor} USDC, the floor the live quote is held to`,
        `  cost      ${Number.isFinite(total) ? `${total.toFixed(4)} USDC, ${feePct.toFixed(2)} percent` : 'unknown'}`,
        `  routing   ${Number.isFinite(routing) ? `${routing.toFixed(4)} USDC inside the quote` : 'unknown'}`,
        `  app fee   ${Number.isFinite(appFee) ? `${appFee.toFixed(4)} USDC, ${appBps} bp, inside the quote` : 'unknown'}${appBps > 0 ? ' (a 1Click partner key removes it)' : ''}`,
        `  activation ${HL_ACTIVATION_USDC} USDC on top, the venue's charge for a destination it has never seen`,
        `  arrives   usually within ${Math.round(eta / 60)} minutes end to end (the router's leg about ${routerEta ?? '?'}s, then the venue shows it)` + books,
        `  by hand   always a click, whatever the size; refused while any position is open`,
      ],
    };
  }

  function checkQuote(draft: HlWithdrawDraft, p: Plan, quote: OneClickQuote): string[] {
    const problems: string[] = [];
    const out = Number(quote.amountOutFormatted);
    if (!Number.isFinite(out) || out <= 0) {
      problems.push(`1click returned an unusable output amount (${oneLine(quote.amountOutFormatted, 40)})`);
      return problems;
    }
    if (out < draft.minReceived) {
      problems.push(`the quote credits ${out} USDC and the approved draft required at least ${draft.minReceived}`);
    }
    const guaranteed = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (guaranteed < p.minReceivedBase) {
      problems.push(
        `the quote guarantees only ${Number(guaranteed) / 10 ** INTENTS_USDC_DECIMALS} USDC against the ${draft.minReceived} the ` +
          `approved draft floors at, whatever the ${out} it expects to deliver. This rail asks for ${HL_WITHDRAW_SLIPPAGE_BPS} bps ` +
          'of tolerance, so a wider gap than that is the venue offering a guarantee it was not asked for',
      );
    }
    if (quote.amountInFormatted !== undefined && Number(quote.amountInFormatted) !== draft.amount) {
      problems.push(`the quote prices ${oneLine(quote.amountInFormatted, 40)} in, but the draft says ${draft.amount}`);
    }
    return problems;
  }

  // The quote's echo of what we asked for. The signed sendAsset names the deposit address and
  // nothing else: where the money goes AFTER that address is only in the quote, so the echo
  // is what ties the signature to our intents account. A missing echo is a refusal.
  function echoWant(draft: HlWithdrawDraft, p: Plan): QuoteEcho {
    return {
      recipient: draft.to,
      recipientVerb: 'credit',
      recipientNoun: 'intents account',
      recipientType: 'INTENTS',
      recipientTypeWhy: 'a withdrawal that pays out on a chain instead of into our balance inside the verifier is not what was approved',
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      refundTypeWhy: 'back to the venue account the send left',
      refundTo: draft.from,
      originAsset: HYPERCORE_ORIGIN_ASSET_ID,
      destinationAsset: INTENTS_USDC_ASSET_ID,
      amount: p.amountBase.toString(),
      noEcho:
        'there is nothing tying it to the intents account the draft credits. The signed send names only the ' +
        `address 1Click minted and says nothing about ${oneLine(draft.to, 60)}, so without the echo this withdrawal ` +
        'cannot be checked and is refused.',
    };
  }

  function valueUsd(draft: HlWithdrawDraft): number {
    const a = Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
    const b = Number.isFinite(draft.amount) ? draft.amount : Infinity;
    return Math.max(a, b);
  }

  async function simulate(draft: HlWithdrawDraft): Promise<SimulationResult> {
    const planned = await plan(draft);
    if (planned.plan === undefined) return refusal(draft, planned.reasons);
    const p = planned.plan;

    try {
      requireOwner(draft);
    } catch (err) {
      return refusal(draft, [errText(err)]);
    }

    try {
      // dry:true, always. A simulation must never mint a deposit address.
      const response = await client.quote(quoteParams(draft, p, true));
      const priced = priceLines(draft, p, response.quote, response.raw);
      const problems = [...checkQuote(draft, p, response.quote), ...quoteEchoProblems(response.raw, echoWant(draft, p))];
      if (problems.length > 0) return refusal(draft, problems, priced.lines);
      priced.lines.push('execution signs one sendAsset with the master key to an address 1Click mints for this quote; nothing is sent on any chain');
      return { ok: true, summary: priced.lines.join('\n'), send: priced.facts };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `hypercore withdraw simulation failed: ${message}`, error: message };
    }
  }

  // Every poll tells the executor which word 1Click used, so the stage on the card is the
  // stage the vendor would confirm rather than a word only this app uses.
  async function watchStatus(depositAddress: string, hooks?: RailHooks): Promise<OneClickStatus> {
    const deadline = now() + pollTimeoutMs;
    const maxPolls = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
    let last: OneClickStatus = { found: false, status: 'PENDING_DEPOSIT', reported: 'not polled', originTxHashes: [], destinationTxHashes: [], nearTxHashes: [] };
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      try {
        last = await client.status(depositAddress);
        tell(hooks, { providerStage: last.status });
        if ((ONECLICK_TERMINAL as readonly string[]).includes(last.status)) return last;
      } catch (err) {
        last = { ...last, reported: `status check failed: ${oneLine(errText(err), 80)}` };
      }
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    }
    return last;
  }

  // The venue's own record of the send, keyed on the nonce the action signed with. A `send`
  // delta that carries no nonce field is matched on the destination, the exact amount and a
  // time inside the window instead: a miss here only costs a retry with the SAME nonce, which
  // the venue refuses as a duplicate, so the match may be loose in that one direction and
  // never in the other. Best effort: the send already happened, so a ledger that will not
  // answer changes the sentence and not the fact.
  async function ledgerHash(owner: string, nonce: number, destination: string, amount?: string): Promise<string | null> {
    try {
      const res = await (hl.fetchImpl ?? fetch)('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'userNonFundingLedgerUpdates', user: owner, startTime: nonce - 60_000 }),
        signal: readTimeout(),
      });
      const rows = (await res.json()) as Array<{ time?: number; hash?: string; delta?: Record<string, unknown> }>;
      const ours = (r: { delta?: Record<string, unknown> }) =>
        (r.delta?.type === 'spotTransfer' || r.delta?.type === 'send') && String(r.delta?.destination ?? '').toLowerCase() === destination.toLowerCase();
      const byNonce = rows.find((r) => ours(r) && Number(r.delta?.nonce) === nonce);
      const byShape =
        amount === undefined
          ? undefined
          : rows.find(
              (r) =>
                ours(r) &&
                r.delta?.nonce === undefined &&
                String(r.delta?.amount ?? '') === amount &&
                typeof r.time === 'number' &&
                r.time >= nonce - 60_000 &&
                r.time <= nonce + 10 * 60_000,
            );
      const hit = byNonce ?? byShape;
      return typeof hit?.hash === 'string' ? hit.hash : null;
    } catch {
      return null;
    }
  }

  async function execute(draft: HlWithdrawDraft, _proposalId?: string, hooks?: RailHooks): Promise<RailResult> {
    // Re-plan and re-price rather than trust the approval: the position check and the price
    // are both live facts, and an approval can be minutes old. The live quote below is checked
    // with the same functions the simulation used, so no dry quote is needed here.
    const planned = await plan(draft);
    if (planned.plan === undefined) return { ok: false, detail: `${planned.reasons.join('; ')}. Nothing was sent.` };
    const p = planned.plan;
    let owner: string;
    try {
      owner = requireOwner(draft);
    } catch (err) {
      return { ok: false, detail: `${errText(err)}. Nothing was sent.` };
    }

    // Both sides BEFORE anything moves, so the proof afterwards is a comparison and not a guess.
    // A verifier that will not answer now is a withdrawal nothing could confirm later: the row
    // is settled by the balance rising over this read (criterion 8.3), and with no read there is
    // nothing for it to rise over, so it refuses here, before a quote mints an address and
    // before the key is touched, the way the deposit rail refuses on its own before-read.
    const before = p.account;
    const intentsBefore = await intentsBalance(draft.to, INTENTS_USDC_ASSET_ID);
    if (intentsBefore === null) {
      return {
        ok: false,
        detail:
          'the balance inside NEAR Intents could not be read before the send, so this app could not confirm the credit ' +
          'afterwards. Nothing was sent; try again in a minute.',
      };
    }
    // The pocket the row is judged by, from this moment on: on the row with the first word from
    // the venue, and on every answer after it.
    const pocket = pocketOf(draft, intentsBefore, null);

    const response = await client.quote(quoteParams(draft, p, false));
    const quote = response.quote;
    // The signature is checked beside the amounts and the echo, before the deposit address is
    // read for anything: a quote 1Click did not sign, or signed with a different address, stops here.
    const problems = [...checkQuote(draft, p, quote), ...quoteEchoProblems(response.raw, echoWant(draft, p)), ...quoteSignatureProblems(response, quoteKey)];
    if (problems.length > 0) {
      return { ok: false, detail: `live quote does not match the approved draft: ${problems.join('; ')}. Nothing was sent.` };
    }
    if (typeof quote.depositMemo === 'string' && quote.depositMemo !== '') {
      return { ok: false, detail: 'the quote requires a deposit memo, which a sendAsset cannot carry; funds sent without it are lost. Nothing was sent.' };
    }
    const depositAddress = typeof quote.depositAddress === 'string' ? quote.depositAddress.trim() : '';
    if (!isAddress(depositAddress)) {
      return { ok: false, detail: `1click returned a deposit address that is not an EVM address: ${oneLine(quote.depositAddress, 60)}. Nothing was sent.` };
    }
    const signedQuote = signedQuoteRecord(response);

    // A standard account pays the send out of the spot book; move what is short from perp.
    // Same account, different side: nothing leaves, but a refusal after this point has to say
    // that the collateral now sits on spot, or the human reads "nothing was sent" as "nothing
    // changed" and the next look at the perp book comes up short.
    const handle = depositAddress.toLowerCase();
    let movedToSpot = false;
    if (p.moveToSpot > 0) {
      const moved = await usdClassTransfer(hl, { amount: p.moveToSpot, toPerp: false });
      if (!moved.ok) {
        return {
          ok: false,
          detail: moved.ambiguous
            ? `moving ${p.moveToSpot} USDC from the perp side to spot got no answer from the venue before the send: ` +
              `${oneLine(moved.detail, 160)}. Nothing was sent out, but the move between sides is unconfirmed: read both ` +
              'sides of the account before proposing again.'
            : `moving ${p.moveToSpot} USDC from the perp side to spot failed before the send: ${oneLine(moved.detail, 160)}. ` +
              'Nothing left the account.',
          txids: [],
          ...(moved.ambiguous && moved.nonce !== undefined ? { evidence: { nonce: String(moved.nonce) } } : {}),
        };
      }
      movedToSpot = true;
    }

    // One nonce per move, whatever happens. The venue dedupes on the nonce and on nothing
    // else, so a send it did not answer is retried once with the SAME nonce (the same send
    // again, or a refused duplicate) and never with a fresh one, which would be a second real
    // payout. The ledger is read first: a send that landed shows there under its nonce, and
    // then there is nothing to retry. The rule is written out at the top of intents-spend.ts.
    const first = await sendAsset(hl, { destination: depositAddress, amount: draft.amount });
    /* THE ROW HEARS BEFORE ANY OTHER READ. A send the venue took, or one it may have taken,
       reaches the row with its nonce, the signed quote and the intents pocket the moment the
       answer is in, ahead of the ledger read, the retry and the watch loop. Every one of those
       is a network read that can fail or a wait the process can die inside, and a row that has
       the nonce is a row the sweep can re-check by it; a row without it is "failed" over a send
       the venue may hold, which is how a second copy gets proposed (review, 2026-09-20). The
       pocket is what a row recovered from a crash is settled by: the balance rising over the
       before-read, never 1Click's SUCCESS alone. A send the venue refused outright is not
       evidence of anything and is not reported here. */
    if (first.ok || first.ambiguous) {
      tell(hooks, { handle, ...(first.nonce !== undefined ? { nonce: String(first.nonce) } : {}), quote: signedQuote, pocket });
    }
    let sent = first;
    let ledger: string | null = null;
    if (!first.ok && first.ambiguous && first.nonce !== undefined) {
      ledger = await ledgerHash(owner, first.nonce, depositAddress, toAmountString(draft.amount));
      if (ledger === null) {
        /* NOTHING THROWS AFTER THE SIGNATURE (the two-phase contract at the top of
           intents-spend.ts). The retry re-reads the account before it re-signs, and that read
           fails the way any read does; a throw out of here reached the executor as "rail
           threw", which it writes as failed with no nonce on the row. A retry that could not
           run is the same fact as a retry that got no answer: unconfirmed, same nonce. */
        try {
          sent = await sendAsset(hl, { destination: depositAddress, amount: draft.amount, nonce: first.nonce });
        } catch (err) {
          sent = { ok: false, ambiguous: true, nonce: first.nonce, detail: `the retry with the same nonce could not run: ${oneLine(errText(err), 160)}` };
        }
      }
    }
    const landed = sent.ok || ledger !== null;
    if (!landed) {
      if (first.ambiguous) {
        // The nonce is the identity of the action on this venue and the only thing a retry can
        // reuse, so it is the evidence; there is no hash to record and none is invented. A
        // refusal of the same nonce on the retry is not proof either way: the venue refuses a
        // nonce it has already taken, and it refuses a send it cannot fund.
        const again =
          sent === first
            ? ''
            : sent.ambiguous
              ? ` The same nonce was tried once more: ${oneLine(sent.detail, 160)}.`
              : ` The same nonce was sent once more and the venue answered: ${oneLine(sent.detail, 160)}.`;
        return {
          ok: false,
          detail:
            `${first.detail}${again} The send was to ${handle} for 1Click quote of ${oneLine(quote.amountOutFormatted, 40)} USDC, ` +
            `so it is unconfirmed: read the Hyperliquid ledger for nonce ${String(first.nonce)} and 1Click status for that address ` +
            'before proposing again.',
          txids: [],
          pocket,
          evidence: { handle, ...(first.nonce !== undefined ? { nonce: String(first.nonce) } : {}), quote: signedQuote },
        };
      }
      return {
        ok: false,
        detail:
          `${sent.detail}. ` +
          (movedToSpot ? 'The collateral was moved to the spot side and stays there; nothing was sent out.' : 'Nothing was sent.'),
        txids: [],
        evidence: { quote: signedQuote },
      };
    }
    const nonce = first.nonce ?? sent.nonce ?? now();
    // The venue's ledger hash when it has one. When it has not shown the send yet the row keeps
    // the nonce and no hash: an invented id in txids reaches Activity as a transaction.
    if (ledger === null) ledger = await ledgerHash(owner, nonce, depositAddress, toAmountString(draft.amount));
    const evidence = `sent ${draft.amount} USDC to ${handle} (nonce ${String(nonce)}, ledger ${ledger ?? 'not found yet'})`;
    const railEvidence = (status: OneClickStatus) => ({ ...settledEvidence(status, handle), nonce: String(nonce), quote: signedQuote });
    const hash = ledger ?? '';

    const watch = await watchStatus(depositAddress, hooks);

    if (watch.status === 'SUCCESS') {
      const delivered = deliveredAmount(watch, quote.amountOutFormatted);
      const proof = await proveBothSides(draft, before, intentsBefore, delivered);
      const read = pocketOf(draft, intentsBefore, proof.intentsAfter);
      const said =
        `withdrew ${draft.amount} USDC from Hyperliquid; ${delivered} USDC credited to our ` +
        `intents account ${draft.to} (${deliveredNote(watch)}); ${evidence}.${proof.sentence}`;
      /* CONFIRMED ONLY ONCE THE VERIFIER SHOWS IT. 1Click's SUCCESS is the solver's word and a
         finality-final read lags it, so a row that flipped to Confirmed here printed "Confirmed"
         over a balance that had not moved. Not risen inside the window is settling: the executor
         lands it as needs_reconciliation with the pocket, the card reads "Waiting for the venue to
         credit it", and the next ledger read that shows the rise settles it. Nothing more is
         signed either way. */
      if (!proof.rose) {
        return {
          ok: false,
          settling: true,
          detail: `${SETTLING_WITHDRAW} ${said}`,
          txids: uniqueTxids(hash, watch),
          pocket: read,
          evidence: railEvidence(watch),
        };
      }
      return {
        ok: true,
        detail: said,
        txids: uniqueTxids(hash, watch),
        pocket: read,
        evidence: railEvidence(watch),
      };
    }

    if (watch.status === 'REFUNDED' || watch.status === 'FAILED') {
      const refund = describeRefund(watch, handle, {
        symbol: 'USDC',
        refundTarget: `the venue account ${draft.from} (the spot side)`,
        evidence,
        primaryTxid: hash,
      });
      return { ...refund, evidence: { ...refund.evidence, nonce: String(nonce), quote: signedQuote } };
    }

    if (watch.status === 'INCOMPLETE_DEPOSIT') {
      const short = describeIncompleteDeposit(watch, handle, {
        symbol: 'USDC',
        quotedIn: oneLine(quote.amountInFormatted, 40),
        refundTarget: `the venue account ${draft.from} (the spot side)`,
        evidence,
        primaryTxid: hash,
      });
      return { ...short, evidence: { ...short.evidence, nonce: String(nonce), quote: signedQuote } };
    }

    // The send happened and the watch ran out. The ledger hash, the nonce and the address stay
    // on the row so the routing can be checked later, and the intents pocket rides with them:
    // the boot sweep re-asks 1Click by the handle, and a SUCCESS it hears later still waits on
    // the verifier showing the credit rather than confirming on the router's word.
    return {
      ok: false,
      detail:
        `the send confirmed but 1click did not reach a terminal status within ${Math.round(pollTimeoutMs / 1000)}s ` +
        `(last status ${watch.reported}); ${evidence}. THE SEND HAPPENED and the routing may still complete, so it is ` +
        `unconfirmed: read the intents balance and 1Click status for ${handle} before proposing again.`,
      txids: uniqueTxids(hash, watch),
      pocket,
      evidence: { handle, nonce: String(nonce), quote: signedQuote },
    };
  }

  /* The verifier's balance of the intents USDC either side of the move, base units as strings,
     for the receipt and for the re-judgement of a settling row (src/proposals/execute.ts
     judgeSettling). The before is always read: execute refuses before any quote when the
     verifier will not give one, so no row this rail writes is ever without its pocket. */
  function pocketOf(draft: HlWithdrawDraft, before: bigint, after: bigint | null): PocketRead {
    return {
      venue: 'intents',
      account: draft.to.toLowerCase(),
      assetId: INTENTS_USDC_ASSET_ID,
      symbol: 'USDC',
      decimals: INTENTS_USDC_DECIMALS,
      before: before.toString(),
      after: after === null ? null : after.toString(),
      floor: toBaseUnits(draft.minReceived, INTENTS_USDC_DECIMALS).toString(),
    };
  }

  type Proof = { sentence: string; rose: boolean; intentsAfter: bigint | null };

  /* What changed on each side, read back rather than assumed. The verifier is READ UNTIL IT
     SHOWS the floor or the window is spent: 1Click says SUCCESS the block the solver executes and
     a finality-final read lags it, so the one read this used to take saw the old balance and
     called the credit unseen over money a block away. Never throws: the money has moved by now,
     and a read that fails changes the sentence, not the fact. */
  async function proveBothSides(draft: HlWithdrawDraft, before: HlAccountSummary, intentsBefore: bigint, delivered: string): Promise<Proof> {
    const parts: string[] = [];
    try {
      const after = await accountSummary(hl, draft.from);
      const fell = (before.unified ? before.availableUsdc - after.availableUsdc : before.spotUsdc + before.perpWithdrawableUsd - after.spotUsdc - after.perpWithdrawableUsd);
      parts.push(fell > 0 ? ` Venue collateral fell by ${Number(fell.toFixed(6))} USDC.` : ' The venue has not shown the debit yet.');
    } catch (err) {
      parts.push(` Could not read the venue afterwards (${oneLine(errText(err), 80)}).`);
    }
    const floor = toBaseUnits(draft.minReceived, INTENTS_USDC_DECIMALS);
    const watched = await watchRise<bigint>({
      read: () => intentsBalance(draft.to, INTENTS_USDC_ASSET_ID),
      rose: (read) => read - intentsBefore >= floor,
      schedule: settleSchedule,
      sleep,
      now,
    });
    const intentsAfter = watched.last;
    if (intentsAfter === null) {
      parts.push(' The verifier would not answer a balance read, so the credit is unconfirmed here; read the wallet.');
      return { sentence: parts.join(''), rose: false, intentsAfter: null };
    }
    const gain = intentsAfter - intentsBefore;
    if (watched.rose) {
      parts.push(` The intents balance rose by ${Number(gain) / 10 ** INTENTS_USDC_DECIMALS} USDC.`);
      return { sentence: parts.join(''), rose: true, intentsAfter };
    }
    parts.push(
      gain > 0n
        ? ` The intents balance rose by ${Number(gain) / 10 ** INTENTS_USDC_DECIMALS} USDC so far, under the ${draft.minReceived} USDC floor, after ${Math.round(watched.waitedMs / 1000)}s over ${watched.reads} reads.`
        : ` The verifier has not shown the credit yet after ${Math.round(watched.waitedMs / 1000)}s over ${watched.reads} reads; 1Click reported SUCCESS for ${delivered} USDC, so read the wallet in a minute rather than sending again.`,
    );
    return { sentence: parts.join(''), rose: false, intentsAfter };
  }

  return { kind: 'hl_withdraw', valueUsd, simulate, execute };
}
