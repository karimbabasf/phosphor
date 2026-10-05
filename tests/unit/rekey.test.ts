// The move to the chip and the restore, through the window's own routes (src/http/chip.ts) on a
// real server, keystore, relay and journal, against the vault service's own rules with a stand-in
// keychain and enclave (tests/unit/helpers/vault-double.ts) and the chain double
// (tests/unit/helpers/intents-double.ts). No Touch ID: the stand-in records every touch and the
// sentence each chip signature's dialog would have shown.
//
// What it holds the rekey to: C7's five events before anything is sent, the four views before
// the window says done, then vault.json and the owner key out of the session; a restore that needs
// the key backup and the paper; nothing signed before the checks a touch would waste; and no word
// of a paper key in the data folder, a frame or /api/state after any step.
//
// Run: node --test tests/unit/rekey.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { english } from 'viem/accounts';

import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { base58Encode } from '../../src/chain/near.ts';
import { createKeystore, isOwnerTouchRequired, useKeystore } from '../../src/keystore/index.ts';
import type { Keystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import type { IntentsRead } from '../../src/ledger/intents.ts';
import { createMarketData } from '../../src/market/index.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import type { VerifierEvent } from '../../src/relay/verifier.ts';
import { createServer } from '../../src/server.ts';
import { createStore } from '../../src/store.ts';
import { createTradeView } from '../../src/trade/view.ts';
import type { AppConfig, LedgerSnapshot, Proposal, SendParams } from '../../src/types.ts';
import { createAccounts } from '../../src/vault/accounts.ts';
import type { AccountsPort } from '../../src/vault/accounts.ts';
import { chipStatusReader, ownerKeyGate } from '../../src/vault/chip.ts';
import { paperKeyOf } from '../../src/vault/phrase24.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import type { VaultPrefs } from '../../src/vault/prefs.ts';
import { MOVE_VAULT_REASON, RESTORE_REASON, RESTORE_VAULT_REASON, UNLOCK_REASON } from '../../src/vault/reason.ts';
import { paperProbe, useChipVault } from '../../src/vault/rekey.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { VaultRelay } from '../../src/vault/relay.ts';
import { createVaultSubmitter, fileJournal, journalPathFor } from '../../src/vault/submit.ts';
import type { VaultSubmitter } from '../../src/vault/submit.ts';
import { stubView } from '../fixtures/view.ts';
import { SALT_HEX, createIntentsDouble } from './helpers/intents-double.ts';
import type { IntentsDouble, Send } from './helpers/intents-double.ts';
import { tempDir } from './helpers/tmp.ts';
import { T0, VaultDouble, relayTo, swiftc } from './helpers/vault-double.ts';
import type { Answer, Hook, Request } from './helpers/vault-double.ts';

const skip = swiftc ? false : 'needs macOS with swiftc';

/* Two paper keys made of words no sentence of this app writes, so a search for any one word in the
   data folder is exact. Picked by their place in the BIP39 list, with checksums that hold; the file
   carries no phrase a secret sweep would read as one. */
const PAPER_A = [2047, 1022, 1343, 1392, 574, 1389, 2044, 766, 1026, 296, 1152, 804, 1522, 1266, 1046, 1233, 315, 250, 1824, 784, 1816, 1533, 953, 270].map((i) => english[i]).join(' ');
const PAPER_B = [1283, 1255, 407, 784, 270, 574, 1303, 415, 1879, 1974, 1410, 1409, 1409, 873, 1392, 1295, 245, 521, 1233, 805, 1522, 873, 552, 1389].map((i) => english[i]).join(' ');
const HALF_NEAR = 500_000_000_000_000_000_000_000n;
const CHIP_SENTENCE = "confirm this Mac's Touch ID key for your vault";

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

function snapshot(): LedgerSnapshot {
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices: {} };
}

test.afterEach(() => {
  useChipVault(null);
  useKeystore(null);
});

type App = {
  dataDir: string;
  keystore: Keystore;
  relay: VaultRelay;
  prefs: VaultPrefs;
  accounts: AccountsPort;
  submitter: VaultSubmitter;
  mac: VaultDouble;
  shell: ReturnType<typeof relayTo>;
  sends: SendParams[];
  // The owner key gate src/main.ts gives the keystore: vault.json, then a marker the chain confirms.
  gate: (vault: string) => boolean;
  frames(): string;
  post(route: string, body?: Record<string, unknown>): Promise<{ status: number; json: any }>;
  postBare(route: string, body: Record<string, unknown>): Promise<{ status: number; json: any }>;
  get(route: string): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
};

/* One Mac, wired the way src/main.ts wires it: the keystore with its owner key gate, the relay, the
   accounts the rails read, one vault move submitter over a journal in the data folder, and the chip
   vault installed over the chain double. The shell is the test, relaying to the stand-in service
   with its clock held to the chain's. `papers` are the paper keys /chip/phrase hands out, in order. */
async function chipApp(chain: IntentsDouble, opts: { mac?: VaultDouble; papers?: string[]; dataDir?: string; hook?: (r: Request) => Hook | undefined; near?: IntentsDouble['near']; intents?: () => IntentsRead | undefined } = {}): Promise<App> {
  const dataDir = opts.dataDir ?? tempDir('phosphor-rekey-');
  const token = crypto.randomBytes(32).toString('hex');
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'live', kdf: fast });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const relaySecret = crypto.randomBytes(32).toString('hex');
  const relay = createVaultRelay({ transportKey: transport, secret: relaySecret });
  const cfg: AppConfig = { mode: 'live', port: 0, addresses: {}, candleProducts: ['BTC-USD'], dataDir, keysPath };
  const prefs = createVaultPrefs(dataDir);
  const gate = ownerKeyGate(() => prefs.get(), relay, chain.verifier);
  keystore.keepOwnerKeyOutWhen(gate);
  const accounts = createAccounts({ keystore, prefs, chipStatus: chipStatusReader(relay) });
  const submitter = createVaultSubmitter({
    verifier: chain.verifier,
    gasSeed: () => keystore.gasSeed(),
    gasAccount: () => keystore.derivedAccounts()?.gas ?? null,
    journal: fileJournal(journalPathFor(dataDir)),
    near: chain.near,
    now: chain.now,
    sleep: chain.near.sleep,
  });
  const papers = [...(opts.papers ?? [])];
  useChipVault({
    verifier: chain.verifier,
    submitter,
    accounts,
    // The Vault tab's reads of the gas account, which a test may hold; the submitter keeps its own.
    near: opts.near ?? chain.near,
    now: chain.now,
    newPhrase: () => {
      const next = papers.shift();
      if (next === undefined) throw new Error('the test has no paper key left to hand out');
      return next;
    },
    reads: true,
    pollMs: 20,
  });
  const sends: SendParams[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const server = createServer({
    cfg,
    token,
    vault: relay,
    intentsReceive: async () => ({ account: keystore.addressReport().addresses.evm, verified: keystore.addressReport().verified, tampered: false, networks: [] }),
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    keystore,
    riskRows: [],
    ledger: { snapshot, intents: () => opts.intents?.(), hyperliquid: () => undefined, refresh: async () => snapshot() },
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals: {
      proposePolicyChange: unused,
      proposeSwap: unused,
      proposeHlDeposit: unused,
      proposeHlWithdraw: unused,
      proposeSend: async (params) => {
        sends.push(params);
        return { id: `p-${sends.length}`, status: 'pending' } as Proposal;
      },
      proposeTrade: unused,
      proposeTradeChange: unused,
      approve: unused,
      refuse: unused,
      get: () => undefined,
      list: () => [],
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
  async function send(route: string, body: Record<string, unknown>) {
    const res = await fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  async function get(route: string) {
    const res = await fetch(`${url}${route}`, { headers: { origin: url, 'x-phosphor-token': token } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  // Every frame the window would get, as text.
  let frameText = '';
  const tap = new AbortController();
  const events = await fetch(`${url}/api/events`, { headers: { origin: url, 'x-phosphor-token': token }, signal: tap.signal });
  void (async () => {
    try {
      const reader = events.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        frameText += Buffer.from(value).toString('utf8');
      }
    } catch {
      // the tap closed
    }
  })();

  const mac = opts.mac ?? new VaultDouble();
  mac.now = Math.floor(chain.now() / 1000);
  const shell = relayTo((route, body) => send(route, { relay: relaySecret, ...body }), mac, transport, (r) => {
    mac.now = Math.floor(chain.now() / 1000);
    return opts.hook?.(r) ?? { kind: 'run' };
  });
  // src/main.ts's start: the probe, then the chip markers right behind it, whose answer asks the
  // gate about this wallet's vault; without it no marker is known and the chain alone decides (FA-1).
  const probing = relay.ask({ op: 'probe' });
  const marking = relay.ask({ op: 'chipStatus' }).then(() => {
    const evm = keystore.addresses().evm;
    if (evm !== null) gate(evm);
  });
  const probed = await probing;
  assert.ok(probed.ok, JSON.stringify(probed));
  await marking;
  return {
    dataDir,
    keystore,
    relay,
    prefs,
    accounts,
    submitter,
    mac,
    shell,
    sends,
    gate,
    frames: () => frameText,
    post: (route, body = {}) => send(route, { token, ...body }),
    postBare: send,
    get,
    close: async () => {
      tap.abort();
      relay.stop();
      await shell.stop();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      useKeystore(null);
    },
  };
}

/* A Touch ID wallet made on this Mac by the window's own route, opened, its backup proven, and its
   gas account funded on the chain: what the move starts from. */
async function wallet(app: App, chain: IntentsDouble, opts: { gas?: bigint | null } = {}): Promise<string> {
  const made = await app.post('/api/vault/create');
  assert.equal(made.json.ok, true, JSON.stringify(made.json));
  if (app.keystore.state() !== 'unlocked') assert.equal((await app.post('/api/vault/unlock')).json.ok, true);
  const vault = made.json.addresses.evm.toLowerCase();
  app.prefs.markBackedUp(Date.now, vault);
  const gas = app.keystore.derivedAccounts()?.gas;
  assert.ok(gas !== undefined);
  if (opts.gas !== null) chain.fundGas(gas, opts.gas ?? HALF_NEAR);
  return vault;
}

async function settled(app: App, run: string): Promise<string> {
  for (let i = 0; i < 1000; i += 1) {
    const chip = (await app.get('/api/state')).json.vault.chip;
    if (chip.run?.id === run && (chip.run.status === 'done' || chip.run.status === 'failed')) return chip.run.reason === null ? chip.run.status : `${chip.run.status} ${chip.run.reason}`;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the move did not end');
}

async function chipState(app: App): Promise<any> {
  return (await app.get('/api/state')).json.vault.chip;
}

// The paper shown, typed back whole, and the move started: the window's three posts.
async function migrate(app: App, paper: string): Promise<{ run: string; result: string }> {
  const shown = await app.post('/api/vault/chip/phrase');
  assert.deepEqual(shown.json.words, paper.split(' '));
  const proven = await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words });
  assert.equal(proven.json.ok, true, JSON.stringify(proven.json));
  const moved = await app.post('/api/vault/chip/move');
  assert.equal(moved.status, 202, JSON.stringify(moved.json));
  return { run: moved.json.run, result: await settled(app, moved.json.run) };
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/* Every place a word of the paper or its key could be: each of the 24 words as a word, and the
   paper's private key as hex, base64 and base58. */
function leaksIn(texts: { name: string; text: string }[], paper: string): string[] {
  const words = paper.split(' ');
  const key = paperKeyOf(paper).key;
  const encodings = [key.toString('hex'), key.toString('base64'), base58Encode(key)];
  key.fill(0);
  const found: string[] = [];
  for (const { name, text } of texts) {
    for (const w of words) if (new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'i').test(text)) found.push(`${name}: the word ${w}`);
    for (const e of encodings) if (text.includes(e) || text.toLowerCase().includes(e.toLowerCase())) found.push(`${name}: the paper key`);
  }
  return found;
}

async function noLeak(app: App, paper: string, step: string): Promise<void> {
  const texts = filesUnder(app.dataDir).map((f) => ({ name: path.relative(app.dataDir, f), text: fs.readFileSync(f, 'utf8') }));
  texts.push({ name: 'frames', text: app.frames() }, { name: '/api/state', text: JSON.stringify((await app.get('/api/state')).json) });
  assert.deepEqual(leaksIn(texts, paper), [], `after ${step}`);
}

function names(events: readonly VerifierEvent[]): string[] {
  return events.map((e) => (e.event === 'set_auth_by_predecessor_id' ? `${e.event}:${e.data.enabled}` : e.event === 'intents_executed' ? `${e.event}(${e.data.length})` : e.event));
}

const touchesOf = (app: App, from = 0): string[] => app.shell.seen.slice(from).filter((r) => r.op === 'unwrap' || r.op === 'signIntent').map((r) => (r.op === 'unwrap' ? `unwrap: ${r.reason}` : 'signIntent'));
const chipKeysIn = (mac: VaultDouble): number => mac.state().keys.filter((k) => k.tag.startsWith('com.karimbabasf.phosphor.chip.')).length;

test('the move to the chip through the window: two Touch IDs, C7\'s five events, the four views, then vault.json, and no word of the paper anywhere', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const app = await chipApp(chain, { papers: [PAPER_A] });
  try {
    const vault = await wallet(app, chain);
    const old = (await import('../../src/vault/phrase24.ts')).verifierKeyOf(Buffer.from(app.keystore.evmPrivateKey().slice(2), 'hex'));
    await noLeak(app, PAPER_A, 'the wallet was made');
    const ready = await chipState(app);
    assert.equal(ready.paper, 'none');

    const shown = await app.post('/api/vault/chip/phrase');
    assert.equal(shown.status, 200);
    assert.deepEqual(shown.json.words, PAPER_A.split(' '), 'the 24 words, once, to the window that asked');
    await noLeak(app, PAPER_A, 'the paper was shown');
    assert.equal((await chipState(app)).paper, 'shown');

    // A slip: a real paper key, but not this one. The answer names no word.
    const slip = await app.post('/api/vault/chip/phrase-proven', { words: PAPER_B.split(' ') });
    assert.equal(slip.json.code, 'wrong_words');
    assert.deepEqual(leaksIn([{ name: 'answer', text: JSON.stringify(slip.json) }], PAPER_B), []);
    // Not 24 words, or a checksum that fails: no paper key at all.
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words.slice(0, 23) })).json.code, 'bad_paper');
    const swapped = [...shown.json.words];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: swapped })).json.code, 'bad_paper');

    const proven = await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words });
    assert.equal(proven.json.ok, true);
    assert.equal(proven.json.recovery, paperKeyOf(PAPER_A).publicKey);
    await noLeak(app, PAPER_A, 'the paper was typed back');
    const held = paperProbe(app.keystore);
    assert.ok(held !== null && held() === false, 'the paper key is held, not yet zeroed');
    assert.equal((await chipState(app)).paper, 'proven');

    let simulated: VerifierEvent[] = [];
    chain.faults.simulate = (sim) => {
      if (sim.ok) simulated = sim.events ?? [];
      return sim;
    };
    const from = app.shell.seen.length;
    const moved = await app.post('/api/vault/chip/move');
    assert.equal(moved.status, 202);
    assert.equal(await settled(app, moved.json.run), 'done');
    await noLeak(app, PAPER_A, 'the move');

    // C7's five events on P_a's hash, checked before anything was sent.
    assert.deepEqual(names(simulated), ['public_key_added', 'public_key_added', 'public_key_removed', 'set_auth_by_predecessor_id:false', 'intents_executed(3)']);
    // Two Touch IDs: the owner key's, with the app's sentence, and the chip's, with the service's.
    assert.deepEqual(touchesOf(app, from), [`unwrap: ${MOVE_VAULT_REASON}`, 'signIntent']);
    assert.deepEqual(app.mac.dialogs(), [CHIP_SENTENCE]);
    // The four views.
    const chip = app.prefs.get().chip;
    assert.ok(chip !== null);
    assert.equal(chip.account, vault);
    assert.equal(chain.hasKey(vault, chip.publicKey), true, 'the chip key is on the vault');
    assert.equal(chain.hasKey(vault, paperKeyOf(PAPER_A).publicKey), true, 'the paper key is on the vault');
    assert.equal(chain.hasKey(vault, old), false, 'the owner key is off the vault');
    assert.equal(chain.predecessorAuth(vault), false, 'predecessor auth is off');
    assert.equal(chain.executions(), 1);
    // vault.json written, the rails on the allowance, the owner key out of the session.
    assert.equal(app.accounts.accounts().kind, 'chip');
    assert.throws(() => app.keystore.evmPrivateKey(), (err: unknown) => isOwnerTouchRequired(err));
    assert.equal(held(), true, 'the paper key was zeroed once it signed');

    const done = await chipState(app);
    assert.equal(done.state, 'done');
    assert.equal(done.paper, 'none');
    assert.deepEqual(done.pins, { vault, allowance: app.keystore.derivedAccounts()!.allowance, recovery: paperKeyOf(PAPER_A).publicKey });
    // Frames, in order, for the window that watched.
    const statuses = [...app.frames().matchAll(/"type":"chip","kind":"chip","run":"[0-9a-f]+","status":"([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(statuses)], ['creating', 'touch_old', 'touch_chip', 'simulating', 'done']);
    // The chain facts the Vault tab shows, read again once the move ended.
    let facts = done;
    for (let i = 0; i < 100 && facts.recoveryOnChain !== true; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      facts = await chipState(app);
    }
    assert.deepEqual([facts.recoveryOnChain, facts.oldOnChain, facts.predecessorAuth], [true, false, false]);
    assert.equal(facts.gas.account, app.keystore.derivedAccounts()!.gas);
    await noLeak(app, PAPER_A, 'the state was read');
  } finally {
    await app.close();
  }
});

test('the moment the move ends, no fact read before it reaches the tab: every key and the NEAR door, this Mac\'s Touch ID key included, wait for a read begun after it', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  // From the chip's Touch ID on, the tab's read of the gas account waits: a slow read after the move.
  let holding = false;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const near = {
    ...chain.near,
    fetchImpl: (async (url: string, init: { body: string }) => {
      if (holding && (JSON.parse(init.body) as { params?: { request_type?: string } }).params?.request_type === 'view_account') await held;
      return chain.near.fetchImpl(url, init as RequestInit);
    }) as unknown as typeof fetch,
  };
  const app = await chipApp(chain, { papers: [PAPER_A], near, hook: (r) => { if (r.op === 'signIntent') holding = true; return undefined; } });
  const facts = (c: any): unknown[] => [c.chipOnChain, c.recoveryOnChain, c.oldOnChain, c.predecessorAuth, c.otherKeys];
  try {
    await wallet(app, chain);
    // Before the move the tab reads the wallet's own key on the vault and the NEAR door open.
    let before = await chipState(app);
    for (let i = 0; i < 100 && before.oldOnChain !== true; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      before = await chipState(app);
    }
    assert.deepEqual(facts(before), [null, null, true, true, null]);
    assert.equal((await migrate(app, PAPER_A)).result, 'done');
    // Done, and the only read in hand began before it: nothing it says reaches the tab.
    const done = await chipState(app);
    assert.equal(done.state, 'done');
    assert.deepEqual(facts(done), [null, null, null, null, null]);
    release();
    let after = done;
    for (let i = 0; i < 300 && after.chipOnChain !== true; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      after = await chipState(app);
    }
    // A read begun after the move: this Mac's Touch ID key from NEAR too.
    assert.deepEqual(facts(after), [true, true, false, false, []]);
  } finally {
    release();
    await app.close();
  }
});

test('a restore on a new Mac takes the key backup and the paper: the paper signs, the old chip and the paper go, a new chip and a new paper come', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const a = await chipApp(chain, { papers: [PAPER_A] });
  let vault = '';
  let mnemonic = '';
  let chipA = '';
  let old = '';
  try {
    vault = await wallet(a, chain);
    old = (await import('../../src/vault/phrase24.ts')).verifierKeyOf(Buffer.from(a.keystore.evmPrivateKey().slice(2), 'hex'));
    const revealed = await a.post('/api/vault/reveal');
    assert.equal(revealed.json.ok, true);
    mnemonic = revealed.json.words.join(' ');
    assert.equal((await migrate(a, PAPER_A)).result, 'done');
    chipA = a.prefs.get().chip!.publicKey;
  } finally {
    await a.close();
  }

  // The new Mac: its own keychain and data folder, the same chain.
  const b = await chipApp(chain, { papers: [PAPER_B] });
  try {
    const restored = await b.post('/api/vault/restore', { mnemonic });
    assert.equal(restored.json.ok, true, JSON.stringify(restored.json));
    if (b.keystore.state() !== 'unlocked') assert.equal((await b.post('/api/vault/unlock')).json.ok, true);
    assert.equal(b.keystore.addresses().evm?.toLowerCase(), vault);
    // The key backup alone no longer reaches the vault: the Vault tab offers the restore.
    let first = await chipState(b);
    for (let i = 0; i < 100 && first.oldOnChain !== false; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      first = await chipState(b);
    }
    assert.equal(first.state, 'broken');
    assert.equal(first.oldOnChain, false);

    // A move from here is refused before any touch: the owner key is no longer on the vault.
    const shown = await b.post('/api/vault/chip/phrase');
    assert.deepEqual(shown.json.words, PAPER_B.split(' '));
    assert.equal((await b.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    // The paper being written cannot also be the paper the restore retires.
    assert.equal((await b.post('/api/vault/chip/restore', { words: PAPER_B.split(' ') })).json.code, 'same_paper');
    await noLeak(b, PAPER_B, 'the new paper was proven');

    let simulated: VerifierEvent[] = [];
    chain.faults.simulate = (sim) => {
      if (sim.ok) simulated = sim.events ?? [];
      return sim;
    };
    const from = b.shell.seen.length;
    const started = await b.post('/api/vault/chip/restore', { words: PAPER_A.split(' ') });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    assert.equal(await settled(b, started.json.run), 'done');
    await noLeak(b, PAPER_A, 'the restore');
    await noLeak(b, PAPER_B, 'the restore');

    // One Touch ID, the new chip's: the paper is the old signer, and this session held the owner
    // key, so its public half needed no touch.
    assert.deepEqual(touchesOf(b, from), ['signIntent']);
    assert.deepEqual(b.mac.dialogs(), [CHIP_SENTENCE]);
    // Added the chip and the new paper, removed the old chip and the old paper; no set_auth event,
    // because predecessor auth was already off.
    assert.deepEqual(names(simulated), ['public_key_added', 'public_key_added', 'public_key_removed', 'public_key_removed', 'intents_executed(3)']);
    const chipB = b.prefs.get().chip!.publicKey;
    assert.notEqual(chipB, chipA);
    for (const [key, is] of [[chipB, true], [paperKeyOf(PAPER_B).publicKey, true], [old, false], [chipA, false], [paperKeyOf(PAPER_A).publicKey, false]] as const) {
      assert.equal(chain.hasKey(vault, key), is, key);
    }
    assert.equal(chain.predecessorAuth(vault), false);
    assert.equal(b.accounts.accounts().kind, 'chip');
    assert.throws(() => b.keystore.evmPrivateKey(), (err: unknown) => isOwnerTouchRequired(err));
  } finally {
    await b.close();
  }
});

/* Session S's restore (fix2b d5f88678; reaudit2 RA2-03): a second data folder on the same keychain
   sees the vault's chip marker, so the owner key stays out of its session, while the unlock has read
   the key's public half (Keystore.ownerPublicKey). The restore still asks its own Touch ID for that
   half, "Restore your vault ...", before the new chip's, as the sheet says: the half an unlock read
   counts only for resumeChip's verdict. */
test('a restore with the owner key out of the session asks its own Restore your vault Touch ID before the chip\'s', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const a = await chipApp(chain, { papers: [PAPER_A] });
  let vault = '';
  let mnemonic = '';
  try {
    vault = await wallet(a, chain);
    const revealed = await a.post('/api/vault/reveal');
    assert.equal(revealed.json.ok, true);
    mnemonic = revealed.json.words.join(' ');
    assert.equal((await migrate(a, PAPER_A)).result, 'done');
  } finally {
    await a.close();
  }

  const b = await chipApp(chain, { mac: a.mac, papers: [PAPER_B] });
  try {
    assert.equal((await b.post('/api/vault/restore', { mnemonic })).json.ok, true);
    if (b.keystore.state() !== 'unlocked') assert.equal((await b.post('/api/vault/unlock')).json.ok, true);
    assert.equal(b.keystore.addresses().evm?.toLowerCase(), vault);
    assert.throws(() => b.keystore.evmPrivateKey(), (err: unknown) => isOwnerTouchRequired(err), 'the owner key came into a session whose keychain holds the vault\'s chip marker');
    assert.notEqual(b.keystore.ownerPublicKey?.() ?? null, null, 'the unlock did not read the owner key\'s public half');
    const shown = await b.post('/api/vault/chip/phrase');
    assert.equal((await b.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    const from = b.shell.seen.length;
    const started = await b.post('/api/vault/chip/restore', { words: PAPER_A.split(' ') });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    assert.equal(await settled(b, started.json.run), 'done');
    assert.deepEqual(touchesOf(b, from), [`unwrap: ${RESTORE_VAULT_REASON}`, 'signIntent']);
  } finally {
    await b.close();
  }
});

test('a restore with a paper that is not a key of the vault stops before the chip is asked', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const a = await chipApp(chain, { papers: [PAPER_A] });
  try {
    await wallet(a, chain);
    assert.equal((await migrate(a, PAPER_A)).result, 'done');
  } finally {
    await a.close();
  }
  const b = await chipApp(chain, { papers: [PAPER_B, PAPER_A] });
  try {
    await wallet(b, chain);
    const shown = await b.post('/api/vault/chip/phrase');
    assert.equal((await b.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    // PAPER_A is a key of the first Mac's vault, not of this one.
    const from = b.shell.seen.length;
    const started = await b.post('/api/vault/chip/restore', { words: PAPER_A.split(' ') });
    assert.equal(started.status, 202);
    assert.equal(await settled(b, started.json.run), 'failed not_your_paper');
    assert.deepEqual(touchesOf(b, from), [], 'no Touch ID');
    assert.equal(chipKeysIn(b.mac), 0, 'no chip key made');
  } finally {
    await b.close();
  }
});

test('the checks a Touch ID would waste come first: locked, no paper, no backup, no gas, and the routes want the window token', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const app = await chipApp(chain, { papers: [PAPER_A, PAPER_B] });
  try {
    const vault = await wallet(app, chain, { gas: null });
    // No paper typed back.
    assert.equal((await app.post('/api/vault/chip/move')).json.code, 'paper_needed');
    // No phrase on screen and none proven: nothing to type back.
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: PAPER_A.split(' ') })).json.code, 'phrase_gone');
    const shown = await app.post('/api/vault/chip/phrase');
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    // No backup proven.
    app.prefs.clearBackedUp();
    assert.equal((await app.post('/api/vault/chip/move')).json.code, 'not_backed_up');
    app.prefs.markBackedUp(Date.now, vault);
    // The gas account was never paid: refused before any key is made or any touch asked.
    const from = app.shell.seen.length;
    const unfunded = await app.post('/api/vault/chip/move');
    assert.equal(unfunded.status, 202);
    assert.equal(await settled(app, unfunded.json.run), 'failed gas_unfunded');
    // Under the purchase price of the gas a submit attaches.
    chain.fundGas(app.keystore.derivedAccounts()!.gas, 10_000_000_000_000_000_000_000n);
    const low = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, low.json.run), 'failed gas_low');
    assert.deepEqual(touchesOf(app, from), [], 'no Touch ID');
    assert.equal(chipKeysIn(app.mac), 0, 'no chip key made');
    assert.equal(chain.executions(), 0);
    // The window's token, and only the window's.
    for (const route of ['/api/vault/chip/phrase', '/api/vault/chip/phrase-proven', '/api/vault/chip/move', '/api/vault/chip/restore', '/api/vault/gas/fund']) {
      assert.equal((await app.postBare(route, {})).status, 403, route);
      assert.equal((await app.postBare(route, { token: 'f'.repeat(64) })).status, 403, route);
    }
    // Locked: nothing moves.
    assert.equal((await app.post('/api/lock')).json.ok, true);
    assert.equal((await app.post('/api/vault/chip/move')).json.code, 'wallet_locked');
    assert.equal((await app.post('/api/vault/chip/phrase')).json.code, 'wallet_locked');
    await noLeak(app, PAPER_A, 'the refusals');
  } finally {
    await app.close();
  }
});

test('a lock wipes a proven paper key, and after a restart the same paper typed again is checked against its public key', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const mac = new VaultDouble();
  const dataDir = tempDir('phosphor-rekey-restart-');
  const a = await chipApp(chain, { mac, dataDir, papers: [PAPER_A] });
  try {
    await wallet(a, chain);
    const shown = await a.post('/api/vault/chip/phrase');
    assert.equal((await a.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    const held = paperProbe(a.keystore)!;
    assert.equal((await a.post('/api/lock')).json.ok, true);
    assert.equal(held(), true, 'the lock zeroed the paper key');
  } finally {
    await a.close();
  }
  // A restart: a new process over the same data folder and the same Mac.
  const b = await chipApp(chain, { mac, dataDir });
  try {
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true);
    assert.equal((await chipState(b)).paper, 'retype');
    assert.equal((await b.post('/api/vault/chip/phrase-proven', { words: PAPER_B.split(' ') })).json.code, 'wrong_paper');
    assert.equal((await b.post('/api/vault/chip/phrase-proven', { words: PAPER_A.split(' ') })).json.ok, true);
    assert.equal((await chipState(b)).paper, 'proven');
    const moved = await b.post('/api/vault/chip/move');
    assert.equal(await settled(b, moved.json.run), 'done');
    await noLeak(b, PAPER_A, 'the move after a restart');
  } finally {
    await b.close();
  }
});

test('a phrase shown and never typed back before a restart is void: the window says so, and its words are refused', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const mac = new VaultDouble();
  const dataDir = tempDir('phosphor-rekey-void-');
  const a = await chipApp(chain, { mac, dataDir, papers: [PAPER_A] });
  try {
    await wallet(a, chain);
    assert.deepEqual((await a.post('/api/vault/chip/phrase')).json.words, PAPER_A.split(' '));
  } finally {
    await a.close();
  }
  const b = await chipApp(chain, { mac, dataDir, papers: [PAPER_B] });
  try {
    assert.equal((await b.post('/api/vault/unlock')).json.ok, true);
    assert.equal((await chipState(b)).paper, 'void');
    assert.equal((await b.post('/api/vault/chip/phrase-proven', { words: PAPER_A.split(' ') })).json.code, 'phrase_gone');
    assert.equal((await migrate(b, PAPER_B)).result, 'done');
  } finally {
    await b.close();
  }
});

test('either Touch ID cancelled sends nothing; the paper stays until it signs, and the next try finishes with the same chip', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  let cancel: 'unwrap' | 'signIntent' | null = null;
  const app = await chipApp(chain, {
    papers: [PAPER_A],
    hook: (r) => {
      if (cancel !== null && r.op === cancel && (r.op !== 'unwrap' || r.reason === MOVE_VAULT_REASON)) {
        cancel = null;
        return { kind: 'answer', answer: { ok: false, error: 'user_cancel', message: 'cancelled' } as Answer };
      }
      return undefined;
    },
  });
  try {
    const vault = await wallet(app, chain);
    const shown = await app.post('/api/vault/chip/phrase');
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    cancel = 'unwrap';
    const first = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, first.json.run), 'failed user_cancel');
    assert.equal((await chipState(app)).paper, 'proven', 'the paper did not sign, so it is still held');
    cancel = 'signIntent';
    const second = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, second.json.run), 'failed user_cancel');
    assert.equal((await chipState(app)).paper, 'proven');
    assert.equal(chain.executions(), 0, 'nothing ran');
    assert.equal(app.submitter.pending(vault).length, 0, 'nothing left this Mac');
    const third = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, third.json.run), 'done');
    assert.equal(chipKeysIn(app.mac), 1, 'one chip key, made once and used by every try');
    assert.equal(chain.executions(), 1);
  } finally {
    await app.close();
  }
});

test('a dry run the verifier refuses (its salt taken out) is written down: no new signature until it can never run, then a new chip finishes', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  let rotate = false;
  const app = await chipApp(chain, {
    papers: [PAPER_A],
    hook: (r) => {
      if (rotate && r.op === 'signIntent') {
        rotate = false;
        return { kind: 'after', edit: (a: Answer) => (chain.retireSalt(SALT_HEX), a) };
      }
      return undefined;
    },
  });
  try {
    const vault = await wallet(app, chain);
    const shown = await app.post('/api/vault/chip/phrase');
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    rotate = true;
    const first = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, first.json.run), 'failed simulate_refused');
    assert.deepEqual(app.submitter.pending(vault).map((e) => e.state), ['released'], 'the signed bundle is written down');
    assert.equal((await chipState(app)).paper, 'retype', 'the paper signed once and is gone');
    // Typed again; the bundle can still run until its deadline and two minutes: nothing is signed.
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: PAPER_A.split(' ') })).json.ok, true);
    const touches = app.mac.touches().length;
    const early = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, early.json.run), 'failed vault_settling');
    assert.equal(app.mac.touches().length, touches, 'no Touch ID while the earlier bundle may run');
    // Past it: its salt is gone, so whether it ran can never be read from its nonces; the vault's
    // keys say it did not, and the move goes on with a new chip.
    chain.advance(5 * 60_000);
    const later = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, later.json.run), 'done');
    assert.equal(chipKeysIn(app.mac), 2);
    assert.equal(chain.executions(), 1);
    assert.equal(chain.hasKey(vault, app.prefs.get().chip!.publicKey), true);
    assert.equal(chain.predecessorAuth(vault), false);
  } finally {
    await app.close();
  }
});

test('NEAR answering nothing after the send: the move reads checking, then done once the call is found by its hash', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const app = await chipApp(chain, { papers: [PAPER_A] });
  try {
    const vault = await wallet(app, chain);
    const lost: Send[] = [{ kind: 'lost', land: true }];
    chain.sends.push(...lost);
    const shown = await app.post('/api/vault/chip/phrase');
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    const moved = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, moved.json.run), 'done');
    const statuses = [...app.frames().matchAll(/"status":"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(statuses.includes('checking'), statuses.join(','));
    assert.equal(chain.executions(), 1, 'one call ran, however many copies were sent');
    assert.equal(app.prefs.get().chip?.account, vault);
  } finally {
    await app.close();
  }
});

test('a key someone adds to the vault while the move is being signed is caught after it: the vault moved, and the window is told it holds a key the move did not add', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  let vault = '';
  let stranger = '';
  let plant = false;
  const app = await chipApp(chain, {
    papers: [PAPER_A],
    hook: (r) => {
      // The owner key is still a key of the vault until the call runs: it adds one of its own
      // while the chip's Touch ID is up, after the last read before the signatures.
      if (plant && r.op === 'signIntent') {
        plant = false;
        chain.addKey(vault, stranger);
      }
      return undefined;
    },
  });
  try {
    vault = await wallet(app, chain);
    stranger = paperKeyOf(PAPER_B).publicKey;
    const shown = await app.post('/api/vault/chip/phrase');
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    plant = true;
    const moved = await app.post('/api/vault/chip/move');
    assert.equal(await settled(app, moved.json.run), 'failed vault_other_keys');
    // The vault did move: the owner key is out, and vault.json says so.
    assert.equal(app.prefs.get().chip?.account, vault);
    assert.equal(chain.hasKey(vault, stranger), true);
    let facts = await chipState(app);
    for (let i = 0; i < 100 && facts.otherKeys === null; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      facts = await chipState(app);
    }
    assert.deepEqual(facts.otherKeys, [stranger]);
    assert.match(app.frames(), /holds a key Phosphor did not add/);
  } finally {
    await app.close();
  }
});

/* The owner key gate (CONTRACTS.md, Wave 2 as merged): no chain answer yet, the owner key is out; neither
   pinned key on the vault, it is in; the chip key or the paper key on the vault, out for good. A
   restart asks the markers first, as src/main.ts does right behind the probe. */
async function restartedOn(chain: IntentsDouble, mac: VaultDouble, dataDir: string, vault: string): Promise<App> {
  const app = await chipApp(chain, { mac, dataDir });
  assert.equal((await app.relay.ask({ op: 'chipStatus' })).ok, true);
  // The gate asks the chain about any marker naming the vault; the double answers at once.
  app.gate(vault);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await app.post('/api/vault/unlock')).json.ok, true);
  return app;
}

test('the owner key gate and the move agree after a crash: a call that ran keeps the owner key out before vault.json is written, one that never went out lets it back in', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const mac = new VaultDouble();
  const dataDir = tempDir('phosphor-rekey-gate-');

  // A move that ran, and a crash before vault.json named the chip: the disk as kill point 7 leaves it.
  const a = await chipApp(chain, { mac, dataDir, papers: [PAPER_A] });
  let vault = '';
  try {
    vault = await wallet(a, chain);
    assert.equal((await migrate(a, PAPER_A)).result, 'done');
  } finally {
    await a.close();
  }
  const prefsFile = path.join(dataDir, 'vault.json');
  const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) as Record<string, unknown>;
  delete prefs.chip;
  fs.writeFileSync(prefsFile, JSON.stringify(prefs));
  const runFile = path.join(dataDir, 'chip-run.json');
  fs.writeFileSync(runFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(runFile, 'utf8')), status: 'moving' }));

  const b = await restartedOn(chain, mac, dataDir, vault);
  try {
    assert.equal(b.prefs.get().chip, null, 'vault.json names no chip yet');
    assert.equal(b.gate(vault), true, 'the chip on the vault keeps the owner key out');
    assert.throws(() => b.keystore.evmPrivateKey(), (err: unknown) => isOwnerTouchRequired(err), 'no session holds the owner key of a vault that moved');
    // The first read of the state finishes the move from the chain's word.
    await new Promise((r) => setTimeout(r, 0));
    let chip = await chipState(b);
    for (let i = 0; i < 200 && chip.state !== 'done'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      chip = await chipState(b);
    }
    assert.equal(chip.state, 'done');
    assert.equal(b.prefs.get().chip?.account, vault);
  } finally {
    await b.close();
  }
});

test('a chip committed and a call that never went out: once the chain answers, the owner key is back in and the next try finishes with that chip', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const mac = new VaultDouble();
  const dataDir = tempDir('phosphor-rekey-gate-');
  // The owner key's touch cancelled after the commit: a marker names the vault and nothing was sent.
  let cancel = true;
  const a = await chipApp(chain, {
    mac,
    dataDir,
    papers: [PAPER_A],
    hook: (r) => {
      if (cancel && r.op === 'unwrap' && r.reason === MOVE_VAULT_REASON) {
        cancel = false;
        return { kind: 'answer', answer: { ok: false, error: 'user_cancel', message: 'cancelled' } as Answer };
      }
      return undefined;
    },
  });
  let vault = '';
  try {
    vault = await wallet(a, chain);
    const shown = await a.post('/api/vault/chip/phrase');
    assert.equal((await a.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    const moved = await a.post('/api/vault/chip/move');
    assert.equal(await settled(a, moved.json.run), 'failed user_cancel');
  } finally {
    await a.close();
  }
  assert.equal(chipKeysIn(mac), 1);

  const b = await restartedOn(chain, mac, dataDir, vault);
  try {
    assert.equal(b.relay.chipMarkers(vault).length, 1, 'the restart read the marker naming the vault');
    assert.equal(b.gate(vault), false, 'neither pinned key is on the vault: the owner key is in');
    assert.match(b.keystore.evmPrivateKey(), /^0x[0-9a-f]{64}$/, 'kind key: the owner key signs VAULT again');
    assert.equal((await b.post('/api/vault/chip/phrase-proven', { words: PAPER_A.split(' ') })).json.ok, true);
    const moved = await b.post('/api/vault/chip/move');
    assert.equal(await settled(b, moved.json.run), 'done');
    assert.equal(chipKeysIn(mac), 1, 'the chip committed before the crash is the one that moved the vault');
    assert.equal(b.gate(vault), true);
  } finally {
    await b.close();
  }
});

test('two windows at once: one move runs, the other is told the vault is already moving', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const app = await chipApp(chain, { papers: [PAPER_A] });
  try {
    await wallet(app, chain);
    const shown = await app.post('/api/vault/chip/phrase');
    assert.equal((await app.post('/api/vault/chip/phrase-proven', { words: shown.json.words })).json.ok, true);
    const [one, two] = await Promise.all([app.post('/api/vault/chip/move'), app.post('/api/vault/chip/move')]);
    const answers = [one, two].map((r) => (r.status === 202 ? 'run' : r.json.code)).sort();
    assert.deepEqual(answers, ['rekey_busy', 'run']);
    const run = (one.status === 202 ? one : two).json.run;
    assert.equal(await settled(app, run), 'done');
    assert.equal(chain.executions(), 1);
  } finally {
    await app.close();
  }
});

test('the gas account is funded by a NEAR payout to its derived id, whatever the body names', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  const app = await chipApp(chain, { papers: [] });
  try {
    await wallet(app, chain, { gas: null });
    const gas = app.keystore.derivedAccounts()!.gas;
    const funded = await app.post('/api/vault/gas/fund', { near: 0.5, to: 'attacker.near', receiver: 'b'.repeat(64) });
    assert.equal(funded.json.ok, true, JSON.stringify(funded.json));
    assert.deepEqual(app.sends, [{ to: gas, symbol: 'NEAR', amount: 0.5, where: 'near' }]);
    assert.deepEqual(funded.json.proposal, { id: 'p-1', status: 'pending' });
    for (const near of [0, 0.05, 2, '0.5', null]) assert.equal((await app.post('/api/vault/gas/fund', { near })).json.code, 'fund_amount', String(near));
    assert.equal(app.sends.length, 1);
    const slice = await chipState(app);
    assert.ok(slice.needs.includes('gas'), 'an unpaid gas account is what the move still needs');
  } finally {
    await app.close();
  }
});

test('the state says how much NEAR the gas account\'s payout could come from: none, some, or not read yet', { skip, timeout: 120_000 }, async () => {
  const chain = createIntentsDouble({ start: T0 * 1000 });
  let read: IntentsRead | undefined;
  const app = await chipApp(chain, { papers: [], intents: () => read });
  const row = (accountId: string, symbol: string, amount: number) => ({ accountId, assetId: `nep141:${symbol}`, symbol, originChain: 'near', amount, decimals: 24 });
  // The state is built at most once a second for inputs it does not watch (src/http/state.ts).
  const sourceNear = async (want: number | null): Promise<unknown> => {
    let seen: unknown;
    for (let i = 0; i < 60; i += 1) {
      seen = (await chipState(app)).sourceNear;
      if (seen === want) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return seen;
  };
  try {
    const vault = await wallet(app, chain, { gas: null });
    assert.equal(await sourceNear(null), null, 'a ledger that never read the vault says none');
    read = { ok: true, fetchedAt: new Date().toISOString(), holdings: [row(vault, 'USDC', 40), row('0x' + 'f'.repeat(40), 'wNEAR', 3)] };
    assert.equal(await sourceNear(0), 0, 'NEAR another account holds was counted as the vault\'s');
    read = { ...read, holdings: [...read.holdings, row(vault, 'wNEAR', 1.25)] };
    assert.equal(await sourceNear(1.25), 1.25);
    read = { ...read, ok: false, error: 'the verifier did not answer' };
    assert.equal(await sourceNear(null), null, 'a failed read is not a vault with no NEAR');
  } finally {
    await app.close();
  }
});

test('a demo has no chip vault: the routes say so and nothing is asked of the keychain', { timeout: 60_000 }, async () => {
  const { startRekey, showPaper } = await import('../../src/vault/rekey.ts');
  useChipVault(null);
  const host = {
    keystore: { isUnlocked: () => true, addressReport: () => ({ verified: true, addresses: { evm: '0x' + '1'.repeat(40) } }), onChange: () => () => {} } as unknown as Keystore,
  } as Parameters<typeof startRekey>[0];
  const started = startRekey(host, 'migrate');
  assert.ok(!started.ok && started.code === 'chip_unsupported');
  assert.equal(typeof showPaper, 'function');
});

test('the paper key moves through no agent door: no chip route is on /api/mcp, and no tool names one', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const mcp = fs.readFileSync(path.join(root, 'src', 'http', 'mcp.ts'), 'utf8') + fs.readFileSync(path.join(root, 'src', 'mcp.ts'), 'utf8');
  for (const word of ['chip/phrase', 'chip/move', 'chip/restore', 'gas/fund', 'showPaper', 'provePaper', 'startRekey']) assert.ok(!mcp.includes(word), word);
  const router = fs.readFileSync(path.join(root, 'src', 'http', 'router.ts'), 'utf8');
  for (const route of ['/api/vault/chip/phrase', '/api/vault/chip/phrase-proven', '/api/vault/chip/move', '/api/vault/chip/restore', '/api/vault/gas/fund']) {
    assert.match(router, new RegExp(`'${route.replaceAll('/', '\\/')}': \\(ctx, req, res\\) => handle`), route);
  }
  // Only these sentences open the owner key for the vault, and the dialog says which.
  assert.equal(MOVE_VAULT_REASON, "Move your vault to this Mac's Touch ID key and your paper key");
  assert.notEqual(MOVE_VAULT_REASON, UNLOCK_REASON);
  assert.notEqual(MOVE_VAULT_REASON, RESTORE_REASON);
});
