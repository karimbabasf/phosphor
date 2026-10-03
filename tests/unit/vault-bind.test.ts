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
import { BIND_REASON, CREATE_REASON, MIGRATE_REASON, RESTORE_KEY_REASON, RESTORE_REASON, UNLOCK_REASON } from '../../src/vault/reason.ts';
import { refusal } from '../../src/http/wallet.ts';
import { settleAtStart } from '../../src/http/custody.ts';
import { base58Encode } from '../../src/chain/near.ts';
import { privateKeyToAccount } from 'viem/accounts';
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
    assert.ok(b.audit.tail(40).some((e) => e.msg.includes("made Phosphor-only on this Mac")));

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

test('a bind keeps every key the file sealed: the legacy NEAR and Solana keys and a trading key, not only the one the backup holds', { skip }, async () => {
  const b = await boot();
  try {
    // A file as old ones are: keygen's three rails and a Hyperliquid trading key, moved from the
    // plaintext keys.json to a password file, then behind a key bound to this Mac.
    const evmKey = `0x${'2a'.repeat(32)}` as const;
    const agentKey = `0x${'3b'.repeat(32)}`;
    const legacy = {
      evm: { address: privateKeyToAccount(evmKey).address, privateKey: evmKey },
      solana: { secretKey: base58Encode(crypto.randomBytes(64)) },
      near: { secretKey: `ed25519:${base58Encode(crypto.randomBytes(64))}` },
      hyperliquidAgents: { mainnet: { privateKey: agentKey, address: privateKeyToAccount(agentKey as `0x${string}`).address, name: 'phosphor' } },
    };
    fs.mkdirSync(path.dirname(b.keysPath), { recursive: true });
    fs.writeFileSync(b.keysPath, JSON.stringify(legacy), { mode: 0o600 });
    const password = 'a long enough password';
    assert.equal((await b.post('/api/wallet/migrate', { password })).json.ok, true);
    b.double.team = '';
    await b.probe();
    assert.equal((await b.post('/api/vault/migrate', { password })).json.ok, true);
    b.double.team = TEAM;
    await b.probe();
    const before = b.keystore.keys();
    assert.ok(before.solana && before.near && before.hyperliquidAgents?.mainnet, 'the legacy keys came through the moves');
    b.prefs.markBackedUp(Date.now, legacy.evm.address);
    assert.deepEqual((await b.post('/api/vault/bind')).json, { ok: true, binding: 'app' });
    b.keystore.lock();
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true);
    assert.deepEqual(b.keystore.keys(), before, 'the bound file seals the same payload, key for key');
    assert.equal(b.keystore.apiWallet()?.address, legacy.hyperliquidAgents.mainnet.address, 'the trading key still signs');
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
    assert.ok(c.audit.tail(40).some((e) => e.msg.includes('ready before Phosphor stopped')));
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
    assert.ok(b.audit.tail(40).some((e) => e.msg.includes('never finished')));

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

test('a restore replaces the wallet only after its Touch ID and its commit: a cancel or a refusal leaves it exactly as it was', { skip }, async () => {
  const b = await boot();
  try {
    const { evm } = await blobWallet(b);
    b.prefs.markBackedUp(Date.now, evm);
    const before = fs.readFileSync(b.live, 'utf8');
    const other = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const otherKey = `0x${'11'.repeat(32)}`;
    const intact = (why: string): void => {
      assert.equal(fs.readFileSync(b.live, 'utf8'), before, `${why}: the wallet file is byte for byte the one that was there`);
      assert.equal(fs.existsSync(b.staged), false, `${why}: nothing staged is left`);
      assert.equal(b.keystore.addresses().evm, evm, `${why}: the same wallet`);
    };
    // A window-token holder used to be able to wipe the wallet here with no presence at all: the
    // file was shredded before the Touch ID it then cancelled.
    b.double.touch = 'cancel';
    for (const body of [{ mnemonic: other }, { key: otherKey }]) {
      const got = await b.post('/api/vault/restore', body);
      assert.equal(got.json.code, 'user_cancel', JSON.stringify(got.json));
      intact(`cancelled (${Object.keys(body)[0]})`);
    }
    b.double.touch = undefined;
    b.double.fail = 'addMarker=-25308';
    assert.equal((await b.post('/api/vault/restore', { mnemonic: other })).json.code, 'keychain_unavailable');
    b.double.fail = undefined;
    intact('a commit that did not land');
    b.keystore.lock();
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true, 'and it still opens');
    assert.equal(b.double.state().markers.length, 0);

    const restored = await b.post('/api/vault/restore', { key: otherKey });
    assert.equal(restored.json.ok, true, JSON.stringify(restored.json));
    assert.notEqual(b.keystore.addresses().evm, evm);
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true, 'a restored wallet is committed at creation');
  } finally {
    await b.close();
  }
});

test('with no wallet on this Mac, a restore from a phrase or a key asks for no backup and is committed at creation', { skip }, async () => {
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const key = `0x${'4c'.repeat(32)}`;
  for (const body of [{ mnemonic: phrase }, { key }]) {
    const b = await boot();
    try {
      assert.equal(b.keystore.state(), 'no_wallet');
      const from = b.shell.seen.length;
      const restored = await b.post('/api/vault/restore', body);
      assert.equal(restored.json.ok, true, JSON.stringify(restored.json));
      const reason = 'key' in body ? RESTORE_KEY_REASON : RESTORE_REASON;
      assert.deepEqual(ops(seenSince(b, from)).filter((o) => o !== 'sweep'), ['create', `unwrap:${reason}`, 'commit'], 'no backup asked, no status read: there is nothing to replace');
      assert.equal(statusOf(b, liveRequest(b)).pinMatches, true);
      assert.equal(b.keystore.state(), 'unlocked');
      assert.equal((await b.get('/api/vault')).json.backedUp, true, 'what was typed from a copy is a proven backup');
    } finally {
      await b.close();
    }
  }
  // A cancelled touch leaves no wallet and nothing staged.
  const c = await boot();
  try {
    c.double.touch = 'cancel';
    assert.equal((await c.post('/api/vault/restore', { key })).json.code, 'user_cancel');
    assert.equal(fs.existsSync(c.live), false);
    assert.equal(fs.existsSync(c.staged), false);
    assert.equal(c.keystore.state(), 'no_wallet');
  } finally {
    await c.close();
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

/* REAUDIT1B, RA1B-01 (LOW). The pin covers a substitute key file of version 2. A same-user process
   can instead move the bound file aside and put a readable keys.json of its own wallet where a wallet
   from before encryption lives: the next start serves that wallet's addresses as verified, with no
   pin, no service question and no Touch ID, and its lock card asks the person to encrypt it. RED until
   a Mac that holds a marker stops vouching for a plaintext key file. */
test('RA1B-01: on a Mac that holds a marker, a plaintext key file put where the bound wallet was is not served as a verified wallet', { skip }, async () => {
  const b = await boot();
  const { double, dataDir } = b;
  const theirKey = `0x${'22'.repeat(32)}` as const;
  const theirs = privateKeyToAccount(theirKey).address;
  try {
    const made = await b.post('/api/vault/create');
    assert.equal(made.json.ok, true, JSON.stringify(made.json));
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true, 'the real wallet is committed, so this Mac holds a marker');
    assert.notEqual(made.json.addresses.evm.toLowerCase(), theirs.toLowerCase());
    b.keystore.lock();
    fs.renameSync(b.live, path.join(path.dirname(b.live), '.moved-aside'));
    fs.writeFileSync(b.keysPath, JSON.stringify({ evm: { address: theirs, privateKey: theirKey } }) + '\n');
  } finally {
    await b.close();
  }

  const c = await boot({ double, dataDir });
  try {
    assert.equal(c.double.state().markers.length, 1, 'the marker of the real wallet is still on this Mac');
    const touches = c.double.touches().length;
    const lock = (await c.get('/api/state')).json.lock;
    assert.equal(lock.state, 'needs_migration');
    assert.equal(String(lock.addresses.evm).toLowerCase(), theirs.toLowerCase(), 'the window and every reader now see the other wallet');
    assert.equal(c.double.touches().length, touches, 'no Touch ID and no service check stood in the way');
    assert.notEqual(lock.verified, true, 'RA1B-01: a plaintext key file on a Mac that holds a marker is served as a verified wallet');
  } finally {
    await c.close();
  }
});

/* REAUDIT1B, RA1B-02 (MEDIUM). proveAndInstall commits only when the start-up probe said keychainHome,
   and that answer is false whenever the probe's one read of the markers failed, while the service
   still makes every new key in the keychain group. So a create, restore or move from a password after
   such a probe installs a keychain wallet with no marker, which the window calls Phosphor-only. Ten
   minutes after any wallet on the Mac is committed it answers not_committed, and the next sweep deletes
   its key: without a backup the wallet is gone. RED until a keychain key is committed whatever the
   probe said. */
test('RA1B-02: a wallet made after a start-up probe that could not read the markers is committed all the same, and keeps opening', { skip }, async () => {
  const double = new VaultDouble();
  double.fail = 'markers=-25308';
  const b = await boot({ double });
  try {
    assert.equal(b.vault.capability()?.keychainHome, false, 'the start-up probe could not read the markers');
    double.fail = undefined;
    const made = await b.post('/api/vault/create');
    assert.equal(made.json.ok, true, JSON.stringify(made.json));
    const live = liveRequest(b);
    assert.ok(live.keyBlob.startsWith('keychain:'), 'the service made the key in the keychain group');
    assert.equal((await b.get('/api/vault')).json.enclave.binding, 'app', 'the window says Phosphor-only');
    assert.equal(statusOf(b, live).pinMatches, true, 'RA1B-02: the new Phosphor-only wallet was never committed: no marker holds its pin');

    // Another wallet made Phosphor-only on this Mac, then ten minutes: the first still opens and keeps its key.
    const other = await boot({ double });
    try {
      assert.equal((await other.post('/api/vault/create')).json.ok, true);
    } finally {
      await other.close();
    }
    double.now = T0 + 601;
    b.keystore.lock();
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true, 'the first wallet still opens');
    double.run({ op: 'sweep' });
    assert.ok(double.state().keys.some((k) => `keychain:${k.tag}` === live.keyBlob), 'a sweep keeps its key');
  } finally {
    await b.close();
  }
});

/* RA1B-02, the window's half: Phosphor-only is said from the service's answer about the file in place,
   never from the start-up probe. Before the service answers nothing is Phosphor-only, and a file no
   marker holds (what an install with no commit left behind) never is. */
test('the window calls a wallet Phosphor-only only once the service confirmed its file committed, never for an uncommitted install', { skip }, async () => {
  const double = new VaultDouble();
  const b = await boot({ double });
  const dataDir = b.dataDir;
  try {
    assert.equal((await b.post('/api/vault/create')).json.ok, true);
    assert.equal((await b.get('/api/vault')).json.enclave.binding, 'app', 'a commit that landed is the service saying so');
  } finally {
    await b.close();
  }

  const c = await boot({ double, dataDir });
  try {
    assert.equal((await c.get('/api/vault')).json.enclave.binding, 'unconfirmed', 'before the service answers, nothing is Phosphor-only');
    assert.equal(await settleAtStart({ keystore: c.keystore, vault: c.vault, audit: c.audit }), 'none');
    assert.equal((await c.get('/api/vault')).json.enclave.binding, 'app', 'the start-up check confirmed the committed file');
  } finally {
    await c.close();
  }

  fs.writeFileSync(double.store, JSON.stringify({ ...double.state(), markers: [] }));
  const d = await boot({ double, dataDir });
  try {
    await settleAtStart({ keystore: d.keystore, vault: d.vault, audit: d.audit });
    assert.equal(statusOf(d, liveRequest(d)).pinMatches, false, 'no marker holds this file');
    assert.equal((await d.get('/api/vault')).json.enclave.binding, 'unconfirmed', 'an uncommitted install is called Phosphor-only');
    assert.equal((await d.get('/api/state')).json.vault.enclave.binding, 'unconfirmed');
  } finally {
    await d.close();
  }
});

/* RA1B-02: with the probe's answer stale, a commit that does not land still ends the step, in the calm
   words, and the wallet in place stays exactly as it was. */
test('after a start-up probe that could not read the markers, a commit that does not land makes nothing and keeps the wallet in place', { skip }, async () => {
  const double = new VaultDouble();
  double.fail = 'markers=-25308';
  const b = await boot({ double });
  let evm = '';
  try {
    assert.equal(b.vault.capability()?.keychainHome, false);
    double.fail = 'addMarker=-25308';
    const made = await b.post('/api/vault/create');
    double.fail = undefined;
    assert.equal(made.json.code, 'keychain_unavailable', JSON.stringify(made.json));
    assert.equal(made.json.error, refusal('keychain_unavailable').error);
    assert.equal(fs.existsSync(b.live), false, 'no wallet was put in place');
    assert.equal(fs.existsSync(b.staged), false, 'nothing staged is left');
    assert.equal(b.keystore.state(), 'no_wallet');
    assert.equal(b.vault.capability()?.keychainHome, true, 'the service answered what the probe could not read');
    const again = await b.post('/api/vault/create');
    assert.equal(again.json.ok, true, JSON.stringify(again.json));
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true);
    evm = again.json.addresses.evm;
  } finally {
    await b.close();
  }

  double.fail = 'markers=-25308';
  const c = await boot({ double, dataDir: b.dataDir });
  double.fail = undefined;
  try {
    assert.equal(c.vault.capability()?.keychainHome, false);
    assert.equal((await c.post('/api/vault/unlock')).json.ok, true);
    c.prefs.markBackedUp(Date.now, evm);
    const before = fs.readFileSync(c.live, 'utf8');
    double.fail = 'addMarker=-25308';
    const restored = await c.post('/api/vault/restore', { key: `0x${'11'.repeat(32)}` });
    double.fail = undefined;
    assert.equal(restored.json.code, 'keychain_unavailable', JSON.stringify(restored.json));
    assert.equal(fs.readFileSync(c.live, 'utf8'), before, 'the wallet file is byte for byte the one that was there');
    assert.equal(fs.existsSync(c.staged), false);
    c.keystore.lock();
    assert.equal((await c.post('/api/vault/unlock')).json.ok, true, 'and it still opens');
    assert.equal(c.keystore.addresses().evm, evm);
  } finally {
    await c.close();
  }
});

/* RA1B-02, the smaller effect: a committed file a crash left is put in place by the service's answer,
   never kept on a stale probe for the next staged file to write over. */
test('after a start-up probe that could not read the markers, what a crash left is settled by the service all the same', { skip }, async () => {
  const double = new VaultDouble();
  const b = await boot({ double });
  let bytes = '';
  try {
    await blobWallet(b);
    const made = double.run({ op: 'create' });
    const s = b.keystore.stageRewrap({ keyBlob: made.keyBlob as string, publicKey: made.publicKey as string, createdAt: new Date(T0 * 1000).toISOString() });
    assert.equal(double.run({ op: 'commit', ...material(s.request) }).ok, true, 'a bind stopped between its commit and its rename');
    bytes = s.bytes;
  } finally {
    await b.close();
  }

  double.fail = 'markers=-25308';
  const c = await boot({ double, dataDir: b.dataDir });
  double.fail = undefined;
  try {
    assert.equal(c.vault.capability()?.keychainHome, false, 'the start-up probe could not read the markers');
    assert.equal(await settleAtStart({ keystore: c.keystore, vault: c.vault, audit: c.audit }), 'installed');
    assert.equal(fs.readFileSync(c.live, 'utf8'), bytes, 'the committed file is in place');
    assert.equal(fs.existsSync(c.staged), false);
    assert.equal((await c.get('/api/vault')).json.enclave.binding, 'app');
    assert.equal((await c.post('/api/vault/unlock')).json.ok, true, 'and it opens');
  } finally {
    await c.close();
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

test('a new file the disk will not take is finished later when committed, and is gone when it was not', { skip }, async () => {
  let gate: Promise<void> | null = null;
  let release: () => void = () => {};
  const b = await boot({
    hook: async (r) => {
      if (r.op === 'unwrap' && r.reason === CREATE_REASON && gate !== null) await gate;
      return { kind: 'run' };
    },
  });
  try {
    const hold = (): void => {
      gate = new Promise<void>((r) => {
        release = r;
      });
    };
    // A build with no keychain home: nothing is committed, so a file that cannot be put in place is nothing.
    b.double.team = '';
    await b.probe();
    hold();
    let making = b.post('/api/vault/create');
    while (!fs.existsSync(b.staged)) await new Promise((r) => setTimeout(r, 10));
    fs.mkdirSync(b.live);
    release();
    let made = await making;
    assert.equal(made.json.code, 'write_failed', JSON.stringify(made.json));
    assert.equal(made.json.error, refusal('write_failed').error);
    assert.equal(fs.existsSync(b.staged), false);
    fs.rmdirSync(b.live);

    // A Developer ID build: the commit landed, so the staged file is the wallet, and the next step puts it in place.
    b.double.team = TEAM;
    await b.probe();
    hold();
    making = b.post('/api/vault/create');
    while (!fs.existsSync(b.staged)) await new Promise((r) => setTimeout(r, 10));
    fs.mkdirSync(b.live);
    release();
    made = await making;
    assert.equal(made.json.code, 'install_pending', JSON.stringify(made.json));
    assert.equal(fs.existsSync(b.staged), true);
    assert.equal(b.double.state().markers.length, 1);
    fs.rmdirSync(b.live);
    gate = null;
    assert.equal((await b.post('/api/vault/create')).status, 409, 'the committed wallet was put in place first, so there is one');
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(statusOf(b, liveRequest(b)).pinMatches, true);
  } finally {
    release();
    await b.close();
  }
});

test('a staged file the enclave will not open is refused as such, and nothing changes', { skip }, async () => {
  const b = await boot({ hook: (r) => (r.op === 'unwrap' && r.reason === BIND_REASON ? { kind: 'answer', answer: { ok: false, error: 'crypto_failed', message: 'x' } } : { kind: 'run' }) });
  try {
    await blobWallet(b);
    b.prefs.markBackedUp();
    const before = fs.readFileSync(b.live, 'utf8');
    const got = await b.post('/api/vault/bind');
    assert.equal(got.json.code, 'proof_failed');
    assert.equal(got.json.error, refusal('proof_failed').error);
    assert.equal(fs.readFileSync(b.live, 'utf8'), before);
    assert.equal(fs.existsSync(b.staged), false);
    assert.equal(b.double.state().markers.length, 0);
  } finally {
    await b.close();
  }
});

test('every refusal the bind can give is said in plain words', () => {
  for (const code of ['wallet_locked', 'not_enclave', 'no_keychain_home', 'bind_busy', 'touch_waiting', 'install_pending', 'proof_failed', 'write_failed', 'no_wallet', 'not_backed_up', 'keychain_unavailable', 'user_cancel']) {
    const said = String(refusal(code).error);
    assert.notEqual(said, 'That did not work.', code);
    assert.ok(!/marker|\bpin\b|\btag\b|group|commit|sweep|entitlement|stag(ed|ing)|blob|-\d{4,5}/i.test(said), `${code}: ${said}`);
  }
  assert.ok(BIND_REASON.length <= 120 && /^[A-Z]/.test(BIND_REASON));
});

test('no shipped source, and no script that builds or signs what ships, names the test double or its switches', async () => {
  // What the app carries: the payload (scripts/payload-digest.ts), the shell and the service.
  const { PAYLOAD } = await import('../../scripts/payload-digest.ts');
  const shipped = [...(PAYLOAD as string[]).filter((p) => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isDirectory()), 'src-tauri/src', 'src-tauri/se-helper'];
  const builders = ['scripts/build-se-helper.sh', 'scripts/bundle-payload.ts', 'scripts/notarize-mac.sh', 'scripts/sign-and-notarize-local.sh'];
  const named = /vault-double|VaultTestPlatform|PHOSPHOR_TEST_STORE|PHOSPHOR_TESTSEAM|tests\/swift/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js|rs|swift|sh|c|h|json|plist)$/.test(entry.name) && named.test(fs.readFileSync(full, 'utf8')) && !full.endsWith('se-helper/main.swift')) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  for (const dir of shipped) walk(path.join(ROOT, dir));
  for (const script of builders) if (fs.existsSync(path.join(ROOT, script)) && named.test(fs.readFileSync(path.join(ROOT, script), 'utf8'))) offenders.push(script);
  assert.deepEqual(offenders, []);
  // main.swift names the flag in one #if, and builds the stand-in nowhere else (vault-service.test.ts holds the rest).
  assert.equal(fs.readFileSync(path.join(ROOT, 'src-tauri/se-helper/main.swift'), 'utf8').split('PHOSPHOR_TESTSEAM').length, 3);
});

// ---------- the crash matrix: real backends, killed at each step of a bind and a restore ----------

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
   the handshake the shell gives it, and the test playing the shell over HTTP. It runs in demo mode,
   which makes no keys (src/vault/relay.ts, makesKeys) unless told it may, as a test run from a
   checkout can be: `keys: false` is the demo as an installed app runs it. */
async function backend(dir: string, double: VaultDouble, hook?: (r: Request) => Hook | Promise<Hook>, opts: { keys?: boolean } = {}): Promise<Backend> {
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
      ...(opts.keys === false ? {} : { PHOSPHOR_DEMO_ENCLAVE: '1' }),
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
  // Up once the shell's probe has answered: ready, or for a demo that makes no keys, a capability.
  for (let i = 0; i < 100; i += 1) {
    const enclave = (await get('/api/vault')).json?.enclave;
    if (opts.keys === false ? enclave?.capability != null : enclave?.ready === true) break;
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

/* audit1b AU1B-02: one marker in the group refuses every device-bound wallet on the Mac, so a demo
   of a signed release, run before the owner's own wallet is Phosphor-only, must write nothing there.
   The real backend in demo mode, as the shell starts it, against the service's own rules with a
   keychain home: every step that would make a key is refused before the shell sees it, and the
   window is offered the password path. */
test('a demo backend writes nothing to the keychain home: create, restore, the move from a password and the bind leave it empty', { skip, timeout: 60_000 }, async () => {
  const dir = tempDir('phosphor-demo-keys-');
  const double = new VaultDouble(path.join(dir, 'keychain.json'));
  const app = await backend(dir, double, undefined, { keys: false });
  try {
    const vault = (await app.get('/api/vault')).json;
    assert.equal(vault.enclave.capability?.keychainHome, true, 'the service under test has a keychain home, as a signed release does');
    assert.equal(vault.enclave.ready, false, 'a demo was offered a Touch ID wallet');
    const key = `0x${crypto.randomBytes(32).toString('hex')}`;
    assert.equal((await app.post('/api/vault/create')).json.code, 'enclave_unavailable');
    assert.equal((await app.post('/api/vault/restore', { key })).json.code, 'enclave_unavailable');
    // The demo's own wallet is a password wallet, and nothing moves it behind a new key.
    const password = 'a long enough password';
    assert.equal((await app.post('/api/wallet/create', { password })).json.ok, true);
    assert.equal((await app.post('/api/vault/migrate', { password })).json.code, 'enclave_unavailable');
    assert.equal((await app.post('/api/vault/restore', { key })).json.code, 'enclave_unavailable');
    assert.equal((await app.post('/api/vault/bind')).json.code, 'not_enclave');
  } finally {
    await app.stop();
  }
  assert.deepEqual(app.shell.seen.filter((r) => r.op === 'create' || r.op === 'commit' || r.op === 'sweep').map((r) => r.op), [], 'the shell was handed a write');
  const mac = double.state();
  assert.deepEqual([mac.keys.length, mac.markers.length], [0, 0], 'the keychain home holds a key or a marker');
  assert.deepEqual(mac.calls.filter((c) => /^(makeKey|addMarker|deleteKey)/.test(c)), []);
});

test('the crash matrix: a bind and a restore killed before the commit, between commit and rename, and after the rename open correctly on the next start', { skip, timeout: 300_000 }, async () => {
  type Point = 'before commit' | 'between commit and rename' | 'after rename';
  for (const flow of ['bind', 'restore'] as const) {
    for (const point of ['before commit', 'between commit and rename', 'after rename'] as Point[]) {
      const at = `${flow}, ${point}`;
      const dir = tempDir('phosphor-crash-');
      const double = new VaultDouble(path.join(dir, 'keychain.json'));
      const live = path.join(dir, 'keys', 'keys.enc.json');
      const staged = path.join(dir, 'keys', 'keys.enc.json.bind');

      // A device-bound wallet, made the way 0.10.14 made Karim's, backed up.
      double.team = '';
      let app = await backend(dir, double);
      const made = await app.post('/api/vault/create');
      assert.equal(made.json.ok, true, at);
      const revealed = await app.post('/api/vault/reveal');
      const words = revealed.json.words as string[];
      assert.equal((await app.post('/api/vault/backup-proven', { words: (revealed.json.prove as number[]).map((index) => ({ index, word: words[index] })) })).json.ok, true);
      await app.stop();
      const blob = fs.readFileSync(live, 'utf8');
      const address = made.json.addresses.evm as string;
      assert.ok(!JSON.parse(blob).header.enclave.keyBlob.startsWith('keychain:'), 'a device-bound wallet');

      // The Developer ID build starts, the wallet opens, and the step is killed at `point`. The
      // restore brings back the same wallet from its own words (a demo backend never puts one wallet
      // in the place of another); what is under test is the file that replaces the live one.
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
      assert.equal((await app.post('/api/vault/unlock')).json.ok, true, `${at}: the device-bound wallet opens on the Developer ID build`);
      const step = flow === 'bind' ? app.post('/api/vault/bind') : app.post('/api/vault/restore', { mnemonic: words.join(' ') });
      await step.catch(() => null);
      while (!killed) await new Promise((r) => setTimeout(r, 20));
      await killing;

      const markers = double.state().markers.length;
      if (point === 'before commit') {
        assert.equal(fs.readFileSync(live, 'utf8'), blob, `${at}: the live file is untouched`);
        assert.equal(fs.existsSync(staged), true);
        assert.equal(markers, 0);
      } else if (point === 'between commit and rename') {
        assert.equal(fs.readFileSync(live, 'utf8'), blob, `${at}: the live file is untouched`);
        assert.equal(fs.existsSync(staged), true);
        assert.equal(markers, 1);
      } else {
        assert.notEqual(fs.readFileSync(live, 'utf8'), blob, `${at}: the new file is in place`);
        assert.equal(fs.existsSync(staged), false);
        assert.equal(markers, 1);
      }

      // The next start: the shell's probe settles what was left, and the next open opens the right file.
      app = await backend(dir, double);
      try {
        const opened = await app.post('/api/vault/unlock');
        assert.equal(opened.json.ok, true, `${at}: ${JSON.stringify(opened.json)}`);
        assert.equal(fs.existsSync(staged), false, `${at}: nothing staged is left`);
        const file = JSON.parse(fs.readFileSync(live, 'utf8'));
        assert.equal(String(file.header.addresses.evm).toLowerCase(), address.toLowerCase(), `${at}: the same wallet`);
        const bound = String(file.header.enclave.keyBlob).startsWith('keychain:');
        assert.equal(bound, point !== 'before commit', `${at}: the new file is in place exactly when its commit landed`);

        if (point === 'before commit') {
          // Asked again, it goes through: the Mac is bound from here on.
          const again = flow === 'bind' ? await app.post('/api/vault/bind') : await app.post('/api/vault/restore', { mnemonic: words.join(' ') });
          assert.equal(again.json.ok, true, `${at}: ${JSON.stringify(again.json)}`);
        }
        // No orphan key past a sweep: once every key made in this run is past its first minutes,
        // the keychain holds the bound key and its marker, and nothing else.
        double.now = T0 + 3600;
        const swept = double.run({ op: 'sweep' });
        assert.equal(swept.ok, true, JSON.stringify(swept));
        const left = double.state();
        const current = JSON.parse(fs.readFileSync(live, 'utf8')).header.enclave.keyBlob.slice('keychain:'.length);
        assert.deepEqual(left.keys.map((k) => k.tag), [current], `${at}: one key, the bound one`);
        assert.deepEqual(left.markers.map((m) => m.tag), [current], `${at}: one marker, for it`);
        const pin = double.run({ op: 'status', ...material(liveRequestOf(live)) });
        assert.equal(pin.pinMatches, true, `${at}: the file in place is the committed one`);
      } finally {
        await app.stop();
      }
    }
  }
});

/* The request the backend sends for the file at `live`, built by the app's own keystore. */
function liveRequestOf(live: string): EnclaveUnwrapRequest {
  const keystore: Keystore = createKeystore({ keysPath: path.join(path.dirname(live), 'keys.json'), kdf: fast });
  return keystore.enclaveRequest()!;
}
