// One Mac wired the way src/main.ts wires wave 3, for the end-to-end proofs of the merge
// (tests/unit/wave3-wiring.test.ts): the keystore with the one owner key gate, the Hyperliquid
// owner touch and the trading key plan; the relay, with the vault service's own rules behind it
// (U5's Swift compiled with the test seam, tests/unit/helpers/vault-double.ts); the accounts the
// rails read; ONE vault move submitter that the move to the chip and the allowance share; the
// allowance service; the proposal service with the relay swap rail and the top-up rail; and the
// real server, its window routes and its agent door.
//
// The chain is the intents double; the solver relay, 1Click's signed price and Hyperliquid are
// fakes. No Touch ID (the stand-in records each one and the sentence it would show), no real key,
// no network: a fetch to any host but this server and the Hyperliquid fake throws.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { MAX_AGENTS, createAgents } from '../../../src/agents.ts';
import { createAudit } from '../../../src/audit.ts';
import type { Audit } from '../../../src/audit.ts';
import { hlAgentPlan } from '../../../src/hl/agent-key.ts';
import { useRailAccounts } from '../../../src/intents-sign.ts';
import { createKeystore, useKeystore } from '../../../src/keystore/index.ts';
import type { Keystore } from '../../../src/keystore/index.ts';
import { defaultParams } from '../../../src/keystore/kdf.ts';
import { createMarketData } from '../../../src/market/index.ts';
import { loadPolicy, savePolicy } from '../../../src/policy/file.ts';
import { createProposalService } from '../../../src/proposals.ts';
import { ownerTouchVia } from '../../../src/proposals/lifecycle.ts';
import { isRailKind } from '../../../src/rails/index.ts';
import { useOwnerTouch } from '../../../src/rails/hl-user-signed.ts';
import { intentsRelayRail } from '../../../src/rails/intents-relay.ts';
import { vaultTopUpRail } from '../../../src/rails/vault-topup.ts';
import type { RelayClient } from '../../../src/relay/client.ts';
import type { VerifierPort } from '../../../src/relay/verifier.ts';
import { createServer } from '../../../src/server.ts';
import { createStore } from '../../../src/store.ts';
import { createTradeView } from '../../../src/trade/view.ts';
import type { AppConfig, Rail, RiskRow, WriteDraft } from '../../../src/types.ts';
import { createAccounts } from '../../../src/vault/accounts.ts';
import type { AccountsPort } from '../../../src/vault/accounts.ts';
import { createAllowance } from '../../../src/vault/allowance.ts';
import type { AllowanceService } from '../../../src/vault/allowance.ts';
import { chipStatusReader, ownerKeyGate } from '../../../src/vault/chip.ts';
import { createVaultPrefs } from '../../../src/vault/prefs.ts';
import type { VaultPrefs } from '../../../src/vault/prefs.ts';
import { useChipVault } from '../../../src/vault/rekey.ts';
import { createVaultRelay } from '../../../src/vault/relay.ts';
import type { VaultRelay } from '../../../src/vault/relay.ts';
import { createVaultSubmitter, fileJournal, journalPathFor } from '../../../src/vault/submit.ts';
import type { VaultSubmitter } from '../../../src/vault/submit.ts';
import { TOKENS, doubleLedger, fakeRelay, signedPrice } from './allowance-world.ts';
import { createIntentsDouble } from './intents-double.ts';
import type { IntentsDouble } from './intents-double.ts';
import { seededPolicy } from './proposals.ts';
import { TEST_QUOTE_KEY } from './signed-quote.ts';
import { tempDir } from './tmp.ts';
import { VaultDouble, relayTo } from './vault-double.ts';
import type { Hook, Request as ShellRequest } from './vault-double.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const HALF_NEAR = 500_000_000_000_000_000_000_000n;
// The seat secret the app hands the agents it spawns: a seat that holds it is the app's own.
export const SEAT = 'a'.repeat(64);

export type HlPost = { action: Record<string, unknown>; nonce: number; signature: unknown };

// A call held mid-way: `reached` once it is waiting, and `release` lets it go on.
export type Held = { reached: Promise<void>; release: () => void };

function heldCall(): Held & { wait(): Promise<void> } {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return {
    reached,
    release,
    wait() {
      arrive();
      return open;
    },
  };
}

export type Wave3World = {
  chain: IntentsDouble;
  mac: VaultDouble;
  dataDir: string;
  keysPath: string;
  keystore: Keystore;
  relay: VaultRelay;
  prefs: VaultPrefs;
  gate: (vault: string) => boolean;
  accounts: AccountsPort;
  vaultMoves: VaultSubmitter;
  allowance: AllowanceService;
  svc: ReturnType<typeof createProposalService>;
  audit: Audit;
  ledger: ReturnType<typeof doubleLedger>;
  // Every request the shell relayed to the vault service, in order.
  seen: ShellRequest[];
  // Every swap the solver relay took, with the account that signed it.
  publishes: { payload: string; signer: string }[];
  // Every action posted to Hyperliquid's /exchange.
  hlPosts: HlPost[];
  // Holds the solver relay's next quote (a swap being proposed), or the swap rail's next read of
  // the verifier's salt (the last read before its signature), until `release` is called.
  holdQuote(): Held;
  holdSwapRead(): Held;
  post(route: string, body?: Record<string, unknown>): Promise<{ status: number; json: any }>;
  get(route: string): Promise<{ status: number; json: any }>;
  // The agent door, as an agent this app spawned: its own seat secret and a session.
  mcp(body: Record<string, unknown>): Promise<{ status: number; json: any }>;
  // A Touch ID wallet made by the window's own route, open, its backup proven, its gas account funded.
  wallet(): Promise<{ vault: string; allowance: string; gas: string }>;
  // The paper shown, typed back, and the move started: the run's id.
  startMove(paper: string): Promise<string>;
  // How the run ended: 'done', or 'failed <code>'.
  settled(run: string): Promise<string>;
  close(): Promise<void>;
};

/* `papers`: the paper keys /chip/phrase hands out, in order. `hook`: decides what the shell does
   with a request before the vault service sees it (vault-double.ts Hook). `chain`, `mac` and
   `dataDir`: what outlives a restart, handed to the next start. */
export async function wave3World(
  opts: { papers?: string[]; hook?: (r: ShellRequest) => Hook | Promise<Hook> | undefined; chain?: IntentsDouble; mac?: VaultDouble; dataDir?: string } = {},
): Promise<Wave3World> {
  const chain = opts.chain ?? createIntentsDouble({ start: Date.now() });
  const dataDir = opts.dataDir ?? tempDir('phosphor-wave3-');
  const token = crypto.randomBytes(32).toString('hex');
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'live', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const relaySecret = crypto.randomBytes(32).toString('hex');
  const relay = createVaultRelay({ transportKey: transport, secret: relaySecret, makesKeys: true });
  const cfg: AppConfig = { mode: 'live', port: 0, addresses: {}, candleProducts: ['BTC-USD'], dataDir, keysPath };
  const prefs = createVaultPrefs(dataDir);
  if (opts.dataDir === undefined) savePolicy(dataDir, seededPolicy());

  // src/main.ts, in its order: the one gate, the owner touch on it, the trading key plan, the
  // accounts the rails read, the one vault move submitter, the chip vault, the allowance.
  const gate = ownerKeyGate(() => prefs.get(), relay, chain.verifier, { owner: () => keystore.ownerPublicKey() });
  keystore.keepOwnerKeyOutWhen(gate);
  useOwnerTouch(ownerTouchVia({ vault: relay, keystore, ownerOut: gate }));
  keystore.planHlAgentsWith((v) => hlAgentPlan(prefs.get(), v));
  const accounts = createAccounts({ keystore, prefs, chipStatus: chipStatusReader(relay) });
  useRailAccounts(accounts.accounts);
  const vaultMoves = createVaultSubmitter({
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
    submitter: vaultMoves,
    accounts,
    near: chain.near,
    now: chain.now,
    newPhrase: () => {
      const next = papers.shift();
      if (next === undefined) throw new Error('the test has no paper key left to hand out');
      return next;
    },
    reads: true,
    pollMs: 20,
  });
  const allowance = createAllowance({ accounts, prefs, relay, verifier: chain.verifier, submitter: vaultMoves, now: chain.now, sleep: chain.near.sleep });

  // The rails a moved vault spends through, and the ledger read off the chain double for both accounts.
  const publishes: { payload: string; signer: string }[] = [];
  let quoteGate: ReturnType<typeof heldCall> | null = null;
  let readGate: ReturnType<typeof heldCall> | null = null;
  const solver = fakeRelay(chain, publishes);
  const relayClient: RelayClient = {
    ...solver,
    async quote(req) {
      const gate = quoteGate;
      quoteGate = null;
      if (gate !== null) await gate.wait();
      return solver.quote(req);
    },
  };
  const swapVerifier: VerifierPort = {
    ...chain.verifier,
    async currentSalt() {
      const gate = readGate;
      readGate = null;
      if (gate !== null) await gate.wait();
      return chain.verifier.currentSalt();
    },
  };
  const swap = intentsRelayRail({ keysPath, tokens: TOKENS, relay: relayClient, client: signedPrice(), quoteKey: TEST_QUOTE_KEY, verifier: swapVerifier, sleepImpl: async () => {}, settleSchedule: { firstMs: 1, maxMs: 1, timeoutMs: 50 } }) as Rail;
  const table = new Map<WriteDraft['kind'], Rail>([
    ['swap', swap],
    ['vault_top_up', vaultTopUpRail({ allowance }) as Rail],
  ]);
  const ownAccounts = (): string[] => {
    const evm = keystore.addresses().evm;
    const derived = keystore.derivedAccounts();
    return [...(evm === null ? [] : [evm.toLowerCase()]), ...(derived === null ? [] : [derived.allowance.toLowerCase()])];
  };
  const ledger = doubleLedger(chain, ownAccounts);
  const audit = createAudit(dataDir);
  audit.subscribe((event) => {
    if (event.type === 'executed') void ledger.refresh();
  });
  const store = createStore(dataDir);
  const svc = createProposalService({
    cfg,
    audit,
    store,
    ledger,
    riskRows,
    rails: { for: (draft) => table.get(draft.kind) ?? null, kinds: () => [...table.keys()].filter(isRailKind) },
    dataDir,
    vault: relay,
    keystore,
    allowance,
  });

  // No network: this server and the Hyperliquid fake answer, anything else throws.
  const hlPosts: HlPost[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    if (href.startsWith('http://127.0.0.1:')) return realFetch(url, init);
    if (href.startsWith('https://api.hyperliquid.xyz/exchange')) {
      hlPosts.push(JSON.parse(String(init?.body)) as HlPost);
      return new Response(JSON.stringify({ status: 'ok', response: { type: 'default' } }), { headers: { 'content-type': 'application/json' } });
    }
    if (href.startsWith('https://api.hyperliquid.xyz/info')) return new Response('[]', { headers: { 'content-type': 'application/json' } });
    throw new Error(`no network in this test: ${href}`);
  }) as typeof fetch;

  const agents = createAgents(Date.now, MAX_AGENTS, { secret: SEAT });
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const server = createServer({
    cfg,
    token,
    vault: relay,
    intentsReceive: async () => ({ account: keystore.addressReport().addresses.evm, verified: keystore.addressReport().verified, tampered: false, networks: [] }),
    audit,
    store,
    keystore,
    riskRows,
    ledger,
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals: svc,
    getPolicy: () => loadPolicy(dataDir),
    setKill: () => {},
    agents,
    getView: () => 'pro',
    setView: () => {},
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: unused,
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
    const res = await realFetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  async function get(route: string) {
    const res = await realFetch(`${url}${route}`, { headers: { origin: url, 'x-phosphor-token': token } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }

  const mac = opts.mac ?? new VaultDouble();
  const seen: ShellRequest[] = [];
  const shell = relayTo((route, body) => send(route, { relay: relaySecret, ...body }), mac, transport, async (r) => {
    mac.now = Math.floor(chain.now() / 1000);
    seen.push(r);
    return (await opts.hook?.(r)) ?? { kind: 'run' };
  });
  // src/main.ts's start: the probe, then the chip markers queued right behind it, whose answer asks
  // the owner key gate about this wallet's vault before any unlock is answered, and a status that
  // did not answer asked again until one does (FA-1).
  const probing = relay.ask({ op: 'probe' });
  const marking = relay.ask({ op: 'chipStatus' }).then((answer) => {
    const evm = keystore.addresses().evm;
    if (evm !== null) gate(evm);
    if (!answer.ok && !relay.chipMarkersKnown()) retryMarkers(1);
  });
  let retrying: NodeJS.Timeout | null = null;
  const retryMarkers = (attempt: number): void => {
    retrying = setTimeout(() => {
      void relay.ask({ op: 'chipStatus' }).then((answer) => {
        const evm = keystore.addresses().evm;
        if (evm !== null) gate(evm);
        if (!answer.ok && !relay.chipMarkersKnown()) retryMarkers(attempt + 1);
      });
    }, Math.min(30_000, 1_000 * 2 ** attempt));
    retrying.unref();
  };
  const probed = await probing;
  assert.ok(probed.ok, JSON.stringify(probed));
  await marking;

  const post = (route: string, body: Record<string, unknown> = {}) => send(route, { token, ...body });

  async function settled(run: string): Promise<string> {
    for (let i = 0; i < 2000; i += 1) {
      const chip = (await get('/api/state')).json.vault.chip;
      if (chip.run?.id === run && (chip.run.status === 'done' || chip.run.status === 'failed')) return chip.run.reason === null ? chip.run.status : `${chip.run.status} ${chip.run.reason}`;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the move did not end');
  }

  return {
    chain,
    mac,
    dataDir,
    keysPath,
    keystore,
    relay,
    prefs,
    gate,
    accounts,
    vaultMoves,
    allowance,
    svc,
    audit,
    ledger,
    seen,
    publishes,
    hlPosts,
    holdQuote() {
      quoteGate = heldCall();
      return quoteGate;
    },
    holdSwapRead() {
      readGate = heldCall();
      return readGate;
    },
    post,
    get,
    mcp: (body) => send('/api/mcp', { secret: SEAT, session: 'wave3-agent', client: 'test', ...body }),
    async wallet() {
      const made = await post('/api/vault/create');
      assert.equal(made.json.ok, true, JSON.stringify(made.json));
      if (keystore.state() !== 'unlocked') assert.equal((await post('/api/vault/unlock')).json.ok, true);
      const vault = String(made.json.addresses.evm).toLowerCase();
      prefs.markBackedUp(Date.now, vault);
      const derived = keystore.derivedAccounts();
      assert.ok(derived !== null);
      chain.fundGas(derived.gas, HALF_NEAR);
      return { vault, allowance: derived.allowance.toLowerCase(), gas: derived.gas };
    },
    async startMove(paper: string) {
      const shown = await post('/api/vault/chip/phrase');
      assert.deepEqual(shown.json.words, paper.split(' '));
      const proven = await post('/api/vault/chip/phrase-proven', { words: shown.json.words });
      assert.equal(proven.json.ok, true, JSON.stringify(proven.json));
      const moved = await post('/api/vault/chip/move');
      assert.equal(moved.status, 202, JSON.stringify(moved.json));
      return String(moved.json.run);
    },
    settled,
    async close() {
      if (retrying !== null) clearTimeout(retrying);
      relay.stop();
      await shell.stop();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      globalThis.fetch = realFetch;
      useChipVault(null);
      useRailAccounts(null);
      useOwnerTouch(null);
      useKeystore(null);
    },
  };
}
