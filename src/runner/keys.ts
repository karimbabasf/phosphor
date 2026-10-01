// Reading the API wallet key.
//
// Separate from src/chain/evm.ts on purpose, because these are two different keys with two
// different powers and putting them behind one reader would invite one to be used where the
// other was meant. The EVM key moves funds on chain. This one can place orders on Hyperliquid
// and, by the venue's own signing split, cannot withdraw, cannot transfer, and cannot approve
// another agent. That is what makes it the key the runner is allowed to hold.
//
// Read at the moment it is needed and never held in module state, matching the reasoning in
// evm.ts: a heap dump of a long-running process is less likely to carry it.
//
// It lives under a distinct field so an install that has an EVM key but has never approved an
// agent fails with a sentence that says what to do, rather than by silently signing orders with
// the master key, which would be the worst possible fallback. Which field, when an older file
// carries two shapes, is apiWalletOf in src/keystore/store.ts.
//
// The keystore holds it beside the payload as its own 32 bytes, so a runner start reads that and
// never decodes the payload, which carries the recovery phrase: a decoded copy is a string, and
// nothing can wipe a string.

import { apiWallet, isLocked } from '../keystore/index.ts';

export type ApiWalletRead = {
  key: `0x${string}` | null;
  // 'locked' is its own answer, not a flavour of 'absent'. A bot that will not arm because the
  // wallet is locked and a bot that will not arm because nobody has approved an agent wallet
  // need two different sentences: one is a password away and the other is a script away.
  source: 'present' | 'absent' | 'locked';
  address: string | null;
};

export function readApiWallet(keysPath: string): ApiWalletRead {
  const absent: ApiWalletRead = { key: null, source: 'absent', address: null };
  if (isLocked()) return { key: null, source: 'locked', address: null };
  try {
    const held = apiWallet(keysPath);
    return held === null ? absent : { key: held.key, source: 'present', address: held.address };
  } catch {
    // A malformed or missing wallet reads as no key rather than as an exception. Nothing can
    // arm without a key, which is the safe direction for this failure to point.
    return absent;
  }
}

export async function readApiWalletKey(keysPath: string): Promise<`0x${string}` | null> {
  return readApiWallet(keysPath).key;
}
