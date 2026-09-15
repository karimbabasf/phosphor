// The version 2 keystore: a wallet whose data key is wrapped to a Secure Enclave key.
//
// There is no enclave in a test, so a software P-256 key stands in for it: the wrap is done
// exactly as the app does it (seWrap against the public half), and the unwrap is done with the
// private half through seUnwrapWithSoftwareKey, which exists for this file alone. What that
// proves is everything on the Node side of the boundary: the file format, the AAD, the tamper
// check, the lock, the rewrap from a password file and the refusals. What it cannot prove is
// the enclave itself, and that half is measured by scripts/vault-selftest.ts against the real
// sidecar with a real Touch ID.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonical } from '../../src/keystore/envelope.ts';
import { seUnwrapWithSoftwareKey, seWrap } from '../../src/keystore/sewrap.ts';
import { createKeystore, keystorePathFor, readHeader } from '../../src/keystore/store.ts';
import type { EnclaveRef, Keystore } from '../../src/keystore/store.ts';

const FAST_KDF = () => ({ name: 'scrypt' as const, N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') });

function tmpKeys(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-enclave-'));
  return path.join(dir, 'keys.json');
}

/* A software stand-in for the enclave: the public half in X9.63 like the sidecar reports it,
   the private half kept here so the test can play the enclave's part of the unwrap. */
function fakeEnclave(): { ref: EnclaveRef; priv: crypto.KeyObject } {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    ref: { keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() },
    priv: pair.privateKey,
  };
}

/* The enclave's side of an unlock, in software: take what the store hands the relay, unwrap
   it with the private half, and hand the data key back. */
function playEnclave(store: Keystore, priv: crypto.KeyObject): Buffer {
  const req = store.enclaveRequest();
  assert.ok(req !== null, 'a version 2 file always has an unwrap request');
  return seUnwrapWithSoftwareKey(
    { ephemeralPublicKey: req.ephemeralPublicKey, ciphertext: req.ciphertext },
    priv,
    Buffer.from(req.aad, 'base64'),
  );
}

test('the wrap round-trips against a P-256 key and refuses a foreign AAD', () => {
  const { ref, priv } = fakeEnclave();
  const dek = crypto.randomBytes(32);
  const aad = Buffer.from('{"version":2}');
  const wrapped = seWrap(dek, ref.publicKey, aad);
  assert.equal(Buffer.from(wrapped.ephemeralPublicKey, 'base64').length, 65, 'X9.63 ephemeral key');
  assert.equal(Buffer.from(wrapped.ciphertext, 'base64').length, 12 + 32 + 16, 'nonce, 32 bytes, tag');
  assert.deepEqual(seUnwrapWithSoftwareKey(wrapped, priv, aad), dek);
  assert.throws(() => seUnwrapWithSoftwareKey(wrapped, priv, Buffer.from('{"version":3}')));
  const other = fakeEnclave();
  assert.throws(() => seUnwrapWithSoftwareKey(wrapped, other.priv, aad), 'another enclave cannot open it');
});

test('a wallet created behind the enclave writes a version 2 file with no password material', () => {
  const keysPath = tmpKeys();
  const { ref } = fakeEnclave();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  assert.equal(store.custody(), null);
  const made = store.createWithEnclave(ref);
  assert.match(made.addresses.evm ?? '', /^0x[0-9a-fA-F]{40}$/);
  assert.equal(store.state(), 'unlocked', 'open on creation, the person is standing there');
  assert.equal(store.custody(), 'secure-enclave');

  const header = readHeader(keysPath);
  assert.equal(header?.version, 2);
  assert.equal(header?.kdf, undefined, 'no KDF, because no password');
  assert.equal(header?.enclave?.publicKey, ref.publicKey);
  const raw = JSON.parse(fs.readFileSync(keystorePathFor(keysPath), 'utf8'));
  assert.equal(raw.headerProof, undefined, 'version 2 has no proof, the open compares addresses instead');
  assert.equal(typeof raw.wrap.ephemeralPublicKey, 'string');
  assert.equal(raw.wrap.iv, undefined, 'the wrap is an enclave wrap, not a password envelope');
  assert.equal((fs.statSync(keystorePathFor(keysPath)).mode & 0o777), 0o600);
});

test('locked, the enclave unwraps the data key and the store opens with it; a password never does', async () => {
  const keysPath = tmpKeys();
  const { ref, priv } = fakeEnclave();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  const made = store.createWithEnclave(ref);
  assert.equal(store.lock(), true);
  assert.equal(store.state(), 'locked');
  assert.throws(() => store.keys(), /locked/);

  const byPassword = await store.unlock('anything at all');
  assert.equal(byPassword.ok, false);
  assert.equal(!byPassword.ok && byPassword.error, 'enclave_required');

  const dek = playEnclave(store, priv);
  const opened = store.unlockWithDataKey(dek);
  assert.deepEqual(opened, { ok: true });
  assert.equal(store.state(), 'unlocked');
  assert.equal(store.keys().evm?.address, made.addresses.evm);
  assert.deepEqual(store.addressReport(), { addresses: made.addresses, verified: true, tampered: false });
  assert.ok(!dek.every((b) => b === 0), 'the data key is held while the wallet is open');
  store.lock();
  assert.ok(dek.every((b) => b === 0), 'and wiped by the lock');
  assert.deepEqual(store.unlockWithDataKey(playEnclave(store, priv)), { ok: true });

  // A second process opening the same file sees the same wallet.
  const again = createKeystore({ keysPath, kdf: FAST_KDF });
  assert.equal(again.state(), 'locked');
  assert.deepEqual(again.unlockWithDataKey(playEnclave(again, priv)), { ok: true });
  assert.equal(again.keys().evm?.address, made.addresses.evm);
});

test('an edited header address is detected on open and never served', () => {
  const keysPath = tmpKeys();
  const { ref, priv } = fakeEnclave();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  const made = store.createWithEnclave(ref);
  store.lock();

  const file = keystorePathFor(keysPath);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.header.addresses.evm = '0x000000000000000000000000000000000000dEaD';
  fs.writeFileSync(file, JSON.stringify(raw));

  const fresh = createKeystore({ keysPath, kdf: FAST_KDF });
  assert.equal(fresh.addressReport().verified, false, 'an unopened header is served as unverified');
  assert.deepEqual(fresh.unlockWithDataKey(playEnclave(fresh, priv)), { ok: true }, 'the envelopes still open: addresses are outside the AAD');
  const report = fresh.addressReport();
  assert.equal(report.tampered, true);
  assert.equal(report.verified, true);
  assert.equal(report.addresses.evm, made.addresses.evm, 'the derived address wins over the edited header');
});

test('a data key for another file, or a damaged payload, is refused without opening anything', () => {
  const keysPath = tmpKeys();
  const { ref } = fakeEnclave();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  store.createWithEnclave(ref);
  store.lock();
  const wrong = store.unlockWithDataKey(crypto.randomBytes(32));
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.error, 'damaged');
  assert.equal(store.state(), 'locked');
});

test('a password wallet moves behind the enclave in one step and the password wrap is gone', async () => {
  const keysPath = tmpKeys();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  const made = await store.create('a long enough password');
  store.lock();
  assert.equal(store.custody(), 'password');
  assert.equal(readHeader(keysPath)?.version, 1);

  const { ref, priv } = fakeEnclave();
  const refused = await store.rewrapToEnclave('not the password', ref);
  assert.equal(refused.ok, false);
  assert.equal(readHeader(keysPath)?.version, 1, 'a wrong password changes nothing on disk');

  const moved = await store.rewrapToEnclave('a long enough password', ref);
  assert.deepEqual(moved, { ok: true });
  assert.equal(store.custody(), 'secure-enclave');
  assert.equal(readHeader(keysPath)?.version, 2);
  assert.equal(readHeader(keysPath)?.kdf, undefined);
  assert.equal(store.keys().evm?.address, made.addresses.evm, 'same keys, same wallet');
  assert.equal(readHeader(keysPath)?.hasMnemonic, true);

  store.lock();
  assert.equal((await store.unlock('a long enough password')).ok, false, 'the password no longer opens it');
  assert.deepEqual(store.unlockWithDataKey(playEnclave(store, priv)), { ok: true });
});

test('a recovery phrase restores the same wallet behind a new enclave', () => {
  const first = createKeystore({ keysPath: tmpKeys(), kdf: FAST_KDF });
  const made = first.createWithEnclave(fakeEnclave().ref);
  const phrase = first.reveal().mnemonic;
  assert.ok(phrase !== null);

  const { ref } = fakeEnclave();
  const second = createKeystore({ keysPath: tmpKeys(), kdf: FAST_KDF });
  const restored = second.importWithEnclave(ref, { mnemonic: phrase });
  assert.deepEqual(restored.addresses, made.addresses);
  assert.equal(readHeader(second.path().replace(/keys\.enc\.json$/, 'keys.json'))?.custody, 'secure-enclave');
});

test('the payload can be rewritten in place while open, and only while open', () => {
  const keysPath = tmpKeys();
  const { ref, priv } = fakeEnclave();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  const made = store.createWithEnclave(ref);
  const before = canonical(readHeader(keysPath));

  store.updatePayload((p) => ({ ...p, hyperliquidAgents: { mainnet: { address: '0xabc', privateKey: '0x01' } } }));
  assert.equal(store.keys().hyperliquidAgents?.mainnet?.address, '0xabc');
  assert.equal(canonical(readHeader(keysPath)), before, 'the header, and so the AAD, is untouched');

  store.lock();
  assert.throws(() => store.updatePayload((p) => p), /locked/);
  assert.deepEqual(store.unlockWithDataKey(playEnclave(store, priv)), { ok: true });
  assert.equal(store.keys().hyperliquidAgents?.mainnet?.address, '0xabc', 'the rewrite survived a lock and a reopen');
  assert.equal(store.keys().evm?.address, made.addresses.evm);
});

test('forget shreds the file and leaves no wallet', () => {
  const keysPath = tmpKeys();
  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  store.createWithEnclave(fakeEnclave().ref);
  const file = keystorePathFor(keysPath);
  assert.ok(fs.existsSync(file));
  store.forget();
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.state(), 'no_wallet');
  assert.equal(store.custody(), null);
  assert.deepEqual(store.addressReport().addresses, { evm: null, solana: null, near: null, nearPublicKey: null });
});
