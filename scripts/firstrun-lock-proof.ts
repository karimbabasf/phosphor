// The first run under a lock, proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with an EMPTY data directory and a throwaway home, and
// runs the password first run in headless Chromium up to the recovery words. Then it locks the
// wallet the way the screen lock does (POST /api/lock with the shell's reason) and reads what is in
// front: the lock card has to be under the pointer and hold the keyboard, and no word may be left
// on screen. It unlocks through the card, checks the first run is back on the same step with the
// same words, types three of them back on Prove it and waits for Your addresses. Before
// ui/design/lock.css put the card in front, the first run painted over it: the words stayed up
// with nobody at the desk and the unlock field sat under them, holding the keyboard. Along the
// way it counts the frames the field behind the first run draws: about 30 a second while it
// shows, none while the window is hidden (the page's visibility set the way WebKit sets it) or
// the lock card is up, and 30 again after.
//
// One line per check, then a summary line; exit 1 on any failure. The three moments are shot into
// PROOF_OUT (a temp directory by default, so docs/ is never written).
//
// Fixture data only: temp directories, never the live wallet. Run:
//   node scripts/firstrun-lock-proof.ts
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
const SHOTS = process.env.PROOF_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-firstrun-lock-shots-'));
const PASSWORD = 'proof-password-1';

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-firstrun-lock-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-firstrun-lock-home-'));
let app: ChildProcess | null = null;
let base = '';
let token = '';
const log: string[] = [];

async function startApp(port: number): Promise<void> {
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ACC_MODE: 'demo', ACC_PORT: String(port), ACC_DATA_DIR: dataDir, CFFIXED_USER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  app.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const m = /minted one: ([0-9a-f]{16,})/.exec(log.join(''));
    if (m && token === '') token = m[1] as string;
    if (token !== '') {
      try {
        const res = await fetch(`${base}/api/state`, { headers: { 'x-phosphor-token': token } });
        if (res.ok) return;
      } catch {
        // not listening yet
      }
    }
    if (app.exitCode !== null) break;
    await sleep(150);
  }
  throw new Error(`the demo backend did not come up:\n${log.join('')}`);
}

/* A backend writes its audit tip as it shuts down, so its data dir goes once it has exited. */
async function stopApp(): Promise<void> {
  const child = app;
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
  for (const dir of [dataDir, home]) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- the page ----------

/* What is in front at the lock field and in the middle of the window, and whether any word is
   still drawn. */
const FRONT = `(function () {
  var field = document.querySelector('#screen-lock:not([hidden]) input[type="password"]');
  var at = null;
  if (field) {
    var r = field.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    at = hit === field ? 'the lock field' : (hit ? (hit.closest('#screen-firstrun') ? 'the first run' : hit.tagName) : null);
  }
  var middle = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  var words = Array.prototype.slice.call(document.querySelectorAll('#screen-firstrun .word-text'));
  return {
    lockUp: !!field,
    atField: at,
    middle: middle ? (middle.closest('#screen-lock') ? 'the lock card' : middle.closest('#screen-firstrun') ? 'the first run' : middle.tagName) : null,
    wordsDrawn: words.filter(function (n) { return getComputedStyle(n).visibility === 'visible' && n.getClientRects().length > 0; }).length,
    keyboard: document.activeElement === field ? 'the lock field' : (document.activeElement && document.activeElement.closest && document.activeElement.closest('#screen-firstrun') ? 'the first run' : 'elsewhere'),
    title: (document.querySelector('#screen-firstrun .screen-body h1') || {}).textContent || null
  };
})()`;

/* Frames the field behind the first run has drawn so far, from its handle on the motion loop. */
const FIELD_FRAMES = `(function () {
  var handle = window.PhosphorMotion.handles().filter(function (h) { return h.node && h.node.id === 'field'; })[0];
  return handle ? handle.stats().frames : -1;
})()`;

/* The page's visibility set the way WebKit sets it when the window is minimized or hidden. */
const setHidden = (hidden: boolean): string => `(function () {
  Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return ${hidden}; } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return ${hidden ? "'hidden'" : "'visible'"}; } });
  document.dispatchEvent(new Event('visibilitychange'));
})()`;

const failures: string[] = [];
function check(ok: boolean, line: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
  if (!ok) failures.push(line);
}

async function main(): Promise<void> {
  await startApp(await freePort());
  const require = createRequire(import.meta.url);
  // Untyped on purpose: playwright-core is not a dependency of this repo.
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    const page: Json = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, bypassCSP: true });
    page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
    const primary = '#screen-firstrun .screen-body .screen-actions .btn-lg:last-child';
    const title = async (): Promise<string> => String(await page.evaluate('(document.querySelector("#screen-firstrun .screen-body h1") || {}).textContent'));
    const onStep = async (words: string): Promise<void> => {
      await page.waitForFunction(`(document.querySelector("#screen-firstrun .screen-body h1") || {}).textContent === ${JSON.stringify(words)}`, undefined, { timeout: 15_000 });
      await sleep(450);
    };

    await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
    await page.waitForSelector('#screen-firstrun .firstrun-welcome', { timeout: 20_000 });
    await page.evaluate('document.fonts.ready');
    await sleep(1500);
    await page.click('#screen-firstrun .firstrun-welcome .btn-primary');
    await sleep(500);
    if ((await title()) === 'Before you start') await page.click(primary);
    await onStep('Have an invite code?');
    await page.click('#screen-firstrun .screen-body .screen-actions .btn-quiet');
    await onStep('Create or bring a wallet');
    await page.click(primary);
    await onStep('Set a password');
    await page.fill('#screen-firstrun .screen-body .field:nth-of-type(1) input', PASSWORD);
    await page.fill('#screen-firstrun .screen-body .field:nth-of-type(2) input', PASSWORD);
    await page.click(primary);
    await onStep('Save your recovery words');
    const words = (await page.evaluate('Array.from(document.querySelectorAll("#screen-firstrun .word-text")).map(function (n) { return n.textContent; })')) as string[];
    await page.screenshot({ path: path.join(SHOTS, 'firstrun-lock-1-words.png') });
    /* The field's frames over two seconds, as frames a second. */
    const fieldRate = async (): Promise<number> => {
      const from = Number(await page.evaluate(FIELD_FRAMES));
      await sleep(2_000);
      return (Number(await page.evaluate(FIELD_FRAMES)) - from) / 2;
    };
    const open = await fieldRate();
    check(open >= 20, `the field draws on the first run (${open} frames a second)`);
    await page.evaluate(setHidden(true));
    const hidden = await fieldRate();
    check(hidden === 0, `the field draws nothing while the window is hidden (${hidden} frames a second)`);
    await page.evaluate(setHidden(false));
    const shown = await fieldRate();
    check(shown >= 20, `the field draws again when the window shows (${shown} frames a second)`);

    // The screen locks, as the shell reports it.
    const locked = await fetch(`${base}/api/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ token, whenIdle: true, reason: 'the screen locked' }),
    });
    check(locked.ok, `the screen lock was taken (${locked.status})`);
    await page.waitForSelector('#screen-lock:not([hidden]) input[type="password"]', { timeout: 10_000 });
    await sleep(900);
    const front = (await page.evaluate(FRONT)) as Json;
    await page.screenshot({ path: path.join(SHOTS, 'firstrun-lock-2-locked.png') });
    check(front.atField === 'the lock field', `the lock field is in front of the first run (found: ${front.atField})`);
    check(front.middle === 'the lock card', `the middle of the window is the lock card (found: ${front.middle})`);
    check(front.wordsDrawn === 0, `no recovery word is drawn while locked (drawn: ${front.wordsDrawn})`);
    check(front.keyboard === 'the lock field', `the keyboard is in the lock field (found: ${front.keyboard})`);
    const why = String(await page.evaluate('(document.querySelector("#screen-lock .lock-why") || {}).textContent || ""'));
    check(why.includes('Locked when your screen locked.'), `the card says why: "${why}"`);
    const covered = await fieldRate();
    check(covered === 0, `the field draws nothing behind the lock card (${covered} frames a second)`);

    // Unlock through the card, as a person types it.
    await page.fill('#screen-lock input[type="password"]', PASSWORD);
    await page.press('#screen-lock input[type="password"]', 'Enter');
    await page.waitForSelector('#screen-lock', { state: 'hidden', timeout: 15_000 });
    await sleep(900);
    const back = (await page.evaluate(FRONT)) as Json;
    const again = (await page.evaluate('Array.from(document.querySelectorAll("#screen-firstrun .word-text")).map(function (n) { return n.textContent; })')) as string[];
    await page.screenshot({ path: path.join(SHOTS, 'firstrun-lock-3-unlocked.png') });
    check(back.title === 'Save your recovery words' && back.middle === 'the first run', `unlocking is back on the same step, in front (on "${back.title}", middle: ${back.middle})`);
    check(back.wordsDrawn === 12 && JSON.stringify(again) === JSON.stringify(words), `the same twelve words are back (${back.wordsDrawn} drawn)`);
    const unlocked = await fieldRate();
    check(unlocked >= 20, `the field draws again after the unlock (${unlocked} frames a second)`);

    // Written down: Prove it, and the addresses step.
    await page.click('#screen-firstrun .screen-body input[type="checkbox"]');
    await page.click(primary);
    await onStep('Prove it');
    await page.evaluate(`(function (w) {
      var fields = document.querySelectorAll('#screen-firstrun .screen-body input.input');
      for (var i = 0; i < fields.length; i += 1) fields[i].value = w[Number(fields[i].dataset.index)];
    })(${JSON.stringify(words)})`);
    await page.click(primary);
    await page.waitForFunction('(document.querySelector("#screen-firstrun .screen-body h1") || {}).textContent !== "Prove it" || !!document.querySelector("#screen-firstrun .firstrun-error:not([hidden])")', undefined, { timeout: 15_000 });
    await sleep(450);
    const stuck = String(await page.evaluate('(document.querySelector("#screen-firstrun .firstrun-error:not([hidden])") || {}).textContent || ""'));
    check((await title()) === 'Your addresses', `Prove it goes through to Your addresses (on "${await title()}"${stuck ? `, saying "${stuck}"` : ''})`);
    const vault = (await (await fetch(`${base}/api/vault`, { headers: { 'x-phosphor-token': token } })).json()) as Json;
    check(vault.backedUp === true, `the app has the wallet as backed up (${vault.backedUp})`);
    await page.close();
  } finally {
    await browser.close();
    await stopApp();
  }
  const errors = log.filter((line) => line.startsWith('[page]'));
  check(errors.length === 0, `no page error (${errors.length})`);
  console.log(`${failures.length === 0 ? 'FIRSTRUN LOCK PASS' : 'FIRSTRUN LOCK FAIL'}: ${failures.length} of the checks failed; pictures in ${SHOTS}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await stopApp().catch(() => {});
  process.exit(1);
});
