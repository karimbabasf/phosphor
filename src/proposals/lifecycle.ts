// The proposal lifecycle and the spend budget: what a proposal is when it is made, what a human
// click does to it, and the one-at-a-time rule that makes the session cap mean anything.
//
// This file is the leaf of src/proposals: draft.ts, rails.ts and execute.ts all read from it and
// it reads from none of them. approve() reaches execution through `ctx.execute`, wired by the
// service in src/proposals.ts, so the executor can live in its own file without a cycle.

import crypto from 'node:crypto';
import type {
  AppConfig,
  ChainId,
  LedgerSnapshot,
  Policy,
  PolicyPatch,
  Proposal,
  Quoter,
  RiskRow,
  Signer,
  SimulationResult,
  Verdict,
  WriteDraft,
} from '../types.ts';
import type { Audit } from '../audit.ts';
import type { Store } from '../store.ts';
import type { Ledger } from '../ledger/index.ts';
import { classify } from '../composition.ts';
import { evaluate } from '../policy/engine.ts';
import type { EngineCtx } from '../policy/engine.ts';
import { loadPolicy } from '../policy/file.ts';
import type { RailRegistry } from '../rails/index.ts';
import type { TxLookup } from './reconcile.ts';

export const ALL_CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const EVM_CHAINS: ChainId[] = ['eth', 'base', 'arb'];
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

// A registry with no rails in it. Fail closed: a wiring layer that forgets to pass one
// gets every rail proposal refused with a reason, not a rail picked by guesswork.
export const NO_RAILS: RailRegistry = { for: () => null, kinds: () => [] };

export type ProposalDeps = {
  cfg: AppConfig;
  audit: Audit;
  store: Store;
  ledger: Ledger;
  riskRows: RiskRow[];
  quoter: Quoter;
  signer: Signer;
  dataDir: string;
  rails?: RailRegistry; // src/rails/index.ts; absent means no rail can execute
  onChange?: () => void;
  // How a recorded transaction hash is checked against the chain, for reconcile. Defaulted to
  // the viem readers the rails already use; a test hands in a fake so the four outcomes can be
  // driven without a network.
  txLookup?: TxLookup;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function money(usd: number): string {
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function amount(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function pct(share: number): string {
  return (share * 100).toFixed(2) + '%';
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function totalUsdOf(draft: WriteDraft): number {
  if (draft.kind === 'consolidate') return draft.totalUsd;
  if (draft.kind === 'transfer') return draft.leg.amountUsd;
  if (draft.kind === 'policy_change') return 0;
  // Every rail draft carries its own amountUsd, which is what the engine budgets on. A
  // non-finite one never executes (the engine refuses it), so it contributes nothing here.
  return Number.isFinite(draft.amountUsd) ? draft.amountUsd : 0;
}

// Symbols the app prices at exactly 1.0. The risk table is already the app's register of
// what a dollar stable is, so this reads it rather than keeping a second list to drift.
export function stableSymbols(rows: RiskRow[]): Set<string> {
  return new Set(rows.map(r => r.symbol.toUpperCase()));
}

// Same dust rule as cost.ts: below the economic transfer size, or below 3x what it costs to
// move anything off that chain. Kept local because cost.ts does not export the predicate.
export function dustThreshold(snapshot: LedgerSnapshot, chain: ChainId, cfg: AppConfig): number {
  const transferCostUsd = snapshot.gas[chain]?.transferCostUsd ?? 0;
  return Math.max(cfg.economicTransferUsd, 3 * transferCostUsd);
}

// Copies only the fields a PolicyPatch is allowed to carry. A spread would let a hostile patch
// smuggle unknown keys into policy.json, so every field is named.
export function mergePatch(base: Policy, patch: PolicyPatch): Policy {
  const next: Policy = {
    version: base.version,
    killSwitch: base.killSwitch,
    outbound: { ...base.outbound },
    composition: {
      maxIssuerShare: { ...base.composition.maxIssuerShare },
      maxFreezableShare: base.composition.maxFreezableShare,
      minNativeGasUsd: { ...base.composition.minNativeGasUsd },
      forbiddenIssuers: [...base.composition.forbiddenIssuers],
    },
    sentences: [...base.sentences],
  };

  const o = patch.outbound;
  if (o) {
    if (o.maxPerTransactionUsd !== undefined) next.outbound.maxPerTransactionUsd = o.maxPerTransactionUsd;
    if (o.maxPerSessionUsd !== undefined) next.outbound.maxPerSessionUsd = o.maxPerSessionUsd;
    if (o.humanClickAboveUsd !== undefined) next.outbound.humanClickAboveUsd = o.humanClickAboveUsd;
    if (o.destinationAllowlist !== undefined) next.outbound.destinationAllowlist = o.destinationAllowlist.map(a => a.toLowerCase());
  }

  const c = patch.composition;
  if (c) {
    if (c.maxIssuerShare !== undefined) next.composition.maxIssuerShare = { ...c.maxIssuerShare };
    if (c.maxFreezableShare !== undefined) next.composition.maxFreezableShare = c.maxFreezableShare;
    if (c.minNativeGasUsd !== undefined) next.composition.minNativeGasUsd = { ...c.minNativeGasUsd };
    if (c.forbiddenIssuers !== undefined) next.composition.forbiddenIssuers = [...c.forbiddenIssuers];
  }

  return next;
}

/* Everything the four files read. It is the ProposalDeps the caller passed plus the two pieces
   the service derives (the rail registry, defaulted, and the set of symbols this app prices at a
   dollar) and two indirections: `notify` is the caller's onChange, and `execute` is the executor
   in execute.ts, wired by createProposalService so approve() can reach it without this file
   importing the module that imports this one. */
export type PCtx = {
  cfg: AppConfig;
  audit: Audit;
  store: Store;
  ledger: Ledger;
  riskRows: RiskRow[];
  quoter: Quoter;
  signer: Signer;
  dataDir: string;
  rails: RailRegistry;
  stables: Set<string>;
  notify: () => void;
  execute: (p: Proposal) => Promise<Proposal>;
  /* land() from execute.ts, wired by the service for the same reason `execute` is: this file is
     the leaf of the directory and importing the module that imports it would be a cycle. */
  land: (p: Proposal) => Promise<Proposal>;
  // How a recorded transaction hash is checked against the chain, for reconcile. Same
  // indirection for a different reason: it is a seam, so a test can drive the four outcomes
  // without a network.
  txLookup: TxLookup;
};

export function persist(ctx: PCtx, p: Proposal): Proposal {
  ctx.store.put(p);
  ctx.notify();
  return p;
}

// Addresses we own: whatever the ledger reports holdings for, plus anything configured.
export function selfAddresses(ctx: PCtx, snapshot: LedgerSnapshot): string[] {
  const set = new Set<string>();
  for (const h of snapshot.holdings) set.add(h.address.toLowerCase());
  for (const a of [...ctx.cfg.addresses.evm, ...ctx.cfg.addresses.solana, ...ctx.cfg.addresses.near]) set.add(a.toLowerCase());
  return [...set];
}

// Where a consolidation lands. eth, base and arb share one evm address, so a holding on any
// of them names the recipient on the others.
export function recipientFor(ctx: PCtx, chain: ChainId, snapshot: LedgerSnapshot): string | null {
  const onChain = snapshot.holdings.find(h => h.chain === chain);
  if (onChain) return onChain.address;

  if (EVM_CHAINS.includes(chain)) {
    const sibling = snapshot.holdings.find(h => EVM_CHAINS.includes(h.chain));
    if (sibling) return sibling.address;
    return ctx.cfg.addresses.evm[0] ?? null;
  }
  if (chain === 'sol') return ctx.cfg.addresses.solana[0] ?? null;
  return ctx.cfg.addresses.near[0] ?? null;
}

export function buildCtx(ctx: PCtx, snapshot: LedgerSnapshot, policy: Policy | null): EngineCtx {
  return {
    policy,
    composition: classify(snapshot, ctx.riskRows),
    ledger: snapshot,
    sessionSpentUsd: sessionSpentUsd(ctx),
    selfAddresses: selfAddresses(ctx, snapshot),
  };
}

export function newProposal(kind: WriteDraft['kind'], draft: WriteDraft, simulation: SimulationResult | null, verdict: Verdict): Proposal {
  return {
    id: crypto.randomUUID(),
    kind,
    createdAt: nowIso(),
    status: 'pending',
    draft,
    simulation,
    verdict,
  };
}

export function requirePending(ctx: PCtx, id: string, action: string): Proposal {
  const p = ctx.store.get(id);
  if (!p) {
    ctx.audit.append('approve_attempt_rejected', `${action} for unknown proposal ${id}`, { id, action });
    throw new Error(`unknown proposal ${id}`);
  }
  if (p.status !== 'pending') {
    ctx.audit.append('approve_attempt_rejected', `${action} for proposal ${id} which is ${p.status}, not pending`, { id, action, status: p.status });
    throw new Error(`proposal ${id} is not pending (status ${p.status})`);
  }
  return p;
}

export async function approve(ctx: PCtx, id: string): Promise<Proposal> {
  const p = requirePending(ctx, id, 'approve');

  // Re-run the engine at approval time: the policy file, the kill switch and the balances
  // can all have moved since the proposal was created, and the older verdict is only ever a
  // statement about the world as it was then.
  const snapshot = ctx.ledger.snapshot();
  const policy = loadPolicy(ctx.dataDir);
  const verdict = evaluate(p.draft, buildCtx(ctx, snapshot, policy));
  if (verdict.outcome === 'refuse') {
    ctx.audit.append('policy_refused', `${id} refused at approval time: ${verdict.rule}`, { id, rule: verdict.rule, reasons: verdict.reasons });
    return persist(ctx, { ...p, verdict, status: 'policy_refused', decidedBy: 'policy', decidedAt: nowIso() });
  }

  const approved = persist(ctx, { ...p, verdict, status: 'approved', decidedBy: 'human', decidedAt: nowIso() });
  ctx.audit.append('approved', `human approved ${p.kind} proposal ${id}`, { id, totalUsd: totalUsdOf(p.draft) });
  // Through the context rather than a direct import: execute.ts reads from this file, so calling
  // it by name here would make the two modules a cycle. createProposalService wires it.
  return ctx.execute(approved);
}

/* Everything queued while the wallet was locked, decided now.
   Re-EVALUATED rather than replayed. The proposals were ruled on against the policy, the kill
   switch and the balances as they stood when the agent asked, and an unlock can be hours later:
   a rule the owner tightened in between has to bind, and money that has since moved has to be
   what the size check reads. So each one goes back through the engine and then through land(),
   which is the same door a fresh proposal uses. A queued proposal that is now too large simply
   lands pending; one the policy now refuses is refused, with the reason recorded.
   Oldest first, so the order the agent asked in is the order the owner sees. */
export async function releaseQueued(ctx: PCtx): Promise<number> {
  const waiting = ctx.store
    .list()
    .filter((p) => p.status === 'pending_unlock')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (waiting.length === 0) return 0;

  const snapshot = ctx.ledger.snapshot();
  const policy = loadPolicy(ctx.dataDir);
  let released = 0;
  for (const p of waiting) {
    const verdict = evaluate(p.draft, buildCtx(ctx, snapshot, policy));
    ctx.audit.append('proposal_created', `${p.id} was re-decided after the wallet was unlocked: ${verdict.outcome}`, {
      id: p.id,
      verdict,
    });
    // Back to pending first, because land() reads the status of nothing but writes one: this
    // is what keeps a released proposal from carrying the queued status into execution.
    await ctx.land({ ...p, status: 'pending', verdict });
    released += 1;
  }
  return released;
}

export async function refuse(ctx: PCtx, id: string): Promise<Proposal> {
  const p = requirePending(ctx, id, 'refuse');
  ctx.audit.append('refused', `human refused ${p.kind} proposal ${id}`, { id });
  return persist(ctx, { ...p, status: 'refused', decidedBy: 'human', decidedAt: nowIso() });
}

export function sessionSpentUsd(ctx: PCtx): number {
  const cutoff = Date.now() - SESSION_WINDOW_MS;
  return ctx.store
    .list()
    // Everything that moved funds OR is moving them right now, which is every kind except
    // a policy change. Written as an exclusion so a rail added later counts against the
    // session cap by default: an inclusion list would leave the new kind silently
    // unbudgeted.
    //
    // 'executing' counts, and that is the whole fix. Counting only 'executed' meant a
    // proposal was invisible to the cap for the entire duration of an on-chain send, and
    // nothing serialises proposal handling: node:http runs them concurrently and there is
    // no queue anywhere. So N proposals arriving together each evaluated against a spend
    // of 0 and all N executed. Demonstrated: five concurrent $10,000 consolidations moved
    // $50,000 against a $25,000 session cap, and the window's width tracks send latency,
    // so a slower chain is a wider hole.
    //
    // Committed-but-unconfirmed money is spent for budgeting purposes. Over-counting a
    // send that later fails costs a refusal the human can retry; under-counting one that
    // succeeds costs the cap itself.
    // `needs_reconciliation` is deliberately NOT here. A row the app cannot say moved money is
    // a row that must not hold the budget hostage: one crash used to eat the 24h cap for the
    // whole window, and the human had no surface to clear it from. It is reported instead.
    .filter(p => (p.status === 'executed' || p.status === 'executing') && p.kind !== 'policy_change')
    .filter(p => {
      const at = Date.parse(p.decidedAt ?? p.createdAt);
      return Number.isFinite(at) && at >= cutoff;
    })
    .reduce((sum, p) => sum + totalUsdOf(p.draft), 0);
}


// Every path that can spend runs one at a time.
//
// Counting 'executing' against the session cap is necessary but not sufficient on its own:
// a proposal is only marked executing after it has already been evaluated, so two arriving
// together could both read the same spend figure and both be allowed before either
// reserved anything. node:http handles requests concurrently and nothing else in this
// process serialises them, so that window was real. Demonstrated before this existed:
// five concurrent $10,000 consolidations moved $50,000 against a $25,000 cap.
//
// A promise chain is the whole mechanism. It makes "read the spend, decide, reserve" one
// indivisible step, which is what a budget needs to mean anything. Throughput is not a
// concern here: these operations end in a chain send, a human click, or both.
export type Serialiser = {
  <T>(fn: () => Promise<T>): Promise<T>;
  // Resolves when everything queued as of the call has finished, however it finished. Used by
  // shutdown: work already in flight gets to write its row before the process ends. Nothing new
  // can be queued behind it during a drain, because the HTTP surface is already refusing.
  idle(): Promise<void>;
};

export function createSerialiser(): Serialiser {
  let chain: Promise<unknown> = Promise.resolve();
  const serialise = function <T>(fn: () => Promise<T>): Promise<T> {
    // Both arms run fn, so one rejection does not wedge the queue for everything after it.
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  } as Serialiser;
  serialise.idle = (): Promise<void> =>
    chain.then(
      () => undefined,
      () => undefined,
    );
  return serialise;
}
