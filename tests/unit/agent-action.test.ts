// What the agent is doing right now, and the two guarantees the window's animation rests on.
//
// The animation in ui/mechanism.js winds on `start` and releases on `settle`, with no timer
// and no predicted duration, because the model's own latency is invisible to this app. That
// design only holds if the store below never opens an action it does not close: a wind-up
// with no release is a machine that spins forever and lies about the account being busy.
// These are that promise, written down.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentActionStore, targetFor } from '../../src/agent-action.ts';
import type { AgentActionEvent } from '../../src/agent-action.ts';

function collect(store: ReturnType<typeof createAgentActionStore>): AgentActionEvent[] {
  const seen: AgentActionEvent[] = [];
  store.subscribe((event) => seen.push(event));
  return seen;
}

const INPUT = { op: 'read', tool: 'balances', label: 'read balances', target: 'read', detail: '' } as const;

test('a start is emitted before the caller can do any work, and carries the label', () => {
  const store = createAgentActionStore();
  const seen = collect(store);
  store.begin({ ...INPUT });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, 'start');
  assert.equal(seen[0].action.label, 'read balances');
});

test('every start gets exactly one settle, and the settle carries the outcome', () => {
  const store = createAgentActionStore();
  const seen = collect(store);
  const action = store.begin({ ...INPUT });
  store.end(action, 'refused');
  assert.deepEqual(seen.map((e) => e.phase), ['start', 'settle']);
  const settled = seen[1];
  assert.equal(settled.phase, 'settle');
  if (settled.phase !== 'settle') return;
  assert.equal(settled.action.outcome, 'refused');
});

test('settling twice is a no-op, so a finally plus an explicit end cannot double-release', () => {
  const store = createAgentActionStore();
  const seen = collect(store);
  const action = store.begin({ ...INPUT });
  store.end(action, 'ok');
  store.end(action, 'error');
  assert.equal(seen.filter((e) => e.phase === 'settle').length, 1);
});

test('open() is what a reloading window reads, and empties as actions settle', () => {
  const store = createAgentActionStore();
  const a = store.begin({ ...INPUT });
  const b = store.begin({ ...INPUT, tool: 'wallet' });
  assert.equal(store.open().length, 2);
  store.end(a, 'ok');
  assert.deepEqual(store.open().map((x) => x.tool), ['wallet']);
  store.end(b, 'ok');
  assert.equal(store.open().length, 0);
});

test('an action that never settles is swept, and the sweep emits a real settle', () => {
  // The window releases through its normal path or not at all. A sweep that silently dropped
  // the action would leave the machine winding with nothing open to justify it.
  let clock = 1_000;
  const store = createAgentActionStore(() => clock);
  const seen = collect(store);
  store.begin({ ...INPUT });
  clock += 130_000;
  store.begin({ ...INPUT, tool: 'wallet' });
  const settles = seen.filter((e) => e.phase === 'settle');
  assert.equal(settles.length, 1);
  assert.equal(settles[0].phase === 'settle' && settles[0].action.outcome, 'error');
  assert.deepEqual(store.open().map((x) => x.tool), ['wallet']);
});

test('a throwing subscriber cannot stop the emit, because a trade is behind this call', () => {
  const store = createAgentActionStore();
  const seen: string[] = [];
  store.subscribe(() => {
    throw new Error('a window went away mid-write');
  });
  store.subscribe((e) => seen.push(e.phase));
  assert.doesNotThrow(() => store.end(store.begin({ ...INPUT }), 'ok'));
  assert.deepEqual(seen, ['start', 'settle']);
});

test('unsubscribe stops delivery', () => {
  const store = createAgentActionStore();
  const seen: string[] = [];
  const off = store.subscribe((e) => seen.push(e.phase));
  store.begin({ ...INPUT });
  off();
  store.end(store.begin({ ...INPUT }), 'ok');
  assert.deepEqual(seen, ['start']);
});

test('targetFor is total: an op nobody has heard of animates as the quietest thing', () => {
  // The window picks its animation from this and has no default of its own, so a gap here is
  // a blank stage rather than a wrong one.
  assert.equal(targetFor('view', 'chart_set_view', ''), 'chart');
  assert.equal(targetFor('set_view_mode', '', 'trade'), 'view');
  assert.equal(targetFor('propose', '', 'policy_change'), 'policy');
  // Arming a mandate is the only propose kind that puts size in the market, so it is the only
  // one that draws the bow. A deposit moves funds and is not an order, whatever it is named.
  assert.equal(targetFor('propose', '', 'mandate_arm'), 'order');
  assert.equal(targetFor('propose', '', 'hl_deposit'), 'account');
  assert.equal(targetFor('propose', '', 'swap'), 'account');
  assert.equal(targetFor('propose', '', 'lp_add'), 'account');
  assert.equal(targetFor('propose', '', 'consolidate'), 'account');
  assert.equal(targetFor('propose', '', 'something_new'), 'account', 'unknown money movement still weighs');
  assert.equal(targetFor('read', 'chart_read', ''), 'chart');
  assert.equal(targetFor('read', 'balances', ''), 'read');
  assert.equal(targetFor('nonsense', '', ''), 'read');
  assert.equal(targetFor('', '', ''), 'read');
});
