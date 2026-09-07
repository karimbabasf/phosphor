// The one route the MCP proxy speaks, and everything behind it: the cross-origin gate, the seat
// (hello, bye and the two refusals), the audited op label, and the dispatch to the six op
// handlers. The read table is assembled here too, because a read is one of those ops.
//
// Every op that reads, proposes or moves the window is audit-logged as a tool_call before
// dispatch, arguments included verbatim. The one op that is not is the presence heartbeat: it
// is logged as agent_connected and agent_disconnected on the edges, because a line every 15s
// buries the transcript it is meant to sit in.

import type http from 'node:http';

import { sameOrigin } from './auth.ts';
import { asRecord, capLabel, fail, readBody, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { agentReads } from './read/agents.ts';
import { chartReads } from './read/chart.ts';
import { gasReads } from './read/gas.ts';
import { marketReads } from './read/market.ts';
import { tradeReads } from './read/trade.ts';
import { walletReads } from './read/wallet.ts';
import { yieldReads } from './read/yield.ts';
import { handlePropose } from './propose.ts';
import { handleView } from './view.ts';
import { handleSetBasicCoins, handleSetViewMode, handleYieldAuto } from './mutation.ts';
import { READ_TOOLS } from './context.ts';
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
  ...yieldReads,
  ...gasReads,
  ...tradeReads,
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
  await handler(ctx, body, asRecord(body.args), res);
}

function rejectSeat(ctx: Ctx, error: string, body: JsonBody, res: http.ServerResponse, revoked = false): void {
  const session = String(body.session ?? 'unnamed-session');
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
  if (!ctx.seats.has(session)) {
    ctx.seats.add(session);
    // Not "a second agent was refused" any more: a second agent is welcome. This line is now
    // only ever a FULL roster, which is a capacity fact and reads differently in a log.
    ctx.audit.append('agent_rejected', 'an agent tried to attach to a full roster and was refused', {
      op: String(body.op ?? ''),
      client: body.client,
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

export async function handleMcp(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  /* The money surface gets the same cross-origin guard the approval and trade routes already
     carry. handleMcp is where an agent proposes and, at or under the click threshold, executes, so
     a page that could POST here blind (classic CSRF: a cross-origin fetch still sends Origin) was
     the one mutating route a browser could drive. The seat is not a credential, so this line is
     what stands between a web page and a swap.
     AN ABSENT ORIGIN IS REFUSED, and so is the literal `null` a sandboxed iframe sends. This
     comment said the opposite for a while and src/http/auth.ts had already stopped meaning it: a
     present, matching Origin is required. Origin is a forbidden header name, so a page cannot set
     one, and a local process can, which is exactly the split this door wants. The MCP proxy sends
     it (POST_HEADERS in src/mcp.ts) and so must anything else calling this route by hand. */
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
    if (claim.edge) ctx.audit.append('agent_connected', 'an agent attached to phosphor', body);
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
    ctx.audit.append('agent_connected', 'an agent attached to phosphor', body);
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
              : op === 'yield_auto'
                ? `yield_auto ${body.enabled === true ? 'on' : 'off'}`
                : `unknown op ${op}`;
  // Contract: every op that reads, proposes or moves the window is audit-logged
  // before dispatch, arguments included verbatim.
  ctx.audit.append('tool_call', `agent: ${capLabel(label)}`, body);

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
  if (op === 'yield_auto') {
    handleYieldAuto(ctx, body, res);
    return;
  }
  fail(
    res,
    400,
    `unknown op: ${op}. known ops: hello, bye, read, propose, view, set_view_mode, set_basic_coins, yield_auto`,
  );
}
