// Reading what the venue actually said, which is not the HTTP status and not the top-level one.
//
// Hyperliquid refuses an order with HTTP 200 and `{"status":"ok"}`, and buries the refusal per
// order inside `response.data.statuses`. A caller that checks what it is handed sees success.
//
// The runner did exactly that: it discarded the body on every order path. An order that never
// reached the book was indistinguishable from one that filled, which is how a mandate could arm,
// fire, place nothing, and report nothing. Found live on 2026-08-20 while proving the bracket:
// `{"status":"ok","response":{"type":"order","data":{"statuses":[{"error":"Price too far from
// oracle asset=4"}]}}}`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { orderErrors } from '../../src/hl/exchange.ts';

test('the shape that started this: ok on top, refused underneath', () => {
  const live = {
    status: 'ok',
    response: { type: 'order', data: { statuses: [{ error: 'Price too far from oracle asset=4' }] } },
  };
  assert.deepEqual(orderErrors(live), ['Price too far from oracle asset=4']);
});

test('a resting order and a fill are both accepted, and report nothing', () => {
  assert.deepEqual(orderErrors({ status: 'ok', response: { data: { statuses: [{ resting: { oid: 1 } }] } } }), []);
  assert.deepEqual(orderErrors({ status: 'ok', response: { data: { statuses: [{ filled: { oid: 2, totalSz: '1' } }] } } }), []);
  // The bracket shape: an entry that rested and a trigger waiting for it.
  assert.deepEqual(
    orderErrors({ status: 'ok', response: { data: { statuses: [{ resting: { oid: 3 } }, 'waitingForFill'] } } }),
    [],
  );
});

test('one refusal among several accepted orders is still a refusal', () => {
  const mixed = {
    status: 'ok',
    response: { data: { statuses: [{ resting: { oid: 1 } }, { error: 'Insufficient margin' }, { resting: { oid: 2 } }] } },
  };
  assert.deepEqual(orderErrors(mixed), ['Insufficient margin']);
});

test('every refusal is reported, not just the first', () => {
  const both = { status: 'ok', response: { data: { statuses: [{ error: 'a' }, { error: 'b' }] } } };
  assert.deepEqual(orderErrors(both), ['a', 'b']);
});

test('a top-level failure carries its reason as a bare string', () => {
  // The scheduleCancel shape: no per-order statuses at all.
  const locked = { status: 'err', response: 'Cannot set scheduled cancel time until enough volume traded.' };
  assert.deepEqual(orderErrors(locked), ['Cannot set scheduled cancel time until enough volume traded.']);
});

test('an absent or unreadable body reads as a failure rather than as success', () => {
  // Fail closed. Treating "I could not tell" as "it worked" is the whole defect.
  assert.deepEqual(orderErrors(null), ['the venue returned no response body']);
  assert.deepEqual(orderErrors(undefined), ['the venue returned no response body']);
  assert.deepEqual(orderErrors('not an object'), ['the venue returned no response body']);
});

test('a body with no statuses array is not invented into an error', () => {
  // A cancel answers {status:'ok',response:{type:'cancel',data:{statuses:['success']}}}, and a
  // plain default answers with no data at all. Neither is a refusal.
  assert.deepEqual(orderErrors({ status: 'ok', response: { type: 'default' } }), []);
  assert.deepEqual(orderErrors({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }), []);
});
