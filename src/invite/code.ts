// An invite code: 128 random bits, written so a person can type it back, and the one secp256k1
// key it turns into. Spec: docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The code".
//
// The key's address is an account inside intents.near that the operator funds. Whoever holds
// the code holds the key, so the code is a bearer secret: the address is public the moment it is
// funded, and anyone can guess codes offline against it with no rate limit. 128 bits from the
// OS CSPRNG is what makes that search hopeless; nothing here ever reads Math.random.
//
// THE FORMAT. `PHOS` plus 27 Crockford base32 characters: 26 carry the secret (130 bits, the top
// two zero, so the first is always 0 to 7) and the last is Crockford's mod 37 check symbol. Mod 37
// catches every single wrong character and every swap of two neighbours before anything leaves
// this machine, which is the difference between "That code has a typo" and a network read of an
// empty account. The generator redraws until the check symbol is one of the 32 letters and digits,
// so a code never carries `* ~ $ = U`, and until the 26 secret characters hold at least two
// digits, which is what lets the composer tell a code from a sentence (below).
//
// TWO MATCHERS. The shape found inside any text is what the log tail redacts: right after the
// prefix a separator or five data characters in a row, so the word "Phosphor" and a sentence are
// not one, and over-redacting is fine there. The composer guard (looksLikeInviteCode) adds one rule
// every issued code meets and prose almost never does: at least two literal digits in the match.
// "phosphorus is used in fertilizer and in matches" has the shape and no digit. CONTRACTS.md,
// "Code shape", pins both.

import crypto from 'node:crypto';

import { keccak256 } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const INVITE_PREFIX = 'PHOS';
export const INVITE_LINK_BASE = 'https://phosphor.money/invite#';
// Separates this key from every other use of the same bytes.
export const INVITE_KEY_TAG = 'phosphor-invite-v1';
export const SECRET_BYTES = 16;
// 26 characters carry the secret, the 27th is the check symbol.
export const DATA_CHARS = 26;
export const CODE_CHARS = DATA_CHARS + 1;

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// Crockford's check alphabet: the 32 above, then the five symbols only a check can carry.
const CHECK_ALPHABET = CROCKFORD + '*~$=U';

/* The secp256k1 group order. A key is a scalar strictly between 0 and this. Written as 2^256 less
   its published complement, because the order spelled out is a 64 hex run, the shape the secret
   sweep (scripts/sweep.ts) rightly stops on. */
export const SECP256K1_N = (1n << 256n) - 0x14551231950b75fc4402da1732fc9bebfn;

const TAG_BYTES = new TextEncoder().encode(INVITE_KEY_TAG);

function secretValue(secret: Uint8Array): bigint {
  let value = 0n;
  for (const byte of secret) value = (value << 8n) | BigInt(byte);
  return value;
}

function checkIndex(secret: Uint8Array): number {
  return Number(secretValue(secret) % 37n);
}

// The 26 characters that carry the secret, most significant first.
function secretChars(secret: Uint8Array): string {
  const value = secretValue(secret);
  let data = '';
  for (let i = DATA_CHARS - 1; i >= 0; i -= 1) data += CROCKFORD[Number((value >> BigInt(5 * i)) & 31n)];
  return data;
}

// The fewest literal digits an issued code carries in its 26 secret characters.
export const MIN_CODE_DIGITS = 2;

function digitCount(text: string): number {
  return (text.match(/[0-9]/g) ?? []).length;
}

export function keyInRange(k: bigint): boolean {
  return k > 0n && k < SECP256K1_N;
}

/* k = keccak256(utf8("phosphor-invite-v1") || secret), read big-endian. Null when k is 0 or at
   least the curve order, which the generator never issues and the parser answers as empty. */
export function deriveKey(secret: Uint8Array): Hex | null {
  if (secret.length !== SECRET_BYTES) throw new Error(`an invite secret is ${SECRET_BYTES} bytes, got ${secret.length}`);
  const joined = new Uint8Array(TAG_BYTES.length + secret.length);
  joined.set(TAG_BYTES, 0);
  joined.set(secret, TAG_BYTES.length);
  const k = keccak256(joined);
  joined.fill(0);
  return keyInRange(BigInt(k)) ? k : null;
}

// The code's account inside intents.near: the key's EVM address, lowercased the way the
// verifier keys an erc191 signer.
export function codeAddress(secret: Uint8Array): string | null {
  const key = deriveKey(secret);
  return key === null ? null : privateKeyToAccount(key).address.toLowerCase();
}

/* 16 bytes from the OS CSPRNG, redrawn until the key is a valid scalar, the check symbol is a
   letter or a digit, and the secret characters hold two digits (about one draw in ten thousand
   is thrown away for that, a cost of about 0.0001 bits). `random` is crypto.randomBytes in the
   app and the operator script; a test hands in its own to pin a vector or to force a redraw. */
export function generateSecret(random: (bytes: number) => Uint8Array = (n) => crypto.randomBytes(n)): Uint8Array {
  for (;;) {
    const secret = Uint8Array.from(random(SECRET_BYTES));
    if (secret.length !== SECRET_BYTES) throw new Error(`the random source gave ${secret.length} bytes, not ${SECRET_BYTES}`);
    if (checkIndex(secret) < CROCKFORD.length && digitCount(secretChars(secret)) >= MIN_CODE_DIGITS && deriveKey(secret) !== null) return secret;
    secret.fill(0);
  }
}

// PHOS-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXXX: four groups of five and a last group of seven.
export function formatCode(secret: Uint8Array): string {
  if (secret.length !== SECRET_BYTES) throw new Error(`an invite secret is ${SECRET_BYTES} bytes, got ${secret.length}`);
  const data = secretChars(secret) + CHECK_ALPHABET[checkIndex(secret)];
  return [INVITE_PREFIX, data.slice(0, 5), data.slice(5, 10), data.slice(10, 15), data.slice(15, 20), data.slice(20)].join('-');
}

export function inviteLink(code: string): string {
  return INVITE_LINK_BASE + code;
}

export type ParsedCode = { ok: true; secret: Uint8Array } | { ok: false };

/* Crockford's reading rules: case does not matter, O reads as 0, I and L read as 1. ASCII only:
   toUpperCase folds a dotless ı to I and a long ſ to S, and a ligature to two letters, so a
   spelling the redaction pattern cannot see would otherwise parse as a real code. */
function crockfordIndex(ch: string): number {
  if (!/^[0-9A-Za-z]$/.test(ch)) return -1;
  const upper = ch.toUpperCase();
  const mapped = upper === 'O' ? '0' : upper === 'I' || upper === 'L' ? '1' : upper;
  return CROCKFORD.indexOf(mapped);
}

/* The secret back out of whatever was pasted, or not ok. In this order, because the order is
   what keeps the prefix's O from being read as a zero: find and strip the prefix (PHOS or PH0S,
   any case, alone or as the fragment of a pasted invite link), then on the 27 data characters
   only drop spaces and hyphens, read them by Crockford's rules, require the two spare bits to be
   zero, and check the symbol. Never says why: a reason that quoted the input would be the code
   in an error. */
export function parseCode(input: unknown): ParsedCode {
  if (typeof input !== 'string' || input.length > 512) return { ok: false };
  let text = input.trim();
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(hash + 1).trim();
  if (!/^PH[O0]S/i.test(text)) return { ok: false };
  const data = text.slice(INVITE_PREFIX.length).replace(/[\s-]+/g, '');
  if (data.length !== CODE_CHARS) return { ok: false };
  let value = 0n;
  for (let i = 0; i < DATA_CHARS; i += 1) {
    const index = crockfordIndex(data[i]!);
    if (index < 0) return { ok: false };
    value = (value << 5n) | BigInt(index);
  }
  if (value >> 128n !== 0n) return { ok: false };
  const check = crockfordIndex(data[DATA_CHARS]!);
  if (check < 0 || BigInt(check) !== value % 37n) return { ok: false };
  const secret = new Uint8Array(SECRET_BYTES);
  for (let i = SECRET_BYTES - 1; i >= 0; i -= 1) {
    secret[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return { ok: true, secret };
}

/* The canonical shape: a code in any form the parser accepts, inside any text. A separator or
   five data characters in a row after the prefix, 27 data characters with any spaces or hyphens
   between them, and no data character straight after the last one. Case-insensitive. The log
   tail redacts by this alone; the composer asks looksLikeInviteCode. CONTRACTS.md pins both. */
export const INVITE_CODE_SOURCE = String.raw`PH[O0]S(?:[\s-]+|(?=[0-9A-Z]{5}))[0-9A-Z](?:[\s-]*[0-9A-Z]){26}(?![0-9A-Z])`;

export function inviteCodePattern(): RegExp {
  return new RegExp(INVITE_CODE_SOURCE, 'gi');
}

export function containsInviteCode(text: string): boolean {
  return inviteCodePattern().test(text);
}

/* The composer's question: does this text carry something that is an invite code and not a
   sentence. The shape above AND at least two literal digits in the match, counted as typed with
   no O, I or L mapping, the zero of a PH0S prefix included. Every code the generator issues has
   two in its secret characters alone. Mirrored by the window (CONTRACTS.md); change both or
   neither. */
export function looksLikeInviteCode(text: string): boolean {
  for (const match of text.matchAll(inviteCodePattern())) {
    if (digitCount(match[0]) >= MIN_CODE_DIGITS) return true;
  }
  return false;
}
