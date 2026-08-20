// /api/state is requested on a timer whether or not anything changed, and the browser rebuilds
// the wallet, the policy and the basic screen from the answer every time. Measured on a real
// instance, the 54KB body is byte-identical between those requests, so almost all of that work
// repaints identical pixels.
//
// An ETag makes the unchanged case cost a 304 and nothing else: no body, no JSON.parse, no DOM
// teardown, no layout. Freshness does not change, because the request still happens on every
// signal; only the redraw is skipped, and only when the bytes are the same.
//
// The last test is the one that matters most: the 304 shortcut runs inside the same handler as
// every other route and must not become a way around the Host guard that closes DNS rebinding.

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
import type { AppConfig, ChainId, ChainStatus, Holding, LedgerSnapshot, LpPosition } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

// Fixed, unlike the fixture in security-hardening.test.ts, which stamps a fresh timestamp on
// every call. A moving timestamp would change the bytes on every request and make an ETag
// useless, which is exactly the property the real payload was checked for before this was built.
const FETCHED_AT = '2026-08-19T00:00:00.000Z';

// What test 4 mutates to prove a real change still gets a full 200.
let holdings: Holding[] = [];

function snapshot(): LedgerSnapshot {
  const status: ChainStatus = { ok: true, fetchedAt: FETCHED_AT };
  return {
    holdings,
    chainStatus: Object.fromEntries(CHAINS.map((c) => [c, status])) as Record<ChainId, ChainStatus>,
    mode: 'demo',
    prices: {},
    gas: Object.fromEntries(CHAINS.map((c) => [c, { transferCostUsd: 0.1 }])) as LedgerSnapshot['gas'],
  };
}

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-etag-'));
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
      get: async () => ({ candles: [], stale: false, source: 'test', fetchedAt: FETCHED_AT }),
      spot: async () => 1,
    },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposeConsolidate: async () => { throw new Error('unused'); },
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeIntentsDeposit: async () => { throw new Error('unused'); },
      proposeIntentsWithdraw: async () => { throw new Error('unused'); },
      proposeMandate: async () => { throw new Error('unused'); },
      proposeLpAdd: async () => { throw new Error('unused'); },
      proposeLpRemove: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
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

function raw(
  urlBase: string,
  route: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const u = new URL(urlBase + route);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('/api/state carries an ETag, so a caller can ask whether anything changed', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/state', { Host: '127.0.0.1' });
    assert.equal(out.status, 200);
    assert.ok(out.headers.etag !== undefined, 'the state response must carry an ETag');
    assert.ok(out.body.length > 0);
  } finally {
    await h.close();
  }
});

test('an unchanged state answers 304 with no body, which is the whole point', async () => {
  const h = await boot();
  try {
    const first = await raw(h.url, '/api/state', { Host: '127.0.0.1' });
    const etag = String(first.headers.etag);
    const second = await raw(h.url, '/api/state', { Host: '127.0.0.1', 'If-None-Match': etag });
    assert.equal(second.status, 304);
    assert.equal(second.body, '', 'a 304 must not spend the 54KB it was built to avoid');
  } finally {
    await h.close();
  }
});

test('a stale ETag still gets the full body, so a client can never be stuck on old state', async () => {
  const h = await boot();
  try {
    const out = await raw(h.url, '/api/state', { Host: '127.0.0.1', 'If-None-Match': '"not-the-current-one"' });
    assert.equal(out.status, 200);
    assert.ok(out.body.length > 0);
  } finally {
    await h.close();
  }
});

test('a real change moves the ETag and delivers the new state', async () => {
  const h = await boot();
  holdings = [];
  try {
    const before = await raw(h.url, '/api/state', { Host: '127.0.0.1' });
    const etag = String(before.headers.etag);

    // Money arrives. The next conditional request must not be told nothing happened.
    holdings = [{ chain: 'arb', symbol: 'USDC', amount: 25, usd: 25 } as unknown as Holding];

    const after = await raw(h.url, '/api/state', { Host: '127.0.0.1', 'If-None-Match': etag });
    assert.equal(after.status, 200, 'a changed state must never answer 304');
    assert.notEqual(String(after.headers.etag), etag, 'the ETag must move when the state moves');
    assert.ok(after.body.includes('USDC'), 'the new holding must be in the body');
  } finally {
    holdings = [];
    await h.close();
  }
});

test('the 304 shortcut is still behind the Host guard, so it is not a way around DNS rebinding', async () => {
  const h = await boot();
  try {
    const good = await raw(h.url, '/api/state', { Host: '127.0.0.1' });
    const etag = String(good.headers.etag);
    // A rebinding page knows the ETag it was served and must still be refused, not answered 304.
    const forged = await raw(h.url, '/api/state', { Host: 'evil.com', 'If-None-Match': etag });
    assert.equal(forged.status, 403, 'a forged Host must be refused before any cache check runs');
  } finally {
    await h.close();
  }
});
