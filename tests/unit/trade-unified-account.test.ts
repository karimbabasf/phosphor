// The risk panel showed two answers to one question, and both of them were on screen at once.
//
// A unified account holding a cross short: the venue said the position dies at 713.42, which is
// 838 percent away, and the panel said the account was 0.48 healthy with 4.66 dollars left after
// a five percent move, which is a position dying at about 79.59, which is 4.6 percent away. A
// factor of 181 between two numbers a human reads in the same glance.
//
// Neither figure was corrupt. Both were computed correctly from the perp view of an account whose
// money is not in the perp view. The detection that was supposed to catch that had two tells,
// and this account tripped neither: the first only ever fires on a long, and the second only on
// an account holding nothing.
//
// So the test that matters here is not "is the flag right". It is that no two figures the payload
// publishes may imply different liquidation prices. The flag is one way to get that wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTradePayload, type AssetMeta, type TradePayload } from '../../src/trade/state.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { liquidationPrice } from '../../src/hl/liquidation.ts';
import {
  ACTIVE_ASSET_DATA,
  CLEARINGHOUSE_STATE,
  PERP_ACCOUNT_VALUE,
  SPOT_USDC_TOTAL,
  VENUE_LIQ_PX,
  openFeed,
  type FeedHarness,
} from '../fixtures/unified-account.ts';
import type { TradeFeed } from '../../src/trade/feed-ws.ts';

const NOW = 1_786_492_801_000;

// A tenth of a percent, which is 71 cents on this position. The disagreement being guarded
// against is 634 dollars, and the nearest wrong answer worth ruling out (counting the perp
// account value as money on top of spot) is 7 dollars out, so the band is not a close call in
// either direction.
const LIQ_TOLERANCE_PCT = 0.1;

function meta(): Map<string, AssetMeta> {
  return new Map([['SOL', { assetId: 1, szDecimals: 2, maxLeverage: 10 }]]);
}

function payloadFrom(feed: TradeFeed): TradePayload {
  return buildTradePayload({
    view: createTradeView('SOL', () => NOW).state(),
    feed,
    mandates: [],
    meta: meta(),
    atrFor: () => 2.4,
    products: ['SOL'],
    nowMs: NOW,
    network: 'testnet',
    address: '0x2222222222222222222222222222222222222222',
  });
}

// Where the panel's own figures say the position dies, using nothing that is not published on it.
//
// Anchored at the mark rather than the entry, because equity and notional are both measured at
// the mark, and Hyperliquid's documented formula anchors wherever those were read. Maintenance
// leverage comes from the account's own maintenance requirement over the notional next to it, so
// no constant is assumed about the asset.
function impliedLiqPx(payload: TradePayload, p: TradePayload['positions'][number]): number | null {
  const equity = payload.account.equityUsd;
  const maintenance = payload.account.maintenanceUsd;
  if (equity === null || maintenance === null || maintenance <= 0) return null;
  if (p.markPx === null || p.markPx <= 0 || p.sizeCoin <= 0) return null;
  return liquidationPrice({
    entryPx: p.markPx,
    side: p.side,
    positionSize: p.sizeCoin,
    marginAvailable: equity - maintenance,
    maintenanceLeverage: p.notionalUsd / maintenance,
  });
}

// The invariant. Every cross position the venue has published a liquidation price for either
// agrees with the panel's own arithmetic, or the panel published nothing to disagree with.
function assertOneLiquidationPrice(payload: TradePayload, when: string): void {
  for (const p of payload.positions) {
    if (p.liqPx === null || p.leverageType !== 'cross') continue;
    const implied = impliedLiqPx(payload, p);
    if (implied === null) {
      // The other half of the invariant: with no equity published, nothing derived from it may
      // be published either.
      assert.equal(payload.account.healthPct, null, `${when}: health without an equity`);
      assert.equal(payload.account.crossLeverage, null, `${when}: leverage without an equity`);
      assert.equal(
        payload.account.equityAtFivePctAdverse,
        null,
        `${when}: a stress figure without an equity`,
      );
      continue;
    }
    const offPct = (Math.abs(implied - p.liqPx) / p.liqPx) * 100;
    assert.ok(
      offPct <= LIQ_TOLERANCE_PCT,
      `${when}: the panel implies ${p.coin} dies at ${implied.toFixed(4)}, the venue says ${p.liqPx}` +
        ` (${offPct.toFixed(2)}% apart)`,
    );
  }
}

async function held(t: { after(fn: () => void): void }): Promise<FeedHarness> {
  const h = await openFeed();
  t.after(() => h.stop());
  return h;
}

// ---------- the acceptance test ----------

test('no two figures on the panel imply different liquidation prices', async (t) => {
  const h = await held(t);

  // The account message on its own. This is every reconnect's first paint, and it lasts until a
  // watched coin answers, which is not a moment the human can be told to ignore.
  h.deliver('clearinghouseState', CLEARINGHOUSE_STATE);
  assertOneLiquidationPrice(payloadFrom(h.feed), 'on the account message alone');

  // And with the collateral message in.
  h.deliver('activeAssetData', ACTIVE_ASSET_DATA);
  const settled = payloadFrom(h.feed);
  assertOneLiquidationPrice(settled, 'settled');

  // The invariant holds trivially if the panel goes dark, so this pins that it did not: the
  // account is known, and the figure it is known by is the venue's own.
  assert.equal(settled.account.accountKnown, true, 'the account never settled');
  assert.equal(settled.account.unified, true, 'a unified account read as a plain perp account');
  assert.ok(settled.account.equityUsd !== null, 'equity went dark instead of being right');
});

// ---------- detection ----------

test('a unified account holding a short is detected with no collateral message to read', async (t) => {
  const h = await held(t);
  // Nothing here but clearinghouseState and the spot balance read at boot. totalRawUsd is
  // POSITIVE at 110.07 because a short sells first, so the negative-raw tell cannot fire, and
  // accountValue is 9.65 rather than 0.0, so the flat-account tell cannot fire either.
  h.deliver('clearinghouseState', CLEARINGHOUSE_STATE);

  const acc = h.feed.account();
  assert.ok(acc !== null);
  assert.equal(acc.unified, true);
  assert.equal(acc.accountKnown, true);
});

test('collateral the perp pot cannot supply is enough on its own, with no liquidation price to read', async (t) => {
  const h = await held(t);
  // The venue publishes no liquidationPx on a cross position often enough that it is the most
  // likely null on the whole payload, so detection cannot depend on having one.
  const noLiq = {
    ...CLEARINGHOUSE_STATE,
    assetPositions: [
      {
        type: 'oneWay',
        position: {
          ...(CLEARINGHOUSE_STATE.assetPositions as Array<{ position: Record<string, unknown> }>)[0]
            .position,
          liquidationPx: null,
        },
      },
    ],
  };
  h.deliver('clearinghouseState', noLiq);
  assert.equal(h.feed.account()?.unified, false, 'nothing has proved anything yet');

  // 878 dollars to trade with, on an account whose entire perp pot is worth 9.65. The extra is
  // not in the perp pot, which is the whole definition of the unified account.
  h.deliver('activeAssetData', ACTIVE_ASSET_DATA);
  assert.equal(h.feed.account()?.unified, true);
});

test('a plain perp account keeps every figure it has', async (t) => {
  const h = await openFeed({ spot: { balances: [] } });
  t.after(() => h.stop());

  // The same position, on an account whose money is where the perp view says it is: 950 of
  // equity, a liquidation price the venue priced against exactly that, and no spot balance.
  h.deliver('clearinghouseState', {
    marginSummary: {
      accountValue: '950.0',
      totalNtlPos: '100.42164',
      totalRawUsd: '1050.42164',
      totalMarginUsed: '10.042164',
    },
    crossMaintenanceMarginUsed: '5.021082',
    withdrawable: '939.957836',
    assetPositions: [
      {
        position: {
          coin: 'SOL',
          szi: '-1.32',
          entryPx: '75.823',
          positionValue: '100.42164',
          unrealizedPnl: '-0.33528',
          // (950 + 100.42164) / (1.32 * 1.05), the venue pricing against the perp pot.
          liquidationPx: '757.7376334776',
          leverage: { type: 'cross', value: 10 },
          marginUsed: '10.042164',
          cumFunding: { allTime: '0.055832', sinceOpen: '0.055832', sinceChange: '0.055832' },
        },
      },
    ],
    time: 1_786_492_800_000,
  });
  h.deliver('activeAssetData', { ...ACTIVE_ASSET_DATA, availableToTrade: ['939.957836', '939.957836'] });

  const payload = payloadFrom(h.feed);
  assert.equal(payload.account.unified, false, 'a plain perp account was called unified');
  assert.equal(payload.account.equityUsd, 950);
  assert.ok(payload.account.healthPct !== null, 'a perp account lost its health figure');
  assert.ok(payload.account.crossLeverage !== null, 'a perp account lost its leverage figure');
  assertOneLiquidationPrice(payload, 'plain perp account');
});

test('a disagreement that cannot be pinned on one position reads unknown, not settled', async (t) => {
  const h = await held(t);
  // Two cross positions, which is not a capture: it is the same account with a second position
  // bolted on. Maintenance margin is reported for the account and never per position, so with
  // two open there is no way to say which of them the 5.02 belongs to, and the equity read back
  // out of a liquidation price becomes an estimate. An estimate is enough to refuse to answer
  // and not enough to answer.
  h.deliver('clearinghouseState', {
    ...CLEARINGHOUSE_STATE,
    marginSummary: {
      accountValue: '9.651052',
      totalNtlPos: '200.42164',
      totalRawUsd: '110.072692',
      totalMarginUsed: '20.042164',
    },
    assetPositions: [
      (CLEARINGHOUSE_STATE.assetPositions as unknown[])[0],
      {
        position: {
          coin: 'BTC',
          szi: '0.001',
          entryPx: '100000.0',
          positionValue: '100.0',
          unrealizedPnl: '0.0',
          liquidationPx: null,
          leverage: { type: 'cross', value: 10 },
          marginUsed: '10.0',
          cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' },
        },
      },
    ],
  });

  const acc = h.feed.account();
  assert.ok(acc !== null);
  assert.equal(acc.accountKnown, false, 'an estimate was treated as an answer');
  assert.equal(acc.equityUsd, null, 'a figure was published from a reading that is not settled');
  assertOneLiquidationPrice(payloadFrom(h.feed), 'two positions, one maintenance figure');
});

// ---------- the unified branch ----------

test('equity on a unified account is the spot balance, not spot plus the perp account value', async (t) => {
  const h = await held(t);
  h.deliver('clearinghouseState', CLEARINGHOUSE_STATE);
  h.deliver('activeAssetData', ACTIVE_ASSET_DATA);

  const payload = payloadFrom(h.feed);
  assert.equal(payload.account.equityUsd, SPOT_USDC_TOTAL);

  // Not an opinion about what position equity means. The venue's own liquidation price is only
  // reproducible from the spot balance alone: adding the 9.65 the perp view reports moves the
  // wall 7 dollars out, because that 9.65 is margin already drawn from this same spot balance
  // and counting it twice is counting the same dollars twice.
  const both = liquidationPrice({
    entryPx: 76.077,
    side: 'short',
    positionSize: 1.32,
    marginAvailable: SPOT_USDC_TOTAL + PERP_ACCOUNT_VALUE - 5.021082,
    maintenanceLeverage: 20,
  });
  assert.ok(
    Math.abs(both - VENUE_LIQ_PX) > 1,
    'the two candidate equities are too close to tell apart, so this test proves nothing',
  );
  assertOneLiquidationPrice(payload, 'spot as equity');

  // The rest of the unified reading, which the venue's liquidation price says nothing about.
  assert.equal(payload.account.healthPct, null, 'a health ratio against money it is not measuring');
  assert.equal(payload.account.crossLeverage, null);
  assert.equal(payload.account.equityAtFivePctAdverse, null);
  assert.equal(payload.account.freeUsd, 878.338901);
});
