// Task B read stack: ledger (near/demo/index), composition, cost.
// Fixture-driven only; every fetchImpl here is a mock, no network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { AppConfig, RiskRow, TransferLeg } from '../../src/types.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { classify } from '../../src/composition.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8'),
).rows as RiskRow[];

const demoConfig: AppConfig = {
  mode: 'demo',
  keysPath: '/tmp/phosphor-test-keys.json',
  port: 4177,
  addresses: { evm: [], solana: [], near: [] },
  economicTransferUsd: 10,
  candleProducts: ['BTC-USD'],
  dataDir: 'state',
};

function closeTo(actual: number, expected: number, tolerance: number, msg?: string) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    msg ?? `expected ${actual} within ${tolerance} of ${expected}`,
  );
}

// ---------- demo.ts + composition.ts + cost.ts, against real data/*.json ----------

test('demo snapshot totals the fixture stable usd (re-derived: 49878.15, not the plan draft 49878.25 -- see task report)', () => {
  const snap = loadDemoLedger();
  const totalUsd = snap.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  closeTo(totalUsd, 49878.15, 0.01);
});

test('demo snapshot has all five chains ok and every ChainId present', () => {
  const snap = loadDemoLedger();
  for (const chain of ['eth', 'base', 'arb', 'sol', 'near'] as const) {
    assert.equal(snap.chainStatus[chain].ok, true);
  }
});

test('composition: Circle share is 0.5553 +- 0.001', () => {
  const snap = loadDemoLedger();
  const comp = classify(snap, riskRows);
  closeTo(comp.byIssuer['Circle'], 0.5553, 0.001);
});

test('composition: freezable share is >= 0.96', () => {
  const snap = loadDemoLedger();
  const comp = classify(snap, riskRows);
  assert.ok(comp.freezableShare >= 0.96, `freezableShare ${comp.freezableShare} should be >= 0.96`);
});

test('composition: XUSD is unclassified and counts as freezable (pessimistic default)', () => {
  const snap = loadDemoLedger();
  const comp = classify(snap, riskRows);
  assert.ok(comp.unclassified.includes('XUSD'));
  const xusdRow = comp.rows.find(r => r.symbol === 'XUSD' && r.chain === 'arb');
  assert.ok(xusdRow);
  assert.equal(xusdRow!.freezable, true);
  assert.equal(xusdRow!.classified, false);
  assert.equal(xusdRow!.issuer, 'unclassified');
});

test('composition: rows are sorted by share descending', () => {
  const snap = loadDemoLedger();
  const comp = classify(snap, riskRows);
  for (let i = 1; i < comp.rows.length; i++) {
    assert.ok(comp.rows[i - 1].share >= comp.rows[i].share);
  }
});

// ---------- ledger/index.ts: demo-mode wiring + applyDemoTransfer ----------

test('createLedger demo mode: snapshot matches loadDemoLedger totals', () => {
  const ledger = createLedger(demoConfig);
  const snap = ledger.snapshot();
  const totalUsd = snap.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  closeTo(totalUsd, 49878.15, 0.01);
  assert.equal(snap.mode, 'demo');
});

test('createLedger demo mode: refresh() resolves without changing balances', async () => {
  const ledger = createLedger(demoConfig);
  const before = ledger.snapshot();
  const after = await ledger.refresh();
  const totalBefore = before.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  const totalAfter = after.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  closeTo(totalAfter, totalBefore, 0.0001);
});

test('applyDemoTransfer moves balance from source chain to destination chain, net of gas', () => {
  const ledger = createLedger(demoConfig);
  const before = ledger.snapshot();
  const nearUsdtBefore = before.holdings.find(h => h.chain === 'near' && h.symbol === 'USDT')!.amount;
  const ethUsdtBefore = before.holdings.find(h => h.chain === 'eth' && h.symbol === 'USDT')!.amount;
  const nearNativeBefore = before.holdings.find(h => h.chain === 'near' && h.native)!.amount;

  const leg: TransferLeg = {
    fromChain: 'near',
    toChain: 'eth',
    symbol: 'USDT',
    amount: nearUsdtBefore,
    amountUsd: nearUsdtBefore,
    from: 'karim-demo.near',
    to: '0x1111111111111111111111111111111111111111',
    quote: { amountOut: 949.5, feeUsd: 0.5, timeEstimateSec: 8 },
    gasNativeUsd: before.gas.near.transferCostUsd,
  };
  ledger.applyDemoTransfer(leg);
  const after = ledger.snapshot();

  closeTo(after.holdings.find(h => h.chain === 'near' && h.symbol === 'USDT')!.amount, 0, 1e-9);
  closeTo(
    after.holdings.find(h => h.chain === 'eth' && h.symbol === 'USDT')!.amount,
    ethUsdtBefore + 949.5,
    1e-9,
  );
  assert.ok(after.holdings.find(h => h.chain === 'near' && h.native)!.amount < nearNativeBefore);
});

// ---------- ledger/index.ts: live mode failure handling ----------

const liveConfig: AppConfig = {
  mode: 'live',
  keysPath: '/tmp/phosphor-test-keys.json',
  port: 4177,
  addresses: {
    evm: ['0x1111111111111111111111111111111111111111'],
    solana: ['11111111111111111111111111111111'],
    near: ['karim-demo.near'],
  },
  economicTransferUsd: 10,
  candleProducts: ['BTC-USD'],
  dataDir: 'state',
};

/* The live ledger reads ONE place now: the intents.near verifier. There is no per-chain balance
   fan-out left to fail, which is why neither test below looks for a stale chain any more. A chain
   this app never reads cannot go stale, and a STALE badge on one would be the window reporting on
   a request nobody made. What can still fail is the verifier read, and that carries its own ok
   flag on IntentsRead rather than on chainStatus. */

test('createLedger live mode: a failing fetchImpl leaves the snapshot empty and does not throw', async () => {
  const failFetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  const ledger = createLedger(liveConfig, { fetchImpl: failFetch });
  const snap = await ledger.refresh();

  assert.deepEqual(snap.holdings, []);
  for (const chain of ['eth', 'base', 'arb', 'sol', 'near'] as const) {
    assert.equal(snap.chainStatus[chain].ok, true, `${chain} is not read, so it cannot be stale`);
  }
});

test('createLedger live mode: configured addresses change nothing, because no chain is read', async () => {
  const okFetch = (async () =>
    new Response(JSON.stringify([[0, 0, 0, 0, 100, 0]]), { status: 200 })) as typeof fetch;

  const configured = createLedger(liveConfig, { fetchImpl: okFetch });
  const unconfigured = createLedger({ ...liveConfig, addresses: { evm: [], solana: [], near: [] } }, { fetchImpl: okFetch });

  assert.deepEqual((await configured.refresh()).holdings, []);
  assert.deepEqual((await unconfigured.refresh()).holdings, []);
});
