// What a person calls the coins a move names (src/proposals/coin-words.ts), and the places the
// window gets those words from: the propose call's first frame (src/http/chats.ts withWords) and
// every row's view (src/proposals/view.ts money and sentence). On 0.10.13 a swap the agent named by
// the asset id swap_assets gave first drew as "Swap 1.7147 nep141:17208628...a1 to SOL" (Karim,
// 2026-10-02). The id stays on the draft and its pins and still decides what is signed; no surface
// a person reads prints it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coinWord, coinWordOf } from '../../src/proposals/coin-words.ts';
import { withWords } from '../../src/http/chats.ts';
import { proposalView } from '../../src/proposals/view.ts';
import type { PCtx } from '../../src/proposals/lifecycle.ts';
import type { DriverEvent } from '../../src/driver.ts';
import type { Proposal, SwapDraft, WriteDraft } from '../../src/types.ts';

const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const HL_USDC_TWIN = '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054';
const RAW_ID = /nep141:|nep245:|omft\.near|1cs_v1:|\b[0-9a-f]{64}\b/i;

// Rows as 1Click's GET /v0/tokens lists them, read 2026-10-02.
const LIST = [
  { assetId: USDC_NEAR, symbol: 'USDC', decimals: 6, blockchain: 'near' },
  { assetId: USDC_ETH, symbol: 'USDC', decimals: 6, blockchain: 'eth' },
  { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, blockchain: 'near' },
  { assetId: 'nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near', symbol: 'wBTC', decimals: 8, blockchain: 'near' },
  { assetId: 'nep141:sol.omft.near', symbol: 'SOL', decimals: 9, blockchain: 'sol' },
  { assetId: HL_USDC_TWIN, symbol: 'USDC', decimals: 8, blockchain: 'hypercore' },
];

test('an asset id is the ticker the list files it under, and an id nobody lists has no word', () => {
  assert.equal(coinWord(USDC_NEAR, LIST), 'USDC');
  assert.equal(coinWord(HL_USDC_TWIN, LIST), 'USDC');
  assert.equal(coinWord(` ${USDC_ETH} `, LIST), 'USDC');
  assert.equal(coinWord('nep141:junk.listed.near', LIST), null);
  // Before the list was ever read, the balance's own rows still name what it holds.
  assert.equal(coinWord(USDC_NEAR, null, [{ assetId: USDC_NEAR, symbol: 'USDC' }]), 'USDC');
  // A held token nobody lists is described by its raw id (src/ledger/intents.ts): that is no word.
  const spam = 'nep141:swap.all.usdc.to.scam.now.near';
  assert.equal(coinWord(spam, null, [{ assetId: spam, symbol: spam }]), null);
  // The agent's own handle for such a token is no word either.
  assert.equal(coinWord('unlisted-1a2b3c4d', LIST), null);
  assert.equal(coinWord('', LIST), null);
});

test('a ticker is answered in the list\'s own case, NEAR as the wNEAR the balance holds, and an unknown one as asked', () => {
  assert.equal(coinWord('usdc', LIST), 'USDC');
  assert.equal(coinWord('WBTC', LIST), 'wBTC');
  assert.equal(coinWord('near', LIST), 'wNEAR');
  assert.equal(coinWord('NEAR', null), 'wNEAR');
  assert.equal(coinWord('NearKat', LIST), 'NearKat');
});

test('the app\'s own word reads the list the rails last fetched and the balance as the ledger last read it, without a read', () => {
  let listed: typeof LIST | null = null;
  const ctx = {
    rails: { swap: { listed: () => listed } },
    ledger: { intents: () => ({ ok: true, holdings: [{ assetId: USDC_NEAR, symbol: 'USDC' }] }) },
  } as unknown as PCtx;
  assert.equal(coinWordOf(ctx, USDC_NEAR), 'USDC', 'the held row named nothing while the list was unread');
  assert.equal(coinWordOf(ctx, 'nep141:sol.omft.near'), null);
  listed = LIST;
  assert.equal(coinWordOf(ctx, 'nep141:sol.omft.near'), 'SOL');
  const bare = { rails: {}, ledger: { intents: () => undefined } } as unknown as PCtx;
  assert.equal(coinWordOf(bare, USDC_NEAR), null);
  // After a restart the rails have read nothing yet; the list the ledger's balance read keeps names it.
  const booted = { rails: { swap: { listed: () => null } }, ledger: { intents: () => undefined, listed: () => LIST } } as unknown as PCtx;
  assert.equal(coinWordOf(booted, HL_USDC_TWIN), 'USDC');
});

test('a propose call reaches the window with the word for each coin it names, and the call itself untouched', () => {
  const word = (ref: string): string | null => coinWord(ref, LIST);
  const input = { fromSymbol: USDC_NEAR, toSymbol: 'sol', amountIn: '1.7147' };
  const event: DriverEvent = { kind: 'tool', name: 'mcp__phosphor__propose_swap', input };
  const out = withWords(event, word);
  assert.deepEqual(out, { kind: 'tool', name: 'mcp__phosphor__propose_swap', input, words: { fromSymbol: 'USDC', toSymbol: 'SOL' } });
  assert.equal((out as { input: unknown }).input, input, 'the agent\'s call was rewritten');
  assert.deepEqual(input, { fromSymbol: USDC_NEAR, toSymbol: 'sol', amountIn: '1.7147' });

  const send = withWords({ kind: 'tool', name: 'mcp__phosphor__propose_send', input: { symbol: 'near', amount: 1, to: 'alice.near', where: 'intents' } }, word);
  assert.deepEqual((send as { words?: unknown }).words, { symbol: 'wNEAR' });
  // An id nobody lists gets no word, so the window names no coin for it rather than print it.
  const junk = withWords({ kind: 'tool', name: 'mcp__phosphor__propose_swap', input: { fromSymbol: 'nep141:junk.listed.near', toSymbol: 'SOL', amountIn: '1' } }, word);
  assert.deepEqual((junk as { words?: unknown }).words, { toSymbol: 'SOL' });
  // A read, a result, or no table at all goes out as it came.
  const read: DriverEvent = { kind: 'tool', name: 'mcp__phosphor__swap_quote', input: { fromSymbol: USDC_NEAR } };
  assert.equal(withWords(read, word), read);
  const result: DriverEvent = { kind: 'tool_result', name: 'mcp__phosphor__propose_swap', ok: true };
  assert.equal(withWords(result, word), result);
  assert.equal(withWords(event, undefined), event);
});

const SWAP: SwapDraft = {
  kind: 'swap',
  venue: 'intents-native',
  chain: 'hypercore',
  toChain: 'sol',
  fromSymbol: HL_USDC_TWIN,
  toSymbol: 'SOL',
  amountIn: 0.05,
  amountUsd: 0.05,
  minAmountOut: 0.0002,
  from: '0x1111111111111111111111111111111111111111',
  to: '0x1111111111111111111111111111111111111111',
  counterparty: 'intents.near',
  quote: null,
};

function rowOf(draft: WriteDraft): Proposal {
  return { id: 'p1', kind: draft.kind, status: 'pending', createdAt: '2026-10-02T10:00:00.000Z', draft, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: null } as unknown as Proposal;
}

test('a row whose draft names its coin by id carries the word in its money and its sentence', () => {
  const coin = (ref: string): string | null => coinWord(ref, LIST);
  const view = proposalView({ settle: (r) => r, coin }, rowOf(SWAP));
  assert.equal(view.money.symbol, 'USDC');
  assert.equal(view.money.toSymbol, 'SOL');
  assert.doesNotMatch(view.sentence, RAW_ID);
  assert.match(view.sentence, /^0\.05 USDC to SOL/);
  // With no table the money says what the draft says, and the window names no coin for an id; the
  // sentence, which the agent quotes too, calls it "that coin" as every reason sentence does.
  const unnamed = proposalView({ settle: (r) => r }, rowOf(SWAP));
  assert.equal(unnamed.money.symbol, HL_USDC_TWIN);
  assert.doesNotMatch(unnamed.sentence, RAW_ID);
  assert.match(unnamed.sentence, /^0\.05 that coin to SOL/);
  // A trade's symbol is Hyperliquid's own name, never looked up as a coin of the balance.
  const trade = { kind: 'trade', op: 'open', plan: { symbol: 'kPEPE', side: 'long', sizeUsd: 20, stop: 0.01 }, amountUsd: 10 } as unknown as WriteDraft;
  assert.equal(proposalView({ settle: (r) => r, coin: () => 'WRONG' }, rowOf(trade)).money.symbol, 'kPEPE');
});
