// The demo backend the harness drives: a staged copy of the repo, one app per scene on a free
// port with a throwaway data directory, and the doors the harness knocks on.
//
// Staged, as scripts/eval.ts stages it, because two things are read off the tree rather than off
// the data directory: data/demo-state.json (the demo ledger reads it beside its own file, and a
// scene's balances cannot be set any other way) and config.json (driver.claudeBin has to point
// at the harness's own agent, never at the claude binary on this machine). Nothing here touches
// ~/.phosphor, the installed app's port or the real keystore.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { hashLine } from '../../src/audit.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { venueAllowlist } from '../../src/rails/index.ts';
import { TURN_FILE, type Turn } from './agent.ts';

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export type Json = any;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') out[key] = value;
  return out;
}

// ---------- the staged repo ----------

const STAGE_COPY = ['src', 'tests', 'scripts', 'operator', 'data', 'skills', 'ui', 'package.json', 'tsconfig.json', 'config.json'];

export function stageRepo(): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-anxiety-stage-'));
  for (const entry of STAGE_COPY) {
    const from = path.join(ROOT, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(stage, entry), { recursive: true, dereference: false });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(stage, 'node_modules'));
  const agent = path.join(stage, 'scripts', 'anxiety', 'agent.ts');
  fs.chmodSync(agent, 0o755);
  const cfgPath = path.join(stage, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  cfg.driver = { claudeBin: agent };
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  /* THE HOME THE APP RUNS UNDER, and why there is one. loadConfig (src/config.ts) drops the
     `driver` block on the floor, so the claudeBin written above reaches nobody and the window's
     chat spawns whatever `claude` src/driver.ts finds: the first place it looks is
     $HOME/.local/bin/claude. A scratch HOME with the scripted agent at that path is what keeps
     the real Claude Code, and the subscription behind it, out of a screenshot run. Nothing of
     the real home directory is read or written by a demo backend given its own data dir. */
  const home = path.join(stage, 'home');
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)} "$@"\n`, { mode: 0o755 });
  return stage;
}

export function stageHome(stage: string): string {
  return path.join(stage, 'home');
}

// ---------- what a scene starts from ----------

export type DemoHolding = { symbol: string; originChain: string; assetId: string; amount: number; decimals: number };

export type DemoState = {
  prices?: Record<string, number>;
  account?: string;
  intents?: DemoHolding[];
  hyperliquid?: { collateralUsdc: number; availableUsdc: number };
};

export type Seed = {
  demo?: DemoState;
  // Merged over the policy file main.ts would have seeded, so a scene that names one threshold
  // does not silently rewrite every other rule.
  policy?: Record<string, unknown>;
  // Rows written into proposals.json before boot. `{ agoSec }` anywhere becomes a real stamp.
  proposals?: Array<Record<string, unknown>>;
  audit?: Array<{ type: string; msg: string; data?: unknown; agoSec?: number }>;
  // Demo knobs (src/rails/demo.ts): stage scale, the stall, the deadline.
  env?: Record<string, string>;
  // A wallet and the terms, made before the window opens. False for the onboarding rows.
  wallet?: boolean;
};

export const DEFAULT_DEMO = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'demo-state.json'), 'utf8')) as DemoState;

export function writeDemoState(stage: string, demo: DemoState | undefined): void {
  const merged = { ...DEFAULT_DEMO, ...(demo ?? {}) };
  fs.writeFileSync(path.join(stage, 'data', 'demo-state.json'), `${JSON.stringify(merged, null, 2)}\n`);
}

export function resolveStamps(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveStamps(item, now));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (typeof inner === 'object' && inner !== null && typeof (inner as Json).agoSec === 'number') {
      out[key] = new Date(now - (inner as Json).agoSec * 1000).toISOString();
      continue;
    }
    out[key] = resolveStamps(inner, now);
  }
  return out;
}

export function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && !Array.isArray(current)
        ? mergeDeep(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

export function seedDataDir(dataDir: string, seed: Seed): void {
  const now = Date.now();
  fs.mkdirSync(dataDir, { recursive: true });
  const rows = (seed.proposals ?? []).map((row) => resolveStamps(row, now));
  if (rows.length > 0) fs.writeFileSync(path.join(dataDir, 'proposals.json'), `${JSON.stringify(rows, null, 2)}\n`);
  if (seed.policy !== undefined) {
    const seeded = defaultPolicy();
    seeded.outbound.destinationAllowlist = venueAllowlist();
    const merged = mergeDeep(seeded as unknown as Record<string, unknown>, seed.policy);
    (merged as Json).sentences = renderSentences(merged as Json);
    fs.writeFileSync(path.join(dataDir, 'policy.json'), `${JSON.stringify(merged, null, 2)}\n`);
  }
  const lines = seed.audit ?? [];
  if (lines.length > 0) {
    let prev: string | null = null;
    const out: string[] = [];
    for (const line of lines) {
      const event = { ts: new Date(now - (line.agoSec ?? 0) * 1000).toISOString(), type: line.type, msg: line.msg, data: line.data ?? null, prev };
      const text = JSON.stringify(event);
      out.push(text);
      prev = hashLine(text);
    }
    fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), `${out.join('\n')}\n`);
  }
}

// ---------- one app ----------

type AppProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export type App = {
  stage: string;
  port: number;
  base: string;
  token: string;
  dataDir: string;
  output: string[];
  seat(): string;
  post(route: string, body: Record<string, unknown>): Promise<{ status: number; json: Json }>;
  get(route: string): Promise<Json>;
  state(): Promise<Json>;
  // The agent door, as a session of the harness's own (a colleague, never the window's chat).
  mcp(op: 'view' | 'read' | 'propose', tool: string, args: Record<string, unknown>): Promise<{ status: number; json: Json }>;
  // The window's conversation: the scripted agent plays `turn` when `text` is sent.
  chat(text: string, turn: Turn, opts?: { timeoutMs?: number }): Promise<void>;
  // The finger. Both routes carry the window token, which never leaves this process.
  approve(id: string): Promise<{ status: number; json: Json }>;
  refuse(id: string): Promise<{ status: number; json: Json }>;
  // The row's view as /api/state carries it, or null.
  view(id: string): Promise<Json | null>;
  // Waits until the row's stage is `stage` (or one of them). Throws past the deadline.
  waitStage(id: string, stage: string | string[], timeoutMs: number): Promise<Json>;
  stop(): Promise<void>;
};

export const WALLET_PASSWORD = 'anxiety-eval-password-1';

// Every backend this process started and has not stopped, so an interrupted run leaves none.
const running = new Set<App>();

export async function stopAll(): Promise<void> {
  for (const app of [...running]) await app.stop().catch(() => undefined);
}

export async function bootApp(stage: string, seed: Seed): Promise<App> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-anxiety-data-'));
  seedDataDir(dataDir, seed);
  writeDemoState(stage, seed.demo);
  fs.rmSync(path.join(stage, TURN_FILE), { force: true });

  const token = crypto.randomBytes(32).toString('hex');
  const output: string[] = [];
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: stage,
    env: { ...cleanEnv(), HOME: stageHome(stage), PHOSPHOR_PORT: String(port), PHOSPHOR_MODE: 'demo', PHOSPHOR_DATA_DIR: dataDir, ...(seed.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as AppProcess;
  child.stdin.write(`${token}\n`);
  child.stdin.end();
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const until = Date.now() + 20_000;
  let up = false;
  while (Date.now() < until) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/api/state`);
      if (res.ok) {
        await res.json();
        up = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(100);
  }

  const stop = async (): Promise<void> => {
    running.delete(app);
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(2500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  if (!up) {
    await stop();
    throw new Error(`the app did not boot on ${base}: ${output.join('').slice(-600)}`);
  }

  const post = async (route: string, body: Record<string, unknown>): Promise<{ status: number; json: Json }> => {
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    });
    let json: Json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  const get = async (route: string): Promise<Json> => await (await fetch(`${base}${route}`)).json();
  const seat = (): string => {
    const file = path.join(dataDir, 'agent.secret');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  };
  const state = (): Promise<Json> => get('/api/state');
  const view = async (id: string): Promise<Json | null> => {
    const rows = ((await state()).proposals as Json[]) ?? [];
    const row = rows.find((p) => p.id === id);
    return row?.view ?? null;
  };

  let chatOpened = false;
  const app: App = {
    stage,
    port,
    base,
    token,
    dataDir,
    output,
    seat,
    post,
    get,
    state,
    mcp: (op, tool, args) => post('/api/mcp', { op, tool, args, session: 'anxiety-eval', client: 'anxiety-eval', label: 'anxiety-eval', secret: seat() }),
    approve: (id) => post('/api/approve', { id, token }),
    refuse: (id) => post('/api/refuse', { id, token }),
    view,
    waitStage: async (id, stage, timeoutMs) => {
      const want = Array.isArray(stage) ? stage : [stage];
      const deadline = Date.now() + timeoutMs;
      let last: Json = null;
      while (Date.now() < deadline) {
        last = await view(id);
        if (last !== null && want.includes(String(last.stage))) return last;
        await sleep(100);
      }
      throw new Error(`proposal ${id} never reached ${want.join(' or ')} inside ${timeoutMs} ms (last: ${last?.stage ?? 'no row'})`);
    },
    chat: async (text, turn, opts) => {
      fs.writeFileSync(path.join(stage, TURN_FILE), `${JSON.stringify(turn)}\n`);
      const before = await get('/api/driver');
      const running = before?.running === true || before?.state === 'ready' || before?.state === 'thinking';
      if (!running) {
        const started = await post('/api/driver', { action: chatOpened ? 'start' : 'open', token });
        if (started.status !== 200) throw new Error(`the chat did not open: ${started.status} ${JSON.stringify(started.json)}`);
        chatOpened = true;
        await waitDriver(get, ['ready'], 10_000);
      }
      const sent = await post('/api/driver', { action: 'prompt', text, token });
      if (sent.status !== 200) throw new Error(`the prompt was refused: ${sent.status} ${JSON.stringify(sent.json)}`);
      await waitDriver(get, ['thinking'], 3_000).catch(() => undefined);
      await waitDriver(get, ['ready'], opts?.timeoutMs ?? 60_000);
    },
    stop,
  };
  running.add(app);
  return app;
}

async function waitDriver(get: (route: string) => Promise<Json>, states: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const payload = await get('/api/driver');
    last = String(payload?.state ?? '');
    if (states.includes(last)) return;
    if (last === 'failed') throw new Error(`the in-app driver failed: ${String(payload?.detail ?? '')}`);
    await sleep(80);
  }
  throw new Error(`the in-app driver never reached ${states.join('/')} inside ${timeoutMs} ms (last: ${last})`);
}

/* The wallet and the terms, through the same routes the window uses, so the page opens on Basic
   in the state a person is in after onboarding: terms accepted, a software wallet made, and the
   recovery words proven backed up (the prove step), so the backup nudge is not on the screen
   of every card row. */
export async function makeWallet(app: App): Promise<void> {
  const terms = await app.post('/api/terms/accept', { token: app.token });
  if (terms.status !== 200) throw new Error(`terms accept refused: ${terms.status} ${JSON.stringify(terms.json)}`);
  const created = await app.post('/api/wallet/create', { token: app.token, password: WALLET_PASSWORD });
  if (created.status !== 200) throw new Error(`wallet create refused: ${created.status} ${JSON.stringify(created.json)}`);
  const mnemonic = Array.isArray(created.json?.mnemonic) ? (created.json.mnemonic as string[]) : [];
  if (mnemonic.length >= 3) {
    const proven = await app.post('/api/vault/backup-proven', { token: app.token, words: [0, 5, 11].map((index) => ({ index, word: mnemonic[index] })) });
    if (proven.status !== 200 || proven.json?.ok !== true) throw new Error(`backup-proven refused: ${proven.status} ${JSON.stringify(proven.json)}`);
  }
}
