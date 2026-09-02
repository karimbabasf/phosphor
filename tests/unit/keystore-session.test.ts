// The auto-lock clock, driven by an injected clock rather than by waiting.
//
// The property that carries the weight is the negative one: an agent working does not refresh
// the timer. It is invisible in ordinary use, because in ordinary use somebody is also moving
// a mouse, and it is the whole reason the beacon is a separate route rather than a side effect
// of any request arriving.

import test from 'node:test';
import assert from 'node:assert/strict';

import { IDLE_LOCK_MS, SIGNING_SESSION_MAX_MS, createSession } from '../../src/keystore/session.ts';

function harness(startUnlocked = true) {
  let clock = 1_700_000_000_000;
  let unlocked = startUnlocked;
  const locks: string[] = [];
  const session = createSession({
    now: () => clock,
    isUnlocked: () => unlocked,
    lock: (reason) => {
      unlocked = false;
      locks.push(reason);
    },
  });
  return {
    session,
    locks,
    advance: (ms: number) => {
      clock += ms;
    },
    // Ticks the way the interval would, every TICK_MS, so a gap only appears when the test
    // deliberately jumps the clock between ticks.
    run: (ms: number) => {
      for (let left = ms; left > 0; left -= 15_000) {
        clock += Math.min(15_000, left);
        session.tick();
      }
    },
    unlock: () => {
      unlocked = true;
    },
    isUnlocked: () => unlocked,
  };
}

test('an idle wallet locks after fifteen minutes', () => {
  const h = harness();
  h.run(IDLE_LOCK_MS - 15_000);
  assert.deepEqual(h.locks, [], 'not yet');
  h.run(30_000);
  assert.deepEqual(h.locks, ['idle']);
  assert.equal(h.isUnlocked(), false);
});

test('a human touching the window pushes the lock out', () => {
  const h = harness();
  h.run(14 * 60_000);
  h.session.touch();
  h.run(14 * 60_000);
  assert.deepEqual(h.locks, [], 'the touch reset the fifteen minutes');
  h.run(2 * 60_000);
  assert.deepEqual(h.locks, ['idle']);
});

test('agent traffic does not refresh the timer, because only the beacon calls touch', () => {
  const h = harness();
  // Stand in for an assistant reading balances every two seconds for the whole window. It
  // reaches the server, it is audited, and it moves nothing here.
  for (let i = 0; i < 450; i += 1) {
    h.session.tick();
    h.advance(2_000);
  }
  h.session.tick();
  assert.deepEqual(h.locks, ['idle'], 'a busy agent must not hold a funded wallet open');
});

test('the countdown the window shows is honest, and is null when there is nothing to lock', () => {
  const h = harness();
  assert.equal(h.session.idleLocksInSec(), IDLE_LOCK_MS / 1000);
  h.advance(60_000);
  assert.equal(h.session.idleLocksInSec(), IDLE_LOCK_MS / 1000 - 60);
  h.run(IDLE_LOCK_MS);
  assert.equal(h.session.idleLocksInSec(), null, 'a locked wallet has no countdown');
});

test('a clock jump reads as sleep and locks, and says so', () => {
  const h = harness();
  h.session.tick();
  // The lid was closed for four hours. Nothing ticked in between.
  h.advance(4 * 60 * 60_000);
  assert.equal(h.session.tick(), 'sleep');
  assert.deepEqual(h.locks, ['sleep'], 'the reason is sleep, not idle');
});

test('a jump while already locked locks nothing and does not fire again on the next tick', () => {
  const h = harness(false);
  h.advance(4 * 60 * 60_000);
  assert.equal(h.session.tick(), null);
  h.unlock();
  h.advance(15_000);
  assert.equal(h.session.tick(), null, 'the gap was already answered');
  assert.deepEqual(h.locks, []);
});

test('a slow tick inside the tolerance is not sleep', () => {
  const h = harness();
  h.session.tick();
  h.advance(45_000); // a busy event loop, not a suspended machine
  assert.equal(h.session.tick(), null);
  assert.deepEqual(h.locks, []);
});

// ---------- the signing session ----------

test('a signing session defaults to eight hours and is capped at a day', () => {
  const h = harness();
  const eight = h.session.arm('m1');
  assert.equal(eight.expiresAt - eight.armedAt, 8 * 60 * 60_000);

  const asked = h.session.arm('m2', 7 * 24 * 60 * 60_000);
  assert.equal(asked.expiresAt - asked.armedAt, SIGNING_SESSION_MAX_MS, 'a week becomes a day');

  const short = h.session.arm('m3', 60_000);
  assert.equal(short.expiresAt - short.armedAt, 60_000, 'a shorter one is honoured exactly');
});

test('a signing session expires on its own and is reported once', () => {
  const h = harness();
  h.session.arm('m1', 60_000);
  h.session.arm('m2', 10 * 60_000);

  h.advance(61_000);
  const gone = h.session.expired();
  assert.deepEqual(gone.map((s) => s.id), ['m1']);
  assert.equal(h.session.sessionFor('m1'), null, 'and it is not handed out afterwards');
  assert.deepEqual(h.session.expired(), [], 'a session is reported expired exactly once');
  assert.deepEqual(h.session.armed().map((s) => s.id), ['m2']);
});

test('disarming drops the session immediately', () => {
  const h = harness();
  h.session.arm('m1');
  assert.equal(h.session.disarm('m1'), true);
  assert.equal(h.session.sessionFor('m1'), null);
  assert.equal(h.session.disarm('m1'), false, 'disarming twice is not an error, it is a no-op');
});

test('a signing session outlives the lock, which is the point of it', () => {
  const h = harness();
  h.session.arm('m1');
  h.run(IDLE_LOCK_MS + 15_000);
  assert.deepEqual(h.locks, ['idle']);
  assert.notEqual(h.session.sessionFor('m1'), null, 'the armed rule keeps its trading key');
  assert.deepEqual(h.session.expired(), [], 'and locking did not expire it');
});
