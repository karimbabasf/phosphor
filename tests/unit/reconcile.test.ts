// A proposal the app was in the middle of executing when the process died.
//
// Before this it stayed `executing` forever: unactionable, because requirePending refuses every
// verb on any status but pending, and expensive, because sessionSpentUsd counted it against the
// 24h cap for the whole window. One crash cost a day of spend budget and no screen said why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { createProposalService } from '../../src/proposals.ts';
import type { AppConfig, Proposal, ProposalService, RiskRow } from '../../src/types.ts';

const HASH_A = '0x' + 'a'.repeat(64);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-reconcile-'));
}

const RISK_ROWS: RiskRow[] = [{ symbol: 'USDC', issuer: 'Circle', freezable: true, tier: 'A' } as unknown as RiskRow];

type Harness = { svc: ProposalService; dir: string };

function setup(): Harness {
  const dir = tmpDir();
  const audit = createAudit(dir);
  const store = createStore(dir);
  const policy = defaultPolicy();
  policy.sentences = renderSentences(policy);
  savePolicy(dir, policy);

  const cfg = {
    mode: 'demo',
    dataDir: dir,
    port: 0,
    keysPath: path.join(dir, 'keys.json'),
    addresses: { evm: ['0x1111111111111111111111111111111111111111'], solana: [], near: [] },
    candleProducts: ['BTC-USD'],
  } as unknown as AppConfig;

  const svc = createProposalService({
    cfg,
    audit,
    store,
    ledger: createLedger(cfg),
    riskRows: RISK_ROWS,
    dataDir: dir,
  });
  void loadDemoLedger; // the demo ledger is loaded by createLedger in demo mode
  return { svc, dir };
}

// Written straight to the store, which is what a killed process leaves behind: the row was
// persisted as `executing` and the answer never arrived.
function strand(dir: string, over: Partial<Proposal> = {}): Proposal {
  const store = createStore(dir);
  const p: Proposal = {
    id: over.id ?? 'stranded-1',
    // A retired kind, the shape rows on disk still have.
    kind: 'intents_deposit' as unknown as Proposal['kind'],
    createdAt: new Date().toISOString(),
    status: 'executing',
    draft: {
      kind: 'intents_deposit',
      chain: 'arb',
      symbol: 'USDC',
      amount: 100,
      amountUsd: 100,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
    } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'allow', reasons: ['under the click threshold'] },
    decidedBy: 'policy',
    decidedAt: new Date().toISOString(),
    ...over,
  };
  store.put(p);
  return p;
}

test('boot turns an executing row into needs_reconciliation and says it may have sent', () => {
  const { svc, dir } = setup();
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A] } });

  const moved = svc.reconcileOnBoot();
  assert.equal(moved.length, 1);
  assert.equal(moved[0].status, 'needs_reconciliation');
  assert.deepEqual(moved[0].result?.txids, [HASH_A]);
  assert.match(moved[0].result?.detail ?? '', /may already have sent/);
});

test('a stranded row with no hash says it may or may not have sent', () => {
  const { svc, dir } = setup();
  strand(dir);
  const moved = svc.reconcileOnBoot();
  assert.match(moved[0].result?.detail ?? '', /may or may not have sent/);
  assert.deepEqual(moved[0].result?.txids, []);
});

test('a stranded row no longer holds the 24 hour spend cap', () => {
  const { svc, dir } = setup();
  strand(dir);
  assert.equal(svc.sessionSpentUsd(), 100, 'executing counts, which is what stops a concurrent double spend');
  svc.reconcileOnBoot();
  assert.equal(svc.sessionSpentUsd(), 0, 'a row that may not have sent must not eat the budget for a day');
});

test('boot leaves everything that is not executing alone', () => {
  const { svc, dir } = setup();
  strand(dir, { id: 'a', status: 'pending' });
  strand(dir, { id: 'b', status: 'executed' });
  strand(dir, { id: 'c', status: 'failed' });
  assert.deepEqual(svc.reconcileOnBoot(), []);
  assert.deepEqual(svc.list().map(p => p.status).sort(), ['executed', 'failed', 'pending']);
});

test('with no hash to look up, reconcile changes nothing and says why', async () => {
  const { svc, dir } = setup();
  strand(dir);
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /nothing to look up/);
});

// This app reads no chain of its own any more: a hash with no venue handle beside it is
// something a person looks up by hand, and the row says exactly that rather than guessing.
test('a hash with no venue handle is left where it was, named, with nothing invented', async () => {
  const { svc, dir } = setup();
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A], evidence: { nonce: '99' } } });
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /No venue handle was recorded/);
  assert.ok(out.result?.detail?.includes(HASH_A), 'the hash a person has to look up is named');
  assert.deepEqual(out.result?.txids, [HASH_A]);
  assert.equal(out.result?.evidence?.nonce, '99', 'the evidence the rail recorded stays');
  assert.equal(out.balances?.afterUsd, undefined, 'no balance is invented');
});

test('reconcile refuses any proposal that is not waiting to be reconciled', async () => {
  const { svc, dir } = setup();
  strand(dir, { id: 'p', status: 'pending' });
  await assert.rejects(() => svc.reconcile('p'), /only a proposal waiting to be reconciled/);
  await assert.rejects(() => svc.reconcile('nope'), /unknown proposal/);
});
