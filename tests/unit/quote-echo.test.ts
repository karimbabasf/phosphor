// The quoteRequest echo check, on its own.
//
// The API echoes the request it priced, verbatim, and that echo is the only place a quote states
// where the money ends up. Two rails checked it and three did not, which is how the same defect
// was found twice: a quote priced to credit a different recipient, or to take its input from a
// chain transfer rather than the verifier balance, passed every check the three without it made.
//
// Run: node --test tests/unit/quote-echo.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

import { quoteEchoProblems } from '../../src/intents.ts';
import type { QuoteEcho } from '../../src/intents.ts';

const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL = 'So11111111111111111111111111111111111111112';

function want(over: Partial<QuoteEcho> = {}): QuoteEcho {
  return {
    recipient: EVM,
    recipientVerb: 'pay',
    recipientNoun: 'wallet',
    recipientType: 'DESTINATION_CHAIN',
    recipientTypeWhy: 'a payout anywhere else is not what was approved',
    depositType: 'ORIGIN_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    refundTypeWhy: 'back to the wallet the funds left',
    refundTo: EVM,
    originAsset: 'nep141:base-usdc.omft.near',
    destinationAsset: 'nep141:arb-usdt.omft.near',
    amount: '100000000',
    noEcho: 'nothing ties it to a destination and it is refused.',
    ...over,
  };
}

function echoOf(over: Record<string, unknown> = {}): unknown {
  const w = want();
  return {
    quoteRequest: {
      recipient: w.recipient,
      recipientType: w.recipientType,
      depositType: w.depositType,
      refundType: w.refundType,
      refundTo: w.refundTo,
      originAsset: w.originAsset,
      destinationAsset: w.destinationAsset,
      amount: w.amount,
      ...over,
    },
  };
}

test('a quote echoing exactly what was asked for raises nothing', () => {
  assert.deepEqual(quoteEchoProblems(echoOf(), want()), []);
});

test('a quote that echoes a different recipient is refused', () => {
  const problems = quoteEchoProblems(echoOf({ recipient: '0x000000000000000000000000000000000000dEaD' }), want());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /priced to pay/);
});

test('a quote with no echo at all is refused, and the refusal says why this rail needs one', () => {
  const problems = quoteEchoProblems({}, want());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /carries no quoteRequest echo/);
  assert.match(problems[0], /nothing ties it to a destination/);
});

test('an echo that is not an object is refused rather than read field by field', () => {
  assert.match(quoteEchoProblems({ quoteRequest: 'ok' }, want())[0], /no quoteRequest echo/);
  assert.match(quoteEchoProblems({ quoteRequest: [] }, want())[0], /no quoteRequest echo/);
  assert.match(quoteEchoProblems(null, want())[0], /not an object/);
});

test('every routing field is checked, not only the recipient', () => {
  assert.match(quoteEchoProblems(echoOf({ recipientType: 'INTENTS' }), want())[0], /not DESTINATION_CHAIN/);
  assert.match(quoteEchoProblems(echoOf({ depositType: 'INTENTS' }), want())[0], /takes its input as INTENTS/);
  assert.match(quoteEchoProblems(echoOf({ refundType: 'INTENTS' }), want())[0], /back to the wallet the funds left/);
  assert.match(quoteEchoProblems(echoOf({ refundTo: SOL }), want())[0], /refund on this quote goes to/);
  assert.match(quoteEchoProblems(echoOf({ amount: '1' }), want())[0], /priced for 1 base units/);
  assert.match(quoteEchoProblems(echoOf({ destinationAsset: 'nep141:wrap.near' }), want())[0], /the quote moves/);
});

// ---------- the case rule ----------
//
// base58 case carries key material: two Solana strings differing only in case are two different
// accounts. An EVM address is the one exception, because the same 20 bytes have a checksummed
// spelling and a lowercase one and both name the same account.

test('an EVM recipient matches whatever its checksum casing', () => {
  assert.deepEqual(quoteEchoProblems(echoOf({ recipient: EVM.toLowerCase() }), want()), []);
});

test('a Solana recipient differing only in case is a different account and is refused', () => {
  const lowered = SOL.toLowerCase();
  assert.notEqual(lowered, SOL);
  const problems = quoteEchoProblems(echoOf({ recipient: lowered }), want({ recipient: SOL }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /priced to pay/);
});

test('a NEAR account id is compared exactly too', () => {
  const problems = quoteEchoProblems(echoOf({ recipient: 'Phosphor.near' }), want({ recipient: 'phosphor.near' }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /priced to pay/);
});

test('a missing recipient is a mismatch, never a pass', () => {
  const problems = quoteEchoProblems(echoOf({ recipient: undefined }), want());
  assert.ok(problems.some((p) => /priced to pay/.test(p)));
});
