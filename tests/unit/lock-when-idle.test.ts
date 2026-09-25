// The lock the shell takes on its way out: POST /api/lock with whenIdle, which the backend
// decides in one step, locking only while no move is being sent.
//
// A rail mid-flight reads the key through keystore.keys(), which throws once the wallet is
// locked, so a lock landing under it cuts the move partway: the one thing the drain in
// src/shutdown.ts exists to prevent. Two paths put a lock there. The quit read /api/health and
// then posted the lock, two requests with room between them for a move to start; and the window
// closing while a quit drained posted a plain lock with no check at all. Here the route is
// driven through the real router with a keystore that counts its locks, and the shell's source
// is read for every lock it sends (tsc and cargo never see the one from the other).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { handle } from '../../src/http/router.ts';
import type { Ctx } from '../../src/http/context.ts';

const TOKEN = 't'.repeat(64);
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

type World = { rows: Array<Record<string, unknown>>; locks: number; audit: string[] };

function ctxOf(world: World): Ctx {
  let state: 'locked' | 'unlocked' = 'unlocked';
  return {
    token: TOKEN,
    audit: { append: (_kind: string, line: string) => { world.audit.push(line); } },
    proposals: { list: () => world.rows },
    keystore: {
      lock: () => {
        world.locks += 1;
        const was = state === 'unlocked';
        state = 'locked';
        return was;
      },
      state: () => state,
    },
    sse: { broadcastLock: () => {}, broadcastState: () => {} },
  } as unknown as Ctx;
}

async function lock(world: World, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const server = http.createServer((req, res) => void handle(ctxOf(world), req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ token: TOKEN, ...body }),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const row = (id: string, status: string) => ({ id, kind: 'swap', status, createdAt: '2026-09-25T10:00:00Z' });

test('a lock asked for when idle is refused while a move is being sent, and the wallet keeps its key', async () => {
  const world: World = { rows: [row('p-1', 'executing'), row('p-2', 'executed')], locks: 0, audit: [] };
  const answer = await lock(world, { reason: 'quitting', whenIdle: true });
  assert.equal(answer.status, 200, 'a refusal is an answer, the way every custody refusal is');
  assert.equal(answer.json.ok, false);
  assert.equal(answer.json.code, 'busy');
  assert.equal(answer.json.executing, 1);
  assert.match(answer.json.error, /being sent/);
  assert.equal(world.locks, 0, 'the keystore was never asked to lock under the move');
  assert.deepEqual(world.audit, []);
});

test('a lock asked for when idle locks once nothing is being sent, with its reason in the log', async () => {
  const world: World = { rows: [row('p-2', 'executed'), row('p-3', 'pending')], locks: 0, audit: [] };
  const answer = await lock(world, { reason: 'quitting', whenIdle: true });
  assert.equal(answer.json.ok, true);
  assert.equal(world.locks, 1);
  assert.deepEqual(world.audit, ['the wallet was locked (quitting)']);
});

test('the person\'s own Lock is never refused, move or no move', async () => {
  const world: World = { rows: [row('p-1', 'executing')], locks: 0, audit: [] };
  const answer = await lock(world, {});
  assert.equal(answer.json.ok, true);
  assert.equal(world.locks, 1);
});

test('every lock the shell sends on its way out is the backend\'s own when-idle lock, through one helper', () => {
  const backend = read('../../src-tauri/src/backend.rs');
  const shell = read('../../src-tauri/src/main.rs');
  const update = read('../../src-tauri/src/update.rs');
  const code = (source: string): string => source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  assert.ok(/"whenIdle": true/.test(backend), 'the lock request asks the backend to decide');
  for (const [name, source] of [['main.rs', shell], ['update.rs', update], ['backend.rs', backend]]) {
    assert.equal(/\bpost_lock\(/.test(code(source)), false, `${name} sends no lock that skips the check`);
  }
  assert.ok(/post_lock_when_idle\(port, &token, "the control window was closed"\)/.test(code(shell)), 'the window closing mid-quit cannot lock under a move');
  assert.ok(/lock_and_stop\(/.test(code(shell)), 'the quit locks and stops through the shared helper');
  assert.ok(/lock_and_stop\(/.test(code(update)), 'so does the update relaunch');
  assert.equal(/get_health/.test(code(shell)), false, 'the quit no longer reads health and then locks');
});
