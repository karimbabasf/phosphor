// A send NEAR shows has run is Done, whatever 1Click still says.
//
// 2026-10-05, 0.10.17: a send of 5 USDC inside NEAR Intents to another intents account stayed on
// "Taking longer · 2m, Still checking whether this went through." The receiver already held the
// money, and the public record said so. 0.10.17 taught the swap card to end on NEAR's word (its
// own signed transfer spent, the bought coin arrived); the send rail still ended its watch on
// 1Click's status alone, and 1Click was slow that day. The two reads that prove a send ran are its
// own signed transfer's nonce, spent at the verifier, and the receiver's balance of the coin
// against the read taken before the quote.
//
// Run: node --test tests/unit/send-ran-proof.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import type { Address } from 'viem';

import type { IntentsSendDraft, RailResult } from '../../src/types.ts';
import { parseStatus } from '../../src/intents.ts';
import type { OneClickQuote } from '../../src/intents.ts';
import type { IntentsApiPort, IntentsSignerPort } from '../../src/rails/intents-native.ts';
import { INTENTS_SEND_COUNTERPARTY, intentsSendRail, minReceivedForSend } from '../../src/rails/intents-send.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const ACCOUNT = OWNER.toLowerCase();
const FRIEND_ID = '0xdc073cbe45df27fe3567fe8a6029bbe54ab469f2';
const HANDLE = 'a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const NONCE = 'Vij2xgAlKBKzwEtQGN8wzBgg5wAN1h+JO1SSpSw/VVo=';
const AMOUNT = 5;
const AMOUNT_BASE = 5_000_000n;
const ARRIVES = 4_987_500n; // less the 25 bp fee
const HELD_BEFORE = 1_000_000n; // the friend already held 1 USDC
const START = Date.parse('2026-10-05T20:50:00.000Z');
// NEAR runs the send this long after its submit.
const RUNS_AFTER_MS = 3_000;

type World = {
  // Whether NEAR runs the send at all, and what the receiver sees when it does.
  nonceSpends?: boolean;
  receiverRises?: boolean;
  // When 1Click says SUCCESS, after NEAR runs it; never inside the watch when unset.
  saysAfterMs?: number;
};

function draftOf(): IntentsSendDraft {
  const coin = { assetId: USDC, decimals: 6 };
  return {
    kind: 'intents_send',
    symbol: 'USDC',
    originAsset: USDC,
    amount: AMOUNT,
    amountUsd: 5,
    minReceived: minReceivedForSend(AMOUNT),
    from: ACCOUNT,
    to: FRIEND_ID,
    counterparty: INTENTS_SEND_COUNTERPARTY,
    assets: { origin: coin, destination: coin },
  };
}

async function sendIn(world: World): Promise<{ result: RailResult; submittedAt: number; doneAt: number; signatures: number }> {
  let now = START;
  // Each wait moves the clock and yields, so a read the watch started can answer before the next poll.
  const sleep = async (ms: number): Promise<void> => {
    now += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };
  let submittedAt = Infinity;
  let signatures = 0;
  const ran = (): boolean => now >= submittedAt + RUNS_AFTER_MS;
  const api: IntentsApiPort = {
    tokens: async () => [{ assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC' }],
    async quote(params) {
      const signed = signQuote({
        quote: {
          depositAddress: HANDLE,
          amountIn: AMOUNT_BASE.toString(),
          amountInFormatted: '5',
          amountInUsd: '5.0000',
          minAmountIn: AMOUNT_BASE.toString(),
          amountOut: ARRIVES.toString(),
          amountOutFormatted: '4.9875',
          amountOutUsd: '4.9875',
          minAmountOut: '4982500',
          timeEstimate: 5,
          refundFee: '0',
          withdrawFee: '0',
        },
        quoteRequest: {
          dry: params.dry,
          swapType: 'EXACT_INPUT',
          originAsset: USDC,
          destinationAsset: USDC,
          amount: AMOUNT_BASE.toString(),
          depositType: 'INTENTS',
          refundTo: ACCOUNT,
          refundType: 'INTENTS',
          recipient: FRIEND_ID,
          recipientType: 'INTENTS',
        },
      });
      return { quote: signed['quote'] as OneClickQuote, raw: signed };
    },
    async generateIntent() {
      const payload = JSON.stringify({
        verifying_contract: 'intents.near',
        signer_id: ACCOUNT,
        deadline: new Date(now + 72 * 3_600_000).toISOString(),
        nonce: NONCE,
        intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [USDC]: AMOUNT_BASE.toString() } }],
      });
      return { standard: 'erc191', payload };
    },
    async submitIntent() {
      submittedAt = now;
      return { intentHash: 'HASH123' };
    },
    async status() {
      const says = world.saysAfterMs !== undefined && ran() && now >= submittedAt + RUNS_AFTER_MS + world.saysAfterMs;
      return parseStatus({ status: says ? 'SUCCESS' : 'PROCESSING' });
    },
  };
  const signer: IntentsSignerPort = {
    address: () => OWNER as Address,
    signErc191: async () => {
      signatures += 1;
      return 'secp256k1:SIGNATURE';
    },
  };
  const rail = intentsSendRail({
    keysPath: '/nonexistent/keys.json',
    api,
    signer,
    now: () => now,
    sleepImpl: sleep,
    quoteKey: TEST_QUOTE_KEY,
    receiverBalance: async (account, asset) => {
      if (account !== FRIEND_ID || asset !== USDC) return null;
      return (world.receiverRises ?? true) && ran() ? HELD_BEFORE + ARRIVES : HELD_BEFORE;
    },
    nonceUsed: async (account, nonce) => account === ACCOUNT && nonce === NONCE && (world.nonceSpends ?? true) && ran(),
  });
  const result = await rail.execute(draftOf());
  return { result, submittedAt, doneAt: now, signatures };
}

test('a send NEAR has run says Done within seconds while 1Click still says PROCESSING', async () => {
  const { result, submittedAt, doneAt, signatures } = await sendIn({});
  assert.equal(result.ok, true, result.detail);
  assert.ok(doneAt - submittedAt < 15_000, `Done ${(doneAt - submittedAt) / 1000}s after the submit`);
  assert.match(result.detail, /0xdc073cbe45df27fe3567fe8a6029bbe54ab469f2 now holds 4987500 base units more of USDC/);
  assert.match(result.detail, /signed transfer spent while 1click still reported PROCESSING/);
  assert.equal(signatures, 1);
});

test('a send NEAR has not run never says Done on its own', async () => {
  const { result } = await sendIn({ nonceSpends: false, receiverRises: false });
  assert.equal(result.ok, false);
  assert.match(result.detail, /did not reach a terminal status/);
});

test('a spent nonce with no rise at the receiver is not Done', async () => {
  const { result } = await sendIn({ receiverRises: false });
  assert.equal(result.ok, false);
  assert.match(result.detail, /did not reach a terminal status/);
});

test('a rise at the receiver with this send\'s nonce unspent is somebody else\'s credit, not Done', async () => {
  const { result } = await sendIn({ nonceSpends: false });
  assert.equal(result.ok, false);
  assert.match(result.detail, /did not reach a terminal status/);
});

test('a 1Click that answers promptly still settles on its SUCCESS as before', async () => {
  const { result } = await sendIn({ saysAfterMs: 0 });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /now holds 4987500 base units more of USDC inside the verifier \(/);
  assert.doesNotMatch(result.detail, /still reported/);
});
