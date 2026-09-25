// Every step of a plan of swaps is priced before the first one is filed.
//
// 2026-09-25: asked to take all of their VVV (about $8) to DAI, the agent found nobody priced VVV
// to DAI, filed VVV to USDC as step one at 19:59:32, and only at 19:59:33 asked USDC to DAI, which
// swap_quote refused because the balance held no USDC. USDC to DAI was liquid that time; on a thin
// coin the money would have stopped in the middle coin. swap_quote now prices a coin the balance
// does not hold yet, as a preview, and propose_swap still spends only what is held.
//
// Run: node --test tests/unit/swap-leg-quotes.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { Rail, RailResult, SwapDraft, SwapQuoteFacts, SwapSpend } from '../../src/types.ts';
import type { OneClickToken } from '../../src/intents.ts';
import type { IntentsRead } from '../../src/ledger/intents.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import { ReasonError } from '../../src/rails/reasons.ts';
import { NEAR_VERSION_PINNED } from '../../src/proposals/swap-reads.ts';
import { MONEY } from '../../src/persona.ts';
import { SELF_EVM, makeCtx, railThat } from './helpers/proposals.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const VVV = 'nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near';
const USDC = NEAR_VERSION_PINNED.USDC!;
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const DAI = 'nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near';
const USDT_ARB = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';
const USDT_ETH = 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
const THIN = 'nep141:thin.near';
const VVV_HELD = 2_500_000_000_000_000_000n; // 2.5 VVV, about $8

// USDC on NEAR, Base and Ethereum; USDT with no NEAR version; DAI on Ethereum alone; a thin coin.
const LIST: OneClickToken[] = [
  { assetId: THIN, decimals: 18, blockchain: 'near', symbol: 'THIN', price: 0.01 },
  { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 4.4 },
  { assetId: VVV, decimals: 18, blockchain: 'base', symbol: 'VVV', price: 3.2 },
  { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', price: 1 },
  { assetId: USDC_BASE, decimals: 6, blockchain: 'base', symbol: 'USDC', price: 1 },
  { assetId: USDC_ETH, decimals: 6, blockchain: 'eth', symbol: 'USDC', price: 1 },
  { assetId: DAI, decimals: 18, blockchain: 'eth', symbol: 'DAI', price: 1 },
  { assetId: USDT_ARB, decimals: 6, blockchain: 'arb', symbol: 'USDT', price: 1 },
  { assetId: USDT_ETH, decimals: 6, blockchain: 'eth', symbol: 'USDT', price: 1 },
];

// A coin as a draft names it: by id, or by ticker on its network.
function idOf(symbol: string, network: string): string {
  if (symbol.includes(':')) return symbol;
  return LIST.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase() && t.blockchain === network)?.assetId ?? symbol;
}

/* The 1Click of that evening: nobody prices VVV to DAI, VVV to USDC gets 8, and USDC to DAI gets
   8.0009 whether or not USDC is held, since a dry quote reads no balance. Nobody sells THIN for
   USDC, the middle coin the money would have stopped in. Every priced ask is kept. */
function venue(): { rail: Rail; asked: SwapDraft[] } {
  const asked: SwapDraft[] = [];
  const out = (d: SwapDraft): string | null => {
    const [from, to] = [idOf(d.fromSymbol, d.chain), idOf(d.toSymbol, d.toChain)];
    if ((from === VVV && to === DAI) || to === THIN) return null;
    if (from === VVV && to === USDC) return '8';
    if (from === USDC && to === DAI) return '8.0009';
    return '1';
  };
  const rail: Rail = {
    ...railThat('swap', async (): Promise<RailResult> => ({ ok: true, detail: 'never run here' })),
    async facts(draft): Promise<SwapQuoteFacts> {
      const d = draft as SwapDraft;
      asked.push(d);
      const got = out(d);
      if (got === null) throw new ReasonError('no_price', '1click quote failed: No liquidity available');
      return { amountIn: d.amountInExact ?? String(d.amountIn), expectedOut: got, minOut: got, feeUsd: 0.01, etaSeconds: 12 };
    },
    async quote(draft): Promise<number | null> {
      const got = out(draft as SwapDraft);
      return got === null ? null : Number(got);
    },
    async spend(draft): Promise<SwapSpend> {
      const d = draft as SwapDraft;
      const assetId = idOf(d.fromSymbol, d.chain);
      const decimals = LIST.find((t) => t.assetId === assetId)?.decimals ?? 18;
      return { assetId, decimals, heldBase: assetId === VVV ? VVV_HELD : 0n };
    },
  };
  return { rail, asked };
}

function registry(rail: Rail): RailRegistry {
  return {
    for: () => rail,
    kinds: () => ['swap'],
    swap: {
      tokens: async () => LIST,
      balance: async (_account, assetId) => (assetId === VVV ? VVV_HELD : 0n),
      activity: async () => ({ account: SELF_EVM, ok: false, rows: [], balances: null, partial: false, source: 'none', explorer: null, note: '' }),
    },
  };
}

// The balance of that evening: VVV and nothing else.
function vvvHeld(): IntentsRead {
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    holdings: [{ accountId: SELF_EVM.toLowerCase(), assetId: VVV, symbol: 'VVV', originChain: 'base', amount: 2.5, amountBase: VVV_HELD.toString(), decimals: 18 }],
  };
}

function harness() {
  const v = venue();
  return { ...makeCtx({ intents: vvvHeld(), deps: { rails: registry(v.rail) } }), asked: v.asked };
}

test('the live case of 2026-09-25: VVV to DAI has no price, and USDC to DAI is priced before any step is filed, from the USDC step one brings', async () => {
  const h = harness();
  const direct = await h.svc.swapQuote!({ fromSymbol: 'VVV', toSymbol: 'DAI', amountIn: 'all' });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'no_price');

  const first = await h.svc.swapQuote!({ fromSymbol: 'VVV', toSymbol: 'USDC', amountIn: 'all' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.to?.assetId, USDC);
  assert.equal(first.preview, undefined, 'VVV is held: a quote, not a preview');

  const second = await h.svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'DAI', amountIn: first.expectedOut ?? '' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.preview, true);
  assert.equal(second.from?.assetId, USDC, 'the USDC a swap into USDC lands as: its NEAR version');
  assert.equal(second.amountIn, '8');
  assert.equal(second.expectedOut, '8.0009');
  assert.equal(second.reason, 'insufficient_balance', 'a swap from it could not run now');
  assert.equal(second.sentence, 'The balance holds no USDC yet, so this is the price if it did: a swap from it can run once the USDC is there.');
  assert.equal(h.asked.at(-1)?.fromSymbol, USDC);
  assert.equal(h.store.list().length, 0, 'three quotes filed nothing');
});

test('a later step with no price is no price, never a preview: the plan stops before anything is filed', async () => {
  const h = harness();
  const first = await h.svc.swapQuote!({ fromSymbol: 'VVV', toSymbol: 'USDC', amountIn: 'all' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await h.svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'THIN', amountIn: first.expectedOut ?? '' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'no_price');
  assert.equal(second.from?.assetId, USDC, 'asked from the USDC step one brings, and nobody offered');
  assert.equal('preview' in second, false);
  assert.equal(h.store.list().length, 0);
});

test('propose_swap from a coin the balance does not hold is refused as before, whatever a quote previewed', async () => {
  const h = harness();
  assert.equal((await h.svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'DAI', amountIn: '8' })).preview, true);
  // By ticker the resolver finds none held; by id the balance read before any price says 0.
  for (const [fromSymbol, why] of [
    ['USDC', /the balance holds no USDC/],
    [USDC, /holds 0 USDC, less than the 8 this swap asks for/],
  ] as const) {
    const p = await h.svc.proposeSwap({ fromSymbol, toSymbol: 'DAI', amountIn: '8' });
    assert.equal(p.status, 'policy_refused', fromSymbol);
    assert.equal(h.svc.view(p).reason?.code, 'insufficient_balance', fromSymbol);
    assert.match(p.verdict.reasons.join(' '), why);
  }
  assert.equal(h.store.list().every((p) => p.status === 'policy_refused'), true, 'nothing ran');
});

test('"all" of a coin the balance does not hold is refused in a plain sentence: there is no amount to price', async () => {
  const h = harness();
  for (const fromSymbol of ['USDC', USDC]) {
    const all = await h.svc.swapQuote!({ fromSymbol, toSymbol: 'DAI', amountIn: 'all' });
    assert.equal(all.ok, false, fromSymbol);
    assert.equal(all.reason, 'insufficient_balance', fromSymbol);
    assert.equal(all.preview, undefined, fromSymbol);
    // The sentence is said to the person; what to quote instead is the agent's, in details.
    assert.equal(all.sentence, 'The balance holds no USDC yet, so there is no amount to price for all of it.', fromSymbol);
    assert.equal(all.details, 'Quote a number instead, such as what the step before gets.', fromSymbol);
  }
  assert.equal(h.asked.length, 0, 'nothing was priced');
});

test('a coin held is quoted as before: no preview, and more than is held still says so', async () => {
  const h = harness();
  const some = await h.svc.swapQuote!({ fromSymbol: 'VVV', toSymbol: 'USDC', amountIn: '1' });
  assert.equal(some.ok, true, JSON.stringify(some));
  assert.equal(some.reason, null);
  assert.equal(some.sentence, null);
  assert.equal('preview' in some, false);

  const over = await h.svc.swapQuote!({ fromSymbol: 'VVV', toSymbol: 'USDC', amountIn: '3' });
  assert.equal(over.ok, true);
  assert.equal(over.reason, 'insufficient_balance');
  assert.match(over.sentence ?? '', /You don't have that much VVV/);
  assert.equal('preview' in over, false);
});

test('a coin not held with no NEAR version is no preview until it is named by the id the step before buys', async () => {
  const h = harness();
  const usdt = await h.svc.swapQuote!({ fromSymbol: 'USDT', toSymbol: 'DAI', amountIn: '8' });
  assert.equal(usdt.ok, false);
  assert.equal(usdt.reason, 'insufficient_balance');
  assert.equal(usdt.candidates, undefined, 'versions of one coin are never a question for the person');
  assert.equal(usdt.sentence, 'The balance holds no USDT yet, so this step waits on the one before it.');
  assert.doesNotMatch(usdt.sentence ?? '', /assetId|quote/i, 'the sentence the agent says tells the person to quote by an id');
  assert.equal(usdt.details, 'USDT has no NEAR version, so which one this is depends on the step before: quote it by the assetId that step buys.');
  assert.equal(h.asked.length, 0);

  const byId = await h.svc.swapQuote!({ fromSymbol: USDT_ETH, toSymbol: 'DAI', amountIn: '8' });
  assert.equal(byId.ok, true, JSON.stringify(byId));
  assert.equal(byId.preview, true);
  assert.equal(byId.from?.assetId, USDT_ETH);
});

test('swap_quote says a coin not held yet is a preview and every step is quoted first; propose_swap files a plan a step at a time', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-leg-quotes-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp.ts')],
    // Port 9 answers nothing: listing needs no app, and no call is made.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PHOSPHOR_DATA_DIR: data, PHOSPHOR_PORT: '9', PHOSPHOR_SEAT: 'leg-quotes', PHOSPHOR_SESSION: 'leg-quotes', PHOSPHOR_SURFACE: 'chat' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'leg-quotes', version: '0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  fs.rmSync(data, { recursive: true, force: true });
  const said = (name: string): string => tools.find((t) => t.name === name)?.description ?? '';
  assert.match(said('swap_quote'), /A coin they do not hold yet is priced too, as its NEAR version, with `preview`/);
  assert.match(said('swap_quote'), /A plan in steps: quote every step first, each for what the one before gets; one with no price means file nothing/);
  assert.match(said('propose_swap'), /It spends only what their balance holds: in a plan of steps, file the first once swap_quote priced every step/);
});

test('the persona has every step of a plan quoted before any is filed, and says why a plan takes two steps', () => {
  assert.ok(
    MONEY.includes('A plan of swaps: swap_quote every step before filing any, and if one has no price, say so and file nothing. Two steps because the pair has no price? Say why in one line, with the second fee.'),
  );
});
