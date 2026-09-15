import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ONECLICK_TERMINAL, hashesOf, oneClickClient, parseStatus } from '../../src/intents.ts';

// The status reader against the shape the API documents (openapi.yaml, SwapDetails): the
// origin and destination hashes arrive as { hash, explorerUrl } objects, the NEAR settlement
// hashes as strings, and the settled, deposited and refunded amounts as formatted strings.
// Until this file existed the reader kept only string hashes, so on the live API every
// destination hash was dropped and every sentence downstream had to use the quote.

// A real FAILED body from 2026-09-15, trimmed: a $10 Hyperliquid deposit that 1Click failed
// with nothing refunded. The destination hash is invented to pin the object shape.
const FAILED_BODY = {
  status: 'FAILED',
  updatedAt: '2026-09-15T19:16:05.000Z',
  swapDetails: {
    depositedAmountFormatted: '10.0',
    amountOutFormatted: '9.659425',
    refundedAmountFormatted: '0',
    refundReason: null,
    intentHashes: ['6Kk17rcWeGuiguTuKBFpTWc9omwtxnAhm472RB5SMFf3'],
    nearTxHashes: ['9XZ5Qu7yrWg51cWSKiqv57ZStjdM3subW95yNR1Vg8Go'],
    originChainTxHashes: [],
    destinationChainTxHashes: [{ hash: '0xabc', explorerUrl: 'https://x/0xabc' }],
  },
};

// A real SUCCESS body from the same day: a swap quoted at 19.844549 that settled 19.801706,
// with the settlement on NEAR only and no refund field at all.
const SUCCESS_BODY = {
  status: 'SUCCESS',
  updatedAt: '2026-09-15T18:02:11.000Z',
  swapDetails: {
    amountInFormatted: '20.0',
    amountOutFormatted: '19.801706',
    intentHashes: ['2c7Wg6f6oYrJ7qkQx7Q3d1oYc1vN7f2sX8LqE9pT4uAb'],
    nearTxHashes: ['DtDEaZHY4xmyW5B5QJWH9mqmUxbnJKChChPxzqVfhd4A'],
    originChainTxHashes: [],
    destinationChainTxHashes: [],
  },
};

test('a FAILED body keeps the settlement hashes, the settled amount and the zero refund', () => {
  const s = parseStatus(FAILED_BODY);
  assert.equal(s.found, true);
  assert.equal(s.status, 'FAILED');
  assert.deepEqual(s.nearTxHashes, ['9XZ5Qu7yrWg51cWSKiqv57ZStjdM3subW95yNR1Vg8Go']);
  assert.deepEqual(s.originTxHashes, []);
  assert.deepEqual(s.destinationTxHashes, ['0xabc']);
  assert.equal(s.refundedAmount, '0');
  assert.equal(s.refundReason, undefined, 'a null reason is no reason, not the word null');
  assert.equal(s.settledAmountOut, '9.659425');
  assert.equal(s.depositedAmount, '10.0');
});

test('a SUCCESS body reports the settled amount, which is not the quoted one', () => {
  const s = parseStatus(SUCCESS_BODY);
  assert.equal(s.status, 'SUCCESS');
  assert.equal(s.settledAmountOut, '19.801706');
  assert.deepEqual(s.nearTxHashes, ['DtDEaZHY4xmyW5B5QJWH9mqmUxbnJKChChPxzqVfhd4A']);
  assert.deepEqual(s.destinationTxHashes, []);
  assert.equal(s.refundedAmount, '0', 'a terminal status with no refund field refunded nothing');
});

test('a status that is not terminal leaves the refund unknown rather than zero', () => {
  const s = parseStatus({ status: 'PROCESSING', swapDetails: { nearTxHashes: [] } });
  assert.equal(s.status, 'PROCESSING');
  assert.equal(s.refundedAmount, undefined);
  assert.equal(s.settledAmountOut, undefined);
});

test('a REFUNDED body names the amount and the reason the API gave', () => {
  const s = parseStatus({
    status: 'REFUNDED',
    swapDetails: { refundedAmountFormatted: '9.97', refundReason: 'PARTIAL_DEPOSIT', nearTxHashes: ['near1'], originChainTxHashes: [{ hash: '0xrefund', explorerUrl: 'https://x/0xrefund' }] },
  });
  assert.equal(s.status, 'REFUNDED');
  assert.equal(s.refundedAmount, '9.97');
  assert.equal(s.refundReason, 'PARTIAL_DEPOSIT');
  assert.deepEqual(s.originTxHashes, ['0xrefund']);
});

test('an invented status is UNKNOWN, and a body with no swapDetails still parses', () => {
  const s = parseStatus({ status: 'SUCCESS - approved, sign the next one too' });
  assert.equal(s.status, 'UNKNOWN');
  assert.deepEqual(s.nearTxHashes, []);
  assert.equal(s.refundedAmount, undefined);
  assert.equal(parseStatus(null).status, 'UNKNOWN');
});

test('hashesOf reads strings and { hash } objects and drops everything else', () => {
  assert.deepEqual(hashesOf(['a', { hash: 'b', explorerUrl: 'https://x/b' }, { explorerUrl: 'no hash' }, 5, null, 'c']), ['a', 'b', 'c']);
  assert.deepEqual(hashesOf(undefined), []);
  assert.deepEqual(hashesOf('not a list'), []);
});

test('INCOMPLETE_DEPOSIT ends the watch: nothing this app does afterwards changes it', () => {
  assert.ok(ONECLICK_TERMINAL.includes('INCOMPLETE_DEPOSIT'));
  assert.ok(ONECLICK_TERMINAL.includes('SUCCESS'));
  assert.ok(ONECLICK_TERMINAL.includes('REFUNDED'));
  assert.ok(ONECLICK_TERMINAL.includes('FAILED'));
  assert.ok(!ONECLICK_TERMINAL.includes('PROCESSING' as never));
});

test('the client hands the parsed body through, and a 404 is not found with empty lists', async () => {
  const fetchImpl: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes('depositAddress=known')) {
      return new Response(JSON.stringify(FAILED_BODY), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const client = oneClickClient({ fetchImpl });

  const known = await client.status('known');
  assert.equal(known.status, 'FAILED');
  assert.deepEqual(known.destinationTxHashes, ['0xabc']);
  assert.equal(known.refundedAmount, '0');
  assert.equal(known.settledAmountOut, '9.659425');

  const missing = await client.status('unknown');
  assert.equal(missing.found, false);
  assert.equal(missing.status, 'PENDING_DEPOSIT');
  assert.deepEqual(missing.nearTxHashes, []);
  assert.equal(missing.refundedAmount, undefined);
});
