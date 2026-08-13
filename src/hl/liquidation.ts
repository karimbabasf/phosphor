// Where the position dies, and how far away that is right now.
//
// Hyperliquid's own formula, kept in its documented shape rather than rearranged into something
// tidier, so it can be read against the venue's docs line for line:
//
//   liq = price - side * marginAvailable / positionSize / (1 - l * side)
//   l = 1 / maintenanceLeverage, side = 1 for a long and -1 for a short
//
// Three things a caller has to get right, because none of them can be checked from inside:
//
//   1. `maintenanceLeverage` is not the leverage the position was opened at. On Hyperliquid it
//      is twice the asset's maximum leverage, because maintenance margin is half the initial
//      margin at maximum leverage. Passing the position's own leverage puts the line in the
//      wrong place, and in the safe-looking direction.
//   2. `marginAvailable` is cross margin for a cross position and isolated margin for an
//      isolated one. Cross margin moves when any other position moves, so this number is a
//      snapshot and the answer is only as fresh as it is.
//   3. `positionSize` is size in units of the asset, not dollars.
//
// The result is returned raw, never clamped. A long with margin far above its notional gets a
// negative liquidation price, which is the true statement that price alone cannot liquidate it,
// and clamping that to zero would quietly turn "unreachable" into "reachable at zero".

export function liquidationPrice(a: {
  entryPx: number;
  side: 'long' | 'short';
  positionSize: number;
  marginAvailable: number;
  maintenanceLeverage: number;
}): number {
  const { entryPx, positionSize, marginAvailable, maintenanceLeverage } = a;
  if (!Number.isFinite(entryPx) || entryPx <= 0) {
    throw new Error(`liquidationPrice: entryPx ${entryPx} is not a price`);
  }
  if (!Number.isFinite(positionSize) || positionSize <= 0) {
    throw new Error(`liquidationPrice: positionSize ${positionSize} must be a positive size in units`);
  }
  if (!Number.isFinite(marginAvailable)) {
    throw new Error(`liquidationPrice: marginAvailable ${marginAvailable} is not a number`);
  }
  if (!Number.isFinite(maintenanceLeverage) || maintenanceLeverage <= 0) {
    throw new Error(`liquidationPrice: maintenanceLeverage ${maintenanceLeverage} must be positive`);
  }

  const side = a.side === 'long' ? 1 : -1;
  const l = 1 / maintenanceLeverage;
  const denom = 1 - l * side;
  // A long at maintenanceLeverage 1 divides by zero: the whole notional is maintenance margin,
  // so there is no price that clears it. Infinity would propagate into a chart line and a
  // supervisor threshold, so refuse instead.
  if (denom === 0) {
    throw new Error(`liquidationPrice: maintenanceLeverage ${maintenanceLeverage} leaves no margin band for a ${a.side}`);
  }

  return entryPx - (side * marginAvailable) / positionSize / denom;
}

// Percent of the current mark price that sits between here and liquidation, signed so that a
// position already past its liquidation price reads negative rather than zero. The supervisor
// compares this against a floor, and "past the wall" must never look the same as "at the wall".
export function distanceToLiquidationPct(
  markPx: number,
  liqPx: number,
  side: 'long' | 'short',
): number {
  if (!Number.isFinite(markPx) || markPx <= 0) {
    throw new Error(`distanceToLiquidationPct: markPx ${markPx} is not a price`);
  }
  if (!Number.isFinite(liqPx)) {
    throw new Error(`distanceToLiquidationPct: liqPx ${liqPx} is not a number`);
  }
  const gap = side === 'long' ? markPx - liqPx : liqPx - markPx;
  return (gap / markPx) * 100;
}
