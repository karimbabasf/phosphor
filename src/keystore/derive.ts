// Twelve words to three chains.
//
// A person cannot back up three random private keys. They can write twelve words down, and
// every wallet they have ever used works that way, so a new Phosphor wallet is a BIP39
// mnemonic and the three rail keys are derived from it.
//
//   EVM      m/44'/60'/0'/0/0    through viem, which owns the secp256k1 and the EIP-55 casing
//   Solana   m/44'/501'/0'/0'    SLIP-0010 ed25519, written here
//   NEAR     m/44'/397'/0'       SLIP-0010 ed25519, written here
//
// SLIP-0010 for ed25519 is fifteen lines of HMAC-SHA512 and it is written here rather than
// pulled in, because the alternative is a dependency in the process that holds the keys. It is
// also the simple half of the standard: ed25519 has no public derivation, so every step is
// hardened and the only operation is HMAC over the parent key.
//
// Every step is checked against a published vector by the test beside this file. The mnemonic
// "abandon abandon ... about" is the BIP39 vector every wallet agrees on, and the three
// addresses it derives here are the three addresses MetaMask, Phantom and a NEAR wallet show
// for it. That is what makes a wallet made here recoverable somewhere else.

import crypto from 'node:crypto';
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { base58Decode, base58Encode } from '../chain/near.ts';

export type RailKeys = {
  // 0x-prefixed, 32 bytes. The master key: it moves funds on every EVM chain.
  evm: `0x${string}`;
  // base58 of seed(32) || public(32), which is what every Solana tool means by a secret key.
  solana: string;
  // 'ed25519:' + base58 of seed(32) || public(32), NEAR's own spelling.
  nearSecret: string;
};

export type Addresses = {
  evm: string;
  solana: string;
  // The implicit account id, which is the hex of the public key. It exists the moment it is
  // funded, so a fresh wallet has a NEAR address without anybody registering a name.
  near: string;
  nearPublicKey: string; // 'ed25519:' + base58, the form the RPC and the access key list use
};

export type Wallet = { keys: RailKeys; addresses: Addresses };

const EVM_PATH = "m/44'/60'/0'/0/0";
const SOLANA_PATH = "m/44'/501'/0'/0'";
const NEAR_PATH = "m/44'/397'/0'";

// ---------- BIP39 ----------

// PBKDF2-HMAC-SHA512, 2048 iterations, salt "mnemonic" + passphrase, 64 bytes out. That is the
// whole of BIP39's seed derivation and node:crypto has all of it. No passphrase is accepted:
// a thirteenth secret the user has to remember beside the twelve words is a way to lose money,
// and every wallet that offers it says so.
export function mnemonicToSeed(mnemonic: string): Buffer {
  return crypto.pbkdf2Sync(mnemonic.normalize('NFKD'), Buffer.from('mnemonic', 'utf8'), 2048, 64, 'sha512');
}

export function newMnemonic(): string {
  // 128 bits of entropy, which is twelve words. viem draws from a CSPRNG and applies the
  // checksum, so an invalid mnemonic cannot be produced here.
  return generateMnemonic(english);
}

// Checked by deriving from it: viem validates the wordlist and the checksum, and a mnemonic
// that fails either is refused with a sentence rather than silently producing a wallet nobody
// can restore. Whitespace is normalised first, because a phrase pasted out of a text file
// routinely arrives with a newline or a double space in it.
export function normaliseMnemonic(raw: string): string {
  return raw.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

/* The BIP39 checksum, written here because nothing in the tree checks it.
   viem's mnemonicToAccount runs the phrase through PBKDF2 and derives happily from twelve real
   words in the wrong order: the seed function does not validate, and the wallet it produces is
   simply a different wallet. That failure is silent and it is the expensive one, because the
   person finds out when they try to restore. Twelve words carry 128 bits of entropy plus 4
   bits that are the top of SHA-256 over those 128, and checking them is what turns a
   transposed pair into a refusal. */
function checksumHolds(words: string[]): boolean {
  const bits = words.map((w) => english.indexOf(w).toString(2).padStart(11, '0')).join('');
  const entropyBits = (bits.length * 32) / 33;
  const entropy = Buffer.alloc(entropyBits / 8);
  for (let i = 0; i < entropy.length; i += 1) entropy[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const checkBits = bits.length - entropyBits;
  const digest = crypto.createHash('sha256').update(entropy).digest();
  const expected = digest[0] >> (8 - checkBits);
  entropy.fill(0);
  return expected === Number.parseInt(bits.slice(entropyBits), 2);
}

export function mnemonicProblem(raw: string): string | null {
  const phrase = normaliseMnemonic(raw);
  const words = phrase === '' ? [] : phrase.split(' ');
  if (words.length !== 12) return `a recovery phrase is twelve words; this one has ${words.length}`;
  const unknown = words.filter((w) => !english.includes(w));
  if (unknown.length > 0) return `these are not words from the recovery list: ${unknown.slice(0, 3).join(', ')}`;
  if (!checksumHolds(words)) return 'that is not a valid recovery phrase: the twelve words do not check out';
  try {
    mnemonicToAccount(phrase, { path: EVM_PATH });
  } catch (err) {
    return `that recovery phrase does not derive a wallet: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

// ---------- SLIP-0010, ed25519 ----------

type Node = { key: Buffer; chain: Buffer };

function master(seed: Buffer): Node {
  const I = crypto.createHmac('sha512', Buffer.from('ed25519 seed', 'utf8')).update(seed).digest();
  return { key: I.subarray(0, 32), chain: I.subarray(32) };
}

// Hardened only, which is not a simplification: ed25519 has no public child derivation, so
// SLIP-0010 defines nothing else for this curve.
function child(node: Node, index: number): Node {
  const ser = Buffer.alloc(4);
  ser.writeUInt32BE((index | 0x80000000) >>> 0);
  const data = Buffer.concat([Buffer.from([0]), node.key, ser]);
  const I = crypto.createHmac('sha512', node.chain).update(data).digest();
  return { key: I.subarray(0, 32), chain: I.subarray(32) };
}

function derivePath(seed: Buffer, path: string): Buffer {
  const parts = path.split('/');
  if (parts[0] !== 'm') throw new Error(`a derivation path starts at m, got ${path}`);
  let node = master(seed);
  for (const part of parts.slice(1)) {
    if (!part.endsWith("'")) throw new Error(`ed25519 derives hardened steps only, got ${part}`);
    const index = Number.parseInt(part.slice(0, -1), 10);
    if (!Number.isInteger(index) || index < 0) throw new Error(`not a derivation index: ${part}`);
    node = child(node, index);
  }
  return node.key;
}

// The public half of an ed25519 seed. node:crypto has no "seed to public key" call, so the
// seed is wrapped in the fixed PKCS#8 prefix for ed25519 and the key object does the rest.
export function ed25519PublicKey(seed: Buffer): Buffer {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('ed25519 public key export produced nothing');
  return Buffer.from(jwk.x, 'base64url');
}

// ---------- the wallet ----------

export function walletFromMnemonic(rawMnemonic: string): Wallet {
  const mnemonic = normaliseMnemonic(rawMnemonic);
  const problem = mnemonicProblem(mnemonic);
  if (problem !== null) throw new Error(problem);

  const account = mnemonicToAccount(mnemonic, { path: EVM_PATH });
  const evmKey = account.getHdKey().privateKey;
  if (evmKey === null) throw new Error('the EVM derivation produced no private key');

  const seed = mnemonicToSeed(mnemonic);
  const solSeed = derivePath(seed, SOLANA_PATH);
  const solPublic = ed25519PublicKey(solSeed);
  const nearSeed = derivePath(seed, NEAR_PATH);
  const nearPublic = ed25519PublicKey(nearSeed);

  const wallet: Wallet = {
    keys: {
      evm: `0x${Buffer.from(evmKey).toString('hex')}`,
      solana: base58Encode(Buffer.concat([solSeed, solPublic])),
      nearSecret: 'ed25519:' + base58Encode(Buffer.concat([nearSeed, nearPublic])),
    },
    addresses: {
      evm: account.address,
      solana: base58Encode(solPublic),
      near: nearPublic.toString('hex'),
      nearPublicKey: 'ed25519:' + base58Encode(nearPublic),
    },
  };
  seed.fill(0);
  solSeed.fill(0);
  nearSeed.fill(0);
  return wallet;
}

export function newWallet(): { mnemonic: string; wallet: Wallet } {
  const mnemonic = newMnemonic();
  return { mnemonic, wallet: walletFromMnemonic(mnemonic) };
}

// ---------- addresses from raw keys ----------

// The import path for somebody who already has three keys and no phrase, and the path a
// migrated keys.json takes: the header needs the addresses whatever produced the keys.
export function addressesFromKeys(keys: Partial<RailKeys>): Partial<Addresses> {
  const out: Partial<Addresses> = {};
  if (keys.evm !== undefined && (keys.evm as string) !== '') {
    out.evm = privateKeyToAccount(keys.evm).address;
  }
  if (keys.solana !== undefined && keys.solana !== '') {
    const material = base58Decode(keys.solana);
    if (material.length !== 64) throw new Error(`a Solana secret key is 64 bytes, this one decodes to ${material.length}`);
    out.solana = base58Encode(material.subarray(32));
  }
  if (keys.nearSecret !== undefined && keys.nearSecret !== '') {
    const body = keys.nearSecret.startsWith('ed25519:') ? keys.nearSecret.slice('ed25519:'.length) : keys.nearSecret;
    const material = base58Decode(body);
    if (material.length !== 64) throw new Error(`a NEAR secret key is 64 bytes, this one decodes to ${material.length}`);
    const publicHalf = Buffer.from(material.subarray(32));
    out.near = publicHalf.toString('hex');
    out.nearPublicKey = 'ed25519:' + base58Encode(publicHalf);
  }
  return out;
}
