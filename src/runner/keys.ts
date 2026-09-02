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
//
// A keys.json written before 2026-09-01 keyed the agent by a venue axis this app no longer
// has. The reader takes the entry that names this venue first and falls back to the flat
// field an older file carries, so no install loses its agent to a shape change. It never
// writes that file back and never removes anything from it: it is key material, and a human
// removes what a human put there.

import { isLocked, keyMaterial } from '../keystore/index.ts';
import type { AgentEntry } from '../keystore/store.ts';

function validKey(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

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
    const parsed = keyMaterial(keysPath);

    const keyed = parsed.hyperliquidAgents?.mainnet;
    if (validKey(keyed?.privateKey)) {
      return { key: keyed.privateKey, source: 'present', address: keyed.address ?? null };
    }

    // The flat entry. Read it rather than refuse: a file written under either older shape
    // has a perfectly good key in it, and a shape change should not cost an install its agent.
    const flat: AgentEntry | undefined = parsed.hyperliquidAgent;
    if (validKey(flat?.privateKey)) {
      return { key: flat.privateKey, source: 'present', address: flat.address ?? null };
    }

    return absent;
  } catch {
    // A malformed or missing wallet reads as no key rather than as an exception. Nothing can
    // arm without a key, which is the safe direction for this failure to point.
    return absent;
  }
}

export async function readApiWalletKey(keysPath: string): Promise<`0x${string}` | null> {
  return readApiWallet(keysPath).key;
}
