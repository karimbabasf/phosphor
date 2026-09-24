// The preflight: what the app checks on its own, a moment before a 1Click intent is signed.
//
// The reason it exists is the 2026-09-15 loss. 1Click's HyperCore leg pays USDC to a forwarding
// wallet on Arbitrum and its relayer sweeps that wallet into Circle CCTP with a hard-coded
// 300,000 gas limit; an L1 data surge put 155,024 gas of L1 data into the sweep, it ran out of
// gas twice, and the money sat in a wallet nobody retried. These tests replay those numbers
// through the sweep model and hold the verdict to `hold`, and they pin the other four checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SWEEP_CALLDATA_BYTES,
  SWEEP_L2_GAS_UNITS,
  VENDOR_SWEEP_GAS_LIMIT,
  l1DataUnits,
  readArbGas,
  sweepEstimate,
} from '../../src/preflight/arbitrum.ts';
import type { ArbGasRead } from '../../src/preflight/arbitrum.ts';
import { GAS_HISTORY_SAMPLES, createGasHistory } from '../../src/preflight/history.ts';
import { runPreflight } from '../../src/preflight/index.ts';
import type { PreflightDeps } from '../../src/preflight/index.ts';
import type { OneClickQuote } from '../../src/intents.ts';
import type { HlDepositDraft, IntentsPayDraft } from '../../src/types.ts';

const NOW = Date.parse('2026-09-17T18:00:00.000Z');
const OWNER = '0x1111111111111111111111111111111111111111';

// What ArbGasInfo answered on 2026-09-17 at block 506047296, read through viem on the public
// RPC: a quiet hour, the sweep at 145,392 of the vendor's 300,000.
function quietArb(over: Partial<ArbGasRead> = {}): ArbGasRead {
  return {
    l2BaseFeeWei: 20_000_000n,
    perL2Tx: 2_609_956_160n,
    perL1CalldataByte: 18_642_544n,
    perStorageAllocation: 400_400_000_000n,
    perArbGasBase: 20_000_000n,
    perArbGasCongestion: 20_000n,
    perArbGasTotal: 20_020_000n,
    l1BaseFeeEstimateWei: 1_165_159n,
    ...over,
  };
}

// The 09-15 surge: a per-byte L1 price that puts exactly 155,024 gas of L1 data into a
// 420-byte sweep at an L2 price of 0.021 gwei (7,751,200,000 * 420 / 21,000,000).
function surgeArb(): ArbGasRead {
  return quietArb({ perArbGasTotal: 21_000_000n, perL1CalldataByte: 7_751_200_000n, l1BaseFeeEstimateWei: 484_450_000_000n });
}

// A read that puts exactly `units` of L1 data into the 420-byte sweep at an L2 price of 0.021
// gwei: 50,000 wei per byte is one unit.
function arbWithL1(units: number): ArbGasRead {
  return quietArb({ perArbGasTotal: 21_000_000n, perL1CalldataByte: BigInt(units) * 50_000n });
}

// Every relayer sweep that failed since 2026-05-28, by the L1 data its receipt carried
// (gasUsedForL1). Four surges, six orders, all sent at the 300,000 limit, none recovered.
const RELAYER_FAILURES = [
  { at: '2026-08-19', l1: 244_611 },
  { at: '2026-08-21', l1: 75_253 },
  { at: '2026-09-11', l1: 75_254 },
  { at: '2026-09-11', l1: 76_096 },
  { at: '2026-09-15', l1: 155_024 },
  { at: '2026-09-15', l1: 63_426 },
];

test('the sweep model: calibrated from the chain, the 09-15 surge needs 392,024 gas against the vendor limit of 300,000 and is blocked', () => {
  // The second 09-15 sweep ran out after 234,720 of execution with 63,426 of L1 charged, so
  // 236,574 of execution was not enough; the receipts of the sweeps that went through report
  // 203k to 208k because a receipt is not what a sweep has to be sent with.
  assert.equal(SWEEP_L2_GAS_UNITS, 237_000);
  assert.equal(SWEEP_CALLDATA_BYTES, 420);
  assert.equal(VENDOR_SWEEP_GAS_LIMIT, 300_000);
  assert.equal(l1DataUnits(surgeArb()), 155_024);
  const surge = sweepEstimate(surgeArb());
  assert.equal(surge?.gasUnits, 392_024);
  assert.equal(surge?.limit, 300_000);
  assert.equal(surge?.verdict, 'blocked');
  // The smallest failure on record is over the limit in the model too.
  assert.equal(sweepEstimate(arbWithL1(63_426))?.verdict, 'blocked');
});

test('the sweep model: a quiet hour is ok, the band up to the limit is elevated, a zero L2 price is unreadable', () => {
  const quiet = sweepEstimate(quietArb());
  assert.equal(quiet?.l1DataUnits, 392);
  assert.equal(quiet?.gasUnits, 237_392);
  assert.equal(quiet?.verdict, 'ok');
  // 40,000 gas of L1 data: 277,000, under the limit and too close to it to send.
  const elevated = sweepEstimate(arbWithL1(40_000));
  assert.equal(elevated?.gasUnits, 277_000);
  assert.equal(elevated?.verdict, 'elevated');
  assert.equal(sweepEstimate(quietArb({ perArbGasTotal: 0n })), null);
});

test('the sweeps that went through are ok: 150 relayer sweeps on 2026-09-21 and 09-22 carried 271 to 14,445 of L1', () => {
  for (const l1 of [271, 2_190, 14_445]) {
    assert.equal(sweepEstimate(arbWithL1(l1))?.verdict, 'ok', `${l1} of L1 data`);
  }
});

test('the six relayer failures on record: every one holds the deposit, and nothing is signed', async () => {
  for (const f of RELAYER_FAILURES) {
    const p = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf({ arb: arbWithL1(f.l1) }));
    assert.equal(check(p, 'gas').state, 'fail', `${f.at}, ${f.l1} of L1 data`);
    assert.equal(p.verdict, 'hold', `${f.at}, ${f.l1} of L1 data`);
  }
});

test('readArbGas asks the precompile for both views and the chain for the base fee, and answers null when the read fails', async () => {
  const calls: string[] = [];
  const client = {
    async readContract(args: { address: string; functionName: string }) {
      calls.push(`${args.address}:${args.functionName}`);
      if (args.functionName === 'getPricesInWei') return [2_609_956_160n, 18_642_544n, 400_400_000_000n, 20_000_000n, 20_000n, 20_020_000n];
      return 1_165_159n;
    },
    async getBlock() {
      calls.push('getBlock');
      return { baseFeePerGas: 20_000_000n };
    },
  };
  const read = await readArbGas(client);
  assert.deepEqual(read, quietArb());
  assert.deepEqual(calls.sort(), ['0x000000000000000000000000000000000000006C:getL1BaseFeeEstimate', '0x000000000000000000000000000000000000006C:getPricesInWei', 'getBlock']);

  const down = { ...client, async readContract() { throw new Error('rate limited'); } };
  assert.equal(await readArbGas(down), null);
  const noFee = { ...client, async getBlock() { return { baseFeePerGas: null }; } };
  assert.equal(await readArbGas(noFee), null);
});

test('the history keeps one sample per minute and at most sixty, and averages the last hour', () => {
  const h = createGasHistory();
  assert.equal(GAS_HISTORY_SAMPLES, 60);
  for (let i = 0; i < 90; i += 1) h.push(NOW + i * 60_000, 100_000 + i);
  const series = h.series(NOW + 89 * 60_000);
  assert.equal(series.length, 60);
  assert.equal(series[0], 100_030, 'the oldest thirty fell off');
  assert.equal(series[59], 100_089);
  // Two reads in the same minute are one sample, the newer one.
  h.push(NOW + 89 * 60_000 + 10_000, 200_000);
  assert.equal(h.series(NOW + 89 * 60_000 + 10_000).length, 60);
  assert.equal(h.series(NOW + 89 * 60_000 + 10_000)[59], 200_000);
  // Samples older than an hour are not part of the series or the average.
  const later = NOW + 89 * 60_000 + 61 * 60_000;
  assert.deepEqual(h.series(later), []);
  assert.equal(h.average(later), null);
  const fresh = createGasHistory();
  fresh.push(NOW, 100);
  fresh.push(NOW + 60_000, 300);
  assert.equal(fresh.average(NOW + 60_000), 200);
});

// ---------- runPreflight ----------

function hlDraft(over: Partial<HlDepositDraft> = {}): HlDepositDraft {
  return {
    kind: 'hl_deposit',
    symbol: 'USDC',
    originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    amount: 10,
    amountUsd: 10,
    minCredited: 9.5,
    from: OWNER,
    hlAccount: OWNER,
    counterparty: 'intents.near',
    ...over,
  } as HlDepositDraft;
}

function payDraft(over: Partial<IntentsPayDraft> = {}): IntentsPayDraft {
  return {
    kind: 'intents_pay',
    symbol: 'USDC',
    originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    network: 'ethereum',
    amount: 10,
    amountUsd: 10,
    minReceived: 9.7,
    fee: null,
    from: OWNER,
    to: '0xb583f41992cd21b2f2345e194a36d33684bb5db0',
    toChecksum: 'valid',
    counterparty: 'intents.near',
    recipient: { known: false, count: 0, lastAt: null, activity: null, ownAddress: false },
    ...over,
  } as IntentsPayDraft;
}

function quoteOf(over: Partial<OneClickQuote> = {}): OneClickQuote {
  return {
    depositAddress: 'a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058',
    amountIn: '10000000',
    amountInFormatted: '10.0',
    amountInUsd: '10.0',
    minAmountIn: '10000000',
    amountOut: '965940000',
    amountOutFormatted: '9.6594',
    amountOutUsd: '9.6594',
    minAmountOut: '964974060',
    deadline: new Date(NOW + 10 * 60_000).toISOString(),
    timeEstimate: 20,
    withdrawFee: '31530000',
    ...over,
  };
}

type Fakes = {
  arb?: ArbGasRead | null;
  baseFee?: Record<string, bigint | null>;
  balance?: bigint | null;
  dryQuote?: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  price?: number | null;
  venueTimeoutMs?: number;
};

function depsOf(over: Fakes = {}): PreflightDeps {
  return {
    now: () => NOW,
    arbitrum: async () => (over.arb === undefined ? quietArb() : over.arb),
    baseFee: async (chain) => (over.baseFee === undefined ? 1_000_000_000n : (over.baseFee[chain] ?? null)),
    history: { arb: createGasHistory(), eth: createGasHistory(), base: createGasHistory() },
    venue: {
      dryQuote: over.dryQuote ?? (async () => ({ quote: {} })),
      status: over.status ?? (async () => ({ found: false })),
    },
    balance: async () => (over.balance === undefined ? 50_000_000n : over.balance),
    priceUsd: () => (over.price === undefined ? 4_000 : over.price),
    venueTimeoutMs: over.venueTimeoutMs ?? 10_000,
  };
}

function check(p: Awaited<ReturnType<typeof runPreflight>>, id: string) {
  const c = p.checks.find((x) => x.id === id);
  assert.ok(c, `no ${id} check`);
  return c;
}

test('a quiet hour: five checks, all ok, and the verdict is ok', async () => {
  const p = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf());
  assert.equal(p.at, new Date(NOW).toISOString());
  assert.deepEqual(p.checks.map((c) => c.id), ['gas', 'coverage', 'venue', 'balance', 'deadline']);
  assert.deepEqual(p.checks.map((c) => c.state), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(p.checks.map((c) => c.label), ['Arbitrum gas', 'Fee covers the payout', 'Venue answering', 'Balance', 'Quote still valid']);
  assert.equal(p.verdict, 'ok');
  assert.equal(p.holdReason, undefined);
  const gas = check(p, 'gas');
  assert.equal(gas.value, '237,392 / 300,000');
  assert.deepEqual(gas.series, [237_392]);
  assert.equal(gas.limit, 300_000);
  assert.match(gas.detail, /300,000 gas limit/);
  const coverage = check(p, 'coverage');
  assert.match(coverage.value, /^\d+(\.\d)?x$/);
  assert.equal(check(p, 'balance').value, '50 USDC');
  assert.equal(check(p, 'deadline').value, '10 min');
});

test('the 09-15 replay: the sweep is blocked, the gas check fails and the verdict is hold', async () => {
  const deps = depsOf({ arb: surgeArb() });
  // An hour of quiet readings before the surge, so the sentence can say how far above them it is.
  for (let i = 30; i >= 1; i -= 1) deps.history.arb.push(NOW - i * 60_000, 237_392);
  const p = await runPreflight('hl_deposit', hlDraft(), quoteOf(), deps);
  const gas = check(p, 'gas');
  assert.equal(gas.state, 'fail');
  assert.equal(gas.value, '392,024 / 300,000');
  assert.match(gas.detail, /1\.7x the hourly average/);
  assert.match(gas.detail, /run out of gas/);
  assert.equal(gas.series?.length, 31);
  assert.equal(gas.series?.[30], 392_024);
  assert.equal(p.verdict, 'hold');
  assert.match(p.holdReason ?? '', /^Arbitrum fees are spiking/);
});

// The two dash characters the app never shows, built from their code points.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

// The hold is what the person reads on the card: what is happening, that the money has not
// moved, and when to look again. Plain words, no gas units.
function assertPlainHold(reason: string | undefined): void {
  assert.ok(reason !== undefined, 'a hold carries a reason');
  assert.match(reason, /your money has not moved/i);
  assert.match(reason, /try again in a few minutes/i);
  assert.doesNotMatch(reason, /gas|gwei|L1|relayer|sweep/i);
  assert.doesNotMatch(reason, DASHES);
}

test('an HL deposit fails closed: elevated gas holds it, and so does an Arbitrum that did not answer', async () => {
  const elevated = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf({ arb: arbWithL1(40_000) }));
  assert.equal(check(elevated, 'gas').state, 'fail');
  assert.match(check(elevated, 'gas').detail, /too close to the limit/);
  assert.equal(elevated.verdict, 'hold');
  assertPlainHold(elevated.holdReason);
  assert.match(elevated.holdReason ?? '', /^Arbitrum fees are spiking/);

  const unread = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf({ arb: null }));
  assert.equal(check(unread, 'gas').state, 'fail');
  assert.equal(check(unread, 'gas').value, 'Not read');
  assert.equal(unread.verdict, 'hold');
  assertPlainHold(unread.holdReason);
  assert.match(unread.holdReason ?? '', /^Arbitrum is not answering/);

  const zeroPrice = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf({ arb: quietArb({ perArbGasTotal: 0n }) }));
  assert.equal(zeroPrice.verdict, 'hold', 'a price the app cannot divide by is not a read');
});

test('a plain payout to Arbitrum has no relayer sweep behind it: elevated gas and an unread chain warn there, and only a blocked sweep holds', async () => {
  const elevated = await runPreflight('intents_pay', payDraft({ network: 'arbitrum' }), quoteOf(), depsOf({ arb: arbWithL1(40_000) }));
  assert.equal(check(elevated, 'gas').state, 'warn');
  assert.equal(elevated.verdict, 'ok');
  const unread = await runPreflight('intents_pay', payDraft({ network: 'arbitrum' }), quoteOf(), depsOf({ arb: null }));
  assert.equal(check(unread, 'gas').state, 'warn');
  assert.equal(unread.verdict, 'ok');
});

test('an Ethereum payout reads the base fee against the hourly average: warn above 2x, fail above 4x', async () => {
  const deps = depsOf({ baseFee: { eth: 500_000_000n } });
  for (let i = 10; i >= 1; i -= 1) deps.history.eth.push(NOW - i * 60_000, 0.1);
  const p = await runPreflight('intents_pay', payDraft(), quoteOf(), deps);
  const gas = check(p, 'gas');
  assert.equal(gas.label, 'Ethereum gas');
  assert.equal(gas.value, '0.5 gwei');
  assert.equal(gas.state, 'fail');
  assert.equal(gas.limit, undefined);
  assert.equal(p.verdict, 'hold');
  assert.equal(p.holdReason, 'Waiting for Ethereum gas to settle');

  const warm = depsOf({ baseFee: { eth: 250_000_000n } });
  for (let i = 10; i >= 1; i -= 1) warm.history.eth.push(NOW - i * 60_000, 0.1);
  const w = await runPreflight('intents_pay', payDraft(), quoteOf(), warm);
  assert.equal(check(w, 'gas').state, 'warn');
  assert.equal(w.verdict, 'ok');
});

test('coverage: a fee under the cost of the payout fails and holds; under 1.5x it warns', async () => {
  // 65,000 units at 100 gwei is 0.0065 ETH, $26 at $4,000, against a fee of $0.34.
  const deps = depsOf({ baseFee: { eth: 100_000_000_000n } });
  for (let i = 10; i >= 1; i -= 1) deps.history.eth.push(NOW - i * 60_000, 100);
  const p = await runPreflight('intents_pay', payDraft(), quoteOf(), deps);
  const coverage = check(p, 'coverage');
  assert.equal(coverage.state, 'fail');
  assert.match(coverage.value, /^0\.0x$/);
  assert.match(coverage.detail, /\$0\.34 fee/);
  assert.equal(p.verdict, 'hold');
  assert.equal(p.holdReason, 'Waiting for a fee that covers the payout');

  // 65,000 units at 1 gwei is $0.26: the $0.34 fee covers it 1.3 times, which warns.
  const thin = depsOf({ baseFee: { eth: 1_000_000_000n } });
  for (let i = 10; i >= 1; i -= 1) thin.history.eth.push(NOW - i * 60_000, 1);
  const t = await runPreflight('intents_pay', payDraft(), quoteOf(), thin);
  assert.equal(check(t, 'coverage').state, 'warn');
  assert.equal(check(t, 'coverage').value, '1.3x');
  assert.equal(t.verdict, 'ok');
});

test('coverage with no price for the gas asset warns and says so, never holds', async () => {
  const p = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf({ price: null }));
  assert.equal(check(p, 'coverage').state, 'warn');
  assert.match(check(p, 'coverage').detail, /ETH price/);
  assert.equal(p.verdict, 'ok');
});

test('the venue check: a dry quote past the deadline, or a status endpoint that will not answer, holds', async () => {
  const slow = depsOf({ venueTimeoutMs: 5, dryQuote: () => new Promise((resolve) => setTimeout(() => resolve({}), 40)) });
  const p = await runPreflight('hl_deposit', hlDraft(), quoteOf(), slow);
  assert.equal(check(p, 'venue').state, 'fail');
  assert.match(check(p, 'venue').detail, /did not answer a dry quote within 5 ms/);
  assert.equal(p.verdict, 'hold');
  assert.equal(p.holdReason, 'Waiting for NEAR Intents to answer');

  const down = depsOf({ status: async () => { throw new Error('1click status failed: 503'); } });
  const d = await runPreflight('hl_deposit', hlDraft(), quoteOf(), down);
  assert.equal(check(d, 'venue').state, 'fail');
  assert.match(check(d, 'venue').detail, /status/);
  assert.equal(d.verdict, 'hold');
});

test('the balance check: a verifier balance short of the amount fails the preflight outright, and an unread balance warns', async () => {
  const short = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf({ balance: 9_000_000n }));
  assert.equal(check(short, 'balance').state, 'fail');
  assert.equal(check(short, 'balance').value, '9 USDC');
  assert.equal(short.verdict, 'fail');
  assert.match(short.holdReason ?? '', /balance/i);
  const unread = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf({ balance: null }));
  assert.equal(check(unread, 'balance').state, 'warn');
  assert.equal(unread.verdict, 'ok');
});

test('the deadline check: a quote that expires inside three minutes holds, and a quote with no deadline warns', async () => {
  const soon = await runPreflight('hl_deposit', hlDraft(), quoteOf({ deadline: new Date(NOW + 2 * 60_000).toISOString() }), depsOf());
  assert.equal(check(soon, 'deadline').state, 'fail');
  assert.equal(check(soon, 'deadline').value, '2 min');
  assert.equal(soon.verdict, 'hold');
  assert.equal(soon.holdReason, 'Waiting for a fresh quote');
  const none = await runPreflight('hl_deposit', hlDraft(), quoteOf({ deadline: undefined }), depsOf());
  assert.equal(check(none, 'deadline').state, 'warn');
  assert.equal(none.verdict, 'ok');
});

test('a payout on Arbitrum runs the sweep model too, and a Solana payout says its gas is not read', async () => {
  const arb = await runPreflight('intents_pay', payDraft({ network: 'arbitrum' }), quoteOf(), depsOf({ arb: surgeArb() }));
  assert.equal(check(arb, 'gas').label, 'Arbitrum gas');
  assert.equal(check(arb, 'gas').state, 'fail');
  assert.equal(arb.verdict, 'hold');
  const sol = await runPreflight('intents_pay', payDraft({ network: 'solana' }), quoteOf(), depsOf());
  assert.equal(check(sol, 'gas').label, 'Solana gas');
  assert.equal(check(sol, 'gas').state, 'ok');
  assert.equal(check(sol, 'gas').value, 'Not read');
  assert.equal(check(sol, 'coverage').state, 'ok');
  assert.equal(sol.verdict, 'ok');
});

test('the first failing check names the hold, and a balance failure outranks a gas hold', async () => {
  const p = await runPreflight('hl_deposit', hlDraft(), quoteOf(), depsOf({ arb: surgeArb(), balance: 0n }));
  assert.equal(p.verdict, 'fail');
  assert.match(p.holdReason ?? '', /balance/i);
});

// ---------- the live runner ----------

import { createLivePreflight } from '../../src/preflight/live.ts';

test('the live runner reads Arbitrum through the client it is handed, keeps sampling it after a preflight, and stops on stop()', async () => {
  let clock = NOW;
  let reads = 0;
  const arb = {
    async readContract(args: { functionName: string }) {
      reads += 1;
      if (args.functionName === 'getPricesInWei') return [2_609_956_160n, 18_642_544n, 400_400_000_000n, 20_000_000n, 20_000n, 20_020_000n];
      return 1_165_159n;
    },
    async getBlock() {
      return { baseFeePerGas: 20_000_000n };
    },
  };
  const live = createLivePreflight({
    prices: () => ({ ETH: 4_000 }),
    clients: { arb: arb as never },
    now: () => clock,
    sampleMs: 5,
    fetchImpl: (async () => new Response(JSON.stringify({ result: { result: Array.from(Buffer.from('["50000000"]')) } }), { status: 200 })) as typeof fetch,
  });
  const port = { owner: OWNER, originAsset: hlDraft().originAsset, venue: { dryQuote: async () => ({}), status: async () => ({}) } };
  const first = await live.run('hl_deposit', hlDraft(), quoteOf(), port);
  assert.equal(first.verdict, 'ok');
  assert.deepEqual(check(first, 'gas').series, [237_392]);
  const before = reads;
  clock += 60_000;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(reads > before, 'the sampler kept reading the chain after the preflight');
  const second = await live.run('hl_deposit', hlDraft(), quoteOf(), port);
  assert.ok((check(second, 'gas').series?.length ?? 0) >= 2, 'the second preflight sees the sampled minute');
  live.stop();
  const after = reads;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reads, after, 'nothing reads after stop()');
});
