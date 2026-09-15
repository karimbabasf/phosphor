// Reconcile asks 1Click by the quote handle, and the sweep runs it on its own.
//
// A 1Click swap settles on NEAR for an INTENTS order, which the chain lookup answers `unknown`
// for, so the handle the rail recorded is the only thing that can tell a SUCCESS from a refund.
// The mappings here are the four the operator and the human read: settled, refunded, still
// failing, and not yet decided. The sweep is what makes it happen without a human pressing
// Reconcile, and the boot sweep now also rescues an `approved` or `awaiting_touch` row a dead
// process left behind.

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
import type { OneClickStatus } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';
import type { AppConfig, Proposal, ProposalService, ProposalStatus, RiskRow } from '../../src/types.ts';

const RISK_ROWS: RiskRow[] = [{ symbol: 'USDC', issuer: 'Circle', freezable: true, tier: 'A' } as unknown as RiskRow];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-oneclick-'));
}

function statusOf(over: Partial<OneClickStatus>): OneClickStatus {
  return { found: true, status: 'PROCESSING', reported: '', originTxHashes: [], destinationTxHashes: [], ...over };
}

type Harness = { svc: ProposalService; dir: string; asked: string[] };

function setup(answer: OneClickStatus | ((handle: string) => OneClickStatus), wireClient = true): Harness {
  const dir = tmpDir();
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
  const asked: string[] = [];
  const svc = createProposalService({
    cfg,
    audit: createAudit(dir),
    store: createStore(dir),
    ledger: createLedger(cfg),
    riskRows: RISK_ROWS,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir: dir,
    ...(wireClient
      ? {
          oneClickStatus: async (handle: string) => {
            asked.push(handle);
            return typeof answer === 'function' ? answer(handle) : answer;
          },
        }
      : {}),
  });
  return { svc, dir, asked };
}

// Written straight to the store, the state a rail left with its handle recorded.
function seed(dir: string, over: Partial<Proposal> = {}): Proposal {
  const store = createStore(dir);
  const p: Proposal = {
    id: over.id ?? 'oc-1',
    kind: 'hl_deposit',
    createdAt: new Date().toISOString(),
    status: 'needs_reconciliation',
    draft: { kind: 'hl_deposit', symbol: 'USDC', amount: 10, amountUsd: 10 } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'allow', reasons: ['under the click threshold'] },
    decidedBy: 'policy',
    decidedAt: new Date().toISOString(),
    result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['intent-h1'], evidence: { handle: 'dep-1' } },
    ...over,
  };
  store.put(p);
  return p;
}

test('SUCCESS reconciles to executed with the settled amount', async () => {
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }));
  seed(h.dir);
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'executed');
  assert.equal(out.result?.ok, true);
  assert.match(out.result?.detail ?? '', /9\.97/);
  assert.deepEqual(h.asked, ['dep-1']);
});

test('REFUNDED reconciles to failed and names the amount that went back', async () => {
  const h = setup(statusOf({ status: 'REFUNDED', refundedAmount: '9.90' }));
  seed(h.dir);
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'failed');
  assert.match(out.result?.detail ?? '', /REFUNDED: 9\.90/);
});

test('FAILED stays needs_reconciliation and says the input is held under the handle', async () => {
  const h = setup(statusOf({ status: 'FAILED', refundedAmount: '0', refundReason: 'SLIPPAGE' }));
  seed(h.dir);
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /refunded 0 so far/);
  assert.match(out.result?.detail ?? '', /reason SLIPPAGE/);
  assert.match(out.result?.detail ?? '', /held by 1Click under handle dep-1/);
});

test('FAILED with no refund reason says "not given"', async () => {
  const h = setup(statusOf({ status: 'FAILED' }));
  seed(h.dir);
  const out = await h.svc.reconcile('oc-1');
  assert.match(out.result?.detail ?? '', /refunded 0 so far/);
  assert.match(out.result?.detail ?? '', /reason not given/);
});

test('a status that is not terminal leaves the row and says what it is waiting on', async () => {
  const h = setup(statusOf({ status: 'PROCESSING' }));
  seed(h.dir);
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /PROCESSING/);
});

test('a failed row that carries a handle can still be re-checked, and 1Click can settle it', async () => {
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }));
  seed(h.dir, { id: 'oc-failed', status: 'failed', result: { ok: false, detail: 'timed out', txids: ['h'], evidence: { handle: 'dep-2' } } });
  const out = await h.svc.reconcile('oc-failed');
  assert.equal(out.status, 'executed');
});

test('with no handle on the row, reconcile falls back to the chain and never asks 1Click', async () => {
  const h = setup(statusOf({ status: 'SUCCESS' }));
  seed(h.dir, { id: 'oc-nohandle', result: { ok: false, detail: 'mid flight', txids: ['0x' + 'a'.repeat(64)] } });
  await h.svc.reconcile('oc-nohandle');
  assert.deepEqual(h.asked, [], '1Click was asked about a row with no handle');
});

test('the sweep re-checks every open handled row and reports how many changed', async () => {
  const h = setup((handle) => statusOf(handle === 'dep-win' ? { status: 'SUCCESS', settledAmountOut: '5' } : { status: 'PROCESSING' }));
  seed(h.dir, { id: 'a', result: { ok: false, detail: 'x', txids: ['h1'], evidence: { handle: 'dep-win' } } });
  seed(h.dir, { id: 'b', result: { ok: false, detail: 'x', txids: ['h2'], evidence: { handle: 'dep-wait' } } });
  seed(h.dir, { id: 'c', status: 'executed', result: { ok: true, detail: 'done', txids: ['h3'], evidence: { handle: 'dep-done' } } });
  const changed = await h.svc.reconcileOpen();
  assert.equal(changed, 1, 'only the one that settled changed');
  assert.equal(h.svc.get('a')?.status, 'executed');
  assert.equal(h.svc.get('b')?.status, 'needs_reconciliation');
  assert.ok(!h.asked.includes('dep-done'), 'an executed row is settled and is not re-asked');
});

test('one order that throws does not stop the sweep reaching the next', async () => {
  const h = setup((handle) => {
    if (handle === 'dep-bad') throw new Error('1click 500');
    return statusOf({ status: 'SUCCESS', settledAmountOut: '5' });
  });
  seed(h.dir, { id: 'a', result: { ok: false, detail: 'x', txids: ['h1'], evidence: { handle: 'dep-bad' } } });
  seed(h.dir, { id: 'b', result: { ok: false, detail: 'x', txids: ['h2'], evidence: { handle: 'dep-ok' } } });
  const changed = await h.svc.reconcileOpen();
  assert.equal(changed, 1);
  assert.equal(h.svc.get('b')?.status, 'executed');
});

test('the sweep does nothing when no 1Click client is wired', async () => {
  const h = setup(statusOf({ status: 'SUCCESS' }), false);
  seed(h.dir, { result: { ok: false, detail: 'x', txids: ['h1'], evidence: { handle: 'dep-1' } } });
  assert.equal(await h.svc.reconcileOpen(), 0);
});

test('boot turns an approved row a dead process left into needs_reconciliation, and awaiting_touch back to pending', () => {
  const h = setup(statusOf({ status: 'PROCESSING' }));
  const seedStatus = (id: string, status: ProposalStatus): void => {
    seed(h.dir, { id, status, result: undefined });
  };
  seedStatus('was-approved', 'approved');
  seedStatus('was-touch', 'awaiting_touch');
  const moved = h.svc.reconcileOnBoot();
  const byId = new Map(moved.map((p) => [p.id, p.status]));
  assert.equal(byId.get('was-approved'), 'needs_reconciliation');
  assert.equal(byId.get('was-touch'), 'pending');
});

// A settle merges what the venue reported INTO the evidence; it never replaces it. The handle
// and the nonce are what a later question to the venue goes by, and a settle that dropped
// them would leave an executed row nobody could re-check.
test('settling by handle merges the venue facts into the evidence and keeps the handle and nonce', async () => {
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }));
  seed(h.dir, { result: { ok: false, detail: 'x', txids: ['intent-h1'], evidence: { handle: 'dep-1', nonce: '77', deadline: '2026-09-16T00:00:00.000Z' } } });
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'executed');
  assert.equal(out.result?.evidence?.handle, 'dep-1');
  assert.equal(out.result?.evidence?.nonce, '77');
  assert.equal(out.result?.evidence?.deadline, '2026-09-16T00:00:00.000Z');
  assert.equal(out.result?.evidence?.settledAmountOut, '9.97', 'what 1Click reported is merged in');
});

test('a FAILED re-check merges the refund facts into the evidence beside the handle', async () => {
  const h = setup(statusOf({ status: 'FAILED', refundedAmount: '0', refundReason: 'SLIPPAGE' }));
  seed(h.dir);
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.result?.evidence?.handle, 'dep-1');
  assert.equal(out.result?.evidence?.refundedAmount, '0');
  assert.equal(out.result?.evidence?.refundReason, 'SLIPPAGE');
});
