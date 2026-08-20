// The yield feature's arithmetic, and the three refusals that make its numbers honest.
//
// Everything asserted here is a claim the WINDOW makes to a person about their money, so
// each test is written against the sentence it protects rather than against the function.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aprFromRay,
  apyFromApr,
  fromBaseUnits,
  rateFromRay,
  toBaseUnits,
  RAY,
} from '../../src/yield/venue.ts';
import {
  MIN_ANNUALISE_MS,
  OBSERVATION_CAVEAT,
  avgPrincipalBase,
  creditsFor,
  openedAtFrom,
  principalFrom,
  realizedFrom,
  windowLabel,
} from '../../src/yield/positions.ts';
import type { YieldCredit } from '../../src/yield/positions.ts';
import { decodeReserveHealth, aaveAsset, aaveChains, marketFor } from '../../src/yield/aave.ts';
import { rebalanceWorthIt, REBALANCE_HORIZON_DAYS } from '../../src/yield/allocator.ts';
import type { Proposal } from '../../src/types.ts';

// ---------- rates ----------

test('a RAY rate becomes the fraction the venue means by it', () => {
  // 4.2687 percent, the live Arbitrum Sepolia USDC supply rate on 2026-08-20.
  const ray = 42687000000000000000000000n;
  assert.equal(Math.round(aprFromRay(ray) * 10_000) / 10_000, 0.0427);
});

test('APY is above APR, because Aave compounds every second', () => {
  const apr = 0.042687;
  const apy = apyFromApr(apr);
  assert.ok(apy > apr, 'compounding must not lower the rate');
  // e^0.042687 - 1 = 0.043611...
  assert.equal(apy.toFixed(6), '0.043611');
});

test('the raw rate crosses the wire as a STRING, because a bigint takes the whole payload down', () => {
  const rate = rateFromRay(42687000000000000000000000n);
  assert.equal(typeof rate.aprRay, 'string');
  // The regression this guards: JSON.stringify THROWS on a bigint rather than skipping the
  // field, so one wrongly typed lending rate returned a 500 for /api/state and blanked every
  // panel in the window, not just this one.
  assert.doesNotThrow(() => JSON.stringify(rate));
  assert.equal(JSON.parse(JSON.stringify(rate)).aprRay, '42687000000000000000000000');
});

test('RAY is 1e27 and nothing else', () => {
  assert.equal(RAY, 10n ** 27n);
});

// ---------- base units ----------

test('base units go through a decimal string, never through a float multiply', () => {
  assert.equal(toBaseUnits(50, 6), 50_000_000n);
  assert.equal(toBaseUnits(56.292032, 6), 56_292_032n);
  // The case that motivates the rule: at 18 decimals the naive product is past
  // Number.MAX_SAFE_INTEGER and the low digits are rounding noise.
  assert.equal(toBaseUnits(1.234567890123456, 18), 1_234_567_890_123_456_000n);
});

test('this toBaseUnits agrees with the uniswap rail\'s, which is the drift guard for the third copy', async () => {
  // src/intents.ts and src/rails/uniswap.ts each already carry one of these. A third
  // implementation is a third chance to be subtly different about someone's money, so the
  // agreement is asserted rather than assumed. If this test starts failing, the copies have
  // drifted and one of them is now sending a different number than the others.
  const uni = await import('../../src/rails/uniswap.ts');
  const amounts = [50, 56.292032, 0.000001, 100, 1234.5678901234567, 0.3, 0.1, 1, 12345.678];
  for (const a of amounts) {
    for (const d of [6, 18]) {
      assert.equal(toBaseUnits(a, d), uni.toBaseUnits(a, d), `${a} at ${d} decimals`);
    }
  }
});

test('a tiny amount survives the trip, because early yield is all tiny amounts', () => {
  assert.equal(toBaseUnits(0.000012, 6), 12n);
  assert.equal(fromBaseUnits(12n, 6), 0.000012);
});

test('fromBaseUnits keeps the sign, so a loss reads as a loss', () => {
  assert.equal(fromBaseUnits(-45n, 6), -0.000045);
});

// ---------- cost basis ----------

function credit(kind: 'deposit' | 'withdraw', amountBase: string, at: string): YieldCredit {
  return { at, kind, amountBase, amountUsd: Number(amountBase) / 1e6, txids: ['0xabc'], proposalId: 'p' };
}

test('principal is deposits minus withdrawals, and interest never touches it', () => {
  const credits = [
    credit('deposit', '50000000', '2026-08-20T18:35:22Z'),
    credit('deposit', '6292032', '2026-08-20T18:43:19Z'),
  ];
  assert.equal(principalFrom(credits), 56_292_032n);
});

test('a full exit cannot drive the cost basis negative', () => {
  // A withdrawal takes out principal AND the interest sitting on top of it, so it is larger
  // than anything that was ever deposited. Without the clamp the basis goes negative and the
  // next deposit reports a fortune it never made.
  const credits = [
    credit('deposit', '50000000', '2026-08-20T18:00:00Z'),
    credit('withdraw', '50000045', '2026-08-20T19:00:00Z'),
  ];
  assert.equal(principalFrom(credits), 0n);
});

test('the window starts when the CURRENT run of exposure started, not at the first deposit ever', () => {
  const credits = [
    credit('deposit', '50000000', '2026-06-01T00:00:00Z'),
    credit('withdraw', '50000000', '2026-06-02T00:00:00Z'),
    credit('deposit', '25000000', '2026-08-20T00:00:00Z'),
  ];
  // Measuring from June would divide by the wrong number and under-report the rate by an
  // order of magnitude on a position that has been working for hours.
  assert.equal(openedAtFrom(credits), '2026-08-20T00:00:00Z');
});

test('a closed position has no open window at all', () => {
  const credits = [
    credit('deposit', '50000000', '2026-08-20T00:00:00Z'),
    credit('withdraw', '50000000', '2026-08-20T06:00:00Z'),
  ];
  assert.equal(openedAtFrom(credits), null);
});

// ---------- the percentage ----------

test('average principal is TIME WEIGHTED, so a late top-up is not counted as though it had been working all along', () => {
  const from = Date.parse('2026-08-20T00:00:00Z');
  const to = Date.parse('2026-08-20T10:00:00Z');
  const credits = [
    credit('deposit', '100000000', '2026-08-20T00:00:00Z'), // 100 for the whole 10 hours
    credit('deposit', '100000000', '2026-08-20T05:00:00Z'), // another 100 for the last 5
  ];
  // 100 for 5 hours then 200 for 5 hours averages 150, not the 200 standing at the end.
  assert.equal(avgPrincipalBase(credits, from, to), 150_000_000);
});

test('under an hour, no percentage is produced at all', () => {
  const opened = '2026-08-20T18:35:22Z';
  const r = realizedFrom({
    credits: [credit('deposit', '50000000', opened)],
    openedAt: opened,
    earnedBase: 12n,
    decimals: 6,
    priceUsd: 1,
    nowMs: Date.parse(opened) + 10 * 60 * 1000,
  });
  assert.ok(r !== null);
  // Annualising ten minutes of interest is arithmetically correct and rhetorically a lie.
  assert.equal(r.annualisedPct, null);
  assert.equal(r.earnedUsd, 0.000012);
  assert.equal(r.windowLabel, '10 minutes');
});

test('past an hour the percentage appears, and it is the realized one', () => {
  const opened = '2026-08-20T00:00:00Z';
  // $100 that made 1 cent in exactly one day annualises to 3.65 percent.
  const r = realizedFrom({
    credits: [credit('deposit', '100000000', opened)],
    openedAt: opened,
    earnedBase: 10_000n,
    decimals: 6,
    priceUsd: 1,
    nowMs: Date.parse(opened) + 24 * 60 * 60 * 1000,
  });
  assert.ok(r !== null && r.annualisedPct !== null);
  assert.equal(r.annualisedPct.toFixed(2), '3.65');
  assert.equal(r.avgPrincipalUsd, 100);
  assert.equal(r.windowLabel, '24 hours');
});

test('the caveat travels with the number, so a renderer cannot forget it', () => {
  const opened = '2026-08-20T00:00:00Z';
  const r = realizedFrom({
    credits: [credit('deposit', '100000000', opened)],
    openedAt: opened,
    earnedBase: 10_000n,
    decimals: 6,
    priceUsd: 1,
    nowMs: Date.parse(opened) + 24 * 60 * 60 * 1000,
  });
  assert.equal(r?.caveat, OBSERVATION_CAVEAT);
  assert.match(OBSERVATION_CAVEAT, /not promised/);
});

test('a closed position produces no realized figure rather than a zero', () => {
  assert.equal(
    realizedFrom({ credits: [], openedAt: null, earnedBase: 0n, decimals: 6, priceUsd: 1, nowMs: Date.now() }),
    null,
  );
});

test('the annualise floor is one hour', () => {
  assert.equal(MIN_ANNUALISE_MS, 3_600_000);
});

test('windows read as a person would say them', () => {
  assert.equal(windowLabel(60_000), '1 minute');
  assert.equal(windowLabel(10 * 60_000), '10 minutes');
  assert.equal(windowLabel(3 * 3_600_000), '3 hours');
  assert.equal(windowLabel(7 * 86_400_000), '7 days');
});

// ---------- the ledger, from the proposal store ----------

function executedProposal(kind: 'yield_deposit' | 'yield_withdraw', amountBase: string, at: string, ok = true): Proposal {
  return {
    id: `p-${at}`,
    kind,
    createdAt: at,
    status: ok ? 'executed' : 'failed',
    draft: { kind, venue: 'aave-v3', chain: 'arb', symbol: 'USDC', amount: 1, amountBase, decimals: 6, amountUsd: 1, from: '0x', counterparty: '0x' } as never,
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    decidedAt: at,
    result: { ok, detail: '', txids: ['0xhash'] },
  } as Proposal;
}

test('only proposals that actually moved money reach the ledger', () => {
  const list = [
    executedProposal('yield_deposit', '50000000', '2026-08-20T01:00:00Z', true),
    executedProposal('yield_deposit', '99000000', '2026-08-20T02:00:00Z', false), // failed
    { ...executedProposal('yield_deposit', '77000000', '2026-08-20T03:00:00Z'), status: 'pending' } as Proposal,
  ];
  const credits = creditsFor(list, 'aave-v3', 'arb', 'USDC');
  // Counting the failed or the pending one would inflate the cost basis, which shows up as a
  // SMALLER earned figure. Wrong in the flattering direction is still wrong.
  assert.equal(credits.length, 1);
  assert.equal(principalFrom(credits), 50_000_000n);
});

test('another chain and another symbol do not leak into this position', () => {
  const list = [executedProposal('yield_deposit', '50000000', '2026-08-20T01:00:00Z')];
  assert.equal(creditsFor(list, 'aave-v3', 'base', 'USDC').length, 0);
  assert.equal(creditsFor(list, 'aave-v3', 'arb', 'USDT').length, 0);
});

// ---------- the reserve's own flags ----------

test('the reserve configuration bitmap decodes to the flags that decide whether a deposit can work', () => {
  const active = 1n << 56n;
  const frozen = 1n << 57n;
  const paused = 1n << 60n;
  assert.deepEqual(decodeReserveHealth(active), { active: true, frozen: false, paused: false, supplyCapUnits: 0n });
  assert.equal(decodeReserveHealth(active | frozen).frozen, true);
  assert.equal(decodeReserveHealth(active | paused).paused, true);
  assert.equal(decodeReserveHealth(0n).active, false);
  // supplyCap sits at bits 116..151 in WHOLE units of the asset.
  assert.equal(decodeReserveHealth(active | (10_500_000n << 116n)).supplyCapUnits, 10_500_000n);
});

// ---------- the verified deployment table ----------

test('mainnet has no verified deployment, so the table itself refuses before the rail does', () => {
  assert.deepEqual(aaveChains('mainnet'), []);
  assert.throws(() => marketFor('mainnet', 'base'), /no verified deployment/);
});

test('the testnet USDC is the SAME token the uniswap rail already knows on arb', async () => {
  const { tokenFor } = await import('../../src/rails/uniswap-abi.ts');
  const aave = aaveAsset('testnet', 'arb', 'USDC');
  assert.ok(aave !== null);
  // This is what makes the feature free to fund: the existing swap rail produces exactly the
  // token this one consumes. Two different USDC addresses would mean a second funding step
  // for a human, and a silent one.
  assert.equal(aave.address.toLowerCase(), tokenFor('testnet', 'arb', 'USDC').address.toLowerCase());
});

test('ethereum sepolia is deliberately absent', () => {
  // Its market reports 57 percent on USDC, an artefact of a testnet nobody arbitrages. A
  // window whose headline number is 57 percent teaches the reader to distrust every other
  // number in it.
  assert.equal(aaveAsset('testnet', 'eth', 'USDC'), null);
});

// ---------- the allocator's economics ----------

test('a rebalance that costs more than it earns is refused', () => {
  const v = rebalanceWorthIt({ principalUsd: 50, currentApy: 0.0124, bestApy: 0.0436, moveCostUsd: 0.5 });
  // 50 dollars at a 3.12 point spread over 30 days is about 13 cents, against 50 cents to move.
  assert.equal(v.worth, false);
  assert.match(v.reason, /loses money/);
});

test('the same spread on enough principal is worth taking', () => {
  const v = rebalanceWorthIt({ principalUsd: 5000, currentApy: 0.0124, bestApy: 0.0436, moveCostUsd: 0.5 });
  assert.equal(v.worth, true);
  assert.ok(v.gainUsd > 0.5);
});

test('the loop never chases a spread that runs the wrong way', () => {
  const v = rebalanceWorthIt({ principalUsd: 100000, currentApy: 0.0436, bestApy: 0.0124, moveCostUsd: 0 });
  assert.equal(v.worth, false);
  assert.match(v.reason, /already the best/);
});

test('the horizon a move has to repay inside is thirty days', () => {
  assert.equal(REBALANCE_HORIZON_DAYS, 30);
});
