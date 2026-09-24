// The Vault, run for real over a small DOM.
//
// What matters most here is the phrase: it is shown once, behind a route that asks
// for a Touch ID, with Print and never Copy; "backed up" clears only when three
// words typed back are accepted by the backend; Done, a lock, or leaving the tab
// wipes it. Then the safety rows the bar no longer carries: Freeze confirms in
// place and its confirm is the only red on the page, the lock timer marks its
// choice and posts the new one, the backup row says the truth and leads to the
// reveal, and the limits are the server's own sentences. The rest (keys,
// addresses, forget, the migration card) is asserted as the text a person reads
// and the route a click posts. The assistant list has its own file
// (tests/unit/vault-agent-ui.test.ts).

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

function build(options: { vault?: Any; lock?: Any; policy?: Any; receive?: Any; sentences?: string[]; dailyLimit?: Any } = {}): World {
  const view = makeNode('section');
  const migrate = makeNode('div');
  migrate.hidden = true;
  const page = makeNode('div');
  const body = makeNode('body');
  const calls: Any[] = [];
  const toasts: string[] = [];
  const confirms: Any[] = [];
  const answer: Any = {
    reveal: { ok: true, words: WORDS.slice(), paths: { evm: "m/44'/60'/0'/0/0" } },
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
  sandbox.PhosphorNetPick = {
    NETWORKS: [
      { id: 'eth', name: 'Ethereum', mark: 'ETH', colour: '#627EEA' },
      { id: 'base', name: 'Base', mark: 'BASE', colour: '#0052FF' },
      { id: 'arb', name: 'Arbitrum', mark: 'ARB', colour: '#12AAFF' },
      { id: 'sol', name: 'Solana', mark: 'SOL', colour: '#9945FF' },
      { id: 'near', name: 'NEAR', mark: 'NEAR', colour: '#00EC97' },
    ],
    render: (host: Any, opts: Any) => { calls.push(Object.assign({ route: 'netpick.render', host }, opts)); return { destroy() {} }; },
  };
  sandbox.PhosphorDeposit = {
    open: (opts: Any) => { calls.push(Object.assign({ route: 'deposit.open' }, opts)); return Promise.resolve(null); },
    copyChecked: (address: string, say: (s: string) => void) => { calls.push({ route: 'copy', address }); say('Address copied, ends in ...' + address.slice(-4)); return Promise.resolve(true); },
    networkWords: (chain: string) => chain,
    defaultSymbol: (accepts: Any[]) => (accepts && accepts.length ? accepts[0].symbol : ''),
    chunks: (address: string) => [address.slice(0, 4), address.slice(4, -4), address.slice(-4)],
  };
  sandbox.PhosphorApi = {
    receive: () => Promise.resolve({ data: options.receive ?? { chains: [{ id: 'eth', name: 'Ethereum', address: EVM }, { id: 'base', name: 'Base', address: EVM }, { id: 'arb', name: 'Arbitrum', address: EVM }], state: 'unlocked', verified: true, tampered: false } }),
    intentsReceive: () => Promise.resolve({ data: { networks: [{ id: 'eth', address: EVM, accepts: [{ symbol: 'USDC' }] }, { id: 'sol', address: 'SOLADDR', accepts: [{ symbol: 'SOL' }] }] } }),
    vaultReveal: () => { calls.push({ route: '/api/vault/reveal' }); return Promise.resolve(answer.reveal); },
    vaultBackupProven: (words: Any[]) => { calls.push({ route: '/api/vault/backup-proven', words }); return Promise.resolve(answer.proven(words)); },
    vaultForget: () => { calls.push({ route: '/api/vault/forget' }); return Promise.resolve(answer.forget); },
    vaultRestore: (mnemonic: string) => { calls.push({ route: '/api/vault/restore', mnemonic }); return Promise.resolve(answer.restore); },
    vaultMigrate: (password: string) => { calls.push({ route: '/api/vault/migrate', password }); return Promise.resolve(answer.migrate); },
    vaultPrefs: (prefs: Any) => { calls.push(Object.assign({ route: '/api/vault/prefs' }, prefs)); return Promise.resolve(answer.prefs); },
    kill: (on: boolean) => { calls.push({ route: '/api/kill', on }); return answer.kill ? Promise.reject(new Error(answer.kill)) : Promise.resolve({ ok: true }); },
    lock: () => { calls.push({ route: '/api/lock' }); return Promise.resolve({ ok: true }); },
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
    sentences: options.sentences ?? [],
    dailyLimit: options.dailyLimit ?? null,
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

const row = (world: World, surface: string): Any => find(world.view, '.vault-row').find((p: Any) => p.dataset.surface === surface) as Any;
const recovery = (world: World): Any => row(world, 'recovery');
const flow = (world: World): Any => find(world.view, '.vault-flow')[0];
const backup = (world: World): string => find(row(world, 'backup'), '.vault-text')[0].textContent;

/* ---------- the source ---------- */

test('no string reaches the DOM as markup, and no Copy is offered on the phrase', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'vault.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
  // The phrase is printed or written down. A clipboard is a place other
  // processes read, so the reveal never writes one: the tab's only copy is the
  // address rows', and that goes through the deposit card's read-back.
  assert.equal(/navigator\.clipboard|writeText/.test(SOURCE), false, 'vault.js writes the clipboard itself');
});

/* ---------- the page ---------- */

test('three sections in reading order, the assistant and safety first, and rows ruled rather than boxed', () => {
  const world = build();
  assert.deepEqual(find(world.view, '.vault-sec').map((s: Any) => s.dataset.surface), ['agent', 'safety', 'wallet']);
  assert.deepEqual(find(world.view, '.vault-title').map((t: Any) => t.textContent), ['Your assistant', 'Safety', 'Your wallet']);
  assert.deepEqual(find(world.view, '.vault-row').map((r: Any) => r.dataset.surface),
    ['freeze', 'window', 'backup', 'rules', 'custody', 'recovery', 'addresses', 'danger']);
  assert.equal(find(world.view, '.panel').length, 0, 'a card is back on the Vault');
  assert.equal(find(world.view, '.chip').length, 0, 'a status chip is back on the Vault');
  assert.equal(find(world.view, '.dot').length, 0, 'a dot is back on the Vault');
});

test('no red but the freeze, and no green anywhere on the Vault', () => {
  // btn-danger is set in the freeze's own code and nowhere else; btn-primary is Approve's.
  const danger = SOURCE.split('btn-danger').length - 1;
  assert.equal(danger, 2, 'btn-danger outside the freeze confirm');
  assert.ok(/refs\.freezeGo = button\(FREEZE\.off\.go, 'btn-danger btn-sm'/.test(SOURCE));
  assert.doesNotMatch(SOURCE, /btn-primary/, 'a green button on the Vault');
  assert.doesNotMatch(SOURCE, /PhosphorToast\.show\([^)]*'down'\)/, 'a red toast from the Vault');
  const css = read('../../ui/design/vault.css');
  assert.doesNotMatch(css, /--down|--ink-wash|--up\b/, 'vault.css paints a state colour');
});

/* ---------- safety: freeze ---------- */

test('Freeze asks in place, with Cancel first, and its Freeze is the one red button; Escape puts it away', async () => {
  const world = build();
  const freeze = row(world, 'freeze');
  assert.ok(textOf(freeze).some((t) => t.startsWith('Stops every move at once.')));
  // The row's own action, not the confirm's button of the same name inside the step.
  const open = buttonNamed(find(freeze, '.vault-row-act')[0], 'Freeze everything');
  const step = find(freeze, '.vault-confirm')[0];
  assert.equal(step.hidden, true, 'the confirm is up before anyone asked');
  open.click();
  assert.equal(step.hidden, false);
  assert.equal(open.hidden, true, 'two Freeze everything buttons at once');
  assert.ok(textOf(step).some((t) => t.startsWith('This cancels every working order')));
  const buttons = find(step, 'button');
  assert.deepEqual(buttons.map((b: Any) => b.textContent), ['Cancel', 'Freeze everything']);
  assert.ok(buttons[1].className.includes('btn-danger'), 'the freeze itself is not the red one');
  assert.ok(!buttons[0].className.includes('btn-danger'));
  assert.equal(world.calls.some((c) => c.route === '/api/kill'), false, 'opening the step froze something');
  step.dispatch('keydown', { key: 'Escape' });
  assert.equal(step.hidden, true);
  assert.equal(open.hidden, false);

  open.click();
  buttons[1].click();
  await flush();
  await flush();
  assert.deepEqual(world.calls.find((c) => c.route === '/api/kill'), { route: '/api/kill', on: true });
  assert.ok(world.calls.some((c) => c.route === 'refresh'));
  assert.equal(step.hidden, true, 'the step stayed open after the freeze landed');
});

test('frozen, the row says so and its way back is plain, never red', () => {
  const world = build({ policy: { killSwitch: true, outbound: {} } });
  const freeze = row(world, 'freeze');
  assert.ok(textOf(freeze).includes('Everything is frozen. The assistant cannot move any money until you unfreeze.'));
  buttonNamed(find(freeze, '.vault-row-act')[0], 'Unfreeze').click();
  const step = find(freeze, '.vault-confirm')[0];
  const go = find(step, 'button').find((b: Any) => b.textContent === 'Unfreeze') as Any;
  assert.ok(go, 'no Unfreeze in the step');
  assert.ok(!go.className.includes('btn-danger'), 'the way back is red');
  assert.ok(find(step, 'button').some((b: Any) => b.textContent === 'Keep frozen'));
});

test('a freeze the app refuses says why in the step, in words', async () => {
  const world = build();
  world.answer.kill = 'The app could not reach its rules.';
  const freeze = row(world, 'freeze');
  buttonNamed(find(freeze, '.vault-row-act')[0], 'Freeze everything').click();
  find(find(freeze, '.vault-confirm')[0], 'button')[1].click();
  await flush();
  await flush();
  const error = find(freeze, '.vault-error')[0];
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'The app could not reach its rules.');
});

/* ---------- safety: the lock timer ---------- */

test('the lock timer marks the current choice, posts a new one, and Lock now locks', async () => {
  const world = build();
  const lock = row(world, 'window');
  const cells = find(lock, 'button.vault-seg-cell');
  assert.deepEqual(cells.map((c: Any) => c.textContent), ['5 min', '15 min', '1 hour']);
  assert.deepEqual(cells.map((c: Any) => c.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.equal(cells[0].getAttribute('role'), 'radio');
  cells[2].click();
  await flush();
  assert.deepEqual(world.calls.find((c) => c.route === '/api/vault/prefs'), { route: '/api/vault/prefs', idleMinutes: 60 });
  buttonNamed(lock, 'Lock now').click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/lock'));
  // A locked window has nothing to lock.
  world.put({ lock: { state: 'locked', idleLocksInSec: null } });
  assert.equal(buttonNamed(lock, 'Lock now').hidden, true);
});

/* ---------- safety: the backup ---------- */

test('the backup row says the truth and leads to the reveal; proven, it says when and offers nothing', async () => {
  const world = build();
  assert.ok(backup(world).startsWith('Not backed up yet.'), backup(world));
  const go = buttonNamed(row(world, 'backup'), 'Back it up');
  assert.equal(go.hidden, false);
  go.click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/vault/reveal'), 'Back it up did not start the reveal');
  assert.equal(flow(world).dataset.step, 'words');

  world.put({ vault: vaultState({ backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' }) });
  assert.equal(backup(world), 'Backed up. You proved your copy of the phrase on Sep 14, 2026.');
  assert.equal(buttonNamed(row(world, 'backup'), 'Back it up').hidden, true);

  const none = build({ vault: { custody: null } });
  assert.equal(backup(none), 'There is nothing to back up until a wallet exists.');
});

/* ---------- safety: limits ---------- */

test('the limits are the server\'s own figures, in the order a person needs them, with the day\'s use', () => {
  const world = build({
    policy: { approval: { thresholdUsd: 100 }, outbound: { humanClickAboveUsd: 100, destinationAllowlist: ['oneclick:1click.chaindefuser.com', 'intents.near', 'hyperliquid-perps', '0xabc'] } },
    sentences: [
      'Ask me before anything above $100.',
      'Refuse any single transaction above $10,000.',
      'Refuse more than $25,000 in any 24 hours.',
      'Keep $5 of gas on Ethereum.',
      'Allowed destinations: 4.',
    ],
    dailyLimit: { capUsd: 25000, spentUsd: 120.07, resetsAt: null },
  });
  const rules = find(row(world, 'rules'), '.vault-rule').map((r: Any) => r.textContent);
  assert.deepEqual(rules, [
    'Asks you before anything above $100.',
    'Refuses any single move above $10,000.',
    'Refuses more than $25,000 in any 24 hours. $120.07 of it used in the last 24 hours.',
    'Keep $5 of gas on Ethereum.',
    'Pays only 1 wallet of yours, 1Click, NEAR Intents and Hyperliquid.',
  ]);
  assert.ok(textOf(row(world, 'rules')).includes('Ask your assistant to change a limit. Every change waits for your click.'));
});

test('a limit that is not set is not drawn, nothing spent is said in words, and no policy is one sentence', () => {
  const quiet = build({
    policy: { outbound: {} },
    sentences: ['Refuse more than $500 in any 24 hours.', 'Kill switch on: every proposal is refused.'],
    dailyLimit: { capUsd: 500, spentUsd: 0, resetsAt: null },
  });
  assert.deepEqual(find(row(quiet, 'rules'), '.vault-rule').map((r: Any) => r.textContent), [
    'Refuses more than $500 in any 24 hours. Nothing of it used in the last 24 hours.',
  ], 'the kill switch is the Freeze row\'s, not a limit');

  const none = build({ policy: { outbound: {} }, sentences: [] });
  assert.deepEqual(find(row(none, 'rules'), '.vault-rule').map((r: Any) => r.textContent), [
    'No limits are set, so everything your assistant asks for waits for your click.',
  ]);
});

/* ---------- reveal and prove ---------- */

test('Reveal posts /api/vault/reveal, shows the 24 words once, with Print and without Copy', async () => {
  const world = build();
  buttonNamed(recovery(world), 'Reveal').click();
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
  assert.ok(textOf(panel).some((t) => t.includes("m/44'/60'/0'/0/0")), 'the derivation path is not stated');
  assert.equal(textOf(panel).some((t) => t.includes("m/44'/501'")), false, 'a Solana path the wallet no longer signs with');
  // The warning is a line with the lock, not a red banner.
  assert.equal(find(panel, '.banner').length, 0);
  assert.ok(textOf(panel).some((t) => t.startsWith('On this screen only.')));
});

test('Print prints a sheet that holds only the numbered words, and takes it away after', async () => {
  const world = build();
  buttonNamed(recovery(world), 'Reveal').click();
  await flush();
  buttonNamed(flow(world), 'Print').click();
  const printed = world.calls.find((c) => c.route === 'print');
  assert.ok(printed && printed.sheet, 'print ran without a sheet in the document');
  assert.deepEqual(find(printed.sheet, 'li').map((li: Any) => li.textContent), WORDS);
  assert.equal(world.sandbox.document.body.childNodes.includes(printed.sheet), false, 'the sheet stayed in the document after printing');
});

test('the Prove step posts three positions, and only a right answer clears "not backed up"', async () => {
  const world = build();
  buttonNamed(recovery(world), 'Reveal').click();
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

  // Wrong words: the backend refuses, the row stays, nothing is cleared.
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
  assert.ok(backup(world).startsWith('Not backed up yet.'));

  // Right words: accepted, the phrase is wiped, and the row follows the state.
  inputs.forEach((input: Any, i: number) => { input.value = WORDS[positions[i]]; });
  buttonNamed(panel, 'Prove it').click();
  await flush();
  const posts = world.calls.filter((c) => c.route === '/api/vault/backup-proven');
  assert.equal(posts.length, 2);
  assert.ok(world.calls.some((c) => c.route === 'refresh'), 'a right answer did not refresh the state');
  assert.equal(flow(world).hidden, true, 'the phrase is still on screen after it was proven');
  assert.equal(find(flow(world), '.word').length, 0, 'the words survived the wipe');
  world.put({ vault: vaultState({ backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' }) });
  assert.ok(backup(world).startsWith('Backed up.'));
});

test('Done, a lock, or leaving the tab wipes the words', async () => {
  const world = build();
  buttonNamed(recovery(world), 'Reveal').click();
  await flush();
  assert.equal(find(flow(world), '.word').length, 24);
  buttonNamed(flow(world), 'Done').click();
  assert.equal(find(flow(world), '.word').length, 0);
  assert.equal(flow(world).hidden, true);

  buttonNamed(recovery(world), 'Reveal').click();
  await flush();
  assert.equal(find(flow(world), '.word').length, 24);
  world.put({ lock: { state: 'locked', idleLocksInSec: null } });
  assert.equal(find(flow(world), '.word').length, 0, 'the words stayed on a locked window');
});

test('a cancelled Touch ID on Reveal shows nothing and says nothing', async () => {
  const world = build();
  world.answer.reveal = { ok: false, error: 'cancelled', code: 'user_cancel' };
  buttonNamed(recovery(world), 'Reveal').click();
  await flush();
  assert.equal(flow(world).hidden, true);
  assert.equal(world.toasts.length, 0);
});

/* ---------- restore ---------- */

test('Restore takes 12 or 24 words, asks once more in place, and posts /api/vault/restore', async () => {
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
  assert.equal(world.calls.some((c) => c.route === '/api/vault/restore'), false, 'one press replaced the wallet');
  assert.ok(textOf(panel).some((t) => t.startsWith('This Mac will hold the wallet the phrase makes')));
  assert.equal(world.confirms.length, 0, 'a dialog over the window');
  buttonNamed(panel, 'Restore').click();
  await flush();
  await flush();
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
  buttonNamed(panel, 'Restore').click();
  await flush();
  await flush();
  assert.ok(textOf(panel).some((t) => t.includes('not proven backed up')));
});

/* ---------- keys ---------- */

test('the Keys row says which binding is live, and the software case offers the move', () => {
  const enclave = build();
  const custody = row(enclave, 'custody');
  const text = textOf(custody);
  assert.ok(text.includes('Behind the Secure Enclave on this Mac. Touch ID or your Mac login password opens it. Made on Sep 14, 2026.'), JSON.stringify(text));
  assert.ok(text.includes('Any process on this Mac can ask for it; a Developer ID build binds the key to Phosphor.'));
  assert.equal(buttonNamed(custody, 'Move behind the Secure Enclave').hidden, true);

  enclave.put({ vault: vaultState({ enclave: { attached: true, ready: true, capability: null, keyMadeAt: null, binding: 'app' } }) });
  assert.equal(find(custody, '.vault-sub')[0].hidden, true, 'the device line is shown for an app-bound key');

  const software = build({ vault: { custody: 'software' } });
  const soft = row(software, 'custody');
  assert.ok(textOf(soft).some((t) => t.startsWith('Locked with your password, on this disk.')));
  assert.equal(buttonNamed(soft, 'Move behind the Secure Enclave').hidden, false);

  const noEnclave = build({ vault: { custody: 'software', enclave: { attached: true, ready: false, capability: { secureEnclave: false, biometry: 'none', canAuthenticate: false }, keyMadeAt: null, binding: null } } });
  const none = row(noEnclave, 'custody');
  assert.ok(textOf(none).includes('This Mac has no Secure Enclave.'));
  assert.equal(buttonNamed(none, 'Move behind the Secure Enclave').hidden, true);
});

/* ---------- addresses ---------- */

test('the Addresses row is a network menu over the token list, and Show the address opens the deposit card', async () => {
  const world = build();
  await flush();
  const card = row(world, 'addresses');
  assert.ok(card, 'no Addresses row');

  const button = find(card, '.netsel')[0];
  assert.equal(button.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(find(button, '.netsel-name')[0].textContent, 'Ethereum');
  const options = find(card, '.netsel-option');
  assert.deepEqual(options.map((o: Any) => o.dataset.network), ['eth', 'base', 'arb', 'sol', 'near']);
  assert.deepEqual(options.map((o: Any) => o.getAttribute('aria-selected')), ['true', 'false', 'false', 'false', 'false']);

  // The token list is the component, at its token step, for the network in the menu, fed the report read here.
  const first = world.calls.find((c) => c.route === 'netpick.render');
  assert.ok(first, 'the token list was not rendered');
  assert.equal(first.context, 'vault');
  assert.equal(first.stage, 'tokens');
  assert.equal(first.network, 'eth');
  assert.equal(first.host, find(card, '.vault-tokens')[0]);
  assert.deepEqual(first.report.networks.map((n: Any) => n.id), ['eth', 'sol']);
  assert.equal(find(card, '.vault-flow').length, 0);

  // Picking Solana redraws the list for Solana and the menu closes.
  button.click();
  const menu = find(card, '.netsel-menu')[0];
  assert.equal(menu.dataset.open, 'true');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  // The shim does not bubble, so the click lands on the menu with the option as its target, as it does in the browser.
  menu.dispatch('click', { target: find(card, '.netsel-option')[3] });
  assert.equal(menu.dataset.open, undefined, 'the menu stayed open after a pick');
  assert.equal(find(button, '.netsel-name')[0].textContent, 'Solana');
  const renders = world.calls.filter((c) => c.route === 'netpick.render');
  assert.equal(renders[renders.length - 1].network, 'sol');

  // Show the address is the component's; it hands the network, the token and the bridge row here.
  renders[renders.length - 1].onAddress('sol', 'SOL', { address: 'SOLADDR' });
  assert.deepEqual(world.calls.find((c) => c.route === 'deposit.open'), { route: 'deposit.open', chain: 'sol', symbol: 'SOL', address: 'SOLADDR' });

  // Keyboard: ArrowDown opens, the arrows walk, Enter picks.
  button.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(menu.dataset.open, 'true');
  const active = (): string => (find(card, '.netsel-option').find((o: Any) => o.dataset.active === 'true') as Any).dataset.network;
  assert.equal(active(), 'sol');
  menu.dispatch('keydown', { key: 'ArrowUp' });
  menu.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(active(), 'base');
  menu.dispatch('keydown', { key: 'Enter' });
  assert.equal(menu.dataset.open, undefined);
  assert.equal(find(button, '.netsel-name')[0].textContent, 'Base');
  menu.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.dataset.open, undefined);
});

test('the wallet\'s own key on the network in the menu sits behind the developer switch; only the EVM one copies', async () => {
  const world = build();
  await flush();
  const card = row(world, 'addresses');
  const key = find(card, '.vault-key')[0];
  assert.ok(key.hasAttribute('data-dev-only'), 'the wallet key is on screen without the switch');
  assert.ok(textOf(key).includes('Wallet key address on Ethereum'));
  assert.ok(textOf(key).includes('Verified. Your account id on NEAR Intents and Hyperliquid.'));
  assert.equal(find(key, '.sr-only')[0].textContent, EVM);
  buttonNamed(key, 'Copy').click();
  await flush();
  assert.deepEqual(world.calls.find((c) => c.route === 'copy'), { route: 'copy', address: EVM });
  assert.ok(textOf(key).includes('Address copied, ends in ...0e1d'));

  // The wallet has no key of its own on Solana any more: no address, no Copy, and the row
  // points at the bridge address above.
  find(card, '.netsel')[0].click();
  find(card, '.netsel-menu')[0].dispatch('click', { target: find(card, '.netsel-option')[3] });
  const sol = find(card, '.vault-key')[0];
  assert.ok(textOf(sol).includes('Wallet key address on Solana'));
  assert.equal(buttonNamed(sol, 'Copy'), undefined, 'a Copy button on the Solana row');
  assert.ok(textOf(sol).some((t) => t.startsWith('This wallet has no key of its own on Solana')));
  assert.equal(find(sol, '.sr-only').length, 0, 'no Solana address is shown');

  const locked = build({ receive: { chains: [{ id: 'eth', name: 'Ethereum', address: EVM }], state: 'locked', verified: false, tampered: false } });
  await flush();
  const unverified = find(locked.view, '.vault-key')[0];
  assert.ok(textOf(unverified).some((t) => t.startsWith('Not verified yet.')));
  assert.equal(buttonNamed(unverified, 'Copy'), undefined, 'an unverified key offered Copy');
});

/* ---------- forget ---------- */

test('Forget opens in place, is dead until FORGET is typed, posts, and shows a not-backed-up refusal; none of it red', async () => {
  const world = build();
  const danger = row(world, 'danger');
  const open = buttonNamed(danger, 'Forget this wallet');
  assert.ok(!open.className.includes('btn-danger'));
  const step = find(danger, '.vault-confirm')[0];
  assert.equal(step.hidden, true);
  open.click();
  assert.equal(step.hidden, false);
  const input = find(step, 'input')[0];
  const forget = buttonNamed(step, 'Forget it');
  assert.ok(!forget.className.includes('btn-danger'), 'forget is refused until backed up, so it is not a loss and not red');
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
  assert.equal(world.confirms.length, 0, 'a dialog over the window');
  assert.ok(world.calls.some((c) => c.route === '/api/vault/forget'));
  assert.ok(textOf(danger).some((t) => t.startsWith('Refused: the phrase is not proven backed up')));

  world.answer.forget = { ok: true };
  forget.click();
  await flush();
  await flush();
  assert.ok(world.calls.filter((c) => c.route === 'refresh').length >= 1);
  assert.ok(world.toasts.some((t) => t.includes('forgotten')));
  assert.equal(step.hidden, true, 'the step stayed open after the wallet was forgotten');

  // No wallet, no row.
  const none = build({ vault: { custody: null } });
  assert.equal(row(none, 'danger').hidden, true);
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

  // The Keys row keeps the button, and the form posts the password once.
  buttonNamed(row(world, 'custody'), 'Move behind the Secure Enclave').click();
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
