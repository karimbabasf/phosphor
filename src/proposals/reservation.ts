// Where the one-at-a-time queue ends.
//
// Every propose and every approve runs through one promise chain, and it has to: the spend cap
// is only a cap if "read the spend, decide, reserve" is indivisible. Five concurrent $10,000
// consolidations moved $50,000 against a $25,000 limit before that chain existed, because each
// one read a spend of zero.
//
// But the chain used to cover the WHOLE job, and a job ends in a rail. A rail sitting in
// watchStatus holds it for up to five minutes, and for those five minutes a human could not
// approve, refuse or cancel anything, including the thing that was stuck. The queue meant to stop
// two proposals racing was stopping a person reaching the brake.
//
// So it is cut in two. The reservation is the last thing that needs to be serialised: once a
// proposal is on disk as `executing`, sessionSpentUsd counts it, and the next caller reads a
// spend figure that already includes it. Everything after that (the broadcast, the status poll,
// the receipt) is a network wait with no shared state in it, and it runs outside.
//
// AsyncLocalStorage rather than an argument threaded through eleven propose functions and four
// executors. The reservation point is eight frames below the queue, the value is per-call, and
// concurrent calls must not see each other's: that is exactly the problem this facility exists
// for, and it is in node's standard library.

import { AsyncLocalStorage } from 'node:async_hooks';

type Slot = { release: () => void; released: boolean };

const current = new AsyncLocalStorage<Slot>();

/* Runs `fn` with a reservation slot bound to it. `release` moves the queue on; it is called by
   reservationMade() below, or, if the job never reaches a reservation, when the job settles. */
export function withReservation<T>(release: () => void, fn: () => Promise<T>): Promise<T> {
  const slot: Slot = {
    released: false,
    release: () => {
      if (slot.released) return;
      slot.released = true;
      release();
    },
  };
  return current.run(slot, async () => {
    try {
      return await fn();
    } finally {
      // A job that ended without reserving anything (a refusal, a throw, a policy change) still
      // has to let the queue move. Idempotent, so reaching here after reservationMade() is fine.
      slot.release();
    }
  });
}

/* Called at the exact moment a proposal's budget is on disk. Everything after this point runs
   outside the queue: the next caller can start reading and deciding while this one waits on a
   venue. Outside a withReservation, it does nothing, which is what makes it safe to call from
   code paths that are also reached directly by tests. */
export function reservationMade(): void {
  current.getStore()?.release();
}

// For tests: is this code running inside a reservation, and has it been released?
export function reservationState(): { inside: boolean; released: boolean } {
  const slot = current.getStore();
  return { inside: slot !== undefined, released: slot?.released ?? false };
}
