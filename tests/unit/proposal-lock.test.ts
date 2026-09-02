// The one-at-a-time queue, and where it now ends.
//
// It has to exist. "Read the spend, decide, reserve" is only a budget if it is indivisible: five
// concurrent $10,000 consolidations moved $50,000 against a $25,000 cap before this chain, each
// one reading a spend of zero.
//
// It used to cover the whole job, and a job ends in a rail. A rail sitting in watchStatus held
// the chain for up to five minutes, and for those five minutes nobody could approve, refuse or
// cancel anything, including the thing that was stuck. The queue that stops two proposals racing
// was stopping a person reaching the brake.
//
// Two properties, and they pull against each other, which is why both are here:
//   1. the reservation is still serialised, so the cap still holds under concurrency;
//   2. everything after it is not, so a hung venue does not hold the door.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';
import { venueAllowlist } from '../../src/rails/index.ts';
import { createSerialiser } from '../../src/proposals/lifecycle.ts';
import { reservationMade, reservationState, withReservation } from '../../src/proposals/reservation.ts';
import type { AppConfig, ProposalService, Rail, RiskRow, WriteDraft } from '../../src/types.ts';

const RISK_ROWS: RiskRow[] = [{ symbol: 'USDC', issuer: 'Circle', freezable: true, tier: 'A' } as unknown as RiskRow];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-lock-'));
}

// ---------- the queue itself, in isolation ----------

test('a job that never reserves anything still lets the queue move on', async () => {
  const serialise = createSerialiser();
  const order: string[] = [];
  const first = serialise(async () => {
    order.push('first-start');
    await new Promise((r) => setTimeout(r, 30));
    order.push('first-end');
  });
  const second = serialise(async () => {
    order.push('second-start');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});

test('the queue moves on at the reservation, not at the end of the job', async () => {
  const serialise = createSerialiser();
  const order: string[] = [];
  let releaseWork = (): void => {};
  const held = new Promise<void>((r) => (releaseWork = r));

  const first = serialise(async () => {
    order.push('first-start');
    reservationMade(); // the budget is on disk here
    await held; // and this is the venue, which may take five minutes
    order.push('first-end');
  });
  const second = serialise(async () => {
    order.push('second-start');
  });

  await second;
  assert.deepEqual(order, ['first-start', 'second-start'], 'the second ran while the first waited');
  releaseWork();
  await first;
  assert.deepEqual(order, ['first-start', 'second-start', 'first-end']);
});

test('idle still waits for the whole job, not just the reservation', async () => {
  const serialise = createSerialiser();
  let done = false;
  void serialise(async () => {
    reservationMade();
    await new Promise((r) => setTimeout(r, 40));
    done = true;
  });
  await serialise.idle();
  assert.equal(done, true, 'a shutdown must not close the sockets on a rail that is mid send');
});

test('a rejection does not wedge the queue', async () => {
  const serialise = createSerialiser();
  void serialise(() => Promise.reject(new Error('rail threw'))).catch(() => undefined);
  const after = await serialise(async () => 'ran');
  assert.equal(after, 'ran');
});

test('reservationMade outside a queued job does nothing rather than throwing', () => {
  assert.deepEqual(reservationState(), { inside: false, released: false });
  reservationMade(); // must not throw
});

test('the slot releases exactly once, however many times it is called', async () => {
  let released = 0;
  await withReservation(
    () => (released += 1),
    async () => {
      assert.equal(reservationState().inside, true);
      reservationMade();
      reservationMade();
      assert.equal(reservationState().released, true);
    },
  );
  assert.equal(released, 1);
});

// ---------- against the real service ----------

function setup(rail: Rail | null, clickAboveUsd = 1_000_000): { svc: ProposalService; dir: string } {
  const dir = tmpDir();
  const p = defaultPolicy();
  // Room to move and a venue to move to. The default policy allows nothing and caps at $10k, so
  // without these every proposal below is refused for a reason that has nothing to do with the
  // queue this file is about.
  p.outbound.maxPerTransactionUsd = 1_000_000;
  p.outbound.maxPerSessionUsd = 1_000_000;
  // Below this a proposal executes on the policy's own say-so and reaches the rail; above it
  // the proposal sits pending until a human clicks. Both are needed here: the hung rail has to be
  // reached, and there has to be something waiting that a person can still refuse.
  p.outbound.humanClickAboveUsd = clickAboveUsd;
  p.outbound.destinationAllowlist = [...venueAllowlist(), '0x794a61358d6845594f94dc1db02a252b5b4814ad'];
  p.sentences = renderSentences(p);
  savePolicy(dir, p);

  const cfg = {
    mode: 'live',
    dataDir: dir,
    port: 0,
    keysPath: path.join(dir, 'keys.json'),
    addresses: { evm: ['0x1111111111111111111111111111111111111111'], solana: [], near: [] },
    economicTransferUsd: 5,
    candleProducts: ['BTC-USD'],
  } as unknown as AppConfig;

  const svc = createProposalService({
    cfg,
    audit: createAudit(dir),
    store: createStore(dir),
    ledger: createLedger({ ...cfg, mode: 'demo' } as AppConfig),
    riskRows: RISK_ROWS,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir: dir,
    rails: {
      for: (draft: WriteDraft) => (rail !== null && draft.kind === rail.kind ? rail : null),
      kinds: () => (rail === null ? [] : [rail.kind as never]),
    },
  });
  return { svc, dir };
}

test('a rail whose status poll hangs does not hold a refuse on another proposal', async () => {
  let releaseRail = (): void => {};
  const hung = new Promise<void>((r) => (releaseRail = r));

  // A rail whose execute never returns: exactly what watchStatus looks like against a venue
  // that has stopped answering, and the shape that used to hold the whole app.
  const rail: Rail = {
    kind: 'yield_deposit',
    valueUsd: () => 1,
    simulate: async () => ({ ok: true, summary: 'fine' }),
    execute: async () => {
      await hung;
      return { ok: true, detail: 'eventually' };
    },
  } as unknown as Rail;

  // $50: the $1 deposit executes and reaches the hung rail, the $100 consolidate waits.
  const { svc } = setup(rail, 50);

  // One proposal that will sit pending, so there is something to refuse.
  const pending = await svc.proposeConsolidate({ toChain: 'arb', symbol: 'USDC', maxTotalUsd: 100 });

  // And one that goes straight into the hung rail. Not awaited: it never finishes.
  const stuck = svc.proposeYieldDeposit({ chain: 'arb', symbol: 'USDC', amount: 1 });
  void stuck.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 100));

  const started = Date.now();
  await svc.refuse(pending.id);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1_000, `refuse took ${elapsed}ms while a rail was hung; it must not wait on one`);
  assert.equal(svc.get(pending.id)?.status, 'refused');

  releaseRail();
  await stuck.catch(() => undefined);
});

test('a rail whose status poll hangs does not hold the next propose either', async () => {
  let releaseRail = (): void => {};
  const hung = new Promise<void>((r) => (releaseRail = r));
  const rail: Rail = {
    kind: 'yield_deposit',
    valueUsd: () => 1,
    simulate: async () => ({ ok: true, summary: 'fine' }),
    execute: async () => {
      await hung;
      return { ok: true, detail: 'eventually' };
    },
  } as unknown as Rail;

  const { svc } = setup(rail);
  const stuck = svc.proposeYieldDeposit({ chain: 'arb', symbol: 'USDC', amount: 1 });
  void stuck.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 100));

  const started = Date.now();
  await svc.proposeConsolidate({ toChain: 'arb', symbol: 'USDC', maxTotalUsd: 100 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `propose took ${elapsed}ms behind a hung rail`);

  releaseRail();
  await stuck.catch(() => undefined);
});

test('and the cap still holds: the reservation is on disk before the next caller reads it', async () => {
  let releaseRail = (): void => {};
  const hung = new Promise<void>((r) => (releaseRail = r));
  const rail: Rail = {
    kind: 'yield_deposit',
    valueUsd: () => 1,
    simulate: async () => ({ ok: true, summary: 'fine' }),
    execute: async () => {
      await hung;
      return { ok: true, detail: 'eventually' };
    },
  } as unknown as Rail;

  const { svc } = setup(rail);
  const stuck = svc.proposeYieldDeposit({ chain: 'arb', symbol: 'USDC', amount: 250 });
  void stuck.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 100));

  // The whole point of cutting the lock where it is cut: the row is already `executing`, so the
  // spend the next caller reads includes it even though the rail has not answered.
  const spent = svc.sessionSpentUsd();
  assert.ok(spent > 0, 'a proposal mid rail is committed money and must count against the cap');
  assert.equal(svc.list().some((p) => p.status === 'executing'), true);

  releaseRail();
  await stuck.catch(() => undefined);
});
