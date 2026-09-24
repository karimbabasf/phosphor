// What the conversation column shows a person while their agent is working.
//
// The trust-boundary properties are asserted next door in agent-panel-ui.test.ts. This file is
// about the other half of the column's job, which is telling the truth about what is happening,
// calmly: one row per thing the human said, one quiet working line with the step in plain words
// while the agent is at it, the reply streamed as it is written, no clock anywhere, and a column
// that stays at its end while the person is there and holds still when they scroll up to read.
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
const MARKS_SOURCE = readFileSync(new URL('../../ui/design/marks.js', import.meta.url), 'utf8');

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
  querySelector(selector: string): Node | null;
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
    style: { setProperty(name: string, value: string) { (this as Record<string, unknown>)[name] = value; } } as Record<string, any>,
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
  /* A class selector is enough for the column: it asks a button for its .btn-label. */
  node.querySelector = (selector: string) => {
    if (!selector.startsWith('.')) return null;
    for (const child of node.children) {
      const found = all(child, selector.slice(1))[0];
      if (found) return found;
    }
    return null;
  };
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

function build(options: { command?: string; driverData?: Record<string, unknown> } = {}) {
  const sends: string[] = [];
  /* The shared receipt card (ui/screens/receipt.js) is somebody else's: the column hands it the
     receipt and places what comes back. The stub records what it was handed and returns one
     marker node, so a test can say the card was posted and built from the app's own receipt
     without asserting the card's insides, which receipt-ui.test.ts owns. */
  const built: unknown[] = [];
  let reject: ((err: Error) => void) | null = null;
  const driverHandlers: Array<(frame: unknown) => void> = [];
  const agentsHandlers: Array<(slice: unknown) => void> = [];
  const busHandlers: Record<string, Array<(payload: unknown) => void>> = {};
  const windowHandlers: Record<string, Array<() => void>> = {};
  const actions: string[] = [];

  const host = make('div');
  const composerHost = make('div');

  const root = { dataset: {} as Record<string, string> };
  const sizes: Array<() => void> = [];
  const sandbox: Record<string, unknown> = {
    console,
    navigator: {},
    document: { createElement: (tag: string) => make(tag), addEventListener: () => {}, documentElement: root },
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
    addEventListener: (type: string, handler: () => void) => { (windowHandlers[type] ??= []).push(handler); },
    PhosphorNet: { readable: (e: Error) => String(e.message) },
    PhosphorShell: { setPending: () => {} },
    PhosphorToast: { show: () => {} },
    /* The observer the column pins its end with: fired by hand, the way a row that grew would. */
    ResizeObserver: function ResizeObserverStub(this: Record<string, unknown>, fn: () => void) {
      sizes.push(fn);
      this.observe = () => {};
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
      driverState: () => Promise.resolve({ data: Object.assign({ state: 'ready', chats: [{ id: 'c1', transcript: [] }] }, options.driverData ?? {}) }),
      connection: () => Promise.resolve({ command: options.command ?? '', connected: [] }),
    },
    PhosphorEvents: {
      on: (type: string, handler: (frame: unknown) => void) => {
        if (type === 'driver') driverHandlers.push(handler);
        else (busHandlers[type] ??= []).push(handler);
      },
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
  runInContext(MARKS_SOURCE, sandbox, { filename: 'ui/design/marks.js' });
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
    /* A card another screen asked to show, at the thread's end (PhosphorAgent.showCard). */
    sheets: () => all(host, 'chat-sheet-card'),
    showCard: (fill: (host: Node, done: () => void) => void, opts?: Record<string, unknown>) => (win.PhosphorAgent as { showCard: (b: unknown, o: unknown) => void }).showCard(fill, opts),
    root,
    /* A row grew, a card opened, the window changed size: the observer's call. */
    grew() {
      for (const fn of sizes) fn();
    },
    fail: (message: string) => reject?.(new Error(message)),
    type(text: string) {
      input.value = text;
      fire(composer, 'submit');
    },
    saidRows: () => all(host, 'chat-said'),
    replyRows: () => all(host, 'chat-reply'),
    stepRows: () => all(host, 'step'),
    /* The one quiet line while the agent works: the mark and the step in plain words. */
    working: () => all(host, 'chat-working')[0],
    workingWords: () => all(host, 'chat-working-words')[0]?.textContent ?? null,
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
    /* An event on the window, the way another screen says something to the column. */
    windowEvent: (type: string) => {
      for (const handler of windowHandlers[type] ?? []) handler();
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
    cards: () => all(host, 'receipt-card'),
    /* The scroller and Latest, the quiet way back down. */
    list: () => all(host, 'transcript')[0],
    pill: () => all(host, 'jump-latest')[0],
    pillOn: () => all(host, 'jump-latest')[0].getAttribute('data-on') === 'true',
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
  assert.equal(world.working(), undefined, 'the working line stayed up for a turn that never started');
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
  /* An id on the row is its two ends: the whole one is on the card, behind its Copy (3.1). */
  world.emit({ kind: 'tool', name: 'mcp__phosphor__proposal_status', input: { id: 'ca99ad08-2677-4b50-aaa2-e08e5b709af4' } });
  const read = world.stepRows()[1].textContent;
  assert.ok(read.includes('ca99ad08...5b709af4'), read);
  assert.ok(!read.includes('ca99ad08-2677'), 'the whole id is on the step row: ' + read);
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

test('one quiet line says what the agent is doing, and it becomes the reply when the words arrive', () => {
  /* The two longest silences in a turn (before the first call, and while the answer is written)
     used to have nothing on screen, and then a head clock, a step row and a turn bar all said the
     same thing at once. Now there is one line, the mark and the step in plain words, and nothing
     at all once the reply itself is arriving. */
  const world = build();
  assert.equal(world.working(), undefined);

  world.type('what am I holding');
  assert.equal(world.workingWords(), 'Thinking');
  const rows = all(world.host, 'transcript-rows')[0].children;
  assert.equal(rows[rows.length - 1], world.working(), 'the working line is not at the thread\'s end');

  world.emit({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} });
  assert.equal(world.workingWords(), 'Reading your wallet');
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__wallet', ok: true });
  assert.equal(world.workingWords(), 'Thinking');

  world.emit({ kind: 'text', text: 'You hold 3.27 dollars.' });
  assert.equal(world.working(), undefined, 'the working line stayed under the reply');
  assert.equal(world.replyRows().length, 1);

  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.equal(world.working(), undefined);
});

test('no clock ticks anywhere in the conversation', () => {
  /* Karim, 2026-09-23: three clocks ticked (the head at ten a second, "1 step, 0.0 s", "12s of
     about 30s"). A working agent is a line of words; a late move says so on its own card. */
  assert.doesNotMatch(AGENT_SOURCE, /setInterval/, 'agent.js runs a timer');
  const world = build();
  world.type('what is btc doing');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: { product: 'BTC-USD' } });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__chart_read', ok: true });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.equal(all(world.host, 'status-elapsed').length, 0, 'the head still carries a clock');
  assert.equal(all(world.host, 'step-time').length, 0, 'a step row still carries a duration');
  assert.doesNotMatch(world.host.textContent, /\d+(\.\d)? s\b/, 'seconds are printed in the column');
});

test('the chat tells the header mark whether it is idle, working or done', () => {
  const world = build();
  assert.equal(world.root.dataset.agent, 'idle');
  world.type('what do I hold?');
  assert.equal(world.root.dataset.agent, 'working');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} });
  assert.equal(world.root.dataset.agent, 'working');
  world.emit({ kind: 'text', text: 'Two coins.' });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  world.emit({ kind: 'status', state: 'ready' });
  assert.equal(world.root.dataset.agent, 'done');
  world.type('and my positions?');
  assert.equal(world.root.dataset.agent, 'working');
  world.emit({ kind: 'status', state: 'stopped' });
  assert.equal(world.root.dataset.agent, 'idle');
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

test('a client of the person\'s own that is working is named on the card, with no composer', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  const composer = all(world.composerHost, 'agent-composer')[0];
  assert.equal(world.seat(), 'off');

  /* The roster names somebody: the seat is taken, though nothing of ours is at work. */
  world.agents([{ client: 'claude-code', role: 'operator', ops: 2 }]);
  assert.equal(world.seat(), 'own');
  assert.ok(world.card().includes('Your own agent is working.'), world.card());
  assert.ok(world.card().includes('Talk to it from its own terminal.'), world.card());
  assert.equal(composer.hidden, true, 'a box that cannot reach the attached client was offered');

  world.agents([]);
  assert.equal(world.seat(), 'off');
  assert.equal(composer.hidden, true);
});

test('idle connections fold into one quiet row and are not called a working agent', () => {
  // Karim, 2026-09-18, with five rows reading "phosphor-mcp, can ask · 0 calls" over a card
  // saying "Your own agent is at the wheel": "this also looks like a bug". Every Claude Code
  // session on the Mac starts the proxy, which announces itself on boot, so the roster held five
  // members that had never made a call. Attached is not driving.
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  const idle = (n: number) => Array.from({ length: n }, (_, i) => ({ session: 's' + i, client: 'claude-code', label: 'claude-code', role: 'operator', ops: 0 }));

  world.agents(idle(5));
  assert.equal(world.seat(), 'own', 'five connections are still a connection');
  let rows = all(world.host, 'agent-client');
  assert.equal(rows.length, 1, 'five idle connections drew ' + rows.length + ' rows');
  assert.equal(rows[0].getAttribute('data-idle'), 'true');
  assert.equal(rows[0].textContent, '5 connected, none has made a call yet');
  assert.ok(world.card().includes('Your own agents are connected.'), world.card());
  assert.ok(world.card().includes('None has made a move yet.'), world.card());
  assert.ok(!world.card().includes('at the wheel'), world.card());
  assert.ok(!world.card().includes('is working'), world.card());

  /* One of them goes to work: it gets its own row, named, and the rest stay folded. */
  const five = idle(5);
  five[2] = { ...five[2], ops: 3 };
  world.agents(five);
  rows = all(world.host, 'agent-client');
  assert.equal(rows.length, 2, rows.map((r) => r.textContent).join(' | '));
  assert.equal(rows[0].textContent, 'claude-code, can ask3 calls');
  assert.equal(rows[0].getAttribute('data-idle'), null);
  assert.equal(rows[1].textContent, '4 more connected, idle');
  assert.ok(world.card().includes('Your own agent is working.'), world.card());

  /* One idle connection is said in the singular. */
  world.agents(idle(1));
  rows = all(world.host, 'agent-client');
  assert.equal(rows[0].textContent, '1 connected, no call yet');
  assert.ok(world.card().includes('Your own agent is connected.'), world.card());
  assert.ok(world.card().includes('It has not made a move yet.'), world.card());

  /* A row is named by its label when it has one, which is how a spawned worker is told apart. */
  world.agents([{ session: 'w', client: 'claude-code', label: 'Analyst 2', role: 'analyst', ops: 4 }]);
  rows = all(world.host, 'agent-client');
  assert.equal(rows[0].textContent, 'Analyst 2, read only4 calls');
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
  /* With no conversation yet the failure is the centre card's, with Retry in Start's place
     (hunt A, 2026-09-23: the reason sat in 13 px text in the corner). */
  assert.ok(world.card().includes('Your agent stopped.'), world.card());
  assert.ok(world.card().includes('Claude Code is not installed on this Mac.'), world.card());
  assert.equal(world.note().hidden, true, 'the failure is said twice, in the corner as well');

  /* A later start that works does not fire the old question on its own: the failure ended the
     press, and the words are in the box for the person to send. */
  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  assert.deepEqual(world.sends, [], 'a question from a failed press sent itself on the next start');
  assert.equal(world.input.value, rows[2].textContent);
});

/* ---------- Receipts ----------

   A move made anywhere has one card, in the thread, drawn from its row and changed in place
   (agent-cards-ui.test.ts). The chat's own receipt feed never ran and is gone, and a receipt
   opened from Activity opens there: the thread is not posted a second card for the same money. */

test('a receipt opened elsewhere in the window posts nothing into the thread', () => {
  const world = build();
  world.bus('receipt:open', { receipt: receipt(), source: 'activity' });
  assert.equal(world.cards().length, 0);
  assert.equal(world.built.length, 0);
  assert.equal(world.cardHidden(), false, 'a receipt took the empty card\'s place');
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

test('an agent that stops mid answer takes the working line with it', () => {
  const world = build();
  world.type('read the chart');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: {} });
  assert.ok(world.working());

  world.emit({ kind: 'status', state: 'stopped' });
  assert.equal(world.working(), undefined, 'the line stayed up for an agent that had stopped');
});

test('the working line says the step in plain words, and the arguments stay in developer mode', () => {
  const world = build();
  world.type('read the news');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__research', input: { query: 'SOL funding' } });
  assert.equal(world.workingWords(), 'Reading the news');
  assert.equal(world.stepRows()[0].textContent.includes('SOL funding'), true);
  assert.equal(all(world.host, 'steps-block')[0].getAttribute('data-dev-only'), '', 'the step row shows outside developer mode');
});

/* ---------- Streaming ----------

   Replies used to arrive one whole model block at a time: nothing, then a paragraph. The driver
   streams the words as they are written (contract 4, src/driver.ts): `{ kind: 'delta', block,
   text }` for each piece, then the `text` event with the same block number, whole. */

test('a reply streams into one row as it is written, and the whole block takes its place', () => {
  const world = build();
  world.type('what do I hold?');
  world.emit({ kind: 'delta', block: 1, text: 'You hold ' });
  assert.equal(world.working(), undefined, 'the working line stayed up while words arrived');
  assert.equal(world.replyRows().length, 1);
  assert.equal(all(world.replyRows()[0], 'chat-text')[0].textContent, 'You hold ');
  world.emit({ kind: 'delta', block: 1, text: 'two coins.' });
  assert.equal(all(world.replyRows()[0], 'chat-text')[0].textContent, 'You hold two coins.');
  assert.equal(world.replyRows()[0].getAttribute('data-streaming'), 'true');
  /* The block, whole: it replaces what streamed rather than printing it twice. */
  world.emit({ kind: 'text', text: 'You hold two coins.', block: 1 });
  assert.equal(world.replyRows().length, 1);
  assert.equal(all(world.replyRows()[0], 'chat-text')[0].textContent, 'You hold two coins.');
  assert.equal(world.replyRows()[0].getAttribute('data-streaming'), null);
  /* The next block of the same reply streams under it, on a new paragraph. */
  world.emit({ kind: 'delta', block: 2, text: 'Most of it is USDC.' });
  assert.equal(world.replyRows().length, 1);
  assert.equal(all(world.replyRows()[0], 'chat-p').length, 2);
  world.emit({ kind: 'text', text: 'Most of it is USDC.', block: 2 });
  assert.equal(all(world.replyRows()[0], 'chat-p').map((p) => p.textContent).join(' | '), 'You hold two coins. | Most of it is USDC.');
  /* Work between two stretches of words starts a new reply after it. */
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: {} });
  assert.equal(world.workingWords(), 'Reading the chart');
  world.emit({ kind: 'delta', block: 3, text: 'And the chart is up.' });
  assert.equal(world.replyRows().length, 2);
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
   transcript and nothing else, so it went on saying nobody was there and offering a Start
   button for the whole time an agent was up and simply had not been spoken to yet. The chip in the
   corner changed. Nothing he was looking at did. */

test('the card says nobody is there only when nobody is there', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'off' });
  assert.equal(world.seat(), 'off');
  assert.ok(world.card().includes('Your agent is off.'), world.card());
  assert.ok(!world.card().includes('at the wheel'), 'the card still says the agent drives');
  assert.equal(world.actionsHidden(), false, 'Start is the thing to do here and it is not offered');
});

test('an agent that is up does not get asked to start again', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'ready' });
  assert.equal(world.seat(), 'live');
  assert.ok(world.card().includes('Your agent is ready.'), world.card());
  assert.ok(!world.card().includes('is off'), 'the card still says a running agent is off');
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

test('a start that failed says so on the centre card, in plain words, with a Retry in Start\'s place', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'failed', detail: 'driver: the claude CLI was not found. Install Claude Code.', reason: 'Claude Code is not installed on this Mac.' });
  /* The technical line follows on the error channel, exactly as src/driver.ts fail() sends it. */
  world.emit({ kind: 'error', message: 'driver: the claude CLI was not found. Install Claude Code.' });
  world.runTimers();
  assert.equal(world.seat(), 'error');
  assert.ok(world.card().includes('Claude Code is not installed on this Mac.'), world.card());
  assert.ok(world.card().includes('Retry'), 'the card offers no way back');
  assert.ok(!world.card().includes('Start your agent'), 'the card offers a plain Start over a failure');
  assert.ok(!world.card().includes('driver:'), 'the raw driver string reached the card');
  assert.equal(world.cardHidden(), false, 'the failure buried the card under a row');
  assert.equal(world.saidRows().length + world.replyRows().length + world.noteRows().length, 0, 'the technical line was printed as a row');
  assert.equal(world.actionsHidden(), false, 'no way back from a failed start');
  world.press('Retry');
  assert.deepEqual(world.actions, ['start'], 'Retry did not start the assistant');
  assert.equal(world.note().hidden, true, 'the old reason is still up while a new start runs');
});

test('while it starts the card says so once', () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting', detail: 'Starting your assistant.' });
  assert.equal(world.note().hidden, true, 'a failure line is up with nothing having failed');
  assert.equal((world.card().match(/Starting your agent\./g) ?? []).length, 1, world.card());
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
  assert.equal(world.seat(), 'coming');
  /* Nothing comes back. The start watch fires, and the failure waits the starting floor. */
  world.runTimers();
  world.runTimers();
  assert.ok(world.card().includes('The assistant did not answer in time.'), world.card());
  assert.equal(world.input.value, rows[0].textContent, 'the words were lost with the start');
  world.press('Retry');
  assert.deepEqual(world.actions, ['start', 'start']);
});

test('the connect sheet takes the card\'s place and closes the moment an agent is ready', async () => {
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
  assert.ok(world.card().includes('Your agent is ready.'), world.card());
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

test('Turn off asks first, on a card of its own, and only the card\'s Turn off quits: the process stops, the chat closes, and the column is empty again', async () => {
  const world = build();
  world.emit({ kind: 'status', state: 'starting' });
  world.emit({ kind: 'status', state: 'ready' });
  world.runTimers();
  world.type('what do I hold?');
  world.emit({ kind: 'text', text: 'Two coins.' });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  world.emit({ kind: 'status', state: 'ready' });
  assert.equal(world.cardHidden(), true, 'a transcript and the empty card at once');
  world.press('Turn off');
  assert.deepEqual(world.actions, ['prompt'], 'the process was stopped before the person confirmed');
  assert.equal(world.sheets().length, 1, 'no confirmation card in the thread');
  const card = world.sheets()[0];
  const rows = all(world.host, 'transcript-rows')[0].children;
  assert.equal(rows[rows.length - 1].children[0], card, 'the card is not at the thread\'s end');
  const words = all(card, 'title').map((n) => n.textContent);
  assert.deepEqual(words, ['Turn off the assistant?']);
  /* The card says what will happen and what will not. */
  const body = all(card, 'body')[0].textContent;
  assert.ok(body.includes('transcript'), 'the card does not say the transcript goes');
  assert.ok(body.includes('untouched'), 'the card does not say what stays');
  const buttons = all(card, 'btn').map((n) => n.textContent);
  assert.deepEqual(buttons, ['Keep running', 'Turn off']);

  /* Keep running: the card goes and nothing was sent. */
  fire(all(card, 'btn')[0], 'click');
  assert.equal(world.sheets().length, 0, 'the card outlived its own Keep running');
  assert.deepEqual(world.actions, ['prompt']);
  assert.equal(world.saidRows().length, 1, 'keeping it running lost the transcript');

  /* Turn off on the card: stop, then close, in that order, and then the column is what it was
     before anybody started: the card saying the agent is off, no rows, the head reading Off. */
  world.press('Turn off');
  const again = world.sheets()[0];
  fire(all(again, 'btn')[1], 'click');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(world.actions, ['prompt', 'stop', 'close']);
  assert.equal(world.saidRows().length, 0, 'the old transcript stayed on screen after the quit');
  assert.equal(world.replyRows().length, 0);
  assert.equal(world.cardHidden(), false, 'the empty card did not come back');
  assert.ok(world.card().includes('Your agent is off.'), world.card());
  assert.equal(world.seat(), 'off');
  assert.equal(world.actionsHidden(), false, 'the card offers no way to start again');
  assert.equal(all(world.composerHost, 'agent-composer')[0].hidden, true, 'the composer stayed open with nobody to talk to');
});

test('a stop the person did not ask for keeps the transcript under the reason', () => {
  /* The clear belongs to the quit, not to the stopped frame: a crash arrives as the same state
     with a reason, and that transcript has to stay under the failure line. */
  const world = build();
  world.type('what do I hold?');
  world.emit({ kind: 'text', text: 'Two coins.' });
  world.emit({ kind: 'status', state: 'stopped', reason: 'The assistant exited on its own.' });
  assert.equal(world.saidRows().length, 1, 'an exit the person did not ask for wiped the transcript');
  assert.equal(world.noteText(), 'The assistant exited on its own.');
});

/* ---------- scrolling ---------- */

test('new content while the person is scrolled up leaves the scroll alone and offers the way down', () => {
  const world = build();
  world.type('what do I hold?');
  world.emit({ kind: 'text', text: 'You hold two coins.' });
  assert.equal(world.pillOn(), false, 'Latest is up while the person is at the end');

  world.scrollUp();
  world.emit({ kind: 'text', text: 'Most of it is USDC.' });
  world.grew();
  assert.equal(world.list().scrollTop, 0, 'a new block moved a person who had scrolled up');
  assert.equal(world.pillOn(), true, 'nothing offered the way down');
  assert.equal(world.pill().textContent, 'Latest');
  world.emit({ kind: 'said', text: 'and my positions?' }, 'c1');
  assert.equal(world.list().scrollTop, 0);
});

/* THE COLUMN STAYS AT ITS END. A card that grows in place, a reply that streams and a window
   that changes size moved nothing the old mark could see, so the bottom slipped under the fold.
   While the person is at the end, any change of size keeps them there. */
test('at the end, the column stays at the end through anything that changes its size', () => {
  const world = build();
  world.type('what do I hold?');
  const list = world.list();
  list.clientHeight = 400;
  list.scrollHeight = 2000;
  list.scrollTop = 1600;
  world.grew();
  /* A card below the fold grew by 300 px, and nothing else happened. */
  list.scrollHeight = 2300;
  world.grew();
  assert.equal(list.scrollTop, 1900, 'the growth slipped under the fold');
  assert.equal(world.pillOn(), false);
});

test('pressing Latest scrolls to the end and puts it away', () => {
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

/* ---------- The driver's contract (pg/agent, 2026-09-23) ----------

   A block that got deltas and no whole copy was cut short by a stop; an error frame is a log
   line; the web tools arrive with no prefix; and the picked agent may run outside the window. */

test('a reply stopped mid-stream keeps what arrived and stops reading as arriving', () => {
  const world = build();
  world.type('what do I hold?');
  world.emit({ kind: 'delta', block: 4, text: 'You hold two ' });
  world.emit({ kind: 'status', state: 'stopped' });
  assert.equal(world.replyRows().length, 1);
  assert.equal(all(world.replyRows()[0], 'chat-text')[0].textContent, 'You hold two ');
  assert.equal(world.replyRows()[0].getAttribute('data-streaming'), null, 'a stopped reply still reads as arriving');
});

test('an error frame is a log line for developer mode, never a line of the chat', () => {
  const world = build();
  world.type('hi');
  world.emit({ kind: 'error', message: 'stderr: a line only an engineer reads' });
  const notes = world.noteRows();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].getAttribute('data-dev-only'), '', 'the log line shows outside developer mode');
});

test('the web tools say what they do in plain words and are named as leaving the machine', () => {
  const world = build();
  world.type('any news on SOL?');
  world.emit({ kind: 'tool', name: 'web_search', input: { query: 'SOL' } });
  assert.equal(world.workingWords(), 'Searching the web');
  world.emit({ kind: 'tool_result', name: 'web_search', ok: true });
  world.emit({ kind: 'tool', name: 'web_fetch', input: {} });
  assert.equal(world.workingWords(), 'Reading a page');
  world.emit({ kind: 'tool', name: 'x_search', input: {} });
  assert.equal(world.workingWords(), 'Searching X');
});

test('an agent that runs outside this window gets its sentence where Start would be', async () => {
  const reason = 'Codex runs in your terminal, not in this chat. Start it there and it joins this window.';
  const world = build({ driverData: { state: 'off', agent: { id: 'codex', name: 'Codex', inApp: false, reason } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  world.emit({ kind: 'status', state: 'stopped' });
  assert.equal(world.note().hidden, false, 'the sentence is not in the head');
  assert.equal(world.noteText(), reason);
  const mark = all(world.host, 'agent-note-mark')[0];
  assert.equal(mark.hidden, false, 'the sentence names Codex without its logo');
  const logo = all(mark, 'logo')[0];
  assert.equal(logo.attrs['data-agent'], 'codex');
  assert.equal((logo.children[0] as unknown as Record<string, unknown>).src, './logos/agents/codex.svg');
  assert.equal(world.retry().hidden, true, 'a Retry for an agent that does not start here');
  const starts = all(world.host, 'btn').filter((b) => b.textContent === 'Start your agent');
  assert.ok(starts.length > 0 && starts.every((b) => b.hidden === true), 'a Start for an agent that runs elsewhere');
});

/* A reminder (the backup nudge) asks to be quiet: a line in the thread, not a card with a green
   button beside the move that is waiting (lead, 2026-09-23). And no button in the chat is
   green or red: green is the mark's, the live move's and Approve's, red a real loss's. */
test('a quiet card from another screen is a line in the thread, and nothing in the chat is green or red', () => {
  const world = build();
  world.showCard((host: Node) => { host.appendChild(make('span')); }, { quiet: true });
  world.showCard((host: Node) => { host.appendChild(make('span')); });
  const sheets = all(world.host, 'chat-sheet');
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].getAttribute('data-quiet'), 'true');
  assert.equal(sheets[1].getAttribute('data-quiet'), null);
  assert.doesNotMatch(AGENT_SOURCE, /btn-primary|btn-danger/, 'a green or red button in the chat');
});


test('Start says Start your agent whatever is picked, and a pick in the Vault is read on the spot', async () => {
  // GET /api/driver carries the pick as `agent` (src/providers/index.ts vendorFor); the Vault's
  // list dispatches `phosphor:agent` after every pick the app stored, and the column reads again.
  // The vendor's name is the Vault's list's to say, never the Start button's (Karim, 2026-09-23).
  const data: Record<string, unknown> = { state: 'off', agent: { id: 'grok', name: 'Grok', inApp: true, reason: null } };
  const world = build({ driverData: data });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const starts = (): string[] => all(world.host, 'btn-label').map((l) => l.textContent).filter((t) => t.startsWith('Start'));
  assert.ok(starts().length >= 2, JSON.stringify(starts()));
  assert.ok(starts().every((t) => t === 'Start your agent'), JSON.stringify(starts()));

  data.agent = { id: 'claude', name: 'Claude Code', inApp: true, reason: null };
  world.windowEvent('phosphor:agent');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(starts().every((t) => t === 'Start your agent'), JSON.stringify(starts()));

  // A pick the chat cannot run keeps the same word; its sentence is the head's note.
  const away = 'Codex runs in your terminal, not in this chat. Start it there and it joins this window.';
  data.agent = { id: 'codex', name: 'Codex', inApp: false, reason: away };
  world.windowEvent('phosphor:agent');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(starts().every((t) => t === 'Start your agent'), JSON.stringify(starts()));
  assert.equal(world.noteText(), away, 'the pick was not read again');
});
