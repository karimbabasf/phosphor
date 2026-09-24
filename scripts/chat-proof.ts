// The conversation, proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with a throwaway data directory, creates the demo
// wallet so the window opens past its first-run card, then drives headless Chromium through
// playwright-core and plays fixture conversations into the thread through the same door the
// server's SSE frames come through (PhosphorEvents.emit('driver', frame)). Each scene is one
// fresh window: the thread as the design reference draws it (a swap done, a swap waiting for
// its OK), a move being asked for with the working line under it, a swap running with a reply
// streaming in, a swap the venue failed with nothing moved, a swap nobody would price, a move
// that runs late, a waiting card scrolled out of view, and Latest. Every scene is shot at
// 1280 x 800 and 1440 x 900 into PROOF_OUT (default docs/screenshots/chat/).
//
// Fixture data only: the demo wallet on a temp directory, never the live one, and no model turn
// is spent. Run:
//   PROOF_OUT=<dir> node scripts/chat-proof.ts [--scenes thread,failed]
// playwright-core is not a dependency of this repo; point PLAYWRIGHT_CORE at a copy. Without
// playwright's own Chromium installed, point PROOF_BROWSER at a Chromium binary.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposalView } from '../src/proposals/view.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/47c97c996798144b/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const SHOTS = process.env.PROOF_OUT ?? path.join(ROOT, 'docs', 'screenshots', 'chat');
const SIZES: Array<[number, number]> = [[1280, 800], [1440, 900]];
const ONLY = (() => {
  const at = process.argv.indexOf('--scenes');
  return at === -1 ? null : new Set(String(process.argv[at + 1] ?? '').split(',').filter(Boolean));
})();

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
    env: { ...process.env, PHOSPHOR_MODE: 'demo', PHOSPHOR_PORT: String(port), PHOSPHOR_DATA_DIR: dataDir },
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
  const terms = await post('/api/terms/accept', { token });
  if (terms.status !== 200) throw new Error(`terms accept refused: ${terms.status} ${JSON.stringify(terms.json)}`);
  const created = await post('/api/wallet/create', { token, password: 'proof-password-1' });
  if (created.status !== 200) throw new Error(`wallet create refused: ${created.status} ${JSON.stringify(created.json)}`);
}

// ---------- the rows ----------

/* A row as the app hands it to the window, with its view beside it, built by the one builder
   (src/proposals/view.ts), so the card reads what the real frame would carry. */
function withView(row: Json, now = Date.now()): Json {
  return { ...row, view: proposalView({ settle: (r: Json) => r } as Json, row, now) };
}

const HANDLE = '3f9c2a7b1e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f';

function swapDraft(fromSymbol: string, toSymbol: string, amountIn: number, amountUsd: number): Json {
  return { kind: 'swap', venue: 'intents-native', chain: 'intents', toChain: 'intents', fromSymbol, toSymbol, amountIn, amountUsd, minAmountOut: 0, from: 'you.near', to: 'you.near', counterparty: 'intents.near', quote: null };
}

function swapRow(id: string, status: string, over: Json, ageSec = 0): Json {
  const created = new Date(Date.now() - ageSec * 1000).toISOString();
  return withView({
    id,
    kind: 'swap',
    createdAt: created,
    lastChangeAt: created,
    status,
    verdict: { outcome: 'needs_approval', reasons: ['swap of $500.00 to intents.near.', 'It is above the $100 you said to ask about.'] },
    simulation: { ok: true, summary: 'swap 500 USDC for about 0.1862 ETH inside NEAR Intents', swap: { receives: '0.1862', receivesAtLeast: '0.1843', feeUsd: 0.21 } },
    draft: swapDraft('USDC', 'ETH', 500, 500),
    ...over,
  });
}

/* A driver frame, as the SSE stream carries it, or the proposals slice of a state frame: the
   server's own rows, which are the only rows a card offers Approve on. */
type Frame = { chat: string; event: Json } | { proposals: Json[] };

function driver(event: Json): Frame {
  return { chat: 'c1', event: { ...event, at: Date.now() } };
}

const TOOL = 'mcp__phosphor__propose_swap';

function turn(said: string, input: Json, data: Json | null, reply: string | null, end = true): Frame[] {
  const out: Frame[] = [driver({ kind: 'said', text: said }), driver({ kind: 'tool', name: TOOL, input })];
  if (data) {
    out.push(driver({ kind: 'tool_result', name: TOOL, ok: true }));
    out.push(driver({ kind: 'tool_data', name: TOOL, input, data }));
    if (data.id) out.push({ proposals: [data] });
  }
  if (reply) out.push(driver({ kind: 'text', text: reply }));
  if (end) out.push(driver({ kind: 'turn_end', error: false, turns: 1 }), driver({ kind: 'status', state: 'ready' }));
  return out;
}

function doneSwap(): Frame[] {
  const input = { fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 4 };
  const done = swapRow('p_done4', 'executed', {
    decidedBy: 'policy',
    decidedAt: new Date(Date.now() - 20_000).toISOString(),
    settledAt: new Date(Date.now() - 14_000).toISOString(),
    draft: swapDraft('USDC', 'ETH', 4, 4),
    simulation: { ok: true, summary: 'swap 4 USDC for about 0.00149 ETH', swap: { receives: '0.00149', receivesAtLeast: '0.00147', feeUsd: 0.02 } },
    result: { ok: true, detail: 'intent settled', evidence: { providerStage: 'SETTLED', amountOut: '0.00149' } },
  }, 20);
  done.view.money.amountOut = '0.00149';
  done.view.tookSec = 6;
  return turn('swap 4 dollars into eth', input, done, 'Done. You swapped 4 USDC for **0.00149 ETH**, about **$3.98**. Took 6 seconds.');
}

function waitingSwap(): Frame[] {
  const input = { fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 500 };
  return turn('now swap 500 USDC to ETH', input, swapRow('p_wait500', 'pending', {}), 'This one is over your **$100** limit, so it needs your OK.');
}

// ---------- the scenes ----------

type Scene = { name: string; frames: () => Frame[]; after?: (page: Json) => Promise<void> };

const SCENES: Scene[] = [
  { name: 'thread', frames: () => [...doneSwap(), ...waitingSwap()] },
  {
    name: 'asking',
    frames: () => [driver({ kind: 'said', text: 'swap 25 USDC into SOL' }), driver({ kind: 'tool', name: TOOL, input: { fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 25 } })],
  },
  {
    name: 'working',
    frames: () => {
      const input = { fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 25 };
      const running = swapRow('p_run25', 'executing', {
        decidedBy: 'policy',
        decidedAt: new Date(Date.now() - 9_000).toISOString(),
        draft: swapDraft('USDC', 'SOL', 25, 25),
        simulation: { ok: true, summary: 'swap 25 USDC for about 0.1693 SOL', swap: { receives: '0.1693', receivesAtLeast: '0.1676', feeUsd: 0.04 } },
        result: { ok: true, detail: 'sent', evidence: { providerStage: 'PENDING' } },
      }, 9);
      return [
        ...turn('swap 25 USDC into SOL', input, running, null, false),
        driver({ kind: 'delta', block: 9, text: 'On it. The swap is running now, and ' }),
        driver({ kind: 'delta', block: 9, text: 'the card above changes the moment it lands' }),
      ];
    },
  },
  {
    name: 'failed',
    frames: () => {
      const input = { fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 4 };
      const failed = swapRow('p_fail4', 'failed', {
        decidedBy: 'policy',
        decidedAt: new Date(Date.now() - 70_000).toISOString(),
        settledAt: new Date(Date.now() - 10_000).toISOString(),
        draft: swapDraft('USDC', 'ETH', 4, 4),
        simulation: { ok: true, summary: 'swap 4 USDC for about 0.00149 ETH', swap: { receives: '0.00149', receivesAtLeast: '0.00147', feeUsd: 0.02 } },
        result: { ok: false, reason: 'venue_failed_nothing_moved', detail: `1click reported FAILED (reason not given) and the intents ledger shows no transfer to handle ${HANDLE} since this move was approved, so nothing left the balance.`, evidence: { providerStage: 'FAILED', handle: HANDLE } },
      }, 70);
      return turn('swap 4 dollars into eth', input, failed, 'That swap did not go through. Nothing left your balance, so your **4 USDC** is still there.');
    },
  },
  {
    name: 'noprice',
    frames: () => {
      const input = { fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 4 };
      const refused = swapRow('p_noprice', 'policy_refused', {
        verdict: { outcome: 'refuse', reasons: ['swap of $4.00 to intents.near.', 'Nobody offered a price for this swap right now. Nothing moved.'] },
        simulation: { ok: false, summary: '', error: 'no quote' },
        draft: swapDraft('USDC', 'ETH', 4, 4),
      });
      return turn('swap 4 dollars into eth', input, refused, 'Nobody would price that swap just now, so nothing moved. Try again in a minute.');
    },
  },
  {
    name: 'late',
    frames: () => {
      const input = { fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 40 };
      const late = swapRow('p_late40', 'executing', {
        decidedBy: 'human',
        decidedAt: new Date(Date.now() - 190_000).toISOString(),
        draft: swapDraft('USDC', 'ETH', 40, 40),
        simulation: { ok: true, summary: 'swap 40 USDC for about 0.0149 ETH', swap: { receives: '0.0149', receivesAtLeast: '0.0147', feeUsd: 0.05 } },
        result: { ok: true, detail: 'sent', evidence: { providerStage: 'TX_BROADCASTED' } },
      }, 200);
      return turn('swap 40 USDC to ETH', input, late, 'It is running. The venue is slower than usual today.');
    },
  },
  /* The conversation went on under a card that still needs the person: the column is at its
     end, the card is above the fold, and the line over the box says so. */
  { name: 'scrolled', frames: () => [...waitingSwap(), ...history(6)] },
  {
    name: 'latest',
    frames: () => [...doneSwap(), ...history(6)],
    after: async (page) => {
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, -1600);
      await sleep(700);
    },
  },
];

function history(n: number): Frame[] {
  const out: Frame[] = [];
  const asks = ['What is ETH doing today?', 'And SOL?', 'Is anything waiting on me?', 'What did I spend on fees this week?', 'How much is in trading?', 'Thanks'];
  const answers = [
    'ETH is up **2.1%** today, at **$2,684**.',
    'SOL is flat, at **$148.20**.',
    'One swap is waiting for your OK: **500 USDC** into ETH.',
    'About **$0.31** across four moves.\n\n- Swaps: **$0.27**\n- Sends: **$0.04**',
    'Nothing is in the trading account right now.',
    'Any time.',
  ];
  for (let i = 0; i < n; i += 1) {
    out.push(driver({ kind: 'said', text: asks[i % asks.length] as string }));
    out.push(driver({ kind: 'text', text: answers[i % answers.length] as string }));
    out.push(driver({ kind: 'turn_end', error: false, turns: 1 }), driver({ kind: 'status', state: 'ready' }));
  }
  return out;
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
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    for (const [width, height] of SIZES) {
      const page: Json = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, bypassCSP: true });
      page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
      page.on('console', (msg: Json) => {
        if (msg.type() === 'error' || msg.type() === 'warning') log.push(`[console.${msg.type()}] ${msg.text()}\n`);
      });
      for (const scene of SCENES) {
        if (ONLY && !ONLY.has(scene.name)) continue;
        await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
        await page.waitForSelector('#conversation', { state: 'attached' });
        await page.waitForFunction('!!(window.PhosphorAgent && window.PhosphorEvents && window.PhosphorCards)', undefined, { timeout: 20_000 });
        await page.evaluate('document.fonts.ready');
        /* The frame this build ships gives the conversation 30 percent of the window; the chat
           and balances frame gives it the wide side. The proof shoots the thread at its own
           measure, so it widens the column to the frame's cap. */
        await page.evaluate('(function () { var s = document.querySelector(".stage"); if (s) s.style.setProperty("--conv", "760px"); })()');
        await sleep(300);
        /* The backup nudge is a real card in the thread on a funded demo wallet; a person
           would put it away, and the scenes are about the moves. */
        await page.evaluate('(function () { var x = document.querySelector(".chat-sheet .dock-close"); if (x) x.click(); })()');
        const emit = `(function (f) {
          if (f.proposals) {
            var store = window.PhosphorState;
            var now = store.get() || {};
            var had = Array.isArray(now.proposals) ? now.proposals : [];
            store.put(Object.assign({}, now, { proposals: had.filter(function (p) { return !f.proposals.some(function (q) { return q.id === p.id; }); }).concat(f.proposals) }));
            return;
          }
          window.PhosphorEvents.emit("driver", f);
        })`;
        await page.evaluate(`${emit}(${JSON.stringify(driver({ kind: 'status', state: 'ready' }))})`);
        for (const frame of scene.frames()) {
          await page.evaluate(`${emit}(${JSON.stringify(frame)})`);
          await sleep(40);
        }
        await sleep(900);
        if (scene.after) await scene.after(page);
        const file = path.join(SHOTS, `${scene.name}-${width}.png`);
        await page.screenshot({ path: file });
        shots.push(file);
      }
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
