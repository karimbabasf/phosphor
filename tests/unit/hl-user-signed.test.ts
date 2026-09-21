import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSignature, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';

import {
  HL_DOMAIN,
  HL_USDC_TOKEN,
  SIGNATURE_CHAIN_ID,
  SEND_ASSET_TYPES,
  SIGNATURE_CHAIN_ID_HEX,
  USD_CLASS_TRANSFER_TYPES,
  accountSummary,
  buildSendAssetPayload,
  buildUsdClassTransferPayload,
  maxSendableUsdc,
  sendAsset,
  toAmountString,
  usdClassTransfer,
  usdcCreditedSince,
  userRole,
} from '../../src/rails/hl-user-signed.ts';
import type { HlSignPort, HlTypedData, HlUserSignedDeps } from '../../src/rails/hl-user-signed.ts';

// A generic wallet stands in for the app's own. Which wallet signs is irrelevant to every
// assertion here, and the live address buys nothing in a public repo.
const OWN = '0x2222222222222222222222222222222222222222' as Address;
const OUTSIDE = '0x3333333333333333333333333333333333333333';
const FRESH = '0xaf4FDa3876a32301839734891C337dA23184d954'; // the shape 1Click mints: checksummed, never seen
const KEYS = '/nowhere/keys.json'; // never read: the port stands in for the signer

// The key, destination and time are the official hyperliquid-python-sdk's own fixture inputs
// (tests/signing_test.py). The key is published there and holds nothing. The r, s, v values
// were produced by running the SDK's sign_user_signed_action on these inputs (SDK 0.24.0, in a
// scratch venv that first reproduced the SDK's own spotSend vector) and, separately, by viem,
// and the two agreed byte for byte (2026-09-20). They are the regression guard on the exact
// bytes this module produces.
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
  abstraction?: string; // what userAbstraction answers
  role?: string; // what userRole answers for any destination
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
    if (body.type === 'userAbstraction') {
      return jsonResponse(over.abstraction ?? (over.unifiedAvailable !== undefined ? 'unifiedAccount' : 'standard'));
    }
    if (body.type === 'userRole') {
      return jsonResponse({ role: over.role ?? 'user' });
    }
    return jsonResponse({
      balances: [{ coin: 'USDC', token: 0, total: over.spotUsdc ?? '899.037299', hold: '0.0' }],
      ...(over.unifiedAvailable !== undefined
        ? { tokenToAvailableAfterMaintenance: [[0, over.unifiedAvailable]] }
        : {}),
    });
  };
  return { fetchImpl, posts };
}

function deps(over: Partial<HlUserSignedDeps> & FetchOverrides & PortOverrides = {}): HlUserSignedDeps {
  const { port } = fakeSignPort(over);
  const { fetchImpl } = fakeFetch(over);
  return {
    keysPath: KEYS,
    sign: over.sign ?? port,
    fetchImpl: over.fetchImpl ?? fetchImpl,
    now: over.now ?? (() => NOW),
  };
}

// ---------- the signing scheme, against the official SDK ----------
//
// These are the tests that matter. Everything else in this file is a refusal; only these
// prove the bytes we sign are the bytes Hyperliquid verifies. If one fails, the module is
// producing valid signatures for the wrong message and the venue will either reject them or
// attribute them somewhere else.

test('the sendAsset payload signs to the SDK vector on Mainnet', async () => {
  const account = privateKeyToAccount(FIXTURE_KEY);
  const { typedData, action, nonce } = buildSendAssetPayload({
    destination: FIXTURE_DEST,
    amount: '1',
    nonce: FIXTURE_TIME,
  });

  const packed = await account.signTypedData(typedData as never);
  const { r, s, yParity } = parseSignature(packed);

  assert.equal(r, '0xfe1a043dc1f5b7e5bd361b397a615f8f791a317cf2d7c28e483746020cf2dd04');
  assert.equal(s, '0x3dbf449f1d7dc7c819e04c8f88e30edc762abbc69351d278e851c2b7c1fd9d39');
  assert.equal(27 + yParity, 28);

  const recovered = await recoverTypedDataAddress({ ...typedData, signature: packed } as never);
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());

  assert.equal(nonce, action.nonce);
  assert.equal(action.nonce, FIXTURE_TIME);
});

test('the sendAsset payload signs to the SDK vector on Testnet, so hyperliquidChain is inside the digest', async () => {
  const account = privateKeyToAccount(FIXTURE_KEY);
  const { typedData } = buildSendAssetPayload({
    destination: FIXTURE_DEST,
    amount: '1',
    nonce: FIXTURE_TIME,
    chain: 'Testnet',
  });
  const { r, s, yParity } = parseSignature(await account.signTypedData(typedData as never));
  assert.equal(r, '0x99a9ac7337378f56543cb5a762b710d4afd8925abf644bb6ec03ed9669c8f60e');
  assert.equal(s, '0x5d2db4547b8b54c9c54ce80a4948031566e5e78267eb3d9fe811960f59a7dcc0');
  assert.equal(27 + yParity, 27);
});

test('the usdClassTransfer payload signs to the SDK vector on Mainnet', async () => {
  const account = privateKeyToAccount(FIXTURE_KEY);
  const { typedData } = buildUsdClassTransferPayload({ amount: '1', toPerp: true, nonce: FIXTURE_TIME });
  const { r, s, yParity } = parseSignature(await account.signTypedData(typedData as never));
  assert.equal(r, '0x7000485fd96b213d769e6f07fc859c2683f52f4bcf24209f4a40379be9336e40');
  assert.equal(s, '0x0eca63d4e42e247ca9d7b3e4ffd8b72e73237a74cec0c0d9a490bd05dc3a7153');
  assert.equal(27 + yParity, 27);
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
  assert.deepEqual(SEND_ASSET_TYPES['HyperliquidTransaction:SendAsset'], [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' }, // string, NOT address
    { name: 'sourceDex', type: 'string' },
    { name: 'destinationDex', type: 'string' },
    { name: 'token', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'fromSubAccount', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ]);
  assert.deepEqual(USD_CLASS_TRANSFER_TYPES['HyperliquidTransaction:UsdClassTransfer'], [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'toPerp', type: 'bool' },
    { name: 'nonce', type: 'uint64' },
  ]);
});

test('the HyperCore USDC token string is name:tokenId, as confirmed from spotMeta', () => {
  assert.equal(HL_USDC_TOKEN, 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054');
});

test('the sendAsset action carries every field the API requires, and the signed message mirrors it', () => {
  const { action, typedData, nonce } = buildSendAssetPayload({ destination: FRESH, amount: '8', nonce: NOW });

  assert.deepEqual(action, {
    type: 'sendAsset',
    signatureChainId: '0x66eee',
    hyperliquidChain: 'Mainnet',
    destination: FRESH.toLowerCase(),
    sourceDex: 'spot',
    destinationDex: 'spot',
    token: HL_USDC_TOKEN,
    amount: '8',
    fromSubAccount: '',
    nonce: NOW,
  });
  assert.equal(typedData.primaryType, 'HyperliquidTransaction:SendAsset');
  assert.deepEqual(typedData.message, {
    hyperliquidChain: 'Mainnet',
    destination: FRESH.toLowerCase(),
    sourceDex: 'spot',
    destinationDex: 'spot',
    token: HL_USDC_TOKEN,
    amount: '8',
    fromSubAccount: '',
    nonce: BigInt(NOW),
  });
  assert.equal(nonce, NOW);
});

test('usdClassTransfer signs nonce, not time', () => {
  const { action, typedData } = buildUsdClassTransferPayload({ amount: '899.037299', toPerp: true, nonce: NOW });
  assert.deepEqual(action, {
    type: 'usdClassTransfer',
    signatureChainId: '0x66eee',
    hyperliquidChain: 'Mainnet',
    amount: '899.037299',
    toPerp: true,
    nonce: NOW,
  });
  assert.equal(typedData.primaryType, 'HyperliquidTransaction:UsdClassTransfer');
  assert.deepEqual(typedData.message, { hyperliquidChain: 'Mainnet', amount: '899.037299', toPerp: true, nonce: BigInt(NOW) });
});

// ---------- the network reaches the signature, not just the URL ----------

test('a mainnet sendAsset signs a Mainnet payload and posts it to the mainnet exchange', async () => {
  const { port, signed } = fakeSignPort();
  const { fetchImpl, posts } = fakeFetch({ unifiedAvailable: '1000.0' });
  const d: HlUserSignedDeps = { keysPath: KEYS, sign: port, fetchImpl, now: () => NOW };

  const out = await sendAsset(d, { destination: FRESH, amount: 100 });
  assert.equal(out.ok, true, out.detail);

  assert.equal(signed.length, 1);
  assert.equal((signed[0].message as Record<string, unknown>).hyperliquidChain, 'Mainnet');

  const exchange = posts.filter((p) => p.url.endsWith('/exchange'));
  assert.equal(exchange.length, 1);
  assert.equal(exchange[0].url, 'https://api.hyperliquid.xyz/exchange');
  assert.deepEqual(Object.keys(exchange[0].body).sort(), ['action', 'nonce', 'signature']);
  assert.equal(exchange[0].body.action.type, 'sendAsset');
  assert.equal(exchange[0].body.action.hyperliquidChain, 'Mainnet');
  assert.equal(exchange[0].body.action.destination, FRESH.toLowerCase());
  assert.equal(exchange[0].body.action.sourceDex, 'spot');
  assert.equal(exchange[0].body.action.destinationDex, 'spot');
  assert.equal(exchange[0].body.action.token, HL_USDC_TOKEN);
  assert.equal(exchange[0].body.action.amount, '100');
  assert.equal(exchange[0].body.action.fromSubAccount, '');
  assert.equal(exchange[0].body.nonce, NOW);
  assert.equal(exchange[0].body.action.nonce, NOW);
  assert.ok(
    posts.every((p) => p.url.startsWith('https://api.hyperliquid.xyz/')),
    `every call should be mainnet, got ${posts.map((p) => p.url).join(', ')}`,
  );
  assert.equal(out.nonce, NOW);
});

test('the signed usdClassTransfer payload names Mainnet in both the action and the message', () => {
  const p = buildUsdClassTransferPayload({ amount: '100', toPerp: true, nonce: NOW });
  assert.equal(p.action.hyperliquidChain, 'Mainnet');
  assert.equal((p.typedData.message as { hyperliquidChain: string }).hyperliquidChain, 'Mainnet');
});

// ---------- sendAsset refusals, every one before the key is touched ----------

test('sendAsset refuses a destination that is not an address and signs nothing', async () => {
  const { port, signed } = fakeSignPort();
  const out = await sendAsset(deps({ sign: port, unifiedAvailable: '1000.0' }), { destination: 'not-an-address', amount: 5 });
  assert.equal(out.ok, false);
  assert.match(out.detail, /is not an address/);
  assert.equal(signed.length, 0);
});

test('sendAsset refuses an amount that toAmountString refuses', async () => {
  const { port, signed } = fakeSignPort();
  const zero = await sendAsset(deps({ sign: port, unifiedAvailable: '1000.0' }), { destination: FRESH, amount: 0 });
  assert.equal(zero.ok, false);
  assert.match(zero.detail, /must be positive/);
  const fine = await sendAsset(deps({ sign: port, unifiedAvailable: '1000.0' }), { destination: FRESH, amount: 1.0000005 });
  assert.equal(fine.ok, false);
  assert.match(fine.detail, /needs more than 6 decimals/);
  assert.equal(signed.length, 0);
});

// Hyperliquid charges the SENDER 1 USDC for the first transfer into an account it has never
// seen, on top of the amount; the destination is credited in full. Every address 1Click mints
// is such an account, so this is the normal case for a withdrawal rather than a corner.
test('sendAsset to a never-seen destination needs amount plus 1 USDC and says why', async () => {
  const short = await sendAsset(deps({ unifiedAvailable: '8.5', role: 'missing' }), { destination: FRESH, amount: 8 });
  assert.equal(short.ok, false);
  assert.match(short.detail, /available is 8\.5 USDC/);
  assert.match(short.detail, /needs 9 \(8 plus the 1 USDC activation fee/);

  const { fetchImpl, posts } = fakeFetch({ unifiedAvailable: '9.0', role: 'missing' });
  const ok = await sendAsset(deps({ fetchImpl }), { destination: FRESH, amount: 8 });
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /1 USDC activation fee/);
  assert.equal(ok.activationFeeUsdc, 1);
  // The role was checked for the destination we are about to pay, once.
  const roles = posts.filter((p) => p.body.type === 'userRole');
  assert.equal(roles.length, 1);
  assert.equal(roles[0].body.user, FRESH.toLowerCase());
});

test('sendAsset to an existing destination pays no activation fee', async () => {
  const out = await sendAsset(deps({ unifiedAvailable: '8.0', role: 'user' }), { destination: OUTSIDE, amount: 8 });
  assert.equal(out.ok, true, out.detail);
  assert.doesNotMatch(out.detail, /activation/);
  assert.equal(out.activationFeeUsdc, 0);
});

test('sendAsset on a unified account draws on the unified figure and never suggests usdClassTransfer', async () => {
  const out = await sendAsset(deps({ withdrawable: '0.0', unifiedAvailable: '10.0', spotUsdc: '10.0' }), { destination: OUTSIDE, amount: 500 });
  assert.equal(out.ok, false);
  assert.match(out.detail, /available is 10 USDC/);
  assert.doesNotMatch(out.detail, /usdClassTransfer/);
});

// The refusal ends with the number to try instead: what is free, less the activation fee when
// the destination is fresh, cut toward zero at six decimals (criterion 8.6).
test('a short balance refusal spells the sum as money, never as a float that toAmountString would refuse', async () => {
  // 7.209399 plus the 1 USDC fee is 8.209399000000001 as a double; the sentence says 8.209399.
  const out = await sendAsset(deps({ unifiedAvailable: '7.0', role: 'missing' }), { destination: FRESH, amount: 7.209399 });
  assert.equal(out.ok, false);
  assert.match(out.detail, /needs 8\.209399 \(/);
  assert.doesNotMatch(out.detail, /0000001/);
  assert.equal(out.maxSendableUsdc, 6);
});

test('a short balance refusal names the most the account could send now', async () => {
  const fresh = await sendAsset(deps({ unifiedAvailable: '8.5', role: 'missing' }), { destination: FRESH, amount: 8 });
  assert.equal(fresh.ok, false);
  assert.match(fresh.detail, /The most it can send now is 7\.5 USDC/);
  assert.equal(fresh.maxSendableUsdc, 7.5);

  const known = await sendAsset(deps({ unifiedAvailable: '8.5', role: 'user' }), { destination: OUTSIDE, amount: 9 });
  assert.match(known.detail, /The most it can send now is 8\.5 USDC/);
  assert.equal(known.maxSendableUsdc, 8.5);

  assert.equal(maxSendableUsdc(0.5, 1), 0, 'never negative');
  assert.equal(maxSendableUsdc(7.2093999, 1), 6.209399, 'cut, never rounded, and never a float tail');
});

test('sendAsset on a standard account draws on the spot book and points at the perp side', async () => {
  const out = await sendAsset(deps({ withdrawable: '50.0', spotUsdc: '0.0' }), { destination: OUTSIDE, amount: 20 });
  assert.equal(out.ok, false);
  assert.match(out.detail, /the spot book holds 0 USDC/);
  assert.match(out.detail, /usdClassTransfer/);
});

test('sendAsset refuses when the signing wallet cannot be resolved', async () => {
  const { port } = fakeSignPort({ throwOnAddress: 'no keys file at /nowhere/keys.json' });
  const out = await sendAsset(deps({ sign: port }), { destination: FRESH, amount: 5 });
  assert.equal(out.ok, false);
  assert.match(out.detail, /cannot resolve the signing wallet/);
});

test('sendAsset retries with the nonce it is given rather than minting a new one', async () => {
  const { fetchImpl, posts } = fakeFetch({ unifiedAvailable: '100.0' });
  const out = await sendAsset(deps({ fetchImpl }), { destination: OUTSIDE, amount: 5, nonce: 1700000000000 });
  assert.equal(out.ok, true, out.detail);
  const posted = posts.find((p) => p.url.endsWith('/exchange'));
  assert.equal(posted?.body.nonce, 1700000000000);
  assert.equal(posted?.body.action.nonce, 1700000000000);
});

// ---------- usdClassTransfer ----------

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
  assert.equal(posted.url, 'https://api.hyperliquid.xyz/exchange');
  assert.deepEqual(Object.keys(posted.body).sort(), ['action', 'nonce', 'signature']);
  assert.equal(posted.body.nonce, NOW);
  assert.equal(posted.body.action.nonce, NOW);
  assert.equal(posted.body.action.amount, '899.037299');
  assert.equal(posted.body.action.toPerp, true);
  assert.deepEqual(Object.keys(posted.body.signature).sort(), ['r', 's', 'v']);
  assert.equal(posted.body.signature.v, 27);
});

// ---------- the response contract ----------

test('an HTTP 200 carrying status err is a failure, not a success', async () => {
  const out = await sendAsset(
    deps({ unifiedAvailable: '1000.0', exchange: { status: 'err', response: 'Insufficient balance for token transfer' } }),
    { destination: OUTSIDE, amount: 100 },
  );
  assert.equal(out.ok, false);
  assert.match(out.detail, /refused by Hyperliquid/);
  assert.match(out.detail, /Insufficient balance/);
});

test('a non-JSON or non-200 reply is a failure with the body kept for the operator', async () => {
  const bad = await sendAsset(
    deps({ unifiedAvailable: '1000.0', exchangeStatus: 502, exchangeOk: false, exchange: { error: 'bad gateway' } }),
    { destination: OUTSIDE, amount: 100 },
  );
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
  assert.throws(() => toAmountString(1.0000005), /needs more than 6 decimals/);
});

// ---------- reads ----------

test('accountSummary separates the two books and defaults to the app own address', async () => {
  const { fetchImpl, posts } = fakeFetch({ spotUsdc: '899.037299', withdrawable: '0.0' });
  const summary = await accountSummary(deps({ fetchImpl }));

  assert.equal(summary.address, OWN);
  assert.equal(summary.spotUsdc, 899.037299);
  assert.equal(summary.perpWithdrawableUsd, 0);
  assert.equal(summary.openPositions, 0);
  assert.deepEqual(new Set(posts.map((p) => p.url)), new Set(['https://api.hyperliquid.xyz/info']));
});

test('accountSummary reads zero from a malformed number rather than poisoning the guards with NaN', async () => {
  const summary = await accountSummary(deps({ spotUsdc: 'not-a-number', withdrawable: '' }));
  assert.equal(summary.spotUsdc, 0);
  assert.equal(summary.perpWithdrawableUsd, 0);
});

test('accountSummary throws on a non-address and on a failed request', async () => {
  await assert.rejects(() => accountSummary(deps(), 'not-an-address'), /is not an address/);
  const failing = deps({ fetchImpl: async () => jsonResponse({ error: 'nope' }, false, 500) });
  await assert.rejects(() => accountSummary(failing), /failed: 500/);
});

// The venue's own answer is the authoritative unified flag. The balance heuristic stays as a
// fallback because an empty unified account reads 0 on both figures and would otherwise pass
// as standard, and the withdraw rail would then try a usdClassTransfer the venue rejects.
test('accountSummary reads the account mode from userAbstraction, with the balances as fallback', async () => {
  const said = await accountSummary(deps({ abstraction: 'unifiedAccount', withdrawable: '0.0', spotUsdc: '0.0' }));
  assert.equal(said.unified, true);

  const standard = await accountSummary(deps({ abstraction: 'standard', withdrawable: '5.0', spotUsdc: '1.0' }));
  assert.equal(standard.unified, false);

  const inferred = await accountSummary(deps({ abstraction: '', withdrawable: '0.0', unifiedAvailable: '12.0' }));
  assert.equal(inferred.unified, true);
  assert.equal(inferred.availableUsdc, 12);
});

test('userRole tells a never-seen address from an existing one', async () => {
  assert.equal(await userRole(deps({ role: 'missing' }), FRESH), 'missing');
  assert.equal(await userRole(deps({ role: 'user' }), OUTSIDE), 'user');
  assert.equal(await userRole(deps({ role: 'agent' }), OUTSIDE), 'agent');
});

// ---------- the key never leaks ----------

test('no result or action ever carries the private key', async () => {
  const out = await sendAsset(deps({ unifiedAvailable: '1000.0' }), { destination: OUTSIDE, amount: 100 });
  const dumped = JSON.stringify(out);
  assert.equal(dumped.includes(FIXTURE_KEY), false);
  assert.equal(/"privateKey"/.test(dumped), false);
  assert.equal(/0x[0-9a-fA-F]{64}/.test(JSON.stringify(out.action)), false);
});

/* The venue's own ledger of credits, for the reconcile sweep. A deposit 1Click calls SUCCESS is
   confirmed by the account showing a credit, and after the fact the only record of one is this
   ledger: a bridge deposit, or a USDC transfer whose destination is the account, on either book.
   Money moving between the account's own books, and money leaving, are not credits. */
test('usdcCreditedSince sums the deposits and incoming USDC transfers since a time, and nothing else', async () => {
  const posts: Array<{ body: any }> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    posts.push({ body });
    return jsonResponse([
      { time: NOW - 5_000, hash: '0xa', delta: { type: 'deposit', usdc: '10.0' } },
      { time: NOW - 4_000, hash: '0xb', delta: { type: 'spotTransfer', token: 'USDC', amount: '9.97', usdcValue: '9.97', user: '0xsolver', destination: OWN, fee: '0.0' } },
      { time: NOW - 3_000, hash: '0xc', delta: { type: 'internalTransfer', usdc: '5.5', user: '0xsolver', destination: OWN.toUpperCase(), fee: '0.0' } },
      // Leaving, moving between the account's own books, a different token, and a bad number.
      { time: NOW - 2_000, hash: '0xd', delta: { type: 'spotTransfer', token: 'USDC', amount: '100', usdcValue: '100', user: OWN, destination: '0xelse', fee: '0.0' } },
      { time: NOW - 2_000, hash: '0xe', delta: { type: 'accountClassTransfer', usdc: '50', toPerp: true } },
      { time: NOW - 1_000, hash: '0xf', delta: { type: 'withdraw', usdc: '20', fee: '1' } },
      { time: NOW - 1_000, hash: '0xg', delta: { type: 'spotTransfer', token: 'PURR', amount: '3', usdcValue: '0.5', user: '0xsolver', destination: OWN, fee: '0.0' } },
      { time: NOW - 500, hash: '0xh', delta: { type: 'deposit', usdc: 'not-a-number' } },
    ]);
  };
  const seen = await usdcCreditedSince(deps({ fetchImpl }), OWN, NOW - 60_000);
  assert.equal(seen, 25.47);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { type: 'userNonFundingLedgerUpdates', user: OWN, startTime: NOW - 60_000 });
});

test('usdcCreditedSince throws when the ledger will not answer, so the caller can leave the row unconfirmed', async () => {
  const failing = deps({ fetchImpl: async () => jsonResponse({ error: 'nope' }, false, 500) });
  await assert.rejects(() => usdcCreditedSince(failing, OWN, NOW - 60_000), /failed: 500/);
  const garbage = deps({ fetchImpl: async () => jsonResponse({ not: 'a list' }) });
  await assert.rejects(() => usdcCreditedSince(garbage, OWN, NOW - 60_000), /not a list/);
});
