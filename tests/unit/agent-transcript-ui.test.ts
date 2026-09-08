// What the conversation column shows a person while their agent is working.
//
// The trust-boundary properties are asserted next door in agent-panel-ui.test.ts. This file is
// about the other half of the column's job, which is telling the truth about what is happening:
// one row per thing the human said, a row per call that names what the call was about, and one
// line that keeps saying the agent is alive for as long as it is.
//
// It drives the real ui/screens/agent.js against a DOM small enough to read. The stub is not a
// browser: it is the handful of node operations ui/core/dom.js actually uses, which is what
// makes the assertions here about the column rather than about a framework.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const DOM_SOURCE = readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8');
const AGENT_SOURCE = readFileSync(new URL('../../ui/screens/agent.js', import.meta.url), 'utf8');

type Node = {
  tag: string;
  className: string;
  children: Node[];
  parentNode: Node | null;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  hidden: boolean;
  style: Record<string, string>;
  textContent: string;
  rows?: number;
  value?: string;
  disabled?: boolean;
  type?: string;
  placeholder?: string;
  autocomplete?: string;
  firstChild: Node | null;
  lastChild: Node | null;
  nextSibling: Node | null;
  offsetHeight: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  appendChild(child: Node): Node;
  insertBefore(child: Node, before: Node | null): Node;
  removeChild(child: Node): Node;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  addEventListener(type: string, handler: (event?: unknown) => void): void;
  removeEventListener(): void;
  querySelector(): null;
  __keyed?: Record<string, Node>;
  __on: Record<string, Array<(event?: unknown) => void>>;
};

function make(tag: string): Node {
  const node = {
    tag,
    className: '',
    children: [] as Node[],
    parentNode: null as Node | null,
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    hidden: false,
    style: {} as Record<string, string>,
    rows: 1,
    value: '',
    disabled: false,
    offsetHeight: 40,
    clientHeight: 38,
    scrollHeight: 38,
    scrollTop: 0,
    __on: {} as Record<string, Array<(event?: unknown) => void>>,
  } as unknown as Node;

  Object.defineProperty(node, 'textContent', {
    get(): string {
      if (node.children.length === 0) return (node as unknown as { __text?: string }).__text ?? '';
      return node.children.map((c) => c.textContent).join('');
    },
    set(value: string) {
      node.children.length = 0;
      (node as unknown as { __text?: string }).__text = String(value);
    },
  });
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] ?? null });
  Object.defineProperty(node, 'lastChild', { get: () => node.children[node.children.length - 1] ?? null });
  Object.defineProperty(node, 'nextSibling', {
    get(): Node | null {
      const parent = node.parentNode;
      if (!parent) return null;
      const at = parent.children.indexOf(node);
      return at === -1 ? null : parent.children[at + 1] ?? null;
    },
  });

  node.appendChild = (child) => node.insertBefore(child, null);
  node.insertBefore = (child, before) => {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before === null ? node.children.length : node.children.indexOf(before);
    node.children.splice(at === -1 ? node.children.length : at, 0, child);
    child.parentNode = node;
    return child;
  };
  node.removeChild = (child) => {
    const at = node.children.indexOf(child);
    if (at !== -1) node.children.splice(at, 1);
    child.parentNode = null;
    return child;
  };
  node.setAttribute = (name, value) => {
    node.attrs[name] = String(value);
  };
  node.getAttribute = (name) => (name in node.attrs ? node.attrs[name] : null);
  node.hasAttribute = (name) => name in node.attrs;
  node.removeAttribute = (name) => {
    delete node.attrs[name];
  };
  node.addEventListener = (type, handler) => {
    (node.__on[type] ??= []).push(handler);
  };
  node.removeEventListener = () => {};
  node.querySelector = () => null;
  (node as unknown as { focus: () => void; focused: boolean }).focus = () => {
    (node as unknown as { focused: boolean }).focused = true;
  };
  (node as unknown as { focused: boolean }).focused = false;
  return node;
}

function fire(node: Node, type: string, event: Record<string, unknown> = {}): void {
  for (const handler of node.__on[type] ?? []) handler({ preventDefault: () => {}, ...event });
}

/* Every node carrying a class, flattened. The column is a tree of divs and what a test wants to
   know is which rows are in it, so this is the query language rather than a selector engine. */
function all(node: Node, className: string, found: Node[] = []): Node[] {
  if (node.className.split(' ').includes(className)) found.push(node);
  for (const child of node.children) all(child, className, found);
  return found;
}

function build() {
  const sends: string[] = [];
  let reject: ((err: Error) => void) | null = null;
  const driverHandlers: Array<(frame: unknown) => void> = [];

  const host = make('div');
  const composerHost = make('div');

  const sandbox: Record<string, unknown> = {
    console,
    navigator: {},
    document: { createElement: (tag: string) => make(tag), addEventListener: () => {} },
  };
  /* Timers are collected rather than run, so a test can say when they fire. The starting floor
     below is the only thing here that depends on one, and running it eagerly would erase the
     state it exists to keep on screen. */
  const timers: Array<{ id: number; fn: () => void }> = [];
  let timerSeq = 0;

  const win: Record<string, unknown> = {
    setTimeout: (fn: () => void) => {
      timerSeq += 1;
      timers.push({ id: timerSeq, fn });
      return timerSeq;
    },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at !== -1) timers.splice(at, 1);
    },
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: () => ({ lineHeight: '21px', paddingTop: '8px', paddingBottom: '8px' }),
    dispatchEvent: () => true,
    PhosphorNet: { readable: (e: Error) => String(e.message) },
    PhosphorShell: { setPending: () => {}, updateField: () => {} },
    PhosphorToast: { show: () => {} },
    PhosphorApi: {
      driver: (body: { action: string; text?: string }) => {
        if (body.action === 'prompt') {
          sends.push(String(body.text));
          return new Promise<void>((_, rej) => {
            reject = rej;
          });
        }
        return Promise.resolve({});
      },
      driverState: () => Promise.resolve({ data: { state: 'ready', chats: [{ id: 'c1', transcript: [] }] } }),
      connection: () => Promise.resolve({ command: '', connected: [] }),
    },
    PhosphorEvents: {
      on: (type: string, handler: (frame: unknown) => void) => {
        if (type === 'driver') driverHandlers.push(handler);
      },
    },
  };
  sandbox.window = win;
  sandbox.CustomEvent = function CustomEventStub(this: Record<string, unknown>, type: string, init: unknown) {
    this.type = type;
    this.detail = (init as { detail?: unknown } | undefined)?.detail;
  };
  createContext(sandbox);
  runInContext(DOM_SOURCE, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(AGENT_SOURCE, sandbox, { filename: 'ui/screens/agent.js' });

  const agent = win.PhosphorAgent as { mount: (h: unknown, o: unknown) => void; start: () => void };
  agent.mount(host, { composerHost });
  agent.start();

  const emit = (event: Record<string, unknown>, chat = 'c1') => {
    for (const handler of driverHandlers) handler({ chat, event });
  };
  emit({ kind: 'status', state: 'ready' });

  const composer = all(composerHost, 'agent-composer')[0];
  const input = all(composerHost, 'input')[0];

  return {
    host,
    composerHost,
    emit,
    sends,
    fail: (message: string) => reject?.(new Error(message)),
    type(text: string) {
      input.value = text;
      fire(composer, 'submit');
    },
    saidRows: () => all(host, 'chat-said'),
    stepRows: () => all(host, 'step'),
    turnBar: () => all(composerHost, 'turn-bar')[0],
    seat: () => all(host, 'agent-seat')[0].getAttribute('data-seat'),
    card: () => all(host, 'agent-empty-inner')[0].textContent,
    actionsHidden: () => all(host, 'agent-empty-actions')[0].hidden,
    input,
    /* Fire every timer the column has booked. The starting floor is the one that matters, and a
       test that could not hold it open could not tell a state that stays from one that flickers. */
    runTimers() {
      const due = timers.splice(0, timers.length);
      for (const timer of due) timer.fn();
    },
  };
}

test('a message a person sends appears once, not once per echo', async () => {
  /* THE BUG THIS FILE WAS OPENED FOR. The column drew the message when it was typed and again
     when the server broadcast it back, so every prompt appeared twice in the transcript. */
  const world = build();
  world.type('hello');
  assert.equal(world.saidRows().length, 1);

  world.emit({ kind: 'said', text: 'hello' });
  assert.equal(world.saidRows().length, 1, 'the server echo drew the message a second time');
});

test('the message is held back until the app has it, then settles', () => {
  const world = build();
  world.type('move 12 usdc');
  assert.equal(world.saidRows()[0].getAttribute('data-state'), 'pending');

  world.emit({ kind: 'said', text: 'move 12 usdc' });
  assert.equal(world.saidRows()[0].getAttribute('data-state'), 'sent');
});

test('a prompt the app never took says so on the row that carries it', async () => {
  const world = build();
  world.type('swap everything');
  world.fail('the assistant is not running');
  await new Promise((r) => setImmediate(r));
  assert.equal(world.saidRows()[0].getAttribute('data-state'), 'failed');
  assert.equal(world.turnBar().hidden, true, 'the bar kept counting for a turn that never started');
});

test('two identical prompts each get their own row and their own receipt', () => {
  const world = build();
  world.type('hello');
  world.type('hello');
  assert.equal(world.saidRows().length, 2);
  world.emit({ kind: 'said', text: 'hello' });
  const states = world.saidRows().map((r) => r.getAttribute('data-state'));
  assert.deepEqual(states, ['pending', 'sent'], 'one echo confirmed both rows, or neither');
});

test('a step row says what the call was about, not just what kind it was', () => {
  /* "reading prices" is a category of work. "reading prices, SOL-USD" is evidence the app is
     working on the thing that was asked for, and the tool event already carried it. */
  const world = build();
  world.type('what is sol doing');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__candles', input: { product: 'SOL-USD', granularity: 3600 } });
  const text = world.stepRows()[0].textContent;
  assert.ok(text.includes('reading prices'), text);
  assert.ok(text.includes('SOL-USD'), text);
});

test('nothing but a scalar reaches a step row', () => {
  // Tool arguments come from a language model. An object has no reading a person can use and a
  // long string is not this row's job, so neither one gets in.
  const world = build();
  world.type('draw it');
  world.emit({
    kind: 'tool',
    name: 'mcp__phosphor__chart_trendline',
    input: { a: { t: 1, price: 2 }, label: 'x'.repeat(400) },
  });
  const text = world.stepRows()[0].textContent;
  assert.ok(!text.includes('[object'), text);
  assert.ok(text.length < 120, `a step row ran to ${text.length} characters`);
});

test('the turn bar is up for the whole answer and gone after it', () => {
  /* The old build put a thinking row in the transcript and removed it on the first frame, so the
     two longest silences in a turn (before the first call, and while the answer is written) had
     nothing on screen at all. */
  const world = build();
  assert.equal(world.turnBar().hidden, true);

  world.type('what am I holding');
  assert.equal(world.turnBar().hidden, false);
  assert.equal(world.turnBar().textContent.includes('thinking'), true);

  world.emit({ kind: 'tool', name: 'mcp__phosphor__balances', input: {} });
  assert.equal(world.turnBar().hidden, false);
  assert.equal(world.turnBar().textContent.includes('working'), true);

  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__balances', ok: true });
  world.emit({ kind: 'text', text: 'You hold 3.27 dollars.' });
  assert.equal(world.turnBar().textContent.includes('writing the answer'), true);

  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.equal(world.turnBar().hidden, true);
});

test('an agent that stops mid answer takes the turn bar with it', () => {
  const world = build();
  world.type('read the chart');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: {} });
  assert.equal(world.turnBar().hidden, false);

  world.emit({ kind: 'status', state: 'stopped' });
  assert.equal(world.turnBar().hidden, true, 'the bar counted on for an agent that had stopped');
});

test('the turn bar does not repeat the step row above it', () => {
  // Both lines were saying the tool phrase, one under the other. The steps answer "on what", the
  // bar answers "still going".
  const world = build();
  world.type('read the news');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__research', input: { query: 'SOL funding' } });
  assert.equal(world.turnBar().textContent.includes('SOL funding'), false);
  assert.equal(world.stepRows()[0].textContent.includes('SOL funding'), true);
});

test('another conversation does not print into this one', () => {
  /* The stream carries every chat the app has open and this reader took them all, so a second
     conversation's calls landed here and lit this window's panels for work this agent never did. */
  const world = build();
  world.type('hello');
  world.emit({ kind: 'said', text: 'hello' });
  world.emit({ kind: 'said', text: 'not for this window' }, 'c2');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__propose_swap', input: { symbol: 'USDC' } }, 'c2');

  assert.equal(world.saidRows().length, 1);
  assert.equal(world.stepRows().length, 0);
});

/* ---------- Starting an agent ----------

   Karim, 2026-09-08: "i need much better feedback when i click start an agent, right now nothing
   changes." He was right and the reason was structural. The empty card keyed on an empty
   transcript and nothing else, so it went on saying "Nobody is at the wheel" and offering a Start
   button for the whole time an agent was up and simply had not been spoken to yet. The chip in the
   corner changed. Nothing he was looking at did. */

test('the card says nobody is there only when nobody is there', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  assert.equal(world.seat(), 'off');
  assert.ok(world.card().includes('Nobody is at the wheel'));
  assert.equal(world.actionsHidden(), false, 'Start is the thing to do here and it is not offered');
});

test('an agent that is up does not get asked to start again', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'ready' });
  assert.equal(world.seat(), 'live');
  assert.ok(world.card().includes('at the wheel'));
  assert.ok(!world.card().includes('Nobody'), 'the card still says nobody is driving a running agent');
  assert.equal(world.actionsHidden(), true, 'Start is offered to somebody whose agent is running');
});

test('coming up is its own state and it survives long enough to be seen', () => {
  /* The driver reports ready on the child's spawn event, so the real start is a couple of hundred
     milliseconds. Without a floor the state existed and no eye could catch it, which is the same
     thing as not existing. */
  const world = build();
  world.emit({ kind: 'status', state: 'starting', detail: 'Starting your assistant.' });
  assert.equal(world.seat(), 'coming');
  assert.equal(world.actionsHidden(), true, 'a button offered to somebody mid press');

  world.emit({ kind: 'status', state: 'ready' });
  assert.equal(world.seat(), 'coming', 'the starting state was gone before it could be seen');

  world.runTimers();
  assert.equal(world.seat(), 'live');
});

test('arriving hands the person the caret', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  assert.equal((world.input as unknown as { focused: boolean }).focused, false);

  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  assert.equal((world.input as unknown as { focused: boolean }).focused, true);
});

test('a window that opens onto a running agent does not steal focus', () => {
  // The transition is what hands over the caret, not the state. Somebody who was reading the chart
  // when the window reloaded should keep what they were doing.
  const world = build();
  assert.equal((world.input as unknown as { focused: boolean }).focused, false);
});

test('a start that failed says so where the person is looking', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'failed', detail: 'claude was not found on PATH.' });
  world.runTimers();
  assert.equal(world.seat(), 'error');
  assert.ok(world.card().includes('could not start'));
  assert.ok(world.card().includes('claude was not found on PATH.'));
  assert.equal(world.actionsHidden(), false, 'no way back from a failed start');
});

test('the same sentence is not printed twice on one screen', () => {
  // The head's detail line and the empty card carried the same string, one under the other.
  const world = build();
  world.emit({ kind: 'status', state: 'starting', detail: 'Starting your assistant.' });
  const head = all(world.host, 'agent-detail')[0];
  assert.equal(head.hidden, true);
  assert.ok(world.card().includes('Starting your assistant.'));
});

test('once there is a transcript the card is gone and the detail line takes the sentence back', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting', detail: 'Starting your assistant.' });
  assert.equal(all(world.host, 'agent-detail')[0].hidden, true, 'both places said it at once');

  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  world.type('hello');
  assert.equal(all(world.host, 'agent-empty')[0].hidden, true);

  world.emit({ kind: 'status', state: 'failed', detail: 'the agent exited with code 1' });
  const head = all(world.host, 'agent-detail')[0];
  assert.equal(head.hidden, false, 'with the card gone, nothing carries the reason');
  assert.equal(head.textContent, 'the agent exited with code 1');
});
