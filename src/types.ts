// Shared type contract for agent-crypto-control.
// Erasable TypeScript only: this repo runs on Node 24 type stripping with no build step.
// No enums, no namespaces, no parameter properties. Relative imports use explicit .ts extensions.

export type ChainId = 'eth' | 'base' | 'arb' | 'sol' | 'near';
export type Mode = 'demo' | 'live';

// ChainId names the chain family; Network selects which world that family lives in.
// Adding 'arb-sepolia' style ids instead was rejected: it doubles every ChainId switch
// in the engine, ledger, policy file and UI, and the wallet's CHAIN column would read
// 'arb-sepolia' where a wallet should read ARB. One config field moves the whole app.
export type Network = 'testnet' | 'mainnet';

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
export type ViewMode = 'basic' | 'pro' | 'trade';

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

export type LpPosition = {
  chain: ChainId;
  venue: string; // 'uniswap-v3', 'ref-finance', ...
  poolId: string; // pool address or id
  positionId: string; // NFT token id, or the pool id where positions are fungible
  token0: { symbol: string; tokenId: string; amount: number };
  token1: { symbol: string; tokenId: string; amount: number };
  feeTier: number | null; // in hundredths of a bip (3000 = 0.30%); null where the venue has no tiers
  inRange: boolean | null; // null for a venue without concentrated ranges
  uncollectedFeesUsd: number | null; // null when the venue cannot report it
};

// Where a wallet row physically sits. A balance inside the intents.near verifier is on no
// chain: it is an entry on that contract's own ledger, and calling it 'near' would tell a
// reader to look for it on NEAR where nothing will be found.
//
// Deliberately a DISPLAY axis only. LedgerSnapshot.chainStatus and everything the policy
// engine reads stay strictly ChainId, so adding this cannot reach the per-chain gas floors
// or the outbound rules. See the header of src/ledger/index.ts on adding an axis.
export type WalletPlace = ChainId | 'intents';

export type WalletRow = {
  kind: 'token' | 'lp' | 'intents';
  chain: WalletPlace;
  symbol: string; // 'USDC', 'ETH', or 'USDC/WETH 0.05%' for a pool position
  tokenId: string;
  quantity: number;
  priceUsd: number; // 1.0 for stables, spot for natives; testnet prices come from the mainnet twin
  valueUsd: number;
  share: number; // 0..1 of wallet total
  native: boolean;
  lp?: LpPosition;
  // Set on an intents row: the verifier's asset id and the account it credits, so a row
  // can be reconciled against `npm run intents-balance` without guessing.
  intents?: { accountId: string; assetId: string };
};

export type WalletView = {
  rows: WalletRow[]; // value descending; only things actually held
  totalUsd: number; // everything: tokens, natives, LP and intents balances
  byChain: Record<string, number>; // place -> usd
  stale: WalletPlace[]; // places whose last read failed; never silently zero
  // How many configured tokens came back with nothing in them. The rows are gone from
  // the list (a wallet lists what you hold), but the number stays: "we looked at 19
  // tokens and 14 were empty" and "we only looked at 5" are different facts.
  emptyCount: number;
};

// ---------- Policy ----------

export type Policy = {
  version: number;
  killSwitch: boolean; // human-only; not reachable by any patch
  outbound: {
    maxPerTransactionUsd: number;
    maxPerSessionUsd: number; // rolling 24h sum of executed fund-moving proposals
    humanClickAboveUsd: number; // above this, allow becomes needs_approval
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
  venue: 'oneclick' | 'uniswap-v3' | 'intents-native';
  chain: ChainId; // origin chain
  toChain: ChainId; // same as chain for a same-chain DEX swap
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

export type HlDepositDraft = {
  kind: 'hl_deposit';
  chain: ChainId; // 'arb' (Arbitrum Sepolia on testnet)
  symbol: string; // 'USDC'
  amount: number;
  amountUsd: number;
  from: string;
  bridge: string; // resolved per network; the mainnet address on testnet burns the tokens
};

export type LpAddDraft = {
  kind: 'lp_add';
  chain: ChainId;
  venue: string;
  poolId: string;
  token0: { symbol: string; tokenId: string; amount: number; decimals: number };
  token1: { symbol: string; tokenId: string; amount: number; decimals: number };
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  amountUsd: number;
  from: string;
  counterparty: string; // position manager / router; must be on the policy allowlist
};

export type LpRemoveDraft = {
  kind: 'lp_remove';
  chain: ChainId;
  venue: string;
  positionId: string;
  liquidityPct: number; // 0..1 of the position to pull
  amountUsd: number;
  from: string;
  counterparty: string; // position manager; must be on the policy allowlist
};

// Arming a strategy. The odd one out among the drafts, and deliberately so: it moves no money
// at the moment it is approved. What it does is grant STANDING authority to a program that will
// move money later, at machine speed, with no human in the loop for each order.
//
// It rides the draft path anyway rather than opening a second trust path, which buys the gate,
// the audit log, the policy engine and the approval panel for free. amountUsd is the maximum
// notional the mandate can put at risk, so the existing budget rules govern how big a bot can
// be without a new rule being written.
//
// Note what is absent, matching every other rail: no address, no recipient, no contract. The
// program the agent wrote cannot name a destination because the grammar has no verb that moves
// value off the venue.
export type MandateDraft = {
  kind: 'mandate_arm';
  symbol: string;
  program: unknown; // validated by src/strategy/grammar.ts at propose time, never trusted raw
  programHash: string;
  maxNotionalUsd: number;
  maxLeverage: number;
  maxOrdersPerMin: number;
  maxLossUsd: number;
  expiresAt: string;
  allowedActions: string[];
  amountUsd: number; // equals maxNotionalUsd; the field name the policy engine reads
  counterparty: string; // the venue itself: a perp order moves nothing to a new address
};

export type WriteDraft =
  | { kind: 'consolidate'; legs: TransferLeg[]; totalUsd: number; toChain: ChainId; symbol: string }
  | { kind: 'transfer'; leg: TransferLeg } // engine supports it; no MCP tool exposes it in v1
  | { kind: 'policy_change'; patch: PolicyPatch; sentence: string }
  | SwapDraft
  | HlDepositDraft
  | IntentsDepositDraft
  | IntentsWithdrawDraft
  | LpAddDraft
  | LpRemoveDraft
  | MandateDraft;

// One rail per feature, each owning exactly one module under src/rails/. The dispatch
// table in proposals.ts is the only place that knows they all exist, which is what lets
// a rail be added without touching the engine.
export type RailResult = { ok: boolean; detail: string; txids?: string[] };

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
  // Runs only after the proposal is approved, or auto-approved with the gate off.
  execute(draft: D): Promise<RailResult>;
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
  | 'approved'
  | 'refused'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'policy_refused';

export type Proposal = {
  id: string;
  kind: WriteDraft['kind'];
  createdAt: string;
  status: ProposalStatus;
  draft: WriteDraft;
  simulation: SimulationResult | null;
  verdict: Verdict;
  // 'gate_disabled' is an auto-approval taken because the approval gate is switched off on
  // testnet. It is deliberately NOT 'human': nothing in the record may suggest a person
  // clicked when no person did.
  decidedBy?: 'human' | 'policy' | 'gate_disabled';
  decidedAt?: string;
  // txids are the evidence: the hashes the rail broadcast or the intents it signed. They
  // are also written to the audit log, but the log is compactable and this record is not,
  // so the transaction history keeps its explorer links after a compaction.
  result?: { ok: boolean; detail: string; txids?: string[] };
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
  headline: string; // "Moved $36.54 of your dollars into a Uniswap pool."
  timeLine: string; // "2:14 pm"
  outcome: 'done' | 'refused' | 'blocked';
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
  totalLine: string; // "$2,341.08" | "still checking" | "checking your new balance"
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
    // A second agent tried to drive the app while another one held the seat. One
    // line per refused session, not per refused call: see src/agents.ts.
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
    | 'view_refused'
    | 'error';
  msg: string; // one human-readable line
  data?: unknown;
};

// ---------- External rails ----------

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type CandleSource = {
  name: string;
  // product like 'BTC-USD', granularity in seconds, newest-last ordering
  candles(product: string, granularitySec: number, limit: number): Promise<Candle[]>;
  spot(product: string): Promise<number>;
};

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
  network: Network; // selects RPCs, the token registry and every contract address
  approvalGate: boolean; // honoured on testnet only; see gateRequired() in policy/gate.ts
  port: number;
  addresses: { evm: string[]; solana: string[]; near: string[] };
  economicTransferUsd: number; // below this a balance is dust regardless of gas
  candleProducts: string[];
  dataDir: string; // state dir: policy.json, proposals.json, audit.jsonl
  keysPath: string; // absolute path OUTSIDE the working copy; never inside the repo
  // The in-app driver. Both fields are optional and neither can loosen the lockdown: the tool
  // surface is fixed in operator/driver.settings.json and checked again at runtime in
  // src/driver.ts. claudeBin exists because a GUI app launched from Finder inherits a PATH that
  // does not contain the place Claude Code installs itself.
  driver?: { claudeBin?: string; systemPrompt?: string };
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
};

export type HlDepositParams = { amount: number }; // chain, token and bridge come from the network table

// The credited account, the loss floor and the counterparty are all resolved by the app.
// symbol defaults to the origin chain's gas asset, which is what "deposit $10 of ETH" means.
export type IntentsDepositParams = { chain: ChainId; symbol?: string; amount: number };

// Same shape, opposite direction, and the same silence about addresses. `chain` says where
// the money lands; which wallet on that chain is our own is read from config and from the
// key, never from this call.
export type IntentsWithdrawParams = { chain: ChainId; symbol?: string; amount: number };

export type LpAddParams = {
  chain: ChainId;
  token0Symbol: string;
  token1Symbol: string;
  amount0: number;
  amount1: number;
  feeTier: number;
  tickLower: number;
  tickUpper: number;
};

// The position is looked up in the wallet, which is what fixes the chain, the venue and the
// value. An id we do not already hold is refused rather than resolved.
export type LpRemoveParams = { positionId: string; liquidityPct: number };

// No address, no recipient, no contract. The agent names a symbol, a size and a shape, and
// everything about WHERE the money is resolves from the app's own config and the venue table.
export type MandateParams = {
  symbol: string;
  program: unknown; // validated against the grammar before a draft exists
  maxNotionalUsd: number;
  maxLeverage: number;
  maxOrdersPerMin: number;
  maxLossUsd: number;
  expiresAt: string;
  allowedActions: string[];
};

export type ProposalService = {
  proposeConsolidate(params: {
    toChain: ChainId;
    symbol: string;
    fromChains?: ChainId[];
    maxTotalUsd?: number;
  }): Promise<Proposal>;
  proposePolicyChange(params: { patch: PolicyPatch; sentence: string }): Promise<Proposal>;
  proposeSwap(params: SwapParams): Promise<Proposal>;
  proposeHlDeposit(params: HlDepositParams): Promise<Proposal>;
  proposeIntentsDeposit(params: IntentsDepositParams): Promise<Proposal>;
  proposeIntentsWithdraw(params: IntentsWithdrawParams): Promise<Proposal>;
  proposeMandate(params: MandateParams): Promise<Proposal>;
  proposeLpAdd(params: LpAddParams): Promise<Proposal>;
  proposeLpRemove(params: LpRemoveParams): Promise<Proposal>;
  approve(id: string): Promise<Proposal>; // human path only; executes on approval
  refuse(id: string): Promise<Proposal>;
  get(id: string): Proposal | undefined;
  list(): Proposal[];
  sessionSpentUsd(): number; // executed fund-moving usd in the last 24h
};
