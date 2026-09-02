// PHOSPHOR HTTP server: the one-page approval surface, the browser JSON routes,
// an SSE change stream, and the single /api/mcp route the MCP proxy speaks.
//
// Approve, refuse and kill are the only mutating browser routes and every one of
// them requires the window token, which arrives in the environment and is served by
// no route at all. Every /api/mcp
// op is audit-logged as a tool_call before dispatch, and every rejected mutation is
// audit-logged as approve_attempt_rejected. The one op that is not a tool_call is the
// presence heartbeat: it is logged as agent_connected and agent_disconnected on the
// edges, because a line every 15s buries the transcript it is meant to sit in.
//
// The window token, the Host check and the origin check live in src/http/auth.ts.

import http from 'node:http';

import type { LogEvent } from './types.ts';
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
import { BASIC_EVENT_SCAN, PROJECT_DIR } from './http/context.ts';
import type { Ctx, GasFill, PriceCache, ServerDeps, PhosphorServer } from './http/context.ts';
import { HOST, windowToken } from './http/auth.ts';
import { createKeystore } from './keystore/index.ts';
import { createSession } from './keystore/session.ts';
import { createSseHub } from './http/sse.ts';
import { createChatRegistry } from './http/chats.ts';
import { loadCandles, startPricePolling } from './http/chart.ts';
import { handle } from './http/router.ts';

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

  /* The window token, read from the environment the shell wrote. No route serves it: the only
     holder is the webview the shell injected it into. See src/http/auth.ts. */
  const token = windowToken();
  audit.append('app_start', 'approval surface armed: the window token is held by the window only');

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
  //
  // The coins live in src/view/coins.ts, because the owner can ask the assistant to change them
  // (Karim, 2026-08-14) and the answer outlives the process. Deliberately NOT the pro chart's
  // product: the two screens are read by two different people, and the owner's prices should
  // not change because a trader typed a ticker in the other window.
  const prices: PriceCache = { coins: readCoins(cfg.dataDir), readings: [] };
  prices.readings = prices.coins.map(() => null);

  /* The keys and the clock over them. main.ts passes the keystore it installed as the process
     keystore, so the app has exactly one; a test that passes none gets one over its own temp
     keysPath, which reads that path and writes nothing until a wallet route is called. */
  const keystore = deps.keystore ?? createKeystore({ keysPath: cfg.keysPath });
  const session =
    deps.session ??
    createSession({
      isUnlocked: () => keystore.isUnlocked(),
      lock: (reason) => {
        keystore.lock();
        audit.append(
          'app_start',
          reason === 'sleep'
            ? 'the wallet locked: this machine was asleep'
            : 'the wallet locked after fifteen minutes with nobody at the window',
          { reason },
        );
        sse.broadcastLock(keystore.state());
        broadcastState();
      },
    });
  /* Only when this server owns the session. main.ts starts the one it built and shares with the
     runner, and starting it twice would put two intervals on one clock. */
  if (deps.session === undefined) session.start();
  const stopSession = deps.session === undefined ? () => session.stop() : () => {};

  /* Everything the handlers read, in one object. It is assembled here rather than passed around
     as a dozen arguments because src/server.ts used to be one closure over these bindings, and
     the split turned each read into a field. `history` and `crew` close over `ctx` itself and
     are only ever called from a request, which is why the cycle is safe. */
  const ctx: Ctx = {
    ...deps,
    token,
    keystore,
    session,
    releaseQueued: () => deps.proposals.releaseQueued(),
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

  const base = http.createServer((req, res) => {
    void handle(ctx, req, res);
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
    stopSession();
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
