import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';

import type { HlWithdrawDraft } from '../../src/types.ts';
import type { OneClickClient, OneClickQuote, OneClickQuoteParams, OneClickStatus } from '../../src/intents.ts';
import type { HlSignPort, HlTypedData, HlUserSignedDeps } from '../../src/rails/hl-user-signed.ts';
import { HL_USDC_TOKEN } from '../../src/rails/hl-user-signed.ts';
import { ONECLICK_COUNTERPARTY } from '../../src/rails/oneclick.ts';
import {
  HL_WITHDRAW_COUNTERPARTY,
  HL_WITHDRAW_FEE_BPS,
  HL_WITHDRAW_FLAT_USDC,
  HL_WITHDRAW_SLIPPAGE_BPS,
  HYPERCORE_ORIGIN_ASSET_ID,
  INTENTS_USDC_ASSET_ID,
  MIN_HL_WITHDRAW_USDC,
  hypercoreWithdrawRail,
  minReceivedForHlWithdraw,
} from '../../src/rails/hypercore-withdraw.ts';
import type { HypercoreWithdrawDeps } from '../../src/rails/hypercore-withdraw.ts';

// The only way collateral leaves Hyperliquid. One spotSend, signed with the master key, to an
// address 1Click mints for the quote the rail just checked; the money lands in the app's own
// intents balance and nowhere else. The tests pin the refusals (every one before the key), the
// echo binding, the fee sentence with the venue's activation charge inside it, and the proof
// the rail reads back afterwards.

const SELF = '0x2222222222222222222222222222222222222222' as Address;
const ACCOUNT = SELF.toLowerCase();
const STRANGER = '0x3333333333333333333333333333333333333333';
const DEPOSIT = '0xaf4FDa3876a32301839734891C337dA23184d954'; // what 1Click mints: fresh, checksummed
const KEYS = '/nowhere/keys.json';

const AMOUNT = 8;
const AMOUNT_BASE8 = 800_000_000n; // HyperCore USDC is 8 decimals
const NOW = 1786600000000;

function draft(over: Partial<HlWithdrawDraft> = {}): HlWithdrawDraft {
  return {
    kind: 'hl_withdraw',
    symbol: 'USDC',
    amount: AMOUNT,
    amountUsd: AMOUNT,
    minReceived: minReceivedForHlWithdraw(AMOUNT),
    from: SELF,
    to: ACCOUNT,
    counterparty: HL_WITHDRAW_COUNTERPARTY,
    ...over,
  };
}

// The live numbers from 2026-09-11 for 8 USDC of HyperCore USDC into the intents balance:
// 7.780248 out, 35 seconds.
function quoteOf(over: Partial<OneClickQuote> = {}): OneClickQuote {
  return {
    depositAddress: DEPOSIT,
    amountIn: AMOUNT_BASE8.toString(),
    amountInFormatted: '8.0',
    amountInUsd: '8.0',
    minAmountIn: AMOUNT_BASE8.toString(),
    amountOut: '7780248',
    amountOutFormatted: '7.780248',
    amountOutUsd: '7.780248',
    minAmountOut: '7772468',
    timeEstimate: 35,
    refundFee: '31530000',
    withdrawFee: '0',
    ...over,
  };
}

function echoOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: HL_WITHDRAW_SLIPPAGE_BPS,
    originAsset: HYPERCORE_ORIGIN_ASSET_ID,
    destinationAsset: INTENTS_USDC_ASSET_ID,
    amount: AMOUNT_BASE8.toString(),
    depositType: 'ORIGIN_CHAIN',
    refundTo: SELF,
    refundType: 'ORIGIN_CHAIN',
    recipient: ACCOUNT,
    recipientType: 'INTENTS',
    ...over,
  };
}

type ClientOverrides = {
  quote?: Partial<OneClickQuote>;
  echo?: Record<string, unknown> | null;
  status?: OneClickStatus['status'];
  statusThrows?: boolean;
  originMissing?: boolean;
  originDecimals?: number;
  destinationMissing?: boolean;
};

function fakeClient(over: ClientOverrides = {}): { client: OneClickClient; quotes: OneClickQuoteParams[]; submitted: string[] } {
  const quotes: OneClickQuoteParams[] = [];
  const submitted: string[] = [];
  const client: OneClickClient = {
    async tokens() {
      return [
        ...(over.originMissing ? [] : [{ assetId: HYPERCORE_ORIGIN_ASSET_ID, decimals: over.originDecimals ?? 8, blockchain: 'hypercore', symbol: 'USDC' }]),
        ...(over.destinationMissing ? [] : [{ assetId: INTENTS_USDC_ASSET_ID, decimals: 6, blockchain: 'near', symbol: 'USDC' }]),
      ];
    },
    async quote(params) {
      quotes.push(params);
      const quote = quoteOf(over.quote);
      const raw: Record<string, unknown> = { quote };
      if (over.echo !== null) raw['quoteRequest'] = echoOf({ dry: params.dry, ...(over.echo ?? {}) });
      return { quote, raw };
    },
    async submitDeposit(depositAddress) {
      submitted.push(depositAddress);
      return { ok: true, detail: '' };
    },
    async status() {
      if (over.statusThrows) throw new Error('status endpoint down');
      const status = over.status ?? 'SUCCESS';
      return { found: true, status, reported: status, originTxHashes: [], destinationTxHashes: ['0xdest'] } as OneClickStatus;
    },
  };
  return { client, quotes, submitted };
}

// Hyperliquid /info and /exchange. `shapes` is the account before and after; the ledger
// answers with the send the rail made, keyed on its nonce, once the exchange has seen it.
type Shape = { available: number; spot: number; perp: number; positions?: number; marginUsed?: number; unified?: boolean };

type HlOverrides = { role?: string; exchange?: unknown; exchangeThrows?: boolean; ledgerMissing?: boolean };

function fakeHl(shapes: Shape[], over: HlOverrides = {}): { hl: HlUserSignedDeps; signed: HlTypedData[]; exchange: any[]; infoTypes: string[] } {
  const signed: HlTypedData[] = [];
  const exchange: any[] = [];
  const infoTypes: string[] = [];
  let reads = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/exchange')) {
      if (over.exchangeThrows) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      exchange.push(body);
      return json(over.exchange ?? { status: 'ok', response: { type: 'default' } });
    }
    infoTypes.push(body.type);
    const shape = shapes[Math.min(reads, shapes.length - 1)] ?? { available: 0, spot: 0, perp: 0 };
    const unified = shape.unified ?? true;
    if (body.type === 'clearinghouseState') {
      return json({
        marginSummary: { accountValue: String(shape.perp), totalMarginUsed: String(shape.marginUsed ?? 0) },
        withdrawable: unified ? '0.0' : String(shape.perp),
        assetPositions: new Array(shape.positions ?? 0).fill({ position: {} }),
      });
    }
    if (body.type === 'userAbstraction') return json(unified ? 'unifiedAccount' : 'standard');
    if (body.type === 'userRole') return json({ role: over.role ?? 'missing' });
    if (body.type === 'userNonFundingLedgerUpdates') {
      if (over.ledgerMissing || exchange.length === 0) return json([]);
      const sent = exchange[exchange.length - 1];
      return json([
        {
          time: sent.action.time,
          hash: '0xledgerhash',
          delta: { type: 'spotTransfer', token: 'USDC', amount: sent.action.amount, user: ACCOUNT, destination: sent.action.destination, fee: '1.0', nonce: sent.action.time, feeToken: 'USDC' },
        },
      ]);
    }
    reads += 1;
    return json({
      balances: [{ coin: 'USDC', token: 0, total: String(shape.spot), hold: '0' }],
      ...(unified ? { tokenToAvailableAfterMaintenance: [[0, String(shape.available)]] } : {}),
    });
  };
  const sign: HlSignPort = {
    address: () => SELF,
    async signTypedData(_keysPath, typed) {
      signed.push(typed);
      return { r: `0x${'1'.repeat(64)}`, s: `0x${'2'.repeat(64)}`, v: 27 };
    },
  };
  return { hl: { keysPath: KEYS, fetchImpl, sign, now: () => NOW }, signed, exchange, infoTypes };
}

function rail(
  clientOver: ClientOverrides = {},
  shapes: Shape[] = [{ available: 20, spot: 20, perp: 0 }],
  hlOver: HlOverrides = {},
  balances: bigint[] = [0n, 7_780_248n],
  over: Partial<HypercoreWithdrawDeps> = {},
) {
  const { client, quotes, submitted } = fakeClient(clientOver);
  const hl = fakeHl(shapes, hlOver);
  let balanceReads = 0;
  const r = hypercoreWithdrawRail({
    keysPath: KEYS,
    client,
    hl: hl.hl,
    intentsBalance: async () => balances[Math.min(balanceReads++, balances.length - 1)] ?? null,
    now: () => NOW,
    sleep: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 3,
    ...over,
  });
  return { rail: r, quotes, submitted, signed: hl.signed, exchange: hl.exchange, infoTypes: hl.infoTypes };
}

// ---------- the shape refusals, before any quote ----------

test('a counterparty that is not the routing venue is refused', async () => {
  const { rail: r, quotes } = rail();
  const out = await r.simulate(draft({ counterparty: 'intents.near' }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /counterparty/);
  assert.equal(quotes.length, 0);
});

test('a destination that is not our own intents account is refused, whatever the caller says', async () => {
  const { rail: r, quotes } = rail();
  const out = await r.simulate(draft({ to: STRANGER }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /own intents account/);
  assert.equal(quotes.length, 0);
});

test('a source account that is not the signer is refused', async () => {
  const { rail: r, quotes } = rail();
  const out = await r.simulate(draft({ from: STRANGER, to: STRANGER.toLowerCase() }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /configured key/);
  assert.equal(quotes.length, 0);
});

test('below the floor the refusal names the flat cost, activation fee included', async () => {
  const { rail: r, quotes } = rail();
  const out = await r.simulate(draft({ amount: 3, amountUsd: 3, minReceived: minReceivedForHlWithdraw(3) }));
  assert.equal(out.ok, false);
  assert.match(out.summary, new RegExp(`below the ${MIN_HL_WITHDRAW_USDC} USDC floor`));
  assert.match(out.summary, /1 USDC activation/);
  assert.equal(quotes.length, 0);
});

// ---------- the account, read before any quote ----------

test('an open position refuses the withdrawal before anything is priced', async () => {
  const { rail: r, quotes } = rail({}, [{ available: 20, spot: 20, perp: 0, positions: 1 }]);
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /1 open position/);
  assert.equal(quotes.length, 0);
});

test('margin in use refuses the withdrawal even with no position row', async () => {
  const { rail: r, quotes } = rail({}, [{ available: 20, spot: 20, perp: 0, marginUsed: 3.5 }]);
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /3\.5 USDC of margin in use/);
  assert.equal(quotes.length, 0);
});

test('a balance short of amount plus the activation fee is refused and says both numbers', async () => {
  const { rail: r, quotes } = rail({}, [{ available: 8.5, spot: 8.5, perp: 0 }]);
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /8\.5 USDC/);
  assert.match(out.summary, /needs 9 USDC/);
  assert.equal(quotes.length, 0);
});

test('a standard account counts both books and the rail will move perp to spot itself', async () => {
  const { rail: r } = rail({}, [{ available: 0, spot: 2, perp: 20, unified: false }]);
  const out = await r.simulate(draft());
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /perp side to spot first/);
});

// ---------- the pin ----------

test('the origin asset is the documented two-way HyperCore USDC at 8 decimals, and the pin is checked live', async () => {
  assert.equal(HYPERCORE_ORIGIN_ASSET_ID, '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054');
  assert.equal(INTENTS_USDC_ASSET_ID, 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
  const gone = await rail({ originMissing: true }).rail.simulate(draft());
  assert.equal(gone.ok, false);
  assert.match(gone.summary, /no longer in the 1Click token list/);
  const wrong = await rail({ originDecimals: 6 }).rail.simulate(draft());
  assert.equal(wrong.ok, false);
  assert.match(wrong.summary, /decimals changed/);
  const noDest = await rail({ destinationMissing: true }).rail.simulate(draft());
  assert.equal(noDest.ok, false);
  assert.match(noDest.summary, /does not list/);
});

// ---------- simulate ----------

test('simulate prices with dry:true from HyperCore to the intents balance, refunding to the venue account', async () => {
  const { rail: r, quotes } = rail();
  const out = await r.simulate(draft());
  assert.equal(out.ok, true, out.summary);
  assert.equal(quotes.length, 1);
  const q = quotes[0];
  assert.equal(q.dry, true);
  assert.equal(q.originAsset, HYPERCORE_ORIGIN_ASSET_ID);
  assert.equal(q.destinationAsset, INTENTS_USDC_ASSET_ID);
  assert.equal(q.amount, AMOUNT_BASE8.toString());
  assert.equal(q.recipient, ACCOUNT);
  assert.equal(q.recipientType, 'INTENTS');
  assert.equal(q.refundTo, SELF);
  assert.equal(q.refundType, 'ORIGIN_CHAIN');
  assert.equal(q.depositType, 'ORIGIN_CHAIN');
  assert.equal(q.slippageToleranceBps, HL_WITHDRAW_SLIPPAGE_BPS);
});

test('the summary states the full cost as a rate, with the activation fee inside it', async () => {
  const { rail: r } = rail();
  const out = await r.simulate(draft());
  assert.equal(out.ok, true, out.summary);
  // 8 in, 7.780248 credited, plus 1 USDC the venue charges the sender: 1.2198 total, 15.25 percent.
  assert.match(out.summary, /1\.2198 USDC/);
  assert.match(out.summary, /15\.25 percent/);
  assert.match(out.summary, /7\.780248 USDC/);
  assert.match(out.summary, /always a click/);
});

test('a quote that credits less than the approved floor is refused', async () => {
  const { rail: r } = rail({ quote: { amountOutFormatted: '7.0', amountOut: '7000000', minAmountOut: '6990000' } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /required at least/);
});

test('a quote whose guaranteed floor is below minReceived is refused even when its expected output clears it', async () => {
  const { rail: r } = rail({ quote: { minAmountOut: '7000000' } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /guarantees only 7 USDC/);
});

test('a quote priced against a different amount than the draft is refused', async () => {
  const { rail: r } = rail({ quote: { amountInFormatted: '9.0' } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /prices 9\.0 in, but the draft says 8/);
});

test('a quote that echoes a recipient other than our intents account is refused', async () => {
  const { rail: r } = rail({ echo: { recipient: STRANGER.toLowerCase() } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /0x3333/);
});

test('a quote that would pay out on a chain instead of into the intents balance is refused', async () => {
  const { rail: r } = rail({ echo: { recipientType: 'DESTINATION_CHAIN' } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /INTENTS/);
});

test('a quote with no echo at all is refused rather than trusted', async () => {
  const { rail: r } = rail({ echo: null });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /nothing tying/);
});

// ---------- execute ----------

test('execute signs one spotSend to the minted address, watches 1Click, and proves both sides', async () => {
  const { rail: r, quotes, signed, exchange } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);

  const live = quotes.filter((q) => !q.dry);
  assert.equal(live.length, 1, 'one live quote mints one deposit address');

  assert.equal(signed.length, 1);
  const message = signed[0].message as Record<string, unknown>;
  assert.equal(signed[0].primaryType, 'HyperliquidTransaction:SpotSend');
  assert.equal(message.destination, DEPOSIT.toLowerCase());
  assert.equal(message.token, HL_USDC_TOKEN);
  assert.equal(message.amount, '8');
  assert.equal(message.hyperliquidChain, 'Mainnet');

  assert.equal(exchange.length, 1);
  assert.equal(exchange[0].action.type, 'spotSend');
  assert.equal(exchange[0].nonce, NOW);

  assert.match(out.detail, /sent 8 USDC/);
  assert.match(out.detail, /7\.780248 USDC/);
  assert.match(out.detail, /nonce 1786600000000/);
  assert.match(out.detail, /ledger 0xledgerhash/);
  assert.match(out.detail, /intents balance rose by 7\.780248/);
  assert.match(out.detail, /collateral fell by 9/);
  assert.deepEqual(out.txids, ['0xledgerhash', '0xdest']);
});

test('the echo is checked again at execute, before anything is signed', async () => {
  const { rail: r, signed } = rail({ echo: { recipient: STRANGER.toLowerCase() } });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /Nothing was sent/);
  assert.equal(signed.length, 0);
});

test('a live quote without a usable deposit address stops execution before the key is touched', async () => {
  const noAddr = await rail({ quote: { depositAddress: 'not-an-address' } });
  const out = await noAddr.rail.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /not an EVM address/);
  assert.equal(noAddr.signed.length, 0);

  const memo = await rail({ quote: { depositMemo: 'needs-a-memo' } });
  const withMemo = await memo.rail.execute(draft());
  assert.equal(withMemo.ok, false);
  assert.match(withMemo.detail, /memo/);
  assert.equal(memo.signed.length, 0);
});

test('a send the venue refuses is reported with nothing moved', async () => {
  const { rail: r } = rail({}, undefined, { exchange: { status: 'err', response: 'Insufficient balance for token transfer' } });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /Insufficient balance/);
  assert.match(out.detail, /Nothing was sent/);
});

test('a send whose reply is lost is reported as ambiguous with its nonce, never as nothing happened', async () => {
  const { rail: r } = rail({}, undefined, { exchangeThrows: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /MAY HAVE BEEN ACCEPTED/);
  assert.match(out.detail, /1786600000000/);
  assert.match(out.detail, new RegExp(DEPOSIT.toLowerCase()));
  assert.doesNotMatch(out.detail, /Nothing was sent/);
});

test('a refund after the send is reported against the venue account, with the send kept as evidence', async () => {
  const { rail: r } = rail({ status: 'REFUNDED' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /REFUNDED/);
  assert.match(out.detail, new RegExp(`refund .*${SELF}`));
  assert.ok(out.txids?.includes('0xledgerhash'));
});

test('a poll that never reaches terminal says THE SEND HAPPENED, in capitals, and names the address', async () => {
  const { rail: r } = rail({ statusThrows: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /THE SEND HAPPENED/);
  assert.match(out.detail, new RegExp(DEPOSIT.toLowerCase()));
});

test('a standard account moves perp collateral to spot before the send', async () => {
  // Reads, in order: the plan, the transfer's own balance check, the send's, the proof.
  const { rail: r, exchange } = rail({}, [
    { available: 0, spot: 2, perp: 20, unified: false },
    { available: 0, spot: 2, perp: 20, unified: false },
    { available: 0, spot: 9, perp: 13, unified: false },
    { available: 0, spot: 0, perp: 13, unified: false },
  ]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.equal(exchange.length, 2);
  assert.equal(exchange[0].action.type, 'usdClassTransfer');
  assert.equal(exchange[0].action.toPerp, false);
  assert.equal(exchange[0].action.amount, '7');
  assert.equal(exchange[1].action.type, 'spotSend');
});

test('a success the intents balance has not shown yet is reported as pending proof, not as a loss', async () => {
  const { rail: r } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], {}, [0n, 0n]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /has not shown the credit yet/);
});

// ---------- the floor, against the measured fee ----------

test('the floor clears the real 1Click fee at every size the rail accepts', () => {
  // Live dry quotes 2026-09-11, no partner key. The activation fee is not in these numbers:
  // the venue takes it from the sender on top, so the floor is about what lands inside intents.
  const live: Array<[number, number]> = [
    [5, 4.787684],
    [8, 7.780248],
    [50, 49.672082],
    [1000, 997.217342],
  ];
  for (const [sent, delivered] of live) {
    assert.ok(minReceivedForHlWithdraw(sent) <= delivered, `floor ${minReceivedForHlWithdraw(sent)} for ${sent} is above ${delivered}`);
  }
  assert.ok(minReceivedForHlWithdraw(1000) > 995);
  assert.equal(HL_WITHDRAW_FLAT_USDC, 0.25);
  assert.equal(HL_WITHDRAW_FEE_BPS, 40);
  assert.equal(minReceivedForHlWithdraw(Number.NaN), 0);
});

test('the withdraw venue is the 1Click entry the swap rail already has on the allowlist', () => {
  assert.equal(HL_WITHDRAW_COUNTERPARTY, ONECLICK_COUNTERPARTY);
});

test('a draft that cannot price itself fails every budget instead of passing them all', () => {
  const { rail: r } = rail();
  assert.equal(r.valueUsd(draft({ amountUsd: Number.NaN })), Infinity);
  assert.equal(r.valueUsd(draft({ amountUsd: 8, amount: 12 })), 12);
});
