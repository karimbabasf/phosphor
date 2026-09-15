// The runner child against a venue that answers the way Hyperliquid does.
//
// A real fork of src/runner/main.ts, its key over stdin, its commands over IPC, and a loopback
// http server standing in for api.hyperliquid.xyz with the response shapes the docs give:
// statuses[].filled.totalSz, resting.oid, error; clearinghouseState.assetPositions; openOrders
// with a cloid. Nothing here reaches the network.
//
// Every command path the child has is driven once, because each one signs with real money.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FromChild, ToChild } from '../../src/runner/protocol.ts';
import type { Plan } from '../../src/trade/plan.ts';
import { venue } from '../fixtures/hl-venue.ts';
import type { Wire } from '../fixtures/hl-venue.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// A command without its sequence number, which the harness mints. Distributed over the union by
// hand, because Omit on a union keeps only the keys every member shares.
type Command = { [K in ToChild['cmd']]: Omit<Extract<ToChild, { cmd: K }>, 'seq'> }[ToChild['cmd']];
const USER = '0x2222222222222222222222222222222222222222';
const KEY = `0x${'11'.repeat(32)}`;
const META = { assetId: 3, szDecimals: 4, maxLeverage: 25 };

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'pl_1',
    symbol: 'ETH',
    side: 'long',
    sizeUsd: 1000,
    leverage: 5,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    target: 120,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  };
}

// The child, spoken to the way the host speaks to it.
class Child {
  readonly proc: ChildProcess;
  readonly events: FromChild[] = [];
  private seq = 0;
  private waiting = new Map<number, (e: FromChild) => void>();

  constructor(url: string) {
    this.proc = fork(path.join(ROOT, 'src', 'runner', 'main.ts'), [], {
      env: { ...process.env, PHOSPHOR_HL_URL: url, PHOSPHOR_HL_USER: USER },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    this.proc.stdin?.write(`${KEY}\n`);
    this.proc.stdin?.end();
    this.proc.on('message', (m) => {
      const e = m as FromChild;
      this.events.push(e);
      const settle = this.waiting.get(e.seq);
      if (settle !== undefined) {
        this.waiting.delete(e.seq);
        settle(e);
      }
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve) => {
      if (this.events.some((e) => e.ev === 'ready')) return resolve();
      this.proc.on('message', (m) => {
        if ((m as FromChild).ev === 'ready') resolve();
      });
    });
  }

  send(cmd: Command): Promise<FromChild> {
    this.seq += 1;
    const seq = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${cmd.cmd} within 10s`)), 10_000);
      this.waiting.set(seq, (e) => {
        clearTimeout(timer);
        resolve(e);
      });
      this.proc.send({ ...cmd, seq } as ToChild);
    });
  }

  async arm(p: Plan, gen = 0): Promise<void> {
    const e = await this.send({ cmd: 'arm', plan: p, cloids: {}, gen, meta: META });
    assert.equal(e.ev, 'armed');
  }

  kill(): void {
    this.proc.kill('SIGKILL');
  }
}

const children: Child[] = [];
const venues: ReturnType<typeof venue>[] = [];

async function boot(): Promise<{ v: ReturnType<typeof venue>; c: Child }> {
  const v = venue();
  const url = await v.listen();
  const c = new Child(url);
  await c.ready();
  children.push(c);
  venues.push(v);
  return { v, c };
}

after(async () => {
  for (const c of children) c.kill();
  for (const v of venues) await v.close();
});

function trigger(w: Wire): { isMarket: boolean; triggerPx: string; tpsl: string } {
  return (w.t as { trigger: { isMarket: boolean; triggerPx: string; tpsl: string } }).trigger;
}

test('a market fire is one bracket: entry IOC, stop with its limit ten percent past, target as a limit', async () => {
  const { v, c } = await boot();
  v.state.leverage = { type: 'cross', value: 3 };
  await c.arm(plan());
  const e = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(e.ev, 'placed', JSON.stringify(e));
  if (e.ev !== 'placed') return;
  assert.equal(e.filledSz, 9.971, 'a thousand dollars at the bound, rounded toward zero, filled whole');
  assert.equal(e.avgPx, 100.29);
  assert.equal(typeof e.cloids.entry, 'string');
  assert.equal(typeof e.cloids.stop, 'string');
  assert.equal(typeof e.cloids.target, 'string');

  // Leverage first, isolated, because the account was at 3x cross.
  const lev = v.state.actions[0];
  assert.deepEqual(lev, { type: 'updateLeverage', asset: 3, isCross: false, leverage: 5 });

  const orders = v.orders();
  assert.equal(orders.length, 1, 'one signed action carries the entry and both exits');
  const [bracket] = orders;
  assert.equal(bracket.grouping, 'normalTpsl');
  assert.equal(bracket.orders.length, 3);
  const [entry, stop, target] = bracket.orders;
  assert.deepEqual(entry.t, { limit: { tif: 'Ioc' } });
  // 100 times 1.003 lands a hair under 100.3 in binary and a buy bound rounds DOWN, so the
  // venue sees 100.29: one tick tighter than the nominal bound, never past it.
  assert.equal(entry.p, '100.29', 'the entry bound is the mark plus 30 bps, rounded down for a buy');
  assert.equal(entry.s, '9.971', 'sized at the bound so a fill there never exceeds the approved notional');
  assert.equal(entry.r, false);
  assert.equal(stop.r, true);
  assert.equal(trigger(stop).tpsl, 'sl');
  assert.equal(trigger(stop).isMarket, true);
  assert.equal(trigger(stop).triggerPx, '90');
  assert.equal(stop.p, '81', 'the stop leg works ten percent past its trigger');
  assert.equal(trigger(target).tpsl, 'tp');
  assert.equal(trigger(target).isMarket, false);
  assert.equal(target.p, '120');
  assert.equal(stop.c, e.cloids.stop);
  assert.equal(target.c, e.cloids.target);
});

test('a partial IOC fill gets positionTpsl exits sized to the fill, in the same command', async () => {
  const { v, c } = await boot();
  v.state.answer = (orders) => orders.map((o, i) => (i === 0 ? { filled: { totalSz: '4', avgPx: o.p, oid: 1 } } : 'waitingForFill'));
  await c.arm(plan());
  const e = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(e.ev, 'placed', JSON.stringify(e));
  if (e.ev !== 'placed') return;
  assert.equal(e.filledSz, 4);
  const orders = v.orders();
  assert.equal(orders.length, 2, 'the bracket, then the exits for the part that filled');
  const exits = orders[1];
  assert.equal(exits.grouping, 'positionTpsl');
  assert.equal(exits.orders.length, 2);
  for (const o of exits.orders) {
    assert.equal(o.s, '4', 'sized to the fill, not to the plan');
    assert.equal(o.r, true);
  }
  assert.notEqual(exits.orders[0].c, orders[0].orders[1].c, 'the replacement stop is a new generation with an id of its own');
});

test('a limit fire rests the entry alone, and a stop entry is a trigger that opens', async () => {
  const { v, c } = await boot();
  await c.arm(plan({ entry: { type: 'limit', px: 95 } }));
  const e = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(e.ev, 'placed', JSON.stringify(e));
  if (e.ev !== 'placed') return;
  assert.equal(e.filledSz, 0);
  assert.equal(e.oids.entry, 2000);
  const orders = v.orders();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].grouping, 'na');
  assert.equal(orders[0].orders.length, 1, 'no exits until something fills');
  assert.deepEqual(orders[0].orders[0].t, { limit: { tif: 'Gtc' } });
  assert.equal(orders[0].orders[0].p, '95');

  await c.arm(plan({ id: 'pl_2', entry: { type: 'stop', px: 105, maxSlippageBps: 30 }, stop: 95 }));
  const s = await c.send({ cmd: 'fire', id: 'pl_2', mark: 100 });
  assert.equal(s.ev, 'placed', JSON.stringify(s));
  const stopEntry = v.orders()[1];
  assert.equal(stopEntry.grouping, 'na');
  assert.equal(stopEntry.orders[0].r, false, 'an entry opens');
  assert.equal(trigger(stopEntry.orders[0]).triggerPx, '105');
  assert.equal(stopEntry.orders[0].p, '105.31', 'its own slippage bound, not the venue ten percent');
});

test('protect sizes the exits to the position the venue reports, and is idempotent', async () => {
  const { v, c } = await boot();
  await c.arm(plan({ entry: { type: 'limit', px: 95 } }));
  await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  v.state.position = { szi: 6, entryPx: 95 };
  const e = await c.send({ cmd: 'protect', id: 'pl_1' });
  assert.equal(e.ev, 'protected', JSON.stringify(e));
  if (e.ev !== 'protected') return;
  assert.equal(e.sz, 6);
  const exits = v.orders()[1];
  assert.equal(exits.grouping, 'positionTpsl');
  assert.equal(exits.orders[0].s, '6');
  assert.equal(exits.orders[1].s, '6');

  const again = await c.send({ cmd: 'protect', id: 'pl_1' });
  assert.equal(again.ev, 'protected');
  assert.equal(v.orders().length, 2, 'the same size places nothing twice');

  // The position grew: the old exits go by cloid and new ones come sized to it.
  v.state.position = { szi: 10, entryPx: 95 };
  const grown = await c.send({ cmd: 'protect', id: 'pl_1' });
  assert.equal(grown.ev, 'protected');
  const cancel = v.state.actions.find((a) => a.type === 'cancelByCloid');
  assert.ok(cancel !== undefined && cancel.type === 'cancelByCloid');
  assert.deepEqual(
    cancel.cancels.map((x) => x.cloid).sort(),
    [exits.orders[0].c, exits.orders[1].c].sort(),
  );
  assert.equal(v.orders()[2].orders[0].s, '10');
});

test('modify re-checks the sides against the mark, then cancels by cloid and places the next generation', async () => {
  const { v, c } = await boot();
  await c.arm(plan());
  const fired = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(fired.ev, 'placed');
  v.state.position = { szi: 10, entryPx: 100.3 };

  const wrong = await c.send({ cmd: 'modify', id: 'pl_1', stop: 101, cloids: {}, gen: 1, mark: 100 });
  assert.equal(wrong.ev, 'refused');
  assert.match(wrong.ev === 'refused' ? wrong.reason : '', /stop/);

  const before = v.orders().length;
  const ok = await c.send({ cmd: 'modify', id: 'pl_1', stop: 95, cloids: {}, gen: 1, mark: 100 });
  assert.equal(ok.ev, 'modified', JSON.stringify(ok));
  if (ok.ev !== 'modified') return;
  assert.equal(ok.stop, 95);
  assert.equal(ok.gen, 2);
  const cancel = v.state.actions.find((a) => a.type === 'cancelByCloid');
  assert.ok(cancel !== undefined, 'the old exits were cancelled by cloid');
  const next = v.orders()[before];
  assert.equal(next.grouping, 'positionTpsl');
  assert.equal(trigger(next.orders[0]).triggerPx, '95');
  assert.equal(next.orders[0].p, '85.5');
  assert.equal(next.orders[0].s, '10');
});

test('cancel on an open plan is refused; on a placed plan it cancels the entry and protects any fill', async () => {
  const { v, c } = await boot();
  await c.arm(plan());
  await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  const open = await c.send({ cmd: 'cancel', id: 'pl_1' });
  assert.equal(open.ev, 'refused');
  assert.match(open.ev === 'refused' ? open.reason : '', /open/);

  await c.arm(plan({ id: 'pl_2', entry: { type: 'limit', px: 95 } }));
  const placed = await c.send({ cmd: 'fire', id: 'pl_2', mark: 100 });
  assert.equal(placed.ev, 'placed');
  v.state.position = { szi: 3, entryPx: 95 };
  const cancelled = await c.send({ cmd: 'cancel', id: 'pl_2' });
  assert.equal(cancelled.ev, 'cancelled', JSON.stringify(cancelled));
  assert.equal(cancelled.ev === 'cancelled' ? cancelled.filledSz : 0, 3);
  const cancel = v.state.actions.find((a) => a.type === 'cancelByCloid');
  assert.ok(cancel !== undefined && cancel.type === 'cancelByCloid');
  assert.equal(cancel.cancels[0].cloid, placed.ev === 'placed' ? placed.cloids.entry : '');
  const exits = v.orders()[v.orders().length - 1];
  assert.equal(exits.grouping, 'positionTpsl');
  assert.equal(exits.orders[0].s, '3', 'the part that filled is protected before the answer');
});

test('"already canceled" is success, and any other cancel error is not', async () => {
  const { v, c } = await boot();
  await c.arm(plan({ entry: { type: 'limit', px: 95 } }));
  await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  v.state.cancelAnswer = () => [{ error: 'Order was never placed, already canceled, or filled.' }];
  const gone = await c.send({ cmd: 'cancel', id: 'pl_1' });
  assert.equal(gone.ev, 'cancelled', JSON.stringify(gone));

  await c.arm(plan({ id: 'pl_2', entry: { type: 'limit', px: 95 } }));
  await c.send({ cmd: 'fire', id: 'pl_2', mark: 100 });
  v.state.cancelAnswer = () => [{ error: 'Rate limited' }];
  const refused = await c.send({ cmd: 'cancel', id: 'pl_2' });
  assert.equal(refused.ev, 'error');
  assert.match(refused.ev === 'error' ? refused.message : '', /still working/);
});

test('close is a reduce-only IOC at the plan bound, then the exits are cancelled once flat', async () => {
  const { v, c } = await boot();
  await c.arm(plan());
  await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  v.state.position = { szi: 10, entryPx: 100.3 };
  let reads = 0;
  v.state.answer = (orders) => {
    // The close fills; the next position read finds the account flat.
    v.state.position = null;
    reads += 1;
    return orders.map((o) => ({ filled: { totalSz: o.s, avgPx: o.p, oid: 9 } }));
  };
  const e = await c.send({ cmd: 'close', id: 'pl_1', maxSlippageBps: 30, mark: 110 });
  assert.equal(e.ev, 'closed', JSON.stringify(e));
  assert.equal(reads, 1);
  const closeOrder = v.orders()[1].orders[0];
  assert.equal(closeOrder.b, false, 'closing a long is a sell');
  assert.equal(closeOrder.r, true);
  assert.equal(closeOrder.p, '109.67', 'the mark less 30 bps, rounded up for a sell');
  assert.equal(closeOrder.s, '10');
  const cancel = v.state.actions.find((a) => a.type === 'cancelByCloid');
  assert.ok(cancel !== undefined && cancel.type === 'cancelByCloid' && cancel.cancels.length === 2, 'both exits are cancelled');
});

test('every event that reached the venue says how long the venue took, in whole milliseconds', async () => {
  const { v, c } = await boot();
  const venueMs = (e: FromChild): number => ('venueMs' in e ? e.venueMs : Number.NaN);
  const took = (e: FromChild, what: string): void => {
    assert.ok(Number.isInteger(venueMs(e)) && venueMs(e) >= 0, `${what} carries the venue round trip: ${JSON.stringify(e)}`);
  };
  await c.arm(plan());
  const placed = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(placed.ev, 'placed');
  took(placed, 'placed');
  v.state.position = { szi: 10, entryPx: 100.3 };
  took(await c.send({ cmd: 'protect', id: 'pl_1' }), 'protected');
  took(await c.send({ cmd: 'modify', id: 'pl_1', stop: 95, cloids: {}, gen: 1, mark: 100 }), 'modified');
  v.state.answer = (orders) => {
    v.state.position = null;
    return orders.map((o) => ({ filled: { totalSz: o.s, avgPx: o.p, oid: 9 } }));
  };
  took(await c.send({ cmd: 'close', id: 'pl_1', maxSlippageBps: 30, mark: 110 }), 'closed');
  v.state.answer = null;
  await c.arm(plan({ id: 'pl_2', entry: { type: 'limit', px: 95 } }));
  await c.send({ cmd: 'fire', id: 'pl_2', mark: 100 });
  took(await c.send({ cmd: 'cancel', id: 'pl_2' }), 'cancelled');
  // A refusal that never reached the venue carries no round trip: there was none.
  const refused = await c.send({ cmd: 'fire', id: 'pl_9', mark: 100 });
  assert.equal(refused.ev, 'refused');
  assert.ok(!('venueMs' in refused));
});

test('an unknown plan and an expired plan are refused by name, before anything is read or signed', async () => {
  const { v, c } = await boot();
  const unknown = await c.send({ cmd: 'fire', id: 'pl_9', mark: 100 });
  assert.equal(unknown.ev, 'refused');
  assert.match(unknown.ev === 'refused' ? unknown.reason : '', /pl_9/);

  await c.arm(plan({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const expired = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(expired.ev, 'refused');
  assert.match(expired.ev === 'refused' ? expired.reason : '', /expired/);
  assert.equal(v.state.actions.length, 0, 'nothing reached the venue');
});

test('leverage is never changed under a position or a resting order on the coin', async () => {
  const { v, c } = await boot();
  v.state.leverage = { type: 'cross', value: 3 };
  v.state.position = { szi: 1, entryPx: 100 };
  await c.arm(plan());
  const e = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(e.ev, 'refused');
  assert.match(e.ev === 'refused' ? e.reason : '', /leverage cannot move/);
  assert.equal(v.state.actions.length, 0);

  v.state.position = null;
  v.state.openOrders = [{ coin: 'ETH', oid: 5, cloid: null }];
  const again = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(again.ev, 'refused');
  assert.equal(v.state.actions.length, 0);
});

test('a venue refusal on the bracket is a refusal, and the plan can fire again', async () => {
  const { v, c } = await boot();
  v.state.answer = () => [{ error: 'Insufficient margin to place order.' }];
  await c.arm(plan());
  const e = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(e.ev, 'refused');
  assert.match(e.ev === 'refused' ? e.reason : '', /Insufficient margin/);
  v.state.answer = null;
  const ok = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(ok.ev, 'placed', 'the reservation was released with the refusal');
});

test('flatten closes every coin it is named and cancels every cloid it is named', async () => {
  const { v, c } = await boot();
  v.state.position = { szi: -2, entryPx: 100 };
  v.state.answer = (orders) => {
    v.state.position = null;
    return orders.map((o) => ({ filled: { totalSz: o.s, avgPx: o.p, oid: 9 } }));
  };
  const e = await c.send({ cmd: 'flatten', coins: [{ coin: 'ETH', meta: META, mark: 100 }], cancels: [{ assetId: 3, cloid: '0xabc' }] });
  assert.equal(e.ev, 'flat', JSON.stringify(e));
  if (e.ev !== 'flat') return;
  assert.deepEqual(e.stillOpen, []);
  const closeOrder = v.orders()[0].orders[0];
  assert.equal(closeOrder.b, true, 'closing a short is a buy');
  assert.equal(closeOrder.p, '101', 'a hundred basis points for the human door');
  assert.ok(v.state.actions.some((a) => a.type === 'cancelByCloid'));
});

test('a venue 5xx on the bracket answers ambiguous, not refused: the venue may hold the order', async () => {
  const { v, c } = await boot();
  await c.arm(plan());
  v.state.exchangeStatus = 502;
  const e = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(e.ev, 'error', JSON.stringify(e));
  if (e.ev !== 'error') return;
  assert.equal(e.ambiguous, true, 'a 5xx is ambiguous, so the host keeps the plan rather than abandoning it');

  // And a second fire of the same plan is refused, because it is still counted as fired: the
  // one thing that must not happen after an ambiguous send is a second bracket on the venue.
  const again = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(again.ev, 'refused', JSON.stringify(again));
});

// ---------- every action expires ----------
//
// The child signs an expiresAfter of one minute into every L1 action it posts, so a bracket held
// up on the way cannot land later against a market that moved. The venue reads it and rejects a
// stale action outright, with HTTP 200 and status 'err', which is a definite answer: nothing
// rests, so the plan is refused (never ambiguous) and may fire again.

test('every action the child posts carries an expiry a minute ahead, inside the signed bytes', async () => {
  const { v, c } = await boot();
  const before = Date.now();
  await c.arm(plan());
  const e = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(e.ev, 'placed', JSON.stringify(e));
  const posted = v.state.bodies;
  assert.ok(posted.length >= 1, 'the bracket went to the venue');
  assert.ok(posted.some((b) => (b.action as { type?: string }).type === 'order'));
  for (const body of posted) {
    const expires = body.expiresAfter;
    assert.equal(typeof expires, 'number', `${String((body.action as { type?: string }).type)} carries expiresAfter`);
    assert.ok((expires as number) >= before + 60_000 && (expires as number) <= Date.now() + 60_000, 'a minute ahead of when it was signed');
    assert.ok((expires as number) > (body.nonce as number), 'and after the nonce it was signed with');
  }
});

test('an action the venue rejected as expired is a definite refusal, and the plan can fire again', async () => {
  const { v, c } = await boot();
  await c.arm(plan());
  v.state.exchangeError = 'Action expired: expiresAfter is before the current block time';
  const e = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(e.ev, 'refused', JSON.stringify(e));
  assert.match(e.ev === 'refused' ? e.reason : '', /expired/);
  assert.ok(!('ambiguous' in e), 'a stale action does not exist at the venue, so nothing is held');

  const ok = await c.send({ cmd: 'fire', id: 'pl_1', mark: 100 });
  assert.equal(ok.ev, 'placed', 'the reservation was released with the refusal');
});
