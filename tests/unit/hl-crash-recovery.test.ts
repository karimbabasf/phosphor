// kill -9 at every stage of a Hyperliquid move, then boot: nothing is lost and nothing is
// signed twice (criterion 4.1, one test per stage).
//
// Each test seeds the store with the row exactly as the executor had written it when the
// process died (src/proposals/execute.ts persists every hook the rail makes before its wait),
// boots the service the way src/main.ts does (reconcileOnBoot, then the 1Click sweep), feeds
// it the venue's later word and the ledger's later read, and checks three things: the row is
// still there with every hash, handle and nonce it had; the rail was never run again; and the
// row ends where the design says, confirmed only once the venue or the verifier shows the money.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, LedgerSnapshot, Policy, Proposal, Rail, RiskRow, WriteDraft } from '../../src/types.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import type { HlRead } from '../../src/ledger/hyperliquid.ts';
import type { IntentsHolding } from '../../src/ledger/intents.ts';
import type { OneClickStatus } from '../../src/intents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { createProposalService } from '../../src/proposals.ts';
import { hlDepositCredited } from '../../src/proposals/reconcile.ts';
import { venueAllowlist } from '../../src/rails/index.ts';
import { HYPERCORE_COUNTERPARTY, HYPERCORE_USDC_ASSET_ID, HYPERCORE_USDC_DECIMALS, minCreditedFor } from '../../src/rails/hypercore-deposit.ts';
import { HL_WITHDRAW_COUNTERPARTY, INTENTS_USDC_ASSET_ID, INTENTS_USDC_DECIMALS, SETTLING_WITHDRAW, minReceivedForHlWithdraw } from '../../src/rails/hypercore-withdraw.ts';
import { STAGE_LABEL } from '../../src/proposals/view.ts';
import { makeCtx, slowRail } from './helpers/proposals.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(__dirname));
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

const SELF_EVM = '0x1111111111111111111111111111111111111111';
const ACCOUNT = SELF_EVM.toLowerCase();
const ETH_USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const HANDLE = '0xaf4fda3876a32301839734891c337da23184d954';
const NONCE = '1786600000000';
const DEPOSIT_AMOUNT = 10;
const WITHDRAW_AMOUNT = 8;

function seededPolicy(): Policy {
  const p = defaultPolicy();
  p.outbound.destinationAllowlist = venueAllowlist();
  p.sentences = renderSentences(p);
  return p;
}

function depositDraft(): WriteDraft {
  return {
    kind: 'hl_deposit',
    symbol: 'USDC',
    originAsset: ETH_USDC,
    amount: DEPOSIT_AMOUNT,
    amountUsd: DEPOSIT_AMOUNT,
    minCredited: minCreditedFor(DEPOSIT_AMOUNT),
    from: ACCOUNT,
    hlAccount: SELF_EVM,
    counterparty: HYPERCORE_COUNTERPARTY,
  };
}

function withdrawDraft(): WriteDraft {
  return {
    kind: 'hl_withdraw',
    symbol: 'USDC',
    amount: WITHDRAW_AMOUNT,
    amountUsd: WITHDRAW_AMOUNT,
    minReceived: minReceivedForHlWithdraw(WITHDRAW_AMOUNT),
    from: SELF_EVM,
    to: ACCOUNT,
    counterparty: HL_WITHDRAW_COUNTERPARTY,
  };
}

const depositFloorBase = BigInt(Math.round(minCreditedFor(DEPOSIT_AMOUNT) * 10 ** HYPERCORE_USDC_DECIMALS)).toString();
const withdrawFloorBase = BigInt(Math.round(minReceivedForHlWithdraw(WITHDRAW_AMOUNT) * 10 ** INTENTS_USDC_DECIMALS)).toString();

const depositPocket = { venue: 'hyperliquid' as const, account: ACCOUNT, assetId: HYPERCORE_USDC_ASSET_ID, symbol: 'USDC', decimals: HYPERCORE_USDC_DECIMALS, before: '0', after: null, floor: depositFloorBase };
const withdrawPocket = { venue: 'intents' as const, account: ACCOUNT, assetId: INTENTS_USDC_ASSET_ID, symbol: 'USDC', decimals: INTENTS_USDC_DECIMALS, before: '0', after: null, floor: withdrawFloorBase };

// The row as the executor had written it at the moment the process died.
function rowAt(kind: 'hl_deposit' | 'hl_withdraw', over: Partial<Proposal>): Proposal {
  const decidedAt = new Date(Date.now() - 20_000).toISOString();
  return {
    id: `crash-${kind}`,
    kind,
    createdAt: decidedAt,
    status: 'executing',
    draft: kind === 'hl_deposit' ? depositDraft() : withdrawDraft(),
    simulation: { ok: true, summary: 'seeded' },
    verdict: kind === 'hl_deposit' ? { outcome: 'allow', reasons: ['under the click threshold'] } : { outcome: 'needs_approval', reasons: ['always a click'] },
    decidedBy: kind === 'hl_deposit' ? 'policy' : 'human',
    decidedAt,
    ...over,
  };
}

/* The ledger as the booted app reads it, with the two venue reads the test moves by hand: the
   Hyperliquid account's free USDC and the verifier's USDC balance. */
function fakeLedger(): Ledger & { hl: number; intentsUsdc: string; credited: number } {
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const listeners = new Set<() => void>();
  const ledger = {
    hl: 0,
    intentsUsdc: '0',
    credited: 0,
    snapshot: () => snapshot,
    intents: () => ({
      ok: true,
      fetchedAt: new Date().toISOString(),
      holdings: [
        { accountId: ACCOUNT, assetId: ETH_USDC, symbol: 'USDC', originChain: 'eth', amount: 100, amountBase: '100000000', decimals: 6 },
        { accountId: ACCOUNT, assetId: INTENTS_USDC_ASSET_ID, symbol: 'USDC', originChain: 'near', amount: Number(ledger.intentsUsdc) / 1e6, amountBase: ledger.intentsUsdc, decimals: 6 },
      ] as IntentsHolding[],
    }),
    hyperliquid: (): HlRead => ({ ok: true, fetchedAt: new Date().toISOString(), account: ACCOUNT, collateralUsdc: ledger.hl, availableUsdc: ledger.hl, marginUsedUsd: 0, openPositions: 0, unified: true }),
    refresh: async () => {
      for (const fn of listeners) fn();
      return snapshot;
    },
    onRefresh: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return ledger;
}

type Boot = {
  svc: ReturnType<typeof createProposalService>;
  ledger: ReturnType<typeof fakeLedger>;
  executed: number;
  asked: string[];
  venue: { status: OneClickStatus['status'] };
  store: ReturnType<typeof createStore>;
};

/* Boot the app over a store that holds the seeded row: the boot sweep first, the way main.ts
   runs it before the port opens. The rails count their executions and answer nothing else,
   because a boot must never reach them for a row it found on disk. `demo` boots the way
   main.ts does in demo mode: no 1Click client, so no venue lookup for the sweep. */
function boot(seed: Proposal, over: { demo?: boolean } = {}): Boot {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-hl-crash-'));
  const cfg: AppConfig = { mode: over.demo ? 'demo' : 'live', port: 4177, addresses: { evm: SELF_EVM }, candleProducts: [], dataDir, keysPath: path.join(dataDir, 'keys.json') };
  savePolicy(dataDir, seededPolicy());
  const store = createStore(dataDir);
  store.put(seed);
  const audit = createAudit(dataDir);
  const ledger = fakeLedger();
  const out = { executed: 0, asked: [] as string[], venue: { status: 'PROCESSING' as OneClickStatus['status'] }, ledger, store } as Boot;
  const rail = (kind: 'hl_deposit' | 'hl_withdraw'): Rail => ({
    kind,
    valueUsd: () => 0,
    simulate: async () => ({ ok: true, summary: 'never' }),
    execute: async () => {
      out.executed += 1;
      throw new Error('the rail must never run for a row found on disk');
    },
  });
  const rails = new Map<string, Rail>([
    ['hl_deposit', rail('hl_deposit')],
    ['hl_withdraw', rail('hl_withdraw')],
  ]);
  const svc = createProposalService({
    cfg,
    audit,
    store,
    ledger,
    riskRows,
    rails: { for: (d) => rails.get(d.kind) ?? null, kinds: () => ['hl_deposit', 'hl_withdraw'] },
    dataDir,
    ...(over.demo
      ? {}
      : {
          oneClickStatus: async (handle: string) => {
            out.asked.push(handle);
            return { found: true, status: out.venue.status, reported: out.venue.status, originTxHashes: [], destinationTxHashes: ['0xdest'], nearTxHashes: [], ...(out.venue.status === 'SUCCESS' ? { settledAmountOut: '9.66' } : {}) };
          },
        }),
    venueCredited: hlDepositCredited({ credited: async () => ledger.credited, rows: () => store.list() }),
  });
  out.svc = svc;
  svc.reconcileOnBoot();
  return out;
}

function assertKept(before: Proposal, after: Proposal): void {
  assert.ok(after !== undefined, 'the row survived the boot');
  for (const hash of before.result?.txids ?? []) assert.ok(after.result?.txids?.includes(hash), `hash ${hash} kept`);
  const was = before.result?.evidence ?? {};
  const now = after.result?.evidence ?? {};
  for (const key of ['handle', 'nonce', 'quote'] as const) {
    if (was[key] !== undefined) assert.deepEqual(now[key], was[key], `${key} kept`);
  }
  if (before.pocket !== undefined) assert.equal(after.pocket?.before, before.pocket.before, 'the pocket kept its before');
}

// ---------- hl_deposit ----------

test('deposit, killed at Signing: the click was taken and the executing row never written; boot leaves it unconfirmed, nothing signed', () => {
  const seed = rowAt('hl_deposit', { status: 'approved' });
  const b = boot(seed);
  const row = b.svc.get(seed.id) as Proposal;
  assert.equal(row.status, 'needs_reconciliation');
  assert.match(row.result?.detail ?? '', /may or may not have sent/);
  assert.equal(b.executed, 0);
  assert.equal(b.svc.view(row).stage, 'crediting');
});

test('deposit, killed at Sending it: the intent was signed, the handle is on the row, the hash is not yet; boot keeps the handle and the sweep asks 1Click by it', async () => {
  const seed = rowAt('hl_deposit', {
    result: { ok: false, detail: 'submitted, waiting for the venue', txids: [], evidence: { handle: HANDLE, deadline: '2026-09-24T00:00:00.000Z' } },
  });
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  assert.equal(booted.status, 'needs_reconciliation');
  assertKept(seed, booted);
  b.venue.status = 'PENDING_DEPOSIT';
  await b.svc.reconcileOpen();
  assert.deepEqual(b.asked, [HANDLE]);
  const later = b.svc.get(seed.id) as Proposal;
  assert.equal(later.status, 'needs_reconciliation');
  assert.equal(b.svc.view(later).stage, 'crediting');
  assert.equal(b.executed, 0);
});

test('deposit, killed at Deposit seen: hash and handle kept; a later SUCCESS confirms only once the venue ledger shows the credit', async () => {
  const seed = rowAt('hl_deposit', {
    result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['0xintent'], evidence: { handle: HANDLE, providerStage: 'KNOWN_DEPOSIT_TX' } },
  });
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  assertKept(seed, booted);
  assert.equal(b.svc.view(booted).stage, 'KNOWN_DEPOSIT_TX');
  assert.equal(b.svc.view(booted).stageLabel, STAGE_LABEL.KNOWN_DEPOSIT_TX);

  b.venue.status = 'SUCCESS';
  await b.svc.reconcileOpen();
  const heard = b.svc.get(seed.id) as Proposal;
  assert.equal(heard.status, 'needs_reconciliation', 'SUCCESS alone never confirms a deposit');
  assert.match(heard.result?.detail ?? '', /has not shown the credit/);

  b.ledger.credited = minCreditedFor(DEPOSIT_AMOUNT);
  await b.svc.reconcileOpen();
  const done = b.svc.get(seed.id) as Proposal;
  assert.equal(done.status, 'executed');
  assert.equal(b.svc.view(done).stage, 'confirmed');
  assertKept(seed, done);
  assert.equal(b.executed, 0);
});

test('deposit, killed at On its way: the row resumes at PROCESSING, and only the credit confirms it', async () => {
  const seed = rowAt('hl_deposit', {
    result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['0xintent'], evidence: { handle: HANDLE, providerStage: 'PROCESSING' } },
  });
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  assert.equal(b.svc.view(booted).stage, 'PROCESSING');
  await b.svc.reconcileOpen();
  assert.equal(b.svc.get(seed.id)?.status, 'needs_reconciliation');
  b.venue.status = 'SUCCESS';
  b.ledger.credited = minCreditedFor(DEPOSIT_AMOUNT);
  await b.svc.reconcileOpen();
  const done = b.svc.get(seed.id) as Proposal;
  assert.equal(done.status, 'executed');
  assertKept(seed, done);
  assert.equal(b.executed, 0);
});

test('deposit, killed at Waiting for the venue to credit it: the settling row with its pocket is left for the balance, and the next read that shows the rise settles it', async () => {
  const seed = rowAt('hl_deposit', {
    status: 'needs_reconciliation',
    settledAt: new Date().toISOString(),
    result: { ok: false, detail: 'The venue has not shown it yet', txids: ['0xintent', '0xdest'], evidence: { handle: HANDLE, providerStage: 'SUCCESS' } },
    pocket: depositPocket,
  });
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  assert.equal(booted.status, 'needs_reconciliation', 'boot leaves a settling row exactly as it was');
  assert.equal(b.svc.view(booted).stage, 'crediting');
  assertKept(seed, booted);

  await b.ledger.refresh();
  assert.equal(b.svc.get(seed.id)?.status, 'needs_reconciliation', 'a read with no rise changes nothing');

  b.ledger.hl = minCreditedFor(DEPOSIT_AMOUNT);
  await b.ledger.refresh();
  const done = b.svc.get(seed.id) as Proposal;
  assert.equal(done.status, 'executed');
  assert.equal(b.svc.view(done).stage, 'confirmed');
  assert.equal(done.pocket?.after, BigInt(Math.round(minCreditedFor(DEPOSIT_AMOUNT) * 10 ** HYPERCORE_USDC_DECIMALS)).toString());
  assert.equal(b.executed, 0);
});

test('deposit, killed while Late: the stalled row keeps its stamp and its evidence, reads "Late, nothing has changed", and still settles forward on a credit', async () => {
  const seed = rowAt('hl_deposit', {
    status: 'needs_reconciliation',
    stalledAt: new Date().toISOString(),
    result: { ok: false, detail: 'The venue has not shown it yet', txids: ['0xintent'], evidence: { handle: HANDLE, providerStage: 'SUCCESS' } },
    pocket: depositPocket,
  });
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  const view = b.svc.view(booted);
  assert.equal(view.stage, 'stalled');
  assert.equal(view.stageLabel, 'Late, nothing has changed');
  assert.equal(view.error?.code, 'deadline_passed');
  assertKept(seed, booted);
  b.ledger.hl = minCreditedFor(DEPOSIT_AMOUNT);
  await b.ledger.refresh();
  assert.equal(b.svc.get(seed.id)?.status, 'executed');
  assert.equal(b.executed, 0);
});

// ---------- hl_withdraw ----------

test('withdraw, killed at Signing: the approved row becomes unconfirmed with no evidence, and the rail is not run again', () => {
  const seed = rowAt('hl_withdraw', { status: 'approved' });
  const b = boot(seed);
  const row = b.svc.get(seed.id) as Proposal;
  assert.equal(row.status, 'needs_reconciliation');
  assert.equal(row.result?.txids?.length ?? 0, 0);
  assert.equal(b.executed, 0);
});

/* The withdraw row as the executor really writes it at "Sending it", produced by the executor
   rather than typed here: a live service runs a rail that makes the withdraw rail's first tell
   (the handle, the nonce, the signed quote and the intents pocket, hypercore-withdraw.ts
   execute, pinned by hypercore-withdraw.test.ts "the first word to the row carries the intents
   pocket") through runRail's onEvidence (src/proposals/execute.ts), and then the process dies
   with the rail still inside its watch loop. What is on disk at that moment is the seed. */
async function withdrawRowAtSendingIt(): Promise<Proposal> {
  const slow = slowRail('hl_withdraw');
  const h = makeCtx({ rails: [slow.rail] });
  const filed = await h.svc.proposeHlWithdraw({ amount: WITHDRAW_AMOUNT });
  assert.equal(filed.status, 'pending', 'a withdrawal always waits for the click');
  await h.svc.approve(filed.id);
  await slow.started();
  const hooks = slow.hooks();
  assert.ok(hooks?.onEvidence !== undefined, 'the executor handed the rail no hooks');
  hooks.onEvidence({ handle: HANDLE, nonce: NONCE, quote: { correlationId: 'c-1', timestamp: '2026-09-20T00:00:00.000Z', signature: 'ed25519:sig', depositAddress: HANDLE }, pocket: withdrawPocket });
  const row = h.store.get(filed.id) as Proposal;
  assert.equal(row.status, 'executing');
  return row;
}

test('withdraw, killed at Sending it: the send was signed and its nonce is on the row; boot keeps the nonce, the sweep asks 1Click, and SUCCESS waits for the verifier', async () => {
  const seed = await withdrawRowAtSendingIt();
  assert.equal(seed.result?.evidence?.nonce, NONCE);
  assert.deepEqual(seed.pocket, withdrawPocket, 'the executor wrote the pocket with the first word, before the wait');
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  assert.equal(booted.status, 'needs_reconciliation');
  assert.equal(booted.result?.evidence?.nonce, NONCE, 'the nonce is the identity of the send and the only thing a retry may reuse');
  assertKept(seed, booted);

  b.venue.status = 'SUCCESS';
  await b.svc.reconcileOpen();
  const heard = b.svc.get(seed.id) as Proposal;
  assert.equal(heard.status, 'needs_reconciliation', 'SUCCESS alone never confirms a withdrawal');
  assert.equal(b.svc.view(heard).stage, 'crediting');

  b.ledger.intentsUsdc = withdrawFloorBase;
  await b.ledger.refresh();
  const done = b.svc.get(seed.id) as Proposal;
  assert.equal(done.status, 'executed');
  assertKept(seed, done);
  assert.equal(b.executed, 0);
});

/* A row with evidence and no pocket is what the executor wrote at "Sending it" until the pocket
   rode with the first word, and the sweep then confirmed it on 1Click's SUCCESS alone with the
   verifier balance still at zero (review L1, 2026-09-20). No rail writes such a row now; one
   from before, or one with the pocket lost, stays unconfirmed with its nonce. */
test('withdraw, killed while polling on a row with no pocket: SUCCESS alone never confirms it, and it stays unconfirmed with its nonce', async () => {
  const seed = rowAt('hl_withdraw', {
    result: { ok: false, detail: 'submitted, waiting for the venue', txids: [], evidence: { handle: HANDLE, nonce: NONCE, providerStage: 'PROCESSING' } },
  });
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  assert.equal(booted.status, 'needs_reconciliation');
  assert.equal(booted.pocket, undefined);
  b.venue.status = 'SUCCESS';
  await b.svc.reconcileOpen();
  const heard = b.svc.get(seed.id) as Proposal;
  assert.equal(heard.status, 'needs_reconciliation', 'SUCCESS alone must not confirm a withdrawal');
  assert.equal(heard.result?.ok, false);
  assert.equal(heard.result?.evidence?.nonce, NONCE, 'the nonce stays for a later question to the venue');
  assert.match(heard.result?.detail ?? '', /cannot confirm the credit on its own/);
  assert.notEqual(b.svc.view(heard).stage, 'confirmed');
  // A sweep that hears SUCCESS again writes nothing new and still confirms nothing.
  await b.svc.reconcileOpen();
  assert.equal(b.svc.get(seed.id)?.status, 'needs_reconciliation');
  assert.equal(b.executed, 0);

  // The same row with the rail's settling sentence on it ("has not shown"), which used to route a
  // withdrawal to the deposit's venue read and hold it open with a sentence about depositing.
  const settling = rowAt('hl_withdraw', {
    id: 'crash-hl_withdraw-settling-nopocket',
    status: 'needs_reconciliation',
    settledAt: new Date().toISOString(),
    result: { ok: false, detail: `${SETTLING_WITHDRAW} sent 8 USDC`, txids: ['0xledgerhash'], evidence: { handle: HANDLE, nonce: NONCE, providerStage: 'SUCCESS' } },
  });
  const c = boot(settling);
  c.venue.status = 'SUCCESS';
  await c.svc.reconcileOpen();
  const kept = c.svc.get(settling.id) as Proposal;
  assert.equal(kept.status, 'needs_reconciliation');
  assert.match(kept.result?.detail ?? '', /cannot confirm the credit on its own/);
  assert.doesNotMatch(kept.result?.detail ?? '', /before depositing again/, "a withdrawal never takes the deposit's venue read");
  assert.equal(kept.result?.evidence?.nonce, NONCE);
  assert.equal(c.executed, 0);
});

/* Demo mode builds no 1Click client, so the sweep has no venue lookup, and it wrote "No venue
   handle was recorded for <hash>" over a demo row that carried one (report-b request 3). The
   demo walk dies with the process and keeps no status a reader could answer from, so the honest
   sentence is that the lookup is missing, with the handle the row has named in it. */
test('withdraw, killed mid-walk in demo mode: the sweep names the handle it has and never claims none was recorded', async () => {
  const seed = rowAt('hl_withdraw', {
    result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['0xdemohash'], evidence: { handle: 'demo-a1b2c3d4e5f6', nonce: NONCE, providerStage: 'PROCESSING' } },
  });
  const b = boot(seed, { demo: true });
  const booted = b.svc.get(seed.id) as Proposal;
  assert.equal(booted.status, 'needs_reconciliation');
  await b.svc.reconcileOpen();
  const swept = b.svc.get(seed.id) as Proposal;
  assert.equal(swept.status, 'needs_reconciliation');
  assert.equal(b.asked.length, 0, 'there is no venue to ask in demo mode');
  const clicked = await b.svc.reconcile(seed.id);
  assert.equal(clicked.status, 'needs_reconciliation');
  assert.match(clicked.result?.detail ?? '', /No venue lookup is wired in demo mode, so the handle demo-a1b2c3d4e5f6 cannot be re-checked here/);
  assert.doesNotMatch(clicked.result?.detail ?? '', /No venue handle was recorded/);
  assert.equal(clicked.result?.evidence?.handle, 'demo-a1b2c3d4e5f6', 'the handle stays on the row');
  assert.equal(clicked.result?.evidence?.nonce, NONCE);
  assert.deepEqual(clicked.result?.txids, ['0xdemohash']);
  assert.equal(b.executed, 0);
});

test('withdraw, killed at Deposit seen: the ledger hash, handle and nonce survive, and the row resumes at the word 1Click last said', async () => {
  const seed = rowAt('hl_withdraw', {
    result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['0xledgerhash'], evidence: { handle: HANDLE, nonce: NONCE, providerStage: 'KNOWN_DEPOSIT_TX' } },
    pocket: withdrawPocket,
  });
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  assert.equal(b.svc.view(booted).stage, 'KNOWN_DEPOSIT_TX');
  assertKept(seed, booted);
  b.venue.status = 'PROCESSING';
  await b.svc.reconcileOpen();
  const later = b.svc.get(seed.id) as Proposal;
  assert.equal(later.status, 'needs_reconciliation');
  assert.equal(later.result?.evidence?.nonce, NONCE);
  assert.equal(b.executed, 0);
});

test('withdraw, killed at On its way: PROCESSING resumes, then SUCCESS plus the verifier showing the floor confirms it', async () => {
  const seed = rowAt('hl_withdraw', {
    result: { ok: false, detail: 'submitted, waiting for the venue', txids: ['0xledgerhash'], evidence: { handle: HANDLE, nonce: NONCE, providerStage: 'PROCESSING' } },
    pocket: withdrawPocket,
  });
  const b = boot(seed);
  assert.equal(b.svc.view(b.svc.get(seed.id) as Proposal).stage, 'PROCESSING');
  b.venue.status = 'SUCCESS';
  await b.svc.reconcileOpen();
  assert.equal(b.svc.get(seed.id)?.status, 'needs_reconciliation');
  b.ledger.intentsUsdc = withdrawFloorBase;
  await b.ledger.refresh();
  const done = b.svc.get(seed.id) as Proposal;
  assert.equal(done.status, 'executed');
  assert.equal(b.svc.view(done).stage, 'confirmed');
  assertKept(seed, done);
  assert.equal(b.executed, 0);
});

test('withdraw, killed at Waiting for the venue to credit it: the settling row is judged by the verifier balance and by nothing else', async () => {
  const seed = rowAt('hl_withdraw', {
    status: 'needs_reconciliation',
    settledAt: new Date().toISOString(),
    result: { ok: false, detail: `${SETTLING_WITHDRAW} sent 8 USDC`, txids: ['0xledgerhash', '0xdest'], evidence: { handle: HANDLE, nonce: NONCE, providerStage: 'SUCCESS' } },
    pocket: withdrawPocket,
  });
  const b = boot(seed);
  const booted = b.svc.get(seed.id) as Proposal;
  assert.equal(booted.status, 'needs_reconciliation');
  assert.equal(b.svc.view(booted).stage, 'crediting');
  assert.equal(b.svc.view(booted).waitingOn, 'NEAR Intents');
  // Even a sweep that hears SUCCESS again leaves it to the balance.
  b.venue.status = 'SUCCESS';
  await b.svc.reconcileOpen();
  assert.equal(b.svc.get(seed.id)?.status, 'needs_reconciliation');
  b.ledger.intentsUsdc = withdrawFloorBase;
  await b.ledger.refresh();
  const done = b.svc.get(seed.id) as Proposal;
  assert.equal(done.status, 'executed');
  assert.equal(done.pocket?.after, withdrawFloorBase);
  assertKept(seed, done);
  assert.equal(b.executed, 0);
});

test('withdraw, killed while Late: the stalled row reads late with its nonce and hash, and a credit still settles it forward', async () => {
  const seed = rowAt('hl_withdraw', {
    status: 'needs_reconciliation',
    stalledAt: new Date().toISOString(),
    result: { ok: false, detail: `${SETTLING_WITHDRAW} sent 8 USDC`, txids: ['0xledgerhash'], evidence: { handle: HANDLE, nonce: NONCE, providerStage: 'PROCESSING' } },
    pocket: withdrawPocket,
  });
  const b = boot(seed);
  const view = b.svc.view(b.svc.get(seed.id) as Proposal);
  assert.equal(view.stage, 'stalled');
  assert.equal(view.stageLabel, 'Late, nothing has changed');
  assert.equal(view.txs[0]?.hash, '0xledgerhash');
  assert.equal(view.txs[0]?.leg, 'origin');
  b.ledger.intentsUsdc = withdrawFloorBase;
  await b.ledger.refresh();
  assert.equal(b.svc.get(seed.id)?.status, 'executed');
  assert.equal(b.executed, 0);
});
