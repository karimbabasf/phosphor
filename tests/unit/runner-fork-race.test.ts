// Two mandates arming inside one key read, and the orphan that used to leave behind.
//
// ensureChild checked `child === null` and then AWAITED the API wallet key before forking, and
// nothing guarded that gap. Mandate rails run outside the proposal serialiser (the reservation
// is released as soon as the row is written), so two arms could sit inside one key read
// together. The second fork overwrote the `child` binding; the first process stayed alive, had
// already been sent its `arm` message through its own handle, and held the same Hyperliquid API
// key. stopAll, setKilled, the kill switch and the SIGKILL backstop all address `child`, so the
// orphan kept placing orders with nothing in the app able to stop it.
//
// The property: however many arms are in flight, this host forks once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { createRunnerHost, type RunnerEvent } from '../../src/runner/host.ts';
import type { Mandate } from '../../src/strategy/envelope.ts';
import type { Program } from '../../src/strategy/grammar.ts';

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  killed = false;
  readonly sent: unknown[] = [];
  stderr = null;
  readonly stdin = new (class extends EventEmitter {
    write(): boolean {
      return true;
    }
    end(): void {}
  })();

  send(msg: unknown): boolean {
    if (!this.connected) throw new Error('ERR_IPC_CHANNEL_CLOSED: channel closed');
    this.sent.push(msg);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
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

function mandate(id: string): Mandate {
  return {
    id,
    symbol: 'ETH',
    maxNotionalUsd: 25,
    maxLeverage: 1,
    maxOrdersPerMin: 2,
    maxLossUsd: 5,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    programHash: 'unused-in-this-test',
  } as unknown as Mandate;
}

/* The key read TAKES TIME, which is the whole point: it is a file read and, on the real path,
   a keystore decrypt. The gap it opens is where the second fork used to happen. */
function host(keyDelayMs = 20) {
  const forked: FakeChild[] = [];
  const runner = createRunnerHost({
    apiWalletKey: async () => {
      await new Promise((resolve) => setTimeout(resolve, keyDelayMs));
      return '0x'.padEnd(66, '1') as `0x${string}`;
    },
    baseUrl: 'http://127.0.0.1:1',
    user: '0x0000000000000000000000000000000000000001',
    killSwitch: () => false,
    pollMs: 100_000, // the pump never fires inside a test
    onEvent: () => {},
    forkImpl: (() => {
      const child = new FakeChild();
      forked.push(child);
      return child as unknown as ChildProcess;
    }) as never,
  });
  return { runner, forked };
}

test('two mandates arming at once share one child, so no process is left holding the key', async () => {
  const h = host();

  const [first, second] = await Promise.all([h.runner.arm(mandate('m1'), PROGRAM), h.runner.arm(mandate('m2'), PROGRAM)]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(h.forked.length, 1, 'one fork, however many arms were inside the key read');
  assert.deepEqual(
    h.forked[0].sent.filter((m) => (m as { cmd?: string }).cmd === 'arm').map((m) => (m as { mandate: Mandate }).mandate.id).sort(),
    ['m1', 'm2'],
    'both mandates went to the one child',
  );
});

test('stopAll reaches the child every arm shares', async () => {
  const h = host();
  await Promise.all([h.runner.arm(mandate('m1'), PROGRAM), h.runner.arm(mandate('m2'), PROGRAM)]);

  await h.runner.stopAll('kill switch');

  assert.equal(h.forked.length, 1);
  assert.ok(
    h.forked[0].sent.some((m) => (m as { cmd?: string }).cmd === 'flatten_and_exit'),
    'the one child was asked to flatten',
  );
  assert.deepEqual(h.runner.status().armed, []);
});

test('stopping while a fork is in flight leaves no process behind', async () => {
  // The kill switch flipped in the gap. A fork that lands after stopAll would be a child
  // nothing has a handle on, which is the same orphan by another route.
  const h = host(40);

  const arming = h.runner.arm(mandate('m1'), PROGRAM);
  await new Promise((resolve) => setTimeout(resolve, 5)); // inside the key read
  await h.runner.stopAll('kill switch');

  const out = await arming;
  assert.equal(out.ok, false, 'the arm that was starting when everything stopped does not quietly succeed');
  assert.equal(h.forked.length, 0, 'and nothing was forked after the stop');
  assert.deepEqual(h.runner.status().armed, []);
});

test('a later arm starts a new child, because stopping is not permanent', async () => {
  const h = host(5);
  await h.runner.arm(mandate('m1'), PROGRAM);
  await h.runner.stopAll('kill switch');

  const again = await h.runner.arm(mandate('m2'), PROGRAM);
  assert.equal(again.ok, true);
  assert.equal(h.forked.length, 2);
});


/* A child that dies before it reads the key raises EPIPE on ITS STDIN, and `child.on('error')`
   does not cover a stream of the child rather than the child itself. With no listener node
   re-raises it from nextTick as an uncaught exception, so a mandate that could not start took
   the whole app with it. */
test('an EPIPE writing the key to a dead child is a runner event, not an uncaught exception', async () => {
  const events: RunnerEvent[] = [];
  const forked: FakeChild[] = [];
  const runner = createRunnerHost({
    apiWalletKey: async () => '0x'.padEnd(66, '1') as `0x${string}`,
    baseUrl: 'http://127.0.0.1:1',
    user: '0x0000000000000000000000000000000000000001',
    killSwitch: () => false,
    pollMs: 100_000,
    onEvent: (e) => events.push(e),
    forkImpl: (() => {
      const child = new FakeChild();
      forked.push(child);
      return child as unknown as ChildProcess;
    }) as never,
  });

  await runner.arm(mandate('m1'), PROGRAM);
  assert.equal(forked.length, 1);

  // The listener the host attaches is the whole of the fix: without one this throws.
  forked[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

  assert.ok(
    events.some((e) => e.type === 'error' && e.message.includes('never read its key')),
    'the mandate hears about it, and the process keeps running',
  );
});
