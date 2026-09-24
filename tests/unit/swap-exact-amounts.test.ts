// Exact amounts, end to end. "Swap all my NEAR" failed three times on 2026-09-23: the whole
// wNEAR balance, 894697028778374732410224 yocto, travelled as the double 0.8946970287783748 and
// came back as 894697028778374800000000, 67,589,776 more than was held, so the signed transfer
// could never run and 1Click marked it FAILED (recon R1). A double holds about 16 significant
// digits and a 24-decimal balance needs 24.
//
// Run: node --test tests/unit/swap-exact-amounts.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { privateKeyToAccount, signMessage } from 'viem/accounts';

import type { Rail, RailResult, SwapDraft, SwapSpend } from '../../src/types.ts';
import type { OneClickQuote, OneClickToken, TokensFile } from '../../src/intents.ts';
import { amountAsk, baseUnitsToDecimal, decimalToBaseUnits, parseStatus, toBaseUnits } from '../../src/intents.ts';
import { INTENTS_NATIVE_COUNTERPARTY, INTENTS_VERIFIER, erc191SignatureField, intentsNativeRail } from '../../src/rails/intents-native.ts';
import type { IntentsApiPort, IntentsQuoteParams } from '../../src/rails/intents-native.ts';
import { reasonOf } from '../../src/rails/reasons.ts';
import { makeCtx, railThat } from './helpers/proposals.ts';
import { makeHttp, serviceThatAnswers } from './helpers/http.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

// ---------- the numbers from the recon ----------

const HELD = 894697028778374732410224n; // intents.near mt_balance_of, block 216956065
const THE_DOUBLE = 0.8946970287783748; // what the wallet tool handed the agent
const THE_EXACT = '0.894697028778374732410224';

test('the recon arithmetic: the double scales 67,589,776 yocto above the balance, and the exact string does not', () => {
  assert.equal(toBaseUnits(THE_DOUBLE, 24), 894697028778374800000000n);
  assert.equal(toBaseUnits(THE_DOUBLE, 24) - HELD, 67_589_776n);
  assert.equal(decimalToBaseUnits(THE_EXACT, 24), HELD);
  assert.equal(baseUnitsToDecimal(HELD, 24), THE_EXACT);
});

test('amountAsk takes "all", an exact decimal, or a number through its shortest decimal, and nothing else', () => {
  assert.deepEqual(amountAsk('all'), { all: true });
  assert.deepEqual(amountAsk('ALL'), { all: true });
  assert.deepEqual(amountAsk(THE_EXACT), { all: false, text: THE_EXACT });
  assert.deepEqual(amountAsk(THE_DOUBLE), { all: false, text: '0.8946970287783748' });
  assert.deepEqual(amountAsk(1e-7), { all: false, text: '0.0000001' });
  for (const bad of ['0', '0.000', '-1', '+1', '1e5', '1E5', '0x10', '1,5', ' 1.5', '1.5 ', ' all', 'Infinity', 'NaN', '', 'half', '.5', '5.', 0, -2, Number.NaN, Infinity, null, {}, '9'.repeat(81)]) {
    assert.equal(amountAsk(bad), null, `${String(bad)} is not an amount`);
  }
});

test('decimalToBaseUnits cuts digits past the coin precision, never rounds up', () => {
  assert.equal(decimalToBaseUnits('1.0000009', 6), 1_000_000n);
  assert.equal(decimalToBaseUnits('1.9999999', 6), 1_999_999n);
  assert.equal(decimalToBaseUnits('12', 0), 12n);
  assert.equal(baseUnitsToDecimal(1_500_000n, 6), '1.5');
  assert.equal(baseUnitsToDecimal(0n, 6), '0');
  assert.throws(() => decimalToBaseUnits('1e3', 6), /plain decimal/);
});

// ---------- the 1Click rail, on the real 24-decimal balance ----------

const TEST_KEY = ('0x' + '33'.repeat(32)) as Hex;
const OWNER = privateKeyToAccount(TEST_KEY).address;
const WNEAR = 'nep141:wrap.near';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const HANDLE = '840ade2d6a0f3a5b8d9c4e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b59da';
const NOW = Date.parse('2026-09-23T20:20:00.000Z');

const LIST: OneClickToken[] = [
  { assetId: WNEAR, decimals: 24, blockchain: 'near', symbol: 'wNEAR', contractAddress: 'wrap.near' },
  { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' },
];
const NO_REGISTRY = { eth: {}, base: {}, arb: {}, sol: {}, near: {} } as TokensFile;

function swapDraft(over: Partial<SwapDraft> = {}): SwapDraft {
  return {
    kind: 'swap',
    venue: 'intents-native',
    chain: 'near',
    toChain: 'near',
    fromSymbol: 'wNEAR',
    toSymbol: 'USDC',
    amountIn: THE_DOUBLE,
    amountUsd: 3.9,
    minAmountOut: 3.8,
    from: OWNER,
    to: OWNER,
    counterparty: INTENTS_NATIVE_COUNTERPARTY,
    quote: null,
    ...over,
  };
}

// A venue that prices and generates exactly what it is asked for, as the live one did that day:
// the quote, generate-intent and the payload all agreed on the over-balance amount.
function venue() {
  const quotes: IntentsQuoteParams[] = [];
  const signed: string[] = [];
  let asked = '';
  const api: IntentsApiPort = {
    tokens: async () => LIST,
    async quote(params) {
      quotes.push(params);
      asked = params.amount;
      const quote = {
        amountIn: params.amount,
        amountInFormatted: '0.8947',
        amountInUsd: '3.90',
        minAmountIn: params.amount,
        amountOut: '3903775',
        amountOutFormatted: '3.903775',
        amountOutUsd: '3.89',
        minAmountOut: String((3_903_775n * BigInt(10_000 - (params.slippageToleranceBps ?? 100))) / 10_000n),
        timeEstimate: 12,
        depositAddress: HANDLE,
      } as OneClickQuote;
      const echo = {
        dry: params.dry,
        originAsset: params.originAsset,
        destinationAsset: params.destinationAsset,
        amount: params.amount,
        depositType: 'INTENTS',
        recipientType: 'INTENTS',
        recipient: OWNER.toLowerCase(),
        refundType: 'INTENTS',
        refundTo: OWNER.toLowerCase(),
      };
      const raw = signQuote({ quote, quoteRequest: echo });
      return { quote: raw['quote'] as OneClickQuote, raw };
    },
    async generateIntent() {
      return {
        standard: 'erc191',
        payload: JSON.stringify({
          signer_id: OWNER.toLowerCase(),
          verifying_contract: INTENTS_VERIFIER,
          deadline: new Date(NOW + 72 * 3600e3).toISOString(),
          nonce: 'Vij2xgAlKBKzwGNqwogWQxiy87p9jW5Omfg+L9bXBDw=',
          intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [WNEAR]: asked } }],
        }),
      };
    },
    async submitIntent() {
      return { intentHash: '9g9Swr3scn4mnfQD8RMCyV6zpeJNJsAiKxfEabFbUSQD' };
    },
    async status() {
      return parseStatus({ status: 'SUCCESS', swapDetails: {} });
    },
  };
  const rail = intentsNativeRail({
    keysPath: '/nonexistent/keys.json',
    quoteKey: TEST_QUOTE_KEY,
    tokens: NO_REGISTRY,
    api,
    signer: {
      address: () => OWNER,
      async signErc191(_keys, payload) {
        signed.push(payload);
        return erc191SignatureField(await signMessage({ privateKey: TEST_KEY, message: payload }));
      },
    },
    verifierBalance: async (_account, assetId) => (assetId === WNEAR ? HELD : 0n),
    now: () => NOW,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 5,
    settleSchedule: { firstMs: 1, maxMs: 1, timeoutMs: 2 },
  });
  return { rail, quotes, signed };
}

test('R1: a draft carrying the double of the whole balance is refused before anything is signed', async () => {
  const v = venue();
  await assert.rejects(
    () => v.rail.execute(swapDraft()),
    (err: unknown) => {
      assert.equal(reasonOf(err), 'insufficient_balance');
      assert.match(String((err as Error).message), /holds 0\.894697028778374732410224 wNEAR, less than the 0\.8946970287783748 wNEAR/);
      return true;
    },
  );
  assert.equal(v.signed.length, 0, 'a transfer larger than the balance was signed');
});

test('R1: the exact decimal is quoted, checked and signed to the last yocto', async () => {
  const v = venue();
  const out = await v.rail.execute(swapDraft({ amountInExact: THE_EXACT }));
  assert.equal(v.quotes.at(-1)?.amount, HELD.toString(), 'the live quote asked for exactly what is held');
  assert.equal(v.signed.length, 1);
  const payload = JSON.parse(v.signed[0]!) as { intents: Array<{ tokens: Record<string, string> }> };
  assert.equal(payload.intents[0]!.tokens[WNEAR], '894697028778374732410224');
  assert.notEqual(out.reason, 'insufficient_balance', out.detail);
});

test('the rail names what a draft spends and how much of it is held, for "all" to become exact', async () => {
  const v = venue();
  const spent = await v.rail.spend?.(swapDraft());
  assert.deepEqual(spent, { assetId: WNEAR, decimals: 24, heldBase: HELD });
  assert.equal(v.quotes.length, 0, 'reading the balance asks for no price');
});

// ---------- the builder ----------

// A swap rail that holds `held` of a 24-decimal coin, prices 4.4 USDC for anything, and records
// the draft it would run.
function holdingRail(held: bigint | null): { rail: Rail; drafts: SwapDraft[]; quoted: () => number } {
  const drafts: SwapDraft[] = [];
  let quoted = 0;
  const base = railThat('swap', async (draft): Promise<RailResult> => {
    drafts.push(draft as SwapDraft);
    return { ok: true, detail: 'swapped', txids: ['h'] };
  });
  const rail: Rail = {
    ...base,
    async spend(): Promise<SwapSpend> {
      return { assetId: WNEAR, decimals: 24, heldBase: held };
    },
    async quote() {
      quoted += 1;
      return 4.4;
    },
    async simulate() {
      return { ok: true, summary: 'priced', swap: { receives: '4.4', receivesAtLeast: '4.356', feeUsd: 0.01, etaSeconds: 12 } };
    },
  };
  return { rail, drafts, quoted: () => quoted };
}

test('"all" becomes the exact raw balance on the draft, and the floor is priced for exactly that', async () => {
  const r = holdingRail(HELD);
  const h = makeCtx({ rails: [r.rail] });
  const p = await h.svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: 'all' });
  assert.ok(p.draft.kind === 'swap');
  assert.equal(p.draft.amountInExact, THE_EXACT);
  assert.equal(p.draft.amountIn, Number(THE_EXACT));
  assert.equal(p.draft.minAmountOut, 4.356, 'one percent under the quote');
  assert.equal(r.quoted(), 1);
});

test('an exact amount above the balance is refused as insufficient_balance before any price is asked for', async () => {
  const r = holdingRail(HELD);
  const h = makeCtx({ rails: [r.rail] });
  const p = await h.svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: '0.9' });
  assert.equal(p.status, 'policy_refused');
  assert.deepEqual(p.verdict.reasonCodes, ['insufficient_balance']);
  assert.match(p.verdict.reasons.at(-1) ?? '', /holds 0\.894697028778374732410224 wNEAR, less than the 0\.9/);
  assert.equal(r.quoted(), 0, 'a price was asked for a swap that cannot run');
  const view = h.svc.view(p);
  assert.equal(view.reason?.code, 'insufficient_balance');
  assert.equal(view.reason?.sentence, "You don't have that much NEAR, so nothing moved. Check your balance, or ask to swap all of it.");
  assert.doesNotMatch(view.stageCopy, /rule you set/);
});

test('a number is read through its shortest decimal: the double of the balance is more than is held, and says so', async () => {
  const r = holdingRail(HELD);
  const h = makeCtx({ rails: [r.rail] });
  const p = await h.svc.proposeSwap({ chain: 'near', fromSymbol: 'wNEAR', toSymbol: 'USDC', amountIn: THE_DOUBLE });
  assert.equal(p.status, 'policy_refused');
  assert.deepEqual(p.verdict.reasonCodes, ['insufficient_balance']);
});

test('an amount inside the balance is cut to the coin precision and filed exactly', async () => {
  const r = holdingRail(HELD);
  const h = makeCtx({ rails: [r.rail] });
  const p = await h.svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: '0.5000000000000000000000019' });
  assert.ok(p.draft.kind === 'swap');
  assert.equal(p.draft.amountInExact, '0.500000000000000000000001');
  assert.notEqual(p.status, 'policy_refused', JSON.stringify(p.verdict));
});

test('"all" over an unread balance, or an empty one, is refused with the cause', async () => {
  const unread = makeCtx({ rails: [holdingRail(null).rail] });
  const p1 = await unread.svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: 'all' });
  assert.deepEqual(p1.verdict.reasonCodes, ['balance_unread']);

  const empty = makeCtx({ rails: [holdingRail(0n).rail] });
  const p2 = await empty.svc.proposeSwap({ chain: 'near', fromSymbol: 'NEAR', toSymbol: 'USDC', amountIn: 'all' });
  assert.deepEqual(p2.verdict.reasonCodes, ['insufficient_balance']);
});

// ---------- the door ----------

test('the swap door takes "all", an exact decimal and any chain the venue lists, and names anything else', async () => {
  const h = makeHttp({ proposals: serviceThatAnswers({ id: 'p1', kind: 'swap', status: 'pending', createdAt: new Date().toISOString(), draft: swapDraft(), simulation: null, verdict: { outcome: 'needs_approval', reasons: [] } }) });
  for (const amountIn of ['all', THE_EXACT, 1.5]) {
    const ok = await h.post('swap', { chain: 'near', toChain: 'btc', fromSymbol: 'wNEAR', toSymbol: 'BTC', amountIn });
    assert.equal(ok.status, 200, `${String(amountIn)}: ${JSON.stringify(ok.json)}`);
  }
  const id = await h.post('swap', { chain: 'near', toChain: 'eth', fromSymbol: 'USDC', toSymbol: 'nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near', amountIn: '1' });
  assert.equal(id.status, 200, 'an asset id fits the symbol field: ' + JSON.stringify(id.json));
  const junk = await h.post('swap', { chain: 'near', fromSymbol: 'wNEAR', toSymbol: 'USDC', amountIn: '1e3' });
  assert.equal(junk.status, 400);
  assert.match(String(junk.json.error), /amountIn must be "all" or an exact amount/);
  const nowhere = await h.post('swap', { chain: 'near', toChain: 'atlantis', fromSymbol: 'wNEAR', toSymbol: 'USDC', amountIn: '1' });
  assert.equal(nowhere.status, 400);
  assert.match(String(nowhere.json.error), /toChain must be a chain id the deposit card offers/);
});
