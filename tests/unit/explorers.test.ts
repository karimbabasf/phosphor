// The name on the receipt card's one button ("View on Basescan") follows the link's host, never
// the chain the row was filed under, so an intent hash that links to the NEAR Intents explorer
// is named after that explorer and a url this repo does not link to gets no name at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { HYPERLIQUID_EXPLORER_TX, explorerName } from '../../src/explorers.ts';
import { explorerTxUrl, intentsSwapUrl } from '../../src/transactions.ts';

test('every explorer this repo links to names itself from its url', () => {
  assert.equal(explorerName(explorerTxUrl('base', '0x1')), 'Basescan');
  assert.equal(explorerName(explorerTxUrl('arb', '0x1')), 'Arbiscan');
  assert.equal(explorerName(explorerTxUrl('eth', '0x1')), 'Etherscan');
  assert.equal(explorerName(explorerTxUrl('sol', 'sig')), 'Solscan');
  assert.equal(explorerName(explorerTxUrl('near', 'h')), 'Nearblocks');
  assert.equal(explorerName(explorerTxUrl('intents', 'h')), 'Nearblocks');
  assert.equal(explorerName(intentsSwapUrl('0xdeposit')), 'NEAR Intents explorer');
  assert.equal(explorerName(explorerTxUrl('hyperliquid', '0x1')), 'Hyperliquid explorer');
  assert.equal(explorerName(`${HYPERLIQUID_EXPLORER_TX}0xabc`), 'Hyperliquid explorer');
});

test('a subdomain of an explorer is that explorer; a lookalike host is nothing', () => {
  assert.equal(explorerName('https://sepolia.basescan.org/tx/0x1'), 'Basescan');
  assert.equal(explorerName('https://notbasescan.org/tx/0x1'), null);
  assert.equal(explorerName('https://basescan.org.evil.example/tx/0x1'), null);
});

test('no url, an empty url, or a string that is not a url names nothing', () => {
  assert.equal(explorerName(null), null);
  assert.equal(explorerName(undefined), null);
  assert.equal(explorerName(''), null);
  assert.equal(explorerName('not a url'), null);
  assert.equal(explorerName('https://example.com/tx/0x1'), null);
});
