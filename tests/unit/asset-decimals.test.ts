// Whether this app's token registry and the venue's token list agree on decimals.
//
// Run: node --test tests/unit/asset-decimals.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

import { assetIdFor } from '../../src/intents.ts';

// ---------- the decimals agreement ----------
//
// assetIdFor matched on contractAddress and returned assetId, discarding the matched entry's
// decimals. Every amount was then scaled by this repo's registry value while the venue quoted
// against its own, so the two disagreeing would misprice a transfer by a power of ten. All 17
// registry entries agreed with the live list on 2026-09-07, so this is hardening rather than a
// live bug, and the HyperCore rail already does exactly this check for its one pinned asset.

const usdcOnBase = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const list = [
  {
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    contractAddress: usdcOnBase,
  },
];

test('an asset whose 1Click decimals match the registry resolves as before', () => {
  assert.equal(assetIdFor('base', usdcOnBase, list, 6), list[0].assetId);
});

test('an asset whose 1Click decimals differ from the registry is refused', () => {
  assert.throws(() => assetIdFor('base', usdcOnBase, list, 18), /decimals/);
  assert.throws(() => assetIdFor('base', usdcOnBase, list, 18), /factor of ten/);
});

test('a token the venue does not list is still null, which is a different fact', () => {
  assert.equal(assetIdFor('base', '0xnope', list, 6), null);
});

test('a caller that names no decimals gets the old behaviour', () => {
  assert.equal(assetIdFor('base', usdcOnBase, list), list[0].assetId);
});
