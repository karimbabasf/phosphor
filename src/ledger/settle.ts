// Waiting for a balance to move, bounded.
//
// A venue saying SUCCESS and a balance showing it are two different moments, and the gap
// between them is where this app used to report a settled swap as "rose by 0". 1Click reports
// SUCCESS the instant the solver executes; the verifier read behind it asks NEAR at finality
// 'final', which is a block or two behind (src/chain/near.ts, the note on NearFinality). One
// read taken in that gap sees the balance from before the swap. So a read that must confirm a
// move is repeated: quickly at first, because the common case settles in about one block, then
// backing off, and never for longer than the window, because a read loop with no end is a
// process that never answers.
//
// Read only. Nothing here signs, sends, or retries anything that does.

export type RiseSchedule = {
  firstMs: number; // the first wait, doubled on every read that has not shown the rise
  maxMs: number; // the wait it backs off to
  timeoutMs: number; // the whole window, counted in waits asked for
};

// The verifier settles in about one NEAR block; a minute and a half is far past any observed lag.
export const INTENTS_SETTLE: RiseSchedule = { firstMs: 500, maxMs: 3_000, timeoutMs: 90_000 };
// A credit to HyperCore crosses a bridge first, so its window is longer.
export const HYPERLIQUID_SETTLE: RiseSchedule = { firstMs: 500, maxMs: 3_000, timeoutMs: 120_000 };

export type RiseWatch<T> = {
  // The newest read that answered, or null when none did inside the window.
  last: T | null;
  // Whether `last` showed the rise. False on a timeout, whatever `last` says short of it.
  rose: boolean;
  reads: number;
  waitedMs: number;
};

/* Reads until `rose(read)` is true or the window is spent. The first read is immediate: the
   common case has already settled by the time the venue answers.

   Bounded by the clock AND by the waits it has asked for, the same rule as the status poll in
   src/rails/intents-native.ts: the tests freeze the clock, and a loop that only reads the
   clock never leaves. A read that answers null (the verifier did not answer) is not a
   settlement and not a failure; it costs one wait. */
export async function watchRise<T>(opts: {
  read: () => Promise<T | null>;
  rose: (read: T) => boolean;
  schedule: RiseSchedule;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<RiseWatch<T>> {
  const { schedule } = opts;
  const deadline = opts.now() + schedule.timeoutMs;
  let last: T | null = null;
  let reads = 0;
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    const read = await opts.read();
    reads += 1;
    if (read !== null) {
      last = read;
      if (opts.rose(read)) return { last, rose: true, reads, waitedMs: waited };
    }
    const wait = Math.min(schedule.maxMs, schedule.firstMs * 2 ** attempt);
    if (opts.now() + wait > deadline || waited + wait > schedule.timeoutMs) break;
    await opts.sleep(wait);
    waited += wait;
  }
  return { last, rose: false, reads, waitedMs: waited };
}

/* What a rail read either side of a move, in the pocket the asset moved through: the verifier
   balance of the destination asset for an intents rail, the USDC on the account for a
   Hyperliquid rail. Base units as decimal strings, so a floor decision never round-trips a
   float. `after` is null until a read shows the move. A proposal that is still settling keeps
   this on its row and re-judges it on every ledger refresh (src/proposals/execute.ts). */
export type PocketRead = {
  venue: 'intents' | 'hyperliquid';
  account: string;
  assetId: string;
  symbol: string;
  decimals: number;
  before: string;
  after: string | null;
  // The least the balance has to rise by for the move to count as what was approved.
  floor: string;
};

// The rail's sentence for a move the venue confirmed and the balance has not shown. Never the
// word "failed": the money is most likely a block away, and "failed" is how a second copy of
// the same move gets signed.
export const SETTLING_SENTENCE =
  'The solver reports the swap settled and the balance has not shown it yet. ' +
  'Nothing more will be signed until the next balance read confirms it.';
