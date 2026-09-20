// NEAR inside NEAR Intents is wNEAR. 1Click lists one asset for the coin on its own chain,
// nep141:wrap.near under the symbol wNEAR, and no native entry at all (checked live 2026-09-20).
// So "swap my USDC to NEAR" resolved through the gas-asset table, found nothing, and was refused
// with "does not list native NEAR on near unambiguously": a sentence about zero hits, in a word
// that means two. Karim, 2026-09-20: four messages to get from "I want to hold NEAR" to wNEAR.
//
// Run: node --test tests/unit/intents-alias.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSymbol, resolveAsset, type OneClickToken, type TokensFile } from '../../src/intents.ts';

const TOKENS = {
  eth: {},
  base: {},
  arb: {},
  sol: {},
  near: { wNEAR: { tokenId: 'wrap.near', decimals: 24 }, USDC: { tokenId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 } },
} as unknown as TokensFile;

const LIST: OneClickToken[] = [
  { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', contractAddress: 'wrap.near' },
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH' },
];

test('NEAR on its own chain is booked as wNEAR, the one form 1Click lists', () => {
  assert.equal(canonicalSymbol('near', 'NEAR'), 'wNEAR');
  assert.equal(canonicalSymbol('near', 'wNEAR'), 'wNEAR');
  assert.equal(canonicalSymbol('eth', 'ETH'), 'ETH', 'a real gas asset keeps its name');
});

test('resolveAsset turns NEAR on near into wrap.near with the chain\'s 24 decimals', () => {
  const found = resolveAsset('near', 'NEAR', TOKENS, LIST);
  assert.equal(found.assetId, 'nep141:wrap.near');
  assert.equal(found.decimals, 24);
});

test('a gas asset the list does not carry is refused as missing, not as ambiguous', () => {
  assert.throws(() => resolveAsset('sol', 'SOL', TOKENS, LIST), /1click lists no native SOL on sol/);
});

test('two entries claiming one chain\'s gas asset are refused as ambiguous, with the count', () => {
  const twice: OneClickToken[] = [
    ...LIST,
    { assetId: 'nep141:eth.a.near', decimals: 18, blockchain: 'eth', symbol: 'ETH' },
  ];
  assert.throws(() => resolveAsset('eth', 'ETH', TOKENS, twice), /1click lists 2 native ETH on eth/);
});
