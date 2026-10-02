// The attack suite's shared machinery. It boots the real app the way the Tauri shell does, plays
// the hostile local process against it, and gives every attack case the same handful of primitives:
// an app on a throwaway data dir and a throwaway HOME, the browser half (HTTP with the window
// token), the agent half (a by-hand MCP proxy that reads agent.secret, which is the OUTSIDE seat),
// the audit log, and the health probe. Nothing here is mocked. The one thing it fakes is the shell:
// it mints the three handshake lines and holds the window token, which no route serves.
//
// Every case runs against a fresh app so one case cannot leave state for the next. Ports are
// picked free so cases can run beside each other and beside other worktrees.

import { spawn, spawnSync, type ChildProcessByStdio, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export type Json = any;

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Everything spawned is tracked so a crash or a Ctrl-C never strands a backend or an MCP child.
const LIVE = new Set<ChildProcess>();
const TEMPS = new Set<string>();
let hooksInstalled = false;

function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const killAll = (): void => {
    for (const p of LIVE) {
      try {
        if (p.exitCode === null) p.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  };
  process.on('exit', killAll);
  process.on('SIGINT', () => {
    killAll();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    killAll();
    process.exit(1);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `phos-attack-${prefix}-`));
  TEMPS.add(dir);
  return dir;
}

export function rmTemp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  TEMPS.delete(dir);
}

// A fresh HOME with nothing in it. Cases that care about what the boot leaves behind (vendor
// configs, the task list) seed it themselves and diff it afterwards.
export function fakeHome(): string {
  return tmpDir('home');
}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// The ad-hoc bundle this repo builds, if it is there. SIGNED-ONLY cases and anyone handing an
// --app override reach for cliApp() instead.
export function builtAppPath(): string | null {
  const p = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Phosphor.app');
  return fs.existsSync(p) ? p : null;
}

export function cliApp(): string | null {
  const i = process.argv.indexOf('--app');
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1] as string);
  return null;
}

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  return out;
}

export interface BootOpts {
  mode?: 'demo' | 'live';
  // Added on top of the inherited env, after stripEnv runs. This is how a case injects NODE_OPTIONS
  // and the like into the backend process it is attacking.
  env?: Record<string, string>;
  // Keys removed from the inherited env before env is applied.
  stripEnv?: string[];
  home?: string;
  dataDir?: string;
  // Bare `npm run app`: no shell above it, so no handshake. The app mints its own token and nobody
  // holds it, which is the no-shell case the model calls out.
  noHandshake?: boolean;
  port?: number;
  bootTimeoutMs?: number;
}

export interface PostOpts {
  // Override or drop headers. { origin: null } sends no Origin, which is what a sandboxed page is.
  headers?: Record<string, string | null>;
}

export interface Backend {
  proc: ChildProcessByStdio<Writable, Readable, Readable>;
  port: number;
  base: string;
  token: string;
  dataDir: string;
  home: string;
  // A read as the window makes it, with the window token. { headers: { 'x-phosphor-token': null } }
  // reads as a stranger does.
  get(route: string, opts?: PostOpts): Promise<{ status: number; json: Json; text: string }>;
  post(route: string, body: unknown, opts?: PostOpts): Promise<{ status: number; json: Json; text: string }>;
  mcpOutside(name?: string): Promise<{ client: Client; pid: number | null | undefined; close(): Promise<void> }>;
  callTool(client: Client, name: string, args?: Record<string, unknown>): Promise<Json>;
  auditLog(limit?: number): Promise<Json[]>;
  health(): Promise<Json>;
  createSoftwareWallet(password?: string): Promise<Json>;
  output(): string;
  stop(): Promise<void>;
}

export async function bootBackend(opts: BootOpts = {}): Promise<Backend> {
  installExitHooks();
  const port = opts.port ?? (await freePort());
  const base = `http://127.0.0.1:${port}`;
  // Dirs the harness makes are removed on stop(); dirs a case hands in are its own to keep.
  const autoDataDir = opts.dataDir === undefined;
  const autoHome = opts.home === undefined;
  const dataDir = opts.dataDir ?? tmpDir('data');
  const home = opts.home ?? fakeHome();
  const token = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  const seat = crypto.randomBytes(32).toString('hex');

  const base_env = cleanEnv();
  for (const k of opts.stripEnv ?? []) delete base_env[k];
  const env: Record<string, string> = {
    ...base_env,
    HOME: home,
    ACC_PORT: String(port),
    ACC_MODE: opts.mode ?? 'demo',
    ACC_DATA_DIR: dataDir,
    PHOSPHOR_DEMO_STAGE_SCALE: '0.2',
    ...(opts.env ?? {}),
  };

  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  LIVE.add(child);
  if (!opts.noHandshake) {
    child.stdin.write(`${token}\n${nonce}\n${seat}\n`);
  }
  child.stdin.end();
  const out: string[] = [];
  child.stdout.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr.on('data', (d: Buffer) => out.push(d.toString()));

  const children: ChildProcess[] = [];

  const api = {
    async get(route: string, o?: PostOpts) {
      // Every read under /api/ but health takes a credential (src/http/read-gate.ts).
      const headers: Record<string, string> = { 'x-phosphor-token': token };
      for (const [k, v] of Object.entries(o?.headers ?? {})) {
        if (v === null) delete headers[k];
        else headers[k] = v;
      }
      const res = await fetch(`${base}${route}`, { headers });
      const text = await res.text();
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    },
    async post(route: string, body: unknown, o?: PostOpts) {
      const headers: Record<string, string> = { 'content-type': 'application/json', origin: base };
      for (const [k, v] of Object.entries(o?.headers ?? {})) {
        if (v === null) delete headers[k];
        else headers[k] = v;
      }
      const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await res.text();
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    },
  };

  const backend: Backend = {
    proc: child,
    port,
    base,
    token,
    dataDir,
    home,
    get: api.get,
    post: api.post,
    output: () => out.join(''),
    async mcpOutside(name = 'attack-outside') {
      // The by-hand proxy: src/mcp.ts spawned with no PHOSPHOR_SEAT, so it reads agent.secret off
      // the data dir and seats OUTSIDE. This is the same process the agent-door model describes.
      const proxyEnv: Record<string, string> = { ...cleanEnv(), HOME: home, ACC_PORT: String(port), ACC_MODE: opts.mode ?? 'demo', ACC_DATA_DIR: dataDir };
      delete proxyEnv.PHOSPHOR_SEAT;
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp.ts')], cwd: ROOT, env: proxyEnv });
      const client = new Client({ name, version: '0.1.0' });
      await client.connect(transport);
      const pid = transport.pid;
      return {
        client,
        pid,
        async close() {
          try {
            await client.close();
          } catch {
            // transport already down
          }
          if (typeof pid === 'number') {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // already gone
            }
          }
        },
      };
    },
    async callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type: string; text?: string }> };
      const text = (res.content ?? []).map(c => c.text ?? '').join('');
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    async auditLog(limit = 500) {
      const r = await api.get(`/api/log?limit=${limit}`);
      return Array.isArray(r.json) ? r.json : [];
    },
    async health() {
      return (await api.get('/api/health')).json;
    },
    async createSoftwareWallet(password = 'a long enough password') {
      return (await api.post('/api/wallet/create', { token, password })).json;
    },
    async stop() {
      for (const c of children) {
        try {
          if (c.exitCode === null) c.kill('SIGKILL');
        } catch {
          // gone
        }
      }
      if (child.exitCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(2500)]);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await Promise.race([exited, sleep(1000)]);
        }
      }
      LIVE.delete(child);
      if (autoDataDir) rmTemp(dataDir);
      if (autoHome) rmTemp(home);
    },
  };

  const bootTimeout = opts.bootTimeoutMs ?? 20_000;
  const until = Date.now() + bootTimeout;
  let alive = false;
  while (Date.now() < until) {
    if (child.exitCode !== null) break; // died on boot
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        await res.text();
        alive = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(120);
  }
  if (!alive) {
    await backend.stop();
    throw new Error(`backend did not come up on ${base} within ${bootTimeout}ms\n${out.join('').slice(-2000)}`);
  }
  return backend;
}

// ---------- the Tauri shell (for the attacks that need the real desktop app spawning the node
// backend: env scrub, the inspector, the payload digest, screen lock) ----------
//
// It launches <app>/Contents/MacOS/phosphor-desktop the way macOS would, but points HOME, the port
// and the keys at throwaway paths so it never reaches the installed app's data dir, ~/.phosphor, or
// port 4177. PHOSPHOR_DATA_DIR is derived by the shell from HOME (Tauri app_data_dir), which is why
// a fake HOME isolates it; launchShell verifies the spawned backend's data dir really landed under
// the throwaway HOME and refuses to go on otherwise.

const APP_IDENTIFIER = 'com.karimbabasf.phosphor';

export interface ShellOpts {
  app: string;
  // Extra env for the SHELL process. This is how an env-injection case plants NODE_OPTIONS, DYLD_*,
  // NODE_PATH and the like in the shell's own environment to see whether the sidecar inherits them.
  env?: Record<string, string>;
  mode?: 'demo' | 'live';
  port?: number;
  // false when the attack expects NO backend to spawn (a tampered payload). Then launchShell waits
  // the grace and returns with no sidecar instead of failing.
  expectSpawn?: boolean;
  bootTimeoutMs?: number;
}

export interface Shell {
  app: string;
  shellPid: number;
  port: number;
  base: string;
  home: string;
  dataDir: string;
  keysPath: string;
  get(route: string): Promise<{ status: number; json: Json; text: string }>;
  post(route: string, body: unknown, opts?: PostOpts): Promise<{ status: number; json: Json; text: string }>;
  mcpOutside(name?: string): Promise<{ client: Client; pid: number | null | undefined; close(): Promise<void> }>;
  callTool(client: Client, name: string, args?: Record<string, unknown>): Promise<Json>;
  sidecarPids(): number[];
  sidecarCmdline(pid: number): string;
  sidecarEnvRaw(pid: number): string;
  output(): string;
  stop(): Promise<void>;
}

function pidsForBundleNode(app: string): number[] {
  const marker = path.join(app, 'Contents', 'MacOS', 'node');
  const out = spawnSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' });
  return (out.stdout ?? '')
    .split('\n')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);
}

export async function launchShell(opts: ShellOpts): Promise<Shell> {
  installExitHooks();
  const app = opts.app;
  const shellBin = path.join(app, 'Contents', 'MacOS', 'phosphor-desktop');
  if (!fs.existsSync(shellBin)) throw new Error(`no shell binary at ${shellBin}`);
  const port = opts.port ?? (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const home = tmpDir('shell-home');
  const keysPath = path.join(tmpDir('shell-keys'), 'keys.enc.json');
  const dataDir = path.join(home, 'Library', 'Application Support', APP_IDENTIFIER);
  const expectSpawn = opts.expectSpawn !== false;

  const env: Record<string, string> = {
    ...cleanEnv(),
    HOME: home,
    PHOSPHOR_PORT: String(port),
    PHOSPHOR_MODE: opts.mode ?? 'demo',
    ACC_MODE: opts.mode ?? 'demo',
    PHOSPHOR_KEYS: keysPath,
    ...(opts.env ?? {}),
  };

  const child = spawn(shellBin, [], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  LIVE.add(child);
  const out: string[] = [];
  child.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => out.push(d.toString()));
  const shellPid = child.pid ?? -1;

  const api = {
    async get(route: string) {
      const res = await fetch(`${base}${route}`);
      const text = await res.text();
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    },
    async post(route: string, body: unknown, o?: PostOpts) {
      const headers: Record<string, string> = { 'content-type': 'application/json', origin: base };
      for (const [k, v] of Object.entries(o?.headers ?? {})) {
        if (v === null) delete headers[k];
        else headers[k] = v;
      }
      const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await res.text();
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    },
  };

  const killTree = (): void => {
    for (const p of [shellPid, ...pidsForBundleNode(app)]) {
      try {
        if (p > 0) process.kill(p, 'SIGKILL');
      } catch {
        // gone
      }
    }
  };

  const shell: Shell = {
    app,
    shellPid,
    port,
    base,
    home,
    dataDir,
    keysPath,
    get: api.get,
    post: api.post,
    sidecarPids: () => pidsForBundleNode(app),
    sidecarCmdline(pid: number) {
      return (spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim();
    },
    sidecarEnvRaw(pid: number) {
      // BSD ps prints the process environment with the `e` flag. Values with spaces are not escaped,
      // so cases match on `NAME=` tokens rather than parsing into a map.
      return (spawnSync('/bin/ps', ['eww', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim();
    },
    output: () => out.join(''),
    async callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type: string; text?: string }> };
      const text = (res.content ?? []).map(c => c.text ?? '').join('');
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    async mcpOutside(name = 'attack-shell-outside') {
      const proxyEnv: Record<string, string> = { ...cleanEnv(), HOME: home, PHOSPHOR_PORT: String(port), PHOSPHOR_MODE: opts.mode ?? 'demo', ACC_MODE: opts.mode ?? 'demo', PHOSPHOR_DATA_DIR: dataDir };
      delete proxyEnv.PHOSPHOR_SEAT;
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp.ts')], cwd: ROOT, env: proxyEnv });
      const client = new Client({ name, version: '0.1.0' });
      await client.connect(transport);
      const pid = transport.pid;
      return {
        client,
        pid,
        async close() {
          try {
            await client.close();
          } catch {
            // down
          }
          if (typeof pid === 'number') {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // gone
            }
          }
        },
      };
    },
    async stop() {
      killTree();
      await sleep(400);
      // One more sweep in case a sidecar reparented to launchd.
      spawnSync('/usr/bin/pkill', ['-9', '-f', path.join(app, 'Contents', 'MacOS', 'node')]);
      LIVE.delete(child);
      rmTemp(home);
      rmTemp(path.dirname(keysPath));
    },
  };

  const deadline = Date.now() + (opts.bootTimeoutMs ?? 25_000);
  let sidecar = -1;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && expectSpawn) break;
    const pids = pidsForBundleNode(app);
    if (pids.length > 0) {
      sidecar = pids[0] as number;
      break;
    }
    await sleep(150);
  }

  if (expectSpawn) {
    if (sidecar < 0) {
      await shell.stop();
      throw new Error(`shell did not spawn a backend within the grace\n${out.join('').slice(-1500)}`);
    }
    // SAFETY GATE: the spawned backend must be pointed at the throwaway HOME, never the real data
    // dir. If it is not, something about HOME resolution changed; stop at once and do not proceed.
    const raw = shell.sidecarEnvRaw(sidecar);
    if (!raw.includes(`PHOSPHOR_DATA_DIR=${home}`)) {
      await shell.stop();
      throw new Error(`refusing to run: backend data dir is not under the throwaway HOME (${home}); ps showed it elsewhere`);
    }
    // Wait for the backend to answer, so cases can drive it.
    const healthUntil = Date.now() + 15_000;
    while (Date.now() < healthUntil) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) {
          await res.text();
          break;
        }
      } catch {
        // not up yet
      }
      await sleep(150);
    }
  }

  return shell;
}
