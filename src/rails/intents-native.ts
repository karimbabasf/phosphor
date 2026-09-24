// The intents-native swap rail: the funds already sit inside the verifier contract, and a
// swap is authorised by a signed message rather than by moving money.
//
// WHICH RAIL DO I WANT? Read this paragraph and you will know.
//
// The retired chain-side swap rail moved money that lived in a chain wallet. It asked 1Click for a quote,
// 1Click mints a brand new deposit address for that one quote, and the app sends an ERC-20
// transfer to it. That address is chosen by a remote server, exists only for a few days, and
// is different every time, so it can never appear on a policy allowlist written in advance.
// The app therefore hands real money to a destination the policy engine cannot check. The
// allowlist entry for that rail is the venue string, not an address, because no address of
// its own could ever be listed.
//
// This rail swaps money that already lives inside `intents.near`, the NEAR Intents verifier
// contract. Nothing is transferred to start a swap. The app asks for a quote with
// depositType INTENTS, asks the API to generate the intent that expresses the swap, checks
// that intent against the draft a human approved, signs it with the EVM key the app already
// holds, and submits the signature. The verifier moves balances on its own internal ledger.
//
// The security consequence is the reason this rail exists. Because there is no outbound
// transfer, there is no per-quote destination to govern, and the counterparty is the single
// fixed account `intents.near` for every swap forever. That is a value a human can put on
// the policy allowlist once and leave there, and it is the value evaluateRail actually
// checks. The unverifiable destination is not verified better here; it stops existing.
//
// What replaces it as the thing to be careful about: the API hands back an intent payload
// and we sign it. A signature over a payload we did not read is exactly as dangerous as a
// transfer to an address we did not check, so the payload is treated as hostile data. It is
// parsed with JSON.parse and never evaluated, it never chooses an address, it must name the
// hardcoded verifier account, and its amounts and asset ids are compared against the draft
// before the key is touched. A server that returns a payload swapping a different asset, or
// a payload carrying a withdrawal to somebody else's account, is refused unsigned.
//
// IT ALSO NEEDS A PARTNER API KEY, which a chain-side swap did not. Quoting is unauthenticated,
// but POST /v0/generate-intent and POST /v0/submit-intent both require an X-API-Key, and
// those two calls are the entire rail. A missing key is therefore refused at simulate()
// time, naming what to obtain, rather than surfacing as a confusing 401 at the moment of
// signing.

import { formatUnits } from 'viem';

import type { Rail, RailHooks, RailResult, SimulationResult, SwapDraft, SwapQuoteFacts, SwapSimulation, SwapSpend } from '../types.ts';
import { ERC191_STANDARD, duplicateJsonKey, liveIntentsSigner } from '../intents-sign.ts';
import type { IntentsSignerPort } from '../intents-sign.ts';
import {
  ONECLICK_BASE,
  baseUnits,
  baseUnitsToDecimal,
  decimalToBaseUnits,
  oneClickClient,
  quoteEchoProblems,
  oneLine,
  resolveAsset,
  toBaseUnits,
  truncateToBaseUnits,
} from '../intents.ts';
import type {
  OneClickClient,
  OneClickEndpointType,
  OneClickQuote,
  OneClickStatus,
  OneClickToken,
  TokensFile,
} from '../intents.ts';
import { venueWriteTimeout } from '../net.ts';
import { INTENTS_SETTLE, SETTLING_SENTENCE, watchRise } from '../ledger/settle.ts';
import type { RiseSchedule } from '../ledger/settle.ts';
import { MAX_SLIPPAGE_BPS, QUOTE_REUSE_MS, floorTooLow, floorUnderQuote } from './slippage.ts';
import { describeIncompleteDeposit, describeRefund, describeUnconfirmedSubmit, settledEvidence, uniqueTxids, withQuote } from './oneclick-words.ts';
import { quoteSignatureProblems, signedQuoteRecord } from '../quote-signature.ts';
import { noReply, submitSignedIntent } from './intents-submit.ts';
import { pickOrExplain, swapSummary } from './asset-words.ts';
import { ReasonError, quoteRefusalReason, reasonOf } from './reasons.ts';
import { watchOneClick } from './watch.ts';

// The verifier contract. This is the whole point of the rail: one fixed account that goes on
// the policy allowlist once and stays there, unlike a deposit address minted per quote.
// Nothing in this module may derive a destination from an API response; every place that
// needs the verifier reads this constant.
export const INTENTS_VERIFIER = 'intents.near';

// SwapDraft.venue for this rail. The 'swap' kind is shared with two other venues, so the
// venue is what routes a draft here and what a draft must name to be accepted.
export const INTENTS_NATIVE_VENUE = 'intents-native';

// What the policy allowlist has to contain. Unlike ONECLICK_COUNTERPARTY, this is not a
// venue string standing in for an address that cannot be listed: it is the real account the
// funds are held by and swapped inside.
export const INTENTS_NATIVE_COUNTERPARTY = INTENTS_VERIFIER;

// The signing standard. erc191 is plain personal_sign over the EVM key the app already
// holds, which is why this rail needs no NEAR key and no NEP-413 support. The signer, the
// signature encoding and the duplicate-key reader moved to src/intents-sign.ts on 2026-09-20
// so the relay rail can share them without importing this rail; they are re-exported here
// under their old names for the rails and tests that read them from this module.
export const INTENTS_SIGNING_STANDARD = ERC191_STANDARD;
export { duplicateJsonKey, erc191SignatureField, liveIntentsSigner } from '../intents-sign.ts';
export type { IntentsSignerPort } from '../intents-sign.ts';

// Environment variable carrying the partner API key. Read here rather than in the registry
// so the name lives next to the message that tells a human to set it.
export const INTENTS_API_KEY_ENV = 'PHOSPHOR_1CLICK_API_KEY';

// RETIRED as a blocker on 2026-08-13, kept as an exported string because the tests name it.
//
// This rail used to refuse at simulate() time without a partner API key, on the belief that
// POST /v0/generate-intent and POST /v0/submit-intent both require X-API-Key. Re-tested
// against the live API: an unauthenticated POST /v0/generate-intent with a real deposit
// handle returns HTTP 201 and the erc191 payload. The 400s that produced the original
// conclusion were body validation ("Missing required property 'type'", then "standard must
// be one of ..."), which fire before any auth check and look identical to a rejection if you
// stop at the status code.
//
// A key is still worth having, for the lower fee tier the README describes, so it is still
// read and still sent when present. It is no longer a precondition, because a gate that
// refuses a working rail is not a safety feature.
export const INTENTS_NO_API_KEY_REASON =
  `No 1Click partner API key is set (${INTENTS_API_KEY_ENV}), so this swap runs on the public fee tier. ` +
  'Quoting, intent generation and submission all work unauthenticated; a key only buys a better rate.';

/* HOW LONG THE SIGNED TRANSFER CAN RUN: three minutes, whatever 1Click generated. The nonce stops
   a second run of the same bytes (intents.near answers `is_nonce_used`, verified 2026-08-13), but
   it does nothing about the FIRST run arriving late. generate-intent writes a deadline 72 hours
   out and takes no deadline of its own (openapi, read 2026-09-23), so a swap 1Click called FAILED
   could still have its transfer run for three days after the card said nothing had moved (the
   audit of 2026-09-23). The deadline is cut here before signing, and nothing else in the payload is.
   Three minutes because 1Click estimates 12 s for a whole swap inside the verifier (live dry quote,
   2026-09-23) and the transfer is its first step; because the status watch below gives up at five,
   so a watch that runs out finds the transfer already run or dead; and because the quote's own
   deposit window is ten, so the transfer can never land on a quote 1Click has stopped honouring.
   A transfer that misses it is dead, which costs a retry and never money. */
export const SIGNED_DEADLINE_MS = 3 * 60 * 1000;

/* The payload with its deadline brought forward to `latestMs`, as the same bytes with that one
   value replaced. Unchanged when the deadline is already that soon, and unchanged when the value
   cannot be found exactly once: checkIntentPayload then refuses the long deadline, because which
   of two deadlines to cut is a guess. */
export function shortenDeadline(raw: string, latestMs: number): string {
  let deadline: unknown;
  try {
    deadline = (JSON.parse(raw) as Record<string, unknown> | null)?.['deadline'];
  } catch {
    return raw;
  }
  if (typeof deadline !== 'string' || !(Date.parse(deadline) > latestMs)) return raw;
  const found = [...raw.matchAll(/"deadline"\s*:\s*"([^"\\]*)"/g)];
  if (found.length !== 1 || found[0]![1] !== deadline) return raw;
  const at = found[0]!.index! + found[0]![0].length - deadline.length - 1;
  return `${raw.slice(0, at)}${new Date(latestMs).toISOString()}${raw.slice(at + deadline.length)}`;
}

// The nonce a payload carries, for the evidence: what the verifier is asked by afterwards. Read
// after checkIntentPayload has accepted the payload, so it is a non-empty string there.
export function intentNonce(raw: string): string | undefined {
  try {
    const nonce = (JSON.parse(raw) as Record<string, unknown> | null)?.['nonce'];
    return typeof nonce === 'string' && nonce !== '' ? nonce : undefined;
  } catch {
    return undefined;
  }
}

/* THE SLIPPAGE ASKED OF 1CLICK, half a percent, so the floor 1Click enforces sits ABOVE the one
   the person approved. The app sets its floor one percent under the propose-time quote
   (floorUnderQuote), and every later quote is held to it: a quote passes when its own minimum,
   amountOut x (1 - this), is at or above that floor. Asked at one percent, the two floors were cut
   from two quotes with the same band, so any down-tick between them refused: 5 of 19 swaps on
   2026-09-23, one over a 0.009% move. At half a percent the price has to fall about half a
   percent before a check refuses, which is a real reason to stop. */
export const QUOTE_SLIPPAGE_BPS = 50;

// ---------- base58, for the signature field ----------

// The verifier wants the secp256k1 signature as 'secp256k1:' + base58(65 bytes). base58 is a
// radix conversion, not a cryptographic primitive, so it is written out here rather than
// pulling in a dependency for it. @scure/base is present in node_modules as a transitive
// dependency of viem, but importing a package that package.json does not declare breaks the
// day a hoisting change moves it. Cross-checked against @scure/base on the leading-zero,
// empty and multi-byte vectors, and the test file repeats those vectors.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);

  let out = '';
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Leading zero bytes carry no value in the number above, so they have to be restored by
  // hand. Dropping them would silently change the signature.
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

// The other direction, added for src/rails/intents-withdraw.ts, which has to decide whether a
// string in config.local.json is a real 32-byte Solana address before it sends money to it. A
// length check on the text would pass a transposed or truncated key, and viem's address
// helpers only know EVM hex.
//
// Returns null rather than throwing on anything that is not base58: the caller is validating,
// not parsing, so "this is not an address" is an answer and not an exception.
export function base58Decode(text: string): Uint8Array | null {
  if (text === '') return null;

  let n = 0n;
  for (const ch of text) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }

  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n % 256n));
    n /= 256n;
  }

  // The mirror of the encode side: a leading '1' is a zero byte the number cannot carry.
  let zeros = 0;
  for (const ch of text) {
    if (ch !== '1') break;
    zeros += 1;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

// ---------- the API seam ----------

export type IntentsQuoteParams = {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: string; // base units, decimal integer string
  account: string; // our Intents account id; refundTo is always this, and recipient by default
  slippageToleranceBps?: number;
  deadlineMs?: number;
  // Where the OUTPUT lands. Omitted means the account, credited inside the verifier, which is
  // every swap on this rail and the shape this client was written for. The withdraw rail is
  // the one caller that names a chain address, and these two fields are the only thing in the
  // whole flow that decides where the money ends up: the signed intent hands the input to a
  // solver handle and says nothing about the far side, so the recipient lives in the quote and
  // has to be checked against the echo the API returns. src/rails/intents-withdraw.ts does that.
  //
  // refundTo stays the account and refundType stays INTENTS in both cases. A withdrawal that
  // fails should leave the balance where it already was, not push it onto a chain by another
  // route.
  recipient?: string;
  recipientType?: OneClickEndpointType;
};

export type GeneratedIntent = { standard: string; payload: unknown; correlationId?: string };
export type SubmittedIntent = { intentHash: string; correlationId?: string };

export type IntentsApiPort = {
  tokens(): Promise<OneClickToken[]>;
  quote(params: IntentsQuoteParams): Promise<{ quote: OneClickQuote; raw: unknown }>;
  generateIntent(params: { signerId: string; depositAddress: string }): Promise<GeneratedIntent>;
  submitIntent(signed: { payload: string; signature: string }): Promise<SubmittedIntent>;
  status(depositAddress: string): Promise<OneClickStatus>;
};

// The two endpoints that need the key are the two written here. Quoting, the token list and
// the status poll are unauthenticated and reuse the client in src/intents.ts rather than
// growing a second copy of them.
//
// `client` is accepted so the registry can hand every rail the SAME 1Click client: that
// client caches the token list per instance, and a fresh one per rail re-fetches the whole
// list. Absent, it builds its own, which is what a test or a one-off caller gets.
export function intentsApi(deps: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  client?: OneClickClient;
}): IntentsApiPort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const shared = deps.client ?? oneClickClient({ fetchImpl: deps.fetchImpl });

  // The key goes in a header and nowhere else. It is never interpolated into a message, a
  // thrown error or a returned detail string. An empty key means no header at all rather
  // than an empty one: 'X-API-Key: ' is a malformed credential where its absence is a valid
  // unauthenticated request, and the API answers the second one.
  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (deps.apiKey.trim() !== '') headers['X-API-Key'] = deps.apiKey;
    return headers;
  }

  async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = payload?.['message'] ?? payload?.['error'];
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${what} was rejected as unauthorised (${res.status}). ${INTENTS_NO_API_KEY_REASON}`);
      }
      throw new Error(msg !== undefined ? `${what} failed: ${oneLine(msg)}` : `${what} failed: ${res.status}`);
    }
    if (payload === null || typeof payload !== 'object') throw new Error(`${what} returned no JSON body`);
    return payload;
  }

  async function quote(params: IntentsQuoteParams): Promise<{ quote: OneClickQuote; raw: unknown }> {
    const deadline = new Date(Date.now() + (params.deadlineMs ?? 10 * 60 * 1000)).toISOString();
    // depositType and refundType are always INTENTS: the input is already inside the verifier
    // and a refund belongs back where it started. recipientType defaults to INTENTS too, which
    // is what keeps a swap entirely inside the contract and leaves no chain destination for the
    // policy engine to be unable to check.
    // Lowercased, and not as a formatting nicety. An intents account id derived from an EVM
    // key IS the lowercase address: the API rejects the checksummed form of the very same
    // address with HTTP 400 "recipient is not valid" (verified live 2026-08-13), and the
    // verifier derives the id the same way when it checks an erc191 signature. Passing the
    // checksummed form made every quote on this rail fail.
    const account = params.account.toLowerCase();

    // The recipient is NOT lowercased when it is a chain address. An intents account id is
    // canonically lowercase; a Solana address is base58 and case carries information, so
    // lowercasing one produces a different address that the API happens to accept as
    // well-formed. Only the caller knows which kind it passed, so it is passed through.
    const recipientType = params.recipientType ?? 'INTENTS';
    const recipient = params.recipient ?? account;

    const body = {
      dry: params.dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: params.slippageToleranceBps ?? 100,
      originAsset: params.originAsset,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      depositType: 'INTENTS',
      refundTo: account,
      refundType: 'INTENTS',
      recipient,
      recipientType,
      deadline,
    };

    const res = await fetchImpl(`${ONECLICK_BASE}/v0/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: venueWriteTimeout(),
    });
    const payload = await readJson(res, '1click quote');
    const quoteField = payload['quote'] as OneClickQuote | undefined;
    if (!quoteField || typeof quoteField !== 'object') throw new Error('no quote in 1click response');
    return { quote: quoteField, raw: payload };
  }

  async function generateIntent(params: { signerId: string; depositAddress: string }): Promise<GeneratedIntent> {
    // Lowercased for the same reason quote() lowercases the account, and missing here was a
    // fix applied to one path and not the other. An intents account id derived from an EVM key
    // IS the lowercase address, but signer.address() hands back the CHECKSUMMED form, so the
    // quote was created for the lowercase id and the intent was requested for the checksummed
    // one. Verified live 2026-08-13 against the same deposit handle: lowercase returns 201 and
    // checksummed returns HTTP 400 {"message":"Internal error generating intent"}. That message
    // reads as a server fault and is really a rejected argument, which is why this cost a swap
    // execution to find rather than a glance at the error.
    // Venue write. This and submit-intent below sit between the human's approval and funds
    // that cannot be recovered, and submit-intent runs after the signature is released.
    const res = await fetchImpl(`${ONECLICK_BASE}/v0/generate-intent`, {
      method: 'POST',
      signal: venueWriteTimeout(),
      headers: authHeaders(),
      body: JSON.stringify({
        type: 'swap_transfer',
        standard: INTENTS_SIGNING_STANDARD,
        signerId: params.signerId.toLowerCase(),
        depositAddress: params.depositAddress,
      }),
    });
    const payload = await readJson(res, 'generate-intent');
    const intent = payload['intent'] as Record<string, unknown> | undefined;
    if (!intent || typeof intent !== 'object') throw new Error('generate-intent returned no intent');
    return {
      standard: typeof intent['standard'] === 'string' ? (intent['standard'] as string) : '',
      payload: intent['payload'],
      correlationId: typeof payload['correlationId'] === 'string' ? (payload['correlationId'] as string) : undefined,
    };
  }

  async function submitIntent(signed: { payload: string; signature: string }): Promise<SubmittedIntent> {
    const res = await fetchImpl(`${ONECLICK_BASE}/v0/submit-intent`, {
      method: 'POST',
      signal: venueWriteTimeout(),
      headers: authHeaders(),
      body: JSON.stringify({
        type: 'swap_transfer',
        signedData: {
          standard: INTENTS_SIGNING_STANDARD,
          payload: signed.payload,
          signature: signed.signature,
        },
      }),
    });
    const payload = await readJson(res, 'submit-intent');
    const hash = payload['intentHash'];
    if (typeof hash !== 'string' || hash === '') throw new Error('submit-intent returned no intentHash');
    return {
      intentHash: oneLine(hash, 120),
      correlationId: typeof payload['correlationId'] === 'string' ? (payload['correlationId'] as string) : undefined,
    };
  }

  return { tokens: shared.tokens, quote, generateIntent, submitIntent, status: shared.status };
}

// ---------- the intent payload, read as data ----------

export type IntentPayloadExpectation = {
  signerId: string; // our own account id inside the verifier
  originAsset: string;
  destinationAsset: string;
  amountBase: bigint; // exactly what leaves our balance
  minOutBase: bigint; // the least that may arrive
  now: number;
  maxDeadlineMs: number;
  // The deposit handle from OUR quote. A 'transfer' intent names a receiver, and this is the
  // only value it is allowed to name. Optional so the token_diff path, which has no receiver,
  // does not have to invent one.
  depositAddress?: string;
};

// Everything that has to be true about the payload before the key is touched.
//
// The threat is a remote server returning a well-formed payload that does something other
// than the swap a human approved: a different asset, a larger amount, an extra withdrawal to
// an account that is not ours. A signature over that payload spends our balance exactly as
// effectively as a transfer would, so this is the checkpoint that replaces "is the deposit
// address one we trust", and unlike that question this one is answerable.
//
// The deadline a payload carries, for the sentence and the evidence once it is signed. Read
// after checkIntentPayload has accepted the payload, so the shape is already known good;
// undefined only if it is not.
export function intentDeadline(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const deadline = (parsed as Record<string, unknown> | null)?.['deadline'];
    return typeof deadline === 'string' && deadline !== '' ? oneLine(deadline, 40) : undefined;
  } catch {
    return undefined;
  }
}

// Returns the problems it found. An empty array means the payload says what the draft says.
export function checkIntentPayload(raw: unknown, expect: IntentPayloadExpectation): string[] {
  /* The floor first, before the payload is even read. Every amount check below compares against
     minOutBase, so a floor of zero turns all of them into "receive >= 0", which every payload
     satisfies: a token_diff crediting nothing was accepted and would have been signed.

     plan() now refuses a zero floor before this is ever reached, and that is exactly why the
     guard belongs here too. Leaning on an upstream check to enforce a property this function
     claims is how the claim quietly stops being true, which is the defect this whole file's
     comments keep describing. */
  if (expect.minOutBase <= 0n) {
    return ['the draft carries no slippage floor, so no payload can be checked against one'];
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    return [`the erc191 intent payload must be a JSON string, got ${oneLine(raw, 60)}`];
  }

  let body: Record<string, unknown>;
  try {
    // JSON.parse, never eval and never a Function constructor. The payload is a value.
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [`the intent payload is not a JSON object: ${oneLine(raw, 80)}`];
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return [`the intent payload is not valid JSON: ${oneLine(raw, 80)}`];
  }

  const twice = duplicateJsonKey(raw);
  if (twice !== null) {
    return [
      `the intent payload names ${oneLine(twice, 40)} twice in one object, so what this app checked and what the ` +
        'verifier would read may differ; a payload that can be read two ways is not signed',
    ];
  }

  // The verifier the signature is scoped to. A payload naming any other contract would be a
  // signature we release for a system we did not choose, so this is compared against the
  // hardcoded constant and never against anything the API told us.
  const verifying = body['verifying_contract'];
  if (verifying !== INTENTS_VERIFIER) {
    return [
      `the intent names ${oneLine(verifying, 60)} as the verifying contract, not ${INTENTS_VERIFIER}; ` +
        'this signature would authorise a swap in a contract we did not choose',
    ];
  }

  const signer = body['signer_id'];
  if (typeof signer !== 'string' || signer.toLowerCase() !== expect.signerId.toLowerCase()) {
    return [`the intent is authored for ${oneLine(signer, 60)} but our account is ${expect.signerId}`];
  }

  if (typeof body['nonce'] !== 'string' || body['nonce'] === '') {
    return ['the intent carries no nonce, so it cannot be protected against replay'];
  }

  // A signed intent stays spendable until its deadline. A deadline in the past is dead on
  // arrival; a deadline far ahead is a long replay window on a signature we have released.
  const deadlineRaw = body['deadline'];
  const deadline = typeof deadlineRaw === 'string' ? Date.parse(deadlineRaw) : Number.NaN;
  if (!Number.isFinite(deadline)) {
    return [`the intent deadline ${oneLine(deadlineRaw, 60)} is not a timestamp`];
  }
  if (deadline <= expect.now) {
    return [`the intent deadline ${oneLine(deadlineRaw, 60)} has already passed`];
  }
  if (deadline - expect.now > expect.maxDeadlineMs) {
    return [
      `the intent stays valid until ${oneLine(deadlineRaw, 60)}, more than ` +
        `${Math.round(expect.maxDeadlineMs / 60000)} minutes out; a signature released for that long can be replayed`,
    ];
  }

  const intents = body['intents'];
  if (!Array.isArray(intents) || intents.length !== 1) {
    // Deliberately strict. With every leg staying inside the verifier there is no legitimate
    // second intent: a withdrawal, a transfer or a key change riding along with the swap is
    // the exact shape of the attack this check exists for. Refusing names what was found, so
    // a legitimate change in the API's output is a readable refusal and not a mystery.
    const kinds = Array.isArray(intents)
      ? intents.map((i) => oneLine((i as Record<string, unknown>)?.['intent'] ?? '?', 30)).join(', ')
      : oneLine(intents, 60);
    return [`the intent bundles ${Array.isArray(intents) ? intents.length : 'a non-list'} actions (${kinds}); this rail signs exactly one token_diff`];
  }

  const action = intents[0] as Record<string, unknown>;

  // 1Click's depositType INTENTS flow returns a 'transfer', not a 'token_diff'. Verified
  // against the live API 2026-08-13: generate-intent for a swap of an intents balance came
  // back as {"intent":"transfer","receiver_id":"<the deposit handle of our own quote>",
  // "tokens":{"<originAsset>":"<amountBase>"}}. Both shapes are accepted because both are
  // real, and each is checked for what it can actually do wrong.
  //
  // WHAT SIGNING A TRANSFER MEANS, stated plainly because it is weaker than a token_diff and
  // the difference is not visible in the code. A token_diff is atomic: the balance leaves and
  // the proceeds arrive in one verifier operation, so a solver cannot take one without giving
  // the other. A transfer is not: it hands the input to the solver's account, and the output
  // arrives afterwards as a separate settlement. Between those two moments the funds are the
  // solver's and the guarantee is the quote, not the contract.
  //
  // That is the same trust the oneclick rail takes when it sends money to a minted deposit
  // address, and it is the trust the protocol is built on, so it is accepted rather than
  // refused. What is NOT accepted is a transfer to anywhere other than the deposit handle of
  // the very quote this draft was priced against: that binding is what stops a payload from
  // moving our balance to an account of the server's choosing, and it is checked below.
  if (action?.['intent'] === 'transfer') {
    const receiver = action['receiver_id'];
    if (expect.depositAddress === undefined || expect.depositAddress.trim() === '') {
      return ['the intent is a transfer, but no deposit handle was supplied to check its receiver against'];
    }
    if (typeof receiver !== 'string' || receiver !== expect.depositAddress) {
      return [
        `the transfer sends our balance to ${oneLine(receiver, 60)}, not to ${oneLine(expect.depositAddress, 60)}, ` +
          'the deposit handle of the quote this draft was priced against',
      ];
    }

    const tokens = action['tokens'];
    if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
      return [`the transfer carries no tokens object (got ${oneLine(tokens, 60)})`];
    }
    const moved = tokens as Record<string, unknown>;
    const movedKeys = Object.keys(moved);

    // Exactly the input asset and nothing else. A second entry is a second balance leaving.
    const extra = movedKeys.filter((k) => k !== expect.originAsset);
    if (extra.length > 0) {
      return [`the transfer also moves ${extra.map((k) => oneLine(k, 60)).join(', ')}, which the draft does not name`];
    }
    if (!movedKeys.includes(expect.originAsset)) {
      return [`the transfer does not move ${oneLine(expect.originAsset, 60)}, which the draft names as the input`];
    }

    const amount = amountOf(moved[expect.originAsset], 'the transfer');
    if (typeof amount === 'string') return [amount];
    // A transfer states a positive amount leaving, where a token_diff states it as negative.
    if (amount !== expect.amountBase) {
      return [`the transfer moves ${amount.toString()} base units, not the ${expect.amountBase.toString()} the draft approved`];
    }

    return [];
  }

  if (action?.['intent'] !== 'token_diff') {
    return [`the intent is a ${oneLine(action?.['intent'], 40)}, which is neither the token_diff nor the transfer a swap is made of`];
  }

  const diff = action['diff'];
  if (diff === null || typeof diff !== 'object' || Array.isArray(diff)) {
    return [`the token_diff carries no diff object (got ${oneLine(diff, 60)})`];
  }
  const entries = diff as Record<string, unknown>;
  const keys = Object.keys(entries);

  const problems: string[] = [];

  // Exactly the two assets the draft names, and nothing else. An extra asset in the diff is
  // an extra balance being moved.
  const unexpected = keys.filter((k) => k !== expect.originAsset && k !== expect.destinationAsset);
  if (unexpected.length > 0) {
    problems.push(`the swap also moves ${unexpected.map((k) => oneLine(k, 60)).join(', ')}, which the draft does not name`);
  }
  if (!keys.includes(expect.originAsset)) {
    problems.push(`the swap does not spend ${oneLine(expect.originAsset, 60)}, which the draft names as the input`);
  }
  if (!keys.includes(expect.destinationAsset)) {
    problems.push(`the swap does not deliver ${oneLine(expect.destinationAsset, 60)}, which the draft names as the output`);
  }
  if (problems.length > 0) return problems;

  const spend = amountOf(entries[expect.originAsset], 'the input leg');
  const receive = amountOf(entries[expect.destinationAsset], 'the output leg');
  if (typeof spend === 'string') return [spend];
  if (typeof receive === 'string') return [receive];

  // A token_diff spends as a negative number and credits as a positive one.
  if (spend !== -expect.amountBase) {
    problems.push(`the swap spends ${(-spend).toString()} base units, not the ${expect.amountBase.toString()} the draft approved`);
  }
  if (receive < expect.minOutBase) {
    problems.push(`the swap delivers ${receive.toString()} base units, below the ${expect.minOutBase.toString()} floor the draft approved`);
  }

  return problems;
}

// A diff amount. Never Number(): these are base units at up to 24 decimals and a double
// would round them silently, and a garbage value must be a refusal rather than a NaN that
// compares false against every limit.
function amountOf(value: unknown, what: string): bigint | string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return `${what} of the swap has no amount (got ${oneLine(value, 40)})`;
  }
  try {
    return BigInt(value);
  } catch {
    return `${what} of the swap has a non-integer amount: ${oneLine(value, 40)}`;
  }
}

// ---------- the rail ----------

/* What one asset's balance is inside the verifier, in base units. null means the read failed,
   which is not the same as a balance of zero and must never be reported as one.

   This is the seam behind the after-check in execute. The rail used to report the QUOTE's
   promised output as realised ("swapped X for Y"), and the payload actually signed is a transfer,
   so the far side of that sentence was the solver's promise rather than an observed fact. The
   reader already existed in src/ledger/intents.ts and nothing on this path ever called it. */
export type VerifierBalancePort = (accountId: string, assetId: string) => Promise<bigint | null>;

// Whether the verifier has spent a nonce for this account: the signed transfer having run. Null
// when the read failed, which is never "unspent".
export type NonceUsedPort = (accountId: string, nonce: string) => Promise<boolean | null>;

export type IntentsNativeRailDeps = {
  keysPath: string;
  tokens: TokensFile;
  apiKey?: string; // defaults to process.env[INTENTS_API_KEY_ENV]
  signer?: IntentsSignerPort;
  api?: IntentsApiPort;
  client?: OneClickClient; // the registry's shared 1Click client, so the token list is fetched once
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  firstPollMs?: number;
  maxDeadlineMs?: number;
  verifierBalance?: VerifierBalancePort;
  nonceUsed?: NonceUsedPort;
  // The key 1Click signs quotes with. Left unset it is the production key; a test hands the
  // key its own fake signs with, and nothing else ever sets it.
  quoteKey?: string;
  // How long, and how often, the after-read is repeated once 1Click says SUCCESS. Defaults to
  // INTENTS_SETTLE; the tests shorten it.
  settleSchedule?: RiseSchedule;
};

/* The default reader, over the same view calls the ledger uses. It never throws: a verifier that
   will not answer costs the check, and losing the check must not turn a swap the venue confirmed
   into a reported failure. */
export function liveVerifierBalance(fetchImpl?: typeof fetch): VerifierBalancePort {
  return async (accountId, assetId) => {
    try {
      const [{ fetchIntentsAssetBalance }, { nearChainSpec }] = await Promise.all([
        import('../ledger/intents.ts'),
        import('../chain/near.ts'),
      ]);
      return await fetchIntentsAssetBalance({
        accountId,
        assetId,
        rpcUrl: nearChainSpec().rpcUrl,
        fetchImpl: fetchImpl ?? fetch,
      });
    } catch {
      return null;
    }
  };
}

// The same view the relay rail's reconcile asks (src/relay/verifier.ts). Never throws.
export function liveNonceUsed(fetchImpl?: typeof fetch): NonceUsedPort {
  return async (accountId, nonce) => {
    try {
      const { liveVerifier } = await import('../relay/verifier.ts');
      return await liveVerifier(fetchImpl ?? fetch).nonceUsed(accountId, nonce);
    } catch {
      return null;
    }
  };
}

export type IntentsNativeRail = Rail<SwapDraft>;


function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A hook is the executor's business; whatever it does with the evidence, it must not turn a
// signature that is already released into a thrown "nothing happened".
function tell(hooks: RailHooks | undefined, evidence: Parameters<NonNullable<RailHooks['onEvidence']>>[0]): void {
  try {
    hooks?.onEvidence?.(evidence);
  } catch {
    // reported by the executor's own persistence, not by this rail
  }
}

export function intentsNativeRail(deps: IntentsNativeRailDeps): IntentsNativeRail {
  const { keysPath, tokens } = deps;
  const apiKey = deps.apiKey ?? process.env[INTENTS_API_KEY_ENV];
  const signer = deps.signer ?? liveIntentsSigner;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 5 * 60_000;
  // How long to wait before the SECOND status read. The oneclick rail's 5s is right for a
  // swap that bridges: its own estimate is ~42s, so 5s granularity costs 12%. This rail
  // never leaves the verifier (depositType and recipientType are both INTENTS), so the
  // solver settles in about one NEAR block and a flat 5s sleep IS the observed latency.
  // Start at a quarter second and double up to the interval, so a fast swap is seen fast
  // and a slow one still backs off to one poll every 5s.
  const firstPollMs = deps.firstPollMs ?? 250;
  const maxDeadlineMs = deps.maxDeadlineMs ?? SIGNED_DEADLINE_MS;
  const quoteKey = deps.quoteKey;
  const settleSchedule = deps.settleSchedule ?? INTENTS_SETTLE;

  // The key is optional: it selects a fee tier, it does not authorise the calls. See the
  // comment on INTENTS_NO_API_KEY_REASON for what was re-tested and when.
  const api = deps.api ?? intentsApi({ apiKey: apiKey ?? '', fetchImpl: deps.fetchImpl, client: deps.client });
  const verifierBalance = deps.verifierBalance ?? liveVerifierBalance(deps.fetchImpl);
  const nonceUsed = deps.nonceUsed ?? liveNonceUsed(deps.fetchImpl);

  type Plan = {
    originAsset: string;
    destinationAsset: string;
    destSymbol: string; // the bought coin as the list names it, for the summary a person reads
    originDecimals: number;
    destDecimals: number;
    amountBase: bigint;
    minOutBase: bigint;
  };

  function requireVenue(draft: SwapDraft): void {
    if (draft.venue !== INTENTS_NATIVE_VENUE) {
      throw new Error(
        `intents-native rail received a ${draft.venue} draft; kind 'swap' is shared, venue is not`,
      );
    }
    // The counterparty is fixed and hardcoded. A draft naming anything else is either built
    // against the wrong rail or built by something choosing where the money goes.
    if (draft.counterparty !== INTENTS_NATIVE_COUNTERPARTY) {
      throw new Error(
        `intents-native drafts must name ${INTENTS_NATIVE_COUNTERPARTY} as the counterparty ` +
          `(got ${oneLine(draft.counterparty, 60)}); the verifier account is fixed and never comes from a quote`,
      );
    }
    // Both legs stay inside the verifier and are credited to our own account, so a draft
    // whose output goes somewhere else is describing a swap this rail cannot perform. Checked
    // without reading the key so simulate stays key-free; execute checks both against the
    // real signer address.
    if (draft.from.toLowerCase() !== draft.to.toLowerCase()) {
      throw new Error(
        `intents-native credits the proceeds to our own account inside the verifier, so a draft cannot ` +
          `send them from ${oneLine(draft.from, 50)} to ${oneLine(draft.to, 50)}`,
      );
    }
  }

  // Nothing to require any more: the rail is usable without a key. Kept as a named no-op so
  // the call sites still read as "check this is runnable here" and the next precondition has
  // an obvious home.
  function requireUsable(): void {}

  async function plan(draft: SwapDraft, floorless = false): Promise<Plan> {
    requireVenue(draft);
    requireUsable();

    /* A floor of zero is not a floor, and it does more damage on this rail than on any other.
       minOutBase is the number the signed payload is checked against, and the number the
       balance read-back subtracts against after the swap. That read-back exists so a swap
       crediting nothing is not reported as a success; against a zero floor it reported a total
       loss as a measured success, in the sentence that advertises the measurement. `floorless`
       is the one caller with no floor yet, quote() below, which asks the price the floor will
       be set under and never reaches a signature. */
    if (!floorless && !(draft.minAmountOut > 0)) {
      throw new ReasonError('invalid_request', 'minAmountOut is 0: refusing to swap with no slippage floor');
    }

    // No EVM-origin restriction, unlike the oneclick rail. Nothing is signed on the origin
    // chain here, so the asset's home chain only has to be one the verifier holds a bridged
    // balance for; a base USDC to NEAR USDT swap needs no NEAR key and no Solana key.
    //
    // resolveAsset rather than assetIdFor, so a gas asset can be named. Inside the verifier a
    // deposited ETH is nep141:eth.omft.near and a SOL is nep141:sol.omft.near, both perfectly
    // ordinary balances; the only thing that made them unreachable was that data/tokens.json
    // has no row for an asset with no contract address. Without this, the funding path could
    // deposit ETH and no swap could ever spend it.
    const list = await (api as IntentsApiPort).tokens();
    const origin = originIn(draft, list);
    const dest = pickOrExplain(resolveAsset(draft.toChain, draft.toSymbol, tokens, list), draft.toSymbol, draft.toChain);
    if (origin.assetId === dest.assetId) {
      throw new ReasonError('invalid_request', `${draft.fromSymbol} on ${draft.chain} and ${draft.toSymbol} on ${draft.toChain} are the same asset inside the verifier`);
    }

    return {
      originAsset: origin.assetId,
      destinationAsset: dest.assetId,
      destSymbol: list.find((t) => t.assetId === dest.assetId)?.symbol ?? draft.toSymbol,
      originDecimals: origin.decimals,
      destDecimals: dest.decimals,
      // The exact decimal the draft was approved with. A row written before it existed carries
      // the double alone, and the balance read before signing is what guards that one.
      amountBase: draft.amountInExact !== undefined ? decimalToBaseUnits(draft.amountInExact, origin.decimals) : toBaseUnits(draft.amountIn, origin.decimals),
      minOutBase: floorless ? 0n : toBaseUnits(draft.minAmountOut, dest.decimals),
    };
  }

  // The asset a draft spends, off the one resolver, with its decimals.
  function originIn(draft: SwapDraft, list: OneClickToken[]): { assetId: string; decimals: number } {
    return pickOrExplain(resolveAsset(draft.chain, draft.fromSymbol, tokens, list), draft.fromSymbol, draft.chain);
  }

  /* WHAT THE DRAFT SPENDS AND HOW MUCH OF IT IS HELD, for the builder: "all" becomes this exact
     figure, and an amount above it is refused before any price is asked for. A read that fails
     is null, never zero. Nothing is signed. */
  async function spend(draft: SwapDraft): Promise<SwapSpend> {
    requireVenue(draft);
    const origin = originIn(draft, await (api as IntentsApiPort).tokens());
    return { assetId: origin.assetId, decimals: origin.decimals, heldBase: await verifierBalance(draft.from.toLowerCase(), origin.assetId) };
  }

  type Priced = { quote: OneClickQuote; raw: unknown };
  // The floor-setting price, kept for simulate to check rather than asked for a second time.
  const recentDry = new Map<string, { at: number; response: Priced }>();

  function dryKey(p: Plan, account: string): string {
    return `${p.originAsset}|${p.destinationAsset}|${p.amountBase.toString()}|${account.toLowerCase()}`;
  }

  /* Every quote this rail asks 1Click for: half a percent of slippage asked (QUOTE_SLIPPAGE_BPS),
     and a refusal read as its cause. "No liquidity available" is nobody selling, a minimum is a
     minimum, and a quote that never answered is no price right now. */
  async function askQuote(dry: boolean, p: Plan, account: string): Promise<Priced> {
    try {
      return await (api as IntentsApiPort).quote({
        dry,
        originAsset: p.originAsset,
        destinationAsset: p.destinationAsset,
        amount: p.amountBase.toString(),
        account,
        slippageToleranceBps: QUOTE_SLIPPAGE_BPS,
      });
    } catch (err) {
      if (reasonOf(err) !== undefined) throw err;
      const message = errText(err);
      throw new ReasonError(noReply(err) ? 'no_price' : quoteRefusalReason(message), message);
    }
  }

  /* A dry quote. `reuse` is simulate: the price quote() asked for a moment ago, for this very
     plan, is the one it checks, and it is used once. */
  async function dryQuote(p: Plan, account: string, reuse: boolean): Promise<Priced> {
    const key = dryKey(p, account);
    const kept = recentDry.get(key);
    recentDry.delete(key);
    if (reuse && kept !== undefined && now() - kept.at <= QUOTE_REUSE_MS) return kept.response;
    const response = await askQuote(true, p, account);
    if (!reuse) {
      for (const [k, v] of recentDry) if (now() - v.at > QUOTE_REUSE_MS) recentDry.delete(k);
      recentDry.set(key, { at: now(), response });
    }
    return response;
  }

  /* What is wrong with a quote, each with its cause. The floor is the one a market moves: a
     quote whose own minimum is under the floor the person approved is the price having fallen,
     `price_moved`. Everything else is a quote this rail will not sign. */
  type Problem = { text: string; code: 'price_moved' | 'simulation_failed' };

  function checkQuote(draft: SwapDraft, p: Plan, quote: OneClickQuote): Problem[] {
    const problems: Problem[] = [];

    const amountIn = baseUnits(quote.amountIn, 'amountIn');
    if (amountIn !== p.amountBase) {
      problems.push({
        text: `the quote is for ${formatUnits(amountIn, p.originDecimals)} ${draft.fromSymbol}, not the ${amountInText(draft, p)} the draft names`,
        code: 'simulation_failed',
      });
    }

    const minOut = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (minOut < p.minOutBase) {
      problems.push({
        text: `the solver floor of ${formatUnits(minOut, p.destDecimals)} ${draft.toSymbol} is below the draft floor of ${draft.minAmountOut}`,
        code: 'price_moved',
      });
    }

    /* And the floor against the price. The check above only says the solver guarantees at least
       what the draft asked for, so a draft floor of one base unit passes it against any quote.
       Both amounts are base units of the destination asset, so this compares exactly. */
    const amountOut = baseUnits(quote.amountOut, 'amountOut');
    if (floorTooLow(amountOut, p.minOutBase, MAX_SLIPPAGE_BPS)) {
      problems.push({
        text:
          `the draft floor of ${draft.minAmountOut} ${draft.toSymbol} is more than ${MAX_SLIPPAGE_BPS / 100}% ` +
          `below the ${formatUnits(amountOut, p.destDecimals)} ${draft.toSymbol} this swap quotes: a floor ` +
          'that low is an invitation to a sandwich, not slippage protection',
        code: 'simulation_failed',
      });
    }

    return problems;
  }

  // One cause for a list of problems: the price moving, only when that is all that is wrong.
  function causeOf(problems: Problem[]): 'price_moved' | 'simulation_failed' {
    return problems.length > 0 && problems.every((x) => x.code === 'price_moved') ? 'price_moved' : 'simulation_failed';
  }

  // The amount in the draft's own words: the exact decimal when it carries one.
  function amountInText(draft: SwapDraft, p: Plan): string {
    return draft.amountInExact ?? baseUnitsToDecimal(p.amountBase, p.originDecimals);
  }

  /* The quote's echo of what we asked for, checked against what we asked for.
     checkQuote above reads amountIn and minAmountOut and nothing else, so a quote priced to
     credit a DIFFERENT recipient, to take its input from a chain transfer rather than the
     verifier balance, or to refund somewhere that is not our account, passed every check and was
     signed, submitted and reported as SUCCESS.

     The comparison is in src/intents.ts, shared with every rail that quotes. What stays here is
     what this rail asked for, spelled out. */
  function checkQuoteEcho(p: Plan, owner: string, raw: unknown): Problem[] {
    return echoProblems(p, owner, raw).map((text) => ({ text, code: 'simulation_failed' as const }));
  }

  function echoProblems(p: Plan, owner: string, raw: unknown): string[] {
    return quoteEchoProblems(raw, {
      recipient: owner,
      recipientVerb: 'credit',
      recipientNoun: 'account',
      recipientType: 'INTENTS',
      recipientTypeWhy: 'this rail swaps inside the verifier and moves nothing onto any chain',
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      refundTypeWhy: 'back to our balance inside the verifier',
      refundTo: owner,
      originAsset: p.originAsset,
      destinationAsset: p.destinationAsset,
      amount: p.amountBase.toString(),
      noEcho:
        'there is nothing tying it to the account the draft credits. The signed intent hands our balance to a ' +
        `solver handle and does not name ${oneLine(owner, 60)} anywhere, so without the echo this swap cannot ` +
        'be checked and is refused.',
    });
  }

  function priceLines(draft: SwapDraft, p: Plan, quote: OneClickQuote): string[] {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    const feeUsd = Number.isFinite(inUsd) && Number.isFinite(outUsd) ? inUsd - outUsd : NaN;
    return [
      `intents-native: ${amountInText(draft, p)} ${draft.fromSymbol} -> ` +
        `${oneLine(quote.amountOutFormatted, 40)} ${draft.toSymbol}, entirely inside ${INTENTS_VERIFIER}`,
      `fee ${Number.isFinite(feeUsd) ? '$' + feeUsd.toFixed(4) : 'unknown'}, eta ~${Number(quote.timeEstimate)}s, ` +
        `solver floor ${oneLine(quote.minAmountOut, 40)} base units, draft floor ${draft.minAmountOut} ${draft.toSymbol}`,
    ];
  }

  /* The same figures as fields, for the decision card. The card used to read a fee slot no
     swap simulation ever carried and print "No fee was quoted." over a summary line that
     named the fee; these are the numbers the rail checked, and the card draws these. */
  function swapFacts(p: Plan, quote: OneClickQuote): SwapSimulation {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    return {
      receives: oneLine(quote.amountOutFormatted, 40),
      receivesAtLeast: formatUnits(baseUnits(quote.minAmountOut, 'minAmountOut'), p.destDecimals),
      feeUsd: Number.isFinite(inUsd) && Number.isFinite(outUsd) ? Math.round((inUsd - outUsd) * 10_000) / 10_000 : null,
      etaSeconds: Number.isFinite(Number(quote.timeEstimate)) ? Number(quote.timeEstimate) : null,
    };
  }

  function valueUsd(draft: SwapDraft): number {
    return Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
  }

  async function simulate(draft: SwapDraft): Promise<SimulationResult> {
    try {
      // Order matters, and all three of these refuse before any network call. A draft for
      // another venue is not this rail's business; a missing key means the swap cannot be
      // submitted however good the price is, so pricing it would be a proposal a human can
      // approve and nothing can run.
      requireVenue(draft);
      requireUsable();

      const p = await plan(draft);

      // The price quote() cut the floor from, when propose asked for one a moment ago.
      const response = await dryQuote(p, draft.from, true);

      const lines = priceLines(draft, p, response.quote);
      const swap = swapFacts(p, response.quote);
      // Both checks, in both places. simulate ran checkQuote alone and execute added the echo,
      // so a quote priced to another account passed the approval gate and failed after a human
      // had clicked. draft.from is the account here rather than the signer address, because
      // simulate stays key-free; requireVenue has already tied from and to together, and execute
      // checks both against the real key a moment before signing.
      const problems = [...checkQuote(draft, p, response.quote), ...checkQuoteEcho(p, draft.from, response.raw)];
      // A refusal's words are its reason's sentence (the view); its summary says nothing more.
      if (problems.length > 0) {
        const joined = problems.map((x) => x.text).join('; ');
        return { ok: false, summary: '', developer: [`REFUSED: ${joined}`, ...lines].join('\n'), error: joined, reason: causeOf(problems), swap };
      }

      lines.push(
        `execution signs one intent with the EVM key and transfers nothing; the balance must already be ` +
          `inside ${INTENTS_VERIFIER}`,
      );
      return { ok: true, summary: swapSummary(swap, p.destSymbol), developer: lines.join('\n'), swap };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: '', developer: `intents-native simulation failed: ${message}`, error: message, reason: reasonOf(err) ?? 'simulation_failed' };
    }
  }

  async function execute(draft: SwapDraft, _proposalId?: string, hooks?: RailHooks): Promise<RailResult> {
    requireVenue(draft);
    requireUsable();
    const client = api as IntentsApiPort;

    const p = await plan(draft);

    // The draft names the wallet a human approved. Since the account id inside the verifier
    // IS this address, a different key would be swapping somebody else's balance, or more
    // likely swapping nothing and failing after the signature is already released.
    const owner = signer.address(keysPath);
    if (draft.from.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`draft is authored for ${draft.from} but the configured key is ${owner}`);
    }

    /* THE LIVE QUOTE, AND BESIDE IT THE BALANCE THIS SWAP SPENDS. Nothing is signed for more
       than is held: a transfer larger than the balance can never execute, 1Click marks it
       FAILED, and the card used to say the money was held by 1Click when none had left
       (2026-09-23, three times). Read alongside the quote so it costs no time. A read that fails
       keeps the swap going, as the after-read does: the signed amount is still the approved one. */
    const [response, heldBefore] = await Promise.all([askQuote(false, p, owner), verifierBalance(owner.toLowerCase(), p.originAsset)]);
    if (heldBefore !== null && heldBefore < p.amountBase) {
      throw new ReasonError(
        'insufficient_balance',
        `the balance inside ${INTENTS_VERIFIER} holds ${formatUnits(heldBefore, p.originDecimals)} ${draft.fromSymbol}, less than the ` +
          `${amountInText(draft, p)} ${draft.fromSymbol} this swap spends; nothing was signed`,
      );
    }
    const quote = response.quote;

    // The signature is checked beside the amounts and the echo, before the handle is read for
    // anything: a quote 1Click did not sign, or signed with a different handle, stops here.
    const problems: Problem[] = [
      ...checkQuote(draft, p, quote),
      ...checkQuoteEcho(p, owner, response.raw),
      ...quoteSignatureProblems(response, quoteKey).map((text) => ({ text, code: 'simulation_failed' as const })),
    ];
    if (problems.length > 0) {
      throw new ReasonError(causeOf(problems), `live quote does not match the approved draft: ${problems.map((x) => x.text).join('; ')}`);
    }

    // For an INTENTS quote this is an account id inside the verifier, not a chain address,
    // and nothing is ever sent to it. It is the handle that ties the signed intent back to
    // this quote, so it is bounded and required but deliberately not address-validated.
    const depositAddress = quote.depositAddress;
    if (typeof depositAddress !== 'string' || depositAddress.trim() === '') {
      throw new Error(`the quote carries no deposit handle to attach an intent to (got ${oneLine(depositAddress, 60)})`);
    }
    const signedQuote = signedQuoteRecord(response);

    /* Read before, so the after-read below has something to subtract. A read that fails costs
       the check and nothing else: this is deliberately taken before anything is signed, so a
       verifier that will not answer refuses nothing and delays nothing.

       Taken alongside generate-intent rather than ahead of it. The two are independent: the
       read needs the owner and the destination asset, both known since plan(), and generate
       needs only the deposit handle. Both still land before the signature, which is the
       property the paragraph above is about. */
    const [beforeBase, generated] = await Promise.all([
      verifierBalance(owner.toLowerCase(), p.destinationAsset),
      client.generateIntent({ signerId: owner, depositAddress }),
    ]);

    // We asked for erc191 and we can only sign erc191. A different standard coming back is
    // never something to attempt: signing the wrong scheme releases a signature over bytes we
    // did not mean to authorise.
    if (generated.standard !== INTENTS_SIGNING_STANDARD) {
      throw new Error(
        `generate-intent returned a ${oneLine(generated.standard, 40)} payload, but this rail signs ` +
          `${INTENTS_SIGNING_STANDARD} only`,
      );
    }

    // The deadline cut to SIGNED_DEADLINE_MS, and then the whole payload checked, that cap included.
    const shortened = typeof generated.payload === 'string' ? shortenDeadline(generated.payload, now() + SIGNED_DEADLINE_MS) : generated.payload;
    const payloadProblems = checkIntentPayload(shortened, {
      signerId: owner,
      originAsset: p.originAsset,
      destinationAsset: p.destinationAsset,
      amountBase: p.amountBase,
      minOutBase: p.minOutBase,
      now: now(),
      maxDeadlineMs,
      depositAddress,
    });
    if (payloadProblems.length > 0) {
      throw new Error(`refusing to sign the intent 1click generated: ${payloadProblems.join('; ')}`);
    }

    // Signed as returned but for the deadline. The payload string is not re-serialised,
    // re-ordered or normalised anywhere above: the signature has to cover the same bytes the
    // verifier will parse, and a round trip through JSON.parse and JSON.stringify would not
    // guarantee that.
    const payload = shortened as string;
    const deadline = intentDeadline(payload) ?? 'unknown';
    const nonce = intentNonce(payload);
    const signature = await signer.signErc191(keysPath, payload);
    tell(hooks, { handle: depositAddress, deadline, ...(nonce === undefined ? {} : { nonce }), quote: signedQuote });

    // Nothing throws from here on, and the key is never used again for this move: the rule and
    // the one safe retry are described at the top of src/rails/intents-spend.ts. A submit that
    // does not answer is an intent that may be live at 1Click, and the executor has to hear
    // that as a fact about the money rather than as a rail that threw.
    const sent = await submitSignedIntent(client, { payload, signature });
    if (!sent.submitted) {
      return withQuote(describeUnconfirmedSubmit({ error: sent.error, handle: depositAddress, deadline }), signedQuote);
    }
    const submitted: SubmittedIntent = sent.intent;
    tell(hooks, { txids: [submitted.intentHash], handle: depositAddress, deadline, ...(nonce === undefined ? {} : { nonce }), quote: signedQuote });
    const evidence = `intent ${submitted.intentHash}, quote handle ${oneLine(depositAddress, 80)}`;

    const watch = await watchStatus(depositAddress, hooks);

    if (watch.status === 'SUCCESS') {
      /* SUCCESS from the venue is the venue's word. What arrived is a number this app can read,
         and until now it never did: the detail reported `quote.amountOutFormatted`, which is the
         solver's PROMISE, over a payload that is a transfer and names no output. So a swap that
         credited less than the approved floor, or nothing at all, was reported as a success at
         the promised size.

         READ UNTIL IT SHOWS, not once. 1Click says SUCCESS the instant the solver executes, and
         the verifier read asks NEAR at finality 'final', a block or two behind. One read taken
         right then saw the balance from before the swap, so a swap that had settled was
         reported as "rose by 0, below the floor, do not sign another". The loop stops at the
         first read that shows the floor; only the window running out is a decision. */
      const account = owner.toLowerCase();
      const settle =
        beforeBase === null
          ? { last: await verifierBalance(account, p.destinationAsset), rose: false, reads: 1, waitedMs: 0 }
          : await watchRise({
              read: () => verifierBalance(account, p.destinationAsset),
              rose: (after) => after - beforeBase >= p.minOutBase,
              schedule: settleSchedule,
              sleep,
              now,
            });
      const afterBase = settle.last;
      const txids = uniqueTxids(submitted.intentHash, watch);
      const railEvidence = { ...settledEvidence(watch, depositAddress), quote: signedQuote };
      const pocket =
        beforeBase === null
          ? undefined
          : {
              venue: 'intents' as const,
              account,
              assetId: p.destinationAsset,
              symbol: draft.toSymbol,
              decimals: p.destDecimals,
              before: beforeBase.toString(),
              after: afterBase === null ? null : afterBase.toString(),
              floor: p.minOutBase.toString(),
            };

      if (beforeBase !== null && afterBase !== null) {
        const delta = afterBase - beforeBase;
        if (delta <= 0n) {
          // Not shown inside the window. The venue's word stands, the balance has not caught up,
          // and the one thing that must not happen now is a second signature.
          return {
            ok: false,
            settling: true,
            detail:
              `${SETTLING_SENTENCE} Watched ${draft.toSymbol} for ${owner} inside ${INTENTS_VERIFIER} for ` +
              `${Math.round(settle.waitedMs / 1000)}s over ${settle.reads} reads; ${evidence}.`,
            txids,
            pocket,
            evidence: railEvidence,
          };
        }
        if (delta < p.minOutBase) {
          return {
            ok: false,
            reason: 'short_fill',
            detail:
              `1click reported SUCCESS, and the balance inside ${INTENTS_VERIFIER} rose by ` +
              `${formatUnits(delta, p.destDecimals)} ${draft.toSymbol}, below the ` +
              `${draft.minAmountOut} ${draft.toSymbol} floor this swap was approved with; ${evidence}. ` +
              `Read the balance for ${owner} before signing another.`,
            txids,
            pocket,
            evidence: railEvidence,
          };
        }
        return {
          ok: true,
          detail:
            `swapped ${amountInText(draft, p)} ${draft.fromSymbol} for ${formatUnits(delta, p.destDecimals)} ` +
            `${draft.toSymbol} inside ${INTENTS_VERIFIER}, read back from the verifier rather than taken ` +
            `from the quote; ${evidence}. Nothing was transferred on any chain and the proceeds are ` +
            `credited to ${owner} inside the verifier.`,
          txids,
          pocket,
          evidence: railEvidence,
        };
      }

      // The venue confirmed and this app could not read the balance. Still a success, and the
      // sentence says which half is measured and which half is the solver's word.
      return {
        ok: true,
        detail:
          `swapped ${amountInText(draft, p)} ${draft.fromSymbol} for a quoted ${oneLine(quote.amountOutFormatted, 40)} ` +
          `${draft.toSymbol} inside ${INTENTS_VERIFIER}; ${evidence}. The verifier balance could not be read ` +
          `back, so the amount out is the solver's figure rather than an observed one. Nothing was transferred ` +
          `on any chain and the proceeds are credited to ${owner} inside the verifier.`,
        txids,
        ...(pocket === undefined ? {} : { pocket }),
        evidence: railEvidence,
      };
    }

    const refundWords = {
      symbol: draft.fromSymbol,
      refundTarget: `${owner} inside ${INTENTS_VERIFIER}, not any chain address`,
      evidence,
      primaryTxid: submitted.intentHash,
    };

    // REFUNDED is 1Click's word that the input came back; the balance read against the one taken
    // before the signature shows whether it has.
    if (watch.status === 'REFUNDED') {
      const heldAfter = await verifierBalance(owner.toLowerCase(), p.originAsset);
      return withQuote(
        describeRefund(watch, depositAddress, refundWords, { before: heldBefore, after: heldAfter, amountBase: p.amountBase, decimals: p.originDecimals }),
        signedQuote,
      );
    }

    /* FAILED: THE INTENT'S OWN NONCE DECIDES, NEVER THE BALANCE. A balance that reads the same
       after proves nothing: a same-coin credit landing in the watch hides a transfer that ran, and
       a transfer that has not run can still run until its deadline (the audit of 2026-09-23).
       Spent is the input gone; unspent is a row that stays open and counted until the deadline,
       which reconcile then closes for real (src/proposals/reconcile.ts). */
    if (watch.status === 'FAILED') {
      const spent = nonce === undefined ? null : await nonceUsed(owner.toLowerCase(), nonce);
      return withQuote(describeRefund(watch, depositAddress, { ...refundWords, intent: { spent, until: deadline } }), signedQuote);
    }

    if (watch.status === 'INCOMPLETE_DEPOSIT') {
      return withQuote(describeIncompleteDeposit(watch, depositAddress, {
        symbol: draft.fromSymbol,
        quotedIn: oneLine(quote.amountInFormatted, 40),
        refundTarget: `${owner} inside ${INTENTS_VERIFIER}`,
        evidence,
        primaryTxid: submitted.intentHash,
      }), signedQuote);
    }

    // Timed out. The signature is already released and the intent already submitted, so the
    // balance may well move after this returns. Same rule as the oneclick rail: a poll
    // timeout is not a failed swap, and saying so is what stops someone signing a second one.
    // The hash and the handle stay on the row so the swap can be checked later.
    return {
      ok: false,
      reason: 'stuck_unknown',
      detail:
        `the intent was submitted but 1click did not reach a terminal status within ` +
        `${Math.round(pollTimeoutMs / 1000)}s (last status ${watch.reported}); ${evidence}. ` +
        `THE INTENT IS SIGNED AND SUBMITTED and the swap may still complete, so it is unconfirmed: check the balance ` +
        `inside ${INTENTS_VERIFIER} before signing another.`,
      txids: uniqueTxids(submitted.intentHash, watch),
      evidence: { handle: oneLine(depositAddress, 80), quote: signedQuote },
    };
  }

  // The one watch every rail shares (./watch.ts): until terminal or out of time, and never a
  // throw once the intent is submitted.
  function watchStatus(depositAddress: string, hooks?: RailHooks): Promise<OneClickStatus> {
    const plan = { firstMs: firstPollMs, everyMs: pollIntervalMs, timeoutMs: pollTimeoutMs, sleep, now };
    return watchOneClick(plan, (handle) => (api as IntentsApiPort).status(handle), depositAddress, hooks);
  }

  /* THE PRICE WITH NO FLOOR IN THE QUESTION: 1Click's dry quote for the draft's amountIn, read
     as the bought coin's units. Null when the router has no price. Nothing is signed here. */
  async function quote(draft: SwapDraft): Promise<number | null> {
    const p = await plan(draft, true);
    let response: Priced;
    try {
      response = await dryQuote(p, draft.from, false);
    } catch (err) {
      // Nobody selling is an answer, null. Any other refusal carries its cause to the builder.
      if (reasonOf(err) === 'no_price') return null;
      throw err;
    }
    const out = response.quote.amountOut;
    if (typeof out !== 'string' || !/^\d+$/.test(out)) return null;
    return Number(formatUnits(BigInt(out), p.destDecimals));
  }

  /* THE SAME DRY QUOTE AS FIELDS, for a read that files nothing: the exact amount it prices, what
     arrives, the floor the app would set under it and hold every later quote to, the fee and the
     time. A refusal throws with its cause. Nothing is signed. */
  async function facts(draft: SwapDraft): Promise<SwapQuoteFacts> {
    const p = await plan(draft, true);
    const q = (await dryQuote(p, draft.from, false)).quote;
    const out = baseUnits(q.amountOut, 'amountOut');
    const inUsd = Number(q.amountInUsd);
    const outUsd = Number(q.amountOutUsd);
    const floor = truncateToBaseUnits(floorUnderQuote(Number(formatUnits(out, p.destDecimals))), p.destDecimals);
    return {
      amountIn: baseUnitsToDecimal(p.amountBase, p.originDecimals),
      expectedOut: baseUnitsToDecimal(out, p.destDecimals),
      minOut: baseUnitsToDecimal(floor, p.destDecimals),
      feeUsd: Number.isFinite(inUsd) && Number.isFinite(outUsd) ? Math.round((inUsd - outUsd) * 10_000) / 10_000 : null,
      etaSeconds: Number.isFinite(Number(q.timeEstimate)) ? Number(q.timeEstimate) : null,
    };
  }

  return { kind: 'swap', valueUsd, simulate, quote, spend, facts, execute };
}
