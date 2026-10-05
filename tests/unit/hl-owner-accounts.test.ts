// Where Hyperliquid money goes once a vault has moved to the chip (PHASE2-PLAN.md C6, U8): the
// account the venue credits and every exit back from it are VAULT, the wallet's own 0x address,
// even though the intents rails now spend from ALLOWANCE. VAULT is the address the owner key signs
// for, so a deposit lands in the vault's own trading account and a withdrawal lands in the vault's
// own intents balance, and nothing either rail does is ever named after the allowance.
//
// A real keystore with its gate closed (tests/unit/helpers/owner-touch.ts), the live HL signer, and
// every remote faked. The allowance is the published vector's (tests/fixtures/derived-keys.ts),
// which is the account U3 derives from this owner key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import type { Address } from 'viem';

import type { HlDepositDraft, HlWithdrawDraft } from '../../src/types.ts';
import type { OneClickQuote } from '../../src/intents.ts';
import type { IntentsApiPort, IntentsQuoteParams, IntentsSignerPort } from '../../src/rails/intents-native.ts';
import { buildSendAssetPayload } from '../../src/rails/hl-user-signed.ts';
import type { HlSignature } from '../../src/rails/hl-user-signed.ts';
import { HL_WITHDRAW_COUNTERPARTY, minReceivedForHlWithdraw } from '../../src/rails/hypercore-withdraw.ts';
import { HYPERCORE_COUNTERPARTY, HYPERCORE_SLIPPAGE_BPS, HYPERCORE_USDC_ASSET_ID, HYPERCORE_USDC_DECIMALS, hypercoreDepositRail, minCreditedFor } from '../../src/rails/hypercore-deposit.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { MINTED, chipVault, teardown, withdrawWorld } from './helpers/owner-touch.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

const [V] = DERIVED_VECTORS;
const VAULT = V.vault;
const ALLOWANCE = V.allowance;
const ETH_USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';

test.afterEach(teardown);

function withdrawal(over: Partial<HlWithdrawDraft> = {}): HlWithdrawDraft {
  return {
    kind: 'hl_withdraw',
    symbol: 'USDC',
    amount: 8,
    amountUsd: 8,
    minReceived: minReceivedForHlWithdraw(8),
    from: VAULT,
    to: VAULT.toLowerCase(),
    counterparty: HL_WITHDRAW_COUNTERPARTY,
    ...over,
  };
}

test('kind chip: a withdrawal leaves the vault\'s Hyperliquid account and lands in the vault, behind one Touch ID', async () => {
  const v = chipVault(V.old);
  assert.equal(v.vault, VAULT);
  const world = withdrawWorld(v.keysPath);

  const simulated = await world.rail.simulate(withdrawal());
  assert.equal(simulated.ok, true, simulated.summary);
  assert.match(simulated.summary, /after a Touch ID that names the amount and that address/, 'the card says the touch is coming, and what it will name');

  const running = world.rail.execute(withdrawal());
  const asked = await v.shell.answer();
  const out = await running;
  assert.equal(out.ok, true, out.detail);
  assert.equal(asked.reason, 'Send 8.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954');
  assert.equal(v.shell.asked.length, 1, 'one send, one Touch ID');

  for (const q of world.quotes) {
    assert.equal(q.recipient, VAULT.toLowerCase(), 'credited to the vault inside the verifier');
    assert.equal(q.recipientType, 'INTENTS');
    assert.equal(q.refundTo, VAULT, 'a refund goes back to the vault\'s own Hyperliquid account');
  }
  assert.ok(world.intentsReads.length >= 2);
  assert.ok(world.intentsReads.every((a) => a === VAULT.toLowerCase()), 'the credit is proven on the vault\'s balance');
  assert.equal(out.pocket?.account, VAULT.toLowerCase());

  assert.equal(world.posts.length, 1);
  const post = world.posts[0] as { action: { destination: string; amount: string; nonce: number }; signature: HlSignature };
  assert.equal(post.action.destination, MINTED.toLowerCase());
  const { typedData } = buildSendAssetPayload(post.action);
  const signer = await recoverTypedDataAddress({
    domain: typedData.domain,
    types: typedData.types as never,
    primaryType: typedData.primaryType as never,
    message: typedData.message as never,
    signature: { r: post.signature.r, s: post.signature.s, yParity: post.signature.v - 27 },
  } as never);
  assert.equal(signer.toLowerCase(), VAULT.toLowerCase(), 'the owner key signed it: the account the venue moves money out of is the vault\'s');

  const everything = JSON.stringify({ quotes: world.quotes, posts: world.posts, reads: world.intentsReads, out }).toLowerCase();
  assert.ok(!everything.includes(ALLOWANCE.toLowerCase().slice(2)), 'the allowance is named nowhere in a withdrawal');
});

test('kind chip: a withdrawal that would credit the allowance, or leave from it, is refused before any quote', async () => {
  const v = chipVault(V.old);
  const world = withdrawWorld(v.keysPath);
  const toAllowance = await world.rail.simulate(withdrawal({ to: ALLOWANCE.toLowerCase() }));
  assert.equal(toAllowance.ok, false);
  assert.match(toAllowance.summary, /not our own intents account/);
  const fromAllowance = await world.rail.simulate(withdrawal({ from: ALLOWANCE, to: ALLOWANCE.toLowerCase() }));
  assert.equal(fromAllowance.ok, false);
  assert.match(fromAllowance.summary, new RegExp(`the configured key is ${VAULT.toLowerCase()}`));
  assert.equal(world.quotes.length, 0);
  assert.equal(v.shell.asked.length, 0);
});

// ---------- the deposit: spent from the allowance, credited to the vault ----------

function deposit(over: Partial<HlDepositDraft> = {}): HlDepositDraft {
  return {
    kind: 'hl_deposit',
    symbol: 'USDC',
    originAsset: ETH_USDC,
    amount: 10,
    amountUsd: 10,
    minCredited: minCreditedFor(10),
    from: ALLOWANCE.toLowerCase(),
    hlAccount: VAULT,
    counterparty: HYPERCORE_COUNTERPARTY,
    assets: { origin: { assetId: ETH_USDC, decimals: 6 }, destination: { assetId: HYPERCORE_USDC_ASSET_ID, decimals: HYPERCORE_USDC_DECIMALS } },
    ...over,
  };
}

// 1Click from the intents balance to HyperCore, the 2026-09-11 numbers for 10 USDC, echoing what was asked.
function depositApi(): { api: IntentsApiPort; quotes: IntentsQuoteParams[] } {
  const quotes: IntentsQuoteParams[] = [];
  const quote: OneClickQuote = {
    depositAddress: '0xhandle',
    amountIn: '10000000',
    amountInFormatted: '10.0',
    amountInUsd: '10.0',
    minAmountIn: '10000000',
    amountOut: '965940000',
    amountOutFormatted: '9.6594',
    amountOutUsd: '9.6594',
    minAmountOut: '964974060',
    timeEstimate: 20,
    refundFee: '0',
    withdrawFee: '31530000',
  };
  const api = {
    tokens: async () => [
      { assetId: ETH_USDC, decimals: 6, blockchain: 'eth', symbol: 'USDC' },
      { assetId: HYPERCORE_USDC_ASSET_ID, decimals: HYPERCORE_USDC_DECIMALS, blockchain: 'hypercore', symbol: 'USDC' },
    ],
    async quote(params: IntentsQuoteParams) {
      quotes.push(params);
      const echo = {
        dry: params.dry,
        swapType: 'EXACT_INPUT',
        slippageTolerance: HYPERCORE_SLIPPAGE_BPS,
        originAsset: params.originAsset,
        destinationAsset: params.destinationAsset,
        amount: params.amount,
        depositType: 'INTENTS',
        refundTo: params.account,
        refundType: 'INTENTS',
        recipient: params.recipient,
        recipientType: params.recipientType,
      };
      const raw = signQuote({ quote, quoteRequest: echo });
      return { quote: raw['quote'] as OneClickQuote, raw };
    },
  } as unknown as IntentsApiPort;
  return { api, quotes };
}

// The intents signer as the rails switch makes it under kind chip: it signs for the allowance.
const allowanceSigner: IntentsSignerPort = {
  address: () => ALLOWANCE as Address,
  signErc191: async () => {
    throw new Error('a simulation signs nothing');
  },
};

function depositRail(keysPath: string) {
  const { api, quotes } = depositApi();
  // The venue reads only; the HL signer is the live one, which answers with the vault.
  const fetchImpl: typeof fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  const rail = hypercoreDepositRail({ keysPath, api, signer: allowanceSigner, hl: { keysPath, fetchImpl }, quoteKey: TEST_QUOTE_KEY, sleep: async () => {} });
  return { rail, quotes };
}

test('kind chip: a deposit spends the allowance and is credited to the vault\'s own Hyperliquid account', async () => {
  const v = chipVault(V.old);
  const { rail, quotes } = depositRail(v.keysPath);
  const out = await rail.simulate(deposit());
  assert.equal(out.ok, true, out.summary);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].recipient, VAULT, 'the Hyperliquid account credited is the vault');
  assert.equal(quotes[0].recipientType, 'DESTINATION_CHAIN');
  assert.equal(quotes[0].account, ALLOWANCE.toLowerCase(), 'the balance spent, and any refund, is the allowance');
  assert.match(out.summary, /with the allowance key/);
  assert.match(out.summary, /asks for a Touch ID of its own/, 'the card says a book move would ask for a touch');
  assert.equal(v.shell.asked.length, 0, 'a deposit\'s own signature is the allowance\'s: no owner touch');
});

test('kind chip: a deposit that would credit an account named after the allowance is refused before any quote', async () => {
  const v = chipVault(V.old);
  const { rail, quotes } = depositRail(v.keysPath);
  const toAllowance = await rail.simulate(deposit({ hlAccount: ALLOWANCE }));
  assert.equal(toAllowance.ok, false);
  assert.match(toAllowance.summary, new RegExp(`not the account this app signs for on Hyperliquid \\(${VAULT.toLowerCase()}\\)`));
  const fromVault = await rail.simulate(deposit({ from: VAULT.toLowerCase() }));
  assert.equal(fromVault.ok, false);
  assert.match(fromVault.summary, /draft spends the balance of/);
  assert.equal(quotes.length, 0);
});
