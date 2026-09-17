// Shared type contract for agent-crypto-control.
// Erasable TypeScript only: this repo runs on Node 24 type stripping with no build step.
// No enums, no namespaces, no parameter properties. Relative imports use explicit .ts extensions.

import type { PocketRead } from './ledger/settle.ts';
import type { Plan } from './trade/plan.ts';
import type { PlanRisk } from './trade/risk.ts';

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

export type Holding = {
  chain: ChainId;
  address: string; // owner address
  symbol: string; // 'USDC', 'USDT', ... ; native gas assets use 'ETH' | 'SOL' | 'NEAR'
  tokenId: string; // contract address / mint / NEAR contract id; 'native' for the gas asset
  amount: number; // UI units
  usd: number; // amount * price (stables priced 1.0, natives via spot)
  native: boolean;
};

export type ChainStatus = { ok: boolean; fetchedAt: string; error?: string };

export type LedgerSnapshot = {
  holdings: Holding[];
  chainStatus: Record<ChainId, ChainStatus>; // a failed chain is marked stale, never silently zero
  mode: Mode;
  prices: Record<string, number>; // native symbol -> usd used for pricing
  /* When each of those prices was fetched, in epoch ms. Present on a live snapshot and absent on
     a demo or fixture one, and the difference is real: a live price is a reading off one endpoint
     that can fail, and the old loader then reused the last known value forever with no way for
     anything downstream to know how old it was. Every budget in the policy engine is measured
     against a number derived from these, so an unknown age has to be refusable. A snapshot with
     no map at all carries a static table rather than a reading, and there is no fetch time to be
     old. See PRICE_STALENESS_MS in src/proposals/draft.ts for the bound. */
  priceAsOf?: Record<string, number>;
  gas: Record<ChainId, { transferCostUsd: number }>; // est. cost of one stable transfer out of this chain
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
  chain: ChainId;
  amount: number;
  usd: number;
  share: number; // 0..1 of total stable usd
  freezable: boolean; // unclassified assets count as freezable (fail pessimistic)
  classified: boolean;
};

export type CompositionView = {
  rows: CompositionRow[]; // sorted by share descending
  totalUsd: number; // stables only, natives excluded
  byIssuer: Record<string, number>; // issuer -> share 0..1
  freezableShare: number;
  unclassified: string[]; // symbols with no risk row
};

// ---------- Wallet ----------
// What the composition panel renders: everything held, the way a normal wallet shows it.
// CompositionView above does NOT go away; it stops being the UI's source and stays the
// policy engine's input (byIssuer, freezableShare are what the composition rules read).

// Where a wallet row physically sits. A balance inside the intents.near verifier is on no
// chain: it is an entry on that contract's own ledger, and calling it 'near' would tell a
// reader to look for it on NEAR where nothing will be found.
//
// Deliberately a DISPLAY axis only. LedgerSnapshot.chainStatus and everything the policy
// engine reads stay strictly ChainId, so adding this cannot reach the per-chain gas floors
// or the outbound rules. See the header of src/ledger/index.ts on adding an axis.
export type WalletPlace = ChainId | 'intents' | 'hyperliquid';

export type WalletRow = {
  kind: 'token' | 'intents' | 'hyperliquid';
  chain: WalletPlace;
  symbol: string; // 'USDC' or 'ETH'
  tokenId: string;
  quantity: number;
  priceUsd: number; // 1.0 for stables, spot for natives
  valueUsd: number;
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
  totalUsd: number; // everything: tokens, natives and intents balances
  byChain: Record<string, number>; // place -> usd
  stale: WalletPlace[]; // places whose reads have failed; never silently zero
  // Why each stale place is stale, in the reader's words, where the read said.
  staleWhy?: Partial<Record<WalletPlace, string>>;
  // How many configured tokens came back with nothing in them. The rows are gone from
  // the list (a wallet lists what you hold), but the number stays: "we looked at 19
  // tokens and 14 were empty" and "we only looked at 5" are different facts.
  emptyCount: number;
  // Priced balances that round to $0.00, kept out of the rows but inside totalUsd and byChain.
  // The count and the sum let a card say "1 tiny balance, not listed" instead of hiding money.
  dustCount: number;
  dustUsd: number;
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
    minNativeGasUsd: Partial<Record<ChainId, number>>;
    forbiddenIssuers: string[];
  };
  sentences: string[]; // plain-English rules as authored; UI renders these, never JSON
};

export type PolicyPatch = {
  outbound?: Partial<Omit<Policy['outbound'], 'simulateBeforeSign'>>;
  composition?: Partial<Policy['composition']>;
};

export type Verdict =
  | { outcome: 'allow'; reasons: string[] }
  | { outcome: 'needs_approval'; reasons: string[] }
  | { outcome: 'refuse'; reasons: string[]; rule: string };

// ---------- Writes ----------

export type LegQuote = {
  amountOut: number;
  feeUsd: number;
  timeEstimateSec: number;
  raw?: unknown;
};

export type TransferLeg = {
  fromChain: ChainId;
  toChain: ChainId;
  symbol: string;
  amount: number;
  amountUsd: number;
  from: string; // owner address on fromChain
  to: string; // recipient address on toChain
  quote: LegQuote | null;
  gasNativeUsd: number; // est. origin-chain gas to fund the deposit
};

// The three features Karim asked for, each one draft kind. Every draft carries amountUsd
// because that is what the policy engine's budget rules read; a rail that cannot price
// itself in USD cannot be governed, so the field is required rather than optional.

export type SwapDraft = {
  kind: 'swap';
  // 'oneclick' and 'intents-native' are both NEAR Intents and they are not interchangeable:
  // oneclick transfers wallet funds to a per-quote deposit address, intents-native signs an
  // intent over a balance already held inside the intents.near verifier and transfers
  // nothing. See the header of src/rails/intents-native.ts for which one to use.
  //
  // 'uniswap-v3' is retired and cannot be proposed. It stays in the union because
  // state/proposals.json holds executed rows naming it, and a history reader that could not
  // type those rows would have to drop them. Nothing builds one.
  venue: 'oneclick' | 'uniswap-v3' | 'intents-native';
  chain: ChainId; // origin chain
  toChain: ChainId; // equal to chain when nothing crosses
  fromSymbol: string;
  toSymbol: string;
  amountIn: number;
  amountUsd: number;
  minAmountOut: number; // slippage floor; execution must revert rather than fill below this
  from: string;
  to: string;
  counterparty: string; // the contract funds are handed to; must be on the policy allowlist
  quote: LegQuote | null;
};

// Moving funds from this wallet into the intents.near verifier, where they become a balance
// the intents-native rail can swap. Not a SwapDraft: the asset does not change, and the far
// side is an account id inside a contract rather than an address. See the header of
// src/rails/intents-deposit.ts for why that distinction is load bearing on the tool surface.
export type IntentsDepositDraft = {
  kind: 'intents_deposit';
  chain: ChainId; // origin chain, an EVM one; the app has no signer for the others
  symbol: string;
  tokenId: string; // 'native' for the gas asset, otherwise the ERC-20 contract
  amount: number;
  amountUsd: number;
  minCredited: number; // the least that may be credited inside the verifier
  from: string; // our wallet on the origin chain
  intentsAccount: string; // who is credited inside intents.near: our own address, lowercased
  counterparty: string; // must be on the policy allowlist
};

// The way back out: a balance held inside intents.near leaves the verifier and lands in a
// wallet on a real chain. The mirror of IntentsDepositDraft, and the only draft in the app
// whose destination is an address on a chain this app may hold no key for. `to` is resolved
// from config by the proposal service and re-derived by the rail; see the header of
// src/rails/intents-withdraw.ts for why that is the whole safety story of this kind.
export type IntentsWithdrawDraft = {
  kind: 'intents_withdraw';
  chain: ChainId; // where it lands, and whose bridged asset we are spending inside the verifier
  symbol: string;
  amount: number;
  amountUsd: number;
  minReceived: number; // the least that may arrive in the wallet
  from: string; // our account id inside intents.near: the EVM address, lowercased
  to: string; // our own wallet on `chain`; never named by a caller
  counterparty: string; // must be on the policy allowlist
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
// A balance inside intents.near moving to ANOTHER account inside the same verifier: the one
// draft whose `to` is not this app's own wallet. It is held to the destination allowlist by the
// policy engine and always waits for a click; see the header of src/rails/intents-send.ts.
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
  | { kind: 'consolidate'; legs: TransferLeg[]; totalUsd: number; toChain: ChainId; symbol: string }
  | { kind: 'transfer'; leg: TransferLeg } // engine supports it; no MCP tool exposes it in v1
  | { kind: 'policy_change'; patch: PolicyPatch; sentence: string }
  | SwapDraft
  | HlDepositDraft
  | HlWithdrawDraft
  | IntentsDepositDraft
  | IntentsWithdrawDraft
  | IntentsSendDraft
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
  // The 1Click quote the move paid into, as 1Click signed it: verified before the deposit address
  // was used (src/quote-signature.ts) and kept so a dispute is filed with the vendor's own
  // commitment rather than this app's memory of it.
  quote?: { correlationId: string; timestamp: string; signature: string; depositAddress: string };
};

export type RailResult = {
  ok: boolean;
  detail: string;
  txids?: string[];
  evidence?: RailEvidence;
  // The venue confirmed the move and the balance has not shown it inside the rail's window.
  // Neither executed nor failed: the proposal lands as needs_reconciliation and the next
  // balance read that shows the rise settles it (src/proposals/execute.ts).
  settling?: boolean;
  // The balance the rail read either side of the move, for the receipt and for that re-check.
  pocket?: PocketRead;
};

// Called by a rail the moment something irreversible exists: a signature released, a
// transaction broadcast, an intent submitted. The executor persists it before the rail's
// watch loop, so a process that dies inside the wait still has the hash on the row.
export type RailHooks = { onEvidence?: (evidence: { txids?: string[] } & RailEvidence) => void };

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
  postComposition?: CompositionView; // fund moves: composition after the move
  policyDiff?: { before: string[]; after: string[] }; // policy changes: sentences before/after
  error?: string;
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
  result?: { ok: boolean; detail: string; txids?: string[]; evidence?: RailEvidence };
  // When the rail returned, or when a reconcile settled the row. `decidedAt` is the decision
  // and can be a minute before the money moved, which is the wrong stamp to judge a balance by.
  settledAt?: string;
  // An idempotency key the proposer chose, with the session, kind and params it is scoped to.
  // A repeat carrying the same key is answered with this row instead of a second one.
  clientKey?: ClientKey;
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
};

// ---------- Basic view ----------
// The whole basic screen as data. Built by src/view/basic.ts from the same state the
// pro deck renders, so the two can be asserted to agree rather than assumed to.
//
// The rule this type exists to enforce: basic may render fewer WORDS, never fewer
// FACTS about where the money goes. Amount is the field least likely to be wrong.
// Destination is the one with a track record here (see F2: the amount was correct and
// the funds went to a solver-chosen address while the screen said "your wallet").

// Drives the one big sentence and the colour treatment. The browser maps it to a
// class, so a tone nobody styled cannot silently render as unstyled text.
export type BasicTone = 'calm' | 'asking' | 'working' | 'stopped' | 'frozen' | 'broken';

// Where the funds actually land. 'quoter' means the venue minted the address rather
// than the app choosing it, which is inherent to intent bridging and is exactly what
// F2 hid. A quoter-chosen address may never be labelled as the user's own wallet.
export type BasicDestination = {
  label: string; // plain words: "an address the swap service chose, not your wallet"
  address: string; // rendered in full, never truncated
  chosenBy: 'app' | 'quoter';
};

export type BasicAsk = {
  proposalId: string;
  kind: WriteDraft['kind'];
  headline: string; // "It wants to change $105.00 of your dollars into Ether."
  afterLine: string; // "You would have $2,236.08 in dollars afterwards."
  amountUsd: number; // MUST equal draft.amountUsd, the number evaluateRail governed on
  symbols: string[]; // every token symbol the draft names
  chains: string[]; // every chain the draft names
  destinations: BasicDestination[]; // draft.counterparty plus every simulation deposit address
  facts: string[]; // short plain lines that may not be dropped
};

// One line of "what you own". Quantity and value are pre-formatted here for the same
// reason every other sentence is: a number formatted in browser JavaScript is a claim
// nothing tests. Pool positions collapse into the row for what they hold.
export type BasicHolding = {
  name: string; // plain: "US dollars (USDC)"
  quantityLine: string; // "1,204.00"
  valueLine: string; // "$1,204.00"
  valueUsd: number; // for ordering and for tests to check the line against
  // 0..1 of the total. The ring is drawn from this rather than from a sum the browser
  // did for itself: every figure about money on this screen is computed in one place.
  share: number;
};

// One coin, one price, one direction, and the shape of the last day behind it.
// A LINE, never a candlestick. Karim, 2026-08-14: "btc, sol, and eth with a basic
// chart, not candles, just a single line". A candlestick answers a question this
// reader did not ask; the line answers the one they did, which is "and before now?".
export type BasicPrice = {
  name: string; // plain: "Ether"
  symbol: string; // "ETH", kept because it is the verifiable half
  // Which chain mark the browser draws beside the name. Drawn, not loaded: this page
  // still loads no images. null means draw nothing rather than draw a guess.
  mark: 'btc' | 'eth' | 'sol' | null;
  priceLine: string; // "$3,184.22"
  changeLine: string; // "up 1.4% today" | "down 0.8% today" | "level today"
  direction: 'up' | 'down' | 'flat';
  // Closes over the tracked window, oldest first. Empty when the history could not be
  // read, which draws no line at all: a flat line and an unread one look identical.
  points: number[];
};

// A headline, not a log line. The sentence is composed from the proposal's own typed
// draft, never from the audit event's developer-facing msg: that text is written for
// whoever is debugging this and reads as noise to the person who owns the money.
export type BasicRecent = {
  headline: string; // "Moved $36.54 of your dollars to your Hyperliquid trading account."
  timeLine: string; // "2:14 pm"
  // 'unconfirmed' is a needs_reconciliation row that carries a hash or a handle: money may have
  // moved and the app cannot yet say. Distinct from 'blocked' (nothing moved) on purpose.
  outcome: 'done' | 'refused' | 'blocked' | 'unconfirmed';
};

// What the ASSISTANT did, which is a different list from what happened to the money.
// Karim, 2026-08-14: "history for transactions and agent actions separate". Reading and
// looking are most of what an assistant does, and folding them into the money list made
// four real movements sit under twenty balance checks.
//
// Composed from the typed audit event and its arguments, never from its msg field, for
// the same reason BasicRecent is composed from the proposal: that text is written for
// whoever is debugging this app and reads as noise to the person who owns the money.
export type BasicAction = {
  line: string; // "Looked at what you own."
  timeLine: string; // "2:14 pm", of the most recent one in the run
  // A run of the same action collapses to one line carrying its count. An assistant that
  // read the wallet nine times produces nine identical sentences, and nine identical
  // sentences is a log, which is the thing this screen exists not to be.
  repeat: number; // 1 when it happened once
};

export type BasicView = {
  tone: BasicTone;
  // null when unknown or stale. NEVER 0 as a stand-in: a zero and an unknown are
  // indistinguishable on screen, and basic is aimed at someone who cannot tell.
  totalUsd: number | null;
  // The hero's own slot: the last read total, or "" when a place is unread and nothing has
  // been read at all. Never a sentence, and never a zero standing in for an unknown.
  totalLine: string; // "$2,341.08" | ""
  // Why the number above is not yet fact, set in the state line under it; null when it is.
  checkingLine: string | null; // "Still checking." | "Checking your new balance."
  placesLine: string;
  headline: string;
  ask: BasicAsk | null;
  warning: string | null; // gate off, policy unreadable, kill switch, in plain words
  agentLine: string;
  footer: string;
  // Empty while any chain is unread, for the same reason totalUsd goes null: a holdings
  // list missing a chain looks exactly like a holdings list of someone who owns less.
  holdings: BasicHolding[];
  // The three coins this screen tracks, in the order they are read: BTC, SOL, ETH.
  // A coin whose price could not be read is ABSENT rather than present and blank, for
  // the same reason totalUsd goes null: an unknown and a zero look identical on screen.
  prices: BasicPrice[];
  recent: BasicRecent[]; // newest first, capped; empty is a designed state, not a bug
  actions: BasicAction[]; // the other half of the history: what the assistant did
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
    // A person filed an unconfirmed row from the dock. Nothing about the money changed.
    | 'acknowledged'
    // A rail handed the executor its evidence (a hash, a handle, a nonce) before its watch loop,
    // so the record exists while the venue is still working.
    | 'submitted'
    | 'approve_attempt_rejected'
    | 'kill_switch'
    | 'policy_changed'
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

export type Quoter = {
  name: string;
  quoteLeg(leg: TransferLeg): Promise<LegQuote>; // throws on failure; caller treats throw as refusal
};

export type Signer = {
  ready: boolean;
  describe(): string;
  send(leg: TransferLeg, depositAddress: string): Promise<{ ok: boolean; txid?: string; error?: string }>;
};

// ---------- Config ----------

export type AppConfig = {
  mode: Mode;
  port: number;
  addresses: { evm: string[]; solana: string[]; near: string[] };
  economicTransferUsd: number; // below this a balance is dust regardless of gas
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
};

// ---------- Service interfaces (wired in main.ts) ----------

// Rail proposal parameters. Note what is NOT in any of them: no from, no to, no recipient,
// no counterparty and no contract address. The agent names what it wants moved in chain and
// symbol terms; the app resolves every address from its own config and from the verified
// deployment tables in src/rails/. That is what keeps "the agent cannot name where the money
// goes" true for the rails and not only for a transfer, and tests/injection.test.ts asserts
// the MCP schemas built from these carry no destination field.

export type SwapParams = {
  venue: SwapDraft['venue'];
  chain: ChainId; // origin
  toChain?: ChainId; // defaults to chain; only the oneclick venue crosses chains
  fromSymbol: string;
  toSymbol: string;
  amountIn: number;
  minAmountOut: number; // slippage floor, in toSymbol units
  clientKey?: ClientKey;
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
export type HlDepositParams = { amount: number; symbol?: string; clientKey?: ClientKey };

// One number. The venue account, the intents account credited, the floor and the counterparty
// are all the app's; there is no field for a destination, which is the whole point.
export type HlWithdrawParams = { amount: number; clientKey?: ClientKey };

// The credited account, the loss floor and the counterparty are all resolved by the app.
// symbol defaults to the origin chain's gas asset, which is what "deposit $10 of ETH" means.
export type IntentsDepositParams = { chain: ChainId; symbol?: string; amount: number; clientKey?: ClientKey };

// Same shape, opposite direction, and the same silence about addresses. `chain` says where
// the money lands; which wallet on that chain is our own is read from config and from the
// key, never from this call.
export type IntentsWithdrawParams = { chain: ChainId; symbol?: string; amount: number; clientKey?: ClientKey };
export type IntentsSendParams = { to: string; symbol: string; amount: number; clientKey?: ClientKey };

// No address, no recipient, no contract. The agent sends a plan or names one it drew, and
// everything about WHERE the money is resolves from the app's own config and the venue table.
export type TradeParams = { plan?: unknown; planId?: string; by?: string | null; clientKey?: ClientKey };
export type TradeChangeParams = { id: string; stop?: number; target?: number; cancel?: boolean; close?: boolean; clientKey?: ClientKey };

export type ProposalService = {
  proposeConsolidate(params: {
    toChain: ChainId;
    symbol: string;
    fromChains?: ChainId[];
    maxTotalUsd?: number;
    clientKey?: ClientKey;
  }): Promise<Proposal>;
  proposePolicyChange(params: { patch: PolicyPatch; sentence: string; clientKey?: ClientKey }): Promise<Proposal>;
  proposeSwap(params: SwapParams): Promise<Proposal>;
  proposeHlDeposit(params: HlDepositParams): Promise<Proposal>;
  proposeHlWithdraw(params: HlWithdrawParams): Promise<Proposal>;
  proposeIntentsDeposit(params: IntentsDepositParams): Promise<Proposal>;
  proposeIntentsWithdraw(params: IntentsWithdrawParams): Promise<Proposal>;
  proposeIntentsSend(params: IntentsSendParams): Promise<Proposal>;
  proposeTrade(params: TradeParams): Promise<Proposal>;
  proposeTradeChange(params: TradeChangeParams): Promise<Proposal>;
  approve(id: string): Promise<Proposal>; // human path only; executes on approval
  refuse(id: string): Promise<Proposal>;
  /* Re-decide everything queued while the wallet was locked, against the policy and balances
     as they are now rather than as they were when the agent asked. Returns how many moved. */
  releaseQueued(): Promise<number>;
  get(id: string): Proposal | undefined;
  list(): Proposal[];
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
};
