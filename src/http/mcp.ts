// The one route the MCP proxy speaks, and everything behind it: the cross-origin gate, the seat
// (hello, bye and the two refusals), the audited op label, and the dispatch to the six op
// handlers. The read table is assembled here too, because a read is one of those ops.
//
// Every op that reads, proposes or moves the window is audit-logged as a tool_call before
// dispatch, arguments included, each string cut to MAX_LOGGED_CHARS. The one op that is not is
// the presence heartbeat: it is logged as agent_connected and agent_disconnected on the edges,
// because a line every 15s buries the transcript it is meant to sit in.

import type http from 'node:http';

import { SEAT_SECRET_FILE, seatSecretPath } from '../agents.ts';
import { oneLine } from '../intents.ts';
import { sameOrigin } from './auth.ts';
import { asRecord, capLabel, capStrings, fail, oversizeString, readBody, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';

// The longest string any op on this door takes, and the longest one the audit line keeps. The
// propose door caps its own fields lower (src/http/propose.ts); a chart label, a search query
// or a policy sentence has no business past a kilobyte.
export const MAX_ARG_CHARS = 1024;
export const MAX_LOGGED_CHARS = 256;
import { agentReads } from './read/agents.ts';
import { chainReads } from './read/chain.ts';
import { chartReads } from './read/chart.ts';
import { marketReads } from './read/market.ts';
import { swapReads } from './read/swap.ts';
import { tradeReads } from './read/trade.ts';
import { walletReads } from './read/wallet.ts';
import { handlePropose } from './propose.ts';
import { handleView } from './view.ts';
import { handleSetBasicCoins, handleSetViewMode } from './mutation.ts';
import { LEAD_ONLY_READ_TOOLS, READ_TOOLS } from './context.ts';
import type { Ctx, ReadTable } from './context.ts';

/* Every read tool, in one table assembled from the seven domain files under http/read. A table
   rather than the if-chain it replaces: a chain answers "unknown read tool" for a tool it then
   lists as known the moment a branch above it falls through, which is exactly the break the
   view chain carried for a while (see the note in view.ts). */
const READS: ReadTable = {
  ...walletReads,
  ...marketReads,
  ...chartReads,
  ...agentReads,
  ...tradeReads,
  ...chainReads,
  ...swapReads,
};

// The table's own keys, for the test that holds READ_TOOLS and this in step. A tool listed in
// the refusal message and missing from the table is a tool an agent is told it has and cannot
// call; a tool in the table and off the list is one nobody is told about. Both were possible.
export function readToolNames(): string[] {
  return Object.keys(READS);
}

export async function handleRead(ctx: Ctx, body: JsonBody, res: http.ServerResponse): Promise<void> {
  const tool = String(body.tool ?? '');
  const handler = READS[tool];
  if (handler === undefined) {
    fail(res, 400, `unknown read tool: ${tool}. known tools: ${READ_TOOLS.join(', ')}`);
    return;
  }
  // The proxy never registers this for a worker, and this is the wall behind it, the same one
  // handleView holds: the seat's role, decided by the roster and never by anything the body claims.
  if ((LEAD_ONLY_READ_TOOLS as readonly string[]).includes(tool) && ctx.agents.member(body.session)?.role === 'analyst') {
    fail(res, 403, `${tool} is not on a worker's surface`);
    return;
  }
  await handler(ctx, body, asRecord(body.args), res);
}

/* One audit line per key, then silence, over a set that cannot grow past a few hundred. The
   keys are caller-chosen strings (a session, a client name), and a process guessing them would
   otherwise fill memory one refusal at a time. Oldest out first: a long-running app forgets a
   refusal it logged hours ago rather than refusing to log a new one. */
const MAX_REFUSALS_REMEMBERED = 200;
function firstRefusal(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  while (seen.size > MAX_REFUSALS_REMEMBERED) {
    const oldest = seen.values().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
  return true;
}

function rejectSeat(ctx: Ctx, error: string, body: JsonBody, res: http.ServerResponse, revoked = false): void {
  const session = oneLine(body.session ?? 'unnamed-session', 80);
  if (revoked) {
    // A replaced agent is not a second agent that showed up: the human took the seat off it
    // on purpose. It gets its own marker so the proxy exits instead of reporting a busy
    // seat to a model that would then keep asking. Not deduplicated by session either,
    // because there is exactly one of these per eviction.
    ctx.audit.append('agent_disconnected', 'a replaced agent was refused and told to stop', {
      op: String(body.op ?? ''),
      client: body.client,
    });
    fail(res, 409, error, { seat: 'revoked' });
    return;
  }
  if (firstRefusal(ctx.seats, `roster:${session}`)) {
    // Not "a second agent was refused" any more: a second agent is welcome. This line is now
    // only ever a FULL roster, which is a capacity fact and reads differently in a log.
    ctx.audit.append('agent_rejected', 'an agent tried to attach to a full roster and was refused', {
      op: String(body.op ?? ''),
      client: body.client === undefined ? undefined : oneLine(body.client, 80),
      attached: ctx.agents.roster().map((m) => m.label),
    });
  }
  // seat:'busy' is the marker src/mcp.ts unwraps into a plain sentence for the agent. The
  // name is kept because the proxy, the e2e script and older builds all read it; what it
  // means has narrowed from "somebody else is driving" to "there is no room right now".
  // It is deliberately not "any 409": the view-mode refusal is also a 409 and must keep its
  // JSON shape, which is what the e2e script and the browser both read.
  fail(res, 409, error, { seat: 'busy' });
}

// The header every answer on this door carries: which screen the window is on. The proxy
// (src/mcp.ts) turns it into the last line of every tool result. A header rather than a field,
// because forty handlers build their own bodies and the tests hold those shapes.
export const SCREEN_HEADER = 'x-phosphor-screen';

/* THE SCREEN RIDES ON EVERY ANSWER, and it is read when the answer is written. An agent used to
   learn the screen once, from `start`, and then from nothing: the human's tabs moved the window
   and no tool result said so, so it went on describing the screen it remembered (Karim,
   2026-09-14). Stamped as the head goes out rather than before dispatch, because a switch has
   to answer with the screen it moved to, and the ops that move the window are the ones being
   dispatched. */
function stampScreen(ctx: Ctx, res: http.ServerResponse): void {
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((...args: Parameters<typeof writeHead>) => {
    res.setHeader(SCREEN_HEADER, ctx.getView());
    return writeHead(...args);
  }) as typeof res.writeHead;
}

/* The sentence a caller without the secret is refused with. It names the file and the variable
   because the caller it is written for is a proxy a human started by hand against an app that
   has since rebooted, or one started with no data directory in its environment: what it needs is
   where to look, not a lecture. The secret's value is the one thing it must not carry. */
function seatSecretRefusal(ctx: Ctx): string {
  return (
    'this call carried no seat secret, or a wrong one, and every /api/mcp op needs this boot\'s. ' +
    `The app writes it to ${seatSecretPath(ctx.cfg.dataDir)} at boot (one line, owner-readable only, new each boot); ` +
    `src/mcp.ts reads ${SEAT_SECRET_FILE} from the data directory it resolves, or PHOSPHOR_SEAT when the app spawned it.`
  );
}

export async function handleMcp(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  stampScreen(ctx, res);
  /* The money surface gets the same cross-origin guard the approval and trade routes already
     carry. handleMcp is where an agent proposes and, at or under the click threshold, executes, so
     a page that could POST here blind (classic CSRF: a cross-origin fetch still sends Origin) was
     the one mutating route a browser could drive.
     AN ABSENT ORIGIN IS REFUSED, and so is the literal `null` a sandboxed iframe sends. This
     comment said the opposite for a while and src/http/auth.ts had already stopped meaning it: a
     present, matching Origin is required. Origin is a forbidden header name, so a page cannot set
     one, and a local process can, which is exactly the split this line wants. The MCP proxy sends
     it (POST_HEADERS in src/mcp.ts) and so must anything else calling this route by hand.
     It is the first wall and not the only one: a local process can set Origin, and the seat
     secret below is what holds that process out. */
  if (!sameOrigin(req)) {
    ctx.audit.append('agent_rejected', 'an /api/mcp call was refused as cross-origin', {
      origin: req.headers.origin ?? '(absent)',
      host: req.headers.host ?? '(absent)',
    });
    fail(res, 403, 'cross-origin request refused');
    return;
  }
  const parsed = await readBody(req);
  if (!parsed.ok) {
    fail(res, parsed.status, parsed.error);
    return;
  }
  const body = parsed.value;
  const op = String(body.op ?? '');
  /* THE BODY THAT IS LOGGED IS THE BODY WITHOUT ITS CREDENTIALS. The proxy sends this boot's seat
     secret on the hello and on every call (src/mcp.ts). Logged verbatim, it sat on audit.jsonl,
     which log_tail hands to every agent, a worker included, and GET /api/log hands to any local
     process, so the credential the door checks below was open to anyone who read the log. The
     arguments, the session and the client name are the record; the secret was never part of it.
     A token is stripped for the same reason, in case a caller ever sends one here. */
  const { secret: _secret, token: _token, ...logged } = body;

  /* THE SEAT SECRET, ON EVERY OP, FROM EVERY SESSION. Origin above is a header any local process
     sets, and this door is where a propose at or under the click threshold executes with no human
     in the loop; the roster seated any session string and the policy engine answered `allow`. So
     every op, hello and bye included, presents this boot's secret or stops here, before the roster
     sees the session, before the audit sees the arguments and before any handler runs. The agents
     this app spawns carry it in PHOSPHOR_SEAT; a hand-started proxy reads it off the file named in
     the refusal. Compared hashed and constant-time in src/agents.ts.
     One audit line per refused CLIENT, the way a full roster is logged: the proxy's heartbeat
     alone is one attempt every five seconds, and the refusal is never silent, only the log is.
     The line names the session, the client and the op, and never the value, right or wrong.
     BOTH STRINGS ARE THE CALLER'S AND BOTH ARE CAPPED. They were written raw, bounded only by
     the body cap, so a process with no secret could put a megabyte into the log that log_tail
     hands to every agent, once per invented session string, and grow the set below by one
     entry each time. A session that failed the secret is never seated in that set. */
  if (!ctx.agents.recognises(body.secret)) {
    const client = body.client === undefined ? undefined : oneLine(body.client, 80);
    if (firstRefusal(ctx.seats, `secret:${client ?? ''}`)) {
      ctx.audit.append('agent_rejected', 'an /api/mcp call was refused: it carried no seat secret, or a wrong one', {
        op,
        session: oneLine(body.session ?? 'unnamed-session', 80),
        client,
        secretPresent: typeof body.secret === 'string' && body.secret.length > 0,
      });
    }
    fail(res, 401, seatSecretRefusal(ctx));
    return;
  }

  /* EVERY STRING ON THIS DOOR HAS A CEILING, checked once here for hello, read, propose and the
     window ops alike, before anything is seated, logged or drafted. The body cap is 1 MiB, and
     nothing under it bounded a single argument: a 900 KiB symbol went through the propose door
     into the refusal reason, proposals.json and every state frame the window was sent after
     it. The propose door holds each of its fields tighter still (src/http/propose.ts); this is
     the ceiling for everything else, chart labels and search queries included. */
  const oversize = oversizeString(body, MAX_ARG_CHARS);
  if (oversize !== null) {
    fail(res, 400, `${oversize.path} is ${oversize.length} characters, over the ${MAX_ARG_CHARS} this door takes`);
    return;
  }

  // The presence heartbeat is not a tool call, so it is answered before the
  // append below and never enters the transcript. mcp.ts pings for the whole life
  // of an agent session: on 2026-08-12, with two sessions open, 242 of 418 audit
  // lines were heartbeats and the real calls were buried. Only the edges are worth
  // a line, and the seat below reports them.
  if (op === 'hello') {
    // The client name is agent-controlled. It stays in data, where it is stored
    // verbatim and rendered as data, and out of msg, where a crafted value could
    // dress a heartbeat up as some other event in the log column.
    const claim = ctx.agents.claim(body);
    if (!claim.ok) {
      rejectSeat(ctx, claim.error, body, res, claim.revoked === true);
      return;
    }
    if (claim.edge) ctx.audit.append('agent_connected', 'an agent attached to phosphor', logged);
    ctx.sse.broadcastState();
    sendJson(res, 200, {
      ok: true,
      seat: 'held',
      since: claim.member.since,
      role: claim.member.role,
      label: claim.member.label,
      // What the joining agent needs to know before its first turn: it is not alone, and who
      // else is here. An agent that discovers a colleague by finding a level it did not draw
      // has already wasted a turn being confused.
      roster: ctx.agents.roster().map((m) => ({ label: m.label, role: m.role, since: m.since })),
    });
    return;
  }

  // A clean shutdown, which is what makes the light go out the moment an agent is
  // terminated rather than one TTL later. Only the holder can free its own seat.
  if (op === 'bye') {
    const freed = ctx.agents.release(body.session);
    if (freed !== null) {
      ctx.audit.append('agent_disconnected', 'the agent disconnected', { client: freed.client, since: freed.since });
      ctx.sse.broadcastState();
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // Every other op is on the roster or is refused. An op from a session that never said
  // hello joins: an agent should not have to know about a handshake to be counted as
  // connected, and something has to be attached for a tool call to exist.
  const seat = ctx.agents.check(body);
  if (!seat.ok) {
    rejectSeat(ctx, seat.error, body, res, seat.revoked === true);
    return;
  }
  if (seat.edge) {
    ctx.audit.append('agent_connected', 'an agent attached to phosphor', logged);
    // An agent that joined on its first op (no hello) is connected NOW. Push state so
    // the window's `agent` field and presence light say so at once rather than at the next
    // heartbeat up to a TTL later. The hello path already does this; this covers the rest.
    ctx.sse.broadcastState();
  }
  // A granted tool call is the agent working. Tell the window so its presence light shines
  // now rather than at the next state push, which for a pure read would never come.
  ctx.sse.broadcastActivity();

  const label =
    op === 'read'
      ? `read ${String(body.tool ?? '?')}`
      : op === 'propose'
        ? `propose ${String(body.kind ?? '?')}`
        // 'view' is the chart's render state. 'set_view_mode' is which of the two
        // screens the window shows. Two different things, deliberately named apart.
        : op === 'view'
          ? `chart ${String(body.tool ?? '?')}`
          : op === 'set_view_mode'
            ? `set_view_mode ${String(body.mode ?? '?')}`
            : op === 'set_basic_coins'
              ? `set_basic_coins ${(Array.isArray(body.coins) ? body.coins : []).join(' ')}`
              : `unknown op ${op}`;
  // Contract: every op that reads, proposes or moves the window is audit-logged before
  // dispatch, arguments included. The credentials are not arguments, and a string is kept to
  // its first MAX_LOGGED_CHARS with its length: the log is what log_tail hands every agent.
  ctx.audit.append('tool_call', `agent: ${capLabel(label)}`, capStrings(logged, MAX_LOGGED_CHARS) as JsonBody);

  if (op === 'read') {
    await handleRead(ctx, body, res);
    return;
  }
  if (op === 'propose') {
    await handlePropose(ctx, body, res);
    return;
  }
  if (op === 'view') {
    await handleView(ctx, body, res);
    return;
  }
  if (op === 'set_view_mode') {
    handleSetViewMode(ctx, body, res);
    return;
  }
  if (op === 'set_basic_coins') {
    await handleSetBasicCoins(ctx, body, res);
    return;
  }
  fail(
    res,
    400,
    `unknown op: ${op}. known ops: hello, bye, read, propose, view, set_view_mode, set_basic_coins`,
  );
}
