import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';

import type { HlDepositDraft } from '../../src/types.ts';
import type { OneClickQuote, OneClickStatus, OneClickToken } from '../../src/intents.ts';
import type { IntentsApiPort, IntentsQuoteParams, IntentsSignerPort } from '../../src/rails/intents-native.ts';
import { INTENTS_VERIFIER } from '../../src/rails/intents-native.ts';
import type { HlSignPort, HlUserSignedDeps } from '../../src/rails/hl-user-signed.ts';
import {
  HYPERCORE_COUNTERPARTY,
  HYPERCORE_FEE_BPS,
  HYPERCORE_FLAT_FEE_USDC,
  HYPERCORE_SLIPPAGE_BPS,
  HYPERCORE_USDC_ASSET_ID,
  HYPERCORE_USDC_DECIMALS,
  HYPERCORE_VENUE_MIN_CREDIT_USDC,
  MAX_FEE_PCT,
  MIN_DEPOSIT_USDC,
  hypercoreDepositRail,
  minCreditedFor,
} from '../../src/rails/hypercore-deposit.ts';
import type { HypercoreDepositDeps } from '../../src/rails/hypercore-deposit.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

// The rail that funds the trading account from the intents balance. What it signs is one
// erc191 transfer of our balance to the deposit handle of the quote it just checked; what it
// never does is touch a chain. The tests pin the refusals (every one before the key), the
// echo binding, the floor against the measured fee, and the settle step on both account shapes.

const SELF = '0x2222222222222222222222222222222222222222' as Address;
const ACCOUNT = SELF.toLowerCase();
const STRANGER = '0x3333333333333333333333333333333333333333';
const HANDLE = '81aee1ec126b2b0f041fe080b2195d4ff63c88c13f23da1859b4b6f203cb885a';
const KEYS = '/nowhere/keys.json';

const ETH_USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const AMOUNT = 10;
const AMOUNT_BASE = 10_000_000n;
const NOW = Date.parse('2026-09-11T22:00:00.000Z');
const DEADLINE = '2026-09-14T22:00:00.000Z';

function draft(over: Partial<HlDepositDraft> = {}): HlDepositDraft {
  return {
    kind: 'hl_deposit',
    symbol: 'USDC',
    originAsset: ETH_USDC,
    amount: AMOUNT,
    amountUsd: AMOUNT,
    minCredited: minCreditedFor(AMOUNT),
    from: ACCOUNT,
    hlAccount: SELF,
    counterparty: HYPERCORE_COUNTERPARTY,
    ...over,
  };
}

// The live numbers from 2026-09-11 for 10 USDC of the eth flavor into HyperCore: 9.6594 out.
function quoteOf(over: Partial<OneClickQuote> = {}): OneClickQuote {
  return {
    depositAddress: HANDLE,
    amountIn: AMOUNT_BASE.toString(),
    amountInFormatted: '10.0',
    amountInUsd: '10.0',
    minAmountIn: AMOUNT_BASE.toString(),
    amountOut: '965940000',
    amountOutFormatted: '9.6594',
    amountOutUsd: '9.6594',
    minAmountOut: '964974060',
    timeEstimate: 20,
    refundFee: '0',
    withdrawFee: '31530000',
    ...over,
  };
}

function echoOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: HYPERCORE_SLIPPAGE_BPS,
    originAsset: ETH_USDC,
    destinationAsset: HYPERCORE_USDC_ASSET_ID,
    amount: AMOUNT_BASE.toString(),
    depositType: 'INTENTS',
    refundTo: ACCOUNT,
    refundType: 'INTENTS',
    recipient: SELF,
    recipientType: 'DESTINATION_CHAIN',
    ...over,
  };
}

function payloadOf(): string {
  return JSON.stringify({
    verifying_contract: 'intents.near',
    signer_id: ACCOUNT,
    deadline: DEADLINE,
    nonce: 'Vij2xgAlKBKzwEtQGN8wzBgg5wAN1h+JO1SSpSw/VVo=',
    intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [ETH_USDC]: AMOUNT_BASE.toString() } }],
  });
}

type ApiOverrides = {
  quote?: Partial<OneClickQuote>;
  echo?: Record<string, unknown> | null;
  status?: OneClickStatus['status'];
  refundedAmount?: string;
  refundReason?: string;
  settledAmountOut?: string;
  nearTxHashes?: string[];
  statusThrows?: boolean;
  submitThrows?: boolean;
  assetMissing?: boolean;
  assetDecimals?: number;
  originMissing?: boolean;
  // Applied to the quote response AFTER it is signed: what a proxy between this app and the
  // API would do to it. Left out, the response arrives as signed.
  tamper?: (signed: Record<string, unknown>) => Record<string, unknown>;
};

type ApiCalls = { quotes: IntentsQuoteParams[]; generated: unknown[]; signed: string[]; submitted: unknown[] };

function fakeApi(over: ApiOverrides = {}): { api: IntentsApiPort; signer: IntentsSignerPort; calls: ApiCalls } {
  const calls: ApiCalls = { quotes: [], generated: [], signed: [], submitted: [] };
  const list: OneClickToken[] = [
    ...(over.originMissing ? [] : [{ assetId: ETH_USDC, decimals: 6, blockchain: 'eth', symbol: 'USDC' }]),
    ...(over.assetMissing
      ? [{ assetId: '1cs_v1:hypercore:erc20:0xdead', decimals: 6, blockchain: 'hypercore', symbol: 'USDC' }]
      : [{ assetId: HYPERCORE_USDC_ASSET_ID, decimals: over.assetDecimals ?? HYPERCORE_USDC_DECIMALS, blockchain: 'hypercore', symbol: 'USDC' }]),
  ];
  const api: IntentsApiPort = {
    tokens: async () => list,
    async quote(params) {
      calls.quotes.push(params);
      const unsigned: Record<string, unknown> = { quote: quoteOf(over.quote) };
      if (over.echo !== null) unsigned['quoteRequest'] = echoOf({ dry: params.dry, ...(over.echo ?? {}) });
      // Signed the way 1Click signs its answers, over the whole payload, quote included.
      const signed = signQuote(unsigned);
      const raw = over.tamper === undefined ? signed : over.tamper(signed);
      return { quote: raw['quote'] as OneClickQuote, raw };
    },
    async generateIntent(params) {
      calls.generated.push(params);
      return { standard: 'erc191', payload: payloadOf() };
    },
    async submitIntent(signed) {
      if (over.submitThrows) throw new Error('submit-intent timed out after 30s');
      calls.submitted.push(signed);
      return { intentHash: 'HASH1', correlationId: 'c1' };
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
  const signer: IntentsSignerPort = {
    address: () => SELF,
    async signErc191(_keysPath, payload) {
      calls.signed.push(payload);
      return 'SIG';
    },
  };
  return { api, signer, calls };
}

// Hyperliquid /info and /exchange, driven by what each test wants the account to look like
// before and after. Each accountSummary makes three reads; the shape advances after the spot one.
type AccountShape = { perp: number; spot: number; unifiedAvailable?: number };

// `failReadsAfter`: the summary read that starts failing, counted from the first (0 is the
// read before the deposit). A venue that stops answering after the money moved.
type HlOverrides = { failReadsAfter?: number; transferRefused?: boolean };

function fakeHl(shapes: AccountShape[], over: HlOverrides = {}): { hl: HlUserSignedDeps; calls: string[]; exchange: any[] } {
  const calls: string[] = [];
  const exchange: any[] = [];
  let reads = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url).endsWith('/exchange')) {
      exchange.push(body);
      return new Response(
        JSON.stringify(over.transferRefused ? { status: 'err', response: 'Insufficient balance for token transfer' } : { status: 'ok', response: { type: 'default' } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    calls.push(String(body.type));
    if (over.failReadsAfter !== undefined && reads >= over.failReadsAfter && body.type === 'clearinghouseState') {
      throw new Error('info endpoint down');
    }
    const shape = shapes[Math.min(reads, shapes.length - 1)] ?? { perp: 0, spot: 0 };
    if (body.type === 'clearinghouseState') {
      return new Response(
        JSON.stringify({ marginSummary: { accountValue: String(shape.perp), totalMarginUsed: '0' }, withdrawable: String(shape.perp), assetPositions: [] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (body.type === 'userAbstraction') {
      return new Response(JSON.stringify(shape.unifiedAvailable !== undefined ? 'unifiedAccount' : 'standard'), { headers: { 'content-type': 'application/json' } });
    }
    reads += 1;
    return new Response(
      JSON.stringify({
        balances: [{ coin: 'USDC', token: 0, total: String(shape.spot), hold: '0' }],
        ...(shape.unifiedAvailable !== undefined ? { tokenToAvailableAfterMaintenance: [[0, String(shape.unifiedAvailable)]] } : {}),
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const sign: HlSignPort = {
    address: () => SELF,
    signTypedData: async () => ({ r: `0x${'1'.repeat(64)}`, s: `0x${'2'.repeat(64)}`, v: 27 }),
  };
  return { hl: { keysPath: KEYS, fetchImpl, sign, now: () => NOW }, calls, exchange };
}

function rail(apiOver: ApiOverrides = {}, shapes: AccountShape[] = [{ perp: 0, spot: 0, unifiedAvailable: 0 }], over: Partial<HypercoreDepositDeps> = {}, hlOver: HlOverrides = {}) {
  const { api, signer, calls } = fakeApi(apiOver);
  const hl = fakeHl(shapes, hlOver);
  const r = hypercoreDepositRail({
    keysPath: KEYS,
    api,
    signer,
    hl: hl.hl,
    now: () => NOW,
    sleep: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 3,
    quoteKey: TEST_QUOTE_KEY,
    ...over,
  });
  return { rail: r, calls, hlCalls: hl.calls, exchange: hl.exchange };
}

// ---------- the shape refusals, before any quote ----------

test('a counterparty that is not the verifier is refused', async () => {
  const { rail: r, calls } = rail();
  const out = await r.simulate(draft({ counterparty: 'oneclick:1click.chaindefuser.com' }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /counterparty/);
  assert.equal(calls.quotes.length, 0);
});

test('a trading account that is not an EVM address is refused, because HyperCore credits one', async () => {
  const { rail: r, calls } = rail();
  const out = await r.simulate(draft({ hlAccount: 'phosphor.near' }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /not an EVM address/);
  assert.equal(calls.quotes.length, 0);
});

test('below the floor the refusal names the venue minimum and the flat fee that sets the floor above it', async () => {
  const { rail: r, calls } = rail();
  for (const amount of [3, 5, 5.99]) {
    const out = await r.simulate(draft({ amount, amountUsd: amount, minCredited: minCreditedFor(amount) }));
    assert.equal(out.ok, false, `${amount} was accepted`);
    assert.match(out.summary, new RegExp(`below the ${MIN_DEPOSIT_USDC} USDC floor`));
    assert.match(out.summary, new RegExp(`Hyperliquid does not credit a deposit under ${HYPERCORE_VENUE_MIN_CREDIT_USDC} USDC, it is lost`));
    assert.match(out.summary, new RegExp(`${MIN_DEPOSIT_USDC} in is what guarantees ${HYPERCORE_VENUE_MIN_CREDIT_USDC} lands`));
    assert.match(out.summary, /flat/);
  }
  assert.equal(calls.quotes.length, 0);
});

// ---------- the venue's own floor: under 5 USDC delivered, Hyperliquid credits nothing ----------

// Docs: "The minimum deposit amount is 5 USDC. If you send an amount less than this, it will
// not be credited and be lost forever." 1Click quotes a 3 USDC deposit without a word, so the
// app is the one that refuses, at draft time and again against the quote's guarantee.
test('the venue floor is 5 USDC delivered, and the size floor of 7 puts 5 on the ground after the fee and keeps the fee under the ceiling', () => {
  assert.equal(HYPERCORE_VENUE_MIN_CREDIT_USDC, 5);
  assert.equal(MIN_DEPOSIT_USDC, 7);
  assert.ok(minCreditedFor(MIN_DEPOSIT_USDC) >= HYPERCORE_VENUE_MIN_CREDIT_USDC, `${minCreditedFor(MIN_DEPOSIT_USDC)} guaranteed at the floor is under the venue's 5`);
  assert.ok(minCreditedFor(5) < HYPERCORE_VENUE_MIN_CREDIT_USDC, 'a 5 USDC deposit would be refused for its size, not only for its guarantee');
  // That the measured fee at 7 sits under the ceiling is pinned in tests/unit/trade-collateral.test.ts,
  // beside the cost model that reproduces the live quotes.
});

test('a draft whose own guarantee is under 5 USDC landing is refused before any quote, and the sentence says the money is lost', async () => {
  const { rail: r, calls } = rail();
  const out = await r.simulate(draft({ amount: 7, amountUsd: 7, minCredited: 4.9 }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /would guarantee only 4\.9000 USDC landing; Hyperliquid does not credit a deposit under 5 USDC, it is lost/);
  assert.equal(calls.quotes.length, 0);
  const fine = await r.simulate(draft({ amount: 7, amountUsd: 7, minCredited: minCreditedFor(7) }));
  assert.equal(calls.quotes.length, 1, 'an honest 7 USDC draft was refused before the quote');
  assert.doesNotMatch(fine.summary, /does not credit/, 'the venue floor spoke about a draft that clears it');
});

test('a quote guaranteeing under 5 USDC delivered is refused first, whatever the draft floor says, and 5 exactly passes that gate', async () => {
  // The default draft is 10 in, floored at 9.51, so a 4.99999999 guarantee fails both floors;
  // the venue's is the one named, because it is the one that loses everything.
  const { rail: under } = rail({ quote: { amountOutFormatted: '5.2', amountOut: '520000000', minAmountOut: '499999999' } });
  const lost = await under.simulate(draft());
  assert.equal(lost.ok, false);
  assert.match(lost.summary, /guarantees only 4\.99999999 USDC landing; Hyperliquid does not credit a deposit under 5 USDC, it is lost/);
  assert.doesNotMatch(lost.summary, /approved draft floors at/, 'the draft floor spoke before the venue floor');

  const { rail: at } = rail({ quote: { amountOutFormatted: '5.2', amountOut: '520000000', minAmountOut: '500000000' } });
  const short = await at.simulate(draft());
  assert.equal(short.ok, false);
  assert.doesNotMatch(short.summary, /does not credit/, 'a guarantee of exactly 5 tripped the venue gate');
  assert.match(short.summary, /approved draft floors at/);
});

test('a draft spending an intents account that is not ours is refused', async () => {
  const { rail: r, calls } = rail();
  const out = await r.simulate(draft({ from: STRANGER }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /configured key/);
  assert.equal(calls.quotes.length, 0);
});

test('a draft crediting a Hyperliquid account that is not the signer is refused', async () => {
  const { rail: r, calls } = rail();
  const out = await r.simulate(draft({ hlAccount: STRANGER }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /not the account this app signs for/);
  assert.equal(calls.quotes.length, 0);
});

// ---------- the pin ----------

test('a quote refuses when the pin is gone, and the rail never takes a replacement id', async () => {
  const { rail: r, calls } = rail({ assetMissing: true });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /no longer in the 1Click token list/);
  assert.match(out.summary, /0xdead/); // the live ids are named so a human can update the pin
  assert.equal(calls.quotes.length, 0);
});

test('a pin whose decimals changed refuses, because every amount would be wrong by a power of ten', async () => {
  const { rail: r } = rail({ assetDecimals: 6 });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /decimals changed/);
});

test('an origin asset 1Click no longer lists is refused before any quote', async () => {
  const { rail: r, calls } = rail({ originMissing: true });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /does not list/);
  assert.equal(calls.quotes.length, 0);
});

test('the pinned asset is the documented two-way HyperCore USDC id at 8 decimals', () => {
  assert.equal(HYPERCORE_USDC_ASSET_ID, '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054');
  assert.equal(HYPERCORE_USDC_DECIMALS, 8);
});

// ---------- simulate ----------

test('simulate prices with dry:true from the intents balance to the pinned asset, crediting our account', async () => {
  const { rail: r, calls } = rail();
  const out = await r.simulate(draft());
  assert.equal(out.ok, true, out.summary);
  assert.equal(calls.quotes.length, 1);
  const q = calls.quotes[0];
  assert.equal(q.dry, true);
  assert.equal(q.originAsset, ETH_USDC);
  assert.equal(q.destinationAsset, HYPERCORE_USDC_ASSET_ID);
  assert.equal(q.amount, AMOUNT_BASE.toString());
  assert.equal(q.account, ACCOUNT);
  assert.equal(q.recipient, SELF);
  assert.equal(q.recipientType, 'DESTINATION_CHAIN');
  assert.equal(q.slippageToleranceBps, HYPERCORE_SLIPPAGE_BPS);
  assert.equal(calls.generated.length, 0, 'a simulation never asks for an intent');
});

test('the summary states the effective rate and says the intents balance is the source', async () => {
  const { rail: r } = rail();
  const out = await r.simulate(draft());
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /3\.41 percent/);
  assert.match(out.summary, /0\.3406 USDC/);
  assert.match(out.summary, /intents balance/);
  assert.match(out.summary, /9\.6594 USDC/);
  assert.doesNotMatch(out.summary, /withdraw3/);
});

// ---------- the fee facts on the card (criteria 1.10, 8.1, 8.7) ----------

test('the simulation carries the fee facts the card draws: the total, the app fee off the echo, the draft floor as "at least"', async () => {
  const { rail: r } = rail({ echo: { appFees: [{ recipient: 'app.near', fee: 25 }] } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, true, out.summary);
  const facts = out.send;
  assert.ok(facts !== undefined, 'the send facts are on the simulation');
  // 10 in, 9.6594 credited: 0.3406 inside the quote, of which 25 bp of 10 is 0.025.
  assert.equal(facts.feeUsd, 0.3406);
  assert.equal(facts.arrives, '9.6594');
  assert.equal(facts.arrivesAtLeast, String(minCreditedFor(AMOUNT)));
  assert.equal(facts.destinationAsset, HYPERCORE_USDC_ASSET_ID);
  assert.equal(facts.etaSeconds, 20);
  assert.match(facts.activity, /25 bp app fee \(0\.025 USDC\)/);
  assert.match(facts.activity, /at least 9\.51 USDC has to land/);
  assert.match(out.summary, /app fee   0\.0250 USDC, 25 bp, inside the quote/);
  assert.match(out.summary, /routing   0\.3156 USDC inside the quote/);
  assert.match(out.summary, /at least  9\.51 USDC, the floor the live quote is held to; under 5 the venue keeps it/);
});

// "Deposit seen" inside 30 s of the submit (criterion 8.3): the first status read happens the
// moment the submit answers, before the poll sleeps at all, and the word 1Click answers with
// reaches the executor on that read. At the live 3 s interval every later read is 3 s apart.
test('the first status read follows the submit with no sleep in between, so the router\'s first word reaches the card at once', async () => {
  const events: string[] = [];
  const { rail: r } = rail({ status: 'KNOWN_DEPOSIT_TX' }, undefined, {
    sleep: async () => {
      events.push('sleep');
    },
    pollIntervalMs: 3000,
    pollTimeoutMs: 6000,
  });
  const out = await r.execute(draft(), 'p_seen', {
    onEvidence: (e) => {
      if (e.txids !== undefined && e.providerStage === undefined) events.push('hash');
      if (e.providerStage !== undefined) events.push(`stage:${e.providerStage}`);
    },
  });
  assert.equal(out.ok, false, 'a watch that never leaves KNOWN_DEPOSIT_TX is unconfirmed');
  assert.match(out.detail, /IS SIGNED AND SUBMITTED/);
  const firstWord = events.indexOf('stage:KNOWN_DEPOSIT_TX');
  const firstSleep = events.indexOf('sleep');
  assert.ok(firstWord >= 0, `the router's word reached the executor: ${events.join(',')}`);
  assert.ok(events.indexOf('hash') < firstWord, 'the hash landed before the first word');
  assert.ok(firstSleep === -1 || firstWord < firstSleep, `the first read came before the first sleep: ${events.join(',')}`);
});

test('a quote that asks for a deposit memo is refused before anything is signed, with the floor named', async () => {
  const { rail: r, calls } = rail({ quote: { depositMemo: 'needs-a-memo' } });
  const dry = await r.simulate(draft());
  assert.equal(dry.ok, false);
  assert.match(dry.summary, /deposit memo/);
  assert.match(dry.summary, /floor stays 9\.5100 USDC landing/);
  const live = await r.execute(draft());
  assert.equal(live.ok, false);
  assert.match(live.detail, /deposit memo/);
  assert.match(live.detail, /Nothing was signed/);
  assert.equal(calls.signed.length, 0, 'the key was never touched');
  assert.equal(calls.generated.length, 0, 'no intent was generated');
});

test('a quote whose cost exceeds the ceiling is refused, and the refusal says to deposit more', async () => {
  const { rail: r } = rail({ quote: { amountOutFormatted: '9.0', amountOut: '900000000', minAmountOut: '899000000' } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, new RegExp(`above the ${MAX_FEE_PCT} percent ceiling`));
  assert.match(out.summary, /depositing more at once/);
});

test('a quote that credits less than the approved floor is refused', async () => {
  const { rail: r } = rail({ quote: { amountOutFormatted: '9.5', amountOut: '950000000', minAmountOut: '949000000' } });
  const out = await r.simulate(draft({ minCredited: 9.6 }));
  assert.equal(out.ok, false);
  assert.match(out.summary, /required at least 9\.6/);
});

test('a quote whose guaranteed floor is below minCredited is refused even when its expected output clears it', async () => {
  const { rail: r } = rail({ quote: { minAmountOut: '900000000' } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /guarantees only 9 USDC/);
});

test('a quote priced against a different amount than the draft is refused', async () => {
  const { rail: r } = rail({ quote: { amountInFormatted: '11.0' } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /prices 11\.0 in, but the draft says 10/);
});

test('a quote that echoes a different Hyperliquid account is refused', async () => {
  const { rail: r } = rail({ echo: { recipient: STRANGER } });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /credit/);
  assert.match(out.summary, /0x3333/);
});

test('a quote with no echo at all is refused rather than trusted', async () => {
  const { rail: r } = rail({ echo: null });
  const out = await r.simulate(draft());
  assert.equal(out.ok, false);
  assert.match(out.summary, /nothing tying/);
});

// ---------- execute ----------

test('execute signs one intent to the quote handle, submits it, and reports the credit with evidence', async () => {
  const { rail: r, calls } = rail({}, [{ perp: 0, spot: 0, unifiedAvailable: 0.001 }, { perp: 0, spot: 9.6604, unifiedAvailable: 9.6604 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);

  const live = calls.quotes.filter((q) => !q.dry);
  assert.equal(live.length, 1);
  assert.equal(live[0].recipient, SELF);
  assert.deepEqual(calls.generated, [{ signerId: ACCOUNT, depositAddress: HANDLE }]);
  assert.equal(calls.signed.length, 1);
  assert.deepEqual(calls.submitted, [{ payload: payloadOf(), signature: 'SIG' }]);

  assert.match(out.detail, /9\.6594 USDC/);
  assert.match(out.detail, /intent HASH1/);
  assert.match(out.detail, /unified/);
  assert.match(out.detail, /rose by 9\.6594/);
  assert.deepEqual(out.txids, ['HASH1', '0xdest']);
});

test('a success reports the amount 1Click settled, not the quote, and keeps the NEAR settlement hash', async () => {
  const { rail: r } = rail({ settledAmountOut: '9.6412', nearTxHashes: ['nearSettle'] }, [{ perp: 0, spot: 0, unifiedAvailable: 0 }, { perp: 0, spot: 9.6412, unifiedAvailable: 9.6412 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /funded Hyperliquid with 9\.6412 USDC/);
  assert.doesNotMatch(out.detail, /9\.6594/);
  assert.doesNotMatch(out.detail, /quoted/);
  assert.equal(out.evidence?.settledAmountOut, '9.6412');
  assert.equal(out.evidence?.handle, HANDLE);
  assert.deepEqual(out.txids, ['HASH1', '0xdest', 'nearSettle']);
});

test('a success without a settled amount says the figure is quoted', async () => {
  const { rail: r } = rail({}, [{ perp: 0, spot: 0, unifiedAvailable: 0 }, { perp: 0, spot: 9.66, unifiedAvailable: 9.66 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /a quoted 9\.6594 USDC/);
  assert.equal(out.evidence?.settledAmountOut, undefined);
});

test('the echo is checked again at execute, before anything is signed', async () => {
  const { rail: r, calls } = rail({ echo: { recipient: STRANGER } });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /Nothing was signed/);
  assert.equal(calls.signed.length, 0);
});

test('a refund is reported back into the verifier with the amount the API named, never as a success', async () => {
  const { rail: r } = rail({ status: 'REFUNDED', refundedAmount: '9.97' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /REFUNDED/);
  assert.match(out.detail, new RegExp(`9\\.97 USDC went back to ${ACCOUNT} inside ${INTENTS_VERIFIER}`));
  assert.deepEqual(out.txids, ['HASH1', '0xdest']);
  assert.equal(out.evidence?.handle, HANDLE);
  assert.equal(out.evidence?.refundedAmount, '9.97');
});

test('a FAILED order with nothing refunded says the input is held by 1Click, and never that a refund is credited', async () => {
  // The incident of 2026-09-15: two $10 deposits FAILED at 1Click with refundedAmount 0, and
  // the rail said the refund was back in the balance. It was not; the money sat at 1Click.
  const { rail: r } = rail({ status: 'FAILED', refundedAmount: '0' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /1click reported FAILED and refunded 0 USDC so far/);
  assert.match(out.detail, new RegExp(`held by 1Click under handle ${HANDLE}`));
  assert.match(out.detail, /reason not given/);
  assert.match(out.detail, /Nothing is back in your balance/);
  assert.doesNotMatch(out.detail, /refund is credited/);
  assert.deepEqual(out.txids, ['HASH1', '0xdest']);
  assert.equal(out.evidence?.handle, HANDLE);
  assert.equal(out.evidence?.refundedAmount, '0');
});

test('a FAILED order names the reason and the partial refund the API gave', async () => {
  const { rail: r } = rail({ status: 'FAILED', refundedAmount: '4.5', refundReason: 'PARTIAL_DEPOSIT' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /refunded 4\.5 USDC so far/);
  assert.match(out.detail, /reason PARTIAL_DEPOSIT/);
  assert.doesNotMatch(out.detail, /Nothing is back/);
  assert.equal(out.evidence?.refundedAmount, '4.5');
  assert.equal(out.evidence?.refundReason, 'PARTIAL_DEPOSIT');
});

test('a submit that throws after the signature says the intent was signed and names the handle, never nothing signed', async () => {
  const { rail: r, calls } = rail({ submitThrows: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.equal(calls.signed.length, 1, 'the key was used');
  assert.match(out.detail, /signed/);
  assert.match(out.detail, /unconfirmed/);
  assert.match(out.detail, new RegExp(HANDLE));
  assert.match(out.detail, new RegExp(DEADLINE));
  assert.doesNotMatch(out.detail, /Nothing was signed/);
  assert.deepEqual(out.txids, []);
  assert.equal(out.evidence?.handle, HANDLE);
  assert.equal(out.evidence?.deadline, DEADLINE);
});

test('the executor hears the handle before the submit and the hash before the wait', async () => {
  const { rail: r } = rail({}, [{ perp: 0, spot: 0, unifiedAvailable: 0 }, { perp: 0, spot: 9.66, unifiedAvailable: 9.66 }]);
  const heard: Array<{ txids?: string[]; handle?: string; deadline?: string }> = [];
  const out = await r.execute(draft(), 'p1', { onEvidence: (e) => heard.push(e) });
  assert.equal(out.ok, true, out.detail);
  // The signed quote rides on both, so a row that dies inside the wait still has what 1Click signed.
  const { quote: signedQuote, ...rest } = heard[0] as { quote?: unknown; handle?: string; deadline?: string };
  assert.deepEqual(rest, { handle: HANDLE, deadline: DEADLINE });
  assert.equal((signedQuote as { depositAddress?: string } | undefined)?.depositAddress, HANDLE);
  assert.deepEqual(heard[1].txids, ['HASH1']);
  assert.equal(heard[1].handle, HANDLE);
});

test('a poll that never reaches terminal says the intent IS SIGNED AND SUBMITTED, in capitals', async () => {
  const { rail: r } = rail({ statusThrows: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /THE INTENT IS SIGNED AND SUBMITTED/);
  assert.match(out.detail, /HASH1/);
});

test('a watch that runs out is unconfirmed and keeps the hash and the handle for a later check', async () => {
  const { rail: r } = rail({ status: 'PROCESSING' });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /unconfirmed/);
  assert.ok(out.txids?.includes('HASH1'));
  assert.equal(out.evidence?.handle, HANDLE);
});

test('collateral that lands on the spot book of a standard account is moved to perp, and the detail says so', async () => {
  const { rail: r, exchange } = rail({}, [{ perp: 0, spot: 0 }, { perp: 0, spot: 9.6594 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /moved to perp/);
  assert.equal(exchange.length, 1);
  assert.equal(exchange[0].action.type, 'usdClassTransfer');
  assert.equal(exchange[0].action.toPerp, true);
  assert.equal(exchange[0].action.amount, '9.6594');
});

test('a unified account is not asked to move money between books that do not exist', async () => {
  const { rail: r, exchange } = rail({}, [{ perp: 0, spot: 0, unifiedAvailable: 0 }, { perp: 0, spot: 9.6594, unifiedAvailable: 9.6594 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /margin already/);
  assert.equal(exchange.length, 0);
});

// ---------- the read-back after SUCCESS, which is a loop now ----------
//
// A credit to HyperCore crosses a bridge after 1Click says SUCCESS, so one read taken right
// then saw the account from before the deposit. The rail reads until the account shows the
// floor, up to two minutes; a rise under the floor after that is the short fill; no rise is
// settling, a third answer beside ok and failed, and never the word failed.

const SHORT_SETTLE = { firstMs: 1, maxMs: 2, timeoutMs: 6 };

test('a credit the venue has not shown yet is settling, not a loss and not a success', async () => {
  const { rail: r, calls, hlCalls } = rail({}, [{ perp: 0, spot: 0 }, { perp: 0, spot: 0 }], { settleSchedule: SHORT_SETTLE });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.equal(out.settling, true, 'needs_reconciliation, for the executor to land it as');
  assert.match(out.detail, /The solver reports the swap settled and the balance has not shown it yet/);
  assert.match(out.detail, /Nothing more will be signed until the next balance read confirms it/);
  assert.match(out.detail, /intent HASH1/);
  assert.doesNotMatch(out.detail, /fail/i);
  assert.equal(calls.signed.length, 1, 'signed exactly once');
  assert.equal(calls.submitted.length, 1);
  assert.ok(hlCalls.filter((t) => t === 'spotClearinghouseState').length > 3, 'the account was re-read through the window');
  assert.deepEqual(out.txids, ['HASH1', '0xdest']);
  assert.equal(out.evidence?.handle, HANDLE, 'the handle rides on a settling row for the re-check');
  assert.equal(out.pocket?.venue, 'hyperliquid');
  assert.equal(out.pocket?.before, '0');
  assert.equal(out.pocket?.after, '0');
  assert.equal(out.pocket?.decimals, HYPERCORE_USDC_DECIMALS);
});

test('an account that cannot be read after the deposit is settling, never "the deposit itself completed"', async () => {
  const { rail: r } = rail({}, [{ perp: 0, spot: 0, unifiedAvailable: 0 }], { settleSchedule: SHORT_SETTLE }, { failReadsAfter: 1 });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.equal(out.settling, true);
  assert.match(out.detail, /unconfirmed/);
  assert.doesNotMatch(out.detail, /the deposit itself completed/);
  assert.deepEqual(out.txids, ['HASH1', '0xdest']);
  assert.equal(out.evidence?.handle, HANDLE);
  assert.equal(out.pocket?.after, null, 'no after-read to record');
});

test('collateral stuck on the spot side is named, and nobody is told to deposit again', async () => {
  const { rail: r, exchange } = rail({}, [{ perp: 0, spot: 0 }, { perp: 0, spot: 9.6594 }], { settleSchedule: SHORT_SETTLE }, { transferRefused: true });
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.equal(exchange.length, 1);
  assert.match(out.detail, /spot side/);
  assert.match(out.detail, /do not deposit again/);
  assert.doesNotMatch(out.detail, /for nothing/);
  assert.doesNotMatch(out.detail, /propose the deposit again/);
});

test('an account that shows the credit only on the third read after SUCCESS is a funded deposit', async () => {
  // Read 1 is the before. Reads 2 and 3 still show the old account; read 4 shows the credit.
  const shapes: AccountShape[] = [
    { perp: 0, spot: 0, unifiedAvailable: 0 },
    { perp: 0, spot: 0, unifiedAvailable: 0 },
    { perp: 0, spot: 0, unifiedAvailable: 0 },
    { perp: 0, spot: 9.6594, unifiedAvailable: 9.6594 },
  ];
  const { rail: r, calls, hlCalls } = rail({}, shapes, { settleSchedule: SHORT_SETTLE });
  const out = await r.execute(draft());
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /rose by 9\.6594/);
  assert.equal(hlCalls.filter((t) => t === 'spotClearinghouseState').length, 4, 'stopped at the read that showed it');
  assert.equal(calls.signed.length, 1);
  assert.equal(out.pocket?.after, String(Math.round(9.6594 * 10 ** HYPERCORE_USDC_DECIMALS)));
});

test('a credit under the floor for the whole window is the short fill, with the floor named', async () => {
  const { rail: r, calls } = rail({}, [{ perp: 0, spot: 0, unifiedAvailable: 0 }, { perp: 0, spot: 1, unifiedAvailable: 1 }], { settleSchedule: SHORT_SETTLE });
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.notEqual(out.settling, true);
  assert.match(out.detail, /rose by 1\.0000 USDC, below the .* USDC floor/);
  assert.match(out.detail, /before signing another/);
  assert.equal(calls.signed.length, 1);
});

// ---------- the floor, against the measured fee ----------

test('the floor clears the real fee at every size the rail accepts', () => {
  // Live dry quotes from the intents balance on 2026-09-11, no partner key, so the 25 bp app
  // fee is inside these numbers. The floor has to sit UNDER each delivered amount or it refuses
  // an honest quote and blames the wrong thing.
  // The 6 row is from 2026-09-16, the day the size floor moved up to it.
  const live: Array<[number, number]> = [
    [6, 5.669525],
    [10, 9.6594],
    [50, 49.55863],
    [1000, 997.115655],
  ];
  for (const [sent, delivered] of live) {
    assert.ok(
      minCreditedFor(sent) <= delivered,
      `floor ${minCreditedFor(sent).toFixed(4)} for ${sent} is above the ${delivered} the venue actually delivers`,
    );
  }
});

test('the floor still caps the loss rather than waving everything through', () => {
  assert.ok(minCreditedFor(50) > 49, 'a floor of 49 would allow a full percent of unexplained loss');
  assert.ok(minCreditedFor(1000) > 995, 'the bp term must not dominate at size');
  assert.ok(1000 - minCreditedFor(1000) < 5, 'and the cap in dollars stays small');
  assert.equal(HYPERCORE_FLAT_FEE_USDC, 0.45);
  assert.equal(HYPERCORE_FEE_BPS, 40);
});

test('a nonsense amount floors at zero rather than at NaN', () => {
  assert.equal(minCreditedFor(Number.NaN), 0);
  assert.equal(minCreditedFor(-5), 0);
});

test('the funding venue is the verifier itself, one allowlist entry', () => {
  assert.equal(HYPERCORE_COUNTERPARTY, INTENTS_VERIFIER);
});

test('a draft that cannot price itself fails every budget instead of passing them all', () => {
  const { rail: r } = rail();
  assert.equal(r.valueUsd(draft({ amountUsd: Number.NaN })), Infinity);
  assert.equal(r.valueUsd(draft({ amountUsd: 10, amount: 12 })), 12);
});

// ---------- the quote signature ----------
//
// The handle is the one field the echo never covered. The rail verifies 1Click's signature over
// the quote (src/quote-signature.ts, through spendFromIntents) before the handle is used.

test('a quote whose handle was changed after signing is refused before anything is signed', async () => {
  const { rail: r, calls } = rail({ tamper: (s) => ({ ...s, quote: { ...(s.quote as Record<string, unknown>), depositAddress: 'attacker.near' } }) }, [{ perp: 0, spot: 0, unifiedAvailable: 0 }]);
  const out = await r.execute(draft());
  assert.equal(out.ok, false);
  assert.match(out.detail, /signature does not verify/);
  assert.match(out.detail, /Nothing was signed/);
  assert.equal(calls.generated.length, 0, 'no intent was generated');
  assert.equal(calls.signed.length, 0, 'nothing was signed');
});

test('an unsigned quote is refused, and a signed one lands its record in the evidence', async () => {
  const unsigned = rail({ tamper: (s) => ({ ...s, signature: undefined }) }, [{ perp: 0, spot: 0, unifiedAvailable: 0 }]);
  const refused = await unsigned.rail.execute(draft());
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /carries no signature/);
  assert.equal(unsigned.calls.signed.length, 0);

  const { rail: r } = rail({}, [{ perp: 0, spot: 0, unifiedAvailable: 0 }, { perp: 9.8, spot: 0, unifiedAvailable: 0 }]);
  const out = await r.execute(draft());
  const quote = out.evidence?.quote;
  assert.ok(quote !== undefined, `the signed quote is on the result: ${out.detail}`);
  assert.equal(quote.depositAddress, HANDLE);
  assert.match(quote.signature, /^ed25519:/);
});
