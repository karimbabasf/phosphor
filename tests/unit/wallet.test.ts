// buildWallet is what the composition panel renders. The cases that matter are the ones
// where it must differ from classify(): natives are included, pool positions are rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWallet } from '../../src/wallet.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { LpPosition } from '../../src/types.ts';

function closeTo(actual: number, expected: number, tolerance: number, msg?: string) {
  assert.ok(Math.abs(actual - expected) <= tolerance, msg ?? `${actual} not within ${tolerance} of ${expected}`);
}

test('the wallet includes natives, which the composition view deliberately excludes', () => {
  const snap = loadDemoLedger();
  const wallet = buildWallet(snap);

  const natives = wallet.rows.filter(r => r.native);
  assert.ok(natives.length > 0, 'demo fixture holds native gas assets and the wallet must show them');

  const stableUsd = snap.holdings.filter(h => !h.native).reduce((s, h) => s + h.usd, 0);
  assert.ok(wallet.totalUsd > stableUsd, 'wallet total must exceed the stables-only total');
  closeTo(wallet.totalUsd, snap.holdings.reduce((s, h) => s + h.usd, 0), 0.01);
});

test('rows carry a unit price, so a wallet row can show quantity x price = value', () => {
  const wallet = buildWallet(loadDemoLedger());
  for (const row of wallet.rows) {
    if (row.quantity === 0) continue;
    closeTo(row.quantity * row.priceUsd, row.valueUsd, 0.01, `${row.symbol} on ${row.chain}`);
  }
});

test('rows sort by value descending and shares sum to 1', () => {
  const wallet = buildWallet(loadDemoLedger());
  for (let i = 1; i < wallet.rows.length; i++) {
    assert.ok(wallet.rows[i - 1].valueUsd >= wallet.rows[i].valueUsd, 'rows must be value descending');
  }
  closeTo(wallet.rows.reduce((s, r) => s + r.share, 0), 1, 0.0001);
});

test('a pool position is one row, valued as both sides plus uncollected fees', () => {
  const snap = loadDemoLedger();
  const position: LpPosition = {
    chain: 'arb',
    venue: 'uniswap-v3',
    poolId: '0xpool',
    positionId: '4242',
    token0: { symbol: 'USDC', tokenId: '0xusdc', amount: 100 },
    token1: { symbol: 'USDT', tokenId: '0xusdt', amount: 50 },
    feeTier: 500,
    inRange: true,
    uncollectedFeesUsd: 3,
  };
  const wallet = buildWallet(snap, [position]);

  const lpRows = wallet.rows.filter(r => r.kind === 'lp');
  assert.equal(lpRows.length, 1);
  assert.equal(lpRows[0].symbol, 'USDC/USDT 0.05%');
  // both stables price at ~1.0 in the fixture: 100 + 50 + 3 uncollected
  closeTo(lpRows[0].valueUsd, 153, 0.5);
  assert.equal(lpRows[0].lp?.positionId, '4242');
});

test('a failed chain is reported stale rather than silently zeroed', () => {
  const snap = loadDemoLedger();
  snap.chainStatus.sol = { ok: false, fetchedAt: new Date().toISOString(), error: 'rpc down' };
  assert.deepEqual(buildWallet(snap).stale, ['sol']);
});

test('an empty wallet does not divide by zero', () => {
  const snap = { ...loadDemoLedger(), holdings: [] };
  const wallet = buildWallet(snap);
  assert.equal(wallet.totalUsd, 0);
  assert.deepEqual(wallet.rows, []);
});
