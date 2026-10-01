// What a signature leaves behind in this process's heap.
//
// The unlocked payload is held as bytes so a lock can wipe it (src/keystore/store.ts). That only
// helps if signing does not turn it back into strings, and it did: evmPrivateKey() decoded the
// whole payload and parsed it, recovery phrase included, on every signature. JavaScript cannot
// wipe a string, so each copy stayed in heap until the allocator reused the memory, across a lock
// too. A signer now reads a 32-byte buffer kept beside the payload and wiped with it.
//
// What this does not claim: the key itself still becomes a hex string for viem and a bigint in
// noble on every signature. Those copies are the floor for signing inside JavaScript; moving the
// signer out of this process is what removes them.
//
// Temp directories throughout, a fresh wallet and a random password per test. No app boots.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

import { liveIntentsSigner } from '../../src/intents-sign.ts';
import { open, seal } from '../../src/keystore/envelope.ts';
import { createKeystore, evmPrivateKey, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import type { EnclaveRef, Keystore } from '../../src/keystore/store.ts';

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

function tmpKeys(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-signing-key-')), 'keys.json');
}

function password(): string {
  return crypto.randomBytes(16).toString('hex');
}

function addressOf(key: `0x${string}`): string {
  return privateKeyToAccount(key).address;
}

test.afterEach(() => {
  useKeystore(null);
});

/* Counts every string this process decodes or parses that holds the phrase, for as long as `run`
   takes. JSON.parse and Buffer#toString are the two doors a payload comes back through. */
async function phraseDecodes(phrase: string, run: () => Promise<void> | void): Promise<number> {
  const realParse = JSON.parse;
  const realToString = Buffer.prototype.toString;
  let seen = 0;
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    if (typeof text === 'string' && text.includes(phrase)) seen += 1;
    return realParse(text, reviver);
  }) as typeof JSON.parse;
  Buffer.prototype.toString = function (this: Buffer, ...args: Parameters<Buffer['toString']>): string {
    const out = realToString.apply(this, args);
    if (out.includes(phrase)) seen += 1;
    return out;
  } as Buffer['toString'];
  try {
    await run();
  } finally {
    JSON.parse = realParse;
    Buffer.prototype.toString = realToString;
  }
  return seen;
}

test('a signature reads the EVM key and never decodes the recovery phrase', async () => {
  const keysPath = tmpKeys();
  const store = createKeystore({ keysPath, kdf: fast });
  const made = await store.create(password());
  useKeystore(store);

  const during = await phraseDecodes(made.mnemonic, async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal(addressOf(evmPrivateKey(keysPath)), made.addresses.evm);
      await liveIntentsSigner.signErc191(keysPath, `{"signer":"test","n":${i}}`);
    }
  });
  assert.equal(during, 0, 'a signature decoded the whole payload, phrase and all');

  // The control: the counter does see a decode when one happens, so the zero above means something.
  const control = await phraseDecodes(made.mnemonic, () => {
    store.keys();
  });
  assert.ok(control > 0, 'keys() decodes the payload, and the counter has to notice');
});

/* Every buffer zero-filled while `run` takes, as the hex it held just before. wipe() is fill(0). */
function wipedDuring(run: () => void): string[] {
  const realFill = Buffer.prototype.fill;
  const wiped: string[] = [];
  Buffer.prototype.fill = function (this: Buffer, ...args: Parameters<Buffer['fill']>) {
    if (args[0] === 0) wiped.push(this.toString('hex'));
    return realFill.apply(this, args);
  } as Buffer['fill'];
  try {
    run();
  } finally {
    Buffer.prototype.fill = realFill;
  }
  return wiped;
}

test('the lock wipes the key a signer reads, and the unlock brings it back', async () => {
  const keysPath = tmpKeys();
  const store = createKeystore({ keysPath, kdf: fast });
  const secret = password();
  const made = await store.create(secret);
  useKeystore(store);

  const key = evmPrivateKey(keysPath);
  const wiped = wipedDuring(() => store.lock());
  assert.ok(wiped.includes(key.slice(2)), 'the 32 bytes a signature reads were overwritten by the lock');
  assert.throws(() => evmPrivateKey(keysPath), /locked/);

  assert.deepEqual(await store.unlock(secret), { ok: true });
  assert.equal(addressOf(evmPrivateKey(keysPath)), made.addresses.evm);
});

test('an imported wallet signs with the key of the address it reports', async () => {
  const source = createKeystore({ keysPath: tmpKeys(), kdf: fast });
  const made = await source.create(password());

  const keysPath = tmpKeys();
  const store = createKeystore({ keysPath, kdf: fast });
  const imported = await store.importWallet(password(), { mnemonic: made.mnemonic });
  useKeystore(store);
  assert.equal(imported.addresses.evm, made.addresses.evm);
  assert.equal(addressOf(evmPrivateKey(keysPath)), made.addresses.evm);
});

/* A software stand-in for the enclave, as in keystore-enclave.test.ts: the public half in X9.63,
   the private half kept here to play the enclave's part of an unlock. */
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

test('an enclave wallet signs with its own key after create, unlock and a rewrite, and not after a lock', () => {
  const keysPath = tmpKeys();
  const store = createKeystore({ keysPath, kdf: fast });
  const { ref, priv } = fakeEnclave();
  const made = store.createWithEnclave(ref);
  useKeystore(store);
  assert.equal(addressOf(evmPrivateKey(keysPath)), made.addresses.evm);

  store.lock();
  assert.throws(() => evmPrivateKey(keysPath), /locked/);
  assert.deepEqual(store.unlockWithDataKey(playEnclave(store, priv)), { ok: true });
  assert.equal(addressOf(evmPrivateKey(keysPath)), made.addresses.evm);

  store.updatePayload((payload) => ({ ...payload }));
  assert.equal(addressOf(evmPrivateKey(keysPath)), made.addresses.evm, 'a rewrite keeps the key beside the payload it rewrote');
});

/* Every buffer a decipher's update() hands back while `run` takes. envelope.ts calls
   crypto.createDecipheriv on the same module object this file imports, so swapping it here is
   seen there. */
function decipheredChunks(run: () => void): Buffer[] {
  const cryptoModule = crypto as unknown as { createDecipheriv: typeof crypto.createDecipheriv };
  const realCreate = crypto.createDecipheriv;
  const chunks: Buffer[] = [];
  cryptoModule.createDecipheriv = ((...args: Parameters<typeof crypto.createDecipheriv>) => {
    const decipher = realCreate(...args);
    const realUpdate = decipher.update.bind(decipher) as (data: Buffer) => Buffer;
    decipher.update = ((data: Buffer) => {
      const out = realUpdate(data);
      chunks.push(out);
      return out;
    }) as typeof decipher.update;
    return decipher;
  }) as typeof crypto.createDecipheriv;
  try {
    run();
  } finally {
    cryptoModule.createDecipheriv = realCreate;
  }
  return chunks;
}

test('open() wipes the plaintext the cipher hands back before it is joined, and on a bad tag too', () => {
  const key = crypto.randomBytes(32);
  const aad = Buffer.from('{"version":1}');
  const body = crypto.randomBytes(300);
  const sealed = seal(body, key, aad);

  let back: Buffer | null = null;
  const chunks = decipheredChunks(() => {
    back = open(sealed, key, aad);
  });
  assert.deepEqual(back, body, 'the caller still gets the plaintext');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, body.length);
  assert.ok(chunks[0].every((b) => b === 0), 'the loose chunk is zero once open() returns');

  const forged = { ...sealed, tag: crypto.randomBytes(16).toString('hex') };
  const failed = decipheredChunks(() => {
    assert.throws(() => open(forged, key, aad));
  });
  assert.ok(failed.length === 1 && failed[0].every((b) => b === 0), 'unauthenticated plaintext is wiped as well');
});
