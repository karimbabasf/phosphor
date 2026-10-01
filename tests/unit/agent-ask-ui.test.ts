// The card that asks about an agent started outside Phosphor (ui/screens/agentask.js).
//
// Run for real over a small DOM with ui/core/dom.js, a store that hands it state frames and an
// api that records the answer. What is proven: the card asks only about an outside agent that can
// be allowed and has not been answered; it says who is asking in the agent's own words, what it
// can do now and after an Allow (with the person's own approval amount), and why to be careful;
// it moves no focus and holds its answers for a beat; Allow and Not now are one round trip each,
// Escape is Not now, a failure keeps it up with the reason, and nothing it draws is markup or a
// brand's mark for a name nobody checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const ASK = read('../../ui/screens/agentask.js');
const CSS = read('../../ui/design/agentask.css');

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
    type: '',
    dataset: {} as Record<string, string>,
    childNodes: [] as Any[],
    parentNode: null as Any,
    get textContent(): string {
      return node.childNodes.length ? node.childNodes.map((c: Any) => c.textContent).join('') : ownText;
    },
    set textContent(value: string) {
      ownText = String(value);
      node.childNodes = [];
    },
    get firstChild() { return node.childNodes[0] ?? null; },
    get children() { return node.childNodes; },
    appendChild(child: Any) { child.parentNode = node; node.childNodes.push(child); return child; },
    removeChild(child: Any) { node.childNodes = node.childNodes.filter((c: Any) => c !== child); child.parentNode = null; return child; },
    setAttribute(name: string, value: string) { attrs[name] = String(value); },
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    removeAttribute(name: string) { delete attrs[name]; },
    addEventListener(type: string, fn: (event: Any) => void) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type: string, fn: (event: Any) => void) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
    querySelector(selector: string): Any | null {
      const cls = selector.replace(/^\./, '');
      for (const child of node.childNodes) {
        if (String(child.className).split(' ').includes(cls)) return child;
        const deep = child.querySelector?.(selector);
        if (deep) return deep;
      }
      return null;
    },
    fire(type: string, event: Any = {}) { for (const fn of listeners[type] ?? []) fn(event); },
    focus() { (globalThis as Any).__focused = node; },
  };
  return node;
}

function all(root: Any, pick: (n: Any) => boolean, out: Any[] = []): Any[] {
  for (const child of root.childNodes ?? []) {
    if (pick(child)) out.push(child);
    all(child, pick, out);
  }
  return out;
}

const MEMBER = { session: 'seat-ask-1', client: 'claude-code', label: 'claude-code', role: 'operator', since: '2026-10-01T19:12:00.000Z', ops: 0, origin: 'outside', allowed: false, later: false, askable: true };

function harness(opts: { answer?: (session: string, allow: boolean) => Promise<unknown> } = {}) {
  const body = makeNode('body');
  const timers: Array<() => void> = [];
  const answers: Array<[string, boolean]> = [];
  let state: Any = { agents: { members: [] }, policy: { outbound: { humanClickAboveUsd: 25 } } };
  const watchers: Record<string, Array<(slice: unknown) => void>> = {};
  const pending: Array<[Any, boolean]> = [];
  const sandbox: Any = {
    document: { createElement: (tag: string) => makeNode(tag), body },
    console,
  };
  sandbox.window = {
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    PhosphorState: {
      get: () => state,
      select: (key: string, fn: (slice: unknown) => void) => { (watchers[key] ??= []).push(fn); },
    },
    PhosphorApi: {
      agentAnswer: (session: string, allow: boolean) => {
        answers.push([session, allow]);
        return opts.answer ? opts.answer(session, allow) : Promise.resolve({ ok: true });
      },
    },
    PhosphorNet: { readable: (err: Any) => `readable: ${err?.message ?? err}` },
    PhosphorIcons: { svg: (name: string) => { const n = makeNode('svg'); n.dataset.icon = name; return n; } },
    PhosphorShell: { setPending: (button: Any, on: boolean) => { pending.push([button, on]); button.disabled = on; } },
  };
  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(ASK, sandbox, { filename: 'ui/screens/agentask.js' });
  const ask = sandbox.window.PhosphorAgentAsk;
  ask.boot();
  const push = (next: Any): void => {
    state = next;
    for (const fn of watchers.agents ?? []) fn(next.agents);
  };
  const card = (): Any => body.childNodes.find((n: Any) => n.className === 'agent-ask') ?? null;
  const buttons = (): { later: Any; allow: Any } => {
    const list = all(card(), (n) => n.tagName === 'BUTTON');
    return { later: list.find((b) => b.textContent.includes('Not now')), allow: list.find((b) => b.textContent.includes('Allow')) };
  };
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { body, push, card, buttons, timers, answers, pending, tick, stateWith: (members: Any[]) => ({ ...state, agents: { members } }) };
}

test('no card for an agent the app started, one allowed or put off, or one that sent no key', () => {
  const h = harness();
  for (const m of [
    { ...MEMBER, origin: 'app', allowed: true, askable: false },
    { ...MEMBER, allowed: true },
    { ...MEMBER, later: true },
    { ...MEMBER, askable: false },
  ]) {
    h.push(h.stateWith([m]));
    assert.ok(h.card() === null || h.card().hidden === true, JSON.stringify(m));
  }
});

test('it asks who, in the agent\'s own words, what it can do now and after an Allow, and why to be careful', () => {
  const h = harness();
  h.push(h.stateWith([MEMBER]));
  const card = h.card();
  assert.ok(card !== null && card.hidden === false);
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'false');
  assert.equal(card.getAttribute('data-motion'), 'pop', 'it grows in and goes out on the window\'s pop');
  const text = card.textContent;
  assert.match(text, /Allow this agent\?/);
  assert.match(text, /"claude-code", started outside Phosphor at \d{2}:\d{2}/);
  assert.match(text, /Until you allow it/);
  assert.match(text, /Every move it asks for waits for your OK\./);
  assert.match(text, /If you allow it/);
  assert.match(text, /Moves up to \$25 run without asking you/);
  assert.match(text, /Allow only an agent you started yourself\./);
  assert.equal((globalThis as Any).__focused, undefined, 'the card took the focus');
});

test('its answers hold for a beat after it lands, then Allow is one round trip and the card goes', async () => {
  const h = harness();
  h.push(h.stateWith([MEMBER]));
  const { later, allow } = h.buttons();
  assert.equal(allow.disabled, true);
  assert.equal(later.disabled, true);
  allow.fire('click');
  assert.deepEqual(h.answers, [], 'a click already on its way answered a card nobody read');
  for (const fn of h.timers.splice(0)) fn();
  assert.equal(allow.disabled, false);
  allow.fire('click');
  assert.deepEqual(h.answers, [['seat-ask-1', true]]);
  await h.tick();
  assert.equal(h.card().hidden, true);
});

test('Not now is the other round trip, and Escape inside the card is Not now, never Allow', async () => {
  const h = harness();
  h.push(h.stateWith([MEMBER, { ...MEMBER, session: 'seat-ask-2', client: 'codex' }]));
  for (const fn of h.timers.splice(0)) fn();
  h.card().fire('keydown', { key: 'Escape' });
  assert.deepEqual(h.answers, [['seat-ask-1', false]]);
  await h.tick();
  // The next agent waiting is asked about once the first is answered.
  assert.equal(h.card().hidden, false);
  assert.match(h.card().textContent, /"codex"/);
  for (const fn of h.timers.splice(0)) fn();
  h.buttons().later.fire('click');
  assert.deepEqual(h.answers, [['seat-ask-1', false], ['seat-ask-2', false]]);
});

test('an answer that did not go through stays up with the reason, and both answers come back', async () => {
  const h = harness({ answer: () => Promise.reject(new Error('that agent is no longer connected')) });
  h.push(h.stateWith([MEMBER]));
  for (const fn of h.timers.splice(0)) fn();
  h.buttons().allow.fire('click');
  await h.tick();
  const card = h.card();
  assert.equal(card.hidden, false);
  const error = all(card, (n) => n.className === 'agent-ask-error')[0];
  assert.equal(error.hidden, false);
  assert.equal(error.getAttribute('role'), 'alert');
  assert.match(error.textContent, /no longer connected/);
  assert.equal(h.buttons().allow.disabled, false);
  assert.equal(h.buttons().later.disabled, false);
});

test('nothing it draws is markup, and a name nobody checked never gets a brand\'s mark', () => {
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(ASK), false);
  assert.equal(/PhosphorMarks/.test(ASK), false, 'a brand mark would vouch for a self-chosen name');
  const h = harness();
  h.push(h.stateWith([{ ...MEMBER, client: '<img src=x onerror=alert(1)>' }]));
  assert.match(h.card().textContent, /"<img src=x onerror=alert\(1\)>"/);
  assert.equal(all(h.card(), (n) => n.tagName === 'IMG').length, 0);
});

test('the card floats in the freeze panel\'s corner, under the top bar, never over the conversation', () => {
  assert.match(CSS, /\.agent-ask \{[^}]*position: fixed;[^}]*top: calc\(var\(--topbar-h\) \+ var\(--s-3\)\);[^}]*right: var\(--s-4\);/s);
  assert.match(CSS, /box-shadow: var\(--lift\)/);
  assert.match(CSS, /transform-origin: top right/);
  assert.equal(/border(-left|-right)?:\s*[1-9]/.test(CSS), false, 'a card is lifted, never outlined');
});
