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
// the master key, which would be the worst possible fallback.

import fs from 'node:fs';

type KeysFile = { hyperliquidAgent?: { privateKey?: string }; [k: string]: unknown };

export async function readApiWalletKey(keysPath: string): Promise<`0x${string}` | null> {
  if (!fs.existsSync(keysPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysFile;
    const key = parsed.hyperliquidAgent?.privateKey;
    if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
    return key as `0x${string}`;
  } catch {
    // A malformed keys file reads as no key rather than as an exception. Nothing can arm
    // without a key, which is the safe direction for this failure to point.
    return null;
  }
}
