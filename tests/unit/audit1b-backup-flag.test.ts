// AUDIT1B, finding AU1B-01 (LOW): the backed-up flag's binding to its wallet (`backedUpFor`) was
// checked against the live file's header address, which is unverified and attacker-editable.
// Because a wallet's EVM address is public, a file swapped in from outside the app could copy that
// address into its header and so INHERIT the backed-up flag, which the `backedUpFor` field was
// added to prevent (custody-backup, CONTRACTS.md "Backup proven").
//
// The first test was audit1b's red test: it failed against build/custody-bind, where backupProven
// returned backedUp:true for a locked, never-opened file that is a DIFFERENT wallet whose header
// merely claims the proven address. fix-au1b binds the flag to the address this process derived
// from the keys it decrypted. Before any open there is none, so the answer is null (not known
// yet), never true; the second test opens the swapped file and the flag is gone; the third is the
// honest wallet, which reads backed up once opened and stays so after a lock.

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

/* This Mac's enclave, in software: the key pair stays here, so a test can answer the Touch ID. */
function softEnclave(): { ref: () => EnclaveRef; priv: crypto.KeyObject } {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    ref: () => ({ keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() }),
    priv: pair.privateKey,
  };
}

/* The open a Touch ID gives: the enclave unwraps the data key the file in place is wrapped with. */
function openWith(store: Keystore, mac: crypto.KeyObject): void {
  const request = store.enclaveRequest();
  assert.ok(request !== null);
  const dek = seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey, ciphertext: request.ciphertext }, mac, Buffer.from(request.aad, 'base64'));
  const opened = store.unlockWithDataKey(dek);
  assert.equal(opened.ok, true, JSON.stringify(opened));
}

/* Wallet A, made and proven, then a different wallet B wrapped to the same enclave key (anyone can
   wrap to it: its public half is in the file) with A's public address written into its header,
   copied over A's file the way a same-user process can. */
function swappedScene(): { keysA: string; prefs: VaultPrefs; mac: crypto.KeyObject; addrA: string; addrB: string; fileA: string } {
  const mac = softEnclave();
  const dirA = tempDir('audit1b-A-');
  const keysA = path.join(dirA, 'keys.json');
  const a = createKeystore({ keysPath: keysA, mode: 'live', kdf: FAST_KDF });
  const addrA = a.createWithEnclave(mac.ref()).addresses.evm!;
  a.lock();
  const fileA = fs.readFileSync(keystorePathFor(keysA), 'utf8');

  const prefs = createVaultPrefs(dirA);
  prefs.markBackedUp(Date.now, addrA);
  assert.equal(prefs.get().backedUpFor, addrA.toLowerCase());

  const keysB = path.join(tempDir('audit1b-B-'), 'keys.json');
  createKeystore({ keysPath: keysB, mode: 'live', kdf: FAST_KDF }).createWithEnclave(mac.ref());
  const fileB = JSON.parse(fs.readFileSync(keystorePathFor(keysB), 'utf8'));
  const addrB = fileB.header.addresses.evm as string;
  assert.notEqual(addrB.toLowerCase(), addrA.toLowerCase(), 'B is a different wallet');
  // The header's addresses are outside the AAD on purpose, so B still opens with A's in it.
  fileB.header.addresses.evm = addrA;
  fs.writeFileSync(keystorePathFor(keysA), JSON.stringify(fileB, null, 2) + '\n');
  return { keysA, prefs, mac: mac.priv, addrA, addrB, fileA };
}

const ctxOf = (keystore: Keystore, prefs: VaultPrefs): Ctx => ({ keystore, vaultPrefs: prefs }) as unknown as Ctx;

test('AU1B-01: a swapped-in file that copies the proven public address into its header does not inherit the backed-up flag', () => {
  const { keysA, prefs } = swappedScene();

  // A fresh process that has never opened the wallet: addressReport reads the (lying) header.
  const fresh = createKeystore({ keysPath: keysA, mode: 'live', kdf: FAST_KDF });
  assert.equal(fresh.addressReport().verified, false);
  const proven = backupProven(ctxOf(fresh, prefs));
  // The live file is wallet B, which has NOT been backed up. The flag must not transfer to it.
  assert.notEqual(proven.backedUp, true, 'AU1B-01: backupProven trusts the unverified header address, so a swapped wallet file inherits the backed-up flag');
  assert.deepEqual(proven, { backedUp: null, backedUpAt: null }, 'not known until this process opens the wallet');
});

test('AU1B-01: the swapped file loses the flag for good once it is opened: its keys are another wallet', () => {
  const { keysA, prefs, mac, addrB } = swappedScene();
  const fresh = createKeystore({ keysPath: keysA, mode: 'live', kdf: FAST_KDF });
  openWith(fresh, mac);
  const report = fresh.addressReport();
  assert.deepEqual([report.verified, report.tampered, report.addresses.evm], [true, true, addrB], 'the open derived B and saw the header lie');
  assert.deepEqual(backupProven(ctxOf(fresh, prefs)), { backedUp: false, backedUpAt: null });
  fresh.lock();
  assert.equal(backupProven(ctxOf(fresh, prefs)).backedUp, false, 'a lock brings back nothing the open took away');
});

test('AU1B-01: the proven wallet itself reads backed up once this process has opened it, and stays so after a lock', () => {
  const { keysA, prefs, mac, fileA } = swappedScene();
  fs.writeFileSync(keystorePathFor(keysA), fileA);
  const fresh = createKeystore({ keysPath: keysA, mode: 'live', kdf: FAST_KDF });
  assert.equal(backupProven(ctxOf(fresh, prefs)).backedUp, null, 'the honest file is not known before an open either: the header is all there is');
  openWith(fresh, mac);
  const opened = backupProven(ctxOf(fresh, prefs));
  assert.deepEqual(opened, { backedUp: true, backedUpAt: prefs.get().backedUpAt });
  fresh.lock();
  assert.deepEqual(backupProven(ctxOf(fresh, prefs)), opened, 'a locked wallet this process opened keeps its proof');
});
