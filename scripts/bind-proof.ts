// The Vault's Bind card, proven in a real browser against real backends and the vault service's own
// rules with a stand-in keychain and enclave (tests/unit/helpers/vault-double.ts): no Touch ID is
// ever asked for, and nothing reaches a real keychain.
//
// For each window size, a wallet with no phrase is made the way 0.10.14 made one, with a key bound
// to this Mac (a build with no Team ID behind the relay), and the app then starts again as a
// Developer ID build would (a Team ID, so the service has its keychain home). Each backend is the app
// in demo mode on a free port (never 4177), a throwaway data dir and HOME, and the shell's five-line
// handshake on stdin; a loop here plays the shell. Headless Chromium, through playwright-core, at the
// window's minimum (960 x 700), its default (1180 x 780) and a large one (1680 x 1050), into
// scripts/scratch/bind-proof/ (PROOF_OUT names any other folder):
//
//   keys-dev        a build with no keychain home: the Keys row as it was, no card
//   bind-first      a device-bound key whose backup is not proven: the card asks for it first
//   bind-offer      proven: what Phosphor-only gives, why the one touch, what it does not reach
//   bind-waiting    the Touch ID is up
//   bind-cancelled  the person cancelled it: said in the card, nothing changed
//   bind-done       Phosphor-only: the tick, and the old copies the step cannot reach
//   keys-bound      the Keys row after the window opens again
//   firstrun-create   a new Mac with no wallet: Create, and I already have a wallet beside it
//   firstrun-restore  that second path: the phrase or the key, behind one Touch ID
//   firstrun-short    a key typed one character short, said before anything is sent
//   firstrun-restored the wallet brought back, named before any address
//
// The app is dark only (src/view/theme.ts has one colourway), so there is no light picture.
// Run: node scripts/bind-proof.ts. playwright-core is not a dependency of this repo; point
// PLAYWRIGHT_CORE at a copy, and PROOF_BROWSER at a Chromium binary when playwright's is missing.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';
import { proofOut } from './proof-out.ts';
import { relayTo, TEAM, VaultDouble } from '../tests/unit/helpers/vault-double.ts';
import type { Hook, Request } from '../tests/unit/helpers/vault-double.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/47c97c996798144b/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const SHOTS = proofOut('bind-proof', 'bind');
const PASSWORD = 'proof-password-1';
const BIND_REASON = 'Make your wallet Phosphor-only on this Mac';

type Json = any;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: number): string => crypto.randomBytes(bytes).toString('hex');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 && port !== 4177 ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
}

type Backend = { base: string; token: string; log: string[]; stop: () => Promise<void> };

/* One start of the app on `dir`, with this script as its shell and `double` as its enclave. */
async function startBackend(dir: string, double: VaultDouble, hook?: (r: Request) => Hook | Promise<Hook>): Promise<Backend> {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const token = hex(32);
  const relay = hex(32);
  const transport = crypto.randomBytes(32);
  const log: string[] = [];
  const app: ChildProcess = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      HOME: home,
      CFFIXED_USER_HOME: home,
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_PORT: String(port),
      PHOSPHOR_DATA_DIR: path.join(dir, 'state'),
      PHOSPHOR_KEYS: path.join(dir, 'keys', 'keys.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  app.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
  app.stdin?.end([token, hex(16), hex(32), transport.toString('hex'), relay].join('\n') + '\n');
  const until = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/state`, { headers: { 'x-phosphor-token': token } })).ok) break;
    } catch {
      // not listening yet
    }
    if (app.exitCode !== null || Date.now() > until) throw new Error(`the backend did not come up:\n${log.join('')}`);
    await sleep(150);
  }
  const send = async (route: string, body: Json): Promise<{ status: number; json: Json }> => {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const shell = relayTo((route, body) => send(route, { relay, ...body }), double, transport, hook);
  for (let i = 0; i < 100; i += 1) {
    if ((await get({ base, token } as Backend, '/api/vault')).enclave?.ready === true) break;
    await sleep(50);
  }
  return {
    base,
    token,
    log,
    stop: async () => {
      if (app.exitCode === null) {
        const gone = new Promise<void>((resolve) => app.once('exit', () => resolve()));
        app.kill('SIGTERM');
        await Promise.race([gone, sleep(5_000)]);
        if (app.exitCode === null) app.kill('SIGKILL');
      }
      await shell.stop();
    },
  };
}

async function post(b: Backend, route: string, body: Json = {}): Promise<Json> {
  const res = await fetch(`${b.base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b.base }, body: JSON.stringify({ token: b.token, ...body }) });
  return res.json().catch(() => null);
}

async function get(b: Backend, route: string): Promise<Json> {
  return (await fetch(`${b.base}${route}`, { headers: { 'x-phosphor-token': b.token } })).json();
}

const SIZES = [
  { tag: '960', width: 960, height: 700 },
  { tag: '1180', width: 1180, height: 780 },
  { tag: '1680', width: 1680, height: 1050 },
];
const KEYS = '#view-vault .vault-row[data-surface="custody"]';

type Shot = { file: string; state: string; size: string; says: string[] };
const results: { shots: Shot[]; checks: Record<string, unknown> } = { shots: [], checks: {} };

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-bind-proof-'));
  const running: Backend[] = [];

  async function page(b: Backend, size: (typeof SIZES)[number]): Promise<Json> {
    const p: Json = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
    p.on('pageerror', (err: unknown) => b.log.push(`[page] ${String(err)}\n`));
    await p.goto(`${b.base}/?token=${b.token}`, { waitUntil: 'load' });
    await p.waitForFunction('!!(window.PhosphorState && window.PhosphorState.get() && window.PhosphorState.get().vault)', null, { timeout: 20_000 });
    const later = await p.waitForSelector('#screen-migrate button:has-text("Not now")', { timeout: 1_500 }).catch(() => null);
    if (later) await later.click();
    await p.click('.tab[data-tab="vault"]');
    await p.waitForSelector(KEYS, { timeout: 20_000 });
    await p.evaluate(`document.querySelector(${JSON.stringify(KEYS)}).scrollIntoView({ block: 'center' })`);
    await sleep(300);
    return p;
  }

  async function shoot(p: Json, size: { tag: string }, state: string): Promise<void> {
    await p.evaluate('document.fonts.ready');
    await sleep(600);
    const file = path.join(SHOTS, `${state}-${size.tag}.png`);
    await p.screenshot({ path: file });
    const says = (await p.evaluate(`(document.querySelector(${JSON.stringify(KEYS)}) || { innerText: '' }).innerText.split('\\n').map(function (t) { return t.trim(); }).filter(Boolean)`)) as string[];
    results.shots.push({ file, state, size: size.tag, says });
  }

  const button = (label: string): string => `${KEYS} button:has(.btn-label:text-is("${label}"))`;

  async function shootFirstRun(p: Json, size: { tag: string }, state: string): Promise<void> {
    await p.evaluate('document.fonts.ready');
    await sleep(600);
    const file = path.join(SHOTS, `${state}-${size.tag}.png`);
    await p.screenshot({ path: file });
    const says = (await p.evaluate(`(document.querySelector('#screen-firstrun') || { innerText: '' }).innerText.split('\\n').map(function (t) { return t.trim(); }).filter(Boolean)`)) as string[];
    results.shots.push({ file, state, size: size.tag, says });
  }

  try {
    for (const size of SIZES) {
      const dir = path.join(scratch, size.tag);
      const double = new VaultDouble(path.join(dir, 'keychain.json'));

      // 0.10.14's wallet: an EVM key and no phrase, moved behind a key bound to this Mac.
      double.team = '';
      let b = await startBackend(dir, double);
      running.push(b);
      await post(b, '/api/terms/accept');
      const imported = await post(b, '/api/wallet/import', { password: PASSWORD, keys: { evm: generatePrivateKey() } });
      if (imported?.ok !== true) throw new Error(`import refused: ${JSON.stringify(imported)}`);
      const moved = await post(b, '/api/vault/migrate', { password: PASSWORD });
      if (moved?.ok !== true) throw new Error(`migrate refused: ${JSON.stringify(moved)}`);
      let p = await page(b, size);
      await shoot(p, size, 'keys-dev');
      results.checks[`noCardOnDev-${size.tag}`] = await p.$eval(`${KEYS} .vault-bind`, (n: Json) => n.hidden);
      await p.close();
      await b.stop();

      // The same Mac, a build with a keychain home. The bind's touch waits on `gate` when held.
      double.team = TEAM;
      let release: (() => void) | null = null;
      let hold = false;
      let cancel = false;
      b = await startBackend(dir, double, async (r: Request): Promise<Hook> => {
        if (r.op === 'unwrap' && r.reason === BIND_REASON && hold) {
          await new Promise<void>((resolve) => (release = resolve));
          if (cancel) return { kind: 'answer', answer: { ok: false, error: 'user_cancel', message: 'cancelled' } };
        }
        return { kind: 'run' };
      });
      running.push(b);
      const opened = await post(b, '/api/vault/unlock');
      if (opened?.ok !== true) throw new Error(`unlock refused: ${JSON.stringify(opened)}`);
      p = await page(b, size);
      await shoot(p, size, 'bind-first');

      // The backup proven the way the Vault proves it: the key shown behind a touch, the whole copy back.
      const revealed = await post(b, '/api/vault/reveal-key');
      const groups = revealed?.groups as string[];
      const proven = await post(b, '/api/vault/key-proven', { key: groups.join(' ') });
      if (proven?.ok !== true) throw new Error(`key proof refused: ${JSON.stringify(proven)}`);
      await p.waitForSelector(button('Make it Phosphor-only'), { timeout: 10_000 });
      await sleep(400);
      await shoot(p, size, 'bind-offer');

      hold = true;
      cancel = true;
      await p.click(button('Make it Phosphor-only'));
      await p.waitForSelector(`${KEYS} button[aria-busy="true"]`, { timeout: 10_000 });
      await shoot(p, size, 'bind-waiting');
      while (release === null) await sleep(20);
      (release as () => void)();
      await p.waitForSelector(`${KEYS} .vault-bind .vault-error:not([hidden])`, { timeout: 10_000 });
      await shoot(p, size, 'bind-cancelled');

      hold = false;
      cancel = false;
      release = null;
      await p.click(button('Make it Phosphor-only'));
      await p.waitForSelector(`${KEYS} .vault-bind[data-step="done"]`, { timeout: 10_000 });
      await shoot(p, size, 'bind-done');
      await p.close();
      const vault = await get(b, '/api/vault');
      results.checks[`bound-${size.tag}`] = vault.enclave?.binding === 'app';

      p = await page(b, size);
      await shoot(p, size, 'keys-bound');
      await p.close();
      await b.stop();
    }

    // A new Mac with Touch ID and no wallet: the first run's second path, for a wallet that exists.
    for (const size of SIZES) {
      const dir = path.join(scratch, `first-${size.tag}`);
      const b = await startBackend(dir, new VaultDouble(path.join(dir, 'keychain.json')));
      running.push(b);
      await post(b, '/api/terms/accept');
      const p: Json = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
      p.on('pageerror', (err: unknown) => b.log.push(`[page] ${String(err)}\n`));
      await p.goto(`${b.base}/?token=${b.token}`, { waitUntil: 'load' });
      await p.waitForSelector('#screen-firstrun:not([hidden])', { timeout: 20_000 });
      await p.click('#screen-firstrun button:has(.btn-label:text-is("Get started"))');
      const skip = await p.waitForSelector('#screen-firstrun button:has(.btn-label:text-is("Skip"))', { timeout: 5_000 }).catch(() => null);
      if (skip) await skip.click();
      const first = (state: string): Promise<void> => shootFirstRun(p, size, state);
      await p.waitForSelector('#screen-firstrun button:has(.btn-label:text-is("I already have a wallet"))', { timeout: 10_000 });
      await first('firstrun-create');
      await p.click('#screen-firstrun button:has(.btn-label:text-is("I already have a wallet"))');
      await p.waitForSelector('#screen-firstrun textarea', { timeout: 10_000 });
      await first('firstrun-restore');
      const key = generatePrivateKey().slice(2);
      await p.fill('#screen-firstrun textarea', (key.slice(0, -1).match(/.{1,4}/g) as string[]).join(' '));
      await p.click('#screen-firstrun button:has(.btn-label:text-is("Restore"))');
      await sleep(300);
      await first('firstrun-short');
      await p.fill('#screen-firstrun textarea', (key.match(/.{4}/g) as string[]).join(' '));
      await p.click('#screen-firstrun button:has(.btn-label:text-is("Restore"))');
      // A selector, not a predicate: the window's CSP refuses the eval a polled predicate needs.
      await p.waitForSelector('#screen-firstrun h1:text-is("Your wallet is back")', { timeout: 15_000 }).catch(async (err: unknown) => {
        const said = await p.evaluate(`(document.querySelector('#screen-firstrun') || { innerText: '' }).innerText`);
        throw new Error(`the restore did not name the wallet: ${String(err)}\nthe screen says: ${said}\nbackend: ${b.log.join('').slice(-1500)}`);
      });
      await first('firstrun-restored');
      await p.close();
      const vault = await get(b, '/api/vault');
      results.checks[`firstRunRestored-${size.tag}`] = vault.custody === 'secure-enclave' && vault.enclave?.binding === 'app' && vault.backedUp === true;
      await b.stop();
    }
  } finally {
    for (const b of running) await b.stop().catch(() => undefined);
    await browser.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.writeFileSync(path.join(SHOTS, 'proof-results.json'), JSON.stringify(results, null, 2) + '\n');
  }
  console.log(`bind-proof: ${results.shots.length} shots in ${SHOTS}; checks ${JSON.stringify(results.checks)}`);
}

await main();
process.exit(0);
