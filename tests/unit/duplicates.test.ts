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

import { createDuplicateGuard, fingerprint, stillInFlight, DUPLICATE_MS } from '../../src/duplicates.ts';
import type { Proposal } from '../../src/types.ts';

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

test('the same agent is not blocked from repeating a proposal that has settled', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  assert.equal(guard.find('swap', SWAP, 'agent-a'), null);
});

/* THE INCIDENT. 2026-09-15: one "deposit $10" moved $20. The propose held its reply open past
   the proxy's patience, the proxy said the app was not running, the agent proposed the same
   thing again, and this guard let it through because a repeat from the same session was read
   as a harmless retry. It is a harmless retry only once the first one has settled. While the
   first is still being drafted (no id yet) or still running, the repeat is a second spend. */
test('the same session cannot repeat a proposal that is still being drafted', () => {
  const g = createDuplicateGuard(() => 1000);
  g.remember('hl_deposit', { amount: 10 }, 's1', '');
  assert.deepEqual(g.find('hl_deposit', { amount: 10 }, 's1'), { id: '', session: 's1' });
});

test('the same session cannot repeat a proposal whose row is still in flight', () => {
  const live = new Set(['prop-1']);
  const g = createDuplicateGuard(() => 1000, undefined, { inFlight: (id) => live.has(id) });
  g.remember('hl_deposit', { amount: 10 }, 's1', 'prop-1');
  assert.deepEqual(g.find('hl_deposit', { amount: 10 }, 's1'), { id: 'prop-1', session: 's1' });
  // The rail answered: from here a repeat by the same session is its own business again.
  live.delete('prop-1');
  assert.equal(g.find('hl_deposit', { amount: 10 }, 's1'), null);
  // And a different session is still refused inside the window, in flight or not.
  assert.equal(g.find('hl_deposit', { amount: 10 }, 's2')?.id, 'prop-1');
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

/* ---------- the claim, and giving it back ----------

   The guard is only as good as WHEN it is written to. handlePropose checked `find` and then
   awaited the whole draft, quote and policy pipeline before calling `remember`, so two identical
   requests in one tick both found an empty memory. The claim is made in the same tick as the
   check now, with no id yet, and rewritten with the real id when the proposal exists. */

test('a claim with no id yet still blocks a second agent', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', '');
  const clash = guard.find('swap', SWAP, 'agent-b');
  assert.deepEqual(clash, { id: '', session: 'agent-a' }, 'the sentence can say who, even before it can say which');
});

test('filling in the id keeps the claim, it does not make a second one', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', '');
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');
  assert.equal(guard.size(), 1);
  assert.equal(guard.find('swap', SWAP, 'agent-b')?.id, 'prop-1');
});

test('the ninety seconds run from the check, not from whenever the rail answered', () => {
  const { guard, advance } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', '');
  advance(40_000); // a slow quote and a slow chain read
  guard.remember('swap', SWAP, 'agent-a', 'prop-1');

  advance(DUPLICATE_MS - 40_000 + 1);
  assert.equal(guard.find('swap', SWAP, 'agent-b'), null, 'the window closes when the check ages out');
});

test('forget gives the claim back, so a draft that never landed blocks nobody', () => {
  const { guard } = guardFrom(1_000_000);
  guard.remember('swap', SWAP, 'agent-a', '');
  guard.forget('swap', SWAP);
  assert.equal(guard.find('swap', SWAP, 'agent-b'), null);
  assert.equal(guard.size(), 0);
});

test('forgetting something never claimed is not an error', () => {
  const { guard } = guardFrom(1_000_000);
  guard.forget('swap', SWAP);
  assert.equal(guard.size(), 0);
});

/* What "in flight" means for a stored row, in one place for the server and the door's tests.
   Terminal rows have settled, with one exception: an unconfirmed row that carries a hash, a
   handle or a nonce is money that may be live at the venue, and an identical repeat inside the
   window would double it. In the incident replay the first $10 landed unconfirmed at 43 s and a
   repeat at 44 s walked through the guard, because needs_reconciliation read as terminal. */
test('an unconfirmed row with evidence still holds its claim, and one with none does not', () => {
  const row = (over: Partial<Proposal>): Proposal =>
    ({ id: 'x', kind: 'hl_deposit', createdAt: '', status: 'executed', draft: {}, simulation: null, verdict: { outcome: 'allow', reasons: [] }, ...over }) as Proposal;
  assert.equal(stillInFlight(undefined), true, 'a row the store does not hold yet is still being written');
  assert.equal(stillInFlight(row({ status: 'executing' })), true);
  assert.equal(stillInFlight(row({ status: 'pending' })), true);
  for (const status of ['executed', 'failed', 'refused', 'policy_refused'] as const) {
    assert.equal(stillInFlight(row({ status })), false, `${status} has settled`);
  }
  assert.equal(stillInFlight(row({ status: 'needs_reconciliation' })), false, 'unconfirmed with nothing sent is the app not knowing, and holds nothing');
  assert.equal(stillInFlight(row({ status: 'needs_reconciliation', result: { ok: false, detail: 'x', txids: ['0xh'] } })), true, 'a hash is money that may have moved');
  assert.equal(stillInFlight(row({ status: 'needs_reconciliation', result: { ok: false, detail: 'x', evidence: { handle: 'dep-1' } } })), true, 'so is a handle');
  assert.equal(stillInFlight(row({ status: 'needs_reconciliation', result: { ok: false, detail: 'x', evidence: { nonce: '7' } } })), true, 'and a nonce');
});

/* THE WINDOW DOES NOT RUN OUT UNDER MONEY THAT IS STILL MOVING.

   stillInFlight already held an unconfirmed row that carries a hash, a handle or a nonce, and
   the sweep deleted the entry at ninety seconds anyway. The deposit deadline table runs to 1440
   seconds, so a row that is needs_reconciliation at t=120 s no longer collided at all, and what
   the agent reads on that row is `terminal: true`. After that the only things standing between
   an agent and a second send of the same money were the reply sentence and its own judgement.

   Ninety seconds stays what it is for every settled row, which is what keeps the window from
   ever being the reason a person cannot repeat an action they meant to repeat. */
test('a claim on a row that is still in flight outlives the window', () => {
  let now = 1_000_000;
  const live = new Set<string>(['prop-1']);
  const guard = createDuplicateGuard(() => now, undefined, { inFlight: (id) => live.has(id) });
  guard.remember('hl_deposit', SWAP, 'agent-a', 'prop-1');

  now += DUPLICATE_MS * 16; // past the 1440 s deposit deadline, let alone ninety seconds
  assert.equal(guard.find('hl_deposit', SWAP, 'agent-a')?.id, 'prop-1', 'the sender walked through its own unsettled move');
  assert.equal(guard.find('hl_deposit', SWAP, 'agent-b')?.id, 'prop-1', 'a second agent walked through it');

  live.delete('prop-1');
  assert.equal(guard.find('hl_deposit', SWAP, 'agent-b'), null, 'and once it settles the window is long over');
  assert.equal(guard.size(), 0, 'the entry is gone rather than merely ignored');
});

test('the cap evicts a settled entry before an unsettled one', () => {
  let now = 1_000_000;
  const guard = createDuplicateGuard(() => now, undefined, { inFlight: (id) => id === 'prop-0' });
  guard.remember('hl_deposit', { ...SWAP, amountIn: 0 }, 'agent-a', 'prop-0');
  for (let i = 1; i < 500; i++) guard.remember('swap', { ...SWAP, amountIn: i }, 'agent-a', `prop-${i}`);

  assert.ok(guard.size() <= 201, `the guard is holding ${guard.size()} entries`);
  assert.equal(guard.find('hl_deposit', { ...SWAP, amountIn: 0 }, 'agent-b')?.id, 'prop-0', 'the unsettled claim was evicted by noise');
});

test('a draft that died without calling forget still lets go of its fingerprint', () => {
  let now = 1_000_000;
  const guard = createDuplicateGuard(() => now, undefined, { inFlight: () => true });
  guard.remember('swap', SWAP, 'agent-a', '');
  assert.ok(guard.find('swap', SWAP, 'agent-b'), 'a fresh claim blocks, as it should');
  now += DUPLICATE_MS + 1;
  assert.equal(guard.find('swap', SWAP, 'agent-b'), null, 'a claim with no row behind it held on past the window');
  assert.equal(guard.size(), 0);
});
