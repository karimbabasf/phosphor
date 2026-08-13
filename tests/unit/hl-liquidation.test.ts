import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liquidationPrice, distanceToLiquidationPct } from '../../src/hl/liquidation.ts';

// The worked numbers below use maintenance leverages of 2 and 4 so that l is 0.5 and 0.25, both
// exact in binary. That keeps the assertions equalities rather than tolerances, which is what
// catches an operator typo in the formula.

test('a long liquidates below entry', () => {
  // l = 0.5, denom = 1 - 0.5 = 0.5
  // liq = 100 - (1 * 200 / 10) / 0.5 = 100 - 40 = 60
  const liq = liquidationPrice({
    entryPx: 100,
    side: 'long',
    positionSize: 10,
    marginAvailable: 200,
    maintenanceLeverage: 2,
  });
  assert.equal(liq, 60);
  assert.ok(liq < 100, 'a long must liquidate below its entry');
});

test('a short liquidates above entry', () => {
  // l = 0.25, denom = 1 - 0.25 * -1 = 1.25
  // liq = 100 - (-1 * 200 / 10) / 1.25 = 100 + 16 = 116
  const liq = liquidationPrice({
    entryPx: 100,
    side: 'short',
    positionSize: 10,
    marginAvailable: 200,
    maintenanceLeverage: 4,
  });
  assert.equal(liq, 116);
  assert.ok(liq > 100, 'a short must liquidate above its entry');
});

test('thinner margin moves the wall closer on both sides', () => {
  const long = (marginAvailable: number) =>
    liquidationPrice({
      entryPx: 100,
      side: 'long',
      positionSize: 10,
      marginAvailable,
      maintenanceLeverage: 2,
    });
  assert.equal(long(100), 80);
  assert.equal(long(50), 90);
  assert.ok(long(50) > long(100), 'less margin puts a long wall nearer its entry from below');

  const short = (marginAvailable: number) =>
    liquidationPrice({
      entryPx: 100,
      side: 'short',
      positionSize: 10,
      marginAvailable,
      maintenanceLeverage: 4,
    });
  assert.equal(short(100), 108);
  assert.ok(short(100) < short(200), 'less margin puts a short wall nearer its entry from above');
});

test('a realistic 50x maintenance leverage sits close to entry', () => {
  // l = 0.02, denom = 0.98, liq = 100 - (200 / 10) / 0.98
  const liq = liquidationPrice({
    entryPx: 100,
    side: 'long',
    positionSize: 10,
    marginAvailable: 200,
    maintenanceLeverage: 50,
  });
  assert.ok(Math.abs(liq - 79.59183673469388) < 1e-9, `liq was ${liq}`);
});

test('margin far above notional gives a negative liquidation price, not a clamped zero', () => {
  // Nothing on the price axis can liquidate this long, and saying "0" would imply something can.
  const liq = liquidationPrice({
    entryPx: 100,
    side: 'long',
    positionSize: 1,
    marginAvailable: 1000,
    maintenanceLeverage: 2,
  });
  assert.equal(liq, -1900);
});

test('inputs that would produce a nonsense wall are refused', () => {
  const base = {
    entryPx: 100,
    side: 'long' as const,
    positionSize: 10,
    marginAvailable: 200,
    maintenanceLeverage: 2,
  };
  assert.throws(() => liquidationPrice({ ...base, positionSize: 0 }), /positionSize/);
  assert.throws(() => liquidationPrice({ ...base, entryPx: 0 }), /entryPx/);
  assert.throws(() => liquidationPrice({ ...base, maintenanceLeverage: 0 }), /maintenanceLeverage/);
  // A long at maintenance leverage 1 divides by zero: refuse rather than return Infinity.
  assert.throws(() => liquidationPrice({ ...base, maintenanceLeverage: 1 }), /no margin band/);
});

test('distance to liquidation is a percent of the mark price, signed', () => {
  assert.equal(distanceToLiquidationPct(100, 60, 'long'), 40);
  assert.equal(distanceToLiquidationPct(100, 116, 'short'), 16);
  // Already past the wall reads negative, so a supervisor floor of 0 cannot mistake it for safe.
  assert.equal(distanceToLiquidationPct(50, 60, 'long'), -20);
  assert.ok(Math.abs(distanceToLiquidationPct(120, 116, 'short') - -10 / 3) < 1e-12);
  assert.throws(() => distanceToLiquidationPct(0, 60, 'long'), /markPx/);
});
