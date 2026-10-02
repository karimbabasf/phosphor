// The one Touch ID the XPC service still owes: a real unwrap, over the real hop, in a built and
// signed bundle, against a wallet made for the occasion.
//
// It seeds a throwaway enclave wallet (the development helper makes the key, which needs no
// presence, and the keystore writes the file exactly as the app does), starts the given bundle's
// own shell against a temporary HOME in demo mode, and waits for one press of "Unlock with Touch
// ID" in that window and one touch. PASS needs all of it: the vault opened with the addresses
// the seed wrote, and coreauthd saw the dialog come from the service inside THIS bundle, with
// the unlock sentence, under the name Phosphor.
//
// ~/.phosphor is never read. Three locks keep it that way: a demo boot never resolves it
// (config.ts defaultKeysPath), PHOSPHOR_KEYS names the throwaway file outright, and HOME is the
// temporary directory, so the shell's Application Support and the backend's home both sit
// inside it. The script refuses to start when Phosphor is already running or when the bundled
// payload would not honour PHOSPHOR_KEYS, and stops the app at once if the shell did not follow
// HOME.
//
//   node scripts/xpc-touch-proof.ts path/to/Phosphor.app [--dry-run]
//
// Needs the development helper (npm run se:build) to make the throwaway key. --dry-run stops
// once the locked wallet is up and the enclave answers through the service, before anything
// could raise a dialog.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKeystore } from '../src/keystore/store.ts';
import { UNLOCK_REASON } from '../src/vault/reason.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRIPLE = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const HELPER = path.join(ROOT, 'src-tauri', 'binaries', `se-helper-dev-${TRIPLE}`);
const IDENTIFIER = 'com.karimbabasf.phosphor';
const SERVICE = `${IDENTIFIER}.vault`;
const TOUCH_WAIT_MS = 180_000;

type Json = Record<string, any>;
const checks: Array<{ label: string; ok: boolean }> = [];
function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `   ${detail}` : ''}`);
  return ok;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `codesign -dv` writes to stderr, and says "not set" for an ad-hoc signature.
function teamOf(target: string): string {
  const out = spawnSync('codesign', ['-dv', target], { encoding: 'utf8' }).stderr;
  return /^TeamIdentifier=(.+)$/m.exec(out)?.[1] ?? 'unknown';
}

// `log show --start` takes local wall time.
function logStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const given = args.find((a) => !a.startsWith('--'));
  if (given === undefined || !fs.existsSync(path.join(given, 'Contents', 'MacOS', 'phosphor-desktop'))) {
    console.error('usage: node scripts/xpc-touch-proof.ts path/to/Phosphor.app [--dry-run]');
    return 2;
  }
  const app = fs.realpathSync(given);
  const shell = path.join(app, 'Contents', 'MacOS', 'phosphor-desktop');
  const service = path.join(app, 'Contents', 'XPCServices', `${SERVICE}.xpc`);
  const serviceBinary = path.join(service, 'Contents', 'MacOS', 'se-helper');
  const bundledConfig = path.join(app, 'Contents', 'Resources', 'phosphor', 'src', 'config.ts');

  // ---- refusals, before anything is written or started ----
  if (!fs.existsSync(HELPER)) {
    console.error(`no development helper at ${HELPER}; run npm run se:build first`);
    return 2;
  }
  try {
    execFileSync('pgrep', ['-x', 'phosphor-desktop'], { stdio: 'ignore' });
    console.error('Phosphor is running. Quit it first: this proof starts its own copy, and two identical windows are one wrong click from unlocking the real wallet.');
    return 2;
  } catch {
    // pgrep exits 1 when nothing matches, which is the case wanted
  }
  const payloadConfig = fs.existsSync(bundledConfig) ? fs.readFileSync(bundledConfig, 'utf8') : '';
  if (!payloadConfig.includes("env('PHOSPHOR_KEYS')") || !payloadConfig.includes("if (mode === 'demo')")) {
    console.error(`refusing: ${bundledConfig} does not honour PHOSPHOR_KEYS and a demo key path, so this bundle could reach ~/.phosphor`);
    return 2;
  }
  if (!check('the old sidecar is gone and the service ships inside the bundle', !fs.existsSync(path.join(app, 'Contents', 'MacOS', 'se-helper')) && fs.existsSync(serviceBinary))) return 1;
  let sealed = true;
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' });
  } catch {
    sealed = false;
  }
  const appTeam = teamOf(app);
  const serviceTeam = teamOf(service);
  if (!check('the bundle verifies, and the app and its service carry one signer', sealed && appTeam === serviceTeam, `app ${appTeam}, service ${serviceTeam}`)) return 1;
  if (appTeam === 'not set') console.log('       ad-hoc build: a pass here proves the hop, not the Developer ID requirement');

  // ---- the throwaway wallet ----
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-touch-proof-')));
  const dataDir = path.join(home, 'Library', 'Application Support', IDENTIFIER);
  const stateDir = path.join(dataDir, 'state');
  const keysPath = path.join(stateDir, 'keys.json');
  fs.mkdirSync(stateDir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(dataDir, 'config.local.json'), JSON.stringify({ port, mode: 'demo' }));
  // The terms screen gates a screen, not a key (src/terms.ts). Accepted here so the one thing
  // left in the window is the unlock button; the version is the one this bundle asks for.
  const bundledTerms = path.join(app, 'Contents', 'Resources', 'phosphor', 'src', 'terms.ts');
  const termsVersion = /TERMS_VERSION = '([^']+)'/.exec(fs.existsSync(bundledTerms) ? fs.readFileSync(bundledTerms, 'utf8') : '')?.[1];
  if (termsVersion !== undefined) {
    fs.writeFileSync(path.join(stateDir, 'terms.json'), JSON.stringify({ acceptedVersion: termsVersion, acceptedAt: new Date().toISOString() }));
  }

  const made = JSON.parse(execFileSync(HELPER, { input: '{"op":"create"}\n' }).toString()) as Json;
  if (!check('a throwaway enclave key, made with no dialog', made.ok === true && made.binding === 'device', `binding ${String(made.binding)}`)) {
    fs.rmSync(home, { recursive: true, force: true });
    return 1;
  }
  const ref = { keyBlob: String(made.keyBlob), publicKey: String(made.publicKey), createdAt: new Date().toISOString() };
  const seeded = createKeystore({ keysPath, mode: 'demo' });
  const seededEvm = String(seeded.createWithEnclave(ref).addresses.evm);
  seeded.lock();
  check('a throwaway enclave wallet written under the temporary HOME', fs.existsSync(path.join(stateDir, 'keys.enc.json')), `evm ${seededEvm}`);

  // ---- the bundle, started the way it starts itself, pointed at the throwaway ----
  const output: string[] = [];
  const child = spawn(shell, [], {
    cwd: home,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      USER: process.env.USER ?? '',
      LOGNAME: process.env.LOGNAME ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_PORT: String(port),
      PHOSPHOR_KEYS: keysPath,
    },
  });
  child.stdout.on('data', (d: Buffer) => output.push(d.toString()));
  child.stderr.on('data', (d: Buffer) => output.push(d.toString()));
  const stop = async () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      return;
    }
    for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i += 1) await sleep(100);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // the group is already gone
    }
  };

  const started = new Date(Date.now() - 1000);
  try {
    let up = false;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && child.exitCode === null; await sleep(200)) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          up = true;
          break;
        }
      } catch {
        // not yet
      }
    }
    if (!check('the shell started its backend on the throwaway port', up)) return 1;
    // The shell writes its pid file into its own data directory. Finding it here is the proof
    // that Application Support followed HOME; not finding it means the real one may be in use,
    // and the app is stopped before it does anything else.
    if (!check('the shell keeps its data under the temporary HOME', fs.existsSync(path.join(dataDir, 'backend.pid')), dataDir)) return 1;
    // Every read wants the window token or the read key, and the shell keeps the token to itself.
    // The backend writes the key into its own data directory, which is this script's throwaway one.
    const read = { headers: { 'x-phosphor-read': fs.readFileSync(path.join(stateDir, 'read.key'), 'utf8').trim() } };

    let vault: Json = {};
    for (let i = 0; i < 100; i += 1) {
      vault = (await (await fetch(`${base}/api/vault`, read)).json()) as Json;
      if (vault.enclave?.ready === true) break;
      await sleep(100);
    }
    check('the backend opened the throwaway file and no other', vault.custody === 'secure-enclave' && vault.enclave?.keyMadeAt === ref.createdAt, `keyMadeAt ${String(vault.enclave?.keyMadeAt)}`);
    check('the wallet is locked', vault.state === 'locked', String(vault.state));
    check('the shell reaches the enclave through the service', vault.enclave?.ready === true, JSON.stringify(vault.enclave));
    if (checks.some((c) => !c.ok)) return 1;

    if (dryRun) {
      console.log('\n--dry-run: stopping before any dialog.');
      return 0;
    }

    console.log(`\n>> In the Phosphor window: click "Unlock with Touch ID", then touch the sensor.`);
    console.log(`   The dialog should say Phosphor and "${UNLOCK_REASON}". Waiting ${TOUCH_WAIT_MS / 1000} s.`);
    let state: Json = {};
    for (const deadline = Date.now() + TOUCH_WAIT_MS; Date.now() < deadline; await sleep(500)) {
      state = (await (await fetch(`${base}/api/state`, read)).json()) as Json;
      vault = (await (await fetch(`${base}/api/vault`, read)).json()) as Json;
      if (state.lock?.state === 'unlocked' || vault.foreign === true) break;
    }
    if (vault.foreign === true) {
      check('the service opened a key the development helper made', false, 'foreign_key: the signed service will not load a device blob made by another signer, so an existing wallet would not open after this upgrade');
      return 1;
    }
    check('the wallet opened after the touch', state.lock?.state === 'unlocked', String(state.lock?.state));
    check('with the addresses the seed wrote, decrypted rather than read from the header', state.lock?.verified === true && String(state.lock?.addresses?.evm).toLowerCase() === seededEvm.toLowerCase(), String(state.lock?.addresses?.evm));

    // coreauthd names every process that raises a dialog, with the sentence it shows.
    const auth = execFileSync('/usr/bin/log', ['show', '--start', logStamp(started), '--style', 'compact', '--predicate', 'process == "coreauthd"'], { maxBuffer: 64 * 1024 * 1024 }).toString();
    const asked = new RegExp(`value:${UNLOCK_REASON} on ContextProxy\\[(\\d+):`).exec(auth);
    const pid = asked?.[1];
    check('coreauthd saw a dialog with the unlock sentence', pid !== undefined);
    if (pid !== undefined) {
      const from = new RegExp(`Determined path for PID ${pid}: (.+)$`, 'm').exec(auth)?.[1]?.trim();
      check('it came from the service inside this bundle', from === serviceBinary, String(from));
      check('and was shown under the name Phosphor', new RegExp(`Determined name Phosphor and bundle ID .* for pid ${pid}\\b`).test(auth));
    }
  } catch (err) {
    check('no exception', false, err instanceof Error ? err.message : String(err));
  } finally {
    await stop();
    fs.rmSync(home, { recursive: true, force: true });
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    if (failed > 0) console.log(output.join('').slice(-2000));
    else if (!dryRun) console.log('PASS');
  }
  return checks.some((c) => !c.ok) ? 1 : 0;
}

process.exit(await main());
