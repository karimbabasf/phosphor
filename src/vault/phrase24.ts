// The paper key: twenty-four words written by hand, the only key that opens the vault away from
// this Mac (PHASE2-PLAN.md section 1, RECOVERY).
//
// The words are made here (viem's generateMnemonic, 256 bits of entropy) and shown once, in the
// answer to the window that asked. They are never written anywhere: not a state file, not an audit
// line, not a frame, not /api/state. What this process keeps while the person writes them down is a
// SHA-256 of the phrase, which says nothing about 256 bits of entropy, and once all 24 words are
// typed back it keeps the paper's private key, as a Buffer it can zero, until the one signature the
// move asks of it (src/vault/rekey.ts). The JavaScript strings the words travel in cannot be
// zeroed; nothing holds them after the route answers.
//
// The key is the secp256k1 key at m/44'/60'/0'/0/0, the path every EVM wallet derives from 24
// words, so the paper also signs for the vault in any EVM wallet if Phosphor is gone. Its name on
// the verifier is "secp256k1:" and the base58 of its 64-byte public key.

import crypto from 'node:crypto';
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { base58Encode } from '../chain/near.ts';
import { mnemonicProblem, normaliseMnemonic } from '../keystore/derive.ts';

export const PAPER_WORDS = 24;
export const PAPER_PATH = "m/44'/60'/0'/0/0";

// A new paper key. 256 bits, so 24 words; viem draws from a CSPRNG and applies the checksum.
export function newPaperPhrase(): string {
  return generateMnemonic(english, 256);
}

/* The 24 words the window sent, as one normalised phrase, or null for anything that is not 24
   strings. Nothing here quotes a word back. */
export function phraseOf(words: unknown): string | null {
  if (!Array.isArray(words) || words.length !== PAPER_WORDS || !words.every((w) => typeof w === 'string')) return null;
  const phrase = normaliseMnemonic((words as string[]).join(' '));
  return phrase.split(' ').length === PAPER_WORDS ? phrase : null;
}

/* Whether a phrase is a paper key: 24 words from the list with a checksum that holds. The answer
   is yes or no: derive.ts's own sentence names an unknown word, and a word typed from a paper
   key never goes into a sentence. */
export function isPaperPhrase(phrase: string): boolean {
  return phrase.split(' ').length === PAPER_WORDS && mnemonicProblem(phrase) === null;
}

// What the window's type-back is checked against while the words are being written down.
export function phraseDigest(phrase: string): Buffer {
  return crypto.createHash('sha256').update(normaliseMnemonic(phrase), 'utf8').digest();
}

// A secp256k1 key's name on the verifier.
export function verifierKeyOf(privateKey: Uint8Array): string {
  const account = privateKeyToAccount(`0x${Buffer.from(privateKey).toString('hex')}`);
  return `secp256k1:${base58Encode(Buffer.from(account.publicKey.slice(4), 'hex'))}`;
}

export type PaperKey = { key: Buffer; publicKey: string; address: string };

/* The paper's private key, in a Buffer of its own that the caller zeroes, with its verifier name
   and its 0x address. The HD key viem leaves behind is zeroed here. */
export function paperKeyOf(phrase: string): PaperKey {
  if (!isPaperPhrase(phrase)) throw new Error('not the 24 words of a paper key');
  const account = mnemonicToAccount(normaliseMnemonic(phrase), { path: PAPER_PATH });
  const hd = account.getHdKey();
  if (hd.privateKey === null) throw new Error('the paper key derived no private key');
  const key = Buffer.from(hd.privateKey);
  hd.privateKey.fill(0);
  return { key, publicKey: verifierKeyOf(key), address: account.address.toLowerCase() };
}

export function wipeKey(key: Buffer | null | undefined): void {
  key?.fill(0);
}
