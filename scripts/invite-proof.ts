// The invite code in the window, proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with an EMPTY data directory, so the window opens on
// the first run, then drives headless Chromium through playwright-core at 1280 x 800 (two device
// pixels per CSS pixel) and shoots every state an invite code has: the first run's step (empty,
// checking, a good code and each refusal), the claim on the addresses step (running, landed,
// failed), the toast a claim that ends after the person moved on becomes, the Add money line on
// Basic (closed, open, a good code, running, landed, a refusal, failed), and the chat keeping a
// pasted code out of the conversation.
//
// The two invite routes are the backend's, on its own branch until it merges. The window calls
// them through one file, ui/core/invite.js, so this proof answers them there, in the page, and
// says each claim's end on the window's own bus (PhosphorEvents.emit) the way the SSE frame
// would. Everything else is the real demo backend. Two runs, because a claim's end is said once:
// one lands on the addresses step, the other fails there and goes on to Basic.
//
// Fixture data only: temp directories, never the live wallet, and a code the shape of a real one
// that was never issued. Run:
//   node scripts/invite-proof.ts
// PROOF_OUT names another directory for the pictures (default docs/screenshots/invite/).
// playwright-core is not a dependency of this repo; point PLAYWRIGHT_CORE at a copy. Without
// playwright's own Chromium installed, point PROOF_BROWSER at a Chromium binary.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/47c97c996798144b/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const SHOTS = process.env.PROOF_OUT ?? path.join(ROOT, 'docs', 'screenshots', 'invite');

const CODE = 'PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ';
const GOOD = { ok: true, amount: '5.00', asset: 'USDC', route: 'relay', net: '5.00' };

type Json = any;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
}

// ---------- the backend ----------

type Backend = { base: string; token: string; app: ChildProcess; dataDir: string };
const backends: Backend[] = [];
const log: string[] = [];

async function startApp(): Promise<Backend> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-proof-'));
  const base = `http://127.0.0.1:${port}`;
  const app = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ACC_MODE: 'demo', ACC_PORT: String(port), ACC_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const own: string[] = [];
  app.stdout?.on('data', (d: Buffer) => own.push(d.toString()));
  app.stderr?.on('data', (d: Buffer) => own.push(d.toString()));
  const backend: Backend = { base, token: '', app, dataDir };
  backends.push(backend);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const m = /minted one: ([0-9a-f]{16,})/.exec(own.join(''));
    if (m && backend.token === '') backend.token = m[1] as string;
    if (backend.token !== '') {
      try {
        const res = await fetch(`${base}/api/state`);
        if (res.ok) return backend;
      } catch {
        // not listening yet
      }
    }
    if (app.exitCode !== null) break;
    await sleep(150);
  }
  throw new Error(`the demo backend did not come up:\n${own.join('')}`);
}

function stopAll(): void {
  for (const backend of backends) {
    if (backend.app.exitCode === null) {
      try {
        backend.app.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    try {
      fs.rmSync(backend.dataDir, { recursive: true, force: true });
    } catch {
      // a temp dir that would not go is not a failure of the proof
    }
  }
}

// ---------- the page ----------

/* The invite routes, answered in the page through the one file that calls them. `hang` is a
   check that never answers, to shoot the wait. */
const STUB = `(function () {
  var door = window.PhosphorInviteApi;
  window.__invite = window.__invite || { check: null, claim: null };
  door.check = function () {
    var a = window.__invite.check;
    return a === 'hang' ? new Promise(function () {}) : Promise.resolve(a);
  };
  door.claim = function () { return Promise.resolve(window.__invite.claim); };
})()`;

async function answer(page: Json, route: 'check' | 'claim', value: Json): Promise<void> {
  await page.evaluate(`window.__invite.${route} = ${JSON.stringify(value)}`);
}

/* A claim's end, on the bus the stream's frames come through. */
async function end(page: Json, claim: string, status: 'landed' | 'failed'): Promise<void> {
  await page.evaluate(`window.PhosphorEvents.emit('invite', ${JSON.stringify({ type: 'invite', claim, status, amount: '5.00', asset: 'USDC' })})`);
  await sleep(700);
}

const results: Record<string, unknown> = {};
const shots: string[] = [];

/* What the picture cannot show: the one line under the field and the key beside it. */
const READ = `(function () {
  var said = Array.prototype.slice.call(document.querySelectorAll('.invite-said, .composer-aside'))
    .filter(function (n) { return !n.hidden && n.getClientRects().length > 0; })
    .map(function (n) { return n.textContent; });
  var toasts = Array.prototype.slice.call(document.querySelectorAll('.toast')).map(function (n) { return n.textContent; });
  var title = (document.querySelector('#screen-firstrun:not([hidden]) .screen-body h1') || {}).textContent || null;
  var codeOnPage = document.body.innerText.indexOf(${JSON.stringify(CODE)}) >= 0;
  return { title: title, said: said, toasts: toasts, codeShownAsText: codeOnPage };
})()`;

async function shoot(page: Json, name: string): Promise<void> {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  results[name] = await page.evaluate(READ);
}

const title = async (page: Json): Promise<string> =>
  String(await page.evaluate('(document.querySelector("#screen-firstrun .screen-body h1") || {}).textContent'));

async function waitTitle(page: Json, words: string): Promise<void> {
  await page.waitForFunction(`(document.querySelector("#screen-firstrun .screen-body h1") || {}).textContent === ${JSON.stringify(words)}`, undefined, { timeout: 10_000 });
  await sleep(450);
}

const primary = '#screen-firstrun .screen-body .screen-actions .btn-lg:last-child';

async function open(browser: Json, backend: Backend): Promise<Json> {
  const page: Json = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, bypassCSP: true });
  page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
  page.on('console', (msg: Json) => {
    if (msg.type() === 'error' || msg.type() === 'warning') log.push(`[console.${msg.type()}] ${msg.text()}\n`);
  });
  await page.goto(`${backend.base}/?token=${backend.token}`, { waitUntil: 'load' });
  await page.waitForSelector('#screen-firstrun .firstrun-welcome', { timeout: 20_000 });
  await page.evaluate('document.fonts.ready');
  await page.evaluate(STUB);
  await sleep(1800);
  await page.click('#screen-firstrun .firstrun-welcome .btn-primary');
  await sleep(450);
  if ((await title(page)) === 'Before you start') {
    await page.click(primary);
  }
  await waitTitle(page, 'Got an invite code?');
  return page;
}

/* A code typed into the step, and Use code. */
async function check(page: Json, value: Json): Promise<void> {
  await answer(page, 'check', value);
  await page.fill('#screen-firstrun .invite-input', CODE);
  await page.click(primary);
  await sleep(500);
}

/* From a good code on the invite step to the addresses step, through the software flow the demo
   backend runs: Continue, a new wallet, a password, the words read off the page and three of
   them typed back by their number. */
async function toAddresses(page: Json): Promise<void> {
  await page.click(primary); // Continue, with the good code
  await waitTitle(page, 'Create or bring a wallet');
  await page.click(primary);
  await waitTitle(page, 'Set a password');
  await page.fill('#screen-firstrun .screen-body .field:nth-of-type(1) input', 'proof-password-1');
  await page.evaluate(`(function () {
    var fields = document.querySelectorAll('#screen-firstrun .screen-body input.input');
    fields[1].value = 'proof-password-1';
  })()`);
  await page.click(primary);
  await waitTitle(page, 'Save your recovery words');
  const words = (await page.evaluate('Array.from(document.querySelectorAll("#screen-firstrun .word-text")).map(function (n) { return n.textContent; })')) as string[];
  if (words.length !== 12) throw new Error(`expected twelve words on the page, saw ${words.length}`);
  await page.click('#screen-firstrun .screen-body input[type="checkbox"]');
  await sleep(100);
  await page.click(primary);
  await waitTitle(page, 'Prove it');
  await page.evaluate(`(function (w) {
    var fields = document.querySelectorAll('#screen-firstrun .screen-body input.input');
    for (var i = 0; i < fields.length; i += 1) fields[i].value = w[Number(fields[i].dataset.index)];
  })(${JSON.stringify(words)})`);
  await page.click(primary);
  await waitTitle(page, 'Your addresses');
}

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  // Untyped on purpose: playwright-core is not a dependency of this repo.
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });

  try {
    // ---------- run A: the step, every check, and a claim that lands in place ----------
    const a = await startApp();
    const page = await open(browser, a);
    await shoot(page, 'firstrun-invite-empty');
    await check(page, 'hang');
    await shoot(page, 'firstrun-invite-checking');
    const refusals: Array<[string, Json]> = [
      ['typo', { ok: false, reason: 'typo' }],
      ['used', { ok: false, reason: 'empty' }],
      ['offline', { ok: false, reason: 'offline' }],
      ['locked', { ok: false, reason: 'locked' }],
      ['busy', { ok: false, reason: 'busy' }],
    ];
    for (const [name, value] of refusals) {
      await check(page, value);
      await shoot(page, `firstrun-invite-${name}`);
    }
    await check(page, GOOD);
    await shoot(page, 'firstrun-invite-valid');
    await answer(page, 'claim', { ok: true, claim: 'proof-1' });
    await toAddresses(page);
    await shoot(page, 'firstrun-addresses-running');
    await end(page, 'proof-1', 'landed');
    await shoot(page, 'firstrun-addresses-landed');
    await page.close();

    // ---------- run B: a claim that fails in place, then Basic: the toasts, Add money, the chat ----------
    const b = await startApp();
    const second = await open(browser, b);
    await check(second, GOOD);
    await answer(second, 'claim', { ok: true, claim: 'proof-2' });
    await toAddresses(second);
    await end(second, 'proof-2', 'failed');
    await shoot(second, 'firstrun-addresses-failed');

    // On through the steps to Basic.
    await second.click(primary); // addresses
    await waitTitle(second, 'Add money');
    await second.click('#screen-firstrun .screen-body .screen-actions .btn-quiet');
    await waitTitle(second, 'Your assistant');
    await second.click('#screen-firstrun .screen-body .screen-actions .btn-quiet');
    await waitTitle(second, 'When should it ask you?');
    await second.click(primary);
    await waitTitle(second, 'Phosphor is ready');
    await second.click(primary);
    await second.waitForSelector('#screen-firstrun', { state: 'hidden', timeout: 10_000 });
    await second.waitForSelector('.bal-add', { timeout: 10_000 });
    await sleep(1200);

    // A claim that ends after the person moved on: a toast on Basic, each way.
    await answer(second, 'claim', { ok: true, claim: 'proof-3' });
    await second.evaluate(`window.PhosphorInvite.claim(${JSON.stringify(CODE)}, { amount: '5.00', asset: 'USDC' })`);
    await sleep(200);
    await end(second, 'proof-3', 'landed');
    await shoot(second, 'basic-toast-landed');
    await second.waitForFunction('document.querySelectorAll(".toast").length === 0', undefined, { timeout: 10_000 });
    await answer(second, 'claim', { ok: true, claim: 'proof-4' });
    await second.evaluate(`window.PhosphorInvite.claim(${JSON.stringify(CODE)}, { amount: '5.00', asset: 'USDC' })`);
    await sleep(200);
    await end(second, 'proof-4', 'failed');
    await shoot(second, 'basic-toast-failed');
    await second.waitForFunction('document.querySelectorAll(".toast").length === 0', undefined, { timeout: 12_000 });

    // Add money on Basic.
    await second.click('.bal-add');
    await second.waitForSelector('.invite-open', { timeout: 10_000 });
    await sleep(700);
    await shoot(second, 'addmoney-line');
    await second.click('.invite-open');
    await sleep(500);
    await shoot(second, 'addmoney-open');
    await answer(second, 'check', GOOD);
    await second.fill('.invite-input', CODE);
    await second.click('.invite-use');
    await sleep(500);
    await shoot(second, 'addmoney-valid');
    await answer(second, 'claim', { ok: true, claim: 'proof-5' });
    await second.click('.invite-use');
    await sleep(500);
    await shoot(second, 'addmoney-running');
    await end(second, 'proof-5', 'landed');
    await shoot(second, 'addmoney-landed');
    await second.click('.invite-open');
    await sleep(400);
    await answer(second, 'check', { ok: false, reason: 'offline' });
    await second.fill('.invite-input', CODE);
    await second.click('.invite-use');
    await sleep(500);
    await shoot(second, 'addmoney-offline');
    await answer(second, 'check', GOOD);
    await second.click('.invite-use');
    await sleep(400);
    await answer(second, 'claim', { ok: true, claim: 'proof-6' });
    await second.click('.invite-use');
    await sleep(300);
    await end(second, 'proof-6', 'failed');
    await shoot(second, 'addmoney-failed');

    // The chat: a pasted code never goes, and opens the field instead.
    await second.click('.bal-done');
    await sleep(700);
    await second.evaluate(`window.PhosphorEvents.emit('driver', ${JSON.stringify({ chat: 'c1', event: { kind: 'status', state: 'ready', at: Date.now() } })})`);
    await second.waitForSelector('.composer-input', { state: 'visible', timeout: 10_000 });
    await answer(second, 'check', GOOD);
    await second.fill('.composer-input', CODE);
    await sleep(900);
    await shoot(second, 'chat-code-kept-out');
    results['chat-code-kept-out-composer'] = await second.evaluate('document.querySelector(".composer-input").value');
    await second.close();

    results.screenshots = shots;
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
  const noise = log.filter((l) => l.startsWith('[page]') || l.startsWith('[console'));
  if (noise.length) console.log(`browser noise:\n${noise.join('')}`);
}

process.on('exit', stopAll);
process.on('SIGINT', () => {
  stopAll();
  process.exit(1);
});

main()
  .then(() => {
    stopAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    console.error(log.slice(-40).join(''));
    stopAll();
    process.exit(1);
  });
