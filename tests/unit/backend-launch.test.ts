// How the shell starts the process that holds the keys: the Node flags and the environment.
//
// src-tauri/src/backend.rs builds the command in backend_command: NODE_FLAGS before the entry
// point, env_clear(), then BACKEND_ENV by name and the three names the shell sets itself. Its
// Rust tests run that exact command against a probe payload with a hostile environment. This file
// holds the other half together: that the list in Rust is the list src/ actually reads, and that
// the real backend boots, and stays shut, under exactly that launch.
//
// What the two closed: Node opens an unauthenticated inspector on SIGUSR1, which any process this
// user runs can send, and NODE_OPTIONS (planted by `launchctl setenv`, or a shell) loads code into
// the process at boot. Either one reads the unwrapped key while the wallet is open.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WINDOW_TOKEN_VAR } from '../../src/http/auth.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const BACKEND_RS = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'backend.rs'), 'utf8');

function quoted(block: string): string[] {
  const code = block.replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function nodeFlags(): string[] {
  const list = /pub const NODE_FLAGS: \[&str; \d+\] = \[([^\]]*)\];/.exec(BACKEND_RS)?.[1];
  assert.ok(list !== undefined, 'backend.rs declares NODE_FLAGS');
  return quoted(list);
}

function backendEnv(): string[] {
  const list = /const BACKEND_ENV: &\[&str\] = &\[([\s\S]*?)\];/.exec(BACKEND_RS)?.[1];
  assert.ok(list !== undefined, 'backend.rs declares BACKEND_ENV');
  return quoted(list);
}

function backendCommandBody(): string {
  const start = BACKEND_RS.indexOf('fn backend_command(');
  assert.ok(start > 0, 'backend.rs has backend_command');
  return BACKEND_RS.slice(start, BACKEND_RS.indexOf('\n}\n', start));
}

// The names backend_command sets itself rather than passing on.
function setByShell(): string[] {
  return [...backendCommandBody().matchAll(/\.env\("([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

/* ---------- what src/ reads, derived from the code ----------

   Every file the backend loads, from src/main.ts down its relative imports, and every name read
   in one of the shapes this codebase uses: process.env.X, env.X or parent.X, a bracket read with
   a literal or with a constant declared as const NAME = 'X', config.ts's env('X', 'Y') helper, the
   *_ENV name arrays (INHERITED_ENV, PROBE_ENV) and the agent catalog's homeEnv. Writes into a
   child's environment (env.X = ...) are not reads and are skipped. src/mcp.ts and
   src/runner/main.ts are other processes with environments of their own, and are not reached. */
function backendFiles(): string[] {
  const seen = new Set<string>();
  const stack = [path.join(ROOT, 'src', 'main.ts')];
  const spec = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(spec)) stack.push(path.resolve(path.dirname(file), m[1] ?? m[2]));
  }
  return [...seen];
}

function namesTheBackendReads(): Map<string, Set<string>> {
  const files = backendFiles();
  const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const constants = new Map<string, string>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([A-Z][A-Z0-9_]+)'/g)) constants.set(m[1], m[2]);
  }
  const found = new Map<string, Set<string>>();
  const add = (name: string, file: string): void => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name)?.add(path.relative(ROOT, file));
  };
  // An assignment or a delete changes a child's environment; neither one reads this process's.
  const notWrite = '(?!\\s*=[^=])';
  const notDelete = '(?<!\\bdelete\\s+)';
  // Not after a dot, so process.env.X is matched once, as process.env, and never again as env.
  const holder = `${notDelete}(?<!\\.)\\b(?:process\\.env|env|parent)`;
  for (const [file, source] of sources) {
    for (const m of source.matchAll(new RegExp(`${holder}\\.([A-Z][A-Z0-9_]+)\\b${notWrite}`, 'g'))) add(m[1], file);
    for (const m of source.matchAll(new RegExp(`${holder}\\[\\s*'([A-Z][A-Z0-9_]+)'\\s*\\]${notWrite}`, 'g'))) add(m[1], file);
    for (const m of source.matchAll(new RegExp(`${holder}\\[\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\]${notWrite}`, 'g'))) {
      const name = constants.get(m[1]);
      if (name !== undefined) add(name, file);
    }
    for (const m of source.matchAll(/\benv\(\s*((?:'[A-Z0-9_]+'\s*,?\s*)+)\)/g)) for (const n of m[1].matchAll(/'([A-Z0-9_]+)'/g)) add(n[1], file);
    for (const m of source.matchAll(/const\s+[A-Z0-9_]*_ENV\s*=\s*\[([^\]]*)\]/g)) for (const n of m[1].matchAll(/'([A-Z0-9_]+)'/g)) add(n[1], file);
    for (const m of source.matchAll(/homeEnv:\s*'([A-Z0-9_]+)'/g)) add(m[1], file);
  }
  return found;
}

/* Read by the backend and deliberately not handed to it by the shell. The reasons for the first
   three are written beside BACKEND_ENV in backend.rs too, where the next person to edit the list
   will read them. */
const WITHHELD: Record<string, string> = {
  ACC_PORT: 'the shell probes PHOSPHOR_PORT only, so a backend on ACC_PORT is one the shell never finds',
  ACC_DATA_DIR: 'PHOSPHOR_DATA_DIR is always set by the shell and wins',
  PHOSPHOR_NO_PARENT_WATCH: 'the shell is the parent the watch exists for',
  [WINDOW_TOKEN_VAR]: 'the token goes down stdin, never the environment (tests/unit/token-stdin.test.ts)',
};

test('every name the backend reads is passed by the shell, set by it, or withheld on purpose', () => {
  const reads = namesTheBackendReads();
  // A scanner that stopped matching would pass everything, so it has to find what is known to be there.
  for (const known of ['PATH', 'HOME', 'PHOSPHOR_MODE', 'CLAUDE_CONFIG_DIR', 'COINGECKO_API_KEY', 'PHOSPHOR_1CLICK_API_KEY', 'PHOSPHOR_DEMO_STALL', 'PHOSPHOR_NO_PARENT_WATCH']) {
    assert.ok(reads.has(known), `the scan of src/ lost ${known}, so it can no longer vouch for the list`);
  }
  const passed = new Set(backendEnv());
  const set = new Set(setByShell());
  assert.deepEqual([...set].sort(), ['PHOSPHOR_APP_DATA', 'PHOSPHOR_CONFIG_DIR', 'PHOSPHOR_DATA_DIR']);
  const unclassified = [...reads.keys()].filter((name) => !passed.has(name) && !set.has(name) && !(name in WITHHELD));
  assert.deepEqual(
    unclassified.map((name) => `${name} (${[...(reads.get(name) ?? [])].join(', ')})`),
    [],
    'src/ reads these and the shell neither hands them over (BACKEND_ENV in backend.rs) nor says why not',
  );
});

test('the shell passes nothing the backend does not read, and nothing it withholds', () => {
  const reads = namesTheBackendReads();
  const passed = backendEnv();
  assert.equal(new Set(passed).size, passed.length, 'BACKEND_ENV names a variable twice');
  assert.deepEqual(passed.filter((name) => !reads.has(name)), [], 'BACKEND_ENV passes these and nothing in src/ reads them');
  assert.deepEqual(passed.filter((name) => name in WITHHELD), []);
  for (const name of ['ACC_PORT', 'ACC_DATA_DIR', 'PHOSPHOR_NO_PARENT_WATCH']) {
    assert.ok(BACKEND_RS.includes(name), `backend.rs says why ${name} is withheld`);
  }
});

test('the backend command clears the environment and puts the flags before the entry point', () => {
  const body = backendCommandBody();
  assert.match(body, /\.env_clear\(\)/, 'without env_clear the list is a list of additions to everything the shell had');
  const flags = body.indexOf('.args(NODE_FLAGS)');
  const entry = body.indexOf('.arg(payload.join("src").join("main.ts"))');
  assert.ok(flags > 0 && entry > flags, 'Node reads every argument after the entry point as the script\'s, not its own');
  assert.deepEqual(nodeFlags(), ['--disable-sigusr1', '--no-addons', '--disallow-code-generation-from-strings']);

  // spawn_backend and spawn_checked, the start it hands the runtime, the digest and the team to.
  const spawnBackend = BACKEND_RS.slice(BACKEND_RS.indexOf('pub fn spawn_backend('), BACKEND_RS.indexOf('fn backend_command('));
  assert.match(spawnBackend, /spawn_checked\(&node, payload, data, hand, crate::payload::BUILT_FOR, own_team\(\)\.as_deref\(\)\)/);
  assert.match(spawnBackend, /backend_command\(node, payload, data, \|name\| std::env::var_os\(name\)\)/);
  assert.doesNotMatch(spawnBackend, /Command::new/, 'spawn_backend builds no command of its own beside it');
  const order = ['crate::payload::check(payload, built_for)', '.spawn()', 'runtime_signed_by(child.id(), team)', 'writeln!(pipe'].map((step) => spawnBackend.indexOf(step));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), 'the payload is checked before the start, the runtime before the handshake');
});

test('the bundle boots the staged runtime with the same flags, and ships Node 24 only', () => {
  const bundler = fs.readFileSync(path.join(ROOT, 'scripts', 'bundle-payload.ts'), 'utf8');
  assert.match(bundler, /\[\.\.\.backendNodeFlags\(\), path\.join\(STAGE, 'src', 'main\.ts'\)\]/);
  assert.match(bundler, /if \(major !== 24\) throw/);
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

// The control for the test after it: on this runtime, without the flag, SIGUSR1 does open an
// inspector, so the absence of one below is the flag's doing and not the test's blindness.
test('without --disable-sigusr1, SIGUSR1 opens an inspector (the control)', async () => {
  // Signalled only once it says it is running: a SIGUSR1 that lands before Node has set itself up
  // takes the default action and kills it, which would prove nothing.
  const script = "console.log('ready'); setTimeout(() => {}, 10_000);";
  const child = spawn(process.execPath, ['--inspect-port=0', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stdout.once('data', () => child.kill('SIGUSR1'));
  try {
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (!stderr.includes('Debugger listening')) return;
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.ok(opened, `no inspector opened: ${stderr}`);
  } finally {
    child.kill('SIGKILL');
  }
});

test('the real backend boots under exactly the shell\'s launch, and SIGUSR1 opens nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-launch-'));
  t.diagnostic(`backend data path: ${dir}`);
  const port = await freePort();
  let decoy = await freePort();
  while (decoy === port) decoy = await freePort();

  // What the shell's own environment might hold, built the way backend_command builds the child's:
  // the BACKEND_ENV names it has, then the three the shell sets. HOME and the key path point into
  // the throwaway directory, so nothing here can reach a real wallet.
  const parent: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(dir, 'home'),
    PHOSPHOR_MODE: 'demo',
    PHOSPHOR_PORT: String(port),
    PHOSPHOR_KEYS: path.join(dir, 'keys.enc.json'),
    ACC_PORT: String(decoy),
    PHOSPHOR_NO_PARENT_WATCH: '1',
    NODE_OPTIONS: '--inspect-port=0',
  };
  const env: Record<string, string> = {};
  for (const name of backendEnv()) if (parent[name] !== undefined) env[name] = parent[name];
  Object.assign(env, {
    PHOSPHOR_DATA_DIR: path.join(dir, 'data', 'state'),
    PHOSPHOR_CONFIG_DIR: path.join(dir, 'data'),
    PHOSPHOR_APP_DATA: '1',
  });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ACC_PORT, undefined);

  const child = spawn(process.execPath, [...nodeFlags(), path.join(ROOT, 'src', 'main.ts')], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const [token, nonce, seat, transport, relay] = Array.from({ length: 5 }, () => crypto.randomBytes(32).toString('hex'));
  child.stdin.write(`${token}\n${nonce}\n${seat}\n${transport}\n${relay}\n`);
  child.stdin.end();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  try {
    const up = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 25_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (!chunk.includes(`http://127.0.0.1:${port}`)) return;
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.ok(up, `the backend never came up on PHOSPHOR_PORT under the shell's launch: ${stderr}`);

    const origin = `http://127.0.0.1:${port}`;
    const root = await fetch(`${origin}/`);
    await root.arrayBuffer();
    assert.equal(root.headers.get('x-phosphor'), nonce, 'the handshake reached it down the pipe, as the shell sends it');

    child.kill('SIGUSR1');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(child.exitCode, null, 'SIGUSR1 must not take the backend down either');
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    await health.arrayBuffer();
    assert.ok(!stderr.includes('Debugger listening'), `SIGUSR1 opened an inspector on the backend: ${stderr}`);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
