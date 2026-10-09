// Where a Hyperliquid deposit in flight reads the account's credits: the trade feed's socket
// first, which the venue pushes each credit onto the moment it lands and which costs nothing to
// ask, and the venue's /info ledger only while the feed is not carrying it.
//
// Run: node --test tests/unit/hl-credit-reader.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hlCreditReader } from '../../src/rails/hypercore-deposit.ts';
import type { HlUsdcCredit } from '../../src/rails/hl-user-signed.ts';

const ACCOUNT = '0x2222222222222222222222222222222222222222';
const SINCE = Date.parse('2026-10-09T17:29:00.000Z');

function credit(atMs: number, hash: string): HlUsdcCredit {
  return { atMs, hash, usdc: 9.6594, book: 'perp' };
}

test('the feed answers when it carries the ledger, and only with credits since the moment asked about', async () => {
  const rest: Array<[string, number]> = [];
  const asked: string[] = [];
  const read = hlCreditReader({
    pushed: (account) => {
      asked.push(account);
      return [credit(SINCE + 1_000, '0xnew'), credit(SINCE - 5_000, '0xold')];
    },
    rest: async (account, sinceMs) => {
      rest.push([account, sinceMs]);
      return [];
    },
  });
  assert.deepEqual((await read(ACCOUNT, SINCE))?.map((c) => c.hash), ['0xnew']);
  assert.deepEqual(asked, [ACCOUNT]);
  assert.equal(rest.length, 0, 'the venue is not asked what the socket already said');
});

test('a feed that is not carrying the ledger hands the question to the venue', async () => {
  const rest: Array<[string, number]> = [];
  const read = hlCreditReader({
    pushed: () => null,
    rest: async (account, sinceMs) => {
      rest.push([account, sinceMs]);
      return [credit(SINCE + 2_000, '0xrest')];
    },
  });
  assert.deepEqual((await read(ACCOUNT, SINCE))?.map((c) => c.hash), ['0xrest']);
  assert.deepEqual(rest, [[ACCOUNT, SINCE]]);
});

test('a venue that will not answer is no answer, never "nothing landed"', async () => {
  const read = hlCreditReader({
    pushed: () => null,
    rest: async () => {
      throw new Error('hyperliquid userNonFundingLedgerUpdates failed: 500');
    },
  });
  assert.equal(await read(ACCOUNT, SINCE), null);
  // While a venue that answers with an empty ledger has said something: nothing landed yet.
  const empty = hlCreditReader({ pushed: () => null, rest: async () => [] });
  assert.deepEqual(await empty(ACCOUNT, SINCE), []);
});
