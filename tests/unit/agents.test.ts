// The roster: several agents drive at once, each is named, and a terminated one stops reading
// as connected quickly rather than eventually.
//
// This file used to assert the opposite. Until 2026-08-21 there was one seat and the second
// agent was refused; the tests below that check a second, third and fourth agent attaching are
// the deliberate reversal of that rule, not a regression. What survives from the old shape is
// everything that was about PRESENCE rather than exclusivity: the TTL, the eviction, the
// revoke window, and the refusal a replaced agent must not retry through.
//
// Time is injected, so these assert the TTL itself rather than sleeping through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgents, MAX_AGENTS } from '../../src/agents.ts';

function clockFrom(start: number, max?: number): { agents: ReturnType<typeof createAgents>; advance: (ms: number) => void } {
  let now = start;
  const agents = createAgents(() => now, max);
  return {
    agents,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('the first hello joins the roster and reports the connect edge once', () => {
  const { agents } = clockFrom(1_000_000);

  const first = agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.edge, true, 'the first hello is the edge the log line hangs on');

  const second = agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  assert.equal(second.ok && second.edge, false, 'a heartbeat is not a second connection');
  assert.equal(agents.connected(), 1);
});

// The rule this whole change exists to remove.
test('a second agent attaches beside the first instead of being refused', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });

  const other = agents.claim({ session: 'b', client: 'codex', intervalMs: 5000 });
  assert.equal(other.ok, true, 'two agents may drive phosphor at the same time');
  assert.equal(agents.connected(), 2);
  assert.deepEqual(
    agents.roster().map((m) => m.client),
    ['claude-code', 'codex'],
    'the roster is oldest first, so the lead does not move when a newer member pings',
  );
});

test('the lead is the longest-attached operator and does not change when others join', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  advance(1000);
  agents.claim({ session: 'b', client: 'worker', role: 'analyst', intervalMs: 5000 });
  advance(1000);
  agents.claim({ session: 'c', client: 'codex', intervalMs: 5000 });

  assert.equal(agents.lead()?.session, 'a');
  assert.equal(agents.holder()?.session, 'a', 'holder() still answers, for every caller written before the roster');
});

test('an analyst never becomes the lead while an operator is attached', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'worker', client: 'phosphor-worker', role: 'analyst', intervalMs: 5000 });
  advance(1000);
  agents.claim({ session: 'human-side', client: 'claude-code', intervalMs: 5000 });

  assert.equal(agents.lead()?.session, 'human-side', 'the lead is the one that can act, not merely the oldest');
});

test('a role an agent claims is recorded but is a label, never a widening', () => {
  const { agents } = clockFrom(1_000_000);
  const claim = agents.claim({ session: 'a', client: 'x', role: 'operator' });
  assert.equal(claim.ok && claim.member.role, 'operator');
  const analyst = agents.claim({ session: 'b', client: 'y', role: 'analyst' });
  assert.equal(analyst.ok && analyst.member.role, 'analyst');
  // Anything unrecognised is an operator, because the tool surface is what actually decides
  // and a mistyped role must not silently produce a member nothing can explain.
  const odd = agents.claim({ session: 'c', client: 'z', role: 'captain' });
  assert.equal(odd.ok && odd.member.role, 'operator');
});

test('the roster is capped, and the refusal says it is capacity rather than a rule', () => {
  const { agents } = clockFrom(1_000_000, 2);
  agents.claim({ session: 'a', client: 'one', intervalMs: 5000 });
  agents.claim({ session: 'b', client: 'two', intervalMs: 5000 });

  const third = agents.claim({ session: 'c', client: 'three', intervalMs: 5000 });
  assert.equal(third.ok, false);
  assert.equal(third.ok === false && third.full, true);
  assert.match(!third.ok ? third.error : '', /maximum/);
  assert.match(!third.ok ? third.error : '', /several may drive at once/);
  assert.equal(agents.connected(), 2, 'a refused join does not disturb the members');
});

test('the default cap is the one the app ships with', () => {
  const { agents } = clockFrom(1_000_000);
  assert.equal(agents.capacity().max, MAX_AGENTS);
});

test('a member that expires makes room without waiting for a sweep', () => {
  const { agents, advance } = clockFrom(1_000_000, 2);
  agents.claim({ session: 'a', client: 'one', intervalMs: 5000 });
  agents.claim({ session: 'b', client: 'two', intervalMs: 5000 });
  advance(13_000);

  const next = agents.claim({ session: 'c', client: 'three', intervalMs: 5000 });
  assert.equal(next.ok, true);
  assert.equal(agents.connected(), 1);
});

test('an op from a session that never said hello joins the roster', () => {
  const { agents } = clockFrom(1_000_000);
  const first = agents.check({ session: 'curl' });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.edge, true);
  assert.equal(agents.connected(), 1, 'something is attached: a tool call cannot come from nothing');
});

test('a tool call from a second agent is granted, and both are counted', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });

  assert.equal(agents.check({ session: 'b' }).ok, true);
  assert.equal(agents.check({ session: 'a' }).ok, true);
  assert.equal(agents.connected(), 2);
});

test('a bye removes only the member that sent it', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  agents.claim({ session: 'b', client: 'codex', intervalMs: 5000 });

  const freed = agents.release('a');
  assert.equal(freed?.client, 'claude-code');
  assert.equal(agents.connected(), 1);
  assert.equal(agents.lead()?.client, 'codex');
});

test('a bye from a session nobody knows changes nothing', () => {
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
  assert.equal(agents.lead(), null);
});

test('one member expiring does not take a live one with it', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'fast', client: 'quick', intervalMs: 5000 });
  agents.claim({ session: 'slow', client: 'patient' });

  advance(13_000);
  assert.equal(agents.connected(), 1);
  assert.equal(agents.lead()?.session, 'slow');
});

test('a client that declares no interval keeps the old wide TTL rather than flapping', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'older-mcp' });

  advance(30_000);
  assert.equal(agents.connected(), 1, 'an older mcp.ts pings every 15s and must survive one miss');
  advance(16_000);
  assert.equal(agents.connected(), 0);
});

test('the sweep reports each drop exactly once, so the log gets one line per agent', () => {
  const { agents, advance } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  agents.claim({ session: 'b', client: 'codex', intervalMs: 5000 });

  assert.deepEqual(agents.sweep(), [], 'nothing to report while they are alive');
  advance(13_000);
  assert.deepEqual(
    agents.sweep().map((m) => m.client).sort(),
    ['claude-code', 'codex'],
  );
  assert.deepEqual(agents.sweep(), [], 'the second sweep has nothing left to say');
});

test('an agent-authored client name is capped and stripped of control characters', () => {
  const { agents } = clockFrom(1_000_000);
  const claim = agents.claim({ session: 'a', client: 'x'.repeat(200) + '\ndrop table' });
  assert.equal(claim.ok, true);
  const name = claim.ok ? claim.member.client : '';
  assert.equal(name.length, 48);
  assert.equal(/[\u0000-\u001f]/.test(name), false);
});

test('a re-hello may change the name but never restarts the membership', () => {
  const { agents } = clockFrom(1_000_000);
  const first = agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  const since = first.ok ? first.member.since : '';

  const again = agents.claim({ session: 'a', client: 'claude-code v2', intervalMs: 5000 });
  assert.equal(again.ok && again.member.since, since, 'the session did not start again');
  assert.equal(agents.lead()?.client, 'claude-code v2');
});

test('a member records who spawned it, so the roster reads as a tree', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'lead', client: 'claude-code', intervalMs: 5000 });
  const worker = agents.claim({
    session: 'w1',
    client: 'phosphor-worker',
    role: 'analyst',
    label: 'four hour',
    parent: 'lead',
    intervalMs: 5000,
  });
  assert.equal(worker.ok && worker.member.parent, 'lead');
  assert.equal(worker.ok && worker.member.label, 'four hour');
});

test('ops are counted per member, so an attached-but-idle agent is visible as one', () => {
  const { agents } = clockFrom(1_000_000);
  agents.claim({ session: 'a', client: 'busy', intervalMs: 5000 });
  agents.claim({ session: 'b', client: 'idle', intervalMs: 5000 });
  agents.check({ session: 'a' });
  agents.check({ session: 'a' });
  agents.claim({ session: 'b', client: 'idle', intervalMs: 5000 }); // a heartbeat, not work

  assert.equal(agents.member('a')?.ops, 2);
  assert.equal(agents.member('b')?.ops, 0, 'heartbeats are not work');
});

// Eviction: the human replacing the agents from the window.
//
// Clearing the roster is the obvious half and it is not enough on its own. An evicted proxy
// heartbeats every five seconds and a terminal takes longer than that to start a shell, so a
// roster that is merely empty is refilled by the agent that was just replaced.
test('evict with no argument clears the whole roster and reports everyone dropped', () => {
  const { agents } = clockFrom(1000);
  agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
  agents.claim({ session: 'w1', client: 'phosphor-worker', role: 'analyst', intervalMs: 5000 });

  const dropped = agents.evict();
  assert.deepEqual(dropped.map((m) => m.client).sort(), ['claude-code', 'phosphor-worker']);
  assert.equal(agents.connected(), 0);
  assert.equal(agents.lead(), null);
});

test('evict can name one member and leave the rest working', () => {
  const { agents } = clockFrom(1000);
  agents.claim({ session: 'a', client: 'claude-code', intervalMs: 5000 });
  agents.claim({ session: 'b', client: 'codex', intervalMs: 5000 });

  const dropped = agents.evict('b');
  assert.deepEqual(dropped.map((m) => m.client), ['codex']);
  assert.equal(agents.connected(), 1);
  assert.equal(agents.lead()?.client, 'claude-code');
});

test('an evicted session is refused even though there is now room', () => {
  const { agents } = clockFrom(1000);
  agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
  agents.evict();
  const again = agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.revoked, true);
  assert.equal(agents.connected(), 0, 'and it did not rejoin');
});

test('the replacement joins, and is not blocked by the eviction', () => {
  const { agents } = clockFrom(1000);
  agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
  agents.evict();
  const fresh = agents.claim({ session: 'new', client: 'claude-code', intervalMs: 5000 });
  assert.equal(fresh.ok, true);
  assert.equal(agents.lead()?.session, 'new');
});

test('an ordinary op from an evicted session is refused too, not just a hello', () => {
  // check() is the path every tool call takes. If only claim() were guarded, a replaced agent
  // could keep working as long as it never said hello again.
  const { agents } = clockFrom(1000);
  agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
  agents.evict();
  const op = agents.check({ session: 'old', client: 'claude-code' });
  assert.equal(op.ok, false);
  assert.equal(op.ok === false && op.revoked, true);
});

test('a revoked session is forgiven once its window passes', () => {
  // Bounded rather than permanent: a session id could be reused by a fresh process, and a map
  // that only grows in a long-lived app is a leak.
  const { agents, advance } = clockFrom(1000);
  agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
  agents.evict();
  advance(300_001);
  const later = agents.claim({ session: 'old', client: 'claude-code', intervalMs: 5000 });
  assert.equal(later.ok, true);
});

test('evicting an empty roster is not an error and still leaves it joinable', () => {
  const { agents } = clockFrom(1000);
  assert.deepEqual(agents.evict(), []);
  assert.equal(agents.claim({ session: 'new', client: 'x', intervalMs: 5000 }).ok, true);
});

test('a full roster is NOT marked revoked, because that one is worth waiting through', () => {
  // The proxy exits on `revoked` and reports a sentence on anything else. Conflating them
  // would have an agent kill itself for arriving while the app was busy.
  const { agents } = clockFrom(1000, 1);
  agents.claim({ session: 'a', client: 'first', intervalMs: 5000 });
  const second = agents.claim({ session: 'b', client: 'second', intervalMs: 5000 });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.revoked, undefined);
});
