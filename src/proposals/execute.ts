// Execution: the single exit for a freshly evaluated proposal, the one route from approved to
// the thing that runs it, and the two ways a proposal actually moves (a rail, or a policy file).

import type { Proposal, Rail, RailEvidence, RailHooks, RailResult, WriteDraft } from '../types.ts';
import type { PocketRead } from '../ledger/settle.ts';
import { SETTLING_SENTENCE } from '../ledger/settle.ts';
import { loadPolicy, savePolicy } from '../policy/file.ts';
import { renderSentences } from '../policy/render.ts';
import { isLocked } from '../keystore/index.ts';
import { errText, mergePatch, nowIso, persist, totalUsdOf, enclaveGated } from './lifecycle.ts';
import { reservationMade } from './reservation.ts';
import { within } from '../shutdown.ts';
import { buildWallet } from '../wallet.ts';
import type { PCtx } from './lifecycle.ts';

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

async function runRail(ctx: PCtx, p: Proposal, rail: Rail, executing: Proposal, beforeUsd: number | null): Promise<Proposal> {
  /* THE EVIDENCE IS WRITTEN THE MOMENT IT EXISTS. A rail hands back a handle once the quote is
     taken, a hash once the intent is submitted, a nonce once the action is signed, and each one
     lands on the row here, before the rail's watch loop, so a quit or a crash during the three
     to five minutes of polling leaves a row that can be reconciled rather than one that "may or
     may not have sent". Merged, because a rail reports in pieces; ignored once the row has left
     `executing`, because a late hook must not reopen a decided row. */
  const hooks: RailHooks = {
    onEvidence: (e) => {
      const current = ctx.store.get(p.id) ?? executing;
      if (current.status !== 'executing') return;
      const txids = [...new Set([...(current.result?.txids ?? []), ...(e.txids ?? [])])];
      const evidence = { ...current.result?.evidence, ...pickEvidence(e) };
      ctx.audit.append('submitted', `${p.id}: the venue holds the move; evidence recorded before the wait`, { id: p.id, txids, evidence });
      persist(ctx, { ...current, result: { ok: false, detail: 'submitted, waiting for the venue', txids, evidence } });
    },
  };

  let result: RailResult;
  try {
    result = await rail.execute(p.draft, p.id, hooks);
  } catch (err) {
    // A rail that throws has said nothing about whether it sent anything, so its message
    // is passed through as-is rather than summarised into "failed".
    result = { ok: false, detail: `${p.draft.kind} rail threw: ${errText(err)}` };
  }

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
  const unconfirmed = !result.ok && (moved || settling);
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
    ...executing,
    status,
    settledAt,
    result: { ok: result.ok, detail: result.detail, txids, ...(Object.keys(evidence).length === 0 ? {} : { evidence }) },
    balances,
    ...(pocket === undefined ? {} : { pocket }),
  });
  if (settling) watchSettling(ctx);

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
  const pocket = p.pocket;
  if (p.status !== 'needs_reconciliation' || pocket === undefined) return p;
  const after = pocketBalance(ctx, pocket);
  if (after === null) return p;
  const before = BigInt(pocket.before);
  const floor = BigInt(pocket.floor);
  const delta = after - before;
  if (delta <= 0n) return p;

  const place = pocket.venue === 'intents' ? 'inside intents.near' : 'on the Hyperliquid account';
  const txids = p.result?.txids ?? [];
  // The handle, nonce and quote the rail recorded stay on the row: a settle by the balance adds
  // a verdict, it does not forget what a later question to the venue would go by.
  const kept = p.result?.evidence === undefined ? {} : { evidence: p.result.evidence };
  const settled = { ...pocket, after: after.toString() };
  const balances = {
    beforeUsd: p.balances?.beforeUsd ?? pocketPriced(ctx, settled, settled.before),
    afterUsd: pocketPriced(ctx, settled, settled.after),
  };
  if (delta < floor) {
    const detail =
      `A later read shows the balance ${place} rose by ${units(delta, pocket.decimals)} ${pocket.symbol}, below the ` +
      `${units(floor, pocket.decimals)} ${pocket.symbol} floor this move was approved with (${units(before, pocket.decimals)} before, ` +
      `${units(after, pocket.decimals)} after). Read the balance for ${pocket.account} before signing another.`;
    ctx.audit.append('execution_failed', `${p.id}: ${detail}`, { id: p.id, txids });
    return persist(ctx, { ...p, status: 'failed', settledAt: nowIso(), pocket: settled, balances, result: { ok: false, detail, txids, ...kept } });
  }
  const detail =
    `confirmed on a later read: the balance ${place} rose by ${units(delta, pocket.decimals)} ${pocket.symbol} ` +
    `(${units(before, pocket.decimals)} before, ${units(after, pocket.decimals)} after), at or above the ` +
    `${units(floor, pocket.decimals)} ${pocket.symbol} floor this move was approved with.`;
  ctx.audit.append('executed', `${p.id}: ${detail}`, { id: p.id, txids });
  return persist(ctx, { ...p, status: 'executed', settledAt: nowIso(), pocket: settled, balances, result: { ok: true, detail, txids, ...kept } });
}

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
