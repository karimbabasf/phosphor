// One price per propose, with room under it.
//
// A propose asked 1Click the same question twice a second apart: once to cut the floor (one
// percent under the answer) and once to check it, with 1Click's own minimum also cut one percent
// under ITS answer. Any down-tick between the two refused the swap: 5 of 19 swaps on 2026-09-23,
// one over a 0.009% move ("the solver floor of 3.864737 USDC is below the draft floor of
// 3.86507"). Now simulate checks the very quote the floor was cut from, and every quote asks
// 1Click for half a percent, so its minimum sits above the approved floor until the price has
// really fallen (recon R1 d, R5 B1).
//
// Run: node --test tests/unit/swap-one-quote.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { Rail, RailResult, SwapDraft } from '../../src/types.ts';
import type { OneClickQuote, OneClickToken, TokensFile } from '../../src/intents.ts';
import { toBaseUnits } from '../../src/intents.ts';
import { INTENTS_NATIVE_COUNTERPARTY, QUOTE_SLIPPAGE_BPS, intentsApi, intentsNativeRail } from '../../src/rails/intents-native.ts';
import type { IntentsApiPort, IntentsQuoteParams } from '../../src/rails/intents-native.ts';
import { INTENTS_RELAY_COUNTERPARTY, intentsRelayRail } from '../../src/rails/intents-relay.ts';
import type { RelayClient, RelayQuote } from '../../src/relay/client.ts';
import type { VerifierPort } from '../../src/relay/verifier.ts';
import { floorUnderQuote } from '../../src/rails/slippage.ts';
import { reasonOf } from '../../src/rails/reasons.ts';
import { makeCtx, railThat } from './helpers/proposals.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

const OWNER = privateKeyToAccount(('0x' + '44'.repeat(32)) as Hex).address;
const WNEAR = 'nep141:wrap.near';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const LIST: OneClickToken[] = [
  { assetId: WNEAR, decimals: 24, blockchain: 'near', symbol: 'wNEAR', contractAddress: 'wrap.near' },
  { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' },
];
const NO_REGISTRY = { eth: {}, base: {}, arb: {}, sol: {}, near: {} } as TokensFile;

function draftOf(over: Partial<SwapDraft> = {}): SwapDraft {
  return {
    kind: 'swap',
    venue: 'intents-native',
    chain: 'near',
    toChain: 'near',
    fromSymbol: 'wNEAR',
    toSymbol: 'USDC',
    amountIn: 0.8,
    amountInExact: '0.8',
    amountUsd: 3.9,
    minAmountOut: 0,
    from: OWNER,
    to: OWNER,
    counterparty: INTENTS_NATIVE_COUNTERPARTY,
    quote: null,
    ...over,
  };
}

/* A 1Click that answers each dry quote with the next amountOut in `outs`, and cuts its own
   minimum from the slippage the request asked for, exactly as the live API does. */
function oneClick(outs: bigint[] | ((n: number) => bigint), error?: string) {
  const asked: IntentsQuoteParams[] = [];
  const api: IntentsApiPort = {
    tokens: async () => LIST,
    async quote(params) {
      asked.push(params);
      if (error !== undefined) throw new Error(error);
      const n = asked.length - 1;
      const out = typeof outs === 'function' ? outs(n) : outs[Math.min(n, outs.length - 1)]!;
      const bps = BigInt(params.slippageToleranceBps ?? 100);
      const quote = {
        amountIn: params.amount,
        amountInFormatted: '0.8',
        amountInUsd: '3.91',
        minAmountIn: params.amount,
        amountOut: out.toString(),
        amountOutFormatted: formatUnits(out, 6),
        amountOutUsd: '3.90',
        minAmountOut: ((out * (10_000n - bps)) / 10_000n).toString(),
        timeEstimate: 12,
      } as OneClickQuote;
      const raw = signQuote({
        quote,
        quoteRequest: {
          dry: params.dry,
          originAsset: params.originAsset,
          destinationAsset: params.destinationAsset,
          amount: params.amount,
          depositType: 'INTENTS',
          recipientType: 'INTENTS',
          recipient: OWNER.toLowerCase(),
          refundType: 'INTENTS',
          refundTo: OWNER.toLowerCase(),
        },
      });
      return { quote: raw['quote'] as OneClickQuote, raw };
    },
    generateIntent: async () => {
      throw new Error('never generated in these tests');
    },
    submitIntent: async () => {
      throw new Error('never submitted in these tests');
    },
    status: async () => {
      throw new Error('never polled in these tests');
    },
  };
  const rail = intentsNativeRail({
    keysPath: '/nonexistent/keys.json',
    quoteKey: TEST_QUOTE_KEY,
    tokens: NO_REGISTRY,
    api,
    verifierBalance: async () => 10n ** 30n,
    now: () => Date.parse('2026-09-23T20:23:49.000Z'),
  });
  return { rail, asked };
}

// ---------- the math ----------

test('the math: quote 1 cuts the floor, a quote a hair lower still clears it at half a percent and did not at one', () => {
  const quote1 = 3_904_111n; // 3.904111 USDC for the whole wNEAR balance, 20:23:49
  const floor = floorUnderQuote(3.904111); // one percent under, cut at six figures
  assert.equal(floor, 3.86506);
  const floorBase = toBaseUnits(floor, 6);
  assert.equal(floorBase, 3_865_060n);

  const quote2 = 3_903_775n; // a second later, 0.0086% lower
  const minAt = (bps: bigint, out: bigint): bigint => (out * (10_000n - bps)) / 10_000n;
  assert.equal(minAt(100n, quote2), 3_864_737n, 'what 1Click answered at one percent: the refusal of 20:23:50');
  assert.ok(minAt(100n, quote2) < floorBase, 'at one percent the check refused a 0.009% move');
  assert.equal(QUOTE_SLIPPAGE_BPS, 50);
  assert.equal(minAt(50n, quote2), 3_884_256n);
  assert.ok(minAt(50n, quote2) >= floorBase, 'at half a percent the same move passes');

  // Half a percent of room is room, not a blank cheque: 0.6% lower still stops the swap.
  const quote3 = (quote1 * 994n) / 1000n;
  assert.ok(minAt(50n, quote3) < floorBase, 'a real fall still refuses');
  // The break-even: the price may fall to 99/99.5 of quote 1, about half a percent.
  assert.ok(minAt(50n, (quote1 * 9950n) / 10_000n) >= floorBase);
});

test('every quote the rail asks for carries 50 bps, and that is what goes on the wire', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ quote: { amountOut: '1' } }), { status: 201 });
  }) as unknown as typeof fetch;
  const api = intentsApi({ apiKey: '', fetchImpl });
  await api.quote({ dry: true, originAsset: WNEAR, destinationAsset: USDC, amount: '1', account: OWNER, slippageToleranceBps: QUOTE_SLIPPAGE_BPS });
  assert.equal(bodies[0]?.['slippageTolerance'], 50);

  const v = oneClick([3_904_111n]);
  await v.rail.quote?.(draftOf());
  await v.rail.simulate(draftOf({ minAmountOut: floorUnderQuote(3.904111) }));
  assert.ok(v.asked.length > 0);
  for (const params of v.asked) assert.equal(params.slippageToleranceBps, 50);
});

test('a propose asks one price: simulate checks the quote the floor was cut from, and passes on it', async () => {
  // The second answer is the 20:23:50 down-tick; it is never asked for.
  const v = oneClick([3_904_111n, 3_903_775n]);
  const priced = await v.rail.quote?.(draftOf());
  assert.equal(priced, 3.904111);
  const floor = floorUnderQuote(priced ?? 0);
  const sim = await v.rail.simulate(draftOf({ minAmountOut: floor }));
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(v.asked.length, 1, 'one round trip per propose, not two');
  assert.equal(sim.swap?.receives, '3.904111', 'the card facts come off the quote the floor was cut from');
});

test('the kept price is used once: a later simulate asks again, and a real fall is price_moved', async () => {
  const v = oneClick([3_904_111n, 3_880_686n]);
  await v.rail.quote?.(draftOf());
  const floor = floorUnderQuote(3.904111);
  assert.equal((await v.rail.simulate(draftOf({ minAmountOut: floor }))).ok, true);
  const again = await v.rail.simulate(draftOf({ minAmountOut: floor }));
  assert.equal(v.asked.length, 2);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'price_moved');
});

test('nobody selling is a null price, a minimum is below_minimum, and anything else keeps its cause', async () => {
  const none = oneClick([], '1click quote failed: No liquidity available');
  assert.equal(await none.rail.quote?.(draftOf()), null);

  const small = oneClick([], 'Amount is too low for bridge, try at least 7090031');
  await assert.rejects(() => small.rail.quote!(draftOf()), (err: unknown) => reasonOf(err) === 'below_minimum');

  const odd = oneClick([], 'tokenIn is not supported');
  await assert.rejects(() => odd.rail.quote!(draftOf()), (err: unknown) => reasonOf(err) === 'simulation_failed');
  const sim = await odd.rail.simulate(draftOf({ minAmountOut: 3 }));
  assert.equal(sim.reason, 'simulation_failed');
});

// ---------- the relay rail ----------

test('the relay rail asks once per propose too: simulate picks again from the answers quote() got', async () => {
  const NOW = Date.parse('2026-09-23T20:00:00.000Z');
  const calls: unknown[] = [];
  const quoteOf = (out: string): RelayQuote => ({
    quoteHash: 'qh',
    assetIn: USDC,
    assetOut: WNEAR,
    amountIn: '4000000',
    amountOut: out,
    expirationTime: new Date(NOW + 60_000).toISOString(),
  });
  const relay: RelayClient = {
    async quote(req) {
      calls.push(req);
      return [quoteOf(calls.length === 1 ? '1000000000000000000000000' : '1')];
    },
    publishIntent: async () => {
      throw new Error('never published here');
    },
    status: async () => {
      throw new Error('never polled here');
    },
  };
  const verifier = { balance: async () => 10n ** 30n, currentSalt: async () => null, nonceUsed: async () => null } as unknown as VerifierPort;
  const rail = intentsRelayRail({
    keysPath: '/nonexistent/keys.json',
    tokens: NO_REGISTRY,
    relay,
    client: { tokens: async () => LIST } as never,
    verifier,
    now: () => NOW,
  });
  const draft = draftOf({ venue: 'intents-relay', counterparty: INTENTS_RELAY_COUNTERPARTY, fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 4, amountInExact: '4' });
  const priced = await rail.quote?.(draft);
  assert.equal(priced, 1);
  const sim = await rail.simulate({ ...draft, minAmountOut: floorUnderQuote(priced ?? 0) });
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(calls.length, 1, 'the relay was asked the same question twice');
});

// ---------- the builder, and the words for no price ----------

function pricingRail(price: number | null | Error): Rail {
  const base = railThat('swap', async (): Promise<RailResult> => ({ ok: true, detail: 'swapped' }));
  return {
    ...base,
    async quote() {
      if (price instanceof Error) throw price;
      return price;
    },
  };
}

/* A TRY AGAIN THAT CAN NEVER WORK is not offered (hunt A, #21): nobody sells native bitcoin inside
   NEAR Intents however often it is asked, so the card says what does work, in two short lines. */
test('no price for native BTC offers no Try again, and says in two plain lines to ask for WBTC instead', async () => {
  const h = makeCtx({ rails: [pricingRail(null)] });
  const p = await h.svc.proposeSwap({ chain: 'near', toChain: 'btc', fromSymbol: 'USDC', toSymbol: 'BTC', amountIn: '100' });
  assert.equal(p.status, 'policy_refused');
  assert.deepEqual(p.verdict.reasonCodes, ['no_price']);
  const view = h.svc.view(p);
  assert.equal(view.reason?.code, 'no_price');
  assert.equal(view.reason?.retry, false, 'asking again cannot price native bitcoin');
  assert.equal(view.reason?.sentence, "Bitcoin itself can't be held here, so nothing moved. Wrapped bitcoin (WBTC) tracks it one to one: ask for WBTC instead.");
  assert.doesNotMatch(view.reason?.sentence ?? '', /NEAR Intents|nBTC|cbBTC/);
  assert.equal(view.stageCopy, view.reason?.sentence, 'the card prints the cause, not "a rule you set"');

  // Any other pair nobody prices right now is worth asking again.
  const other = await h.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: '100' });
  assert.equal(h.svc.view(other).reason?.code, 'no_price');
  assert.equal(h.svc.view(other).reason?.retry, true);
});

test('a quote that fails for a reason other than no price is refused with that reason, never swallowed as no price', async () => {
  const err = Object.assign(new Error('1click lists no FOO on near'), { reason: 'unsupported_asset' });
  const h = makeCtx({ rails: [pricingRail(err)] });
  const p = await h.svc.proposeSwap({ chain: 'near', fromSymbol: 'FOO', toSymbol: 'USDC', amountIn: '1' });
  assert.deepEqual(p.verdict.reasonCodes, ['unsupported_asset']);
  assert.match(p.verdict.reasons.at(-1) ?? '', /1click lists no FOO on near/);
  assert.doesNotMatch(p.verdict.reasons.at(-1) ?? '', /Nobody offered a price/);
});
