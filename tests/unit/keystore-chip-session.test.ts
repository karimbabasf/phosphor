// The session a vault that moved to the chip opens with (PHASE2-PLAN.md C5).
//
// Kind `key` opens as it always has, plus the ALLOWANCE key and the GAS seed derived beside the
// owner key. Kind `chip` (the gate src/main.ts wires from vault.json) opens with the API wallet,
// ALLOWANCE and GAS only: no payload, no owner key, no data key. The owner key then signs one
// action per touch of its own through withOwnerKey, and the buffer it lends is read back here
// after the call to prove it was zeroed. The same for the derived keys after a lock.
//
// No enclave in a test: a software P-256 key plays it, as in keystore-enclave.test.ts. Temp
// directories throughout; the owner key is a published test key (tests/fixtures/derived-keys.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { allowanceKey, derivedAccounts, evmPrivateKey, gasSeed, keyMaterial, useKeystore } from '../../src/keystore/index.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { OWNER_TOUCH_REQUIRED, OwnerTouchRequired, createKeystore, isOwnerTouchRequired } from '../../src/keystore/store.ts';
import type { EnclaveRef, Keystore } from '../../src/keystore/store.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { tempDir } from './helpers/tmp.ts';

const FAST_KDF = () => ({ name: 'scrypt' as const, N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') });
const [V, OTHER] = DERIVED_VECTORS;
const AGENT = generatePrivateKey();

function tmpKeys(): string {
  return path.join(tempDir('phosphor-chip-session-'), 'keys.json');
}

function fakeEnclave(): { ref: EnclaveRef; priv: crypto.KeyObject } {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    ref: { keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() },
    priv: pair.privateKey,
  };
}

function playEnclave(store: Keystore, priv: crypto.KeyObject): Buffer {
  const req = store.enclaveRequest();
  assert.ok(req !== null);
  return seUnwrapWithSoftwareKey({ ephemeralPublicKey: req.ephemeralPublicKey, ciphertext: req.ciphertext }, priv, Buffer.from(req.aad, 'base64'));
}

function zeroed(b: Buffer): boolean {
  return b.length > 0 && b.every((x) => x === 0);
}

/* An enclave wallet holding the vector's owner key and a Hyperliquid API wallet. `moved` is the
   set of vaults vault.json says moved to the chip: what the gate in src/main.ts reads. */
function vaultWith(old: string, moved: Set<string>): { store: Keystore; priv: crypto.KeyObject; keysPath: string } {
  const keysPath = tmpKeys();
  const { ref, priv } = fakeEnclave();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  store.importWithEnclave(ref, { keys: { evm: `0x${old}` } });
  store.updatePayload((p) => ({ ...p, hyperliquidAgents: { mainnet: { privateKey: AGENT, address: privateKeyToAccount(AGENT).address } } }));
  store.lock();
  store.keepOwnerKeyOutWhen((vault) => moved.has(vault.toLowerCase()));
  return { store, priv, keysPath };
}

test.afterEach(() => {
  useKeystore(null);
});

test('kind key: the session holds the owner key as before, and the two derived keys beside it', () => {
  const { store, priv } = vaultWith(V.old, new Set());
  assert.equal(store.derivedAccounts()?.allowance, V.allowance, 'the import already derived the accounts');
  const dek = playEnclave(store, priv);
  assert.deepEqual(store.unlockWithDataKey(dek), { ok: true });
  assert.equal(store.evmPrivateKey(), `0x${V.old}`);
  assert.equal(store.keys().evm?.privateKey, `0x${V.old}`);
  assert.equal(zeroed(dek), false, 'kind key keeps its data key, as 0.10.15 did');
  const allowance = store.allowanceKey();
  const gas = store.gasSeed();
  assert.equal(allowance.toString('hex'), V.allowanceKey);
  assert.equal(gas.toString('hex'), V.gasSeed);
  assert.deepEqual(store.derivedAccounts(), { allowance: V.allowance, gas: V.gas });
  assert.equal(store.apiWallet()?.key, AGENT);

  store.lock();
  assert.ok(zeroed(allowance), 'the lock zeroes the ALLOWANCE key (read back from the buffer the session lent)');
  assert.ok(zeroed(gas), 'and the GAS seed');
  assert.ok(zeroed(dek), 'and the data key');
  assert.throws(() => store.allowanceKey(), /locked/);
  assert.throws(() => store.gasSeed(), /locked/);
  assert.deepEqual(store.derivedAccounts(), { allowance: V.allowance, gas: V.gas }, 'the accounts are public and outlive the lock');
});

test('kind chip: after an unlock, keys() and evmPrivateKey() refuse owner_touch_required', () => {
  const { store, priv, keysPath } = vaultWith(V.old, new Set([V.vault.toLowerCase()]));
  const dek = playEnclave(store, priv);
  assert.deepEqual(store.unlockWithDataKey(dek), { ok: true });
  assert.equal(store.state(), 'unlocked');
  // Before anything asks: the open itself kept no data key, so it held no owner key either.
  assert.ok(zeroed(dek), 'the data key is not kept: it would open the payload again with no touch');
  assert.equal(store.dropOwnerKey(), false, 'there was no owner key to drop');

  for (const ask of [() => store.keys(), () => store.evmPrivateKey()]) {
    assert.throws(ask, (err: unknown) => {
      assert.ok(err instanceof OwnerTouchRequired);
      assert.equal((err as OwnerTouchRequired).code, OWNER_TOUCH_REQUIRED);
      assert.ok(isOwnerTouchRequired(err));
      assert.doesNotMatch((err as Error).message, /locked/, 'never read as a lock, which would queue the move for an unlock that cannot help');
      return true;
    });
  }
  useKeystore(store);
  assert.throws(() => evmPrivateKey(keysPath), OwnerTouchRequired, 'the door every rail signs through refuses too');
  assert.throws(() => keyMaterial(keysPath), OwnerTouchRequired);

  assert.throws(() => store.reveal(), OwnerTouchRequired);
  assert.throws(() => store.updatePayload((p) => p), OwnerTouchRequired);
  assert.throws(() => store.stageRewrap(fakeEnclave().ref), OwnerTouchRequired);

  // What the session does hold.
  assert.equal(store.allowanceKey().toString('hex'), V.allowanceKey);
  assert.equal(allowanceKey().toString('hex'), V.allowanceKey);
  assert.equal(gasSeed().toString('hex'), V.gasSeed);
  assert.deepEqual(derivedAccounts(), { allowance: V.allowance, gas: V.gas });
  assert.equal(store.apiWallet()?.key, AGENT, 'the runner keeps its API wallet');
  assert.equal(store.addresses().evm, V.vault, 'addresses().evm stays VAULT');
});

test('kind chip: shut, a signer is told the owner key needs its own touch, and the derived keys that the wallet is locked', () => {
  const { store } = vaultWith(V.old, new Set([V.vault.toLowerCase()]));
  assert.throws(() => store.keys(), OwnerTouchRequired);
  assert.throws(() => store.evmPrivateKey(), OwnerTouchRequired);
  assert.throws(() => store.allowanceKey(), /locked/);
  assert.throws(() => store.apiWallet(), /locked/, 'the API wallet comes back with an unlock, so it says locked');
});

test('withOwnerKey lends the owner key for one signature and zeroes the buffer (the test reads it)', async () => {
  const { store, priv } = vaultWith(V.old, new Set([V.vault.toLowerCase()]));
  store.unlockWithDataKey(playEnclave(store, priv));

  let lent: Buffer | null = null;
  const dek = playEnclave(store, priv);
  const got = store.withOwnerKey(dek, (key) => {
    lent = key;
    assert.equal(key.toString('hex'), V.old, 'the owner key, as its bytes');
    return privateKeyToAccount(`0x${key.toString('hex')}`).address;
  });
  assert.deepEqual(got, { ok: true, value: V.vault });
  assert.ok(lent !== null && zeroed(lent), 'zeroed as soon as the signer returned');
  assert.ok(zeroed(dek), 'and the data key with it');
  assert.equal(store.state(), 'unlocked');
  assert.throws(() => store.evmPrivateKey(), OwnerTouchRequired, 'the touch lent the key to one call, not to the session');

  // An async signer keeps it until its promise settles, then loses it.
  let later: Buffer | null = null;
  const pending = store.withOwnerKey(playEnclave(store, priv), async (key) => {
    later = key;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(key.toString('hex'), V.old, 'still whole across the await');
    return 'signed';
  });
  assert.ok(pending.ok);
  assert.equal(await pending.value, 'signed');
  assert.ok(later !== null && zeroed(later), 'zeroed once the signature was made');

  // A signer that throws loses it too, and the throw is the caller's.
  let thrown: Buffer | null = null;
  assert.throws(
    () =>
      store.withOwnerKey(playEnclave(store, priv), (key) => {
        thrown = key;
        throw new Error('the venue said no');
      }),
    /the venue said no/,
  );
  assert.ok(thrown !== null && zeroed(thrown));

  let rejected: Buffer | null = null;
  const failing = store.withOwnerKey(playEnclave(store, priv), async (key) => {
    rejected = key;
    throw new Error('refused');
  });
  assert.ok(failing.ok);
  await assert.rejects(failing.value, /refused/);
  assert.ok(rejected !== null && zeroed(rejected));
});

test('withOwnerKey on a shut wallet leaves it shut and tells nobody', () => {
  const { store, priv } = vaultWith(V.old, new Set([V.vault.toLowerCase()]));
  const heard: string[] = [];
  store.onChange((s) => heard.push(s));
  const got = store.withOwnerKey(playEnclave(store, priv), (key) => key.toString('hex'));
  assert.deepEqual(got, { ok: true, value: V.old });
  assert.equal(store.state(), 'locked');
  assert.deepEqual(heard, [], 'no unlock was announced, so no plan re-arms and nothing queued runs');
  assert.throws(() => store.allowanceKey(), /locked/);

  const wrong = crypto.randomBytes(32);
  let called = false;
  const refused = store.withOwnerKey(wrong, () => {
    called = true;
  });
  assert.equal(refused.ok, false);
  assert.equal(called, false, 'a data key that opens nothing lends nothing');
  assert.ok(zeroed(wrong));
});

test('the gate is the vault it names: another wallet in the same app opens as kind key', () => {
  const { store, priv } = vaultWith(OTHER.old, new Set([V.vault.toLowerCase()]));
  store.unlockWithDataKey(playEnclave(store, priv));
  assert.equal(store.evmPrivateKey(), `0x${OTHER.old}`);
  assert.deepEqual(store.derivedAccounts(), { allowance: OTHER.allowance, gas: OTHER.gas });
});

test('a gate that closes on an open wallet takes the owner key and the data key at the first ask', () => {
  const moved = new Set<string>();
  const { store, priv } = vaultWith(V.old, moved);
  const dek = playEnclave(store, priv);
  store.unlockWithDataKey(dek);
  assert.equal(store.evmPrivateKey(), `0x${V.old}`);

  moved.add(V.vault.toLowerCase());
  assert.throws(() => store.evmPrivateKey(), OwnerTouchRequired);
  assert.ok(zeroed(dek), 'the data key went with it');
  assert.equal(store.state(), 'unlocked', 'the rest of the session stays open');
  assert.equal(store.allowanceKey().toString('hex'), V.allowanceKey);

  // The explicit form, for the move to call the moment it has written vault.json.
  const again = vaultWith(V.old, new Set());
  again.store.unlockWithDataKey(playEnclave(again.store, again.priv));
  assert.equal(again.store.dropOwnerKey(), true);
  assert.equal(again.store.dropOwnerKey(), false);
  assert.throws(() => again.store.keys(), OwnerTouchRequired);
});

test('an approval touch on a shut kind chip wallet holds only what kind chip holds, and lets it go', async () => {
  const { store, priv } = vaultWith(V.old, new Set([V.vault.toLowerCase()]));
  let signed = false;
  assert.deepEqual(store.openFor('move-1', playEnclave(store, priv), () => signed, 60_000), { ok: true });
  assert.equal(store.state(), 'locked', 'closing: open to the move already under way only');
  const allowance = store.allowanceKey();
  assert.equal(allowance.toString('hex'), V.allowanceKey);
  assert.throws(() => store.evmPrivateKey(), OwnerTouchRequired);
  signed = true;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(store.keyHeld(), false);
  assert.ok(zeroed(allowance), 'the derived key went with the lock');
});

test('a password wallet under the gate opens the same way', async () => {
  const keysPath = tmpKeys();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  store.keepOwnerKeyOutWhen((vault) => vault.toLowerCase() === V.vault.toLowerCase());
  const password = crypto.randomBytes(12).toString('hex');
  await store.importWallet(password, { keys: { evm: `0x${V.old}` } });
  assert.throws(() => store.keys(), OwnerTouchRequired, 'the import held kind chip from its first open');
  store.lock();
  assert.deepEqual(await store.unlock(password), { ok: true });
  assert.throws(() => store.evmPrivateKey(), OwnerTouchRequired);
  assert.equal(store.gasSeed().toString('hex'), V.gasSeed);
});

test('a gate that throws keeps the owner key out', () => {
  const keysPath = tmpKeys();
  const { ref, priv } = fakeEnclave();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  store.importWithEnclave(ref, { keys: { evm: `0x${V.old}` } });
  store.lock();
  store.keepOwnerKeyOutWhen(() => {
    throw new Error('vault.json unreadable');
  });
  store.unlockWithDataKey(playEnclave(store, priv));
  assert.throws(() => store.keys(), OwnerTouchRequired);
});

test('neither derived key is ever written: every file the wallet wrote is searched for both', () => {
  const moved = new Set<string>();
  const { store, priv, keysPath } = vaultWith(V.old, moved);
  store.unlockWithDataKey(playEnclave(store, priv));
  store.lock();
  moved.add(V.vault.toLowerCase());
  store.unlockWithDataKey(playEnclave(store, priv));
  store.withOwnerKey(playEnclave(store, priv), () => true);
  store.lock();

  const dir = path.dirname(keysPath);
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).map((name) => path.join(dir, name)).filter((p) => fs.statSync(p).isFile());
  assert.ok(files.some((p) => p.endsWith('keys.enc.json')), 'the wallet file is among them');
  const needles = [V.allowanceKey, V.gasSeed].flatMap((hex) => {
    const raw = Buffer.from(hex, 'hex');
    return [Buffer.from(hex), Buffer.from(hex.toUpperCase()), raw, Buffer.from(raw.toString('base64')), Buffer.from(raw.toString('base64url'))];
  });
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    for (const needle of needles) assert.equal(bytes.includes(needle), false, `${path.basename(file)} holds a derived key`);
  }
});

test('the accounts are learned from any decrypt, before any unlock, and forgotten with the wallet', () => {
  const { store, priv, keysPath } = vaultWith(V.old, new Set());
  const cold = createKeystore({ keysPath, kdf: FAST_KDF });
  assert.equal(cold.derivedAccounts(), null, 'a process that never opened the wallet knows no derived account');
  const shown = cold.readWithDataKey(playEnclave(cold, priv), () => true);
  assert.deepEqual(shown, { ok: true, value: true });
  assert.equal(cold.state(), 'locked');
  assert.deepEqual(cold.derivedAccounts(), { allowance: V.allowance, gas: V.gas }, 'a touch that showed the addresses showed these too');
  cold.forget();
  assert.equal(cold.derivedAccounts(), null);
  assert.ok(store.derivedAccounts() !== null);
});
