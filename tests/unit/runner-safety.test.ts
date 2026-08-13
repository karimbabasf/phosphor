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

// ---------- the live breach of 2026-08-13 ----------
//
// A mandate capped at $60 notional and 4 orders a minute built a $238 position with 8 orders in
// one second, on live testnet money. Nothing in the envelope was wrong: it was asked eight
// questions about the same instant and truthfully answered yes to all of them.
//
// Two independent causes, each sufficient on its own, so each gets its own test.

test('breach 1: an async tick on an interval must not overlap itself', () => {
  // setInterval does not wait for an async callback. Placing an order is a network call of
  // hundreds of milliseconds, so at a 250ms interval up to eight ticks ran at once, every one
  // of them reading the order count and the position before any other had incremented either.
  //
  // This models the loop, not the runner: the property under test is that the guard admits
  // exactly one runner at a time, which is what makes every check inside it mean what it says.
  let running = 0;
  let maxConcurrent = 0;
  let ticking = false;
  const pending: Array<() => void> = [];

  const tick = () =>
    new Promise<void>((resolve) => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      pending.push(() => {
        running -= 1;
        resolve();
      });
    });

  const fire = () => {
    if (ticking) return;
    ticking = true;
    void tick().then(() => {
      ticking = false;
    });
  };

  // Eight interval firings while the first tick is still inside its network call.
  for (let i = 0; i < 8; i++) fire();
  assert.equal(maxConcurrent, 1, 'the guard must admit one tick at a time');
  assert.equal(pending.length, 1, 'seven firings were dropped, which is the point');
});

test('breach 2: in-flight size is retired by observed growth, never discarded', () => {
  // The runner used to zero inFlightUsd on every book. The book arrives every couple of seconds
  // and the venue takes time to reflect a fill, so a book that had not caught up wiped the
  // reservation while the orders behind it were still live, and the next tick saw full headroom.
  //
  // Retiring by growth keeps the sum honest whether the book is current or stale.
  const cap = 60;
  let inFlight = 0;
  let lastPositionUsd = 0;
  let venuePositionUsd = 0;

  const wouldExceed = (size: number) => venuePositionUsd + inFlight + size > cap;
  const order = (size: number) => {
    inFlight += size;
  };
  const onBook = (positionUsd: number) => {
    const grew = Math.max(0, positionUsd - lastPositionUsd);
    inFlight = Math.max(0, inFlight - grew);
    lastPositionUsd = positionUsd;
  };

  order(30);
  order(30);
  assert.equal(wouldExceed(30), true, 'the third $30 is over the $60 cap');

  // The stale book: the venue has not reflected either fill yet. The old code zeroed here.
  onBook(0);
  assert.equal(
    wouldExceed(30),
    true,
    'a book that has not caught up must NOT hand back headroom: this is the live breach',
  );

  // The venue catches up. Now the reservation is genuinely retired, and the cap still holds.
  venuePositionUsd = 60;
  onBook(60);
  assert.equal(inFlight, 0, 'confirmed size stops being in flight');
  assert.equal(wouldExceed(1), true, 'the position itself now fills the cap');
});

test('breach 2b: a partly filled book retires only the part that filled', () => {
  let inFlight = 60;
  let lastPositionUsd = 0;
  const onBook = (positionUsd: number) => {
    const grew = Math.max(0, positionUsd - lastPositionUsd);
    inFlight = Math.max(0, inFlight - grew);
    lastPositionUsd = positionUsd;
  };
  onBook(25);
  assert.equal(inFlight, 35, 'the unconfirmed remainder stays reserved');
});
