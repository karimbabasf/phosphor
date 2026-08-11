// Shared type contract for agent-crypto-control.
// Erasable TypeScript only: this repo runs on Node 24 type stripping with no build step.
// No enums, no namespaces, no parameter properties. Relative imports use explicit .ts extensions.

export type ChainId = 'eth' | 'base' | 'arb' | 'sol' | 'near';
export type Mode = 'demo' | 'live';

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

// ---------- Cost ----------

export type CostLine = { label: string; usd: number | null; note: string }; // null = unavailable, note says why

export type CostReport = {
  totalUsd: number; // headline fragmentation cost
  lines: CostLine[]; // exactly 4: gas-to-consolidate, conversion fees, dust, stranded
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

export type WriteDraft =
  | { kind: 'consolidate'; legs: TransferLeg[]; totalUsd: number; toChain: ChainId; symbol: string }
  | { kind: 'transfer'; leg: TransferLeg } // engine supports it; no MCP tool exposes it in v1
  | { kind: 'policy_change'; patch: PolicyPatch; sentence: string };

export type SimulationResult = {
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
  decidedBy?: 'human' | 'policy';
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
  port: number;
  addresses: { evm: string[]; solana: string[]; near: string[] };
  economicTransferUsd: number; // below this a balance is dust regardless of gas
  candleProducts: string[];
  dataDir: string; // state dir: policy.json, proposals.json, audit.jsonl
};

// ---------- Service interfaces (wired in main.ts) ----------

export type ProposalService = {
  proposeConsolidate(params: {
    toChain: ChainId;
    symbol: string;
    fromChains?: ChainId[];
    maxTotalUsd?: number;
  }): Promise<Proposal>;
  proposePolicyChange(params: { patch: PolicyPatch; sentence: string }): Promise<Proposal>;
  approve(id: string): Promise<Proposal>; // human path only; executes on approval
  refuse(id: string): Promise<Proposal>;
  get(id: string): Proposal | undefined;
  list(): Proposal[];
  sessionSpentUsd(): number; // executed fund-moving usd in the last 24h
};
