import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, emptyMemory } from '../../src/strategy/evaluate.ts';
import type { MarketState } from '../../src/strategy/evaluate.ts';
import type { RunState } from '../../src/strategy/envelope.ts';
import type { Program, Ref } from '../../src/strategy/grammar.ts';

const NOW = 1_700_000_000_000;

function market(over: Partial<MarketState> = {}): MarketState {
  return {
    nowMs: NOW,
    markPx: 100,
    prevMarkPx: 100,
    resolveRef: (r: Ref) => (r.kind === 'price' ? r.value : r.kind === 'drawing' ? 105 : null),
    lastClose: () => ({ t: NOW - 60_000, close: 100 }),
    ...over,
  };
}

function run(over: Partial<RunState> = {}): RunState {
  return {
    nowMs: NOW,
    armedAtMs: NOW - 600_000,
    symbol: 'ETH',
    positionUsd: 0,
    positionSide: 'flat',
    entryAtMs: null,
    realisedUsd: 0,
    unrealisedUsd: 0,
    ordersInLastMin: 0,
    programHash: 'h',
    ...over,
  };
}

const openLong = { do: 'open', side: 'long', sizeUsd: 100, leverage: 2,
  entry: { type: 'market', maxSlippageBps: 20 } } as const;

function program(when: Program['rules'][number]['when'], extra: Partial<Program> = {}): Program {
  return { symbol: 'ETH', rules: [{ id: 'r1', when, then: [openLong] }], ...extra };
}

test('a cross up fires only on the transition, not while simply above', () => {
  const p = program({ op: 'price_cross_up', ref: { kind: 'price', value: 100 } });

  const crossing = evaluate(p, market({ prevMarkPx: 99, markPx: 101 }), run(), emptyMemory());
  assert.equal(crossing.actions.length, 1);

  const alreadyAbove = evaluate(p, market({ prevMarkPx: 101, markPx: 102 }), run(), emptyMemory());
  assert.equal(alreadyAbove.actions.length, 0, 'being above is not crossing');
});

test('a reference to a drawing resolves through the injected resolver', () => {
  const p = program({ op: 'price_above', ref: { kind: 'drawing', id: 'tl_1' } });
  // The stub resolver puts tl_1 at 105.
  assert.equal(evaluate(p, market({ markPx: 106 }), run(), emptyMemory()).actions.length, 1);
  assert.equal(evaluate(p, market({ markPx: 104 }), run(), emptyMemory()).actions.length, 0);
});

test('an unresolvable reference makes the condition false rather than throwing', () => {
  const p = program({ op: 'price_above', ref: { kind: 'drawing', id: 'deleted' } });
  const m = market({ resolveRef: () => null, markPx: 1e9 });
  assert.doesNotThrow(() => evaluate(p, m, run(), emptyMemory()));
  assert.equal(evaluate(p, m, run(), emptyMemory()).actions.length, 0,
    'a deleted line should stop triggering, not fire on everything');
});

test('once means once, across ticks', () => {
  const p = program({ op: 'price_above', ref: { kind: 'price', value: 50 } });
  p.rules[0].once = true;
  const first = evaluate(p, market(), run(), emptyMemory());
  assert.equal(first.actions.length, 1);
  const second = evaluate(p, market(), run(), first.memory);
  assert.equal(second.actions.length, 0);
});

test('a cooldown suppresses a re-fire until it expires', () => {
  const p = program({ op: 'price_above', ref: { kind: 'price', value: 50 } });
  p.rules[0].cooldownSec = 300;
  const first = evaluate(p, market(), run(), emptyMemory());
  assert.equal(first.actions.length, 1);

  const tooSoon = evaluate(p, market({ nowMs: NOW + 100_000 }), run(), first.memory);
  assert.equal(tooSoon.actions.length, 0);

  const later = evaluate(p, market({ nowMs: NOW + 400_000 }), run(), first.memory);
  assert.equal(later.actions.length, 1);
});

test('invalidation stands down and pre-empts every rule', () => {
  const p = program(
    { op: 'price_above', ref: { kind: 'price', value: 50 } },
    { invalidate: { op: 'price_below', ref: { kind: 'price', value: 90 } } },
  );
  const out = evaluate(p, market({ markPx: 80 }), run(), emptyMemory());
  assert.equal(out.invalidated, true);
  assert.deepEqual(out.actions.map((a) => a.do), ['stand_down']);
});

test('profit and loss is undefined while flat, not zero', () => {
  const p = program({ op: 'pnl_pct', cmp: 'lt', value: -2 });
  assert.equal(evaluate(p, market(), run({ positionUsd: 0 }), emptyMemory()).actions.length, 0);
  assert.equal(
    evaluate(p, market(), run({ positionUsd: 100, unrealisedUsd: -5 }), emptyMemory()).actions.length,
    1,
  );
});

test('elapsed since entry measures from the trade, not from arming', () => {
  const p = program({ op: 'elapsed', since: 'entry', cmp: 'gt', seconds: 3600 });
  // Armed ten minutes ago, in the trade for two hours would be impossible; entry drives it.
  const flat = evaluate(p, market(), run({ entryAtMs: null }), emptyMemory());
  assert.equal(flat.actions.length, 0, 'no entry means nothing to measure');

  const inTrade = evaluate(p, market(), run({ entryAtMs: NOW - 7200_000 }), emptyMemory());
  assert.equal(inTrade.actions.length, 1);
});

test('and, or and not compose', () => {
  const above = { op: 'price_above', ref: { kind: 'price', value: 50 } } as const;
  const below = { op: 'price_below', ref: { kind: 'price', value: 50 } } as const;
  assert.equal(evaluate(program({ op: 'and', of: [above, below] }), market(), run(), emptyMemory()).actions.length, 0);
  assert.equal(evaluate(program({ op: 'or', of: [above, below] }), market(), run(), emptyMemory()).actions.length, 1);
  assert.equal(evaluate(program({ op: 'not', of: below }), market(), run(), emptyMemory()).actions.length, 1);
});

test('the same inputs always produce the same output', () => {
  const p = program({ op: 'price_cross_up', ref: { kind: 'price', value: 100 } });
  const m = market({ prevMarkPx: 99, markPx: 101 });
  const a = evaluate(p, m, run(), emptyMemory());
  const b = evaluate(p, m, run(), emptyMemory());
  assert.deepEqual(a.actions, b.actions, 'determinism is what makes replay meaningful');
});

test('the caller memory is not mutated', () => {
  const p = program({ op: 'price_above', ref: { kind: 'price', value: 50 } });
  const mem = emptyMemory();
  evaluate(p, market(), run(), mem);
  assert.deepEqual(mem, emptyMemory(), 'memory is carried in and out, never held or mutated');
});
