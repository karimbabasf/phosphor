// The checks fold, photographed on a real receipt.
//
// Boots the app in demo mode on a free port with a throwaway data directory (never the live
// one, never a real key) seeded with one executed HyperCore deposit that carries two preflights:
// the 2026-09-15 surge (held) and the attempt that cleared. Creates a demo wallet, opens the
// window in the automation browser over CDP, opens the row's receipt from Activity, unfolds
// the checks and photographs the card at 1280 px into PROOF_OUT_DIR. Same shape as
// activity-proof.ts. Run:
//   node scripts/checks-proof.ts
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
// A working picture, not a deliverable: it goes to the temp dir, never into the repo.
const SHOTS = process.env.PROOF_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-checks-shot-'));

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-checks-'));
let app: ChildProcess | null = null;

const SELF = '0x1111111111111111111111111111111111111111';
const QUIET = [145392, 145390, 145401, 145388, 145395, 145402, 145399, 145391, 145397, 145405, 145388, 145393, 145400, 145396, 145389];
const SURGE = [...QUIET, 148210, 152840, 171455, 204120, 258990, 300024];
const SETTLED = [...SURGE, 281300, 240115, 198420, 171002, 152310, 146880, 145412];

function checks(kind: 'surge' | 'settled') {
  const surge = kind === 'surge';
  return [
    {
      id: 'gas',
      label: 'Arbitrum gas',
      state: surge ? 'fail' : 'ok',
      value: surge ? '300,024 / 300,000' : '145,412 / 300,000',
      detail: surge
        ? "1Click's relayer sweeps the payout with a 300,000 gas limit. Right now the sweep needs about 300,024, 155,024 of it L1 data, 2.1x the hourly average."
        : "1Click's relayer sweeps the payout with a 300,000 gas limit. Right now the sweep needs about 145,412, 412 of it L1 data, 0.8x the hourly average.",
      series: surge ? SURGE : SETTLED,
      limit: 300000,
    },
    { id: 'coverage', label: 'Fee covers the payout', state: 'ok', value: surge ? '13.4x' : '29.3x', detail: surge ? '$0.34 fee against about $0.03 of gas on Arbitrum (300,024 units at today\'s price).' : '$0.34 fee against about $0.01 of gas on Arbitrum (145,412 units at today\'s price).' },
    { id: 'venue', label: 'Venue answering', state: 'ok', value: surge ? '212 ms' : '187 ms', detail: surge ? 'A dry quote answered in 212 ms and the status endpoint is reachable.' : 'A dry quote answered in 187 ms and the status endpoint is reachable.' },
    { id: 'balance', label: 'Balance', state: 'ok', value: '50 USDC', detail: 'USDC inside NEAR Intents reads 50 USDC, and this move needs 10 USDC.' },
    { id: 'deadline', label: 'Quote still valid', state: surge ? 'warn' : 'ok', value: surge ? '4 min' : '10 min', detail: surge ? 'The quote is good until 2026-09-15T19:19:40.000Z; the intent is signed and submitted within seconds of this check.' : 'The quote is good until 2026-09-15T19:27:10.000Z; the intent is signed and submitted within seconds of this check.' },
  ];
}

function seed(dir: string): void {
  const { createStore } = require(path.join(ROOT, 'src', 'store.ts')) as { createStore: (d: string) => { put: (p: unknown) => void } };
  const store = createStore(dir);
  const decided = new Date(Date.now() - 2 * 3_600_000);
  const settled = new Date(decided.getTime() + 6 * 60_000);
  store.put({
    id: 'proof-deposit',
    kind: 'hl_deposit',
    createdAt: decided.toISOString(),
    decidedAt: decided.toISOString(),
    decidedBy: 'human',
    status: 'executed',
    settledAt: settled.toISOString(),
    draft: {
      kind: 'hl_deposit', symbol: 'USDC', originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
      amount: 10, amountUsd: 10, minCredited: 9.5, from: SELF, hlAccount: SELF, counterparty: 'intents.near',
    },
    simulation: { ok: true, summary: 'hypercore deposit: 10 USDC held inside intents.near -> 9.6594 USDC credited to the perps account' },
    verdict: { outcome: 'needs_approval', reasons: ['above the click threshold'] },
    result: {
      ok: true,
      detail: 'funded Hyperliquid with 9.6594 USDC from 10 USDC held inside intents.near (1click reported SUCCESS); intent HASH-proof, quote handle a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058. fee $0.34',
      txids: ['0x' + 'c3'.repeat(32)],
      evidence: { handle: 'a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058', settledAmountOut: '9.6594' },
    },
    balances: { beforeUsd: 50, afterUsd: 40 },
    preflight: [
      { at: decided.toISOString(), verdict: 'hold', holdReason: 'Waiting for Arbitrum gas to settle', checks: checks('surge') },
      { at: settled.toISOString(), verdict: 'ok', checks: checks('settled') },
    ],
  });
}

let base = '';
let token = '';
const log: string[] = [];

async function startApp(port: number): Promise<void> {
  base = `http://127.0.0.1:${port}`;
  seed(dataDir);
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
  // The receipt as the window will read it, before the browser is involved.
  const receipts = (await (await fetch(`${base}/api/receipts`)).json()) as { receipts?: Array<{ id: string; kind: string; preflight: unknown }>; total?: number };
  const mine = receipts.receipts?.find((r) => r.id === 'proof-deposit');
  if (mine === undefined) throw new Error(`the seeded deposit is not a receipt: ${JSON.stringify(receipts).slice(0, 400)}`);
  console.log(`receipt ${mine.id} (${mine.kind}) carries ${mine.preflight === null ? 'no' : 'the'} preflight`);

  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const context: Json = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page: Json = await context.newPage();
    page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
    page.on('console', (msg: Json) => {
      if (msg.type() === 'error') log.push(`[console.error] ${msg.text()}\n`);
    });
    await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
    await page.waitForSelector('.tab[data-tab="pro"]');
    await page.click('.tab[data-tab="pro"]');
    await page.waitForSelector('.receipt-row', { timeout: 20_000 });
    await page.click('.receipt-row');
    await page.waitForSelector('.receipt-dialog .receipt-card .checks-toggle', { timeout: 10_000 });
    await page.click('.receipt-dialog .receipt-card .checks-toggle');
    await page.evaluate('document.fonts.ready');
    await sleep(600);
    fs.mkdirSync(SHOTS, { recursive: true });
    const card = page.locator('.receipt-dialog .receipt-card').first();
    await card.screenshot({ path: path.join(SHOTS, 'checks-receipt.png') });
    await page.screenshot({ path: path.join(SHOTS, 'checks-window.png') });
    const facts = await page.evaluate(`(() => {
      const fold = document.querySelector('.receipt-dialog .checks');
      const nodes = [...fold.querySelectorAll('.checks-node')].map((n) => ({
        id: n.dataset.id, state: n.dataset.state,
        label: n.querySelector('.checks-label').textContent, value: n.querySelector('.checks-value').textContent,
        spark: n.querySelector('.checks-spark') ? n.querySelector('.checks-spark').getBoundingClientRect().width : 0,
      }));
      const box = document.querySelector('.receipt-dialog .receipt-card').getBoundingClientRect();
      return { open: fold.dataset.open, summary: fold.querySelector('.checks-summary').textContent, nodes, card: { w: Math.round(box.width), h: Math.round(box.height) } };
    })()`);
    console.log(JSON.stringify(facts, null, 1));
    await context.close();
  } finally {
    await browser.close();
  }
  const errors = log.filter((l) => l.startsWith('[page]') || l.startsWith('[console.error]'));
  console.log(`checks: ${path.join(SHOTS, 'checks-receipt.png')}, ${errors.length} page error(s)${errors.length ? '\n' + errors.join('') : ''}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    app?.kill('SIGTERM');
    // The child may still be flushing its last write; a few retries cover it.
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
