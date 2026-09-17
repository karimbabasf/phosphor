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
const MARKDOWN_SOURCE = readFileSync(new URL('../../ui/core/markdown.js', import.meta.url), 'utf8');

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
  /* The scroller's one write. A browser eases it; the stub lands it, so a test reads where the
     column asked to be rather than a frame of the way there. */
  (node as unknown as { scrollTo: (opts: { top: number }) => void }).scrollTo = (opts) => {
    node.scrollTop = opts.top;
  };
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

function build(options: { command?: string } = {}) {
  const sends: string[] = [];
  /* The shared receipt card (ui/screens/receipt.js) is somebody else's: the column hands it the
     receipt and places what comes back. The stub records what it was handed and returns one
     marker node, so a test can say the card was posted and built from the app's own receipt
     without asserting the card's insides, which receipt-ui.test.ts owns. */
  const built: unknown[] = [];
  let reject: ((err: Error) => void) | null = null;
  const driverHandlers: Array<(frame: unknown) => void> = [];
  const receiptHandlers: Array<(list: unknown[], state: string) => void> = [];
  const agentsHandlers: Array<(slice: unknown) => void> = [];
  const busHandlers: Record<string, Array<(payload: unknown) => void>> = {};
  const actions: string[] = [];
  const confirms: Node[] = [];

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
    /* The decision dock (ui/screens/decision.js): a card handed a builder. The stub builds it
       into a node the test can read and press, and records that it was asked. */
    PhosphorDecision: {
      showCard: (build: (host: unknown, done: () => void) => void) => {
        const card = make('div');
        card.className = 'dock-card';
        confirms.push(card);
        build(card, () => { card.setAttribute('data-done', 'true'); });
      },
    },
    PhosphorApi: {
      driver: (body: { action: string; text?: string }) => {
        actions.push(body.action);
        if (body.action === 'prompt') {
          sends.push(String(body.text));
          return new Promise<void>((_, rej) => {
            reject = rej;
          });
        }
        return Promise.resolve({});
      },
      driverState: () => Promise.resolve({ data: { state: 'ready', chats: [{ id: 'c1', transcript: [] }] } }),
      connection: () => Promise.resolve({ command: options.command ?? '', connected: [] }),
    },
    PhosphorEvents: {
      on: (type: string, handler: (frame: unknown) => void) => {
        if (type === 'driver') driverHandlers.push(handler);
        else (busHandlers[type] ??= []).push(handler);
      },
    },
    /* The receipts feed (ui/screens/receipts.js): the column subscribes, asks for one read,
       and is handed the whole list on every change. The test delivers lists by hand. */
    PhosphorReceipts: {
      onChange: (fn: (list: unknown[], state: string) => void) => {
        receiptHandlers.push(fn);
        fn([], 'idle');
      },
      load: () => {},
    },
    PhosphorReceipt: {
      chainName: (id: string) => ({ base: 'Base', sol: 'Solana' })[id] ?? id,
      card: (receipt: unknown) => {
        built.push(receipt);
        const node = make('div');
        node.className = 'receipt-card';
        node.setAttribute('data-inline', 'true');
        return node;
      },
    },
    /* The shared icon set and the motion helper (foundation): one svg per name, no motion. */
    PhosphorIcons: { svg: (name: string, className: string) => { const n = make('svg'); n.className = 'icon ' + (className || ''); n.setAttribute('data-icon', name); return n; } },
    /* The motion helper (ui/design/motion.js): no reduced preference, and a value animation
       that lands on its end value at once, the way the browser would a few frames later. */
    PhosphorMotion: {
      reduced: () => false,
      spring: () => 'linear',
      animate: (_from: unknown, to: number, opts: { onUpdate?: (v: number) => void }) => {
        if (opts && typeof opts.onUpdate === 'function') opts.onUpdate(to);
        return { finished: Promise.resolve(), stop: () => {} };
      },
    },
    /* The state store: the column reads the roster slice for the connect sheet. */
    PhosphorState: {
      select: (key: string, fn: (slice: unknown) => void) => {
        if (key === 'agents') agentsHandlers.push(fn);
        return () => {};
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
  runInContext(MARKDOWN_SOURCE, sandbox, { filename: 'ui/core/markdown.js' });
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
    actions,
    confirms,
    fail: (message: string) => reject?.(new Error(message)),
    type(text: string) {
      input.value = text;
      fire(composer, 'submit');
    },
    saidRows: () => all(host, 'chat-said'),
    replyRows: () => all(host, 'chat-reply'),
    stepRows: () => all(host, 'step'),
    turnBar: () => all(composerHost, 'turn-bar')[0],
    seat: () => all(host, 'agent-seat')[0].getAttribute('data-seat'),
    card: () => all(host, 'agent-empty-inner')[0].textContent,
    cardHidden: () => all(host, 'agent-empty')[0].hidden,
    actionsHidden: () => all(host, 'agent-empty-actions')[0].hidden,
    /* The failure line under the status: hidden, or the one sentence plus its Retry. */
    note: () => all(host, 'agent-note')[0],
    noteText: () => all(host, 'agent-note-text')[0].textContent,
    retry: () => all(host, 'agent-retry')[0],
    sheet: () => all(host, 'agent-connect')[0],
    connectLine: () => all(host, 'connection-line')[0].textContent,
    connectStatus: () => all(host, 'agent-connect-status')[0].textContent,
    press: (label: string) => {
      const btn = all(host, 'btn').concat(all(host, 'chip')).find((b) => b.textContent === label);
      if (!btn) throw new Error(`no button "${label}"`);
      fire(btn, 'click');
    },
    agents: (members: unknown[]) => {
      for (const handler of agentsHandlers) handler({ members });
    },
    bus: (type: string, payload: unknown) => {
      for (const handler of busHandlers[type] ?? []) handler(payload);
    },
    noteRows: () => all(host, 'chat-note'),
    built,
    input,
    /* Fire every timer the column has booked. The starting floor is the one that matters, and a
       test that could not hold it open could not tell a state that stays from one that flickers. */
    runTimers() {
      const due = timers.splice(0, timers.length);
      for (const timer of due) timer.fn();
    },
    receipts: (list: unknown[]) => {
      for (const handler of receiptHandlers) handler(list, 'ready');
    },
    cards: () => all(host, 'receipt-card'),
    /* The scroller and the pill that offers the way back down. */
    list: () => all(host, 'transcript')[0],
    pill: () => all(host, 'jump-latest')[0],
    pillOn: () => all(host, 'jump-latest')[0].getAttribute('data-on') === 'true',
    pillCount: () => all(host, 'jump-count')[0].textContent,
    /* Put the person part way up a long transcript: the box is 400 tall, the content 2000,
       and the top is where they are reading. */
    scrollUp() {
      const list = all(host, 'transcript')[0];
      list.clientHeight = 400;
      list.scrollHeight = 2000;
      list.scrollTop = 1600;
      fire(list, 'scroll');
      list.scrollTop = 0;
      fire(list, 'scroll');
    },
  };
}

/* A receipt as /api/receipts hands it out (src/http/receipts.ts), for one executed swap. */
function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    kind: 'swap',
    at: new Date(Date.now() + 1000).toISOString(),
    headline: 'Changed about $5 of your Solana (SOL) into USDC.',
    summary: 'swapped 0.049 SOL for 4.981119 USDC, intent hash EafozJ2XkQ9mRtb7n16c',
    fromChain: 'intents',
    toChain: 'intents',
    amount: 0.049,
    symbol: 'SOL',
    received: { symbol: 'USDC', amount: 4.981119 },
    feesUsd: 0.02,
    txids: [{ chain: 'near', hash: 'EafozJ2XkQ9mRtb7n16c', url: null }],
    balanceBefore: 1000,
    balanceAfter: 999.98,
    status: 'executed',
    ...over,
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
  /* "scanning the timeframes" is a category of work. "scanning the timeframes, SOL-USD" is
     evidence the app is working on the thing that was asked for, and the tool event already
     carried it. */
  const world = build();
  world.type('what is sol doing');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_scan', input: { product: 'SOL-USD', timeframes: ['1h'] } });
  const text = world.stepRows()[0].textContent;
  assert.ok(text.includes('scanning the timeframes'), text);
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

test('the seat light in the head names the open call in its own words and settles to Ready', () => {
  /* The head carried a pill that said "Working" in a border. The status line says what the work
     is, in the words the step row uses, and goes back to the state word when the turn is over. */
  const world = build();
  const status = all(world.host, 'agent-status')[0];
  const verb = all(status, 'status-verb')[0];
  const elapsed = all(status, 'status-elapsed')[0];
  assert.equal(status.getAttribute('data-state'), 'ready');
  assert.equal(verb.textContent, 'Ready');
  assert.equal(elapsed.hidden, true, 'a clock with nothing to time');

  world.type('what is btc doing');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: { product: 'BTC-USD' } });
  assert.equal(status.getAttribute('data-state'), 'working');
  assert.equal(verb.textContent, 'Reading the chart');
  assert.equal(elapsed.hidden, false);
  assert.ok(/\d s$/.test(elapsed.textContent), elapsed.textContent);
  /* The head is the live clock; the row is the record. While the call runs the row carries no
     seconds (the head is counting them, one screen up), and it gets its duration when the
     call settles. */
  const rowTime = () => all(world.stepRows()[0], 'step-time')[0].textContent;
  assert.equal(rowTime(), '', 'the live row counted the same seconds as the head');

  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__chart_read', ok: true });
  assert.ok(/^\d+(\.\d)? s$/.test(rowTime()), `a settled row has no duration: "${rowTime()}"`);
  assert.equal(verb.textContent, 'Thinking');
  world.emit({ kind: 'text', text: 'Up on the 15m.' });
  assert.equal(verb.textContent, 'Writing the answer');

  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  world.emit({ kind: 'status', state: 'ready' });
  assert.equal(status.getAttribute('data-state'), 'ready');
  assert.equal(verb.textContent, 'Ready');
  assert.equal(elapsed.hidden, true);
  assert.equal(status.getAttribute('data-live'), null, 'the column wrote the attribute the beam owns');
});

test('the composer arms on text and leaves the screen when nobody of ours can take a message', () => {
  const world = build();
  const composer = all(world.composerHost, 'agent-composer')[0];
  const field = all(world.composerHost, 'composer-field')[0];
  assert.equal(composer.hidden, false, 'a Ready assistant has no box to talk into');
  assert.equal(world.input.placeholder, 'Ask, or tell it what to do');
  assert.equal(field.getAttribute('data-armed'), null);
  world.input.value = 'hello';
  fire(world.input, 'input');
  assert.equal(field.getAttribute('data-armed'), 'true');
  world.type('hello');
  assert.equal(field.getAttribute('data-armed'), null, 'the arrow stayed lit after the message went');

  /* Off: the card says what to do, so a dead box under it with a dead send button is gone. */
  world.emit({ kind: 'status', state: 'off' });
  assert.equal(composer.hidden, true, 'a box nobody can use stayed on screen');
  assert.equal(world.input.disabled, true);
  assert.equal(all(world.host, 'suggest').length, 3, 'the empty card offers three first moves');
  world.emit({ kind: 'status', state: 'starting' });
  assert.equal(composer.hidden, true, 'the box came back before the assistant did');
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  assert.equal(composer.hidden, false, 'the box did not come back with the assistant');
});

test('a client of the person\'s own at the wheel reads Connected in the head, with no composer', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  const status = all(world.host, 'agent-status')[0];
  const verb = all(world.host, 'status-verb')[0];
  const composer = all(world.composerHost, 'agent-composer')[0];
  assert.equal(verb.textContent, 'Off');
  assert.equal(status.getAttribute('data-state'), 'off');

  /* The roster names somebody: the seat is taken, though nothing of ours is at work. */
  world.agents([{ client: 'claude-code', role: 'operator', ops: 2 }]);
  assert.equal(verb.textContent, 'Connected', 'the head said Off over a card saying somebody was at the wheel');
  assert.equal(status.getAttribute('data-state'), 'connected');
  assert.equal(world.seat(), 'own');
  assert.ok(world.card().includes('Your own agent is at the wheel.'), world.card());
  assert.ok(world.card().includes('Talk to it from its own terminal.'), world.card());
  assert.equal(composer.hidden, true, 'a box that cannot reach the attached client was offered');

  world.agents([]);
  assert.equal(verb.textContent, 'Off');
  assert.equal(status.getAttribute('data-state'), 'off');
  assert.equal(composer.hidden, true);
});

test('a first move on a live column asks its question at once', () => {
  const world = build();
  const rows = all(world.host, 'suggest');
  fire(rows[0], 'click');
  assert.deepEqual(world.sends, [rows[0].textContent]);
  assert.equal(world.input.value, '', 'the words stayed in the box after they were sent');
  assert.ok(!world.actions.includes('start'), 'a running assistant was started again');
});

test('a first move on a quiet column starts the assistant and asks once it is ready', () => {
  /* It used to write the words into a box the column keeps disabled while nobody is at the
     wheel, so "What do I hold?" sat grey over the placeholder that had just explained why the
     box was quiet. The press is the question, so it takes the same door as Start. */
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  const rows = all(world.host, 'suggest');
  fire(rows[1], 'click');
  assert.deepEqual(world.actions, ['start'], 'the press did not start the assistant');
  assert.deepEqual(world.sends, [], 'the question went out before anybody was there to hear it');
  assert.equal(world.input.value, rows[1].textContent, 'the words are not waiting in the box');
  assert.equal(world.seat(), 'coming');

  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  assert.deepEqual(world.sends, [rows[1].textContent], 'the seat came up and the question was not asked');
  assert.equal(world.input.value, '');
  assert.equal(world.saidRows().length, 1);
});

test('a first move whose start fails keeps its words in the box and sends nothing', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  const rows = all(world.host, 'suggest');
  fire(rows[2], 'click');
  world.emit({ kind: 'status', state: 'failed', detail: 'driver: the claude CLI was not found.', reason: 'Claude Code is not installed on this Mac.' });
  world.runTimers();
  assert.deepEqual(world.sends, []);
  assert.equal(world.input.value, rows[2].textContent, 'the words were lost with the start');
  assert.equal(world.input.disabled, true);
  assert.equal(world.note().hidden, false, 'nothing under the status says what went wrong');
  assert.equal(world.noteText(), 'Claude Code is not installed on this Mac.');

  /* A later start that works does not fire the old question on its own: the failure ended the
     press, and the words are in the box for the person to send. */
  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  assert.deepEqual(world.sends, [], 'a question from a failed press sent itself on the next start');
  assert.equal(world.input.value, rows[2].textContent);
});

/* ---------- The receipt card ----------

   Karim, 2026-09-14, on the assistant's prose after a swap (a line, a Sold / Received / Fee /
   Where table, the id, a balance sentence): "when trades happen I dont want to see this, I want
   to see a nice card, simple, no unnecessary info, and the intent id should be a clickable link".
   The card is drawn from the app's own receipt, never from what the assistant wrote. */

test('a move that lands mid conversation posts one shared card, drawn from the receipt', () => {
  const world = build();
  world.receipts([]);
  world.type('swap 0.049 sol to usdc');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__swap', input: { amount: 0.049, symbol: 'SOL' } });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__swap', ok: true });
  world.receipts([receipt()]);

  assert.equal(world.cards().length, 1);
  /* Built by PhosphorReceipt.card from the app's own receipt, untouched: the headline, the id
     and the url the server built all reach the card, which decides its own link from them. */
  assert.equal(world.built.length, 1);
  const handed = world.built[0] as Record<string, unknown>;
  assert.equal(handed.headline, 'Changed about $5 of your Solana (SOL) into USDC.');
  assert.deepEqual(handed.txids, [{ chain: 'near', hash: 'EafozJ2XkQ9mRtb7n16c', url: null }]);
  assert.equal(world.cards()[0].getAttribute('data-inline'), 'true', 'the thread got the popover, not the inline card');
  // The card closed the steps block, so the next call starts a new one under the card.
  world.emit({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} });
  const order = all(world.host, 'transcript')[0].children.map((n) => n.className.split(' ')[0]);
  assert.deepEqual(order.slice(-2), ['receipt-card', 'steps-block'], order.join(' > '));
});

test("the explorer url the server built reaches the card untouched, so the card can link it", () => {
  const world = build();
  world.receipts([]);
  const url = 'https://basescan.org/tx/0xabc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890ab';
  const txids = [{ chain: 'base', hash: '0xabc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890ab', url }];
  world.receipts([receipt({ id: 'p2', toChain: 'base', txids })]);
  assert.equal(world.cards().length, 1);
  const handed = world.built[0] as Record<string, unknown>;
  assert.deepEqual(handed.txids, txids, 'the column rewrote the receipt on its way to the card');
  assert.equal(handed.toChain, 'base');
});

test('only a move that executed in this session gets a card, and only once', () => {
  const world = build();
  const old = receipt({ id: 'old', at: new Date(Date.now() - 60_000).toISOString() });
  const failed = receipt({ id: 'bad', status: 'failed' });
  world.receipts([failed, old]);
  assert.equal(world.cards().length, 0, 'what happened before the window opened is the Activity list, not a card');
  world.receipts([receipt(), failed, old]);
  assert.equal(world.cards().length, 1);
  world.receipts([receipt(), failed, old]);
  assert.equal(world.cards().length, 1, 'a re-read of the same list drew the card again');
  world.receipts([receipt({ id: 'bad', status: 'executed' }), receipt(), old]);
  assert.equal(world.cards().length, 2, 'a move read back as executed after failing got no card');
});

test('text that follows text in one turn is one reply row', () => {
  /* A model answers in blocks: a heading, then a table, then a sentence. Each arrived as its own
     event and drew its own row, so one answer read as three replies with air between them. */
  const world = build();
  world.type('what do you see');
  world.emit({ kind: 'text', text: '## Levels' });
  world.emit({ kind: 'text', text: '| Level | Price |\n|---|---:|\n| Support | 63,200 |' });
  world.emit({ kind: 'text', text: 'Bias is up.' });
  assert.equal(world.replyRows().length, 1, 'one answer drew three rows');
  const row = world.replyRows()[0];
  assert.ok(row.textContent.includes('Levels'));
  assert.ok(row.textContent.includes('Bias is up.'));

  // A tool call between two texts is a break: the second text is a new reply after work.
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: {} });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__chart_read', ok: true });
  world.emit({ kind: 'text', text: 'And after reading it, still up.' });
  assert.equal(world.replyRows().length, 2);
});

test('a reply renders as elements and never as markup', () => {
  const world = build();
  world.type('table please');
  world.emit({ kind: 'text', text: '| Level | Price |\n|---|---:|\n| Support | 63,200 |\n\n<b onclick="x()">bold</b> **real**' });
  const row = world.replyRows()[0];
  const tables = all(row, 'chat-table');
  assert.equal(tables.length, 1, 'a GFM table did not become a table');
  assert.equal(tables[0].children[0].tag, 'table');
  assert.ok(row.textContent.includes('<b onclick="x()">bold</b>'), 'markup in a reply was parsed rather than printed');
  const walk = (n: Node, out: string[] = []): string[] => {
    out.push(n.tag);
    for (const c of n.children) walk(c, out);
    return out;
  };
  assert.ok(!walk(row).includes('b'));
  assert.ok(walk(row).includes('strong'));
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

test('a start that failed says so under the status, in plain words, with a Retry', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'failed', detail: 'driver: the claude CLI was not found. Install Claude Code.', reason: 'Claude Code is not installed on this Mac.' });
  /* The technical line follows on the error channel, exactly as src/driver.ts fail() sends it. */
  world.emit({ kind: 'error', message: 'driver: the claude CLI was not found. Install Claude Code.' });
  world.runTimers();
  assert.equal(world.seat(), 'error');
  assert.equal(world.noteText(), 'Claude Code is not installed on this Mac.');
  assert.equal(all(world.host, 'agent-status')[0].getAttribute('data-failed'), 'true');
  assert.ok(!world.card().includes('driver:'), 'the raw driver string reached the card');
  assert.equal(world.cardHidden(), false, 'the failure buried the card under a row');
  assert.equal(world.saidRows().length + world.replyRows().length + world.noteRows().length, 0, 'the technical line was printed as a row');
  assert.equal(world.actionsHidden(), false, 'no way back from a failed start');
  world.press('Retry');
  assert.deepEqual(world.actions, ['start'], 'Retry did not start the assistant');
  assert.equal(world.note().hidden, true, 'the old reason is still up while a new start runs');
});

test('while it starts the card says so once and the status line says Starting', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting', detail: 'Starting your assistant.' });
  assert.equal(world.note().hidden, true, 'a failure line is up with nothing having failed');
  assert.ok(world.card().includes('Starting your assistant.'));
  assert.equal(all(world.host, 'status-verb')[0].textContent, 'Starting...');
});

test('an assistant that leaves mid conversation says why under the status, and Turn off says nothing', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  world.type('hello');
  assert.equal(world.cardHidden(), true);

  world.emit({ kind: 'status', state: 'stopped', detail: 'the agent exited with code 1', reason: 'The assistant stopped: it exited with code 1.' });
  assert.equal(world.note().hidden, false, 'with the card gone, nothing carries the reason');
  assert.equal(world.noteText(), 'The assistant stopped: it exited with code 1.');
  assert.equal(world.input.disabled, true, 'the box is open with nobody to send to');
  assert.equal(all(world.host, 'status-verb')[0].textContent, 'Off');

  /* A stop the person asked for: the state word alone. */
  world.press('Retry');
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  world.emit({ kind: 'status', state: 'stopped' });
  assert.equal(world.note().hidden, true, 'Turn off was reported as a failure');
  assert.equal(world.input.disabled, true);
});

test('a first move on a quiet column whose start never reports back says so, and Retry starts again', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  const rows = all(world.host, 'suggest');
  fire(rows[0], 'click');
  assert.equal(all(world.host, 'status-verb')[0].textContent, 'Starting...');
  /* Nothing comes back. The start watch fires, and the failure waits the starting floor. */
  world.runTimers();
  world.runTimers();
  assert.equal(world.noteText(), 'The assistant did not answer in time.');
  assert.equal(world.input.value, rows[0].textContent, 'the words were lost with the start');
  world.press('Retry');
  assert.deepEqual(world.actions, ['start', 'start']);
});

test('the connect sheet takes the card\'s place and closes the moment somebody is at the wheel', async () => {
  const world = build({ command: 'claude mcp add phosphor -- node /repo/src/mcp.ts' });
  /* The command arrives from the backend after mount. */
  await new Promise((r) => setImmediate(r));
  world.emit({ kind: 'status', state: 'off' });
  assert.equal(world.sheet().hidden, true);
  world.press('Connect your own');
  assert.equal(world.sheet().hidden, false);
  assert.equal(world.cardHidden(), true, 'the sheet went over the card rather than in its place');
  assert.equal(world.connectLine(), 'claude mcp add phosphor -- node /repo/src/mcp.ts');
  assert.ok(world.connectStatus().includes('Waiting for a connection'));

  /* A client attaching flips the line; it is read off the state frame's roster. */
  world.agents([{ client: 'claude-code', role: 'operator', ops: 2 }]);
  assert.ok(world.connectStatus().includes('Connected'));
  world.agents([]);

  world.press('Back');
  assert.equal(world.sheet().hidden, true);
  assert.equal(world.cardHidden(), false);

  /* Open again, then start: the sheet is not a thing a Ready card can carry. */
  world.press('Connect your own');
  world.emit({ kind: 'status', state: 'starting' });
  assert.equal(world.sheet().hidden, true, 'the mcp-add block survived the start');
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  assert.equal(world.sheet().hidden, true, 'the Ready card carries the mcp-add block');
  assert.ok(world.card().includes('at the wheel'));
});

test('the child\'s stderr is a quiet note that does not bury the card', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  world.emit({ kind: 'error', message: '(node) some deprecation warning' });
  assert.equal(world.noteRows().length, 1);
  assert.equal(world.cardHidden(), false, 'a stderr line replaced the card');
  assert.equal(all(world.host, 'chat-error').length, 0, 'a stderr line was drawn as a stopped row');
});

test('while an answer runs the composer button is Stop, and it interrupts', () => {
  const world = build();
  world.type('read the chart');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: {} });
  const field = all(world.composerHost, 'composer-field')[0];
  assert.equal(field.getAttribute('data-mode'), 'stop');
  const composer = all(world.composerHost, 'agent-composer')[0];
  fire(composer, 'submit');
  assert.ok(world.actions.includes('interrupt'), 'the press did not stop the answer');
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  world.emit({ kind: 'status', state: 'ready' });
  assert.equal(field.getAttribute('data-mode'), null);
});

test('a receipt opened anywhere in the window is posted into the thread as the shared card', () => {
  const world = build();
  world.bus('receipt:open', { receipt: receipt(), source: 'activity' });
  assert.equal(world.cards().length, 1);
  assert.equal((world.built[0] as Record<string, unknown>).id, 'p1');
  assert.equal(world.cardHidden(), true, 'a card in the thread and the empty card at once');
});

test('Turn off asks first, on a card of its own, and only the card\'s Turn off quits: the process stops and the chat closes', async () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  world.press('Turn off');
  assert.deepEqual(world.actions, [], 'the process was stopped before the person confirmed');
  assert.equal(world.confirms.length, 1, 'no confirmation card');
  const card = world.confirms[0];
  const words = all(card, 'title').map((n) => n.textContent);
  assert.deepEqual(words, ['Turn your assistant off?']);
  const buttons = all(card, 'btn').map((n) => n.textContent);
  assert.deepEqual(buttons, ['Keep it on', 'Turn off']);

  /* Keep it on: the card goes and nothing was sent. */
  fire(all(card, 'btn')[0], 'click');
  assert.equal(card.getAttribute('data-done'), 'true');
  assert.deepEqual(world.actions, []);

  /* Turn off on the card: stop, then close, in that order. */
  world.press('Turn off');
  const again = world.confirms[1];
  fire(all(again, 'btn')[1], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(world.actions, ['stop', 'close']);
});

/* ---------- scrolling ---------- */

test('new content while the person is scrolled up leaves the scroll alone and offers the way down', () => {
  const world = build();
  world.type('what do I hold?');
  world.emit({ kind: 'text', text: 'You hold two coins.' });
  assert.equal(world.pillOn(), false, 'the pill is up while the person is at the end');

  world.scrollUp();
  world.emit({ kind: 'text', text: 'Most of it is USDC.' });
  assert.equal(world.list().scrollTop, 0, 'a new block moved a person who had scrolled up');
  assert.equal(world.pillOn(), true, 'nothing told them a row landed');
  assert.equal(world.pillCount(), '', 'one arrival is not a count');

  /* A second arrival counts, and the count is of what they have not seen. */
  world.emit({ kind: 'said', text: 'and my positions?' }, 'c1');
  assert.equal(world.pillCount(), '2');
  assert.equal(world.list().scrollTop, 0);
});

test('pressing the pill scrolls to the end and puts the pill away', () => {
  const world = build();
  world.type('what do I hold?');
  world.scrollUp();
  world.emit({ kind: 'text', text: 'Two coins.' });
  assert.equal(world.pillOn(), true);
  fire(world.pill(), 'click');
  assert.equal(world.list().scrollTop, world.list().scrollHeight - world.list().clientHeight, 'the jump did not reach the end');
  assert.equal(world.pillOn(), false, 'the pill outlived the jump');
});

test('sending a message always scrolls to the end, however far up the person was', () => {
  const world = build();
  world.type('what do I hold?');
  world.emit({ kind: 'text', text: 'Two coins.' });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  world.emit({ kind: 'status', state: 'ready' });
  world.scrollUp();
  /* A row from a second window on the same chat lands while they are up. */
  world.emit({ kind: 'said', text: 'is anything waiting on me?' });
  assert.equal(world.pillOn(), true);
  world.type('and my positions?');
  assert.equal(world.list().scrollTop, world.list().scrollHeight - world.list().clientHeight, 'their own message landed off screen');
  assert.equal(world.pillOn(), false);
});

test('a reply that grows keeps the paragraphs it already drew and appends the new ones', () => {
  const world = build();
  world.type('what do I hold?');
  world.emit({ kind: 'text', text: 'You hold two coins.' });
  const row = world.replyRows()[0];
  const first = all(row, 'chat-p')[0];
  assert.ok(first, 'no paragraph was drawn');
  world.emit({ kind: 'text', text: 'Most of it is USDC.' });
  assert.equal(world.replyRows().length, 1, 'text that follows text made a second row');
  const paragraphs = all(row, 'chat-p');
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0], first, 'the first paragraph was rebuilt rather than kept');
  assert.equal(paragraphs[1].textContent, 'Most of it is USDC.');
});
