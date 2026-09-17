// A never-funded account is a known thing, not a mystery.
//
// The trade strip said "Still reading the account. The venue has not said what kind it is." on
// every fresh install, forever. The account kind detection (src/trade/feed-ws.ts detectUnified)
// answered null when the perp view read zero and activeAssetData had nothing to add, which is
// exactly what an EMPTY account looks like, and the one read that could settle it (the spot
// balance, zero as well) was skipped while the answer was null. Stuck by construction.
//
// So: a zero perp value with a completed spot read that holds nothing is a plain empty account,
// known and empty, and the strip falls through to "No trading money yet".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, openFeed } from '../fixtures/unified-account.ts';

const EMPTY_CLEARINGHOUSE: Record<string, unknown> = {
  marginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' },
  crossMarginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' },
  crossMaintenanceMarginUsed: '0.0',
  withdrawable: '0.0',
  assetPositions: [],
  time: 1_786_492_800_000,
};

test('an empty account settles to known within one spot poll, with every figure at zero', async (t) => {
  // The venue answers the spot read with no balances at all, which is what a wallet that has
  // never been funded gets back.
  const h = await openFeed({ spot: { balances: [] } });
  t.after(() => h.stop());
  await flush();

  h.deliver('clearinghouseState', EMPTY_CLEARINGHOUSE);
  await flush();

  const account = h.feed.account();
  assert.ok(account !== null, 'the account was heard');
  assert.equal(account.accountKnown, true, 'a zero perp value and an empty spot read is a known, empty account');
  assert.equal(account.unified, false);
  assert.equal(account.equityUsd, 0);
  assert.equal(account.freeUsd, 0);
  assert.equal(account.perpValueUsd, 0);
});

test('a spot read that answers a zero USDC row settles the same way', async (t) => {
  const h = await openFeed({ spot: { balances: [{ coin: 'USDC', token: 0, total: '0.0', hold: '0.0', entryNtl: '0.0' }] } });
  t.after(() => h.stop());
  await flush();

  h.deliver('clearinghouseState', EMPTY_CLEARINGHOUSE);
  await flush();

  const account = h.feed.account();
  assert.ok(account !== null);
  assert.equal(account.accountKnown, true);
  assert.equal(account.spotUsdcUsd, 0);
});

test('a zero perp value with money in spot stays unknown until activeAssetData speaks, because it may be a funded unified account', async (t) => {
  const h = await openFeed({ spot: { balances: [{ coin: 'USDC', token: 0, total: '250.0', hold: '0.0', entryNtl: '250.0' }] } });
  t.after(() => h.stop());
  await flush();

  h.deliver('clearinghouseState', EMPTY_CLEARINGHOUSE);
  await flush();

  const account = h.feed.account();
  assert.ok(account !== null);
  assert.equal(account.accountKnown, false, 'money on the spot side is not nothing, and which book it backs is not yet known');
});
