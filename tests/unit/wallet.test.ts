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

// ---------- a wallet lists what you hold ----------
//
// Karim, 2026-08-13: "the actual list should only show us tokens we are holding. clearly".
// The live wallet was 19 rows, 14 of them zero.

test('a token with nothing in it is not a row, and the number dropped is still reported', () => {
  const snap = loadDemoLedger();
  const held = snap.holdings.filter(h => h.amount > 0).length;
  snap.holdings.push({ chain: 'base', address: '0xself', symbol: 'PYUSD', tokenId: '0xpyusd', amount: 0, usd: 0, native: false });
  snap.holdings.push({ chain: 'base', address: '0xself', symbol: 'USDS', tokenId: '0xusds', amount: 0, usd: 0, native: false });

  const wallet = buildWallet(snap);
  assert.equal(wallet.rows.some(r => r.quantity === 0 && r.kind === 'token'), false, 'no empty rows');
  assert.equal(wallet.rows.length, held);
  assert.equal(wallet.emptyCount, 2, 'a short list and a shallow read are different facts');
});

test('a token we hold but cannot price is still a row: the test is quantity, not value', () => {
  const snap = loadDemoLedger();
  snap.holdings.push({ chain: 'base', address: '0xself', symbol: 'WHO', tokenId: '0xwho', amount: 12, usd: 0, native: false });

  const wallet = buildWallet(snap);
  const row = wallet.rows.find(r => r.symbol === 'WHO');
  assert.ok(row, 'dropping it would be the app deciding you own less than you do');
  assert.equal(row!.quantity, 12);
});

test('an empty verifier balance is dropped like any other empty holding', () => {
  const snap = loadDemoLedger();
  const wallet = buildWallet(snap, [], {
    holdings: [{ ...INTENTS_ETH, amount: 0 }],
    ok: true,
    fetchedAt: 'now',
  });
  assert.equal(wallet.rows.some(r => r.kind === 'intents'), false);
  assert.equal(wallet.emptyCount, 1);
});

test('byChain only names places that hold something', () => {
  const snap = loadDemoLedger();
  // Everything on this chain is empty, so the chain itself has nothing to report.
  snap.holdings = snap.holdings.filter(h => h.chain !== 'near');
  snap.holdings.push({ chain: 'near', address: 'x.near', symbol: 'USDT', tokenId: 'usdt', amount: 0, usd: 0, native: false });
  const wallet = buildWallet(snap);
  assert.equal(Object.prototype.hasOwnProperty.call(wallet.byChain, 'near'), false, 'a zero total is a line of noise');
});

// ---------- balances held inside the intents.near verifier ----------

const INTENTS_ETH = {
  accountId: '0xabc',
  assetId: 'nep141:eth.omft.near',
  symbol: 'ETH',
  originChain: 'eth',
  amount: 2,
  decimals: 18,
};

test('a verifier balance is a wallet row, placed at intents rather than on a chain', () => {
  const snap = loadDemoLedger();
  const wallet = buildWallet(snap, [], { holdings: [INTENTS_ETH], ok: true, fetchedAt: 'now' });

  const rows = wallet.rows.filter(r => r.kind === 'intents');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'ETH');
  assert.equal(rows[0].chain, 'intents', 'it is on no chain: calling it near would send you looking in the wrong place');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].intents?.assetId, 'nep141:eth.omft.near');
});

test('verifier ETH and wallet ETH agree about what an ETH is worth', () => {
  const snap = loadDemoLedger();
  const wallet = buildWallet(snap, [], { holdings: [INTENTS_ETH], ok: true, fetchedAt: 'now' });

  const onChain = wallet.rows.find(r => r.kind === 'token' && r.symbol === 'ETH' && r.native);
  const inVerifier = wallet.rows.find(r => r.kind === 'intents');
  assert.ok(onChain && inVerifier);
  closeTo(inVerifier!.priceUsd, onChain!.priceUsd, 0.01);
  closeTo(inVerifier!.valueUsd, 2 * onChain!.priceUsd, 0.01);
});

test('a verifier balance counts toward the total, which is the bug that started this', () => {
  const snap = loadDemoLedger();
  const before = buildWallet(snap);
  const after = buildWallet(snap, [], { holdings: [INTENTS_ETH], ok: true, fetchedAt: 'now' });

  assert.ok(after.totalUsd > before.totalUsd, 'money in the verifier is money held');
  assert.ok(after.byChain.intents > 0, 'and it gets its own place in the breakdown');
  closeTo(after.rows.reduce((s, r) => s + r.share, 0), 1, 0.0001);
});

test('a failed verifier read is stale, never an absent row', () => {
  const wallet = buildWallet(loadDemoLedger(), [], {
    holdings: [],
    ok: false,
    fetchedAt: 'now',
    error: 'rpc down',
  });
  assert.ok(wallet.stale.includes('intents'), 'showing no row would claim the deposit is gone');
});

test('a wallet that never asked the verifier does not claim it went stale', () => {
  // Demo mode and testnet: intents.near is not there to read, so there is nothing to mark.
  assert.equal(buildWallet(loadDemoLedger()).stale.includes('intents'), false);
  assert.equal(
    buildWallet(loadDemoLedger(), [], { holdings: [], ok: true, fetchedAt: 'now' }).stale.includes('intents'),
    false,
  );
});

test('an empty wallet does not divide by zero', () => {
  const snap = { ...loadDemoLedger(), holdings: [] };
  const wallet = buildWallet(snap);
  assert.equal(wallet.totalUsd, 0);
  assert.deepEqual(wallet.rows, []);
});
