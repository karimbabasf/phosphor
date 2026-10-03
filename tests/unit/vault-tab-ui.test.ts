// The Vault, run for real over a small DOM.
//
// What matters most here is the phrase: it is shown once, in its own row, behind a
// route that asks for a Touch ID or behind the password typed into that row (never a
// dialog, never a card in the conversation), with Print and never Copy; "backed up"
// clears only when three words typed back are accepted by the backend, for either kind
// of wallet; Done, a lock, or leaving the tab wipes it. Then the safety rows the bar no
// longer carries: Freeze confirms in place, says what it really does, and its confirm
// is the only red on the page; the lock timer is one radio group the arrows walk; the
// phrase's row says the truth; and the limits are the server's own figures, with the
// ask line changed in place. The rest (keys, restore, addresses behind their fold,
// forget, the migration card) is asserted as the text a person reads and the route a
// click posts. The assistant list has its own file (tests/unit/vault-agent-ui.test.ts).

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
// The three positions the app names with the words, the only three it checks (src/vault/phrase-proof.ts).
const PROVE = [2, 6, 11];
const EVM = '0x7d4e1f0a2c9b8e6d3f5a1c7b9e0d2f4a6c8b0e1d';
// A wallet with no phrase backs up its key in sixteen groups of four. Made up, and kept as groups
// so no key-shaped string sits in the tree.
const GROUPS = ['3f9a', '07c2', 'b41e', '5d68', 'e2a0', '9b17', '4c3d', 'f805', '1a6e', 'c9b2', '7e41', '0d5f', 'a8c3', '62e9', 'd07b', '3b14'];

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
  key: (key: string) => boolean;
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
    reveal: { ok: true, words: WORDS.slice(), paths: { evm: "m/44'/60'/0'/0/0" }, prove: PROVE.slice() },
    proven: (words: Any[]) => (words.every((w) => WORDS[w.index] === w.word) ? { ok: true, backedUpAt: '2026-09-14T10:00:00.000Z' } : { ok: false, error: 'Those words do not match. Look again.', code: 'wrong_words' }),
    revealKey: { ok: true, groups: GROUPS.slice(), address: EVM } as Any,
    keyProven: (key: string) => (key === '0x' + GROUPS.join('') ? { ok: true, backedUpAt: '2026-09-14T10:00:00.000Z' } : { ok: false, error: 'That copy opens a different wallet. Check it group by group.', code: 'wrong_copy' }),
    restoreKey: { ok: true, addresses: { evm: EVM } } as Any,
    keyCheck: { ok: true, matches: true } as Any,
    forget: { ok: true },
    restore: { ok: true, addresses: {} },
    migrate: { ok: true },
    bind: { ok: true, binding: 'app' } as Any,
    prefs: { ok: true },
    confirm: true,
    revealStart: { ok: true, nonce: 'n1' },
    revealFetch: { ok: true, what: 'mnemonic', mnemonic: WORDS.slice(0, 12), prove: PROVE.slice() },
    exportAnswer: { ok: true, path: '/Users/x/Documents/Phosphor backup.json' },
    post: {} as Record<string, Any>,
  };

  const docListeners: Record<string, Array<(event: Any) => void>> = {};
  const doc: Any = {
    body,
    createElement: makeNode,
    getElementById: (id: string) => (id === 'view-vault' ? view : id === 'screen-migrate' ? migrate : id === 'page' ? page : null),
    addEventListener(type: string, fn: (event: Any) => void) { (docListeners[type] ||= []).push(fn); },
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
  sandbox.PhosphorNet = {
    readable: (e: Any) => String(e && e.message ? e.message : e),
    postJson: (path: string, payload: Any) => {
      calls.push(Object.assign({ route: path }, payload));
      const out = answer.post[path];
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out ?? { ok: true });
    },
  };
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
    vaultRevealKey: () => { calls.push({ route: '/api/vault/reveal-key' }); return Promise.resolve(answer.revealKey); },
    vaultKeyProven: (key: string) => { calls.push({ route: '/api/vault/key-proven', key }); return Promise.resolve(answer.keyProven(key)); },
    vaultRestoreKey: (key: string) => { calls.push({ route: '/api/vault/restore', key }); return Promise.resolve(answer.restoreKey); },
    vaultKeyCheck: (key: string) => { calls.push({ route: '/api/vault/key-check', key }); return Promise.resolve(answer.keyCheck); },
    vaultForget: () => { calls.push({ route: '/api/vault/forget' }); return Promise.resolve(answer.forget); },
    vaultRestore: (mnemonic: string) => { calls.push({ route: '/api/vault/restore', mnemonic }); return Promise.resolve(answer.restore); },
    vaultMigrate: (password: string) => { calls.push({ route: '/api/vault/migrate', password }); return Promise.resolve(answer.migrate); },
    vaultBind: () => { calls.push({ route: '/api/vault/bind' }); return Promise.resolve(answer.bind); },
    vaultPrefs: (prefs: Any) => { calls.push(Object.assign({ route: '/api/vault/prefs' }, prefs)); return Promise.resolve(answer.prefs); },
    kill: (on: boolean) => { calls.push({ route: '/api/kill', on }); return answer.kill ? Promise.reject(new Error(answer.kill)) : Promise.resolve(answer.killAnswer || { ok: true }); },
    lock: () => { calls.push({ route: '/api/lock' }); return Promise.resolve({ ok: true }); },
    revealStart: (password: string, what: string) => { calls.push({ route: '/api/wallet/reveal', password, what }); return Promise.resolve(answer.revealStart); },
    revealFetch: (nonce: string) => { calls.push({ route: '/api/wallet/reveal/' + nonce }); return Promise.resolve(answer.revealFetch); },
    walletExport: (password: string, path?: string) => {
      calls.push({ route: '/api/wallet/export', password, path });
      return answer.exportAnswer instanceof Error ? Promise.reject(answer.exportAnswer) : Promise.resolve(answer.exportAnswer);
    },
  };

  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(CUSTODY, sandbox, { filename: 'ui/core/custody.js' });
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
    key: (key: string) => {
      let prevented = false;
      for (const fn of docListeners.keydown ?? []) fn({ key, defaultPrevented: prevented, preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

const row = (world: World, surface: string): Any => find(world.view, '.vault-row').find((p: Any) => p.dataset.surface === surface) as Any;
const recovery = (world: World): Any => row(world, 'recovery');
/* The phrase's own flow (reveal, words, prove) lives in its row under Safety; restore and
   the encrypted copy open in the Restore row under the wallet. */
const flow = (world: World): Any => find(row(world, 'backup'), '.vault-flow')[0];
const restoreFlow = (world: World): Any => find(recovery(world), '.vault-flow')[0];
const backup = (world: World): string => find(row(world, 'backup'), '.vault-text')[0].textContent;
// A date as the Vault writes it: its spaces non-breaking, so "Oct" never ends a line alone.
const day = (words: string): string => words.replace(/ /g, '\u00a0');
const shown = (nodes: Any[]): Any[] => nodes.filter((n: Any) => {
  for (let at = n; at; at = at.parentNode) if (at.hidden) return false;
  return true;
});
const ruleText = (world: World): string[] => shown(find(row(world, 'rules'), '.vault-rule')).map((r: Any) => textOf(r).filter((t) => t !== 'Change').join(' | '));

/* ---------- the source ---------- */

test('no string reaches the DOM as markup, and no Copy is offered on the phrase', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'vault.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
  // The phrase is printed or written down. A clipboard is a place other
  // processes read, so the reveal never writes one: the tab's only copy is the
  // address rows', and that goes through the deposit card's read-back.
  assert.equal(/navigator\.clipboard|writeText/.test(SOURCE), false, 'vault.js writes the clipboard itself');
  // No dialog of any kind asks for the password or shows the words: both happen in the row.
  assert.equal(/PhosphorPassword|PhosphorDecision|showModal|PhosphorConfirm/.test(SOURCE), false, 'a dialog or a thread card on the phrase path');
});

/* ---------- the page ---------- */

test('three sections in reading order, the assistant and Safety side by side first, and every row a tile with no chip or dot', () => {
  const world = build();
  assert.deepEqual(find(world.view, '.vault-sec').map((s: Any) => s.dataset.surface), ['agent', 'safety', 'wallet']);
  assert.deepEqual(find(world.view, '.vault-title').map((t: Any) => t.textContent), ['Your assistant', 'Safety', 'Your wallet']);
  const top = find(world.view, '.vault-top')[0];
  assert.deepEqual(top.childNodes.map((s: Any) => s.dataset.surface), ['agent', 'safety'], 'the assistant and Safety do not share the top');
  assert.deepEqual(find(world.view, '.vault-row').map((r: Any) => r.dataset.surface),
    ['freeze', 'window', 'backup', 'rules', 'custody', 'recovery', 'addresses', 'danger']);
  assert.deepEqual(find(world.view, '.vault-row-title').map((t: Any) => t.textContent),
    ['Freeze', 'Locks after', 'Recovery phrase', 'Policies', 'Keys', 'Restore', 'Addresses', 'Forget']);
  assert.equal(find(world.view, '.panel').length, 0, 'a card is back on the Vault');
  assert.equal(find(world.view, '.chip').length, 0, 'a status chip is back on the Vault');
  assert.equal(find(world.view, '.dot').length, 0, 'a dot is back on the Vault');
  // The rows are tiles: no rule between them, the soft layer on each.
  const css = read('../../ui/design/vault.css');
  assert.match(css, /\.vault-row \{[^}]*background: var\(--tile\);[^}]*box-shadow: var\(--hi\);/);
  assert.doesNotMatch(css, /\.vault-row \{[^}]*border-bottom/, 'a hairline between rows is back');
  assert.match(css, /@container vault \(min-width: 620px\)/, 'the two columns do not follow the page');
});

test('the lock row says the screen lock locks the window too, so a long timer is no surprise', () => {
  const world = build();
  const row = find(world.view, '.vault-row').find((r: Any) => r.dataset.surface === 'window');
  assert.ok(row, 'no lock row');
  assert.deepEqual(find(row, '.vault-text').map((t: Any) => t.textContent),
    ["The window locks after this long without you, and whenever your Mac's screen locks. It hides everything until you open it."]);
});

test('no red but the freeze, and no green anywhere on the Vault but the tick on a proven backup or a bound key', () => {
  // btn-danger is set in the freeze's own code and nowhere else; btn-primary is Approve's.
  const danger = SOURCE.split('btn-danger').length - 1;
  assert.equal(danger, 2, 'btn-danger outside the freeze confirm');
  assert.ok(/refs\.freezeGo = button\(FREEZE\.off\.go, 'btn-danger btn-sm'/.test(SOURCE));
  assert.doesNotMatch(SOURCE, /btn-primary/, 'a green button on the Vault');
  assert.doesNotMatch(SOURCE, /PhosphorToast\.show\([^)]*'down'\)/, 'a red toast from the Vault');
  const css = read('../../ui/design/vault.css');
  assert.doesNotMatch(css, /--down|--ink-wash|--up\b/, 'vault.css paints a state colour');
  const inks = css.match(/var\(--ink\)/g) ?? [];
  assert.equal(inks.length, 1, 'the ink is on something other than the proven phrase');
  assert.match(css, /\.vault-backup-mark \{[^}]*color: var\(--ink\);/);
});

/* ---------- safety: freeze ---------- */

test('Freeze asks in place, says what it really does, with Cancel first and the one red button; Escape puts it away from anywhere', async () => {
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
  // The kill switch closes every open position at the market price (src/runner/host.ts stopAll):
  // the step says so, and never that nothing in the app can close one.
  const ask = textOf(step).find((t) => t.startsWith('This closes your open trading positions at the market price')) as string;
  assert.ok(ask, JSON.stringify(textOf(step)));
  assert.ok(ask.includes('Nothing can move your money until you unfreeze.'));
  assert.equal(textOf(world.view).some((t) => /nothing in this app can|does not close/i.test(t)), false, 'the old, false sentence is back');
  const buttons = find(step, 'button');
  assert.deepEqual(buttons.map((b: Any) => b.textContent), ['Cancel', 'Freeze everything']);
  assert.ok(buttons[1].className.includes('btn-danger'), 'the freeze itself is not the red one');
  assert.ok(!buttons[0].className.includes('btn-danger'));
  assert.equal(world.calls.some((c) => c.route === '/api/kill'), false, 'opening the step froze something');
  step.dispatch('keydown', { key: 'Escape' });
  assert.equal(step.hidden, true);
  assert.equal(open.hidden, false);

  // Escape anywhere on the page closes it too, not only inside the step.
  open.click();
  assert.equal(step.hidden, false);
  assert.equal(world.key('Escape'), true, 'the page did not take the Escape');
  assert.equal(step.hidden, true);

  open.click();
  buttons[1].click();
  await flush();
  await flush();
  assert.deepEqual(world.calls.find((c) => c.route === '/api/kill'), { route: '/api/kill', on: true });
  assert.ok(world.calls.some((c) => c.route === 'refresh'));
  assert.equal(step.hidden, true, 'the step stayed open after the freeze landed');
});

test('frozen, the row reads frozen before a word is read, and its way back is plain, never red', () => {
  const world = build({ policy: { killSwitch: true, outbound: {} } });
  const freeze = row(world, 'freeze');
  assert.equal(freeze.getAttribute('data-frozen'), 'true', 'the tile does not know it is frozen');
  assert.ok(textOf(freeze).includes('Everything is frozen. The assistant cannot move any money until you unfreeze.'));
  buttonNamed(find(freeze, '.vault-row-act')[0], 'Unfreeze').click();
  const step = find(freeze, '.vault-confirm')[0];
  assert.ok(textOf(step).some((t) => t.includes('Positions the freeze closed stay closed.')));
  const go = find(step, 'button').find((b: Any) => b.textContent === 'Unfreeze') as Any;
  assert.ok(go, 'no Unfreeze in the step');
  assert.ok(!go.className.includes('btn-danger'), 'the way back is red');
  assert.ok(find(step, 'button').some((b: Any) => b.textContent === 'Keep frozen'));
});

/* A position needs the trading key to close. A freeze with none in reach still freezes, and the
   answer's note (src/kill.ts) is said once, so the step that promised the close is not the last
   word on positions that stayed open. */
test('a freeze that could not close the trading positions says so once it lands', async () => {
  const world = build();
  const note = 'Frozen. Your trading positions are still open, because Phosphor has no trading key for this account; close them on Hyperliquid.';
  world.answer.killAnswer = { ok: true, killSwitch: true, note };
  const freeze = row(world, 'freeze');
  buttonNamed(find(freeze, '.vault-row-act')[0], 'Freeze everything').click();
  find(find(freeze, '.vault-confirm')[0], 'button')[1].click();
  await flush();
  await flush();
  assert.deepEqual(world.toasts, [note]);
  assert.ok(world.calls.some((c) => c.route === 'refresh'));
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

test('the lock timer is one radio group: it marks the current choice, the arrows walk and choose, and Lock now locks', async () => {
  const world = build();
  const lock = row(world, 'window');
  const cells = find(lock, 'button.vault-seg-cell');
  assert.deepEqual(cells.map((c: Any) => c.textContent), ['5 min', '15 min', '1 hour']);
  assert.deepEqual(cells.map((c: Any) => c.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.equal(cells[0].getAttribute('role'), 'radio');
  // One stop in the tab order: the chosen cell.
  assert.deepEqual(cells.map((c: Any) => c.tabIndex), [-1, 0, -1]);
  cells[2].click();
  await flush();
  assert.deepEqual(world.calls.find((c) => c.route === '/api/vault/prefs'), { route: '/api/vault/prefs', idleMinutes: 60 });
  // ArrowLeft from 15 min chooses 5 min.
  cells[1].dispatch('keydown', { key: 'ArrowLeft' });
  await flush();
  assert.deepEqual(world.calls.filter((c) => c.route === '/api/vault/prefs').map((c) => c.idleMinutes), [60, 5]);
  // The one already chosen posts nothing.
  const before = world.calls.length;
  cells[1].click();
  await flush();
  assert.equal(world.calls.length, before, 'the current choice was posted again');
  buttonNamed(lock, 'Lock now').click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/lock'));
  assert.ok(!textOf(lock).some((t) => t.includes('Every move still needs its own click')), 'the row promises a click it cannot keep');
  // A locked window has nothing to lock.
  world.put({ lock: { state: 'locked', idleLocksInSec: null } });
  assert.equal(buttonNamed(lock, 'Lock now').hidden, true);
});

/* ---------- safety: the recovery phrase ---------- */

test('the phrase row says the truth and leads to the reveal; proven, it says when, wears the tick, and offers the words again', async () => {
  const world = build();
  assert.ok(backup(world).startsWith('Not backed up yet.'), backup(world));
  const go = buttonNamed(row(world, 'backup'), 'Back it up');
  assert.equal(go.hidden, false);
  go.click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/vault/reveal'), 'Back it up did not start the reveal');
  assert.equal(flow(world).dataset.step, 'words');
  assert.equal(go.hidden, true, 'Back it up stayed beside the words');

  world.put({ vault: vaultState({ backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' }) });
  buttonNamed(flow(world), 'Hide words').click();
  assert.equal(backup(world), `Backed up. You proved your copy on ${day('Sep 14, 2026')}.`);
  assert.equal(find(row(world, 'backup'), '.vault-text')[0].getAttribute('data-backed'), 'true');
  assert.equal(buttonNamed(row(world, 'backup'), 'Back it up'), undefined, 'Back it up on a proven phrase');
  assert.equal(buttonNamed(row(world, 'backup'), 'Show my words').hidden, false);

  const none = build({ vault: { custody: null } });
  assert.equal(backup(none), 'There is nothing to back up until a wallet exists.');
  // A wallet with no phrase is not told its file is its backup any more: it backs up its key here.
  const keys = build({ vault: { hasMnemonic: false } });
  assert.equal(find(row(keys, 'backup'), '.vault-row-title')[0].textContent, 'Private key');
  assert.ok(backup(keys).startsWith('Not backed up yet. This wallet has no recovery phrase, so its key is the only way back'), backup(keys));
  assert.equal(buttonNamed(row(keys, 'backup'), 'Back it up').hidden, false);
});

/* ---------- a password wallet: the same row, the password typed into it ---------- */

test('a password wallet backs up in place: the password in the row, the words, three typed back, and the app marks it backed up', async () => {
  const world = build({ vault: { custody: 'software', enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } } });
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  const panel = flow(world);
  assert.equal(panel.dataset.step, 'password', 'the password is not asked for in the row');
  assert.equal(world.calls.some((c) => c.route === '/api/vault/reveal'), false, 'Touch ID was asked of a password wallet');
  const input = find(panel, 'input[type="password"]')[0];
  assert.ok(input, 'no password field in the row');
  // A wrong password says so in the row, and the field is emptied.
  world.answer.revealStart = { ok: false, error: 'That password is wrong.', code: 'wrong_password' };
  input.value = 'nope';
  find(panel, 'form')[0].dispatch('submit');
  await flush();
  await flush();
  assert.ok(textOf(panel).includes('That password is wrong.'));
  assert.equal(input.value, '');
  // The right one: the words, in the row, never a dialog or a card in the thread.
  world.answer.revealStart = { ok: true, nonce: 'n2' };
  input.value = 'proof-password-1';
  find(panel, 'form')[0].dispatch('submit');
  await flush();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/wallet/reveal' && c.password === 'proof-password-1' && c.what === 'mnemonic'));
  assert.ok(world.calls.some((c) => c.route === '/api/wallet/reveal/n2'));
  assert.equal(flow(world).dataset.step, 'words');
  assert.deepEqual(find(flow(world), '.word').map((w: Any) => w.childNodes[1].textContent), WORDS.slice(0, 12));
  assert.equal(world.confirms.length, 0, 'a dialog over the window');

  buttonNamed(flow(world), 'I wrote them down').click();
  const inputs = find(flow(world), 'input');
  assert.equal(inputs.length, 3);
  inputs.forEach((field: Any) => { field.value = WORDS[Number(field.dataset.index)]; });
  buttonNamed(flow(world), 'Prove it').click();
  await flush();
  const proven = world.calls.find((c) => c.route === '/api/vault/backup-proven');
  assert.ok(proven, 'the words were never checked by the app');
  assert.ok(world.calls.some((c) => c.route === 'refresh'), 'a proven phrase did not refresh the state');
  assert.equal(flow(world).hidden, true, 'the words stayed after they were proven');
});

/* ---------- safety: limits ---------- */

test('the limits are the server\'s own figures, a name and a figure each, in the order a person needs them, with the day\'s use', () => {
  const world = build({
    policy: { approval: { thresholdUsd: 100 }, outbound: { humanClickAboveUsd: 100, destinationAllowlist: ['oneclick:1click.chaindefuser.com', 'intents.near', 'hyperliquid-perps', '0xabc'] } },
    sentences: [
      'Refuse any single transaction above $10,000.',
      'Refuse more than $25,000 in any 24 hours.',
      'Ask me before anything above $100.',
      'Ask me once auto-approved moves pass $500 in 24 hours.',
      'Keep $5 of gas on Ethereum.',
      'Allowed destinations: 4.',
    ],
    dailyLimit: { capUsd: 25000, spentUsd: 120.07, resetsAt: null },
  });
  assert.deepEqual(ruleText(world), [
    'Asks you above | $100 | Anything above this waits for your click.',
    'Largest move | $10,000 | Anything above this is refused.',
    'In any 24 hours | $25,000 | $120.07 of it used in the last 24 hours.',
    'Without asking | $500 | Moves made on their own stop at this in any 24 hours, then it asks you again.',
    'Keep $5 of gas on Ethereum.',
    'Pays only | 1 wallet of yours, your swaps and your trading account.',
  ]);
  // Figures are figures: the value carries the tabular numerals.
  assert.ok(shown(find(row(world, 'rules'), '.vault-rule-value')).every((v: Any) => String(v.className).split(' ').includes('num')));
  // No venue names and no first person on the page.
  const words = textOf(row(world, 'rules')).join(' ');
  assert.doesNotMatch(words, /1Click|NEAR Intents|Hyperliquid|Ask me|auto-approved/);
});

test('a limit that is not set is not drawn, nothing spent is said in words, and no policy is one sentence', () => {
  const quiet = build({
    policy: { outbound: {} },
    sentences: ['Refuse more than $500 in any 24 hours.', 'Kill switch on: every proposal is refused.'],
    dailyLimit: { capUsd: 500, spentUsd: 0, resetsAt: null },
  });
  assert.deepEqual(ruleText(quiet), [
    'In any 24 hours | $500 | None of it used in the last 24 hours.',
  ], 'the kill switch is the Freeze row\'s, not a limit');

  const none = build({ policy: { outbound: {} }, sentences: [] });
  assert.deepEqual(ruleText(none), [
    'No limits are set, so everything your assistant asks for waits for your click.',
  ]);
});

test('the ask line changes in place: the field, the amounts that follow it, one post, and the route\'s own refusal', async () => {
  const world = build({ policy: { outbound: { humanClickAboveUsd: 100, maxPerTransactionUsd: 10000 } }, sentences: ['Ask me before anything above $100.'] });
  const rules = row(world, 'rules');
  const change = buttonNamed(rules, 'Change');
  assert.ok(change, 'no Change on the ask line');
  const edit = find(rules, 'form.vault-ask')[0];
  assert.equal(edit.hidden, true);
  change.click();
  assert.equal(edit.hidden, false);
  assert.equal(change.hidden, true);
  const input = find(edit, 'input')[0];
  assert.equal(input.value, '100', 'the field does not start at the figure in force');
  const chips = find(edit, 'button.vault-chip');
  assert.deepEqual(chips.map((c: Any) => c.textContent), ['$25', '$100', '$500', '$1,000']);
  assert.deepEqual(chips.map((c: Any) => c.getAttribute('aria-checked')), ['false', 'true', 'false', 'false']);
  input.value = '500';
  input.dispatch('input');
  assert.deepEqual(chips.map((c: Any) => c.getAttribute('aria-checked')), ['false', 'false', 'true', 'false'], 'the amounts do not follow what is typed');
  chips[0].click();
  assert.equal(input.value, '25');

  world.answer.post['/api/policy/threshold'] = Object.assign(new Error('Keep the threshold under $10,000.'), { status: 400 });
  input.value = '20000';
  edit.dispatch('submit');
  await flush();
  await flush();
  assert.ok(textOf(edit).includes('Keep the threshold under $10,000.'));
  assert.equal(edit.hidden, false, 'a refusal closed the editor');

  world.answer.post['/api/policy/threshold'] = { ok: true, threshold: 25, from: 100 };
  input.value = '25';
  edit.dispatch('submit');
  await flush();
  await flush();
  assert.deepEqual(world.calls.filter((c) => c.route === '/api/policy/threshold').map((c) => c.usd), [20000, 25]);
  assert.ok(world.calls.some((c) => c.route === 'refresh'));
  assert.equal(edit.hidden, true, 'the editor stayed open after the figure saved');
});

/* ---------- reveal and prove ---------- */

test('Back it up posts /api/vault/reveal, shows the 24 words once, with Print and without Copy', async () => {
  const world = build();
  buttonNamed(row(world, 'backup'), 'Back it up').click();
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
  // The derivation path is a developer's line: stated, and behind the switch.
  const path = find(panel, 'p').find((p: Any) => p.textContent.includes("m/44'/60'/0'/0/0")) as Any;
  assert.ok(path, 'the derivation path is not stated');
  assert.ok(path.hasAttribute('data-dev-only'), 'the derivation path shows to everyone');
  assert.equal(textOf(panel).some((t) => t.includes("m/44'/501'")), false, 'a Solana path the wallet no longer signs with');
  // The warning is a line with the lock, not a red banner.
  assert.equal(find(panel, '.banner').length, 0);
  assert.ok(textOf(panel).some((t) => t.startsWith('On this screen only.')));
});

test('Print prints a sheet that holds only the numbered words, and takes it away after', async () => {
  const world = build();
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  buttonNamed(flow(world), 'Print').click();
  const printed = world.calls.find((c) => c.route === 'print');
  assert.ok(printed && printed.sheet, 'print ran without a sheet in the document');
  assert.deepEqual(find(printed.sheet, 'li').map((li: Any) => li.textContent), WORDS);
  assert.equal(world.sandbox.document.body.childNodes.includes(printed.sheet), false, 'the sheet stayed in the document after printing');
  // Whoever finds the paper later is told how to use it, and when it was printed.
  const words = textOf(printed.sheet);
  assert.ok(words.includes('Anyone who has these words has the money. Keep this sheet away from your Mac.'));
  assert.ok(words.includes('To restore this wallet on any Mac: install Phosphor from phosphor.money, choose I already have a wallet, and type the words in order.'));
  assert.ok(words.some((t) => /^Printed on [A-Z][a-z]{2}\u00a0\d{1,2},\u00a0\d{4}\.$/.test(t)), String(words));
});

test('the Prove step posts three positions, and only a right answer clears "not backed up"; two misses show the words again', async () => {
  const world = build();
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  buttonNamed(flow(world), 'I wrote them down').click();
  let panel = flow(world);
  assert.equal(panel.dataset.step, 'prove');
  let inputs = find(panel, 'input');
  assert.equal(inputs.length, 3, 'the prove step does not ask for three words');
  const positions = inputs.map((i: Any) => Number(i.dataset.index));
  assert.deepEqual(positions, PROVE, 'the window asked other positions than the three the app named');
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

  // A second miss: the words again, with the line that says why.
  for (const input of inputs) input.value = 'wrong';
  buttonNamed(panel, 'Prove it').click();
  await flush();
  assert.equal(flow(world).dataset.step, 'words', 'two misses did not show the words again');
  assert.ok(textOf(flow(world)).includes('Two tries did not match. Check your copy, then try again.'));

  // Right words: accepted, the phrase is wiped, and the row follows the state.
  buttonNamed(flow(world), 'I wrote them down').click();
  panel = flow(world);
  inputs = find(panel, 'input');
  inputs.forEach((input: Any) => { input.value = WORDS[Number(input.dataset.index)]; });
  let scrolled = 0;
  row(world, 'backup').scrollIntoView = () => { scrolled += 1; };
  buttonNamed(panel, 'Prove it').click();
  await flush();
  const posts = world.calls.filter((c) => c.route === '/api/vault/backup-proven');
  assert.equal(posts.length, 3);
  assert.ok(world.calls.some((c) => c.route === 'refresh'), 'a right answer did not refresh the state');
  assert.equal(flow(world).hidden, true, 'the phrase is still on screen after it was proven');
  assert.equal(find(flow(world), '.word').length, 0, 'the words survived the wipe');
  world.put({ vault: vaultState({ backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' }) });
  assert.ok(backup(world).startsWith('Backed up.'));
  // The row says it, in view, with its tick popping: no toast laid over the rows below.
  assert.equal(find(row(world, 'backup'), '.vault-backup-line')[0].getAttribute('data-pop'), 'true', 'the tick did not pop');
  assert.ok(scrolled > 0, 'the done line was left out of view');
  assert.deepEqual(world.toasts, []);
});

test('Done, a lock, or leaving the tab wipes the words', async () => {
  const world = build();
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  assert.equal(find(flow(world), '.word').length, 24);
  buttonNamed(flow(world), 'Hide words').click();
  assert.equal(find(flow(world), '.word').length, 0);
  assert.equal(flow(world).hidden, true);

  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  assert.equal(find(flow(world), '.word').length, 24);
  world.put({ lock: { state: 'locked', idleLocksInSec: null } });
  assert.equal(find(flow(world), '.word').length, 0, 'the words stayed on a locked window');
});

/* The reveal opens nothing, so the proof is checked against what the reveal left in the app for
   half an hour. Past that (or after a restart) the backend says to show the words again: the row
   closes so Back it up is there to press, and the sentence says so once. */
test('a proof the app can no longer check closes the row and says to show the words again', async () => {
  const world = build();
  world.answer.proven = () => ({ ok: false, error: 'Show your words once more with Back it up, then type three of them back.', code: 'reveal_again' });
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  buttonNamed(flow(world), 'I wrote them down').click();
  const panel = flow(world);
  find(panel, 'input').forEach((input: Any) => { input.value = WORDS[Number(input.dataset.index)]; });
  buttonNamed(panel, 'Prove it').click();
  await flush();
  assert.equal(flow(world).hidden, true, 'the words are wiped and the row is closed');
  assert.equal(find(flow(world), '.word').length, 0);
  assert.deepEqual(world.toasts, ['Show your words once more with Back it up, then type three of them back.']);
  assert.ok(backup(world).startsWith('Not backed up yet.'));
});

/* The app checks only the three positions it named with the words. Words that came without them
   cannot be proven, so the row says to show them again rather than ask positions of its own. */
test('words that came without the three positions to ask are shown again, never quizzed on a guess', async () => {
  const world = build();
  world.answer.reveal = { ok: true, words: WORDS.slice(), paths: { evm: "m/44'/60'/0'/0/0" } };
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  buttonNamed(flow(world), 'I wrote them down').click();
  assert.equal(flow(world).hidden, true, 'the words are wiped and the row is closed');
  assert.equal(world.calls.filter((c) => c.route === '/api/vault/backup-proven').length, 0);
  assert.deepEqual(world.toasts, ['Show your words once more with Back it up, then type three of them back.']);
});

/* A reveal whose Touch ID went through on a working wallet and still could not read it is not a
   broken wallet: the person is making their only copy, so the line says only that it could not show. */
test('a reveal that could not show the backup says so in the row, never that the wallet is lost', async () => {
  const words = build();
  words.answer.reveal = { ok: false, error: 'Phosphor could not show your backup just now, and nothing changed. Try again.', code: 'reveal_failed' };
  buttonNamed(row(words, 'backup'), 'Back it up').click();
  await flush();
  assert.ok(textOf(flow(words)).includes('Phosphor could not show your recovery phrase just now, and nothing changed. Try again.'), String(textOf(flow(words))));
  const key = build({ vault: { hasMnemonic: false } });
  key.answer.revealKey = { ok: false, error: 'Phosphor could not show your backup just now, and nothing changed. Try again.', code: 'reveal_failed' };
  buttonNamed(row(key, 'backup'), 'Back it up').click();
  await flush();
  assert.ok(textOf(flow(key)).includes('Phosphor could not show your key just now, and nothing changed. Try again.'), String(textOf(flow(key))));
  assert.ok(!textOf(flow(key)).some((t) => /recovery words|bring the wallet back/.test(t)));
  // The service's own words never reach the row.
  const raw = build({ vault: { hasMnemonic: false } });
  raw.answer.revealKey = { ok: false, error: 'no user present', code: 'interaction_required' };
  buttonNamed(row(raw, 'backup'), 'Back it up').click();
  await flush();
  assert.ok(textOf(flow(raw)).includes('That did not finish, so nothing changed. Try again.'), String(textOf(flow(raw))));
});

test('the foot notice\'s Back it up lands on this row: the shell glides to it and puts the cursor on its button', () => {
  const world = build();
  const backup = row(world, 'backup');
  assert.equal(backup.getAttribute('data-reveal'), 'backup');
  assert.equal(buttonNamed(backup, 'Back it up').getAttribute('data-reveal-focus'), '');
});

test('a cancelled Touch ID on the reveal shows nothing and says nothing', async () => {
  const world = build();
  world.answer.reveal = { ok: false, error: 'cancelled', code: 'user_cancel' };
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  assert.equal(flow(world).hidden, true);
  assert.equal(world.toasts.length, 0);
});

/* ---------- a wallet with no phrase: its private key, in the same row ---------- */

const keyText = (world: World): string[] => find(flow(world), '.word').map((w: Any) => w.childNodes[1].textContent);

test('a wallet with no phrase backs up its key in the same row: one line says why Touch ID, and Back it up posts the key reveal', async () => {
  const world = build({ vault: { hasMnemonic: false } });
  const why = find(row(world, 'backup'), '.vault-sub').find((p: Any) => p.textContent === 'Showing it takes Touch ID, so only you can see it.') as Any;
  assert.ok(why && !why.hidden, 'the row does not say why the key takes a Touch ID');
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/vault/reveal-key'), 'Back it up did not ask for the key');
  assert.equal(world.calls.some((c) => c.route === '/api/vault/reveal'), false, 'the phrase was asked of a wallet with none');
  const panel = flow(world);
  assert.equal(panel.dataset.step, 'key');
  assert.deepEqual(keyText(world), GROUPS, 'the sixteen groups are not on screen in order');
  assert.deepEqual(find(panel, '.word').map((w: Any) => w.childNodes[0].textContent), GROUPS.map((_, i) => String(i + 1)), 'the groups are not numbered');
  assert.ok(String(find(panel, 'ol')[0].className).split(' ').includes('vault-key'), 'the key is not set as a key');
  assert.ok(textOf(panel).includes('On this screen only. Anyone who reads this key can take your money.'));
  assert.ok(textOf(panel).includes('It opens the wallet 0x7d4e...0e1d.'), String(textOf(panel)));
  const labels = find(panel, 'button').map((b: Any) => b.textContent);
  // Hide key, not Done: a first-timer reads Done as "I am done backing up".
  assert.deepEqual(labels, ['I wrote it down', 'Print', 'Hide key']);
  assert.equal(labels.some((l: string) => /copy/i.test(l)), false, 'a Copy button on the key');
  assert.equal(buttonNamed(row(world, 'backup'), 'Back it up').hidden, true, 'Back it up stayed beside the key');
  assert.equal(why.hidden, true, 'the Touch ID line stayed once the key was on screen');
  assert.equal(find(panel, '.banner').length, 0);
});

/* A key has no checksum, and three groups of sixteen pass a copy with one slipped group 13 times
   in 16, so the key is proven by the whole copy, typed once from the paper. */
test('I wrote it down asks for the whole copy once; a slip is named by its group, and only a whole match marks it backed up', async () => {
  const world = build({ vault: { hasMnemonic: false } });
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  buttonNamed(flow(world), 'I wrote it down').click();
  let panel = flow(world);
  assert.equal(panel.dataset.step, 'prove');
  assert.equal(find(panel, 'input').length, 0, 'groups asked one by one');
  assert.equal(find(panel, 'textarea').length, 1, 'one field takes the whole copy');
  assert.ok(textOf(panel).includes('Check your copy'));
  assert.ok(textOf(panel).includes('Type the whole key from your copy. One wrong character opens a different wallet, so every one is checked against this wallet now, before you need it.'));
  assert.equal(keyText(world).length, 0, 'the key stayed on screen while its copy is typed');

  let input = find(panel, 'textarea')[0];
  input.value = GROUPS.slice(0, 15).join(' ');
  buttonNamed(panel, 'Check').click();
  assert.ok(textOf(panel).includes('That is 60 characters. A private key is 64.'));
  assert.equal(world.calls.some((c) => c.route === '/api/vault/key-proven'), false, 'a copy that cannot be right was sent');

  // One slipped group: the app answers another wallet, and the window, still holding the key it
  // showed a moment ago, names the group to look at. Two misses show the key again.
  world.answer.keyProven = () => ({ ok: false, error: 'That copy opens a different wallet. Check it group by group.', code: 'wrong_copy' });
  input.value = GROUPS.map((g, i) => (i === 5 ? 'ffff' : g)).join(' ');
  buttonNamed(panel, 'Check').click();
  await flush();
  assert.ok(textOf(panel).includes('Group 6 does not match the key Phosphor showed you. Check it on your copy, then try again.'), String(textOf(panel)));
  buttonNamed(panel, 'Check').click();
  await flush();
  assert.equal(flow(world).dataset.step, 'key', 'two misses did not show the key again');
  assert.ok(textOf(flow(world)).includes('Two tries did not match. Check your copy group by group, then try again.'));

  // The whole copy, as a person copies it: upper case, a line break, 0x in front.
  world.answer.keyProven = () => ({ ok: true, backedUpAt: '2026-09-14T10:00:00.000Z' });
  buttonNamed(flow(world), 'I wrote it down').click();
  panel = flow(world);
  input = find(panel, 'textarea')[0];
  input.value = '0X' + GROUPS.slice(0, 8).join(' ').toUpperCase() + '\n' + GROUPS.slice(8).join(' ');
  buttonNamed(panel, 'Check').click();
  await flush();
  const posts = world.calls.filter((c) => c.route === '/api/vault/key-proven');
  assert.equal(posts.length, 3);
  assert.equal(posts[2].key, '0x' + GROUPS.join(''), 'the copy is sent whole, as one key');
  assert.equal(world.calls.some((c) => c.route === '/api/vault/key-check'), false, 'the proof went through the check that writes nothing');
  assert.ok(world.calls.some((c) => c.route === 'refresh'));
  assert.equal(flow(world).hidden, true);
  assert.equal(find(flow(world), '.word').length, 0, 'the key survived the wipe');
  world.put({ vault: vaultState({ hasMnemonic: false, backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' }) });
  assert.equal(backup(world), `Backed up on ${day('Sep 14, 2026')}. Your whole copy matched.`);
  assert.equal(find(row(world, 'backup'), '.vault-backup-line')[0].getAttribute('data-pop'), 'true', 'the tick did not pop');
  assert.deepEqual(world.toasts, [], 'a toast said what the row says');
});

test('proven, the key row reads as done: the tick, the day, Show my key, and no Touch ID line', () => {
  const world = build({ vault: { hasMnemonic: false, backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  assert.equal(find(row(world, 'backup'), '.vault-row-title')[0].textContent, 'Private key');
  assert.equal(backup(world), `Backed up on ${day('Sep 14, 2026')}. Your whole copy matched.`);
  assert.equal(find(row(world, 'backup'), '.vault-text')[0].getAttribute('data-backed'), 'true');
  assert.equal(buttonNamed(row(world, 'backup'), 'Show my key').hidden, false);
  assert.equal(buttonNamed(row(world, 'backup'), 'Back it up') === undefined, true, 'Back it up on a proven key');
  const why = find(row(world, 'backup'), '.vault-sub').find((p: Any) => p.textContent.startsWith('Showing it takes Touch ID')) as Any;
  assert.equal(why.hidden, true);
});

test('Print prints the numbered groups and the wallet they open, and takes the sheet away after', async () => {
  const world = build({ vault: { hasMnemonic: false } });
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  buttonNamed(flow(world), 'Print').click();
  const printed = world.calls.find((c) => c.route === 'print');
  assert.ok(printed && printed.sheet);
  assert.deepEqual(find(printed.sheet, 'li').map((li: Any) => li.textContent), GROUPS);
  assert.ok(textOf(printed.sheet).includes(`It opens the wallet ${EVM}.`));
  assert.ok(textOf(printed.sheet).includes('Phosphor private key'));
  assert.ok(textOf(printed.sheet).includes('Anyone who has this key has the money. Keep this sheet away from your Mac.'));
  assert.ok(textOf(printed.sheet).includes('To restore this wallet on any Mac: install Phosphor from phosphor.money, choose I already have a wallet, and type the sixteen groups in order.'));
  assert.ok(textOf(printed.sheet).some((t) => t.startsWith('Printed on ')));
  assert.ok(!textOf(printed.sheet).some((t) => /computer/.test(t)), 'the sheet says computer');
  assert.equal(world.sandbox.document.body.childNodes.includes(printed.sheet), false);
});

test('Done, a lock, or leaving the tab wipes the key, and a cancelled touch shows nothing', async () => {
  const world = build({ vault: { hasMnemonic: false } });
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  assert.equal(keyText(world).length, 16);
  buttonNamed(flow(world), 'Hide key').click();
  assert.equal(keyText(world).length, 0);

  buttonNamed(row(world, 'backup'), 'Back it up').click();
  await flush();
  world.put({ lock: { state: 'locked', idleLocksInSec: null } });
  assert.equal(keyText(world).length, 0, 'the key stayed on a locked window');

  const cancelled = build({ vault: { hasMnemonic: false } });
  cancelled.answer.revealKey = { ok: false, error: 'cancelled', code: 'user_cancel' };
  buttonNamed(row(cancelled, 'backup'), 'Back it up').click();
  await flush();
  assert.equal(flow(cancelled).hidden, true);
  assert.equal(cancelled.toasts.length, 0);

  const short = build({ vault: { hasMnemonic: false } });
  short.answer.revealKey = { ok: true, groups: GROUPS.slice(0, 15) };
  buttonNamed(row(short, 'backup'), 'Back it up').click();
  await flush();
  assert.ok(textOf(flow(short)).includes('No key came back.'), 'a key cut short was shown as a key');
});

/* A proven key's copy, checked whole again later, with no Touch ID and nothing written: never by
   trying a restore, which would replace the wallet with whatever a slip in the copy makes. */
test('a proven key offers Check my copy: the whole key typed, checked with nothing written, and a slip named as another wallet', async () => {
  const world = build({ vault: { hasMnemonic: false, backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  assert.equal(buttonNamed(build({ vault: { hasMnemonic: false } }).view, 'Check my copy').hidden, true, 'a check offered before there is a proven copy');
  assert.equal(buttonNamed(build({ vault: { backedUp: true } }).view, 'Check my copy').hidden, true, 'a key check offered to a wallet with a phrase');
  buttonNamed(row(world, 'backup'), 'Check my copy').click();
  const panel = flow(world);
  assert.equal(panel.dataset.step, 'check');
  assert.ok(textOf(panel).includes('Type the whole key from your copy. It is checked against this wallet, kept nowhere, and nothing changes.'));
  assert.equal(buttonNamed(row(world, 'backup'), 'Show my key').hidden, true, 'Show my key stayed beside the check');
  const input = find(panel, 'textarea')[0];
  input.value = GROUPS.slice(0, 15).join(' ');
  buttonNamed(panel, 'Check').click();
  assert.ok(textOf(panel).includes('That is 60 characters. A private key is 64.'));
  assert.equal(world.calls.some((c) => c.route === '/api/vault/key-check'), false);

  input.value = GROUPS.join(' ').toUpperCase();
  buttonNamed(panel, 'Check').click();
  await flush();
  const post = world.calls.find((c) => c.route === '/api/vault/key-check');
  assert.ok(post, 'the copy was never checked');
  assert.equal(post.key, '0x' + GROUPS.join(''));
  const right = find(panel, '.vault-check-line')[0];
  assert.equal(right.hidden, false);
  assert.ok(textOf(right).includes('Your copy is right, to the last character.'));
  assert.equal(input.value, '', 'a checked key stayed in the field');

  world.answer.keyCheck = { ok: true, matches: false };
  input.value = GROUPS.join('');
  input.dispatch('input');
  buttonNamed(panel, 'Check').click();
  await flush();
  assert.equal(right.hidden, true);
  assert.ok(textOf(panel).includes('That copy opens a different wallet. Show your key and check it group by group.'));
  assert.equal(world.calls.some((c) => c.route === '/api/vault/reveal-key' || c.route === '/api/vault/restore' || c.route === 'refresh'), false, 'a check reached past itself');

  buttonNamed(panel, 'Done').click();
  assert.equal(flow(world).hidden, true);
  assert.equal(find(flow(world), 'textarea').length, 0, 'the typed key survived Done');
});

test('a password wallet with no phrase shows its key behind the password typed in the row', async () => {
  const world = build({ vault: { custody: 'software', hasMnemonic: false, enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } } });
  const why = find(row(world, 'backup'), '.vault-sub').find((p: Any) => p.textContent.startsWith('Showing it takes Touch ID')) as Any;
  assert.equal(why.hidden, true, 'a password wallet was told about a Touch ID');
  world.answer.revealFetch = { ok: true, what: 'keys', keys: { evm: '0x' + GROUPS.join('') }, groups: GROUPS.slice() };
  buttonNamed(row(world, 'backup'), 'Back it up').click();
  const panel = flow(world);
  assert.equal(panel.dataset.step, 'password');
  assert.ok(textOf(panel).includes('Type your password to see your private key. It shows here once and is not saved anywhere.'));
  find(panel, 'input[type="password"]')[0].value = 'proof-password-1';
  find(panel, 'form')[0].dispatch('submit');
  await flush();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/wallet/reveal' && c.what === 'keys'), 'the password reveal did not ask for the key');
  assert.equal(world.calls.some((c) => c.route === '/api/vault/reveal-key'), false, 'Touch ID was asked of a password wallet');
  assert.equal(flow(world).dataset.step, 'key');
  assert.deepEqual(keyText(world), GROUPS);
});

/* ---------- restore ---------- */

test('Restore takes 12 or 24 words, asks once more in place, and posts /api/vault/restore', async () => {
  const world = build({ vault: { backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  buttonNamed(recovery(world), 'Restore from a phrase').click();
  const panel = restoreFlow(world);
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
  const world = build({ vault: { backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  world.answer.restore = { ok: false, error: 'not backed up', code: 'not_backed_up' };
  buttonNamed(recovery(world), 'Restore from a phrase').click();
  const panel = restoreFlow(world);
  find(panel, 'textarea')[0].value = WORDS.join(' ');
  buttonNamed(panel, 'Restore').click();
  buttonNamed(panel, 'Restore').click();
  await flush();
  await flush();
  assert.ok(textOf(panel).some((t) => t.includes('not proven backed up')));
  assert.equal(find(panel, '.vault-confirm-text')[0].hidden, true, '"press Restore again" stayed under a refusal');
});

test('a password wallet can restore where this Mac has Touch ID, and only once its phrase is backed up', async () => {
  const guarded = build({ vault: { custody: 'software', backedUp: false } });
  const back = buttonNamed(recovery(guarded), 'Back up first');
  assert.ok(back && !back.hidden, 'a password wallet that is not backed up offers a restore that could lose it');
  back.click();
  assert.equal(flow(guarded).dataset.step, 'password', 'Back up first did not open the backup');

  const ready = build({ vault: { custody: 'software', backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  assert.equal(buttonNamed(recovery(ready), 'Restore from a phrase').hidden, false);
  assert.equal(buttonNamed(recovery(ready), 'Save an encrypted copy').hidden, false);

  const noTouch = build({ vault: { custody: 'software', backedUp: true, enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } } });
  assert.equal(buttonNamed(recovery(noTouch), 'Restore from a phrase').hidden, true, 'a restore offered where it cannot run');
  assert.equal(buttonNamed(recovery(noTouch), 'Restore from a key').hidden, true);
  assert.equal(buttonNamed(recovery(guarded), 'Restore from a key').hidden, true, 'a key restore offered over a password wallet that is not backed up');
});

/* A Touch ID wallet that is not backed up is guarded the same way, before anything is typed: a
   person used to type a whole key, press Restore twice, and only then read that it was refused. */
test('a Touch ID wallet that is not backed up offers Back up first, which goes to its backup row, before any key is typed', () => {
  for (const hasMnemonic of [true, false]) {
    const world = build({ vault: { hasMnemonic, backedUp: false } });
    const line = textOf(recovery(world));
    assert.ok(line.includes('Back up this wallet first, so restoring another one here never loses it.'), String(line));
    const back = buttonNamed(recovery(world), 'Back up first');
    assert.ok(back && !back.hidden, 'a restore that could lose this wallet was offered');
    assert.match(back.className, /btn-ghost/);
    assert.equal(buttonNamed(recovery(world), 'Restore from a key').hidden, true);
    const went: string[] = [];
    row(world, 'backup').scrollIntoView = () => went.push('scrolled');
    buttonNamed(row(world, 'backup'), 'Back it up').focus = () => went.push('focused');
    back.click();
    assert.deepEqual(went, ['scrolled', 'focused'], 'Back up first did not bring the backup row and its button');
    assert.equal(restoreFlow(world).hidden, true, 'a restore opened over an unbacked wallet');
    assert.equal(world.calls.some((c) => c.route === '/api/vault/reveal' || c.route === '/api/vault/reveal-key'), false, 'a Touch ID was asked before the row said why');
  }
});

test('Restore from a key takes the key the way the backup shows it, asks once more, and names the wallet it brought', async () => {
  const world = build({ vault: { hasMnemonic: false, backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  assert.ok(textOf(recovery(world)).includes('Your private key brings this wallet back on any Mac. Restoring here replaces the wallet on this Mac, behind Touch ID.'));
  // The backup this wallet has leads: its key button first and filled, the phrase quiet after it.
  const buttons = find(recovery(world), 'button').filter((b: Any) => !b.hidden).map((b: Any) => [b.textContent, /btn-ghost/.test(b.className) ? 'ghost' : 'quiet']);
  assert.deepEqual(buttons.slice(0, 2), [['Restore from a key', 'ghost'], ['Restore from a phrase', 'quiet']]);
  const phrased = build({ vault: { backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  assert.deepEqual(find(recovery(phrased), 'button').filter((b: Any) => !b.hidden).slice(0, 2).map((b: Any) => b.textContent), ['Restore from a phrase', 'Restore from a key']);
  buttonNamed(recovery(world), 'Restore from a key').click();
  const panel = restoreFlow(world);
  assert.equal(panel.dataset.step, 'restore-key');
  assert.ok(textOf(panel).includes('Private key'));
  const input = find(panel, 'textarea')[0];

  input.value = GROUPS.join(' ').slice(0, -1);
  buttonNamed(panel, 'Restore').click();
  assert.ok(textOf(panel).includes('That is 63 characters. A private key is 64.'), String(textOf(panel)));
  input.value = `zz${GROUPS.join('').slice(2)}`;
  buttonNamed(panel, 'Restore').click();
  assert.ok(textOf(panel).includes('Group 1 has a character a private key never uses. A key has only 0 to 9 and a to f.'));
  input.value = GROUPS.map((g, i) => (i === 5 ? 'e2ao' : g)).join(' ');
  buttonNamed(panel, 'Restore').click();
  assert.ok(textOf(panel).includes('Group 6 has a character a private key never uses. A key has only 0 to 9 and a to f.'));
  assert.equal(world.calls.some((c) => c.route === '/api/vault/restore'), false, 'a key that cannot be right was posted');

  // As written from the backup: 0x, upper case, the groups on two lines.
  input.value = `0X${GROUPS.slice(0, 8).join(' ').toUpperCase()}\n${GROUPS.slice(8).join(' ').toUpperCase()}`;
  input.dispatch('input');
  buttonNamed(panel, 'Restore').click();
  await flush();
  assert.equal(world.calls.some((c) => c.route === '/api/vault/restore'), false, 'one press replaced the wallet');
  assert.ok(textOf(panel).includes('This Mac will hold the wallet that key opens instead of the one it holds now. Nothing moves. Press Restore again to go ahead.'));
  buttonNamed(panel, 'Restore').click();
  await flush();
  await flush();
  const post = world.calls.find((c) => c.route === '/api/vault/restore');
  assert.ok(post, 'nothing was posted');
  assert.equal(post.key, '0x' + GROUPS.join(''), 'the key was not posted as 0x and 64 lower-case characters');
  assert.equal(post.mnemonic, undefined);
  assert.deepEqual(world.toasts, ['Restored. This Mac now holds the wallet 0x7d4e...0e1d.']);
  assert.equal(input.value, '', 'the key stayed in the field');
});

test('a key restore the backend refuses says why in the tab, in words for a key', async () => {
  const cases: Array<[Any, string]> = [
    [{ ok: false, error: 'a private key is 64 characters', code: 'bad_key' }, 'That key is not right. Check every character against your copy.'],
    [{ ok: false, error: 'already', code: 'same_wallet' }, 'This Mac already holds that wallet, and it opens. Nothing to restore.'],
    [{ ok: false, error: 'not backed up', code: 'not_backed_up' }, 'The wallet on this Mac is not proven backed up, so it cannot be replaced. Back up its private key first.'],
    [{ ok: false, error: 'cancelled', code: 'user_cancel' }, 'Touch ID was cancelled. Nothing changed.'],
    // What a service wrote for its logs is never the line.
    [{ ok: false, error: 'no user present', code: 'interaction_required' }, 'That did not finish, so nothing changed. Try again.'],
  ];
  for (const [answer, said] of cases) {
    const world = build({ vault: { hasMnemonic: false, backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
    world.answer.restoreKey = answer;
    buttonNamed(recovery(world), 'Restore from a key').click();
    const panel = restoreFlow(world);
    find(panel, 'textarea')[0].value = GROUPS.join('');
    buttonNamed(panel, 'Restore').click();
    buttonNamed(panel, 'Restore').click();
    await flush();
    await flush();
    assert.ok(textOf(panel).includes(said), `${answer.code}: ${String(textOf(panel))}`);
    // A cancel is the person's own choice: the quiet line, never the warning one.
    const line = find(panel, '.vault-error')[0];
    assert.equal(line.getAttribute('data-tone'), answer.code === 'user_cancel' ? 'quiet' : null, answer.code);
    // The refusal ends that press: the line that said to press again goes, and the next press asks first.
    const sure = find(panel, '.vault-confirm-text')[0];
    assert.equal(sure.hidden, true, `${answer.code}: "press Restore again" stayed under a refusal`);
    buttonNamed(panel, 'Restore').click();
    await flush();
    assert.equal(world.calls.filter((c) => c.route === '/api/vault/restore').length, 1, `${answer.code}: one press after a refusal posted again`);
  }
});

test('the encrypted copy is saved in place: the password in the row, and a full path asked for only when the app needs one', async () => {
  const world = build({ vault: { custody: 'software', backedUp: true, enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } } });
  buttonNamed(recovery(world), 'Save an encrypted copy').click();
  const panel = restoreFlow(world);
  assert.equal(panel.dataset.step, 'export');
  const password = find(panel, 'input[type="password"]')[0];
  const where = find(panel, 'input').find((i: Any) => i.name === 'backup-path') as Any;
  assert.equal(where.parentNode.hidden, true, 'a path field before the app asked for one');
  world.answer.exportAnswer = Object.assign(new Error('the backup path must be absolute'), { status: 400 });
  password.value = 'proof-password-1';
  find(panel, 'form')[0].dispatch('submit');
  await flush();
  await flush();
  assert.equal(world.calls.filter((c) => c.route === '/api/wallet/export')[0].path, undefined, 'a path was invented');
  assert.equal(where.parentNode.hidden, false, 'the app needed a place and the row did not ask');
  world.answer.exportAnswer = { ok: true, path: '/Users/x/Documents/Phosphor backup 2026-09-23.json' };
  password.value = 'proof-password-1';
  where.value = '/Users/x/Documents/Phosphor backup 2026-09-23.json';
  find(panel, 'form')[0].dispatch('submit');
  await flush();
  await flush();
  assert.equal(world.calls.filter((c) => c.route === '/api/wallet/export')[1].path, '/Users/x/Documents/Phosphor backup 2026-09-23.json');
  assert.ok(world.toasts.some((t) => t.includes('Encrypted copy saved to /Users/x/Documents/Phosphor backup 2026-09-23.json')));
  assert.equal(world.confirms.length, 0, 'a dialog over the window');
});

/* ---------- keys ---------- */

test('the Keys row says which binding is live in plain words, and the software case offers Touch ID', () => {
  const enclave = build();
  const custody = row(enclave, 'custody');
  const text = textOf(custody);
  assert.ok(text.includes('Touch ID'), 'the row does not say what opens the keys');
  assert.ok(text.includes(`Behind the Secure Enclave on this Mac. Touch ID or your Mac login password opens it. Made on ${day('Sep 14, 2026')}.`), JSON.stringify(text));
  // A key any app could ask to use is said by the card, with the step that changes it; where no
  // card can show (this build has no keychain home), a worry with nothing to do is not said.
  assert.equal(find(custody, '.vault-sub')[0].hidden, true, 'the row repeats the card as a threat');
  assert.doesNotMatch(JSON.stringify(text), /Bound to this Mac/);
  // Every release so far is signed and still binds the key to the Mac: the row follows the
  // binding, and a signature is never offered as the protection (the 0.10.13 audit).
  assert.doesNotMatch(JSON.stringify(text), /signed/i, 'the row ties the binding to a signature');
  assert.equal(buttonNamed(custody, 'Protect with Touch ID').hidden, true);

  // A Phosphor-only wallet keeps one quiet line for good, and its date is the day it became
  // Phosphor-only: that step makes a new key, and "Made on" would read as a new wallet.
  enclave.put({ vault: vaultState({ enclave: { attached: true, ready: true, capability: null, keyMadeAt: '2026-10-03T08:25:47.861Z', binding: 'app' } }) });
  assert.equal(find(custody, '.vault-sub')[0].hidden, false);
  assert.equal(find(custody, '.vault-sub')[0].textContent, 'Only Phosphor can open your wallet on this Mac. Older copies of the file still open the old way.');
  assert.ok(textOf(custody).includes(`Behind the Secure Enclave on this Mac. Touch ID or your Mac login password opens it. Phosphor-only since ${day('Oct 3, 2026')}.`), JSON.stringify(textOf(custody)));

  const software = build({ vault: { custody: 'software' } });
  const soft = row(software, 'custody');
  assert.ok(textOf(soft).includes('Locked with your password on this Mac. Use a long one.'));
  assert.ok(textOf(soft).includes('Password'));
  assert.equal(buttonNamed(soft, 'Protect with Touch ID').hidden, false);

  const noEnclave = build({ vault: { custody: 'software', enclave: { attached: true, ready: false, capability: { secureEnclave: false, biometry: 'none', canAuthenticate: false }, keyMadeAt: null, binding: null } } });
  const none = row(noEnclave, 'custody');
  assert.ok(textOf(none).includes('This Mac has no Secure Enclave.'));
  assert.equal(buttonNamed(none, 'Protect with Touch ID').hidden, true);
  // A demo makes no Touch ID wallet, on any build (audit1b AU1B-02), and says why in plain words.
  for (const keychainHome of [true, false]) {
    const demo = build({ vault: { custody: 'software', enclave: { attached: true, ready: false, capability: { secureEnclave: true, biometry: 'touchid', canAuthenticate: true, keychainHome }, keyMadeAt: null, binding: null } } });
    const demoRow = row(demo, 'custody');
    assert.ok(textOf(demoRow).includes('A demo keeps its wallet behind a password, so the wallets on this Mac stay as they are.'), JSON.stringify(textOf(demoRow)));
    assert.equal(buttonNamed(demoRow, 'Protect with Touch ID').hidden, true);
  }
  // No shell words on the page.
  assert.doesNotMatch(textOf(enclave.view).join(' ') + textOf(software.view).join(' '), /desktop shell|Developer ID|round trip/);
});

/* ---------- addresses ---------- */

test('the Addresses row is a network menu with the token list folded behind it, and Show the address opens the deposit card', async () => {
  const world = build();
  await flush();
  const card = row(world, 'addresses');
  assert.ok(card, 'no Addresses row');
  assert.ok(textOf(card).includes('Pick the network you will send from. The address is checked before it shows.'));

  const button = find(card, '.netsel')[0];
  assert.equal(button.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(find(button, '.netsel-name')[0].textContent, 'Ethereum');
  const options = find(card, '.netsel-option');
  assert.deepEqual(options.map((o: Any) => o.dataset.network), ['eth', 'base', 'arb', 'sol', 'near']);
  assert.deepEqual(options.map((o: Any) => o.getAttribute('aria-selected')), ['true', 'false', 'false', 'false', 'false']);

  // Folded: nothing drawn until the person asks.
  assert.equal(world.calls.some((c) => c.route === 'netpick.render'), false, 'the token list is drawn before anyone asked');
  const toggle = buttonNamed(card, 'Show tokens');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, 'Hide tokens');

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

  // Folded again, then a pick in the menu opens it for that network on its own.
  buttonNamed(card, 'Hide tokens').click();
  assert.equal(find(card, '.vault-fold-body')[0].hidden, true);
  button.click();
  menu.dispatch('click', { target: find(card, '.netsel-option')[0] });
  assert.equal(find(card, '.vault-fold-body')[0].hidden, false, 'a pick did not open the list');
  const last = world.calls.filter((c) => c.route === 'netpick.render').pop();
  assert.ok(last, 'the menu drew no list');
  assert.equal(last!.network, 'eth');
});

test('the wallet\'s own key on the network in the menu sits behind the developer switch; only the EVM one copies', async () => {
  const world = build();
  await flush();
  const card = row(world, 'addresses');
  buttonNamed(card, 'Show tokens').click();
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
  buttonNamed(row(locked, 'addresses'), 'Show tokens').click();
  const unverified = find(locked.view, '.vault-key')[0];
  assert.ok(textOf(unverified).some((t) => t.startsWith('Not verified yet.')));
  assert.equal(buttonNamed(unverified, 'Copy'), undefined, 'an unverified key offered Copy');
});

/* ---------- forget ---------- */

test('Forget waits for the backup: until the phrase is proven its way is Back up first, which opens the backup', () => {
  const world = build();
  const danger = row(world, 'danger');
  assert.equal(buttonNamed(danger, 'Forget this wallet'), undefined, 'Forget is offered while the app would refuse it');
  const first = buttonNamed(danger, 'Back up first');
  assert.ok(first && !first.hidden);
  assert.ok(!first.className.includes('btn-danger'));
  first.click();
  assert.ok(world.calls.some((c) => c.route === '/api/vault/reveal'), 'Back up first did not start the backup');
  assert.equal(find(danger, '.vault-confirm')[0].hidden, true, 'the forget step opened anyway');
});

/* A wallet with no phrase used to be offered Forget outright, and the app refused it every time,
   because nothing could prove its backup. Now its key can be proven, so it waits the same way. */
test('a wallet with no phrase waits for its key backup before Forget, and Back up first opens the key', async () => {
  const world = build({ vault: { hasMnemonic: false } });
  const danger = row(world, 'danger');
  assert.equal(buttonNamed(danger, 'Forget this wallet') === undefined, true, 'Forget is offered while the app would refuse it');
  assert.ok(textOf(danger).includes('Removes this wallet from this Mac. The app allows it once your private key is backed up, so nothing is lost.'));
  buttonNamed(danger, 'Back up first').click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/vault/reveal-key'), 'Back up first did not open the key');

  const proven = build({ vault: { hasMnemonic: false, backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  assert.equal(buttonNamed(row(proven, 'danger'), 'Forget this wallet').hidden, false);
  assert.ok(textOf(row(proven, 'danger')).includes('Removes this wallet from this Mac. Your private key brings it back, here or on any Mac.'));
});

test('Forget opens in place, is an outline until FORGET is typed, posts, shows a refusal in words, and Escape puts it away; none of it red', async () => {
  const world = build({ vault: { backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z' } });
  const danger = row(world, 'danger');
  const open = buttonNamed(danger, 'Forget this wallet');
  assert.ok(!open.className.includes('btn-danger'));
  const step = find(danger, '.vault-confirm')[0];
  assert.equal(step.hidden, true);
  open.click();
  assert.equal(step.hidden, false);
  // Escape, from the step or from anywhere on the page.
  assert.equal(world.key('Escape'), true);
  assert.equal(step.hidden, true, 'Escape did not close the forget step');
  open.click();
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
  assert.ok(textOf(danger).some((t) => t.startsWith('Refused: the recovery phrase is not proven backed up')));

  world.answer.forget = { ok: true };
  forget.click();
  await flush();
  await flush();
  assert.ok(world.calls.filter((c) => c.route === 'refresh').length >= 1);
  assert.ok(world.toasts.some((t) => t.includes('forgotten')));
  assert.equal(step.hidden, true, 'the step stayed open after the wallet was forgotten');
  // The disabled face is an outline in vault.css, never half a fill.
  assert.match(read('../../ui/design/vault.css'), /\.vault \.btn:disabled:not\(\[data-pending="true"\]\) \{[^}]*opacity: 1;[^}]*background: transparent;/);

  // No wallet, no row.
  const none = build({ vault: { custody: null } });
  assert.equal(row(none, 'danger').hidden, true);
});

/* ---------- the migration card ---------- */

test('a password wallet on a ready enclave gets the Touch ID card once at boot, dismissable', async () => {
  const world = build({ vault: { custody: 'software' } });
  assert.equal(world.migrate.hidden, false, 'no migration card at boot');
  const text = textOf(world.migrate);
  assert.ok(text.includes('Protect your keys with Touch ID'));
  assert.ok(text.some((t) => t.startsWith('Type your password once.')));
  assert.equal(find(world.migrate, 'input[type="password"]').length, 1);
  buttonNamed(world.migrate, 'Not now').click();
  assert.equal(world.migrate.hidden, true);
  world.put({ vault: vaultState({ custody: 'software' }) });
  assert.equal(world.migrate.hidden, true, 'the card came back after it was dismissed');

  // The Keys row keeps the button, and the form posts the password once.
  buttonNamed(row(world, 'custody'), 'Protect with Touch ID').click();
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

/* ---------- your wallet: binding an older key ---------- */

// A build whose vault service has its keychain home: the one place Bind is offered.
const HOME = { attached: true, ready: true, capability: { secureEnclave: true, biometry: 'touchid', canAuthenticate: true, keychainHome: true }, keyMadeAt: '2026-09-14T09:00:00.000Z' };
const keysRow = (world: World): Any => row(world, 'custody');
const bindCard = (world: World): Any => find(keysRow(world), '.vault-bind')[0];
const bindWords = (world: World): string[] => shown(find(bindCard(world), '.vault-text, .vault-sub, .vault-flow-title')).map((n: Any) => n.textContent);

/* One plain name for the step, Phosphor-only, on every line: never bind, keychain or marker. */
const jargon = /\b(bind|binding|bound|keychain|marker|enclave|blob|pin)\b/i;

test('Phosphor-only asks for the backup first: one sentence on why, and the way to it', () => {
  const world = build({ vault: { hasMnemonic: false, enclave: { ...HOME, binding: 'device' } } });
  const card = bindCard(world);
  assert.equal(card.hidden, false);
  assert.equal(card.getAttribute('data-step'), 'first');
  assert.deepEqual(bindWords(world), [
    'Phosphor-only access',
    'Back up your private key first. After this step only Phosphor can open your wallet on this Mac, so your copy is the way back if anything happens to this Mac.',
  ]);
  assert.equal(buttonNamed(card, 'Make it Phosphor-only').hidden, true, 'offered before the backup is proven');
  const first = buttonNamed(card, 'Back it up first');
  assert.equal(first.hidden, false);
  const backupRow = row(world, 'backup');
  const backItUp = buttonNamed(backupRow, 'Back it up');
  const went: string[] = [];
  backupRow.scrollIntoView = () => went.push('scrolled');
  backItUp.focus = () => went.push('focused');
  first.click();
  assert.deepEqual(went, ['scrolled', 'focused'], 'the backup row is brought into view with its button under the cursor');
  assert.equal(world.calls.some((c) => c.route === '/api/vault/bind'), false);
  assert.ok(!bindWords(world).some((t) => jargon.test(t)), String(bindWords(world)));
});

test('backed up, the card says what Phosphor-only gives, why the one touch, and what it does not reach; done, the tick pops', async () => {
  const world = build({ vault: { hasMnemonic: true, backedUp: true, backedUpAt: '2026-10-02T10:00:00.000Z', enclave: { ...HOME, binding: 'device' } } });
  const card = bindCard(world);
  assert.equal(card.getAttribute('data-step'), 'offer');
  assert.deepEqual(bindWords(world), [
    'Phosphor-only access',
    'Today any app on this Mac can ask to open your wallet, with its own Touch ID prompt. After this, only Phosphor can.',
    'One Touch ID checks that Phosphor opens your wallet the new way before anything changes.',
    'Copies of your wallet file saved before today, such as one in Time Machine, still open the old way.',
  ]);
  const go = buttonNamed(card, 'Make it Phosphor-only');
  assert.equal(go.hidden, false);
  assert.equal(go.getAttribute('data-pending-label'), 'Waiting for Touch ID');
  assert.doesNotMatch(go.className, /btn-primary/, 'the one green button belongs to Approve');
  go.click();
  await flush();
  assert.deepEqual(world.calls.filter((c) => c.route === '/api/vault/bind' || c.route === 'refresh').map((c) => c.route), ['/api/vault/bind', 'refresh']);
  world.put({ vault: vaultState({ hasMnemonic: true, backedUp: true, enclave: { ...HOME, binding: 'app' } }) });
  // The tick pops as the done line comes in (the attribute goes again after the spring).
  assert.equal(find(bindCard(world), '.vault-backup-line')[0].getAttribute('data-pop'), 'true', 'the tick did not pop');
  await flush();
  assert.equal(bindCard(world).getAttribute('data-step'), 'done');
  assert.deepEqual(bindWords(world), [
    'Phosphor-only. No other app on this Mac can open your wallet.',
    'Copies of your wallet file saved before today, such as one in Time Machine, still open the old way. Approve a Touch ID prompt only when you started it.',
  ]);
  const done = find(bindCard(world), '.vault-backup-line')[0];
  assert.equal(done.getAttribute('data-backed'), 'true', 'the done line wears the tick');
  assert.equal(find(bindCard(world), '.vault-actions')[0].hidden, true, 'an empty button row stayed under the done line');
  assert.equal((find(keysRow(world), '.vault-sub').find((p: Any) => p.textContent.startsWith('Only Phosphor can open')) as Any).hidden, true, 'said once, in the card');
  for (const words of bindWords(world)) assert.ok(!jargon.test(words), words);
});

test('a cancelled or refused Phosphor-only step says so in the card, the cancel quietly, and the button stays', async () => {
  const world = build({ vault: { backedUp: true, enclave: { ...HOME, binding: 'device' } } });
  world.answer.bind = { ok: false, code: 'user_cancel', error: 'Touch ID was cancelled. Nothing changed.' };
  buttonNamed(bindCard(world), 'Make it Phosphor-only').click();
  await flush();
  const error = find(bindCard(world), '.vault-error')[0];
  assert.equal(error.hidden, false);
  assert.equal(textOf(error).join(''), 'Touch ID was cancelled. Nothing changed.');
  assert.equal(error.getAttribute('data-tone'), 'quiet', 'a cancel was shown as a warning');
  assert.equal(buttonNamed(bindCard(world), 'Make it Phosphor-only').hidden, false);
  world.answer.bind = { ok: false, code: 'touch_waiting', error: 'A move is waiting for your Touch ID. Finish it, then try again.' };
  buttonNamed(bindCard(world), 'Make it Phosphor-only').click();
  await flush();
  assert.equal(textOf(find(bindCard(world), '.vault-error')[0]).join(''), 'A move is waiting for your Touch ID. Finish it, then try again.');
  assert.equal(find(bindCard(world), '.vault-error')[0].getAttribute('data-tone'), null, 'a refusal lost its warning');
  // What a service wrote for its logs never reaches the card.
  for (const raw of ['no user present', 'keychain key -25300', 'keyBlob names no vault key']) {
    world.answer.bind = { ok: false, code: 'a_code', error: raw };
    buttonNamed(bindCard(world), 'Make it Phosphor-only').click();
    await flush();
    assert.equal(textOf(find(bindCard(world), '.vault-error')[0]).join(''), 'That did not finish, so nothing changed. Try again.', raw);
  }
  assert.equal(world.calls.filter((c) => c.route === 'refresh').length, 0, 'nothing to refresh after a refusal');
});

test('the card is not offered where there is nothing to do, and a Phosphor-only wallet says so in its row', () => {
  for (const vault of [
    { enclave: { ...HOME, capability: { ...HOME.capability, keychainHome: false }, binding: 'device' }, backedUp: true },
    { custody: 'software', enclave: { ...HOME, binding: null }, backedUp: true },
    { state: 'locked', enclave: { ...HOME, binding: 'device' }, backedUp: true },
    { enclave: { ...HOME, binding: 'app' }, backedUp: true },
  ]) {
    const world = build({ vault });
    assert.equal(bindCard(world).hidden, true, JSON.stringify(vault));
  }
  const done = build({ vault: { enclave: { ...HOME, binding: 'app' } } });
  const sub = find(keysRow(done), '.vault-sub').find((p: Any) => p.textContent.startsWith('Only Phosphor can open')) as Any;
  assert.equal(sub.textContent, 'Only Phosphor can open your wallet on this Mac. Older copies of the file still open the old way.');
  assert.equal(sub.hidden, false);
});

/* ---------- every refusal, through the Vault's own lines ---------- */

/* Each code the backend can say (and every code the service and the relays can answer), as the
   backend says it, and again carrying the service's own log text: what reaches the page is a calm
   sentence, never a code, a status number or an OS phrase. */
test('every refusal the Vault can be handed reads as a sentence on the page, and no service text reaches it', async () => {
  const codes = [...new Set([...refusalCodes(), ...VAULT_REFUSAL_CODES])];
  const lineOf = (node: Any): string => textOf(node).join(' ');
  for (const code of codes) {
    for (const answer of [refusal(code), { ok: false, code, error: SERVICE_MESSAGE }]) {
      const world = build({ vault: { hasMnemonic: false, backedUp: true, backedUpAt: '2026-09-14T10:00:00.000Z', enclave: { ...HOME, binding: 'device' } } });
      world.answer.bind = answer;
      buttonNamed(bindCard(world), 'Make it Phosphor-only').click();
      await flush();
      const bindLine = lineOf(find(bindCard(world), '.vault-error')[0]);
      world.answer.restoreKey = answer;
      buttonNamed(recovery(world), 'Restore from a key').click();
      const panel = restoreFlow(world);
      find(panel, 'textarea')[0].value = GROUPS.join(' ');
      buttonNamed(panel, 'Restore').click();
      buttonNamed(panel, 'Restore').click();
      await flush();
      await flush();
      const restoreLine = lineOf(find(panel, '.vault-error')[0]);
      world.answer.revealKey = answer;
      buttonNamed(row(world, 'backup'), 'Show my key').click();
      await flush();
      const revealLine = textOf(flow(world)).join(' ');
      for (const [where, said] of [['the card', bindLine], ['the restore', restoreLine], ['the reveal', revealLine]] as Array<[string, string]>) {
        if (code === 'user_cancel' && where === 'the reveal') continue;
        assert.ok(said.length > 0, `${code}, ${where}: nothing was said`);
        assert.ok(!RAW.test(said), `${code}, ${where}: ${said}`);
        for (const part of SERVICE_MESSAGE.split('; ')) assert.ok(!said.includes(part), `${code}, ${where}: ${said}`);
      }
    }
  }
});
