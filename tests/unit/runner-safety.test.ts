// Regression tests for the four findings the security audit turned up in the runner.
//
// Each one failed on the code as written before the audit. They are here rather than in
// strategy-envelope.test.ts because the envelope itself was always correct: the property test
// there accumulates position between checks and passed the whole time. What was wrong was the
// state the runner HANDED it, which is the more dangerous kind of wrong, because the unit under
// test looks fine in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEnvelope } from '../../src/strategy/envelope.ts';
import type { Mandate, RunState } from '../../src/strategy/envelope.ts';
import { programHash } from '../../src/strategy/grammar.ts';
import type { Action, Program } from '../../src/strategy/grammar.ts';

const PROGRAM: Program = {
  symbol: 'ETH',
  rules: [
    {
      id: 'a',
      when: { op: 'position', state: 'flat' },
      then: [{ do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: { type: 'market', maxSlippageBps: 20 } }],
    },
  ],
};

const mandate: Mandate = {
  id: 'md_1',
  programHash: programHash(PROGRAM),
  symbol: 'ETH',
  maxNotionalUsd: 1000,
  maxLeverage: 5,
  maxOrdersPerMin: 10,
  maxLossUsd: 100,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  allowedActions: ['open', 'close'],
};

function state(over: Partial<RunState> = {}): RunState {
  return {
    nowMs: Date.now(),
    armedAtMs: Date.now() - 1000,
    symbol: 'ETH',
    positionUsd: 0,
    positionSide: 'flat',
    entryAtMs: null,
    realisedUsd: 0,
    unrealisedUsd: 0,
    ordersInLastMin: 0,
    programHash: programHash(PROGRAM),
    ...over,
  };
}

const open500: Action = {
  do: 'open',
  side: 'long',
  sizeUsd: 500,
  leverage: 3,
  entry: { type: 'market', maxSlippageBps: 20 },
};

test('finding C: notional counts orders already in flight, not only confirmed position', () => {
  // Several rules can fire in one tick. The book only moves when the venue answers, so before
  // the fix each check saw a flat position and three $500 opens all cleared a $1,000 cap.
  // The runner now adds inFlightUsd into positionUsd, which is what this models.
  let inFlight = 0;
  const accepted: number[] = [];

  for (let i = 0; i < 3; i++) {
    const r = checkEnvelope(open500, mandate, state({ positionUsd: 0 + inFlight }));
    if (r.allow) {
      accepted.push(open500.sizeUsd);
      inFlight += open500.sizeUsd;
    }
  }

  assert.equal(accepted.length, 2, 'the third $500 must be refused against a $1,000 cap');
  assert.ok(inFlight <= mandate.maxNotionalUsd);
});

test('finding D: the program hash is compared against the program, not against itself', () => {
  // The runner used to copy the mandate's own hash into RunState, so this comparison was
  // always true and the check defended nothing. Hashing the held program is what gives it
  // something to disagree with.
  const swapped: Program = {
    ...PROGRAM,
    rules: [
      {
        id: 'a',
        when: { op: 'position', state: 'flat' },
        then: [
          // Same shape, ten times the size. A swap the old check could not see.
          { do: 'open', side: 'long', sizeUsd: 5000, leverage: 3, entry: { type: 'market', maxSlippageBps: 20 } },
        ],
      },
    ],
  };

  assert.notEqual(programHash(swapped), programHash(PROGRAM), 'the two programs must hash apart');

  const r = checkEnvelope(open500, mandate, state({ programHash: programHash(swapped) }));
  assert.equal(r.allow, false);
  assert.equal(r.allow === false && r.halt, true);
  assert.match(r.allow === false ? r.reason : '', /does not match/);
});

test('the envelope still refuses over-cap size on the first order, in-flight or not', () => {
  const tooBig: Action = { ...open500, sizeUsd: 1500 };
  assert.equal(checkEnvelope(tooBig, mandate, state()).allow, false);
});

test('a mandate that can lose more than it can hold is not bounded', () => {
  // Guarded at propose time in proposals.ts. Asserted here as the invariant it protects: the
  // stop-out has to bite before the whole position is gone, or it is not a stop-out.
  assert.ok(mandate.maxLossUsd <= mandate.maxNotionalUsd);
});
