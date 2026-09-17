// Raw key generation for developers. Mints one fresh EVM secp256k1 keypair, writes it to
// keysPath (default ~/.phosphor/keys.json, mode 0600, directory 0700), and prints the public
// address only. Run: npm run keygen.
//
// One key, because this app signs with one: the EVM key is the NEAR Intents account id and the
// Hyperliquid signer. The NEAR and Solana ed25519 keys this script used to mint beside it signed
// nothing after the chain wallets went (2026-09-16); a wallet made in the window still derives
// them from the mnemonic and seals them in the file, and that format is untouched.
//
// SUPERSEDED by wallet creation inside the app, which is where a person should make a wallet.
// This script exists for a developer who wants a raw key on disk and knows what that costs.
//
// READ THIS BEFORE RUNNING IT. The key it writes is generated on a laptop, stored UNENCRYPTED
// at rest behind nothing but file permissions, and handled by a program that also talks to the
// network. Anything that can read your home directory can spend what this address holds. The
// app's own wallet creation encrypts the key behind a password; this script does not. Whatever
// you put behind this key, you are accepting that.
//
// keysPath comes from src/config.ts, which refuses any path inside the working copy. A key
// file inside a git working copy is one `git add -f` from being published; one outside it
// cannot be reached by git at all. That is the structural guarantee. `npm run sweep` is the
// check that nothing leaked anyway.
//
// EVM address derivation goes through viem. The trap it avoids is worth naming, because it
// is silent and expensive: an EVM address is keccak256 of the public key, and node:crypto has
// no keccak256. It ships 'sha3-256', which is NIST FIPS 202: same Keccak-f[1600] permutation,
// different padding byte (0x06 rather than 0x01), so it returns a different digest and an
// address derived from it is an address nobody holds the key to. Funds sent there are gone,
// and nothing about the wrong address looks wrong. viem is the same library the rails sign
// with, so there is exactly one derivation path in this codebase rather than two that have to
// agree. selfCheck() runs before any key is generated, so a broken primitive stops the program
// rather than printing an address that no private key opens.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { loadConfig } from '../src/config.ts';

// ---------- key material ----------

type EvmKeys = { address: string; privateKey: string };

function generateEvm(): EvmKeys {
  // viem draws the scalar from a CSPRNG and returns the EIP-55 cased address. Nothing here
  // touches keccak directly, which is the point: one library owns the derivation.
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}

// ---------- self check ----------

function expect(label: string, got: string, want: string): void {
  if (got !== want) throw new Error(`self check failed: ${label}\n  got  ${got}\n  want ${want}`);
}

// Runs before any key is generated. If a primitive is wrong, the run stops here rather than
// handing over an address that no private key opens.
function selfCheck(): void {
  // The canonical Ethereum vector. Covers the whole EVM path in one assertion: scalar to
  // public key, keccak256, the last twenty bytes, and the EIP-55 casing. If viem is ever
  // swapped out or mis-imported, this is what catches it.
  expect(
    'evm address for the canonical test key',
    privateKeyToAccount('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318').address,
    '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
  );
}

// ---------- main ----------

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function main(): void {
  const force = process.argv.slice(2).includes('--force');

  selfCheck();

  const keysPath = loadConfig(ROOT).keysPath;

  if (fs.existsSync(keysPath) && !force) {
    // Overwriting a funded key loses the funds with it, so the refusal is the default and
    // --force is the deliberate act.
    console.error(`refusing to overwrite ${keysPath}`);
    console.error('A key file is already there. Overwriting it destroys whatever this address holds.');
    console.error('Move it aside, or re-run with --force if you really mean to replace it.');
    process.exit(1);
  }

  const evm = generateEvm();

  const file = {
    version: 1,
    createdAt: new Date().toISOString(),
    _comment:
      'Unencrypted key on disk, protected by file permissions alone. Anything that can read this ' +
      'file can spend what this address holds. Regenerate with: npm run keygen -- --force',
    evm,
  };

  fs.mkdirSync(path.dirname(keysPath), { recursive: true, mode: 0o700 });
  // mkdir and writeFile both mask their mode through the umask, and writeFile ignores mode
  // entirely on an existing file, so set both explicitly afterwards.
  fs.chmodSync(path.dirname(keysPath), 0o700);
  fs.writeFileSync(keysPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(keysPath, 0o600);

  // Everything below is public. No branch of this program prints a private key.
  console.log('');
  console.log('KEY GENERATED, UNENCRYPTED ON DISK. File permissions are the only thing protecting it.');
  console.log(`written to ${keysPath} (file 0600, directory 0700)`);
  console.log('');
  console.log(`  EVM      ${evm.address}`);
  console.log('');
  console.log('This address is your NEAR Intents account id and your Hyperliquid account. Money comes in');
  console.log('through the deposit card in the window, never by sending to this address on a chain.');
  console.log('');
  console.log('Paste into config.local.json (gitignored, create it if missing) for a read-only install:');
  console.log('');
  console.log(JSON.stringify({ addresses: { evm: evm.address } }, null, 2));
  console.log('');
  console.log('Then run: npm run sweep');
}

// Only generate when run as the entry point, so this file can be imported without minting a new
// key file as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
