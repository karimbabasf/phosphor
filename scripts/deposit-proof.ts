// Money in, proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with a throwaway data directory and a fixture
// standing in for the bridge (PHOSPHOR_DEMO_RECEIVE, see src/http/wallet.ts), creates the demo
// wallet through the same route the first-run card posts to, then drives headless Chromium
// through playwright-core: Basic's Money in fold at each of its three steps (the network tiles
// with one under the pointer, the token list with the acknowledgement ticked, the address),
// the Vault tab, the Vault tab with the developer switch on, and the deposit card the Vault
// tab opens, at 1280 x 800 and 2560 x 1440, into docs/screenshots/deposit/.
//
// Fixture data only: the demo wallet on a temp directory, never the live one. Run:
//   node scripts/deposit-proof.ts
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
const SHOTS = path.join(ROOT, 'docs', 'screenshots', 'deposit');

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

// ---------- the bridge, as a fixture ----------

// What the bridge answers today for the five networks, in its own row shape, so the report
// the window reads is built by the same parser the live one goes through.
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
      sol: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      near: '7f2a9c4e1b8d3f6a0c5e2b9d4f7a1c8e3b6d9f2a5c8e1b4d7f0a3c6e9b2d5f8a',
    },
    tokens: [
      row('eth:1', 'ETH', 18, '100000000000', 'nep141:eth.omft.near'),
      row('eth:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', 6, '1000', 'nep141:eth-0xa0b8.omft.near'),
      row('eth:1:0xdac17f958d2ee523a2206206994597c13d831ec7', 'USDT', 6, '1000', 'nep141:eth-0xdac1.omft.near'),
      row('eth:1:0x6b175474e89094c44da98b954eedeac495271d0f', 'DAI', 18, '1000000000000000', 'nep141:eth-0x6b17.omft.near'),
      row('eth:1:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 'WBTC', 8, '10000', 'nep141:eth-0x2260.omft.near'),
      row('eth:1:0x514910771af9ca656af840dff83e8264ecf986ca', 'LINK', 18, '100000000000000000', 'nep141:eth-0x5149.omft.near'),
      row('eth:1:0x6c3ea9036406852006290770bedfcaba0e23a0e8', 'PYUSD', 6, '1000', 'nep141:eth-0x6c3e.omft.near'),
      row('eth:8453', 'ETH', 18, '100000000000', 'nep141:base.omft.near'),
      row('eth:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6, '1000', 'nep141:base-0x8335.omft.near'),
      row('eth:8453:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 'cbBTC', 8, '10000', 'nep141:base-0xcbb7.omft.near'),
      row('eth:42161', 'ETH', 18, '100000000000', 'nep141:arb.omft.near'),
      row('eth:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC', 6, '1000', 'nep141:arb-0xaf88.omft.near'),
      row('eth:42161:0x912ce59144191c1204e64559fe8253a0e49e6548', 'ARB', 18, '1000000000000000000', 'nep141:arb-0x912c.omft.near'),
      row('sol:mainnet', 'SOL', 9, '10000000', 'nep141:sol.omft.near'),
      row('sol:mainnet:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 6, '1000', 'nep141:sol-EPjF.omft.near'),
      row('near:mainnet', 'NEAR', 24, '100000000000000000000000', 'nep141:wrap.near'),
      row('near:mainnet:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'USDC', 6, '1000', 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'),
      row('near:mainnet:usdt.tether-token.near', 'USDT', 6, '1000', 'nep141:usdt.tether-token.near'),
    ],
  };
}

// ---------- the backend ----------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-deposit-proof-'));
let app: ChildProcess | null = null;
let base = '';
let token = '';
const log: string[] = [];

async function startApp(port: number): Promise<void> {
  base = `http://127.0.0.1:${port}`;
  const fixture = path.join(dataDir, 'receive.json');
  fs.writeFileSync(fixture, JSON.stringify(bridgeFixture()));
  app = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ACC_MODE: 'demo', ACC_PORT: String(port), ACC_DATA_DIR: dataDir, PHOSPHOR_DEMO_RECEIVE: fixture },
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

// The demo wallet, made the way the first-run card makes it, so the window opens on Basic
// with the wallet open and every address verified.
async function createWallet(): Promise<void> {
  const created = await post('/api/wallet/create', { token, password: 'proof-password-1' });
  if (created.status !== 200) throw new Error(`wallet create refused: ${created.status} ${JSON.stringify(created.json)}`);
}

// ---------- the browser ----------

const SIZES: Array<{ tag: string; width: number; height: number }> = [
  { tag: '', width: 1280, height: 800 },
  { tag: '-wide', width: 2560, height: 1440 },
];

async function main(): Promise<void> {
  const port = await freePort();
  await startApp(port);
  await createWallet();
  const report = (await (await fetch(`${base}/api/intents-receive`)).json()) as Json;
  if (!Array.isArray(report.networks) || report.networks.length !== 5 || report.networks.some((n: Json) => n.address === null)) {
    throw new Error(`the demo fixture did not reach the report: ${JSON.stringify(report).slice(0, 400)}`);
  }

  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  const shots: string[] = [];
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    for (const size of SIZES) {
      // bypassCSP: the page's CSP is script-src 'self', which is right for the app and blocks
      // the two evaluate calls below (the developer switch, the acknowledgement reset). The
      // bypass is the harness's, never the app's.
      const page: Json = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, bypassCSP: true });
      page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
      page.on('console', (msg: Json) => {
        if (msg.type() === 'error' || msg.type() === 'warning') log.push(`[console.${msg.type()}] ${msg.text()}\n`);
      });
      const shoot = async (name: string): Promise<void> => {
        await page.evaluate('document.fonts.ready');
        await sleep(450);
        const file = path.join(SHOTS, `${name}${size.tag}.png`);
        await page.screenshot({ path: file });
        shots.push(file);
      };
      // The fold at the top of the world, so the picture holds the whole step and not the
      // holdings list above it, wherever the click before it left the scroll.
      const showFold = async (): Promise<void> => {
        await page.evaluate('document.querySelector(\'.fold[data-surface="moneyin"]\').scrollIntoView({ block: "start" })');
        await sleep(150);
      };

      await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
      await page.waitForSelector('#view-basic', { state: 'attached' });
      // A fresh install: the acknowledgement has not been given, the developer switch is off.
      await page.evaluate("localStorage.removeItem('phosphor.depositAck'); localStorage.setItem('phosphor.developer', '0')");
      await page.click('.tab[data-tab="basic"]');
      await page.waitForSelector('.fold[data-surface="moneyin"] > .fold-head', { timeout: 20_000 });
      await page.click('.fold[data-surface="moneyin"] > .fold-head');

      // Step one: the tiles, Base under the pointer.
      await page.waitForSelector('.net-tile[data-network="base"]', { timeout: 20_000 });
      await showFold();
      await page.hover('.net-tile[data-network="base"]');
      await sleep(350);
      await shoot('stage1');

      // Step two: the tokens Base credits, the box ticked.
      await page.click('.net-tile[data-network="base"]');
      await page.waitForSelector('.token-row', { timeout: 20_000 });
      await showFold();
      await sleep(400);
      await shoot('stage2');
      await page.click('.ack-row');
      await showFold();
      await sleep(250);
      await shoot('stage2-acked');

      // Step three: the address, drawn and checked.
      await page.click('.netpick-ack button');
      await page.waitForSelector('.deposit-body[data-state="shown"] canvas', { timeout: 20_000 });
      await showFold();
      await sleep(500);
      await shoot('stage3');

      // The Vault tab, then with the developer switch on, then the card it opens.
      await page.click('.tab[data-tab="vault"]');
      await page.waitForSelector('#view-vault .netsel', { timeout: 20_000 });
      await page.waitForSelector('#view-vault .token-row', { timeout: 20_000 });
      await sleep(400);
      await shoot('vault');
      await page.evaluate('window.PhosphorDev.set(true)');
      await sleep(300);
      await shoot('vault-dev');
      await page.evaluate('window.PhosphorDev.set(false)');
      await page.click('#view-vault .netsel');
      await page.waitForSelector('#view-vault .netsel-option[data-network="sol"]', { timeout: 5_000 });
      await sleep(250);
      await shoot('vault-menu');
      await page.click('#view-vault .netsel-option[data-network="sol"]');
      await page.waitForSelector('#view-vault .token-row[data-symbol="SOL"]', { timeout: 10_000 });
      await page.click('#view-vault .netpick-ack button');
      await page.waitForSelector('dialog.deposit-dialog[open] .deposit-body[data-state="shown"] canvas', { timeout: 20_000 });
      await sleep(500);
      await shoot('deposit-card');
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ screenshots: shots }, null, 2));
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
