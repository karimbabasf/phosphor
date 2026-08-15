// The transaction history: what this app actually did with money, as a list.
//
// It is DERIVED, never a second ledger. The proposal store already holds every write this
// app has made, and the audit log already holds the hashes those writes produced. This
// joins the two and adds the three things a person reading a wallet expects and neither
// source carries: which explorer a hash belongs to, what it cost in gas, and which side of
// the trade an address is on. Nothing here is authored: every number traces to a proposal,
// a receipt, or a quote the human approved.
//
// Why the audit log for hashes. executeRail logs {id, txids} and stores {ok, detail} on the
// proposal, so the hashes have historically lived in the log alone. They are now written to
// the proposal as well (see proposals.ts), because the log is compactable and a compacted
// log would take the evidence with it. Old records still resolve through the join.

import fs from 'node:fs';
import path from 'node:path';
import type { ChainId, LogEvent, Network, Proposal, WriteDraft } from './types.ts';
import { chainSpec, reader } from './chain/evm.ts';

// ---------- explorers ----------

// Per network, per chain: where a hash and an address are looked at. The EVM tx prefixes
// come from src/chain/evm.ts so a rail's evidence link and this table can never disagree;
// only the non-EVM chains and the address forms are stated here.
const NON_EVM: Record<Network, Partial<Record<TxPlace, { tx: string; address: string }>>> = {
  mainnet: {
    sol: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
    near: { tx: 'https://nearblocks.io/txns/', address: 'https://nearblocks.io/address/' },
    intents: { tx: 'https://nearblocks.io/txns/', address: 'https://nearblocks.io/address/' },
  },
  testnet: {
    sol: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
    near: { tx: 'https://testnet.nearblocks.io/txns/', address: 'https://testnet.nearblocks.io/address/' },
    intents: { tx: 'https://testnet.nearblocks.io/txns/', address: 'https://testnet.nearblocks.io/address/' },
  },
};

export type TxPlace = ChainId | 'intents';

// An EVM explorer's address page is its tx page with one path segment swapped. Deriving it
// keeps one table rather than two that can drift apart.
function evmExplorer(network: Network, chain: ChainId): { tx: string; address: string } | null {
  try {
    const spec = chainSpec(network, chain);
    return { tx: spec.explorerTx, address: spec.explorerTx.replace(/\/tx\/$/, '/address/') };
  } catch {
    return null;
  }
}

function explorerFor(network: Network, place: TxPlace): { tx: string; address: string } | null {
  const nonEvm = NON_EVM[network][place];
  if (nonEvm !== undefined) return nonEvm;
  return evmExplorer(network, place as ChainId);
}

export function explorerTxUrl(network: Network, place: TxPlace, hash: string): string | null {
  const table = explorerFor(network, place);
  if (table === null || hash.length === 0) return null;
  return table.tx + hash;
}

export function explorerAddressUrl(network: Network, place: TxPlace, address: string): string | null {
  // A balance inside intents.near is not an account any explorer has a page for: it is a
  // row in the verifier's own state, keyed by an address that belongs to another chain.
  // No link is the honest answer; `npm run intents-balance` is where that is checked.
  if (place === 'intents') return null;
  const table = explorerFor(network, place);
  if (table === null || address.length === 0) return null;
  // A NEAR account id is a name, not a hash, and nearblocks resolves it on the same path.
  return table.address + address;
}

// ---------- the entry model ----------

export type TxHash = {
  hash: string;
  place: TxPlace;
  // 'chain' is a transaction that was broadcast and paid gas. 'intent' is a signed intent
  // settled by a solver: it has a hash to look at and no gas of our own, and calling both
  // of them "tx" is how a reader ends up looking for a fee that never existed.
  kind: 'chain' | 'intent';
  url: string | null;
  // Filled in by the enricher for EVM hashes, null until then or when the read failed.
  gas: TxGas | null;
  // Whether the fee is still coming. False with a null gas means no chain we can reach
  // knows this hash, which the surface says as "unknown" rather than as "reading".
  gasPending: boolean;
};

export type TxGas = {
  // The chain whose RPC actually returned this receipt, which is the authority on where
  // the hash lives. It overrides the guess classifyHash made from the draft.
  place: TxPlace;
  gasUsed: string; // base units, as a decimal string: a receipt figure, not a rounded one
  gasPriceWei: string;
  feeNative: number;
  feeSymbol: string;
  feeUsd: number | null;
  blockNumber: string | null;
  status: 'success' | 'reverted';
};

export type TxParty = { label: string; address: string; place: TxPlace; url: string | null; self: boolean };

export type TxEntry = {
  id: string; // the proposal id: the same handle the log and proposal_status use
  ts: string; // when it settled, or when it was created if it never did
  action: 'swap' | 'deposit' | 'withdraw' | 'transfer' | 'consolidate' | 'lp add' | 'lp remove';
  kind: WriteDraft['kind'];
  status: 'executed' | 'failed' | 'executing';
  venue: string | null;
  place: TxPlace; // where it started
  toPlace: TxPlace; // where it landed; the same place for a same-chain move
  sent: { symbol: string; amount: number } | null;
  received: { symbol: string; amount: number } | null; // null when the amount out is not recorded
  // For a move whose size is not an amount of a token. Pulling liquidity is a share of a
  // position, and printing "--" there says nothing when the record knows exactly how much.
  note: string | null;
  valueUsd: number;
  from: TxParty | null;
  to: TxParty | null;
  counterparty: TxParty | null;
  decidedBy: 'human' | 'policy' | 'gate_disabled' | null;
  hashes: TxHash[];
  // The venue's own fee, taken from the quote the human approved. Not gas: an intent pays a
  // solver, a swap pays a pool, and neither shows up in a gas figure.
  venueFeeUsd: number | null;
  detail: string; // the rail's own sentence, verbatim
  reasons: string[]; // the policy verdict that let it through
};

const ACTIONS: Record<WriteDraft['kind'], TxEntry['action'] | null> = {
  swap: 'swap',
  hl_deposit: 'deposit',
  intents_deposit: 'deposit',
  intents_withdraw: 'withdraw',
  transfer: 'transfer',
  consolidate: 'consolidate',
  lp_add: 'lp add',
  lp_remove: 'lp remove',
  // Not a transaction. It moves no money and it is already a line in the log.
  policy_change: null,
  // Arming grants standing authority; it moves nothing itself. What the armed bot then does
  // arrives here as its own entries, which is the only honest way to show it: the mandate is
  // the permission, not the spend.
  mandate_arm: null,
};

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_PLACES: TxPlace[] = ['eth', 'base', 'arb'];

// What a recorded id actually IS, which decides whether it gets a link and whether it can
// have a gas figure. Two rails put an intent hash first and chain hashes after it:
//
//   intents-native  txids = [intentHash, ...originTxHashes, ...destinationTxHashes]
//   intents_withdraw same shape
//   everything else  txids = [chain tx, ...chain txs]
//
// An intent hash is not a transaction on any chain. It is the hash of something this app
// signed and a solver settled, so no explorer resolves it and none is offered: a link that
// goes nowhere is worse than a value that does not pretend to be one.
function classifyHash(
  hash: string,
  index: number,
  kind: WriteDraft['kind'],
  venue: string | null,
  place: TxPlace,
  toPlace: TxPlace,
): { place: TxPlace; kind: TxHash['kind'] } {
  if (index === 0 && (kind === 'intents_withdraw' || venue === 'intents-native')) {
    return { place: 'intents', kind: 'intent' };
  }
  if (EVM_HASH.test(hash)) {
    // A hash carries no chain id, so which EVM chain it was mined on is a guess until a
    // receipt is read: the first hash of a move is the one this app broadcast on the origin,
    // and a later one is the solver's payout on the destination. The guess only decides
    // where to LOOK; whichever chain actually answers is what the row ends up saying (see
    // evmCandidates and the place recorded on the receipt).
    const order: TxPlace[] = index === 0 ? [place, toPlace] : [toPlace, place];
    const evm = order.find(p => EVM_PLACES.includes(p));
    return { place: evm ?? 'eth', kind: 'chain' };
  }
  // Base58: one of the two non-EVM chains this move touched, and NEAR when neither side is
  // one, because that is where an intent settles.
  const nonEvm = [toPlace, place].find(p => p === 'sol' || p === 'near');
  return { place: nonEvm ?? 'near', kind: 'chain' };
}

// The venue fee out of the simulation summary the human read. Every rail writes that line
// itself (see the summaries in src/rails/), so this parses our own generated text rather
// than anything an agent supplied, and a summary without the line simply reports no fee.
function venueFeeOf(summary: string | undefined): number | null {
  if (typeof summary !== 'string') return null;
  const match = /\bfee \$([0-9]+(?:\.[0-9]+)?)/.exec(summary);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function party(
  network: Network,
  label: string,
  address: string | undefined,
  place: TxPlace,
  selfAddresses: Set<string>,
): TxParty | null {
  if (typeof address !== 'string' || address.length === 0) return null;
  return {
    label,
    address,
    place,
    url: explorerAddressUrl(network, place, address),
    self: selfAddresses.has(address.toLowerCase()),
  };
}

type Sides = {
  place: TxPlace;
  toPlace: TxPlace;
  venue: string | null;
  sent: { symbol: string; amount: number } | null;
  from: string | undefined;
  to: string | undefined;
  counterparty: string | undefined;
};

// One place that knows what each draft kind means in wallet terms: what left, where from,
// where to. Every field comes off the draft the policy engine governed.
function sidesOf(draft: WriteDraft): Sides {
  switch (draft.kind) {
    case 'swap':
      return {
        place: draft.chain,
        toPlace: draft.toChain,
        venue: draft.venue,
        sent: { symbol: draft.fromSymbol, amount: draft.amountIn },
        from: draft.from,
        to: draft.to,
        counterparty: draft.counterparty,
      };
    case 'hl_deposit':
      return {
        place: draft.chain,
        toPlace: draft.chain,
        venue: 'hyperliquid',
        sent: { symbol: draft.symbol, amount: draft.amount },
        from: draft.from,
        to: draft.bridge,
        counterparty: draft.bridge,
      };
    case 'intents_deposit':
      return {
        place: draft.chain,
        toPlace: 'intents',
        venue: 'intents.near',
        sent: { symbol: draft.symbol, amount: draft.amount },
        from: draft.from,
        to: draft.intentsAccount,
        counterparty: draft.counterparty,
      };
    case 'intents_withdraw':
      return {
        place: 'intents',
        toPlace: draft.chain,
        venue: 'intents.near',
        sent: { symbol: draft.symbol, amount: draft.amount },
        from: draft.from,
        to: draft.to,
        counterparty: draft.counterparty,
      };
    case 'transfer':
      return {
        place: draft.leg.fromChain,
        toPlace: draft.leg.toChain,
        venue: null,
        sent: { symbol: draft.leg.symbol, amount: draft.leg.amount },
        from: draft.leg.from,
        to: draft.leg.to,
        counterparty: undefined,
      };
    case 'consolidate': {
      const first = draft.legs[0];
      return {
        place: first?.fromChain ?? draft.toChain,
        toPlace: draft.toChain,
        venue: null,
        sent: { symbol: draft.symbol, amount: draft.legs.reduce((sum, leg) => sum + leg.amount, 0) },
        from: first?.from,
        to: first?.to,
        counterparty: undefined,
      };
    }
    case 'lp_add':
      return {
        place: draft.chain,
        toPlace: draft.chain,
        venue: draft.venue,
        sent: { symbol: `${draft.token0.symbol}/${draft.token1.symbol}`, amount: draft.token0.amount },
        from: draft.from,
        to: draft.counterparty,
        counterparty: draft.counterparty,
      };
    case 'lp_remove':
      return {
        place: draft.chain,
        toPlace: draft.chain,
        venue: draft.venue,
        sent: null,
        from: draft.from,
        to: draft.counterparty,
        counterparty: draft.counterparty,
      };
    default:
      return { place: 'eth', toPlace: 'eth', venue: null, sent: null, from: undefined, to: undefined, counterparty: undefined };
  }
}

// What arrived, when the rail recorded it. Only read off values the rail itself computed:
// a swap's floor is what was approved, not what filled, and printing the floor as the fill
// would be inventing a number.
function receivedOf(draft: WriteDraft, detail: string): { symbol: string; amount: number } | null {
  if (draft.kind !== 'swap' && draft.kind !== 'intents_withdraw' && draft.kind !== 'intents_deposit') return null;
  const symbol = draft.kind === 'swap' ? draft.toSymbol : draft.symbol;
  // Rail sentences are generated by this repo: "swapped X ETH for 0.1214 SOL", "1.9927 USDC
  // paid out", "0.0032967 ETH now credited". One pattern per rail, anchored on the symbol.
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`for ([0-9]+(?:\\.[0-9]+)?) ${escaped}\\b`),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?) ${escaped} paid out\\b`),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?) ${escaped} now credited\\b`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(detail);
    if (match !== null) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount)) return { symbol, amount };
    }
  }
  return null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function usdOf(draft: WriteDraft): number {
  if (draft.kind === 'policy_change') return 0;
  if (draft.kind === 'consolidate') return draft.totalUsd;
  if (draft.kind === 'transfer') return draft.leg.amountUsd;
  return draft.amountUsd;
}

// Hashes for a proposal: whatever the rail recorded on the proposal, and failing that
// whatever the audit log recorded against the same id.
function hashesFor(p: Proposal, fromLog: Map<string, string[]>): string[] {
  const stored = (p.result as { txids?: unknown } | undefined)?.txids;
  const onProposal = Array.isArray(stored) ? stored.filter((h): h is string => typeof h === 'string') : [];
  const list = onProposal.length > 0 ? onProposal : (fromLog.get(p.id) ?? []);
  return list.filter(h => h.length > 0 && h !== '(no txid)');
}

export function txidsFromLog(events: LogEvent[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const event of events) {
    if (event.type !== 'executed' && event.type !== 'execution_failed') continue;
    const data = event.data as { id?: unknown; txids?: unknown } | undefined;
    if (data === undefined || typeof data.id !== 'string' || !Array.isArray(data.txids)) continue;
    const hashes = data.txids.filter((h): h is string => typeof h === 'string');
    if (hashes.length > 0) out.set(data.id, hashes);
  }
  return out;
}

export type BuildParams = {
  proposals: Proposal[];
  events: LogEvent[];
  network: Network;
  selfAddresses: string[];
  // Hash -> gas, from the enricher. Absent keys read as "not looked up yet", never as "free".
  gas?: Map<string, TxGas>;
  // Hashes the enricher looked for and could not find on any chain it can reach.
  tried?: Set<string>;
};

export function buildTransactions(params: BuildParams): TxEntry[] {
  const { proposals, events, network } = params;
  const fromLog = txidsFromLog(events);
  const selfAddresses = new Set(params.selfAddresses.map(a => a.toLowerCase()));
  const gas = params.gas ?? new Map<string, TxGas>();
  const tried = params.tried ?? new Set<string>();

  const entries: TxEntry[] = [];
  for (const p of proposals) {
    const action = ACTIONS[p.draft.kind];
    if (action === null || action === undefined) continue;
    if (p.status !== 'executed' && p.status !== 'failed' && p.status !== 'executing') continue;

    const sides = sidesOf(p.draft);
    const detail = p.result?.detail ?? '';
    const hashes = hashesFor(p, fromLog).map((hash, index): TxHash => {
      const seen = classifyHash(hash, index, p.draft.kind, sides.venue, sides.place, sides.toPlace);
      // A receipt outranks the guess: if this hash was read off arb, the row says arb and
      // the link goes to arbiscan, whatever the draft implied.
      const receipt = gas.get(hash.toLowerCase()) ?? null;
      const place = receipt !== null ? receipt.place : seen.place;
      return {
        hash,
        place,
        kind: seen.kind,
        url: seen.kind === 'intent' ? null : explorerTxUrl(network, place, hash),
        gas: receipt,
        gasPending: seen.kind === 'chain' && receipt === null && !tried.has(gasKey(hash)),
      };
    });

    entries.push({
      id: p.id,
      ts: p.decidedAt ?? p.createdAt,
      action,
      kind: p.draft.kind,
      status: p.status,
      venue: sides.venue,
      place: sides.place,
      toPlace: sides.toPlace,
      sent: sides.sent,
      received: receivedOf(p.draft, detail),
      note: p.draft.kind === 'lp_remove' ? `${round(p.draft.liquidityPct * 100)}% of the position` : null,
      valueUsd: usdOf(p.draft),
      from: party(network, 'from', sides.from, sides.place, selfAddresses),
      to: party(network, 'to', sides.to, sides.toPlace, selfAddresses),
      counterparty: party(network, 'via', sides.counterparty, sides.place, selfAddresses),
      decidedBy: p.decidedBy ?? null,
      hashes,
      venueFeeUsd: venueFeeOf(p.simulation?.summary),
      detail,
      reasons: p.verdict?.reasons ?? [],
    });
  }

  // Newest first: a history is read from the top.
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return entries;
}

// ---------- gas, read back off the chain ----------

// Keyed by hash alone, not by chain: the whole point of the read is to find out which chain
// the hash is on, so the key cannot assume the answer.
function gasKey(hash: string): string {
  return hash.toLowerCase();
}

export type GasCache = {
  get(hash: string): TxGas | null;
  all(): Map<string, TxGas>;
  // True once this hash has been looked for and not found: no chain we can reach has it.
  // A history that ran on testnet and is now read on mainnet is full of these, and "we
  // looked and cannot see it" is a different sentence from "we have not looked yet".
  tried(hash: string): boolean;
  triedAll(): Set<string>;
  // Reads receipts for anything not cached yet and returns how many landed. Each hash comes
  // with the chains it could plausibly be on, tried in order. Never throws: an RPC that will
  // not answer leaves the fee unknown, which the UI says out loud rather than calling it zero.
  fill(wanted: Array<{ places: TxPlace[]; hash: string }>, priceOf: (symbol: string) => number): Promise<number>;
};

const NATIVE_SYMBOL: Partial<Record<TxPlace, string>> = { eth: 'ETH', base: 'ETH', arb: 'ETH' };
const WEI = 1e18;

// A mined receipt never changes, so the cache is write-once and lives across restarts. It
// holds nothing private: public hashes and the gas they burned.
export function createGasCache(params: { network: Network; dataDir: string }): GasCache {
  const filePath = path.join(params.dataDir, 'tx-gas.json');
  const cache = new Map<string, TxGas>();
  const failed = new Set<string>();

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, TxGas>;
    for (const [key, value] of Object.entries(raw)) cache.set(key, value);
  } catch {
    // no cache yet, or a corrupt one: start empty and rewrite it on the next fill
  }

  function save(): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(cache), null, 2));
    } catch {
      // a cache that cannot be written is a slower app, not a broken one
    }
  }

  // Tries each candidate chain until one has the hash. A chain that does not know a hash
  // answers with an error, which is the negative result this needs, so at most one extra
  // round trip settles which chain a payout actually landed on. Cached forever after.
  async function readOne(places: TxPlace[], hash: string, priceOf: (symbol: string) => number): Promise<boolean> {
    if (!EVM_HASH.test(hash)) return false;
    for (const place of places) {
      const symbol = NATIVE_SYMBOL[place];
      if (symbol === undefined) continue;
      try {
        const receipt = await reader(params.network, place as ChainId).getTransactionReceipt({ hash: hash as `0x${string}` });
        const feeNative = Number(receipt.gasUsed * receipt.effectiveGasPrice) / WEI;
        const price = priceOf(symbol);
        cache.set(gasKey(hash), {
          place,
          gasUsed: receipt.gasUsed.toString(),
          gasPriceWei: receipt.effectiveGasPrice.toString(),
          feeNative,
          feeSymbol: symbol,
          feeUsd: price > 0 ? feeNative * price : null,
          blockNumber: receipt.blockNumber.toString(),
          status: receipt.status === 'success' ? 'success' : 'reverted',
        });
        return true;
      } catch {
        // not on this chain, or this chain would not answer: try the next candidate
      }
    }
    // Remembered as unread for this process so a hash nobody can resolve is not retried on
    // every panel refresh. A restart tries again, which is what makes a temporary RPC
    // outage recoverable without a cache to clear.
    failed.add(gasKey(hash));
    return false;
  }

  return {
    get: (hash) => cache.get(gasKey(hash)) ?? null,
    all: () => new Map(cache),
    tried: (hash) => failed.has(gasKey(hash)),
    triedAll: () => new Set(failed),
    async fill(wanted, priceOf) {
      const todo = wanted.filter(w => {
        const key = gasKey(w.hash);
        return !cache.has(key) && !failed.has(key) && EVM_HASH.test(w.hash);
      });
      if (todo.length === 0) return 0;
      const results = await Promise.all(todo.map(w => readOne(w.places, w.hash, priceOf)));
      const landed = results.filter(Boolean).length;
      if (landed > 0) save();
      return landed;
    },
  };
}

// Which chains a hash could be on, most likely first. Everything EVM this app can reach,
// with the row's own guess in front of it.
export function evmCandidates(first: TxPlace): TxPlace[] {
  return [first, ...EVM_PLACES.filter(p => p !== first)];
}
