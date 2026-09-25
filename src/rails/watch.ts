// ONE STATUS WATCH FOR EVERY RAIL.
//
// Four rails polled a venue in four copies of one loop, and only the 1Click swap rail started
// fast: sends, payouts and the Hyperliquid moves slept a flat 3 or 5 s between reads, so a move
// the venue settled in a second showed on the card up to 5 s later (R5 A1 to A3). Every watch
// now starts a quarter second after the submit and doubles to the rail's own interval.
//
// Bounded by the clock AND by the waits it has already spent. A precomputed attempt count is
// wrong once the interval ramps, because many more short waits fit inside the same window. The
// clock alone is not enough either: `now` is injectable and the tests freeze it, so a loop that
// only reads the clock never leaves. Counting what it asked to sleep for ends on a stopped clock
// and agrees with it on a running one.

import { ONECLICK_TERMINAL, oneLine } from '../intents.ts';
import type { OneClickStatus } from '../intents.ts';
import type { RailHooks } from '../types.ts';
import { tell } from './oneclick-words.ts';

export const FIRST_POLL_MS = 250;

export type PollPlan = {
  firstMs: number; // the first wait; each one after doubles
  everyMs: number; // the longest wait between two reads
  timeoutMs: number; // the whole window
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/* Runs `step` until it says done or the window is spent. `step` reads once and answers whether
   that read ends the watch; it must not throw (a read that fails is its caller's to record).
   Returns how long it waited in all. */
export async function pollUntil(plan: PollPlan, step: () => Promise<boolean>): Promise<number> {
  const deadline = plan.now() + plan.timeoutMs;
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    if (await step()) return waited;
    const wait = Math.min(plan.everyMs, plan.firstMs * 2 ** attempt);
    if (plan.now() + wait >= deadline || waited + wait >= plan.timeoutMs) return waited;
    await plan.sleep(wait);
    waited += wait;
  }
}

/* A 1Click order, by its deposit handle, until a terminal status or the window ends. Never
   throws once the money is on its way: a status endpoint that goes down after the move must not
   become a thrown "nothing happened". Every read tells the executor 1Click's own word for the
   stage, so the card moves as the order does. `over` is asked after a read that is not terminal
   and ends the watch when it says so: the rail's own proof that the move can no longer happen
   (the intents-native swap's signed transfer past its deadline). One that throws says no. */
export async function watchOneClick(
  plan: PollPlan,
  status: (handle: string) => Promise<OneClickStatus>,
  handle: string,
  hooks?: RailHooks,
  over?: () => Promise<boolean>,
): Promise<OneClickStatus> {
  let last: OneClickStatus = {
    found: false,
    status: 'PENDING_DEPOSIT',
    reported: 'not polled',
    originTxHashes: [],
    destinationTxHashes: [],
    nearTxHashes: [],
  };
  await pollUntil(plan, async () => {
    try {
      last = await status(handle);
      tell(hooks, { providerStage: last.status });
      if ((ONECLICK_TERMINAL as readonly string[]).includes(last.status)) return true;
    } catch (err) {
      last = { ...last, reported: `status check failed: ${oneLine(err instanceof Error ? err.message : String(err), 80)}` };
    }
    return over === undefined ? false : over().catch(() => false);
  });
  return last;
}
