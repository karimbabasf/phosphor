// The basic screen after a fill. Karim, 2026-09-14: "when a trade happens, basic mode doesnt
// update the balance". The hero read "checking your new balance" in the balance type and never
// stopped, because the ledger stamped chainStatus.fetchedAt once at boot and every refresh
// carried the stamp forward, so from the first fill after boot the read was older than the
// execution for the life of the process. These tests play a fill through the real proposal
// service on the demo ledger and read the frame the way src/http/state.ts builds it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, ChainStatus, RiskRow } from '../../src/types.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { createLedger } from '../../src/ledger/index.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';
import { buildWallet } from '../../src/wallet.ts';
import { buildBasic } from '../../src/view/basic.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function newestStamp(status: Record<string, ChainStatus>): number {
  return Math.max(...Object.values(status).map((s) => Date.parse(s.fetchedAt)));
}

function cfgFor(mode: AppConfig['mode'], dataDir: string): AppConfig {
  return {
    mode,
    keysPath: path.join(dataDir, 'no-keys.json'),
    port: 4177,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: [],
    dataDir,
  };
}

// The frame the way src/http/state.ts assembles it, minus the parts a fill does not touch.
function frame(ledger: Ledger, proposals: ReturnType<typeof createStore>) {
  const snapshot = ledger.snapshot();
  return buildBasic({
    wallet: buildWallet(snapshot, ledger.intents(), ledger.hyperliquid()),
    proposals: proposals.list(),
    policyReadable: true,
    killSwitch: false,
    agentsConnected: 1,
    chainStatus: snapshot.chainStatus,
    selfAddresses: [],
    prices: [],
    events: [],
  });
}

test('a fill in demo mode leaves the basic frame with a total, not a waiting sentence', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-after-fill-'));
  const cfg = cfgFor('demo', dataDir);
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const ledger = createLedger(cfg);
  // The click threshold is well above the move, so the policy lands it on its own, exactly as
  // the sub-threshold path does in the app.
  const policy = defaultPolicy();
  policy.outbound.humanClickAboveUsd = 100;
  savePolicy(dataDir, policy);
  const svc = createProposalService({ cfg, audit, store, ledger, riskRows, quoter: syntheticQuoter(), signer: stubSigner(), dataDir });

  const before = frame(ledger, store);
  assert.equal(before.checkingLine, null);
  assert.ok(typeof before.totalUsd === 'number' && before.totalUsd > 0);

  // A stamp taken in the same millisecond as the fill would hide the bug, so the clock moves.
  await sleep(5);
  const started = await svc.proposeConsolidate({ toChain: 'arb', symbol: 'USDC', maxTotalUsd: 40 });
  const executed = await svc.settled(started.id, 5000);
  assert.equal(executed.status, 'executed', JSON.stringify(executed.verdict));

  const after = frame(ledger, store);
  assert.equal(after.checkingLine, null, 'the read after the fill counts it');
  assert.ok(typeof after.totalUsd === 'number', 'the total is stated as fact again');
  assert.match(after.totalLine, /^\$[\d,]+\.\d\d$/, 'the hero slot holds a number and never a sentence');
  assert.match(after.headline, /^Done\. You now have \$/);
  assert.ok(newestStamp(ledger.snapshot().chainStatus) >= Date.parse(executed.decidedAt ?? ''), 'the ledger was read after the decision');
});

test('the demo ledger re-stamps its read on every refresh', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-after-fill-'));
  const ledger = createLedger(cfgFor('demo', dataDir));
  const first = newestStamp(ledger.snapshot().chainStatus);
  await sleep(5);
  await ledger.refresh();
  assert.ok(newestStamp(ledger.snapshot().chainStatus) > first);
});

test('the live ledger stamps the read when it starts, and again on every refresh', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-after-fill-'));
  // No key on disk, so the verifier and the venue are not read; a fetch that fails after a
  // pause stands in for the price reads and makes the start and the end of a refresh distinct.
  const slowOffline = (async () => {
    await sleep(60);
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const ledger = createLedger(cfgFor('live', dataDir), { fetchImpl: slowOffline });
  const first = newestStamp(ledger.snapshot().chainStatus);
  await sleep(5);

  const started = Date.now();
  await ledger.refresh();
  const stamp = newestStamp(ledger.snapshot().chainStatus);
  assert.ok(stamp > first, 'the stamp moved');
  assert.ok(stamp >= started, 'the stamp is not older than the refresh');
  // Taken before the reads, not after: a read that started before a fill can only carry the
  // balance from before it, whatever the clock said when the answer came back.
  assert.ok(stamp < started + 30, `the stamp is the start of the refresh, not its end (${stamp - started} ms in)`);

  await sleep(5);
  await ledger.refresh();
  assert.ok(newestStamp(ledger.snapshot().chainStatus) > stamp, 'and it moves again on the next pass');
});
