// An order is confirmed by the venue's own word, read back by id, not by the absence of an
// error on the reply that placed it.
//
// Placing an order proved only that the exchange returned no error; a child reply that timed
// out was booked as placed outright. The read-back polls orderStatus for the entry, every
// second for twenty, until the venue says filled, open, canceled or rejected, and records
// which. Silence for the whole window is `unconfirmed`: the order may exist, the row stays
// where it is, and nothing places a second one. Every venue here is a stub; nothing is sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { classifyVenueStatus, confirmOrder } from '../../src/hl/confirm.ts';
import type { InfoClient } from '../../src/hl/info.ts';
import { createRunnerHost } from '../../src/runner/host.ts';
import type { AccountView, RunnerEvent } from '../../src/runner/host.ts';
import type { FromChild, ToChild } from '../../src/runner/protocol.ts';
import { createPlanStore } from '../../src/trade/plans.ts';
import type { PlanRow } from '../../src/trade/plans.ts';
import { planHash } from '../../src/trade/plan.ts';

const USER = '0x0000000000000000000000000000000000000001';
const FAST = { firstMs: 1, maxMs: 1, timeoutMs: 3 };
const noSleep = async (): Promise<void> => {};

/* The /info door, answering orderStatus from a script consumed one entry per read (the last
   repeats). 'unknown' is the venue's unknownOid, 'throw' a failed call, anything else the
   venue's status word for a known order. */
function fakeInfo(script: string[]): { info: InfoClient; asked: Array<Record<string, unknown>> } {
  const asked: Array<Record<string, unknown>> = [];
  const info: InfoClient = {
    post<T>(body: unknown): Promise<T> {
      const b = body as Record<string, unknown>;
      if (b.type !== 'orderStatus') return Promise.resolve({} as T);
      const word = script[Math.min(asked.length, script.length - 1)] ?? 'unknown';
      asked.push(b);
      if (word === 'throw') return Promise.reject(new Error('hyperliquid /info 500'));
      if (word === 'unknown') return Promise.resolve({ status: 'unknownOid' } as T);
      return Promise.resolve({ status: 'order', order: { status: word, statusTimestamp: 1, order: { oid: 77, coin: 'ETH' } } } as T);
    },
    health: () => ({ ok: true, consecutiveFailures: 0, lastError: null, lastLatencyMs: null, backoffUntilMs: null }),
  };
  return { info, asked };
}

test('the venue status words map onto the four answers, and an unknown word onto none', () => {
  assert.equal(classifyVenueStatus('filled'), 'filled');
  assert.equal(classifyVenueStatus('open'), 'resting');
  assert.equal(classifyVenueStatus('triggered'), 'resting');
  assert.equal(classifyVenueStatus('canceled'), 'canceled');
  assert.equal(classifyVenueStatus('marginCanceled'), 'canceled');
  assert.equal(classifyVenueStatus('siblingFilledCanceled'), 'canceled');
  assert.equal(classifyVenueStatus('rejected'), 'rejected');
  assert.equal(classifyVenueStatus('perpMarginRejected'), 'rejected');
  assert.equal(classifyVenueStatus('tickRejected'), 'rejected');
  assert.equal(classifyVenueStatus('somethingNew'), null);
  assert.equal(classifyVenueStatus(''), null);
});

test('a filled order is confirmed on the first read', async () => {
  const { info, asked } = fakeInfo(['filled']);
  const out = await confirmOrder({ info, user: USER, oid: 77, schedule: FAST, sleep: noSleep });
  assert.equal(out.state, 'filled');
  assert.equal(out.venueStatus, 'filled');
  assert.equal(out.oid, 77);
  assert.equal(out.reads, 1);
  assert.deepEqual(asked[0], { type: 'orderStatus', user: USER, oid: 77 });
});

test('an order the venue has not indexed yet is read again until it answers, then confirmed resting', async () => {
  const { info } = fakeInfo(['unknown', 'unknown', 'open']);
  const out = await confirmOrder({ info, user: USER, oid: 77, schedule: FAST, sleep: noSleep });
  assert.equal(out.state, 'resting');
  assert.equal(out.reads, 3);
});

test('a venue that never answers inside the window leaves the order unconfirmed, never placed', async () => {
  const { info, asked } = fakeInfo(['unknown']);
  const out = await confirmOrder({ info, user: USER, oid: 77, schedule: FAST, sleep: noSleep });
  assert.equal(out.state, 'unconfirmed');
  assert.equal(out.venueStatus, null);
  assert.ok(asked.length >= 3, `polled through the window (${asked.length} reads)`);
  assert.equal(out.reads, asked.length);
});

test('a read-back whose calls fail is unconfirmed too, not an error thrown at the caller', async () => {
  const { info } = fakeInfo(['throw']);
  const out = await confirmOrder({ info, user: USER, oid: 77, schedule: FAST, sleep: noSleep });
  assert.equal(out.state, 'unconfirmed');
});

test('a canceled family word is canceled with the venue word kept, and a client order id can be the key', async () => {
  const { info, asked } = fakeInfo(['marginCanceled']);
  const out = await confirmOrder({ info, user: USER, oid: '0x' + '1'.repeat(32), schedule: FAST, sleep: noSleep });
  assert.equal(out.state, 'canceled');
  assert.equal(out.venueStatus, 'marginCanceled');
  assert.equal(asked[0]?.oid, '0x' + '1'.repeat(32));
});

// ---------- the runner host ----------

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  killed = false;
  readonly sent: ToChild[] = [];
  stderr = null;
  fire: ((m: ToChild & { cmd: 'fire' }) => FromChild | null) | null = null;
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
    if (m.cmd === 'fire') reply = this.fire === null ? null : this.fire(m);
    if (m.cmd === 'release') reply = { ev: 'released', seq: m.seq, id: m.id };
    if (m.cmd === 'flatten') reply = { ev: 'flat', seq: m.seq, stillOpen: [], detail: '' };
    if (reply !== null) setImmediate(() => this.emit('message', reply));
    return true;
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

function row(): PlanRow {
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
  };
  base.hash = planHash({ id: base.id, symbol: base.symbol, side: base.side, sizeUsd: base.sizeUsd, leverage: base.leverage, entry: base.entry, stop: base.stop, target: base.target, expiresAt: base.expiresAt });
  return base;
}

function account(): AccountView {
  return { atMs: Date.now(), freeUsd: 1000, positions: [], orders: [], fills: [] };
}

function host(script: string[], replyMs = 500) {
  const { info, asked } = fakeInfo(script);
  const forked: FakeChild[] = [];
  const events: RunnerEvent[] = [];
  const runner = createRunnerHost({
    apiWalletKey: async () => '0x'.padEnd(66, '1') as `0x${string}`,
    baseUrl: 'http://127.0.0.1:1',
    user: USER,
    killSwitch: () => false,
    onEvent: (e) => events.push(e),
    store: createPlanStore(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-hl-confirm-'))),
    meta: () => ({ assetId: 3, szDecimals: 4, maxLeverage: 25 }),
    mark: () => 100,
    free: () => 1000,
    agentApproved: async () => true,
    replyMs,
    info,
    confirmSchedule: FAST,
    sleep: noSleep,
    forkImpl: (() => {
      const child = new FakeChild();
      forked.push(child);
      return child as unknown as ChildProcess;
    }) as never,
  });
  return { runner, forked, events, asked, child: () => forked[0] };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

async function armAndFire(h: ReturnType<typeof host>, fire: FakeChild['fire']): Promise<void> {
  const armed = await h.runner.arm(row());
  assert.equal(armed.ok, true, armed.ok ? '' : armed.reason);
  h.child().fire = fire;
  h.runner.onAccount(account());
  await settle();
}

const placed = (m: ToChild & { cmd: 'fire' }): FromChild => ({ ev: 'placed', seq: m.seq, id: m.id, oids: { entry: 77 }, filledSz: 0, avgPx: null, cloids: { entry: '0xentry' }, gen: 1, venueMs: 7 });

test('a placed entry is read back by its oid and confirmed resting when the venue says open', async () => {
  const h = host(['unknown', 'open']);
  await armAndFire(h, placed);
  const r = h.runner.get('pl_1');
  assert.equal(r?.status, 'placed');
  assert.equal(r?.confirm?.state, 'resting');
  assert.equal(r?.confirm?.venueStatus, 'open');
  assert.equal(r?.confirm?.reads, 2);
  assert.deepEqual(h.asked[0], { type: 'orderStatus', user: USER, oid: 77 });
  const confirmed = h.events.find((e) => e.type === 'confirmed');
  assert.ok(confirmed !== undefined && confirmed.type === 'confirmed' && confirmed.state === 'resting');
});

test('an entry the venue reports rejected ends the plan as failed with the venue word', async () => {
  const h = host(['perpMarginRejected']);
  await armAndFire(h, placed);
  const r = h.runner.get('pl_1');
  assert.equal(r?.status, 'done');
  assert.equal(r?.endReason, 'failed:the venue rejected the entry (perpMarginRejected)');
  assert.equal(r?.confirm?.state, 'rejected');
});

test('an entry the venue reports canceled with no fill ends the plan as cancelled', async () => {
  const h = host(['canceled']);
  await armAndFire(h, placed);
  const r = h.runner.get('pl_1');
  assert.equal(r?.status, 'done');
  assert.equal(r?.endReason, 'cancelled');
});

test('a filled market entry that the venue later calls canceled (the IOC remainder) stays open as a fill', async () => {
  const h = host(['canceled']);
  await armAndFire(h, (m) => ({ ev: 'placed', seq: m.seq, id: m.id, oids: { entry: 77 }, filledSz: 4, avgPx: 100, cloids: { entry: '0xentry', stop: '0xstop' }, gen: 1, venueMs: 7 }));
  const r = h.runner.get('pl_1');
  assert.equal(r?.status, 'open');
  assert.equal(r?.confirm?.state, 'filled');
  assert.equal(r?.confirm?.venueStatus, 'canceled', 'the venue word is kept beside the answer');
});

test('a venue silent for the whole window leaves the row placed but unconfirmed, and it is not fired again', async () => {
  const h = host(['unknown']);
  await armAndFire(h, placed);
  const r = h.runner.get('pl_1');
  assert.equal(r?.status, 'placed');
  assert.equal(r?.confirm?.state, 'unconfirmed');
  const unconfirmed = h.events.filter((e) => e.type === 'unconfirmed');
  assert.equal(unconfirmed.length, 1);
  assert.match(unconfirmed[0]?.type === 'unconfirmed' ? unconfirmed[0].detail : '', /the order may exist and nothing places a second one/);

  h.runner.onAccount(account());
  await settle();
  assert.equal(h.child().of('fire').length, 1, 'a placed row never fires twice');
});

test('a child that never answers the fire leaves the row unconfirmed under its client order id, and the venue is asked by that id', async () => {
  const h = host(['unknown', 'unknown', 'open'], 40);
  await armAndFire(h, () => null);
  await settle();
  await settle();
  const r = h.runner.get('pl_1');
  assert.equal(r?.status, 'placed', 'never waiting again: a second fire is the one thing that must not happen');
  assert.ok(r?.cloids.entry !== undefined, 'the id the child would have used is on the row');
  const first = h.events.find((e) => e.type === 'unconfirmed');
  assert.ok(first !== undefined, 'the timeout is reported as unconfirmed, not as placed');
  assert.match(first?.type === 'unconfirmed' ? first.detail : '', /unconfirmed/);
  assert.doesNotMatch(first?.type === 'unconfirmed' ? first.detail : '', /treated as placed/);
  assert.equal(h.asked[0]?.oid, r?.cloids.entry, 'read back by the client order id');
  assert.equal(r?.confirm?.state, 'resting', 'and the venue, once it answered, settled it');
  assert.equal(h.child().of('fire').length, 1);
});
