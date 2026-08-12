import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';

import {
  HL_DOMAIN,
  MIN_WITHDRAW_USDC,
  SIGNATURE_CHAIN_ID,
  SIGNATURE_CHAIN_ID_HEX,
  USD_CLASS_TRANSFER_TYPES,
  WITHDRAW_FEE_USDC,
  WITHDRAW_TYPES,
  accountSummary,
  buildUsdClassTransferPayload,
  buildWithdrawPayload,
  toAmountString,
  usdClassTransfer,
  withdraw3,
} from '../../src/rails/hyperliquid-withdraw.ts';
import type { HlSignPort, HlTypedData, HlWithdrawDeps } from '../../src/rails/hyperliquid-withdraw.ts';

// The app's own wallet stands in as a generic address. Not the real one: which wallet signs is
// irrelevant to every assertion here, and putting the live address in a public repo buys
// nothing. The secret sweep catches it if it ever creeps in.
const OWN = '0x2222222222222222222222222222222222222222' as Address;
const OUTSIDE = '0x3333333333333333333333333333333333333333';
const KEYS = '/nowhere/keys.json'; // never read: the port stands in for the signer

// The official hyperliquid-python-sdk's own test vector, from tests/signing_test.py. This key
// is published in that repo as a fixture and holds nothing.
const FIXTURE_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
const FIXTURE_DEST = '0x5e9ee1089755c3435139848e47e6635505d5a13a';
const FIXTURE_TIME = 1687816341423;

const NOW = 1786600000000;

type PortOverrides = { signer?: string; throwOnAddress?: string };

function fakeSignPort(over: PortOverrides = {}): { port: HlSignPort; signed: HlTypedData[] } {
  const signed: HlTypedData[] = [];
  const port: HlSignPort = {
    address() {
      if (over.throwOnAddress) throw new Error(over.throwOnAddress);
      return (over.signer ?? OWN) as Address;
    },
    async signTypedData(_keysPath, typed) {
      signed.push(typed);
      return { r: `0x${'1'.repeat(64)}`, s: `0x${'2'.repeat(64)}`, v: 27 };
    },
  };
  return { port, signed };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status: ok ? status : status, headers: { 'content-type': 'application/json' } });
}

type FetchOverrides = {
  spotUsdc?: string;
  withdrawable?: string;
  // Unified accounts report this and leave perp `withdrawable` at 0.0.
  unifiedAvailable?: string;
  exchange?: unknown;
  exchangeOk?: boolean;
  exchangeStatus?: number;
};

function fakeFetch(over: FetchOverrides = {}): { fetchImpl: typeof fetch; posts: Array<{ url: string; body: any }> } {
  const posts: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body));
    posts.push({ url: u, body });
    if (u.endsWith('/exchange')) {
      return jsonResponse(over.exchange ?? { status: 'ok', response: { type: 'default' } }, over.exchangeOk ?? true, over.exchangeStatus ?? 200);
    }
    if (body.type === 'clearinghouseState') {
      return jsonResponse({ marginSummary: { accountValue: over.withdrawable ?? '0.0', totalMarginUsed: '0.0' }, withdrawable: over.withdrawable ?? '0.0', assetPositions: [] });
    }
    return jsonResponse({
      balances: [{ coin: 'USDC', total: over.spotUsdc ?? '899.037299', hold: '0.0' }],
      ...(over.unifiedAvailable !== undefined
        ? { tokenToAvailableAfterMaintenance: [[0, over.unifiedAvailable]] }
        : {}),
    });
  };
  return { fetchImpl, posts };
}

function deps(over: Partial<HlWithdrawDeps> & FetchOverrides & PortOverrides = {}): HlWithdrawDeps {
  const { port } = fakeSignPort(over);
  const { fetchImpl } = fakeFetch(over);
  return {
    network: over.network ?? 'testnet',
    keysPath: KEYS,
    sign: over.sign ?? port,
    fetchImpl: over.fetchImpl ?? fetchImpl,
    now: over.now ?? (() => NOW),
  };
}

// ---------- the signing scheme, against the official SDK's fixtures ----------
//
// This is the test that matters. Everything else in this file is a refusal; only this one
// proves the bytes we sign are the bytes Hyperliquid verifies. If it fails, the module is
// producing valid signatures for the wrong message and the API will either reject them or
// attribute them somewhere else.

test('withdraw3 payload reproduces the official SDK signature fixture exactly', async () => {
  const account = privateKeyToAccount(FIXTURE_KEY);
  const { typedData, action, nonce } = buildWithdrawPayload({
    network: 'testnet',
    destination: FIXTURE_DEST,
    amount: '1',
    time: FIXTURE_TIME,
  });

  const packed = await account.signTypedData(typedData as never);
  const { r, s, yParity } = parseSignature(packed);

  // tests/signing_test.py::test_sign_withdraw_from_bridge_action
  assert.equal(r, '0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9');
  assert.equal(s, '0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881');
  assert.equal(27 + yParity, 28);

  // The nonce the API compares against action.time.
  assert.equal(nonce, action.time);
  assert.equal(action.time, FIXTURE_TIME);
});

test('the EIP-712 domain is HyperliquidSignTransaction on chain 421614 at the zero address', () => {
  assert.deepEqual(HL_DOMAIN, {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: 421614,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  });
  assert.equal(SIGNATURE_CHAIN_ID, 421614);
  assert.equal(SIGNATURE_CHAIN_ID_HEX, '0x66eee');
  assert.equal(parseInt(SIGNATURE_CHAIN_ID_HEX, 16), SIGNATURE_CHAIN_ID);
});

test('the typed-data field order and types match the SDK, since order is inside the type hash', () => {
  assert.deepEqual(WITHDRAW_TYPES['HyperliquidTransaction:Withdraw'], [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' }, // string, NOT address
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
  ]);
  assert.deepEqual(USD_CLASS_TRANSFER_TYPES['HyperliquidTransaction:UsdClassTransfer'], [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'toPerp', type: 'bool' },
    { name: 'nonce', type: 'uint64' },
  ]);
});

test('the withdraw3 action carries every field the API requires, and the signed message mirrors it', () => {
  const { action, typedData, nonce } = buildWithdrawPayload({
    network: 'testnet',
    destination: OUTSIDE,
    amount: '898',
    time: NOW,
  });

  assert.deepEqual(action, {
    type: 'withdraw3',
    signatureChainId: '0x66eee',
    hyperliquidChain: 'Testnet',
    destination: OUTSIDE.toLowerCase(),
    amount: '898',
    time: NOW,
  });
  assert.equal(typedData.primaryType, 'HyperliquidTransaction:Withdraw');
  // The signed message is the action minus its type tag and signatureChainId, so the two can
  // never drift. time is a bigint because the field is uint64.
  assert.deepEqual(typedData.message, {
    hyperliquidChain: 'Testnet',
    destination: OUTSIDE.toLowerCase(),
    amount: '898',
    time: BigInt(NOW),
  });
  assert.equal(nonce, NOW);
});

test('usdClassTransfer signs nonce, not time, and mainnet stamps a different hyperliquidChain', () => {
  const { action, typedData } = buildUsdClassTransferPayload({ network: 'testnet', amount: '899.037299', toPerp: true, nonce: NOW });
  assert.deepEqual(action, {
    type: 'usdClassTransfer',
    signatureChainId: '0x66eee',
    hyperliquidChain: 'Testnet',
    amount: '899.037299',
    toPerp: true,
    nonce: NOW,
  });
  assert.equal(typedData.primaryType, 'HyperliquidTransaction:UsdClassTransfer');
  assert.deepEqual(typedData.message, { hyperliquidChain: 'Testnet', amount: '899.037299', toPerp: true, nonce: BigInt(NOW) });

  // hyperliquidChain is the real network separator, and it is inside the signature.
  const main = buildUsdClassTransferPayload({ network: 'mainnet', amount: '1', toPerp: true, nonce: NOW });
  assert.equal(main.action.hyperliquidChain, 'Mainnet');
  assert.equal(main.action.signatureChainId, '0x66eee'); // unchanged: it is not the selector
});

// ---------- the testnet guard ----------

test('every write throws on mainnet rather than refusing softly', async () => {
  const d = deps({ network: 'mainnet', withdrawable: '1000.0' });
  await assert.rejects(() => withdraw3(d, { amount: 100 }), /TESTNET ONLY.*configured for mainnet/s);
  await assert.rejects(() => usdClassTransfer(d, { amount: 100, toPerp: true }), /TESTNET ONLY.*configured for mainnet/s);
});

test('the mainnet guard fires before anything is signed or sent', async () => {
  const { port, signed } = fakeSignPort();
  const { fetchImpl, posts } = fakeFetch({ withdrawable: '1000.0' });
  await assert.rejects(
    () => withdraw3({ network: 'mainnet', keysPath: KEYS, sign: port, fetchImpl, now: () => NOW }, { amount: 100 }),
    /TESTNET ONLY/,
  );
  assert.equal(signed.length, 0);
  assert.equal(posts.length, 0);
});

// ---------- the destination guard ----------

test('withdraw3 refuses a destination that is not the app own address', async () => {
  const { port, signed } = fakeSignPort();
  const { fetchImpl, posts } = fakeFetch({ withdrawable: '1000.0' });
  const d: HlWithdrawDeps = { network: 'testnet', keysPath: KEYS, sign: port, fetchImpl, now: () => NOW };

  const out = await withdraw3(d, { amount: 100, destination: OUTSIDE });
  assert.equal(out.ok, false);
  assert.match(out.detail, /not this app's own address/);
  assert.match(out.detail, /irreversible/);
  // Nothing was signed and nothing was posted.
  assert.equal(signed.length, 0);
  assert.equal(posts.length, 0);
});

test('withdraw3 allows an outside destination only when explicitly overridden', async () => {
  const { fetchImpl, posts } = fakeFetch({ withdrawable: '1000.0' });
  const out = await withdraw3(deps({ fetchImpl, withdrawable: '1000.0' }), {
    amount: 100,
    destination: OUTSIDE,
    allowExternalDestination: true,
  });
  assert.equal(out.ok, true, out.detail);
  const posted = posts.find((p) => p.url.endsWith('/exchange'));
  assert.equal(posted?.body.action.destination, OUTSIDE.toLowerCase());
});

test('withdraw3 defaults the destination to the app own address and accepts any casing of it', async () => {
  const { fetchImpl, posts } = fakeFetch({ withdrawable: '1000.0' });
  const out = await withdraw3(deps({ fetchImpl, withdrawable: '1000.0' }), { amount: 100 });
  assert.equal(out.ok, true, out.detail);
  const posted = posts.find((p) => p.url.endsWith('/exchange'));
  assert.equal(posted?.body.action.destination, OWN.toLowerCase());

  // The same address in a different case is still our own address, not an outside one.
  const upper = await withdraw3(deps({ fetchImpl, withdrawable: '1000.0' }), { amount: 100, destination: OWN.toUpperCase().replace('0X', '0x') });
  assert.equal(upper.ok, true, upper.detail);
});

test('withdraw3 refuses a destination that is not an address at all', async () => {
  const out = await withdraw3(deps({ withdrawable: '1000.0' }), { amount: 100, destination: 'vitalik.eth', allowExternalDestination: true });
  assert.equal(out.ok, false);
  assert.match(out.detail, /is not an address/);
});

// ---------- the fee floor ----------

test('withdraw3 refuses an amount that does not clearly exceed the 1 USDC fee', async () => {
  const { port, signed } = fakeSignPort();
  const { fetchImpl, posts } = fakeFetch({ withdrawable: '1000.0' });
  const d: HlWithdrawDeps = { network: 'testnet', keysPath: KEYS, sign: port, fetchImpl, now: () => NOW };

  assert.equal(WITHDRAW_FEE_USDC, 1);
  assert.equal(MIN_WITHDRAW_USDC, 2);

  for (const amount of [0.5, 1, 1.999999]) {
    const out = await withdraw3(d, { amount });
    assert.equal(out.ok, false, `amount ${amount} should have been refused`);
    assert.match(out.detail, /below the 2 USDC minimum/);
    assert.match(out.detail, /fee out of the amount/);
  }
  assert.equal(signed.length, 0);
  assert.equal(posts.length, 0);

  // Exactly at the floor is allowed: it still delivers 1 USDC2 to the far side.
  const ok = await withdraw3(deps({ withdrawable: '1000.0' }), { amount: 2 });
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /receives 1\.000000 USDC2/);
});

test('withdraw3 reports the net the destination actually receives, not the gross', async () => {
  const out = await withdraw3(deps({ withdrawable: '1000.0' }), { amount: 898 });
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /receives 897\.000000 USDC2/);
  assert.match(out.detail, /Arbitrum Sepolia/);
});

// ---------- the balance guard ----------

test('withdraw3 refuses when perp is short and points at the spot balance', async () => {
  // The live account exactly: everything in spot, nothing withdrawable on perp.
  const out = await withdraw3(deps({ withdrawable: '0.0', spotUsdc: '899.037299' }), { amount: 898 });
  assert.equal(out.ok, false);
  assert.match(out.detail, /perp withdrawable is 0 USDC/);
  assert.match(out.detail, /Spot holds 899\.037299 USDC/);
  assert.match(out.detail, /toPerp: true/);
});

test('usdClassTransfer refuses to move more than the source side holds', async () => {
  const toPerp = await usdClassTransfer(deps({ spotUsdc: '899.037299' }), { amount: 900, toPerp: true });
  assert.equal(toPerp.ok, false);
  assert.match(toPerp.detail, /spot holds 899\.037299 USDC and the transfer needs 900/);

  const toSpot = await usdClassTransfer(deps({ withdrawable: '5.0' }), { amount: 10, toPerp: false });
  assert.equal(toSpot.ok, false);
  assert.match(toSpot.detail, /perp withdrawable holds 5 USDC and the transfer needs 10/);
});

test('usdClassTransfer posts a signed action to /exchange and reports the direction', async () => {
  const { fetchImpl, posts } = fakeFetch({ spotUsdc: '899.037299' });
  const out = await usdClassTransfer(deps({ fetchImpl, spotUsdc: '899.037299' }), { amount: 899.037299, toPerp: true });
  assert.equal(out.ok, true, out.detail);
  assert.match(out.detail, /spot -> perp/);

  const posted = posts.find((p) => p.url.endsWith('/exchange'));
  assert.ok(posted, 'nothing was posted to /exchange');
  assert.equal(posted.url, 'https://api.hyperliquid-testnet.xyz/exchange');
  assert.deepEqual(Object.keys(posted.body).sort(), ['action', 'nonce', 'signature']);
  assert.equal(posted.body.nonce, NOW);
  assert.equal(posted.body.action.nonce, NOW); // must match the top-level nonce
  assert.equal(posted.body.action.amount, '899.037299');
  assert.equal(posted.body.action.toPerp, true);
  assert.deepEqual(Object.keys(posted.body.signature).sort(), ['r', 's', 'v']);
  assert.equal(posted.body.signature.v, 27);
});

// ---------- the response contract ----------

test('an HTTP 200 carrying status err is a failure, not a success', async () => {
  const out = await withdraw3(
    deps({ withdrawable: '1000.0', exchange: { status: 'err', response: 'Insufficient balance for withdrawal' } }),
    { amount: 100 },
  );
  assert.equal(out.ok, false);
  assert.match(out.detail, /refused by Hyperliquid/);
  assert.match(out.detail, /Insufficient balance/);
});

test('a non-JSON or non-200 reply is a failure with the body kept for the operator', async () => {
  const bad = await withdraw3(deps({ withdrawable: '1000.0', exchangeStatus: 502, exchangeOk: false, exchange: { error: 'bad gateway' } }), { amount: 100 });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /HTTP 502/);
});

// ---------- amounts ----------

test('toAmountString refuses anything that would silently move a different number', () => {
  assert.equal(toAmountString(898), '898');
  assert.equal(toAmountString(899.037299), '899.037299');
  assert.equal(toAmountString(1.5), '1.5');
  assert.equal(toAmountString(0.000001), '0.000001');

  assert.throws(() => toAmountString(0), /must be positive/);
  assert.throws(() => toAmountString(-5), /must be positive/);
  assert.throws(() => toAmountString(Number.NaN), /not a finite number/);
  assert.throws(() => toAmountString(Number.POSITIVE_INFINITY), /not a finite number/);
  // Seven decimals cannot be represented, so it is refused rather than rounded.
  assert.throws(() => toAmountString(1.0000005), /needs more than 6 decimals/);
});

// ---------- reads ----------

test('accountSummary separates the two books and defaults to the app own address', async () => {
  const { fetchImpl, posts } = fakeFetch({ spotUsdc: '899.037299', withdrawable: '0.0' });
  const summary = await accountSummary(deps({ fetchImpl }));

  assert.equal(summary.address, OWN);
  assert.equal(summary.network, 'testnet');
  assert.equal(summary.spotUsdc, 899.037299);
  assert.equal(summary.perpWithdrawableUsd, 0);
  assert.equal(summary.openPositions, 0);
  assert.deepEqual(new Set(posts.map((p) => p.url)), new Set(['https://api.hyperliquid-testnet.xyz/info']));
});

test('accountSummary reads zero from a malformed number rather than poisoning the guards with NaN', async () => {
  const summary = await accountSummary(deps({ spotUsdc: 'not-a-number', withdrawable: '' }));
  assert.equal(summary.spotUsdc, 0);
  assert.equal(summary.perpWithdrawableUsd, 0);
});

test('accountSummary throws on a non-address and on a failed request', async () => {
  await assert.rejects(() => accountSummary(deps(), 'not-an-address'), /is not an address/);
  const failing = deps({ fetchImpl: async () => jsonResponse({ error: 'nope' }, false, 500) });
  await assert.rejects(() => accountSummary(failing), /clearinghouseState failed: 500/);
});

test('withdraw3 refuses when the signing wallet cannot be resolved', async () => {
  const { port } = fakeSignPort({ throwOnAddress: 'no keys file at /nowhere/keys.json' });
  const out = await withdraw3(deps({ sign: port }), { amount: 100 });
  assert.equal(out.ok, false);
  assert.match(out.detail, /cannot resolve the signing wallet/);
});

// ---------- the key never leaks ----------

test('no result or action ever carries the private key', async () => {
  const out = await withdraw3(deps({ withdrawable: '1000.0' }), { amount: 100 });
  const dumped = JSON.stringify(out);
  assert.equal(dumped.includes(FIXTURE_KEY), false);
  assert.equal(/"privateKey"/.test(dumped), false);
  assert.equal(/0x[0-9a-fA-F]{64}/.test(JSON.stringify(out.action)), false);
});

// ---------- unified accounts, found by running this against Karim's real account ----------
// A unified account merges the spot and perp books. clearinghouseState.withdrawable then
// reads 0.0 while every dollar sits in spot, and usdClassTransfer is rejected outright with
// "Action disabled when unified account is active" because there are no longer two sides to
// move between. Guarding on the perp figure alone refused a withdrawal the account could
// afford and advised a transfer that cannot run. Observed live 2026-08-12.

test('a unified account can withdraw against its spot balance', async () => {
  const { fetchImpl } = fakeFetch({ withdrawable: '0.0', unifiedAvailable: '899.037299' });
  const summary = await accountSummary(deps({ fetchImpl, withdrawable: '0.0', unifiedAvailable: '899.037299' }), OWN);

  assert.equal(summary.perpWithdrawableUsd, 0, 'the perp book really does read zero');
  assert.equal(summary.availableUsdc, 899.037299, 'and the unified figure is what counts');
  assert.equal(summary.unified, true);

  const out = await withdraw3(deps({ fetchImpl, withdrawable: '0.0', unifiedAvailable: '899.037299' }), { amount: 50 });
  assert.equal(out.ok, true, out.detail);
});

test('a unified account is not told to run a transfer that would be rejected', async () => {
  const over = { withdrawable: '0.0', unifiedAvailable: '10.0', spotUsdc: '10.0' };
  const out = await withdraw3(deps({ ...over, fetchImpl: fakeFetch(over).fetchImpl }), { amount: 500 });

  assert.equal(out.ok, false);
  assert.doesNotMatch(out.detail, /usdClassTransfer/, 'that advice is wrong on a unified account');
  assert.match(out.detail, /available is 10/);
});

test('a classic account still guards on the perp book and still gets the transfer hint', async () => {
  const over = { withdrawable: '0.0', spotUsdc: '899.037299' }; // no unified field
  const out = await withdraw3(deps({ ...over, fetchImpl: fakeFetch(over).fetchImpl }), { amount: 50 });

  assert.equal(out.ok, false);
  assert.match(out.detail, /perp withdrawable is 0/);
  assert.match(out.detail, /usdClassTransfer/);
});
