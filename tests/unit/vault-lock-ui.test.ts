// The enclave wallet's way in, and the way the window learns about it.
//
// Three screens share one property: on a Secure Enclave wallet nothing in the
// window asks for, draws, or imitates a password. The lock screen is one
// button that raises the system dialog; the first run is one button that makes
// the wallet and one Touch ID that proves it opens; the shell routes the
// deposit watcher's frames and says "not backed up" in its notice line until
// the phrase has been typed back. Each is run for real over a small DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const LOCK = read('../../ui/screens/lock.js');
const FIRSTRUN = read('../../ui/screens/firstrun.js');
const SHELL = read('../../ui/screens/shell.js');

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
    rows: 0,
    inert: false,
    tabIndex: 0,
    dataset: {} as Record<string, string>,
    style: { setProperty() {} } as Any,
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
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
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

function textOf(node: Any): string[] {
  const out: string[] = [];
  const walk = (n: Any): void => {
    if (n.childNodes.length === 0) {
      if (n.textContent !== '') out.push(n.textContent);
      return;
    }
    for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return out;
}

const buttonNamed = (root: Any, label: string): Any => find(root, 'button').find((b: Any) => b.textContent === label) as Any;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- the window ---------- */

function vaultState(overrides: Any = {}): Any {
  return Object.assign({
    custody: 'secure-enclave',
    state: 'locked',
    enclave: { attached: true, ready: true, capability: { secureEnclave: true, biometry: 'touchid', canAuthenticate: true }, keyMadeAt: '2026-09-14T09:00:00.000Z', binding: 'device' },
    foreign: false,
    waiting: null,
    backedUp: false,
    backedUpAt: null,
    idleMinutes: 15,
    hasMnemonic: true,
  }, overrides);
}

type World = {
  sandbox: Any;
  store: Any;
  nodes: Record<string, Any>;
  calls: Any[];
  answer: Any;
  put: (patch: Any) => void;
  events: Record<string, Array<(frame: Any) => void>>;
};

function build(state: Any, sources: string[]): World {
  const nodes: Record<string, Any> = {};
  for (const id of ['screen-lock', 'screen-firstrun', 'page', 'notice']) {
    nodes[id] = makeNode('div');
  }
  // The notice line at the foot of the world: a glyph, the words, and the way through.
  for (const [tag, role] of [['use', 'notice-icon'], ['span', 'notice-text'], ['button', 'notice-act']]) {
    const part = makeNode(tag);
    part.setAttribute('data-role', role);
    nodes.notice.appendChild(part);
  }
  nodes.notice.hidden = true;
  const body = makeNode('body');
  const calls: Any[] = [];
  const answer: Any = {
    unlock: { ok: true, released: 0 },
    create: { ok: true, addresses: { evm: '0xabc', solana: 'sol', near: 'near' }, custody: 'secure-enclave' },
    restore: { ok: true, addresses: {} },
    state: null,
  };
  const events: Record<string, Array<(frame: Any) => void>> = {};

  const doc: Any = {
    body,
    createElement: makeNode,
    getElementById: (id: string) => nodes[id] ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const sandbox: Any = {
    console,
    document: doc,
    location: { search: '' },
    URLSearchParams,
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: class { type: string; detail: Any; constructor(type: string, init: Any) { this.type = type; this.detail = init && init.detail; } },
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
  };
  sandbox.window = sandbox;
  sandbox.PhosphorNet = { readable: (e: Any) => String(e && e.message ? e.message : e) };
  sandbox.PhosphorMotion = { reduced: () => true };
  sandbox.PhosphorEvents = {
    on: (type: string, fn: (frame: Any) => void) => { (events[type] ||= []).push(fn); },
    onConnection: (fn: (c: string) => void) => { fn('live'); },
    start() {},
  };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean, label: string) { button.disabled = !!pending; button.pendingLabel = pending ? label : ''; },
    refresh: () => { calls.push({ route: 'refresh' }); return Promise.resolve(); },
    setView: (name: string) => { calls.push({ route: 'setView', view: name }); },
    view: () => 'basic',
    updateField() {},
  };
  sandbox.PhosphorToast = { show: (message: string) => { calls.push({ route: 'toast', message }); } };
  sandbox.PhosphorMoneyIn = { render: (host: Any) => { calls.push({ route: 'moneyin.render' }); host.appendChild(makeNode('div')); } };
  sandbox.PhosphorDeposit = { onFrame: (frame: Any) => { calls.push({ route: 'deposit.onFrame', frame }); } };
  sandbox.PhosphorVault = { focusRecovery() { calls.push({ route: 'focusRecovery' }); } };
  sandbox.PhosphorFirstRun = { open() { calls.push({ route: 'firstrun.open' }); }, boot() {}, strengthWords: () => '' };
  sandbox.PhosphorApi = {
    unlock: (password: string) => { calls.push({ route: '/api/unlock', password }); return Promise.resolve({ ok: true }); },
    vaultUnlock: (purpose?: string) => { calls.push({ route: '/api/vault/unlock', purpose }); return Promise.resolve(answer.unlock); },
    vaultCreate: () => { calls.push({ route: '/api/vault/create' }); return Promise.resolve(answer.create); },
    vaultRestore: (mnemonic: string) => { calls.push({ route: '/api/vault/restore', mnemonic }); return Promise.resolve(answer.restore); },
    walletCreate: (password: string) => { calls.push({ route: '/api/wallet/create', password }); return Promise.resolve({ ok: true, mnemonic: [], addresses: {} }); },
    connection: () => Promise.resolve({ missing: true }),
    driver: () => Promise.resolve({}),
    state: () => Promise.resolve({ data: answer.state ?? state, fresh: true }),
    health: () => Promise.resolve({ data: {} }),
  };

  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  for (const source of sources) {
    const file = source === LOCK ? 'ui/screens/lock.js' : source === FIRSTRUN ? 'ui/screens/firstrun.js' : 'ui/screens/shell.js';
    runInContext(source, sandbox, { filename: file });
  }

  const store = sandbox.PhosphorState;
  store.put(state);
  return {
    sandbox,
    store,
    nodes,
    calls,
    answer,
    events,
    put: (patch: Any) => store.put(Object.assign({}, store.get(), patch)),
  };
}

/* ---------- the lock screen ---------- */

test('an enclave wallet locks to one button and never a password field', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState() }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  assert.equal(screen.hidden, false, 'the lock screen is not up');
  assert.equal(find(screen, 'input').length, 0, 'a field was drawn on an enclave lock screen');
  assert.equal(find(screen, 'form').length, 0);
  const buttons = find(screen, 'button');
  assert.equal(buttons.length, 1, 'more than one button on the lock screen');
  assert.equal(buttons[0].textContent, 'Unlock with Touch ID');
  assert.ok(textOf(screen).includes('Phosphor is locked'));

  // The click posts /api/vault/unlock with no purpose, and the button is dead
  // and says why until the dialog answers.
  let resolveUnlock: (value: Any) => void = () => {};
  world.sandbox.PhosphorApi.vaultUnlock = (purpose?: string) => {
    world.calls.push({ route: '/api/vault/unlock', purpose });
    return new Promise((resolve) => { resolveUnlock = resolve; });
  };
  buttons[0].click();
  assert.equal(buttons[0].disabled, true, 'the button took a second click while the dialog was up');
  assert.equal(buttons[0].getAttribute('data-pending-label'), 'Waiting for Touch ID');
  const post = world.calls.find((c) => c.route === '/api/vault/unlock');
  assert.ok(post, 'nothing was posted');
  assert.equal(post.purpose, undefined);
  assert.equal(world.calls.some((c) => c.route === '/api/unlock'), false, 'the password route was posted from an enclave lock screen');

  // A cancel brings the button back, with nothing to read.
  resolveUnlock({ ok: false, error: 'cancelled', code: 'user_cancel' });
  await flush();
  assert.equal(buttons[0].disabled, false, 'the button stayed dead after a cancel');
  assert.equal(find(screen, '.down').some((n: Any) => n.hidden === false && n.textContent !== ''), false, 'a cancel was shown as an error');

  // A success refreshes the state, and the screen goes with the lock.
  world.sandbox.PhosphorApi.vaultUnlock = () => Promise.resolve({ ok: true, released: 0 });
  buttons[0].click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === 'refresh'));
  world.put({ lock: { state: 'unlocked', idleLocksInSec: null } });
  assert.equal(screen.hidden, true);
});

test('a refusal other than a cancel is on the screen, in words', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState() }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  world.answer.unlock = { ok: false, error: 'no relay', code: 'enclave_unavailable' };
  find(world.nodes['screen-lock'], 'button')[0].click();
  await flush();
  assert.ok(textOf(world.nodes['screen-lock']).some((t) => t.startsWith('The Secure Enclave did not answer')));
});

test('a password wallet still locks to a password field and posts /api/unlock', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software' }) }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  const input = find(screen, 'input[type="password"]')[0];
  assert.ok(input, 'no password field on a password lock screen');
  assert.equal(input.focused, true, 'the field is not focused on arrival');
  assert.ok(textOf(screen).includes('Phosphor is locked'));
  const unlock = buttonNamed(screen, 'Unlock');
  assert.ok(unlock, 'no Unlock button');
  assert.equal(unlock.type, 'submit', 'Enter in the field would not submit');
  input.value = 'hunter22';
  find(screen, 'form')[0].dispatch('submit');
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/unlock' && c.password === 'hunter22'));
  assert.equal(world.calls.some((c) => c.route === '/api/vault/unlock'), false);
});

test('a wrong password says so in one line, clears the field and keeps the cursor in it', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software' }) }, [LOCK]);
  world.sandbox.PhosphorApi.unlock = () => Promise.resolve({ ok: false, error: 'That password is wrong.', code: 'wrong_password' });
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  const input = find(screen, 'input[type="password"]')[0];
  input.value = 'nope';
  input.focused = false;
  find(screen, 'form')[0].dispatch('submit');
  await flush();
  const error = find(screen, '.lock-error')[0];
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'Wrong password. Try again.');
  assert.equal(input.value, '');
  assert.equal(input.focused, true);
  assert.equal(find(screen, '.banner').length, 0, 'the error is a bar, not a line');
});

test('the eye shows and hides the password without leaving the field', () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software' }) }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  const input = find(screen, 'input')[0];
  const eye = find(screen, 'button.lock-eye')[0];
  assert.ok(eye, 'no show/hide toggle');
  assert.equal(eye.type, 'button', 'the toggle would submit the form');
  assert.equal(eye.getAttribute('aria-pressed'), 'false');
  input.focused = false;
  eye.click();
  assert.equal(input.type, 'text');
  assert.equal(eye.getAttribute('aria-pressed'), 'true');
  assert.equal(eye.getAttribute('aria-label'), 'Hide password');
  assert.equal(input.focused, true, 'the toggle took the focus');
  eye.click();
  assert.equal(input.type, 'password');
  assert.equal(eye.getAttribute('aria-label'), 'Show password');
});

test('unlocking without motion.dev simply takes the screen down, and a lock mid-way puts it back', () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software' }) }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  assert.equal(world.sandbox.document.body.getAttribute('data-locked'), 'true');
  assert.equal(world.nodes.page.inert, true);
  world.put({ lock: { state: 'unlocked', idleLocksInSec: null } });
  assert.equal(screen.hidden, true);
  assert.equal(world.sandbox.document.body.getAttribute('data-locked'), null);
  assert.equal(world.nodes.page.inert, false);
  world.put({ lock: { state: 'locked', idleLocksInSec: null } });
  assert.equal(screen.hidden, false);
  assert.ok(find(screen, 'input[type="password"]')[0], 'the field did not come back');
});

test('a wallet file made on another Mac hands over to the first run instead of asking for Touch ID', () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ foreign: true }) }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  assert.equal(world.nodes['screen-lock'].hidden, true);
  assert.ok(world.calls.some((c) => c.route === 'firstrun.open'));
});

test('focus lands on the Touch ID button where there is no field', () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState() }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const button = find(world.nodes['screen-lock'], 'button')[0];
  button.focused = false;
  world.sandbox.PhosphorLock.focus();
  assert.equal(button.focused, true);
});

test('the fine print says what really runs while the app is locked, for both kinds of wallet', () => {
  for (const custody of ['software', 'secure-enclave']) {
    const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody }) }, [LOCK]);
    world.sandbox.PhosphorLock.boot();
    const fine = find(world.nodes['screen-lock'], '.lock-fine')[0].textContent;
    assert.ok(fine.includes('Nothing new is sent while Phosphor is locked; orders already on the exchange still run.'), `${custody}: ${fine}`);
    assert.doesNotMatch(fine, /nothing moves|cannot be reset/i, `${custody}: a promise the lock cannot keep`);
  }
});

test('too many tries count down in place, hold Unlock in its outline until nought, then clear', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software' }) }, [LOCK]);
  const ticks: Array<() => void> = [];
  world.sandbox.setInterval = (fn: () => void) => { ticks.push(fn); return 7; };
  world.sandbox.clearInterval = () => { ticks.length = 0; };
  world.sandbox.PhosphorApi.unlock = () => Promise.resolve({ ok: false, error: 'Too many tries.', code: 'locked_out', retryInSec: 3 });
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  const input = find(screen, 'input[type="password"]')[0];
  const unlock = buttonNamed(screen, 'Unlock');
  input.value = 'nope';
  find(screen, 'form')[0].dispatch('submit');
  await flush();
  const error = find(screen, '.lock-error')[0];
  assert.equal(error.textContent, 'Too many tries. Try again in 3 seconds.');
  assert.equal(unlock.disabled, true, 'Unlock stayed live while the app refuses every try');
  assert.equal(unlock.getAttribute('data-waiting'), 'true');
  // A press while waiting posts nothing.
  const posts = world.calls.length;
  input.value = 'again';
  find(screen, 'form')[0].dispatch('submit');
  await flush();
  assert.equal(world.calls.length, posts, 'a try went out during the wait');
  ticks[0]();
  assert.equal(error.textContent, 'Too many tries. Try again in 2 seconds.');
  ticks[0]();
  assert.equal(error.textContent, 'Too many tries. Try again in 1 second.');
  ticks[0]();
  assert.equal(unlock.disabled, false, 'Unlock did not come back at nought');
  assert.equal(unlock.getAttribute('data-waiting'), null);
  assert.equal(error.hidden, true, 'the line stayed after the wait');
});

test('a forgotten password has a way back where this Mac has Touch ID: the phrase, in the card, and a second press', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software' }) }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  const forgot = find(screen, 'button.lock-forgot')[0];
  assert.ok(forgot, 'no way back from a forgotten password');
  assert.equal(forgot.textContent, 'Forgot your password? Restore from your recovery phrase');
  const step = find(screen, '.lock-restore')[0];
  const form = find(screen, 'form')[0];
  assert.equal(step.hidden, true);
  forgot.click();
  assert.equal(step.hidden, false);
  assert.equal(form.hidden, true, 'the password field stayed beside the phrase');
  const phrase = find(step, 'textarea')[0];
  const go = buttonNamed(step, 'Restore');
  phrase.value = 'one two';
  go.click();
  await flush();
  assert.ok(textOf(step).includes('That is 2 words. It should be 12 or 24.'));
  const words = Array.from({ length: 12 }, (_v, i) => 'w' + (i + 1));
  phrase.value = words.join(' ');
  go.click();
  await flush();
  assert.equal(world.calls.some((c) => c.route === '/api/vault/restore'), false, 'one press replaced the wallet');
  assert.ok(textOf(step).some((t) => t.startsWith('This replaces the wallet on this Mac with the one your phrase makes.')));
  go.click();
  await flush();
  await flush();
  const post = world.calls.find((c) => c.route === '/api/vault/restore');
  assert.ok(post, 'the restore was not posted');
  assert.equal(post.mnemonic, words.join(' '));
  assert.ok(world.calls.some((c) => c.route === 'refresh'));
  // Back to the password, and no way back offered where there is no Touch ID to restore behind.
  buttonNamed(step, 'Use my password').click();
  assert.equal(form.hidden, false);
  const bare = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software', enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } }) }, [LOCK]);
  bare.sandbox.PhosphorLock.boot();
  assert.equal(find(bare.nodes['screen-lock'], 'button.lock-forgot').length, 0, 'a restore offered where it cannot run');
});

/* ---------- the first run ---------- */

test('with the enclave ready, the first run is the welcome, Create wallet, the addresses, the assistant, then Home', async () => {
  const world = build({ lock: { state: 'no_wallet', idleLocksInSec: null }, vault: vaultState({ custody: null, state: 'no_wallet' }) }, [FIRSTRUN]);
  world.sandbox.PhosphorFirstRun.boot();
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  assert.equal(screen.hidden, false);
  assert.equal(world.sandbox.document.body.getAttribute('data-firstrun'), 'true', 'the page is not hidden behind the card');

  // The welcome: the mark, the name, one button, and no count.
  assert.equal(find(screen, 'input').length, 0, 'the welcome asks for something typed');
  assert.equal(find(screen, '.firstrun-mark').length, 1, 'no mark');
  const welcome = find(screen, 'button');
  assert.equal(welcome.length, 1, 'more than one button on the welcome');
  assert.equal(welcome[0].textContent, 'Get started');
  assert.ok(textOf(screen).includes('Welcome to Phosphor'));
  assert.equal(find(screen, '.screen-progress').length, 0, 'a step count on the welcome');
  welcome[0].click();

  // Create wallet: one button, nothing typed, the first of three steps.
  assert.equal(find(screen, 'input.input, textarea').length, 0, 'the enclave first run asks for something typed');
  const buttons = find(screen, 'button');
  assert.equal(buttons.length, 1, 'more than one button on the create screen');
  assert.equal(buttons[0].textContent, 'Create wallet');
  assert.ok(textOf(screen).includes('Step 1 of 3'));
  assert.ok(textOf(screen).some((t) => t.startsWith('Locked by this Mac')), 'the enclave create screen does not say where the key is held');

  buttons[0].click();
  assert.equal(buttons[0].getAttribute('data-pending-label'), 'Waiting for Touch ID');
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/vault/create'));
  assert.equal(world.calls.some((c) => c.route === '/api/wallet/create'), false, 'the password route was posted');

  // The addresses step, the existing one.
  assert.ok(textOf(screen).includes('Your addresses'));
  assert.ok(textOf(screen).includes('Step 2 of 3'));
  assert.ok(world.calls.some((c) => c.route === 'moneyin.render'));
  buttonNamed(screen, 'Continue').click();

  // The assistant step, the agent picker, and its Continue is Home.
  assert.ok(textOf(screen).includes('Your assistant'));
  assert.ok(textOf(screen).includes('Step 3 of 3'));
  buttonNamed(screen, 'Continue').click();
  assert.equal(screen.hidden, true, 'the first run did not close');
  assert.ok(world.calls.some((c) => c.route === 'setView' && c.view === 'basic'), 'Home was not opened');
});

test('a cancelled Touch ID on Create says so and stays on the screen', async () => {
  const world = build({ lock: { state: 'no_wallet', idleLocksInSec: null }, vault: vaultState({ custody: null, state: 'no_wallet' }) }, [FIRSTRUN]);
  world.answer.create = { ok: false, error: 'cancelled', code: 'user_cancel' };
  world.sandbox.PhosphorFirstRun.boot();
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  buttonNamed(screen, 'Get started').click();
  find(screen, 'button')[0].click();
  await flush();
  assert.ok(textOf(screen).includes('Touch ID was cancelled. Nothing was changed.'));
  assert.equal(find(screen, 'button')[0].textContent, 'Create wallet');
});

test('a file made on another Mac opens, after the welcome, on Restore: one field, one button, 12 or 24 words', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ foreign: true }) }, [FIRSTRUN]);
  world.sandbox.PhosphorFirstRun.boot();
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  assert.ok(textOf(screen).includes('Welcome to Phosphor'));
  buttonNamed(screen, 'Get started').click();
  assert.ok(textOf(screen).includes('Made on another Mac'));
  const fields = find(screen, 'textarea');
  assert.equal(fields.length, 1, 'the restore screen does not have exactly one field');
  assert.equal(find(screen, 'input').length, 0);
  const buttons = find(screen, 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, 'Restore');

  fields[0].value = 'one two three';
  buttons[0].click();
  await flush();
  assert.equal(world.calls.some((c) => c.route === '/api/vault/restore'), false, 'three words were posted');
  assert.ok(textOf(screen).includes('That is 3 words. It should be 12 or 24.'));

  const words = Array.from({ length: 24 }, (_v, i) => 'w' + (i + 1));
  fields[0].value = '  ' + words.join('   ').toUpperCase() + '\n';
  buttons[0].click();
  await flush();
  const post = world.calls.find((c) => c.route === '/api/vault/restore');
  assert.ok(post, 'nothing was posted');
  assert.equal(post.mnemonic, words.join(' '));
  assert.ok(textOf(screen).includes('Your addresses'), 'restore did not go on to the addresses');
});

test('without an enclave the software first run keeps its screens after the welcome: nine steps from Get started', () => {
  const world = build({ lock: { state: 'no_wallet', idleLocksInSec: null }, vault: vaultState({ custody: null, state: 'no_wallet', enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } }) }, [FIRSTRUN]);
  world.sandbox.PhosphorFirstRun.boot();
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  assert.ok(textOf(screen).includes('Welcome to Phosphor'));
  assert.equal(find(screen, 'button')[0].textContent, 'Get started');
  find(screen, 'button')[0].click();
  assert.ok(textOf(screen).includes('Step 1 of 9'));
  assert.ok(textOf(screen).includes('Create or bring a wallet'));
  buttonNamed(screen, 'Continue').click();
  assert.ok(textOf(screen).includes('Step 2 of 9'));
  assert.ok(textOf(screen).includes('Set a password'));
  assert.ok(textOf(screen).some((t) => t.startsWith('Locked by your password')), 'the password screen does not say where the key is held');
});

/* ---------- the shell ---------- */

test('the shell routes deposit frames to the store and the card, and says "not backed up" in the notice', async () => {
  const state = {
    lock: { state: 'unlocked', idleLocksInSec: null },
    vault: vaultState({ state: 'unlocked', backedUp: false }),
    proposals: [],
    policy: {},
    deposit: null,
  };
  const world = build(state, [SHELL]);
  world.sandbox.PhosphorShell.boot();
  await flush();
  assert.ok(world.events.deposit && world.events.deposit.length === 1, 'the shell does not listen for deposit frames');

  const frame = { type: 'deposit', phase: 'watching', chain: 'sol', symbol: 'USDC', address: 'abc', startedAt: '2026-09-14T10:00:00.000Z', baseline: 0, amount: null, txHash: null, ms: null };
  world.events.deposit[0](frame);
  const stored = world.store.get().deposit;
  assert.equal(stored.phase, 'watching');
  assert.equal(stored.type, undefined, 'the frame type leaked into the state slice');
  const routed = world.calls.find((c) => c.route === 'deposit.onFrame');
  assert.ok(routed, 'the card was not told');
  assert.equal(routed.frame.startedAt, frame.startedAt);

  // A frame with no phase is not a deposit frame.
  world.events.deposit[0]({ type: 'deposit' });
  assert.equal(world.calls.filter((c) => c.route === 'deposit.onFrame').length, 1);

  // The notice: on while a wallet exists and is not proven backed up, off once it is.
  const notice = world.nodes.notice;
  const text = find(notice, '[data-role="notice-text"]')[0];
  const act = find(notice, '[data-role="notice-act"]')[0];
  assert.equal(notice.hidden, false, 'nothing said about a wallet that is not backed up');
  assert.equal(text.textContent, 'Recovery phrase not backed up.');
  assert.equal(act.textContent, 'Back it up');
  assert.equal(act.hidden, false);
  world.put({ vault: vaultState({ state: 'unlocked', backedUp: true }) });
  assert.equal(notice.hidden, true, 'the line stayed after the phrase was proven');
  world.put({ vault: vaultState({ custody: null, state: 'no_wallet', backedUp: false }) });
  assert.equal(notice.hidden, true, 'a backup line with no wallet to back up');

  // The line is a way in.
  world.put({ vault: vaultState({ state: 'unlocked', backedUp: false }) });
  act.click();
  assert.ok(world.calls.some((c) => c.route === 'focusRecovery'));
});

test('the notice says the one thing that matters most: the app not answering, then a freeze, then the backup', async () => {
  const state = {
    lock: { state: 'unlocked', idleLocksInSec: null },
    vault: vaultState({ state: 'unlocked', backedUp: false }),
    proposals: [],
    policy: { killSwitch: true },
    basic: { warning: 'You have frozen everything. The assistant cannot move any money.' },
    deposit: null,
  };
  const world = build(state, [SHELL]);
  world.sandbox.PhosphorShell.boot();
  await flush();
  const notice = world.nodes.notice;
  const text = find(notice, '[data-role="notice-text"]')[0];
  const act = find(notice, '[data-role="notice-act"]')[0];
  const icon = find(notice, '[data-role="notice-icon"]')[0];
  assert.equal(text.textContent, 'You have frozen everything. The assistant cannot move any money.');
  assert.equal(act.textContent, 'Unfreeze');
  assert.equal(icon.getAttribute('href'), '#i-freeze');

  // Rules that cannot be read have nothing to press.
  world.put({ policy: {}, basic: { warning: 'The safety rules cannot be read, so every move is being refused.' } });
  assert.equal(text.textContent, 'The safety rules cannot be read, so every move is being refused.');
  assert.equal(act.hidden, true);
  assert.equal(icon.getAttribute('href'), '#i-warning');
});

/* The macOS shell says a restart and a copied connection line in the window's own notice
   (src-tauri/src/main.rs notice_script calls window.__phosphorShellNotice). The line stands
   after "not answering", holds for ten seconds or until a click, and then the notice goes
   back to whatever it was saying. */
test('a line from the macOS shell shows after "not answering", and goes after ten seconds or a click', async () => {
  const state = {
    lock: { state: 'unlocked', idleLocksInSec: null },
    vault: vaultState({ state: 'unlocked', backedUp: false }),
    proposals: [],
    policy: {},
    deposit: null,
  };
  const world = build(state, [SHELL]);
  let connect: (next: string) => void = () => {};
  world.sandbox.PhosphorEvents.onConnection = (fn: (c: string) => void) => { connect = fn; fn('live'); };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  world.sandbox.PhosphorShell.boot();
  await flush();
  world.sandbox.setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  const notice = world.nodes.notice;
  const text = find(notice, '[data-role="notice-text"]')[0];
  const act = find(notice, '[data-role="notice-act"]')[0];
  const icon = find(notice, '[data-role="notice-icon"]')[0];
  const backup = 'Recovery phrase not backed up.';
  assert.equal(text.textContent, backup);

  const restarted = "Phosphor stopped and started again. Anything that was moving then shows as Not confirmed in Pro's Recent moves, so check it before you act again.";
  assert.equal(typeof world.sandbox.__phosphorShellNotice, 'function', 'the shell has no way into the notice');
  world.sandbox.__phosphorShellNotice(restarted);
  assert.equal(notice.hidden, false);
  assert.equal(text.textContent, restarted);
  assert.equal(act.hidden, true, 'the shell line offers the backup line\'s press');
  assert.equal(icon.getAttribute('href'), '#i-warning');
  assert.equal(timers.at(-1)?.ms, 10000, 'the line does not go after ten seconds');
  timers.at(-1)!.fn();
  assert.equal(text.textContent, backup, 'the backup line did not come back');
  assert.equal(act.hidden, false);

  // A click on the line puts it away early; a click on the backup line does nothing to it.
  world.sandbox.__phosphorShellNotice('The connection line for your agent is on the clipboard.');
  assert.equal(icon.getAttribute('href'), '#i-copy');
  notice.click();
  assert.equal(text.textContent, backup);
  notice.click();
  assert.equal(text.textContent, backup);

  // "Not answering" outranks it, and it is still there once the app answers again.
  world.sandbox.__phosphorShellNotice(restarted);
  connect('offline');
  assert.match(text.textContent, /^The app stopped answering/);
  connect('live');
  assert.equal(text.textContent, restarted);
});

test('the Vault tab is one of the views the shell knows', () => {
  assert.ok(/VIEWS = \[[^\]]*'vault'/.test(SHELL), 'shell.js does not list the vault view');
});
