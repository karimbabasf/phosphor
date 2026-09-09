// The rolling 24 hour cap, as a number a person can read.
//
// It was in `sentences` as prose and nowhere as a figure, so the window could say what the rule
// was and not how much of it was left. Three properties:
//
//   It survives a restart. That is not a new mechanism: the spend has always been derived from
//   proposals.json rather than held in memory. What made it fragile was the FILE, and both
//   failures are closed elsewhere (a durable write in src/fsatomic.ts, and a refusal to read a
//   damaged file as empty in src/store.ts). This is the read that depends on them, so it is
//   asserted across a real second Store against the same directory.
//
//   The number on screen is the number the engine budgets on. Two derivations of one figure
//   would let the screen and the refusal disagree, which is the worst version of this feature.
//
//   `needs_reconciliation` counts only when it carries a transaction hash. A hash is evidence
//   that funds left the wallet; a row with none is the app not knowing, and a row it cannot
//   speak for must not hold a day's budget hostage.

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
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import type { AppConfig, LedgerSnapshot, Policy, Proposal, ProposalService, ProposalStatus, RiskRow } from '../../src/types.ts';

const RISK_ROWS: RiskRow[] = [{ symbol: 'USDC', issuer: 'Circle', freezable: true, tier: 'A' } as unknown as RiskRow];
const DAY_MS = 24 * 60 * 60 * 1000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-daily-'));
}

function serviceOn(dir: string, policy?: Policy): ProposalService {
  if (policy === undefined) {
    const p = defaultPolicy();
    p.sentences = renderSentences(p);
    savePolicy(dir, p);
  }
  const cfg = {
    mode: 'demo',
    dataDir: dir,
    port: 0,
    keysPath: path.join(dir, 'keys.json'),
    addresses: { evm: ['0x1111111111111111111111111111111111111111'], solana: [], near: [] },
    economicTransferUsd: 5,
    candleProducts: ['BTC-USD'],
  } as unknown as AppConfig;
  return createProposalService({
    cfg,
    audit: createAudit(dir),
    store: createStore(dir),
    ledger: createLedger(cfg),
    riskRows: RISK_ROWS,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir: dir,
  });
}

/* A live-mode ledger over the demo fixture, so the signer path runs with no RPC. Same shape as
   the one in proposals.test.ts and for the same reason. */
function liveLedgerOn(_dir: string): Ledger {
  const snap: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  return {
    snapshot: () => snap,
    intents: () => undefined,
    refresh: async () => snap,
    applyDemoTransfer: () => {
      throw new Error('applyDemoTransfer must never be called in live mode');
    },
  };
}

// The demo fixture's NEAR account holds $0.003 against the default $0.50 gas floor, so the
// shipped policy refuses to move its USDT at all. The floors go, and nothing else does.
function permissivePolicy(): Policy {
  const p = defaultPolicy();
  p.composition.minNativeGasUsd = {};
  p.sentences = renderSentences(p);
  return p;
}

// Written straight to the store, so the fixture states the row rather than the route that made it.
function spend(dir: string, id: string, usd: number, status: ProposalStatus, agoMs = 0, txids?: string[]): void {
  const at = new Date(Date.now() - agoMs).toISOString();
  createStore(dir).put({
    ...(txids === undefined ? {} : { result: { ok: false, detail: 'part done', txids } }),
    id,
    kind: 'intents_deposit',
    createdAt: at,
    decidedAt: at,
    decidedBy: 'policy',
    status,
    draft: {
      kind: 'intents_deposit',
      chain: 'arb',
      symbol: 'USDC',
      amount: usd,
      amountUsd: usd,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
    } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'allow', reasons: ['under the click threshold'] },
  });
}

test('an empty history spends nothing and has nothing to reset', () => {
  const svc = serviceOn(tmpDir());
  const limit = svc.dailyLimit(25_000);
  assert.deepEqual(limit, { capUsd: 25_000, spentUsd: 0, resetsAt: null });
});

test('the figure on screen is the figure the engine budgets on', () => {
  const dir = tmpDir();
  const svc = serviceOn(dir);
  spend(dir, 'a', 400, 'executed');
  spend(dir, 'b', 100, 'executing');
  assert.equal(svc.dailyLimit(25_000).spentUsd, svc.sessionSpentUsd());
  assert.equal(svc.dailyLimit(25_000).spentUsd, 500);
});

test('it survives a restart, because it was never in memory', () => {
  const dir = tmpDir();
  serviceOn(dir);
  spend(dir, 'a', 750, 'executed');

  // A second service over the same directory: what a restart actually is.
  const restarted = serviceOn(dir);
  assert.equal(restarted.dailyLimit(25_000).spentUsd, 750);
});

test('a spend older than the window has left it', () => {
  const dir = tmpDir();
  const svc = serviceOn(dir);
  spend(dir, 'old', 900, 'executed', DAY_MS + 60_000);
  spend(dir, 'new', 100, 'executed', 60_000);
  assert.equal(svc.dailyLimit(25_000).spentUsd, 100);
});

test('resetsAt is when the oldest counted spend leaves the window, not midnight', () => {
  const dir = tmpDir();
  const svc = serviceOn(dir);
  const sixHoursAgo = 6 * 60 * 60 * 1000;
  spend(dir, 'older', 100, 'executed', sixHoursAgo);
  spend(dir, 'newer', 100, 'executed', 60_000);

  const at = Date.parse(svc.dailyLimit(25_000).resetsAt ?? '');
  const expected = Date.now() - sixHoursAgo + DAY_MS;
  assert.ok(Math.abs(at - expected) < 5_000, 'capacity returns 18 hours from now, not at the end of the day');
});

test('a proposal the app cannot say moved money does not hold the budget', () => {
  const dir = tmpDir();
  const svc = serviceOn(dir);
  spend(dir, 'unknown', 5_000, 'executing');
  assert.equal(svc.dailyLimit(25_000).spentUsd, 5_000, 'executing counts: it is committed money');

  svc.reconcileOnBoot();
  assert.equal(svc.dailyLimit(25_000).spentUsd, 0, 'and an unknown outcome does not, for a whole day');
  assert.equal(svc.dailyLimit(25_000).resetsAt, null);
});

test('a policy change is not a spend, whatever it decides', () => {
  const dir = tmpDir();
  const svc = serviceOn(dir);
  createStore(dir).put({
    id: 'policy',
    kind: 'policy_change',
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    status: 'executed',
    draft: { kind: 'policy_change', patch: {}, sentence: 'raise the cap' } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
  });
  assert.equal(svc.dailyLimit(25_000).spentUsd, 0);
});

test('refused and pending proposals are not spends', () => {
  const dir = tmpDir();
  const svc = serviceOn(dir);
  spend(dir, 'a', 100, 'pending');
  spend(dir, 'b', 100, 'refused');
  spend(dir, 'c', 100, 'policy_refused');
  spend(dir, 'd', 100, 'failed');
  assert.equal(svc.dailyLimit(25_000).spentUsd, 0);
});

test('the cap comes from the caller, so the screen and the policy cannot drift', () => {
  const svc = serviceOn(tmpDir());
  assert.equal(svc.dailyLimit(1_234).capUsd, 1_234);
});

// ---------- the unlock queue and the cap, together ----------
//
// Custody queues a write made while the wallet was locked as `pending_unlock`, and releases the
// whole queue through one serialise() call on unlock. Reliability cut that queue short at the
// reservation and made the cap a number on the state payload. The two meet here: releasing N
// proposals at once is N things that may spend, and they have to meet the SAME cap one at a time
// rather than each reading the spend as it stood before any of them ran.
//
// The queued proposals are built through the real propose path and then moved to
// `pending_unlock`, rather than written by hand. A hand-built draft has to satisfy the whole of
// the engine's contract (sane leg numbers, a quote per leg, a destination it recognises) and a
// fixture that drifts from that contract tests the fixture.

function capPolicy(dir: string, clickAboveUsd: number, sessionUsd: number): Policy {
  const policy = defaultPolicy();
  policy.outbound.maxPerTransactionUsd = 10_000;
  policy.outbound.maxPerSessionUsd = sessionUsd;
  policy.outbound.humanClickAboveUsd = clickAboveUsd;
  policy.sentences = renderSentences(policy);
  savePolicy(dir, policy);
  return policy;
}

test('a released queue is decided one at a time against one cap, not all against zero', async () => {
  const dir = tmpDir();
  // Nothing may execute on its own while these are being made, so each lands pending.
  capPolicy(dir, 0, 100_000);
  const svc = serviceOn(dir, defaultPolicy());

  const made = [
    await svc.proposeConsolidate({ toChain: 'arb', symbol: 'USDC', maxTotalUsd: 4_000 }),
    await svc.proposeConsolidate({ toChain: 'base', symbol: 'USDC', maxTotalUsd: 4_000 }),
    await svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDC', maxTotalUsd: 4_000 }),
  ];
  assert.deepEqual(made.map(p => p.status), ['pending', 'pending', 'pending']);

  // What custody writes when the wallet is locked while an agent proposes.
  const store = createStore(dir);
  for (const p of made) store.put({ ...store.get(p.id) as Proposal, status: 'pending_unlock' });
  assert.equal(svc.dailyLimit(5_000).spentUsd, 0, 'a queued proposal has not spent anything yet');

  /* The unlock, with room for ONE of them. The policy is rewritten first on purpose: a queued
     proposal is re-evaluated against the rules as they stand at unlock rather than replayed
     against the rules it was made under, which is custody's own design and is what makes the
     cap below the one that binds. */
  capPolicy(dir, 9_000, 5_000);
  const released = await svc.releaseQueued();
  assert.equal(released, 3, 'every queued proposal is decided');
  assert.equal(svc.list().filter(p => p.status === 'pending_unlock').length, 0, 'nothing is left queued');

  /* All three come out PENDING, and none of them has spent anything. An unlock releases a batch,
     and a batch is not what the click threshold is a claim about: the threshold says how much
     money one action may move without a person, and three of them running together on one
     keystroke is a different question. See releaseQueued in src/proposals/lifecycle.ts.
     The cap still binds, one at a time, at the point the money actually moves, which is the
     click. That is what the rest of this test drives. */
  assert.equal(svc.list().filter(p => p.status === 'pending').length, 3);
  assert.equal(svc.dailyLimit(5_000).spentUsd, 0, 'typing a password spends nothing');

  // Three clicks arriving together, which is the race the serialiser exists for.
  await Promise.all(made.map(p => svc.approve(p.id).catch(() => undefined)));

  const after = svc.dailyLimit(5_000);
  assert.ok(after.spentUsd <= after.capUsd, `spent ${after.spentUsd} against a cap of ${after.capUsd}`);

  // Only the statuses that COUNT against the cap. A refusal is the right outcome for the ones
  // that did not fit, and counting refusals would pass whatever the cap did.
  const spent = svc.list().filter(p => p.status === 'executed' || p.status === 'executing');
  assert.equal(spent.length, 1, `one fits the cap, ${spent.length} spent: ${svc.list().map(p => p.status).join(', ')}`);
  assert.equal(svc.list().filter(p => p.status === 'policy_refused').length, 2, 'and the rest are refused, not run');
});


// ---------- a send that half worked ----------
//
// Three legs totalling $3,000 and a gas shortfall on the third: the first two broadcast, their
// hashes were recorded, and the row was written `failed`. `failed` charges nothing, so $2,000
// left the wallet against a budget that recorded $0, and the agent's retry was evaluated against
// a cap that had forgotten it. The honest state for that row is needs_reconciliation, which the
// human can re-check against the chain, and it counts.

test('a send that partly succeeded lands as an unknown outcome rather than a failure', async () => {
  const dir = tmpDir();
  let sent = 0;
  const svc = createProposalService({
    cfg: {
      mode: 'live',
      dataDir: dir,
      port: 0,
      keysPath: path.join(dir, 'keys.json'),
      addresses: { evm: ['0x1111111111111111111111111111111111111111'], solana: [], near: [] },
      economicTransferUsd: 5,
      candleProducts: ['BTC-USD'],
    } as unknown as AppConfig,
    audit: createAudit(dir),
    store: createStore(dir),
    ledger: liveLedgerOn(dir),
    riskRows: RISK_ROWS,
    quoter: syntheticQuoter(),
    // The first leg broadcasts, the second one does not.
    signer: {
      ready: true,
      describe: () => 'one leg then a gas shortfall',
      async send() {
        sent += 1;
        return sent === 1 ? { ok: true, txid: '0xleg1' } : { ok: false, error: 'not enough gas on that chain' };
      },
    },
    dataDir: dir,
  });
  savePolicy(dir, permissivePolicy());

  const p = await svc.proposeConsolidate({ toChain: 'eth', symbol: 'USDC' });
  assert.ok(p.draft.kind === 'consolidate' && p.draft.legs.length > 1, 'this needs more than one leg to mean anything');
  const done = p.status === 'pending' ? await svc.approve(p.id) : p;

  assert.equal(done.status, 'needs_reconciliation', 'money left on one leg, so this is not a failure');
  assert.deepEqual(done.result?.txids, ['0xleg1']);
  assert.ok(svc.sessionSpentUsd() > 0, 'and the dollars that left are charged against the day');
  assert.equal(svc.dailyLimit(25_000).spentUsd, svc.sessionSpentUsd(), 'screen and engine agree, as always');
});

test('a stranded row with no hash still holds none of the budget', () => {
  const dir = tmpDir();
  const svc = serviceOn(dir);
  spend(dir, 'moved', 300, 'needs_reconciliation', 0, ['0xhash']);
  spend(dir, 'unknown', 900, 'needs_reconciliation', 0, []);
  assert.equal(svc.sessionSpentUsd(), 300, 'the hash is evidence; the absence of one is not');
  assert.equal(svc.dailyLimit(25_000).spentUsd, 300);
});
