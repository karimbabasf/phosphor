// The WebAuthn wrapper a chip vault payload is signed in, as the verifier reads it (intents.near
// 0.4.4, standard "webauthn" on curve P-256). The Secure Enclave service builds these same bytes in
// Swift and signs them behind Touch ID. This is the Node side: the fixed authenticator data, the
// client data template, the bytes an ES256 signature covers, the low-S rule, and the check every
// signed answer passes before it goes into a bundle.
//
// Read live on 0.4.4 with signatures from a real Secure Enclave key (2026-10-04):
// - authenticator_data is sha256("phosphor.money") || flags 0x05 || sign count 0, sent as
//   base64url with no padding. User present is the gate: flags 0x00 and 0x04 were refused. The
//   verifier never compares the rpId hash, and it needs an origin it never compares.
// - client_data_json is exactly {"type":"webauthn.get","challenge":"<base64url sha256(payload)>",
//   "origin":"https://phosphor.money"}, in that key order and with no spaces.
// - The signature is ES256 over authenticator_data || sha256(client_data_json), sent as r || s,
//   32 + 32 bytes big-endian, with S at most n / 2: a high S is refused as "invalid signature", and
//   25 of 61 enclave signatures came back high.
// - public_key and signature are "p256:" + base58 of 64 bytes: x || y, and r || s.

import crypto from 'node:crypto';

import { base58Decode, base58Encode } from '../chain/near.ts';

export const WEBAUTHN_STANDARD = 'webauthn';
export const WEBAUTHN_ORIGIN = 'https://phosphor.money';
const RP_ID = 'phosphor.money';
// User present (0x01) and user verified (0x04).
const FLAGS = 0x05;

// The order n of the P-256 group, a curve constant published in SEC 2.
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = P256_N >> 1n;

function sha256(data: string | Uint8Array): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

export const AUTHENTICATOR_DATA_BYTES = Uint8Array.from(Buffer.concat([sha256(RP_ID), Buffer.from([FLAGS, 0, 0, 0, 0])]));
export const AUTHENTICATOR_DATA = Buffer.from(AUTHENTICATOR_DATA_BYTES).toString('base64url');

export function clientDataJson(payload: string): string {
  return JSON.stringify({ type: 'webauthn.get', challenge: sha256(payload).toString('base64url'), origin: WEBAUTHN_ORIGIN });
}

// The bytes an ES256 signature covers. ES256 hashes them once more inside, the same as the
// enclave's X9.62 SHA-256 mode.
export function webauthnMessage(payload: string): Uint8Array {
  return Uint8Array.from(Buffer.concat([AUTHENTICATOR_DATA_BYTES, sha256(clientDataJson(payload))]));
}

// What the verifier names a webauthn payload by: base58 of sha256 of the payload string.
export function webauthnIntentHash(payload: string): string {
  return base58Encode(sha256(payload));
}

function bigOf(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
}

/* r || s with S folded into the low half of the group, the one form the verifier accepts. Throws
   on anything that is not 64 bytes with r and s between 1 and n - 1. */
export function lowS(rs: Uint8Array): Uint8Array {
  if (rs.length !== 64) throw new Error(`a P-256 signature is 64 bytes of r || s, got ${rs.length}`);
  const r = bigOf(rs.subarray(0, 32));
  const s = bigOf(rs.subarray(32));
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) throw new Error('a P-256 signature has r and s between 1 and n - 1');
  const out = Uint8Array.from(rs);
  if (s > HALF_N) out.set(Buffer.from((P256_N - s).toString(16).padStart(64, '0'), 'hex'), 32);
  return out;
}

export type WebauthnSigned = {
  standard: typeof WEBAUTHN_STANDARD;
  payload: string;
  public_key: string;
  signature: string;
  client_data_json: string;
  authenticator_data: string;
};

/* The signed answer for a payload, built from the raw key (x || y) and signature (r || s): the
   shape the service answers with, which a software P-256 key stands in for in tests and in the
   live check. S is folded low here. */
export function webauthnSigned(payload: string, publicKey: Uint8Array, signature: Uint8Array): WebauthnSigned {
  if (publicKey.length !== 64) throw new Error(`a P-256 public key is 64 bytes of x || y, got ${publicKey.length}`);
  return {
    standard: WEBAUTHN_STANDARD,
    payload,
    public_key: `p256:${base58Encode(publicKey)}`,
    signature: `p256:${base58Encode(lowS(signature))}`,
    client_data_json: clientDataJson(payload),
    authenticator_data: AUTHENTICATOR_DATA,
  };
}

const SIGNED_KEYS = ['standard', 'payload', 'public_key', 'signature', 'client_data_json', 'authenticator_data'];

// "p256:" and base58 of exactly 64 bytes, in the one spelling that encodes back to itself.
function p256Bytes(value: string, what: string): Uint8Array {
  if (!value.startsWith('p256:')) throw new Error(`the ${what} is not a p256 value`);
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(value.slice(5));
  } catch {
    throw new Error(`the ${what} is not base58`);
  }
  if (bytes.length !== 64 || `p256:${base58Encode(bytes)}` !== value) throw new Error(`the ${what} is not 64 bytes`);
  return bytes;
}

/* One signed answer as the multi-payload the verifier takes, after every check that can be made
   without the chain: the exact field set, the standard, this app's authenticator data, the client
   data template for this very payload, a key that is a P-256 point, a low S, and a signature that
   verifies. Throws, naming the first thing wrong. It does not know which key should have signed or
   which payload was asked for: the chip signer that asked holds the answer to both. */
export function webauthnMultiPayload(signed: unknown): WebauthnSigned {
  if (signed === null || typeof signed !== 'object' || Array.isArray(signed)) throw new Error('the signed answer is not an object');
  const o = signed as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== SIGNED_KEYS.length || !SIGNED_KEYS.every((k) => keys.includes(k))) {
    throw new Error(`the signed answer carries ${[...keys].sort().join(', ')}, not exactly ${SIGNED_KEYS.join(', ')}`);
  }
  const { standard, payload, public_key, signature, client_data_json, authenticator_data } = o;
  if (typeof payload !== 'string' || typeof public_key !== 'string' || typeof signature !== 'string' || typeof client_data_json !== 'string' || typeof authenticator_data !== 'string') {
    throw new Error('every field of the signed answer is a string');
  }
  if (standard !== WEBAUTHN_STANDARD) throw new Error('the signed answer is not webauthn');
  if (authenticator_data !== AUTHENTICATOR_DATA) throw new Error("the authenticator data is not this app's (phosphor.money, user present)");
  if (client_data_json !== clientDataJson(payload)) throw new Error('the client data is not the template for this payload');
  const xy = p256Bytes(public_key, 'public key');
  const rs = p256Bytes(signature, 'signature');
  const s = bigOf(rs.subarray(32));
  const r = bigOf(rs.subarray(0, 32));
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) throw new Error('the signature has r or s out of range');
  if (s > HALF_N) throw new Error('the signature has a high S, which the verifier refuses');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: Buffer.from(xy.subarray(0, 32)).toString('base64url'), y: Buffer.from(xy.subarray(32)).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    throw new Error('the public key is not a point on P-256');
  }
  if (!crypto.verify('sha256', webauthnMessage(payload), { key, dsaEncoding: 'ieee-p1363' }, rs)) {
    throw new Error('the signature does not verify for this payload and key');
  }
  return { standard: WEBAUTHN_STANDARD, payload, public_key, signature, client_data_json, authenticator_data };
}
