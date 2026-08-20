// The trading surface's numbers, tested against the afternoons that matter.
//
// Two of these tests exist because of things the venue actually does rather than because of
// anything the code does. A unified account reports its account value as 0.0 while holding real
// money, and a cross position reports no liquidation price at all. Both arrive as ordinary JSON
// and both turn into a confident wrong number on a risk panel unless something refuses them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTradePayload,
  buildTradeRead,
  mandateWallPrice,
} from '../../src/trade/state.ts';
import type { AssetMeta, MandateStatus } from '../../src/trade/state.ts';
import type {
  AccountSnapshot,
  MarketCtx,
  RawFill,
  RawOrder,
  RawPosition,
  TradeFeed,
} from '../../src/trade/feed-ws.ts';
import { createTradeView } from '../../src/trade/view.ts';
import type { Mandate } from '../../src/strategy/envelope.ts';
import type { Program } from '../../src/strategy/grammar.ts';
import { programHash } from '../../src/strategy/grammar.ts';

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

const PROGRAM: Program = {
  symbol: 'BTC',
  rules: [
    {
      id: 'r1',
      when: { op: 'price_below', ref: { kind: 'price', value: 95 } },
      then: [
        { do: 'open', side: 'long', sizeUsd: 1000, leverage: 3, entry: { type: 'market', maxSlippageBps: 20 } },
      ],
    },
  ],
};

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: 'md_1',
    programHash: programHash(PROGRAM),
    symbol: 'BTC',
    maxNotionalUsd: 5000,
    maxLeverage: 5,
    maxOrdersPerMin: 4,
    maxLossUsd: 250,
    expiresAt: new Date(NOW + 60 * MINUTE).toISOString(),
    allowedActions: ['open', 'close', 'set_stop', 'cancel'],
    ...over,
  };
}

function armed(over: Partial<MandateStatus> = {}): MandateStatus {
  return {
    mandate: mandate(),
    program: PROGRAM,
    armed: true,
    running: true,
    since: new Date(NOW - 10 * MINUTE).toISOString(),
    realisedUsd: 0,
    lastRule: null,
    haltedReason: null,
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
  mandates?: MandateStatus[];
  atr?: number | null;
  symbol?: string;
}) {
  const view = createTradeView(p.symbol === undefined ? 'BTC' : p.symbol, () => NOW).state();
  return buildTradePayload({
    view,
    feed: feed(p),
    mandates: p.mandates === undefined ? [] : p.mandates,
    meta: meta(),
    atrFor: () => (p.atr === undefined ? 15 : p.atr),
    products: ['BTC', 'ETH', 'SOL'],
    nowMs: NOW,
    network: 'testnet',
    address: '0x1111111111111111111111111111111111111111',
  });
}

// ---------- the mandate wall ----------

test('the wall sits below entry for a long and above it for a short', () => {
  // $50 of allowance spread over 2 coins is a $25 move, so a long stands down at 75 and a short
  // at 125. This is the line no other trading interface can draw, because in no other interface
  // does an approved maximum loss exist.
  close(
    mandateWallPrice({ side: 'long', entryPx: 100, sizeCoin: 2, maxLossUsd: 50, realisedLossUsd: 0 }),
    75,
    'long wall',
  );
  close(
    mandateWallPrice({ side: 'short', entryPx: 100, sizeCoin: 2, maxLossUsd: 50, realisedLossUsd: 0 }),
    125,
    'short wall',
  );
});

test('a loss already taken pulls the wall in and a gain already taken pushes it out', () => {
  // checkEnvelope halts on -(realised + unrealised) >= maxLoss, so it nets a realised gain
  // against the cap. The wall has to move the same way or it is a line that stops nothing.
  close(
    mandateWallPrice({ side: 'long', entryPx: 100, sizeCoin: 2, maxLossUsd: 50, realisedLossUsd: 20 }),
    85,
    'wall after a $20 realised loss',
  );
  close(
    mandateWallPrice({ side: 'long', entryPx: 100, sizeCoin: 2, maxLossUsd: 50, realisedLossUsd: -50 }),
    50,
    'wall after a $50 realised gain',
  );
});

test('there is no wall while flat, because there is no position for a price to hurt', () => {
  assert.equal(
    mandateWallPrice({ side: 'long', entryPx: 100, sizeCoin: 0, maxLossUsd: 50, realisedLossUsd: 0 }),
    null,
  );
});

test('there is no wall once the allowance is spent, at any price', () => {
  // Exactly spent counts as spent: the mandate is at its stop-out now, and a line drawn anywhere
  // would say there is room left.
  assert.equal(
    mandateWallPrice({ side: 'long', entryPx: 100, sizeCoin: 2, maxLossUsd: 50, realisedLossUsd: 50 }),
    null,
  );
  assert.equal(
    mandateWallPrice({ side: 'short', entryPx: 100, sizeCoin: 2, maxLossUsd: 50, realisedLossUsd: 60 }),
    null,
  );
});

test('a non-finite input produces no wall rather than a NaN on the chart', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      mandateWallPrice({ side: 'long', entryPx: bad, sizeCoin: 2, maxLossUsd: 50, realisedLossUsd: 0 }),
      null,
    );
    assert.equal(
      mandateWallPrice({ side: 'long', entryPx: 100, sizeCoin: bad, maxLossUsd: 50, realisedLossUsd: 0 }),
      null,
    );
    assert.equal(
      mandateWallPrice({ side: 'long', entryPx: 100, sizeCoin: 2, maxLossUsd: bad, realisedLossUsd: 0 }),
      null,
    );
    assert.equal(
      mandateWallPrice({ side: 'long', entryPx: 100, sizeCoin: 2, maxLossUsd: 50, realisedLossUsd: bad }),
      null,
    );
  }
});

test('a long wall at or below zero is not a stop-out, it is the asset going to nothing', () => {
  assert.equal(
    mandateWallPrice({ side: 'long', entryPx: 10, sizeCoin: 1, maxLossUsd: 50, realisedLossUsd: 0 }),
    null,
  );
});

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
});

test('the liquidation distance is reported in percent, dollars and ATR together', () => {
  const p = build({ atr: 15 });
  const [pos] = p.positions;
  // Mark 110, liquidation 80: a 30 point gap on 2 coins.
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

// ---------- mandate rows ----------

test('the order rate counts the fills of the last sixty seconds and nothing older', () => {
  const p = build({
    mandates: [armed()],
    fills: [
      fill({ tid: 'a', atMs: NOW - 1_000 }),
      fill({ tid: 'b', atMs: NOW - 59_000 }),
      fill({ tid: 'c', atMs: NOW - 60_000 }),
      fill({ tid: 'd', atMs: NOW - 90_000 }),
    ],
  });
  assert.equal(p.mandates[0].used.ordersLastMin, 2, 'the window is exclusive at exactly sixty seconds');
});

test('the order rate ignores other coins and anything that happened before the mandate armed', () => {
  const p = build({
    mandates: [armed()],
    markets: { BTC: ctx(), ETH: ctx({ coin: 'ETH', markPx: 3900 }) },
    fills: [
      fill({ tid: 'a', atMs: NOW - 1_000 }),
      fill({ tid: 'b', coin: 'ETH', atMs: NOW - 1_000 }),
      fill({ tid: 'c', atMs: NOW - 20 * MINUTE }),
    ],
  });
  assert.equal(p.mandates[0].used.ordersLastMin, 1);
  assert.equal(p.mandates[0].id, 'md_1');
});

test('only a loss spends the loss allowance', () => {
  const winning = build({ mandates: [armed({ realisedUsd: 50 })] });
  assert.equal(winning.mandates[0].used.lossUsd, 0, 'a winning bot has spent none of it');

  const losing = build({ mandates: [armed({ realisedUsd: -100 })] });
  // Realised -100 against the position's +20 unrealised nets to -80.
  close(losing.mandates[0].used.lossUsd, 80, 'lossUsd');
});

test('a mandate row carries the program in English and the wall it would stand down at', () => {
  const p = build({ mandates: [armed({ realisedUsd: -100 })] });
  const row = p.mandates[0];
  assert.ok(row.english.length > 0);
  assert.match(row.english[0], /open long/, 'the same renderer the approval screen used');
  // Entry 100, size 2, $250 allowance with $100 already lost: $150 over 2 coins is a 75 move.
  close(row.wallPx, 25, 'wallPx');
  close(row.used.msToExpiry, 60 * MINUTE, 'msToExpiry');
  close(row.used.notionalUsd, 220, 'notional in use');
});

test('an expired mandate has no time left rather than negative time', () => {
  const p = build({ mandates: [armed({ mandate: mandate({ expiresAt: new Date(NOW - MINUTE).toISOString() }) })] });
  assert.equal(p.mandates[0].used.msToExpiry, 0);
});

test('an expiry that will not parse is unknown, not immediate', () => {
  const p = build({ mandates: [armed({ mandate: mandate({ expiresAt: 'whenever' }) })] });
  assert.equal(p.mandates[0].used.msToExpiry, null);
});

test('a flat mandate has no wall yet', () => {
  const p = build({ account: snapshot({ positions: [] }), mandates: [armed()] });
  assert.equal(p.mandates[0].wallPx, null);
  assert.equal(p.mandates[0].used.notionalUsd, 0);
});

// ---------- the arm receipt ----------

test('the receipt previews the position, the margin, the free collateral and the liquidation', () => {
  const p = build({ account: snapshot({ positions: [], freeUsd: 2000 }), mandates: [armed()] });
  const projected = p.mandates[0].projected;
  assert.ok(projected !== null);
  // The envelope allows $5000 and $2000 free at 5x carries $10000, so the envelope is the wall.
  close(projected.maxPositionUsd, 5000, 'maxPositionUsd');
  close(projected.marginRequiredUsd, 1000, 'marginRequiredUsd');
  close(projected.freeAfterUsd, 1000, 'freeAfterUsd');
  // Maintenance is half the initial margin at 5x, so the move that takes it is one tenth.
  close(projected.liqPxAtMax, 99, 'liqPxAtMax on a long, from a mark of 110');
});

test('the receipt is capped by the collateral, not only by the envelope', () => {
  // An envelope allowing $5000 on an account with $200 free is not a $5000 position, and a
  // receipt that says it is would be the wrong number on an approval screen.
  const p = build({ account: snapshot({ positions: [], freeUsd: 200 }), mandates: [armed()] });
  const projected = p.mandates[0].projected;
  assert.ok(projected !== null);
  close(projected.maxPositionUsd, 1000, 'capped at free times max leverage');
  close(projected.freeAfterUsd, 0, 'all of it posted');
});

test('the whole receipt is null when an input is unknown, never a zero', () => {
  // A unified account has no knowable free collateral here, which is exactly the case where a
  // confident projection would be worst.
  const noFree = build({
    account: snapshot({ positions: [], freeUsd: null }),
    mandates: [armed()],
  });
  assert.equal(noFree.mandates[0].projected, null);

  // No market context means no mark to open against.
  const noMark = build({ account: snapshot({ positions: [] }), markets: {}, mandates: [armed()] });
  assert.equal(noMark.mandates[0].projected, null);
});

test('a program that can go either way projects no liquidation, and still projects the rest', () => {
  const both: Program = {
    symbol: 'BTC',
    rules: [
      {
        id: 'r1',
        when: { op: 'price_below', ref: { kind: 'price', value: 95 } },
        then: [{ do: 'open', side: 'long', sizeUsd: 100, leverage: 3, entry: { type: 'market', maxSlippageBps: 20 } }],
      },
      {
        id: 'r2',
        when: { op: 'price_above', ref: { kind: 'price', value: 130 } },
        then: [{ do: 'open', side: 'short', sizeUsd: 100, leverage: 3, entry: { type: 'market', maxSlippageBps: 20 } }],
      },
    ],
  };
  const p = build({ account: snapshot({ positions: [], freeUsd: 2000 }), mandates: [armed({ program: both })] });
  const projected = p.mandates[0].projected;
  assert.ok(projected !== null);
  assert.equal(projected.liqPxAtMax, null);
  close(projected.maxPositionUsd, 5000, 'the size is still knowable');
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
    mandates: [armed({ realisedUsd: -200 })],
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

test('the read names the bound that stops the bot first', () => {
  const payload = build({
    mandates: [armed({ realisedUsd: -200 })],
    fills: [fill({ tid: 'a', atMs: NOW - 1000 })],
  });
  const read = buildTradeRead(payload);
  const m = read.mandates[0];
  // Loss is 180 of 250 against notional 220 of 5000, one order of four, and ten minutes of
  // seventy elapsed.
  assert.equal(m.tightest, 'loss');
  assert.equal(m.bounds[0].bound, 'loss');
  close(m.bounds[0].spent, 180 / 250, 'loss spent');
  assert.equal(m.bounds.length, 4);
});

test('the read never prints an unknown as a number', () => {
  const payload = build({ account: snapshot({ unified: true, equityUsd: 0, withdrawableUsd: 0, freeUsd: null }) });
  const read = buildTradeRead(payload);
  assert.match(read.account.summary, /equity unknown/);
  assert.match(read.account.summary, /health unknown/);
  assert.match(read.account.summary, /cross unknown/);
  assert.doesNotMatch(read.account.summary, /\$0\.00/);
  assert.match(read.account.summary, /unified account/, 'and it says why');
  assert.equal(read.account.equityUsd, null);
});

test('the read carries a handful of fills rather than the tape', () => {
  const many: RawFill[] = [];
  for (let i = 0; i < 40; i++) many.push(fill({ tid: `t${i}`, atMs: NOW - i * 1000 }));
  const read = buildTradeRead(build({ fills: many }));
  assert.equal(read.fills.count, 40);
  assert.equal(read.fills.recent.length, 5);
  assert.equal(read.fills.recent[0].tid, 't0', 'newest first');
});

test('the read carries the feed health, so a stale number is never read as current', () => {
  const read = buildTradeRead(build({ connected: false }));
  assert.equal(read.venue.degraded, true);
  assert.match(read.account.summary, /feed degraded/);
});

// The bug this caught on the first live boot, kept as the case it was.
//
// clearinghouseState and activeAssetData arrive on separate websocket messages. In the window
// between them the account looked like a plain perp account worth exactly nothing, and the
// payload said so: equityUsd 0, unified false. The account held 889 USDC. That is the precise
// failure this surface exists to avoid, because an obviously wrong number gets questioned and a
// plausible one gets acted on, and a flat account worth zero is entirely plausible.
test('an account the feed has not settled yet reports nothing, not zero', () => {
  const p = build({
    account: snapshot({
      accountKnown: false,
      equityUsd: null,
      freeUsd: null,
      withdrawableUsd: null,
      positions: [],
    }),
  });

  assert.equal(p.account.accountKnown, false, 'the window has to be able to say it is waiting');
  assert.equal(p.account.equityUsd, null, 'never 0: that is the claim that there is nothing there');
  assert.equal(p.account.freeUsd, null);
  assert.equal(p.account.healthPct, null);
  assert.equal(p.account.crossLeverage, null);
  assert.equal(p.account.equityAtFivePctAdverse, null);
});
