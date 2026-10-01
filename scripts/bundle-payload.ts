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

import { payloadDigest } from './payload-digest.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TAURI = path.join(ROOT, 'src-tauri');
const STAGE = path.join(TAURI, 'payload', 'phosphor');
const BINARIES = path.join(TAURI, 'binaries');
// Beside the stage, not in it: src-tauri/build.rs compiles the digest into the shell, and the
// manifest names each file's hash, for finding which file a copy differs in.
const DIGEST_FILE = path.join(TAURI, 'payload', 'phosphor.sha256');
const MANIFEST_FILE = path.join(TAURI, 'payload', 'phosphor.manifest');

// Rust's target triple, which is what Tauri appends to every externalBin filename.
const TRIPLE = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';

// What the app reads at runtime. config.local.json is deliberately absent: it is the writable
// half and lives in Application Support, not in a read-only bundle. So is state/, and so are
// the keys, which have never been in the working copy at all.
// `operator` carries the two lockdown files. Without it an installed app can still run, and the
// driver would refuse to start rather than spawn an agent whose tool surface it cannot vouch for,
// which is the correct failure and a useless one. It ships.
// docs/changelog.md alone, not docs/ (37 MB of pictures): the agent's whats_new reads it.
const PAYLOAD = ['src', 'ui', 'data', 'skills', 'operator', 'config.json', 'package.json', 'package-lock.json', 'docs/changelog.md'];

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

// Whole packages, by where they install at the top of node_modules rather than by a name matched
// anywhere. typescript is a devDependency that --omit=dev keeps: viem, ox and abitype name it as an
// optional peer, so npm files it as dev or optional. Nothing in the app runs the compiler, and
// since 7.0 it is a native binary, one package per platform under @typescript.
//
// And two things npm writes beside the packages rather than unpacks from them: .bin, its links
// to package commands (the app runs none, and a link is not something the payload digest
// accepts), and .package-lock.json, its own record of the install, whose layout follows the npm
// version rather than the lockfile. Without them node_modules is the lockfile's packages and
// nothing else, which is what lets a rebuild on another Mac reach the same digest.
const DROP_PACKAGES = ['typescript', '@typescript', '.bin', '.package-lock.json'];

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
    fs.mkdirSync(path.dirname(path.join(STAGE, name)), { recursive: true });
    fs.cpSync(from, path.join(STAGE, name), { recursive: true });
  }
  console.log(`payload: staged ${PAYLOAD.length} entries`);

  // `npm ci` against the copied lockfile rather than a copy of the working node_modules, so the
  // bundle carries exactly the locked versions and nothing a stray `npm install` left behind.
  // --ignore-scripts because the stage has no .npmrc: no dependency runs code at install time
  // into the tree that ships, whatever a future version of one of them declares.
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: STAGE, stdio: 'inherit' });
  const installed = bytes(path.join(STAGE, 'node_modules'));

  for (const name of DROP_PACKAGES) fs.rmSync(path.join(STAGE, 'node_modules', name), { recursive: true, force: true });
  prune(path.join(STAGE, 'node_modules'));
  const pruned = bytes(path.join(STAGE, 'node_modules'));
  console.log(`payload: node_modules ${mb(installed)} -> ${mb(pruned)}`);
}

/* The digest the shell is built to accept (scripts/payload-digest.ts). Taken once the stage is
   final and again after the boot check below: the backend must write nothing into its own
   payload, because the installed copy is read-only and the next launch would refuse it. */
function sealPayload(): string {
  const sealed = payloadDigest(STAGE);
  if (sealed.problems.length > 0) throw new Error(`bundle-payload: the payload cannot ship as it stands:\n  ${sealed.problems.join('\n  ')}`);
  fs.writeFileSync(DIGEST_FILE, `${sealed.digest}\n`);
  fs.writeFileSync(MANIFEST_FILE, sealed.manifest);
  console.log(`payload: digest ${sealed.digest} over ${sealed.files} files`);
  return sealed.digest;
}

function unchangedSince(digest: string): void {
  const after = payloadDigest(STAGE).digest;
  if (after !== digest) throw new Error(`bundle-payload: the boot check changed the payload (${digest} -> ${after}); the backend must not write into it`);
}

// Copied rather than symlinked: an installed app cannot depend on the nvm directory this was
// built from still existing, still holding 24.x, or existing on somebody else's machine at all.
//
// NODE 24 AND ONLY 24, because the runtime is whatever node runs this script and it is the process
// that holds the keys. It was "24 or later", so a local build took the first node on PATH, and Node
// 26 turns on node:ffi by default: dlopen and dlsym from JavaScript, which --no-addons does not
// cover. CI ships 24 (.github/workflows/release.yml) and every test runs on it. Moving to 26 means
// adding --no-experimental-ffi to NODE_FLAGS in src-tauri/src/backend.rs in the same change, a flag
// Node 24 refuses to start with.
function stageRuntime(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) throw new Error(`bundle-payload: the app ships Node 24, this is ${process.versions.node}. Run it with Node 24 (nvm use 24).`);

  fs.mkdirSync(BINARIES, { recursive: true });
  const target = path.join(BINARIES, `node-${TRIPLE}`);
  fs.copyFileSync(process.execPath, target);
  fs.chmodSync(target, 0o755);
  console.log(`runtime: node ${process.versions.node} -> binaries/node-${TRIPLE} (${mb(fs.statSync(target).size)})`);
}

/* The flags the shell starts the backend with, read out of src-tauri/src/backend.rs rather than
   copied here, so the boot check below cannot drift from what ships. */
function backendNodeFlags(): string[] {
  const source = fs.readFileSync(path.join(TAURI, 'src', 'backend.rs'), 'utf8');
  const list = /pub const NODE_FLAGS: \[&str; \d+\] = \[([^\]]*)\];/.exec(source)?.[1];
  const flags = [...(list ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (flags.length === 0) throw new Error('bundle-payload: could not read NODE_FLAGS from src-tauri/src/backend.rs');
  return flags;
}

/* The Secure Enclave helper, built from src-tauri/se-helper/main.swift by the script that also
   serves `npm run se:build`. It ships as an XPC service, copied to
   Contents/XPCServices/com.karimbabasf.phosphor.vault.xpc by tauri.conf.json's bundle.macOS.files,
   and the script signs it, because Tauri signs neither. A bundle without it still runs: the
   backend's relay reports the enclave unreachable and the wallet stays on the password path,
   which is the wrong product to ship by accident, so the build fails here rather than there. */
function stageEnclaveHelper(): void {
  execFileSync('sh', [path.join(ROOT, 'scripts', 'build-se-helper.sh')], { stdio: 'inherit' });
  const service = path.join(BINARIES, 'xpc', 'com.karimbabasf.phosphor.vault.xpc', 'Contents', 'MacOS', 'se-helper');
  if (!fs.existsSync(service)) throw new Error('bundle-payload: the Secure Enclave service was not built');
  console.log(`enclave: se-helper -> binaries/xpc/com.karimbabasf.phosphor.vault.xpc (${mb(fs.statSync(service).size)})`);
}

// The staged tree is only correct if it boots. Installing cleanly proves nothing: pruning once
// removed a directory viem imports, and npm reported success right up until the app died on
// first launch. So the build refuses to finish until the bundled runtime has actually served a
// page out of the bundled payload.
//
// It runs on a port the kernel just handed back as free, against throwaway directories, with the
// key path pointed somewhere empty. Karim keeps real instances running on 4177 and 4188; this
// must never collide with them and must never read a real key. It starts the runtime with the
// shell's own NODE_FLAGS, so a runtime that refuses one, or a dependency that needs eval or a
// native addon at boot, fails here and not in somebody's Applications folder.
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
    [...backendNodeFlags(), path.join(STAGE, 'src', 'main.ts')],
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
const digest = sealPayload();
stageRuntime();
stageEnclaveHelper();
await verifyBoots();
unchangedSince(digest);
console.log(`total: ${mb(bytes(path.join(TAURI, 'payload')) + bytes(BINARIES))} to bundle`);
