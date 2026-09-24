// What a plan puts at stake, derived once, in one place, from the plan and a few venue facts.
//
// Every position opens ISOLATED, and that is what makes these numbers true rather than
// estimates. Cross margin backs a position with the whole account, so "collateral at stake"
// would be a figure the venue does not enforce. Isolated, the margin posted is literally the
// most the venue can take for this plan, and the stop is the most the plan means to lose.
//
// The policy wall reads amountUsd = max(margin, max loss). Stated consequence: leverage lowers
// margin, so a $4,000 notional at 40x with a tight stop is $100 of collateral and passes a $100
// threshold. Max loss and the stop slippage bound are on the card so nothing is hidden, and a
// wide stop raises the figure the wall sees.
//
// Pure, with no clock and no network, because it runs twice on the same plan: at propose, where
// the human reads the refusal, and again inside the child before it signs.

import { formatPrice, formatSize } from '../hl/format.ts';
import { liquidationPrice } from '../hl/liquidation.ts';
import type { Plan } from './plan.ts';

export type PlanRisk = {
  marginUsd: number;
  maxLossUsd: number;
  // The venue's own slippage tolerance on a triggered stop market order is 10%. Shown beside
  // max loss, never hidden: it is the difference between the stop as a line and the stop as a fill.
  stopSlipUsd: number;
  entryRef: number;
  liquidationPx: number;
  // After lot rounding, which only ever makes it smaller than the ask.
  notionalUsd: number;
  // What the policy engine reads: max(marginUsd, maxLossUsd).
  amountUsd: number;
};

export type RiskInputs = {
  mark: number;
  szDecimals: number;
  // Null when the venue's metadata for the coin has not loaded: nothing can be sized then.
  maxLeverage: number | null;
  freeCollateralUsd: number | null;
  takerFeeBps: number;
  // The id of another live plan on the same coin, or null. One plan holds a coin at a time
  // (see sameCoinRefusal), which also keeps the coin's one venue-wide setting its own.
  sameCoinPlan: string | null;
  // The fill price of a plan that is already open. A change on an open plan measures its loss
  // from where the position actually was opened, not from where the plan meant to.
  entryPx?: number;
};

export const STOP_SLIP_FRACTION = 0.1;
export const DEFAULT_TAKER_FEE_BPS = 4.5;
export const VENUE_MIN_NOTIONAL_USD = 10;
// Maintenance margin on this venue is half the initial margin at the asset's maximum leverage.
const MAINTENANCE_DIVISOR = 2;

type Outcome = { ok: true; risk: PlanRisk } | { ok: false; refusal: string };

function refuse(refusal: string): Outcome {
  return { ok: false, refusal };
}

function onGrid(px: number, szDecimals: number): boolean {
  try {
    formatPrice(px, szDecimals, true);
    return true;
  } catch {
    return false;
  }
}

/* ONE PLAN PER COIN. The venue keeps one position per coin, and a plan's stop and target are
   sized to that position: a second plan on the coin would take the first one's fill as its own,
   put exits on the whole position at its own stop, and report numbers that belong to neither.
   So a coin with a live plan takes no second one until the first is done. */
export function sameCoinRefusal(symbol: string, otherId: string): string {
  return (
    `${symbol} already has a live plan (${otherId}), and the venue keeps one position per coin, so a second ` +
    `plan would share it. Change or cancel ${otherId} first`
  );
}

function gridRefusal(what: string, px: number, szDecimals: number): string {
  return (
    `${what} ${String(px)} is off the venue's price grid: at most 5 significant figures and ` +
    `${6 - szDecimals} decimals for this coin, or any whole number`
  );
}

export function planRisk(plan: Plan, i: RiskInputs): Outcome {
  if (i.maxLeverage === null) {
    return refuse(`the venue's details for ${plan.symbol} have not loaded yet (the app keeps asking Hyperliquid for them), so the plan cannot be priced; try again in a minute`);
  }
  if (!Number.isFinite(i.mark) || i.mark <= 0) return refuse(`no mark price for ${plan.symbol} yet, so the plan cannot be priced`);
  if (plan.leverage > i.maxLeverage) {
    return refuse(`leverage ${plan.leverage}x is above the ${i.maxLeverage}x maximum the venue allows on ${plan.symbol}`);
  }
  if (i.sameCoinPlan !== null) return refuse(sameCoinRefusal(plan.symbol, i.sameCoinPlan));

  const long = plan.side === 'long';
  const entryRef = i.entryPx ?? (plan.entry.type === 'market' ? i.mark : plan.entry.px);

  if (plan.entry.type !== 'market' && !onGrid(plan.entry.px, i.szDecimals)) {
    return refuse(gridRefusal('entry', plan.entry.px, i.szDecimals));
  }
  if (!onGrid(plan.stop, i.szDecimals)) return refuse(gridRefusal('stop', plan.stop, i.szDecimals));
  if (plan.target !== undefined && !onGrid(plan.target, i.szDecimals)) {
    return refuse(gridRefusal('target', plan.target, i.szDecimals));
  }

  // A stop entry is a trigger the venue fires when the mark crosses it in the direction of the
  // trade. A buy stop below the mark would fire at once, which is a market order dressed up.
  // Once the entry has a fill the trigger has already fired, and the mark sitting past it is
  // exactly what fired it, so the rule is for a plan that has not entered yet.
  if (plan.entry.type === 'stop' && i.entryPx === undefined) {
    const past = long ? plan.entry.px > i.mark : plan.entry.px < i.mark;
    if (!past) {
      return refuse(
        `a stop entry for a ${plan.side} must sit ${long ? 'above' : 'below'} the mark (${String(i.mark)}); ` +
          'use a limit entry to enter on the other side of it',
      );
    }
  }

  const losing = (px: number): boolean => (long ? px < entryRef && px < i.mark : px > entryRef && px > i.mark);
  const winning = (px: number): boolean => (long ? px > entryRef && px > i.mark : px < entryRef && px < i.mark);
  if (!losing(plan.stop)) {
    return refuse(
      `the stop at ${String(plan.stop)} must sit ${long ? 'below' : 'above'} both the entry (${String(entryRef)}) ` +
        `and the mark (${String(i.mark)}) for a ${plan.side}`,
    );
  }
  if (plan.target !== undefined && !winning(plan.target)) {
    return refuse(
      `the target at ${String(plan.target)} must sit ${long ? 'above' : 'below'} both the entry (${String(entryRef)}) ` +
        `and the mark (${String(i.mark)}) for a ${plan.side}`,
    );
  }

  // Lot rounding, toward zero, the way the order will be sized. formatSize throws when the size
  // rounds to nothing, which is the same refusal as being under the floor.
  let sizeCoin: number;
  try {
    sizeCoin = Number(formatSize(plan.sizeUsd / entryRef, i.szDecimals));
  } catch {
    sizeCoin = 0;
  }
  const notionalUsd = sizeCoin * entryRef;
  if (notionalUsd < VENUE_MIN_NOTIONAL_USD) {
    return refuse(
      `$${plan.sizeUsd.toFixed(2)} of ${plan.symbol} rounds to ${String(sizeCoin)} coin at ${entryRef}, ` +
        `$${notionalUsd.toFixed(2)} of notional, under the venue's $10 minimum`,
    );
  }

  const marginUsd = plan.sizeUsd / plan.leverage;
  const feeUsd = 2 * plan.sizeUsd * (i.takerFeeBps / 10_000);
  const maxLossUsd = (Math.abs(entryRef - plan.stop) / entryRef) * plan.sizeUsd + feeUsd;
  const stopSlipUsd = plan.sizeUsd * STOP_SLIP_FRACTION;

  const maintenanceLeverage = MAINTENANCE_DIVISOR * i.maxLeverage;
  const liquidationPx = liquidationPrice({
    entryPx: entryRef,
    side: plan.side,
    positionSize: plan.sizeUsd / entryRef,
    marginAvailable: marginUsd - plan.sizeUsd / maintenanceLeverage,
    maintenanceLeverage,
  });
  const pastLiquidation = long ? plan.stop <= liquidationPx : plan.stop >= liquidationPx;
  if (pastLiquidation) {
    return refuse(
      `the stop at ${String(plan.stop)} is at or past the liquidation price (${liquidationPx.toFixed(2)}) at ${plan.leverage}x; ` +
        'the venue would take the position before the stop fires. Lower the leverage or tighten the stop',
    );
  }

  if (i.freeCollateralUsd !== null && marginUsd > i.freeCollateralUsd) {
    return refuse(
      `the plan needs $${marginUsd.toFixed(2)} of collateral and $${i.freeCollateralUsd.toFixed(2)} is free on the venue`,
    );
  }

  return {
    ok: true,
    risk: {
      marginUsd,
      maxLossUsd,
      stopSlipUsd,
      entryRef,
      liquidationPx,
      notionalUsd,
      amountUsd: Math.max(marginUsd, maxLossUsd),
    },
  };
}

// A change to the exits. Tightening costs nothing at the wall; widening is priced like a new
// plan and, once landed, becomes the plan's approved figure.
export function changeRisk(
  plan: Plan,
  approved: PlanRisk,
  change: { stop?: number; target?: number },
  i: RiskInputs,
): { ok: true; risk: PlanRisk; widens: boolean } | { ok: false; refusal: string } {
  const next: Plan = { ...plan };
  if (change.stop !== undefined) next.stop = change.stop;
  if (change.target !== undefined) next.target = change.target;
  const out = planRisk(next, i);
  if (!out.ok) return out;
  return { ok: true, risk: out.risk, widens: out.risk.maxLossUsd > approved.maxLossUsd + 1e-9 };
}
