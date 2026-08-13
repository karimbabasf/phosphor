// PHOSPHOR HTTP server: the one-page approval surface, the browser JSON routes,
// an SSE change stream, and the single /api/mcp route the MCP proxy speaks.
//
// Approve, refuse and kill are the only mutating browser routes and every one of
// them requires the per-boot token that GET /api/session hands out. Every /api/mcp
// op is audit-logged as a tool_call before dispatch, and every rejected mutation is
// audit-logged as approve_attempt_rejected.
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

import type { AppConfig, Candle, ChainId, Policy, Proposal, ProposalService, RiskRow } from './types.ts';
import type { Audit } from './audit.ts';
import type { Store } from './store.ts';
import type { Ledger } from './ledger/index.ts';
import type { CandleService } from './candles.ts';
import type { LiveCandles } from './hyperliquid.ts';
import { classify } from './composition.ts';
import { buildWallet } from './wallet.ts';
import { gateRequired, gateBanner } from './policy/gate.ts';
import { renderSentences } from './policy/render.ts';
import {
  buildRead,
  createChartStore,
  digestSeries,
  LIMITS as CHART_LIMITS,
  measure as measureChart,
  snapTimeframe,
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

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const STATE_DEBOUNCE_MS = 120;
const HEARTBEAT_MS = 15000; // SSE keepalive; doubles as a floor on state freshness
const LOG_LIMIT_MAX = 2000;
const CANDLE_LIMIT_MAX = 1000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const CHAINS: readonly string[] = ['eth', 'base', 'arb', 'sol', 'near'];
const PROPOSE_KINDS: readonly string[] = ['consolidate', 'policy_change', 'swap', 'hl_deposit', 'lp_add', 'lp_remove'];
const READ_TOOLS: readonly string[] = [
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
  'chart_clear',
];
const SCAN_TIMEFRAMES_MAX = 6;

export type ServerDeps = {
  cfg: AppConfig;
  audit: Audit;
  store: Store;
  ledger: Ledger;
  riskRows: RiskRow[];
  candles: CandleService;
  live: LiveCandles;
  proposals: ProposalService;
  getPolicy: () => Policy | null;
  setKill: (on: boolean) => void;
  agentSeen: () => void;
  agentsConnected: () => number;
};

// http.Server plus an explicit push so the wiring layer can signal the UI after
// a ledger refresh, which no store or audit subscription would otherwise catch.
export type PhosphorServer = http.Server & { broadcastState(): void };

type JsonBody = Record<string, unknown>;
type BodyResult = { ok: true; value: JsonBody } | { ok: false; error: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): JsonBody {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonBody) : {};
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
  const { cfg, audit, store, ledger, riskRows, candles, live, proposals } = deps;
  const { getPolicy, setKill, agentSeen, agentsConnected } = deps;

  const token = crypto.randomBytes(24).toString('hex');
  audit.append('app_start', 'approval surface armed: browser approval token minted for this boot');

  const sseClients = new Set<http.ServerResponse>();
  let stateTimer: NodeJS.Timeout | null = null;

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

  function sseSend(res: http.ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcastState(): void {
    if (stateTimer !== null) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      for (const client of sseClients) sseSend(client, { type: 'state' });
    }, STATE_DEBOUNCE_MS);
    stateTimer.unref();
  }

  // The revision rides along so the browser can tell an agent's change from the echo of its
  // own. It ignores anything at or below the rev its last write returned, which is what keeps
  // a server round trip from fighting the hand that is dragging the chart.
  function broadcastChart(): void {
    for (const client of sseClients) sseSend(client, { type: 'chart', rev: chart.rev() });
  }

  const offStore = store.subscribe(() => broadcastState());
  const offAudit = audit.subscribe((event) => {
    for (const client of sseClients) sseSend(client, { type: 'log', event });
  });

  // Trades push the chart instead of the chart polling for them. The live layer
  // already coalesces to ~10/s, so a busy coin cannot flood the SSE channel.
  live.onUpdate(() => {
    for (const client of sseClients) sseSend(client, { type: 'candles' });
  });

  const heartbeat = setInterval(() => {
    for (const client of sseClients) sseSend(client, { type: 'state' });
  }, HEARTBEAT_MS);
  heartbeat.unref();

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
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
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
    return {
      ledger: snapshot,
      // wallet is what the UI renders; composition stays because the policy engine
      // reads byIssuer and freezableShare out of it.
      wallet: buildWallet(snapshot, ledger.positions()),
      composition,
      policy,
      gate: { required: gateRequired(cfg), banner: gateBanner(cfg) },
      network: cfg.network,
      sentences: sentencesOf(policy),
      proposals: proposals.list(),
      mode: cfg.mode,
      agents: { connected: agentsConnected() },
      candleProducts: cfg.candleProducts,
    };
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
    collectedSec: number;
    fetchedAt: string;
  };

  // One loader behind every candle surface: the legacy /api/candles route, the chart payload
  // the browser renders, and every agent read. Two loaders would let the number the agent
  // reads drift from the pixel the human sees.
  async function loadCandles(product: string, granularitySec: number, limit: number): Promise<CandleLoad> {
    // Keep the trade stream pointed at whatever the chart is showing. Cheap and
    // idempotent, and it means the sub-minute book is already warm on a switch.
    live.watch(product);

    // Under a minute there is no exchange candle to fetch: Hyperliquid's interval
    // enum starts at 1m and rejects anything smaller with a 422. Those candles are
    // built here from the trade stream, so they are live-only and start empty.
    if (granularitySec < 60) {
      return {
        candles: live.seconds(product, granularitySec, limit),
        source: 'hyperliquid live trades',
        stale: !live.connected(),
        built: 'trades',
        collectedSec: live.collectedSec(product),
        fetchedAt: new Date().toISOString(),
      };
    }
    const result = await candles.get(product, granularitySec, limit);
    return {
      candles: result.candles,
      source: result.source,
      stale: result.stale,
      built: 'candles',
      collectedSec: 0,
      fetchedAt: result.fetchedAt,
    };
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
        'x-candle-collected': String(load.collectedSec),
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
  async function chartPayload(): Promise<unknown> {
    const state = chart.state();
    let load: CandleLoad;
    let error: string | null = null;
    try {
      load = await loadCandles(state.view.product, state.view.granularitySec, chart.historyNeeded());
    } catch (err) {
      error = errText(err);
      load = {
        candles: [],
        source: 'unavailable',
        stale: true,
        built: '',
        collectedSec: 0,
        fetchedAt: new Date().toISOString(),
      };
    }
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
        collectedSec: load.collectedSec,
        fetchedAt: load.fetchedAt,
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
        meta: { source: load.source, stale: load.stale, built: load.built, collectedSec: load.collectedSec },
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
  function sameOrigin(req: http.IncomingMessage): boolean {
    const host = String(req.headers.host ?? '');
    const hostname = host.split(':')[0];
    if (hostname !== HOST && hostname !== 'localhost') return false;
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
      // The supplied token itself never enters the audit log.
      audit.append('approve_attempt_rejected', `POST ${route} rejected: ${reason}`, {
        route,
        id,
        reason,
        tokenPresent: typeof body.token === 'string' && body.token.length > 0,
      });
      sendJson(res, parsed.ok ? 403 : 400, { error: parsed.ok ? 'invalid approval token' : reason });
      return;
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
      sendJson(res, 200, buildWallet(ledger.snapshot(), ledger.positions()));
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
      const wanted: number[] = [];
      for (const entry of asked.slice(0, SCAN_TIMEFRAMES_MAX)) {
        const found = TIMEFRAMES.find((tf) => tf.label === String(entry));
        wanted.push(found === undefined ? snapTimeframe(Number(entry)) : found.sec);
      }
      const bars = intParam(args.bars, 120, CANDLE_LIMIT_MAX);
      const nowSec = Math.floor(Date.now() / 1000);
      const rows: unknown[] = [];
      for (const sec of wanted) {
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
    sendJson(res, 400, { error: `unknown read tool: ${tool}. known tools: ${READ_TOOLS.join(', ')}` });
  }

  function numOrUndefined(raw: unknown): number | undefined {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }

  // ---------- chart writes from the agent ----------

  async function handleView(body: JsonBody, res: http.ServerResponse): Promise<void> {
    const tool = String(body.tool ?? '');
    const args = asRecord(body.args);

    let outcome: { ok: boolean; notes: string[]; error?: string; id?: string; label?: string };
    if (tool === 'chart_set_view') outcome = chart.setView(args, 'agent');
    else if (tool === 'chart_add_indicator') outcome = chart.addIndicator(args, 'agent');
    else if (tool === 'chart_remove_indicator') outcome = chart.removeIndicator(String(args.id ?? args.type ?? ''));
    else if (tool === 'chart_level') outcome = chart.setLevel(args, 'agent');
    else if (tool === 'chart_mark') outcome = chart.setMark(args, 'agent');
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
        if (venueRaw !== 'uniswap-v3' && venueRaw !== 'oneclick') {
          problems.push('venue must be uniswap-v3 or oneclick');
        }
        const chain = chainField(params, 'chain', problems);
        const toChain = params.toChain === undefined ? chain : chainField(params, 'toChain', problems);
        const fromSymbol = strField(params, 'fromSymbol', problems);
        const toSymbol = strField(params, 'toSymbol', problems);
        const amountIn = numField(params, 'amountIn', problems);
        const minAmountOut = numField(params, 'minAmountOut', problems);
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(
          res,
          await proposals.proposeSwap({
            venue: venueRaw as 'uniswap-v3' | 'oneclick',
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
      if (kind === 'hl_deposit') {
        const amount = numField(params, 'amount', problems);
        if (problems.length > 0) {
          sendJson(res, 400, { error: problems.join('; ') });
          return;
        }
        sendProposal(res, await proposals.proposeHlDeposit({ amount }));
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

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await readBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const body = parsed.value;
    const op = String(body.op ?? '');

    const label =
      op === 'read'
        ? `read ${String(body.tool ?? '?')}`
        : op === 'propose'
          ? `propose ${String(body.kind ?? '?')}`
          : op === 'view'
            ? `chart ${String(body.tool ?? '?')}`
            : op === 'hello'
              ? `hello from ${String(body.client ?? 'unknown client')}`
              : `unknown op ${op}`;
    // Contract: every op is audit-logged before dispatch, arguments included verbatim.
    audit.append('tool_call', `agent: ${label}`, body);

    if (op === 'hello') {
      agentSeen();
      broadcastState();
      sendJson(res, 200, { ok: true });
      return;
    }
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
    sendJson(res, 400, { error: `unknown op: ${op}. known ops: hello, read, propose, view` });
  }

  // ---------- dispatch ----------

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const route = url.pathname;
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (route === '/api/state') return sendJson(res, 200, buildState());
        if (route === '/api/candles') return await sendCandles(url, res);
        if (route === '/api/chart') return sendJson(res, 200, await chartPayload());
        if (route === '/api/log') {
          return sendJson(res, 200, audit.tail(intParam(url.searchParams.get('limit'), 200, LOG_LIMIT_MAX)));
        }
        if (route === '/api/session') return sendJson(res, 200, { token });
        if (route === '/api/events') return openEvents(req, res);
        if (route.startsWith('/api/')) return sendJson(res, 404, { error: `unknown route: ${route}` });
        return serveStatic(route, res);
      }
      if (req.method === 'POST') {
        if (route === '/api/mcp') return await handleMcp(req, res);
        if (route === '/api/chart') return await handleChartWrite(req, res);
        if (route === '/api/approve' || route === '/api/refuse' || route === '/api/kill') {
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

  base.on('close', () => {
    offStore();
    offAudit();
    clearInterval(heartbeat);
    for (const client of sseClients) client.end();
    sseClients.clear();
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

  return Object.assign(base, { broadcastState });
}
