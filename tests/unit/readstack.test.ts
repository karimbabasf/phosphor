// The read stack: the demo fixture, the composition over the two pockets, and the ledger
// orchestrator in both modes. Fixture-driven only; every fetchImpl here is a mock, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { AppConfig, RiskRow } from '../../src/types.ts';
import { demoAccount, loadDemoLedger, loadDemoReads } from '../../src/ledger/demo.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { classify } from '../../src/composition.ts';
import { buildWallet } from '../../src/wallet.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8'),
).rows as RiskRow[];

const demoConfig: AppConfig = {
  mode: 'demo',
  keysPath: '/tmp/phosphor-test-keys.json',
  port: 4177,
  addresses: {},
  candleProducts: ['BTC-USD'],
  dataDir: 'state',
};

function closeTo(actual: number, expected: number, tolerance: number, msg?: string) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    msg ?? `expected ${actual} within ${tolerance} of ${expected}`,
  );
}

function demoRows() {
  const reads = loadDemoReads();
  return buildWallet(loadDemoLedger(), reads.intents, reads.hyperliquid).rows;
}

// ---------- demo.ts + composition.ts, against real data/*.json ----------

test('the demo fixture is one account with ETH, USDC and SOL inside NEAR Intents and 50 USDC on Hyperliquid', () => {
  const reads = loadDemoReads();
  assert.deepEqual(reads.intents.holdings.map(h => h.symbol).sort(), ['ETH', 'SOL', 'USDC']);
  assert.ok(reads.intents.holdings.every(h => h.accountId === demoAccount()), 'every balance is credited to the one demo account');
  assert.ok(reads.intents.holdings.every(h => typeof h.amountBase === 'string' && /^[0-9]+$/.test(h.amountBase)), 'base units ride beside the UI amount');
  assert.equal(reads.hyperliquid.collateralUsdc, 50);
  assert.equal(reads.intents.ok && reads.hyperliquid.ok, true);
});

/* THE FIXTURE IS THIS WALLET'S, NOT THE FILE'S ACCOUNT.
   Found while photographing the money stages: a demo deposit made by a wallet created in the
   app walked every stage, was credited, and then sat in `crediting` until its deadline flipped
   it to `stalled`. judgeSettling matches the row's pocket (the draft's account, which is the
   keystore's) against the venue read's account (the fixture's, 0x1111...), they never matched,
   so the balance that had moved was never read as this row's. Every read the fixture stands in
   for is attributed to the wallet asking. */
test('the demo reads are credited to the wallet that holds them, and the file account is the fallback', () => {
  const mine = '0x2222222222222222222222222222222222222222';
  const reads = loadDemoReads(mine);
  assert.equal(reads.hyperliquid.account, mine, 'the trading account read names this wallet');
  assert.ok(reads.intents.holdings.every(h => h.accountId === mine), 'and so does every balance inside the verifier');
  assert.equal(reads.hyperliquid.collateralUsdc, loadDemoReads().hyperliquid.collateralUsdc, 'the figures come from the fixture either way');
  assert.equal(loadDemoReads().hyperliquid.account, demoAccount(), 'no wallet yet keeps the account named in the file');
  assert.equal(loadDemoReads(null).hyperliquid.account, demoAccount());
});

test('the demo snapshot carries the spot prices and a stamp, and nothing held on a chain', () => {
  const snap = loadDemoLedger();
  assert.equal(snap.mode, 'demo');
  assert.ok(snap.prices.ETH > 0 && snap.prices.SOL > 0);
  assert.ok(Number.isFinite(Date.parse(snap.fetchedAt)));
  assert.equal('holdings' in snap, false);
});

test('composition: the issued coins are USDC in both pockets, all of it Circle and freezable', () => {
  const comp = classify(demoRows(), riskRows);
  closeTo(comp.byIssuer['Circle'], 1, 1e-9);
  closeTo(comp.freezableShare, 1, 1e-9);
  assert.deepEqual(comp.rows.map(r => `${r.symbol}@${r.chain}`).sort(), ['USDC@hyperliquid', 'USDC@intents']);
  closeTo(comp.totalUsd, 1850 + 50, 0.01);
});

test('composition: ETH and SOL have no issuer, so they sit outside the composition the wallet still shows', () => {
  const rows = demoRows();
  assert.ok(rows.some(r => r.symbol === 'ETH') && rows.some(r => r.symbol === 'SOL'), 'the wallet shows them');
  const comp = classify(rows, riskRows);
  assert.equal(comp.rows.some(r => r.symbol === 'ETH' || r.symbol === 'SOL'), false, 'the composition does not count them');
  assert.deepEqual(comp.unclassified, []);
});

test('composition: an issued coin the risk table does not know is unclassified and counts as freezable (pessimistic default)', () => {
  const rows = [...demoRows(), { kind: 'intents' as const, chain: 'intents' as const, symbol: 'XUSD', tokenId: 'x', quantity: 120, priceUsd: 1, valueUsd: 120, share: 0, native: false }];
  const comp = classify(rows, riskRows);
  assert.ok(comp.unclassified.includes('XUSD'));
  const xusd = comp.rows.find(r => r.symbol === 'XUSD');
  assert.ok(xusd);
  assert.equal(xusd!.freezable, true);
  assert.equal(xusd!.classified, false);
  assert.equal(xusd!.issuer, 'unclassified');
});

test('composition: rows are sorted by share descending', () => {
  const comp = classify(demoRows(), riskRows);
  for (let i = 1; i < comp.rows.length; i++) {
    assert.ok(comp.rows[i - 1].share >= comp.rows[i].share);
  }
});

// ---------- ledger/index.ts: demo-mode wiring ----------

test('createLedger demo mode: the pockets are the fixture, so a proposal has something to spend', () => {
  const ledger = createLedger(demoConfig);
  const intents = ledger.intents();
  assert.ok(intents !== undefined && intents.ok);
  assert.deepEqual(intents!.holdings.map(h => h.symbol).sort(), ['ETH', 'SOL', 'USDC']);
  assert.equal(ledger.hyperliquid()?.collateralUsdc, 50);
  assert.equal(ledger.snapshot().mode, 'demo');
});

test('createLedger demo mode: refresh() resolves without changing balances', async () => {
  const ledger = createLedger(demoConfig);
  const before = buildWallet(ledger.snapshot(), ledger.intents(), ledger.hyperliquid()).totalUsd;
  await ledger.refresh();
  const after = buildWallet(ledger.snapshot(), ledger.intents(), ledger.hyperliquid()).totalUsd;
  closeTo(after, before, 0.0001);
});

// ---------- ledger/index.ts: live mode failure handling ----------

const liveConfig: AppConfig = {
  mode: 'live',
  keysPath: '/tmp/phosphor-test-keys.json',
  port: 4177,
  addresses: { evm: '0x1111111111111111111111111111111111111111' },
  candleProducts: ['BTC-USD'],
  dataDir: 'state',
};

/* The live ledger reads two places: the intents.near verifier and the Hyperliquid account. Both
   need a key on disk to name the account, and there is none here, so neither is asked. What is
   left is the price read, and a price that fails leaves the snapshot without one rather than
   throwing. */

test('createLedger live mode: a failing fetchImpl leaves the snapshot without prices and does not throw', async () => {
  const failFetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  const ledger = createLedger(liveConfig, { fetchImpl: failFetch });
  const snap = await ledger.refresh();

  assert.equal(snap.mode, 'live');
  assert.equal(ledger.intents(), undefined, 'no key, so the verifier is not asked');
  assert.equal(ledger.hyperliquid(), undefined, 'no key, so the venue is not asked');
  assert.ok(Number.isFinite(Date.parse(snap.fetchedAt)));
});

test('createLedger live mode: configured addresses change nothing, because no chain is read', async () => {
  const okFetch = (async () =>
    new Response(JSON.stringify([[0, 0, 0, 0, 100, 0]]), { status: 200 })) as typeof fetch;

  const configured = createLedger(liveConfig, { fetchImpl: okFetch });
  const unconfigured = createLedger({ ...liveConfig, addresses: {} }, { fetchImpl: okFetch });

  assert.deepEqual((await configured.refresh()).prices, (await unconfigured.refresh()).prices);
  assert.equal(configured.intents(), undefined);
  assert.equal(unconfigured.intents(), undefined);
});
