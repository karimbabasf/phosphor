import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OneClickQuote, OneClickStatus, OneClickToken } from '../../src/intents.ts';
import type { IntentsApiPort, IntentsQuoteParams, IntentsSignerPort } from '../../src/rails/intents-native.ts';
import { spendFromIntents } from '../../src/rails/intents-spend.ts';
import type { IntentsSpendRequest } from '../../src/rails/intents-spend.ts';

// The step every rail that spends the intents balance shares: quote, check the echo, ask
// 1Click for the intent, check it, sign it, submit it, watch it. The tests here pin the one
// property that matters at each step: the key is never touched until every check has passed,
// and once it has been, the outcome is reported rather than thrown.

const OWNER = '0x1111111111111111111111111111111111111111';
const HL_ACCOUNT = '0x1111111111111111111111111111111111111111';
const HANDLE = 'a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058';
const ORIGIN = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const DEST = '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054';
const AMOUNT_BASE = 10_000_000n; // 10 USDC at 6 decimals
const NOW = Date.parse('2026-09-11T22:00:00.000Z');
const DEADLINE = '2026-09-14T22:00:00.000Z';

const apiTokens: OneClickToken[] = [
  { assetId: ORIGIN, decimals: 6, blockchain: 'eth', symbol: 'USDC' },
  { assetId: DEST, decimals: 8, blockchain: 'hypercore', symbol: 'USDC' },
];

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
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 10,
    originAsset: ORIGIN,
    destinationAsset: DEST,
    amount: AMOUNT_BASE.toString(),
    depositType: 'INTENTS',
    refundTo: OWNER,
    refundType: 'INTENTS',
    recipient: HL_ACCOUNT,
    recipientType: 'DESTINATION_CHAIN',
    ...over,
  };
}

function payloadOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verifying_contract: 'intents.near',
    signer_id: OWNER,
    deadline: DEADLINE,
    nonce: 'Vij2xgAlKBKzwEtQGN8wzBgg5wAN1h+JO1SSpSw/VVo=',
    intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [ORIGIN]: AMOUNT_BASE.toString() } }],
    ...over,
  });
}

type Overrides = {
  quote?: Partial<OneClickQuote>;
  echo?: Record<string, unknown> | null;
  payload?: string;
  standard?: string;
  status?: OneClickStatus['status'];
  destinationTxHashes?: string[];
  statusThrows?: boolean;
};

type Calls = { quotes: IntentsQuoteParams[]; generated: unknown[]; submitted: unknown[]; signed: string[]; polls: number };

function harness(over: Overrides = {}): { api: IntentsApiPort; signer: IntentsSignerPort; calls: Calls } {
  const calls: Calls = { quotes: [], generated: [], submitted: [], signed: [], polls: 0 };
  const api: IntentsApiPort = {
    tokens: async () => apiTokens,
    async quote(params) {
      calls.quotes.push(params);
      const raw: Record<string, unknown> = { quote: quoteOf(over.quote) };
      if (over.echo !== null) raw['quoteRequest'] = echoOf(over.echo ?? {});
      return { quote: quoteOf(over.quote), raw };
    },
    async generateIntent(params) {
      calls.generated.push(params);
      return { standard: over.standard ?? 'erc191', payload: over.payload ?? payloadOf() };
    },
    async submitIntent(signed) {
      calls.submitted.push(signed);
      return { intentHash: 'HASH1', correlationId: 'c1' };
    },
    async status() {
      calls.polls += 1;
      if (over.statusThrows) throw new Error('status endpoint down');
      const status = over.status ?? 'SUCCESS';
      return {
        found: true,
        status,
        reported: status,
        originTxHashes: [],
        destinationTxHashes: over.destinationTxHashes ?? ['0xdeadbeef'],
        nearTxHashes: [],
      } as OneClickStatus;
    },
  };
  const signer: IntentsSignerPort = {
    address: () => OWNER as never,
    async signErc191(_keysPath, payload) {
      calls.signed.push(payload);
      return 'SIG';
    },
  };
  return { api, signer, calls };
}

function requestOf(over: Partial<IntentsSpendRequest> = {}): IntentsSpendRequest {
  return {
    owner: OWNER,
    originAsset: ORIGIN,
    destinationAsset: DEST,
    amountBase: AMOUNT_BASE,
    minOutBase: 960_000_000n,
    recipient: HL_ACCOUNT,
    recipientType: 'DESTINATION_CHAIN',
    slippageToleranceBps: 10,
    echo: {
      recipient: HL_ACCOUNT,
      recipientVerb: 'credit',
      recipientNoun: 'Hyperliquid account',
      recipientType: 'DESTINATION_CHAIN',
      recipientTypeWhy: 'a deposit that credits another intents balance is not what was approved',
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      refundTypeWhy: 'back to our balance inside the verifier',
      refundTo: OWNER,
      originAsset: ORIGIN,
      destinationAsset: DEST,
      amount: AMOUNT_BASE.toString(),
      noEcho: 'there is nothing tying the signature to the destination',
    },
    ...over,
  };
}

function depsOf(h: ReturnType<typeof harness>) {
  return {
    api: h.api,
    signer: h.signer,
    keysPath: '/nowhere/keys.json',
    now: () => NOW,
    sleep: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 3,
    maxDeadlineMs: 4 * 24 * 60 * 60 * 1000,
  };
}

test('the happy path quotes live, signs the generated intent once, submits it and reports SUCCESS', async () => {
  const h = harness();
  const out = await spendFromIntents(depsOf(h), requestOf());

  assert.equal(out.intentHash, 'HASH1');
  assert.equal(out.depositAddress, HANDLE);
  assert.equal(out.watch.status, 'SUCCESS');
  assert.deepEqual(out.watch.destinationTxHashes, ['0xdeadbeef']);
  assert.equal(out.quote.amountOutFormatted, '9.6594');

  assert.equal(h.calls.quotes.length, 1);
  assert.equal(h.calls.quotes[0].dry, false);
  assert.equal(h.calls.quotes[0].originAsset, ORIGIN);
  assert.equal(h.calls.quotes[0].destinationAsset, DEST);
  assert.equal(h.calls.quotes[0].recipient, HL_ACCOUNT);
  assert.equal(h.calls.quotes[0].recipientType, 'DESTINATION_CHAIN');
  assert.equal(h.calls.quotes[0].account, OWNER);
  assert.deepEqual(h.calls.generated, [{ signerId: OWNER, depositAddress: HANDLE }]);
  // Signed exactly as returned, never re-serialised.
  assert.deepEqual(h.calls.signed, [payloadOf()]);
  assert.deepEqual(h.calls.submitted, [{ payload: payloadOf(), signature: 'SIG' }]);
});

test('a quote whose echo names another recipient is refused before the key is touched', async () => {
  const h = harness({ echo: { recipient: '0x9999999999999999999999999999999999999999' } });
  await assert.rejects(() => spendFromIntents(depsOf(h), requestOf()), /live quote does not match/);
  assert.equal(h.calls.signed.length, 0);
  assert.equal(h.calls.generated.length, 0);
});

test('a quote with no echo at all is refused, since nothing ties the signature to a destination', async () => {
  const h = harness({ echo: null });
  await assert.rejects(() => spendFromIntents(depsOf(h), requestOf()), /nothing tying the signature/);
  assert.equal(h.calls.signed.length, 0);
});

test('the caller can add its own live-quote checks and they refuse before signing too', async () => {
  const h = harness();
  const req = requestOf({ checkQuote: (q) => (BigInt(q.amountOut) < 999_999_999_999n ? ['the solver would deliver too little'] : []) });
  await assert.rejects(() => spendFromIntents(depsOf(h), req), /deliver too little/);
  assert.equal(h.calls.signed.length, 0);
});

test('a generated intent that moves a different amount is refused before signing', async () => {
  const h = harness({ payload: payloadOf({ intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [ORIGIN]: '99000000' } }] }) });
  await assert.rejects(() => spendFromIntents(depsOf(h), requestOf()), /refusing to sign the intent 1click generated/);
  assert.equal(h.calls.signed.length, 0);
});

test('a generated intent sending to a handle other than our quote is refused before signing', async () => {
  const h = harness({ payload: payloadOf({ intents: [{ intent: 'transfer', receiver_id: 'somebody.near', tokens: { [ORIGIN]: AMOUNT_BASE.toString() } }] }) });
  await assert.rejects(() => spendFromIntents(depsOf(h), requestOf()), /not to a7d101a893/);
  assert.equal(h.calls.signed.length, 0);
});

test('a payload in any standard but erc191 is refused', async () => {
  const h = harness({ standard: 'nep413' });
  await assert.rejects(() => spendFromIntents(depsOf(h), requestOf()), /erc191 only/);
  assert.equal(h.calls.signed.length, 0);
});

test('a quote without a deposit handle is refused', async () => {
  const h = harness({ quote: { depositAddress: '' } });
  await assert.rejects(() => spendFromIntents(depsOf(h), requestOf()), /no deposit handle/);
  assert.equal(h.calls.signed.length, 0);
});

test('REFUNDED and FAILED after submission are reported, never thrown, with the hash kept', async () => {
  for (const status of ['REFUNDED', 'FAILED'] as const) {
    const h = harness({ status });
    const out = await spendFromIntents(depsOf(h), requestOf());
    assert.equal(out.intentHash, 'HASH1');
    assert.equal(out.watch.status, status);
    assert.equal(h.calls.signed.length, 1);
  }
});

test('a status endpoint that goes down after submission is reported as not terminal, not thrown', async () => {
  const h = harness({ statusThrows: true });
  const out = await spendFromIntents(depsOf(h), requestOf());
  assert.equal(out.intentHash, 'HASH1');
  assert.equal(out.watch.status, 'PENDING_DEPOSIT');
  assert.match(out.watch.reported, /status endpoint down/);
  assert.ok(h.calls.polls >= 1);
});

test('the signer id sent to generate-intent is the owner exactly as given', async () => {
  const h = harness();
  await spendFromIntents(depsOf(h), requestOf({ owner: OWNER }));
  assert.equal((h.calls.generated[0] as { signerId: string }).signerId, OWNER);
});
