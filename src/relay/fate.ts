// Whether a transfer this app signed inside intents.near ran, and whether it still can. The one
// proof behind every "nothing moved" written about a signature the app released: the relay swap's
// reconcile, the 1Click swap's reconcile, and the 1Click swap rail's own watch all ask it here.
//
// THE INVARIANT: never write "nothing moved" while the signed transfer can still execute.
//
// intents.near refuses a signed intent once the block it would run in is stamped past the intent's
// deadline, and every block is stamped later than the one before it. So "never ran and never can"
// is four facts about ONE final block:
//   1. its stamp is past the signed deadline, so no block from here on can run the transfer;
//   2. at that block the verifier shows the intent's nonce unspent, so no block up to it ran it;
//   3. at that block the nonce's salt is still one the verifier accepts, and
//   4. the stamp is inside the nonce's own life. The contract prunes a SPENT nonce once its salt is
//      retired or its life is over (garbage_collector.rs), after which it reads unspent too; 3 and
//      4 are what make the "unspent" in 2 mean the transfer never ran.
// The block is read first and the nonce and salt AT that block, by its hash. "Final" read a moment
// later is not the same block: a load-balanced RPC answers from nodes a block or two apart, and a
// read from the one behind would miss a transfer run between the two.
//
// When the chain's clock cannot be read, the deadline is judged by this Mac's clock with
// RELAY_DEADLINE_GRACE_MS of skew, the only rule before 2026-09-25, and the nonce and salt are read
// at whatever block is final. When the chain's clock CAN be read, BOTH clocks have to be
// FATE_FLOOR_MS past the deadline: the final block's stamp, and this Mac's. The stamp is the RPC's
// word, and on its word alone a node that lied about the time closed a row minutes early on every
// path, the sweep and a Reconcile click included (security review F3); this clock is the floor
// under it. A final block stamped at or before that is a transfer that can still run, whatever this
// clock says. A block stamped more than FATE_AHEAD_MAX_MS ahead of this clock is no answer at all:
// nothing is read at it, and the grace rule decides as if the chain could not be read.
//
// Why it exists: on 2026-09-25 a VVV to USDC swap (proposal 6bb6783b) signed a transfer with a
// deadline of 20:02:34Z. The chain could have shown it dead half a minute later; the grace rule
// could only say so at 20:07:34Z, and the ten-minute sweep said it at 20:13:08Z, while the card read
// "On its way" over money that never left.
//
// Nothing here writes a row or signs anything; each caller writes the verdict in its own words.

import type { FinalBlock } from './verifier.ts';
import { decodeNonce } from './payload.ts';

/* Clock skew between this Mac and the verifier's block time. The deadline in the payload was
   minted from this clock, and the contract judges it by its own; a deadline is only called
   passed once it is this far behind, so an intent the contract could still execute is never
   called dead. Five minutes is far past any skew a Mac that syncs its clock carries, and the
   cost of waiting it out is a failed row that reads unconfirmed for five minutes longer. Since
   2026-09-25 it is the fallback: the chain's own clock, when it answers, needs only
   FATE_FLOOR_MS, with this clock past the same floor. */
export const RELAY_DEADLINE_GRACE_MS = 5 * 60_000;

// How often one open row's signed transfer is asked about once its deadline has passed: the
// rail's watch and the deadline watch in src/proposals/reconcile.ts both hold to it.
export const FATE_RECHECK_MS = 30_000;

/* How far past the deadline the chain's final block AND this clock must both be before a transfer
   is called dead. It costs an honest RPC half a minute (a final block trails real time by about
   2.6 s), and it keeps a node answering from a little older state, or a clock a little fast, on
   the safe side. */
export const FATE_FLOOR_MS = 30_000;

/* How far ahead of this clock a final block may be stamped and still be read as the chain's time.
   Further than two minutes is not a clock a little fast: it is a node that cannot be believed. */
export const FATE_AHEAD_MAX_MS = 120_000;

/* The three reads the proof takes, every one of them null when it did not answer (never zero,
   never false, never "unspent"). `at` is a block hash to read at. The relay lookup
   (src/rails/index.ts) and the 1Click swap rail's ports are both this shape. Without finalBlock
   the grace rule decides; without saltValid no unspent nonce is ever believed. */
export type FateReads = {
  finalBlock?(): Promise<FinalBlock | null>;
  nonceUsed(accountId: string, nonce: string, at?: string): Promise<boolean | null>;
  saltValid?(salt: Uint8Array, at?: string): Promise<boolean | null>;
};

// How a deadline was proved passed: by a final block stamped past it, or by this Mac's clock and
// the grace when the chain's clock did not answer.
export type DeadProof = { by: 'chain'; block: FinalBlock } | { by: 'clock' };

/* ran true: the verifier shows the nonce spent, so the transfer ran.
   ran false: the nonce is unspent and the verifier still keeps it, so the transfer has not run;
     `dead` is the proof that it never can, null while it still can or while nothing says when it
     stops (no deadline on the row).
   ran null: no answer a verdict can stand on, and `why`. */
export type TransferFate =
  | { ran: true }
  | { ran: false; dead: DeadProof | null }
  | { ran: null; why: 'not_the_verifiers' | 'no_answer' | 'nonce_life_over' | 'salt_retired' | 'salt_no_answer'; nonceLifeMs?: number };

export async function transferFate(
  reads: FateReads,
  signed: { account: string; nonce: string; deadline: string | undefined },
  now: number = Date.now(),
): Promise<TransferFate> {
  // Only a versioned intents nonce is the verifier's to answer for; a Hyperliquid row's nonce is
  // the venue's, and nothing is asked about it here.
  const parts = decodeNonce(signed.nonce);
  if (parts === null) return { ran: null, why: 'not_the_verifiers' };
  const deadlineMs = Date.parse(signed.deadline ?? '');
  // The clock first, then the nonce and the salt at the block it came from. A read that throws is
  // a read that did not answer, and so is a block stamped too far ahead of this clock.
  const read = Number.isFinite(deadlineMs) && reads.finalBlock !== undefined ? await reads.finalBlock().catch(() => null) : null;
  const block = read !== null && read.atMs > now + FATE_AHEAD_MAX_MS ? null : read;
  const spent = await reads.nonceUsed(signed.account.toLowerCase(), signed.nonce, block?.hash).catch(() => null);
  if (spent === true) return { ran: true };
  if (spent !== false) return { ran: null, why: 'no_answer' };
  if ((block?.atMs ?? now) > parts.deadlineMs) return { ran: null, why: 'nonce_life_over', nonceLifeMs: parts.deadlineMs };
  const salt = reads.saltValid === undefined ? null : await reads.saltValid(parts.salt, block?.hash).catch(() => null);
  if (salt !== true) return { ran: null, why: salt === false ? 'salt_retired' : 'salt_no_answer' };
  if (!Number.isFinite(deadlineMs)) return { ran: false, dead: null };
  if (block !== null) {
    const past = block.atMs > deadlineMs + FATE_FLOOR_MS && now >= deadlineMs + FATE_FLOOR_MS;
    return { ran: false, dead: past ? { by: 'chain', block } : null };
  }
  return { ran: false, dead: now >= deadlineMs + RELAY_DEADLINE_GRACE_MS ? { by: 'clock' } : null };
}

// What proved the deadline passed, for the engineer's line: nothing to add for the clock and the
// grace (the sentence has always said "passed"), the block's own stamp for the chain.
export function proofWords(dead: DeadProof): string {
  return dead.by === 'chain' ? ` (NEAR's final block is stamped ${new Date(dead.block.atMs).toISOString()}, past it, so it never can)` : '';
}
