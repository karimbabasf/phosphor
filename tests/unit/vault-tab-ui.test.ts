// The Vault tab, run for real over a small DOM.
//
// What matters here is the phrase: it is shown once, behind a route that asks
// for a Touch ID, with Print and never Copy; "backed up" clears only when three
// words typed back are accepted by the backend; Done, a lock, or leaving the
// tab wipes it. The rest of the tab (custody words, addresses, forget, the idle
// control, the migration card) is asserted as the text a person reads and the
// route a click posts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const SOURCE = read('../../ui/screens/vault.js');

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
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
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
    focus() {},
    scrollIntoView() {},
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

const WORDS = ('abandon ability able about above absent absorb abstract absurd abuse access accident '
  + 'account accuse achieve acid acoustic acquire across act action actor actress actual').split(' ');
const EVM = '0x7d4e1f0a2c9b8e6d3f5a1c7b9e0d2f4a6c8b0e1d';

function vaultState(overrides: Any = {}): Any {
  return Object.assign({
    custody: 'secure-enclave',
    state: 'unlocked',
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
  vault: Any;
  store: Any;
  view: Any;
  migrate: Any;
  calls: Any[];
  toasts: string[];
  confirms: Any[];
  put: (patch: Any) => void;
  answer: Any;
};

function build(options: { vault?: Any; lock?: Any; policy?: Any; receive?: Any } = {}): World {
  const view = makeNode('section');
  const migrate = makeNode('div');
  migrate.hidden = true;
  const page = makeNode('div');
  const body = makeNode('body');
  const calls: Any[] = [];
  const toasts: string[] = [];
  const confirms: Any[] = [];
  const answer: Any = {
    reveal: { ok: true, words: WORDS.slice(), paths: { evm: "m/44'/60'/0'/0/0", solana: "m/44'/501'/0'/0'", near: "m/44'/397'/0'" } },
    proven: (words: Any[]) => (words.every((w) => WORDS[w.index] === w.word) ? { ok: true, backedUpAt: '2026-09-14T10:00:00.000Z' } : { ok: false, error: 'Those words do not match. Look again.', code: 'wrong_words' }),
    forget: { ok: true },
    restore: { ok: true, addresses: {} },
    migrate: { ok: true },
    prefs: { ok: true },
    confirm: true,
  };

  const doc: Any = {
    body,
    createElement: makeNode,
    getElementById: (id: string) => (id === 'view-vault' ? view : id === 'screen-migrate' ? migrate : id === 'page' ? page : null),
    addEventListener() {},
  };
  const viewListeners: Array<(event: Any) => void> = [];
  const sandbox: Any = {
    console,
    document: doc,
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    addEventListener(type: string, fn: (event: Any) => void) { if (type === 'phosphor:view') viewListeners.push(fn); },
    print() { calls.push({ route: 'print', sheet: body.childNodes.find((n: Any) => n.className === 'print-sheet') ?? null }); },
    Math,
  };
  sandbox.window = sandbox;
  sandbox.PhosphorNet = { readable: (e: Any) => String(e && e.message ? e.message : e) };
  sandbox.PhosphorMotion = { reduced: () => true };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean, label: string) { button.disabled = !!pending; button.pendingLabel = pending ? label : ''; },
    refresh: () => { calls.push({ route: 'refresh' }); return Promise.resolve(); },
    setView: (name: string) => { calls.push({ route: 'setView', view: name }); },
    view: () => 'vault',
  };
  sandbox.PhosphorToast = { show: (message: string) => { toasts.push(message); } };
  sandbox.PhosphorConfirm = { ask: (opts: Any) => { confirms.push(opts); return Promise.resolve(answer.confirm); } };
  sandbox.PhosphorDeposit = {
    open: (opts: Any) => { calls.push(Object.assign({ route: 'deposit.open' }, opts)); return Promise.resolve(null); },
    copyChecked: (address: string, say: (s: string) => void) => { calls.push({ route: 'copy', address }); say('Copied, ends in ...' + address.slice(-4)); return Promise.resolve(true); },
    networkWords: (chain: string) => chain,
    defaultSymbol: (accepts: Any[]) => (accepts && accepts.length ? accepts[0].symbol : ''),
    chunks: (address: string) => [address.slice(0, 4), address.slice(4, -4), address.slice(-4)],
  };
  sandbox.PhosphorApi = {
    receive: () => Promise.resolve({ data: options.receive ?? { chains: [{ id: 'eth', name: 'Ethereum', address: EVM }, { id: 'base', name: 'Base', address: EVM }, { id: 'sol', name: 'Solana', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' }, { id: 'near', name: 'NEAR', address: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' }], state: 'unlocked', verified: true, tampered: false } }),
    intentsReceive: () => Promise.resolve({ data: { networks: [{ id: 'eth', address: EVM, accepts: [{ symbol: 'USDC' }] }, { id: 'sol', address: 'SOLADDR', accepts: [{ symbol: 'SOL' }] }] } }),
    vaultReveal: () => { calls.push({ route: '/api/vault/reveal' }); return Promise.resolve(answer.reveal); },
    vaultBackupProven: (words: Any[]) => { calls.push({ route: '/api/vault/backup-proven', words }); return Promise.resolve(answer.proven(words)); },
    vaultForget: () => { calls.push({ route: '/api/vault/forget' }); return Promise.resolve(answer.forget); },
    vaultRestore: (mnemonic: string) => { calls.push({ route: '/api/vault/restore', mnemonic }); return Promise.resolve(answer.restore); },
    vaultMigrate: (password: string) => { calls.push({ route: '/api/vault/migrate', password }); return Promise.resolve(answer.migrate); },
    vaultPrefs: (prefs: Any) => { calls.push(Object.assign({ route: '/api/vault/prefs' }, prefs)); return Promise.resolve(answer.prefs); },
  };

  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/vault.js' });

  const store = sandbox.PhosphorState;
  const state: Any = {
    lock: options.lock ?? { state: 'unlocked', idleLocksInSec: null },
    vault: vaultState(options.vault ?? {}),
    policy: options.policy ?? { outbound: { humanClickAboveUsd: 100 } },
  };
  store.put(state);
  sandbox.PhosphorVault.boot();
  for (const fn of viewListeners) fn({ detail: { view: 'vault' } });

  return {
    sandbox,
    vault: sandbox.PhosphorVault,
    store,
    view,
    migrate,
    calls,
    toasts,
    confirms,
    answer,
    put: (patch: Any) => store.put(Object.assign({}, store.get(), patch)),
  };
}

const recovery = (world: World): Any => find(world.view, '.panel').find((p: Any) => p.dataset.surface === 'recovery') as Any;
const flow = (world: World): Any => find(world.view, '.vault-flow')[0];
const badge = (world: World): string => find(recovery(world), '.chip')[0].textContent;

/* ---------- the source ---------- */

test('no string reaches the DOM as markup, and no Copy is offered on the phrase', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'vault.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
  // The phrase is printed or written down. A clipboard is a place other
  // processes read, so the reveal never writes one: the tab's only copy is the
  // address rows', and that goes through the deposit card's read-back.
  assert.equal(/navigator\.clipboard|writeText/.test(SOURCE), false, 'vault.js writes the clipboard itself');
});

/* ---------- reveal and prove ---------- */

test('Reveal posts /api/vault/reveal, shows the 24 words once, with Print and without Copy', async () => {
  const world = build();
  assert.equal(badge(world), 'Not backed up');
  buttonNamed(recovery(world), 'Reveal recovery phrase').click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/vault/reveal'));
  const panel = flow(world);
  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.step, 'words');
  const words = find(panel, '.word').map((w: Any) => w.childNodes[1].textContent);
  assert.deepEqual(words, WORDS, 'the 24 words are not on screen in order');
  const labels = find(panel, 'button').map((b: Any) => b.textContent);
  assert.ok(labels.includes('Print'), 'no Print');
  assert.equal(labels.some((l: string) => /copy/i.test(l)), false, 'a Copy button on the phrase');
  assert.ok(textOf(panel).some((t) => t.includes("m/44'/501'/0'/0'")), 'the derivation paths are not stated');
});

test('Print prints a sheet that holds only the numbered words, and takes it away after', async () => {
  const world = build();
  buttonNamed(recovery(world), 'Reveal recovery phrase').click();
  await flush();
  buttonNamed(flow(world), 'Print').click();
  const printed = world.calls.find((c) => c.route === 'print');
  assert.ok(printed && printed.sheet, 'print ran without a sheet in the document');
  assert.deepEqual(find(printed.sheet, 'li').map((li: Any) => li.textContent), WORDS);
  assert.equal(world.sandbox.document.body.childNodes.includes(printed.sheet), false, 'the sheet stayed in the document after printing');
});

test('the Prove step posts three positions, and only a right answer clears the badge', async () => {
  const world = build();
  buttonNamed(recovery(world), 'Reveal recovery phrase').click();
  await flush();
  buttonNamed(flow(world), 'I wrote them down').click();
  const panel = flow(world);
  assert.equal(panel.dataset.step, 'prove');
  const inputs = find(panel, 'input');
  assert.equal(inputs.length, 3, 'the prove step does not ask for three words');
  const positions = inputs.map((i: Any) => Number(i.dataset.index));
  assert.equal(new Set(positions).size, 3, 'a position was asked twice');
  assert.ok(positions.every((p: number) => p >= 0 && p < 24));
  assert.ok(textOf(panel).some((t) => t === 'Word ' + (positions[0] + 1)), 'the field is not labelled by its number');

  // Wrong words: the backend refuses, the badge stays, nothing is cleared.
  for (const input of inputs) input.value = 'wrong';
  buttonNamed(panel, 'Prove it').click();
  await flush();
  const first = world.calls.find((c) => c.route === '/api/vault/backup-proven');
  assert.ok(first, 'nothing was posted');
  assert.equal(first.words.length, 3);
  // Array.from: the posted list was made inside the vm and carries that realm's
  // prototype, which a strict deep-equal would refuse.
  assert.deepEqual(Array.from(first.words, (w: Any) => w.index), positions);
  assert.ok(first.words.every((w: Any) => w.word === 'wrong'));
  assert.equal(world.calls.some((c) => c.route === 'refresh'), false, 'a wrong answer refreshed as if it had cleared');
  assert.ok(textOf(panel).some((t) => t.includes('do not match')), 'the refusal is not on screen');
  assert.equal(badge(world), 'Not backed up');

  // Right words: accepted, the phrase is wiped, and the badge follows the state.
  inputs.forEach((input: Any, i: number) => { input.value = WORDS[positions[i]]; });
  buttonNamed(panel, 'Prove it').click();
  await flush();
  const posts = world.calls.filter((c) => c.route === '/api/vault/backup-proven');
  assert.equal(posts.length, 2);
  assert.ok(world.calls.some((c) => c.route === 'refresh'), 'a right answer did not refresh the state');
  assert.equal(flow(world).hidden, true, 'the phrase is still on screen after it was proven');
  assert.equal(find(flow(world), '.word').length, 0, 'the words survived the wipe');
  world.put({ vault: vaultState({ backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' }) });
  assert.equal(badge(world), 'Backed up');
  assert.ok(textOf(recovery(world)).some((t) => t.startsWith('Backed up: yes')));
});

test('Done, a lock, or leaving the tab wipes the words', async () => {
  const world = build();
  buttonNamed(recovery(world), 'Reveal recovery phrase').click();
  await flush();
  assert.equal(find(flow(world), '.word').length, 24);
  buttonNamed(flow(world), 'Done').click();
  assert.equal(find(flow(world), '.word').length, 0);
  assert.equal(flow(world).hidden, true);

  buttonNamed(recovery(world), 'Reveal recovery phrase').click();
  await flush();
  assert.equal(find(flow(world), '.word').length, 24);
  world.put({ lock: { state: 'locked', idleLocksInSec: null } });
  assert.equal(find(flow(world), '.word').length, 0, 'the words stayed on a locked window');
});

test('a cancelled Touch ID on Reveal shows nothing and says nothing', async () => {
  const world = build();
  world.answer.reveal = { ok: false, error: 'cancelled', code: 'user_cancel' };
  buttonNamed(recovery(world), 'Reveal recovery phrase').click();
  await flush();
  assert.equal(flow(world).hidden, true);
  assert.equal(world.toasts.length, 0);
});

/* ---------- restore ---------- */

test('Restore takes 12 or 24 words, confirms, and posts /api/vault/restore', async () => {
  const world = build();
  buttonNamed(recovery(world), 'Restore from a phrase').click();
  const panel = flow(world);
  assert.equal(panel.dataset.step, 'restore');
  const input = find(panel, 'textarea')[0];
  input.value = WORDS.slice(0, 13).join(' ');
  buttonNamed(panel, 'Restore').click();
  await flush();
  assert.equal(world.calls.some((c) => c.route === '/api/vault/restore'), false, '13 words were posted');
  assert.ok(textOf(panel).some((t) => t.includes('13 words')));
  input.value = WORDS.slice(0, 12).join(' ').toUpperCase();
  buttonNamed(panel, 'Restore').click();
  await flush();
  await flush();
  assert.equal(world.confirms.length, 1, 'restore ran without a confirm');
  const post = world.calls.find((c) => c.route === '/api/vault/restore');
  assert.ok(post);
  assert.equal(post.mnemonic, WORDS.slice(0, 12).join(' '), 'the phrase was not lowercased and joined by single spaces');
});

test('a restore the backend refuses says why, in the tab', async () => {
  const world = build();
  world.answer.restore = { ok: false, error: 'not backed up', code: 'not_backed_up' };
  buttonNamed(recovery(world), 'Restore from a phrase').click();
  const panel = flow(world);
  find(panel, 'textarea')[0].value = WORDS.join(' ');
  buttonNamed(panel, 'Restore').click();
  await flush();
  await flush();
  assert.ok(textOf(panel).some((t) => t.includes('not proven backed up')));
});

/* ---------- custody ---------- */

test('the Custody panel says which binding is live, and the software case offers the move', () => {
  const enclave = build();
  const custody = find(enclave.view, '.panel').find((p: Any) => p.dataset.surface === 'custody') as Any;
  const text = textOf(custody);
  assert.ok(text.includes('Secure Enclave on this Mac'));
  assert.ok(text.some((t) => t.startsWith('Key made ')));
  assert.ok(text.includes('Opens with Touch ID, or your Mac login password.'));
  assert.ok(text.includes('Any process on this Mac can ask; a Developer ID build binds the key to Phosphor.'));
  assert.equal(buttonNamed(custody, 'Move behind the Secure Enclave').hidden, true);

  enclave.put({ vault: vaultState({ enclave: { attached: true, ready: true, capability: null, keyMadeAt: null, binding: 'app' } }) });
  assert.equal(textOf(custody).includes('Any process on this Mac can ask; a Developer ID build binds the key to Phosphor.'), false, 'the device line is shown for an app-bound key');

  const software = build({ vault: { custody: 'software' } });
  const soft = find(software.view, '.panel').find((p: Any) => p.dataset.surface === 'custody') as Any;
  assert.ok(textOf(soft).some((t) => t.startsWith('Software')));
  assert.equal(buttonNamed(soft, 'Move behind the Secure Enclave').hidden, false);

  const noEnclave = build({ vault: { custody: 'software', enclave: { attached: true, ready: false, capability: { secureEnclave: false, biometry: 'none', canAuthenticate: false }, keyMadeAt: null, binding: null } } });
  const none = find(noEnclave.view, '.panel').find((p: Any) => p.dataset.surface === 'custody') as Any;
  assert.ok(textOf(none).includes('This Mac has no Secure Enclave.'));
  assert.equal(buttonNamed(none, 'Move behind the Secure Enclave').hidden, true);
});

/* ---------- addresses ---------- */

test('three address rows, each with its badge, Copy through the read-back, and Show QR to the card', async () => {
  const world = build();
  await flush();
  const rows = find(world.view, '.vault-row');
  assert.deepEqual(rows.map((r: Any) => r.dataset.chain), ['eth', 'sol', 'near']);
  assert.ok(rows.every((r: Any) => find(r, '.chip')[0].textContent === 'Verified'));
  assert.equal(find(rows[0], '.sr-only')[0].textContent, EVM);

  buttonNamed(rows[0], 'Copy').click();
  await flush();
  assert.deepEqual(world.calls.find((c) => c.route === 'copy'), { route: 'copy', address: EVM });
  assert.ok(textOf(rows[0]).includes('Copied, ends in ...0e1d'));

  buttonNamed(rows[1], 'Show QR').click();
  await flush();
  await flush();
  const opened = world.calls.find((c) => c.route === 'deposit.open');
  assert.deepEqual(opened, { route: 'deposit.open', chain: 'sol', symbol: 'SOL', address: 'SOLADDR' });

  const locked = build({ receive: { chains: [{ id: 'eth', name: 'Ethereum', address: EVM }], state: 'locked', verified: false, tampered: false } });
  await flush();
  const row = find(locked.view, '.vault-row')[0];
  assert.equal(find(row, '.chip')[0].textContent, 'Unverified');
});

/* ---------- agent, window, danger ---------- */

test('the Agent panel states the click threshold from the policy', () => {
  const world = build({ policy: { outbound: { humanClickAboveUsd: 250 } } });
  const agent = find(world.view, '.panel').find((p: Any) => p.dataset.surface === 'agent') as Any;
  assert.ok(textOf(agent).some((t) => t.startsWith('Moves under $250 run without a click while the vault is open.')));
  assert.ok(textOf(agent).includes('It cannot see'));
});

test('the idle control marks the current choice and posts the new one', async () => {
  const world = build();
  const chips = find(find(world.view, '.panel').find((p: Any) => p.dataset.surface === 'window') as Any, 'button.chip');
  assert.deepEqual(chips.map((c: Any) => c.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  chips[2].click();
  await flush();
  assert.deepEqual(world.calls.find((c) => c.route === '/api/vault/prefs'), { route: '/api/vault/prefs', idleMinutes: 60 });
});

test('Forget is dead until FORGET is typed, confirms, posts, and shows a not-backed-up refusal', async () => {
  const world = build();
  const danger = find(world.view, '.panel').find((p: Any) => p.dataset.surface === 'danger') as Any;
  const input = find(danger, 'input')[0];
  const forget = buttonNamed(danger, 'Forget this wallet');
  assert.equal(forget.disabled, true);
  input.value = 'forget';
  input.dispatch('input');
  assert.equal(forget.disabled, true, 'lowercase forget armed the button');
  input.value = 'FORGET';
  input.dispatch('input');
  assert.equal(forget.disabled, false);

  world.answer.forget = { ok: false, error: 'not backed up', code: 'not_backed_up' };
  forget.click();
  await flush();
  await flush();
  assert.equal(world.confirms.length, 1);
  assert.ok(world.calls.some((c) => c.route === '/api/vault/forget'));
  assert.ok(textOf(danger).some((t) => t.startsWith('Refused: the phrase is not proven backed up')));

  world.answer.forget = { ok: true };
  forget.click();
  await flush();
  await flush();
  assert.ok(world.calls.filter((c) => c.route === 'refresh').length >= 1);
  assert.ok(world.toasts.some((t) => t.includes('forgotten')));
});

/* ---------- the migration card ---------- */

test('a password wallet on a ready enclave gets the migration card once at boot, dismissable', async () => {
  const world = build({ vault: { custody: 'software' } });
  assert.equal(world.migrate.hidden, false, 'no migration card at boot');
  const text = textOf(world.migrate);
  assert.ok(text.includes('Move your keys behind the Secure Enclave'));
  assert.equal(find(world.migrate, 'input[type="password"]').length, 1);
  buttonNamed(world.migrate, 'Not now').click();
  assert.equal(world.migrate.hidden, true);
  world.put({ vault: vaultState({ custody: 'software' }) });
  assert.equal(world.migrate.hidden, true, 'the card came back after it was dismissed');

  // The Custody panel keeps the button, and the form posts the password once.
  const custody = find(world.view, '.panel').find((p: Any) => p.dataset.surface === 'custody') as Any;
  buttonNamed(custody, 'Move behind the Secure Enclave').click();
  assert.equal(world.migrate.hidden, false);
  find(world.migrate, 'input[type="password"]')[0].value = 'hunter22';
  find(world.migrate, 'form')[0].dispatch('submit');
  await flush();
  await flush();
  assert.deepEqual(world.calls.find((c) => c.route === '/api/vault/migrate'), { route: '/api/vault/migrate', password: 'hunter22' });
  assert.equal(world.migrate.hidden, true);
});

test('no migration card for an enclave wallet, a locked window, or a Mac with no enclave', () => {
  assert.equal(build().migrate.hidden, true);
  assert.equal(build({ vault: { custody: 'software' }, lock: { state: 'locked' } }).migrate.hidden, true);
  assert.equal(build({ vault: { custody: 'software', enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } } }).migrate.hidden, true);
});
