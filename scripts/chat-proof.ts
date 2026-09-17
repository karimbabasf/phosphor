// The conversation column, proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with a throwaway data directory, creates the demo
// wallet so the window opens past its first-run card, then drives headless Chromium through
// playwright-core and plays a fixture conversation into the panel through the same door the
// server's SSE frames come through (PhosphorEvents.emit('driver', frame)): a question, a
// balance card, a folded turn, a position card, a swap that is pending and then confirmed, a
// deposit card, and two receipts (the older folded, the newest open). Then it shoots the window
// at 1280 x 800 and 2560 x 1440 into docs/screenshots/chat/, plus the composer with a draft in
// it and the receipts folded and open.
//
// Fixture data only: the demo wallet on a temp directory, never the live one, and no model
// turn is spent. Run:
//   node scripts/chat-proof.ts
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
const SHOTS = path.join(ROOT, 'docs', 'screenshots', 'chat');
// PROOF_EXTRA_DIR: a working folder for pictures of the panel's states that are not deliverables
// (the jump pill, the quit card, the empty state after a quit, the beam in the air, the Basic
// folds). Set, it also slows the beam (?beam=slow) so a shot can catch the dot mid-flight.
const EXTRA = process.env.PROOF_EXTRA_DIR;

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chat-proof-'));
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

// ---------- the conversation ----------

const T0 = Date.UTC(2026, 8, 15, 14, 2, 0);

const BALANCES = {
  mode: 'demo',
  totalStableUsd: 25.9,
  totalUsd: 29.6,
  holdings: [
    { chain: 'base', symbol: 'USDC', amount: 25.9, usd: 25.9, native: false },
    { chain: 'sol', symbol: 'SOL', amount: 0.0182, usd: 3.7, native: true },
  ],
  screen: { view: 'basic' },
};

const BOOK = {
  symbol: 'BTC',
  account: { summary: 'ok', equityUsd: 1000, freeUsd: 700, marginUsedUsd: 300, unified: false, atRiskUsd: 120, maxLossUsd: 40 },
  positions: [
    { coin: 'BTC', side: 'long', sizeCoin: 0.01, notionalUsd: 612, entryPx: 60000, markPx: 61200, unrealisedUsd: 12, roePct: 4.0, leverage: 3, leverageType: 'isolated', liqPx: 41000 },
    { coin: 'ETH', side: 'short', sizeCoin: 0.2, notionalUsd: 480, entryPx: 2500, markPx: 2400, unrealisedUsd: 20, roePct: 8.3, leverage: 5, leverageType: 'isolated', liqPx: 2950 },
  ],
  orders: [],
  fills: { count: 1, inLastMin: 0, recent: [{ tid: 't1', coin: 'SOL', side: 'sell', px: 150.2, sizeCoin: 1, closedPnlUsd: 7.5, atMs: T0 - 3_600_000, liquidation: false }] },
  plans: [],
  markets: [],
  highlights: [],
  products: [],
};

const SWAP_INPUT = { chain: 'intents', toChain: 'intents', fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: 0.05, minAmountOut: 4.9, venue: 'intents-native' };
const SWAP_PENDING = { id: 'p_7f3a9c2b', status: 'pending', verdict: { outcome: 'needs_approval', reasons: ['above the click threshold'] }, simulation: { ok: true, summary: 'swap 0.05 SOL for about 4.98 USDC inside NEAR Intents' } };
const SWAP_DONE = {
  id: 'p_7f3a9c2b',
  kind: 'swap',
  status: 'executed',
  createdAt: new Date(T0 + 40_000).toISOString(),
  decidedAt: new Date(T0 + 65_000).toISOString(),
  draft: { kind: 'swap', venue: 'intents-native', chain: 'intents', toChain: 'intents', fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: 0.05, amountUsd: 5.02, minAmountOut: 4.9, quote: { amountOut: 4.98, feeUsd: 0.02, timeEstimateSec: 5 } },
  verdict: { outcome: 'needs_approval', reasons: [] },
  simulation: { ok: true, summary: 'swap 0.05 SOL for about 4.98 USDC inside NEAR Intents' },
  result: { ok: true, detail: 'intent settled', txids: ['EafozJ2XkQ9mRtb7n16c'] },
};

const DEPOSIT = {
  ok: true,
  shownInWindow: true,
  chain: 'base',
  network: 'Base',
  asset: 'USDC',
  minDeposit: 1,
  addressFingerprint: '0x4c1d...9Xk2',
  addressVerified: true,
  memo: null,
  watching: 'watching',
};

function receipt(id: string, at: number, amount: number, received: number): Record<string, unknown> {
  return {
    id,
    kind: 'swap',
    at: new Date(at).toISOString(),
    headline: `Changed about $${(received).toFixed(0)} of your Solana (SOL) into USDC.`,
    summary: `swapped ${amount} SOL for ${received} USDC, intent hash EafozJ2XkQ9mRtb7n16c`,
    fromChain: 'intents',
    toChain: 'intents',
    amount,
    symbol: 'SOL',
    received: { symbol: 'USDC', amount: received },
    feesUsd: 0.02,
    txids: [{ chain: 'near', hash: 'EafozJ2XkQ9mRtb7n16c', url: 'https://nearblocks.io/txns/EafozJ2XkQ9mRtb7n16c' }],
    balanceBefore: 29.6,
    balanceAfter: 29.58,
    status: 'executed',
  };
}

type Frame = { chat: string; event: Record<string, unknown> } | { bus: string; payload: unknown };

/* The fixture conversation, in the order the server would have sent it. `at` is the clock the
   transcript shows, so every row carries a real time rather than "now". */
function conversation(): Frame[] {
  const chat = 'c1';
  let at = T0;
  const step = (ms: number): number => (at += ms);
  const driver = (event: Record<string, unknown>): Frame => ({ chat, event: { ...event, at } });
  return [
    driver({ kind: 'status', state: 'ready' }),
    driver({ kind: 'said', text: 'What do I hold?' }),
    driver({ kind: 'tool', name: 'mcp__phosphor__balances', input: {} }),
    (step(1400), driver({ kind: 'tool_result', name: 'mcp__phosphor__balances', ok: true })),
    driver({ kind: 'tool_data', name: 'mcp__phosphor__balances', input: {}, data: BALANCES }),
    (step(900), driver({ kind: 'text', text: '$29.60 across two places: most of it is USDC on Base, with a little SOL beside it.' })),
    driver({ kind: 'turn_end', error: false, turns: 1 }),
    driver({ kind: 'status', state: 'ready' }),

    (step(20_000), driver({ kind: 'said', text: 'How are my positions doing?' })),
    driver({ kind: 'tool', name: 'mcp__phosphor__trade_read', input: {} }),
    (step(800), driver({ kind: 'tool_result', name: 'mcp__phosphor__trade_read', ok: true })),
    driver({ kind: 'tool_data', name: 'mcp__phosphor__trade_read', input: {}, data: BOOK }),
    (step(1200), driver({ kind: 'text', text: 'Up $32.00 on the two open positions. The BTC long is the one working: 4.0% on 3x. The ETH short is 8.3% up on 5x, with its liquidation at 2,950.' })),
    driver({ kind: 'turn_end', error: false, turns: 1 }),
    driver({ kind: 'status', state: 'ready' }),

    (step(15_000), driver({ kind: 'said', text: 'Swap 0.05 SOL to USDC' })),
    driver({ kind: 'tool', name: 'mcp__phosphor__propose_swap', input: SWAP_INPUT }),
    (step(2100), driver({ kind: 'tool_result', name: 'mcp__phosphor__propose_swap', ok: true })),
    driver({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: SWAP_INPUT, data: SWAP_PENDING }),
    (step(700), driver({ kind: 'text', text: 'Proposed: 0.05 SOL for about 4.98 USDC, fee $0.02. It is above your click line, so it waits for you in the dock.' })),
    driver({ kind: 'turn_end', error: false, turns: 1 }),
    driver({ kind: 'status', state: 'ready' }),

    (step(25_000), driver({ kind: 'said', text: 'Did it go through?' })),
    driver({ kind: 'tool', name: 'mcp__phosphor__proposal_status', input: { id: 'p_7f3a9c2b' } }),
    (step(600), driver({ kind: 'tool_result', name: 'mcp__phosphor__proposal_status', ok: true })),
    driver({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'p_7f3a9c2b' }, data: SWAP_DONE }),
    (step(500), driver({ kind: 'text', text: 'Yes. 4.98 USDC landed in NEAR Intents; the receipt is below.' })),
    driver({ kind: 'turn_end', error: false, turns: 1 }),
    driver({ kind: 'status', state: 'ready' }),
    { bus: 'receipt:open', payload: { receipt: receipt('p_11a0', T0 - 86_400_000, 0.1, 9.96), source: 'activity' } },
    { bus: 'receipt:open', payload: { receipt: receipt('p_7f3a9c2b', at, 0.05, 4.98), source: 'activity' } },

    (step(30_000), driver({ kind: 'said', text: 'I want to deposit USDC on Base' })),
    driver({ kind: 'tool', name: 'mcp__phosphor__deposit', input: { chain: 'base', asset: 'USDC' } }),
    (step(1100), driver({ kind: 'tool_result', name: 'mcp__phosphor__deposit', ok: true })),
    driver({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: { chain: 'base', asset: 'USDC' }, data: DEPOSIT }),
    (step(800), driver({ kind: 'text', text: 'The address and a QR code are in the window now. Check it ends in 9Xk2, choose the Base network on the sending side, and send a small amount first.' })),
    driver({ kind: 'turn_end', error: false, turns: 1 }),
    driver({ kind: 'status', state: 'ready' }),
  ];
}

// ---------- the browser ----------

async function main(): Promise<void> {
  const port = await freePort();
  await startApp(port);
  await createWallet();

  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  const shots: string[] = [];
  try {
    const page: Json = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, bypassCSP: true });
    page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
    page.on('console', (msg: Json) => {
      if (msg.type() === 'error' || msg.type() === 'warning') log.push(`[console.${msg.type()}] ${msg.text()}\n`);
    });
    await page.goto(`${base}/?token=${token}${EXTRA ? '&beam=slow' : ''}`, { waitUntil: 'load' });
    await page.waitForSelector('#conversation', { state: 'attached' });
    await page.waitForFunction('!!(window.PhosphorAgent && window.PhosphorEvents && window.PhosphorCards)', undefined, { timeout: 20_000 });
    await page.evaluate('document.fonts.ready');
    await sleep(400);

    /* The conversation goes in through the events bus, frame by frame, exactly as the SSE
       stream would deliver it. A short pause after each so the panel's entrances run. */
    /* Evaluated as a string, because this file is typechecked with the server's config and
       has no `window` in it: the page has. */
    const emit = `(function (f) {
      var events = window.PhosphorEvents;
      if (f.bus) events.emit(f.bus, f.payload);
      else events.emit('driver', f);
    })`;
    for (const frame of conversation()) {
      await page.evaluate(`${emit}(${JSON.stringify(frame)})`);
      await sleep(30);
    }
    /* receipt:open also opens the receipt popover, which is the window's business and not
       this proof's: the thread is what is being shot. */
    await page.evaluate('(function () { var r = window.PhosphorReceipt; if (r && r.close) r.close(); })()');
    await sleep(700);

    fs.mkdirSync(SHOTS, { recursive: true });
    const shoot = async (name: string): Promise<void> => {
      const file = path.join(SHOTS, name);
      await page.screenshot({ path: file });
      shots.push(file);
    };

    /* The whole thread at the laptop size: the panel is scrolled to the end, so the shot holds
       the newest cards, then to the top for the first two. */
    await shoot('chat-1280.png');
    await page.evaluate('(function () { var t = document.querySelector(".transcript"); if (t) t.scrollTop = 0; })()');
    await sleep(200);
    await shoot('chat-1280-top.png');

    /* The composer with a draft in it and the caret in the box. */
    await page.evaluate('(function () { var t = document.querySelector(".transcript"); if (t) t.scrollTop = t.scrollHeight; })()');
    await page.focus('.composer-input');
    await page.keyboard.type('Close the ETH short if it comes back to 2,450');
    await sleep(250);
    await shoot('chat-1280-composer.png');
    await page.keyboard.press('Escape');

    /* The receipts: the older one folded and the newest open, then the newest folded too. */
    await page.evaluate('(function () { var r = document.querySelectorAll(".tcard[data-card=receipt]"); var last = r[r.length - 1]; if (last) last.scrollIntoView({ block: "center" }); })()');
    await sleep(250);
    await shoot('chat-1280-receipt-open.png');
    await page.evaluate('(function () { var r = document.querySelectorAll(".tcard[data-card=receipt] .tcard-head"); var last = r[r.length - 1]; if (last) last.click(); })()');
    await sleep(350);
    await shoot('chat-1280-receipt-folded.png');
    await page.evaluate('(function () { var r = document.querySelectorAll(".tcard[data-card=receipt] .tcard-head"); var last = r[r.length - 1]; if (last) last.click(); })()');

    /* The big display. */
    await page.setViewportSize({ width: 2560, height: 1440 });
    await sleep(500);
    await page.evaluate('(function () { var t = document.querySelector(".transcript"); if (t) t.scrollTop = t.scrollHeight; })()');
    await sleep(200);
    await shoot('chat-2560.png');

    if (EXTRA) await extras(page, emit, shots);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ screenshots: shots }, null, 2));
  const noise = log.filter((l) => l.startsWith('[page]') || l.startsWith('[console'));
  if (noise.length) console.log(`browser noise:\n${noise.join('')}`);
}

/* The panel's other states, one picture each, into PROOF_EXTRA_DIR. */
async function extras(page: Json, emit: string, shots: string[]): Promise<void> {
  const dir = EXTRA as string;
  fs.mkdirSync(dir, { recursive: true });
  const shoot = async (name: string): Promise<void> => {
    const file = path.join(dir, name);
    await page.screenshot({ path: file });
    shots.push(file);
  };
  const send = async (frame: Frame): Promise<void> => {
    await page.evaluate(`${emit}(${JSON.stringify(frame)})`);
  };
  const chat = 'c1';
  const driver = (event: Record<string, unknown>): Frame => ({ chat, event: { ...event, at: Date.now() } });

  await page.setViewportSize({ width: 1280, height: 800 });
  /* The receipt shots above centre a card with scrollIntoView, which also scrolls the column's
     own overflow:hidden body a few pixels; put the head back where a person sees it. */
  await page.evaluate('(function () { var b = document.querySelector(".conversation-body"); if (b) b.scrollTop = 0; var c = document.querySelector(".conversation"); if (c) c.scrollTop = 0; })()');
  await sleep(400);

  /* The pill: the person is reading at the top when two rows land. */
  await page.evaluate('(function () { var t = document.querySelector(".transcript"); if (t) { t.scrollTop = t.scrollHeight; } })()');
  await sleep(200);
  await page.evaluate('(function () { var t = document.querySelector(".transcript"); if (t) { t.scrollTop = 0; } })()');
  await sleep(300);
  await send(driver({ kind: 'said', text: 'Is anything waiting on me?' }));
  await sleep(120);
  await send(driver({ kind: 'text', text: 'Nothing is waiting. The swap you approved landed and the deposit address is still open in the window.' }));
  await send(driver({ kind: 'turn_end', error: false, turns: 1 }));
  await send(driver({ kind: 'status', state: 'ready' }));
  await sleep(700);
  await shoot('panel-jump-pill.png');
  await page.click('.jump-latest');
  await sleep(700);
  await shoot('panel-jump-landed.png');

  /* The Basic folds at the foot of the column: shut, then Money in open. */
  const toFoot = '(function () { var v = document.getElementById("views"); if (v) v.scrollTop = v.scrollHeight; })()';
  await page.evaluate(toFoot);
  await sleep(300);
  await shoot('panel-basic-folds.png');
  await page.click('.fold[data-surface="moneyin"] > .fold-head');
  await sleep(500);
  await page.evaluate(toFoot);
  await sleep(200);
  await shoot('panel-basic-moneyin-open.png');
  await page.click('.fold[data-surface="moneyin"] > .fold-head');
  await sleep(300);
  await page.evaluate('(function () { var v = document.getElementById("views"); if (v) v.scrollTop = 0; })()');

  /* The Pro Money head. */
  await page.click('.tab[data-tab="pro"]');
  await sleep(900);
  await shoot('panel-pro-money.png');
  await page.click('.tab[data-tab="basic"]');
  await sleep(600);

  /* The beam, slowed to four seconds by ?beam=slow: the dot in the air, then the landing. */
  await send(driver({ kind: 'said', text: 'Draw the levels on ETH' }));
  await sleep(80);
  await send(driver({ kind: 'tool', name: 'mcp__phosphor__chart_draw', input: { product: 'ETH-USD' } }));
  await sleep(1600);
  await shoot('panel-beam-flight.png');
  await sleep(3700);
  await shoot('panel-beam-landed.png');
  await send(driver({ kind: 'tool_result', name: 'mcp__phosphor__chart_draw', ok: true }));
  await send(driver({ kind: 'text', text: 'Done: support at 2,410 and the range top at 2,560 are on the chart.' }));
  await send(driver({ kind: 'turn_end', error: false, turns: 1 }));
  await send(driver({ kind: 'status', state: 'ready' }));
  await sleep(600);

  /* Turn off: the card, then the empty state it leaves behind. */
  await page.click('.agent-controls .btn-quiet');
  await sleep(500);
  await shoot('panel-quit-card.png');
  await page.click('#overlay-card .btn-danger');
  await sleep(1200);
  await shoot('panel-empty-after-quit.png');
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
