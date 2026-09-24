// The first run's assistant step: the agent list, and the threshold that lands in policy.json.
//
// Both run for real over a small DOM (the pattern of firstrun-welcome-ui.test.ts) with the api
// module replaced by a recorder that answers what the test says the app answered. What is
// proven: six rows in the catalog's order, each with the state the app's scan found and the line
// that says how; Use is one round trip whose words come from the answer, and a pick the app did
// not store is never shown as held; the action row follows the state (Start and the agent's
// name for one the app runs, Continue otherwise, never a dead end); nothing the network said is
// printed; a terminal agent on the door reads Connected; and the threshold step posts the figure
// and shows the route's refusal over the same Continue. tsc never sees ui/, so this is the check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const LINKS = read('../../ui/core/links.js');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const FIRSTRUN = read('../../ui/screens/firstrun.js');
const VAULT = read('../../ui/screens/vault.js');
const CSS = read('../../ui/design/agentpick.css');

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

/* Every text a person can read: what is not hidden, and not inside something hidden. */
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
type World = { sandbox: Any; screen: Any; head: Any; calls: Any[]; toasts: string[]; answers: Record<string, Answer>; store: Any; clipboard: string[] };

const ENCLAVE = {
  custody: null,
  state: 'no_wallet',
  enclave: { attached: true, ready: true, capability: { secureEnclave: true, biometry: 'touchid', canAuthenticate: true }, keyMadeAt: null, binding: 'device' },
  foreign: false,
  waiting: null,
  backedUp: false,
  backedUpAt: null,
  idleMinutes: 15,
  hasMnemonic: true,
};

const CHECKS: Record<string, Any> = {
  codexMissing: { agent: 'codex', name: 'Codex', state: 'not_installed', probed: true, sentence: 'Codex is not on this Mac yet. Install it, then come back to this screen.', details: ['Made by OpenAI.', 'Looked for `codex` on PATH and in ~/.local/bin/codex.', 'Install: npm install -g @openai/codex'], version: null, bin: null, inApp: false, registers: true, ms: 12 },
  codexOut: { agent: 'codex', name: 'Codex', state: 'installed_not_logged_in', probed: true, sentence: 'Codex is installed but not signed in. Sign in in your terminal, then press Check again.', details: ['Made by OpenAI.', 'Found at /Users/x/.nvm/versions/node/v24.16.0/bin/codex, codex-cli 0.154.0.', 'Sign in: codex login'], version: 'codex-cli 0.154.0', bin: '/Users/x/.nvm/versions/node/v24.16.0/bin/codex', inApp: false, registers: true, ms: 40 },
  codexIn: { agent: 'codex', name: 'Codex', state: 'installed_and_logged_in', probed: true, sentence: 'Codex is signed in: start it in your terminal and it will appear here.', details: ['Made by OpenAI.', 'Found at /Users/x/.nvm/versions/node/v24.16.0/bin/codex, codex-cli 0.154.0.'], version: 'codex-cli 0.154.0', bin: '/Users/x/.nvm/versions/node/v24.16.0/bin/codex', inApp: false, registers: true, ms: 40 },
  claudeIn: { agent: 'claude', name: 'Claude Code', state: 'installed_and_logged_in', probed: true, sentence: 'Claude Code is signed in and ready to start.', details: ['Made by Anthropic.', 'Found at /Users/x/.local/bin/claude, 2.1.278 (Claude Code).'], version: '2.1.278 (Claude Code)', bin: '/Users/x/.local/bin/claude', inApp: true, registers: true, ms: 130 },
  other: { agent: 'mcp', name: 'Another agent', state: 'unknown_client', probed: false, sentence: 'Phosphor cannot check this agent, so paste the line below into it and it will appear here.', details: ['Any agent that connects to MCP servers.'], version: null, bin: null, inApp: false, registers: false, ms: 0 },
  desktop: { agent: 'desktop', name: 'Claude Desktop or a chat app', state: 'unknown_client', probed: false, sentence: 'Phosphor needs an agent that runs on your Mac. Claude Desktop cannot drive it yet. Install Claude Code or Codex, then pick it here.', details: ['A chat window, with no agent on this Mac.'], version: null, bin: null, inApp: false, registers: false, ms: 0 },
};

const LINE = 'codex mcp add phosphor --env PHOSPHOR_PORT=4177 --env PHOSPHOR_DATA_DIR=/Users/x/state -- node /Users/x/phosphor/src/mcp.ts';

function build(): World {
  const nodes: Record<string, Any> = {};
  for (const id of ['screen-firstrun', 'page']) nodes[id] = makeNode('div');
  const body = makeNode('body');
  const head = makeNode('head');
  const root = makeNode('html');
  const calls: Any[] = [];
  const toasts: string[] = [];
  const clipboard: string[] = [];
  const answers: Record<string, Answer> = {
    'agent-scan': { ok: true, agents: [], picked: null },
  };

  const doc: Any = {
    body,
    head,
    documentElement: root,
    createElement: makeNode,
    getElementById: (id: string) => nodes[id] ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const sandbox: Any = {
    console,
    URL,
    document: doc,
    Promise,
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn: (now: number) => void) => { fn(0); return 1; },
    cancelAnimationFrame() {},
    navigator: { clipboard: { writeText: (text: string) => { clipboard.push(text); return Promise.resolve(); } } },
  };
  sandbox.window = sandbox;
  const answerFor = (key: string): Promise<unknown> => {
    const answer = answers[key];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? {});
  };
  sandbox.PhosphorNet = {
    readable: (e: Any) => `RAW:${String(e && e.message ? e.message : e)}`,
    postJson: (path: string, payload: Any) => { calls.push({ route: path, ...payload }); return answerFor(path); },
  };
  sandbox.PhosphorMotion = { reduced: () => true };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean) { button.disabled = !!pending; button.pending = !!pending; },
    refresh: () => { calls.push({ route: 'refresh' }); return Promise.resolve(); },
    setView: (name: string) => { calls.push({ route: 'setView', view: name }); },
  };
  sandbox.PhosphorToast = { show: (message: string) => { toasts.push(message); } };
  sandbox.PhosphorMoneyIn = { render: (host: Any) => { host.appendChild(makeNode('div')); } };
  sandbox.PhosphorApi = {
    vaultCreate: () => Promise.resolve({ ok: true, addresses: { evm: '0xabc' } }),
    vaultRestore: () => Promise.resolve({ ok: true, addresses: {} }),
    walletCreate: () => Promise.resolve({ ok: true, mnemonic: [], addresses: {} }),
    walletImport: () => Promise.resolve({ ok: true, addresses: {} }),
    connection: () => Promise.resolve({ missing: true }),
    driver: (payload: Any) => {
      calls.push({ route: '/api/driver', ...payload });
      return answerFor(payload.action === 'start' ? 'start' : payload.action);
    },
  };

  createContext(sandbox);
  runInContext(LINKS, sandbox, { filename: 'ui/core/links.js' });
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(FIRSTRUN, sandbox, { filename: 'ui/screens/firstrun.js' });

  const store = sandbox.PhosphorState;
  store.put({ lock: { state: 'no_wallet', idleLocksInSec: null }, vault: ENCLAVE, agents: { members: [] } });
  sandbox.PhosphorFirstRun.boot();
  return { sandbox, screen: nodes['screen-firstrun'], head, calls, toasts, answers, store, clipboard };
}

/* Opens the first run and walks to the assistant step (welcome, create, addresses, assistant). */
async function atPicker(world: World): Promise<Any> {
  world.sandbox.PhosphorFirstRun.open();
  buttonNamed(world.screen, 'Get started').click();
  buttonNamed(world.screen, 'Create wallet').click();
  await flush();
  buttonNamed(world.screen, 'Continue').click();
  await flush();
  assert.ok(visibleText(world.screen).includes('Your assistant'), 'the assistant step did not open');
  return world.screen;
}

const rows = (screen: Any): Any[] => find(screen, '.agentrow');
const rowOf = (screen: Any, id: string): Any => rows(screen).find((r: Any) => r.dataset.agent === id) as Any;
const stateOf = (screen: Any, id: string): string => find(rowOf(screen, id), '.agentrow-state')[0].textContent;
const commandOf = (screen: Any, id: string): string => {
  const cmd = find(rowOf(screen, id), '.agentrow-cmd')[0];
  return cmd && !cmd.hidden ? find(cmd, '.agentrow-code')[0].textContent : '';
};
const status = (screen: Any): string => {
  const node = find(screen, '.agentpick-status')[0];
  return node && !node.hidden ? node.textContent : '';
};
const useOf = (screen: Any, id: string): Any => find(rowOf(screen, id), '.agentrow-use')[0];
const primary = (screen: Any): Any => find(screen, '.screen-actions')[0].childNodes[find(screen, '.screen-actions')[0].childNodes.length - 1];

/* ---------- the source ---------- */

test('the list prints nothing the network said, raises no toast, and owns no sentence about a missing agent', () => {
  const list = FIRSTRUN.slice(FIRSTRUN.indexOf('The agent list, one component for two hosts'));
  assert.ok(list.length > 3000, 'the list block was not found');
  assert.equal(/readable\(/.test(list), false, 'the list prints net.readable');
  assert.equal(/PhosphorToast/.test(list), false, 'the list raises a toast');
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML/.test(FIRSTRUN), false);
  // The rows are ruled, not tiled, and no brand colour lands on them.
  assert.match(CSS, /\.agentrow\s*\{[^}]*grid-template-columns:\s*28px minmax\(0, 1fr\) auto auto;/);
  assert.equal(/var\(--net\)|agent-tile|agentpick-light/.test(CSS), false, 'a tile, a brand colour or a light is back');
  // The sentences for a missing agent have one source, src/agents-catalog.ts stateSentence: a
  // screen that composed its own would fork the fix that keeps a fresh pick from reading as "no longer".
  for (const [file, source] of [['firstrun.js', FIRSTRUN], ['vault.js', VAULT]] as const) {
    assert.equal(/no longer on this Mac|not on this Mac yet/.test(source), false, `${file} composes a state sentence of its own`);
  }
  // The old step's toast on a failed start is gone from the assistant step too.
  const step = FIRSTRUN.slice(FIRSTRUN.indexOf('function screenConnect'), FIRSTRUN.indexOf('function screenThreshold'));
  assert.equal(/PhosphorToast|readable\(/.test(step), false, 'the assistant step still prints a raw error');
});

/* ---------- the rows ---------- */

test('six rows in the catalog\'s order, one screen, the stylesheet linked, and a quiet way on before a pick', async () => {
  const world = build();
  const screen = await atPicker(world);
  assert.deepEqual(rows(screen).map((r: Any) => r.dataset.agent), ['claude', 'codex', 'hermes', 'grok', 'mcp', 'desktop']);
  assert.deepEqual(
    rows(screen).map((r: Any) => find(r, '.agentrow-name')[0].textContent),
    ['Claude Code', 'Codex', 'Hermes', 'Grok', 'Another agent', 'Claude Desktop or a chat app'],
  );
  assert.ok(visibleText(screen).includes('Step 3 of 3'), 'the list is not the same step the connect step was');
  assert.match(read('../../ui/index.html'), /<link rel="stylesheet" href="\.\/design\/agentpick\.css">/, 'index.html does not link the list stylesheet');
  assert.equal(world.calls.filter((c) => c.action === 'agent-scan').length, 1, 'the scan did not run once');
  assert.equal(status(screen), '');
  assert.equal(primary(screen).textContent, 'Continue');
  assert.equal(primary(screen).className, 'btn btn-ghost btn-lg');
  assert.ok(buttonNamed(screen, 'Do this later'));
  // The list carries its own Check again here, since the step has none.
  assert.ok(buttonNamed(screen, 'Check again'), 'no way to check again after installing');
});

test('the scan says each agent\'s state in words, with the line that says how', async () => {
  const world = build();
  world.answers['agent-scan'] = { ok: true, agents: [CHECKS.claudeIn, CHECKS.codexOut, { ...CHECKS.codexMissing, agent: 'hermes', name: 'Hermes', details: ['Install: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'] }], picked: null };
  const screen = await atPicker(world);
  await flush();
  assert.equal(stateOf(screen, 'claude'), 'Ready');
  assert.equal(stateOf(screen, 'codex'), 'Not signed in');
  assert.equal(commandOf(screen, 'codex'), 'codex login');
  assert.equal(stateOf(screen, 'hermes'), 'Not installed');
  assert.equal(commandOf(screen, 'hermes'), 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash');
  assert.equal(useOf(screen, 'hermes').hidden, true, 'Use on an agent that is not here');
  assert.equal(stateOf(screen, 'desktop'), 'Cannot drive Phosphor');
  assert.equal(useOf(screen, 'desktop').hidden, true, 'Use on a chat app that cannot drive');
  assert.ok(!visibleText(screen).some((t) => t.includes('/Users/')), 'a path is in the open');
});

/* ---------- a pick ---------- */

test('Claude Code signed in: Use is one round trip, the step offers Start Claude Code, and a start that lands turns it into Continue', async () => {
  const world = build();
  world.answers['agent-scan'] = { ok: true, agents: [CHECKS.claudeIn], picked: null };
  world.answers['agent-pick'] = { ok: true, check: CHECKS.claudeIn, registered: true, registrationFailed: false, command: 'claude mcp add phosphor --scope user -- node /x/src/mcp.ts', picked: 'claude' };
  world.answers.start = { ok: true, state: 'ready', running: true };
  const screen = await atPicker(world);
  await flush();
  useOf(screen, 'claude').click();
  assert.equal(status(screen), 'Checking on this Mac.');
  await flush();
  await flush();
  const pick = world.calls.find((c) => c.action === 'agent-pick');
  assert.ok(pick && pick.agent === 'claude', 'the pick was not posted');
  assert.equal(rowOf(screen, 'claude').getAttribute('aria-current'), 'true');
  assert.equal(primary(screen).textContent, 'Start Claude Code');
  primary(screen).click();
  await flush();
  assert.ok(world.calls.some((c) => c.action === 'start'), 'Start did not post the start');
  assert.equal(status(screen), 'Claude Code is at the wheel.');
  assert.equal(primary(screen).textContent, 'Continue');
  primary(screen).click();
  assert.equal(screen.hidden, true, 'Continue on the last step did not close the first run');
  assert.equal(world.toasts.length, 0);
});

test('a start that fails is one sentence over the same Start, never a toast or the raw text', async () => {
  const world = build();
  world.answers['agent-scan'] = { ok: true, agents: [CHECKS.claudeIn], picked: null };
  world.answers['agent-pick'] = { ok: true, check: CHECKS.claudeIn, registered: true, registrationFailed: false, command: 'x', picked: 'claude' };
  world.answers.start = new Error('spawn ENOENT /Users/x/.local/bin/claude');
  const screen = await atPicker(world);
  await flush();
  useOf(screen, 'claude').click();
  await flush();
  await flush();
  primary(screen).click();
  await flush();
  await flush();
  assert.equal(status(screen), 'Claude Code could not start. Try again, or start it in your terminal.');
  assert.equal(primary(screen).textContent, 'Start Claude Code');
  assert.equal(world.toasts.length, 0);
  assert.ok(!visibleText(screen).some((t) => t.includes('ENOENT') || t.includes('RAW:')));
});

test('a pick of an agent that is not here stores nothing: the list says the app\'s sentence and the pick stays where it was', async () => {
  const world = build();
  world.answers['agent-pick'] = { ok: true, check: CHECKS.codexMissing, registered: false, registrationFailed: false, command: LINE, agent: 'codex', picked: null };
  const screen = await atPicker(world);
  useOf(screen, 'codex').click();
  await flush();
  await flush();
  assert.equal(rowOf(screen, 'codex').getAttribute('aria-current'), null, 'a pick the app did not store is shown as held');
  assert.equal(stateOf(screen, 'codex'), 'Not installed');
  assert.equal(commandOf(screen, 'codex'), 'npm install -g @openai/codex');
  assert.equal(status(screen), CHECKS.codexMissing.sentence);
  assert.equal(primary(screen).textContent, 'Continue');
});

test('another agent gets the line to paste with Copy, and Continue', async () => {
  const world = build();
  world.answers['agent-pick'] = { ok: true, check: CHECKS.other, registered: false, registrationFailed: false, command: 'PHOSPHOR_PORT=4177 node /x/src/mcp.ts', picked: 'mcp' };
  const screen = await atPicker(world);
  useOf(screen, 'mcp').click();
  await flush();
  await flush();
  assert.equal(commandOf(screen, 'mcp'), 'PHOSPHOR_PORT=4177 node /x/src/mcp.ts');
  buttonNamed(rowOf(screen, 'mcp'), 'Copy').click();
  await flush();
  assert.deepEqual(world.clipboard, ['PHOSPHOR_PORT=4177 node /x/src/mcp.ts']);
  assert.equal(primary(screen).textContent, 'Continue');
});

test('a pick the app refuses while an agent is running shows that one sentence and leaves the pick where it was', async () => {
  const world = build();
  world.answers['agent-scan'] = { ok: true, agents: [CHECKS.claudeIn, CHECKS.codexIn], picked: 'claude' };
  world.answers['agent-pick'] = { ok: false, refused: 'running', sentence: 'Your assistant is running. Turn it off in the chat, then change it here.', picked: 'claude' };
  const screen = await atPicker(world);
  await flush();
  useOf(screen, 'codex').click();
  await flush();
  await flush();
  assert.equal(status(screen), 'Your assistant is running. Turn it off in the chat, then change it here.');
  assert.equal(rowOf(screen, 'codex').getAttribute('aria-current'), null);
  assert.equal(rowOf(screen, 'claude').getAttribute('aria-current'), 'true');
});

test('when the app does not answer, the list says so in its own words and never prints what the network said', async () => {
  const world = build();
  world.answers['agent-pick'] = new Error('Failed to fetch');
  const screen = await atPicker(world);
  useOf(screen, 'grok').click();
  await flush();
  await flush();
  assert.equal(status(screen), 'Phosphor could not check right now. Try again.');
  assert.ok(!visibleText(screen).some((t) => t.includes('RAW:') || t.includes('Failed to fetch')));
  assert.equal(world.toasts.length, 0);
});

test('a terminal agent on the door reads Connected, and another vendor\'s client does not light it', async () => {
  const world = build();
  world.answers['agent-scan'] = { ok: true, agents: [CHECKS.codexIn], picked: null };
  world.answers['agent-pick'] = { ok: true, check: CHECKS.codexIn, registered: true, registrationFailed: false, command: LINE, picked: 'codex' };
  const screen = await atPicker(world);
  await flush();
  useOf(screen, 'codex').click();
  await flush();
  await flush();
  assert.equal(stateOf(screen, 'codex'), 'Runs in your terminal');
  world.store.put({ ...world.store.get(), agents: { members: [{ client: 'codex-cli', label: 'codex', ops: 0 }] } });
  assert.equal(stateOf(screen, 'codex'), 'Connected');
  world.store.put({ ...world.store.get(), agents: { members: [{ client: 'claude-code', label: 'claude', ops: 2 }] } });
  assert.equal(stateOf(screen, 'codex'), 'Runs in your terminal');
});

/* ---------- the threshold ---------- */

/* The software flow walked to the assistant step on the import path, which skips the words and
   the prove step (they need a phrase). `pick` clicks that tile there and waits for the answer. */
async function atAssistant(world: World, pick?: string): Promise<Any> {
  world.store.put({ ...world.store.get(), vault: { ...ENCLAVE, enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } } });
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.screen;
  buttonNamed(screen, 'Get started').click();
  (find(screen, '.choice').find((c: Any) => c.textContent.startsWith('I already have one')) as Any).click();
  buttonNamed(screen, 'Continue').click(); // choose
  find(screen, 'input').forEach((i: Any) => { i.value = 'a long enough password'; });
  buttonNamed(screen, 'Continue').click(); // password, straight to the addresses
  await flush();
  buttonNamed(screen, 'Continue').click(); // addresses
  buttonNamed(screen, 'Do this later').click(); // money
  await flush();
  assert.ok(visibleText(screen).includes('Your assistant'), 'the assistant step did not open');
  if (pick) {
    (find(screen, '.agentrow').find((r: Any) => r.dataset.agent === pick) as Any).querySelector('.agentrow-use').click();
    await flush();
    await flush();
  }
  return screen;
}

async function atThreshold(world: World): Promise<Any> {
  world.answers['agent-pick'] = { ok: true, check: CHECKS.desktop, command: null, picked: 'desktop' };
  const screen = await atAssistant(world);
  buttonNamed(screen, 'Do this later').click(); // assistant
  await flush();
  assert.ok(visibleText(screen).includes('Set the ask threshold'), 'the threshold step did not open');
  return screen;
}

/* ---------- the done screen ---------- */

async function doneSentence(world: World, pick?: string): Promise<string> {
  const screen = await atAssistant(world, pick);
  const primary = find(screen, '.screen-actions')[0].childNodes.slice(-1)[0];
  if (primary.textContent.startsWith('Start ')) {
    primary.click();
    await flush();
    await flush();
  }
  (buttonNamed(screen, 'Continue') ?? buttonNamed(screen, 'Do this later')).click();
  await flush();
  world.answers['/api/policy/threshold'] = { ok: true, threshold: 100, from: 100 };
  buttonNamed(screen, 'Continue').click(); // threshold
  await flush();
  assert.ok(visibleText(screen).includes('Done'), 'the done screen did not open');
  return find(screen, 'p.body')[0].textContent;
}

test('the done screen says what the assistant step actually found, never a connection nobody made', async () => {
  const cases: Array<[string | undefined, Answer | undefined, string]> = [
    ['codex', { ok: true, check: CHECKS.codexIn, command: LINE, registered: true, picked: 'codex' }, 'Start Codex in your terminal and it will appear.'],
    ['codex', { ok: true, check: CHECKS.codexOut, command: LINE, picked: 'codex' }, 'Sign in to Codex, then start it in your terminal.'],
    ['codex', { ok: true, check: CHECKS.codexMissing, command: LINE, picked: null }, 'Install Codex, then pick it in the Vault tab.'],
    ['mcp', { ok: true, check: CHECKS.other, command: 'PHOSPHOR_PORT=4177 node /x', picked: 'mcp' }, 'Paste the line from the Vault tab into your agent and it will appear.'],
    [undefined, undefined, 'Pick your assistant in the Vault tab when you are ready.'],
  ];
  for (const [pick, answer, expected] of cases) {
    const world = build();
    if (answer) world.answers['agent-pick'] = answer;
    const text = await doneSentence(world, pick);
    assert.ok(text.includes(expected), `${pick ?? 'no pick'}: ${text}`);
    assert.ok(!text.includes('is connected'), `${pick ?? 'no pick'} claims a connection: ${text}`);
    assert.ok(text.startsWith('Add money any time from the Basic tab.'), `the money half is not honest when nothing landed: ${text}`);
    assert.ok(text.endsWith('Nothing moves unless you say so.'));
  }

  // Claude Code started in-app is a connection, and so is a client on the door.
  const started = build();
  started.answers['agent-pick'] = { ok: true, check: CHECKS.claudeIn, command: 'x', registered: true, picked: 'claude' };
  started.answers.start = { ok: true, state: 'ready', running: true };
  assert.ok((await doneSentence(started, 'claude')).includes('Your assistant is connected.'));

  const attached = build();
  attached.answers['agent-pick'] = { ok: true, check: CHECKS.codexIn, command: LINE, registered: true, picked: 'codex' };
  const screen = await atAssistant(attached, 'codex');
  attached.store.put({ ...attached.store.get(), agents: { members: [{ client: 'codex-cli', label: 'codex', ops: 1 }] } });
  buttonNamed(screen, 'Continue').click();
  await flush();
  attached.answers['/api/policy/threshold'] = { ok: true, threshold: 100, from: 100 };
  buttonNamed(screen, 'Continue').click();
  await flush();
  assert.ok(find(screen, 'p.body')[0].textContent.includes('Your assistant is connected.'));
});

test('Continue on the threshold step posts the figure to the policy route and moves on when it lands', async () => {
  const world = build();
  world.answers['/api/policy/threshold'] = { ok: true, threshold: 25, from: 100 };
  const screen = await atThreshold(world);
  buttonNamed(screen, '$25').click();
  buttonNamed(screen, 'Continue').click();
  await flush();
  const post = world.calls.find((c) => c.route === '/api/policy/threshold');
  assert.ok(post, 'nothing was posted');
  assert.equal(post.usd, 25);
  assert.ok(visibleText(screen).includes('Done'), 'the flow did not move on');
});

test('a refusal from the policy route is shown as its one sentence over the same Continue, and a dead app in the step\'s own words', async () => {
  const world = build();
  world.answers['/api/policy/threshold'] = Object.assign(new Error('Asking above $20,000 with a hard cap of $10,000 means nothing would ever wait for a click. Keep the threshold under $10,000.'), { status: 400 });
  const screen = await atThreshold(world);
  find(screen, '.threshold-input')[0].value = '20000';
  buttonNamed(screen, 'Continue').click();
  await flush();
  await flush();
  assert.ok(visibleText(screen).some((t) => t.startsWith('Asking above $20,000 with a hard cap of $10,000')));
  assert.ok(visibleText(screen).includes('Set the ask threshold'), 'the step moved on after a refusal');
  assert.equal(buttonNamed(screen, 'Continue').disabled, false);

  world.answers['/api/policy/threshold'] = new Error('Failed to fetch');
  buttonNamed(screen, 'Continue').click();
  await flush();
  await flush();
  assert.ok(visibleText(screen).includes('Phosphor could not save that. Try again.'));
  assert.ok(!visibleText(screen).some((t) => t.includes('Failed to fetch')));

  // A figure that is not a number never reaches the app.
  find(screen, '.threshold-input')[0].value = 'ten';
  buttonNamed(screen, 'Continue').click();
  assert.equal(world.calls.filter((c) => c.route === '/api/policy/threshold').length, 2);
  assert.ok(visibleText(screen).includes('Type a number of dollars above 0.'));
});
