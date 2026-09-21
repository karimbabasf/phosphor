// One card per move, proved in a browser: the scripted agent (tests/eval/agent.ts) plays a
// swap scenario through the app's own conversation, the demo rail walks the row through
// every stage, and headless Chromium watches the window. It counts `.chat-card` per proposal
// id at the end (criterion 5.1: exactly one), records every stage the card showed with the
// clock, the words, the card's height and the delay between the row changing on the server
// and the word changing on screen (5.3, 2.3), reads the fade the stylesheet put on the state
// word, and photographs the card at every stage at two column widths.
//
// Run: node scripts/card-proof.ts [--scenario S29] [--port 4204] [--out <dir>]
// It stages the repo the way scripts/eval.ts does, boots a demo app on the port with a data
// dir under state/, and quits everything it started. playwright-core is not a dependency of
// this repo: point PLAYWRIGHT_CORE at a copy (the npx cache has one) and it uses the headless
// shell that copy knows; PROOF_BROWSER names another Chromium binary.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { defaultPolicy } from '../src/policy/file.ts';
import { renderSentences } from '../src/policy/render.ts';
import { venueAllowlist } from '../src/rails/index.ts';
import { loadScenarios } from '../tests/eval/schema.ts';

type Json = any;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};
const SCENARIO = flag('--scenario', 'S29');
// The window's width for the walk: 1280 is the dock's wide fixture, 700 puts the card column at
// about 400, the narrow one (vault State 2026-09-18).
const WIDTH = Number(flag('--width', '1280'));
const PORT = Number(flag('--port', process.env.PHOSPHOR_PORT ?? '4204'));
const OUT = path.resolve(flag('--out', path.join(ROOT, 'docs', 'superpowers', 'prompts', 'ready-for-people', 'evidence-d', `card-proof-${WIDTH}`)));
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/705bc6b22212b352/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const POLL_MS = 50;
const DEADLINE_MS = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- the staged repo, as scripts/eval.ts stages it ----------

const STAGE_COPY = ['src', 'tests', 'scripts', 'operator', 'data', 'skills', 'ui', 'package.json', 'tsconfig.json', 'config.json'];

function stageRepo(scenario: Json): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-card-proof-'));
  for (const entry of STAGE_COPY) {
    const from = path.join(ROOT, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(stage, entry), { recursive: true, dereference: false });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(stage, 'node_modules'));
  fs.chmodSync(path.join(stage, 'tests', 'eval', 'agent.ts'), 0o755);
  /* The conversation's own child is the scripted agent, and it plays this scenario. It is put
     where src/driver.ts looks first, $HOME/.local/bin/claude, under a HOME of the stage's own:
     `driver.claudeBin` in config.json does not reach the app's chats (src/config.ts loadConfig
     drops the driver block, vault Gotchas), and the real binary answering here would be a
     model being paid for by a proof. */
  const home = path.join(stage, 'home');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(stage, 'tests', 'eval', 'agent.ts'), path.join(home, '.local', 'bin', 'claude'));
  fs.writeFileSync(path.join(stage, '.eval-scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);
  const demo = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'demo-state.json'), 'utf8')), ...(scenario.pre?.demo ?? {}) };
  fs.writeFileSync(path.join(stage, 'data', 'demo-state.json'), `${JSON.stringify(demo, null, 2)}\n`);
  return stage;
}

function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && !Array.isArray(current)
        ? mergeDeep(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

function seedDataDir(dataDir: string, scenario: Json): void {
  fs.mkdirSync(dataDir, { recursive: true });
  if (scenario.pre?.policy !== undefined) {
    const seeded = defaultPolicy();
    seeded.outbound.destinationAllowlist = venueAllowlist();
    const merged = mergeDeep(seeded as unknown as Record<string, unknown>, scenario.pre.policy);
    (merged as Json).sentences = renderSentences(merged as Json);
    fs.writeFileSync(path.join(dataDir, 'policy.json'), `${JSON.stringify(merged, null, 2)}\n`);
  }
}

// ---------- the app ----------

type AppProcess = ChildProcessByStdio<Writable, Readable, Readable>;

async function bootApp(stage: string, dataDir: string): Promise<{ base: string; token: string; output: string[]; stop(): Promise<void> }> {
  const base = `http://127.0.0.1:${PORT}`;
  const token = crypto.randomBytes(32).toString('hex');
  const output: string[] = [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: stage,
    env: { ...env, HOME: path.join(stage, 'home'), ACC_PORT: String(PORT), ACC_MODE: 'demo', ACC_DATA_DIR: dataDir, PHOSPHOR_DEMO_STAGE_SCALE: process.env.PHOSPHOR_DEMO_STAGE_SCALE ?? '1' },
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
      const res = await fetch(`${base}/api/state`);
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

// ---------- the page-side probe ----------

// What the window shows for every move card: per proposal id, the count of hosts, the state
// word, the stage line, the fold state, the card's box and the fade the stylesheet applied.
const PROBE = `(() => {
  const out = {};
  const hosts = Array.from(document.querySelectorAll('.chat-card'));
  for (const host of hosts) {
    const card = host.querySelector('.tcard[data-card="move"]');
    if (!card) continue;
    const id = card.id.replace(/^card-proposal-/, '');
    const word = card.querySelector('.tcard-state');
    const copy = card.querySelector('.tcard-stage-copy');
    const box = card.getBoundingClientRect();
    const cs = word ? getComputedStyle(word) : null;
    const entry = out[id] || (out[id] = { hosts: 0 });
    entry.hosts += 1;
    entry.word = word ? word.textContent : null;
    entry.fade = word ? word.getAttribute('data-fade') : null;
    entry.animation = cs ? cs.animationName + ' ' + cs.animationDuration : null;
    entry.copy = copy ? copy.textContent : null;
    entry.clock = (card.querySelector('.tcard-stage-since') || {}).textContent || null;
    entry.open = card.getAttribute('data-open');
    entry.details = (card.querySelector('.tcard-details') || { getAttribute: () => null }).getAttribute('data-open');
    entry.top = Math.round(box.top);
    entry.height = Math.round(box.height);
    entry.text = card.textContent;
  }
  return { cards: out, chatCards: hosts.length, receipts: document.querySelectorAll('.tcard[data-card="receipt"]').length, replies: Array.from(document.querySelectorAll('.chat-reply .chat-text')).map((n) => n.textContent) };
})()`;

/* A picture of one card by its box, taken now. Playwright's element screenshot waits for the
   element to hold still and to be visible by its own rules, and a card whose clock ticks and
   whose column scrolls never is; the box off the layout and a clip of the viewport is the
   picture a person sees at that moment. */
async function shoot(page: Json, id: string, file: string): Promise<void> {
  const box = (await page.evaluate(`(() => { const n = document.getElementById('card-proposal-${id}'); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, visible: getComputedStyle(n).visibility, display: getComputedStyle(n).display }; })()`)) as Json;
  if (!box || box.width < 1 || box.height < 1) {
    await page.screenshot({ path: file });
    return;
  }
  const vw = page.viewportSize().width;
  const vh = page.viewportSize().height;
  const x = Math.max(0, box.x - 8);
  const y = Math.max(0, box.y - 8);
  await page.screenshot({ path: file, clip: { x, y, width: Math.min(box.width + 16, vw - x), height: Math.min(box.height + 16, vh - y) } });
}

// ---------- the run ----------

async function main(): Promise<void> {
  const scenario = loadScenarios(path.join(ROOT, 'tests', 'eval')).find((s: Json) => s.id === SCENARIO);
  if (scenario === undefined) throw new Error(`no scenario ${SCENARIO}`);
  fs.mkdirSync(OUT, { recursive: true });
  const stage = stageRepo(scenario);
  const dataDir = path.join(ROOT, 'state', `card-proof-${Date.now()}`);
  seedDataDir(dataDir, scenario);
  const app = await bootApp(stage, dataDir);
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  const result: Json = { scenario: SCENARIO, port: PORT, stages: [], counts: null, latencyMs: [], heights: [], fade: [], replies: [], pass: {} };
  const log: string[] = [];
  try {
    const created = await post(app.base, '/api/wallet/create', { token: app.token, password: 'proof-password-1' });
    if (created.status !== 200) throw new Error(`wallet create refused: ${created.status} ${JSON.stringify(created.json)}`);
    // The terms card covers a fresh window (9.4); the finger that accepts it is this one.
    const terms = await post(app.base, '/api/terms/accept', { token: app.token });
    if (terms.status !== 200) throw new Error(`terms accept refused: ${terms.status} ${JSON.stringify(terms.json)}`);
    const page: Json = await browser.newPage({ viewport: { width: WIDTH, height: 860 }, deviceScaleFactor: 2, bypassCSP: true });
    page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}`));
    page.on('console', (msg: Json) => {
      if (msg.type() === 'error' || msg.type() === 'warning') log.push(`[console.${msg.type()}] ${msg.text()}`);
    });
    await page.goto(`${app.base}/?token=${app.token}`, { waitUntil: 'load' });
    /* The card's own stylesheet, until ui/index.html links it (node E's file; the request is in
       report-d.md). Loaded here so the fade the proof reads is the one that ships. */
    await page.addStyleTag({ url: `${app.base}/design/chatcard.css` });
    await page.waitForSelector('.agent-composer', { state: 'attached', timeout: 20_000 }).catch(() => undefined);

    const opened = await post(app.base, '/api/driver', { action: 'open', token: app.token });
    if (opened.status !== 200) throw new Error(`open refused: ${opened.status} ${JSON.stringify(opened.json)}`);
    await sleep(1500);
    const prompted = await post(app.base, '/api/driver', { action: 'prompt', text: scenario.userSays, token: app.token, chat: opened.json.id });
    if (prompted.status !== 200) throw new Error(`prompt refused: ${prompted.status} ${JSON.stringify(prompted.json)}`);
    const started = Date.now();

    /* The watch: the server's row every poll (the truth) and the window's card every poll
       (what a person sees), stamped, so every stage the card showed is on record with how
       long after the row moved it appeared. */
    let lastServer: Record<string, string> = {};
    let serverChangedAt: Record<string, number> = {};
    let lastWord: Record<string, string | null> = {};
    let lastHeight: Record<string, number> = {};
    let shots = 0;
    let done = false;
    while (Date.now() - started < DEADLINE_MS && !done) {
      const state = (await (await fetch(`${app.base}/api/state`)).json()) as Json;
      const now = Date.now();
      for (const row of (state.proposals as Json[]) ?? []) {
        const stage = String(row.view?.stage ?? row.status);
        if (lastServer[row.id] !== stage) {
          lastServer[row.id] = stage;
          serverChangedAt[row.id] = now;
          result.stages.push({ at: now - started, source: 'server', id: row.id, stage, label: row.view?.stageLabel ?? null });
        }
      }
      const seen = (await page.evaluate(PROBE)) as Json;
      const shown = Date.now();
      for (const [id, entry] of Object.entries(seen.cards as Record<string, Json>)) {
        if (lastWord[id] !== entry.word) {
          const lag = serverChangedAt[id] === undefined ? null : shown - serverChangedAt[id];
          result.stages.push({ at: shown - started, source: 'window', id, word: entry.word, copy: entry.copy, clock: entry.clock, hosts: entry.hosts, fade: entry.fade, animation: entry.animation, height: entry.height, open: entry.open, details: entry.details, lagMs: lag });
          if (lag !== null && lastWord[id] !== undefined) result.latencyMs.push(lag);
          if (lastWord[id] !== undefined) {
            result.heights.push({ from: lastHeight[id], to: entry.height, jump: Math.abs(entry.height - (lastHeight[id] ?? entry.height)) });
            result.fade.push({ word: entry.word, fade: entry.fade, animation: entry.animation });
          }
          lastWord[id] = entry.word;
          lastHeight[id] = entry.height;
          shots += 1;
          const name = `${String(shots).padStart(2, '0')}-${String(entry.word || 'no-word').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
          await shoot(page, id, path.join(OUT, `${name}.png`));
        } else if (Math.abs(entry.height - (lastHeight[id] ?? entry.height)) > 0) {
          result.heights.push({ from: lastHeight[id], to: entry.height, jump: Math.abs(entry.height - (lastHeight[id] ?? entry.height)), tick: true });
          lastHeight[id] = entry.height;
        }
      }
      const terminal = ((state.proposals as Json[]) ?? []).length > 0 && ((state.proposals as Json[]) ?? []).every((row: Json) => row.view?.terminal === true);
      if (terminal && Object.keys(seen.cards).length > 0 && Object.values(seen.cards as Record<string, Json>).every((c: Json) => c.word && /Confirmed|Failed|Declined|Refused|Refunded|Late/.test(c.word))) {
        // Give the receipts feed a moment to arrive, then read the final picture.
        await sleep(2500);
        done = true;
      }
      await sleep(POLL_MS);
    }

    const finalWide = (await page.evaluate(PROBE)) as Json;
    result.replies = finalWide.replies;
    /* The whole window at the end, the card scrolled into view, and the card open at its fold. */
    await page.evaluate(`(() => { const n = document.querySelector('.chat-card .tcard[data-card="move"]'); if (n) n.scrollIntoView({ block: 'center' }); })()`);
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, 'window.png') });
    await page.evaluate(`(() => { const b = document.querySelector('.tcard-details-head'); if (b) b.click(); })()`);
    await sleep(500);
    await page.evaluate(`(() => { const n = document.querySelector('.tcard-details'); if (n) n.scrollIntoView({ block: 'end' }); })()`);
    await sleep(300);
    for (const id of Object.keys(finalWide.cards)) await shoot(page, id, path.join(OUT, `final-${id.slice(0, 8)}-details-open.png`));

    result.counts = {
      width: WIDTH,
      chatCards: finalWide.chatCards,
      receipts: finalWide.receipts,
      perId: Object.fromEntries(Object.entries(finalWide.cards).map(([id, c]: [string, Json]) => [id, c.hosts])),
    };
    const ids = Object.keys(finalWide.cards);
    const words = result.stages.filter((s: Json) => s.source === 'window').map((s: Json) => s.word);
    const lags = result.latencyMs as number[];
    const jumps = (result.heights as Json[]).filter((h) => h.tick !== true).map((h) => h.jump as number);
    result.pass = {
      '5.1 one card per id': ids.length > 0 && ids.every((id) => finalWide.cards[id].hosts === 1) && finalWide.receipts === 0,
      '5.3 stage word changed with the fade': (result.fade as Json[]).length > 0 && (result.fade as Json[]).every((f) => /chatcard-fade-[ab] 0\.24s/.test(String(f.animation))),
      '5.3 no layout jump over 8 px': jumps.every((j) => j <= 8),
      '2.3 stage on screen under 500 ms': lags.length > 0 && lags.every((ms) => ms < 500),
      '5.4 only table words on the card': words.every((w: unknown) => typeof w === 'string' && !/[A-Z]{3,}_[A-Z]|SUCCESS|PROCESSING|KNOWN_DEPOSIT/.test(w)),
      stagesSeen: words,
      lagsMs: lags,
      heightJumps: jumps,
    };
    result.log = log.slice(0, 40);
    result.appOutputTail = app.output.join('').slice(-1500);
  } finally {
    await browser.close().catch(() => undefined);
    await app.stop();
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(OUT, 'card-proof.json'), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `card-proof ${SCENARIO} on ${PORT}`,
    `stages the card showed: ${(result.pass as Json).stagesSeen.join(' > ')}`,
    `cards per id at ${WIDTH}: ${JSON.stringify((result.counts as Json).perId)}, chat cards ${(result.counts as Json).chatCards}, receipt cards ${(result.counts as Json).receipts}`,
    `row to screen ms: ${(result.pass as Json).lagsMs.join(', ')}`,
    `height jumps px: ${(result.pass as Json).heightJumps.join(', ')}`,
    `fade: ${(result.fade as Json[]).map((f) => `${f.word}=${f.animation}`).join(' | ')}`,
    `replies: ${(result.replies as string[]).map((t) => JSON.stringify(t)).join(' | ')}`,
    ...Object.entries(result.pass as Record<string, unknown>).filter(([k]) => /^\d/.test(k)).map(([k, v]) => `${v === true ? 'PASS' : 'FAIL'} ${k}`),
    `written: ${OUT}`,
  ];
  console.log(lines.join('\n'));
  const failed = Object.entries(result.pass as Record<string, unknown>).some(([k, v]) => /^\d/.test(k) && v !== true);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(2);
});
