// The kill switch, flipped onto a runner child that is already gone.
//
// stopAll was the one send path in the host without a `connected` guard, so an IPC channel that
// had closed threw ERR_IPC_CHANNEL_CLOSED into `void runner.stopAll(...)` in main.ts, uncaught,
// and Node ended the process. The kill switch killed the app: the exact moment the switch exists
// for was the moment it took the backend down.
//
// The child here is a stand-in through the host's fork seam, because the property under test is
// what the HOST does when `connected` is false, and a real fork would need a real key and a real
// venue to reach that state.

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

// A child that can be told to die. `connected` follows the same rule the real one does: false
// once the process is gone, and `send` then throws exactly as node:child_process does.
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
    return true;
  }

  die(code = 1): void {
    this.connected = false;
    this.exitCode = code;
    this.emit('exit', code);
  }
}

function plan(): PlanRow {
  return {
    id: 'm1',
    symbol: 'ETH',
    side: 'long',
    sizeUsd: 100,
    leverage: 2,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'waiting',
    hash: 'unused-in-this-test',
    cloids: {},
    gen: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function host(): { runner: ReturnType<typeof createRunnerHost>; child: FakeChild; events: RunnerEvent[] } {
  const child = new FakeChild();
  const events: RunnerEvent[] = [];
  const runner = createRunnerHost({
    apiWalletKey: async () => '0x'.padEnd(66, '1') as `0x${string}`,
    baseUrl: 'http://127.0.0.1:1',
    user: '0x0000000000000000000000000000000000000001',
    killSwitch: () => false,
    onEvent: (e) => events.push(e),
    store: createPlanStore(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-dead-child-'))),
    meta: () => ({ assetId: 1, szDecimals: 4, maxLeverage: 25 }),
    mark: () => 100,
    free: () => 1000,
    replyMs: 200,
    forkImpl: (() => child as unknown as ChildProcess) as never,
  });
  return { runner, child, events };
}

test('stopAll on a dead child does not throw, and still finishes every plan', async () => {
  const { runner, child } = host();
  const armed = await runner.arm(plan());
  assert.equal(armed.ok, true, armed.ok ? '' : armed.reason);

  child.die();

  // The line that used to end the backend.
  await runner.stopAll('kill switch');

  assert.equal(child.sent.filter((m) => m.cmd === 'flatten').length, 0, 'nothing is sent to a dead channel');
  assert.deepEqual(runner.status().watching, []);
  assert.equal(runner.get('m1')?.status, 'done');
});

test('stopAll on a LIVE child asks it to flatten first', async () => {
  const { runner, child } = host();
  await runner.arm(plan());

  await runner.stopAll('kill switch');

  assert.ok(child.sent.some((m) => m.cmd === 'flatten'), 'a healthy child is asked to close everything before it is killed');
  assert.ok(child.sent.some((m) => m.cmd === 'kill'));
});

test('setKilled and cancel on a dead child do not throw either', async () => {
  const { runner, child } = host();
  await runner.arm(plan());
  child.die();

  runner.setKilled(true);
  const out = await runner.cancel('m1');
  assert.equal(out.ok, true, 'a waiting plan is cancelled in the registry whatever the child is doing');
});

test('a child that fails to start is a runner event rather than the end of the app', async () => {
  const { runner, child, events } = host();
  await runner.arm(plan());
  assert.deepEqual(runner.status().watching, ['ETH']);

  // node raises 'error' on the child for a fork that cannot start and for a send on a closed
  // channel. With no listener it becomes an uncaught exception from nextTick.
  child.connected = false;
  child.emit('error', new Error('spawn ENOENT'));

  assert.ok(events.some((e) => e.type === 'error' && e.message.includes('spawn ENOENT')));
  assert.equal(runner.status().child, 'off');
  // The plan is still on the record: the venue holds nothing for a waiting plan, and the next
  // command or reconcile re-arms it on a fresh child.
  assert.equal(runner.get('m1')?.status, 'waiting');
});

test('a command for a plan on a dead child answers with a sentence, not a hang', async () => {
  const { runner, child } = host();
  await runner.arm(plan());
  child.die();
  const out = await runner.change('m1', { stop: 92 });
  assert.equal(out.ok, false);
  assert.match(out.detail, /runner|answer/);
});
