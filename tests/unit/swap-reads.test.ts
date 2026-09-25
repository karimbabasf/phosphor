// The three swap reads: swap_assets, swap_quote, swap_check. None files a row or signs.
//
// On 2026-09-23 the agent had no way to ask whether BTC could be bought, what a swap would get,
// or whether a FAILED swap's money had left, other than proposing and drawing a Refused card
// (recon R3). These reads answer each, off the venue, the balance and the intents ledger.
//
// Run: node --test tests/unit/swap-reads.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import type { Proposal, Rail, RailResult, SwapDraft, SwapQuoteFacts } from '../../src/types.ts';
import type { OneClickStatus, OneClickToken } from '../../src/intents.ts';
import type { IntentsActivity } from '../../src/chainscan/index.ts';
import type { IntentsRead } from '../../src/ledger/intents.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import { ReasonError } from '../../src/rails/reasons.ts';
import { swapReads } from '../../src/http/read/swap.ts';
import { NEAR_VERSION_PINNED, pickBoughtByQuote } from '../../src/proposals/swap-reads.ts';
import { sentenceOf } from '../../src/proposals/view.ts';
import fs from 'node:fs';
import type { PCtx } from '../../src/proposals/lifecycle.ts';
import { walletReads } from '../../src/http/read/wallet.ts';
import type { Ctx } from '../../src/http/context.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { SELF_EVM, makeCtx, railThat } from './helpers/proposals.ts';

const WNEAR = 'nep141:wrap.near';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BTC = 'nep141:btc.omft.near';
const NBTC = 'nep141:nbtc.bridge.near';
const WBTC = 'nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near';
const HELD = 894697028778374732410224n;
const HANDLE = '840ade2d6a0f3a5b8d9c4e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b59da';

const LIST: OneClickToken[] = [
  { assetId: WNEAR, decimals: 24, blockchain: 'near', symbol: 'wNEAR', contractAddress: 'wrap.near', price: 4.4 },
  { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', price: 1 },
  { assetId: BTC, decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 112000 },
  { assetId: NBTC, decimals: 8, blockchain: 'near', symbol: 'BTC', contractAddress: 'nbtc.bridge.near', price: 112000 },
  { assetId: WBTC, decimals: 8, blockchain: 'eth', symbol: 'WBTC', contractAddress: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', price: 112000 },
];

// A venue that sells anything but native BTC, pricing every coin at a flat 0.0001 out.
function venueRail(): { rail: Rail; asked: SwapDraft[] } {
  const asked: SwapDraft[] = [];
  const base = railThat('swap', async (): Promise<RailResult> => ({ ok: true, detail: 'never run here' }));
  const rail: Rail = {
    ...base,
    async facts(draft): Promise<SwapQuoteFacts> {
      const d = draft as SwapDraft;
      asked.push(d);
      if (d.toSymbol === BTC) throw new ReasonError('no_price', '1click quote failed: No liquidity available');
      return { amountIn: d.amountInExact ?? String(d.amountIn), expectedOut: '0.0001', minOut: '0.000099', feeUsd: 0.02, etaSeconds: 12 };
    },
  };
  return { rail, asked };
}

function wnearHeld(): IntentsRead {
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    holdings: [{ accountId: SELF_EVM.toLowerCase(), assetId: WNEAR, symbol: 'wNEAR', originChain: 'near', amount: 0.8946970287783748, amountBase: HELD.toString(), decimals: 24 }],
  };
}

function registry(rail: Rail, activity: IntentsActivity | null = null): RailRegistry {
  return {
    for: () => rail,
    kinds: () => ['swap'],
    swap: {
      tokens: async () => LIST,
      balance: async (_account, assetId) => (assetId === WNEAR ? HELD : 0n),
      activity: async () => activity ?? { account: SELF_EVM, ok: false, rows: [], balances: null, partial: false, source: 'none', explorer: null, note: '' },
    },
  };
}

// ---------- swap_assets ----------

test('swap_assets for "btc" asks the venue about each coin it found: native BTC has no seller, the wrapped ones do', async () => {
  const v = venueRail();
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(v.rail) } });
  const reply = await h.svc.swapAssets!({ query: 'btc' });
  assert.equal(reply.ok, true);
  const by = new Map(reply.assets.map((a) => [a.assetId, a]));
  assert.equal(by.get(BTC)?.liquidity, 'no');
  assert.equal(by.get(BTC)?.network, 'btc');
  assert.equal(by.get(NBTC)?.liquidity, 'yes');
  assert.equal(by.get(WBTC)?.liquidity, 'yes');
  assert.equal(by.get(WBTC)?.name, 'WBTC on Ethereum');
  assert.ok(v.asked.every((d) => d.amountInExact === '5'), 'the probe is a few dollars of USDC');
  assert.ok(v.asked.every((d) => d.fromSymbol === USDC));
});

test('swap_assets puts what the person holds first, with the exact amount, and asks nothing for a wide list', async () => {
  const v = venueRail();
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(v.rail) } });
  const reply = await h.svc.swapAssets!({});
  assert.equal(reply.total, LIST.length);
  assert.equal(reply.assets[0]?.assetId, WNEAR);
  assert.equal(reply.assets[0]?.held, '0.894697028778374732410224');
  assert.equal(v.asked.length, 0, 'an unfiltered list is not quoted coin by coin');
  assert.ok(reply.assets.every((a) => a.liquidity === 'unknown'));
});

test('swap_assets with no venue wired says so rather than listing nothing as if nothing existed', async () => {
  const h = makeCtx({});
  const reply = await h.svc.swapAssets!({ query: 'usdc' });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'not_available');
});

// ---------- swap_quote ----------

test('swap_quote for all of the NEAR prices the exact raw balance and files nothing', async () => {
  const v = venueRail();
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(v.rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'WBTC', amountIn: 'all' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.from?.assetId, WNEAR);
  assert.equal(reply.to?.assetId, WBTC);
  assert.equal(reply.amountIn, '0.894697028778374732410224');
  assert.equal(reply.expectedOut, '0.0001');
  assert.equal(reply.minOut, '0.000099');
  assert.equal(reply.feeUsd, 0.02);
  assert.equal(reply.reason, null);
  assert.equal(h.store.list().length, 0, 'a quote filed a proposal');
});

/* ONE TICKER, SEVERAL COINS, NO NETWORK NAMED ("swap my NEAR to USDC" came back "which USDC?" on
   the live build, 2026-09-23). The coin spent is the one held, and only that. The coin bought is
   its NEAR version, so one coin never sits in the balance on several networks (Karim, 2026-09-25);
   with none, the one held the most of; else up to four are asked what they would get and the most
   wins; no answer is no price, never a question about networks. */
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDC_ARB = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const USDT_ARB = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';
const USDT_ETH = 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
const USDT_TRON = 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near';
const ETH_NEAR = 'nep141:eth.bridge.near';
const ETH_ETH = 'nep141:eth.omft.near';
const ETH_BASE = 'nep141:base.omft.near';
const ETH_ARB = 'nep141:arb.omft.near';
const ETH_OP = 'nep245:v2_1.omni.hot.tg:10_11111111111111111111';
const WIDE: OneClickToken[] = [
  ...LIST,
  { assetId: USDC_ETH, decimals: 6, blockchain: 'eth', symbol: 'USDC', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', price: 1 },
  { assetId: USDC_ARB, decimals: 6, blockchain: 'arb', symbol: 'USDC', contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', price: 1 },
  { assetId: USDC_BASE, decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', price: 1 },
  { assetId: USDT_ARB, decimals: 6, blockchain: 'arb', symbol: 'USDT', contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', price: 1 },
  { assetId: USDT_ETH, decimals: 6, blockchain: 'eth', symbol: 'USDT', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', price: 1 },
  { assetId: USDT_TRON, decimals: 6, blockchain: 'tron', symbol: 'USDT', contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', price: 1 },
  { assetId: ETH_NEAR, decimals: 18, blockchain: 'near', symbol: 'ETH', contractAddress: 'eth.bridge.near', price: 4000 },
  { assetId: ETH_ETH, decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 4000 },
  { assetId: ETH_BASE, decimals: 18, blockchain: 'base', symbol: 'ETH', price: 4000 },
  { assetId: ETH_ARB, decimals: 18, blockchain: 'arb', symbol: 'ETH', price: 4000 },
  { assetId: ETH_OP, decimals: 18, blockchain: 'op', symbol: 'ETH', price: 4000 },
];

/* A venue whose floorless price per bought coin the test sets: a number, null for no price, or
   'hang' for an answer that never comes. Every ask is recorded by the id it was for. */
function pricingRail(outs: Record<string, number | null | 'hang'>, fallback: number | null = 0.0001): { rail: Rail; asked: string[] } {
  const asked: string[] = [];
  const base = venueRail().rail;
  const rail: Rail = {
    ...base,
    async quote(draft) {
      const id = (draft as SwapDraft).toSymbol;
      asked.push(id);
      const out = id in outs ? outs[id] : fallback;
      if (out === 'hang') return new Promise<number | null>(() => {});
      return out ?? null;
    },
  };
  return { rail, asked };
}

function wide(rail: Rail, list: OneClickToken[] = WIDE): RailRegistry {
  const r = registry(rail);
  return { ...r, swap: { ...r.swap!, tokens: async () => list } };
}
// The same list with no ETH on near, where the quote still decides.
const NO_NEAR_ETH = WIDE.filter((t) => t.assetId !== ETH_NEAR);

// wNEAR, and beside it whatever else the balance holds, by id and base units.
function holding(extra: Array<[string, string, number]>): IntentsRead {
  const base = wnearHeld();
  return {
    ...base,
    holdings: [
      ...base.holdings,
      ...extra.map(([assetId, symbol, units]) => ({ accountId: SELF_EVM.toLowerCase(), assetId, symbol, originChain: 'eth', amount: units / 1e6, amountBase: String(units), decimals: 6 })),
    ],
  };
}

test('the live case: swap_quote from all of the NEAR to USDC is USDC on near, never "which USDC?"', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail({}).rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'wNEAR', toSymbol: 'USDC', amountIn: 'all' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.reason, null);
  assert.equal(reply.to?.assetId, USDC, 'four USDC quote the same, and the tie goes to the one on near');
  assert.equal(reply.to?.network, 'near');
});

test('the coin bought: its NEAR version beats one already held elsewhere; with no NEAR version, the one held the most of; nothing is asked', async () => {
  const v = pricingRail({ [USDC_ETH]: 9 });
  const h = makeCtx({ intents: holding([[USDC_BASE, 'USDC', 2_000_000]]), deps: { rails: wide(v.rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: '0.5' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.to?.assetId, USDC, 'USDC on base is held, and the bought USDC still goes to NEAR');

  // No USDT on near in this list: the larger of the two held.
  const held = makeCtx({ intents: holding([[USDT_ARB, 'USDT', 1_000_000], [USDT_ETH, 'USDT', 3_000_000]]), deps: { rails: wide(v.rail) } });
  const usdt = await held.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDT', amountIn: '0.5' });
  assert.equal(usdt.to?.assetId, USDT_ETH);
  assert.deepEqual(v.asked, [], 'a picked coin is not quoted against the others');
});

test('the coin bought: with none held, four are asked at once and the one that gets the most wins', async () => {
  // ETH from Ethereum pays more than the bridged ETH on near: the new person gets the better coin.
  // No NEAR version listed: the new person gets the one that pays the most.
  const v = pricingRail({ [ETH_ETH]: 0.00108, [ETH_BASE]: 0.00107, [ETH_ARB]: 0.00106, [ETH_OP]: 0.0001 });
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: wide(v.rail, NO_NEAR_ETH) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'ETH', amountIn: '0.5' });
  assert.equal(reply.to?.assetId, ETH_ETH);
  assert.deepEqual([...v.asked].sort(), [ETH_ARB, ETH_BASE, ETH_ETH, ETH_OP].sort(), 'Ethereum, Base and Arbitrum, then the list order');
});

test('ETH bought is its NEAR version even when ETH from Ethereum quotes more, in swap_quote and propose_swap alike; with no NEAR version the quote decides', async () => {
  const omftAhead = { [ETH_NEAR]: 0.0015734768, [ETH_ETH]: 0.0015736358 }; // 1 NEAR, live 2026-09-23
  const quoted = await makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail(omftAhead, null).rail) } }).svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'ETH', amountIn: '0.5' });
  assert.equal(quoted.to?.assetId, ETH_NEAR);
  assert.match(quoted.picked ?? '', /^ETH on NEAR, its NEAR version/);
  const proposed = await makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail(omftAhead, null).rail) } }).svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'ETH', amountIn: '0.5', minAmountOut: 0.0007 });
  assert.deepEqual([(proposed.draft as SwapDraft).toChain, (proposed.draft as SwapDraft).toSymbol], ['near', 'ETH']);

  const noNear = await makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail(omftAhead, null).rail, NO_NEAR_ETH) } }).svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'ETH', amountIn: '0.5' });
  assert.equal(noNear.to?.assetId, ETH_ETH);
  assert.match(noNear.picked ?? '', /^ETH on Ethereum: no NEAR version is offered/);
});

/* ONE TICKER, TWO COINS (audit, finding 8). 1Click lists two NEARKATs at $0.00552645 and
   $0.00017222; $10 buys about 1,809 of one and 58,065 of the other, and the most units went to the
   cheaper token whatever the person meant. Listed prices more than five percent apart are two coins. */
test('two coins under one ticker, listed thirty times apart, are the question and never a pick by units', async () => {
  const usdc = { symbol: 'USDC', network: 'near', assetId: USDC, decimals: 6 };
  const a = { symbol: 'NearKat', network: 'near', assetId: 'nep141:kat-a.near', decimals: 18 };
  const b = { symbol: 'NEARKAT', network: 'near', assetId: 'nep141:kat-b.near', decimals: 18 };
  const katList: OneClickToken[] = [
    { assetId: a.assetId, decimals: 18, blockchain: 'near', symbol: 'NearKat', price: 0.00552645 },
    { assetId: b.assetId, decimals: 18, blockchain: 'near', symbol: 'NEARKAT', price: 0.00017222 },
  ];
  const v = pricingRail({ [a.assetId]: 1_809, [b.assetId]: 58_065 });
  const ctx = { cfg: {}, rails: { for: () => v.rail } } as unknown as PCtx;
  const pick = await pickBoughtByQuote(ctx, usdc, '10', [a, b], SELF_EVM, katList);
  assert.equal(pick.kind, 'many');
  assert.deepEqual(v.asked, [], 'two coins are asked about by the person, not priced against each other');
});

test('the most arriving is counted in dollars: a candidate the list prices wins over one it does not, and same-priced coins still auto-pick', async () => {
  // ETH on base unpriced in this list: only the priced ones are compared.
  const list = NO_NEAR_ETH.map((t) => (t.assetId === ETH_BASE ? { ...t, price: undefined } : t));
  const v = pricingRail({ [ETH_ETH]: 0.0011, [ETH_BASE]: 0.5, [ETH_ARB]: 0.00105 });
  const r = wide(v.rail);
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: { ...r, swap: { ...r.swap!, tokens: async () => list } } } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'ETH', amountIn: '0.5' });
  assert.equal(reply.to?.assetId, ETH_ETH, 'the unpriced one quoting 0.5 is not compared against priced ones');
  assert.ok(!v.asked.includes(ETH_BASE));
});

test('the coin bought: when no price comes back, the one on near; when there is none on near, no price and never a question', async () => {
  const silent = pricingRail({}, null);
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: wide(silent.rail) } });
  const eth = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'ETH', amountIn: '0.5' });
  assert.equal(eth.to?.assetId, ETH_NEAR);

  // USDT on eth, arb and tron: nobody answers, and none is on near.
  const usdt = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDT', amountIn: '0.5' });
  assert.equal(usdt.ok, false);
  assert.equal(usdt.reason, 'no_price');
  assert.equal(usdt.candidates, undefined, 'three networks of one coin are not handed over as a choice');

  // NEAR is only on near, and native BTC has no seller: nBTC, which quotes.
  const btc = await makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail({ [BTC]: null }).rail) } }).svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'BTC', amountIn: '0.5' });
  assert.equal(btc.ok, true, JSON.stringify(btc));
  assert.equal(btc.to?.assetId, NBTC);
});

test('the coin bought: a price that does not come within two seconds is no answer', async () => {
  const v = pricingRail({ [ETH_ETH]: 'hang', [ETH_BASE]: 0.001 }, null);
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: wide(v.rail, NO_NEAR_ETH) } });
  const started = Date.now();
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'ETH', amountIn: '0.5' });
  assert.equal(reply.to?.assetId, ETH_BASE);
  assert.ok(Date.now() - started < 3_000, 'the hung ask did not hold the answer past its bound');
});

test('the coin spent: the one held is the only answer; none held is nothing to spend, two held is the question', async () => {
  const one = makeCtx({ intents: holding([[USDC_BASE, 'USDC', 2_000_000]]), deps: { rails: wide(pricingRail({}).rail) } });
  assert.equal((await one.svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: '1' })).from?.assetId, USDC_BASE);

  const none = makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail({}).rail) } });
  const nothing = await none.svc.swapQuote!({ fromSymbol: 'USDT', toSymbol: 'NEAR', amountIn: '1' });
  assert.equal(nothing.reason, 'insufficient_balance');
  assert.match(nothing.sentence ?? '', /The balance holds no USDT yet/);

  const two = makeCtx({ intents: holding([[USDC_BASE, 'USDC', 1_000_000], [USDC_ARB, 'USDC', 1_000_000]]), deps: { rails: wide(pricingRail({}).rail) } });
  const which = await two.svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: '1' });
  assert.equal(which.reason, 'ambiguous_asset');
  assert.deepEqual(which.candidates?.map((c) => c.assetId).sort(), [USDC_ARB, USDC_BASE].sort());
});

test('propose_swap picks by the same rule: a network left out is found, and no price for any version is refused as no price', async () => {
  const h = makeCtx({ intents: holding([[USDC_BASE, 'USDC', 2_000_000]]), deps: { rails: wide(pricingRail({}).rail) } });
  const p = await h.svc.proposeSwap({ fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: '0.5', minAmountOut: 1 });
  assert.equal(p.draft.kind, 'swap');
  const d = p.draft as SwapDraft;
  assert.deepEqual([d.chain, d.fromSymbol, d.toChain, d.toSymbol], ['near', 'wNEAR', 'near', 'USDC'], 'NEAR found on near, USDC its NEAR version');

  const best = makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail({ [ETH_ETH]: 0.002 }).rail, NO_NEAR_ETH) } });
  const bought = await best.svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'ETH', amountIn: '0.5', minAmountOut: 0.0009 });
  assert.deepEqual([(bought.draft as SwapDraft).toChain, (bought.draft as SwapDraft).toSymbol], ['eth', 'ETH']);

  const asked = makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail({}, null).rail) } });
  const refused = await asked.svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'USDT', amountIn: '0.5', minAmountOut: 1 });
  assert.equal(refused.status, 'policy_refused');
  assert.equal(asked.svc.view(refused).reason?.code, 'no_price');
  assert.doesNotMatch(refused.verdict.reasons.join(' '), new RegExp(`${USDT_ETH}`));
});

/* NEAR INTENTS FIRST (Karim, 2026-09-25): "turn everything into USDT" had the swap service pick
   Tron for some coins and Ethereum for others, and the agent asked which network. A coin bought
   with no network named is its NEAR version, so every swap into USDT lands on one tile. */
const USDT_NEAR = 'nep141:usdt.tether-token.near';
const USDT_FAKE = 'nep141:usdt-tether.near';
const USDT_NEAR_ROW: OneClickToken = { assetId: USDT_NEAR, decimals: 6, blockchain: 'near', symbol: 'USDT', contractAddress: 'usdt.tether-token.near', price: 1 };
const USDT_FAKE_ROW: OneClickToken = { assetId: USDT_FAKE, decimals: 6, blockchain: 'near', symbol: 'USDT', contractAddress: 'usdt-tether.near', price: 1 };

test('USDT listed on Tron, Ethereum, Arbitrum and NEAR: every swap into it, from any coin, is USDT on NEAR, and the card says so', async () => {
  const list = [...WIDE, USDT_NEAR_ROW];
  // Held on Tron already: still NEAR, so the balance ends on one USDT.
  const h = makeCtx({ intents: holding([[USDC_BASE, 'USDC', 2_000_000], [USDT_TRON, 'USDT', 5_000_000]]), deps: { rails: wide(pricingRail({}).rail, list) } });
  const quoted = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDT', amountIn: '0.5' });
  assert.equal(quoted.ok, true, JSON.stringify(quoted));
  assert.equal(quoted.to?.assetId, USDT_NEAR);
  assert.equal(quoted.picked, 'USDT on NEAR, its NEAR version: the app keeps every coin bought on NEAR, so the balance holds one USDT.');

  for (const [fromSymbol, amountIn] of [['NEAR', '0.5'], ['USDC', '1']] as const) {
    const p = await h.svc.proposeSwap({ fromSymbol, toSymbol: 'USDT', amountIn });
    const d = p.draft as SwapDraft;
    assert.deepEqual([d.toChain, d.toSymbol], ['near', 'USDT'], `${fromSymbol} into USDT`);
    assert.ok(d.minAmountOut > 0, 'the floor is still set off the live quote');
    assert.equal(d.to, d.from, 'the proceeds stay in the person\'s own account inside NEAR Intents');
    assert.match(sentenceOf(d), /to USDT on NEAR, inside NEAR Intents$/);
  }
});

test('a network they named still wins: USDT on Tron by network or by id, and the coin spent is untouched', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail({}).rail, [...WIDE, USDT_NEAR_ROW]) } });
  const byNetwork = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDT', toChain: 'tron', amountIn: '0.5' });
  assert.equal(byNetwork.to?.assetId, USDT_TRON);
  assert.equal(byNetwork.picked, undefined, 'a coin they named is not described as picked');
  const byId = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: USDT_TRON, amountIn: '0.5' });
  assert.equal(byId.to?.assetId, USDT_TRON);
  const p = await h.svc.proposeSwap({ fromSymbol: 'NEAR', toSymbol: 'USDT', toChain: 'tron', amountIn: '0.5' });
  assert.deepEqual([(p.draft as SwapDraft).toChain, (p.draft as SwapDraft).toSymbol], ['tron', 'USDT']);
});

test('a lookalike never becomes the NEAR version: a pinned ticker is its pinned id, and an unpinned one must price like the rest', async () => {
  // The real USDT on near beside a fake one under the same ticker: the real one.
  const both = makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail({}).rail, [...WIDE, USDT_FAKE_ROW, USDT_NEAR_ROW]) } });
  assert.equal((await both.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDT', amountIn: '0.5' })).to?.assetId, USDT_NEAR);
  assert.equal((await both.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDT', toChain: 'near', amountIn: '0.5' })).to?.assetId, USDT_NEAR);
  // Named by its id, by an agent a page talked into it: refused, in the quote and the proposal.
  const byId = await both.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: USDT_FAKE, amountIn: '0.5' });
  assert.equal(byId.ok, false);
  assert.match(byId.details ?? '', /is not the real coin of that name/);
  const proposed = await both.svc.proposeSwap({ fromSymbol: 'NEAR', toSymbol: USDT_FAKE, amountIn: '0.5' });
  assert.equal(proposed.status, 'policy_refused');
  const named = await both.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'NEAR', toSymbol: USDT_FAKE, amountIn: '0.5', minAmountOut: 1 });
  assert.equal(named.status, 'policy_refused', 'both networks named does not skip the check');
  assert.match(named.verdict.reasons.join(' '), /is not the real coin of that name/);

  // Only the fake on near: it is dropped and never even priced; the quote picks among the rest.
  const v = pricingRail({ [USDT_ETH]: 2.2, [USDT_FAKE]: 99 });
  const fake = makeCtx({ intents: wnearHeld(), deps: { rails: wide(v.rail, [...WIDE, USDT_FAKE_ROW]) } });
  assert.equal((await fake.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDT', amountIn: '0.5' })).to?.assetId, USDT_ETH);
  assert.ok(!v.asked.includes(USDT_FAKE));

  // An unpinned ticker whose near version is listed thirty times off the others: not taken.
  const pepe = (id: string, blockchain: string, price: number): OneClickToken => ({ assetId: id, decimals: 18, blockchain, symbol: 'PEPE', price });
  const odd = makeCtx({ intents: wnearHeld(), deps: { rails: wide(pricingRail({}).rail, [...WIDE, pepe('nep141:pepe.near', 'near', 0.0003), pepe('nep141:eth-pepe.omft.near', 'eth', 0.00001)]) } });
  const reply = await odd.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'PEPE', amountIn: '0.5' });
  assert.equal(reply.reason, 'ambiguous_asset');
  assert.match(reply.sentence ?? '', /never which network/);
});

test('the pinned NEAR versions are the near rows of data/tokens.json', () => {
  const near = (JSON.parse(fs.readFileSync(new URL('../../data/tokens.json', import.meta.url), 'utf8')) as Record<string, Record<string, { tokenId: string }>>).near!;
  assert.deepEqual(
    Object.fromEntries(Object.entries(near).map(([k, v]) => [k.toUpperCase(), `nep141:${v.tokenId}`])),
    { ...NEAR_VERSION_PINNED },
  );
});

test('swap_quote into native BTC is no price, in the words that say what works instead', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(venueRail().rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'BTC', toChain: 'btc', amountIn: '0.5' });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'no_price');
  assert.match(reply.sentence ?? '', /Bitcoin itself can't be held here/);
  assert.match(reply.details ?? '', /No liquidity available/);

  const nbtc = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'BTC', toChain: 'near', amountIn: '0.5' });
  assert.equal(nbtc.ok, true, 'BTC on near is nBTC, and it quotes');
  assert.equal(nbtc.to?.assetId, NBTC);
});

test('swap_quote for more than is held still prices it, and says the swap could not run', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(venueRail().rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: WNEAR, toSymbol: 'USDC', toChain: 'near', amountIn: '0.9' });
  assert.equal(reply.ok, true);
  assert.equal(reply.reason, 'insufficient_balance');
  assert.match(reply.sentence ?? '', /You don't have that much NEAR/);
});

test('swap_quote for a coin nobody lists is unsupported_asset', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(venueRail().rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'DOGEWIFHAT', amountIn: '1' });
  assert.equal(reply.reason, 'unsupported_asset');
  assert.match(reply.details ?? '', /lists no coin called DOGEWIFHAT/);
});

// ---------- swap_check ----------

function failedSwap(): Proposal {
  return {
    id: '8b589eca',
    kind: 'swap',
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    decidedAt: new Date(Date.now() - 110_000).toISOString(),
    status: 'needs_reconciliation',
    draft: {
      kind: 'swap',
      venue: 'intents-native',
      chain: 'near',
      toChain: 'eth',
      fromSymbol: 'wNEAR',
      toSymbol: 'WBTC',
      amountIn: 0.8946970287783748,
      amountUsd: 3.9,
      minAmountOut: 0.0000345,
      from: SELF_EVM,
      to: SELF_EVM,
      counterparty: 'intents.near',
      quote: null,
    },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    result: { ok: false, detail: '1click reported FAILED and refunded 0 wNEAR so far; the input is held by 1Click under handle', txids: ['9g9S'], evidence: { handle: HANDLE, providerStage: 'FAILED', refundedAmount: '0' } },
  };
}

const QUIET_LEDGER: IntentsActivity = {
  account: SELF_EVM.toLowerCase(),
  ok: true,
  // One old row, from before the click: the page reaches back, and nothing went to the handle.
  rows: [{ cause: 'TRANSFER', token: 'wNEAR', tokenId: WNEAR, delta: '+0.89', counterparty: 'solver.near', hash: 'BnKW', time: new Date(Date.now() - 3_600_000).toISOString() }],
  balances: null,
  partial: false,
  source: 'nearblocks',
  explorer: null,
  note: '',
};

function failedStatus(over: Partial<OneClickStatus> = {}): OneClickStatus {
  return { found: true, status: 'FAILED', reported: 'FAILED', originTxHashes: [], destinationTxHashes: [], nearTxHashes: [], refundedAmount: '0', ...over };
}

test('swap_check on the FAILED wNEAR swap: the ledger shows nothing left, and the balance says what is held', async () => {
  const asked: string[] = [];
  const h = makeCtx({
    intents: wnearHeld(),
    deps: {
      rails: registry(venueRail().rail, QUIET_LEDGER),
      oneClickStatus: async (handle) => {
        asked.push(handle);
        return failedStatus();
      },
    },
  });
  h.store.put(failedSwap());
  const reply = await h.svc.swapCheck!('8b589eca');
  assert.deepEqual(asked, [HANDLE], 'the venue was asked again, not read off the row');
  assert.equal(reply.moved, 'no');
  assert.equal(reply.refunded, false);
  assert.equal(reply.venue.status, 'FAILED');
  assert.equal(reply.balance.now, '0.894697028778374732410224');
  assert.equal(reply.summary, "It didn't go through. Nothing left your balance. You hold 0.894697028778374732410224 NEAR.");
  assert.equal(h.store.get('8b589eca')?.status, 'needs_reconciliation', 'a read writes nothing');
});

test('swap_check on a FAILED swap whose signed transfer can still run says nothing has left yet, not that it is over', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(venueRail().rail, QUIET_LEDGER), oneClickStatus: async () => failedStatus() } });
  const row = failedSwap();
  const watching = (deadline: string) => ({ ...row, result: { ...row.result!, reason: 'venue_failed_watching', evidence: { ...row.result!.evidence, deadline } } });
  h.store.put(watching(new Date(Date.now() + 3 * 60_000).toISOString()));
  const reply = await h.svc.swapCheck!('8b589eca');
  assert.equal(reply.moved, 'no');
  assert.equal(reply.summary, "Still checking this swap: nothing has left your balance so far. I'm keeping an eye on it for a few minutes. You hold 0.894697028778374732410224 NEAR.");

  // A transfer 1Click signed for 72 hours says how long, never "a few minutes" over days.
  h.store.put(watching(new Date(Date.now() + 72 * 3_600_000).toISOString()));
  const long = await h.svc.swapCheck!('8b589eca');
  assert.match(long.summary, /I'm keeping an eye on it until it can no longer run, in about 3 days\./);
  assert.doesNotMatch(long.summary, /send it again|a few minutes/);
});

test('swap_check says the coin left when the ledger shows the transfer to the handle, and cannot tell when there is no ledger', async () => {
  const sent: IntentsActivity = { ...QUIET_LEDGER, rows: [{ cause: 'TRANSFER', token: 'wNEAR', tokenId: WNEAR, delta: '-0.89', counterparty: HANDLE, hash: 'Tx1', time: new Date().toISOString() }] };
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(venueRail().rail, sent), oneClickStatus: async () => failedStatus() } });
  h.store.put(failedSwap());
  const reply = await h.svc.swapCheck!('8b589eca');
  assert.equal(reply.moved, 'yes');
  assert.equal(reply.ledger?.outgoing[0]?.amount, '0.89');
  assert.match(reply.summary, /left your balance and the swap hasn't finished/);

  const blind = makeCtx({ intents: wnearHeld(), deps: { rails: registry(venueRail().rail, null), oneClickStatus: async () => failedStatus() } });
  blind.store.put(failedSwap());
  const unknown = await blind.svc.swapCheck!('8b589eca');
  assert.equal(unknown.moved, 'unknown');
  assert.equal(unknown.summary, "Still checking whether your NEAR left your balance. I'll update it here.");
});

// ---------- the doors ----------

function captured(): { res: http.ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let text = '';
  let code = 0;
  const res = {
    writeHead(status: number) {
      code = status;
      return res;
    },
    end(chunk?: unknown) {
      text = String(chunk ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, status: () => code, body: () => JSON.parse(text) as Record<string, unknown> };
}

test('the read doors answer with the service, name a missing argument, and 404 an unknown id', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(venueRail().rail) } });
  const ctx = { proposals: h.svc } as unknown as Ctx;

  const quote = captured();
  await swapReads.swap_quote!(ctx, {}, { fromSymbol: 'NEAR', toSymbol: 'WBTC', amountIn: 'all' }, quote.res);
  assert.equal(quote.status(), 200);
  assert.equal(quote.body().amountIn, '0.894697028778374732410224');

  const missing = captured();
  await swapReads.swap_quote!(ctx, {}, { fromSymbol: 'NEAR' }, missing.res);
  assert.equal(missing.status(), 400);
  assert.match(String(missing.body().error), /toSymbol is required.*amountIn is required/);

  const assets = captured();
  await swapReads.swap_assets!(ctx, {}, { query: 'wnear' }, assets.res);
  assert.equal(assets.status(), 200);
  assert.ok(Array.isArray(assets.body().assets));

  const nobody = captured();
  await swapReads.swap_check!(ctx, {}, { id: 'nope' }, nobody.res);
  assert.equal(nobody.status(), 404);
});

test('the wallet read carries every quantity as an exact decimal beside the number', async () => {
  const snapshot = loadDemoLedger();
  const ctx = {
    ledger: { snapshot: () => snapshot, intents: () => wnearHeld(), hyperliquid: () => undefined, refresh: async () => snapshot },
    keystore: { custody: () => null, enclave: () => null, state: () => 'no_wallet', header: () => null },
    vault: { attached: () => false, enclaveReady: () => false, capability: () => null, waiting: () => null },
    vaultPrefs: { get: () => ({ backedUp: false, backedUpAt: null, idleMinutes: 15 }) },
  } as unknown as Ctx;
  const out = captured();
  await walletReads.wallet!(ctx, {}, {}, out.res);
  const rows = out.body().rows as Array<{ symbol: string; quantity: number; quantityExact: string | null }>;
  const near = rows.find((r) => r.symbol === 'wNEAR');
  assert.equal(near?.quantity, 0.8946970287783748, 'the number the window reads is still there');
  assert.equal(near?.quantityExact, '0.894697028778374732410224');
});
