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
// ---------- one key per NETWORK, added 2026-08-20 ----------
//
// An agent wallet is approved on ONE Hyperliquid network. The approval is a signed action sent
// to that network's exchange, and the other network has never heard of the address. This file
// used to hold a single `hyperliquidAgent`, which meant approving on mainnet silently destroyed
// the testnet one, and pointing the app back at testnet then signed orders with a wallet that
// venue does not recognise. Every order comes back rejected and nothing says why, because the
// key is present, well formed, and simply belongs somewhere else.
//
// That is not hypothetical: it happened here on 2026-08-20, approving mainnet over a testnet
// agent that had been in use since 08-13.
//
// So the file is keyed by network now. The old flat shape is still read, because a keys.json
// written before today has it and silently ignoring a key that is right there would be its own
// version of the same bug: it is treated as belonging to whichever network asks first and a
// caller can see that it was a legacy read.

import fs from 'node:fs';
import type { Network } from '../types.ts';

type AgentEntry = { privateKey?: string; address?: string; name?: string; approvedAt?: string };
type KeysFile = {
  // The shape written before 2026-08-20: one agent, network unstated.
  hyperliquidAgent?: AgentEntry;
  // The shape written now: one agent per network.
  hyperliquidAgents?: Partial<Record<Network, AgentEntry>>;
  [k: string]: unknown;
};

function validKey(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export type ApiWalletRead = {
  key: `0x${string}` | null;
  // Where it came from, so a caller can tell a network-specific key from a legacy one that
  // merely has not been proven to belong to this network.
  source: 'network' | 'legacy' | 'absent';
  address: string | null;
};

export function readApiWallet(keysPath: string, network: Network): ApiWalletRead {
  const absent: ApiWalletRead = { key: null, source: 'absent', address: null };
  if (!fs.existsSync(keysPath)) return absent;
  try {
    const parsed = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysFile;

    const forNetwork = parsed.hyperliquidAgents?.[network];
    if (validKey(forNetwork?.privateKey)) {
      return { key: forNetwork.privateKey, source: 'network', address: forNetwork.address ?? null };
    }

    // Legacy flat entry. Read it rather than refuse: a file written before the split has a
    // perfectly good key in it, and the migration should not cost an install its agent.
    const flat = parsed.hyperliquidAgent;
    if (validKey(flat?.privateKey)) {
      return { key: flat.privateKey, source: 'legacy', address: flat.address ?? null };
    }

    return absent;
  } catch {
    // A malformed keys file reads as no key rather than as an exception. Nothing can arm
    // without a key, which is the safe direction for this failure to point.
    return absent;
  }
}

export async function readApiWalletKey(keysPath: string, network: Network): Promise<`0x${string}` | null> {
  return readApiWallet(keysPath, network).key;
}
