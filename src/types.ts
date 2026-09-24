// Shared type contract for agent-crypto-control.
// Erasable TypeScript only: this repo runs on Node 24 type stripping with no build step.
// No enums, no namespaces, no parameter properties. Relative imports use explicit .ts extensions.

import type { PocketRead } from './ledger/settle.ts';
import type { Plan } from './trade/plan.ts';
import type { PlanRisk } from './trade/risk.ts';
import type { AddressActivity } from './chainscan/index.ts';
import type { ProposalView } from './proposals/view.ts';
import type { SwapAssetsParams, SwapAssetsReply, SwapCheckReply, SwapQuoteParams, SwapQuoteReply } from './proposals/swap-reads.ts';
// Re-exported so every caller reads the one object from the one contract without importing
// two files to describe one row.
export type { ProposalStage, ProposalView, TxLeg } from './proposals/view.ts';
export type { SwapAssetsParams, SwapAssetsReply, SwapCheckReply, SwapQuoteParams, SwapQuoteReply } from './proposals/swap-reads.ts';

export type ChainId = 'eth' | 'base' | 'arb' | 'sol' | 'near';
export type Mode = 'demo' | 'live';

// Which of the two screens the app window is showing. 'pro' is the operator deck;
// 'basic' is the plain-English screen written for someone non-technical.
//
// Persisted, because basic exists for a person who owns the money and is not
// technical: an app restart that dumped them back into pro would be an escape hatch
// Karim deliberately declined when he asked for agent-only switching. Every failure
// to read the stored value falls back to 'pro', because pro shows more and a corrupt
// file must never silently simplify what a human sees.
// Which of the three windows the app is showing. 'trade' arrived last and is a different
// KIND of member from the other two: basic and pro are two renderings of the same treasury
// screen, while trade is a separate page (/trade) with its own feed. It lives in the same
// union anyway, because from the outside all three answer one question, "where is the human
// looking", and one union is what lets one tool move between them.
export type ViewMode = 'basic' | 'pro' | 'trade' | 'vault';

// Who last put the window on its screen: the person clicking a tab, or an agent calling
// `switch`. The two can disagree about where the window is only when one of them is not
// recorded, and until 2026-09-14 the human's clicks were not.
export type ScreenBy = 'human' | 'agent';

// The screen the window is on, as the server knows it: what the state frame, `start`, `switch`
// and the line under every tool result all report. `since` is when it was put there.
export type Screen = { view: ViewMode; since: string; by: ScreenBy };

// ---------- Ledger ----------

/* What a refresh leaves behind beside the two pocket reads (src/ledger/index.ts: the verifier
   through intents(), the trading account through hyperliquid()). Nothing is held on a chain, so
   there is no holding here and no chain to mark stale: the pocket reads carry their own ok
   flags and stamps, and this carries the prices they are valued at and when the pass began. */
export type LedgerSnapshot = {
  mode: Mode;
  /* When the reads that built this snapshot started, once per refresh. src/view/basic.ts holds
     it against the newest executed proposal to decide whether the total on screen already
     counts the last fill, and src/proposals/execute.ts waits for a read stamped later than a
     settlement before it prints the balance after a move. */
  fetchedAt: string;
  prices: Record<string, number>; // native symbol -> usd used for pricing
  /* When each of those prices was fetched, in epoch ms. Present on a live snapshot and absent on
     a demo or fixture one, and the difference is real: a live price is a reading off one endpoint
     that can fail, and the old loader then reused the last known value forever with no way for
     anything downstream to know how old it was. Every budget in the policy engine is measured
     against a number derived from these, so an unknown age has to be refusable. A snapshot with
     no map at all carries a static table rather than a reading, and there is no fetch time to be
     old. See PRICE_STALENESS_MS in src/proposals/draft.ts for the bound. */
  priceAsOf?: Record<string, number>;
};

// ---------- Composition ----------

export type RiskRow = {
  symbol: string;
  issuer: string;
  freezable: boolean;
  freezeMechanism: string;
  reserveType: 'treasuries-cash' | 'mixed' | 'crypto-collateralized' | 'synthetic-hedged' | 'unknown';
  depegWorstUsd: number;
  depegNote: string;
  sourceUrl: string;
};

export type CompositionRow = {
  issuer: string; // 'unclassified' when the symbol has no risk table row
  symbol: string;
  chain: WalletPlace; // the pocket the balance sits in: 'intents' or 'hyperliquid'
  amount: number;
  usd: number;
  share: number; // 0..1 of total stable usd
  freezable: boolean; // unclassified assets count as freezable (fail pessimistic)
  classified: boolean;
};

export type CompositionView = {
  rows: CompositionRow[]; // sorted by share descending
  totalUsd: number; // issued coins only; ETH, SOL, NEAR and BTC have no issuer and are excluded
  byIssuer: Record<string, number>; // issuer -> share 0..1
  freezableShare: number;
  unclassified: string[]; // symbols with no risk row
};

// ---------- Wallet ----------
// What the composition panel renders: everything held, the way a normal wallet shows it.
// CompositionView above does NOT go away; it stops being the UI's source and stays the
// policy engine's input (byIssuer, freezableShare are what the composition rules read).

// Where a wallet row sits. A balance inside the intents.near verifier is on no chain: it is
// an entry on that contract's own ledger, and calling it 'near' would tell a reader to look
// for it on NEAR where nothing will be found. The chain ids stay in the union for the rows
// older builds wrote and the receipts that still name them.
export type WalletPlace = ChainId | 'intents' | 'hyperliquid';

export type WalletRow = {
  kind: 'intents' | 'hyperliquid';
  chain: WalletPlace;
  symbol: string; // 'USDC' or 'ETH'
  tokenId: string;
  quantity: number;
  priceUsd: number; // 1.0 for stables, spot for natives
  valueUsd: number;
  // Where priceUsd came from when it is 1Click's listed price, the source of last resort; absent
  // for the spot table and the stablecoin list.
  priceSource?: '1click';
  /* False when this app could not price the asset at all, so valueUsd is a hole rather than a
     figure. Absent means priced, because every other rail derives its value from a number it
     already holds. It exists because "$0.00" and "we do not know" printed identically, and the
     first one reads as "you own nothing" against a balance somebody does own. */
  priced?: boolean;
  share: number; // 0..1 of wallet total
  native: boolean;
  // Set on an intents row: the verifier's asset id and the account it credits, so a row
  // can be reconciled against `npm run intents-balance` without guessing.
  intents?: { accountId: string; assetId: string };
  // Set on the hyperliquid row: what the venue said about the account, so a reader can tell
  // free collateral from margin under a position without a second tool.
  hyperliquid?: { account: string; availableUsdc: number; marginUsedUsd: number; openPositions: number; unified: boolean };
};

export type WalletView = {
  rows: WalletRow[]; // value descending; only things actually held
  totalUsd: number; // everything: the intents balances and the trading account
  byChain: Record<string, number>; // place -> usd
  stale: WalletPlace[]; // places whose reads have failed; never silently zero
  // Why each stale place is stale, in the reader's words, where the read said.
  staleWhy?: Partial<Record<WalletPlace, string>>;
  // How many pockets came back with nothing in them. The rows are gone from the list (a
  // wallet lists what you hold), but the number stays: "we looked and it was empty" and "we
  // did not look" are different facts.
  emptyCount: number;
  // Priced balances that round to $0.00, kept out of the rows but inside totalUsd and byChain.
  // The count and the sum let a card say "1 tiny balance, not listed" instead of hiding money.
  dustCount: number;
  dustUsd: number;
  // The symbols held that the app has no price for, in row order. totalUsd leaves them out,
  // so a head or a total that prints the number alone over one of these reads as "you have
  // nothing" (Karim, 2026-09-20: $0.00 over 2.0097 wNEAR). A card names them instead.
  unpriced: string[];
  // The trading account, when it was read: funded or not. Unfunded is where a new account
  // starts, so it is never counted as an empty holding.
  hyperliquid?: { funded: boolean };
};

// ---------- Policy ----------

export type Policy = {
  version: number;
  killSwitch: boolean; // human-only; not reachable by any patch
  outbound: {
    maxPerTransactionUsd: number;
    maxPerSessionUsd: number; // rolling 24h sum of executed fund-moving proposals
    humanClickAboveUsd: number; // above this, allow becomes needs_approval
    // A rolling 24h ceiling on AUTO-APPROVED spend alone: past it the next sub-threshold move
    // waits for a click, so a stream of small auto moves cannot run unattended up to the whole
    // session cap. Optional so a policy file predating it still parses; loadPolicy fills it with
    // five times the click threshold, which is also the fresh default.
    autoApproveDailyUsd?: number;
    destinationAllowlist: string[]; // lowercased; self addresses are implicitly allowed
    simulateBeforeSign: true; // constant in v1, shown in UI
  };
  composition: {
    maxIssuerShare: Record<string, number>; // key 'default' is the catch-all, 0..1
    maxFreezableShare: number; // 0..1
    forbiddenIssuers: string[];
  };
  sentences: string[]; // plain-English rules as authored; UI renders these, never JSON
};

export type PolicyPatch = {
  outbound?: Partial<Omit<Policy['outbound'], 'simulateBeforeSign'>>;
  composition?: Partial<Policy['composition']>;
};

/* What the engine decided, why in words, and why in codes.
   `reasonCodes` is the machine-readable half of `reasons`: a refusal carries its rule, and a
   needs_approval verdict carries any adjustment the engine made on the way through (today only
   `threshold_clamped_to_cap`). It is optional because rows already on disk were written without
   it and because nothing outside the engine mints a verdict with codes; the engine always sets
   it, so a reader takes `verdict.reasonCodes ?? []` and never has to read the prose. */
/* What a policy change moves, per money axis, so the card can print before and after for each
   one instead of a sentence somebody has to take on trust. `factor` is how far the number went,
   which is the one thing two figures do not show at a glance; null where the old value was zero.
   Only on a policy_change verdict, and only for the axes that actually moved. */
export type PolicyAxisChange = { axis: string; before: number; after: number; factor: number | null };

export type Verdict =
  | { outcome: 'allow'; reasons: string[]; reasonCodes?: string[] }
  | { outcome: 'needs_approval'; reasons: string[]; reasonCodes?: string[]; changes?: PolicyAxisChange[] }
  | { outcome: 'refuse'; reasons: string[]; rule: string; reasonCodes?: string[] };

// ---------- Writes ----------

// The venue's own figures for a quoted leg. A swap draft carries the slot and every builder
// leaves it null: the quote is taken at simulate time and lives on the simulation.
export type LegQuote = {
  amountOut: number;
  feeUsd: number;
  timeEstimateSec: number;
  raw?: unknown;
};

// The three features Karim asked for, each one draft kind. Every draft carries amountUsd
// because that is what the policy engine's budget rules read; a rail that cannot price
// itself in USD cannot be governed, so the field is required rather than optional.

export type SwapDraft = {
  kind: 'swap';
  // A swap signs an intent over a balance already held inside the intents.near verifier and
  // transfers nothing on any chain. 'intents-relay' signs one atomic token_diff through the
  // solver relay (docs/superpowers/specs/2026-09-20-swap-relay-design.md); 'intents-native'
  // is the 1Click transfer it replaces, kept behind `swap.rail` until the relay has settled
  // real money. 'oneclick' (wallet funds to a per-quote deposit address) and 'uniswap-v3' are
  // retired: state/proposals.json holds executed rows naming them, and the history readers
  // take the venue as a string, so nothing has to type those rows.
  venue: 'intents-native' | 'intents-relay';
  // The home chains of the two ASSETS, which is how the 1Click token list names an asset
  // ("USDC from eth" and "USDC from arb" are two ids). Neither is a place money moves to or
  // from: both legs sit inside NEAR Intents, and every card says so. Any spend network id
  // (src/rails/intents-address.ts), not only the five pinned chains.
  chain: string;
  toChain: string;
  fromSymbol: string;
  toSymbol: string;
  // For display and pricing. The rails sign amountInExact when it is present, never this.
  amountIn: number;
  /* The amount approved, as an exact decimal in fromSymbol units, cut to the coin's own
     decimals when the draft was built. A double holds about 16 significant digits and a
     24-decimal balance needs 24, so "all of it" as a number could sign more than was held
     (2026-09-23). Absent on rows written before it existed. */
  amountInExact?: string;
  amountUsd: number;
  minAmountOut: number; // slippage floor; execution must revert rather than fill below this
  from: string;
  to: string;
  counterparty: string; // the contract funds are handed to; must be on the policy allowlist
  quote: LegQuote | null;
};

// Collateral entering a Hyperliquid perps account. The kind is older than the mechanism: it
// meant an ERC-20 transfer to Hyperliquid's Bridge2 contract, then a NEAR Intents route from a
// wallet on any chain, and since 2026-09-11 it means the intents balance itself, spent through
// one signed intent. The kind stayed each time because what it MEANS to the policy engine, the
// ledger and the approval screen did not change: money is entering the trading account.
//
// There is no chain on this draft any more. The money starts inside the verifier, so the only
// origin fact is which bridged flavor of the asset is spent (`originAsset`), and the proposal
// service picks that from what the ledger says is held. `hlAccount` is the account credited,
// which the policy engine checks is one we hold the key for.
export type HlDepositDraft = {
  kind: 'hl_deposit';
  symbol: string; // the asset spent from the intents balance; USDC unless the caller says otherwise
  originAsset: string; // its 1Click id, the flavor actually held inside the verifier
  amount: number; // in `symbol`
  amountUsd: number;
  minCredited: number; // the least the trading account may be credited, in USDC
  from: string; // our account id inside intents.near: the EVM address, lowercased
  hlAccount: string; // the Hyperliquid account credited: an EVM address we hold the key for
  counterparty: string; // must be on the policy allowlist
};

// Collateral leaving a Hyperliquid perps account and landing back in the intents balance. The
// mirror of HlDepositDraft, and the only draft whose signature is a Hyperliquid user-signed
// action rather than a chain transaction or an intent: one spotSend from the venue account to
// an address 1Click mints for the quote. `to` is our own account inside intents.near and is
// never a caller's; a draft naming anything else is refused by the rail and by the engine.
// What the app knows about the receiver of a send at propose time, so the card can say "First
// send to this address" or "Sent here 3 times" and the simulation can say whether the address
// has ever been used. `known`, `count` and `lastAt` come from the recipients book
// (src/recipients.ts, written on approval); `activity` is the public chain read at propose time
// and null when it could not be made; `ownAddress` is the app's own EVM address on that chain.
export type SendRecipient = {
  known: boolean;
  count: number;
  lastAt: string | null;
  activity: AddressActivity | null;
  ownAddress: boolean;
  // The agent's own words about the receiver, one bounded line. Written to the recipients
  // book as the row's label on approval and never drawn on the card.
  note?: string;
};

// A balance inside intents.near moving to ANOTHER account inside the same verifier: the one of
// the two send drafts whose money never touches a chain. Since 2026-09-17 the receiver is not
// allowlisted: the gate is the card and the Touch ID sentence that name the account, and the
// send always waits for a click; see the header of src/rails/intents-send.ts.
export type IntentsSendDraft = {
  kind: 'intents_send';
  symbol: string;
  originAsset: string; // the 1Click asset id of the flavor held; the same asset arrives
  amount: number;
  amountUsd: number;
  minReceived: number; // the least that may be credited to the receiver
  from: string; // our account id inside intents.near: the EVM address, lowercased
  to: string; // the receiver's intents account id, as the verifier keys it
  counterparty: string; // must be on the policy allowlist
  recipient?: SendRecipient; // absent on rows written before the recipients book existed
};

// A balance inside intents.near paid out to an address on a real chain: a friend's wallet on
// Ethereum, a Solana account, our own wallet on Base. The one draft whose money leaves the
// verifier for an address this app may hold no key for, so the address is decoded rather than
// matched, the chain is named, the payout is always a click and a Touch ID that names the
// receiver, and the quote echo binds the recipient before anything is signed. See the header
// of src/rails/intents-pay.ts.
export type IntentsPayDraft = {
  kind: 'intents_pay';
  symbol: string;
  originAsset: string; // the 1Click asset id of the flavor held inside the verifier
  /* The real chain the payout lands on, as the one registry ids a chain (src/rails/
     intents-address.ts). Wider than ChainNetwork, which is the six chains this app can also READ
     an address on: a payout needs an address it can decode, and it can decode more chains than
     it can read. */
  network: string;
  amount: number;
  amountUsd: number;
  minReceived: number; // the least that may arrive on the chain, in `symbol`
  from: string; // our account id inside intents.near: the EVM address, lowercased
  to: string; // the receiver's address as the chain spells it (EIP-55 on an EVM chain)
  toChecksum: 'valid' | 'lowercase' | null; // whether the caller's spelling carried a checksum (EVM only)
  counterparty: string; // must be on the policy allowlist
  recipient: SendRecipient;
};

export type HlWithdrawDraft = {
  kind: 'hl_withdraw';
  symbol: 'USDC'; // the only asset HyperCore holds as collateral
  amount: number; // USDC leaving the venue account
  amountUsd: number;
  minReceived: number; // the least that may land inside the verifier, in USDC
  from: string; // the Hyperliquid account: our EVM address, the one that signs
  to: string; // our account id inside intents.near: the same address, lowercased
  counterparty: string; // must be on the policy allowlist
};

// A trade. One plan, whole, plus its sha256: what the human clicks is what runs. It rides the
// draft path like every other write, which buys the audit log, the policy engine and the
// approval card for free. amountUsd is what the plan actually puts at stake, max(margin, max
// loss), because every position opens isolated and the margin posted is the most the venue can
// take for it. A change that only takes risk off (a cancel, a tighter stop) is amountUsd 0 and
// lands without the engine; one that widens is priced like a new plan.
//
// Note what is absent, matching every other rail: no address, no recipient, no contract. A plan
// has no field that moves value off the venue.
export type TradeDraft =
  | {
      kind: 'trade';
      op: 'open';
      plan: Plan;
      hash: string;
      risk: PlanRisk;
      amountUsd: number;
      counterparty: string; // the venue itself: a perp order moves nothing to a new address
    }
  | {
      kind: 'trade';
      op: 'change';
      id: string;
      stop?: number;
      target?: number;
      cancel?: true;
      close?: true;
      before: PlanRisk;
      after: PlanRisk;
      amountUsd: number;
      counterparty: string;
    };

export type WriteDraft =
  | { kind: 'policy_change'; patch: PolicyPatch; sentence: string }
  | SwapDraft
  | HlDepositDraft
  | HlWithdrawDraft
  | IntentsSendDraft
  | IntentsPayDraft
  | TradeDraft;

// One rail per feature, each owning exactly one module under src/rails/. The dispatch
// table in proposals.ts is the only place that knows they all exist, which is what lets
// a rail be added without touching the engine.
// What a rail knows beyond the hash: the 1Click handle it spent through, the venue nonce it
// used, the deadline it signed, and what the venue reported as settled or refunded. Every
// field is a fact the rail read, never a figure taken from a quote.
export type RailEvidence = {
  handle?: string;
  nonce?: string;
  deadline?: string;
  refundedAmount?: string;
  refundReason?: string;
  settledAmountOut?: string;
  explorerUrl?: string;
  /* 1Click's own word for where the order is, byte for byte off GetExecutionStatusResponse
     (PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED,
     FAILED). Written on every poll so the stage a person reads is the stage the vendor would
     confirm, rather than a word only this app uses. */
  providerStage?: string;
  // The 1Click quote the move paid into, as 1Click signed it: verified before the deposit address
  // was used (src/quote-signature.ts) and kept so a dispute is filed with the vendor's own
  // commitment rather than this app's memory of it.
  quote?: { correlationId: string; timestamp: string; signature: string; depositAddress: string };
  // The relay quote a swap was signed against (src/rails/intents-relay.ts): the hash the
  // publish named and the two amounts the signed diff carries, written before the publish so a
  // process that dies after the signature still says what price it signed.
  relayQuote?: { quoteHash: string; amountIn: string; amountOut: string; expiration: string };
};

export type RailResult = {
  ok: boolean;
  detail: string;
  // Why it ended the way it did, as one code from src/rails/reasons.ts. The view turns it into
  // the sentence a person reads; `detail` stays the engineer's line.
  reason?: string;
  txids?: string[];
  evidence?: RailEvidence;
  // The venue confirmed the move and the balance has not shown it inside the rail's window.
  // Neither executed nor failed: the proposal lands as needs_reconciliation and the next
  // balance read that shows the rise settles it (src/proposals/execute.ts).
  settling?: boolean;
  // The balance the rail read either side of the move, for the receipt and for that re-check.
  pocket?: PocketRead;
  // The preflight said hold and nothing was signed. The executor keeps the row approved and
  // runs the rail again in a while; `detail` is the hold reason (src/proposals/execute.ts).
  held?: boolean;
  // What the preflight found on this run, held or not, for the row and the receipt.
  preflight?: Preflight;
};

// Called by a rail the moment something irreversible exists: a signature released, a
// transaction broadcast, an intent submitted. The executor persists it before the rail's
// watch loop, so a process that dies inside the wait still has the hash on the row. A rail
// that read the pocket before the move hands it over here too, so a row recovered from a
// crash is settled by the balance the way a live one is, never by a vendor's word alone.
// `onPreflight` is told the moment the checks have run and before anything is signed, so
// the row carries what was read even if the rail dies in the wait that follows.
export type RailHooks = {
  onEvidence?: (evidence: { txids?: string[]; pocket?: PocketRead } & RailEvidence) => void;
  onPreflight?: (preflight: Preflight) => void;
};

// ---------- preflight ----------
// What the app reads for itself a moment before a 1Click intent is signed (src/preflight/):
// the chain the payout lands on, the fee against the payout's cost, the venue, the balance and
// the quote's deadline. A `hold` signs nothing and is retried by the executor; a `fail` signs
// nothing and stops. The card and the receipt draw the checks as a folded rail
// (ui/screens/checks.js), never as text.
export type PreflightCheckId = 'gas' | 'coverage' | 'venue' | 'balance' | 'deadline';

export type PreflightCheck = {
  id: PreflightCheckId;
  label: string; // plain English: "Arbitrum gas", "Fee covers the payout"
  state: 'ok' | 'warn' | 'fail';
  value: string; // the number, as the receipt prints it: "145,392 / 300,000", "2.3x"
  detail: string; // one sentence under it
  series?: number[]; // the hour of readings behind the gas check, oldest first
  limit?: number; // the line the sparkline dashes: the vendor's gas limit, when there is one
};

export type Preflight = {
  at: string; // ISO, when the checks ran
  checks: PreflightCheck[];
  verdict: 'ok' | 'hold' | 'fail';
  holdReason?: string; // the sentence the card shows while held or once failed
};

export type Rail<D extends WriteDraft = WriteDraft> = {
  kind: D['kind'];
  // The rail's own view of what the draft moves, in USD.
  //
  // NOT what the policy engine reads. evaluateRail governs on draft.amountUsd, which the
  // proposal service sets when it builds the draft (priced from the risk table, then
  // holdings, then spot, and never from anything the agent supplied). This comment used to
  // claim the engine called this method; it does not, and a type comment that misstates
  // where a safety number comes from is worth correcting even when both values agree.
  //
  // Kept because a rail is the thing that actually knows its own sizing, and the two
  // agreeing is a property worth being able to assert rather than assume.
  valueUsd(draft: D): number;
  // Dry run. Must not sign or broadcast anything.
  simulate(draft: D): Promise<SimulationResult>;
  /* A price with no floor in the question, for a swap rail only: what the venue would give for
     the draft's amountIn right now, in the bought coin's units, or null when nobody offers a
     price. The app sets a draft's floor under this when the agent names none (frozen rule 2:
     the floor comes off the quote, never off a guess). Must not sign or broadcast anything. */
  quote?(draft: D): Promise<number | null>;
  /* For a swap rail only: which asset the draft spends and how much of it the verifier holds
     for us right now, in base units (null when the read failed, never zero for unread). What
     turns "all" into an exact amount and refuses one larger than the balance. Signs nothing. */
  spend?(draft: D): Promise<SwapSpend>;
  /* For a swap rail only: a dry quote as fields, for a read that files nothing. Signs nothing. */
  facts?(draft: D): Promise<SwapQuoteFacts>;
  // Runs only after the proposal is approved, or auto-approved with the gate off. The proposal
  // id rides along so a rail that keeps its own registry (the trade rail) can record which
  // approval a row came from.
  execute(draft: D, proposalId?: string, hooks?: RailHooks): Promise<RailResult>;
};

export type SimulationResult = {
  // For legs whose funds go to an address the VENUE chose rather than one we picked.
  // 1Click mints a fresh deposit address per quote, so it can never be on an allowlist,
  // and the policy engine's destination rule checks leg.to instead. That left the control
  // pointed at a different value than the one actually sent to. Recording the addresses
  // here at propose time gives the human something concrete to approve and gives execution
  // something to compare against. Absent when no leg has one.
  depositAddresses?: Array<{ leg: string; address: string }>;
  ok: boolean;
  summary: string; // human-readable, rendered in the approval gate
  /* The engineer's lines behind the summary: base units, the solver's own floor, what is signed.
     Kept on the row for the log and a developer; the propose reply the agent reads leaves it out
     (src/http/propose.ts), so the agent says the summary and never these. */
  developer?: string;
  postComposition?: CompositionView; // fund moves: composition after the move
  policyDiff?: { before: string[]; after: string[] }; // policy changes: sentences before/after
  send?: SendSimulation; // the two send rails: the facts the send card draws
  swap?: SwapSimulation; // the swap rail: the facts the decision card draws
  error?: string;
  // Why it did not pass, as one code from src/rails/reasons.ts, when the rail knows.
  reason?: string;
};

// The asset a swap draft spends, resolved, and what the verifier holds of it for us.
export type SwapSpend = { assetId: string; decimals: number; heldBase: bigint | null };

/* One dry quote as fields: the exact amount it prices, what it says arrives, the floor the app
   would set under it, the fee and the time. Amounts are exact decimals in the coin's units. */
export type SwapQuoteFacts = {
  amountIn: string;
  expectedOut: string;
  minOut: string;
  feeUsd: number | null;
  etaSeconds: number | null;
};

// What a swap simulation learned from the dry quote, as fields rather than as a sentence, so the
// decision card (ui/screens/decision.js) draws the same numbers the rail checked instead of
// reading them out of the summary. Amounts are formatted in `toSymbol` units the way the quote
// formats them.
export type SwapSimulation = {
  receives: string; // the quote's amountOut
  receivesAtLeast: string; // the quote's minAmountOut, the floor the rail will hold the live quote to
  feeUsd: number | null; // amountInUsd minus amountOutUsd, when the quote priced both
  etaSeconds: number | null;
  /* How long the price on the card stays good, in seconds, on a rail that quotes again at the
     click (the relay: a quote lives about a minute, and the swap is re-priced after a human
     approves; the floor is the contract, the number on the card is the estimate). Null where
     the quote is held to the click. The card prints it as one line, never as a number to sum. */
  priceGoodForSec?: number | null;
};

// What a send simulation learned from the dry quote and the chain, as fields rather than as a
// sentence, so the send card (ui/screens/sendcard.js) and the Basic view draw the same numbers
// the rail checked. Every string is formatted in `symbol` units the way the quote formats them.
export type SendSimulation = {
  destinationAsset: string; // the 1Click id the receiver is paid in
  arrives: string; // the quote's amountOut
  arrivesAtLeast: string; // the quote's minAmountOut, the floor the rail will hold the live quote to
  feeUsd: number | null; // amountInUsd minus amountOutUsd, when the quote priced both
  bridgeFee: string | null; // the flat withdrawFee inside `arrives`, chain payouts only
  etaSeconds: number | null;
  activity: string; // the receiver sentence: what the chain or the verifier says about the address
  explorer: string | null; // the receiver's page on the chain's explorer, chain payouts only
};

export type ProposalStatus =
  | 'pending'
  // Authored and policy-checked while the wallet was locked, and waiting for the unlock that
  // makes signing possible. Never refused: refusing throws away the agent's work and teaches
  // people to turn the lock off. See decision 6 in the v1 spec.
  | 'pending_unlock'
  // A human clicked approve on an enclave wallet and the Touch ID dialog that names the move is
  // up. Leaves for `approved` when the enclave answers, or back to `pending` when the person
  // cancels or nobody answers. See src/proposals/lifecycle.ts, approve.
  | 'awaiting_touch'
  | 'approved'
  | 'refused'
  | 'executing'
  // What a proposal becomes when the process died between "executing" and the rail's answer.
  // Neither executed nor failed, and the difference matters: money may have left the wallet.
  // Excluded from the 24h spend cap, and cleared only by POST /api/reconcile asking the chain.
  | 'needs_reconciliation'
  | 'executed'
  | 'failed'
  | 'policy_refused';

// Who decided a proposal. There are exactly two answers and no third: a person clicked,
// or the policy engine allowed it inside limits a person wrote. Nothing else may decide.
export type DecidedBy = 'human' | 'policy';

export type Proposal = {
  id: string;
  kind: WriteDraft['kind'];
  createdAt: string;
  status: ProposalStatus;
  draft: WriteDraft;
  simulation: SimulationResult | null;
  verdict: Verdict;
  // Only a human click or a policy 'allow' decides a proposal. There is no third answer.
  // Records written before the approval gate became unconditional may carry a retired
  // value on disk; src/transactions.ts widens the type on the read side to render them.
  decidedBy?: DecidedBy;
  decidedAt?: string;
  // txids are the evidence: the hashes the rail broadcast or the intents it signed. They
  // are also written to the audit log, but the log is compactable and this record is not,
  // so the transaction history keeps its explorer links after a compaction.
  result?: { ok: boolean; detail: string; reason?: string; txids?: string[]; evidence?: RailEvidence };
  // When the rail returned, or when a reconcile settled the row. `decidedAt` is the decision
  // and can be a minute before the money moved, which is the wrong stamp to judge a balance by.
  settledAt?: string;
  // An idempotency key the proposer chose, with the session, kind and params it is scoped to.
  // A repeat carrying the same key is answered with this row instead of a second one.
  clientKey?: ClientKey;
  // The seat that proposed it (the agent's session id on the roster), so the app can tell
  // that conversation when the row ends after its turn (src/http/ended.ts). Absent on a row
  // the app filed itself or a person filed from the window.
  by?: string;
  // Set when that seat's agent had read the web in its session at the moment this was asked for
  // (src/web-read.ts). land() makes such a row wait for a click, whatever its size.
  webRead?: true;
  // Set when a person filed an unconfirmed row from the dock ("Got it, waiting on the venue").
  // The row stays needs_reconciliation, keeps counting against the day and keeps its place in
  // Activity; only the dock stops asking. Cleared the moment a re-check changes what the venue
  // says, so the card comes back when there is something new to read.
  acknowledgedAt?: string;
  /* What the pocket this action moved money through was worth either side of it, in USD:
     the intents balance for an intents rail, the trading account for a Hyperliquid rail, the
     wallet total for a chain-side move. `before` is the ledger's last read as execution began,
     or the rail's own read where it took one. `after` is the rail's own after-read where it
     took one, else the ledger re-read once the move landed; null means no read answered,
     which is a different fact from a balance of zero and is rendered as "not re-read".
     These are what make a receipt answer "did my money change", which is the question a person
     actually has and which no amount of transaction hashes answers on its own. */
  balances?: { beforeUsd: number | null; afterUsd: number | null };
  // The rail's own before and after in the pocket the asset moved through, when the rail
  // read one. What `balances` is priced from, and what a settling row is re-judged against.
  pocket?: PocketRead;
  // Every preflight this row ran, oldest first: one per attempt, so a row held and retried
  // carries each reading. The card and the receipt draw the last one.
  preflight?: Preflight[];
  // Set when the preflight first said hold: the row stays approved, nothing is signed, and the
  // executor retries on its own until the checks clear or the hold runs out.
  heldSince?: string;
  /* WHEN EACH STAGE WAS FIRST ENTERED, and when the stage last changed at all. The row is
     written many times inside one stage (evidence lands, the preflight lands, a balance is
     re-read), so "last written" is not "last moved", and a counter on a card that reset on
     every write would say a deposit had just changed when nothing about it had. Written by
     persist() in src/proposals/lifecycle.ts, read by proposalView(). Keys are ProposalStage
     words; the map is absent on rows written before this existed and is backfilled on the
     next write. */
  stageAt?: Record<string, string>;
  lastChangeAt?: string;
  /* Set by the sweep in src/main.ts when a row passed its deadline with nothing changing. It
     is a statement that nothing has moved, never a claim that the move failed: the row keeps
     its status, keeps its charge against the day, and a later credit still settles it forward
     to executed. Cleared by nothing; the stage that follows a settle wins on its own. */
  stalledAt?: string;
};

// ---------- Basic view ----------
// The balances panel as data. Built by src/view/basic.ts from the same wallet the rest of the
// window reads, so every figure about money on the panel is computed in one place.

// One line of what you hold. Quantity and value are pre-formatted here for the same reason
// every other sentence is: a number formatted in browser JavaScript is a claim nothing tests.
export type BasicHolding = {
  symbol: string; // "USDC", what the row is titled
  name: string; // plain: "US dollars (USDC)", what a screen reader says
  quantityLine: string; // "1,204.00"
  // "$1,204.00", or null when the app has no price for the coin: an unknown is never "$0.00".
  valueLine: string | null;
  valueUsd: number | null; // for ordering and for tests to check the line against
};

export type BasicView = {
  // null when unknown or stale. NEVER 0 as a stand-in: a zero and an unknown are
  // indistinguishable on screen, and the panel is aimed at someone who cannot tell.
  totalUsd: number | null;
  // The figure: the last read total, or "" when nothing has been read or nothing is priced.
  // Never a sentence, and never a zero standing in for an unknown.
  totalLine: string; // "$2,341.08" | ""
  // The line under the figure, saying what it is: "in your balance", "still checking",
  // "in your balance, not counting WIF", or a whole sentence when there is no figure.
  caption: string;
  warning: string | null; // kill switch or unreadable rules, in plain words
  // Empty while any place is unread, for the same reason totalUsd goes null: a holdings list
  // missing a place looks exactly like the holdings list of someone who owns less.
  holdings: BasicHolding[];
  smallLine: string | null; // "2 tiny balances under a cent, not listed"
  emptyLine: string | null; // what the list says when it has no rows, and why
};

// ---------- Audit ----------

export type LogEvent = {
  ts: string;
  type:
    | 'app_start'
    | 'tool_call'
    // The two edges of an agent session. The heartbeat between them is not
    // logged: it says nothing a reader of the transcript does not already know.
    | 'agent_connected'
    | 'agent_disconnected'
    // An agent was turned away: the roster was full, or the session had been replaced from
    // the window. One line per refused session, not per refused call: see src/agents.ts.
    | 'agent_rejected'
    // Written by a human-run compaction, never by the app. The log is append-only,
    // so the one thing a removal owes its reader is a line saying it happened.
    | 'audit_compacted'
    | 'proposal_created'
    | 'policy_refused'
    | 'approved'
    | 'refused'
    | 'executed'
    | 'execution_failed'
    // A rail answered ok:false with a hash or a handle on it: money may have moved, and the row
    // is needs_reconciliation rather than failed. Its own kind so a reader scanning for what
    // left the wallet sees it beside 'executed', not filed under failures.
    | 'execution_unconfirmed'
    // The preflight said hold: nothing was signed, the row stays approved and the executor will
    // try again. And the hold that ran out: still nothing signed, the row is failed.
    | 'execution_held'
    | 'execution_held_expired'
    // A person filed an unconfirmed row from the dock. Nothing about the money changed.
    | 'acknowledged'
    // A rail handed the executor its evidence (a hash, a handle, a nonce) before its watch loop,
    // so the record exists while the venue is still working.
    | 'submitted'
    | 'approve_attempt_rejected'
    | 'kill_switch'
    | 'policy_changed'
    // The person accepted the terms of use in the window; data names the version.
    | 'terms_accepted'
    | 'chain_stale'
    // A view change is a thing an agent did to what a human sees, so the transcript
    // says so. 'view_refused' is HISTORICAL: the switch used to be declined while a
    // proposal was pending, and nothing emits it now that the approval block renders
    // on all three windows. It stays in the union because the log is append-only and
    // tail() casts rather than validates, so an existing audit.jsonl can still hold
    // these lines. Removing it would make the type lie about the file.
    | 'view_changed'
    // The window was recoloured. Its own kind rather than a view_changed, because a reader
    // scanning for what a human was shown while they approved wants to see it named.
    | 'theme_changed'
    | 'view_refused'
    // What a human told the in-app driver to do. The tool calls that follow are already
    // logged; without this line the transcript records that the app swapped a token and
    // never records that somebody asked it to, which is the wrong half to keep.
    | 'driver_prompt'
    | 'error';
  msg: string; // one human-readable line
  data?: unknown;
  /* SHA-256 of the previous line, exactly as it was written. It is what makes the file a chain
     and an edit detectable; see the header of src/audit.ts. Null on the first line of a file,
     and absent on any line written before the chain existed, which verify() treats as a restart
     rather than as damage. */
  prev?: string | null;
};

// ---------- External rails ----------

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

// ---------- Config ----------

export type AppConfig = {
  mode: Mode;
  port: number;
  // The one address this app owns, as a read-only install names it. The keystore is the truth
  // when there is one (src/proposals/lifecycle.ts ownBook); this is the fallback for an install
  // that reads without a key. It is the intents account id and the Hyperliquid account.
  addresses: { evm?: string };
  candleProducts: string[];
  dataDir: string; // state dir: policy.json, proposals.json, audit.jsonl
  keysPath: string; // absolute path OUTSIDE the working copy; never inside the repo
  // The in-app driver. None of these can loosen the lockdown: the tool surface is fixed in
  // operator/driver.settings.json and checked again at runtime in src/driver.ts. claudeBin
  // exists because a GUI app launched from Finder inherits a PATH that does not contain the
  // place Claude Code installs itself. autostart defaults to OFF: with no agent attached, the
  // app opens on the globe and starting one is a press. Setting it true opens the window with
  // an agent already running, and stopping the agent by hand never restarts it either way.
  driver?: { claudeBin?: string; systemPrompt?: string; autostart?: boolean; model?: string };
  // Optional keys for the chain lookups (src/chainscan). Keyless works; a key raises the rate
  // limit. Read by the read handler on every call, sent only to the host each was issued for,
  // and never written to a log or an error.
  chainscan?: { blockscoutApiKey?: string; nearblocksApiKey?: string };
  /* Which rail a swap runs on: the solver relay (one atomic token_diff) or the 1Click transfer
     it replaces, kept one config line away for a month after the flip. Rail choice is config,
     never code; absent means the relay (src/config.ts swapRailOf). */
  swap?: { rail: SwapRail };
};

export type SwapRail = 'relay' | 'oneclick';

// ---------- Service interfaces (wired in main.ts) ----------

// Rail proposal parameters. Note what is NOT in any of them: no from, no to, no recipient,
// no counterparty and no contract address. The agent names what it wants moved in chain and
// symbol terms; the app resolves every address from its own config and from the verified
// deployment tables in src/rails/. That is what keeps "the agent cannot name where the money
// goes" true for the rails and not only for a transfer, and tests/injection.test.ts asserts
// the MCP schemas built from these carry no destination field.

export type SwapParams = {
  // The home networks of the two coins, any spend network id. Either may be left out, and the
  // swap picks it by one rule (src/proposals/swap-reads.ts, resolveSwapSides).
  chain?: string;
  toChain?: string;
  fromSymbol: string;
  toSymbol: string;
  // "all" (the exact balance held), an exact decimal string, or a number read through its
  // shortest decimal string. Never float math on base units.
  amountIn: number | string;
  minAmountOut?: number; // slippage floor, in toSymbol units; absent, the app sets it under its own quote
  clientKey?: ClientKey;
  by?: string;
};

/* The idempotency key a proposer may send with any propose: 1 to 64 characters of
   [A-Za-z0-9_.:-]. A repeat carrying the same key inside CLIENT_KEY_WINDOW_MS is answered with
   the row it already made, never a second one. Not part of the duplicate fingerprint. */
export const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
export const CLIENT_KEY_WINDOW_MS = 24 * 60 * 60 * 1000;

/* That key as the door hands it to the service and as the row keeps it: the key itself, the
   session and the propose kind it is scoped to, and the fingerprint of the params it was first
   sent with. The namespace used to be global, so a second agent (or the first, an hour later, for
   a different move) reusing a key it had seen was answered with a row that moved something else
   and read "executed" about money that never went. Another session's key never matches, another
   kind under the same key is a new move, and the same key with other params is refused. */
export type ClientKey = { key: string; session: string; kind: string; fingerprint: string };

// The money leaves the intents balance and nowhere else, so there is no chain to name. symbol
// is the asset spent from that balance and defaults to USDC. The flavor spent, the credited
// account, the loss floor and the counterparty are all resolved by the app.
export type HlDepositParams = { amount: number; symbol?: string; clientKey?: ClientKey; by?: string };

// One number. The venue account, the intents account credited, the floor and the counterparty
// are all the app's; there is no field for a destination, which is the whole point.
export type HlWithdrawParams = { amount: number; clientKey?: ClientKey; by?: string };

// One send door for both send drafts. `where` is 'intents' (the money stays inside the verifier,
// an intents_send draft) or a chain network id (it is paid out on that chain, an intents_pay
// draft); the door refuses anything else and there is no default. `note` is the agent's own
// words about the receiver: kept as data on the recipients book row and in the audit line, and
// never drawn on the card, because the agent does not get to label the address it is paying.
export type SendParams = { to: string; symbol: string; amount: number; where: string; note?: string; clientKey?: ClientKey; by?: string };

// No address, no recipient, no contract. The agent sends a plan or names one it drew, and
// everything about WHERE the money is resolves from the app's own config and the venue table.
export type TradeParams = { plan?: unknown; planId?: string; by?: string | null; clientKey?: ClientKey };
export type TradeChangeParams = { id: string; stop?: number; target?: number; cancel?: boolean; close?: boolean; clientKey?: ClientKey; by?: string };

export type ProposalService = {
  proposePolicyChange(params: { patch: PolicyPatch; sentence: string; clientKey?: ClientKey; by?: string }): Promise<Proposal>;
  proposeSwap(params: SwapParams): Promise<Proposal>;
  proposeHlDeposit(params: HlDepositParams): Promise<Proposal>;
  proposeHlWithdraw(params: HlWithdrawParams): Promise<Proposal>;
  proposeSend(params: SendParams): Promise<Proposal>;
  proposeTrade(params: TradeParams): Promise<Proposal>;
  proposeTradeChange(params: TradeChangeParams): Promise<Proposal>;
  approve(id: string): Promise<Proposal>; // human path only; executes on approval
  refuse(id: string): Promise<Proposal>;
  /* Re-decide everything queued while the wallet was locked, against the policy and balances
     as they are now rather than as they were when the agent asked. Returns how many moved. */
  releaseQueued(): Promise<number>;
  get(id: string): Proposal | undefined;
  list(): Proposal[];
  /* One row as every surface reads it: the stage, what is being waited on, the clocks, the
     money and the hashes, in one object. The card draws it, /api/state carries it, the agent
     narrates it, and a row still waiting on a venue is re-judged against the last balance read
     on the way through. `now` is the clock the elapsed figures are taken against, so two
     surfaces can be asserted to agree at one instant. See src/proposals/view.ts. */
  view(p: Proposal, now?: number): ProposalView;
  /* Mark every row that passed its deadline with nothing changing. Returns how many moved. A
     stall is a statement that nothing has changed, never a claim that the move failed: the
     status underneath is untouched and a later credit still settles the row forward. */
  markStalled(now?: number): number;
  sessionSpentUsd(): number; // executed fund-moving usd in the last 24h
  // Boot sweep: every row left `executing` by a process that is gone becomes
  // `needs_reconciliation`. Returns what it changed. Ran once, before the port opens.
  reconcileOnBoot(): Proposal[];
  // Re-check one such row against the chain. Never guesses: a hash it cannot look up leaves
  // the proposal where it is, with a sentence saying why.
  reconcile(id: string): Promise<Proposal>;
  // File an unconfirmed row from the dock. Decides nothing, signs nothing, settles nothing: the
  // row keeps its status and its charge; the dock stops showing it until the venue's word changes.
  acknowledge(id: string): Promise<Proposal>;
  // Re-check every open row that carries a 1Click handle, young enough to still settle. What the
  // scheduled sweep in src/main.ts calls at boot and every ten minutes. Returns how many changed.
  reconcileOpen(): Promise<number>;
  /* The row once its rail has answered, or the row as it stands when capMs runs out. A propose
     returns the `executing` row the moment the rail starts; this is how a caller waits for the
     settled one without holding a reply open for a five minute watch loop. */
  settled(id: string, capMs: number): Promise<Proposal>;
  // Wait for whatever is already executing, up to capMs. True if it finished in time. What a
  // clean shutdown awaits before it closes the sockets.
  settle(capMs: number): Promise<boolean>;
  // The rolling 24h cap as the window shows it: the same spend figure the engine budgets on,
  // plus when the oldest counted spend leaves the window and capacity returns.
  dailyLimit(capUsd: number): { capUsd: number; spentUsd: number; resetsAt: string | null };
  // The same, for the moves the policy ran on its own: what the auto-approved ceiling budgets
  // on. Optional so a stand-in service need not carry it.
  autoLimit?(capUsd: number): { capUsd: number; spentUsd: number; resetsAt: string | null };
  /* The three swap reads (src/proposals/swap-reads.ts). None files a row, signs anything or
     takes the spend queue: what can be swapped, a dry quote, and one swap's truth re-read now.
     Optional so a stand-in service without a venue need not carry them. */
  swapAssets?(params: SwapAssetsParams): Promise<SwapAssetsReply>;
  swapQuote?(params: SwapQuoteParams): Promise<SwapQuoteReply>;
  swapCheck?(id: string): Promise<SwapCheckReply>;
};
