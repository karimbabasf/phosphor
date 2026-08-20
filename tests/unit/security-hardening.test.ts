// The hardening pass, driven against a real server over real HTTP.
//
// The guards live on the wire (a Host header, an Origin
// header, the shape of a proposal body), so a unit test of a lifted function would assert the
// function and not the door. Each test below is one of the red-team's confirmed break-ins,
// turned into a test that fails on the old code and passes on the new.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot, LpPosition, Proposal } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

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

function builtSwap(): Proposal {
  // A stub that stands in for a real draft. The venue and amount guards run BEFORE proposeSwap
  // is called, so a rejected request never reaches this; a request that returns this is one the
  // guards let through.
  return {
    id: 'p-swap',
    kind: 'swap',
    createdAt: new Date().toISOString(),
    status: 'pending',
    draft: {
      kind: 'swap',
      venue: 'oneclick',
      chain: 'arb',
      toChain: 'sol',
      fromSymbol: 'USDC',
      toSymbol: 'SOL',
      amountIn: 100,
      amountUsd: 100,
      minAmountOut: 0.5,
      from: '0xself',
      to: '0xself',
      counterparty: 'oneclick:1click.chaindefuser.com',
      quote: null,
    },
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: ['above the click threshold'] },
  };
}

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-sec-'));
  const cfg: AppConfig = {
    mode: 'demo',
    network: 'testnet',
    tradingNetwork: 'testnet',
    approvalGate: true,
    port: 0,
    addresses: { evm: ['0xself'], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };
  const server = createServer({
    cfg,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    riskRows: [],
    ledger: {
      snapshot,
      positions: (): LpPosition[] => [],
      intents: () => undefined,
      refresh: async () => snapshot(),
      applyDemoTransfer: () => {},
    },
    candles: {
      get: async () => ({ candles: [], stale: false, source: 'test', fetchedAt: new Date().toISOString() }),
      spot: async () => 1,
    },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposeConsolidate: async () => builtSwap(),
      proposePolicyChange: async () => builtSwap(),
      // Only reached when the swap guards pass. A bad venue or amount is refused before here.
      proposeSwap: async () => builtSwap(),
      proposeHlDeposit: async () => builtSwap(),
      proposeIntentsDeposit: async () => builtSwap(),
      proposeIntentsWithdraw: async () => builtSwap(),
      proposeMandate: async () => builtSwap(),
      proposeLpAdd: async () => builtSwap(),
      proposeLpRemove: async () => builtSwap(),
      approve: async () => builtSwap(),
      refuse: async () => builtSwap(),
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents: createAgents(),
    getView: () => 'pro',
    setView: () => {},
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      onUpdate: () => {},
      stop: () => {},
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// A request with explicit control over Host and Origin, which fetch() will not let a caller set.
function raw(
  urlBase: string,
  route: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(urlBase + route);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: opts.headers ?? {} },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

test('a forged Host is refused on every route, closing DNS-rebinding (Finding 4)', async () => {
  const h = await boot();
  try {
    for (const route of ['/api/session', '/api/state']) {
      const out = await raw(h.url, route, { headers: { Host: 'evil.com' } });
      assert.equal(out.status, 403, `${route} under a foreign Host must be refused`);
    }
    // The real loopback name still answers.
    const ok = await raw(h.url, '/api/session', { headers: { Host: '127.0.0.1' } });
    assert.equal(ok.status, 200);
  } finally {
    await h.close();
  }
});

test('a cross-origin POST to /api/mcp is refused, closing CSRF (Findings 2 and 3)', async () => {
  const h = await boot();
  try {
    const foreign = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://evil.com' },
      body: JSON.stringify({ op: 'read', tool: 'balances' }),
    });
    assert.equal(foreign.status, 403, 'a foreign Origin must not drive the money surface');

    // The MCP proxy and curl send no Origin: that path stays open, or the app is unusable.
    const local = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'read', tool: 'start' }),
    });
    assert.notEqual(local.status, 403, 'an absent Origin is a local caller and must be allowed');
  } finally {
    await h.close();
  }
});

test('a cross-chain swap that names no venue is refused with the venue to use (S3, the reported bug)', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'propose',
        kind: 'swap',
        params: { chain: 'arb', toChain: 'sol', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 100, minAmountOut: 0.5 },
      }),
    });
    assert.equal(out.status, 400);
    assert.match(out.body, /uniswap-v3 is a same-chain venue/);
    assert.match(out.body, /oneclick|intents-native/);
  } finally {
    await h.close();
  }
});

test('the same cross-chain swap with venue oneclick passes the guard and builds', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'propose',
        kind: 'swap',
        params: { chain: 'arb', toChain: 'sol', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 100, minAmountOut: 0.5, venue: 'oneclick' },
      }),
    });
    assert.equal(out.status, 200, 'a named cross-chain venue must not be refused by the guard');
  } finally {
    await h.close();
  }
});

test('a negative amountIn is refused at the edge, never reaching the USD math (Finding 8)', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'propose',
        kind: 'swap',
        params: { chain: 'arb', fromSymbol: 'USDC', toSymbol: 'WETH', amountIn: -5, minAmountOut: 0 },
      }),
    });
    assert.equal(out.status, 400);
    assert.match(out.body, /amountIn must be greater than 0/);
  } finally {
    await h.close();
  }
});
