// The SSE fan-out: the client set, every broadcast the app makes, the two coalescers, the
// heartbeat, the candle push timer, and the /api/events endpoint that opens a stream.
//
// Nothing here carries a payload beyond a type and, on two of them, a revision. The browser
// refetches on the signal, so a frame that grew would silently become a second copy of the
// truth travelling down a different pipe.

import type http from 'node:http';

import type { LogEvent } from '../types.ts';
import type { Audit } from '../audit.ts';
import type { Store } from '../store.ts';
import type { TradeService } from '../trade/service.ts';
import type { ChartStore, SseHub } from './context.ts';

const STATE_DEBOUNCE_MS = 120;
const HEARTBEAT_MS = 15000; // SSE keepalive; doubles as a floor on state freshness
const CANDLE_PUSH_MS = 250; // how often the browser is told there may be a newer bar

export function createSseHub(deps: {
  store: Store;
  audit: Audit;
  chart: ChartStore;
  trade: TradeService;
  // The bounded audit tail the basic screen reads. Seeded by the caller and appended here,
  // because the audit subscription that feeds the pro log is the same one that feeds it.
  recent: LogEvent[];
  recentMax: number;
  // Whether the live rail has gone quiet. Defaults to "always", which is behaviour before the
  // rail existed. See the tick below for why the nudge timer has to ask.
  candlesQuiet?: () => boolean;
}): SseHub {
  const { store, audit, chart, trade, recent, recentMax } = deps;
  const candlesQuiet = deps.candlesQuiet ?? (() => true);

  const sseClients = new Set<http.ServerResponse>();
  let stateTimer: NodeJS.Timeout | null = null;
  let activityTimer: NodeJS.Timeout | null = null;

  function sseSend(res: http.ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcast(payload: unknown): void {
    for (const client of sseClients) sseSend(client, payload);
  }

  // LEADING edge, then a trailing sweep, for the same reason as the feed's own coalescer in
  // src/trade/feed-ws.ts: trailing-only made the FIRST change of a quiet minute pay the full
  // debounce, and the first change is the one someone is watching for. The burst cap is
  // unchanged at one frame per STATE_DEBOUNCE_MS.
  let statePending = false;
  function broadcastState(): void {
    if (stateTimer !== null) {
      statePending = true;
      return;
    }
    for (const client of sseClients) sseSend(client, { type: 'state' });
    stateTimer = setTimeout(function sweep() {
      stateTimer = null;
      if (!statePending) return;
      statePending = false;
      broadcastState();
    }, STATE_DEBOUNCE_MS);
    stateTimer.unref();
  }

  /* The lock. Its own frame rather than a state push, because the window's answer to it is a
     whole screen rather than a repaint: locked draws the lock screen over everything, and a
     state frame arriving first would have the wallet redraw with the old lock chip on it. The
     state it carries is the whole payload, so the window needs no follow-up read to know
     whether it is looking at locked, unlocked, no wallet, or a wallet waiting to be migrated. */
  function broadcastLock(state: string): void {
    for (const client of sseClients) sseSend(client, { type: 'lock', state });
  }

  // The history panel refetches on its own signal rather than on state, because a gas
  // receipt landing changes one cell in a table nobody may even be looking at, and a state
  // push redraws the wallet, the gate, the policy and the basic screen.
  function broadcastTransactions(): void {
    for (const client of sseClients) sseSend(client, { type: 'transactions' });
  }

  // The revision rides along so the browser can tell an agent's change from the echo of its
  // own. It ignores anything at or below the rev its last write returned, which is what keeps
  // a server round trip from fighting the hand that is dragging the chart.
  function broadcastChart(): void {
    for (const client of sseClients) sseSend(client, { type: 'chart', rev: chart.rev() });
  }

  // The trading surface's own channel. It carries the revision and nothing else, exactly like
  // the chart's: the browser refetches, so a payload that grew would not silently become a
  // second copy of the truth travelling down a different pipe.
  function broadcastTrade(): void {
    for (const client of sseClients) sseSend(client, { type: 'trade', rev: trade.view.rev() });
  }

  // The presence light's live pulse. Deliberately NOT a state broadcast: a read changes no
  // money, so making every agent read refetch and repaint the whole wallet would be a lot of
  // work to move one dot. This carries nothing (the browser already knows the agent is
  // connected) and only says "a tool call just happened now", which is all the light needs to
  // brighten and restart its own dull timer. Coalesced so a burst of rapid reads is one frame.
  let activityPending = false;
  function broadcastActivity(): void {
    if (activityTimer !== null) {
      activityPending = true;
      return;
    }
    for (const client of sseClients) sseSend(client, { type: 'activity' });
    activityTimer = setTimeout(function sweep() {
      activityTimer = null;
      if (!activityPending) return;
      activityPending = false;
      broadcastActivity();
    }, STATE_DEBOUNCE_MS);
    activityTimer.unref();
  }

  // A proposal reaching 'executed' is both a balance change and a new line in the history.
  const offStore = store.subscribe(() => {
    broadcastState();
    broadcastTransactions();
  });
  // The basic screen's second history list is built from the audit tail, and buildState
  // runs on every broadcast and every heartbeat. audit.tail() re-reads the whole file from
  // disk by design, and that file is append-only forever, so calling it per state build
  // would make the state payload get slower every day the app runs. The newest events are
  // kept in memory instead: seeded once by the caller, appended by the same subscription
  // that feeds the pro log, and bounded.
  const offAudit = audit.subscribe((event) => {
    recent.unshift(event);
    if (recent.length > recentMax) recent.length = recentMax;
    for (const client of sseClients) sseSend(client, { type: 'log', event });
  });

  // Tell the browser to redraw on a fixed cadence rather than on every trade.
  //
  // This used to hang off the Hyperliquid trade websocket, which fired about 1.4 times a
  // second and made every browser refetch the whole chart payload each time. That socket
  // existed to build second candles; both are gone. A timer is the honest replacement,
  // because what the browser is actually waiting for is the cache refreshing behind it,
  // and that runs on its own schedule (see staleAfterSec in src/market/store.ts). Pushing
  // faster than the cache refreshes only redraws the same bars.
  let candleFrame: NodeJS.Timeout | null = null;
  function broadcastCandles(): void {
    if (candleFrame !== null) return;
    candleFrame = setTimeout(() => {
      candleFrame = null;
      for (const client of sseClients) sseSend(client, { type: 'candles' });
    }, CANDLE_PUSH_MS);
    candleFrame.unref();
  }
  const candleTick = setInterval(() => {
    if (sseClients.size === 0) return;
    // While a venue socket is pushing bars the browser is already current, and this nudge would
    // only make it refetch the whole candle array to arrive where it already is. That refetch is
    // exactly what the delta frame in src/market/push.ts exists to delete. The moment the rail
    // goes quiet this resumes, which is what makes REST the fallback and not a second path.
    if (!candlesQuiet()) return;
    broadcastCandles();
  }, CANDLE_PUSH_MS);
  candleTick.unref();

  const heartbeat = setInterval(() => {
    for (const client of sseClients) sseSend(client, { type: 'state' });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function open(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    const drop = () => {
      sseClients.delete(res);
    };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  // Teardown, called from the server's own close handler. candleTick and the two coalescer
  // timers are unref'd and are deliberately left alone, exactly as they were before the split.
  function stop(): void {
    offStore();
    offAudit();
    clearInterval(heartbeat);
    for (const client of sseClients) client.end();
    sseClients.clear();
  }

  return {
    broadcast,
    clientCount: () => sseClients.size,
    broadcastState,
    broadcastTransactions,
    broadcastChart,
    broadcastTrade,
    broadcastActivity,
    broadcastCandles,
    broadcastLock,
    open,
    stop,
  };
}
