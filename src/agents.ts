// Who is driving this app. Plural, since 2026-08-21.
//
// WHAT CHANGED AND WHY. This file used to hold one seat: the first MCP session to speak took
// it and every other session was refused with a sentence telling it to wait. That rule was
// written for a real failure, and the failure is worth restating because nothing below
// pretends it went away: two agents driving one wallet looked exactly like one agent, and
// neither of them knew about the other. Exclusivity fixed the confusion by making the second
// agent impossible.
//
// It also made a team impossible, and a team is what the work actually wants. One agent
// reading the four hour while another reads the one minute, an analyst spawned to measure a
// second market, a research pass running beside the session the human is typing into: every
// one of those was refused by the seat, and the human's only route to two views was to run
// them one after the other.
//
// So the seat became a ROSTER, and the confusion is fixed the other way round: every member is
// named, every object it draws carries its id (see Provenance in src/chart.ts), and every
// agent can see the others through `agent_roster`. Two agents are no longer indistinguishable
// from one, so they no longer need to be forbidden.
//
// WHAT DID NOT CHANGE.
//
//   Presence is still a TTL over pings, because an MCP process cannot say goodbye when it is
//   killed. Each member carries its own TTL, derived from the interval its client declared.
//
//   This is still not a security boundary. Anything with a shell can post as any session; see
//   the KNOWN HOLE note at the top of src/server.ts. It is what keeps a team coordinated, not
//   what keeps an attacker out.
//
//   The money path is still guarded, and now by something narrower than exclusivity. A member
//   holds a ROLE. An `operator` may propose; an `analyst` cannot, and the tools that would let
//   it are not registered for its process at all (src/mcp.ts reads PHOSPHOR_ROLE). Spawned
//   workers are analysts, so widening the door to a team did not widen the door to the wallet.
//
//   Approval is still a physical click a human makes. Nothing here approves anything, and
//   three agents cannot outvote a human.

export type AgentRole = 'operator' | 'analyst';

export type AgentMember = {
  session: string;
  client: string;
  role: AgentRole;
  // A short human-readable name for the window and for the other agents. Defaults to the
  // client name; a worker is given one by whatever spawned it.
  label: string;
  // The session that spawned this one, or null for an agent a human started. It is what makes
  // the roster a tree rather than a list, which is the difference between "five agents are
  // connected" and "one agent and the four it put to work".
  parent: string | null;
  since: string; // ISO, when it joined
  lastSeen: string; // ISO, its most recent op or heartbeat
  ttlMs: number;
  // Tool calls this member has made this run. The window's roster line reads it, and so does
  // an agent deciding whether a colleague is actually working or merely attached.
  ops: number;
};

export type JoinOk = { ok: true; member: AgentMember; edge: boolean };
// `revoked` marks the one refusal an agent must not retry through. `full` means the roster is
// at its cap: waiting is correct, retrying immediately is not.
export type JoinBusy = { ok: false; member: AgentMember | null; error: string; revoked?: boolean; full?: boolean };
export type JoinResult = JoinOk | JoinBusy;

export type AgentPresence = {
  claim(params: { session?: unknown; client?: unknown; intervalMs?: unknown; role?: unknown; label?: unknown; parent?: unknown }): JoinResult;
  check(params: { session?: unknown; client?: unknown }): JoinResult;
  release(session: unknown): AgentMember | null;
  // The human replacing the agents, from the window. Frees the roster AND revokes every
  // session on it, which are two different things and both are needed: freeing alone would let
  // an evicted proxy simply rejoin on its next heartbeat, five seconds later.
  evict(session?: unknown): AgentMember[];
  // Turns lazy expiry into events. Returns the members that just went cold, once each.
  sweep(): AgentMember[];
  // The lead: the longest-attached operator, or null. It is who the window's chat surface
  // belongs to and who a human means by "the agent". It is NOT a permission: every operator
  // may do everything an operator may do.
  lead(): AgentMember | null;
  // Kept for every caller that predates the roster. It answers with the lead.
  holder(): AgentMember | null;
  roster(): AgentMember[];
  member(session: unknown): AgentMember | null;
  connected(): number;
  capacity(): { used: number; max: number };
  activityAt(): number | null;
};

// A client that names no interval is an older src/mcp.ts pinging every 15s. Its TTL has to
// stay above that or the light flaps; a client that declares one gets a TTL just wide enough
// for two missed pings.
const DEFAULT_TTL_MS = 45_000;
const MIN_TTL_MS = 8_000;
const MAX_TTL_MS = 60_000;

// How many agents may drive at once.
//
// Not one, and not unbounded. Every member is an MCP session holding a model on the other end,
// and the failure a cap prevents is not confusion any more (the roster fixed that), it is
// cost and noise: a runaway spawn loop would open sessions until the machine or the
// subscription gave out, and a chart with nine agents drawing on it is unreadable whatever the
// tags say. Six is two humans' worth of parallel work plus the workers they spawn.
export const MAX_AGENTS = 6;

// How long an evicted session stays refused. It only has to outlive the evicted proxy's own
// exit, which happens on its very next heartbeat, so this is a wide margin and not a policy.
const REVOKE_MS = 300_000;

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

// A role an agent claims for itself is a role it can lower and never raise. The app decides
// what a session may do by which tools it registered for that process (src/mcp.ts reads
// PHOSPHOR_ROLE from the environment the app itself wrote), so this field is a LABEL for the
// roster and the audit log, not the gate. Reading it as the gate would be the classic mistake:
// trusting a claim made by the thing being restricted.
function roleFrom(value: unknown): AgentRole {
  return value === 'analyst' ? 'analyst' : 'operator';
}

export function createAgents(now: () => number = Date.now, max: number = MAX_AGENTS): AgentPresence {
  const members = new Map<string, AgentMember>();
  let lastActivity: number | null = null;
  const revoked = new Map<string, number>();

  function expired(m: AgentMember): boolean {
    return now() - Date.parse(m.lastSeen) >= m.ttlMs;
  }

  // Lazy expiry, so connected() is honest the moment a TTL passes rather than at the next
  // sweep. sweep() is only how the drop becomes an audit line and an SSE push.
  function live(): AgentMember[] {
    const out: AgentMember[] = [];
    for (const m of members.values()) if (!expired(m)) out.push(m);
    // Oldest first, so the lead is stable: it is whoever has been here longest and it does not
    // change because a newer member happened to ping first.
    return out.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  }

  function liveOne(session: string): AgentMember | null {
    const m = members.get(session);
    if (m === undefined) return null;
    return expired(m) ? null : m;
  }

  function full(): JoinBusy {
    const names = live().map((m) => `${m.label} (${m.role})`).join(', ');
    return {
      ok: false,
      member: null,
      full: true,
      error:
        `phosphor already has ${max} agents attached (${names}), which is the maximum. ` +
        'Wait for one to finish and stop sending heartbeats, or ask the human to drop one from the window. ' +
        'This is a capacity limit, not a rule against a second agent: several may drive at once.',
    };
  }

  function resolve(
    params: { session?: unknown; client?: unknown; intervalMs?: unknown; role?: unknown; label?: unknown; parent?: unknown },
    claiming: boolean,
  ): JoinResult {
    // An op with no session id is a curl, the e2e script, or an older mcp.ts. It is one member
    // like any other rather than a hole in the roster.
    const session = clean(params.session, 'unnamed-session', 64);
    const client = clean(params.client, 'unnamed agent', 48);

    // Checked before the roster, deliberately. An evicted session that arrives while there is
    // room must still be refused, or the replacement it was evicted for would race it: the old
    // proxy is already pinging on a five second loop while the new terminal is still starting.
    const until = revoked.get(session);
    if (until !== undefined) {
      if (now() < until) {
        return {
          ok: false,
          member: null,
          revoked: true,
          error:
            'this session has been replaced from the phosphor window. Stop and let this connection ' +
            'close; do not retry.',
        };
      }
      revoked.delete(session);
    }

    const existing = liveOne(session);
    if (existing !== null) {
      // The same session re-announcing is not a new member. Its client name, label and ping
      // interval are allowed to move; its role, parent and join time are not.
      const updated: AgentMember = {
        ...existing,
        client: claiming ? client : existing.client,
        label: claiming ? clean(params.label, client, 40) : existing.label,
        ttlMs: claiming ? ttlFrom(params.intervalMs) : existing.ttlMs,
        lastSeen: new Date(now()).toISOString(),
        ops: claiming ? existing.ops : existing.ops + 1,
      };
      members.set(session, updated);
      return { ok: true, member: updated, edge: false };
    }

    // Expired members are dropped here rather than only in sweep(), so a roster that has gone
    // cold does not keep a live agent out until the next tick.
    for (const [id, m] of [...members]) if (expired(m)) members.delete(id);
    if (members.size >= max) return full();

    const stamp = new Date(now()).toISOString();
    const member: AgentMember = {
      session,
      client,
      role: roleFrom(params.role),
      label: clean(params.label, client, 40),
      parent: typeof params.parent === 'string' ? clean(params.parent, '', 64) || null : null,
      since: stamp,
      lastSeen: stamp,
      ttlMs: claiming ? ttlFrom(params.intervalMs) : DEFAULT_TTL_MS,
      ops: claiming ? 0 : 1,
    };
    members.set(session, member);
    return { ok: true, member, edge: true };
  }

  function leadOf(list: AgentMember[]): AgentMember | null {
    return list.find((m) => m.role === 'operator') ?? list[0] ?? null;
  }

  return {
    claim: (params) => resolve(params, true),
    check: (params) => {
      const result = resolve(params, false);
      // Stamped only on a granted op. A refused check is an agent being turned away, not a
      // member working, so lighting the presence light on it would report activity that never
      // happened. hello/bye never reach here (handleMcp answers them first), so this counts
      // tool calls and nothing else.
      if (result.ok) lastActivity = now();
      return result;
    },
    release(session: unknown) {
      const id = clean(session, 'unnamed-session', 64);
      const m = liveOne(id);
      members.delete(id);
      return m;
    },
    evict(session?: unknown) {
      const at = now();
      for (const [id, until] of revoked) if (at >= until) revoked.delete(id);
      // Naming a session drops that one; naming none drops the whole roster, which is what the
      // window's "replace the agent" control means and what the app does before it starts its
      // own driver.
      const targets =
        session === undefined || session === null
          ? [...members.values()]
          : [...members.values()].filter((m) => m.session === clean(session, '', 64));
      const dropped: AgentMember[] = [];
      for (const m of targets) {
        members.delete(m.session);
        revoked.set(m.session, at + REVOKE_MS);
        if (!expired(m)) dropped.push(m);
      }
      return dropped;
    },
    sweep() {
      const gone: AgentMember[] = [];
      for (const [id, m] of [...members]) {
        if (!expired(m)) continue;
        members.delete(id);
        gone.push(m);
      }
      return gone;
    },
    lead: () => leadOf(live()),
    holder: () => leadOf(live()),
    roster: () => live(),
    member: (session: unknown) => liveOne(clean(session, 'unnamed-session', 64)),
    connected: () => live().length,
    capacity: () => ({ used: live().length, max }),
    activityAt: () => lastActivity,
  };
}
