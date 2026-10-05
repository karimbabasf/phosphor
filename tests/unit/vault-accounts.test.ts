// Which account does what (src/vault/accounts.ts, PHASE2-PLAN.md C5), and the gate that keeps the
// owner key out of the session once the vault moved (src/main.ts wires it from vault.json).
//
// `chip` takes the chip service's word for it: a status answer naming the key vault.json pins,
// with a marker for this vault and the allowance these keys derive. Anything less is `broken`,
// unchecked until the service has answered. The status answers here are made up in the shape C1
// gives them; the keystore and vault.json are real, in temp directories.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base58Encode } from '../../src/chain/near.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { OwnerTouchRequired, createKeystore } from '../../src/keystore/store.ts';
import { accountsFrom, createAccounts, ownerKeyOut } from '../../src/vault/accounts.ts';
import type { ChipStatus } from '../../src/vault/accounts.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import type { ChipPrefs } from '../../src/vault/prefs.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { tempDir } from './helpers/tmp.ts';

const [V, OTHER] = DERIVED_VECTORS;
const KEY_REF = 'chip:com.karimbabasf.phosphor.chip.p2-test.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
const RECOVERY = '0x' + '5e'.repeat(20);

function chipPublicKey(): string {
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return 'p256:' + base58Encode(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
}

const PUBLIC_KEY = chipPublicKey();
const CHIP: ChipPrefs = { keyRef: KEY_REF, publicKey: PUBLIC_KEY, account: V.vault.toLowerCase(), migratedAt: '2026-10-04T12:00:00.000Z' };
const DERIVED = { allowance: V.allowance as `0x${string}`, gas: V.gas };

function statusWith(marker: Partial<ChipStatus['chips'][number]['marker']> | null, entry: Partial<ChipStatus['chips'][number]> = {}): ChipStatus {
  return {
    keychainHome: true,
    chips: [
      {
        keyRef: KEY_REF,
        publicKey: PUBLIC_KEY,
        fresh: false,
        marker: marker === null ? null : { account: V.vault.toLowerCase(), allowance: V.allowance.toLowerCase(), recovery: RECOVERY, at: '2026-10-04T11:59:00.000Z', ...marker },
        ...entry,
      },
    ],
  };
}

test('the gate: the owner key stays out only for the vault vault.json says moved', () => {
  assert.equal(ownerKeyOut({ chip: null }, V.vault), false);
  assert.equal(ownerKeyOut({ chip: CHIP }, V.vault), true);
  assert.equal(ownerKeyOut({ chip: CHIP }, V.vault.toUpperCase().replace('0X', '0x')), true, 'case is not identity');
  assert.equal(ownerKeyOut({ chip: CHIP }, OTHER.vault), false, 'another wallet opened in this data folder never moved');
  const unreadable = { keyRef: '', publicKey: '', account: '', migratedAt: '' };
  assert.equal(ownerKeyOut({ chip: unreadable }, OTHER.vault), true, 'an entry that names no account it can read keeps every key out');
});

test('kind key: VAULT spends, and the derived accounts stand beside it', () => {
  assert.deepEqual(accountsFrom({ vault: V.vault, derived: DERIVED, chip: null, status: null }), {
    kind: 'key',
    vault: V.vault,
    spend: V.vault,
    allowance: V.allowance,
    gas: V.gas,
    chip: null,
    checked: true,
  });
  assert.equal(accountsFrom({ vault: OTHER.vault, derived: null, chip: CHIP, status: statusWith({}) }).kind, 'key', 'an entry for another vault is not this one');
  assert.deepEqual(accountsFrom({ vault: null, derived: null, chip: CHIP, status: null }), {
    kind: 'key',
    vault: null,
    spend: null,
    allowance: null,
    gas: null,
    chip: null,
    checked: true,
  });
});

test('kind chip: the service shows the marker for this vault, and ALLOWANCE spends', () => {
  assert.deepEqual(accountsFrom({ vault: V.vault, derived: DERIVED, chip: CHIP, status: statusWith({}) }), {
    kind: 'chip',
    vault: V.vault,
    spend: V.allowance,
    allowance: V.allowance,
    gas: V.gas,
    chip: { keyRef: KEY_REF, publicKey: PUBLIC_KEY },
    checked: true,
  });
  const cold = accountsFrom({ vault: V.vault, derived: null, chip: CHIP, status: statusWith({}) });
  assert.equal(cold.kind, 'chip');
  assert.deepEqual([cold.allowance, cold.spend, cold.gas], [null, null, null], 'before the first open no allowance is believed, the pinned one included');
});

test('kind broken: unchecked until the service answers, then any mismatch is broken', () => {
  const unchecked = accountsFrom({ vault: V.vault, derived: DERIVED, chip: CHIP, status: null });
  assert.deepEqual([unchecked.kind, unchecked.checked, unchecked.spend, unchecked.chip], ['broken', false, V.allowance, null]);

  const cases: [string, ChipStatus, ChipPrefs?][] = [
    ['no marker', statusWith(null)],
    ['no entry for the key', { keychainHome: true, chips: [] }],
    ['the marker names another vault', statusWith({ account: OTHER.vault.toLowerCase() })],
    ['the marker pins another allowance', statusWith({ allowance: OTHER.allowance })],
    ['the key is not the one vault.json pinned', statusWith({}, { publicKey: chipPublicKey() })],
    ['vault.json names another key', statusWith({}), { ...CHIP, keyRef: KEY_REF.replace('0F1E', '1F1E') }],
    ['an entry vault.json cannot read', statusWith({}), { keyRef: '', publicKey: '', account: '', migratedAt: '' }],
  ];
  for (const [why, status, chip] of cases) {
    const got = accountsFrom({ vault: V.vault, derived: DERIVED, chip: chip ?? CHIP, status });
    assert.deepEqual([got.kind, got.checked, got.chip, got.spend, got.vault], ['broken', true, null, V.allowance, V.vault], why);
  }
});

test('refresh asks the service about the key vault.json names, and a failed ask changes nothing', async () => {
  const dir = tempDir('phosphor-accounts-');
  const prefs = createVaultPrefs(dir);
  const asked: string[] = [];
  let answer: () => Promise<ChipStatus> = async () => statusWith({});
  const accounts = createAccounts({
    keystore: { addresses: () => ({ evm: V.vault }), derivedAccounts: () => DERIVED },
    prefs,
    chipStatus: (keyRef) => {
      asked.push(keyRef);
      return answer();
    },
  });
  assert.equal((await accounts.refresh()).kind, 'key');
  assert.deepEqual(asked, [], 'a vault that never moved asks nothing');

  prefs.setChip({ keyRef: KEY_REF, publicKey: PUBLIC_KEY, account: V.vault });
  assert.deepEqual([accounts.accounts().kind, accounts.accounts().checked], ['broken', false]);
  assert.equal((await accounts.refresh()).kind, 'chip');
  assert.deepEqual(asked, [KEY_REF]);

  answer = async () => {
    throw new Error('keychain_unavailable');
  };
  assert.equal((await accounts.refresh()).kind, 'chip', 'a refusal is not an answer: the last one stands');
  answer = async () => statusWith(null);
  assert.deepEqual([(await accounts.refresh()).kind, accounts.accounts().checked], ['broken', true]);

  prefs.setChip({ keyRef: KEY_REF.replace('0F1E', '2F1E'), publicKey: PUBLIC_KEY, account: V.vault });
  assert.deepEqual([accounts.accounts().kind, accounts.accounts().checked], ['broken', false], 'an answer about another key is no answer about this one');

  const noService = createAccounts({ keystore: { addresses: () => ({ evm: V.vault }), derivedAccounts: () => DERIVED }, prefs });
  assert.deepEqual([(await noService.refresh()).kind, noService.accounts().checked], ['broken', false]);
});

test('end to end: vault.json, the gate as src/main.ts wires it, the keystore and the accounts agree', async () => {
  const dir = tempDir('phosphor-accounts-e2e-');
  const keysPath = path.join(dir, 'keys.json');
  const prefs = createVaultPrefs(path.join(dir, 'state'));
  fs.mkdirSync(path.join(dir, 'state'));
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const store = createKeystore({ keysPath, kdf: () => ({ name: 'scrypt', N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') }) });
  store.keepOwnerKeyOutWhen((vault) => ownerKeyOut(prefs.get(), vault));
  store.importWithEnclave({ keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() }, { keys: { evm: `0x${V.old}` } });
  const accounts = createAccounts({ keystore: store, prefs, chipStatus: async () => statusWith({}) });
  assert.deepEqual(await accounts.refresh(), { kind: 'key', vault: V.vault, spend: V.vault, allowance: V.allowance, gas: V.gas, chip: null, checked: true });
  assert.equal(store.evmPrivateKey(), `0x${V.old}`);

  // The move finished: vault.json is written, the open session lets go of the owner key.
  prefs.setChip({ keyRef: KEY_REF, publicKey: PUBLIC_KEY, account: V.vault });
  assert.equal(store.dropOwnerKey(), true);
  assert.deepEqual(await accounts.refresh(), { kind: 'chip', vault: V.vault, spend: V.allowance, allowance: V.allowance, gas: V.gas, chip: { keyRef: KEY_REF, publicKey: PUBLIC_KEY }, checked: true });

  store.lock();
  const req = store.enclaveRequest();
  assert.ok(req !== null);
  store.unlockWithDataKey(seUnwrapWithSoftwareKey({ ephemeralPublicKey: req.ephemeralPublicKey, ciphertext: req.ciphertext }, pair.privateKey, Buffer.from(req.aad, 'base64')));
  assert.throws(() => store.keys(), OwnerTouchRequired, 'the next open is kind chip from the start');
  assert.equal(store.allowanceKey().toString('hex'), V.allowanceKey);
  assert.equal(accounts.accounts().spend, V.allowance);
});

test('the app wires the gate from vault.json before anything can open the wallet', () => {
  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main.ts'), 'utf8');
  // vault.json's word, or the chip service's marker (src/vault/chip.ts ownerKeyGate, tests/unit/vault-chip.test.ts).
  const gate = main.indexOf('keystore.keepOwnerKeyOutWhen(ownerKeyStaysOut);');
  assert.ok(gate > 0, 'src/main.ts sets the gate on the one keystore the app has');
  assert.ok(gate < main.indexOf('const server = createServer('), 'before the server, so before any route can open the wallet');
});
