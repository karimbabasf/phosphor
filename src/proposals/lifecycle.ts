// The proposal lifecycle and the spend budget: what a proposal is when it is made, what a human
// click does to it, and the one-at-a-time rule that makes the session cap mean anything.
//
// This file is the leaf of src/proposals: draft.ts, rails.ts and execute.ts all read from it and
// it reads from none of them. approve() reaches execution through `ctx.execute`, wired by the
// service in src/proposals.ts, so the executor can live in its own file without a cycle.

import crypto from 'node:crypto';
import type {
  AppConfig,
  ClientKey,
  LedgerSnapshot,
  Policy,
  PolicyPatch,
  Proposal,
  RiskRow,
  SimulationResult,
  Verdict,
  WriteDraft,
} from '../types.ts';
import type { Audit } from '../audit.ts';
import type { Store } from '../store.ts';
import type { Ledger } from '../ledger/index.ts';
import { classify } from '../composition.ts';
import { buildWallet } from '../wallet.ts';
import { evaluate } from '../policy/engine.ts';
import type { EngineCtx } from '../policy/engine.ts';
import { loadPolicy } from '../policy/file.ts';
import { isLocked } from '../keystore/index.ts';
import type { Keystore } from '../keystore/store.ts';
import type { VaultRelay, VaultResult } from '../vault/relay.ts';
import { reasonFor } from '../vault/reason.ts';
import type { RailRegistry } from '../rails/index.ts';
import type { TradeDeps } from '../trade/rail.ts';
import type { OneClickLookup, VenueCredited } from './reconcile.ts';
import { withReservation } from './reservation.ts';

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
  dataDir: string;
  rails?: RailRegistry; // src/rails/index.ts; absent means no rail can execute
  // The plan runner and the venue facts a plan is priced against. Absent means no trade can
  // be proposed, which is demo mode and every test that builds a service without one.
  trade?: TradeDeps;
  onChange?: () => void;
  // How a 1Click order is re-checked by its quote handle, for reconcile. Wired from the intents
  // client in src/main.ts; absent means no venue lookup and reconcile falls back to the chain.
  oneClickStatus?: OneClickLookup;
  /* Whether the venue on the far side of a 1Click order shows the money: for a Hyperliquid
     deposit, the account's own record of the credit. 1Click's SUCCESS is the solver's delivery,
     not the venue's credit, and reconcile refuses to call a deposit executed on the first alone.
     Wired from the venue ledger in src/main.ts; absent leaves such a row unconfirmed for a person. */
  venueCredited?: VenueCredited;
  /* The enclave relay and the keystore it opens, for the click-tier touch. Absent in tests and
     in a bare `npm run app`, where approve behaves exactly as it did before the enclave: the
     wallet is opened by password and a click is a click. */
  vault?: VaultRelay;
  keystore?: Keystore;
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
      forbiddenIssuers: [...base.composition.forbiddenIssuers],
    },
    sentences: [...base.sentences],
  };

  const o = patch.outbound;
  if (o) {
    if (o.maxPerTransactionUsd !== undefined) next.outbound.maxPerTransactionUsd = o.maxPerTransactionUsd;
    if (o.maxPerSessionUsd !== undefined) next.outbound.maxPerSessionUsd = o.maxPerSessionUsd;
    if (o.humanClickAboveUsd !== undefined) next.outbound.humanClickAboveUsd = o.humanClickAboveUsd;
    if (o.autoApproveDailyUsd !== undefined) next.outbound.autoApproveDailyUsd = o.autoApproveDailyUsd;
    if (o.destinationAllowlist !== undefined) next.outbound.destinationAllowlist = o.destinationAllowlist.map(a => a.toLowerCase());
  }

  const c = patch.composition;
  if (c) {
    if (c.maxIssuerShare !== undefined) next.composition.maxIssuerShare = { ...c.maxIssuerShare };
    if (c.maxFreezableShare !== undefined) next.composition.maxFreezableShare = c.maxFreezableShare;
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
  dataDir: string;
  rails: RailRegistry;
  trade?: TradeDeps;
  stables: Set<string>;
  notify: () => void;
  execute: (p: Proposal) => Promise<Proposal>;
  /* land() from execute.ts, wired by the service for the same reason `execute` is: this file is
     the leaf of the directory and importing the module that imports it would be a cycle. */
  land: (p: Proposal) => Promise<Proposal>;
  // How a 1Click order is re-checked by its quote handle. Optional: absent falls back to the
  // chain lookup, which is demo mode and every test that does not drive the venue path.
  oneClickStatus?: OneClickLookup;
  // Whether the far venue shows the money a 1Click order delivered. Optional: absent leaves a
  // Hyperliquid deposit 1Click calls SUCCESS unconfirmed rather than deciding it.
  venueCredited?: VenueCredited;
  vault?: VaultRelay;
  keystore?: Keystore;
  // finishTouch, serialised by the service like approve is, so the continuation of a click
  // never interleaves with another proposal's execution.
  afterTouch: (id: string, result: VaultResult) => Promise<Proposal | null>;
  /* Every rail still running, by proposal id, each resolving with the row it recorded. A propose
     returns the `executing` row and this is how a caller who wants the settled one waits for it
     with a cap (settled, below), and how the shutdown drain knows a rail is still out. */
  inflight: Map<string, Promise<Proposal>>;
};

/* The row once it is terminal, or the row as it stands when `capMs` runs out. The caller reads
   `status` to tell the two apart: `executing` past the cap means the rail is still working and
   proposal_status is where the answer will appear. Never throws for a slow rail; only for an id
   the store does not hold. */
export async function settled(ctx: PCtx, id: string, capMs: number): Promise<Proposal> {
  const run = ctx.inflight.get(id);
  if (run !== undefined) {
    await Promise.race([
      run.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => setTimeout(resolve, capMs).unref()),
    ]);
  }
  const p = ctx.store.get(id);
  if (p === undefined) throw new Error(`unknown proposal ${id}`);
  return p;
}

export function persist(ctx: PCtx, p: Proposal): Proposal {
  ctx.store.put(p);
  ctx.notify();
  return p;
}

// ---------- the outcome, in the words an agent may repeat ----------
//
// Five words, and the assistant reporting a proposal uses one of them and nothing else. Four
// of them are execution outcomes: `confirmed` (the move ran and the balance shows it),
// `settling` (the venue confirmed and the balance has not shown it yet, so nothing more is
// signed), `failed` (nothing moved, or the sentence says what did), `unconfirmed` (the move
// was started and its outcome is not known; it must not be sent again). `pending` is a
// proposal nobody has executed. The sentence beside the word is plain and carries the row's
// own detail, so "failed" is never invented for a row that is settling.

export type OutcomeState = 'confirmed' | 'settling' | 'failed' | 'unconfirmed' | 'pending';

export type ProposalOutcome = {
  state: OutcomeState;
  sentence: string;
  // The pocket the money moved through, in USD, either side of the move. Null is "not read",
  // never zero.
  beforeUsd: number | null;
  afterUsd: number | null;
  // The same two numbers in the asset's own units when the rail read them itself.
  pocket: { venue: 'intents' | 'hyperliquid'; symbol: string; before: string; after: string | null } | null;
};

// The plan a trade proposal armed, as the runner holds it: the entry's fate lives there.
export type PlanFate = {
  status: 'idea' | 'waiting' | 'placed' | 'open' | 'done';
  endReason?: string;
  confirm?: { state: 'filled' | 'resting' | 'canceled' | 'rejected' | 'unconfirmed'; venueStatus: string | null };
};

const LEAD: Record<OutcomeState, string> = {
  confirmed: 'Confirmed.',
  settling: 'Settling: the venue confirmed the move and the balance has not shown it yet. Nothing more is signed until it does.',
  failed: 'Failed.',
  unconfirmed: 'Unconfirmed: the move was started and its outcome is not known yet. Do not send it again; read it again instead.',
  pending: 'Not executed yet.',
};

function unitsOf(base: string, decimals: number): string {
  const digits = base.replace(/^-/, '').padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${base.startsWith('-') ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

function tradeState(plan: PlanFate): { state: OutcomeState; sentence: string } {
  if (plan.status === 'waiting') return { state: 'confirmed', sentence: 'Confirmed. The plan is armed and waiting for its conditions; no order is placed yet.' };
  if (plan.status === 'open') return { state: 'confirmed', sentence: 'Confirmed. The entry filled and the position is open with its exits resting.' };
  if (plan.status === 'placed') {
    const c = plan.confirm;
    if (c === undefined) return { state: 'unconfirmed', sentence: `${LEAD.unconfirmed} The entry was sent and the venue has not been read back for it yet.` };
    if (c.state === 'unconfirmed') return { state: 'unconfirmed', sentence: `${LEAD.unconfirmed} The venue did not answer for the entry inside the read-back window; the order may exist.` };
    return { state: 'confirmed', sentence: `Confirmed. The venue reports the entry ${c.venueStatus ?? c.state}.` };
  }
  if (plan.status === 'done') {
    const reason = plan.endReason ?? 'closed';
    if (reason.startsWith('failed:')) return { state: 'failed', sentence: `${LEAD.failed} ${reason.slice('failed:'.length)}` };
    if (reason === 'cancelled' || reason === 'expired') return { state: 'failed', sentence: `${LEAD.failed} The plan ended ${reason} and no position was taken.` };
    return { state: 'confirmed', sentence: `Confirmed. The trade ran and ended ${reason}.` };
  }
  return { state: 'pending', sentence: `${LEAD.pending} The plan is an idea and has no authority.` };
}

export function outcomeOf(p: Proposal, plan?: PlanFate | null): ProposalOutcome {
  const detail = p.result?.detail ?? '';
  const pocket =
    p.pocket === undefined
      ? null
      : {
          venue: p.pocket.venue,
          symbol: p.pocket.symbol,
          before: unitsOf(p.pocket.before, p.pocket.decimals),
          after: p.pocket.after === null ? null : unitsOf(p.pocket.after, p.pocket.decimals),
        };
  const money = { beforeUsd: p.balances?.beforeUsd ?? null, afterUsd: p.balances?.afterUsd ?? null, pocket };

  let state: OutcomeState;
  let sentence: string;
  switch (p.status) {
    case 'executed':
      if (p.kind === 'trade' && plan !== undefined && plan !== null) {
        ({ state, sentence } = tradeState(plan));
      } else {
        state = 'confirmed';
        sentence = `${LEAD.confirmed} ${detail}`.trim();
      }
      break;
    case 'needs_reconciliation':
      // A settling row carries the pocket the rail read; a row the boot sweep stranded does
      // not, and for that one the honest word is unconfirmed.
      state = p.pocket !== undefined ? 'settling' : 'unconfirmed';
      sentence = `${LEAD[state]} ${detail}`.trim();
      break;
    case 'executing':
      state = 'unconfirmed';
      sentence = `${LEAD.unconfirmed} The rail is still running.`;
      break;
    case 'failed':
      state = 'failed';
      sentence = `${LEAD.failed} ${detail}`.trim();
      break;
    case 'refused':
    case 'policy_refused':
      state = 'failed';
      sentence = `${LEAD.failed} The proposal was refused${p.status === 'policy_refused' ? ' by policy' : ''} and nothing was signed.`;
      break;
    default:
      state = 'pending';
      sentence = `${LEAD.pending} The proposal is ${p.status.replace(/_/g, ' ')}.`;
  }
  return { state, sentence, ...money };
}

/* The address book this app owns: the keystore's own addresses first, because the key is the
   truth and a config entry can go stale, then whatever config.local.json lists. A wallet made
   in the window writes no config.local.json at all, and until 2026-09-16 every proposal builder
   read the book from config alone, so a brand new user could deposit and then never swap, send
   or withdraw: "We hold no EVM address" on the first thing they asked for. */
export function ownBook(ctx: PCtx): { evm: string[] } {
  const own = ctx.keystore?.addressReport().addresses.evm;
  const evm: string[] = typeof own === 'string' && own.trim() !== '' ? [own] : [];
  // A demo owns nothing but its fixture: a developer's config.local.json beside the repo
  // must not become the demo's identity, or a test drafts from the real wallet's address.
  const configured = ctx.cfg.mode === 'demo' ? undefined : ctx.cfg.addresses.evm;
  if (configured !== undefined && !evm.some((x) => x.toLowerCase() === configured.toLowerCase())) evm.push(configured);
  return { evm };
}

// Addresses we own: the book above, plus the account the verifier read names, which is how a
// demo ledger (no keystore, no config) still knows whose money it shows.
export function selfAddresses(ctx: PCtx): string[] {
  const set = new Set<string>();
  for (const a of ownBook(ctx).evm) set.add(a.toLowerCase());
  const read = ctx.ledger.intents();
  for (const h of read?.holdings ?? []) set.add(h.accountId.toLowerCase());
  return [...set];
}

export function buildCtx(ctx: PCtx, snapshot: LedgerSnapshot, policy: Policy | null): EngineCtx {
  return {
    policy,
    composition: classify(buildWallet(snapshot, ctx.ledger.intents(), ctx.ledger.hyperliquid()).rows, ctx.riskRows),
    riskRows: ctx.riskRows,
    sessionSpentUsd: sessionSpentUsd(ctx),
    autoApprovedSpentUsd: autoApprovedSpentUsd(ctx),
    selfAddresses: selfAddresses(ctx),
  };
}

export function newProposal(kind: WriteDraft['kind'], draft: WriteDraft, simulation: SimulationResult | null, verdict: Verdict, clientKey?: ClientKey): Proposal {
  return {
    id: crypto.randomUUID(),
    kind,
    createdAt: nowIso(),
    status: 'pending',
    draft,
    simulation,
    verdict,
    // On the row from its first write, so a repeat carrying the key finds it whatever happened
    // to the process in between.
    ...(clientKey === undefined ? {} : { clientKey }),
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

  /* AN ENCLAVE WALLET ASKS FOR A FINGER, every time, open or shut. The click is recorded as
     awaiting_touch and the enclave is asked to unwrap the data key with a dialog that names this
     move; finishTouch (below) takes it from there when the shell answers. Not awaited: approve
     runs inside the service's serialiser, and a person can take a minute to reach for the
     sensor. What the dialog says is composed from the draft's fields, never from the agent. */
  if (enclaveGated(ctx)) {
    const waiting = persist(ctx, { ...p, verdict, status: 'awaiting_touch' });
    ctx.audit.append('proposal_created', `${id} was approved by click and is waiting for Touch ID`, { id });
    void ctx.vault!.ask({ op: 'unwrap', id: `approve:${id}`, reason: reasonFor(p), ...ctx.keystore!.enclaveRequest() }).then(
      (result) => ctx.afterTouch(id, result),
      () => ctx.afterTouch(id, { ok: false, error: 'relay', message: 'the relay failed' }),
    );
    return waiting;
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

/* True when this backend has an enclave wallet AND a shell relaying to the enclave. Either
   half missing means the password path, which needs no relay and asks nothing. */
export function enclaveGated(ctx: PCtx): boolean {
  return ctx.vault !== undefined && ctx.keystore !== undefined && ctx.vault.attached() && ctx.keystore.custody() === 'secure-enclave';
}

/* The second half of an enclave-gated approval: the shell has answered. A data key opens the
   wallet (which also lifts anything parked as pending_unlock, through releaseQueued's rules,
   not through this one) and this proposal alone goes to approved and executes. Anything else
   (a cancelled dialog, a relay that died, a key that did not open the file) puts the proposal
   back to pending with the reason in the audit log: the click is not lost, and nothing has
   been signed. */
export async function finishTouch(ctx: PCtx, id: string, result: VaultResult): Promise<Proposal | null> {
  // A data key that arrives with nowhere to go is wiped here; unlockWithDataKey is the only other
  // place that wipes it, and every path that does not reach it must.
  const drop = (): void => {
    if (result.ok && result.op === 'unwrap') result.dek.fill(0);
  };
  const current = ctx.store.get(id);
  if (current === undefined || current.status !== 'awaiting_touch') {
    drop();
    return null;
  }
  if (!result.ok) {
    ctx.audit.append('proposal_created', `${id} goes back to pending: the Touch ID did not complete (${result.error})`, { id, error: result.error });
    return persist(ctx, { ...current, status: 'pending' });
  }
  if (result.op !== 'unwrap' || ctx.keystore === undefined) {
    drop();
    ctx.audit.append('proposal_created', `${id} goes back to pending: the enclave answered the wrong thing`, { id });
    return persist(ctx, { ...current, status: 'pending' });
  }
  const opened = ctx.keystore.unlockWithDataKey(result.dek);
  if (!opened.ok) {
    ctx.audit.append('proposal_created', `${id} goes back to pending: the data key did not open the wallet (${opened.error})`, { id, error: opened.error });
    return persist(ctx, { ...current, status: 'pending' });
  }
  const approved = persist(ctx, { ...current, status: 'approved', decidedBy: 'human', decidedAt: nowIso() });
  ctx.audit.append('approved', `human approved ${current.kind} proposal ${id} with Touch ID`, { id, totalUsd: totalUsdOf(current.draft), touch: true });
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
       the row lands `pending` and the human sees the list. The old mandate override in land()
       made the same argument: a $30 cap is not a small spend, it is an unattended trader with a
       $30 cap. A backlog is the same shape. */
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

/* WHAT THE ROLLING 24 HOUR CAP CHARGES FOR, in one predicate, read by both the number on screen
   and the number a proposal is refused against. Two copies of this is how a gauge comes to read
   "at the limit" while the thing enforcing it disagrees.

   Everything that moved funds or is moving them right now, which is every kind except a policy
   change. Written as an exclusion so a rail added later counts by default: an inclusion list
   would leave the new kind silently unbudgeted.

   'executing' counts, and that was the original fix. Counting only 'executed' meant a proposal
   was invisible to the cap for the whole duration of an on-chain send, and nothing serialises
   proposal handling, so N proposals arriving together were each evaluated against a spend of 0.
   Demonstrated: five concurrent $10,000 consolidations moved $50,000 against a $25,000 cap.

   'needs_reconciliation' counts ONLY when the row carries a transaction hash, and the two halves
   of that are different facts. With a hash, money left the wallet: a three-leg send that broke on
   the third leg lands here, and it used to land `failed` and charge nothing, so $2,000 could
   leave against a budget that recorded $0. Without a hash, the app genuinely does not know
   whether anything moved, and a row it cannot speak for must not hold a day's budget hostage:
   one crash used to eat the whole window with no surface to clear it from.

   Over-counting a send that later turns out to have failed costs a refusal the human can retry.
   Under-counting one that succeeded costs the cap itself. */
function countsAgainstCap(p: Proposal): boolean {
  if (p.kind === 'policy_change') return false;
  if (p.status === 'executed' || p.status === 'executing') return true;
  if (p.status !== 'needs_reconciliation') return false;
  // A hash, or the evidence a rail leaves when it never got one: a handle for a signed intent
  // or an ambiguous venue send, a nonce for an ambiguous Hyperliquid action. Each is money that
  // may be live at the venue, and a budget that forgot it is the under-count that let a retry
  // spend twice. A row with none of them is the app not knowing, and holds nothing.
  const evidence = p.result?.evidence;
  return (p.result?.txids?.length ?? 0) > 0 || evidence?.handle !== undefined || evidence?.nonce !== undefined;
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
    // One predicate, shared with dailyLimit above. These two used to spell out the same filter
    // separately, which is how the figure on screen and the figure a proposal is refused against
    // come to disagree.
    .filter(countsAgainstCap)
    .filter(p => {
      const at = Date.parse(p.decidedAt ?? p.createdAt);
      return Number.isFinite(at) && at >= cutoff;
    })
    .reduce((sum, p) => sum + totalUsdOf(p.draft), 0);
}

/* The auto-approved slice of the same window: the same 24h and the same "money moved or is
   moving" predicate as sessionSpentUsd, but only rows a policy 'allow' executed, never a human
   click. It is what the engine's auto-approved daily ceiling budgets on, so a stream of
   sub-threshold moves the human never saw is bounded by something smaller than the session cap.
   A human-approved move does not count: the person already made that decision at the card. */
export function autoApprovedSpentUsd(ctx: PCtx): number {
  const cutoff = Date.now() - SESSION_WINDOW_MS;
  return ctx.store
    .list()
    .filter(countsAgainstCap)
    .filter(p => p.decidedBy === 'policy')
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
