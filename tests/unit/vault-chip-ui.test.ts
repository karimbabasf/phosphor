// Your vault, run for real over a small DOM (the pattern of vault-tab-ui.test.ts): the Vault tab
// with ui/screens/chip.js and ui/screens/allowance.js, the window's half of the move to this Mac's
// Touch ID key (src/vault/rekey.ts, src/http/chip.ts, src/http/allowance.ts, src/http/hl-agent.ts).
//
// What matters most is the paper key. Its 24 words are shown once, in their row only, and never
// reach a log, a frame, the state, storage, an attribute or any request but the two that take
// them back; there is no Print and no Copy; they are typed back whole, one to a field, with
// pasting off; a slip is named by its number and never by the word; and a lock, the tab left or
// Hide words takes them off the screen. The screen says plainly that the paper is the only key
// away from this Mac and that the wallet's backup also holds the allowance and the gas account.
// Then every face of the row: the four steps, the move under way with the Touch ID sentences
// named before they are asked, the vault that moved (who opens it, the NEAR door, a key nobody
// added), the restore on a new Mac beside the wallet's own restore, the allowance ("$63 of
// $100"), the gas account, the trading key, every refusal in calm words, and the agent's one line
// while the vault moves.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { english } from 'viem/accounts';

import { chipRefusal } from '../../src/http/chip.ts';
import { refusal } from '../../src/http/wallet.ts';
import { AGENTS_WAIT_SAID } from '../../src/proposals/lifecycle.ts';
import { shortfallSentence } from '../../src/vault/allowance.ts';
import { MOVE_VAULT_REASON, RESTORE_VAULT_REASON } from '../../src/vault/reason.ts';
import { RAW } from '../fixtures/vault-refusal-codes.ts';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const CUSTODY = read('../../ui/core/custody.js');
const VAULT_JS = read('../../ui/screens/vault.js');
const CHIP_JS = read('../../ui/screens/chip.js');
const ALLOWANCE_JS = read('../../ui/screens/allowance.js');
const AGENT_JS = read('../../ui/screens/agent.js');
const MARKDOWN_JS = read('../../ui/core/markdown.js');
const MARKS_JS = read('../../ui/design/marks.js');
const CSS = read('../../ui/design/vault.css');
const GETTING_STARTED = read('../../docs/getting-started.md');

// The words a person must never read on these rows: the parts underneath.
const JARGON = /\b(chips?|enclave|markers?|predecessor|nonces?|keychain|keyref|salt|intents\.near)\b/i;
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

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
    type: '',
    name: '',
    value: '',
    inert: false,
    dataset: {} as Record<string, string>,
    style: { setProperty(name: string, value: string) { (this as Any)[name] = value; } } as Any,
    childNodes: [] as Any[],
    parentNode: null as unknown as Any,
    focused: false,
    get textContent(): string {
      return node.childNodes.length ? node.childNodes.map((c: Any) => c.textContent).join('') : ownText;
    },
    set textContent(value: string) {
      ownText = String(value);
      for (const child of node.childNodes) child.parentNode = null;
      node.childNodes = [];
    },
    get firstChild() { return node.childNodes[0] ?? null; },
    get lastChild() { return node.childNodes[node.childNodes.length - 1] ?? null; },
    get children() { return node.childNodes; },
    get nextSibling() {
      const siblings = node.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
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
    attributes: attrs,
    addEventListener(type: string, fn: (event: Any) => void) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type: string, event: Any = {}) {
      let prevented = false;
      for (const fn of listeners[type] ?? []) fn(Object.assign({ target: node, currentTarget: node, preventDefault() { prevented = true; } }, event));
      return prevented;
    },
    click() { node.dispatch('click'); },
    focus() { node.focused = true; },
    scrollIntoView() { node.scrolled = true; },
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0 }),
    querySelector(selector: string) { return find(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return find(node, selector); },
  };
  return node;
}

function matches(node: Any, selector: string): boolean {
  const parts = selector.trim().match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
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

// A selector of one compound, or two joined by a space (an ancestor, then the node).
function find(root: Any, selector: string): Any[] {
  const out: Any[] = [];
  for (const one of selector.split(',').map((s) => s.trim())) {
    const parts = one.split(/\s+/);
    const last = parts[parts.length - 1] as string;
    const above = parts.slice(0, -1);
    const walk = (n: Any): void => {
      for (const child of n.childNodes) {
        if (matches(child, last) && (above.length === 0 || hasAncestor(child, above[0] as string, root)) && !out.includes(child)) out.push(child);
        walk(child);
      }
    };
    walk(root);
  }
  return out;
}

function hasAncestor(node: Any, selector: string, root: Any): boolean {
  for (let at = node.parentNode; at && at !== root.parentNode; at = at.parentNode) if (matches(at, selector)) return true;
  return false;
}

const isShown = (n: Any): boolean => {
  for (let at = n; at; at = at.parentNode) if (at.hidden) return false;
  return true;
};

// What a person reads: every leaf's text under nodes that are not hidden.
function visible(node: Any): string[] {
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
  return out;
}

function everyNode(root: Any): Any[] {
  const out: Any[] = [root];
  for (const child of root.childNodes) out.push(...everyNode(child));
  return out;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/* ---------- the paper key and the accounts ---------- */

const UI_WORDS = new Set(
  [VAULT_JS, CHIP_JS, ALLOWANCE_JS, CUSTODY, AGENT_JS, GETTING_STARTED].join(' ').toLowerCase().match(/[a-z]+/g) ?? [],
);
// 24 words off the BIP39 list that no screen and no doc here ever says, so finding one anywhere
// means the paper leaked. Built from indices so no phrase sits in the tree for the sweep to find.
const PAPER_WORDS: string[] = [];
for (let i = 1500; PAPER_WORDS.length < 24 && i < english.length; i += 7) {
  const word = english[i] as string;
  if (!UI_WORDS.has(word) && word.length >= 4) PAPER_WORDS.push(word);
}
const OLD_PAPER: string[] = [];
for (let i = 103; OLD_PAPER.length < 24 && i < english.length; i += 11) {
  const word = english[i] as string;
  if (!UI_WORDS.has(word) && !PAPER_WORDS.includes(word) && word.length >= 4) OLD_PAPER.push(word);
}

const leaks = (text: string, words: string[] = PAPER_WORDS): string[] =>
  words.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));

const VAULT = '0x8902c5f1a1b2c3d4e5f6a7b8c9d0e1f23c4daede';
const ALLOWANCE = '0x12ab5678a1b2c3d4e5f6a7b8c9d0e1f290abcd34';
const GAS = 'a1b2c3d4' + '0'.repeat(48) + 'e5f6a7b8';
const NEXT_AGENT = '0x77aa5678a1b2c3d4e5f6a7b8c9d0e1f2deadbe01';

function chipSlice(over: Any = {}): Any {
  return Object.assign(
    {
      state: 'ready',
      recoveryOnChain: null,
      oldOnChain: true,
      predecessorAuth: true,
      otherKeys: null,
      allowance: null,
      gas: { account: GAS, near: '0.4985', low: false },
      needs: [],
      paper: 'none',
      run: null,
      pins: null,
      moving: false,
    },
    over,
  );
}

const MOVED = (over: Any = {}): Any =>
  chipSlice(Object.assign({
    state: 'done',
    recoveryOnChain: true,
    oldOnChain: false,
    predecessorAuth: false,
    otherKeys: [],
    allowance: { account: ALLOWANCE, sizeUsd: 100, balanceUsd: 63 },
    pins: { vault: VAULT, allowance: ALLOWANCE, recovery: 'secp256k1:4mLhzZ9S' + 'x'.repeat(70) + '8czTabcd' },
  }, over));

function vaultState(over: Any = {}): Any {
  return Object.assign(
    {
      custody: 'secure-enclave',
      state: 'unlocked',
      enclave: { attached: true, ready: true, capability: { secureEnclave: true, biometry: 'touchid', canAuthenticate: true, keychainHome: true }, keyMadeAt: '2026-09-14T09:00:00.000Z', binding: 'app' },
      foreign: false,
      waiting: null,
      backedUp: true,
      backedUpAt: '2026-09-14T10:00:00.000Z',
      idleMinutes: 15,
      hasMnemonic: false,
      chip: chipSlice(),
    },
    over,
  );
}

/* ---------- the window ---------- */

type World = {
  sandbox: Any;
  store: Any;
  view: Any;
  calls: Any[];
  logs: string[];
  emitted: Any[];
  stored: string[];
  answer: Any;
  put: (patch: Any) => void;
  chip: (over: Any) => void;
  frame: (frame: Any) => void;
  lock: () => void;
  leave: () => void;
  key: (key: string) => boolean;
};

function build(options: { vault?: Any; proposals?: Any[] } = {}): World {
  const view = makeNode('section');
  const migrate = makeNode('div');
  migrate.hidden = true;
  const page = makeNode('div');
  const body = makeNode('body');
  const calls: Any[] = [];
  const logs: string[] = [];
  const emitted: Any[] = [];
  const stored: string[] = [];
  const answer: Any = {
    post: {} as Record<string, Any>,
    trading: { moved: true, key: null, next: NEXT_AGENT, days: 90 },
  };

  const record = (level: string) => (...args: unknown[]) => { logs.push(level + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  const docListeners: Record<string, Array<(event: Any) => void>> = {};
  const doc: Any = {
    body,
    createElement: makeNode,
    getElementById: (id: string) => (id === 'view-vault' ? view : id === 'screen-migrate' ? migrate : id === 'page' ? page : null),
    addEventListener(type: string, fn: (event: Any) => void) { (docListeners[type] ||= []).push(fn); },
  };
  const viewListeners: Array<(event: Any) => void> = [];
  const busHandlers: Record<string, Array<(frame: Any) => void>> = {};
  const storage = (name: string): Any => ({
    getItem: () => null,
    setItem: (k: string, v: string) => { stored.push(`${name} ${k}=${v}`); },
    removeItem: () => {},
  });
  const sandbox: Any = {
    console: { log: record('log'), info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') },
    document: doc,
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    addEventListener(type: string, fn: (event: Any) => void) { if (type === 'phosphor:view') viewListeners.push(fn); },
    localStorage: storage('local'),
    sessionStorage: storage('session'),
    Math,
    Date,
  };
  sandbox.window = sandbox;
  sandbox.PhosphorNet = {
    readable: (e: Any) => String(e && e.message ? e.message : e),
    postJson: (path: string, payload: Any, opts?: Any) => {
      calls.push(Object.assign({ route: path, touch: !!(opts && opts.touch) }, payload));
      const out = typeof answer.post[path] === 'function' ? answer.post[path](payload) : answer.post[path];
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out ?? { ok: true });
    },
    getJson: (path: string) => {
      calls.push({ route: 'GET ' + path });
      if (path === '/api/vault/trading-key') return Promise.resolve({ data: answer.trading, fresh: true });
      return Promise.resolve({ data: {}, fresh: true });
    },
  };
  sandbox.PhosphorMotion = { reduced: () => true };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean) { button.disabled = !!pending; button.dataset.pending = pending ? 'true' : ''; },
    refresh: () => { calls.push({ route: 'refresh' }); if (answer.onRefresh) answer.onRefresh(); return Promise.resolve(); },
    setView: (name: string) => { calls.push({ route: 'setView', view: name }); },
    view: () => 'vault',
  };
  sandbox.PhosphorToast = { show: (message: string) => { calls.push({ route: 'toast', message }); } };
  sandbox.PhosphorEvents = {
    on: (type: string, fn: (frame: Any) => void) => { (busHandlers[type] ||= []).push(fn); },
    emit: (type: string, payload: Any) => { emitted.push({ type, payload }); },
  };
  sandbox.PhosphorNetPick = {
    NETWORKS: [{ id: 'eth', name: 'Ethereum', mark: 'ETH', colour: '#627EEA' }, { id: 'near', name: 'NEAR', mark: 'NEAR', colour: '#00EC97' }],
    render: () => ({ destroy() {} }),
  };
  sandbox.PhosphorDeposit = { open: () => Promise.resolve(null), networkWords: (c: string) => c, defaultSymbol: () => '', chunks: (a: string) => [a] };
  sandbox.PhosphorApi = {
    receive: () => Promise.resolve({ data: { chains: [], state: 'unlocked', verified: true, tampered: false } }),
    intentsReceive: () => Promise.resolve({ data: { networks: [] } }),
    lock: () => { calls.push({ route: '/api/lock' }); return Promise.resolve({ ok: true }); },
    kill: () => Promise.resolve({ ok: true }),
    vaultPrefs: () => Promise.resolve({ ok: true }),
  };

  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(CUSTODY, sandbox, { filename: 'ui/core/custody.js' });
  runInContext(VAULT_JS, sandbox, { filename: 'ui/screens/vault.js' });
  runInContext(CHIP_JS, sandbox, { filename: 'ui/screens/chip.js' });
  runInContext(ALLOWANCE_JS, sandbox, { filename: 'ui/screens/allowance.js' });

  const store = sandbox.PhosphorState;
  store.put({
    lock: { state: 'unlocked', idleLocksInSec: null, addresses: { evm: VAULT } },
    vault: vaultState(options.vault ?? {}),
    policy: { outbound: { humanClickAboveUsd: 100 } },
    sentences: [],
    dailyLimit: null,
    proposals: options.proposals ?? [],
  });
  sandbox.PhosphorVault.boot();
  for (const fn of viewListeners) fn({ detail: { view: 'vault' } });

  const put = (patch: Any): void => store.put(Object.assign({}, store.get(), patch));
  return {
    sandbox,
    store,
    view,
    calls,
    logs,
    emitted,
    stored,
    answer,
    put,
    chip: (over: Any) => {
      const vault = store.get().vault;
      put({ vault: Object.assign({}, vault, { chip: Object.assign({}, vault.chip, over) }) });
    },
    frame: (frame: Any) => { for (const fn of busHandlers.chip ?? []) fn(Object.assign({ type: 'chip', kind: 'chip' }, frame)); },
    lock: () => put({ lock: { state: 'locked', idleLocksInSec: null, addresses: { evm: VAULT } } }),
    leave: () => { for (const fn of viewListeners) fn({ detail: { view: 'basic' } }); },
    key: (key: string) => {
      let prevented = false;
      for (const fn of docListeners.keydown ?? []) fn({ key, defaultPrevented: prevented, preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

const section = (w: World): Any => find(w.view, '.vault-sec').find((s: Any) => s.dataset.surface === 'chip') as Any;
const rowOf = (w: World, surface: string): Any => find(w.view, '.vault-row').find((r: Any) => r.dataset.surface === surface) as Any;
const keyRow = (w: World): Any => rowOf(w, 'chip');
const shownButtons = (root: Any): Any[] => find(root, 'button').filter(isShown);
const press = (root: Any, label: string): Any => {
  const btn = shownButtons(root).find((b: Any) => b.textContent.startsWith(label) && !b.disabled);
  assert.ok(btn, `no button "${label}" on screen: ${JSON.stringify(shownButtons(root).map((b: Any) => b.textContent))}`);
  btn.click();
  return btn;
};
const said = (root: Any): string => visible(root).join(' ').replace(/\s+/g, ' ');
const stepState = (w: World): Record<string, string> => Object.fromEntries(find(keyRow(w), '.vault-step').map((s: Any) => [s.dataset.step, s.dataset.state]));
const fields = (w: World): Any[] => find(keyRow(w), '.vault-paper-input').filter(isShown);
const errorLine = (root: Any): string => find(root, '.vault-error').filter(isShown).map((e: Any) => e.textContent).join(' ');
const type = (inputs: Any[], words: string[]): void => {
  inputs.forEach((input, i) => { input.value = words[i] ?? ''; });
};

/* Everything a word of the paper could hide in, outside the screen that shows it and the two
   requests that take it back. */
function holdsNoWord(w: World, step: string, words: string[] = PAPER_WORDS): void {
  assert.deepEqual(leaks(w.logs.join('\n'), words), [], `${step}: a word of the paper in the console`);
  assert.deepEqual(leaks(JSON.stringify(w.emitted), words), [], `${step}: a word of the paper in a frame`);
  assert.deepEqual(leaks(JSON.stringify(w.store.get()), words), [], `${step}: a word of the paper in the state`);
  assert.deepEqual(leaks(w.stored.join('\n'), words), [], `${step}: a word of the paper in storage`);
  for (const call of w.calls) {
    if (call.route === '/api/vault/chip/phrase-proven' || call.route === '/api/vault/chip/restore') continue;
    assert.deepEqual(leaks(JSON.stringify(call), words), [], `${step}: a word of the paper in ${call.route}`);
  }
  for (const node of everyNode(w.view)) {
    const attributes = JSON.stringify(node.attributes) + JSON.stringify(node.dataset) + String(node.name || '');
    assert.deepEqual(leaks(attributes, words), [], `${step}: a word of the paper in an attribute`);
  }
}

// Every leaf's text, hidden or not, one apart from the next.
const allText = (root: Any): string => everyNode(root).filter((n: Any) => n.childNodes.length === 0).map((n: Any) => n.textContent).join(' ');

// Off the screen too: no node's text and no field holds a word.
function screenHoldsNoWord(w: World, step: string, words: string[] = PAPER_WORDS): void {
  assert.deepEqual(leaks(allText(w.view), words), [], `${step}: a word of the paper still on the page`);
  for (const input of find(w.view, 'input')) assert.deepEqual(leaks(String(input.value), words), [], `${step}: a word of the paper left in a field`);
}

async function showPaper(w: World, words: string[] = PAPER_WORDS): Promise<void> {
  w.answer.post['/api/vault/chip/phrase'] = () => ({ ok: true, words: words.slice() });
  w.answer.onRefresh = () => w.chip({ paper: 'shown' });
  press(keyRow(w), 'Show my paper key');
  await flush();
}

async function proveRight(w: World): Promise<void> {
  w.answer.post['/api/vault/chip/phrase-proven'] = (body: Any) =>
    JSON.stringify(body.words) === JSON.stringify(PAPER_WORDS) ? { ok: true, recovery: 'secp256k1:abc' } : { ok: false, code: 'wrong_words', error: 'Those words do not match the paper key on screen. Check each word against your paper.' };
  w.answer.onRefresh = () => w.chip({ paper: 'proven' });
  type(fields(w), PAPER_WORDS);
  press(keyRow(w), 'Check my paper');
  await flush();
}

/* ---------- the source ---------- */

test('the two screens never write markup, a clipboard, a print job, the console or storage, and name the Touch ID sentences the app writes', () => {
  for (const [file, source] of [['chip.js', CHIP_JS], ['allowance.js', ALLOWANCE_JS]] as const) {
    assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(source), false, `${file} writes markup`);
    assert.equal(/navigator\.clipboard|writeText|execCommand/.test(source), false, `${file} touches the clipboard`);
    assert.equal(/\.print\(|'Print'|"Print"/.test(source), false, `${file} offers a print`);
    assert.equal(/console\./.test(source), false, `${file} writes the console`);
    assert.equal(/localStorage|sessionStorage|indexedDB/.test(source), false, `${file} writes storage`);
    assert.equal(/PhosphorState\.put|store\.put|PhosphorEvents\.emit|events\.emit/.test(source), false, `${file} writes the store or the bus`);
    assert.equal(/btn-primary|btn-danger/.test(source), false, `${file} paints a green or red button on the Vault`);
    assert.equal(/PhosphorConfirm|showModal|window\.confirm|window\.alert|alert\(/.test(source), false, `${file} opens a dialog`);
  }
  // The words take no selection, so a drag never puts them on the clipboard.
  assert.match(CSS, /\.vault-paper \{[^}]*user-select: none;/);
  // The Touch ID sentences the window names are the ones the app and the vault service write.
  const sandbox: Any = {};
  sandbox.window = sandbox;
  sandbox.PhosphorDom = {};
  createContext(sandbox);
  runInContext(CHIP_JS, sandbox);
  assert.equal(sandbox.PhosphorChip.SAYS.move, MOVE_VAULT_REASON);
  assert.equal(sandbox.PhosphorChip.SAYS.restore, RESTORE_VAULT_REASON);
  const grammar = read('../../src-tauri/se-helper/IntentGrammar.swift');
  assert.ok(grammar.includes('said = "confirm this Mac\'s Touch ID key for \\(from)"'), 'the rekey proof sentence moved in the grammar');
  assert.equal(sandbox.PhosphorChip.SAYS.chip, "confirm this Mac's Touch ID key for your vault");
});

/* ---------- the section ---------- */

test('Your vault sits between Safety and the wallet once this copy can move a vault, and nowhere it cannot', () => {
  const w = build();
  assert.deepEqual(find(w.view, '.vault-sec').map((s: Any) => s.dataset.surface), ['agent', 'safety', 'chip', 'wallet']);
  assert.equal(find(section(w), '.vault-title')[0].textContent, 'Your vault');
  assert.deepEqual(find(section(w), '.vault-row').filter(isShown).map((r: Any) => r.dataset.surface), ['chip', 'gas'], 'before the move: the key and the gas account');
  assert.equal(keyRow(w).getAttribute('data-reveal'), 'vault-key');

  const cases: Array<[string, Any]> = [
    ['a demo with no chain (state none, nothing needed)', { chip: chipSlice({ state: 'none', needs: [], gas: null, oldOnChain: null, predecessorAuth: null }) }],
    ['a build with no keychain home', { chip: chipSlice({ state: 'none', needs: ['keychain'] }) }],
    ['a password wallet on a Mac with no Touch ID', { custody: 'software', enclave: { attached: true, ready: false }, chip: chipSlice({ state: 'none', needs: ['touch_id'] }) }],
    ['no wallet', { custody: null, chip: chipSlice({ state: 'none', needs: [] }) }],
    ['a state with no vault slice', { chip: undefined }],
  ];
  for (const [what, vault] of cases) {
    const v = build({ vault });
    assert.deepEqual(find(v.view, '.vault-sec').map((s: Any) => s.dataset.surface), ['agent', 'safety', 'wallet'], what);
  }
});

/* ---------- the offer: four steps ---------- */

test('the move is four numbered steps in order, the open one first, each with the action that gets past it', async () => {
  const w = build({ vault: { backedUp: false, chip: chipSlice({ state: 'none', needs: ['backup', 'gas'], gas: { account: GAS, near: '0', low: true } }) } });
  const row = keyRow(w);
  assert.ok(said(row).includes('Your private key opens your vault today.'));
  assert.ok(said(row).includes('Move your vault to Touch ID'));
  assert.deepEqual(find(row, '.vault-step-title').map((t: Any) => t.textContent),
    ['Back up your private key', 'Add NEAR to the gas account', 'Write your paper key', 'Move your vault']);
  assert.deepEqual(stepState(w), { backup: 'now', gas: 'next', paper: 'next', move: 'next' });
  assert.equal(find(row, '.vault-step-body').filter(isShown).length, 1, 'more than one step is open');
  assert.ok(said(row).includes('After the move your private key still opens your allowance, the gas account and Hyperliquid, so prove your copy first.'));
  const backupRow = rowOf(w, 'backup');
  press(row, 'Back it up first');
  assert.equal(backupRow.scrolled, true, 'Back it up first does not take the person to the backup');

  // Backed up: the gas account is next, and its button opens the gas account's own step.
  w.put({ vault: Object.assign({}, w.store.get().vault, { backedUp: true }) });
  w.chip({ needs: ['gas'] });
  assert.deepEqual(stepState(w), { backup: 'done', gas: 'now', paper: 'next', move: 'next' });
  assert.ok(said(row).includes('Backed up.'));
  assert.ok(said(row).includes('It holds 0 NEAR, and the move needs more.'));
  press(row, 'Add NEAR');
  const gas = rowOf(w, 'gas');
  assert.equal(gas.scrolled, true);
  assert.equal(find(gas, '.vault-gas-add')[0].hidden, false, 'Add NEAR does not open the gas account\'s step');

  // Funded: the paper is next (with nothing left to need, the backend reads the vault ready).
  w.chip({ state: 'ready', needs: [], gas: { account: GAS, near: '0.4985', low: false } });
  assert.deepEqual(stepState(w), { backup: 'done', gas: 'done', paper: 'now', move: 'next' });
  assert.ok(said(row).includes('0.4985 NEAR, enough for the move.'));
  assert.ok(said(row).includes('24 words you write by hand. With this Mac, they are the only key to your vault.'));
});

test('a wallet that cannot move yet says why in one line, with the way past it where there is one', () => {
  const locked = build({ vault: { chip: chipSlice({ state: 'none', needs: ['open', 'gas'] }) } });
  assert.ok(said(keyRow(locked)).includes('Open your wallet to go on.'));
  assert.equal(find(keyRow(locked), '.vault-step-body').filter(isShown).length, 0);
  const password = build({ vault: { custody: 'software', enclave: { attached: true, ready: true }, chip: chipSlice({ state: 'none', needs: ['touch_id', 'gas'] }) } });
  assert.ok(said(keyRow(password)).includes('Your wallet opens with a password. Move it behind Touch ID first; your vault moves after that.'));
  press(keyRow(password), 'Protect with Touch ID');
  assert.equal(password.sandbox.document.getElementById('screen-migrate').hidden, false, 'Protect with Touch ID does not open the move behind Touch ID');
  const outside = build({ vault: { enclave: { attached: false, ready: false }, chip: chipSlice({ state: 'none', needs: ['touch_id'] }) } });
  assert.ok(said(keyRow(outside)).includes('Touch ID only works inside the Phosphor app. Open the app to move your vault.'));
});

/* ---------- the paper key ---------- */

test('the paper key: 24 numbered words once, both plain sentences, the vault\'s address, and no Print or Copy', async () => {
  const w = build();
  holdsNoWord(w, 'before');
  await showPaper(w);
  const row = keyRow(w);
  assert.equal(w.calls.filter((c) => c.route === '/api/vault/chip/phrase').length, 1);
  const grid = find(row, '.vault-paper')[0];
  assert.ok(grid && isShown(grid), 'the words are not on screen');
  assert.deepEqual(find(grid, '.word-text').map((n: Any) => n.textContent), PAPER_WORDS);
  assert.deepEqual(find(grid, '.num').map((n: Any) => n.textContent), Array.from({ length: 24 }, (_, i) => String(i + 1)));
  const text = said(row);
  // Rule 1, on the phrase screen, for a wallet whose backup is its private key.
  assert.ok(text.includes('Your paper key is the only key that opens your vault away from this Mac.'), text);
  assert.ok(text.includes('Your private key also controls your allowance (at most its size plus 10 percent) and the gas account (about 0.5 NEAR), so keep both like cash.'), text);
  assert.ok(text.includes('On this screen only. Anyone who reads these words can open your vault.'));
  assert.ok(text.includes('Under the words, write your vault\'s address:'));
  assert.equal(find(row, '.vault-mono')[0].textContent, VAULT);
  assert.ok(text.includes('By hand, on paper: a printer, a screenshot or a copy keeps one more key to your vault.'));
  const labels = shownButtons(row).map((b: Any) => b.textContent);
  assert.deepEqual(labels, ['I wrote it down', 'Hide words']);
  assert.equal(labels.some((l: string) => /print|copy|save/i.test(l)), false);
  holdsNoWord(w, 'shown');

  // A recovery phrase wallet's second sentence names its phrase.
  const phrase = build({ vault: { hasMnemonic: true } });
  await showPaper(phrase);
  assert.ok(said(keyRow(phrase)).includes('Your recovery phrase also controls your allowance (at most its size plus 10 percent) and the gas account (about 0.5 NEAR), so keep both like cash.'));
});

test('typed back whole: 24 fields, pasting off, a slip named by its number and never by the word, two misses show the words again', async () => {
  const w = build();
  await showPaper(w);
  press(keyRow(w), 'I wrote it down');
  screenHoldsNoWord(w, 'the type-back opens');
  const inputs = fields(w);
  assert.equal(inputs.length, 24);
  assert.deepEqual(inputs.map((i: Any) => i.getAttribute('aria-label')), Array.from({ length: 24 }, (_, i) => `Word ${i + 1}`));
  for (const input of inputs) {
    assert.equal(input.autocomplete, 'off');
    assert.equal(input.spellcheck, false);
    assert.equal(input.getAttribute('autocorrect'), 'off');
    assert.equal(input.getAttribute('autocapitalize'), 'off');
  }
  assert.ok(said(keyRow(w)).includes('All 24 words, from your paper, in order. It proves the paper is right before your vault depends on it.'));

  // Pasting is refused, and says why.
  assert.equal(inputs[0].dispatch('paste'), true, 'a paste went through');
  assert.ok(said(keyRow(w)).includes('Type each word from your paper. Pasting is off here, so the check is of your paper.'));
  assert.equal(inputs[0].dispatch('drop'), true, 'a drop went through');

  // Typing a space moves on: the words can go in as one run.
  inputs[0].value = `${PAPER_WORDS[0]} ${PAPER_WORDS[1]} `;
  inputs[0].dispatch('input');
  assert.equal(inputs[0].value, PAPER_WORDS[0]);
  assert.equal(inputs[1].value, PAPER_WORDS[1]);
  assert.equal(inputs[2].focused, true);
  // Enter goes on to the next field.
  inputs[5].dispatch('keydown', { key: 'Enter' });
  assert.equal(inputs[6].focused, true);

  // Checked here before anything is sent: empty fields and a field with more than letters, by number.
  type(inputs, []);
  press(keyRow(w), 'Check my paper');
  assert.equal(errorLine(keyRow(w)), 'Type the 24 words from your paper.');
  type(inputs, PAPER_WORDS.map((word, i) => (i === 2 || i === 6 ? '' : word)));
  press(keyRow(w), 'Check my paper');
  assert.equal(errorLine(keyRow(w)), 'Words 3 and 7 are still empty. Your paper key is 24 words.');
  type(inputs, PAPER_WORDS.map((word, i) => (i === 4 ? word + '7' : word)));
  press(keyRow(w), 'Check my paper');
  assert.equal(errorLine(keyRow(w)), 'Word 5 is not one word. A paper key word is letters only, one to a field.');
  assert.equal(w.calls.filter((c) => c.route === '/api/vault/chip/phrase-proven').length, 0, 'a field the window could tell was wrong went to the backend');

  // One word off: named by its number, from the paper still in this window; the word never.
  w.answer.post['/api/vault/chip/phrase-proven'] = () => ({ ok: false, code: 'wrong_words', error: 'Those words do not match the paper key on screen. Check each word against your paper.' });
  const slipped = PAPER_WORDS.slice();
  slipped[6] = OLD_PAPER[0] as string;
  type(inputs, slipped);
  press(keyRow(w), 'Check my paper');
  await flush();
  assert.equal(errorLine(keyRow(w)), 'Word 7 does not match the paper key Phosphor showed you. Check it on your paper, then try again.');
  assert.deepEqual(leaks(errorLine(keyRow(w)), [...PAPER_WORDS, ...OLD_PAPER]), []);
  holdsNoWord(w, 'one miss');
  type(fields(w), slipped);
  press(keyRow(w), 'Check my paper');
  await flush();
  assert.ok(said(keyRow(w)).includes('Two tries did not match. Check your paper word by word, then type it again.'));
  assert.equal(find(keyRow(w), '.vault-paper').filter(isShown).length, 1, 'the words did not come back after two misses');
  holdsNoWord(w, 'two misses');

  // Right: the words leave the window, the fields are emptied, and the move is the open step.
  press(keyRow(w), 'I wrote it down');
  await proveRight(w);
  const proven = w.calls.filter((c) => c.route === '/api/vault/chip/phrase-proven').at(-1);
  assert.deepEqual([...(proven?.words ?? [])], PAPER_WORDS);
  screenHoldsNoWord(w, 'proven');
  holdsNoWord(w, 'proven');
  assert.deepEqual(stepState(w), { backup: 'done', gas: 'done', paper: 'done', move: 'now' });
  assert.ok(said(keyRow(w)).includes('Typed back whole.'));
});

test('a lock, the tab left and Hide words each take the paper off the screen and out of the fields', async () => {
  for (const how of ['lock', 'leave', 'hide'] as const) {
    const w = build();
    await showPaper(w);
    assert.equal(leaks(allText(w.view)).length, 24, `${how}: the words were not shown`);
    if (how === 'lock') w.lock();
    else if (how === 'leave') w.leave();
    else press(keyRow(w), 'Hide words');
    await flush();
    screenHoldsNoWord(w, how);
    holdsNoWord(w, how);
  }
  // Typed words go too.
  const w = build();
  await showPaper(w);
  press(keyRow(w), 'I wrote it down');
  type(fields(w), PAPER_WORDS);
  w.leave();
  await flush();
  screenHoldsNoWord(w, 'typed, then the tab left');
});

test('after a restart the paper is typed again against the one proven before, and a paper shown before it is void', () => {
  const retype = build({ vault: { chip: chipSlice({ paper: 'retype' }) } });
  assert.ok(said(keyRow(retype)).includes('Phosphor restarted or locked, so type the paper you wrote for this move again, all 24 words.'));
  assert.equal(fields(retype).length, 24);
  assert.ok(shownButtons(keyRow(retype)).some((b: Any) => b.textContent === 'Show a new paper key'), 'no way to a new paper when the old one is lost');
  const shown = build({ vault: { chip: chipSlice({ paper: 'shown' }) } });
  assert.equal(fields(shown).length, 24, 'a paper on screen in another window is not typed back here');
  const isVoid = build({ vault: { chip: chipSlice({ paper: 'void' }) } });
  assert.ok(said(keyRow(isVoid)).includes('The paper key shown before Phosphor restarted opens nothing. Destroy it, then write a new one.'));
  assert.ok(shownButtons(keyRow(isVoid)).some((b: Any) => b.textContent === 'Show a new paper key'));
});

/* ---------- the move ---------- */

test('the move names both Touch IDs before it asks, then shows each step as its frame arrives, and lands on the done state', async () => {
  const w = build({ vault: { chip: chipSlice({ paper: 'proven' }) } });
  const row = keyRow(w);
  assert.deepEqual(find(row, '.vault-said').map((n: Any) => n.textContent), [MOVE_VAULT_REASON, "confirm this Mac's Touch ID key for your vault"]);
  assert.ok(said(row).includes('Cancel any Touch ID that reads anything else. While the move runs, your assistant\'s moves wait.'));
  w.answer.post['/api/vault/chip/move'] = { ok: true, run: 'r1' };
  w.answer.onRefresh = () => w.chip({ state: 'moving', run: { id: 'r1', kind: 'migrate', status: 'creating', reason: null, said: null } });
  press(row, 'Move my vault');
  await flush();
  assert.equal(w.calls.filter((c) => c.route === '/api/vault/chip/move').length, 1);
  const runState = (): string[] => find(row, '.vault-run-step').filter(isShown).map((s: Any) => `${s.dataset.status}:${s.dataset.state}`);
  assert.deepEqual(runState(), ['creating:now', 'touch_old:next', 'touch_chip:next', 'simulating:next', 'checking:next']);
  assert.ok(said(row).includes('Your vault is moving to this Mac\'s Touch ID key.'));
  w.frame({ run: 'r1', status: 'touch_old' });
  assert.deepEqual(runState(), ['creating:done', 'touch_old:now', 'touch_chip:next', 'simulating:next', 'checking:next']);
  // The sentence of the Touch ID that is up, under its own step.
  const up = find(row, '.vault-run-step').filter((s: Any) => s.dataset.state === 'now');
  assert.deepEqual(up.map((s: Any) => find(s, '.vault-said')[0].textContent), [MOVE_VAULT_REASON]);
  assert.ok(said(row).includes('Touch ID is asking now. Approve it only if it reads the sentence above.'));
  w.frame({ run: 'r1', status: 'touch_chip' });
  w.frame({ run: 'r1', status: 'simulating' });
  w.frame({ run: 'r1', status: 'checking' });
  assert.deepEqual(runState(), ['creating:done', 'touch_old:done', 'touch_chip:done', 'simulating:done', 'checking:now']);
  assert.ok(said(row).includes('Sent. Phosphor reads your vault every 15 seconds until NEAR confirms it, also after a restart. Your assistant\'s moves wait until then.'));
  // Done: the tick, the pins, who opens the vault, and the two plain sentences.
  w.frame({ run: 'r1', status: 'done' });
  w.chip(MOVED({ run: { id: 'r1', kind: 'migrate', status: 'done', reason: null, said: null } }));
  const text = said(row);
  assert.ok(text.includes('Your vault is on this Mac\'s Touch ID key.'), text);
  assert.ok(text.includes('This Mac\'s Touch ID key signs only for these two.'));
  assert.ok(find(row, '.vault-pins .vault-rule-value').map((n: Any) => n.textContent).includes('0x8902c5f1...3c4daede'));
  assert.equal(find(row, '.vault-backup-line')[0].getAttribute('data-pop'), 'true', 'the done check does not pop');
  assert.equal(find(keyRow(w), '.vault-row-value')[0].textContent, 'Touch ID');
  assert.ok(text.includes('Your paper key is the only key that opens your vault away from this Mac.'));
  assert.ok(text.includes('Your private key also controls your allowance (at most its size plus 10 percent) and the gas account (about 0.5 NEAR), so keep both like cash.'));
  holdsNoWord(w, 'done');
  // Back on the tab later, the moment has rested: the row says who opens the vault.
  w.leave();
  assert.equal(find(row, '.vault-backup-line').filter(isShown).length, 0, 'the done moment outlives the tab');
  assert.ok(said(row).includes('Who opens your vault'));
});

test('a done frame that beats the state lands on the done moment, never back on the steps', () => {
  const w = build({ vault: { chip: chipSlice({ state: 'moving', paper: 'proven', run: { id: 'r5', kind: 'migrate', status: 'checking', reason: null, said: null } }) } });
  w.frame({ run: 'r5', status: 'done' });
  const row = keyRow(w);
  assert.equal(find(row, '.vault-step').length, 0, 'the steps came back between the last frame and the state');
  assert.ok(said(row).includes('Your vault is on this Mac\'s Touch ID key.'));
});

test('a move that stops says why in calm words, with the action that helps beside Try again', async () => {
  const cases: Array<[string, string, string | null]> = [
    ['user_cancel', 'Touch ID was cancelled. Nothing changed.', null],
    ['gas_low', String(refusal('gas_low').error), 'Add NEAR'],
    ['gas_unfunded', String(refusal('gas_unfunded').error), 'Add NEAR'],
    ['not_backed_up', String(refusal('not_backed_up').error), 'Back it up first'],
    ['wrong_paper', String(chipRefusal('wrong_paper').error), 'Show a new paper key'],
    ['rekey_slow', String(chipRefusal('rekey_slow').error), null],
    ['events_mismatch', String(refusal('events_mismatch').error), null],
  ];
  for (const [code, words, fix] of cases) {
    const w = build({ vault: { chip: chipSlice({ paper: 'proven', run: { id: 'r9', kind: 'migrate', status: 'failed', reason: code, said: String(chipRefusal(code).error) } }) } });
    const row = keyRow(w);
    assert.equal(errorLine(row), words, code);
    const tone = find(row, '.vault-error').filter(isShown)[0].getAttribute('data-tone');
    assert.equal(tone, code === 'user_cancel' ? 'quiet' : null, `${code}: a cancel reads as a warning, or a refusal as a choice`);
    const labels = shownButtons(row).map((b: Any) => b.textContent);
    assert.ok(labels.includes('Try again'), `${code}: ${labels}`);
    if (fix) assert.ok(labels.includes(fix), `${code}: no "${fix}" in ${labels}`);
    else assert.equal(labels.length, 1, `${code}: ${labels}`);
  }
  // A frame from a move that ended never stands in for a later one the state names.
  const later = build({ vault: { chip: chipSlice({ paper: 'proven' }) } });
  later.frame({ run: 'r-old', status: 'done' });
  later.chip({ run: { id: 'r-new', kind: 'migrate', status: 'failed', reason: 'gas_low', said: String(refusal('gas_low').error) } });
  assert.equal(errorLine(keyRow(later)), String(refusal('gas_low').error), 'an old run\'s frame hid the new run\'s failure');
  assert.ok(shownButtons(keyRow(later)).some((b: Any) => b.textContent === 'Add NEAR'));
  // Text the service wrote for its logs never reaches the row, whatever carried it.
  const raw = build({ vault: { chip: chipSlice({ paper: 'proven', run: { id: 'r9', kind: 'migrate', status: 'failed', reason: 'crypto_failed', said: 'keychain key -25300' } }) } });
  assert.equal(errorLine(keyRow(raw)), 'That did not finish, so nothing changed. Try again.');
  // A route's refusal at the click: said the same way.
  const w = build({ vault: { chip: chipSlice({ paper: 'proven' }) } });
  w.answer.post['/api/vault/chip/move'] = chipRefusal('rekey_busy');
  press(keyRow(w), 'Move my vault');
  await flush();
  assert.equal(errorLine(keyRow(w)), String(chipRefusal('rekey_busy').error));
});

test('every refusal the vault\'s routes and frames can carry is a calm sentence the raw-text guard lets through, with none of the parts underneath', () => {
  const chipSource = read('../../src/http/chip.ts');
  const start = chipSource.indexOf('const CHIP_WORDS');
  const chipCodes = [...chipSource.slice(start, chipSource.indexOf('};', start)).matchAll(/^\s+(\w+):/gm)].map((m) => m[1] as string);
  assert.ok(chipCodes.length >= 16, `read ${chipCodes.length} codes off src/http/chip.ts`);
  const hlSource = read('../../src/http/hl-agent.ts');
  const hlStart = hlSource.indexOf('const SAID');
  const hlBlock = hlSource.slice(hlStart, hlSource.indexOf('};', hlStart)).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const nothingSigned = /const NOTHING_SIGNED = '([^']+)'/.exec(hlSource)?.[1] ?? '';
  const hlSaid = [...hlBlock.matchAll(/'((?:[^'\\]|\\.)+)'/g)].map((m) => (m[1] as string).replace(/\\'/g, "'")).filter((s) => /^[A-Z]/.test(s));
  assert.ok(hlSaid.length >= 10, `read ${hlSaid.length} sentences off src/http/hl-agent.ts`);
  const shared = ['grammar', 'wrong_signer', 'chip_missing', 'chip_payload', 'chip_answer', 'vault_bundle', 'vault_journal', 'simulate_unavailable', 'simulate_refused', 'events_mismatch',
    'vault_settling', 'vault_pending', 'vault_checking', 'vault_mismatch', 'vault_unknown', 'gas_low', 'gas_unfunded', 'gas_key_missing', 'rpc_unavailable', 'invalid_request', 'chip_unsupported',
    'not_backed_up', 'wallet_locked', 'enclave_unavailable', 'keychain_unavailable', 'user_cancel', 'timeout', 'auth_failed', 'interaction_required', 'crypto_failed', 'no_key', 'not_committed'];
  const sentences: Array<[string, string]> = [
    ...chipCodes.map((code): [string, string] => [code, String(chipRefusal(code).error)]),
    ...shared.map((code): [string, string] => [code, String(chipRefusal(code).error)]),
    ...hlSaid.map((s, i): [string, string] => [`hl-agent ${i}`, s]),
    ['hl-agent nothing signed', nothingSigned],
    ['agents wait', AGENTS_WAIT_SAID],
  ];
  const w = build();
  const guard = w.sandbox.PhosphorCustody.sentence;
  for (const [code, sentence] of sentences) {
    assert.equal(guard({ error: sentence }, 'FALLBACK'), sentence, `${code}: the guard does not let "${sentence}" through`);
    assert.equal(JARGON.test(sentence), false, `${code}: jargon in "${sentence}"`);
    assert.equal(RAW.test(sentence), false, `${code}: a raw part in "${sentence}"`);
  }
});

/* ---------- a vault that moved ---------- */

test('a vault that moved says who opens it, as NEAR reads it, with the NEAR door said in plain words', () => {
  const w = build({ vault: { chip: MOVED() } });
  const row = keyRow(w);
  const facts = (): Record<string, string> => Object.fromEntries(find(row, '.vault-facts .vault-rule').map((r: Any) => [find(r, '.vault-rule-label')[0].textContent, find(r, '.vault-rule-value')[0].textContent]));
  assert.deepEqual(facts(), { 'This Mac\'s Touch ID key': 'Opens it', 'Your paper key': 'Opens it', 'Your private key': 'No longer opens it', 'The NEAR door': 'Shut' });
  assert.ok(said(row).includes('This Mac\'s Touch ID key and your paper key open your vault, and nothing else does.'));
  assert.ok(said(row).includes('A way for your private key to act for your vault through NEAR. The move shut it. NEAR Intents\' admins can open it again for any account, and this line reads it from NEAR.'));
  assert.ok(said(row).includes('It still opens your allowance, the gas account and Hyperliquid.'));
  assert.equal(find(row, '.vault-backup-line').filter(isShown).length, 0, 'the done moment shows on every open, not only after the move');
  assert.equal(find(row, '.vault-rule-value').filter((n: Any) => n.getAttribute('data-tone') === 'warn').length, 0);

  // A forced flip by the verifier's admins is visible.
  w.chip({ predecessorAuth: true });
  assert.equal(facts()['The NEAR door'], 'Open');
  assert.equal(find(row, '.vault-facts .vault-rule-value').filter((n: Any) => n.getAttribute('data-tone') === 'warn').length, 1);
  assert.ok(said(row).includes('NEAR Intents\' admins opened the NEAR door again, so your private key can reach your vault through it. Keep it like cash, and move your money to a fresh wallet if anyone else may have it.'));
  // Unread is never a yes or a no.
  w.chip({ predecessorAuth: null, recoveryOnChain: null, oldOnChain: null });
  assert.deepEqual(facts(), { 'This Mac\'s Touch ID key': 'Opens it', 'Your paper key': 'Not read yet', 'Your private key': 'Not read yet', 'The NEAR door': 'Not read yet' });
  // A key nobody here added is named, with what to do.
  w.chip({ predecessorAuth: false, recoveryOnChain: true, oldOnChain: false, otherKeys: ['secp256k1:TmysAU1B' + 'x'.repeat(70) + 'H7MkuLjQ'] });
  assert.ok(said(row).includes('Your vault also holds a key Phosphor did not add: secp256k1:TmysAU1B...H7MkuLjQ. It can move your vault\'s money. Send what your vault and allowance hold to a wallet whose key was made fresh, then stop using this one.'));
  for (const line of visible(section(w))) assert.equal(JARGON.test(line), false, line);
});

/* ---------- the restore on a new Mac ---------- */

test('on a new Mac the vault waits for its paper: the restore sits beside the wallet\'s own, a new paper first, then the old one', async () => {
  const w = build({ vault: { chip: chipSlice({ state: 'broken', oldOnChain: false, predecessorAuth: false }) } });
  const row = keyRow(w);
  assert.ok(said(row).includes('Your vault answers to a Touch ID key this Mac does not have.'));
  assert.ok(said(row).includes('Restore your vault on this Mac'));
  assert.deepEqual(find(row, '.vault-step-title').map((t: Any) => t.textContent), ['Back up your private key', 'Add NEAR to the gas account', 'Write a new paper key', 'Type your old paper key']);
  // Beside the wallet's restore, which says what the vault needs.
  const restoreRow = rowOf(w, 'recovery');
  assert.ok(said(restoreRow).includes('Your wallet is back. Your vault comes back with your paper key.'));
  press(restoreRow, 'Restore your vault');
  assert.equal(row.scrolled, true, 'Restore your vault does not take the person to the vault\'s row');

  await showPaper(w);
  press(row, 'I wrote it down');
  await proveRight(w);
  assert.deepEqual(stepState(w), { backup: 'done', gas: 'done', paper: 'done', old: 'now' });
  const oldFields = fields(w);
  assert.equal(oldFields.length, 24);
  assert.deepEqual(find(row, '.vault-said').map((n: Any) => n.textContent), ["confirm this Mac's Touch ID key for your vault", RESTORE_VAULT_REASON]);
  w.answer.post['/api/vault/chip/restore'] = { ok: true, run: 'r2' };
  w.answer.onRefresh = () => w.chip({ state: 'moving', run: { id: 'r2', kind: 'restore', status: 'creating', reason: null, said: null } });
  type(oldFields, OLD_PAPER);
  press(row, 'Restore my vault');
  await flush();
  assert.deepEqual(w.calls.filter((c) => c.route === '/api/vault/chip/restore').map((c) => [...c.words]), [OLD_PAPER]);
  screenHoldsNoWord(w, 'restore asked', OLD_PAPER);
  holdsNoWord(w, 'restore asked', OLD_PAPER);
  assert.ok(said(row).includes('Restoring your vault'));
  // The first Touch ID of a restore shows only when this Mac asks it, and the numbers follow.
  const steps = (): string[] => find(row, '.vault-run-step').filter(isShown).map((s: Any) => s.dataset.status);
  const numbers = (): string[] => find(row, '.vault-run-number').filter(isShown).map((n: Any) => n.textContent);
  assert.deepEqual(steps(), ['creating', 'touch_chip', 'simulating', 'checking']);
  assert.deepEqual(numbers(), ['1', '2', '3', '4'], 'a gap in the numbers where the restore asks no first Touch ID');
  w.frame({ run: 'r2', status: 'touch_old' });
  assert.deepEqual(steps(), ['creating', 'touch_old', 'touch_chip', 'simulating', 'checking']);
  assert.deepEqual(numbers(), ['1', '2', '3', '4', '5'], 'the steps shown are numbered in order');
  // A paper that is not the vault's is said calmly; old words are checked here first.
  const again = build({ vault: { chip: chipSlice({ state: 'broken', oldOnChain: false, paper: 'proven' }) } });
  again.answer.post['/api/vault/chip/restore'] = chipRefusal('not_your_paper');
  type(fields(again), OLD_PAPER);
  press(keyRow(again), 'Restore my vault');
  await flush();
  assert.equal(errorLine(keyRow(again)), String(chipRefusal('not_your_paper').error));
  type(fields(again), OLD_PAPER.slice(0, 23));
  press(keyRow(again), 'Try again');
  assert.equal(errorLine(keyRow(again)), 'Word 24 is still empty. Your paper key is 24 words.');
});

test('a vault moved here whose vault.json lost its chip entry reads one calm checking line, never the offer to move it, until NEAR answers', () => {
  const w = build({ vault: { chip: chipSlice({ state: 'checking', needs: ['open', 'gas'], oldOnChain: null, predecessorAuth: null, gas: null }) } });
  const row = keyRow(w);
  assert.ok(isShown(section(w)), 'the section shows while it checks');
  assert.ok(said(row).includes('Checking which keys open your vault, with NEAR. This takes a moment.'));
  for (const offer of ['opens your vault today', 'Move your vault to Touch ID', 'Restore your vault on this Mac']) assert.equal(said(row).includes(offer), false, offer);
  assert.equal(find(row, '.vault-step').filter(isShown).length, 0, 'no steps while it checks');
  for (const line of visible(row)) assert.equal(JARGON.test(line), false, line);
  // NEAR answered and vault.json names the chip again: who opens the vault.
  w.chip(MOVED());
  assert.ok(said(keyRow(w)).includes('This Mac\'s Touch ID key and your paper key open your vault, and nothing else does.'));
});

test('a restore that a failure or a restart cut short goes back to its own steps, never the move\'s', () => {
  const failed = build({ vault: { chip: chipSlice({ state: 'moving', oldOnChain: false, paper: 'retype', run: { id: 'r3', kind: 'restore', status: 'failed', reason: 'user_cancel', said: 'Touch ID was cancelled. Nothing changed.' } }) } });
  assert.ok(said(keyRow(failed)).includes('Restore your vault on this Mac'));
  const restarted = build({ vault: { chip: chipSlice({ state: 'moving', oldOnChain: false, paper: 'retype', run: null }) } });
  assert.ok(said(keyRow(restarted)).includes('Restore your vault on this Mac'));
  const migrate = build({ vault: { chip: chipSlice({ state: 'moving', oldOnChain: true, paper: 'retype', run: null }) } });
  assert.ok(said(keyRow(migrate)).includes('Move your vault to Touch ID'));
});

/* ---------- the allowance ---------- */

test('the allowance reads "$63 of $100", says the sweep in one line, and offers a top-up when it runs low', async () => {
  const w = build({ vault: { chip: MOVED() } });
  const row = rowOf(w, 'allowance');
  assert.ok(isShown(row));
  assert.equal(find(row, '.vault-row-value')[0].textContent, '$63 of $100');
  assert.ok(said(row).includes('What your assistant spends with no Touch ID. Anything over $110 goes back to your vault on its own, USDC first.'));
  assert.equal(find(row, '.vault-id')[0].textContent, '0x12ab5678...90abcd34');
  assert.equal(find(row, '.vault-warn').filter(isShown).length, 0);
  assert.equal(shownButtons(row).find((b: Any) => b.textContent === 'Top up')?.className, 'btn btn-quiet btn-sm');

  w.chip({ allowance: { account: ALLOWANCE, sizeUsd: 100, balanceUsd: 20 } });
  assert.equal(find(row, '.vault-row-value')[0].textContent, '$20 of $100');
  assert.ok(said(row).includes('Running low: under a quarter of its size. Top it up from your vault.'));
  assert.equal(shownButtons(row).find((b: Any) => b.textContent === 'Top up')?.className, 'btn btn-ghost btn-sm');
  press(row, 'Top up');
  const form = find(row, '.vault-topup')[0];
  assert.equal(form.hidden, false);
  assert.deepEqual(find(form, '.vault-chip').map((c: Any) => c.textContent), ['$25', '$50', 'Fill to $100']);
  assert.ok(said(form).includes('Up to $90 now: more would go straight back to your vault.'));
  assert.ok(said(form).includes('From your vault\'s USDC. Its card in the conversation waits for your click, then one Touch ID names the amount.'));
  assert.equal(find(form, '.vault-money-input')[0].value, '80');
  assert.equal(shownButtons(form)[shownButtons(form).length - 2].textContent, 'Top up $80');
  w.answer.post['/api/vault/allowance/top-up'] = { ok: true, proposal: { id: 'p-top', status: 'pending' } };
  form.dispatch('submit');
  await flush();
  assert.deepEqual(w.calls.filter((c) => c.route === '/api/vault/allowance/top-up').map((c) => [c.usd, c.why]), [[80, 'low']]);
  assert.ok(said(row).includes('Your top-up of $80 is on its card in the conversation. Approve it there; its Touch ID names the amount.'));
  // Gone once its card has an answer.
  w.put({ proposals: [{ id: 'p-top', status: 'pending' }] });
  assert.ok(said(row).includes('Your top-up of $80'));
  w.put({ proposals: [{ id: 'p-top', status: 'executed' }] });
  assert.equal(said(row).includes('Your top-up of $80'), false);

  // More than it can hold is said before anything is sent; a route's refusal is its own sentence.
  press(row, 'Top up');
  find(form, '.vault-money-input')[0].value = '500';
  form.dispatch('submit');
  assert.equal(errorLine(form), 'That is more than the allowance can hold. Up to $90 now.');
  w.answer.post['/api/vault/allowance/top-up'] = Object.assign(new Error('Your vault holds less USDC than that top-up. Nothing changed.'), { status: 400 });
  find(form, '.vault-money-input')[0].value = '30';
  form.dispatch('submit');
  await flush();
  assert.equal(errorLine(form), 'Your vault holds less USDC than that top-up. Nothing changed.');
  assert.equal(w.key('Escape'), true, 'Escape does not put the top-up away');
  assert.equal(form.hidden, true);
});

test('the allowance\'s size is the person\'s to set, $0 turns it off, and it shows only once the vault has moved', async () => {
  const w = build({ vault: { chip: MOVED() } });
  const row = rowOf(w, 'allowance');
  press(row, 'Change size');
  const form = find(row, '.vault-size')[0];
  assert.deepEqual(find(form, '.vault-chip').map((c: Any) => c.textContent), ['$25', '$50', '$100', '$250', '$500']);
  assert.equal(find(form, '.vault-chip').find((c: Any) => c.getAttribute('aria-checked') === 'true')?.textContent, '$100');
  find(form, '.vault-chip')[3].click();
  w.answer.post['/api/vault/allowance/size'] = { ok: true, sizeUsd: 250 };
  form.dispatch('submit');
  await flush();
  assert.deepEqual(w.calls.filter((c) => c.route === '/api/vault/allowance/size').map((c) => c.usd), [250]);
  assert.ok(said(row).includes('Your allowance is now $250. Anything over it plus 10 percent goes back to your vault.'));
  w.chip({ allowance: { account: ALLOWANCE, sizeUsd: 0, balanceUsd: 0 } });
  assert.equal(find(row, '.vault-row-value')[0].textContent, 'Off');
  assert.ok(said(row).includes('Your assistant spends nothing without your Touch ID, and anything in the allowance goes back to your vault on its own.'));
  assert.equal(shownButtons(row).some((b: Any) => b.textContent === 'Top up'), false);
  w.chip({ allowance: { account: ALLOWANCE, sizeUsd: 100, balanceUsd: null } });
  assert.equal(find(row, '.vault-row-value')[0].textContent, 'Size $100');
  assert.ok(said(row).includes('Phosphor could not read the allowance just now. It reads it again in a moment.'));
  const before = build();
  assert.equal(isShown(rowOf(before, 'allowance')), false, 'an allowance row before the move');
});

test('the two-touch card says the move\'s own Touch ID comes first, then the one that moves the difference from the vault', () => {
  const line = shortfallSentence({ symbol: 'USDC', decimals: 6 }, 1_000_000n, 2_000_001n);
  assert.equal(line, 'Your allowance holds 1 USDC, less than this move spends. Approve asks for two Touch IDs: the first approves this move, the second moves 2.000001 USDC from your vault to your allowance.');
  assert.ok(line.indexOf('the first approves this move') < line.indexOf('the second moves'));
  assert.ok(line.startsWith('Your allowance holds '), 'src/proposals/execute.ts askedFor keys on this start');
});

/* ---------- the gas account ---------- */

test('the gas account: its NEAR, low and empty said plainly, its id to check the Touch ID against, and a refill on its card', async () => {
  const w = build({ vault: { chip: chipSlice({ gas: { account: GAS, near: '0.4985', low: false } }) } });
  const row = rowOf(w, 'gas');
  assert.equal(find(row, '.vault-row-value')[0].textContent, '0.4985 NEAR');
  assert.ok(said(row).includes('Pays NEAR\'s small fee for every move of your vault.'));
  assert.equal(find(row, '.vault-id')[0].textContent, 'a1b2c3d4...e5f6a7b8');
  assert.ok(said(row).includes('A payout to it names a1b2c3d4...e5f6a7b8 in its Touch ID.'));
  assert.equal(find(row, '.vault-warn').filter(isShown).length, 0);
  w.chip({ gas: { account: GAS, near: '0.04', low: true } });
  assert.ok(said(row).includes('Low. Your vault\'s moves wait until it holds more NEAR.'));
  w.chip({ gas: { account: GAS, near: '0', low: true } });
  assert.ok(said(row).includes('Empty. Add NEAR before your vault can move.'));
  w.chip({ gas: { account: GAS, near: null, low: null } });
  assert.ok(said(row).includes('Phosphor could not read the gas account just now. It reads it again in a minute.'));

  press(row, 'Add NEAR');
  const form = find(row, '.vault-gas-add')[0];
  assert.deepEqual(find(form, '.vault-chip').map((c: Any) => c.textContent), ['0.25', '0.5', '1']);
  assert.ok(said(form).includes('From your vault, as a payout on NEAR. Its card in the conversation waits for your click, then one Touch ID names the gas account.'));
  assert.equal(shownButtons(form)[shownButtons(form).length - 2].textContent, 'Add 0.5 NEAR');
  find(form, '.vault-money-input')[0].value = '2';
  form.dispatch('submit');
  assert.equal(errorLine(form), 'Add between 0.1 and 1 NEAR, with four places at most.');
  find(form, '.vault-money-input')[0].value = '0.5';
  w.answer.post['/api/vault/gas/fund'] = { ok: true, proposal: { id: 'p-gas', status: 'pending' } };
  form.dispatch('submit');
  await flush();
  assert.deepEqual(w.calls.filter((c) => c.route === '/api/vault/gas/fund').map((c) => c.near), [0.5]);
  assert.ok(said(row).includes('Your payout of 0.5 NEAR is on its card in the conversation. Approve it there; its Touch ID names the gas account.'));
  // A card that never waited keeps its line until the tab is left.
  press(row, 'Add NEAR');
  w.answer.post['/api/vault/gas/fund'] = { ok: true, proposal: { id: 'p-gas-2', status: 'policy_refused' } };
  form.dispatch('submit');
  await flush();
  w.put({ proposals: [{ id: 'p-gas-2', status: 'policy_refused' }] });
  assert.ok(said(row).includes('Its card in the conversation says why the payout of 0.5 NEAR did not go ahead.'));
  w.leave();
  assert.equal(said(row).includes('did not go ahead'), false, 'the line outlived the tab');
  // A refusal is the route's own sentence.
  press(row, 'Add NEAR');
  w.answer.post['/api/vault/gas/fund'] = chipRefusal('fund_amount');
  form.dispatch('submit');
  await flush();
  assert.equal(errorLine(form), String(chipRefusal('fund_amount').error));
  // Once the vault has moved, the NEAR comes from the allowance.
  const moved = build({ vault: { chip: MOVED() } });
  press(rowOf(moved, 'gas'), 'Add NEAR');
  assert.ok(said(rowOf(moved, 'gas')).includes('From your allowance, as a payout on NEAR.'));
});

test('a vault on another Mac\'s keys pays no NEAR from here: Add NEAR shows the gas account whole, to send NEAR to it straight', async () => {
  const elsewhere = chipSlice({ state: 'broken', oldOnChain: false, predecessorAuth: false, elsewhere: true, needs: ['gas'], gas: { account: GAS, near: '0', low: true } });
  const w = build({ vault: { chip: elsewhere } });
  const copied: string[] = [];
  w.sandbox.PhosphorNetPick.copyChecked = (value: string, say: (words: string) => void) => {
    copied.push(value);
    say('Account copied, ends in ...' + value.slice(-6));
    return Promise.resolve(true);
  };
  w.chip({});
  const gas = rowOf(w, 'gas');
  assert.ok(said(gas).includes('Your vault opens with another Mac\'s Touch ID key now, so this Mac cannot pay NEAR from it. Send 0.1 to 1 NEAR on NEAR straight to this account, from any NEAR wallet:'));
  assert.deepEqual(find(gas, '.vault-mono').filter(isShown).map((n: Any) => n.textContent), [GAS], 'the account whole, not cut to its ends');
  assert.equal(shownButtons(gas).some((b: Any) => b.textContent === 'Add NEAR'), false, 'no payout from the vault is offered');
  press(gas, 'Copy');
  await flush();
  assert.deepEqual(copied, [GAS]);
  assert.ok(said(gas).includes('Account copied, ends in ...' + GAS.slice(-6)));
  // The restore's gas step says where NEAR goes, and its button brings the account into view.
  const key = keyRow(w);
  assert.ok(said(key).includes('if not, send it 0.1 to 1 NEAR on NEAR from any NEAR wallet. Its account is in the Gas account row below.'));
  press(key, 'Show the gas account');
  assert.equal(gas.scrolled, true);
  assert.equal(find(gas, '.vault-gas-add')[0].hidden, true, 'no payout form');
  for (const line of visible(section(w))) assert.equal(JARGON.test(line), false, line);
  // A form opened before NEAR's word came goes, and the route's refusal says why.
  const before = build({ vault: { chip: chipSlice({ state: 'broken', oldOnChain: false, needs: ['gas'], gas: { account: GAS, near: '0', low: true } }) } });
  const row = rowOf(before, 'gas');
  press(row, 'Add NEAR');
  const form = find(row, '.vault-gas-add')[0];
  before.answer.post['/api/vault/gas/fund'] = Object.assign(chipRefusal('fund_elsewhere'), { gas: GAS });
  before.answer.onRefresh = () => before.chip({ elsewhere: true });
  form.dispatch('submit');
  await flush();
  assert.equal(form.hidden, true, 'the payout form is gone');
  assert.ok(said(row).includes('Send 0.1 to 1 NEAR on NEAR straight to this account'));
  assert.ok(said(row).includes(GAS));
});

/* ---------- the trading key ---------- */

test('Allow trading on Hyperliquid: one Touch ID whose sentence the row names first, and the way past each refusal', async () => {
  const w = build({ vault: { chip: MOVED() } });
  await flush();
  const row = rowOf(w, 'trading');
  assert.ok(isShown(row), 'no trading key row after the move');
  assert.ok(said(row).includes('Your plans trade on Hyperliquid with a trading key. One Touch ID lets a new one trade for 90 days.'));
  assert.ok(said(row).includes('Its Touch ID reads: Let 0x77aa5678...deadbe01 trade on your Hyperliquid account for 90 days.'));
  const until = Date.UTC(2027, 0, 2, 12);
  w.answer.post['/api/vault/trading-key/allow'] = { ok: true, address: NEXT_AGENT, version: 1, validUntil: until, days: 90 };
  w.answer.trading = { moved: true, key: { address: NEXT_AGENT, version: 1, validUntil: until, approvedAt: Date.now(), expired: false }, next: null, days: 90 };
  press(row, 'Allow trading on Hyperliquid');
  await flush();
  const allow = w.calls.filter((c) => c.route === '/api/vault/trading-key/allow');
  assert.equal(allow.length, 1);
  assert.equal(allow[0].touch, true, 'the allow does not wait like a Touch ID route');
  // Read with its spaces folded: the date's own are non-breaking, so "Jan" never ends a line.
  assert.ok(said(row).includes('0x77aa5678...deadbe01 can trade on your Hyperliquid account until Jan 2, 2027.'), said(row));
  assert.ok(visible(row).some((t: string) => t.includes('Jan\u00a02,\u00a02027')), 'the date breaks across lines');

  const reopen = build({ vault: { chip: MOVED() } });
  await flush();
  reopen.answer.post['/api/vault/trading-key/allow'] = { ok: false, code: 'reopen', error: 'Lock your wallet and open it again first, so it can make the next trading key. Nothing changed.' };
  press(rowOf(reopen, 'trading'), 'Allow trading on Hyperliquid');
  await flush();
  assert.equal(errorLine(rowOf(reopen, 'trading')), 'Lock your wallet and open it again first, so it can make the next trading key. Nothing changed.');
  press(rowOf(reopen, 'trading'), 'Lock now');
  await flush();
  assert.equal(reopen.calls.filter((c) => c.route === '/api/lock').length, 1);

  const venue = build({ vault: { chip: MOVED() } });
  await flush();
  venue.answer.post['/api/vault/trading-key/allow'] = { ok: false, code: 'refused', error: 'Hyperliquid did not approve the new trading key, so nothing changed.', venue: '<b>Extra agent already used</b>' };
  press(rowOf(venue, 'trading'), 'Allow trading on Hyperliquid');
  await flush();
  assert.ok(said(rowOf(venue, 'trading')).includes('Hyperliquid said: <b>Extra agent already used</b>'), 'the venue\'s words are not said as text');
  const cancel = build({ vault: { chip: MOVED() } });
  await flush();
  cancel.answer.post['/api/vault/trading-key/allow'] = { ok: false, code: 'user_cancel', error: 'Touch ID was cancelled. Nothing changed.' };
  press(rowOf(cancel, 'trading'), 'Allow trading on Hyperliquid');
  await flush();
  assert.equal(find(rowOf(cancel, 'trading'), '.vault-error')[0].getAttribute('data-tone'), 'quiet');
});

test('a trading key near its end, or past it, is said with why it matters, and a vault that never moved has no trading key row', async () => {
  const soon = build({ vault: { chip: MOVED() } });
  soon.answer.trading = { moved: true, key: { address: NEXT_AGENT, version: 2, validUntil: Date.now() + 3 * 86_400_000, approvedAt: Date.now(), expired: false }, next: NEXT_AGENT, days: 90 };
  soon.chip({ state: 'broken' });
  soon.chip({ state: 'done' });
  await flush();
  assert.ok(said(rowOf(soon, 'trading')).includes('Allow a new one before then: without a trading key, Freeze cannot close your positions.'));
  const ended = build({ vault: { chip: MOVED() } });
  ended.answer.trading = { moved: true, key: { address: NEXT_AGENT, version: 2, validUntil: Date.now() - 1000, approvedAt: Date.now() - 1e9, expired: true }, next: NEXT_AGENT, days: 90 };
  ended.chip({ state: 'broken' });
  ended.chip({ state: 'done' });
  await flush();
  assert.equal(find(rowOf(ended, 'trading'), '.vault-row-value')[0].textContent, 'Ended');
  assert.ok(said(rowOf(ended, 'trading')).includes('Your trading key has ended. Allow a new one so your plans can trade and Freeze can close your positions.'));
  const before = build();
  await flush();
  assert.equal(isShown(rowOf(before, 'trading')), false);
  assert.equal(before.calls.some((c) => c.route === 'GET /api/vault/trading-key'), false, 'the trading key is read before the vault moved');
});

/* ---------- every face, read as a person reads it ---------- */

test('no face of Your vault says a part underneath, and every button is one of the Vault\'s own families', async () => {
  const faces: Array<[string, Any]> = [
    ['offer', chipSlice({ needs: ['backup', 'gas'] })],
    ['paper', chipSlice()],
    ['typeback', chipSlice({ paper: 'shown' })],
    ['move', chipSlice({ paper: 'proven' })],
    ['moving', chipSlice({ state: 'moving', run: { id: 'r', kind: 'migrate', status: 'touch_chip', reason: null, said: null } })],
    ['failed', chipSlice({ paper: 'proven', run: { id: 'r', kind: 'migrate', status: 'failed', reason: 'vault_unknown', said: '' } })],
    ['moved', MOVED({ predecessorAuth: true, otherKeys: ['secp256k1:abc'] })],
    ['broken', chipSlice({ state: 'broken', oldOnChain: false })],
  ];
  const families = new Set(['btn btn-sm', 'btn btn-ghost btn-sm', 'btn btn-quiet btn-sm', 'vault-chip num']);
  for (const [face, chip] of faces) {
    const w = build({ vault: { chip } });
    await flush();
    for (const line of visible(section(w))) assert.equal(JARGON.test(line), false, `${face}: "${line}"`);
    for (const b of find(section(w), 'button')) assert.ok(families.has(b.className), `${face}: a button of a new family, "${b.className}"`);
  }
});

/* ---------- the agent's line while the vault moves ---------- */

function agentWorld(): { host: Any; select: Record<string, (slice: Any) => void>; emit: (event: Any) => void } {
  const host = makeNode('div');
  const composerHost = makeNode('div');
  const driverHandlers: Array<(frame: Any) => void> = [];
  const select: Record<string, (slice: Any) => void> = {};
  const win: Any = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: () => ({ lineHeight: '21px', paddingTop: '8px', paddingBottom: '8px' }),
    dispatchEvent: () => true,
    addEventListener: () => {},
    PhosphorNet: { readable: (e: Error) => String(e.message) },
    PhosphorShell: { setPending: () => {} },
    PhosphorToast: { show: () => {} },
    ResizeObserver: function ResizeObserverStub(this: Any) { this.observe = () => {}; },
    PhosphorApi: {
      driver: () => Promise.resolve({}),
      driverState: () => Promise.resolve({ data: { state: 'ready', chats: [{ id: 'c1', transcript: [] }], agent: { id: 'claude', name: 'Claude Code', inApp: true, reason: null } } }),
      connection: () => Promise.resolve({ command: '', connected: [] }),
    },
    PhosphorEvents: { on: (type: string, fn: (frame: Any) => void) => { if (type === 'driver') driverHandlers.push(fn); } },
    PhosphorIcons: { svg: () => makeNode('svg') },
    PhosphorMotion: { reduced: () => false, spring: () => 'linear', animate: (_f: unknown, to: number, o: Any) => { if (o && o.onUpdate) o.onUpdate(to); return { finished: Promise.resolve(), stop() {} }; } },
    PhosphorState: { select: (key: string, fn: (slice: Any) => void) => { select[key] = fn; return () => {}; } },
  };
  const sandbox: Any = { console, navigator: {}, window: win, document: { createElement: makeNode, addEventListener: () => {}, documentElement: { dataset: {} } } };
  sandbox.CustomEvent = function CustomEventStub(this: Any, t: string) { this.type = t; };
  createContext(sandbox);
  runInContext(DOM, sandbox);
  runInContext(MARKS_JS, sandbox);
  runInContext(MARKDOWN_JS, sandbox);
  runInContext(AGENT_JS, sandbox);
  win.PhosphorAgent.mount(host, { composerHost });
  win.PhosphorAgent.start();
  const emit = (event: Any): void => { for (const fn of driverHandlers) fn({ chat: 'c1', event }); };
  emit({ kind: 'status', state: 'ready' });
  return { host, select, emit };
}

test('while the vault moves, the agent\'s head says in one calm line that its moves wait, and goes back after', async () => {
  const w = agentWorld();
  await flush();
  w.emit({ kind: 'said', text: 'hello' });
  const who = (): Any => find(w.host, '.agent-who')[0];
  assert.equal(who().textContent, 'Claude Code is ready');
  w.select.vault({ chip: chipSlice({ state: 'moving', moving: true, run: { id: 'r1', kind: 'migrate', status: 'touch_old', reason: null, said: null } }) });
  assert.equal(who().textContent, 'Your vault is moving. Claude Code\'s moves wait.');
  assert.equal(who().getAttribute('data-moving'), 'true');
  w.select.vault({ chip: MOVED({ run: { id: 'r1', kind: 'migrate', status: 'done', reason: null, said: null } }) });
  assert.equal(who().textContent, 'Claude Code is ready');
  assert.equal(who().getAttribute('data-moving'), null);
  // A failed move pauses nothing, and Freeze still says itself first.
  w.select.vault({ chip: chipSlice({ state: 'moving', run: { id: 'r2', kind: 'migrate', status: 'failed', reason: 'user_cancel', said: null } }) });
  assert.equal(who().textContent, 'Claude Code is ready');
  w.select.policy({ killSwitch: true });
  w.select.vault({ chip: chipSlice({ state: 'moving', moving: true, run: { id: 'r3', kind: 'migrate', status: 'creating', reason: null, said: null } }) });
  assert.equal(who().textContent, 'Everything is frozen. Claude Code can read, but no money moves.');
});

test('after a restart mid-move the agent\'s head reads the fact that holds its moves, not the run this process no longer has', async () => {
  const w = agentWorld();
  await flush();
  w.emit({ kind: 'said', text: 'hello' });
  const who = (): Any => find(w.host, '.agent-who')[0];
  // A move bundle written down before the restart can still run: agents are held, and no run is in hand.
  w.select.vault({ chip: chipSlice({ state: 'moving', paper: 'retype', run: null, moving: true }) });
  assert.equal(who().textContent, 'Your vault is moving. Claude Code\'s moves wait.');
  assert.equal(who().getAttribute('data-moving'), 'true');
  // NEAR can no longer run it: the hold is gone, and so is the line, whatever the run says.
  w.select.vault({ chip: chipSlice({ state: 'moving', paper: 'retype', run: null, moving: false }) });
  assert.equal(who().textContent, 'Claude Code is ready');
  w.select.vault({ chip: chipSlice({ state: 'moving', moving: false, run: { id: 'r4', kind: 'migrate', status: 'checking', reason: null, said: null } }) });
  assert.equal(who().textContent, 'Claude Code is ready', 'the line never says more than the hold');
});

/* ---------- the docs ---------- */

test('getting-started.md says the same two plain sentences as the paper key\'s screen', () => {
  const flat = GETTING_STARTED.replace(/\s+/g, ' ');
  assert.ok(flat.includes('Your paper key is the only key that opens your vault away from this Mac.'));
  assert.ok(flat.includes('Your recovery phrase also controls your allowance (at most its size plus 10 percent) and the gas account (about 0.5 NEAR), so keep both like cash.'));
  assert.ok(flat.includes('On a wallet with no recovery phrase, that second backup is your private key.'));
  assert.ok(flat.includes(MOVE_VAULT_REASON));
  assert.ok(flat.includes("confirm this Mac's Touch ID key for your vault"));
  assert.equal(DASHES.test(GETTING_STARTED), false, 'a dash in the docs');
});
