// The EVM chains this app can read and name: an RPC per chain for read-only lookups (the
// chain scan the agent gets) and the explorer prefixes a receipt links to. Nothing here
// signs. The one EVM key this app holds signs intents (src/rails/intents-native.ts) and
// Hyperliquid actions (src/rails/hl-user-signed.ts), never a chain transaction, and its
// address is read through src/keystore/index.ts.

import { createPublicClient, http } from 'viem';
import type { PublicClient } from 'viem';
import type { ChainId } from '../types.ts';

// Chain identity. Kept here rather than in the callers so nothing can quietly point itself
// at the wrong chain.
export type EvmChainSpec = {
  chainId: number;
  rpcUrl: string;
  explorerTx: string; // prefix; a receipt links explorerTx + hash
  explorerAddress: string; // prefix; explorerAddress + address
};

export const EVM_CHAINS: Partial<Record<ChainId, EvmChainSpec>> = {
  base: {
    chainId: 8453,
    rpcUrl: 'https://base-rpc.publicnode.com',
    explorerTx: 'https://basescan.org/tx/',
    explorerAddress: 'https://basescan.org/address/',
  },
  arb: {
    chainId: 42161,
    rpcUrl: 'https://arbitrum-one-rpc.publicnode.com',
    explorerTx: 'https://arbiscan.io/tx/',
    explorerAddress: 'https://arbiscan.io/address/',
  },
  eth: {
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    explorerTx: 'https://etherscan.io/tx/',
    explorerAddress: 'https://etherscan.io/address/',
  },
};

export function chainSpec(chain: ChainId): EvmChainSpec {
  const spec = EVM_CHAINS[chain];
  if (spec === undefined) throw new Error(`no EVM chain spec for ${chain}`);
  return spec;
}

export function explorerTx(chain: ChainId, hash: string): string {
  return chainSpec(chain).explorerTx + hash;
}

export function explorerAddress(chain: ChainId, address: string): string {
  return chainSpec(chain).explorerAddress + address;
}

// A rate-limited public RPC answers with an HTML error page rather than JSON, which
// makes JSON.parse throw something unrelated to the real problem. Retrying on that is
// the difference between a readable error and a mystery.
function rpcTransport(url: string) {
  return http(url, { retryCount: 3, retryDelay: 400, timeout: 20_000 });
}

export function reader(chain: ChainId): PublicClient {
  const spec = chainSpec(chain);
  return createPublicClient({ transport: rpcTransport(spec.rpcUrl) }) as PublicClient;
}
