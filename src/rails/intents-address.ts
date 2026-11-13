// The networks money comes in on and goes out to, and the coins NEAR Intents takes on each.
//
// THE ADDRESS ITSELF IS NOT HERE ANY MORE. Until 2026-11 the POA bridge's JSON-RPC handed this app
// one standing address per (account, network). NEAR Intents is closing that API (its mail of
// 2026-11-12); a deposit address is now a one-time 1Click quote, minted when a card opens
// (src/rails/deposit-quote.ts), and the coin list is 1Click's /v0/tokens. What stays here is the
// registry both of those are read against: which networks exist, what an exchange calls each, the
// key NEAR Intents names it by, and the name 1Click's token list gives it.
//
// THE ACCOUNT ID IS THE EVM ADDRESS, lowercased, which is the same id the verifier keys balances
// by and the same one src/ledger/intents.ts reads with.

import type { ChainId } from '../types.ts';
import type { AddressFamily } from '../chainscan/networks.ts';
import type { OneClickToken } from '../intents.ts';

// The address shape, which is what the window chunks the string by: 0x plus forty hex, a base58
// string, a NEAR account, or something else it prints whole.
export type ReceiveKind = 'evm' | 'sol' | 'near' | 'other';

/* The decoders a payout may be checked by: every family src/chainscan/networks.ts decodes but
   two. Zcash has no chain reader that answers (so the chain cannot be asked about the address
   first) and Aleo is a privacy chain whose delivery nobody here has verified. */
export type PayFamily = Exclude<AddressFamily, 'zec' | 'aleo'>;

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
  // The six quick tiles. Everything else is reached through the search.
  popular: boolean;
  /* The name 1Click's token list gives this chain, which is NOT always our id: the list says
     pol, bsc and hood where this registry says polygon, bnb and robinhood. Explicit rather than
     derived, for the same reason `bridge` is: a wrong name here prices a quote against a
     different chain. Null where the venue lists no token for the chain at all. */
  venue: string | null;
  /* Which of this app's address decoders can validate a payout address here, or null where it
     has none yet. A chain the bridge will accept money FROM is not automatically a chain this
     app may pay money TO: the fence on a payout is that the address was decoded, and a chain
     with no decoder has no fence. */
  pay: PayFamily | null;
};

// No colour here: the window has one colour table, keyed by the mark (PhosphorMarks.colourFor).

/* Every network the bridge lists in supported_tokens, verified against the live list on
   2026-09-16 (34 prefixes). The bridge names networks with the defuse asset identifier prefix,
   not the short name this app uses everywhere else: a bare 'eth' is answered with "Network not
   supported", so the mapping is explicit rather than derived. A wrong bridge key here would
   print an address that belongs to a different chain, and money sent to it is not recoverable.
   EVM names are the ones chainid.network gives the chain ids. A prefix the bridge adds after this
   list was written is not invented here: the report shows it under its raw key. */
export const RECEIVE_NETWORKS: readonly ReceiveNetwork[] = [
  { id: 'eth', name: 'Ethereum', words: 'Ethereum (ERC-20)', bridge: 'eth:1', kind: 'evm', native: 'ETH', mark: 'ETH', popular: true , venue: 'eth', pay: 'evm' },
  { id: 'base', name: 'Base', words: 'Base', bridge: 'eth:8453', kind: 'evm', native: 'ETH', mark: 'BASE', popular: true , venue: 'base', pay: 'evm' },
  { id: 'arb', name: 'Arbitrum', words: 'Arbitrum One', bridge: 'eth:42161', kind: 'evm', native: 'ETH', mark: 'ARB', popular: true , venue: 'arb', pay: 'evm' },
  { id: 'sol', name: 'Solana', words: 'Solana (SPL)', bridge: 'sol:mainnet', kind: 'sol', native: 'SOL', mark: 'SOL', popular: true , venue: 'sol', pay: 'sol' },
  { id: 'near', name: 'NEAR', words: 'NEAR Protocol', bridge: 'near:mainnet', kind: 'near', native: 'NEAR', mark: 'NEAR', popular: true , venue: 'near', pay: 'near' },
  { id: 'btc', name: 'Bitcoin', words: 'Bitcoin (BTC)', bridge: 'btc:mainnet', kind: 'other', native: 'BTC', mark: 'BTC', popular: true , venue: 'btc', pay: 'btc' },
  { id: 'bch', name: 'Bitcoin Cash', words: 'Bitcoin Cash (BCH)', bridge: 'bch:mainnet', kind: 'other', native: 'BCH', mark: 'BCH', popular: false , venue: 'bch', pay: 'bch' },
  { id: 'ltc', name: 'Litecoin', words: 'Litecoin (LTC)', bridge: 'ltc:mainnet', kind: 'other', native: 'LTC', mark: 'LTC', popular: false , venue: 'ltc', pay: 'ltc' },
  { id: 'doge', name: 'Dogecoin', words: 'Dogecoin (DOGE)', bridge: 'doge:mainnet', kind: 'other', native: 'DOGE', mark: 'DOGE', popular: false , venue: 'doge', pay: 'doge' },
  { id: 'dash', name: 'Dash', words: 'Dash (DASH)', bridge: 'dash:mainnet', kind: 'other', native: 'DASH', mark: 'DASH', popular: false , venue: 'dash', pay: 'dash' },
  { id: 'zec', name: 'Zcash', words: 'Zcash (ZEC)', bridge: 'zec:mainnet', kind: 'other', native: 'ZEC', mark: 'ZEC', popular: false , venue: 'zec', pay: null },
  { id: 'xrp', name: 'XRP Ledger', words: 'XRP Ledger (XRP)', bridge: 'xrp:mainnet', kind: 'other', native: 'XRP', mark: 'XRP', popular: false , venue: 'xrp', pay: 'xrp' },
  { id: 'ton', name: 'TON', words: 'TON (The Open Network)', bridge: 'ton:mainnet', kind: 'other', native: 'GRAM', mark: 'TON', popular: false , venue: 'ton', pay: 'ton' },
  { id: 'tron', name: 'Tron', words: 'Tron (TRC-20)', bridge: 'tron:mainnet', kind: 'other', native: 'TRX', mark: 'TRX', popular: false , venue: 'tron', pay: 'tron' },
  { id: 'sui', name: 'Sui', words: 'Sui (SUI)', bridge: 'sui:mainnet', kind: 'other', native: 'SUI', mark: 'SUI', popular: false , venue: 'sui', pay: 'move' },
  { id: 'aptos', name: 'Aptos', words: 'Aptos (APT)', bridge: 'aptos:mainnet', kind: 'other', native: 'APT', mark: 'APT', popular: false , venue: 'aptos', pay: 'move' },
  { id: 'cardano', name: 'Cardano', words: 'Cardano (ADA)', bridge: 'cardano:mainnet', kind: 'other', native: 'ADA', mark: 'ADA', popular: false , venue: 'cardano', pay: 'cardano' },
  { id: 'stellar', name: 'Stellar', words: 'Stellar (XLM)', bridge: 'stellar:mainnet', kind: 'other', native: 'XLM', mark: 'XLM', popular: false , venue: 'stellar', pay: 'stellar' },
  { id: 'starknet', name: 'Starknet', words: 'Starknet', bridge: 'starknet:mainnet', kind: 'other', native: 'STRK', mark: 'STRK', popular: false , venue: 'starknet', pay: 'starknet' },
  { id: 'aleo', name: 'Aleo', words: 'Aleo', bridge: 'aleo:mainnet', kind: 'other', native: 'ALEO', mark: 'ALEO', popular: false , venue: 'aleo', pay: null },
  // Fogo runs the Solana virtual machine and its addresses are base58 like Solana's.
  { id: 'fogo', name: 'Fogo', words: 'Fogo', bridge: 'fogo:mainnet', kind: 'sol', native: 'FOGO', mark: 'FOGO', popular: false , venue: 'fogo', pay: 'sol' },
  { id: 'movement', name: 'Movement', words: 'Movement', bridge: 'movement:mainnet', kind: 'other', native: 'MOVE', mark: 'MOVE', popular: false , venue: 'movement', pay: 'move' },
  // HyperCore credits an EVM address: the bridge hands back the same address as the EVM chains.
  { id: 'hypercore', name: 'Hyperliquid', words: 'Hyperliquid (HyperCore)', bridge: 'hypercore:mainnet', kind: 'evm', native: 'HYPE', mark: 'HYPE', popular: false , venue: 'hypercore', pay: 'evm' },
  { id: 'op', name: 'Optimism', words: 'Optimism (OP Mainnet)', bridge: 'eth:10', kind: 'evm', native: 'ETH', mark: 'OP', popular: false , venue: 'op', pay: 'evm' },
  { id: 'gnosis', name: 'Gnosis', words: 'Gnosis Chain', bridge: 'eth:100', kind: 'evm', native: 'xDAI', mark: 'GNO', popular: false , venue: 'gnosis', pay: 'evm' },
  { id: 'polygon', name: 'Polygon', words: 'Polygon (POS)', bridge: 'eth:137', kind: 'evm', native: 'POL', mark: 'POL', popular: false , venue: 'pol', pay: 'evm' },
  { id: 'monad', name: 'Monad', words: 'Monad', bridge: 'eth:143', kind: 'evm', native: 'MON', mark: 'MON', popular: false , venue: 'monad', pay: 'evm' },
  { id: 'xlayer', name: 'X Layer', words: 'X Layer (OKX)', bridge: 'eth:196', kind: 'evm', native: 'OKB', mark: 'XLAYER', popular: false , venue: 'xlayer', pay: 'evm' },
  { id: 'adi', name: 'ADI Chain', words: 'ADI Chain', bridge: 'eth:36900', kind: 'evm', native: 'ADI', mark: 'ADI', popular: false , venue: 'adi', pay: 'evm' },
  { id: 'avax', name: 'Avalanche', words: 'Avalanche (C-Chain)', bridge: 'eth:43114', kind: 'evm', native: 'AVAX', mark: 'AVAX', popular: false , venue: 'avax', pay: 'evm' },
  { id: 'robinhood', name: 'Robinhood Chain', words: 'Robinhood Chain', bridge: 'eth:4663', kind: 'evm', native: 'ETH', mark: 'ROBINHOOD', popular: false , venue: 'hood', pay: 'evm' },
  { id: 'scroll', name: 'Scroll', words: 'Scroll', bridge: 'eth:534352', kind: 'evm', native: 'ETH', mark: 'SCROLL', popular: false , venue: 'scroll', pay: 'evm' },
  { id: 'bnb', name: 'BNB Smart Chain', words: 'BNB Smart Chain (BEP-20)', bridge: 'eth:56', kind: 'evm', native: 'BNB', mark: 'BNB', popular: false , venue: 'bsc', pay: 'evm' },
  { id: 'bera', name: 'Berachain', words: 'Berachain', bridge: 'eth:80094', kind: 'evm', native: 'BERA', mark: 'BERA', popular: false , venue: 'bera', pay: 'evm' },
  { id: 'plasma', name: 'Plasma', words: 'Plasma', bridge: 'eth:9745', kind: 'evm', native: 'XPL', mark: 'XPL', popular: false , venue: 'plasma', pay: 'evm' },
];

/* The chains the venue lists a token on that the bridge lists no prefix for, so money can be
   swapped into them and cannot be deposited from them. They stay out of RECEIVE_NETWORKS because
   that list is exactly what the bridge answers for, and a row there with a bridge key the bridge
   does not know is a deposit address that cannot be minted. `bridge` is the eth chain id, which
   is what the bridge will key the chain by the day it appears. */
const SPEND_ONLY_NETWORKS: readonly ReceiveNetwork[] = [
  { id: 'abs', name: 'Abstract', words: 'Abstract', bridge: 'eth:2741', kind: 'evm', native: 'ETH', mark: 'ABS', popular: false, venue: 'abs', pay: 'evm' },
];

const BY_ID = new Map(RECEIVE_NETWORKS.map((n) => [n.id, n]));
const BY_BRIDGE = new Map(RECEIVE_NETWORKS.map((n) => [n.bridge, n]));

/* Every chain a spend may name: the registry minus the rows the venue lists no token for, plus
   the rows only the venue has. */
export const SPEND_NETWORKS: readonly ReceiveNetwork[] = [
  ...RECEIVE_NETWORKS.filter((n) => n.venue !== null),
  ...SPEND_ONLY_NETWORKS,
];

const BY_SPEND_ID = new Map(SPEND_NETWORKS.map((n) => [n.id, n]));
const BY_VENUE = new Map(SPEND_NETWORKS.map((n) => [n.venue as string, n]));

/* A chain a spend may name. Wider than receiveNetworkOf by the spend-only rows, and narrower by
   the rows the venue lists nothing on, which is why the two lookups are not one. */
export function spendNetworkOf(id: string): ReceiveNetwork | undefined {
  return BY_SPEND_ID.get(id) ?? BY_ID.get(id);
}

export function networkByVenue(venue: string): ReceiveNetwork | undefined {
  return BY_VENUE.get(venue.toLowerCase());
}

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
/* Coins renamed after the bridge named them. Toncoin became Gram (GRAM) on 2026-06-15 by the TON
   community's vote; the network is still TON, and the bridge still lists the coin as 'TON'. A
   person reads the coin's name off an exchange's withdraw screen, so the old name is never shown. */
const RENAMED_BY_ID: Record<string, string> = { 'ton:mainnet:native': 'GRAM' };
const RENAMED_BY_CHAIN: Record<string, Record<string, string>> = { ton: { TON: 'GRAM' } };

/* The coin's current ticker for a symbol an agent or a person typed on a network: TON on TON is
   GRAM. Anything else comes back as it came. */
export function currentSymbol(chain: string, symbol: string): string {
  return RENAMED_BY_CHAIN[chain]?.[symbol] ?? symbol;
}

export function parsePoaToken(row: unknown): PoaToken | null {
  const r = (row ?? {}) as Record<string, unknown>;
  const id = r.defuse_asset_identifier;
  const symbol = typeof id === 'string' && RENAMED_BY_ID[id] !== undefined ? RENAMED_BY_ID[id] : r.asset_name;
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

/* 1Click's token list as the rows the receive report reads: every coin 1Click lists on a network
   the registry knows, keyed by that network's bridge key so the rest of the report (and Activity)
   keeps naming networks one way. A coin on a chain the registry does not know is left out: a chain
   with no row has no name, no address rule and no words for an exchange's withdraw screen, and a
   deposit address with none of those is a guess. The floor is not on the list: it comes with the
   address, from the quote that mints it, so `minDeposit` is empty here and the window prints none.
   The contract is 1Click's own field; on NEAR every coin has one (wNEAR is wrap.near), and that is
   the truth the card tells: on NEAR the address takes tokens, not plain NEAR. */
export function tokensFromOneClick(list: readonly OneClickToken[]): PoaToken[] {
  const out: PoaToken[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (t === null || typeof t !== 'object' || typeof t.assetId !== 'string' || typeof t.symbol !== 'string') continue;
    if (typeof t.decimals !== 'number' || !Number.isInteger(t.decimals) || t.decimals < 0) continue;
    const net = typeof t.blockchain === 'string' ? networkByVenue(t.blockchain) : undefined;
    if (net === undefined || receiveNetworkOf(net.id) === undefined) continue;
    if (seen.has(t.assetId)) continue;
    seen.add(t.assetId);
    const contract = typeof t.contractAddress === 'string' && t.contractAddress.trim() !== '' ? t.contractAddress.trim() : null;
    out.push({
      network: net.bridge,
      symbol: currentSymbol(net.id, t.symbol),
      decimals: t.decimals,
      minDeposit: '',
      minDepositHuman: '',
      contract,
      intentsAssetId: t.assetId,
      nearTokenId: t.assetId.replace(/^nep141:/, ''),
    });
  }
  return out;
}
