// The portfolio ceiling: the one bound that is not per mandate.
//
// Every other limit in this app checks a single mandate against its own envelope. Three
// separate $200 mandates each pass every one of those checks, and together they are $600 of
// standing authority that no screen and no rule ever stated. This is that number.
//
// It matters more since 2026-08-20, when the runner stopped refusing mainnet outright. The
// blanket refusal is what used to make "a bot cannot reach real money" true; these two numbers
// are what make it bounded instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAINNET_TRADING_LIMITS,
  TESTNET_TRADING_LIMITS,
  createRunnerHost,
  tradingLimitRefusal,
} from '../../src/runner/host.ts';
import type { Mandate } from '../../src/strategy/envelope.ts';

const LIMITS = { maxArmedMandates: 3, maxAggregateNotionalUsd: 250 };

function armed(...pairs: Array<[string, number]>) {
  return pairs.map(([id, maxNotionalUsd]) => ({ id, maxNotionalUsd }));
}

test('nothing armed means anything inside the ceiling is allowed', () => {
  assert.equal(tradingLimitRefusal([], { id: 'a', maxNotionalUsd: 250 }, LIMITS), null);
});

test('the count ceiling refuses the mandate that would exceed it, naming the number', () => {
  const refusal = tradingLimitRefusal(
    armed(['a', 1], ['b', 1], ['c', 1]),
    { id: 'd', maxNotionalUsd: 1 },
    LIMITS,
  );
  assert.ok(refusal !== null);
  assert.match(refusal, /3 mandates are already armed and the ceiling is 3/);
  assert.match(refusal, /standing authority, not on how much you can trade/);
});

test('the aggregate ceiling adds up what is armed, which no per-mandate rule does', () => {
  // Each of these is individually unremarkable. The third is the one that breaks the sum, and
  // before this rule existed nothing in the app would have noticed.
  const refusal = tradingLimitRefusal(armed(['a', 100], ['b', 100]), { id: 'c', maxNotionalUsd: 100 }, LIMITS);
  assert.ok(refusal !== null);
  assert.match(refusal, /\$300\.00 of standing authority/);
  assert.match(refusal, /above the \$250\.00 ceiling/);
  assert.match(refusal, /\$200\.00 is already armed/);
});

test('exactly at the ceiling is allowed; a cent over is not', () => {
  assert.equal(tradingLimitRefusal(armed(['a', 150]), { id: 'b', maxNotionalUsd: 100 }, LIMITS), null);
  assert.ok(tradingLimitRefusal(armed(['a', 150]), { id: 'b', maxNotionalUsd: 100.01 }, LIMITS) !== null);
});

test('re-arming the same id replaces it instead of counting twice', () => {
  // Same id, same size: the total is still 200, not 400.
  assert.equal(tradingLimitRefusal(armed(['a', 200]), { id: 'a', maxNotionalUsd: 200 }, LIMITS), null);
  // Same id, raised: only the new number counts, and 260 is over.
  assert.ok(tradingLimitRefusal(armed(['a', 200]), { id: 'a', maxNotionalUsd: 260 }, LIMITS) !== null);
  // A different id at the same size is the one that breaks it.
  assert.ok(tradingLimitRefusal(armed(['a', 200]), { id: 'b', maxNotionalUsd: 200 }, LIMITS) !== null);
});

test('the count rule is checked before the money rule, so the refusal names the binding one', () => {
  const refusal = tradingLimitRefusal(
    armed(['a', 1], ['b', 1], ['c', 1]),
    { id: 'd', maxNotionalUsd: 1 },
    LIMITS,
  );
  // Four tiny mandates are nowhere near $250, so a money-shaped refusal here would send a
  // reader to raise the wrong number.
  assert.ok(refusal !== null);
  assert.doesNotMatch(refusal, /ceiling \(\$/);
  assert.match(refusal, /already armed and the ceiling is/);
});

test('mainnet is the tighter profile, and both are stated rather than derived', () => {
  assert.equal(MAINNET_TRADING_LIMITS.maxAggregateNotionalUsd, 250);
  assert.equal(TESTNET_TRADING_LIMITS.maxAggregateNotionalUsd, 2500);
  assert.equal(MAINNET_TRADING_LIMITS.maxArmedMandates, 3);
  assert.ok(
    MAINNET_TRADING_LIMITS.maxAggregateNotionalUsd < TESTNET_TRADING_LIMITS.maxAggregateNotionalUsd,
    'real money gets the smaller ceiling',
  );
});

// ---------- the wiring, which is the part a pure function cannot prove ----------

function host(limits?: { maxArmedMandates: number; maxAggregateNotionalUsd: number }, killed = false) {
  return createRunnerHost({
    apiWalletKey: async () => null,
    isMainnet: false,
    baseUrl: 'https://api.hyperliquid-testnet.xyz',
    user: '0x2222222222222222222222222222222222222222',
    killSwitch: () => killed,
    onEvent: () => {},
    limits,
  });
}

function mandate(id: string, maxNotionalUsd: number): Mandate {
  return {
    id,
    programHash: 'hash-' + id,
    symbol: 'SOL',
    maxNotionalUsd,
    maxLeverage: 5,
    maxOrdersPerMin: 4,
    maxLossUsd: 20,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    allowedActions: ['open', 'close'],
  } as Mandate;
}

test('the kill switch refuses before any ceiling is consulted', async () => {
  const h = host({ maxArmedMandates: 9, maxAggregateNotionalUsd: 9_000_000 }, true);
  const out = await h.arm(mandate('a', 10), null);
  assert.equal(out.ok, false);
  assert.match(out.detail, /kill switch is on/);
});

test('a mandate over the ceiling is refused before a child is ever spawned', async () => {
  // maxArmedMandates 0 makes the very first arm exceed it, which is the only way to reach the
  // refusal without a running child: an arm that gets past this point tries to spawn one.
  const h = host({ maxArmedMandates: 0, maxAggregateNotionalUsd: 250 });
  const out = await h.arm(mandate('a', 10), null);
  assert.equal(out.ok, false);
  assert.match(out.detail, /the ceiling is 0/);
  // No API wallet exists in this harness, so a refusal that came from spawning would say so.
  assert.doesNotMatch(out.detail, /API wallet/);
});

test('a host given no limits falls back to the testnet profile rather than to none', () => {
  // The dep is optional, and an absent ceiling would be the quietest possible regression.
  assert.ok(
    tradingLimitRefusal(armed(['a', 2000]), { id: 'b', maxNotionalUsd: 2000 }, TESTNET_TRADING_LIMITS) !== null,
  );
});
