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

export type WalletRow = {
  kind: 'token' | 'lp';
  chain: ChainId;
  symbol: string; // 'USDC', 'ETH', or 'USDC/WETH 0.05%' for a pool position
  tokenId: string;
  quantity: number;
  priceUsd: number; // 1.0 for stables, spot for natives; testnet prices come from the mainnet twin
  valueUsd: number;
  share: number; // 0..1 of wallet total
  native: boolean;
  lp?: LpPosition;
};

export type WalletView = {
  rows: WalletRow[]; // value descending
  totalUsd: number; // everything: tokens, natives and LP
  byChain: Record<string, number>; // chain -> usd
  stale: ChainId[]; // chains whose last read failed; never silently zero
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
  result?: { ok: boolean; detail: string };
};

// ---------- Audit ----------

export type LogEvent = {
  ts: string;
  type:
    | 'app_start'
    | 'tool_call'
    | 'agent_connected'
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
  proposeMandate(params: MandateParams): Promise<Proposal>;
  proposeLpAdd(params: LpAddParams): Promise<Proposal>;
  proposeLpRemove(params: LpRemoveParams): Promise<Proposal>;
  approve(id: string): Promise<Proposal>; // human path only; executes on approval
  refuse(id: string): Promise<Proposal>;
  get(id: string): Proposal | undefined;
  list(): Proposal[];
  sessionSpentUsd(): number; // executed fund-moving usd in the last 24h
};
