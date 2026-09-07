// How old a price may be before the app stops sizing money against it.
//
// One endpoint feeds every native price, and a failed fetch fell back to the last known value
// with no timestamp, no age limit and no staleness flag. That number is not decoration: priceOf
// reads it, usdOf turns it into draft.amountUsd, and every budget in the policy engine is
// measured against that. So ETH doubling while the endpoint is failing for this app means a
// 3 ETH swap governs as if it were 1.5 ETH, clears a per-transaction cap it should have
// breached, and may fall under the human click threshold.
//
// docs/architecture.md already promises the opposite for chains: a chain that fails to read is
// marked stale with a timestamp and never silently shows zero. Prices had no equivalent.
//
// The cold start was always correct: with no fallback the price is 0, priceOf returns null,
// usdOf returns Infinity and the engine refuses as invalid_amount. That is the failure mode this
// bound reuses, rather than inventing a second one.
//
// Run: node --test tests/unit/pricing.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { PRICE_STALENESS_MS, priceOf, usdOf } from '../../src/proposals/draft.ts';
import type { PCtx } from '../../src/proposals/lifecycle.ts';
import type { LedgerSnapshot } from '../../src/types.ts';

const ctx = { stables: new Set(['USDC', 'USDT', 'DAI']) } as unknown as PCtx;

function snapshotAged(ageMs: number | undefined): LedgerSnapshot {
  const base = loadDemoLedger();
  return {
    ...base,
    prices: { ...base.prices, ETH: 3000 },
    ...(ageMs === undefined ? {} : { priceAsOf: { ETH: Date.now() - ageMs } }),
  };
}

test('the bound is two minutes, which is the number the plan names', () => {
  assert.equal(PRICE_STALENESS_MS, 120_000);
});

test('a price older than the staleness bound is not a price', () => {
  assert.equal(priceOf(ctx, 'ETH', snapshotAged(PRICE_STALENESS_MS + 1_000)), null);
});

test('a price inside the bound still prices', () => {
  assert.equal(priceOf(ctx, 'ETH', snapshotAged(5_000)), 3000);
});

test('a stale price refuses a rail draft rather than sizing it', () => {
  // Infinity, never NaN: the engine refuses a non-finite amount as invalid_amount, where NaN
  // would make every comparison against a cap false and sail through all of them.
  assert.equal(usdOf(ctx, 'ETH', 3, snapshotAged(PRICE_STALENESS_MS + 1_000)), Infinity);
  assert.equal(usdOf(ctx, 'ETH', 3, snapshotAged(5_000)), 9000);
});

test('WETH ages with ETH, because it is the same price behind two contracts', () => {
  assert.equal(priceOf(ctx, 'WETH', snapshotAged(PRICE_STALENESS_MS + 1_000)), null);
  assert.equal(priceOf(ctx, 'WETH', snapshotAged(5_000)), 3000);
});

test('a stable is one dollar whatever the spot table says or how old it is', () => {
  // The risk table decides this, not the price feed, so there is nothing here to go stale.
  assert.equal(priceOf(ctx, 'USDC', snapshotAged(PRICE_STALENESS_MS * 10)), 1);
});

test('a price carrying no timestamp at all is refused, since an unknown age is not a fresh one', () => {
  const snapshot = { ...snapshotAged(5_000), priceAsOf: {} };
  assert.equal(priceOf(ctx, 'ETH', snapshot), null);
});

test('a snapshot with no priceAsOf map at all keeps its old behaviour', () => {
  // Demo mode and every test fixture build a snapshot without one. Those prices are a static
  // table rather than a reading off a wire, so there is no fetch time to be old.
  assert.equal(priceOf(ctx, 'ETH', snapshotAged(undefined)), 3000);
});

// ---------- the stamp itself ----------

test('a failed price fetch keeps the old timestamp, so the value ages out of use', async () => {
  const { createLedger } = await import('../../src/ledger/index.ts');
  const os = await import('node:os');
  const nodePath = await import('node:path');

  let coinbaseWorks = true;
  const fetchImpl = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('api.exchange.coinbase.com')) {
      if (!coinbaseWorks) return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' };
      // [time, low, high, open, close, volume], newest first.
      return { ok: true, status: 200, json: async () => [[0, 0, 0, 0, 3000, 0]], text: async () => '' };
    }
    // Every chain read fails, which is a state this ledger is built to survive: it keeps the
    // last good holdings and marks the chain stale.
    return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' };
  }) as unknown as typeof fetch;

  const cfg = {
    mode: 'live',
    port: 0,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 0,
    candleProducts: [],
    dataDir: os.tmpdir(),
    keysPath: nodePath.join(os.tmpdir(), 'phosphor-pricing-keys', 'keys.json'),
  } as never;

  const ledger = createLedger(cfg, { fetchImpl });

  await ledger.refresh();
  const first = ledger.snapshot();
  assert.equal(first.prices.ETH, 3000);
  const stampedAt = first.priceAsOf?.ETH;
  assert.equal(typeof stampedAt, 'number');

  coinbaseWorks = false;
  await ledger.refresh();
  const second = ledger.snapshot();

  assert.equal(second.prices.ETH, 3000, 'the last known price is still shown, which is right for a display');
  assert.equal(second.priceAsOf?.ETH, stampedAt, 'and it carries the time it was read, not the time it was reused');
});
