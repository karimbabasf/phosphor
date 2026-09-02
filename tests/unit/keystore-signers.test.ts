// The line between a READER and a SIGNER, drawn through the five places in the app that used
// to open the key file themselves.
//
// The claim under test is decision 6 in the spec: while locked, every read works and nothing
// signs. A reader that reached for key material would break the first half; a signer that kept
// its own copy of the file would break the second. Both failures are silent in ordinary use
// and only show up when somebody locks the app, which is why they are asserted here.
//
// Temp directory throughout. No app boots, nothing looks at ~/.phosphor.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evmAddress } from '../../src/chain/evm.ts';
import { nearAccountId, readNearSigner } from '../../src/chain/near.ts';
import { liveIntentsSigner } from '../../src/rails/intents-native.ts';
import { liveSignPort } from '../../src/rails/hyperliquid-withdraw.ts';
import { readApiWallet } from '../../src/runner/keys.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { walletFromMnemonic } from '../../src/keystore/derive.ts';

const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PASSWORD = 'a long enough password';
const AGENT_KEY = `0x${'ab'.repeat(32)}` as const;

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

async function walletOnDisk(): Promise<{ keysPath: string; store: ReturnType<typeof createKeystore> }> {
  const keysPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-signers-')), 'keys.json');
  const store = createKeystore({ keysPath, kdf: fast });
  await store.importWallet(PASSWORD, { mnemonic: VECTOR });
  useKeystore(store);
  return { keysPath, store };
}

test.afterEach(() => {
  useKeystore(null);
});

test('while unlocked every signer and every reader answers', async () => {
  const { keysPath, store } = await walletOnDisk();
  const wallet = walletFromMnemonic(VECTOR);

  assert.equal(evmAddress(keysPath), VECTOR_EVM);
  assert.equal(nearAccountId(keysPath), wallet.addresses.near);
  assert.equal(liveIntentsSigner.address(keysPath), VECTOR_EVM);
  assert.equal(liveSignPort.address(keysPath), VECTOR_EVM);
  assert.equal(readNearSigner(keysPath).accountId, wallet.addresses.near);

  const signed = await liveIntentsSigner.signErc191(keysPath, 'a payload');
  assert.match(signed, /^secp256k1:/, 'the intents rail really signs');
  assert.equal(store.state(), 'unlocked');
});

test('while locked the readers still answer, because addresses come from the header', async () => {
  const { keysPath, store } = await walletOnDisk();
  const wallet = walletFromMnemonic(VECTOR);
  store.lock();

  assert.equal(store.state(), 'locked');
  assert.equal(evmAddress(keysPath), VECTOR_EVM, 'the EVM address is the balance reader for three chains');
  assert.equal(nearAccountId(keysPath), wallet.addresses.near);
  assert.equal(liveIntentsSigner.address(keysPath), VECTOR_EVM);
  assert.equal(liveSignPort.address(keysPath), VECTOR_EVM);
  assert.equal(store.addresses().solana, wallet.addresses.solana);
});

test('while locked every signer refuses, and says the wallet is locked', async () => {
  const { keysPath, store } = await walletOnDisk();
  store.lock();

  await assert.rejects(() => liveIntentsSigner.signErc191(keysPath, 'a payload'), /locked/);
  await assert.rejects(
    () => liveSignPort.signTypedData(keysPath, { domain: {}, types: {}, primaryType: 'x', message: {} } as never),
    /locked/,
  );
  assert.throws(() => readNearSigner(keysPath), /locked/);
});

test('the runner asks for the API wallet key and is told the wallet is locked, not that there is none', async () => {
  const keysPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-agentkey-')), 'keys.json');
  // A plaintext file with an approved agent, migrated into the envelope, so the agent key
  // travels with everything else rather than being a second file.
  fs.writeFileSync(
    keysPath,
    JSON.stringify({
      evm: { address: VECTOR_EVM, privateKey: walletFromMnemonic(VECTOR).keys.evm },
      hyperliquidAgent: { privateKey: AGENT_KEY, address: '0xagent' },
    }),
    { mode: 0o600 },
  );
  const store = createKeystore({ keysPath, kdf: fast });
  await store.migrate(PASSWORD);
  useKeystore(store);

  const present = readApiWallet(keysPath);
  assert.equal(present.source, 'present');
  assert.equal(present.key, AGENT_KEY);
  assert.equal(present.address, '0xagent');

  store.lock();
  const locked = readApiWallet(keysPath);
  assert.equal(locked.source, 'locked', 'a locked wallet is not the same answer as an unapproved agent');
  assert.equal(locked.key, null);
});

test('with no wallet at all the signers name what to do instead of throwing about a file', async () => {
  const keysPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-nowallet-')), 'keys.json');
  useKeystore(createKeystore({ keysPath, kdf: fast }));
  assert.throws(() => evmAddress(keysPath), /Create a wallet in the app window|no wallet/i);
  assert.equal(readApiWallet(keysPath).source, 'absent');
});

test('nothing in src opens a key file on its own any more', () => {
  // The grep the audit's task 6 asks for, as a test. A second reader is how the app grew three
  // copies of "read the key at the moment of use", and a copy is a place the lock is not.
  const root = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
  const src = path.join(root, 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      // The keystore is the one place allowed to open a key file, which is the whole point.
      if (full.includes(`${path.sep}keystore${path.sep}`)) continue;
      const body = fs.readFileSync(full, 'utf8');
      for (const line of body.split('\n')) {
        if (/readFileSync\(\s*keysPath/.test(line) || /readFileSync\(\s*cfg\.keysPath/.test(line)) {
          offenders.push(`${path.relative(root, full)}: ${line.trim()}`);
        }
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], 'every key read goes through src/keystore');
});
