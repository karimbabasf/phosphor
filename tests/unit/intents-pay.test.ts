// The NEAR Intents pay rail: a balance inside the verifier paid out to an address on a real chain.
//
// Same harness as intents-send.test.ts: a stubbed 1Click, a stubbed signer, signed quote
// responses, and a stubbed chain read for the receiver. What is different is what the tests
// hold: the receiver is an address on a chain, decoded rather than matched, the echo has to say
// DESTINATION_CHAIN and name that exact address, a contract cannot be paid the chain's coin, the
// bridge's flat fee is named when it breaches the floor, and the proof is the payout hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import type { Address } from 'viem';

import type { IntentsPayDraft, SendRecipient } from '../../src/types.ts';
import type { AddressActivity, AddressSummary } from '../../src/chainscan/index.ts';
import type { OneClickQuote, OneClickStatus, OneClickToken, TokensFile } from '../../src/intents.ts';
import type { IntentsApiPort, IntentsQuoteParams, IntentsSignerPort } from '../../src/rails/intents-native.ts';
import {
  INTENTS_PAY_COUNTERPARTY,
  PAY_MAX_LOSS_BPS,
  intentsPayRail,
  minReceivedForPay,
  networkChain,
  recipientSentence,
} from '../../src/rails/intents-pay.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const ACCOUNT = OWNER.toLowerCase();
const FRIEND = getAddress('0xb583f41992Cd21b2F2345e194a36D33684BB5DB0');
const HANDLE = 'a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058';
const PAYOUT_TX = '0x' + 'ab'.repeat(32);

// Live ids, 2026-09-17: ETH on Ethereum, USDC on Ethereum, USDC on Base, SOL on Solana.
const ETH_ASSET = 'nep141:eth.omft.near';
const USDC_ETH_ASSET = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDC_BASE_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const SOL_ASSET = 'nep141:sol.omft.near';

const apiTokens: OneClickToken[] = [
  { assetId: ETH_ASSET, decimals: 18, blockchain: 'eth', symbol: 'ETH' },
  { assetId: USDC_ETH_ASSET, decimals: 6, blockchain: 'eth', symbol: 'USDC', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  { assetId: USDC_BASE_ASSET, decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: SOL_ASSET, decimals: 9, blockchain: 'sol', symbol: 'SOL' },
];

const registry: TokensFile = {
  eth: { USDC: { tokenId: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 } },
  base: { USDC: { tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
  arb: {},
  sol: {},
  near: {},
};

// Live numbers, 2026-09-17: 0.01 ETH in, 0.00994 ETH out, withdrawFee 0.000035 ETH, eta 17 s.
const AMOUNT = 0.01;
const AMOUNT_BASE = 10_000_000_000_000_000n;
const OUT_BASE = 9_940_000_000_000_000n;
const WITHDRAW_FEE = 35_000_000_000_000n;

const NOW = Date.parse('2026-09-17T03:00:00.000Z');
const DEADLINE = '2026-09-20T03:00:00.000Z';

function quoteOf(over: Partial<OneClickQuote> = {}): OneClickQuote {
  return {
    depositAddress: HANDLE,
    amountIn: AMOUNT_BASE.toString(),
    amountInFormatted: '0.01',
    amountInUsd: '24.40',
    minAmountIn: AMOUNT_BASE.toString(),
    amountOut: OUT_BASE.toString(),
    amountOutFormatted: '0.00994',
    amountOutUsd: '24.25',
    minAmountOut: '9840600000000000',
    timeEstimate: 17,
    refundFee: '0',
    withdrawFee: WITHDRAW_FEE.toString(),
    ...over,
  };
}

function echoOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 10,
    originAsset: ETH_ASSET,
    destinationAsset: ETH_ASSET,
    amount: AMOUNT_BASE.toString(),
    depositType: 'INTENTS',
    refundTo: ACCOUNT,
    refundType: 'INTENTS',
    recipient: FRIEND,
    recipientType: 'DESTINATION_CHAIN',
    ...over,
  };
}

function payloadOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verifying_contract: 'intents.near',
    signer_id: ACCOUNT,
    deadline: DEADLINE,
    nonce: 'Vij2xgAlKBKzwEtQGN8wzBgg5wAN1h+JO1SSpSw/VVo=',
    intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [ETH_ASSET]: AMOUNT_BASE.toString() } }],
    ...over,
  });
}

function activityOf(over: Partial<AddressActivity> = {}): AddressActivity {
  return {
    network: 'ethereum',
    address: FRIEND,
    ok: true,
    txCount: 42,
    balance: { amount: '0.51', symbol: 'ETH' },
    isContract: false,
    lastSeen: '2026-09-12T10:00:00.000Z',
    source: 'blockscout',
    ...over,
  };
}

function recipientOf(over: Partial<SendRecipient> = {}): SendRecipient {
  return { known: false, count: 0, lastAt: null, activity: activityOf(), ownAddress: false, ...over };
}

function draftOf(over: Partial<IntentsPayDraft> = {}): IntentsPayDraft {
  return {
    kind: 'intents_pay',
    symbol: 'ETH',
    originAsset: ETH_ASSET,
    network: 'ethereum',
    amount: AMOUNT,
    amountUsd: 24.4,
    minReceived: minReceivedForPay(AMOUNT),
    from: ACCOUNT,
    to: FRIEND,
    toChecksum: 'valid',
    counterparty: INTENTS_PAY_COUNTERPARTY,
    recipient: recipientOf(),
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
  destinationTxHashes?: string[];
  submitThrows?: boolean;
  quoteThrows?: string;
  // The receiver's holdings as the chain answers them, before and after; null is "would not answer".
  receiver?: Array<AddressSummary | null>;
};

function summaryOf(balance: string): AddressSummary {
  return { ...activityOf({ balance: { amount: balance, symbol: 'ETH' } }), tokens: [], tokensSource: 'blockscout', explorer: null, note: '' };
}

function apiOf(over: Overrides = {}): { api: IntentsApiPort; calls: ApiCalls } {
  const calls: ApiCalls = { quotes: [], generated: [], submitted: [] };
  const api: IntentsApiPort = {
    tokens: async () => apiTokens,
    async quote(params) {
      calls.quotes.push(params);
      if (over.quoteThrows !== undefined) throw new Error(over.quoteThrows);
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
        destinationTxHashes: over.destinationTxHashes ?? [PAYOUT_TX],
        nearTxHashes: ['NearTx1'],
        settledAmountOut: '0.00994',
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
  const reads: Array<{ network: string; address: string }> = [];
  const answers = [...(over.receiver ?? [summaryOf('0.51'), summaryOf('0.51994')])];
  const rail = intentsPayRail({
    keysPath: '/nonexistent/keys.json',
    tokens: registry,
    api,
    signer,
    now: () => NOW,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 10,
    quoteKey: TEST_QUOTE_KEY,
    receiverRead: async (network, address) => {
      reads.push({ network, address });
      return answers.length > 0 ? (answers.shift() as AddressSummary | null) : null;
    },
  });
  return { rail, calls, reads };
}

async function refusal(rail: ReturnType<typeof railOf>['rail'], draft: IntentsPayDraft): Promise<string> {
  const sim = await rail.simulate(draft);
  assert.equal(sim.ok, false, `expected a refusal, got: ${sim.summary}`);
  return sim.summary;
}

// ---------- the tables ----------

test('the loss floor is three percent under the amount, because the bridge fee is flat', () => {
  assert.equal(PAY_MAX_LOSS_BPS, 300);
  assert.equal(minReceivedForPay(100), 97);
});

test('every payout network maps to the chain the token registry and the gas table know, and Bitcoin to none', () => {
  assert.equal(networkChain('ethereum'), 'eth');
  assert.equal(networkChain('base'), 'base');
  assert.equal(networkChain('arbitrum'), 'arb');
  assert.equal(networkChain('solana'), 'sol');
  assert.equal(networkChain('near'), 'near');
  assert.equal(networkChain('bitcoin'), null);
});

test('the receiver sentence says what the chain said, and says to check twice when nothing was ever there', () => {
  assert.equal(recipientSentence('ethereum', recipientOf()), 'This address has 42 transactions on Ethereum and holds 0.51 ETH.');
  const fresh = recipientOf({ activity: activityOf({ txCount: 0, balance: { amount: '0', symbol: 'ETH' }, lastSeen: null }) });
  assert.equal(recipientSentence('ethereum', fresh), 'This address has never been used on Ethereum. Check it twice.');
  const unread = recipientOf({ activity: null });
  assert.equal(recipientSentence('ethereum', unread), 'This address could not be checked on Ethereum right now.');
  const failed = recipientOf({ activity: activityOf({ ok: false, txCount: null, balance: null, error: 'blockscout answered 503' }) });
  assert.match(recipientSentence('ethereum', failed), /could not be checked on Ethereum/);
  const contract = recipientOf({ activity: activityOf({ isContract: true }) });
  assert.match(recipientSentence('ethereum', contract), /is a contract on Ethereum/);
  const own = recipientOf({ ownAddress: true });
  assert.match(recipientSentence('base', own), /^This is your own address on Base\./);
});

// ---------- refusals before any signature ----------

test('a draft spending somebody else\'s balance, a wrong counterparty, or an unlisted asset is refused', async () => {
  const { rail } = railOf();
  assert.match(await refusal(rail, draftOf({ from: FRIEND.toLowerCase() })), /configured key is/);
  assert.match(await refusal(rail, draftOf({ counterparty: 'not-the-verifier' })), /must name intents.near/);
  assert.match(await refusal(rail, draftOf({ originAsset: 'nep141:nothing.near' })), /does not list/);
  assert.match(await refusal(rail, draftOf({ symbol: 'USDT' })), /is ETH on the 1click list, not the USDT/);
});

test('a receiver that is not an address on the named chain is refused before a quote is asked for', async () => {
  const { rail, calls } = railOf();
  assert.match(await refusal(rail, draftOf({ to: '0xb583f41992Cd21b2F2345e194a36D33684BB5DB' })), /not an address on Ethereum/);
  // One character changed in a checksummed address fails its checksum: a typo, not a wallet.
  assert.match(await refusal(rail, draftOf({ to: '0xb583f41992Cd21b2F2345e194a36D33684BB5DB1' })), /checksum/);
  assert.match(await refusal(rail, draftOf({ to: 'alice.near' })), /not an address on Ethereum/);
  assert.equal(calls.quotes.length, 0);
});

test('a Solana address passes when it decodes to 32 bytes and fails on 31', async () => {
  const solDraft = (to: string): IntentsPayDraft =>
    draftOf({ symbol: 'SOL', originAsset: SOL_ASSET, network: 'solana', to, toChecksum: null, amount: 0.1, amountUsd: 21, minReceived: minReceivedForPay(0.1), recipient: recipientOf({ activity: null }) });
  const good = railOf({
    quote: { amountIn: '100000000', amountInFormatted: '0.1', minAmountIn: '100000000', amountOut: '99648062', amountOutFormatted: '0.099648062', minAmountOut: '99500000', withdrawFee: '101938' },
    echo: { originAsset: SOL_ASSET, destinationAsset: SOL_ASSET, amount: '100000000', recipient: 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy' },
  });
  const sim = await good.rail.simulate(solDraft('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'));
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(good.calls.quotes[0]?.recipient, 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy');
  assert.equal(good.calls.quotes[0]?.recipientType, 'DESTINATION_CHAIN');
  // 31 bytes: a base58 string that is one byte short of a key.
  const short = railOf();
  assert.match(await refusal(short.rail, solDraft('2ipXjKCMt9Gb5HHYKmeBEaMpGmBUqTyHtnb8jVsz8L')), /does not decode to 32 bytes/);
  assert.equal(short.calls.quotes.length, 0);
});

test('a contract cannot be paid the chain\'s own coin, and a token payout to one is allowed with the fact said', async () => {
  const contract = recipientOf({ activity: activityOf({ isContract: true }) });
  const { rail, calls } = railOf();
  assert.match(await refusal(rail, draftOf({ recipient: contract })), /is a contract on Ethereum.*ETH sent to a contract/);
  assert.equal(calls.quotes.length, 0);

  const usdc = railOf({
    quote: { amountIn: '10000000', amountInFormatted: '10', minAmountIn: '10000000', amountOut: '9972600', amountOutFormatted: '9.9726', minAmountOut: '9950000', withdrawFee: '2400', amountInUsd: '10.00', amountOutUsd: '9.97' },
    echo: { originAsset: USDC_ETH_ASSET, destinationAsset: USDC_ETH_ASSET, amount: '10000000' },
  });
  const sim = await usdc.rail.simulate(draftOf({ symbol: 'USDC', originAsset: USDC_ETH_ASSET, amount: 10, amountUsd: 10, minReceived: minReceivedForPay(10), recipient: contract }));
  assert.equal(sim.ok, true, sim.summary);
  assert.match(sim.summary, /is a contract on Ethereum/);
});

test('our own address on the chain is allowed and said as such', async () => {
  const { rail } = railOf({ echo: { recipient: OWNER } });
  const sim = await rail.simulate(draftOf({ to: OWNER, recipient: recipientOf({ ownAddress: true }) }));
  assert.equal(sim.ok, true, sim.summary);
  assert.match(sim.summary, /This is your own address on Ethereum/);
  assert.equal(sim.send?.activity.startsWith('This is your own address on Ethereum.'), true);
});

test('Bitcoin is not a network this rail pays out on', async () => {
  const { rail, calls } = railOf();
  assert.match(await refusal(rail, draftOf({ network: 'bitcoin', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', toChecksum: null })), /Bitcoin/);
  assert.equal(calls.quotes.length, 0);
});

// ---------- the dry quote ----------

test('the dry quote asks for a chain payout of the same asset, to the receiver as the chain spells it', async () => {
  const { rail, calls } = railOf();
  const sim = await rail.simulate(draftOf());
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(calls.quotes.length, 1);
  const q = calls.quotes[0]!;
  assert.equal(q.dry, true);
  assert.equal(q.originAsset, ETH_ASSET);
  assert.equal(q.destinationAsset, ETH_ASSET);
  assert.equal(q.amount, AMOUNT_BASE.toString());
  assert.equal(q.account, ACCOUNT);
  assert.equal(q.recipient, FRIEND, 'the checksummed spelling goes to the API as it is');
  assert.equal(q.recipientType, 'DESTINATION_CHAIN');
  assert.equal(q.slippageToleranceBps, 10, 'a same-asset payout has no price to slip against');
  assert.match(sim.summary, /0\.00994 ETH paid out to 0xb583f41992Cd21b2F2345e194a36D33684BB5DB0 on Ethereum/);
  assert.match(sim.summary, /0\.000035 ETH is the bridge's flat fee/);
  assert.match(sim.summary, /This address has 42 transactions on Ethereum and holds 0\.51 ETH\./);
  assert.match(sim.summary, /always waits for your click/);
  assert.deepEqual(sim.send, {
    destinationAsset: ETH_ASSET,
    arrives: '0.00994',
    arrivesAtLeast: '0.0098406',
    feeUsd: 0.15,
    bridgeFee: '0.000035',
    etaSeconds: 17,
    activity: 'This address has 42 transactions on Ethereum and holds 0.51 ETH.',
    explorer: `https://etherscan.io/address/${FRIEND}`,
  });
});

test('a payout of USDC held as the Ethereum flavor onto Base is quoted as that cross-chain pair at the default slippage', async () => {
  const { rail, calls } = railOf({
    quote: { amountIn: '10000000', amountInFormatted: '10', minAmountIn: '10000000', amountOut: '9972600', amountOutFormatted: '9.9726', minAmountOut: '9850000', withdrawFee: '2400', amountInUsd: '10.00', amountOutUsd: '9.97' },
    echo: { originAsset: USDC_ETH_ASSET, destinationAsset: USDC_BASE_ASSET, amount: '10000000', slippageTolerance: 100 },
  });
  const sim = await rail.simulate(draftOf({ symbol: 'USDC', originAsset: USDC_ETH_ASSET, network: 'base', amount: 10, amountUsd: 10, minReceived: minReceivedForPay(10), recipient: recipientOf({ activity: activityOf({ network: 'base' }) }) }));
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(calls.quotes[0]?.originAsset, USDC_ETH_ASSET);
  assert.equal(calls.quotes[0]?.destinationAsset, USDC_BASE_ASSET);
  assert.equal(calls.quotes[0]?.slippageToleranceBps, undefined, 'a real cross-chain route keeps the default tolerance');
  assert.equal(sim.send?.destinationAsset, USDC_BASE_ASSET);
  assert.equal(sim.send?.explorer, `https://basescan.org/address/${FRIEND}`);
});

test('a quote whose echo names another receiver, or an intents credit, or no echo at all, is refused', async () => {
  const stranger = await refusal(railOf({ echo: { recipient: '0x9999999999999999999999999999999999999999' } }).rail, draftOf());
  assert.match(stranger, /REFUSED/);
  assert.match(stranger, /0x9999/);
  const inside = await refusal(railOf({ echo: { recipientType: 'INTENTS' } }).rail, draftOf());
  assert.match(inside, /credits an intents balance instead of paying a wallet on Ethereum/);
  const none = await refusal(railOf({ echo: null }).rail, draftOf());
  assert.match(none, /without the echo this payout cannot be checked/);
});

test('a solver floor under the draft floor is refused, with the flat bridge fee named', async () => {
  const summary = await refusal(railOf({ quote: { minAmountOut: '9500000000000000' } }).rail, draftOf());
  assert.match(summary, /as little as 0\.0095 ETH/);
  assert.match(summary, /0\.000035 ETH is a flat bridge fee/);
  assert.match(summary, /3% of the amount/);
});

test('an amount under the bridge floor is refused with the floor named in the asset', async () => {
  const { rail } = railOf({ quoteThrows: '1click quote failed: Amount is too low for bridge, try at least 35442140705301' });
  const summary = await refusal(rail, draftOf({ amount: 0.00003, minReceived: minReceivedForPay(0.00003) }));
  assert.match(summary, /will not pay out less than 0\.000035442140705301 ETH on Ethereum/);
});

// ---------- execution ----------

test('execute signs the transfer 1click generated once, submits it, and reports the payout hash with its explorer link', async () => {
  const { rail, calls, reads } = railOf();
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, true, result.detail);
  assert.equal(calls.quotes.length, 1);
  assert.equal(calls.quotes[0]?.dry, false);
  assert.equal(calls.quotes[0]?.recipient, FRIEND);
  assert.equal(calls.quotes[0]?.recipientType, 'DESTINATION_CHAIN');
  assert.deepEqual(calls.generated, [{ signerId: ACCOUNT, depositAddress: HANDLE }]);
  assert.equal(calls.submitted.length, 1, 'one signature per move, never two');
  assert.equal(calls.submitted[0]?.signature, 'secp256k1:SIGNATURE');
  // The receiver read before the quote and after the success, both on the named chain.
  assert.deepEqual(reads, [{ network: 'ethereum', address: FRIEND }, { network: 'ethereum', address: FRIEND }]);
  assert.match(result.detail, /paid 0\.01 ETH from intents\.near to 0xb583f41992Cd21b2F2345e194a36D33684BB5DB0 on Ethereum/);
  assert.match(result.detail, /0\.00994 ETH arrived/);
  assert.match(result.detail, new RegExp(`payout ${PAYOUT_TX} \\(https://etherscan\\.io/tx/${PAYOUT_TX}\\)`));
  assert.match(result.detail, /ETH balance 0\.51 -> 0\.51994/);
  assert.deepEqual(result.txids, ['HASH123', PAYOUT_TX, 'NearTx1']);
  assert.equal(result.evidence?.explorerUrl, `https://etherscan.io/tx/${PAYOUT_TX}`);
  assert.equal(result.evidence?.settledAmountOut, '0.00994');
});

test('a success without a payout hash yet is a success that says where to look', async () => {
  const { rail } = railOf({ destinationTxHashes: [] });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, true);
  assert.match(result.detail, /no payout hash yet/);
  assert.match(result.detail, new RegExp(`https://etherscan\\.io/address/${FRIEND}`));
  assert.equal(result.evidence?.explorerUrl, undefined);
});

test('a chain that would not answer leaves the balance unsaid, still a success on the hash', async () => {
  const { rail } = railOf({ receiver: [null, null] });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, true);
  assert.match(result.detail, /balance was not read back/);
});

test('a generated payload that hands the balance to anything but the quote handle is never signed', async () => {
  const { rail, calls } = railOf({
    payload: payloadOf({ intents: [{ intent: 'transfer', receiver_id: FRIEND.toLowerCase(), tokens: { [ETH_ASSET]: AMOUNT_BASE.toString() } }] }),
  });
  await assert.rejects(() => rail.execute(draftOf()), /refusing to sign the intent 1click generated/);
  assert.equal(calls.submitted.length, 0);
});

test('a live echo that names another receiver throws before the signature and nothing is submitted', async () => {
  const { rail, calls } = railOf({ echo: { recipient: '0x9999999999999999999999999999999999999999' } });
  await assert.rejects(() => rail.execute(draftOf()), /0x9999/);
  assert.equal(calls.generated.length, 0);
  assert.equal(calls.submitted.length, 0);
});

test('a failed status with no refund yet says the input is held at the handle, never that it is back', async () => {
  const { rail } = railOf({ status: 'FAILED' });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, false);
  assert.match(result.detail, /1click reported FAILED and refunded 0 ETH so far/);
});

test('a submit that never answered is reported as signed and unconfirmed, not as failed', async () => {
  const { rail } = railOf({ submitThrows: true });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, false);
  assert.match(result.detail, /signed/i);
  assert.match(result.detail, /HANDLE|a7d101a8/);
});
