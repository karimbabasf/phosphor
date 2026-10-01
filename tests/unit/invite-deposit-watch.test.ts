// The deposit watch and an invite claim landing in the same wallet. The watch calls a deposit
// credited the moment NEAR USDC rises, and a claim is exactly such a rise, so while a claim runs
// the watch holds "credited" on that asset, and once the claim is proven its amount joins the
// baseline. Spec: docs/superpowers/specs/2026-10-01-invite-codes-design.md, "Deposit watch".

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Ledger } from '../../src/ledger/index.ts';
import type { IntentsRead } from '../../src/ledger/intents.ts';
import type { LedgerSnapshot } from '../../src/types.ts';
import { createDepositWatch } from '../../src/vault/watch.ts';
import { INVITE_ASSET_ID } from '../../src/invite/payload.ts';

const ACCOUNT = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const NEAR_USDC = { assetId: INVITE_ASSET_ID, decimals: 6, contract: null };
const BASE_USDC = { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };

function ledgerWith(intents: IntentsRead | undefined): Ledger {
  const snapshot = { holdings: [], mode: 'live', prices: {}, priceAsOf: {} } as unknown as LedgerSnapshot;
  return { snapshot: () => snapshot, intents: () => intents, hyperliquid: () => undefined, refresh: async () => snapshot };
}

const READ_OK: IntentsRead = { holdings: [], ok: true, fetchedAt: '2026-10-01T10:00:00.000Z', failures: 0 };

function build(intents: IntentsRead | undefined = READ_OK) {
  const balances = new Map<string, bigint | null>([
    [NEAR_USDC.assetId, 0n],
    [BASE_USDC.assetId, 0n],
  ]);
  const watch = createDepositWatch({
    ledger: ledgerWith(intents),
    sse: { broadcast: () => {}, broadcastState: () => {} },
    account: () => ACCOUNT,
    refresh: async () => {},
    recent: async () => [],
    balance: async (_account, assetId) => balances.get(assetId) ?? null,
    now: () => Date.parse('2026-10-01T10:00:00.000Z'),
    pollMs: 5,
  });
  return { watch, balances };
}

async function ticks(n = 4): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5 * n + 15));
}

test('a claim on NEAR USDC is not a deposit, and a real deposit in the same window still is', async () => {
  const { watch, balances } = build();
  watch.show('near', 'USDC', null, NEAR_USDC);
  await ticks();
  assert.equal(watch.current()?.phase, 'watching');

  const release = watch.holdForClaim(INVITE_ASSET_ID);
  // The claim's 5 USDC and a real 2 USDC deposit land while the claim is being proven.
  balances.set(INVITE_ASSET_ID, 7_000_000n);
  await ticks();
  assert.equal(watch.current()?.phase, 'watching', 'held: no credit while a claim runs on this asset');

  release(5_000_000n);
  await ticks();
  const state = watch.current();
  assert.equal(state?.phase, 'credited', 'the deposit is still a deposit');
  assert.equal(state?.amount, 2, 'and only the deposit is counted');
  watch.stop();
});

test('a claim alone never ends the watch as credited', async () => {
  const { watch, balances } = build();
  watch.show('near', 'USDC', null, NEAR_USDC);
  await ticks();
  const release = watch.holdForClaim(INVITE_ASSET_ID);
  balances.set(INVITE_ASSET_ID, 5_000_000n);
  await ticks();
  release(5_000_000n);
  await ticks();
  assert.equal(watch.current()?.phase, 'watching');
  // A failed claim proves nothing, so nothing joins the baseline, and nothing has risen either.
  const failed = watch.holdForClaim(INVITE_ASSET_ID);
  await ticks();
  failed(null);
  await ticks();
  assert.equal(watch.current()?.phase, 'watching');
  watch.stop();
});

test('a watch opened mid-claim takes no baseline until the claim ends, then a clean one', async () => {
  const { watch, balances } = build(undefined);
  const release = watch.holdForClaim(INVITE_ASSET_ID);
  watch.show('near', 'USDC', null, NEAR_USDC);
  balances.set(INVITE_ASSET_ID, 5_000_000n);
  await ticks();
  assert.equal(watch.current()?.phase, 'watching');
  release(5_000_000n);
  await ticks();
  assert.equal(watch.current()?.phase, 'watching', 'the first read after the claim holds it, so it is the baseline');
  balances.set(INVITE_ASSET_ID, 6_000_000n);
  await ticks();
  assert.equal(watch.current()?.phase, 'credited');
  assert.equal(watch.current()?.amount, 1);
  watch.stop();
});

test('a claim on NEAR USDC does not hold a watch on another asset', async () => {
  const { watch, balances } = build();
  watch.show('base', 'USDC', '0xdeadbeef', BASE_USDC);
  await ticks();
  const release = watch.holdForClaim(INVITE_ASSET_ID);
  balances.set(BASE_USDC.assetId, 3_000_000n);
  await ticks();
  assert.equal(watch.current()?.phase, 'credited');
  assert.equal(watch.current()?.amount, 3);
  release(5_000_000n);
  watch.stop();
});
