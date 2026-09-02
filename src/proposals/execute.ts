// Execution: the single exit for a freshly evaluated proposal, the one route from approved to
// the thing that runs it, and the four ways a proposal actually moves.
//
// The deposit-address check in here is the one that closes the gap between approval and
// signing: proposals persist to disk as JSON in between, so the quote a leg carries at send
// time is not necessarily the one the human saw.

import type { Proposal, Rail, RailResult, TransferLeg } from '../types.ts';
import { loadPolicy, savePolicy } from '../policy/file.ts';
import { renderSentences } from '../policy/render.ts';
import { isRailKind } from '../rails/index.ts';
import { isLocked } from '../keystore/index.ts';
import { errText, mergePatch, money, nowIso, persist, totalUsdOf } from './lifecycle.ts';
import { reservationMade } from './reservation.ts';
import { within } from '../shutdown.ts';
import type { PCtx } from './lifecycle.ts';

// Single exit for a freshly evaluated proposal. This is the only place a proposal can become
// executed without a human, and only on verdict allow.
export async function land(ctx: PCtx, p: Proposal): Promise<Proposal> {
  // Arming a bot is never auto-approved, and 'allow' is the path that has to be closed.
  //
  // The carve-out further down covers needs_approval, which is what a LARGE mandate produces.
  // A small one comes back 'allow' because it sits under the click threshold, and the first
  // live arm went straight to executed with nobody having clicked anything. The threshold is
  // a rule about how much money one action moves, and a mandate does not move money when it
  // is approved: it grants standing authority to move money later, repeatedly, with no human
  // in the loop. A $30 cap is not a small spend, it is an unattended trader with a $30 cap.
  //
  // So the outcome is downgraded here rather than in the engine, which stays a pure function
  // of policy and draft, and the reason is recorded so the human reads why it is waiting.
  if (p.kind === 'mandate_arm' && p.verdict.outcome === 'allow') {
    p = {
      ...p,
      verdict: {
        outcome: 'needs_approval',
        reasons: [...p.verdict.reasons, 'Arming a bot always needs a human click, whatever the size.'],
      },
    };
  }

  if (p.verdict.outcome === 'refuse') {
    const refused: Proposal = { ...p, status: 'policy_refused', decidedBy: 'policy', decidedAt: nowIso() };
    ctx.audit.append('proposal_created', `${p.kind} proposal ${p.id} refused by policy: ${p.verdict.rule}`, {
      id: p.id,
      verdict: p.verdict,
    });
    ctx.audit.append('policy_refused', `${p.verdict.rule}: ${p.verdict.reasons[p.verdict.reasons.length - 1]}`, {
      id: p.id,
      rule: p.verdict.rule,
      reasons: p.verdict.reasons,
    });
    return persist(ctx, refused);
  }

  ctx.audit.append('proposal_created', `${p.kind} proposal ${p.id}: ${p.verdict.outcome}`, {
    id: p.id,
    verdict: p.verdict,
    totalUsd: totalUsdOf(p.draft),
  });

  /* A LOCKED WALLET QUEUES, it never refuses. The proposal has been drafted, priced, simulated
     and ruled on; the only thing missing is a signature, and the person who can produce one is
     the person who will read this proposal anyway. Refusing here would throw away all of that
     work and, worse, would teach the owner that locking the app breaks their assistant, which
     is how a lock ends up switched off.
     It sits ahead of both remaining outcomes on purpose. An 'allow' must not execute while
     locked because there is no key to sign with, and a 'needs_approval' must not sit in the
     pending list either, because a human clicking approve on a locked wallet would get a
     failure rather than a transaction. Both are re-decided at unlock, against the policy as it
     stands then. */
  if (isLocked()) {
    ctx.audit.append('proposal_created', `${p.id} is waiting for the wallet to be unlocked`, { id: p.id });
    return persist(ctx, { ...p, status: 'pending_unlock' });
  }

  if (p.verdict.outcome === 'needs_approval') {
    // Nothing reserved and nothing left to do: a pending proposal does not count against the
    // cap, so the queue has no reason to keep waiting on this one.
    reservationMade();
    // Above the click threshold nothing decides but a person. There is no exemption:
    // no flag, no environment and no proposal kind reaches execution from here without
    // a click on a surface the agent cannot open. The product's central claim is that
    // an agent cannot approve its own actions, and this is the line that holds it.
    return persist(ctx, p);
  }

  // allow: under the click threshold, so the policy itself is the decision maker.
  const allowed = persist(ctx, { ...p, status: 'approved', decidedBy: 'policy', decidedAt: nowIso() });
  return executeApproved(ctx, allowed);
}

// The one route from an approved proposal to the thing that runs it. Both entry points
// (the auto-allow path above and the human approve() below) come through here, so the
// registry is consulted once rather than in a switch copied per call site.
export async function executeApproved(ctx: PCtx, p: Proposal): Promise<Proposal> {
  if (p.draft.kind === 'policy_change') return applyPolicyChange(ctx, p);

  const rail = ctx.rails.for(p.draft);
  if (rail !== null) return executeRail(ctx, p, rail);

  if (isRailKind(p.draft.kind)) {
    // A rail draft with no rail behind it. Reachable when a proposal outlives the process
    // that made it and the app comes back up in a mode that owns no rails; running it as a
    // fund move would report a zero-leg success and move nothing.
    const detail = `no ${p.draft.kind} rail is wired in ${ctx.cfg.mode} mode, so nothing was sent`;
    ctx.audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id });
    return persist(ctx, { ...p, status: 'failed', result: { ok: false, detail } });
  }

  return executeFundMove(ctx, p);
}

/* The wallet total the app currently believes, in USD. Synchronous: the snapshot is memory the
   refresh loop fills, so this costs nothing and never waits. */
export function walletUsd(ctx: PCtx): number {
  return ctx.ledger.snapshot().holdings.reduce((sum, h) => sum + h.usd, 0);
}

/* The balance after the move, once the chains have actually been re-read.
   Taking a snapshot the instant the rail returns would report the numbers that were on screen
   BEFORE the move, because the ledger is a poll and the poll has not run yet. So the refresh is
   awaited, bounded, and a failure reports null rather than a number that would be wrong.
   This runs outside the one-at-a-time queue (the reservation was released when the row was
   written), so nobody waits behind it. */
export async function balanceAfter(ctx: PCtx): Promise<number | null> {
  const refreshed = await within(BALANCE_REFRESH_CAP_MS, ctx.ledger.refresh());
  return refreshed ? walletUsd(ctx) : null;
}

// Long enough for five chains of RPC reads that each carry a 10 s deadline of their own, short
// enough that a receipt is not held open on a provider having a bad day.
const BALANCE_REFRESH_CAP_MS = 15_000;

export async function executeRail(ctx: PCtx, p: Proposal, rail: Rail): Promise<Proposal> {
  const beforeUsd = walletUsd(ctx);
  const executing = persist(ctx, { ...p, status: 'executing', balances: { beforeUsd, afterUsd: null } });
  /* The budget is now on disk and sessionSpentUsd counts it, so the next caller can safely read,
     decide and reserve. Everything below is a network wait with no shared state in it. Before
     this the whole rail ran inside the queue, and a rail in watchStatus held every approve and
     refuse in the app for up to five minutes. */
  reservationMade();

  let result: RailResult;
  try {
    result = await rail.execute(p.draft);
  } catch (err) {
    // A rail that throws has said nothing about whether it sent anything, so its message
    // is passed through as-is rather than summarised into "failed".
    result = { ok: false, detail: `${p.draft.kind} rail threw: ${errText(err)}` };
  }

  const txids = result.txids ?? [];
  const balances = { beforeUsd, afterUsd: await balanceAfter(ctx) };
  if (!result.ok) {
    ctx.audit.append('execution_failed', `${p.id}: ${result.detail}`, { id: p.id, txids });
    return persist(ctx, { ...executing, status: 'failed', balances, result: { ok: false, detail: result.detail, txids } });
  }
  ctx.audit.append('executed', `${p.id}: ${result.detail}`, { id: p.id, txids });
  return persist(ctx, { ...executing, status: 'executed', balances, result: { ok: true, detail: result.detail, txids } });
}

export function legKey(leg: TransferLeg): string {
  return `${leg.fromChain}->${leg.toChain}:${leg.symbol}`;
}

// Where a leg's funds are ACTUALLY sent. For a 1Click quote this is a deposit address the
// solver minted, not leg.to: the solver takes delivery here and pays out to leg.to itself.
// That is inherent to intent bridging and is not the bug. The bug was that the policy
// engine's destination rule checks leg.to while this value is what gets signed, so the
// control reported a guarantee about an address nobody looked at.
export function depositAddressFor(leg: TransferLeg): string {
  const raw = leg.quote?.raw as { quote?: { depositAddress?: string } } | undefined;
  return raw?.quote?.depositAddress ?? leg.to;
}

// Captured at propose time so the human approves a concrete destination, and so execution
// has something to compare against. Only legs that actually have a venue-chosen address
// appear: a leg falling back to leg.to is already governed by the allowlist.
export function depositAddressesOf(legs: TransferLeg[]): Array<{ leg: string; address: string }> {
  const out: Array<{ leg: string; address: string }> = [];
  for (const leg of legs) {
    const address = depositAddressFor(leg);
    if (address !== leg.to) out.push({ leg: legKey(leg), address });
  }
  return out;
}

// The check that closes the gap. Proposals persist to disk as JSON between approval and
// execution, so the quote a leg carries at send time is not necessarily the one the human
// saw. Anything that edits that file, or any refetch, would otherwise redirect the funds
// silently. Compare what we are about to sign against what was recorded when the proposal
// was made, and refuse on any difference rather than guessing which one is right.
export function depositAddressMismatch(p: Proposal, legs: TransferLeg[]): string | null {
  const approved = p.simulation?.depositAddresses;
  if (approved === undefined) return null; // nothing venue-chosen in this proposal

  const now = depositAddressesOf(legs);
  if (now.length !== approved.length) {
    return `deposit addresses changed since approval: ${approved.length} recorded, ${now.length} now`;
  }
  for (const record of approved) {
    const current = now.find(n => n.leg === record.leg);
    if (current === undefined) return `leg ${record.leg} no longer carries the approved deposit address`;
    if (current.address.toLowerCase() !== record.address.toLowerCase()) {
      return `leg ${record.leg} would now send to a different address than the one approved`;
    }
  }
  return null;
}

export async function executeFundMove(ctx: PCtx, p: Proposal): Promise<Proposal> {
  const legs = p.draft.kind === 'consolidate' ? p.draft.legs : p.draft.kind === 'transfer' ? [p.draft.leg] : [];
  const beforeUsd = walletUsd(ctx);
  const executing = persist(ctx, { ...p, status: 'executing', balances: { beforeUsd, afterUsd: null } });
  // As executeRail: reserved, so the queue moves on and the sends below run outside it.
  reservationMade();

  if (ctx.cfg.mode === 'demo') {
    for (const leg of legs) ctx.ledger.applyDemoTransfer(leg);
    const detail = `moved ${money(totalUsdOf(p.draft))} across ${legs.length} leg(s) in demo mode`;
    ctx.audit.append('executed', `${p.id}: ${detail}`, { id: p.id, legs: legs.length });
    /* The demo ledger has already moved, so the receipt can say what it moved to. This branch
       returned without balances and kept { beforeUsd, afterUsd: null } off the executing row, so
       every demo receipt read "balance after: unknown" about a transfer that plainly happened. */
    const balances = { beforeUsd, afterUsd: await balanceAfter(ctx) };
    return persist(ctx, { ...executing, status: 'executed', balances, result: { ok: true, detail } });
  }

  if (!ctx.signer.ready) {
    // The auth step Karim does last. Nothing is signed, nothing is lost.
    const detail = ctx.signer.describe();
    ctx.audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id });
    return persist(ctx, { ...executing, status: 'failed', result: { ok: false, detail } });
  }

  // Refuse before signing anything if the destination is no longer what was approved.
  const mismatch = depositAddressMismatch(p, legs);
  if (mismatch !== null) {
    ctx.audit.append('execution_failed', `${p.id}: ${mismatch}`, { id: p.id });
    return persist(ctx, { ...executing, status: 'failed', result: { ok: false, detail: mismatch } });
  }

  const failures: string[] = [];
  const txids: string[] = [];
  for (const leg of legs) {
    try {
      const res = await ctx.signer.send(leg, depositAddressFor(leg));
      if (res.ok) txids.push(res.txid ?? '(no txid)');
      else failures.push(`${leg.fromChain} -> ${leg.toChain}: ${res.error ?? 'unknown error'}`);
    } catch (err) {
      failures.push(`${leg.fromChain} -> ${leg.toChain}: ${errText(err)}`);
    }
  }

  const balances = { beforeUsd, afterUsd: await balanceAfter(ctx) };
  if (failures.length > 0) {
    const detail = failures.join('; ');
    ctx.audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id, txids });
    return persist(ctx, { ...executing, status: 'failed', balances, result: { ok: false, detail, txids } });
  }

  const detail = `sent ${legs.length} leg(s): ${txids.join(', ')}`;
  ctx.audit.append('executed', `${p.id}: ${detail}`, { id: p.id, txids });
  return persist(ctx, { ...executing, status: 'executed', balances, result: { ok: true, detail, txids } });
}

export async function applyPolicyChange(ctx: PCtx, p: Proposal): Promise<Proposal> {
  if (p.draft.kind !== 'policy_change') return p;
  const current = loadPolicy(ctx.dataDir);
  if (!current) {
    const detail = 'policy file became unreadable before the change could be applied';
    ctx.audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id });
    return persist(ctx, { ...p, status: 'failed', result: { ok: false, detail } });
  }

  const patched = mergePatch(current, p.draft.patch);
  patched.version = current.version + 1;
  // The policy the human reads is always the deterministic render of the policy that is
  // actually in force. The agent's own wording stays in the proposal and the audit trail,
  // where it is clearly the agent talking, and never becomes the displayed rule.
  patched.sentences = renderSentences(patched);
  savePolicy(ctx.dataDir, patched);

  ctx.audit.append('policy_changed', `${p.id}: policy now at version ${patched.version}`, {
    id: p.id,
    patch: p.draft.patch,
    agentSentence: p.draft.sentence,
    before: current.sentences,
    after: patched.sentences,
  });

  const detail = `policy updated to version ${patched.version}`;
  ctx.audit.append('executed', `${p.id}: ${detail}`, { id: p.id });
  return persist(ctx, { ...p, status: 'executed', result: { ok: true, detail } });
}
