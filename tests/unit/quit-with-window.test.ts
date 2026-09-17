// Quit with the window still open, which is every quit.
//
// main.ts stops on SIGTERM by awaiting `server.close()`, and node's close waits for every open
// connection to end before it calls back. The window holds /api/events open the whole time it
// exists, and the shell that sent the SIGTERM is blocked waiting for node, so the window never
// goes away and the stream never ends: node waited on the window, the shell waited on node, and
// SHUTDOWN_GRACE (35 s) in src-tauri/src/backend.rs was the only thing that ever ended it, with
// a SIGKILL. Every quit took half a minute and Karim force quit instead.
//
// The server's own close has to hang up on its clients, not wait for them.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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
import { createKeystore } from '../../src/keystore/index.ts';
import { createSession } from '../../src/keystore/session.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import type { AppConfig, LedgerSnapshot } from '../../src/types.ts';


function snapshot(): LedgerSnapshot {
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices: {} };
}

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-quit-'));
  process.env.PHOSPHOR_WINDOW_TOKEN = crypto.randomBytes(32).toString('hex');
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'demo', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: {},
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath,
  };
  const session = createSession({ isUnlocked: () => keystore.isUnlocked(), lock: () => keystore.lock() });
  const server = createServer({
    cfg,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    keystore,
    session,
    riskRows: [],
    ledger: {
      snapshot,
      intents: () => undefined,
      hyperliquid: () => undefined,
      refresh: async () => snapshot(),
    },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
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
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      reconcileOpen: async () => 0,
      settled: async () => { throw new Error('unused'); },
      acknowledge: () => Promise.reject(new Error('not wired in this stub')),
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
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
      plan: () => ({ ok: false as const, error: 'no venue in this test' }),
      meta: () => null,
      mark: () => null,
      free: () => null,
      onUpdate: () => {},
      stop: () => {},
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, server };
}

// The window's event stream: opened and then left exactly as it is, the way a real window
// leaves it until the process behind it goes away.
function openStream(url: string): Promise<{ res: http.IncomingMessage; ended: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url}/api/events`, { headers: { accept: 'text/event-stream' } }, (res) => {
      res.resume();
      const ended = new Promise<void>((done) => {
        res.on('end', done);
        res.on('close', done);
      });
      resolve({ res, ended });
    });
    req.on('error', reject);
    req.end();
  });
}

test('close hangs up on the window instead of waiting for it', async () => {
  const b = await boot();
  const stream = await openStream(b.url);
  const started = Date.now();
  const closed = new Promise<void>((resolve) => b.server.close(() => resolve()));
  const finished = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000).unref()),
  ]);
  const took = Date.now() - started;
  if (!finished) stream.res.destroy();
  await closed;
  assert.ok(finished, `close waited on the open event stream: still open after ${took}ms`);
  await stream.ended;
  assert.ok(took < 1_000, `close took ${took}ms with a window attached`);
});
