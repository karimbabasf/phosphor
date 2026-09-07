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

import crypto from 'node:crypto';

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
  /* No `role`. It used to be read off the body and it is decided by the seat now; a client may
     still send one and it is ignored, which is what makes the wire claim stop mattering. */
  /* Named by the app when it spawns a worker, before that worker's first call. This is the
     whole of the role decision: a session in here is an analyst and everything else is an
     operator, because everything else is an agent a human attached on purpose. */
  markAnalyst(session: string): void;
  /* No `role`. It used to be read off the body and it is decided by the seat now; a client may
     still send one and it is ignored, which is what makes the wire claim stop mattering. */
  /* `secret` is this boot's seat secret, if the caller has one. It is not a role and it is not an
     authorisation for anything the agent does: it only decides whether a NEW session may take one
     of the seats reserved for the agents this app starts. See RESERVED_SEATS. */
  claim(params: { session?: unknown; client?: unknown; intervalMs?: unknown; label?: unknown; parent?: unknown; secret?: unknown }): JoinResult;
  check(params: { session?: unknown; client?: unknown; secret?: unknown }): JoinResult;
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

/* How many of those seats an unrecognised session may never take.

   THE FAILURE THIS PREVENTS. `hello` runs before any credential check and there is none on that
   route, so six unauthenticated POSTs filled the roster and every later arrival got the 409 above,
   including the app's own agent. The human pressed Start and nothing could attach; re-sending the
   six every five seconds held it there. Availability of the money surface, taken by anything with
   a shell and a loop.
   Four is one driver plus the three workers MAX_WORKERS in src/crew.ts allows, so the app can run
   a full crew while an attacker holds every seat it is allowed to hold. The two that are left are
   the two hand-attached agents the cap was sized for in the first place.
   RECOGNISED means one of two things, and neither can be claimed on the wire: the session id is
   one this app minted (it spawns the driver and every worker, so it knows their ids before their
   first call), or the caller presented this boot's seat secret, which reaches an agent this app
   spawned through childEnv and reaches nothing else. */
export const RESERVED_SEATS = 4;

export type AgentOptions = {
  // Seats an unrecognised session may not take. Zero, the default, is the old behaviour and is
  // what every test that is about presence rather than about this gate keeps using.
  reserved?: number;
  /* This boot's seat secret, off the shell's pipe (src/main.ts). Empty means no caller can ever
     present one, which is correct rather than open: the app's own sessions are still recognised by
     id, and everything else is held to the unreserved seats. */
  secret?: string;
};

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

/* THE ROLE IS DECIDED HERE, NOT ON THE WIRE.
   `body.role` used to set it. That was documented as a label rather than a gate, and it was
   true as far as it went: the real restriction is which tools src/mcp.ts REGISTERS for a
   process, from the PHOSPHOR_ROLE the app itself wrote into that child's environment. Reading
   a self-claim into anything is still the classic mistake, and the wire field is gone.
   What decides instead is the seat: this app knows which sessions it spawned, because it minted
   their ids, and it spawns analysts. Everything else is an agent a human attached on purpose,
   which is an operator. A worker that posted `role: "operator"` now gets analyst, and a
   hand-written client claiming either gets the answer the app already held. */
export function createAgents(
  now: () => number = Date.now,
  max: number = MAX_AGENTS,
  opts: AgentOptions = {},
): AgentPresence {
  const members = new Map<string, AgentMember>();
  let lastActivity: number | null = null;
  const revoked = new Map<string, number>();
  const reserved = Math.max(0, Math.min(max, opts.reserved ?? 0));
  const secret = opts.secret ?? '';
  /* Sessions this app spawned as workers. Ids are never removed: a worker's id becoming an
     operator's id by being forgotten is the one way this could widen, and they are uuids, one
     per worker, a few tens over a long session. */
  const analysts = new Set<string>();

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

  /* The seat secret, compared the way src/http/auth.ts compares the window token: both sides
     hashed first, so neither length nor content leaks through the comparison, and an app with no
     secret matches nothing rather than matching everything.
     It is NOT as strong as the window token and the difference is worth stating. It reaches the
     agents this app spawns through childEnv, and `ps eww <pid>` prints the environment of any
     process this user owns, so a local process can read it off a running driver child. That is
     survivable because of when the attack lands: the roster is filled BEFORE the human presses
     Start, when there is no child to read it from. Recognition by minted session id, below, does
     not depend on it at all. */
  function presentedSecret(supplied: unknown): boolean {
    if (secret.length === 0) return false;
    if (typeof supplied !== 'string' || supplied.length === 0) return false;
    const a = crypto.createHash('sha256').update(supplied).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function heldBack(free: number): JoinBusy {
    return {
      ok: false,
      member: null,
      full: true,
      error:
        `phosphor is holding its last ${reserved} seat(s) for the agents it starts itself, and ${free} are free to ` +
        'anything else. Ask the human to drop an agent from the window, or start this one from inside Phosphor. ' +
        'This is a capacity rule, not a rule against a second agent: several may drive at once.',
    };
  }

  function resolve(
    params: { session?: unknown; client?: unknown; intervalMs?: unknown; label?: unknown; parent?: unknown; secret?: unknown },
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
    /* Recognised sessions reach the whole roster; everything else stops at the unreserved seats.
       Checked on this branch only, which is the one that creates a member: a session already
       seated keeps its seat, and neither the heartbeat nor a tool call re-argues for it. */
    const recognised = analysts.has(session) || presentedSecret(params.secret);
    if (!recognised && members.size >= max - reserved) return heldBack(max - reserved);

    const stamp = new Date(now()).toISOString();
    const member: AgentMember = {
      session,
      client,
      role: analysts.has(session) ? 'analyst' : 'operator',
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
    markAnalyst(session: string) {
      analysts.add(session);
    },
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
