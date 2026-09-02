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
//   It does not refuse the same session. An agent repeating itself is retrying, that is its own
//   business, and the rails are idempotent enough for it. Blocking a retry would turn a network
//   blip into a stuck agent.
//
//   It does not persist. This guards a race between two agents working at the same moment, not
//   a human who asked for the same swap twice in an afternoon. A memory that outlived the app
//   would start refusing deliberate repeats and there would be no way to tell it apart.
//
//   It is not a lock and it is not security. Anything with a shell can post as any session (see
//   the KNOWN HOLE note at the top of src/server.ts), and two agents that genuinely both want
//   the same swap can have it a minute and a half apart. It removes an accident, not an attack.

export type Duplicate = { id: string; session: string };

export type DuplicateGuard = {
  // The proposal already in flight that this one would double, or null. `id` is empty when the
  // other agent's proposal is still being drafted, which is the case this guard exists for.
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

export function createDuplicateGuard(now: () => number = Date.now, windowMs = DUPLICATE_MS): DuplicateGuard {
  const seen = new Map<string, { session: string; at: number; id: string }>();

  function sweep(): void {
    const at = now();
    for (const [key, entry] of seen) if (at - entry.at > windowMs) seen.delete(key);
    // Oldest first, because a Map iterates in insertion order and the oldest is the one whose
    // race is furthest in the past.
    while (seen.size > MAX_TRACKED) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  return {
    find(kind, params, session) {
      sweep();
      const entry = seen.get(fingerprint(kind, params));
      if (entry === undefined || entry.session === session) return null;
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
