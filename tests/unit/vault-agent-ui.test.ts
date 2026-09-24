// The Vault's assistant list: one row per agent in the catalog, each with its mark, one plain
// state and one action, Use.
//
// Run for real over a small DOM (the pattern of vault-tab-ui.test.ts) with vault.js and the
// list from firstrun.js loaded together, the api module replaced by a recorder. What is proven:
// opening the Vault scans this Mac; every row says one true state (Ready, Runs in your
// terminal, Not signed in, Not installed, Connects from outside, Cannot drive Phosphor) with
// the line that says how when there is something to do; Use is one round trip, the row in use
// says so, and the chat hears about it; a switch the app refuses is that one sentence and the
// pick stays; a terminal agent on the door reads Connected; an app that does not answer is
// said in the list's own words; and nothing the network said is printed. No dots, no chips.

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
    CustomEvent: function (type: string, init?: Any) { return { type, detail: init?.detail }; },
    dispatchEvent: (ev: Any) => { calls.push({ route: 'event', type: ev.type }); },
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

const section = (world: World): Any => find(world.view, '.vault-sec').find((p: Any) => p.dataset.surface === 'agent') as Any;
const rows = (world: World): Any[] => find(section(world), '.agentrow');
const rowOf = (world: World, id: string): Any => rows(world).find((r: Any) => r.dataset.agent === id) as Any;
const stateOf = (world: World, id: string): string => find(rowOf(world, id), '.agentrow-state')[0].textContent;
const lineOf = (world: World, id: string): string => {
  const line = find(rowOf(world, id), '.agentrow-line')[0];
  return line && !line.hidden ? line.textContent : '';
};
const commandOf = (world: World, id: string): string => {
  const cmd = find(rowOf(world, id), '.agentrow-cmd')[0];
  return cmd && !cmd.hidden ? find(cmd, '.agentrow-code')[0].textContent : '';
};
const status = (world: World): string => {
  const node = find(section(world), '.agentpick-status')[0];
  return node && !node.hidden ? node.textContent : '';
};
const useOf = (world: World, id: string): Any => find(rowOf(world, id), '.agentrow-use')[0];

const CLAUDE_IN = { agent: 'claude', name: 'Claude Code', state: 'installed_and_logged_in', probed: true, sentence: 'Claude Code is signed in and ready to start.', details: ['Made by Anthropic.', 'Found at /Users/x/.local/bin/claude, 2.1.281.', 'Install: curl -fsSL https://claude.ai/install.sh | bash', 'Sign in: claude auth login'], version: '2.1.281', bin: '/Users/x/.local/bin/claude', inApp: true, registers: true, ms: 30 };
const GROK_OUT = { agent: 'grok', name: 'Grok', state: 'installed_not_logged_in', probed: true, sentence: 'Grok is installed but not signed in. Sign in in your terminal, then press Check again.', details: ['Made by xAI.', 'Install: curl -fsSL https://x.ai/cli/install.sh | bash', 'Sign in: grok login'], version: '1.0.40', bin: '/Users/x/.grok/bin/grok', inApp: true, registers: true, ms: 50 };
const HERMES_NONE = { agent: 'hermes', name: 'Hermes', state: 'not_installed', probed: true, sentence: 'Hermes is not on this Mac yet. Install it, then come back to this screen.', details: ['Made by Nous Research.', 'Install: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', 'Sign in: hermes model'], version: null, bin: null, inApp: false, registers: true, ms: 5 };

function scanWith(picked: string | null): Any {
  return { ok: true, agents: [CLAUDE_IN, CODEX_IN, HERMES_NONE, GROK_OUT], picked };
}

async function opened(picked: string | null = 'codex'): Promise<World> {
  const world = build();
  world.answers['agent-scan'] = scanWith(picked);
  world.show('vault');
  await flush();
  await flush();
  return world;
}

/* ---------- the source ---------- */

test('the list prints nothing the network said and raises no toast about the agent', () => {
  const block = FIRSTRUN.slice(FIRSTRUN.indexOf('/* The agent list, one component for two hosts'));
  assert.ok(block.length > 3000, 'the agent list was not found');
  assert.equal(/readable\(/.test(block), false);
  assert.equal(/PhosphorToast/.test(block), false);
  assert.equal(/innerHTML|insertAdjacentHTML/.test(block), false);
  assert.equal(/agentpick-light|agent-tile|'dot'|chip/.test(block), false, 'a light, a tile or a chip is back');
});

/* ---------- the rows ---------- */

test('opening the Vault scans this Mac; one row per agent in the catalog\'s order, with its mark and name', async () => {
  const world = await opened();
  assert.equal(world.calls.filter((c) => c.action === 'agent-scan').length, 1);
  assert.deepEqual(rows(world).map((r: Any) => r.dataset.agent), ['claude', 'codex', 'hermes', 'grok', 'mcp', 'desktop']);
  assert.deepEqual(rows(world).map((r: Any) => find(r, '.agentrow-mark')[0].textContent), ['CC', 'Cx', 'He', 'Gr', 'A', 'Ch']);
  assert.deepEqual(rows(world).map((r: Any) => find(r, '.agentrow-name')[0].textContent),
    ['Claude Code', 'Codex', 'Hermes', 'Grok', 'Another agent', 'Claude Desktop or a chat app']);
  assert.equal(find(section(world), '.chip').length, 0);
  assert.equal(find(section(world), '.agent-tile').length, 0);
});

test('every row says one plain state, and the line that says how when there is something to do', async () => {
  const world = await opened();
  assert.equal(stateOf(world, 'claude'), 'Ready');
  assert.equal(lineOf(world, 'claude'), '', 'a ready row needs no line');
  assert.equal(stateOf(world, 'codex'), 'Runs in your terminal');
  assert.equal(lineOf(world, 'codex'), CODEX_IN.sentence, 'the reason is the app\'s own sentence');
  assert.equal(stateOf(world, 'hermes'), 'Not installed');
  assert.equal(commandOf(world, 'hermes'), 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash');
  assert.ok(find(rowOf(world, 'hermes'), '.agentrow-copy')[0], 'no Copy beside the install line');
  assert.equal(stateOf(world, 'grok'), 'Not signed in');
  assert.equal(commandOf(world, 'grok'), 'grok login');
  assert.equal(stateOf(world, 'mcp'), 'Connects from outside');
  assert.equal(lineOf(world, 'mcp'), 'Paste one line into it and it joins this window.');
  assert.equal(stateOf(world, 'desktop'), 'Cannot drive Phosphor');
  assert.ok(lineOf(world, 'desktop').startsWith('A chat app cannot drive Phosphor yet.'));
  // No path, version or maker on the face of any row.
  assert.ok(!visibleText(section(world)).some((t) => t.includes('/Users/') || t.startsWith('Made by')), JSON.stringify(visibleText(section(world))));
});

test('Use is offered only where a pick can do something, and the agent in use says so in its place', async () => {
  const world = await opened('codex');
  const offered = rows(world).filter((r: Any) => !find(r, '.agentrow-use')[0].hidden).map((r: Any) => r.dataset.agent);
  assert.deepEqual(offered, ['claude', 'grok', 'mcp'], 'Use on a row it cannot help, or missing from one it can');
  const codex = rowOf(world, 'codex');
  assert.equal(codex.getAttribute('aria-current'), 'true');
  assert.equal(find(codex, '.agentrow-current')[0].hidden, false);
  assert.equal(find(codex, '.agentrow-current')[0].textContent, 'Your assistant');
  assert.equal(useOf(world, 'claude').getAttribute('aria-label'), 'Use Claude Code');
  assert.ok(!useOf(world, 'claude').className.includes('btn-primary'), 'green is for Approve');
});

test('Use is one round trip: the row turns current, the chat hears about it, nothing is printed but the app\'s words', async () => {
  const world = await opened('codex');
  world.answers['agent-pick'] = { ok: true, check: CLAUDE_IN, registered: true, registrationFailed: false, command: 'claude mcp add phosphor -- node /x', picked: 'claude' };
  useOf(world, 'claude').click();
  assert.equal(status(world), 'Checking on this Mac.');
  await flush();
  await flush();
  assert.equal(world.calls.filter((c) => c.action === 'agent-pick').length, 1);
  assert.equal(world.calls.find((c) => c.action === 'agent-pick')?.agent, 'claude');
  assert.equal(rowOf(world, 'claude').getAttribute('aria-current'), 'true');
  assert.equal(rowOf(world, 'codex').getAttribute('aria-current'), null);
  assert.equal(useOf(world, 'claude').hidden, true);
  assert.equal(useOf(world, 'codex').hidden, false, 'the agent left behind lost its way back');
  assert.equal(status(world), '');
  assert.deepEqual(world.calls.filter((c) => c.route === 'event').map((c) => c.type), ['phosphor:agent'], 'the chat was not told');
  assert.equal(world.toasts.length, 0);
});

test('a switch the app refuses while an agent is running is that one sentence, and the pick stays', async () => {
  const world = await opened('codex');
  world.answers['agent-pick'] = { ok: false, refused: 'running', sentence: 'Your assistant is running. Turn it off in the chat, then change it here.', picked: 'codex' };
  useOf(world, 'claude').click();
  await flush();
  await flush();
  assert.equal(status(world), 'Your assistant is running. Turn it off in the chat, then change it here.');
  assert.equal(find(section(world), '.agentpick-status')[0].getAttribute('data-tone'), 'warn');
  assert.equal(rowOf(world, 'codex').getAttribute('aria-current'), 'true');
  assert.equal(rowOf(world, 'claude').getAttribute('aria-current'), null);
  assert.equal(world.calls.filter((c) => c.route === 'event').length, 0, 'the chat was told about a pick that did not happen');
});

test('a terminal agent on the door reads Connected, and back when it leaves', async () => {
  const world = await opened('codex');
  world.store.put({ ...world.store.get(), agents: { members: [{ client: 'codex-cli', label: 'codex', ops: 3 }] } });
  assert.equal(stateOf(world, 'codex'), 'Connected');
  world.store.put({ ...world.store.get(), agents: { members: [] } });
  assert.equal(stateOf(world, 'codex'), 'Runs in your terminal');
});

test('another agent, once picked, shows the one line to paste with Copy; a registration that failed does too', async () => {
  const world = await opened(null);
  world.answers['agent-pick'] = { ok: true, check: { agent: 'mcp', name: 'Another agent', state: 'unknown_client', probed: false, sentence: 'x', details: [], inApp: false }, registered: false, registrationFailed: false, command: 'claude mcp add phosphor -- node /x', picked: 'mcp' };
  useOf(world, 'mcp').click();
  await flush();
  await flush();
  assert.equal(commandOf(world, 'mcp'), 'claude mcp add phosphor -- node /x');

  const failed = await opened(null);
  failed.answers['agent-pick'] = { ok: true, check: CLAUDE_IN, registered: false, registrationFailed: true, command: 'claude mcp add phosphor -- node /y', picked: 'claude' };
  useOf(failed, 'claude').click();
  await flush();
  await flush();
  assert.equal(lineOf(failed, 'claude'), 'Claude Code is on this Mac, but Phosphor could not add itself to it. Paste this line into your terminal:');
  assert.equal(commandOf(failed, 'claude'), 'claude mcp add phosphor -- node /y');
});

test('when the app does not answer the list says so in its own words, and Check again scans again', async () => {
  const world = build();
  world.answers['agent-scan'] = new Error('Failed to fetch');
  world.show('vault');
  await flush();
  await flush();
  assert.equal(status(world), 'Phosphor could not check right now. Try again.');
  assert.ok(!visibleText(section(world)).some((t) => t.includes('RAW:') || t.includes('Failed to fetch')));
  assert.equal(stateOf(world, 'claude'), 'Checking', 'a row claimed a state nobody checked');
  world.answers['agent-scan'] = scanWith('codex');
  const again = buttonNamed(section(world), 'Check again');
  assert.ok(again, 'no Check again by the title');
  again.click();
  await flush();
  await flush();
  assert.equal(world.calls.filter((c) => c.action === 'agent-scan').length, 2);
  assert.equal(stateOf(world, 'claude'), 'Ready');
  assert.equal(status(world), '');
  assert.equal(world.toasts.length, 0);
});

test('reopening the Vault checks again, on the same list', async () => {
  const world = await opened('codex');
  const first = rows(world)[0];
  world.show('basic');
  world.show('vault');
  await flush();
  assert.equal(world.calls.filter((c) => c.action === 'agent-scan').length, 2);
  assert.equal(rows(world)[0], first, 'the list was rebuilt rather than checked again');
});
