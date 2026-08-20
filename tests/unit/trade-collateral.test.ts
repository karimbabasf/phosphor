// The collateral block on the trading surface: what a mandate can spend, where it is, and
// what it costs to send more.
//
// Three things are asserted here and each one is a way the screen could lie.
//
//   The floor and the ceiling are restated in src/trade/funding.ts so that a pure payload
//   builder does not pull the rail's whole dependency graph in behind it. A restatement that
//   nothing checks is a fork, so it is checked here against the rail's own constants.
//
//   The cost model is the reason this page quotes two sizes rather than one. It is fitted to
//   live 1Click dry quotes and it has to keep reproducing them, or the screen is quoting a
//   number the rail will not honour.
//
//   `funded` is three-valued. An account that has not answered and an account with nothing in
//   it are different sentences, and only one of them names a next action.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_FEE_PCT, MIN_DEPOSIT_USDC, hypercoreDepositRail } from '../../src/rails/hypercore-deposit.ts';
import { FUNDING_FAUCET, FUNDING_SHAPE, feePctAt, fundingBlock } from '../../src/trade/funding.ts';
import { buildTradePayload } from '../../src/trade/state.ts';
import type { AssetMeta } from '../../src/trade/state.ts';
import type { AccountSnapshot, TradeFeed } from '../../src/trade/feed-ws.ts';
import { createTradeView } from '../../src/trade/view.ts';

const NOW = 1_786_492_800_000;
const ADDRESS = '0x3333333333333333333333333333333333333333';
const SELF = '0x2222222222222222222222222222222222222222';

function feed(snapshot: AccountSnapshot | null): TradeFeed {
  return {
    watch: () => undefined,
    account: () => snapshot,
    orders: () => [],
    fills: () => [],
    market: () => null,
    status: () => ({ connected: true, since: null, lastMessageMs: NOW, reconnects: 0, lastError: null }),
    onUpdate: () => undefined,
    stop: () => undefined,
  };
}

function snapshot(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    atMs: NOW - 500,
    equityUsd: null,
    marginUsedUsd: null,
    maintenanceUsd: null,
    withdrawableUsd: null,
    freeUsd: null,
    unified: false,
    accountKnown: true,
    perpValueUsd: 0,
    spotUsdcUsd: 0,
    spotUsdcHoldUsd: 0,
    positions: [],
    ...over,
  };
}

function payload(snap: AccountSnapshot | null, network: 'testnet' | 'mainnet' = 'mainnet') {
  return buildTradePayload({
    view: createTradeView('BTC', () => NOW).state(),
    feed: feed(snap),
    mandates: [],
    meta: new Map<string, AssetMeta>(),
    atrFor: () => null,
    products: ['BTC'],
    nowMs: NOW,
    network,
    address: ADDRESS,
  });
}

// ---------- the restatement cannot fork ----------

test('the funding floor and ceiling match the rail that enforces them', () => {
  assert.equal(FUNDING_SHAPE.minUsd, MIN_DEPOSIT_USDC);
  assert.equal(FUNDING_SHAPE.maxFeePct, MAX_FEE_PCT);
});

// ---------- the cost model still reproduces the quotes it was fitted to ----------

// Measured against live 1Click dry quotes on 2026-08-20. The rounded figure is what the screen
// prints, so that is what is asserted: a model that drifted by a basis point would still pass a
// looser check and would still be showing the human the wrong percentage.
test('the cost model reproduces the measured dry quotes', () => {
  const at = (usd: number): string => {
    const pct = feePctAt(usd);
    assert.ok(pct !== null, `no cost for $${usd}`);
    return pct.toFixed(2);
  };
  // $6 is the size the rail refuses for cost, and it refuses it at 5.35 percent.
  assert.equal(at(6), '5.35');
  assert.equal(at(50), '0.73');
  assert.equal(at(1000), '0.13');
});

test('a size the fee cannot be charged against has no percentage rather than an infinite one', () => {
  assert.equal(feePctAt(0), null);
  assert.equal(feePctAt(-10), null);
  assert.equal(feePctAt(Number.NaN), null);
});

test('the funding block names its origins fastest first and quotes two sizes', () => {
  const block = fundingBlock('mainnet');
  assert.deepEqual(block.origins, ['arb', 'base', 'eth']);
  assert.equal(block.etaSec, 35);
  assert.equal(block.costAt.length, 2);
  assert.equal(block.costAt[0].usd, 50);
  assert.equal(block.costAt[1].usd, 1000);
  // The whole reason for two: one number would be a fact about the amount pretending to be a
  // fact about the rail.
  assert.ok(block.costAt[0].pct > block.costAt[1].pct * 4);
});

// ---------- the block itself ----------

test('the collateral block carries the trading network and the account it is about', () => {
  const p = payload(snapshot(), 'mainnet');
  assert.equal(p.collateral.network, 'mainnet');
  assert.equal(p.collateral.address, ADDRESS);
});

test('a venue that has not answered leaves funded unknown rather than false', () => {
  const p = payload(null);
  assert.equal(p.collateral.funded, null);
  assert.equal(p.collateral.perpUsd, null);
  assert.equal(p.collateral.spotUsdcUsd, null);
});

test('an account that answered with nothing on either book is not funded', () => {
  const p = payload(snapshot({ perpValueUsd: 0, spotUsdcUsd: 0 }));
  assert.equal(p.collateral.funded, false);
  assert.equal(p.collateral.perpUsd, 0);
  assert.equal(p.collateral.spotUsdcUsd, 0);
});

// The live mainnet account, read on 2026-08-20. It has never been funded and it reports two
// millionths of a dollar of spot USDC. Every figure on this surface rounds at half a cent, so
// counting that as collateral prints $0.00 on both books and hides the line that says what to
// do about an empty account. That is the state that ships broken.
test('venue dust is not collateral', () => {
  const p = payload(snapshot({ perpValueUsd: 0, spotUsdcUsd: 0.000002 }));
  assert.equal(p.collateral.funded, false);
  // The figure itself is still reported as it is. The threshold decides a sentence, not a
  // number, and rewriting the number would be the screen editing the venue.
  assert.equal(p.collateral.spotUsdcUsd, 0.000002);
});

test('a balance above the rounding threshold is collateral', () => {
  assert.equal(payload(snapshot({ perpValueUsd: 0.01, spotUsdcUsd: 0 })).collateral.funded, true);
  assert.equal(payload(snapshot({ perpValueUsd: 0, spotUsdcUsd: 0.01 })).collateral.funded, true);
});

// The account this surface is looked at on: 887.81 dollars reading on the spot side and a perp
// figure of nine cents. Whether that money is usable depends on the kind of account and the
// page says which, so the payload has to carry both figures rather than one reading of them.
test('collateral sitting on the spot book counts as funded and is reported separately', () => {
  const p = payload(snapshot({ perpValueUsd: 0.077, spotUsdcUsd: 887.81 }), 'testnet');
  assert.equal(p.collateral.funded, true);
  assert.equal(p.collateral.perpUsd, 0.077);
  assert.equal(p.collateral.spotUsdcUsd, 887.81);
});

// The perp value is the RAW clearinghouse figure and is not the unified-account reinterpretation
// the account block applies. On a unified account holding a short, equity is the spot total and
// the perp side is worth almost nothing, and the collateral block has to say the second thing.
test('the perp value is the perp book and not the account block reading of it', () => {
  const p = payload(snapshot({ unified: true, equityUsd: 887.81, perpValueUsd: 9.65, spotUsdcUsd: 887.81 }));
  assert.equal(p.collateral.perpUsd, 9.65);
  assert.notEqual(p.collateral.perpUsd, p.account.equityUsd);
});

test('the funding shape reaches the payload so the page does no arithmetic about money', () => {
  const p = payload(snapshot());
  assert.equal(p.collateral.funding.minUsd, MIN_DEPOSIT_USDC);
  assert.equal(p.collateral.funding.etaSec, 35);
  assert.ok(p.collateral.funding.costAt.length > 1);
});

// ---------- the rail is mainnet only, and the screen has to agree ----------

// The screen must not advertise a capability the rail refuses. This is not a tidiness point: on
// a testnet trading network the deposit takes REAL money, delivers it correctly to the mainnet
// account, and reports success while the account being traded stays empty. A page that told
// someone to ask their agent for funding there would be pointing at that.
test('funding is not offered on a network the rail refuses to fund', () => {
  const p = payload(snapshot(), 'testnet');
  assert.equal(p.collateral.funding.available, false);
  assert.equal(p.collateral.funding.faucet, FUNDING_FAUCET);
});

test('funding is offered on the one network the rail serves', () => {
  const p = payload(snapshot(), 'mainnet');
  assert.equal(p.collateral.funding.available, true);
  assert.equal(p.collateral.funding.faucet, null);
});

// The screen and the rail must send a person to the same place. The rail spells the faucet out
// inside a sentence rather than exporting it, so this asks the rail for that sentence and looks
// for the string the screen prints. Two places naming one destination is exactly the drift that
// makes a next action point at nothing.
test('the faucet the screen names is the faucet the rail names', async () => {
  const rail = hypercoreDepositRail({
    network: 'testnet',
    keysPath: '/nowhere/keys.json',
    tokens: {} as never,
    // The testnet check runs before anything else, so none of these are reached. They exist
    // because the factory takes them, not because this test is about them.
    client: {
      tokens: async () => [] as never,
      quote: async () => ({ quote: {} }) as never,
      status: async () => ({}) as never,
      submitDeposit: async () => undefined,
    } as never,
    evm: { signerAddress: () => SELF, send: async () => ({ ok: false, error: 'unused' }) } as never,
    near: {
      accountId: () => 'nobody.near',
      storageRegistered: async () => true,
      send: async () => ({ ok: false, error: 'unused' }),
    } as never,
  });

  const result = await rail.simulate({
    kind: 'hl_deposit',
    chain: 'arb',
    symbol: 'USDC',
    tokenId: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    amount: 50,
    amountUsd: 50,
    minCredited: 49,
    from: SELF,
    hlAccount: SELF,
    counterparty: 'unused',
  } as never);

  assert.equal(result.ok, false);
  const said = `${result.summary} ${result.error ?? ''}`;
  assert.ok(said.includes(FUNDING_FAUCET), `the rail's refusal does not name ${FUNDING_FAUCET}: ${said}`);
});
