import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OneClickQuote, OneClickStatus, OneClickToken } from '../../src/intents.ts';
import type { IntentsApiPort, IntentsQuoteParams, IntentsSignerPort } from '../../src/rails/intents-native.ts';
import { spendFromIntents } from '../../src/rails/intents-spend.ts';
import type { IntentsSpendOutcome, IntentsSpendRequest } from '../../src/rails/intents-spend.ts';
import type { RailEvidence } from '../../src/types.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

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
  submitThrows?: boolean;
  // One outcome per submit call, the last one repeating. 'timeout' and 'reset' are a call that
  // got no reply; 'reply' is the venue answering with an error.
  submitOutcomes?: Array<'ok' | 'timeout' | 'reset' | 'reply'>;
  // Applied to the quote response AFTER it is signed: what a proxy between this app and the
  // API would do to it. Left out, the response arrives as signed.
  tamper?: (signed: Record<string, unknown>) => Record<string, unknown>;
};

// Every call in the order it happened, so a test can say what came before what.
type Calls = { quotes: IntentsQuoteParams[]; generated: unknown[]; submitted: unknown[]; submitAttempts: number; signed: string[]; polls: number; order: string[] };

function harness(over: Overrides = {}): { api: IntentsApiPort; signer: IntentsSignerPort; calls: Calls } {
  const calls: Calls = { quotes: [], generated: [], submitted: [], submitAttempts: 0, signed: [], polls: 0, order: [] };
  const api: IntentsApiPort = {
    tokens: async () => apiTokens,
    async quote(params) {
      calls.quotes.push(params);
      const unsigned: Record<string, unknown> = { quote: quoteOf(over.quote) };
      if (over.echo !== null) unsigned['quoteRequest'] = echoOf(over.echo ?? {});
      // Signed the way 1Click signs its answers, over the whole payload, quote included.
      const signed = signQuote(unsigned);
      const raw = over.tamper === undefined ? signed : over.tamper(signed);
      return { quote: raw['quote'] as OneClickQuote, raw };
    },
    async generateIntent(params) {
      calls.generated.push(params);
      return { standard: over.standard ?? 'erc191', payload: over.payload ?? payloadOf() };
    },
    async submitIntent(signed) {
      calls.order.push('submit');
      if (over.submitThrows) throw new Error('submit-intent timed out after 30s');
      const outcomes = over.submitOutcomes ?? ['ok'];
      const outcome = outcomes[Math.min(calls.submitAttempts, outcomes.length - 1)] ?? 'ok';
      calls.submitAttempts += 1;
      if (outcome === 'timeout') {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (outcome === 'reset') throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      if (outcome === 'reply') throw new Error('submit-intent failed: 502');
      calls.submitted.push(signed);
      return { intentHash: 'HASH1', correlationId: 'c1' };
    },
    async status() {
      calls.order.push('poll');
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
      calls.order.push('sign');
      calls.signed.push(payload);
      return 'SIG';
    },
  };
  return { api, signer, calls };
}

function submittedOf(out: IntentsSpendOutcome) {
  assert.ok(out.submitted, 'expected the intent to have been submitted');
  return out;
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
    quoteKey: TEST_QUOTE_KEY,
  };
}

test('the happy path quotes live, signs the generated intent once, submits it and reports SUCCESS', async () => {
  const h = harness();
  const out = submittedOf(await spendFromIntents(depsOf(h), requestOf()));

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
    const out = submittedOf(await spendFromIntents(depsOf(h), requestOf()));
    assert.equal(out.intentHash, 'HASH1');
    assert.equal(out.watch.status, status);
    assert.equal(h.calls.signed.length, 1);
  }
});

test('a status endpoint that goes down after submission is reported as not terminal, not thrown', async () => {
  const h = harness({ statusThrows: true });
  const out = submittedOf(await spendFromIntents(depsOf(h), requestOf()));
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

// ---------- after the signature, nothing throws ----------

test('a submit that throws after the signature is returned as signed and unsubmitted, never thrown', async () => {
  const h = harness({ submitThrows: true });
  const out = await spendFromIntents(depsOf(h), requestOf());
  assert.equal(out.signed, true);
  assert.equal(out.submitted, false);
  assert.ok(!out.submitted);
  assert.match(out.error, /submit-intent timed out/);
  assert.equal(out.depositAddress, HANDLE);
  assert.equal(out.deadline, DEADLINE);
  assert.equal(out.quote.amountOutFormatted, '9.6594');
  assert.equal(h.calls.signed.length, 1, 'the key was used exactly once');
  assert.equal(h.calls.polls, 0, 'nothing to watch without a submitted intent');
});

test('the executor hears the handle right after the signature and the hash right after the submit, before any poll', async () => {
  const h = harness();
  const heard: Array<{ txids?: string[] } & RailEvidence> = [];
  const out = await spendFromIntents(depsOf(h), requestOf(), {
    onEvidence: (e) => {
      h.calls.order.push(`evidence:${e.txids?.join(',') ?? ''}:${e.handle ?? ''}`);
      heard.push(e);
    },
  });
  assert.ok(out.submitted);
  // The last pair is the poll and the word it read: every poll tells the executor where 1Click
  // says the order is, so a five minute wait moves on the card instead of sitting on one stage.
  assert.deepEqual(h.calls.order, ['sign', `evidence::${HANDLE}`, 'submit', `evidence:HASH1:${HANDLE}`, 'poll', 'evidence::']);
  assert.equal(heard.at(-1)?.providerStage, 'SUCCESS');
  // The signed quote rides on both, so a row that dies inside the wait still has what 1Click signed.
  const { quote: signedQuote, ...rest } = heard[0] as { quote?: unknown; handle?: string; deadline?: string };
  assert.deepEqual(rest, { handle: HANDLE, deadline: DEADLINE });
  assert.equal((signedQuote as { depositAddress?: string } | undefined)?.depositAddress, HANDLE);
  assert.equal(heard[1].deadline, DEADLINE, 'the second call carries everything the first did');
});

test('a submit that throws still handed the executor the handle first', async () => {
  const h = harness({ submitThrows: true });
  const heard: Array<{ txids?: string[] } & RailEvidence> = [];
  await spendFromIntents(depsOf(h), requestOf(), { onEvidence: (e) => heard.push(e) });
  assert.equal(heard.length, 1);
  assert.equal(heard[0].handle, HANDLE);
  assert.equal(heard[0].deadline, DEADLINE);
});

test('a hook that throws costs nothing: the money is already moving and the rail carries on', async () => {
  const h = harness();
  const out = await spendFromIntents(depsOf(h), requestOf(), {
    onEvidence: () => {
      throw new Error('disk full');
    },
  });
  assert.ok(out.submitted);
  assert.equal(out.watch.status, 'SUCCESS');
});

// ---------- never sign again after an ambiguous outcome ----------
//
// The verifier dedupes on the nonce inside the signed bytes and on nothing else. A second
// generate-intent or a second signature is a second nonce, and a second real balance move.
// The tests below count the signer: one call per move, whatever the submit or the watch did.

test('a submit that got no reply is sent once more with the identical bytes, and the key is not touched again', async () => {
  const h = harness({ submitOutcomes: ['timeout', 'ok'] });
  const out = await spendFromIntents(depsOf(h), requestOf());
  assert.ok(out.submitted, 'the second attempt answered');
  assert.equal(out.intentHash, 'HASH1');
  assert.equal(h.calls.submitAttempts, 2);
  assert.equal(h.calls.generated.length, 1, 'generate-intent once');
  assert.equal(h.calls.signed.length, 1, 'signErc191 exactly once');
  assert.deepEqual(h.calls.submitted, [{ payload: payloadOf(), signature: 'SIG' }], 'the bytes that landed are the bytes signed once');
});

test('a socket that dropped counts as no reply and gets the same one resend', async () => {
  const h = harness({ submitOutcomes: ['reset', 'ok'] });
  const out = await spendFromIntents(depsOf(h), requestOf());
  assert.ok(out.submitted);
  assert.equal(h.calls.submitAttempts, 2);
  assert.equal(h.calls.signed.length, 1);
});

test('two calls with no reply end as unconfirmed: never a third, never a new signature', async () => {
  const h = harness({ submitOutcomes: ['timeout', 'timeout'] });
  const out = await spendFromIntents(depsOf(h), requestOf());
  assert.equal(out.submitted, false);
  assert.ok(out.signed && !out.submitted);
  assert.match(out.error, /timeout/);
  assert.equal(out.depositAddress, HANDLE);
  assert.equal(h.calls.submitAttempts, 2);
  assert.equal(h.calls.generated.length, 1);
  assert.equal(h.calls.signed.length, 1, 'signErc191 exactly once');
  assert.equal(h.calls.polls, 0);
});

test('a submit the venue answered with an error is not resent: the answer may mean the intent was taken', async () => {
  const h = harness({ submitOutcomes: ['reply'] });
  const out = await spendFromIntents(depsOf(h), requestOf());
  assert.equal(out.submitted, false);
  assert.equal(h.calls.submitAttempts, 1);
  assert.equal(h.calls.generated.length, 1);
  assert.equal(h.calls.signed.length, 1);
});

test('a watch that runs out signs nothing more either', async () => {
  const h = harness({ status: 'PROCESSING' });
  const out = await spendFromIntents(depsOf(h), requestOf());
  assert.ok(out.submitted);
  assert.equal(out.watch.status, 'PROCESSING');
  assert.equal(h.calls.generated.length, 1);
  assert.equal(h.calls.signed.length, 1);
  assert.equal(h.calls.submitAttempts, 1);
});

// ---------- the quote signature ----------
//
// The handle is the one field the echo never covered. Every rail that spends through here
// verifies 1Click's signature over the quote (src/quote-signature.ts) before the handle is used.

test('a quote whose handle was changed after signing is refused before anything is signed', async () => {
  const h = harness({ tamper: (signed) => ({ ...signed, quote: { ...(signed.quote as Record<string, unknown>), depositAddress: 'attacker.near' } }) });
  await assert.rejects(() => spendFromIntents(depsOf(h), requestOf()), /signature does not verify/);
  assert.equal(h.calls.generated.length, 0, 'no intent was generated');
  assert.equal(h.calls.signed.length, 0, 'nothing was signed');
});

test('an unsigned quote is refused, and a signed one carries its record through both outcomes', async () => {
  const unsigned = harness({ tamper: (signed) => ({ ...signed, signature: undefined }) });
  await assert.rejects(() => spendFromIntents(depsOf(unsigned), requestOf()), /carries no signature/);
  assert.equal(unsigned.calls.signed.length, 0);

  const h = harness();
  const out = await spendFromIntents(depsOf(h), requestOf());
  assert.ok(out.signed);
  assert.equal(out.signedQuote.depositAddress, HANDLE);
  assert.match(out.signedQuote.signature, /^ed25519:/);
  assert.match(out.signedQuote.correlationId, /^test-quote-/);

  const noReply = harness({ submitOutcomes: ['timeout'] });
  const stuck = await spendFromIntents(depsOf(noReply), requestOf());
  assert.equal(stuck.submitted, false);
  assert.ok(stuck.signed);
  assert.equal(stuck.signedQuote.depositAddress, HANDLE, 'an unconfirmed submit keeps the signed quote too');
});

// ---------- the preflight ----------
//
// Between the live quote and generate-intent the rail can run the app's own checks
// (src/preflight/). A hold or a fail returns before the key is touched: no intent generated,
// no signature, and the venue probe the checks ran used the same request as the live quote.

import type { Preflight } from '../../src/types.ts';
import type { PreflightPort } from '../../src/rails/intents-spend.ts';

function preflightOf(verdict: Preflight['verdict'], holdReason?: string): Preflight {
  return {
    at: new Date(NOW).toISOString(),
    checks: [{ id: 'gas', label: 'Arbitrum gas', state: verdict === 'ok' ? 'ok' : 'fail', value: '300,024 / 300,000', detail: 'the 09-15 shape' }],
    verdict,
    ...(holdReason === undefined ? {} : { holdReason }),
  };
}

test('a preflight that says hold signs nothing: no intent generated, no signature, the outcome is held with the checks on it', async () => {
  const h = harness();
  const told: Preflight[] = [];
  let seen: PreflightPort | null = null;
  const out = await spendFromIntents(
    { ...depsOf(h), preflight: async (_quote, port) => { seen = port; return preflightOf('hold', 'Waiting for Arbitrum gas to settle'); } },
    requestOf(),
    { onPreflight: (p) => told.push(p) },
  );
  assert.equal(out.signed, false);
  assert.equal(out.submitted, false);
  assert.ok(!out.signed && out.held, 'the outcome says held');
  assert.equal(out.preflight.holdReason, 'Waiting for Arbitrum gas to settle');
  assert.equal(h.calls.generated.length, 0, 'no intent was generated');
  assert.equal(h.calls.signed.length, 0, 'nothing was signed');
  assert.equal(h.calls.submitAttempts, 0);
  assert.equal(told.length, 1, 'the executor was told the checks before anything else');
  assert.equal(h.calls.quotes.length, 1, 'the live quote was taken before the checks');
  // The port: whose balance, which asset, and a venue probe over the same request and handle.
  const port = seen as PreflightPort | null;
  assert.ok(port !== null);
  assert.equal(port.owner, OWNER);
  assert.equal(port.originAsset, ORIGIN);
  await port.venue.dryQuote();
  assert.equal(h.calls.quotes.length, 2);
  const dry = h.calls.quotes[1]!;
  assert.equal(dry.dry, true);
  assert.equal(dry.recipient, HL_ACCOUNT);
  assert.equal(dry.recipientType, 'DESTINATION_CHAIN');
  assert.equal(dry.amount, AMOUNT_BASE.toString());
  await port.venue.status();
  assert.equal(h.calls.polls, 1, 'the status probe asks about the live quote\'s handle');
});

test('a preflight that says ok is recorded through the hook before the signature and the spend goes on', async () => {
  const h = harness();
  const order: string[] = [];
  const out = await spendFromIntents(
    { ...depsOf(h), preflight: async () => { order.push('preflight'); return preflightOf('ok'); } },
    requestOf(),
    { onPreflight: () => order.push('told'), onEvidence: () => order.push('evidence') },
  );
  assert.ok(out.signed && out.submitted);
  assert.equal(h.calls.signed.length, 1);
  assert.deepEqual(order.slice(0, 3), ['preflight', 'told', 'evidence']);
  assert.ok(h.calls.order.indexOf('sign') >= 0);
});

test('a preflight that says fail signs nothing either, and is not a hold', async () => {
  const h = harness();
  const out = await spendFromIntents({ ...depsOf(h), preflight: async () => preflightOf('fail', 'The balance inside NEAR Intents does not cover this move') }, requestOf());
  assert.equal(out.signed, false);
  assert.ok(!out.signed && !out.held);
  assert.equal(h.calls.signed.length, 0);
  assert.equal(h.calls.generated.length, 0);
});

test('a preflight that throws is a refusal before the signature, not a signed move', async () => {
  const h = harness();
  await assert.rejects(() => spendFromIntents({ ...depsOf(h), preflight: async () => { throw new Error('arbitrum rpc down'); } }, requestOf()), /arbitrum rpc down/);
  assert.equal(h.calls.signed.length, 0);
});
