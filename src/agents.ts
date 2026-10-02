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
//   This is still not a security boundary on its own. The door in src/http/mcp.ts asks
//   `recognises` below before any op reaches the roster. A process holding the app's own seat
//   secret (it can read it off a running child's environment) can post as any session; see the
//   KNOWN HOLE note at the top of src/server.ts. One holding only the file secret, agent.secret,
//   posts only as a seat of its own, and that seat is OUTSIDE: every move it asks for waits for
//   the person's click until they allow it in the window (review gap 4, 2026-10-01).
//
//   The money path is still guarded, and now by something narrower than exclusivity. A member
//   holds a ROLE. An `operator` may propose; an `analyst` cannot, and the tools that would let
//   it are not registered for its process at all (src/mcp.ts reads PHOSPHOR_ROLE). Spawned
//   workers are analysts, so widening the door to a team did not widen the door to the wallet.
//
//   Approval is still a physical click a human makes. Nothing here approves anything, and
//   three agents cannot outvote a human.

import crypto from 'node:crypto';
import path from 'node:path';

import { allowOutside, markOutside } from './web-read.ts';

export type AgentRole = 'operator' | 'analyst';

/* Who started a seat, decided by which secret its first call carried and never by anything else
   on the wire. `app`: this app spawned it (PHOSPHOR_SEAT, which only the app's own children are
   given). `outside`: a proxy someone started by hand, which read agent.secret off the disk, and
   so may be any process running as this user (review gap 4, 2026-10-01). */
export type AgentOrigin = 'app' | 'outside';

export type AgentMember = {
  session: string;
  client: string;
  role: AgentRole;
  origin: AgentOrigin;
  /* An outside seat the person allowed with one click in the window. Until then every move it
     asks for waits for their click (src/web-read.ts OUTSIDE_REASON). Always true for an app seat. */
  allowed: boolean;
  // The person answered Ask each time: the window stops asking, and its moves keep waiting.
  later: boolean;
  /* Whether an Allow can bind to this seat: its proxy sent a key of its own (src/mcp.ts SEAT_KEY),
     so no other process holding the file secret can post as it. An outside seat with no key is
     never allowed, and every move it asks for waits. */
  askable: boolean;
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
// at its cap: waiting is correct, retrying immediately is not. `foreign` means the seat belongs
// to another process: the caller holds the file secret and posted as a seat it is not.
export type JoinBusy = { ok: false; member: AgentMember | null; error: string; revoked?: boolean; full?: boolean; foreign?: boolean };
export type JoinResult = JoinOk | JoinBusy;

export type AgentPresence = {
  /* No `role`. It used to be read off the body and it is decided by the seat now; a client may
     still send one and it is ignored, which is what makes the wire claim stop mattering. */
  /* Named by the app when it spawns a worker, before that worker's first call. This is the
     whole of the role decision: a session in here is an analyst and everything else is an
     operator, because everything else is an agent a human attached on purpose. */
  markAnalyst(session: string): void;
  /* Named by the app when it mints a chat's seat (src/http/chats.ts), before that chat's agent
     makes its first call. Like a worker's, the seat can then only be taken with the app's own
     secret: a hand-started proxy that read the id off /api/state cannot sit in it first. */
  markOwn(session: string): void;
  /* No `role`. It used to be read off the body and it is decided by the seat now; a client may
     still send one and it is ignored, which is what makes the wire claim stop mattering. */
  /* `secret` is one of this boot's seat secrets. The door has already checked it by the time a
     body reaches claim or check (see `recognises`); here it decides the seat's origin, and whether
     a NEW session may take one of the seats reserved for the agents this app starts (see
     RESERVED_SEATS). `key` is the outside proxy's own (src/mcp.ts SEAT_KEY), bound on its first
     call; a later call on that seat without it is refused as another process. */
  claim(params: { session?: unknown; client?: unknown; intervalMs?: unknown; label?: unknown; parent?: unknown; secret?: unknown; key?: unknown }): JoinResult;
  check(params: { session?: unknown; client?: unknown; secret?: unknown; key?: unknown }): JoinResult;
  /* Whether `supplied` is one of this boot's seat secrets. THE DOOR'S CREDENTIAL: src/http/mcp.ts
     asks this before any op, hello and bye included, reaches the roster or a handler. A roster
     built with no secret answers false to everything, which is closed rather than open. */
  recognises(supplied: unknown): boolean;
  /* The person's answer to an outside seat, from the window's card (src/http/agents.ts). Allow
     lifts the mark the seat started with, so its moves run under the policy like the app's own
     agent's; Ask each time keeps every move waiting and stops the window asking. Allow binds to the
     key the seat's proxy holds, so it is refused for a seat that sent none. */
  allow(session: unknown): { ok: true; member: AgentMember } | { ok: false; reason: string };
  later(session: unknown): AgentMember | null;
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
   first call), or the caller presented this boot's seat secret.
   Since the door started taking the secret on every op (src/http/mcp.ts), nothing without it
   reaches this roster at all, so every seated session is a recognised one and this reservation
   is a second wall behind the first. It stays because it costs nothing and because a roster
   built without a secret (every presence test) still needs the rule stated. */
export const RESERVED_SEATS = 4;

/* Where a proxy a human started by hand finds this boot's seat secret: one line, owner-readable
   only, written under the data directory by src/main.ts before the port opens and rewritten on
   every boot. The agents this app spawns get a DIFFERENT value through PHOSPHOR_SEAT and never
   read the file, which is how the door tells the two apart (AgentOrigin). src/mcp.ts reads it when
   the variable is absent; src/http/mcp.ts names it in the refusal, so a proxy that has neither is
   told where to look. */
export const SEAT_SECRET_FILE = 'agent.secret';

export function seatSecretPath(dataDir: string): string {
  return path.join(dataDir, SEAT_SECRET_FILE);
}

export type AgentOptions = {
  // Seats an unrecognised session may not take. Zero, the default, is the old behaviour and is
  // what every test that is about presence rather than about this gate keeps using.
  reserved?: number;
  /* This boot's seat secret for the agents the app spawns, off the shell's pipe (src/main.ts) and
     handed only to the app's own children. Empty means no caller can ever present one, which is
     correct rather than open: the app's own sessions are still recognised by id, and everything
     else is held to the unreserved seats. */
  secret?: string;
  /* The one written to agent.secret for proxies started by hand. A seat taken with it is
     `outside`. Empty means no hand-started proxy can attach at all. */
  handSecret?: string;
};

// How long an evicted session stays refused. It only has to outlive the evicted proxy's own
// exit, which happens on its very next heartbeat, so this is a wide margin and not a policy.
const REVOKE_MS = 300_000;

// Agent-controlled strings reach a status bar and an audit line. They are rendered as text
// everywhere, so this is about keeping a 4KB "client name" out of the log rather than about
// escaping: length and control characters, nothing else.
// Trimmed again after the cut, so a cleaned id cleans to itself: the door hands a seat's id on as
// its one name (src/http/mcp.ts), and every lookup here cleans what it is given.
function clean(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (stripped.length === 0) return fallback;
  return stripped.slice(0, max).trimEnd();
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
  const handSecret = opts.handSecret ?? '';
  /* Sessions this app spawned as workers. Ids are never removed: a worker's id becoming an
     operator's id by being forgotten is the one way this could widen, and they are uuids, one
     per worker, a few tens over a long session. */
  const analysts = new Set<string>();
  // Sessions this app minted for its chats, held to the app's secret like the workers'.
  const own = new Set<string>();
  /* Per outside seat: the hash of the key its proxy bound on its first call ('' for none), the
     key an Allow was given to, and the seats answered Ask each time. Kept off AgentMember, which the
     window and the agents read. */
  const keys = new Map<string, string>();
  const allowances = new Map<string, string>();
  const laters = new Set<string>();

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

  /* Counted, never named: a label is the words of whichever agent chose it, and this sentence
     reaches an agent that has no seat to be marked on (audit 2026-10-01). */
  function full(): JoinBusy {
    return {
      ok: false,
      member: null,
      full: true,
      error:
        `phosphor already has ${max} agents attached, which is the maximum. ` +
        'Wait for one to finish and stop sending heartbeats, or ask the human to drop one from the window. ' +
        'This is a capacity limit, not a rule against a second agent: several may drive at once.',
    };
  }

  /* The seat secret, compared the way src/http/auth.ts compares the window token: both sides
     hashed first, so neither length nor content leaks through the comparison, and an app with no
     secret matches nothing rather than matching everything.
     It is NOT as strong as the window token and the difference is worth stating. It reaches the
     agents this app spawns through childEnv, and `ps eww <pid>` prints the environment of any
     process this user owns, so a local process can read it off a running driver child; the file
     it is also written to (SEAT_SECRET_FILE) is readable by any process running as this user.
     What it closes is everything that is not that: a web page, a sandboxed iframe, an extension's
     native host with no shell, a process under another account, and any local process that
     did not go looking. Loopback TCP has no peer identity, and this is the credential in its
     place until the door moves to a socket that has one. */
  // The two secrets hashed once, here: every op on the door compares against both.
  const digest = (value: string): Buffer | null => (value.length === 0 ? null : crypto.createHash('sha256').update(value).digest());
  const ownDigest = digest(secret);
  const handDigest = digest(handSecret);

  // Which of the two `supplied` is: 'app', 'outside', or null for neither.
  function presented(supplied: unknown): AgentOrigin | null {
    if (typeof supplied !== 'string' || supplied.length === 0) return null;
    const a = crypto.createHash('sha256').update(supplied).digest();
    if (ownDigest !== null && crypto.timingSafeEqual(a, ownDigest)) return 'app';
    if (handDigest !== null && crypto.timingSafeEqual(a, handDigest)) return 'outside';
    return null;
  }

  function presentedSecret(supplied: unknown): boolean {
    return presented(supplied) !== null;
  }

  /* The origin a call proves by its secret. Only the hand secret makes a seat outside: a roster
     with no hand secret (every presence test) seats everything as the app's, as it always did. */
  function originOf(supplied: unknown): AgentOrigin {
    return presented(supplied) === 'outside' ? 'outside' : 'app';
  }

  // A proxy's own key, hashed, or '' when it sent none worth binding to.
  function keyOf(supplied: unknown): string {
    if (typeof supplied !== 'string' || supplied.length < 32 || supplied.length > 256) return '';
    return crypto.createHash('sha256').update(supplied).digest('hex');
  }

  function foreign(error: string): JoinBusy {
    return { ok: false, member: null, foreign: true, error };
  }

  function allowedNow(session: string): boolean {
    const bound = keys.get(session) ?? '';
    return bound !== '' && allowances.get(session) === bound;
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
    params: { session?: unknown; client?: unknown; intervalMs?: unknown; label?: unknown; parent?: unknown; secret?: unknown; key?: unknown },
    claiming: boolean,
  ): JoinResult {
    // An op with no session id is a curl, the e2e script, or an older mcp.ts. It is one member
    // like any other rather than a hole in the roster.
    const session = clean(params.session, 'unnamed-session', 64);
    const client = clean(params.client, 'unnamed agent', 48);
    const origin = originOf(params.secret);

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

    /* A call with the file secret posts only as the seat its own proxy took. Session ids are no
       secret (the window shows them, the log names them), so without this any process that read
       agent.secret could post as the app's own agent, or as an outside agent the person allowed. */
    if (origin === 'outside') {
      // A seat that lapsed binds nothing: it is dropped below, and its id is free to take.
      const held = liveOne(session);
      if ((held !== null && held.origin === 'app') || (held === null && (analysts.has(session) || own.has(session)))) {
        return foreign('that seat belongs to an agent Phosphor started, and this call is not from it. Start your own session.');
      }
      if (held !== null && keys.get(session) !== keyOf(params.key)) {
        return foreign('that seat belongs to another process. Start your own session.');
      }
    }

    const existing = liveOne(session);
    if (existing !== null) {
      // The same session re-announcing is not a new member. Its client name, label and ping
      // interval are allowed to move; its role, parent, origin and join time are not.
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
    for (const [id, m] of [...members]) if (expired(m)) drop(id);
    if (members.size >= max) return full();
    /* Recognised sessions reach the whole roster; everything else stops at the unreserved seats.
       Checked on this branch only, which is the one that creates a member: a session already
       seated keeps its seat, and neither the heartbeat nor a tool call re-argues for it. */
    const recognised = analysts.has(session) || presentedSecret(params.secret);
    if (!recognised && members.size >= max - reserved) return heldBack(max - reserved);

    if (origin === 'outside') keys.set(session, keyOf(params.key));
    const allowed = origin === 'app' || allowedNow(session);
    // The mark an outside seat starts with (src/web-read.ts), unless the person already allowed
    // this very proxy before its seat lapsed.
    if (!allowed) markOutside(session);
    const stamp = new Date(now()).toISOString();
    const member: AgentMember = {
      session,
      client,
      role: analysts.has(session) ? 'analyst' : 'operator',
      origin,
      allowed,
      later: origin === 'outside' && laters.has(session),
      askable: origin === 'outside' && (keys.get(session) ?? '') !== '',
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

  // A seat leaving the roster: the key its proxy bound goes with it, so the id can be taken again.
  function drop(session: string): void {
    members.delete(session);
    keys.delete(session);
  }

  // A seat the person ended or its proxy closed: its answer goes too.
  function end(session: string): void {
    drop(session);
    allowances.delete(session);
    laters.delete(session);
  }

  function leadOf(list: AgentMember[]): AgentMember | null {
    return list.find((m) => m.role === 'operator') ?? list[0] ?? null;
  }

  return {
    markAnalyst(session: string) {
      analysts.add(session);
    },
    markOwn(session: string) {
      own.add(session);
    },
    claim: (params) => resolve(params, true),
    recognises: (supplied) => presentedSecret(supplied),
    allow(session: unknown) {
      const m = liveOne(clean(session, '', 64));
      if (m === null) return { ok: false, reason: 'that agent is no longer connected' };
      if (m.origin === 'app') return { ok: true, member: m };
      if (!m.askable) return { ok: false, reason: 'that agent did not say who it is, so its moves always wait for your OK' };
      allowances.set(m.session, keys.get(m.session) ?? '');
      laters.delete(m.session);
      allowOutside(m.session);
      const updated: AgentMember = { ...m, allowed: true, later: false };
      members.set(m.session, updated);
      return { ok: true, member: updated };
    },
    later(session: unknown) {
      const m = liveOne(clean(session, '', 64));
      if (m === null || m.origin === 'app') return m;
      laters.add(m.session);
      const updated: AgentMember = { ...m, later: true };
      members.set(m.session, updated);
      return updated;
    },
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
      end(id);
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
        end(m.session);
        revoked.set(m.session, at + REVOKE_MS);
        if (!expired(m)) dropped.push(m);
      }
      return dropped;
    },
    sweep() {
      const gone: AgentMember[] = [];
      for (const [id, m] of [...members]) {
        if (!expired(m)) continue;
        drop(id);
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
