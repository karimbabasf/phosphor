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
  basisFrom,
  creditsFor,
  openedAtFrom,
  principalFrom,
  realizedFrom,
  windowLabel,
} from '../../src/yield/positions.ts';
import type { YieldCredit } from '../../src/yield/positions.ts';
import { decodeReserveHealth, aaveAsset, aaveChains, marketFor } from '../../src/yield/aave.ts';
import {
  MAX_BACKOFF_MS,
  PROPOSE_COOLDOWN_MS,
  actionGate,
  backoffMs,
  countsAsFailure,
  pickIdleVenue,
  rebalanceWorthIt,
  REBALANCE_HORIZON_DAYS,
} from '../../src/yield/allocator.ts';
import type { Proposal } from '../../src/types.ts';
import type { VenueQuote } from '../../src/yield/allocator.ts';

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

test('a balance with no deposit behind it has an UNKNOWN basis, not a zero one', () => {
  // The defect this replaces, found 2026-08-20 by running scripts/e2e.ts on a throwaway data
  // dir against a live 56.29 USDC Aave position: principalFrom([]) is correctly 0n, because
  // zero is genuinely what this app put in, and `balance - 0` then reported the whole
  // position as interest earned. A fresh install, a store restored short of the deposit, and
  // a position supplied with this key outside the app all land here.
  const basis = basisFrom([], 56_293_621n);
  assert.equal(basis.basisKnown, false);
  assert.equal(basis.principalBase, null);
  // Null rather than 0n. Zero would render as "$0.00 earned", which is the same lie pointing
  // the other way: it says a position that may have earned for months has earned nothing.
  assert.equal(basis.earnedBase, null);
});

test('a balance with a deposit behind it earns the difference, and says the basis is known', () => {
  const credits = [credit('deposit', '50000000', '2026-08-20T18:35:22Z')];
  const basis = basisFrom(credits, 50_000_012n);
  assert.equal(basis.basisKnown, true);
  assert.equal(basis.principalBase, 50_000_000n);
  assert.equal(basis.earnedBase, 12n);
});

test('a fully closed position keeps a KNOWN basis of zero, which is not the unknown case', () => {
  // The two states look identical in the arithmetic and are opposite in meaning. Here the app
  // has the whole history and the history says nothing is supplied; above it has no history
  // at all. Distinguishing them on credits.length rather than on the principal is what keeps
  // a closed position from reporting its next dust balance as pure profit.
  const credits = [
    credit('deposit', '50000000', '2026-08-20T18:35:22Z'),
    credit('withdraw', '56292312', '2026-08-20T19:37:16Z'),
  ];
  const basis = basisFrom(credits, 0n);
  assert.equal(basis.basisKnown, true);
  assert.equal(basis.principalBase, 0n);
  assert.equal(basis.earnedBase, 0n);
});

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

// ---------- the loop's brakes ----------
//
// These exist because of an audit finding, not a hypothetical. Before them the loop re-filed
// the same proposal on every tick for as long as the condition held: proposals.json rewrites
// its whole array per put, so the disk cost was quadratic, and an approve that landed with a
// supply that reverted was one real gas payment per minute for as long as nobody looked.

test('the cooldown is longer than the tick, or the loop can act on every look', () => {
  assert.ok(PROPOSE_COOLDOWN_MS > 60_000);
});

test('backoff doubles per consecutive failure and stops at four hours', () => {
  assert.equal(backoffMs(0), PROPOSE_COOLDOWN_MS);
  assert.equal(backoffMs(1), PROPOSE_COOLDOWN_MS * 2);
  assert.equal(backoffMs(3), PROPOSE_COOLDOWN_MS * 8);
  assert.equal(backoffMs(99), MAX_BACKOFF_MS);
  assert.ok(backoffMs(99) <= MAX_BACKOFF_MS);
});

test('inside the cooldown the loop may not act, however many times it looks', () => {
  const t0 = 1_000_000;
  // Six ticks a minute apart. Before the cooldown existed every one of them filed a proposal.
  for (let i = 1; i <= 6; i++) {
    const g = actionGate({ lastProposalAtMs: t0, failureStreak: 0, nowMs: t0 + i * 60_000 });
    assert.equal(g.allowed, false, `tick ${i} must not be allowed to act`);
  }
  // Past it, acting is allowed again: the money is still doing nothing and backing off
  // forever would be its own failure.
  const after = actionGate({ lastProposalAtMs: t0, failureStreak: 0, nowMs: t0 + PROPOSE_COOLDOWN_MS + 1 });
  assert.equal(after.allowed, true);
});

test('the very first action is never gated', () => {
  assert.equal(actionGate({ lastProposalAtMs: null, failureStreak: 0, nowMs: 1 }).allowed, true);
});

test('a refusal widens the gap; one plain cooldown is no longer enough', () => {
  const t0 = 1_000_000;
  const justPastBase = t0 + PROPOSE_COOLDOWN_MS + 1;
  assert.equal(actionGate({ lastProposalAtMs: t0, failureStreak: 0, nowMs: justPastBase }).allowed, true);
  assert.equal(actionGate({ lastProposalAtMs: t0, failureStreak: 1, nowMs: justPastBase }).allowed, false);
  assert.equal(
    actionGate({ lastProposalAtMs: t0, failureStreak: 1, nowMs: t0 + PROPOSE_COOLDOWN_MS * 2 + 1 }).allowed,
    true,
  );
});

test('a proposal waiting on a human is not a failure, so the gate does not punish the gate', () => {
  assert.equal(countsAsFailure('pending'), false);
  assert.equal(countsAsFailure('executed'), false);
  assert.equal(countsAsFailure('policy_refused'), true);
  assert.equal(countsAsFailure('failed'), true);
  assert.equal(countsAsFailure('refused'), true);
});

// ---------- where idle money goes ----------

function quote(chain: 'arb' | 'base' | 'eth', apy: number, idleUsd: number, healthy = true): VenueQuote {
  return {
    venue: 'aave-v3',
    chain,
    symbol: 'USDC',
    rate: { aprRay: '0', apr: apy, apy },
    healthy,
    note: healthy ? '' : 'reserve frozen',
    idleBase: String(Math.round(idleUsd * 1e6)),
    idleUsd,
  };
}

test('idle money is deposited where it already sits, not only on the best-paying chain', () => {
  // The bug this replaces: only the best chain was considered, so $500 idle on base was left
  // earning nothing because arb paid ten basis points more, and the loop then reported that
  // nothing was idle at all. A local deposit needs no bridge, so there is nothing to trade off.
  const picked = pickIdleVenue([quote('arb', 0.0436, 0), quote('base', 0.0124, 500)], 5);
  assert.equal(picked?.chain, 'base');
});

test('among chains that both hold idle money, the best-paying one wins', () => {
  const picked = pickIdleVenue([quote('base', 0.0124, 100), quote('arb', 0.0436, 100)], 5);
  assert.equal(picked?.chain, 'arb');
});

test('dust is left alone, because a deposit is two transactions and a human click', () => {
  assert.equal(pickIdleVenue([quote('arb', 0.0436, 3)], 5), undefined);
});

test('an unhealthy venue is never a destination, however much is idle on it', () => {
  assert.equal(pickIdleVenue([quote('arb', 0.0436, 5000, false)], 5), undefined);
});
