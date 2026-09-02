// The custody surface over real HTTP: unlock, lock, the four wallet verbs, the reveal
// handshake, receive, and the agent door that opens onto none of them.
//
// Driven against a real server on a loopback port with a temp data directory and a temp
// keysPath. Nothing here reads or writes ~/.phosphor.

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
import { defaultParams } from '../../src/keystore/kdf.ts';
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot, LpPosition } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
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

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

type Booted = {
  url: string;
  token: string;
  keystore: ReturnType<typeof createKeystore>;
  keysPath: string;
  post: (route: string, body: unknown, opts?: { origin?: string; contentType?: string }) => Promise<{ status: number; json: any }>;
  get: (route: string, opts?: { origin?: string }) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
};

async function boot(): Promise<Booted> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-wallet-'));
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, kdf: fast });
  const cfg: AppConfig = {
    mode: 'demo',
    port: 0,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath,
  };
  const server = createServer({
    cfg,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    keystore,
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
      releaseQueued: async () => 2,
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

  async function post(route: string, body: unknown, opts: { origin?: string; contentType?: string } = {}) {
    const res = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'content-type': opts.contentType ?? 'application/json', origin: opts.origin ?? url },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  async function get(route: string, opts: { origin?: string } = {}) {
    const res = await fetch(`${url}${route}`, { headers: { origin: opts.origin ?? url } });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  return { url, token, keystore, keysPath, post, get, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ---------- the guard ----------

test('every custody route needs the window token and a matching Origin', async () => {
  const b = await boot();
  try {
    const routes = ['/api/unlock', '/api/lock', '/api/activity', '/api/wallet/create', '/api/wallet/import', '/api/wallet/migrate', '/api/wallet/reveal', '/api/wallet/export'];
    for (const route of routes) {
      const noToken = await b.post(route, { password: PASSWORD });
      assert.equal(noToken.status, 403, `${route} without a token`);
      const foreign = await b.post(route, { token: b.token, password: PASSWORD }, { origin: 'http://evil.com' });
      assert.equal(foreign.status, 403, `${route} from a foreign origin`);
      const plain = await b.post(route, '{}', { contentType: 'text/plain' });
      assert.equal(plain.status, 415, `${route} as text/plain`);
    }
    // And nothing was created by all that knocking.
    assert.equal(b.keystore.state(), 'no_wallet');
  } finally {
    await b.close();
  }
});

// ---------- create, lock, unlock ----------

test('creating a wallet returns the words once and leaves it unlocked', async () => {
  const b = await boot();
  try {
    const made = await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    assert.equal(made.status, 200);
    assert.equal(made.json.mnemonic.length, 12);
    assert.match(made.json.addresses.evm, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(b.keystore.state(), 'unlocked');

    // The words are not in the state payload, the log, or anything else this app serves.
    const state = await b.get('/api/state');
    assert.equal(state.json.lock.state, 'unlocked');
    assert.ok(typeof state.json.lock.idleLocksInSec === 'number');
    const phrase = made.json.mnemonic.join(' ');
    const body = JSON.stringify(state.json);
    assert.ok(!body.includes(phrase), 'the phrase reached the state payload');
    assert.equal(state.json.lock.mnemonic, undefined);
    assert.ok(!/"(privateKey|secretKey|mnemonic|password)"/.test(body), 'the state payload names key material');
    const log = await b.get('/api/log?limit=200');
    const logBody = JSON.stringify(log.json);
    assert.ok(!logBody.includes(phrase), 'the phrase reached the audit log');
    assert.ok(!/"(privateKey|secretKey|mnemonic|password)"/.test(logBody), 'the audit log names key material');

    // A short password is refused before anything is written.
    const second = await b.post('/api/wallet/create', { token: b.token, password: 'short' });
    assert.equal(second.status, 400);
  } finally {
    await b.close();
  }
});

test('lock and unlock move the state, and a wrong password does not', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    const locked = await b.post('/api/lock', { token: b.token });
    assert.equal(locked.status, 200);
    assert.equal((await b.get('/api/state')).json.lock.state, 'locked');
    assert.equal((await b.get('/api/state')).json.lock.idleLocksInSec, null);

    const wrong = await b.post('/api/unlock', { token: b.token, password: 'not the password' });
    assert.equal(wrong.status, 200);
    assert.deepEqual(wrong.json, { ok: false, error: 'wrong_password' });
    assert.equal(b.keystore.state(), 'locked');

    const right = await b.post('/api/unlock', { token: b.token, password: PASSWORD });
    assert.equal(right.json.ok, true);
    assert.equal(right.json.released, 2, 'unlocking re-decides what was queued while it was shut');
    assert.equal(b.keystore.state(), 'unlocked');
  } finally {
    await b.close();
  }
});

test('five wrong passwords over the route start the backoff', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    await b.post('/api/lock', { token: b.token });
    for (let i = 0; i < 5; i += 1) {
      const out = await b.post('/api/unlock', { token: b.token, password: 'wrong' });
      assert.equal(out.json.error, 'wrong_password', `attempt ${i + 1}`);
    }
    const out = await b.post('/api/unlock', { token: b.token, password: PASSWORD });
    assert.equal(out.json.error, 'locked_out');
    assert.ok(out.json.retryInSec > 0);
  } finally {
    await b.close();
  }
});

// ---------- import, receive, migrate ----------

test('import takes twelve words, refuses a bad phrase, and lands the known addresses', async () => {
  const b = await boot();
  try {
    const bad = await b.post('/api/wallet/import', { token: b.token, password: PASSWORD, mnemonic: 'abandon abandon' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /twelve words/);

    const out = await b.post('/api/wallet/import', { token: b.token, password: PASSWORD, mnemonic: VECTOR });
    assert.equal(out.status, 200);
    assert.equal(out.json.addresses.evm, VECTOR_EVM);
  } finally {
    await b.close();
  }
});

test('receive answers while locked, with a warning per chain and no key anywhere', async () => {
  const b = await boot();
  try {
    const empty = await b.get('/api/receive');
    assert.deepEqual(empty.json.chains, [], 'no wallet means no addresses to show');

    await b.post('/api/wallet/import', { token: b.token, password: PASSWORD, mnemonic: VECTOR });
    await b.post('/api/lock', { token: b.token });

    const out = await b.get('/api/receive');
    assert.equal(out.json.state, 'locked');
    const ids = out.json.chains.map((c: { id: string }) => c.id);
    assert.deepEqual(ids, ['eth', 'base', 'arb', 'sol', 'near']);
    for (const chain of out.json.chains) {
      assert.ok(typeof chain.address === 'string' && chain.address.length > 0);
      assert.ok(chain.warning.length > 0, 'every chain says what it does not accept');
    }
    assert.equal(out.json.chains[0].address, VECTOR_EVM);
  } finally {
    await b.close();
  }
});

test('migrate encrypts a plaintext file, destroys it, and says the state changed', async () => {
  const b = await boot();
  try {
    const { walletFromMnemonic } = await import('../../src/keystore/derive.ts');
    const wallet = walletFromMnemonic(VECTOR);
    fs.mkdirSync(path.dirname(b.keysPath), { recursive: true });
    fs.writeFileSync(
      b.keysPath,
      JSON.stringify({ evm: { address: wallet.addresses.evm, privateKey: wallet.keys.evm } }),
      { mode: 0o600 },
    );
    assert.equal((await b.get('/api/state')).json.lock.state, 'needs_migration');

    const out = await b.post('/api/wallet/migrate', { token: b.token, password: PASSWORD });
    assert.equal(out.status, 200);
    assert.equal(out.json.destroyed.length, 1);
    assert.match(out.json.note, /snapshot/i, 'the honest caveat travels with the answer');
    assert.ok(!fs.existsSync(b.keysPath));
    assert.equal((await b.get('/api/state')).json.lock.state, 'unlocked');
  } finally {
    await b.close();
  }
});

// ---------- reveal and export ----------

test('reveal is a two step handshake whose nonce works exactly once', async () => {
  const b = await boot();
  try {
    const made = await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });

    const wrong = await b.post('/api/wallet/reveal', { token: b.token, password: 'not it', what: 'mnemonic' });
    assert.equal(wrong.json.ok, false, 'the password is asked for again, even though the wallet is open');

    const start = await b.post('/api/wallet/reveal', { token: b.token, password: PASSWORD, what: 'mnemonic' });
    assert.equal(start.json.ok, true);
    assert.equal(start.json.nonce.length, 64);
    assert.equal(start.json.mnemonic, undefined, 'the first request carries no material');

    const first = await b.get(`/api/wallet/reveal/${start.json.nonce}`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.mnemonic, made.json.mnemonic);

    const second = await b.get(`/api/wallet/reveal/${start.json.nonce}`);
    assert.equal(second.status, 404, 'the nonce is spent');

    // And an unissued nonce is refused, so guessing is the only attack and it is 32 bytes wide.
    const guess = await b.get(`/api/wallet/reveal/${'0'.repeat(64)}`);
    assert.equal(guess.status, 404);
  } finally {
    await b.close();
  }
});

test('a reveal nonce cannot be spent from another origin', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    const start = await b.post('/api/wallet/reveal', { token: b.token, password: PASSWORD, what: 'keys' });
    const stolen = await b.get(`/api/wallet/reveal/${start.json.nonce}`, { origin: 'http://evil.com' });
    assert.equal(stolen.status, 403);
  } finally {
    await b.close();
  }
});

test('revealing the private keys hands back all three and nothing else', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/import', { token: b.token, password: PASSWORD, mnemonic: VECTOR });
    const start = await b.post('/api/wallet/reveal', { token: b.token, password: PASSWORD, what: 'keys' });
    const out = await b.get(`/api/wallet/reveal/${start.json.nonce}`);
    assert.match(out.json.keys.evm, /^0x[0-9a-f]{64}$/);
    assert.ok(out.json.keys.solana.length > 0);
    assert.match(out.json.keys.near, /^ed25519:/);
    assert.equal(out.json.keys.password, undefined);
  } finally {
    await b.close();
  }
});

test('export writes a keystore at an absolute path and refuses a relative one', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/import', { token: b.token, password: PASSWORD, mnemonic: VECTOR });
    const relative = await b.post('/api/wallet/export', { token: b.token, password: PASSWORD, path: 'backup.json' });
    assert.equal(relative.status, 400);

    const target = path.join(os.tmpdir(), `phosphor-backup-${crypto.randomBytes(6).toString('hex')}.json`);
    const out = await b.post('/api/wallet/export', { token: b.token, password: PASSWORD, path: target });
    assert.equal(out.json.ok, true);
    const written = JSON.parse(fs.readFileSync(target, 'utf8')) as { header: { addresses: { evm: string } } };
    assert.equal(written.header.addresses.evm, VECTOR_EVM);
    assert.ok(!fs.readFileSync(target, 'utf8').includes(VECTOR), 'the backup is encrypted');
    fs.rmSync(target);
  } finally {
    await b.close();
  }
});

// ---------- the agent's door ----------

test('no op on the agent door unlocks, locks, creates or reveals anything', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    await b.post('/api/lock', { token: b.token });

    for (const op of ['unlock', 'lock', 'wallet_create', 'wallet_import', 'wallet_reveal', 'wallet_export', 'migrate']) {
      const out = await b.post('/api/mcp', { op, password: PASSWORD, token: b.token, session: 's', client: 'test' });
      assert.equal(out.status, 400, `op ${op} must not exist`);
      assert.match(String(out.json.error), /unknown op/);
    }
    assert.equal(b.keystore.state(), 'locked', 'the agent could not reach the lock');

    // And a read tool by that name is not there either.
    const read = await b.post('/api/mcp', { op: 'read', tool: 'reveal', session: 's', client: 'test' });
    assert.equal(read.status, 400);
    assert.match(String(read.json.error), /unknown read tool/);
  } finally {
    await b.close();
  }
});

// ---------- the beacon ----------

test('the beacon moves the lock countdown and an agent call does not', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    const opening = (await b.get('/api/state')).json.lock.idleLocksInSec as number;
    assert.ok(opening > 0);

    // Twenty agent reads, back to back. Every one is audited, every one answers, and the
    // countdown must be no further away afterwards than it was before.
    for (let i = 0; i < 20; i += 1) {
      const out = await b.post('/api/mcp', { op: 'read', tool: 'balances', session: 'agent-1', client: 'test' });
      assert.equal(out.status, 200, 'the agent can still work while this is being asserted');
    }
    const afterAgent = (await b.get('/api/state')).json.lock.idleLocksInSec as number;
    assert.ok(afterAgent <= opening, 'agent traffic must never push the lock out');

    // The window says a person is here.
    const beacon = await b.post('/api/activity', { token: b.token });
    assert.equal(beacon.status, 200);
    assert.ok(beacon.json.idleLocksInSec >= afterAgent, 'the beacon is the one thing that resets it');
  } finally {
    await b.close();
  }
});
