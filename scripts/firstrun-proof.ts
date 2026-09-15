// The first run, proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with an EMPTY data directory, so the window opens
// on the first-run card by itself, then drives headless Chromium through playwright-core: the
// welcome and the create-wallet step at 1280 x 800 (two device pixels per CSS pixel, a laptop)
// and at 2560 x 1440 (one, a large external display), into docs/screenshots/firstrun/. The
// create step is also shot with the developer switch on, at the small size, because that is
// the tallest the card gets and the one that must not scroll. Alongside the pictures it prints
// what a picture cannot show: the card's box at each size, how far the screen would scroll,
// whether the page behind is painted, and the field's cost per frame.
//
// In demo mode the Secure Enclave reports not ready, so the software flow is what shows: the
// welcome, Create or bring a wallet, then Set a password, which is the create step there.
//
// Fixture data only: a temp directory, never the live wallet. Run:
//   node scripts/firstrun-proof.ts
// playwright-core is not a dependency of this repo; point PLAYWRIGHT_CORE at a copy. Without
// playwright's own Chromium installed, point PROOF_BROWSER at a Chromium binary (Brave's, say).

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
const SHOTS = path.join(ROOT, 'docs', 'screenshots', 'firstrun');

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-firstrun-proof-'));
let app: ChildProcess | null = null;
let base = '';
let token = '';
const log: string[] = [];

async function startApp(port: number): Promise<void> {
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ACC_MODE: 'demo', ACC_PORT: String(port), ACC_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  app.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const text = log.join('');
    const m = /minted one: ([0-9a-f]{16,})/.exec(text);
    if (m && token === '') token = m[1] as string;
    if (token !== '') {
      try {
        const res = await fetch(`${base}/api/state`);
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

// ---------- the browser ----------

// What the picture cannot show, read out of the page.
const MEASURE = `(function () {
  var screen = document.getElementById('screen-firstrun');
  var card = screen && screen.querySelector('.screen-card');
  var page = document.getElementById('page');
  var box = card ? card.getBoundingClientRect() : null;
  var motion = window.PhosphorMotion;
  var handles = motion && motion.handles ? motion.handles() : [];
  var stats = handles.length ? handles[0].stats() : null;
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    card: box ? { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height), bottom: Math.round(box.bottom) } : null,
    overflow: screen ? screen.scrollHeight - screen.clientHeight : null,
    pageVisibility: page ? getComputedStyle(page).visibility : null,
    pageHidden: document.body.getAttribute('data-firstrun'),
    loops: handles.length,
    fieldFrames: stats ? stats.frames : 0,
    fieldMeanMs: stats ? Number(stats.meanMs.toFixed(2)) : null,
    fieldWorstMs: stats ? Number(stats.worstMs.toFixed(2)) : null,
    step: screen ? (screen.querySelector('.screen-progress .sr-only') || {}).textContent || 'welcome' : null,
    title: screen ? (screen.querySelector('h1') || {}).textContent : null
  };
})()`;

async function main(): Promise<void> {
  const port = await freePort();
  await startApp(port);

  const require = createRequire(import.meta.url);
  // Untyped on purpose: playwright-core is not a dependency of this repo, so its types are not
  // in the tree.
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  const results: Record<string, unknown> = {};
  const shots: string[] = [];
  fs.mkdirSync(SHOTS, { recursive: true });

  async function open(width: number, height: number, dpr: number): Promise<Json> {
    const page: Json = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr, bypassCSP: true });
    page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
    page.on('console', (msg: Json) => {
      if (msg.type() === 'error' || msg.type() === 'warning') log.push(`[console.${msg.type()}] ${msg.text()}\n`);
    });
    await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
    await page.waitForSelector('#screen-firstrun .firstrun-welcome', { timeout: 20_000 });
    await page.evaluate('document.fonts.ready');
    // The field fades up over 600 ms and the welcome lands inside 1.2 s: wait for both.
    await sleep(1800);
    return page;
  }

  async function shoot(page: Json, name: string): Promise<void> {
    const file = path.join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }

  // Get started, then (software flow) Continue past Create or bring a wallet, to the step
  // where the wallet is made.
  async function toCreate(page: Json): Promise<void> {
    await page.click('#screen-firstrun .firstrun-welcome .btn-primary');
    await page.waitForSelector('#screen-firstrun .screen-progress', { timeout: 5_000 });
    await sleep(500);
    const title = await page.evaluate('(document.querySelector("#screen-firstrun .screen-body h1") || {}).textContent');
    if (title === 'Create or bring a wallet') {
      await page.click('#screen-firstrun .screen-body .btn-primary');
      await sleep(500);
    }
    await page.waitForSelector('#screen-firstrun .firstrun-where', { timeout: 5_000 });
    await sleep(400);
  }

  try {
    for (const size of [{ w: 1280, h: 800, dpr: 2 }, { w: 2560, h: 1440, dpr: 1 }]) {
      const tag = `${size.w}x${size.h}`;
      const page = await open(size.w, size.h, size.dpr);
      await shoot(page, `welcome-${tag}`);
      results[`welcome-${tag}`] = await page.evaluate(MEASURE);

      await toCreate(page);
      await shoot(page, `create-${tag}`);
      results[`create-${tag}`] = await page.evaluate(MEASURE);

      if (size.w === 1280) {
        await page.evaluate('window.PhosphorDev.set(true)');
        await sleep(400);
        await shoot(page, `create-developer-${tag}`);
        results[`create-developer-${tag}`] = await page.evaluate(MEASURE);
        await page.evaluate('window.PhosphorDev.set(false)');
      }
      await page.close();
    }
    results.screenshots = shots;
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
  const noise = log.filter((l) => l.startsWith('[page]') || l.startsWith('[console'));
  if (noise.length) console.log(`browser noise:\n${noise.join('')}`);
}

function stop(): void {
  if (app !== null && app.exitCode === null) {
    try {
      app.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // a temp dir that would not go is not a failure of the proof
  }
}

process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(1);
});

main()
  .then(() => {
    stop();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    console.error(log.slice(-40).join(''));
    stop();
    process.exit(1);
  });
