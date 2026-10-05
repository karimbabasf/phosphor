// What the vault service's grammar refuses for the chip key, asked again in Node before the service
// is (src/vault/chip.ts chipSign). The rules are src-tauri/se-helper/IntentGrammar.swift's, under
// its own names, so a payload the service would refuse never reaches it: the service stays the real
// boundary, and this is the first line. readVaultPayload (./payload.ts) already holds the shape (one
// JSON object with its exact keys, no key twice, a V1 nonce, the four intents a vault uses, each
// with its exact keys); what is here is the rest of the grammar. tests/unit/intent-grammar.test.ts
// holds it to the Swift over the grammar's corpus and its 10 000 mutated payloads.
//
// THE SENTENCE. The service refuses a payload whose Touch ID sentence would run past 120 characters.
// Its words depend on what the chip's marker pins: "your allowance" for the allowance, "your paper
// recovery key" for the paper. With the pins given, the length here is the service's; without them,
// the shortest the pins could make it, so a payload is refused here only when the service would
// refuse it whatever they are.

import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../rails/intents-relay.ts';
import { chipTokens } from './chip-tokens.ts';
import type { VaultPayload } from './payload.ts';

export type GrammarRefusal = { rule: string; message: string };

// The pins the service writes the sentence from, when the caller knows them.
export type GrammarPins = { account: string; allowance?: string; recovery?: string };

const MAX_BYTES = 4096;
const MAX_INTENTS = 4;
const MAX_SENTENCE = 120;
const WINDOW_NS = 120_000_000_000n;
const NONCE_LIFE_NS = BigInt(NONCE_LIFE_AFTER_DEADLINE_MS) * 1_000_000n;
// IntentGrammar.swift isAccountId: 2 to 64 of a-z and 0-9, in runs joined by single . - or _.
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const EVM = /^0x[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DEADLINE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/* The bytes, before anything parses them: at most 4096, printable ASCII and JSON whitespace only,
   and no backslash, so no escape can make one parser read what another does not. */
export function chipBytesRefusal(payload: string): GrammarRefusal | null {
  const size = Buffer.byteLength(payload, 'utf8');
  if (size > MAX_BYTES) return { rule: 'size', message: `the payload is ${size} bytes, over ${MAX_BYTES}` };
  const at = payload.search(/[^\x20-\x7e\t\n\r]/);
  if (at >= 0) return { rule: 'ascii', message: `character ${at} is not printable ASCII or JSON whitespace` };
  if (payload.includes('\\')) return { rule: 'escape', message: 'the payload carries a backslash escape' };
  return null;
}

// 2026-10-04T18:33:36.641Z and nothing looser, in nanoseconds since 1970, or null (years 1970 to 2261).
function deadlineNs(text: string): bigint | null {
  const m = DEADLINE.exec(text);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1970 || year > 2261 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return null;
  const nanos = BigInt((m[7] ?? '').padEnd(9, '0') || '0');
  return BigInt(Date.UTC(year, month - 1, day, hour, minute, second) / 1000) * 1_000_000_000n + nanos;
}

// The nonce's own expiry, in nanoseconds: bytes 9 to 17, little-endian.
function nonceExpiryNs(nonce: string): bigint {
  return Buffer.from(nonce, 'base64').readBigInt64LE(9);
}

const ends = (s: string): string => `${s.slice(0, 8)}...${s.slice(-8)}`;

/* An account as the sentence names it (IntentGrammar.swift name), or null when it hangs on a pin the
   caller did not give: a 0x account may be the allowance. */
function nameOf(account: string, pins: GrammarPins): string | null {
  if (account === pins.account) return 'your vault';
  if (pins.allowance !== undefined && account === pins.allowance) return 'your allowance';
  if (pins.allowance === undefined && EVM.test(account)) return null;
  if (HEX64.test(account)) return ends(account);
  if (EVM.test(account)) return `0x${ends(account.slice(2))}`;
  return account;
}

function list(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}

// Base units as the sentence says them: exact, thousands grouped, trailing zeros trimmed to two places.
export function sentenceAmount(amount: string, places: number): string {
  const digits = amount.length <= places ? '0'.repeat(places + 1 - amount.length) + amount : amount;
  const whole = digits.slice(0, digits.length - places);
  let fraction = digits.slice(digits.length - places);
  while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  fraction = fraction.padEnd(2, '0');
  let grouped = '';
  for (let i = 0; i < whole.length; i += 1) grouped += (i > 0 && (whole.length - i) % 3 === 0 ? ',' : '') + whole[i];
  return `${grouped}.${fraction}`;
}

/* The shortest the service's sentence can be: its exact length when the pins are given. */
function sentenceLength(p: VaultPayload, pins: GrammarPins): number {
  const from = nameOf(p.signer_id, pins) ?? 'your allowance';
  const first = p.intents[0];
  if (first === undefined) return `confirm this Mac's Touch ID key for ${from}`.length;
  if (first.intent === 'transfer') {
    const amounts = p.intents.map((i) => {
      if (i.intent !== 'transfer') return '';
      const [asset, amount] = Object.entries(i.tokens)[0]!;
      const token = chipTokens().get(asset)!;
      return `${sentenceAmount(amount, token.decimals)} ${token.symbol}`;
    });
    // "move" and "send" are one length; a 0x receiver with no pins may be the allowance.
    const to = nameOf(first.receiver_id, pins) ?? 'your allowance';
    return `move ${list(amounts)} from ${from} to ${to}`.length;
  }
  const keys = p.intents.map((i) => {
    if (i.intent !== 'remove_public_key') return '';
    if (pins.recovery !== undefined ? i.public_key === pins.recovery : i.public_key.startsWith('secp256k1:')) return 'your paper recovery key';
    const colon = i.public_key.indexOf(':');
    return `key ${i.public_key.slice(0, colon + 1)}${ends(i.public_key.slice(colon + 1))}`;
  });
  return `remove ${list(keys)} from ${from}`.length;
}

/* The grammar's rules a payload readVaultPayload took can still break, in the grammar's order, for
   the chip key `chip` (its p256: key) at `nowMs` on this Mac's clock; the first broken, or null. */
export function chipPayloadRefusal(p: VaultPayload, chip: string, nowMs: number, pins: GrammarPins): GrammarRefusal | null {
  const deadline = deadlineNs(p.deadline);
  if (deadline === null) return { rule: 'deadline', message: 'the deadline must read like 2026-10-04T18:33:36.641Z' };
  const now = BigInt(Math.round(nowMs)) * 1_000_000n;
  if (deadline <= now || deadline - now > WINDOW_NS) return { rule: 'deadline', message: 'the deadline must be later than now and at most 120 seconds after it' };
  if (nonceExpiryNs(p.nonce) !== deadline + NONCE_LIFE_NS) return { rule: 'nonce', message: "the nonce must expire exactly seven days after the payload's deadline" };
  if (p.intents.length > MAX_INTENTS) return { rule: 'intents', message: `${p.intents.length} intents, over ${MAX_INTENTS}` };
  // Each intent on its own, in order.
  for (const intent of p.intents) {
    if (intent.intent === 'add_public_key') return { rule: 'refused_kind', message: 'add_public_key: a key is added only by the old signer, inside a rekey, never by the chip key' };
    if (intent.intent === 'set_auth_by_predecessor_id') return { rule: 'refused_kind', message: 'set_auth_by_predecessor_id: the rekey turns this off with the old key, and the chip key never turns it back on' };
    if (intent.intent === 'transfer') {
      if (!ACCOUNT_ID.test(intent.receiver_id)) return { rule: 'receiver', message: 'receiver_id is not a NEAR account id' };
      const asset = Object.keys(intent.tokens)[0]!;
      if (!chipTokens().has(asset)) return { rule: 'token', message: `${asset} is not in the chip token table` };
    } else if (intent.public_key === chip) {
      return { rule: 'signing_key', message: 'the chip key never removes itself' };
    }
  }
  // Then what holds across them: a token symbol once, a key once, one kind, one receiver.
  const kinds = new Set<string>();
  const receivers = new Set<string>();
  const symbols = new Set<string>();
  const keys = new Set<string>();
  for (const intent of p.intents) {
    kinds.add(intent.intent);
    if (intent.intent === 'transfer') {
      const symbol = chipTokens().get(Object.keys(intent.tokens)[0]!)!.symbol;
      if (symbols.has(symbol)) return { rule: 'token_repeat', message: `${symbol} appears twice; a payload moves each token once` };
      symbols.add(symbol);
      receivers.add(intent.receiver_id);
    } else if (intent.intent === 'remove_public_key') {
      if (keys.has(intent.public_key)) return { rule: 'key_repeat', message: 'one key is removed twice' };
      keys.add(intent.public_key);
    }
  }
  if (kinds.size > 1) return { rule: 'one_kind', message: 'a payload carries one kind of intent' };
  if (receivers.size > 1) return { rule: 'one_receiver', message: 'every transfer in a payload goes to one receiver' };
  const length = sentenceLength(p, pins);
  if (length > MAX_SENTENCE) return { rule: 'sentence', message: `the sentence would be ${length} characters, over ${MAX_SENTENCE}` };
  return null;
}
