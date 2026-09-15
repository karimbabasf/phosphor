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
import { hlDepositCredited } from '../../src/proposals/reconcile.ts';
import type { AppConfig, Proposal, ProposalService, ProposalStatus, RiskRow } from '../../src/types.ts';

const RISK_ROWS: RiskRow[] = [{ symbol: 'USDC', issuer: 'Circle', freezable: true, tier: 'A' } as unknown as RiskRow];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-oneclick-'));
}

function statusOf(over: Partial<OneClickStatus>): OneClickStatus {
  return { found: true, status: 'PROCESSING', reported: '', originTxHashes: [], destinationTxHashes: [], nearTxHashes: [], ...over };
}

type Harness = { svc: ProposalService; dir: string; asked: string[] };

// `venueCredited` is the Hyperliquid account read a deposit needs on top of 1Click's word;
// absent means the app has none wired, which is every test not about a deposit.
function setup(
  answer: OneClickStatus | ((handle: string) => OneClickStatus),
  wireClient = true,
  venueCredited?: (p: Proposal) => Promise<boolean>,
): Harness {
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
    ...(venueCredited === undefined ? {} : { venueCredited }),
  });
  return { svc, dir, asked };
}

const shown = async (): Promise<boolean> => true;
const flat = async (): Promise<boolean> => false;

// A row of a kind 1Click's word settles on its own: the swap lands inside the verifier, and the
// venue that reports SUCCESS is the venue that holds the money.
const SWAP: Partial<Proposal> = {
  kind: 'swap',
  draft: { kind: 'swap', venue: 'oneclick', chain: 'arb', toChain: 'arb', fromSymbol: 'USDC', toSymbol: 'WETH', amountIn: 10, amountUsd: 10 } as unknown as Proposal['draft'],
};

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
  seed(h.dir, SWAP);
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'executed');
  assert.equal(out.result?.ok, true);
  assert.match(out.result?.detail ?? '', /9\.97/);
  assert.deepEqual(h.asked, ['dep-1']);
});

/* 1CLICK'S WORD IS NOT THE VENUE'S. For a Hyperliquid deposit, SUCCESS means the solver delivered
   to the bridge; the account shows the credit some time later, and the rail's own settle step
   had already found it had not (the "has not shown" sentence on the row). The sweep used to
   overwrite that observation with the promise ten minutes later and write executed, ok true. */
test('a Hyperliquid deposit 1Click calls SUCCESS stays unconfirmed until the account shows the credit, and the detail carries both facts', async () => {
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }), true, flat);
  seed(h.dir, {
    result: {
      ok: false,
      detail: '1click reported SUCCESS for 9.97 USDC, but the venue has not shown it; intent h1, quote handle dep-1. The venue had not shown the credit on either side within 60s.',
      txids: ['intent-h1'],
      evidence: { handle: 'dep-1' },
    },
  });
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'needs_reconciliation', 'the venue has not shown it, so 1Click alone does not settle it');
  assert.equal(out.result?.ok, false);
  assert.match(out.result?.detail ?? '', /9\.97/, 'what 1Click settled is on the row');
  assert.match(out.result?.detail ?? '', /has not shown the credit/, 'and so is the account not showing it');
  assert.equal(out.result?.evidence?.settledAmountOut, '9.97', 'the venue facts are merged into the evidence');
  assert.equal(out.result?.evidence?.handle, 'dep-1');
});

test('the same deposit settles to executed once the account shows the rise', async () => {
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }), true, shown);
  seed(h.dir);
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'executed');
  assert.equal(out.result?.ok, true);
  assert.match(out.result?.detail ?? '', /9\.97/);
  assert.match(out.result?.detail ?? '', /shows the credit/);
});

test('with no venue read wired, a deposit 1Click calls SUCCESS is left unconfirmed for a person', async () => {
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }));
  seed(h.dir);
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.match(out.result?.detail ?? '', /no venue read/);
});

test('any row whose rail wrote that the venue had not shown the money waits for the venue the same way', async () => {
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }), true, flat);
  seed(h.dir, { ...SWAP, result: { ok: false, detail: '1click reported SUCCESS but the venue has not shown it; quote handle dep-1.', txids: ['h1'], evidence: { handle: 'dep-1' } } });
  const out = await h.svc.reconcile('oc-1');
  assert.equal(out.status, 'needs_reconciliation');
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
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }), true, shown);
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
  const h = setup((handle) => statusOf(handle === 'dep-win' ? { status: 'SUCCESS', settledAmountOut: '5' } : { status: 'PROCESSING' }), true, shown);
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
  }, true, shown);
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
  const h = setup(statusOf({ status: 'SUCCESS', settledAmountOut: '9.97' }), true, shown);
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

/* The venue read main.ts wires, over the account's ledger of credits. A balance comparison cannot
   answer "did this deposit land" after the fact, so the question is whether the account has been
   credited, since just before this row was decided, with at least what every deposit decided since
   then was promised. One credit for two deposits vouches for neither. */
test('hlDepositCredited asks for every deposit promised since this row, so a second deposit cannot vouch for the first', async () => {
  const t0 = Date.now() - 120_000;
  const ACCOUNT = '0x2222222222222222222222222222222222222222';
  const row = (id: string, decidedAt: number, status: ProposalStatus, minCredited: number, account = ACCOUNT): Proposal => ({
    id,
    kind: 'hl_deposit',
    createdAt: new Date(decidedAt).toISOString(),
    decidedAt: new Date(decidedAt).toISOString(),
    status,
    draft: { kind: 'hl_deposit', symbol: 'USDC', amount: 10, amountUsd: 10, minCredited, hlAccount: account } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
  });
  const first = row('d1', t0, 'needs_reconciliation', 9.9);
  const second = row('d2', t0 + 1_000, 'executed', 9.9);
  const rows = [
    first,
    second,
    row('d0', t0 - 600_000, 'executed', 50), // long settled, not in the window
    row('d3', t0 + 2_000, 'failed', 9.9), // nothing left the wallet, so nothing is owed
    row('d4', t0 + 3_000, 'needs_reconciliation', 9.9, '0x3333333333333333333333333333333333333333'), // another account
  ];
  const asked: Array<{ account: string; since: number }> = [];
  const vouches = (seen: number) =>
    hlDepositCredited({
      credited: async (account, since) => {
        asked.push({ account, since });
        return seen;
      },
      rows: () => rows,
    });

  assert.equal(await vouches(9.97)(first), false, 'one credit for two deposits leaves the first unconfirmed');
  assert.deepEqual(asked[0], { account: ACCOUNT, since: t0 - 60_000 }, 'asked from a minute before the row was decided');
  assert.equal(await vouches(9.97)(second), false, 'and the second: the credit could be either');
  assert.equal(await vouches(19.94)(first), true, 'both credits show, so both settle');
  assert.equal(await vouches(19.94)(second), true);

  const offline = hlDepositCredited({
    credited: async () => {
      throw new Error('ledger offline');
    },
    rows: () => rows,
  });
  assert.equal(await offline(first), false, 'a ledger that will not answer is not shown');
  assert.equal(await vouches(1_000)({ ...first, ...SWAP } as Proposal), false, 'only a deposit has an account to read');
});
