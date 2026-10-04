// The payloads a chip vault signs, built here and read back here, and the exact events the
// verifier has to report for a bundle of them before anything is sent.
//
// One payload is {signer_id, verifying_contract, deadline, nonce, intents} in that key order. The
// nonce is V1 (src/relay/payload.ts) and its own deadline is the payload's. The intents are the four
// a vault uses, each with exactly the keys the Secure Enclave service's grammar reads:
// add_public_key and remove_public_key {intent, public_key}, set_auth_by_predecessor_id {intent,
// enabled}, and transfer {intent, receiver_id, tokens} with one token and no memo or msg. The
// grammar refuses add_public_key and set_auth_by_predecessor_id for the chip key; the old key and
// the paper key sign those, here in Node.
//
// The events are what simulate_intents reports for a bundle (src/relay/verifier.ts reads them),
// and a bundle is sent only when the reported list is this one exactly, payload by payload: a key
// event for each key intent, a transfer event for each transfer, the predecessor event only when
// the flag actually changes, then intents_executed naming every payload in order (near/intents at
// the deployed rev a2dd1408, read live on 2026-10-04).

import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hashMessage, hexToBytes } from 'viem';

import { base58Encode } from '../chain/near.ts';
import { oneLine } from '../intents.ts';
import { ERC191_STANDARD, duplicateJsonKey } from '../intents-sign.ts';
import { INTENTS_VERIFIER } from '../ledger/intents.ts';
import { intentsAccountProblem } from '../rails/intents-send.ts';
import { NONCE_RANDOM_BYTES, buildNonce, decodeNonce } from '../relay/payload.ts';
import { isVerifierPublicKey } from '../relay/verifier.ts';
import type { ExecutedEntry, VerifierEvent } from '../relay/verifier.ts';
import { WEBAUTHN_STANDARD, webauthnIntentHash } from './webauthn.ts';

export type VaultIntent =
  | { intent: 'add_public_key'; public_key: string }
  | { intent: 'remove_public_key'; public_key: string }
  | { intent: 'set_auth_by_predecessor_id'; enabled: boolean }
  | { intent: 'transfer'; receiver_id: string; tokens: Record<string, string> };

export type VaultPayload = {
  signer_id: string;
  verifying_contract: string;
  deadline: string;
  nonce: string;
  intents: VaultIntent[];
};

export type VaultPayloadInput = {
  signerId: string;
  intents: VaultIntent[];
  deadlineMs: number; // the chain's clock plus the life this signature gets
  salt: Uint8Array; // current_salt, read a moment before
  random?: (bytes: number) => Uint8Array; // the nonce's random bytes; node's crypto when absent
};

const PAYLOAD_KEYS = ['signer_id', 'verifying_contract', 'deadline', 'nonce', 'intents'];
const INTENT_KEYS: Record<VaultIntent['intent'], string[]> = {
  add_public_key: ['intent', 'public_key'],
  remove_public_key: ['intent', 'public_key'],
  set_auth_by_predecessor_id: ['intent', 'enabled'],
  transfer: ['intent', 'receiver_id', 'tokens'],
};
const U128_MAX = (1n << 128n) - 1n;
// An asset inside the verifier: a NEP-141, NEP-171 or NEP-245 token id, no space or quote in it.
const ASSET_ID = /^nep(?:141|171|245):[^\s"\\]+$/;

function sameKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

function accountOf(raw: unknown, what: string): string {
  if (typeof raw !== 'string') throw new Error(`the ${what} is not an account id`);
  const checked = intentsAccountProblem(raw);
  if (!checked.ok) throw new Error(`the ${what} is unusable: ${checked.problem}`);
  return checked.id;
}

/* One intent in the exact shape that is signed, or a throw naming what is wrong. The same check
   builds a payload and reads one back, so nothing is built that would not read back. Building
   lowercases a receiver; reading refuses one that is not lowercase already. */
function vaultIntentOf(raw: unknown, signerId: string, building: boolean): VaultIntent {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('an intent is an object');
  const o = raw as Record<string, unknown>;
  const kind = o.intent;
  if (typeof kind !== 'string' || !Object.hasOwn(INTENT_KEYS, kind)) throw new Error(`a vault signs no ${oneLine(kind, 40)} intent`);
  const keys = INTENT_KEYS[kind as VaultIntent['intent']];
  if (!sameKeys(o, keys)) throw new Error(`a ${kind} intent carries exactly ${keys.join(', ')}`);
  const { public_key: publicKey, enabled, receiver_id: receiverId, tokens } = o;
  if (kind === 'add_public_key' || kind === 'remove_public_key') {
    if (!isVerifierPublicKey(publicKey)) throw new Error(`the ${kind} key is not an ed25519, secp256k1 or p256 key`);
    return { intent: kind, public_key: publicKey };
  }
  if (kind === 'set_auth_by_predecessor_id') {
    if (typeof enabled !== 'boolean') throw new Error('set_auth_by_predecessor_id says enabled true or false');
    return { intent: kind, enabled };
  }
  const receiver = accountOf(receiverId, 'transfer receiver');
  if (!building && receiver !== receiverId) throw new Error('a transfer receiver is written lowercase, the way the verifier keys it');
  if (receiver === signerId) throw new Error('a transfer to the signing account moves nothing');
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('a transfer names its tokens as an object');
  const entries = Object.entries(tokens as Record<string, unknown>);
  if (entries.length !== 1) throw new Error(`a vault transfer moves one token, got ${entries.length}`);
  const [asset, amount] = entries[0];
  if (!ASSET_ID.test(asset)) throw new Error(`${oneLine(asset, 80)} is not a token id inside the verifier`);
  if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount) || BigInt(amount) > U128_MAX) {
    throw new Error('a transfer amount is base units in digits, 1 or more, no leading zero, at most u128');
  }
  return { intent: 'transfer', receiver_id: receiver, tokens: { [asset]: amount } };
}

/* The string that is signed and sent, serialised once, keys in the fixed order, every account id
   lowercase the way the verifier keys it. Throws rather than build anything readVaultPayload
   would refuse. */
export function buildVaultPayload(input: VaultPayloadInput): string {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0) throw new Error('a payload deadline is a time in whole milliseconds');
  const signer = accountOf(input.signerId, 'signer');
  const intents = input.intents.map((intent) => vaultIntentOf(intent, signer, true));
  const random = input.random ?? ((bytes: number) => Uint8Array.from(randomBytes(bytes)));
  return JSON.stringify({
    signer_id: signer,
    verifying_contract: INTENTS_VERIFIER,
    deadline: new Date(input.deadlineMs).toISOString(),
    nonce: buildNonce({ salt: input.salt, deadlineMs: input.deadlineMs, random: random(NONCE_RANDOM_BYTES) }),
    intents,
  });
}

/* A payload as the verifier will read it, or a throw naming the first thing that is not a vault
   payload: a duplicated key, another key set, another contract, a deadline that is not a time, a
   nonce that is not V1 or whose deadline is not the payload's, an intent a vault does not sign. */
export function readVaultPayload(raw: unknown): VaultPayload {
  if (typeof raw !== 'string' || raw === '') throw new Error('the payload is not a JSON string');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('the payload is not JSON');
  }
  const duplicate = duplicateJsonKey(raw);
  if (duplicate !== null) throw new Error(`the payload names ${oneLine(duplicate, 40)} twice`);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('the payload is not an object');
  const o = body as Record<string, unknown>;
  if (!sameKeys(o, PAYLOAD_KEYS)) throw new Error(`the payload carries exactly ${PAYLOAD_KEYS.join(', ')}`);
  if (o.verifying_contract !== INTENTS_VERIFIER) throw new Error(`the payload is for ${oneLine(o.verifying_contract, 60)}, not ${INTENTS_VERIFIER}`);
  const signer = accountOf(o.signer_id, 'signer');
  if (signer !== o.signer_id) throw new Error('the signer is written lowercase, the way the verifier keys it');
  const { deadline, nonce, intents } = o;
  const deadlineMs = typeof deadline === 'string' ? Date.parse(deadline) : Number.NaN;
  if (typeof deadline !== 'string' || !Number.isFinite(deadlineMs)) throw new Error('the payload deadline is not a time');
  const parts = decodeNonce(nonce);
  if (parts === null || typeof nonce !== 'string') throw new Error('the nonce is not a V1 nonce');
  if (parts.deadlineMs !== deadlineMs) throw new Error("the nonce's deadline is not the payload's");
  if (!Array.isArray(intents)) throw new Error('the intents are not a list');
  return { signer_id: signer, verifying_contract: INTENTS_VERIFIER, deadline, nonce, intents: intents.map((intent) => vaultIntentOf(intent, signer, false)) };
}

/* What the verifier names a signed payload by, the hash intents_executed carries: base58 of
   sha256(payload) for webauthn, base58 of the EIP-191 message hash for erc191. */
export function signedIntentHash(signed: { standard: string; payload: string }): string {
  if (signed.standard === WEBAUTHN_STANDARD) return webauthnIntentHash(signed.payload);
  if (signed.standard === ERC191_STANDARD) return base58Encode(hexToBytes(hashMessage(signed.payload)));
  throw new Error(`a vault signs in webauthn or erc191, not ${oneLine(signed.standard, 40)}`);
}

/* `before` is what was read before the bundle was signed. predecessorAuth is
   is_auth_by_predecessor_id_enabled for the signing account: the verifier reports a
   set_auth_by_predecessor_id only when the flag changes (a second `enabled: false` reports
   nothing), so it is needed whenever the bundle sets the flag. */
export type BundleBefore = { predecessorAuth?: boolean };

/* The events simulate_intents must report for this bundle, in order. One bundle signs for one
   account. Throws on a payload this module would not have built, and on a bundle that sets the
   predecessor flag when `before` does not say what it read. */
export function expectedEvents(bundle: readonly { standard: string; payload: string }[], before: BundleBefore): VerifierEvent[] {
  if (bundle.length === 0) throw new Error('a bundle carries at least one payload');
  const events: VerifierEvent[] = [];
  const executed: ExecutedEntry[] = [];
  let account: string | null = null;
  let flag = before.predecessorAuth;
  for (const signed of bundle) {
    const body = readVaultPayload(signed.payload);
    if (account !== null && body.signer_id !== account) throw new Error('one bundle signs for one account');
    account = body.signer_id;
    const intent_hash = signedIntentHash(signed);
    const account_id = body.signer_id;
    for (const intent of body.intents) {
      if (intent.intent === 'add_public_key') events.push({ event: 'public_key_added', data: { intent_hash, account_id, public_key: intent.public_key } });
      else if (intent.intent === 'remove_public_key') events.push({ event: 'public_key_removed', data: { intent_hash, account_id, public_key: intent.public_key } });
      else if (intent.intent === 'set_auth_by_predecessor_id') {
        if (typeof flag !== 'boolean') throw new Error('read is_auth_by_predecessor_id_enabled before a bundle that sets it');
        if (intent.enabled !== flag) events.push({ event: 'set_auth_by_predecessor_id', data: { intent_hash, account_id, enabled: intent.enabled } });
        flag = intent.enabled;
      } else events.push({ event: 'transfer', data: [{ intent_hash, account_id, receiver_id: intent.receiver_id, tokens: { ...intent.tokens } }] });
    }
    executed.push({ intent_hash, account_id, nonce: body.nonce });
  }
  events.push({ event: 'intents_executed', data: executed });
  return events;
}

// An id or key cut to its ends, a key's curve kept whole.
function short(id: string): string {
  const colon = id.indexOf(':');
  if (colon > 0) return `${id.slice(0, colon + 1)}${short(id.slice(colon + 1))}`;
  return id.length > 20 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
}

function eventWords(e: VerifierEvent): string {
  switch (e.event) {
    case 'public_key_added':
    case 'public_key_removed':
      return `${e.event} ${short(e.data.public_key)} on ${short(e.data.account_id)} for intent ${short(e.data.intent_hash)}`;
    case 'set_auth_by_predecessor_id':
      return `${e.event} enabled ${e.data.enabled} on ${short(e.data.account_id)} for intent ${short(e.data.intent_hash)}`;
    case 'transfer':
      return `transfer of ${e.data.map((t) => `${Object.entries(t.tokens).map(([a, n]) => `${n} ${short(a)}`).join(' and ')} to ${short(t.receiver_id)}`).join(', ')}`;
    case 'intents_executed':
      return `intents_executed naming ${e.data.length} payloads`;
    default:
      return `a log line no vault bundle makes: ${oneLine(e.line, 120)}`;
  }
}

/* Null when the verifier reported exactly the expected events, else the first difference in
   words. `actual` undefined means the answer carried no events at all, which is never right. */
export function eventsMismatch(actual: readonly VerifierEvent[] | undefined, expected: readonly VerifierEvent[]): string | null {
  if (actual === undefined) return 'the simulation reported no events';
  for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
    const got = actual[i];
    const want = expected[i];
    if (got === undefined) return `the simulation reported ${actual.length} events where ${expected.length} were expected; missing: ${eventWords(want)}`;
    if (want === undefined) return `the simulation reported ${actual.length} events where ${expected.length} were expected; extra: ${eventWords(got)}`;
    if (!isDeepStrictEqual(got, want)) return `event ${i + 1} is ${eventWords(got)} where ${eventWords(want)} was expected`;
  }
  return null;
}
