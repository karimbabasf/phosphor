// Any coin 1Click lists has a price: its own, off the token list, where nothing else prices it.
//
// On 2026-09-23, after 2 USDC -> WBTC confirmed in 6 s, the swap back was held for a click as
// "This swap spends WBTC, which the app cannot price", and the balances panel showed WBTC, cbBTC
// and nBTC as "not priced". The list the ledger already labels every holding from carries a USD
// price per asset; it is now the price of last resort, marked as such, aged like any governing
// price, and unknown stays null when 1Click has none either.
//
// Run: node --test tests/unit/listed-prices.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOKEN_LIST_TTL_MS, oneClickClient } from '../../src/intents.ts';
import type { OneClickToken } from '../../src/intents.ts';
import { fetchIntentsHoldings } from '../../src/ledger/intents.ts';
import type { IntentsHolding, IntentsRead } from '../../src/ledger/intents.ts';
import { buildWallet } from '../../src/wallet.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { Rail, SwapDraft } from '../../src/types.ts';
import { SELF_EVM, landed, makeCtx, railThat } from './helpers/proposals.ts';

const WBTC = 'nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near';
const CBBTC = 'nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

// ---------- the list ----------

test('the token list is read again once it is a minute old, and a read that fails keeps the last list and its stamp', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-23T20:00:00.000Z') });
  let price = 112_000;
  let down = false;
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    if (down) throw new Error('fetch failed');
    return new Response(JSON.stringify([{ assetId: WBTC, decimals: 8, blockchain: 'eth', symbol: 'WBTC', price }]), { status: 200 });
  }) as unknown as typeof fetch;
  const client = oneClickClient({ fetchImpl });

  assert.equal((await client.tokens())[0]?.price, 112_000);
  const first = client.listedAt?.();
  await client.tokens();
  assert.equal(fetches, 1, 'inside the minute the list is the one in hand');

  price = 113_000;
  t.mock.timers.tick(TOKEN_LIST_TTL_MS);
  assert.equal((await client.tokens())[0]?.price, 113_000);
  assert.equal(fetches, 2);
  const second = client.listedAt?.();
  assert.ok(second !== null && second !== undefined && first !== null && first !== undefined && second > first);

  down = true;
  t.mock.timers.tick(TOKEN_LIST_TTL_MS);
  assert.equal((await client.tokens())[0]?.price, 113_000, 'the names stay good through a failed read');
  assert.equal(client.listedAt?.(), second, 'and the prices keep the stamp they were read at, so they age out on their own');
});

// ---------- the holdings ----------

function viewResult(value: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')] } }), { status: 200 });
}

test('each holding carries 1Click\'s own price for it and when that list was read; a coin 1Click prices at nothing stays unknown', async () => {
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const method = JSON.parse(String(init.body)).params.method_name as string;
    if (method === 'mt_tokens_for_owner') return viewResult([{ token_id: WBTC }, { token_id: CBBTC }]);
    return viewResult(['1000', '2000']);
  }) as unknown as typeof fetch;
  const list: OneClickToken[] = [
    { assetId: WBTC, decimals: 8, blockchain: 'eth', symbol: 'WBTC', price: 112_000 },
    { assetId: CBBTC, decimals: 8, blockchain: 'base', symbol: 'cbBTC' },
  ];
  const read = await fetchIntentsHoldings({ rpcUrl: 'https://rpc.example', accountId: SELF_EVM, tokenList: async () => list, listedAt: () => 1_758_657_600_000, fetchImpl });
  assert.equal(read.ok, true);
  const by = new Map(read.holdings.map((h) => [h.assetId, h]));
  assert.equal(by.get(WBTC)?.priceUsd, 112_000);
  assert.equal(by.get(WBTC)?.priceAsOf, 1_758_657_600_000);
  assert.equal(by.get(CBBTC)?.priceUsd, null, 'no price listed is unknown, never zero');
});

// ---------- the panel ----------

function holding(assetId: string, symbol: string, amountBase: string, decimals: number, priceUsd: number | null, priceAsOf = Date.now()): IntentsHolding {
  return { accountId: SELF_EVM.toLowerCase(), assetId, symbol, originChain: 'eth', amount: Number(amountBase) / 10 ** decimals, amountBase, decimals, priceUsd, priceAsOf };
}

function readOf(holdings: IntentsHolding[]): IntentsRead {
  return { ok: true, fetchedAt: new Date().toISOString(), holdings };
}

test('the balances panel values a held WBTC off 1Click\'s price, says so, and leaves a coin nobody prices unpriced', () => {
  const wallet = buildWallet(
    { ...loadDemoLedger(), mode: 'live' },
    readOf([holding(WBTC, 'WBTC', '1000', 8, 112_000), holding(CBBTC, 'cbBTC', '2000', 8, null), holding(USDC, 'USDC', '5000000', 6, 0.9998)]),
  );
  const by = new Map(wallet.rows.map((r) => [r.tokenId, r]));
  assert.equal(by.get(WBTC)?.priced, true);
  assert.equal(by.get(WBTC)?.priceSource, '1click');
  assert.ok(Math.abs((by.get(WBTC)?.valueUsd ?? 0) - 1.12) < 1e-9);
  assert.equal(by.get(CBBTC)?.priced, false, 'unknown stays unknown');
  assert.equal(by.get(CBBTC)?.valueUsd, 0);
  assert.equal(by.get(USDC)?.priceUsd, 1, 'a coin another source prices keeps that source');
  assert.equal(by.get(USDC)?.priceSource, undefined);
});

// ---------- the swap ----------

// A venue that spends the held WBTC and answers every step.
function wbtcRail(ran: SwapDraft[]): Rail {
  const base = railThat('swap', async (draft) => {
    ran.push(draft as SwapDraft);
    return { ok: true, detail: 'swapped', txids: ['intent-h'] };
  });
  return {
    ...base,
    spend: async () => ({ assetId: WBTC, decimals: 8, heldBase: 1000n }),
    simulate: async () => ({ ok: true, summary: 'About 1.1 USDC, at least 1.09.', swap: { receives: '1.1', receivesAtLeast: '1.09', feeUsd: 0.01, etaSeconds: 12 } }),
  };
}

function swapOut(): { chain: string; fromSymbol: string; toSymbol: string; toChain: string; amountIn: string; minAmountOut: number } {
  return { chain: 'eth', fromSymbol: 'WBTC', toChain: 'near', toSymbol: 'USDC', amountIn: 'all', minAmountOut: 1 };
}

test('a swap out of a held WBTC under the limit runs on its own, priced off the token list', async () => {
  const ran: SwapDraft[] = [];
  const h = makeCtx({ intents: readOf([holding(WBTC, 'WBTC', '1000', 8, 112_000)]), rails: [wbtcRail(ran)] });
  const p = await landed(h, h.svc.proposeSwap(swapOut()));
  assert.equal(p.status, 'executed', JSON.stringify(p.verdict));
  const usd = (p.draft as SwapDraft).amountUsd;
  assert.ok(Math.abs(usd - 1.12) < 1e-9, `valued at ${usd}`);
  assert.doesNotMatch(p.verdict.reasons.join(' '), /cannot price/);
  assert.equal(ran.length, 1);
});

test('a token-list price older than a governing price may be is not governed by: the swap waits for a click', async () => {
  const stale = Date.now() - 3 * 60_000;
  const h = makeCtx({ intents: readOf([holding(WBTC, 'WBTC', '1000', 8, 112_000, stale)]), rails: [wbtcRail([])] });
  const p = await landed(h, h.svc.proposeSwap(swapOut()));
  assert.equal(p.status, 'pending');
  assert.match(p.verdict.reasons.join(' '), /cannot price/);
});
