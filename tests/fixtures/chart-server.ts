// A real server over a fake venue, for the chart tests.
//
// The market layer is the real one with two things swapped underneath it: a store whose
// fetch answers synthetic bars for any product, and a catalogue that lists three coins. So a
// chart_draw that sets a product resolves it exactly as the app would, and a chart_read
// computes indicators over bars the same way, and nothing dials a venue. The trading service
// is inert except for its payload, which a test may fill with plans: chart_draw reads them to
// refuse clearing one that is not an idea.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { MAX_AGENTS, createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { createMarketStore } from '../../src/market/store.ts';
import type { LiveSocket } from '../../src/market/live.ts';
import type { Catalog, MarketRef, Provider } from '../../src/market/catalog.ts';
import type { AppConfig, Candle, ChainId, ChainStatus, LedgerSnapshot, ViewMode } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const COINS = ['BTC', 'ETH', 'SOL'];

function ref(symbol: string, provider: Provider = 'hyperliquid'): MarketRef {
  return { product: `${symbol}-USD`, provider, symbol, quote: 'USD', kind: provider === 'hyperliquid' ? 'perp' : 'spot' };
}

function symbolOf(query: string): string | null {
  const key = query.trim().toUpperCase().split('-')[0] ?? '';
  return COINS.includes(key) ? key : null;
}

export function fakeCatalog(): Catalog {
  return {
    refresh: async () => {},
    resolve: (query) => {
      const s = symbolOf(query);
      return s === null ? null : ref(s);
    },
    resolveOn: (query, provider) => {
      const s = symbolOf(query);
      return s === null ? null : ref(s, provider);
    },
    search: (query, limit = 10) => COINS.filter((c) => c.includes(query.toUpperCase())).slice(0, limit).map((c) => ref(c)),
    all: () => COINS.map((c) => ref(c)),
    loadedAt: () => new Date().toISOString(),
  };
}

// Bars ending on the current minute, a gentle sine over a rising drift, so every indicator
// has something to compute and the newest bar is never stale.
export function syntheticBars(product: string, baseSec: number, bars: number, nowMs = Date.now()): Candle[] {
  const seed = product.charCodeAt(0) * 10;
  const end = Math.floor(nowMs / 1000 / baseSec) * baseSec;
  const out: Candle[] = [];
  for (let i = bars - 1; i >= 0; i--) {
    const t = end - i * baseSec;
    const k = bars - 1 - i;
    const c = 100 + seed + Math.sin(k / 9) * 4 + k * 0.05;
    out.push({ t, o: c - 0.3, h: c + 1, l: c - 1, c, v: 10 + (k % 7) });
  }
  return out;
}

export type ChartHarness = {
  url: string;
  close: () => Promise<void>;
  view: (mode: ViewMode) => void;
  setPlans: (plans: unknown[]) => void;
  fetches: () => { product: string; baseSec: number; startedAt: number; endedAt: number }[];
  mcp: (body: unknown) => Promise<{ status: number; json: any }>;
  post: (route: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>;
  get: (route: string) => Promise<{ status: number; json: any }>;
  token: string;
  // The seat secret the door takes; `mcp` carries it, `post` does not.
  seat: string;
  audit: ReturnType<typeof createAudit>;
  agents: ReturnType<typeof createAgents>;
};

function snapshot(): LedgerSnapshot {
  const fetchedAt = new Date().toISOString();
  const status: ChainStatus = { ok: true, fetchedAt };
  return {
    holdings: [],
    chainStatus: Object.fromEntries(CHAINS.map((c) => [c, status])) as Record<ChainId, ChainStatus>,
    mode: 'demo',
    prices: {},
    gas: Object.fromEntries(CHAINS.map((c) => [c, { transferCostUsd: 0.1 }])) as LedgerSnapshot['gas'],
  };
}

export async function bootChartServer(
  opts: {
    view?: ViewMode;
    fetchDelayMs?: number;
    indicators?: Record<string, string | Buffer>;
    // A fake socket factory switches the live rail on; without one the fixture dials nothing.
    liveSocket?: (url: string) => LiveSocket;
  } = {},
): Promise<ChartHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chart-'));
  // Files a test drops into the indicators folder before the server reads it at boot, the way
  // a human would: name to body, read by the real loader through the real resolver.
  if (opts.indicators !== undefined) {
    fs.mkdirSync(path.join(dataDir, 'indicators'));
    for (const [name, body] of Object.entries(opts.indicators)) fs.writeFileSync(path.join(dataDir, 'indicators', name), body);
  }
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  let view: ViewMode = opts.view ?? 'trade';
  let plans: unknown[] = [];
  const fetches: { product: string; baseSec: number; startedAt: number; endedAt: number }[] = [];

  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: { evm: ['0xself'], solana: [], near: [] },
    candleProducts: ['BTC-USD', 'ETH-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };

  const token = 'a'.repeat(48);
  const marketStore = createMarketStore({
    fetchWindow: async (product, baseSec, bars) => {
      const row = { product, baseSec, startedAt: Date.now(), endedAt: 0 };
      fetches.push(row);
      if (opts.fetchDelayMs !== undefined) await new Promise((r) => setTimeout(r, opts.fetchDelayMs));
      row.endedAt = Date.now();
      return syntheticBars(product, baseSec, bars);
    },
  });
  const market = createMarketData({
    store: marketStore,
    catalog: fakeCatalog(),
    live: opts.liveSocket === undefined ? undefined : { enabled: true, wsImpl: opts.liveSocket },
  });

  /* This boot's seat secret, which every op on /api/mcp has to carry (src/http/mcp.ts). `mcp`
     below sends it for a test that is not about the door; a test that is posts through `post`
     and chooses what to carry. */
  const seat = 's'.repeat(64);
  const agents = createAgents(Date.now, MAX_AGENTS, { secret: seat });
  agents.claim({ session: 'unnamed-session', client: 'test' });

  const server = createServer({
    cfg,
    token,
    audit,
    store,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, refresh: async () => snapshot(), hyperliquid: () => undefined },
    market,
    proposals: {
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
      proposeIntentsDeposit: async () => { throw new Error('unused'); },
      proposeIntentsWithdraw: async () => { throw new Error('unused'); },
      proposeIntentsSend: async () => { throw new Error('unused'); },
      proposeTrade: async () => { throw new Error('unused'); },
      proposeTradeChange: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: async () => { throw new Error('unused'); },
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      acknowledge: () => Promise.reject(new Error('not wired in this stub')),
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents,
    getView: () => view,
    setView: (mode) => {
      view = mode;
    },
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({ plans }) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      plan: () => ({ ok: false as const, error: 'no venue in this test' }),
      meta: () => null,
      mark: () => null,
      free: () => null,
      onUpdate: () => {},
      stop: () => {},
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  async function post(route: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url, ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  return {
    url,
    token,
    seat,
    audit,
    agents,
    close: () => {
      market.stopLive();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
    view: (mode) => {
      view = mode;
    },
    setPlans: (next) => {
      plans = next;
    },
    fetches: () => fetches,
    mcp: (body) => post('/api/mcp', { secret: seat, ...(body as Record<string, unknown>) }),
    post,
    get: async (route) => {
      const res = await fetch(`${url}${route}`);
      return { status: res.status, json: await res.json() };
    },
  };
}
