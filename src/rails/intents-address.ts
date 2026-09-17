// A deposit address for the NEAR Intents balance: the plain "here is where to send it" that
// every wallet has and this app did not.
//
// WHY THIS AND NOT THE 1CLICK ADDRESS THE DEPOSIT RAIL ALREADY MINTS. src/rails/intents-deposit.ts
// asks 1Click for a quote and sends to the address that quote mints. That address belongs to one
// quote, one asset and one amount, and it stops working at the quote's deadline, which the API
// documents as "the time when the deposit address becomes inactive and funds may be lost". It is
// a swap deposit, and it is the right shape when the app is the one spending.
//
// This is the other question: a person, or an exchange withdrawal, sending money in from outside.
// Nothing here quotes, nothing here has an amount, and nothing here expires. The POA bridge hands
// back one address per (account, network) and hands back the SAME address every time, so it can
// be drawn once, put behind a QR code, saved in an exchange's address book, and used again next
// month. That is what a person means by a deposit address.
//
// WHAT IT IS, precisely: an address the bridge controls, which forwards what it receives to the
// verifier and credits it to our account id. Phosphor never holds it and never sends to it, so it
// is deliberately NOT on the policy allowlist and does not belong there: the allowlist governs
// what this app may send to, and this is an address other people send to. Reading it is a read.
//
// THE ACCOUNT ID IS THE EVM ADDRESS, lowercased, which is the same id the verifier keys balances
// by and the same one src/ledger/intents.ts reads with. Probed against the live bridge: it is
// case insensitive on the account id, it returns one address for every EVM network and for
// HyperCore, and it refuses an account id it cannot parse rather than inventing one.

import type { ChainId } from '../types.ts';
import { readTimeout } from '../net.ts';

export const POA_BRIDGE_RPC = 'https://bridge.chaindefuser.com/rpc';

// The address shape, which is what the window chunks the string by: 0x plus forty hex, a base58
// string, a NEAR account, or something else it prints whole.
export type ReceiveKind = 'evm' | 'sol' | 'near' | 'other';

export type ReceiveNetwork = {
  // The short id the app uses everywhere: the route, the watch, the agent tool. The five the app
  // has always had keep theirs; the rest are the plainest word for the chain.
  id: string;
  name: string;
  // What an exchange's withdraw screen calls the network. The pick on that screen is where a
  // deposit is lost, so this is spelled the way that screen spells it.
  words: string;
  // The bridge's key: the first two segments of its defuse asset identifier.
  bridge: string;
  kind: ReceiveKind;
  // The chain's own coin.
  native: string;
  // The symbol marks.js draws the tile with.
  mark: string;
  // The brand hex, or the quiet grey where the chain has no colour anyone knows.
  colour: string;
  // The six quick tiles. Everything else is reached through the search.
  popular: boolean;
};

const QUIET = '#8A8F98';

/* Every network the bridge lists in supported_tokens, verified against the live list on
   2026-09-16 (34 prefixes). The bridge names networks with the defuse asset identifier prefix,
   not the short name this app uses everywhere else: a bare 'eth' is answered with "Network not
   supported", so the mapping is explicit rather than derived. A wrong bridge key here would
   print an address that belongs to a different chain, and money sent to it is not recoverable.
   EVM names are the ones chainid.network gives the chain ids. A prefix the bridge adds after this
   list was written is not invented here: the report shows it under its raw key. */
export const RECEIVE_NETWORKS: readonly ReceiveNetwork[] = [
  { id: 'eth', name: 'Ethereum', words: 'Ethereum (ERC-20)', bridge: 'eth:1', kind: 'evm', native: 'ETH', mark: 'ETH', colour: '#627EEA', popular: true },
  { id: 'base', name: 'Base', words: 'Base', bridge: 'eth:8453', kind: 'evm', native: 'ETH', mark: 'BASE', colour: '#0052FF', popular: true },
  { id: 'arb', name: 'Arbitrum', words: 'Arbitrum One', bridge: 'eth:42161', kind: 'evm', native: 'ETH', mark: 'ARB', colour: '#12AAFF', popular: true },
  { id: 'sol', name: 'Solana', words: 'Solana (SPL)', bridge: 'sol:mainnet', kind: 'sol', native: 'SOL', mark: 'SOL', colour: '#9945FF', popular: true },
  { id: 'near', name: 'NEAR', words: 'NEAR Protocol', bridge: 'near:mainnet', kind: 'near', native: 'NEAR', mark: 'NEAR', colour: '#00EC97', popular: true },
  { id: 'btc', name: 'Bitcoin', words: 'Bitcoin (BTC)', bridge: 'btc:mainnet', kind: 'other', native: 'BTC', mark: 'BTC', colour: '#F7931A', popular: true },
  { id: 'bch', name: 'Bitcoin Cash', words: 'Bitcoin Cash (BCH)', bridge: 'bch:mainnet', kind: 'other', native: 'BCH', mark: 'BCH', colour: '#8DC351', popular: false },
  { id: 'ltc', name: 'Litecoin', words: 'Litecoin (LTC)', bridge: 'ltc:mainnet', kind: 'other', native: 'LTC', mark: 'LTC', colour: '#345D9D', popular: false },
  { id: 'doge', name: 'Dogecoin', words: 'Dogecoin (DOGE)', bridge: 'doge:mainnet', kind: 'other', native: 'DOGE', mark: 'DOGE', colour: '#C2A633', popular: false },
  { id: 'dash', name: 'Dash', words: 'Dash (DASH)', bridge: 'dash:mainnet', kind: 'other', native: 'DASH', mark: 'DASH', colour: '#008DE4', popular: false },
  { id: 'zec', name: 'Zcash', words: 'Zcash (ZEC)', bridge: 'zec:mainnet', kind: 'other', native: 'ZEC', mark: 'ZEC', colour: '#F4B728', popular: false },
  { id: 'xrp', name: 'XRP Ledger', words: 'XRP Ledger (XRP)', bridge: 'xrp:mainnet', kind: 'other', native: 'XRP', mark: 'XRP', colour: QUIET, popular: false },
  { id: 'ton', name: 'TON', words: 'TON (The Open Network)', bridge: 'ton:mainnet', kind: 'other', native: 'TON', mark: 'TON', colour: '#0098EA', popular: false },
  { id: 'tron', name: 'Tron', words: 'Tron (TRC-20)', bridge: 'tron:mainnet', kind: 'other', native: 'TRX', mark: 'TRX', colour: '#FF060A', popular: false },
  { id: 'sui', name: 'Sui', words: 'Sui (SUI)', bridge: 'sui:mainnet', kind: 'other', native: 'SUI', mark: 'SUI', colour: '#4DA2FF', popular: false },
  { id: 'aptos', name: 'Aptos', words: 'Aptos (APT)', bridge: 'aptos:mainnet', kind: 'other', native: 'APT', mark: 'APT', colour: '#00D2CE', popular: false },
  { id: 'cardano', name: 'Cardano', words: 'Cardano (ADA)', bridge: 'cardano:mainnet', kind: 'other', native: 'ADA', mark: 'ADA', colour: '#0033AD', popular: false },
  { id: 'stellar', name: 'Stellar', words: 'Stellar (XLM)', bridge: 'stellar:mainnet', kind: 'other', native: 'XLM', mark: 'XLM', colour: '#7D00FF', popular: false },
  { id: 'starknet', name: 'Starknet', words: 'Starknet', bridge: 'starknet:mainnet', kind: 'other', native: 'STRK', mark: 'STRK', colour: '#EC796B', popular: false },
  { id: 'aleo', name: 'Aleo', words: 'Aleo', bridge: 'aleo:mainnet', kind: 'other', native: 'ALEO', mark: 'ALEO', colour: QUIET, popular: false },
  // Fogo runs the Solana virtual machine and its addresses are base58 like Solana's.
  { id: 'fogo', name: 'Fogo', words: 'Fogo', bridge: 'fogo:mainnet', kind: 'sol', native: 'FOGO', mark: 'FOGO', colour: QUIET, popular: false },
  { id: 'movement', name: 'Movement', words: 'Movement', bridge: 'movement:mainnet', kind: 'other', native: 'MOVE', mark: 'MOVE', colour: QUIET, popular: false },
  // HyperCore credits an EVM address: the bridge hands back the same address as the EVM chains.
  { id: 'hypercore', name: 'Hyperliquid', words: 'Hyperliquid (HyperCore)', bridge: 'hypercore:mainnet', kind: 'evm', native: 'HYPE', mark: 'HYPE', colour: '#97FCE4', popular: false },
  { id: 'op', name: 'Optimism', words: 'Optimism (OP Mainnet)', bridge: 'eth:10', kind: 'evm', native: 'ETH', mark: 'OP', colour: '#FF0420', popular: false },
  { id: 'gnosis', name: 'Gnosis', words: 'Gnosis Chain', bridge: 'eth:100', kind: 'evm', native: 'xDAI', mark: 'GNO', colour: '#3E6957', popular: false },
  { id: 'polygon', name: 'Polygon', words: 'Polygon (POS)', bridge: 'eth:137', kind: 'evm', native: 'POL', mark: 'POL', colour: '#8247E5', popular: false },
  { id: 'monad', name: 'Monad', words: 'Monad', bridge: 'eth:143', kind: 'evm', native: 'MON', mark: 'MON', colour: '#836EF9', popular: false },
  { id: 'xlayer', name: 'X Layer', words: 'X Layer (OKX)', bridge: 'eth:196', kind: 'evm', native: 'OKB', mark: 'XLAYER', colour: QUIET, popular: false },
  { id: 'adi', name: 'ADI Chain', words: 'ADI Chain', bridge: 'eth:36900', kind: 'evm', native: 'ADI', mark: 'ADI', colour: QUIET, popular: false },
  { id: 'avax', name: 'Avalanche', words: 'Avalanche (C-Chain)', bridge: 'eth:43114', kind: 'evm', native: 'AVAX', mark: 'AVAX', colour: '#E84142', popular: false },
  { id: 'robinhood', name: 'Robinhood Chain', words: 'Robinhood Chain', bridge: 'eth:4663', kind: 'evm', native: 'ETH', mark: 'ROBINHOOD', colour: QUIET, popular: false },
  { id: 'scroll', name: 'Scroll', words: 'Scroll', bridge: 'eth:534352', kind: 'evm', native: 'ETH', mark: 'SCROLL', colour: '#FFEEDA', popular: false },
  { id: 'bnb', name: 'BNB Smart Chain', words: 'BNB Smart Chain (BEP-20)', bridge: 'eth:56', kind: 'evm', native: 'BNB', mark: 'BNB', colour: '#F3BA2F', popular: false },
  { id: 'bera', name: 'Berachain', words: 'Berachain', bridge: 'eth:80094', kind: 'evm', native: 'BERA', mark: 'BERA', colour: '#814625', popular: false },
  { id: 'plasma', name: 'Plasma', words: 'Plasma', bridge: 'eth:9745', kind: 'evm', native: 'XPL', mark: 'XPL', colour: '#00FF85', popular: false },
];

const BY_ID = new Map(RECEIVE_NETWORKS.map((n) => [n.id, n]));
const BY_BRIDGE = new Map(RECEIVE_NETWORKS.map((n) => [n.bridge, n]));

export function receiveNetworkOf(id: string): ReceiveNetwork | undefined {
  return BY_ID.get(id);
}

export function receiveNetworkByBridge(bridge: string): ReceiveNetwork | undefined {
  return BY_BRIDGE.get(bridge);
}

// The bridge's own spelling: lowercase letters and digits either side of one colon.
const BRIDGE_KEY = /^[a-z0-9]+:[a-z0-9]+$/;

/* A short id or a raw bridge key, to the bridge key. A raw key passes through untouched so a
   network the registry does not know yet can still be asked about; anything else is undefined
   rather than a guess, because a guessed key is an address on the wrong chain. */
export function bridgeKeyOf(idOrKey: string): string | undefined {
  const known = BY_ID.get(idOrKey);
  if (known !== undefined) return known.bridge;
  return BRIDGE_KEY.test(idOrKey) ? idOrKey : undefined;
}

function bridgeOf(id: ChainId): string {
  const network = BY_ID.get(id);
  if (network === undefined) throw new Error(`the receive registry has no ${id}`);
  return network.bridge;
}

/* The five chains the rest of the app is typed on, as a view of the registry, so the callers
   that predate it keep working and the two can never disagree. */
export const POA_NETWORK: Record<ChainId, string> = {
  eth: bridgeOf('eth'),
  base: bridgeOf('base'),
  arb: bridgeOf('arb'),
  sol: bridgeOf('sol'),
  near: bridgeOf('near'),
};

export type PoaDepositAddress = {
  // The id or key the caller asked with, echoed so a batch of answers can be told apart.
  chain: string;
  network: string;
  address: string;
  // Set on the chains that route by memo. Stellar is one today: the bridge hands back one
  // address for everybody and a memo that says whose the deposit is, so a memo dropped on the
  // sending side is a lost deposit. The field exists to be rendered rather than assumed absent.
  memo: string | null;
};

type RpcResult = { result?: { address?: unknown; chain?: unknown; memo?: unknown }; error?: unknown };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function rpc(method: string, params: unknown[], fetchImpl: typeof fetch): Promise<RpcResult> {
  const res = await fetchImpl(POA_BRIDGE_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'phosphor', jsonrpc: '2.0', method, params }),
    signal: readTimeout(),
  });
  if (!res.ok) throw new Error(`poa bridge ${method} http ${res.status}`);
  return (await res.json()) as RpcResult;
}

function errorSaid(error: unknown): string {
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/* One address for one account on one network.
 *
 * Throws rather than returning null, because every failure here has a different answer for the
 * person reading the screen: an unsupported network is a permanent no, a rejected account id is
 * a bug in what we sent, and a timeout is "try again". A single null would flatten the three into
 * one blank box beside a QR code, and a blank box next to the words "deposit address" is the
 * worst thing this module could produce.
 *
 * `chain` is a registry id or a raw bridge key. A chain that routes by memo refuses the plain
 * ask with "Deposit mode MEMO is required for this chain" (Stellar, live on 2026-09-16), and is
 * asked again in memo mode rather than greyed out: the memo comes back beside the address and
 * is carried, because it is half of where the money goes.
 */
export async function intentsDepositAddress(
  accountId: string,
  chain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PoaDepositAddress> {
  const network = bridgeKeyOf(chain);
  if (network === undefined) throw new Error(`no bridge network is mapped for ${chain}`);

  const ask = (mode?: 'MEMO'): Promise<RpcResult> =>
    rpc(
      'deposit_address',
      [{ account_id: accountId.toLowerCase(), chain: network, ...(mode === undefined ? {} : { deposit_mode: mode }) }],
      fetchImpl,
    );

  let body: RpcResult;
  try {
    body = await ask();
    if (body.error !== undefined && /deposit mode MEMO is required/i.test(errorSaid(body.error))) body = await ask('MEMO');
  } catch (err) {
    throw new Error(`the bridge did not answer for ${network}: ${errText(err)}`);
  }

  if (body.error !== undefined) {
    throw new Error(`the bridge refused ${network}: ${errorSaid(body.error)}`);
  }

  const address = body.result?.address;
  /* An address is the whole answer, so a response that does not carry one as a non-empty string
     is a failure however cheerful its status code was. Rendering an empty string under a QR code
     would be a receive screen that tells somebody to send money nowhere. */
  if (typeof address !== 'string' || address.trim() === '') {
    throw new Error(`the bridge answered for ${network} without an address`);
  }

  const memo = body.result?.memo;
  return {
    chain,
    network,
    address: address.trim(),
    memo: typeof memo === 'string' && memo.trim() !== '' ? memo.trim() : null,
  };
}

export type PoaToken = {
  network: string;
  symbol: string;
  decimals: number;
  // The bridge's floor in base units, as it sent it. Kept for anything that compares raw amounts.
  minDeposit: string;
  // The same floor in the unit a person reads: "0.001", never "1000". This is the one a screen
  // or an agent prints; the raw string printed beside a symbol read as a thousand USDC.
  minDepositHuman: string;
  // The token's contract on its chain, null for the chain's own coin.
  contract: string | null;
  intentsAssetId: string;
  // The NEAR token the bridge mints for it, which is how two bridge rows for one coin are seen
  // to be one coin.
  nearTokenId: string;
};

/* Base units to the number a person reads, by string arithmetic: "1000" at 6 decimals is
   "0.001", "100000000000" at 18 is "0.0000001", "1000000" at 6 is "1". A float would print
   1e-7 for the second and drift on the big ones, and a minimum is a number somebody compares
   against the amount they are about to type. Anything that is not a whole number of base
   units comes back as it arrived rather than as an invented figure. */
export function humanAmount(raw: string, decimals: number): string {
  const digits = String(raw ?? '').trim();
  if (!/^\d+$/.test(digits) || !Number.isInteger(decimals) || decimals < 0) return digits;
  const units = BigInt(digits).toString();
  if (decimals === 0) return units;
  const padded = units.length > decimals ? units : '0'.repeat(decimals - units.length + 1) + units;
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/* One bridge row to one token, or null where the row cannot be read. Shared by the live list
   and the demo fixture so both say the same thing about the same row.

   The contract is `origin_chain_address`, which the bridge spells the way the chain does (an EVM
   address checksummed), and that is the string a person copies into an explorer. The live rows
   spell a chain's own coin 'eth:8453:native' with origin_chain_address 'native', so the word
   'native' is never a contract: it is null. Two rows (APT, MOVE) say 'native' in the address and
   carry the coin's type in the identifier; that type is what an explorer takes, so it is kept. */
export function parsePoaToken(row: unknown): PoaToken | null {
  const r = (row ?? {}) as Record<string, unknown>;
  const id = r.defuse_asset_identifier;
  const symbol = r.asset_name;
  const decimals = r.decimals;
  const min = r.min_deposit_amount;
  const assetId = r.intents_token_id;
  if (typeof id !== 'string' || typeof symbol !== 'string' || typeof decimals !== 'number') return null;
  // 'eth:1:0xa0b8...', 'eth:1:native', or a bare 'eth:1': the network is the first two segments
  // and the identifier's own contract, when there is one, is everything after them.
  const parts = id.split(':');
  const rest = parts.slice(2).join(':');
  const origin = typeof r.origin_chain_address === 'string' ? r.origin_chain_address.trim() : '';
  const contract = origin !== '' && origin !== 'native' ? origin : rest !== '' && rest !== 'native' ? rest : null;
  const minDeposit = typeof min === 'string' ? min : String(min ?? '0');
  return {
    network: parts.slice(0, 2).join(':'),
    symbol,
    decimals,
    minDeposit,
    minDepositHuman: humanAmount(minDeposit, decimals),
    contract,
    intentsAssetId: typeof assetId === 'string' ? assetId : '',
    nearTokenId: typeof r.near_token_id === 'string' ? r.near_token_id : '',
  };
}

export function parsePoaTokens(rows: unknown): PoaToken[] {
  if (!Array.isArray(rows)) return [];
  const out: PoaToken[] = [];
  for (const row of rows) {
    const token = parsePoaToken(row);
    if (token !== null) out.push(token);
  }
  return out;
}

/* What the bridge will actually accept, per network. This is the half of a receive screen that
   stops a loss: an asset the bridge does not list for that network is not credited and is not
   refunded, so the screen names what may be sent rather than leaving a person to guess from the
   address alone. Never throws; an unreadable list costs the guidance, not the address. */
export async function poaSupportedTokens(fetchImpl: typeof fetch = fetch): Promise<PoaToken[]> {
  try {
    const body = (await rpc('supported_tokens', [{}], fetchImpl)) as { result?: { tokens?: unknown } };
    return parsePoaTokens(body.result?.tokens);
  } catch {
    return [];
  }
}

// `amount` is in base units; `decimals` is the row's own scale when the bridge sent one.
export type PoaDeposit = { txHash: string; amount: string; status: string; asset: string; decimals?: number };

/* What the bridge has SEEN, which is not the same question as what the verifier has CREDITED.
   The settled truth is mt_batch_balance_of in src/ledger/intents.ts, and that is what the wallet
   reports. This exists to answer the ten minutes in between, when a person has sent money and the
   balance has not moved yet, so the screen can say "seen, not credited" instead of nothing. Never
   throws: this is a nicety on top of a balance that is read elsewhere. `chain` is a registry id
   or a raw bridge key; anything else is an empty list. */
export async function poaRecentDeposits(
  accountId: string,
  chain: string,
  fetchImpl: typeof fetch = fetch,
  limit = 10,
): Promise<PoaDeposit[]> {
  try {
    return await poaRecentDepositsOrThrow(accountId, chain, fetchImpl, limit);
  } catch {
    return [];
  }
}

/* The same read for a caller that has to tell a failure from an empty list: the deposit watch
   remembers which rows were already complete when it began, and a first poll that failed must
   not read as "none were". Throws where poaRecentDeposits returns []; an unknown chain is still
   an empty list, because that is an answer. */
export async function poaRecentDepositsOrThrow(
  accountId: string,
  chain: string,
  fetchImpl: typeof fetch = fetch,
  limit = 10,
): Promise<PoaDeposit[]> {
  const network = bridgeKeyOf(chain);
  if (network === undefined) return [];
  const body = (await rpc(
    'recent_deposits',
    [{ account_id: accountId.toLowerCase(), chain: network, limit }],
    fetchImpl,
  )) as { result?: { deposits?: unknown }; error?: unknown };
  if (body.error !== undefined) throw new Error(`poa bridge recent_deposits: ${errorSaid(body.error)}`);
  const rows = body.result?.deposits;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      txHash: typeof r.tx_hash === 'string' ? r.tx_hash : '',
      amount: typeof r.amount === 'string' ? r.amount : String(r.amount ?? ''),
      status: typeof r.status === 'string' ? r.status : 'unknown',
      asset: typeof r.defuse_asset_identifier === 'string' ? r.defuse_asset_identifier : '',
      ...(typeof r.decimals === 'number' && Number.isInteger(r.decimals) ? { decimals: r.decimals } : {}),
    };
  });
}
