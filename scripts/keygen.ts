// Phosphor testnet key generation. Mints one fresh keypair per rail (EVM secp256k1,
// NEAR ed25519, Solana ed25519), writes them to keysPath (default ~/.phosphor/keys.json,
// mode 0600, directory 0700), and prints public addresses only. Run: npm run keygen.
//
// These keys are for TESTNET. They are generated on a laptop, stored unencrypted at rest
// behind file permissions, and handled by a program that also talks to the network. That is
// an acceptable posture for faucet money and an unacceptable one for real money, so the file
// records network: "testnet" and the banner says so on every run.
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
// and nothing about the wrong address looks wrong. viem is the same library the three rails
// sign with, so there is exactly one derivation path in this codebase rather than two that
// have to agree.
//
// base58 is still vendored below, twenty lines, because NEAR and Solana need it and viem has
// no base58. It is verified against published vectors at startup, as is every other step:
// selfCheck() runs before any key is generated, so a broken primitive stops the program
// rather than printing an address that no private key opens.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';

// ---------- base58 ----------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let acc = 0n;
  for (const byte of bytes) acc = (acc << 8n) | BigInt(byte);
  let out = '';
  while (acc > 0n) {
    out = B58_ALPHABET[Number(acc % 58n)] + out;
    acc /= 58n;
  }
  // Every leading zero byte is one leading '1'; the bigint loop above cannot represent them.
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}

// ---------- key material ----------

type EvmKeys = { address: string; privateKey: string };
type NearKeys = { accountId: string; publicKey: string; secretKey: string };
type SolanaKeys = { address: string; secretKey: string };

function generateEvm(): EvmKeys {
  // viem draws the scalar from a CSPRNG and returns the EIP-55 cased address. Nothing here
  // touches keccak directly, which is the point: one library owns the derivation.
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}

function ed25519Pair(): { seed: Buffer; publicKey: Buffer } {
  const pair = crypto.generateKeyPairSync('ed25519');
  const priv = pair.privateKey.export({ format: 'jwk' });
  const pub = pair.publicKey.export({ format: 'jwk' });
  if (typeof priv.d !== 'string' || typeof pub.x !== 'string') {
    throw new Error('ed25519 key export produced no seed or no public key');
  }
  return { seed: Buffer.from(priv.d, 'base64url'), publicKey: Buffer.from(pub.x, 'base64url') };
}

function generateNear(): NearKeys {
  const { seed, publicKey } = ed25519Pair();
  return {
    // An implicit account id is the hex of the public key, and it exists the moment it is funded.
    accountId: publicKey.toString('hex'),
    publicKey: 'ed25519:' + base58Encode(publicKey),
    secretKey: 'ed25519:' + base58Encode(Buffer.concat([seed, publicKey])),
  };
}

function generateSolana(): SolanaKeys {
  const { seed, publicKey } = ed25519Pair();
  return {
    address: base58Encode(publicKey),
    // 64 bytes, seed || public, which is what every Solana tool means by a secret key.
    secretKey: base58Encode(Buffer.concat([seed, publicKey])),
  };
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

  expect('base58("Hello World!")', base58Encode(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U');
  expect('base58(leading zero bytes)', base58Encode(Buffer.from('0000287fb4cd', 'hex')), '11233QC4');

  // RFC 8032 test vector 1, seed to public key. Covers the ed25519 export path that NEAR and
  // Solana both depend on, the same way the vector above covers the EVM one.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
  ]);
  const edPub = crypto
    .createPublicKey(crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }))
    .export({ format: 'jwk' });
  expect(
    'ed25519 rfc8032 vector 1',
    Buffer.from(String(edPub.x), 'base64url').toString('hex'),
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  );
}

// ---------- main ----------

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function main(): void {
  const force = process.argv.slice(2).includes('--force');

  selfCheck();

  const keysPath = loadConfig(ROOT).keysPath;

  if (fs.existsSync(keysPath) && !force) {
    // Overwriting a funded testnet key loses the funds and the faucet cooldown with it, so the
    // refusal is the default and --force is the deliberate act.
    console.error(`refusing to overwrite ${keysPath}`);
    console.error('A key file is already there. Overwriting it destroys whatever those addresses hold.');
    console.error('Move it aside, or re-run with --force if you really mean to replace it.');
    process.exit(1);
  }

  const evm = generateEvm();
  const near = generateNear();
  const solana = generateSolana();

  const file = {
    version: 1,
    network: 'testnet',
    createdAt: new Date().toISOString(),
    _comment: 'TESTNET ONLY. Never place mainnet funds behind these keys. Regenerate with: npm run keygen -- --force',
    evm,
    near,
    solana,
  };

  fs.mkdirSync(path.dirname(keysPath), { recursive: true, mode: 0o700 });
  // mkdir and writeFile both mask their mode through the umask, and writeFile ignores mode
  // entirely on an existing file, so set both explicitly afterwards.
  fs.chmodSync(path.dirname(keysPath), 0o700);
  fs.writeFileSync(keysPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(keysPath, 0o600);

  // Everything below is public. No branch of this program prints a private key.
  console.log('');
  console.log('TESTNET KEYS GENERATED. Do not fund these with mainnet assets.');
  console.log(`written to ${keysPath} (file 0600, directory 0700)`);
  console.log('');
  console.log(`  EVM      ${evm.address}`);
  console.log(`  NEAR     ${near.accountId}`);
  console.log(`           ${near.publicKey}`);
  console.log(`  SOLANA   ${solana.address}`);
  console.log('');
  console.log('Paste into config.local.json (gitignored, create it if missing):');
  console.log('');
  console.log(
    JSON.stringify(
      { addresses: { evm: [evm.address], solana: [solana.address], near: [near.accountId] } },
      null,
      2,
    ),
  );
  console.log('');
  console.log('Then fund them from the faucets listed in the README, and run: npm run sweep');
}

// Only generate when run as the entry point, so base58Encode can be imported (by a signer, or
// by a check that re-derives an address) without minting a new key file as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
