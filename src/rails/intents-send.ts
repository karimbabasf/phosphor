// The NEAR Intents send rail: a balance held inside intents.near moves to ANOTHER account inside
// the same verifier. The one rail whose destination is not this app's own wallet.
//
// WHY IT EXISTS. Karim, 2026-09-16, holding three Phosphor wallets from three onboarding runs:
// "send from wallet 2 and 3 to 1 on near intents". Every other rail pays out to the address
// that holds the key, by construction, so the money made by one wallet could never reach
// another Phosphor, and a person with two of them (or a friend with one) had no way to move a
// balance between them short of exporting a seed phrase. This rail is that way, and it is the
// same shape as paying anyone else's intents account, which is why it is fenced the way it is.
//
// THE FENCE, three parts, none of them optional:
//
//   1. THE DESTINATION IS DECODED, SHOWN IN FULL, AND NAMED IN THE TOUCH ID DIALOG. `to` is the
//      one field on the whole tool surface that names where money ends up. Until 2026-09-17 the
//      policy engine held it to the destination allowlist; that gate is gone (decision 3 of the
//      new-user pass), because it was a second click naming the same address a day earlier. The
//      gate now is the send card (ui/screens/sendcard.js: the whole account in groups of four,
//      whether it has been paid before, what it holds) and the dialog sentence that names it
//      (src/vault/reason.ts), both drawn from the app's own decoding of the address.
//
//   2. IT ALWAYS WAITS FOR A CLICK, whatever the size. A withdrawal to our own wallet under the
//      threshold may run on its own; a balance leaving for another account never does
//      (src/proposals/execute.ts, beside the hl_withdraw rule).
//
//   3. THE RECIPIENT IS IN THE QUOTE ECHO, checked at simulate time and again on the live quote
//      a moment before the key is touched, exactly as the withdraw rail checks its wallet. The
//      signed intent hands the balance to the solver's handle and says nothing about the far
//      side, so the echo is the only thing tying the signature to the account named in the
//      draft. No echo, no signature.
//
// WHAT MOVES. The same asset, in and out: a send of USDC is USDC arriving, less the solver's
// fee (measured 2026-09-16: 0.25 percent on 3.78 USDC, no flat term). 1Click prices a
// same-asset intents-to-intents route as a swap with recipientType INTENTS, which is what
// makes this a send rather than a withdrawal: nothing touches a chain, the balance is credited
// inside the verifier under the receiver's account id. The four shared steps are
// src/rails/intents-spend.ts, as for the withdraw and the HyperCore deposit.
//
// THE PROOF IS THE RECEIVER'S BALANCE. Reading our own balance fall proves the signature spent;
// it does not prove where the money went. The receiver's balance of the asset is a public view
// on the verifier, so the rail reads it before the quote and again once 1Click reports success,
// and the receipt states the rise. A rise smaller than the floor is said as such, never as done.

import { formatUnits, isAddress } from 'viem';
import type { IntentsSendDraft, Rail, RailHooks, RailResult, SendSimulation, SimulationResult } from '../types.ts';
import { baseUnits, oneLine, quoteEchoProblems, toBaseUnits } from '../intents.ts';
import type { OneClickClient, OneClickQuote, OneClickToken, QuoteEcho } from '../intents.ts';
import { INTENTS_VERIFIER, intentsApi, liveIntentsSigner } from './intents-native.ts';
import type { IntentsApiPort, IntentsSignerPort } from './intents-native.ts';
import { spendFromIntents } from './intents-spend.ts';
import { describeHeld, deliveredNote, describeIncompleteDeposit, describeRefund, describeUnconfirmedSubmit, settledEvidence, uniqueTxids, withQuote } from './oneclick-words.ts';
import { isNearAccountId, nearChainSpec } from '../chain/near.ts';
import { fetchIntentsAssetBalance } from '../ledger/intents.ts';

// The funds are spent inside the verifier, so the counterparty is the verifier: the same
// allowlist entry the swap, withdraw and HyperCore rails use.
export const INTENTS_SEND_COUNTERPARTY = INTENTS_VERIFIER;

// The most a send may lose between leaving our balance and landing in the receiver's, in basis
// points. A constant and not a tool argument, for the reason every rail gives: a tolerance an
// agent can widen is a tolerance an agent can set to 100 percent. 100 bps against a measured
// 25: the route has no flat fee and no chain to pay gas on, so a quote that loses more than one
// percent is a quote worth refusing and reading.
export const SEND_MAX_LOSS_BPS = 100;

// The slippage tolerance the quote is asked for. A same-asset send has no price to slip
// against, so the only thing between the amount and the guarantee is the solver's fee; asking
// for the default 100 bps put the guarantee 125 bps under the amount and the one percent
// floor refused an honest quote (live, 2026-09-16). Ten, as the HyperCore rail asks.
export const SEND_SLIPPAGE_BPS = 10;

export function minReceivedForSend(amount: number): number {
  return amount * (1 - SEND_MAX_LOSS_BPS / 10_000);
}

/* An intents account id is an EVM address (lowercased: the verifier derives the id that way
   from an erc191 signature) or a NEAR account id. Decoded rather than pattern matched, so a
   mistyped hex address is refused instead of credited to nobody. Returns the id as the
   verifier keys it, or the problem. */
export function intentsAccountProblem(raw: string): { ok: true; id: string } | { ok: false; problem: string } {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return { ok: false, problem: 'no receiving account was named' };
  if (/^0x/i.test(trimmed)) {
    if (!isAddress(trimmed, { strict: false })) {
      return { ok: false, problem: `${oneLine(trimmed, 60)} is not an EVM address, so it cannot be an intents account` };
    }
    // A mixed-case address carries a checksum, and a checksum that does not verify is a typo.
    if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase() && !isAddress(trimmed, { strict: true })) {
      return { ok: false, problem: `${oneLine(trimmed, 60)} fails its own checksum, so a character in it is wrong` };
    }
    return { ok: true, id: trimmed.toLowerCase() };
  }
  if (isNearAccountId(trimmed)) return { ok: true, id: trimmed };
  return { ok: false, problem: `${oneLine(trimmed, 60)} is neither an EVM address nor a NEAR account id` };
}

export type IntentsSendRailDeps = {
  keysPath: string;
  apiKey?: string;
  signer?: IntentsSignerPort;
  api?: IntentsApiPort;
  client?: OneClickClient; // the registry's shared 1Click client, so the token list is fetched once
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxDeadlineMs?: number;
  quoteKey?: string;
  // The verifier read for the receiver's balance. Defaults to the live view call; a test hands
  // in its own ledger.
  receiverBalance?: (accountId: string, assetId: string) => Promise<bigint | null>;
  nearRpcUrl?: string;
};

export type IntentsSendRail = Rail<IntentsSendDraft>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function intentsSendRail(deps: IntentsSendRailDeps): IntentsSendRail {
  const { keysPath } = deps;
  const signer = deps.signer ?? liveIntentsSigner;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 5 * 60_000;
  const maxDeadlineMs = deps.maxDeadlineMs ?? 4 * 24 * 60 * 60 * 1000;
  const api = deps.api ?? intentsApi({ apiKey: deps.apiKey ?? '', fetchImpl: deps.fetchImpl, client: deps.client });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rpcUrl = deps.nearRpcUrl ?? nearChainSpec().rpcUrl;
  const receiverBalance =
    deps.receiverBalance ??
    ((accountId: string, assetId: string) => fetchIntentsAssetBalance({ rpcUrl, accountId, assetId, fetchImpl }));

  type Plan = {
    asset: string; // the 1Click asset id held; the same on both sides, since nothing is swapped
    decimals: number;
    amountBase: bigint;
    minReceivedBase: bigint;
    to: string; // the receiver's account id, as the verifier keys it
  };

  function requireVenue(draft: IntentsSendDraft): void {
    if (draft.counterparty !== INTENTS_SEND_COUNTERPARTY) {
      throw new Error(
        `intents send drafts must name ${INTENTS_SEND_COUNTERPARTY} as the counterparty ` +
          `(got ${oneLine(draft.counterparty, 60)}); the verifier account is fixed and never comes from a quote`,
      );
    }
  }

  // The account whose balance is spent, read from the key and compared against the draft.
  function requireOwner(draft: IntentsSendDraft): string {
    const owner = signer.address(keysPath).toLowerCase();
    if (draft.from.toLowerCase() !== owner) {
      throw new Error(`draft spends the balance of ${draft.from} but the configured key is ${owner}`);
    }
    return owner;
  }

  // The receiver, decoded again here rather than trusted, and never ourselves: a send to our
  // own account is a fee paid for nothing and is refused rather than priced.
  function requireReceiver(draft: IntentsSendDraft, owner: string): string {
    const checked = intentsAccountProblem(draft.to);
    if (!checked.ok) throw new Error(`the receiving account is unusable: ${checked.problem}`);
    if (checked.id === owner) {
      throw new Error(`the receiving account ${checked.id} is this app's own account; a send to ourselves pays a fee to move nothing`);
    }
    return checked.id;
  }

  function findAsset(list: OneClickToken[], draft: IntentsSendDraft): OneClickToken {
    const asset = list.find((t) => t.assetId === draft.originAsset);
    if (asset === undefined) {
      throw new Error(`1click does not list ${oneLine(draft.originAsset, 60)}, the ${draft.symbol} flavor the draft spends`);
    }
    if (asset.symbol.toUpperCase() !== draft.symbol.toUpperCase()) {
      throw new Error(`${oneLine(draft.originAsset, 60)} is ${asset.symbol} on the 1click list, not the ${draft.symbol} the draft names`);
    }
    return asset;
  }

  async function plan(draft: IntentsSendDraft): Promise<Plan> {
    requireVenue(draft);
    const owner = requireOwner(draft);
    const to = requireReceiver(draft, owner);
    const asset = findAsset(await api.tokens(), draft);
    return {
      asset: asset.assetId,
      decimals: asset.decimals,
      amountBase: toBaseUnits(draft.amount, asset.decimals),
      minReceivedBase: toBaseUnits(draft.minReceived, asset.decimals),
      to,
    };
  }

  function checkQuote(draft: IntentsSendDraft, p: Plan, quote: OneClickQuote): string[] {
    const problems: string[] = [];
    const amountIn = baseUnits(quote.amountIn, 'amountIn');
    if (amountIn !== p.amountBase) {
      problems.push(`the quote spends ${amountIn.toString()} base units of ${draft.symbol}, not the ${p.amountBase.toString()} the draft names`);
    }
    const minOut = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (minOut < p.minReceivedBase) {
      problems.push(
        `the solver would credit as little as ${minOut.toString()} base units of ${draft.symbol}, below the ` +
          `${p.minReceivedBase.toString()} floor the draft names (${SEND_MAX_LOSS_BPS / 100} percent under the amount); ` +
          'a send that loses more than that is not a send',
      );
    }
    return problems;
  }

  function echoWant(draft: IntentsSendDraft, p: Plan): QuoteEcho {
    return {
      recipient: p.to,
      recipientVerb: 'credit',
      recipientNoun: 'intents account',
      recipientType: 'INTENTS',
      recipientTypeWhy: 'a send that pays a wallet on a chain instead of crediting an intents balance is not what was approved',
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      refundTypeWhy: 'back to our balance inside the verifier',
      refundTo: draft.from,
      originAsset: p.asset,
      destinationAsset: p.asset,
      amount: p.amountBase.toString(),
      noEcho:
        'there is nothing tying it to the account the draft names. The signed intent hands our balance to a ' +
        `solver handle and does not name ${oneLine(p.to, 60)} anywhere, so without the echo this send cannot be checked and is refused.`,
    };
  }

  function priceLines(draft: IntentsSendDraft, p: Plan, quote: OneClickQuote): string[] {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    const feeUsd = Number.isFinite(inUsd) && Number.isFinite(outUsd) ? inUsd - outUsd : NaN;
    return [
      `intents send: ${draft.amount} ${draft.symbol} held inside ${INTENTS_VERIFIER} by ${draft.from} -> ` +
        `${oneLine(quote.amountOutFormatted, 40)} ${draft.symbol} credited to ${p.to} inside the same verifier`,
      `fee ${Number.isFinite(feeUsd) ? '$' + feeUsd.toFixed(4) : 'unknown'}, eta ~${Number(quote.timeEstimate)}s, ` +
        `solver floor ${oneLine(quote.minAmountOut, 40)} base units, draft floor ${draft.minReceived} ${draft.symbol}`,
    ];
  }

  function valueUsd(draft: IntentsSendDraft): number {
    return Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
  }

  /* What the verifier says about the receiver, as the one sentence the card shows: an account
     that already holds the asset is an account somebody uses, and one that holds nothing is the
     one to read twice. A read the verifier would not answer says so rather than guessing. */
  function receiverSentence(draft: IntentsSendDraft, p: Plan, held: bigint | null): string {
    if (held === null) return 'This account could not be checked inside NEAR Intents right now.';
    if (held === 0n) return `This account holds no ${draft.symbol} inside NEAR Intents yet. Check it twice.`;
    return `This account already holds ${formatUnits(held, p.decimals)} ${draft.symbol} inside NEAR Intents.`;
  }

  function sendFacts(p: Plan, quote: OneClickQuote, activity: string): SendSimulation {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    return {
      destinationAsset: p.asset,
      arrives: oneLine(quote.amountOutFormatted, 40),
      arrivesAtLeast: formatUnits(baseUnits(quote.minAmountOut, 'minAmountOut'), p.decimals),
      feeUsd: Number.isFinite(inUsd) && Number.isFinite(outUsd) ? Math.round((inUsd - outUsd) * 10_000) / 10_000 : null,
      bridgeFee: null,
      etaSeconds: Number.isFinite(Number(quote.timeEstimate)) ? Number(quote.timeEstimate) : null,
      activity,
      explorer: null,
    };
  }

  async function simulate(draft: IntentsSendDraft): Promise<SimulationResult> {
    try {
      const p = await plan(draft);
      const owner = requireOwner(draft);
      const response = await api.quote({
        dry: true,
        originAsset: p.asset,
        destinationAsset: p.asset,
        amount: p.amountBase.toString(),
        account: owner,
        recipient: p.to,
        recipientType: 'INTENTS',
        slippageToleranceBps: SEND_SLIPPAGE_BPS,
      });
      const lines = priceLines(draft, p, response.quote);
      const held = await receiverBalance(p.to, p.asset).catch(() => null);
      const send = sendFacts(p, response.quote, receiverSentence(draft, p, held));
      lines.push(send.activity);
      const problems = [...checkQuote(draft, p, response.quote), ...quoteEchoProblems(response.raw, echoWant(draft, p))];
      if (problems.length > 0) {
        const joined = problems.join('; ');
        return { ok: false, summary: [`REFUSED: ${joined}`, ...lines].join('\n'), error: joined, send };
      }
      lines.push('execution signs one intent with the EVM key and sends nothing on any chain; the solver credits the receiver inside the verifier');
      lines.push(`the receiver ${p.to} is named by the draft and shown in full on the card; this send always waits for your click`);
      return { ok: true, summary: lines.join('\n'), send };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `intents send simulation failed: ${message}`, error: message };
    }
  }

  async function execute(draft: IntentsSendDraft, _proposalId?: string, hooks?: RailHooks): Promise<RailResult> {
    const p = await plan(draft);
    const owner = requireOwner(draft);
    const before = await receiverBalance(p.to, p.asset);

    const spent = await spendFromIntents(
      { api, signer, keysPath, now, sleep, pollIntervalMs, pollTimeoutMs, maxDeadlineMs, quoteKey: deps.quoteKey },
      {
        owner,
        originAsset: p.asset,
        destinationAsset: p.asset,
        amountBase: p.amountBase,
        minOutBase: p.minReceivedBase,
        recipient: p.to,
        recipientType: 'INTENTS',
        slippageToleranceBps: SEND_SLIPPAGE_BPS,
        echo: echoWant(draft, p),
        checkQuote: (quote) => checkQuote(draft, p, quote),
      },
      hooks,
    );
    // This rail wires no preflight (the money stays inside the verifier), so an unsigned
    // outcome cannot happen here; the type still has to be narrowed before a hash is read.
    if (!spent.signed) return describeHeld(spent.preflight);
    if (!spent.submitted) {
      return withQuote(describeUnconfirmedSubmit({ error: spent.error, handle: spent.depositAddress, deadline: spent.deadline }), spent.signedQuote);
    }
    const { quote, depositAddress, watch, signedQuote } = spent;
    const evidence = `intent ${spent.intentHash}, quote handle ${oneLine(depositAddress, 80)}`;

    if (watch.status === 'SUCCESS') {
      const after = await receiverBalance(p.to, p.asset);
      const rise = before !== null && after !== null ? after - before : null;
      const risen = rise !== null && rise >= p.minReceivedBase;
      const receiverWords =
        rise === null
          ? `the receiver's balance could not be read back, so the credit is 1click's word (${deliveredNote(watch)})`
          : risen
            ? `${p.to} now holds ${rise.toString()} base units more of ${draft.symbol} inside the verifier (${deliveredNote(watch)})`
            : `${p.to} rose by only ${rise.toString()} base units of ${draft.symbol}, under the ${p.minReceivedBase.toString()} floor: read the verifier again before treating this as done`;
      return {
        ok: rise === null || risen,
        detail:
          `sent ${draft.amount} ${draft.symbol} from ${owner} to ${p.to} inside ${INTENTS_VERIFIER}; ` +
          `${oneLine(quote.amountOutFormatted, 40)} ${draft.symbol} quoted to land; ${receiverWords}; ${evidence}.`,
        txids: uniqueTxids(spent.intentHash, watch),
        evidence: { ...settledEvidence(watch, depositAddress), quote: signedQuote },
      };
    }

    if (watch.status === 'REFUNDED' || watch.status === 'FAILED') {
      return withQuote(describeRefund(watch, depositAddress, {
        symbol: draft.symbol,
        refundTarget: `${owner} inside ${INTENTS_VERIFIER}, where the balance started`,
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

    return {
      ok: false,
      detail:
        `the intent was submitted but 1click did not reach a terminal status within ` +
        `${Math.round(pollTimeoutMs / 1000)}s (last status ${watch.reported}); ${evidence}. ` +
        `THE INTENT IS SIGNED AND SUBMITTED and the credit may still land, so it is unconfirmed: read ${p.to}'s balance ` +
        `and ours inside ${INTENTS_VERIFIER} before signing another.`,
      txids: uniqueTxids(spent.intentHash, watch),
      evidence: { handle: oneLine(depositAddress, 80), quote: signedQuote },
    };
  }

  return { kind: 'intents_send', valueUsd, simulate, execute };
}
