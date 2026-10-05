// Execution: the single exit for a freshly evaluated proposal, the one route from approved to
// the thing that runs it, and the two ways a proposal actually moves (a rail, or a policy file).

import type { Preflight, Proposal, Rail, RailEvidence, RailHooks, RailResult, SimulationResult, VaultTopUpDraft, VaultTopUpParams, Verdict, WriteDraft } from '../types.ts';
import type { PocketRead } from '../ledger/settle.ts';
import { SETTLING_SENTENCE } from '../ledger/settle.ts';
import { loadPolicy, savePolicyChecked } from '../policy/file.ts';
import { evaluate } from '../policy/engine.ts';
import { renderSentences } from '../policy/render.ts';
import { isLocked } from '../keystore/index.ts';
import { baseUnitsToDecimal, decimalToBaseUnits } from '../intents.ts';
import { railAccounts } from '../intents-sign.ts';
import { createAllowanceSweep } from '../rails/allowance-sweep.ts';
import type { AllowanceSweep } from '../rails/allowance-sweep.ts';
import { VAULT_TOP_UP_COUNTERPARTY } from '../rails/vault-topup.ts';
import { SWEEP_MARGIN, amountWords, moveSpend, shortfallOf, shortfallSentence } from '../vault/allowance.ts';
import type { CoinAmount } from '../vault/allowance.ts';
import { AGENTS_WAIT_SAID, agentsWait, buildCtx, errText, mergePatch, newProposal, nowIso, persist, totalUsdOf, enclaveGated } from './lifecycle.ts';
import { priceOf } from './draft.ts';
import { reservationMade } from './reservation.ts';
import { within } from '../shutdown.ts';
import { buildWallet } from '../wallet.ts';
import { OUTSIDE_REASON, WEB_READ_REASON } from '../web-read.ts';
import { APP_TURN_REASON } from '../app-turn.ts';
import type { PCtx } from './lifecycle.ts';
import { TERMINAL, deadlineAtOf, stageOf } from './view.ts';
import type { ProposalStage } from './view.ts';
import { ReasonError, reasonOf } from '../rails/reasons.ts';

// Single exit for a freshly evaluated proposal. This is the only place a proposal can become
// executed without a human, and only on verdict allow.
export async function land(ctx: PCtx, p: Proposal): Promise<Proposal> {
  // Collateral leaving the venue always waits for a click. A withdrawal under the threshold is
  // small money, but it is the one direction in which an autonomous agent could hurt a
  // trading account (Karim's call, 2026-09-11: always a click, whatever the size), and the
  // rail already refuses it under any open position. Recorded here for the same reason as
  // the engine staying a pure function of policy and draft.
  if (p.kind === 'hl_withdraw' && p.verdict.outcome === 'allow') {
    p = {
      ...p,
      verdict: {
        outcome: 'needs_approval',
        reasons: [...p.verdict.reasons, 'Collateral leaving the venue always needs a human click, whatever the size.'],
      },
    };
  }
  // A balance leaving for somebody else, likewise, whether it stays inside the verifier
  // (intents_send) or is paid out on a chain (intents_pay). There is no allowlist for a
  // receiver since 2026-09-17: the click and the Touch ID sentence that name the address ARE
  // the gate, so nothing here may execute on the policy's word alone, at any size.
  if ((p.kind === 'intents_send' || p.kind === 'intents_pay') && p.verdict.outcome === 'allow') {
    p = {
      ...p,
      verdict: {
        outcome: 'needs_approval',
        reasons: [...p.verdict.reasons, 'Money leaving for another address always needs a human click, whatever the size.'],
      },
    };
  }
  /* A MOVE BIGGER THAN THE ALLOWANCE WAITS FOR A CLICK, whatever its size, and its card says why:
     the difference moves from the vault first, behind the vault's own Touch ID (the shortfall step,
     executeRail below). The allowance is the most a move with no click may take (PHASE2-PLAN.md
     section 1). Judged on the ledger's last read of the allowance; an unread one is left to the
     rail's own live read, which refuses a balance it cannot see. */
  const over = overAllowance(ctx, p.draft);
  if (over !== null) p = { ...p, verdict: askedFor(p.verdict, over) };
  // And any move an agent the app did not spawn asked for before the person allowed it in the
  // window: it reads with its own tools, where this app cannot look (src/agents.ts). Ahead of the
  // web-read check, which such a seat also trips, because this reason says what to do about it.
  if (p.verdict.outcome === 'allow' && p.outside === true) {
    p = { ...p, verdict: { outcome: 'needs_approval', reasons: [...p.verdict.reasons, OUTSIDE_REASON] } };
  }
  // And any move the chat's agent asked for after it read the web in that session: a page can
  // talk an agent into a move. The row's own stamp, taken when it was asked for (src/web-read.ts).
  if (p.verdict.outcome === 'allow' && p.webRead === true) {
    p = { ...p, verdict: { outcome: 'needs_approval', reasons: [...p.verdict.reasons, WEB_READ_REASON] } };
  }
  // And any move asked for inside a turn the app started, every kind: nobody asked for that turn,
  // so nobody may be at the window to see what it files (src/app-turn.ts). The row's own stamp.
  if (p.verdict.outcome === 'allow' && p.appTurn === true) {
    p = { ...p, verdict: { outcome: 'needs_approval', reasons: [...p.verdict.reasons, APP_TURN_REASON] } };
  }
  // And nothing an agent asked for while the vault moves, whatever the verdict (lifecycle.ts agentsWait).
  if (p.by !== undefined && p.verdict.outcome !== 'refuse' && agentsWait(ctx)) {
    p = { ...p, verdict: { outcome: 'refuse', reasons: [...p.verdict.reasons, AGENTS_WAIT_SAID], rule: 'vault_moving', reasonCodes: ['vault_moving'] } };
  }
  /* AND FREEZE IS READ AGAIN FOR AN ALLOW, with nothing awaited between this and the executing
     write. The verdict a caller hands in was taken before its simulation, seconds of quotes and
     reads, and Freeze pressed in those seconds used to let the move run on the old answer
     (re-audit R-L1). The two rules every allow answers to, whoever ruled it (the engine, or
     landFree for a change that only takes risk off). */
  if (p.verdict.outcome === 'allow') {
    const policy = loadPolicy(ctx.dataDir);
    if (policy === null) {
      p = { ...p, verdict: { outcome: 'refuse', reasons: [...p.verdict.reasons, 'The policy file became unreadable while this was checked, so nothing was sent.'], rule: 'policy_unreadable' } };
    } else if (policy.killSwitch) {
      p = { ...p, verdict: { outcome: 'refuse', reasons: [...p.verdict.reasons, 'Freeze was pressed while this was checked, so nothing was sent.'], rule: 'kill_switch' } };
    }
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
  /* ONE EXCEPTION, for the enclave wallet: a needs_approval proposal sits in the pending list
     even while locked, because on that wallet the click IS the unlock. Approve puts up a Touch
     ID dialog that opens the wallet and approves this one proposal in the same motion, so a
     person clicking on a locked enclave wallet gets a dialog, not a failure. An 'allow' still
     parks, for the reason above: there is no key to sign with until somebody touches. */
  if (isLocked() && !(p.verdict.outcome === 'needs_approval' && enclaveGated(ctx))) {
    ctx.audit.append('proposal_created', `${p.id} is waiting for the wallet to be unlocked`, { id: p.id });
    return persist(ctx, { ...p, status: 'pending_unlock' });
  }

  if (p.verdict.outcome === 'needs_approval') {
    // Nothing reserved and nothing left to do: a pending proposal does not count against the
    // cap, so the queue has no reason to keep waiting on this one. The pending_unlock branch
    // above returns before reaching this line and reserves nothing either, for the same reason
    // and not by oversight: a queued proposal has not spent anything.
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

  // A rail draft with no rail behind it. Reachable when a proposal outlives the process that
  // made it and the app comes back up in a mode that owns no rails (demo), and for any kind
  // still on disk that no rail answers for any more. Nothing is sent.
  const detail = `no ${p.draft.kind} rail is wired in ${ctx.cfg.mode} mode, so nothing was sent`;
  ctx.audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id });
  return persist(ctx, { ...p, status: 'failed', result: { ok: false, detail } });
}

/* Which pocket a draft moves money through. The intents rails read the verifier, the
   Hyperliquid rails the trading account; anything else is valued as the wallet total. */
function pocketOf(draft: WriteDraft | undefined): 'intents' | 'hyperliquid' | null {
  switch (draft?.kind) {
    case 'swap':
    case 'intents_send':
    case 'intents_pay':
      return 'intents';
    case 'hl_deposit':
    case 'hl_withdraw':
    case 'trade':
      return 'hyperliquid';
    default:
      return null;
  }
}

/* The balance the receipt is about, in USD, off the ledger's last read: the intents pocket for
   an intents rail, the trading account for a Hyperliquid rail, the wallet total (as the panel
   shows it, priced the same way) for anything else, and for a pocket the ledger has never
   read (demo mode, which signs nothing). Synchronous: the reads are memory the refresh loop
   fills.

   This used to sum `snapshot().holdings`, which is always empty on a live ledger (the money
   sits inside the verifier and the trading account, see src/ledger/index.ts), so every live
   receipt said 0 before and 0 after.
   A read that failed is null, not zero: a balance the app could not read is a different fact
   from nothing held, and the receipt says "not read" rather than printing $0 for money that
   is there. */
function pocketUsd(ctx: PCtx, draft: WriteDraft | undefined): number | null {
  const venue = pocketOf(draft);
  const intents = ctx.ledger.intents();
  const hyperliquid = ctx.ledger.hyperliquid();
  const wallet = buildWallet(ctx.ledger.snapshot(), intents, hyperliquid);
  if (venue === null) {
    return (intents !== undefined && !intents.ok) || (hyperliquid !== undefined && !hyperliquid.ok) ? null : wallet.totalUsd;
  }
  const read = venue === 'intents' ? intents : hyperliquid;
  if (read === undefined) return wallet.totalUsd;
  if (!read.ok) return null;
  return wallet.rows.filter((r) => r.kind === venue).reduce((sum, r) => sum + r.valueUsd, 0);
}

/* The rail's own read, priced. A dollar stable (the risk table is the register) and the
   venue's USDC are their amount; a gas asset is priced off the ledger's table; anything else
   is null, so the caller falls back to the ledger's figure rather than printing $0 for money
   that is there. */
function pocketPriced(ctx: PCtx, pocket: PocketRead, base: string | null): number | null {
  if (base === null) return null;
  const amount = Number(base) / 10 ** pocket.decimals;
  if (pocket.venue === 'hyperliquid') return amount;
  const upper = pocket.symbol.toUpperCase();
  const symbol = upper === 'WETH' ? 'ETH' : upper;
  if (ctx.stables.has(symbol)) return amount;
  const price = ctx.ledger.snapshot().prices[symbol];
  return typeof price === 'number' && price > 0 ? amount * price : null;
}

// When the ledger's newest read started: the verifier and venue reads carry their own stamp,
// and the snapshot carries the pass's.
function readStamp(ctx: PCtx): number {
  const snapshot = ctx.ledger.snapshot();
  const stamps = [
    Date.parse(snapshot.fetchedAt),
    Date.parse(ctx.ledger.intents()?.fetchedAt ?? ''),
    Date.parse(ctx.ledger.hyperliquid()?.fetchedAt ?? ''),
  ].filter((n) => Number.isFinite(n));
  return stamps.length === 0 ? 0 : Math.max(...stamps);
}

/* The balance after the move, once the pocket has actually been re-read.
   Taking a snapshot the instant the rail returns would report the numbers that were on screen
   BEFORE the move, because the ledger is a poll and the poll has not run yet. So the refresh is
   awaited, bounded, and a failure reports null rather than a number that would be wrong.
   `settledAt` is the bar the read has to clear: a refresh that started before the rail returned
   carries the balance from before the fill whatever the clock said when it answered, so a read
   stamped earlier than the settlement is tried again until one is later or the cap runs out.
   This runs outside the one-at-a-time queue (the reservation was released when the row was
   written), so nobody waits behind it. No draft means the wallet total. */
export async function balanceAfter(ctx: PCtx, draft?: WriteDraft, settledAt?: string): Promise<number | null> {
  const bar = settledAt === undefined ? 0 : Date.parse(settledAt);
  const deadline = Date.now() + BALANCE_REFRESH_CAP_MS;
  while (true) {
    const refreshed = await within(Math.max(1, deadline - Date.now()), ctx.ledger.refresh());
    if (!refreshed) return null;
    if (readStamp(ctx) > bar) return pocketUsd(ctx, draft);
    if (Date.now() + BALANCE_RETRY_MS >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, BALANCE_RETRY_MS).unref());
  }
}

// Long enough for five chains of RPC reads that each carry a 10 s deadline of their own, short
// enough that a receipt is not held open on a provider having a bad day.
const BALANCE_REFRESH_CAP_MS = 15_000;
const BALANCE_RETRY_MS = 1_000;

// A held row is tried again every half minute for a quarter of an hour. Gas surges of the
// 2026-09-15 kind last minutes; a hold that outlives this is not a surge, and the row closes
// with the reason rather than sitting approved for a day with a signature waiting behind it.
export const HELD_RETRY_MS = 30_000;
export const HELD_MAX_MS = 15 * 60_000;

function heldTiming(ctx: PCtx): { retryMs: number; maxMs: number } {
  return { retryMs: ctx.held?.retryMs ?? HELD_RETRY_MS, maxMs: ctx.held?.maxMs ?? HELD_MAX_MS };
}

// The row's checks with one more run on the end, never the same run twice: the rail tells the
// executor through the hook the moment the checks exist and again on its result.
function withPreflight(rows: Preflight[] | undefined, next: Preflight | undefined): Preflight[] | undefined {
  if (next === undefined) return rows;
  const kept = rows ?? [];
  if (kept.some((r) => r.at === next.at)) return kept;
  return [...kept, next];
}

// A row that has moved on from a hold, or never held: the stamp is the hold's alone.
function withoutHold(p: Proposal): Proposal {
  if (p.heldSince === undefined) return p;
  const { heldSince: _heldSince, ...rest } = p;
  return rest;
}

// Two values say the same thing whatever order their keys arrived in.
function sameJson(a: unknown, b: unknown): boolean {
  const sorted = (value: unknown): string =>
    JSON.stringify(value, (_key, v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
        : v,
    );
  return sorted(a) === sorted(b);
}

// What of a rail's evidence goes on the row: everything but the hashes, which have their own
// field. Named so a rail cannot smuggle a stray key into the store through the hook.
function pickEvidence(e: RailEvidence): RailEvidence {
  const out: RailEvidence = {};
  if (e.handle !== undefined) out.handle = e.handle;
  if (e.nonce !== undefined) out.nonce = e.nonce;
  if (e.deadline !== undefined) out.deadline = e.deadline;
  if (e.refundedAmount !== undefined) out.refundedAmount = e.refundedAmount;
  if (e.refundReason !== undefined) out.refundReason = e.refundReason;
  if (e.settledAmountOut !== undefined) out.settledAmountOut = e.settledAmountOut;
  if (e.explorerUrl !== undefined) out.explorerUrl = e.explorerUrl;
  if (e.quote !== undefined) out.quote = e.quote;
  if (e.relayQuote !== undefined) out.relayQuote = e.relayQuote;
  if (e.providerStage !== undefined) out.providerStage = e.providerStage;
  return out;
}

export async function executeRail(ctx: PCtx, p: Proposal, rail: Rail): Promise<Proposal> {
  const beforeUsd = pocketUsd(ctx, p.draft);
  const executing = persist(ctx, { ...p, status: 'executing', balances: { beforeUsd, afterUsd: null } });
  /* The budget is now on disk and sessionSpentUsd counts it, so the next caller can safely read,
     decide and reserve. Everything below is a network wait with no shared state in it. Before
     this the whole rail ran inside the queue, and a rail in watchStatus held every approve and
     refuse in the app for up to five minutes. */
  reservationMade();

  /* THE REPLY IS THE ROW AS IT STANDS, AND THE RAIL RUNS BEHIND IT. This awaited the rail, so
     the propose that started it held its HTTP reply open for the whole watch loop: up to five
     minutes against a proxy that gives up at thirty seconds and told the agent the app was not
     running. On 2026-09-15 "deposit $10" moved $20 that way. The `executing` row is durable, the
     budget is charged, and it is an answer; whoever wants the settled row waits on `inflight`
     with a cap (settled, in lifecycle.ts), and past the cap reads proposal_status. Every exit
     from the run below persists a terminal row, so the promise never rejects and a caller
     racing it never sees a row left `executing` by a throw. */
  return behind(ctx, executing, runRail(ctx, p, rail, executing, beforeUsd));
}

/* Register a run on the inflight map and answer with the executing row. Shared by the rail path
   and the fund move, so both settle behind the same map the propose cap, the settled wait and
   the shutdown drain read. The run's own throws are caught inside it; what is caught here is
   the store or the log refusing the write. The row stays `executing` for the boot sweep, and
   the wait still ends. */
function behind(ctx: PCtx, executing: Proposal, run: Promise<Proposal>): Proposal {
  const settled = run
    .catch((err: unknown) => {
      try {
        ctx.audit.append('error', `${executing.id}: recording the answer failed: ${errText(err)}`, { id: executing.id });
      } catch {
        // the log is what failed
      }
      return ctx.store.get(executing.id) ?? executing;
    })
    .finally(() => ctx.inflight.delete(executing.id));
  ctx.inflight.set(executing.id, settled);
  return executing;
}

/* FREEZE BINDS AT THE SIGNATURE. A rail reads quotes and balances for seconds before its key
   signs, and Freeze pressed in that time used to let the signature through, on a click, a touch
   or no click at all (re-audit R-L1). Every rail asks here as its last step before the key
   (RailHooks.lastCheck), synchronously, so nothing lands between this read and the signature.
   A policy file that will not load reads as frozen, as the engine reads it. */
function refuseIfFrozen(ctx: PCtx): void {
  const policy = loadPolicy(ctx.dataDir);
  if (policy === null) throw new ReasonError('rules_unreadable', 'Your rules could not be read, so nothing was signed.');
  if (policy.killSwitch) throw new ReasonError('kill_switch', 'Everything is frozen, so nothing was signed.');
}

async function runRail(ctx: PCtx, p: Proposal, rail: Rail, executing: Proposal, beforeUsd: number | null): Promise<Proposal> {
  /* THE EVIDENCE IS WRITTEN THE MOMENT IT EXISTS. A rail hands back a handle once the quote is
     taken, a hash once the intent is submitted, a nonce once the action is signed, and each one
     lands on the row here, before the rail's watch loop, so a quit or a crash during the three
     to five minutes of polling leaves a row that can be reconciled rather than one that "may or
     may not have sent". Merged, because a rail reports in pieces; ignored once the row has left
     `executing`, because a late hook must not reopen a decided row. The pocket a rail read
     before the move rides with the first piece, so a row the boot sweep recovers is judged by
     the balance (judgeSettling below) and never by 1Click's word alone. */
  const hooks: RailHooks = {
    decidedBy: p.decidedBy,
    lastCheck: () => {
      refuseIfFrozen(ctx);
      // An agent's move signs nothing while the vault moves (lifecycle.ts agentsWait).
      if (p.by !== undefined && agentsWait(ctx)) throw new ReasonError('vault_moving', AGENTS_WAIT_SAID);
    },
    onEvidence: (e) => {
      const current = ctx.store.get(p.id) ?? executing;
      if (current.status !== 'executing') return;
      const txids = [...new Set([...(current.result?.txids ?? []), ...(e.txids ?? [])])];
      const evidence = { ...current.result?.evidence, ...pickEvidence(e) };
      /* A poll that repeats what the row already says writes nothing: no audit line, no rewrite
         of proposals.json, no frames. Every poll used to do all three (R5, 2026-09-23). */
      const unchanged =
        current.result !== undefined &&
        sameJson(txids, current.result.txids ?? []) &&
        sameJson(evidence, current.result.evidence ?? {}) &&
        (e.pocket === undefined || sameJson(e.pocket, current.pocket));
      if (unchanged) return;
      ctx.audit.append('submitted', `${p.id}: the venue holds the move; evidence recorded before the wait`, { id: p.id, txids, evidence });
      persist(ctx, { ...current, result: { ok: false, detail: 'submitted, waiting for the venue', txids, evidence }, ...(e.pocket === undefined ? {} : { pocket: e.pocket }) });
    },
    // The checks land on the row the moment they exist, before anything is signed, so a
    // process that dies in the wait still shows what was read.
    onPreflight: (checks) => {
      const current = ctx.store.get(p.id) ?? executing;
      if (current.status !== 'executing') return;
      persist(ctx, { ...current, preflight: withPreflight(current.preflight, checks) });
    },
  };

  let result: RailResult;
  // A move bigger than the allowance takes the difference from the vault first, or nothing runs.
  const short = await shortfallStep(ctx, p);
  if (short !== null) result = short;
  else {
    try {
      result = await rail.execute(p.draft, p.id, hooks);
    } catch (err) {
      // A rail that throws has said nothing about whether it sent anything, so its message
      // is passed through as-is rather than summarised into "failed". A rail that knew why it
      // stopped (a balance short of the amount, a price that moved) says so in the code.
      const reason = reasonOf(err);
      result = { ok: false, detail: `${p.draft.kind} rail threw: ${errText(err)}`, ...(reason === undefined ? {} : { reason }) };
    }
  }

  const preflight = withPreflight(ctx.store.get(p.id)?.preflight, result.preflight);
  const checks = preflight === undefined ? {} : { preflight };

  /* THE HOLD. The preflight said wait and the rail signed nothing: no handle, no hash, no
     nonce, nothing at the venue. The row goes back to approved, stamped with when the hold
     began, and the rail runs again in a while. It is a status the card reads, never a
     question: the person already decided, and the app is waiting for the chain. */
  if (result.held === true) return holdRow(ctx, p, executing, rail, result.detail, checks, result.reason);

  /* THE HASH IS THE RECORD. THE BALANCE IS A DECORATION.
     Both used to be written together, after `balanceAfter`, which is up to fifteen seconds of
     RPC reads across five chains. A process that ended inside that window (SIGKILL, Force Quit,
     power loss, or the uncaught-exception handler in src/crash.ts, which exits with no drain)
     had broadcast a transaction and recorded nothing about it: reconcileOnBoot found an
     `executing` row with no txids and could only say "this may or may not have sent", and
     reconcileProposal had nothing to look it up by. Money moved and no hash existed anywhere.
     The shutdown drain does not cover it either; SETTLE_CAP_MS is 32s and a 30s venue write plus
     a 15s refresh is 45s.
     So the durable write happens the instant the rail answers, and the balance is a second
     update afterwards. */
  /* A FAILURE WITH A HASH IS NOT A FAILURE. On 2026-09-15 two $10 deposits came back ok:false
     from 1Click with the intent hash on each, landed `failed`, charged nothing to the day, and
     the receipt said nothing had left the wallet while about $40 had. A hash is evidence that
     money moved; the honest row for it is needs_reconciliation, which counts against the cap
     and can be re-checked. `failed` is kept for the answer that carries no evidence at all. */
  // Merged with what the hooks already wrote: a rail that handed over its handle early and
  // answers with the hash alone has not withdrawn the handle.
  const early = ctx.store.get(p.id)?.result;
  const txids = [...new Set([...(early?.txids ?? []), ...(result.txids ?? [])])];
  const evidence = { ...early?.evidence, ...result.evidence };
  /* A hash is not the only sign that money may have moved. An intent that was signed but whose
     submission was never confirmed leaves a handle and a deadline; an ambiguous Hyperliquid send
     leaves a handle and a nonce; an ambiguous class transfer leaves a nonce alone. None carries
     a hash, every one may be live at the venue, so each is unconfirmed rather than failed. */
  const moved = txids.length > 0 || evidence.handle !== undefined || evidence.nonce !== undefined;
  /* THREE ANSWERS, not two. A rail that watched the venue confirm and the balance not move
     inside its window says `settling`: the intent is signed and submitted, the money is most
     likely a block away, and "failed" would be the word that gets a second copy signed. The
     row lands as needs_reconciliation, which already counts against the cap, already has a
     screen, and is re-judged on every ledger refresh below. */
  const settling = !result.ok && result.settling === true;
  /* AND ONE PROOF THE OTHER WAY. A refund the balance shows back, or a signed transfer that
     never ran and can no longer run, is a move that is over and cost nothing: the row closes as
     failed and charges nobody's day. A balance that merely reads the same is not that proof (a
     same-coin credit hides a transfer that ran, and one that has not run can still run until its
     deadline), so a FAILED swap whose transfer is unspent stays open as venue_failed_watching
     until reconcile sees the deadline pass (the audit of 2026-09-23). */
  const provedNothingLeft = result.reason === 'venue_failed_nothing_moved' || result.reason === 'refunded';
  const unconfirmed = !result.ok && !provedNothingLeft && (moved || settling);
  const status = result.ok ? 'executed' : unconfirmed ? 'needs_reconciliation' : 'failed';
  const settledAt = nowIso();
  ctx.audit.append(
    result.ok ? 'executed' : unconfirmed ? 'execution_unconfirmed' : 'execution_failed',
    `${p.id}: ${settling ? 'settling. ' : ''}${result.detail}`,
    { id: p.id, txids },
  );
  /* THE RAIL'S OWN READS WIN. A rail that read the pocket either side of the move hands the
     numbers over, and the receipt prints those: the same read the rail decided on, not a
     ledger poll taken some seconds before or after. The ledger's figure stands in only where
     the rail took no read of its own. */
  const pocket = result.pocket;
  const exactBefore = pocket === undefined ? null : pocketPriced(ctx, pocket, pocket.before);
  // A settling row has no after yet: the read the rail holds is the balance from BEFORE the
  // move showed, and the receipt says "not re-read" until the read that settles it.
  const exactAfter = pocket === undefined || settling ? null : pocketPriced(ctx, pocket, pocket.after);
  const balances = { beforeUsd: exactBefore ?? beforeUsd, afterUsd: exactAfter };
  const recorded = persist(ctx, {
    ...withoutHold(executing),
    status,
    settledAt,
    result: {
      ok: result.ok,
      detail: result.detail,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      txids,
      ...(Object.keys(evidence).length === 0 ? {} : { evidence }),
    },
    balances,
    ...(pocket === undefined ? {} : { pocket }),
    ...checks,
  });
  if (settling) watchSettling(ctx);
  afterSettledMove(ctx, recorded);

  /* And the decoration is not on the caller's clock either. `balanceAfter` is up to fifteen
     seconds of RPC across every chain, and until now the agent's tool call and the HTTP
     response both sat behind it AFTER the receipt was already durable. Nothing in those
     fifteen seconds could change the outcome, so they were fifteen seconds of a person
     watching a spinner for a number the screen updates on its own anyway.

     It runs detached now. `persist` calls `ctx.notify()`, which is the SSE broadcast the
     window already listens to, so the balance lands on screen when the chains answer. A
     refresh that fails, or a process that exits first, leaves `afterUsd` null, which is the
     same thing it has always meant: the move is recorded, the balance was not read. Skipped
     when the rail's own after-read already answered it, and for a settling row, whose after
     is written by the read that settles it (judgeSettling). */
  if (exactAfter === null && !settling) {
    void balanceAfter(ctx, p.draft, settledAt)
      .then((afterUsd) => {
        if (afterUsd === null) return;
        const current = ctx.store.get(recorded.id) ?? recorded;
        persist(ctx, { ...current, balances: { beforeUsd: balances.beforeUsd, afterUsd } });
      })
      .catch(() => {
        // A decoration that cannot be read is not an error anyone is told about; the row
        // already says afterUsd is null.
      });
  }

  return recorded;
}

// ---------- held rows ----------
//
// Nothing here signs or sends: a held row is an approved row with a stamp, and the only thing
// that moves it is the rail running again with the checks in front of it.

function holdRow(ctx: PCtx, p: Proposal, executing: Proposal, rail: Rail, reason: string, checks: { preflight?: Preflight[] }, code?: string): Proposal {
  const heldSince = executing.heldSince ?? nowIso();
  const heldFor = Math.max(0, Date.now() - Date.parse(heldSince));
  const { retryMs, maxMs } = heldTiming(ctx);
  if (heldFor >= maxMs) return expireHold(ctx, executing, `${reason} Held for ${Math.round(heldFor / 60_000)} min without clearing, so it is closed.`, checks, code);
  ctx.audit.append('execution_held', `${p.id}: ${reason} Trying again in ${Math.round(retryMs / 1000)} s.`, { id: p.id, heldSince });
  const held = persist(ctx, { ...executing, status: 'approved', heldSince, ...checks });
  const timer = setTimeout(() => retryHeld(ctx, held.id, rail), retryMs);
  timer.unref?.();
  return held;
}

/* The hold is over and nothing was signed: a failure with no evidence, charged to nobody, with
   the reason on it. Also what the boot sweep writes for a row held when the process stopped. */
export function expireHold(ctx: PCtx, row: Proposal, detail: string, checks: { preflight?: Preflight[] } = {}, reason?: string): Proposal {
  ctx.audit.append('execution_held_expired', `${row.id}: ${detail}`, { id: row.id, heldSince: row.heldSince });
  return persist(ctx, {
    ...withoutHold(row),
    status: 'failed',
    settledAt: nowIso(),
    result: { ok: false, detail, ...(reason === undefined ? {} : { reason }) },
    ...checks,
  });
}

function retryHeld(ctx: PCtx, id: string, rail: Rail): void {
  const row = ctx.store.get(id);
  if (row === undefined || row.status !== 'approved' || row.heldSince === undefined) return;
  // A hold lasts minutes, and the seal that guards the click guards the retry: the row the
  // rail runs must be the row the human approved, not one rewritten on disk meanwhile. Nothing
  // is written back, and no timer is set again, so the boot sweep is what closes it.
  if (!ctx.store.intact(id)) {
    ctx.audit.append('approve_attempt_rejected', `retry for proposal ${id}, whose row on disk is not the row this app wrote`, { id, action: 'retry', changedOnDisk: true });
    return;
  }
  // The key it would sign with is behind a lock now. Waiting on a person to unlock it is a
  // question, and a hold is not one: the row closes and the ask can be made again.
  if (isLocked()) {
    expireHold(ctx, row, 'The wallet locked while this was waiting for the checks to clear. Nothing was signed; ask again once it is unlocked.');
    return;
  }
  // The policy, the kill switch and the balances can all have moved during the hold, and the
  // click was given against the world as it was then: the engine runs again, as it does at the
  // click itself.
  const verdict = evaluate(row.draft, buildCtx(ctx, ctx.ledger.snapshot(), loadPolicy(ctx.dataDir)));
  if (verdict.outcome === 'refuse') {
    ctx.audit.append('policy_refused', `${id} refused while held: ${verdict.rule}`, { id, rule: verdict.rule, reasons: verdict.reasons });
    persist(ctx, { ...withoutHold(row), verdict, status: 'policy_refused', decidedBy: 'policy', decidedAt: nowIso() });
    return;
  }
  void executeRail(ctx, row, rail);
}

// ---------- settling rows ----------
//
// A row the rail left settling is judged again on every ledger refresh, against the same read
// the wallet panel is about to show. Nothing here signs or sends: the only thing that can
// change the row is a balance that has moved.

/* One listener per proposal service, whatever the number of settling rows: the ledger tells
   it, it sweeps the store. Idempotent, so the executor calls it whenever it lands a settling
   row and the boot path calls it once for the rows found on disk. A ledger without onRefresh
   (the hand-built ones in tests) is simply never heard from. */
const watching = new WeakSet<PCtx>();

export function watchSettling(ctx: PCtx): void {
  if (watching.has(ctx) || ctx.ledger.onRefresh === undefined) return;
  watching.add(ctx);
  ctx.ledger.onRefresh(() => {
    for (const p of ctx.store.list()) {
      if (p.status === 'needs_reconciliation' && p.pocket !== undefined) judgeSettling(ctx, p);
    }
  });
}

/* The pocket's balance as the ledger last read it, in the pocket's base units, or null when
   the ledger has no good read to offer. An intents asset the verifier no longer lists is a
   balance of zero, not a missing read: the enumeration only returns what is held. */
function pocketBalance(ctx: PCtx, pocket: PocketRead): bigint | null {
  if (pocket.venue === 'intents') {
    const read = ctx.ledger.intents();
    if (read === undefined || !read.ok) return null;
    const row = read.holdings.find(
      (h) => h.assetId === pocket.assetId && h.accountId.toLowerCase() === pocket.account.toLowerCase(),
    );
    if (row === undefined) return 0n;
    if (row.amountBase === undefined) return null;
    return BigInt(row.amountBase);
  }
  const read = ctx.ledger.hyperliquid();
  if (read === undefined || !read.ok || read.account.toLowerCase() !== pocket.account.toLowerCase()) return null;
  // The same measure the deposit rail records: free collateral on a unified account, both
  // books on a standard one.
  return BigInt(Math.round((read.unified ? read.availableUsdc : read.collateralUsdc) * 10 ** pocket.decimals));
}

function units(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

/* The three outcomes a later read can give a settling row, the same three the rail gives at
   the moment of the swap: risen by the floor is executed, risen by less is the short fill,
   not risen is still settling and the row is left exactly as it was. Returns the row as it
   stands afterwards. */
export function judgeSettling(ctx: PCtx, p: Proposal): Proposal {
  /* THE STORE'S ROW, NEVER THE CALLER'S. Every caller hands a row it read a moment ago, and the
     one that matters (watchSettling) hands a whole page of them, so a row settled while that
     page was being walked was settled again off the stale copy. With the re-entrant refresh
     below that made it a storm: 820 audit lines for one deposit in 103 ms, the log 2.8 MB in a
     quarter of an hour, and the app answering nothing for 13 s at the exact moment the money
     landed. A settle is idempotent now: the second pass reads `executed` and stops. */
  const row = ctx.store.get(p.id) ?? p;
  const pocket = row.pocket;
  if (row.status !== 'needs_reconciliation' || pocket === undefined) return row;
  const after = pocketBalance(ctx, pocket);
  if (after === null) return row;
  const before = BigInt(pocket.before);
  const floor = BigInt(pocket.floor);
  const delta = after - before;
  if (delta <= 0n) return row;

  const place = pocket.venue === 'intents' ? 'inside intents.near' : 'on the Hyperliquid account';
  const txids = row.result?.txids ?? [];
  // The handle, nonce and quote the rail recorded stay on the row: a settle by the balance adds
  // a verdict, it does not forget what a later question to the venue would go by.
  const kept = row.result?.evidence === undefined ? {} : { evidence: row.result.evidence };
  const settled = { ...pocket, after: after.toString() };
  const balances = {
    beforeUsd: row.balances?.beforeUsd ?? pocketPriced(ctx, settled, settled.before),
    afterUsd: pocketPriced(ctx, settled, settled.after),
  };
  /* THE ROW BEFORE THE LOG LINE, and that order is the rest of the fix above. An audit append
     tells its subscribers, one of them re-reads the ledger, and a ledger that tells its own
     listeners synchronously lands back here (src/main.ts, audit.subscribe -> refreshNow). Logged
     first, the row this was about had not been written yet, so every one of those passes settled
     it again. Written first, the next pass reads `executed` at the top and stops. */
  /* A SHORT RISE IS NOT A SHORT FILL WHILE THE VENUE HAS NOT FAILED THE MOVE. A rise under the
     floor is another credit landing in the same window: on the relay because the diff is
     atomic (the verifier applied exactly the signed credit or nothing), on 1Click because the
     transfer is still routing and an unrelated USDC credit lands first. A row written failed on
     it is a second copy signed while the first is on its way, and the sweep never re-asks a
     failed row. So a settling row has three exits and no fourth: the floor reached confirms
     (below), the venue's own failure word on the row fails it here with that word, and the
     deadline passing stalls it (markStalled). Everything else leaves the row exactly as it was;
     a relay row also takes the verifier's nonce as its verdict (src/proposals/reconcile.ts). */
  if (delta < floor) {
    const word = row.result?.evidence?.providerStage;
    if (word === undefined || !PROVIDER_FAILED.has(word)) return row;
    const detail =
      `The venue reported ${word}, and a later read shows the balance ${place} rose by ${units(delta, pocket.decimals)} ${pocket.symbol}, below the ` +
      `${units(floor, pocket.decimals)} ${pocket.symbol} floor this move was approved with (${units(before, pocket.decimals)} before, ` +
      `${units(after, pocket.decimals)} after). Read the balance for ${pocket.account} before signing another.`;
    const short = persist(ctx, { ...row, status: 'failed', settledAt: nowIso(), pocket: settled, balances, result: { ok: false, detail, reason: 'short_fill', txids, ...kept } });
    ctx.audit.append('execution_failed', `${row.id}: ${detail}`, { id: row.id, txids });
    return short;
  }
  const detail =
    `confirmed on a later read: the balance ${place} rose by ${units(delta, pocket.decimals)} ${pocket.symbol} ` +
    `(${units(before, pocket.decimals)} before, ${units(after, pocket.decimals)} after), at or above the ` +
    `${units(floor, pocket.decimals)} ${pocket.symbol} floor this move was approved with.`;
  const done = persist(ctx, { ...row, status: 'executed', settledAt: nowIso(), pocket: settled, balances, result: { ok: true, detail, txids, ...kept } });
  ctx.audit.append('executed', `${row.id}: ${detail}`, { id: row.id, txids });
  afterSettledMove(ctx, done);
  return done;
}

/* THE ROW SAYS SO ITSELF WHEN IT IS LATE, rather than counting up forever under a word that
   stopped being true. Every money kind carries a deadline of eight times its typical duration
   with a ten minute floor (DEADLINE_SEC), measured from the decision, and a row past it with
   nothing having changed goes to `stalled`.

   IT IS NOT A FAILURE AND IT IS NOT FINAL. Nothing is refunded, nothing is retried, and the
   status underneath is untouched, so the same balance read that would have settled the row
   still settles it: `stalled` is terminal in the sense that the app has stopped expecting the
   venue, and it moves forward to `confirmed` the moment the money shows. Claiming a failure
   here is how a person comes to send a second copy of a move that was merely slow.

   ROWS WAITING ON A PERSON ARE NEVER LATE. A card nobody has clicked is doing exactly what it
   is for, however long it sits there, so the three human stages are skipped by name. */
export function markStalled(ctx: PCtx, now: number = Date.now()): number {
  let marked = 0;
  for (const p of ctx.store.list()) {
    if (p.stalledAt !== undefined) continue;
    /* Only a row that would actually READ as stalled. stageOf returns `stalled` for a row waiting
       on a venue's credit and for nothing else, so stamping an approved or executing row wrote an
       audit line saying a move was late and then changed nothing anybody could see. A row still
       inside its rail is not late in a way this sweep can speak to: the rail's own timeout is
       what lands it, and that is the thing that produces a row this sweep can then judge. */
    if (p.status !== 'needs_reconciliation') continue;
    const stage = stageOf(p);
    if (TERMINAL.has(stage) || WAITS_ON_A_PERSON.has(stage)) continue;
    const deadline = Date.parse(deadlineAtOf(p) ?? '');
    if (!Number.isFinite(deadline) || now <= deadline) continue;
    ctx.audit.append('error', `${p.id}: nothing has changed since ${p.lastChangeAt ?? p.createdAt} and it is past its deadline, so it is marked late`, {
      id: p.id,
      stage,
      deadlineAt: deadlineAtOf(p),
    });
    persist(ctx, { ...p, stalledAt: new Date(now).toISOString() });
    marked += 1;
  }
  return marked;
}

const WAITS_ON_A_PERSON: ReadonlySet<ProposalStage> = new Set<ProposalStage>(['waiting_for_you', 'waiting_for_unlock', 'waiting_for_touch']);

// The vendors' words for a move that ended without delivering: 1Click's two and the relay's
// one. A short rise on a row carrying one of these is the refund or the leftover, and the row
// is failed with the word; on any other word the rise is not this move's and the row waits.
const PROVIDER_FAILED: ReadonlySet<string> = new Set(['FAILED', 'REFUNDED', 'NOT_FOUND_OR_NOT_VALID']);

/* One fresh ledger read, then the judgment above. What the scheduled sweep uses: a balance
   that has not moved writes nothing, so a row can sit settling for days without collecting a
   line per pass or coming back to the dock after a person filed it. */
export async function judgeSettlingNow(ctx: PCtx, id: string): Promise<Proposal> {
  const p = ctx.store.get(id);
  if (p === undefined) throw new Error(`unknown proposal ${id}`);
  if (p.status !== 'needs_reconciliation' || p.pocket === undefined) return p;
  await within(BALANCE_REFRESH_CAP_MS, ctx.ledger.refresh());
  return judgeSettling(ctx, ctx.store.get(id) ?? p);
}

/* The explicit re-check, for a person clicking on the row: the read and judgment above, and a
   row still not risen is told when it was last looked at, so the click visibly did something. */
export async function settleProposal(ctx: PCtx, id: string): Promise<Proposal> {
  const judged = await judgeSettlingNow(ctx, id);
  if (judged.status !== 'needs_reconciliation' || judged.pocket === undefined) return judged;
  const pocket = judged.pocket;
  const after = pocketBalance(ctx, pocket);
  const reading =
    after === null
      ? 'the balance could not be read just now'
      : `${pocket.symbol} for ${pocket.account} reads ${units(after, pocket.decimals)}, not up from ${units(BigInt(pocket.before), pocket.decimals)}`;
  const txids = judged.result?.txids ?? [];
  return persist(ctx, {
    ...judged,
    result: {
      ok: false,
      detail: `${SETTLING_SENTENCE} Re-read at ${nowIso()}: ${reading}.`,
      txids,
      ...(judged.result?.evidence === undefined ? {} : { evidence: judged.result.evidence }),
    },
  });
}

// ---------- the allowance ----------
//
// Once the vault has moved to this Mac's Touch ID key, every rail spends the allowance
// (src/intents-sign.ts) and the vault moves only behind its own Touch ID (src/vault/allowance.ts).
// Three things join that to the proposals: a move bigger than the allowance takes the exact
// difference from the vault first; a person can top the allowance up from the window; and every
// settled move that touched the allowance is followed by a look at whether it is over its size.

// The account a draft spends from, lowercased, for the drafts that name one.
function spenderOf(draft: WriteDraft): string | null {
  return 'from' in draft && typeof draft.from === 'string' ? draft.from.toLowerCase() : null;
}

// What the ledger's last good read says one account holds of one coin, in base units; null with none.
function ledgerHeld(ctx: PCtx, account: string, asset: string): bigint | null {
  const read = ctx.ledger.intents();
  if (read === undefined || !read.ok) return null;
  let sum = 0n;
  for (const h of read.holdings) {
    if (h.accountId.toLowerCase() !== account.toLowerCase() || h.assetId !== asset) continue;
    if (h.amountBase === undefined) return null;
    sum += BigInt(h.amountBase);
  }
  return sum;
}

/* The card's line when a move spends more of a coin than the allowance holds, or null. Not for a
   swap: its builder read the allowance live a moment before (src/proposals/rails.ts), and a ledger
   read a refresh behind a top-up must not hold a swap the live read let through. */
function overAllowance(ctx: PCtx, draft: WriteDraft): string | null {
  if (ctx.allowance === undefined || draft.kind === 'swap') return null;
  const rails = railAccounts(ctx.cfg.keysPath);
  if (rails.kind !== 'chip' || rails.spend === null) return null;
  const need = moveSpend(draft);
  if (need === null || spenderOf(draft) !== rails.spend.toLowerCase()) return null;
  const held = ledgerHeld(ctx, rails.spend, need.asset);
  if (held === null || held >= need.base) return null;
  return shortfallSentence(need, held, need.base - held);
}

/* For the swap builder (src/proposals/rails.ts), off live reads: the card's line when a swap
   spends more than the allowance holds and the vault holds the rest, or null when it does not
   (the builder then refuses as it always has). */
export async function vaultShortfall(ctx: PCtx, coin: Pick<CoinAmount, 'asset' | 'symbol' | 'decimals'>, need: bigint, held: bigint | null): Promise<string | null> {
  const service = ctx.allowance;
  if (service === undefined || held === null || need <= held) return null;
  const acc = service.accounts();
  if (acc.kind !== 'chip' || acc.vault === null) return null;
  const saved = await service.balance(acc.vault, coin.asset);
  if (saved === null || held + saved < need) return null;
  return shortfallSentence(coin, held, need - held);
}

/* An allow becomes a click, and a click keeps its own rule, each with the line beside it once:
   the swap builder may already have said it off a live read (src/proposals/rails.ts). */
function askedFor(verdict: Verdict, line: string): Verdict {
  if (verdict.reasons.some((r) => r.startsWith('Your allowance holds '))) return verdict;
  if (verdict.outcome === 'allow') return { outcome: 'needs_approval', reasons: [...verdict.reasons, line], why: [line] };
  if (verdict.outcome === 'needs_approval') return { ...verdict, reasons: [...verdict.reasons, line], why: [...(verdict.why ?? verdict.reasons.slice(-1)), line] };
  return verdict;
}

/* THE SHORTFALL STEP (PHASE2-PLAN.md C8, call 14). A move that spends more of a coin than the
   allowance holds right now takes exactly the difference from the vault first, of that coin, as
   a top-up row of its own (why: shortfall) that this move's click approved: the vault's chip key
   signs it behind one Touch ID whose sentence names the amount, and the gas account sends it.
   Only then does the move's own rail run. Null when there is nothing to add (or no allowance in
   play, or nothing to read it by, which the rail then judges alone); a result when the move stops
   here, with nothing signed for it.
   Never on the policy's word: a move nobody clicked that turns out bigger than the allowance stops
   here, and the vault is not touched. */
async function shortfallStep(ctx: PCtx, p: Proposal): Promise<RailResult | null> {
  const service = ctx.allowance;
  if (service === undefined) return null;
  const acc = service.accounts();
  if (acc.kind !== 'chip' || acc.allowance === null || acc.vault === null) return null;
  const need = moveSpend(p.draft);
  const allowance = acc.allowance.toLowerCase();
  if (need === null || spenderOf(p.draft) !== allowance) return null;
  const held = await service.balance(allowance, need.asset);
  if (held === null) return null;
  const short = shortfallOf(need.base, held);
  if (short === 0n) return null;
  const coin: CoinAmount = { ...need, base: short };
  const holds = `your allowance holds ${baseUnitsToDecimal(held, need.decimals)} ${need.symbol}, less than the ${amountWords(need)} this move spends`;
  if (p.decidedBy !== 'human') {
    return { ok: false, reason: 'insufficient_balance', detail: `${holds}, and money leaves your vault only on your click and your Touch ID; nothing was signed` };
  }
  const vault = acc.vault.toLowerCase();
  const saved = await service.balance(vault, need.asset);
  if (saved === null) return { ok: false, reason: 'balance_unread', detail: `${holds}, and your vault's ${need.symbol} could not be read just now; nothing was signed` };
  if (saved < short) {
    return { ok: false, reason: 'insufficient_balance', detail: `${holds}, and your vault holds ${baseUnitsToDecimal(saved, need.decimals)} ${need.symbol}, less than the ${amountWords(coin)} it would add; nothing was signed` };
  }
  const topUp = await shortfallTopUp(ctx, p, need, coin, vault, allowance);
  if (topUp.status === 'executed') return null;
  const why = topUp.result?.detail ?? topUp.verdict.reasons.at(-1) ?? topUp.status;
  return {
    ok: false,
    reason: topUp.result?.reason ?? (topUp.status === 'policy_refused' ? 'policy_rule' : 'not_sent'),
    detail: `the top-up of ${amountWords(coin)} from your vault this move needed first (${topUp.id}) is ${topUp.status}: ${why}; nothing was signed for this move`,
  };
}

/* The shortfall's own row: priced as its share of the move, judged by the engine, dry-run by its
   rail, approved by the click that approved the move, and run to its end before the move goes on. */
async function shortfallTopUp(ctx: PCtx, parent: Proposal, need: CoinAmount, coin: CoinAmount, vault: string, allowance: string): Promise<Proposal> {
  const parentUsd = totalUsdOf(parent.draft);
  const draft: VaultTopUpDraft = {
    kind: 'vault_top_up',
    why: 'shortfall',
    asset: coin.asset,
    symbol: coin.symbol,
    decimals: coin.decimals,
    amount: baseUnitsToDecimal(coin.base, coin.decimals),
    amountUsd: parentUsd > 0 && need.base > 0n ? (parentUsd * Number(coin.base)) / Number(need.base) : Infinity,
    from: vault,
    to: allowance,
    counterparty: VAULT_TOP_UP_COUNTERPARTY,
    forProposal: parent.id,
  };
  const { row, rail } = await judgedTopUp(ctx, draft);
  if (row.verdict.outcome === 'refuse' || rail === null || row.simulation?.ok !== true) {
    const stopped = persist(ctx, { ...row, status: 'policy_refused', decidedBy: 'policy', decidedAt: nowIso() });
    ctx.audit.append('policy_refused', `${row.id}: the top-up for proposal ${parent.id} was refused: ${row.verdict.reasons.at(-1) ?? row.simulation?.error ?? 'no rail'}`, { id: row.id, forProposal: parent.id });
    return stopped;
  }
  const approved = persist(ctx, { ...row, status: 'approved', decidedBy: 'human', decidedAt: parent.decidedAt ?? nowIso() });
  ctx.audit.append('approved', `${row.id}: ${amountWords(coin)} from the vault, the difference proposal ${parent.id} needs, approved by that click; the vault's Touch ID asks at its signature`, {
    id: row.id,
    forProposal: parent.id,
    totalUsd: totalUsdOf(draft),
    vaultTouch: true,
  });
  const running = await executeRail(ctx, approved, rail);
  return (await ctx.inflight.get(running.id)) ?? ctx.store.get(running.id) ?? running;
}

// A top-up draft as a row: the engine's verdict and its rail's dry run, nothing landed yet.
async function judgedTopUp(ctx: PCtx, draft: VaultTopUpDraft): Promise<{ row: Proposal; rail: Rail | null }> {
  const verdict = evaluate(draft, buildCtx(ctx, ctx.ledger.snapshot(), loadPolicy(ctx.dataDir)));
  const rail = ctx.rails.for(draft);
  let simulation: SimulationResult | null = null;
  if (verdict.outcome !== 'refuse' && rail !== null) {
    try {
      simulation = await rail.simulate(draft);
    } catch (err) {
      simulation = { ok: false, summary: `top-up simulation threw: ${errText(err)}`, error: errText(err) };
    }
  }
  return { row: newProposal('vault_top_up', draft, simulation, verdict), rail };
}

/* A TOP-UP A PERSON ASKS FOR, from the window (POST /api/vault/allowance/top-up): dollars of USDC,
   from the vault's largest USDC, never past what keeps the allowance at its size plus 10 %
   (more would only come straight back at the next sweep). It lands pending: the engine always
   asks, and the click then runs it behind the vault's own Touch ID. A request the app will not
   file throws, with the sentence the window shows. */
export async function proposeVaultTopUp(ctx: PCtx, params: VaultTopUpParams): Promise<Proposal> {
  const service = ctx.allowance;
  const acc = service?.accounts();
  if (service === undefined || acc === undefined || acc.kind !== 'chip' || acc.vault === null) {
    throw new Error("Your vault is not on this Mac's Touch ID key, so there is no vault to top up from. Nothing changed.");
  }
  if (acc.allowance === null) throw new Error('Open your wallet first, so Phosphor knows your allowance. Nothing changed.');
  const usd = typeof params.usd === 'number' && Number.isFinite(params.usd) ? Math.round(params.usd * 100) / 100 : NaN;
  if (!(usd > 0) || usd > 1_000_000) throw new Error('A top-up is an amount of dollars above zero. Nothing changed.');
  const size = service.sizeUsd();
  if (!(size > 0)) throw new Error('Your allowance size is $0, so a top-up would go straight back to your vault. Pick a size first. Nothing changed.');
  const vault = acc.vault.toLowerCase();
  const allowance = acc.allowance.toLowerCase();
  const heldUsd = allowanceUsd(ctx, allowance);
  const room = Math.floor(((heldUsd === null ? size : size * (1 + SWEEP_MARGIN) - heldUsd) + 1e-9) * 100) / 100;
  if (room <= 0) throw new Error(`Your allowance already holds $${(heldUsd ?? 0).toFixed(2)} of its $${size.toFixed(2)} size. Nothing changed.`);
  if (usd > room) throw new Error(`Your allowance can take at most $${room.toFixed(2)} more right now, or the extra goes straight back to your vault. Nothing changed.`);
  // The vault's USDC with the most in it, by the ledger's last read: the coin and the count it is held in.
  const read = ctx.ledger.intents();
  const usdc = (read?.ok === true ? read.holdings : [])
    .filter((h) => h.accountId.toLowerCase() === vault && h.symbol.toUpperCase() === 'USDC' && h.amountBase !== undefined && BigInt(h.amountBase) > 0n)
    .sort((a, b) => (BigInt(b.amountBase!) > BigInt(a.amountBase!) ? 1 : -1))[0];
  if (usdc === undefined) throw new Error('Your vault holds no USDC to move to your allowance. Nothing changed.');
  const base = decimalToBaseUnits(usd.toFixed(2), usdc.decimals);
  if (BigInt(usdc.amountBase!) < base) {
    throw new Error(`Your vault holds ${baseUnitsToDecimal(BigInt(usdc.amountBase!), usdc.decimals)} USDC, less than the ${usd.toFixed(2)} this top-up moves. Nothing changed.`);
  }
  const draft: VaultTopUpDraft = {
    kind: 'vault_top_up',
    why: params.why === 'low' ? 'low' : 'manual',
    asset: usdc.assetId,
    symbol: 'USDC',
    decimals: usdc.decimals,
    amount: baseUnitsToDecimal(base, usdc.decimals),
    amountUsd: usd,
    from: vault,
    to: allowance,
    counterparty: VAULT_TOP_UP_COUNTERPARTY,
  };
  const { row } = await judgedTopUp(ctx, draft);
  if (row.verdict.outcome !== 'refuse' && row.simulation?.ok !== true) {
    return land(ctx, {
      ...row,
      verdict: {
        outcome: 'refuse',
        reasons: [...row.verdict.reasons, `The dry run failed, so nothing is signed: ${row.simulation?.error ?? row.simulation?.summary ?? 'no rail can run a top-up here'}`],
        rule: 'simulation_required',
        reasonCodes: [row.simulation?.reason ?? 'simulation_failed'],
      },
    });
  }
  return land(ctx, row);
}

// What the allowance holds in dollars, priced the engine's way; null with no read or a coin it cannot price.
function allowanceUsd(ctx: PCtx, allowance: string): number | null {
  const read = ctx.ledger.intents();
  if (read === undefined || !read.ok) return null;
  let total = 0;
  for (const h of read.holdings) {
    if (h.accountId.toLowerCase() !== allowance) continue;
    const price = priceOf(ctx, h.symbol, ctx.ledger.snapshot(), h.assetId);
    if (price === null) return null;
    total += h.amount * price;
  }
  return total;
}

// ---------- the sweep ----------

const sweepers = new WeakMap<PCtx, AllowanceSweep>();

/* The allowance's sweep for this service (src/rails/allowance-sweep.ts), built once, on the
   engine's own prices and the service's own rows: nothing goes home while a move is approved,
   waiting on a Touch ID or executing. Null where there is no allowance. */
export function sweeperFor(ctx: PCtx): AllowanceSweep | null {
  const service = ctx.allowance;
  if (service === undefined) return null;
  const known = sweepers.get(ctx);
  if (known !== undefined) return known;
  const made = createAllowanceSweep({
    service,
    sizeUsd: () => service.sizeUsd(),
    read: () => ctx.ledger.intents(),
    price: (symbol, asset) => priceOf(ctx, symbol, ctx.ledger.snapshot(), asset),
    busy: () => ctx.store.list().some((r) => r.status === 'approved' || r.status === 'awaiting_touch' || r.status === 'executing'),
    frozen: () => {
      const policy = loadPolicy(ctx.dataDir);
      return policy === null || policy.killSwitch;
    },
    isOpen: () => ctx.keystore?.isUnlocked() ?? false,
    audit: ctx.audit,
    refresh: () => void ctx.ledger.refresh().catch(() => undefined),
    ...(ctx.ledger.onRefresh === undefined ? {} : { onRefresh: (fn: () => void) => ctx.ledger.onRefresh!(fn) }),
  });
  sweepers.set(ctx, made);
  return made;
}

// A move that touched the allowance settled: the sweep looks at the next read that shows it.
function afterSettledMove(ctx: PCtx, row: Proposal): void {
  if (ctx.allowance === undefined) return;
  const spender = spenderOf(row.draft);
  const touched = row.draft.kind === 'vault_top_up' || (moveSpend(row.draft) !== null && spender !== null && spender === ctx.allowance.accounts().allowance?.toLowerCase());
  if (touched) sweeperFor(ctx)?.after();
}

async function applyPolicyChange(ctx: PCtx, p: Proposal): Promise<Proposal> {
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
  // Through the loader's own schema: a policy it would refuse is never written, because an
  // unreadable policy.json stops every write until somebody edits the file by hand.
  if (!savePolicyChecked(ctx.dataDir, patched)) {
    const detail = 'the changed policy did not pass the policy check, so the file was left as it was';
    ctx.audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id });
    return persist(ctx, { ...p, status: 'failed', result: { ok: false, detail } });
  }

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
