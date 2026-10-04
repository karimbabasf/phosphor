// The rails switch (PHASE2-PLAN.md C6): which account the live intents signer signs for, and with
// which key, in each kind of wallet. Kind `key` signs for VAULT with the owner key, as 0.10.15
// did. Kind `chip` and kind `broken` sign for ALLOWANCE with the allowance key the keystore
// derives, and that key signs only payloads naming its own account. Drafts name the same account
// (src/proposals/draft.ts ourIntentsAddress) and the ledger reads it beside the vault
// (spendAccountId); the vault stays the account deposits and the trading account name.
//
// The keystore, vault.json and the accounts are real, in temp directories; the chip service's
// status answer is made up in C1's shape. Owner keys are the published test vectors
// (tests/fixtures/derived-keys.ts). No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base58Encode } from '../../src/chain/near.ts';
import { ALLOWANCE_UNKNOWN, liveIntentsSigner, railAccounts, useRailAccounts } from '../../src/intents-sign.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import type { Keystore } from '../../src/keystore/index.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { intentsAccountId, spendAccountId } from '../../src/ledger/index.ts';
import { ourEvmAddress, ourIntentsAddress } from '../../src/proposals/draft.ts';
import type { PCtx } from '../../src/proposals/lifecycle.ts';
import type { AppConfig } from '../../src/types.ts';
import { createAccounts, ownerKeyOut } from '../../src/vault/accounts.ts';
import type { ChipStatus } from '../../src/vault/accounts.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { signerOf } from './helpers/rail-kinds.ts';
import { tempDir } from './helpers/tmp.ts';

const [V] = DERIVED_VECTORS;
const KEY_REF = 'chip:com.karimbabasf.phosphor.chip.p2-test.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
const RECOVERY = '0x' + '5e'.repeat(20);

function chipPublicKey(): string {
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return 'p256:' + base58Encode(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
}
const PUBLIC_KEY = chipPublicKey();

function marked(): ChipStatus {
  return {
    keychainHome: true,
    chips: [{ keyRef: KEY_REF, publicKey: PUBLIC_KEY, fresh: false, marker: { account: V.vault.toLowerCase(), allowance: V.allowance.toLowerCase(), recovery: RECOVERY, at: '2026-10-04T11:59:00.000Z' } }],
  };
}

// A payload the way the rails write one: one JSON object naming its signer.
function payloadFor(signer: string, extra = ''): string {
  return `{"signer_id":"${signer.toLowerCase()}","verifying_contract":"intents.near","deadline":"2026-10-04T12:02:00.000Z","nonce":"AAAA",${extra}"intents":[]}`;
}

type World = { keysPath: string; store: Keystore; prefs: ReturnType<typeof createVaultPrefs>; open(): void; accounts: ReturnType<typeof createAccounts> };

/* An enclave wallet holding the vector's owner key, with the gate and the accounts wired the way
   src/main.ts wires them, a software P-256 key playing the enclave. */
function world(status: () => Promise<ChipStatus> = async () => marked()): World {
  const dir = tempDir('phosphor-rails-accounts-');
  const keysPath = path.join(dir, 'keys.json');
  fs.mkdirSync(path.join(dir, 'state'));
  const prefs = createVaultPrefs(path.join(dir, 'state'));
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const store = createKeystore({ keysPath, kdf: () => ({ name: 'scrypt', N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') }) });
  store.keepOwnerKeyOutWhen((vault) => ownerKeyOut(prefs.get(), vault));
  store.importWithEnclave({ keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() }, { keys: { evm: `0x${V.old}` } });
  const accounts = createAccounts({ keystore: store, prefs, chipStatus: status });
  useKeystore(store);
  useRailAccounts(accounts.accounts);
  return {
    keysPath,
    store,
    prefs,
    accounts,
    open() {
      const req = store.enclaveRequest();
      assert.ok(req !== null);
      store.unlockWithDataKey(seUnwrapWithSoftwareKey({ ephemeralPublicKey: req.ephemeralPublicKey, ciphertext: req.ciphertext }, pair.privateKey, Buffer.from(req.aad, 'base64')));
    },
  };
}

// The vault moves, as U10 ends a rekey: vault.json names the chip key, the session lets go of OLD.
async function move(w: World): Promise<void> {
  w.prefs.setChip({ keyRef: KEY_REF, publicKey: PUBLIC_KEY, account: V.vault });
  w.store.dropOwnerKey();
  await w.accounts.refresh();
}

function cfgOf(keysPath: string): AppConfig {
  return { keysPath, mode: 'live', addresses: {} } as unknown as AppConfig;
}

// The draft builder's view of the app: the keystore, the config and a ledger that has read nothing.
function ctxOf(w: World, mode: 'live' | 'demo' = 'live'): PCtx {
  return { keystore: w.store, cfg: { ...cfgOf(w.keysPath), mode }, ledger: { intents: () => undefined } } as unknown as PCtx;
}

test.afterEach(() => {
  useKeystore(null);
  useRailAccounts(null);
});

test('with no accounts installed every wallet is kind key, the old behaviour', () => {
  const w = world();
  useRailAccounts(null);
  assert.deepEqual(railAccounts(w.keysPath), { kind: 'key', vault: V.vault, spend: V.vault });
  assert.equal(liveIntentsSigner.address(w.keysPath), V.vault);
});

test('kind key: the live signer names the vault and signs with the owner key, any payload, as 0.10.15 did', async () => {
  const w = world();
  assert.equal((await w.accounts.refresh()).kind, 'key');
  assert.equal(liveIntentsSigner.address(w.keysPath), V.vault);
  const payload = payloadFor(V.vault);
  assert.equal(await signerOf(payload, await liveIntentsSigner.signErc191(w.keysPath, payload)), V.vault);
  // Kind key keeps its old contract: the owner key signs whatever the rail checked, JSON or not.
  assert.match(await liveIntentsSigner.signErc191(w.keysPath, 'a payload'), /^secp256k1:/);
  assert.equal(spendAccountId(cfgOf(w.keysPath)), V.vault.toLowerCase());
  assert.equal(intentsAccountId(cfgOf(w.keysPath)), V.vault.toLowerCase());
  assert.equal(ourIntentsAddress(ctxOf(w), []), V.vault, 'drafts spend the vault');
});

test('kind chip: the live signer names the allowance and signs with the allowance key; the owner key is never asked', async () => {
  const w = world();
  await move(w);
  assert.equal(w.accounts.accounts().kind, 'chip');
  assert.equal(liveIntentsSigner.address(w.keysPath), V.allowance);
  const payload = payloadFor(V.allowance);
  const signed = await liveIntentsSigner.signErc191(w.keysPath, payload);
  assert.equal(await signerOf(payload, signed), V.allowance, 'the allowance key signed it');
  assert.throws(() => w.store.evmPrivateKey(), /owner_touch_required/, 'and the owner key stayed out of the session');

  // Drafts spend the allowance, the ledger reads it beside the vault, and the vault stays the
  // account deposits, invites and the trading account name.
  assert.equal(ourIntentsAddress(ctxOf(w), []), V.allowance);
  assert.equal(ourEvmAddress(ctxOf(w), []), V.vault, 'the Hyperliquid account is still the vault');
  assert.equal(spendAccountId(cfgOf(w.keysPath)), V.allowance.toLowerCase());
  assert.equal(intentsAccountId(cfgOf(w.keysPath)), V.vault.toLowerCase());
});

test('kind chip: the allowance key signs only one JSON object naming the allowance, and refuses before it signs', async () => {
  const w = world();
  await move(w);
  for (const [payload, why] of [
    [payloadFor(V.vault), 'a payload for the vault'],
    [payloadFor(V.allowance, `"signer_id":"${V.vault.toLowerCase()}",`), 'a second signer_id, the vault, which JSON.parse would keep'],
    ['a payload', 'a string that is not JSON'],
    [`{"verifying_contract":"intents.near","intents":[]}`, 'no signer at all'],
    [`[${payloadFor(V.allowance)}]`, 'an array'],
  ] as const) {
    await assert.rejects(() => liveIntentsSigner.signErc191(w.keysPath, payload), /refusing to sign/, why);
  }
});

test('kind broken (vault.json moved, the service has not vouched): the rails still spend the allowance', async () => {
  const w = world(async () => {
    throw new Error('keychain_unavailable');
  });
  await move(w);
  assert.equal(w.accounts.accounts().kind, 'broken');
  assert.equal(liveIntentsSigner.address(w.keysPath), V.allowance);
  const payload = payloadFor(V.allowance);
  assert.equal(await signerOf(payload, await liveIntentsSigner.signErc191(w.keysPath, payload)), V.allowance);
});

test('kind chip, locked: the allowance is still named, and nothing signs until an unlock', async () => {
  const w = world();
  await move(w);
  w.store.lock();
  assert.equal(liveIntentsSigner.address(w.keysPath), V.allowance, 'the accounts are public and outlive the lock');
  await assert.rejects(() => liveIntentsSigner.signErc191(w.keysPath, payloadFor(V.allowance)), /locked/);
  w.open();
  assert.equal(await signerOf(payloadFor(V.allowance), await liveIntentsSigner.signErc191(w.keysPath, payloadFor(V.allowance))), V.allowance);
});

test('kind chip, never opened in this process: no allowance can be named, so nothing is drafted and the move waits for the unlock', async () => {
  const w = world();
  await move(w);
  // A new process on the same files: the keystore has opened nothing, so it derived nothing.
  const fresh = createKeystore({ keysPath: w.keysPath });
  fresh.keepOwnerKeyOutWhen((vault) => ownerKeyOut(w.prefs.get(), vault));
  const accounts = createAccounts({ keystore: fresh, prefs: w.prefs, chipStatus: async () => marked() });
  useKeystore(fresh);
  useRailAccounts(accounts.accounts);
  await accounts.refresh();
  assert.equal(accounts.accounts().spend, null);
  assert.throws(() => liveIntentsSigner.address(w.keysPath), (err: Error) => err.message === ALLOWANCE_UNKNOWN && /the wallet is locked/.test(err.message));
  const problems: string[] = [];
  assert.equal(ourIntentsAddress({ ...ctxOf(w), keystore: fresh } as PCtx, problems), '');
  assert.match(problems[0] ?? '', /^Unlock the wallet first/);
  assert.equal(spendAccountId(cfgOf(w.keysPath)), null, 'and the ledger reads the vault alone');
});

test('the vault moving between the read and the signature: the allowance key refuses the payload the old read built', async () => {
  const w = world();
  await w.accounts.refresh();
  const built = payloadFor(liveIntentsSigner.address(w.keysPath));
  await move(w);
  await assert.rejects(() => liveIntentsSigner.signErc191(w.keysPath, built), /refusing to sign: the payload is for 0x2c75/);
});

test('src/main.ts installs the app accounts for the rails, the demo its own, after the gate', () => {
  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main.ts'), 'utf8');
  const gate = main.indexOf('keystore.keepOwnerKeyOutWhen(ownerKeyStaysOut);');
  const made = main.indexOf('const accounts = createAccounts({ keystore, prefs: vaultPrefs });');
  const used = main.indexOf("useRailAccounts(cfg.mode === 'demo' ? () => demoAccounts(intentsAccountId(cfg)) : accounts.accounts);");
  assert.ok(gate > 0 && made > gate && used > made, 'the accounts are made after the gate and installed at once');
  assert.ok(used < main.indexOf('const ledger = createLedger(cfg);'), 'before the ledger or any rail can ask');
});
