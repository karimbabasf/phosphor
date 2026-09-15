// The first run's welcome, its field, and the create screen's facts.
//
// Every flow opens on the same welcome and only then on its own first screen.
// The create screen (Touch ID or password) says where the key is held in
// three plain lines, with the technical form behind the developer switch.
// The field behind the card is a canvas registered with the window's one
// motion loop, and closing the screen must leave nothing registered. Each is
// run for real over a small DOM, with the real motion loop and developer
// switch where the test is about them, and a recording stand-in for
// motion.dev where the test is about what was asked of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const MOTION = read('../../ui/design/motion.js');
const DEVMODE = read('../../ui/design/devmode.js');
const DEVMODE_CSS = read('../../ui/design/devmode.css');
const FIELD = read('../../ui/design/field.js');
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
    checked: false,
    type: '',
    name: '',
    value: '',
    inert: false,
    width: 0,
    height: 0,
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
    getBoundingClientRect: () => ({ left: 400, top: 100, width: 480, height: 600 }),
    querySelector(selector: string) { return find(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return find(node, selector); },
  };
  if (tagName === 'canvas') {
    node.getContext = () => ({
      calls: [] as string[],
      setTransform() {},
      clearRect() { this.calls.push('clear'); },
      beginPath() {},
      moveTo() {},
      bezierCurveTo() {},
      stroke() { this.calls.push('stroke'); },
    });
  }
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
    custody: null,
    state: 'no_wallet',
    enclave: { attached: true, ready: true, capability: { secureEnclave: true, biometry: 'touchid', canAuthenticate: true }, keyMadeAt: null, binding: 'device' },
    foreign: false,
    waiting: null,
    backedUp: false,
    backedUpAt: null,
    idleMinutes: 15,
    hasMnemonic: true,
  }, overrides);
}

const SOFTWARE = { enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } };

/* A stand-in for motion.dev that records every animate() and never finishes,
   so what a fast click leaves behind can be counted. */
function fakeMotion(calls: Any[]): Any {
  return {
    animate(target: Any, keyframes: Any, options: Any) {
      const run: Any = { target, keyframes, options: options ?? {}, stopped: false, finished: new Promise(() => {}) };
      run.stop = () => { run.stopped = true; };
      calls.push(run);
      return run;
    },
    stagger(gap: number, opts: Any) {
      const fn: Any = (i: number) => (opts?.startDelay ?? 0) + gap * i;
      fn.stagger = { gap, startDelay: opts?.startDelay ?? 0 };
      return fn;
    },
  };
}

type World = {
  sandbox: Any;
  nodes: Record<string, Any>;
  calls: Any[];
  frames: Array<(now: number) => void>;
  animations: Any[];
};

type Options = { motion?: 'real' | 'none'; devmode?: boolean; field?: boolean; fakeMotion?: boolean; reduced?: boolean; netpick?: boolean };

function build(state: Any, opts: Options = {}): World {
  const nodes: Record<string, Any> = {};
  for (const id of ['screen-firstrun', 'page']) nodes[id] = makeNode('div');
  const body = makeNode('body');
  const root = makeNode('html');
  const calls: Any[] = [];
  const frames: Array<(now: number) => void> = [];
  const animations: Any[] = [];
  const storage: Record<string, string> = {};

  const doc: Any = {
    body,
    documentElement: root,
    createElement: makeNode,
    getElementById: (id: string) => nodes[id] ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  let rafId = 0;
  const sandbox: Any = {
    console,
    document: doc,
    performance,
    Promise,
    localStorage: { getItem: (k: string) => (k in storage ? storage[k] : null), setItem: (k: string, v: string) => { storage[k] = v; } },
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn: (now: number) => void) => { frames.push(fn); rafId += 1; return rafId; },
    cancelAnimationFrame() {},
  };
  sandbox.window = sandbox;
  sandbox.PhosphorNet = { readable: (e: Any) => String(e && e.message ? e.message : e) };
  if (opts.motion !== 'real') sandbox.PhosphorMotion = { reduced: () => opts.reduced === true };
  if (opts.fakeMotion) sandbox.Motion = fakeMotion(animations);
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean, label: string) { button.disabled = !!pending; button.pendingLabel = pending ? label : ''; },
    refresh: () => { calls.push({ route: 'refresh' }); return Promise.resolve(); },
    setView: (name: string) => { calls.push({ route: 'setView', view: name }); },
  };
  sandbox.PhosphorToast = { show() {} };
  sandbox.PhosphorMoneyIn = { render: (host: Any) => { calls.push({ route: 'moneyin.render' }); host.appendChild(makeNode('div')); } };
  if (opts.netpick) {
    sandbox.PhosphorNetPick = {
      render: (host: Any, options: Any) => {
        calls.push({ route: 'netpick.render', options });
        host.appendChild(makeNode('div'));
        return { destroy: () => { calls.push({ route: 'netpick.destroy' }); } };
      },
    };
  }
  sandbox.PhosphorApi = {
    vaultCreate: () => { calls.push({ route: '/api/vault/create' }); return Promise.resolve({ ok: true, addresses: { evm: '0xabc' } }); },
    vaultRestore: () => Promise.resolve({ ok: true, addresses: {} }),
    walletCreate: (password: string) => { calls.push({ route: '/api/wallet/create', password }); return Promise.resolve({ ok: true, mnemonic: [], addresses: {} }); },
    walletImport: () => Promise.resolve({ ok: true, addresses: {} }),
    connection: () => Promise.resolve({ missing: true }),
    driver: () => Promise.resolve({}),
  };

  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  if (opts.motion === 'real') runInContext(MOTION, sandbox, { filename: 'ui/design/motion.js' });
  if (opts.devmode) runInContext(DEVMODE, sandbox, { filename: 'ui/design/devmode.js' });
  if (opts.field) runInContext(FIELD, sandbox, { filename: 'ui/design/field.js' });
  runInContext(FIRSTRUN, sandbox, { filename: 'ui/screens/firstrun.js' });

  sandbox.PhosphorState.put(state);
  sandbox.PhosphorFirstRun.boot();
  return { sandbox, nodes, calls, frames, animations };
}

const firstRun = (vault: Any, opts: Options = {}): World =>
  build({ lock: { state: vault.foreign ? 'locked' : 'no_wallet', idleLocksInSec: null }, vault: vaultState(vault) }, opts);

/* ---------- the welcome ---------- */

test('every flow opens on the welcome, and Get started goes to that flow\'s own first step', () => {
  const flows: Array<[string, Any, string, number]> = [
    ['enclave', {}, 'Create your wallet', 3],
    ['software', SOFTWARE, 'Create or bring a wallet', 9],
    ['foreign', { foreign: true }, 'Made on another Mac', 3],
  ];
  for (const [name, vault, firstTitle, count] of flows) {
    const world = firstRun(vault);
    world.sandbox.PhosphorFirstRun.open();
    const screen = world.nodes['screen-firstrun'];
    const words = textOf(screen);
    assert.ok(words.includes('Welcome to Phosphor'), `${name}: no welcome`);
    assert.ok(words.some((t) => t.startsWith('Your money stays on this Mac')), `${name}: no welcome line`);
    assert.equal(find(screen, '.firstrun-mark').length, 1, `${name}: no mark on the welcome`);
    assert.equal(find(screen, '.screen-progress').length, 0, `${name}: a progress bar on the welcome`);
    const buttons = find(screen, 'button');
    assert.equal(buttons.length, 1, `${name}: the welcome has more than one button`);
    assert.equal(buttons[0].textContent, 'Get started');
    // The card is the dialog and takes the focus on the welcome, so the button
    // opens without a ring on it; Tab reaches it first.
    const card = find(screen, '.screen-card')[0];
    assert.equal(card.getAttribute('role'), 'dialog', `${name}: the card is not a dialog`);
    assert.equal(card.getAttribute('aria-modal'), 'true');
    assert.equal(card.getAttribute('tabindex'), '-1');
    assert.equal(card.focused, true, `${name}: the card did not take the focus on the welcome`);
    assert.notEqual(buttons[0].focused, true, `${name}: Get started took the focus on the welcome`);
    assert.equal(find(screen, 'h1')[0].id, 'firstrun-title', `${name}: the title is not what labels the dialog`);
    assert.equal(card.getAttribute('aria-labelledby'), 'firstrun-title');

    buttons[0].click();
    assert.equal(find(screen, 'h1')[0].id, 'firstrun-title', `${name}: the next title does not label the dialog`);
    assert.ok(textOf(screen).includes(firstTitle), `${name}: Get started did not reach ${firstTitle}`);
    assert.equal(find(screen, '.firstrun-mark').length, 0, `${name}: the mark is repeated after the welcome`);
    const progress = find(screen, '.screen-progress');
    assert.equal(progress.length, 1, `${name}: no progress after the welcome`);
    assert.ok(textOf(progress[0]).includes(`Step 1 of ${count}`), `${name}: the count is not Step 1 of ${count}`);
    const segments = find(progress[0], '.screen-progress-seg');
    assert.equal(segments.length, count, `${name}: one segment per step`);
    assert.equal(segments.filter((s: Any) => s.dataset.done === 'true').length, 1, `${name}: exactly the first segment is filled`);
  }
});

test('the create screen says where the key is held in three lines, and the technical form waits for the developer switch', () => {
  const cases: Array<[string, Any, string]> = [
    ['enclave', {}, 'Locked by this Mac\'s Secure Enclave.'],
    ['software', SOFTWARE, 'Locked by your password.'],
  ];
  for (const [name, vault, lockLine] of cases) {
    const world = firstRun(vault, { devmode: true });
    world.sandbox.PhosphorFirstRun.open();
    const screen = world.nodes['screen-firstrun'];
    buttonNamed(screen, 'Get started').click();
    if (name === 'software') buttonNamed(screen, 'Continue').click();

    const leads = find(screen, '.firstrun-fact-lead').map((n: Any) => n.textContent);
    assert.deepEqual(leads, ['Made and kept on this Mac.', lockLine, 'Your assistant never sees the key.'], `${name}: the three facts`);
    const facts = find(screen, '.firstrun-fact');
    assert.equal(facts.length, 3);
    assert.ok(facts[0].textContent.endsWith('Nothing is uploaded, and there is no account to make.'));

    // The switch is the shared control, off, and the list is marked for it.
    const control = find(screen, '.dev-switch');
    assert.equal(control.length, 1, `${name}: no developer switch`);
    assert.equal(find(control[0], '.dev-switch-label')[0].textContent, 'Show the technical details');
    const details = find(screen, '[data-dev-only]');
    assert.equal(details.length, 1, `${name}: the technical list is not marked data-dev-only`);
    assert.equal(world.sandbox.document.documentElement.dataset.developer, 'false', `${name}: the switch is on before anyone touched it`);
    const lines = find(details[0], '.firstrun-dev-line').map((n: Any) => n.textContent);
    assert.equal(lines.length, 4, `${name}: the technical list is not four lines`);
    assert.ok(lines[0].includes('keys.enc.json') && lines[0].includes('0600') && lines[0].includes('~/.phosphor/'));
    assert.ok(lines[1].includes('AES-256-GCM') && lines[1].includes('AAD') && lines[1].includes('scrypt'));
    assert.ok(lines[2].includes('P-256') && lines[2].includes('CryptoKit'));
    assert.ok(lines[3].includes('MCP') && lines[3].includes('mcp__phosphor__*'));
    const mono = find(details[0], 'code.mono').map((n: Any) => n.textContent);
    for (const name2 of ['keys.enc.json', '~/.phosphor/', '0600', 'AES-256-GCM', 'scrypt', 'P-256', 'mcp__phosphor__*']) {
      assert.ok(mono.includes(name2), `${name}: ${name2} is not set in the mono face`);
    }

    // On: from the switch itself, or from anywhere that flips the mode.
    const box = find(control[0], 'input')[0];
    box.checked = true;
    box.dispatch('change');
    assert.equal(world.sandbox.document.documentElement.dataset.developer, 'true', `${name}: the switch did not turn the mode on`);
    world.sandbox.PhosphorDev.set(false);
    assert.equal(world.sandbox.document.documentElement.dataset.developer, 'false');
    assert.equal(box.checked, false, `${name}: the switch did not follow the mode`);
    world.sandbox.PhosphorDev.set(true);
    assert.equal(world.sandbox.document.documentElement.dataset.developer, 'true');

    // The developer switch is never the thing the cursor lands on.
    assert.notEqual(box.focused, true, `${name}: the developer switch took the focus`);
  }
  // The stylesheet is what hides the list: the pair of rules the mark relies on.
  assert.ok(/\[data-dev-only\]\s*\{\s*display:\s*none/.test(DEVMODE_CSS), 'devmode.css does not hide data-dev-only');
  assert.ok(/:root\[data-developer="true"\]\s*\[data-dev-only\]\s*\{\s*display:\s*revert/.test(DEVMODE_CSS), 'devmode.css does not show data-dev-only for developers');
});

test('the password screen keeps its mechanics: two fields, eight characters, a match, then the wallet is made', async () => {
  const world = firstRun(SOFTWARE, { devmode: true });
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  buttonNamed(screen, 'Get started').click();
  buttonNamed(screen, 'Continue').click();
  assert.ok(textOf(screen).includes('Set a password'));
  const fields = find(screen, 'input.input');
  assert.equal(fields.length, 2, 'the password screen does not have exactly two fields');
  assert.equal(fields[0].focused, true, 'the first field did not take the focus');
  fields[0].value = 'short';
  fields[1].value = 'short';
  buttonNamed(screen, 'Continue').click();
  assert.ok(textOf(screen).includes('Use at least eight characters.'));
  fields[0].value = 'longenough';
  fields[1].value = 'different1';
  buttonNamed(screen, 'Continue').click();
  assert.ok(textOf(screen).includes('The two passwords do not match.'));
  fields[1].value = 'longenough';
  buttonNamed(screen, 'Continue').click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/wallet/create' && c.password === 'longenough'));
  assert.ok(textOf(screen).includes('Save your recovery words'));
});

/* ---------- the field ---------- */

test('opening registers the field with the motion loop, and close() leaves no loop registered', () => {
  const world = firstRun({}, { motion: 'real', field: true });
  const motion = world.sandbox.PhosphorMotion;
  assert.equal(motion.handles().length, 0);
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  const canvases = find(screen, 'canvas');
  assert.equal(canvases.length, 1, 'no field canvas under the card');
  assert.equal(canvases[0].getAttribute('aria-hidden'), 'true');
  assert.equal(screen.childNodes.indexOf(canvases[0]) < screen.childNodes.indexOf(find(screen, '.screen-card')[0]), true, 'the canvas is not under the card');
  assert.equal(motion.handles().length, 1, 'the field did not register with the motion loop');
  assert.equal(world.nodes.page.inert, true);
  assert.equal(world.sandbox.document.body.getAttribute('data-firstrun'), 'true');

  // One frame paints it: the loop asked for a frame, and the frame strokes.
  assert.ok(world.frames.length > 0, 'the loop never asked for a frame');
  const ctx = canvases[0].getContext();
  const tick = world.frames.shift() as (now: number) => void;
  tick(performance.now());
  assert.ok(motion.handles()[0].stats().frames >= 1, 'the field did not paint');
  assert.ok(ctx !== null);

  world.sandbox.PhosphorFirstRun.close();
  assert.equal(motion.handles().length, 0, 'a motion loop was left registered after close()');
  assert.equal(find(screen, 'canvas').length, 0, 'the canvas was left in the screen');
  assert.equal(screen.hidden, true);
  assert.equal(world.nodes.page.inert, false);
  assert.equal(world.sandbox.document.body.getAttribute('data-firstrun'), null);
  assert.equal(world.sandbox.document.body.getAttribute('data-locked'), null);

  // Open again: exactly one loop, never two.
  world.sandbox.PhosphorFirstRun.open();
  assert.equal(motion.handles().length, 1);
  world.sandbox.PhosphorFirstRun.close();
  assert.equal(motion.handles().length, 0);
});

/* ---------- the moments ---------- */

test('the welcome plays its entrance once, after the field, and a fast click through never stacks bodies', () => {
  const world = firstRun(SOFTWARE, { fakeMotion: true, field: true, motion: 'real' });
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  const shell = find(screen, '.screen-card')[0];

  // The field fades up over 600 ms; the four pieces of the welcome follow,
  // staggered, lifting and clearing from a blur, each 400 ms.
  const fieldRun = world.animations.find((a) => a.target.tagName === 'CANVAS');
  assert.ok(fieldRun, 'the field did not fade in');
  assert.equal(fieldRun.options.duration, 0.6);
  const welcomeRun = world.animations.find((a) => Array.isArray(a.target));
  assert.ok(welcomeRun, 'the welcome pieces were not animated');
  assert.equal(welcomeRun.target.length, 4, 'the welcome animates the mark, the title, the line and the button');
  assert.equal(JSON.stringify(welcomeRun.keyframes.y), '[12,0]');
  assert.equal(JSON.stringify(welcomeRun.keyframes.filter), '["blur(6px)","blur(0px)"]');
  assert.equal(welcomeRun.options.duration, 0.4);
  assert.equal(JSON.stringify(welcomeRun.options.ease), '[0.16,1,0.3,1]');
  const stagger = welcomeRun.options.delay;
  assert.equal(typeof stagger, 'function', 'the pieces are not staggered');
  assert.ok(stagger.stagger.startDelay + stagger.stagger.gap * 3 + 0.4 < 1.2, 'the welcome takes longer than 1.2 s');
  assert.ok(stagger.stagger.startDelay >= 0.4, 'the pieces arrive before the field is up');

  // Three fast steps: choose, then Back twice to the welcome. Never more than
  // one leaving body, the live body is never a ghost, and the welcome moment
  // is not played again.
  buttonNamed(screen, 'Get started').click();
  const ghostsAfterOne = find(shell, '.screen-body-ghost');
  assert.equal(ghostsAfterOne.length, 1, 'the leaving body is not fading out');
  assert.equal(ghostsAfterOne[0].getAttribute('aria-hidden'), 'true');
  assert.equal(shell.getAttribute('data-swapping'), 'true');
  buttonNamed(screen, 'Back').click();
  buttonNamed(screen, 'Get started').click();
  const ghosts = find(shell, '.screen-body-ghost');
  assert.equal(ghosts.length, 1, 'leaving bodies stacked up');
  assert.equal(ghostsAfterOne[0].parentNode, null, 'the first leaving body was not thrown away by the next click');
  const live = find(shell, '.screen-body').filter((b: Any) => !String(b.className).includes('screen-body-ghost'));
  assert.equal(live.length, 1, 'more than one live body');
  assert.ok(textOf(live[0]).includes('Create or bring a wallet'));
  assert.equal(find(live[0], 'button').some((b: Any) => b.focused), true, 'the live body did not take the focus');
  const entrances = world.animations.filter((a) => a.keyframes.y && a.keyframes.y[0] === 8);
  assert.equal(entrances.length, 3, 'one entrance per step change');
  assert.equal(entrances[0].stopped, true, 'the interrupted entrance was not stopped');
  assert.equal(entrances[1].stopped, true);
  assert.equal(entrances[2].stopped, false);
  const welcomes = world.animations.filter((a) => Array.isArray(a.target));
  assert.equal(welcomes.length, 1, 'the welcome moment played again on Back');

  // Closing stops everything that was still running and drops the ghost.
  world.sandbox.PhosphorFirstRun.close();
  assert.equal(find(shell, '.screen-body-ghost').length, 0, 'a ghost survived close()');
  assert.equal(entrances[2].stopped, true, 'the running entrance was not stopped on close()');
  assert.equal(world.sandbox.PhosphorMotion.handles().length, 0);
});

test('under reduced motion the welcome shows at once, opacity only', () => {
  const world = firstRun({}, { fakeMotion: true, reduced: true });
  world.sandbox.PhosphorFirstRun.open();
  const welcomeRun = world.animations.find((a) => Array.isArray(a.target));
  assert.ok(welcomeRun);
  assert.deepEqual(Object.keys(welcomeRun.keyframes), ['opacity']);
  assert.equal(welcomeRun.options.delay, undefined, 'the pieces are staggered under reduced motion');
  buttonNamed(world.nodes['screen-firstrun'], 'Get started').click();
  const ghost = world.animations.find((a) => a.keyframes.opacity === 0);
  assert.ok(ghost, 'no exit');
  assert.equal(ghost.keyframes.y, undefined, 'the exit lifts under reduced motion');
});

/* ---------- the addresses ---------- */

test('the addresses step uses the network picker when the window has one, and takes it down on the way out', async () => {
  const world = firstRun({}, { netpick: true });
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  buttonNamed(screen, 'Get started').click();
  buttonNamed(screen, 'Create wallet').click();
  await flush();
  assert.ok(textOf(screen).includes('Your addresses'));
  const rendered = world.calls.find((c) => c.route === 'netpick.render');
  assert.ok(rendered, 'the picker was not used');
  assert.equal(JSON.stringify(rendered.options), '{"context":"firstrun"}');
  assert.equal(world.calls.some((c) => c.route === 'moneyin.render'), false, 'the plain address list was drawn beside the picker');
  buttonNamed(screen, 'Continue').click();
  assert.ok(world.calls.some((c) => c.route === 'netpick.destroy'), 'the picker was not taken down');
  assert.ok(textOf(screen).includes('Connect your assistant'));
});

test('without the picker the addresses step falls back to the plain address list', async () => {
  const world = firstRun({});
  world.sandbox.PhosphorFirstRun.open();
  const screen = world.nodes['screen-firstrun'];
  buttonNamed(screen, 'Get started').click();
  buttonNamed(screen, 'Create wallet').click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === 'moneyin.render'));
});
