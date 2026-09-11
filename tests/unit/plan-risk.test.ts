// The numbers the policy sees, derived once and only here.
//
// Every position opens isolated, so the margin posted is literally the most the venue can take
// for the plan, and the stop is the most the plan is meant to lose. The wall the human set
// applies to max(margin, max loss). Every refusal below is a refusal at propose AND again in
// the child before it signs, so they are pure functions of the plan and a few venue facts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liquidationPrice } from '../../src/hl/liquidation.ts';
import { changeRisk, planRisk, STOP_SLIP_FRACTION } from '../../src/trade/risk.ts';
import type { RiskInputs } from '../../src/trade/risk.ts';
import type { Plan } from '../../src/trade/plan.ts';

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'pl_1',
    symbol: 'BTC',
    side: 'long',
    sizeUsd: 4000,
    leverage: 20,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 63000,
    target: 66000,
    expiresAt: '2026-09-12T00:00:00.000Z',
    ...over,
  };
}

function inputs(over: Partial<RiskInputs> = {}): RiskInputs {
  return {
    mark: 64000,
    szDecimals: 5,
    maxLeverage: 40,
    freeCollateralUsd: 1000,
    takerFeeBps: 4.5,
    sameCoinLeverage: null,
    ...over,
  };
}

function risk(p: Plan = plan(), i: RiskInputs = inputs()) {
  const out = planRisk(p, i);
  assert.ok(out.ok, out.ok ? '' : out.refusal);
  return out.risk;
}

function refusal(p: Plan, i: RiskInputs = inputs()): string {
  const out = planRisk(p, i);
  assert.equal(out.ok, false, 'expected a refusal');
  return out.ok ? '' : out.refusal;
}

test('margin, max loss, slippage bound and the policy figure', () => {
  const r = risk();
  assert.equal(r.marginUsd, 200, 'sizeUsd / leverage');
  assert.equal(r.entryRef, 64000, 'a market entry is priced at the mark');
  // 1000 / 64000 of 4000 is 62.50, plus 4.5 bps taker both ways on 4000 is 3.60.
  assert.ok(Math.abs(r.maxLossUsd - 66.1) < 1e-9, `maxLossUsd ${r.maxLossUsd}`);
  assert.equal(r.stopSlipUsd, 4000 * STOP_SLIP_FRACTION);
  assert.equal(r.amountUsd, 200, 'max(margin, maxLoss)');
  assert.ok(r.notionalUsd <= 4000 && r.notionalUsd > 3999, 'notional after lot rounding, never above the ask');
});

test('the widest stop that survives the liquidation check still costs less than the margin', () => {
  // Isolated, the venue liquidates at about 1/leverage minus half the maintenance fraction under
  // the entry, so any stop that passes the liquidation refusal loses less than the margin posted.
  // amountUsd is max(margin, maxLoss) all the same, so a fee schedule that changed that would
  // reach the wall without anyone editing this file.
  const r = risk(plan({ stop: 61600 }));
  assert.ok(r.maxLossUsd < r.marginUsd, `${r.maxLossUsd} vs ${r.marginUsd}`);
  assert.equal(r.amountUsd, r.marginUsd);
  assert.ok(r.maxLossUsd > 150, 'and the loss is most of the margin, not a rounding of it');
});

test('the liquidation price is the isolated one from src/hl/liquidation.ts', () => {
  const r = risk();
  const expected = liquidationPrice({
    entryPx: 64000,
    side: 'long',
    positionSize: 4000 / 64000,
    marginAvailable: 200 - 4000 / 80,
    maintenanceLeverage: 80,
  });
  assert.ok(Math.abs(r.liquidationPx - expected) < 1e-9);
  assert.ok(r.liquidationPx < 64000 && r.liquidationPx > 61000, `liq ${r.liquidationPx}`);
});

test('a stop at or beyond liquidation is refused, because the venue gets there first', () => {
  const r = risk();
  // Integers are always on the price grid, so the refusal under test is the liquidation one.
  assert.match(refusal(plan({ stop: Math.floor(r.liquidationPx) - 1 })), /liquidation/);
  assert.match(refusal(plan({ stop: Math.floor(r.liquidationPx) })), /liquidation/);
});

test('notional under $10 after lot rounding is refused', () => {
  // $10.50 of BTC at 64k is 0.000164 BTC, which rounds to 0.00016 at five decimals: $10.24.
  // The venue floor is $10, so this passes; at two decimals it rounds to 0 and is refused.
  assert.match(refusal(plan({ sizeUsd: 11, leverage: 1, stop: 60000 }), inputs({ szDecimals: 2 })), /\$10 minimum/);
  assert.match(refusal(plan({ sizeUsd: 11, leverage: 1, stop: 60000 }), inputs({ szDecimals: 3 })), /\$10 minimum/);
  const fine = planRisk(plan({ sizeUsd: 11, leverage: 1, stop: 60000 }), inputs({ szDecimals: 5 }));
  assert.equal(fine.ok, true);
});

test('the stop and the target must sit on the right side of the entry and of the mark', () => {
  assert.match(refusal(plan({ stop: 65000 })), /stop/);
  assert.match(refusal(plan({ target: 63500 })), /target/);
  // A limit entry below the mark: the stop can sit between the two and still be refused, because
  // it is on the wrong side of the mark right now.
  assert.match(refusal(plan({ entry: { type: 'limit', px: 62000 }, stop: 63000 })), /stop/);
  // Short: mirrored.
  const short = plan({ side: 'short', stop: 65000, target: 62000 });
  assert.equal(planRisk(short, inputs()).ok, true);
  assert.match(refusal(plan({ side: 'short', stop: 63000, target: 62000 })), /stop/);
  assert.match(refusal(plan({ side: 'short', stop: 65000, target: 64500 })), /target/);
});

test('a stop entry must sit past the mark in the direction of the trade', () => {
  assert.match(refusal(plan({ entry: { type: 'stop', px: 63500, maxSlippageBps: 30 }, stop: 63000 })), /stop entry/);
  assert.equal(planRisk(plan({ entry: { type: 'stop', px: 64500, maxSlippageBps: 30 }, stop: 63000 }), inputs()).ok, true);
});

test('an off-grid price is refused by name rather than rounded in silence', () => {
  assert.match(refusal(plan({ stop: 63000.123 })), /stop .* grid/);
  assert.match(refusal(plan({ entry: { type: 'limit', px: 63500.5 } })), /entry .* grid/);
  assert.match(refusal(plan({ target: 66000.5 })), /target .* grid/);
});

test('leverage above the coin maximum and leverage that disagrees with the coin are refused', () => {
  assert.match(refusal(plan({ leverage: 41 })), /40x/);
  assert.match(refusal(plan(), inputs({ sameCoinLeverage: 10 })), /10x/);
  assert.equal(planRisk(plan(), inputs({ sameCoinLeverage: 20 })).ok, true);
  // The fixture's own stop, 1.56% under the entry, is past liquidation at 40x: the venue would
  // take the position first, so the plan is refused rather than priced.
  assert.match(refusal(plan({ leverage: 40 })), /liquidation/);
});

test('margin above free collateral is refused; unknown collateral is not a refusal', () => {
  assert.match(refusal(plan(), inputs({ freeCollateralUsd: 50 })), /collateral/);
  assert.equal(planRisk(plan(), inputs({ freeCollateralUsd: null })).ok, true);
});

test('no mark yet is a refusal, not a plan priced at zero', () => {
  assert.match(refusal(plan(), inputs({ mark: 0 })), /mark/);
  assert.match(refusal(plan(), inputs({ mark: Number.NaN })), /mark/);
});

test('a change that tightens the stop is free; one that widens it is priced', () => {
  const approved = risk();
  const tighter = changeRisk(plan(), approved, { stop: 63500 }, inputs());
  assert.ok(tighter.ok);
  assert.equal(tighter.ok && tighter.widens, false);
  assert.ok(tighter.ok && tighter.risk.maxLossUsd < approved.maxLossUsd);

  const wider = changeRisk(plan(), approved, { stop: 62000 }, inputs());
  assert.ok(wider.ok);
  assert.equal(wider.ok && wider.widens, true);
  assert.ok(wider.ok && wider.risk.maxLossUsd > approved.maxLossUsd);

  // A target move never changes the loss, so it never widens.
  const target = changeRisk(plan(), approved, { target: 70000 }, inputs());
  assert.ok(target.ok && !target.widens);

  // The same side rules apply to the new levels.
  const wrong = changeRisk(plan(), approved, { stop: 65000 }, inputs());
  assert.equal(wrong.ok, false);
});

test('a change on an open plan measures against the fill, not the plan', () => {
  const approved = risk();
  const filled = changeRisk(plan(), approved, { stop: 63500 }, inputs({ entryPx: 64500 }));
  assert.ok(filled.ok);
  assert.equal(filled.ok ? filled.risk.entryRef : 0, 64500);
});
