// The terms of use: accepted once per version, recorded beside the vault prefs, gated by the
// window token.
//
// The store is read fresh on every get, so a file another process edits shows at once, and a
// version bump on the site brings the screen back exactly once. The route is a custody write:
// no window token, no acceptance, and the knock is logged like any other.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createTerms, TERMS_VERSION } from '../../src/terms.ts';
import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { createKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import type { AppConfig, LedgerSnapshot } from '../../src/types.ts';
import { stubView } from '../fixtures/view.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-terms-'));
}

test('nothing is accepted on a fresh data directory, and the payload names the version and the pages', () => {
  const terms = createTerms(tmp(), '2026-09-17');
  const data = terms.get();
  assert.equal(data.accepted, false);
  assert.equal(data.acceptedVersion, null);
  assert.equal(data.acceptedAt, null);
  assert.equal(data.version, '2026-09-17');
  assert.equal(data.urls.terms, 'https://phosphor.karimbabasf.com/terms/');
  assert.equal(data.urls.privacy, 'https://phosphor.karimbabasf.com/privacy/');
});

test('accepting writes terms.json at 0600 with the version and the moment, and a fresh reader agrees', () => {
  const dir = tmp();
  const terms = createTerms(dir, '2026-09-17');
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  const data = terms.accept(() => now);
  assert.equal(data.accepted, true);
  assert.equal(data.acceptedVersion, '2026-09-17');
  assert.equal(data.acceptedAt, '2026-09-18T12:00:00.000Z');
  const file = path.join(dir, 'terms.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { acceptedVersion: '2026-09-17', acceptedAt: '2026-09-18T12:00:00.000Z' });
  assert.equal(createTerms(dir, '2026-09-17').get().accepted, true);
});

test('a newer version of the terms is not accepted until it is, and the old acceptance stays on record', () => {
  const dir = tmp();
  createTerms(dir, '2026-09-17').accept();
  const newer = createTerms(dir, '2027-01-01');
  assert.equal(newer.get().accepted, false);
  assert.equal(newer.get().acceptedVersion, '2026-09-17', 'the version that was accepted is still named');
  newer.accept();
  assert.equal(newer.get().accepted, true);
  assert.equal(newer.get().acceptedVersion, '2027-01-01');
});

test('a file that is not ours reads as nothing accepted rather than throwing', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'terms.json'), 'not json');
  assert.equal(createTerms(dir).get().accepted, false);
  fs.writeFileSync(path.join(dir, 'terms.json'), JSON.stringify({ acceptedVersion: 7, acceptedAt: true }));
  const data = createTerms(dir).get();
  assert.equal(data.accepted, false);
  assert.equal(data.acceptedVersion, null);
  assert.equal(data.version, TERMS_VERSION);
});

/* ---------- the route ---------- */

function snapshot(): LedgerSnapshot {
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices: {} };
}

async function boot() {
  const dataDir = tmp();
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'demo', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  const cfg: AppConfig = { mode: 'demo', port: 0, addresses: {}, candleProducts: ['BTC-USD'], dataDir, keysPath };
  const audit = createAudit(dataDir);
  const server = createServer({
    cfg,
    audit,
    store: createStore(dataDir),
    keystore,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => snapshot() },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
      proposeSend: async () => { throw new Error('unused'); },
      proposeTrade: async () => { throw new Error('unused'); },
      proposeTradeChange: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      view: (p) => stubView(p),
      markStalled: () => 0,
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: async () => { throw new Error('unused'); },
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
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
  const post = async (route: string, body: Record<string, unknown>) => {
    const res = await fetch(url + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const get = async (route: string) => (await (await fetch(url + route)).json()) as Record<string, any>;
  return { url, token, audit, dataDir, post, get, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('the state says the terms are not accepted, the route refuses without the window token, and accepts with it', async () => {
  const b = await boot();
  try {
    const before = await b.get('/api/state');
    assert.equal(before.terms.accepted, false);
    assert.equal(before.terms.version, TERMS_VERSION);

    const refused = await b.post('/api/terms/accept', {});
    assert.equal(refused.status, 403);
    assert.equal((await b.get('/api/state')).terms.accepted, false, 'a knock without the token accepted the terms');
    assert.ok(b.audit.tail(5).some((e) => e.type === 'approve_attempt_rejected' && String(e.msg).includes('/api/terms/accept')), 'the refused knock was not logged');

    const ok = await b.post('/api/terms/accept', { token: b.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.accepted, true);
    assert.equal(ok.json.acceptedVersion, TERMS_VERSION);

    const after = await b.get('/api/state');
    assert.equal(after.terms.accepted, true, 'the state cache served the old answer');
    assert.equal(typeof after.terms.acceptedAt, 'string');
    const line = b.audit.tail(5).find((e) => e.type === 'terms_accepted');
    assert.ok(line, 'no audit line for the acceptance');
    assert.equal((line.data as { version: string }).version, TERMS_VERSION);
    assert.equal(fs.existsSync(path.join(b.dataDir, 'terms.json')), true);
  } finally {
    await b.close();
  }
});
