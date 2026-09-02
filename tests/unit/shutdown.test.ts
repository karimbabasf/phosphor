// Stopping on purpose.
//
// Two properties. Order: drain, then settle, then close, and never the other way round, because
// draining after settling would let a write in while the app was waiting. And the cap: a rail
// that hangs must turn "quit" into a two second wait and a sentence, not into a hang.
//
// The last test is the end-to-end one the plan asks for: SIGTERM into a real backend mid
// proposal, then read proposals.json back and check it is valid JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { createShutdown, installShutdownHandlers, within, SETTLE_CAP_MS } from '../../src/shutdown.ts';
import { VENUE_WRITE_TIMEOUT_MS } from '../../src/net.ts';
import { beginDraining, isDraining, resetDrainingForTests } from '../../src/draining.ts';
import { createSerialiser } from '../../src/proposals/lifecycle.ts';
import type { LogEvent } from '../../src/types.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-shutdown-'));
}

function harness(over: Partial<{ settle: (ms: number) => Promise<boolean>; close: () => Promise<void> }> = {}): {
  run: (signal: string) => Promise<void>;
  order: string[];
  lines: string[];
  logged: string[];
  codes: number[];
} {
  const order: string[] = [];
  const lines: string[] = [];
  const logged: string[] = [];
  const codes: number[] = [];
  const run = createShutdown({
    audit: {
      append(type, msg): LogEvent {
        logged.push(`${type}: ${msg}`);
        return { ts: new Date().toISOString(), type, msg };
      },
    },
    drain: () => order.push('drain'),
    settle:
      over.settle ??
      (async () => {
        order.push('settle');
        return true;
      }),
    close:
      over.close ??
      (async () => {
        order.push('close');
      }),
    capMs: 50,
    exit: (code) => codes.push(code),
    stderr: (line) => lines.push(line),
  });
  return { run, order, lines, logged, codes };
}

test('the three steps run in order and the process exits clean', async () => {
  const h = harness();
  await h.run('SIGTERM');
  assert.deepEqual(h.order, ['drain', 'settle', 'close']);
  assert.deepEqual(h.codes, [0]);
  assert.ok(h.logged.some(l => l.includes('nothing left in flight')));
});

test('work that outlives the cap is named rather than waited on forever', async () => {
  const h = harness({
    settle: async (ms) => {
      // What a hung rail looks like: the caller's own cap is what answers.
      assert.equal(ms, 50);
      return false;
    },
  });
  await h.run('SIGINT');
  assert.deepEqual(h.codes, [0], 'it still exits');
  assert.ok(h.logged.some(l => l.includes('while work was still in flight')));
  assert.ok(h.lines.some(l => l.includes('Check the transaction history')));
});

test('a second signal stops waiting immediately', async () => {
  let release = (): void => {};
  const h = harness({ settle: () => new Promise<boolean>((resolve) => (release = () => resolve(true))) });
  const first = h.run('SIGINT');
  await h.run('SIGINT');
  assert.deepEqual(h.codes, [1], 'the impatient exit is nonzero: work was abandoned');
  assert.ok(h.lines.some(l => l.includes('again, stopping without waiting')));
  release();
  await first;
});

test('a settle that throws does not stop the shutdown', async () => {
  const h = harness({
    settle: () => {
      throw new Error('the queue is broken');
    },
  });
  await h.run('SIGTERM');
  assert.deepEqual(h.order, ['drain', 'close']);
  assert.deepEqual(h.codes, [0]);
});

test('a close that throws does not stop the exit either', async () => {
  const h = harness({
    close: () => Promise.reject(new Error('the socket would not close')),
  });
  await h.run('SIGTERM');
  assert.deepEqual(h.codes, [0]);
  assert.ok(h.lines.some(l => l.includes('closing down failed')));
});

test('within reports whether the work beat the deadline', async () => {
  assert.equal(await within(1000, Promise.resolve()), true);
  assert.equal(await within(1000, Promise.reject(new Error('failed, but finished'))), true);
  assert.equal(await within(20, new Promise(() => {})), false);
});

test('the serialiser knows when it is idle', async () => {
  const serialise = createSerialiser();
  let done = false;
  void serialise(async () => {
    await new Promise((r) => setTimeout(r, 30));
    done = true;
  });
  assert.equal(done, false);
  await serialise.idle();
  assert.equal(done, true);
});

test('a rejection in the queue still lets idle resolve', async () => {
  const serialise = createSerialiser();
  let settled = false;
  void serialise(() => Promise.reject(new Error('rail threw'))).catch(() => {
    settled = true;
  });
  await serialise.idle();
  // Without this the test passed by not hanging, which is a test of the test runner's timeout
  // rather than of the queue.
  assert.equal(settled, true, 'the failed job finished, and idle waited for it to');
});

test('the draining flag is one answer for the whole process', () => {
  resetDrainingForTests();
  assert.equal(isDraining(), false);
  beginDraining();
  assert.equal(isDraining(), true);
  resetDrainingForTests();
});

/* The cap has to cover ONE venue write or the drain is decorative for the exact case it was
   written for: a quit during a real send always timed out and stranded the row. Two seconds
   against a thirty second venue budget could never wait for anything that mattered. */
test('the settle cap covers a venue write, with a little room', () => {
  assert.ok(SETTLE_CAP_MS > VENUE_WRITE_TIMEOUT_MS, 'a quit must be able to wait for a send in flight');
  assert.ok(SETTLE_CAP_MS <= VENUE_WRITE_TIMEOUT_MS + 5_000, 'and not much longer than one');
});

// SIGTERM into a real backend, mid proposal. The property: proposals.json is valid JSON
// afterwards and the process exits 0 within a few seconds.
test('SIGTERM mid-propose leaves a valid state file and exits clean', async () => {
  const dir = tmpDir();
  const port = 4400 + (process.pid % 400);
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.ts')], {
    env: {
      ...process.env,
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_PORT: String(port),
      PHOSPHOR_DATA_DIR: dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const up = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (chunk.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  assert.equal(up, true, 'the backend came up');

  // A proposal in flight, then the signal, without waiting for the answer.
  const token = 'not-the-token'; // an MCP propose needs no token; this is only a body field
  void fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: 'POST',
    // Origin and Content-Type both required on a write; see the note in failure-modes.test.ts.
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({
      op: 'propose',
      kind: 'consolidate',
      params: { toChain: 'arb', symbol: 'USDC' },
      client: 'shutdown-test',
      session: token,
    }),
  }).catch(() => undefined);

  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(-1);
    }, 10_000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
    setTimeout(() => child.kill('SIGTERM'), 150);
  });

  assert.equal(code, 0, 'a clean exit on SIGTERM');

  const file = path.join(dir, 'proposals.json');
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    assert.notEqual(raw.trim(), '', 'never a zero-byte state file');
    assert.doesNotThrow(() => JSON.parse(raw), 'proposals.json is valid JSON after a signal');
  }
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'the instance lock is released');
});

/* ---------- the window goes away ----------

   src-tauri registers no signal handler, so on SIGTERM the shell takes the default action and
   neither `impl Drop for Backend` nor RunEvent::Exit runs. The backend was then left holding the
   port with the wallet loaded, and the next launch found the port in use. Seen twice on
   2026-09-01. The signal is the parent pid: when the process that started this one goes, this one
   is reparented, so process.ppid stops matching what it was at boot. */

async function until(done: () => boolean, why: string, capMs = 3000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(why);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function watched(over: Partial<{ ppid: () => number; alive: (pid: number) => boolean; enabled: boolean }>) {
  const order: string[] = [];
  const codes: number[] = [];
  const uninstall = installShutdownHandlers({
    audit: { append: (type, msg): LogEvent => ({ ts: new Date().toISOString(), type, msg }) },
    drain: () => order.push('drain'),
    settle: async () => {
      order.push('settle');
      return true;
    },
    close: async () => {
      order.push('close');
    },
    capMs: 20,
    exit: (code) => codes.push(code),
    stderr: () => {},
    parentWatch: { intervalMs: 5, ...over },
  });
  return { order, codes, uninstall };
}

test('a parent that is still there is not a reason to stop', async () => {
  const h = watched({ ppid: () => 4242, alive: () => true });
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(h.order, []);
    assert.deepEqual(h.codes, []);
  } finally {
    h.uninstall();
  }
});

test('a parent pid that no longer answers runs the same three steps a signal would', async () => {
  let alive = true;
  const h = watched({ ppid: () => 4242, alive: () => alive });
  try {
    alive = false;
    await until(() => h.codes.length > 0, 'the backend never stopped');
    assert.deepEqual(h.order, ['drain', 'settle', 'close'], 'drain, settle, close, in that order');
    assert.deepEqual(h.codes, [0]);
  } finally {
    h.uninstall();
  }
});

test('being reparented is the same answer, because that is what happens when a parent dies', async () => {
  let parent = 4242;
  const h = watched({ ppid: () => parent, alive: () => true });
  try {
    parent = 1; // launchd on macOS, init or a subreaper on Linux
    await until(() => h.codes.length > 0, 'a reparented backend kept running');
    assert.deepEqual(h.order, ['drain', 'settle', 'close']);
  } finally {
    h.uninstall();
  }
});

test('PHOSPHOR_NO_PARENT_WATCH=1 turns the watch off for a parent meant to exit first', async () => {
  const prev = process.env.PHOSPHOR_NO_PARENT_WATCH;
  process.env.PHOSPHOR_NO_PARENT_WATCH = '1';
  const h = watched({ ppid: () => 4242, alive: () => false });
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(h.codes, [], 'a dead parent stops nothing when the watch is off');
  } finally {
    h.uninstall();
    if (prev === undefined) delete process.env.PHOSPHOR_NO_PARENT_WATCH;
    else process.env.PHOSPHOR_NO_PARENT_WATCH = prev;
  }
});

// The real thing: three processes, and the middle one exits.
test('a real child whose parent exits shuts itself down', async () => {
  const dir = tmpDir();
  const marker = path.join(dir, 'closed');
  const child = path.join(dir, 'child.mjs');
  const parent = path.join(dir, 'parent.mjs');

  fs.writeFileSync(
    child,
    `import fs from 'node:fs';\n` +
      `import { installShutdownHandlers } from ${JSON.stringify(path.join(ROOT, 'src', 'shutdown.ts'))};\n` +
      // Stands in for the HTTP server: without something holding the loop this process would
      // exit on its own and prove nothing.
      `const hold = setInterval(() => {}, 1000);\n` +
      `installShutdownHandlers({\n` +
      `  audit: { append: () => ({ ts: '', type: 'app_start', msg: '' }) },\n` +
      `  drain: () => {},\n` +
      `  settle: async () => true,\n` +
      `  close: async () => { clearInterval(hold); fs.writeFileSync(${JSON.stringify(marker)}, 'closed'); },\n` +
      `  capMs: 50,\n` +
      `  stderr: () => {},\n` +
      `  parentWatch: { intervalMs: 25 },\n` +
      `});\n`,
  );
  fs.writeFileSync(
    parent,
    `import { spawn } from 'node:child_process';\n` +
      `spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' });\n` +
      `setTimeout(() => process.exit(0), 150);\n`,
  );

  const run = spawn(process.execPath, [parent], { stdio: 'ignore' });
  await new Promise<void>((resolve) => run.on('exit', () => resolve()));

  await until(() => fs.existsSync(marker), 'the backend outlived the process that started it', 8000);
});
