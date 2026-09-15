// What the proxy says when a call to the app does not come back cleanly.
//
// Its own module, not because it is large but because src/mcp.ts starts an stdio server and a
// heartbeat the instant it is imported, so nothing can unit test a value defined inside it. The
// same reason src/mcp-content.ts is separate.
//
// THREE SENTENCES, NOT ONE, AND THE DIFFERENCE IS WHERE THE MONEY IS.
// Every fetch failure used to become "the control app is not running", which reads as "it never
// happened, try again". On 2026-09-15 that is how "deposit $10" moved $20: the rail was still
// running at 43 s, the proxy's 30 s abort fired, the agent was told the app was down, and it
// proposed again.
// NOT_RUNNING is now only for a refused connection: nothing was sent, so a retry is safe. A
// timeout or a reset AFTER the request went out means the app took the call and may be executing
// a proposal right now, so the sentence says to check before repeating. A body that will not
// parse is the same danger from the other side: the app answered, so something happened.

export const NOT_RUNNING = 'The control app is not running. Start it with: npm run app';
export const STILL_WORKING =
  'The app took this call and has not answered within 30 seconds. If it was a propose, a proposal may exist and may be executing: read proposal_status (the id is in log_tail) before repeating anything.';
export const UNREADABLE_REPLY =
  'The app answered but the reply could not be read. Read log_tail and proposal_status before repeating anything.';

/* Which sentence a thrown fetch error earns. ECONNREFUSED and ENOTFOUND are the only "nothing
   was sent" cases: there was no socket to send on. Everything else that can be thrown here (the
   30 s timeout, an abort, a connection reset, a broken pipe, a socket closed mid-flight) means
   the request left this process, so the outcome is unknown and a blind retry can double a move.
   Node wraps the real cause a layer or two down (undici, then the system error), so this walks
   `cause` and reads `code` at each level. */
export function classifyProxyError(err: unknown): typeof NOT_RUNNING | typeof STILL_WORKING {
  const codes = new Set<string>();
  let node: unknown = err;
  for (let depth = 0; depth < 6 && node !== null && typeof node === 'object'; depth += 1) {
    const o = node as { code?: unknown; cause?: unknown };
    if (typeof o.code === 'string') codes.add(o.code);
    node = o.cause;
  }
  if (codes.has('ECONNREFUSED') || codes.has('ENOTFOUND')) return NOT_RUNNING;
  return STILL_WORKING;
}
