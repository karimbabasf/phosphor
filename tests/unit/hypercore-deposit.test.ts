// The Hyperliquid funding rail, which is almost entirely refusal.
//
// The rail it replaces was tested the same way and for the same reason: its failure mode was
// never an exception, it was silent permanent loss. That specific danger is gone with Bridge2
// (there is no address to get wrong any more), and three new ones arrived with 1Click:
//
//   - the fee is close to flat, so a small deposit pays most of itself away while every
//     percentage-shaped check in the app reads normal;
//   - the deposit address is minted by a remote API per quote, so it is never on an allowlist
//     and has to be shape-checked at the moment it comes back;
//   - the collateral may land on the spot book instead of the perp one, where it is real,
//     visible, and not usable as margin.
//
// Every test below is one of those three, or the plumbing that makes them checkable.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';

import {
  HYPERCORE_COUNTERPARTY,
  HYPERCORE_USDC_ASSET_ID,
  MAX_FEE_PCT,
  MIN_DEPOSIT_USDC,
  hypercoreDepositRail,
  minCreditedFor,
} from '../../src/rails/hypercore-deposit.ts';
import type { HypercoreDepositDeps, HypercoreEvmPort, HypercoreNearPort } from '../../src/rails/hypercore-deposit.ts';
import type { HlDepositDraft } from '../../src/types.ts';
import type { OneClickClient, OneClickQuoteParams, TokensFile } from '../../src/intents.ts';

const SELF = '0x2222222222222222222222222222222222222222' as Address;
const STRANGER = '0x3333333333333333333333333333333333333333';
const DEPOSIT_ADDR = '0x4444444444444444444444444444444444444444';
const KEYS = '/nowhere/keys.json';

const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

// Only what resolveAsset reads. Deliberately minimal: a fixture that mirrored data/tokens.json
// would drift from it silently.
const TOKENS = {
  eth: { USDC: { tokenId: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 } },
  base: { USDC: { tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
  arb: { USDC: { tokenId: ARB_USDC, decimals: 6 } },
  sol: {},
  near: { USDC: { tokenId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 } },
} as unknown as TokensFile;

function draft(over: Partial<HlDepositDraft> = {}): HlDepositDraft {
  return {
    kind: 'hl_deposit',
    chain: 'arb',
    symbol: 'USDC',
    tokenId: ARB_USDC,
    amount: 50,
    amountUsd: 50,
    minCredited: 49,
    from: SELF,
    hlAccount: SELF,
    counterparty: HYPERCORE_COUNTERPARTY,
    ...over,
  };
}

type ClientOverrides = {
  // The live shape, from a real dry quote on 2026-08-20: 50 in, 49.6347 out.
  amountOut?: string;
  amountIn?: string;
  depositAddress?: unknown;
  depositMemo?: string;
  statuses?: string[];
  quoteThrows?: string;
  assetMissing?: boolean;
  assetDecimals?: number;
};

function fakeClient(over: ClientOverrides = {}): { client: OneClickClient; quotes: OneClickQuoteParams[]; submitted: string[] } {
  const quotes: OneClickQuoteParams[] = [];
  const submitted: string[] = [];
  let poll = 0;
  const statuses = over.statuses ?? ['SUCCESS'];

  const client: OneClickClient = {
    async tokens() {
      if (over.assetMissing) return [];
      return [
        {
          assetId: HYPERCORE_USDC_ASSET_ID,
          decimals: over.assetDecimals ?? 6,
          blockchain: 'hypercore',
          symbol: 'USDC',
          contractAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
        },
        // The origin side resolves against this list too, the same way the swap rail does.
        { assetId: 'nep141:arb-usdc.omft.near', decimals: 6, blockchain: 'arb', symbol: 'USDC', contractAddress: ARB_USDC },
        { assetId: 'nep141:near-usdc.omft.near', decimals: 6, blockchain: 'near', symbol: 'USDC', contractAddress: NEAR_USDC },
      ] as never;
    },
    async quote(params) {
      quotes.push(params);
      if (over.quoteThrows) throw new Error(over.quoteThrows);
      return {
        quote: {
          amountInFormatted: over.amountIn ?? '50',
          amountOutFormatted: over.amountOut ?? '49.6347',
          timeEstimate: 35,
          depositAddress: params.dry ? undefined : (over.depositAddress ?? DEPOSIT_ADDR),
          ...(over.depositMemo !== undefined ? { depositMemo: over.depositMemo } : {}),
        },
      } as never;
    },
    async submitDeposit(address, hash) {
      submitted.push(`${address}:${hash}`);
      return { ok: true, detail: 'submitted' };
    },
    async status() {
      const name = statuses[Math.min(poll, statuses.length - 1)] ?? 'SUCCESS';
      poll += 1;
      return { found: true, status: name, reported: name, originTxHashes: [], destinationTxHashes: ['0xdest'] } as never;
    },
  };
  return { client, quotes, submitted };
}

type PortOverrides = { signer?: string; sendOk?: boolean; sendError?: string; storageRegistered?: boolean };

function fakeEvm(over: PortOverrides = {}): { port: HypercoreEvmPort; sends: Array<{ to: string; chain: string }> } {
  const sends: Array<{ to: string; chain: string }> = [];
  return {
    sends,
    port: {
      signerAddress: () => (over.signer ?? SELF) as Address,
      async send(params) {
        sends.push({ to: String(params.to), chain: String(params.chain) });
        return over.sendOk === false
          ? { ok: false, error: over.sendError ?? 'reverted' }
          : { ok: true, hash: '0xorigin', explorer: 'https://arbiscan.io/tx/0xorigin' };
      },
    },
  };
}

function fakeNear(over: PortOverrides = {}): HypercoreNearPort {
  return {
    accountId: () => 'phosphor.near',
    storageRegistered: async () => over.storageRegistered ?? true,
    send: async () => ({ ok: true, hash: 'nearhash' }) as never,
  };
}

// Hyperliquid /info, driven by what each test wants the account to look like before and after.
type AccountShape = { perp: number; spot: number };

function fakeInfo(shapes: AccountShape[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let readPair = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { type: string };
    calls.push(body.type);
    // Each accountState() makes exactly two reads; advance the shape after the spot one.
    const shape = shapes[Math.min(readPair, shapes.length - 1)] ?? { perp: 0, spot: 0 };
    if (body.type === 'clearinghouseState') {
      return new Response(
        JSON.stringify({ marginSummary: { accountValue: String(shape.perp), totalMarginUsed: '0' }, withdrawable: String(shape.perp), assetPositions: [] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    readPair += 1;
    return new Response(JSON.stringify({ balances: [{ coin: 'USDC', token: 0, total: String(shape.spot), hold: '0' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function rail(
  ports: PortOverrides = {},
  clientOver: ClientOverrides = {},
  shapes: AccountShape[] = [{ perp: 0, spot: 0 }],
  over: Partial<HypercoreDepositDeps> = {},
) {
  const { client, quotes, submitted } = fakeClient(clientOver);
  const evm = fakeEvm(ports);
  const info = fakeInfo(shapes);
  const r = hypercoreDepositRail({
    network: 'mainnet',
    keysPath: KEYS,
    tokens: TOKENS,
    client,
    evm: evm.port,
    near: fakeNear(),
    fetchImpl: info.fetchImpl,
    pollIntervalMs: 1,
    pollTimeoutMs: 10,
    sleep: async () => {},
    ...over,
  });
  return { rail: r, quotes, submitted, sends: evm.sends, infoCalls: info.calls };
}

// ---------- the network guard, which is the worst outcome this rail can produce ----------

test('a testnet trading network is refused, because the money would land on mainnet and work', async () => {
  // The failure this prevents does not revert and does not look wrong: 1Click has no testnet,
  // the pinned asset is mainnet HyperCore, and one EVM address names an account on both
  // networks. So the deposit would succeed, into the wrong book, while the account the app is
  // trading stayed empty.
  const h = rail({}, {}, [{ perp: 0, spot: 0 }], { network: 'testnet' });
  const out = await h.rail.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /NEAR Intents, which has no testnet/);
  assert.match(out.error ?? '', /real money into the mainnet trading account/);
  assert.match(out.error ?? '', /faucet/);
  assert.equal(h.quotes.length, 0, 'nothing was priced');
});

test('the network guard runs before every other refusal, so it cannot be masked by one', async () => {
  // A draft that is wrong in several ways at once must still name this reason, because it is
  // the one that costs money.
  const h = rail({}, {}, [{ perp: 0, spot: 0 }], { network: 'testnet' });
  const out = await h.rail.simulate(draft({ chain: 'sol', amount: 1, counterparty: 'nonsense' }));
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /has no testnet/);
});

test('execute refuses on testnet too, not only simulate', async () => {
  const h = rail({}, {}, [{ perp: 0, spot: 0 }], { network: 'testnet' });
  const out = await h.rail.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /has no testnet/);
  assert.equal(h.sends.length, 0, 'nothing was signed');
});

// ---------- the shape refusals, none of which touch the network ----------

test('an origin chain this app cannot sign on is refused before any quote', async () => {
  const h = rail();
  const out = await h.rail.simulate(draft({ chain: 'sol' }));
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /cannot sign on sol/);
  assert.match(out.error ?? '', /1Click reaches more chains than that/);
  assert.equal(h.quotes.length, 0, 'nothing was priced');
});

test('a counterparty that is not the routing venue is refused', async () => {
  const h = rail();
  const out = await h.rail.simulate(draft({ counterparty: 'oneclick:evil.example' }));
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /is not oneclick:1click\.chaindefuser\.com/);
  assert.equal(h.quotes.length, 0);
});

test('a trading account that is not an EVM address is refused, because HyperCore credits one', async () => {
  const h = rail();
  const out = await h.rail.simulate(draft({ hlAccount: 'phosphor.near' }));
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /not an EVM address/);
  assert.equal(h.quotes.length, 0);
});

test('below the floor the refusal names the flat fee, not a venue minimum', async () => {
  const h = rail();
  const out = await h.rail.simulate(draft({ amount: MIN_DEPOSIT_USDC - 1 }));
  assert.equal(out.ok, false);
  // The old rail refused here because the venue would not credit it. This one refuses because
  // the routing cost is nearly fixed, and the two reasons lead a reader somewhere different.
  assert.match(out.error ?? '', /close to flat/);
  assert.match(out.error ?? '', /pays most of itself away/);
  assert.equal(h.quotes.length, 0);
});

test('funding from a wallet this app does not hold the key for is refused', async () => {
  const h = rail({ signer: STRANGER });
  const out = await h.rail.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /this app signs with/);
  assert.equal(h.quotes.length, 0);
});

test('a NEAR testnet account is refused here, not by a 500 from the API', async () => {
  // 1Click is mainnet only. Without this check the quote is well formed, leaves, and comes back
  // as a bare "Internal server error", which tells a reader nothing about the actual cause.
  const h = rail();
  // A generic name, not the one in config.local.json: scripts/sweep.ts treats any configured
  // address in tracked content as a leak, and it is right to, even for a testnet account id.
  const out = await h.rail.simulate(draft({ chain: 'near', symbol: 'USDC', from: 'example.testnet' }));
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /NEAR testnet account and 1Click is mainnet only/);
  assert.match(out.error ?? '', /an error that does not say so/);
  assert.equal(h.quotes.length, 0, 'the API was never asked');
});

// ---------- the quote checks ----------

test('simulate prices with dry:true and never asks for a deposit address', async () => {
  const h = rail();
  const out = await h.rail.simulate(draft());
  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(h.quotes.length, 1);
  assert.equal(h.quotes[0].dry, true, 'a simulation must never mint a deposit address');
  assert.equal(h.quotes[0].destinationAsset, HYPERCORE_USDC_ASSET_ID);
  assert.equal(h.quotes[0].recipient, SELF, 'the recipient is the trading account');
  assert.equal(h.quotes[0].recipientType, 'DESTINATION_CHAIN');
  assert.equal(h.sends.length, 0, 'nothing was signed');
});

test('the summary states the effective rate, because the flat fee is invisible as a rate', async () => {
  const h = rail();
  const out = await h.rail.simulate(draft());
  assert.equal(out.ok, true, out.error ?? '');
  // 50 in, 49.6347 out: 0.3653 of cost, 0.73 percent.
  assert.match(out.summary, /0\.3653 USDC, 0\.73 percent of the deposit/);
  assert.match(out.summary, /about 35s/);
  assert.match(out.summary, /one way/i, 'the summary says the money cannot come back down this rail');
});

test('a quote whose cost exceeds the ceiling is refused, and the refusal says to deposit more', async () => {
  // 10 in, 9.3 out is 7 percent: the shape of a small deposit against a nearly fixed fee.
  const h = rail({}, { amountIn: '10', amountOut: '9.3' });
  const out = await h.rail.simulate(draft({ amount: 10, minCredited: 9 }));
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', new RegExp(`above the ${MAX_FEE_PCT} percent ceiling`));
  assert.match(out.error ?? '', /depositing more at once costs the same in dollars/);
  // The pricing is still shown: a refusal a human cannot check is a worse refusal.
  assert.match(out.summary, /7\.00 percent/);
});

test('a quote that credits less than the approved floor is refused', async () => {
  const h = rail({}, { amountOut: '48.0' });
  const out = await h.rail.simulate(draft({ minCredited: 49 }));
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /credits 48 USDC and the approved draft required at least 49/);
});

test('a quote priced against a different amount than the draft is refused', async () => {
  const h = rail({}, { amountIn: '25' });
  const out = await h.rail.simulate(draft({ amount: 50 }));
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /prices 25 in, but the draft says 50/);
});

// ---------- execute ----------

test('execute sends to the address the quote minted, submits it, and reports the credit', async () => {
  const h = rail({}, {}, [{ perp: 0, spot: 0 }, { perp: 49.6347, spot: 0 }]);
  const out = await h.rail.execute(draft());

  assert.equal(out.ok, true, out.detail ?? '');
  assert.equal(h.sends.length, 1, 'exactly one transfer');
  assert.equal(h.sends[0].to, ARB_USDC, 'the transfer calls the token, not the deposit address');
  assert.equal(h.submitted.length, 1);
  assert.match(out.detail, /funded Hyperliquid mainnet with 49\.6347 USDC/);
  assert.match(out.detail, /Credited to the perp side directly/);
  assert.ok(out.txids?.includes('0xorigin'));

  // Two quotes: the re-simulation, then the live one. The re-simulation is dry.
  assert.equal(h.quotes.length, 2);
  assert.equal(h.quotes[0].dry, true);
  assert.equal(h.quotes[1].dry, false);
});

test('a quote demanding a memo is refused without sending, because a transfer cannot carry one', async () => {
  const h = rail({}, { depositMemo: 'must-include' });
  const out = await h.rail.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /deposit memo/);
  assert.match(out.detail, /Nothing was sent/);
  assert.equal(h.sends.length, 0);
});

test('a deposit address that is not an address stops execution before the transfer', async () => {
  const h = rail({}, { depositAddress: 'not-an-address' });
  await assert.rejects(() => h.rail.execute(draft()), /not an EVM address/);
  assert.equal(h.sends.length, 0);
});

test('a failed transfer says the money never left, so nobody sends it twice', async () => {
  const h = rail({ sendOk: false, sendError: 'insufficient funds' });
  const out = await h.rail.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /No funds left the wallet/);
});

test('a poll that never reaches terminal says the funds WERE sent, in capitals', async () => {
  const h = rail({}, { statuses: ['PENDING_DEPOSIT'] });
  const out = await h.rail.execute(draft());
  assert.equal(out.ok, false);
  // The transfer confirmed, so this is not a failed deposit and must not read like one.
  assert.match(out.detail, /THE FUNDS WERE SENT/);
  assert.match(out.detail, /check the deposit address before retrying/);
  assert.equal(h.sends.length, 1);
});

test('a refund is reported against the refund address rather than as a success', async () => {
  const h = rail({}, { statuses: ['REFUNDED'] });
  const out = await h.rail.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /REFUNDED/);
  assert.match(out.detail, new RegExp(`Check the refund address ${SELF}`));
});

// ---------- the settle step, which is what makes the rail's promise true ----------

test('collateral that lands on the spot book is moved to perp, and the detail says so', async () => {
  // Before: empty. After: 49.6347 sat down on the SPOT side, where it is not margin.
  const h = rail({}, {}, [{ perp: 0, spot: 0 }, { perp: 0, spot: 49.6347 }]);
  const out = await h.rail.execute(draft());

  assert.equal(out.ok, true, out.detail ?? '');
  // usdClassTransfer is real and will refuse against these fakes; what is asserted here is
  // that the rail NOTICED and said which side the money is on, which is the part a human acts
  // on. Either sentence names the spot side.
  assert.match(out.detail, /spot side/i);
  assert.doesNotMatch(out.detail, /Credited to the perp side directly/);
});

test('a credit the venue has not shown yet is not reported as a loss', async () => {
  // 1Click said SUCCESS and neither book has moved: overwhelmingly a timing gap.
  const h = rail({}, {}, [{ perp: 0, spot: 0 }, { perp: 0, spot: 0 }]);
  const out = await h.rail.execute(draft());
  assert.equal(out.ok, true, out.detail ?? '');
  assert.match(out.detail, /has not shown the credit yet/);
  assert.match(out.detail, /rather than sending again/);
});

// ---------- the pin ----------

test('a quote refuses when the pin is gone, so the check cannot be forgotten', async () => {
  // The pin used to be verified only by a method nothing called. It is now checked on the path
  // that fetches the token list anyway, so a quote is impossible without it having run.
  const h = rail({}, { assetMissing: true });
  const out = await h.rail.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /no longer in the 1Click token list/);
  assert.equal(h.quotes.length, 0, 'nothing was priced against an unverified destination');
});

test('a hostile token list can stop this rail and cannot redirect it', async () => {
  // The failure mode that matters: an attacker who could edit the remote list would want the
  // money to go somewhere else. Refusing is the only thing they can cause.
  const h = rail({}, { assetMissing: true });
  const out = await h.rail.execute(draft());
  assert.equal(out.ok, false);
  assert.equal(h.sends.length, 0);
});

test('the pinned asset id is checked against the live list and never replaced from it', async () => {
  const gone = rail({}, { assetMissing: true });
  await assert.rejects(() => gone.rail.assertAssetLive(), /no longer in the 1Click token list/);
  await assert.rejects(() => gone.rail.assertAssetLive(), /will not take a replacement id from the API/);

  const shifted = rail({}, { assetDecimals: 8 });
  await assert.rejects(() => shifted.rail.assertAssetLive(), /decimals changed/);

  const fine = rail();
  await fine.rail.assertAssetLive();
});

// ---------- budgets ----------

test('a draft that cannot price itself fails every budget instead of passing them all', () => {
  const h = rail();
  assert.equal(h.rail.valueUsd(draft({ amount: 50, amountUsd: 50 })), 50);
  // The pessimistic read: the larger of the two, so an under-reported value cannot slip under
  // a cap.
  assert.equal(h.rail.valueUsd(draft({ amount: 90, amountUsd: 50 })), 90);
  assert.equal(h.rail.valueUsd(draft({ amount: Number.NaN, amountUsd: Number.NaN })), Infinity);
});

test('the funding venue and the swap venue are one allowlist entry', () => {
  assert.equal(HYPERCORE_COUNTERPARTY, 'oneclick:1click.chaindefuser.com');
});

// ---------- the loss floor, which has to be shaped like the fee ----------

test('the floor clears the real fee at every size the rail accepts', () => {
  // The measured curve: fee is about 0.315 flat plus 10 bp. These are the live numbers from
  // 2026-08-20, and the floor has to sit UNDER each delivered amount or it refuses an honest
  // quote and blames the wrong thing.
  const live: Array<[number, number]> = [
    [5, 4.6797],
    [10, 9.6747],
    [50, 49.6347],
    [100, 99.5847],
  ];
  for (const [sent, delivered] of live) {
    assert.ok(
      minCreditedFor(sent) <= delivered,
      `floor ${minCreditedFor(sent).toFixed(4)} for ${sent} is above the ${delivered} the venue actually delivers`,
    );
  }
});

test('the old proportional floor is what this replaced, and it would have refused these', () => {
  // 200 bps of the amount, the Intents rule. Kept here as the regression: on 10 USDC it demands
  // 9.80 credited and the venue delivers 9.67, so every deposit under about 17 was refused with
  // a message about the floor rather than about the flat fee.
  const proportional = (amount: number): number => amount * 0.98;
  assert.ok(proportional(10) > 9.6747, 'the old rule refused a 10 USDC deposit');
  assert.ok(minCreditedFor(10) <= 9.6747, 'the new one does not');
});

test('the floor still caps the loss rather than waving everything through', () => {
  // It must not be so loose that a genuinely bad quote passes. At 50 the venue delivers 49.63
  // and the floor is 49.55, so anything more than about 9 cents worse than measured is refused.
  assert.ok(minCreditedFor(50) > 49, 'a floor of 49 would allow a full percent of unexplained loss');
  // At 1000 the floor is 997.65, so the most unexplained loss it will accept is 2.35, or
  // 23.5 bp. The flat term stops mattering at size and the 20 bp term is what binds.
  assert.ok(minCreditedFor(1000) > 997, 'the bp term must not dominate at size');
  assert.ok(1000 - minCreditedFor(1000) < 3, 'and the cap in dollars stays small');
});

test('a nonsense amount floors at zero rather than at NaN', () => {
  assert.equal(minCreditedFor(Number.NaN), 0);
  assert.equal(minCreditedFor(-5), 0);
});
