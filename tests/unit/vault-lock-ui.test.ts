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

import { refusal, refusalCodes } from '../../src/http/wallet.ts';
import { RAW, SERVICE_MESSAGE, VAULT_REFUSAL_CODES } from '../fixtures/vault-refusal-codes.ts';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const CUSTODY = read('../../ui/core/custody.js');
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

/* A selector with a descendant step ("a b") matches its last part on a node with an ancestor
   for each step before it, as the shell's reveal asks for its section. */
function under(node: Any, steps: string[]): boolean {
  if (!steps.length) return true;
  for (let at = node.parentNode; at; at = at.parentNode) {
    if (matches(at, steps[steps.length - 1]!) && under(at, steps.slice(0, -1))) return true;
  }
  return false;
}

function find(root: Any, selector: string): Any[] {
  const chain = selector.trim().split(/\s+(?![^\[]*\])/);
  if (chain.length > 1 && !selector.includes(',')) {
    return find(root, chain[chain.length - 1]!).filter((n: Any) => under(n, chain.slice(0, -1)));
  }
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
// What a person can see: nothing under a hidden parent.
const shown = (nodes: Any[]): Any[] => nodes.filter((n: Any) => {
  for (let at = n; at; at = at.parentNode) if (at.hidden) return false;
  return true;
});
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
    vaultRestoreKey: (key: string) => { calls.push({ route: '/api/vault/restore', key }); return Promise.resolve(answer.restore); },
    walletCreate: (password: string) => { calls.push({ route: '/api/wallet/create', password }); return Promise.resolve({ ok: true, mnemonic: [], addresses: {} }); },
    connection: () => Promise.resolve({ missing: true }),
    driver: () => Promise.resolve({}),
    state: () => Promise.resolve({ data: answer.state ?? state, fresh: true }),
    health: () => Promise.resolve({ data: {} }),
  };

  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(CUSTODY, sandbox, { filename: 'ui/core/custody.js' });
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
  const buttons = shown(find(screen, 'button'));
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
  assert.ok(textOf(world.nodes['screen-lock']).includes('Touch ID did not answer. Open the Phosphor app and try again.'));
  assert.equal(shown(find(world.nodes['screen-lock'], 'button.lock-forgot')).length, 0, 'a restore offered for a Touch ID that may answer next time');
});

/* A wallet file this Mac will not open is not opened by asking again: the line says what happened
   and the way under it is the backup, in the card. */
for (const code of ['pin_mismatch', 'not_committed', 'blob_refused', 'damaged']) {
  test(`${code}: the lock card says the file stayed closed and offers the restore that opens it`, async () => {
    const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ hasMnemonic: false }) }, [LOCK]);
    world.sandbox.PhosphorLock.boot();
    const screen = world.nodes['screen-lock'];
    assert.equal(shown(find(screen, 'button.lock-forgot')).length, 0, 'the restore was offered before anything was refused');
    world.answer.unlock = { ok: false, error: 'a sentence the card says better', code };
    buttonNamed(screen, 'Unlock with Touch ID').click();
    await flush();
    const line = textOf(find(screen, '.lock-error')[0]).join(' ');
    assert.ok(line.endsWith('Restore your wallet from your private key to open it here.'), line);
    assert.ok(/nothing moved/.test(line), line);
    const way = shown(find(screen, 'button.lock-forgot'));
    assert.equal(way.length, 1, 'no way to use the backup the line names');
    assert.equal(way[0].textContent, 'Restore from your private key');
    way[0].click();
    const step = find(screen, '.lock-restore')[0];
    assert.equal(step.hidden, false);
    assert.equal(shown(find(screen, 'button')).some((b: Any) => b.textContent === 'Unlock with Touch ID'), false, 'the refused button stayed beside the restore');
    assert.ok(textOf(step).includes('Type your private key, 64 characters. Phosphor opens your wallet from it here, behind Touch ID.'));
    world.answer.restore = { ok: true, addresses: { evm: WALLET } };
    const field = find(step, 'textarea')[0];
    field.value = GROUPS.join(' ');
    buttonNamed(step, 'Restore').click();
    buttonNamed(step, 'Restore').click();
    await flush();
    await flush();
    assert.equal((world.calls.find((c) => c.route === '/api/vault/restore') as Any).key, '0x' + GROUPS.join(''));
    assert.ok(world.calls.some((c) => c.route === 'toast' && c.message === `Restored. This Mac now holds the wallet ${WALLET.slice(0, 6)}...${WALLET.slice(-4)}.`), 'the wallet that came back was not named');
    assert.ok(world.calls.some((c) => c.route === 'refresh'));
    // Back puts the unlock button where it was.
    const back = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState() }, [LOCK]);
    back.sandbox.PhosphorLock.boot();
    back.answer.unlock = { ok: false, error: 'x', code };
    buttonNamed(back.nodes['screen-lock'], 'Unlock with Touch ID').click();
    await flush();
    assert.equal(shown(find(back.nodes['screen-lock'], 'button.lock-forgot'))[0].textContent, 'Restore from your recovery phrase');
    shown(find(back.nodes['screen-lock'], 'button.lock-forgot'))[0].click();
    buttonNamed(back.nodes['screen-lock'], 'Back').click();
    assert.equal(shown(find(back.nodes['screen-lock'], 'button')).some((b: Any) => b.textContent === 'Unlock with Touch ID'), true);
  });
}

/* Every code the backend can say, and every code the service and the relays can answer, as the
   backend says it and again carrying the service's own log text: the card shows a sentence. */
test('every refusal an unlock can be handed reads as a sentence on the lock card, and no service text reaches it', async () => {
  const codes = [...new Set([...refusalCodes(), ...VAULT_REFUSAL_CODES])].filter((c) => c !== 'user_cancel');
  for (const code of codes) {
    for (const answer of [refusal(code), { ok: false, code, error: SERVICE_MESSAGE }]) {
      const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState() }, [LOCK]);
      world.sandbox.PhosphorLock.boot();
      world.answer.unlock = answer;
      buttonNamed(world.nodes['screen-lock'], 'Unlock with Touch ID').click();
      await flush();
      const said = textOf(find(world.nodes['screen-lock'], '.lock-error')[0]).join(' ');
      assert.ok(said.length > 0, `${code}: nothing was said`);
      assert.ok(!RAW.test(said), `${code}: ${said}`);
      for (const part of SERVICE_MESSAGE.split('; ')) assert.ok(!said.includes(part), `${code}: ${said}`);
    }
  }
});

/* What the service writes for its logs never reaches the card, whatever answer carries it. */
test('a refusal that is not a sentence is never put on the card: the card says Touch ID did not finish', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState() }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  for (const [error, code] of [['no user present', 'interaction_required'], ['keychain key -25300', 'auth_failed'], ['', 'a_code_from_a_newer_service']]) {
    world.answer.unlock = { ok: false, error, code };
    buttonNamed(screen, 'Unlock with Touch ID').click();
    await flush();
    const said = textOf(find(screen, '.lock-error')[0]).join(' ');
    assert.equal(said, 'Touch ID did not finish, so nothing changed. Try again.', `${code}: ${said}`);
  }
  // The backend's own sentence for a code is what the card says.
  world.answer.unlock = { ok: false, error: 'Touch ID could not ask you just now, so nothing changed. Unlock your Mac and try again.', code: 'interaction_required' };
  buttonNamed(screen, 'Unlock with Touch ID').click();
  await flush();
  assert.equal(textOf(find(screen, '.lock-error')[0]).join(' '), 'Touch ID could not ask you just now, so nothing changed. Unlock your Mac and try again.');
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
    assert.ok(fine.includes('Nothing new is sent while Phosphor is locked, except by a plan you armed; orders already on the exchange still run.'), `${custody}: ${fine}`);
    assert.doesNotMatch(fine, /nothing moves|cannot be reset/i, `${custody}: a promise the lock cannot keep`);
  }
});

/* ---------- why it locked, and what waits ---------- */

// The lines under the title, in order, or [] when the block is hidden or absent.
function whyOf(world: World): string[] {
  const block = find(world.nodes['screen-lock'], '.lock-why')[0];
  if (!block || block.hidden) return [];
  return find(block, 'p').filter((p: Any) => !p.hidden).map((p: Any) => p.textContent);
}

test('the lock screen says why it locked, in one line under the title, for each reason the backend names', () => {
  const cases: Array<[string, number, string]> = [
    ['screen', 5, 'Locked when your screen locked.'],
    ['switch', 5, 'Locked when this Mac switched users.'],
    ['sleep', 5, 'Locked while this Mac was asleep.'],
    ['idle', 5, 'Locked after 5 quiet minutes.'],
    ['idle', 15, 'Locked after 15 quiet minutes.'],
    ['idle', 60, 'Locked after a quiet hour.'],
  ];
  for (const custody of ['software', 'secure-enclave']) {
    for (const [reason, idleMinutes, line] of cases) {
      const world = build({ lock: { state: 'locked', idleLocksInSec: null, reason, waiting: 0 }, vault: vaultState({ custody, idleMinutes }) }, [LOCK]);
      world.sandbox.PhosphorLock.boot();
      assert.deepEqual(whyOf(world), [line], `${custody} ${reason} ${idleMinutes}`);
      const title = find(world.nodes['screen-lock'], '.lock-title')[0];
      assert.equal(title.textContent, 'Phosphor is locked');
    }
  }
});

test('Lock now, the app starting, and a reason the window does not know get no line', () => {
  for (const reason of [null, undefined, 'quitting', 'the screen locked']) {
    const world = build({ lock: { state: 'locked', idleLocksInSec: null, reason, waiting: 0 }, vault: vaultState({ custody: 'software', idleMinutes: 5 }) }, [LOCK]);
    world.sandbox.PhosphorLock.boot();
    assert.deepEqual(whyOf(world), [], String(reason));
  }
});

test('waiting moves are counted, never named, with one and with many', () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null, reason: 'screen', waiting: 1 }, vault: vaultState({ custody: 'software', idleMinutes: 5 }) }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  assert.deepEqual(whyOf(world), ['Locked when your screen locked.', '1 move is waiting for your OK.']);

  // A second move arrives while locked: the line changes in place and the field keeps what was typed.
  const input = find(world.nodes['screen-lock'], 'input[type="password"]')[0];
  input.value = 'half a passw';
  world.put({ lock: { state: 'locked', idleLocksInSec: null, reason: 'screen', waiting: 2 } });
  assert.deepEqual(whyOf(world), ['Locked when your screen locked.', '2 moves are waiting for your OK.']);
  assert.equal(find(world.nodes['screen-lock'], 'input[type="password"]')[0], input, 'the card was rebuilt under the person typing');
  assert.equal(input.value, 'half a passw');

  // A count with no reason (Lock now) still says what waits.
  world.put({ lock: { state: 'locked', idleLocksInSec: null, reason: null, waiting: 3 } });
  assert.deepEqual(whyOf(world), ['3 moves are waiting for your OK.']);

  // Nothing waiting and no reason: the block goes, so no gap is left under the title.
  world.put({ lock: { state: 'locked', idleLocksInSec: null, reason: null, waiting: 0 } });
  assert.deepEqual(whyOf(world), []);
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
  const fine = find(screen, '.lock-fine')[0];
  assert.equal(step.hidden, true);
  forgot.click();
  assert.equal(step.hidden, false);
  assert.equal(form.hidden, true, 'the password field stayed beside the phrase');
  assert.equal(fine.hidden, true, 'the card still says what the password does to a person who forgot it');
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
  assert.equal(fine.hidden, false);
  const bare = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software', enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } }) }, [LOCK]);
  bare.sandbox.PhosphorLock.boot();
  assert.equal(find(bare.nodes['screen-lock'], 'button.lock-forgot').length, 0, 'a restore offered where it cannot run');
});

// Sixteen made-up groups of four, a private key as the Vault's backup shows one.
const GROUPS = ['3f9a', '07c2', 'b41e', '5d68', 'e2a0', '9b17', '4c3d', 'f805', '1a6e', 'c9b2', '7e41', '0d5f', 'a8c3', '62e9', 'd07b', '3b14'];
// The wallet a file names in its header, made up.
const WALLET = '0x8902231e893D97D9834081469D87D79C8fA8Aede';

test('a password wallet with no phrase comes back from its private key, in the same card', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software', hasMnemonic: false }) }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  const forgot = find(screen, 'button.lock-forgot')[0];
  assert.equal(forgot.textContent, 'Forgot your password? Restore from your private key');
  forgot.click();
  const step = find(screen, '.lock-restore')[0];
  assert.ok(textOf(step).includes('Type your private key, 64 characters. This Mac then holds that wallet behind Touch ID, and the password is no longer needed.'));
  const field = find(step, 'textarea')[0];
  assert.equal(field.getAttribute('aria-label'), 'Private key');
  const go = buttonNamed(step, 'Restore');
  field.value = GROUPS.slice(0, 15).join(' ');
  go.click();
  assert.ok(textOf(step).includes('That is 60 characters. A private key is 64.'));
  field.value = GROUPS.join(' ');
  go.click();
  await flush();
  assert.equal(world.calls.some((c) => c.route === '/api/vault/restore'), false, 'one press replaced the wallet');
  assert.ok(textOf(step).some((t) => t.startsWith('This replaces the wallet on this Mac with the one your key opens.')));
  go.click();
  await flush();
  await flush();
  const post = world.calls.find((c) => c.route === '/api/vault/restore');
  assert.ok(post, 'the restore was not posted');
  assert.equal(post.key, '0x' + GROUPS.join(''));
  assert.equal(post.mnemonic, undefined);
});

/* A cancel on the restore's Touch ID is the person's choice: said quietly under the buttons, and
   the confirm goes with it, so the next press asks again rather than going straight to Touch ID. */
test('a cancelled restore on the lock card says so under the buttons, quietly, and the next press asks again', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ custody: 'software', hasMnemonic: false }) }, [LOCK]);
  world.sandbox.PhosphorLock.boot();
  const screen = world.nodes['screen-lock'];
  find(screen, 'button.lock-forgot')[0].click();
  const step = find(screen, '.lock-restore')[0];
  const field = find(step, 'textarea')[0];
  const go = buttonNamed(step, 'Restore');
  field.value = GROUPS.join(' ');
  world.answer.restore = { ok: false, error: 'Touch ID was cancelled. Nothing changed.', code: 'user_cancel' };
  go.click();
  go.click();
  await flush();
  await flush();
  const sure = find(step, '.lock-restore-sure')[0];
  assert.equal(sure.hidden, true, 'the confirm stayed armed after a cancel');
  const note = find(step, '.lock-restore-note')[0];
  assert.equal(note.hidden, false);
  assert.equal(textOf(note).join(' '), 'Touch ID was cancelled. Nothing changed.');
  assert.equal(note.getAttribute('data-tone'), 'quiet');
  assert.equal(find(note, '.lock-error-icon').length, 0, 'a cancel wore the warning glyph');
  const kids = step.childNodes;
  assert.ok(kids.indexOf(note) > kids.indexOf(find(step, '.lock-restore-actions')[0]), 'the cancel line is not under the buttons');
  const posts = world.calls.filter((c) => c.route === '/api/vault/restore').length;
  go.click();
  await flush();
  assert.equal(world.calls.filter((c) => c.route === '/api/vault/restore').length, posts, 'the next single press went straight to Touch ID');
  assert.equal(sure.hidden, false, 'the next press did not ask again');
});

/* ---------- the first run ---------- */

test('with the enclave ready, the first run is the welcome, Create a new wallet, the addresses, the assistant, then Home', async () => {
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

  // Create wallet: nothing typed, the first of three steps, Create the main action and the way
  // back for a wallet that exists quiet beside it.
  assert.equal(find(screen, 'input.input, textarea').length, 0, 'the enclave first run asks for something typed');
  const buttons = find(screen, 'button');
  assert.deepEqual(buttons.map((b: Any) => b.textContent), ['I already have a wallet', 'Create a new wallet']);
  assert.match(buttons[0].className, /btn-quiet/);
  assert.match(buttons[1].className, /btn-primary/);
  assert.ok(textOf(screen).includes('Step 1 of 3'));
  assert.ok(textOf(screen).some((t) => t.startsWith('Locked by this Mac')), 'the enclave create screen does not say where the key is held');

  buttons[1].click();
  assert.equal(buttons[1].getAttribute('data-pending-label'), 'Waiting for Touch ID');
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
  buttonNamed(screen, 'Create a new wallet').click();
  await flush();
  assert.ok(textOf(screen).includes('Touch ID was cancelled. Nothing changed.'));
  // A cancel is the person's own choice: the quiet line, no warning glyph.
  const line = find(screen, '.firstrun-error').find((n: Any) => !n.hidden) as Any;
  assert.equal(line.getAttribute('data-tone'), 'quiet');
  assert.equal(find(line, '.firstrun-error-icon').length, 0);
  assert.ok(buttonNamed(screen, 'Create a new wallet'), 'still on Create');
});

/* A person who moved Macs with Migration Assistant already owns the wallet: no welcome, no invite
   for "your new wallet", straight to what happened and the way in. */
test('a file made on another Mac opens straight on Made on another Mac: no welcome, no invite, one field, 12 or 24 words', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ foreign: true }) }, [FIRSTRUN]);
  world.sandbox.PhosphorFirstRun.boot();
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  assert.ok(!textOf(screen).includes('Welcome to Phosphor'), 'an owner who moved Macs was welcomed as new');
  assert.ok(textOf(screen).includes('Made on another Mac'));
  assert.ok(textOf(screen).includes('Your wallet file came with you, and your money has not moved. This Mac cannot open a file another Mac made, so type your recovery phrase to open the wallet here.'));
  assert.ok(textOf(screen).includes('No copy of your recovery phrase? On the Mac that made this wallet, open Phosphor, then Vault, Recovery phrase, Back it up. Come back here with the copy.'));
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
  world.answer.restore = { ok: true, addresses: { evm: WALLET } };
  fields[0].value = '  ' + words.join('   ').toUpperCase() + '\n';
  buttons[0].click();
  await flush();
  const post = world.calls.find((c) => c.route === '/api/vault/restore');
  assert.ok(post, 'nothing was posted');
  assert.equal(post.mnemonic, words.join(' '));
  assert.ok(textOf(screen).includes('Your wallet is back'), 'the wallet that came back was not named');
  buttonNamed(screen, 'Continue').click();
  assert.ok(textOf(screen).includes('Your addresses'));
  // The invite step is missing from this window, and the flow keeps its last step all the same.
  buttonNamed(screen, 'Continue').click();
  assert.ok(textOf(screen).includes('Your assistant'), 'the step after the addresses was dropped');
});

/* A file with no phrase, carried to a new Mac (Migration Assistant does this), comes back from the
   key its owner backed up. The header says which backup it is, and it reads without the enclave;
   it also names the wallet, so the one that comes back is set beside it. */
test('a file with no phrase made on another Mac asks for its private key, and sets the wallet that came back beside the one the file names', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null, addresses: { evm: WALLET } }, vault: vaultState({ foreign: true, hasMnemonic: false }) }, [FIRSTRUN]);
  world.sandbox.PhosphorFirstRun.boot();
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  assert.ok(textOf(screen).includes('Made on another Mac'));
  assert.ok(textOf(screen).includes('Your wallet file came with you, and your money has not moved. This Mac cannot open a file another Mac made, so type your private key to open the wallet here.'));
  assert.ok(textOf(screen).includes('No copy of your key? On the Mac that made this wallet, open Phosphor, then Vault, Private key, Back it up. Come back here with the copy.'));
  assert.ok(textOf(screen).includes('Private key, 64 characters'));
  const field = find(screen, 'textarea')[0];
  const restore = buttonNamed(screen, 'Restore');
  field.value = 'not a key';
  restore.click();
  await flush();
  assert.ok(textOf(screen).includes('That has a character a private key never uses. A key has only 0 to 9 and a to f.'));
  world.answer.restore = { ok: true, addresses: { evm: WALLET } };
  field.value = `0x ${GROUPS.join(' ').toUpperCase()}`;
  restore.click();
  await flush();
  const post = world.calls.find((c) => c.route === '/api/vault/restore');
  assert.ok(post, 'nothing was posted');
  assert.equal(post.key, '0x' + GROUPS.join(''));
  assert.ok(textOf(screen).includes('Your wallet is back'));
  assert.ok(textOf(screen).includes(`This is the wallet ${WALLET.slice(0, 6)}...${WALLET.slice(-4)}. Check it matches the address on your copy.`));
  assert.ok(textOf(screen).includes('The same wallet your file from the other Mac names.'));
});

test('a key that brings back another wallet than the file names says so, and leads with Try again', async () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null, addresses: { evm: WALLET } }, vault: vaultState({ foreign: true, hasMnemonic: false }) }, [FIRSTRUN]);
  world.sandbox.PhosphorFirstRun.boot();
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  const other = '0x1111111111111111111111111111111111112222';
  world.answer.restore = { ok: true, addresses: { evm: other } };
  find(screen, 'textarea')[0].value = GROUPS.join(' ');
  buttonNamed(screen, 'Restore').click();
  await flush();
  assert.ok(textOf(screen).includes('This is a different wallet'));
  assert.ok(textOf(screen).includes(`The wallet file from your other Mac is ${WALLET.slice(0, 6)}...${WALLET.slice(-4)}. If that one is yours, a character is off in what you typed.`));
  const buttons = find(find(screen, '.screen-actions')[0], 'button');
  assert.deepEqual(buttons.map((b: Any) => b.textContent), ['Keep this wallet', 'Try again']);
  assert.match(buttons[1].className, /btn-primary/);
  // The file here is no longer the other Mac's: a second try is a plain restore, with the line.
  world.put({ vault: vaultState({ foreign: false, hasMnemonic: false, state: 'unlocked' }) });
  buttons[1].click();
  assert.ok(textOf(screen).includes('Restore your wallet'));
  assert.ok(textOf(screen).includes('Then a character is off. Check your copy group by group and try again.'));
});

test('the terms come first on a flow with no welcome', () => {
  const world = build({ lock: { state: 'locked', idleLocksInSec: null }, vault: vaultState({ foreign: true }) }, [FIRSTRUN]);
  world.sandbox.PhosphorTerms = {
    required: () => true,
    firstRunOwns: () => true,
    content: (host: Any) => { const p = world.sandbox.document.createElement('p'); p.textContent = 'The terms.'; host.appendChild(p); return p; },
    accept: () => Promise.resolve({ ok: true }),
  };
  world.sandbox.PhosphorFirstRun.boot();
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  assert.ok(textOf(screen).includes('Before you start'), textOf(screen).join(' | '));
  assert.ok(!textOf(screen).includes('Made on another Mac'), 'the wallet step came before the terms');
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
  assert.ok(textOf(screen).includes('Create or restore a wallet'));
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
  /* The world with the Vault in it: the backup row the notice glides to, and its Back it up. */
  const views = world.sandbox.document.createElement('div');
  const vaultView = world.sandbox.document.createElement('section');
  vaultView.className = 'view';
  const backupRow = world.sandbox.document.createElement('div');
  backupRow.setAttribute('data-reveal', 'backup');
  const backItUp = world.sandbox.document.createElement('button');
  backItUp.setAttribute('data-reveal-focus', '');
  let focusedWith: Any | null = null;
  backItUp.focus = (opts: Any) => { backItUp.focused = true; focusedWith = opts; };
  backupRow.appendChild(backItUp);
  vaultView.appendChild(backupRow);
  views.appendChild(vaultView);
  views.scrollTo = () => {};
  world.nodes.views = views;
  world.nodes['view-vault'] = vaultView;
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
  // A wallet with no phrase is told about the backup it has: its private key.
  world.put({ vault: vaultState({ state: 'unlocked', backedUp: false, hasMnemonic: false }) });
  assert.equal(text.textContent, 'Private key not backed up.');
  assert.equal(act.textContent, 'Back it up');
  world.put({ vault: vaultState({ state: 'unlocked', backedUp: true, hasMnemonic: false }) });
  assert.equal(notice.hidden, true, 'the line stayed after the key was proven');

  // The line is a way in: the Vault, glided to the backup row once it is up, the cursor on Back it
  // up. Scrolled to while the Vault still faded in, the row stayed under the window's foot.
  world.put({ vault: vaultState({ state: 'unlocked', backedUp: false }) });
  act.click();
  await flush();
  assert.equal(world.sandbox.document.body.getAttribute('data-view'), 'vault');
  assert.equal(vaultView.getAttribute('data-active'), 'true');
  assert.equal(backItUp.focused, true, 'the cursor stayed on the notice');
  assert.equal((focusedWith as Any | null)?.preventScroll, true, 'the focus scrolled on its own, against the glide');
  assert.equal(world.calls.some((c) => c.route === 'focusRecovery'), false, 'the row was scrolled to while the Vault faded in');
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
