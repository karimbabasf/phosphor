// The one exception to the auto-lock, and its two ends: the expiry a human sets when they arm
// a rule, and the key that reaches the runner over a pipe rather than an environment.
//
// Why an exception exists at all. A rule armed at 6pm has to still be trading at 2am, and
// perps run at 2am. Refusing to arm while locked, or dropping the key at the lock, would make
// a bot useless overnight and the owner would answer by turning auto-lock off, which costs
// them the master key's protection to save the trading key's. So the bot keeps ONE key, the
// Hyperliquid API wallet, which the venue itself forbids from withdrawing, transferring or
// approving another agent. What survives a lock is trading authority, not custody.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunnerHost } from '../../src/runner/host.ts';
import { SIGNING_SESSION_MAX_MS, createSession } from '../../src/keystore/session.ts';
import type { RunnerEvent } from '../../src/runner/host.ts';
import type { Mandate } from '../../src/strategy/envelope.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function mandate(id: string, expiresInMs: number): Mandate {
  return {
    id,
    programHash: `hash-${id}`,
    symbol: 'SOL',
    maxNotionalUsd: 10,
    maxLeverage: 2,
    maxOrdersPerMin: 2,
    maxLossUsd: 5,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    allowedActions: ['open', 'close'],
  } as Mandate;
}

// A host with a real signing session and a key, but nothing that can spawn: the child is only
// reached through ensureChild, and every assertion here is about the session and the bookkeeping
// around it. The one test that needs a process is the stdin test at the bottom, which reads the
// source rather than launching a venue client.
function host(now: () => number, key: `0x${string}` | null = `0x${'11'.repeat(32)}`) {
  const events: RunnerEvent[] = [];
  const session = createSession({ now, isUnlocked: () => true, lock: () => {} });
  const runner = createRunnerHost({
    apiWalletKey: async () => key,
    baseUrl: 'https://api.hyperliquid.xyz',
    user: '0x2222222222222222222222222222222222222222',
    killSwitch: () => false,
    onEvent: (e) => events.push(e),
    session,
    limits: { maxArmedMandates: 3, maxAggregateNotionalUsd: 1000 },
  });
  return { runner, session, events };
}

test('the signing session is opened at arm and its length comes from the mandate', () => {
  let clock = 1_700_000_000_000;
  const h = host(() => clock);
  const opened = h.session.arm('m1', 3 * 60 * 60_000);
  assert.equal(opened.expiresAt - opened.armedAt, 3 * 60 * 60_000, 'a three hour mandate gets a three hour session');
});

test('a mandate that outlives a day still only holds the key for a day', () => {
  let clock = 1_700_000_000_000;
  const h = host(() => clock);
  const opened = h.session.arm('m1', 30 * 24 * 60 * 60_000);
  assert.equal(opened.expiresAt - opened.armedAt, SIGNING_SESSION_MAX_MS);
});

test('disarming takes the session back, so no key is held for a bot that is gone', async () => {
  let clock = 1_700_000_000_000;
  const h = host(() => clock);
  h.session.arm('m1');
  assert.notEqual(h.session.sessionFor('m1'), null);

  await h.runner.disarm('m1', 'the human pressed stop');
  assert.equal(h.session.sessionFor('m1'), null);
  assert.ok(h.events.some((e) => e.type === 'disarmed' && e.id === 'm1'));
});

test('an expired session disarms the mandate and says why', async () => {
  let clock = 1_700_000_000_000;
  const h = host(() => clock);
  h.session.arm('m1', 60_000);
  h.session.arm('m2', 10 * 60_000);

  clock += 61_000;
  const taken = h.runner.sweepSigningSessions();
  assert.deepEqual(taken, ['m1']);

  const disarmed = h.events.filter((e) => e.type === 'disarmed');
  assert.equal(disarmed.length, 1);
  assert.match((disarmed[0] as { reason: string }).reason, /signing session expired/);
  assert.notEqual(h.session.sessionFor('m2'), null, 'the other rule keeps its key');
});

test('the sweep is a no-op when nothing has expired, and reports each expiry once', () => {
  let clock = 1_700_000_000_000;
  const h = host(() => clock);
  h.session.arm('m1', 60_000);
  assert.deepEqual(h.runner.sweepSigningSessions(), []);
  clock += 61_000;
  assert.deepEqual(h.runner.sweepSigningSessions(), ['m1']);
  assert.deepEqual(h.runner.sweepSigningSessions(), [], 'a session is taken back once');
});

test('stopping everything takes every signing session with it', async () => {
  let clock = 1_700_000_000_000;
  const h = host(() => clock);
  h.session.arm('m1');
  h.session.arm('m2');
  await h.runner.stopAll('kill switch');
  assert.deepEqual(h.session.armed(), [], 'freeze everything means no key is held anywhere');
});

test('a mandate refused before it arms opens no session', async () => {
  let clock = 1_700_000_000_000;
  const h = host(() => clock);
  // Over the aggregate ceiling, so the refusal happens before a child or a session exists.
  const runner = createRunnerHost({
    apiWalletKey: async () => `0x${'11'.repeat(32)}`,
    baseUrl: 'https://api.hyperliquid.xyz',
    user: '0x2222222222222222222222222222222222222222',
    killSwitch: () => false,
    onEvent: () => {},
    session: h.session,
    limits: { maxArmedMandates: 0, maxAggregateNotionalUsd: 0 },
  });
  const out = await runner.arm(mandate('m1', 60_000), null);
  assert.equal(out.ok, false);
  assert.deepEqual(h.session.armed(), []);
});

// ---------- the key's route to the child ----------

test('the key goes over stdin and is nowhere in the environment', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src', 'runner', 'host.ts'), 'utf8');
  const child = fs.readFileSync(path.join(ROOT, 'src', 'runner', 'main.ts'), 'utf8');

  assert.ok(!/PHOSPHOR_HL_KEY/.test(host), 'the host must not put the key in the child environment');
  assert.ok(!/PHOSPHOR_HL_KEY/.test(child), 'the child must not read a key from its environment');
  assert.match(host, /child\.stdin\?\.write/, 'the host writes the key to the pipe');
  assert.match(host, /child\.stdin\?\.end\(\)/, 'and closes it behind the key');
  assert.match(child, /process\.stdin\.on\('data'/, 'the child reads it from the pipe');
  // The fork has to open a pipe on fd 0 or the write above has nowhere to go.
  assert.match(host, /stdio: \['pipe', 'pipe', 'pipe', 'ipc'\]/);
});

test('the key never reaches an argument list either', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src', 'runner', 'host.ts'), 'utf8');
  // fork's second argument is argv. It is empty and stays empty: argv is world-readable in ps
  // for every process on the machine, not only this user's.
  assert.match(host, /fork\(entry, \[\], \{/);
});
