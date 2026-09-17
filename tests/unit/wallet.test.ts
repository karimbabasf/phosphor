// buildWallet is what the wallet panel renders: the balances inside NEAR Intents and the
// Hyperliquid collateral, priced and shared. The case that matters is where it must differ
// from classify(): ETH and SOL are rows here and are left out of the composition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWallet } from '../../src/wallet.ts';
import { loadDemoLedger, loadDemoReads } from '../../src/ledger/demo.ts';

function closeTo(actual: number, expected: number, tolerance: number, msg?: string) {
  assert.ok(Math.abs(actual - expected) <= tolerance, msg ?? `${actual} not within ${tolerance} of ${expected}`);
}

function demoWallet() {
  const reads = loadDemoReads();
  return buildWallet(loadDemoLedger(), reads.intents, reads.hyperliquid);
}

test('the demo wallet is the two pockets: three intents rows and the trading account', () => {
  const wallet = demoWallet();
  assert.deepEqual(wallet.rows.map(r => `${r.kind}:${r.symbol}`).sort(), ['hyperliquid:USDC', 'intents:ETH', 'intents:SOL', 'intents:USDC']);
  const reads = loadDemoReads();
  const intentsUsd = reads.intents.holdings.reduce((s, h) => s + h.amount * (h.symbol === 'USDC' ? 1 : loadDemoLedger().prices[h.symbol]), 0);
  closeTo(wallet.totalUsd, intentsUsd + reads.hyperliquid.collateralUsdc, 0.01);
  assert.ok(wallet.rows.some(r => r.symbol === 'ETH' && r.valueUsd > 0), 'ETH inside the verifier is priced off spot and shown');
});

test('rows carry a unit price, so a wallet row can show quantity x price = value', () => {
  const wallet = demoWallet();
  for (const row of wallet.rows) {
    if (row.quantity === 0) continue;
    closeTo(row.quantity * row.priceUsd, row.valueUsd, 0.01, `${row.symbol} on ${row.chain}`);
  }
});

test('rows sort by value descending and shares sum to 1', () => {
  const wallet = demoWallet();
  for (let i = 1; i < wallet.rows.length; i++) {
    assert.ok(wallet.rows[i - 1].valueUsd >= wallet.rows[i].valueUsd, 'rows must be value descending');
  }
  closeTo(wallet.rows.reduce((s, r) => s + r.share, 0), 1, 0.0001);
});

// ---------- a wallet lists what you hold ----------
//
// Karim, 2026-08-13: "the actual list should only show us tokens we are holding. clearly".

test('an empty verifier balance is dropped like any other empty holding, and the number dropped is still reported', () => {
  const reads = loadDemoReads();
  const intents = {
    ...reads.intents,
    holdings: [...reads.intents.holdings, { ...reads.intents.holdings[1], assetId: 'nep141:arb-usdc.omft.near', amount: 0, amountBase: '0' }],
  };
  const wallet = buildWallet(loadDemoLedger(), intents, reads.hyperliquid);
  assert.equal(wallet.rows.some(r => r.quantity === 0), false, 'no empty rows');
  assert.equal(wallet.emptyCount, 1, 'a short list and a shallow read are different facts');
});

test('a token we hold but cannot price is still a row: the test is quantity, not value', () => {
  const reads = loadDemoReads();
  const intents = { ...reads.intents, holdings: [{ ...reads.intents.holdings[0], symbol: 'WIF', assetId: 'nep141:wif.omft.near', amount: 412.5 }] };
  const wallet = buildWallet(loadDemoLedger(), intents);
  const row = wallet.rows.find(r => r.symbol === 'WIF');
  assert.ok(row !== undefined, 'a held balance is a row whatever it is worth');
  assert.equal(row.priced, false);
});

test('byChain only names places that hold something', () => {
  const reads = loadDemoReads();
  const wallet = buildWallet(loadDemoLedger(), reads.intents, { ...reads.hyperliquid, collateralUsdc: 0, availableUsdc: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(wallet.byChain, 'hyperliquid'), false, 'a zero total is a line of noise');
  assert.ok(wallet.byChain.intents > 0);
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
  const wallet = buildWallet(loadDemoLedger(), { holdings: [INTENTS_ETH], ok: true, fetchedAt: 'now' });

  const rows = wallet.rows.filter(r => r.kind === 'intents');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'ETH');
  assert.equal(rows[0].chain, 'intents', 'it is on no chain: calling it near would send you looking in the wrong place');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].intents?.assetId, 'nep141:eth.omft.near');
});

test('verifier ETH is priced off the spot table', () => {
  const snap = loadDemoLedger();
  const wallet = buildWallet(snap, { holdings: [INTENTS_ETH], ok: true, fetchedAt: 'now' });
  const inVerifier = wallet.rows.find(r => r.kind === 'intents');
  assert.ok(inVerifier);
  closeTo(inVerifier!.priceUsd, snap.prices.ETH, 0.01);
  closeTo(inVerifier!.valueUsd, 2 * snap.prices.ETH, 0.01);
});

test('a verifier balance counts toward the total, which is the bug that started this', () => {
  const snap = loadDemoLedger();
  const before = buildWallet(snap);
  const after = buildWallet(snap, { holdings: [INTENTS_ETH], ok: true, fetchedAt: 'now' });

  assert.ok(after.totalUsd > before.totalUsd, 'money in the verifier is money held');
  assert.ok(after.byChain.intents > 0, 'and it gets its own place in the breakdown');
  closeTo(after.rows.reduce((s, r) => s + r.share, 0), 1, 0.0001);
});

test('a failed verifier read is stale, never an absent row', () => {
  const wallet = buildWallet(loadDemoLedger(), {
    holdings: [],
    ok: false,
    fetchedAt: 'now',
    error: 'rpc down',
  });
  assert.ok(wallet.stale.includes('intents'), 'showing no row would claim the deposit is gone');
});

test('a wallet that never asked the verifier does not claim it went stale', () => {
  assert.equal(buildWallet(loadDemoLedger()).stale.includes('intents'), false);
  assert.equal(
    buildWallet(loadDemoLedger(), { holdings: [], ok: true, fetchedAt: 'now' }).stale.includes('intents'),
    false,
  );
});

test('an empty wallet does not divide by zero', () => {
  const wallet = buildWallet(loadDemoLedger());
  assert.equal(wallet.totalUsd, 0);
  assert.deepEqual(wallet.rows, []);
  assert.deepEqual(wallet.stale, []);
});

// ---------- a stablecoin the spot table does not carry ----------
//
// The bug this block exists for, seen in Karim's own window on 2026-09-08: 3.694727 USDC sitting
// in the intents verifier, priced at 0, valued at 0, and a wallet total reading $25.90 when it
// was $29.60. Money he owns, on screen as nothing. The spot table carries the natives; a
// stablecoin appears in it nowhere, so it was priced off nothing.

const intentsOf = (symbol: string, amount: number) => ({
  holdings: [{ accountId: '0xabc', assetId: `nep141:${symbol.toLowerCase()}.omft.near`, symbol, originChain: 'eth', amount, decimals: 6 }],
  ok: true,
  fetchedAt: 'now',
});

test('a stablecoin held in the verifier is worth a dollar, not nothing', () => {
  const wallet = buildWallet(loadDemoLedger(), intentsOf('USDC', 3.694727));

  const row = wallet.rows.find(r => r.kind === 'intents');
  assert.equal(row?.priceUsd, 1);
  assert.ok(Math.abs((row?.valueUsd ?? 0) - 3.694727) < 1e-9);
  assert.equal(row?.priced, true);
});

test('the total counts it, because a total that leaves money out is the number a person acts on', () => {
  const snap = loadDemoLedger();
  const without = buildWallet(snap).totalUsd;
  const withIt = buildWallet(snap, intentsOf('USDC', 10)).totalUsd;
  assert.ok(Math.abs(withIt - without - 10) < 1e-9, `total moved by ${withIt - without}, not by 10`);
});

test('a symbol in the other case is the same symbol', () => {
  // The price map was keyed by whatever case each side happened to use, so a lookup only landed
  // when the two agreed. src/ledger/index.ts already normalises; this did not.
  const wallet = buildWallet(loadDemoLedger(), intentsOf('usdc', 5));
  assert.equal(wallet.rows.find(r => r.kind === 'intents')?.priceUsd, 1);
});

test('WETH in the verifier is worth what an ETH is worth', () => {
  const snap = loadDemoLedger();
  const wallet = buildWallet(snap, intentsOf('WETH', 1));
  assert.ok(Math.abs((wallet.rows.find(r => r.kind === 'intents')?.priceUsd ?? 0) - snap.prices.ETH) < 1e-6);
});

test('an asset this app cannot price is a hole, and says so rather than printing zero', () => {
  /* The floor is a named list and not a guess at what looks like a dollar: a token called
     USDCoin is not a dollar because its name starts the same way, and this figure is added to a
     total somebody makes decisions against. So an unknown asset still values at zero, and it
     carries the flag that stops the window printing "$0.00" beside a balance somebody owns. */
  const wallet = buildWallet(loadDemoLedger(), intentsOf('WIF', 412.5));

  const row = wallet.rows.find(r => r.kind === 'intents');
  assert.equal(row?.priceUsd, 0, 'a price was invented for an asset nothing prices');
  assert.equal(row?.valueUsd, 0);
  assert.equal(row?.priced, false, 'the window cannot tell this apart from a worthless balance');
});

// ---------- the trading account, the second pocket ----------
//
// Since 2026-09-11 money moves intents <-> HyperCore, and one read has to show both or the
// agent cannot verify a deposit or a withdrawal without a second tool.

const HL_READ = {
  ok: true,
  fetchedAt: 'now',
  account: '0xabc',
  collateralUsdc: 9.6594,
  availableUsdc: 9.6594,
  marginUsedUsd: 0,
  openPositions: 0,
  unified: true,
};

test('the Hyperliquid collateral is a wallet row, placed at hyperliquid rather than on a chain', () => {
  const wallet = buildWallet(loadDemoLedger(), undefined, HL_READ);
  const rows = wallet.rows.filter(r => r.kind === 'hyperliquid');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'USDC');
  assert.equal(rows[0].chain, 'hyperliquid');
  assert.equal(rows[0].quantity, 9.6594);
  assert.equal(rows[0].priceUsd, 1);
  closeTo(rows[0].valueUsd, 9.6594, 0.0001);
  assert.deepEqual(rows[0].hyperliquid, { account: '0xabc', availableUsdc: 9.6594, marginUsedUsd: 0, openPositions: 0, unified: true });
  assert.ok(wallet.byChain.hyperliquid > 0, 'and it gets its own place in the breakdown');
});

test('an empty trading account is not a row, and a failed venue read is stale rather than absent', () => {
  const empty = buildWallet(loadDemoLedger(), undefined, { ...HL_READ, collateralUsdc: 0, availableUsdc: 0 });
  assert.equal(empty.rows.some(r => r.kind === 'hyperliquid'), false);
  assert.equal(empty.stale.includes('hyperliquid'), false);

  const failed = buildWallet(loadDemoLedger(), undefined, { ...HL_READ, ok: false, error: 'info down' });
  assert.ok(failed.stale.includes('hyperliquid'), 'showing no row would claim the collateral is gone');

  assert.equal(buildWallet(loadDemoLedger()).stale.includes('hyperliquid'), false, 'a venue never asked did not go stale');
});

test('a priced balance that rounds to $0.00 is dust: hidden from the rows, kept in the total, counted in the note', () => {
  const reads = loadDemoReads();
  const plain = buildWallet(loadDemoLedger(), reads.intents);
  const dustHl = { ...HL_READ, collateralUsdc: 0.001038, availableUsdc: 0.001038 };
  const wallet = buildWallet(loadDemoLedger(), reads.intents, dustHl);
  assert.equal(wallet.rows.some(r => r.kind === 'hyperliquid'), false, 'the $0.00 row is not listed');
  assert.equal(wallet.dustCount, plain.dustCount + 1);
  closeTo(wallet.dustUsd, plain.dustUsd + 0.001038, 0.000001);
  const listed = wallet.rows.reduce((sum, r) => sum + r.valueUsd, 0);
  closeTo(wallet.totalUsd - listed, wallet.dustUsd, 0.000001, 'the total still carries the dust');
  assert.ok(wallet.byChain.hyperliquid > 0, 'and the place still counts it');
});

test('a balance the app could not price is never dust, however small', () => {
  const wallet = buildWallet(loadDemoLedger(), {
    holdings: [{ ...INTENTS_ETH, symbol: 'ZZZ', assetId: 'nep141:zzz.omft.near', amount: 0.000001, decimals: 18 }],
    ok: true,
    fetchedAt: 'now',
  });
  const row = wallet.rows.find(r => r.kind === 'intents');
  assert.ok(row !== undefined, 'an unpriced holding stays on the list');
  assert.equal(row.priced, false);
  assert.equal(wallet.dustCount, 0, 'an unpriced holding never joins the dust');
});
