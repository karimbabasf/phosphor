// The window, proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with a throwaway data directory, plays the shell
// far enough to get past the first-run card, seeds the chart and the rail with fixture objects
// through the agent door (a level, a line, a zone, an idea plan, a highlight), then drives
// headless Chromium through playwright-core: the trade screen at 1280 x 800 and, with a two
// chart layout up, at 1440 x 900, into docs/screenshots/. Then it measures, ten samples each:
//
//   trade SSE frame -> rail DOM update   (a MutationObserver on the rail, timed from the frame)
//   chart_draw POST -> next repaint      (performance.now around the fetch, resolved on the
//                                         animation frame after the chart applies the new rev)
//
// Fixture data only: the demo wallet on a temp directory, never the live one. Run:
//   node scripts/window-proof.ts
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
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const SAMPLES = 10;

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

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[at] as number;
}

// ---------- the backend ----------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-proof-'));
let app: ChildProcess | null = null;
let base = '';
let token = '';
const log: string[] = [];

async function startApp(port: number): Promise<void> {
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ACC_MODE: 'demo', ACC_PORT: String(port), ACC_DATA_DIR: dataDir },
    // stdin from /dev/null, exactly as the unit tests boot it: no shell above it, so it mints a
    // window token and says so on stderr once.
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

async function getJson(route: string): Promise<Json> {
  const res = await fetch(`${base}${route}`);
  return await res.json();
}

async function agent(op: string, tool: string, args: Record<string, unknown>): Promise<Json> {
  const out = await post('/api/mcp', { op, tool, args, session: 'window-proof', client: 'window-proof' });
  if (out.status !== 200) throw new Error(`${tool} refused: ${out.status} ${JSON.stringify(out.json)}`);
  return out.json;
}

// ---------- fixtures ----------

async function createWallet(): Promise<void> {
  const created = await post('/api/wallet/create', { token, password: 'proof-password-1' });
  if (created.status !== 200) throw new Error(`wallet create refused: ${created.status} ${JSON.stringify(created.json)}`);
}

type Candle = { t: number; o: number; h: number; l: number; c: number };

// The primary chart once it holds candles at the timeframe asked for, so the fixtures sit
// inside the visible range rather than off the top of the pane.
async function chartAt(timeframe: string): Promise<{ product: string; candles: Candle[]; granularitySec: number }> {
  await agent('view', 'chart_draw', { view: { timeframe } });
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    const chart = await getJson('/api/chart');
    const candles = Array.isArray(chart.candles) ? (chart.candles as Candle[]) : [];
    const sec = Number(chart.view?.granularitySec);
    const want = timeframe.endsWith('h') ? Number(timeframe.slice(0, -1)) * 3600 : Number(timeframe.slice(0, -1)) * 60;
    if (sec === want && candles.length > 40) return { product: String(chart.view.product), candles, granularitySec: sec };
    await sleep(500);
  }
  throw new Error(`no candles arrived for the primary chart at ${timeframe}`);
}

// A level, a line and a zone inside the last 80 bars, replacing whatever the agent drew before.
async function drawObjects(chart: { candles: Candle[] }): Promise<void> {
  const recent = chart.candles.slice(-80);
  const lo = Math.min(...recent.map((c) => c.l));
  const hi = Math.max(...recent.map((c) => c.h));
  const at = (f: number): number => Number((lo + (hi - lo) * f).toPrecision(6));
  await agent('view', 'chart_draw', {
    clear: 'agent',
    levels: [{ px: at(0.2), label: 'support' }, { px: at(0.85), label: 'supply' }],
    lines: [{ t1: (recent[4] as Candle).t, p1: at(0.1), t2: (recent[64] as Candle).t, p2: at(0.6), label: 'trend' }],
    zones: [{ p1: at(0.55), p2: at(0.62), label: 'demand' }],
  });
}

// One idea plan on the chart's coin, placed inside the visible range so its band is on the
// pane (the entry under the price, the stop under that, the target above), and a highlight
// pointing at it with a note.
async function drawPlan(coin: string, chart: { candles: Candle[] }): Promise<void> {
  const recent = chart.candles.slice(-80);
  const lo = Math.min(...recent.map((c) => c.l));
  const hi = Math.max(...recent.map((c) => c.h));
  const px = (recent[recent.length - 1] as Candle).c;
  const at = (f: number): number => Number((lo + (hi - lo) * f).toPrecision(6));
  const entry = Math.min(at(0.35), Number((px * 0.999).toPrecision(6)));
  const plan = await agent('view', 'trade_plan', {
    plan: {
      symbol: coin,
      side: 'long',
      sizeUsd: 200,
      leverage: 3,
      entry: { type: 'limit', px: entry },
      stop: Math.min(at(0.12), Number((entry * 0.998).toPrecision(6))),
      target: Math.max(at(0.92), Number((px * 1.002).toPrecision(6))),
      when: [{ type: 'close', tf: '15m', is: 'above', at: { px: Number((px * 1.001).toPrecision(6)) } }],
      note: 'Fixture plan for the window proof',
    },
  });
  const planId = String(plan.plan?.id ?? '');
  if (planId !== '') {
    await agent('view', 'trade_highlight', { kind: 'plan', id: planId, note: 'This one waits on the 15m close above the level.' });
  }
}

// ---------- the browser ----------

async function main(): Promise<void> {
  const port = await freePort();
  await startApp(port);
  await createWallet();
  const first = await chartAt('15m');
  const product = first.product;
  const coin = product.split('-')[0] as string;
  await drawObjects(first);
  await drawPlan(coin, first);

  const require = createRequire(import.meta.url);
  // Untyped on purpose: playwright-core is not a dependency of this repo, so its types are not
  // in the tree. The page-side probes live in window-proof.page.js as a plain script.
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  const results: Record<string, unknown> = {};
  try {
    // bypassCSP: the page's CSP is script-src 'self', which is right for the app and blocks the
    // probes this proof evaluates into it. The bypass is the harness's, never the app's.
    const page: Json = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, bypassCSP: true });
    page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
    page.on('console', (msg: Json) => {
      if (msg.type() === 'error' || msg.type() === 'warning') log.push(`[console.${msg.type()}] ${msg.text()}\n`);
    });
    await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
    await page.waitForSelector('#view-trade', { state: 'attached' });
    await page.waitForSelector('.tab[data-tab="trade"]');
    await page.click('.tab[data-tab="trade"]');
    await page.waitForFunction('window.CHART && Array.isArray(window.CHART.candles) && window.CHART.candles.length > 0', undefined, { timeout: 45_000 });
    // The rail: wait until the idea plan is listed, so the picture holds the fixture.
    await page.waitForSelector('.trade-waiting .trade-row', { timeout: 20_000 });
    // Fonts, one more paint, then the picture.
    await page.evaluate('document.fonts.ready');
    await sleep(600);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'trade.png') });

    // PROOF_EXTRA_DIR: a working folder for pictures of the states the two deliverables do not
    // hold (the Layers popover open), for whoever is checking the craft rather than the layout.
    const extra = process.env.PROOF_EXTRA_DIR;
    if (extra) {
      fs.mkdirSync(extra, { recursive: true });
      await page.click('.layers');
      await sleep(400);
      await page.screenshot({ path: path.join(extra, 'layers.png') });
      await page.keyboard.press('Escape');
      await sleep(300);
    }

    // ---------- latency ----------
    await page.evaluate(fs.readFileSync(path.join(ROOT, 'scripts', 'window-proof.page.js'), 'utf8'));

    const railSamples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const pending: Promise<number> = page.evaluate('window.__railSample()');
      await sleep(30);
      const out = await post('/api/trade', { token, overlay: { name: 'fills', on: i % 2 === 0 } });
      if (out.status !== 200) throw new Error(`overlay write refused: ${out.status} ${JSON.stringify(out.json)}`);
      railSamples.push(await pending);
      await sleep(120);
    }

    const drawSamples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      drawSamples.push((await page.evaluate(`window.__drawSample(${i})`)) as number);
      await sleep(120);
    }

    // ---------- the wide picture, with a second chart up ----------
    // The probe levels were fixtures for the clock, not for the picture: drawObjects clears them.
    const other = product.startsWith('BTC') ? 'ETH-USD' : 'BTC-USD';
    await agent('view', 'chart_layout', { charts: [{ product, timeframe: '1h' }, { product: other, timeframe: '4h' }] });
    await drawObjects(await chartAt('1h'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.mini[data-slot="1"] canvas', { timeout: 20_000 });
    await page.waitForFunction('(function () { var c = document.querySelector(".mini[data-slot=\\"1\\"] canvas"); return !!(c && c.width > 0); })()', undefined, { timeout: 20_000 });
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS, 'trade-wide.png') });

    results.railMs = { p50: percentile(railSamples, 50), p95: percentile(railSamples, 95), samples: railSamples.map((n) => Number(n.toFixed(2))) };
    results.drawMs = { p50: percentile(drawSamples, 50), p95: percentile(drawSamples, 95), samples: drawSamples.map((n) => Number(n.toFixed(2))) };
    results.screenshots = [path.join(SHOTS, 'trade.png'), path.join(SHOTS, 'trade-wide.png')];
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
