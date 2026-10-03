// The bind, and every custody step that writes a key file (src/http/custody.ts), run through the
// real routes, relay and keystore against the vault service's own rules with a stand-in keychain
// and enclave (tests/unit/helpers/vault-double.ts). No Touch ID: the stand-in records every call,
// so "before any touch" is a count of its agree calls. The last test kills real backends at each
// step of a bind and starts them again on the same files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import type { Store } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { stagedPathFor } from '../../src/keystore/store.ts';
import type { EnclaveUnwrapRequest, Keystore } from '../../src/keystore/store.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { BIND_REASON, CREATE_REASON, MIGRATE_REASON, RESTORE_REASON, UNLOCK_REASON } from '../../src/vault/reason.ts';
import { refusal } from '../../src/http/wallet.ts';
import { identityProof } from '../../src/http/respond.ts';
import type { AppConfig, LedgerSnapshot, Proposal } from '../../src/types.ts';
import { stubView } from '../fixtures/view.ts';
import { tempDir } from './helpers/tmp.ts';
import { relayTo, swiftc, T0, TEAM, VaultDouble } from './helpers/vault-double.ts';
import type { Answer, Hook, Request } from './helpers/vault-double.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = swiftc ? false : 'needs macOS with swiftc';

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

function snapshot(): LedgerSnapshot {
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices: {} };
}

const MATERIAL = ['keyBlob', 'ephemeralPublicKey', 'ciphertext', 'aad', 'addresses'] as const;
const material = (r: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(MATERIAL.map((k) => [k, r[k]]));

type Booted = Awaited<ReturnType<typeof boot>>;

async function boot(opts: { double?: VaultDouble; mode?: AppConfig['mode']; dataDir?: string; hook?: (r: Request) => Hook | Promise<Hook> } = {}) {
  const dataDir = opts.dataDir ?? tempDir('phosphor-bind-');
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: opts.mode ?? 'live', kdf: fast });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const relaySecret = crypto.randomBytes(32).toString('hex');
  const vault = createVaultRelay({ transportKey: transport, secret: relaySecret });
  const cfg: AppConfig = { mode: opts.mode ?? 'live', port: 0, addresses: {}, candleProducts: ['BTC-USD'], dataDir, keysPath };
  const audit = createAudit(dataDir);
  const real = createStore(dataDir);
  const touchWaiting = { on: false };
  // The bind reads the proposal list for a row whose Touch ID is still open; a test flips this.
  const store: Store = { ...real, list: () => (touchWaiting.on ? [{ status: 'awaiting_touch' } as Proposal] : real.list()) };
  const server = createServer({
    cfg,
    token,
    vault,
    intentsReceive: async () => {
      const report = keystore.addressReport();
      return { account: report.addresses.evm, verified: report.verified, tampered: report.tampered, networks: [] };
    },
    audit,
    store,
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

  async function send(route: string, body: Record<string, unknown>) {
    const res = await fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  const post = (route: string, body: Record<string, unknown> = {}) => send(route, { token, ...body });
  async function get(route: string) {
    const res = await fetch(`${url}${route}`, { headers: { origin: url, 'x-phosphor-token': token } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }

  const double = opts.double ?? new VaultDouble();
  const shell = relayTo((route, body) => send(route, { relay: relaySecret, ...body }), double, transport, opts.hook);
  const probe = async (): Promise<void> => {
    const probed = await vault.ask({ op: 'probe' });
    assert.ok(probed.ok, JSON.stringify(probed));
  };
  await probe();

  const live = path.join(path.dirname(keysPath), 'keys.enc.json');
  const staged = stagedPathFor(keysPath);
  return {
    dataDir,
    keysPath,
    live,
    staged,
    keystore,
    vault,
    audit,
    double,
    shell,
    touchWaiting,
    prefs: createVaultPrefs(dataDir),
    post,
    get,
    probe,
    close: async () => {
      vault.stop();
      await shell.stop();
      await new Promise<void>((r) => server.close(() => r()));
      useKeystore(null);
    },
  };
}

/* A wallet whose key is a device-bound blob, made the way every wallet before the keychain home
   was (a build with no Team ID), then seen by a Developer ID build: the state Karim's wallet is in. */
async function blobWallet(b: Booted): Promise<{ evm: string }> {
  b.double.team = '';
  await b.probe();
  const made = await b.post('/api/vault/create');
  assert.equal(made.json.ok, true, JSON.stringify(made.json));
  b.double.team = TEAM;
  await b.probe();
  assert.equal(b.vault.capability()?.keychainHome, true);
  const vault = (await b.get('/api/vault')).json;
  assert.equal(vault.enclave.binding, 'device');
  return { evm: made.json.addresses.evm };
}

/* Until the shell has answered everything asked so far, the sweep a step sends last included. */
async function idle(b: Booted): Promise<void> {
  for (let i = 0; i < 200 && b.vault.queued() > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.vault.queued(), 0, 'the relay went quiet');
}

const liveRequest = (b: Booted): EnclaveUnwrapRequest => b.keystore.enclaveRequest()!;
const statusOf = (b: Booted, request: Record<string, unknown>): Answer => b.double.run({ op: 'status', ...material(request) });
const seenSince = (b: Booted, from: number): Request[] => b.shell.seen.slice(from);
const ops = (requests: Request[]): string[] => requests.map((r) => (r.op === 'unwrap' ? `unwrap:${r.reason}` : r.op));

test('a device-bound wallet binds with one Touch ID: staged, proven, committed, then put in place', { skip }, async () => {
  const b = await boot();
  try {
    const { evm } = await blobWallet(b);
    b.prefs.markBackedUp();
    const before = fs.readFileSync(b.live, 'utf8');
    const touches = b.double.touches().length;
    const from = b.shell.seen.length;

    const bound = await b.post('/api/vault/bind');
    assert.deepEqual(bound.json, { ok: true, binding: 'app' });
    const asked = seenSince(b, from);
    assert.deepEqual(ops(asked).filter((o) => o !== 'sweep'), ['create', `unwrap:${BIND_REASON}`, 'commit']);
    assert.equal(b.double.touches().length, touches + 1, 'one Touch ID');
    const unwrap = asked.find((r) => r.op === 'unwrap')!;
    const commit = asked.find((r) => r.op === 'commit')!;
    assert.deepEqual(material(commit), material(unwrap), 'the commit pins exactly what the touch proved');
    assert.match(String(commit.keyBlob), /^keychain:com\.karimbabasf\.phosphor\.vault\.[0-9A-F-]{36}$/);

    // In place: the live file is the proven one, its marker matches, the staged path is clear.
    assert.deepEqual(material(liveRequest(b)), material(unwrap));
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true);
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(b.keystore.state(), 'unlocked', 'the wallet stays open');
    assert.equal(b.keystore.addresses().evm, evm, 'the same wallet');
    assert.match(b.keystore.evmPrivateKey(), /^0x[0-9a-f]{64}$/);
    const vault = (await b.get('/api/vault')).json;
    assert.equal(vault.enclave.binding, 'app');
    assert.ok(b.audit.tail(40).some((e) => e.msg.includes("bound to Phosphor on this Mac")));

    // The old device-bound file no longer opens here, and is refused before any touch.
    b.keystore.lock();
    const bound2 = fs.readFileSync(b.live, 'utf8');
    fs.writeFileSync(b.live, before);
    const t0 = b.double.touches().length;
    const old = await b.post('/api/vault/unlock');
    assert.equal(old.json.code, 'blob_refused');
    assert.equal(old.json.error, refusal('blob_refused').error);
    assert.equal(b.double.touches().length, t0, 'no dialog for a refused file');
    // The bound file opens, through the pin check.
    fs.writeFileSync(b.live, bound2);
    const opened = await b.post('/api/vault/unlock');
    assert.equal(opened.json.ok, true, JSON.stringify(opened.json));
    assert.equal(b.keystore.addresses().evm, evm);

    // Bound again is bound: no key, no touch.
    const keys = b.double.state().keys.length;
    const again = await b.post('/api/vault/bind');
    assert.deepEqual(again.json, { ok: true, binding: 'app' });
    assert.equal(b.double.state().keys.length, keys);
    assert.equal(b.double.touches().length, t0 + 1);
  } finally {
    await b.close();
  }
});

test('the bind is refused in plain words when it cannot hold, and nothing is made or touched', { skip }, async () => {
  const b = await boot();
  try {
    await blobWallet(b);
    const before = fs.readFileSync(b.live, 'utf8');
    const quiet = async (code: string): Promise<void> => {
      const keys = b.double.state().keys.length;
      const touches = b.double.touches().length;
      const got = await b.post('/api/vault/bind');
      assert.equal(got.json.ok, false, code);
      assert.equal(got.json.code, code);
      assert.equal(got.json.error, refusal(code).error);
      assert.notEqual(got.json.error, 'That did not work.');
      assert.equal(b.double.state().keys.length, keys, `${code}: no key was made`);
      assert.equal(b.double.touches().length, touches, `${code}: no dialog`);
      assert.equal(fs.readFileSync(b.live, 'utf8'), before, `${code}: the live file is untouched`);
      assert.equal(fs.existsSync(b.staged), false, `${code}: nothing staged`);
    };

    await quiet('not_backed_up');
    b.prefs.markBackedUp();
    b.touchWaiting.on = true;
    await quiet('touch_waiting');
    b.touchWaiting.on = false;
    b.keystore.lock();
    await quiet('wallet_locked');
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true);
    b.double.team = '';
    await b.probe();
    await quiet('no_keychain_home');
    b.double.team = TEAM;
    await b.probe();
  } finally {
    await b.close();
  }

  const p = await boot();
  try {
    const made = await p.post('/api/wallet/create', { password: 'a long enough password' });
    assert.equal(made.json.ok, true);
    const got = await p.post('/api/vault/bind');
    assert.equal(got.json.code, 'not_enclave');
    assert.equal(got.json.error, refusal('not_enclave').error);
  } finally {
    await p.close();
  }
});

test('a cancelled bind leaves the live file exactly as it was, and its key goes at the next sweep once old', { skip }, async () => {
  const b = await boot();
  try {
    await blobWallet(b);
    b.prefs.markBackedUp();
    const before = fs.readFileSync(b.live, 'utf8');
    b.double.touch = 'cancel';
    const cancelled = await b.post('/api/vault/bind');
    b.double.touch = undefined;
    assert.equal(cancelled.json.code, 'user_cancel');
    assert.equal(fs.readFileSync(b.live, 'utf8'), before);
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(b.double.state().markers.length, 0, 'nothing committed');
    assert.equal(b.keystore.state(), 'unlocked');
    const orphan = b.double.state().keys[0].tag;

    assert.deepEqual((await b.post('/api/vault/bind')).json, { ok: true, binding: 'app' });
    await idle(b);
    assert.equal(b.double.state().keys.length, 2, 'the cancelled key is still in its first minutes');
    b.double.now = T0 + 601;
    const swept = await b.vault.ask({ op: 'sweep' });
    assert.ok(swept.ok && swept.op === 'sweep' && swept.deleted === 1, JSON.stringify(swept));
    const left = b.double.state();
    assert.equal(left.keys.length, 1);
    assert.notEqual(left.keys[0].tag, orphan);
    assert.equal(left.markers[0].tag, left.keys[0].tag, 'what is left is the bound key, and it has its marker');
  } finally {
    await b.close();
  }
});

test('a commit that does not answer is settled by asking the service what is true', { skip }, async () => {
  // Refused: no marker was written, so the staged file goes and the live file stays.
  let mode: 'refuse' | 'lost' | 'unknown' = 'refuse';
  const double = new VaultDouble();
  const hook = (r: Request): Hook => {
    if (r.op === 'commit' && mode === 'refuse') {
      double.fail = 'addMarker=-25308';
      return { kind: 'after', edit: (a) => ((double.fail = undefined), a) };
    }
    if (r.op === 'commit') return { kind: 'after', edit: () => ({ ok: false, error: 'timeout', message: 'nobody answered the request' }) };
    if (r.op === 'status' && mode === 'unknown') return { kind: 'answer', answer: { ok: false, error: 'keychain_unavailable', message: 'unreadable' } };
    return { kind: 'run' };
  };
  const b = await boot({ double, hook });
  try {
    await blobWallet(b);
    b.prefs.markBackedUp();
    const before = fs.readFileSync(b.live, 'utf8');
    const refused = await b.post('/api/vault/bind');
    assert.equal(refused.json.code, 'keychain_unavailable');
    assert.equal(fs.readFileSync(b.live, 'utf8'), before);
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(double.state().markers.length, 0);

    // The marker was written and only the answer was lost: the service says so, and the bind finishes.
    mode = 'lost';
    const lost = await b.post('/api/vault/bind');
    assert.deepEqual(lost.json, { ok: true, binding: 'app' });
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true);
  } finally {
    await b.close();
  }

  // Lost, and the service cannot say: the staged file stays for the next open, which finishes it.
  mode = 'unknown';
  const c = await boot({ double: new VaultDouble(), hook });
  try {
    await blobWallet(c);
    c.prefs.markBackedUp();
    const before = fs.readFileSync(c.live, 'utf8');
    const unknown = await c.post('/api/vault/bind');
    assert.equal(unknown.json.code, 'keychain_unavailable');
    assert.equal(fs.readFileSync(c.live, 'utf8'), before, 'the live file is untouched');
    assert.equal(fs.existsSync(c.staged), true, 'the staged file is kept: it may be the only file that opens');
    assert.equal(c.double.state().markers.length, 1, 'the commit did land');
    for (const route of ['/api/vault/bind', '/api/vault/create']) {
      assert.equal((await c.post(route)).json.code, 'keychain_unavailable', `${route} writes nothing over an undecided staged file`);
    }
    mode = 'refuse';
    c.keystore.lock();
    const from = c.shell.seen.length;
    const opened = await c.post('/api/vault/unlock');
    assert.equal(opened.json.ok, true, JSON.stringify(opened.json));
    const unwrap = seenSince(c, from).find((r) => r.op === 'unwrap')!;
    assert.match(String(unwrap.keyBlob), /^keychain:/, 'the open met the committed file, put in place first');
    assert.equal(fs.existsSync(c.staged), false);
    assert.ok(c.audit.tail(40).some((e) => e.msg.includes('committed before Phosphor stopped')));
  } finally {
    await c.close();
  }
});

test('what a crash leaves is settled at the next open by the service, one rule per state', { skip }, async () => {
  const b = await boot();
  try {
    const { evm } = await blobWallet(b);
    const blob = fs.readFileSync(b.live, 'utf8');
    const fresh = (): { keyBlob: string; publicKey: string; createdAt: string } => {
      const made = b.double.run({ op: 'create' });
      assert.equal(made.ok, true);
      return { keyBlob: made.keyBlob as string, publicKey: made.publicKey as string, createdAt: new Date(T0 * 1000).toISOString() };
    };
    const unlockAsks = async (): Promise<{ json: any; unwrap: Request | undefined }> => {
      const from = b.shell.seen.length;
      const res = await b.post('/api/vault/unlock');
      return { json: res.json, unwrap: seenSince(b, from).find((r) => r.op === 'unwrap') };
    };

    // Staged, not committed: shredded; the live file opens as before.
    b.keystore.stageRewrap(fresh());
    b.keystore.lock();
    let got = await unlockAsks();
    assert.equal(got.json.ok, true, JSON.stringify(got.json));
    assert.ok(!String(got.unwrap?.keyBlob).startsWith('keychain:'), 'the device-bound file opened');
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(fs.readFileSync(b.live, 'utf8'), blob);
    assert.ok(b.audit.tail(40).some((e) => e.msg.includes('never committed')));

    // Renamed (the staged file is the live one): removed, and nothing else changes.
    fs.copyFileSync(b.live, b.staged);
    b.keystore.lock();
    got = await unlockAsks();
    assert.equal(got.json.ok, true);
    assert.equal(fs.existsSync(b.staged), false);

    // A build with no keychain home cannot tell: it leaves the staged file and opens the live one.
    const key = fresh();
    const s = b.keystore.stageRewrap(key);
    b.double.team = '';
    await b.probe();
    b.keystore.lock();
    got = await unlockAsks();
    assert.equal(got.json.ok, true);
    assert.equal(fs.existsSync(b.staged), true);
    b.double.team = TEAM;
    await b.probe();

    // A file that cannot be read is never deleted.
    fs.writeFileSync(b.staged, 'not a key file');
    b.keystore.lock();
    got = await unlockAsks();
    assert.equal(got.json.ok, true);
    assert.equal(fs.readFileSync(b.staged, 'utf8'), 'not a key file');

    // Committed, not renamed: put in place, and the open goes on with it.
    fs.writeFileSync(b.staged, s.bytes);
    assert.equal(b.double.run({ op: 'commit', ...material(s.request) }).ok, true);
    b.keystore.lock();
    got = await unlockAsks();
    assert.equal(got.json.ok, true, JSON.stringify(got.json));
    assert.equal(got.unwrap?.keyBlob, key.keyBlob, 'the open asked about the committed file');
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(fs.readFileSync(b.live, 'utf8'), s.bytes);
    assert.equal(b.keystore.addresses().evm, evm);

    // A staged file wrapped to a committed key but not the committed file: shredded, never installed.
    const other = b.keystore.stageRewrap(key);
    assert.notDeepEqual(material(other.request), material(s.request));
    b.keystore.lock();
    got = await unlockAsks();
    assert.equal(got.json.ok, true, 'the bound file in place still opens');
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(fs.readFileSync(b.live, 'utf8'), s.bytes);
  } finally {
    await b.close();
  }
});

test('no answer from the service leaves a staged file alone, and nothing writes over it', { skip }, async () => {
  const double = new VaultDouble();
  let deaf = false;
  const b = await boot({ double, hook: (r) => (deaf && r.op === 'status' ? { kind: 'answer', answer: { ok: false, error: 'keychain_unavailable', message: 'x' } } : { kind: 'run' }) });
  try {
    await blobWallet(b);
    b.prefs.markBackedUp();
    const made = double.run({ op: 'create' });
    const s = b.keystore.stageRewrap({ keyBlob: made.keyBlob as string, publicKey: made.publicKey as string, createdAt: new Date().toISOString() });
    deaf = true;
    for (const route of ['/api/vault/bind', '/api/vault/restore', '/api/vault/migrate']) {
      const body = route === '/api/vault/restore' ? { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' } : {};
      assert.equal((await b.post(route, body)).json.code, 'keychain_unavailable', route);
    }
    assert.equal(fs.readFileSync(b.staged, 'utf8'), s.bytes, 'still the staged file');
    b.keystore.lock();
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true, 'the live file still opens');
    assert.equal(fs.readFileSync(b.staged, 'utf8'), s.bytes);
  } finally {
    await b.close();
  }
});

test('new wallets are committed at creation: create, restore and the move from a password', { skip }, async () => {
  const b = await boot();
  try {
    const from = b.shell.seen.length;
    const made = await b.post('/api/vault/create');
    assert.equal(made.json.ok, true, JSON.stringify(made.json));
    const asked = seenSince(b, from);
    assert.deepEqual(ops(asked).filter((o) => o !== 'sweep'), ['create', `unwrap:${CREATE_REASON}`, 'commit']);
    const unwrap = asked.find((r) => r.op === 'unwrap')!;
    assert.deepEqual(material(asked.find((r) => r.op === 'commit')!), material(unwrap));
    assert.deepEqual(material(liveRequest(b)), material(unwrap), 'the file in place is the proven one');
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true);
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(b.keystore.state(), 'unlocked');
    assert.equal((await b.get('/api/vault')).json.enclave.binding, 'app');
    const phrase = ((await b.post('/api/vault/reveal')).json.words as string[]).join(' ');

    // Restore: the same shape, and the file it replaces is the one in place until the commit.
    b.prefs.markBackedUp();
    const r0 = b.shell.seen.length;
    const restored = await b.post('/api/vault/restore', { mnemonic: phrase });
    assert.equal(restored.json.ok, true, JSON.stringify(restored.json));
    const rAsked = seenSince(b, r0);
    assert.deepEqual(ops(rAsked).filter((o) => o !== 'sweep' && o !== 'status'), ['create', `unwrap:${RESTORE_REASON}`, 'commit']);
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true);
    assert.equal(b.keystore.addresses().evm, made.json.addresses.evm);
  } finally {
    await b.close();
  }

  // A cancelled or uncommitted create leaves no wallet at all.
  const c = await boot();
  try {
    c.double.touch = 'cancel';
    assert.equal((await c.post('/api/vault/create')).json.code, 'user_cancel');
    c.double.touch = undefined;
    assert.equal(fs.existsSync(c.live), false);
    assert.equal(fs.existsSync(c.staged), false);
    c.double.fail = 'addMarker=-25308';
    assert.equal((await c.post('/api/vault/create')).json.code, 'keychain_unavailable');
    c.double.fail = undefined;
    assert.equal(fs.existsSync(c.live), false, 'a wallet whose commit did not land is not a wallet');
    assert.equal(c.keystore.state(), 'no_wallet');
  } finally {
    await c.close();
  }

  // The move from a password: the password file is replaced only after the commit.
  const m = await boot();
  try {
    const password = 'a long enough password';
    const made = await m.post('/api/wallet/create', { password });
    assert.equal(made.json.ok, true);
    const before = fs.readFileSync(m.live, 'utf8');
    m.double.touch = 'cancel';
    const cancelled = await m.post('/api/vault/migrate', { password });
    m.double.touch = undefined;
    assert.equal(cancelled.json.code, 'user_cancel');
    assert.equal(fs.readFileSync(m.live, 'utf8'), before, 'the password file is exactly as it was');
    assert.equal(fs.existsSync(m.staged), false);
    m.keystore.lock();
    assert.equal((await m.post('/api/unlock', { password })).json.ok, true, 'and the password still opens it');

    const from = m.shell.seen.length;
    const moved = await m.post('/api/vault/migrate', { password });
    assert.equal(moved.json.ok, true, JSON.stringify(moved.json));
    assert.deepEqual(ops(seenSince(m, from)).filter((o) => o !== 'sweep'), ['create', `unwrap:${MIGRATE_REASON}`, 'commit']);
    assert.equal(statusOf(m, liveRequest(m)).pinMatches, true);
    m.keystore.lock();
    assert.equal((await m.post('/api/unlock', { password })).json.code, 'enclave_required');
    assert.equal((await m.post('/api/vault/unlock')).json.ok, true);
    assert.equal(m.keystore.addresses().evm, made.json.addresses.evm);
  } finally {
    await m.close();
  }
});

test('a substitute wallet file is refused before any Touch ID, in words a person can act on', { skip }, async () => {
  const b = await boot();
  try {
    assert.equal((await b.post('/api/vault/create')).json.ok, true);
    b.keystore.lock();
    const real = liveRequest(b);
    const header = JSON.parse(fs.readFileSync(b.live, 'utf8')).header;
    // Anyone can wrap a wallet of their own to the real key's public half, which is in the header.
    const elsewhere = createKeystore({ keysPath: path.join(tempDir('phosphor-bind-sub-'), 'keys.json'), kdf: fast });
    elsewhere.createWithEnclave(header.enclave);
    fs.copyFileSync(elsewhere.path(), b.live);
    assert.equal(liveRequest(b).keyBlob, real.keyBlob, 'the substitute names the real key');
    const touches = b.double.touches().length;
    for (const purpose of [undefined, 'address']) {
      const got = await b.post('/api/vault/unlock', purpose === undefined ? {} : { purpose });
      assert.equal(got.json.code, 'pin_mismatch');
      assert.equal(got.json.error, refusal('pin_mismatch').error);
      assert.ok(!/marker|\bpin\b|commit|keychain item/i.test(got.json.error), got.json.error);
    }
    assert.equal(b.double.touches().length, touches, 'no dialog was shown for the substitute');
    assert.equal(b.keystore.state(), 'locked');
  } finally {
    await b.close();
  }
});

test('the restore guard counts a file this Mac refuses as one it cannot open', { skip }, async () => {
  const b = await boot();
  try {
    const { evm } = await blobWallet(b);
    const blob = fs.readFileSync(b.live, 'utf8');
    const other = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    // Not backed up, a different phrase, and a file this Mac opens: refused.
    assert.equal((await b.post('/api/vault/restore', { mnemonic: other })).json.code, 'not_backed_up');
    b.prefs.markBackedUp();
    assert.equal((await b.post('/api/vault/bind')).json.ok, true);
    b.prefs.clearBackedUp();
    assert.equal((await b.post('/api/vault/restore', { mnemonic: other })).json.code, 'not_backed_up', 'the bound file opens, so it is guarded');
    // An older device-bound copy put back in place opens nothing on this Mac, so replacing it loses nothing.
    fs.writeFileSync(b.live, blob);
    b.keystore.lock();
    const restored = await b.post('/api/vault/restore', { mnemonic: other });
    assert.equal(restored.json.ok, true, JSON.stringify(restored.json));
    assert.notEqual(b.keystore.addresses().evm, evm);
  } finally {
    await b.close();
  }
});

test('one custody step at a time: an unlock during a bind waits for it and opens the bound file', { skip }, async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let heldBind = false;
  const b = await boot({
    hook: async (r) => {
      if (r.op === 'unwrap' && r.reason === BIND_REASON) {
        heldBind = true;
        await gate;
      }
      return { kind: 'run' };
    },
  });
  try {
    const { evm } = await blobWallet(b);
    b.prefs.markBackedUp();
    const binding = b.post('/api/vault/bind');
    while (!heldBind) await new Promise((r) => setTimeout(r, 10));
    // A second bind while the first waits on its touch is refused at once.
    assert.equal((await b.post('/api/vault/bind')).json.code, 'bind_busy');
    // The idle lock fires while the dialog is up, and the person unlocks.
    b.keystore.lock();
    const seen = b.shell.seen.length;
    const unlocking = b.post('/api/vault/unlock');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(b.vault.queued(), 1, 'the unlock asked nothing while the bind held the file: only the bind\'s touch is out');
    release();
    assert.deepEqual((await binding).json, { ok: true, binding: 'app' });
    const opened = await unlocking;
    assert.equal(opened.json.ok, true, JSON.stringify(opened.json));
    const unwrap = seenSince(b, seen).find((r) => r.op === 'unwrap' && r.reason === UNLOCK_REASON)!;
    assert.match(String(unwrap.keyBlob), /^keychain:/, 'the unlock asked about the bound file');
    assert.deepEqual(material(unwrap), material(liveRequest(b)));
    assert.equal(b.keystore.state(), 'unlocked');
    assert.equal(b.keystore.addresses().evm, evm);
  } finally {
    release();
    await b.close();
  }
});

test('a staged file swapped on disk during the touch is not what gets proven, pinned or put in place', { skip }, async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let held = false;
  const b = await boot({
    hook: async (r) => {
      if (r.op === 'unwrap' && r.reason === BIND_REASON) {
        held = true;
        await gate;
      }
      return { kind: 'run' };
    },
  });
  try {
    const { evm } = await blobWallet(b);
    b.prefs.markBackedUp();
    const binding = b.post('/api/vault/bind');
    while (!held) await new Promise((r) => setTimeout(r, 10));
    // Another process writes its own wallet, wrapped to the same new key, where the staged file is.
    const ours = fs.readFileSync(b.staged, 'utf8');
    const header = JSON.parse(ours).header;
    const elsewhere = createKeystore({ keysPath: path.join(tempDir('phosphor-bind-swap-'), 'keys.json'), kdf: fast });
    elsewhere.createWithEnclave(header.enclave);
    fs.copyFileSync(elsewhere.path(), b.staged);
    release();
    assert.deepEqual((await binding).json, { ok: true, binding: 'app' });
    assert.equal(fs.readFileSync(b.live, 'utf8'), ours, 'the bytes put in place are the ones this process wrote');
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true);
    assert.equal(b.double.run({ op: 'status', ...material(elsewhere.enclaveRequest()!) }).pinMatches, false, 'the swapped file was never pinned');
    b.keystore.lock();
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true);
    assert.equal(b.keystore.addresses().evm, evm);
  } finally {
    release();
    await b.close();
  }
});

function deadPid(): number {
  for (let pid = 99_999; pid > 50_000; pid -= 7) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no free pid found');
}

test('after the first open of the bound file, the copies this app left are shredded, and nothing else', { skip }, async () => {
  const b = await boot();
  try {
    await blobWallet(b);
    b.prefs.markBackedUp();
    const dir = path.dirname(b.live);
    const dead = deadPid();
    const ours = [`.keys.enc.json.${dead}.deadbeef.tmp`, `.keys.enc.json.bind.${dead}.cafef00d.tmp`];
    const theirs = [`.keys.enc.json.${process.ppid}.0badf00d.tmp`, 'keys.enc.json.backup', 'keys.enc.json.bak', 'notes.txt'];
    for (const name of [...ours, ...theirs]) fs.writeFileSync(path.join(dir, name), fs.readFileSync(b.live));
    // A name shaped like a leftover that is really a link to somebody's file loses only the name.
    const victim = path.join(tempDir('phosphor-bind-victim-'), 'thesis.txt');
    fs.writeFileSync(victim, 'mine, not the app\'s');
    const linked = [`.keys.enc.json.${dead}.feedface.tmp`, `.keys.enc.json.${dead}.facefeed.tmp`];
    fs.linkSync(victim, path.join(dir, linked[0]));
    fs.symlinkSync(victim, path.join(dir, linked[1]));

    assert.equal((await b.post('/api/vault/bind')).json.ok, true);
    for (const name of [...ours, ...theirs]) assert.ok(fs.existsSync(path.join(dir, name)), `${name} waits for the first open`);
    b.keystore.lock();
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true);
    for (const name of ours) assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} is the app's own leftover`);
    for (const name of theirs) assert.ok(fs.existsSync(path.join(dir, name)), `${name} is not the app's to delete`);
    for (const name of linked) assert.equal(fs.existsSync(path.join(dir, name)), false);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'mine, not the app\'s', 'a linked file keeps every byte');
    assert.ok(b.audit.tail(40).some((e) => e.msg.includes('4 leftover copies')));
  } finally {
    await b.close();
  }
});

test('every refusal the bind can give is said in plain words', () => {
  for (const code of ['wallet_locked', 'not_enclave', 'no_keychain_home', 'bind_busy', 'touch_waiting', 'install_pending', 'not_backed_up', 'keychain_unavailable', 'user_cancel']) {
    const said = String(refusal(code).error);
    assert.notEqual(said, 'That did not work.', code);
    assert.ok(!/marker|\bpin\b|\btag\b|group|commit|sweep|entitlement|stag(ed|ing)|blob|-\d{4,5}/i.test(said), `${code}: ${said}`);
  }
  assert.ok(BIND_REASON.length <= 120 && /^[A-Z]/.test(BIND_REASON));
});

test('no shipped source names the test double or its switches', () => {
  const shipped = ['src', 'src-tauri/src', 'src-tauri/se-helper', 'scripts', 'ui'];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js|rs|swift|sh|c|h)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/vault-double|VaultTestPlatform|PHOSPHOR_TEST_STORE|PHOSPHOR_TESTSEAM/.test(text) && !full.endsWith('main.swift')) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  for (const dir of shipped) walk(path.join(ROOT, dir));
  assert.deepEqual(offenders, []);
  // main.swift names the flag in one #if, and builds the stand-in nowhere else (vault-service.test.ts holds the rest).
  assert.equal(fs.readFileSync(path.join(ROOT, 'src-tauri/se-helper/main.swift'), 'utf8').split('PHOSPHOR_TESTSEAM').length, 3);
});

// ---------- the crash matrix: real backends, killed at each step of a bind ----------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

type Backend = {
  child: ChildProcess;
  post(route: string, body?: Record<string, unknown>): Promise<{ status: number; json: any }>;
  get(route: string): Promise<{ status: number; json: any }>;
  shell: ReturnType<typeof relayTo>;
  stop(): Promise<void>;
  kill(): Promise<void>;
};

/* The real backend (src/main.ts) in its own process, on a scratch data dir and a fake home, with
   the handshake the shell gives it, and the test playing the shell over HTTP. */
async function backend(dir: string, double: VaultDouble, hook?: (r: Request) => Hook | Promise<Hook>): Promise<Backend> {
  const port = await freePort();
  assert.notEqual(port, 4177);
  const base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ port, mode: 'demo' }));
  const token = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  const transportHex = crypto.randomBytes(32).toString('hex');
  const relaySecret = crypto.randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: process.env.TMPDIR ?? '',
      PHOSPHOR_DATA_DIR: path.join(dir, 'state'),
      PHOSPHOR_CONFIG_DIR: dir,
      PHOSPHOR_APP_DATA: '1',
      PHOSPHOR_KEYS: path.join(dir, 'keys', 'keys.json'),
      PHOSPHOR_PORT: String(port),
      ACC_MODE: 'demo',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout!.on('data', (d: Buffer) => output.push(d.toString()));
  child.stderr!.on('data', (d: Buffer) => output.push(d.toString()));
  child.stdin!.write(`${token}\n${nonce}\n${crypto.randomBytes(32).toString('hex')}\n${transportHex}\n${relaySecret}\n`);
  child.stdin!.end();
  const exited = new Promise<void>((r) => child.once('exit', () => r()));

  async function send(route: string, body: Record<string, unknown>) {
    const challenge = crypto.randomBytes(32).toString('hex');
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-phosphor-challenge': challenge }, body: JSON.stringify(body) });
    assert.equal(res.headers.get('x-phosphor')?.toLowerCase(), identityProof(nonce, challenge), 'this boot answered');
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`the backend did not come up: ${output.join('').slice(-600)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const shell = relayTo((route, body) => send(route, { relay: relaySecret, ...body }), double, Buffer.from(transportHex, 'hex'), hook);
  const get = async (route: string) => {
    const res = await fetch(`${base}${route}`, { headers: { 'x-phosphor-token': token } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  for (let i = 0; i < 100; i += 1) {
    if ((await get('/api/vault')).json?.enclave?.ready === true) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    child,
    post: (route, body = {}) => send(route, { token, ...body }),
    get,
    shell,
    stop: async () => {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await shell.stop();
    },
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
      await shell.stop();
    },
  };
}

test('the crash matrix: a bind killed before its commit, between commit and rename, and after the rename opens correctly on the next start', { skip, timeout: 240_000 }, async () => {
  type Point = 'before commit' | 'between commit and rename' | 'after rename';
  for (const point of ['before commit', 'between commit and rename', 'after rename'] as Point[]) {
    const dir = tempDir('phosphor-crash-');
    const double = new VaultDouble(path.join(dir, 'keychain.json'));
    const live = path.join(dir, 'keys', 'keys.enc.json');
    const staged = path.join(dir, 'keys', 'keys.enc.json.bind');

    // A device-bound wallet, made the way 0.10.14 made Karim's, backed up.
    double.team = '';
    let app = await backend(dir, double);
    const made = await app.post('/api/vault/create');
    assert.equal(made.json.ok, true, point);
    const revealed = await app.post('/api/vault/reveal');
    const words = revealed.json.words as string[];
    assert.equal((await app.post('/api/vault/backup-proven', { words: (revealed.json.prove as number[]).map((index) => ({ index, word: words[index] })) })).json.ok, true);
    await app.stop();
    const blob = fs.readFileSync(live, 'utf8');
    const address = made.json.addresses.evm as string;
    assert.ok(!JSON.parse(blob).header.enclave.keyBlob.startsWith('keychain:'), 'a device-bound wallet');

    // The Developer ID build starts, the wallet opens, and the bind is killed at `point`.
    double.team = TEAM;
    let killed = false;
    let killing: Promise<void> | null = null;
    app = await backend(dir, double, (r) => {
      const stop = (): void => {
        killed = true;
        killing = app.kill();
      };
      if (point === 'before commit' && r.op === 'commit') {
        stop();
        return { kind: 'drop' };
      }
      if (point === 'between commit and rename' && r.op === 'commit') {
        return {
          kind: 'after',
          edit: (a: Answer) => {
            assert.equal(a.ok, true, 'the commit ran');
            stop();
            return 'drop';
          },
        };
      }
      if (point === 'after rename' && r.op === 'sweep') {
        stop();
        return { kind: 'drop' };
      }
      return { kind: 'run' };
    });
    assert.equal((await app.post('/api/vault/unlock')).json.ok, true, `${point}: the device-bound wallet opens on the Developer ID build`);
    await app.post('/api/vault/bind').catch(() => null);
    while (!killed) await new Promise((r) => setTimeout(r, 20));
    await killing;

    const markers = double.state().markers.length;
    if (point === 'before commit') {
      assert.equal(fs.readFileSync(live, 'utf8'), blob, `${point}: the live file is untouched`);
      assert.equal(fs.existsSync(staged), true);
      assert.equal(markers, 0);
    } else if (point === 'between commit and rename') {
      assert.equal(fs.readFileSync(live, 'utf8'), blob);
      assert.equal(fs.existsSync(staged), true);
      assert.equal(markers, 1);
    } else {
      assert.notEqual(fs.readFileSync(live, 'utf8'), blob, `${point}: the bound file is in place`);
      assert.equal(fs.existsSync(staged), false);
      assert.equal(markers, 1);
    }

    // The next start: the shell's probe settles what was left, and the next open opens the right file.
    app = await backend(dir, double);
    try {
      const opened = await app.post('/api/vault/unlock');
      assert.equal(opened.json.ok, true, `${point}: ${JSON.stringify(opened.json)}`);
      assert.equal(fs.existsSync(staged), false, `${point}: nothing staged is left`);
      const file = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.equal(String(file.header.addresses.evm).toLowerCase(), address.toLowerCase(), `${point}: the same wallet`);
      const bound = String(file.header.enclave.keyBlob).startsWith('keychain:');
      assert.equal(bound, point !== 'before commit', `${point}: bound exactly when the commit landed`);

      if (point === 'before commit') {
        // The bind is asked again, and goes through: the Mac is bound from here on.
        assert.deepEqual((await app.post('/api/vault/bind')).json, { ok: true, binding: 'app' });
      }
      // No orphan key past a sweep: once every key made in this run is past its first minutes,
      // the keychain holds the bound key and its marker, and nothing else.
      double.now = T0 + 3600;
      const swept = double.run({ op: 'sweep' });
      assert.equal(swept.ok, true, JSON.stringify(swept));
      const left = double.state();
      const current = JSON.parse(fs.readFileSync(live, 'utf8')).header.enclave.keyBlob.slice('keychain:'.length);
      assert.deepEqual(left.keys.map((k) => k.tag), [current], `${point}: one key, the bound one`);
      assert.deepEqual(left.markers.map((m) => m.tag), [current], `${point}: one marker, for it`);
      const pin = double.run({ op: 'status', ...material(liveRequestOf(live)) });
      assert.equal(pin.pinMatches, true, `${point}: the file in place is the committed one`);
    } finally {
      await app.stop();
    }
  }
});

/* The request the backend sends for the file at `live`, built by the app's own keystore. */
function liveRequestOf(live: string): EnclaveUnwrapRequest {
  const keystore: Keystore = createKeystore({ keysPath: path.join(path.dirname(live), 'keys.json'), kdf: fast });
  return keystore.enclaveRequest()!;
}
