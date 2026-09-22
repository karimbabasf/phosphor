// Which token a spend means, from what the agent typed. The registry answers for the assets it
// pins; the venue's list answers for the rest; two answers is a question, never a coin flip.
//
// Run: node --test tests/unit/asset-resolve.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAsset } from '../../src/intents.ts';
import type { OneClickToken, TokensFile } from '../../src/intents.ts';
import { pickOrExplain } from '../../src/rails/asset-words.ts';

const tokens = {
  base: { USDC: { tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
} as unknown as TokensFile;

const list: OneClickToken[] = [
  { assetId: 'nep141:base-0x8335.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', price: 1 },
  { assetId: 'nep245:v2_1.omni.hot.tg:1117_', decimals: 9, blockchain: 'ton', symbol: 'GRAM', price: 1.44 },
  { assetId: '1cs_v1:hypercore:hip1:0x6d1e', decimals: 8, blockchain: 'hypercore', symbol: 'USDC', contractAddress: '0x6d1e', price: 1 },
  { assetId: '1cs_v1:hypercore:erc20:0xb883', decimals: 6, blockchain: 'hypercore', symbol: 'USDC', contractAddress: '0xb883', price: 1 },
  { assetId: 'nep141:pol-0xaaa.omft.near', decimals: 6, blockchain: 'pol', symbol: 'USDT', contractAddress: '0xaaa', price: 1 },
];

test('a registry asset resolves exactly as it did, through the registry', () => {
  const pick = resolveAsset('base', 'USDC', tokens, list);
  assert.equal(pick.kind, 'one');
  if (pick.kind !== 'one') return;
  assert.equal(pick.assetId, 'nep141:base-0x8335.omft.near');
  assert.equal(pick.decimals, 6);
});

test('a coin the registry never heard of resolves off the venue list', () => {
  const pick = resolveAsset('ton', 'GRAM', tokens, list);
  assert.equal(pick.kind, 'one');
  if (pick.kind !== 'one') return;
  assert.equal(pick.assetId, 'nep245:v2_1.omni.hot.tg:1117_');
  assert.equal(pick.decimals, 9);
  assert.equal(pick.native, true);
});

/* The chain is looked up by the venue's name for it, which is not our id on three rows. Naming
   the chain 'polygon' has to find the tokens the list files under 'pol'. */
test('a chain the venue spells differently still finds its tokens', () => {
  const pick = resolveAsset('polygon', 'USDT', tokens, list);
  assert.equal(pick.kind, 'one');
});

/* The one live collision as of 2026-09-22: two assets called USDC on hypercore, 8 decimals and
   6. Picking either is a hundredfold mistake half the time, so neither is picked. */
test('two tokens with one ticker on one chain come back as a question', () => {
  const pick = resolveAsset('hypercore', 'USDC', tokens, list);
  assert.equal(pick.kind, 'many');
  if (pick.kind !== 'many') return;
  assert.equal(pick.candidates.length, 2);
  assert.deepEqual(pick.candidates.map((c) => c.decimals).sort(), [6, 8]);
});

test('an assetId named outright is taken as it is, which is how a question gets answered', () => {
  const pick = resolveAsset('hypercore', '1cs_v1:hypercore:erc20:0xb883', tokens, list);
  assert.equal(pick.kind, 'one');
  if (pick.kind !== 'one') return;
  assert.equal(pick.decimals, 6);
});

test('a ticker on a chain that does not carry it still throws, naming the chain', () => {
  assert.throws(() => resolveAsset('ton', 'WIF', tokens, list), /WIF/);
  assert.throws(() => resolveAsset('ton', 'WIF', tokens, list), /ton/);
});

test('a chain the registry does not know throws rather than guessing a venue name', () => {
  assert.throws(() => resolveAsset('madeupchain', 'USDC', tokens, list), /madeupchain/);
});

// ---------- what a rail does with an answer it cannot act on alone ----------

test('a single answer passes straight through', () => {
  const pick = resolveAsset('ton', 'GRAM', tokens, list);
  assert.equal(pickOrExplain(pick, 'GRAM', 'ton').decimals, 9);
});

/* The refusal has to carry the way out of itself: both assetIds, and the words that say to name
   one. An agent that reads "ambiguous" and nothing else asks the person, which is the one thing
   this refusal is trying to avoid at this stage. */
test('a question refuses with both assetIds and how to answer it', () => {
  const pick = resolveAsset('hypercore', 'USDC', tokens, list);
  assert.throws(() => pickOrExplain(pick, 'USDC', 'hypercore'), /1cs_v1:hypercore:hip1:0x6d1e/);
  assert.throws(() => pickOrExplain(pick, 'USDC', 'hypercore'), /1cs_v1:hypercore:erc20:0xb883/);
  assert.throws(() => pickOrExplain(pick, 'USDC', 'hypercore'), /name one of them/);
});
