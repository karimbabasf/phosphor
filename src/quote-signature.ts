// The 1Click quote signature, checked before a deposit address is trusted with anything.
//
// The deposit address is the one field in a quote this app cannot check by itself: the API picks
// it, and every rail sends the whole amount to it. 1Click signs the quote for exactly that
// reason (docs.near-intents.org, "Verify Quote Signatures"), and the signature came back on every
// response and was read by nobody: it was kept on the type "because the docs say this is what
// resolves a dispute", and quoteEchoProblems compares recipient, refundTo, assets and amount,
// never the deposit address. A TLS position between this app and the API (a corporate proxy, a
// root certificate another tool installed, NODE_TLS_REJECT_UNAUTHORIZED=0 inherited from the
// launching shell) could rewrite depositAddress, leave quoteRequest alone, pass every check and
// take the transfer. This closes that, and it persists what was signed so a dispute has the
// quote 1Click committed to rather than a reconstruction.
//
// WHAT IS SIGNED, in the vendor's words: a Base58-encoded SHA-256 of a deterministic JSON object,
// `stringify({ ...quoteRequest, ...quoteResponse, timestamp })` with json-stable-stringify's key
// ordering, where quoteRequest and quoteResponse are the field subsets below and nothing else. The
// message the key signs is the UTF-8 bytes of that Base58 text, not the hash bytes. The key is
// Ed25519. All of it is transcribed from src/quote-signature.ts of the vendor's own SDK
// (@defuse-protocol/one-click-sdk-typescript 0.1.25, the version the docs name), which is also
// where ONECLICK_MANAGER_PUBLIC_KEY comes from; the SDK's own test fixtures, signed by 1Click's
// staging key, are the vectors in tests/unit/quote-signature.test.ts. Transcribed rather than
// imported because the SDK brings axios, form-data and tweetnacl into a process that holds keys,
// for four functions Node's own crypto covers.
//
// Two things a reader should not "fix". The field lists are the vendor's, exactly, including the
// `|| undefined` on every optional quote field (an empty string or a zero is dropped from the
// message, as the signer dropped it) and the three request fields the signer always leaves out
// (appFees, depositMode, sessionId and the rest). And stableStringify skips undefined values the
// way JSON.stringify does, which is what makes a field the API omitted and a field it sent as
// null hash the same: the status endpoint returns the same quote with nulls where the quote
// endpoint returned nothing, and both carry one signature.

import crypto from 'node:crypto';

import { base58Decode, base58Encode } from './chain/near.ts';
import type { OneClickQuote } from './intents.ts';
import { oneLine } from './intents.ts';

/* 1Click's quote signing key on production, as the SDK ships it. A key that changes is a release
   of the SDK, and the test that pins this one to 32 decoded bytes is where a new one gets typed. */
export const ONECLICK_MANAGER_PUBLIC_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

const ED25519_PREFIX = 'ed25519:';

// The DER head of an Ed25519 SubjectPublicKeyInfo (RFC 8410): the twelve bytes that turn a raw
// 32-byte key into something createPublicKey reads.
const ED25519_SPKI_HEAD = Buffer.from('302a300506032b6570032100', 'hex');

// What a rail keeps of a verified quote, on the proposal row beside the hashes. Four fields, all
// of them 1Click's own: the id it traces the request by, the stamp it signed, the signature, and
// the address the money went to. Enough to put the signed quote in front of the vendor.
export type QuoteRecord = {
  correlationId: string;
  timestamp: string;
  signature: string;
  depositAddress: string;
};

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

/* The exact subset of the echoed request that the signature covers, in the SDK's own shape. The
   five optional fields are `x ? x : undefined`, as the signer wrote them, so a zero
   quoteWaitingTimeMs and an empty referral are absent from the message rather than present. */
function signedRequest(quoteRequest: Json): Json {
  const optional = (key: string): unknown => (quoteRequest[key] ? quoteRequest[key] : undefined);
  return {
    dry: quoteRequest['dry'],
    swapType: quoteRequest['swapType'],
    slippageTolerance: quoteRequest['slippageTolerance'],
    originAsset: quoteRequest['originAsset'],
    depositType: quoteRequest['depositType'],
    destinationAsset: quoteRequest['destinationAsset'],
    amount: quoteRequest['amount'],
    refundTo: quoteRequest['refundTo'],
    refundType: quoteRequest['refundType'],
    recipient: quoteRequest['recipient'],
    recipientType: quoteRequest['recipientType'],
    deadline: quoteRequest['deadline'],
    quoteWaitingTimeMs: optional('quoteWaitingTimeMs'),
    referral: optional('referral'),
    virtualChainRecipient: optional('virtualChainRecipient'),
    virtualChainRefundRecipient: optional('virtualChainRefundRecipient'),
    customRecipientMsg: optional('customRecipientMsg'),
  };
}

/* The subset of the quote that the signature covers. A dry quote signs the eight amounts; a live
   one signs those plus the execution fields, each `|| undefined` as the signer wrote it. */
function signedQuote(quote: Json, dry: boolean): Json {
  const amounts: Json = {
    amountIn: quote['amountIn'],
    amountInFormatted: quote['amountInFormatted'],
    amountInUsd: quote['amountInUsd'],
    minAmountIn: quote['minAmountIn'],
    amountOut: quote['amountOut'],
    amountOutFormatted: quote['amountOutFormatted'],
    amountOutUsd: quote['amountOutUsd'],
    minAmountOut: quote['minAmountOut'],
  };
  if (dry) return amounts;
  const optional = (key: string): unknown => quote[key] || undefined;
  return {
    ...amounts,
    depositAddress: optional('depositAddress'),
    depositMemo: optional('depositMemo'),
    deadline: optional('deadline'),
    timeWhenInactive: optional('timeWhenInactive'),
    timeEstimate: optional('timeEstimate'),
    virtualChainRecipient: optional('virtualChainRecipient'),
    virtualChainRefundRecipient: optional('virtualChainRefundRecipient'),
    customRecipientMsg: optional('customRecipientMsg'),
    refundFee: optional('refundFee'),
    withdrawFee: optional('withdrawFee'),
  };
}

/* json-stable-stringify 1.3.0 with its defaults: keys sorted by code unit, no whitespace, an
   undefined value dropped from an object and written as null inside an array, everything else
   exactly as JSON.stringify writes it. Only the defaults are reproduced, because only the
   defaults are what the signer used. */
export function stableStringify(value: unknown): string | undefined {
  const node = value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
  if (node === undefined) return undefined;
  if (node === null || typeof node !== 'object') return JSON.stringify(node);
  if (Array.isArray(node)) return `[${node.map((item) => stableStringify(item) ?? 'null').join(',')}]`;
  const out: string[] = [];
  for (const key of Object.keys(node as Json).sort()) {
    const text = stableStringify((node as Json)[key]);
    if (text !== undefined) out.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${out.join(',')}}`;
}

// The Base58 text 1Click signs for this response: its hash, computed over the signed subset.
export function quoteHash(raw: unknown): string {
  const response = record(raw);
  const quoteRequest = record(response['quoteRequest']);
  const fields = {
    ...signedRequest(quoteRequest),
    ...signedQuote(record(response['quote']), Boolean(quoteRequest['dry'])),
    timestamp: response['timestamp'],
  };
  const text = stableStringify(fields) ?? '';
  return base58Encode(crypto.createHash('sha256').update(text, 'utf8').digest());
}

function decodeKeyed(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value === '') throw new Error('empty');
  return base58Decode(value.startsWith(ED25519_PREFIX) ? value.slice(ED25519_PREFIX.length) : value);
}

// True when `raw` is a quote response 1Click signed under `publicKey`. False for anything else,
// including a response with no signature, a malformed one, or one that is not an object at all:
// nothing here throws, because a rail's answer to every one of those is the same refusal.
export function verifyQuoteSignature(raw: unknown, publicKey: string = ONECLICK_MANAGER_PUBLIC_KEY): boolean {
  try {
    const signature = Buffer.from(decodeKeyed(record(raw)['signature']));
    const keyBytes = Buffer.from(decodeKeyed(publicKey));
    if (signature.length !== 64 || keyBytes.length !== 32) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_HEAD, keyBytes]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(quoteHash(raw), 'utf8'), key, signature);
  } catch {
    return false;
  }
}

/* The check a rail runs beside checkQuote and quoteEchoProblems, on the live quote and before the
   deposit address is used for anything. Each problem is a sentence in the rail's refusal, so the
   list is empty exactly when the response is signed by 1Click, carries the id a dispute is filed
   under, and the quote the rail is about to read is the quote that was signed. That last one is a
   consistency check on this process rather than on the network: the client hands the rail the
   same object twice, and if it ever does not, the address that was verified is not the one about
   to be paid. */
export function quoteSignatureProblems(
  response: { quote: OneClickQuote; raw: unknown },
  publicKey: string = ONECLICK_MANAGER_PUBLIC_KEY,
): string[] {
  const raw = record(response.raw);
  if (typeof raw['signature'] !== 'string' || raw['signature'] === '') {
    return ['the quote carries no signature, so nothing proves 1Click chose its deposit address'];
  }
  if (typeof raw['timestamp'] !== 'string' || raw['timestamp'] === '') {
    return ['the quote carries no timestamp, which the signature covers, so it cannot be verified'];
  }
  if (!verifyQuoteSignature(raw, publicKey)) {
    return [
      'the quote signature does not verify against 1Click\'s key, so the quote (its deposit address included) ' +
        'was changed after 1Click signed it, or was never signed by 1Click',
    ];
  }
  /* A dry quote is signed too, and its signature covers no deposit address, because a dry quote
     has none. So a signed dry response with a deposit address pasted in verifies, and it is
     exactly what a proxy holding the dry quote from this rail's own simulate could answer the
     live request with. The rails only ask here about live quotes, so the signed echo has to say
     so: `dry` is inside the signed subset, which is what makes this line mean something. */
  const echo = record(raw['quoteRequest']);
  if (echo['dry'] !== false) {
    return ['the signed quote is a dry one (its echoed request says dry), and a dry signature covers no deposit address'];
  }
  const problems: string[] = [];
  if (typeof raw['correlationId'] !== 'string' || raw['correlationId'] === '') {
    problems.push('the quote carries no correlationId, which the API always returns and a dispute is filed under');
  }
  const signed = record(raw['quote'])['depositAddress'];
  if (response.quote.depositAddress !== signed) {
    problems.push(
      `the deposit address about to be used (${oneLine(response.quote.depositAddress, 60)}) is not the deposit ` +
        `address that was signed (${oneLine(signed, 60)})`,
    );
  }
  return problems;
}

/* The four fields kept on the row. Called after quoteSignatureProblems answered with nothing, so
   every field is present; a throw here is a programming error, not a quote problem. */
export function signedQuoteRecord(response: { quote: OneClickQuote; raw: unknown }): QuoteRecord {
  const raw = record(response.raw);
  const field = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value === '') throw new Error(`signedQuoteRecord: the quote carries no ${key}`);
    return value;
  };
  const depositAddress = record(raw['quote'])['depositAddress'];
  if (typeof depositAddress !== 'string' || depositAddress === '') throw new Error('signedQuoteRecord: the quote carries no depositAddress');
  return {
    correlationId: field('correlationId'),
    timestamp: field('timestamp'),
    signature: field('signature'),
    depositAddress,
  };
}
