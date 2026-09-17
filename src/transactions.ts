// The transaction history: what this app actually did with money, as a list.
//
// It is DERIVED, never a second ledger. The proposal store already holds every write this
// app has made, and the audit log already holds the hashes those writes produced. This
// joins the two and adds the two things a person reading a wallet expects and neither
// source carries: which explorer a hash belongs to, and which side of the trade an address
// is on. Nothing here is authored: every number traces to a proposal or a quote the human
// approved. Gas is not here: every move settles inside a venue, and a solver pays the gas.
//
// Why the audit log for hashes. executeRail logs {id, txids} and stores {ok, detail} on the
// proposal, so the hashes have historically lived in the log alone. They are now written to
// the proposal as well (see proposals.ts), because the log is compactable and a compacted
// log would take the evidence with it. Old records still resolve through the join.

import type { ChainId, DecidedBy, LogEvent, Proposal, RailEvidence, WriteDraft } from './types.ts';
import { chainSpec } from './chain/evm.ts';
import { HYPERLIQUID_EXPLORER_ADDRESS, HYPERLIQUID_EXPLORER_TX } from './explorers.ts';
import { networkChain } from './rails/intents-pay.ts';

// ---------- explorers ----------

// Per chain: where a hash and an address are looked at. The EVM tx prefixes come from
// src/chain/evm.ts so a rail's evidence link and this table can never disagree; only the
// non-EVM chains and the address forms are stated here.
const NON_EVM: Partial<Record<TxPlace, { tx: string; address: string }>> = {
  sol: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
  near: { tx: 'https://nearblocks.io/txns/', address: 'https://nearblocks.io/address/' },
  intents: { tx: 'https://nearblocks.io/txns/', address: 'https://nearblocks.io/address/' },
  // The venue's own explorer, keyed by address. A HyperCore credit has no tx hash of ours.
  // The prefix lives in src/explorers.ts so a fill's link (src/trade/state.ts) and this table
  // can never disagree about where a venue hash is looked at.
  hyperliquid: { tx: HYPERLIQUID_EXPLORER_TX, address: HYPERLIQUID_EXPLORER_ADDRESS },
};

// Two members that are not chains. 'intents' is a balance inside the verifier contract, and
// 'hyperliquid' is a balance on the venue's own books. Both are places money genuinely sits
// and neither is anywhere a block explorer for a chain would find it, which is why calling
// either one by a chain name would send a reader looking in the wrong place.
export type TxPlace = ChainId | 'intents' | 'hyperliquid';

// An EVM explorer's address page is its tx page with one path segment swapped. Deriving it
// keeps one table rather than two that can drift apart.
function evmExplorer(chain: ChainId): { tx: string; address: string } | null {
  try {
    const spec = chainSpec(chain);
    return { tx: spec.explorerTx, address: spec.explorerAddress };
  } catch {
    return null;
  }
}

function explorerFor(place: TxPlace): { tx: string; address: string } | null {
  const nonEvm = NON_EVM[place];
  if (nonEvm !== undefined) return nonEvm;
  return evmExplorer(place as ChainId);
}

export function explorerTxUrl(place: TxPlace, hash: string): string | null {
  const table = explorerFor(place);
  if (table === null || hash.length === 0) return null;
  return table.tx + hash;
}

export function explorerAddressUrl(place: TxPlace, address: string): string | null {
  // A balance inside intents.near is not an account any explorer has a page for: it is a
  // row in the verifier's own state, keyed by an address that belongs to another chain.
  // No link is the honest answer; `npm run intents-balance` is where that is checked.
  if (place === 'intents') return null;
  const table = explorerFor(place);
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
};

export type TxParty = { label: string; address: string; place: TxPlace; url: string | null; self: boolean };

export type TxEntry = {
  id: string; // the proposal id: the same handle the log and proposal_status use
  ts: string; // when it settled, or when it was created if it never did
  action: 'swap' | 'deposit' | 'withdraw' | 'transfer' | 'consolidate' | 'lp add' | 'lp remove' | 'trade' | 'arm';
  // The draft kind, except on the venue: an armed plan and the retired standing mandate both
  // read as 'bot' (a thing that acts on its own once armed), and a close, a cancel or a moved
  // stop keeps 'trade'. Activity filters on these two words (src/http/receipts.ts).
  kind: WriteDraft['kind'] | 'bot';
  // 'needs_reconciliation' is a row the app cannot say moved money or did not. It belongs in
  // the history precisely because of that: dropping it would hide the one transaction a person
  // most needs to look at.
  status: 'executed' | 'failed' | 'executing' | 'needs_reconciliation';
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
  // The read side of the audit history. 'gate_disabled' is a retired value that no code
  // path writes any more; records written before the approval gate became unconditional
  // still carry it and must render rather than throw.
  decidedBy: DecidedBy | 'gate_disabled' | null;
  hashes: TxHash[];
  // The venue's own fee, taken from the quote the human approved. Not gas: an intent pays a
  // solver, a swap pays a pool, and neither shows up in a gas figure.
  venueFeeUsd: number | null;
  detail: string; // the rail's own sentence, verbatim
  reasons: string[]; // the policy verdict that let it through
};

/* Keyed on string, not on WriteDraft['kind'], and the four extra keys are the reason.
   state/proposals.json holds EXECUTED rows naming kinds this app no longer builds: lp_add,
   lp_remove, yield_deposit and yield_withdraw were real rails, and the money they moved was
   real. A history that drops or throws on them would be lying about what happened, so every
   reader that switches on kind stays tolerant of them. They cannot be proposed again; they
   can still be read. */
const ACTIONS: Record<string, TxEntry['action'] | null | undefined> = {
  swap: 'swap',
  hl_deposit: 'deposit',
  hl_withdraw: 'withdraw',
  intents_deposit: 'deposit',
  intents_withdraw: 'withdraw',
  intents_send: 'transfer',
  intents_pay: 'transfer',
  // Retired rails, kept for the rows already on disk.
  transfer: 'transfer',
  consolidate: 'consolidate',
  lp_add: 'lp add',
  lp_remove: 'lp remove',
  // Money leaving the wallet for a lending pool, and coming back from one. Deliberately the
  // same two verbs the Intents rails use: from the reader's side of the screen, "my money
  // went somewhere it is still mine" is one fact, and which contract holds it is a detail
  // the row's counterparty already carries.
  yield_deposit: 'deposit',
  yield_withdraw: 'withdraw',
  // Not a transaction. It moves no money and it is already a line in the log.
  policy_change: null,
  // A trade moves nothing off the venue: margin, position and profit stay inside the trading
  // account. It is still something that happened to the money, so it has a row: an armed
  // plan, a close, a cancel or a moved stop, each with the proposal's own time and the
  // venue's own sentence. Fills are not here, because the proposal never learns them: the
  // runner reads them off the venue and the trade page shows them. The retired mandate kind
  // is kept for the rows already on disk, for the same reason as the pool kinds.
  trade: 'trade',
  mandate_arm: 'arm',
};

// The two words Activity sorts venue rows by. An arm is a bot: from the moment the click
// lands, the runner acts on the plan without asking again. A cancel takes a bot down before
// it acted, so it is a bot too. A close and a moved stop act on a trade.
function venueKindOf(draft: WriteDraft): 'trade' | 'bot' {
  if (draft.kind === 'trade') return draft.op === 'open' || draft.cancel === true ? 'bot' : 'trade';
  return 'bot';
}

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
// signed and a solver settled, so no chain explorer resolves it. The venue's own explorer
// does have a page for the swap, keyed by the deposit address 1Click minted for it (the
// "quote handle" every intents rail writes into its evidence sentence), and that page is
// what an intent hash links to (see intentsSwapUrl). Without a handle there is no link: a
// link that goes nowhere is worse than a value that does not pretend to be one.

// The NEAR Intents explorer's swap page, checked live on 2026-09-14: every row on
// https://explorer.near-intents.org links /transactions/<deposit address> and that page
// renders the deposit, the settlement and the payout for the swap the address was minted
// for. A path with the intent hash instead renders an empty shell, so the hash never goes
// in the url; only the handle does.
export const INTENTS_EXPLORER_TX = 'https://explorer.near-intents.org/transactions/';

// The deposit address, out of the rail's own evidence sentence. Two shapes, both written by
// this repo (src/rails/): "quote handle <address>" from the rails that sign an intent, and
// "deposit <address>, origin tx" from the ones that transfer to the address. Anchored on
// the words on both sides, so a hash, an amount or a failure sentence ("deposit transfer
// failed") can never be read as an address, and bounded to the characters an EVM, NEAR,
// Solana or Bitcoin address can carry. The handle may hold dots inside (a NEAR account)
// but never ends in one: the sentence's own full stop was read into the link on 2026-09-15
// and the explorer answered 404.
const HANDLE_SHAPES = [
  /\bquote handle ([A-Za-z0-9._:-]{7,119}[A-Za-z0-9])(?=[,;.\s]|$)/,
  /\bdeposit ([A-Za-z0-9._:-]{8,120}), origin tx\b/,
];

export function depositHandleOf(detail: string): string | null {
  for (const shape of HANDLE_SHAPES) {
    const match = shape.exec(detail);
    if (match !== null) return match[1];
  }
  return null;
}

export function intentsSwapUrl(handle: string | null): string | null {
  return handle === null ? null : INTENTS_EXPLORER_TX + handle;
}
function classifyHash(
  hash: string,
  index: number,
  kind: WriteDraft['kind'],
  venue: string | null,
  place: TxPlace,
  toPlace: TxPlace,
): { place: TxPlace; kind: TxHash['kind'] } {
  if (index === 0 && (String(kind) === 'intents_withdraw' || kind === 'intents_send' || kind === 'intents_pay' || kind === 'hl_deposit' || venue === 'intents-native')) {
    return { place: 'intents', kind: 'intent' };
  }
  // A hash a trade recorded is the venue's own ledger hash: the venue's explorer resolves
  // it and no chain does, so it never goes looking for an EVM receipt.
  if (place === 'hyperliquid' && toPlace === 'hyperliquid') return { place: 'hyperliquid', kind: 'chain' };
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
    url: explorerAddressUrl(place, address),
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

/* The shape a retired draft has on disk. Not a live type: nothing builds one of these any
   more, and this exists so the kinds the rail table dropped can still be rendered off the
   rows already written. Every field is optional because it is being read back out of JSON
   rather than off a draft the type system saw built. */
type RetiredDraft = {
  kind: string;
  chain?: TxPlace;
  venue?: string;
  symbol?: string;
  amount?: number;
  amountBase?: string | null;
  amountUsd?: number;
  liquidityPct?: number;
  token0?: { symbol: string; amount: number };
  token1?: { symbol: string };
  from?: string;
  to?: string;
  intentsAccount?: string;
  counterparty?: string;
  // The chain-era fund moves (gone 2026-09-16): a consolidation gathered one symbol across
  // legs onto toChain, a transfer was one leg.
  toChain?: TxPlace;
  totalUsd?: number;
  legs?: RetiredLeg[];
  leg?: RetiredLeg;
};

type RetiredLeg = { fromChain?: TxPlace; toChain?: TxPlace; symbol?: string; amount?: number; amountUsd?: number; from?: string; to?: string };

const RETIRED_KINDS = ['lp_add', 'lp_remove', 'yield_deposit', 'yield_withdraw', 'consolidate', 'transfer', 'intents_deposit', 'intents_withdraw'];

/* Historic rows, rendered off what the retired draft actually carries.
   These used to fall through to `default`, which is a quiet way to be wrong: the fallback
   returns place 'eth', so every one of these movements read as having happened on Ethereum
   whatever chain it was actually on, with no venue, no amount and no counterparty. The gas
   figures survived it only by accident, because TxGas.place is the chain whose RPC answered
   and overrides the draft's guess, so the money column was wrong while the fee column beside
   it was right.
   A withdrawal may carry a null amountBase, which is how "the whole position, interest
   included" was expressed: the rebasing receipt grew while the proposal waited, so the rail
   read the balance at execution rather than trusting a number computed a block earlier.
   `amount` still holds what was quoted, so it is the honest thing to show, and a full exit
   says so in `note` rather than printing a figure that was already stale when written. */
function retiredSidesOf(draft: RetiredDraft): Sides {
  // The chain-era fund moves: every field off the legs the row carries, nothing guessed.
  // The chain moves in and out of the verifier (gone 2026-09-16 with the chain wallets).
  if (draft.kind === 'intents_deposit') {
    return {
      place: draft.chain ?? 'eth',
      toPlace: 'intents',
      venue: 'intents.near',
      sent: draft.symbol === undefined || draft.amount === undefined ? null : { symbol: draft.symbol, amount: draft.amount },
      from: draft.from,
      to: draft.intentsAccount,
      counterparty: draft.counterparty,
    };
  }
  if (draft.kind === 'intents_withdraw') {
    return {
      place: 'intents',
      toPlace: draft.chain ?? 'eth',
      venue: 'intents.near',
      sent: draft.symbol === undefined || draft.amount === undefined ? null : { symbol: draft.symbol, amount: draft.amount },
      from: draft.from,
      to: draft.to,
      counterparty: draft.counterparty,
    };
  }
  if (draft.kind === 'transfer') {
    const leg = draft.leg ?? {};
    return {
      place: leg.fromChain ?? 'eth',
      toPlace: leg.toChain ?? leg.fromChain ?? 'eth',
      venue: null,
      sent: leg.symbol === undefined || leg.amount === undefined ? null : { symbol: leg.symbol, amount: leg.amount },
      from: leg.from,
      to: leg.to,
      counterparty: undefined,
    };
  }
  if (draft.kind === 'consolidate') {
    const legs = draft.legs ?? [];
    const first = legs[0];
    const toPlace = draft.toChain ?? 'eth';
    return {
      place: first?.fromChain ?? toPlace,
      toPlace,
      venue: null,
      sent: draft.symbol === undefined ? null : { symbol: draft.symbol, amount: legs.reduce((sum, leg) => sum + (leg.amount ?? 0), 0) },
      from: first?.from,
      to: first?.to,
      counterparty: undefined,
    };
  }
  const place = draft.chain ?? 'eth';
  const base = { place, toPlace: place, venue: draft.venue ?? null, counterparty: draft.counterparty };
  if (draft.kind === 'lp_add') {
    return {
      ...base,
      sent:
        draft.token0 === undefined
          ? null
          : { symbol: `${draft.token0.symbol}/${draft.token1?.symbol ?? '?'}`, amount: draft.token0.amount },
      from: draft.from,
      to: draft.counterparty,
    };
  }
  if (draft.kind === 'lp_remove') {
    return { ...base, sent: null, from: draft.from, to: draft.counterparty };
  }
  const sent =
    draft.symbol === undefined || draft.amount === undefined
      ? null
      : { symbol: draft.symbol, amount: draft.amount };
  if (draft.kind === 'yield_deposit') {
    return { ...base, sent, from: draft.from, to: draft.counterparty };
  }
  // yield_withdraw: money coming back, so from and to swap over.
  return { ...base, sent: draft.amountBase === null ? null : sent, from: draft.counterparty, to: draft.from };
}

// One place that knows what each draft kind means in wallet terms: what left, where from,
// where to. Every field comes off the draft the policy engine governed.
function sidesOf(draft: WriteDraft): Sides {
  if (RETIRED_KINDS.includes(draft.kind)) return retiredSidesOf(draft as unknown as RetiredDraft);
  // A trade and the retired standing mandate both start and end on the venue: nothing leaves
  // the trading account, so there is no sent amount, no from and no to. The stake is valueUsd.
  if (draft.kind === 'trade' || (draft as { kind: string }).kind === 'mandate_arm') {
    return {
      place: 'hyperliquid',
      toPlace: 'hyperliquid',
      venue: 'hyperliquid',
      sent: null,
      from: undefined,
      to: undefined,
      counterparty: (draft as { counterparty?: string }).counterparty,
    };
  }
  switch (draft.kind) {
    case 'swap': {
      // Both legs sit inside the verifier: chain and toChain are the home chains of the two
      // assets, not places the money went. A row the retired 1Click venue wrote did move
      // between chains, and it keeps saying so; the venue is read as the string it is.
      const venue = String(draft.venue);
      const inside = venue === 'intents-native';
      return {
        place: inside ? 'intents' : draft.chain,
        toPlace: inside ? 'intents' : draft.toChain,
        venue,
        sent: { symbol: draft.fromSymbol, amount: draft.amountIn },
        from: draft.from,
        to: draft.to,
        counterparty: draft.counterparty,
      };
    }
    case 'hl_deposit':
      return {
        // The money leaves the intents balance and lands on the venue. Earlier mechanisms
        // started on a chain (Arbitrum for Bridge2, any chain for the 2026-08-20 route); rows
        // executed then still render from their own recorded place.
        place: 'intents',
        toPlace: 'hyperliquid',
        venue: 'hyperliquid',
        sent: { symbol: draft.symbol, amount: draft.amount },
        from: draft.from,
        to: draft.hlAccount,
        counterparty: draft.counterparty,
      };
    case 'hl_withdraw':
      return {
        // Collateral leaves the venue and lands inside the verifier. The first hash is the
        // venue's own ledger hash of the send, which no chain explorer resolves.
        place: 'hyperliquid',
        toPlace: 'intents',
        venue: 'hyperliquid',
        sent: { symbol: draft.symbol, amount: draft.amount },
        from: draft.from,
        to: draft.to,
        counterparty: draft.counterparty,
      };
    case 'intents_send':
      // Both ends inside the verifier: the row moves between two intents accounts.
      return {
        place: 'intents',
        toPlace: 'intents',
        venue: 'intents.near',
        sent: { symbol: draft.symbol, amount: draft.amount },
        from: draft.from,
        to: draft.to,
        counterparty: draft.counterparty,
      };
    case 'intents_pay':
      // Out of the verifier and onto a real chain: the payout hash is on that chain, and the
      // receiver is somebody else's address there.
      return {
        place: 'intents',
        toPlace: networkChain(draft.network) ?? 'eth',
        venue: 'intents.near',
        sent: { symbol: draft.symbol, amount: draft.amount },
        from: draft.from,
        to: draft.to,
        counterparty: draft.counterparty,
      };
    default:
      return { place: 'eth', toPlace: 'eth', venue: null, sent: null, from: undefined, to: undefined, counterparty: undefined };
  }
}

/* The one row detail a retired kind still needs. An lp_remove pulled a percentage of a
   position rather than an amount, so without this its history row shows no size at all. */
function noteOf(draft: WriteDraft): string | null {
  const retired = draft as unknown as RetiredDraft;
  if (retired.kind !== 'lp_remove') return null;
  return retired.liquidityPct === undefined ? null : `${round(retired.liquidityPct * 100)}% of the position`;
}

// What arrived, when the rail recorded it. Only read off values the rail itself computed:
// a swap's floor is what was approved, not what filled, and printing the floor as the fill
// would be inventing a number. The venue's own settled figure, when the rail kept it, comes
// first; the sentence is read only for rows from before that field existed, and never a
// figure the sentence calls quoted, because a quote is a promise and not an arrival.
function receivedOf(draft: WriteDraft, detail: string, evidence: RailEvidence | undefined): { symbol: string; amount: number } | null {
  const kind = String(draft.kind);
  if (kind !== 'swap' && kind !== 'intents_withdraw' && kind !== 'intents_deposit' && kind !== 'intents_pay') return null;
  const symbol = draft.kind === 'swap' ? draft.toSymbol : ((draft as unknown as RetiredDraft).symbol ?? '');
  const settled = Number(evidence?.settledAmountOut);
  if (typeof evidence?.settledAmountOut === 'string' && Number.isFinite(settled)) return { symbol, amount: settled };
  // Rail sentences are generated by this repo: "swapped X ETH for 0.1214 SOL", "1.9927 USDC
  // paid out", "0.0032967 ETH now credited". One pattern per rail, anchored on the symbol.
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`for ([0-9]+(?:\\.[0-9]+)?) ${escaped}\\b`),
    new RegExp(`(?<!quoted )([0-9]+(?:\\.[0-9]+)?) ${escaped} paid out\\b`),
    new RegExp(`(?<!quoted )([0-9]+(?:\\.[0-9]+)?) ${escaped} now credited\\b`),
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
  if (RETIRED_KINDS.includes(draft.kind)) {
    const retired = draft as unknown as RetiredDraft;
    return retired.totalUsd ?? retired.leg?.amountUsd ?? retired.amountUsd ?? 0;
  }
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
  selfAddresses: string[];
};

export function buildTransactions(params: BuildParams): TxEntry[] {
  const { proposals, events } = params;
  const fromLog = txidsFromLog(events);
  const selfAddresses = new Set(params.selfAddresses.map(a => a.toLowerCase()));

  const entries: TxEntry[] = [];
  for (const p of proposals) {
    const action = ACTIONS[p.draft.kind];
    if (action === null || action === undefined) continue;
    if (p.status !== 'executed' && p.status !== 'failed' && p.status !== 'executing' && p.status !== 'needs_reconciliation') continue;

    const sides = sidesOf(p.draft);
    const detail = p.result?.detail ?? '';
    const swapPage = intentsSwapUrl(depositHandleOf(detail));
    const hashes = hashesFor(p, fromLog).map((hash, index): TxHash => {
      const seen = classifyHash(hash, index, p.draft.kind, sides.venue, sides.place, sides.toPlace);
      return {
        hash,
        place: seen.place,
        kind: seen.kind,
        url: seen.kind === 'intent' ? swapPage : explorerTxUrl(seen.place, hash),
      };
    });

    entries.push({
      id: p.id,
      // When the rail returned, if that was recorded; the decision can be a minute earlier.
      ts: p.settledAt ?? p.decidedAt ?? p.createdAt,
      action,
      kind: action === 'trade' || action === 'arm' ? venueKindOf(p.draft) : p.draft.kind,
      status: p.status,
      venue: sides.venue,
      place: sides.place,
      toPlace: sides.toPlace,
      sent: sides.sent,
      received: receivedOf(p.draft, detail, p.result?.evidence),
      // Historic only: lp_remove is a retired kind, and this line is why its rows still read
      // correctly. See RETIRED_KINDS above.
      note: noteOf(p.draft),
      valueUsd: usdOf(p.draft),
      from: party('from', sides.from, sides.place, selfAddresses),
      to: party('to', sides.to, sides.toPlace, selfAddresses),
      counterparty: party('via', sides.counterparty, sides.place, selfAddresses),
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
