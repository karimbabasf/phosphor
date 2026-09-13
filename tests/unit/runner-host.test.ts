// The host: registry, watcher, fills watch and the boot reconcile, driven with a stand-in child.
//
// The child is a stand-in through the fork seam because the properties under test sit between
// the app and the child: what is sent, when, and what the registry says afterwards. The child
// itself is proven against a fake venue in runner-child.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { createRunnerHost } from '../../src/runner/host.ts';
import type { AccountView, RunnerEvent } from '../../src/runner/host.ts';
import type { FromChild, ToChild } from '../../src/runner/protocol.ts';
import { createSession } from '../../src/keystore/session.ts';
import { createPlanStore } from '../../src/trade/plans.ts';
import type { PlanRow } from '../../src/trade/plans.ts';
import { planHash } from '../../src/trade/plan.ts';
import type { PlanInput } from '../../src/trade/plan.ts';
import type { Bar } from '../../src/trade/watch.ts';

const META = { assetId: 3, szDecimals: 4, maxLeverage: 25 };

/* A child that answers the way the real one does, with the answer a test chooses per command.
   `connected` follows the same rule the real one does. */
class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  killed = false;
  readonly sent: ToChild[] = [];
  stderr = null;
  answers: Partial<Record<ToChild['cmd'], (m: ToChild) => FromChild | null>> = {};
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
    const custom = this.answers[m.cmd];
    const reply = custom !== undefined ? custom(m) : this.defaultReply(m);
    if (reply !== null) setImmediate(() => this.emit('message', reply));
    return true;
  }

  defaultReply(m: ToChild): FromChild | null {
    switch (m.cmd) {
      case 'arm':
        return { ev: 'armed', seq: m.seq, id: m.plan.id };
      case 'fire':
        return { ev: 'placed', seq: m.seq, id: m.id, oids: { entry: 1 }, filledSz: 0, avgPx: null, cloids: { entry: '0xentry' }, gen: 1, venueMs: 7 };
      case 'protect':
        return { ev: 'protected', seq: m.seq, id: m.id, oids: { stop: 2, target: 3 }, sz: 5, cloids: { entry: '0xentry', stop: '0xstop', target: '0xtarget' }, gen: 2, venueMs: 8 };
      case 'modify':
        return { ev: 'modified', seq: m.seq, id: m.id, stop: m.stop ?? 90, target: m.target ?? null, cloids: { stop: '0xstop2' }, gen: m.gen + 1, venueMs: 9 };
      case 'cancel':
        return { ev: 'cancelled', seq: m.seq, id: m.id, filledSz: 0, cloids: {}, gen: 1, venueMs: 10 };
      case 'close':
        return { ev: 'closed', seq: m.seq, id: m.id, stillOpenSz: 0, venueMs: 11 };
      case 'flatten':
        return { ev: 'flat', seq: m.seq, stillOpen: [], detail: 'flat' };
      case 'release':
        return { ev: 'released', seq: m.seq, id: m.id };
      default:
        return null;
    }
  }

  kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }

  of(cmd: ToChild['cmd']): ToChild[] {
    return this.sent.filter((m) => m.cmd === cmd);
  }
}

// The agent-facing half of a row: what trade_plan sends, before the host mints an id.
function planInputOf(r: PlanRow): PlanInput {
  const { symbol, side, sizeUsd, leverage, entry, stop, target, when, expiresAt, note } = r;
  return { symbol, side, sizeUsd, leverage, entry, stop, ...(target !== undefined ? { target } : {}), ...(when !== undefined ? { when } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), ...(note !== undefined ? { note } : {}) };
}

function row(over: Partial<PlanRow> = {}): PlanRow {
  const base: PlanRow = {
    id: 'pl_1',
    symbol: 'ETH',
    side: 'long',
    sizeUsd: 1000,
    leverage: 5,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    target: 120,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'waiting',
    hash: '',
    cloids: {},
    gen: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  base.hash = planHash({ id: base.id, symbol: base.symbol, side: base.side, sizeUsd: base.sizeUsd, leverage: base.leverage, entry: base.entry, stop: base.stop, target: base.target, expiresAt: base.expiresAt, ...(base.when ? { when: base.when } : {}) });
  return base;
}

function bars(n: number, startT: number, tfSec: number, last: Partial<Bar> = {}): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i += 1) out.push({ t: startT + i * tfSec, o: 100, h: 101, l: 99, c: 100, v: 100 });
  Object.assign(out[out.length - 1] as Bar, last);
  return out;
}

function account(over: Partial<AccountView> = {}): AccountView {
  return { atMs: Date.now(), freeUsd: 1000, positions: [], orders: [], fills: [], ...over };
}

type Harness = {
  runner: ReturnType<typeof createRunnerHost>;
  forked: FakeChild[];
  events: RunnerEvent[];
  session: ReturnType<typeof createSession>;
  dir: string;
  clock: { now: number };
  approvals: Map<string, { hash: string; status: string }>;
  agentOk: { value: boolean };
};

function fresh(h: Harness): void {
  h.runner.onAccount(account({ atMs: h.clock.now }));
}

function harness(over: { key?: `0x${string}` | null; keyDelayMs?: number; bars?: (coin: string, tf: string, count: number) => Promise<Bar[]>; mark?: number | null; killSwitch?: boolean; dir?: string } = {}): Harness {
  const dir = over.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-runner-host-'));
  const forked: FakeChild[] = [];
  const events: RunnerEvent[] = [];
  const clock = { now: Date.now() };
  const approvals = new Map<string, { hash: string; status: string }>();
  const agentOk = { value: true };
  const session = createSession({ now: () => clock.now, isUnlocked: () => true, lock: () => {} });
  const runner = createRunnerHost({
    apiWalletKey: async () => {
      if (over.keyDelayMs !== undefined) await new Promise((r) => setTimeout(r, over.keyDelayMs));
      return over.key === undefined ? ('0x'.padEnd(66, '1') as `0x${string}`) : over.key;
    },
    session,
    baseUrl: 'http://127.0.0.1:1',
    user: '0x0000000000000000000000000000000000000001',
    killSwitch: () => over.killSwitch === true,
    onEvent: (e) => events.push(e),
    store: createPlanStore(dir),
    meta: () => META,
    mark: () => (over.mark === undefined ? 100 : over.mark),
    free: () => 1000,
    bars: over.bars === undefined ? undefined : (coin, tf, count) => over.bars!(coin, tf, count),
    approval: (id) => approvals.get(id) ?? null,
    agentApproved: async () => agentOk.value,
    now: () => clock.now,
    replyMs: 500,
    forkImpl: (() => {
      const child = new FakeChild();
      forked.push(child);
      return child as unknown as ChildProcess;
    }) as never,
  });
  return { runner, forked, events, session, dir, clock, approvals, agentOk };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

test('arming sends the plan with its meta, opens a session, persists waiting, and a plan with no conditions fires on the first mark', async () => {
  const h = harness();
  fresh(h);
  const out = await h.runner.arm(row());
  assert.equal(out.ok, true, out.ok ? '' : out.reason);
  const child = h.forked[0];
  const armed = child.of('arm')[0];
  assert.equal(armed?.cmd, 'arm');
  if (armed?.cmd === 'arm') {
    assert.equal(armed.plan.id, 'pl_1');
    assert.deepEqual(armed.meta, META);
  }
  assert.notEqual(h.session.sessionFor('pl_1'), null, 'a signing session is open for the plan');
  await settle();
  // No conditions and a mark: fired at once, and the child's answer moved it to placed.
  assert.equal(child.of('fire').length, 1);
  const fire = child.of('fire')[0];
  assert.equal(fire?.cmd === 'fire' ? fire.mark : 0, 100);
  assert.equal(h.runner.get('pl_1')?.status, 'placed');
  assert.deepEqual(h.runner.get('pl_1')?.cloids, { entry: '0xentry' });
  const onDisk = createPlanStore(h.dir).get('pl_1');
  assert.equal(onDisk?.status, 'placed');
  assert.ok(h.events.some((e) => e.type === 'armed'));
  assert.ok(h.events.some((e) => e.type === 'placed'));
});

test('a market entry that filled whole is open at once, protected by its bracket', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row());
  const child = h.forked[0];
  child.answers.fire = (m) => (m.cmd === 'fire' ? { ev: 'placed', seq: m.seq, id: m.id, oids: { entry: 1, stop: 2, target: 3 }, filledSz: 9.9, avgPx: 100.2, cloids: { entry: 'a', stop: 'b', target: 'c' }, gen: 1, venueMs: 12 } : null);
  // The arm already fired with the default answer; arm a second plan for this one.
  await h.runner.arm(row({ id: 'pl_2' }));
  await settle();
  const r = h.runner.get('pl_2');
  assert.equal(r?.status, 'open');
  assert.equal(r?.fillPx, 100.2);
  assert.equal(r?.exitSz, 9.9);
});

test('a plan waits for its bar close, seeded from history and rolled forward by minute frames', async () => {
  const tf = 900;
  // On the 15m grid: buckets are folded from the epoch, so a start off the grid is a test of
  // the wrong thing.
  const start = 1_080_000;
  const h = harness({
    bars: async () => bars(30, start, tf),
    mark: 100,
  });
  h.clock.now = (start + 30 * tf) * 1000 + 5_000;
  const plan = row({ when: [{ type: 'close', tf: '15m', is: 'above', at: { px: 100.5 } }] });
  await h.runner.arm(plan);
  await settle();
  const child = h.forked[0];
  assert.equal(child.of('fire').length, 0, 'the seed closes at 100, under the level');
  assert.equal(h.runner.get('pl_1')?.status, 'waiting');
  assert.equal(h.runner.get('pl_1')?.holds?.[0]?.holds, false);

  // The forming 15m bucket: minutes that close above the level, then the first minute of the
  // NEXT bucket, which is what closes it.
  const bucket = start + 30 * tf;
  for (let i = 0; i < 15; i += 1) {
    h.clock.now += 60_000;
    h.runner.onMarket('ETH', { t: bucket + i * 60, o: 100, h: 102, l: 100, c: 101, v: 5 });
  }
  await settle();
  assert.equal(child.of('fire').length, 0, 'the bucket is still forming');
  h.runner.onMarket('ETH', { t: bucket + tf, o: 101, h: 101, l: 101, c: 101, v: 1 });
  await settle();
  assert.equal(child.of('fire').length, 1, 'the close of the bucket is what fires');
  assert.equal(h.runner.get('pl_1')?.status, 'placed');
});

test('a stale feed makes a waiting plan blind and nothing fires', async () => {
  const h = harness();
  const plan = row({ when: [{ type: 'time' }] });
  await h.runner.arm(plan);
  await settle();
  // No frame has been seen at all: blind, and the fire has not happened.
  assert.equal(h.runner.get('pl_1')?.blind, true);
  assert.equal(h.forked[0].of('fire').length, 0);
  h.runner.onMarket('ETH', { t: 60, o: 1, h: 1, l: 1, c: 1, v: 1 });
  await settle();
  assert.equal(h.forked[0].of('fire').length, 1);
});

test('the coin set the feeds watch is every live plan coin', async () => {
  const h = harness();
  await h.runner.arm(row({ id: 'pl_1', symbol: 'ETH' }));
  await h.runner.arm(row({ id: 'pl_2', symbol: 'BTC', when: [{ type: 'time' }] }));
  assert.deepEqual(h.runner.status().watching.sort(), ['BTC', 'ETH']);
  assert.equal(h.runner.status().child, 'on');
});

test('the first fill of a resting entry sends protect, and the plan is open once the exits rest', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row({ entry: { type: 'limit', px: 95 } }));
  await settle();
  const child = h.forked[0];
  assert.equal(h.runner.get('pl_1')?.status, 'placed');
  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 5, entryPx: 95 }] }));
  await settle();
  assert.equal(child.of('protect').length, 1);
  const r = h.runner.get('pl_1');
  assert.equal(r?.status, 'open');
  assert.equal(r?.exitSz, 5);
  assert.equal(r?.cloids.stop, '0xstop');
  assert.equal(r?.fillPx, 95);
  // The position grows past the exits: protect again.
  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 8, entryPx: 95 }] }));
  await settle();
  assert.equal(child.of('protect').length, 2);
});

test('an open plan whose position is gone is done, with the reason read off the fills', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row());
  h.forked[0].answers.fire = (m) => (m.cmd === 'fire' ? { ev: 'placed', seq: m.seq, id: m.id, oids: {}, filledSz: 10, avgPx: 100, cloids: { entry: 'a', stop: 'b', target: 'c' }, gen: 1, venueMs: 12 } : null);
  await h.runner.arm(row({ id: 'pl_2' }));
  await settle();
  assert.equal(h.runner.get('pl_2')?.status, 'open');
  h.runner.onAccount(account({ positions: [], fills: [{ coin: 'ETH', px: 90.2, sizeCoin: 10, atMs: Date.now(), closedPnlUsd: -98 }] }));
  await settle();
  assert.equal(h.runner.get('pl_2')?.status, 'done');
  assert.equal(h.runner.get('pl_2')?.endReason, 'stopped');
  assert.ok(h.forked[0].of('release').some((m) => m.cmd === 'release' && m.id === 'pl_2'), 'leftover exits are released');
  assert.ok(h.events.some((e) => e.type === 'done' && e.id === 'pl_2' && e.reason === 'stopped'));
});

test('cancel is refused on an open plan, cancels a placed one through the child, and finishes a waiting one at once', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row({ id: 'pl_w', when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }] }));
  await h.runner.arm(row({ id: 'pl_p', entry: { type: 'limit', px: 95 } }));
  h.forked[0].answers.fire = (m) => (m.cmd === 'fire' ? { ev: 'placed', seq: m.seq, id: m.id, oids: {}, filledSz: 10, avgPx: 100, cloids: { entry: 'a', stop: 'b' }, gen: 1, venueMs: 12 } : null);
  await h.runner.arm(row({ id: 'pl_o' }));
  await settle();
  assert.equal(h.runner.get('pl_w')?.status, 'waiting');
  assert.equal(h.runner.get('pl_p')?.status, 'placed');
  assert.equal(h.runner.get('pl_o')?.status, 'open');

  const open = await h.runner.cancel('pl_o');
  assert.equal(open.ok, false);
  assert.match(open.detail, /open/);

  const placed = await h.runner.cancel('pl_p');
  assert.equal(placed.ok, true, placed.detail);
  assert.equal(h.runner.get('pl_p')?.status, 'done');
  assert.equal(h.runner.get('pl_p')?.endReason, 'cancelled');
  assert.ok(h.forked[0].of('cancel').some((m) => m.cmd === 'cancel' && m.id === 'pl_p'));

  const waiting = await h.runner.cancel('pl_w');
  assert.equal(waiting.ok, true);
  assert.equal(h.runner.get('pl_w')?.endReason, 'cancelled');
});

test('a change goes through the child with the mark, and the row takes the new levels and hash', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row());
  await settle();
  const before = h.runner.get('pl_1')?.hash;
  const out = await h.runner.change('pl_1', { stop: 92 });
  assert.equal(out.ok, true, out.detail);
  const sent = h.forked[0].of('modify')[0];
  assert.equal(sent?.cmd === 'modify' ? sent.stop : 0, 92);
  assert.equal(sent?.cmd === 'modify' ? sent.mark : 0, 100);
  const r = h.runner.get('pl_1');
  assert.equal(r?.stop, 92);
  assert.notEqual(r?.hash, before);
  assert.equal(r?.gen, 2);
});

test('close goes through the child at the given bound and finishes the plan', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row());
  h.forked[0].answers.fire = (m) => (m.cmd === 'fire' ? { ev: 'placed', seq: m.seq, id: m.id, oids: {}, filledSz: 10, avgPx: 100, cloids: { entry: 'a' }, gen: 1, venueMs: 12 } : null);
  await h.runner.arm(row({ id: 'pl_2' }));
  await settle();
  const out = await h.runner.close('pl_2', 30);
  assert.equal(out.ok, true, out.detail);
  const sent = h.forked[0].of('close')[0];
  assert.equal(sent?.cmd === 'close' ? sent.maxSlippageBps : 0, 30);
  assert.equal(h.runner.get('pl_2')?.endReason, 'closed');
  const notOpen = await h.runner.close('pl_1', 30);
  assert.equal(notOpen.ok, false, 'a placed plan has nothing to close');
});

test('every host event that came from a child reply carries the venue round trip, and one that never asked the venue does not', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row({ id: 'pl_p', entry: { type: 'limit', px: 95 } }));
  h.forked[0].answers.fire = (m) => (m.cmd === 'fire' ? { ev: 'placed', seq: m.seq, id: m.id, oids: {}, filledSz: 10, avgPx: 100, cloids: { entry: 'a', stop: 'b' }, gen: 1, venueMs: 12 } : null);
  await h.runner.arm(row({ id: 'pl_o' }));
  await h.runner.arm(row({ id: 'pl_w', when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }] }));
  await settle();
  const of = (type: RunnerEvent['type'], id: string): RunnerEvent | undefined => h.events.find((e) => e.type === type && 'id' in e && e.id === id);
  assert.deepEqual(of('placed', 'pl_p'), { type: 'placed', id: 'pl_p', symbol: 'ETH', filledSz: 0, venueMs: 7 });
  assert.equal((of('placed', 'pl_o') as { venueMs?: number } | undefined)?.venueMs, 12, 'the child answer is the source, not a constant');

  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 5, entryPx: 95 }] }));
  await settle();
  assert.deepEqual(of('protected', 'pl_p'), { type: 'protected', id: 'pl_p', symbol: 'ETH', sz: 5, venueMs: 8 });

  await h.runner.change('pl_p', { stop: 92 });
  assert.equal((of('changed', 'pl_p') as { venueMs?: number } | undefined)?.venueMs, 9);

  await h.runner.close('pl_o', 30);
  assert.deepEqual(of('done', 'pl_o'), { type: 'done', id: 'pl_o', symbol: 'ETH', reason: 'closed', venueMs: 11 });

  await h.runner.cancel('pl_w');
  assert.deepEqual(of('done', 'pl_w'), { type: 'done', id: 'pl_w', symbol: 'ETH', reason: 'cancelled' }, 'a waiting plan is cancelled without the venue, so there is no round trip to report');
});

test('the API wallet is checked once per child before the first fire, and a revoked one fails the plan', async () => {
  const h = harness();
  fresh(h);
  h.agentOk.value = false;
  await h.runner.arm(row());
  await settle();
  assert.equal(h.forked[0].of('fire').length, 0);
  assert.equal(h.runner.get('pl_1')?.status, 'done');
  assert.match(String(h.runner.get('pl_1')?.endReason), /no longer approved/);
});

test('a venue refusal on fire finishes the plan as failed with the venue words', async () => {
  const h = harness();
  fresh(h);
  // Held back by a time window, so the refusal can be installed on the child before it fires.
  await h.runner.arm(row({ id: 'pl_x', when: [{ type: 'time', after: new Date(h.clock.now + 5_000).toISOString() }] }));
  h.forked[0].answers.fire = (m) => (m.cmd === 'fire' ? { ev: 'refused', seq: m.seq, id: m.id, reason: 'Insufficient margin to place order.' } : null);
  h.clock.now += 6_000;
  h.runner.onMarket('ETH', { t: 60, o: 1, h: 1, l: 1, c: 1, v: 1 });
  await settle();
  assert.equal(h.runner.get('pl_x')?.status, 'done');
  assert.equal(h.runner.get('pl_x')?.endReason, 'failed:Insufficient margin to place order.');
});

test('the expiry sweep finishes a waiting plan and cancels a placed one', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row({ id: 'pl_w', when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }], expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  await h.runner.arm(row({ id: 'pl_p', entry: { type: 'limit', px: 95 }, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  await settle();
  h.clock.now += 61_000;
  h.runner.sweep();
  await settle();
  assert.equal(h.runner.get('pl_w')?.endReason, 'expired');
  assert.equal(h.runner.get('pl_p')?.endReason, 'expired');
  assert.ok(h.forked[0].of('cancel').some((m) => m.cmd === 'cancel' && m.id === 'pl_p'));
});

test('the kill switch refuses an arm before a child exists', async () => {
  const h = harness({ killSwitch: true });
  const out = await h.runner.arm(row());
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.reason, /kill switch/);
  assert.equal(h.forked.length, 0);
  assert.equal(h.runner.get('pl_1')?.status, 'done');
});

test('no venue metadata for the coin refuses the arm rather than arming a plan that cannot size', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-runner-host-'));
  const runner = createRunnerHost({
    apiWalletKey: async () => '0x'.padEnd(66, '1') as `0x${string}`,
    baseUrl: 'http://127.0.0.1:1',
    user: '0x1',
    killSwitch: () => false,
    onEvent: () => {},
    store: createPlanStore(dir),
    meta: () => null,
    mark: () => 100,
    free: () => null,
    forkImpl: (() => new FakeChild() as unknown as ChildProcess) as never,
  });
  const out = await runner.arm(row());
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.reason, /metadata/);
});

// ---------- boot ----------

test('reconcile re-arms a waiting plan whose proposal executed with the same hash, and fails one that does not match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-runner-host-'));
  const store = createPlanStore(dir);
  const good = row({ id: 'pl_good', proposalId: 'p1', when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }] });
  const bad = row({ id: 'pl_bad', proposalId: 'p2', when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }] });
  const orphan = row({ id: 'pl_orphan', when: [{ type: 'time' }] });
  store.put(good);
  store.put(bad);
  store.put(orphan);
  const h = harness({ dir });
  h.approvals.set('p1', { hash: good.hash, status: 'executed' });
  h.approvals.set('p2', { hash: 'someone edited the file', status: 'executed' });
  h.runner.onAccount(account());
  await h.runner.reconcile(100);
  await settle();
  assert.equal(h.runner.get('pl_good')?.status, 'waiting');
  assert.equal(h.forked[0].of('arm').length, 1);
  assert.equal(h.runner.get('pl_bad')?.endReason, 'failed:plan on disk does not match its approval');
  assert.equal(h.runner.get('pl_orphan')?.endReason, 'failed:plan on disk does not match its approval');
});

test('reconcile reads placed and open rows against the venue by cloid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-runner-host-'));
  const store = createPlanStore(dir);
  store.put(row({ id: 'pl_resting', status: 'placed', cloids: { entry: '0xrest' }, gen: 1 }));
  store.put(row({ id: 'pl_gone', status: 'placed', cloids: { entry: '0xgone' }, gen: 1 }));
  store.put(row({ id: 'pl_filled', status: 'placed', symbol: 'BTC', cloids: { entry: '0xfilled' }, gen: 1 }));
  store.put(row({ id: 'pl_open', status: 'open', symbol: 'SOL', cloids: { entry: 'a', stop: '0xstop' }, gen: 2, exitSz: 5 }));
  store.put(row({ id: 'pl_done', status: 'open', symbol: 'DOGE', cloids: { entry: 'a', stop: 's' }, gen: 2, exitSz: 5, target: 120 }));
  const h = harness({ dir });
  h.runner.onAccount(
    account({
      positions: [
        { coin: 'BTC', szi: 2, entryPx: 95 },
        { coin: 'SOL', szi: 5, entryPx: 95 },
      ],
      orders: [
        { coin: 'ETH', cloid: '0xrest' },
        { coin: 'SOL', cloid: '0xstop' },
      ],
      fills: [{ coin: 'DOGE', px: 119.9, sizeCoin: 5, atMs: Date.now(), closedPnlUsd: 100 }],
    }),
  );
  await h.runner.reconcile(100);
  await settle();
  assert.equal(h.runner.get('pl_resting')?.status, 'placed', 'its entry still rests');
  assert.equal(h.runner.get('pl_gone')?.endReason, 'cancelled', 'no order and no position');
  assert.equal(h.runner.get('pl_filled')?.status, 'open', 'a position appeared while the app was down');
  assert.ok(h.forked[0].of('protect').some((m) => m.cmd === 'protect' && m.id === 'pl_filled'));
  assert.equal(h.runner.get('pl_open')?.status, 'open');
  assert.equal(h.runner.get('pl_done')?.endReason, 'targeted');
});

// ---------- the key's route to the child ----------

test('the key goes over stdin and is nowhere in the environment', () => {
  const host = fs.readFileSync(new URL('../../src/runner/host.ts', import.meta.url), 'utf8');
  const child = fs.readFileSync(new URL('../../src/runner/main.ts', import.meta.url), 'utf8');
  assert.ok(!/PHOSPHOR_HL_KEY/.test(host));
  assert.ok(!/PHOSPHOR_HL_KEY/.test(child));
  assert.match(host, /\.stdin\?\.write/);
  assert.match(host, /\.stdin\?\.end\(\)/);
  assert.match(child, /process\.stdin\.on\('data'/);
  assert.match(host, /stdio: \['pipe', 'pipe', 'pipe', 'ipc'\]/);
  assert.match(host, /fork\)?\(entry, \[\], \{/);
  assert.doesNotMatch(host, /fork\)?\(entry, \[[^\]]/, 'nothing was put into argv');
  assert.doesNotMatch(host, /TRADING_LIMITS|maxArmedMandates|maxAggregateNotionalUsd/, 'the policy is the only wall');
});

test('an idea past its own expiry leaves the chart on the next sweep, and a live idea stays', async () => {
  /* propose_trade refuses to arm an expired idea by the same clock, so a row nobody can arm has
     no reason to sit on the chart as a suggestion. */
  const h = harness();
  const stale = h.runner.draw({ ...planInputOf(row()), expiresAt: new Date(h.clock.now + 30_000).toISOString() }, 'agent-1');
  const fresh = h.runner.draw({ ...planInputOf(row()), expiresAt: new Date(h.clock.now + 86_400_000).toISOString() }, 'agent-1');
  assert.equal(h.runner.get(stale.id)?.status, 'idea');
  h.clock.now += 31_000;
  h.runner.sweep();
  assert.equal(h.runner.get(stale.id), null, 'the expired idea is gone');
  assert.equal(h.runner.get(fresh.id)?.status, 'idea', 'the live idea stays');
  assert.equal(h.runner.plans().filter((p) => p.status === 'idea').length, 1);
});
