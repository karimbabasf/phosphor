// The seat: one agent drives, everything else is told why not, and a terminated agent
// stops reading as connected quickly rather than eventually.
//
// Time is injected, so these assert the TTL itself rather than sleeping through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgents } from '../../src/agents.ts';

function clockFrom(start: number): { agents: ReturnType<typeof createAgents>; advance: (ms: number) => void } {
  let now = start;
  const agents = createAgents(() => now);
  return {
    agents,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('the first hello takes the seat and reports the connect edge once', () => {
  const { agents } = clockFrom(1_000_000);

  const first = agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.edge, true, 'the first hello is the edge the log line hangs on');

  const second = agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  assert.equal(second.ok && second.edge, false, 'a heartbeat is not a second connection');
  assert.equal(agents.connected(), 1);
});

test('a second agent is refused while the first holds the seat, and told which one holds it', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });

  const other = agents.claim({ session: 'b', client: 'codex', intervalMs: 5000 });
  assert.equal(other.ok, false);
  assert.match(!other.ok ? other.error : '', /already connected/);
  assert.match(!other.ok ? other.error : '', /claude-code/, 'the refusal names the holder, or it is not actionable');
  assert.equal(agents.holder()?.client, 'claude-code', 'a refused claim does not disturb the holder');
});

test('every op is subject to the seat, not just the handshake', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });

  assert.equal(agents.check({ session: 'b' }).ok, false, 'a tool call from a second agent is refused');
  assert.equal(agents.check({ session: 'a' }).ok, true);
});

test('an op from a session that never said hello takes a free seat', () => {
  const { agents } = clockFrom(1_000_000);
  const first = agents.check({ session: 'curl' });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.edge, true);
  assert.equal(agents.connected(), 1, 'something is attached: a tool call cannot come from nothing');
});

test('a bye frees the seat immediately, which is what makes the light go out on shutdown', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });

  const freed = agents.release('a');
  assert.equal(freed?.client, 'claude-code');
  assert.equal(agents.connected(), 0);
  assert.equal(agents.claim({ session: 'b', client: 'codex' }).ok, true, 'the next agent can sit down at once');
});

test('a bye from a session that does not hold the seat cannot evict the one that does', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });

  assert.equal(agents.release('b'), null);
  assert.equal(agents.connected(), 1);
});

test('a killed agent expires on the TTL its own heartbeat interval implies', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });

  advance(12_000);
  assert.equal(agents.connected(), 1, 'two missed pings is not yet a disconnection');

  advance(1_000); // 13s: past 2.5 intervals
  assert.equal(agents.connected(), 0, 'a terminated agent stops reading as connected in about twelve seconds');
  assert.equal(agents.holder(), null);
});

test('a client that declares no interval keeps the old wide TTL rather than flapping', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'older-mcp' });

  advance(30_000);
  assert.equal(agents.connected(), 1, 'an older mcp.ts pings every 15s and must survive one miss');
  advance(16_000);
  assert.equal(agents.connected(), 0);
});

test('the sweep reports the drop exactly once, so the log gets one line', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });

  assert.equal(agents.sweep(), null, 'nothing to report while it is alive');
  advance(13_000);
  assert.equal(agents.sweep()?.client, 'claude-code');
  assert.equal(agents.sweep(), null, 'the second sweep has nothing left to say');
});

test('an expired seat is free for the next agent without waiting for a sweep', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  advance(13_000);

  const next = agents.claim({ session: 'b', client: 'codex', intervalMs: 5000 });
  assert.equal(next.ok, true);
  assert.equal(agents.holder()?.client, 'codex');
});

test('an agent-authored client name is capped and stripped of control characters', () => {
  const { agents } = clockFrom(1_000_000);
  const claim = agents.claim({ session: 'a', client: 'x'.repeat(200) + '\ndrop table' });
  assert.equal(claim.ok, true);
  const name = claim.ok ? claim.seat.client : '';
  assert.equal(name.length, 48);
  assert.equal(/[\u0000-\u001f]/.test(name), false);
});

test('a re-hello from the holder may change its name but never the seat it holds', () => {
  const { agents } = clockFrom(1_000_000);
  const first = agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  const since = first.ok ? first.seat.since : '';

  const again = agents.claim({ session: 'a', client: 'claude-code v2', intervalMs: 5000 });
  assert.equal(again.ok && again.seat.since, since, 'the session did not start again');
  assert.equal(agents.holder()?.client, 'claude-code v2');
});
