import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { actionHash, signL1Action } from '../../src/hl/sign.ts';
import { buildOrderAction, buildTriggerAction } from '../../src/hl/exchange.ts';

// A throwaway key. It signs nothing on any real network and holds nothing. It is also the key
// the Hyperliquid Python SDK's own signing tests use, which is what lets the vectors below be
// theirs rather than ours.
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123' as const;

// The canonical order action, keys in the documented order. Numbers arrive as wire strings.
const ORDER = {
  type: 'order',
  orders: [{ a: 0, b: true, p: '1234.5', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } }],
  grouping: 'na',
};

/* ---------- the vendor's vectors ----------

   Every value below is transcribed from tests/signing_test.py in hyperliquid-dex/hyperliquid-python-sdk
   (master, read 2026-09-15): the action as order_request_to_order_wire and order_wires_to_order_action
   build it, the nonce the test passes, and the hash or the r, s, v the test asserts. This test used
   to say "pinned deliberately" and then compare the hash to itself, so a msgpack regression passed
   CI and surfaced at the venue as "does not exist". A hash the vendor's SDK produces is the only
   thing worth freezing: it is what the L1 rebuilds.
   The SDK's to_hex strips leading zeroes from r and s, so the parts are compared as numbers. */

// test_phantom_agent_creation_matches_production: ETH is asset 4, Ioc, and the hash is the
// connectionId the phantom agent carries.
const PRODUCTION_ORDER = {
  type: 'order',
  orders: [{ a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } }],
  grouping: 'na',
};
const PRODUCTION_NONCE = 1_677_777_606_040;
const PRODUCTION_HASH = '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908';

// test_l1_action_signing_order_matches: asset 1, 100 at 100, Gtc, nonce 0, mainnet.
const GTC_ORDER = {
  type: 'order',
  orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } }],
  grouping: 'na',
};
const GTC_SIGNATURE = {
  r: '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e',
  s: '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e',
  v: 28,
};

// test_l1_action_signing_order_with_cloid_matches: the same order with a client order id.
const CLOID_ORDER = {
  type: 'order',
  orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } }, c: '0x00000000000000000000000000000001' }],
  grouping: 'na',
};
const CLOID_SIGNATURE = {
  r: '0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3',
  s: '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da',
  v: 27,
};

// test_l1_action_signing_tpsl_order_matches: a stop, market on trigger at 103.
const TPSL_ORDER = {
  type: 'order',
  orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { trigger: { isMarket: true, triggerPx: '103', tpsl: 'sl' } } }],
  grouping: 'na',
};
const TPSL_SIGNATURE = {
  r: '0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9',
  s: '0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405',
  v: 27,
};

// test_l1_action_signing_matches and _with_vault: a dummy action whose one number is
// float_to_int_for_hashing(1000), an integer above 2^32, signed with and without a vault.
const DUMMY = { type: 'dummy', num: 100_000_000_000 };
const DUMMY_SIGNATURE = {
  r: '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298',
  s: '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8',
  v: 27,
};
const VAULT = '0x1719884eb866cb12b2287399b15f7db5e7d775ea';
const VAULT_SIGNATURE = {
  r: '0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239',
  s: '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c',
  v: 28,
};

// test_schedule_cancel_action, the second half: an action carrying a time.
const SCHEDULE_CANCEL = { type: 'scheduleCancel', time: 123_456_789 };
const SCHEDULE_CANCEL_SIGNATURE = {
  r: '0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55',
  s: '0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b',
  v: 28,
};

function same(actual: { r: string; s: string; v: number }, expected: { r: string; s: string; v: number }, what: string): void {
  assert.equal(BigInt(actual.r), BigInt(expected.r), `${what}: r`);
  assert.equal(BigInt(actual.s), BigInt(expected.s), `${what}: s`);
  assert.equal(actual.v, expected.v, `${what}: v`);
}

test("the action hash reproduces the SDK's production vector byte for byte", () => {
  assert.equal(actionHash(PRODUCTION_ORDER, PRODUCTION_NONCE, null, null), PRODUCTION_HASH);
});

test("signing reproduces the SDK's mainnet signatures: a Gtc order, one with a cloid, and a stop", async () => {
  same(await signL1Action(KEY, GTC_ORDER, 0), GTC_SIGNATURE, 'Gtc order');
  same(await signL1Action(KEY, CLOID_ORDER, 0), CLOID_SIGNATURE, 'order with cloid');
  same(await signL1Action(KEY, TPSL_ORDER, 0), TPSL_SIGNATURE, 'trigger order');
});

test("signing reproduces the SDK's vectors for an integer above 2^32, a vault, and a scheduled cancel", async () => {
  same(await signL1Action(KEY, DUMMY, 0), DUMMY_SIGNATURE, 'dummy');
  same(await signL1Action(KEY, DUMMY, 0, VAULT), VAULT_SIGNATURE, 'dummy with vault');
  same(await signL1Action(KEY, SCHEDULE_CANCEL, 0), SCHEDULE_CANCEL_SIGNATURE, 'scheduleCancel');
});

test("the builders in exchange.ts produce the SDK's wire shape, so the vectors cover the path the runner takes", () => {
  // ETH has 4 size decimals on the venue, which is what makes 1670.1 and 0.0147 legal.
  const production = buildOrderAction([{ assetId: 4, isBuy: true, price: 1670.1, size: 0.0147, reduceOnly: false, tif: 'Ioc', szDecimals: 4 }]);
  assert.deepEqual(production, PRODUCTION_ORDER);
  assert.equal(actionHash(production, PRODUCTION_NONCE, null, null), PRODUCTION_HASH);

  const gtc = buildOrderAction([{ assetId: 1, isBuy: true, price: 100, size: 100, reduceOnly: false, tif: 'Gtc', szDecimals: 0 }]);
  assert.deepEqual(gtc, GTC_ORDER);
  const cloid = buildOrderAction([{ assetId: 1, isBuy: true, price: 100, size: 100, reduceOnly: false, tif: 'Gtc', szDecimals: 0, cloid: '0x00000000000000000000000000000001' }]);
  assert.deepEqual(cloid, CLOID_ORDER);
  const stop = buildTriggerAction([{ assetId: 1, isBuy: true, size: 100, triggerPx: 103, limitPx: 100, isMarket: true, tpsl: 'sl', szDecimals: 0, reduceOnly: false }], 'na');
  assert.deepEqual(stop, TPSL_ORDER);
});

test('the action hash is deterministic', () => {
  const h = actionHash(ORDER, 1_700_000_000_000, null, null);
  assert.match(h, /^0x[0-9a-f]{64}$/);
  assert.equal(h, actionHash(ORDER, 1_700_000_000_000, null, null));
});

test('the nonce is part of the hash', () => {
  const a = actionHash(ORDER, 1_700_000_000_000, null, null);
  const b = actionHash(ORDER, 1_700_000_000_001, null, null);
  assert.notEqual(a, b);
});

test('a nonce above 2^32 is not truncated', () => {
  // Unix milliseconds exceed 32 bits. A bit-shift implementation silently wraps here and
  // signs the wrong nonce, which the venue rejects with a message about the wallet instead.
  const a = actionHash(ORDER, 1_700_000_000_000, null, null);
  const b = actionHash(ORDER, 1_700_000_000_000 + 2 ** 32, null, null);
  assert.notEqual(a, b);
});

test('the vault marker changes the hash, and its case does not', () => {
  const none = actionHash(ORDER, 1, null, null);
  const lower = actionHash(ORDER, 1, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', null);
  const upper = actionHash(ORDER, 1, '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD', null);
  assert.notEqual(none, lower, 'a vault address must be in the hash');
  assert.equal(lower, upper, 'documented trap four: addresses are lowercased before signing');
});

test('expiresAfter changes the hash when present', () => {
  assert.notEqual(actionHash(ORDER, 1, null, null), actionHash(ORDER, 1, null, 1_700_000_060_000));
});

test('trailing zeroes change the hash, which is why numbers arrive as wire strings', () => {
  const a = actionHash({ ...ORDER, orders: [{ ...ORDER.orders[0], p: '1234.5' }] }, 1, null, null);
  const b = actionHash({ ...ORDER, orders: [{ ...ORDER.orders[0], p: '1234.50' }] }, 1, null, null);
  assert.notEqual(a, b, 'documented trap three');
});

test('field order is part of the hash', () => {
  const reordered = { orders: ORDER.orders, type: 'order', grouping: 'na' };
  assert.notEqual(
    actionHash(ORDER, 1, null, null),
    actionHash(reordered, 1, null, null),
    'documented trap two: msgpack must not sort keys',
  );
});

test('the signature recovers to the signing account', async () => {
  const nonce = 1_700_000_000_000;
  const sig = await signL1Action(KEY, ORDER, nonce);
  const packed = `${sig.r}${sig.s.slice(2)}${(sig.v - 27).toString(16).padStart(2, '0')}` as `0x${string}`;

  const recovered = await recoverTypedDataAddress({
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source: 'a', connectionId: actionHash(ORDER, nonce, null, null) },
    signature: packed,
  });

  assert.equal(
    recovered.toLowerCase(),
    privateKeyToAccount(KEY).address.toLowerCase(),
  );
});

test('v is normalised to 27 or 28', async () => {
  const sig = await signL1Action(KEY, ORDER, 1_700_000_000_000);
  assert.ok(sig.v === 27 || sig.v === 28, `got v=${sig.v}`);
  assert.match(sig.r, /^0x[0-9a-f]{64}$/);
  assert.match(sig.s, /^0x[0-9a-f]{64}$/);
});
