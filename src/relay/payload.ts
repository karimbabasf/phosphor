// The intent the relay swap rail signs, built here and read back here as a stranger would.
//
// Everything in the payload comes from one of three places and nowhere else: the approved
// draft, the quote the rail chose, or the app's own key and clock. Nothing from the relay's
// response is copied in except the two amounts and the two asset ids, and each of those is
// checked against the draft first. `buildTokenDiffPayload` writes the string; `checkTokenDiffPayload`
// reads the string it is about to sign with no access to how it was built, one refusal per way
// the string could say something other than the swap a human approved. Both are pure.
//
// The nonce is the verifier's versioned V1 shape (near/intents, contracts/defuse/README.md):
//   magic 5628f6c6 (4) || version 00 (1) || salt (4) || deadline ns, i64 little-endian (8) || random (15)
// and the README's own worked example is a test vector. A legacy nonce of 32 random bytes
// still passes the contract today and is announced as going away, so this rail never makes one.

import { INTENTS_VERIFIER } from '../ledger/intents.ts';
import { oneLine } from '../intents.ts';
import { duplicateJsonKey } from '../intents-sign.ts';
import type { RelayQuote } from './client.ts';

// ---------- the nonce ----------

export const NONCE_MAGIC = Uint8Array.from([0x56, 0x28, 0xf6, 0xc6]);
export const NONCE_VERSION_V1 = 0;
export const NONCE_RANDOM_BYTES = 15;
const NONCE_BYTES = 32;

export type NonceParts = {
  salt: Uint8Array; // 4 bytes, the contract's current salt
  deadlineMs: number; // when the nonce itself stops being valid; at or after the intent deadline
  random: Uint8Array; // 15 bytes from the app's own randomness
};

/* The nonce as base64 of its 32 bytes. Throws on parts of the wrong size rather than padding
   them: a nonce the contract would read differently from how it was meant is a nonce that
   could be replayed under a reading nobody checked. */
export function buildNonce(parts: NonceParts): string {
  if (parts.salt.length !== 4) throw new Error(`a nonce salt is 4 bytes, got ${parts.salt.length}`);
  if (parts.random.length !== NONCE_RANDOM_BYTES) throw new Error(`a nonce carries ${NONCE_RANDOM_BYTES} random bytes, got ${parts.random.length}`);
  if (!Number.isFinite(parts.deadlineMs) || parts.deadlineMs <= 0) throw new Error('a nonce deadline must be a time');
  const out = new Uint8Array(NONCE_BYTES);
  out.set(NONCE_MAGIC, 0);
  out[4] = NONCE_VERSION_V1;
  out.set(parts.salt, 5);
  new DataView(out.buffer).setBigInt64(9, BigInt(Math.floor(parts.deadlineMs)) * 1_000_000n, true);
  out.set(parts.random, 17);
  return Buffer.from(out).toString('base64');
}

export type DecodedNonce = { salt: Uint8Array; deadlineMs: number; random: Uint8Array };

// The parts back out of a nonce, or null for anything that is not a 32-byte V1 nonce.
export function decodeNonce(nonce: unknown): DecodedNonce | null {
  if (typeof nonce !== 'string' || nonce === '') return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(nonce, 'base64');
  } catch {
    return null;
  }
  // Buffer.from(base64) is forgiving; only a string that round-trips to itself is a nonce.
  if (bytes.length !== NONCE_BYTES || bytes.toString('base64') !== nonce) return null;
  for (let i = 0; i < 4; i += 1) if (bytes[i] !== NONCE_MAGIC[i]) return null;
  if (bytes[4] !== NONCE_VERSION_V1) return null;
  const deadlineNs = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(9, true);
  return {
    salt: Uint8Array.from(bytes.subarray(5, 9)),
    deadlineMs: Number(deadlineNs / 1_000_000n),
    random: Uint8Array.from(bytes.subarray(17, 32)),
  };
}

// ---------- the deadline ----------

// How long a signature this app releases may stay live: the quote's own expiry, capped. Two
// minutes is what makes "Freeze everything" cover a relay swap by itself, since an intent past
// its deadline is dead without anyone doing anything.
export const MAX_DEADLINE_MS = 120_000;

export function deadlineFor(quoteExpiration: string, now: number, maxMs: number = MAX_DEADLINE_MS): string {
  const expires = Date.parse(quoteExpiration);
  const capped = now + maxMs;
  return new Date(Number.isFinite(expires) ? Math.min(expires, capped) : capped).toISOString();
}

// ---------- the payload ----------

export type TokenDiffInput = {
  signerId: string; // our EVM address; lowercased here, because the verifier keys the account that way
  assetIn: string;
  assetOut: string;
  amountIn: bigint; // base units leaving, exactly the draft's
  amountOut: bigint; // base units arriving, exactly the chosen quote's
  deadline: string; // ISO
  nonce: string; // base64, from buildNonce
};

/* The string that is signed and sent, serialised exactly once. Key order is fixed so the same
   inputs give the same bytes, and the diff writes the spend first and the credit second, which
   is the order the relay reports filled_amounts in. */
export function buildTokenDiffPayload(input: TokenDiffInput): string {
  if (input.amountIn <= 0n || input.amountOut <= 0n) throw new Error('a token_diff moves a positive amount each way');
  if (input.assetIn === input.assetOut) throw new Error('a token_diff needs two different assets');
  return JSON.stringify({
    signer_id: input.signerId.toLowerCase(),
    verifying_contract: INTENTS_VERIFIER,
    deadline: input.deadline,
    nonce: input.nonce,
    intents: [
      {
        intent: 'token_diff',
        diff: {
          [input.assetIn]: `-${input.amountIn.toString()}`,
          [input.assetOut]: input.amountOut.toString(),
        },
      },
    ],
  });
}

export type TokenDiffExpectation = {
  signerId: string; // our address; compared lowercased against a payload that must be lowercase
  assetIn: string;
  assetOut: string;
  amountIn: bigint; // what the draft spends, base units
  minOut: bigint; // the draft's floor, base units
  quoteOut: bigint; // what the chosen quote credits, base units; the payload must say exactly this
  now: number;
  maxDeadlineMs: number;
  // Every nonce this process has signed. A nonce seen here is a second signature over a move.
  usedNonces: ReadonlySet<string>;
  // The salt read from the contract before the nonce was built, when one was; the nonce's own
  // salt has to be it. Absent means the caller could not read one, which the rail refuses before
  // it gets here; the check refuses too rather than trusting the nonce's own claim.
  salt?: Uint8Array;
};

const PAYLOAD_KEYS = ['signer_id', 'verifying_contract', 'deadline', 'nonce', 'intents'];

// A diff amount: a decimal integer string and nothing else. The relay writes amounts as
// strings, this app writes them as strings, and a number here would have been through a
// double. Leading zeros and a plus sign are refused too: not because the contract would read
// them differently, but because this app never writes them and a builder that did has changed.
function decimalAmount(value: unknown, sign: '-' | '+'): bigint | null {
  if (typeof value !== 'string') return null;
  const shape = sign === '-' ? /^-(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/;
  if (!shape.test(value)) return null;
  return BigInt(value);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* Returns the problems it found. An empty array means the payload says what the draft says.
   One refusal per row of the table in the spec ("The payload we build"), and the first row
   that fails is the answer: a payload with two things wrong is refused for the first, and the
   sentence names it. Amounts are compared as bigint from decimal strings, never through a
   double. */
export function checkTokenDiffPayload(raw: unknown, expect: TokenDiffExpectation): string[] {
  if (expect.minOut <= 0n) return ['the draft carries no slippage floor, so no payload can be checked against one'];
  if (typeof raw !== 'string' || raw.trim() === '') return [`the payload must be a JSON string, got ${oneLine(raw, 60)}`];

  let body: Record<string, unknown>;
  try {
    // JSON.parse, once, never eval. The payload is a value.
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [`the payload is not a JSON object: ${oneLine(raw, 80)}`];
    body = parsed as Record<string, unknown>;
  } catch {
    return [`the payload is not valid JSON: ${oneLine(raw, 80)}`];
  }

  const twice = duplicateJsonKey(raw);
  if (twice !== null) {
    return [`the payload names ${oneLine(twice, 40)} twice in one object, so what this app checked and what the verifier would read may differ; a payload that can be read two ways is not signed`];
  }

  const stray = Object.keys(body).filter((k) => !PAYLOAD_KEYS.includes(k));
  if (stray.length > 0) return [`the payload carries ${stray.map((k) => oneLine(k, 30)).join(', ')}, which this app never writes`];

  if (body['verifying_contract'] !== INTENTS_VERIFIER) {
    return [`the payload names ${oneLine(body['verifying_contract'], 60)} as the verifying contract, not ${INTENTS_VERIFIER}; this signature would authorise a swap in a contract we did not choose`];
  }

  const signer = body['signer_id'];
  const ours = expect.signerId.toLowerCase();
  if (typeof signer !== 'string' || signer !== ours) {
    return [`the payload is authored for ${oneLine(signer, 60)} but our account is ${ours}`];
  }

  const nonce = decodeNonce(body['nonce']);
  if (nonce === null) return ['the payload carries no 32-byte versioned nonce, so it cannot be protected against replay'];
  if (typeof body['nonce'] === 'string' && expect.usedNonces.has(body['nonce'])) {
    return ['the payload reuses a nonce this app already signed; one signature per move, ever'];
  }
  if (expect.salt === undefined || !sameBytes(nonce.salt, expect.salt)) {
    return ['the nonce does not carry the salt read from the verifier, so the contract would refuse it'];
  }

  const deadlineRaw = body['deadline'];
  const deadline = typeof deadlineRaw === 'string' ? Date.parse(deadlineRaw) : Number.NaN;
  if (!Number.isFinite(deadline)) return [`the deadline ${oneLine(deadlineRaw, 60)} is not a timestamp`];
  if (deadline <= expect.now) return [`the deadline ${oneLine(deadlineRaw, 60)} has already passed`];
  if (deadline - expect.now > expect.maxDeadlineMs) {
    return [`the deadline ${oneLine(deadlineRaw, 60)} is more than ${Math.round(expect.maxDeadlineMs / 1000)} s out; a signature released for that long can be replayed`];
  }
  if (nonce.deadlineMs < deadline) return ['the nonce expires before the intent does, so the contract would refuse it'];

  const intents = body['intents'];
  if (!Array.isArray(intents) || intents.length !== 1) {
    const kinds = Array.isArray(intents) ? intents.map((i) => oneLine((i as Record<string, unknown>)?.['intent'] ?? '?', 30)).join(', ') : oneLine(intents, 60);
    return [`the payload bundles ${Array.isArray(intents) ? intents.length : 'a non-list'} actions (${kinds}); this rail signs exactly one token_diff`];
  }
  const action = intents[0] as Record<string, unknown> | null;
  if (action === null || typeof action !== 'object' || action['intent'] !== 'token_diff') {
    return [`the intent is a ${oneLine(action?.['intent'], 40)}, not the token_diff a relay swap is made of`];
  }
  const actionKeys = Object.keys(action).filter((k) => k !== 'intent' && k !== 'diff');
  if (actionKeys.length > 0) return [`the token_diff carries ${actionKeys.map((k) => oneLine(k, 30)).join(', ')}, which this app never writes`];

  const diff = action['diff'];
  if (diff === null || typeof diff !== 'object' || Array.isArray(diff)) return [`the token_diff carries no diff object (got ${oneLine(diff, 60)})`];
  const entries = diff as Record<string, unknown>;
  const keys = Object.keys(entries);
  if (keys.length !== 2) return [`the token_diff moves ${keys.length} assets, not the two the draft names`];
  if (expect.assetIn === expect.assetOut) return ['the draft names the same asset on both sides'];
  if (!keys.includes(expect.assetIn)) return [`the swap does not spend ${oneLine(expect.assetIn, 60)}, which the draft names as the input`];
  if (!keys.includes(expect.assetOut)) return [`the swap does not deliver ${oneLine(expect.assetOut, 60)}, which the draft names as the output`];

  const spend = decimalAmount(entries[expect.assetIn], '-');
  if (spend === null) return [`the input leg of the swap has no negative decimal amount (got ${oneLine(entries[expect.assetIn], 40)})`];
  if (-spend !== expect.amountIn) {
    return [`the swap spends ${(-spend).toString()} base units, not the ${expect.amountIn.toString()} the draft approved`];
  }

  const receive = decimalAmount(entries[expect.assetOut], '+');
  if (receive === null) return [`the output leg of the swap has no decimal amount (got ${oneLine(entries[expect.assetOut], 40)})`];
  if (receive < expect.minOut) {
    return [`the swap delivers ${receive.toString()} base units, below the ${expect.minOut.toString()} floor the draft approved`];
  }
  if (receive !== expect.quoteOut) {
    return [`the swap delivers ${receive.toString()} base units, not the ${expect.quoteOut.toString()} the chosen quote offers`];
  }

  return [];
}

// ---------- the quote ----------

export type QuoteWant = {
  assetIn: string;
  assetOut: string;
  amountIn: bigint;
  now: number;
  minAheadMs: number; // a quote expiring sooner than this is not worth a signature
};

export type QuotePick = {
  chosen: RelayQuote | null;
  // Why the others were passed over, one line each, for the sentence and the audit row.
  passed: string[];
};

/* The quote to sign against: the largest amount_out among the quotes that price exactly our
   amount_in of our two assets and stay valid long enough to publish. Everything else is passed
   over by name. Pure; the floor is the rail's to judge, because under the threshold it refuses
   and above it it holds, and this function does neither. */
export function pickQuote(quotes: RelayQuote[], want: QuoteWant): QuotePick {
  const passed: string[] = [];
  let chosen: RelayQuote | null = null;
  let best = -1n;
  for (const q of quotes) {
    if (q.assetIn !== want.assetIn || q.assetOut !== want.assetOut) {
      passed.push(`quote ${oneLine(q.quoteHash, 20)} prices ${oneLine(q.assetIn, 40)} to ${oneLine(q.assetOut, 40)}, not the pair the draft names`);
      continue;
    }
    if (BigInt(q.amountIn) !== want.amountIn) {
      passed.push(`quote ${oneLine(q.quoteHash, 20)} is for ${q.amountIn} base units in, not the ${want.amountIn.toString()} the draft spends`);
      continue;
    }
    const expires = Date.parse(q.expirationTime);
    if (!Number.isFinite(expires) || expires - want.now < want.minAheadMs) {
      passed.push(`quote ${oneLine(q.quoteHash, 20)} expires at ${q.expirationTime}, inside ${Math.round(want.minAheadMs / 1000)} s`);
      continue;
    }
    const out = BigInt(q.amountOut);
    if (out > best) {
      best = out;
      chosen = q;
    }
  }
  return { chosen, passed };
}
