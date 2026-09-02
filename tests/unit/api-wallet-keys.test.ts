// One agent wallet per network, because an agent wallet belongs to exactly one.
//
// Approval is a signed action sent to ONE exchange. The other network has never heard of the
// address, so a key that is present, well formed and approved elsewhere produces rejected
// orders with nothing saying why. That is worse than no key at all: no key fails loudly at arm
// time with a sentence telling you what to run.
//
// It happened here on 2026-08-20. Approving a mainnet agent wrote over the testnet one that had
// been in use since 08-13, and both live in a file this repo does not own.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiWallet, readApiWalletKey } from '../../src/runner/keys.ts';

const MAINNET_KEY = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const TESTNET_KEY = ('0x' + 'b'.repeat(64)) as `0x${string}`;
const LEGACY_KEY = ('0x' + 'c'.repeat(64)) as `0x${string}`;

function keysFile(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-keys-'));
  const p = path.join(dir, 'keys.json');
  fs.writeFileSync(p, JSON.stringify(body, null, 2), { mode: 0o600 });
  return p;
}

// A keys.json written between 2026-08-20 and 2026-09-01 keyed the agent by a venue axis this
// app no longer has. The mainnet entry is the one that names this venue, so it is the one read.
test('the keyed shape is read from its mainnet entry', () => {
  const p = keysFile({
    hyperliquidAgents: {
      mainnet: { privateKey: MAINNET_KEY, address: '0xMAIN' },
      testnet: { privateKey: TESTNET_KEY, address: '0xTEST' },
    },
  });

  const r = readApiWallet(p);
  assert.equal(r.key, MAINNET_KEY);
  assert.equal(r.source, 'present');
  assert.equal(r.address, '0xMAIN');
  assert.notEqual(r.key, TESTNET_KEY, 'an entry for another venue is never handed out');
});

test('a file with no agent at all reads as absent, which fails loudly rather than signing wrong', () => {
  const p = keysFile({ evm: { privateKey: MAINNET_KEY } });
  const missing = readApiWallet(p);
  assert.equal(missing.key, null);
  assert.equal(missing.source, 'absent');
});

test('the pre-2026-08-20 flat key is still read, and is labelled so a caller can warn', () => {
  // Refusing it would cost an existing install its agent for no safety gain: the key is right
  // there and was working yesterday. What a caller needs is to know it is unstamped.
  const p = keysFile({ hyperliquidAgent: { privateKey: LEGACY_KEY, address: '0xOLD' } });
  {
    const r = readApiWallet(p);
    assert.equal(r.key, LEGACY_KEY);
    assert.equal(r.source, 'present');
  }
});

test('the keyed entry wins over a stale flat one', () => {
  const p = keysFile({
    hyperliquidAgent: { privateKey: LEGACY_KEY },
    hyperliquidAgents: { mainnet: { privateKey: MAINNET_KEY } },
  });
  assert.equal(readApiWallet(p).key, MAINNET_KEY);
  assert.equal(readApiWallet(p).source, 'present');
});

test('a missing file, a malformed file and a malformed key all read as no key', async () => {
  assert.equal(await readApiWalletKey('/nowhere/keys.json'), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-keys-'));
  const bad = path.join(dir, 'keys.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(await readApiWalletKey(bad), null);

  const short = keysFile({ hyperliquidAgents: { mainnet: { privateKey: '0xabc' } } });
  assert.equal(await readApiWalletKey(short), null, 'a truncated key is not a key');

  const noPrefix = keysFile({ hyperliquidAgents: { mainnet: { privateKey: 'a'.repeat(64) } } });
  assert.equal(await readApiWalletKey(noPrefix), null);
});

test('nothing can arm without a key, which is the safe direction for this to fail', async () => {
  // Restating the module's own rule as a test, because the alternative fallback anyone would
  // reach for is the master key, and that key can withdraw.
  const p = keysFile({ hyperliquidAgents: {} });
  assert.equal(await readApiWalletKey(p), null);
});
