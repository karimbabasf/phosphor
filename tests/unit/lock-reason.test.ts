// Why the wallet locked, on the lock slice of /api/state, for the lock screen's line.
//
// The slice carries a fixed code (screen, switch, idle, sleep) and a count of the moves waiting
// for the person, and nothing else new: never the text a caller sent, never what the moves are.
// An unknown reason gives no code, a lock the person asked for gives none, and an unlock clears
// it. Driven through the real server, router and keystore.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { createKeystore } from '../../src/keystore/index.ts';
import { createSession } from '../../src/keystore/session.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { lockCodeOf, lockReasonFor } from '../../src/keystore/lock-reason.ts';
import type { AppConfig, LedgerSnapshot, Proposal, ProposalStatus } from '../../src/types.ts';
import { stubView } from '../fixtures/view.ts';

const PASSWORD = 'a long enough password';
const SNAPSHOT: LedgerSnapshot = { mode: 'demo', fetchedAt: new Date().toISOString(), prices: {} };
const read = (p: string): string => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const row = (id: string, status: ProposalStatus): Proposal =>
  ({
    id,
    kind: 'swap',
    status,
    createdAt: '2026-10-01T10:00:00Z',
    draft: { kind: 'swap', chain: 'base', fromSymbol: 'USDC', toSymbol: 'WETH', amountUsd: 150, venue: 'oneclick' },
    simulation: { ok: true, summary: 'swap 150 USDC for WETH', destinations: [] },
    verdict: { outcome: 'needs_approval', reasons: ['It is above the $100 you said to ask about.'] },
  }) as unknown as Proposal;

async function boot(rows: Proposal[] = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-lockreason-'));
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  fs.writeFileSync(path.join(dataDir, 'proposals.json'), JSON.stringify(rows));
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'demo', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  const store = createStore(dataDir);
  const cfg: AppConfig = { mode: 'demo', port: 0, addresses: {}, candleProducts: ['BTC-USD'], dataDir, keysPath };
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const server = createServer({
    cfg,
    audit: createAudit(dataDir),
    store,
    keystore,
    session: createSession({ isUnlocked: () => keystore.isUnlocked(), lock: () => keystore.lock() }),
    riskRows: [],
    ledger: { snapshot: () => SNAPSHOT, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => SNAPSHOT },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposePolicyChange: unused,
      proposeSwap: unused,
      proposeHlDeposit: unused,
      proposeHlWithdraw: unused,
      proposeSend: unused,
      proposeTrade: unused,
      proposeTradeChange: unused,
      approve: unused,
      refuse: unused,
      get: (id: string) => store.get(id),
      list: () => store.list(),
      view: (p) => stubView(p),
      markStalled: () => 0,
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: unused,
      reconcile: unused,
      acknowledge: unused,
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
  await keystore.create(PASSWORD);
  const post = async (route: string, body: Record<string, unknown>) => {
    const res = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ token, ...body }),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const state = async (): Promise<{ text: string; lock: Record<string, unknown> }> => {
    const text = await (await fetch(`${url}/api/state`)).text();
    return { text, lock: (JSON.parse(text) as { lock: Record<string, unknown> }).lock };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { keystore, post, state, close };
}

const WAITING_ROWS = [row('p-1', 'pending'), row('p-2', 'executed'), row('p-3', 'pending_unlock'), row('p-4', 'refused')];

test('a screen lock puts its code and the count of waiting moves on the lock slice', async () => {
  const b = await boot(WAITING_ROWS);
  try {
    assert.equal((await b.post('/api/lock', { reason: 'the screen locked', whenIdle: true })).ok, true);
    const { lock } = await b.state();
    assert.equal(lock.state, 'locked');
    assert.equal(lock.reason, 'screen');
    assert.equal(lock.waiting, 2, 'pending and pending_unlock wait for the person; executed and refused do not');
  } finally {
    await b.close();
  }
});

test('a switch to another user has its own code', async () => {
  const b = await boot();
  try {
    await b.post('/api/lock', { reason: 'this Mac switched to another user', whenIdle: true });
    const { lock } = await b.state();
    assert.equal(lock.reason, 'switch');
    assert.equal(lock.waiting, 0);
  } finally {
    await b.close();
  }
});

test('an unknown reason gives no code, and its text never reaches the state', async () => {
  const b = await boot();
  try {
    const raw = 'the screen locked <img src=x> because a stranger said so';
    await b.post('/api/lock', { reason: raw, whenIdle: true });
    const { text, lock } = await b.state();
    assert.equal(lock.state, 'locked');
    assert.equal(lock.reason, null);
    assert.equal(text.includes('stranger said so'), false, 'the request text was echoed into /api/state');
    assert.equal(text.includes('<img'), false);
  } finally {
    await b.close();
  }
});

test('Lock now, quitting and the window closing give no code', async () => {
  for (const reason of [undefined, 'quitting', 'the control window was closed', 'installing an update']) {
    const b = await boot();
    try {
      await b.post('/api/lock', reason === undefined ? {} : { reason, whenIdle: true });
      const { lock } = await b.state();
      assert.equal(lock.state, 'locked');
      assert.equal(lock.reason, null, String(reason));
    } finally {
      await b.close();
    }
  }
});

test('an unlock clears the code, and the next lock does not inherit it', async () => {
  const b = await boot();
  try {
    await b.post('/api/lock', { reason: 'the screen locked', whenIdle: true });
    assert.equal((await b.state()).lock.reason, 'screen');
    assert.equal((await b.post('/api/unlock', { password: PASSWORD })).ok, true);
    const open = (await b.state()).lock;
    assert.equal(open.state, 'unlocked');
    assert.equal(open.reason, null);
    // A lock that does not pass through a route that notes a code (a vault step, say).
    b.keystore.lock();
    assert.equal((await b.state()).lock.reason, null, 'a stale code came back');
  } finally {
    await b.close();
  }
});

test('a second lock request while locked keeps the first reason', async () => {
  const b = await boot();
  try {
    await b.post('/api/lock', { reason: 'the screen locked', whenIdle: true });
    await b.post('/api/lock', { reason: 'this Mac switched to another user', whenIdle: true });
    assert.equal((await b.state()).lock.reason, 'screen');
  } finally {
    await b.close();
  }
});

test('the idle clock and a sleep note their own codes, in both places the clock is built', async () => {
  const b = await boot();
  try {
    if (b.keystore.lock()) lockReasonFor(b.keystore).note('idle');
    assert.equal((await b.state()).lock.reason, 'idle');
  } finally {
    await b.close();
  }
  for (const file of ['../../src/main.ts', '../../src/server.ts']) {
    assert.match(read(file), /lock: \(reason\) => \{\s*if \(keystore\.lock\(\)\) lockReasonFor\(keystore\)\.note\(reason\);/, file);
  }
});

test('only the shell sentences map to codes', () => {
  assert.equal(lockCodeOf('the screen locked'), 'screen');
  assert.equal(lockCodeOf('this Mac switched to another user'), 'switch');
  assert.equal(lockCodeOf('The screen locked'), null);
  assert.equal(lockCodeOf('idle'), null, 'a caller cannot claim the idle clock locked it');
  assert.equal(lockCodeOf(7), null);
  assert.equal(lockCodeOf(undefined), null);
  // The sentences the shell really sends (src-tauri/src/session_watch.rs).
  const shell = read('../../src-tauri/src/session_watch.rs');
  assert.ok(shell.includes('SCREEN => "the screen locked"'));
  assert.ok(shell.includes('SESSION => "this Mac switched to another user"'));
});
