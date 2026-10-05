// The card that asks about an agent started outside Phosphor (ui/screens/agentask.js).
//
// Run for real over a small DOM with ui/core/dom.js, a store that hands it state frames and an
// api that records the answer. What is proven: the card asks only about an outside agent that can
// be allowed and has not been answered; it sits in the conversation's slot under the roster, in
// the column's flow and across its measure, and never floats over the balances or the freeze
// panel; it says in one line which assistant wants to use Phosphor and when it connected, how
// many more wait, what it can do until an Allow and after one (with the person's own approval
// amount, $0 included, and that a move already asked for still waits), and why to be careful; a
// screen reader hears that an agent asks; it moves no focus and holds its answers for a beat at
// full strength; Allow and Ask each time are one round trip each, Escape is Ask each time, a
// failure keeps it up with the reason, a put-off agent's card comes back when the person asks
// from its roster row, and nothing it draws is markup. Only a name the card knows gets a logo, and
// the card says Phosphor can't check the name; any other name stays the agent's own text.

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
  const logos: string[] = [];
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
    // ui/design/marks.js agent(): a brand's logo is an <img> of its file.
    PhosphorMarks: { agent: (id: string) => { logos.push(id); const n = makeNode('span'); n.className = 'logo'; n.appendChild(makeNode('img')); return n; } },
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
  const part = (cls: string): Any => all(card(), (n) => n.className === cls)[0];
  // The words as read: the line under the title keeps its no-break spaces out of the comparisons.
  const says = (cls: string): string => String(part(cls).textContent).replace(/\u00a0/g, ' ');
  const buttons = (): { later: Any; allow: Any } => {
    const list = all(card(), (n) => n.tagName === 'BUTTON');
    return { later: list.find((b) => b.textContent.includes('Ask each time')), allow: list.find((b) => b.textContent.includes('Allow')) };
  };
  const runTimers = (): void => { for (const fn of timers.splice(0)) fn(); };
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { body, slot, ask, push, card, live, more, part, says, buttons, timers, runTimers, answers, logos, pending, tick, stateWith: (members: Any[]) => ({ ...state, agents: { members } }) };
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

// Karim, 2026-10-05: "this looks like shit, idk what it is". The card said '"claude-code", started
// outside Phosphor at 07:43' for a session started at 00:12 that connected at 07:43.
test('it says in one line which assistant wants to use Phosphor, when it connected, what each answer means, and why to be careful', () => {
  const h = harness();
  h.push(h.stateWith([MEMBER]));
  const card = h.card();
  assert.ok(card !== null && card.hidden === false);
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'false');
  assert.equal(card.getAttribute('aria-labelledby'), 'agent-ask-title');
  assert.equal(card.getAttribute('data-motion'), 'pop', 'it grows in and goes out on the window\'s pop');
  assert.equal(h.part('agent-ask-title').textContent, 'Claude Code wants to use Phosphor');
  assert.match(h.says('agent-ask-line'), /^An AI assistant on this Mac · connected at \d{2}:\d{2}$/);
  const text = card.textContent;
  assert.equal(/started outside|claude-code/.test(text), false, 'the start time it never knew, or the client\'s raw name: ' + text);
  assert.match(text, /Until you allow itEvery move it asks for waits for your OK\. It can read your wallet\./);
  assert.match(text, /If you allow it/);
  assert.match(text, /Only allow an agent you started yourself\. Phosphor can't check its name or see what it reads elsewhere\./);
  assert.deepEqual(h.logos, ['claude'], 'Claude Code is drawn with the logo the window shows for it elsewhere');
  assert.equal(h.part('agent-ask-mark').getAttribute('data-agent'), 'claude');
  assert.equal((globalThis as Any).__focused, undefined, 'the card took the focus');
});

test('the time is when it connected, and a card with no time says no time', () => {
  const h = harness();
  h.push(h.stateWith([{ ...MEMBER, since: '2026-10-05T07:43:00' }]));
  assert.equal(h.says('agent-ask-line'), 'An AI assistant on this Mac · connected at 07:43');
  const none = harness();
  none.push(none.stateWith([{ ...MEMBER, since: 'not a time' }]));
  assert.equal(none.says('agent-ask-line'), 'An AI assistant on this Mac');
});

test('a name it does not know is the agent\'s own word beside the link, and no name says so', () => {
  const h = harness();
  h.push(h.stateWith([{ ...MEMBER, client: 'my-trading-bot', label: 'my-trading-bot' }]));
  assert.equal(h.part('agent-ask-title').textContent, 'An AI assistant on this Mac wants to use Phosphor');
  assert.match(h.says('agent-ask-line'), /^It calls itself my-trading-bot · connected at \d{2}:\d{2}$/);
  assert.equal(h.part('agent-ask-said').textContent, 'my-trading-bot');
  assert.equal(h.part('agent-ask-mark').getAttribute('data-agent'), 'mcp');
  assert.deepEqual(h.logos, [], 'a name nobody knows was drawn with a brand');
  // The proxy's own name, before a client's lands or for a client that sends none (src/mcp.ts).
  for (const client of ['phosphor-mcp', '']) {
    const n = harness();
    n.push(n.stateWith([{ ...MEMBER, client, label: client }]));
    assert.equal(n.part('agent-ask-title').textContent, 'An AI assistant on this Mac wants to use Phosphor');
    assert.match(n.says('agent-ask-line'), /^It gave no name · connected at \d{2}:\d{2}$/);
    assert.equal(n.part('agent-ask-said').hidden, true);
  }
});

test('the known names are the agents\' own clients, said plainly with their logos', () => {
  for (const [client, name, logo] of [['claude-code', 'Claude Code', 'claude'], ['claude-ai', 'Claude Desktop', 'desktop'], ['codex-mcp-client', 'Codex', 'codex']]) {
    const h = harness();
    h.push(h.stateWith([{ ...MEMBER, client, label: client }]));
    assert.equal(h.part('agent-ask-title').textContent, `${name} wants to use Phosphor`);
    assert.deepEqual(h.logos, [logo]);
  }
});

// The proxy says hello under its own name and renames itself within a beat (src/mcp.ts
// clientName): the card turns into the agent in place, its answers still held from when it landed.
test('a name that lands a beat later turns the card in place, with its logo, and asks nothing again', () => {
  const h = harness();
  h.push(h.stateWith([{ ...MEMBER, client: 'phosphor-mcp', label: 'phosphor-mcp' }]));
  assert.equal(h.part('agent-ask-mark').getAttribute('data-agent'), 'mcp');
  const armedTimers = h.timers.length;
  h.push(h.stateWith([MEMBER]));
  assert.equal(h.part('agent-ask-title').textContent, 'Claude Code wants to use Phosphor');
  assert.equal(h.part('agent-ask-mark').getAttribute('data-agent'), 'claude');
  assert.equal(h.part('agent-ask-mark').childNodes.length, 1, 'the link stayed beside the logo');
  assert.equal(h.timers.length, armedTimers, 'a rename armed the card again');
  h.push(h.stateWith([MEMBER]));
  assert.deepEqual(h.logos, ['claude'], 'the logo was drawn again on a frame that changed nothing');
});

// UX review 2026-10-01, finding 19: "like your own assistant's" pointed at the wrong agents, and
// the card did not say that an Allow leaves a move already asked for waiting.
test('an Allow is said as the same as Phosphor\'s own chat, and a move already asked for still waits', () => {
  const h = harness();
  h.push(h.stateWith([MEMBER]));
  assert.match(h.card().textContent, /If you allow itMoves up to \$25 run without asking you\. Phosphor's own chat works the same way\. Moves it already asked for still wait for your OK\./);
  assert.equal(h.card().textContent.includes('your own assistant'), false);
  const unread = harness();
  unread.push({ agents: { members: [MEMBER] } });
  assert.match(unread.card().textContent, /Small moves run without asking you\. Phosphor's own chat works the same way\. Moves it already asked for still wait for your OK\./);
});

// At $0 the rules ask before every move whoever proposes it (src/policy/engine.ts), so an Allow
// lets nothing run on its own; the card used to say small moves would.
test('at a $0 approval amount the card says every move still waits after an Allow', () => {
  const h = harness();
  h.push({ agents: { members: [MEMBER] }, policy: { outbound: { humanClickAboveUsd: 0 } } });
  const text = h.card().textContent;
  assert.match(text, /If you allow itEvery move still waits for your OK\. Your rules ask you before every move, from any agent\./);
  assert.equal(/run without asking/.test(text), false, text);
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
  // Across the column's measure, the head's and the thread's edges, not a box left at one side.
  assert.match(rule, /width: 100%/);
  assert.equal(/max-width/.test(rule), false, 'the card stops short of the column: ' + rule);
  assert.match(CSS, /\.agent-asks \{[^}]*width: min\(100%, var\(--thread-w\)\)/);
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
  // Held at full strength: a hollow key that filled in a moment later read as a flicker.
  assert.equal(h.card().getAttribute('data-arming'), 'true');
  const held = /\.agent-ask\[data-arming="true"\] \.agent-ask-actions > \.btn:disabled \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
  assert.match(held, /background: var\(--btn-bg\)/);
  assert.match(held, /color: var\(--btn-fg\)/);
  assert.equal(/opacity/.test(held), false);
  allow.fire('click');
  assert.deepEqual(h.answers, [], 'a click already on its way answered a card nobody read');
  h.runTimers();
  assert.equal(allow.disabled, false);
  assert.equal(h.card().getAttribute('data-arming'), null);
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
  assert.match(h.card().textContent, /It calls itself codex/);
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
  assert.match(h.card().textContent, /It calls itself codex/);
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
  assert.equal(live.textContent, 'Claude Code wants to use Phosphor.');
  h.buttons().later.fire('click');
  await h.tick();
  assert.equal(live.textContent, '', 'the same words again would not be heard again');
  h.runTimers();
  assert.equal(live.textContent, 'An AI assistant on this Mac wants to use Phosphor.', 'the next agent is said in its own head line');
  assert.equal((globalThis as Any).__focused, undefined, 'the card took the focus');
});

// UX review 2026-10-01, finding 9: after Not now there was no way to allow the agent. Its roster
// row's Allow brings the whole card back (ui/screens/agent.js paintAllow).
test('a put-off agent is asked about again, first and whole, when the person asks from its roster row', async () => {
  const h = harness();
  h.push(h.stateWith([{ ...MEMBER, later: true }, { ...MEMBER, session: 'seat-ask-2', client: 'codex' }]));
  assert.match(h.card().textContent, /It calls itself codex/);
  h.ask.reopen('seat-ask-1');
  assert.match(h.card().textContent, /Claude Code wants to use Phosphor/, 'the agent the person asked about is not first');
  assert.equal(h.more().textContent, '1 more agent is waiting');
  assert.equal(h.buttons().allow.disabled, true, 'a card brought back answers before it is read');
  h.runTimers();
  h.buttons().allow.fire('click');
  assert.deepEqual(h.answers, [['seat-ask-1', true]]);
  await h.tick();
  assert.match(h.card().textContent, /It calls itself codex/);
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

/* The name is the agent's own word: Phosphor can't check it, and the card says so beside every
   name. A logo is only ever one of the few names the card knows, by the catalog's id (marks.js
   draws a fixed file for it); the agent's own text never picks a file, never reaches the title,
   and is never markup. */
test('nothing it draws is markup, and a name the card does not know never gets a brand\'s mark or the title', () => {
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(ASK), false);
  assert.match(ASK, /marks\.agent\(id, 40\)/, 'the logo is drawn by the catalog id, never by the agent\'s words');
  const h = harness();
  h.push(h.stateWith([{ ...MEMBER, client: '<img src=x onerror=alert(1)>', label: '<img src=x onerror=alert(1)>' }]));
  assert.equal(h.part('agent-ask-said').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.part('agent-ask-title').textContent, 'An AI assistant on this Mac wants to use Phosphor');
  assert.equal(all(h.card(), (n) => n.tagName === 'IMG').length, 0);
  assert.deepEqual(h.logos, []);
  // A known agent's own name, said by anybody, is still a name nobody checked, and the card says so.
  const k = harness();
  k.push(k.stateWith([MEMBER]));
  assert.match(k.card().textContent, /Phosphor can't check its name/);
  for (const near of ['claude code', 'claude-code-', 'Claude', 'anthropic']) {
    const n = harness();
    n.push(n.stateWith([{ ...MEMBER, client: near, label: near }]));
    assert.deepEqual(n.logos, [], `"${near}" was drawn with a brand`);
  }
});
