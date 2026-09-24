// The NEAR Intents send rail: a balance moving to ANOTHER account inside the verifier.
//
// Same harness as intents-withdraw.test.ts: a stubbed 1Click, a stubbed signer, signed quote
// responses. What is different is what the tests hold: the receiver is named by the draft, so
// the echo check is the fence, and the proof of arrival is the receiver's balance read back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import type { Address } from 'viem';

import type { IntentsSendDraft } from '../../src/types.ts';
import type { OneClickQuote, OneClickStatus, OneClickToken } from '../../src/intents.ts';
import type { IntentsApiPort, IntentsQuoteParams, IntentsSignerPort } from '../../src/rails/intents-native.ts';
import {
  INTENTS_SEND_COUNTERPARTY,
  SEND_MAX_LOSS_BPS,
  intentsAccountProblem,
  intentsSendRail,
  minReceivedForSend,
} from '../../src/rails/intents-send.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const ACCOUNT = OWNER.toLowerCase();
const FRIEND = getAddress('0xb583f41992Cd21b2F2345e194a36D33684BB5DB0');
const FRIEND_ID = FRIEND.toLowerCase();
const HANDLE = 'a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058';

// USDC as it sits inside the verifier after arriving from NEAR: the live id, 6 decimals.
const USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const ETH_ASSET = 'nep141:eth.bridge.near';

const apiTokens: OneClickToken[] = [
  { assetId: USDC_ASSET, decimals: 6, blockchain: 'near', symbol: 'USDC' },
  { assetId: ETH_ASSET, decimals: 18, blockchain: 'near', symbol: 'ETH' },
];

// Live numbers, 2026-09-16: 3.775899 USDC in, 3.766459 out, floor 3.747626 (a 25 bp fee).
const AMOUNT = 3.775899;
const AMOUNT_BASE = 3_775_899n;

const NOW = Date.parse('2026-09-17T03:00:00.000Z');
const DEADLINE = '2026-09-20T03:00:00.000Z';

function quoteOf(over: Partial<OneClickQuote> = {}): OneClickQuote {
  return {
    depositAddress: HANDLE,
    amountIn: AMOUNT_BASE.toString(),
    amountInFormatted: '3.775899',
    amountInUsd: '3.774650',
    minAmountIn: AMOUNT_BASE.toString(),
    amountOut: '3766459',
    amountOutFormatted: '3.766459',
    amountOutUsd: '3.765213',
    minAmountOut: '3747626',
    timeEstimate: 5,
    refundFee: '0',
    withdrawFee: '0',
    ...over,
  };
}

function echoOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: USDC_ASSET,
    destinationAsset: USDC_ASSET,
    amount: AMOUNT_BASE.toString(),
    depositType: 'INTENTS',
    refundTo: ACCOUNT,
    refundType: 'INTENTS',
    recipient: FRIEND_ID,
    recipientType: 'INTENTS',
    ...over,
  };
}

function payloadOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verifying_contract: 'intents.near',
    signer_id: ACCOUNT,
    deadline: DEADLINE,
    nonce: 'Vij2xgAlKBKzwEtQGN8wzBgg5wAN1h+JO1SSpSw/VVo=',
    intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [USDC_ASSET]: AMOUNT_BASE.toString() } }],
    ...over,
  });
}

function draftOf(over: Partial<IntentsSendDraft> = {}): IntentsSendDraft {
  return {
    kind: 'intents_send',
    symbol: 'USDC',
    originAsset: USDC_ASSET,
    amount: AMOUNT,
    amountUsd: 3.77465,
    minReceived: minReceivedForSend(AMOUNT),
    from: ACCOUNT,
    to: FRIEND_ID,
    counterparty: INTENTS_SEND_COUNTERPARTY,
    ...over,
  };
}

type ApiCalls = {
  quotes: IntentsQuoteParams[];
  generated: Array<{ signerId: string; depositAddress: string }>;
  submitted: Array<{ payload: string; signature: string }>;
};

type Overrides = {
  quote?: Partial<OneClickQuote>;
  echo?: Record<string, unknown> | null;
  payload?: string;
  status?: OneClickStatus['status'];
  submitThrows?: boolean;
  // The receiver's balance as the verifier answers it, before and after; null is "would not answer".
  receiver?: Array<bigint | null>;
};

function apiOf(over: Overrides = {}): { api: IntentsApiPort; calls: ApiCalls } {
  const calls: ApiCalls = { quotes: [], generated: [], submitted: [] };
  const api: IntentsApiPort = {
    tokens: async () => apiTokens,
    async quote(params) {
      calls.quotes.push(params);
      const unsigned: Record<string, unknown> = { quote: quoteOf(over.quote) };
      if (over.echo !== null) unsigned['quoteRequest'] = echoOf({ dry: params.dry, ...(over.echo ?? {}) });
      const signed = signQuote(unsigned);
      return { quote: signed['quote'] as OneClickQuote, raw: signed };
    },
    async generateIntent(params) {
      calls.generated.push(params);
      return { standard: 'erc191', payload: over.payload ?? payloadOf() };
    },
    async submitIntent(signed) {
      if (over.submitThrows) throw new Error('submit-intent timed out after 30s');
      calls.submitted.push(signed);
      return { intentHash: 'HASH123' };
    },
    async status() {
      return {
        found: true,
        status: over.status ?? 'SUCCESS',
        reported: over.status ?? 'SUCCESS',
        originTxHashes: [],
        destinationTxHashes: [],
        nearTxHashes: ['NearTx1'],
      };
    },
  };
  return { api, calls };
}

const signer: IntentsSignerPort = {
  address: () => OWNER as Address,
  signErc191: async () => 'secp256k1:SIGNATURE',
};

function railOf(over: Overrides = {}) {
  const { api, calls } = apiOf(over);
  const reads: Array<{ account: string; asset: string }> = [];
  const answers = [...(over.receiver ?? [0n, 3_766_459n])];
  const rail = intentsSendRail({
    keysPath: '/nonexistent/keys.json',
    api,
    signer,
    now: () => NOW,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 10,
    quoteKey: TEST_QUOTE_KEY,
    receiverBalance: async (account, asset) => {
      reads.push({ account, asset });
      return answers.length > 0 ? (answers.shift() as bigint | null) : null;
    },
  });
  return { rail, calls, reads };
}

async function refusal(rail: ReturnType<typeof railOf>['rail'], draft: IntentsSendDraft): Promise<string> {
  const sim = await rail.simulate(draft);
  assert.equal(sim.ok, false, `expected a refusal, got: ${sim.summary}`);
  return sim.summary;
}

// ---------- the account check ----------

test('an intents account is an EVM address, lowercased as the verifier keys it, or a NEAR account id', () => {
  assert.deepEqual(intentsAccountProblem(FRIEND), { ok: true, id: FRIEND_ID });
  assert.deepEqual(intentsAccountProblem(FRIEND_ID), { ok: true, id: FRIEND_ID });
  assert.deepEqual(intentsAccountProblem('  alice.near '), { ok: true, id: 'alice.near' });
  const bad = intentsAccountProblem('0xb583f41992Cd21b2F2345e194a36D33684BB5DB');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.problem, /not an EVM address/);
  // One character changed in a checksummed address fails its checksum: a typo, not an account.
  const typo = intentsAccountProblem('0xb583f41992Cd21b2F2345e194a36D33684BB5DB1');
  assert.equal(typo.ok, false);
  assert.match(typo.ok ? '' : typo.problem, /checksum/);
  assert.equal(intentsAccountProblem('').ok, false);
  assert.equal(intentsAccountProblem('not an account!').ok, false);
});

test('the loss floor is one percent under the amount', () => {
  assert.equal(SEND_MAX_LOSS_BPS, 100);
  assert.equal(minReceivedForSend(100), 99);
});

// ---------- refusals before any signature ----------

test('a send to our own account is refused before a quote is asked for', async () => {
  const { rail, calls } = railOf();
  const summary = await refusal(rail, draftOf({ to: ACCOUNT }));
  assert.match(summary, /this app's own account/);
  assert.equal(calls.quotes.length, 0);
});

test('a draft spending somebody else\'s balance, a wrong counterparty, or an unlisted asset is refused', async () => {
  const { rail } = railOf();
  assert.match(await refusal(rail, draftOf({ from: FRIEND_ID })), /configured key is/);
  assert.match(await refusal(rail, draftOf({ counterparty: 'not-the-verifier' })), /must name intents.near/);
  assert.match(await refusal(rail, draftOf({ originAsset: 'nep141:nothing.near' })), /does not list/);
  assert.match(await refusal(rail, draftOf({ symbol: 'USDT' })), /is USDC on the 1click list, not the USDT/);
});

test('the dry quote is asked for the same asset both ways, credited inside intents to the receiver', async () => {
  const { rail, calls } = railOf();
  const sim = await rail.simulate(draftOf());
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(calls.quotes.length, 1);
  const q = calls.quotes[0]!;
  assert.equal(q.dry, true);
  assert.equal(q.originAsset, USDC_ASSET);
  assert.equal(q.destinationAsset, USDC_ASSET);
  assert.equal(q.amount, AMOUNT_BASE.toString());
  assert.equal(q.recipient, FRIEND_ID);
  assert.equal(q.recipientType, 'INTENTS');
  assert.match(sim.summary, /credited to 0xb583f41992cd21b2f2345e194a36d33684bb5db0 inside the same verifier/);
  assert.match(sim.summary, /always waits for your click/);
  // The facts the send card draws, and the receiver's balance read at simulate time as its sentence.
  assert.equal(sim.send?.arrivesAtLeast, '3.747626');
  assert.equal(sim.send?.arrives, '3.766459');
  assert.equal(sim.send?.explorer, null);
  assert.equal(sim.send?.activity, 'This account holds no USDC inside NEAR Intents yet. Check it twice.');
  assert.match(sim.summary, /holds no USDC inside NEAR Intents yet/);
});

test('a receiver that already holds the asset is said as such, and one the verifier would not answer about as unchecked', async () => {
  const holding = railOf({ receiver: [12_500_000n] });
  const sim = await holding.rail.simulate(draftOf());
  assert.equal(sim.send?.activity, 'This account already holds 12.5 USDC inside NEAR Intents.');
  const unread = railOf({ receiver: [null] });
  const sim2 = await unread.rail.simulate(draftOf());
  assert.equal(sim2.send?.activity, 'This account could not be checked inside NEAR Intents right now.');
});

test('a quote whose echo names another receiver, or a chain wallet, or no echo at all, is refused', async () => {
  const stranger = await refusal(railOf({ echo: { recipient: '0x9999999999999999999999999999999999999999' } }).rail, draftOf());
  assert.match(stranger, /REFUSED/);
  assert.match(stranger, /0x9999/);
  const wallet = await refusal(railOf({ echo: { recipientType: 'DESTINATION_CHAIN' } }).rail, draftOf());
  assert.match(wallet, /pays a wallet on a chain instead of crediting an intents balance/);
  const none = await refusal(railOf({ echo: null }).rail, draftOf());
  assert.match(none, /without the echo this send cannot be checked/);
});

test('a solver floor under the draft floor is refused, with the floor named', async () => {
  const summary = await refusal(railOf({ quote: { minAmountOut: '3700000' } }).rail, draftOf());
  assert.match(summary, /as little as 3700000 base units/);
  assert.match(summary, /1 percent under the amount/);
});

// ---------- execution ----------

test('execute signs the transfer 1click generated, submits it, and proves the receiver rose by at least the floor', async () => {
  const { rail, calls, reads } = railOf();
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, true, result.detail);
  assert.equal(calls.quotes[0]?.dry, false);
  assert.equal(calls.quotes[0]?.recipient, FRIEND_ID);
  assert.deepEqual(calls.generated, [{ signerId: ACCOUNT, depositAddress: HANDLE }]);
  assert.equal(calls.submitted.length, 1);
  assert.equal(calls.submitted[0]?.signature, 'secp256k1:SIGNATURE');
  // The receiver's balance, read before the quote and after the success, both for the friend.
  assert.deepEqual(reads, [{ account: FRIEND_ID, asset: USDC_ASSET }, { account: FRIEND_ID, asset: USDC_ASSET }]);
  assert.match(result.detail, /sent 3.775899 USDC from 0x1111.* to 0xb583f41992cd21b2f2345e194a36d33684bb5db0 inside intents.near/);
  assert.match(result.detail, /now holds 3766459 base units more of USDC/);
  assert.deepEqual(result.txids, ['HASH123', 'NearTx1']);
});

test('a receiver that rose by less than the floor is said as unconfirmed, never as done', async () => {
  const { rail } = railOf({ receiver: [0n, 1_000n] });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, false);
  assert.match(result.detail, /rose by only 1000 base units/);
  assert.match(result.detail, /read the verifier again/);
});

test('a verifier that would not answer leaves the credit as 1click\'s word, still a success', async () => {
  const { rail } = railOf({ receiver: [null, null] });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, true);
  assert.match(result.detail, /could not be read back/);
});

test('a generated payload that hands the balance to anything but the quote handle is never signed', async () => {
  const { rail, calls } = railOf({
    payload: payloadOf({ intents: [{ intent: 'transfer', receiver_id: FRIEND_ID, tokens: { [USDC_ASSET]: AMOUNT_BASE.toString() } }] }),
  });
  await assert.rejects(() => rail.execute(draftOf()), /refusing to sign the intent 1click generated/);
  assert.equal(calls.submitted.length, 0);
});

test('a failed status with no refund yet never says it is back, and names where the input went only off a hash', async () => {
  const { rail } = railOf({ status: 'FAILED' });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, false);
  assert.match(result.detail, /1click reported FAILED and refunded 0 USDC so far/);
  assert.match(result.detail, /is not back yet|is not confirmed/);
  assert.doesNotMatch(result.detail, /refund is credited|went back/);
});

test('a submit that never answered is reported as signed and unconfirmed, not as failed', async () => {
  const { rail } = railOf({ submitThrows: true });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, false);
  assert.match(result.detail, /signed/i);
  assert.match(result.detail, /HANDLE|a7d101a8/);
});

test('the ETH flavor sends as ETH: nothing is swapped on the way', async () => {
  const amount = 0.00155507209807035;
  const base = 1_555_072_098_070_350n;
  const { rail, calls } = railOf({
    quote: { amountIn: base.toString(), amountInFormatted: '0.00155507209807035', minAmountIn: base.toString(), amountOut: '1551184417825174', amountOutFormatted: '0.001551184', minAmountOut: '1545000000000000' },
    echo: { originAsset: ETH_ASSET, destinationAsset: ETH_ASSET, amount: base.toString() },
  });
  const sim = await rail.simulate(draftOf({ symbol: 'ETH', originAsset: ETH_ASSET, amount, amountUsd: 3.76, minReceived: minReceivedForSend(amount) }));
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(calls.quotes[0]?.originAsset, ETH_ASSET);
  assert.equal(calls.quotes[0]?.destinationAsset, ETH_ASSET);
  assert.equal(calls.quotes[0]?.amount, base.toString());
});
