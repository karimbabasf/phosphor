import { test } from 'node:test';
import assert from 'node:assert/strict';

import { oneClickQuoter, syntheticQuoter, stubSigner, assetIdFor } from '../../src/intents.ts';
import type { TokensFile, OneClickToken } from '../../src/intents.ts';
import { coinbaseSource, krakenSource, cachedCandles } from '../../src/candles.ts';
import type { TransferLeg } from '../../src/types.ts';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

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

const leg: TransferLeg = {
  fromChain: 'eth',
  toChain: 'base',
  symbol: 'USDC',
  amount: 100,
  amountUsd: 100,
  from: '0xfrom0000000000000000000000000000000000',
  to: '0xto000000000000000000000000000000000000',
  quote: null,
  gasNativeUsd: 5,
};

// ---------- intents.ts ----------

test('assetIdFor matches on blockchain and lowercased contract address', () => {
  const id = assetIdFor('eth', tokensFixture.eth.USDC.tokenId, oneClickTokensFixture);
  assert.equal(id, oneClickTokensFixture[0].assetId);

  const missing = assetIdFor('arb', '0xnope', oneClickTokensFixture);
  assert.equal(missing, null);
});

test('oneClickQuoter maps a TransferLeg to base units and asset ids, and computes LegQuote from the response', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/v0/tokens')) return jsonResponse(oneClickTokensFixture);
    if (u.endsWith('/v0/quote')) {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        quote: {
          amountIn: '100000000',
          amountInFormatted: '100',
          amountInUsd: '100.00',
          minAmountIn: '99000000',
          amountOut: '99980000',
          amountOutFormatted: '99.98',
          amountOutUsd: '99.96',
          minAmountOut: '98980000',
          timeEstimate: 8,
          refundFee: '0',
          withdrawFee: '0',
        },
        quoteRequest: {},
        signature: 'sig',
        timestamp: '2026-08-11T00:00:00.000Z',
        correlationId: 'abc123',
      });
    }
    throw new Error(`unexpected url in test: ${u}`);
  };

  const quoter = oneClickQuoter(tokensFixture, { fetchImpl });
  const result = await quoter.quoteLeg(leg);

  assert.ok(capturedBody);
  assert.equal(capturedBody!.amount, '100000000');
  assert.equal(capturedBody!.originAsset, oneClickTokensFixture[0].assetId);
  assert.equal(capturedBody!.destinationAsset, oneClickTokensFixture[1].assetId);
  assert.equal(capturedBody!.dry, true);
  assert.equal(capturedBody!.swapType, 'EXACT_INPUT');
  assert.equal(capturedBody!.slippageTolerance, 100);
  assert.equal(capturedBody!.refundTo, leg.from);
  assert.equal(capturedBody!.recipient, leg.to);
  assert.equal(capturedBody!.refundType, 'ORIGIN_CHAIN');
  assert.equal(capturedBody!.recipientType, 'DESTINATION_CHAIN');
  assert.equal(capturedBody!.depositType, 'ORIGIN_CHAIN');

  assert.equal(result.amountOut, 99.98);
  assert.ok(Math.abs(result.feeUsd - 0.04) < 1e-9);
  assert.equal(result.timeEstimateSec, 8);
});

test('oneClickQuoter throws the solver error message verbatim on a non-200 response', async () => {
  const fetchImpl: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/v0/tokens')) return jsonResponse(oneClickTokensFixture);
    if (u.endsWith('/v0/quote')) return jsonResponse({ message: 'insufficient liquidity' }, false, 400);
    throw new Error(`unexpected url in test: ${u}`);
  };

  const quoter = oneClickQuoter(tokensFixture, { fetchImpl });
  await assert.rejects(
    () => quoter.quoteLeg(leg),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error).message, 'insufficient liquidity');
      return true;
    },
  );
});

test('syntheticQuoter is deterministic', async () => {
  const quoter = syntheticQuoter();
  const a = await quoter.quoteLeg(leg);
  const b = await quoter.quoteLeg(leg);
  assert.deepEqual(a, b);
  assert.equal(a.amountOut, leg.amount * 0.9999 - 0.02);
  assert.equal(a.feeUsd, leg.amount * 0.0001 + 0.02);
  assert.equal(a.timeEstimateSec, 8);
});

test('stubSigner is not ready and send resolves with its describe message', async () => {
  const signer = stubSigner();
  assert.equal(signer.ready, false);
  assert.match(signer.describe(), /No signer configured/);

  const result = await signer.send(leg, '0xdeposit');
  assert.equal(result.ok, false);
  assert.equal(result.error, signer.describe());
});

// ---------- candles.ts ----------

test('coinbaseSource maps rows to oldest-first candles with correct field order', async () => {
  const rows = [
    [300, 10, 20, 15, 18, 100],
    [200, 9, 19, 14, 17, 90],
    [100, 8, 18, 13, 16, 80],
  ];
  const fetchImpl: typeof fetch = async (url) => {
    assert.ok(String(url).includes('/products/BTC-USD/candles'));
    assert.ok(String(url).includes('granularity=60'));
    return jsonResponse(rows);
  };

  const source = coinbaseSource({ fetchImpl });
  const candles = await source.candles('BTC-USD', 60, 3);
  assert.deepEqual(candles.map((c) => c.t), [100, 200, 300]);
  assert.deepEqual(candles[0], { t: 100, o: 13, h: 18, l: 8, c: 16, v: 80 });
});

test('krakenSource maps BTC-USD to the XBTUSD pair and reads oldest-first rows', async () => {
  const rows = [
    [100, '13', '18', '8', '16', '15', '80', 5],
    [200, '14', '19', '9', '17', '16', '90', 6],
  ];
  const fetchImpl: typeof fetch = async (url) => {
    assert.ok(String(url).includes('pair=XBTUSD'));
    return jsonResponse({ error: [], result: { XBTUSD: rows, last: 200 } });
  };

  const source = krakenSource({ fetchImpl });
  const candles = await source.candles('BTC-USD', 60, 2);
  assert.deepEqual(candles.map((c) => c.t), [100, 200]);
  assert.deepEqual(candles[0], { t: 100, o: 13, h: 18, l: 8, c: 16, v: 80 });
});

test('cachedCandles returns stale:true with prior data when primary and fallback both fail', async () => {
  let primaryCalls = 0;
  const rows = [[100, 8, 18, 13, 16, 80]];
  const primaryFetch: typeof fetch = async () => {
    primaryCalls += 1;
    if (primaryCalls === 1) return jsonResponse(rows);
    return jsonResponse({}, false, 500);
  };
  const fallbackFetch: typeof fetch = async () => jsonResponse({}, false, 500);

  const primary = coinbaseSource({ fetchImpl: primaryFetch });
  const fallback = krakenSource({ fetchImpl: fallbackFetch });
  const service = cachedCandles(primary, fallback);

  const first = await service.get('BTC-USD', 60, 1);
  assert.equal(first.stale, false);
  assert.equal(first.source, 'coinbase');
  assert.equal(first.candles.length, 1);

  const second = await service.get('BTC-USD', 60, 1);
  assert.equal(second.stale, true);
  assert.equal(second.source, 'coinbase');
  assert.deepEqual(second.candles, first.candles);
});

test('cachedCandles throws when both sources fail and nothing is cached', async () => {
  const alwaysFail: typeof fetch = async () => jsonResponse({}, false, 500);
  const primary = coinbaseSource({ fetchImpl: alwaysFail });
  const fallback = krakenSource({ fetchImpl: alwaysFail });
  const service = cachedCandles(primary, fallback);

  await assert.rejects(() => service.get('BTC-USD', 60, 1));
});
