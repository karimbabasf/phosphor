// The one-time 1Click deposit address (src/rails/deposit-quote.ts): how it is minted, every check
// it has to pass before it may be shown, when a held one is handed out again, the book every
// minted address is written to, and the list of our own deposit addresses a payout is held to.
// Every 1Click answer here is a fake signed with the test key (tests/unit/helpers/signed-quote.ts);
// nothing in this file touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { QuoteRefusal } from '../../src/intents.ts';
import type { OneClickQuote, OneClickQuoteResponse } from '../../src/intents.ts';
import {
  DEPOSIT_BOOK_FILE,
  DEPOSIT_BOOK_KEPT,
  DEPOSIT_PINS_FILE,
  MINTS_PER_HOUR,
  MINT_WINDOW_MS,
  MIN_QUOTE_UNITS,
  ONE_TIME_DEADLINE_MS,
  REUSE_MIN_LEFT_MS,
  amountAboveFloor,
  createDepositBook,
  deadlineWords,
  depositAddressProblem,
  depositBookPath,
  depositQuoteProblems,
  floorFrom,
  keptRows,
  mintOneTimeDeposit,
  mintRoom,
  oneTimeWords,
  ownDepositsOn,
  standingAddresses,
  stillGood,
} from '../../src/rails/deposit-quote.ts';
import type { DepositAsk, DepositMode, OneTimeDeposit } from '../../src/rails/deposit-quote.ts';
import { receiveNetworkOf } from '../../src/rails/intents-address.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';
import { tempDir } from './helpers/tmp.ts';

const NOW = Date.parse('2026-11-13T18:05:00.000Z');
const HOUR = 60 * 60 * 1000;
const ACCOUNT = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const BASE_USDC_ID = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const WNEAR_ID = 'nep141:wrap.near';
const BASE_ADDRESS = '0x1111111111111111111111111111111111111111';
const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
const BTC_ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const NEAR_IMPLICIT = 'a'.repeat(64);

function net(id: string) {
  const n = receiveNetworkOf(id);
  assert.ok(n !== undefined, `${id} is a receive network`);
  return n;
}

// The account in mixed case, so a test sees the mint lowercase it everywhere.
function askOn(chain: string, token = { symbol: 'USDC', assetId: BASE_USDC_ID, decimals: 6 }): DepositAsk {
  return { account: ACCOUNT.toUpperCase().replace('0X', '0x'), net: net(chain), token };
}

type Params = Record<string, unknown> & { dry: boolean; amount: string; depositMode: DepositMode };

/* A live quote as 1Click would answer `params`: the request echoed, the address, the amount it
   was asked at, and a deadline the caller can move, all signed. `edit` changes the response
   before it is signed; `after` changes it after, which is what a tamper looks like. */
function answer(
  params: Params,
  over: { quote?: Partial<OneClickQuote> & Record<string, unknown>; echo?: Record<string, unknown>; edit?: (raw: Record<string, unknown>) => void; after?: (signed: Record<string, unknown>) => void } = {},
): OneClickQuoteResponse {
  const quote: Record<string, unknown> = {
    depositAddress: BASE_ADDRESS,
    amountIn: params.amount,
    amountInFormatted: '0.16',
    amountInUsd: '0.16',
    minAmountIn: params.amount,
    amountOut: params.amount,
    amountOutFormatted: '0.16',
    amountOutUsd: '0.16',
    minAmountOut: params.amount,
    deadline: new Date(NOW + ONE_TIME_DEADLINE_MS).toISOString(),
    timeWhenInactive: new Date(NOW + ONE_TIME_DEADLINE_MS).toISOString(),
    timeEstimate: 20,
    ...(over.quote ?? {}),
  };
  for (const [k, v] of Object.entries(quote)) if (v === undefined) delete quote[k];
  const raw: Record<string, unknown> = { quote, quoteRequest: { ...params, ...(over.echo ?? {}) } };
  over.edit?.(raw);
  const signed = signQuote(raw);
  over.after?.(signed);
  return {
    quote: signed['quote'] as OneClickQuote,
    raw: signed,
    signature: signed['signature'] as string,
    timestamp: signed['timestamp'] as string,
    correlationId: signed['correlationId'] as string,
  };
}

/* A fake 1Click quote endpoint. `dry` answers each dry ask in turn (an Error is thrown, anything
   else is taken); `live` answers the one live ask. Every ask is recorded. */
function fakeQuote(script: { dry?: Array<Error | 'ok'>; live?: (p: Params) => OneClickQuoteResponse }) {
  const asks: Params[] = [];
  const dry = [...(script.dry ?? ['ok'])];
  const quote = async (p: unknown): Promise<OneClickQuoteResponse> => {
    const params = { ...(p as Params) };
    asks.push(params);
    if (params.dry) {
      const next = dry.shift() ?? 'ok';
      if (next instanceof Error) throw next;
      return { quote: { amountIn: params.amount } as OneClickQuote, raw: {} };
    }
    return (script.live ?? ((x) => answer(x)))(params);
  };
  return { quote: quote as never, asks };
}

const tooLow = (n: string) => new QuoteRefusal(400, `Amount is too low for bridge, try at least ${n}`);
const badMode = () => new QuoteRefusal(400, 'Incorrect depositMode');
const closedPair = () => new QuoteRefusal(400, 'Quoting for this pair is not available');

const mintDeps = (q: { quote: never }) => ({ quote: q.quote, now: () => NOW, quoteKey: TEST_QUOTE_KEY });

/* ---------- the floor ---------- */

test('floorFrom reads 1Click\'s "try at least N" from a 400 refusal and nothing else', () => {
  assert.equal(floorFrom(tooLow('150000')), '150000');
  assert.equal(floorFrom(new QuoteRefusal(400, 'Amount is too low for bridge, try at least 0')), '0');
  assert.equal(floorFrom(new QuoteRefusal(500, 'Amount is too low for bridge, try at least 150000')), null, 'only a 400 names a floor');
  assert.equal(floorFrom(new Error('Amount is too low for bridge, try at least 150000')), null, 'only a QuoteRefusal is 1Click speaking');
  assert.equal(floorFrom(closedPair()), null);
});

test('amountAboveFloor lifts the floor past the slippage band and rounds up to two figures; a 0 floor is a millionth of the coin', () => {
  assert.equal(amountAboveFloor('150000', 6), 160000n, 'Base USDC: 0.15 becomes 0.16');
  assert.equal(amountAboveFloor('2000000', 6), 2100000n, 'XRP: 2 becomes 2.1');
  assert.equal(amountAboveFloor('0', 24), 1_100_000_000_000_000_000n, 'wNEAR: 0 becomes 1.1e18 yocto');
  assert.equal(amountAboveFloor('0', 6), 1100n, 'a 6 decimal coin with a 0 floor asks at 1,000 units lifted');
  for (const floor of ['1', '99', '150000', '2000000', '123456789']) {
    assert.ok(amountAboveFloor(floor, 6) > BigInt(floor), `${floor} is lifted, never asked at the floor itself`);
  }
});

test('a mint asks the floor dry at one base unit, never quotes at the floor, and sends exactly one live quote at an amount a dry one took', async () => {
  const q = fakeQuote({ dry: [tooLow('150000'), 'ok'] });
  const got = await mintOneTimeDeposit(mintDeps(q), askOn('base'));
  assert.deepEqual(
    q.asks.map((a) => [a.dry, a.amount]),
    [
      [true, '1'],
      [true, '160000'],
      [false, '160000'],
    ],
  );
  assert.equal(q.asks.filter((a) => !a.dry).length, 1, 'one live quote: one address minted');
  assert.ok(!q.asks.some((a) => a.amount === '150000'), 'never asked at the floor, which 1Click refuses');
  const live = q.asks[2]!;
  assert.equal(live.swapType, 'FLEX_INPUT');
  assert.equal(live.depositMode, 'SIMPLE');
  assert.equal(live.depositType, 'ORIGIN_CHAIN');
  assert.equal(live.recipientType, 'INTENTS');
  assert.equal(live.refundType, 'INTENTS', 'a refund lands in the person\'s own balance');
  assert.equal(live.recipient, ACCOUNT);
  assert.equal(live.refundTo, ACCOUNT);
  assert.equal(live.originAsset, BASE_USDC_ID);
  assert.equal(live.destinationAsset, BASE_USDC_ID, 'the same coin in and out');
  assert.equal(live.deadlineMs, ONE_TIME_DEADLINE_MS);
  assert.equal(live.slippageToleranceBps, 100);

  assert.equal(got.account, ACCOUNT, 'lowercased');
  assert.equal(got.chain, 'base');
  assert.equal(got.network, 'eth:8453');
  assert.equal(got.symbol, 'USDC');
  assert.equal(got.assetId, BASE_USDC_ID);
  assert.equal(got.decimals, 6);
  assert.equal(got.address, BASE_ADDRESS);
  assert.equal(got.memo, null);
  assert.equal(got.minimumBase, '160000');
  assert.equal(got.minimum, '0.16');
  assert.equal(got.deadline, new Date(NOW + ONE_TIME_DEADLINE_MS).toISOString());
  assert.equal(got.mintedAt, new Date(NOW).toISOString());
  assert.match(got.correlationId ?? '', /^test-quote-/);
  assert.ok(got.signature !== null && got.timestamp !== null, 'what a dispute is filed under is kept');
});

test('a floor that 1Click raises again at the lifted amount is lifted again; one that does not rise throws, and no live quote is sent', async () => {
  const again = fakeQuote({ dry: [tooLow('150000'), tooLow('160000'), 'ok'] });
  const got = await mintOneTimeDeposit(mintDeps(again), askOn('base'));
  assert.deepEqual(
    again.asks.map((a) => [a.dry, a.amount]),
    [
      [true, '1'],
      [true, '160000'],
      [true, '170000'],
      [false, '170000'],
    ],
  );
  assert.equal(got.minimumBase, '170000');

  const flat = fakeQuote({ dry: [tooLow('150000'), tooLow('100000')] });
  await assert.rejects(mintOneTimeDeposit(mintDeps(flat), askOn('base')), (err: unknown) => err instanceof QuoteRefusal && /try at least 100000/.test(err.message));
  assert.equal(flat.asks.filter((a) => !a.dry).length, 0, 'a floor that does not rise is a loop, and nothing is minted');

  const endless = fakeQuote({ dry: [tooLow('100000'), tooLow('1000000'), tooLow('10000000'), tooLow('100000000'), tooLow('1000000000'), 'ok'] });
  await assert.rejects(mintOneTimeDeposit(mintDeps(endless), askOn('base')), /try at least 1000000000\b/);
  assert.equal(endless.asks.length, 5, 'five dry asks at most');
  assert.equal(endless.asks.filter((a) => !a.dry).length, 0);
});

test('a 0 floor (NEAR) becomes a millionth of the coin lifted, and the live quote is asked there', async () => {
  const q = fakeQuote({ dry: [new QuoteRefusal(400, 'Amount is too low for bridge, try at least 0'), 'ok'], live: (p) => answer(p, { quote: { depositAddress: NEAR_IMPLICIT } }) });
  const got = await mintOneTimeDeposit(mintDeps(q), askOn('near', { symbol: 'WNEAR', assetId: WNEAR_ID, decimals: 24 }));
  assert.deepEqual(
    q.asks.map((a) => a.amount),
    ['1', '1100000000000000000', '1100000000000000000'],
  );
  assert.equal(got.minimum, '0.0000011');
});

test('a floor of a unit or two (ARB, SUI, USDG live on 2026-11-13) is quoted at a millionth of the coin and never under 1,000 units, so one unit of rounding cannot trip the value check', async () => {
  assert.equal(MIN_QUOTE_UNITS, 1000n);
  // 1Click as it answers live: the slippage band taken off minAmountOut, rounded down.
  const banded = (p: Params) => answer(p, { quote: { minAmountOut: ((BigInt(p.amount) * 9_900n) / 10_000n).toString() } });
  const six = fakeQuote({ dry: [tooLow('1'), 'ok'], live: banded });
  const usdc = await mintOneTimeDeposit(mintDeps(six), askOn('base'));
  assert.deepEqual(six.asks.map((a) => a.amount), ['1', '1100', '1100']);
  assert.equal(usdc.minimumBase, '1100');

  const eighteen = fakeQuote({ dry: [tooLow('2'), 'ok'], live: banded });
  const arb = await mintOneTimeDeposit(mintDeps(eighteen), askOn('arb', { symbol: 'ARB', assetId: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near', decimals: 18 }));
  assert.deepEqual(eighteen.asks.map((a) => a.amount), ['1', '1100000000000', '1100000000000']);
  assert.equal(arb.minimum, '0.0000011');
});

test('one base unit refused without a floor (Bitcoin answers "Failed to get quote" for 1 sat) is asked once more at a millionth of the coin, never under 1,000 units; no other refusal is asked again', async () => {
  const unpriced = () => new QuoteRefusal(400, 'Failed to get quote');
  const btcToken = { symbol: 'BTC', assetId: 'nep141:btc.omft.near', decimals: 8 };
  const btc = fakeQuote({ dry: [unpriced(), tooLow('6400'), 'ok'], live: (p) => answer(p, { quote: { depositAddress: BTC_ADDRESS } }) });
  const got = await mintOneTimeDeposit(mintDeps(btc), askOn('btc', btcToken));
  assert.deepEqual(
    btc.asks.map((a) => [a.dry, a.amount]),
    [
      [true, '1'],
      [true, '1000'],
      [true, '6500'],
      [false, '6500'],
    ],
  );
  assert.equal(got.minimum, '0.000065');

  const twice = fakeQuote({ dry: [unpriced(), unpriced(), 'ok'] });
  await assert.rejects(mintOneTimeDeposit(mintDeps(twice), askOn('btc', btcToken)), /Failed to get quote/);
  assert.equal(twice.asks.length, 2, 'asked again once, and nothing minted');

  const other = fakeQuote({ dry: [new QuoteRefusal(400, 'Internal error'), 'ok'] });
  await assert.rejects(mintOneTimeDeposit(mintDeps(other), askOn('btc', btcToken)), /Internal error/);
  assert.equal(other.asks.length, 1, 'any other refusal at the first ask stands as it was');
});

test('one depositMode retry: "Incorrect depositMode" switches the mode once, a second one throws, and Stellar is asked in memo mode first', async () => {
  const switched = fakeQuote({ dry: [badMode(), 'ok'], live: (p) => answer(p, { quote: { depositMemo: '12345' } }) });
  const got = await mintOneTimeDeposit(mintDeps(switched), askOn('base'));
  assert.deepEqual(
    switched.asks.map((a) => [a.dry, a.depositMode]),
    [
      [true, 'SIMPLE'],
      [true, 'MEMO'],
      [false, 'MEMO'],
    ],
  );
  assert.equal(got.memo, '12345', 'a memo chain keeps its memo, half of where the money goes');

  const twice = fakeQuote({ dry: [badMode(), badMode(), 'ok'] });
  await assert.rejects(mintOneTimeDeposit(mintDeps(twice), askOn('base')), /Incorrect depositMode/);
  assert.equal(twice.asks.length, 2, 'the mode is switched at most once');

  const stellar = fakeQuote({ dry: [closedPair()] });
  await assert.rejects(
    mintOneTimeDeposit(mintDeps(stellar), askOn('stellar', { symbol: 'XLM', assetId: 'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz', decimals: 7 })),
    (err: unknown) => err instanceof QuoteRefusal && err.message === 'Quoting for this pair is not available',
  );
  assert.equal(stellar.asks[0]!.depositMode, 'MEMO');
  assert.equal(stellar.asks.length, 1, 'a closed pair is thrown as 1Click said it, for the card to draw as a pause');
});

test('a live quote with any problem throws naming it, so no address is ever returned from it', async () => {
  const q = fakeQuote({ live: (p) => answer(p, { quote: { depositAddress: '0x123' } }) });
  await assert.rejects(mintOneTimeDeposit(mintDeps(q), askOn('base')), /the deposit address was not shown: the deposit address is not an address on Base/);
  const unsigned = fakeQuote({});
  await assert.rejects(mintOneTimeDeposit({ quote: unsigned.quote, now: () => NOW }, askOn('base')), /does not verify against 1Click's key/, 'the shipped key does not trust the test signer');
});

test('the deadline is capped at 24 hours whatever 1Click answers, a shorter one is kept, and the address goes cold no later than it', async () => {
  const long = fakeQuote({ live: (p) => answer(p, { quote: { deadline: new Date(NOW + 30 * 24 * HOUR).toISOString(), timeWhenInactive: new Date(NOW + 29 * 24 * HOUR).toISOString() } }) });
  const capped = await mintOneTimeDeposit(mintDeps(long), askOn('base'));
  assert.equal(capped.deadline, new Date(NOW + ONE_TIME_DEADLINE_MS).toISOString());
  assert.equal(capped.coldAt, capped.deadline, 'cold no later than the deadline');

  const short = fakeQuote({ live: (p) => answer(p, { quote: { deadline: new Date(NOW + 20 * HOUR).toISOString(), timeWhenInactive: undefined } }) });
  const kept = await mintOneTimeDeposit(mintDeps(short), askOn('base'));
  assert.equal(kept.deadline, new Date(NOW + 20 * HOUR).toISOString());
  assert.equal(kept.coldAt, null);
});

test('the minimum is the quoted amountIn, and the asked amount when 1Click\'s is not a whole number', async () => {
  const q = fakeQuote({ dry: [tooLow('150000'), 'ok'], live: (p) => answer(p, { quote: { amountIn: '170000', amountOut: '170000', minAmountOut: '168300' } }) });
  assert.equal((await mintOneTimeDeposit(mintDeps(q), askOn('base'))).minimum, '0.17');
  const odd = fakeQuote({ dry: [tooLow('150000'), 'ok'], live: (p) => answer(p, { quote: { amountIn: '0.17' } }) });
  assert.equal((await mintOneTimeDeposit(mintDeps(odd), askOn('base'))).minimumBase, '160000');
});

/* ---------- every refusal before an address may be shown ---------- */

const LIVE: Params = {
  dry: false,
  swapType: 'FLEX_INPUT',
  depositMode: 'SIMPLE',
  originAsset: BASE_USDC_ID,
  destinationAsset: BASE_USDC_ID,
  amount: '160000',
  refundTo: ACCOUNT,
  refundType: 'INTENTS',
  recipient: ACCOUNT,
  recipientType: 'INTENTS',
  depositType: 'ORIGIN_CHAIN',
  slippageToleranceBps: 100,
  deadlineMs: ONE_TIME_DEADLINE_MS,
};
const SENT = { amount: '160000', mode: 'SIMPLE' as DepositMode };
const ASK: DepositAsk = { account: ACCOUNT, net: net('base'), token: { symbol: 'USDC', assetId: BASE_USDC_ID, decimals: 6 } };
const problemsOf = (r: OneClickQuoteResponse, over: { ask?: DepositAsk; sent?: typeof SENT; now?: number; key?: string } = {}) =>
  depositQuoteProblems(r, over.ask ?? ASK, over.sent ?? SENT, over.now ?? NOW, 'key' in over ? over.key : TEST_QUOTE_KEY);

function onlyProblem(r: OneClickQuoteResponse, pattern: RegExp, over: Parameters<typeof problemsOf>[1] = {}): void {
  const got = problemsOf(r, over);
  assert.ok(got.some((p) => pattern.test(p)), `expected ${pattern} in ${JSON.stringify(got)}`);
}

test('a good live quote has no problems', () => {
  assert.deepEqual(problemsOf(answer(LIVE)), []);
});

test('the echo: our account as recipient and refund, INTENTS both ways, ORIGIN_CHAIN, the coin in and out, the amount sent', () => {
  const other = '0x2222222222222222222222222222222222222222';
  onlyProblem(answer(LIVE, { echo: { recipient: other } }), /priced to credit .*not our intents account/);
  onlyProblem(answer(LIVE, { echo: { refundTo: other } }), /a refund on this quote goes to .*not to our account/);
  onlyProblem(answer(LIVE, { echo: { refundType: 'ORIGIN_CHAIN' } }), /a refund on this quote goes to .*this wallet's own intents balance/);
  onlyProblem(answer(LIVE, { echo: { recipientType: 'DESTINATION_CHAIN' } }), /pays out as .*not INTENTS/);
  onlyProblem(answer(LIVE, { echo: { depositType: 'INTENTS' } }), /takes its input as .*not the ORIGIN_CHAIN/);
  onlyProblem(answer(LIVE, { echo: { destinationAsset: 'nep141:wrap.near' } }), /the quote moves /);
  onlyProblem(answer(LIVE, { echo: { amount: '1' } }), /priced for .*not the 160000/);
  onlyProblem(answer(LIVE, { edit: (raw) => delete raw['quoteRequest'] }), /no quoteRequest echo, so nothing ties its address to this wallet/);
  assert.deepEqual(problemsOf(answer({ ...LIVE, recipient: ACCOUNT.toUpperCase().replace('0X', '0x'), refundTo: ACCOUNT.toUpperCase().replace('0X', '0x') })), [], 'an EVM account compares case-blind');
});

test('the signature: unsigned, tampered after signing, or signed by another key is refused', () => {
  onlyProblem(answer(LIVE, { after: (s) => delete s['signature'] }), /carries no signature/);
  onlyProblem(
    answer(LIVE, {
      after: (s) => {
        (s['quote'] as Record<string, unknown>)['depositAddress'] = '0x3333333333333333333333333333333333333333';
      },
    }),
    /does not verify against 1Click's key/,
  );
  onlyProblem(answer(LIVE), /does not verify against 1Click's key/, { key: undefined });
});

test('swapType FLEX_INPUT and a live (not dry) quote are both required', () => {
  onlyProblem(answer({ ...LIVE, swapType: 'EXACT_INPUT' }), /priced as EXACT_INPUT, not FLEX_INPUT/);
  onlyProblem(answer({ ...LIVE, dry: true }), /a dry run, which carries no address/);
  onlyProblem(answer(LIVE, { echo: { dry: undefined } }), /a dry run, which carries no address/, {});
});

test('the address: present, and shaped like an address on the chain it was asked for', () => {
  onlyProblem(answer(LIVE, { quote: { depositAddress: undefined } }), /carries no deposit address/);
  onlyProblem(answer(LIVE, { quote: { depositAddress: '   ' } }), /carries no deposit address/);
  onlyProblem(answer(LIVE, { quote: { depositAddress: '0x123' } }), /not an address on Base/);
  onlyProblem(answer(LIVE, { quote: { depositAddress: SOL_ADDRESS } }), /not an address on Base/, {});

  assert.equal(depositAddressProblem(net('base'), BASE_ADDRESS), null);
  assert.equal(depositAddressProblem(net('arb'), BASE_ADDRESS), null, 'every EVM chain shares one shape');
  assert.equal(depositAddressProblem(net('sol'), SOL_ADDRESS), null);
  assert.notEqual(depositAddressProblem(net('sol'), BASE_ADDRESS), null);
  assert.equal(depositAddressProblem(net('btc'), BTC_ADDRESS), null);
  assert.notEqual(depositAddressProblem(net('btc'), BASE_ADDRESS), null);
  assert.equal(depositAddressProblem(net('near'), NEAR_IMPLICIT), null);
  assert.notEqual(depositAddressProblem(net('near'), 'has spaces in it.near'), null);
  // A chain with no decoder still needs a printable, unbroken string of a plausible length.
  assert.notEqual(depositAddressProblem(net('aleo'), 'short'), null);
  assert.notEqual(depositAddressProblem(net('aleo'), 'aleo1 with a space in the middle'), null);
  assert.notEqual(depositAddressProblem(net('aleo'), 'x'.repeat(129)), null);
});

test('a memo exactly when the quote was asked in memo mode', () => {
  onlyProblem(answer({ ...LIVE, depositMode: 'MEMO' }), /asked in memo mode and carries no memo/, { sent: { amount: '160000', mode: 'MEMO' } });
  onlyProblem(answer(LIVE, { quote: { depositMemo: '42' } }), /carries a memo it was not asked for/);
  assert.deepEqual(problemsOf(answer({ ...LIVE, depositMode: 'MEMO' }, { quote: { depositMemo: '42' } }), { sent: { amount: '160000', mode: 'MEMO' } }), []);
});

test('the deadline: present, and at least half an hour ahead', () => {
  onlyProblem(answer(LIVE, { quote: { deadline: undefined } }), /carries no deadline/);
  onlyProblem(answer(LIVE, { quote: { deadline: 'soon' } }), /carries no deadline/);
  onlyProblem(answer(LIVE, { quote: { deadline: new Date(NOW + 29 * 60 * 1000).toISOString() } }), /stops taking money in under half an hour/);
  assert.deepEqual(problemsOf(answer(LIVE, { quote: { deadline: new Date(NOW + 31 * 60 * 1000).toISOString() } })), []);
});

test('the value: a quote that keeps more than 1% of a same-coin deposit is refused, because a fee line sits outside the signature and only the signed amounts show it', async () => {
  // A fee line added on the way out and taken off the echo, or 1Click's own fee account carrying a
  // huge one: the echo looks clean and only amountOut says half of every deposit goes elsewhere.
  onlyProblem(answer(LIVE, { quote: { amountOut: '80000', amountOutFormatted: '0.08', minAmountOut: '79200' } }), /keeps 50% of a deposit/);
  onlyProblem(answer(LIVE, { quote: { amountOut: '158000', minAmountOut: '156420' } }), /keeps 1\.25% of a deposit/);
  onlyProblem(answer(LIVE, { quote: { minAmountOut: '150000' } }), /guarantees only 150000 of 160000/);
  onlyProblem(answer(LIVE, { quote: { amountOut: undefined } }), /carries no amounts this app can read/);
  onlyProblem(answer(LIVE, { quote: { amountOut: '0.16' } }), /carries no amounts this app can read/);
  // Live 2026-11-13: in = out on Base, NEAR and XRP; BTC kept 2.2 bp. One percent exactly is taken.
  assert.deepEqual(problemsOf(answer(LIVE, { quote: { amountOut: '159965', minAmountOut: '158365' } })), []);
  assert.deepEqual(problemsOf(answer(LIVE, { quote: { amountOut: '158400', minAmountOut: '156816' } })), []);

  // And through the mint: no address comes back from a quote that skims.
  const skim = fakeQuote({ dry: [tooLow('150000'), 'ok'], live: (p) => answer(p, { quote: { amountOut: String(BigInt(p.amount) / 2n), minAmountOut: String(BigInt(p.amount) / 2n) } }) });
  await assert.rejects(mintOneTimeDeposit(mintDeps(skim), askOn('base')), /the deposit address was not shown: .*keeps 50% of a deposit/);
});

/* ---------- reuse and the words ---------- */

function record(over: Partial<OneTimeDeposit> = {}): OneTimeDeposit {
  return {
    account: ACCOUNT,
    chain: 'base',
    network: 'eth:8453',
    symbol: 'USDC',
    assetId: BASE_USDC_ID,
    decimals: 6,
    address: BASE_ADDRESS,
    memo: null,
    minimumBase: '160000',
    minimum: '0.16',
    deadline: new Date(NOW + ONE_TIME_DEADLINE_MS).toISOString(),
    coldAt: null,
    mintedAt: new Date(NOW).toISOString(),
    correlationId: 'c-1',
    signature: null,
    timestamp: null,
    ...over,
  };
}

test('stillGood: the same account, chain and coin with two hours or more left, and nothing else', () => {
  const ask = { account: ACCOUNT.toUpperCase().replace('0X', '0x'), chain: 'base', assetId: BASE_USDC_ID };
  const d = record({ deadline: new Date(NOW + 3 * HOUR).toISOString() });
  assert.equal(stillGood(d, ask, NOW), true);
  assert.equal(stillGood(d, ask, NOW + HOUR), true, 'exactly two hours left is still good');
  assert.equal(stillGood(d, ask, NOW + HOUR + 1), false, 'under two hours left mints a new one');
  assert.equal(REUSE_MIN_LEFT_MS, 2 * HOUR);
  assert.equal(stillGood(d, { ...ask, account: '0x2222222222222222222222222222222222222222' }, NOW), false);
  assert.equal(stillGood(d, { ...ask, chain: 'arb' }, NOW), false, 'a Base address is never handed out for Arbitrum');
  assert.equal(stillGood(d, { ...ask, assetId: 'nep141:other' }, NOW), false);
  assert.equal(stillGood(record({ deadline: 'garbage' }), ask, NOW), false, 'a deadline nobody can read is no time left');
});

test('deadlineWords and oneTimeWords say the deadline in UTC minutes, the same for the window and the agent', () => {
  assert.equal(deadlineWords('2026-11-14T18:05:33.000Z'), '2026-11-14 18:05 UTC');
  assert.equal(deadlineWords('garbage'), 'its deadline');
  assert.equal(
    oneTimeWords({ deadline: '2026-11-14T18:05:33.000Z' }),
    'This address is for one deposit and stops taking money at 2026-11-14 18:05 UTC. Do not save it or send to it again; ask for a new one next time.',
  );
});

/* ---------- the book ---------- */

test('the book: newest first, the same address and memo replaced not doubled, settle marks one, owner-only file', () => {
  const dir = tempDir('phosphor-book-');
  const book = createDepositBook(dir);
  assert.deepEqual(book.all(), [], 'no file is no rows');
  book.add(record({ address: BASE_ADDRESS }));
  book.add(record({ address: '0x2222222222222222222222222222222222222222' }));
  assert.deepEqual(
    book.all().map((r) => r.address),
    ['0x2222222222222222222222222222222222222222', BASE_ADDRESS],
  );
  assert.ok(book.all().every((r) => r.settled === null));

  book.settle(BASE_ADDRESS, null, 'SUCCESS');
  assert.equal(book.all().find((r) => r.address === BASE_ADDRESS)?.settled, 'SUCCESS');
  book.settle(BASE_ADDRESS, '7', 'FAILED');
  assert.equal(book.all().find((r) => r.address === BASE_ADDRESS)?.settled, 'SUCCESS', 'the memo is half of the spot: another memo is another address');
  book.settle('0x9999999999999999999999999999999999999999', null, 'SUCCESS');
  assert.equal(book.all().length, 2, 'settling an address the book never had changes nothing');

  // Same address, another memo, is another spot; the same spot again moves to the top, open.
  book.add(record({ address: BASE_ADDRESS, memo: '7' }));
  book.add(record({ address: BASE_ADDRESS }));
  const rows = book.all();
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0]!.address, rows[0]!.memo, rows[0]!.settled], [BASE_ADDRESS, null, null]);

  const file = depositBookPath(dir);
  assert.equal(path.basename(file), DEPOSIT_BOOK_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // all() is a copy: a caller cannot edit the book by editing what it was handed.
  book.all().pop();
  assert.equal(book.all().length, 3);
  // A second book over the same folder (the payout check's) sees the same rows.
  assert.equal(createDepositBook(dir).all().length, 3);
});

const nth = (i: number): string => `0x${i.toString(16).padStart(40, '0')}`;
// A row whose deadline passed an hour before NOW, minted a day before that.
const spent = (i: number) => ({ ...record({ address: nth(i), deadline: new Date(NOW - HOUR).toISOString(), mintedAt: new Date(NOW - 25 * HOUR).toISOString() }), settled: null });
const open = (i: number) => ({ ...record({ address: nth(i) }), settled: null });

test('the book keeps the newest 500', () => {
  const dir = tempDir('phosphor-book-');
  const rows = Array.from({ length: DEPOSIT_BOOK_KEPT + 2 }, (_, i) => spent(i));
  fs.writeFileSync(depositBookPath(dir), JSON.stringify({ version: 1, deposits: rows.slice(1) }));
  const book = createDepositBook(dir, () => NOW);
  book.add(rows[0]!);
  const all = book.all();
  assert.equal(DEPOSIT_BOOK_KEPT, 500);
  assert.equal(all.length, 500);
  assert.equal(all[0]!.address, rows[0]!.address, 'the new one is first');
  assert.equal(all[499]!.address, rows[499]!.address);
  assert.ok(!all.some((r) => r.address === rows[500]!.address), 'the oldest fell off');
});

test('the book never drops an address that still takes money: past 500 the oldest past their deadline go, and live ones past the cap all stay', () => {
  // A live address at the very bottom (a newer quote can carry a shorter deadline than an older
  // one): the next add drops the oldest spent row above it, never the live one.
  const dir = tempDir('phosphor-book-');
  const rows = [...Array.from({ length: DEPOSIT_BOOK_KEPT - 1 }, (_, i) => spent(i + 1)), open(9999)];
  fs.writeFileSync(depositBookPath(dir), JSON.stringify({ version: 1, deposits: rows }));
  const book = createDepositBook(dir, () => NOW);
  book.add(open(0));
  const all = book.all().map((r) => r.address);
  assert.equal(all.length, DEPOSIT_BOOK_KEPT);
  assert.equal(all[0], nth(0));
  assert.equal(all.at(-1), nth(9999), 'the live address at the bottom was dropped');
  assert.ok(!all.includes(nth(DEPOSIT_BOOK_KEPT - 1)), 'the oldest spent row stayed');

  // More live addresses than the cap: every one stays, and every spent one goes.
  const full = tempDir('phosphor-book-');
  fs.writeFileSync(depositBookPath(full), JSON.stringify({ version: 1, deposits: [...Array.from({ length: DEPOSIT_BOOK_KEPT + 20 }, (_, i) => open(i + 1)), spent(7777)] }));
  const crowded = createDepositBook(full, () => NOW);
  crowded.add(open(0));
  assert.equal(crowded.all().length, DEPOSIT_BOOK_KEPT + 21);
  assert.ok(!crowded.all().some((r) => r.address === nth(7777)));
  // A settle writes the book too, by the same rule.
  crowded.settle(nth(1), null, 'SUCCESS');
  assert.equal(crowded.all().length, DEPOSIT_BOOK_KEPT + 21);

  // keptRows itself: at or under the cap nothing goes, live or not; a deadline nobody can read is live.
  assert.equal(keptRows([spent(1), spent(2)], NOW).length, 2);
  const unread = { ...spent(5), deadline: 'not a date' };
  const kept = keptRows([...Array.from({ length: DEPOSIT_BOOK_KEPT }, (_, i) => spent(i + 10)), unread], NOW);
  assert.equal(kept.length, DEPOSIT_BOOK_KEPT);
  assert.ok(kept.includes(unread));
});

test('mintRoom: 20 new addresses an hour, counted from the book\'s own mintedAt, with the mints still waiting on 1Click, and when the next one frees', () => {
  assert.equal(MINTS_PER_HOUR, 20);
  assert.equal(MINT_WINDOW_MS, HOUR);
  assert.ok(MINTS_PER_HOUR * (ONE_TIME_DEADLINE_MS / MINT_WINDOW_MS) < DEPOSIT_BOOK_KEPT, 'an hour of mints for every hour an address lives must stay under what the book keeps');
  const MIN = 60_000;
  const mintedAgo = (minutes: number[]) => minutes.map((m, i) => ({ ...open(i + 1), mintedAt: new Date(NOW - m * MIN).toISOString() }));
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  assert.deepEqual(mintRoom([], NOW), { ok: true });
  assert.deepEqual(mintRoom(mintedAgo(range(1, 19)), NOW), { ok: true });
  // One more waiting on 1Click fills the hour: it frees when the oldest (19 minutes ago) leaves it.
  assert.deepEqual(mintRoom(mintedAgo(range(1, 19)), NOW, 1), { ok: false, freesInMs: 41 * MIN });
  assert.deepEqual(mintRoom(mintedAgo(range(1, 20)), NOW), { ok: false, freesInMs: 40 * MIN });
  // Twenty-two in the hour: three have to leave, so it frees when the third oldest does.
  assert.deepEqual(mintRoom(mintedAgo(range(1, 22)), NOW), { ok: false, freesInMs: 40 * MIN });
  // Twenty waiting and none written yet: refused, and free again as soon as one is written or fails.
  assert.deepEqual(mintRoom([], NOW, MINTS_PER_HOUR), { ok: false, freesInMs: 0 });
  // An hour ago or more does not count, and neither does a mintedAt nobody can read.
  assert.deepEqual(mintRoom([...mintedAgo([...range(1, 19), 60, 61, 600]), { ...open(50), mintedAt: 'not a date' }], NOW), { ok: true });
  // A clock set back: a row minted within the hour ahead still counts (the oldest still leaves
  // first), and one further ahead does not.
  assert.deepEqual(mintRoom(mintedAgo([...range(1, 19), -30]), NOW), { ok: false, freesInMs: 41 * MIN });
  assert.deepEqual(mintRoom(mintedAgo([...range(1, 19), -61]), NOW), { ok: true });
});

test('an unreadable book is no rows for the card and is never written over, and a row the app cannot type is kept and still ours', () => {
  /* A book that is there and cannot be read may hold addresses that still take money. Written over,
     they would be gone from the payout check for good, so the card is refused instead, the file is
     left for a person to look at, and the payout check refuses rather than reading it as empty. */
  const dir = tempDir('phosphor-book-');
  fs.writeFileSync(depositBookPath(dir), '{not json');
  const book = createDepositBook(dir);
  assert.deepEqual(book.all(), []);
  assert.throws(() => book.add(record()), /cannot be read, so it is not written over/);
  assert.doesNotThrow(() => book.settle(BASE_ADDRESS, null, 'SUCCESS'));
  assert.equal(fs.readFileSync(depositBookPath(dir), 'utf8'), '{not json');
  assert.equal(ownDepositsOn(dir, 'base'), null);
  fs.writeFileSync(depositBookPath(dir), JSON.stringify({ version: 1, deposits: 'none' }));
  assert.equal(ownDepositsOn(dir, 'base'), null, 'a file that parses but holds no list is not an empty list');

  const mixed = tempDir('phosphor-book-');
  const odd = { ...record({ address: nth(7) }), decimals: 'six', settled: null };
  fs.writeFileSync(depositBookPath(mixed), JSON.stringify({ deposits: [{ ...record(), settled: null }, { ...record({ address: '' }), settled: null }, odd, null, 'x'] }));
  const kept = createDepositBook(mixed);
  assert.equal(kept.all().length, 1);
  kept.add(record({ address: nth(8) }));
  kept.settle(nth(8), null, 'SUCCESS');
  const raw = JSON.parse(fs.readFileSync(depositBookPath(mixed), 'utf8')) as { deposits: Array<{ address?: unknown }> };
  assert.ok(raw.deposits.some((r) => r?.address === nth(7)), 'a row this build cannot type survives the next write');
  assert.deepEqual(createDepositBook(mixed).all().map((r) => r.address), [nth(8), BASE_ADDRESS]);
  assert.deepEqual(ownDepositsOn(mixed, 'arb')!.map((o) => o.address).sort(), [BASE_ADDRESS, nth(7), nth(8)].sort());
});

test('the book throws when it cannot write, so an address it cannot find again is never shown', () => {
  const root = tempDir('phosphor-book-');
  const blocker = path.join(root, 'not-a-folder');
  fs.writeFileSync(blocker, '');
  const book = createDepositBook(path.join(blocker, 'data'));
  assert.throws(() => book.add(record()));
  assert.doesNotThrow(() => book.settle(BASE_ADDRESS, null, 'SUCCESS'), 'a settle that cannot write costs one more status call, nothing else');
});

/* ---------- our own deposit addresses, for the payout check ---------- */

function pins(dir: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, DEPOSIT_PINS_FILE), typeof value === 'string' ? value : JSON.stringify(value));
}

test('standingAddresses reads the old pins file, read only, and skips what is not a pin', () => {
  const dir = tempDir('phosphor-pins-');
  assert.deepEqual(standingAddresses(dir), [], 'no file');
  pins(dir, {
    [`${ACCOUNT}|eth:1`]: { address: BASE_ADDRESS },
    [`${ACCOUNT}|stellar:mainnet`]: { address: 'GSTELLAR', memo: '99' },
    '|eth:1': { address: BASE_ADDRESS },
    'no-bar': { address: BASE_ADDRESS },
    [`${ACCOUNT}|sol:mainnet`]: { address: '' },
    [`${ACCOUNT}|btc:mainnet`]: null,
  });
  const before = fs.readFileSync(path.join(dir, DEPOSIT_PINS_FILE), 'utf8');
  assert.deepEqual(standingAddresses(dir), [
    { account: ACCOUNT, network: 'eth:1', address: BASE_ADDRESS, memo: null },
    { account: ACCOUNT, network: 'stellar:mainnet', address: 'GSTELLAR', memo: '99' },
  ]);
  assert.equal(fs.readFileSync(path.join(dir, DEPOSIT_PINS_FILE), 'utf8'), before, 'never written');
  pins(dir, '[1,2]');
  assert.deepEqual(standingAddresses(dir), []);
  pins(dir, '{broken');
  assert.deepEqual(standingAddresses(dir), []);
});

test('ownDepositsOn: the book and the pins on every chain of the payout chain\'s address family, for every account', () => {
  const dir = tempDir('phosphor-own-');
  const book = createDepositBook(dir);
  const baseOne = '0x4444444444444444444444444444444444444444';
  const otherAccount = '0x5555555555555555555555555555555555555555';
  book.add(record({ address: baseOne }));
  book.add(record({ address: SOL_ADDRESS, chain: 'sol', network: 'sol:mainnet', account: otherAccount }));
  book.add(record({ address: BTC_ADDRESS, chain: 'btc', network: 'btc:mainnet' }));
  pins(dir, {
    [`${ACCOUNT}|eth:1`]: { address: BASE_ADDRESS },
    [`${ACCOUNT}|sol:mainnet`]: { address: 'So22222222222222222222222222222222222222222' },
    [`${ACCOUNT}|nowhere:1`]: { address: 'nowhere-address' },
  });

  const onArb = ownDepositsOn(dir, 'arb')!;
  assert.deepEqual(
    onArb.map((o) => [o.address, o.kind, o.network]),
    [
      [baseOne, 'one_time', 'base'],
      [BASE_ADDRESS, 'standing', 'eth'],
    ],
    'a Base one-time address and an Ethereum pin are both caught on Arbitrum',
  );
  assert.equal(onArb[0]!.deadline, record().deadline);
  assert.equal(onArb[1]!.deadline, null);
  for (const chain of ['eth', 'base', 'op', 'polygon', 'hypercore', 'bnb']) {
    assert.equal(ownDepositsOn(dir, chain)!.length, 2, `${chain} is in the EVM family`);
  }
  assert.deepEqual(
    ownDepositsOn(dir, 'sol')!.map((o) => o.address),
    [SOL_ADDRESS, 'So22222222222222222222222222222222222222222'],
    'another account\'s address on this Mac is still ours',
  );
  assert.equal(ownDepositsOn(dir, 'fogo')!.length, 2, 'Fogo pays to Solana-shaped addresses');
  assert.deepEqual(
    ownDepositsOn(dir, 'btc')!.map((o) => o.address),
    [BTC_ADDRESS],
  );
  assert.deepEqual(ownDepositsOn(dir, 'near'), []);
  assert.deepEqual(ownDepositsOn(dir, 'no-such-chain'), []);
  assert.deepEqual(ownDepositsOn(tempDir('phosphor-own-'), 'arb'), [], 'nothing minted, nothing pinned');

  // A pins file that is there and cannot be read refuses too: it may name an address on an exchange.
  for (const broken of ['{broken', '[1,2]']) {
    pins(dir, broken);
    assert.equal(ownDepositsOn(dir, 'arb'), null, broken);
  }
});
