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
// ONE FOLD, TWO MATCHERS. The parser, the log tail and the composer guard read text through the
// same fold (foldText, below), so a hyphen an editor turned into a dash, a zero-width space or a
// full-width letter is the same code to all three. A match is the prefixed shape (right after the
// prefix a separator, five data characters in a row or a digit, so the word "Phosphor" is not one)
// or a bare run: a code copied without its prefix, which must read as a valid code. The log tail
// redacts every match, and over-redacting is fine there. The composer guard (looksLikeInviteCode)
// adds one rule every issued code meets and prose almost never does: at least two literal digits
// in the match. "phosphorus is used in fertilizer and in matches" has the shape and no digit. Both
// read every match, overlapping ones included. CONTRACTS.md, "Code shape", pins both.

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

/* Crockford's reading rules: case does not matter, O reads as 0, I and L read as 1. ASCII only,
   on folded text (foldText): toUpperCase would turn a dotless ı into I, and the fold leaves ı as a
   separator, so a spelling the matchers read one way would parse another. */
function crockfordIndex(ch: string): number {
  if (!/^[0-9A-Za-z]$/.test(ch)) return -1;
  const upper = ch.toUpperCase();
  const mapped = upper === 'O' ? '0' : upper === 'I' || upper === 'L' ? '1' : upper;
  return CROCKFORD.indexOf(mapped);
}

/* THE FOLD. Text read one character at a time through Unicode NFKD (UAX #15), with combining
   marks and invisible format characters (categories M and Cf) dropped: a full-width or bold letter
   is that letter, a ligature is its letters, an accented letter is its base letter, and a
   zero-width space, a soft hyphen or a direction mark is nothing at all. What is left that is an
   ASCII letter or digit is a data character; any other character separates. NFKD rather than NFKC
   because it reads every character NFKC reads as a letter or digit the same way, and also reads a
   letter and its accent alike however they were encoded; one character at a time so that `starts`
   and `ends` map each folded character back to the text, and the log tail cuts what was written.
   ui/core/invite.js folds the same way. */
const DROPPED = /[\p{M}\p{Cf}]/gu;
const DATA_CHAR = /[0-9A-Za-z]/;

export type Folded = { text: string; starts: number[] | null; ends: number[] | null };

export function foldText(input: string): Folded {
  if (!/[^\x00-\x7f]/.test(input)) return { text: input, starts: null, ends: null };
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  for (const ch of input) {
    const out = ch.charCodeAt(0) < 0x80 ? ch : ch.normalize('NFKD').replace(DROPPED, '');
    for (let i = 0; i < out.length; i += 1) {
      starts.push(at);
      ends.push(at + ch.length);
    }
    text += out;
    at += ch.length;
  }
  return { text, starts, ends };
}

/* The secret back out of whatever was pasted, or not ok. Folded first (above), then in this
   order, because the order is what keeps the prefix's O from being read as a zero: the fragment of
   a pasted invite link if there is one, then the prefix (PHOS or PH0S, any case) stripped when it
   is there, then every separator dropped from the 27 data characters, read by Crockford's rules,
   the two spare bits required to be zero, and the symbol checked. A code with no prefix parses
   too: no valid code starts with P, so the prefix can never be taken for data. Never says why: a
   reason that quoted the input would be the code in an error. */
export function parseCode(input: unknown): ParsedCode {
  if (typeof input !== 'string' || input.length > 512) return { ok: false };
  let text = foldText(input).text;
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(hash + 1);
  text = text.replace(/^[^0-9A-Za-z]+/, '');
  if (/^PH[O0]S/i.test(text)) text = text.slice(INVITE_PREFIX.length);
  const data = text.replace(/[^0-9A-Za-z]+/g, '');
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

/* The prefixed shape, on folded text: the prefix, then a separator, five data characters in a
   row or a digit (every code starts with one, so a first group cut short is still a code, and the
   word "Phosphor" is still not), then 27 data characters with any separators between them, and no
   data character straight after the last one. Case-insensitive. CONTRACTS.md pins it. */
export const INVITE_CODE_SOURCE = String.raw`PH[O0]S(?:[^0-9A-Za-z]+|(?=[0-9A-Za-z]{5})|(?=[0-9]))[0-9A-Za-z](?:[^0-9A-Za-z]*[0-9A-Za-z]){26}(?![0-9A-Za-z])`;

export function inviteCodePattern(): RegExp {
  return new RegExp(INVITE_CODE_SOURCE, 'gi');
}

// A match in folded text: where it starts and ends there, and the literal digits it holds.
type Found = { start: number; end: number; digits: number };

/* Every match of the prefixed shape, overlapping ones included. A plain global search goes on from
   the end of each match, so prose that fills the shape can swallow the prefix of a code right
   behind it ("phosphorus is used in my codes ok PHOS-..."): starting again one character after
   each match's start finds that code too. */
function shapeMatches(folded: string, out: Found[]): void {
  const pattern = inviteCodePattern();
  let found = pattern.exec(folded);
  while (found !== null) {
    out.push({ start: found.index, end: found.index + found[0].length, digits: digitCount(found[0]) });
    pattern.lastIndex = found.index + 1;
    found = pattern.exec(folded);
  }
}

/* Every bare run: a code copied without its prefix. 27 data characters that start a word and end
   one, with only spaces or dashes between them, every group of them but the last at least three
   long, that read as a valid code (Crockford characters, the two spare bits zero, the check symbol
   right) and hold two literal digits. The check is what tells a code from a sentence, and the
   rest is what keeps words, numbers and JSON from passing it by chance one time in 37: measured
   2026-10-01, 1 line in 253,062 of this repo's docs, code and fixtures, and 1 in 20,000 log
   events with random ids and hashes. */
const BARE_SEPARATOR = /[\s\p{Pd}−]/u;

function bareRuns(folded: string, out: Found[]): void {
  for (let start = 0; start < folded.length; start += 1) {
    if (!DATA_CHAR.test(folded[start]!) || (start > 0 && DATA_CHAR.test(folded[start - 1]!))) continue;
    const first = crockfordIndex(folded[start]!);
    if (first < 0 || first >= 8) continue;
    let check = 0;
    let count = 0;
    let digits = 0;
    let group = 0;
    let short = false;
    let end = start;
    for (let i = start; i < folded.length && count < CODE_CHARS; i += 1) {
      const ch = folded[i]!;
      if (!DATA_CHAR.test(ch)) {
        if (!BARE_SEPARATOR.test(ch)) break;
        if (group > 0 && group < 3) short = true;
        group = 0;
        continue;
      }
      const index = crockfordIndex(ch);
      if (index < 0) break;
      if (count < DATA_CHARS) check = (check * 32 + index) % 37;
      else if (index !== check) break;
      if (ch >= '0' && ch <= '9') digits += 1;
      count += 1;
      group += 1;
      end = i + 1;
    }
    if (count !== CODE_CHARS || short || digits < MIN_CODE_DIGITS || (end < folded.length && DATA_CHAR.test(folded[end]!))) continue;
    out.push({ start, end, digits });
  }
}

/* Every match in a text, in the text's own positions, sorted by where it starts. */
function inviteMatches(text: string): Array<Found & { from: number; to: number }> {
  const folded = foldText(text);
  const found: Found[] = [];
  shapeMatches(folded.text, found);
  bareRuns(folded.text, found);
  return found
    .map((f) => ({ ...f, from: folded.starts?.[f.start] ?? f.start, to: folded.ends?.[f.end - 1] ?? f.end }))
    .sort((a, b) => a.from - b.from || b.to - a.to);
}

export function containsInviteCode(text: string): boolean {
  return inviteMatches(text).length > 0;
}

/* The composer's question: the first stretch of this text that is an invite code and not a
   sentence, as written, or null. A match (the prefixed shape or a bare run), at any start, with at
   least two literal digits in it, counted as typed with no O, I or L mapping, the zero of a PH0S
   prefix included. Every code the generator issues has two in its secret characters alone. The
   window's codeIn (ui/core/invite.js) is the same function, and tests/fixtures/invite-code-texts.ts
   holds both to one corpus (CONTRACTS.md); change both or neither. */
export function findInviteCode(text: string): string | null {
  const hit = inviteMatches(text).find((m) => m.digits >= MIN_CODE_DIGITS);
  return hit === undefined ? null : text.slice(hit.from, hit.to);
}

export function looksLikeInviteCode(text: string): boolean {
  return findInviteCode(text) !== null;
}

/* The log tail's cut: every stretch a match covers, overlaps joined, replaced whole. */
export function redactInviteCodes(text: string, replacement: string): string {
  const spans: Array<[number, number]> = [];
  for (const match of inviteMatches(text)) {
    const last = spans[spans.length - 1];
    if (last !== undefined && match.from <= last[1]) last[1] = Math.max(last[1], match.to);
    else spans.push([match.from, match.to]);
  }
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    out += text.slice(at, start) + replacement;
    at = end;
  }
  return out + text.slice(at);
}
