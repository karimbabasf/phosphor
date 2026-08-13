import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireNumber, formatPrice, formatSize } from '../../src/hl/format.ts';

test('wireNumber strips trailing zeros, so 1.5 and 1.50 are the same wire string', () => {
  assert.equal(wireNumber(1.5), '1.5');
  assert.equal(wireNumber(1.50), '1.5');
  assert.equal(wireNumber(100), '100');
  assert.equal(wireNumber(100.0), '100');
  assert.equal(wireNumber(0.1), '0.1');
  assert.equal(wireNumber(-2.25), '-2.25');
});

test('wireNumber normalises -0 to "0"', () => {
  assert.equal(wireNumber(-0), '0');
  assert.equal(wireNumber(0), '0');
});

test('wireNumber never emits exponent notation', () => {
  // (1e-8).toString() is "1e-8" and the venue rejects it.
  assert.equal(wireNumber(0.00000001), '0.00000001');
  assert.equal(wireNumber(1e20), '100000000000000000000');
  assert.throws(() => wireNumber(1e21), /too large/);
});

test('wireNumber throws past 8 decimals rather than rounding', () => {
  assert.equal(wireNumber(12.3456789), '12.3456789'); // 7 decimals, fine
  assert.equal(wireNumber(0.12345678), '0.12345678'); // 8 decimals, the limit
  assert.throws(() => wireNumber(0.123456789), /more than 8 decimals/);
  assert.throws(() => wireNumber(1e-9), /more than 8 decimals/);
  // Float noise counts as real precision: the caller must round on purpose.
  assert.throws(() => wireNumber(0.1 + 0.2), /more than 8 decimals/);
  assert.throws(() => wireNumber(NaN), /not a finite number/);
  assert.throws(() => wireNumber(Infinity), /not a finite number/);
});

test('formatPrice accepts at most 5 significant figures', () => {
  assert.equal(formatPrice(1234.5, 0, true), '1234.5');
  assert.throws(() => formatPrice(1234.56, 0, true), /significant figures/);
});

test('formatPrice accepts at most 6 - szDecimals decimals on a perp', () => {
  assert.equal(formatPrice(0.001234, 0, true), '0.001234'); // 6 decimals, 4 sig figs
  assert.throws(() => formatPrice(0.0012345, 0, true), /more than 6 decimals/);

  assert.equal(formatPrice(0.01234, 1, true), '0.01234'); // 5 decimals, the limit at szDecimals 1
  assert.throws(() => formatPrice(0.012345, 1, true), /more than 5 decimals/);
});

test('an integer price is always valid, whatever its significant figures', () => {
  assert.equal(formatPrice(123456, 0, true), '123456');
  assert.equal(formatPrice(1234567890, 3, true), '1234567890');
  // The same digits with a fraction are not: only the integer case is exempt.
  assert.throws(() => formatPrice(123456.5, 0, true), /significant figures/);
});

test('spot allows 8 - szDecimals decimals where a perp allows 6 - szDecimals', () => {
  assert.equal(formatPrice(0.00012345, 0, false), '0.00012345'); // 8 decimals, 5 sig figs
  assert.throws(() => formatPrice(0.00012345, 0, true), /more than 6 decimals/);
  assert.equal(formatPrice(0.000123, 2, false), '0.000123'); // 6 decimals at szDecimals 2
  assert.throws(() => formatPrice(0.0001234, 2, false), /more than 6 decimals/);
});

test('formatPrice refuses a price that is not one', () => {
  assert.throws(() => formatPrice(0, 0, true), /not a price/);
  assert.throws(() => formatPrice(-10, 0, true), /not a price/);
  assert.throws(() => formatPrice(NaN, 0, true), /not a price/);
  assert.throws(() => formatPrice(10, 1.5, true), /szDecimals/);
});

test('formatSize rounds toward zero, so a fill is never larger than approved', () => {
  assert.equal(formatSize(1.5, 2), '1.5');
  assert.equal(formatSize(0.29, 2), '0.29'); // 0.29 * 100 is 28.999999999999996 in binary
  assert.equal(formatSize(0.2999, 2), '0.29'); // down, never up to 0.3
  assert.equal(formatSize(1.239999, 3), '1.239');
  assert.equal(formatSize(12, 0), '12');
  assert.equal(formatSize(12.9, 0), '12');
});

test('formatSize refuses a size that rounds away to nothing', () => {
  assert.throws(() => formatSize(0.004, 2), /rounds to zero/);
  assert.throws(() => formatSize(0, 2), /not a size/);
  assert.throws(() => formatSize(-1, 2), /not a size/);
});
