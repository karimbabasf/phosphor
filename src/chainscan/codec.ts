// The checksums inside a chain address, each small enough to read in one sitting.
//
// An address that decodes and carries the wrong checksum is the pasted address that lost or
// swapped a character, which on a chain is money sent to nobody. So every family whose format
// has a checksum gets it checked here, from the format's own definition, with no library: a
// dependency in a wallet is code from a stranger that runs next to the key. Everything here is
// pure and synchronous, and answers null for "not this format" rather than throwing.

import { createHash } from 'node:crypto';

export const BTC_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// The XRP Ledger's own ordering of the same 58 characters, which is why an r-address fails a
// Bitcoin decoder even though every character in it is legal there.
export const XRP_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

export function base58Decode(text: string, alphabet: string = BTC_ALPHABET): Uint8Array | null {
  let acc = 0n;
  for (const ch of text) {
    const digit = alphabet.indexOf(ch);
    if (digit < 0) return null;
    acc = acc * 58n + BigInt(digit);
  }
  const body: number[] = [];
  for (; acc > 0n; acc >>= 8n) body.push(Number(acc & 0xffn));
  // Each leading zero character is one leading zero byte, which the number above cannot hold.
  for (const ch of text) {
    if (ch !== alphabet[0]) break;
    body.push(0);
  }
  return Uint8Array.from(body.reverse());
}

function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest();
}

// base58check: a payload followed by the first four bytes of its double SHA-256. The payload
// when the tail matches, null when it does not.
export function base58Check(text: string, alphabet: string = BTC_ALPHABET): Uint8Array | null {
  const raw = base58Decode(text, alphabet);
  if (raw === null || raw.length < 5) return null;
  const payload = raw.subarray(0, raw.length - 4);
  const sum = sha256(sha256(payload));
  for (let i = 0; i < 4; i++) if (sum[i] !== raw[payload.length + i]) return null;
  return payload;
}

// ---------- bech32 and bech32m (BIP-173, BIP-350) ----------

const BECH32_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
  }
  return chk >>> 0;
}

export type Bech32 = { hrp: string; words: number[]; variant: 'bech32' | 'bech32m' };

// BIP-173 caps a string at 90 characters; Cardano's addresses run longer under the same
// checksum, so the cap is the caller's.
export function bech32Decode(text: string, maxLength = 90): Bech32 | null {
  if (text.length > maxLength || (text !== text.toLowerCase() && text !== text.toUpperCase())) return null;
  const s = text.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const data: number[] = [];
  for (const ch of s.slice(sep + 1)) {
    const v = BECH32_CHARS.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  const check = bech32Polymod([...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31), ...data]);
  const variant = check === 1 ? 'bech32' : check === BECH32M_CONST ? 'bech32m' : null;
  return variant === null ? null : { hrp, words: data.slice(0, -6), variant };
}

// Five-bit groups back to bytes. Leftover bits must be fewer than five and all zero, or the
// string was padded by something other than an encoder.
export function fromWords(words: number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

// A segwit address: witness version and program, with the variant each version requires.
export function segwit(text: string, hrp: string): { version: number; program: Uint8Array } | null {
  const d = bech32Decode(text);
  if (d === null || d.hrp !== hrp || d.words.length < 1) return null;
  const version = d.words[0];
  const program = fromWords(d.words.slice(1));
  if (program === null || version > 16 || program.length < 2 || program.length > 40) return null;
  if (version === 0 ? d.variant !== 'bech32' || (program.length !== 20 && program.length !== 32) : d.variant !== 'bech32m') return null;
  return { version, program };
}

// ---------- CashAddr (Bitcoin Cash) ----------

// The same 32 characters as bech32 under a 40-bit checksum, so BigInt.
function cashPolymod(values: number[]): bigint {
  const gen = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const top = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) c ^= gen[i];
  }
  return c ^ 1n;
}

// The version byte and hash of a CashAddr with the given prefix, the prefix itself optional
// in the text as the spec allows.
export function cashAddr(text: string, prefix: string): Uint8Array | null {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null;
  const s = text.toLowerCase();
  const body = s.startsWith(`${prefix}:`) ? s.slice(prefix.length + 1) : s;
  const data: number[] = [];
  for (const ch of body) {
    const v = BECH32_CHARS.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  if (data.length < 9) return null;
  if (cashPolymod([...[...prefix].map((c) => c.charCodeAt(0) & 31), 0, ...data]) !== 0n) return null;
  return fromWords(data.slice(0, -8));
}

// ---------- base32 and CRC16 (Stellar strkeys, TON friendly addresses) ----------

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of text) {
    const v = BASE32_CHARS.indexOf(ch);
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return bits >= 5 || (acc & ((1 << bits) - 1)) !== 0 ? null : Uint8Array.from(out);
}

// CRC-16/XMODEM: polynomial 0x1021, initial value 0.
export function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
