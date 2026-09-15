// Seats the app holds back for the agents it starts itself.
//
// THE FAILURE. `op: "hello"` runs before any credential check and there is none on /api/mcp, so
// six POSTs from six invented session ids filled the roster, and every later arrival got
// "phosphor already has 6 agents attached" including the app's own driver. The human pressed Start
// and nothing could attach. Re-sending the six every five seconds held it there for as long as the
// attacker cared to, and the audit log filled with agent_connected lines for six agents that did
// not exist. Availability of the money surface, taken by anything with a shell and a loop.
//
// THE FIX, in two layers. The roster holds four of the six seats for a session this app
// recognises: an id this app minted (it spawns the driver and every worker, so it knows their ids
// before their first call) or a caller that presented this boot's seat secret. That was written
// as deliberately not authentication. It became authentication later: the door itself
// (src/http/mcp.ts) now takes the secret on EVERY op from every session, hello included, so the
// six-hello script never reaches the roster at all. The reservation stays as the wall behind it.
//
// The roster half is asserted against createAgents, the door half over real HTTP through
// handleMcp, because the gate is only worth anything if the route reads what the roster checks.

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

   The door reads the secret before the roster does. handleMcp hands the whole body to claim(),
   so this is also the assertion that the field survives the trip for a caller that has it. */

type Wire = { url: string; close: () => Promise<void>; audit: string[]; seats: Set<string> };

async function boot(agents: ReturnType<typeof createAgents>): Promise<Wire> {
  const audit: string[] = [];
  const seats = new Set<string>();
  const ctx = {
    cfg: { dataDir: '/tmp/phosphor-roster-test' },
    agents,
    seats,
    audit: { append: (type: string) => audit.push(type) },
    sse: { broadcastState: () => {}, broadcastActivity: () => {} },
    // Every answer on this door names the screen the window is on (src/http/mcp.ts stampScreen).
    getView: () => 'basic',
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
    seats,
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

test('the six-hello script is refused at the door and seats nobody', async () => {
  const agents = roster();
  const wire = await boot(agents);
  try {
    // The attack, verbatim: six distinct invented sessions, no credential.
    const codes: number[] = [];
    for (let n = 0; n < 6; n += 1) codes.push(await hello(wire, { session: `sess${n}` }));
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 401], 'no seat is on offer without the secret');
    assert.equal(agents.connected(), 0, 'a refused hello is not a member');

    // And the app's own agents in, over the same wire that just refused six times. A worker's
    // id was minted by the app AND its process carries the secret (childEnv), so it brings both.
    agents.markAnalyst('worker-1');
    assert.equal(await hello(wire, { session: 'worker-1', secret: SECRET }), 200, 'a session the app minted');
    assert.equal(await hello(wire, { session: 'driver-1', secret: SECRET }), 200, 'and the driver');
    assert.equal(agents.member('worker-1')?.role, 'analyst');
    assert.equal(agents.connected(), 2);
  } finally {
    await wire.close();
  }
});

test('a minted id without the secret is still refused: the door does not know the roster', async () => {
  const agents = roster();
  const wire = await boot(agents);
  try {
    agents.markAnalyst('worker-1');
    assert.equal(await hello(wire, { session: 'worker-1' }), 401);
    assert.equal(agents.connected(), 0);
  } finally {
    await wire.close();
  }
});

test('a refused hello is logged once rather than once a heartbeat', async () => {
  const agents = roster();
  const wire = await boot(agents);
  try {
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

/* The set behind "logged once" is keyed on caller-chosen strings. A refused session used to be
   added to it, one entry per invented session string, with no bound. A session that failed the
   secret is never seated in it now, and the set cannot grow past a few hundred distinct clients. */
test('refused sessions never grow the seats set, and distinct clients cannot grow it without bound', async () => {
  const agents = roster();
  const wire = await boot(agents);
  try {
    for (let n = 0; n < 20; n += 1) await hello(wire, { session: `invented-${n}`, client: 'one-client' });
    assert.equal(wire.seats.size, 1, 'one client, one entry, whatever the session strings');
    assert.ok(![...wire.seats].some((key) => key.includes('invented-')), 'a session that failed the secret is not seated');
    for (let n = 0; n < 500; n += 1) await hello(wire, { session: 'same', client: `client-${n}` });
    assert.ok(wire.seats.size <= 200, `bounded, got ${wire.seats.size}`);
    assert.equal(agents.connected(), 0);
  } finally {
    await wire.close();
  }
});
