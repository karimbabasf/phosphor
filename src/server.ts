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

import type { AppConfig, ChainId, Policy, ProposalService, RiskRow } from './types.ts';
import type { Audit } from './audit.ts';
import type { Store } from './store.ts';
import type { Ledger } from './ledger/index.ts';
import type { CandleService } from './candles.ts';
import type { LiveCandles } from './hyperliquid.ts';
import { classify } from './composition.ts';
import { buildWallet } from './wallet.ts';
import { gateRequired, gateBanner } from './policy/gate.ts';
import { renderSentences } from './policy/render.ts';

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
const READ_TOOLS: readonly string[] = [
  'balances',
  'composition',
  'wallet',
  'policy_show',
  'log_tail',
  'candles',
  'proposal_status',
];

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

  async function sendCandles(url: URL, res: http.ServerResponse): Promise<void> {
    const product = url.searchParams.get('product') ?? cfg.candleProducts[0] ?? 'BTC-USD';
    const granularity = intParam(url.searchParams.get('granularity'), 60, 86400);
    const limit = intParam(url.searchParams.get('limit'), 120, CANDLE_LIMIT_MAX);
    // Keep the trade stream pointed at whatever the chart is showing. Cheap and
    // idempotent, and it means the sub-minute book is already warm on a switch.
    live.watch(product);

    // Under a minute there is no exchange candle to fetch: Hyperliquid's interval
    // enum starts at 1m and rejects anything smaller with a 422. Those candles are
    // built here from the trade stream, so they are live-only and start empty.
    if (granularity < 60) {
      const built = live.seconds(product, granularity, limit);
      const body = JSON.stringify(built);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'x-candle-source': 'hyperliquid live trades',
        'x-candle-stale': String(!live.connected()),
        'x-candle-fetched-at': new Date().toISOString(),
        'x-candle-built': 'trades',
        'x-candle-collected': String(live.collectedSec(product)),
      });
      res.end(body);
      return;
    }

    try {
      const result = await candles.get(product, granularity, limit);
      // Body is Candle[] per the contract; the staleness marker the chart region
      // needs rides in headers so the body shape stays exactly what was specified.
      const body = JSON.stringify(result.candles);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'x-candle-source': result.source,
        'x-candle-stale': String(result.stale),
        'x-candle-fetched-at': result.fetchedAt,
      });
      res.end(body);
    } catch (err) {
      sendJson(res, 502, { error: errText(err) });
    }
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
    sendJson(res, 400, { error: `unknown read tool: ${tool}. known tools: ${READ_TOOLS.join(', ')}` });
  }

  async function handlePropose(body: JsonBody, res: http.ServerResponse): Promise<void> {
    const kind = String(body.kind ?? '');
    const params = asRecord(body.params);
    try {
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
        const proposal = await proposals.proposeConsolidate({
          toChain: toChain as ChainId,
          symbol,
          ...(fromChains !== undefined && fromChains.length > 0 ? { fromChains } : {}),
          ...(maxTotalUsd !== undefined ? { maxTotalUsd } : {}),
        });
        broadcastState();
        sendJson(res, 200, {
          id: proposal.id,
          status: proposal.status,
          verdict: proposal.verdict,
          simulation: proposal.simulation,
        });
        return;
      }
      if (kind === 'policy_change') {
        // patch and sentence are passed through as authored: the engine validates
        // the patch, and the sentence is stored as data, never read as instruction.
        const sentence = typeof params.sentence === 'string' ? params.sentence : '';
        const proposal = await proposals.proposePolicyChange({
          patch: asRecord(params.patch),
          sentence,
        });
        broadcastState();
        sendJson(res, 200, {
          id: proposal.id,
          status: proposal.status,
          verdict: proposal.verdict,
          simulation: proposal.simulation,
        });
        return;
      }
      sendJson(res, 400, { error: `unknown propose kind: ${kind}. known kinds: consolidate, policy_change` });
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
    sendJson(res, 400, { error: `unknown op: ${op}. known ops: hello, read, propose` });
  }

  // ---------- dispatch ----------

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const route = url.pathname;
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (route === '/api/state') return sendJson(res, 200, buildState());
        if (route === '/api/candles') return await sendCandles(url, res);
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
