// Twelve words to one key.
//
// A person cannot back up a raw private key. They can write twelve words down, and every
// wallet they have ever used works that way, so a new Phosphor wallet is a BIP39 mnemonic and
// its one key is derived from it:
//
//   EVM      m/44'/60'/0'/0/0    through viem, which owns the secp256k1 and the EIP-55 casing
//
// ONE key, on purpose. NEAR Intents and Hyperliquid both take ERC-191 signatures from this
// key, so it is the whole wallet. Wallets made before 0.10.5 also carried a Solana and a NEAR
// key derived from the same words; nothing signed with them, and a second address is a second
// place money can be sent and stranded (5 NEAR, 2026-09-18). A new wallet makes neither.
// Old files that still hold them open unchanged: addressesFromKeys below reads them so the
// header check stays whole, and nothing else does.
//
// The mnemonic "abandon abandon ... about" is the BIP39 vector every wallet agrees on, and the
// address it derives here is the address MetaMask shows for it, checked by the test beside
// this file. That is what makes a wallet made here recoverable somewhere else.

import crypto from 'node:crypto';
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { base58Decode, base58Encode } from '../chain/near.ts';

export type RailKeys = {
  // 0x-prefixed, 32 bytes. The master key: it moves funds on every EVM chain.
  evm: `0x${string}`;
  // Legacy, read from pre-0.10.5 files only, never made or imported.
  // base58 of seed(32) || public(32), which is what every Solana tool means by a secret key.
  solana?: string;
  // Legacy, as above. 'ed25519:' + base58 of seed(32) || public(32), NEAR's own spelling.
  nearSecret?: string;
};

export type Addresses = {
  evm: string;
  // Legacy, as above.
  solana?: string;
  near?: string;
  nearPublicKey?: string;
};

export type Wallet = { keys: { evm: `0x${string}` }; addresses: { evm: string } };

const EVM_PATH = "m/44'/60'/0'/0/0";

// ---------- BIP39 ----------

function newMnemonic(): string {
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
  // Twelve is what this app writes. Twenty-four is what most other wallets write, and a phrase
  // carried in from one of them derives the same EVM path, so restore takes both.
  if (words.length !== 12 && words.length !== 24) return `a recovery phrase is twelve words (or twenty-four from another wallet); this one has ${words.length}`;
  const unknown = words.filter((w) => !english.includes(w));
  if (unknown.length > 0) return `these are not words from the recovery list: ${unknown.slice(0, 3).join(', ')}`;
  if (!checksumHolds(words)) return `that is not a valid recovery phrase: the ${words.length === 12 ? 'twelve' : 'twenty-four'} words do not check out`;
  try {
    mnemonicToAccount(phrase, { path: EVM_PATH });
  } catch (err) {
    return `that recovery phrase does not derive a wallet: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

// ---------- the wallet ----------

export function walletFromMnemonic(rawMnemonic: string): Wallet {
  const mnemonic = normaliseMnemonic(rawMnemonic);
  const problem = mnemonicProblem(mnemonic);
  if (problem !== null) throw new Error(problem);

  const account = mnemonicToAccount(mnemonic, { path: EVM_PATH });
  const evmKey = account.getHdKey().privateKey;
  if (evmKey === null) throw new Error('the EVM derivation produced no private key');

  return {
    keys: { evm: `0x${Buffer.from(evmKey).toString('hex')}` },
    addresses: { evm: account.address },
  };
}

export function newWallet(): { mnemonic: string; wallet: Wallet } {
  const mnemonic = newMnemonic();
  return { mnemonic, wallet: walletFromMnemonic(mnemonic) };
}

// ---------- addresses from raw keys ----------

// The import path for somebody who has an EVM key and no phrase, and the path an existing
// file takes on open: the header needs the addresses whatever produced the keys, including the
// legacy Solana and NEAR keys a pre-0.10.5 file still carries.
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
