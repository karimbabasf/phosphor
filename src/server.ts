// PHOSPHOR HTTP server: the one-page approval surface, the browser JSON routes,
// an SSE change stream, and the single /api/mcp route the MCP proxy speaks.
//
// Approve, refuse and kill are the only mutating browser routes and every one of
// them requires the per-boot token that GET /api/session hands out. Every /api/mcp
// op is audit-logged as a tool_call before dispatch, and every rejected mutation is
// audit-logged as approve_attempt_rejected. The one op that is not a tool_call is the
// presence heartbeat: it is logged as agent_connected and agent_disconnected on the
// edges, because a line every 15s buries the transcript it is meant to sit in.
//
// The approval token, the Host check and the origin check live in src/http/auth.ts, and the
// known hole in all three is written up in that file header.

import http from 'node:http';

import type {
  LogEvent,
} from './types.ts';
import { readCoins } from './view/coins.ts';
import { createGasCache } from './transactions.ts';
import { buildWorkerRole } from './role.ts';
import { createChartStore } from './chart.ts';
import { DEFAULT_THEME, type Theme } from './view/theme.ts';
import { createDrawingStore } from './drawings.ts';
import { createBoard } from './board.ts';
import { createDuplicateGuard } from './duplicates.ts';
import { createCrew } from './crew.ts';
import { createHistory } from './history.ts';
import {
  BASIC_EVENT_SCAN,
  LOG_LIMIT_MAX,
  PROJECT_DIR,
  READ_TOOLS,
} from './http/context.ts';
import type { Ctx, GasFill, PriceCache, ReadTable, ServerDeps, PhosphorServer } from './http/context.ts';
import {
  asRecord,
  capLabel,
  errText,
  fail,
  intParam,
  readBody,
  sendJson,
  sendJsonConditional,
  serveStatic,
} from './http/respond.ts';
import type { JsonBody } from './http/respond.ts';
import { HOST, hostIsLocal, mintToken, sameOrigin } from './http/auth.ts';
import { createSseHub } from './http/sse.ts';
import { createChatRegistry } from './http/chats.ts';
import {
  buildState,
  fillGas,
  gasReport,
  transactionsPayload,
} from './http/state.ts';
import {
  chartPayload,
  handleChartWrite,
  loadCandles,
  sendCandles,
  startPricePolling,
} from './http/chart.ts';
import {
  handleMutation,
  handleSetBasicCoins,
  handleSetViewMode,
  handleYieldAuto,
} from './http/mutation.ts';
import { agentReads } from './http/read/agents.ts';
import { chartReads } from './http/read/chart.ts';
import { gasReads } from './http/read/gas.ts';
import { marketReads } from './http/read/market.ts';
import { tradeReads } from './http/read/trade.ts';
import { walletReads } from './http/read/wallet.ts';
import { yieldReads } from './http/read/yield.ts';
import { handlePropose } from './http/propose.ts';
import { handleView } from './http/view.ts';
import { handleTradeAction, handleTradeWrite } from './http/trade.ts';

// The three coins the basic screen tracks, in the order it shows them (Karim,
// 2026-08-14: "btc, sol, and eth"). Fixed, and deliberately NOT the pro chart's
// product: the two screens are read by two different people, and the owner's three
// prices should not change because a trader typed a ticker into the other window.
// The coins the basic screen tracks live in src/view/coins.ts, because the owner can ask
// the assistant to change them and the answer outlives the process. Deliberately NOT the
// pro chart's product either way: the two screens are read by two different people, and
// the owner's prices should not change because a trader typed a ticker in the other
// window.

export function createServer(deps: ServerDeps): PhosphorServer {
  const { cfg, audit, store, agents, getView, trade } = deps;

  // See the note on ServerDeps.getTheme: memory only when the caller did not bring a file.
  let localTheme: Theme = { ...DEFAULT_THEME };
  const getTheme = deps.getTheme ?? ((): Theme => localTheme);
  const setTheme =
    deps.setTheme ??
    ((next: Theme): void => {
      localTheme = next;
    });

  const token = mintToken();
  audit.append('app_start', 'approval surface armed: browser approval token minted for this boot');

  // The bounded audit tail the basic screen's activity list reads. Seeded once here, then
  // appended by the SSE hub's own audit subscription. See the note beside it in sse.ts.
  const recentEvents: LogEvent[] = audit.tail(BASIC_EVENT_SCAN);

  // Chart state is server-side on purpose: see the header of src/chart.ts. The browser
  // renders it and writes its own pan and zoom back.
  const chart = createChartStore(cfg.candleProducts[0] ?? 'BTC-USD');

  // Trend lines and zones the agent drew. Levels and marks stay in the chart store above;
  // these are the object kinds it does not carry, kept in their own store so the two files
  // never contend for the same state.
  const drawings = createDrawingStore();

  // The team board. One line each, read by every agent and by the human's log, and the reason a
  // roster of agents is a team rather than a crowd. See src/board.ts for what it is not.
  const board = createBoard();

  const sse = createSseHub({ store, audit, chart, trade, recent: recentEvents, recentMax: BASIC_EVENT_SCAN });
  const {
    broadcastState,
    broadcastTrade,
    broadcastActivity,
    broadcastCandles,
  } = sse;

  // Workers: agents this app spawns on an agent's behalf. Created lazily, so an install that
  // never spawns one never resolves the claude binary. See src/crew.ts for why the app spawns
  // them rather than handing the driver's child an Agent tool.
  let crew: ReturnType<typeof createCrew> | null = null;
  function getCrew(): ReturnType<typeof createCrew> {
    if (crew === null) {
      crew = createCrew({
        repo: PROJECT_DIR,
        port: cfg.port,
        claudeBin: cfg.driver?.claudeBin,
        model: cfg.driver?.model,
        workerPrompt: (brief, label) => buildWorkerRole({ brief, label, root: PROJECT_DIR }),
        onChange: (job) => {
          audit.append('tool_call', `worker ${job.label}: ${job.state}`, {
            id: job.id,
            parent: job.parent,
            calls: job.calls,
          });
          // A finished worker is news to the window and to the parent agent, and neither is
          // polling. The state frame is what carries it.
          broadcastState();
        },
      });
    }
    return crew;
  }

  // History paging shares loadCandles, so a bar the agent walks back to is the same bar the
  // chart would have drawn had the human panned there.
  const history = createHistory(async (product, granularitySec, endSec, limit) => {
    // Same rule as chart_batch: paging back on the instrument on screen follows that
    // chart's pinned venue, and paging back on any other product does not inherit a
    // choice that was never made about it.
    const view = chart.state().view;
    const provider = product === view.product ? view.provider : 'auto';
    const load = await loadCandles(ctx, product, granularitySec, limit, provider);
    return load.candles.filter((c) => c.t < endSec);
  });

  const chats = createChatRegistry({ cfg, audit, agents, getView, sse, makeDriver: deps.makeDriver });

  // Two agents cannot double the same proposal by accident. See src/duplicates.ts for what this
  // replaces and what it deliberately does not do.
  const duplicates = createDuplicateGuard();

  // The receipt reader behind the history panel, and the one-at-a-time latch in front of it.
  const gas: GasFill = { cache: createGasCache({ dataDir: cfg.dataDir }), filling: false };

  // A refused agent keeps trying: its heartbeat alone is one attempt every few seconds, and
  // the condition it is waiting on (a full roster, or its own revocation) can last hours. One
  // audit line per refused session, then silence. The refusal itself is never silent (every
  // call gets the 409 and the reason), only the log is.
  const seats = new Set<string>();

  // ---------- the three prices the basic screen tracks ----------
  //
  // buildState is synchronous and every caller depends on that, so prices are polled
  // into a cache here rather than fetched inside the state build. A failed poll clears
  // that coin instead of leaving the last good figure in place: a price with no
  // timestamp beside it is indistinguishable from a current one, and the basic screen
  // is read by someone who cannot tell. Same direction as every other refusal in
  // src/view/basic.ts, which is to say less rather than something possibly untrue.
  //
  // One coin failing clears that coin and nothing else. Three prices behind one flag
  // would mean a Solana outage blanking the Bitcoin line, which is a lie about Bitcoin.
  // Held in memory and mirrored to disk, the same shape as the view mode above it: the
  // file is the durable copy, this is the live one, and it is read once on boot rather
  // than per poll.
  const prices: PriceCache = { coins: readCoins(cfg.dataDir), readings: [] };
  prices.readings = prices.coins.map(() => null);

  /* Everything the handlers read, in one object. It is assembled here rather than passed around
     as a dozen arguments because src/server.ts used to be one closure over these bindings, and
     the split turned each read into a field. `history` and `crew` close over `ctx` itself and
     are only ever called from a request, which is why the cycle is safe. */
  const ctx: Ctx = {
    ...deps,
    token,
    theme: { get: getTheme, set: setTheme },
    sse,
    chats,
    chart,
    drawings,
    board,
    crew: getCrew,
    crewIfAny: () => crew,
    recent: recentEvents,
    history,
    prices,
    gas,
    duplicates,
    seats,
  };

  const priceTimer = startPricePolling(ctx);

  // ---------- browser routes ----------

  // ---------- MCP route ----------

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

  async function handleRead(body: JsonBody, res: http.ServerResponse): Promise<void> {
    const tool = String(body.tool ?? '');
    const handler = READS[tool];
    if (handler === undefined) {
      fail(res, 400, `unknown read tool: ${tool}. known tools: ${READ_TOOLS.join(', ')}`);
      return;
    }
    await handler(ctx, body, asRecord(body.args), res);
  }

  function rejectSeat(error: string, body: JsonBody, res: http.ServerResponse, revoked = false): void {
    const session = String(body.session ?? 'unnamed-session');
    if (revoked) {
      // A replaced agent is not a second agent that showed up: the human took the seat off it
      // on purpose. It gets its own marker so the proxy exits instead of reporting a busy
      // seat to a model that would then keep asking. Not deduplicated by session either,
      // because there is exactly one of these per eviction.
      audit.append('agent_disconnected', 'a replaced agent was refused and told to stop', {
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
      audit.append('agent_rejected', 'an agent tried to attach to a full roster and was refused', {
        op: String(body.op ?? ''),
        client: body.client,
        attached: agents.roster().map((m) => m.label),
      });
    }
    // seat:'busy' is the marker src/mcp.ts unwraps into a plain sentence for the agent. The
    // name is kept because the proxy, the e2e script and older builds all read it; what it
    // means has narrowed from "somebody else is driving" to "there is no room right now".
    // It is deliberately not "any 409": the view-mode refusal is also a 409 and must keep its
    // JSON shape, which is what the e2e script and the browser both read.
    fail(res, 409, error, { seat: 'busy' });
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // The money surface gets the same cross-origin guard the approval and trade routes already
    // carry. handleMcp is where an agent proposes and, under the click threshold, executes, so a
    // page that could POST here blind (classic CSRF: a cross-origin fetch still sends Origin) was
    // the one mutating route a browser could drive. sameOrigin refuses a foreign Origin, and the
    // seat is not a credential, so this is what stands between a web page and a swap. An absent
    // Origin (the MCP proxy over stdio->HTTP, curl, the e2e script) is still allowed.
    if (!sameOrigin(req)) {
      audit.append('agent_rejected', 'an /api/mcp call was refused as cross-origin', {
        origin: req.headers.origin ?? '(absent)',
        host: req.headers.host ?? '(absent)',
      });
      fail(res, 403, 'cross-origin request refused');
      return;
    }
    const parsed = await readBody(req);
    if (!parsed.ok) {
      fail(res, 400, parsed.error);
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
      const claim = agents.claim(body);
      if (!claim.ok) {
        rejectSeat(claim.error, body, res, claim.revoked === true);
        return;
      }
      if (claim.edge) audit.append('agent_connected', 'an agent attached to phosphor', body);
      broadcastState();
      sendJson(res, 200, {
        ok: true,
        seat: 'held',
        since: claim.member.since,
        role: claim.member.role,
        label: claim.member.label,
        // What the joining agent needs to know before its first turn: it is not alone, and who
        // else is here. An agent that discovers a colleague by finding a level it did not draw
        // has already wasted a turn being confused.
        roster: agents.roster().map((m) => ({ label: m.label, role: m.role, since: m.since })),
      });
      return;
    }

    // A clean shutdown, which is what makes the light go out the moment an agent is
    // terminated rather than one TTL later. Only the holder can free its own seat.
    if (op === 'bye') {
      const freed = agents.release(body.session);
      if (freed !== null) {
        audit.append('agent_disconnected', 'the agent disconnected', { client: freed.client, since: freed.since });
        broadcastState();
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // Every other op is on the roster or is refused. An op from a session that never said
    // hello joins: an agent should not have to know about a handshake to be counted as
    // connected, and something has to be attached for a tool call to exist.
    const seat = agents.check(body);
    if (!seat.ok) {
      rejectSeat(seat.error, body, res, seat.revoked === true);
      return;
    }
    if (seat.edge) {
      audit.append('agent_connected', 'an agent attached to phosphor', body);
      // An agent that joined on its first op (no hello) is connected NOW. Push state so
      // the window's `agent` field and presence light say so at once rather than at the next
      // heartbeat up to a TTL later. The hello path already does this; this covers the rest.
      broadcastState();
    }
    // A granted tool call is the agent working. Tell the window so its presence light shines
    // now rather than at the next state push, which for a pure read would never come.
    broadcastActivity();

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
    audit.append('tool_call', `agent: ${capLabel(label)}`, body);

    if (op === 'read') {
      await handleRead(body, res);
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

  // ---------- dispatch ----------

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const route = url.pathname;
    try {
      // First gate, before any route: refuse a forged Host. This is the one line that closes
      // DNS-rebinding for the whole surface, reads included, so a page cannot rebind its own
      // domain to 127.0.0.1 and then read the wallet and the session token as same-origin.
      if (!hostIsLocal(req)) {
        fail(res, 403, 'request refused: this app answers only on 127.0.0.1');
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (route === '/api/state') return sendJsonConditional(req, res, buildState(ctx));
        if (route === '/api/candles') return await sendCandles(ctx, url, res);
        if (route === '/api/chart') return sendJson(res, 200, chartPayload(ctx));
        if (route === '/api/log') {
          return sendJson(res, 200, audit.tail(intParam(url.searchParams.get('limit'), 200, LOG_LIMIT_MAX)));
        }
        if (route === '/api/transactions') {
          const payload = transactionsPayload(ctx);
          fillGas(ctx, payload.entries);
          return sendJson(res, 200, payload);
        }
        if (route === '/api/gas') {
          // Same derivation as /api/transactions and the same background fill, so opening GAS
          // after HISTORY costs nothing and opening it first warms the cache for HISTORY. The
          // report says how many receipts are still coming rather than counting them as free.
          const report = gasReport(ctx, url.searchParams.get('window') ?? '7d');
          return sendJson(res, report.status, report.body);
        }
        if (route === '/api/trade') return sendJson(res, 200, trade.payload());
        if (route === '/api/session') return sendJson(res, 200, { token });
        if (route === '/api/driver') return sendJson(res, 200, chats.payload());
        if (route === '/api/events') return sse.open(req, res);
        if (route.startsWith('/api/')) return fail(res, 404, `unknown route: ${route}`);
        // The second surface. A bare /trade is the page; everything else still resolves as a
        // file, so the two pages share one static root and one stylesheet.
        if (route === '/trade' || route === '/trade/') return serveStatic('/trade.html', res);
        return serveStatic(route, res);
      }
      if (req.method === 'POST') {
        if (route === '/api/mcp') return await handleMcp(req, res);
        if (route === '/api/chart') return await handleChartWrite(ctx, req, res);
        if (route === '/api/trade') return await handleTradeWrite(ctx, req, res);
        if (route === '/api/trade/action') return await handleTradeAction(ctx, req, res);
        if (
          route === '/api/approve' ||
          route === '/api/refuse' ||
          route === '/api/kill' ||
          route === '/api/yield/withdraw' ||
          route === '/api/driver'
        ) {
          return await handleMutation(ctx, route, req, res);
        }
        return fail(res, 404, `unknown route: ${route}`);
      }
      fail(res, 405, `method not allowed: ${String(req.method)}`);
    } catch (err) {
      audit.append('error', `server error on ${route}: ${errText(err)}`);
      if (!res.headersSent) fail(res, 500, errText(err));
      else res.end();
    }
  }

  const base = http.createServer((req, res) => {
    void handle(req, res);
  });

  /* The app opens with an agent already attached. On 'listening' and not before, because the
     child's MCP proxy POSTs straight back to this port: a driver started ahead of the socket
     would hand the model an empty tool surface and a session that has to be thrown away.

     `once`, so a server that is closed and listened on again does not stack a second child on
     top of the first. A failure here is not fatal to the app: the driver reports it, the panel
     lands on the globe with the reason printed under it, and pressing the globe tries again. */
  if (deps.autostart === true) {
    base.once('listening', () => {
      chats.start('app');
    });
  }

  base.on('close', () => {
    sse.stop();
    clearInterval(priceTimer);
    chats.stopAll();
  });

  // Structural guarantee for the "binds 127.0.0.1 only" constraint: a bare port
  // would otherwise listen on every interface and put the approval surface on the
  // LAN. Any explicit host the caller passes is left alone.
  const nativeListen = base.listen.bind(base) as (...args: unknown[]) => http.Server;
  const localOnlyListen = (...args: unknown[]): http.Server => {
    if (args.length === 0) return nativeListen(0, HOST);
    const first = args[0];
    if (typeof first === 'number') {
      if (typeof args[1] === 'string') return nativeListen(...args);
      return nativeListen(first, HOST, ...args.slice(1));
    }
    if (first !== null && typeof first === 'object' && 'port' in first) {
      const opts = first as { host?: string };
      return nativeListen({ ...opts, host: opts.host ?? HOST }, ...args.slice(1));
    }
    return nativeListen(...args);
  };
  base.listen = localOnlyListen as unknown as typeof base.listen;

  return Object.assign(base, { broadcastState, broadcastCandles, broadcastTrade });
}
