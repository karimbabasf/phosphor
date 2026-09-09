// The gas report is an aggregation, so what these assert is the arithmetic and the honesty:
// that every receipt lands in exactly one slice of each grouping, that gas units survive a
// history long enough to break a float, and that the four things this app cannot count are
// carried out as their own numbers instead of being averaged into a smaller total.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGasReport } from '../../src/gas/report.ts';
import type { GasWindow } from '../../src/gas/report.ts';
import type { TxEntry, TxGas, TxHash } from '../../src/transactions.ts';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

// 210000 units at 100 gwei is 0.000021 ETH, which is the same product the receipt reader
// takes: gasUsed * effectiveGasPrice, kept in wei until the last division.
function receipt(over: Partial<TxGas> = {}): TxGas {
  return {
    place: 'arb',
    gasUsed: '210000',
    gasPriceWei: '100000000',
    feeNative: 0.000021,
    feeSymbol: 'ETH',
    feeUsd: 0.07,
    blockNumber: '1',
    status: 'success',
    ...over,
  };
}

function mined(gas: TxGas): TxHash {
  return { hash: '0x' + 'a'.repeat(64), place: gas.place, kind: 'chain', url: null, gas, gasPending: false };
}

function reading(): TxHash {
  return { hash: '0x' + 'b'.repeat(64), place: 'arb', kind: 'chain', url: null, gas: null, gasPending: true };
}

function lost(): TxHash {
  return { hash: '0x' + 'c'.repeat(64), place: 'arb', kind: 'chain', url: null, gas: null, gasPending: false };
}

function intent(): TxHash {
  return { hash: 'G8tyevVXKS4RA', place: 'intents', kind: 'intent', url: null, gas: null, gasPending: false };
}

/* `over` is loosened on kind and venue so a RETIRED value can be used here, and that is the
   point rather than a convenience: state/proposals.json holds executed rows naming yield_deposit,
   lp_add and venue 'uniswap-v3', this report groups over exactly those rows, and a test that
   could only express live kinds would stop covering the case the report actually meets. */
function entry(over: Partial<Omit<TxEntry, 'kind' | 'venue'>> & { kind?: string; venue?: string | null } = {}): TxEntry {
  return {
    id: 'p-1',
    ts: at(HOUR),
    action: 'swap',
    kind: 'swap',
    status: 'executed',
    venue: 'uniswap-v3',
    place: 'arb',
    toPlace: 'arb',
    sent: { symbol: 'USDC', amount: 100 },
    received: null,
    note: null,
    valueUsd: 100,
    from: null,
    to: null,
    counterparty: null,
    decidedBy: 'human',
    hashes: [mined(receipt())],
    venueFeeUsd: null,
    detail: 'swapped',
    reasons: [],
    ...over,
  } as TxEntry;
}

function report(entries: TxEntry[], window: GasWindow = 'all') {
  return buildGasReport({ entries, window, nowMs: NOW });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

test('an empty history reports zeroes and divides by nothing', () => {
  const r = report([]);
  assert.equal(r.totalUsd, 0);
  assert.equal(r.totalGasUsed, '0');
  assert.equal(r.txCount, 0);
  assert.equal(r.moveCount, 0);
  assert.equal(r.movedUsd, 0);
  assert.equal(r.gasBps, null, 'nothing moved, so the ratio has no denominator and says so');
  assert.deepEqual(r.byAction, []);
  assert.deepEqual(r.byChain, []);
  assert.deepEqual(r.unpriced, { txCount: 0, gasUsed: '0' });
  assert.equal(r.fromTs, null);
  assert.equal(r.toTs, '2026-08-20T12:00:00.000Z');
});

test('the dollars in byChain add up to the total, because a receipt belongs to one chain', () => {
  const r = report([
    entry({ id: 'a', hashes: [mined(receipt({ place: 'arb', feeUsd: 0.07 }))] }),
    entry({ id: 'b', action: 'deposit', kind: 'yield_deposit', hashes: [mined(receipt({ place: 'eth', feeUsd: 1.42 }))] }),
    entry({ id: 'c', action: 'withdraw', kind: 'yield_withdraw', hashes: [mined(receipt({ place: 'base', feeUsd: 0.0123 }))] }),
  ]);
  assert.equal(sum(r.byChain.map(s => s.feeUsd)), r.totalUsd, 'the invariant the report is built to hold');
  assert.equal(sum(r.byAction.map(s => s.feeUsd)), r.totalUsd, 'and the move groupings see the same receipts once each');
  assert.equal(r.totalUsd, 1.5023);
  assert.equal(sum(r.byChain.map(s => s.share)), 1);
});

test('a move spanning two chains is split by chain and counted once by action', () => {
  const crossChain = entry({
    action: 'deposit',
    kind: 'intents_deposit',
    hashes: [
      mined(receipt({ place: 'eth', feeUsd: 1.4, gasUsed: '90000' })),
      mined(receipt({ place: 'arb', feeUsd: 0.1, gasUsed: '210000' })),
    ],
  });
  const r = report([crossChain]);

  assert.equal(r.moveCount, 1, 'one movement');
  assert.equal(r.txCount, 2, 'two receipts');
  assert.equal(r.byChain.length, 2);
  assert.deepEqual(r.byChain.map(s => s.key), ['eth', 'arb'], 'the origin cost more, so it sorts first');
  assert.deepEqual(r.byChain.map(s => s.moveCount), [1, 1], 'the same movement contributes to both');

  assert.equal(r.byAction.length, 1);
  assert.equal(r.byAction[0].feeUsd, r.totalUsd, 'the action holds the whole cost of the move, counted once');
  assert.equal(r.byAction[0].moveCount, 1);
  assert.equal(r.byAction[0].gasUsed, '300000');
  assert.equal(sum(r.byChain.map(s => s.feeUsd)), r.totalUsd);
});

test('a reverted receipt is gas spent on a movement that moved nothing', () => {
  const r = report([entry({ status: 'failed', hashes: [mined(receipt({ feeUsd: 0.09, status: 'reverted' }))] })]);
  assert.equal(r.totalUsd, 0.09, 'the chain took the fee whatever the call did');
  assert.equal(r.txCount, 1);
  assert.deepEqual(r.reverted, { feeUsd: 0.09, txCount: 1 });
  assert.equal(r.movedUsd, 0, 'a failed move moved nothing');
  assert.equal(r.gasBps, null, 'and a ratio over nothing is not a number to print');
  assert.equal(r.byAction[0].feeUsd, 0.09, 'it is in the slices too: it is real money out');
});

test('a move settled entirely by intents burns no gas of ours and is counted as such', () => {
  const r = report([entry({ venue: 'intents-native', hashes: [intent()] })]);
  assert.deepEqual(r.intentOnly, { moveCount: 1 });
  assert.equal(r.txCount, 0);
  assert.equal(r.moveCount, 0);
  assert.equal(r.totalUsd, 0);
  assert.deepEqual(r.byAction, [], 'a solver paid for it, so there is no slice of ours to draw');
  assert.deepEqual(r.pending, { moveCount: 0 });
  assert.deepEqual(r.unknown, { moveCount: 0 }, 'nothing is missing here, which is different from missing');
});

test('a receipt still being read is pending, which is not a claim that it cost nothing', () => {
  const r = report([entry({ hashes: [reading()] })]);
  assert.deepEqual(r.pending, { moveCount: 1 });
  assert.equal(r.txCount, 0, 'it has not burned anything we can count yet');
  assert.equal(r.totalUsd, 0);
  assert.deepEqual(r.byChain, [], 'and it draws no slice, because a slice would read as a figure');
  assert.deepEqual(r.unknown, { moveCount: 0 });
  assert.deepEqual(r.intentOnly, { moveCount: 0 });
});

test('a hash no chain we can reach knows is unknown, and unknown is not zero either', () => {
  const r = report([entry({ hashes: [lost()] })]);
  assert.deepEqual(r.unknown, { moveCount: 1 });
  assert.deepEqual(r.pending, { moveCount: 0 }, 'we looked and could not see it, which is a finished sentence');
  assert.equal(r.totalUsd, 0);
  assert.equal(r.moveCount, 0);
});

test('a movement that recorded no hash at all is unaccounted, never free', () => {
  const r = report([entry({ hashes: [] })]);
  assert.deepEqual(r.unknown, { moveCount: 1 });
  assert.deepEqual(r.intentOnly, { moveCount: 0 }, 'no solver settled it: claiming one would invent the evidence');
});

test('an unpriced receipt spends gas units and no dollars', () => {
  const r = report([entry({ hashes: [mined(receipt({ feeUsd: null, gasUsed: '210000' }))] })]);
  assert.deepEqual(r.unpriced, { txCount: 1, gasUsed: '210000' });
  assert.equal(r.totalGasUsed, '210000', 'the units are known');
  assert.equal(r.totalUsd, 0, 'the price was not');
  assert.equal(r.txCount, 1);
  assert.equal(r.byChain[0].gasUsed, '210000');
  assert.equal(r.byChain[0].feeUsd, 0);
  assert.equal(r.byChain[0].share, 0, 'a share of a total of zero is zero, not a division');
  assert.equal(r.byChain[0].feeNative, 0.000021, 'and the native fee is still a real figure');
});

test('gas units are summed exactly past the point a float would start rounding', () => {
  const huge = '9007199254740993'; // 2^53 + 1: the first integer a double cannot hold
  const r = report([
    entry({ id: 'a', hashes: [mined(receipt({ gasUsed: huge, gasPriceWei: '1' }))] }),
    entry({ id: 'b', hashes: [mined(receipt({ gasUsed: huge, gasPriceWei: '1' }))] }),
  ]);
  assert.equal(r.totalGasUsed, '18014398509481986');
  assert.equal(r.byChain[0].gasUsed, '18014398509481986');
  assert.notEqual(r.totalGasUsed, String(Number(huge) + Number(huge)), 'which is what a float sum would have said');
});

test('the window keeps a movement landing exactly on its edge and drops the one before it', () => {
  const entries = [
    entry({ id: 'recent', ts: at(HOUR), hashes: [mined(receipt({ feeUsd: 1 }))] }),
    entry({ id: 'edge', ts: at(DAY), hashes: [mined(receipt({ feeUsd: 0.5 }))] }),
    entry({ id: 'older', ts: at(DAY + 1), hashes: [mined(receipt({ feeUsd: 99 }))] }),
  ];
  const day = report(entries, '24h');
  assert.equal(day.txCount, 2, 'the edge is inside the window it names');
  assert.equal(day.totalUsd, 1.5);
  assert.equal(day.fromTs, at(DAY));

  const all = report(entries, 'all');
  assert.equal(all.txCount, 3);
  assert.equal(all.fromTs, null, 'all has no lower edge to print');
  assert.equal(all.totalUsd, 100.5);
});

test('the window filters on the settle time, which is the timestamp every other surface orders by', () => {
  const settledInside = entry({ ts: at(2 * HOUR), hashes: [mined(receipt({ feeUsd: 3 }))] });
  assert.equal(report([settledInside], '24h').totalUsd, 3);
  assert.equal(report([entry({ ts: at(8 * DAY), hashes: [mined(receipt({ feeUsd: 3 }))] })], '7d').totalUsd, 0);
  assert.equal(report([entry({ ts: at(8 * DAY), hashes: [mined(receipt({ feeUsd: 3 }))] })], '30d').totalUsd, 3);
});

test('slices are ordered by dollars, and one that spent gas without a price still appears, last', () => {
  const r = report([
    entry({ id: 'a', action: 'swap', hashes: [mined(receipt({ feeUsd: 0.2 }))] }),
    entry({ id: 'b', action: 'deposit', kind: 'yield_deposit', hashes: [mined(receipt({ feeUsd: 2 }))] }),
    entry({ id: 'c', action: 'withdraw', kind: 'yield_withdraw', hashes: [mined(receipt({ feeUsd: null, gasUsed: '500000' }))] }),
  ]);
  assert.deepEqual(r.byAction.map(s => s.key), ['deposit', 'swap', 'withdraw']);
  assert.equal(r.byAction[2].feeUsd, 0);
  assert.equal(r.byAction[2].gasUsed, '500000', 'it is last because its price is missing, not because it spent nothing');
});

test('only an executed or executing movement counts as value moved', () => {
  const entries = [
    entry({ id: 'done', status: 'executed', valueUsd: 400 }),
    entry({ id: 'inflight', status: 'executing', valueUsd: 600 }),
    entry({ id: 'failed', status: 'failed', valueUsd: 5000 }),
  ];
  const r = report(entries);
  assert.equal(r.movedUsd, 1000, 'the failed one burned gas and moved nothing, which is the asymmetry gasBps is for');
  assert.equal(r.txCount, 3, 'all three burned gas');
});

test('gasBps is what the gas cost as a share of what actually moved', () => {
  const r = report([entry({ valueUsd: 10000, hashes: [mined(receipt({ feeUsd: 1 }))] })]);
  assert.equal(r.movedUsd, 10000);
  assert.equal(r.gasBps, 1, 'a dollar of gas on ten thousand moved is one basis point');
});

test('a move is grouped by its action and by its draft kind at the same time', () => {
  const r = report([
    entry({ id: 'a', action: 'deposit', kind: 'yield_deposit', venue: 'aave-v3', hashes: [mined(receipt({ feeUsd: 0.3 }))] }),
    entry({ id: 'b', action: 'deposit', kind: 'intents_deposit', venue: 'intents.near', hashes: [mined(receipt({ feeUsd: 0.2 }))] }),
  ]);
  assert.deepEqual(r.byAction.map(s => s.key), ['deposit'], 'one verb from the reader side of the screen');
  assert.equal(r.byAction[0].moveCount, 2);
  assert.deepEqual(r.byKind.map(s => s.key), ['yield_deposit', 'intents_deposit'], 'two rails underneath it');
  assert.equal(r.byKind[0].label, 'yield deposit', 'the key is the token, the label is read by a person');
  assert.deepEqual(r.byVenue.map(s => s.key), ['aave-v3', 'intents.near']);
});

test('a movement that named no venue is counted under none rather than dropped', () => {
  const r = report([entry({ action: 'transfer', kind: 'transfer', venue: null, hashes: [mined(receipt({ feeUsd: 0.4 }))] })]);
  assert.equal(r.byVenue.length, 1);
  assert.equal(r.byVenue[0].key, 'none');
  assert.equal(r.byVenue[0].label, 'no venue');
  assert.equal(r.byVenue[0].feeUsd, 0.4);
});

test('a slice spanning chains with different native symbols reports no symbol', () => {
  // Every chain this app reaches today pays in ETH, so a mixed slice needs a fixture to
  // exist at all. The field is here for the first chain that does not, and a slice that
  // added 0.4 ETH to 12 of something else would be a number with no unit.
  const r = report([
    entry({ id: 'a', hashes: [mined(receipt({ place: 'eth', feeSymbol: 'ETH', feeUsd: 1 }))] }),
    entry({ id: 'b', hashes: [mined(receipt({ place: 'near', feeSymbol: 'NEAR', feeUsd: 0.5 }))] }),
  ]);
  assert.equal(r.byAction[0].symbol, null, 'the action spans both');
  assert.deepEqual(r.byChain.map(s => s.symbol), ['ETH', 'NEAR'], 'each chain keeps its own');
});

test('the venue fee is summed beside the gas and never inside it', () => {
  const r = report([
    entry({ id: 'a', venueFeeUsd: 0.0027, hashes: [mined(receipt({ feeUsd: 0.07 }))] }),
    entry({ id: 'b', venueFeeUsd: 0.5, hashes: [mined(receipt({ feeUsd: 0.03 }))] }),
    entry({ id: 'c', status: 'failed', venueFeeUsd: 9, hashes: [] }),
  ]);
  assert.equal(r.venueFeeUsd, 0.5027, 'a quote for a move that never executed named a fee nobody paid');
  assert.equal(r.totalUsd, 0.1, 'a solver and a pool are not the chain: the two figures never mix');
});
