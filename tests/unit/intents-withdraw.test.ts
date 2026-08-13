// The intents-withdraw rail, tested against a mocked API and a mocked signer. Nothing here
// touches the network and nothing here reads a key: both ports are stubbed, so no test can
// reach the live API or the real signer by forgetting to override something.
//
// What this suite is about. Every other rail either delivers to the signer or to a contract on
// a verified deployment table. This one pays real money to an ordinary address on a chain, and
// on Solana it is an address the app holds no key for, so a wrong one is settled and gone.
// Worse, the address is NOT in the bytes we sign: the intent hands our balance to a solver
// handle and says nothing about the far side, so the only thing tying the signature to a
// destination is the request echo the API returns with the quote. Most of what follows is
// about that echo and about the address, and the numbers in the fixtures are the ones the live
// API actually returned on 2026-08-13.
//
// Run: node --test tests/unit/intents-withdraw.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import type { Address } from 'viem';

import type { AppConfig, IntentsWithdrawDraft, Network } from '../../src/types.ts';
import type { OneClickQuote, OneClickStatus, OneClickToken, TokensFile } from '../../src/intents.ts';
import type { IntentsApiPort, IntentsQuoteParams, IntentsSignerPort } from '../../src/rails/intents-native.ts';
import { base58Decode, base58Encode } from '../../src/rails/intents-native.ts';
import {
  INTENTS_WITHDRAW_COUNTERPARTY,
  WITHDRAW_DESTINATIONS,
  WITHDRAW_MAX_LOSS_BPS,
  addressProblem,
  intentsWithdrawRail,
  minReceivedFor,
  ourWalletOn,
} from '../../src/rails/intents-withdraw.ts';

// ---------- fixtures ----------

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const ACCOUNT = OWNER.toLowerCase();
// Two public constants standing in for a wallet and a stranger: the wrapped SOL mint and the
// system program. Never a real wallet, because a test fixture is published the moment it is
// committed, and an address in a public repo links this project to whoever holds it.
const SOL_WALLET = 'So11111111111111111111111111111111111111112';
const SOL_STRANGER = '11111111111111111111111111111111';
// The deposit handle a live INTENTS quote returned: 64 hex, an account id inside the verifier
// rather than an address on any chain.
const HANDLE = 'a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058';

const SOL_ASSET = 'nep141:sol.omft.near';
const ETH_ASSET = 'nep141:eth.omft.near';

const apiTokens: OneClickToken[] = [
  { assetId: SOL_ASSET, decimals: 9, blockchain: 'sol', symbol: 'SOL' },
  { assetId: ETH_ASSET, decimals: 18, blockchain: 'eth', symbol: 'ETH' },
];

const tokensFixture: TokensFile = { eth: {}, base: {}, arb: {}, sol: {}, near: {} };

const ADDRESSES: AppConfig['addresses'] = {
  evm: [OWNER],
  solana: [SOL_WALLET],
  near: ['demo.testnet'],
};

// 0.1 SOL, the amount the live quote below was taken for.
const AMOUNT = 0.1;
const AMOUNT_BASE = 100_000_000n;

const NOW = Date.parse('2026-08-13T05:00:00.000Z');
const DEADLINE = '2026-08-16T05:00:00.000Z'; // 72h out, which is what the live API returns

// The live numbers, verbatim: 0.1 SOL in, a flat 138816-lamport withdraw fee, a solver floor
// 1.24% under the input.
function quoteOf(over: Partial<OneClickQuote> = {}): OneClickQuote {
  return {
    depositAddress: HANDLE,
    amountIn: AMOUNT_BASE.toString(),
    amountInFormatted: '0.1',
    amountInUsd: '7.607000000000',
    minAmountIn: AMOUNT_BASE.toString(),
    amountOut: '99761184',
    amountOutFormatted: '0.099761184',
    amountOutUsd: '7.588833266880',
    minAmountOut: '98763572',
    timeEstimate: 7,
    refundFee: '0',
    withdrawFee: '138816',
    ...over,
  };
}

// The quoteRequest echo, which is the only thing in the whole flow that names the destination.
function echoOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: SOL_ASSET,
    destinationAsset: SOL_ASSET,
    amount: AMOUNT_BASE.toString(),
    depositType: 'INTENTS',
    refundTo: ACCOUNT,
    refundType: 'INTENTS',
    recipient: SOL_WALLET,
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
    intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [SOL_ASSET]: AMOUNT_BASE.toString() } }],
    ...over,
  });
}

// The ETH case, for the two tests that need an EVM destination. Live numbers again: 0.004 ETH
// in, a flat 0.000035 ETH withdraw fee, a solver floor 1.97% under the input. A fixture set
// hardcoded to SOL would make an ETH draft fail the echo check, which is correct behaviour and
// a useless test.
const ETH_AMOUNT = 0.004;
const ETH_AMOUNT_BASE = 4_000_000_000_000_000n;

const ethOverrides: Overrides = {
  quote: {
    amountIn: ETH_AMOUNT_BASE.toString(),
    amountInFormatted: '0.004',
    amountInUsd: '7.563640000000',
    minAmountIn: ETH_AMOUNT_BASE.toString(),
    amountOut: '3961000000000000',
    amountOutFormatted: '0.003961',
    amountOutUsd: '7.489712660000',
    minAmountOut: '3921390000000000',
    timeEstimate: 17,
    withdrawFee: '35000000000000',
  },
  echo: { originAsset: ETH_ASSET, destinationAsset: ETH_ASSET, amount: ETH_AMOUNT_BASE.toString(), recipient: OWNER },
};

function ethDraft(over: Partial<IntentsWithdrawDraft> = {}): IntentsWithdrawDraft {
  return draftOf({
    chain: 'eth',
    symbol: 'ETH',
    to: OWNER,
    amount: ETH_AMOUNT,
    amountUsd: 7.56364,
    minReceived: minReceivedFor(ETH_AMOUNT),
    ...over,
  });
}

function draftOf(over: Partial<IntentsWithdrawDraft> = {}): IntentsWithdrawDraft {
  return {
    kind: 'intents_withdraw',
    chain: 'sol',
    symbol: 'SOL',
    amount: AMOUNT,
    amountUsd: 7.607,
    minReceived: minReceivedFor(AMOUNT),
    from: ACCOUNT,
    to: SOL_WALLET,
    counterparty: INTENTS_WITHDRAW_COUNTERPARTY,
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
  echo?: Record<string, unknown> | null; // null removes quoteRequest entirely
  payload?: string;
  standard?: string;
  status?: OneClickStatus['status'];
  destinationTxHashes?: string[];
};

function apiOf(over: Overrides = {}): { api: IntentsApiPort; calls: ApiCalls } {
  const calls: ApiCalls = { quotes: [], generated: [], submitted: [] };
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
      return { intentHash: 'HASH123' };
    },
    async status() {
      return {
        found: true,
        status: over.status ?? 'SUCCESS',
        reported: over.status ?? 'SUCCESS',
        originTxHashes: [],
        destinationTxHashes: over.destinationTxHashes ?? ['5xSolanaTxSig'],
      };
    },
  };
  return { api, calls };
}

const signer: IntentsSignerPort = {
  address: () => OWNER as Address,
  signErc191: async () => 'secp256k1:SIGNATURE',
};

function railOf(over: Overrides = {}, opts: { network?: Network; addresses?: AppConfig['addresses'] } = {}) {
  const { api, calls } = apiOf(over);
  const rail = intentsWithdrawRail({
    network: opts.network ?? 'mainnet',
    keysPath: '/nonexistent/keys.json', // the signer port is stubbed, so this is never opened
    tokens: tokensFixture,
    addresses: opts.addresses ?? ADDRESSES,
    api,
    signer,
    now: () => NOW,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 10,
  });
  return { rail, calls };
}

async function refusal(rail: ReturnType<typeof railOf>['rail'], draft: IntentsWithdrawDraft): Promise<string> {
  const sim = await rail.simulate(draft);
  assert.equal(sim.ok, false, `expected a refusal, got: ${sim.summary}`);
  return sim.summary;
}

async function executeError(rail: ReturnType<typeof railOf>['rail'], draft: IntentsWithdrawDraft): Promise<string> {
  try {
    const result = await rail.execute(draft);
    assert.fail(`expected execute to throw, got ${JSON.stringify(result)}`);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------- base58, the thing an address check stands on ----------

test('base58Decode inverts base58Encode, including the leading-zero case', () => {
  const vectors: Uint8Array[] = [
    Uint8Array.from([0]),
    Uint8Array.from([0, 0, 1]),
    Uint8Array.from([1, 2, 3, 4, 5]),
    Uint8Array.from([255, 255, 255]),
    Uint8Array.from(new Array(32).fill(7)),
  ];
  for (const bytes of vectors) {
    const round = base58Decode(base58Encode(bytes));
    assert.deepEqual(round === null ? null : [...round], [...bytes], `round trip failed for ${bytes}`);
  }
});

test('base58Decode refuses characters that are not in the alphabet', () => {
  // 0, O, I and l are excluded from base58 precisely because they are confusable.
  for (const bad of ['0OIl', 'abc!', 'hello world', '28whPYACXrao299LdwGgep4aoa2sfcPwMuTJxPJjkcN0']) {
    assert.equal(base58Decode(bad), null, `${bad} should not decode`);
  }
});

// ---------- the address check ----------

test('a real Solana address passes and a truncated one does not', () => {
  assert.equal(addressProblem('sol', SOL_WALLET), null);

  // One character short. The string still looks like an address and passes any length range
  // check; it decodes to 31 bytes.
  const short = addressProblem('sol', SOL_WALLET.slice(0, -1));
  assert.ok(short !== null);
  assert.match(short, /31 bytes/);
  assert.match(short, /not the 32/);
});

test('an EVM address is not a Solana address and the reverse', () => {
  assert.equal(addressProblem('eth', OWNER), null);
  assert.ok((addressProblem('sol', OWNER) ?? '').length > 0, 'an 0x address is not base58');
  assert.ok((addressProblem('eth', SOL_WALLET) ?? '').length > 0, 'base58 is not an EVM address');
});

test('near is not an address this rail will validate, because it is not a destination', () => {
  assert.ok(!WITHDRAW_DESTINATIONS.includes('near'));
  assert.match(addressProblem('near', 'phosphor.near') ?? '', /not a chain this rail can withdraw to/);
});

test('ourWalletOn reads the address book and never invents a default', () => {
  assert.equal(ourWalletOn('sol', ADDRESSES), SOL_WALLET);
  assert.equal(ourWalletOn('eth', ADDRESSES), OWNER);
  assert.equal(ourWalletOn('base', ADDRESSES), OWNER, 'the three EVM chains share one address');
  assert.equal(ourWalletOn('sol', { evm: [OWNER], solana: [], near: [] }), null);
  assert.equal(ourWalletOn('sol', { evm: [OWNER], solana: ['   '], near: [] }), null, 'blank is not an address');
});

// ---------- the happy path ----------

test('simulate prices a SOL withdrawal and names the wallet it lands in', async () => {
  const { rail, calls } = railOf();
  const sim = await rail.simulate(draftOf());

  assert.equal(sim.ok, true, sim.summary);
  assert.match(sim.summary, /0\.099761184 SOL/);
  assert.match(sim.summary, new RegExp(SOL_WALLET));
  assert.equal(calls.quotes.length, 1);
  assert.equal(calls.quotes[0].dry, true, 'simulate must not mint a live handle');
  assert.equal(calls.quotes[0].recipient, SOL_WALLET);
  assert.equal(calls.quotes[0].recipientType, 'DESTINATION_CHAIN');
  assert.equal(calls.quotes[0].originAsset, SOL_ASSET);
  assert.equal(calls.quotes[0].destinationAsset, SOL_ASSET, 'a withdrawal does not change the asset');
});

test('simulate says plainly that a Solana destination cannot be checked against a key', async () => {
  const { rail } = railOf();
  const sol = await rail.simulate(draftOf());
  assert.match(sol.summary, /holds NO sol key/);
  assert.match(sol.summary, /vouches for/);

  // On an EVM chain the opposite is true and the summary says so instead.
  const eth = await railOf(ethOverrides).rail.simulate(ethDraft());
  assert.match(eth.summary, /holds the key for, checked against it/);
  assert.doesNotMatch(eth.summary, /vouches for/);
});

test('execute signs one intent, submits it, and reports the destination tx', async () => {
  const { rail, calls } = railOf();
  const result = await rail.execute(draftOf());

  assert.equal(result.ok, true, result.detail);
  assert.equal(calls.quotes.length, 1);
  assert.equal(calls.quotes[0].dry, false, 'execute needs a live handle');
  assert.deepEqual(calls.generated, [{ signerId: ACCOUNT, depositAddress: HANDLE }]);
  assert.equal(calls.submitted.length, 1);
  assert.equal(calls.submitted[0].signature, 'secp256k1:SIGNATURE');
  // The bytes signed are the bytes returned, never a re-serialisation.
  assert.equal(calls.submitted[0].payload, payloadOf());
  assert.deepEqual(result.txids, ['HASH123', '5xSolanaTxSig']);
  assert.match(result.detail, new RegExp(SOL_WALLET));
});

test('nothing is sent on any chain: the rail has no chain port at all', async () => {
  // The deposit rail takes an evm port and can move money. This one takes an api and a signer
  // and nothing else, which is the structural version of "it transfers nothing".
  const { rail } = railOf();
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(rail).sort(), ['execute', 'kind', 'simulate', 'valueUsd']);
  assert.equal(rail.kind, 'intents_withdraw');
});

// ---------- the destination, which is the whole point ----------

test('a draft naming a stranger is refused before any quote is asked for', async () => {
  const { rail, calls } = railOf();
  const summary = await refusal(rail, draftOf({ to: SOL_STRANGER }));
  assert.match(summary, /pays out to our own address and no other/);
  assert.equal(calls.quotes.length, 0, 'a bad destination must not even be priced');
});

test('Solana destinations compare case-sensitively, because base58 case is key material', async () => {
  const { rail } = railOf();
  const summary = await refusal(rail, draftOf({ to: SOL_WALLET.toLowerCase() }));
  assert.match(summary, /pays out to our own address and no other/);
});

test('EVM destinations compare case-insensitively, because the checksum is presentational', async () => {
  const { rail } = railOf(ethOverrides);
  const sim = await rail.simulate(ethDraft({ to: OWNER.toLowerCase() }));
  assert.equal(sim.ok, true, sim.summary);
});

test('a config address of the wrong shape is refused rather than paid', async () => {
  const { rail } = railOf({}, { addresses: { evm: [OWNER], solana: [SOL_WALLET.slice(0, -1)], near: [] } });
  const summary = await refusal(rail, draftOf({ to: SOL_WALLET.slice(0, -1) }));
  assert.match(summary, /configured sol address is unusable/);
  assert.match(summary, /31 bytes/);
});

test('no configured wallet on the destination chain refuses instead of falling back', async () => {
  const { rail } = railOf({}, { addresses: { evm: [OWNER], solana: [], near: [] } });
  const summary = await refusal(rail, draftOf());
  assert.match(summary, /no sol address is configured/);
});

test('an EVM wallet that disagrees with the key is refused', async () => {
  const other = getAddress('0x4444444444444444444444444444444444444444');
  const { rail } = railOf({}, { addresses: { evm: [other], solana: [SOL_WALLET], near: [] } });
  const summary = await refusal(
    rail,
    draftOf({ chain: 'eth', symbol: 'ETH', to: other, amount: 0.004, minReceived: minReceivedFor(0.004) }),
  );
  assert.match(summary, /not the address this app holds the key for/);
});

test('near is refused as a destination by name', async () => {
  const { rail } = railOf();
  const summary = await refusal(
    rail,
    draftOf({ chain: 'near', symbol: 'NEAR', to: 'demo.testnet', amount: 1, minReceived: minReceivedFor(1) }),
  );
  assert.match(summary, /eth, base, arb, sol only/);
  assert.match(summary, /nobody signed for/);
});

// ---------- the quote echo, which is what binds the signature to the destination ----------

test('a quote priced for somebody else is refused even when the amounts are right', async () => {
  const { rail } = railOf({ echo: { recipient: SOL_STRANGER } });
  const summary = await refusal(rail, draftOf());
  assert.match(summary, /priced to pay/);
  assert.match(summary, new RegExp(SOL_STRANGER));
});

test('a quote that credits another intents balance instead of a wallet is refused', async () => {
  const { rail } = railOf({ echo: { recipientType: 'INTENTS' } });
  const summary = await refusal(rail, draftOf());
  assert.match(summary, /not DESTINATION_CHAIN/);
});

test('a quote with no request echo is refused, because nothing would name the destination', async () => {
  const { rail } = railOf({ echo: null });
  const summary = await refusal(rail, draftOf());
  assert.match(summary, /no quoteRequest echo/);
  assert.match(summary, /cannot be checked and is refused/);
});

test('a quote that would take the input from the wallet instead of the balance is refused', async () => {
  const { rail } = railOf({ echo: { depositType: 'ORIGIN_CHAIN' } });
  assert.match(await refusal(rail, draftOf()), /not the INTENTS balance/);
});

test('a quote whose refund leaves the verifier is refused', async () => {
  const withType = railOf({ echo: { refundType: 'DESTINATION_CHAIN' } });
  assert.match(await refusal(withType.rail, draftOf()), /not back to our balance/);

  const withAddress = railOf({ echo: { refundTo: SOL_STRANGER } });
  assert.match(await refusal(withAddress.rail, draftOf()), /refund on this quote goes to/);
});

test('a quote for a different asset or a different size is refused by the echo as well', async () => {
  const asset = railOf({ echo: { destinationAsset: ETH_ASSET } });
  assert.match(await refusal(asset.rail, draftOf()), /not the nep141:sol.omft.near/);

  const size = railOf({ echo: { amount: '999' } });
  assert.match(await refusal(size.rail, draftOf()), /priced for 999 base units/);
});

test('the echo is checked again on the live quote, a moment before the key is touched', async () => {
  const { rail, calls } = railOf({ echo: { recipient: SOL_STRANGER } });
  const message = await executeError(rail, draftOf());
  assert.match(message, /live quote does not match the approved draft/);
  assert.match(message, /priced to pay/);
  assert.equal(calls.generated.length, 0, 'no intent may be generated');
  assert.equal(calls.submitted.length, 0, 'nothing may be signed or submitted');
});

// ---------- the amounts ----------

test('a quote for the wrong amount is refused', async () => {
  const { rail } = railOf({ quote: { amountIn: '999' } });
  assert.match(await refusal(rail, draftOf()), /the quote spends 0\.000000999 SOL/);
});

test('a solver floor below the draft floor is refused and names the flat fee', async () => {
  // 90000000 is 0.09 SOL, a tenth under the input and well below the 300bps floor.
  const { rail } = railOf({ quote: { minAmountOut: '90000000' } });
  const summary = await refusal(rail, draftOf());
  assert.match(summary, /below the/);
  assert.match(summary, /flat withdrawal fee/);
  assert.match(summary, /withdraw more at once/);
});

test('the loss floor is a constant, not something a draft can widen', async () => {
  assert.equal(WITHDRAW_MAX_LOSS_BPS, 300);
  assert.equal(minReceivedFor(1), 0.97);

  // A draft claiming a floor of zero is still measured against the solver's own floor, so it
  // cannot buy itself a worse fill: checkQuote compares the SOLVER floor to the DRAFT floor,
  // and a draft floor of 0 only ever makes the check looser for the draft, never for the money
  // the policy engine already sized. What it must not do is change the constant.
  const { rail } = railOf();
  const sim = await rail.simulate(draftOf({ minReceived: 0 }));
  assert.equal(sim.ok, true, 'a lower draft floor is permitted, but the tool cannot set one');
  assert.equal(minReceivedFor(AMOUNT), AMOUNT * 0.97, 'the constant is what the proposal builder uses');
});

// ---------- the payload ----------

test('a payload transferring to anywhere but our own quote handle is refused unsigned', async () => {
  const { rail, calls } = railOf({
    payload: payloadOf({
      intents: [{ intent: 'transfer', receiver_id: 'attacker.near', tokens: { [SOL_ASSET]: AMOUNT_BASE.toString() } }],
    }),
  });
  const message = await executeError(rail, draftOf());
  assert.match(message, /refusing to sign/);
  assert.equal(calls.submitted.length, 0);
});

test('a payload for a different amount is refused unsigned', async () => {
  const { rail, calls } = railOf({
    payload: payloadOf({
      intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [SOL_ASSET]: '999' } }],
    }),
  });
  assert.match(await executeError(rail, draftOf()), /refusing to sign/);
  assert.equal(calls.submitted.length, 0);
});

test('a payload naming another verifier is refused unsigned', async () => {
  const { rail, calls } = railOf({ payload: payloadOf({ verifying_contract: 'evil.near' }) });
  assert.match(await executeError(rail, draftOf()), /verifying contract/);
  assert.equal(calls.submitted.length, 0);
});

test('a payload bundling a second action is refused unsigned', async () => {
  const { rail, calls } = railOf({
    payload: payloadOf({
      intents: [
        { intent: 'transfer', receiver_id: HANDLE, tokens: { [SOL_ASSET]: AMOUNT_BASE.toString() } },
        { intent: 'transfer', receiver_id: 'attacker.near', tokens: { [SOL_ASSET]: '1' } },
      ],
    }),
  });
  assert.match(await executeError(rail, draftOf()), /bundles 2 actions/);
  assert.equal(calls.submitted.length, 0);
});

test('a token_diff shaped payload cannot satisfy a withdrawal, since both legs are one asset', async () => {
  // A withdrawal has originAsset === destinationAsset. One diff entry would have to be both
  // -amountBase and at or above the floor, which no single number is. Fail closed by shape.
  const { rail, calls } = railOf({
    payload: payloadOf({
      intents: [{ intent: 'token_diff', diff: { [SOL_ASSET]: (-AMOUNT_BASE).toString() } }],
    }),
  });
  assert.match(await executeError(rail, draftOf()), /refusing to sign/);
  assert.equal(calls.submitted.length, 0);
});

test('a payload in a standard we did not ask for is never signed', async () => {
  const { rail, calls } = railOf({ standard: 'nep413' });
  assert.match(await executeError(rail, draftOf()), /this rail signs erc191 only/);
  assert.equal(calls.submitted.length, 0);
});

// ---------- the draft's own claims ----------

test('a forged counterparty is refused before anything else happens', async () => {
  const { rail, calls } = railOf();
  const summary = await refusal(rail, draftOf({ counterparty: 'evil.near' }));
  assert.match(summary, /must name intents.near as the counterparty/);
  assert.equal(calls.quotes.length, 0);
});

test('a draft spending another account is refused', async () => {
  const { rail, calls } = railOf();
  const summary = await refusal(rail, draftOf({ from: '0x4444444444444444444444444444444444444444' }));
  assert.match(summary, /but the configured key is/);
  assert.equal(calls.quotes.length, 0, 'the account is checked before the network is touched');
});

test('testnet cannot execute, and simulate says so instead of pretending', async () => {
  const { rail } = railOf({}, { network: 'testnet' });
  const sim = await rail.simulate(draftOf());
  assert.equal(sim.ok, false);
  assert.match(sim.summary, /CANNOT EXECUTE on testnet/);
  assert.match(sim.summary, /code_hash 11111111111111111111111111111111/);

  const { rail: rail2, calls } = railOf({}, { network: 'testnet' });
  assert.match(await executeError(rail2, draftOf()), /mainnet only/);
  assert.equal(calls.quotes.length, 0, 'testnet must refuse before any network call');
});

// ---------- what happens after the signature is out ----------

test('a refund is reported as money back inside the verifier, not as money in a wallet', async () => {
  const { rail } = railOf({ status: 'REFUNDED' });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, false);
  assert.match(result.detail, /credited back to/);
  assert.match(result.detail, /where the balance started/);
});

test('a poll timeout says the intent IS submitted, so nobody signs a second one', async () => {
  const { rail } = railOf({ status: 'PROCESSING' });
  const result = await rail.execute(draftOf());
  assert.equal(result.ok, false);
  assert.match(result.detail, /THE INTENT IS SIGNED AND SUBMITTED/);
  assert.match(result.detail, /before signing another/);
  assert.deepEqual(result.txids, ['HASH123']);
});

test('valueUsd trusts a finite amount and refuses to under-report an unusable one', () => {
  const { rail } = railOf();
  assert.equal(rail.valueUsd(draftOf()), 7.607);
  assert.equal(rail.valueUsd(draftOf({ amountUsd: Number.NaN })), Infinity, 'an unpriced draft is not a cheap one');
});
