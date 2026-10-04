// REAUDIT1B, finding RA1B-01 (LOW): the legacy plaintext key file is served as verified.
//
// AU1B-01's fix binds the backed-up flag to an address this process derived from keys it decrypted
// (addressReport().verified). One branch of addressReport() serves a file nothing authenticates as
// verified: the plaintext keys.json read before migration. Its addresses come from addressesOf(),
// which derives from a key when the file holds one and otherwise falls back to the address the file
// merely CLAIMS. A same-user process that moves keys.enc.json aside and writes keys.json holding
// only the proven address (no key at all) therefore reads as verified, and the flag AU1B-01 closed
// for the header comes back through this file.
//
// RED until addressReport() serves a plaintext file's addresses as verified only when each one was
// derived from a key the file holds.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { backupProven } from '../../src/http/vault.ts';
import type { Ctx } from '../../src/http/context.ts';
import { createKeystore, keystorePathFor } from '../../src/keystore/store.ts';
import type { EnclaveRef, Keystore } from '../../src/keystore/store.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import type { VaultPrefs } from '../../src/vault/prefs.ts';
import { tempDir } from './helpers/tmp.ts';

const FAST_KDF = () => ({ name: 'scrypt' as const, N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') });

function enclaveRef(): EnclaveRef {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() };
}

const ctxOf = (keystore: Keystore, prefs: VaultPrefs): Ctx => ({ keystore, vaultPrefs: prefs }) as unknown as Ctx;

/* Wallet A, made behind the enclave and proven backed up. Then the same-user process: the real file
   is moved aside (nothing destroyed) and a plaintext keys.json that holds no key, only A's public
   address, is put where the pre-migration wallet lives. */
function claimScene(): { keysPath: string; prefs: VaultPrefs; addrA: string } {
  const dir = tempDir('reaudit1b-plain-');
  const keysPath = path.join(dir, 'keys.json');
  const a = createKeystore({ keysPath, mode: 'live', kdf: FAST_KDF });
  const addrA = a.createWithEnclave(enclaveRef()).addresses.evm!;
  a.lock();
  const prefs = createVaultPrefs(dir);
  prefs.markBackedUp(Date.now, addrA);
  fs.renameSync(keystorePathFor(keysPath), path.join(dir, '.moved-aside'));
  fs.writeFileSync(keysPath, JSON.stringify({ evm: { address: addrA } }) + '\n');
  return { keysPath, prefs, addrA };
}

test('RA1B-01: a plaintext key file that holds no key is not served as verified', () => {
  const { keysPath, addrA } = claimScene();
  const fresh = createKeystore({ keysPath, mode: 'live', kdf: FAST_KDF });
  assert.equal(fresh.state(), 'needs_migration');
  const report = fresh.addressReport();
  assert.ok(
    report.verified !== true || report.addresses.evm === null,
    `RA1B-01: the file claims ${addrA} and holds no key, and addressReport() serves the claim as verified`,
  );
});

/* The same fallback behind an open. A same-user process can wrap a payload of its own to this Mac's
   enclave key (its public half is in the file), and on a Mac with no marker one Touch ID opens it. A
   payload with no key, only the proven address, then becomes the derived address. updatePayload
   writes such a payload under the real wrap, which stands in for the outside writer here. */
test('RA1B-01: an opened wallet file whose payload holds no key does not have the address it claims served as verified', () => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const ref: EnclaveRef = { keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() };
  const dir = tempDir('reaudit1b-claim-');
  const keysPath = path.join(dir, 'keys.json');
  const open = (store: Keystore): void => {
    const request = store.enclaveRequest()!;
    const dek = seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey, ciphertext: request.ciphertext }, pair.privateKey, Buffer.from(request.aad, 'base64'));
    assert.equal(store.unlockWithDataKey(dek).ok, true);
  };
  const a = createKeystore({ keysPath, mode: 'live', kdf: FAST_KDF });
  const addrA = a.createWithEnclave(ref).addresses.evm!;
  a.lock();
  open(a);
  a.updatePayload(() => ({ evm: { address: addrA } }) as never);
  a.lock();

  const fresh = createKeystore({ keysPath, mode: 'live', kdf: FAST_KDF });
  open(fresh);
  const report = fresh.addressReport();
  assert.ok(
    report.verified !== true || report.addresses.evm === null,
    `RA1B-01: the payload holds no key and claims ${addrA}, and the open serves the claim as derived`,
  );
});

test('RA1B-01: the proven address written as a bare claim into a plaintext file does not inherit the backed-up flag', () => {
  const { keysPath, prefs } = claimScene();
  const fresh = createKeystore({ keysPath, mode: 'live', kdf: FAST_KDF });
  assert.notEqual(
    backupProven(ctxOf(fresh, prefs)).backedUp,
    true,
    'RA1B-01: the AU1B-01 inheritance comes back through the plaintext branch of addressReport()',
  );
});
