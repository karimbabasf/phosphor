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

test('each holding carries 1Click\'s own price for it, aged from when 1Click priced it; a coin 1Click prices at nothing stays unknown', async () => {
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const method = JSON.parse(String(init.body)).params.method_name as string;
    if (method === 'mt_tokens_for_owner') return viewResult([{ token_id: WBTC }, { token_id: CBBTC }]);
    return viewResult(['1000', '2000']);
  }) as unknown as typeof fetch;
  const listedAt = 1_758_657_600_000;
  const list: OneClickToken[] = [
    { assetId: WBTC, decimals: 8, blockchain: 'eth', symbol: 'WBTC', price: 112_000, priceUpdatedAt: new Date(listedAt - 30_000).toISOString() },
    { assetId: CBBTC, decimals: 8, blockchain: 'base', symbol: 'cbBTC' },
  ];
  const read = await fetchIntentsHoldings({ rpcUrl: 'https://rpc.example', accountId: SELF_EVM, tokenList: async () => list, listedAt: () => listedAt, fetchImpl });
  assert.equal(read.ok, true);
  const by = new Map(read.holdings.map((h) => [h.assetId, h]));
  assert.equal(by.get(WBTC)?.priceUsd, 112_000);
  assert.equal(by.get(WBTC)?.priceAsOf, listedAt - 30_000, 'as old as 1Click\'s own stamp, not the moment the list was read');
  assert.equal(by.get(CBBTC)?.priceUsd, null, 'no price listed is unknown, never zero');

  // A list read now carrying a price 1Click last updated two days ago is two days old (audit, finding 7).
  const stale: OneClickToken[] = [{ assetId: WBTC, decimals: 8, blockchain: 'eth', symbol: 'WBTC', price: 84, priceUpdatedAt: new Date(listedAt - 2 * 86_400_000).toISOString() }];
  const old = await fetchIntentsHoldings({ rpcUrl: 'https://rpc.example', accountId: SELF_EVM, tokenList: async () => stale, listedAt: () => listedAt, fetchImpl });
  assert.equal(old.holdings.find((h) => h.assetId === WBTC)?.priceAsOf, listedAt - 2 * 86_400_000);
  // And a price with no stamp from 1Click has no age anyone can vouch for.
  const unstamped = await fetchIntentsHoldings({ rpcUrl: 'https://rpc.example', accountId: SELF_EVM, tokenList: async () => [{ ...stale[0]!, priceUpdatedAt: undefined }], listedAt: () => listedAt, fetchImpl });
  assert.equal(unstamped.holdings.find((h) => h.assetId === WBTC)?.priceAsOf, undefined);
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

/* A WRONG-LOW LISTED PRICE IS BOUNDED BY THE QUOTE (audit, finding 7). 1 WBTC listed at $84, a
   thousandfold slip, was governed as $84 and ran with no click while the quote in hand said 84,000
   USDC arrives. A swap priced only by the list is governed at the larger of the two. */
test('a wrong-low listed price does not make a big swap look small: the quote of what arrives bounds it', async () => {
  // The audit's own shape: WBTC listed at $84 against a quote of $84,000 a coin.
  const wbtcAt84 = (heldBase: bigint, receives: string): { rail: Rail; ran: SwapDraft[] } => {
    const ran: SwapDraft[] = [];
    const base = railThat('swap', async (draft) => {
      ran.push(draft as SwapDraft);
      return { ok: true, detail: 'swapped', txids: ['intent-h'] };
    });
    return {
      ran,
      rail: {
        ...base,
        spend: async () => ({ assetId: WBTC, decimals: 8, heldBase }),
        simulate: async () => ({ ok: true, summary: `About ${receives} USDC.`, swap: { receives, receivesAtLeast: receives, feeUsd: 5, etaSeconds: 12 } }),
      },
    };
  };

  // 0.05 WBTC: $4.20 on the list, $4,200 by the quote. Governed at $4,200, so it waits for a click.
  const small = wbtcAt84(5_000_000n, '4200');
  const h = makeCtx({ intents: readOf([holding(WBTC, 'WBTC', '5000000', 8, 84)]), rails: [small.rail] });
  const p = await landed(h, h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'WBTC', toChain: 'near', toSymbol: 'USDC', amountIn: 'all', minAmountOut: 4_150 }));
  assert.equal(p.status, 'pending', `${p.status} ${p.decidedBy ?? ''}`);
  assert.equal((p.draft as SwapDraft).amountUsd, 4_200);
  assert.equal(small.ran.length, 0, 'nothing ran on the list price alone');

  // 1 WBTC: $84 on the list, $84,000 by the quote, which is over the limit for one move.
  const whole = wbtcAt84(100_000_000n, '84000');
  const h2 = makeCtx({ intents: readOf([holding(WBTC, 'WBTC', '100000000', 8, 84)]), rails: [whole.rail] });
  const q = await landed(h2, h2.svc.proposeSwap({ chain: 'eth', fromSymbol: 'WBTC', toChain: 'near', toSymbol: 'USDC', amountIn: 'all', minAmountOut: 83_160 }));
  assert.equal(q.status, 'policy_refused');
  assert.equal(h2.svc.view(q).reason?.code, 'over_trade_cap');
  assert.equal(whole.ran.length, 0);
});

test('a listed price 1Click last updated more than two minutes ago is not governed by: the swap waits for a click', async () => {
  const h = makeCtx({ intents: readOf([holding(WBTC, 'WBTC', '1000', 8, 112_000, Date.now() - 2 * 86_400_000)]), rails: [wbtcRail([])] });
  const p = await landed(h, h.svc.proposeSwap(swapOut()));
  assert.equal(p.status, 'pending');
});

/* THE LIST CANNOT CHECK ITSELF (audit, finding 10). 1Click prices the whole BTC family off one
   number, so a glitch that lists WBTC at $84 lists cbBTC at $84 too, and the quote's value of what
   arrives is the same wrong number. A bought coin priced only by the list checks nothing: the swap
   waits for a click. */
test('a swap between two coins priced only by the list waits for a click, however small the list makes it', async () => {
  const ran: SwapDraft[] = [];
  const base = railThat('swap', async (draft) => {
    ran.push(draft as SwapDraft);
    return { ok: true, detail: 'swapped', txids: ['intent-h'] };
  });
  const rail: Rail = {
    ...base,
    spend: async () => ({ assetId: WBTC, decimals: 8, heldBase: 100_000_000n }),
    simulate: async () => ({ ok: true, summary: 'About 0.9995 cbBTC.', swap: { receives: '0.9995', receivesAtLeast: '0.9895', feeUsd: 1, etaSeconds: 12 } }),
  };
  const h = makeCtx({ intents: readOf([holding(WBTC, 'WBTC', '100000000', 8, 84), holding(CBBTC, 'cbBTC', '100000000', 8, 84)]), rails: [rail] });
  const p = await landed(h, h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'WBTC', toChain: 'base', toSymbol: 'cbBTC', amountIn: 'all', minAmountOut: 0.9895 }));
  assert.equal(p.status, 'pending', `${p.status} ${p.decidedBy ?? ''}`);
  assert.match(p.verdict.reasons.at(-1) ?? '', /nothing in its quote can check that price/);
  assert.equal(ran.length, 0, 'nothing ran on the list checked against itself');
});
