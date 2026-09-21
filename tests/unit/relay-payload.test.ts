// The payload the relay swap rail signs: built here, read back here, one refusal per way it
// could say something other than the swap a human approved (spec, "The payload we build").
// Nothing here touches a network or a key.
//
// Run: node --test tests/unit/relay-payload.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RelayQuote } from '../../src/relay/client.ts';
import {
  MAX_DEADLINE_MS,
  NONCE_MAGIC,
  buildNonce,
  buildTokenDiffPayload,
  checkTokenDiffPayload,
  deadlineFor,
  decodeNonce,
  pickQuote,
} from '../../src/relay/payload.ts';
import type { TokenDiffExpectation } from '../../src/relay/payload.ts';

const OWNER = '0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050';
const ACCOUNT = OWNER.toLowerCase();
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDT = 'nep141:usdt.tether-token.near';
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const DEADLINE = new Date(NOW + 60_000).toISOString();
const SALT = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]);
const RANDOM = Uint8Array.from(Buffer.from('027015ec13dc11864973138fe6812f', 'hex'));

function nonceFor(deadlineMs: number = NOW + 60_000 + 7 * 24 * 3_600_000): string {
  return buildNonce({ salt: SALT, deadlineMs, random: RANDOM });
}

function expectOf(over: Partial<TokenDiffExpectation> = {}): TokenDiffExpectation {
  return {
    signerId: OWNER,
    assetIn: USDC,
    assetOut: USDT,
    amountIn: 2_000_000n,
    minOut: 1_950_000n,
    quoteOut: 1_961_996n,
    now: NOW,
    maxDeadlineMs: MAX_DEADLINE_MS,
    usedNonces: new Set(),
    salt: SALT,
    ...over,
  };
}

function payloadOf(over: Record<string, unknown> = {}, nonce: string = nonceFor()): string {
  return JSON.stringify({
    signer_id: ACCOUNT,
    verifying_contract: 'intents.near',
    deadline: DEADLINE,
    nonce,
    intents: [{ intent: 'token_diff', diff: { [USDC]: '-2000000', [USDT]: '1961996' } }],
    ...over,
  });
}

// ---------- the nonce ----------

/* The worked example in near/intents contracts/defuse/README.md ("Nonces"): salt 252812b3,
   deadline 2280047743 s, fifteen random bytes 027015ec13dc11864973138fe6812f, and the base64
   the contract reads back. A byte off anywhere in the layout changes this string. */
test('buildNonce reproduces the verifier README vector byte for byte', () => {
  const nonce = buildNonce({ salt: SALT, deadlineMs: 2_280_047_743_000, random: RANDOM });
  assert.equal(nonce, 'Vij2xgAlKBKzADZykFdbpB8CcBXsE9wRhklzE4/mgS8=');
  const bytes = Buffer.from(nonce, 'base64');
  assert.equal(bytes.length, 32);
  assert.deepEqual([...bytes.subarray(0, 4)], [...NONCE_MAGIC]);
  assert.equal(bytes[4], 0, 'version byte');
  assert.equal(bytes.subarray(5, 9).toString('hex'), '252812b3');
  assert.equal(bytes.subarray(9, 17).toString('hex'), '00367290575ba41f', 'deadline in ns, little-endian');
});

test('decodeNonce reads the parts back and refuses anything that is not a 32-byte V1 nonce', () => {
  const nonce = nonceFor(NOW + 5_000);
  const parts = decodeNonce(nonce);
  assert.ok(parts !== null);
  assert.deepEqual([...parts.salt], [...SALT]);
  assert.equal(parts.deadlineMs, NOW + 5_000);
  assert.deepEqual([...parts.random], [...RANDOM]);

  assert.equal(decodeNonce(''), null);
  assert.equal(decodeNonce(Buffer.alloc(31).toString('base64')), null, 'short');
  assert.equal(decodeNonce(Buffer.alloc(33).toString('base64')), null, 'long');
  // A legacy nonce: 32 random bytes with no magic prefix.
  assert.equal(decodeNonce(Buffer.from('a'.repeat(32)).toString('base64')), null, 'legacy shape');
  // Non-canonical base64 of the right length is not the nonce it decodes to.
  assert.equal(decodeNonce(nonce.slice(0, -1) + '!'), null);
});

test('buildNonce refuses parts of the wrong size rather than padding them', () => {
  assert.throws(() => buildNonce({ salt: Uint8Array.from([1, 2, 3]), deadlineMs: NOW, random: RANDOM }), /salt is 4 bytes/);
  assert.throws(() => buildNonce({ salt: SALT, deadlineMs: NOW, random: RANDOM.subarray(0, 14) }), /15 random bytes/);
  assert.throws(() => buildNonce({ salt: SALT, deadlineMs: Number.NaN, random: RANDOM }), /deadline/);
});

// ---------- the deadline ----------

test('deadlineFor is the quote expiry capped at 120 s out, never past the quote', () => {
  const soon = new Date(NOW + 40_000).toISOString();
  assert.equal(deadlineFor(soon, NOW), soon);
  const late = new Date(NOW + 10 * 60_000).toISOString();
  assert.equal(deadlineFor(late, NOW), new Date(NOW + MAX_DEADLINE_MS).toISOString());
  assert.equal(MAX_DEADLINE_MS, 120_000);
});

// ---------- the payload ----------

test('buildTokenDiffPayload writes the spend first, the credit second, the signer lowercased, and nothing else', () => {
  const nonce = nonceFor();
  const text = buildTokenDiffPayload({ signerId: OWNER, assetIn: USDC, assetOut: USDT, amountIn: 2_000_000n, amountOut: 1_961_996n, deadline: DEADLINE, nonce });
  assert.equal(text, payloadOf({}, nonce), 'serialised once, in the fixed key order');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['signer_id', 'verifying_contract', 'deadline', 'nonce', 'intents']);
  assert.equal(parsed['signer_id'], ACCOUNT);
  const diff = (parsed['intents'] as Array<{ diff: Record<string, string> }>)[0].diff;
  assert.deepEqual(Object.keys(diff), [USDC, USDT]);
  assert.equal(diff[USDC], '-2000000');
  assert.equal(diff[USDT], '1961996');
});

test('buildTokenDiffPayload refuses a zero amount and a single asset', () => {
  assert.throws(() => buildTokenDiffPayload({ signerId: OWNER, assetIn: USDC, assetOut: USDT, amountIn: 0n, amountOut: 1n, deadline: DEADLINE, nonce: nonceFor() }), /positive/);
  assert.throws(() => buildTokenDiffPayload({ signerId: OWNER, assetIn: USDC, assetOut: USDC, amountIn: 1n, amountOut: 1n, deadline: DEADLINE, nonce: nonceFor() }), /two different assets/);
});

test('a payload built from the draft and the chosen quote passes every check', () => {
  assert.deepEqual(checkTokenDiffPayload(payloadOf(), expectOf()), []);
});

// One test per refusal row of the table in the spec, in the table's order.

test('refuses any verifying contract but intents.near', () => {
  const problems = checkTokenDiffPayload(payloadOf({ verifying_contract: 'intents-v2.near' }), expectOf());
  assert.match(problems[0] ?? '', /verifying contract/);
});

test('refuses a signer that is not our address, and our address in any other case', () => {
  assert.match(checkTokenDiffPayload(payloadOf({ signer_id: '0x1111111111111111111111111111111111111111' }), expectOf())[0] ?? '', /authored for/);
  assert.match(checkTokenDiffPayload(payloadOf({ signer_id: OWNER }), expectOf())[0] ?? '', /authored for/, 'checksummed is not the account the verifier keys');
});

test('refuses a nonce that is missing, short, of the legacy shape, or already signed in this process', () => {
  assert.match(checkTokenDiffPayload(payloadOf({ nonce: undefined }), expectOf())[0] ?? '', /32-byte versioned nonce/);
  assert.match(checkTokenDiffPayload(payloadOf({ nonce: Buffer.alloc(16).toString('base64') }), expectOf())[0] ?? '', /32-byte versioned nonce/);
  assert.match(checkTokenDiffPayload(payloadOf({ nonce: Buffer.from('b'.repeat(32)).toString('base64') }), expectOf())[0] ?? '', /32-byte versioned nonce/);
  const nonce = nonceFor();
  assert.match(checkTokenDiffPayload(payloadOf({}, nonce), expectOf({ usedNonces: new Set([nonce]) }))[0] ?? '', /reuses a nonce/);
});

test('refuses a nonce whose salt is not the one read from the verifier, or when none was read', () => {
  const other = buildNonce({ salt: Uint8Array.from([0, 0, 0, 1]), deadlineMs: NOW + 3_600_000, random: RANDOM });
  assert.match(checkTokenDiffPayload(payloadOf({}, other), expectOf())[0] ?? '', /salt/);
  assert.match(checkTokenDiffPayload(payloadOf(), expectOf({ salt: undefined }))[0] ?? '', /salt/);
});

test('refuses a deadline that is absent, past, or more than 120 s out, and a nonce that expires before the intent', () => {
  assert.match(checkTokenDiffPayload(payloadOf({ deadline: undefined }), expectOf())[0] ?? '', /not a timestamp/);
  assert.match(checkTokenDiffPayload(payloadOf({ deadline: new Date(NOW - 1).toISOString() }), expectOf())[0] ?? '', /already passed/);
  assert.match(checkTokenDiffPayload(payloadOf({ deadline: new Date(NOW + 120_001).toISOString() }), expectOf())[0] ?? '', /more than 120 s/);
  assert.deepEqual(checkTokenDiffPayload(payloadOf({ deadline: new Date(NOW + 120_000).toISOString() }), expectOf()), [], 'exactly 120 s is the edge and passes');
  const early = nonceFor(NOW + 30_000);
  assert.match(checkTokenDiffPayload(payloadOf({}, early), expectOf())[0] ?? '', /nonce expires before the intent/);
});

test('refuses any count of intents but one, any kind but token_diff, and any key count but two', () => {
  const diff = { [USDC]: '-2000000', [USDT]: '1961996' };
  assert.match(checkTokenDiffPayload(payloadOf({ intents: [] }), expectOf())[0] ?? '', /bundles 0 actions/);
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff }, { intent: 'ft_withdraw', token: 'usdt.near', receiver_id: 'bob.near', amount: '1' }] }), expectOf())[0] ?? '',
    /bundles 2 actions/,
  );
  assert.match(checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'transfer', receiver_id: 'bob.near', tokens: { [USDC]: '2000000' } }] }), expectOf())[0] ?? '', /not the token_diff/);
  assert.match(checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { ...diff, 'nep141:wrap.near': '1' } }] }), expectOf())[0] ?? '', /moves 3 assets/);
  assert.match(checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { [USDC]: '-2000000' } }] }), expectOf())[0] ?? '', /moves 1 assets/);
  assert.match(checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff, referral: 'somebody.near' }] }), expectOf())[0] ?? '', /never writes/);
});

test('refuses a negative side that is another asset or another amount', () => {
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { 'nep141:wrap.near': '-2000000', [USDT]: '1961996' } }] }), expectOf())[0] ?? '',
    /does not spend/,
  );
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { [USDC]: '-2000001', [USDT]: '1961996' } }] }), expectOf())[0] ?? '',
    /spends 2000001 base units, not the 2000000/,
  );
});

test('refuses a positive side that is another asset, under the floor, or not the chosen quote', () => {
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { [USDC]: '-2000000', 'nep141:wrap.near': '1961996' } }] }), expectOf())[0] ?? '',
    /does not deliver/,
  );
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { [USDC]: '-2000000', [USDT]: '1949999' } }] }), expectOf({ quoteOut: 1_949_999n }))[0] ?? '',
    /below the 1950000 floor/,
  );
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { [USDC]: '-2000000', [USDT]: '1961995' } }] }), expectOf())[0] ?? '',
    /not the 1961996 the chosen quote offers/,
  );
});

test('refuses the same asset on both sides', () => {
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { [USDC]: '-2000000', [USDT]: '1961996' } }] }), expectOf({ assetOut: USDC }))[0] ?? '',
    /same asset on both sides/,
  );
});

test('refuses a key spelled twice, an amount that is not a decimal string, and a stray top-level key', () => {
  const twice = payloadOf().replace('"intents":[', `"intents":[{"intent":"token_diff","diff":{"${USDC}":"-1","${USDT}":"1"}}],"intents":[`);
  assert.match(checkTokenDiffPayload(twice, expectOf())[0] ?? '', /names intents twice/);
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { [USDC]: -2000000, [USDT]: '1961996' } }] }), expectOf())[0] ?? '',
    /input leg .* no negative decimal amount/,
  );
  assert.match(
    checkTokenDiffPayload(payloadOf({ intents: [{ intent: 'token_diff', diff: { [USDC]: '-2000000', [USDT]: '1.961996e6' } }] }), expectOf())[0] ?? '',
    /output leg .* no decimal amount/,
  );
  assert.match(checkTokenDiffPayload(payloadOf({ memo: 'hello' }), expectOf())[0] ?? '', /never writes/);
});

test('refuses a payload that is not a JSON object string, and a draft with no floor', () => {
  assert.match(checkTokenDiffPayload(undefined, expectOf())[0] ?? '', /must be a JSON string/);
  assert.match(checkTokenDiffPayload('[1]', expectOf())[0] ?? '', /not a JSON object/);
  assert.match(checkTokenDiffPayload('{"signer_id":', expectOf())[0] ?? '', /not valid JSON/);
  assert.match(checkTokenDiffPayload(payloadOf(), expectOf({ minOut: 0n }))[0] ?? '', /no slippage floor/);
});

// ---------- the quote ----------

function quoteOf(over: Partial<RelayQuote> = {}): RelayQuote {
  return {
    quoteHash: 'Cw6dV7MV3NvKRNrXjLpymkWneBzuhTjrgEYuQLwnnCg6',
    assetIn: USDC,
    assetOut: USDT,
    amountIn: '2000000',
    amountOut: '1961996',
    expirationTime: new Date(NOW + 60_000).toISOString(),
    ...over,
  };
}

const WANT = { assetIn: USDC, assetOut: USDT, amountIn: 2_000_000n, now: NOW, minAheadMs: 15_000 };

test('pickQuote takes the largest amount_out among quotes with the right amount_in and pair', () => {
  const pick = pickQuote([quoteOf({ quoteHash: 'a', amountOut: '1961996' }), quoteOf({ quoteHash: 'b', amountOut: '1970000' }), quoteOf({ quoteHash: 'c', amountOut: '1965000' })], WANT);
  assert.equal(pick.chosen?.quoteHash, 'b');
  assert.deepEqual(pick.passed, []);
});

test('pickQuote passes over a quote for another amount_in, another pair, or one expiring inside 15 s', () => {
  const pick = pickQuote(
    [
      quoteOf({ quoteHash: 'wrong-amount', amountIn: '1999999', amountOut: '9000000' }),
      quoteOf({ quoteHash: 'wrong-pair', assetOut: 'nep141:wrap.near', amountOut: '9000000' }),
      quoteOf({ quoteHash: 'expiring', amountOut: '9000000', expirationTime: new Date(NOW + 14_999).toISOString() }),
      quoteOf({ quoteHash: 'ok', amountOut: '1961996', expirationTime: new Date(NOW + 15_000).toISOString() }),
    ],
    WANT,
  );
  assert.equal(pick.chosen?.quoteHash, 'ok');
  assert.equal(pick.passed.length, 3);
  assert.match(pick.passed[0], /not the 2000000 the draft spends/);
  assert.match(pick.passed[1], /not the pair/);
  assert.match(pick.passed[2], /inside 15 s/);
});

test('pickQuote chooses nothing from an empty list, and the floor is not its business', () => {
  assert.equal(pickQuote([], WANT).chosen, null);
  // A quote under any floor is still the best quote; the rail refuses or holds on it.
  assert.equal(pickQuote([quoteOf({ amountOut: '1' })], WANT).chosen?.amountOut, '1');
});
