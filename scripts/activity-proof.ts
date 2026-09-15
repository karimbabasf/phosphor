// The Activity panel, photographed with real receipts.
//
// Boots the app in demo mode on a free port with a throwaway data directory (never the live
// one, never a real key) seeded with six executed proposals, creates a demo wallet, then opens
// the window in the automation browser over CDP and photographs the Pro screen's Activity
// panel into docs/screenshots/activity.png. Same shape as window-proof.ts, smaller. Run:
//   node scripts/activity-proof.ts
// CDP_URL (default http://127.0.0.1:9333) and PLAYWRIGHT_CORE (a copy of the package; not a
// dependency of this repo) point at the browser and the driver.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

type Json = any;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-activity-'));
let app: ChildProcess | null = null;

/* Demo mode has no swap rail, so the receipts are seeded the way tests/unit/receipts.test.ts
   seeds them: executed proposals put straight into the store before the app boots. The
   history and the receipts are projections of that store, so what the panel shows here is
   built by the same code that builds it for real money. Six rows, the shapes the live panel
   holds: swaps into and out of a stable, a NEAR Intents deposit, and one that did not go
   through. The rail sentence carries the fill and the fee in the forms transactions.ts
   parses ("for X SYM", "fee $Y"). */
type Seed = { from: string; to: string; amountIn: number; amountUsd: number; got: number; fee: number; hoursAgo: number; status: 'executed' | 'failed' };
const SELF = '0x1111111111111111111111111111111111111111';
const SEEDS: Seed[] = [
  { from: 'ETH', to: 'USDC', amountIn: 0.002, amountUsd: 5, got: 4.9811, fee: 0.02, hoursAgo: 2, status: 'executed' },
  { from: 'SOL', to: 'ETH', amountIn: 0.049, amountUsd: 4.98, got: 0.002, fee: 0.02, hoursAgo: 49, status: 'executed' },
  { from: 'USDC', to: 'ETH', amountIn: 16.0699, amountUsd: 16.07, got: 0.0063, fee: 0.05, hoursAgo: 50, status: 'executed' },
  { from: 'USDC', to: 'ETH', amountIn: 5, amountUsd: 5, got: 0.002, fee: 0.02, hoursAgo: 52, status: 'executed' },
  { from: 'USDC', to: 'SOL', amountIn: 5, amountUsd: 5, got: 0.049, fee: 0.01, hoursAgo: 120, status: 'executed' },
  { from: 'SOL', to: 'USDC', amountIn: 0.0481, amountUsd: 4.92, got: 0, fee: 0.02, hoursAgo: 126, status: 'failed' },
];

function seedReceipts(dir: string): void {
  const { createStore } = require(path.join(ROOT, 'src', 'store.ts')) as { createStore: (d: string) => { put: (p: unknown) => void } };
  const store = createStore(dir);
  SEEDS.forEach((seed, i) => {
    const at = new Date(Date.now() - seed.hoursAgo * 3_600_000).toISOString();
    const detail = seed.status === 'executed'
      ? `swapped ${seed.amountIn} ${seed.from} for ${seed.got} ${seed.to} on intents.near, quote q-${i}, fee $${seed.fee.toFixed(2)}`
      : `the venue refused the intent: no solver quoted ${seed.amountIn} ${seed.from} in time`;
    store.put({
      id: `seed-${i}`,
      kind: 'swap',
      createdAt: at,
      decidedAt: at,
      decidedBy: 'policy',
      status: seed.status,
      draft: {
        kind: 'swap', venue: 'intents-native', chain: 'eth', toChain: 'eth',
        fromSymbol: seed.from, toSymbol: seed.to, amountIn: seed.amountIn, amountUsd: seed.amountUsd,
        minAmountOut: seed.got * 0.99, from: SELF, to: SELF, counterparty: 'intents.near', quote: null,
      },
      simulation: { ok: true, summary: `swap of $${seed.amountUsd.toFixed(2)} to intents.near, fee $${seed.fee.toFixed(2)}` },
      verdict: { outcome: 'allow', reasons: ['under the click threshold'] },
      result: { ok: seed.status === 'executed', detail, txids: seed.status === 'executed' ? ['0x' + (i + 1).toString(16).padStart(64, 'a')] : [] },
      balances: { beforeUsd: 25.56, afterUsd: 25.56 - seed.fee },
    });
  });
}
let base = '';
let token = '';
const log: string[] = [];

async function startApp(port: number): Promise<void> {
  base = `http://127.0.0.1:${port}`;
  seedReceipts(dataDir);
  app = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ACC_MODE: 'demo', ACC_PORT: String(port), ACC_DATA_DIR: dataDir },
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
        if ((await fetch(`${base}/api/state`)).ok) return;
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
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  const port = await freePort();
  await startApp(port);
  const created = await post('/api/wallet/create', { token, password: 'proof-password-1' });
  if (created.status !== 200) throw new Error(`wallet create refused: ${created.status} ${JSON.stringify(created.json)}`);

  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const context: Json = await browser.newContext({ viewport: { width: 1920, height: 1050 }, deviceScaleFactor: 2 });
    const page: Json = await context.newPage();
    page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
    page.on('console', (msg: Json) => {
      if (msg.type() === 'error') log.push(`[console.error] ${msg.text()}\n`);
    });
    await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
    await page.waitForSelector('.tab[data-tab="pro"]');
    await page.click('.tab[data-tab="pro"]');
    await page.waitForSelector('.activity-list .receipt-row', { timeout: 20_000 });
    await page.evaluate('document.fonts.ready');
    await sleep(600);
    fs.mkdirSync(SHOTS, { recursive: true });
    const panel = page.locator('.activity-list').first().locator('xpath=ancestor::*[contains(@class,"panel")][1]');
    await panel.screenshot({ path: path.join(SHOTS, 'activity.png') });
    const rows = await page.evaluate(`(() => [...document.querySelectorAll('.activity-list .receipt-row')].map((r) => ({
      title: r.children[1].textContent, when: r.children[2].textContent, amount: r.children[3].textContent, sub: r.children[4].textContent, h: Math.round(r.getBoundingClientRect().height)
    })))()`);
    console.log(JSON.stringify(rows, null, 1));
    await context.close();
  } finally {
    await browser.close();
  }
  const errors = log.filter((l) => l.startsWith('[page]') || l.startsWith('[console.error]'));
  console.log(`activity: docs/screenshots/activity.png, ${errors.length} page error(s)${errors.length ? '\n' + errors.join('') : ''}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    app?.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
