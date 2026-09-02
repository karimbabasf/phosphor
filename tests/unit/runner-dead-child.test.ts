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
import type { ChildProcess } from 'node:child_process';

import { createRunnerHost, type RunnerEvent } from '../../src/runner/host.ts';
import type { Mandate } from '../../src/strategy/envelope.ts';
import type { Program } from '../../src/strategy/grammar.ts';

// A child that can be told to die. `connected` follows the same rule the real one does: false
// once the process is gone, and `send` then throws exactly as node:child_process does.
class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  killed = false;
  readonly sent: unknown[] = [];
  stderr = null;

  send(msg: unknown): boolean {
    if (!this.connected) throw new Error('ERR_IPC_CHANNEL_CLOSED: channel closed');
    this.sent.push(msg);
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

const PROGRAM: Program = {
  symbol: 'ETH',
  rules: [
    {
      id: 'a',
      when: { op: 'position', state: 'flat' },
      then: [{ do: 'open', side: 'long', sizeUsd: 10, leverage: 1, entry: { type: 'market', maxSlippageBps: 50 } }],
    },
  ],
};

function mandate(): Mandate {
  return {
    id: 'm1',
    symbol: 'ETH',
    maxNotionalUsd: 25,
    maxLeverage: 1,
    maxOrdersPerMin: 2,
    maxLossUsd: 5,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    programHash: 'unused-in-this-test',
  } as unknown as Mandate;
}

function host(): { runner: ReturnType<typeof createRunnerHost>; child: FakeChild; events: RunnerEvent[] } {
  const child = new FakeChild();
  const events: RunnerEvent[] = [];
  const runner = createRunnerHost({
    apiWalletKey: async () => '0x'.padEnd(66, '1') as `0x${string}`,
    baseUrl: 'http://127.0.0.1:1',
    user: '0x0000000000000000000000000000000000000001',
    killSwitch: () => false,
    pollMs: 100_000, // the pump never fires inside a test
    onEvent: (e) => events.push(e),
    forkImpl: (() => child as unknown as ChildProcess) as never,
  });
  return { runner, child, events };
}

test('stopAll on a dead child does not throw, and still takes the process out', async () => {
  const { runner, child } = host();
  const armed = await runner.arm(mandate(), PROGRAM);
  assert.equal(armed.ok, true);

  child.die();

  // The line that used to end the backend.
  await runner.stopAll('kill switch');

  assert.equal(child.sent.filter((m) => (m as { cmd?: string }).cmd === 'flatten_and_exit').length, 0);
  assert.deepEqual(runner.status().armed, []);
});

test('stopAll on a LIVE child still asks it to flatten first', async () => {
  const { runner, child } = host();
  await runner.arm(mandate(), PROGRAM);

  await runner.stopAll('kill switch');

  const asked = child.sent.find((m) => (m as { cmd?: string }).cmd === 'flatten_and_exit');
  assert.ok(asked !== undefined, 'a healthy child is asked to close its position before it is killed');
});

test('setKilled and disarm on a dead child do not throw either', async () => {
  const { runner, child } = host();
  await runner.arm(mandate(), PROGRAM);
  child.die();

  runner.setKilled(true);
  const out = await runner.disarm('m1', 'by hand');
  assert.equal(out.ok, true);
});

test('a child that fails to start disarms what it was holding rather than ending the app', async () => {
  const { runner, child, events } = host();
  await runner.arm(mandate(), PROGRAM);
  assert.deepEqual(runner.status().armed.map((a) => a.id), ['m1']);

  // node raises 'error' on the child for a fork that cannot start and for a send on a closed
  // channel. With no listener it becomes an uncaught exception from nextTick.
  child.connected = false;
  child.emit('error', new Error('spawn ENOENT'));

  assert.deepEqual(runner.status().armed, []);
  assert.ok(events.some((e) => e.type === 'error' && e.message.includes('spawn ENOENT')));
  assert.ok(events.some((e) => e.type === 'disarmed' && e.reason.includes('spawn ENOENT')));
});
