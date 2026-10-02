// The packages that load into the process that holds the key.
//
// The backend (src/main.ts) holds the unwrapped wallet keys while the vault is open, so any
// package that loads into it can read them. That set is fourteen and reviewed: viem and zod and
// what they depend on. The MCP SDK and its tree (express, hono, ajv, jose and the rest) load only
// in src/mcp.ts, the proxy each agent starts, which holds no key. Two tests hold the line: one
// reads what could load (every package the backend's source imports, and everything those depend
// on, from the lockfile), and one watches what does load while the real backend boots and opens a
// wallet. A new package fails both, and joins REVIEWED only once somebody has read it. Versions
// are the lockfile's to pin; CI checks their registry signatures (npm audit signatures).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const REVIEWED = [
  '@adraffy/ens-normalize',
  '@noble/ciphers',
  '@noble/curves',
  '@noble/hashes',
  '@scure/base',
  '@scure/bip32',
  '@scure/bip39',
  'abitype',
  'eventemitter3',
  'isows',
  'ox',
  'viem',
  'ws',
  'zod',
];

function packageOf(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

// The backend's own files, src/main.ts down its relative imports, and every bare package they
// name, read with comments removed so a sentence in one is never taken for an import.
function backendImports(): Map<string, Set<string>> {
  const seen = new Set<string>();
  const stack = [path.join(ROOT, 'src', 'main.ts')];
  const found = new Map<string, Set<string>>();
  const spec = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const source = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    for (const m of source.matchAll(spec)) {
      const target = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (target.startsWith('.')) stack.push(path.resolve(path.dirname(file), target));
      else if (!target.startsWith('node:')) {
        const name = packageOf(target);
        if (!found.has(name)) found.set(name, new Set());
        found.get(name)?.add(path.relative(ROOT, file));
      }
    }
  }
  return found;
}

test('what can load into the backend is the reviewed fourteen: its imports and everything they depend on', () => {
  const imports = backendImports();
  assert.ok(imports.has('viem') && imports.has('zod'), 'the scan has to find the imports it is known to have');
  type Entry = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
  const lock = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, Entry> }).packages;
  const closure = new Set<string>();
  const todo = [...imports.keys()];
  while (todo.length > 0) {
    const name = todo.pop() as string;
    if (closure.has(name)) continue;
    const entry = lock[`node_modules/${name}`];
    assert.ok(entry !== undefined, `${name} is imported by the backend (${[...(imports.get(name) ?? [])].join(', ')}) and is not in the lockfile`);
    closure.add(name);
    // An optional peer (typescript, for viem, ox and abitype) is not installed for them and never
    // loads; scripts/bundle-payload.ts removes it from the bundle.
    const optional = (peer: string): boolean => entry.peerDependenciesMeta?.[peer]?.optional === true;
    todo.push(...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {}).filter((p) => !optional(p)));
  }
  assert.deepEqual([...closure].sort(), REVIEWED, 'a package entered or left the key process: read it, then change REVIEWED');
});

// A resolve hook that writes down every package a process loads, by the last node_modules in the
// path, so a copy nested inside another package is named for itself.
function packageLogger(dir: string): string {
  const hook = path.join(dir, 'log-packages.mjs');
  fs.writeFileSync(
    hook,
    [
      "import { registerHooks } from 'node:module';",
      "import fs from 'node:fs';",
      'const out = process.env.PHOSPHOR_TEST_PACKAGES_OUT;',
      'const seen = new Set();',
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      '    const resolved = nextResolve(specifier, context);',
      "    const all = [...String(resolved.url).matchAll(/\\/node_modules\\/((?:@[^/]+\\/)?[^/]+)\\//g)];",
      '    const name = all.length > 0 ? all[all.length - 1][1] : null;',
      "    if (name !== null && !seen.has(name)) { seen.add(name); fs.appendFileSync(out, name + '\\n'); }",
      '    return resolved;',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  return hook;
}

function nodeFlags(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'backend.rs'), 'utf8');
  const list = /pub const NODE_FLAGS: \[&str; \d+\] = \[([^\]]*)\];/.exec(source)?.[1] ?? '';
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

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

test('the hook sees a package load, so a quiet log below means the backend loaded nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-packages-'));
  const out = path.join(dir, 'loaded.txt');
  // hono ships in node_modules for the MCP proxy and is outside the reviewed set.
  execFileSync(process.execPath, ['--import', pathToFileURL(packageLogger(dir)).href, '--input-type=module', '-e', "await import('hono');"], {
    cwd: ROOT,
    env: { ...process.env, PHOSPHOR_TEST_PACKAGES_OUT: out },
  });
  const seen = fs.readFileSync(out, 'utf8').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(seen.includes('hono'), `the hook missed hono: ${seen.join(' ')}`);
  assert.equal(REVIEWED.includes('hono'), false);
});

test('what does load while the real backend boots, opens a wallet, locks and unlocks is inside the reviewed set', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-packages-'));
  t.diagnostic(`backend data path: ${dir}`);
  const out = path.join(dir, 'loaded.txt');
  const port = await freePort();
  const child = spawn(process.execPath, [...nodeFlags(), '--import', pathToFileURL(packageLogger(dir)).href, path.join(ROOT, 'src', 'main.ts')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(dir, 'home'),
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_PORT: String(port),
      PHOSPHOR_DATA_DIR: path.join(dir, 'data', 'state'),
      PHOSPHOR_CONFIG_DIR: path.join(dir, 'data'),
      PHOSPHOR_KEYS: path.join(dir, 'keys.enc.json'),
      PHOSPHOR_TEST_PACKAGES_OUT: out,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const [token, nonce, seat, transport, relay] = Array.from({ length: 5 }, () => crypto.randomBytes(32).toString('hex'));
  child.stdin.write(`${token}\n${nonce}\n${seat}\n${transport}\n${relay}\n`);
  child.stdin.end();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const origin = `http://127.0.0.1:${port}`;
  const post = async (route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token, ...body }) });
    return (await res.json()) as Record<string, unknown>;
  };
  try {
    const up = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 25_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (!chunk.includes(origin)) return;
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.ok(up, `the backend never came up: ${stderr}`);
    const password = crypto.randomBytes(12).toString('hex');
    assert.equal((await post('/api/wallet/create', { password })).ok, true);
    assert.equal((await post('/api/lock', { reason: 'package test' })).ok, true);
    assert.equal((await post('/api/unlock', { password })).ok, true);
    await (await fetch(`${origin}/api/state`)).arrayBuffer();

    const loaded = fs.readFileSync(out, 'utf8').split('\n').filter((name) => name !== '').sort();
    t.diagnostic(`packages loaded in the backend: ${loaded.length}: ${loaded.join(' ')}`);
    assert.ok(loaded.includes('viem') && loaded.includes('zod'), 'the hook watched the backend load');
    assert.deepEqual(loaded.filter((name) => !REVIEWED.includes(name)), [], 'a package outside the reviewed set loaded beside the key');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
