// The slippage-floor sanity bound (src/rails/uniswap.ts). minAmountOut is the only slippage
// protection on a swap and it comes off the wire from an agent that may be hijacked. The tool
// has no recipient field, so a near-zero floor is the exfiltration path: the agent names a price
// at which a sandwich takes the money. floorTooLow is the pure half of the guard, asserted here
// against a fixed quote so no live quoter is needed. The live half (a real quoter response) was
// verified separately against a testnet pool: a 0.0000001 floor against a 0.002251 quote was
// refused, a 0.00220 floor was allowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { floorTooLow } from '../../src/rails/uniswap.ts';

const BPS = 2000; // 20%, the shipped bound

test('a near-zero floor against a real quote is refused (the exfiltration attack)', () => {
  const quote = 2_251_000_000_000_000n; // 0.002251 WETH in wei
  assert.equal(floorTooLow(quote, 100_000_000_000n, BPS), true); // 0.0000001 WETH: ~100% below
});

test('a floor within the bound is allowed (a real swap is not false-rejected)', () => {
  const quote = 2_251_000_000_000_000n;
  assert.equal(floorTooLow(quote, 2_200_000_000_000_000n, BPS), false); // 0.00220, ~2% below
  assert.equal(floorTooLow(quote, 1_810_000_000_000_000n, BPS), false); // exactly ~19.6% below, inside 20%
});

test('a floor past the bound is refused', () => {
  const quote = 2_251_000_000_000_000n;
  assert.equal(floorTooLow(quote, 1_600_000_000_000_000n, BPS), true); // ~29% below
});

test('the boundary itself is not refused: a floor at exactly the limit passes', () => {
  const quote = 1_000_000n;
  const limit = (quote * BigInt(10_000 - BPS)) / 10_000n; // 800000
  assert.equal(floorTooLow(quote, limit, BPS), false);
  assert.equal(floorTooLow(quote, limit - 1n, BPS), true);
});

test('a zero or absent quote is not judged, leaving the too-high-floor check to handle it', () => {
  assert.equal(floorTooLow(0n, 0n, BPS), false);
  assert.equal(floorTooLow(0n, 5_000n, BPS), false);
});
