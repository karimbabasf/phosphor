// ALLOWANCE and GAS: two keys the wallet derives from its owner key and never stores.
//
// Phase 2 moves the vault onto this Mac's Touch ID key and leaves two small keys for the session:
// ALLOWANCE, a 0x account the agent spends from with no click up to its size, and GAS, a NEAR
// implicit account that pays for the vault's execute_intents calls (about 0.5 NEAR). Both come
// from OLD, the wallet's EVM key, at every open, are held as bytes beside it, and are zeroed by
// the same lock. Derived rather than made and kept, the lead's call 7: a new key in the wallet
// file is a payload rewrite (audit1b AU1B-04), a bound file cannot be committed again once its
// key is ten minutes old, and the key backup a person already holds brings both back.
//
// THE COST, said where the keys are made: whoever holds OLD, or its backup, also holds ALLOWANCE
// (at most its size plus 10 %, $110 at the default) and GAS (about 0.5 NEAR). So the key backup
// is kept like cash.
//
// HKDF-SHA256 (RFC 5869) over OLD's 32 bytes, salt "phosphor", one info string per key:
//   ALLOWANCE  info "phosphor-allowance-v1", 32 bytes read big-endian as a secp256k1 scalar. While
//              that is 0 or not below the group order n, the info takes "/1", then "/2", and so on
//              (about once in 2^128 OLD keys).
//   GAS        info "phosphor-gas-v1", 32 bytes: an ed25519 seed, which any 32 bytes are. Its
//              account is NEAR's implicit one, the 64 hex characters of its public key.
//   HL-AGENT   info "phosphor/hl-agent/v<n>", redrawn like ALLOWANCE: the Hyperliquid trading key
//              (an API wallet) of a vault on Touch ID, for the counter n that vault.json keeps
//              (src/hl/agent-key.ts). The lead's call on p2-owner's open item 3: OLD owns the
//              Hyperliquid account already, so a trading key made from it adds no reach, and a new n
//              is a new key, never one the venue approved before. Made at the open with the other two.
// No other key in the app comes out of HKDF under this salt (the enclave wrap's is
// "phosphor-vault", src/keystore/sewrap.ts), and a later scheme takes a new version in its info.
// The vectors in tests/unit/keystore-derived.test.ts, also in docs/security-model.md, let any
// other implementation check itself: a person rebuilding these keys by hand must reach the same
// two accounts. The trading key's are in tests/fixtures/hl-agent-keys.ts and docs/trading.md.

import crypto from 'node:crypto';
import { toHex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

import { wipe } from './envelope.ts';

export const DERIVE_SALT = 'phosphor';
export const ALLOWANCE_INFO = 'phosphor-allowance-v1';
export const GAS_INFO = 'phosphor-gas-v1';
// The trading key's info is this and its version: "phosphor/hl-agent/v1", "phosphor/hl-agent/v2".
export const HL_AGENT_INFO = 'phosphor/hl-agent/v';
// A counter, not a secret; the ceiling only keeps a hand-edited vault.json from naming nonsense.
export const MAX_HL_AGENT_VERSION = 2 ** 31 - 1;

// The order of the secp256k1 group (SEC 2).
const SECP256K1_N = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');
// RFC 8410's PKCS #8 header for an ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
// Each redraw has odds of about 2^-128; reaching this many means HKDF itself is broken.
const MAX_REDRAWS = 255;

export type DerivedKeys = { allowance: Buffer; gas: Buffer };
// What the two keys sign for: ALLOWANCE's 0x address (EIP-55) and GAS's implicit account id.
export type DerivedAccounts = { allowance: `0x${string}`; gas: string };

function isScalar(k: Uint8Array): boolean {
  return k.length === 32 && Buffer.compare(k, SECP256K1_N) < 0 && k.some((b) => b !== 0);
}

function checkOwner(old: Buffer): void {
  if (!Buffer.isBuffer(old) || !isScalar(old)) throw new Error('the owner key is not a valid secp256k1 private key');
}

function hkdf(old: Buffer, info: string): Buffer {
  // Buffer.from over the ArrayBuffer shares its memory, so a wipe of the Buffer reaches the bytes.
  return Buffer.from(crypto.hkdfSync('sha256', old, DERIVE_SALT, info, 32));
}

/* The first draw that is a secp256k1 scalar, for `base`, then `base/1`, `base/2` and on. Every draw
   it refuses is wiped. Exported so the redraw rule can be tested: no known OLD reaches it. */
export function firstScalar(draw: (info: string) => Buffer, base: string): Buffer {
  for (let i = 0; i <= MAX_REDRAWS; i += 1) {
    const key = draw(i === 0 ? base : `${base}/${i}`);
    if (isScalar(key)) return key;
    wipe(key);
  }
  throw new Error(`no secp256k1 scalar in ${MAX_REDRAWS + 1} draws for ${base}`);
}

export function deriveAllowanceKey(old: Buffer): Buffer {
  checkOwner(old);
  return firstScalar((info) => hkdf(old, info), ALLOWANCE_INFO);
}

export function deriveGasSeed(old: Buffer): Buffer {
  checkOwner(old);
  return hkdf(old, GAS_INFO);
}

export function isHlAgentVersion(version: unknown): version is number {
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 1 && version <= MAX_HL_AGENT_VERSION;
}

export function deriveHlAgentKey(old: Buffer, version: number): Buffer {
  checkOwner(old);
  if (!isHlAgentVersion(version)) throw new Error(`a trading key version is a whole number from 1 to ${MAX_HL_AGENT_VERSION}`);
  return firstScalar((info) => hkdf(old, info), `${HL_AGENT_INFO}${version}`);
}

/* The 0x address of a secp256k1 key, EIP-55 cased. Through OpenSSL's ECDH rather than viem, so the
   key stays a Buffer the whole way and never becomes a hex string, which nothing can wipe. */
export function evmAddressOf(key: Buffer): `0x${string}` {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(key);
  return publicKeyToAddress(toHex(ecdh.getPublicKey()));
}

export function ed25519PublicKey(seed: Buffer): Buffer {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('an ed25519 seed is 32 bytes');
  const der = Buffer.concat([ED25519_PKCS8, seed]);
  try {
    const jwk = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }) as { x?: string };
    const pub = Buffer.from(jwk.x ?? '', 'base64url');
    if (pub.length !== 32) throw new Error('the ed25519 public key did not come back as 32 bytes');
    return pub;
  } finally {
    wipe(der);
  }
}

export function gasAccountOf(seed: Buffer): string {
  return ed25519PublicKey(seed).toString('hex');
}

export function deriveKeys(old: Buffer): DerivedKeys {
  const allowance = deriveAllowanceKey(old);
  try {
    return { allowance, gas: deriveGasSeed(old) };
  } catch (err) {
    wipe(allowance);
    throw err;
  }
}

export function accountsOf(keys: DerivedKeys): DerivedAccounts {
  return { allowance: evmAddressOf(keys.allowance), gas: gasAccountOf(keys.gas) };
}
