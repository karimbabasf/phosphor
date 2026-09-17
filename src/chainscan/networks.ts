// What a chain lookup may name, and nothing else.
//
// The agent hands this module a network from a closed enum and an address or a transaction
// hash. Everything that reaches the wire (host, path, method, explorer link) comes from the
// tables below, keyed by that enum; the address or hash is checked against its network's own
// shape first and URL-encoded after. There is no path through here where a string from an
// agent, a page or a chain response picks a host, and an input that fails its shape is refused
// rather than repaired: a repaired address is an address nobody typed.

import { getAddress } from 'viem';
import type { ChainId } from '../types.ts';

export type ChainNetwork = 'ethereum' | 'base' | 'arbitrum' | 'solana' | 'near' | 'bitcoin';

export const CHAIN_NETWORKS: readonly ChainNetwork[] = ['ethereum', 'base', 'arbitrum', 'solana', 'near', 'bitcoin'];

export function isChainNetwork(value: unknown): value is ChainNetwork {
  return typeof value === 'string' && (CHAIN_NETWORKS as readonly string[]).includes(value);
}

export type NetworkSpec = {
  label: string;
  symbol: string; // the native asset
  decimals: number;
  evm: ChainId | null; // the viem reader's chain, EVM networks only (src/chain/evm.ts reader)
  api: string; // the one host this network's lookups talk to
  explorerAddress: string; // link prefixes for a human, never fetched
  explorerTx: string;
};

// Blockscout for the EVM chains because it is keyless and one call answers balance, code and
// counts; the public Solana and NEAR RPCs; mempool.space for Bitcoin. All verified live on
// 2026-09-16 (discovery, research-chain.md).
export const NETWORKS: Readonly<Record<ChainNetwork, NetworkSpec>> = {
  ethereum: { label: 'Ethereum', symbol: 'ETH', decimals: 18, evm: 'eth', api: 'eth.blockscout.com', explorerAddress: 'https://etherscan.io/address/', explorerTx: 'https://etherscan.io/tx/' },
  base: { label: 'Base', symbol: 'ETH', decimals: 18, evm: 'base', api: 'base.blockscout.com', explorerAddress: 'https://basescan.org/address/', explorerTx: 'https://basescan.org/tx/' },
  arbitrum: { label: 'Arbitrum', symbol: 'ETH', decimals: 18, evm: 'arb', api: 'arbitrum.blockscout.com', explorerAddress: 'https://arbiscan.io/address/', explorerTx: 'https://arbiscan.io/tx/' },
  solana: { label: 'Solana', symbol: 'SOL', decimals: 9, evm: null, api: 'api.mainnet-beta.solana.com', explorerAddress: 'https://solscan.io/account/', explorerTx: 'https://solscan.io/tx/' },
  near: { label: 'NEAR', symbol: 'NEAR', decimals: 24, evm: null, api: 'free.rpc.fastnear.com', explorerAddress: 'https://nearblocks.io/address/', explorerTx: 'https://nearblocks.io/txns/' },
  bitcoin: { label: 'Bitcoin', symbol: 'BTC', decimals: 8, evm: null, api: 'mempool.space', explorerAddress: 'https://mempool.space/address/', explorerTx: 'https://mempool.space/tx/' },
};

// NEAR history and the intents ledger come from NearBlocks; the RPC has no account history.
export const NEARBLOCKS_HOST = 'api.nearblocks.io';

// Exact hosts, compared character for character against new URL().host. Never a suffix test.
export const HOSTS: ReadonlySet<string> = new Set([...Object.values(NETWORKS).map((n) => n.api), NEARBLOCKS_HOST]);

// ---------- shapes ----------

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
// Named (a.b.near, with - and _ inside a part) or implicit (64 hex). 2 to 64 characters.
const NEAR_ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
// bech32 (bc1...) or base58check (1... or 3...). Format only: a checksum here would mean
// carrying a bech32 decoder for a network this app never signs on.
const BITCOIN_ADDRESS = /^(bc1[02-9ac-hj-np-z]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
const BITCOIN_HASH = /^[0-9a-fA-F]{64}$/;

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// How many bytes a base58 string decodes to. Its own copy rather than an import from
// src/chain/near.ts, so this module stays standing when the chain signers go.
function base58Length(text: string): number {
  let acc = 0n;
  for (const ch of text) acc = acc * 58n + BigInt(B58_ALPHABET.indexOf(ch));
  let bytes = 0;
  while (acc > 0n) {
    acc >>= 8n;
    bytes += 1;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes += 1;
  }
  return bytes;
}

export type AddressCheck = { ok: true; normalized: string; checksum?: 'valid' | 'lowercase' } | { ok: false; reason: string };
export type HashCheck = { ok: true; normalized: string } | { ok: false; reason: string };

function evmAddressCheck(address: string, label: string): AddressCheck {
  if (!EVM_ADDRESS.test(address)) return { ok: false, reason: `not an address on ${label}: expected 0x followed by 40 hex characters` };
  const checksummed = getAddress(address.toLowerCase());
  // No capitals at all means no checksum was offered, so there is nothing to verify. Any
  // capital means one was, and then it has to match: a mixed-case address with the wrong
  // capitals is the signature of a typo or an edit.
  if (!/[A-F]/.test(address.slice(2))) return { ok: true, normalized: checksummed, checksum: 'lowercase' };
  if (checksummed !== address) return { ok: false, reason: 'the address has a checksum and it does not match: a character was changed or mistyped' };
  return { ok: true, normalized: checksummed, checksum: 'valid' };
}

export function validateAddress(network: ChainNetwork, address: string): AddressCheck {
  const value = typeof address === 'string' ? address.trim() : '';
  if (value === '') return { ok: false, reason: 'no address given' };
  switch (network) {
    case 'ethereum':
    case 'base':
    case 'arbitrum':
      return evmAddressCheck(value, NETWORKS[network].label);
    case 'solana':
      if (!BASE58.test(value) || value.length < 32 || value.length > 44) return { ok: false, reason: 'not a Solana address: expected 32 to 44 base58 characters' };
      if (base58Length(value) !== 32) return { ok: false, reason: 'not a Solana address: it does not decode to 32 bytes' };
      return { ok: true, normalized: value };
    case 'near': {
      // An EVM address is a valid NEAR account id in lowercase (the eth-implicit form, and how
      // an intents account is named), so that one spelling is normalised; every other id has
      // to arrive in the lowercase NEAR defines.
      if (EVM_ADDRESS.test(value)) return { ok: true, normalized: value.toLowerCase() };
      if (!NEAR_ACCOUNT.test(value)) return { ok: false, reason: 'not a NEAR account id: expected a lowercase name like alice.near or a 64-character implicit id' };
      return { ok: true, normalized: value };
    }
    case 'bitcoin':
      if (!BITCOIN_ADDRESS.test(value)) return { ok: false, reason: 'not a Bitcoin address: expected bc1... or a 1.../3... address' };
      return { ok: true, normalized: value };
  }
}

export function validateHash(network: ChainNetwork, hash: string): HashCheck {
  const value = typeof hash === 'string' ? hash.trim() : '';
  if (value === '') return { ok: false, reason: 'no transaction hash given' };
  switch (network) {
    case 'ethereum':
    case 'base':
    case 'arbitrum':
      if (!EVM_HASH.test(value)) return { ok: false, reason: 'not an EVM transaction hash: expected 0x followed by 64 hex characters' };
      return { ok: true, normalized: value.toLowerCase() };
    case 'solana':
      if (!SOLANA_SIGNATURE.test(value)) return { ok: false, reason: 'not a Solana transaction signature: expected 86 to 88 base58 characters' };
      return { ok: true, normalized: value };
    case 'near':
      if (!NEAR_HASH.test(value)) return { ok: false, reason: 'not a NEAR transaction hash: expected 43 or 44 base58 characters' };
      return { ok: true, normalized: value };
    case 'bitcoin':
      if (!BITCOIN_HASH.test(value)) return { ok: false, reason: 'not a Bitcoin transaction id: expected 64 hex characters' };
      return { ok: true, normalized: value.toLowerCase() };
  }
}

// Links for a human to open. Built only from a value that passed its check, so a link can
// never carry a string an agent made up, and null when it did not pass.
export function explorerAddressUrl(network: ChainNetwork, address: string): string | null {
  const check = validateAddress(network, address);
  return check.ok ? NETWORKS[network].explorerAddress + encodeURIComponent(check.normalized) : null;
}

export function explorerTxUrl(network: ChainNetwork, hash: string): string | null {
  const check = validateHash(network, hash);
  return check.ok ? NETWORKS[network].explorerTx + encodeURIComponent(check.normalized) : null;
}
