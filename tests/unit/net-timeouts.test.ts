// Every network call has a deadline, and the deadline is one module's decision.
//
// Node and undici fall back to a 300 second headers timeout when no signal is given, so before
// this every hang cost about five minutes of a wallet-holding process sitting still. Four of the
// sites sat between "the human approved" and "the funds are irrecoverable".
//
// The mechanical test at the bottom is the one that keeps this true: it counts the fetch sites
// in src/ and the ones passing a signal, and fails when a new call arrives without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withTimeout, readTimeout, venueWriteTimeout, isTimeout, READ_TIMEOUT_MS, VENUE_WRITE_TIMEOUT_MS } from '../../src/net.ts';
import { auditFetchSites } from '../../scripts/fetch-audit.ts';
import { intentsDepositRail } from '../../src/rails/intents-deposit.ts';
import { oneClickClient } from '../../src/intents.ts';

test('the two budgets are ten and thirty seconds, and a write is the longer one', () => {
  assert.equal(READ_TIMEOUT_MS, 10_000);
  assert.equal(VENUE_WRITE_TIMEOUT_MS, 30_000);
  assert.ok(VENUE_WRITE_TIMEOUT_MS > READ_TIMEOUT_MS);
});

test('each call gets its own signal, never a shared clock', () => {
  const a = readTimeout();
  const b = readTimeout();
  assert.notEqual(a, b, 'a shared signal would give the second request the first one\'s leftovers');
  assert.equal(a.aborted, false);
  assert.equal(venueWriteTimeout().aborted, false);
});

test('the signal actually fires', async () => {
  const signal = withTimeout(20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as Error).name, 'TimeoutError');
});

test('isTimeout recognises a timeout however deeply it is wrapped', () => {
  assert.equal(isTimeout({ name: 'TimeoutError' }), true);
  assert.equal(isTimeout({ name: 'AbortError' }), true);
  assert.equal(isTimeout({ name: 'HttpRequestError', cause: { name: 'TimeoutError' } }), true);
  assert.equal(isTimeout(new Error('connection refused')), false);
  assert.equal(isTimeout(null), false);
  assert.equal(isTimeout('a string'), false);
});

// The behavioural half: the deadline reaches the call, and the caller lets it through as a
// timeout rather than swallowing it. The fake fetch checks the signal arrived and then fails the
// way an expired one does, so the assertion costs milliseconds instead of the real ten seconds
// (that the signal itself fires is the test above).
function hungFetch(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new Error('no signal was passed, so this call would hang for five minutes'));
    }
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    return Promise.reject(err);
  }) as typeof fetch;
}

test('the 1Click client passes its deadline down and lets a timeout through', async () => {
  const client = oneClickClient({ fetchImpl: hungFetch() });
  await assert.rejects(
    () => client.tokens(),
    (err: unknown) => {
      assert.equal(isTimeout(err), true, `expected a timeout, got ${String(err)}`);
      return true;
    },
  );
});

test('a rail whose venue hangs reports a timeout rather than sitting for five minutes', async () => {
  const rail = intentsDepositRail({
    keysPath: '/nonexistent/keys.json',
    tokens: { eth: {}, base: {}, arb: {}, sol: {}, near: {} } as never,
    fetchImpl: hungFetch(),
  });
  const out = await rail.simulate({
    kind: 'intents_deposit',
    chain: 'eth',
    symbol: 'ETH',
    tokenId: 'native',
    amount: 1,
    amountUsd: 10,
    from: '0x1111111111111111111111111111111111111111',
    intentsAccount: '0x1111111111111111111111111111111111111111',
    counterparty: 'oneclick:1click.chaindefuser.com',
  } as never);

  assert.equal(out.ok, false);
  assert.doesNotMatch(String(out.error ?? ''), /no signal was passed/, 'the rail handed the fetch a deadline');
});

// The gate. Not a style rule: a fetch without a deadline is a five minute stall in a process
// holding keys, and the only way to keep this true is to count.
test('every fetch site in src passes a signal', () => {
  const sites = auditFetchSites();
  const missing = sites.filter((s) => !s.hasSignal).map((s) => `${s.file}:${s.line}`);
  assert.deepEqual(missing, [], 'these network calls have no deadline');
  assert.ok(sites.length >= 30, `expected the scanner to still be finding the call sites, found ${sites.length}`);
});
