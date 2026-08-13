// The audit log is the product's record of what the agent did. These tests exist
// because the heartbeat used to be written to it as a tool_call on every ping,
// which buried the real events at ~5,760 entries a day.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAudit } from '../../src/audit.ts';
import { createAgentTracker, AGENT_TIMEOUT_MS } from '../../src/agents.ts';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-agents-'));
  const audit = createAudit(dir);
  let clock = 1_000_000;
  const tracker = createAgentTracker(audit, () => clock);
  return {
    tracker,
    audit,
    advance: (ms: number) => {
      clock += ms;
    },
    events: () => audit.tail(1000),
  };
}

test('a storm of heartbeats writes exactly one audit event', () => {
  const h = harness();
  for (let i = 0; i < 500; i++) {
    h.tracker.seen('phosphor-mcp');
    h.advance(15_000);
  }
  const events = h.events();
  assert.equal(events.length, 1, `500 pings wrote ${events.length} events`);
  assert.equal(events[0].type, 'agent_connected');
  assert.match(events[0].msg, /agent connected: phosphor-mcp/);
});

test('the heartbeat is never recorded as a tool_call', () => {
  const h = harness();
  for (let i = 0; i < 50; i++) h.tracker.seen('phosphor-mcp');
  assert.equal(
    h.events().filter((e) => e.type === 'tool_call').length,
    0,
    'a liveness ping is not something the agent did',
  );
});

test('a drop is recorded once, and only after the timeout lapses', () => {
  const h = harness();
  h.tracker.seen('phosphor-mcp');
  assert.equal(h.tracker.connected(), 1);

  h.advance(AGENT_TIMEOUT_MS - 1);
  h.tracker.sweep();
  assert.equal(h.events().length, 1, 'still inside the window, nothing to report');

  h.advance(2);
  assert.equal(h.tracker.connected(), 0);
  h.tracker.sweep();
  h.tracker.sweep();
  h.tracker.sweep();

  const events = h.events();
  assert.equal(events.length, 2, 'three sweeps past the lapse still record one drop');
  assert.match(events[0].msg, /agent dropped: phosphor-mcp/);
});

test('a reconnect after a drop is logged again, so the record has both halves', () => {
  const h = harness();
  h.tracker.seen('phosphor-mcp');
  h.advance(AGENT_TIMEOUT_MS + 1);
  h.tracker.sweep();
  h.tracker.seen('phosphor-mcp');

  const msgs = h
    .events()
    .map((e) => e.msg)
    .reverse();
  assert.deepEqual(msgs, [
    'agent connected: phosphor-mcp',
    'agent dropped: phosphor-mcp',
    'agent connected: phosphor-mcp',
  ]);
});

test('sweep on a tracker that never saw an agent reports nothing', () => {
  const h = harness();
  h.tracker.sweep();
  h.advance(AGENT_TIMEOUT_MS * 10);
  h.tracker.sweep();
  assert.equal(h.events().length, 0, 'an agent that never connected cannot drop');
});
