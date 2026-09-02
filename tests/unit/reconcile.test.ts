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
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';
import { chainsOf, looksLikeEvmHash } from '../../src/proposals/reconcile.ts';
import type { TxState } from '../../src/proposals/reconcile.ts';
import type { AppConfig, ChainId, Proposal, ProposalService, RiskRow } from '../../src/types.ts';

const HASH_A = '0x' + 'a'.repeat(64);
const HASH_B = '0x' + 'b'.repeat(64);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-reconcile-'));
}

const RISK_ROWS: RiskRow[] = [{ symbol: 'USDC', issuer: 'Circle', freezable: true, tier: 'A' } as unknown as RiskRow];

type Harness = { svc: ProposalService; dir: string; asked: Array<{ chain: ChainId; hash: string }> };

function setup(lookup: Record<string, TxState> = {}): Harness {
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
    economicTransferUsd: 5,
    candleProducts: ['BTC-USD'],
  } as unknown as AppConfig;

  const asked: Array<{ chain: ChainId; hash: string }> = [];
  const svc = createProposalService({
    cfg,
    audit,
    store,
    ledger: createLedger(cfg),
    riskRows: RISK_ROWS,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir: dir,
    txLookup: async (chain, hash) => {
      asked.push({ chain, hash });
      return lookup[`${chain}:${hash}`] ?? lookup[hash] ?? 'absent';
    },
  });
  void loadDemoLedger; // the demo ledger is loaded by createLedger in demo mode
  return { svc, dir, asked };
}

// Written straight to the store, which is what a killed process leaves behind: the row was
// persisted as `executing` and the answer never arrived.
function strand(dir: string, over: Partial<Proposal> = {}): Proposal {
  const store = createStore(dir);
  const p: Proposal = {
    id: over.id ?? 'stranded-1',
    kind: 'intents_deposit',
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

test('a confirmed hash reconciles to executed', async () => {
  const { svc, dir, asked } = setup({ [`arb:${HASH_A}`]: 'confirmed' });
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A] } });
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'executed');
  assert.equal(out.result?.ok, true);
  assert.match(out.result?.detail ?? '', /confirmed on chain/);
  // Only the chain the draft names is asked. Guessing across every chain would report a
  // definite "absent" for chains this transaction was never on.
  assert.deepEqual(asked, [{ chain: 'arb', hash: HASH_A }]);
});

test('a reverted hash reconciles to failed and says the chain rejected it', async () => {
  const { svc, dir } = setup({ [`arb:${HASH_A}`]: 'reverted' });
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A] } });
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'failed');
  assert.match(out.result?.detail ?? '', /the chain rejected/);
});

test('a hash that is not on chain at all reconciles to failed: nothing was sent', async () => {
  const { svc, dir } = setup({ [`arb:${HASH_A}`]: 'absent' });
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A] } });
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'failed');
  assert.match(out.result?.detail ?? '', /nothing was sent/);
});

test('a hash still in the mempool stays unreconciled and says to check again', async () => {
  const { svc, dir } = setup({ [`arb:${HASH_A}`]: 'pending' });
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A] } });
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /not yet included in a block/);
});

test('a chain this app cannot read never reports absent', async () => {
  const { svc, dir } = setup({ [`arb:${HASH_A}`]: 'unknown' });
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A] } });
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /block explorer by hand/);
});

test('one confirmed and one missing hash is reported as part done, not as success', async () => {
  const { svc, dir } = setup({ [`arb:${HASH_A}`]: 'confirmed', [`arb:${HASH_B}`]: 'absent' });
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A, HASH_B] } });
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /part done/);
});

test('with no hash to look up, reconcile changes nothing and says why', async () => {
  const { svc, dir, asked } = setup();
  strand(dir);
  svc.reconcileOnBoot();

  const out = await svc.reconcile('stranded-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /nothing to look up on chain/);
  assert.deepEqual(asked, []);
});

test('reconcile refuses any proposal that is not waiting to be reconciled', async () => {
  const { svc, dir } = setup();
  strand(dir, { id: 'p', status: 'pending' });
  await assert.rejects(() => svc.reconcile('p'), /only a proposal waiting to be reconciled/);
  await assert.rejects(() => svc.reconcile('nope'), /unknown proposal/);
});

test('a lookup that throws reads as unknown rather than as absent', async () => {
  const { svc, dir } = setup();
  strand(dir, { result: { ok: false, detail: 'mid flight', txids: [HASH_A] } });
  svc.reconcileOnBoot();
  // Rebuild the service with a lookup that fails the way an RPC outage does.
  const store = createStore(dir);
  const audit = createAudit(dir);
  const cfg = { mode: 'demo', dataDir: dir, port: 0, keysPath: path.join(dir, 'keys.json'), addresses: { evm: [], solana: [], near: [] }, economicTransferUsd: 5, candleProducts: ['BTC-USD'] } as unknown as AppConfig;
  const svc2 = createProposalService({
    cfg,
    audit,
    store,
    ledger: createLedger(cfg),
    riskRows: RISK_ROWS,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir: dir,
    txLookup: async () => {
      throw new Error('RPC unreachable');
    },
  });
  const out = await svc2.reconcile('stranded-1');
  assert.equal(out.status, 'needs_reconciliation', 'an outage is not evidence that nothing sent');
});

test('chainsOf reads the origin chain the draft actually names', () => {
  assert.deepEqual(chainsOf({ kind: 'intents_deposit', chain: 'base' } as never), ['base']);
  assert.deepEqual(chainsOf({ kind: 'policy_change' } as never), []);
  assert.deepEqual(
    chainsOf({ kind: 'consolidate', legs: [{ fromChain: 'arb' }, { fromChain: 'sol' }, { fromChain: 'arb' }] } as never),
    ['arb', 'sol'],
  );
});

test('only a 32-byte hex string is treated as an EVM hash', () => {
  assert.equal(looksLikeEvmHash(HASH_A), true);
  assert.equal(looksLikeEvmHash('5xY9NEARorSolanaBase58Hash'), false);
  assert.equal(looksLikeEvmHash('0xdeadbeef'), false);
});


/* The receipt a person most wants a number on is the one for a row the app could not say had
   moved money, now confirmed on chain. It kept `afterUsd: null` off the boot sweep, so the answer
   to "what did that leave me with" was "unknown" for exactly that case. */
test('a row reconciled to executed reports the balance it left behind', async () => {
  const h = setup({ [`arb:${HASH_A}`]: 'confirmed' });
  strand(h.dir, { id: 'r-after', result: { ok: false, detail: 'mid flight', txids: [HASH_A] }, balances: { beforeUsd: 1234, afterUsd: null } });
  h.svc.reconcileOnBoot();

  const out = await h.svc.reconcile('r-after');

  assert.equal(out.status, 'executed');
  assert.equal(out.balances?.beforeUsd, 1234, 'the before is the one recorded at the time');
  assert.equal(typeof out.balances?.afterUsd, 'number', 'and the after is read now rather than left blank');
});

test('a row reconciled to something other than executed invents no balance', async () => {
  const h = setup({ [`arb:${HASH_A}`]: 'absent' });
  strand(h.dir, { id: 'r-reverted', result: { ok: false, detail: 'mid flight', txids: [HASH_A] }, balances: { beforeUsd: 1234, afterUsd: null } });
  h.svc.reconcileOnBoot();

  const out = await h.svc.reconcile('r-reverted');

  assert.notEqual(out.status, 'executed');
  assert.equal(out.balances?.afterUsd, null, 'a blank is better than a number nothing supports');
});
