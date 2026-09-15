// The window at every size it has to look right at, in a real browser against a demo backend.
//
// Karim, 2026-09-15: "make sure this thing looks good on any screen, regardless of the
// resolution, cause phosphor might look broken on a larger screen". So this boots the app in
// demo mode on a free port with a throwaway data directory, gets past the first-run card the
// way scripts/window-proof.ts does, then drives headless Chromium through playwright-core and
// shoots Basic, Trade and Pro at four window sizes: the new minimum (960 x 700), a 13 inch
// laptop (1280 x 800 and 1440 x 900) and a 27 inch screen (2560 x 1440). The trade pictures
// carry the strip with a venue notice forced onto it, so the notice is in the picture even
// when the demo venue has nothing to say. Pictures land in docs/screenshots/scale/.
//
// Fixture data only: the demo wallet on a temp directory, never the live one. Run:
//   node scripts/scale-proof.ts
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
const SHOTS = path.join(ROOT, 'docs', 'screenshots', 'scale');

// The four sizes. A 27 inch screen is shot at one device pixel per CSS pixel so the file
// stays a picture rather than a download; the laptop sizes are shot at two, as the app is
// seen on a Mac.
const ALL_SIZES: Array<{ width: number; height: number; scale: number }> = [
  { width: 960, height: 700, scale: 2 },
  { width: 1280, height: 800, scale: 2 },
  { width: 1440, height: 900, scale: 2 },
  { width: 2560, height: 1440, scale: 1 },
];
const ALL_TABS = ['basic', 'trade', 'pro'];
// While iterating on one screen: PROOF_SIZES=1280x800,960x700 PROOF_TABS=trade.
const SIZES = process.env.PROOF_SIZES
  ? ALL_SIZES.filter((s) => (process.env.PROOF_SIZES as string).split(',').includes(`${s.width}x${s.height}`))
  : ALL_SIZES;
const TABS = process.env.PROOF_TABS ? ALL_TABS.filter((t) => (process.env.PROOF_TABS as string).split(',').includes(t)) : ALL_TABS;

// What the strip says when Hyperliquid refuses the account read, word for word as the window
// builds it from the feed's own error (src/trade/feed-ws.ts readSpot).
const VENUE_LINE =
  'No route to the venue: spot read failed: hyperliquid /info 422: Failed to deserialize the JSON body into the target type. The window keeps asking.';

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-scale-'));
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

async function post(route: string, body: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  let json: Json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function createWallet(): Promise<void> {
  const created = await post('/api/wallet/create', { token, password: 'proof-password-1' });
  if (created.status !== 200) throw new Error(`wallet create refused: ${created.status} ${JSON.stringify(created.json)}`);
}

// ---------- the page ----------

// The venue notice, forced onto the strip through the DOM the window builds for it. The
// window's own path needs the feed to fail, which the demo venue never does; the picture only
// needs the notice on screen.
const FORCE_LINE = `(function (text) {
  var line = document.querySelector('.trade-strip .trade-line');
  if (!line) return false;
  var span = line.querySelector('.trade-line-text');
  if (span) span.textContent = text; else line.textContent = text;
  line.setAttribute('data-tone', 'warn');
  line.classList.add('warn');
  line.hidden = false;
  return true;
})(${JSON.stringify(VENUE_LINE)})`;

// What the eye cannot check from a picture alone: any box wider than the window (a sideways
// scroll), the chart's height, and whether the composer is on screen.
const MEASURE = `(function () {
  var doc = document.documentElement;
  var wide = [];
  var all = document.querySelectorAll('body *');
  for (var i = 0; i < all.length; i += 1) {
    var el = all[i];
    if (el.hidden || el.closest('[hidden]')) continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > window.innerWidth + 1 || r.left < -1) wide.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    if (wide.length > 6) break;
  }
  var stage = document.querySelector('.chart-stage');
  // The composer is on screen only while the built-in assistant can take a message; with
  // nobody at the wheel the column shows its start buttons instead, and those count.
  var composer = Array.prototype.find.call(
    document.querySelectorAll('.composer-input, .conversation-body button'),
    function (b) { return b.offsetHeight > 0; }
  ) || null;
  var strip = document.querySelector('.trade-strip');
  var stripRow = document.querySelector('.strip-row');
  var line = document.querySelector('.trade-strip .trade-line');
  function h(el) { return el ? Math.round(el.getBoundingClientRect().height) : null; }
  function onScreen(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return r.bottom <= window.innerHeight + 1 && r.top >= 0 && r.height > 0;
  }
  var world = document.querySelector('.world');
  // Anything in the world that pokes past its right edge, which is what a sideways scroll
  // of the world is made of.
  var poking = [];
  if (world) {
    var edge = world.getBoundingClientRect().right;
    var inside = world.querySelectorAll('*');
    for (var j = 0; j < inside.length; j += 1) {
      var box = inside[j].getBoundingClientRect();
      if (box.width > 0 && box.right > edge + 0.5 && !inside[j].closest('[hidden]')) {
        poking.push(inside[j].tagName.toLowerCase() + (typeof inside[j].className === 'string' && inside[j].className ? '.' + inside[j].className.split(' ')[0] : '') + ' +' + (box.right - edge).toFixed(1));
        if (poking.length > 8) break;
      }
    }
  }
  return {
    poking: poking,
    scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth,
    scrollHeight: doc.scrollHeight, innerHeight: window.innerHeight,
    // How far the world itself scrolls, sideways and down: zero on every tab but Basic
    // and Pro, whose columns scroll by design once they are taller than the window.
    worldScrollX: world ? world.scrollWidth - world.clientWidth : null,
    worldScrollY: world ? world.scrollHeight - world.clientHeight : null,
    wide: wide,
    chartHeight: h(stage), deckHeight: h(document.querySelector('.trade-rail')),
    stripHeight: h(strip), stripRowHeight: h(stripRow), lineHeight: line && !line.hidden ? h(line) : null,
    conversationWidth: Math.round((document.querySelector('.conversation') || { getBoundingClientRect: function () { return { width: 0 }; } }).getBoundingClientRect().width),
    worldWidth: Math.round((document.querySelector('.world') || { getBoundingClientRect: function () { return { width: 0 }; } }).getBoundingClientRect().width),
    composerOnScreen: onScreen(composer),
  };
})()`;

async function main(): Promise<void> {
  const port = await freePort();
  await startApp(port);
  await createWallet();

  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  const report: Record<string, unknown> = {};
  const shots: string[] = [];
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const size of SIZES) {
      // One page per size: the split's stored sizes and the chart's backing store are both
      // read at load, and a fresh page is what a person gets when they open the app on that
      // screen.
      const context: Json = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        bypassCSP: true,
      });
      const page: Json = await context.newPage();
      page.on('pageerror', (err: unknown) => log.push(`[page ${size.width}] ${String(err)}\n`));
      page.on('console', (msg: Json) => {
        if (msg.type() === 'error') log.push(`[console ${size.width}] ${msg.text()}\n`);
      });
      await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
      await page.waitForSelector('.tab[data-tab="trade"]');
      await page.evaluate('document.fonts.ready');

      for (const tab of TABS) {
        await page.click(`.tab[data-tab="${tab}"]`);
        await page.waitForSelector(`#view-${tab}[data-active="true"]`);
        if (tab === 'trade') {
          await page.waitForSelector('.trade-strip');
          // Candles when the demo venue serves them; the strip is the picture either way.
          await page
            .waitForFunction('window.CHART && Array.isArray(window.CHART.candles) && window.CHART.candles.length > 0', undefined, { timeout: 20_000 })
            .catch(() => log.push(`[note ${size.width}] no candles for the trade picture\n`));
          await page.evaluate(FORCE_LINE);
        }
        await sleep(700);
        const file = path.join(SHOTS, `${tab}-${size.width}x${size.height}.png`);
        await page.screenshot({ path: file });
        shots.push(file);
        report[`${tab}-${size.width}x${size.height}`] = await page.evaluate(MEASURE);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ shots, report }, null, 2));
  const noise = log.filter((l) => l.startsWith('[page') || l.startsWith('[console') || l.startsWith('[note'));
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
