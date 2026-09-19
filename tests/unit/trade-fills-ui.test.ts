// The trade deck, which is where a person reads what their bot is holding, what it is
// waiting to do, and what it did.
//
// The strip over the chart and three tabs under it since the exchange-grade pass
// (2026-09-15): the strip is the market (logo, venue, mark price, the day, free and at risk),
// the tabs are Open, Waiting and Done. What is asserted below is the text a person would read
// in each, the shape of an empty answer (one line, no explanation), the tape's 24 hour window
// with Show more under it, the receipt a fill row opens, and the two controls the deck has:
// Close on a position and Cancel on a plan, which confirm inline and post to the human-only
// door.
//
// The older bugs this file caught are still pinned: the list read `fill.sz || fill.size || 0`
// and `fill.time || fill.at` and the payload carries neither (a Fill is { tid, coin, side, px,
// sizeCoin, atMs, ... }), so every fill said "Bought BTC 0" with no time beside it.
//
// Run against the REAL ui/core/dom.js and ui/screens/trade.js over a small stand-in DOM, so what
// is asserted is the text a person would read rather than the shape of the source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Node = {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  title: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  childNodes: Node[];
  parentNode: Node | null;
  readonly children: Node[];
  readonly firstChild: Node | null;
  readonly nextSibling: Node | null;
  appendChild: (n: Node) => Node;
  insertBefore: (n: Node, before: Node | null) => Node;
  removeChild: (n: Node) => Node;
  querySelector: () => null;
  getBoundingClientRect: () => { width: number; height: number };
  setAttribute: (n: string, v: string) => void;
  getAttribute: (n: string) => string | null;
  hasAttribute: (n: string) => boolean;
  removeAttribute: (n: string) => void;
  addEventListener: (type: string, fn: (ev: unknown) => void) => void;
  removeEventListener: () => void;
  focus: () => void;
  click: () => void;
  fire: (type: string, ev?: Record<string, unknown>) => void;
  animations: unknown[];
  animate: (frames: unknown, opts: unknown) => { cancel: () => void };
};

// Enough of a DOM for the keyed reconciler in ui/core/dom.js, which is what the lists are built
// with: it needs insertBefore, removeChild, firstChild, nextSibling and parentNode to be real.
// Listeners are kept so a test can press a button, and animate() records what the spotlight
// asked for so a test can read the pulse without a compositor.
function camel(name: string): string {
  return name.slice('data-'.length).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function makeNode(tagName: string): Node {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const node = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    title: '',
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => {
        const parts = node.className.split(' ').filter(Boolean);
        if (!parts.includes(c)) parts.push(c);
        node.className = parts.join(' ');
      },
      remove: (c: string) => {
        node.className = node.className.split(' ').filter((p) => p && p !== c).join(' ');
      },
      contains: (c: string) => node.className.split(' ').includes(c),
    },
    childNodes: [] as Node[],
    parentNode: null as Node | null,
    animations: [] as unknown[],
    get children() {
      return node.childNodes;
    },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    get nextSibling() {
      const siblings = node.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    appendChild(child: Node) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    insertBefore(child: Node, before: Node | null) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      const at = before === null ? node.childNodes.length : node.childNodes.indexOf(before);
      node.childNodes.splice(at < 0 ? node.childNodes.length : at, 0, child);
      return child;
    },
    removeChild(child: Node) {
      const at = node.childNodes.indexOf(child);
      if (at >= 0) node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    // data-* attributes reflect into dataset, as they do on a real element, because the
    // screen writes them one way (dom.setAttr) and reads them the other (node.dataset).
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
      if (name.startsWith('data-')) node.dataset[camel(name)] = value;
    },
    getAttribute: (name: string) => (name.startsWith('data-') ? node.dataset[camel(name)] ?? null : attrs[name] ?? null),
    hasAttribute: (name: string) => (name.startsWith('data-') ? camel(name) in node.dataset : name in attrs),
    removeAttribute: (name: string) => {
      delete attrs[name];
      if (name.startsWith('data-')) delete node.dataset[camel(name)];
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      (listeners[type] = listeners[type] ?? []).push(fn);
    },
    removeEventListener: () => {},
    focus: () => {},
    click: () => {
      for (const fn of listeners.click ?? []) fn({ currentTarget: node, target: node, preventDefault: () => {} });
    },
    fire: (type: string, ev: Record<string, unknown> = {}) => {
      for (const fn of listeners[type] ?? []) fn({ currentTarget: node, target: node, preventDefault: () => {}, stopPropagation: () => {}, ...ev });
    },
    animate: (frames: unknown, opts: unknown) => {
      node.animations.push({ frames, opts });
      return { cancel: () => {} };
    },
  } as unknown as Node;
  return node;
}

function textOf(node: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.childNodes.length === 0) {
      if (n.textContent !== '') out.push(n.textContent);
      return;
    }
    for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return out;
}

function allWithDataset(node: Node, key: string, out: Node[] = []): Node[] {
  if (node.dataset[key] !== undefined) out.push(node);
  for (const child of node.childNodes) allWithDataset(child, key, out);
  return out;
}

function allWithTag(node: Node, tag: string, out: Node[] = []): Node[] {
  if (node.tagName === tag) out.push(node);
  for (const child of node.childNodes) allWithTag(child, tag, out);
  return out;
}

function withClass(node: Node, name: string, out: Node[] = []): Node[] {
  if (node.className.split(' ').includes(name)) out.push(node);
  for (const child of node.childNodes) withClass(child, name, out);
  return out;
}

function buttons(node: Node): Node[] {
  return allWithTag(node, 'button').filter((b) => b.className.includes('trade-act'));
}

// A fill row on the tape, read cell by cell: the clock, the side pill, the coin, the size, the
// value and the explorer link slot, in the order the row places them.
function fillRows(node: Node) {
  return withClass(node, 'fill-row').map((row) => ({
    node: row,
    when: row.childNodes[0].textContent,
    side: row.childNodes[1].textContent,
    coin: textOf(row.childNodes[2]).join(''),
    size: row.childNodes[3].textContent,
    value: row.childNodes[4].textContent,
    link: row.childNodes[5].childNodes[0] ?? null,
  }));
}

// What a done row says, whichever kind it is: a fill reads as "Buy BTC 0.001", an ended plan
// as its sentence.
function doneText(row: Node): string {
  if (row.className.includes('fill-row')) return [row.childNodes[1].textContent, textOf(row.childNodes[2]).join(''), row.childNodes[3].textContent].join(' ');
  return row.childNodes[2].textContent;
}

// The tabs over the deck, with their counts.
function tabs(node: Node) {
  return withClass(node, 'trade-tab').map((tab) => ({
    node: tab,
    label: tab.childNodes[0].textContent,
    count: tab.childNodes[1].textContent,
    selected: tab.getAttribute('aria-selected') === 'true',
  }));
}

// Times relative to now: the tape shows the last 24 hours by default, so a fixture dated to a
// fixed day would fall out of the window as the calendar moved.
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

/* Objects built inside the vm carry that realm's Object.prototype, and a strict deep compare
   tests prototypes as well as keys. Copying through JSON puts the shape back in this realm. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

// ---------- payloads, shaped as buildTradePayload emits them ----------

function fill(over: Record<string, unknown> = {}) {
  return {
    tid: 't1',
    coin: 'BTC',
    side: 'buy',
    px: 60000,
    sizeCoin: 0.001,
    notionalUsd: 60,
    feeUsd: 0.01,
    closedPnlUsd: null,
    atMs: NOW - 30 * MINUTE,
    tSec: 0,
    liquidation: false,
    planId: null,
    ...over,
  };
}

// One fill of a tenth of a BTC-sized asset, priced.
function payload(sizeCoin: number, szDecimals: number | null) {
  return {
    symbol: 'BTC',
    account: { equityUsd: 0, freeUsd: 0, marginUsedUsd: 0, accountKnown: true, atRiskUsd: 0, maxLossUsd: 0 },
    markets: [{ coin: 'BTC', markPx: 60000, szDecimals, maxLeverage: 20, assetId: 0 }],
    positions: [],
    orders: [],
    plans: [],
    highlights: [],
    products: ['BTC-USD'],
    fills: [fill({ sizeCoin, notionalUsd: sizeCoin * 60000 })],
  };
}

function waitingPlan(over: Record<string, unknown> = {}) {
  return {
    id: 'pl_a1',
    symbol: 'ETH',
    side: 'long',
    sizeUsd: 200,
    leverage: 3,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 3180,
    target: 3420,
    when: [
      { type: 'close', tf: '1h', is: 'above', at: { px: 3300 } },
      { type: 'volume', tf: '1h', atLeast: 1.5 },
    ],
    status: 'waiting',
    hash: 'h',
    cloids: {},
    gen: 0,
    holds: [
      { condition: 'a 1h bar closes above 3300', holds: true },
      { condition: 'volume on the 1h is at least 1.5x its 20-bar average', holds: false },
    ],
    createdAt: '2026-09-11T13:40:00.000Z',
    updatedAt: '2026-09-11T13:40:00.000Z',
    ...over,
  };
}

function openPlan(over: Record<string, unknown> = {}) {
  return {
    id: 'pl_b2',
    symbol: 'BTC',
    side: 'long',
    sizeUsd: 30000,
    leverage: 5,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 57000,
    target: 62000,
    status: 'open',
    hash: 'h',
    cloids: {},
    gen: 0,
    fillPx: 58000,
    createdAt: '2026-09-11T12:00:00.000Z',
    updatedAt: '2026-09-11T12:01:00.000Z',
    ...over,
  };
}

// The rail with money in it: a funded account, one open position under an open plan, and one
// plan waiting on two conditions. Every field name below is the one src/trade/state.ts emits.
function funded() {
  return {
    symbol: 'BTC',
    overlays: { position: true, liquidation: false, planStop: true },
    account: {
      equityUsd: 4200.5,
      freeUsd: 3100.25,
      marginUsedUsd: 1100.25,
      healthPct: 0.62,
      unified: false,
      accountKnown: true,
      atRiskUsd: 6000,
      maxLossUsd: 517.4,
    },
    markets: [{ coin: 'BTC', markPx: 60000, szDecimals: 5, maxLeverage: 20, assetId: 0 }],
    positions: [
      {
        coin: 'BTC',
        side: 'long',
        sizeCoin: 0.5,
        notionalUsd: 30000,
        entryPx: 58000,
        markPx: 60000,
        liqPx: 52800,
        unrealisedUsd: 1000,
        leverage: 5,
        liqReachable: true,
        liqDistancePct: 12,
        liqDistanceUsd: 3600,
      },
    ],
    orders: [] as Record<string, unknown>[],
    plans: [openPlan(), waitingPlan()],
    highlights: [] as Record<string, unknown>[],
    products: ['BTC-USD'],
    fills: [] as ReturnType<typeof fill>[],
    venue: undefined as Record<string, unknown> | undefined,
  };
}

// Flat: the account has answered, there is money history, nothing is open and nothing waits.
// This is the state the rail is in most of the time.
function flat() {
  const data = funded() as Record<string, unknown>;
  data.account = { equityUsd: 4200.5, freeUsd: 4200.5, healthPct: 1, unified: false, accountKnown: true, atRiskUsd: 0, maxLossUsd: 0 };
  data.positions = [];
  data.plans = [];
  data.fills = payload(0.001, 5).fills;
  return data;
}

type World = { host: Node; lines: string[]; posts: Array<{ path: string; body: Record<string, unknown> }>; emitted: Array<{ type: string; payload: any }>; refresh: () => Promise<void>; set: (d: unknown) => void; tick: (ms: number) => void; window: Record<string, any>; fire: (type: string, event: Record<string, unknown>) => void };

type Options = {
  reduced?: boolean;
  onInvalidate?: (scene: boolean) => void;
  // The pane state ui/split.js would hold, for the Layout menu.
  split?: Record<string, any>;
  // The day's hourly candles /api/candles would answer with, and the view the shell reports:
  // the strip reads the day only once the trade view is up.
  candles?: unknown[];
  view?: string;
};

async function renderPayload(data: unknown, opts: Options = {}): Promise<World> {
  const host = makeNode('div');
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const emitted: Array<{ type: string; payload: any }> = [];
  let current = data;
  // Timers the test drives, so the four second confirm window and the spotlight's 1.2 s are
  // read as numbers rather than waited for.
  let now = 0;
  let nextId = 1;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const setTimer = (fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, at: now + (ms || 0), fn });
    return id;
  };
  const clearTimer = (id: number) => {
    const at = timers.findIndex((t) => t.id === id);
    if (at >= 0) timers.splice(at, 1);
  };
  const tick = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    for (const t of due) timers.splice(timers.indexOf(t), 1);
    for (const t of due) t.fn();
  };
  // Listeners on the document itself, so a test can press Escape or click outside a popover.
  const docListeners: Record<string, Array<(ev: unknown) => void>> = {};
  const sandbox: Record<string, any> = {
    console,
    URL,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    document: {
      createElement: (tag: string) => makeNode(tag),
      getElementById: (id: string) => (id === 'view-trade' ? host : null),
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        (docListeners[type] = docListeners[type] ?? []).push(fn);
      },
      documentElement: makeNode('html'),
      body: makeNode('body'),
    },
  };
  sandbox.window = {
    document: sandbox.document,
    addEventListener: () => {},
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    PhosphorMotion: { reduced: () => opts.reduced === true },
    PhosphorEvents: {
      on: () => {},
      emit: (type: string, payload: unknown) => {
        emitted.push({ type, payload });
      },
    },
    PhosphorNet: {
      readable: (e: unknown) => String(e),
      postJson: async (path: string, body: Record<string, unknown>) => {
        posts.push({ path, body });
        return { ok: true };
      },
      getJson: async (path: string) => {
        if (path.startsWith('/api/candles')) return { fresh: true, data: opts.candles ?? [], status: 200 };
        throw new Error('no such route in this harness: ' + path);
      },
    },
    PhosphorApi: {
      trade: async () => ({ fresh: true, data: current }),
      tradeAction: async (body: Record<string, unknown>) => {
        posts.push({ path: '/api/trade/action', body });
        return { ok: true };
      },
    },
    PhosphorShell: { view: () => opts.view ?? 'basic', setPending: () => {} },
    PhosphorAgent: { mount: () => {} },
    // The foundation's marks, icons and pane state, as stand-ins: a logo is a span that
    // remembers its ticker, an icon a span that remembers its name.
    PhosphorMarks: {
      logo: (symbol: string, size: number) => {
        const node = makeNode('span');
        node.className = 'logo';
        node.dataset.token = symbol;
        node.style['--logo'] = size + 'px';
        return node;
      },
    },
    PhosphorIcons: {
      svg: (name: string, className?: string) => {
        const node = makeNode('svg');
        node.className = 'icon' + (className ? ' ' + className : '');
        node.dataset.icon = name;
        return node;
      },
    },
    PhosphorSplit: opts.split ?? { panes: () => [], setPane: () => false, paneControl: () => null },
    // The chart engine's repaint hook, recorded so a test can see the spotlight ask for it.
    chartInvalidate: (scene: boolean) => {
      if (opts.onInvalidate) opts.onInvalidate(scene);
    },
  };
  sandbox.globalThis = sandbox;
  createContext(sandbox);

  for (const file of ['../../ui/core/links.js', '../../ui/core/dom.js', '../../ui/screens/trade.js']) {
    runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), sandbox, { filename: file });
  }
  sandbox.window.PhosphorTrade.boot();
  await sandbox.window.PhosphorTrade.refresh();
  return {
    host,
    get lines() {
      return textOf(host);
    },
    posts,
    emitted,
    refresh: () => sandbox.window.PhosphorTrade.refresh(),
    set: (d: unknown) => {
      current = d;
    },
    tick,
    window: sandbox.window,
    fire: (type: string, event: Record<string, unknown>) => {
      for (const fn of docListeners[type] ?? []) fn({ preventDefault: () => {}, ...event });
    },
  };
}

async function render(sizeCoin: number, szDecimals: number | null): Promise<ReturnType<typeof fillRows>> {
  const out = await renderPayload(payload(sizeCoin, szDecimals));
  return fillRows(out.host);
}

// ---------- Done: the fills ----------

test('a fill is one line under headings: the clock, the side, the coin, the size that actually traded, the value', async () => {
  const world = await renderPayload(payload(0.001, 5));
  const [head] = withClass(world.host, 'tape-head');
  assert.equal(head.hidden, false, 'no headings over the tape');
  assert.deepEqual(textOf(head), ['Time', 'Side', 'Asset', 'Size', 'Value']);
  const [row] = fillRows(world.host);
  assert.ok(row !== undefined, 'no fill row on the tape');
  assert.equal(row.side, 'Buy');
  assert.equal(row.node.childNodes[1].dataset.tone, 'up', 'a buy is toned up');
  assert.equal(row.coin, 'BTC');
  assert.equal(row.size, '0.001', 'the list never said what was bought');
  assert.equal(row.value, '$60.00');
  assert.equal(row.node.childNodes[4].dataset.dir, 'up', 'a buy takes its value in the side colour, green, the same as its pill');
  assert.ok(row.node.childNodes[3].className.includes('mono'), 'a size is set in the mono face');
  assert.ok(row.node.childNodes[4].className.includes('mono'), 'a value is set in the mono face');
});

test('a sell is toned down, value included', async () => {
  const data = payload(0.001, 5);
  data.fills = [fill({ side: 'sell' })];
  const { host } = await renderPayload(data);
  const [row] = fillRows(host);
  assert.equal(row.side, 'Sell');
  assert.equal(row.node.childNodes[1].dataset.tone, 'down');
  assert.equal(row.node.childNodes[4].dataset.dir, 'down', 'a sell chip in red over a green value');
});

test('a fill carries the time it happened', async () => {
  const [row] = await render(0.001, 5);
  assert.ok(/^\d{2}:\d{2}$/.test(row.when), `no clock beside the fill: ${row.when}`);
});

test('an asset the venue reports no precision for still prints a real size', async () => {
  // No szDecimals means the general rule applies: four places, so this rounds to 0.0003. What
  // it must never do is round to nothing.
  const [row] = await render(0.00025, null);
  assert.notEqual(row.size, '0', 'a size rounded away to nothing');
  assert.ok(Number(row.size) > 0);
});

test('a whole-number asset still shows a fraction rather than rounding it to nothing', async () => {
  const [row] = await render(0.001, 0);
  assert.ok(row.size.startsWith('0.001'), `rounded to nothing at the asset's own precision: ${row.size}`);
});

test('a large fill keeps the thousands separator and does not grow decimals it does not need', async () => {
  const [row] = await render(12500, 2);
  assert.equal(row.size, '12,500');
});

test('a done plan sits in the tape with the reason it ended, one line each, newest first', async () => {
  const data = flat();
  data.plans = [
    openPlan({ id: 'pl_s1', status: 'done', endReason: 'stopped', updatedAt: ago(20 * MINUTE) }),
    openPlan({ id: 'pl_c2', symbol: 'ETH', side: 'short', status: 'done', endReason: 'cancelled', updatedAt: ago(40 * MINUTE) }),
    openPlan({ id: 'pl_f3', status: 'done', endReason: 'failed:plan on disk does not match its approval', updatedAt: ago(50 * MINUTE) }),
  ];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('Stopped long BTC'), JSON.stringify(lines));
  assert.ok(lines.includes('Cancelled short ETH'), JSON.stringify(lines));
  assert.ok(lines.includes('Failed, plan on disk does not match its approval'), JSON.stringify(lines));
  // The id is the agent's handle, not a value: it stays off the tape.
  assert.ok(!lines.includes('pl_s1'), JSON.stringify(lines));
  const rows = withClass(host, 'done-row');
  assert.equal(rows.length, 4, 'three done plans and one fill');
  // 20 minutes ago stopped, 30 the fill, 40 cancelled, 50 failed.
  assert.deepEqual(
    rows.map(doneText),
    ['Stopped long BTC', 'Buy BTC 0.001', 'Cancelled short ETH', 'Failed, plan on disk does not match its approval'],
  );
  // The value cell of a plan without a closed figure is empty, not the id.
  assert.equal(rows[0].childNodes[3].textContent, '');
  assert.equal(rows[0].childNodes[3].dataset.dir, undefined);
});

test('a done plan whose payload carries what it closed for shows the figure, signed and by its sign', async () => {
  const data = flat();
  data.plans = [
    openPlan({ id: 'pl_w', status: 'done', endReason: 'targeted', closedPnlUsd: 412.5, updatedAt: ago(20 * MINUTE) }),
    openPlan({ id: 'pl_l', status: 'done', endReason: 'stopped', closedPnlUsd: -63.2, updatedAt: ago(40 * MINUTE) }),
  ];
  const { host } = await renderPayload(data);
  const rows = withClass(host, 'done-row').filter((r) => r.className.includes('ended-row'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].childNodes[3].textContent, '+$412.50');
  assert.equal(rows[0].childNodes[3].dataset.dir, 'up');
  assert.ok(rows[0].childNodes[3].className.includes('mono'), 'a figure is set in the mono face');
  assert.equal(rows[1].childNodes[3].textContent, '-$63.20');
  assert.equal(rows[1].childNodes[3].dataset.dir, 'down');
});

test('the tape is the last 24 hours, and Show more reveals the next twenty older rows', async () => {
  const data = flat();
  // Five in the last day, thirty older.
  data.fills = [
    ...Array.from({ length: 5 }, (_, i) => fill({ tid: 'd' + i, atMs: NOW - (i + 1) * HOUR })),
    ...Array.from({ length: 30 }, (_, i) => fill({ tid: 'o' + i, atMs: NOW - 2 * 24 * HOUR - i * MINUTE })),
  ];
  const world = await renderPayload(data);
  assert.equal(withClass(world.host, 'done-row').length, 5);
  const doneCount = () => tabs(world.host).filter((t) => t.label === 'Done')[0].count;
  assert.equal(doneCount(), '5', 'the tab counts the day');
  const [more] = withClass(world.host, 'trade-more');
  assert.ok(more !== undefined, 'no Show more under the tape');
  assert.equal(more.parentNode!.hidden, false, 'Show more is hidden with thirty older rows behind it');
  more.click();
  assert.equal(withClass(world.host, 'done-row').length, 25);
  // The count is the day's, whatever Show more has revealed under it.
  assert.equal(doneCount(), '5', 'Show more grew the count with the rows it loaded');
  more.click();
  assert.equal(withClass(world.host, 'done-row').length, 35);
  assert.equal(doneCount(), '5');
  assert.equal(more.parentNode!.hidden, true, 'nothing older is left, so Show more goes');
  // What was revealed stays revealed across the frames that keep landing.
  await world.refresh();
  assert.equal(withClass(world.host, 'done-row').length, 35);
});

test('an empty window says so in one line, and Show more still reaches the older rows', async () => {
  const data = flat();
  data.fills = [fill({ tid: 'old', atMs: NOW - 3 * 24 * HOUR })];
  const world = await renderPayload(data);
  assert.ok(world.lines.includes('Nothing in the last 24 hours.'), JSON.stringify(world.lines));
  assert.ok(!world.lines.includes('Nothing yet.'), 'there is history, so the tape must not say there is none');
  const [more] = withClass(world.host, 'trade-more');
  assert.equal(more.parentNode!.hidden, false);
  more.click();
  assert.equal(withClass(world.host, 'done-row').length, 1);
  // No history at all is the other sentence, with nothing to show more of.
  const none = flat();
  none.fills = [];
  const bare = await renderPayload(none);
  assert.ok(bare.lines.includes('Nothing yet.'), JSON.stringify(bare.lines));
  assert.equal(withClass(bare.host, 'trade-more')[0].parentNode!.hidden, true);
  assert.equal(withClass(bare.host, 'tape-head')[0].hidden, true, 'headings over nothing');
});

test('the tape owns its host, so nothing is left under it for the reconciler to trip on', async () => {
  // dom.reconcile removes everything after the last row it placed. Show more sits under the
  // list host, never inside it.
  const { host } = await renderPayload(payload(0.001, 5));
  const [list] = withClass(host, 'trade-list').filter((n) =>
    n.childNodes.some((c) => c.className.includes('done-row')),
  );
  assert.ok(list !== undefined, 'no tape');
  for (const child of list.childNodes) {
    assert.ok(child.className.includes('done-row'), `something else is in the list: ${child.className}`);
  }
});

test('a fill with a venue hash ends in an explorer link, and one without ends in nothing', async () => {
  const data = flat();
  data.fills = [
    fill({ tid: 'linked', url: 'https://app.hyperliquid.xyz/explorer/tx/0xabc', hash: '0xabc' }),
    fill({ tid: 'bare', atMs: NOW - 31 * MINUTE }),
  ];
  const { host } = await renderPayload(data);
  const [linked, bare] = fillRows(host);
  assert.ok(linked.link !== null, 'no explorer link on the fill that carries a hash');
  assert.equal(linked.link!.tagName, 'a');
  assert.equal((linked.link as any).href, 'https://app.hyperliquid.xyz/explorer/tx/0xabc');
  assert.equal((linked.link as any).target, '_blank');
  assert.equal((linked.link as any).rel, 'noreferrer noopener');
  assert.equal(linked.link!.getAttribute('aria-label'), 'View on Hyperliquid');
  assert.equal(bare.link, null, 'a link to nowhere');
});

test('pressing a fill row opens the receipt card with the fill mapped to the receipt shape', async () => {
  const data = flat();
  data.fills = [fill({ tid: 'r1', feeUsd: 0.02, url: 'https://app.hyperliquid.xyz/explorer/tx/0xabc', hash: '0xabc' })];
  const world = await renderPayload(data);
  const [row] = fillRows(world.host);
  row.node.click();
  assert.equal(world.emitted.length, 1, 'no receipt:open event');
  assert.equal(world.emitted[0].type, 'receipt:open');
  const { receipt, source } = world.emitted[0].payload;
  assert.equal(source, 'trade');
  assert.equal(receipt.kind, 'trade');
  assert.equal(receipt.id, 'fill:r1');
  assert.equal(receipt.headline, 'Bought BTC 0.001');
  assert.equal(receipt.at, new Date(NOW - 30 * MINUTE).toISOString());
  assert.equal(receipt.status, 'done');
  assert.equal(receipt.feesUsd, 0.02);
  // A buy sends dollars out and brings the coin in.
  assert.equal(receipt.amount, 60);
  assert.equal(receipt.symbol, 'USDC');
  assert.deepEqual(plain(receipt.received), { symbol: 'BTC', amount: 0.001 });
  assert.deepEqual(plain(receipt.txids), [{ chain: 'hyperliquid', hash: '0xabc', url: 'https://app.hyperliquid.xyz/explorer/tx/0xabc' }]);
  assert.ok(receipt.summary.startsWith('Bought 0.001 BTC at $60,000.00 on Hyperliquid'), receipt.summary);
  assert.equal(receipt.side, 'buy');
  assert.equal(receipt.closed, false, 'an opening fill is not a close');
  assert.equal(receipt.valueUsd, 60);
  assert.equal(receipt.venue, 'Hyperliquid');
  // A sell the other way, and a fill with no hash carries no transaction. A fill that
  // realised something closed a position, and the dollar leg is rounded to the cent.
  const sold = world.window.PhosphorTrade.mapFill(fill({ side: 'sell', tid: 'r2', closedPnlUsd: 7.25, notionalUsd: 61.2345 }));
  assert.equal(sold.headline, 'Sold BTC 0.001');
  assert.equal(sold.side, 'sell');
  assert.equal(sold.closed, true);
  assert.equal(sold.amount, 0.001);
  assert.equal(sold.symbol, 'BTC');
  assert.deepEqual(plain(sold.received), { symbol: 'USDC', amount: 61.23 });
  assert.deepEqual(plain(sold.txids), []);
  assert.ok(sold.summary.includes('+$7.25 realised'), sold.summary);
});

// ---------- the strip ----------

test('the strip is the coin, the venue, the mark, free collateral and what the plans put at risk', async () => {
  const { host, lines } = await renderPayload(funded());
  assert.ok(!lines.includes('No trading money yet.'), `a funded account was told it had none: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('Free'), JSON.stringify(lines));
  assert.ok(lines.includes('$3,100.25'), JSON.stringify(lines));
  assert.ok(lines.includes('At risk'), JSON.stringify(lines));
  assert.ok(lines.includes('$6,000.00'), JSON.stringify(lines));
  // Two figures on the strip and no third: the exchange header carries what a person checks
  // before a plan, and the loss at the stops is on the open row as the stop's distance.
  assert.ok(!lines.includes('Max loss'), JSON.stringify(lines));
  // The coin is a name set in the text face, on the market control, with its logo before it.
  const [coin] = withClass(host, 'trade-mark-coin');
  assert.equal(coin.textContent, 'BTC');
  const [symbol] = withClass(host, 'trade-symbol');
  assert.equal(symbol.childNodes[0].className, 'trade-symbol-logo');
  assert.equal(symbol.childNodes[0].dataset.coin, 'BTC');
  const [venue] = withClass(host, 'trade-venue');
  assert.ok(textOf(venue).includes('Hyperliquid'), 'the venue is not named');
});

test('the price ticks in colour: a rise marks the digits up, a fall marks them down', async () => {
  const world = await renderPayload(flat());
  const [px] = withClass(world.host, 'px');
  // The figure is two spans, the cents one step quieter, and reads as one price.
  assert.equal(textOf(px).join(''), '$60,000.00');
  assert.equal(px.childNodes[1].textContent, '.00');
  assert.equal(px.dataset.tick, undefined, 'the first paint is not a tick');
  const up = flat();
  up.markets = [{ coin: 'BTC', markPx: 60010, szDecimals: 5, maxLeverage: 20, assetId: 0 }];
  world.set(up);
  await world.refresh();
  assert.equal(textOf(px).join(''), '$60,010.00');
  assert.equal(px.dataset.tick, 'up');
  const down = flat();
  down.markets = [{ coin: 'BTC', markPx: 59990, szDecimals: 5, maxLeverage: 20, assetId: 0 }];
  world.set(down);
  await world.refresh();
  assert.equal(px.dataset.tick, 'down');
  // The same number again is not a tick, and the mark is written as plain text, never as
  // markup.
  world.set(down);
  await world.refresh();
  assert.equal(px.dataset.tick, 'down');
});

test('reduced motion skips the tick', async () => {
  const world = await renderPayload(flat(), { reduced: true });
  const up = flat();
  up.markets = [{ coin: 'BTC', markPx: 60010, szDecimals: 5, maxLeverage: 20, assetId: 0 }];
  world.set(up);
  await world.refresh();
  const [px] = withClass(world.host, 'px');
  assert.equal(textOf(px).join(''), '$60,010.00');
  assert.equal(px.dataset.tick, undefined);
});

test('the day reads from 25 hourly candles: the change against the close a day ago, plain and coloured, the high and the low', async () => {
  // 25 bars: the first is the bar that closed a day ago, the 24 since are the day.
  const candles = Array.from({ length: 25 }, (_, i) => ({ t: 0, o: 61000, h: i === 10 ? 63500 : 61500, l: i === 3 ? 58200 : 60500, c: i === 0 ? 61700 : 61000, v: 1 }));
  const world = await renderPayload(flat(), { candles, view: 'trade' });
  await new Promise((resolve) => setImmediate(resolve));
  const [change] = withClass(world.host, 'trade-change');
  const value = change.childNodes[1];
  // 60,000 against 61,700: down 1,700, which is 2.76%.
  assert.equal(value.textContent, '-1,700.00 / -2.76%');
  assert.equal(value.dataset.dir, 'down');
  assert.equal(withClass(world.host, 'trade-high')[0].childNodes[1].textContent, '$63,500.00');
  assert.equal(withClass(world.host, 'trade-low')[0].childNodes[1].textContent, '$58,200.00');
  // A rise reads up.
  const up = flat();
  up.markets = [{ coin: 'BTC', markPx: 62000, szDecimals: 5, maxLeverage: 20, assetId: 0 }];
  world.set(up);
  await world.refresh();
  assert.equal(value.textContent, '+300.00 / +0.49%');
  assert.equal(value.dataset.dir, 'up');
});

test('the day reads -- until the candles have landed, and never a number for another market', async () => {
  const world = await renderPayload(flat());
  const [change] = withClass(world.host, 'trade-change');
  assert.equal(change.childNodes[1].textContent, '--');
  assert.equal(withClass(world.host, 'trade-high')[0].childNodes[1].textContent, '--');
  assert.equal(withClass(world.host, 'trade-low')[0].childNodes[1].textContent, '--');
});

test('max loss is not on the strip', async () => {
  const { lines } = await renderPayload(flat());
  assert.ok(lines.includes('At risk'), JSON.stringify(lines));
  assert.ok(lines.includes('$0.00'), JSON.stringify(lines));
  assert.ok(!lines.includes('Max loss'), `a max loss spent a figure: ${JSON.stringify(lines)}`);
});

test('an account the feed has not settled yet says nothing: no line, no figures, and never the empty sentence', async () => {
  // accountKnown false means every figure above it is null on purpose. Answering that with
  // "no trading money" is the window inventing a fact the venue has not stated, and a line
  // about the wait ("Still reading the account") was a status about the app's own plumbing
  // that every new window opened on. The line only appears when it has something to say.
  const data = funded();
  data.account = { ...data.account, accountKnown: false, equityUsd: null, freeUsd: null, healthPct: null } as never;
  const { host, lines } = await renderPayload(data);
  assert.ok(!lines.some((l) => l.startsWith('Still reading')), JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.startsWith('No trading money yet')), JSON.stringify(lines));
  const [line] = withClass(host, 'trade-line');
  assert.equal(line.hidden, true, 'a wait is not news');
  assert.equal(withClass(host, 'strip-stats')[0].hidden, true, 'no figures while none are known');
});

test('no money at all is one sentence that names the next step, with the clock ahead of it', async () => {
  const data = flat();
  data.account = { equityUsd: null, freeUsd: null, healthPct: null, unified: false, accountKnown: true, atRiskUsd: 0, maxLossUsd: 0 };
  data.fills = [];
  const world = await renderPayload(data);
  assert.ok(world.lines.includes('No trading money yet. Ask your assistant to fund it.'), JSON.stringify(world.lines));
  const [line] = withClass(world.host, 'trade-line');
  assert.equal(line.hidden, false);
  assert.equal(line.dataset.tone, undefined, 'an empty account is not a fault');
  assert.equal(line.childNodes[0].dataset.icon, 'waiting', 'the clock, not the deposit tray');
  // The line is written once: a payload that says the same thing keeps the node.
  const icon = line.childNodes[0];
  await world.refresh();
  assert.equal(line.childNodes[0], icon, 'the icon was rebuilt for a sentence that did not change');
});

test('the mark price is on the rail whether or not anything is open', async () => {
  const { host, lines } = await renderPayload(flat());
  const [mark] = withClass(host, 'trade-mark-price');
  assert.ok(mark !== undefined, 'the mark price has no type of its own');
  assert.equal(textOf(mark).join(''), '$60,000.00', `no mark price: ${JSON.stringify(lines)}`);
});

test('a market the payload does not price reads as unknown rather than as zero', async () => {
  const data = flat();
  data.markets = [];
  const { host } = await renderPayload(data);
  assert.equal(textOf(withClass(host, 'trade-mark-price')[0]).join(''), '--');
});

test('an unreachable venue says so in plain words rather than drawing its last numbers as current', async () => {
  // The sentence a person reads is plain; the venue's own words are there for the developer
  // switch and nowhere else (Karim read the raw error as scary debug output, 2026-09-15).
  const data = flat();
  data.venue = { connected: false, source: 'none', ageMs: null, latencyMs: null, error: 'connect ECONNREFUSED', degraded: true };
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('Not connected to Hyperliquid. Trying again.'), `the venue failed silently: ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => l.startsWith('No route to the venue')), 'the old sentence is still there');
  const [raw] = withClass(host, 'trade-line-raw');
  assert.equal(raw.textContent, 'connect ECONNREFUSED');
  assert.ok(raw.hasAttribute('data-dev-only'), 'the raw error is on screen without the developer switch');
});

test('the venue notice is drawn in the tone of the news: red with the link struck through for a shut socket, amber with a warning for an open one that errors', async () => {
  // The notice under the strip carries a data-tone the stylesheet washes and a drawn icon
  // ahead of the sentence (2026-09-15). A shut socket and an open socket that answers with an
  // error are different news and read differently; a wait is quiet; and with nothing to say
  // the row is gone rather than empty.
  // The notice is [icon][sentence][raw]: the raw span carries the venue's own words behind
  // the developer switch (data-dev-only) and is hidden outright while there are none.
  const shut = flat();
  shut.venue = { connected: false, source: 'none', ageMs: null, latencyMs: null, error: 'connect ECONNREFUSED', degraded: true };
  const a = await renderPayload(shut);
  const [down] = withClass(a.host, 'trade-line');
  assert.equal(down.hidden, false);
  assert.equal(down.dataset.tone, 'down');
  assert.equal(down.childNodes[0].dataset.icon, 'link-off', 'no drawn icon ahead of the sentence');
  assert.ok(down.childNodes[1].className.includes('trade-line-text'));
  assert.equal(down.childNodes[1].textContent, 'Not connected to Hyperliquid. Trying again.');
  assert.ok(down.childNodes[2].className.includes('trade-line-raw'));
  assert.ok(down.childNodes[2].hasAttribute('data-dev-only'), 'the raw words must wait for the developer switch');
  assert.equal(down.childNodes[2].hidden, false);
  assert.equal(down.childNodes[2].textContent, 'connect ECONNREFUSED');

  const erring = flat();
  erring.venue = { connected: true, source: 'ws', ageMs: 40, latencyMs: 12, error: 'spot read failed: hyperliquid /info 422: Failed to deserialize the JSON body into the target type', degraded: false };
  const b = await renderPayload(erring);
  const [warn] = withClass(b.host, 'trade-line');
  assert.equal(warn.dataset.tone, 'warn');
  assert.equal(warn.childNodes[0].dataset.icon, 'warning');
  assert.equal(warn.childNodes[1].textContent, 'Hyperliquid is not answering one of our reads. Trying again.');
  assert.equal(warn.childNodes[2].textContent, 'spot read failed: hyperliquid /info 422: Failed to deserialize the JSON body into the target type');
  assert.ok(!b.lines.some((l) => l.includes('422') && !l.startsWith('spot read failed')), 'the raw words leaked into the sentence');

  // No wallet yet: the read was skipped, not refused, so it is a quiet wait. Keyed off the
  // error's text until the feed carries it as a flag of its own.
  const walletless = flat();
  walletless.venue = { connected: true, source: 'ws', ageMs: 40, latencyMs: 12, error: 'spot read skipped: no wallet yet', degraded: false };
  const w = await renderPayload(walletless);
  const [wait] = withClass(w.host, 'trade-line');
  assert.equal(wait.dataset.tone, undefined, 'no wallet is not a fault');
  assert.equal(wait.childNodes[0].dataset.icon, 'waiting');
  assert.equal(wait.childNodes[1].textContent, 'Nothing to read until a wallet exists.');
  assert.equal(wait.childNodes[2].textContent, 'spot read skipped: no wallet yet');

  // An account the feed has not settled is not news: the line stays away.
  const reading = funded();
  reading.account = { ...reading.account, accountKnown: false, equityUsd: null, freeUsd: null, healthPct: null } as never;
  const c = await renderPayload(reading);
  const [quiet] = withClass(c.host, 'trade-line');
  assert.equal(quiet.hidden, true, 'a wait is not something to say');
  assert.equal(quiet.dataset.icon, undefined);

  const d = await renderPayload(flat());
  const [gone] = withClass(d.host, 'trade-line');
  assert.equal(gone.hidden, true);
  assert.equal(gone.dataset.icon, undefined, 'the icon leaves with the sentence');
  assert.equal(gone.childNodes.length, 2, 'only the empty text and raw spans stay');
  assert.equal(gone.childNodes[1].textContent, '');
});

test('an unreachable venue leaves the figures unknown rather than calling them empty', async () => {
  // Silence is not the same answer as zero. Printing the empty state here would be the window
  // stating a fact the venue has not stated. At risk is the app's own sum over its own plans,
  // so that one is still a number.
  const data = flat();
  data.account = { equityUsd: null, freeUsd: null, healthPct: null, unified: false, accountKnown: true, atRiskUsd: 0, maxLossUsd: 0 };
  data.venue = { connected: false, source: 'none', ageMs: null, latencyMs: null, error: 'no route to host', degraded: true };
  const { host, lines } = await renderPayload(data);
  assert.ok(!lines.some((l) => l.startsWith('No trading money yet')), JSON.stringify(lines));
  const [free] = withClass(host, 'strip-stats')[0].childNodes;
  assert.equal(free.childNodes[0].textContent, 'Free');
  assert.equal(free.childNodes[1].textContent, '--', 'free must read as unknown, not as empty');
  assert.ok(free.childNodes[1].className.includes('dim'));
});

// ---------- Open ----------

test('an open position is one line under headings: the coin and side, size, entry, mark, profit, and the distance to its exits', async () => {
  const { host } = await renderPayload(funded());
  const [head] = withClass(host, 'pos-head');
  assert.equal(head.hidden, false, 'the headings are hidden over a position');
  assert.deepEqual(textOf(head), ['Asset', 'Size', 'Entry', 'Mark', 'PnL', 'Stop', 'Target']);
  const [row] = withClass(host, 'pos-row');
  assert.ok(row !== undefined, 'no position row');
  const asset = row.childNodes[0];
  assert.equal(textOf(asset).join(' '), 'BTC Long 5x');
  assert.equal(asset.childNodes[2].dataset.tone, 'up', 'a long is toned up');
  assert.equal(row.childNodes[1].textContent, '0.5', 'no size');
  assert.equal(row.childNodes[2].textContent, '$58,000.00', 'no entry');
  assert.equal(row.childNodes[3].textContent, '$60,000.00', 'no mark');
  assert.equal(row.childNodes[4].textContent, '+$1,000.00', 'no profit');
  // Stop 57,000 against a 60,000 mark is 5% under it; target 62,000 is 3.3% over it. Signed,
  // so the eye reads which side of the price each one sits.
  assert.equal(row.childNodes[5].textContent, '-5.0%', 'no stop distance');
  assert.equal(row.childNodes[6].textContent, '+3.3%', 'no target distance');
  for (let i = 1; i <= 6; i += 1) assert.ok(row.childNodes[i].className.includes('mono'), `column ${i} is not in the mono face`);
  const [pnl] = withClass(host, 'trade-pnl');
  assert.ok(pnl.className.includes('up'), 'a profit is toned up');
  assert.ok(pnl.className.includes('mono'), 'a number is set in the mono face');
});

test('a short is toned down, and the headings go with the last position', async () => {
  const data = funded();
  data.positions[0] = { ...data.positions[0], side: 'short' } as never;
  const world = await renderPayload(data);
  const [row] = withClass(world.host, 'pos-row');
  assert.equal(row.childNodes[0].childNodes[2].textContent, 'Short');
  assert.equal(row.childNodes[0].childNodes[2].dataset.tone, 'down');
  const none = funded();
  none.positions = [];
  world.set(none);
  await world.refresh();
  assert.equal(withClass(world.host, 'pos-head')[0].hidden, true, 'headings over nothing');
});

test('a loss is toned down and carries its sign', async () => {
  const data = funded();
  data.positions[0] = { ...data.positions[0], unrealisedUsd: -42.5 } as never;
  const { host } = await renderPayload(data);
  const [pnl] = withClass(host, 'trade-pnl');
  assert.equal(pnl.textContent, '-$42.50');
  assert.ok(pnl.className.includes('down'));
});

test('a position with no open plan behind it takes its exits from the working triggers', async () => {
  const data = funded();
  data.plans = [waitingPlan()];
  data.orders = [
    { oid: 1, cloid: null, coin: 'BTC', side: 'sell', kind: 'trigger', role: 'stop', px: null, triggerPx: 54000, sizeCoin: 0.5, notionalUsd: 27000, reduceOnly: true, tif: null, atMs: 0, planId: null },
  ] as never;
  const { host } = await renderPayload(data);
  const [row] = withClass(host, 'pos-row');
  assert.equal(row.childNodes[5].textContent, '-10.0%');
  assert.equal(row.childNodes[6].textContent, '--', 'a target it does not have');
});

test('Close is a ghost button that asks once, then posts to the human door with the plan id', async () => {
  const world = await renderPayload(funded());
  const [close] = buttons(world.host).filter((b) => b.textContent === 'Close');
  assert.ok(close !== undefined, 'no Close button on the open position');
  assert.ok(close.className.includes('btn-ghost'));
  close.click();
  assert.equal(close.textContent, 'Sure?');
  assert.deepEqual(world.posts, [], 'one press moved money');
  close.click();
  assert.deepEqual(plain(world.posts), [{ path: '/api/trade/action', body: { action: 'close', id: 'pl_b2' } }]);
});

test('a confirm that is not answered in four seconds forgets itself', async () => {
  const world = await renderPayload(funded());
  const [close] = buttons(world.host).filter((b) => b.textContent === 'Close');
  close.click();
  assert.equal(close.textContent, 'Sure?');
  world.tick(4001);
  assert.equal(close.textContent, 'Close');
  close.click();
  assert.deepEqual(world.posts, [], 'a press after the window posted');
});

test('a confirm survives a payload landing between the two presses', async () => {
  // Trade frames arrive constantly. A person who pressed once and is reaching for the second
  // press must not find the button reset under their finger.
  const world = await renderPayload(funded());
  const [close] = buttons(world.host).filter((b) => b.textContent === 'Close');
  close.click();
  await world.refresh();
  const [again] = buttons(world.host).filter((b) => b.textContent === 'Sure?');
  assert.ok(again !== undefined, 'the confirm was lost on the refresh');
  again.click();
  assert.equal(world.posts.length, 1);
});

test('a position the app holds no open plan for has no Close, because there is no door for it', async () => {
  const data = funded();
  data.plans = [waitingPlan()];
  const { host } = await renderPayload(data);
  assert.equal(buttons(host).filter((b) => b.textContent === 'Close').length, 0);
});

// ---------- Waiting ----------

test('a waiting plan is one English line, an Armed pill with the armed icon, its conditions as dots, and Cancel', async () => {
  const { host, lines } = await renderPayload(funded());
  assert.ok(lines.includes('Long ETH $200 at 3x, market, stop 3,180, target 3,420'), JSON.stringify(lines));
  // The price in a condition is grouped like the prices on the line above it, and the
  // watcher's answer sits beside the sentence written here from the plan's own condition.
  assert.ok(lines.includes('a 1h bar closes above 3,300'), JSON.stringify(lines));
  assert.ok(lines.includes('volume on the 1h is at least 1.5x its 20-bar average'), JSON.stringify(lines));
  const conds = withClass(host, 'trade-cond');
  assert.deepEqual(conds.map((c) => c.dataset.holds), ['true', 'false']);
  assert.ok(!lines.includes('pl_a1'), `the id is not the line a person reads: ${JSON.stringify(lines)}`);
  const [state] = withClass(host, 'trade-row-state');
  assert.equal(textOf(state).join(''), 'Armed');
  assert.equal(state.dataset.tone, 'ink');
  assert.ok(state.childNodes[0].className.includes('icon'), 'no armed icon before the word');
  assert.ok(!state.className.includes('warn'));
  const [cancel] = buttons(host).filter((b) => b.textContent === 'Cancel');
  assert.ok(cancel !== undefined, 'no Cancel on the waiting plan');
});

test('Cancel confirms inline and posts cancel with the plan id', async () => {
  const world = await renderPayload(funded());
  const [cancel] = buttons(world.host).filter((b) => b.textContent === 'Cancel');
  cancel.click();
  assert.equal(cancel.textContent, 'Sure?');
  cancel.click();
  assert.deepEqual(plain(world.posts), [{ path: '/api/trade/action', body: { action: 'cancel', id: 'pl_a1' } }]);
});

test('a limit entry and a plan with no target read as they are', async () => {
  const data = funded();
  data.plans = [waitingPlan({ entry: { type: 'limit', px: 3100 }, target: undefined })];
  const { lines } = await renderPayload(data);
  assert.ok(lines.includes('Long ETH $200 at 3x, limit 3,100, stop 3,180'), JSON.stringify(lines));
});

test('every price on a waiting plan is one format: grouped thousands, the market\'s own places', async () => {
  // The line read "limit 76,729.1" over a condition reading "closes above 77017.9". BTC trades
  // in tenths on the venue (szDecimals 5, so one price place), and a price with more digits
  // than the market has rounds to the tick rather than printing places the venue cannot fill.
  const data = funded();
  data.plans = [waitingPlan({
    symbol: 'BTC',
    entry: { type: 'limit', px: 76729.1 },
    stop: 76500.123,
    target: 78000,
    when: [{ type: 'close', tf: '15m', is: 'above', at: { px: 77017.9 } }],
    holds: [{ condition: 'a 15m bar closes above 77017.9', holds: false }],
  })];
  const { lines } = await renderPayload(data);
  assert.ok(lines.includes('Long BTC $200 at 3x, limit 76,729.1, stop 76,500.1, target 78,000'), JSON.stringify(lines));
  assert.ok(lines.includes('a 15m bar closes above 77,017.9'), JSON.stringify(lines));
});

test('a locked plan and a blind plan say so in the waiting tone', async () => {
  const data = funded();
  data.plans = [waitingPlan({ id: 'pl_l', locked: true }), waitingPlan({ id: 'pl_b', blind: true })];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('Needs unlock'), JSON.stringify(lines));
  assert.ok(lines.includes('Feed stale'), JSON.stringify(lines));
  for (const state of withClass(host, 'trade-row-state')) {
    assert.ok(state.className.includes('warn'), state.className);
    assert.equal(state.dataset.tone, 'warn');
  }
});

test('an idea is listed under waiting as an Idea with its conditions unmet and no Cancel, since it was never armed', async () => {
  const data = funded();
  data.plans = [waitingPlan({ id: 'pl_i', status: 'idea', holds: undefined })];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('Long ETH $200 at 3x, market, stop 3,180, target 3,420'), JSON.stringify(lines));
  assert.ok(lines.includes('Idea'), JSON.stringify(lines));
  const [state] = withClass(host, 'trade-row-state');
  assert.equal(state.dataset.tone, undefined, 'an idea is the quiet pill');
  assert.ok(!state.className.includes('warn'));
  // No holds on an idea: the conditions still print, from the plan's own words, all hollow.
  const conds = withClass(host, 'trade-cond');
  assert.equal(conds.length, 2);
  assert.deepEqual(conds.map((c) => c.dataset.holds), ['false', 'false']);
  assert.equal(buttons(host).filter((b) => b.textContent === 'Cancel').length, 0);
});

test('a placed plan reads Placed, says the venue holds its entry, and can still be cancelled', async () => {
  const data = funded();
  data.plans = [waitingPlan({ id: 'pl_p', status: 'placed', entry: { type: 'limit', px: 3100 }, holds: undefined })];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('Placed'), JSON.stringify(lines));
  assert.equal(withClass(host, 'trade-row-state')[0].getAttribute('title'), 'The venue holds the entry');
  assert.equal(buttons(host).filter((b) => b.textContent === 'Cancel').length, 1);
});

// ---------- the shape of the deck ----------

test('nothing open, nothing waiting and nothing done is one line each, with no explanation', async () => {
  const data = flat();
  data.fills = [];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('Nothing open.'), JSON.stringify(lines));
  assert.ok(lines.includes('Nothing waiting.'), JSON.stringify(lines));
  assert.ok(lines.includes('Nothing yet.'), JSON.stringify(lines));
  for (const empty of withClass(host, 'trade-empty')) assert.equal(empty.tagName, 'p');
  assert.ok(!lines.some((l) => l.includes('the only thing that opens or closes anything here')), JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.includes('land here as they happen')), JSON.stringify(lines));
});

test('the deck is three tabs, Open, Waiting and Done, in that order, each with its count', async () => {
  const { host } = await renderPayload(funded());
  const list = tabs(host);
  assert.deepEqual(list.map((t) => t.label), ['Open', 'Waiting', 'Done']);
  assert.deepEqual(list.map((t) => t.count), ['1', '1', '0']);
  for (const t of list) {
    assert.equal(t.node.getAttribute('role'), 'tab');
    assert.ok(t.node.childNodes[1].className.includes('mono'), 'a count is set in the mono face');
  }
  // A zero is written, quietly.
  assert.equal(list[2].node.childNodes[1].dataset.zero, 'true');
  assert.equal(list[0].node.childNodes[1].dataset.zero, undefined);
  // Open is up first; the other two panels are hidden, not absent.
  assert.deepEqual(list.map((t) => t.selected), [true, false, false]);
  const panels = withClass(host, 'trade-panel');
  assert.deepEqual(panels.map((p) => p.getAttribute('role')), ['tabpanel', 'tabpanel', 'tabpanel']);
  assert.deepEqual(panels.map((p) => p.hidden), [false, true, true]);
  assert.equal(allWithTag(host, 'h2').length, 0, 'the old zone headings are gone');
});

test('pressing a tab brings its panel up, and the arrow keys move between them', async () => {
  const world = await renderPayload(funded());
  const list = tabs(world.host);
  list[2].node.click();
  assert.deepEqual(tabs(world.host).map((t) => t.selected), [false, false, true]);
  assert.deepEqual(withClass(world.host, 'trade-panel').map((p) => p.hidden), [true, true, false]);
  assert.equal(list[2].node.getAttribute('tabindex'), '0');
  assert.equal(list[0].node.getAttribute('tabindex'), '-1');
  // Right from the last wraps to the first; Home and End jump.
  list[2].node.fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual(tabs(world.host).map((t) => t.selected), [true, false, false]);
  list[0].node.fire('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(tabs(world.host).map((t) => t.selected), [false, false, true]);
  list[2].node.fire('keydown', { key: 'Home' });
  assert.deepEqual(tabs(world.host).map((t) => t.selected), [true, false, false]);
  // The choice survives the frames that keep landing.
  list[1].node.click();
  await world.refresh();
  assert.deepEqual(tabs(world.host).map((t) => t.selected), [false, true, false]);
});

test('the strip carries no Layout menu of its own: the bar has the one menu, on every mode', async () => {
  // It used to live here, which left the assistant column with no way back on Basic, Pro or
  // Vault once its eye-off had been pressed (Karim, 2026-09-15). The menu is the shell's now
  // (ui/screens/shell.js, tests/unit/topbar-ui.test.ts); the strip keeps the eye-off controls
  // on the chart and the deck headers, drawn by ui/split.js.
  const controls: string[] = [];
  const split = {
    panes: () => [],
    setPane: () => false,
    paneControl: (name: string) => { controls.push(name); return null; },
  };
  const world = await renderPayload(funded(), { split });
  assert.equal(withClass(world.host, 'layout').length, 0, 'the strip still draws a Layout button');
  assert.equal(withClass(world.host, 'layout-pop').length, 0, 'the strip still draws a Layout sheet');
  assert.deepEqual(controls.sort(), ['chart', 'deck'], 'the two headers do not ask for their eye-off control');
});

test('a row that appears enters, and a row that was already there does not', async () => {
  const world = await renderPayload(funded());
  const rows = withClass(world.host, 'trade-row');
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.ok(row.className.includes('trade-enter'), 'a new row did not enter');
  // The mark comes off once the animation has run, so a later pass can tell the two apart.
  world.tick(300);
  for (const row of rows) assert.ok(!row.className.includes('trade-enter'), 'a settled row still reads as entering');
  const data = funded();
  data.plans.push(waitingPlan({ id: 'pl_new', symbol: 'SOL' }));
  world.set(data);
  await world.refresh();
  const after = withClass(world.host, 'trade-row');
  const fresh = after.filter((r) => r.className.includes('trade-enter'));
  assert.equal(fresh.length, 1, 'only the row that appeared enters');
  assert.equal(fresh[0].dataset.spotKey, 'plan:pl_new');
});

test('every row the agent can point at carries its kind and id', async () => {
  const { host } = await renderPayload(funded());
  const keys = allWithDataset(host, 'spotKey').map((n) => n.dataset.spotKey);
  assert.ok(keys.includes('position:BTC'), JSON.stringify(keys));
  assert.ok(keys.includes('plan:pl_a1'), JSON.stringify(keys));
});

test('the market control is a listbox this window drew, not a native select', async () => {
  // A <select> renders with the operating system's own chrome, which was the one thing on the
  // surface that did not look finished.
  const { host } = await renderPayload(flat());
  assert.equal(allWithTag(host, 'select').length, 0, 'the native select is back');
  const options = withClass(host, 'trade-option');
  assert.deepEqual(options.map((o) => textOf(o).join('')), ['BTC-USD']);
  assert.equal(options[0].getAttribute('role'), 'option');
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  // Each option leads with the coin's logo, the way the control itself does.
  assert.equal(options[0].childNodes.length, 2);
  assert.equal(options[0].childNodes[1].className, 'trade-option-name');
});

// ---------- the bar ----------

function byId(node: Node, id: string): Node | null {
  if (node.id === id) return node;
  for (const child of node.childNodes) {
    const hit = byId(child, id);
    if (hit) return hit;
  }
  return null;
}

test('the bar is one segmented control, the command, Layers and one status line; the market is on the strip', async () => {
  const { host } = await renderPayload(funded());
  const [seg] = withClass(host, 'seg');
  assert.ok(seg !== undefined, 'no segmented control');
  // The timeframes (filled by the chart engine into #timeframes) are the segment; the market
  // moved up to the strip, where its logo is.
  assert.ok(byId(seg, 'timeframes') !== null, 'the timeframes are not in the segment');
  assert.equal(withClass(seg, 'trade-symbol').length, 0, 'the market is still in the segment');
  const [strip] = withClass(host, 'trade-strip');
  assert.equal(withClass(strip, 'trade-symbol').length, 1, 'the market is not on the strip');
  // The indicator command: a search glyph ahead of the input the engine binds by id, and a
  // placeholder that says what typing here does.
  const cmd = byId(host, 'chart-cmd');
  assert.ok(cmd !== null, 'the indicator command is gone');
  assert.equal(cmd.getAttribute('placeholder') ?? (cmd as unknown as { placeholder: string }).placeholder, 'Add indicator');
  assert.ok(cmd.parentNode !== null && cmd.parentNode.className.includes('chart-cmd-wrap'), 'the command has no wrap for its glyph');
  assert.equal(cmd.parentNode.childNodes[0].dataset.icon, 'search', 'no search glyph ahead of the command');
  const [layers] = withClass(host, 'layers');
  assert.ok(layers !== undefined, 'no Layers control');
  assert.equal(layers.tagName, 'button');
  assert.ok(textOf(layers).includes('Layers'));
  // The floating word and the venue cycling button are gone.
  assert.ok(!textOf(host).includes('Draw'), 'the word Draw is still on the bar');
  const provider = byId(host, 'chart-provider');
  assert.ok(provider !== null, 'the engine writes the venue into #chart-provider');
  assert.notEqual(provider.tagName, 'button', 'the venue is a word now, not a cycling button');
  // Every id the engine binds by name is still there.
  for (const id of ['chart', 'chart-hud', 'chartwrap', 'panel-chart', 'timeframes', 'chart-cmd', 'chart-status', 'chart-feed']) {
    assert.ok(byId(host, id) !== null, `#${id} is missing`);
  }
});

test('the status line is a dot, the state word and the latency slot, all three left to the engine', async () => {
  const data = funded();
  data.venue = { connected: true, source: 'ws', ageMs: 40, latencyMs: 4_800, error: null, degraded: false };
  const { host } = await renderPayload(data);
  const feed = byId(host, 'chart-feed');
  assert.ok(feed !== null);
  assert.equal(feed.dataset.feed, 'offline', 'the engine owns the state word; it starts offline');
  assert.equal(feed.childNodes[0].tagName, 'i', 'no dot');
  assert.equal(feed.childNodes[1].tagName, 'b', 'no state word for the engine to write');
  const ms = byId(host, 'chart-latency');
  assert.ok(ms !== null, 'no latency slot for the engine to write');
  // The trading payload's venue.latencyMs is the age of the account snapshot, which the venue
  // pushes every 5 s. Painted here it read 0 to 5000 ms and reset beside a price that moved
  // every half second. The slot belongs to the chart engine, which writes the delay of the
  // socket that actually serves the bars (tests/unit/chart-status-ui.test.ts).
  assert.equal(ms.textContent, '', 'the trade screen must not paint the account age as the chart latency');
});

test('the bar reads left to right: the segment, the command, Layers, one status group, then the eyes in a group of their own', async () => {
  // The eye-off controls come from ui/split.js; the stand-in hands back a button per pane so
  // the group at the end of the bar can be read.
  const split = {
    panes: () => [],
    setPane: () => false,
    paneControl: (name: string) => {
      const b = makeNode('button');
      b.className = 'pane-hide';
      b.dataset.pane = name;
      return b;
    },
    paneRestore: (name: string) => {
      const b = makeNode('button');
      b.className = 'pane-show';
      b.dataset.pane = name;
      return b;
    },
  };
  const { host } = await renderPayload(funded(), { split });
  const [bar] = withClass(host, 'chart-bar');
  assert.deepEqual(bar.childNodes.map((n) => n.className.split(' ')[0]), ['seg', 'chart-cmd-wrap', 'layers-wrap', 'chartstatus', 'chart-bar-eyes']);
  const eyes = bar.childNodes[4];
  assert.deepEqual(eyes.childNodes.map((n) => n.dataset.pane), ['deck', 'chart'], 'the way back to the deck, then the chart\'s own eye-off');
  assert.equal(bar.childNodes[3].id, 'chart-status');
});

test('ten timeframes fit the segment as ten equal cells', async () => {
  // The engine fills #timeframes with a button per timeframe the server lists; 1w and 1M make
  // ten. Equal widths are the stylesheet's: one grid column of one fraction per cell, which
  // the harness cannot lay out, so the rule is read off the sheet.
  const { host } = await renderPayload(funded());
  const cells = byId(host, 'timeframes');
  assert.ok(cells !== null);
  for (const label of ['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '1w', '1M']) {
    const b = makeNode('button');
    b.className = 'timeframe';
    b.textContent = label;
    cells.appendChild(b);
  }
  assert.equal(cells.childNodes.length, 10);
  assert.ok(cells.className.includes('seg-cells'));
  const css = readFileSync(new URL('../../ui/design/trade.css', import.meta.url), 'utf8');
  assert.ok(/\.seg-cells\s*\{[^}]*grid-auto-columns:\s*1fr/.test(css), 'the cells are not equal columns');
});

test('Layers holds the seven overlays and volume as check rows, following the payload', async () => {
  const { host } = await renderPayload(funded());
  const rows = allWithDataset(host, 'overlay');
  assert.equal(rows.length, 7);
  const state: Record<string, string | null> = {};
  for (const row of rows) {
    assert.equal(row.getAttribute('role'), 'menuitemcheckbox');
    state[row.dataset.overlay] = row.getAttribute('aria-checked');
  }
  assert.equal(state.position, 'true');
  assert.equal(state.liquidation, 'false');
  assert.equal(state.planStop, 'true');
  // An overlay the payload does not name is on, which is the server's default.
  assert.equal(state.stops, 'true');
  const [volume] = allWithDataset(host, 'layer');
  assert.ok(volume !== undefined, 'no volume row');
  assert.equal(volume.dataset.layer, 'volume');
  // The labels are sentence case words, not ids.
  const labels = withClass(host, 'layers-row').map((r) => textOf(r).join(''));
  assert.ok(labels.includes('Position'), JSON.stringify(labels));
  assert.ok(labels.includes('Plan stop'), JSON.stringify(labels));
  assert.ok(labels.includes('Volume'), JSON.stringify(labels));
  assert.ok(!labels.some((l) => /[A-Z]{2,}/.test(l)), `a tracked caps label: ${JSON.stringify(labels)}`);
});

test('the popover opens from its button, closes on Escape and on a click outside', async () => {
  const world = await renderPayload(funded());
  const [layers] = withClass(world.host, 'layers');
  const [pop] = withClass(world.host, 'layers-pop');
  assert.notEqual(pop.dataset.open, 'true');
  layers.click();
  assert.equal(pop.dataset.open, 'true');
  assert.equal(layers.getAttribute('aria-expanded'), 'true');
  world.fire('keydown', { key: 'Escape' });
  assert.notEqual(pop.dataset.open, 'true');
  assert.equal(layers.getAttribute('aria-expanded'), 'false');
  layers.click();
  assert.equal(pop.dataset.open, 'true');
  // A click on the rail is outside; a click on a row inside is not.
  const [row] = withClass(world.host, 'layers-row');
  world.fire('click', { target: row });
  assert.equal(pop.dataset.open, 'true');
  world.fire('click', { target: world.host });
  assert.notEqual(pop.dataset.open, 'true');
});

test('a check row writes the overlay to the server and flips at once', async () => {
  const world = await renderPayload(funded());
  const [row] = allWithDataset(world.host, 'overlay').filter((r) => r.dataset.overlay === 'liquidation');
  row.click();
  assert.equal(row.getAttribute('aria-checked'), 'true');
  assert.deepEqual(plain(world.posts), [{ path: '/api/trade', body: { overlay: { name: 'liquidation', on: true } } }]);
});

test('the volume row is the window\'s own pane and never reaches the server', async () => {
  const set: boolean[] = [];
  const world = await renderPayload(funded());
  world.window.chartSetVolume = (on: boolean) => set.push(on);
  world.window.chartVolumeOn = () => set.length === 0 ? true : set[set.length - 1];
  const [volume] = allWithDataset(world.host, 'layer');
  volume.click();
  assert.deepEqual(set, [false]);
  assert.equal(volume.getAttribute('aria-checked'), 'false');
  assert.deepEqual(world.posts, []);
});

test('the toggles no longer write a global nothing reads', async () => {
  const source = readFileSync(new URL('../../ui/screens/trade.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('TRADE_OVERLAYS'));
  assert.ok(source.includes("'/api/trade'"), 'the toggle has to reach the server to reach the canvas');
});

test('nothing the payload carries reaches the DOM as markup', () => {
  const source = readFileSync(new URL('../../ui/screens/trade.js', import.meta.url), 'utf8');
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(source), false);
});

// ---------- the spotlight ----------

function highlight(over: Record<string, unknown> = {}) {
  return { kind: 'plan', id: 'pl_a1', note: 'This one waits on the hourly close.', source: 'agent', at: '2026-09-11T14:00:00.000Z', atMs: 1, ttlSec: 300, ...over };
}

test('a highlight rings its row twice, dims the rows beside it, and writes the note under it', async () => {
  const data = funded();
  data.highlights = [highlight()];
  const world = await renderPayload(data);
  const rows = withClass(world.host, 'trade-row');
  const [spot] = rows.filter((r) => r.dataset.spotKey === 'plan:pl_a1');
  assert.ok(spot !== undefined);
  assert.equal(spot.dataset.spot, 'true');
  // The pulse is one WAAPI animation: two rings over 1.2 s, ease-out.
  assert.equal(spot.animations.length, 1);
  const pulse = plain(spot.animations[0]) as { frames: Array<{ boxShadow: string }>; opts: { duration: number; easing: string } };
  assert.equal(pulse.opts.duration, 1200);
  assert.equal(pulse.opts.easing, 'ease-out');
  const rings = pulse.frames.filter((f) => /0 0 0 2px/.test(f.boxShadow)).length;
  assert.equal(rings, 2, `the ring pulses ${rings} times, not twice`);
  for (const other of rows.filter((r) => r !== spot)) assert.equal(other.dataset.dim, 'true', 'a sibling row was not dimmed');
  const [callout] = withClass(spot, 'trade-callout');
  assert.ok(callout !== undefined, 'no callout under the row');
  assert.equal(callout.textContent, 'This one waits on the hourly close.');
  assert.equal(callout.hidden, false);
});

test('the ring and the dim last 1.2 s; the note stays while the highlight is live', async () => {
  const data = funded();
  data.highlights = [highlight()];
  const world = await renderPayload(data);
  world.tick(1201);
  const rows = withClass(world.host, 'trade-row');
  for (const row of rows) {
    assert.notEqual(row.dataset.spot, 'true', 'the ring outlived its 1.2 s');
    assert.notEqual(row.dataset.dim, 'true', 'the dim outlived its 1.2 s');
  }
  const [spot] = rows.filter((r) => r.dataset.spotKey === 'plan:pl_a1');
  assert.equal(withClass(spot, 'trade-callout')[0].hidden, false);
  // Expired on the server: the payload no longer carries it, and the note goes with it.
  const later = funded();
  later.highlights = [];
  world.set(later);
  await world.refresh();
  const [after] = withClass(world.host, 'trade-row').filter((r) => r.dataset.spotKey === 'plan:pl_a1');
  assert.equal(withClass(after, 'trade-callout')[0].hidden, true);
});

test('a highlight pulses once when it arrives, not on every frame that carries it', async () => {
  const data = funded();
  data.highlights = [highlight()];
  const world = await renderPayload(data);
  await world.refresh();
  await world.refresh();
  const [spot] = withClass(world.host, 'trade-row').filter((r) => r.dataset.spotKey === 'plan:pl_a1');
  assert.equal(spot.animations.length, 1);
  // The same row pointed at again is a new highlight, and it pulses again.
  const again = funded();
  again.highlights = [highlight({ atMs: 2, at: '2026-09-11T14:05:00.000Z' })];
  world.set(again);
  await world.refresh();
  assert.equal(spot.animations.length, 2);
});

test('reduced motion keeps the dim and drops the pulse', async () => {
  const data = funded();
  data.highlights = [highlight()];
  const world = await renderPayload(data, { reduced: true });
  const rows = withClass(world.host, 'trade-row');
  const [spot] = rows.filter((r) => r.dataset.spotKey === 'plan:pl_a1');
  assert.equal(spot.animations.length, 0, 'the pulse ran under reduced motion');
  assert.equal(spot.dataset.spot, 'true');
  for (const other of rows.filter((r) => r !== spot)) assert.equal(other.dataset.dim, 'true');
});

test('a highlight on a fill lands on the tape, and one on a position lands on the open row', async () => {
  const data = funded();
  data.fills = [fill({ tid: 'tid9' })];
  data.highlights = [highlight({ kind: 'fill', id: 'tid9', note: 'Your entry.' }), highlight({ kind: 'position', id: 'BTC', note: 'Up since the open.' })];
  const world = await renderPayload(data);
  const [tape] = withClass(world.host, 'done-row').filter((r) => r.dataset.spotKey === 'fill:tid9');
  assert.equal(tape.dataset.spot, 'true');
  assert.equal(withClass(tape, 'trade-callout')[0].textContent, 'Your entry.');
  const [open] = withClass(world.host, 'trade-row').filter((r) => r.dataset.spotKey === 'position:BTC');
  assert.equal(open.dataset.spot, 'true');
  assert.equal(withClass(open, 'trade-callout')[0].textContent, 'Up since the open.');
});

test('a highlight brings up the tab its row sits under, so a pointer never lands behind a tab', async () => {
  const data = funded();
  data.fills = [fill({ tid: 'tid9' })];
  const world = await renderPayload(data);
  assert.deepEqual(tabs(world.host).map((t) => t.selected), [true, false, false]);
  const later = funded();
  later.fills = [fill({ tid: 'tid9' })];
  later.highlights = [highlight({ kind: 'fill', id: 'tid9', note: 'Your entry.' })];
  world.set(later);
  await world.refresh();
  assert.deepEqual(tabs(world.host).map((t) => t.selected), [false, false, true]);
  const again = funded();
  again.fills = [fill({ tid: 'tid9' })];
  again.highlights = [highlight({ kind: 'plan', id: 'pl_a1', atMs: 5 })];
  world.set(again);
  await world.refresh();
  assert.deepEqual(tabs(world.host).map((t) => t.selected), [false, true, false]);
});

test('the canvas is told which objects are lit, for 1.2 s, and repainted at both ends', async () => {
  const data = funded();
  data.highlights = [highlight({ kind: 'level', id: 'lv_3', note: '' }), highlight({ kind: 'plan', id: 'pl_a1' })];
  const paints: boolean[] = [];
  const world = await renderPayload(data, { onInvalidate: (scene: boolean) => paints.push(scene) });
  const active = world.window.chartSpotActive as (kind: string, id: string) => boolean;
  assert.equal(typeof active, 'function');
  assert.equal(active('level', 'lv_3'), true);
  assert.equal(active('plan', 'pl_a1'), true);
  assert.equal(active('line', 'tl_1'), false);
  assert.ok(paints.length >= 1, 'the chart was not asked to repaint when the spotlight came on');
  const before = paints.length;
  world.tick(1201);
  assert.equal(active('level', 'lv_3'), false);
  assert.ok(paints.length > before, 'the chart was not asked to repaint when the spotlight went off');
});

test('the note reaches the DOM as text, never as markup', async () => {
  const data = funded();
  data.highlights = [highlight({ note: '<b onclick="x()">bold</b>' })];
  const world = await renderPayload(data);
  const [spot] = withClass(world.host, 'trade-row').filter((r) => r.dataset.spotKey === 'plan:pl_a1');
  assert.equal(withClass(spot, 'trade-callout')[0].textContent, '<b onclick="x()">bold</b>');
});
