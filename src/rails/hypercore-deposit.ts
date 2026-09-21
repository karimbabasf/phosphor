// The Hyperliquid funding rail: collateral into the perps account from the intents balance.
//
// Third mechanism under the same kind. The first held USDC on Arbitrum and made a plain ERC-20
// transfer to Hyperliquid's Bridge2 contract. The second (2026-08-20) quoted 1Click from a
// wallet on any chain and sent the input on that chain. This one (2026-09-11) starts from the
// balance already held inside intents.near: one erc191 intent handing that balance to the
// solver's handle, and the solver credits the perps account. Nothing is sent on any chain by
// us, which is why the EVM and NEAR ports the second mechanism carried are gone.
//
// The four shared steps live in src/rails/intents-spend.ts. What is here is what makes this a
// deposit rather than a withdrawal: the destination is pinned to HyperCore USDC, the recipient
// is our own Hyperliquid account, the fee floor has the shape of THIS route's fee, and the
// rail finishes by looking at the account rather than at the 1Click status.
//
// Three things about this rail are refusals rather than features:
//
//   1. THE FEE IS ALMOST FLAT, so the percentage depends entirely on size. Measured live
//      2026-09-11 from the intents balance, without a partner key (so a 25 bp app fee sits
//      inside the numbers):
//
//        in     out          fee
//        5      4.672108     0.3279
//        10     9.6594       0.3406
//        50     49.55863     0.4414
//        1000   997.115655   2.8843
//
//      That is about 0.3153 flat plus about 26 bp. On $1000 it is 29 bp, which is fine. On $5
//      it is 6.6 percent, which is a trap no percentage-shaped slippage check would catch,
//      because the venue is not slipping: it is charging a fixed cost against a tiny amount.
//      So this rail states the EFFECTIVE rate in the approval summary and refuses below a
//      floor and above a ceiling, and all three exist because of that table.
//
//      And the venue has a floor of its own that is not a fee but a loss. Hyperliquid's bridge
//      docs: "The minimum deposit amount is 5 USDC. If you send an amount less than this, it
//      will not be credited and be lost forever." 1Click quotes a 3 USDC deposit without a
//      word (2.676895 out, live 2026-09-16), so the refusal has to be this app's: the draft's
//      guaranteed floor and the quote's guaranteed output are both held to 5 USDC delivered,
//      and the size floor sits at 7 so that 5 lands after the flat fee and the fee itself
//      stays under the ceiling.
//
//   2. THE DESTINATION IS PINNED. The HyperCore asset id is a `1cs_v1:...` string the token
//      registry does not hold, so it is a constant here, verified against the live list on
//      every quote and never replaced from it. A hostile list can stop this rail; it cannot
//      redirect it.
//
//   3. THE COLLATERAL MAY LAND ON THE WRONG SIDE OF THE ACCOUNT. Hyperliquid keeps spot and
//      perp as separate books on a standard account, and a delivery is not margin until it is
//      on the perp side. The rail finishes by LOOKING, and moves the balance itself if it has
//      to (settleToPerp). On a unified account, which is what Karim's is, there is one balance
//      and the step is a no-op that says so.
//
// The signature this rail releases is an intents `transfer` with the EVM key. The settle step
// on a standard account signs a second, different thing: an EIP-712 usdClassTransfer with the
// same key. Both are the app's own authority over its own money; a reader should know that a
// module called "deposit" can produce a user-signed venue action.

import { formatUnits, isAddress } from 'viem';
import type { HlDepositDraft, Rail, RailHooks, RailResult, SimulationResult } from '../types.ts';
import { baseUnits, oneLine, quoteEchoProblems, toBaseUnits } from '../intents.ts';
import type { OneClickClient, OneClickQuote, OneClickToken, QuoteEcho } from '../intents.ts';
import { INTENTS_VERIFIER, intentsApi, liveIntentsSigner } from './intents-native.ts';
import type { IntentsApiPort, IntentsSignerPort } from './intents-native.ts';
import { appFeeBpsOf, spendFromIntents } from './intents-spend.ts';
import { TYPICAL_SEC } from '../proposals/view.ts';
import type { PreflightRunner } from '../preflight/live.ts';
import { describeHeld, deliveredAmount, deliveredNote, describeIncompleteDeposit, describeRefund, describeUnconfirmedSubmit, settledEvidence, uniqueTxids, withQuote } from './oneclick-words.ts';
import { accountSummary, usdClassTransfer } from './hl-user-signed.ts';
import type { HlAccountSummary, HlUserSignedDeps } from './hl-user-signed.ts';
import { HYPERLIQUID_SETTLE, SETTLING_SENTENCE, watchRise } from '../ledger/settle.ts';
import type { PocketRead, RiseSchedule } from '../ledger/settle.ts';

// ---------- the destination ----------

// PINNED, not looked up. The `hip1` id is the documented HyperCore spot USDC (token index 0,
// tokenId 0x6d1e..., 8 decimals) and the only hypercore asset 1Click accepts in both
// directions; the `erc20:0xb883...` id the rail pinned before 2026-09-11 is destination-only
// and undocumented. A deposit to this asset lands as perps collateral (docs: "credited to
// their Hyperliquid perps balance"), which the settle step confirms rather than assumes.
export const HYPERCORE_USDC_ASSET_ID = '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054';
export const HYPERCORE_USDC_DECIMALS = 8;

// The funds are spent inside the verifier, so the counterparty is the verifier: the same
// allowlist entry the swap and withdraw rails use. A human who allowed one allowed them all,
// which is one decision rather than three that look like one.
export const HYPERCORE_COUNTERPARTY = INTENTS_VERIFIER;

// What Hyperliquid credits at all. Its bridge docs: "The minimum deposit amount is 5 USDC. If
// you send an amount less than this, it will not be credited and be lost forever." Held in
// USDC delivered, not USDC sent: a 5 USDC deposit loses 0.33 to the route and lands at 4.67,
// which the venue keeps. Verified 2026-09-16: 1Click prices a 3 USDC delivery of 2.68 without
// complaint, so nothing upstream refuses this for us.
export const HYPERCORE_VENUE_MIN_CREDIT_USDC = 5;

// The size floor, in USDC sent. 7, for two reasons that both have to hold: 7 in guarantees
// at least 5 lands after the flat fee (minCreditedFor(7) is 6.52; a live 6 USDC quote already
// delivered 5.67), and at 7 the nearly flat fee is about 4.8 percent of the deposit, under the
// MAX_FEE_PCT ceiling below. 6 cleared the venue's floor and was refused by the ceiling (5.5
// percent, measured 2026-09-16), which is a floor that refuses everything at the floor. Below
// this the deposit is not a bad deal, it is gone. 1Click's own floor is lower and says nothing
// about the venue's.
export const MIN_DEPOSIT_USDC = 7;
// The venue floor in HyperCore USDC base units (8 decimals), for the quote check, which
// compares base units to base units and never through a double.
const VENUE_MIN_CREDIT_BASE = BigInt(HYPERCORE_VENUE_MIN_CREDIT_USDC) * 10n ** BigInt(HYPERCORE_USDC_DECIMALS);

// What a deposit is allowed to cost before this rail stops calling it a deposit. 5 percent lets
// a $10 test through with a loud number attached and refuses the sizes where the user would be
// paying mostly for the privilege.
export const MAX_FEE_PCT = 5;

// The loss floor a draft carries, shaped like the fee or it refuses honest quotes: a flat term
// with headroom over the measured 0.3153, and a bp term with headroom over the measured 26
// (10 from the route, about 25 from the app fee an unkeyed quote carries, minus rounding).
// The bp term was 20 until 2026-09-11 and refused every honest deposit above about $300 once
// the app fee appeared, which is the "value checked was not the value used" bug again.
export const HYPERCORE_MEASURED_FLAT_USDC = 0.32; // what the sentences say; the floor below carries headroom
export const HYPERCORE_FLAT_FEE_USDC = 0.45; // measured 0.3153
export const HYPERCORE_FEE_BPS = 40; // measured about 26

// The slippage tolerance this rail ASKS FOR. checkQuote gates on the guarantee this produces
// (minAmountOut), so the number asked for and the number checked have to be the same number.
// 10 bps because the route is stable to stable with a nearly flat fee: there is no real price
// to slip against.
export const HYPERCORE_SLIPPAGE_BPS = 10;

export function minCreditedFor(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount - (HYPERCORE_FLAT_FEE_USDC + (amount * HYPERCORE_FEE_BPS) / 10_000);
}

// ---------- the seams ----------

export type HypercoreDepositDeps = {
  keysPath: string;
  apiKey?: string;
  signer?: IntentsSignerPort;
  api?: IntentsApiPort;
  client?: OneClickClient; // the registry's shared 1Click client, so the token list is fetched once
  hl?: HlUserSignedDeps; // the Hyperliquid reads and the settle step; defaults to the live key
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxDeadlineMs?: number;
  // The key 1Click signs quotes with. Left unset it is the production key; a test hands the
  // key its own fake signs with, and nothing else ever sets it.
  quoteKey?: string;
  // How long, and how often, the account is re-read once 1Click says SUCCESS. Defaults to
  // HYPERLIQUID_SETTLE (two minutes); the tests shorten it.
  settleSchedule?: RiseSchedule;
  // The checks run on the live quote before the intent is generated (src/preflight/): the
  // Arbitrum sweep this route ends in, above all. The registry wires the live one.
  preflight?: PreflightRunner;
};

export type HypercoreDepositRail = Rail<HlDepositDraft> & {
  accountState(address: string): Promise<HlAccountSummary>;
  assertAssetLive(): Promise<void>;
};

type Plan = {
  originAsset: string;
  decimals: number; // of the origin asset, for the base amount
  amountBase: bigint;
  minCreditedBase: bigint;
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function hypercoreDepositRail(deps: HypercoreDepositDeps): HypercoreDepositRail {
  const { keysPath } = deps;
  const signer = deps.signer ?? liveIntentsSigner;
  const api = deps.api ?? intentsApi({ apiKey: deps.apiKey ?? '', fetchImpl: deps.fetchImpl, client: deps.client });
  const hl: HlUserSignedDeps = deps.hl ?? { keysPath, fetchImpl: deps.fetchImpl, now: deps.now };
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? 3000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 180_000;
  const settleSchedule = deps.settleSchedule ?? HYPERLIQUID_SETTLE;
  // Four days, matching the swap rail. See MAX_DEADLINE_MS there for why the deadline is not
  // what prevents replay and the nonce is.
  const maxDeadlineMs = deps.maxDeadlineMs ?? 4 * 24 * 60 * 60 * 1000;

  function pinProblem(list: OneClickToken[]): string | null {
    const pinned = list.find((t) => t.assetId === HYPERCORE_USDC_ASSET_ID);
    if (pinned === undefined) {
      const hypercore = list.filter((t) => t.blockchain.toLowerCase() === 'hypercore').map((t) => t.assetId);
      return (
        `the pinned HyperCore USDC asset id is no longer in the 1Click token list. Pinned: ` +
        `${HYPERCORE_USDC_ASSET_ID}. Live hypercore assets: ${hypercore.length > 0 ? hypercore.join(', ') : 'none'}. ` +
        `This rail will not take a replacement id from the API; update the constant deliberately`
      );
    }
    if (pinned.decimals !== HYPERCORE_USDC_DECIMALS) {
      return (
        `HyperCore USDC decimals changed: pinned ${HYPERCORE_USDC_DECIMALS}, live ${pinned.decimals}. ` +
        `Every amount this rail sends would be wrong by a factor of ten`
      );
    }
    return null;
  }

  // Confirms the pinned asset id is still in the live list. It reports and never repairs:
  // taking a replacement id from the API is exactly the thing the pin exists to prevent.
  async function assertAssetLive(): Promise<void> {
    const problem = pinProblem(await api.tokens());
    if (problem !== null) throw new Error(problem);
  }

  function refusal(draft: HlDepositDraft, reasons: string[], lines: string[] = []): SimulationResult {
    const joined = reasons.join('; ');
    return {
      ok: false,
      summary: [`REFUSED: fund Hyperliquid with ${draft.amount} ${draft.symbol} - ${joined}`, ...lines].join('\n'),
      error: joined,
    };
  }

  // The account id we spend inside the verifier, which is the EVM address lowercased. Read
  // from the key, never from the draft, and compared against the draft: a draft authored for
  // another account would sign an intent that spends nothing and release a signature for no
  // reason. The Hyperliquid account credited is the same address, checksummed, because the
  // venue identifies an account by the key that signs for it.
  function requireOwner(draft: HlDepositDraft): string {
    const owner = signer.address(keysPath).toLowerCase();
    if (draft.from.toLowerCase() !== owner) {
      throw new Error(`draft spends the balance of ${draft.from} but the configured key is ${owner}`);
    }
    if (draft.hlAccount.toLowerCase() !== owner) {
      throw new Error(
        `draft credits ${draft.hlAccount}, which is not the account this app signs for (${owner}); ` +
          'collateral credited anywhere else is not margin this app can trade',
      );
    }
    return owner;
  }

  // Everything decidable BEFORE a quote. The checks that need no network run first, so a bad
  // draft never becomes a question asked of a remote API.
  async function plan(draft: HlDepositDraft): Promise<{ plan?: Plan; reasons: string[] }> {
    if (draft.counterparty !== HYPERCORE_COUNTERPARTY) {
      return { reasons: [`counterparty ${oneLine(draft.counterparty, 60)} is not ${HYPERCORE_COUNTERPARTY}; the funds are spent inside the verifier`] };
    }
    if (!isAddress(draft.hlAccount.trim())) {
      return { reasons: [`the trading account ${oneLine(draft.hlAccount, 60)} is not an EVM address, and HyperCore credits one`] };
    }
    if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
      return { reasons: [`amount ${draft.amount} is not a positive number`] };
    }
    if (draft.amountUsd < MIN_DEPOSIT_USDC) {
      return {
        reasons: [
          `${draft.amount} ${draft.symbol} is below the ${MIN_DEPOSIT_USDC} USDC floor. Hyperliquid does not credit a deposit ` +
            `under ${HYPERCORE_VENUE_MIN_CREDIT_USDC} USDC, it is lost, and the routing fee is nearly flat (about ` +
            `${HYPERCORE_MEASURED_FLAT_USDC} USDC), so ${MIN_DEPOSIT_USDC} in is what guarantees ${HYPERCORE_VENUE_MIN_CREDIT_USDC} lands; deposit more at once`,
        ],
      };
    }
    if (!Number.isFinite(draft.minCredited) || draft.minCredited <= 0) {
      return { reasons: [`the draft floors at ${draft.minCredited} USDC, which is no floor at all`] };
    }
    // The venue's floor against the draft's own guarantee, before any quote: a draft that can
    // only promise 4.9 landing is a draft that can lose the whole deposit.
    if (draft.minCredited < HYPERCORE_VENUE_MIN_CREDIT_USDC) {
      return {
        reasons: [
          `${draft.amount} ${draft.symbol} would guarantee only ${draft.minCredited.toFixed(4)} USDC landing; Hyperliquid does not credit ` +
            `a deposit under ${HYPERCORE_VENUE_MIN_CREDIT_USDC} USDC, it is lost`,
        ],
      };
    }

    let list: OneClickToken[];
    try {
      list = await api.tokens();
    } catch (err) {
      return { reasons: [`could not read the 1Click token list: ${errText(err)}`] };
    }
    // The pin is verified HERE, against the list this call already had to fetch: a check on
    // the path that cannot be forgotten, because a quote is impossible without it.
    const pin = pinProblem(list);
    if (pin !== null) return { reasons: [pin] };

    const origin = list.find((t) => t.assetId === draft.originAsset);
    if (origin === undefined) {
      return { reasons: [`1click does not list ${oneLine(draft.originAsset, 60)}, the ${draft.symbol} flavor the draft spends`] };
    }

    let amountBase: bigint;
    try {
      amountBase = toBaseUnits(draft.amount, origin.decimals);
    } catch (err) {
      return { reasons: [`amount ${draft.amount} ${draft.symbol} cannot be expressed at ${origin.decimals} decimals: ${errText(err)}`] };
    }

    return {
      plan: {
        originAsset: draft.originAsset,
        decimals: origin.decimals,
        amountBase,
        minCreditedBase: toBaseUnits(draft.minCredited, HYPERCORE_USDC_DECIMALS),
      },
      reasons: [],
    };
  }

  /* What the human reads before clicking. The effective rate is computed rather than quoted,
     because the number that matters is not the fee, it is the fee against THIS amount. Two parts
     sit inside the quote and both are named as numbers: the routing leg (about 0.32 flat) and
     the 25 bp app fee an unkeyed quote carries, read off the quote's own echo rather than
     assumed. The facts ride on the simulation in the shape the card already draws
     (SendSimulation): what arrives, the draft floor as "at least", and the fee as one number. */
  type Priced = { lines: string[]; feePct: number; facts: NonNullable<SimulationResult['send']> };

  function priceLines(draft: HlDepositDraft, quote: OneClickQuote, raw: unknown): Priced {
    const out = Number(quote.amountOutFormatted);
    const inUsd = Number(quote.amountInUsd);
    const spent = Number.isFinite(inUsd) && inUsd > 0 ? inUsd : draft.amountUsd;
    const feeUsd = Number.isFinite(out) ? spent - out : NaN;
    const feePct = Number.isFinite(feeUsd) && spent > 0 ? (feeUsd / spent) * 100 : NaN;
    const appBps = appFeeBpsOf(raw);
    const appFee = Number.isFinite(feeUsd) ? Math.min(Math.max(0, feeUsd), (spent * appBps) / 10_000) : NaN;
    const routing = Number.isFinite(feeUsd) ? feeUsd - appFee : NaN;
    // The router's estimate covers its own leg; the venue shows the money after it. The card
    // counts the whole move against TYPICAL_SEC (src/proposals/view.ts), so that is the figure
    // here too, and the router's leg is named for what it is.
    const routerEta = typeof quote.timeEstimate === 'number' && Number.isFinite(quote.timeEstimate) ? quote.timeEstimate : null;
    const eta = TYPICAL_SEC['hl_deposit'];
    const money = (n: number): string => (Number.isFinite(n) ? n.toFixed(6).replace(/\.?0+$/, '') : String(n));
    return {
      feePct,
      facts: {
        destinationAsset: HYPERCORE_USDC_ASSET_ID,
        // The floor in both slots, for the reason hypercore-withdraw.ts gives: the chat card
        // draws `arrives` as the landing leg and has no "at least" line for this kind yet.
        arrives: money(draft.minCredited),
        arrivesAtLeast: money(draft.minCredited),
        feeUsd: Number.isFinite(feeUsd) ? Number(feeUsd.toFixed(6)) : null,
        bridgeFee: null,
        etaSeconds: eta,
        activity:
          `Two fees, both inside the quote: routing ${money(routing)} USDC and a ${appBps} bp app fee (${money(appFee)} USDC). ` +
          `Hyperliquid keeps any deposit under ${HYPERCORE_VENUE_MIN_CREDIT_USDC} USDC delivered, so at least ${money(draft.minCredited)} USDC has to land.`,
        explorer: null,
      },
      lines: [
        `Fund Hyperliquid perps from the intents balance.`,
        `  spend     ${draft.amount} ${draft.symbol} held inside ${INTENTS_VERIFIER}`,
        `  credited  ${oneLine(quote.amountOutFormatted, 40)} USDC to ${draft.hlAccount}`,
        `  at least  ${money(draft.minCredited)} USDC, the floor the live quote is held to; under ${HYPERCORE_VENUE_MIN_CREDIT_USDC} the venue keeps it`,
        `  cost      ${Number.isFinite(feeUsd) ? `${feeUsd.toFixed(4)} USDC, ${feePct.toFixed(2)} percent of the deposit` : 'unknown'}`,
        `  routing   ${Number.isFinite(routing) ? `${routing.toFixed(4)} USDC inside the quote` : 'unknown'}`,
        `  app fee   ${Number.isFinite(appFee) ? `${appFee.toFixed(4)} USDC, ${appBps} bp, inside the quote` : 'unknown'}${appBps > 0 ? ' (a 1Click partner key removes it)' : ''}`,
        `  arrives   usually within ${Math.round(eta / 60)} minutes end to end (the router's leg about ${routerEta ?? '?'}s, then the venue shows it)`,
        `  way back  propose_hl_withdraw brings collateral back into the same balance, always by a click`,
      ],
    };
  }

  function checkQuote(draft: HlDepositDraft, p: Plan, quote: OneClickQuote, feePct: number): string[] {
    const problems: string[] = [];

    const out = Number(quote.amountOutFormatted);
    if (!Number.isFinite(out) || out <= 0) {
      problems.push(`1click returned an unusable output amount (${oneLine(quote.amountOutFormatted, 40)})`);
      return problems;
    }

    if (out < draft.minCredited) {
      problems.push(`the quote credits ${out} USDC and the approved draft required at least ${draft.minCredited}`);
    }

    // And the GUARANTEED floor, which is the gate. amountOutFormatted is the solver's EXPECTED
    // output; minAmountOut is what it commits to. In base units, because comparing two decimal
    // strings through a double is how a floor stops being exact. A missing minAmountOut throws
    // rather than reading as zero: a quote that guarantees nothing cannot be measured.
    const guaranteed = baseUnits(quote.minAmountOut, 'minAmountOut');
    // The venue's floor first, because it is the one that loses the money rather than some of
    // it: under 5 USDC delivered Hyperliquid credits nothing. 1Click quotes such deliveries
    // happily, so this is the only place the guarantee meets the docs.
    if (guaranteed < VENUE_MIN_CREDIT_BASE) {
      problems.push(
        `the quote guarantees only ${formatUnits(guaranteed, HYPERCORE_USDC_DECIMALS)} USDC landing; Hyperliquid does not credit ` +
          `a deposit under ${HYPERCORE_VENUE_MIN_CREDIT_USDC} USDC, it is lost. Deposit more at once`,
      );
      return problems;
    }
    if (guaranteed < p.minCreditedBase) {
      problems.push(
        `the quote guarantees only ${formatUnits(guaranteed, HYPERCORE_USDC_DECIMALS)} USDC against the ` +
          `${draft.minCredited} the approved draft floors at, whatever the ${out} it expects to deliver. ` +
          `This rail asks for ${HYPERCORE_SLIPPAGE_BPS} bps of tolerance, so a wider gap than that is the ` +
          'venue offering a guarantee it was not asked for',
      );
    }

    if (Number.isFinite(feePct) && feePct > MAX_FEE_PCT) {
      problems.push(
        `the routing cost is ${feePct.toFixed(2)} percent of the deposit, above the ${MAX_FEE_PCT} percent ceiling. ` +
          `The fee is close to flat, so depositing more at once costs the same in dollars and far less as a share`,
      );
    }

    // Echoed back by the server; a mismatch means the quote priced something other than the
    // draft a human read.
    if (quote.amountInFormatted !== undefined && Number(quote.amountInFormatted) !== draft.amount) {
      problems.push(`the quote prices ${oneLine(quote.amountInFormatted, 40)} in, but the draft says ${draft.amount}`);
    }

    // A memo is a second field the deposit would have to carry, and the signed intent hands the
    // balance to the handle and carries none: money sent without the memo is not credited. So
    // a quote that asks for one is refused before anything is signed, on the dry quote at
    // simulate and again on the live one at execute, with the floor named beside the reason.
    if (typeof quote.depositMemo === 'string' && quote.depositMemo !== '') {
      problems.push(
        `the quote asks for a deposit memo, which the signed intent cannot carry; money sent without it would not be credited. ` +
          `Nothing is signed. The floor stays ${draft.minCredited.toFixed(4)} USDC landing`,
      );
    }

    return problems;
  }

  // The quote's echo of what we asked for. checkQuote reads the amounts and nothing else, so a
  // quote priced to credit a DIFFERENT Hyperliquid account, or to refund somewhere that is not
  // our balance, would pass every check there. The account credited is the one this app signs
  // for, derived from its own key, and a deposit credited to any other account is collateral
  // in a book this app cannot trade.
  function echoWant(draft: HlDepositDraft, p: Plan): QuoteEcho {
    return {
      recipient: draft.hlAccount,
      recipientVerb: 'credit',
      recipientNoun: 'Hyperliquid account',
      recipientType: 'DESTINATION_CHAIN',
      recipientTypeWhy: 'collateral credited to an intents balance instead of the venue is not margin this app can trade',
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      refundTypeWhy: 'back to our balance inside the verifier',
      refundTo: draft.from,
      originAsset: p.originAsset,
      destinationAsset: HYPERCORE_USDC_ASSET_ID,
      amount: p.amountBase.toString(),
      noEcho:
        'there is nothing tying it to the Hyperliquid account the draft credits. The signed intent hands our ' +
        `balance to a solver handle and names ${oneLine(draft.hlAccount, 60)} nowhere, so without the echo this ` +
        'funding cannot be checked and is refused.',
    };
  }

  async function accountState(address: string): Promise<HlAccountSummary> {
    return accountSummary(hl, address);
  }

  async function simulate(draft: HlDepositDraft): Promise<SimulationResult> {
    const planned = await plan(draft);
    if (planned.plan === undefined) return refusal(draft, planned.reasons);
    const p = planned.plan;

    let owner: string;
    try {
      owner = requireOwner(draft);
    } catch (err) {
      return refusal(draft, [errText(err)]);
    }

    try {
      // dry:true, always. A simulation must never mint a deposit handle.
      const response = await api.quote({
        dry: true,
        originAsset: p.originAsset,
        destinationAsset: HYPERCORE_USDC_ASSET_ID,
        amount: p.amountBase.toString(),
        account: owner,
        recipient: draft.hlAccount,
        recipientType: 'DESTINATION_CHAIN',
        // Named, not inherited. checkQuote gates on the guarantee this tolerance produces.
        slippageToleranceBps: HYPERCORE_SLIPPAGE_BPS,
      });

      const priced = priceLines(draft, response.quote, response.raw);
      const problems = [
        ...checkQuote(draft, p, response.quote, priced.feePct),
        ...quoteEchoProblems(response.raw, echoWant(draft, p)),
      ];
      if (problems.length > 0) return refusal(draft, problems, priced.lines);

      priced.lines.push('execution signs one intent with the EVM key and sends nothing on any chain; the solver credits the venue');
      return { ok: true, summary: priced.lines.join('\n'), send: priced.facts };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `hypercore funding simulation failed: ${message}`, error: message };
    }
  }

  // The last step, and the one that makes this rail's promise true.
  //
  // "The money arrived" and "the money is usable as margin" are different claims on a standard
  // Hyperliquid account, because spot and perp are separate books. Rather than assume which
  // side a delivery credits, this looks, and moves it if it has to. A failure here is NOT a
  // failed deposit: the money is on the account either way, so the sentence has to separate
  // the two or someone reads "failed" and sends again.
  /* The account's USDC as one number, the same way the ledger reads it (src/ledger/hyperliquid.ts):
     the free collateral on a unified account, both books on a standard one. What the pocket on
     the receipt records, and what a settling row is re-judged against. */
  function collateralOf(s: HlAccountSummary): number {
    return s.unified ? s.availableUsdc : s.spotUsdc + s.perpAccountValueUsd;
  }

  function pocketOf(draft: HlDepositDraft, before: HlAccountSummary, after: HlAccountSummary | null): PocketRead {
    const base = (usd: number): string => BigInt(Math.round(usd * 10 ** HYPERCORE_USDC_DECIMALS)).toString();
    return {
      venue: 'hyperliquid',
      account: draft.hlAccount.toLowerCase(),
      assetId: HYPERCORE_USDC_ASSET_ID,
      symbol: 'USDC',
      decimals: HYPERCORE_USDC_DECIMALS,
      before: base(collateralOf(before)),
      after: after === null ? null : base(collateralOf(after)),
      floor: base(draft.minCredited),
    };
  }

  type Settled =
    | { kind: 'rose'; sentence: string; after: HlAccountSummary }
    | { kind: 'short'; sentence: string; after: HlAccountSummary }
    | { kind: 'unseen'; sentence: string; after: HlAccountSummary | null }
    | { kind: 'unread'; sentence: string };

  async function settleToPerp(draft: HlDepositDraft, before: HlAccountSummary): Promise<Settled> {
    /* READ UNTIL IT SHOWS. A credit to HyperCore crosses a bridge after 1Click says SUCCESS, so
       the one read this took saw the account from before the deposit and the sentence said
       "the venue has not shown the credit yet" over money that landed a few seconds later.
       The loop stops at the first read that shows the floor; only the window running out is
       a decision, and that decision is "settling", never "failed". */
    const watched = await watchRise({
      read: () => accountState(draft.hlAccount).catch(() => null),
      rose: (after) => collateralOf(after) - collateralOf(before) + 1e-9 >= draft.minCredited,
      schedule: settleSchedule,
      sleep,
      now,
    });
    const after = watched.last;
    if (after === null) {
      // Not read is not shown. The deposit most likely landed, and this app cannot say so, which
      // is the same unconfirmed state as a window that ran out, never a funded account.
      return { kind: 'unread', sentence: ' Could not read the account afterwards, so the credit is unconfirmed: read the account before depositing again.' };
    }
    const gain = collateralOf(after) - collateralOf(before);
    if (!watched.rose) {
      if (gain > 0.01) {
        return {
          kind: 'short',
          after,
          sentence:
            ` The account rose by ${gain.toFixed(4)} USDC, below the ${draft.minCredited} USDC floor this deposit was approved ` +
            `with, after ${Math.round(watched.waitedMs / 1000)}s. Read the account before signing another.`,
        };
      }
      return {
        kind: 'unseen',
        after,
        sentence: ` Watched ${draft.hlAccount} for ${Math.round(watched.waitedMs / 1000)}s over ${watched.reads} reads.`,
      };
    }

    // A UNIFIED account has no two sides. The money is collateral the moment it lands, and
    // usdClassTransfer against one is rejected outright.
    if (after.unified || before.unified) {
      return { kind: 'rose', after, sentence: ` The account is unified, so it is margin already: free collateral rose by ${gain.toFixed(4)} USDC.` };
    }

    const perpGain = after.perpAccountValueUsd - before.perpAccountValueUsd;
    const spotGain = after.spotUsdc - before.spotUsdc;

    if (perpGain > 0.01 && spotGain <= 0.01) {
      return { kind: 'rose', after, sentence: ` Credited to the perp side directly; ${perpGain.toFixed(4)} USDC is margin now.` };
    }

    // On the spot side, which is observed money that is not margin yet. Nothing here says to
    // deposit again: a second proposal signs a second intent and spends a second time.
    try {
      const moved = await usdClassTransfer(hl, { amount: spotGain, toPerp: true });
      return {
        kind: 'rose',
        after,
        sentence: moved.ok
          ? ` Landed on the spot side and was moved to perp: ${spotGain.toFixed(4)} USDC is margin now.`
          : ` Landed on the spot side and the move to perp failed: ${oneLine(moved.detail, 120)}. ` +
            `The collateral is on the spot side of the account and is not margin yet; do not deposit again, ` +
            'move it to the perp side in Hyperliquid by hand.',
      };
    } catch (err) {
      return {
        kind: 'rose',
        after,
        sentence:
          ` Landed on the spot side and the move to perp threw: ${oneLine(errText(err), 120)}. ` +
          'The collateral is on the spot side of the account and is not margin yet; do not deposit again, ' +
          'move it to the perp side in Hyperliquid by hand.',
      };
    }
  }

  function valueUsd(draft: HlDepositDraft): number {
    // USDC is a dollar stable so the two agree in practice. Taking the larger is the
    // pessimistic read: a draft that under-reports its value must not slip under a budget.
    const a = Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
    const b = Number.isFinite(draft.amount) ? draft.amount : Infinity;
    return Math.max(a, b);
  }

  async function execute(draft: HlDepositDraft, _proposalId?: string, hooks?: RailHooks): Promise<RailResult> {
    // Re-plan and re-price rather than trust the approval. An approval can be minutes old and
    // a quote is a live price, so the checks that refused a bad draft have to run again here.
    const check = await simulate(draft);
    if (!check.ok) return { ok: false, detail: `${check.error ?? check.summary}. Nothing was signed.` };

    const planned = await plan(draft);
    if (planned.plan === undefined) return { ok: false, detail: `${planned.reasons.join('; ')}. Nothing was signed.` };
    const p = planned.plan;
    const owner = requireOwner(draft);

    // Read the account BEFORE anything moves, so the settle step afterwards is a comparison
    // rather than a guess about which balance was already there.
    let before: HlAccountSummary;
    try {
      before = await accountState(draft.hlAccount);
    } catch (err) {
      return { ok: false, detail: `could not read the Hyperliquid account before funding it: ${errText(err)}. Nothing was signed.` };
    }

    // The four shared steps. Every refusal before the signature throws out of spendFromIntents
    // and is reported here as exactly that; after the signature nothing throws, and a submit
    // that did not answer comes back as signed and unsubmitted.
    let spent;
    const preflight = deps.preflight;
    try {
      spent = await spendFromIntents(
        {
          api,
          signer,
          keysPath,
          now,
          sleep,
          pollIntervalMs,
          pollTimeoutMs,
          maxDeadlineMs,
          quoteKey: deps.quoteKey,
          ...(preflight === undefined ? {} : { preflight: (quote, port) => preflight.run('hl_deposit', draft, quote, port) }),
        },
        {
          owner,
          originAsset: p.originAsset,
          destinationAsset: HYPERCORE_USDC_ASSET_ID,
          amountBase: p.amountBase,
          minOutBase: p.minCreditedBase,
          recipient: draft.hlAccount,
          recipientType: 'DESTINATION_CHAIN',
          slippageToleranceBps: HYPERCORE_SLIPPAGE_BPS,
          echo: echoWant(draft, p),
          // The app fee is read off the echo for the sentence only; the ceiling reads the
          // total, which needs no echo, so the live check prices with none.
          checkQuote: (quote) => checkQuote(draft, p, quote, priceLines(draft, quote, null).feePct),
        },
        hooks,
      );
    } catch (err) {
      return { ok: false, detail: `${errText(err)}. Nothing was signed.` };
    }
    if (!spent.signed) return describeHeld(spent.preflight);
    if (!spent.submitted) {
      return withQuote(describeUnconfirmedSubmit({ error: spent.error, handle: spent.depositAddress, deadline: spent.deadline }), spent.signedQuote);
    }
    const { quote, depositAddress, watch, signedQuote } = spent;
    const evidence = `intent ${spent.intentHash}, quote handle ${oneLine(depositAddress, 80)}`;

    if (watch.status === 'SUCCESS') {
      const settled = await settleToPerp(draft, before);
      const amount = `${deliveredAmount(watch, quote.amountOutFormatted)} USDC from ${draft.amount} ${draft.symbol} held inside ${INTENTS_VERIFIER}`;
      const txids = uniqueTxids(spent.intentHash, watch);
      const recorded = { ...settledEvidence(watch, depositAddress), quote: signedQuote };
      const pocket = pocketOf(draft, before, settled.kind === 'unread' ? null : settled.after);
      if (settled.kind === 'unseen' || settled.kind === 'unread') {
        // The venue confirmed, the account has not shown it (or could not be read), and the one
        // thing that must not happen now is a second signature. Settling: the executor lands it
        // as needs_reconciliation and the next account read that shows the rise settles it.
        return {
          ok: false,
          settling: true,
          detail:
            `${SETTLING_SENTENCE} 1click reported SUCCESS for ${amount} (${deliveredNote(watch)}), but the venue has not shown it; ` +
            `${evidence}.${settled.sentence}`,
          txids,
          pocket,
          evidence: recorded,
        };
      }
      if (settled.kind === 'short') {
        return {
          ok: false,
          detail: `1click reported SUCCESS for ${amount} (${deliveredNote(watch)}); ${evidence}.${settled.sentence}`,
          txids,
          pocket,
          evidence: recorded,
        };
      }
      return {
        ok: true,
        detail:
          `funded Hyperliquid with ${amount} (${deliveredNote(watch)}); ${evidence}.${settled.sentence}`,
        txids,
        pocket,
        evidence: recorded,
      };
    }

    if (watch.status === 'REFUNDED' || watch.status === 'FAILED') {
      return withQuote(describeRefund(watch, depositAddress, {
        symbol: draft.symbol,
        refundTarget: `${owner} inside ${INTENTS_VERIFIER}`,
        evidence,
        primaryTxid: spent.intentHash,
      }), signedQuote);
    }

    if (watch.status === 'INCOMPLETE_DEPOSIT') {
      return withQuote(describeIncompleteDeposit(watch, depositAddress, {
        symbol: draft.symbol,
        quotedIn: oneLine(quote.amountInFormatted, 40),
        refundTarget: `${owner} inside ${INTENTS_VERIFIER}`,
        evidence,
        primaryTxid: spent.intentHash,
      }), signedQuote);
    }

    // Timed out. The signature is released and the intent submitted, so the balance may well
    // move after this returns. Saying "failed" without that sentence is how someone signs a
    // second deposit for money that is already on its way. The hash and the handle stay on the
    // row so the move can be checked later.
    return {
      ok: false,
      detail:
        `the intent was submitted but 1click did not reach a terminal status within ` +
        `${Math.round(pollTimeoutMs / 1000)}s (last status ${watch.reported}); ${evidence}. ` +
        `THE INTENT IS SIGNED AND SUBMITTED and the collateral may still land, so this move is unconfirmed: read the ` +
        `Hyperliquid account ${draft.hlAccount} and the balance inside ${INTENTS_VERIFIER} before signing another.`,
      txids: uniqueTxids(spent.intentHash, watch),
      evidence: { handle: oneLine(depositAddress, 80), quote: signedQuote },
    };
  }

  return { kind: 'hl_deposit', valueUsd, simulate, execute, accountState, assertAssetLive };
}
