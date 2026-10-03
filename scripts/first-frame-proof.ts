// The first frame of every move card, proved in a browser. A propose draws its card the moment the
// agent asks, from the call's own arguments, and an agent may name a coin by 1Click's asset id
// (propose_swap: "a symbol, or the assetId swap_assets gave"). On 0.10.13 that first frame read
// "Swap 1.7147 nep141:17208628...a1 to SOL" over two gray monograms until the row landed (Karim,
// 2026-10-02). This plays one turn through the app's own conversation with the scripted agent
// (tests/eval/agent.ts), holding each propose the way a live quote holds it (holdMs), and records
// every frame each card showed from a MutationObserver in the page, so the first frame is on
// record whether it lasts a second or one paint. Each card is photographed when it first appears
// and again once its row lands, at 1280 x 800 and at 960 x 700.
//
// Run: node scripts/first-frame-proof.ts [--out <dir>] [--label after] [--port 4206] [--hold 2500]
// --out defaults to scripts/scratch/first-frame-proof/, which git ignores (docs/screenshots/first-frame/
// with --docs).
// Demo mode on a throwaway data dir and a scratch HOME, never port 4177; it quits everything it
// started. playwright-core is not a dependency of this repo: point PLAYWRIGHT_CORE at a copy (the
// npx cache has one) and it uses the headless shell that copy knows; PROOF_BROWSER names another
// Chromium binary.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { proofOut } from './proof-out.ts';

type Json = any;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};
const PORT = Number(flag('--port', process.env.PHOSPHOR_PORT ?? '4206'));
if (PORT === 4177) throw new Error('4177 is the installed app\'s port; pick another');
const OUT = path.resolve(flag('--out', proofOut('first-frame-proof', 'first-frame')));
const LABEL = flag('--label', 'run');
const HOLD_MS = Number(flag('--hold', '2500'));
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/705bc6b22212b352/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const SIZES = [
  { width: 1280, height: 800 },
  { width: 960, height: 700 },
];
const DEADLINE_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// USDC as NEAR Intents holds it on NEAR: the id in Karim's screenshot.
const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const PAYEE = '0x1111111111111111111111111111111111111111';

/* One turn, every kind a person meets in the chat: a swap named by the id swap_assets gave, a swap
   named by lowercase tickers, a payout to a chain, a send inside NEAR Intents and a deposit to the
   trading account. Each propose is held HOLD_MS after it is announced. */
function scenario(): Json {
  const held = (tool: string, toolArgs: Json): Json => ({ tool, args: toolArgs, holdMs: HOLD_MS });
  return {
    id: 'FIRST-FRAME',
    title: 'the first frame of every move card',
    userSays: 'swap 1.7147 of my NEAR USDC to SOL, swap 2 usdc to sol, pay 2 USDC to my Base address, send 1 usdc to alice.near and move 10 usdc to trading',
    pre: {
      demo: {
        intents: [
          { symbol: 'USDC', originChain: 'near', assetId: USDC_NEAR, amount: 25, decimals: 6 },
          { symbol: 'USDC', originChain: 'eth', assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', amount: 1850, decimals: 6 },
          { symbol: 'SOL', originChain: 'sol', assetId: 'nep141:sol.omft.near', amount: 1.2, decimals: 9 },
        ],
      },
    },
    script: [
      { tool: 'swap_assets', args: { query: 'usdc' } },
      held('propose_swap', { fromSymbol: USDC_NEAR, toSymbol: 'SOL', amountIn: '1.7147' }),
      held('propose_swap', { fromSymbol: 'usdc', chain: 'eth', toSymbol: 'sol', amountIn: '2' }),
      held('propose_send', { symbol: 'usdc', amount: 2, to: PAYEE, where: 'base', confirmed: true }),
      held('propose_send', { symbol: 'usdc', amount: 1, to: 'alice.near', where: 'intents', confirmed: true }),
      held('propose_hl_deposit', { symbol: 'usdc', amount: 10 }),
      { say: 'Five cards up.' },
    ],
  };
}

// ---------- the staged repo, as scripts/card-proof.ts stages it ----------

const STAGE_COPY = ['src', 'tests', 'scripts', 'operator', 'data', 'skills', 'ui', 'package.json', 'tsconfig.json', 'config.json'];

function stageRepo(play: Json): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-first-frame-'));
  for (const entry of STAGE_COPY) {
    const from = path.join(ROOT, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(stage, entry), { recursive: true, dereference: false });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(stage, 'node_modules'));
  fs.chmodSync(path.join(stage, 'tests', 'eval', 'agent.ts'), 0o755);
  // The scripted agent is the conversation's child, where src/driver.ts looks first.
  const home = path.join(stage, 'home');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(stage, 'tests', 'eval', 'agent.ts'), path.join(home, '.local', 'bin', 'claude'));
  fs.writeFileSync(path.join(stage, '.eval-scenario.json'), `${JSON.stringify(play, null, 2)}\n`);
  const demo = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'demo-state.json'), 'utf8')), ...(play.pre?.demo ?? {}) };
  fs.writeFileSync(path.join(stage, 'data', 'demo-state.json'), `${JSON.stringify(demo, null, 2)}\n`);
  return stage;
}

// ---------- the app ----------

type AppProcess = ChildProcessByStdio<Writable, Readable, Readable>;

async function bootApp(stage: string, dataDir: string): Promise<{ base: string; token: string; output: string[]; stop(): Promise<void> }> {
  const base = `http://127.0.0.1:${PORT}`;
  const token = crypto.randomBytes(32).toString('hex');
  const output: string[] = [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  const home = path.join(stage, 'home');
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: stage,
    env: {
      ...env,
      HOME: home,
      CFFIXED_USER_HOME: home,
      PATH: `${path.join(home, '.local', 'bin')}:${env.PATH ?? ''}`,
      PHOSPHOR_PORT: String(PORT),
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_DATA_DIR: dataDir,
      PHOSPHOR_DEMO_STAGE_SCALE: process.env.PHOSPHOR_DEMO_STAGE_SCALE ?? '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as AppProcess;
  child.stdin.write(`${token}\n`);
  child.stdin.end();
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const until = Date.now() + 20_000;
  let up = false;
  while (Date.now() < until && child.exitCode === null) {
    try {
      const res = await fetch(`${base}/api/state`, { headers: { 'x-phosphor-token': token } });
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(2500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };
  if (!up) {
    await stop();
    throw new Error(`the app did not boot on ${base}: ${output.join('').slice(-800)}`);
  }
  return { base, token, output, stop };
}

async function post(base: string, route: string, body: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
  let json: Json = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, json };
}

// ---------- the page side ----------

/* Every frame every move card showed, in order: a MutationObserver callback runs after the DOM
   changes and before the browser paints, so the first entry per card is its first painted frame.
   A frame is the card's kind and state, its move line, its state word, its marks (the logo's
   token, the file it drew, or the monogram it fell back to) and the face under the head. */
const WATCH = `(() => {
  if (window.__firstFrame) return;
  const cards = [];
  const frames = [];
  const faceOf = (card) => {
    const parts = [];
    for (const sel of ['.mcard-move', '.mcard-line', '.mcard-facts', '.mcard-to']) {
      const n = card.querySelector(sel);
      if (n && !n.hidden && n.textContent) parts.push(n.textContent.replace(/\\s+/g, ' ').trim());
    }
    return parts.join(' | ');
  };
  const snap = () => {
    for (const card of document.querySelectorAll('.chat-card .mcard[data-card="move"]')) {
      let i = cards.indexOf(card);
      if (i === -1) { cards.push(card); frames.push([]); i = cards.length - 1; }
      const marks = Array.from(card.querySelectorAll('.mcard-marks .logo')).map((n) => {
        const img = n.querySelector('img');
        return { token: n.getAttribute('data-token'), fallback: n.getAttribute('data-fallback') === 'true', src: img ? img.getAttribute('src') : null, text: img ? '' : n.textContent };
      });
      const word = card.querySelector('.mcard-state-word');
      const move = card.querySelector('.mcard-move');
      const frame = {
        kind: card.getAttribute('data-kind'),
        state: card.getAttribute('data-state'),
        id: card.id.replace(/^card-proposal-/, ''),
        move: move ? move.textContent.replace(/\\s+/g, ' ').trim() : '',
        coins: move ? Array.from(move.querySelectorAll('.mcard-sym, .mcard-word')).map((n) => n.textContent.trim()).join(' ') : '',
        word: word ? word.textContent : '',
        marks,
        glyph: !!card.querySelector('.mcard-marks .mcard-glyph'),
        face: faceOf(card),
      };
      const key = JSON.stringify(frame);
      const list = frames[i];
      if (!list.length || list[list.length - 1].key !== key) list.push(Object.assign({ at: Math.round(performance.now()), key }, frame));
    }
  };
  new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  window.__firstFrame = { frames, box: (i) => { const c = cards[i]; if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; } };
})()`;

const FRAMES = '(() => window.__firstFrame ? window.__firstFrame.frames.map((list) => list.map((f) => { const { key, ...rest } = f; return rest; })) : [])()';

async function shoot(page: Json, index: number, file: string): Promise<void> {
  const box = (await page.evaluate(`window.__firstFrame.box(${index})`)) as Json;
  if (!box || box.width < 1 || box.height < 1) {
    await page.screenshot({ path: file });
    return;
  }
  const vp = page.viewportSize();
  const x = Math.max(0, box.x - 10);
  const y = Math.max(0, box.y - 10);
  await page.screenshot({ path: file, clip: { x, y, width: Math.min(box.width + 20, vp.width - x), height: Math.min(box.height + 20, vp.height - y) } });
}

// ---------- the checks ----------

// An asset id in words a person reads: 1Click's three id shapes and a bare 64-hex account.
const RAW_ID = /nep141:|nep245:|omft\.near|1cs_v1:|\b[0-9a-f]{64}\b/i;

function judge(frames: Json[][]): Record<string, unknown> {
  const all = frames.flat();
  const leaks = all.filter((f) => RAW_ID.test(f.face) || RAW_ID.test(f.move)).map((f) => `${f.kind} ${f.state}: ${f.move}`);
  // A monogram drawn from an id's first character: the "N" and "1" of the screenshot.
  const idMarks = all.filter((f) => f.marks.some((m: Json) => m.fallback && (/[:.]|^NEP|^[0-9A-F]{8,}/i.test(String(m.token)))));
  const firsts = frames.map((list) => list[0]).filter(Boolean);
  // The first frame wears each coin's own logo file, never a monogram, wherever it names a coin.
  const coinless = firsts.filter((f) => f.marks.length === 0 || f.marks.some((m: Json) => m.fallback || !m.src));
  // The coins the first frame names are the coins the landed row names: no coin changes its name.
  // A send's chain ("from Ethereum") arrives with its row and is not a coin's name.
  const flips = frames
    .map((list) => {
      const first = list[0];
      const landed = list.find((f) => f.id !== '');
      return first && landed && landed.state !== 'done' && first.coins !== landed.coins ? `${first.kind}: "${first.move}" became "${landed.move}"` : null;
    })
    .filter(Boolean);
  return {
    'no raw asset id in any frame': leaks.length === 0,
    'no monogram drawn from an id': idMarks.length === 0,
    'every first frame wears the coin\'s own logo': coinless.length === 0,
    'first frame and landed row say the same coins': flips.length === 0,
    leaks,
    idMarks: idMarks.map((f) => `${f.kind}: ${JSON.stringify(f.marks)}`),
    coinless: coinless.map((f) => `${f.kind}: ${f.move} ${JSON.stringify(f.marks)}`),
    flips,
  };
}

// ---------- the run ----------

async function main(): Promise<void> {
  const play = scenario();
  fs.mkdirSync(OUT, { recursive: true });
  const stage = stageRepo(play);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-first-frame-data-'));
  const app = await bootApp(stage, dataDir);
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  const result: Json = { label: LABEL, port: PORT, holdMs: HOLD_MS, sizes: {}, log: [] };
  try {
    const created = await post(app.base, '/api/wallet/create', { token: app.token, password: 'proof-password-1' });
    if (created.status !== 200) throw new Error(`wallet create refused: ${created.status} ${JSON.stringify(created.json)}`);
    const terms = await post(app.base, '/api/terms/accept', { token: app.token });
    if (terms.status !== 200) throw new Error(`terms accept refused: ${terms.status} ${JSON.stringify(terms.json)}`);
    const pages: Json[] = [];
    for (const size of SIZES) {
      const page: Json = await browser.newPage({ viewport: size, deviceScaleFactor: 2, bypassCSP: true });
      page.on('pageerror', (err: unknown) => result.log.push(`[${size.width} page] ${String(err)}`));
      await page.goto(`${app.base}/?token=${app.token}`, { waitUntil: 'load' });
      await page.waitForSelector('.agent-composer', { state: 'attached', timeout: 20_000 }).catch(() => undefined);
      await page.evaluate(WATCH);
      pages.push(page);
    }
    const opened = await post(app.base, '/api/driver', { action: 'open', token: app.token });
    if (opened.status !== 200) throw new Error(`open refused: ${opened.status} ${JSON.stringify(opened.json)}`);
    await sleep(1500);
    const prompted = await post(app.base, '/api/driver', { action: 'prompt', text: play.userSays, token: app.token, chat: opened.json.id });
    if (prompted.status !== 200) throw new Error(`prompt refused: ${prompted.status} ${JSON.stringify(prompted.json)}`);

    const shotFirst = new Set<string>();
    const shotLanded = new Set<string>();
    const started = Date.now();
    let quietSince = 0;
    while (Date.now() - started < DEADLINE_MS) {
      let landedAll = true;
      let count = 0;
      for (const [p, page] of pages.entries()) {
        const width = SIZES[p]!.width;
        const frames = (await page.evaluate(FRAMES)) as Json[][];
        count = Math.max(count, frames.length);
        for (const [i, list] of frames.entries()) {
          const last = list[list.length - 1];
          const name = `${LABEL}-${String(i + 1).padStart(2, '0')}-${last.kind}`;
          if (!shotFirst.has(`${p}:${i}`)) {
            shotFirst.add(`${p}:${i}`);
            await shoot(page, i, path.join(OUT, `${name}-first-${width}.png`));
          }
          const landed = last.id !== '' && last.state !== 'working';
          if (landed && !shotLanded.has(`${p}:${i}`)) {
            shotLanded.add(`${p}:${i}`);
            await sleep(400);
            await shoot(page, i, path.join(OUT, `${name}-landed-${width}.png`));
          }
          if (!landed) landedAll = false;
        }
      }
      if (count >= 5 && landedAll) {
        if (quietSince === 0) quietSince = Date.now();
        if (Date.now() - quietSince > 1500) break;
      } else quietSince = 0;
      await sleep(80);
    }
    for (const [p, page] of pages.entries()) {
      const width = SIZES[p]!.width;
      const frames = (await page.evaluate(FRAMES)) as Json[][];
      await page.screenshot({ path: path.join(OUT, `${LABEL}-window-${width}.png`) });
      result.sizes[width] = { cards: frames.length, frames, pass: judge(frames) };
    }
  } finally {
    await browser.close().catch(() => undefined);
    await app.stop();
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(OUT, `${LABEL}-first-frame.json`), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [`first-frame-proof ${LABEL} on ${PORT}, hold ${HOLD_MS} ms`];
  for (const [width, entry] of Object.entries(result.sizes as Record<string, Json>)) {
    lines.push(`${width}: ${entry.cards} cards`);
    for (const [i, list] of (entry.frames as Json[][]).entries()) {
      const first = list[0];
      const landed = list.find((f: Json) => f.id !== '');
      lines.push(`  card ${i + 1} ${first.kind}: first "${first.move}" [${first.word}] marks ${first.marks.map((m: Json) => (m.src ? m.token : `monogram ${m.text}`)).join('+') || (first.glyph ? 'glyph' : 'none')}`);
      if (landed) lines.push(`         landed "${landed.move}" [${landed.word}] marks ${landed.marks.map((m: Json) => (m.src ? m.token : `monogram ${m.text}`)).join('+') || (landed.glyph ? 'glyph' : 'none')}`);
    }
    for (const [k, v] of Object.entries(entry.pass as Record<string, unknown>)) if (typeof v === 'boolean') lines.push(`  ${v ? 'PASS' : 'FAIL'} ${k}`);
  }
  if ((result.log as string[]).length) lines.push(...(result.log as string[]).slice(0, 10));
  lines.push(`written: ${OUT}`);
  console.log(lines.join('\n'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
