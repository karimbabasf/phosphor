// The residual of audit finding 8, closed: the price band runs before the held-first preference
// (src/proposals/swap-reads.ts resolveSwapSides, oneCoin).
//
// Anyone can send a coin into the balance. A lookalike under a real ticker is "held" the moment it
// lands, and held-first used to pick it as the coin a swap buys before the band could say the two
// are different coins. Pure: the venue's list and the balance are what each case hands in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OneClickToken } from '../../src/intents.ts';
import { SAME_COIN_BAND, resolveSwapSides } from '../../src/proposals/swap-reads.ts';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const PEPE_ETH = 'nep141:eth-0x6982508145454ce325ddbe47a25d4ec3d2311933.omft.near';
const PEPE_ARB = 'nep141:arb-0x00000000000000000000000000000000000fa4e1.omft.near';
const PEPE_BASE = 'nep141:base-0x0000000000000000000000000000000000000bee.omft.near';

const usdc: OneClickToken = { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', price: 1 };
const list = (...pepes: Array<[string, string, number | undefined]>): OneClickToken[] => [
  usdc,
  ...pepes.map(([assetId, blockchain, price]) => ({ assetId, decimals: 18, blockchain, symbol: 'PEPE', ...(price === undefined ? {} : { price }) }) as OneClickToken),
];
const FROM = { asked: 'USDC', chain: 'near' };
const TO = { asked: 'PEPE' };
const holds = (...ids: string[]): Map<string, string> => new Map([[USDC, '100'], ...ids.map((id) => [id, '5000'] as [string, string])]);

test('a lookalike sent into the balance, listed thirty times the real coin, is never bought for being held', () => {
  const picks = resolveSwapSides(FROM, TO, list([PEPE_ETH, 'eth', 0.00001], [PEPE_ARB, 'arb', 0.0003]), holds(PEPE_ARB));
  assert.equal(picks.to.kind, 'many', JSON.stringify(picks.to));
  assert.deepEqual(picks.to.kind === 'many' ? picks.to.candidates.map((c) => c.assetId).sort() : [], [PEPE_ARB, PEPE_ETH].sort());
});

test('an unpriced version that is held is not preferred over a priced one', () => {
  const picks = resolveSwapSides(FROM, TO, list([PEPE_ETH, 'eth', 0.00001], [PEPE_ARB, 'arb', undefined]), holds(PEPE_ARB));
  assert.equal(picks.to.kind, 'many', 'left to the quote, which compares priced versions only');
});

test('versions that are one coin by the band still go to the one held, as before', () => {
  const inBand = 0.00001 * (1 + SAME_COIN_BAND / 2);
  const picks = resolveSwapSides(FROM, TO, list([PEPE_ETH, 'eth', 0.00001], [PEPE_BASE, 'base', inBand]), holds(PEPE_BASE));
  assert.equal(picks.to.kind, 'one');
  assert.equal(picks.to.kind === 'one' ? picks.to.side.assetId : '', PEPE_BASE);
});

test('just past the band is two coins, held or not', () => {
  const past = 0.00001 * (1 + SAME_COIN_BAND) * 1.01;
  const picks = resolveSwapSides(FROM, TO, list([PEPE_ETH, 'eth', 0.00001], [PEPE_BASE, 'base', past]), holds(PEPE_BASE));
  assert.equal(picks.to.kind, 'many');
});

test('a network they named still picks that coin, whatever the band says', () => {
  const picks = resolveSwapSides(FROM, { asked: 'PEPE', chain: 'arb' }, list([PEPE_ETH, 'eth', 0.00001], [PEPE_ARB, 'arb', 0.0003]), holds(PEPE_ARB));
  assert.equal(picks.to.kind, 'one');
  assert.equal(picks.to.kind === 'one' ? picks.to.side.assetId : '', PEPE_ARB);
});
