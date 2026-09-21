// The Vault tab's Agent panel: the chosen agent, its state from the same check the first run
// makes, Change (the same picker, in the panel) and Check again.
//
// Run for real over a small DOM (the pattern of vault-tab-ui.test.ts) with vault.js and the
// picker from firstrun.js loaded together, the api module replaced by a recorder. What is
// proven: the check runs when the tab opens; the sentence and the chip follow the answer, one
// sentence at a time; an agent that has gone reads "is no longer on this Mac" with the light
// off and nothing thrown; the light follows the roster; Change draws the six tiles in place and
// Done brings the summary back with a fresh check; a switch the app refuses is that sentence;
// leaving the tab closes the picker; and nothing the network said is printed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const VAULT = read('../../ui/screens/vault.js');
const FIRSTRUN = read('../../ui/screens/firstrun.js');

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
    tabIndex: 0,
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
    addEventListener(type: string, fn: (event: Any) => void) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type: string, event: Any = {}) {
      for (const fn of listeners[type] ?? []) fn(Object.assign({ target: node, currentTarget: node, preventDefault() {} }, event));
    },
    click() { node.dispatch('click'); },
    focus() { node.focused = true; },
    contains(other: Any) {
      for (let n = other; n; n = n.parentNode) if (n === node) return true;
      return false;
    },
    querySelector(selector: string) { return find(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return find(node, selector); },
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

function shown(node: Any): boolean {
  for (let n = node; n; n = n.parentNode) if (n.hidden) return false;
  return true;
}

function visibleText(node: Any): string[] {
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

const buttonNamed = (root: Any, label: string): Any => find(root, 'button').find((b: Any) => !b.hidden && b.textContent === label) as Any;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- the window ---------- */

type Answer = Record<string, unknown> | Error;
type World = { view: Any; calls: Any[]; toasts: string[]; answers: Record<string, Answer>; store: Any; show: (view: string) => void };

const CODEX_IN = { agent: 'codex', name: 'Codex', state: 'installed_and_logged_in', probed: true, sentence: 'Codex is signed in: start it in your terminal and it will appear here.', details: ['Made by OpenAI.', 'Found at /Users/x/bin/codex, codex-cli 0.154.0.'], version: 'codex-cli 0.154.0', bin: '/Users/x/bin/codex', inApp: false, registers: true, ms: 40 };
const CODEX_OUT = { ...CODEX_IN, state: 'installed_not_logged_in', sentence: 'Codex is installed but not signed in. Sign in in your terminal, then press Check again.' };
const CODEX_GONE = { ...CODEX_IN, state: 'not_installed', sentence: 'Codex is no longer on this Mac.', bin: null, version: null, details: ['Made by OpenAI.', 'Install: npm install -g @openai/codex'] };

function build(): World {
  const view = makeNode('section');
  const page = makeNode('div');
  const body = makeNode('body');
  const head = makeNode('head');
  const calls: Any[] = [];
  const toasts: string[] = [];
  const answers: Record<string, Answer> = {
    'agent-check': { ok: true, check: null, picked: null, command: null },
    'agent-scan': { ok: true, agents: [], picked: null },
  };
  const doc: Any = {
    body,
    head,
    createElement: makeNode,
    getElementById: (id: string) => (id === 'view-vault' ? view : id === 'page' ? page : null),
    addEventListener() {},
  };
  const viewListeners: Array<(event: Any) => void> = [];
  const sandbox: Any = {
    console,
    document: doc,
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    addEventListener(type: string, fn: (event: Any) => void) { if (type === 'phosphor:view') viewListeners.push(fn); },
    removeEventListener() {},
    Math,
    Promise,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  };
  sandbox.window = sandbox;
  const answerFor = (key: string): Promise<unknown> => {
    const answer = answers[key];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? {});
  };
  sandbox.PhosphorNet = { readable: (e: Any) => `RAW:${String(e && e.message ? e.message : e)}` };
  sandbox.PhosphorMotion = { reduced: () => true };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean) { button.disabled = !!pending; button.pending = !!pending; },
    refresh: () => Promise.resolve(),
    setView: (name: string) => { calls.push({ route: 'setView', view: name }); },
    view: () => 'vault',
  };
  sandbox.PhosphorToast = { show: (message: string) => { toasts.push(message); } };
  sandbox.PhosphorConfirm = { ask: () => Promise.resolve(true) };
  sandbox.PhosphorNetPick = {
    NETWORKS: [{ id: 'eth', name: 'Ethereum', mark: 'ETH', colour: '#627EEA' }, { id: 'base', name: 'Base', mark: 'BASE', colour: '#0052FF' }],
    render: () => ({ destroy() {} }),
  };
  sandbox.PhosphorDeposit = { open: () => Promise.resolve(null), copyChecked: () => Promise.resolve(true), networkWords: (c: string) => c, defaultSymbol: () => '', chunks: (a: string) => [a] };
  sandbox.PhosphorMoneyIn = { render: () => {}, revealWithPassword() {}, exportWithPassword() {} };
  sandbox.PhosphorApi = {
    receive: () => Promise.resolve({ data: { chains: [], state: 'unlocked', verified: true, tampered: false } }),
    intentsReceive: () => Promise.resolve({ data: { networks: [] } }),
    driver: (payload: Any) => { calls.push({ route: '/api/driver', ...payload }); return answerFor(payload.action); },
    connection: () => Promise.resolve({ missing: true }),
  };

  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(FIRSTRUN, sandbox, { filename: 'ui/screens/firstrun.js' });
  runInContext(VAULT, sandbox, { filename: 'ui/screens/vault.js' });

  const store = sandbox.PhosphorState;
  store.put({
    lock: { state: 'unlocked', idleLocksInSec: null },
    vault: { custody: 'secure-enclave', state: 'unlocked', enclave: { attached: true, ready: true, capability: {}, keyMadeAt: null, binding: 'device' }, foreign: false, waiting: null, backedUp: true, backedUpAt: null, idleMinutes: 15, hasMnemonic: true },
    policy: { outbound: { humanClickAboveUsd: 100 } },
    agents: { members: [] },
  });
  sandbox.PhosphorVault.boot();
  return {
    view,
    calls,
    toasts,
    answers,
    store,
    show: (name: string) => { for (const fn of viewListeners) fn({ detail: { view: name } }); },
  };
}

const panel = (world: World): Any => find(world.view, '.panel').find((p: Any) => p.dataset.surface === 'agent') as Any;
const chipText = (world: World): string => find(panel(world), '.card-head-right')[0].textContent;
const chipTone = (world: World): string | null => find(find(panel(world), '.card-head-right')[0], '.chip')[0].getAttribute('data-tone');
const sentences = (world: World): string[] => find(panel(world), '.agentpick-sentence').filter(shown).map((n: Any) => n.textContent).filter((t: string) => t !== '');
const light = (world: World): string | null => find(panel(world), '.agentpick-light')[0].getAttribute('data-state');
const summary = (world: World): Any => find(panel(world), '.vault-agent')[0];
const tileOf = (world: World, id: string): Any => find(panel(world), '.agent-tile').find((t: Any) => t.dataset.agent === id) as Any;

/* ---------- the source ---------- */

test('the panel prints nothing the network said and raises no toast about the agent', () => {
  const block = VAULT.slice(VAULT.indexOf('---------- the agent panel ----------'), VAULT.indexOf('function renderIdle'));
  assert.ok(block.length > 1000, 'the agent panel block was not found');
  assert.equal(/readable\(/.test(block), false);
  assert.equal(/PhosphorToast/.test(block), false);
});

/* ---------- the summary ---------- */

test('the panel has the two facts, the rules as a third, one sentence, and Change, Check again, Your rules', () => {
  const world = build();
  const node = panel(world);
  const labels = find(node, '.fact').map((f: Any) => find(f, '.label')[0].textContent);
  assert.deepEqual(labels, ['It can see', 'It cannot see', 'Your rules']);
  assert.ok(visibleText(node).some((t) => t.startsWith('Moves under $100 run without a click')));
  assert.deepEqual(find(node, 'button').filter((b: Any) => !b.hidden).map((b: Any) => b.textContent), ['Change', 'Check again', 'Your rules']);
  assert.deepEqual(sentences(world), ['No assistant is picked yet.']);
  assert.equal(chipText(world), 'None yet');
  assert.equal(chipTone(world), 'warn');
});

test('opening the tab runs the check; the sentence and the chip follow the answer, one sentence at a time', async () => {
  const world = build();
  world.answers['agent-check'] = { ok: true, check: CODEX_OUT, picked: 'codex', command: 'codex mcp add phosphor -- node /x' };
  world.show('vault');
  assert.deepEqual(sentences(world), ['Checking on this Mac.']);
  await flush();
  assert.equal(world.calls.filter((c) => c.action === 'agent-check').length, 1);
  assert.deepEqual(sentences(world), [CODEX_OUT.sentence]);
  assert.equal(chipText(world), 'Codex: Not signed in');
  assert.equal(chipTone(world), 'warn');
  assert.equal(light(world), 'off');
  assert.ok(!visibleText(panel(world)).some((t) => t.includes('/Users/')), 'a path is on the panel');

  world.answers['agent-check'] = { ok: true, check: CODEX_IN, picked: 'codex', command: 'x' };
  buttonNamed(panel(world), 'Check again').click();
  assert.equal(buttonNamed(panel(world), 'Check again').pending, true);
  await flush();
  await flush();
  assert.deepEqual(sentences(world), [CODEX_IN.sentence]);
  assert.equal(chipText(world), 'Codex: Signed in');
  assert.equal(chipTone(world), 'up');
  assert.equal(buttonNamed(panel(world), 'Check again').pending, false);
  assert.equal(world.toasts.length, 0);
});

test('an agent that has since gone reads "is no longer on this Mac", the light is off, and nothing throws', async () => {
  const world = build();
  world.answers['agent-check'] = { ok: true, check: CODEX_GONE, picked: 'codex', command: 'x' };
  world.show('vault');
  await flush();
  assert.deepEqual(sentences(world), ['Codex is no longer on this Mac.']);
  assert.equal(chipText(world), 'Codex: Not on this Mac');
  assert.equal(chipTone(world), 'down');
  assert.equal(light(world), 'off');
  assert.equal(world.toasts.length, 0);
  assert.equal(buttonNamed(panel(world), 'Change').hidden, false, 'the way to another agent is gone');
});

test('the light follows the roster: on and "is connected" while a client of the agent is on the door, off and back when it leaves', async () => {
  const world = build();
  world.answers['agent-check'] = { ok: true, check: CODEX_IN, picked: 'codex', command: 'x' };
  world.show('vault');
  await flush();
  world.store.put({ ...world.store.get(), agents: { members: [{ client: 'codex-cli', label: 'codex', ops: 3 }] } });
  assert.equal(light(world), 'ready');
  assert.deepEqual(sentences(world), ['Codex is connected.']);
  assert.equal(chipText(world), 'Codex: Ready');
  world.store.put({ ...world.store.get(), agents: { members: [] } });
  assert.equal(light(world), 'off');
  assert.deepEqual(sentences(world), [CODEX_IN.sentence]);
  assert.equal(chipText(world), 'Codex: Signed in');
});

test('when the app does not answer the panel says so in its own words, over the same Check again', async () => {
  const world = build();
  world.answers['agent-check'] = new Error('Failed to fetch');
  world.show('vault');
  await flush();
  await flush();
  assert.deepEqual(sentences(world), ['Phosphor could not check right now. Press Check again.']);
  assert.ok(!visibleText(panel(world)).some((t) => t.includes('RAW:') || t.includes('Failed to fetch')));
  assert.equal(buttonNamed(panel(world), 'Check again').disabled, false);
  assert.equal(world.toasts.length, 0);
});

/* ---------- change ---------- */

test('Change draws the same six tiles in the panel over the summary; Done brings the summary back with a fresh check', async () => {
  const world = build();
  world.answers['agent-check'] = { ok: true, check: CODEX_IN, picked: 'codex', command: 'x' };
  world.show('vault');
  await flush();
  buttonNamed(panel(world), 'Change').click();
  await flush();
  assert.equal(summary(world).hidden, true, 'the summary is still up under the picker');
  const tiles = find(panel(world), '.agent-tile');
  assert.deepEqual(tiles.map((t: Any) => t.dataset.agent), ['claude', 'codex', 'hermes', 'grok', 'mcp', 'desktop']);
  assert.equal(tileOf(world, 'codex').getAttribute('aria-current'), 'true', 'the picked agent is not current');
  assert.equal(sentences(world).length <= 1, true, 'more than one sentence on the panel');

  const before = world.calls.filter((c) => c.action === 'agent-check').length;
  world.answers['agent-check'] = { ok: true, check: { ...CODEX_IN, agent: 'grok', name: 'Grok', sentence: 'Grok is signed in: start it in your terminal and it will appear here.' }, picked: 'grok', command: 'x' };
  buttonNamed(panel(world), 'Done').click();
  await flush();
  assert.equal(find(panel(world), '.agent-tile').length, 0, 'the tiles survived Done');
  assert.equal(summary(world).hidden, false);
  assert.ok(world.calls.filter((c) => c.action === 'agent-check').length > before, 'Done did not check again');
  assert.deepEqual(sentences(world), ['Grok is signed in: start it in your terminal and it will appear here.']);
  assert.equal(chipText(world), 'Grok: Signed in');
});

test('a switch the app refuses while an agent is running is that one sentence, and the pick stays', async () => {
  const world = build();
  world.answers['agent-check'] = { ok: true, check: CODEX_IN, picked: 'codex', command: 'x' };
  world.answers['agent-pick'] = { ok: false, refused: 'running', sentence: 'Your assistant is running. Turn it off in the chat, then change it here.', picked: 'codex' };
  world.show('vault');
  await flush();
  buttonNamed(panel(world), 'Change').click();
  tileOf(world, 'claude').click();
  await flush();
  assert.deepEqual(sentences(world), ['Your assistant is running. Turn it off in the chat, then change it here.']);
  assert.equal(tileOf(world, 'codex').getAttribute('aria-current'), 'true');
  assert.equal(tileOf(world, 'claude').getAttribute('aria-current'), null);
  assert.equal(world.toasts.length, 0);
});

test('a pick that lands is written once, and leaving the tab closes the picker', async () => {
  const world = build();
  world.answers['agent-check'] = { ok: true, check: CODEX_IN, picked: 'codex', command: 'x' };
  world.answers['agent-pick'] = { ok: true, check: { ...CODEX_IN, agent: 'hermes', name: 'Hermes', sentence: 'Hermes is signed in: start it in your terminal and it will appear here.' }, registered: true, registrationFailed: false, command: 'hermes mcp add phosphor', picked: 'hermes' };
  world.show('vault');
  await flush();
  buttonNamed(panel(world), 'Change').click();
  tileOf(world, 'hermes').click();
  await flush();
  assert.equal(world.calls.filter((c) => c.action === 'agent-pick').length, 1);
  assert.deepEqual(sentences(world), ['Hermes is signed in: start it in your terminal and it will appear here.']);
  world.show('basic');
  assert.equal(find(panel(world), '.agent-tile').length, 0, 'the picker survived leaving the tab');
  assert.equal(summary(world).hidden, false);
});
