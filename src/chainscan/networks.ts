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
import { base58Check, base58Decode, bech32Decode, cashAddr, base32Decode, crc16, fromWords, segwit, XRP_ALPHABET } from './codec.ts';

// The first six keep their place and their names; every network NEAR Intents deposits from
// follows, so the enum is the whole list the deposit card offers.
const NAMES = [
  'ethereum', 'base', 'arbitrum', 'solana', 'near', 'bitcoin',
  'optimism', 'gnosis', 'polygon', 'bnb', 'avalanche', 'scroll', 'berachain', 'monad', 'xlayer', 'plasma', 'robinhood', 'adi', 'abstract',
  'hypercore', 'fogo', 'litecoin', 'bitcoincash', 'dogecoin', 'dash', 'zcash',
  'xrp', 'ton', 'tron', 'sui', 'aptos', 'movement', 'cardano', 'stellar', 'starknet', 'aleo',
] as const;

export type ChainNetwork = (typeof NAMES)[number];

export const CHAIN_NETWORKS: readonly ChainNetwork[] = NAMES;

export function isChainNetwork(value: unknown): value is ChainNetwork {
  return typeof value === 'string' && (CHAIN_NETWORKS as readonly string[]).includes(value);
}

// How an address on the network is decoded, and how a transaction id is.
export type AddressFamily = 'evm' | 'sol' | 'near' | 'btc' | 'ltc' | 'bch' | 'doge' | 'dash' | 'zec' | 'xrp' | 'ton' | 'tron' | 'move' | 'cardano' | 'stellar' | 'starknet' | 'aleo';
type HashFamily = 'evm' | 'sol' | 'near' | 'btc' | 'hex' | 'xrp' | 'ton' | 'sui' | 'move' | 'starknet' | 'aleo';

// Which reader in src/chainscan/index.ts or src/chainscan/families.ts answers for it.
export type ReadFamily = 'blockscout' | 'evm-rpc' | 'solana' | 'near' | 'esplora' | 'haskoin' | 'blockcypher' | 'insight' | 'xrpl' | 'toncenter' | 'trongrid' | 'sui' | 'aptos' | 'koios' | 'horizon' | 'starknet' | 'aleo' | 'hyperliquid';

export type NetworkSpec = {
  id: string; // the registry id src/rails/intents-address.ts names this chain with
  label: string;
  symbol: string; // the native asset
  decimals: number;
  evm: ChainId | null; // the viem reader's chain, the three original EVM networks only (src/chain/evm.ts)
  address: AddressFamily;
  hash: HashFamily;
  read: ReadFamily | null; // null: no keyless source answered, and `why` says so
  api: string; // the one host this network's lookups talk to, '' when there is none
  rpc?: string; // an EVM JSON-RPC host beside an indexer, for the chain head
  why?: string;
  explorerAddress: string; // link prefixes for a human, never fetched
  explorerTx: string;
};

type Row = Omit<NetworkSpec, 'evm' | 'address' | 'hash' | 'read'> & Partial<Pick<NetworkSpec, 'evm' | 'address' | 'hash' | 'read'>>;

// An EVM chain read over its own public JSON-RPC: one batched POST answers balance, nonce and
// code, and one more answers a transaction and its receipt. No indexer, so no counts of
// received transfers, no token list and no history.
function evmRpc(row: Row): NetworkSpec {
  return { evm: null, address: 'evm', hash: 'evm', read: 'evm-rpc', ...row };
}

function spec(row: Row & Pick<NetworkSpec, 'address' | 'hash'>): NetworkSpec {
  return { evm: null, read: null, ...row };
}

/* One row per network, and every host in it answered a real read on 2026-09-26 (balance of a
   known address, a recent transaction by hash, the chain head), the first six also on
   2026-09-16 (discovery, research-chain.md). Blockscout for the first three EVM chains because
   one call answers balance, code and counts, with the publicnode RPC beside it for the head;
   every later EVM chain reads its own RPC, publicnode where it runs one that keeps receipts and
   the chain's own endpoint elsewhere (publicnode answers "archive requests require a personal
   token" for a BNB, Optimism, Base or Arbitrum receipt a few minutes old). The rest are each chain's foundation endpoint or the well-known
   public infrastructure for it. Refused on purpose: Blockchair (it blacklists keyless callers
   after a handful of reads), Trezor's Blockbook instances (run for Trezor Suite, not for third
   parties), the Sui foundation's JSON-RPC (deprecated, it answers "Method not found"), and any
   endpoint that needs a key. */
export const NETWORKS: Readonly<Record<ChainNetwork, NetworkSpec>> = {
  ethereum: { id: 'eth', label: 'Ethereum', symbol: 'ETH', decimals: 18, evm: 'eth', address: 'evm', hash: 'evm', read: 'blockscout', api: 'eth.blockscout.com', rpc: 'ethereum-rpc.publicnode.com', explorerAddress: 'https://etherscan.io/address/', explorerTx: 'https://etherscan.io/tx/' },
  base: { id: 'base', label: 'Base', symbol: 'ETH', decimals: 18, evm: 'base', address: 'evm', hash: 'evm', read: 'blockscout', api: 'base.blockscout.com', rpc: 'base-rpc.publicnode.com', explorerAddress: 'https://basescan.org/address/', explorerTx: 'https://basescan.org/tx/' },
  arbitrum: { id: 'arb', label: 'Arbitrum', symbol: 'ETH', decimals: 18, evm: 'arb', address: 'evm', hash: 'evm', read: 'blockscout', api: 'arbitrum.blockscout.com', rpc: 'arbitrum-one-rpc.publicnode.com', explorerAddress: 'https://arbiscan.io/address/', explorerTx: 'https://arbiscan.io/tx/' },
  solana: { id: 'sol', label: 'Solana', symbol: 'SOL', decimals: 9, evm: null, address: 'sol', hash: 'sol', read: 'solana', api: 'api.mainnet-beta.solana.com', explorerAddress: 'https://solscan.io/account/', explorerTx: 'https://solscan.io/tx/' },
  near: { id: 'near', label: 'NEAR', symbol: 'NEAR', decimals: 24, evm: null, address: 'near', hash: 'near', read: 'near', api: 'free.rpc.fastnear.com', explorerAddress: 'https://nearblocks.io/address/', explorerTx: 'https://nearblocks.io/txns/' },
  bitcoin: { id: 'btc', label: 'Bitcoin', symbol: 'BTC', decimals: 8, evm: null, address: 'btc', hash: 'btc', read: 'esplora', api: 'mempool.space', explorerAddress: 'https://mempool.space/address/', explorerTx: 'https://mempool.space/tx/' },

  optimism: evmRpc({ id: 'op', label: 'Optimism', symbol: 'ETH', decimals: 18, api: 'mainnet.optimism.io', explorerAddress: 'https://optimistic.etherscan.io/address/', explorerTx: 'https://optimistic.etherscan.io/tx/' }),
  gnosis: evmRpc({ id: 'gnosis', label: 'Gnosis', symbol: 'xDAI', decimals: 18, api: 'gnosis-rpc.publicnode.com', explorerAddress: 'https://gnosisscan.io/address/', explorerTx: 'https://gnosisscan.io/tx/' }),
  polygon: evmRpc({ id: 'polygon', label: 'Polygon', symbol: 'POL', decimals: 18, api: 'polygon-bor-rpc.publicnode.com', explorerAddress: 'https://polygonscan.com/address/', explorerTx: 'https://polygonscan.com/tx/' }),
  bnb: evmRpc({ id: 'bnb', label: 'BNB Smart Chain', symbol: 'BNB', decimals: 18, api: 'bsc-dataseed.bnbchain.org', explorerAddress: 'https://bscscan.com/address/', explorerTx: 'https://bscscan.com/tx/' }),
  avalanche: evmRpc({ id: 'avax', label: 'Avalanche', symbol: 'AVAX', decimals: 18, api: 'avalanche-c-chain-rpc.publicnode.com', explorerAddress: 'https://snowtrace.io/address/', explorerTx: 'https://snowtrace.io/tx/' }),
  scroll: evmRpc({ id: 'scroll', label: 'Scroll', symbol: 'ETH', decimals: 18, api: 'scroll-rpc.publicnode.com', explorerAddress: 'https://scrollscan.com/address/', explorerTx: 'https://scrollscan.com/tx/' }),
  berachain: evmRpc({ id: 'bera', label: 'Berachain', symbol: 'BERA', decimals: 18, api: 'rpc.berachain.com', explorerAddress: 'https://berascan.com/address/', explorerTx: 'https://berascan.com/tx/' }),
  monad: evmRpc({ id: 'monad', label: 'Monad', symbol: 'MON', decimals: 18, api: 'rpc.monad.xyz', explorerAddress: 'https://monadscan.com/address/', explorerTx: 'https://monadscan.com/tx/' }),
  xlayer: evmRpc({ id: 'xlayer', label: 'X Layer', symbol: 'OKB', decimals: 18, api: 'rpc.xlayer.tech', explorerAddress: 'https://www.oklink.com/x-layer/address/', explorerTx: 'https://www.oklink.com/x-layer/tx/' }),
  plasma: evmRpc({ id: 'plasma', label: 'Plasma', symbol: 'XPL', decimals: 18, api: 'rpc.plasma.to', explorerAddress: 'https://plasmascan.to/address/', explorerTx: 'https://plasmascan.to/tx/' }),
  robinhood: evmRpc({ id: 'robinhood', label: 'Robinhood Chain', symbol: 'ETH', decimals: 18, api: 'robinhood-rpc.publicnode.com', explorerAddress: 'https://robinhoodchain.blockscout.com/address/', explorerTx: 'https://robinhoodchain.blockscout.com/tx/' }),
  adi: evmRpc({ id: 'adi', label: 'ADI Chain', symbol: 'ADI', decimals: 18, api: 'rpc.adifoundation.ai', explorerAddress: 'https://explorer.adifoundation.ai/address/', explorerTx: 'https://explorer.adifoundation.ai/tx/' }),
  // Spend-only today: the venue lists tokens on Abstract and the bridge has no prefix for it.
  abstract: evmRpc({ id: 'abs', label: 'Abstract', symbol: 'ETH', decimals: 18, api: 'api.mainnet.abs.xyz', explorerAddress: 'https://abscan.org/address/', explorerTx: 'https://abscan.org/tx/' }),

  // HyperCore credits an EVM address; its balances come from the info API the trading screens
  // already read, and a transaction and the head from the explorer and HyperEVM on rpc.
  hypercore: spec({ id: 'hypercore', label: 'HyperCore', symbol: 'HYPE', decimals: 8, address: 'evm', hash: 'move', read: 'hyperliquid', api: 'api.hyperliquid.xyz', rpc: 'rpc.hyperliquid.xyz', explorerAddress: 'https://app.hyperliquid.xyz/explorer/address/', explorerTx: 'https://app.hyperliquid.xyz/explorer/tx/' }),
  fogo: spec({ id: 'fogo', label: 'Fogo', symbol: 'FOGO', decimals: 9, address: 'sol', hash: 'sol', read: 'solana', api: 'mainnet.fogo.io', explorerAddress: 'https://fogoscan.com/account/', explorerTx: 'https://fogoscan.com/tx/' }),
  litecoin: spec({ id: 'ltc', label: 'Litecoin', symbol: 'LTC', decimals: 8, address: 'ltc', hash: 'hex', read: 'esplora', api: 'litecoinspace.org', explorerAddress: 'https://litecoinspace.org/address/', explorerTx: 'https://litecoinspace.org/tx/' }),
  bitcoincash: spec({ id: 'bch', label: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, address: 'bch', hash: 'hex', read: 'haskoin', api: 'api.blockchain.info', explorerAddress: 'https://blockchair.com/bitcoin-cash/address/', explorerTx: 'https://blockchair.com/bitcoin-cash/transaction/' }),
  dogecoin: spec({ id: 'doge', label: 'Dogecoin', symbol: 'DOGE', decimals: 8, address: 'doge', hash: 'hex', read: 'blockcypher', api: 'api.blockcypher.com', explorerAddress: 'https://blockchair.com/dogecoin/address/', explorerTx: 'https://blockchair.com/dogecoin/transaction/' }),
  dash: spec({ id: 'dash', label: 'Dash', symbol: 'DASH', decimals: 8, address: 'dash', hash: 'hex', read: 'insight', api: 'insight.dash.org', explorerAddress: 'https://blockchair.com/dash/address/', explorerTx: 'https://blockchair.com/dash/transaction/' }),
  zcash: spec({
    id: 'zec', label: 'Zcash', symbol: 'ZEC', decimals: 8, address: 'zec', hash: 'hex', api: '',
    why: 'no keyless public Zcash explorer answered on 2026-09-26: Blockchair refuses keyless callers, zcha.in is down, the rest are gone or need a key',
    explorerAddress: 'https://blockchair.com/zcash/address/', explorerTx: 'https://blockchair.com/zcash/transaction/',
  }),
  xrp: spec({ id: 'xrp', label: 'XRP Ledger', symbol: 'XRP', decimals: 6, address: 'xrp', hash: 'xrp', read: 'xrpl', api: 'xrplcluster.com', explorerAddress: 'https://livenet.xrpl.org/accounts/', explorerTx: 'https://livenet.xrpl.org/transactions/' }),
  ton: spec({ id: 'ton', label: 'TON', symbol: 'GRAM', decimals: 9, address: 'ton', hash: 'ton', read: 'toncenter', api: 'toncenter.com', explorerAddress: 'https://tonviewer.com/', explorerTx: 'https://tonviewer.com/transaction/' }),
  tron: spec({ id: 'tron', label: 'Tron', symbol: 'TRX', decimals: 6, address: 'tron', hash: 'hex', read: 'trongrid', api: 'api.trongrid.io', explorerAddress: 'https://tronscan.org/#/address/', explorerTx: 'https://tronscan.org/#/transaction/' }),
  sui: spec({ id: 'sui', label: 'Sui', symbol: 'SUI', decimals: 9, address: 'move', hash: 'sui', read: 'sui', api: 'graphql.mainnet.sui.io', explorerAddress: 'https://suiscan.xyz/mainnet/account/', explorerTx: 'https://suiscan.xyz/mainnet/tx/' }),
  aptos: spec({ id: 'aptos', label: 'Aptos', symbol: 'APT', decimals: 8, address: 'move', hash: 'move', read: 'aptos', api: 'api.mainnet.aptoslabs.com', explorerAddress: 'https://explorer.aptoslabs.com/account/', explorerTx: 'https://explorer.aptoslabs.com/txn/' }),
  movement: spec({ id: 'movement', label: 'Movement', symbol: 'MOVE', decimals: 8, address: 'move', hash: 'move', read: 'aptos', api: 'mainnet.movementnetwork.xyz', explorerAddress: 'https://explorer.movementnetwork.xyz/account/', explorerTx: 'https://explorer.movementnetwork.xyz/txn/' }),
  cardano: spec({ id: 'cardano', label: 'Cardano', symbol: 'ADA', decimals: 6, address: 'cardano', hash: 'hex', read: 'koios', api: 'api.koios.rest', explorerAddress: 'https://cardanoscan.io/address/', explorerTx: 'https://cardanoscan.io/transaction/' }),
  stellar: spec({ id: 'stellar', label: 'Stellar', symbol: 'XLM', decimals: 7, address: 'stellar', hash: 'hex', read: 'horizon', api: 'horizon.stellar.org', explorerAddress: 'https://stellar.expert/explorer/public/account/', explorerTx: 'https://stellar.expert/explorer/public/tx/' }),
  starknet: spec({ id: 'starknet', label: 'Starknet', symbol: 'STRK', decimals: 18, address: 'starknet', hash: 'starknet', read: 'starknet', api: 'starknet-rpc.publicnode.com', explorerAddress: 'https://voyager.online/contract/', explorerTx: 'https://voyager.online/tx/' }),
  aleo: spec({ id: 'aleo', label: 'Aleo', symbol: 'ALEO', decimals: 6, address: 'aleo', hash: 'aleo', read: 'aleo', api: 'api.explorer.provable.com', explorerAddress: 'https://explorer.provable.com/address/', explorerTx: 'https://explorer.provable.com/transaction/' }),
};

// NEAR history and the intents ledger come from NearBlocks; the RPC has no account history.
export const NEARBLOCKS_HOST = 'api.nearblocks.io';

// Exact hosts, compared character for character against new URL().host. Never a suffix test.
export const HOSTS: ReadonlySet<string> = new Set([
  ...Object.values(NETWORKS).flatMap((n) => [n.api, n.rpc ?? '']).filter((h) => h !== ''),
  NEARBLOCKS_HOST,
]);

// ---------- shapes ----------

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX_HASH = /^[0-9a-fA-F]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
// Named (a.b.near, with - and _ inside a part) or implicit (64 hex). 2 to 64 characters.
const NEAR_ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
// bech32 (bc1...) or base58check (1... or 3...). Format only, as it was before the checksums in
// src/chainscan/codec.ts existed: a stricter Bitcoin check is a separate change to a fence
// every existing payout card was drawn under.
const BITCOIN_ADDRESS = /^(bc1[02-9ac-hj-np-z]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
const MOVE_ADDRESS = /^0x[0-9a-fA-F]{64}$/;
const TON_RAW = /^(0|-1):[0-9a-fA-F]{64}$/;
const TON_FRIENDLY = /^[A-Za-z0-9_+/-]{48}$/;
const BASE64_HASH = /^[A-Za-z0-9_+/-]{43}=?$/;
const FELT = /^0x[0-9a-fA-F]{1,64}$/;
// The Stark field prime: a felt, and so a Starknet address, is below it.
const STARK_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

export type AddressCheck = { ok: true; normalized: string; checksum?: 'valid' | 'lowercase' } | { ok: false; reason: string };
export type HashCheck = { ok: true; normalized: string } | { ok: false; reason: string };

const MISMATCH = 'the address has a checksum and it does not match: a character was changed or mistyped';

function evmAddressCheck(address: string, label: string): AddressCheck {
  if (!EVM_ADDRESS.test(address)) return { ok: false, reason: `not an address on ${label}: expected 0x followed by 40 hex characters` };
  const checksummed = getAddress(address.toLowerCase());
  // No capitals at all means no checksum was offered, so there is nothing to verify. Any
  // capital means one was, and then it has to match: a mixed-case address with the wrong
  // capitals is the signature of a typo or an edit.
  if (!/[A-F]/.test(address.slice(2))) return { ok: true, normalized: checksummed, checksum: 'lowercase' };
  if (checksummed !== address) return { ok: false, reason: MISMATCH };
  return { ok: true, normalized: checksummed, checksum: 'valid' };
}

/* A base58check address whose payload starts with one of the version prefixes a chain assigns
   (Litecoin's L and M, Dogecoin's D and A, Dash's X and 7, Zcash's two-byte t1 and t3). A
   string in the alphabet that fails the double SHA-256 tail is a changed character; one that
   passes with the wrong version belongs to another chain, and both are refused. */
function versioned(value: string, versions: readonly (readonly number[])[], size: number, shape: string): AddressCheck {
  if (!BASE58.test(value) || value.length < 26 || value.length > 36) return { ok: false, reason: `not ${shape}` };
  const payload = base58Check(value);
  if (payload === null) return { ok: false, reason: MISMATCH };
  const fits = versions.some((v) => payload.length === v.length + size && v.every((b, i) => payload[i] === b));
  return fits ? { ok: true, normalized: value, checksum: 'valid' } : { ok: false, reason: `not ${shape}: it decodes, but to another chain's address` };
}

function cardanoCheck(value: string): AddressCheck {
  const shape = 'not a Cardano address: expected a mainnet addr1... address';
  if (!value.toLowerCase().startsWith('addr1')) return { ok: false, reason: shape };
  const decoded = bech32Decode(value, 120);
  if (decoded === null) return { ok: false, reason: /^addr1[02-9ac-hj-np-z]+$/i.test(value) ? MISMATCH : shape };
  const bytes = fromWords(decoded.words);
  // The header byte: address type in the high nibble (0 to 7 are payment addresses), network in
  // the low (1 is mainnet). Base addresses carry two hashes, enterprise ones one.
  const type = bytes === null ? -1 : bytes[0] >> 4;
  const size = type <= 3 ? 57 : type >= 6 ? 29 : -1;
  if (bytes === null || decoded.variant !== 'bech32' || (bytes[0] & 15) !== 1 || type > 7 || (size > 0 ? bytes.length !== size : bytes.length <= 29)) return { ok: false, reason: shape };
  return { ok: true, normalized: value.toLowerCase(), checksum: 'valid' };
}

function tonCheck(value: string): AddressCheck {
  if (TON_RAW.test(value)) return { ok: true, normalized: value.toLowerCase() };
  const shape = 'not a TON address: expected 0:<64 hex> or a 48-character friendly address';
  if (!TON_FRIENDLY.test(value)) return { ok: false, reason: shape };
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  // flags, workchain, 32-byte account, CRC16 of the 34 before it. A testnet flag (0x80) is a
  // different network's address, refused like one.
  if (bytes.length !== 36 || crc16(bytes.subarray(0, 34)) !== bytes.readUInt16BE(34)) return { ok: false, reason: MISMATCH };
  if ((bytes[0] !== 0x11 && bytes[0] !== 0x51) || (bytes[1] !== 0 && bytes[1] !== 0xff)) return { ok: false, reason: `${shape}: this one is for another network` };
  return { ok: true, normalized: value, checksum: 'valid' };
}

function stellarCheck(value: string): AddressCheck {
  if (!/^G[A-Z2-7]{55}$/.test(value)) return { ok: false, reason: 'not a Stellar account: expected G followed by 55 base32 characters' };
  const bytes = base32Decode(value);
  // Version byte 6 << 3 marks an account key, and the CRC16 is stored little-endian.
  if (bytes === null || bytes.length !== 35 || bytes[0] !== 0x30) return { ok: false, reason: 'not a Stellar account: it does not decode to an account key' };
  const crc = crc16(bytes.subarray(0, 33));
  if (bytes[33] !== (crc & 0xff) || bytes[34] !== crc >> 8) return { ok: false, reason: MISMATCH };
  return { ok: true, normalized: value, checksum: 'valid' };
}

/* THE SAME DECODE, ONE CHAIN OR TWENTY. An EVM address is forty hex and, when it carries capitals,
   its own EIP-55 checksum; that is true of Optimism exactly as it is of Ethereum, and the decoder
   never cared which chain it was for. Keeping the per-chain form meant a new chain could not be
   paid until someone copied a line, which is a fence made of clerical work.

   `label` is only ever printed in a refusal, so a caller that has no word for the chain says
   nothing wrong by leaving it out. */
export function validateAddressForFamily(family: AddressFamily, address: string, label = 'this chain'): AddressCheck {
  const value = typeof address === 'string' ? address.trim() : '';
  if (value === '') return { ok: false, reason: 'no address given' };
  switch (family) {
    case 'evm':
      return evmAddressCheck(value, label);
    case 'sol':
      if (!BASE58.test(value) || value.length < 32 || value.length > 44) return { ok: false, reason: 'not a Solana address: expected 32 to 44 base58 characters' };
      if (base58Decode(value)?.length !== 32) return { ok: false, reason: 'not a Solana address: it does not decode to 32 bytes' };
      return { ok: true, normalized: value };
    case 'near': {
      // An EVM address is a valid NEAR account id in lowercase (the eth-implicit form, and how
      // an intents account is named), so that one spelling is normalised; every other id has
      // to arrive in the lowercase NEAR defines. A mixed-case spelling carries an EIP-55
      // checksum and it has to match: a typo in it used to be lowercased into an account nobody
      // holds. All lowercase or all capitals carries none, the rule intentsAccountProblem in
      // src/rails/intents-send.ts applies to the same id space.
      if (EVM_ADDRESS.test(value)) {
        const body = value.slice(2);
        if (/[A-F]/.test(body) && /[a-f]/.test(body)) {
          const checked = evmAddressCheck(value, label);
          if (!checked.ok) return checked;
          return { ok: true, normalized: value.toLowerCase(), checksum: 'valid' };
        }
        return { ok: true, normalized: value.toLowerCase(), checksum: 'lowercase' };
      }
      if (!NEAR_ACCOUNT.test(value)) return { ok: false, reason: 'not a NEAR account id: expected a lowercase name like alice.near or a 64-character implicit id' };
      return { ok: true, normalized: value };
    }
    case 'btc':
      if (!BITCOIN_ADDRESS.test(value)) return { ok: false, reason: 'not a Bitcoin address: expected bc1... or a 1.../3... address' };
      return { ok: true, normalized: value };
    case 'ltc':
      if (/^ltc1/i.test(value)) return segwit(value, 'ltc') === null ? { ok: false, reason: 'not a Litecoin address: the ltc1... form does not pass its checksum' } : { ok: true, normalized: value.toLowerCase(), checksum: 'valid' };
      return versioned(value, [[0x30], [0x32], [0x05]], 20, 'a Litecoin address: expected ltc1..., L..., M... or 3...');
    case 'bch': {
      // CashAddr, prefix optional as typed and always present once normalised, or the legacy
      // 1.../3... form the chain inherited from Bitcoin.
      if (/^[13]/.test(value)) return versioned(value, [[0x00], [0x05]], 20, 'a Bitcoin Cash address: expected bitcoincash:q..., q..., 1... or 3...');
      if (!/^(bitcoincash:)?[qpzr][02-9ac-hj-np-z]{41,}$/i.test(value)) return { ok: false, reason: 'not a Bitcoin Cash address: expected bitcoincash:q..., q..., 1... or 3...' };
      const payload = cashAddr(value, 'bitcoincash');
      if (payload === null) return { ok: false, reason: MISMATCH };
      // Version byte: type in bits 3 to 6 (0 and 1 plain, 2 and 3 token-aware), size code in
      // the low three (0 is a 20-byte hash, 3 a 32-byte one).
      const type = payload[0] >> 3;
      const code = payload[0] & 7;
      const size = code === 0 ? 20 : code === 3 ? 32 : 0;
      if (type > 3 || size === 0 || payload.length !== size + 1) return { ok: false, reason: 'not a Bitcoin Cash address: the version byte names no address type' };
      const lower = value.toLowerCase();
      return { ok: true, normalized: lower.startsWith('bitcoincash:') ? lower : `bitcoincash:${lower}`, checksum: 'valid' };
    }
    case 'doge':
      return versioned(value, [[0x1e], [0x16]], 20, 'a Dogecoin address: expected D... or A...');
    case 'dash':
      return versioned(value, [[0x4c], [0x10]], 20, 'a Dash address: expected X... or 7...');
    case 'zec':
      // Transparent addresses only: a shielded one has no public balance to read and the
      // bridge hands out t1 addresses.
      return versioned(value, [[0x1c, 0xb8], [0x1c, 0xbd]], 20, 'a transparent Zcash address: expected t1... or t3...');
    case 'xrp': {
      if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return { ok: false, reason: 'not an XRP Ledger address: expected a classic r... address' };
      const payload = base58Check(value, XRP_ALPHABET);
      if (payload === null) return { ok: false, reason: MISMATCH };
      return payload.length === 21 && payload[0] === 0 ? { ok: true, normalized: value, checksum: 'valid' } : { ok: false, reason: 'not an XRP Ledger address: it does not decode to an account id' };
    }
    case 'ton':
      return tonCheck(value);
    case 'tron': {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return { ok: false, reason: 'not a Tron address: expected T followed by 33 base58 characters' };
      const payload = base58Check(value);
      if (payload === null) return { ok: false, reason: MISMATCH };
      return payload.length === 21 && payload[0] === 0x41 ? { ok: true, normalized: value, checksum: 'valid' } : { ok: false, reason: 'not a Tron address: it does not decode to an account' };
    }
    case 'move':
      // Sui, Aptos and Movement accounts are 32 bytes written out in full. A shortened spelling
      // is refused rather than padded: padding is a repair.
      if (!MOVE_ADDRESS.test(value)) return { ok: false, reason: `not an address on ${label}: expected 0x followed by 64 hex characters` };
      return { ok: true, normalized: value.toLowerCase() };
    case 'cardano':
      return cardanoCheck(value);
    case 'stellar':
      return stellarCheck(value);
    case 'starknet': {
      // A felt: the same number with or without its leading zeros, written out to 64 digits once
      // normalised. Starknet's own mixed-case checksum is not verified here, so case is ignored.
      if (!FELT.test(value)) return { ok: false, reason: 'not a Starknet address: expected 0x followed by up to 64 hex characters' };
      const n = BigInt(value);
      if (n === 0n || n >= STARK_PRIME) return { ok: false, reason: 'not a Starknet address: it is outside the field an address lives in' };
      return { ok: true, normalized: `0x${n.toString(16).padStart(64, '0')}` };
    }
    case 'aleo': {
      if (!/^aleo1[02-9ac-hj-np-z]{58}$/.test(value)) return { ok: false, reason: 'not an Aleo address: expected aleo1 followed by 58 characters' };
      const decoded = bech32Decode(value);
      if (decoded === null || decoded.variant !== 'bech32m') return { ok: false, reason: MISMATCH };
      return fromWords(decoded.words)?.length === 32 ? { ok: true, normalized: value, checksum: 'valid' } : { ok: false, reason: 'not an Aleo address: it does not decode to 32 bytes' };
    }
  }
}

/* The chain this module reads for a registry id, which is every chain the deposit card lists
   and the venue's spend-only Abstract. A payout reaches only the ones src/rails/intents-address.ts
   gives a decoder (`pay`): reading an address is what a card would like, decoding one is what
   a payout needs. */
const SCAN_BY_ID: ReadonlyMap<string, ChainNetwork> = new Map(CHAIN_NETWORKS.map((n) => [NETWORKS[n].id, n]));

export function scanNetworkOf(id: string): ChainNetwork | null {
  return SCAN_BY_ID.get(id) ?? null;
}

// The per-chain form every existing caller still uses, over the same decoders.
export function validateAddress(network: ChainNetwork, address: string): AddressCheck {
  return validateAddressForFamily(NETWORKS[network].address, address, NETWORKS[network].label);
}

type HashRule = { reason: string; norm: (value: string) => string | null };

const hexRule = (pattern: RegExp, reason: string, upper = false): HashRule => ({ reason, norm: (v) => (pattern.test(v) ? (upper ? v.toUpperCase() : v.toLowerCase()) : null) });

// Each id normalised to the one spelling its source answers to, so a cache key and a link are
// the same whatever case or encoding was typed.
const HASHES: Readonly<Record<HashFamily, HashRule>> = {
  evm: hexRule(EVM_HASH, 'not an EVM transaction hash: expected 0x followed by 64 hex characters'),
  sol: { reason: 'not a Solana transaction signature: expected 86 to 88 base58 characters', norm: (v) => (SOLANA_SIGNATURE.test(v) ? v : null) },
  near: { reason: 'not a NEAR transaction hash: expected 43 or 44 base58 characters', norm: (v) => (NEAR_HASH.test(v) ? v : null) },
  btc: hexRule(HEX_HASH, 'not a Bitcoin transaction id: expected 64 hex characters'),
  hex: hexRule(HEX_HASH, 'not a transaction id on this chain: expected 64 hex characters'),
  xrp: hexRule(HEX_HASH, 'not an XRP Ledger transaction hash: expected 64 hex characters', true),
  move: hexRule(EVM_HASH, 'not a transaction hash on this chain: expected 0x followed by 64 hex characters'),
  // TON names a transaction by 32 bytes in hex or in base64; both become hex here.
  ton: {
    reason: 'not a TON transaction hash: expected 64 hex characters or 44 base64 characters',
    norm: (v) => (HEX_HASH.test(v) ? v.toLowerCase() : BASE64_HASH.test(v) ? Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex') : null),
  },
  sui: { reason: 'not a Sui transaction digest: expected 43 or 44 base58 characters', norm: (v) => (NEAR_HASH.test(v) && base58Decode(v)?.length === 32 ? v : null) },
  starknet: { reason: 'not a Starknet transaction hash: expected 0x followed by up to 64 hex characters', norm: (v) => (FELT.test(v) && BigInt(v) < STARK_PRIME ? `0x${BigInt(v).toString(16).padStart(64, '0')}` : null) },
  aleo: {
    reason: 'not an Aleo transaction id: expected at1 followed by 58 characters',
    norm: (v) => {
      const d = /^at1[02-9ac-hj-np-z]{58}$/.test(v) ? bech32Decode(v) : null;
      return d !== null && d.variant === 'bech32m' && fromWords(d.words)?.length === 32 ? v : null;
    },
  },
};

export function validateHash(network: ChainNetwork, hash: string): HashCheck {
  const value = typeof hash === 'string' ? hash.trim() : '';
  if (value === '') return { ok: false, reason: 'no transaction hash given' };
  const rule = HASHES[NETWORKS[network].hash];
  const normalized = rule.norm(value);
  return normalized === null ? { ok: false, reason: rule.reason } : { ok: true, normalized };
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
