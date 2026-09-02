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
import { isLocked } from '../keystore/index.ts';
import type { RailRegistry } from '../rails/index.ts';
import type { TxLookup } from './reconcile.ts';
import { withReservation } from './reservation.ts';

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

  /* A LOCKED WALLET QUEUES A CLICK TOO. land() has checked this since the queue existed and the
     approve path had no equivalent, so a proposal a person approved after the wallet auto-locked
     was persisted `executing`, the signer threw "the wallet is locked", and the row landed
     `failed`, which is terminal. The work was thrown away and the sentence blamed the wallet.
     It sits after the engine on purpose: a proposal the policy now refuses is refused whether or
     not there is a key to sign it with. */
  if (isLocked()) {
    ctx.audit.append('proposal_created', `${id} was approved while the wallet was locked, so it is waiting to be unlocked`, { id });
    return persist(ctx, { ...p, verdict, status: 'pending_unlock' });
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
   Oldest first, so the order the agent asked in is the order the owner sees.

   EACH ROW IS RE-READ AND CLAIMED BEFORE IT IS LANDED, and that pair is the fix for a double
   send. This loop awaits land() per row and each of those ends in a network wait of up to
   thirty seconds, so a person who clicks Unlock, sees nothing happen for a minute and clicks
   again used to start a second release over the rows this one had not reached: they were all
   still pending_unlock, and land() takes the proposal it is handed without ever reading the
   stored status. Two sends, one intent.
   The list at the top is therefore a plan, not an authority. The authority is the row on disk
   at the moment it is its turn, and it is rewritten to `pending` with no await in between, so
   no second reader can see it as queued. Node runs one thing at a time: read then write with
   nothing suspended between them is atomic, and that is the whole mechanism. */
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
    // Anything a human refused, or another release already took, is somebody else's now.
    const current = ctx.store.get(p.id);
    if (current === undefined || current.status !== 'pending_unlock') continue;

    const verdict = evaluate(current.draft, buildCtx(ctx, snapshot, policy));
    // Back to pending, because land() reads the status of nothing but writes one: this is what
    // keeps a released proposal from carrying the queued status into execution, and it is what
    // claims the row.
    const claimed = persist(ctx, { ...current, status: 'pending', verdict });
    ctx.audit.append('proposal_created', `${p.id} was re-decided after the wallet was unlocked: ${verdict.outcome}`, {
      id: p.id,
      verdict,
    });

    /* AN UNLOCK IS NOT AN APPROVAL, and an allow that would have executed on its own waits here
       for a click instead.
       The click threshold is a rule about how much money ONE action moves, and it was never a
       statement about a batch. A queue released by an unlock is not one small spend: it is every
       sub-threshold proposal an agent filed while the app was shut, executing together on one
       keystroke, up to the day's whole cap, with nobody having seen any of them. A person types
       their password to read a balance or receive funds; that is what they consented to.
       Nothing is refused and no work is thrown away, which is the property the queue exists for:
       the row lands `pending` and the human sees the list. This app already makes the same
       argument for a mandate, in land(): a $30 cap is not a small spend, it is an unattended
       trader with a $30 cap. A backlog is the same shape. */
    if (verdict.outcome === 'allow') {
      ctx.audit.append('proposal_created', `${p.id} was queued while the wallet was locked, so it waits for a click rather than running on the unlock`, {
        id: p.id,
      });
      released += 1;
      continue;
    }

    await ctx.land(claimed);
    released += 1;
  }
  return released;
}

export async function refuse(ctx: PCtx, id: string): Promise<Proposal> {
  const p = requirePending(ctx, id, 'refuse');
  ctx.audit.append('refused', `human refused ${p.kind} proposal ${id}`, { id });
  return persist(ctx, { ...p, status: 'refused', decidedBy: 'human', decidedAt: nowIso() });
}

/* The rolling 24h cap, as the window shows it.
   `spentUsd` is the same figure the engine budgets on, so the number a person reads and the
   number a proposal is refused against cannot drift. `resetsAt` is when the OLDEST counted spend
   leaves the window, which is when capacity next returns: the cap does not empty at midnight and
   a screen that implied it did would be wrong every day.

   It survives a restart because it never lived in memory. sessionSpentUsd derives from
   proposals.json on every call, and that file is durable (src/fsatomic.ts) and refuses to read as
   empty when it is damaged (src/store.ts). The two failures that COULD have lost it are closed
   elsewhere; this is the read that depends on them. */
type DailyLimit = { capUsd: number; spentUsd: number; resetsAt: string | null };

function countsAgainstCap(p: Proposal): boolean {
  // 'needs_reconciliation' is deliberately absent, and task 4 says why: a row the app cannot
  // say moved money must not hold the budget hostage for a day.
  return (p.status === 'executed' || p.status === 'executing') && p.kind !== 'policy_change';
}

export function dailyLimit(ctx: PCtx, capUsd: number): DailyLimit {
  const cutoff = Date.now() - SESSION_WINDOW_MS;
  const counted = ctx.store
    .list()
    .filter(countsAgainstCap)
    .map(p => ({ at: Date.parse(p.decidedAt ?? p.createdAt), usd: totalUsdOf(p.draft) }))
    .filter(row => Number.isFinite(row.at) && row.at >= cutoff);

  const oldest = counted.reduce<number | null>((min, row) => (min === null || row.at < min ? row.at : min), null);
  return {
    capUsd,
    spentUsd: counted.reduce((sum, row) => sum + row.usd, 0),
    resetsAt: oldest === null ? null : new Date(oldest + SESSION_WINDOW_MS).toISOString(),
  };
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
type Serialiser = {
  <T>(fn: () => Promise<T>): Promise<T>;
  // Resolves when everything queued as of the call has finished, however it finished. Used by
  // shutdown: work already in flight gets to write its row before the process ends. Nothing new
  // can be queued behind it during a drain, because the HTTP surface is already refusing.
  //
  // NOT the same as "the queue is free". The queue moves on at the reservation; this waits for
  // the whole job, which is what a shutdown actually needs.
  idle(): Promise<void>;
};

export function createSerialiser(): Serialiser {
  // What the next caller waits on: the queue ahead of it reaching ITS reservation.
  let chain: Promise<unknown> = Promise.resolve();
  // What a shutdown waits on: every job still running, reserved or not.
  const outstanding = new Set<Promise<unknown>>();

  const serialise = function <T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const reserved = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Both arms run fn, so one rejection does not wedge the queue for everything after it.
    const start = (): Promise<T> => withReservation(release, fn);
    const run = chain.then(start, start);

    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    outstanding.add(settled);
    void settled.then(() => outstanding.delete(settled));

    /* The cut. The next caller starts as soon as this one has its budget on disk, or as soon as
       it finishes without reserving anything. A rail waiting five minutes on a venue no longer
       holds the door that a human's refuse has to come through. */
    chain = Promise.race([reserved, settled]);
    return run;
  } as Serialiser;

  serialise.idle = async (): Promise<void> => {
    // Loops because a job can queue another as it finishes. It terminates because the HTTP
    // surface is already refusing new writes by the time a shutdown calls this, and the caller
    // caps the whole wait anyway.
    while (outstanding.size > 0) {
      await Promise.all([...outstanding]);
    }
  };
  return serialise;
}
