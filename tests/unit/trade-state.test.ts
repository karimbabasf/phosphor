// The trading surface's numbers, tested against the afternoons that matter.
//
// Two of these tests exist because of things the venue actually does rather than because of
// anything the code does. A unified account reports its account value as 0.0 while holding real
// money, and a cross position reports no liquidation price at all. Both arrive as ordinary JSON
// and both turn into a confident wrong number on a risk panel unless something refuses them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTradePayload, buildTradeRead } from '../../src/trade/state.ts';
import type { AssetMeta } from '../../src/trade/state.ts';
import type { PlanRow } from '../../src/trade/plans.ts';
import type {
  AccountSnapshot,
  MarketCtx,
  RawFill,
  RawOrder,
  RawPosition,
  TradeFeed,
} from '../../src/trade/feed-ws.ts';
import { createTradeView } from '../../src/trade/view.ts';

const NOW = 1_786_492_800_000;
const MINUTE = 60_000;

function close(actual: number | null, expected: number, what: string): void {
  assert.ok(actual !== null, `${what} is null, expected ${expected}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: got ${actual}, expected ${expected}`);
}

function position(over: Partial<RawPosition> = {}): RawPosition {
  return {
    coin: 'BTC',
    szi: 2,
    entryPx: 100,
    positionValueUsd: 220,
    unrealisedUsd: 20,
    liqPx: 80,
    leverage: 3,
    leverageType: 'cross',
    marginUsedUsd: 40,
    fundingPaidUsd: 0,
    ...over,
  };
}

function snapshot(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    atMs: NOW - 500,
    equityUsd: 1000,
    marginUsedUsd: 40,
    maintenanceUsd: 100,
    withdrawableUsd: 900,
    freeUsd: 960,
    // The default fixture is an account the feed has already settled. The case where it has
    // not is its own test, because it is the one that used to render a funded account as empty.
    accountKnown: true,
    unified: false,
    // The two raw books, unreinterpreted. On this plain perp fixture the perp value is the
    // equity and there is no spot side at all, which is what a funded perps account looks like.
    perpValueUsd: 1000,
    spotUsdcUsd: null,
    spotUsdcHoldUsd: null,
    positions: [position()],
    ...over,
  };
}

function ctx(over: Partial<MarketCtx> = {}): MarketCtx {
  return {
    coin: 'BTC',
    markPx: 110,
    oraclePx: 110.1,
    midPx: 110.05,
    fundingRateHourly: 0.0000125,
    openInterestUsd: 1_000_000,
    volume24hUsd: 5_000_000,
    premiumPct: 0.01,
    ...over,
  };
}

function order(over: Partial<RawOrder> = {}): RawOrder {
  return {
    oid: 1,
    cloid: null,
    coin: 'BTC',
    side: 'sell',
    limitPx: 90,
    triggerPx: null,
    sizeCoin: 2,
    isTrigger: false,
    reduceOnly: false,
    tif: 'Gtc',
    atMs: NOW - 1000,
    orderType: 'Limit',
    ...over,
  };
}

function fill(over: Partial<RawFill> = {}): RawFill {
  return {
    tid: 't1',
    coin: 'BTC',
    side: 'buy',
    px: 100,
    sizeCoin: 2,
    feeUsd: 0.2,
    closedPnlUsd: null,
    atMs: NOW - 1000,
    liquidation: false,
    ...over,
  };
}

function plan(over: Partial<PlanRow> = {}): PlanRow {
  return {
    id: 'pl_1',
    symbol: 'BTC',
    side: 'long',
    sizeUsd: 1000,
    leverage: 5,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    target: 130,
    expiresAt: new Date(NOW + 60 * MINUTE).toISOString(),
    status: 'open',
    hash: 'h',
    cloids: { entry: '0xentry', stop: '0xstop', target: '0xtarget' },
    gen: 1,
    risk: { marginUsd: 200, maxLossUsd: 100.9, stopSlipUsd: 100, entryRef: 100, liquidationPx: 82, notionalUsd: 1000, amountUsd: 200 },
    createdAt: new Date(NOW - 10 * MINUTE).toISOString(),
    updatedAt: new Date(NOW - 10 * MINUTE).toISOString(),
    ...over,
  };
}

function feed(p: {
  account?: AccountSnapshot | null;
  orders?: RawOrder[];
  fills?: RawFill[];
  markets?: Record<string, MarketCtx>;
  connected?: boolean;
  lastMessageMs?: number | null;
  lastError?: string | null;
}): TradeFeed {
  const markets = p.markets === undefined ? { BTC: ctx() } : p.markets;
  return {
    watch() {},
    account: () => (p.account === undefined ? snapshot() : p.account),
    orders: () => (p.orders === undefined ? [] : p.orders),
    fills: () => (p.fills === undefined ? [] : p.fills),
    market: (coin: string) => (coin in markets ? markets[coin] : null),
    status: () => ({
      connected: p.connected === undefined ? true : p.connected,
      since: new Date(NOW - MINUTE).toISOString(),
      lastMessageMs: p.lastMessageMs === undefined ? NOW - 800 : p.lastMessageMs,
      reconnects: 0,
      lastError: p.lastError === undefined ? null : p.lastError,
    }),
    onUpdate() {},
    stop() {},
  };
}

function meta(): Map<string, AssetMeta> {
  return new Map([['BTC', { assetId: 0, szDecimals: 5, maxLeverage: 40 }]]);
}

function build(p: {
  account?: AccountSnapshot | null;
  orders?: RawOrder[];
  fills?: RawFill[];
  markets?: Record<string, MarketCtx>;
  connected?: boolean;
  lastMessageMs?: number | null;
  plans?: PlanRow[];
  atr?: number | null;
  symbol?: string;
  meta?: Map<string, AssetMeta>;
}) {
  const view = createTradeView(p.symbol === undefined ? 'BTC' : p.symbol, () => NOW).state();
  return buildTradePayload({
    view,
    feed: feed(p),
    plans: p.plans === undefined ? [] : p.plans,
    meta: p.meta === undefined ? meta() : p.meta,
    atrFor: () => (p.atr === undefined ? 15 : p.atr),
    products: ['BTC', 'ETH', 'SOL'],
    nowMs: NOW,
    address: '0x1111111111111111111111111111111111111111',
  });
}

// ---------- the unified account ----------

test('a unified account reporting zero equity reports unknown, never zero', () => {
  // The incident. clearinghouseState answers accountValue 0.0 on a unified account that is
  // holding real money, and a screen that prints that zero tells the human they have nothing
  // while they are carrying a leveraged position.
  const p = build({ account: snapshot({ unified: true, equityUsd: 0, withdrawableUsd: 0 }) });
  assert.equal(p.account.equityUsd, null);
  assert.notEqual(p.account.equityUsd, 0);
  assert.equal(p.account.withdrawableUsd, null);
  assert.notEqual(p.account.withdrawableUsd, 0);
});

test('a unified account never reports a health or a cross leverage, even with equity showing', () => {
  // With positions open accountValue is not zero, but it equals totalRawUsd + totalNtlPos with
  // totalRawUsd negative: position equity, not the account's money. A ratio against it is wrong
  // rather than missing, and the human acts on a health bar.
  const p = build({ account: snapshot({ unified: true, equityUsd: 220, withdrawableUsd: 0 }) });
  assert.equal(p.account.equityUsd, 220, 'the reported figure still passes through');
  assert.equal(p.account.healthPct, null);
  assert.equal(p.account.crossLeverage, null);
  assert.equal(p.account.equityAtFivePctAdverse, null, 'a stress test on a wrong equity is worse than none');
});

test('a plain account computes the two ratios normally', () => {
  const p = build({ account: snapshot({ equityUsd: 1000, maintenanceUsd: 100 }) });
  close(p.account.healthPct, 0.9, 'healthPct');
  close(p.account.crossLeverage, 0.22, 'crossLeverage');
});

// ---------- every derived number's null path ----------

test('no snapshot means every account number is unknown, not empty', () => {
  const p = build({ account: null });
  assert.deepEqual(p.account, {
    equityUsd: null,
    marginUsedUsd: null,
    freeUsd: null,
    maintenanceUsd: null,
    withdrawableUsd: null,
    crossLeverage: null,
    healthPct: null,
    unified: false,
    accountKnown: false,
    netNotionalUsd: null,
    grossNotionalUsd: null,
    equityAtFivePctAdverse: null,
    // Zero, not null: no plan is placed, which is an answer.
    atRiskUsd: 0,
    maxLossUsd: 0,
  });
  assert.deepEqual(p.positions, []);
});

test('health is unknown when maintenance is unknown, and leverage is unknown at zero equity', () => {
  assert.equal(build({ account: snapshot({ maintenanceUsd: null }) }).account.healthPct, null);
  assert.equal(build({ account: snapshot({ equityUsd: null }) }).account.healthPct, null);
  const zero = build({ account: snapshot({ equityUsd: 0 }) }).account;
  assert.equal(zero.healthPct, null, 'dividing by a zero equity is undefined, not perfect health');
  assert.equal(zero.crossLeverage, null);
});

test('health is clamped into 0..1 rather than going negative', () => {
  // Maintenance above equity means the account is already past the point the venue acts on. The
  // bar reads empty; it does not read minus forty percent.
  const p = build({ account: snapshot({ equityUsd: 100, maintenanceUsd: 140 }) });
  assert.equal(p.account.healthPct, 0);
});

test('a cross position with no liquidation price reports no distance in any of the three units', () => {
  // Confirmed live: liquidationPx comes back null on a cross position. This is the most likely
  // real null on the whole payload, so all three go dark together. Two showing a number while the
  // third is blank would read as a glitch instead of as the truth.
  const p = build({ account: snapshot({ positions: [position({ liqPx: null })] }) });
  const [pos] = p.positions;
  assert.equal(pos.liqDistancePct, null);
  assert.equal(pos.liqDistanceUsd, null);
  assert.equal(pos.liqDistanceAtr, null);
  assert.equal(pos.liqPx, null);
  assert.equal(pos.liqReachable, null, 'no price published is unknown, not "cannot be liquidated"');
});

test('a wall more than a whole mark away cannot be reached, so it is not a distance', () => {
  // Measured live, and the numbers are the venue's own: 0.01 SOL sold at 74.914 in a unified
  // account whose spot USDC backs the perp side, so Hyperliquid published liquidationPx
  // 84636.7119047619 against a mark of 87.738. Nothing here is corrupt. 887 dollars of collateral
  // behind 88 cents of notional really does put the wall 963 times the mark away.
  //
  // Rendered as a price and a percent it read as a broken panel: liquidation 84636, 96365% away.
  // A long in the same state has a natural tell, because its wall comes out negative and no one
  // mistakes that for a price. A short's runs off to positive infinity through numbers that all
  // look like prices, and that asymmetry is the whole bug.
  const p = build({
    markets: { BTC: ctx({ markPx: 87.738 }) },
    account: snapshot({
      positions: [
        position({
          szi: -0.01,
          entryPx: 74.914,
          positionValueUsd: 0.87738,
          unrealisedUsd: -0.12824,
          marginUsedUsd: 0.087738,
          liqPx: 84636.7119047619,
        }),
      ],
    }),
  });
  const [pos] = p.positions;
  assert.equal(pos.liqReachable, false);
  assert.equal(pos.liqDistancePct, null, '96365 percent is arithmetic, not a distance to act on');
  assert.equal(pos.liqDistanceUsd, null);
  assert.equal(pos.liqDistanceAtr, null);
  // The venue's own number is a fact about the account and survives untouched. Deleting it would
  // leave the panel unable to tell "over collateralised" from "the venue published nothing".
  close(pos.liqPx, 84636.7119047619, 'liqPx is still whatever the venue said');
});

test('a long whose wall sits at or below zero cannot be reached either', () => {
  // The mirror of the short above, and the case Hyperliquid states by publishing a negative
  // price. The rule has to catch both sides from one test or it is really two rules.
  const p = build({ account: snapshot({ positions: [position({ liqPx: -2116.4 })] }) });
  const [pos] = p.positions;
  assert.equal(pos.liqReachable, false);
  assert.equal(pos.liqDistancePct, null);
});

test('the liquidation distance is reported in percent, dollars and ATR together', () => {
  const p = build({ atr: 15 });
  const [pos] = p.positions;
  // Mark 110, liquidation 80: a 30 point gap on 2 coins. A 27 percent move is the ordinary case
  // and the unreachable rule must not sweep it up.
  assert.equal(pos.liqReachable, true);
  close(pos.liqDistancePct, (30 / 110) * 100, 'liqDistancePct');
  close(pos.liqDistanceUsd, 60, 'liqDistanceUsd is the loss from HERE, anchored on mark');
  close(pos.liqDistanceAtr, 2, 'liqDistanceAtr');
});

test('an unknown or zero ATR leaves the ATR distance unknown and the other two intact', () => {
  for (const bad of [null, 0]) {
    const p = build({ atr: bad });
    const [pos] = p.positions;
    assert.equal(pos.liqDistanceAtr, null, `atr ${String(bad)}`);
    assert.notEqual(pos.liqDistancePct, null);
    assert.notEqual(pos.liqDistanceUsd, null);
  }
});

test('return on equity is unknown when no margin is posted', () => {
  const p = build({ account: snapshot({ positions: [position({ marginUsedUsd: 0 })] }) });
  assert.equal(p.positions[0].roePct, null, 'a return on nothing is undefined, not zero');
  close(build({}).positions[0].roePct, 50, 'roePct');
});

test('a position with no market context falls back to the mark the venue implied', () => {
  // positionValue is size times mark, so the venue told us the mark whether or not the context
  // subscription has arrived.
  const p = build({ markets: {} });
  close(p.positions[0].markPx, 110, 'implied mark');
  assert.deepEqual(p.markets, [], 'no context is no market row, rather than a row of nulls');
});

// ---------- profit, split three ways ----------

test('profit is split into price and funding, and the venue number is the price leg', () => {
  const p = build({ account: snapshot({ positions: [position({ fundingPaidUsd: 3.5 })] }) });
  const [pos] = p.positions;
  close(pos.pnlPriceUsd, 20, 'price leg');
  close(pos.pnlFundingUsd, -3.5, 'funding paid is a cost, so it is signed negative');
  close(pos.pnlNetUsd, 16.5, 'net');
  assert.equal(pos.unrealisedUsd, 20, "the venue's own number is left exactly as reported");
});

test('the price leg is signed by direction, so a short profits when price falls', () => {
  const p = build({
    account: snapshot({ positions: [position({ szi: -2, positionValueUsd: 180 })] }),
    markets: { BTC: ctx({ markPx: 90 }) },
  });
  const [pos] = p.positions;
  assert.equal(pos.side, 'short');
  close(pos.pnlPriceUsd, 20, 'short price leg');
});

// ---------- portfolio exposure ----------

test('exposure is reported net and gross, with the five percent sentence behind it', () => {
  const p = build({
    account: snapshot({
      equityUsd: 1000,
      positions: [position(), position({ coin: 'SOL', szi: -4, positionValueUsd: 100, entryPx: 25 })],
    }),
    markets: { BTC: ctx(), SOL: ctx({ coin: 'SOL', markPx: 25 }) },
  });
  close(p.account.netNotionalUsd, 120, 'net: 220 long against 100 short');
  close(p.account.grossNotionalUsd, 320, 'gross');
  close(p.account.equityAtFivePctAdverse, 1000 - 6, 'five percent of the net book');
});

// ---------- order roles ----------

test('a reduce-only trigger below the mark on a long is a stop, above it is a target', () => {
  const p = build({
    orders: [
      order({ oid: 1, reduceOnly: true, isTrigger: true, triggerPx: 90, limitPx: 81 }),
      order({ oid: 2, reduceOnly: true, isTrigger: true, triggerPx: 130, limitPx: 117 }),
    ],
  });
  assert.equal(p.orders[0].role, 'stop');
  assert.equal(p.orders[1].role, 'target');
  assert.equal(p.orders[0].kind, 'trigger');
});

test('a reduce-only trigger above the mark on a short is a stop, below it is a target', () => {
  const p = build({
    account: snapshot({ positions: [position({ szi: -2, positionValueUsd: 220 })] }),
    orders: [
      order({ oid: 1, reduceOnly: true, isTrigger: true, triggerPx: 130 }),
      order({ oid: 2, reduceOnly: true, isTrigger: true, triggerPx: 90 }),
    ],
  });
  assert.equal(p.orders[0].role, 'stop');
  assert.equal(p.orders[1].role, 'target');
});

test('the role is read off the trigger price and never off the limit price', () => {
  // On a trigger order limitPx is a slippage bound, roughly ten percent past the trigger. Here it
  // lands the other side of the mark from the trigger, so reading the role off it would call this
  // target a stop.
  const p = build({
    orders: [order({ oid: 1, reduceOnly: true, isTrigger: true, triggerPx: 115, limitPx: 103.5 })],
  });
  assert.equal(p.orders[0].role, 'target');
  assert.equal(p.orders[0].px, 103.5, 'the bound is still reported, it just does not classify');
  assert.equal(p.orders[0].triggerPx, 115);
});

test('a reduce-only order that is not a trigger is a reduce, and anything not reduce-only is an entry', () => {
  const p = build({
    orders: [
      order({ oid: 1, reduceOnly: true, isTrigger: false, limitPx: 120 }),
      order({ oid: 2, reduceOnly: false, isTrigger: false, limitPx: 95 }),
    ],
  });
  assert.equal(p.orders[0].role, 'reduce');
  assert.equal(p.orders[1].role, 'entry');
});

test('a trigger with no position under it is an entry, not a stop', () => {
  // Nothing to protect. This is how a program gets into a trade on a break.
  const p = build({
    orders: [order({ oid: 1, coin: 'ETH', reduceOnly: true, isTrigger: true, triggerPx: 4000 })],
    markets: { BTC: ctx(), ETH: ctx({ coin: 'ETH', markPx: 3900 }) },
  });
  assert.equal(p.orders[0].role, 'entry');
});

test('an order notional uses the price that decides it, and is unknown when there is none', () => {
  const p = build({
    orders: [
      order({ oid: 1, isTrigger: true, triggerPx: 90, limitPx: 81, sizeCoin: 2 }),
      order({ oid: 2, isTrigger: true, triggerPx: null, limitPx: null, sizeCoin: 2 }),
    ],
  });
  close(p.orders[0].notionalUsd, 180, 'trigger notional is off the trigger line');
  assert.equal(p.orders[1].notionalUsd, null);
});

// ---------- plans ----------

test('plans pass through whole, and the account sums what the placed and open ones put at stake', () => {
  const p = build({
    plans: [
      plan({ id: 'pl_open', status: 'open' }),
      plan({ id: 'pl_placed', status: 'placed', risk: { marginUsd: 50, maxLossUsd: 20, stopSlipUsd: 25, entryRef: 100, liquidationPx: 82, notionalUsd: 250, amountUsd: 50 } }),
      plan({ id: 'pl_wait', status: 'waiting', holds: [{ condition: 'a 15m bar closes above 120', holds: false }] }),
      plan({ id: 'pl_idea', status: 'idea' }),
      plan({ id: 'pl_done', status: 'done', endReason: 'stopped' }),
    ],
  });
  assert.equal(p.plans.length, 5);
  close(p.account.atRiskUsd, 250, 'margin of the placed and open plans');
  close(p.account.maxLossUsd, 120.9, 'max loss of the placed and open plans');
  const read = buildTradeRead(p);
  const wait = read.plans.find((r) => r.id === 'pl_wait');
  assert.deepEqual(wait?.holds, [{ condition: 'a 15m bar closes above 120', holds: false }]);
  assert.equal(read.plans.find((r) => r.id === 'pl_open')?.holds, null, 'holds is a waiting plan fact');
  assert.equal(read.plans.find((r) => r.id === 'pl_done')?.endReason, 'stopped');
  assert.match(read.account.summary, /plans have \$250\.00 at risk/);
});

test('with nothing placed the at-risk figures are zero, which is an answer and not an unknown', () => {
  const p = build({ plans: [plan({ status: 'waiting' })] });
  assert.equal(p.account.atRiskUsd, 0);
  assert.equal(p.account.maxLossUsd, 0);
  const none = build({ account: null });
  assert.equal(none.account.atRiskUsd, 0);
});

test('an order is attributed to a plan by the cloid the runner minted for it', () => {
  const p = build({
    plans: [plan()],
    orders: [order({ oid: 1, cloid: '0xstop', reduceOnly: true, isTrigger: true, triggerPx: 90 }), order({ oid: 2, cloid: '0xsomeone' }), order({ oid: 3, cloid: null })],
  });
  assert.equal(p.orders[0].planId, 'pl_1');
  assert.equal(p.orders[1].planId, null);
  assert.equal(p.orders[2].planId, null);
});

test('a fill is attributed to the one live plan that covers its coin and time, or to nobody', () => {
  const p = build({
    plans: [plan()],
    fills: [fill({ tid: 'a', atMs: NOW - 1000 }), fill({ tid: 'b', atMs: NOW - 20 * MINUTE }), fill({ tid: 'c', coin: 'ETH' })],
  });
  assert.equal(p.fills.find((f) => f.tid === 'a')?.planId, 'pl_1');
  assert.equal(p.fills.find((f) => f.tid === 'b')?.planId, null, 'before the plan was placed');
  assert.equal(p.fills.find((f) => f.tid === 'c')?.planId, null, 'another coin');
  const two = build({ plans: [plan(), plan({ id: 'pl_2' })], fills: [fill({ tid: 'a', atMs: NOW - 1000 })] });
  assert.equal(two.fills[0].planId, null, 'two live plans on one coin is ambiguous, and ambiguous is null');
});

// ---------- fills and the venue ----------

test('fills are keyed by tid, deduped, and newest first', () => {
  // A reconnect snapshot landing on top of live fills would otherwise count one trade twice
  // against a mandate's order rate.
  const p = build({
    fills: [fill({ tid: 'a', atMs: NOW - 5000 }), fill({ tid: 'b', atMs: NOW - 1000 }), fill({ tid: 'a', atMs: NOW - 5000 })],
  });
  assert.equal(p.fills.length, 2);
  assert.equal(p.fills[0].tid, 'b');
  assert.equal(p.fills[0].tSec, Math.floor((NOW - 1000) / 1000), 'seconds, so the chart can place it');
  close(p.fills[0].notionalUsd, 200, 'fill notional');
});

test('the venue block says how stale the screen is and whether to trust it', () => {
  const live = build({ lastMessageMs: NOW - 800 });
  assert.equal(live.venue.connected, true);
  assert.equal(live.venue.source, 'ws');
  assert.equal(live.venue.ageMs, 800);
  assert.equal(live.venue.latencyMs, 500, 'how old the account state being drawn is');
  assert.equal(live.venue.degraded, false);

  const quiet = build({ lastMessageMs: NOW - 30_000 });
  assert.equal(quiet.venue.degraded, true, 'a socket that has said nothing for 30s is not current');

  const down = build({ connected: false });
  assert.equal(down.venue.source, 'rest', 'state we still hold came from somewhere');
  assert.equal(down.venue.degraded, true);

  const dark = build({ connected: false, account: null });
  assert.equal(dark.venue.source, 'none');
  assert.equal(dark.venue.ageMs !== null, true);
});

test('an unknown last message is an unknown age, not a fresh feed', () => {
  const p = build({ lastMessageMs: null });
  assert.equal(p.venue.ageMs, null);
  assert.equal(p.venue.degraded, true);
});

// ---------- the agent's read ----------

test('the read answers what my situation is in one call', () => {
  const payload = build({
    plans: [plan()],
    fills: [fill({ tid: 'a', atMs: NOW - 1000 })],
  });
  const read = buildTradeRead(payload);

  assert.equal(read.symbol, 'BTC');
  assert.equal(read.positions.length, 1);
  assert.equal(read.positions[0].liqDistance.atr, 2, 'the distance arrives in all three units');
  assert.match(read.account.summary, /equity \$1000\.00/);
  assert.match(read.account.summary, /a 5% move against the book leaves/);
  assert.equal(read.fills.count, 1);
  assert.equal(read.fills.inLastMin, 1);
});
