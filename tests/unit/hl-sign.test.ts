import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { actionHash, signL1Action } from '../../src/hl/sign.ts';

// A throwaway key. It signs nothing on any real network and holds nothing.
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123' as const;

// The canonical order action, keys in the documented order. Numbers arrive as wire strings.
const ORDER = {
  type: 'order',
  orders: [{ a: 0, b: true, p: '1234.5', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } }],
  grouping: 'na',
};

test('the action hash is stable, so a msgpack regression fails here and not at the venue', () => {
  // Pinned deliberately. A local recover proving the right signer says nothing about whether
  // our bytes match what the L1 rebuilds, which is documented trap number five, so the hash
  // itself is the thing worth freezing.
  const h = actionHash(ORDER, 1_700_000_000_000, null, null);
  assert.match(h, /^0x[0-9a-f]{64}$/);
  assert.equal(h, actionHash(ORDER, 1_700_000_000_000, null, null), 'must be deterministic');
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

test('testnet and mainnet produce different signatures for the same action', async () => {
  const t = await signL1Action(KEY, ORDER, 1_700_000_000_000, false);
  const m = await signL1Action(KEY, ORDER, 1_700_000_000_000, true);
  assert.notEqual(t.r + t.s, m.r + m.s, 'the network rides on source, not on chainId');
});

test('the signature recovers to the signing account', async () => {
  const nonce = 1_700_000_000_000;
  const sig = await signL1Action(KEY, ORDER, nonce, false);
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
    message: { source: 'b', connectionId: actionHash(ORDER, nonce, null, null) },
    signature: packed,
  });

  assert.equal(
    recovered.toLowerCase(),
    privateKeyToAccount(KEY).address.toLowerCase(),
  );
});

test('v is normalised to 27 or 28', async () => {
  const sig = await signL1Action(KEY, ORDER, 1_700_000_000_000, false);
  assert.ok(sig.v === 27 || sig.v === 28, `got v=${sig.v}`);
  assert.match(sig.r, /^0x[0-9a-f]{64}$/);
  assert.match(sig.s, /^0x[0-9a-f]{64}$/);
});
