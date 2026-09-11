// Two plans arming inside one key read, and the orphan that used to leave behind.
//
// ensureChild checked `child === null` and then AWAITED the API wallet key before forking, and
// nothing guarded that gap. Rails run outside the proposal serialiser (the reservation is
// released as soon as the row is written), so two arms could sit inside one key read
// together. The second fork overwrote the `child` binding; the first process stayed alive, had
// already been sent its `arm` message through its own handle, and held the same Hyperliquid API
// key. stopAll, setKilled, the kill switch and the SIGKILL backstop all address `child`, so the
// orphan kept placing orders with nothing in the app able to stop it.
//
// The property: however many arms are in flight, this host forks once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { createRunnerHost, type RunnerEvent } from '../../src/runner/host.ts';
import type { FromChild, ToChild } from '../../src/runner/protocol.ts';
import { createPlanStore } from '../../src/trade/plans.ts';
import type { PlanRow } from '../../src/trade/plans.ts';

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  killed = false;
  readonly sent: ToChild[] = [];
  stderr = null;
  readonly stdin = new (class extends EventEmitter {
    write(): boolean {
      return true;
    }
    end(): void {}
  })();

  send(msg: unknown): boolean {
    if (!this.connected) throw new Error('ERR_IPC_CHANNEL_CLOSED: channel closed');
    const m = msg as ToChild;
    this.sent.push(m);
    let reply: FromChild | null = null;
    if (m.cmd === 'arm') reply = { ev: 'armed', seq: m.seq, id: m.plan.id };
    if (m.cmd === 'flatten') reply = { ev: 'flat', seq: m.seq, stillOpen: [], detail: '' };
    if (m.cmd === 'release') reply = { ev: 'released', seq: m.seq, id: m.id };
    if (reply !== null) setImmediate(() => this.emit('message', reply));
    return true;
  }

  kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }
}

function plan(id: string): PlanRow {
  return {
    id,
    symbol: 'ETH',
    side: 'long',
    sizeUsd: 100,
    leverage: 2,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    // A window far ahead, so nothing fires and the test is about the fork alone.
    when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'waiting',
    hash: `hash-${id}`,
    cloids: {},
    gen: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/* The key read TAKES TIME, which is the whole point: it is a file read and, on the real path,
   a keystore decrypt. The gap it opens is where the second fork used to happen. */
function host(keyDelayMs = 20) {
  const forked: FakeChild[] = [];
  const events: RunnerEvent[] = [];
  const runner = createRunnerHost({
    apiWalletKey: async () => {
      await new Promise((resolve) => setTimeout(resolve, keyDelayMs));
      return '0x'.padEnd(66, '1') as `0x${string}`;
    },
    baseUrl: 'http://127.0.0.1:1',
    user: '0x0000000000000000000000000000000000000001',
    killSwitch: () => false,
    onEvent: (e) => events.push(e),
    store: createPlanStore(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-fork-race-'))),
    meta: () => ({ assetId: 1, szDecimals: 4, maxLeverage: 25 }),
    mark: () => 100,
    free: () => 1000,
    replyMs: 500,
    forkImpl: (() => {
      const child = new FakeChild();
      forked.push(child);
      return child as unknown as ChildProcess;
    }) as never,
  });
  return { runner, forked, events };
}

test('two plans arming at once share one child, so no process is left holding the key', async () => {
  const h = host();

  const [first, second] = await Promise.all([h.runner.arm(plan('m1')), h.runner.arm(plan('m2'))]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(h.forked.length, 1, 'one fork, however many arms were inside the key read');
  assert.deepEqual(
    h.forked[0].sent
      .filter((m) => m.cmd === 'arm')
      .map((m) => (m.cmd === 'arm' ? m.plan.id : ''))
      .sort(),
    ['m1', 'm2'],
    'both plans went to the one child',
  );
});

test('stopAll reaches the child every arm shares', async () => {
  const h = host();
  await Promise.all([h.runner.arm(plan('m1')), h.runner.arm(plan('m2'))]);

  await h.runner.stopAll('kill switch');

  assert.equal(h.forked.length, 1);
  assert.ok(h.forked[0].sent.some((m) => m.cmd === 'flatten'), 'the one child was asked to flatten');
  assert.ok(h.forked[0].sent.some((m) => m.cmd === 'kill'), 'and then to go');
  assert.deepEqual(h.runner.status().watching, []);
  for (const row of h.runner.plans()) assert.equal(row.status, 'done');
});

test('stopping while a fork is in flight leaves no process behind', async () => {
  // The kill switch flipped in the gap. A fork that lands after stopAll would be a child
  // nothing has a handle on, which is the same orphan by another route.
  const h = host(40);

  const arming = h.runner.arm(plan('m1'));
  await new Promise((resolve) => setTimeout(resolve, 5)); // inside the key read
  await h.runner.stopAll('kill switch');

  const out = await arming;
  assert.equal(out.ok, false, 'the arm that was starting when everything stopped does not quietly succeed');
  assert.equal(h.forked.length, 0, 'and nothing was forked after the stop');
  assert.deepEqual(h.runner.status().watching, []);
});

test('a later arm starts a new child, because stopping is not permanent', async () => {
  const h = host(5);
  await h.runner.arm(plan('m1'));
  await h.runner.stopAll('kill switch');

  const again = await h.runner.arm(plan('m2'));
  assert.equal(again.ok, true);
  assert.equal(h.forked.length, 2);
});

/* A child that dies before it reads the key raises EPIPE on ITS STDIN, and `child.on('error')`
   does not cover a stream of the child rather than the child itself. With no listener node
   re-raises it from nextTick as an uncaught exception, so a plan that could not start took
   the whole app with it. */
test('an EPIPE writing the key to a dead child is a runner event, not an uncaught exception', async () => {
  const h = host(1);
  await h.runner.arm(plan('m1'));
  assert.equal(h.forked.length, 1);

  // The listener the host attaches is the whole of the fix: without one this throws.
  h.forked[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

  assert.ok(
    h.events.some((e) => e.type === 'error' && e.message.includes('never read its key')),
    'the plan hears about it, and the process keeps running',
  );
});
