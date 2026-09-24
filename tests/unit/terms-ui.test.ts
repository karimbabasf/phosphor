// The terms of use: accepted before anything else, gone on the app's word and not on the click,
// and back once for a newer version of the terms.
//
// Where they are drawn depends on who is reading. A person with no wallet meets them as the
// first run's own step after the welcome (tests/unit/firstrun-welcome-ui.test.ts walks that
// step), so the lock opens the first run and the card stays down. Over a wallet that already
// exists the card is up before the lock, the lock hides itself, and when the card goes it is the
// lock that decides what comes next. Run for real over a small DOM with the real store and the
// real lock screen, so the hand-off between the two screens is the one the window makes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const LINKS = read('../../ui/core/links.js');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const TERMS = read('../../ui/screens/terms.js');
const LOCK = read('../../ui/screens/lock.js');

/* ---------- a DOM small enough to read ---------- */

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(event: Any) => void>> = {};
  let ownText = '';
  const node: Any = {
    tagName: tagName.toUpperCase(),
    className: '',
    id: '',
    hidden: false,
    disabled: false,
    inert: false,
    style: {},
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
    appendChild(child: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child: Any) {
      const at = node.childNodes.indexOf(child);
      if (at >= 0) node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name: string, value: string) { attrs[name] = String(value); },
    getAttribute(name: string) { return name in attrs ? attrs[name] : null; },
    hasAttribute(name: string) { return name in attrs; },
    removeAttribute(name: string) { delete attrs[name]; },
    addEventListener(type: string, fn: (event: Any) => void) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    click() { for (const fn of listeners.click ?? []) fn({ target: node, preventDefault() {} }); },
    focus() { node.focused = true; },
    querySelector(selector: string) { return find(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return find(node, selector); },
  };
  return node;
}

function matches(node: Any, selector: string): boolean {
  const m = /^([a-z][a-z0-9]*)?((?:\.[\w-]+)*)$/i.exec(selector.trim());
  if (!m) return false;
  const [, tag, classes] = m;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const cls of classes.split('.').filter(Boolean)) {
    if (!String(node.className).split(' ').includes(cls)) return false;
  }
  return true;
}

function find(root: Any, selector: string): Any[] {
  const out: Any[] = [];
  const walk = (n: Any): void => {
    for (const child of n.childNodes) {
      if (matches(child, selector)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- the window ---------- */

type World = { sandbox: Any; nodes: Record<string, Any>; body: Any; calls: Any[]; answer: (value: Any) => void };

function termsSlice(accepted: boolean): Any {
  return {
    version: '2026-09-17',
    acceptedVersion: accepted ? '2026-09-17' : null,
    acceptedAt: accepted ? '2026-09-18T12:00:00.000Z' : null,
    accepted,
    urls: { terms: 'https://phosphor.money/terms/', privacy: 'https://phosphor.money/privacy/' },
  };
}

function build(state: Any, opts: { lock?: boolean } = {}): World {
  const nodes: Record<string, Any> = {};
  for (const id of ['screen-terms', 'screen-lock', 'screen-firstrun', 'page']) nodes[id] = makeNode('div');
  const body = makeNode('body');
  const calls: Any[] = [];
  let answer: (value: Any) => void = () => {};
  const doc: Any = {
    body,
    documentElement: makeNode('html'),
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
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.PhosphorNet = { readable: (e: Any) => String(e && e.message ? e.message : e) };
  sandbox.PhosphorMotion = { reduced: () => true };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean, label: string) { button.disabled = !!pending; button.pendingLabel = pending ? label : ''; },
    refresh: () => Promise.resolve(),
  };
  sandbox.PhosphorFirstRun = {
    boot() {},
    open() { calls.push({ route: 'firstrun.open' }); },
    strengthWords: () => '',
  };
  sandbox.PhosphorApi = {
    termsAccept: () => {
      calls.push({ route: '/api/terms/accept' });
      return new Promise((resolve) => { answer = resolve; });
    },
    vaultStatus: () => Promise.resolve({}),
  };

  createContext(sandbox);
  runInContext(LINKS, sandbox, { filename: 'ui/core/links.js' });
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(TERMS, sandbox, { filename: 'ui/screens/terms.js' });
  if (opts.lock !== false) runInContext(LOCK, sandbox, { filename: 'ui/screens/lock.js' });

  sandbox.PhosphorState.put(state);
  sandbox.PhosphorTerms.boot();
  if (opts.lock !== false) sandbox.PhosphorLock.boot();
  return { sandbox, nodes, body, calls, answer: (value) => answer(value) };
}

const noWallet = (terms: Any | undefined): Any => ({ lock: { state: 'no_wallet', idleLocksInSec: null }, vault: { custody: null, state: 'no_wallet', enclave: { ready: true }, foreign: false }, terms });
const madeWallet = (terms: Any | undefined): Any => ({ lock: { state: 'locked', idleLocksInSec: null }, vault: { custody: 'software', state: 'locked', enclave: { ready: false }, foreign: false }, terms });

/* ---------- a person with no wallet ---------- */

test('with no wallet yet the terms are the first run\'s step: the card stays down and the lock opens the first run, whose welcome comes first', () => {
  const world = build(noWallet(termsSlice(false)));
  assert.equal(world.nodes['screen-terms'].hidden, true, 'the card opened ahead of the welcome');
  assert.equal(world.body.hasAttribute('data-terms'), false);
  assert.ok(world.calls.some((c) => c.route === 'firstrun.open'), 'the lock did not open the first run');
  assert.equal(world.sandbox.PhosphorTerms.firstRunOwns(world.sandbox.PhosphorState.get()), true);
  assert.equal(world.sandbox.PhosphorTerms.required(world.sandbox.PhosphorState.get()), true, 'the terms stopped being required');
});

test('the first run draws the terms through content() and accepts them through accept(): the same words, one write, the answer in the store', async () => {
  const world = build(noWallet(termsSlice(false)));
  const body = makeNode('div');
  const note = world.sandbox.PhosphorTerms.content(body);
  assert.equal(find(body, '.terms-fact').length, 4, 'four facts');
  assert.deepEqual(find(body, 'a').map((a) => [a.textContent, a.href ?? null, a.getAttribute('target')]), [
    ['Terms of use', 'https://phosphor.money/terms/', '_blank'],
    ['Privacy page', 'https://phosphor.money/privacy/', '_blank'],
  ]);
  assert.ok(note.textContent.includes('dated 2026-09-17'), 'the note does not name the version');
  const done = world.sandbox.PhosphorTerms.accept();
  assert.equal(world.calls.filter((c) => c.route === '/api/terms/accept').length, 1);
  world.answer({ ok: true, ...termsSlice(true) });
  const answer = await done;
  assert.equal(answer.ok, true);
  assert.equal(world.sandbox.PhosphorState.get().terms.accepted, true, 'the store did not learn the answer');

  const refused = build(noWallet(termsSlice(false)));
  const later = refused.sandbox.PhosphorTerms.accept();
  refused.answer({ error: 'the window token is missing or wrong' });
  assert.deepEqual({ ...(await later) }, { ok: false, reason: 'the window token is missing or wrong' });
});

/* ---------- over a wallet that already exists ---------- */

test('over a wallet that exists, the card is up before anything else, with the mark over it, and the lock stands down', () => {
  const world = build(madeWallet(termsSlice(false)));
  const screen = world.nodes['screen-terms'];
  assert.equal(screen.hidden, false, 'the card is not shown');
  assert.equal(world.nodes['screen-lock'].hidden, true, 'the lock screen is up beside the card');
  assert.deepEqual(world.calls.filter((c) => c.route === 'firstrun.open'), [], 'the first run opened under the terms');
  assert.equal(world.body.getAttribute('data-terms'), 'true');
  assert.equal(world.body.getAttribute('data-locked'), 'true');
  assert.equal(world.nodes.page.inert, true, 'the page behind is reachable');
  assert.equal(world.nodes.page.getAttribute('aria-hidden'), 'true');

  const card = find(screen, '.screen-card')[0];
  assert.ok(card, 'no card');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'true');
  assert.equal(card.getAttribute('aria-labelledby'), 'terms-title');
  assert.equal(card.focused, true, 'the card did not take the focus');
  assert.equal(find(screen, '.terms-mark').length, 1, 'no mark over the card');
  assert.equal(find(screen, 'h1')[0].id, 'terms-title');
  assert.equal(find(screen, 'h1')[0].textContent, 'Before you start');
  assert.equal(find(screen, '.terms-fact').length, 4, 'four facts');

  const links = find(screen, 'a');
  // The href is written by ui/core/links.js, as a property, the way the rest of the window's
  // links are; the stub below does not reflect a property onto its attribute the way a real
  // anchor does, so the destination is read off the property here.
  assert.deepEqual(links.map((a) => [a.textContent, a.href ?? null, a.getAttribute('target'), a.getAttribute('rel')]), [
    ['Terms of use', 'https://phosphor.money/terms/', '_blank', 'noopener'],
    ['Privacy page', 'https://phosphor.money/privacy/', '_blank', 'noopener'],
  ]);
  const buttons = find(screen, 'button');
  assert.equal(buttons.length, 1, 'one button');
  assert.equal(buttons[0].textContent, 'Accept and continue');
  assert.ok(find(screen, '.terms-note')[0].textContent.includes('dated 2026-09-17'), 'the note does not name the version');
});

test('accepting is one write, the card waits for the app, and the lock takes over when the state says accepted', async () => {
  const world = build(madeWallet(termsSlice(false)));
  const screen = world.nodes['screen-terms'];
  const button = find(screen, 'button')[0];
  button.click();
  assert.equal(world.calls.filter((c) => c.route === '/api/terms/accept').length, 1);
  assert.equal(button.disabled, true, 'the button is still live while the app answers');
  button.click();
  assert.equal(world.calls.filter((c) => c.route === '/api/terms/accept').length, 1, 'a second click made a second write');
  assert.equal(screen.hidden, false, 'the card left on the click, before the app answered');

  world.answer({ ok: true, ...termsSlice(true) });
  await flush();
  assert.equal(screen.hidden, true, 'the card is still up after the app said accepted');
  assert.equal(screen.childNodes.length, 0, 'the card left its nodes behind');
  assert.equal(world.body.hasAttribute('data-terms'), false);
  assert.equal(world.sandbox.PhosphorState.get().terms.accepted, true, 'the store did not learn the answer');
  // The lock decided what comes next: a locked wallet, so the lock screen.
  assert.equal(world.nodes['screen-lock'].hidden, false, 'the lock did not take over');
});

test('a write the app refuses leaves the card up with the reason, and the button live again', async () => {
  const world = build(madeWallet(termsSlice(false)));
  const screen = world.nodes['screen-terms'];
  const button = find(screen, 'button')[0];
  button.click();
  world.answer({ error: 'the window token is missing or wrong' });
  await flush();
  assert.equal(screen.hidden, false);
  assert.equal(button.disabled, false, 'the button stayed down after a refusal');
  assert.equal(find(screen, '.terms-note')[0].textContent, 'the window token is missing or wrong');
  assert.equal(world.nodes['screen-lock'].hidden, true, 'the lock came up on a refusal');
});

test('with the terms accepted, or on a backend that has no terms slice, nothing opens and the lock runs as before', () => {
  for (const terms of [termsSlice(true), undefined]) {
    const world = build(noWallet(terms));
    assert.equal(world.nodes['screen-terms'].hidden, true, 'the card opened');
    assert.equal(world.body.hasAttribute('data-terms'), false);
    assert.ok(world.calls.some((c) => c.route === 'firstrun.open'), 'the lock did not open the first run');
  }
});

test('a newer version of the terms brings the card back once, over a wallet that is already made', () => {
  const made = madeWallet(termsSlice(true));
  const world = build(made);
  assert.equal(world.nodes['screen-terms'].hidden, true);
  assert.equal(world.nodes['screen-lock'].hidden, false, 'the lock did not run as usual on accepted terms');
  const newer = { ...termsSlice(false), acceptedVersion: '2026-09-17', version: '2027-01-01' };
  world.sandbox.PhosphorState.put({ ...made, terms: newer });
  assert.equal(world.nodes['screen-terms'].hidden, false, 'the newer terms did not bring the card back');
  assert.equal(world.body.getAttribute('data-terms'), 'true');
  assert.ok(find(world.nodes['screen-terms'], '.terms-note')[0].textContent.includes('2027-01-01'), 'the note does not name the newer version');
  // The lock was asked again with the terms required, and stood down.
  world.sandbox.PhosphorLock.render();
  assert.equal(world.nodes['screen-lock'].hidden, true);
  assert.deepEqual(world.calls.filter((c) => c.route === 'firstrun.open'), [], 'the first run opened under the card');
});
