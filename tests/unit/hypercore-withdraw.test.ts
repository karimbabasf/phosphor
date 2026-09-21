import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';

import type { HlWithdrawDraft } from '../../src/types.ts';
import type { OneClickClient, OneClickQuote, OneClickQuoteParams, OneClickStatus } from '../../src/intents.ts';
import type { HlSignPort, HlTypedData, HlUserSignedDeps } from '../../src/rails/hl-user-signed.ts';
import { HL_USDC_TOKEN } from '../../src/rails/hl-user-signed.ts';
import { ONECLICK_COUNTERPARTY } from '../../src/intents.ts';
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
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

// The only way collateral leaves Hyperliquid. One sendAsset (the transfer both account modes
// accept; spotSend is refused on a unified account), signed with the master key, to an address
// 1Click mints for the quote the rail just checked; the money lands in the app's own intents
// balance and nowhere else. The tests pin the refusals (every one before the key), the echo
// binding, the fee facts with the venue's activation charge and the app fee named, the proof
// the rail reads back afterwards, and that SUCCESS alone never confirms the row.

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
  refundedAmount?: string;
  refundReason?: string;
  settledAmountOut?: string;
  nearTxHashes?: string[];
  statusThrows?: boolean;
  originMissing?: boolean;
  originDecimals?: number;
  destinationMissing?: boolean;
  // Applied to the quote response AFTER it is signed: what a proxy between this app and the
  // API would do to it. Left out, the response arrives as signed.
  tamper?: (signed: Record<string, unknown>) => Record<string, unknown>;
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
      const unsigned: Record<string, unknown> = { quote: quoteOf(over.quote) };
      if (over.echo !== null) unsigned['quoteRequest'] = echoOf({ dry: params.dry, ...(over.echo ?? {}) });
      // Signed the way 1Click signs its answers, over the whole payload, quote included.
      const signed = signQuote(unsigned);
      const raw = over.tamper === undefined ? signed : over.tamper(signed);
      return { quote: raw['quote'] as OneClickQuote, raw };
    },
    async submitDeposit(depositAddress) {
      submitted.push(depositAddress);
      return { ok: true, detail: '' };
    },
    async status() {
      if (over.statusThrows) throw new Error('status endpoint down');
      const status = over.status ?? 'SUCCESS';
      return {
        found: true,
        status,
        reported: status,
        originTxHashes: [],
        destinationTxHashes: ['0xdest'],
        nearTxHashes: over.nearTxHashes ?? [],
        ...(over.refundedAmount !== undefined ? { refundedAmount: over.refundedAmount } : {}),
        ...(over.refundReason !== undefined ? { refundReason: over.refundReason } : {}),
        ...(over.settledAmountOut !== undefined ? { settledAmountOut: over.settledAmountOut } : {}),
      } as OneClickStatus;
    },
  };
  return { client, quotes, submitted };
}

// Hyperliquid /info and /exchange. `shapes` is the account before and after; the ledger
// answers with the send the rail made, keyed on its nonce, once the exchange has seen it.
type Shape = { available: number; spot: number; perp: number; positions?: number; marginUsed?: number; unified?: boolean };

type HlOverrides = {
  role?: string;
  exchange?: unknown;
  exchangeThrows?: boolean;
  // The first exchange call gets no reply; later ones are answered.
  exchangeThrowsOnce?: boolean;
  // Once the exchange has been posted to, this /info read answers 429 one time: the rate limit
  // or dropped socket a retry's own balance read can meet.
  infoFailsOnceAfterPost?: string;
  ledgerMissing?: boolean;
  // The ledger already shows a send under the clock nonce, whether or not the fake exchange
  // recorded one: the venue took a send whose reply was lost.
  ledgerKnowsNonce?: boolean;
  // The same, as a `send` delta that carries no nonce field at all, only its destination,
  // amount and time.
  ledgerShapeOnly?: boolean;
  ledgerShapeAmount?: string;
  refuseSend?: boolean;
};

function fakeHl(shapes: Shape[], over: HlOverrides = {}): { hl: HlUserSignedDeps; signed: HlTypedData[]; exchange: any[]; infoTypes: string[]; posts: any[] } {
  const signed: HlTypedData[] = [];
  const exchange: any[] = [];
  const posts: any[] = [];
  const infoTypes: string[] = [];
  let reads = 0;
  let infoFailed = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/exchange')) {
      posts.push(body);
      if (over.exchangeThrows || (over.exchangeThrowsOnce && posts.length === 1)) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      exchange.push(body);
      if (over.refuseSend && (body.action as { type?: string }).type === 'sendAsset') {
        return json({ status: 'err', response: 'Insufficient balance for token transfer' });
      }
      return json(over.exchange ?? { status: 'ok', response: { type: 'default' } });
    }
    infoTypes.push(body.type);
    if (over.infoFailsOnceAfterPost === body.type && posts.length > 0 && !infoFailed) {
      infoFailed = true;
      return new Response('rate limited', { status: 429 });
    }
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
      if (over.ledgerKnowsNonce) {
        return json([{ time: NOW, hash: '0xledgerhash', delta: { type: 'send', token: 'USDC', amount: '8', user: ACCOUNT, destination: DEPOSIT.toLowerCase(), fee: '1.0', nonce: NOW, feeToken: 'USDC' } }]);
      }
      if (over.ledgerShapeOnly) {
        return json([{ time: NOW + 2_000, hash: '0xshapedhash', delta: { type: 'send', token: 'USDC', amount: over.ledgerShapeAmount ?? '8', user: ACCOUNT, destination: DEPOSIT.toLowerCase(), fee: '1.0', feeToken: 'USDC' } }]);
      }
      if (over.ledgerMissing || exchange.length === 0) return json([]);
      const sent = exchange[exchange.length - 1];
      // A sendAsset shows in the venue's ledger as a `send` delta keyed on the action's nonce.
      return json([
        {
          time: sent.action.nonce,
          hash: '0xledgerhash',
          delta: { type: 'send', token: 'USDC', amount: sent.action.amount, user: ACCOUNT, destination: sent.action.destination, fee: '1.0', nonce: sent.action.nonce, feeToken: 'USDC' },
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
  return { hl: { keysPath: KEYS, fetchImpl, sign, now: () => NOW }, signed, exchange, infoTypes, posts };
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
    quoteKey: TEST_QUOTE_KEY,
    settleSchedule: { firstMs: 1, maxMs: 1, timeoutMs: 3 },
    ...over,
  });
  return { rail: r, quotes, submitted, signed: hl.signed, exchange: hl.exchange, infoTypes: hl.infoTypes, posts: hl.posts };
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

test('an amount the send could not spell at six decimals is refused before any quote', async () => {
  const { rail: r, quotes, signed } = rail();
  const out = await r.simulate(draft({ amount: 8.0000005, amountUsd: 8.0000005 }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /needs more than 6 decimals/);
  assert.equal(quotes.length, 0);
  assert.equal(signed.length, 0);
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

test('the numbers in a refusal are money, never a float with its rounding error showing', async () => {
  // Karim's window, 2026-09-20: "the withdrawal needs 8.209399000000001 USDC".
  const { rail: r } = rail({}, [{ available: 7.209399, spot: 7.209399, perp: 0 }]);
  const out = await r.simulate(draft({ amount: 7.209399, amountUsd: 7.209399, minReceived: minReceivedForHlWithdraw(7.209399) }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /needs 8\.209399 USDC/);
  assert.doesNotMatch(out.summary, /0000001/);
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

test('execute signs one sendAsset to the minted address, watches 1Click, and proves both sides', async () => {
  const { rail: r, quotes, signed, exchange } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);

  const live = quotes.filter((q) => !q.dry);
  assert.equal(live.length, 1, 'one live quote mints one deposit address');

  assert.equal(signed.length, 1);
  const message = signed[0].message as Record<string, unknown>;
  assert.equal(signed[0].primaryType, 'HyperliquidTransaction:SendAsset');
  assert.equal(message.destination, DEPOSIT.toLowerCase());
  assert.equal(message.token, HL_USDC_TOKEN);
  assert.equal(message.amount, '8');
  assert.equal(message.sourceDex, 'spot');
  assert.equal(message.destinationDex, 'spot');
  assert.equal(message.fromSubAccount, '');
  assert.equal(message.hyperliquidChain, 'Mainnet');

  assert.equal(exchange.length, 1);
  assert.equal(exchange[0].action.type, 'sendAsset');
  assert.equal(exchange[0].nonce, NOW);
  assert.equal(exchange[0].action.nonce, NOW);

  assert.match(out.detail, /sent 8 USDC/);
  assert.match(out.detail, /7\.780248 USDC/);
  assert.match(out.detail, /nonce 1786600000000/);
  assert.match(out.detail, /ledger 0xledgerhash/);
  assert.match(out.detail, /intents balance rose by 7\.780248/);
  assert.match(out.detail, /collateral fell by 9/);
  assert.deepEqual(out.txids, ['0xledgerhash', '0xdest']);
  assert.equal(out.evidence?.nonce, '1786600000000');
  assert.equal(out.evidence?.handle, DEPOSIT.toLowerCase());
});

test('a success reports the amount 1Click settled, not the quote, and keeps the NEAR settlement hash', async () => {
  const { rail: r } = rail({ settledAmountOut: '7.75', nearTxHashes: ['nearSettle'] }, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], {}, [0n, 7_750_000n]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /7\.75 USDC credited to our intents account/);
  assert.doesNotMatch(out.detail, /7\.780248/);
  assert.match(out.detail, /intents balance rose by 7\.75/);
  assert.equal(out.evidence?.settledAmountOut, '7.75');
  assert.deepEqual(out.txids, ['0xledgerhash', '0xdest', 'nearSettle']);
});

test('a success without a settled amount says the figure is quoted', async () => {
  const { rail: r } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /a quoted 7\.780248 USDC/);
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
  const { rail: r, posts } = rail({}, undefined, { exchangeThrows: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /MAY HAVE BEEN ACCEPTED/);
  assert.match(out.detail, /unconfirmed/);
  assert.match(out.detail, /1786600000000/);
  assert.match(out.detail, new RegExp(DEPOSIT.toLowerCase()));
  assert.doesNotMatch(out.detail, /Nothing was sent/);
  assert.deepEqual(out.txids, []);
  assert.equal(out.evidence?.nonce, '1786600000000', 'the nonce is the identity of the action and the only handle a retry has');
  assert.equal(out.evidence?.handle, DEPOSIT.toLowerCase());
  // Sent twice, both with the one nonce, and never a third time.
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.nonce), [NOW, NOW], 'the same nonce both times, never a fresh one');
});

test('a send with no reply is retried once with the same nonce, and a reply the second time is the send', async () => {
  const { rail: r, signed, posts } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], { exchangeThrowsOnce: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.nonce), [NOW, NOW]);
  assert.equal(signed.length, 2, 'the same typed data signed again, which is the same bytes');
  assert.equal((signed[0].message as Record<string, unknown>).time, (signed[1].message as Record<string, unknown>).time);
  assert.match(out.detail, /nonce 1786600000000/);
  assert.deepEqual(out.txids, ['0xledgerhash', '0xdest']);
});

/* The retry re-reads the account before it re-signs, and a 429 there used to throw out of
   execute: the executor wrote "rail threw" as failed, with no nonce and no handle on the row,
   over a send the venue may have taken, and a person reading "failed" proposed a second real
   withdrawal (review M1, 2026-09-20). The row hears first, and nothing throws after the signature. */
test('a send with no reply whose retry cannot read the account is unconfirmed with its nonce, told to the row before the ledger read, and never a throw', async () => {
  const { rail: r, posts, infoTypes } = rail({}, [{ available: 20, spot: 20, perp: 0 }], { exchangeThrowsOnce: true, infoFailsOnceAfterPost: 'clearinghouseState' });
  const told: Array<{ nonce?: string; handle?: string; infoCallsSoFar: string[] }> = [];
  const out = await r.execute(draft(), 'p1', { onEvidence: (e) => told.push({ nonce: e.nonce, handle: e.handle, infoCallsSoFar: [...infoTypes] }) });
  assert.equal(out.ok, false);
  assert.match(out.detail, /MAY HAVE BEEN ACCEPTED/);
  assert.match(out.detail, /tried once more: the retry with the same nonce could not run: hyperliquid clearinghouseState failed: 429/);
  assert.match(out.detail, /unconfirmed/);
  assert.doesNotMatch(out.detail, /Nothing was sent/);
  assert.equal(out.evidence?.nonce, '1786600000000');
  assert.equal(out.evidence?.handle, DEPOSIT.toLowerCase());
  assert.equal(posts.length, 1, 'the retry never reached the venue, and no fresh nonce was signed');
  assert.equal(told[0]?.nonce, '1786600000000', 'the nonce reached the row the moment the send went unanswered');
  assert.equal(told[0]?.handle, DEPOSIT.toLowerCase());
  assert.ok(!told[0]?.infoCallsSoFar.includes('userNonFundingLedgerUpdates'), 'told before the ledger read, not after it');
});

test('a send with no reply that the ledger already shows is not sent again at all', async () => {
  const { rail: r, posts } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], { exchangeThrowsOnce: true, ledgerKnowsNonce: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.equal(posts.length, 1, 'the ledger answered, so nothing was resent');
  assert.match(out.detail, /ledger 0xledgerhash/);
});

test('a send the ledger has not shown yet keeps its nonce as evidence and never a made up hash', async () => {
  const { rail: r } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], { ledgerMissing: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.deepEqual(out.txids, ['0xdest']);
  assert.ok(!(out.txids ?? []).some((h) => h.startsWith('hl-nonce-')), 'a synthetic id is not a hash');
  assert.doesNotMatch(out.detail, /hl-nonce-/);
  assert.match(out.detail, /nonce 1786600000000/);
  assert.match(out.detail, /ledger not found yet/);
  assert.equal(out.evidence?.nonce, '1786600000000');
});

test('a send the venue refused after the perp to spot move says where the collateral now sits', async () => {
  const { rail: r, exchange } = rail(
    {},
    [
      { available: 0, spot: 2, perp: 20, unified: false },
      { available: 0, spot: 2, perp: 20, unified: false },
      { available: 0, spot: 9, perp: 13, unified: false },
    ],
    { refuseSend: true },
  );
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.equal(exchange.length, 2, 'the class transfer ran, then the send was refused');
  assert.match(out.detail, /Insufficient balance/);
  assert.match(out.detail, /The collateral was moved to the spot side and stays there; nothing was sent out\./);
  assert.doesNotMatch(out.detail, /Nothing was sent\./);
});

test('a refund after the send names the amount and the venue account, with the send kept as evidence', async () => {
  const { rail: r } = rail({ status: 'REFUNDED', refundedAmount: '7.9' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, new RegExp(`REFUNDED: 7\\.9 USDC went back to .*${SELF}`));
  assert.ok(out.txids?.includes('0xledgerhash'));
  assert.equal(out.evidence?.refundedAmount, '7.9');
  assert.equal(out.evidence?.handle, DEPOSIT.toLowerCase());
});

test('a FAILED routing with nothing refunded says the input is held by 1Click, never that a refund goes back', async () => {
  const { rail: r } = rail({ status: 'FAILED', refundedAmount: '0' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /refunded 0 USDC so far/);
  assert.match(out.detail, new RegExp(`held by 1Click under handle ${DEPOSIT.toLowerCase()}`));
  assert.doesNotMatch(out.detail, /refund goes back/);
  assert.ok(out.txids?.includes('0xledgerhash'));
  assert.equal(out.evidence?.refundedAmount, '0');
});

test('a poll that never reaches terminal says THE SEND HAPPENED, in capitals, and names the address', async () => {
  const { rail: r } = rail({ statusThrows: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /THE SEND HAPPENED/);
  assert.match(out.detail, new RegExp(DEPOSIT.toLowerCase()));
});

test('a watch that runs out is unconfirmed and keeps the ledger hash and the address for a later check', async () => {
  const { rail: r } = rail({ status: 'PROCESSING' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /unconfirmed/);
  assert.ok(out.txids?.includes('0xledgerhash'));
  assert.equal(out.evidence?.handle, DEPOSIT.toLowerCase());
});

test('a short deposit is reported as INCOMPLETE_DEPOSIT with what 1Click saw, not as a poll that ran out', async () => {
  const { rail: r } = rail({ status: 'INCOMPLETE_DEPOSIT' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /INCOMPLETE_DEPOSIT/);
  assert.match(out.detail, /quoted 8\.0 USDC/);
  assert.match(out.detail, /unconfirmed/);
  assert.doesNotMatch(out.detail, /did not reach a terminal status/);
  assert.ok(out.txids?.includes('0xledgerhash'));
  assert.equal(out.evidence?.handle, DEPOSIT.toLowerCase());
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
  assert.equal(exchange[1].action.type, 'sendAsset');
});

// 1Click says SUCCESS the block the solver executes and a finality-final read lags it. The row
// used to flip to Confirmed on that word; now it is settling until the verifier shows the floor,
// with the pocket the executor re-judges it by (criterion 8.3).
test('a success the intents balance has not shown yet is settling with the intents pocket, never confirmed and never a loss', async () => {
  const { rail: r } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], {}, [0n, 0n]);
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.equal(out.settling, true);
  assert.match(out.detail, /has not shown it yet/);
  assert.match(out.detail, /has not shown the credit yet/);
  assert.doesNotMatch(out.detail, /failed/i);
  assert.deepEqual(out.pocket, {
    venue: 'intents',
    account: ACCOUNT,
    assetId: INTENTS_USDC_ASSET_ID,
    symbol: 'USDC',
    decimals: 6,
    before: '0',
    after: '0',
    floor: String(Math.round(minReceivedForHlWithdraw(AMOUNT) * 1e6)),
  });
  assert.equal(out.evidence?.nonce, '1786600000000');
  assert.equal(out.evidence?.handle, DEPOSIT.toLowerCase());
});

test('the verifier showing the floor on the third read after SUCCESS is a confirmed withdrawal, with the pocket after it', async () => {
  const { rail: r } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], {}, [0n, 0n, 0n, 7_780_248n]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /intents balance rose by 7\.780248/);
  assert.equal(out.pocket?.after, '7780248');
  assert.equal(out.pocket?.before, '0');
});

/* A row is confirmed by the intents balance rising over the rail's before-read and by nothing
   else (criterion 8.3), so a before-read the verifier will not give is a withdrawal nothing could
   confirm: it refuses before a quote mints an address and before the key is touched, the way the
   deposit rail refuses on its own before-read. It used to send anyway, land settling with no
   pocket, and let the sweep confirm it on 1Click's word (review L1, 2026-09-20). */
test('a verifier that would not answer before the send refuses before any quote: nothing is minted, nothing is signed', async () => {
  const { rail: r, quotes, signed, posts } = rail({}, [{ available: 20, spot: 20, perp: 0 }], {}, [], {
    intentsBalance: async () => null,
  });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /could not be read before the send/);
  assert.match(out.detail, /Nothing was sent/);
  assert.equal(quotes.filter((q) => !q.dry).length, 0, 'no live quote, so no deposit address was minted');
  assert.equal(signed.length, 0);
  assert.equal(posts.length, 0);
  assert.equal(out.evidence, undefined);
  assert.equal(out.pocket, undefined);
});

/* The pocket is what a row recovered from a crash is settled by. It used to land only when the
   rail returned, so a process killed while polling left a row with evidence and no pocket, and
   the boot sweep then wrote executed on 1Click's SUCCESS alone (review L1, 2026-09-20). */
test('the first word to the row carries the intents pocket beside the nonce and the signed quote, and an unconfirmed send keeps it', async () => {
  const { rail: r } = rail({}, undefined, { exchangeThrows: true });
  const told: Array<Record<string, unknown>> = [];
  const out = await r.execute(draft(), 'p1', { onEvidence: (e) => told.push(e as Record<string, unknown>) });
  const pocket = {
    venue: 'intents',
    account: ACCOUNT,
    assetId: INTENTS_USDC_ASSET_ID,
    symbol: 'USDC',
    decimals: 6,
    before: '0',
    after: null,
    floor: '7718000', // minReceivedForHlWithdraw(8) at six decimals, the floor the guarantee was checked against
  };
  assert.equal(told.length, 1);
  assert.equal(told[0].nonce, '1786600000000');
  assert.equal(told[0].handle, DEPOSIT.toLowerCase());
  assert.ok(told[0].quote !== undefined, 'the signed quote rides with the first word');
  assert.deepEqual(told[0].pocket, pocket, 'the before-read and the floor are on the row before the wait');
  assert.equal(out.ok, false);
  assert.match(out.detail, /unconfirmed/);
  assert.deepEqual(out.pocket, pocket, 'an unconfirmed send keeps the pocket for the sweep to judge it by');
});

test('the venue ledger names the send by its nonce, and a send delta without a nonce field still matches on destination, amount and time', async () => {
  const fixture = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], { exchangeThrowsOnce: true, ledgerKnowsNonce: true });
  const byNonce = await fixture.rail.execute(draft());
  assert.equal(byNonce.ok, true, byNonce.detail);
  assert.equal(fixture.posts.length, 1, 'the ledger answered by nonce, so nothing was resent');

  const shaped = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], { exchangeThrowsOnce: true, ledgerShapeOnly: true });
  const byShape = await shaped.rail.execute(draft());
  assert.equal(byShape.ok, true, byShape.detail);
  assert.equal(shaped.posts.length, 1, 'a nonce-less send delta for the same destination, amount and window is the send');
  assert.match(byShape.detail, /ledger 0xshapedhash/);

  const other = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }], { exchangeThrowsOnce: true, ledgerShapeOnly: true, ledgerShapeAmount: '7' });
  const miss = await other.rail.execute(draft());
  assert.equal(miss.ok, true, miss.detail);
  assert.equal(other.posts.length, 2, 'a different amount is not our send, so the same nonce was sent once more');
});

// ---------- the fee facts on the card (criteria 1.10, 8.1, 8.2) ----------

test('the simulation carries the fee facts the card draws: total with the activation fee, the app fee off the echo, the draft floor as "at least"', async () => {
  const { rail: r } = rail({ echo: { appFees: [{ recipient: 'app.near', fee: 25 }] } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, true, out.summary);
  const facts = out.send;
  assert.ok(facts !== undefined, 'the send facts are on the simulation');
  // 8 in, 7.780248 credited: 0.219752 inside the quote, of which 25 bp of 8 is 0.02, plus 1 on top.
  assert.equal(facts.feeUsd, 1.219752);
  // Both slots carry the floor: the card draws `arrives` as the landing leg and must never
  // print a promise above the one the rail holds the venue to (criterion 8.1).
  assert.equal(facts.arrives, String(minReceivedForHlWithdraw(AMOUNT)));
  assert.equal(facts.arrivesAtLeast, String(minReceivedForHlWithdraw(AMOUNT)));
  assert.equal(facts.destinationAsset, INTENTS_USDC_ASSET_ID);
  assert.equal(facts.etaSeconds, 180, "the whole move, off the table the card counts against, never the router's leg alone");
  assert.match(facts.activity, /25 bp app fee \(0\.02 USDC\)/);
  assert.match(facts.activity, /1 USDC on top/);
  assert.match(out.summary, /app fee   0\.0200 USDC, 25 bp, inside the quote/);
  assert.match(out.summary, /routing   0\.1998 USDC inside the quote/);
  assert.match(out.summary, /activation 1 USDC on top/);
  assert.match(out.summary, /at least  7\.7180 USDC|at least  7\.718 USDC/);
});

/* The card printed the draft's double through toFixed(6) while the guarantee is checked against
   toBaseUnits, which rounds the shortest decimal string half-up: 4.8541265 read as 4.854126 on
   the card and 4.854127 at the check, on 145 of 95,286 amounts (review L2, 2026-09-20). The
   card prints the check's own integer, so the two cannot disagree. */
test('the card floor is the base-unit floor the guarantee is checked against, formatted from that integer', async () => {
  const amount = 5.124625; // minReceived 4.8541265
  const { rail: r } = rail({
    quote: { amountIn: '512462500', amountInFormatted: '5.124625', amountInUsd: '5.124625', minAmountIn: '512462500', amountOut: '4900000', amountOutFormatted: '4.9', minAmountOut: '4860000' },
    echo: { amount: '512462500' },
  });
  const out = await r.simulate(draft({ amount, amountUsd: amount, minReceived: minReceivedForHlWithdraw(amount) }));
  assert.equal(out.ok, true, out.summary);
  assert.equal(out.send?.arrivesAtLeast, '4.854127', 'the floor the check demands, not the double rounded the other way');
  assert.equal(out.send?.arrives, '4.854127');
  assert.match(out.summary, /at least  4\.854127 USDC/);
});

test('a quote with no app fee line in its echo prices the app fee at 0 rather than assuming 25 bp', async () => {
  const { rail: r } = rail();
  const out = await r.simulate(draft());
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /app fee   0\.0000 USDC, 0 bp, inside the quote/);
  assert.match(out.send?.activity ?? '', /a 0 bp app fee \(0 USDC\)/);
});

test('a short balance refusal names the most that can come back, and under the floor says nothing can', async () => {
  const some = await rail({}, [{ available: 8.5, spot: 8.5, perp: 0 }]).rail.simulate(draft());
  assert.equal(some.ok, false);
  assert.match(some.summary, /The most that can come back now is 7\.5 USDC/);

  const none = await rail({}, [{ available: 5.5, spot: 5.5, perp: 0 }]).rail.simulate(draft());
  assert.equal(none.ok, false);
  assert.match(none.summary, /at most 4\.5 USDC could come back, under the 5 USDC floor/);
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

// ---------- the quote signature ----------
//
// The deposit address is the one field the echo never covered, and this rail sends the largest
// single number the app moves to it. The rail verifies 1Click's signature over the quote
// (src/quote-signature.ts) before the address is used for anything.

test('a quote whose deposit address was changed after signing is refused before any send', async () => {
  const { rail: r, signed, exchange } = rail(
    { tamper: (s) => ({ ...s, quote: { ...(s.quote as Record<string, unknown>), depositAddress: '0x000000000000000000000000000000000000dEaD' } }) },
    [{ available: 20, spot: 20, perp: 0 }],
  );
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /signature does not verify/);
  assert.match(out.detail, /Nothing was sent/);
  assert.equal(signed.length, 0, 'nothing was signed');
  assert.equal(exchange.length, 0, 'nothing was posted');
});

test('an unsigned quote is refused before any send, and a signed one lands its record in the evidence', async () => {
  const unsigned = rail({ tamper: (s) => ({ ...s, signature: undefined }) }, [{ available: 20, spot: 20, perp: 0 }]);
  const refused = await unsigned.rail.execute(draft());
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /carries no signature/);
  assert.equal(unsigned.signed.length, 0);

  const { rail: r } = rail({}, [{ available: 20, spot: 20, perp: 0 }, { available: 11, spot: 11, perp: 0 }]);
  const early: Array<Record<string, unknown>> = [];
  const out = await r.execute(draft(), 'p_1', { onEvidence: (e) => early.push(e as Record<string, unknown>) });
  assert.equal(out.ok, true, out.detail);
  const quote = out.evidence?.quote;
  assert.ok(quote !== undefined, 'the signed quote is on the result');
  assert.equal(quote.depositAddress, DEPOSIT);
  assert.match(quote.signature, /^ed25519:/);
  assert.equal(early[0].nonce, String(NOW), 'the executor heard about the send before the watch loop');
  assert.deepEqual(early[0].quote, quote);
  // Then one call per poll, each carrying 1Click's own word for where the order is, so the card
  // and the agent read the vendor's stage rather than a word only this app uses.
  assert.deepEqual(
    early.slice(1).map((e) => e.providerStage),
    ['SUCCESS'],
  );
});
