import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, roundToValidPrice } from '../../src/hl/format.ts';

// The exact number that killed the first live order this code ever attempted.
const LIVE_FAILURE = 63980.30999999999;

test('the price that broke the first live order now formats', () => {
  const px = roundToValidPrice(LIVE_FAILURE, 5, true, true);
  assert.equal(px, 63980, 'five figures leaves no room for decimals, and integers are always valid');
  assert.doesNotThrow(() => formatPrice(px, 5, true));
});

test('a buy rounds down and a sell rounds up, so neither breaches its bound', () => {
  // A buy limit is the MOST it may pay; a sell limit the LEAST it may accept. Rounding the
  // other way would push the fill past the bound the human approved.
  assert.ok(roundToValidPrice(LIVE_FAILURE, 5, true, true) <= LIVE_FAILURE);
  assert.ok(roundToValidPrice(LIVE_FAILURE, 5, true, false) >= LIVE_FAILURE);
  assert.equal(roundToValidPrice(LIVE_FAILURE, 5, true, false), 63981);
});

test('a low-priced asset keeps the decimals it is allowed', () => {
  // ETH at szDecimals 4 allows 2 decimals, and 4 figures before the point leaves 1 by the
  // significant-figure rule, so the tighter one wins.
  const px = roundToValidPrice(1901.02999, 4, true, true);
  assert.doesNotThrow(() => formatPrice(px, 4, true));
  assert.ok(px <= 1901.02999);
});

test('every rounded price survives the formatter across a range of assets', () => {
  const cases = [
    { px: 63980.30999999999, szDecimals: 5 },
    { px: 1901.0299999, szDecimals: 4 },
    { px: 0.0012345678, szDecimals: 1 },
    { px: 12.3456789, szDecimals: 2 },
    { px: 99999.999, szDecimals: 5 },
  ];
  for (const c of cases) {
    for (const isBuy of [true, false]) {
      const px = roundToValidPrice(c.px, c.szDecimals, true, isBuy);
      assert.doesNotThrow(
        () => formatPrice(px, c.szDecimals, true),
        `${c.px} @ szDecimals ${c.szDecimals} isBuy=${isBuy} produced ${px}`,
      );
    }
  }
});

test('an already-valid price is left alone', () => {
  assert.equal(roundToValidPrice(63980, 5, true, true), 63980);
});
