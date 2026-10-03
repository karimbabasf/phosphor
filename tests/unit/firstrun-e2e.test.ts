// The password first run end to end: the real first-run, invite, terms and lock screens and the
// window's own net, api and stream code (ui/), over a DOM small enough to read, against the real
// backend (src/server.ts) on a loopback port with a temp data directory. Create, the backup proof,
// the idle lock, the screen lock, the unlock, the read again and the invite claim are the app's own
// routes and keystore; the invite code pays from the fake chain in helpers/invite-world.ts. What
// stands in: the shell's stream handlers (copied from ui/screens/shell.js), the address picker,
// the toasts, and the clock, which is node:test's mocked Date, so a long wait is real minutes on
// the app's clock and the lock's fifteen-second tick is called the way its interval would.
//
// The unit suites stub /api/vault/backup-proven in the window and call the route only after a
// reveal, so a create that left nothing to prove against shipped with every test green; the
// release proof on the built app found a person stuck on Prove it. These run the whole path.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createContext, runInContext } from 'node:vm';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { MAX_AGENTS, createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { createKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { IDLE_LOCK_MS, TICK_MS, createSession } from '../../src/keystore/session.ts';
import { lockReasonFor } from '../../src/keystore/lock-reason.ts';
import { PHRASE_PROOF_MS } from '../../src/vault/phrase-proof.ts';
import type { AppConfig, LedgerSnapshot } from '../../src/types.ts';
import { stubView } from '../fixtures/view.ts';
import { CODE, freshWorld, oneclickOf, relayOf, verifierOf } from './helpers/invite-world.ts';
import type { World } from './helpers/invite-world.ts';
import { TEST_QUOTE_KEY } from './helpers/signed-quote.ts';
import { tempDir } from './helpers/tmp.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const PASSWORD = 'a long enough password';
const UI = [
  'core/links.js',
  'core/dom.js',
  'core/state.js',
  'core/net.js',
  'core/api.js',
  'core/events.js',
  'core/invite.js',
  'screens/invite.js',
  'screens/terms.js',
  'screens/firstrun.js',
  'screens/lock.js',
].map((file) => [file, fs.readFileSync(new URL(`../../ui/${file}`, import.meta.url), 'utf8')] as const);

/* ---------- the backend ---------- */

type Backend = {
  url: string;
  token: string;
  world: World;
  session: ReturnType<typeof createSession>;
  keystore: ReturnType<typeof createKeystore>;
  server: ReturnType<typeof createServer>;
  dataDir: string;
};

function snapshot(): LedgerSnapshot {
  return { mode: 'live', fetchedAt: new Date().toISOString(), prices: {} };
}

async function boot(): Promise<Backend> {
  const dataDir = tempDir('phosphor-firstrun-e2e-');
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'live', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  const audit = createAudit(dataDir);
  const world = freshWorld();
  /* The lock's clock as main.ts builds it, at the vault's default five minutes: a lock it takes is
     noted, logged and announced with a state frame. */
  let announce = (): void => {};
  const session = createSession({
    isUnlocked: () => keystore.isUnlocked(),
    idleMs: IDLE_LOCK_MS,
    lock: (reason) => {
      if (keystore.lock()) lockReasonFor(keystore).note(reason);
      audit.append('app_start', `the wallet locked after ${IDLE_LOCK_MS / 60_000} minutes with nobody at the window`, { reason });
      announce();
    },
  });
  const cfg: AppConfig = { mode: 'live', port: 0, addresses: {}, candleProducts: ['BTC-USD'], dataDir, keysPath };
  const server = createServer({
    cfg,
    audit,
    store: createStore(dataDir),
    keystore,
    session,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => snapshot() },
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals: {
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
      proposeSend: async () => { throw new Error('unused'); },
      proposeTrade: async () => { throw new Error('unused'); },
      proposeTradeChange: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      view: (p) => stubView(p),
      markStalled: () => 0,
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: async () => { throw new Error('unused'); },
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      acknowledge: () => Promise.reject(new Error('not wired in this stub')),
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents: createAgents(Date.now, MAX_AGENTS, { secret: 's'.repeat(64) }),
    getView: () => 'basic',
    setView: () => {},
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      plan: () => ({ ok: false as const, error: 'no venue in this test' }),
      meta: () => null,
      mark: () => null,
      free: () => null,
      onUpdate: () => {},
      stop: () => {},
    },
    intentsReceive: async () => ({ account: null, verified: false, tampered: false, networks: [] }),
    invite: {
      verifier: verifierOf(world),
      relay: relayOf(world),
      oneclick: oneclickOf(world),
      quoteKey: TEST_QUOTE_KEY,
      now: () => world.mac,
      sleep: async (ms) => {
        world.mac += ms;
        world.chain += ms;
      },
    },
  });
  announce = () => server.broadcastState();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, token, world, session, keystore, server, dataDir };
}

/* What the shell does when the screen locks: the window token, the idle flag and its reason
   (src-tauri/src/session_watch.rs). */
async function screenLock(b: Backend): Promise<void> {
  const res = await fetch(`${b.url}/api/lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: b.url },
    body: JSON.stringify({ token: b.token, whenIdle: true, reason: 'the screen locked' }),
  });
  assert.equal(res.status, 200);
}

/* Minutes on the app's clock with nobody at the window, in the session's own fifteen-second ticks,
   so the idle lock lands where its interval would land it. */
function away(b: Backend, minutes: number): void {
  for (let gone = 0; gone < minutes * 60_000; gone += TICK_MS) {
    mock.timers.tick(TICK_MS);
    b.session.tick();
  }
}

/* ---------- a DOM small enough to read ---------- */

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(event: Any) => void>> = {};
  let ownText = '';
  const node: Any = {
    tagName: tagName.toUpperCase(),
    className: '',
    hidden: false,
    disabled: false,
    checked: false,
    type: '',
    name: '',
    value: '',
    id: '',
    placeholder: '',
    tabIndex: 0,
    inert: false,
    offsetTop: 0,
    offsetLeft: 0,
    offsetWidth: 480,
    dataset: {} as Record<string, string>,
    style: { setProperty(name: string, value: string) { (node.style as Any)[name] = value; } } as Any,
    childNodes: [] as Any[],
    parentNode: null as unknown as Any,
    get textContent(): string {
      return node.childNodes.length ? node.childNodes.map((c: Any) => c.textContent).join('') : ownText;
    },
    set textContent(value: string) {
      ownText = String(value);
      for (const child of node.childNodes) child.parentNode = null;
      node.childNodes = [];
    },
    get firstChild() { return node.childNodes[0] ?? null; },
    get children() { return node.childNodes; },
    appendChild(child: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    insertBefore(child: Any, before: Any | null) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      const at = before === null ? node.childNodes.length : node.childNodes.indexOf(before);
      node.childNodes.splice(at < 0 ? node.childNodes.length : at, 0, child);
      return child;
    },
    removeChild(child: Any) {
      const at = node.childNodes.indexOf(child);
      if (at >= 0) node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    remove() { node.parentNode?.removeChild(node); },
    setAttribute(name: string, value: string) { attrs[name] = String(value); },
    getAttribute(name: string) { return name in attrs ? attrs[name] : null; },
    hasAttribute(name: string) { return name in attrs; },
    removeAttribute(name: string) { delete attrs[name]; },
    addEventListener(type: string, fn: (event: Any) => void) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type: string, event: Any = {}) {
      for (const fn of listeners[type] ?? []) fn(Object.assign({ target: node, currentTarget: node, preventDefault() {} }, event));
    },
    click() { node.dispatch('click'); },
    focus() { node.focused = true; },
    blur() { node.focused = false; },
    querySelector(selector: string) { return find(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return find(node, selector); },
    getBoundingClientRect() { return { top: 0, left: 0, width: 480, height: 40, bottom: 40, right: 480 }; },
    getClientRects() { return [1]; },
  };
  return node;
}

function matches(node: Any, selector: string): boolean {
  const parts = selector.trim().match(/^([a-z][a-z0-9]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!parts) return false;
  const [, tag, classes, attrsPart] = parts;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const cls of classes.split('.').filter(Boolean)) {
    if (!String(node.className).split(' ').includes(cls)) return false;
  }
  for (const raw of attrsPart.match(/\[[^\]]+\]/g) ?? []) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(raw);
    if (!m) return false;
    const value = m[1] === 'type' ? node.type : node.getAttribute(m[1]);
    if (m[2] === undefined ? value === null : value !== m[2]) return false;
  }
  return true;
}

function find(root: Any, selector: string): Any[] {
  const out: Any[] = [];
  const wanted = selector.split(',').map((s) => s.trim());
  const walk = (n: Any): void => {
    for (const child of n.childNodes) {
      if (wanted.some((w) => matches(child, w))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/* Every text a person can read: what is not hidden, and not inside something hidden. */
function visibleText(node: Any): string {
  const out: string[] = [];
  const walk = (n: Any): void => {
    if (n.hidden) return;
    if (n.childNodes.length === 0) {
      if (n.textContent !== '') out.push(n.textContent);
      return;
    }
    for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return out.join('\n');
}

/* ---------- the window ---------- */

type Window = {
  sandbox: Any;
  screen: Any;
  lock: Any;
  heard: string[];
  read: Array<{ path: string; text: string }>;
  close: () => void;
};

/* The window's one stream, as a browser's EventSource hands it to ui/core/events.js: a GET held
   open, every data frame to onmessage, and onerror when it ends without being closed. */
function streamClass(base: string, heard: string[], open: Array<{ close(): void }>): Any {
  return class {
    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    private stop = new AbortController();
    constructor(url: string) {
      this.url = url;
      open.push(this);
      void this.run(base + url);
    }
    private async run(full: string): Promise<void> {
      try {
        const res = await fetch(full, { headers: { accept: 'text/event-stream' }, signal: this.stop.signal });
        if (!res.ok || res.body === null) throw new Error(`the stream answered ${res.status}`);
        this.readyState = 1;
        this.onopen?.();
        const reader = res.body.getReader();
        const text = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += text.decode(value, { stream: true });
          for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (data === '') continue;
            heard.push(data);
            this.onmessage?.({ data });
          }
        }
      } catch {
        // closed by the window, or by the test at its end
      }
      if (this.readyState !== 2) {
        this.readyState = 2;
        this.onerror?.();
      }
    }
    close(): void {
      this.readyState = 2;
      this.stop.abort();
    }
  };
}

function openWindow(b: Backend): Window {
  const nodes: Record<string, Any> = {};
  for (const id of ['page', 'screen-lock', 'screen-firstrun', 'screen-terms']) {
    nodes[id] = makeNode('div');
    nodes[id].id = id;
    nodes[id].hidden = id !== 'page';
  }
  const body = makeNode('body');
  for (const id of ['page', 'screen-lock', 'screen-firstrun', 'screen-terms']) body.appendChild(nodes[id]);
  const heard: string[] = [];
  const read: Array<{ path: string; text: string }> = [];
  const streams: Array<{ close(): void }> = [];
  // Set at the end, when the test takes the backend away under a read still on its way.
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const doc: Any = {
    body,
    head: makeNode('head'),
    documentElement: makeNode('html'),
    readyState: 'complete',
    createElement: makeNode,
    createTextNode: (text: string) => { const n = makeNode('#text'); n.textContent = text; return n; },
    getElementById: (id: string) => nodes[id] ?? null,
    querySelector: (selector: string) => find(body, selector)[0] ?? null,
    querySelectorAll: (selector: string) => find(body, selector),
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox: Any = {
    console,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Promise,
    document: doc,
    navigator: {},
    location: { search: '', pathname: '/', hash: '', origin: b.url },
    history: { replaceState() {} },
    innerHeight: 800,
    __PHOSPHOR_TOKEN__: b.token,
    setTimeout: (fn: () => void, ms?: number) => {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms ?? 0);
      timers.add(id);
      return id;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => { clearTimeout(id); timers.delete(id); },
    setInterval: (fn: () => void, ms?: number) => {
      const id = setInterval(fn, ms ?? 0);
      intervals.add(id);
      return id;
    },
    clearInterval: (id: ReturnType<typeof setInterval>) => { clearInterval(id); intervals.delete(id); },
    requestAnimationFrame: (fn: (now: number) => void) => { fn(0); return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: (n: Any) => ({ overflowY: (n && n.style && n.style.overflowY) || 'visible' }),
    /* The page's fetch is this app's own origin: relative paths, and the Origin header a browser
       puts on them. Every answer is kept, to check what came back. */
    fetch: async (url: string, init: Any = {}) => {
      const res = await fetch(b.url + url, { ...init, headers: { ...(init.headers ?? {}), origin: b.url } });
      const copy = res.clone();
      void copy.text().then((text) => read.push({ path: url, text }), () => {});
      return res;
    },
  };
  sandbox.window = sandbox;
  sandbox.EventSource = streamClass(b.url, heard, streams);
  sandbox.PhosphorMotion = { reduced: () => true };
  sandbox.PhosphorToast = { show() {} };
  sandbox.PhosphorNetPick = { render: (host: Any) => { host.appendChild(makeNode('div')); return { destroy() {} }; } };
  createContext(sandbox);

  /* The shell's half (ui/screens/shell.js setPending, refresh and wireStream), which this test does
     not load whole: the pending face of a button, the state read, and the frames that move it. */
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean) {
      button.disabled = !!pending;
      if (pending) button.dataset.pending = 'true';
      else delete button.dataset.pending;
    },
    refresh() {
      const store = sandbox.PhosphorState;
      return sandbox.PhosphorApi.state({})
        .then((result: Any) => {
          if (!result.fresh && store.loaded()) return;
          store.put(result.data);
        })
        .catch((err: unknown) => { if (!closed) console.error('[shell] state', err); });
    },
    setView() {},
    view: () => 'basic',
  };
  for (const [file, source] of UI) runInContext(source, sandbox, { filename: `ui/${file}` });

  const events = sandbox.PhosphorEvents;
  const store = sandbox.PhosphorState;
  sandbox.PhosphorInvite.boot();
  sandbox.PhosphorFirstRun.boot();
  sandbox.PhosphorTerms.boot();
  sandbox.PhosphorLock.boot();
  events.on('state', () => { void sandbox.PhosphorShell.refresh(); });
  events.on('reattach', () => { void sandbox.PhosphorShell.refresh(); });
  events.on('lock', (frame: Any) => {
    const state = store.get() || {};
    if (frame && frame.state) store.put(Object.assign({}, state, { lock: { state: frame.state, idleLocksInSec: null } }));
  });
  events.start();
  void sandbox.PhosphorShell.refresh();

  return {
    sandbox,
    screen: nodes['screen-firstrun'],
    lock: nodes['screen-lock'],
    heard,
    read,
    close: () => {
      closed = true;
      for (const stream of streams) stream.close();
      for (const id of timers) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
    },
  };
}

/* ---------- driving it ---------- */

async function until(done: () => boolean, why: string | (() => string), capMs = 8_000): Promise<void> {
  const stop = performance.now() + capMs;
  while (!done()) {
    if (performance.now() > stop) throw new Error(typeof why === 'string' ? why : why());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const title = (w: Window): string => (find(w.screen, 'h1')[0] ?? { textContent: '' }).textContent;
const button = (root: Any, label: string): Any => find(root, 'button').find((n: Any) => !n.hidden && n.textContent === label);
const primary = (w: Window): Any => {
  const row = find(w.screen, '.screen-actions')[0];
  return row.childNodes[row.childNodes.length - 1];
};

async function onStep(w: Window, name: string): Promise<void> {
  const said = (): string => find(w.screen, '.firstrun-error').filter((n: Any) => !n.hidden).map((n: Any) => n.textContent).join(' ');
  await until(() => title(w) === name, () => `the first run never reached "${name}"; it is on "${title(w)}", saying "${said()}"`);
}

async function press(w: Window, label: string, next: string): Promise<void> {
  const key = button(w.screen, label);
  assert.ok(key, `no ${label} on "${title(w)}"`);
  await until(() => !key.disabled, `${label} on "${title(w)}" stayed disabled`);
  key.click();
  await onStep(w, next);
}

/* Welcome, the terms, a good invite code, a new wallet, a password, and its words on screen. */
async function toWords(w: Window): Promise<string[]> {
  await onStep(w, 'Welcome to Phosphor');
  await press(w, 'Get started', 'Before you start');
  await press(w, 'Accept and continue', 'Have an invite code?');
  const code = find(w.screen, 'input.invite-input')[0];
  code.value = CODE;
  code.dispatch('input');
  code.dispatch('paste');
  await until(() => visibleText(w.screen).includes('waiting for you'), `the code was not checked: ${visibleText(w.screen)}`);
  await press(w, 'Continue', 'Create or bring a wallet');
  await press(w, 'Continue', 'Set a password');
  for (const field of find(w.screen, 'input.input')) field.value = PASSWORD;
  await press(w, 'Continue', 'Save your recovery words');
  const words = find(w.screen, '.word-text').map((n: Any) => n.textContent as string);
  assert.equal(words.length, 12);
  return words;
}

/* Written down: the box ticked, Continue, and the three it asks for typed in from the copy. */
async function toProve(w: Window): Promise<void> {
  const box = find(w.screen, 'input[type="checkbox"]')[0];
  box.checked = true;
  box.dispatch('change');
  await press(w, 'Continue', 'Prove it');
}

function typeBack(w: Window, words: string[], wrong = false): void {
  for (const field of find(w.screen, 'input.input')) field.value = wrong ? 'notaword' : words[Number(field.dataset.index)];
}

/* The lock card over the first run, and the password typed into it the way a person would. */
async function unlockThroughCard(w: Window, says: string): Promise<void> {
  await until(() => !w.lock.hidden && find(w.lock, 'form').length === 1, 'the lock card never came up over the first run');
  await until(() => visibleText(w.lock).includes(says), `the lock card does not say "${says}": ${visibleText(w.lock)}`);
  find(w.lock, 'input[type="password"]')[0].value = PASSWORD;
  find(w.lock, 'form')[0].dispatch('submit');
  await until(() => w.lock.hidden, `the lock card stayed up after the right password: ${visibleText(w.lock)}`);
}

async function claimLanded(b: Backend, w: Window, wallet: string): Promise<void> {
  await b.server.invites.idle();
  assert.equal(b.world.balances.get(wallet), 5_000_000n, 'the invite money is not in the new wallet');
  await until(() => visibleText(w.screen).includes('is in your wallet'), `the addresses step never said the money landed: ${visibleText(w.screen)}`);
}

/* The recovery phrase is on two answers only: the create that made it and a reveal the window
   spent. It is in no other answer, no frame of the stream and no line of the log. */
async function phraseStaysPut(b: Backend, w: Window, words: string[]): Promise<void> {
  const phrase = words.join(' ');
  const quoted = JSON.stringify(words);
  for (const { path: route, text } of w.read) {
    if (route === '/api/wallet/create' || route.startsWith('/api/wallet/reveal/')) continue;
    assert.ok(!text.includes(phrase) && !text.includes(quoted), `the phrase came back on ${route}`);
  }
  for (const frame of w.heard) assert.ok(!frame.includes(phrase) && !frame.includes(quoted), 'the phrase went out on the stream');
  const log = await fetch(`${b.url}/api/log?limit=500`, { headers: { 'x-phosphor-token': b.token } });
  const lines = await log.text();
  assert.ok(!lines.includes(phrase) && !lines.includes(quoted), 'the phrase is in the audit log');
}

async function vaultOf(b: Backend): Promise<Any> {
  return (await fetch(`${b.url}/api/vault`, { headers: { 'x-phosphor-token': b.token } })).json();
}

async function shut(b: Backend, w: Window): Promise<void> {
  w.close();
  mock.timers.reset();
  b.server.closeAllConnections();
  await new Promise<void>((resolve) => b.server.close(() => resolve()));
  fs.rmSync(b.dataDir, { recursive: true, force: true });
}

/* ---------- the runs ---------- */

test('a new person makes a password wallet, writes the words down past the idle lock, unlocks, proves them, and the invite pays in', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const b = await boot();
  const w = openWindow(b);
  try {
    const words = await toWords(w);
    const wallet = String(b.keystore.addresses().evm).toLowerCase();

    // Twelve minutes with the pen: the wallet locks itself at five.
    away(b, 12);
    assert.equal(b.keystore.state(), 'locked', 'five quiet minutes did not lock the wallet');
    await unlockThroughCard(w, 'Locked after 5 quiet minutes.');
    assert.equal(b.keystore.state(), 'unlocked');
    assert.equal(title(w), 'Save your recovery words', 'unlocking did not put the person back on the step they were on');
    assert.deepEqual(find(w.screen, '.word-text').map((n: Any) => n.textContent), words);

    await toProve(w);
    typeBack(w, words);
    primary(w).click();
    await onStep(w, 'Your addresses');
    assert.equal((await vaultOf(b)).backedUp, true, 'the app does not have the wallet as backed up');
    await claimLanded(b, w, wallet);
    await phraseStaysPut(b, w, words);
  } finally {
    await shut(b, w);
  }
});

test('Prove it more than half an hour after the words, with a screen lock and an idle lock in between, still goes through', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const b = await boot();
  const w = openWindow(b);
  try {
    const words = await toWords(w);
    const wallet = String(b.keystore.addresses().evm).toLowerCase();

    await screenLock(b);
    await unlockThroughCard(w, 'Locked when your screen locked.');
    away(b, PHRASE_PROOF_MS / 60_000 + 1);
    await unlockThroughCard(w, 'Locked after 5 quiet minutes.');
    assert.equal(title(w), 'Save your recovery words');

    await toProve(w);
    typeBack(w, words);
    primary(w).click();
    await onStep(w, 'Your addresses');
    const reveals = w.read.filter((r) => r.path === '/api/wallet/reveal');
    assert.equal(reveals.length, 1, 'the words were not read again, or were read more than once');
    // The read again was spent at once: its nonce answers nothing now.
    const nonce = JSON.parse(reveals[0].text).nonce as string;
    const spent = await fetch(`${b.url}/api/wallet/reveal/${nonce}`, { headers: { origin: b.url, 'x-phosphor-token': b.token } });
    assert.equal(spent.status, 404);
    assert.equal((await vaultOf(b)).backedUp, true);
    await claimLanded(b, w, wallet);
    await phraseStaysPut(b, w, words);
  } finally {
    await shut(b, w);
  }
});

test('five misses on Prove it, then the right words, go through without a Back it up the card does not have', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const b = await boot();
  const w = openWindow(b);
  try {
    const words = await toWords(w);
    const wallet = String(b.keystore.addresses().evm).toLowerCase();
    let misses = 0;
    const miss = async (): Promise<void> => {
      typeBack(w, words, true);
      primary(w).click();
      misses += 1;
      await until(() => visibleText(w.screen).includes(misses % 2 === 0 ? 'Two tries did not match' : 'Those words do not match'), `miss ${misses} said nothing`);
    };
    await toProve(w);
    await miss();
    await miss();
    await toProve(w);
    await miss();
    await miss();
    await toProve(w);
    await miss();
    // The app's five-miss wall is down to nothing now; the right words still go through.
    typeBack(w, words);
    primary(w).click();
    await onStep(w, 'Your addresses');
    assert.ok(!visibleText(w.screen).includes('Back it up'));
    assert.equal(w.read.filter((r) => r.path === '/api/wallet/reveal').length, 1, 'only the wall needed the words read again');
    assert.equal((await vaultOf(b)).backedUp, true);
    await claimLanded(b, w, wallet);
  } finally {
    await shut(b, w);
  }
});
