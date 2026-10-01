// The intents an invite key signs: one `transfer` per receiver out of one account inside
// intents.near, built here, read back here as a stranger would, and handed to the solver relay
// with no quote. The app's claim signs one transfer; the operator script (fund a batch, reclaim,
// withdraw) signs up to ten in one payload with the treasury's key. Spec:
// docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The money path" and "The claim".
//
// WHY A TRANSFER AND NOT A TOKEN_DIFF. A transfer names its receiver inside the signed bytes, so
// the relay can only submit what was signed or nothing: nobody between this app and the verifier
// can point the money anywhere else. It charges no protocol fee in the contract's code (only
// token_diff does), so a $5 code lands as exactly 5.000000 USDC. No `memo` and no `msg`: a `msg`
// makes the verifier call mt_on_transfer on the receiver, and a plain account has nothing to
// answer it with.
//
// THE CLOCK IS THE CHAIN'S. The deadline is the final block's time plus two minutes, never this
// Mac's clock, so a Mac running slow cannot fail every claim with "deadline has expired". The
// nonce is the verifier's versioned V1 shape (src/relay/payload.ts) and lives seven days past the
// deadline, so a reconcile after a crash can still ask whether it was spent.

import { hashMessage, hexToBytes } from 'viem';

import { base58Encode } from '../chain/near.ts';
import { oneLine } from '../intents.ts';
import { ERC191_STANDARD, duplicateJsonKey } from '../intents-sign.ts';
import { INTENTS_VERIFIER } from '../ledger/intents.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS, publishOnce } from '../rails/intents-relay.ts';
import { intentsAccountProblem } from '../rails/intents-send.ts';
import type { RelayClient } from '../relay/client.ts';
import { NONCE_RANDOM_BYTES, buildNonce, decodeNonce } from '../relay/payload.ts';

// Native USDC on NEAR, the one asset an invite holds: the same id the HyperCore withdraw rail
// names INTENTS_USDC_ASSET_ID (a test holds the two to each other).
export const INVITE_ASSET_ID = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const INVITE_ASSET_SYMBOL = 'USDC';
export const INVITE_ASSET_DECIMALS = 6;

// How long a signed claim stays valid on the chain's clock: two minutes, the relay rail's cap.
export const CLAIM_DEADLINE_MS = 120_000;
// The most transfers one payload carries. One issue batch is at most ten codes.
export const MAX_TRANSFERS = 10;

export type TransferLeg = { receiverId: string; amountBase: bigint };

export type TransfersInput = {
  signerId: string; // the signing account: a code's address, or the treasury's
  assetId: string;
  deadline: string; // ISO, from signingDeadline
  nonce: string; // base64 V1, from claimNonce
  transfers: TransferLeg[];
};

/* The deadline and the nonce for a payload signed now, read off the chain's final block time:
   the intent deadline two minutes out, and the nonce's own deadline seven days past that. */
export function signingDeadline(chainMs: number, lifeMs: number = CLAIM_DEADLINE_MS): string {
  if (!Number.isFinite(chainMs) || chainMs <= 0) throw new Error('a signing deadline needs the chain time');
  return new Date(Math.floor(chainMs) + lifeMs).toISOString();
}

export function claimNonce(salt: Uint8Array, deadline: string, random: (bytes: number) => Uint8Array): string {
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) throw new Error('a nonce needs the intent deadline');
  return buildNonce({ salt, deadlineMs: deadlineMs + NONCE_LIFE_AFTER_DEADLINE_MS, random: random(NONCE_RANDOM_BYTES) });
}

function receiverOf(raw: string): string {
  const checked = intentsAccountProblem(raw);
  if (!checked.ok) throw new Error(`a transfer receiver is unusable: ${checked.problem}`);
  return checked.id;
}

/* The string that is signed and sent, serialised once, keys in a fixed order, every account id
   lowercase the way the verifier keys it. Throws rather than builds anything this module would
   refuse to sign. */
export function buildTransfersPayload(input: TransfersInput): string {
  if (input.transfers.length === 0) throw new Error('a payload with no transfer moves nothing');
  if (input.transfers.length > MAX_TRANSFERS) throw new Error(`one payload carries at most ${MAX_TRANSFERS} transfers, got ${input.transfers.length}`);
  const signer = receiverOf(input.signerId);
  const intents = input.transfers.map((t) => {
    if (t.amountBase <= 0n) throw new Error('a transfer moves a positive amount');
    const receiver = receiverOf(t.receiverId);
    if (receiver === signer) throw new Error('a transfer to the signing account moves nothing');
    return { intent: 'transfer', receiver_id: receiver, tokens: { [input.assetId]: t.amountBase.toString() } };
  });
  return JSON.stringify({
    signer_id: signer,
    verifying_contract: INTENTS_VERIFIER,
    deadline: input.deadline,
    nonce: input.nonce,
    intents,
  });
}

export type TransfersExpectation = {
  signerId: string;
  assetId: string;
  transfers: TransferLeg[];
  salt: Uint8Array; // the salt current_salt answered a moment before the nonce was built
  now: number; // the chain's time, the final block's, never this Mac's clock
  maxDeadlineMs: number;
};

const PAYLOAD_KEYS = ['signer_id', 'verifying_contract', 'deadline', 'nonce', 'intents'];
const TRANSFER_KEYS = ['intent', 'receiver_id', 'tokens'];

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* The payload as the verifier will read it, checked against what the caller meant, with no
   access to how it was built. Returns the first problem, or nothing. One refusal per way the
   string could say something else: another contract, another signer, a nonce the verifier would
   refuse or that dies before the intent, a deadline already passed or too far out, a transfer to
   anyone not named, a different amount, a memo or a msg. */
export function checkTransfersPayload(raw: unknown, expect: TransfersExpectation): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return ['the payload is not a JSON string'];
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ['the payload is not a JSON object'];
    body = parsed as Record<string, unknown>;
  } catch {
    return ['the payload is not valid JSON'];
  }
  const twice = duplicateJsonKey(raw);
  if (twice !== null) return [`the payload names ${oneLine(twice, 40)} twice in one object, so it can be read two ways`];
  const stray = Object.keys(body).filter((k) => !PAYLOAD_KEYS.includes(k));
  if (stray.length > 0) return [`the payload carries ${stray.map((k) => oneLine(k, 30)).join(', ')}, which this app never writes`];
  if (body['verifying_contract'] !== INTENTS_VERIFIER) return [`the payload names ${oneLine(body['verifying_contract'], 60)} as the verifying contract`];

  const signer = expect.signerId.toLowerCase();
  if (body['signer_id'] !== signer) return [`the payload is authored for ${oneLine(body['signer_id'], 60)}, not ${signer}`];

  const nonce = decodeNonce(body['nonce']);
  if (nonce === null) return ['the payload carries no 32-byte versioned nonce'];
  if (!sameBytes(nonce.salt, expect.salt)) return ['the nonce does not carry the salt read from the verifier'];

  const deadline = typeof body['deadline'] === 'string' ? Date.parse(body['deadline']) : Number.NaN;
  if (!Number.isFinite(deadline)) return ['the payload deadline is not a timestamp'];
  if (deadline <= expect.now) return ['the payload deadline has already passed on the chain clock'];
  if (deadline - expect.now > expect.maxDeadlineMs) return [`the payload deadline is more than ${Math.round(expect.maxDeadlineMs / 1000)} s out`];
  if (nonce.deadlineMs < deadline + NONCE_LIFE_AFTER_DEADLINE_MS) return ['the nonce does not live seven days past the intent deadline'];

  const intents = body['intents'];
  if (!Array.isArray(intents) || intents.length !== expect.transfers.length) {
    return [`the payload carries ${Array.isArray(intents) ? intents.length : 'no list of'} intents, not the ${expect.transfers.length} transfers meant`];
  }
  for (let i = 0; i < intents.length; i += 1) {
    const action = intents[i] as Record<string, unknown> | null;
    const want = expect.transfers[i]!;
    if (action === null || typeof action !== 'object' || Array.isArray(action) || action['intent'] !== 'transfer') {
      return [`intent ${i + 1} is not a transfer`];
    }
    const extra = Object.keys(action).filter((k) => !TRANSFER_KEYS.includes(k));
    if (extra.length > 0) return [`transfer ${i + 1} carries ${extra.map((k) => oneLine(k, 30)).join(', ')}, which this app never writes`];
    const receiver = action['receiver_id'];
    if (typeof receiver !== 'string' || receiver !== want.receiverId.toLowerCase()) return [`transfer ${i + 1} pays ${oneLine(receiver, 60)}, not the account meant`];
    if (receiver === signer) return [`transfer ${i + 1} pays the signing account itself`];
    const tokens = action['tokens'];
    if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return [`transfer ${i + 1} carries no tokens object`];
    const ids = Object.keys(tokens);
    if (ids.length !== 1 || ids[0] !== expect.assetId) return [`transfer ${i + 1} does not move exactly ${expect.assetId}`];
    const amount = (tokens as Record<string, unknown>)[expect.assetId];
    if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount) || BigInt(amount) !== want.amountBase) {
      return [`transfer ${i + 1} moves ${oneLine(amount, 40)} base units, not ${want.amountBase.toString()}`];
    }
  }
  return [];
}

// What the verifier and the relay call an erc191 intent: base58 of its EIP-191 message hash.
// Matched live against simulate_intents' intents_executed on 2026-10-01.
export function intentHashOf(payload: string): string {
  return base58Encode(hexToBytes(hashMessage(payload)));
}

/* A signed payload handed to the solver relay with an empty quote_hashes, the way the official
   SDK sends every intent that is not a swap: the relay executes it as intents.near, so nobody
   here pays gas. The one retry is the relay rail's: the identical bytes, once, and only when the
   first call got no reply at all. Never a second signature. */
export function publishWithoutQuote(relay: RelayClient, signed: { payload: string; signature: string }) {
  return publishOnce(relay, { quoteHashes: [], standard: ERC191_STANDARD, payload: signed.payload, signature: signed.signature });
}

/* What a simulate_intents refusal means for a payload signed by an invite key, from the
   contract's own words (src/relay/verifier.ts simulationRefusal). */
export type SimulationVerdict = 'empty' | 'locked' | 'expired' | 'refused';

export function simulationVerdict(refusal: string): SimulationVerdict {
  if (/insufficient balance|overflow/i.test(refusal)) return 'empty';
  if (/\block(ed)?\b/i.test(refusal)) return 'locked';
  if (/deadline/i.test(refusal)) return 'expired';
  return 'refused';
}

export const SIMULATION_SENTENCES: Record<SimulationVerdict, string> = {
  empty: 'The account holds less than the signed amount now: it was used, or reclaimed, a moment ago.',
  locked: 'NEAR Intents has locked this account, so nothing can be signed out of it.',
  expired: 'The signed intent would reach the verifier after its deadline.',
  refused: 'The verifier refused the signed intent.',
};

// Base units as the dollars a person reads: two places, rounded down so a figure never says
// more than is there.
export function formatUsdc(base: bigint): string {
  const cents = base / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
