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
import type { InfoClient } from '../../src/hl/info.ts';

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

type HarnessOptions = {
  key?: `0x${string}` | null;
  keyDelayMs?: number;
  bars?: (coin: string, tf: string, count: number) => Promise<Bar[]>;
  mark?: number | null;
  // Per coin, where a test needs one coin watched and another not.
  markFor?: (coin: string) => number | null;
  metaFor?: (coin: string) => typeof META | null;
  info?: InfoClient;
  // Answers every forked child starts with, for a child the host forks on its own.
  answers?: FakeChild['answers'];
  killSwitch?: boolean;
  dir?: string;
};

function harness(over: HarnessOptions = {}): Harness {
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
    meta: (coin) => (over.metaFor === undefined ? META : over.metaFor(coin)),
    mark: (coin) => (over.markFor !== undefined ? over.markFor(coin) : over.mark === undefined ? 100 : over.mark),
    free: () => 1000,
    ...(over.info !== undefined ? { info: over.info } : {}),
    bars: over.bars === undefined ? undefined : (coin, tf, count) => over.bars!(coin, tf, count),
    approval: (id) => approvals.get(id) ?? null,
    agentApproved: async () => agentOk.value,
    now: () => clock.now,
    replyMs: 500,
    forkImpl: (() => {
      const child = new FakeChild();
      if (over.answers !== undefined) child.answers = { ...over.answers };
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
  await h.runner.arm(row({ id: 'pl_2', symbol: 'BTC' }));
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
  await h.runner.arm(row({ id: 'pl_2', symbol: 'BTC' }));
  await settle();
  assert.equal(h.runner.get('pl_2')?.status, 'open');
  h.runner.onAccount(account({ positions: [], fills: [{ coin: 'BTC', px: 90.2, sizeCoin: 10, atMs: Date.now(), closedPnlUsd: -98 }] }));
  await settle();
  assert.equal(h.runner.get('pl_2')?.status, 'done');
  assert.equal(h.runner.get('pl_2')?.endReason, 'stopped');
  assert.ok(h.forked[0].of('release').some((m) => m.cmd === 'release' && m.id === 'pl_2'), 'leftover exits are released');
  assert.ok(h.events.some((e) => e.type === 'done' && e.id === 'pl_2' && e.reason === 'stopped'));
});

test('a plan that ends names its entry and its exits to the runner, so the rest of a part-filled limit entry comes off the book too', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row({ entry: { type: 'limit', px: 95 } }));
  await settle();
  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 5, entryPx: 95 }], orders: [{ coin: 'ETH', cloid: '0xentry' }] }));
  await settle();
  assert.equal(h.runner.get('pl_1')?.status, 'open');
  // The target filled and the position is gone; the rest of the entry still rests.
  h.runner.onAccount(account({ positions: [], orders: [{ coin: 'ETH', cloid: '0xentry' }], fills: [{ coin: 'ETH', px: 120, sizeCoin: 5, atMs: Date.now(), closedPnlUsd: 120 }] }));
  await settle();
  assert.equal(h.runner.get('pl_1')?.status, 'done');
  const release = h.forked[0].of('release').find((m) => m.cmd === 'release' && m.id === 'pl_1');
  assert.ok(release !== undefined && release.cmd === 'release');
  assert.equal(release.assetId, META.assetId);
  assert.deepEqual([...(release.cloids ?? [])].sort(), ['0xentry', '0xstop', '0xtarget']);
});

test('after a restart with no runner running, an ended plan whose entry still rests starts one to take it off the book, then lets it go', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-runner-host-'));
  const openRow = row({ status: 'open', entry: { type: 'limit', px: 95 }, cloids: { entry: '0xentry', stop: '0xstop', target: '0xtarget' }, gen: 2, exitSz: 5, fillPx: 95 });
  createPlanStore(dir).put(openRow);
  const h = harness({ dir });
  // The position closed while the app was down, and the rest of the entry is still resting.
  h.runner.onAccount(account({ positions: [], orders: [{ coin: 'ETH', cloid: '0xentry' }] }));
  await h.runner.reconcile(10);
  await settle();
  assert.equal(h.runner.get('pl_1')?.status, 'done');
  assert.equal(h.forked.length, 1, 'a runner was started for the cancel alone');
  const release = h.forked[0].of('release')[0];
  assert.ok(release !== undefined && release.cmd === 'release');
  assert.deepEqual([...(release.cloids ?? [])].sort(), ['0xentry', '0xstop', '0xtarget']);
  assert.equal(h.forked[0].killed || h.forked[0].of('kill').length > 0, true, 'and it was let go once nothing needed it');
});

test('a plan that ended with nothing of its own resting starts no runner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-runner-host-'));
  createPlanStore(dir).put(row({ status: 'open', cloids: { entry: '0xentry', stop: '0xstop' }, gen: 1, exitSz: 5, fillPx: 100 }));
  const h = harness({ dir });
  h.runner.onAccount(account({ positions: [], orders: [{ coin: 'ETH', cloid: '0xsomeone-else' }] }));
  await h.runner.reconcile(10);
  await settle();
  assert.equal(h.runner.get('pl_1')?.status, 'done');
  assert.equal(h.forked.length, 0);
});

// ---------- one plan per coin ----------

const LATER = (): string => new Date(Date.now() + 86_400_000).toISOString();

test('one plan per coin: a second plan on a coin with a live one is refused at arm, with a row that says why', async () => {
  const h = harness();
  fresh(h);
  const first = await h.runner.arm(row({ id: 'pl_1', when: [{ type: 'time', after: LATER() }] }));
  assert.equal(first.ok, true);
  const second = await h.runner.arm(row({ id: 'pl_2', side: 'short', stop: 110, target: 90 }));
  assert.equal(second.ok, false);
  assert.match(second.ok ? '' : second.reason, /ETH already has a live plan \(pl_1\)/);
  assert.equal(h.runner.get('pl_2')?.status, 'done');
  assert.match(String(h.runner.get('pl_2')?.endReason), /^failed:ETH already has a live plan/);
  assert.equal(h.forked[0].of('arm').length, 1, 'the second plan never reached the child');
  assert.equal(h.runner.get('pl_1')?.status, 'waiting', 'the first plan is untouched');
});

test('one plan per coin: two arms on one coin at the same moment, only one is taken', async () => {
  const h = harness({ keyDelayMs: 20 });
  fresh(h);
  const [a, b] = await Promise.all([
    h.runner.arm(row({ id: 'pl_a', when: [{ type: 'time', after: LATER() }] })),
    h.runner.arm(row({ id: 'pl_b', when: [{ type: 'time', after: LATER() }] })),
  ]);
  assert.deepEqual([a.ok, b.ok], [true, false]);
  assert.match(b.ok ? '' : b.reason, /being armed right now/);
  assert.equal(h.runner.status().plans.filter((r) => r.status === 'waiting').length, 1);
});

test('a coin with a position that no plan made takes no plan: its stop and target would close all of it', async () => {
  const h = harness();
  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 2, entryPx: 100 }] }));
  const out = await h.runner.arm(row());
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.reason, /ETH already has a position open that no plan here made/);
  assert.equal(h.forked.length, 0, 'no runner was started for it');
  const btc = await h.runner.arm(row({ id: 'pl_btc', symbol: 'BTC', when: [{ type: 'time', after: LATER() }] }));
  assert.equal(btc.ok, true, 'another coin is free');
});

test('a waiting plan that comes due onto a position opened meanwhile does not fire, and says why', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row({ when: [{ type: 'time', after: new Date(h.clock.now + 5_000).toISOString() }] }));
  await settle();
  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 2, entryPx: 100 }] }));
  h.clock.now += 6_000;
  h.runner.onMarket('ETH', { t: 60, o: 100, h: 100, l: 100, c: 100, v: 1 });
  await settle();
  assert.equal(h.forked[0].of('fire').length, 0);
  assert.equal(h.runner.get('pl_1')?.status, 'done');
  assert.match(String(h.runner.get('pl_1')?.endReason), /position open that no plan here made/);
});

// ---------- flatten and the kill switch ----------

const HEALTHY = { ok: true, consecutiveFailures: 0, lastError: null, lastLatencyMs: null, backoffUntilMs: null };

function mids(answer: () => Record<string, string>): InfoClient & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    async post<T>(body: unknown): Promise<T> {
      asked.push(body);
      return answer() as T;
    },
    health: () => HEALTHY,
  };
}

// An open plan as it sits on disk: its fill protected by a stop and a target.
function openOn(id: string, symbol: string): PlanRow {
  return row({ id, symbol, status: 'open', cloids: { entry: `${id}.entry`, stop: `${id}.stop`, target: `${id}.target` }, gen: 2, exitSz: 5, fillPx: 100 });
}

function withRows(...rows: PlanRow[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-runner-host-'));
  const store = createPlanStore(dir);
  for (const r of rows) store.put(r);
  return dir;
}

test('flatten prices a coin the feed does not watch from the venue mids, and closes a position no plan made', async () => {
  const info = mids(() => ({ DOGE: '0.25', ETH: '100' }));
  const h = harness({ info, markFor: (coin) => (coin === 'ETH' ? 100 : null) });
  h.runner.onAccount(account({ positions: [{ coin: 'DOGE', szi: 100, entryPx: 0.24 }] }));
  const out = await h.runner.flatten();
  assert.equal(out.ok, true, out.detail);
  const sent = h.forked[0].of('flatten')[0];
  assert.ok(sent !== undefined && sent.cmd === 'flatten');
  assert.deepEqual(sent.coins, [{ coin: 'DOGE', meta: META, mark: 0.25 }]);
  assert.deepEqual(info.asked, [{ type: 'allMids' }]);
});

test('flatten never says nothing is open while a coin it cannot price is open: that plan stays live and keeps its exits', async () => {
  const info = mids(() => {
    throw new Error('the venue is not answering');
  });
  const h = harness({ dir: withRows(openOn('pl_doge', 'DOGE')), info, markFor: (coin) => (coin === 'ETH' ? 100 : null) });
  h.runner.onAccount(account({ positions: [{ coin: 'DOGE', szi: 5, entryPx: 0.24 }, { coin: 'ETH', szi: 2, entryPx: 100 }] }));
  const out = await h.runner.flatten();
  assert.equal(out.ok, false);
  assert.match(out.detail, /DOGE did NOT close and is STILL OPEN/);
  assert.match(out.detail, /no price/);
  assert.doesNotMatch(out.detail, /nothing (was )?open/);
  assert.equal(info.asked.length, 2, 'the mids were asked for twice before giving up on the price');
  const sent = h.forked[0].of('flatten')[0];
  assert.ok(sent !== undefined && sent.cmd === 'flatten');
  assert.deepEqual(sent.coins.map((c) => c.coin), ['ETH'], 'only what can be priced is closed');
  assert.equal(h.runner.get('pl_doge')?.status, 'open', 'never marked closed');
  assert.equal(h.forked[0].of('release').length, 0, 'its exits stay: they are all that protects it');
});

test('a coin with no venue metadata is reported STILL OPEN, never marked closed', async () => {
  const h = harness({ metaFor: (coin) => (coin === 'ETH' ? META : null) });
  h.runner.onAccount(account({ positions: [{ coin: 'XYZ', szi: 5, entryPx: 1 }] }));
  const out = await h.runner.flatten();
  assert.equal(out.ok, false);
  assert.match(out.detail, /XYZ did NOT close and is STILL OPEN/);
  assert.match(out.detail, /metadata/);
});

test('a coin the venue did not close keeps its plan live with its exits, the rest finish, and only entries are cancelled up front', async () => {
  const h = harness({
    dir: withRows(openOn('pl_eth', 'ETH'), openOn('pl_btc', 'BTC')),
    answers: { flatten: (m) => (m.cmd === 'flatten' ? { ev: 'flat', seq: m.seq, stillOpen: ['ETH'], detail: 'ETH: the venue refused the close' } : null) },
  });
  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 5, entryPx: 100 }, { coin: 'BTC', szi: 5, entryPx: 100 }] }));
  const out = await h.runner.flatten();
  assert.equal(out.ok, false);
  assert.match(out.detail, /ETH did NOT close and is STILL OPEN/);
  const sent = h.forked[0].of('flatten')[0];
  assert.ok(sent !== undefined && sent.cmd === 'flatten');
  assert.deepEqual(sent.cancels.map((c) => c.cloid).sort(), ['pl_btc.entry', 'pl_eth.entry']);
  assert.equal(h.runner.get('pl_eth')?.status, 'open');
  assert.equal(h.runner.get('pl_btc')?.status, 'done');
  assert.equal(h.runner.get('pl_btc')?.endReason, 'closed');
  const released = h.forked[0].of('release').map((m) => (m.cmd === 'release' ? m.id : ''));
  assert.deepEqual(released, ['pl_btc']);
});

test('flatten releases every plan it finished through the one runner it started, then lets it go', async () => {
  const h = harness({ dir: withRows(openOn('pl_btc', 'BTC'), openOn('pl_sol', 'SOL')) });
  h.runner.onAccount(account({
    positions: [{ coin: 'BTC', szi: 5, entryPx: 100 }, { coin: 'SOL', szi: 5, entryPx: 100 }],
    orders: [{ coin: 'BTC', cloid: 'pl_btc.stop' }, { coin: 'SOL', cloid: 'pl_sol.stop' }],
  }));
  const out = await h.runner.flatten();
  assert.equal(out.ok, true, out.detail);
  await settle();
  assert.equal(h.forked.length, 1, 'one runner for the whole flatten');
  const released = h.forked[0].of('release').map((m) => (m.cmd === 'release' ? m.id : '')).sort();
  assert.deepEqual(released, ['pl_btc', 'pl_sol']);
  assert.equal(h.forked[0].of('kill').length, 1, 'and it is let go once the releases are on their way');
});

test('flatten with nothing open and no live plan says so, and starts no runner', async () => {
  const h = harness();
  fresh(h);
  const out = await h.runner.flatten();
  assert.equal(out.ok, true);
  assert.match(out.detail, /nothing was open/);
  assert.equal(h.forked.length, 0);
});

test('the kill switch closes a position no plan made, starting a runner to do it', async () => {
  const h = harness();
  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 2, entryPx: 100 }] }));
  await h.runner.stopAll('kill switch');
  assert.equal(h.forked.length, 1);
  const sent = h.forked[0].of('flatten')[0];
  assert.ok(sent !== undefined && sent.cmd === 'flatten');
  assert.deepEqual(sent.coins.map((c) => c.coin), ['ETH']);
});

test('the kill switch keeps a plan whose coin did not close, with its exits, and says it is still open', async () => {
  const h = harness({
    dir: withRows(openOn('pl_eth', 'ETH')),
    answers: { flatten: (m) => (m.cmd === 'flatten' ? { ev: 'flat', seq: m.seq, stillOpen: ['ETH'], detail: 'ETH: the venue refused the close' } : null) },
  });
  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 5, entryPx: 100 }] }));
  await h.runner.stopAll('kill switch');
  assert.equal(h.runner.get('pl_eth')?.status, 'open');
  assert.equal(h.forked[0].of('release').length, 0);
  assert.ok(h.events.some((e) => e.type === 'error' && /ETH did NOT close and is STILL OPEN/.test(e.message)));
});

test('cancel is refused on an open plan, cancels a placed one through the child, and finishes a waiting one at once', async () => {
  const h = harness();
  fresh(h);
  // One plan per coin, so three coins.
  await h.runner.arm(row({ id: 'pl_w', symbol: 'SOL', when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }] }));
  await h.runner.arm(row({ id: 'pl_p', symbol: 'BTC', entry: { type: 'limit', px: 95 } }));
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
  await h.runner.arm(row({ id: 'pl_2', symbol: 'BTC' }));
  await settle();
  const out = await h.runner.close('pl_2', 30);
  assert.equal(out.ok, true, out.detail);
  const sent = h.forked[0].of('close')[0];
  assert.equal(sent?.cmd === 'close' ? sent.maxSlippageBps : 0, 30);
  assert.equal(sent?.cmd === 'close' ? sent.exitSz : 0, 10, 'the fill the app recorded goes with it, for the runner to hold the venue to');
  assert.equal(h.runner.get('pl_2')?.endReason, 'closed');
  const notOpen = await h.runner.close('pl_1', 30);
  assert.equal(notOpen.ok, false, 'a placed plan has nothing to close');
});

test('every host event that came from a child reply carries the venue round trip, and one that never asked the venue does not', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row({ id: 'pl_p', entry: { type: 'limit', px: 95 } }));
  h.forked[0].answers.fire = (m) => (m.cmd === 'fire' ? { ev: 'placed', seq: m.seq, id: m.id, oids: {}, filledSz: 10, avgPx: 100, cloids: { entry: 'a', stop: 'b' }, gen: 1, venueMs: 12 } : null);
  // One plan per coin, so three coins.
  await h.runner.arm(row({ id: 'pl_o', symbol: 'BTC' }));
  await h.runner.arm(row({ id: 'pl_w', symbol: 'SOL', when: [{ type: 'time', after: new Date(Date.now() + 86_400_000).toISOString() }] }));
  await settle();
  const of = (type: RunnerEvent['type'], id: string): RunnerEvent | undefined => h.events.find((e) => e.type === type && 'id' in e && e.id === id);
  assert.deepEqual(of('placed', 'pl_p'), { type: 'placed', id: 'pl_p', symbol: 'ETH', filledSz: 0, venueMs: 7 });
  assert.equal((of('placed', 'pl_o') as { venueMs?: number } | undefined)?.venueMs, 12, 'the child answer is the source, not a constant');

  h.runner.onAccount(account({ positions: [{ coin: 'ETH', szi: 5, entryPx: 95 }, { coin: 'BTC', szi: 10, entryPx: 100 }] }));
  await settle();
  assert.deepEqual(of('protected', 'pl_p'), { type: 'protected', id: 'pl_p', symbol: 'ETH', sz: 5, venueMs: 8 });

  await h.runner.change('pl_p', { stop: 92 });
  assert.equal((of('changed', 'pl_p') as { venueMs?: number } | undefined)?.venueMs, 9);

  await h.runner.close('pl_o', 30);
  assert.deepEqual(of('done', 'pl_o'), { type: 'done', id: 'pl_o', symbol: 'BTC', reason: 'closed', venueMs: 11 });

  await h.runner.cancel('pl_w');
  assert.deepEqual(of('done', 'pl_w'), { type: 'done', id: 'pl_w', symbol: 'SOL', reason: 'cancelled' }, 'a waiting plan is cancelled without the venue, so there is no round trip to report');
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
  await h.runner.arm(row({ id: 'pl_p', symbol: 'BTC', entry: { type: 'limit', px: 95 }, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
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

// ---------- a venue error the child cannot read is ambiguous, not a failure (A.F8) ----------
//
// The bracket POST reset, or the venue answered 5xx: the child flags the reply `ambiguous`
// because the venue may hold the entry. The host must keep the plan as placed under a fresh
// entry cloid so the account feed settles it, never finish it failed and let a re-propose fire a
// second bracket on top of a live position.
test('a fire reply flagged ambiguous leaves the plan placed under a fresh cloid, not failed', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row()); // creates the child, which default-fires pl_1 to placed
  const child = h.forked[0];
  child.answers.fire = (m) =>
    m.cmd === 'fire' ? { ev: 'error', seq: m.seq, id: m.id, message: 'runner command fire failed: ECONNRESET', ambiguous: true } : null;
  await h.runner.arm(row({ id: 'pl_2', symbol: 'BTC' }));
  await settle();
  const r = h.runner.get('pl_2');
  assert.equal(r?.status, 'placed', 'the venue may hold it, so it is placed, not failed');
  assert.ok(r?.cloids.entry, 'a deterministic entry cloid is set so a settle goes by an id we own');
  assert.ok(!h.events.some((e) => e.type === 'done' && e.id === 'pl_2'), 'nothing finished the plan');
});

test('a fire error with no ambiguous flag and no timeout wording still finishes the plan failed', async () => {
  const h = harness();
  fresh(h);
  await h.runner.arm(row());
  const child = h.forked[0];
  child.answers.fire = (m) =>
    m.cmd === 'fire' ? { ev: 'error', seq: m.seq, id: m.id, message: 'a bug in the child' } : null;
  await h.runner.arm(row({ id: 'pl_2', symbol: 'BTC' }));
  await settle();
  const r = h.runner.get('pl_2');
  assert.equal(r?.status, 'done');
  assert.equal(r?.endReason?.startsWith('failed'), true);
});
