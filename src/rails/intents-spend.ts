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

import { ONECLICK_TERMINAL, oneLine, quoteEchoProblems } from '../intents.ts';
import type { OneClickEndpointType, OneClickQuote, OneClickStatus, QuoteEcho } from '../intents.ts';
import type { RailHooks } from '../types.ts';
import { INTENTS_SIGNING_STANDARD, checkIntentPayload, intentDeadline } from './intents-native.ts';
import type { IntentsApiPort, IntentsSignerPort } from './intents-native.ts';
import { submitSignedIntent } from './intents-submit.ts';

export type IntentsSpendDeps = {
  api: IntentsApiPort;
  signer: IntentsSignerPort;
  keysPath: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  maxDeadlineMs: number;
};

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

// Always signed by the time this exists: everything before the signature throws. Whether the
// submit answered is the discriminant, and a caller has to look at it before reading a hash.
export type IntentsSpendOutcome =
  | {
      signed: true;
      submitted: true;
      intentHash: string;
      depositAddress: string; // the handle inside the verifier the balance was handed to
      deadline: string; // the signed intent's own deadline, ISO
      quote: OneClickQuote;
      watch: OneClickStatus; // the last status seen, terminal or not
    }
  | {
      signed: true;
      submitted: false;
      error: string; // what the submit call said, or how it failed to answer
      depositAddress: string;
      deadline: string;
      quote: OneClickQuote;
    };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A hook is the executor's business. Whatever it does with the evidence, it must not turn a
// signature that is already released into a thrown "nothing happened".
function tell(hooks: RailHooks | undefined, evidence: Parameters<NonNullable<RailHooks['onEvidence']>>[0]): void {
  try {
    hooks?.onEvidence?.(evidence);
  } catch {
    // reported by the executor's own persistence, not by this rail
  }
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

  const problems = [...(req.checkQuote?.(quote) ?? []), ...quoteEchoProblems(response.raw, req.echo)];
  if (problems.length > 0) throw new Error(`live quote does not match the approved draft: ${problems.join('; ')}`);

  // For an INTENTS deposit type this is a handle inside the verifier rather than a chain
  // address, and nothing is ever sent to it. It ties the signed intent back to this quote,
  // which is what binds the signature to the destination checked above.
  const depositAddress = quote.depositAddress;
  if (typeof depositAddress !== 'string' || depositAddress.trim() === '') {
    throw new Error(`the quote carries no deposit handle to attach an intent to (got ${oneLine(depositAddress, 60)})`);
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
  tell(hooks, { handle: depositAddress, deadline });

  const sent = await submitSignedIntent(deps.api, { payload, signature });
  if (!sent.submitted) {
    return { signed: true, submitted: false, error: sent.error, depositAddress, deadline, quote };
  }
  const submitted = sent.intent;
  tell(hooks, { txids: [submitted.intentHash], handle: depositAddress, deadline });

  const watch = await watchStatus(deps, depositAddress);

  return { signed: true, submitted: true, intentHash: submitted.intentHash, depositAddress, deadline, quote, watch };
}

// Polls until terminal, out of attempts, or out of time. Never throws once the intent has
// been submitted: a status endpoint that goes down after the money has moved must not become
// an unhandled rejection.
export async function watchStatus(deps: IntentsSpendDeps, depositAddress: string): Promise<OneClickStatus> {
  const deadline = deps.now() + deps.pollTimeoutMs;
  const maxPolls = Math.max(1, Math.ceil(deps.pollTimeoutMs / deps.pollIntervalMs));
  let last: OneClickStatus = {
    found: false,
    status: 'PENDING_DEPOSIT',
    reported: 'not polled',
    originTxHashes: [],
    destinationTxHashes: [],
    nearTxHashes: [],
  };

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    try {
      last = await deps.api.status(depositAddress);
      if ((ONECLICK_TERMINAL as readonly string[]).includes(last.status)) return last;
    } catch (err) {
      last = { ...last, reported: `status check failed: ${oneLine(errText(err), 80)}` };
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(deps.pollIntervalMs);
  }

  return last;
}
