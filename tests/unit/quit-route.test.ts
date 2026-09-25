// GET /api/quit: what the quit sheet says quitting would interrupt, read off the state the app
// already keeps. Driven through the real router, so the Host gate in front of it is the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { handle } from '../../src/http/router.ts';
import type { Ctx } from '../../src/http/context.ts';
import type { QuitReport } from '../../src/http/quit.ts';

type World = {
  proposals?: Record<string, unknown>[];
  plans?: Record<string, unknown>[];
  thinking?: boolean;
  positions?: number;
  deposit?: Record<string, unknown> | null;
};

function ctxOf(world: World): Ctx {
  return {
    audit: { append: () => {} },
    proposals: { list: () => world.proposals ?? [] },
    trade: {
      payload: () => ({ plans: world.plans ?? [], positions: new Array(world.positions ?? 0).fill({}), orders: [] }),
    },
    chats: { all: () => [{ driver: { status: () => ({ state: world.thinking === true ? 'thinking' : 'ready' }) } }] },
    deposits: { current: () => world.deposit ?? null },
  } as unknown as Ctx;
}

async function ask(world: World, host = '127.0.0.1'): Promise<{ status: number; body: QuitReport }> {
  const server = http.createServer((req, res) => void handle(ctxOf(world), req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/quit', headers: { host: `${host}:${port}` } }, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as QuitReport }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const swap = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'swap', status, createdAt: '2026-09-25T10:00:00Z', ...extra });

test('nothing running: no lines, nothing to wait for', async () => {
  const { status, body } = await ask({ proposals: [swap('p-done', 'executed'), swap('p-no', 'refused')] });
  assert.equal(status, 200);
  assert.deepEqual(body.moving, []);
  assert.deepEqual(body.waiting, []);
  assert.equal(body.agent, false);
  assert.deepEqual(body.lines, []);
});

test('a swap in flight is named, and it is what the sheet waits on', async () => {
  const { body } = await ask({
    proposals: [swap('p-1', 'executing', { result: { ok: true, detail: '', evidence: { providerStage: 'PENDING' } } })],
  });
  assert.deepEqual(body.moving, ['p-1']);
  assert.equal(body.lines.length, 1);
  assert.equal(body.lines[0].kind, 'moving');
  assert.equal(body.lines[0].lead, 'Your swap is on its way.');
  assert.match(body.lines[0].rest, /finishes without Phosphor/);
});

test('a move waiting for a click is waiting, never moving', async () => {
  const { body } = await ask({ proposals: [swap('p-2', 'pending'), swap('p-3', 'pending_unlock')] });
  assert.deepEqual(body.moving, []);
  assert.deepEqual(body.waiting, ['p-2', 'p-3']);
  assert.equal(body.lines[0].lead, '2 moves are waiting for your OK.');
  assert.equal(body.lines[0].rest, 'Nothing moves without you.');
});

test('a move held by its checks is cancelled by a quit and is not waited on', async () => {
  const { body } = await ask({ proposals: [swap('p-4', 'approved', { heldSince: '2026-09-25T10:00:00Z' })] });
  assert.deepEqual(body.moving, []);
  assert.equal(body.lines[0].kind, 'held');
  assert.match(body.lines[0].rest, /Quitting cancels it/);
});

test('a late or filed row is not something quitting interrupts', async () => {
  const { body } = await ask({
    proposals: [
      swap('p-5', 'needs_reconciliation', { stalledAt: '2026-09-25T10:30:00Z' }),
      swap('p-6', 'needs_reconciliation', { acknowledgedAt: '2026-09-25T10:30:00Z' }),
    ],
  });
  assert.deepEqual(body.moving, []);
  assert.deepEqual(body.lines, []);
});

test('an armed bar-close plan is named as local: it cannot fire while the app is closed', async () => {
  const { body } = await ask({
    plans: [
      { id: 'pl-1', symbol: 'BTC', side: 'long', status: 'waiting', when: [{ type: 'close', tf: '1h', is: 'above', at: { px: 64000 } }] },
      { id: 'pl-2', symbol: 'ETH', side: 'short', status: 'waiting', locked: true },
      { id: 'pl-3', symbol: 'SOL', side: 'long', status: 'idea' },
    ],
  });
  assert.deepEqual(body.watching, ['pl-1']);
  assert.equal(body.lines.length, 1);
  assert.equal(body.lines[0].kind, 'plan');
  assert.equal(body.lines[0].lead, 'Your BTC long is watching the chart.');
  assert.equal(body.lines[0].rest, 'It can only fire while Phosphor is open.');
});

test('a resting entry with no stop yet is the warning, and it comes first', async () => {
  const { body } = await ask({
    proposals: [swap('p-7', 'executing')],
    plans: [{ id: 'pl-4', symbol: 'BTC', side: 'long', status: 'placed' }, { id: 'pl-5', symbol: 'ETH', side: 'long', status: 'open' }],
    positions: 1,
  });
  assert.deepEqual(body.unprotected, ['pl-4']);
  assert.equal(body.lines[0].kind, 'entry');
  assert.equal(body.lines[0].tone, 'warn');
  assert.match(body.lines[0].rest, /no stop until you open Phosphor and unlock/);
  assert.deepEqual(body.lines.map((l) => l.kind), ['entry', 'moving', 'venue']);
});

test('an agent mid-answer and money on its way in are both said', async () => {
  const { body } = await ask({ thinking: true, deposit: { phase: 'seen' } });
  assert.equal(body.agent, true);
  assert.deepEqual(body.lines.map((l) => l.kind), ['agent', 'incoming']);
});

test('the route sits behind the same Host gate as every read', async () => {
  const { status } = await ask({}, 'evil.example');
  assert.equal(status, 403);
});

test('no line carries a dash a person would read as punctuation', async () => {
  const { body } = await ask({
    proposals: [swap('a', 'executing'), swap('b', 'pending'), swap('c', 'approved', { heldSince: 'x' })],
    plans: [{ id: 'd', symbol: 'BTC', side: 'long', status: 'waiting' }, { id: 'e', symbol: 'BTC', side: 'long', status: 'placed' }],
    thinking: true,
    positions: 2,
    deposit: { phase: 'watching' },
  });
  assert.equal(body.lines.length, 8);
  for (const line of body.lines) assert.doesNotMatch(line.lead + line.rest, /[\u2013\u2014]| - /);
});
