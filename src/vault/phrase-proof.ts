// What "backed up" is proven against: the words the last reveal showed, kept for as long as it
// takes to write twelve words down and type three of them back.
//
// The proof used to read the phrase off the open wallet, so a reveal had to leave the wallet open,
// for signing as much as for reading, until the idle lock. A reveal opens nothing now
// (Keystore.readWithDataKey, readWithPassword), so it leaves this behind instead: one HMAC per
// word under a key made for that reveal, compared in constant time, and wiped on a match, on the
// next reveal and when its time is up. It is bound to the wallet's address, so a proof cannot
// carry over to a wallet made or restored after it. It is not a vault: twelve words from a list
// of 2048 are no secret from something that can read this process's memory. What it changes is
// that nothing here can sign.

import crypto from 'node:crypto';

export const PHRASE_PROOF_MS = 30 * 60_000;

type Held = { key: Buffer; words: Buffer[]; wallet: string; until: number };
let held: Held | null = null;

function mac(key: Buffer, index: number, word: string): Buffer {
  return crypto.createHmac('sha256', key).update(`${index}:${word.trim().toLowerCase()}`, 'utf8').digest();
}

export function rememberPhrase(words: string[], wallet: string, now: number = Date.now()): void {
  forgetPhrase();
  const key = crypto.randomBytes(32);
  held = { key, words: words.map((word, index) => mac(key, index, word)), wallet: wallet.toLowerCase(), until: now + PHRASE_PROOF_MS };
}

/* 'none' when nothing was revealed for this wallet in the last half hour: the window shows the
   words again rather than calling a right answer wrong. */
export function checkPhrase(answers: Array<{ index: number; word: string }>, wallet: string | null, now: number = Date.now()): 'match' | 'mismatch' | 'none' {
  if (held === null || now > held.until || wallet === null || held.wallet !== wallet.toLowerCase()) {
    forgetPhrase();
    return 'none';
  }
  const { key, words } = held;
  const matched = answers.every((answer) => {
    const want = words[answer.index];
    return want !== undefined && crypto.timingSafeEqual(want, mac(key, answer.index, answer.word));
  });
  return matched ? 'match' : 'mismatch';
}

export function forgetPhrase(): void {
  if (held !== null) {
    held.key.fill(0);
    for (const word of held.words) word.fill(0);
  }
  held = null;
}
