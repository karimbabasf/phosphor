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

/* ONE TICKER, SEVERAL COINS, NO NETWORK NAMED: the one held, then the one on the other coin's
   network, then the one on NEAR; only when none of those leaves one coin is it a question. "Swap
   my NEAR to USDC" came back "which USDC?" on the live build (2026-09-23). */
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDC_ARB = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const USDT_ARB = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';
const USDT_ETH = 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
const USDT_TRON = 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near';
const WIDE: OneClickToken[] = [
  ...LIST,
  { assetId: USDC_ETH, decimals: 6, blockchain: 'eth', symbol: 'USDC', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', price: 1 },
  { assetId: USDC_ARB, decimals: 6, blockchain: 'arb', symbol: 'USDC', contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', price: 1 },
  { assetId: USDC_BASE, decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', price: 1 },
  { assetId: USDT_ARB, decimals: 6, blockchain: 'arb', symbol: 'USDT', contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', price: 1 },
  { assetId: USDT_ETH, decimals: 6, blockchain: 'eth', symbol: 'USDT', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', price: 1 },
  { assetId: USDT_TRON, decimals: 6, blockchain: 'tron', symbol: 'USDT', contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', price: 1 },
];

function wide(rail: Rail): RailRegistry {
  const r = registry(rail);
  return { ...r, swap: { ...r.swap!, tokens: async () => WIDE } };
}

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
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: wide(venueRail().rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'wNEAR', toSymbol: 'USDC', amountIn: 'all' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.reason, null);
  assert.equal(reply.to?.assetId, USDC);
  assert.equal(reply.to?.network, 'near');
});

test('step 1: the coin the balance already holds comes first, over the other coin\'s network and over near', async () => {
  const h = makeCtx({ intents: holding([[USDC_BASE, 'USDC', 2_000_000]]), deps: { rails: wide(venueRail().rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: '0.5' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.to?.assetId, USDC_BASE);

  // And on the sold side: the USDC held is the one sold, wherever it is from.
  const sell = await h.svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn: '1' });
  assert.equal(sell.from?.assetId, USDC_BASE);
});

test('step 2: with none held, the coin on the other coin\'s network, named or found', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: wide(venueRail().rail) } });
  const named = await h.svc.swapQuote!({ fromSymbol: 'USDT', chain: 'arb', toSymbol: 'USDC', amountIn: '1' });
  assert.equal(named.to?.assetId, USDC_ARB, 'USDC on arb beside USDT named on arb, not USDC on near');

  // NEAR is only on near, so BTC is the one on near: nBTC, which quotes.
  const found = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'BTC', amountIn: '0.5' });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(found.to?.assetId, NBTC);
});

test('step 3: with none held and none on the other coin\'s network, the one on near', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: wide(venueRail().rail) } });
  // Native BTC sits on btc, where no USDC is listed.
  const reply = await h.svc.swapQuote!({ fromSymbol: 'BTC', chain: 'btc', toSymbol: 'USDC', amountIn: '0.001' });
  assert.equal(reply.to?.assetId, USDC);
});

test('only when none of the three leaves one coin is it a question, answered with the ids', async () => {
  // USDT on eth and on tron: neither held, neither on near, where the NEAR sold is.
  const narrow = WIDE.filter((t) => t.assetId !== USDT_ARB);
  const r = wide(venueRail().rail);
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: { ...r, swap: { ...r.swap!, tokens: async () => narrow } } } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'USDT', amountIn: '0.5' });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'ambiguous_asset');
  assert.deepEqual(reply.candidates?.map((c) => c.assetId).sort(), [USDT_ETH, USDT_TRON].sort());

  // Two held are narrowed on by the next rules, not asked about.
  const two = makeCtx({ intents: holding([[USDC_BASE, 'USDC', 1_000_000], [USDC_ARB, 'USDC', 1_000_000]]), deps: { rails: wide(venueRail().rail) } });
  const picked = await two.svc.swapQuote!({ fromSymbol: 'USDT', chain: 'arb', toSymbol: 'USDC', amountIn: '1' });
  assert.equal(picked.to?.assetId, USDC_ARB);
});

test('propose_swap picks by the same rule: a network left out is found, and a question is refused with the ids', async () => {
  const h = makeCtx({ intents: holding([[USDC_BASE, 'USDC', 2_000_000]]), deps: { rails: wide(venueRail().rail) } });
  const p = await h.svc.proposeSwap({ fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: '0.5', minAmountOut: 1 });
  assert.equal(p.draft.kind, 'swap');
  const d = p.draft as SwapDraft;
  assert.deepEqual([d.chain, d.fromSymbol, d.toChain, d.toSymbol], ['near', 'wNEAR', 'base', 'USDC'], 'NEAR found on near, USDC the one held');

  const r = wide(venueRail().rail);
  const narrow = WIDE.filter((t) => t.assetId !== USDT_ARB);
  const asked = makeCtx({ intents: wnearHeld(), deps: { rails: { ...r, swap: { ...r.swap!, tokens: async () => narrow } } } });
  const refused = await asked.svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'USDT', amountIn: '0.5', minAmountOut: 1 });
  assert.equal(refused.status, 'policy_refused');
  assert.equal(asked.svc.view(refused).reason?.code, 'ambiguous_asset');
  assert.match(refused.verdict.reasons.join(' '), new RegExp(`${USDT_ETH}.*${USDT_TRON}|${USDT_TRON}.*${USDT_ETH}`));
});

test('swap_quote into native BTC is no price, in the words that say what works instead', async () => {
  const h = makeCtx({ intents: wnearHeld(), deps: { rails: registry(venueRail().rail) } });
  const reply = await h.svc.swapQuote!({ fromSymbol: 'NEAR', toSymbol: 'BTC', toChain: 'btc', amountIn: '0.5' });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'no_price');
  assert.match(reply.sentence ?? '', /Bitcoin itself can't be held inside NEAR Intents/);
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
  assert.equal(reply.summary, "It didn't go through, and nothing has left your balance yet. I'm keeping an eye on it for a few minutes. You hold 0.894697028778374732410224 NEAR.");

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
