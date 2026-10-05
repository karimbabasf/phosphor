// What "backed up" is proven against for a recovery phrase: three of the words the last reveal or a
// new wallet showed, kept as one slow hash for as long as it takes to write the phrase down and type
// three of them back. One proof is held at a time. A phrase carries a checksum, so three words show a
// copy that reads; a wallet with no phrase backs up a raw private key, which has no words to ask
// for, and is proven by "I saved it somewhere safe" straight after its reveal (keyShown, at the
// foot of this file; src/http/vault.ts, key-proven).
//
// The proof used to read the phrase off the open wallet, so a reveal had to leave the wallet open,
// for signing as much as for reading, until the idle lock. A reveal opens nothing now
// (Keystore.readWithDataKey, readWithPassword), so it leaves this behind instead, wiped on a match,
// after the fifth miss, on the next reveal and when its half hour is up. A lock leaves it, because
// the words are often still being written down when the idle lock lands. It is bound to the
// wallet's address, so a proof cannot carry over to a wallet made or restored after it.
//
// THREE WORDS UNDER ONE SLOW HASH, NOT A HASH PER WORD. It was one HMAC per word under a key held
// beside them, and a word is one of 2048: anything that could read this process's memory had the
// whole phrase back in 24,576 HMACs. A slow hash per word would not fix that, a word is still 11
// bits, and twelve of them would cost every reveal six seconds. So this file picks the three
// positions the window asks for and keeps one scrypt of those three words, under the keystore's own
// parameters (src/keystore/kdf.ts, 256 MiB and about half a second a guess): 2^33 guesses to read
// them back, and three words of twelve leave the wallet as far out of reach as it was. A wallet
// keeps its three until they are proven, so a reveal made again asks the same three.

import crypto from 'node:crypto';

import { deriveKek, type KdfParams } from '../keystore/kdf.ts';

export const PHRASE_PROOF_MS = 30 * 60_000;
export const PHRASE_PROOF_WORDS = 3;
/* Tries before the words have to be shown again. The window shows them again after two misses;
   this is the wall against using the check as an oracle: five tries at three words leave 2048
   cubed, and each one costs a scrypt. A try is counted before its hash runs, so checks sent
   together cannot get past it. */
export const PHRASE_PROOF_MISSES = 5;

type Held = { positions: number[]; kdf: KdfParams; hash: Promise<Buffer>; wallet: string; until: number; tries: number };
let held: Held | null = null;
/* The wipe when the half hour is up, so the proof leaves memory then and not at the next check.
   Its clock stops while the Mac sleeps, which is why a check still reads the wall clock. */
let expiry: NodeJS.Timeout | null = null;
// The three a wallet is asked for, kept past a forget so a reveal made again asks the same three.
let asked: { wallet: string; positions: number[] } | null = null;

type Answer = { index: number; word: string };

// The answers as one string, in position order, so the same words typed in any order hash the same.
function spelled(answers: Answer[]): string {
  const parts = [...answers].sort((a, b) => a.index - b.index).map((answer) => `${answer.index}:${answer.word.trim().toLowerCase()}`);
  return ['phrase', ...parts].join('\n');
}

function pick(total: number): number[] {
  const out = new Set<number>();
  while (out.size < Math.min(PHRASE_PROOF_WORDS, total)) out.add(crypto.randomInt(total));
  return [...out].sort((a, b) => a - b);
}

/* Returns the positions the window asks for. `kdf` is the keystore's (Keystore.kdfParams), so a
   test suite that runs the keystore cheaply runs this cheaply too. The hash runs after the answer
   that showed the backup has gone out, so a reveal waits on none of it. */
export function rememberPhrase(words: string[], wallet: string, kdf: KdfParams, now: number = Date.now()): number[] {
  forgetPhrase();
  const owner = wallet.toLowerCase();
  const positions = asked !== null && asked.wallet === owner && asked.positions.every((at) => at < words.length) ? asked.positions : pick(words.length);
  asked = { wallet: owner, positions };
  const secret = spelled(positions.map((index) => ({ index, word: words[index] ?? '' })));
  // Never a throw into the route that showed the backup: a hash that fails is a check that answers 'none'.
  const hash = Promise.resolve().then(() => deriveKek(secret, kdf));
  hash.catch(() => undefined);
  held = { positions, kdf, hash, wallet: owner, until: now + PHRASE_PROOF_MS, tries: 0 };
  expiry = setTimeout(forgetPhrase, PHRASE_PROOF_MS);
  expiry.unref();
  return [...positions];
}

/* 'none' when nothing was revealed for this wallet in the last half hour, or the tries ran out: the
   window shows the words again rather than calling a right answer wrong. Answers at any positions
   but the three asked are a miss. */
export async function checkPhrase(answers: Answer[], wallet: string | null, now: number = Date.now()): Promise<'match' | 'mismatch' | 'none'> {
  const proof = held;
  if (proof === null || now > proof.until || wallet === null || proof.wallet !== wallet.toLowerCase() || proof.tries >= PHRASE_PROOF_MISSES) {
    forgetPhrase();
    return 'none';
  }
  proof.tries += 1;
  const given = new Set(answers.map((answer) => answer.index));
  const placed = answers.length === proof.positions.length && proof.positions.every((at) => given.has(at));
  let matched = false;
  if (placed) {
    let typed: Buffer;
    let want: Buffer;
    try {
      [typed, want] = await Promise.all([deriveKek(spelled(answers), proof.kdf), proof.hash]);
    } catch {
      if (held === proof) forgetPhrase();
      return 'none';
    }
    matched = crypto.timingSafeEqual(typed, want);
    typed.fill(0);
  }
  if (matched) {
    if (asked !== null && asked.wallet === proof.wallet) asked = null;
    return 'match';
  }
  if (proof.tries >= PHRASE_PROOF_MISSES && held === proof) forgetPhrase();
  return 'mismatch';
}

export function forgetPhrase(): void {
  if (expiry !== null) clearTimeout(expiry);
  expiry = null;
  if (held !== null) held.hash.then((hash) => hash.fill(0), () => undefined);
  held = null;
}

/* A private key's backup is the person's word, given in the window just after the key was shown:
   I saved it somewhere safe. So a reveal of the key leaves the wallet it opens here for half an
   hour, nothing of the key itself, and the proof spends it. A proof with no reveal before it, for
   another wallet, or after the half hour proves nothing. */
let keyShown: { wallet: string; until: number } | null = null;

export function rememberKeyShown(wallet: string, now: number = Date.now()): void {
  keyShown = { wallet: wallet.toLowerCase(), until: now + PHRASE_PROOF_MS };
}

export function takeKeyShown(wallet: string | null, now: number = Date.now()): boolean {
  const shown = keyShown;
  keyShown = null;
  return shown !== null && wallet !== null && shown.wallet === wallet.toLowerCase() && now <= shown.until;
}
