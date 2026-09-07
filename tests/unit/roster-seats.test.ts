// Seats the app holds back for the agents it starts itself.
//
// THE FAILURE. `op: "hello"` runs before any credential check and there is none on /api/mcp, so
// six POSTs from six invented session ids filled the roster, and every later arrival got
// "phosphor already has 6 agents attached" including the app's own driver. The human pressed Start
// and nothing could attach. Re-sending the six every five seconds held it there for as long as the
// attacker cared to, and the audit log filled with agent_connected lines for six agents that did
// not exist. Availability of the money surface, taken by anything with a shell and a loop.
//
// THE FIX, and it is deliberately not authentication. /api/mcp still has no credential, an agent's
// door still has none by design, and nothing here decides what an agent may DO. What it decides is
// narrower: four of the six seats may only be taken by a session this app recognises, which means
// either an id this app minted (it spawns the driver and every worker, so it knows their ids
// before their first call) or a caller that presented this boot's seat secret, which reaches an
// agent this app spawned through childEnv and reaches nothing else.
//
// The first half is asserted against createAgents, the second over real HTTP through handleMcp,
// because the gate is only worth anything if the route reads what the roster checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { MAX_AGENTS, RESERVED_SEATS, createAgents } from '../../src/agents.ts';
import { handleMcp } from '../../src/http/mcp.ts';
import type { Ctx } from '../../src/http/context.ts';

const SECRET = 'a'.repeat(64);

function roster(reserved = RESERVED_SEATS, secret = SECRET) {
  return createAgents(Date.now, MAX_AGENTS, { reserved, secret });
}

test('an unrecognised session stops at the unreserved seats', () => {
  const agents = roster();
  const free = MAX_AGENTS - RESERVED_SEATS;

  for (let n = 0; n < free; n += 1) {
    const claim = agents.claim({ session: `sess${n}`, client: 'x', intervalMs: 5000 });
    assert.equal(claim.ok, true, `seat ${n} is one anything may take`);
  }

  const refused = agents.claim({ session: 'sess-over', client: 'x', intervalMs: 5000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.full, true, 'waiting is correct, retrying at once is not');
  assert.match(refused.ok === false ? refused.error : '', /holding its last/);
  assert.equal(agents.connected(), free);
});

test('the app own agent still attaches to a roster an attacker filled', () => {
  const agents = roster();
  for (let n = 0; n < MAX_AGENTS; n += 1) agents.claim({ session: `sess${n}`, client: 'x', intervalMs: 5000 });
  assert.equal(agents.connected(), MAX_AGENTS - RESERVED_SEATS, 'the attacker got what it is allowed');

  // A worker: the app minted the id and said so before the worker's first call.
  agents.markAnalyst('worker-1');
  const worker = agents.claim({ session: 'worker-1', client: 'phosphor-mcp', intervalMs: 5000 });
  assert.equal(worker.ok, true);
  assert.equal(worker.ok && worker.member.role, 'analyst');

  // The driver: the app did not mint its id anywhere the roster can see, so it carries the secret.
  const driver = agents.claim({ session: 'driver-1', client: 'phosphor-mcp', intervalMs: 5000, secret: SECRET });
  assert.equal(driver.ok, true);
  assert.equal(driver.ok && driver.member.role, 'operator');
});

test('a wrong secret is worth exactly as much as no secret', () => {
  const agents = roster();
  for (let n = 0; n < MAX_AGENTS; n += 1) agents.claim({ session: `sess${n}`, client: 'x', intervalMs: 5000 });

  for (const guess of [SECRET.slice(0, -1), `${SECRET}b`, 'b'.repeat(64), '', 42, null]) {
    const tried = agents.claim({ session: `guess-${String(guess).slice(0, 8)}`, client: 'x', secret: guess });
    assert.equal(tried.ok, false, `${String(guess).slice(0, 12)} must not open a reserved seat`);
  }
});

test('a boot with no secret at all matches nothing rather than everything', () => {
  const agents = createAgents(Date.now, MAX_AGENTS, { reserved: RESERVED_SEATS, secret: '' });
  for (let n = 0; n < MAX_AGENTS; n += 1) agents.claim({ session: `sess${n}`, client: 'x' });

  assert.equal(agents.claim({ session: 'guess', client: 'x', secret: '' }).ok, false);
  assert.equal(agents.claim({ session: 'guess2', client: 'x' }).ok, false);
  // Recognition by minted id does not depend on the secret, which is why an empty one is safe.
  agents.markAnalyst('worker-1');
  assert.equal(agents.claim({ session: 'worker-1', client: 'x' }).ok, true);
});

test('a recognised session fills the whole roster and the cap still holds', () => {
  const agents = roster();
  for (let n = 0; n < MAX_AGENTS; n += 1) {
    assert.equal(agents.claim({ session: `own${n}`, client: 'x', secret: SECRET }).ok, true);
  }
  const over = agents.claim({ session: 'own-over', client: 'x', secret: SECRET });
  assert.equal(over.ok, false);
  assert.match(over.ok === false ? over.error : '', /already has 6 agents attached/);
});

test('a session already seated keeps its seat, secret or no secret', () => {
  const agents = roster();
  assert.equal(agents.claim({ session: 'early', client: 'x', intervalMs: 5000 }).ok, true);
  for (let n = 0; n < MAX_AGENTS; n += 1) agents.claim({ session: `own${n}`, client: 'x', secret: SECRET });

  // The heartbeat of a member that got in before the roster filled is not a fresh argument for a
  // seat, and refusing it here would drop a working agent because a colleague arrived.
  assert.equal(agents.claim({ session: 'early', client: 'x', intervalMs: 5000 }).ok, true);
  assert.equal(agents.check({ session: 'early' }).ok, true);
});

test('the reserved gate is off unless the app asks for it', () => {
  // Every test in tests/unit/agents.test.ts is about presence rather than about this gate, and
  // builds a roster with two arguments. Those must keep the behaviour they assert.
  const agents = createAgents(Date.now, MAX_AGENTS);
  for (let n = 0; n < MAX_AGENTS; n += 1) {
    assert.equal(agents.claim({ session: `sess${n}`, client: 'x' }).ok, true);
  }
  assert.equal(agents.claim({ session: 'over', client: 'x' }).ok, false);
});

/* ---------- over the wire ----------

   The roster can hold whatever it likes back if the route never passes the secret on. handleMcp
   hands the whole body to claim(), so this is the assertion that the field survives the trip. */

type Wire = { url: string; close: () => Promise<void>; audit: string[] };

async function boot(agents: ReturnType<typeof createAgents>): Promise<Wire> {
  const audit: string[] = [];
  const ctx = {
    agents,
    seats: new Set<string>(),
    audit: { append: (type: string) => audit.push(type) },
    sse: { broadcastState: () => {}, broadcastActivity: () => {} },
  } as unknown as Ctx;

  const server = http.createServer((req, res) => {
    void handleMcp(ctx, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    audit,
  };
}

async function hello(wire: Wire, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${wire.url}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: wire.url },
    body: JSON.stringify({ op: 'hello', client: 'x', intervalMs: 5000, ...body }),
  });
  await res.text();
  return res.status;
}

test('the six-hello script no longer keeps the app own agent out', async () => {
  const agents = roster();
  const wire = await boot(agents);
  try {
    // The attack, verbatim: six distinct invented sessions, no credential.
    const codes: number[] = [];
    for (let n = 0; n < 6; n += 1) codes.push(await hello(wire, { session: `sess${n}` }));
    assert.deepEqual(codes, [200, 200, 409, 409, 409, 409], 'four of the six seats are not on offer');

    // And the app's own two routes in, over the same wire that just refused four times.
    agents.markAnalyst('worker-1');
    assert.equal(await hello(wire, { session: 'worker-1' }), 200, 'a session the app minted');
    assert.equal(await hello(wire, { session: 'driver-1', secret: SECRET }), 200, 'and one carrying the secret');

    assert.equal(agents.connected(), 4);
  } finally {
    await wire.close();
  }
});

test('a refused hello is logged once rather than once a heartbeat', async () => {
  const agents = roster();
  const wire = await boot(agents);
  try {
    for (let n = 0; n < 2; n += 1) await hello(wire, { session: `sess${n}` });
    for (let n = 0; n < 5; n += 1) await hello(wire, { session: 'noisy' });
    assert.equal(
      wire.audit.filter((type) => type === 'agent_rejected').length,
      1,
      'a loop of refusals must not be a loop of audit lines',
    );
  } finally {
    await wire.close();
  }
});
