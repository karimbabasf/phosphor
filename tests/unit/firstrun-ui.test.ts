// The first run's assistant step: the agent picker, and the threshold that lands in policy.json.
//
// Both run for real over a small DOM (the pattern of firstrun-welcome-ui.test.ts) with the api
// module replaced by a recorder that answers what the test says the app answered. What is
// proven: six tiles in the catalog's order; a pick is one round trip whose sentence, line and
// technical lines come from the answer; the action row follows the state (Start it for the one
// agent the app runs, Check again for a missing or signed-out one, Continue otherwise); one
// sentence at a time, the path behind Details, nothing the network said printed; the light
// follows the roster; and the threshold step posts the figure and shows the route's refusal
// over the same Continue. tsc never sees ui/, so this is the check.

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

const tiles = (screen: Any): Any[] => find(screen, '.agent-tile');
const tile = (screen: Any, id: string): Any => tiles(screen).find((t: Any) => t.dataset.agent === id) as Any;
const sentences = (screen: Any): string[] => find(screen, '.agentpick-sentence').filter((n: Any) => !n.hidden).map((n: Any) => n.textContent).filter((t: string) => t !== '');
const primary = (screen: Any): Any => find(screen, '.screen-actions')[0].childNodes[find(screen, '.screen-actions')[0].childNodes.length - 1];
const light = (screen: Any): string | null => find(screen, '.agentpick-light')[0].getAttribute('data-state');

/* ---------- the source ---------- */

test('the picker prints nothing the network said, raises no toast, and brings its stylesheet with three columns of tiles', () => {
  const picker = FIRSTRUN.slice(FIRSTRUN.indexOf('The agent picker, one component'));
  assert.ok(picker.length > 1000, 'the picker block was not found');
  assert.equal(/readable\(/.test(picker), false, 'the picker prints net.readable');
  assert.equal(/PhosphorToast/.test(picker), false, 'the picker raises a toast');
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML/.test(FIRSTRUN), false);
  assert.match(CSS, /\.agentpick-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/);
  assert.match(CSS, /\.agent-tile-name\s*\{[^}]*-webkit-line-clamp:\s*2/);
  // Keyboard focus is the app's own ring, never the tile's colour: a brand-coloured ring read as a
  // second picked tile beside the real one. The tile's colour is for hover and picked only.
  const focus = /\.agent-tile:focus-visible\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(focus, 'no focus-visible rule for the tile');
  assert.match(focus![1], /outline:\s*2px solid var\(--ink\)/, 'the focus ring is not the app\'s');
  assert.equal(/var\(--net\)/.test(focus![1]), false, 'the focus ring is in the tile\'s colour');
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const coloured = [...rules.matchAll(/([^{}]*)\{[^}]*var\(--net\)[^}]*\}/g)].map((m) => m[1].trim());
  for (const selector of coloured) {
    assert.equal(/focus/.test(selector), false, `the tile's colour is painted on focus: ${selector}`);
  }
  // The two sentences for a missing agent have one source, src/agents-catalog.ts stateSentence: a
  // screen that composed its own would fork the fix that keeps a fresh pick from reading as "no longer".
  for (const [file, source] of [['firstrun.js', FIRSTRUN], ['vault.js', VAULT]] as const) {
    assert.equal(/no longer on this Mac|not on this Mac yet/.test(source), false, `${file} composes a state sentence of its own`);
  }
  assert.match(picker, /var text = check\.sentence;/, 'the picker does not print the check\'s own sentence');
  // The old step's toast on a failed start is gone from the assistant step too.
  const step = FIRSTRUN.slice(FIRSTRUN.indexOf('function screenConnect'), FIRSTRUN.indexOf('function screenThreshold'));
  assert.equal(/PhosphorToast|readable\(/.test(step), false, 'the assistant step still prints a raw error');
});

/* ---------- the tiles ---------- */

test('six tiles in the catalog\'s order, one screen, and the stylesheet linked from the page', async () => {
  const world = build();
  const screen = await atPicker(world);
  assert.deepEqual(tiles(screen).map((t: Any) => t.dataset.agent), ['claude', 'codex', 'hermes', 'grok', 'mcp', 'desktop']);
  assert.deepEqual(
    tiles(screen).map((t: Any) => find(t, '.agent-tile-name')[0].textContent),
    ['Claude Code', 'Codex', 'Hermes', 'Grok', 'Another agent', 'Claude Desktop or a chat app'],
  );
  assert.ok(visibleText(screen).includes('Step 3 of 3'), 'the picker is not the same step the connect step was');
  assert.equal(tiles(screen).filter((t: Any) => t.tabIndex === 0).length, 1, 'more than one tile in the tab order');
  assert.match(read('../../ui/index.html'), /<link rel="stylesheet" href="\.\/design\/agentpick\.css">/, 'index.html does not link the picker stylesheet');
  assert.equal(world.calls.filter((c) => c.action === 'agent-scan').length, 1, 'the scan did not run once');
  // Before a pick: nothing said, the primary is a quiet Continue, and Do this later stays.
  assert.deepEqual(sentences(screen), []);
  assert.equal(primary(screen).textContent, 'Continue');
  assert.equal(primary(screen).className, 'btn btn-ghost btn-lg');
  assert.ok(buttonNamed(screen, 'Do this later'));
});

test('the scan tags the tiles the app found on this Mac, in words', async () => {
  const world = build();
  world.answers['agent-scan'] = { ok: true, agents: [CHECKS.claudeIn, CHECKS.codexOut, { ...CHECKS.codexMissing, agent: 'hermes', name: 'Hermes' }], picked: null };
  const screen = await atPicker(world);
  await flush();
  const tagged = tiles(screen).filter((t: Any) => !find(t, '.agent-tile-tag')[0].hidden).map((t: Any) => t.dataset.agent);
  assert.deepEqual(tagged, ['claude', 'codex']);
  assert.equal(find(tile(screen, 'claude'), '.agent-tile-tag')[0].textContent, 'On this Mac');
});

/* ---------- a pick ---------- */

test('a pick is one round trip: the tile is current at once, the sentence is the app\'s, the path waits behind Details', async () => {
  const world = build();
  // A missing agent is not stored by the app (picked stays null); the tile the sentence is about stays current.
  world.answers['agent-pick'] = { ok: true, check: CHECKS.codexMissing, registered: false, registrationFailed: false, command: LINE, agent: 'codex', picked: null };
  const screen = await atPicker(world);
  tile(screen, 'codex').click();
  assert.equal(tile(screen, 'codex').getAttribute('aria-current'), 'true');
  assert.deepEqual(sentences(screen), ['Checking on this Mac.']);
  await flush();
  assert.equal(tile(screen, 'codex').getAttribute('aria-current'), 'true');
  const pick = world.calls.find((c) => c.action === 'agent-pick');
  assert.ok(pick && pick.agent === 'codex', 'the pick was not posted');
  assert.deepEqual(sentences(screen), [CHECKS.codexMissing.sentence]);
  assert.equal(find(screen, '.agentpick-line')[0].getAttribute('data-tone'), 'down');
  // The fold is closed until Details is pressed, and it is where the path lives.
  const fold = find(screen, '.agentpick-fold')[0];
  assert.equal(fold.hidden, true);
  assert.ok(!visibleText(screen).some((t) => t.includes('/Users/')), 'a path is in the open');
  buttonNamed(screen, 'Details').click();
  assert.equal(fold.hidden, false);
  assert.ok(visibleText(screen).some((t) => t.startsWith('Install: npm install -g @openai/codex')));
  assert.ok(visibleText(screen).some((t) => t.includes(LINE)), 'the line to paste is not behind Details');
  // The action row follows: Check again over the same Do this later.
  assert.equal(primary(screen).textContent, 'Check again');
  assert.ok(buttonNamed(screen, 'Do this later'));
  assert.equal(world.toasts.length, 0);
});

test('Check again re-checks without writing, and a signed-out agent gets its sentence and the same button', async () => {
  const world = build();
  world.answers['agent-pick'] = { ok: true, check: CHECKS.codexMissing, registered: false, registrationFailed: false, command: LINE, picked: null };
  const screen = await atPicker(world);
  tile(screen, 'codex').click();
  await flush();
  world.answers['agent-check'] = { ok: true, check: CHECKS.codexOut, command: LINE, picked: 'codex' };
  buttonNamed(screen, 'Check again').click();
  await flush();
  await flush();
  assert.equal(world.calls.filter((c) => c.action === 'agent-pick').length, 1, 'Check again wrote the pick again');
  assert.equal(world.calls.filter((c) => c.action === 'agent-check').length, 1);
  assert.deepEqual(sentences(screen), [CHECKS.codexOut.sentence]);
  assert.equal(find(screen, '.agentpick-line')[0].getAttribute('data-tone'), 'warn');
  assert.equal(primary(screen).textContent, 'Check again');
  world.answers['agent-check'] = { ok: true, check: CHECKS.codexIn, command: LINE, picked: 'codex' };
  buttonNamed(screen, 'Check again').click();
  await flush();
  await flush();
  assert.deepEqual(sentences(screen), [CHECKS.codexIn.sentence]);
  assert.equal(primary(screen).textContent, 'Continue');
  assert.equal(primary(screen).className, 'btn btn-primary btn-lg');
});

test('Claude Code signed in offers Start it, and a start that lands turns the row into Continue', async () => {
  const world = build();
  world.answers['agent-pick'] = { ok: true, check: CHECKS.claudeIn, registered: true, registrationFailed: false, command: 'claude mcp add phosphor --scope user -- node /x/src/mcp.ts', picked: 'claude' };
  world.answers.start = { ok: true, state: 'ready', running: true };
  const screen = await atPicker(world);
  tile(screen, 'claude').click();
  await flush();
  assert.deepEqual(sentences(screen), [CHECKS.claudeIn.sentence]);
  assert.equal(primary(screen).textContent, 'Start it');
  buttonNamed(screen, 'Details').click();
  assert.ok(visibleText(screen).some((t) => t.startsWith('Phosphor added itself to the tools of Claude Code')), 'the registration is not said');
  primary(screen).click();
  await flush();
  assert.ok(world.calls.some((c) => c.action === 'start'), 'Start it did not post the start');
  assert.deepEqual(sentences(screen), ['Claude Code is at the wheel.']);
  assert.equal(primary(screen).textContent, 'Continue');
  primary(screen).click();
  assert.equal(screen.hidden, true, 'Continue on the last step did not close the first run');
});

test('a start that fails is one sentence over the same Start it, never a toast or the raw text', async () => {
  const world = build();
  world.answers['agent-pick'] = { ok: true, check: CHECKS.claudeIn, registered: true, registrationFailed: false, command: 'x', picked: 'claude' };
  world.answers.start = new Error('spawn ENOENT /Users/x/.local/bin/claude');
  const screen = await atPicker(world);
  tile(screen, 'claude').click();
  await flush();
  primary(screen).click();
  await flush();
  await flush();
  assert.deepEqual(sentences(screen), ['Claude Code could not start. Try again, or start it in your terminal.']);
  assert.equal(primary(screen).textContent, 'Start it');
  assert.equal(world.toasts.length, 0);
  assert.ok(!visibleText(screen).some((t) => t.includes('ENOENT') || t.includes('RAW:')));
});

test('another agent gets the line to paste in the open with Copy, and Claude Desktop gets its three sentences and no probe', async () => {
  const world = build();
  world.answers['agent-pick'] = { ok: true, check: CHECKS.other, registered: false, registrationFailed: false, command: 'PHOSPHOR_PORT=4177 node /x/src/mcp.ts', picked: 'mcp' };
  const screen = await atPicker(world);
  tile(screen, 'mcp').click();
  await flush();
  assert.deepEqual(sentences(screen), [CHECKS.other.sentence]);
  const paste = find(screen, '.agentpick-paste')[0];
  assert.equal(paste.hidden, false);
  assert.equal(find(paste, 'input')[0].value, 'PHOSPHOR_PORT=4177 node /x/src/mcp.ts');
  buttonNamed(screen, 'Copy').click();
  await flush();
  assert.deepEqual(world.clipboard, ['PHOSPHOR_PORT=4177 node /x/src/mcp.ts']);
  assert.equal(primary(screen).textContent, 'Continue');

  world.answers['agent-pick'] = { ok: true, check: CHECKS.desktop, registered: false, registrationFailed: false, command: null, picked: 'desktop' };
  tile(screen, 'desktop').click();
  await flush();
  assert.deepEqual(sentences(screen), [CHECKS.desktop.sentence]);
  assert.equal(find(screen, '.agentpick-paste')[0].hidden, true);
  assert.equal(primary(screen).textContent, 'Continue');
});

test('a pick the app refuses while an agent is running shows that one sentence and leaves the pick where it was', async () => {
  const world = build();
  world.answers['agent-pick'] = { ok: false, refused: 'running', sentence: 'Your assistant is running. Turn it off in the chat, then change it here.', picked: 'claude' };
  const screen = await atPicker(world);
  tile(screen, 'codex').click();
  await flush();
  assert.deepEqual(sentences(screen), ['Your assistant is running. Turn it off in the chat, then change it here.']);
  assert.equal(tile(screen, 'codex').getAttribute('aria-current'), null);
  assert.equal(tile(screen, 'claude').getAttribute('aria-current'), 'true');
  assert.equal(primary(screen).textContent, 'Continue');
});

test('when the app does not answer, the picker says so in its own words and never prints what the network said', async () => {
  const world = build();
  world.answers['agent-pick'] = new Error('Failed to fetch');
  const screen = await atPicker(world);
  tile(screen, 'hermes').click();
  await flush();
  await flush();
  assert.deepEqual(sentences(screen), ['Phosphor could not check right now. Try again.']);
  assert.ok(!visibleText(screen).some((t) => t.includes('RAW:') || t.includes('Failed to fetch')));
  assert.equal(world.toasts.length, 0);
  assert.equal(sentences(screen).length, 1);
});

/* ---------- the light ---------- */

test('the light turns on when a client of the picked agent is on the door, and the sentence says so; off when it leaves', async () => {
  const world = build();
  world.answers['agent-pick'] = { ok: true, check: CHECKS.codexIn, registered: true, registrationFailed: false, command: LINE, picked: 'codex' };
  const screen = await atPicker(world);
  tile(screen, 'codex').click();
  await flush();
  assert.equal(light(screen), 'off');
  world.store.put({ ...world.store.get(), agents: { members: [{ client: 'codex-cli', label: 'codex', ops: 0 }] } });
  assert.equal(light(screen), 'ready');
  assert.deepEqual(sentences(screen), ['Codex is connected.']);
  // Another vendor's client does not light Codex.
  world.store.put({ ...world.store.get(), agents: { members: [{ client: 'claude-code', label: 'claude', ops: 2 }] } });
  assert.equal(light(screen), 'off');
  assert.deepEqual(sentences(screen), [CHECKS.codexIn.sentence]);
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
    tile(screen, pick).click();
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
  if (primary.textContent === 'Start it') {
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
    ['desktop', { ok: true, check: CHECKS.desktop, command: null, picked: 'desktop' }, 'Install Claude Code or Codex, then pick it in the Vault tab.'],
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
  world.answers['/api/policy/threshold'] = Object.assign(new Error('Asking above $20,000 with a hard cap of $10,000 means nothing ever asks you. Keep the threshold under $10,000.'), { status: 400 });
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
