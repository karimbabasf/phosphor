// The four verbs that turn a mandate into a trading environment, and one property they share.
//
// Everything asserted here is about the WIRE, because on this venue the wire is the signature:
// src/hl/msgpack.ts preserves insertion order and the hash is taken over that, so a key in the
// wrong place is not a style question, it is a rejection with no reason attached.
//
// Why these four and not others. An LLM round trip is 1 to 5 seconds, so an agent can never
// react to a price. What it can do is put the decision on the venue in advance, where it runs
// at match speed with none of our latency in the path:
//
//   bracket        an entry and its exits in one signature, so a position is never briefly naked
//   modify         re-peg a resting order without losing queue place or leaving the book
//   batchModify    the same for a whole quote ladder, in one round trip
//   scheduleCancel the venue cancels for us if this app stops running at all
//
// The last one is the only safety primitive in this repo that still works when the process is
// dead, which is exactly when every other one has stopped.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULE_CANCEL_MAX_PER_DAY,
  SCHEDULE_CANCEL_MIN_LEAD_MS,
  SCHEDULE_CANCEL_VOLUME_REQUIRED_USD,
  isScheduleCancelLocked,
  buildBatchModifyAction,
  buildBracketAction,
  buildModifyAction,
  buildScheduleCancelAction,
} from '../../src/hl/exchange.ts';
import type { OrderRequest, TriggerRequest } from '../../src/hl/exchange.ts';

const SZ = 4; // szDecimals for the fixture asset

function order(over: Partial<OrderRequest> = {}): OrderRequest {
  return { assetId: 5, isBuy: true, price: 100, size: 2, reduceOnly: false, tif: 'Gtc', szDecimals: SZ, ...over };
}

function exit(over: Partial<TriggerRequest> = {}): TriggerRequest {
  return { assetId: 5, isBuy: false, size: 2, triggerPx: 90, isMarket: true, tpsl: 'sl', szDecimals: SZ, ...over };
}

// ---------- bracket ----------

test('a bracket is one action, grouped normalTpsl, entry first', () => {
  const a = buildBracketAction(order(), [exit({ tpsl: 'tp', triggerPx: 120 }), exit({ tpsl: 'sl', triggerPx: 90 })]) as {
    type: string;
    orders: Record<string, unknown>[];
    grouping: string;
  };

  assert.equal(a.type, 'order');
  // positionTpsl sizes a stop to whatever the position is when it fires, which is right for a
  // stop attached to an existing position and wrong for exits that belong to THIS entry.
  assert.equal(a.grouping, 'normalTpsl');
  assert.equal(a.orders.length, 3);

  // Order matters: the venue attaches exits to what precedes them.
  assert.deepEqual(a.orders[0].t, { limit: { tif: 'Gtc' } });
  assert.equal((a.orders[1].t as { trigger: { tpsl: string } }).trigger.tpsl, 'tp');
  assert.equal((a.orders[2].t as { trigger: { tpsl: string } }).trigger.tpsl, 'sl');

  // Key order is the documented one on every leg, because the hash is taken over it.
  for (const o of a.orders) assert.deepEqual(Object.keys(o), ['a', 'b', 'p', 's', 'r', 't']);
});

test('every bracket exit reduces, whatever the caller passed', () => {
  const a = buildBracketAction(order(), [exit({ isBuy: false })]) as { orders: Record<string, unknown>[] };
  assert.equal(a.orders[0].r, false, 'the entry opens');
  assert.equal(a.orders[1].r, true, 'the exit only ever reduces');
});

test('an exit on the same side as its entry is refused, because it would add to the position', () => {
  assert.throws(
    () => buildBracketAction(order({ isBuy: true }), [exit({ isBuy: true })]),
    /opposite side from its entry/,
  );
});

test('an exit on another asset is refused', () => {
  assert.throws(() => buildBracketAction(order({ assetId: 5 }), [exit({ assetId: 6 })]), /asset 6 and the entry is on 5/);
});

test('a bracket needs at least one exit and takes at most two', () => {
  assert.throws(() => buildBracketAction(order(), []), /just an order/);
  assert.throws(() => buildBracketAction(order(), [exit(), exit(), exit()]), /at most a target and a stop/);
});

test('a trigger carries the trigger price in p, not a zero that would read as free', () => {
  const a = buildBracketAction(order(), [exit({ triggerPx: 90 })]) as { orders: Record<string, unknown>[] };
  assert.equal(a.orders[1].p, '90', 'a wire number never carries a trailing zero');
  assert.equal((a.orders[1].t as { trigger: { triggerPx: string } }).trigger.triggerPx, '90');
});

// ---------- modify ----------

test('modify carries oid and the replacement order, and omits always_place when false', () => {
  const a = buildModifyAction(12345, order({ price: 101 })) as Record<string, unknown>;
  assert.deepEqual(Object.keys(a), ['type', 'oid', 'order'], 'a is absent, not false');
  assert.equal(a.type, 'modify');
  assert.equal(a.oid, 12345);
  assert.equal((a.order as Record<string, unknown>).p, '101');
});

test('always_place appears only when it is true, because false is rejected outright', () => {
  // Rule 2 in the module header: the venue rejects actions hashed with an explicit false here.
  const off = buildModifyAction(1, order()) as Record<string, unknown>;
  const on = buildModifyAction(1, order(), true) as Record<string, unknown>;
  assert.equal('a' in off, false);
  assert.equal(on.a, true);
});

test('modify accepts a cloid as the oid, since the venue takes either', () => {
  const a = buildModifyAction('0xdeadbeef', order()) as Record<string, unknown>;
  assert.equal(a.oid, '0xdeadbeef');
});

test('the default is not to place: an order that filled mid-flight must not be silently replaced', () => {
  const a = buildModifyAction(1, order()) as Record<string, unknown>;
  assert.equal('a' in a, false);
});

// ---------- batchModify ----------

test('batchModify moves a whole ladder in one round trip', () => {
  const a = buildBatchModifyAction([
    { oid: 1, order: order({ price: 99 }) },
    { oid: 2, order: order({ price: 98 }) },
  ]) as { type: string; modifies: { oid: number; order: Record<string, unknown> }[] };

  assert.equal(a.type, 'batchModify');
  assert.equal(a.modifies.length, 2);
  assert.equal(a.modifies[0].order.p, '99');
  assert.equal(a.modifies[1].order.p, '98');
  assert.deepEqual(Object.keys(a.modifies[0]), ['oid', 'order']);
  assert.equal('a' in a, false);
});

// ---------- scheduleCancel ----------

test('scheduleCancel with a time asks the venue to cancel everything at it', () => {
  const at = 1_786_600_000_000;
  const a = buildScheduleCancelAction(at) as Record<string, unknown>;
  assert.deepEqual(a, { type: 'scheduleCancel', time: at });
});

test('scheduleCancel with no time REMOVES the net, and the absent key is how that is said', () => {
  const a = buildScheduleCancelAction(null) as Record<string, unknown>;
  assert.deepEqual(a, { type: 'scheduleCancel' });
  assert.equal('time' in a, false, 'a null time would be a different action to the venue');
});

test('a non-integer timestamp is refused here rather than by an unexplained rejection', () => {
  assert.throws(() => buildScheduleCancelAction(1.5), /integer millisecond timestamp/);
  assert.throws(() => buildScheduleCancelAction(Number.NaN), /integer millisecond timestamp/);
});

test('the venue rules are recorded as constants, not as folklore', () => {
  // The first two are documented and change how this can be used: it cannot be an instant
  // cancel, and it cannot be a heartbeat.
  assert.equal(SCHEDULE_CANCEL_MIN_LEAD_MS, 5_000);
  assert.equal(SCHEDULE_CANCEL_MAX_PER_DAY, 10);
  // The third is not documented and was measured against the live testnet venue on 2026-08-20.
  assert.equal(SCHEDULE_CANCEL_VOLUME_REQUIRED_USD, 1_000_000);
});

test('a volume lock is told apart from a malformed request, because only one is worth retrying', () => {
  // The venue's own words, copied from the live refusal.
  const locked = 'Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $40988.83.';
  assert.equal(isScheduleCancelLocked(locked), true);
  assert.equal(isScheduleCancelLocked({ status: 'err', response: locked }), true);

  // Anything else is a real failure and must not be swallowed as "not eligible yet".
  assert.equal(isScheduleCancelLocked('Invalid nonce'), false);
  assert.equal(isScheduleCancelLocked({ status: 'ok' }), false);
  assert.equal(isScheduleCancelLocked(undefined), false);
});

test('the dead-man switch is not something an account simply has', () => {
  // Named as a test because the failure mode is believing you are protected. A new account
  // cannot arm this at all, so nothing may treat a successful call as a precondition met.
  assert.ok(SCHEDULE_CANCEL_VOLUME_REQUIRED_USD > 0, 'there is a gate, and it is not free');
});
