// The rekey's crash matrix (PHASE2-PLAN.md section 7): a real backend killed with SIGKILL at each of
// the eight points of a migration and of a restore, started again on the same data folder and the
// same Mac, and taken to done. 16 cases.
//
// THE BACKEND IS THE APP'S OWN: node src/main.ts, demo mode with PHOSPHOR_DEMO_ENCLAVE (the switch a
// test harness uses to let a checkout make keys), a throwaway data folder, a fake home, never port
// 4177. Two things are outside it and outlive every kill, as they would outlive a crash:
//   the Mac's keychain and enclave: the vault service's own rules compiled with the stand-in
//     keychain (tests/unit/helpers/vault-double.ts), its store a JSON file, relayed by this script
//     the way the shell relays (src-tauri/src/enclave.rs), no Touch ID;
//   the chain: intents.near and the NEAR RPC as the chain double plays them
//     (tests/unit/helpers/intents-double.ts), served over HTTP by this script. A preload written to
//     the case's temp folder points the backend's NEAR RPC at it, refuses every other host, and can
//     run the backend's clock ahead (a restart minutes later, when a signed bundle has expired).
// Nothing here reaches mainnet or a real keychain.
//
// After every step the data folder and the state the window reads are searched for the paper key:
// the whole phrase, any two of its words in a row, any three of its words within 200 characters,
// and its private key as hex, base64 or base58. Every case ends with the chain double reading the
// chip key and the paper key on the vault, the owner key off and predecessor auth off.
//
//   node scripts/rekey-crash.ts            the 16 cases (macOS with the developer tools)
//   node scripts/rekey-crash.ts --live     one read-only simulate on mainnet: the migration bundle,
//                                          signed with software keys for a throwaway account
//   ONLY=migrate:5 node scripts/rekey-crash.ts   one case

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { base58Encode } from '../src/chain/near.ts';
import type { MultiPayload } from '../src/chain/near-tx.ts';
import { identityProof } from '../src/http/respond.ts';
import { isSpikedVerifier, liveVerifier } from '../src/relay/verifier.ts';
import type { VerifierEvent } from '../src/relay/verifier.ts';
import { eventsMismatch } from '../src/vault/payload.ts';
import { newPaperPhrase, paperKeyOf, verifierKeyOf } from '../src/vault/phrase24.ts';
import { MOVE_VAULT_REASON } from '../src/vault/reason.ts';
import { erc191Signed, rekeyEvents, signRekey } from '../src/vault/rekey.ts';
import { webauthnMessage, webauthnSigned } from '../src/vault/webauthn.ts';
import { createIntentsDouble } from '../tests/unit/helpers/intents-double.ts';
import type { IntentsDouble } from '../tests/unit/helpers/intents-double.ts';
import { VaultDouble, relayTo, swiftc } from '../tests/unit/helpers/vault-double.ts';
import type { Hook, Request } from '../tests/unit/helpers/vault-double.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HALF_NEAR = 500_000_000_000_000_000_000_000n;
const NEAR_RPC = 'https://free.rpc.fastnear.com';
// A restart this long after the kill: past a signed bundle's deadline and two minutes, and past a
// chip key's first ten minutes.
const LATER_MS = 11 * 60_000;

type Json = Record<string, any>;

function words(text: string): string[] {
  return text.split(' ');
}

// ---------- the chain, over HTTP ----------

type RpcTrap = 'simulate' | 'send_tx' | 'confirm';

/* The chain double as NEAR's RPC: what near-tx asks goes to the double's own RPC, and intents.near's
   views go to its verifier, answered in the shape the RPC answers (a view's result as UTF-8 bytes, a
   contract's refusal flat inside `result`). `trap` kills the backend at one call: a dry run (before
   the answer), a send (after the call landed, before the answer) or the first nonce read after a
   send was answered (the views before done). */
function chainServer(chain: IntentsDouble) {
  let offset = 0;
  let trap: { at: RpcTrap; kill: () => void } | null = null;
  let sentOnce = false;

  async function call(method: string, params: Json): Promise<Json> {
    if (method === 'query' && params.request_type === 'call_function' && params.account_id === 'intents.near') {
      const args = JSON.parse(Buffer.from(String(params.args_base64), 'base64').toString('utf8')) as Json;
      const at = typeof params.block_id === 'string' ? params.block_id : undefined;
      const block = (await chain.verifier.finalBlock())!;
      const v = chain.verifier;
      const ok = (value: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')], logs: [], block_hash: block.hash, block_height: 1 } });
      const refusal = (text: string) => ({ result: { error: `wasm execution failed with error: HostError(GuestPanic { panic_msg: ${JSON.stringify(text)} })`, logs: [], block_hash: block.hash, block_height: 1 } });
      switch (params.method_name) {
        case 'has_public_key':
          return ok(await v.hasPublicKey(args.account_id, args.public_key, at));
        case 'public_keys_of':
          return ok(await v.publicKeysOf(args.account_id, at));
        case 'is_auth_by_predecessor_id_enabled':
          return ok(await v.isAuthByPredecessorIdEnabled(args.account_id, at));
        case 'is_nonce_used':
          return ok(await v.nonceUsed(args.account_id, args.nonce, at));
        case 'is_valid_salt':
          return ok(await v.isValidSalt(Uint8Array.from(Buffer.from(String(args.salt), 'hex')), at));
        case 'current_salt':
          return ok(Buffer.from((await v.currentSalt())!).toString('hex'));
        case 'is_account_locked':
          return ok(false);
        case 'mt_batch_balance_of':
          return ok(await Promise.all((args.token_ids as string[]).map(async (t) => String(await v.balance(args.account_id, t, at)))));
        case 'simulate_intents': {
          const sim = await v.simulate(args.signed, at);
          if (sim === null || !sim.ok) return refusal(sim === null ? 'no answer' : sim.refusal);
          const events = sim.events ?? [];
          const logs = events.map((e) => (e.event === 'other' ? e.line : `EVENT_JSON:${JSON.stringify({ standard: 'dip4', version: '0.4.3', event: e.event, data: e.data })}`));
          const executed = events.find((e) => e.event === 'intents_executed') as Extract<VerifierEvent, { event: 'intents_executed' }> | undefined;
          return ok({ intents_executed: executed?.data ?? [], logs, min_deadline: new Date(chain.now()).toISOString(), state: { fee: 1, current_salt: Buffer.from((await v.currentSalt())!).toString('hex') } });
        }
        default:
          return refusal(`MethodResolveError(MethodNotFound) ${String(params.method_name)}`);
      }
    }
    const res = await chain.near.fetchImpl(NEAR_RPC, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 'phosphor', method, params }) } as RequestInit);
    return (await res.json()) as Json;
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        // The chain's clock keeps up with the backend's, which may run ahead.
        const want = Date.now() + offset;
        if (want > chain.now()) chain.advance(want - chain.now());
        let request: Json;
        try {
          request = JSON.parse(body) as Json;
        } catch {
          res.writeHead(400).end();
          return;
        }
        const { method, params, id } = request as { method: string; params: Json; id: unknown };
        const isSimulate = method === 'query' && params?.method_name === 'simulate_intents';
        if (trap?.at === 'simulate' && isSimulate) {
          trap.kill();
          trap = null;
          res.destroy();
          return;
        }
        if (trap?.at === 'confirm' && sentOnce && method === 'query' && params?.method_name === 'is_nonce_used') {
          trap.kill();
          trap = null;
          res.destroy();
          return;
        }
        let answer: Json;
        try {
          answer = await call(method, params ?? {});
        } catch (err) {
          answer = { error: { name: 'HANDLER_ERROR', cause: { name: 'INTERNAL_ERROR', info: {} }, code: -32000, message: String(err), data: String(err) } };
        }
        if (method === 'send_tx' && trap?.at === 'send_tx') {
          // The call landed (the double ran it); the backend dies before it hears.
          trap.kill();
          trap = null;
          res.destroy();
          return;
        }
        if (method === 'send_tx') sentOnce = true;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
      })();
    });
  });

  return {
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    setOffset(ms: number) {
      offset = ms;
    },
    setTrap(at: RpcTrap | null, kill: () => void) {
      trap = at === null ? null : { at, kill };
      sentOnce = false;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------- a real backend ----------

const PRELOAD = `// Written by scripts/rekey-crash.ts into its own temp folder; never part of the app.
const target = process.env.PHOSPHOR_CRASH_RPC;
const offset = Number(process.env.PHOSPHOR_CRASH_CLOCK_MS || '0');
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(${JSON.stringify(NEAR_RPC)})) return real(target, init);
  if (url.startsWith('http://127.0.0.1')) return real(input, init);
  throw new TypeError('fetch failed: the crash harness reaches no outside host');
};
if (offset !== 0) {
  const now = Date.now;
  Date.now = () => now() + offset;
}
`;

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
  post(route: string, body?: Json): Promise<{ status: number; json: any }>;
  get(route: string): Promise<{ status: number; json: any }>;
  seen: Request[];
  frames(): string;
  kill(): Promise<void>;
  stop(): Promise<void>;
};

type Relay = { trap: 'chipCommit' | 'unwrap-move' | 'signIntent' | null; kill: (() => void) | null };

async function backend(dir: string, mac: VaultDouble, rpc: string, offset: number, relay: Relay): Promise<Backend> {
  const port = await freePort();
  if (port === 4177) throw new Error('never the app port');
  const base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ port, mode: 'demo' }));
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, PRELOAD);
  const token = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  const transportHex = crypto.randomBytes(32).toString('hex');
  const relaySecret = crypto.randomBytes(32).toString('hex');
  const child: ChildProcess = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'src/main.ts'], {
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
      PHOSPHOR_DEMO_ENCLAVE: '1',
      PHOSPHOR_CRASH_RPC: rpc,
      PHOSPHOR_CRASH_CLOCK_MS: String(offset),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout!.on('data', (d: Buffer) => output.push(d.toString()));
  child.stderr!.on('data', (d: Buffer) => output.push(d.toString()));
  child.stdin!.write(`${token}\n${nonce}\n${crypto.randomBytes(32).toString('hex')}\n${transportHex}\n${relaySecret}\n`);
  child.stdin!.end();
  const exited = new Promise<void>((r) => child.once('exit', () => r()));

  async function send(route: string, body: Json) {
    const challenge = crypto.randomBytes(32).toString('hex');
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-phosphor-challenge': challenge }, body: JSON.stringify(body) });
    if (res.headers.get('x-phosphor')?.toLowerCase() !== identityProof(nonce, challenge)) throw new Error('another process answered on the port');
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`the backend did not come up: ${output.join('').slice(-800)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const get = async (route: string) => {
    const res = await fetch(`${base}${route}`, { headers: { 'x-phosphor-token': token } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  // The shell: the stand-in's clock is the backend's, and one request can be the kill point.
  const shell = relayTo(
    (route, body) => send(route, { relay: relaySecret, ...body }),
    mac,
    Buffer.from(transportHex, 'hex'),
    (r): Hook => {
      mac.now = Math.floor((Date.now() + offset) / 1000);
      const hit =
        (relay.trap === 'chipCommit' && r.op === 'chipCommit') ||
        (relay.trap === 'signIntent' && r.op === 'signIntent') ||
        (relay.trap === 'unwrap-move' && r.op === 'unwrap' && r.reason === MOVE_VAULT_REASON);
      if (hit && relay.kill !== null) {
        relay.trap = null;
        relay.kill();
        return { kind: 'drop' };
      }
      return { kind: 'run' };
    },
  );
  let frameText = '';
  const tap = new AbortController();
  void fetch(`${base}/api/events`, { headers: { 'x-phosphor-token': token }, signal: tap.signal })
    .then(async (res) => {
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        frameText += Buffer.from(value).toString('utf8');
      }
    })
    .catch(() => undefined);
  for (let i = 0; i < 100; i += 1) {
    if ((await get('/api/vault')).json?.enclave?.ready === true) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const end = async (signal: NodeJS.Signals) => {
    tap.abort();
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await shell.stop().catch(() => undefined);
  };
  return {
    post: (route, body = {}) => send(route, { token, ...body }),
    get,
    seen: shell.seen,
    frames: () => frameText,
    kill: () => end('SIGKILL'),
    stop: () => end('SIGTERM'),
  };
}

// ---------- the leak search ----------

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : e.name === 'preload.mjs' ? [] : [path.join(dir, e.name)]));
}

function leaks(texts: { name: string; text: string }[], phrase: string): string[] {
  const list = words(phrase);
  const key = paperKeyOf(phrase).key;
  const encodings = [key.toString('hex'), key.toString('base64'), base58Encode(key)];
  key.fill(0);
  const found: string[] = [];
  for (const { name, text } of texts) {
    const lower = text.toLowerCase();
    if (encodings.some((e) => text.includes(e) || lower.includes(e.toLowerCase()))) found.push(`${name}: the paper's private key`);
    for (let i = 0; i + 1 < list.length; i += 1) {
      if (new RegExp(`(^|[^a-z])${list[i]}[^a-z]{1,8}${list[i + 1]}([^a-z]|$)`).test(lower)) found.push(`${name}: words ${i + 1} and ${i + 2} in a row`);
    }
    // Any three of the words close together, in any order: a list or a dump of the phrase.
    const at: { word: string; index: number }[] = [];
    for (const w of new Set(list)) for (const m of lower.matchAll(new RegExp(`(^|[^a-z])(${w})(?=[^a-z]|$)`, 'g'))) at.push({ word: w, index: (m.index ?? 0) + m[1]!.length });
    at.sort((a, b) => a.index - b.index);
    for (let i = 0; i < at.length; i += 1) {
      const near = new Set(at.filter((x) => x.index >= at[i]!.index && x.index - at[i]!.index <= 200).map((x) => x.word));
      if (near.size >= 3) {
        found.push(`${name}: three of the words within 200 characters`);
        break;
      }
    }
  }
  return found;
}

async function checkLeaks(dir: string, b: Backend | null, phrases: string[], step: string): Promise<void> {
  const texts = filesUnder(dir).map((f) => ({ name: path.relative(dir, f), text: fs.readFileSync(f, 'utf8') }));
  if (b !== null) {
    texts.push({ name: 'frames', text: b.frames() });
    texts.push({ name: '/api/state', text: JSON.stringify((await b.get('/api/state').catch(() => ({ json: null }))).json) });
  }
  for (const phrase of phrases) {
    const found = leaks(texts, phrase);
    if (found.length > 0) throw new Error(`the paper key leaked after ${step}: ${found.join('; ')}`);
  }
}

// ---------- the window's steps ----------

async function chip(b: Backend): Promise<Json> {
  return (await b.get('/api/state')).json?.vault?.chip ?? {};
}

async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, tries = 600): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
}

// A Touch ID wallet made by the window, opened, its backup proven by three words, its gas funded.
async function newWallet(b: Backend, chain: IntentsDouble): Promise<{ vault: string; mnemonic: string }> {
  const made = await b.post('/api/vault/create');
  if (made.json?.ok !== true) throw new Error(`create: ${JSON.stringify(made.json)}`);
  if ((await b.get('/api/vault')).json?.state !== 'unlocked') {
    const opened = await b.post('/api/vault/unlock');
    if (opened.json?.ok !== true) throw new Error(`unlock: ${JSON.stringify(opened.json)}`);
  }
  const revealed = await b.post('/api/vault/reveal');
  if (revealed.json?.ok !== true) throw new Error(`reveal: ${JSON.stringify(revealed.json)}`);
  const list = revealed.json.words as string[];
  const proven = await b.post('/api/vault/backup-proven', { words: (revealed.json.prove as number[]).map((index) => ({ index, word: list[index] })) });
  if (proven.json?.ok !== true) throw new Error(`backup: ${JSON.stringify(proven.json)}`);
  const gas = (await until('the gas account', () => chip(b), (c) => typeof c.gas?.account === 'string')).gas.account as string;
  chain.fundGas(gas, HALF_NEAR);
  return { vault: String(made.json.addresses.evm).toLowerCase(), mnemonic: list.join(' ') };
}

async function showPaper(b: Backend): Promise<string> {
  const shown = await b.post('/api/vault/chip/phrase');
  if (shown.json?.ok !== true) throw new Error(`phrase: ${JSON.stringify(shown.json)}`);
  return (shown.json.words as string[]).join(' ');
}

async function provePaper(b: Backend, phrase: string): Promise<void> {
  const proven = await b.post('/api/vault/chip/phrase-proven', { words: words(phrase) });
  if (proven.json?.ok !== true) throw new Error(`phrase-proven: ${JSON.stringify(proven.json)}`);
}

async function start(b: Backend, kind: 'migrate' | 'restore', oldPaper?: string): Promise<string> {
  const started = kind === 'migrate' ? await b.post('/api/vault/chip/move') : await b.post('/api/vault/chip/restore', { words: words(oldPaper!) });
  if (started.status !== 202) throw new Error(`${kind}: ${JSON.stringify(started.json)}`);
  return started.json.run as string;
}

async function ended(b: Backend, run: string): Promise<string> {
  const c = await until('the move', () => chip(b), (c) => c.run?.id === run && (c.run.status === 'done' || c.run.status === 'failed'));
  return c.run.reason === null ? c.run.status : `${c.run.status} ${c.run.reason}`;
}

async function unlock(b: Backend): Promise<void> {
  if ((await b.get('/api/vault')).json?.state === 'unlocked') return;
  const opened = await b.post('/api/vault/unlock');
  if (opened.json?.ok !== true) throw new Error(`unlock: ${JSON.stringify(opened.json)}`);
}

// ---------- the cases ----------

type Point = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
const POINTS: Record<Point, string> = {
  1: 'phrase shown, not proven',
  2: 'proven, before chipCreate',
  3: 'chipCreate, before chipCommit',
  4: 'chipCommit, before signing',
  5: 'both signed, before submit',
  6: 'submitted, not final',
  7: 'final, before prefs',
  8: 'prefs, before the first top-up',
};

type Mac = { dir: string; mac: VaultDouble };

function newMac(root: string, name: string): Mac {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, mac: new VaultDouble(path.join(dir, 'keychain.json')) };
}

const chipKeys = (mac: VaultDouble): string[] => mac.state().keys.filter((k) => k.tag.startsWith('com.karimbabasf.phosphor.chip.')).map((k) => k.tag);

/* One case: a vault moved (or restored) with a kill at `point`, resumed on the same folder and Mac,
   and checked. Returns the line printed for it. */
async function runCase(kind: 'migrate' | 'restore', point: Point, root: string): Promise<string> {
  const chain = createIntentsDouble({ start: Date.now() });
  const rpc = chainServer(chain);
  const rpcUrl = await rpc.start();
  const relay: Relay = { trap: null, kill: null };
  const phrases: string[] = [];
  let live: Backend | null = null;
  const boot = async (m: Mac, offset = 0): Promise<Backend> => {
    rpc.setOffset(offset);
    live = await backend(m.dir, m.mac, rpcUrl, offset, relay);
    return live;
  };
  try {
    // ---- the vault, ready to move: on this Mac for a migration, moved already for a restore ----
    let target: Mac;
    let vault: string;
    let old: string;
    let oldPaper: string | null = null;
    if (kind === 'migrate') {
      target = newMac(root, `${kind}-${point}`);
      const b = await boot(target);
      const w = await newWallet(b, chain);
      vault = w.vault;
      old = oldKeyOf(w.mnemonic);
      await checkLeaks(target.dir, b, phrases, 'the wallet was made');
    } else {
      const first = newMac(root, `${kind}-${point}-first`);
      const a = await boot(first);
      const w = await newWallet(a, chain);
      vault = w.vault;
      old = oldKeyOf(w.mnemonic);
      oldPaper = await showPaper(a);
      phrases.push(oldPaper);
      await provePaper(a, oldPaper);
      const moved = await ended(a, await start(a, 'migrate'));
      if (moved !== 'done') throw new Error(`the first Mac's move: ${moved}`);
      await a.stop();
      // A new Mac: its own keychain and folder, the wallet restored from its key backup.
      target = newMac(root, `${kind}-${point}`);
      const b = await boot(target);
      const restored = await b.post('/api/vault/restore', { mnemonic: w.mnemonic });
      if (restored.json?.ok !== true) throw new Error(`restore the wallet: ${JSON.stringify(restored.json)}`);
      await unlock(b);
      await checkLeaks(target.dir, b, phrases, 'the wallet was restored');
    }

    // ---- the move, killed at the point ----
    let b = live!;
    const kill = (): void => {
      void b.kill();
    };
    relay.kill = kill;
    const paper = await showPaper(b);
    phrases.push(paper);
    await checkLeaks(target.dir, b, phrases, 'the paper was shown');
    let chipsBefore: string[] = [];
    if (point === 1) {
      await b.kill();
    } else {
      await provePaper(b, paper);
      await checkLeaks(target.dir, b, phrases, 'the paper was typed back');
      if (point === 2) {
        await b.kill();
      } else {
        if (point === 3) relay.trap = 'chipCommit';
        if (point === 4) relay.trap = kind === 'migrate' ? 'unwrap-move' : 'signIntent';
        if (point === 5) rpc.setTrap('simulate', kill);
        if (point === 6) rpc.setTrap('send_tx', kill);
        if (point === 7) rpc.setTrap('confirm', kill);
        const run = await start(b, kind, oldPaper ?? undefined);
        if (point === 8) {
          const result = await ended(b, run);
          if (result !== 'done') throw new Error(`the move before the kill: ${result}`);
          await b.kill();
        } else {
          await waitDead(b);
        }
      }
    }
    relay.trap = null;
    rpc.setTrap(null, () => {});
    chipsBefore = chipKeys(target.mac);
    await checkLeaks(target.dir, null, phrases, `the kill at ${point}`);
    const found = foundAt(target, chain, vault, kind === 'restore' ? 1 : 0);
    const want = FOUND[point];
    if (found !== want) throw new Error(`killed at ${point}, the next start would find ${found}, not ${want}`);

    // ---- the next start, and what the person does there ----
    const offset = point === 3 || point === 5 ? LATER_MS : 0;
    b = await boot(target, offset);
    relay.kill = () => void b.kill();
    await unlock(b);
    const resumed = await chip(b);
    let how = '';
    switch (point) {
      case 1: {
        if (resumed.paper !== 'void') throw new Error(`after the kill the paper reads ${resumed.paper}, not void`);
        const refused = await b.post('/api/vault/chip/phrase-proven', { words: words(paper) });
        if (refused.json?.code !== 'phrase_gone') throw new Error(`the void paper was taken: ${JSON.stringify(refused.json)}`);
        const fresh = await showPaper(b);
        phrases.push(fresh);
        await provePaper(b, fresh);
        how = 'the old paper is void; a new one';
        break;
      }
      case 2:
      case 3:
      case 4:
      case 5: {
        if (resumed.paper !== 'retype') throw new Error(`after the kill the paper reads ${resumed.paper}, not retype`);
        await provePaper(b, paper);
        how = 'the same paper typed again';
        break;
      }
      default:
        how = 'nothing: the next start finishes it';
    }
    await checkLeaks(target.dir, b, phrases, 'the restart');
    if (point <= 5) {
      const result = await ended(b, await start(b, kind, oldPaper ?? undefined));
      if (result !== 'done') throw new Error(`the move after the restart: ${result}`);
    } else {
      await until('done at the next start', () => chip(b), (c) => c.state === 'done');
    }
    await checkLeaks(target.dir, b, phrases, 'the move finished');

    // ---- what the chain says ----
    const prefs = JSON.parse(fs.readFileSync(path.join(target.dir, 'state', 'vault.json'), 'utf8')) as { chip?: { publicKey: string; account: string } };
    const chipKey = prefs.chip?.publicKey;
    if (chipKey === undefined || prefs.chip?.account !== vault) throw new Error('vault.json names no chip for the vault');
    const recovery = paperKeyOf(phrases.at(-1)!).publicKey;
    const views = { chip: chain.hasKey(vault, chipKey), recovery: chain.hasKey(vault, recovery), old: chain.hasKey(vault, old), predecessor: chain.predecessorAuth(vault) };
    if (!views.chip || !views.recovery || views.old || views.predecessor) throw new Error(`the views: ${JSON.stringify(views)}`);
    if (oldPaper !== null && chain.hasKey(vault, paperKeyOf(oldPaper).publicKey)) throw new Error('the old paper is still on the vault');
    const chipsAfter = chipKeys(target.mac);
    if (point === 3 && chipsAfter.some((t) => chipsBefore.includes(t))) throw new Error('the orphan chip key outlived its ten minutes');
    if (point === 4 && !chipsBefore.some((t) => chipsAfter.includes(t))) throw new Error('the committed chip was not the one used');
    const executions = chain.executions();
    const expected = kind === 'restore' ? 2 : 1;
    if (executions !== expected) throw new Error(`${executions} calls ran, ${expected} expected`);
    await live!.stop();
    live = null;
    return `PASS  ${kind} ${point}  ${POINTS[point]}  | found: ${found}  | resume: ${how}  | has_public_key CHIP true, RECOVERY true, OLD false; predecessor auth false; ${expected} call${expected === 1 ? '' : 's'} ran`;
  } catch (err) {
    return `FAIL  ${kind} ${point}  ${POINTS[point]}  ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    const left = live as Backend | null;
    if (left !== null) await left.stop().catch(() => undefined);
    await rpc.stop();
  }
}

/* What the next start finds on disk, in the keychain and on the chain, in the words of the plan's
   crash matrix: the proof that each kill landed where it was aimed. */
const FOUND: Record<Point, string> = {
  1: 'a paper shown; no key; chain unchanged',
  2: 'a paper proven; no key; chain unchanged',
  3: 'an unmarked chip key; chain unchanged',
  4: 'a marked chip key; nothing written down; chain unchanged',
  5: 'a marked chip key; a bundle written down; chain unchanged',
  6: 'the call ran, its answer never heard; vault.json names no chip',
  7: 'the call ran and was heard; vault.json names no chip',
  8: 'the call ran and was heard; vault.json names the chip',
};

function foundAt(m: Mac, chain: IntentsDouble, vault: string, before: number): string {
  const read = (file: string): any => {
    try {
      return JSON.parse(fs.readFileSync(path.join(m.dir, 'state', file), 'utf8'));
    } catch {
      return null;
    }
  };
  const ran = chain.executions() > before;
  const named = read('vault.json')?.chip?.account === vault;
  const entries = (read('vault-moves.json')?.entries ?? []).filter((e: { account: string }) => e.account === vault) as { state: string }[];
  const heard = entries.some((e) => e.state === 'executed') || (named && entries.length === 0);
  if (ran) return `the call ran${heard ? ' and was heard' : ', its answer never heard'}; vault.json ${named ? 'names the chip' : 'names no chip'}`;
  const chips = m.mac.state();
  const keys = chipKeys(m.mac).length;
  const marked = (chips.chipMarkers ?? []).length;
  const journal = entries.length;
  const run = read('chip-run.json');
  if (keys === 0) return `a paper ${run?.recovery ? 'proven' : 'shown'}; no key; chain unchanged`;
  if (marked === 0) return 'an unmarked chip key; chain unchanged';
  return `a marked chip key; ${journal > 0 ? 'a bundle written down' : 'nothing written down'}; chain unchanged`;
}

function oldKeyOf(mnemonic: string): string {
  const hd = mnemonicToAccount(mnemonic, { path: "m/44'/60'/0'/0/0" }).getHdKey();
  const key = Buffer.from(hd.privateKey!);
  const name = verifierKeyOf(key);
  key.fill(0);
  return name;
}

// The backend a trap killed: gone once its port stops answering.
async function waitDead(b: Backend): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    try {
      await b.get('/api/health');
    } catch {
      await b.kill();
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the trap never fired');
}

// ---------- the live check, read-only ----------

/* The migration bundle, built and signed by the app's own code with software keys for a fresh
   throwaway 0x account, simulated on mainnet. simulate_intents is a view: nothing is sent and
   nothing changes. The paper key is a fresh 24-word paper whose words are never printed. */
async function live(): Promise<number> {
  const verifier = liveVerifier();
  const source = await verifier.sourceMetadata!();
  const old = generatePrivateKey();
  const oldKey = Buffer.from(old.slice(2), 'hex');
  const vault = privateKeyToAccount(old).address.toLowerCase();
  const paper = paperKeyOf(newPaperPhrase());
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const xy = Uint8Array.from(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  const chipKey = `p256:${base58Encode(xy)}`;
  const owner = verifierKeyOf(oldKey);
  const [salt, predecessorAuth, hasOld, listed] = await Promise.all([verifier.currentSalt(), verifier.isAuthByPredecessorIdEnabled!(vault), verifier.hasPublicKey!(vault, owner), verifier.publicKeysOf!(vault)]);
  if (salt === null || predecessorAuth === null || hasOld !== true || listed === null) throw new Error(`reads: salt ${salt !== null}, predecessor ${predecessorAuth}, has OLD ${hasOld}, listed ${JSON.stringify(listed)}`);
  const plan = { vault, chip: chipKey, recovery: paper.publicKey, remove: [owner, ...listed], predecessorAuth };
  const signed = await signRekey(
    plan,
    {
      old: (make) => erc191Signed(oldKey, make()),
      chip: async (payload): Promise<MultiPayload> => webauthnSigned(payload, xy, crypto.sign('sha256', webauthnMessage(payload), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' })),
      paper: (payload) => erc191Signed(paper.key, payload),
    },
    { salt, now: Date.now },
  );
  oldKey.fill(0);
  paper.key.fill(0);
  if (!signed.ok) throw new Error(`signing: ${signed.code} ${signed.detail}`);
  const sim = await verifier.simulate!(signed.bundle);
  if (sim === null || !sim.ok) throw new Error(`simulate: ${sim === null ? 'no answer' : sim.refusal}`);
  const want = rekeyEvents(plan, signed.bundle);
  const mismatch = eventsMismatch(sim.events, want);
  const said = (sim.events ?? []).map((e) =>
    e.event === 'set_auth_by_predecessor_id' ? `set_auth_by_predecessor_id(enabled=${e.data.enabled})` : e.event === 'intents_executed' ? `intents_executed(${e.data.length})` : e.event,
  );
  console.log(`verifier ${source === null ? 'unread' : `intents.near ${source.version} ${source.codeHash} spiked: ${isSpikedVerifier(source) ? 'yes' : 'no'}`}`);
  console.log(`throwaway vault ${vault}  predecessor auth before: ${predecessorAuth}  has_public_key(OLD): ${hasOld}  public_keys_of: ${listed.length}`);
  console.log(`simulate_intents (read-only): ${said.join(', ')}`);
  console.log(`events exact against the plan: ${mismatch === null ? 'yes' : `no: ${mismatch}`}`);
  return mismatch === null && said.length === 5 ? 0 : 1;
}

// ---------- the run ----------

/* The search finds what it is for, or it proves nothing: a phrase as a list, two of its words in a
   row, three of them scattered in a line, and its key as hex. */
function leakSearchFinds(): boolean {
  const phrase = newPaperPhrase();
  const list = words(phrase);
  const key = paperKeyOf(phrase).key;
  const hex = key.toString('hex');
  key.fill(0);
  const plants = [JSON.stringify(list), `note: ${list[3]} ${list[4]}`, `a ${list[9]} b c d ${list[1]} e f ${list[20]} g`, `k=${hex}`];
  const clean = leaks([{ name: 'clean', text: '{"v":1,"at":"2026-10-04T20:00:00.000Z","n":0123456789}' }], phrase).length === 0;
  return clean && plants.every((text) => leaks([{ name: 'plant', text }], phrase).length > 0);
}

async function main(): Promise<number> {
  if (process.argv.includes('--live')) return live();
  const finds = leakSearchFinds();
  console.log(`leak search self-test: finds a planted phrase, pair, scattered three and key: ${finds ? 'yes' : 'no'}`);
  if (!finds) return 1;
  if (!swiftc) {
    console.error('the crash matrix needs macOS with the developer tools: the vault service stand-in is compiled with swiftc');
    return 2;
  }
  const only = process.env.ONLY ?? null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-rekey-crash-'));
  const lines: string[] = [];
  try {
    for (const kind of ['migrate', 'restore'] as const) {
      for (const point of [1, 2, 3, 4, 5, 6, 7, 8] as Point[]) {
        if (only !== null && only !== `${kind}:${point}`) continue;
        const line = await runCase(kind, point, root);
        lines.push(line);
        console.log(line);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const passed = lines.filter((l) => l.startsWith('PASS')).length;
  console.log(`${passed}/${lines.length}`);
  return passed === lines.length && lines.length > 0 ? 0 : 1;
}

process.exitCode = await main();
