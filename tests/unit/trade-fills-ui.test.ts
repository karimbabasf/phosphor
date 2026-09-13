// The trade rail, which is where a person reads what their bot is holding, what it is
// waiting to do, and what it did.
//
// Four zones since the execution rebuild (2026-09-11): Status, Open, Waiting, Done. What is
// asserted below is the text a person would read in each, the shape of an empty answer (one
// line, no explanation), and the two controls the rail has: Close on a position and Cancel on
// a plan, which confirm inline and post to the human-only door.
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
  animations: unknown[];
  animate: (frames: unknown, opts: unknown) => { cancel: () => void };
};

// Enough of a DOM for the keyed reconciler in ui/core/dom.js, which is what the lists are built
// with: it needs insertBefore, removeChild, firstChild, nextSibling and parentNode to be real.
// Listeners are kept so a test can press a button, and animate() records what the spotlight
// asked for so a test can read the pulse without a compositor.
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
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      (listeners[type] = listeners[type] ?? []).push(fn);
    },
    removeEventListener: () => {},
    focus: () => {},
    click: () => {
      for (const fn of listeners.click ?? []) fn({ currentTarget: node, target: node, preventDefault: () => {} });
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
    atMs: Date.UTC(2026, 8, 1, 14, 30, 0),
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
    orders: [],
    plans: [openPlan(), waitingPlan()],
    highlights: [],
    products: ['BTC-USD'],
    fills: [],
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

type World = { host: Node; lines: string[]; posts: Array<{ path: string; body: Record<string, unknown> }>; refresh: () => Promise<void>; set: (d: unknown) => void; tick: (ms: number) => void };

async function renderPayload(data: unknown, opts: { reduced?: boolean } = {}): Promise<World> {
  const host = makeNode('div');
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
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
  const sandbox: Record<string, any> = {
    console,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    document: {
      createElement: (tag: string) => makeNode(tag),
      getElementById: (id: string) => (id === 'view-trade' ? host : null),
      addEventListener: () => {},
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
    PhosphorEvents: { on: () => {} },
    PhosphorNet: {
      readable: (e: unknown) => String(e),
      postJson: async (path: string, body: Record<string, unknown>) => {
        posts.push({ path, body });
        return { ok: true };
      },
    },
    PhosphorApi: {
      trade: async () => ({ fresh: true, data: current }),
      tradeAction: async (body: Record<string, unknown>) => {
        posts.push({ path: '/api/trade/action', body });
        return { ok: true };
      },
    },
    PhosphorShell: { view: () => 'basic', setPending: () => {} },
    PhosphorAgent: { mount: () => {} },
  };
  sandbox.globalThis = sandbox;
  createContext(sandbox);

  for (const file of ['../../ui/core/dom.js', '../../ui/screens/trade.js']) {
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
    refresh: () => sandbox.window.PhosphorTrade.refresh(),
    set: (d: unknown) => {
      current = d;
    },
    tick,
  };
}

async function render(sizeCoin: number, szDecimals: number | null): Promise<string[]> {
  const out = await renderPayload(payload(sizeCoin, szDecimals));
  return out.lines;
}

// ---------- Done: the fills ----------

test('a fill prints the size that was actually traded, not zero', async () => {
  const lines = await render(0.001, 5);
  assert.ok(
    lines.some((l) => l === 'Bought BTC 0.001'),
    `the list never said what was bought: ${JSON.stringify(lines)}`,
  );
});

test('a fill carries the time it happened', async () => {
  const lines = await render(0.001, 5);
  assert.ok(lines.some((l) => /^\d{2}:\d{2}$/.test(l)), `no clock beside the fill: ${JSON.stringify(lines)}`);
});

test('an asset the venue reports no precision for still prints a real size', async () => {
  // No szDecimals means the general rule applies: four places, so this rounds to 0.0003. What
  // it must never do is round to nothing.
  const lines = await render(0.00025, null);
  const row = lines.find((l) => l.startsWith('Bought BTC '));
  assert.ok(row !== undefined, JSON.stringify(lines));
  assert.notEqual(row, 'Bought BTC 0', 'a size rounded away to nothing');
  assert.ok(Number(row.replace('Bought BTC ', '')) > 0);
});

test('a whole-number asset still shows a fraction rather than rounding it to nothing', async () => {
  const lines = await render(0.001, 0);
  assert.ok(
    lines.some((l) => l.startsWith('Bought BTC 0.001')),
    `rounded to nothing at the asset's own precision: ${JSON.stringify(lines)}`,
  );
});

test('a large fill keeps the thousands separator and does not grow decimals it does not need', async () => {
  const lines = await render(12500, 2);
  assert.ok(lines.some((l) => l === 'Bought BTC 12,500'), JSON.stringify(lines));
});

test('a done plan sits in the tape with the reason it ended, one line each, newest first', async () => {
  const data = flat();
  data.plans = [
    openPlan({ id: 'pl_s1', status: 'done', endReason: 'stopped', updatedAt: '2026-09-01T14:40:00.000Z' }),
    openPlan({ id: 'pl_c2', symbol: 'ETH', side: 'short', status: 'done', endReason: 'cancelled', updatedAt: '2026-09-01T14:20:00.000Z' }),
    openPlan({ id: 'pl_f3', status: 'done', endReason: 'failed:plan on disk does not match its approval', updatedAt: '2026-09-01T14:10:00.000Z' }),
  ];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('Stopped long BTC'), JSON.stringify(lines));
  assert.ok(lines.includes('Cancelled short ETH'), JSON.stringify(lines));
  assert.ok(lines.includes('Failed, plan on disk does not match its approval'), JSON.stringify(lines));
  // The id rides beside the words, so the row the agent names is the row the person sees.
  assert.ok(lines.includes('pl_s1'), JSON.stringify(lines));
  const rows = withClass(host, 'done-row');
  assert.equal(rows.length, 4, 'three done plans and one fill');
  // 14:40 stopped, 14:30 fill, 14:20 cancelled, 14:10 failed.
  assert.deepEqual(
    rows.map((r) => r.childNodes[1].textContent),
    ['Stopped long BTC', 'Bought BTC 0.001', 'Cancelled short ETH', 'Failed, plan on disk does not match its approval'],
  );
});

test('the tape stops at twenty', async () => {
  const data = flat();
  data.fills = Array.from({ length: 30 }, (_, i) => fill({ tid: 't' + i, atMs: Date.UTC(2026, 8, 1, 14, i, 0) }));
  const { host } = await renderPayload(data);
  assert.equal(withClass(host, 'done-row').length, 20);
});

test('the tape owns its host, so nothing is left under it for the reconciler to trip on', async () => {
  // dom.reconcile removes everything after the last row it placed. A footer under the list would
  // have to be put back every pass, so there is none.
  const { host } = await renderPayload(payload(0.001, 5));
  const [list] = withClass(host, 'trade-zone-body').filter((n) =>
    n.childNodes.some((c) => c.className.includes('done-row')),
  );
  assert.ok(list !== undefined, 'no tape');
  for (const child of list.childNodes) {
    assert.ok(child.className.includes('done-row'), `something else is in the list: ${child.className}`);
  }
});

// ---------- Status ----------

test('the status zone is the coin, the mark, free collateral and what the plans put at risk', async () => {
  const { host, lines } = await renderPayload(funded());
  assert.ok(!lines.includes('No trading money yet.'), `a funded account was told it had none: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('Free'), JSON.stringify(lines));
  assert.ok(lines.includes('$3,100.25'), JSON.stringify(lines));
  assert.ok(lines.includes('At risk'), JSON.stringify(lines));
  assert.ok(lines.includes('$6,000.00'), JSON.stringify(lines));
  assert.ok(lines.includes('Max loss'), JSON.stringify(lines));
  assert.ok(lines.includes('$517.40'), JSON.stringify(lines));
  // The coin is a name set in the text face, not a tracked-caps label.
  const [coin] = withClass(host, 'trade-mark-coin');
  assert.equal(coin.textContent, 'BTC');
});

test('max loss is only a line when there is one', async () => {
  const { lines } = await renderPayload(flat());
  assert.ok(lines.includes('At risk'), JSON.stringify(lines));
  assert.ok(lines.includes('$0.00'), JSON.stringify(lines));
  assert.ok(!lines.includes('Max loss'), `a zero max loss spent a line: ${JSON.stringify(lines)}`);
});

test('an account the feed has not settled yet says it is waiting, not that it is empty', async () => {
  // accountKnown false means every figure above it is null on purpose. Answering that with
  // "no trading money" is the window inventing a fact the venue has not stated.
  const data = funded();
  data.account = { ...data.account, accountKnown: false, equityUsd: null, freeUsd: null, healthPct: null } as never;
  const { lines } = await renderPayload(data);
  assert.ok(lines.some((l) => l.startsWith('Still reading the account')), JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.startsWith('No trading money yet')), JSON.stringify(lines));
});

test('no money at all is one sentence that names the next step', async () => {
  const data = flat();
  data.account = { equityUsd: null, freeUsd: null, healthPct: null, unified: false, accountKnown: true, atRiskUsd: 0, maxLossUsd: 0 };
  data.fills = [];
  const { lines } = await renderPayload(data);
  assert.ok(lines.includes('No trading money yet. Ask your assistant to fund it.'), JSON.stringify(lines));
});

test('the mark price is on the rail whether or not anything is open', async () => {
  const { host, lines } = await renderPayload(flat());
  assert.ok(lines.includes('$60,000.00'), `no mark price: ${JSON.stringify(lines)}`);
  const [mark] = withClass(host, 'trade-mark-price');
  assert.ok(mark !== undefined, 'the mark price has no type of its own');
  assert.equal(mark.textContent, '$60,000.00');
});

test('a market the payload does not price reads as unknown rather than as zero', async () => {
  const data = flat();
  data.markets = [];
  const { host } = await renderPayload(data);
  assert.equal(withClass(host, 'trade-mark-price')[0].textContent, '--');
});

test('an unreachable venue says so rather than drawing its last numbers as current', async () => {
  const data = flat();
  data.venue = { connected: false, source: 'none', ageMs: null, latencyMs: null, error: 'connect ECONNREFUSED', degraded: true };
  const { lines } = await renderPayload(data);
  assert.ok(
    lines.some((l) => l.startsWith('No route to the venue') && l.includes('connect ECONNREFUSED')),
    `the venue failed silently: ${JSON.stringify(lines)}`,
  );
});

test('an unreachable venue leaves the figures unknown rather than calling them empty', async () => {
  // Silence is not the same answer as zero. Printing the empty state here would be the window
  // stating a fact the venue has not stated. At risk is the app's own sum over its own plans,
  // so that one is still a number.
  const data = flat();
  data.account = { equityUsd: null, freeUsd: null, healthPct: null, unified: false, accountKnown: true, atRiskUsd: 0, maxLossUsd: 0 };
  data.venue = { connected: false, source: 'none', ageMs: null, latencyMs: null, error: 'no route to host', degraded: true };
  const { lines } = await renderPayload(data);
  assert.ok(!lines.some((l) => l.startsWith('No trading money yet')), JSON.stringify(lines));
  assert.equal(lines.filter((l) => l === '--').length, 2, `expected the mark and free as --: ${JSON.stringify(lines)}`);
});

// ---------- Open ----------

test('an open position is a title, its profit, size, entry, and the distance to its exits', async () => {
  const { host, lines } = await renderPayload(funded());
  assert.ok(lines.includes('Long BTC'), JSON.stringify(lines));
  assert.ok(lines.includes('+$1,000.00'), `no profit: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('0.5'), `no size: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('$58,000.00'), `no entry: ${JSON.stringify(lines)}`);
  // Stop 57,000 against a 60,000 mark is 5% under it; target 62,000 is 3.3% over it. Signed,
  // so the eye reads which side of the price each one sits.
  assert.ok(lines.includes('-5.0%'), `no stop distance: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('+3.3%'), `no target distance: ${JSON.stringify(lines)}`);
  const [pnl] = withClass(host, 'trade-pnl');
  assert.ok(pnl.className.includes('up'), 'a profit is toned up');
  assert.ok(pnl.className.includes('mono'), 'a number is set in the mono face');
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
  const { lines } = await renderPayload(data);
  assert.ok(lines.includes('-10.0%'), JSON.stringify(lines));
  assert.ok(!lines.includes('Target'), `a target it does not have: ${JSON.stringify(lines)}`);
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

test('a waiting plan is one English line, its conditions as dots, and Cancel', async () => {
  const { host, lines } = await renderPayload(funded());
  assert.ok(lines.includes('Long ETH $200 at 3x, market, stop 3,180, target 3,420'), JSON.stringify(lines));
  assert.ok(lines.includes('a 1h bar closes above 3300'), JSON.stringify(lines));
  assert.ok(lines.includes('volume on the 1h is at least 1.5x its 20-bar average'), JSON.stringify(lines));
  const conds = withClass(host, 'trade-cond');
  assert.deepEqual(conds.map((c) => c.dataset.holds), ['true', 'false']);
  assert.ok(!lines.includes('pl_a1'), `the id is not the line a person reads: ${JSON.stringify(lines)}`);
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

test('a locked plan and a blind plan say so in the waiting tone', async () => {
  const data = funded();
  data.plans = [waitingPlan({ id: 'pl_l', locked: true }), waitingPlan({ id: 'pl_b', blind: true })];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('waiting, needs unlock'), JSON.stringify(lines));
  assert.ok(lines.includes('waiting, feed stale'), JSON.stringify(lines));
  for (const state of withClass(host, 'trade-row-state')) assert.ok(state.className.includes('warn'), state.className);
});

test('an idea is listed under waiting with its conditions unmet and no Cancel, since it was never armed', async () => {
  const data = funded();
  data.plans = [waitingPlan({ id: 'pl_i', status: 'idea', holds: undefined })];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('Long ETH $200 at 3x, market, stop 3,180, target 3,420'), JSON.stringify(lines));
  assert.ok(lines.includes('idea, not armed'), JSON.stringify(lines));
  // No holds on an idea: the conditions still print, from the plan's own words, all hollow.
  const conds = withClass(host, 'trade-cond');
  assert.equal(conds.length, 2);
  assert.deepEqual(conds.map((c) => c.dataset.holds), ['false', 'false']);
  assert.equal(buttons(host).filter((b) => b.textContent === 'Cancel').length, 0);
});

test('a placed plan says the venue holds its entry, and can still be cancelled', async () => {
  const data = funded();
  data.plans = [waitingPlan({ id: 'pl_p', status: 'placed', entry: { type: 'limit', px: 3100 }, holds: undefined })];
  const { host, lines } = await renderPayload(data);
  assert.ok(lines.includes('placed, the venue holds the entry'), JSON.stringify(lines));
  assert.equal(buttons(host).filter((b) => b.textContent === 'Cancel').length, 1);
});

// ---------- the shape of the rail ----------

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

test('the zones are headed Open, Waiting and Done, in that order, in sentence case', async () => {
  const { host } = await renderPayload(flat());
  assert.deepEqual(allWithTag(host, 'h2').map((h) => h.textContent), ['Open', 'Waiting', 'Done']);
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
  assert.deepEqual(options.map((o) => o.textContent), ['BTC-USD']);
  assert.equal(options[0].getAttribute('role'), 'option');
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
});

test('the overlay chips follow the payload, because the canvas reads the payload', async () => {
  // ui/chart/trade-overlay.js reads data.overlays. These used to write a window global
  // nothing has ever read, so a chip could sit pressed while the overlay under it was off.
  const { host } = await renderPayload(funded());
  const chips = allWithDataset(host, 'overlay');
  assert.equal(chips.length, 3);
  const state: Record<string, string | null> = {};
  for (const chip of chips) state[chip.dataset.overlay] = chip.getAttribute('aria-pressed');
  assert.equal(state.position, 'true');
  assert.equal(state.liquidation, 'false');
  assert.equal(state.planStop, 'true');
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
