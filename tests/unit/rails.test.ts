import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assetIdFor } from '../../src/intents.ts';
import type { TokensFile, OneClickToken } from '../../src/intents.ts';

const tokensFixture: TokensFile = {
  eth: { USDC: { tokenId: '0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606EB48', decimals: 6 } },
  base: { USDC: { tokenId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } },
  arb: {},
  sol: {},
  near: {},
};

const oneClickTokensFixture: OneClickToken[] = [
  {
    assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    decimals: 6,
    blockchain: 'eth',
    symbol: 'USDC',
    contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
  {
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
];

// ---------- intents.ts ----------

test('assetIdFor matches on blockchain and lowercased contract address', () => {
  const id = assetIdFor('eth', tokensFixture.eth.USDC.tokenId, oneClickTokensFixture);
  assert.equal(id, oneClickTokensFixture[0].assetId);

  const missing = assetIdFor('arb', '0xnope', oneClickTokensFixture);
  assert.equal(missing, null);
});
