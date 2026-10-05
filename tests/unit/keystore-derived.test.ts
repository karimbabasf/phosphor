// The two keys the wallet derives from its owner key and never stores (src/keystore/derived.ts).
//
// The vectors are the published ones (tests/fixtures/derived-keys.ts, docs/security-model.md),
// checked outside this code when they were written down. Here each is checked again inside Node
// by a second route, so a change to the derivation, to the address code or to the ed25519 key
// code fails by name. Rerun: node scripts/run-tests.ts tests/unit/keystore-derived.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

import {
  ALLOWANCE_INFO,
  DERIVE_SALT,
  GAS_INFO,
  accountsOf,
  deriveAllowanceKey,
  deriveGasSeed,
  deriveKeys,
  ed25519PublicKey,
  evmAddressOf,
  firstScalar,
  gasAccountOf,
} from '../../src/keystore/derived.ts';
import { SE_WRAP_SALT } from '../../src/keystore/sewrap.ts';
import { DERIVED_VECTORS as VECTORS } from '../fixtures/derived-keys.ts';

const N =Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');

/* HKDF written out from RFC 5869 with HMAC, the second route to the same bytes. */
function hkdfByHand(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i += 1) {
    previous = crypto.createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([i])])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

test('the hand-written HKDF is RFC 5869 test case 1, so it can check the derivation', () => {
  const okm = hkdfByHand(Buffer.alloc(22, 0x0b), Buffer.from('000102030405060708090a0b0c', 'hex'), Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), 42);
  assert.equal(okm.toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});

test('a fixed owner key gives a fixed ALLOWANCE address and GAS id: the published vectors', () => {
  for (const v of VECTORS) {
    const old = Buffer.from(v.old, 'hex');
    assert.equal(evmAddressOf(old), v.vault, 'the owner key is the vault it says it is');
    const keys = deriveKeys(old);
    assert.equal(keys.allowance.toString('hex'), v.allowanceKey);
    assert.equal(keys.gas.toString('hex'), v.gasSeed);
    assert.deepEqual(accountsOf(keys), { allowance: v.allowance, gas: v.gas });
    assert.equal(deriveAllowanceKey(old).toString('hex'), v.allowanceKey, 'the same every time');
    assert.equal(deriveGasSeed(old).toString('hex'), v.gasSeed);
  }
});

test('each vector holds by a second route: HMAC by hand, viem for the address, the RFC 8032 key for ed25519', () => {
  for (const v of VECTORS) {
    const old = Buffer.from(v.old, 'hex');
    const salt = Buffer.from('phosphor');
    assert.equal(hkdfByHand(old, salt, Buffer.from('phosphor-allowance-v1'), 32).toString('hex'), v.allowanceKey);
    assert.equal(hkdfByHand(old, salt, Buffer.from('phosphor-gas-v1'), 32).toString('hex'), v.gasSeed);
    assert.equal(privateKeyToAccount(`0x${v.allowanceKey}`).address, v.allowance, 'noble and OpenSSL agree on the address');
    assert.equal(privateKeyToAccount(`0x${v.old}`).address, v.vault);
  }
  // RFC 8032 section 7.1, test 1: the seed and the public key every ed25519 library agrees on.
  assert.equal(gasAccountOf(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
});

test('the GAS seed signs as the account it names', () => {
  const seed = Buffer.from(VECTORS[0].gasSeed, 'hex');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const message = Buffer.from('phosphor gas account check');
  const signature = crypto.sign(null, message, priv);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(VECTORS[0].gas, 'hex')]);
  const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.equal(crypto.verify(null, message, pub, signature), true);
  assert.equal(ed25519PublicKey(seed).toString('hex'), VECTORS[0].gas);
});

test('the derivation is its own domain: salt and info strings no other key in the app uses', () => {
  assert.equal(DERIVE_SALT, 'phosphor');
  assert.equal(ALLOWANCE_INFO, 'phosphor-allowance-v1');
  assert.equal(GAS_INFO, 'phosphor-gas-v1');
  assert.notEqual(DERIVE_SALT, SE_WRAP_SALT, 'the enclave wrap derives under its own salt');
  for (const v of VECTORS) {
    const all = [v.old, v.allowanceKey, v.gasSeed];
    assert.equal(new Set(all).size, 3, 'the owner key, ALLOWANCE and GAS are three different keys');
  }
  // One bit of the owner key changes everything that comes out of it.
  const old = Buffer.from(VECTORS[0].old, 'hex');
  old[31] ^= 1;
  const moved = deriveKeys(old);
  assert.notEqual(moved.allowance.toString('hex'), VECTORS[0].allowanceKey);
  assert.notEqual(moved.gas.toString('hex'), VECTORS[0].gasSeed);
});

test('a draw that is no scalar is redrawn under /1, /2 and wiped', () => {
  const zero = Buffer.alloc(32);
  const order = Buffer.from(N);
  const above = Buffer.from(N);
  above[31] += 1;
  const good = crypto.randomBytes(32);
  good[0] = 0x01;
  const draws: string[] = [];
  const handed: Buffer[] = [];
  const answers = new Map<string, Buffer>([
    ['base', order],
    ['base/1', zero],
    ['base/2', above],
    ['base/3', good],
  ]);
  const got = firstScalar((info) => {
    draws.push(info);
    const out = Buffer.from(answers.get(info) ?? crypto.randomBytes(32));
    handed.push(out);
    return out;
  }, 'base');
  assert.deepEqual(draws, ['base', 'base/1', 'base/2', 'base/3']);
  assert.equal(got.toString('hex'), good.toString('hex'));
  for (const refused of handed.slice(0, 3)) assert.ok(refused.every((b) => b === 0), 'every refused draw is zeroed');
  // n - 1, the largest scalar, is taken as it is.
  const top = Buffer.from(N);
  top[31] -= 1;
  assert.equal(firstScalar(() => Buffer.from(top), 'x').toString('hex'), top.toString('hex'));
  assert.throws(() => firstScalar(() => Buffer.from(N), 'x'), /no secp256k1 scalar/);
});

test('only a real secp256k1 key derives anything', () => {
  for (const bad of [Buffer.alloc(32), Buffer.from(N), Buffer.alloc(31, 1), Buffer.alloc(33, 1)]) {
    assert.throws(() => deriveAllowanceKey(bad), /not a valid secp256k1 private key/);
    assert.throws(() => deriveGasSeed(bad), /not a valid secp256k1 private key/);
  }
  assert.throws(() => deriveAllowanceKey('ab'.repeat(32) as unknown as Buffer), /not a valid/, 'a hex string is not the key bytes');
  assert.throws(() => ed25519PublicKey(Buffer.alloc(31)), /32 bytes/);
});
