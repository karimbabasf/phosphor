// What happens to a proposal the app was in the middle of executing when it died.
//
// `executing` is written before the rail is called and overwritten after it answers. Kill the
// process in between and the row stays `executing` forever, which is the worst of the three
// possible states: `requirePending` refuses to approve, refuse or retry it, so it is
// unactionable, and `sessionSpentUsd` counts it against the 24h cap for the whole window, so one
// crash eats the day's spend budget. Nothing on any surface said the money might have moved.
//
// Boot rewrites every such row to `needs_reconciliation`: not executed, not failed, and honest
// about which. It carries whatever hashes were recorded, it is excluded from the spend cap, and
// the window renders it as "this may or may not have sent".
//
// `reconcile` is the way out. It asks the venue, by the balance the rail read and by the 1Click
// handle the rail recorded. It never guesses: a row it cannot ask about is left exactly where it
// was, with a sentence saying why. No chain is read: every move settles inside a venue, and the
// hashes a rail records are intent hashes and venue hashes, not transactions of this app's own.

import type { Proposal, RailEvidence } from '../types.ts';
import type { OneClickStatus } from '../intents.ts';
import { oneLine } from '../intents.ts';
import { nearChainSpec } from '../chain/near.ts';
import { depositHandleOf } from '../transactions.ts';
import { INTENTS_RELAY_VENUE, RELAY_TERMINAL } from '../rails/intents-relay.ts';
import { decodeNonce } from '../relay/payload.ts';
import type { RelayLookup } from '../rails/index.ts';
import { errText, nowIso, persist } from './lifecycle.ts';
import { expireHold, judgeSettlingNow, settleProposal } from './execute.ts';
import type { PCtx } from './lifecycle.ts';

// How a 1Click order is re-checked by the deposit address a quote minted. It is the handle the
// rails already record on evidence, and it is what settles a row: an INTENTS-mode swap settles
// on NEAR, inside the verifier, where no explorer of ours can look.
export type OneClickLookup = (handle: string) => Promise<OneClickStatus>;

// Whether the venue on the far side of a 1Click order shows the money it delivered. For a
// Hyperliquid deposit that is the account's own record of the credit; 1Click's SUCCESS is the
// solver's delivery, which the account can trail by a while or never show.
export type VenueCredited = (p: Proposal) => Promise<boolean>;

/* The venue read main.ts wires, over the Hyperliquid account's ledger of credits.
   A balance comparison cannot answer "did this deposit land" after the fact: the rail's own
   before-read is gone with the process, and trading moves the same figure. The ledger names each
   credit with its amount, so the question becomes whether the account has been credited, since
   a minute before this row was decided, with at least what every deposit decided since then was
   promised (this row's floor and each later row's). Two $10 deposits a second apart, the first
   unconfirmed: the first asks for $20 since its time, sees $10, and stays unconfirmed; once both
   credits show, both settle. Asking for the sum errs the safe way: a row this leaves unconfirmed
   is a row a person reads, a row it settled wrongly is money described that is not there. A
   ledger that will not answer is "not shown", never "nothing arrived". */
export function hlDepositCredited(deps: { credited(account: string, sinceMs: number): Promise<number>; rows(): Proposal[] }): VenueCredited {
  const MAY_HAVE_LANDED: ReadonlySet<Proposal['status']> = new Set(['executing', 'executed', 'needs_reconciliation']);
  const decided = (p: Proposal): number => Date.parse(p.decidedAt ?? p.createdAt);
  return async (p) => {
    if (p.draft.kind !== 'hl_deposit') return false;
    const account = p.draft.hlAccount.toLowerCase();
    const since = decided(p) - 60_000;
    if (!Number.isFinite(since)) return false;
    const owed = deps
      .rows()
      .filter((r) => r.draft.kind === 'hl_deposit' && r.draft.hlAccount.toLowerCase() === account && MAY_HAVE_LANDED.has(r.status) && decided(r) >= since)
      .reduce((sum, r) => sum + (r.draft.kind === 'hl_deposit' ? r.draft.minCredited : 0), 0);
    try {
      return (await deps.credited(account, since)) + 1e-6 >= owed;
    } catch {
      return false;
    }
  };
}

/* Rows 1Click's word cannot settle on its own: a Hyperliquid deposit, where the venue credits
   the account after the solver delivers and only the account says when, and any row whose rail
   wrote that the venue had not shown the money (hypercore-deposit.ts settleToPerp, in either
   tense). Both stay unconfirmed on SUCCESS until the venue read says otherwise. */
function awaitsVenue(p: Proposal): boolean {
  return p.kind === 'hl_deposit' || /\bha[sd] not shown\b/.test(p.result?.detail ?? '');
}

// Rows younger than this are still worth asking 1Click about on the scheduled sweep. Past it the
// deposit deadline is long gone and the order is settled one way or the other; a stale row stays
// for a human to clear rather than being re-queried forever.
const ONECLICK_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* Boot sweep. Runs once, before the port opens, so no surface ever renders a row a dead process
   left mid-decision. Returns what it changed, for the audit line and the tests.
     `executing`      -> needs_reconciliation: it was between the rail's call and its answer.
     `approved`       -> needs_reconciliation: it was between the approve and the executing write,
                         a two-put window with no hash, so it is unknown for the same reason.
     `awaiting_touch` -> pending: the Touch ID dialog died with the process and finishTouch will
                         never fire, so the click is offered again rather than stuck on a dead
                         dialog. Nothing was signed, so this is safe and it is not a spend.
   First, the one-off lift below for `failed` rows written before a failure with a hash was
   unconfirmed; those are not in what this returns, because they were not mid-decision. */
export function reconcileOnBoot(ctx: PCtx): Proposal[] {
  liftFailedWithHandle(ctx);
  const moved: Proposal[] = [];
  for (const p of ctx.store.list()) {
    if (p.status === 'awaiting_touch') {
      moved.push(persist(ctx, { ...p, status: 'pending' }));
      continue;
    }
    if (p.status !== 'executing' && p.status !== 'approved') continue;
    // A row held by its preflight when the process stopped signed nothing: it closes with the
    // reason rather than joining the unknowns, and the ask can be made again.
    if (p.status === 'approved' && p.heldSince !== undefined) {
      moved.push(expireHold(ctx, p, 'Phosphor stopped while this was waiting for the checks to clear. Nothing was signed; ask again.'));
      continue;
    }
    // Whatever the rail handed over before the process died stays on the row: the hashes,
    // and the handle or nonce a later reconcile asks the venue by. An `approved` row never
    // reached the rail, so it has neither.
    const txids = p.result?.txids ?? [];
    const evidence = p.result?.evidence;
    /* A relay swap that died after its signature carries the nonce and the deadline the rail
       handed over before publishing (src/rails/intents-relay.ts), and those are what the sweep
       asks the verifier by: a spent nonce is a swap that executed, an unspent one past its
       deadline is a swap that never can. The sentence says so rather than "may or may not". */
    const detail =
      isRelaySwap(p) && typeof evidence?.nonce === 'string'
        ? `Phosphor stopped while this swap was executing. The intent is signed${txids.length > 0 ? ' and published' : ''}, with its deadline at ` +
          `${evidence.deadline ?? 'unknown'}; the verifier is asked whether it executed.`
        : txids.length > 0
          ? `Phosphor stopped while this was executing. ${txids.length} transaction hash(es) were recorded, so it may already have sent.`
          : 'Phosphor stopped while this was executing and no transaction hash was recorded, so it may or may not have sent.';
    moved.push(
      persist(ctx, {
        ...p,
        status: 'needs_reconciliation',
        result: { ok: false, detail, txids, ...(evidence === undefined ? {} : { evidence }) },
      }),
    );
  }
  if (moved.length > 0) {
    ctx.audit.append(
      'error',
      `${moved.length} proposal(s) were mid-decision when Phosphor last stopped and are now waiting to be reconciled`,
      { ids: moved.map(p => p.id) },
    );
  }
  return moved;
}

/* ONE-OFF LIFT, run from the boot sweep, for rows written before a failure with a hash was
   unconfirmed. Until this branch a rail's ok:false with the intent hash on it landed `failed`:
   the 2026-09-15 rows sit there with the hash in txids and no evidence.handle, charged nothing
   to the day, unseen by the sweep and refused by reconcile, while the handle sits in the
   sentence where the receipts parser reads it. Each such row becomes needs_reconciliation with
   the handle on its evidence, the sentence kept, one audit line, and the sweep takes it from
   there. Once per row by construction: a lifted row is no longer `failed`, and a row the sweep
   later calls failed again carries the handle on its evidence.
   A failed row whose sentence names no handle is left alone. Reconcile's own verdicts (a hash
   the chain rejected, a hash that never existed) are definite, carry the hash too, and lifting
   them would reopen a settled answer on every boot. */
export function liftFailedWithHandle(ctx: PCtx): Proposal[] {
  const lifted: Proposal[] = [];
  for (const p of ctx.store.list()) {
    if (p.status !== 'failed' || (p.result?.txids?.length ?? 0) === 0 || p.result?.evidence?.handle !== undefined) continue;
    const handle = depositHandleOf(p.result?.detail ?? '');
    if (handle === null) continue;
    const row = persist(ctx, {
      ...p,
      status: 'needs_reconciliation',
      result: { ...p.result!, evidence: { ...p.result?.evidence, handle } },
    });
    ctx.audit.append('execution_unconfirmed', `${p.id}: a failure that carries a hash is lifted to unconfirmed, with its handle ${handle} on the row for the sweep to re-check`, {
      id: p.id,
      handle,
      txids: row.result?.txids ?? [],
    });
    lifted.push(row);
  }
  return lifted;
}

/* The scheduled sweep: re-check every row that carries a 1Click handle and is young enough that
   the order is not yet settled past recall. Wired in src/main.ts to run at boot and every ten
   minutes, so a FAILED deposit that will be refunded at the deadline, or a SUCCESS the app never
   saw because the process died mid-watch, settles itself instead of waiting for a human to press
   Reconcile. Per-row errors are swallowed into the audit log: one unreachable order must not
   stop the sweep reaching the next. Returns how many rows changed status. */
export async function reconcileOpen(ctx: PCtx): Promise<number> {
  const now = Date.now();
  const open = ctx.store
    .list()
    .filter(
      (p) =>
        p.status === 'needs_reconciliation' &&
        (typeof p.result?.evidence?.handle === 'string' || p.pocket !== undefined || (isRelaySwap(p) && typeof p.result?.evidence?.nonce === 'string')),
    )
    .filter((p) => now - Date.parse(p.settledAt ?? p.decidedAt ?? p.createdAt) < ONECLICK_SWEEP_MAX_AGE_MS);
  let changed = 0;
  for (const p of open) {
    try {
      const before = p.status;
      const after = await reconcileProposal(ctx, p.id, true);
      if (after.status !== before) changed += 1;
    } catch (err) {
      ctx.audit.append('error', `${p.id}: the scheduled reconcile could not re-check it: ${errText(err)}`, { id: p.id });
    }
  }
  return changed;
}

// Where the venue's word starts inside a detail, behind the rail's own sentence. Written by
// nothing else in this repo, so splitting on it finds the rail's sentence again. One anchor
// per venue that gets re-checked, so a relay row never says "1Click".
const RECHECK = ' Re-checked with 1Click: ';
const RECHECK_RELAY = ' Re-checked with the relay: ';

function isRelaySwap(p: Proposal): boolean {
  return p.draft.kind === 'swap' && p.draft.venue === INTENTS_RELAY_VENUE;
}

// One string for one value whatever the key order, so two results that say the same thing
// compare equal. The evidence is merged from two sources and its keys arrive in either order.
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/* Re-check one 1Click order by its quote handle and map what the venue reports onto the row.
     SUCCESS   -> executed, with the settled amount in the detail when the API gave one. A
                  Hyperliquid deposit is the exception: it stays needs_reconciliation until the
                  account read (ctx.venueCredited) shows the credit, because the solver's
                  delivery and the venue's credit are two events and only the second is money.
     REFUNDED  -> failed: the input went back, so nothing is on the far side; the amount is named.
     FAILED    -> stays needs_reconciliation: a FAILED order can still be refunded at the deadline,
                  so it is not terminal for us. The detail says what came back (or 0), why, and
                  that the input is held by 1Click under the handle.
     anything else (still pending, or an address the API does not know yet) leaves the row and
     says which status it is waiting on. */
async function reconcileByHandle(ctx: PCtx, p: Proposal, handle: string): Promise<Proposal> {
  const status = await ctx.oneClickStatus!(handle);
  // The settlement hashes the venue reports join the row's own, so an INTENTS-mode order that
  // settled on NEAR carries its NEAR hash beside the intent hash.
  const txids = [...new Set([...(p.result?.txids ?? []), ...(status.nearTxHashes ?? []), ...(status.destinationTxHashes ?? [])])];
  // MERGED, NEVER REPLACED. The handle and the nonce are what a later question to the venue goes
  // by; what 1Click reported is added beside them, so an executed row can still be re-checked.
  const evidence: RailEvidence = {
    ...p.result?.evidence,
    ...(status.settledAmountOut === undefined ? {} : { settledAmountOut: status.settledAmountOut }),
    ...(status.refundedAmount === undefined ? {} : { refundedAmount: status.refundedAmount }),
    ...(status.refundReason === undefined ? {} : { refundReason: status.refundReason }),
  };
  /* THE RAIL'S SENTENCE STAYS ON A ROW THAT STAYS OPEN. It is the observation ("signed and
     submitted, do not sign another"); the venue's word is the status it is waiting on, and it
     rides behind, anchored on RECHECK so a later re-check replaces the last word rather than
     adding one. A settled row (executed, failed) takes the venue's word alone: the observation
     has been answered. And NOTHING IS WRITTEN OR LOGGED WHEN NOTHING CHANGED: the sweep runs
     every ten minutes for seven days, and an order 1Click keeps calling FAILED used to collect
     up to a thousand audit lines and SSE frames saying so. */
  const railSaid = (p.result?.detail ?? '').split(RECHECK)[0];
  const write = (next: Proposal['status'], ok: boolean, said: string): Proposal => {
    const settledNow = next === 'executed' || next === 'failed';
    const detail = settledNow || railSaid === '' ? said : `${railSaid}${RECHECK}${said}`;
    const result = { ok, detail, txids, evidence };
    const current = { ok: p.result?.ok ?? false, detail: p.result?.detail ?? '', txids: p.result?.txids ?? [], evidence: p.result?.evidence ?? {} };
    if (next === p.status && stable(result) === stable(current)) return p;
    ctx.audit.append(next === 'executed' ? 'executed' : 'error', `${p.id} reconciled by 1Click: ${next}. ${said}`, { id: p.id, handle, status: status.status });
    // Something changed, so a row a person had filed comes back to the dock with the new word.
    const { acknowledgedAt: _filed, ...unfiled } = p;
    return persist(ctx, {
      ...unfiled,
      status: next,
      decidedAt: p.decidedAt ?? nowIso(),
      settledAt: next === p.status ? p.settledAt : nowIso(),
      result,
    });
  };

  if (status.status === 'SUCCESS') {
    const settled = status.settledAmountOut !== undefined ? `1click settled this: ${status.settledAmountOut} arrived.` : '1click reports this settled.';
    /* A ROW WITH A POCKET IS SETTLED BY ITS BALANCE, not by this word. The rail read the balance
       either side of the move and the executor re-judges it on every ledger refresh
       (src/proposals/execute.ts judgeSettling); 1Click's SUCCESS is recorded beside that and the
       row settles itself the moment the balance shows the rise. A Hyperliquid deposit keeps the
       venue read below instead, which names the credit rather than a figure trading also moves. */
    if (p.pocket !== undefined && p.kind !== 'hl_deposit') {
      return write(
        'needs_reconciliation',
        false,
        `${settled} The balance has not shown the rise yet; it is re-read on every refresh and this settles itself when it does.`,
      );
    }
    /* A WITHDRAWAL IS CONFIRMED BY THE INTENTS BALANCE RISING, and by nothing else (criterion
       8.3). The rail reads that balance before the send and puts the pocket on the row with the
       nonce (hypercore-withdraw.ts), so the branch above is the one a withdrawal takes. A row
       that carries none has nothing for the balance to rise over, and 1Click's word is the
       solver's, not the verifier's: it stays unconfirmed, keeps its nonce and handle for a
       later question to the venue, and says what would settle it. Before the venue read below,
       which answers for a deposit's account and would hold a withdrawal open for ever. */
    if (p.kind === 'hl_withdraw') {
      return write(
        'needs_reconciliation',
        false,
        `${settled} This row has no balance read from before the send to compare against, so this app cannot confirm the credit on its own: read the wallet, and press Got it once the balance shows it.`,
      );
    }
    /* 1CLICK'S WORD IS NOT THE VENUE'S. The rail had read the Hyperliquid account and found no
       credit; this used to overwrite that observation with the solver's promise ten minutes
       later and write executed, ok true, which is the sentence rule this branch exists for. The
       row stays unconfirmed, with both facts on it, until the account shows the rise. */
    if (awaitsVenue(p)) {
      if (ctx.venueCredited === undefined) {
        return write(
          'needs_reconciliation',
          false,
          `${settled} This app has no venue read wired to confirm the credit, so this stays unconfirmed: read the account before depositing again.`,
        );
      }
      if (!(await ctx.venueCredited(p))) {
        return write(
          'needs_reconciliation',
          false,
          `${settled} The Hyperliquid account has not shown the credit, so this stays unconfirmed: read the account before depositing again.`,
        );
      }
      return write('executed', true, `${settled} The Hyperliquid account shows the credit.`);
    }
    return write('executed', true, settled);
  }
  if (status.status === 'REFUNDED') {
    const amount = status.refundedAmount ?? '0';
    return write('failed', false, `1click reported REFUNDED: ${amount} went back, so nothing is on the far side.`);
  }
  if (status.status === 'FAILED') {
    const amount = status.refundedAmount ?? '0';
    const reason = status.refundReason ?? 'not given';
    return write(
      'needs_reconciliation',
      false,
      `1click reported FAILED and refunded ${amount} so far, reason ${reason}. The input is held by 1Click under handle ${handle} until a refund shows in your balance.`,
    );
  }
  // Not terminal yet, or an address 1Click does not know: change nothing, say what it is waiting on.
  const said = status.found ? status.status : 'an address 1Click does not recognise yet';
  return write(p.status, p.result?.ok ?? false, `1click has not settled this: it reports ${said}. Nothing has changed; check again shortly.`);
}

/* Ask the venue or the chain what happened. Reachable for a row waiting to be reconciled, and
   for a `failed` row that carries a 1Click handle: a FAILED order can still be refunded at its
   deadline, so the handle is worth re-asking even after the row was called failed. Anything else
   already has a settled answer and re-checking it would be re-deciding it. */
export async function reconcileProposal(ctx: PCtx, id: string, quiet = false): Promise<Proposal> {
  const p = ctx.store.get(id);
  if (p === undefined) throw new Error(`unknown proposal ${id}`);
  const handle = p.result?.evidence?.handle;
  const reCheckableFailed = p.status === 'failed' && typeof handle === 'string';
  if (p.status !== 'needs_reconciliation' && !reCheckableFailed) {
    throw new Error(`proposal ${id} is ${p.status}, and only a proposal waiting to be reconciled can be re-checked`);
  }

  /* A ROW THE RAIL LEFT SETTLING IS JUDGED BY ITS BALANCE FIRST. An intent hash is nothing a
     block explorer can answer for, and the balance the rail read either side of the move is
     what "done" is defined by (see settleProposal). Only a row the balance has not settled goes
     on to the venue: its handle can still say REFUNDED or FAILED, which no balance read will.
     `quiet` is the scheduled sweep: it takes the read and the judgment without the stamped
     "re-read at" sentence a click gets, so a row nothing has changed on is not rewritten. */
  if (p.pocket !== undefined) {
    const judged = quiet ? await judgeSettlingNow(ctx, id) : await settleProposal(ctx, id);
    if (judged.status !== 'needs_reconciliation') return judged;
    if (isRelaySwap(judged)) return reconcileRelaySwap(ctx, judged);
    if (typeof handle === 'string' && ctx.oneClickStatus !== undefined) return reconcileByHandle(ctx, judged, handle);
    return judged;
  }

  /* A RELAY SWAP HAS A CHAIN-LEVEL ANSWER the 1Click path never had: its handle is the intent
     hash the relay reports on, and its nonce is what the verifier itself says is spent or not.
     Before the 1Click branch, because a relay handle asked of 1Click is an address it does not
     know, which would read as "still pending" forever. */
  if (isRelaySwap(p)) return reconcileRelaySwap(ctx, p);

  /* THE VENUE, BY THE HANDLE, NEXT. A 1Click order settles on NEAR for an INTENTS swap, inside
     the verifier, so the quote handle is the only thing that can tell a SUCCESS from a REFUND. */
  if (typeof handle === 'string' && ctx.oneClickStatus !== undefined) {
    return reconcileByHandle(ctx, p, handle);
  }

  /* Nothing left to ask. No handle means no venue to re-check, and this app reads no chain of
     its own any more (the hashes a rail records are intent and venue hashes, not transactions
     it broadcast). Say so and change nothing: an app that cleared this row would be asserting
     that no funds moved, which is exactly what it does not know. */
  const txids = p.result?.txids ?? [];
  const detail =
    txids.length === 0
      ? 'No transaction hash was recorded, so there is nothing to look up. ' +
        'Compare the balances before and after on the receipt, or search the account in the explorer.'
      : `No venue handle was recorded for ${txids.join(', ')}, so there is nothing this app can re-check. ` +
        'Compare the balances before and after on the receipt, or look the hash up in the explorer by hand.';
  ctx.audit.append('error', `${id}: reconcile found nothing to re-check`, { id, txids });
  return persist(ctx, { ...p, result: { ok: false, detail, txids, ...(p.result?.evidence === undefined ? {} : { evidence: p.result.evidence }) } });
}

/* Clock skew between this Mac and the verifier's block time. The deadline in the payload was
   minted from this clock, and the contract judges it by its own; a deadline is only called
   passed once it is this far behind, so an intent the contract could still execute is never
   called dead. Five minutes is far past any skew a Mac that syncs its clock carries, and the
   cost of waiting it out is a failed row that reads unconfirmed for five minutes longer. */
export const RELAY_DEADLINE_GRACE_MS = 5 * 60_000;

/* Re-check one relay swap: by the intent hash at the relay, then by the nonce at the verifier.
     SETTLED at the relay        -> a row with a pocket stays until the balance shows the rise,
                                    which the executor re-judges on every refresh; a row without
                                    one (the rail died in the watch) is executed once the verifier
                                    shows the nonce spent, and stays until it does: the relay's
                                    word is checked against the chain, never taken alone.
     PENDING, TX_BROADCASTED     -> stays, with the relay's word on the row so the card moves.
     anything else, or no hash   -> the verifier, by the nonce:
       spent                     -> the swap executed; executed without a pocket, else stays until
                                    the balance shows it.
       unspent, deadline passed  -> failed, nothing left the balance: an intent past its deadline
                                    cannot execute, and the nonce outlives the deadline by a week
                                    (NONCE_LIFE_AFTER_DEADLINE_MS) so "unspent" is still an answer.
                                    Past the nonce's OWN life, or once the verifier has retired the
                                    nonce's salt (a spent nonce with a retired salt is pruned too,
                                    garbage_collector.rs), "unspent" says nothing and no verdict is
                                    written: the balance read decides.
       unspent, inside deadline  -> stays; it can still execute until the deadline.
       no answer                 -> stays, and says the verifier did not answer.
   Nothing here signs or publishes: the reads are the relay's status and two verifier views. */
async function reconcileRelaySwap(ctx: PCtx, p: Proposal): Promise<Proposal> {
  const lookup: RelayLookup | undefined = ctx.rails.relay;
  const evidence0 = p.result?.evidence ?? {};
  const handle = typeof evidence0.handle === 'string' ? evidence0.handle : null;
  const nonce = typeof evidence0.nonce === 'string' ? evidence0.nonce : null;
  const deadlineMs = typeof evidence0.deadline === 'string' ? Date.parse(evidence0.deadline) : Number.NaN;
  const account = p.draft.kind === 'swap' ? p.draft.from.toLowerCase() : '';
  const railSaid = (p.result?.detail ?? '').split(RECHECK_RELAY)[0];

  let txids = [...(p.result?.txids ?? [])];
  let evidence: RailEvidence = { ...evidence0 };

  const write = (next: Proposal['status'], ok: boolean, said: string): Proposal => {
    const settledNow = next === 'executed' || next === 'failed';
    const detail = settledNow || railSaid === '' ? said : `${railSaid}${RECHECK_RELAY}${said}`;
    const result = { ok, detail, txids, evidence };
    const current = { ok: p.result?.ok ?? false, detail: p.result?.detail ?? '', txids: p.result?.txids ?? [], evidence: p.result?.evidence ?? {} };
    if (next === p.status && stable(result) === stable(current)) return p;
    ctx.audit.append(next === 'executed' ? 'executed' : 'error', `${p.id} reconciled by the relay and the verifier: ${next}. ${said}`, {
      id: p.id,
      ...(handle === null ? {} : { handle }),
      ...(nonce === null ? {} : { nonce }),
    });
    const { acknowledgedAt: _filed, ...unfiled } = p;
    return persist(ctx, {
      ...unfiled,
      status: next,
      decidedAt: p.decidedAt ?? nowIso(),
      settledAt: next === p.status ? p.settledAt : nowIso(),
      result,
    });
  };

  if (lookup === undefined) {
    return write(p.status, p.result?.ok ?? false, `No relay read is wired in ${ctx.cfg.mode} mode, so this stays as it is. Compare the balances before and after on the receipt.`);
  }

  // The relay first, when the rail got as far as a hash.
  let relayWord: string | null = null;
  if (handle !== null) {
    try {
      const status = await lookup.status(handle);
      relayWord = status.status;
      evidence = { ...evidence, providerStage: status.status };
      if (status.nearTxHash !== null) {
        txids = [...new Set([...txids, status.nearTxHash])];
        evidence = { ...evidence, explorerUrl: `${nearChainSpec().explorerTx}${status.nearTxHash}` };
      }
      if (status.status === 'SETTLED') {
        const tx = status.nearTxHash === null ? '' : ` (NEAR tx ${status.nearTxHash})`;
        if (p.pocket !== undefined) {
          return write('needs_reconciliation', false, `The relay reports the swap settled${tx}. The balance has not shown the rise yet; it is re-read on every refresh and this settles itself when it does.`);
        }
        /* The relay's word, checked against the chain: the nonce is committed in the same call
           that applies the diff, so a spent nonce IS the swap having executed. Unspent (a view a
           block behind, or a relay that is wrong) stays unconfirmed and is asked again. */
        const spent = nonce === null ? null : await lookup.nonceUsed(account, nonce);
        if (spent !== true) {
          return write(
            'needs_reconciliation',
            false,
            `The relay reports the swap settled${tx} and the verifier has not shown the nonce spent${spent === null ? ' (it did not answer)' : ''}. ` +
              'Nothing more will be signed; it is checked again shortly.',
          );
        }
        const signed = evidence0.relayQuote?.amountOut;
        return write(
          'executed',
          true,
          `The relay reports the swap settled on NEAR${tx} and the verifier shows the nonce spent: the signed diff executed in one call. This app did not read the balance either side of it, ` +
            `so the amount out is the signed ${signed === undefined ? 'diff' : `${signed} base units`} rather than an observed figure.`,
        );
      }
      if (!RELAY_TERMINAL.includes(status.status)) {
        return write(p.status, p.result?.ok ?? false, `The relay reports ${oneLine(status.status, 40)}. Nothing has changed; check again shortly.`);
      }
    } catch (err) {
      return write(p.status, p.result?.ok ?? false, `The relay could not be asked (${oneLine(errText(err), 80)}). Nothing has changed; check again shortly.`);
    }
  }

  // The verifier, by the nonce: the chain-level answer.
  const relayNote = relayWord === null ? '' : ` The relay reports ${oneLine(relayWord, 40)}.`;
  if (nonce === null) {
    return write(p.status, p.result?.ok ?? false, `No nonce was recorded for this swap, so the verifier cannot be asked whether it executed.${relayNote} Compare the balances before and after on the receipt.`);
  }
  const used = await lookup.nonceUsed(account, nonce);
  if (used === null) {
    return write(p.status, p.result?.ok ?? false, `The verifier did not answer whether the nonce was spent.${relayNote} Nothing has changed; check again shortly.`);
  }
  if (used) {
    if (p.pocket !== undefined) {
      return write('needs_reconciliation', false, `The verifier shows the nonce spent, so the swap executed.${relayNote} The balance has not shown the rise yet; it is re-read on every refresh and this settles itself when it does.`);
    }
    const signed = evidence0.relayQuote?.amountOut;
    return write(
      'executed',
      true,
      `The verifier shows the nonce spent, so the swap executed at the signed diff${signed === undefined ? '' : ` (${signed} base units out)`}.${relayNote} ` +
        'This app did not read the balance either side of it, so that figure is the signed one rather than an observed one.',
    );
  }
  if (!Number.isFinite(deadlineMs)) {
    return write(p.status, p.result?.ok ?? false, `The verifier shows the nonce unspent and no deadline was recorded, so this app cannot say whether it can still execute.${relayNote} Compare the balances before and after on the receipt.`);
  }
  // Past the nonce's own life the contract may have pruned it, and "unspent" then says nothing
  // about whether it executed. No verdict is written on an answer that can no longer be one.
  const parts = decodeNonce(nonce);
  if (parts !== null && Date.now() > parts.deadlineMs) {
    return write(
      p.status,
      p.result?.ok ?? false,
      `The verifier shows the nonce unspent, and the nonce's own life (${new Date(parts.deadlineMs).toISOString()}) has passed, so the verifier may have forgotten it either way.${relayNote} Compare the balances before and after on the receipt.`,
    );
  }
  if (Date.now() < deadlineMs + RELAY_DEADLINE_GRACE_MS) {
    return write(p.status, p.result?.ok ?? false, `The verifier shows the nonce unspent and the deadline (${new Date(deadlineMs).toISOString()}) has not passed, so the swap can still execute.${relayNote} Nothing has changed; check again after the deadline.`);
  }
  /* The salt the nonce carries has to still be one the verifier accepts, or "unspent" is the
     answer a pruned nonce gives whether or not it executed: the contract clears a spent nonce
     once its salt is rotated out. A retired salt, or no answer, is no verdict. */
  const saltValid = parts === null || lookup.saltValid === undefined ? null : await lookup.saltValid(parts.salt);
  if (saltValid !== true) {
    return write(
      p.status,
      p.result?.ok ?? false,
      saltValid === null
        ? `The verifier shows the nonce unspent and did not answer whether that salt is still valid, so this app cannot say whether the swap executed.${relayNote} Nothing has changed; check again shortly.`
        : `The verifier shows the nonce unspent, and the verifier has retired the key of that price window (the nonce's salt), after which a spent nonce reads as unspent too.${relayNote} The balance read decides: compare the balances before and after on the receipt.`,
    );
  }
  return write('failed', false, `The deadline (${new Date(deadlineMs).toISOString()}) passed with the nonce unspent, so the swap never executed and nothing left the balance.${relayNote} Ask for a fresh price to try again.`);
}

/* Filing an unconfirmed row. The dock keeps an unconfirmed move in front of a person because
   the only thing that clears it is the venue, and the venue can take days (a FAILED 1Click order
   waits on their support). Reading the same sentence every time the window opens is not
   information, it is nagging, so a person can say "got it": the row keeps its status, its
   charge against the day and its place in Activity, and the dock stops asking until a re-check
   changes what the venue says. Nothing about the money changes here, which is why it is not a
   decision and carries no decidedBy. */
export async function acknowledge(ctx: PCtx, id: string): Promise<Proposal> {
  const p = ctx.store.get(id);
  if (p === undefined) throw new Error(`unknown proposal ${id}`);
  if (p.status !== 'needs_reconciliation') {
    throw new Error(`proposal ${id} is ${p.status}, and only an unconfirmed row can be filed`);
  }
  if (p.acknowledgedAt !== undefined) throw new Error(`proposal ${id} is already filed`);
  ctx.audit.append('acknowledged', `${id} filed by the human as unconfirmed; the venue has the last word`, { id });
  return persist(ctx, { ...p, acknowledgedAt: nowIso() });
}
