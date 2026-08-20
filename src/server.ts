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
// KNOWN HOLE, do not read the above as a boundary. This comment used to claim the
// agent "has no path to its own approval: no token, no route". That is false and was
// the most misleading text in the repo. GET /api/session hands the token to ANY
// unauthenticated caller on loopback, and sameOrigin() deliberately allows an absent
// Origin header so curl and the e2e script work. So the whole path is open to anything
// with a shell:
//   GET  /api/session                        -> token, no auth
//   POST /api/approve  {id, token} no Origin -> 400 "unknown proposal" (auth CLEARED)
//   POST /api/approve  with a wrong token    -> 403 "invalid approval token"
// The 400-versus-403 split is the proof that authorisation passed and only the id was
// unknown. Every coding agent on this machine has a shell, so every one of them is
// already inside the boundary the product claims to have.
//
// Verified independently twice on 2026-08-11. Writeup:
// Lessons/2026-08-11-phosphor-approval-token-reachable.md in the vault. A per-boot
// token shared with every local caller is an identifier, never an authorisation.
// Unfixed: the fix is a design call on the thing the product exists for.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AppConfig,
  Candle,
  ChainId,
  LogEvent,
  Policy,
  Proposal,
  ProposalService,
  RiskRow,
  ViewMode,
} from './types.ts';
import { buildBasic } from './view/basic.ts';
import type { PriceReading } from './view/basic.ts';
import { readCoins, writeCoins, MAX_COINS, MIN_COINS } from './view/coins.ts';
import type { Audit } from './audit.ts';
import type { Store } from './store.ts';
import type { Ledger } from './ledger/index.ts';
import type { CandleService } from './candles.ts';
import type { MarketData } from './market/index.ts';
import type { TradeService } from './trade/service.ts';
import { classify } from './composition.ts';
import { buildWallet } from './wallet.ts';
import { createDriver } from './driver.ts';
import type { Driver, DriverEvent } from './driver.ts';
import type { AgentPresence } from './agents.ts';
import { buildTransactions, createGasCache, evmCandidates } from './transactions.ts';
import type { TxPlace } from './transactions.ts';
import { gateRequired, gateBanner } from './policy/gate.ts';
import { buildGreeting } from './greeting.ts';
import { buildRole } from './role.ts';
import { research } from './research.ts';
import { buildMandateCatalog } from './strategy/catalog.ts';
import { VERSION } from './version.ts';
import { renderSentences } from './policy/render.ts';
import {
  buildRead,
  createChartStore,
  digestSeries,
  LIMITS as CHART_LIMITS,
  measure as measureChart,
  resolveScanTimeframe,
  TIMEFRAMES,
  timeframeLabel,
} from './chart.ts';
import type { ChartGeometry, ChartIndicator, ChartState } from './chart.ts';
import { indicatorCatalog, indicatorSpec } from './indicators.ts';
import type { IndicatorResult } from './indicators.ts';
import { createDrawingStore } from './drawings.ts';
import { createHistory } from './history.ts';
import { runBatch } from './batch.ts';
import { analysisHandlers } from './analysis/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', 'ui');
const PROJECT_DIR = path.join(__dirname, '..');

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
// Every label component on the MCP surface is caller-controlled and lands in an
// append-only file. The body cap is 1 MB, so without this one request can write a
// 1 MB log line, and a loop of them fills the disk the audit record lives on.
const MAX_LABEL_CHARS = 64;
const STATE_DEBOUNCE_MS = 120;
const HEARTBEAT_MS = 15000; // SSE keepalive; doubles as a floor on state freshness
const LOG_LIMIT_MAX = 2000;
const CANDLE_LIMIT_MAX = 2000; // matches LIMITS.historyMax: the widest window the chart allows
const CANDLE_PUSH_MS = 1000; // how often the browser is told there may be a newer bar

// The basic screen's price tracker. Hourly bars over a day: "today" for someone reading
// a price is the last 24 hours, not the span since midnight in a timezone the exchange
// does not share. Polled well below the rate any venue rate-limits.
const PRICE_GRANULARITY_SEC = 3600;
const PRICE_BARS = 24;
const PRICE_POLL_MS = 30000;
// The three coins the basic screen tracks, in the order it shows them (Karim,
// 2026-08-14: "btc, sol, and eth"). Fixed, and deliberately NOT the pro chart's
// product: the two screens are read by two different people, and the owner's three
// prices should not change because a trader typed a ticker into the other window.
// The coins the basic screen tracks live in src/view/coins.ts, because the owner can ask
// the assistant to change them and the answer outlives the process. Deliberately NOT the
// pro chart's product either way: the two screens are read by two different people, and
// the owner's prices should not change because a trader typed a ticker in the other
// window.
// How far back the basic screen's "what the assistant did" list is willing to look for
// five distinct sentences. Runs collapse, so an assistant that read the wallet two
// hundred times in a row still fills one line, and past this it shows fewer lines rather
// than reading further: the list is a glance, not the log.
const BASIC_EVENT_SCAN = 300;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

const CHAINS: readonly string[] = ['eth', 'base', 'arb', 'sol', 'near'];
// Display only: this feeds the "unknown propose kind" error message and gates nothing, so a
// kind missing here is a misleading error rather than a dead tool. Keep it in step with the
// if-chain in the propose handler anyway, since the message is how a caller finds the typo.
const PROPOSE_KINDS: readonly string[] = [
  'consolidate',
  'policy_change',
  'swap',
  'hl_deposit',
  'intents_deposit',
  'intents_withdraw',
  'lp_add',
  'lp_remove',
  'mandate_arm',
];
const READ_TOOLS: readonly string[] = [
  // The handshake presentation: the banner a connecting agent prints, the live facts it
  // prints beside it, and the index of everything it can do. A read like any other, so it
  // takes the seat, gets audited and refuses a second agent exactly as every other call does.
  'start',
  'balances',
  'composition',
  'wallet',
  'policy_show',
  'log_tail',
  'candles',
  'proposal_status',
  'chart_read',
  'chart_measure',
  'chart_scan',
  'chart_batch',
  'indicator_catalog',
  'market_search',
  // The one tool that leaves this machine. It is a read like the others because that is all it
  // is: the APP fetches from a fixed allowlist and hands back text. The agent never gets a URL
  // it can point anywhere, which is the whole reason this is a Phosphor tool and not WebFetch.
  'research',
  'trade_read',
  'trade_batch',
  // How to write a mandate. Opening a position is the one action that cannot be reached by
  // reading a tool signature, because it takes a program rather than arguments, so the
  // grammar has to be readable from the surface or an agent asks a human how.
  'mandate_catalog',
];
// Chart writes. They move no money, so they never reach the proposal path and never wait on
// an approval. They are still audited like every other op: an agent that can change what the
// human sees while that human approves a transfer is a surface, not a decoration.
const VIEW_TOOLS: readonly string[] = [
  'chart_set_view',
  'chart_add_indicator',
  'chart_remove_indicator',
  'chart_level',
  'chart_mark',
  'chart_trendline',
  'chart_clear',
  // The trading surface's writes. Same category as the chart's: they change what is drawn and
  // what is pointed at, and none of them places, cancels or sizes anything. The verbs that do
  // move a position are on /api/trade/action, which this door does not open onto.
  'trade_focus',
  'trade_highlight',
  'trade_overlay',
  'trade_note',
  'trade_clear',
];
// Human-only controls on the trading window. Each one only ever reduces exposure, which is why
// none of them waits on an approval and none is reachable from the agent's door.
const TRADE_ACTIONS: readonly string[] = ['disarm', 'cancel', 'cancel_all', 'close', 'flatten'];
const SCAN_TIMEFRAMES_MAX = 6;

export type ServerDeps = {
  cfg: AppConfig;
  audit: Audit;
  store: Store;
  ledger: Ledger;
  riskRows: RiskRow[];
  candles: CandleService;
  market: MarketData;
  proposals: ProposalService;
  getPolicy: () => Policy | null;
  setKill: (on: boolean) => void;
  // Who is driving, and the one-at-a-time rule. See src/agents.ts.
  agents: AgentPresence;
  getView: () => ViewMode;
  setView: (mode: ViewMode) => void;
  trade: TradeService;
  /* Start the in-app agent when the port opens. OPT IN, and deliberately not read from cfg
     here: every test in this repo builds a server and listens on it, and a flag that defaulted
     to on would have each of them spawn a real Claude Code process. main.ts is the one caller
     that passes it, and it is the one caller that is an app. */
  autostart?: boolean;
  /* Injected only so a test can drive the start paths without a real Claude Code process
     appearing on the machine. main.ts never passes it, and nothing here can loosen the
     lockdown through it: the tool surface is fixed in operator/driver.settings.json and
     checked again at runtime inside src/driver.ts. */
  makeDriver?: () => Driver;
};

// http.Server plus an explicit push so the wiring layer can signal the UI after
// a ledger refresh, which no store or audit subscription would otherwise catch.
// broadcastTrade is on this surface because the venue feed is the one thing that changes the
// trading window without anyone touching the app, and until it was exported the feed could
// only reach the window through broadcastState, which the trading page does not listen to.
export type PhosphorServer = http.Server & {
  broadcastState(): void;
  broadcastCandles(): void;
  broadcastTrade(): void;
};

type JsonBody = Record<string, unknown>;
type BodyResult = { ok: true; value: JsonBody } | { ok: false; error: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): JsonBody {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonBody) : {};
}

// Bound a caller-supplied string before it reaches a log label. Truncation is
// enough here: the log is JSONL, so JSON.stringify already escapes newlines and
// quotes, and no caller-controlled text is ever rendered as HTML.
function capLabel(raw: string): string {
  return raw.length <= MAX_LABEL_CHARS ? raw : `${raw.slice(0, MAX_LABEL_CHARS)}...`;
}

function intParam(raw: unknown, fallback: number, max: number): number {
  if (raw === null || raw === undefined) return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Hash both sides so the comparison is constant length as well as constant time:
// a raw timingSafeEqual on the tokens themselves would throw on a length mismatch
// and leak the token length through that error.
function tokenMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createServer(deps: ServerDeps): PhosphorServer {
  const { cfg, audit, store, ledger, riskRows, candles, market, proposals } = deps;
  const { getPolicy, setKill, agents, getView, setView, trade } = deps;

  const token = crypto.randomBytes(24).toString('hex');
  audit.append('app_start', 'approval surface armed: browser approval token minted for this boot');

  const sseClients = new Set<http.ServerResponse>();
  let stateTimer: NodeJS.Timeout | null = null;
  let activityTimer: NodeJS.Timeout | null = null;

  // Chart state is server-side on purpose: see the header of src/chart.ts. The browser
  // renders it and writes its own pan and zoom back.
  const chart = createChartStore(cfg.candleProducts[0] ?? 'BTC-USD');

  // Trend lines and zones the agent drew. Levels and marks stay in the chart store above;
  // these are the object kinds it does not carry, kept in their own store so the two files
  // never contend for the same state.
  const drawings = createDrawingStore();

  // History paging shares loadCandles, so a bar the agent walks back to is the same bar the
  // chart would have drawn had the human panned there.
  const history = createHistory(async (product, granularitySec, endSec, limit) => {
    const load = await loadCandles(product, granularitySec, limit);
    return load.candles.filter((c) => c.t < endSec);
  });

  // The driver's seat. The transcript is kept here rather than in the browser because a window
  // that reloads mid-conversation should come back to the conversation, and because the SSE
  // stream is a change notification, not a delivery guarantee. TRANSCRIPT_MAX is a memory bound,
  // not an editorial one: the full record of what the agent did lives in the audit log, which is
  // append-only and is what anyone should read when the question is what happened.
  const TRANSCRIPT_MAX = 400;
  const transcript: Array<DriverEvent & { at: number }> = [];
  let driver: Driver | null = null;

  function driverEvent(event: DriverEvent): void {
    transcript.push({ ...event, at: Date.now() });
    if (transcript.length > TRANSCRIPT_MAX) transcript.splice(0, transcript.length - TRANSCRIPT_MAX);
    // A refused lockdown is not a chat message. It is the one driver event that belongs in the
    // permanent record, because it means a Claude Code upgrade changed the tool surface under an
    // app that signs transactions.
    if (event.kind === 'error' && event.message.startsWith('refusing to drive')) {
      audit.append('error', event.message, { source: 'driver' });
    }
    for (const client of sseClients) sseSend(client, { type: 'driver', event });
  }

  function getDriver(): Driver {
    if (driver === null) {
      driver = deps.makeDriver
        ? deps.makeDriver()
        : createDriver({
            repo: PROJECT_DIR,
            port: cfg.port,
            claudeBin: cfg.driver?.claudeBin,
            /* Unset by default, and that is a measured decision rather than an omission. Pinning
               a faster model looked like the obvious speed win and it is not one: over six runs
               of two canonical chart prompts, all three models were correct every time, and the
               medians came out 5.0s on sonnet, 6.2s on the machine default (opus), 8.0s on haiku,
               which is inside the run-to-run spread on the first two. Haiku was slower, not
               faster: it spent thinking tokens the others did not and took an extra round trip
               more often. The time is in the round trips, not the model, so the app takes the
               user's own default and `driver.model` in config.json is there for anyone who
               disagrees. See scripts/bench-driver.ts to re-run the comparison. */
            model: cfg.driver?.model,
            /* The role, and the reason it is a default rather than a config field with no value.
               An agent given no role is a general assistant holding a wallet's tools: it offers
               to write code it cannot write, it asks which screen you meant, and it treats a
               token name as something that can tell it what to do. src/role.ts is the answer to
               all three. A `driver.systemPrompt` in config still wins outright, because somebody
               running their own Phosphor should be able to change how their own agent talks. */
            systemPrompt:
              cfg.driver?.systemPrompt ?? buildRole({ root: PROJECT_DIR, view: getView(), network: cfg.network }),
            onEvent: driverEvent,
          });
    }
    return driver;
  }

  /* Starting the agent, from either door: a human pressing the globe, or the app opening.

     The seat is taken away FIRST, and that order is not cosmetic: the agent this is replacing
     heartbeats every few seconds and a process takes longer than that to start, so opening
     first lets the outgoing agent win the seat its replacement was started to take. */
  function startDriver(how: 'human' | 'app'): string | null {
    const dropped = agents.evict();
    if (dropped !== null) {
      audit.append('agent_disconnected', `${how === 'human' ? 'the human' : 'the app'} replaced ${dropped.client} with the in-app driver`, {
        client: dropped.client,
      });
    }
    audit.append(
      'app_start',
      how === 'human'
        ? 'in-app driver starting: the app is spawning its own agent'
        : 'in-app driver starting at boot: the window opens with an agent attached',
    );
    getDriver().start();
    broadcastState();
    return dropped?.client ?? null;
  }

  function driverPayload(): Record<string, unknown> {
    const status = driver === null ? { state: 'off' as const, sessionId: '', running: false } : driver.status();
    return { ...status, transcript };
  }

  function sseSend(res: http.ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
  // kept in memory instead: seeded once here, appended by the same subscription that feeds
  // the pro log, and bounded.
  const recentEvents: LogEvent[] = audit.tail(BASIC_EVENT_SCAN);
  const offAudit = audit.subscribe((event) => {
    recentEvents.unshift(event);
    if (recentEvents.length > BASIC_EVENT_SCAN) recentEvents.length = BASIC_EVENT_SCAN;
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
    if (sseClients.size > 0) broadcastCandles();
  }, CANDLE_PUSH_MS);
  candleTick.unref();

  const heartbeat = setInterval(() => {
    for (const client of sseClients) sseSend(client, { type: 'state' });
  }, HEARTBEAT_MS);
  heartbeat.unref();

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
  let basicCoins: string[] = readCoins(cfg.dataDir);
  let priceReadings: PriceReading[] = basicCoins.map(() => null);

  async function readPrice(product: string): Promise<PriceReading> {
    try {
      const load = await loadCandles(product, PRICE_GRANULARITY_SEC, PRICE_BARS);
      const candles = load.candles ?? [];
      const last = candles[candles.length - 1];
      const first = candles[0];
      if (last === undefined || first === undefined || !(first.o > 0)) return null;
      return {
        product,
        priceUsd: last.c,
        changePct: ((last.c - first.o) / first.o) * 100,
        // The window the change is measured over, as a series. The same 24 bars behind
        // both figures, so the line and the percentage can never disagree on screen.
        closes: candles.map((candle) => candle.c),
      };
    } catch {
      return null;
    }
  }

  async function pollPrice(): Promise<void> {
    // Read into a local first. The list can change under this await when the assistant is
    // asked for a different coin, and assigning a three-coin result into a screen that now
    // shows two would put a price under the wrong name.
    const coins = [...basicCoins];
    const readings = await Promise.all(coins.map(readPrice));
    if (coins.join() !== basicCoins.join()) return;
    priceReadings = readings;
  }

  const priceTimer = setInterval(() => {
    void pollPrice();
  }, PRICE_POLL_MS);
  priceTimer.unref();
  void pollPrice();

  // ---------- responses ----------

  function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  // As sendJson, but the caller may ask whether anything changed since last time.
  //
  // State is pushed on a timer whether or not it moved: the heartbeat below fires every
  // HEARTBEAT_MS, and the ledger refresh in main.ts broadcasts on every pass. The browser
  // answers each one by refetching 54KB and rebuilding the wallet, the policy and the basic
  // screen, and measured on a running instance those bodies are byte-identical, so the rebuild
  // repaints exactly what was already there.
  //
  // The ETag lets that case cost a 304: no body, no parse, no DOM teardown, no layout. Nothing
  // about freshness changes, because the request still happens on every signal. Only the redraw
  // is skipped, and only when the bytes match.
  //
  // no-store stays. The browser's own HTTP cache must not hold a wallet balance; the conditional
  // request here is driven by an ETag the page holds in memory and loses on reload.
  function sendJsonConditional(req: http.IncomingMessage, res: http.ServerResponse, payload: unknown): void {
    const body = JSON.stringify(payload);
    // Not a security boundary, just a change detector, so speed beats collision resistance.
    const etag = `"${crypto.createHash('sha1').update(body).digest('base64')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      etag,
    });
    res.end(body);
  }

  function serveStatic(pathname: string, res: http.ServerResponse): void {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '');
    } catch {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const target = path.resolve(UI_DIR, rel);
    if (target !== UI_DIR && !target.startsWith(UI_DIR + path.sep)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const type = MIME[path.extname(target)];
    if (type === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(target);
    } catch {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    // The UI is served from disk on every request so an edit shows up on reload, but a
    // font file is immutable content that would otherwise be refetched on every boot of
    // the window and re-run the swap.
    const cache = type === 'font/woff2' ? 'public, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': cache });
    res.end(body);
  }

  function readBody(req: http.IncomingMessage): Promise<BodyResult> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          resolve({ ok: false, error: 'request body too large' });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw.length === 0) {
          resolve({ ok: true, value: {} });
          return;
        }
        try {
          resolve({ ok: true, value: asRecord(JSON.parse(raw)) });
        } catch {
          resolve({ ok: false, error: 'invalid json body' });
        }
      });
      req.on('error', (err) => resolve({ ok: false, error: errText(err) }));
    });
  }

  // ---------- state ----------

  function sentencesOf(policy: Policy | null): string[] {
    if (policy === null) return [];
    // Authored sentences are the human's own words and win. A hand-edited file
    // that empties them would otherwise hide live rules, so fall back to render.
    const rendered = renderSentences(policy);
    const lines = policy.sentences.length > 0 ? policy.sentences.slice() : rendered;
    // The kill switch line can never be missing from the surface while the switch
    // is on, whatever the stored sentences say. A refusal state the page does not
    // state is a safety bug, so this does not depend on the writer of policy.json.
    const killLine = rendered.find((line) => line.startsWith('KILL SWITCH ON'));
    if (killLine !== undefined && !lines.some((line) => line.startsWith('KILL SWITCH ON'))) {
      lines.push(killLine);
    }
    return lines;
  }

  function buildState(): unknown {
    const snapshot = ledger.snapshot();
    const composition = classify(snapshot, riskRows);
    const policy = getPolicy();
    const wallet = buildWallet(snapshot, ledger.positions(), ledger.intents());
    const list = proposals.list();
    return {
      ledger: snapshot,
      // wallet is what the UI renders; composition stays because the policy engine
      // reads byIssuer and freezableShare out of it.
      wallet,
      composition,
      policy,
      gate: { required: gateRequired(cfg), banner: gateBanner(cfg) },
      network: cfg.network,
      sentences: sentencesOf(policy),
      proposals: list,
      mode: cfg.mode,
      // holder is agent-authored text (its client name) and is rendered as text, never as
      // markup. It is here so the status bar can say WHICH agent holds the seat: "an agent
      // is connected" is a weaker answer than "claude-code is connected, since 19:12".
      agents: {
        connected: agents.connected(),
        holder: agents.holder(),
        // The most recent tool call, so a browser that just loaded (or reconnected and missed
        // the live 'activity' pings below) can seed its presence light from state alone rather
        // than waiting for the next op to know whether the agent is working.
        lastActivityAt: agents.activityAt(),
      },
      candleProducts: cfg.candleProducts,
      view: getView(),
      // Computed in BOTH modes, deliberately. A view model that only exists in the mode
      // that renders it is a view model nothing exercises while the app sits in its
      // default state, which is where a regression would hide longest.
      basic: buildBasic({
        wallet,
        proposals: list,
        policyReadable: policy !== null,
        killSwitch: policy?.killSwitch ?? false,
        gateRequired: gateRequired(cfg),
        agentsConnected: agents.connected(),
        chainStatus: snapshot.chainStatus,
        selfAddresses: [...cfg.addresses.evm, ...cfg.addresses.solana, ...cfg.addresses.near],
        prices: priceReadings,
        // The assistant's half of the history: the same events the pro screen's log
        // carries, rendered as sentences instead of as log lines. See buildActions.
        events: recentEvents,
      }),
    };
  }

  // ---------- transaction history ----------
  //
  // Derived from the proposal store and the audit log on every request (see the header of
  // src/transactions.ts). Gas is the one part that needs the chain, so it is read behind the
  // response rather than in front of it: the panel draws immediately with whatever receipts
  // are already cached, the rest are fetched, and the browser is told when they land.

  const gasCache = createGasCache({ network: cfg.network, dataDir: cfg.dataDir });
  let gasFilling = false;

  function transactionsPayload(): { entries: ReturnType<typeof buildTransactions>; gasPending: number } {
    const entries = buildTransactions({
      proposals: proposals.list(),
      events: audit.tail(LOG_LIMIT_MAX),
      network: cfg.network,
      selfAddresses: [...cfg.addresses.evm, ...cfg.addresses.solana, ...cfg.addresses.near],
      gas: gasCache.all(),
      tried: gasCache.triedAll(),
    });
    // Only what is still worth waiting for. A hash no chain we can reach has ever heard of
    // is answered, not pending: an app that has run on two networks holds plenty of them.
    let gasPending = 0;
    for (const entry of entries) {
      for (const tx of entry.hashes) if (tx.gasPending) gasPending += 1;
    }
    return { entries, gasPending };
  }

  // One fill at a time, and only for hashes nobody has read yet. A receipt is immutable, so
  // this converges: every call after the last one has landed does no network work at all.
  function fillGas(entries: ReturnType<typeof buildTransactions>): void {
    if (gasFilling) return;
    const wanted: Array<{ places: TxPlace[]; hash: string }> = [];
    for (const entry of entries) {
      for (const tx of entry.hashes) {
        if (tx.gasPending) wanted.push({ places: evmCandidates(tx.place), hash: tx.hash });
      }
    }
    if (wanted.length === 0) return;
    gasFilling = true;
    const prices = ledger.snapshot().prices;
    void gasCache
      .fill(wanted, symbol => prices[symbol] ?? 0)
      .then(landed => {
        if (landed > 0) broadcastTransactions();
      })
      .catch(() => undefined)
      .finally(() => {
        gasFilling = false;
      });
  }

  // ---------- browser routes ----------

  function openEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
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

  type CandleLoad = {
    candles: Candle[];
    source: string;
    stale: boolean;
    built: string;
    fetchedAt: string;
    // True while the window behind this read is still being filled, so the chart can say
    // "filling" rather than showing a short series as though it were the whole story.
    filling: boolean;
    note: string | null;
  };

  // One loader behind every candle surface, in two flavours that differ only in who waits.
  //
  // The render path must never wait. Before this, GET /api/chart awaited a Hyperliquid
  // round trip before the browser could draw, and the trade stream asked it to do that
  // about 1.4 times a second. Measured on the running app 2026-08-13: four sequential
  // chart reads did not finish inside four minutes. Now a render reads memory and any
  // refill happens behind it, announced over SSE when it lands.
  //
  // An agent still waits, because an empty array is a worse answer than a slow one when
  // something is about to reason over it.
  function readCandles(product: string, granularitySec: number, limit: number): CandleLoad {
    const held = market.read(product, granularitySec, limit);
    return {
      candles: held.candles,
      source: held.source,
      stale: held.stale,
      built: 'candles',
      fetchedAt: new Date(Date.now() - held.ageSec * 1000).toISOString(),
      filling: held.filling,
      note: held.note,
    };
  }

  async function loadCandles(product: string, granularitySec: number, limit: number): Promise<CandleLoad> {
    await market.warm(product, granularitySec, limit);
    return readCandles(product, granularitySec, limit);
  }

  async function sendCandles(url: URL, res: http.ServerResponse): Promise<void> {
    const product = url.searchParams.get('product') ?? cfg.candleProducts[0] ?? 'BTC-USD';
    const granularity = intParam(url.searchParams.get('granularity'), 60, 86400);
    const limit = intParam(url.searchParams.get('limit'), 120, CANDLE_LIMIT_MAX);
    try {
      const load = await loadCandles(product, granularity, limit);
      // Body is Candle[] per the contract; the staleness marker the chart region
      // needs rides in headers so the body shape stays exactly what was specified.
      const body = JSON.stringify(load.candles);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'x-candle-source': load.source,
        'x-candle-stale': String(load.stale),
        'x-candle-fetched-at': load.fetchedAt,
        'x-candle-built': load.built,
      });
      res.end(body);
    } catch (err) {
      sendJson(res, 502, { error: errText(err) });
    }
  }

  // ---------- chart ----------

  function computeIndicators(
    state: ChartState,
    series: Candle[],
  ): { indicator: ChartIndicator; result: IndicatorResult }[] {
    const out: { indicator: ChartIndicator; result: IndicatorResult }[] = [];
    for (const indicator of state.indicators) {
      const spec = indicatorSpec(indicator.type);
      if (spec === undefined) continue;
      out.push({ indicator, result: spec.compute(series, indicator.params) });
    }
    return out;
  }

  // Everything the renderer needs in one round trip: the view, the candles, and every
  // indicator series already computed. The browser draws plots generically and never has to
  // know what an RSI is, which is what keeps the two sides from disagreeing.
  function chartPayload(): unknown {
    const state = chart.state();
    // Memory only, and it cannot throw: an outage shows the last good candles marked stale
    // rather than an empty chart. This is the render path, so nothing here may await.
    const load = readCandles(state.view.product, state.view.granularitySec, chart.historyNeeded());
    const error: string | null = null;
    const computed = computeIndicators(state, load.candles);
    return {
      rev: state.rev,
      lastDriver: state.lastDriver,
      view: state.view,
      candles: load.candles,
      meta: {
        source: load.source,
        stale: load.stale,
        built: load.built,
        fetchedAt: load.fetchedAt,
        filling: load.filling,
        note: load.note,
        error,
      },
      indicators: computed.map(({ indicator, result }) => ({
        id: indicator.id,
        type: indicator.type,
        label: indicator.label,
        pane: indicator.pane,
        source: indicator.source,
        plots: result.plots,
        guides: result.guides,
        range: result.range,
        state: result.state,
      })),
      levels: state.levels,
      marks: state.marks,
      // Trend lines and zones live in their own store beside the chart's levels and marks.
      // They reach the browser on the same payload so the human sees exactly the objects
      // the agent is measuring against, which is the whole point of drawing them there.
      drawings: drawings.list(),
      agentObjects: chart.agentObjects() + drawings.list().filter((d) => d.source === 'agent').length,
      products: cfg.candleProducts,
      timeframes: TIMEFRAMES,
      limits: CHART_LIMITS,
    };
  }

  // The agent's view of the same thing: no arrays of pixels, every number in context.
  async function chartRead(): Promise<unknown> {
    const state = chart.state();
    try {
      const load = await loadCandles(state.view.product, state.view.granularitySec, chart.historyNeeded());
      return buildRead({
        state,
        candles: load.candles,
        meta: { source: load.source, stale: load.stale, built: load.built },
        computed: computeIndicators(state, load.candles),
        nowSec: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      return {
        error: errText(err),
        product: state.view.product,
        timeframe: timeframeLabel(state.view.granularitySec),
        rev: state.rev,
      };
    }
  }

  // The browser's own pan and zoom coming home. It carries the approval token like every
  // other browser write, not because a view change is dangerous, but so there stays exactly
  // one door per caller: the window uses this, an agent uses /api/mcp.
  async function handleChartWrite(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await readBody(req);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    const body = parsed.value;
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin chart write refused' });
    if (!tokenMatches(body.token, token)) return sendJson(res, 403, { error: 'invalid approval token' });

    if (body.geometry !== null && typeof body.geometry === 'object') {
      chart.setGeometry(body.geometry as ChartGeometry);
    }
    let notes: string[] = [];
    if (body.view !== null && typeof body.view === 'object') {
      const outcome = chart.setView(body.view as Record<string, unknown>, 'human');
      if (!outcome.ok) return sendJson(res, 400, { error: outcome.error });
      notes = outcome.notes;
    }
    // The window's own command line. The human gets the same vocabulary as the agent, so
    // the chart is not a surface only an agent can change.
    if (body.addIndicator !== null && typeof body.addIndicator === 'object') {
      const outcome = chart.addIndicator(body.addIndicator as Record<string, unknown>, 'human');
      if (!outcome.ok) return sendJson(res, 400, { error: outcome.error, notes: outcome.notes });
      notes = notes.concat(outcome.notes);
    }
    if (typeof body.removeIndicator === 'string') {
      const outcome = chart.removeIndicator(body.removeIndicator);
      if (!outcome.ok) return sendJson(res, 400, { error: outcome.error });
    }
    if (typeof body.clear === 'string') {
      const outcome = chart.clear(body.clear);
      if (!outcome.ok) return sendJson(res, 400, { error: outcome.error });
    }
    broadcastChart();
    // The resulting view goes back with the answer. The window applies it from here rather
    // than from a refresh, because a refresh it fired itself can land before this write does
    // and snap the gesture the human just made back to where it started.
    sendJson(res, 200, { ok: true, rev: chart.rev(), view: chart.state().view, notes });
  }

  // Absent Origin (curl, the e2e script) is allowed; a foreign one is not. Paired
  // with the Host check this blunts drive-by and DNS-rebinding POSTs from a page
  // the human happens to have open in the same browser.
  // The Host header, on its own. A browser that has been pointed at this loopback service by a
  // DNS-rebinding page sends the ATTACKER's domain here, not 127.0.0.1: after the rebind the tab
  // still thinks it is talking to evil.com, so Host is evil.com. Refusing a non-loopback Host is
  // what closes rebinding for the READ routes too (/api/state, /api/session, /api/events), which
  // sameOrigin never guarded because they carry no Origin. An absent Host is a Host-less HTTP/1.0
  // client (curl, the e2e script), a local tool and not a browser, so it is allowed: a browser
  // cannot omit it. The app binds to 127.0.0.1 only, so no legitimate request arrives under any
  // other name anyway; this only rejects the forged ones.
  function hostIsLocal(req: http.IncomingMessage): boolean {
    const host = String(req.headers.host ?? '');
    if (host === '') return true;
    const hostname = host.split(':')[0];
    return hostname === HOST || hostname === 'localhost';
  }

  function sameOrigin(req: http.IncomingMessage): boolean {
    if (!hostIsLocal(req)) return false;
    const host = String(req.headers.host ?? '');
    const origin = req.headers.origin;
    if (origin === undefined || origin === 'null') return true;
    return origin === `http://${host}`;
  }

  async function handleMutation(route: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await readBody(req);
    const body = parsed.ok ? parsed.value : {};
    const id = typeof body.id === 'string' ? body.id : null;

    const reason = !parsed.ok
      ? parsed.error
      : !sameOrigin(req)
        ? 'cross-origin request'
        : !tokenMatches(body.token, token)
          ? typeof body.token === 'string' && body.token.length > 0
            ? 'wrong approval token'
            : 'approval token missing'
          : null;

    if (reason !== null) {
      // The supplied token itself never enters the audit log. Its SHA-256 prefix does, and that
      // is the difference between "a token was rejected" and "which client is holding which
      // token": two rejections sharing a fingerprint are one stale page retrying, and a
      // fingerprint that matches no boot this app has served is a client that never had one.
      // The same argument covers origin and agent: a rejection that cannot say who sent it
      // cannot tell a human reloading a dead tab apart from something hammering the endpoint.
      const supplied = typeof body.token === 'string' ? body.token : '';
      audit.append('approve_attempt_rejected', `POST ${route} rejected: ${reason}`, {
        route,
        id,
        reason,
        tokenPresent: supplied.length > 0,
        tokenFp: supplied === '' ? null : crypto.createHash('sha256').update(supplied).digest('hex').slice(0, 12),
        expectedFp: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12),
        origin: req.headers.origin ?? '(absent)',
        agent: String(req.headers['user-agent'] ?? '(absent)').slice(0, 120),
      });
      sendJson(res, parsed.ok ? 403 : 400, { error: parsed.ok ? 'invalid approval token' : reason });
      return;
    }

    if (route === '/api/driver') {
      const action = String(body.action ?? '');
      const instance = getDriver();

      if (action === 'start') {
        const dropped = startDriver('human');
        return sendJson(res, 200, { ok: true, dropped, ...instance.status() });
      }

      if (action === 'prompt') {
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text === '') return sendJson(res, 400, { error: 'text is required' });
        if (text.length > 8000) return sendJson(res, 400, { error: 'text is too long: 8000 characters maximum' });
        try {
          instance.send(text);
        } catch (err) {
          return sendJson(res, 409, { error: errText(err) });
        }
        /* Logged before anything the agent does with it. The dashcam is supposed to answer
           "why did this happen", and the tool calls alone only answer "what happened": a swap
           in the transcript with no instruction above it reads as the app acting on its own. */
        audit.append('driver_prompt', `human to the agent: ${text}`, { chars: text.length });
        driverEvent({ kind: 'said', text });
        return sendJson(res, 200, { ok: true, ...instance.status() });
      }

      /* Stop the answer, not the agent. A separate action from `stop` because they are separate
         intentions and the app should never make a human choose the destructive one to get the
         cheap one: `interrupt` ends the turn in flight and keeps the conversation, `stop` ends
         the session and throws it away. It is audited like everything else, because "the agent
         went quiet halfway through" is a question somebody will ask the log later. */
      if (action === 'interrupt') {
        const stopped = instance.interrupt();
        /* No driverEvent here. interrupt() sets the state itself and the driver's own status
           event is already on its way through onEvent, so pushing a second one printed the
           line twice in the window. Seen doing exactly that on the live app. */
        if (stopped) audit.append('driver_prompt', 'the human stopped the answer in progress', { interrupted: true });
        return sendJson(res, 200, { ok: true, interrupted: stopped, ...instance.status() });
      }

      if (action === 'stop') {
        instance.stop();
        audit.append('app_start', 'in-app driver stopped by the human');
        broadcastState();
        return sendJson(res, 200, { ok: true, ...instance.status() });
      }

      return sendJson(res, 400, { error: `unknown driver action: ${action}` });
    }

    if (route === '/api/kill') {
      const on = body.on === true;
      setKill(on);
      audit.append(
        'kill_switch',
        on ? 'KILL SWITCH ON: all writes refused (human)' : 'kill switch off: writes allowed again, subject to policy (human)',
        { on },
      );
      broadcastState();
      sendJson(res, 200, { ok: true, killSwitch: on });
      return;
    }

    if (id === null) {
      sendJson(res, 400, { error: 'id is required' });
      return;
    }
    try {
      // approve() and refuse() own their own audit trail and any execution.
      const proposal = route === '/api/approve' ? await proposals.approve(id) : await proposals.refuse(id);
      broadcastState();
      sendJson(res, 200, proposal);
    } catch (err) {
      sendJson(res, 400, { error: errText(err) });
    }
  }

  // ---------- MCP route ----------

  async function handleRead(body: JsonBody, res: http.ServerResponse): Promise<void> {
    const tool = String(body.tool ?? '');
    const args = asRecord(body.args);

    // What an agent calls the moment it attaches. Everything in it is read live, because a
    // greeting that cannot say which network it is on is decoration, and an operator working
    // the wrong world is the failure this whole app exists to make impossible.
    if (tool === 'start') {
      const snapshot = ledger.snapshot();
      const wallet = buildWallet(snapshot, ledger.positions(), ledger.intents());
      const policy = getPolicy();
      const pending = proposals.list().filter((p) => p.status === 'pending');
      const holder = agents.holder();
      const greeting = buildGreeting(
        {
          network: cfg.network,
          view: getView(),
          totalUsd: wallet.totalUsd,
          // Places actually holding something, which is what "across N chains" means to a
          // reader. Counting configured chains instead would say 5 while 2 hold the money.
          chainCount: Object.values(wallet.byChain).filter((usd) => usd > 0).length,
          pendingCount: pending.length,
          clickThresholdUsd: policy?.outbound.humanClickAboveUsd ?? null,
          killSwitch: policy?.killSwitch ?? false,
          gateRequired: gateRequired(cfg),
          // Read from the one setting every trading consumer reads, so the greeting cannot
          // name a network the runner is not on. It stopped being a fact about the code on
          // 2026-08-20, when mainnet trading was enabled and cfg.tradingNetwork became the
          // single place that decides.
          tradingNetwork: cfg.tradingNetwork,
          tradingAllowed: true,
          holder: holder?.client ?? null,
          emptyCount: wallet.emptyCount,
        },
        VERSION,
      );
      sendJson(res, 200, {
        ...greeting,
        pending: pending.map((p) => p.id),
        stale: wallet.stale,
      });
      return;
    }
    if (tool === 'mandate_catalog') {
      sendJson(res, 200, buildMandateCatalog(cfg.tradingNetwork));
      return;
    }
    if (tool === 'balances') {
      const snapshot = ledger.snapshot();
      const composition = classify(snapshot, riskRows);
      sendJson(res, 200, {
        mode: snapshot.mode,
        totalStableUsd: round2(composition.totalUsd),
        totalUsd: round2(snapshot.holdings.reduce((sum, h) => sum + h.usd, 0)),
        holdings: snapshot.holdings,
        chainStatus: snapshot.chainStatus,
        prices: snapshot.prices,
        gas: snapshot.gas,
      });
      return;
    }
    if (tool === 'composition') {
      sendJson(res, 200, classify(ledger.snapshot(), riskRows));
      return;
    }
    if (tool === 'wallet') {
      sendJson(res, 200, buildWallet(ledger.snapshot(), ledger.positions(), ledger.intents()));
      return;
    }
    if (tool === 'policy_show') {
      const policy = getPolicy();
      if (policy === null) {
        sendJson(res, 200, {
          readable: false,
          sentences: [],
          error: 'policy file unreadable: every write is refused until it is fixed',
        });
        return;
      }
      sendJson(res, 200, {
        readable: true,
        killSwitch: policy.killSwitch,
        sentences: sentencesOf(policy),
        policy,
      });
      return;
    }
    if (tool === 'log_tail') {
      sendJson(res, 200, audit.tail(intParam(args.limit, 50, LOG_LIMIT_MAX)));
      return;
    }
    if (tool === 'candles') {
      const product = typeof args.product === 'string' ? args.product : (cfg.candleProducts[0] ?? 'BTC-USD');
      const granularity = intParam(args.granularity, 60, 86400);
      const limit = intParam(args.limit, 120, CANDLE_LIMIT_MAX);
      try {
        sendJson(res, 200, await candles.get(product, granularity, limit));
      } catch (err) {
        sendJson(res, 502, { error: errText(err) });
      }
      return;
    }
    if (tool === 'proposal_status') {
      const id = typeof args.id === 'string' ? args.id : '';
      const proposal = proposals.get(id);
      if (proposal === undefined) {
        sendJson(res, 404, { error: `unknown proposal id: ${id}` });
        return;
      }
      sendJson(res, 200, proposal);
      return;
    }
    if (tool === 'chart_read') {
      sendJson(res, 200, await chartRead());
      return;
    }
    // What can be charted, so an agent can find a market before trying to open it rather
    // than guessing at a product id and reading an error.
    if (tool === 'market_search') {
      const query = typeof args.query === 'string' ? args.query : '';
      const limit = intParam(args.limit, 10, 50);
      const exact = query === '' ? null : market.resolve(query);
      sendJson(res, 200, {
        query,
        // The one it would open, when the query is unambiguous.
        match: exact,
        candidates: market.search(query, limit),
        catalogLoadedAt: market.catalogLoadedAt(),
        note: 'Any of these can be charted on any timeframe from 1m to 1w.',
      });
      return;
    }

    /* Market news, and the only place in this app where an agent's question causes a request to
       leave the machine. Three things make that safe enough to ship, and all three live in
       src/research.ts rather than here: the hosts are a fixed set checked by exact match, the
       agent supplies a search phrase and never a URL, and everything coming back is stripped and
       wrapped in a quote envelope that says out loud it is somebody else's writing.
       The query is already in the audit log: every agent read is written there before dispatch,
       arguments included, by the one line that covers the whole surface. */
    if (tool === 'research') {
      const query = typeof args.query === 'string' ? args.query : '';
      if (query.trim() === '') return sendJson(res, 400, { error: 'query is required' });
      sendJson(res, 200, await research(query, { limit: intParam(args.limit, 8, 20) }));
      return;
    }

    if (tool === 'chart_batch') {
      const ops = Array.isArray(args.ops) ? args.ops : [];
      const view = chart.state().view;
      const results = await runBatch(
        ops as { op: string; args?: Record<string, unknown>; as?: string }[],
        analysisHandlers({
          // The chart's own product and timeframe are the defaults, so an op that names
          // neither measures what the human is currently looking at.
          candles: async (product, granularitySec, limit) =>
            (await loadCandles(product || view.product, granularitySec, limit)).candles,
          history,
          drawings,
        }),
      );
      // A drawing op changes what the window shows, so the browser is told the same way a
      // chart mutation tells it. Reads alone leave the rev alone and repaint nothing.
      if (results.some((r) => r.ok && r.op.startsWith('draw'))) broadcastChart();
      sendJson(res, 200, {
        product: view.product,
        timeframe: timeframeLabel(view.granularitySec),
        results,
      });
      return;
    }
    if (tool === 'indicator_catalog') {
      sendJson(res, 200, {
        indicators: indicatorCatalog(),
        limits: {
          overlaysOnPrice: CHART_LIMITS.maxOverlays,
          subPanes: CHART_LIMITS.maxPanes,
          note: 'A sub-pane request past the maximum is refused with the reason, never squeezed in.',
        },
        timeframes: TIMEFRAMES.map((tf) => tf.label),
      });
      return;
    }
    if (tool === 'chart_measure') {
      const view = chart.state().view;
      try {
        const load = await loadCandles(view.product, view.granularitySec, chart.historyNeeded());
        sendJson(res, 200, {
          product: view.product,
          timeframe: timeframeLabel(view.granularitySec),
          ...(measureChart({
            candles: load.candles,
            granularitySec: view.granularitySec,
            fromTime: numOrUndefined(args.fromTime),
            toTime: numOrUndefined(args.toTime),
            fromPrice: numOrUndefined(args.fromPrice),
            toPrice: numOrUndefined(args.toPrice),
          }) as Record<string, unknown>),
        });
      } catch (err) {
        sendJson(res, 502, { error: errText(err) });
      }
      return;
    }
    if (tool === 'chart_scan') {
      const view = chart.state().view;
      const product = typeof args.product === 'string' && args.product.trim().length > 0 ? args.product.trim().toUpperCase() : view.product;
      const asked = Array.isArray(args.timeframes) ? args.timeframes : ['5m', '15m', '1h', '4h', '1d'];
      // TIMEFRAMES is the button bar (1m to 1d), not the set of legal timeframes. Matching only
      // against it and then snapping the miss meant `1w` fell to snapTimeframe(Number('1w')),
      // and Number('1w') is NaN, so every comparison in the snap was false and it returned the
      // FIRST entry: 1m. A weekly scan silently answered with a minute chart, labelled as if
      // that was what had been asked for. parseTimeframe is what chart_set_view already uses and
      // it handles 1w, 7d, 90m and bare seconds. An entry it cannot read is now refused by name
      // rather than substituted, because a wrong answer that looks right is the worst outcome
      // here: nothing downstream can tell that the bias timeframe was never read.
      const plan: ({ sec: number } | { bad: string })[] = [];
      for (const entry of asked.slice(0, SCAN_TIMEFRAMES_MAX)) {
        const sec = resolveScanTimeframe(entry as string | number);
        plan.push(sec === null ? { bad: String(entry) } : { sec });
      }
      const bars = intParam(args.bars, 120, CANDLE_LIMIT_MAX);
      const nowSec = Math.floor(Date.now() / 1000);
      const rows: unknown[] = [];
      for (const step of plan) {
        if ('bad' in step) {
          rows.push({
            timeframe: step.bad,
            error: `${step.bad} is not a timeframe. Use <count><unit> with unit m, h, d or w, from 1m up to 1w.`,
          });
          continue;
        }
        const sec = step.sec;
        try {
          const load = await loadCandles(product, sec, bars);
          rows.push({ ...digestSeries(load.candles, sec, nowSec), source: load.source, stale: load.stale });
        } catch (err) {
          rows.push({ timeframe: timeframeLabel(sec), granularitySec: sec, error: errText(err) });
        }
      }
      sendJson(res, 200, {
        product,
        scannedAt: new Date(nowSec * 1000).toISOString(),
        barsPerTimeframe: bars,
        // Deliberately does not touch the view: a scan is a question, not a instruction to
        // move the chart the human is looking at.
        chartUnchanged: true,
        timeframes: rows,
      });
      return;
    }
    if (tool === 'trade_read') {
      const symbol = typeof args.symbol === 'string' ? args.symbol : undefined;
      sendJson(res, 200, trade.read(symbol));
      return;
    }
    if (tool === 'trade_batch') {
      sendJson(res, 200, trade.batch(Array.isArray(args.ops) ? (args.ops as unknown[]) : []));
      return;
    }
    sendJson(res, 400, { error: `unknown read tool: ${tool}. known tools: ${READ_TOOLS.join(', ')}` });
  }

  // The human's controls on the trading window. Deliberately NOT reachable from /api/mcp: the
  // agent has no verb for closing a position, and the way that is guaranteed is that the door
  // it knocks on does not open onto this function. A check could be wrong; an absence cannot.
  async function handleTradeAction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await readBody(req);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    const body = parsed.value;
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });
    if (!tokenMatches(body.token, token)) {
      audit.append('approve_attempt_rejected', 'POST /api/trade/action rejected: bad approval token', {
        action: String(body.action ?? ''),
        tokenPresent: typeof body.token === 'string' && body.token.length > 0,
      });
      return sendJson(res, 403, { error: 'invalid approval token' });
    }

    const action = String(body.action ?? '');
    if (!TRADE_ACTIONS.includes(action)) {
      return sendJson(res, 400, { error: `unknown action: ${action}. known: ${TRADE_ACTIONS.join(', ')}` });
    }

    const id = typeof body.id === 'string' ? body.id : undefined;
    const coin = typeof body.coin === 'string' ? body.coin : undefined;
    audit.append('tool_call', `human: ${action}${id ? ` ${id}` : ''}${coin ? ` ${coin}` : ''}`, {
      action,
      id,
      coin,
    });

    try {
      const result = await trade.action({ action, id, coin });
      audit.append(result.ok ? 'executed' : 'error', `${action}: ${result.detail}`, { action, id, coin });
      broadcastTrade();
      broadcastState();
      // `error` alongside `detail` on a failure, because the window builds the sentence it
      // shows from `payload.error`. Without it a refused close reached the human as
      // "/api/trade/action returned 400" and the venue's own words, which are the only part
      // that says what to do next, were dropped on the floor.
      sendJson(res, result.ok ? 200 : 400, result.ok ? result : { ...result, error: result.detail });
    } catch (err) {
      audit.append('error', `${action} failed: ${errText(err)}`);
      sendJson(res, 500, { ok: false, detail: errText(err) });
    }
  }

  // The window's own view writes, the mirror of handleChartWrite. Same reasoning: one door per
  // caller, so the browser uses this and an agent uses /api/mcp, and both land in one place.
  async function handleTradeWrite(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await readBody(req);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    const body = parsed.value;
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin trade write refused' });
    if (!tokenMatches(body.token, token)) return sendJson(res, 403, { error: 'invalid approval token' });

    const notes: string[] = [];
    for (const [key, apply] of [
      ['focus', (a: Record<string, unknown>) => trade.view.setFocus(a, 'human')],
      ['overlay', (a: Record<string, unknown>) => trade.view.setOverlay(a, 'human')],
      ['note', (a: Record<string, unknown>) => trade.view.setNote(a, 'human')],
    ] as const) {
      const arg = body[key];
      if (arg === undefined || arg === null || typeof arg !== 'object') continue;
      const out = apply(arg as Record<string, unknown>);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      notes.push(...out.notes);
    }
    if (typeof body.clear === 'string') {
      const out = trade.view.clear(body.clear);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      notes.push(...out.notes);
    }
    if (typeof body.focus === 'object' && body.focus !== null) {
      const symbol = String((body.focus as Record<string, unknown>).symbol ?? '').toUpperCase();
      const match = cfg.candleProducts.find((p) => p.split('-')[0].toUpperCase() === symbol);
      if (match !== undefined) chart.setView({ product: match }, 'human');
      broadcastChart();
    }
    broadcastTrade();
    sendJson(res, 200, { ok: true, notes });
  }

  function numOrUndefined(raw: unknown): number | undefined {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }

  // ---------- chart writes from the agent ----------

  async function handleView(body: JsonBody, res: http.ServerResponse): Promise<void> {
    const tool = String(body.tool ?? '');
    const args = asRecord(body.args);

    // The trading surface's writes answer with the trading surface, the same way the chart's
    // answer with the chart: an agent that has to read after every write pays two round trips
    // to learn what its own change did.
    //
    // Answered FIRST, and that placement is the fix rather than tidying. This block used to sit
    // in the middle of the chart chain, which cut that chain in two: chart_set_view matched the
    // `if` above it, set `outcome`, then fell into the second chain, matched nothing there, and
    // was refused by the final else as an "unknown view tool: chart_set_view" that the same
    // sentence went on to list as known. Every chart write below the split worked; the one
    // above it was unreachable, and the error blamed the caller for the server's own break.
    if (tool.startsWith('trade_')) {
      let out: { ok: boolean; notes: string[]; error?: string };
      if (tool === 'trade_focus') out = trade.view.setFocus(args, 'agent');
      else if (tool === 'trade_highlight') out = trade.view.highlight(args, 'agent');
      else if (tool === 'trade_overlay') out = trade.view.setOverlay(args, 'agent');
      else if (tool === 'trade_note') out = trade.view.setNote(args, 'agent');
      else out = trade.view.clear(String(args.what ?? 'agent'));

      if (!out.ok) {
        sendJson(res, 400, { error: out.error, notes: out.notes });
        return;
      }
      // Focus moves the chart with it. A trading screen whose position panel and whose candles
      // disagree about which market is on screen is the one bug on this surface a person would
      // not catch, because both halves look right on their own.
      if (tool === 'trade_focus') {
        const symbol = String(args.symbol ?? '').toUpperCase();
        const match = cfg.candleProducts.find((p) => p.split('-')[0].toUpperCase() === symbol);
        if (match !== undefined) chart.setView({ product: match }, 'agent');
      }
      broadcastTrade();
      broadcastChart();
      sendJson(res, 200, { ok: true, notes: out.notes, trade: trade.read() });
      return;
    }

    let outcome: { ok: boolean; notes: string[]; error?: string; id?: string; label?: string };
    if (tool === 'chart_set_view') {
      // Resolve what was asked for into what a venue lists, before the view records it.
      // Without this the view stores the raw string, so "bitcoin" charts correctly and
      // then labels itself BITCOIN, and an agent reading the view back gets a product id
      // no venue would recognise.
      const asked = typeof args.product === 'string' ? args.product.trim() : '';
      if (asked !== '') {
        const ref = market.resolve(asked);
        if (ref === null) {
          const near = market.search(asked, 5).map((m) => m.product);
          const hint = near.length > 0 ? ` did you mean: ${near.join(', ')}` : '';
          sendJson(res, 400, { error: `no market listed for "${asked}".${hint}` });
          return;
        }
        args.product = ref.product;
      }
      outcome = chart.setView(args, 'agent');
    } else if (tool === 'chart_add_indicator') outcome = chart.addIndicator(args, 'agent');
    else if (tool === 'chart_remove_indicator') outcome = chart.removeIndicator(String(args.id ?? args.type ?? ''));
    else if (tool === 'chart_level') outcome = chart.setLevel(args, 'agent');
    else if (tool === 'chart_mark') outcome = chart.setMark(args, 'agent');
    else if (tool === 'chart_trendline') outcome = chart.setTrendline(args, 'agent');
    else if (tool === 'chart_clear') outcome = chart.clear(String(args.what ?? 'agent'));
    else {
      sendJson(res, 400, { error: `unknown view tool: ${tool}. known tools: ${VIEW_TOOLS.join(', ')}` });
      return;
    }

    if (!outcome.ok) {
      sendJson(res, 400, { error: outcome.error, notes: outcome.notes });
      return;
    }
    broadcastChart();
    // Answer with the chart as it now stands. An agent that has to call chart_read after
    // every write spends two round trips learning what its own change did.
    sendJson(res, 200, {
      ok: true,
      id: outcome.id,
      notes: outcome.notes,
      chart: await chartRead(),
    });
  }

  // What the agent gets back from any propose: the id to poll, what the policy decided,
  // and what the simulation said. Never the draft itself, so the app's resolved addresses
  // are not echoed to the caller that was deliberately not allowed to name them.
  function sendProposal(res: http.ServerResponse, proposal: Proposal): void {
    broadcastState();
    sendJson(res, 200, {
      id: proposal.id,
      status: proposal.status,
      verdict: proposal.verdict,
      simulation: proposal.simulation,
    });
  }

  // Boundary checks only: a wrong type or an unknown chain is answered here, and every
  // question about the value of a number (too big, zero, negative) is left to the policy
  // engine and the rails, so money rules stay in one place.
  function numField(params: JsonBody, name: string, problems: string[]): number {
    const raw = params[name];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      problems.push(`${name} must be a finite number`);
      return NaN;
    }
    return raw;
  }

  function strField(params: JsonBody, name: string, problems: string[]): string {
    const raw = params[name];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      problems.push(`${name} is required`);
      return '';
    }
    return raw.trim();
  }

  function chainField(params: JsonBody, name: string, problems: string[]): ChainId {
    const raw = String(params[name] ?? '');
    if (!CHAINS.includes(raw)) {
      problems.push(`${name} must be one of: ${CHAINS.join(', ')}`);
      return 'eth';
    }
    return raw as ChainId;
  }

  async function handlePropose(body: JsonBody, res: http.ServerResponse): Promise<void> {
    const kind = String(body.kind ?? '');
    const params = asRecord(body.params);
    const problems: string[] = [];
    try {
      if (kind === 'swap') {
        const venueRaw = params.venue === undefined ? 'uniswap-v3' : String(params.venue);
        if (venueRaw !== 'uniswap-v3' && venueRaw !== 'oneclick' && venueRaw !== 'intents-native') {
          problems.push('venue must be uniswap-v3, oneclick or intents-native');
        }
        const chain = chainField(params, 'chain', problems);
        const toChain = params.toChain === undefined ? chain : chainField(params, 'toChain', problems);
        // uniswap-v3 is an on-chain DEX and cannot cross chains. Caught HERE, at draft time, with
        // a message that names the fix, rather than deep in the rail as "no verified deployment"
        // that reads like a missing config. This is also the guard against the silent default: a
        // cross-chain swap that names no venue defaults to uniswap-v3 and lands here, told to pick
        // oneclick or intents-native, instead of building an on-chain draft nobody asked for.
        if (venueRaw === 'uniswap-v3' && chain !== toChain) {
          problems.push(
            `uniswap-v3 is a same-chain venue and cannot swap ${chain} to ${toChain}. ` +
              'For a cross-chain swap set venue to "oneclick" or "intents-native".',
          );
        }
        const fromSymbol = strField(params, 'fromSymbol', problems);
        const toSymbol = strField(params, 'toSymbol', problems);
        const amountIn = numField(params, 'amountIn', problems);
        // A negative or zero input has no honest swap. Rejected at the edge so it never reaches
        // usdOf, where a negative amount became "$Infinity ... cannot be checked against a limit"
        // and only failed closed by accident of the arithmetic.
        if (amountIn <= 0) problems.push('amountIn must be greater than 0');
        const minAmountOut = numField(params, 'minAmountOut', problems);
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(
          res,
          await proposals.proposeSwap({
            venue: venueRaw as 'uniswap-v3' | 'oneclick' | 'intents-native',
            chain,
            toChain,
            fromSymbol,
            toSymbol,
            amountIn,
            minAmountOut,
          }),
        );
        return;
      }
      if (kind === 'mandate_arm') {
        const symbol = strField(params, 'symbol', problems);
        const maxNotionalUsd = numField(params, 'maxNotionalUsd', problems);
        const maxLeverage = numField(params, 'maxLeverage', problems);
        const maxOrdersPerMin = numField(params, 'maxOrdersPerMin', problems);
        const maxLossUsd = numField(params, 'maxLossUsd', problems);
        const expiresAt = strField(params, 'expiresAt', problems);
        const allowedActions = Array.isArray(params.allowedActions)
          ? params.allowedActions.map((v) => String(v))
          : [];
        if (allowedActions.length === 0) problems.push('allowedActions must list at least one verb');
        if (params.program === undefined) problems.push('program is required');
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(
          res,
          await proposals.proposeMandate({
            symbol,
            program: params.program,
            maxNotionalUsd,
            maxLeverage,
            maxOrdersPerMin,
            maxLossUsd,
            expiresAt,
            allowedActions,
          }),
        );
        return;
      }
      if (kind === 'hl_deposit') {
        // chain and symbol are optional and both default inside proposeHlDeposit: the money
        // used to have to be USDC on Arbitrum, and now the origin is a choice, so omitting it
        // keeps the old call shape working and naming it is the new capability.
        const chain = params.chain === undefined ? undefined : chainField(params, 'chain', problems);
        const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
        const amount = numField(params, 'amount', problems);
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(res, await proposals.proposeHlDeposit({ chain, symbol, amount }));
        return;
      }
      if (kind === 'intents_deposit') {
        const chain = chainField(params, 'chain', problems);
        // symbol is optional: absent means the chain's gas asset, which is the common case
        // and the one the ERC-20 path could not serve.
        const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
        const amount = numField(params, 'amount', problems);
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(res, await proposals.proposeIntentsDeposit({ chain, symbol, amount }));
        return;
      }
      if (kind === 'intents_withdraw') {
        const chain = chainField(params, 'chain', problems);
        // Same optional symbol as the deposit: absent means the destination chain's gas asset.
        // There is no field here for the address, and there must never be one: the wallet the
        // payout lands in is resolved from config by the proposal service and re-derived by the
        // rail. tests/injection.test.ts holds this schema to that.
        const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
        const amount = numField(params, 'amount', problems);
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(res, await proposals.proposeIntentsWithdraw({ chain, symbol, amount }));
        return;
      }
      if (kind === 'lp_add') {
        const chain = chainField(params, 'chain', problems);
        const token0Symbol = strField(params, 'token0Symbol', problems);
        const token1Symbol = strField(params, 'token1Symbol', problems);
        const amount0 = numField(params, 'amount0', problems);
        const amount1 = numField(params, 'amount1', problems);
        const feeTier = numField(params, 'feeTier', problems);
        const tickLower = numField(params, 'tickLower', problems);
        const tickUpper = numField(params, 'tickUpper', problems);
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(
          res,
          await proposals.proposeLpAdd({
            chain,
            token0Symbol,
            token1Symbol,
            amount0,
            amount1,
            feeTier,
            tickLower,
            tickUpper,
          }),
        );
        return;
      }
      if (kind === 'lp_remove') {
        const positionId = strField(params, 'positionId', problems);
        const liquidityPct = numField(params, 'liquidityPct', problems);
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(res, await proposals.proposeLpRemove({ positionId, liquidityPct }));
        return;
      }
      if (kind === 'consolidate') {
        const toChain = String(params.toChain ?? '');
        const symbol = typeof params.symbol === 'string' ? params.symbol.trim() : '';
        if (!CHAINS.includes(toChain)) {
          sendJson(res, 400, { error: `toChain must be one of: ${CHAINS.join(', ')}` });
          return;
        }
        if (symbol.length === 0) {
          sendJson(res, 400, { error: 'symbol is required' });
          return;
        }
        const fromChains = Array.isArray(params.fromChains)
          ? (params.fromChains.filter((c) => typeof c === 'string' && CHAINS.includes(c)) as ChainId[])
          : undefined;
        const maxTotalUsd = typeof params.maxTotalUsd === 'number' && Number.isFinite(params.maxTotalUsd)
          ? params.maxTotalUsd
          : undefined;
        sendProposal(
          res,
          await proposals.proposeConsolidate({
            toChain: toChain as ChainId,
            symbol,
            ...(fromChains !== undefined && fromChains.length > 0 ? { fromChains } : {}),
            ...(maxTotalUsd !== undefined ? { maxTotalUsd } : {}),
          }),
        );
        return;
      }
      if (kind === 'policy_change') {
        // patch and sentence are passed through as authored: the engine validates
        // the patch, and the sentence is stored as data, never read as instruction.
        const sentence = typeof params.sentence === 'string' ? params.sentence : '';
        sendProposal(res, await proposals.proposePolicyChange({ patch: asRecord(params.patch), sentence }));
        return;
      }
      sendJson(res, 400, { error: `unknown propose kind: ${kind}. known kinds: ${PROPOSE_KINDS.join(', ')}` });
    } catch (err) {
      sendJson(res, 400, { error: errText(err) });
    }
  }

  // The one piece of app state an agent writes directly, and the only agent-reachable
  // thing that changes what a HUMAN sees. It moves no money and gets no policy verdict,
  // so it is neither a read nor a propose.
  //
  // WHAT THE REFUSAL BELOW BUYS, EXACTLY. It stops the surface changing under a decision
  // someone is in the middle of making: no moving the YES button while they read.
  // It does NOT stop an agent choosing which surface a decision happens on, because
  // nothing prevents calling this first and proposing after, and a proposal under the
  // click threshold never becomes 'pending' at all (it goes straight to executed with
  // decidedBy 'policy'). That ordering is inherent to agent-only switching, which is why
  // the real control is that both modes render the same facts, asserted in
  // tests/unit/basic-view.test.ts, not this refusal.
  // Aliases exist because the switch is meant to cost one word. A human says "switch to
  // trading", "go to hft", "back to simple"; an agent should not have to learn which of those
  // is the enum member. Mapping them here rather than in src/mcp.ts keeps the shim stateless
  // and means the /api/mcp path and the MCP path resolve a name identically.
  const VIEW_ALIASES: Record<string, ViewMode> = {
    basic: 'basic',
    simple: 'basic',
    plain: 'basic',
    pro: 'pro',
    operator: 'pro',
    advanced: 'pro',
    wallet: 'pro',
    trade: 'trade',
    trading: 'trade',
    hft: 'trade',
    perps: 'trade',
    hyperliquid: 'trade',
    chart: 'trade',
  };

  // The coins the basic screen tracks. Karim, 2026-08-14: "if I don't want Bitcoin, on
  // Ether it changes to whatever I ask it to change it to, and it's saved as my current
  // favorites". The eye on that screen tells the owner this can be asked for, so the ask
  // has to work: a tooltip promising a capability that does not exist is the same class of
  // fault as a balance the app cannot back.
  //
  // Names go through the market catalog rather than being trusted, so "bitcoin", "btc" and
  // "BTC-USD" all land on one product id and a coin nothing can chart is refused with the
  // reason rather than accepted into a screen that would then show a blank row forever.
  async function handleSetBasicCoins(body: JsonBody, res: http.ServerResponse): Promise<void> {
    const raw = Array.isArray(body.coins) ? body.coins : [];
    const asked = raw.map((c) => String(c ?? '').trim()).filter((c) => c.length > 0);

    if (asked.length < MIN_COINS || asked.length > MAX_COINS) {
      sendJson(res, 400, {
        error: `the basic screen shows ${MIN_COINS} to ${MAX_COINS} coins, got ${asked.length}`,
        coins: basicCoins,
      });
      return;
    }

    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const name of asked) {
      const ref = market.resolve(name);
      if (ref === null) unknown.push(name);
      else if (!resolved.includes(ref.product)) resolved.push(ref.product);
    }
    if (unknown.length > 0) {
      sendJson(res, 400, {
        error: `not a market this app can chart: ${unknown.join(', ')}`,
        coins: basicCoins,
        hint: 'read market_search to find the id, then set that',
      });
      return;
    }

    const previous = basicCoins;
    if (previous.join() === resolved.join()) {
      sendJson(res, 200, { ok: true, coins: resolved, unchanged: true });
      return;
    }

    basicCoins = resolved;
    writeCoins(cfg.dataDir, resolved);
    // Blank rather than stale while the new coins are fetched. The screen renders a coin
    // it has no price for as absent, so the band goes short for one poll instead of
    // showing the old coin's figure under the new coin's name.
    priceReadings = resolved.map(() => null);
    audit.append('view_changed', `agent set the basic screen coins to ${resolved.join(', ')}`, {
      from: previous,
      to: resolved,
    });
    broadcastState();
    await pollPrice();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      coins: resolved,
      from: previous,
      note: 'saved. this is what the basic screen shows until it is asked to change again',
    });
  }

  function handleSetViewMode(body: JsonBody, res: http.ServerResponse): void {
    const raw = String(body.mode ?? '').trim().toLowerCase();
    const mode = VIEW_ALIASES[raw];
    if (mode === undefined) {
      sendJson(res, 400, {
        error: `mode must be basic, pro or trade, got: ${raw || '(missing)'}`,
        accepted: Object.keys(VIEW_ALIASES),
      });
      return;
    }

    // This used to refuse outright while any proposal was pending, so that an agent could not
    // move a human away from a decision they were in the middle of. Commit 7b41af4 put the
    // approval block on the trading window too, and ui/approvals.js now renders it on all
    // three surfaces, so the reason the refusal existed no longer holds: the decision follows
    // the human rather than being left behind on the screen they came from.
    //
    // What replaces it is disclosure, not silence. The pending ids ride back on the response
    // and the tool description tells the agent to say the count out loud, because the basic
    // screen shows one ask at a time and switching there with three waiting would otherwise
    // quietly hide two of them.
    const pending = proposals.list().filter((p) => p.status === 'pending');
    const previous = getView();
    if (mode === previous) {
      sendJson(res, 200, { ok: true, view: mode, unchanged: true, pending: pending.map((p) => p.id) });
      return;
    }
    setView(mode);
    audit.append('view_changed', `agent switched the app window from ${previous} to ${mode}`, {
      from: previous,
      to: mode,
      pending: pending.map((p) => p.id),
    });
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      view: mode,
      from: previous,
      pending: pending.map((p) => p.id),
      // Named rather than implied: an agent reading `pending: []` has to know that an empty
      // array is the good case. A sentence it can repeat costs nothing and gets repeated.
      note:
        pending.length === 0
          ? 'nothing is waiting for a human decision'
          : `${pending.length} proposal(s) still await a human click, and they render on this window too`,
    });
  }

  // A second agent is refused for as long as the first one holds the seat, which can be
  // hours, and it will keep trying: its heartbeat alone is one attempt every few seconds.
  // One audit line per refused session, then silence. The refusal itself is never silent
  // (every call gets the 409 and the reason), only the log is.
  const rejectedSessions = new Set<string>();

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
      sendJson(res, 409, { error, seat: 'revoked' });
      return;
    }
    if (!rejectedSessions.has(session)) {
      rejectedSessions.add(session);
      audit.append('agent_rejected', 'a second agent tried to attach and was refused', {
        op: String(body.op ?? ''),
        client: body.client,
        holder: agents.holder()?.client ?? null,
      });
    }
    // seat:'busy' is the marker src/mcp.ts unwraps into a plain sentence for the agent.
    // It is deliberately not "any 409": the view-mode refusal is also a 409 and must keep
    // its JSON shape, which is what the e2e script and the browser both read.
    sendJson(res, 409, { error, seat: 'busy' });
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
      sendJson(res, 403, { error: 'cross-origin request refused' });
      return;
    }
    const parsed = await readBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
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
      sendJson(res, 200, { ok: true, seat: 'held', since: claim.seat.since });
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

    // Every other op holds the seat or is refused. An op from a session that never said
    // hello takes a free seat: an agent should not have to know about a handshake to be
    // counted as connected, and something has to be attached for a tool call to exist.
    const seat = agents.check(body);
    if (!seat.ok) {
      rejectSeat(seat.error, body, res, seat.revoked === true);
      return;
    }
    if (seat.edge) {
      audit.append('agent_connected', 'an agent attached to phosphor', body);
      // An agent that took the seat on its first op (no hello) is connected NOW. Push state so
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
                : `unknown op ${op}`;
    // Contract: every op that reads, proposes or moves the window is audit-logged
    // before dispatch, arguments included verbatim.
    audit.append('tool_call', `agent: ${capLabel(label)}`, body);

    if (op === 'read') {
      await handleRead(body, res);
      return;
    }
    if (op === 'propose') {
      await handlePropose(body, res);
      return;
    }
    if (op === 'view') {
      await handleView(body, res);
      return;
    }
    if (op === 'set_view_mode') {
      handleSetViewMode(body, res);
      return;
    }
    if (op === 'set_basic_coins') {
      await handleSetBasicCoins(body, res);
      return;
    }
    sendJson(res, 400, {
      error: `unknown op: ${op}. known ops: hello, bye, read, propose, view, set_view_mode, set_basic_coins`,
    });
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
        sendJson(res, 403, { error: 'request refused: this app answers only on 127.0.0.1' });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (route === '/api/state') return sendJsonConditional(req, res, buildState());
        if (route === '/api/candles') return await sendCandles(url, res);
        if (route === '/api/chart') return sendJson(res, 200, chartPayload());
        if (route === '/api/log') {
          return sendJson(res, 200, audit.tail(intParam(url.searchParams.get('limit'), 200, LOG_LIMIT_MAX)));
        }
        if (route === '/api/transactions') {
          const payload = transactionsPayload();
          fillGas(payload.entries);
          return sendJson(res, 200, payload);
        }
        if (route === '/api/trade') return sendJson(res, 200, trade.payload());
        if (route === '/api/session') return sendJson(res, 200, { token });
        if (route === '/api/driver') return sendJson(res, 200, driverPayload());
        if (route === '/api/events') return openEvents(req, res);
        if (route.startsWith('/api/')) return sendJson(res, 404, { error: `unknown route: ${route}` });
        // The second surface. A bare /trade is the page; everything else still resolves as a
        // file, so the two pages share one static root and one stylesheet.
        if (route === '/trade' || route === '/trade/') return serveStatic('/trade.html', res);
        return serveStatic(route, res);
      }
      if (req.method === 'POST') {
        if (route === '/api/mcp') return await handleMcp(req, res);
        if (route === '/api/chart') return await handleChartWrite(req, res);
        if (route === '/api/trade') return await handleTradeWrite(req, res);
        if (route === '/api/trade/action') return await handleTradeAction(req, res);
        if (
          route === '/api/approve' ||
          route === '/api/refuse' ||
          route === '/api/kill' ||
          route === '/api/driver'
        ) {
          return await handleMutation(route, req, res);
        }
        return sendJson(res, 404, { error: `unknown route: ${route}` });
      }
      sendJson(res, 405, { error: `method not allowed: ${String(req.method)}` });
    } catch (err) {
      audit.append('error', `server error on ${route}: ${errText(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: errText(err) });
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
      startDriver('app');
    });
  }

  base.on('close', () => {
    offStore();
    offAudit();
    clearInterval(heartbeat);
    clearInterval(priceTimer);
    for (const client of sseClients) client.end();
    sseClients.clear();
    /* The child dies with the server that started it. An orphaned driver would keep the seat,
       keep spending the user's subscription, and keep proposing into a state directory whose
       window is gone, and it is the app's job to clean up a process the app created. */
    if (driver !== null) driver.stop();
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
