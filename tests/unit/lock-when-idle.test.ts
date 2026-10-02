// The lock the shell takes on its way out and when the person steps away: POST /api/lock with
// whenIdle, which the backend decides in one step: at once, unless a move has not signed yet, and
// then the wallet is shut and the key goes the moment that signature is made.
//
// A rail mid-flight reads the key from the keystore, which refuses once the wallet is locked, so
// a lock landing before its signature cuts the move partway: the one thing the drain in
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

type World = { rows: Array<Record<string, unknown>>; locks: number; audit: string[]; closing: string[] };

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
      // The real one is tests/unit/lock-when-signed.test.ts; this records the ask.
      lockWhen: (key: string) => {
        world.closing.push(key);
        state = 'locked';
        return true;
      },
      isUnlocked: () => state === 'unlocked',
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

const row = (id: string, status: string, result?: Record<string, unknown>) => ({ id, kind: 'swap', status, createdAt: '2026-09-25T10:00:00Z', ...(result === undefined ? {} : { result }) });

test('a lock asked for when idle while a move has not signed yet shuts the wallet and waits for that signature', async () => {
  const world: World = { rows: [row('p-1', 'executing'), row('p-2', 'executed')], locks: 0, audit: [], closing: [] };
  const answer = await lock(world, { reason: 'quitting', whenIdle: true });
  assert.equal(answer.status, 200, 'a refusal is an answer, the way every custody refusal is');
  assert.equal(answer.json.ok, false);
  assert.equal(answer.json.code, 'busy', 'a quit still waits on its drain');
  assert.equal(answer.json.executing, 1);
  assert.match(answer.json.error, /being signed/);
  assert.equal(world.locks, 0, 'the key is not wiped under the signature');
  assert.deepEqual(world.closing, ['when-idle'], 'the wallet closes behind it instead of staying open');
  assert.equal(world.audit.length, 1);
  assert.match(world.audit[0], /^the wallet was shut \(quitting\); its key goes as soon as the move already signing has a signature/);
});

test('a lock asked for when idle locks at once while a move only waits for its delivery', async () => {
  const watching = row('p-1', 'executing', { ok: false, detail: 'submitted, waiting for the venue', txids: ['0xabc'] });
  const world: World = { rows: [watching, row('p-2', 'executed'), row('p-3', 'pending')], locks: 0, audit: [], closing: [] };
  const answer = await lock(world, { reason: 'the screen locked', whenIdle: true });
  assert.equal(answer.json.ok, true);
  assert.equal(world.locks, 1);
  assert.deepEqual(world.closing, []);
  assert.deepEqual(world.audit, ['the wallet was locked (the screen locked)']);
});

test('a lock asked for when idle locks once nothing is being sent, with its reason in the log', async () => {
  const world: World = { rows: [row('p-2', 'executed'), row('p-3', 'pending')], locks: 0, audit: [], closing: [] };
  const answer = await lock(world, { reason: 'quitting', whenIdle: true });
  assert.equal(answer.json.ok, true);
  assert.equal(world.locks, 1);
  assert.deepEqual(world.audit, ['the wallet was locked (quitting)']);
});

test('the person\'s own Lock is never refused, move or no move', async () => {
  const world: World = { rows: [row('p-1', 'executing')], locks: 0, audit: [], closing: [] };
  const answer = await lock(world, {});
  assert.equal(answer.json.ok, true);
  assert.equal(world.locks, 1);
});

test('every lock the shell sends on its way out is the backend\'s own when-idle lock, through one helper', () => {
  const backend = read('../../src-tauri/src/backend.rs');
  const shell = read('../../src-tauri/src/main.rs');
  const update = read('../../src-tauri/src/update.rs');
  const watch = read('../../src-tauri/src/session_watch.rs');
  const code = (source: string): string => source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  assert.ok(/"whenIdle": true/.test(backend), 'the lock request asks the backend to decide');
  for (const [name, source] of [['main.rs', shell], ['update.rs', update], ['backend.rs', backend], ['session_watch.rs', watch]]) {
    assert.equal(/\bpost_lock\(/.test(code(source)), false, `${name} sends no lock that skips the check`);
  }
  assert.ok(/post_lock_when_idle\(port, &token, "the control window was closed"\)/.test(code(shell)), 'the window closing mid-quit cannot lock under a move');
  assert.ok(/lock_and_stop\(/.test(code(shell)), 'the quit locks and stops through the shared helper');
  assert.ok(/lock_and_stop\(/.test(code(update)), 'so does the update relaunch');
  assert.equal(/get_health/.test(code(shell)), false, 'the quit no longer reads health and then locks');
});

/* The person stepping away locks the wallet: macOS's screen lock and a switch to another user,
   watched by the shell (src-tauri/src/session_watch.m) and sent as the same when-idle lock. The
   chain itself runs end to end in cargo test against the staged backend; this holds the names
   the app watches for. Beside the system's, the shell hears the same signal addressed to its own
   process id, which that test and the attack suite post so no other app on the Mac hears it. */
test('a screen lock and a switch to another user send the when-idle lock, from the moment the backend answers', () => {
  const watch = read('../../src-tauri/src/session_watch.rs');
  const objc = read('../../src-tauri/src/session_watch.m');
  const shell = read('../../src-tauri/src/main.rs');
  const attack = read('../attack/cases/10-screen-lock-shell.ts');
  assert.match(watch, /pub const SCREEN_LOCKED: &str = "com\.apple\.screenIsLocked";/);
  assert.match(watch, /watch_for\(SCREEN_LOCKED, &screen_locked_here\(std::process::id\(\)\)\)/);
  assert.match(watch, /format!\("com\.karimbabasf\.phosphor\.test\.screenIsLocked\.\{pid\}"\)/);
  assert.match(attack, /'com\.karimbabasf\.phosphor\.test\.screenIsLocked\.'/, 'the attack suite posts the name the shell hears');
  assert.match(watch, /post_lock_when_idle\(port, token, reason\)/);
  assert.match(objc, /addObserverForName:NSWorkspaceSessionDidResignActiveNotification/);
  assert.match(objc, /NSDistributedNotificationCenter defaultCenter\] addObserverForName:name/);
  assert.match(shell, /session_watch::watch\(\);/);
  // The session watch is handed this spawn's token, at the boot start and again on a respawn, so a
  // screen lock after a restart still locks the fresh backend with its own token; and with it the
  // question whether that spawn still runs, asked before every post (re-audit R-L7).
  assert.equal([...shell.matchAll(/session_watch::backend_up\(port, &hand\.token, move \|\| up\.state::<Backend>\(\)\.alive\(generation\)\);/g)].length, 2);
  assert.match(watch, /held\.filter\(\|h\| \(h\.alive\)\(\)\)/, 'a lock goes only to the spawn that is running now');
  assert.match(watch, /if !up\(\) \{\s*return LockAnswer::Busy;/, 'and stops asking once it is gone');
});
