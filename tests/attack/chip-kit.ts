// The chip vault's attack kit (cases 30 to 35). It runs the app's own backend (node src/main.ts) the
// way scripts/rekey-crash.ts does, with nothing real under it:
//   the Mac's keychain and enclave are the vault service's own rules compiled with the stand-in
//     keychain (tests/unit/helpers/vault-double.ts): a JSON file in the case's scratch dir, a
//     software chip key, every Touch ID recorded as the sentence it would have shown, none raised;
//   the shell is a relay loop this kit runs with the relay secret, the way src-tauri/src/enclave.rs
//     drains POST /api/vault/pending;
//   the chain is the intents double (tests/unit/helpers/intents-double.ts) served over HTTP as the
//     NEAR RPC. A preload points the backend's NEAR RPC at it and refuses every other host: fetch,
//     WebSocket and https alike, so a case holds offline and nothing reaches mainnet.
// It also builds vault payloads by hand (not with the app's builder, so a case does not inherit a
// bug it is meant to catch), lists an MCP seat's tools, and reads the router's vault routes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { base58Encode, nearChainSpec } from '../../src/chain/near.ts';
import type { VerifierEvent } from '../../src/relay/verifier.ts';
import { createIntentsDouble } from '../unit/helpers/intents-double.ts';
import type { IntentsDouble } from '../unit/helpers/intents-double.ts';
import { VaultDouble, relayTo } from '../unit/helpers/vault-double.ts';
import type { Hook, Request } from '../unit/helpers/vault-double.ts';
import { ROOT, bootBackend, sleep, tmpDir } from './harness.ts';
import type { Backend, Json } from './harness.ts';

export { swiftc } from '../unit/helpers/vault-double.ts';
export type { Request } from '../unit/helpers/vault-double.ts';

const HALF_NEAR = 500_000_000_000_000_000_000_000n;

// The service ops that write the keychain or put a Touch ID in front of the owner. probe, status and
// chipStatus only read.
export const WRITE_OPS: ReadonlySet<string> = new Set(['create', 'unwrap', 'presence', 'commit', 'sweep', 'chipCreate', 'chipCommit', 'chipSweep', 'signIntent']);
export const CHIP_WRITES: ReadonlySet<string> = new Set(['chipCreate', 'chipCommit', 'chipSweep']);

// ---------- the chain, over HTTP (scripts/rekey-crash.ts chainServer, without its kill traps) ----------

function chainServer(chain: IntentsDouble) {
  const rpc = nearChainSpec().rpcUrl;
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
    const res = await chain.near.fetchImpl(rpc, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 'phosphor', method, params }) } as RequestInit);
    return (await res.json()) as Json;
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        if (Date.now() > chain.now()) chain.advance(Date.now() - chain.now());
        let request: Json;
        try {
          request = JSON.parse(body) as Json;
        } catch {
          res.writeHead(400).end();
          return;
        }
        let answer: Json;
        try {
          answer = await call(String(request.method), (request.params as Json) ?? {});
        } catch (err) {
          answer = { error: { name: 'HANDLER_ERROR', cause: { name: 'INTERNAL_ERROR', info: {} }, code: -32000, message: String(err), data: String(err) } };
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...answer }));
      })();
    });
  });

  return {
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/* Loaded into the backend with --import. Every outside host is refused and written to a file the
   case reads: the NEAR RPC goes to the chain double, 127.0.0.1 is let through. */
function preload(nearRpc: string): string {
  return `// Written by tests/attack/chip-kit.ts into a case's scratch dir; never part of the app.
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
const target = process.env.PHOSPHOR_ATTACK_RPC;
const record = process.env.PHOSPHOR_ATTACK_OUTSIDE;
const note = (what) => { try { fs.appendFileSync(record, what + '\\n'); } catch {} };
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(${JSON.stringify(nearRpc)})) return real(target, init);
  if (url.startsWith('http://127.0.0.1')) return real(input, init);
  note('fetch ' + url.slice(0, 120));
  throw new TypeError('fetch failed: an attack case reaches no outside host');
};
globalThis.WebSocket = class {
  constructor(url) {
    note('websocket ' + String(url).slice(0, 120));
    this.readyState = 3;
    setTimeout(() => { this.onerror?.({ message: 'no outside host' }); this.onclose?.({ code: 1006 }); }, 0);
  }
  addEventListener(name, fn) { this['on' + name] = fn; }
  removeEventListener() {}
  send() {}
  close() {}
};
for (const mod of [https]) {
  for (const verb of ['request', 'get']) {
    mod[verb] = (...args) => { note('https ' + String(args[0]?.hostname ?? args[0]?.host ?? args[0]).slice(0, 120)); throw new Error('an attack case reaches no outside host'); };
  }
}
tls.connect = (...args) => { note('tls ' + String(args[0]?.host ?? args[0]).slice(0, 120)); throw new Error('an attack case reaches no outside host'); };
`;
}

// ---------- the app on the stand-in Mac ----------

export type ChipApp = {
  app: Backend;
  chain: IntentsDouble;
  mac: VaultDouble;
  // Every request the shell took off the relay, in order.
  seen: Request[];
  // Every answer the shell posted back, and how the backend took it.
  answers: { id: string; status: number }[];
  // Hosts the preload refused (empty when the case held offline).
  outside(): string[];
  // A write and a read as the window makes them, with the window token.
  post(route: string, body?: Json): Promise<{ status: number; json: Json; text: string }>;
  get(route: string): Promise<{ status: number; json: Json; text: string }>;
  // A post with no credential added: what a stranger, or an agent, sends.
  raw(route: string, body: Json, headers?: Record<string, string | null>): Promise<{ status: number; json: Json; text: string }>;
  // The relay loop, when the case booted without it.
  startShell(): void;
  stop(): Promise<void>;
};

export type ChipAppOpts = {
  // PHOSPHOR_DEMO_ENCLAVE=1: the relay may make keys and the move to the chip is installed.
  enclave: boolean;
  mode?: 'demo' | 'live';
  // false: boot with no shell polling, so requests wait until startShell().
  shell?: boolean;
  hook?: (r: Request) => Hook | Promise<Hook> | undefined | Promise<undefined>;
  chain?: IntentsDouble;
  mac?: VaultDouble;
  // A dir the case keeps across a restart (the harness leaves dirs it was handed).
  dataDir?: string;
  home?: string;
  scratch: string;
};

export async function chipApp(opts: ChipAppOpts): Promise<ChipApp> {
  const chain = opts.chain ?? createIntentsDouble({ start: Date.now() });
  const mac = opts.mac ?? new VaultDouble(path.join(opts.scratch, `keychain-${crypto.randomBytes(4).toString('hex')}.json`));
  const rpc = chainServer(chain);
  const rpcUrl = await rpc.start();
  const kit = fs.mkdtempSync(path.join(opts.scratch, 'kit-'));
  const preloadFile = path.join(kit, 'preload.mjs');
  fs.writeFileSync(preloadFile, preload(nearChainSpec().rpcUrl));
  const outsideFile = path.join(kit, 'outside.txt');
  let app: Backend;
  try {
    app = await bootBackend({
      mode: opts.mode ?? 'demo',
      relay: true,
      stripEnv: ['PHOSPHOR_DEMO_ENCLAVE', 'NODE_OPTIONS', 'PHOSPHOR_SEAT'],
      env: {
        NODE_OPTIONS: `--import ${pathToFileURL(preloadFile).href}`,
        PHOSPHOR_ATTACK_RPC: rpcUrl,
        PHOSPHOR_ATTACK_OUTSIDE: outsideFile,
        ...(opts.enclave ? { PHOSPHOR_DEMO_ENCLAVE: '1' } : {}),
      },
      ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      bootTimeoutMs: 40_000,
    });
  } catch (err) {
    await rpc.stop();
    throw err;
  }
  const secret = app.relaySecret!;
  const answers: { id: string; status: number }[] = [];
  const shellPost = async (route: string, body: Record<string, unknown>) => {
    const r = await app.post(route, { relay: secret, ...body });
    if (route === '/api/vault/answer') answers.push({ id: String(body.id), status: r.status });
    return r;
  };
  let shell: ReturnType<typeof relayTo> | null = null;
  const seen: Request[] = [];
  const startShell = (): void => {
    if (shell !== null) return;
    shell = relayTo(shellPost, mac, app.transportKey!, async (r) => {
      mac.now = Math.floor(Date.now() / 1000);
      seen.push(r);
      return (await opts.hook?.(r)) ?? { kind: 'run' };
    });
  };
  if (opts.shell !== false) startShell();

  const post = (route: string, body: Json = {}) => app.post(route, { token: app.token, ...body });
  return {
    app,
    chain,
    mac,
    seen,
    answers,
    outside: () => (fs.existsSync(outsideFile) ? fs.readFileSync(outsideFile, 'utf8').split('\n').filter((l) => l !== '') : []),
    post,
    get: (route) => app.get(route),
    raw: (route, body, headers = {}) => app.post(route, body, { headers }),
    startShell,
    async stop() {
      const s = shell as ReturnType<typeof relayTo> | null;
      shell = null;
      try {
        await app.stop();
      } finally {
        await s?.stop().catch(() => undefined);
        await rpc.stop();
      }
    },
  };
}

export async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, tries = 600, everyMs = 50): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (ok(last)) return last;
    await sleep(everyMs);
  }
  throw new Error(`${what}: still ${JSON.stringify(last).slice(0, 400)}`);
}

export async function chipState(c: ChipApp): Promise<Json> {
  return (await c.get('/api/state')).json?.vault?.chip ?? {};
}

/* A Touch ID wallet made by the window, opened, its backup proven by three words, its gas funded
   (scripts/rekey-crash.ts newWallet). */
export async function openWallet(c: ChipApp): Promise<{ vault: string; mnemonic: string; gas: string }> {
  for (let i = 0; i < 100; i += 1) {
    if ((await c.get('/api/vault')).json?.enclave?.ready === true) break;
    await sleep(50);
  }
  const made = await c.post('/api/vault/create');
  if (made.json?.ok !== true) throw new Error(`create: ${JSON.stringify(made.json)}`);
  await unlock(c);
  const revealed = await c.post('/api/vault/reveal');
  if (revealed.json?.ok !== true) throw new Error(`reveal: ${JSON.stringify(revealed.json)}`);
  const list = revealed.json.words as string[];
  const proven = await c.post('/api/vault/backup-proven', { words: (revealed.json.prove as number[]).map((index) => ({ index, word: list[index] })) });
  if (proven.json?.ok !== true) throw new Error(`backup: ${JSON.stringify(proven.json)}`);
  const gas = (await until('the gas account', () => chipState(c), (s) => typeof s.gas?.account === 'string')).gas.account as string;
  c.chain.fundGas(gas, HALF_NEAR);
  return { vault: String(made.json.addresses.evm).toLowerCase(), mnemonic: list.join(' '), gas };
}

export async function unlock(c: ChipApp): Promise<void> {
  if ((await c.get('/api/vault')).json?.state === 'unlocked') return;
  const opened = await c.post('/api/vault/unlock');
  if (opened.json?.ok !== true) throw new Error(`unlock: ${JSON.stringify(opened.json)}`);
}

/* The move to the chip through the window's own routes: the paper shown, typed back, the move run
   to its end. Returns the run's end and the pins the Vault tab shows. */
export async function moveVault(c: ChipApp): Promise<{ ended: string; chip: Json }> {
  const shown = await c.post('/api/vault/chip/phrase');
  if (shown.json?.ok !== true) throw new Error(`phrase: ${JSON.stringify(shown.json)}`);
  const proven = await c.post('/api/vault/chip/phrase-proven', { words: shown.json.words });
  if (proven.json?.ok !== true) throw new Error(`phrase-proven: ${JSON.stringify(proven.json)}`);
  const started = await c.post('/api/vault/chip/move');
  if (started.status !== 202) throw new Error(`move: ${started.status} ${JSON.stringify(started.json)}`);
  const run = String(started.json.run);
  const s = await until('the move', () => chipState(c), (x) => x.run?.id === run && (x.run.status === 'done' || x.run.status === 'failed'), 1200);
  return { ended: s.run.reason === null ? s.run.status : `${s.run.status} ${s.run.reason}`, chip: s };
}

// ---------- vault payloads, built by hand ----------

export const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const U128_MAX = '340282366920938463463374607431768211455';
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/* A V1 nonce: 5628f6c6 00, a salt, its expiry in nanoseconds (i64 little-endian), 15 random bytes. */
export function nonce(expiryMs: number): string {
  const out = Buffer.alloc(32);
  out.set([0x56, 0x28, 0xf6, 0xc6, 0x00], 0);
  out.set([0x25, 0x28, 0x12, 0xb3], 5);
  out.writeBigInt64LE(BigInt(expiryMs) * 1_000_000n, 9);
  crypto.randomBytes(15).copy(out, 17);
  return out.toString('base64');
}

/* A vault payload as JSON.stringify writes it. `nonceLifeMs` is how long the nonce lives past the
   deadline: seven days is the one life the grammar takes. */
export function vaultPayload(o: { signer: string; deadlineMs: number; intents: unknown[]; nonceLifeMs?: number; verifying?: string }): string {
  return JSON.stringify({
    signer_id: o.signer,
    verifying_contract: o.verifying ?? 'intents.near',
    deadline: new Date(o.deadlineMs).toISOString(),
    nonce: nonce(o.deadlineMs + (o.nonceLifeMs ?? SEVEN_DAYS_MS)),
    intents: o.intents,
  });
}

export const transfer = (asset: string, amount: unknown, receiver: string) => ({ intent: 'transfer', receiver_id: receiver, tokens: { [asset]: amount } });

export function secpKey(fill: number): string {
  return `secp256k1:${base58Encode(Buffer.alloc(64, fill))}`;
}

// ---------- the agent's side ----------

/* The tools one MCP seat is offered, as src/mcp.ts registers them: `env` names the seat
   (PHOSPHOR_SEAT for one the app spawned, none for the by-hand proxy that reads agent.secret) and
   the role. tools/list is answered by the proxy itself. */
export async function toolsOf(env: Record<string, string>): Promise<{ name: string; inputSchema: unknown }[]> {
  const home = tmpDir('tools-home');
  const proxyEnv: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, ACC_MODE: 'demo', ...env };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp.ts')], cwd: ROOT, env: proxyEnv, stderr: 'ignore' });
  const client = new Client({ name: 'attack-tools', version: '0.1.0' });
  await client.connect(transport);
  const pid = transport.pid;
  try {
    return (await client.listTools()).tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema }));
  } finally {
    await client.close().catch(() => undefined);
    if (typeof pid === 'number') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* Every POST route under /api/vault: the keys of router.ts's POST table, and every '/api/vault...'
   a route file under src/http names to guarded() or the relay's guard. A route added later is in
   this list without anyone adding it to a case. */
export function vaultPostRoutes(): string[] {
  const router = fs.readFileSync(path.join(ROOT, 'src', 'http', 'router.ts'), 'utf8');
  const start = router.indexOf('const POST: Record<string, Route> = {');
  if (start < 0) throw new Error('router.ts has no POST table where the kit looks for one');
  const table = router.slice(start, router.indexOf('\n};', start));
  const routes = new Set<string>();
  for (const m of table.matchAll(/^\s*'(\/api\/vault(?:\/[^']*)?)'\s*:/gm)) routes.add(m[1]!);
  const dir = path.join(ROOT, 'src', 'http');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/(?:guarded|relayGuarded)\(\s*ctx\s*,\s*'(\/api\/vault(?:\/[^']*)?)'/g)) routes.add(m[1]!);
  }
  return [...routes].sort();
}
