// AUDIT1B red test. Finding AU1B-01 (LOW): the backed-up flag's binding to its wallet
// (`backedUpFor`) is checked against the live file's header address, which is unverified and
// attacker-editable. Because a wallet's EVM address is public, a file swapped in from outside the
// app can copy that address into its header and so INHERIT the backed-up flag, which the
// `backedUpFor` field was added to prevent (custody-backup, CONTRACTS.md "Backup proven").
//
// This test FAILS against build/custody-bind: backupProven returns backedUp:true for a locked,
// never-opened file that is a DIFFERENT wallet whose header merely claims the proven address.
// It is a red test only: do not change product code to make it pass here.
//
// Impact is LOW because the security-relevant consumer (the restore guard, openableHere) backstops
// with the service pin; but the Vault's "Bind" card and the forget route read backupProven as the
// backed-up gate, and this shows that gate trusts attacker-controlled bytes.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { backupProven } from '../../src/http/vault.ts';
import { createKeystore, keystorePathFor } from '../../src/keystore/store.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { seWrap } from '../../src/keystore/sewrap.ts';
import type { EnclaveRef, Ctx } from '../../src/keystore/store.ts';
import { tempDir } from './helpers/tmp.ts';

const FAST_KDF = () => ({ name: 'scrypt' as const, N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') });

function fakeEnclave(): EnclaveRef {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() };
}

test('AU1B-01: a swapped-in file that copies the proven public address into its header inherits the backed-up flag', () => {
  // Wallet A: the real backed-up wallet.
  const dirA = tempDir('audit1b-A-');
  const keysA = path.join(dirA, 'keys.json');
  const a = createKeystore({ keysPath: keysA, mode: 'live', kdf: FAST_KDF });
  const madeA = a.createWithEnclave(fakeEnclave());
  const addrA = madeA.addresses.evm!;
  a.lock();

  // Prove A's backup: the flag is bound to A's address via backedUpFor.
  const prefs = createVaultPrefs(dirA);
  prefs.markBackedUp(Date.now, addrA);
  assert.equal(prefs.get().backedUpFor, addrA.toLowerCase());

  // Wallet B: a different wallet an attacker made (any process can wrap to any public key).
  const dirB = tempDir('audit1b-B-');
  const keysB = path.join(dirB, 'keys.json');
  const b = createKeystore({ keysPath: keysB, mode: 'live', kdf: FAST_KDF });
  b.createWithEnclave(fakeEnclave());
  const fileB = JSON.parse(fs.readFileSync(keystorePathFor(keysB), 'utf8'));
  const addrB = fileB.header.addresses.evm as string;
  assert.notEqual(addrB.toLowerCase(), addrA.toLowerCase(), 'B is a different wallet');

  // The attacker overwrites A's live file with B, but writes A's PUBLIC address into the header.
  // (The header is not authenticated against the payload for the address field; the app only
  // catches this at unwrap time via the service pin, which backupProven never consults.)
  fileB.header.addresses.evm = addrA;
  fs.writeFileSync(keystorePathFor(keysA), JSON.stringify(fileB, null, 2) + '\n');

  // A fresh process that has never opened the wallet: addressReport reads the (lying) header.
  const fresh = createKeystore({ keysPath: keysA, mode: 'live', kdf: FAST_KDF });
  const ctx = { keystore: fresh, vaultPrefs: prefs } as unknown as Ctx;

  const proven = backupProven(ctx);
  // The live file is wallet B, which has NOT been backed up. The flag must not transfer to it.
  assert.equal(
    proven.backedUp,
    false,
    'AU1B-01: backupProven trusts the unverified header address, so a swapped wallet file inherits the backed-up flag',
  );
});
