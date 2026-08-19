// Who is driving this app, and the rule that only one thing may.
//
// Two problems this owns, and they are the same problem seen from two sides.
//
// PRESENCE. An MCP process cannot say goodbye when it is killed, so absence of pings is
// the only honest signal and a TTL is the only honest test. What the old shape got wrong
// was the size of it: a 45s TTL swept every 15s meant a terminated agent read as connected
// for up to a minute. The TTL is now derived from the interval the client says it pings at,
// so the app is not guessing, and src/mcp.ts also sends a bye on shutdown, which makes the
// TTL the backstop for a SIGKILL rather than the mechanism for every exit.
//
// EXCLUSIVITY. Presence used to be one anonymous timestamp: two agents driving the same
// wallet looked exactly like one, and neither knew about the other. The seat below is the
// fix. One session holds it, every other session is refused with the reason, and the seat
// frees on bye or on expiry. It is deliberately not a security boundary (see the KNOWN HOLE
// note at the top of src/server.ts: anything with a shell can post as any session). It is
// what stops two agents on this machine racing each other by accident.

export type AgentSeat = {
  session: string;
  client: string;
  since: string; // ISO, when this session took the seat
  lastSeen: string; // ISO, its most recent op or heartbeat
  ttlMs: number;
};

export type SeatOk = { ok: true; seat: AgentSeat; edge: boolean };
// `revoked` marks the one refusal an agent must not retry through. Every other busy answer
// means "wait, somebody else is driving"; this one means "you have been replaced, stop".
export type SeatBusy = { ok: false; seat: AgentSeat | null; error: string; revoked?: boolean };
export type SeatResult = SeatOk | SeatBusy;

export type AgentPresence = {
  // A hello, or the first op of a session that never sent one. Takes the seat when it is
  // free, refuses when another live session holds it.
  claim(params: { session?: unknown; client?: unknown; intervalMs?: unknown }): SeatResult;
  // Every other op. Same rule as claim: an op from a session that never said hello takes
  // the free seat rather than being refused for a handshake it was not told to send.
  check(params: { session?: unknown; client?: unknown }): SeatResult;
  // A clean shutdown. Only the holder can release, so a stale bye cannot evict a live agent.
  release(session: unknown): AgentSeat | null;
  // The human replacing the agent, from the window. Frees the seat AND revokes the session,
  // which are two different things and both are needed: freeing alone would let the evicted
  // proxy simply take the seat back on its next heartbeat, five seconds later, because a free
  // seat is claimable by whoever asks first and it asks constantly.
  evict(): AgentSeat | null;
  // Turns lazy expiry into an event. Returns the seat that just went cold, once.
  sweep(): AgentSeat | null;
  holder(): AgentSeat | null;
  connected(): number;
  // The epoch-ms of the most recent REAL op (a tool call), or null if none this run. It is
  // the "is the agent actually working right now" signal the window's presence light reads:
  // heartbeats (op 'hello') do not touch it, so a connected-but-idle agent reports an old
  // timestamp and the light dulls, while a burst of reads and proposes keeps it fresh and the
  // light shines. This is deliberately recency, not an in-flight counter: the truth the human
  // wants is "did the thing I asked for just cause activity", and a call that starts brightens
  // the light for the whole window whether it takes 40ms or 4s.
  activityAt(): number | null;
};

// A client that names no interval is an older src/mcp.ts pinging every 15s. Its TTL has to
// stay above that or the light flaps; a client that declares one gets a TTL just wide
// enough for two missed pings.
const DEFAULT_TTL_MS = 45_000;
const MIN_TTL_MS = 8_000;
const MAX_TTL_MS = 60_000;

// Agent-controlled strings reach a status bar and an audit line. They are rendered as text
// everywhere, so this is about keeping a 4KB "client name" out of the log rather than about
// escaping: length and control characters, nothing else.
function clean(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (stripped.length === 0) return fallback;
  return stripped.slice(0, max);
}

function ttlFrom(intervalMs: unknown): number {
  const n = typeof intervalMs === 'number' ? intervalMs : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(n * 2.5)));
}

// How long an evicted session stays refused. It only has to outlive the evicted proxy's own
// exit, which happens on its very next heartbeat, so this is a wide margin and not a policy.
// Bounded rather than permanent because a session id could in principle be reused by a fresh
// process, and a map that only ever grows in a long-lived app is a leak.
const REVOKE_MS = 300_000;

export function createAgents(now: () => number = Date.now): AgentPresence {
  let seat: AgentSeat | null = null;
  let lastActivity: number | null = null;
  const revoked = new Map<string, number>();

  function expired(s: AgentSeat): boolean {
    return now() - Date.parse(s.lastSeen) >= s.ttlMs;
  }

  // Lazy expiry, so connected() is honest the moment the TTL passes rather than at the next
  // sweep. sweep() is only how the drop becomes an audit line and an SSE push.
  function live(): AgentSeat | null {
    if (seat === null) return null;
    return expired(seat) ? null : seat;
  }

  function take(session: string, client: string, ttlMs: number): SeatOk {
    const stamp = new Date(now()).toISOString();
    seat = { session, client, since: stamp, lastSeen: stamp, ttlMs };
    return { ok: true, seat, edge: true };
  }

  function touch(current: AgentSeat, client: string, ttlMs: number): SeatOk {
    seat = { ...current, client, ttlMs, lastSeen: new Date(now()).toISOString() };
    return { ok: true, seat, edge: false };
  }

  function busy(current: AgentSeat): SeatBusy {
    return {
      ok: false,
      seat: current,
      error:
        `another agent is already connected to phosphor (${current.client}, since ${current.since}). ` +
        'Only one agent may drive this app at a time. Disconnect that one, or wait for it to stop ' +
        'sending heartbeats, then try again.',
    };
  }

  function resolve(params: { session?: unknown; client?: unknown; intervalMs?: unknown }, claiming: boolean): SeatResult {
    // An op with no session id is a curl, the e2e script, or an older mcp.ts. It is one
    // occupant like any other rather than a hole in the rule: it can hold the seat, and it
    // is refused while somebody else does.
    const session = clean(params.session, 'unnamed-session', 64);
    const client = clean(params.client, 'unnamed agent', 48);

    // Checked before the seat, deliberately. An evicted session that arrives while the seat
    // happens to be free must still be refused, or the replacement it was evicted for would
    // lose the race to it: the old proxy is already pinging on a five second loop while the
    // new terminal is still starting a shell.
    const until = revoked.get(session);
    if (until !== undefined) {
      if (now() < until) {
        return {
          ok: false,
          seat: null,
          revoked: true,
          error:
            'this session has been replaced from the phosphor window. A newer agent now holds ' +
            'the seat. Stop and let this connection close; do not retry.',
        };
      }
      revoked.delete(session);
    }

    const current = live();
    if (current === null) {
      return take(session, client, claiming ? ttlFrom(params.intervalMs) : DEFAULT_TTL_MS);
    }
    if (current.session !== session) return busy(current);
    // The holder's own client name and ping interval are allowed to change on a re-hello:
    // the same session reconnecting is not a new occupant.
    return touch(current, claiming ? client : current.client, claiming ? ttlFrom(params.intervalMs) : current.ttlMs);
  }

  return {
    claim: (params) => resolve(params, true),
    check: (params) => {
      const result = resolve(params, false);
      // Stamped only on a granted op. A refused check is a SECOND agent being turned away,
      // not the holder working, so lighting the presence light on it would report the wrong
      // session's activity. hello/bye never reach here (handleMcp answers them first), so
      // this counts tool calls and nothing else.
      if (result.ok) lastActivity = now();
      return result;
    },
    release(session: unknown) {
      const current = live();
      if (current === null) return null;
      if (current.session !== clean(session, 'unnamed-session', 64)) return null;
      seat = null;
      return current;
    },
    evict() {
      const at = now();
      for (const [session, until] of revoked) if (at >= until) revoked.delete(session);
      const current = live();
      // The seat is cleared whether or not anyone held it, so a summon always leaves a clean
      // seat for the agent it is about to start.
      const held = seat;
      seat = null;
      if (held !== null) revoked.set(held.session, at + REVOKE_MS);
      return current;
    },
    sweep() {
      if (seat === null || !expired(seat)) return null;
      const gone = seat;
      seat = null;
      return gone;
    },
    holder: () => live(),
    connected: () => (live() === null ? 0 : 1),
    activityAt: () => lastActivity,
  };
}
