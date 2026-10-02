// Only the seat that holds a session can end it (fix round 2, 2026-10-01).
//
// A bye ends a seat and the person's Allow with it. It was the one op the roster answered for any
// session it was named: a process that read agent.secret off the disk could free any seat, the
// app's own chat included, and an outside agent the person had allowed lost its Allow and asked
// again. And the proxy's own bye carried no secret at all, so since the door began to require one
// it was refused, and a closed agent stayed on the roster until its TTL ran out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { MAX_AGENTS, createAgents, seatSecretPath } from '../../src/agents.ts';
import { outsideBy } from '../../src/web-read.ts';
import { bootChartServer } from '../fixtures/chart-server.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HAND = 'h'.repeat(64);
const KEY = 'k'.repeat(64);
const OTHER_KEY = 'q'.repeat(64);

function until(check: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('regression: a bye from a process that does not hold the seat frees nothing, and the holder\'s own bye frees it', async () => {
  const h = await bootChartServer({ handSeat: HAND });
  const seat = 'bye-bound-outside';
  const bye = (body: Record<string, unknown>) => h.post('/api/mcp', { op: 'bye', client: 'claude-code', ...body });
  try {
    assert.equal((await h.post('/api/mcp', { op: 'hello', session: seat, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 })).status, 200);
    assert.equal((await h.post('/api/agents/answer', { token: h.token, session: seat, allow: true })).status, 200);
    assert.equal(h.agents.member(seat)?.allowed, true);

    for (const [who, body] of [
      ['the file secret and another key', { session: seat, secret: HAND, key: OTHER_KEY }],
      ['the file secret and no key', { session: seat, secret: HAND }],
      ['the app secret and no key', { session: seat, secret: h.seat }],
    ] as const) {
      const out = await bye(body);
      assert.equal(out.status, 403, `${who}: ${JSON.stringify(out.json)}`);
      assert.equal(out.json.seat, 'foreign');
      assert.equal(h.agents.member(seat)?.allowed, true, `${who} freed the seat or took its Allow`);
      assert.equal(outsideBy(seat), false, `${who} put the outside mark back`);
    }

    // The app's own seat (the fixture seats 'unnamed-session' as the app's) is not the file secret's to end.
    const app = await bye({ session: 'unnamed-session', secret: HAND, key: KEY });
    assert.equal(app.status, 403, JSON.stringify(app.json));
    assert.notEqual(h.agents.member('unnamed-session'), null);

    // The holder's own bye frees it, and says so in the log.
    assert.equal((await bye({ session: seat, secret: HAND, key: KEY })).status, 200);
    assert.equal(h.agents.member(seat), null);
    assert.ok(h.audit.tail(50).some((e) => e.type === 'agent_disconnected' && e.msg === 'the agent disconnected'));
    // And the app's own bye frees the app's own seat.
    assert.equal((await bye({ session: 'unnamed-session', secret: h.seat })).status, 200);
    assert.equal(h.agents.member('unnamed-session'), null);
    // A bye for a seat nobody holds changes nothing and is not an error.
    assert.equal((await bye({ session: 'never-seated', secret: HAND, key: KEY })).status, 200);
  } finally {
    await h.close();
  }
});

test('regression: an Allow outlives its seat lapsing, and another process cannot bye it away meanwhile', () => {
  let now = 1_000_000;
  const agents = createAgents(() => now, MAX_AGENTS, { secret: 'o'.repeat(64), handSecret: HAND });
  const seat = 'bye-bound-lapsed';
  assert.ok(agents.claim({ session: seat, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 }).ok);
  assert.ok(agents.allow(seat).ok);

  now += 60_000; // the laptop slept: the seat lapsed and the sweep dropped it
  assert.equal(agents.sweep().length, 1);
  const away = agents.release({ session: seat, secret: HAND, key: OTHER_KEY });
  assert.equal(away.ok, false, 'another key ended a seat whose Allow it does not hold');
  assert.equal(!away.ok && away.foreign, true);

  const back = agents.claim({ session: seat, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 });
  assert.ok(back.ok);
  assert.equal(back.member.allowed, true, 'the Allow the person gave is still there for the proxy it was given to');
});

/* The proxy itself, against the real door: its bye carries this boot's secret and its own key,
   so closing the client frees the seat at once rather than one TTL (about twelve seconds) later. */
for (const origin of ['outside', 'app'] as const) {
  test(`closing a proxy that holds ${origin === 'outside' ? 'the file secret' : 'the app secret'} frees its seat at once`, async () => {
    const h = await bootChartServer({ handSeat: HAND });
    const session = `bye-bound-proxy-${origin}`;
    if (origin === 'outside') fs.writeFileSync(seatSecretPath(h.dataDir), `${HAND}\n`, { mode: 0o600 });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !k.startsWith('PHOSPHOR_') && !k.startsWith('ACC_')) env[k] = v;
    env.PHOSPHOR_PORT = new URL(h.url).port;
    env.PHOSPHOR_DATA_DIR = h.dataDir;
    env.PHOSPHOR_SESSION = session;
    if (origin === 'app') env.PHOSPHOR_SEAT = h.seat;
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp.ts')], cwd: ROOT, env });
    const client = new Client({ name: 'phosphor-bye-bound-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      assert.ok(await until(() => h.agents.member(session) !== null, 5000), 'the proxy never took its seat');
      assert.equal(h.agents.member(session)?.origin, origin);
      await client.close();
      assert.ok(await until(() => h.agents.member(session) === null, 3000), 'the proxy closed and its seat is still held');
    } finally {
      await client.close().catch(() => {});
      await h.close();
    }
  });
}

/* Another key can take a lapsed seat's id. It holds that seat, so its bye ends it, but the person's
   Allow was given to the first proxy's key and stays for it; and a mark the other key's seat
   started with goes when the allowed proxy is back (re-audit R-L8). */
test('a key that took a lapsed allowed id cannot bye the Allow away, and leaves no mark on the allowed proxy that returns', () => {
  let now = 1_000_000;
  const agents = createAgents(() => now, MAX_AGENTS, { secret: 'o'.repeat(64), handSecret: HAND });
  const seat = 'bye-bound-retaken';
  assert.ok(agents.claim({ session: seat, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 }).ok);
  assert.ok(agents.allow(seat).ok);

  now += 60_000;
  agents.sweep();
  const taken = agents.claim({ session: seat, client: 'claude-code', secret: HAND, key: OTHER_KEY, intervalMs: 5000 });
  assert.ok(taken.ok);
  assert.equal(taken.member.allowed, false, 'the Allow is not the other key\'s');
  assert.equal(outsideBy(seat), true);
  const bye = agents.release({ session: seat, secret: HAND, key: OTHER_KEY });
  assert.equal(bye.ok, true, 'it ends the seat it holds');

  const back = agents.claim({ session: seat, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 });
  assert.ok(back.ok);
  assert.equal(back.member.allowed, true, 'the Allow is still there for the proxy it was given to');
  assert.equal(outsideBy(seat), false, 'and no mark makes its moves wait');
});

test('an allowed proxy that returns after another key held its lapsed id is not left waiting under the other key\'s mark', () => {
  let now = 2_000_000;
  const agents = createAgents(() => now, MAX_AGENTS, { secret: 'o'.repeat(64), handSecret: HAND });
  const seat = 'bye-bound-stale';
  assert.ok(agents.claim({ session: seat, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 }).ok);
  assert.ok(agents.allow(seat).ok);
  now += 60_000;
  agents.sweep();
  assert.ok(agents.claim({ session: seat, client: 'claude-code', secret: HAND, key: OTHER_KEY, intervalMs: 5000 }).ok);
  assert.equal(outsideBy(seat), true);
  now += 60_000;
  agents.sweep();
  const back = agents.claim({ session: seat, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 });
  assert.ok(back.ok);
  assert.equal(back.member.allowed, true);
  assert.equal(outsideBy(seat), false, 'the roster shows it allowed, so nothing may hold its moves as an outside agent');
});
