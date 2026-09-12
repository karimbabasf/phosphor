// The one exception to the auto-lock, and its two ends: the expiry a human set when they armed
// a plan, and the key that reaches the runner over a pipe rather than an environment.
//
// Why an exception exists at all. A plan armed at 6pm has to still be waiting at 2am, and perps
// run at 2am. Refusing to arm while locked, or dropping the key at the lock, would make a plan
// useless overnight and the owner would answer by turning auto-lock off, which costs them the
// master key's protection to save the trading key's. So the runner keeps ONE key, the Hyperliquid
// API wallet, which the venue itself forbids from withdrawing, transferring or approving another
// agent. What survives a lock is trading authority, not custody.
//
// A session ends after a day at most. A waiting plan then locks and re-arms on the next unlock;
// a placed plan keeps the key, because a fill on its resting entry needs it to be protected and
// dropping the key there is the naked position the whole design exists to prevent; an open plan
// needs no key, because the venue holds its exits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { createRunnerHost } from '../../src/runner/host.ts';
import { SIGNING_SESSION_MAX_MS, createSession } from '../../src/keystore/session.ts';
import type { RunnerEvent } from '../../src/runner/host.ts';
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
    const m = msg as ToChild;
    this.sent.push(m);
    let reply: FromChild | null = null;
    if (m.cmd === 'arm') reply = { ev: 'armed', seq: m.seq, id: m.plan.id };
    if (m.cmd === 'fire') reply = { ev: 'placed', seq: m.seq, id: m.id, oids: { entry: 1 }, filledSz: 0, avgPx: null, cloids: { entry: '0xentry' }, gen: 1, venueMs: 0 };
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

function plan(id: string, expiresInMs: number, over: Partial<PlanRow> = {}): PlanRow {
  return {
    id,
    symbol: 'SOL',
    side: 'long',
    sizeUsd: 100,
    leverage: 2,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    when: [{ type: 'time', after: '2999-01-01T00:00:00.000Z' }],
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    status: 'waiting',
    hash: `hash-${id}`,
    cloids: {},
    gen: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function host(now: () => number, key: `0x${string}` | null = `0x${'11'.repeat(32)}`) {
  const events: RunnerEvent[] = [];
  const forked: FakeChild[] = [];
  const session = createSession({ now, isUnlocked: () => true, lock: () => {} });
  const runner = createRunnerHost({
    apiWalletKey: async () => key,
    baseUrl: 'https://api.hyperliquid.xyz',
    user: '0x2222222222222222222222222222222222222222',
    killSwitch: () => false,
    onEvent: (e) => events.push(e),
    session,
    store: createPlanStore(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-signing-'))),
    meta: () => ({ assetId: 1, szDecimals: 4, maxLeverage: 25 }),
    mark: () => 100,
    free: () => 1000,
    now,
    replyMs: 200,
    forkImpl: (() => {
      const child = new FakeChild();
      forked.push(child);
      return child as unknown as ChildProcess;
    }) as never,
  });
  return { runner, session, events, forked };
}

test('the signing session is opened at arm and its length comes from the plan', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now);
  const out = await h.runner.arm(plan('m1', 3 * 60 * 60_000));
  assert.equal(out.ok, true, out.ok ? '' : out.reason);
  const opened = h.session.sessionFor('m1');
  assert.ok(opened !== null);
  assert.ok(Math.abs(opened.expiresAt - opened.armedAt - 3 * 60 * 60_000) < 1000, 'a three hour plan gets a three hour session');
});

test('a plan that outlives a day still only holds the key for a day', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now);
  await h.runner.arm(plan('m1', 5 * 24 * 60 * 60_000));
  const opened = h.session.sessionFor('m1');
  assert.ok(opened !== null);
  assert.equal(opened.expiresAt - opened.armedAt, SIGNING_SESSION_MAX_MS);
});

test('cancelling a waiting plan takes the session back, so no key is held for a plan that is gone', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now);
  await h.runner.arm(plan('m1', 60 * 60_000));
  assert.notEqual(h.session.sessionFor('m1'), null);

  await h.runner.cancel('m1');
  assert.equal(h.session.sessionFor('m1'), null);
  assert.ok(h.events.some((e) => e.type === 'done' && e.id === 'm1' && e.reason === 'cancelled'));
});

test('an expired session locks a waiting plan, which stays waiting and says so', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now);
  await h.runner.arm(plan('m1', 60_000));
  await h.runner.arm(plan('m2', 10 * 60_000));

  clock.now += 61_000;
  const taken = h.runner.sweepSigningSessions();
  assert.deepEqual(taken, ['m1']);

  assert.equal(h.runner.get('m1')?.status, 'waiting');
  assert.equal(h.runner.get('m1')?.locked, true);
  assert.ok(h.events.some((e) => e.type === 'locked' && e.id === 'm1'));
  assert.ok(h.forked[0].sent.some((m) => m.cmd === 'disarm' && m.id === 'm1'), 'the child lets it go');
  assert.notEqual(h.session.sessionFor('m2'), null, 'the other plan keeps its key');
  assert.equal(h.runner.get('m2')?.locked, undefined);
});

test('a placed plan renews its session rather than losing the key a fill would need', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now);
  // Fresh feed and no conditions: the plan fires at once and the stand-in child rests it.
  h.runner.onAccount({ atMs: clock.now, freeUsd: 1000, positions: [], orders: [], fills: [] });
  await h.runner.arm(plan('m1', 60_000, { when: undefined, entry: { type: 'limit', px: 95 } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.runner.get('m1')?.status, 'placed');
  clock.now += 61_000;
  const taken = h.runner.sweepSigningSessions();
  assert.deepEqual(taken, [], 'a placed plan is not taken');
  assert.notEqual(h.session.sessionFor('m1'), null, 'and holds a fresh session');
  assert.equal(h.runner.get('m1')?.locked, undefined);
});

test('the sweep is a no-op when nothing has expired, and reports each expiry once', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now);
  await h.runner.arm(plan('m1', 60_000));
  assert.deepEqual(h.runner.sweepSigningSessions(), []);
  clock.now += 61_000;
  assert.deepEqual(h.runner.sweepSigningSessions(), ['m1']);
  assert.deepEqual(h.runner.sweepSigningSessions(), [], 'a session is taken back once');
});

test('the child goes once the last plan that needs a key has locked', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now);
  await h.runner.arm(plan('m1', 60_000));
  assert.equal(h.runner.status().child, 'on');
  clock.now += 61_000;
  h.runner.sweepSigningSessions();
  assert.equal(h.runner.status().child, 'off', 'a dead process is the only reliable way to be rid of a key');
});

test('stopping everything takes every signing session with it', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now);
  await h.runner.arm(plan('m1', 60 * 60_000));
  await h.runner.arm(plan('m2', 60 * 60_000));
  await h.runner.stopAll('kill switch');
  assert.deepEqual(h.session.armed(), [], 'freeze everything means no key is held anywhere');
});

test('a plan refused before it arms opens no session', async () => {
  const clock = { now: Date.now() };
  const h = host(() => clock.now, null);
  const out = await h.runner.arm(plan('m1', 60_000));
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.reason, /no API wallet key/);
  assert.deepEqual(h.session.armed(), []);
});

// ---------- the key's route to the child ----------

test('the key goes over stdin and is nowhere in the environment', () => {
  const ROOT = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
  const hostSrc = fs.readFileSync(path.join(ROOT, 'src', 'runner', 'host.ts'), 'utf8');
  const child = fs.readFileSync(path.join(ROOT, 'src', 'runner', 'main.ts'), 'utf8');

  assert.ok(!/PHOSPHOR_HL_KEY/.test(hostSrc), 'the host must not put the key in the child environment');
  assert.ok(!/PHOSPHOR_HL_KEY/.test(child), 'the child must not read a key from its environment');
  assert.match(hostSrc, /\.stdin\?\.write/, 'the host writes the key to the pipe');
  assert.match(hostSrc, /\.stdin\?\.end\(\)/, 'and closes it behind the key');
  assert.match(child, /process\.stdin\.on\('data'/, 'the child reads it from the pipe');
  assert.match(hostSrc, /stdio: \['pipe', 'pipe', 'pipe', 'ipc'\]/);
});

test('the key never reaches an argument list either', () => {
  const ROOT = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
  const hostSrc = fs.readFileSync(path.join(ROOT, 'src', 'runner', 'host.ts'), 'utf8');
  assert.match(hostSrc, /fork\)?\(entry, \[\], \{/);
  assert.doesNotMatch(hostSrc, /fork\)?\(entry, \[[^\]]/, 'nothing was put into argv');
});
