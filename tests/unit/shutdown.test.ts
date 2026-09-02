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

import { createShutdown, within, SETTLE_CAP_MS } from '../../src/shutdown.ts';
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
  void serialise(() => Promise.reject(new Error('rail threw'))).catch(() => undefined);
  await serialise.idle();
});

test('the draining flag is one answer for the whole process', () => {
  resetDrainingForTests();
  assert.equal(isDraining(), false);
  beginDraining();
  assert.equal(isDraining(), true);
  resetDrainingForTests();
});

test('the settle cap is two seconds', () => {
  assert.equal(SETTLE_CAP_MS, 2_000);
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
    headers: { 'content-type': 'application/json' },
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
