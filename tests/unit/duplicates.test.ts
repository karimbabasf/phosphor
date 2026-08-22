// The guard that stopped two agents doubling one proposal.
//
// This is the money-path half of removing the one-agent rule, so the cases below are written as
// the failures rather than as the feature: the same swap from two agents at once, the same swap
// with its arguments in a different order, an agent retrying its own call, and a draft that was
// refused and then corrected.
//
// Time is injected, so the window is asserted rather than slept through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDuplicateGuard, fingerprint, DUPLICATE_MS } from '../../src/duplicates.ts';

function guardFrom(start: number): { guard: ReturnType<typeof createDuplicateGuard>; advance: (ms: number) => void } {
  let now = start;
  return {
    guard: createDuplicateGuard(() => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const SWAP = { venue: 'uniswap-v3', chain: 'eth', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: 25 };

test('a second agent proposing the same thing is told which proposal already exists', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  const clash = guard.find('swap', SWAP, 'agent-b');
  assert.deepEqual(clash, { id: 'prop-1', session: 'agent-a' });
});

test('argument order is not a different proposal', () => {
  // The failure this catches is the whole point: two agents build the same call and serialise
  // its keys in different orders, and a naive fingerprint lets the race straight through.
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  const reordered = { amountIn: 25, toSymbol: 'USDC', fromSymbol: 'USDT', chain: 'eth', venue: 'uniswap-v3' };
  assert.equal(guard.find('swap', reordered, 'agent-b')?.id, 'prop-1');
});

test('an absent argument and an undefined one are the same proposal', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', { ...SWAP, note: undefined }, 'agent-a', 'prop-1');
  assert.equal(guard.find('swap', SWAP, 'agent-b')?.id, 'prop-1');
});

test('the same agent is never blocked, because an agent repeating itself is retrying', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  assert.equal(guard.find('swap', SWAP, 'agent-a'), null);
});

test('a different kind with identical arguments is a different proposal', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  assert.equal(guard.find('intents_deposit', SWAP, 'agent-b'), null);
});

test('any argument that differs at all makes it a different proposal', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  assert.equal(guard.find('swap', { ...SWAP, amountIn: 26 }, 'agent-b'), null);
  assert.equal(guard.find('swap', { ...SWAP, chain: 'base' }, 'agent-b'), null);
});

test('the window closes, so a deliberate repeat is never blocked forever', () => {
  const { guard, advance } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  advance(DUPLICATE_MS - 1);
  assert.ok(guard.find('swap', SWAP, 'agent-b'), 'still inside the window');
  advance(2);
  assert.equal(guard.find('swap', SWAP, 'agent-b'), null);
  assert.equal(guard.size(), 0, 'and the entry is gone rather than merely ignored');
});

test('re-proposing refreshes the entry, so the window is from the last one', () => {
  const { guard, advance } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  advance(DUPLICATE_MS - 1000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-2');
  advance(2000);
  assert.equal(guard.find('swap', SWAP, 'agent-b')?.id, 'prop-2', 'the newer id, and still inside its own window');
});

test('the memory is bounded, so a busy session cannot grow it without limit', () => {
  const { guard } = guardFrom(1_000_000);
  for (let i = 0; i < 500; i++) guard.remember('swap', { ...SWAP, amountIn: i }, 'agent-a', `prop-${i}`);
  assert.ok(guard.size() <= 200, `the guard is holding ${guard.size()} entries`);
  // What survives is the recent end, which is the end where a race is still possible.
  assert.equal(guard.find('swap', { ...SWAP, amountIn: 499 }, 'agent-b')?.id, 'prop-499');
});

test('the fingerprint is stable and distinguishes what it should', () => {
  assert.equal(fingerprint('swap', { a: 1, b: 2 }), fingerprint('swap', { b: 2, a: 1 }));
  assert.notEqual(fingerprint('swap', { a: 1 }), fingerprint('swap', { a: 2 }));
  assert.notEqual(fingerprint('swap', { a: 1 }), fingerprint('consolidate', { a: 1 }));
  // Nested values compare by their JSON, which is what a policy patch needs.
  assert.equal(fingerprint('policy_change', { patch: { x: 1 } }), fingerprint('policy_change', { patch: { x: 1 } }));
  assert.notEqual(fingerprint('policy_change', { patch: { x: 1 } }), fingerprint('policy_change', { patch: { x: 2 } }));
});

test('an empty proposal is still a proposal and is still guarded', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('consolidate', {}, 'agent-a', 'prop-1');
  assert.equal(guard.find('consolidate', {}, 'agent-b')?.id, 'prop-1');
});
