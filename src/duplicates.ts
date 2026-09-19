// The one thing exclusivity was doing that the roster had to replace.
//
// Phosphor allowed one agent at a time until 2026-08-21. Among the things that rule made
// impossible was this: two agents proposing the same swap at the same moment. The second agent
// was not connected, so it could not.
//
// With a team they both can, and the failure is quiet and expensive. Two identical proposals
// under the policy click threshold both get verdict `allow` (see the note beside ProposeKind in
// src/mcp.ts: below the threshold the engine decides and executes, and no human clicks), both
// execute, and the human sees one action they asked for and one they did not. Nothing else in
// the stack catches it, because each proposal is individually correct: correct rail, correct
// size, correct policy verdict. Only the pair is wrong.
//
// So this holds a short memory of what was proposed, by whom. An identical proposal from a
// DIFFERENT session inside the window is refused with the id of the one that already exists.
//
// THREE THINGS IT DELIBERATELY DOES NOT DO.
//
//   It does not refuse the same session once its first proposal has settled. An agent repeating
//   a settled proposal is retrying, that is its own business, and blocking it would turn a
//   network blip into a stuck agent. While the first is still running, or landed unconfirmed
//   with evidence that money moved, the repeat IS refused: that is the incident of 2026-09-15,
//   and `stillInFlight` below is the line between the two.
//
//   It does not persist. This guards a race between two agents working at the same moment, not
//   a human who asked for the same swap twice in an afternoon. A memory that outlived the app
//   would start refusing deliberate repeats and there would be no way to tell it apart.
//
//   It is not a lock and it is not security. Anything with a shell can post as any session (see
//   the KNOWN HOLE note at the top of src/server.ts), and two agents that genuinely both want
//   the same swap can have it a minute and a half apart. It removes an accident, not an attack.

import type { Proposal } from './types.ts';

export type Duplicate = { id: string; session: string };

// Whether the proposal with this id is still in flight: no id yet (an empty string, the claim
// before the row exists), or a stored row that has not reached a terminal status. Wired from the
// store in src/server.ts; a guard built without it treats every id as settled, which is the old
// behaviour and what the pure unit tests use.
export type InFlight = (id: string) => boolean;

const SETTLED: ReadonlySet<Proposal['status']> = new Set(['executed', 'failed', 'refused', 'policy_refused']);

/* What "in flight" means for a stored row, for the server's wiring and the door's tests alike.
   A row the store does not hold yet is still being written. A terminal row has settled, with one
   exception: an UNCONFIRMED row that carries a hash, a handle or a nonce is money that may be
   live at the venue, and it holds its claim for the window. In the incident replay the first $10
   landed needs_reconciliation at 43 s and a repeat at 44 s walked through, because unconfirmed
   read as terminal; the reply sentence and the daily ceiling were the only walls left. An
   unconfirmed row with none of those is the app not knowing, and holds nothing, the same line
   the daily cap draws (countsAgainstCap in src/proposals/lifecycle.ts). */
export function stillInFlight(row: Proposal | undefined): boolean {
  if (row === undefined) return true;
  if (row.status === 'needs_reconciliation') {
    const evidence = row.result?.evidence;
    return (row.result?.txids?.length ?? 0) > 0 || evidence?.handle !== undefined || evidence?.nonce !== undefined;
  }
  return !SETTLED.has(row.status);
}

export type GuardDeps = { inFlight?: InFlight };

export type DuplicateGuard = {
  /* The proposal this one would double, or null.
     A DIFFERENT session is refused for any entry inside the window, as before: two agents must
     not both spend. The SAME session is refused only while its own last proposal is still in
     flight, which is the incident of 2026-09-15: a propose whose reply outlived the proxy, an
     agent that read the timeout as "it never happened" and proposed again, and a guard that
     waved the repeat through as a harmless retry. Once the first has settled, a repeat by the
     same session is its own business again. `id` is empty when the row is still being drafted. */
  find(kind: string, params: Record<string, unknown>, session: string): Duplicate | null;
  /* Called TWICE per proposal, and the first call is the one that closes the race.
     It used to be called once, when the proposal had landed, and the whole pipeline was awaited
     in between: two identical requests arriving in the same tick both found an empty memory and
     both landed. So the claim is made in the same tick as the check, with no id yet, and made
     again with the real id when the proposal exists.
     Anything that does not land calls forget, because a fingerprint left behind by a draft that
     was refused for a bad amount would block the corrected retry as a duplicate of a proposal
     that never existed, and would name an id nobody can look up. */
  remember(kind: string, params: Record<string, unknown>, session: string, id: string): void;
  forget(kind: string, params: Record<string, unknown>): void;
  size(): number;
};

// Ninety seconds. Long enough to cover two agents reacting to the same event, short enough that
// it is never the reason a person cannot repeat an action they meant to repeat.
export const DUPLICATE_MS = 90_000;

// A cap, because this is a map in a long-lived process and a busy session should not grow it
// without bound between sweeps.
const MAX_TRACKED = 200;

/* Key order is whatever the caller sent, so it is sorted: {a:1,b:2} and {b:2,a:1} are the same
   proposal and a fingerprint that said otherwise would let the race straight through, which is
   the one failure this file exists to prevent. Nested values are compared as their JSON, which
   is enough for every propose shape on this surface: they are flat records of strings and
   numbers, apart from a policy patch, and two policy patches that differ only in key order are
   the same patch too. */
export function fingerprint(kind: string, params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `${kind}:${JSON.stringify(entries)}`;
}

export function createDuplicateGuard(now: () => number = Date.now, windowMs = DUPLICATE_MS, deps: GuardDeps = {}): DuplicateGuard {
  const seen = new Map<string, { session: string; at: number; id: string }>();
  // No dependency means the old behaviour: a same-session entry is a settled retry. With one, an
  // empty id (still drafting) or a row the store says is not terminal is still in flight.
  const inFlight: InFlight = deps.inFlight ?? (() => false);

  /* THE WINDOW DOES NOT RUN OUT UNDER MONEY THAT IS STILL MOVING. stillInFlight already held an
     unconfirmed row carrying a hash, a handle or a nonce, and this swept the entry away at
     ninety seconds regardless. The deposit deadline table runs to 1440 seconds, so a row sitting
     at needs_reconciliation from t=120 s stopped colliding at all, and what an agent reads on
     that row is `terminal: true`. The reply sentence and the agent's own judgement were the only
     things left between it and a second send of the same money.
     Ninety seconds is unchanged for every settled row, which is what keeps this from ever being
     the reason a person cannot repeat an action they meant to repeat. */
  function expired(entry: { at: number; id: string }, at: number): boolean {
    if (at - entry.at <= windowMs) return false;
    // A claim with no id yet is a draft, which is a state that lasts a tick. Past the window it
    // is a draft that died without calling forget, and it goes: there is no row to ask about it,
    // and a fingerprint held forever by a proposal that never existed blocks the honest retry.
    return entry.id === '' || !inFlight(entry.id);
  }

  function sweep(): void {
    const at = now();
    for (const [key, entry] of seen) if (expired(entry, at)) seen.delete(key);
    /* Oldest first, because a Map iterates in insertion order and the oldest is the one whose
       race is furthest in the past. A row still in flight is skipped on the first pass: the cap
       is here so noise cannot grow the map without bound, and an unsettled claim is not noise.
       It can still be evicted if every entry is unsettled, because a bound that a caller can
       lift is not a bound. */
    for (const keepLive of [true, false]) {
      for (const [key, entry] of seen) {
        if (seen.size <= MAX_TRACKED) return;
        if (keepLive && entry.id !== '' && inFlight(entry.id)) continue;
        seen.delete(key);
      }
    }
  }

  return {
    find(kind, params, session) {
      sweep();
      const entry = seen.get(fingerprint(kind, params));
      if (entry === undefined) return null;
      // The caller's own repeat is refused only while its last one is still in flight: an empty
      // id (still drafting) or a row the store has not marked terminal. A settled one is a retry.
      if (entry.session === session && !(entry.id === '' || inFlight(entry.id))) return null;
      return { id: entry.id, session: entry.session };
    },
    remember(kind, params, session, id) {
      const key = fingerprint(kind, params);
      // Deleted first so a re-proposal moves to the end of the insertion order, which is what
      // makes the cap above evict the genuinely oldest entry rather than the first ever seen.
      // The claim's `at` is kept when the id is filled in, so the ninety seconds run from the
      // moment of the check rather than from the moment the rail answered.
      const claimed = seen.get(key);
      // Only when this call is filling in the id on THIS session's own claim. A genuine
      // re-proposal comes through the claim first, with an empty id, and that resets the clock.
      const fillingIn = claimed !== undefined && claimed.id === '' && claimed.session === session && id !== '';
      seen.delete(key);
      seen.set(key, { session, at: fillingIn ? claimed.at : now(), id });
      sweep();
    },
    forget(kind, params) {
      seen.delete(fingerprint(kind, params));
    },
    size: () => seen.size,
  };
}
