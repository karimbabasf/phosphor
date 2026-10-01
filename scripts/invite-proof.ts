// The invite code in the window, proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with an EMPTY data directory, so the window opens on
// the first run, then drives headless Chromium through playwright-core at 1280 x 800 (two device
// pixels per CSS pixel; PROOF_VIEWPORT=960x700 shoots at the window's minimum size) and shoots
// every state an invite code has: the terms card, the first run's step (empty, checking, a good
// code and each refusal), the claim on the addresses step (running, landed, failed), the toast a
// claim that ends after the person moved on becomes (a failed one stays until it is closed), the
// Add money line on Basic (a failure kept on the closed line, closed, open, a good code, running,
// landed, offline, a used code, failed), and the chat keeping a pasted code out of the
// conversation while the words around it stay. Each state also records the key a person would
// press next and whether the invite line is inside its scroller, and the run ends on one summary
// line.
//
// Everything is the real backend: the window asks the app's own routes, the app's claim signs and
// watches, and each claim's end reaches the window as the app's own frame. Only the network is
// pretend: PHOSPHOR_DEMO_INVITE names a file (src/invite/demo.ts) that holds what each made-up
// code is worth and how it behaves, keyed by the code's account, and nothing leaves this Mac. Two
// runs, because a claim's end is said once: one lands on the addresses step, the other fails there
// and goes on to Basic. A code is "busy" only while a claim runs, and no claim runs before a
// wallet exists, so the first run's step never shows it; the unit tests do.
//
// Fixture data only: temp directories, never the live wallet, and codes made of a repeated byte
// that were never issued. Run:
//   node scripts/invite-proof.ts
// PROOF_OUT names another directory for the pictures (default docs/screenshots/invite/), and
// PROOF_VIEWPORT another window size as WIDTHxHEIGHT (default 1280x800; 960x700 is the smallest
// the app's window opens at, src-tauri/src/main.rs min_inner_size).
// playwright-core is not a dependency of this repo; point PLAYWRIGHT_CORE at a copy. Without
// playwright's own Chromium installed, point PROOF_BROWSER at a Chromium binary.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeAddress, formatCode } from '../src/invite/code.ts';
import { DEMO_INVITE_ENV } from '../src/invite/demo.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/47c97c996798144b/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const SHOTS = process.env.PROOF_OUT ?? path.join(ROOT, 'docs', 'screenshots', 'invite');
const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.PROOF_VIEWPORT ?? '1280x800');
  if (!m) throw new Error('PROOF_VIEWPORT is WIDTHxHEIGHT, for example 960x700');
  return { width: Number(m[1]), height: Number(m[2]) };
})();

/* One made-up code per part it plays, since a code pays once. Each is a repeated byte whose code
   parses; the demo world holds what each stands for, by its account. */
const PARTS = {
  slow: { byte: 0x52, world: { usdc: '5.00', slowMs: 5_000 } },
  used: { byte: 0x43, world: null },
  offline: { byte: 0x45, world: { usdc: '5.00', offline: true } },
  locked: { byte: 0x44, world: { usdc: '5.00', locked: true } },
  landsA: { byte: 0x42, world: { usdc: '5.00', landMs: 3_000 } },
  failsB: { byte: 0x47, world: { usdc: '5.00', refusal: 'insufficient balance or overflow' } },
  toastLands: { byte: 0x49, world: { usdc: '5.00', landMs: 1_500 } },
  toastFails: { byte: 0x48, world: { usdc: '5.00', refusal: 'insufficient balance or overflow' } },
  addLands: { byte: 0x4a, world: { usdc: '5.00', landMs: 4_000 } },
  addFails: { byte: 0x51, world: { usdc: '5.00', refusal: 'insufficient balance or overflow' } },
} as const;
type Part = keyof typeof PARTS;

const secretOf = (part: Part): Uint8Array => new Uint8Array(16).fill(PARTS[part].byte);
const codeOf = (part: Part): string => formatCode(secretOf(part));
const CODE = codeOf('landsA');
// One character off the end: the check symbol catches it on this Mac.
const TYPO = CODE.slice(0, -1) + (CODE.endsWith('0') ? '1' : '0');

function worldFile(dir: string): string {
  const accounts: Record<string, unknown> = {};
  for (const part of Object.keys(PARTS) as Part[]) {
    const world = PARTS[part].world;
    if (world !== null) accounts[codeAddress(secretOf(part))!] = world;
  }
  const file = path.join(dir, 'invite-world.json');
  fs.writeFileSync(file, JSON.stringify({ accounts }));
  return file;
}

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

type Backend = { base: string; token: string; app: ChildProcess; dataDir: string; worldDir: string };
const backends: Backend[] = [];
const log: string[] = [];

async function startApp(): Promise<Backend> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-proof-'));
  const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-world-'));
  const base = `http://127.0.0.1:${port}`;
  const app = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ACC_MODE: 'demo', ACC_PORT: String(port), ACC_DATA_DIR: dataDir, [DEMO_INVITE_ENV]: worldFile(worldDir) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const own: string[] = [];
  app.stdout?.on('data', (d: Buffer) => own.push(d.toString()));
  app.stderr?.on('data', (d: Buffer) => own.push(d.toString()));
  const backend: Backend = { base, token: '', app, dataDir, worldDir };
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

/* A backend writes its audit tip as it shuts down, so its data dir goes once it has exited. */
async function stopAndWait(): Promise<void> {
  await Promise.all(backends.map((backend) => new Promise<void>((resolve) => {
    if (backend.app.exitCode !== null || backend.app.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 5_000);
    backend.app.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    backend.app.kill('SIGTERM');
  })));
  stopAll();
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
    for (const dir of [backend.dataDir, backend.worldDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // a temp dir that would not go is not a failure of the proof
      }
    }
  }
}

// ---------- the page ----------

/* Waits until a line the invite screens draw says these words, from the app's own answer or
   frame. */
async function said(page: Json, words: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(`Array.prototype.slice.call(document.querySelectorAll('.invite-said'))
    .some(function (n) { return n.getClientRects().length > 0 && n.textContent.indexOf(${JSON.stringify(words)}) >= 0; })`, undefined, { timeout });
  await sleep(450);
}

async function toasted(page: Json, words: string): Promise<void> {
  await page.waitForFunction(`Array.prototype.slice.call(document.querySelectorAll('.toast'))
    .some(function (n) { return n.textContent.indexOf(${JSON.stringify(words)}) >= 0; })`, undefined, { timeout: 20_000 });
  await sleep(450);
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
  var body = document.querySelector('#screen-firstrun:not([hidden]) .screen-body');
  var scroll = document.scrollingElement ? document.scrollingElement.scrollHeight - window.innerHeight : 0;
  /* The key a person would press next, and whether the line about the code is inside its scroller. */
  var key = Array.prototype.slice.call(document.querySelectorAll('#screen-firstrun:not([hidden]) .screen-actions .btn-lg:last-child, .invite-use'))
    .filter(function (n) { return n.getClientRects().length > 0; })[0];
  var line = Array.prototype.slice.call(document.querySelectorAll('.invite-said'))
    .filter(function (n) { return !n.hidden && n.getClientRects().length > 0; })[0];
  var lineInView = null;
  if (line) {
    var r = line.getBoundingClientRect();
    var top = 0, bottom = window.innerHeight;
    for (var n = line.parentElement; n && n !== document.body; n = n.parentElement) {
      if (!/auto|scroll|hidden|clip/.test(getComputedStyle(n).overflowY)) continue;
      var b = n.getBoundingClientRect();
      top = Math.max(top, b.top);
      bottom = Math.min(bottom, b.bottom);
    }
    lineInView = r.top >= top - 1 && r.bottom <= bottom + 1;
  }
  return { title: title, said: said, toasts: toasts, codeShownAsText: codeOnPage, pageScrolls: scroll > 0,
    cardScrolls: body ? body.scrollHeight > body.clientHeight + 1 : null,
    key: key ? { label: key.textContent, disabled: key.disabled } : null, lineInView: lineInView };
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
  const page: Json = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, bypassCSP: true });
  page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
  page.on('console', (msg: Json) => {
    if (msg.type() === 'error' || msg.type() === 'warning') log.push(`[console.${msg.type()}] ${msg.text()}\n`);
  });
  await page.goto(`${backend.base}/?token=${backend.token}`, { waitUntil: 'load' });
  await page.waitForSelector('#screen-firstrun .firstrun-welcome', { timeout: 20_000 });
  await page.evaluate('document.fonts.ready');
  await sleep(1800);
  await page.click('#screen-firstrun .firstrun-welcome .btn-primary');
  await sleep(450);
  if ((await title(page)) === 'Before you start') {
    await sleep(600);
    if (!shots.some((file) => file.endsWith('firstrun-terms.png'))) await shoot(page, 'firstrun-terms');
    await page.click(primary);
  }
  await waitTitle(page, 'Have an invite code?');
  return page;
}

/* A code typed into the step, and Use code: the app's own check answers it. */
async function check(page: Json, code: string): Promise<void> {
  await page.fill('#screen-firstrun .invite-input', code);
  await page.click(primary);
  await sleep(600);
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
    // ---------- run A: the terms, the step, every check, and a claim that lands in place ----------
    const a = await startApp();
    const page = await open(browser, a);
    await shoot(page, 'firstrun-invite-empty');
    await check(page, codeOf('slow'));
    await shoot(page, 'firstrun-invite-checking');
    await said(page, 'waiting for you');
    const refusals: Array<[string, string, string]> = [
      ['typo', TYPO, 'has a typo'],
      ['used', codeOf('used'), 'nothing left'],
      ['offline', codeOf('offline'), "Couldn't check"],
      ['locked', codeOf('locked'), "can't pay out"],
    ];
    for (const [name, code, words] of refusals) {
      await check(page, code);
      await said(page, words);
      await shoot(page, `firstrun-invite-${name}`);
    }
    await check(page, CODE);
    await said(page, 'waiting for you');
    await shoot(page, 'firstrun-invite-valid');
    await toAddresses(page);
    await said(page, 'Adding $5');
    await shoot(page, 'firstrun-addresses-running');
    await said(page, 'is in your wallet');
    await shoot(page, 'firstrun-addresses-landed');
    await page.close();

    // ---------- run B: a claim that fails in place, then Basic: the toasts, Add money, the chat ----------
    const b = await startApp();
    const second = await open(browser, b);
    await check(second, codeOf('failsB'));
    await said(second, 'waiting for you');
    await toAddresses(second);
    await said(second, "didn't come through");
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
    await second.evaluate(`window.PhosphorInvite.claim(${JSON.stringify(codeOf('toastLands'))}, { amount: '5.00', asset: 'USDC' })`);
    await toasted(second, 'is in your wallet');
    await shoot(second, 'basic-toast-landed');
    await second.waitForFunction('document.querySelectorAll(".toast").length === 0', undefined, { timeout: 12_000 });
    await second.evaluate(`window.PhosphorInvite.claim(${JSON.stringify(codeOf('toastFails'))}, { amount: '5.00', asset: 'USDC' })`);
    await toasted(second, "didn't come through");
    await shoot(second, 'basic-toast-failed');
    // Money that did not come stays said: past the 7 s a toast lives, until its close key.
    await sleep(8_000);
    await shoot(second, 'basic-toast-failed-stays');
    await second.click('.toast-stay .dock-close');
    await second.waitForFunction('document.querySelectorAll(".toast").length === 0', undefined, { timeout: 12_000 });

    // Add money on Basic: the closed line still says the claim did not come through, until it is opened.
    await second.click('.bal-add');
    await second.waitForSelector('.invite-open', { timeout: 10_000 });
    await said(second, "didn't come through");
    await shoot(second, 'addmoney-kept-failure');
    await second.click('.invite-open');
    await sleep(500);
    await second.click('.invite-open');
    await sleep(500);
    await shoot(second, 'addmoney-line');
    await second.click('.invite-open');
    await sleep(500);
    await shoot(second, 'addmoney-open');
    await second.fill('.invite-input', codeOf('addLands'));
    await second.click('.invite-use');
    await said(second, 'waiting for you');
    await shoot(second, 'addmoney-valid');
    await second.click('.invite-use');
    await said(second, 'Adding $5');
    await shoot(second, 'addmoney-running');
    await said(second, 'is in your wallet');
    await shoot(second, 'addmoney-landed');
    await second.click('.invite-open');
    await sleep(400);
    await second.fill('.invite-input', codeOf('offline'));
    await second.click('.invite-use');
    await said(second, "Couldn't check");
    await shoot(second, 'addmoney-offline');
    await second.fill('.invite-input', codeOf('used'));
    await second.click('.invite-use');
    await said(second, 'nothing left');
    await shoot(second, 'addmoney-used');
    await second.fill('.invite-input', codeOf('addFails'));
    await second.click('.invite-use');
    await said(second, 'waiting for you');
    await second.click('.invite-use');
    await said(second, "didn't come through");
    await shoot(second, 'addmoney-failed');

    // The chat: a pasted code never goes, and opens the field instead.
    await second.click('.bal-done');
    await sleep(700);
    await second.evaluate(`window.PhosphorEvents.emit('driver', ${JSON.stringify({ chat: 'c1', event: { kind: 'status', state: 'ready', at: Date.now() } })})`);
    await second.waitForSelector('.composer-input', { state: 'visible', timeout: 10_000 });
    await second.fill('.composer-input', CODE);
    await sleep(900);
    await shoot(second, 'chat-code-kept-out');
    results['chat-code-kept-out-composer'] = await second.evaluate('document.querySelector(".composer-input").value');
    // Words around the code stay in the box; only the code goes.
    await second.fill('.composer-input', `here is my invite ${CODE} thanks`);
    await sleep(900);
    await shoot(second, 'chat-words-kept');
    results['chat-words-kept-composer'] = await second.evaluate('document.querySelector(".composer-input").value');
    await second.close();

    results.screenshots = shots;
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
  /* The proof's own summary: how many states, at what size, and whether any drew the code. */
  const states = shots.map((file) => path.basename(file, '.png'));
  const drawn = states.filter((name) => (results[name] as { codeShownAsText?: boolean } | undefined)?.codeShownAsText !== false);
  const hidden = states.filter((name) => (results[name] as { lineInView?: boolean | null } | undefined)?.lineInView === false);
  console.log(`proof: ${states.length} states shot at ${VIEWPORT.width}x${VIEWPORT.height} into ${SHOTS}; code shown as text in ${drawn.length}${drawn.length ? ` (${drawn.join(', ')})` : ''}; invite line under a fold in ${hidden.length}${hidden.length ? ` (${hidden.join(', ')})` : ''}`);
  const noise = log.filter((l) => l.startsWith('[page]') || l.startsWith('[console'));
  if (noise.length) console.log(`browser noise:\n${noise.join('')}`);
}

process.on('exit', stopAll);
process.on('SIGINT', () => {
  stopAll();
  process.exit(1);
});

main()
  .then(async () => {
    await stopAndWait();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    console.error(log.slice(-40).join(''));
    await stopAndWait();
    process.exit(1);
  });
