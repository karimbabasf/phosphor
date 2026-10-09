// The question about an agent started outside Phosphor, and the move cards such agents leave,
// proven in a real browser against a demo backend.
//
// Boots the app in demo mode on a free port with a throwaway HOME, data dir, keys and config, so
// the window opens on the first run; walks it to the main window; then plays the agents a person
// meets: the app's own chat after it read a stranger's text, which asks for a small move; a
// Cancel; an agent started in a terminal (it takes its seat with agent.secret and a key of its
// own) that asks for a small move too; a second one behind it; each put off with Ask each time;
// the first allowed again from its roster row; and a third one asking while Pro is up.
//
// At each state it shoots the window and reads what a picture cannot show: the line under each
// card's head, the Allow card's box against the balances and the conversation, the screen reader
// line, and with the freeze panel open, which element is on top at the centre of its Freeze key
// (elementFromPoint). The checks at the end are the UX review's findings 1, 2, 5, 8, 9, 10, 19
// and 20; a failed check ends the run with exit 1. PROOF_STRICT=0 shoots and reads without
// judging, for a picture of the code before a change.
//
// Fixture data only: temp directories, never the live wallet; every move is a demo deposit that
// waits for a click and is never approved. Run:
//   node scripts/agent-ask-proof.ts
// PROOF_VIEWPORT is the window, 1280x800 by default (the app's floor is 960x700). PROOF_OUT names
// the folder for the pictures (default scripts/scratch/agent-ask-proof/, docs/screenshots/agent-ask/
// with --docs). playwright-core is not a
// dependency of this repo; point PLAYWRIGHT_CORE at a copy, and without playwright's own
// Chromium installed, PROOF_BROWSER at a Chromium binary.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proofOut } from './proof-out.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/47c97c996798144b/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const SHOTS = proofOut('agent-ask-proof', 'agent-ask');
const STRICT = process.env.PROOF_STRICT !== '0';
const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.PROOF_VIEWPORT ?? '1280x800');
  if (!m) throw new Error('PROOF_VIEWPORT is WIDTHxHEIGHT, like 960x700');
  return { width: Number(m[1]), height: Number(m[2]) };
})();
const SIZE = `${VIEWPORT.width}`;
const PASSWORD = 'proof-password-1';

type Json = any;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (): string => crypto.randomBytes(32).toString('hex');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 && port !== 4177 ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
}

// ---------- the backend ----------

type Backend = { base: string; token: string; seat: string; root: string; dataDir: string; app: ChildProcess };
let backend: Backend | null = null;
const log: string[] = [];

/* The shell's own start: a fresh port, and the five lines it hands the backend on stdin (the
   window token, the seat secret among them). Everything it could write lives in one temp folder. */
async function startApp(): Promise<Backend> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-ask-proof-'));
  const dataDir = path.join(root, 'data');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const port = await freePort();
  const token = hex();
  const seat = hex();
  const app = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: root,
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_PORT: String(port),
      PHOSPHOR_DATA_DIR: dataDir,
      PHOSPHOR_KEYS: path.join(root, 'keys.json'),
      PHOSPHOR_CONFIG_DIR: path.join(root, 'config'),
      PHOSPHOR_NO_PARENT_WATCH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  app.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
  app.stdin?.end(`${token}\n${hex()}\n${seat}\n${hex()}\n${hex()}\n`);
  const base = `http://127.0.0.1:${port}`;
  backend = { base, token, seat, root, dataDir, app };
  const until = Date.now() + 40_000;
  while (Date.now() < until) {
    try {
      // Every read needs a credential since the read gate (src/http/read-gate.ts); this one carries the window's.
      const res = await fetch(`${base}/api/state`, { headers: { 'x-phosphor-token': token } });
      if (res.ok) return backend;
    } catch {
      // not listening yet
    }
    if (app.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`the demo backend did not come up:\n${log.join('')}`);
}

/* A backend writes its audit tip as it shuts down, so its folder goes once it has exited. */
async function stopAndWait(): Promise<void> {
  const b = backend;
  if (b === null) return;
  if (b.app.exitCode === null && b.app.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      b.app.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      b.app.kill('SIGTERM');
    });
  }
  stopAll();
}

function stopAll(): void {
  const b = backend;
  if (b === null) return;
  if (b.app.exitCode === null) {
    try {
      b.app.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  try {
    fs.rmSync(b.root, { recursive: true, force: true });
  } catch {
    // a temp dir that would not go is not a failure of the proof
  }
}

async function mcp(body: Record<string, unknown>): Promise<Json> {
  const b = backend!;
  const res = await fetch(`${b.base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: b.base },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, ...JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

/* An agent started outside Phosphor: the seat secret any program of this user can read, and a
   key of its own, which is what makes it one the person can allow. */
type Outside = { session: string; client: string; secret: string; key: string };
async function outsider(client: string): Promise<Outside> {
  const agent = { session: `proof-${client}`, client, secret: fs.readFileSync(path.join(backend!.dataDir, 'agent.secret'), 'utf8').trim(), key: hex() };
  const hello = await mcp({ op: 'hello', ...agent });
  if (hello.ok !== true) throw new Error(`${client} could not take a seat: ${JSON.stringify(hello)}`);
  // The card asks about an agent at work, so the proof's agent calls once, as a real one would.
  await mcp({ op: 'read', tool: 'policy_show', ...agent, args: {} });
  return agent;
}

async function deposit(who: Record<string, unknown>, amount: number): Promise<Json> {
  return mcp({ op: 'propose', kind: 'hl_deposit', ...who, params: { symbol: 'USDC', amount } });
}

// ---------- the page ----------

const H1 = '(function(){var s=document.getElementById("screen-firstrun");if(!s||s.hidden||getComputedStyle(s).display==="none")return null;var h=s.querySelector(".screen-body h1")||s.querySelector("h1");return h?h.textContent:null})()';

/* The two functions below run in the page. page.evaluate sends a function's source and its
   argument apart, so what the page showed (the words) and what this script chose (the password, a
   key's label) reach it as values and never become code. */

// The first run's fields, filled in order with `values`, or each by its number from `byNumber`.
function fillFields(arg: { values?: string[]; byNumber?: string[] }): void {
  const fields: Json[] = Array.from((globalThis as Json).document.querySelectorAll('#screen-firstrun .screen-body input.input'));
  fields.forEach((field, i) => {
    const value = arg.byNumber === undefined ? arg.values?.[i] : arg.byNumber[Number(field.dataset.index)];
    if (value !== undefined) field.value = value;
  });
  fields.forEach((field) => field.dispatchEvent(new (globalThis as Json).Event('input', { bubbles: true })));
}

// The last shown, enabled key in `scope` whose words match the label, pressed.
function pressKey(arg: { scope: string; source: string; flags: string }): boolean {
  const label = new RegExp(arg.source, arg.flags);
  const keys: Json[] = Array.from((globalThis as Json).document.querySelectorAll(arg.scope));
  const shown = keys.filter((b) => b.offsetParent !== null && !b.disabled && label.test((b.querySelector('.btn-label') || b).textContent.trim()));
  if (!shown.length) return false;
  shown[shown.length - 1].click();
  return true;
}

/* The first run to the main window, each step by its own fields and its main key: the invite step
   is skipped, the password set, the words read off the page and typed back by their number. */
async function firstRun(page: Json): Promise<void> {
  await page.waitForSelector('#screen-firstrun .firstrun-welcome', { timeout: 20_000 });
  await page.evaluate('document.fonts.ready');
  await sleep(1500);
  await page.click('#screen-firstrun .firstrun-welcome .btn-primary');
  await sleep(700);
  let words: string[] = [];
  const trace: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const title = (await page.evaluate(H1)) as string | null;
    trace.push(String(title));
    if (title === null) return;
    if (/invite code\?$/.test(title)) {
      await page.evaluate(`(function(){var b=Array.from(document.querySelectorAll('#screen-firstrun .screen-actions button')).filter(function(x){return x.textContent.trim()==='Skip'})[0];if(b)b.click()})()`);
      await sleep(900);
      continue;
    }
    if (title === 'Set a password') {
      await page.evaluate(fillFields, { values: [PASSWORD, PASSWORD] });
    } else if (title === 'Save your recovery words') {
      words = (await page.evaluate('Array.from(document.querySelectorAll("#screen-firstrun .screen-body .word-text")).map(function (n) { return n.textContent; })')) as string[];
    } else if (title === 'Prove it') {
      await page.evaluate(fillFields, { byNumber: words });
    }
    await page.evaluate(`(function(){document.querySelectorAll('#screen-firstrun .screen-body input[type="checkbox"]').forEach(function(c){if(!c.checked)c.click()})})()`);
    await sleep(150);
    await page.evaluate(`(function(){var s=document.getElementById('screen-firstrun');var bs=Array.from(s.querySelectorAll('.screen-body .btn-primary, .screen-actions .btn-lg, .screen-actions .btn-primary')).filter(function(b){return !b.hidden&&!b.disabled&&b.offsetParent!==null});var b=bs[bs.length-1];if(b)b.click()})()`);
    await sleep(900);
  }
  throw new Error('the first run did not finish: ' + trace.join(' | '));
}

/* What the picture cannot show. The Allow card's box and where it sits; the balances' and the
   conversation's boxes; each move card's state word and the line under its head; the screen
   reader's line; and, when the freeze panel is open, what is on top at its Freeze key's centre. */
const READ = `(function () {
  function box(el) { if (!el) return null; var r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  function shown(el) { return !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; }
  var ask = document.querySelector('.agent-ask');
  var askShown = shown(ask);
  function label(b) { return (b.querySelector('.btn-label') || b).textContent.trim(); }
  var keys = askShown ? Array.prototype.slice.call(ask.querySelectorAll('button')).map(label) : [];
  var panel = document.querySelector('.brake-panel');
  var freeze = null;
  if (shown(panel)) {
    var go = panel.querySelector('[data-role="brake-go"]');
    var r = go.getBoundingClientRect();
    var top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    freeze = { key: go.textContent.trim(), onTop: !!top && (top === go || go.contains(top)), hit: top ? (top.closest('.agent-ask') ? 'the Allow card' : (top.closest('.brake-panel') ? 'the freeze panel' : String(top.className))) : null };
  }
  var cards = Array.prototype.slice.call(document.querySelectorAll('.mcard')).filter(shown).map(function (c) {
    var line = c.querySelector('.mcard-line');
    return { state: c.getAttribute('data-state'), line: shown(line) ? line.textContent.trim() : '', text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400) };
  });
  var live = Array.prototype.slice.call(document.querySelectorAll('.agent-ask-live')).map(function (n) { return n.textContent; });
  var roster = Array.prototype.slice.call(document.querySelectorAll('.agent-client')).filter(shown).map(function (row) {
    return { text: row.innerText.replace(/\\s+/g, ' ').trim(), keys: Array.prototype.slice.call(row.querySelectorAll('button')).filter(shown).map(label) };
  });
  return {
    view: document.body.getAttribute('data-view'),
    ask: askShown ? { box: box(ask), text: ask.innerText.replace(/\\s+/g, ' ').trim(), keys: keys, inConversation: !!ask.closest('.conversation'), fixed: getComputedStyle(ask).position === 'fixed' } : null,
    world: box(document.querySelector('.world')),
    conversation: box(document.querySelector('.conversation')),
    freeze: freeze,
    cards: cards,
    live: live,
    roster: roster
  };
})()`;

const results: Record<string, Json> = {};
const shots: string[] = [];

async function shoot(page: Json, name: string): Promise<Json> {
  const file = path.join(SHOTS, `${name}-${SIZE}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  const read = await page.evaluate(READ);
  results[name] = read;
  return read;
}

async function press(page: Json, scope: string, label: RegExp): Promise<boolean> {
  // A key's words are its label: a key that was pending also holds its pending words.
  return page.evaluate(pressKey, { scope, source: label.source, flags: label.flags });
}

async function waitFor(page: Json, expression: string, timeout = 15_000): Promise<boolean> {
  try {
    await page.waitForFunction(expression, undefined, { timeout });
    return true;
  } catch {
    return false;
  }
}

// The words as a string literal for the page's code, with the characters that could end the script
// or a line written as escapes. The literal still reads as the same words.
const asLiteral = (words: string): string =>
  JSON.stringify(words).replace(/[<>/\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// The card names an agent it knows plainly ("Claude Code wants to use Phosphor") and any other by
// the words it gave ("It calls itself codex").
const ASKS_ABOUT = (words: string): string =>
  `(function(){var a=document.querySelector('.agent-ask');return !!a&&!a.hidden&&a.getClientRects().length>0&&a.innerText.indexOf(${asLiteral(words)})>=0})()`;

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  // Untyped on purpose: playwright-core is not a dependency of this repo.
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    const b = await startApp();
    // The page's own CSP refuses the string functions playwright waits on; the proof's, not the app's.
    const page: Json = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, bypassCSP: true });
    page.on('pageerror', (err: unknown) => log.push(`[page] ${String(err)}\n`));
    page.on('console', (msg: Json) => {
      if (msg.type() === 'error') log.push(`[console.error] ${msg.text()}\n`);
    });
    await page.goto(`${b.base}/?token=${b.token}`, { waitUntil: 'load' });
    await firstRun(page);
    await sleep(1500);

    // 1. The app's own chat reads a stranger's text (a chain read marks its seat), then asks for a
    //    $20 move, under the $100 that runs alone: it waits, and its card says why on its face.
    const chat = { session: 'proof-chat', client: 'phosphor-mcp', secret: b.seat };
    await mcp({ op: 'hello', ...chat });
    results.read = (await mcp({ op: 'read', tool: 'chain_address', ...chat, args: { network: 'ethereum', address: '0x000000000000000000000000000000000000dEaD' } })).status;
    results.webReadMove = (await deposit(chat, 20)).status;
    await waitFor(page, `document.body.innerText.indexOf('Needs your OK') >= 0`);
    await sleep(1200);
    await shoot(page, 'card-web-read');

    // 2. Cancel: the card says no, and its Details say when the person said it.
    await press(page, '.tcard button', /^Cancel$/);
    await waitFor(page, `document.body.innerText.indexOf('You said no') >= 0`);
    await sleep(1200);
    await press(page, '.tcard button', /^Details$/);
    await sleep(1000);
    await shoot(page, 'card-cancelled-details');
    await press(page, '.tcard button', /^Details$/);
    await sleep(600);

    // 3. An agent started in a terminal takes its seat, and asks for a $25 move.
    const first = await outsider('claude-code');
    await waitFor(page, ASKS_ABOUT('Claude Code wants to use Phosphor'));
    await sleep(1200);
    results.outsideMove = (await deposit(first, 25)).status;
    await sleep(2500);
    await shoot(page, 'allow-card');

    // 4. With the card up, the freeze glyph opens its panel: the Freeze key must be on top.
    await page.click('#btn-freeze');
    await sleep(1000);
    await shoot(page, 'allow-card-freeze-open');
    await page.keyboard.press('Escape');
    await sleep(700);

    // 5. A second agent behind it: the card says one more waits.
    const second = await outsider('codex');
    await sleep(2000);
    await shoot(page, 'allow-card-two-waiting');

    // 6. Ask each time (Not now before the change) on the first: the second takes its place.
    await sleep(700);
    results.putOffFirst = await press(page, '.agent-ask button', /^(Ask each time|Not now)$/);
    await waitFor(page, ASKS_ABOUT('It calls itself codex'));
    await sleep(250);
    await shoot(page, 'allow-card-next');
    await sleep(1200);
    results.putOffSecond = await press(page, '.agent-ask button', /^(Ask each time|Not now)$/);
    await sleep(1500);
    await shoot(page, 'roster-after-ask-each-time');

    // 7. The first is allowed after all: its roster row's Change brings the card back, then Allow.
    results.reopened = await page.evaluate(`(function(){var row=Array.from(document.querySelectorAll('.agent-client')).filter(function(r){var n=r.querySelector('.agent-client-name');return n&&n.textContent.indexOf('Claude Code,')===0})[0];var b=row?row.querySelector('.agent-client-change'):null;if(!b||b.disabled)return false;b.click();return true})()`);
    await waitFor(page, ASKS_ABOUT('Claude Code wants to use Phosphor'), 5_000);
    await sleep(1000);
    await shoot(page, 'allow-card-reopened');
    results.allowed = await press(page, '.agent-ask button', /^Allow$/);
    await sleep(1800);
    await shoot(page, 'roster-after-allow');

    // 8. A third agent asks while Pro is up, and the freeze panel opens over the world.
    await press(page, '.tabs .tab', /^Pro$/);
    await sleep(1200);
    await outsider('grok');
    await waitFor(page, ASKS_ABOUT('It calls itself grok'));
    await sleep(1500);
    await shoot(page, 'allow-card-pro');
    await page.click('#btn-freeze');
    await sleep(1000);
    await shoot(page, 'allow-card-pro-freeze-open');
    await page.keyboard.press('Escape');
    await sleep(500);
    results.agents = second.session;
  } finally {
    await browser.close();
  }

  // ---------- the checks ----------
  const checks: Array<[string, boolean, string]> = [];
  const check = (name: string, ok: boolean, saw: unknown): void => {
    checks.push([name, ok, JSON.stringify(saw)]);
  };
  const r = results;
  const cardsWith = (state: Json, words: string): boolean => (state?.cards ?? []).some((c: Json) => String(c.text).includes(words));
  const lineSays = (state: Json, words: string): boolean => (state?.cards ?? []).some((c: Json) => String(c.line).includes(words));
  for (const name of ['allow-card-freeze-open', 'allow-card-pro-freeze-open']) {
    check(`F1 the Freeze key is on top (${name})`, r[name]?.freeze?.onTop === true, r[name]?.freeze);
  }
  for (const name of ['allow-card', 'allow-card-two-waiting', 'allow-card-pro']) {
    const s = r[name];
    check(`F8 the Allow card sits in the conversation, in its flow (${name})`, s?.ask?.inConversation === true && s?.ask?.fixed === false, s?.ask && { inConversation: s.ask.inConversation, fixed: s.ask.fixed, box: s.ask.box });
    const a = s?.ask?.box;
    const w = s?.world;
    const over = a && w ? Math.max(0, Math.min(a.x + a.w, w.x + w.w) - Math.max(a.x, w.x)) * Math.max(0, Math.min(a.y + a.h, w.y + w.h) - Math.max(a.y, w.y)) : -1;
    check(`F8 the Allow card covers none of the balances (${name})`, over === 0, { ask: a, world: w });
  }
  check('F2 a small move from a chat that read outside text says why on its face', lineSays(r['card-web-read'], 'This chat read text from outside Phosphor, so this move waits for your OK.'), r['card-web-read']?.cards);
  check('F2 a small move from an agent started outside says why on its face', lineSays(r['allow-card'], 'This agent was started outside Phosphor and is not allowed yet'), r['allow-card']?.cards);
  check('F5 a cancelled card says when you said no, never that you approved it', cardsWith(r['card-cancelled-details'], 'You said no at') && !cardsWith(r['card-cancelled-details'], 'You approved it at'), r['card-cancelled-details']?.cards);
  // The roster names a client the card knows as the card does ("Claude Code", not "claude-code").
  check('F9 the harmless answer is Ask each time', (r['allow-card']?.ask?.keys ?? []).includes('Ask each time'), r['allow-card']?.ask?.keys);
  check('F9 a put-off agent keeps a way back on its roster row', (r['roster-after-ask-each-time']?.roster ?? []).some((row: Json) => row.text.includes('Claude Code') && row.keys.includes('Change')), r['roster-after-ask-each-time']?.roster);
  check('F9 the roster key asks again with the whole card', String(r['allow-card-reopened']?.ask?.text ?? '').includes('Claude Code wants to use Phosphor'), r['allow-card-reopened']?.ask?.text);
  check('F9 once allowed, the row says it can ask', (r['roster-after-allow']?.roster ?? []).some((row: Json) => row.text.startsWith('Claude Code, can ask') && !row.keys.includes('Change')), r['roster-after-allow']?.roster);
  check('F10 one more agent waiting is said on the card', String(r['allow-card-two-waiting']?.ask?.text ?? '').includes('1 more agent is waiting'), r['allow-card-two-waiting']?.ask?.text);
  check('F10 the next agent takes the card', String(r['allow-card-next']?.ask?.text ?? '').includes('It calls itself codex'), r['allow-card-next']?.ask?.text);
  check('F19 the card says what Allow does and does not do', String(r['allow-card']?.ask?.text ?? '').includes("Phosphor's own chat works the same way.") && String(r['allow-card']?.ask?.text ?? '').includes('Moves it already asked for still wait for your OK.'), r['allow-card']?.ask?.text);
  check('F20 a screen reader hears that an agent asks', (r['allow-card']?.live ?? []).some((t: string) => t.includes('Claude Code wants to use Phosphor.')), r['allow-card']?.live);
  const noise = log.filter((l) => l.startsWith('[page]') || l.startsWith('[console'));
  check('the page threw nothing', noise.length === 0, noise.slice(0, 5));

  fs.writeFileSync(path.join(SHOTS, `proof-${SIZE}.json`), JSON.stringify({ results, checks }, null, 2));
  for (const [name, ok, saw] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      saw ${saw.slice(0, 600)}`}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`proof: ${shots.length} states shot at ${VIEWPORT.width}x${VIEWPORT.height} into ${SHOTS}; ${checks.length - failed} of ${checks.length} checks pass`);
  if (failed > 0 && STRICT) process.exitCode = 1;
}

process.on('exit', stopAll);
process.on('SIGINT', () => {
  stopAll();
  process.exit(1);
});

main()
  .then(async () => {
    await stopAndWait();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    console.error(log.slice(-40).join(''));
    await stopAndWait();
    process.exit(1);
  });
