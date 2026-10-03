// The private key backup of a wallet with no phrase, proven in a real browser against real
// backends and a stand-in enclave.
//
// Each backend is the app in demo mode on a free port (never 4177) with a throwaway data
// directory, a throwaway HOME, and the shell's five-line handshake on stdin, so the enclave relay
// is live. A loop here plays the shell the way src-tauri/src/enclave.rs does, and the Secure
// Enclave with a software P-256 key, the stand-in tests/unit/vault-routes.test.ts uses: every
// Touch ID is answered at once, and no real one is ever asked for. Then headless Chromium, through
// playwright-core, at the window's minimum (960 x 700), its default (1180 x 780) and a large one
// (1680 x 1050), into scripts/scratch/key-backup-proof/ (PROOF_OUT names any other folder):
//
//   software-*   a password wallet with no phrase: its row, the password asked in it, its key
//   key-*        the same wallet moved behind the enclave: the row, the key, Prove it, a group
//                that cannot be right, a wrong answer, two of them, the notice, Forget waiting
//   proven-*     the row once three groups are typed back, and the note that says so
//   check-*      Check my copy: open, the whole key right, and the same key with one slip
//   restore-*    Restore from a key: open, a key cut short, the second press, the wallet already
//                here, and the note naming the wallet a restore brought
//   foreign-*    the same file on another Mac: the first run asks for the key
//
// and a round trip: the key one backend showed, typed into a second backend with no wallet, is
// the same wallet. proof-results.json says what each picture shows in words.
//
// The app is dark only (src/view/theme.ts has one colourway), so there is no light picture. One
// answer is given in the page, not by a backend: the restore that replaces a wallet, because a
// demo backend never shreds a key file (src/keystore/store.ts, forget). The refusal before it is
// the backend's own.
//
// Run: node scripts/key-backup-proof.ts
// playwright-core is not a dependency of this repo; point PLAYWRIGHT_CORE at a copy. Without
// playwright's own Chromium installed, point PROOF_BROWSER at a Chromium binary.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { seUnwrapWithSoftwareKey } from '../src/keystore/sewrap.ts';
import { proofOut } from './proof-out.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/47c97c996798144b/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const SHOTS = proofOut('key-backup-proof', 'key-backup');
const PASSWORD = 'proof-password-1';

type Json = any;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

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

// What the bridge would answer for the account, so the Vault's addresses row draws without a
// network call. Made-up addresses, the bridge's own row shape.
function bridgeFixture(): Json {
  const row = (id: string, symbol: string, decimals: number, min: string, intents: string): Json => ({
    defuse_asset_identifier: id,
    asset_name: symbol,
    decimals,
    min_deposit_amount: min,
    intents_token_id: intents,
  });
  return {
    addresses: {
      eth: '0x8f3c2a91e6b74d0c5f1a9e2b3c4d5e6f7a8b9c0d',
      base: '0x8f3c2a91e6b74d0c5f1a9e2b3c4d5e6f7a8b9c0d',
      arb: '0x8f3c2a91e6b74d0c5f1a9e2b3c4d5e6f7a8b9c0d',
    },
    tokens: [
      row('eth:1', 'ETH', 18, '100000000000', 'nep141:eth.omft.near'),
      row('eth:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', 6, '1000', 'nep141:eth-0xa0b8.omft.near'),
      row('eth:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6, '1000', 'nep141:base-0x8335.omft.near'),
      row('eth:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC', 6, '1000', 'nep141:arb-0xaf88.omft.near'),
    ],
  };
}

// ---------- a backend, and the shell in front of it ----------

type Backend = {
  name: string;
  base: string;
  token: string;
  dataDir: string;
  // Answer every unwrap the way a different Mac's enclave would: it does not know the key.
  foreign: { on: boolean };
  touches: string[];
  log: string[];
  stop: () => Promise<void>;
};

const backends: Backend[] = [];

async function startBackend(name: string): Promise<Backend> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `phosphor-key-proof-${name}-`));
  const home = path.join(dataDir, 'home');
  fs.mkdirSync(home);
  const fixture = path.join(dataDir, 'receive.json');
  fs.writeFileSync(fixture, JSON.stringify(bridgeFixture()));
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
      PHOSPHOR_DATA_DIR: path.join(dataDir, 'state'),
      PHOSPHOR_KEYS: path.join(dataDir, 'keys', 'keys.json'),
      PHOSPHOR_DEMO_RECEIVE: fixture,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  app.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
  // The shell's handshake: the window token, the identity nonce, the seat secret, the enclave
  // transport key and the relay secret, one a line (src/main.ts, readHandshake).
  app.stdin?.end([token, hex(16), hex(32), transport.toString('hex'), relay].join('\n') + '\n');

  const until = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/state`, { headers: { 'x-phosphor-token': token } });
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (app.exitCode !== null || Date.now() > until) throw new Error(`backend ${name} did not come up:\n${log.join('')}`);
    await sleep(150);
  }

  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const enclavePub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  const foreign = { on: false };
  const touches: string[] = [];
  let running = true;
  const relayPost = async (route: string, body: Json): Promise<Json> => {
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ relay, ...body }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const shell = (async () => {
    while (running) {
      let pending: Json;
      try {
        pending = await relayPost('/api/vault/pending', { waitMs: 300 });
      } catch {
        break;
      }
      if (pending.status !== 200) break;
      const request = pending.json?.request;
      if (!request) continue;
      touches.push(`${request.op}:${request.reason ?? ''}`);
      if (request.op === 'probe') {
        await relayPost('/api/vault/answer', { id: request.id, ok: true, secureEnclave: true, biometry: 'touchid', canAuthenticate: true });
      } else if (request.op === 'create') {
        await relayPost('/api/vault/answer', { id: request.id, ok: true, keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: enclavePub, binding: 'device' });
      } else if (request.op === 'presence') {
        await relayPost('/api/vault/answer', { id: request.id, ok: true });
      } else if (request.op === 'unwrap') {
        let dek: Buffer | null = null;
        if (!foreign.on) {
          try {
            dek = seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey, ciphertext: request.ciphertext }, pair.privateKey, Buffer.from(request.aad, 'base64'));
          } catch {
            dek = null;
          }
        }
        if (dek === null) {
          await relayPost('/api/vault/answer', { id: request.id, ok: false, error: 'foreign_key', message: 'not this enclave' });
          continue;
        }
        const nonce = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', transport, nonce);
        c.setAAD(Buffer.from(request.id, 'utf8'));
        const sealed = Buffer.concat([nonce, c.update(dek), c.final(), c.getAuthTag()]);
        dek.fill(0);
        await relayPost('/api/vault/answer', { id: request.id, ok: true, dekSealed: sealed.toString('base64') });
      }
    }
  })();

  const backend: Backend = {
    name,
    base,
    token,
    dataDir,
    foreign,
    touches,
    log,
    stop: async () => {
      running = false;
      if (app.exitCode === null) {
        const gone = new Promise<void>((resolve) => app.once('exit', () => resolve()));
        app.kill('SIGTERM');
        await Promise.race([gone, sleep(5_000)]);
        if (app.exitCode === null) app.kill('SIGKILL');
      }
      await shell.catch(() => undefined);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  backends.push(backend);
  return backend;
}

async function post(b: Backend, route: string, body: Json): Promise<Json> {
  const res = await fetch(`${b.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: b.base },
    body: JSON.stringify({ token: b.token, ...body }),
  });
  const json = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`${b.name} ${route}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function get(b: Backend, route: string): Promise<Json> {
  return await (await fetch(`${b.base}${route}`, { headers: { 'x-phosphor-token': b.token } })).json();
}

/* A wallet the way the oldest ones came to be: an EVM key and no phrase, under a password, then
   (when asked) moved behind the enclave. */
async function keyWallet(b: Backend, key: `0x${string}`, enclave: boolean): Promise<void> {
  await post(b, '/api/terms/accept', {});
  const imported = await post(b, '/api/wallet/import', { password: PASSWORD, keys: { evm: key } });
  if (imported.ok !== true) throw new Error(`import refused: ${JSON.stringify(imported)}`);
  if (enclave) {
    const moved = await post(b, '/api/vault/migrate', { password: PASSWORD });
    if (moved.ok !== true) throw new Error(`migrate refused: ${JSON.stringify(moved)}`);
  }
}

// ---------- the browser ----------

const SIZES = [
  { tag: '960', width: 960, height: 700 },
  { tag: '1180', width: 1180, height: 780 },
  { tag: '1680', width: 1680, height: 1050 },
];

type Shot = { file: string; state: string; size: string; says: string[] };
const results: { shots: Shot[]; checks: Record<string, unknown> } = { shots: [], checks: {} };

const ROW = (surface: string): string => `#view-vault .vault-row[data-surface="${surface}"]`;

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });

  const key = generatePrivateKey();
  const wallet = privateKeyToAccount(key).address;
  const groups = key.slice(2).match(/.{4}/g) as string[];

  async function page(b: Backend, size: { tag: string; width: number; height: number }): Promise<Json> {
    const p: Json = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
    p.on('pageerror', (err: unknown) => b.log.push(`[page] ${String(err)}\n`));
    p.on('console', (msg: Json) => {
      if (msg.type() === 'error') b.log.push(`[console.error] ${msg.text()}\n`);
    });
    await p.goto(`${b.base}/?token=${b.token}`, { waitUntil: 'load' });
    await p.waitForFunction('!!(window.PhosphorState && window.PhosphorState.get() && window.PhosphorState.get().vault)', null, { timeout: 20_000 });
    return p;
  }

  async function shoot(p: Json, size: { tag: string }, state: string, scope: string): Promise<void> {
    await p.evaluate('document.fonts.ready');
    await sleep(500);
    const file = path.join(SHOTS, `${state}-${size.tag}.png`);
    await p.screenshot({ path: file });
    const says = (await p.evaluate(`(function (sel) {
      var node = document.querySelector(sel);
      if (!node) return [];
      return node.innerText.split('\\n').map(function (t) { return t.trim(); }).filter(Boolean);
    })(${JSON.stringify(scope)})`)) as string[];
    results.shots.push({ file, state, size: size.tag, says });
  }

  async function toVault(p: Json, row: string): Promise<void> {
    await p.click('.tab[data-tab="vault"]');
    await p.waitForSelector(ROW('backup'), { timeout: 20_000 });
    await p.evaluate(`document.querySelector(${JSON.stringify(row)}).scrollIntoView({ block: 'center' })`);
    await sleep(300);
  }

  const button = (row: string, label: string): string => `${row} button:has(.btn-label:text-is("${label}"))`;

  try {
    // ---- A: a password wallet with no phrase, then the same wallet behind the enclave ----
    const a = await startBackend('a');
    await keyWallet(a, key, false);
    for (const size of SIZES) {
      const p = await page(a, size);
      // The card that offers Touch ID once at boot; this proof wants the row behind it.
      const later = await p.waitForSelector('#screen-migrate button:has-text("Not now")', { timeout: 10_000 }).catch(() => null);
      if (later) await later.click();
      await toVault(p, ROW('backup'));
      await shoot(p, size, 'software-row', ROW('backup'));
      await p.click(button(ROW('backup'), 'Back it up'));
      await p.waitForSelector(`${ROW('backup')} input[type="password"]`, { timeout: 10_000 });
      await shoot(p, size, 'software-password', ROW('backup'));
      await p.fill(`${ROW('backup')} input[type="password"]`, PASSWORD);
      await p.click(button(ROW('backup'), 'Show my key'));
      await p.waitForSelector(`${ROW('backup')} .vault-key`, { timeout: 10_000 });
      await p.evaluate(`document.querySelector(${JSON.stringify(ROW('backup'))}).scrollIntoView({ block: 'center' })`);
      await shoot(p, size, 'software-key', ROW('backup'));
      await p.click(button(ROW('backup'), 'Done'));
      await p.close();
    }

    await post(a, '/api/vault/migrate', { password: PASSWORD });
    for (const [i, size] of SIZES.entries()) {
      const p = await page(a, size);
      await toVault(p, ROW('backup'));
      await shoot(p, size, 'key-row', ROW('backup'));
      await shoot(p, size, 'key-notice', '#notice');
      await p.click(button(ROW('backup'), 'Back it up'));
      await p.waitForSelector(`${ROW('backup')} .vault-key`, { timeout: 10_000 });
      await p.evaluate(`document.querySelector(${JSON.stringify(ROW('backup'))}).scrollIntoView({ block: 'center' })`);
      await shoot(p, size, 'key-shown', ROW('backup'));
      const shown = (await p.evaluate(`Array.from(document.querySelectorAll('${ROW('backup')} .key-text')).map(function (n) { return n.textContent; })`)) as string[];
      results.checks[`groupsOnScreen-${size.tag}`] = shown.join('') === key.slice(2);

      await p.click(button(ROW('backup'), 'I wrote it down'));
      await p.waitForSelector(`${ROW('backup')} .vault-flow[data-step="prove"]`, { timeout: 10_000 });
      await shoot(p, size, 'key-prove', ROW('backup'));
      const asked = (await p.evaluate(`Array.from(document.querySelectorAll('${ROW('backup')} input[data-index]')).map(function (n) { return Number(n.dataset.index); })`)) as number[];
      const fill = async (values: string[]): Promise<void> => {
        const inputs = await p.$$(`${ROW('backup')} input[data-index]`);
        for (let at = 0; at < inputs.length; at += 1) await inputs[at].fill(values[at] ?? '');
      };
      await fill(['12g', '', '']);
      await fill(['12g', 'ab', 'abcd']);
      await p.click(button(ROW('backup'), 'Prove it'));
      await sleep(200);
      await shoot(p, size, 'key-prove-format', ROW('backup'));
      const wrong = asked.map((at) => (groups[at] === 'ffff' ? '0000' : 'ffff'));
      await fill(wrong);
      await p.click(button(ROW('backup'), 'Prove it'));
      await p.waitForSelector(`${ROW('backup')} .vault-error:not([hidden])`, { timeout: 10_000 });
      await sleep(300);
      await shoot(p, size, 'key-prove-wrong', ROW('backup'));

      if (i < SIZES.length - 1) {
        await p.click(button(ROW('backup'), 'Prove it'));
        await p.waitForSelector(`${ROW('backup')} .vault-flow[data-step="key"]`, { timeout: 10_000 });
        await p.evaluate(`document.querySelector(${JSON.stringify(ROW('backup'))}).scrollIntoView({ block: 'center' })`);
        await shoot(p, size, 'key-two-misses', ROW('backup'));
        await p.click(button(ROW('backup'), 'Done'));
        await toVault(p, ROW('danger'));
        await shoot(p, size, 'key-forget-waits', ROW('danger'));
        await p.close();
        continue;
      }

      // The last size proves it: the right three groups, typed the way a person copies them.
      await fill(asked.map((at) => `${groups[at]!.slice(0, 2).toUpperCase()} ${groups[at]!.slice(2)}`));
      await p.click(button(ROW('backup'), 'Prove it'));
      await p.waitForSelector(`${ROW('backup')} .vault-backup-line[data-backed="true"]`, { timeout: 10_000 });
      await shoot(p, size, 'proven-toast', '#view-vault');
      await p.close();
    }
    results.checks.provenAfterThreeGroups = (await get(a, '/api/vault')).backedUp === true;

    for (const size of SIZES) {
      const p = await page(a, size);
      await toVault(p, ROW('backup'));
      await shoot(p, size, 'proven-row', ROW('backup'));
      // Check my copy: the whole key against the wallet, right and then with one slip.
      await p.click(button(ROW('backup'), 'Check my copy'));
      await p.waitForSelector(`${ROW('backup')} .vault-flow[data-step="check"] textarea`, { timeout: 10_000 });
      await shoot(p, size, 'check-open', ROW('backup'));
      await p.fill(`${ROW('backup')} textarea`, groups.join(' '));
      await p.click(button(ROW('backup'), 'Check'));
      await p.waitForSelector(`${ROW('backup')} .vault-check-line:not([hidden])`, { timeout: 10_000 });
      await shoot(p, size, 'check-right', ROW('backup'));
      const slipped = [...groups];
      slipped[9] = slipped[9] === 'ffff' ? '0000' : 'ffff';
      await p.fill(`${ROW('backup')} textarea`, slipped.join(' '));
      await p.click(button(ROW('backup'), 'Check'));
      await p.waitForSelector(`${ROW('backup')} .vault-error:not([hidden])`, { timeout: 10_000 });
      await shoot(p, size, 'check-wrong', ROW('backup'));
      await p.click(button(ROW('backup'), 'Done'));
      await toVault(p, ROW('recovery'));
      await p.click(button(ROW('recovery'), 'Restore from a key'));
      await p.waitForSelector(`${ROW('recovery')} textarea`, { timeout: 10_000 });
      await shoot(p, size, 'restore-open', ROW('recovery'));
      await p.fill(`${ROW('recovery')} textarea`, groups.join(' ').slice(0, -1));
      await p.click(button(ROW('recovery'), 'Restore'));
      await sleep(200);
      await shoot(p, size, 'restore-short', ROW('recovery'));
      // The key as written on the sheet: 0x, two lines, upper case.
      await p.fill(`${ROW('recovery')} textarea`, `0x${groups.slice(0, 8).join(' ').toUpperCase()}\n${groups.slice(8).join(' ').toUpperCase()}`);
      await p.click(button(ROW('recovery'), 'Restore'));
      await sleep(200);
      await shoot(p, size, 'restore-confirm', ROW('recovery'));
      await p.click(button(ROW('recovery'), 'Restore'));
      await p.waitForSelector(`${ROW('recovery')} .vault-error:not([hidden])`, { timeout: 10_000 });
      await sleep(200);
      await shoot(p, size, 'restore-same-wallet', ROW('recovery'));

      // A different key: the one answer given in the page (see the head of this file).
      const other = generatePrivateKey();
      const otherWallet = privateKeyToAccount(other).address;
      await p.route('**/api/vault/restore', (route: Json) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, addresses: { evm: otherWallet }, custody: 'secure-enclave' }) }));
      await p.fill(`${ROW('recovery')} textarea`, other);
      await p.click(button(ROW('recovery'), 'Restore'));
      await p.click(button(ROW('recovery'), 'Restore'));
      await p.waitForSelector('.toast', { timeout: 10_000 }).catch(() => null);
      await sleep(300);
      await shoot(p, size, 'restore-done', 'body');
      await p.unroute('**/api/vault/restore');
      await p.close();
    }

    // ---- B: the round trip, the key A showed typed into a backend with no wallet ----
    const shownByA = await post(a, '/api/vault/reveal-key', {});
    const b = await startBackend('b');
    await post(b, '/api/terms/accept', {});
    const restored = await post(b, '/api/vault/restore', { key: (shownByA.groups as string[]).join(' ') });
    const bVault = await get(b, '/api/vault');
    results.checks.roundTrip = {
      aWallet: wallet,
      aShowed: shownByA.address,
      bRestored: restored.addresses?.evm ?? null,
      same: restored.ok === true && restored.addresses?.evm === wallet && shownByA.address === wallet,
      bHasMnemonic: bVault.hasMnemonic,
      bBackedUp: bVault.backedUp,
      bTouches: b.touches,
    };

    // ---- C: the file on another Mac: its enclave does not know the key ----
    const c = await startBackend('c');
    await keyWallet(c, key, true);
    await post(c, '/api/lock', {});
    c.foreign.on = true;
    for (const size of SIZES) {
      const p = await page(c, size);
      const unlock = await p.waitForSelector('#screen-lock button.lock-unlock', { timeout: 10_000 }).catch(() => null);
      if (unlock) await unlock.click();
      await p.waitForSelector('#screen-firstrun:not([hidden])', { timeout: 15_000 });
      const start = await p.waitForSelector('#screen-firstrun button:has-text("Get started")', { timeout: 10_000 }).catch(() => null);
      if (start) await start.click();
      // The invite step comes before Restore on this flow; this proof has no code to give it.
      const skip = await p.waitForSelector('#screen-firstrun button:has(.btn-label:text-is("Skip"))', { timeout: 5_000 }).catch(() => null);
      if (skip) await skip.click();
      await p.waitForSelector('#screen-firstrun textarea', { timeout: 10_000 });
      await sleep(600);
      await shoot(p, size, 'foreign-key', '#screen-firstrun');
      await p.fill('#screen-firstrun textarea', 'not a key');
      await p.click('#screen-firstrun button:has(.btn-label:text-is("Restore"))');
      await sleep(300);
      await shoot(p, size, 'foreign-key-error', '#screen-firstrun');
      await p.close();
    }
    results.checks.foreignTouches = c.touches.filter((t) => t.startsWith('unwrap'));
    results.checks.touchesA = a.touches;
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(SHOTS, 'proof-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ shots: results.shots.length, checks: results.checks }, null, 2));
  const noise = backends.flatMap((b) => b.log.filter((l) => l.startsWith('[page]') || l.startsWith('[console')));
  if (noise.length) console.log(`browser noise:\n${noise.join('')}`);
}

async function stopAll(): Promise<void> {
  for (const b of backends) await b.stop().catch(() => undefined);
}

process.on('SIGINT', () => {
  void stopAll().then(() => process.exit(1));
});

main()
  .then(async () => {
    await stopAll();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    for (const b of backends) console.error(`--- ${b.name}\n${b.log.slice(-30).join('')}`);
    await stopAll();
    process.exit(1);
  });
