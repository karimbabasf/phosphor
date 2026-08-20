// Stages everything the installed .app runs, so `cargo tauri build` only has to copy it in.
//
// Two outputs, and they land in different places inside the bundle on purpose:
//
//   src-tauri/payload/phosphor/  -> Contents/Resources/phosphor/   the app, verbatim
//   src-tauri/binaries/node-*    -> Contents/MacOS/node            the Node 24 runtime
//
// The payload directory is named `phosphor` and not `app`, because src/config.ts derives the
// default key location from the basename of the root it is handed. Keeping the name means the
// installed app reads ~/.phosphor/phosphor/keys.json, which is the same file the repo checkout
// already uses. Rename this directory and you silently strand somebody's key.
//
// Nothing is compiled or bundled. Node 24 runs the TypeScript directly, so the installed app
// executes byte-identical code to the reviewed tree, and the http.Server patch in src/server.ts
// keeps sitting on the internals it was written against.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TAURI = path.join(ROOT, 'src-tauri');
const STAGE = path.join(TAURI, 'payload', 'phosphor');
const BINARIES = path.join(TAURI, 'binaries');

// Rust's target triple, which is what Tauri appends to every externalBin filename.
const TRIPLE = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';

// What the app reads at runtime. config.local.json is deliberately absent: it is the writable
// half and lives in Application Support, not in a read-only bundle. So is state/, and so are
// the keys, which have never been in the working copy at all.
const PAYLOAD = ['src', 'ui', 'data', 'skills', 'config.json', 'package.json', 'package-lock.json'];

// Removed after `npm ci`. The rule is deliberately narrow: only files Node can never load at
// runtime. Sourcemaps and .d.ts declarations qualify, and nothing else does.
//
// An earlier version of this list also dropped directories called test/, tests/ and docs/, on the
// assumption that those names mean what they usually mean. They do not: viem ships its
// test-client actions in _esm/actions/test/, so the bundle installed cleanly and then died on
// first boot with ERR_MODULE_NOT_FOUND. A directory name is not evidence about what imports it.
// Do not add name-based directory rules here.
const DROP_EXTENSIONS = ['.map', '.d.ts', '.d.cts', '.d.mts'];
const DROP_DIRECTORIES = ['.github'];

function bytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += bytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(0)}MB`;
}

// LICENSE files are never dropped: stripping them would strip the terms the dependency ships under.
function prune(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DROP_DIRECTORIES.includes(entry.name)) {
        fs.rmSync(full, { recursive: true, force: true });
        continue;
      }
      prune(full);
    } else if (entry.isFile()) {
      if (DROP_EXTENSIONS.some(ext => entry.name.endsWith(ext))) fs.rmSync(full, { force: true });
    }
  }
}

function stagePayload(): void {
  fs.rmSync(path.join(TAURI, 'payload'), { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  for (const name of PAYLOAD) {
    const from = path.join(ROOT, name);
    if (!fs.existsSync(from)) throw new Error(`bundle-payload: ${name} is missing from the repo root`);
    fs.cpSync(from, path.join(STAGE, name), { recursive: true });
  }
  console.log(`payload: staged ${PAYLOAD.length} entries`);

  // `npm ci` against the copied lockfile rather than a copy of the working node_modules, so the
  // bundle carries exactly the locked versions and nothing a stray `npm install` left behind.
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: STAGE, stdio: 'inherit' });
  const installed = bytes(path.join(STAGE, 'node_modules'));

  prune(path.join(STAGE, 'node_modules'));
  const pruned = bytes(path.join(STAGE, 'node_modules'));
  console.log(`payload: node_modules ${mb(installed)} -> ${mb(pruned)}`);
}

// Copied rather than symlinked: an installed app cannot depend on the nvm directory this was
// built from still existing, still holding 24.x, or existing on somebody else's machine at all.
function stageRuntime(): void {
  fs.mkdirSync(BINARIES, { recursive: true });
  const target = path.join(BINARIES, `node-${TRIPLE}`);
  fs.copyFileSync(process.execPath, target);
  fs.chmodSync(target, 0o755);

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`bundle-payload: Node 24+ is required, this is ${process.versions.node}`);
  console.log(`runtime: node ${process.versions.node} -> binaries/node-${TRIPLE} (${mb(fs.statSync(target).size)})`);
}

// The staged tree is only correct if it boots. Installing cleanly proves nothing: pruning once
// removed a directory viem imports, and npm reported success right up until the app died on
// first launch. So the build refuses to finish until the bundled runtime has actually served a
// page out of the bundled payload.
//
// It runs on a port the kernel just handed back as free, against throwaway directories, with the
// key path pointed somewhere empty. Karim keeps real instances running on 4177 and 4188; this
// must never collide with them and must never read a real key.
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

async function verifyBoots(): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-verify-'));
  const port = await freePort();
  const child = spawn(
    path.join(BINARIES, `node-${TRIPLE}`),
    [path.join(STAGE, 'src', 'main.ts')],
    {
      env: {
        ...process.env,
        PHOSPHOR_PORT: String(port),
        PHOSPHOR_DATA_DIR: path.join(scratch, 'state'),
        PHOSPHOR_CONFIG_DIR: path.join(scratch, 'config'),
        PHOSPHOR_KEYS: path.join(scratch, 'keys.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`the bundled app exited on boot:\n${output}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) {
          const html = await res.text();
          if (!html.includes('<html')) throw new Error(`the bundled app served no page:\n${html.slice(0, 200)}`);
          console.log(`verify: bundled runtime booted the bundled payload and served ${html.length} bytes on :${port}`);
          return;
        }
      } catch {
        // not listening yet
      }
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`the bundled app never answered on 127.0.0.1:${port} within 30s:\n${output}`);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

stagePayload();
stageRuntime();
await verifyBoots();
console.log(`total: ${mb(bytes(path.join(TAURI, 'payload')) + bytes(BINARIES))} to bundle`);
