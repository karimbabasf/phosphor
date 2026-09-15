// The agent's door takes this boot's seat secret on every op, from every session.
//
// THE FAILURE. /api/mcp was gated by Origin and nothing else. Origin is a header any local
// process sets, so a postinstall in any repo, a browser extension's native host or a compromised
// CLI could POST a propose with a session string of its choosing; the roster seated it, the
// policy engine answered `allow` at or under the click threshold, and the rail signed. No click at
// any point, bounded only by the caps. The seat secret existed and guarded something much
// smaller: whether a NEW session could take one of the four reserved seats.
//
// THE FIX. The secret is the door's credential now. Every op, hello and bye included, carries it
// or is refused with 401 before the roster, the audit line or any handler sees the body. The
// agents this app spawns get it through their environment (PHOSPHOR_SEAT); a proxy a human started
// by hand reads it off <dataDir>/agent.secret, which the app writes at boot, owner-readable only,
// new each boot. The window's own routes are untouched: they carry the window token.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';
import { SEAT_SECRET_FILE } from '../../src/agents.ts';

const OPS: Array<[string, Record<string, unknown>]> = [
  ['hello', { op: 'hello', client: 'x', intervalMs: 5000 }],
  ['read', { op: 'read', tool: 'start' }],
  ['propose', { op: 'propose', kind: 'swap', params: { chain: 'arb', fromSymbol: 'USDC', toSymbol: 'WETH', amountIn: 5, minAmountOut: 0 } }],
  ['bye', { op: 'bye' }],
  ['view', { op: 'view', tool: 'chart_read', args: {} }],
  ['set_view_mode', { op: 'set_view_mode', mode: 'pro' }],
];

test('every op on /api/mcp is refused without the seat secret, and the sentence names the file', async () => {
  const h = await bootChartServer();
  try {
    for (const [name, body] of OPS) {
      const out = await h.post('/api/mcp', { ...body, session: `no-secret-${name}`, client: 'x' });
      assert.equal(out.status, 401, `${name} without a secret must be refused`);
      assert.match(String(out.json.error), new RegExp(SEAT_SECRET_FILE), `${name}: the refusal must say where the secret is`);
      assert.match(String(out.json.error), /PHOSPHOR_SEAT/, `${name}: the refusal must name the variable a spawned agent gets`);
    }
    assert.equal(h.agents.member('no-secret-hello'), null, 'a refused hello must not seat the session');
    assert.equal(h.agents.member('no-secret-read'), null, 'a refused read must not seat the session');
  } finally {
    await h.close();
  }
});

test('a wrong secret is worth exactly as much as no secret', async () => {
  const h = await bootChartServer();
  try {
    for (const guess of [h.seat.slice(0, -1), `${h.seat}b`, 'b'.repeat(h.seat.length), '', 42, null, { secret: h.seat }]) {
      const out = await h.post('/api/mcp', { op: 'hello', client: 'x', session: 'guesser', secret: guess });
      assert.equal(out.status, 401, `${JSON.stringify(guess).slice(0, 16)} must not open the door`);
    }
    assert.equal(h.agents.member('guesser'), null);
  } finally {
    await h.close();
  }
});

test('the right secret opens the door on hello, read and propose', async () => {
  const h = await bootChartServer();
  try {
    const hello = await h.post('/api/mcp', { op: 'hello', client: 'x', intervalMs: 5000, session: 'holder', secret: h.seat });
    assert.equal(hello.status, 200, JSON.stringify(hello.json));
    assert.equal(hello.json.seat, 'held');

    const read = await h.post('/api/mcp', { op: 'read', tool: 'start', session: 'holder', secret: h.seat });
    assert.equal(read.status, 200, JSON.stringify(read.json).slice(0, 200));

    // The propose reaches the door's own argument checks, which is past the credential: a refusal
    // about the amount is the propose path speaking, and a 401 would be the door.
    const propose = await h.post('/api/mcp', {
      op: 'propose',
      kind: 'swap',
      params: { chain: 'arb', fromSymbol: 'USDC', toSymbol: 'WETH', amountIn: -1, minAmountOut: 0 },
      session: 'holder',
      secret: h.seat,
    });
    assert.equal(propose.status, 400);
    assert.match(String(propose.json.error), /amountIn/);
  } finally {
    await h.close();
  }
});

test('a refusal is audited once per session and the line never carries the secret', async () => {
  const h = await bootChartServer();
  try {
    for (let n = 0; n < 5; n += 1) await h.post('/api/mcp', { op: 'hello', client: 'x', session: 'noisy', secret: 'not-it-' + h.seat });
    const lines = h.audit.tail(50).filter((e) => e.type === 'agent_rejected');
    assert.equal(lines.length, 1, 'a loop of refusals must not be a loop of audit lines');
    const text = JSON.stringify(lines);
    assert.ok(!text.includes(h.seat), 'the audit line must not carry the seat secret');
    assert.ok(!text.includes('not-it-'), 'the audit line must not carry the guess either');
    assert.match(text, /noisy/, 'the line names the session that was refused');
  } finally {
    await h.close();
  }
});

test('the window routes still take the window token and never the seat secret', async () => {
  const h = await bootChartServer();
  try {
    const withToken = await h.post('/api/view', { view: 'pro', token: h.token });
    assert.equal(withToken.status, 200, 'the window token is the credential on the window routes');
    const withSeat = await h.post('/api/view', { view: 'pro', secret: h.seat });
    assert.equal(withSeat.status, 403, 'the seat secret must not stand in for the window token');
  } finally {
    await h.close();
  }
});
