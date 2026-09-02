// One deadline for every network call this app makes.
//
// Node and undici fall back to a 300 second headers timeout when no signal is given, so before
// this every hang cost about five minutes of a wallet-holding process sitting still. Four of the
// sites were between "the human approved" and "the funds are irrecoverable": generate-intent,
// submit-intent (the signature is already released by then), a non-dry 1Click quote, and NEAR's
// send_tx. A five minute stall there is not slow, it is a user watching a spinner and deciding
// to try again, which is how the same amount gets sent twice.
//
// Two budgets, and the difference is what happens when the deadline fires.
//
//   READ, 10 s.  Balances, prices, candles, catalogues, statuses. Nothing is in flight at the
//   venue, so giving up costs a retry and nothing else. Ten seconds is already generous for a
//   JSON-RPC read; anything slower is a provider having a bad day and the app should say so
//   rather than freeze the screen.
//
//   VENUE WRITE, 30 s.  An order, a withdrawal, a signed intent, a broadcast. The request may
//   already have been accepted when the deadline fires, so the timeout is deliberately long
//   enough that hitting it means something is genuinely wrong, and every caller that can hit it
//   has to treat the outcome as UNKNOWN rather than as failed. That is why the number is three
//   times the read budget and not the same one.
//
// A timeout is not a failure to send. It is a failure to hear back, and the two are different
// sentences.

export const READ_TIMEOUT_MS = 10_000;
export const VENUE_WRITE_TIMEOUT_MS = 30_000;

// A fresh signal per request, always. AbortSignal.timeout starts its clock when it is created,
// so a shared signal would give the second request whatever was left of the first one's budget.
export function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export function readTimeout(): AbortSignal {
  return withTimeout(READ_TIMEOUT_MS);
}

export function venueWriteTimeout(): AbortSignal {
  return withTimeout(VENUE_WRITE_TIMEOUT_MS);
}

// Did this error come from one of the signals above? Node raises TimeoutError for
// AbortSignal.timeout and AbortError for a manual controller, and both arrive wrapped in
// different shapes depending on whether undici or viem was in the middle.
export function isTimeout(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== null ? isTimeout(cause) : false;
}
