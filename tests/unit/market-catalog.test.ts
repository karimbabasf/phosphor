// Resolving what a person typed into what a venue lists, and the paging that reaches past
// a venue's per-response cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import { createCatalog, normalizeQuery } from '../../src/market/catalog.ts';
import { pageBackward, planBase, COINBASE_NATIVES, HYPERLIQUID_NATIVES } from '../../src/market/providers.ts';

const HL_META = {
  universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }, { name: 'HYPE' }, { name: 'WIF' }, { name: 'OLD', isDelisted: true }],
};

const CB_PRODUCTS = [
  { id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', status: 'online' },
  { id: 'PEPE-USD', base_currency: 'PEPE', quote_currency: 'USD', status: 'online' },
  { id: 'DEAD-USD', base_currency: 'DEAD', quote_currency: 'USD', status: 'delisted' },
  { id: 'BTC-EUR', base_currency: 'BTC', quote_currency: 'EUR', status: 'online' },
];

function stubFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('hyperliquid')) {
      return { ok: true, json: async () => HL_META, text: async () => '', headers: new Headers() };
    }
    return { ok: true, json: async () => CB_PRODUCTS, text: async () => '', headers: new Headers() };
  }) as unknown as typeof fetch;
}

async function loaded() {
  const catalog = createCatalog({ fetchImpl: stubFetch() });
  await catalog.refresh();
  return catalog;
}

test('a query is stripped to the symbol a venue would know', () => {
  assert.deepEqual(normalizeQuery('btc'), { symbol: 'BTC', quote: null });
  assert.deepEqual(normalizeQuery('BTC-USD'), { symbol: 'BTC', quote: 'USD' });
  assert.deepEqual(normalizeQuery('btc/usd'), { symbol: 'BTC', quote: 'USD' });
  assert.deepEqual(normalizeQuery('btcusd'), { symbol: 'BTC', quote: 'USD' });
  assert.deepEqual(normalizeQuery(' bitcoin '), { symbol: 'BTC', quote: null });
  assert.deepEqual(normalizeQuery('ethereum'), { symbol: 'ETH', quote: null });
});

test('a coin both venues list resolves to the one this app trades on', async () => {
  const catalog = await loaded();
  const ref = catalog.resolve('btc');
  assert.equal(ref?.product, 'BTC-USD');
  assert.equal(ref?.provider, 'hyperliquid', 'Hyperliquid wins because that is where execution goes');
});

test('a coin only one venue lists still resolves', async () => {
  const catalog = await loaded();
  assert.equal(catalog.resolve('pepe')?.provider, 'coinbase');
  assert.equal(catalog.resolve('wif')?.provider, 'hyperliquid');
});

test('the seven hardcoded products are no longer the limit', async () => {
  const catalog = await loaded();
  // None of these were reachable before: they were not in config.json.
  for (const query of ['wif', 'hype', 'pepe']) {
    assert.ok(catalog.resolve(query) !== null, `${query} should resolve`);
  }
});

test('a delisted or offline market is not offered', async () => {
  const catalog = await loaded();
  assert.equal(catalog.resolve('OLD'), null, 'a delisted perp is gone');
  assert.equal(catalog.resolve('DEAD'), null, 'an offline spot pair is gone');
});

test('an explicit quote is honoured when the venue lists it', async () => {
  const catalog = await loaded();
  assert.equal(catalog.resolve('BTC-EUR')?.quote, 'EUR');
});

test('an unknown symbol resolves to nothing rather than to something close', async () => {
  const catalog = await loaded();
  assert.equal(catalog.resolve('NOTACOIN'), null);
});

test('search offers ranked candidates so an agent can ask instead of guessing', async () => {
  const catalog = await loaded();
  const hits = catalog.search('BT');
  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.symbol, 'BTC', 'the closest match ranks first');
});

test('one venue being down still leaves a usable catalogue', async () => {
  const halfDown = (async (input: string | URL) => {
    if (String(input).includes('hyperliquid')) throw new Error('network down');
    return { ok: true, json: async () => CB_PRODUCTS, text: async () => '', headers: new Headers() };
  }) as unknown as typeof fetch;

  const catalog = createCatalog({ fetchImpl: halfDown });
  await catalog.refresh();
  assert.equal(catalog.resolve('pepe')?.provider, 'coinbase');
});

test('a symbol can be pinned to one venue, which is what stops a spliced series', () => {
  // The bug this exists to prevent: sub-minute history comes from the Coinbase trade tape
  // while the live stream is a Hyperliquid perp. Splicing them draws a clean chart with a
  // step in it where the spot-perp basis lands, which reads as a real move and is not one.
  return loaded().then((catalog) => {
    assert.equal(catalog.resolve('btc')?.provider, 'hyperliquid', 'BTC prefers the perp venue overall');
    assert.equal(catalog.resolveOn('btc', 'coinbase')?.provider, 'coinbase', 'but can be pinned to the tape venue');
    assert.equal(catalog.resolveOn('btc', 'coinbase')?.product, 'BTC-USD');
    assert.equal(catalog.resolveOn('wif', 'coinbase'), null, 'a perp-only coin has no tape venue, so seconds stay live-only');
    assert.equal(catalog.resolveOn('pepe', 'hyperliquid'), null);
  });
});

test('the base to fetch is chosen from what the venue actually serves', () => {
  const hl = { product: 'BTC-USD', provider: 'hyperliquid' as const, symbol: 'BTC', quote: 'USD', kind: 'perp' as const };
  const cb = { product: 'PEPE-USD', provider: 'coinbase' as const, symbol: 'PEPE', quote: 'USD', kind: 'spot' as const };

  assert.equal(planBase(hl, 14_400).baseSec, 14_400, 'Hyperliquid serves 4h natively');
  assert.equal(planBase(cb, 14_400).baseSec, 3600, 'Coinbase does not, so 4h folds from 1h');
  assert.equal(planBase(cb, 1800).baseSec, 900, 'Coinbase has no 30m, so it folds from 15m');
  assert.equal(planBase(hl, 420).baseSec, 60, '7m folds from 1m on either venue');
  assert.equal(planBase(hl, 30).provider, 'trades', 'sub-minute leaves the candle rail entirely');
});

test('the native tables match what the venues were measured to accept', () => {
  assert.ok(!COINBASE_NATIVES.includes(14_400), 'Coinbase answers 4h with 400 Unsupported granularity');
  assert.ok(!COINBASE_NATIVES.includes(1800), 'and has no 30m either');
  assert.ok(HYPERLIQUID_NATIVES.includes(14_400), 'Hyperliquid does serve 4h');
});

test('paging walks backward until the bar count is met', async () => {
  let calls = 0;
  const rows = (startSec: number, endSec: number): Candle[] => {
    calls++;
    const out: Candle[] = [];
    for (let t = Math.ceil(startSec / 60) * 60; t <= endSec; t += 60) {
      out.push({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });
    }
    return out.slice(-300); // the venue's cap
  };

  const got = await pageBackward(async (s, e) => rows(s, e), {
    baseSec: 60,
    bars: 900,
    maxRowsPerCall: 300,
    nowSec: 1_700_000_000,
  });

  assert.ok(calls >= 3, `three pages of three hundred to reach nine hundred, took ${calls}`);
  assert.equal(got.length, 900);
  for (let i = 1; i < got.length; i++) {
    assert.ok((got[i] as Candle).t > (got[i - 1] as Candle).t, 'ordered oldest first with no duplicates');
  }
});

test('paging stops when the venue runs out of history instead of looping', async () => {
  let calls = 0;
  const got = await pageBackward(
    async () => {
      calls++;
      // The venue keeps answering with the same single old bar: it has no more.
      return [{ t: 1_699_000_000, o: 1, h: 1, l: 1, c: 1, v: 1 }];
    },
    { baseSec: 60, bars: 5000, maxRowsPerCall: 300, nowSec: 1_700_000_000, maxPages: 20 },
  );

  assert.ok(calls <= 2, `should stop as soon as history stops moving, took ${calls}`);
  assert.equal(got.length, 1);
});
