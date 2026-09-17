// One live-mode proposal service over a scripted rail, for the executor tests.
//
// The same shape tests/unit/rail-wiring.test.ts builds by hand: a live ledger over the demo
// fixture so addresses and prices resolve without an RPC, a verifier read with enough USDC of
// one flavor for a deposit, the venue allowlist seeded, and a rail that runs whatever script the
// test hands it. Nothing here touches a key or a network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, LedgerSnapshot, Policy, Proposal, Rail, RailHooks, RailResult, RiskRow, WriteDraft } from '../../../src/types.ts';
import type { Ledger } from '../../../src/ledger/index.ts';
import type { IntentsRead } from '../../../src/ledger/intents.ts';
import type { Audit } from '../../../src/audit.ts';
import type { Store } from '../../../src/store.ts';
import { createAudit } from '../../../src/audit.ts';
import { createStore } from '../../../src/store.ts';
import { loadDemoLedger } from '../../../src/ledger/demo.ts';
import { defaultPolicy, savePolicy } from '../../../src/policy/file.ts';
import { renderSentences } from '../../../src/policy/render.ts';
import { createProposalService } from '../../../src/proposals.ts';
import type { ProposalDeps } from '../../../src/proposals.ts';
import { isRailKind, venueAllowlist } from '../../../src/rails/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

export const SELF_EVM = '0x1111111111111111111111111111111111111111';
export const ETH_USDC_FLAVOR = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';

export type RailScript = (draft: WriteDraft, id: string | undefined, hooks: RailHooks | undefined) => Promise<RailResult>;

// A rail of one kind that simulates fine and executes the script.
export function railThat(kind: WriteDraft['kind'], run: RailScript): Rail {
  return {
    kind,
    valueUsd: () => 0,
    async simulate() {
      return { ok: true, summary: 'scripted rail: nothing was simulated' };
    },
    execute: (draft, id, hooks) => run(draft, id, hooks),
  };
}

// A rail that answers when the test says so. `hooks` is what the executor handed it, so a test
// can hand evidence back through it before releasing.
export function slowRail(kind: WriteDraft['kind']): {
  rail: Rail;
  release: (result: RailResult) => void;
  hooks: () => RailHooks | undefined;
  started: () => Promise<void>;
} {
  let release: (result: RailResult) => void = () => {};
  let hooks: RailHooks | undefined;
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const rail = railThat(kind, (_draft, _id, given) => {
    hooks = given;
    markStarted();
    return new Promise<RailResult>((resolve) => {
      release = resolve;
    });
  });
  return { rail, release: (result) => release(result), hooks: () => hooks, started: () => started };
}

// A propose or an approve answers with the row as it stands, `executing` while the rail runs.
// For a test about where the row lands.
export async function landed(h: { svc: { settled(id: string, capMs: number): Promise<Proposal> } }, reply: Promise<Proposal>): Promise<Proposal> {
  return h.svc.settled((await reply).id, 5000);
}

export function seededPolicy(): Policy {
  const p = defaultPolicy();
  p.outbound.destinationAllowlist = venueAllowlist();
  p.sentences = renderSentences(p);
  return p;
}

export type Harness = {
  dataDir: string;
  svc: ReturnType<typeof createProposalService>;
  store: Store;
  audit: Audit;
  ledger: Ledger;
  eventTypes(): string[];
};

export type HarnessOptions = {
  rails?: Rail[];
  policy?: Policy;
  // USDC the verifier holds for us, priced at a dollar. Default 100.
  intentsUsdc?: number;
  // null: the ledger has no verifier read at all.
  intents?: IntentsRead | null;
  // The chain holdings the snapshot carries: the demo fixture's, or none, which is what a live
  // refresh writes (src/ledger/index.ts keeps chain wallets as transit and reads nothing).
  holdings?: 'demo' | 'none';
  // Extra deps handed straight to the service.
  deps?: Partial<ProposalDeps>;
};

export function makeCtx(over: HarnessOptions = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-proposals-'));
  const cfg: AppConfig = {
    mode: 'live',
    port: 4177,
    addresses: { evm: [SELF_EVM], solana: [], near: [] },
    candleProducts: [],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };

  const demo = loadDemoLedger();
  const snapshot: LedgerSnapshot = { ...demo, mode: 'live', holdings: over.holdings === 'none' ? [] : demo.holdings };
  const intents = (): IntentsRead | undefined => {
    if (over.intents === null) return undefined;
    if (over.intents !== undefined) return over.intents;
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      holdings: [
        {
          accountId: SELF_EVM.toLowerCase(),
          assetId: ETH_USDC_FLAVOR,
          symbol: 'USDC',
          originChain: 'eth',
          amount: over.intentsUsdc ?? 100,
          decimals: 6,
        },
      ],
    };
  };
  const ledger: Ledger = {
    snapshot: () => snapshot,
    intents,
    hyperliquid: () => undefined,
    refresh: async () => snapshot,
  };

  savePolicy(dataDir, over.policy ?? seededPolicy());
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const table = new Map((over.rails ?? []).map((r) => [r.kind, r]));

  const svc = createProposalService({
    cfg,
    audit,
    store,
    ledger,
    riskRows,
    rails: { for: (draft) => table.get(draft.kind) ?? null, kinds: () => [...table.keys()].filter(isRailKind) },
    dataDir,
    ...over.deps,
  });

  return {
    dataDir,
    svc,
    store,
    audit,
    ledger,
    eventTypes: () => audit.tail(200).map((e) => e.type).reverse(),
  };
}
