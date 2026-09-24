// Spending a balance held inside intents.near through 1Click: the four steps every rail that
// starts from the intents balance shares, in one place.
//
// This was the body of the intents withdraw rail until 2026-09-11, when the HyperCore deposit
// rail needed exactly the same steps with a different destination asset. Two copies of a
// sequence that releases a signature is two places for the checks to drift, so the sequence
// lives here and the rails keep what is theirs: the quote they ask for, the words they expect
// echoed back, their own floor, and their sentences.
//
// THE SEQUENCE, one signature, nothing sent on any chain by us:
//   1. POST /v0/quote with depositType INTENTS -> a deposit handle inside the verifier
//      then the PREFLIGHT (src/preflight/), when the rail wired one: the chain the payout lands
//      on, the fee against the payout's cost, the venue, the balance, the quote's deadline. A
//      hold or a fail returns here, before step 2, with nothing generated and nothing signed.
//   2. POST /v0/generate-intent -> an erc191 payload transferring our balance to that handle
//   3. check the payload, sign it with the EVM key, POST /v0/submit-intent
//   4. GET /v0/status until SUCCESS, REFUNDED or FAILED
//
// WHERE THE MONEY GOES IS IN THE QUOTE, NOT IN THE SIGNATURE. The intent we sign says "give N
// of this asset to the solver's handle" and nothing about the far side. What closes that gap
// is the quote echo: the API returns the request it priced, verbatim, and every field the
// caller cares about is compared against it before the key is touched. A missing echo is a
// refusal, because with no echo there is nothing tying the signature to a destination at all.
//
// TWO PHASES, TWO CONTRACTS. Before the signature is released, every problem THROWS: nothing
// has happened and the caller's executor records the reason. After it is released, nothing
// throws: the balance may already be moving, and a status endpoint that goes down must not
// turn into an unhandled rejection that reads as "nothing happened". That includes the submit
// call itself: a submit that times out after the signature is returned as signed and
// unsubmitted, because 1Click may have taken the intent and the caller's sentence must say
// so. The caller gets the hash, the handle and the last status seen, and writes the sentence.
//
// NEVER SIGN AGAIN AFTER AN AMBIGUOUS OUTCOME. Once the key has been used for a move, this
// function does not call generate-intent or signErc191 for that move a second time, whatever
// happens next: a submit that got no reply, a submit the venue answered with an error, a watch
// that ran out. The verifier dedupes on the nonce inside the signed bytes and on nothing else,
// so a fresh signature is a fresh nonce and a second real balance move. The one retry that is
// safe is the identical signed bytes, once, inside this same call, and only when the first
// POST produced no reply at all (src/rails/intents-submit.ts); after that, or after any
// answered error, the outcome is returned as unconfirmed with the handle and the rail stops.
// The Hyperliquid rails follow the same rule with the venue nonce: an ambiguous spotSend is
// retried only with the nonce it already used, never a new one. The tests count the signer
// calls: exactly one per move.
//
// The executor is told twice, through the hooks, before any wait: the handle and deadline the
// moment the signature exists, and the hash the moment the submit answers. A process that
// dies inside the watch loop then still has both on the row.

import { oneLine, quoteEchoProblems } from '../intents.ts';
import type { OneClickEndpointType, OneClickQuote, OneClickStatus, QuoteEcho } from '../intents.ts';
import type { Preflight, RailHooks } from '../types.ts';
import type { VenueProbe } from '../preflight/index.ts';
import { quoteSignatureProblems, signedQuoteRecord } from '../quote-signature.ts';
import type { QuoteRecord } from '../quote-signature.ts';
import { INTENTS_SIGNING_STANDARD, checkIntentPayload, intentDeadline } from './intents-native.ts';
import type { IntentsApiPort, IntentsSignerPort } from './intents-native.ts';
import { submitSignedIntent } from './intents-submit.ts';
import { FIRST_POLL_MS, watchOneClick } from './watch.ts';
import { tell } from './oneclick-words.ts';

export type IntentsSpendDeps = {
  api: IntentsApiPort;
  signer: IntentsSignerPort;
  keysPath: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  // The first wait of the status watch; FIRST_POLL_MS when a rail names none.
  firstPollMs?: number;
  maxDeadlineMs: number;
  // The key 1Click signs quotes with. Left unset it is the production key; a test hands the
  // key its own fake signs with, and nothing else ever sets it.
  quoteKey?: string;
  // The app's own checks, run on the live quote before generate-intent. The rail binds its
  // draft into this closure; the spend path adds the venue probe and the balance's owner.
  // Absent means no checks, which is demo mode and the tests of the sequence itself.
  preflight?: PreflightHook;
};

// What the checks are handed beyond the quote: whose balance, which asset, and the two venue
// reads built from the same client and request as the live quote.
export type PreflightPort = { owner: string; originAsset: string; venue: VenueProbe };
export type PreflightHook = (quote: OneClickQuote, port: PreflightPort) => Promise<Preflight>;

export type IntentsSpendRequest = {
  owner: string; // our account id inside the verifier: the EVM address, lowercased
  originAsset: string;
  destinationAsset: string;
  amountBase: bigint; // exactly what leaves our balance
  minOutBase: bigint; // the least that may arrive; the payload check refuses a zero floor
  recipient: string;
  recipientType: OneClickEndpointType;
  slippageToleranceBps?: number;
  deadlineMs?: number;
  // What the caller expects the quote to echo, in the caller's own words.
  echo: QuoteEcho;
  // The caller's own checks on the live quote (its floor, its fee cap). Problems refuse.
  checkQuote?: (quote: OneClickQuote) => string[];
};

// Signed by the time this exists, or held back by the preflight with nothing signed at all:
// `signed` is the first discriminant, then whether the submit answered, and a caller has to
// look at both before reading a hash. Everything else before the signature throws.
export type IntentsSpendOutcome =
  | {
      signed: false;
      submitted: false;
      held: boolean; // hold: the executor tries again later; fail: it stops
      preflight: Preflight;
      quote: OneClickQuote;
    }
  | {
      signed: true;
      submitted: true;
      intentHash: string;
      depositAddress: string; // the handle inside the verifier the balance was handed to
      deadline: string; // the signed intent's own deadline, ISO
      quote: OneClickQuote;
      signedQuote: QuoteRecord; // what 1Click signed, verified before the handle was used
      watch: OneClickStatus; // the last status seen, terminal or not
    }
  | {
      signed: true;
      submitted: false;
      error: string; // what the submit call said, or how it failed to answer
      depositAddress: string;
      deadline: string;
      quote: OneClickQuote;
      signedQuote: QuoteRecord;
    };

function tellPreflight(hooks: RailHooks | undefined, preflight: Preflight): void {
  try {
    hooks?.onPreflight?.(preflight);
  } catch {
    // same: the row is the executor's to write
  }
}

/* The app fee 1Click prices into a quote, in basis points, read off the quote's own echo:
   quoteRequest.appFees is a list of { recipient, fee } and an unkeyed quote carries one line of
   25 bp (found 2026-09-11: 12.5 of the 13.23 USDC fee on a 5000 USDC move; still there
   2026-09-20). A partner key removes it, and the day it is gone this reads 0 rather than
   assuming. Never a rate to charge, only a fact to print: the fee is already inside amountOut. */
export function appFeeBpsOf(raw: unknown): number {
  const echo = (raw as { quoteRequest?: { appFees?: unknown } } | null)?.quoteRequest;
  const fees = echo?.appFees;
  if (!Array.isArray(fees)) return 0;
  let bps = 0;
  for (const line of fees) {
    const fee = Number((line as { fee?: unknown })?.fee);
    if (Number.isFinite(fee) && fee > 0) bps += fee;
  }
  return bps;
}

export async function spendFromIntents(deps: IntentsSpendDeps, req: IntentsSpendRequest, hooks?: RailHooks): Promise<IntentsSpendOutcome> {
  const response = await deps.api.quote({
    dry: false,
    originAsset: req.originAsset,
    destinationAsset: req.destinationAsset,
    amount: req.amountBase.toString(),
    account: req.owner,
    recipient: req.recipient,
    recipientType: req.recipientType,
    ...(req.slippageToleranceBps !== undefined ? { slippageToleranceBps: req.slippageToleranceBps } : {}),
    ...(req.deadlineMs !== undefined ? { deadlineMs: req.deadlineMs } : {}),
  });
  const quote = response.quote;

  // The signature is checked beside the caller's own checks and the echo, before the handle is
  // read for anything: a quote 1Click did not sign, or signed with a different handle, stops here.
  const problems = [...(req.checkQuote?.(quote) ?? []), ...quoteEchoProblems(response.raw, req.echo), ...quoteSignatureProblems(response, deps.quoteKey)];
  if (problems.length > 0) throw new Error(`live quote does not match the approved draft: ${problems.join('; ')}`);

  // For an INTENTS deposit type this is a handle inside the verifier rather than a chain
  // address, and nothing is ever sent to it. It ties the signed intent back to this quote,
  // which is what binds the signature to the destination checked above.
  const depositAddress = quote.depositAddress;
  if (typeof depositAddress !== 'string' || depositAddress.trim() === '') {
    throw new Error(`the quote carries no deposit handle to attach an intent to (got ${oneLine(depositAddress, 60)})`);
  }
  const signedQuote = signedQuoteRecord(response);

  // The checks, on the quote that will be spent through, and before the intent exists. Told
  // to the executor first so the row carries them even if the hold is the last thing that
  // happens; a hold or a fail returns with the key untouched and nothing to retry but this
  // whole sequence, which is what the executor does.
  if (deps.preflight !== undefined) {
    const preflight = await deps.preflight(quote, {
      owner: req.owner,
      originAsset: req.originAsset,
      venue: {
        dryQuote: () =>
          deps.api.quote({
            dry: true,
            originAsset: req.originAsset,
            destinationAsset: req.destinationAsset,
            amount: req.amountBase.toString(),
            account: req.owner,
            recipient: req.recipient,
            recipientType: req.recipientType,
            ...(req.slippageToleranceBps !== undefined ? { slippageToleranceBps: req.slippageToleranceBps } : {}),
          }),
        status: () => deps.api.status(depositAddress),
      },
    });
    tellPreflight(hooks, preflight);
    if (preflight.verdict !== 'ok') return { signed: false, submitted: false, held: preflight.verdict === 'hold', preflight, quote };
  }

  const generated = await deps.api.generateIntent({ signerId: req.owner, depositAddress });

  if (generated.standard !== INTENTS_SIGNING_STANDARD) {
    throw new Error(
      `generate-intent returned a ${oneLine(generated.standard, 40)} payload, but this rail signs ` +
        `${INTENTS_SIGNING_STANDARD} only`,
    );
  }

  // The same reader the swap rail uses. A spend comes back as a 'transfer' to the deposit
  // handle, which that reader binds to our own quote and to exactly the amount approved.
  const payloadProblems = checkIntentPayload(generated.payload, {
    signerId: req.owner,
    originAsset: req.originAsset,
    destinationAsset: req.destinationAsset,
    amountBase: req.amountBase,
    minOutBase: req.minOutBase,
    now: deps.now(),
    maxDeadlineMs: deps.maxDeadlineMs,
    depositAddress,
  });
  if (payloadProblems.length > 0) {
    throw new Error(`refusing to sign the intent 1click generated: ${payloadProblems.join('; ')}`);
  }

  // Signed exactly as returned: the signature has to cover the same bytes the verifier will
  // parse, so the payload string is never re-serialised.
  const payload = generated.payload as string;
  const deadline = intentDeadline(payload) ?? 'unknown';
  const signature = await deps.signer.signErc191(deps.keysPath, payload);
  tell(hooks, { handle: depositAddress, deadline, quote: signedQuote });

  const sent = await submitSignedIntent(deps.api, { payload, signature });
  if (!sent.submitted) {
    return { signed: true, submitted: false, error: sent.error, depositAddress, deadline, quote, signedQuote };
  }
  const submitted = sent.intent;
  tell(hooks, { txids: [submitted.intentHash], handle: depositAddress, deadline, quote: signedQuote });

  const watch = await watchStatus(deps, depositAddress, hooks);

  return { signed: true, submitted: true, intentHash: submitted.intentHash, depositAddress, deadline, quote, signedQuote, watch };
}

// The one watch every rail shares (./watch.ts): from a quarter second after the submit,
// doubling to this rail's interval, until terminal or out of time. Never throws once the intent
// has been submitted: a status endpoint that goes down after the money has moved must not become
// an unhandled rejection. Every read tells the executor 1Click's word, so the card moves with it.
export function watchStatus(deps: IntentsSpendDeps, depositAddress: string, hooks?: RailHooks): Promise<OneClickStatus> {
  const plan = { firstMs: deps.firstPollMs ?? FIRST_POLL_MS, everyMs: deps.pollIntervalMs, timeoutMs: deps.pollTimeoutMs, sleep: deps.sleep, now: deps.now };
  return watchOneClick(plan, (handle) => deps.api.status(handle), depositAddress, hooks);
}
