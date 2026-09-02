// The lock frame, and the one path that used to skip it.
//
// src/http/sse.ts says why the frame exists: the window answers it with a whole screen, and a
// state frame arriving first repaints the wallet carrying the old lock chip. Every route that
// changes the lock sends it. An AUTOMATIC lock did not: main.ts wired the session's lock
// callback to broadcastState alone, so fifteen idle minutes or a machine waking from sleep shut
// the wallet and the window kept drawing it open until it happened to reconcile from a state
// payload it read for another reason.
//
// The frame follows the STATE now rather than the caller. Whatever closes the keystore, the
// keystore says so, and the server turns that into the frame.

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
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot, LpPosition } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const PASSWORD = 'a long enough password';

function snapshot(): LedgerSnapshot {
  const status: ChainStatus = { ok: true, fetchedAt: new Date().toISOString() };
  return {
    holdings: [],
    chainStatus: Object.fromEntries(CHAINS.map((c) => [c, status])) as Record<ChainId, ChainStatus>,
    mode: 'demo',
    prices: {},
    gas: Object.fromEntries(CHAINS.map((c) => [c, { transferCostUsd: 0.1 }])) as LedgerSnapshot['gas'],
  };
}

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-lockframe-'));
  process.env.PHOSPHOR_WINDOW_TOKEN = crypto.randomBytes(32).toString('hex');
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'demo', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath,
  };
  /* The session main.ts builds and shares with the runner, handed in so this server takes the
     same branch the real app does. That branch is where the missing frame lived. */
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
      positions: (): LpPosition[] => [],
      intents: () => undefined,
      refresh: async () => snapshot(),
      applyDemoTransfer: () => {},
    },
    candles: { get: async () => ({ candles: [], stale: false, source: 'test', fetchedAt: new Date().toISOString() }), spot: async () => 1 },
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
      proposeYieldDeposit: async () => { throw new Error('unused'); },
      proposeYieldWithdraw: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
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
      onUpdate: () => {},
      stop: () => {},
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, keystore, session, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// One SSE connection, with every frame it has seen so far.
function listen(url: string): { frames: Array<{ type: string; state?: string }>; stop: () => void } {
  const frames: Array<{ type: string; state?: string }> = [];
  const req = http.request(`${url}/api/events`, { headers: { accept: 'text/event-stream' } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          frames.push(JSON.parse(line.slice(6)) as { type: string });
        } catch {
          // a heartbeat comment, not a frame
        }
      }
    });
  });
  req.end();
  return { frames, stop: () => req.destroy() };
}

async function waitFor(done: () => boolean, why: string, capMs = 3000): Promise<void> {
  const until = Date.now() + capMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(why);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('an automatic lock sends the lock frame, not a state frame on its own', async () => {
  const b = await boot();
  const stream = listen(b.url);
  try {
    await b.keystore.create(PASSWORD);
    await waitFor(() => stream.frames.some((f) => f.type === 'lock' && f.state === 'unlocked'), 'no frame for the new wallet');
    const before = stream.frames.length;

    // What fifteen idle minutes and a machine waking from sleep both end in.
    b.keystore.lock();

    await waitFor(
      () => stream.frames.slice(before).some((f) => f.type === 'lock' && f.state === 'locked'),
      'the wallet shut and the window was never told',
    );
  } finally {
    stream.stop();
    await b.close();
  }
});

test('the lock frame reaches the window before the state frame that would repaint the old chip', async () => {
  const b = await boot();
  const stream = listen(b.url);
  try {
    await b.keystore.create(PASSWORD);
    await waitFor(() => stream.frames.some((f) => f.type === 'lock'), 'no frame at all');
    const before = stream.frames.length;

    b.keystore.lock();

    await waitFor(() => stream.frames.slice(before).some((f) => f.type === 'lock' && f.state === 'locked'), 'no lock frame');
    const after = stream.frames.slice(before);
    const lockAt = after.findIndex((f) => f.type === 'lock' && f.state === 'locked');
    const stateAt = after.findIndex((f) => f.type === 'state');
    assert.ok(lockAt >= 0);
    assert.ok(stateAt === -1 || lockAt < stateAt, 'the whole-screen answer arrives first');
  } finally {
    stream.stop();
    await b.close();
  }
});
