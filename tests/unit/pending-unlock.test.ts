// What an agent's proposal does while the wallet is locked, and what happens to it after.
//
// Decision 6 in the v1 spec, in one sentence: nothing is refused. The proposal is drafted,
// priced, simulated and ruled on exactly as it would be with the wallet open, and then it
// waits. Refusing instead would throw away the agent's whole turn and would teach the owner
// that locking the app breaks their assistant, which is how a lock ends up switched off.
//
// The second half matters as much: the queue is RE-DECIDED at unlock, not replayed. Hours can
// pass, and a rule the owner tightened in between has to bind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, Policy, RiskRow } from '../../src/types.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const PASSWORD = 'a long enough password';

function happyPolicy(): Policy {
  const p = defaultPolicy();
  delete p.composition.minNativeGasUsd.near;
  p.sentences = renderSentences(p);
  return p;
}

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

function setup(policy: Policy = happyPolicy()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-queued-'));
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const cfg: AppConfig = {
    mode: 'demo',
    keysPath,
    port: 4177,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: [],
    dataDir,
  };
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const ledger = createLedger(cfg);
  savePolicy(dataDir, policy);
  const keystore = createKeystore({ keysPath, kdf: fast });
  useKeystore(keystore);
  const svc = createProposalService({ cfg, audit, store, ledger, riskRows, quoter: syntheticQuoter(), signer: stubSigner(), dataDir });
  return { dataDir, cfg, audit, store, svc, keystore };
}

test.afterEach(() => {
  useKeystore(null);
});

// A consolidation small enough to be auto-approved with the wallet open. It is the case that
// matters most: with no lock it EXECUTES with nobody clicking, so a queue that let it through
// would be money moving with no key and no person.
async function smallMove(h: ReturnType<typeof setup>) {
  return await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: 50 });
}

test('a proposal authored while locked is queued, not refused', async () => {
  const h = setup();
  await h.keystore.create(PASSWORD);
  h.keystore.lock();

  const p = await smallMove(h);
  assert.equal(p.status, 'pending_unlock');
  // It was ruled on: the verdict is real, and the simulation happened.
  assert.equal(p.verdict.outcome, 'allow', 'the engine still decided, it simply could not sign');
  assert.notEqual(p.simulation, null);

  const messages = h.audit.tail(50).map((e) => e.msg);
  assert.ok(messages.some((m) => m.includes('waiting for the wallet to be unlocked')), 'the log says why it is waiting');
  assert.ok(!messages.some((m) => m.includes('refused')), 'nothing was refused');
});

test('unlocking releases the queue and the small one executes', async () => {
  const h = setup();
  await h.keystore.create(PASSWORD);
  h.keystore.lock();

  const queued = await smallMove(h);
  assert.equal(h.store.get(queued.id)?.status, 'pending_unlock');

  assert.equal((await h.keystore.unlock(PASSWORD)).ok, true);
  const released = await h.svc.releaseQueued();
  assert.equal(released, 1);
  assert.equal(h.store.get(queued.id)?.status, 'executed');
});

test('a large one released by unlock lands pending, waiting for a click as it always would', async () => {
  const h = setup();
  await h.keystore.create(PASSWORD);
  h.keystore.lock();

  // Above the $100 click threshold in the default policy.
  const queued = await h.svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDT', maxTotalUsd: 5000 });
  assert.equal(queued.status, 'pending_unlock');
  assert.equal(queued.verdict.outcome, 'needs_approval');

  await h.keystore.unlock(PASSWORD);
  await h.svc.releaseQueued();
  assert.equal(h.store.get(queued.id)?.status, 'pending', 'it waits for the human, not for the lock');
});

test('the queue is re-decided against the policy as it stands at unlock, not as it stood then', async () => {
  const h = setup();
  await h.keystore.create(PASSWORD);
  h.keystore.lock();

  const queued = await smallMove(h);
  assert.equal(queued.verdict.outcome, 'allow', 'it would have executed on its own');

  // The owner tightens the rule while the app is locked, which is exactly the window in which
  // somebody who has just been away decides they want to see everything.
  const stricter = happyPolicy();
  stricter.outbound.humanClickAboveUsd = 1;
  stricter.sentences = renderSentences(stricter);
  savePolicy(h.dataDir, stricter);

  await h.keystore.unlock(PASSWORD);
  await h.svc.releaseQueued();
  assert.equal(h.store.get(queued.id)?.status, 'pending', 'the newer rule binds');
});

test('the kill switch flipped while locked refuses the queue on release', async () => {
  const h = setup();
  await h.keystore.create(PASSWORD);
  h.keystore.lock();
  const queued = await smallMove(h);

  const killed = happyPolicy();
  killed.killSwitch = true;
  killed.sentences = renderSentences(killed);
  savePolicy(h.dataDir, killed);

  await h.keystore.unlock(PASSWORD);
  await h.svc.releaseQueued();
  assert.equal(h.store.get(queued.id)?.status, 'policy_refused');
});

test('several queued proposals are released oldest first', async () => {
  const h = setup();
  await h.keystore.create(PASSWORD);
  h.keystore.lock();

  const first = await smallMove(h);
  const second = await smallMove(h);
  const third = await smallMove(h);

  await h.keystore.unlock(PASSWORD);
  assert.equal(await h.svc.releaseQueued(), 3);

  const decided = h.audit
    .tail(200)
    .reverse()
    .filter((e) => e.msg.includes('was re-decided after the wallet was unlocked'))
    .map((e) => (e.data as { id: string }).id);
  assert.deepEqual(decided, [first.id, second.id, third.id], 'the order the agent asked in');
});

test('releasing with nothing queued is a no-op', async () => {
  const h = setup();
  await h.keystore.create(PASSWORD);
  assert.equal(await h.svc.releaseQueued(), 0);
  assert.equal(await h.svc.releaseQueued(), 0);
});

test('with the wallet unlocked nothing is queued at all', async () => {
  const h = setup();
  await h.keystore.create(PASSWORD);
  const p = await smallMove(h);
  assert.equal(p.status, 'executed', 'the lock is the only thing that queues');
});

test('an install that has never had a keystore is not treated as locked', async () => {
  // needs_migration and no_wallet both mean "there is no lock in the way". Queuing there would
  // strand every proposal on an install that has not migrated yet.
  const h = setup();
  assert.equal(h.keystore.state(), 'no_wallet');
  const p = await smallMove(h);
  assert.notEqual(p.status, 'pending_unlock');
});
