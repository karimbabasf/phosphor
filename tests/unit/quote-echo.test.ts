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

import { quoteEchoProblems, requestEchoProblems } from '../../src/intents.ts';
import type { QuoteEcho } from '../../src/intents.ts';
import { SWAP_MAX_LOSS_BPS, swapLossProblem } from '../../src/rails/intents-native.ts';

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

// ---------- the request 1Click priced, against the request this app sent ----------
// The end-to-end cases, the wire rewritten between the app and 1Click, are in
// tests/unit/quote-request-echo.test.ts.

const LIVE_ORIGIN = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const LIVE_DEST = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';

// What the live API echoed for a swap-shaped dry quote on 2026-10-01, with the request it answered.
const SENT = {
  dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 50, originAsset: LIVE_ORIGIN, destinationAsset: LIVE_DEST, amount: '100000000',
  depositType: 'INTENTS', refundTo: '0x1212121212121212121212121212121212121212', refundType: 'INTENTS',
  recipient: '0x1212121212121212121212121212121212121212', recipientType: 'INTENTS', deadline: '2026-10-01T22:37:38.460Z', referral: 'phosphor',
};
const LIVE_ECHO = {
  quoteRequest: {
    dry: true, depositMode: 'SIMPLE', swapType: 'EXACT_INPUT', slippageTolerance: 50, originAsset: LIVE_ORIGIN, depositType: 'INTENTS',
    destinationAsset: LIVE_DEST, amount: '100000000', refundTo: '0x1212121212121212121212121212121212121212', refundType: 'INTENTS',
    recipient: '0x1212121212121212121212121212121212121212', recipientType: 'INTENTS', deadline: '2026-10-01T22:37:38.460Z',
    confidentiality: 'public', referral: 'phosphor', quoteWaitingTimeMs: 0, insured: false,
    appFees: [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 1 }],
  },
};
function echoWith(over: Record<string, unknown>): unknown {
  return { quoteRequest: { ...LIVE_ECHO.quoteRequest, ...over } };
}

test('the echo the live API returned passes, and so does a same-asset send with no fee line', () => {
  assert.deepEqual(requestEchoProblems(LIVE_ECHO, SENT), []);
  assert.deepEqual(requestEchoProblems(echoWith({ appFees: [] }), SENT), []);
  // No echo at all is the rail's refusal to word (quoteEchoProblems), not this check's.
  assert.deepEqual(requestEchoProblems({ quote: {} }, SENT), []);
});

test('a default this app never asks for, set to anything else, refuses', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ confidentiality: 'basic' }, /confidentiality basic, which this app never asks for/],
    [{ insured: true }, /insured true/],
    [{ depositMode: 'MEMO' }, /depositMode MEMO/],
    [{ quoteWaitingTimeMs: 3000 }, /quoteWaitingTimeMs 3000/],
    [{ rebates: [{ recipient: 'x.near', share: 100 }] }, /rebates/],
    [{ connectedWallets: ['0xabc'] }, /connectedWallets/],
    [{ appFees: [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 'x' }] }, /not a number of basis points/],
    [{ appFees: { recipient: 'attacker.near', fee: 1 } }, /not a list/],
    [{ sessionId: 'abc' }, /sessionId "?abc"?, a field this app did not send/],
    [{ somethingNew: 'value' }, /somethingNew/],
  ];
  for (const [over, expected] of cases) {
    const problems = requestEchoProblems(echoWith(over), SENT);
    assert.equal(problems.length, 1, JSON.stringify(over));
    assert.match(problems[0]!, expected);
  }
  // Null is absence, the way the status endpoint writes a field the quote left out.
  assert.deepEqual(requestEchoProblems(echoWith({ virtualChainRecipient: null, customRecipientMsg: null }), SENT), []);
});

test('a field this app sent that the echo leaves out refuses', () => {
  const { referral: _gone, ...echo } = LIVE_ECHO.quoteRequest;
  assert.match(requestEchoProblems({ quoteRequest: echo }, SENT).join('; '), /referral undefined, not the phosphor this app sent/);
});

test('a swap may give up three percent of its value and no more, and an unpriced side is not judged', () => {
  assert.equal(SWAP_MAX_LOSS_BPS, 300);
  assert.equal(swapLossProblem({ amountInUsd: '100', amountOutUsd: '97.01' }), null);
  assert.equal(swapLossProblem({ amountInUsd: '100', amountOutUsd: '97' }), null);
  assert.match(String(swapLossProblem({ amountInUsd: '100', amountOutUsd: '96.9' })), /gives up 3\.1 percent/);
  // A coin 1Click prices at nothing has no figure to check by; such a swap always waits for a click.
  assert.equal(swapLossProblem({ amountInUsd: '0', amountOutUsd: '50' }), null);
  assert.equal(swapLossProblem({ amountInUsd: '100', amountOutUsd: undefined as unknown as string }), null);
});
