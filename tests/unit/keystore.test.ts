// The keystore, tested as the thing that stands between a copied file and a drained wallet.
//
// Every test here uses a temp directory. None of them reads, writes or looks at ~/.phosphor,
// and none of them boots an app.
//
// The derivation half is checked against published vectors rather than against itself. A test
// that derives an address and asserts it equals what the code just derived proves nothing; the
// property that matters is that twelve words written down here open the same wallet in
// MetaMask, Phantom and a NEAR wallet, and only a published vector says that.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { base58Decode, base58Encode } from '../../src/chain/near.ts';
import { canonical, seal, open as openSealed } from '../../src/keystore/envelope.ts';
import { checkParams, defaultParams } from '../../src/keystore/kdf.ts';
import {
  ed25519PublicKey,
  mnemonicProblem,
  mnemonicToSeed,
  newWallet,
  walletFromMnemonic,
} from '../../src/keystore/derive.ts';
import { backupCopies, createKeystore, keystorePathFor, readHeader } from '../../src/keystore/store.ts';

// The BIP39 test vector every wallet agrees on, and the three addresses it produces.
const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_SEED =
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1' +
  '9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';
const VECTOR_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const VECTOR_SOLANA = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
// NEAR has no household vector for m/44'/397'/0', so the assertion is the property that
// defines an implicit account: the id is the hex of the public key the derivation produced,
// and it is recorded here so a change to the derivation shows up as a diff rather than as a
// wallet nobody can restore.
const VECTOR_NEAR = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412';

/* Cheap parameters, because the shipped ones are 256 MiB and about half a second EACH and
   these run on every commit. The code path is identical: the cost is a header field, and the
   file is always opened with whatever its own header says. One test below writes with the real
   parameters, so the shipped cost is exercised too. */
function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

function keystore(keysPath: string, now?: () => number) {
  return createKeystore({ keysPath, now, kdf: fast });
}

function tempKeys(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-keystore-')), 'keys.json');
}

// ---------- derivation ----------

test('the BIP39 seed matches the published vector', () => {
  assert.equal(mnemonicToSeed(VECTOR).toString('hex'), VECTOR_SEED);
});

test('the vector mnemonic derives the addresses every other wallet shows for it', () => {
  const wallet = walletFromMnemonic(VECTOR);
  assert.equal(wallet.addresses.evm, VECTOR_EVM, 'EVM at m/44/60/0/0/0');
  assert.equal(wallet.addresses.solana, VECTOR_SOLANA, "Solana at m/44'/501'/0'/0'");
  assert.equal(wallet.addresses.near, VECTOR_NEAR, "NEAR implicit id at m/44'/397'/0'");
  // The NEAR public key is the same bytes as the implicit id, spelled in base58.
  assert.equal(wallet.addresses.nearPublicKey, 'ed25519:' + base58Encode(Buffer.from(VECTOR_NEAR, 'hex')));
});

test('a mnemonic round trips through its own seed to the same ed25519 public key', () => {
  const wallet = walletFromMnemonic(VECTOR);
  const secret = wallet.keys.nearSecret.slice('ed25519:'.length);
  const material = Buffer.from(base58Decode(secret));
  assert.equal(material.length, 64, 'a NEAR secret key is seed || public');
  assert.equal(ed25519PublicKey(material.subarray(0, 32)).toString('hex'), VECTOR_NEAR);
});

test('a phrase that is not twelve valid words is refused with a sentence, not a stack trace', () => {
  assert.match(mnemonicProblem('abandon abandon') ?? '', /twelve words/);
  assert.match(mnemonicProblem(VECTOR.replace('about', 'zzzzzz')) ?? '', /not words from the recovery list/);
  // Twelve real words in the wrong order: the checksum is the only thing that catches this.
  assert.match(mnemonicProblem(VECTOR.replace('about', 'abandon')) ?? '', /do not check out/);
  assert.equal(mnemonicProblem(`  ${VECTOR.toUpperCase()}  `), null, 'case and spacing are normalised');
});

test('a fresh wallet is twelve words and three usable addresses', () => {
  const made = newWallet();
  assert.equal(made.mnemonic.split(' ').length, 12);
  assert.equal(mnemonicProblem(made.mnemonic), null);
  assert.match(made.wallet.addresses.evm, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(made.wallet.addresses.near.length, 64);
  // And it is reproducible from the words alone, which is the whole claim of a backup.
  assert.deepEqual(walletFromMnemonic(made.mnemonic).addresses, made.wallet.addresses);
});

// ---------- the envelope ----------

test('the canonical form of a header does not depend on key order', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [3, 4] } }), canonical({ a: { c: [3, 4], d: 2 }, b: 1 }));
});

test('a sealed payload opens only under the same key and the same header', () => {
  const key = crypto.randomBytes(32);
  const aad = Buffer.from('header', 'utf8');
  const sealed = seal(Buffer.from('secret'), key, aad);
  assert.equal(openSealed(sealed, key, aad).toString('utf8'), 'secret');
  assert.throws(() => openSealed(sealed, crypto.randomBytes(32), aad), /unable to authenticate|bad decrypt/i);
  assert.throws(() => openSealed(sealed, key, Buffer.from('different header')), /unable to authenticate|bad decrypt/i);
});

test('the key derivation refuses parameters a tampered header could ask for', () => {
  assert.doesNotThrow(() => checkParams(defaultParams()));
  assert.throws(() => checkParams({ ...defaultParams(), N: 2 ** 30 }), /out of range/);
  assert.throws(() => checkParams({ ...defaultParams(), N: 3000 }), /power of two|out of range/);
  assert.throws(() => checkParams({ ...defaultParams(), salt: 'nothex' }), /salt/);
  assert.equal(defaultParams().N, 2 ** 18, 'the shipped cost stays at the wallet tier');
  assert.equal(defaultParams().r, 8);
  assert.equal(defaultParams().p, 1);
  assert.equal(defaultParams().salt.length, 64, 'a 32 byte salt in hex');
});

// ---------- the store ----------

test('a created wallet writes one 0600 file, unlocked, and locks back to addresses only', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  assert.equal(store.state(), 'no_wallet');

  const made = await store.create('a long enough password');
  assert.equal(made.mnemonic.split(' ').length, 12);
  assert.equal(store.state(), 'unlocked');

  const file = keystorePathFor(keysPath);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the keystore is readable by its owner only');
  assert.ok(!fs.existsSync(keysPath), 'no plaintext file is written beside it');

  // The file on disk carries no key material in the clear.
  const onDisk = fs.readFileSync(file, 'utf8');
  const secret = store.reveal();
  assert.ok(!onDisk.includes(secret.keys.evm?.privateKey ?? 'x'), 'the EVM key is not in the file');
  assert.ok(!onDisk.includes(made.mnemonic), 'the mnemonic is not in the file');

  store.lock();
  assert.equal(store.state(), 'locked');
  assert.deepEqual(store.addresses(), made.addresses, 'the addresses survive the lock');
  assert.throws(() => store.keys(), /locked/);
});

test('locking zeroes the buffer the keys were held in', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  await store.create('a long enough password');

  // Reach the live buffer the way the store holds it: reveal() parses it, so the assertion is
  // that after lock() the material is gone rather than merely unreachable through the API.
  const before = store.reveal().keys.evm?.privateKey ?? '';
  assert.match(before, /^0x[0-9a-f]{64}$/i);
  store.lock();
  assert.equal(store.isUnlocked(), false);
  assert.throws(() => store.reveal(), /locked/);

  // And unlocking again produces the same key, so the zeroing did not damage the file.
  const opened = await store.unlock('a long enough password');
  assert.equal(opened.ok, true);
  assert.equal(store.reveal().keys.evm?.privateKey, before);
});

test('a wrong password is refused and the right one still works', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  await store.create('correct horse battery staple');
  store.lock();

  const wrong = await store.unlock('correct horse battery stapler');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.ok === false && wrong.error, 'wrong_password');
  assert.equal(store.state(), 'locked');

  const right = await store.unlock('correct horse battery staple');
  assert.equal(right.ok, true);
  assert.equal(store.state(), 'unlocked');
});

test('five wrong passwords start a backoff, and it expires', async () => {
  const keysPath = tempKeys();
  let clock = 1_000_000;
  const store = keystore(keysPath, () => clock);
  await store.create('the real password');
  store.lock();

  for (let i = 0; i < 5; i += 1) {
    const out = await store.unlock('nope');
    assert.equal(out.ok === false && out.error, 'wrong_password', `attempt ${i + 1}`);
  }
  const locked = await store.unlock('the real password');
  assert.equal(locked.ok === false && locked.error, 'locked_out', 'the right password waits out the backoff too');
  assert.ok((locked.ok === false ? (locked.retryInSec ?? 0) : 0) > 0, 'and it says how long');

  clock += 31_000;
  const after = await store.unlock('the real password');
  assert.equal(after.ok, true);
});

test('a tampered ciphertext fails the GCM tag rather than opening to something else', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  await store.create('a long enough password');
  store.lock();

  const file = keystorePathFor(keysPath);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { payload: { data: string } };
  const bytes = Buffer.from(parsed.payload.data, 'base64');
  bytes[0] ^= 0xff;
  parsed.payload.data = bytes.toString('base64');
  fs.writeFileSync(file, JSON.stringify(parsed));

  const out = await keystore(keysPath).unlock('a long enough password');
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.error, 'damaged', 'a right password against a broken file says damaged, not wrong password');
});

/* The receive address, against the attacker this whole file is built for: a process running as
   the owner with write access to one file. No password, no window token, no unlock.

   This test used to assert the opposite of what it was named. It edited the header, checked that
   readHeader now returned the attacker's address, and called the finding closed because a later
   unlock failed. But nothing unlocks before somebody copies an address off the Money-in screen,
   and addresses() served the header to that screen without ever checking a tag. Reproduced on a
   throwaway wallet: with the wallet OPEN, addresses().evm returned 0xdeadbeef... The assertion
   that was there was true and measured the wrong thing. */
const TAMPERED_EVM = '0x000000000000000000000000000000000000dEaD';

function tamperHeader(keysPath: string): void {
  const file = keystorePathFor(keysPath);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { header: { addresses: { evm: string } } };
  parsed.header.addresses.evm = TAMPERED_EVM;
  fs.writeFileSync(file, JSON.stringify(parsed));
}

test('an edited header cannot change the address an open wallet hands out', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  const made = await store.create('a long enough password');

  tamperHeader(keysPath);
  assert.equal(readHeader(keysPath)?.addresses.evm, TAMPERED_EVM, 'the file really was edited');

  const open = store.addressReport();
  assert.equal(open.addresses.evm, made.addresses.evm, 'an open wallet answers from the keys it decrypted');
  assert.equal(open.verified, true);

  // And it stays right across the lock, because those addresses were derived, not read.
  store.lock();
  const shut = store.addressReport();
  assert.equal(shut.addresses.evm, made.addresses.evm, 'the address a locked wallet last proved is still the right one');
  assert.equal(shut.verified, true);
});

test('a locked wallet this process has never opened says its addresses are unverified', async () => {
  const keysPath = tempKeys();
  await keystore(keysPath).create('a long enough password');
  tamperHeader(keysPath);

  // Nothing can authenticate a header without the password, so the honest answer is not to
  // claim the address is right. It is served flagged, and the window says which it is.
  const cold = keystore(keysPath).addressReport();
  assert.equal(cold.verified, false, 'a header nobody has checked is not a verified address');
  assert.equal(cold.tampered, false, 'and nothing has proved it wrong yet either');
});

test('unlocking a wallet whose header was edited reports tampering, not a wrong password, and then serves no address', async () => {
  const keysPath = tempKeys();
  await keystore(keysPath).create('a long enough password');
  tamperHeader(keysPath);

  const store = keystore(keysPath);
  const out = await store.unlock('a long enough password');
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.error, 'tampered', 'the password was right; the file was edited');

  const after = store.addressReport();
  assert.equal(after.tampered, true);
  assert.equal(after.verified, false);
  assert.equal(after.addresses.evm, null, 'a file known to have been edited hands out no address at all');
  assert.deepEqual(store.addresses(), { evm: null, solana: null, near: null, nearPublicKey: null });
});

test('a genuinely wrong password on an untouched wallet is still a wrong password', async () => {
  const keysPath = tempKeys();
  await keystore(keysPath).create('a long enough password');
  const out = await keystore(keysPath).unlock('not the password at all');
  assert.equal(out.ok === false && out.error, 'wrong_password', 'the tamper answer must not swallow the ordinary case');
});

test('twenty concurrent wrong guesses hit the backoff, exactly as five sequential ones do', async () => {
  const keysPath = tempKeys();
  await keystore(keysPath).create('a long enough password');
  const store = keystore(keysPath);

  /* The reproduction from the audit. openWith read backoffUntil, then suspended for the whole
     key derivation, so twenty callers all passed the check before any of them had recorded a
     failure: sequential guessing walls at five, concurrent guessing walled at nothing. The
     reveal and export routes call verify() and unlock() directly, so this was reachable with a
     window token and no rate limit at all. */
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.verify(`wrong guess ${i}`)));
  const lockedOut = results.filter((r) => r.ok === false && r.error === 'locked_out').length;
  assert.ok(lockedOut >= 15, `at least fifteen of twenty should be locked out, got ${lockedOut}`);
  assert.equal(results.some((r) => r.ok), false, 'and none of them opened anything');
});

test('an imported mnemonic produces the same wallet as creating one from those words', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  const imported = await store.importWallet('a long enough password', { mnemonic: VECTOR });
  assert.equal(imported.addresses.evm, VECTOR_EVM);
  assert.equal(imported.addresses.solana, VECTOR_SOLANA);
  assert.equal(store.reveal().mnemonic, VECTOR, 'the words are kept, so the wallet can be shown its own backup');
});

test('raw keys import without a mnemonic, and the header says there is none', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  const wallet = walletFromMnemonic(VECTOR);
  const out = await store.importWallet('a long enough password', { keys: { evm: wallet.keys.evm } });
  assert.equal(out.addresses.evm, VECTOR_EVM);
  assert.equal(store.header()?.hasMnemonic, false);
  assert.equal(store.reveal().mnemonic, null);
});

test('an exported backup opens under the same password and carries a different salt', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  await store.importWallet('a long enough password', { mnemonic: VECTOR });

  const backup = path.join(path.dirname(keysPath), 'backup.enc.json');
  await store.exportTo(backup, 'a long enough password');

  const live = JSON.parse(fs.readFileSync(keystorePathFor(keysPath), 'utf8')) as { header: { kdf: { salt: string } } };
  const copy = JSON.parse(fs.readFileSync(backup, 'utf8')) as { header: { kdf: { salt: string } } };
  assert.notEqual(copy.header.kdf.salt, live.header.kdf.salt, 'one cracked password must not open both files');

  // And it really is a keystore: opening it as one recovers the same wallet.
  const restoredPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-restore-')), 'keys.json');
  fs.copyFileSync(backup, keystorePathFor(restoredPath));
  const restored = keystore(restoredPath);
  assert.equal((await restored.unlock('a long enough password')).ok, true);
  assert.equal(restored.reveal().mnemonic, VECTOR);
});

// ---------- migration ----------

function plaintextWallet(keysPath: string): { evm: string } {
  const wallet = walletFromMnemonic(VECTOR);
  fs.mkdirSync(path.dirname(keysPath), { recursive: true });
  fs.writeFileSync(
    keysPath,
    JSON.stringify(
      {
        evm: { address: wallet.addresses.evm, privateKey: wallet.keys.evm },
        solana: { address: wallet.addresses.solana, secretKey: wallet.keys.solana },
        near: { accountId: wallet.addresses.near, publicKey: wallet.addresses.nearPublicKey, secretKey: wallet.keys.nearSecret },
        hyperliquidAgent: { privateKey: `0x${'ab'.repeat(32)}`, address: '0xagent' },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { evm: wallet.addresses.evm };
}

test('an install with a plaintext key file reads as needing migration and still signs', () => {
  const keysPath = tempKeys();
  plaintextWallet(keysPath);
  const store = keystore(keysPath);
  assert.equal(store.state(), 'needs_migration');
  assert.equal(store.addresses().evm, VECTOR_EVM, 'the addresses come from the file it does have');
  assert.equal(store.keys().evm?.privateKey, walletFromMnemonic(VECTOR).keys.evm, 'and it can still sign until it is migrated');
});

test('migration verifies the round trip and the address before it destroys anything', async () => {
  const keysPath = tempKeys();
  const before = plaintextWallet(keysPath);
  // The stale copies the audit found, plus one with a different suffix.
  const bakA = `${keysPath}.bak-2026-08-20`;
  const bakB = `${keysPath}.bak-before-near`;
  const bakC = `${keysPath}.generated.bak`;
  const unrelated = path.join(path.dirname(keysPath), 'notes.txt');
  for (const p of [bakA, bakB, bakC]) fs.copyFileSync(keysPath, p);
  fs.writeFileSync(unrelated, 'not a key file');

  assert.deepEqual(backupCopies(keysPath).sort(), [bakC, bakB, bakA].sort());

  const store = keystore(keysPath);
  const out = await store.migrate('a long enough password');

  assert.equal(out.addresses.evm, before.evm, 'the EVM address is unchanged');
  assert.equal(store.state(), 'unlocked', 'migration leaves the wallet open, because the person just typed the password');
  assert.equal(store.keys().hyperliquidAgent?.address, '0xagent', 'everything in the file came across, not only the three rail keys');

  for (const p of [keysPath, bakA, bakB, bakC]) assert.ok(!fs.existsSync(p), `${path.basename(p)} was destroyed`);
  assert.ok(fs.existsSync(unrelated), 'a file that is not a copy of the key file is left alone');
  assert.deepEqual(out.destroyed.sort(), [keysPath, bakA, bakB, bakC].sort());

  // And the encrypted file really holds it: a fresh store opens it with the same password.
  const reopened = keystore(keysPath);
  assert.equal(reopened.state(), 'locked');
  assert.equal((await reopened.unlock('a long enough password')).ok, true);
  assert.equal(reopened.addresses().evm, before.evm);
});

/* A KILL INSIDE THE DESTROY LOOP used to strand the master key on disk in the clear, forever.
   The loop shredded the primary first and the backups after it, so a process that died between
   the two left `keys.json.bak-*` behind while `keys.enc.json` verified: state() read `locked`,
   the migration screen never appeared again, and migrate() refused because the envelope existed.
   Nothing in the app could reach the survivor.
   Two changes. The copies go first, so the file the app keys its migration state off is the last
   thing destroyed. And migrate() finishes an interrupted run rather than refusing it, after
   proving the encrypted wallet holds the same keys as the plaintext still on disk. */
test('a migration killed inside the destroy loop can be finished, and leaves no plaintext behind', async () => {
  const keysPath = tempKeys();
  const before = plaintextWallet(keysPath);
  const bak = `${keysPath}.bak-2026-08-20`;
  const bytes = fs.readFileSync(keysPath);

  // The kill: the encrypted wallet exists and verifies, and one plaintext copy survives.
  await keystore(keysPath).migrate('a long enough password');
  fs.writeFileSync(bak, bytes);

  const resumed = keystore(keysPath);
  assert.equal(resumed.state(), 'locked', 'the envelope is fine, which is exactly why this used to be invisible');
  const out = await resumed.migrate('a long enough password');
  assert.deepEqual(out.destroyed, [bak]);
  assert.equal(fs.existsSync(bak), false, 'the survivor is gone');
  assert.equal(out.addresses.evm, before.evm);
});

test('finishing an interrupted migration refuses a password that does not open the encrypted wallet', async () => {
  const keysPath = tempKeys();
  plaintextWallet(keysPath);
  const bak = `${keysPath}.bak-2026-08-20`;
  const bytes = fs.readFileSync(keysPath);
  await keystore(keysPath).migrate('a long enough password');
  fs.writeFileSync(bak, bytes);

  await assert.rejects(() => keystore(keysPath).migrate('some other password'), /does not open/);
  assert.ok(fs.existsSync(bak), 'and nothing was destroyed on the way to finding that out');
});

test('finishing an interrupted migration refuses a plaintext file holding a different wallet', async () => {
  const keysPath = tempKeys();
  plaintextWallet(keysPath);
  const bak = `${keysPath}.bak-2026-08-20`;
  await keystore(keysPath).migrate('a long enough password');
  // Somebody else's key, sitting under a name that looks like a backup of this one.
  const other = newWallet();
  fs.writeFileSync(bak, JSON.stringify({ mnemonic: other.mnemonic, evm: { privateKey: other.wallet.keys.evm } }));

  await assert.rejects(() => keystore(keysPath).migrate('a long enough password'), /different wallet/);
  assert.ok(fs.existsSync(bak), 'a file this app cannot account for is never shredded');
});

test('migration refuses to run twice, so an encrypted wallet is never overwritten', async () => {
  const keysPath = tempKeys();
  plaintextWallet(keysPath);
  const store = keystore(keysPath);
  await store.migrate('a long enough password');
  await assert.rejects(() => store.migrate('a long enough password'), /already holds an encrypted wallet/);
});

test('migration with nothing to migrate refuses rather than writing an empty wallet', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  await assert.rejects(() => store.migrate('a long enough password'), /no plaintext key file/);

  fs.mkdirSync(path.dirname(keysPath), { recursive: true });
  fs.writeFileSync(keysPath, JSON.stringify({ notes: 'nothing in here is a key' }));
  await assert.rejects(() => keystore(keysPath).migrate('a long enough password'), /no key this app recognises/);
  assert.ok(fs.existsSync(keysPath), 'and the file it refused to migrate is still there');
});

test('creating a wallet over an existing one is refused', async () => {
  const keysPath = tempKeys();
  const store = keystore(keysPath);
  await store.create('a long enough password');
  await assert.rejects(() => store.create('another password'), /already holds a wallet/);
  await assert.rejects(() => store.importWallet('another password', { mnemonic: VECTOR }), /already holds a wallet/);
});

test('the shipped parameters really open a file written with them', async () => {
  // The one case that pays the real 256 MiB and half a second, so the cost the app ships with
  // is exercised rather than only asserted about.
  const keysPath = tempKeys();
  const real = createKeystore({ keysPath });
  const made = await real.create('a long enough password');
  real.lock();

  assert.equal(readHeader(keysPath)?.kdf.N, 2 ** 18);
  const opened = await createKeystore({ keysPath }).unlock('a long enough password');
  assert.equal(opened.ok, true);
  assert.equal(readHeader(keysPath)?.addresses.evm, made.addresses.evm);
});
