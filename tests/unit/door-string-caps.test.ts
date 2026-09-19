// Every free-text argument an agent sends has a ceiling, and the audit line keeps a cut copy.
//
// Before this, the only bound on a string was the 1 MiB body cap. A 900 KiB symbol through
// propose_send went into the refusal reason, into proposals.json (1.8 MB per call), into the
// audit log (3.7 MB per call, and log_tail hands that to every agent) and into every state frame
// the window was sent afterwards (3.7 MB each): a griefing of the approval surface from any seat.
// Now the agent door refuses any string over MAX_ARG_CHARS by its path, the propose door holds
// each of its fields to what the field is (a ticker, an address, a line), and the tool_call line
// stores at most MAX_LOGGED_CHARS of any string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Proposal } from '../../src/types.ts';
import { MAX_AGENTS, RESERVED_SEATS, createAgents } from '../../src/agents.ts';
import { MAX_ARG_CHARS, MAX_LOGGED_CHARS, handleMcp } from '../../src/http/mcp.ts';
import { ADDRESS_MAX, ID_MAX, NOTE_MAX, SENTENCE_MAX, SYMBOL_MAX, WHERE_MAX } from '../../src/http/propose.ts';
import { capStrings, oversizeString } from '../../src/http/respond.ts';
import type { Ctx } from '../../src/http/context.ts';
import { makeHttp, serviceThatAnswers } from './helpers/http.ts';

const FRIEND = '0xb583f41992Cd21b2F2345e194a36D33684BB5DB0';

function row(): Proposal {
  return {
    id: 'p-1',
    kind: 'intents_pay',
    status: 'pending',
    createdAt: new Date().toISOString(),
    draft: { kind: 'intents_pay', symbol: 'USDC', originAsset: 'x', network: 'ethereum', amount: 1, amountUsd: 1, minReceived: 0.97, from: '0x1', to: FRIEND, toChecksum: 'valid', counterparty: 'intents.near', recipient: { known: false, count: 0, lastAt: null, activity: null, ownAddress: false } },
    verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: null,
  } as unknown as Proposal;
}

// ---------- the propose door ----------

test('a symbol over the cap is refused at the propose door with the field named, and one at the cap goes through', async () => {
  const h = makeHttp({ proposals: serviceThatAnswers(row()) });
  const huge = await h.post('send', { to: FRIEND, symbol: 'B'.repeat(900 * 1024), amount: 1, where: 'ethereum', confirmed: true });
  assert.equal(huge.status, 400);
  assert.match(String(huge.json.error), new RegExp(`^symbol is ${900 * 1024} characters, over the ${SYMBOL_MAX} this field takes`));
  assert.ok(String(huge.json.error).length < 200, 'the refusal does not echo the string');

  const over = await h.post('send', { to: FRIEND, symbol: 'B'.repeat(SYMBOL_MAX + 1), amount: 1, where: 'ethereum', confirmed: true });
  assert.equal(over.status, 400);
  assert.match(String(over.json.error), /symbol is 17 characters/);

  const at = await h.post('send', { to: FRIEND, symbol: 'B'.repeat(SYMBOL_MAX), amount: 1, where: 'ethereum', confirmed: true });
  assert.equal(at.status, 200, JSON.stringify(at.json));
});

test('every free-text field on every propose kind has its own cap', async () => {
  const h = makeHttp({ proposals: serviceThatAnswers(row()) });
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['send', { to: 'a'.repeat(ADDRESS_MAX + 1), symbol: 'USDC', amount: 1, where: 'ethereum', confirmed: true }, /^to is 129 characters, over the 128/],
    ['send', { to: FRIEND, symbol: 'USDC', amount: 1, where: 'e'.repeat(WHERE_MAX + 1), confirmed: true }, /^where is 33 characters, over the 32/],
    ['send', { to: FRIEND, symbol: 'USDC', amount: 1, where: 'ethereum', confirmed: true, note: 'n'.repeat(NOTE_MAX + 1) }, /^note is 281 characters, over the 280/],
    ['swap', { chain: 'eth', fromSymbol: 'F'.repeat(SYMBOL_MAX + 1), toSymbol: 'USDC', amountIn: 1, minAmountOut: 0.5 }, /^fromSymbol is 17 characters/],
    ['swap', { chain: 'eth', fromSymbol: 'USDC', toSymbol: 'T'.repeat(SYMBOL_MAX + 1), amountIn: 1, minAmountOut: 0.5 }, /^toSymbol is 17 characters/],
    ['hl_deposit', { symbol: 'S'.repeat(SYMBOL_MAX + 1), amount: 10 }, /^symbol is 17 characters/],
    ['trade', { planId: 'p'.repeat(ID_MAX + 1) }, /^planId is 65 characters/],
    ['trade_change', { id: 'i'.repeat(ID_MAX + 1), cancel: true }, /^id is 65 characters/],
    ['policy_change', { patch: {}, sentence: 's'.repeat(SENTENCE_MAX + 1) }, /^sentence is 1001 characters, over the 1000/],
  ];
  for (const [kind, params, why] of cases) {
    const r = await h.post(kind, params);
    assert.equal(r.status, 400, `${kind} ${JSON.stringify(params).slice(0, 60)}: ${JSON.stringify(r.json).slice(0, 120)}`);
    assert.match(String(r.json.error), why);
  }
  // At the cap, each of them reaches the service.
  const fine = [
    await h.post('send', { to: FRIEND, symbol: 'USDC', amount: 1, where: 'ethereum', confirmed: true, note: 'n'.repeat(NOTE_MAX) }),
    await h.post('policy_change', { patch: {}, sentence: 's'.repeat(SENTENCE_MAX) }),
    await h.post('trade_change', { id: 'i'.repeat(ID_MAX), cancel: true }),
  ];
  assert.deepEqual(fine.map((r) => r.status), [200, 200, 200]);
});

// ---------- the agent door ----------

test('oversizeString names the first string over the cap by its path, and capStrings cuts every string with its length', () => {
  assert.deepEqual(oversizeString({ a: 'x', b: { c: ['y', 'z'.repeat(10)] } }, 9), { path: 'body.b.c[1]', length: 10 });
  assert.equal(oversizeString({ a: 'x', b: { c: ['y', 'z'.repeat(10)] } }, 10), null);
  assert.equal(oversizeString('short', 5), null);
  assert.equal(oversizeString(42, 1), null);
  assert.deepEqual(capStrings({ a: 'x'.repeat(300), n: 1, l: ['y'.repeat(257), null] }, 256), {
    a: `${'x'.repeat(256)}... (300 characters)`,
    n: 1,
    l: [`${'y'.repeat(256)}... (257 characters)`, null],
  });
});

type Wire = { url: string; close: () => Promise<void>; audit: Array<{ type: string; data: unknown }> };

async function boot(): Promise<Wire> {
  const audit: Array<{ type: string; data: unknown }> = [];
  const agents = createAgents(Date.now, MAX_AGENTS, { reserved: RESERVED_SEATS, secret: 'seat-secret-for-this-test-0000000000' });
  agents.markAnalyst('worker-1');
  const ctx = {
    cfg: { dataDir: '/tmp/phosphor-caps-test' },
    agents,
    seats: new Set<string>(),
    audit: { append: (type: string, _msg: string, data: unknown) => audit.push({ type, data }) },
    sse: { broadcastState: () => {}, broadcastActivity: () => {} },
    getView: () => 'basic',
  } as unknown as Ctx;
  const server = http.createServer((req, res) => {
    void handleMcp(ctx, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())), audit };
}

async function post(wire: Wire, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${wire.url}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: wire.url },
    body: JSON.stringify({ secret: 'seat-secret-for-this-test-0000000000', session: 'worker-1', client: 'caps', ...body }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('the agent door refuses any string over MAX_ARG_CHARS by its path, on a read, a hello and a propose alike', async () => {
  const wire = await boot();
  try {
    const read = await post(wire, { op: 'read', tool: 'market_search', args: { query: 'q'.repeat(MAX_ARG_CHARS + 1) } });
    assert.equal(read.status, 400);
    assert.equal(read.json.error, `body.args.query is ${MAX_ARG_CHARS + 1} characters, over the ${MAX_ARG_CHARS} this door takes`);
    const hello = await post(wire, { op: 'hello', client: 'c'.repeat(5000) });
    assert.equal(hello.status, 400);
    assert.match(String(hello.json.error), /^body\.client is 5000 characters/);
    const nested = await post(wire, { op: 'propose', kind: 'trade', params: { plan: { when: [{ note: 'w'.repeat(2000) }] } } });
    assert.equal(nested.status, 400);
    assert.match(String(nested.json.error), /^body\.params\.plan\.when\[0\]\.note is 2000 characters/);
    assert.equal(wire.audit.filter((e) => e.type === 'tool_call').length, 0, 'a refused call is not a tool call');
  } finally {
    await wire.close();
  }
});

test('the tool_call line keeps a cut copy of every argument', async () => {
  const wire = await boot();
  try {
    // Under the door's ceiling, over the propose door's, and the worker seat is refused by role
    // before any draft: the line is written on the way in, whatever the door then says.
    const r = await post(wire, { op: 'propose', kind: 'send', params: { to: FRIEND, symbol: 'S'.repeat(1000), amount: 1, where: 'ethereum', confirmed: true } });
    assert.equal(r.status, 403);
    const line = wire.audit.find((e) => e.type === 'tool_call');
    assert.ok(line !== undefined, 'the call was logged');
    const logged = line.data as { params: { symbol: string; to: string }; secret?: unknown };
    assert.equal(logged.params.symbol, `${'S'.repeat(MAX_LOGGED_CHARS)}... (1000 characters)`);
    assert.equal(logged.params.to, FRIEND, 'a short string is kept whole');
    assert.equal(logged.secret, undefined, 'and the credential is still not part of the record');
  } finally {
    await wire.close();
  }
});
