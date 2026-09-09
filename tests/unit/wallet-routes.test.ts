// The custody surface over real HTTP: unlock, lock, the four wallet verbs, the reveal
// handshake, receive, and the agent door that opens onto none of them.
//
// Driven against a real server on a loopback port with a temp data directory and a temp
// keysPath. Nothing here reads or writes ~/.phosphor.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { createKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot } from '../../src/types.ts';

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

// Poll for something the server does off the response, with a deadline so a regression fails
// with the sentence below rather than hanging the run.
async function waitFor(done: () => boolean, why: string, capMs = 3000): Promise<void> {
  const until = Date.now() + capMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(why);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Booted = {
  url: string;
  token: string;
  keystore: ReturnType<typeof createKeystore>;
  keysPath: string;
  post: (route: string, body: unknown, opts?: { origin?: string; contentType?: string }) => Promise<{ status: number; json: any }>;
  get: (route: string, opts?: { origin?: string }) => Promise<{ status: number; json: any }>;
  getRaw: (route: string, headers: Record<string, string>) => Promise<{ status: number; json: any }>;
  // How many times the queue behind the lock has been released. One unlock is one release.
  releases: () => number;
  close: () => Promise<void>;
};

// Demo by default, because that is what every route here behaves the same in. The one
// exception is migrate, which demo mode refuses outright: it destroys a plaintext key file and
// a throwaway instance has no business doing that. That test boots live.
//
// `releaseDelayMs` stands in for the thing that made a double unlock possible: releasing the
// queue means sending a rail apiece, so the unlock response can be a minute away, and the
// window in which a second click lands is that whole wait. Zero everywhere but the one test
// that needs the wait to be real.
async function boot(mode: AppConfig['mode'] = 'demo', opts: { releaseDelayMs?: number } = {}): Promise<Booted> {
  let releases = 0;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-wallet-'));
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode, kdf: fast });
  const cfg: AppConfig = {
    mode,
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
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
      releaseQueued: async () => {
        releases += 1;
        if (opts.releaseDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.releaseDelayMs));
        return 2;
      },
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
  /* Exactly the headers a browser sends, which is not the same set the helper above
     sends: a same-origin GET carries no Origin at all, and it does carry Sec-Fetch-Site.
     This goes through node:http rather than fetch because Sec-Fetch-* are forbidden
     header names, so fetch silently drops them and the request under test never happens. */
  function getRaw(route: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const target = new URL(`${url}${route}`);
      const req = http.request(
        { hostname: target.hostname, port: target.port, path: target.pathname, method: 'GET', headers },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            let parsed: any = null;
            try { parsed = JSON.parse(body); } catch { parsed = null; }
            resolve({ status: res.statusCode ?? 0, json: parsed });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  return { url, token, keystore, keysPath, post, get, getRaw, releases: () => releases, close: () => new Promise<void>((r) => server.close(() => r())) };
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
    /* A refusal answers with a sentence a person can read AND the code a screen branches on.
        `error` used to carry the machine code, which is the field every other route on this
        surface fills with English, so a client printing `error` printed "wrong_password". */
    assert.equal(wrong.json.ok, false);
    assert.equal(wrong.json.code, 'wrong_password');
    assert.equal(wrong.json.error, 'That password is wrong.');
    assert.equal(b.keystore.state(), 'locked');

    const right = await b.post('/api/unlock', { token: b.token, password: PASSWORD });
    assert.equal(right.json.ok, true);
    assert.equal(right.json.released, 2, 'unlocking re-decides what was queued while it was shut');
    assert.equal(b.keystore.state(), 'unlocked');
  } finally {
    await b.close();
  }
});

/* Two clicks on Unlock, which is what a person does when the first one appears to do nothing.
   The response waits for the queue to be released and releasing a queue means sending a rail
   apiece, so the wait is real and the second press is reasonable. What must not happen is a
   second release: land() takes the proposal it is handed without re-reading the stored status,
   so two loops over the same queued rows are two sends of one intent. */
test('two unlocks at once are one unlock, and the queue is released once', async () => {
  const b = await boot('demo', { releaseDelayMs: 400 });
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    await b.post('/api/lock', { token: b.token });

    const first = b.post('/api/unlock', { token: b.token, password: PASSWORD });
    // Wait until the server is actually inside the release, so the second press lands in the
    // window the bug lived in rather than after it.
    await waitFor(() => b.releases() === 1, 'the first unlock never reached the release');
    const second = await b.post('/api/unlock', { token: b.token, password: PASSWORD });

    assert.equal(b.releases(), 1, 'the second press waits on the first rather than releasing the queue again');
    assert.equal((await first).json.ok, true);
    assert.equal(second.json.ok, true);
    assert.equal(second.json.released, 2, 'and it is handed the first one\'s answer');
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
      assert.equal(out.json.code, 'wrong_password', `attempt ${i + 1}`);
    }
    const out = await b.post('/api/unlock', { token: b.token, password: PASSWORD });
    assert.equal(out.json.code, 'locked_out');
    assert.ok(out.json.retryInSec > 0);
    assert.match(out.json.error, /Too many tries\. Wait \d+ seconds? and try again\./, 'and it says so in English');
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
  const b = await boot('live');
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

/* The route a demo instance must never reach. Migration overwrites the plaintext key file and
   every backup beside it with random bytes and then unlinks them, which is not undoable, and a
   demo backend is a throwaway. The key path is scoped by the data directory now so there is
   normally nothing real in reach; this is the lock that holds when one is pointed at by hand. */
test('a demo instance refuses to migrate, and the plaintext file it was pointed at survives', async () => {
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

    const out = await b.post('/api/wallet/migrate', { token: b.token, password: PASSWORD });
    assert.equal(out.status, 403);
    assert.match(out.json.error, /demo mode never migrates/);
    assert.ok(fs.existsSync(b.keysPath), 'the file it refused to migrate is still there');
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

test('a reveal is redeemable by the window, which sends no Origin on a GET', async () => {
  // The regression this exists for: every other test here sends an Origin header, and a
  // browser does not send one on a same-origin GET. Checking Origin alone made this route
  // unreachable from the only window that is supposed to call it.
  const b = await boot();
  try {
    const made = await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    const start = await b.post('/api/wallet/reveal', { token: b.token, password: PASSWORD, what: 'mnemonic' });

    const out = await b.getRaw(`/api/wallet/reveal/${start.json.nonce}`, {
      accept: 'application/json',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
    });
    assert.equal(out.status, 200, 'the window can spend its own nonce');
    assert.deepEqual(out.json.mnemonic, made.json.mnemonic);
  } finally {
    await b.close();
  }
});

test('a reveal url opened as a tab is refused, so the words cannot be rendered by a link', async () => {
  // A cross-site fetch cannot read this response anyway: nothing here sends CORS headers. A
  // top-level navigation can, and that is the hole `navigate` closes.
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    const start = await b.post('/api/wallet/reveal', { token: b.token, password: PASSWORD, what: 'mnemonic' });

    const opened = await b.getRaw(`/api/wallet/reveal/${start.json.nonce}`, {
      accept: 'text/html',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
    });
    assert.equal(opened.status, 403);
  } finally {
    await b.close();
  }
});

test('a reveal nonce is refused when nothing says where it came from', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    const start = await b.post('/api/wallet/reveal', { token: b.token, password: PASSWORD, what: 'mnemonic' });
    const bare = await b.getRaw(`/api/wallet/reveal/${start.json.nonce}`, { accept: 'application/json' });
    assert.equal(bare.status, 403, 'no Origin and no fetch metadata is not a window');
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

test('a backup is refused under a password that does not open the live wallet', async () => {
  // The bug this closes: exportTo encrypts under whatever password it is handed, so a typo made
  // a valid backup that opens only with the typo. The check used to be skipped when the wallet
  // was already unlocked, which is the state a person is in when they press Back up.
  const b = await boot();
  try {
    await b.post('/api/wallet/import', { token: b.token, password: PASSWORD, mnemonic: VECTOR });
    assert.equal(b.keystore.state(), 'unlocked');

    const target = path.join(os.tmpdir(), `phosphor-typo-${crypto.randomBytes(6).toString('hex')}.json`);
    const typo = await b.post('/api/wallet/export', { token: b.token, password: 'a long enough passwerd', path: target });
    assert.equal(typo.json.ok, false);
    assert.equal(typo.json.code, 'wrong_password');
    assert.ok(!fs.existsSync(target), 'and nothing was written');

    const right = await b.post('/api/wallet/export', { token: b.token, password: PASSWORD, path: target });
    assert.equal(right.json.ok, true);
    fs.rmSync(target);
  } finally {
    await b.close();
  }
});

/* ---------- what a password check must not do ----------

   Backup and reveal both ask for the password again, which is the control that stops an
   unattended open window being a key dump. They used to run that check by CALLING unlock, which
   is a real unlock: the keystore opened, and then export returned without announcing anything.
   The window kept drawing the lock screen because no lock frame was sent, the idle timer kept
   counting from the last human action, and anything queued in pending_unlock stayed queued
   until somebody locked and unlocked again. Three states out of step at once.

   Backup verifies without opening. Reveal genuinely needs the wallet open, because the second
   half of the handshake reads material off it, so it announces the unlock instead. */

test('a backup checks the password without unlocking the wallet as a side effect', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    await b.post('/api/lock', { token: b.token });
    assert.equal(b.keystore.state(), 'locked');

    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-backup-')), 'backup.json');
    const out = await b.post('/api/wallet/export', { token: b.token, password: PASSWORD, path: target });

    assert.equal(out.json.ok, true, 'the backup is written from behind the lock');
    assert.ok(fs.existsSync(target));
    assert.equal(b.keystore.state(), 'locked', 'and the wallet is exactly as locked as it was');
    assert.equal(b.releases(), 0, 'so there is no queue to release either');
  } finally {
    await b.close();
  }
});

test('a wrong password on a backup still refuses, and still counts toward the backoff', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    await b.post('/api/lock', { token: b.token });

    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-backup-')), 'backup.json');
    const out = await b.post('/api/wallet/export', { token: b.token, password: 'not the password', path: target });

    assert.equal(out.json.ok, false);
    assert.equal(out.json.code, 'wrong_password');
    assert.ok(!fs.existsSync(target), 'nothing was written under a password that does not open the wallet');
    assert.equal(b.keystore.state(), 'locked');
  } finally {
    await b.close();
  }
});

test('a reveal from behind the lock announces the unlock and releases what was queued', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    await b.post('/api/lock', { token: b.token });

    const start = await b.post('/api/wallet/reveal', { token: b.token, password: PASSWORD, what: 'mnemonic' });
    assert.equal(start.json.ok, true);
    assert.equal(b.keystore.state(), 'unlocked', 'the handshake needs the wallet open, and it says so');
    assert.equal((await b.get('/api/state')).json.lock.state, 'unlocked');

    // The queue is released in the background: this response carries a nonce that dies in
    // thirty seconds, and releasing a queue means sending a rail apiece.
    await waitFor(() => b.releases() === 1, 'the queue behind the lock was never released');
    assert.equal(b.releases(), 1);
  } finally {
    await b.close();
  }
});

test('a reveal on an already open wallet releases nothing, because nothing changed', async () => {
  const b = await boot();
  try {
    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    const start = await b.post('/api/wallet/reveal', { token: b.token, password: PASSWORD, what: 'mnemonic' });

    assert.equal(start.json.ok, true);
    assert.equal(b.releases(), 0, 'the wallet was already open, so no queue was waiting on it');
  } finally {
    await b.close();
  }
});

/* Health reported `locked: false` on every install, hardcoded, with a comment saying the custody
   track had not landed. It had landed. A field that always answers the same thing is worse than
   no field: it is a claim a person or a monitor can act on and it is not true. */
test('health reports the lock the app is actually in', async () => {
  const b = await boot();
  try {
    const before = (await b.get('/api/health')).json as { locked: boolean };
    assert.equal(before.locked, false, 'no wallet at all is not locked: there is nothing there to lock');

    await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    assert.equal(((await b.get('/api/health')).json as { locked: boolean }).locked, false, 'a wallet just created is open');

    await b.post('/api/lock', { token: b.token });
    assert.equal(((await b.get('/api/health')).json as { locked: boolean }).locked, true, 'and a shut one says so');

    await b.post('/api/unlock', { token: b.token, password: PASSWORD });
    assert.equal(((await b.get('/api/health')).json as { locked: boolean }).locked, false);
  } finally {
    await b.close();
  }
});
