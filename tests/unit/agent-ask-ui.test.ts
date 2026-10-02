// The card that asks about an agent started outside Phosphor (ui/screens/agentask.js).
//
// Run for real over a small DOM with ui/core/dom.js, a store that hands it state frames and an
// api that records the answer. What is proven: the card asks only about an outside agent that can
// be allowed and has not been answered; it sits in the conversation's slot under the roster, in
// the column's flow, and never floats over the balances or the freeze panel; it says who is
// asking in the agent's own words, how many more wait, what it can do now and after an Allow
// (with the person's own approval amount, and that a move already asked for still waits), and
// why to be careful; a screen reader hears that an agent asks; it moves no focus and holds its
// answers for a beat; Allow and Ask each time are one round trip each, Escape is Ask each time,
// a failure keeps it up with the reason, a put-off agent's card comes back when the person asks
// from its roster row, and nothing it draws is markup or a brand's mark for a name nobody checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const ASK = read('../../ui/screens/agentask.js');
const CSS = read('../../ui/design/agentask.css');
const AGENT = read('../../ui/screens/agent.js');

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

/* The window as the card meets it: a body, and in it the conversation with the slot ui/screens/
   agent.js keeps under its roster. `slot: false` is a window whose conversation never mounted. */
function harness(opts: { answer?: (session: string, allow: boolean) => Promise<unknown>; slot?: boolean } = {}) {
  const body = makeNode('body');
  const conversation = makeNode('aside');
  conversation.className = 'conversation';
  const slot = makeNode('div');
  slot.className = 'agent-asks';
  slot.hidden = true;
  if (opts.slot !== false) conversation.appendChild(slot);
  body.appendChild(conversation);
  const timers: Array<() => void> = [];
  const answers: Array<[string, boolean]> = [];
  let state: Any = { agents: { members: [] }, policy: { outbound: { humanClickAboveUsd: 25 } } };
  const watchers: Record<string, Array<(slice: unknown) => void>> = {};
  const pending: Array<[Any, boolean]> = [];
  const sandbox: Any = {
    document: { createElement: (tag: string) => makeNode(tag), body, querySelector: (selector: string) => body.querySelector(selector) },
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
  const card = (): Any => all(body, (n) => n.className === 'agent-ask')[0] ?? null;
  const live = (): Any => all(body, (n) => String(n.className).split(' ').includes('agent-ask-live'))[0] ?? null;
  const more = (): Any => all(card(), (n) => n.className === 'agent-ask-more')[0];
  const buttons = (): { later: Any; allow: Any } => {
    const list = all(card(), (n) => n.tagName === 'BUTTON');
    return { later: list.find((b) => b.textContent.includes('Ask each time')), allow: list.find((b) => b.textContent.includes('Allow')) };
  };
  const runTimers = (): void => { for (const fn of timers.splice(0)) fn(); };
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { body, slot, ask, push, card, live, more, buttons, timers, runTimers, answers, pending, tick, stateWith: (members: Any[]) => ({ ...state, agents: { members } }) };
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
  assert.match(text, /Allow only an agent you started yourself\./);
  assert.equal((globalThis as Any).__focused, undefined, 'the card took the focus');
});

// UX review 2026-10-01, finding 19: "like your own assistant's" pointed at the wrong agents, and
// the card did not say that an Allow leaves a move already asked for waiting.
test('an Allow is said as the same as Phosphor\'s own chat, and a move already asked for still waits', () => {
  const h = harness();
  h.push(h.stateWith([MEMBER]));
  assert.match(h.card().textContent, /Moves up to \$25 run without asking you, the same as from Phosphor's own chat\. Moves it already asked for still wait for your OK\./);
  assert.equal(h.card().textContent.includes('your own assistant'), false);
  const none = harness();
  none.push({ agents: { members: [MEMBER] }, policy: { outbound: { humanClickAboveUsd: 0 } } });
  assert.match(none.card().textContent, /Small moves run without asking you, the same as from Phosphor's own chat\. Moves it already asked for still wait for your OK\./);
});

// UX review 2026-10-01, findings 1 and 8: floating under the top bar, the card covered the ring,
// the total and a coin tile, and the freeze panel opened under it with its Freeze key out of
// reach (its 55 on the body beat the panel's 60 inside the bar's 40).
test('the card sits in the conversation\'s slot, in the column\'s flow, never floating over the balances or the freeze panel', () => {
  const h = harness();
  assert.equal(h.slot.hidden, true, 'an empty slot holds room in the column');
  h.push(h.stateWith([MEMBER]));
  assert.equal(h.card().parentNode, h.slot, 'the card is not in the conversation\'s slot');
  assert.equal(h.slot.hidden, false);
  assert.equal(h.body.childNodes.some((n: Any) => n.className === 'agent-ask'), false, 'the card was put on the body');
  const rule = /\.agent-ask \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
  assert.equal(/position:\s*(fixed|absolute|sticky)/.test(rule), false, 'the card floats: ' + rule);
  assert.equal(/z-index/.test(CSS), false, 'a card in the flow needs no layer of its own');
  assert.match(rule, /box-shadow: var\(--raise\)/, 'a card in the thread carries the move card\'s raise, not a popover\'s lift');
  assert.match(rule, /border-radius: var\(--radius-card\)/);
  assert.equal(/border(-left|-right)?:\s*[1-9]/.test(CSS), false, 'a card is lifted, never outlined');
  /* The slot is the conversation's, made by its own file under the roster. */
  assert.match(AGENT, /var clients = dom\.el\('div', 'agent-clients'\);\s*host\.appendChild\(clients\);[\s\S]{0,400}var asks = dom\.el\('div', 'agent-asks'\);\s*asks\.hidden = true;\s*host\.appendChild\(asks\);/);
  // The card goes once it is answered, and the slot with it.
  h.runTimers();
  h.buttons().allow.fire('click');
  return h.tick().then(() => {
    assert.equal(h.card().hidden, true);
    assert.equal(h.slot.hidden, true, 'an empty slot kept its room');
  });
});

test('with no conversation to sit in, nothing floats, and nothing is asked', () => {
  const h = harness({ slot: false });
  h.push(h.stateWith([MEMBER]));
  assert.equal(h.card(), null);
});

test('its answers hold for a beat after it lands, then Allow is one round trip and the card goes', async () => {
  const h = harness();
  h.push(h.stateWith([MEMBER]));
  const { later, allow } = h.buttons();
  assert.equal(allow.disabled, true);
  assert.equal(later.disabled, true);
  allow.fire('click');
  assert.deepEqual(h.answers, [], 'a click already on its way answered a card nobody read');
  h.runTimers();
  assert.equal(allow.disabled, false);
  allow.fire('click');
  assert.deepEqual(h.answers, [['seat-ask-1', true]]);
  await h.tick();
  assert.equal(h.card().hidden, true);
});

// UX review 2026-10-01, finding 9: "Not now" promised a later that never came. The key says what
// happens, and Escape is still the harmless answer.
test('Ask each time is the other round trip, and Escape inside the card is Ask each time, never Allow', async () => {
  const h = harness();
  h.push(h.stateWith([MEMBER, { ...MEMBER, session: 'seat-ask-2', client: 'codex' }]));
  assert.equal(h.card().textContent.includes('Not now'), false);
  h.runTimers();
  h.card().fire('keydown', { key: 'Escape' });
  assert.deepEqual(h.answers, [['seat-ask-1', false]]);
  await h.tick();
  // The next agent waiting is asked about once the first is answered.
  assert.equal(h.card().hidden, false);
  assert.match(h.card().textContent, /"codex"/);
  h.runTimers();
  h.buttons().later.fire('click');
  assert.deepEqual(h.answers, [['seat-ask-1', false], ['seat-ask-2', false]]);
});

// UX review 2026-10-01, finding 10: the next agent's card swapped in with the same words and no
// motion, so an answer looked like it had failed.
test('it says how many more agents wait, and the next one is asked about afresh', async () => {
  const h = harness();
  const three = [MEMBER, { ...MEMBER, session: 'seat-ask-2', client: 'codex' }, { ...MEMBER, session: 'seat-ask-3', client: 'grok' }];
  h.push(h.stateWith(three));
  assert.equal(h.more().hidden, false);
  assert.equal(h.more().textContent, '2 more agents are waiting');
  h.runTimers();
  h.buttons().allow.fire('click');
  await h.tick();
  assert.match(h.card().textContent, /"codex"/);
  assert.equal(h.more().textContent, '1 more agent is waiting');
  assert.equal(h.buttons().allow.disabled, true, 'the next card answered before it was read');
  h.push(h.stateWith(three.slice(1, 2)));
  assert.equal(h.more().hidden, true, 'a count with nobody behind it');
});

// UX review 2026-10-01, finding 20: the card takes no focus, which is right, and so a screen
// reader heard nothing.
test('a screen reader hears that an agent asks, once for each agent', async () => {
  const h = harness();
  h.push(h.stateWith([MEMBER, { ...MEMBER, session: 'seat-ask-2', client: 'codex' }]));
  const live = h.live();
  assert.ok(live, 'no live line');
  assert.equal(live.getAttribute('role'), 'status');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.ok(String(live.className).split(' ').includes('sr-only'), 'the line is drawn on screen');
  h.runTimers();
  assert.equal(live.textContent, 'An agent started outside Phosphor asks to be allowed.');
  h.buttons().later.fire('click');
  await h.tick();
  assert.equal(live.textContent, '', 'the same words again would not be heard again');
  h.runTimers();
  assert.equal(live.textContent, 'An agent started outside Phosphor asks to be allowed.');
  assert.equal((globalThis as Any).__focused, undefined, 'the card took the focus');
});

// UX review 2026-10-01, finding 9: after Not now there was no way to allow the agent. Its roster
// row's Allow brings the whole card back (ui/screens/agent.js paintAllow).
test('a put-off agent is asked about again, first and whole, when the person asks from its roster row', async () => {
  const h = harness();
  h.push(h.stateWith([{ ...MEMBER, later: true }, { ...MEMBER, session: 'seat-ask-2', client: 'codex' }]));
  assert.match(h.card().textContent, /"codex"/);
  h.ask.reopen('seat-ask-1');
  assert.match(h.card().textContent, /"claude-code"/, 'the agent the person asked about is not first');
  assert.equal(h.more().textContent, '1 more agent is waiting');
  assert.equal(h.buttons().allow.disabled, true, 'a card brought back answers before it is read');
  h.runTimers();
  h.buttons().allow.fire('click');
  assert.deepEqual(h.answers, [['seat-ask-1', true]]);
  await h.tick();
  assert.match(h.card().textContent, /"codex"/);
});

test('an answer that did not go through stays up with the reason, and both answers come back', async () => {
  const h = harness({ answer: () => Promise.reject(new Error('that agent is no longer connected')) });
  h.push(h.stateWith([MEMBER]));
  h.runTimers();
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
