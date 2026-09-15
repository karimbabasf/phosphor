// The 1Click quote signature, verified the way the vendor verifies it.
//
// THE FAILURE. The deposit address is the one field in a quote this app admits it cannot check:
// the API picks it, and every rail sends the whole amount to it. 1Click signs the quote for
// exactly that reason, and the signature arrived, was kept on the response type with the comment
// "the docs say this is what resolves a dispute", and was read by nobody. A TLS position between
// this app and the API (a corporate proxy, a root another tool installed, a NODE_TLS_REJECT_
// UNAUTHORIZED=0 inherited from the launching shell) could rewrite depositAddress and leave
// quoteRequest alone; the echo check compares recipient, refundTo, assets and amount and never
// the deposit address, so the transfer went to whoever rewrote it.
//
// THE VECTORS are the vendor's own: the fixtures in src/__tests__/quote-signature.test.ts of
// @defuse-protocol/one-click-sdk-typescript, signed by 1Click's staging key. A verifier that
// passes them computes the same bytes the SDK computes, which is the only claim worth making
// about a reimplementation of somebody else's canonical form.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ONECLICK_MANAGER_PUBLIC_KEY,
  quoteHash,
  quoteSignatureProblems,
  signedQuoteRecord,
  verifyQuoteSignature,
} from '../../src/quote-signature.ts';
import { base58Decode } from '../../src/chain/near.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

const STAGING_KEY = 'ed25519:5J5tkaxyPoR3Q9S8LXfo5bWnXK5Z2bctJ4mB9gENh7co';

const STAGING_REQUEST = {
  dry: false,
  depositMode: 'SIMPLE',
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: '1cs_v1:btc:native:coin',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.stft.near',
  amount: '10000',
  refundTo: 'bc1q6mte80265ghwq4vsrpm9lnaz46uvdreu9z8wly',
  refundType: 'ORIGIN_CHAIN',
  recipient: '0xcac3C41676deF4FE375E57118f3eB83A99105577',
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-06-23T19:00:00.000Z',
  confidentiality: 'public',
  quoteWaitingTimeMs: 0,
  appFees: [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 10 }],
};

const STAGING_NON_DRY = {
  correlationId: 'd4f1b110-46cc-4682-aa3f-44d81ffe4b80',
  timestamp: '2026-06-23T17:10:41.104Z',
  signature: 'ed25519:53wcpim7FDNLbBHVezUpakthWq2TR9Lag3PwW3e8Cxmz4bFEodcc4rui5BiVHRRaHocYE9URVapzJD8JxLNDs8K9',
  quoteRequest: STAGING_REQUEST,
  quote: {
    amountIn: '10000',
    amountInFormatted: '0.0001',
    amountInUsd: '6.237600000000',
    minAmountIn: '10000',
    amountOut: '5931560',
    amountOutFormatted: '5.93156',
    amountOutUsd: '5.925171709880',
    minAmountOut: '5872244',
    timeEstimate: 812,
    refundFee: '1900',
    withdrawFee: '300000',
    deadline: '2026-06-26T19:00:00.000Z',
    timeWhenInactive: '2026-06-26T19:00:00.000Z',
    depositAddress: 'bc1q873cxltdc560dth6tpwqpehq9uvhxxcdgwnmnw',
  },
};

const STAGING_DRY = {
  correlationId: '7d6d78f0-601f-4022-9735-854a22ed9dcb',
  timestamp: '2026-06-23T17:10:55.616Z',
  signature: 'ed25519:3yVRcYGXRVj2YqrUng4Ne2yiWgh9YQfer46KW6sXiWzoyRHgsifwDp1HSZW7VLRTdKXoMgxJce22LQ9dcoihyfu5',
  quoteRequest: { ...STAGING_REQUEST, dry: true },
  quote: {
    amountIn: '10000',
    amountInFormatted: '0.0001',
    amountInUsd: '6.237600000000',
    minAmountIn: '10000',
    amountOut: '5935024',
    amountOutFormatted: '5.935024',
    amountOutUsd: '5.928631979152',
    minAmountOut: '5875673',
    timeEstimate: 812,
    refundFee: '1900',
    withdrawFee: '300000',
  },
};

// The same order as the status endpoint returns it: keys in another order, and nulls where the
// quote endpoint leaves fields out. Both have to hash to the same bytes.
const STAGING_FROM_STATUS = {
  correlationId: 'a60bbb06-4609-4976-873a-1f2f72c080e4',
  timestamp: '2026-06-23T17:10:41.104Z',
  signature: STAGING_NON_DRY.signature,
  quoteRequest: {
    dry: false,
    swapType: 'EXACT_INPUT',
    depositMode: 'SIMPLE',
    slippageTolerance: 100,
    originAsset: '1cs_v1:btc:native:coin',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.stft.near',
    amount: '10000',
    refundTo: 'bc1q6mte80265ghwq4vsrpm9lnaz46uvdreu9z8wly',
    refundType: 'ORIGIN_CHAIN',
    recipient: '0xcac3C41676deF4FE375E57118f3eB83A99105577',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-06-23T19:00:00.000Z',
    appFees: [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 10 }],
    virtualChainRecipient: null,
    virtualChainRefundRecipient: null,
    referral: null,
    confidentiality: 'public',
  },
  quote: {
    amountIn: '10000',
    amountInFormatted: '0.0001',
    amountInUsd: '6.237600000000',
    minAmountIn: '10000',
    amountOut: '5931560',
    amountOutFormatted: '5.93156',
    amountOutUsd: '5.925171709880',
    minAmountOut: '5872244',
    timeWhenInactive: '2026-06-26T19:00:00.000Z',
    depositAddress: 'bc1q873cxltdc560dth6tpwqpehq9uvhxxcdgwnmnw',
    deadline: '2026-06-26T19:00:00.000Z',
    timeEstimate: 812,
    refundFee: '1900',
    withdrawFee: '300000',
  },
};

test('the production key is a 32 byte ed25519 key with the NEAR prefix', () => {
  assert.match(ONECLICK_MANAGER_PUBLIC_KEY, /^ed25519:/);
  assert.equal(base58Decode(ONECLICK_MANAGER_PUBLIC_KEY.slice('ed25519:'.length)).length, 32);
});

test("the vendor's staging fixtures verify: non-dry, dry, and the status endpoint's shape of the same quote", () => {
  assert.equal(verifyQuoteSignature(STAGING_NON_DRY, STAGING_KEY), true, 'non-dry');
  assert.equal(verifyQuoteSignature(STAGING_DRY, STAGING_KEY), true, 'dry');
  assert.equal(verifyQuoteSignature(STAGING_FROM_STATUS, STAGING_KEY), true, 'status shape');
  // The two shapes of one quote are one message.
  assert.equal(quoteHash(STAGING_FROM_STATUS), quoteHash(STAGING_NON_DRY));
});

test('a deposit address changed after signing is refused, and so is every other signed field', () => {
  const tampered = { ...STAGING_NON_DRY, quote: { ...STAGING_NON_DRY.quote, depositAddress: 'bc1q0000000000000000000000000000000000000000' } };
  assert.equal(verifyQuoteSignature(tampered, STAGING_KEY), false);
  for (const [field, value] of [
    ['amountOut', '9931560'],
    ['minAmountOut', '1'],
    ['deadline', '2027-06-26T19:00:00.000Z'],
    ['depositMemo', 'pay-me'],
  ] as const) {
    const changed = { ...STAGING_NON_DRY, quote: { ...STAGING_NON_DRY.quote, [field]: value } };
    assert.equal(verifyQuoteSignature(changed, STAGING_KEY), false, `${field} is signed`);
  }
  const otherRecipient = { ...STAGING_NON_DRY, quoteRequest: { ...STAGING_REQUEST, recipient: '0x0000000000000000000000000000000000000001' } };
  assert.equal(verifyQuoteSignature(otherRecipient, STAGING_KEY), false, 'the echoed request is signed too');
  const laterStamp = { ...STAGING_NON_DRY, timestamp: '2026-06-23T17:10:41.105Z' };
  assert.equal(verifyQuoteSignature(laterStamp, STAGING_KEY), false, 'the timestamp is signed');
});

test('no signature, an empty one, a malformed one, a wrong key and a missing timestamp all refuse', () => {
  assert.equal(verifyQuoteSignature({ ...STAGING_NON_DRY, signature: '' }, STAGING_KEY), false);
  assert.equal(verifyQuoteSignature({ ...STAGING_NON_DRY, signature: undefined }, STAGING_KEY), false);
  assert.equal(verifyQuoteSignature({ ...STAGING_NON_DRY, signature: 'not-a-valid-signature' }, STAGING_KEY), false);
  assert.equal(
    verifyQuoteSignature({ ...STAGING_NON_DRY, signature: 'ed25519:5fVqoCrPgqS9WPqnX5xvHKNYBqRZPkXvEqM9VaHZXgBbPYp7qZzx5HkNvZxQK1hBkD2qT8GJfXwR9nL4mS6vYt2' }, STAGING_KEY),
    false,
  );
  assert.equal(verifyQuoteSignature({ ...STAGING_NON_DRY, timestamp: undefined }, STAGING_KEY), false);
  // The staging key is not the production key, so a staging quote fails the default.
  assert.equal(verifyQuoteSignature(STAGING_NON_DRY), false);
  assert.equal(verifyQuoteSignature(STAGING_NON_DRY, 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifd'), false);
  assert.equal(verifyQuoteSignature(null, STAGING_KEY), false);
  assert.equal(verifyQuoteSignature('quote', STAGING_KEY), false);
});

test('the rail-facing check names the reason, and the record carries the four fields a dispute needs', () => {
  const good = { quote: STAGING_NON_DRY.quote, raw: STAGING_NON_DRY };
  assert.deepEqual(quoteSignatureProblems(good, STAGING_KEY), []);
  assert.deepEqual(signedQuoteRecord(good), {
    correlationId: 'd4f1b110-46cc-4682-aa3f-44d81ffe4b80',
    timestamp: '2026-06-23T17:10:41.104Z',
    signature: STAGING_NON_DRY.signature,
    depositAddress: 'bc1q873cxltdc560dth6tpwqpehq9uvhxxcdgwnmnw',
  });

  const unsigned = { quote: STAGING_NON_DRY.quote, raw: { ...STAGING_NON_DRY, signature: undefined } };
  assert.match(quoteSignatureProblems(unsigned, STAGING_KEY).join(' '), /carries no signature/);

  const tampered = { ...STAGING_NON_DRY, quote: { ...STAGING_NON_DRY.quote, depositAddress: 'bc1q0000000000000000000000000000000000000000' } };
  assert.match(quoteSignatureProblems({ quote: tampered.quote, raw: tampered }, STAGING_KEY).join(' '), /signature does not verify/);

  // The quote the rail reads has to be the quote that was signed, not a copy with a different address.
  const swapped = { quote: tampered.quote, raw: STAGING_NON_DRY };
  assert.match(quoteSignatureProblems(swapped, STAGING_KEY).join(' '), /not the deposit address that was signed/);

  const noId = { quote: STAGING_NON_DRY.quote, raw: { ...STAGING_NON_DRY, correlationId: undefined } };
  assert.match(quoteSignatureProblems(noId, STAGING_KEY).join(' '), /correlationId/);
});

/* THE DRY REPLAY. A dry quote is signed as well, and its signature covers no deposit address,
   because a dry quote has none. So a proxy that kept the signed dry answer to this app's own
   simulate can answer the live request with it plus a deposit address of its choosing, and the
   signature verifies. The rails ask about live quotes only, so a signed echo that says dry is
   refused whatever else it carries. */
test('a signed dry quote with a deposit address pasted in verifies as a signature and is refused as a live quote', () => {
  const pasted = { ...STAGING_DRY, quote: { ...STAGING_DRY.quote, depositAddress: 'bc1qattacker0000000000000000000000000000000' } };
  assert.equal(verifyQuoteSignature(pasted, STAGING_KEY), true, 'the signature itself is fine: it never covered the address');
  const problems = quoteSignatureProblems({ quote: pasted.quote, raw: pasted }, STAGING_KEY);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /dry/);
  // Flipping the flag to make it look live breaks the signature, because dry is signed.
  const flipped = { ...pasted, quoteRequest: { ...pasted.quoteRequest, dry: false } };
  assert.match(quoteSignatureProblems({ quote: flipped.quote, raw: flipped }, STAGING_KEY).join(' '), /does not verify/);
});

test('the test signer produces quotes the verifier accepts under its own key and nothing else', () => {
  const raw = signQuote({ quoteRequest: { ...STAGING_REQUEST }, quote: { ...STAGING_NON_DRY.quote } });
  assert.equal(verifyQuoteSignature(raw, TEST_QUOTE_KEY), true);
  assert.equal(verifyQuoteSignature(raw), false, 'a test signature is worth nothing against the production key');
  assert.equal(verifyQuoteSignature(raw, STAGING_KEY), false);
  const moved = { ...raw, quote: { ...(raw.quote as Record<string, unknown>), depositAddress: 'bc1qattacker' } };
  assert.equal(verifyQuoteSignature(moved, TEST_QUOTE_KEY), false);
  // The helper's key is a fresh pair per process, never anything a build could carry.
  assert.notEqual(TEST_QUOTE_KEY, ONECLICK_MANAGER_PUBLIC_KEY);
  assert.equal(base58Decode(TEST_QUOTE_KEY.slice('ed25519:'.length)).length, 32);
});
