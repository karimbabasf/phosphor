// The strip's price is the chart's last trade, not the venue's mark.
//
// The mark reaches the strip once a second through /api/trade and a six-part render, while
// the chart's own candle frames arrive as 120 ms deltas with no fetch behind them; a strip
// that showed the mark stepped while the chart moved per trade, cents to dollars apart
// (Karim, 2026-09-16: "the price is stalling"). What is asserted below: a candle frame for
// the market on the strip moves the big figure with no /api/trade fetch, a frame for another
// market does not, a burst of frames paints once per animation frame with the newest value,
// the day's high and low fold the live bar in, and the mark survives as the figure's title.
//
// Run against the REAL ui/core/dom.js and ui/screens/trade.js over a small stand-in DOM, the
// way tests/unit/trade-fills-ui.test.ts does.

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
  title: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  childNodes: Node[];
  parentNode: Node | null;
  readonly children: Node[];
  readonly firstChild: Node | null;
  readonly nextSibling: Node | null;
  appendChild: (n: Node) => Node;
  insertBefore: (n: Node, before: Node | null) => Node;
  removeChild: (n: Node) => Node;
  setAttribute: (n: string, v: string) => void;
  getAttribute: (n: string) => string | null;
  hasAttribute: (n: string) => boolean;
  removeAttribute: (n: string) => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  querySelector: () => null;
  focus: () => void;
  animate: () => { cancel: () => void };
};

function camel(name: string): string {
  return name.slice('data-'.length).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function makeNode(tagName: string): Node {
  const attrs: Record<string, string> = {};
  const node = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    hidden: false,
    title: '',
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    childNodes: [] as Node[],
    parentNode: null as Node | null,
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
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
      if (name === 'title') node.title = value;
      if (name.startsWith('data-')) node.dataset[camel(name)] = value;
    },
    getAttribute: (name: string) => (name.startsWith('data-') ? node.dataset[camel(name)] ?? null : attrs[name] ?? null),
    hasAttribute: (name: string) => (name.startsWith('data-') ? camel(name) in node.dataset : name in attrs),
    removeAttribute: (name: string) => {
      delete attrs[name];
      if (name === 'title') node.title = '';
      if (name.startsWith('data-')) delete node.dataset[camel(name)];
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    focus: () => {},
    animate: () => ({ cancel: () => {} }),
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

function withClass(node: Node, name: string, out: Node[] = []): Node[] {
  if (node.className.split(' ').includes(name)) out.push(node);
  for (const child of node.childNodes) withClass(child, name, out);
  return out;
}

// A funded, flat account on BTC, the mark at 60,000, ETH listed as a second market.
function payload(over: Record<string, unknown> = {}) {
  return {
    symbol: 'BTC',
    account: { equityUsd: 4200.5, freeUsd: 4200.5, healthPct: 1, unified: false, accountKnown: true, atRiskUsd: 0, maxLossUsd: 0 },
    markets: [
      { coin: 'BTC', markPx: 60000, szDecimals: 5, maxLeverage: 20, assetId: 0 },
      { coin: 'ETH', markPx: 3000, szDecimals: 4, maxLeverage: 20, assetId: 1 },
    ],
    positions: [],
    orders: [],
    plans: [],
    highlights: [],
    products: ['BTC-USD', 'ETH-USD'],
    fills: [],
    ...over,
  };
}

// The 25 hourly bars the day reads: the close a day ago 61,700, the high 63,500, the low 58,200.
function day() {
  return Array.from({ length: 25 }, (_, i) => ({ t: 0, o: 61000, h: i === 10 ? 63500 : 61500, l: i === 3 ? 58200 : 60500, c: i === 0 ? 61700 : 61000, v: 1 }));
}

// One live minute bar for a product, as the server's candle frame carries it.
function frame(product: string, c: number, over: Record<string, unknown> = {}) {
  return { type: 'candle', product, provider: 'hyperliquid', baseSec: 60, candle: { t: 1_700_000_000, o: c, h: c, l: c, c, v: 1 }, ...over };
}

type World = {
  host: Node;
  px: Node;
  fetches: () => number;
  emit: (type: string, payload: unknown) => void;
  frames: () => number;
  flush: () => void;
  refresh: () => Promise<void>;
  set: (d: unknown) => void;
};

async function boot(data: unknown, opts: { candles?: unknown[]; reduced?: boolean } = {}): Promise<World> {
  const host = makeNode('div');
  let current = data;
  let fetches = 0;
  const handlers: Record<string, Array<(payload: unknown) => void>> = {};
  // Animation frames are queued, never run, until the test flushes them: what is asserted
  // is how many the strip asked for and what one paint shows.
  let queued: Array<() => void> = [];
  const sandbox: Record<string, any> = {
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
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
    setTimeout: () => 1,
    clearTimeout: () => {},
    requestAnimationFrame: (fn: () => void) => {
      queued.push(fn);
      return queued.length;
    },
    PhosphorMotion: { reduced: () => opts.reduced === true },
    PhosphorEvents: {
      on: (type: string, fn: (payload: unknown) => void) => {
        (handlers[type] = handlers[type] ?? []).push(fn);
      },
      emit: () => {},
    },
    PhosphorNet: {
      readable: (e: unknown) => String(e),
      postJson: async () => ({ ok: true }),
      getJson: async (path: string) => {
        if (path.startsWith('/api/candles')) return { fresh: true, data: opts.candles ?? [], status: 200 };
        throw new Error('no such route in this harness: ' + path);
      },
    },
    PhosphorApi: {
      trade: async () => {
        fetches += 1;
        return { fresh: true, data: current };
      },
      tradeAction: async () => ({ ok: true }),
    },
    PhosphorShell: { view: () => 'trade', setPending: () => {} },
    PhosphorAgent: { mount: () => {} },
    PhosphorMarks: {
      logo: (symbol: string) => {
        const node = makeNode('span');
        node.className = 'logo';
        node.dataset.token = symbol;
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
    PhosphorSplit: { panes: () => [], setPane: () => false, paneControl: () => null },
    chartInvalidate: () => {},
  };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  for (const file of ['../../ui/core/dom.js', '../../ui/screens/trade.js']) {
    runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), sandbox, { filename: file });
  }
  sandbox.window.PhosphorTrade.boot();
  await sandbox.window.PhosphorTrade.refresh();
  // The day's candles land on the next turn.
  await new Promise((resolve) => setImmediate(resolve));
  const [px] = withClass(host, 'trade-mark-price');
  return {
    host,
    px,
    fetches: () => fetches,
    emit: (type: string, payload: unknown) => {
      for (const fn of handlers[type] ?? []) fn(payload);
    },
    frames: () => queued.length,
    flush: () => {
      const due = queued;
      queued = [];
      for (const fn of due) fn();
    },
    refresh: () => sandbox.window.PhosphorTrade.refresh(),
    set: (d: unknown) => {
      current = d;
    },
  };
}

const price = (w: World): string => textOf(w.px).join('');

test('a candle frame for the market on the strip moves the price, with no /api/trade fetch behind it', async () => {
  const w = await boot(payload());
  assert.equal(price(w), '$60,000.00', 'the mark is the figure until the tape speaks');
  const before = w.fetches();
  w.emit('candle', frame('BTC-USD', 60050));
  assert.equal(w.frames(), 1, 'one animation frame asked for');
  w.flush();
  assert.equal(price(w), '$60,050.00');
  assert.equal(w.px.dataset.tick, 'up', 'a rise ticks the digits up');
  assert.equal(w.fetches(), before, 'the tape must not cost a fetch');
});

test('a frame for another market leaves the strip alone', async () => {
  const w = await boot(payload());
  w.emit('candle', frame('ETH-USD', 3010));
  assert.equal(w.frames(), 0, 'nothing to paint');
  assert.equal(price(w), '$60,000.00');
  assert.equal(w.px.dataset.tick, undefined);
});

test('a burst of frames paints once, with the newest value, and ticks against the last figure shown', async () => {
  const w = await boot(payload());
  w.emit('candle', frame('BTC-USD', 60060));
  w.emit('candle', frame('BTC-USD', 60040));
  w.emit('candle', frame('BTC-USD', 59990));
  assert.equal(w.frames(), 1, 'three frames must fold into one paint');
  w.flush();
  assert.equal(price(w), '$59,990.00');
  assert.equal(w.px.dataset.tick, 'down', 'the tick is the newest value against the figure that was on screen');
  // The next burst paints again, once.
  w.emit('candle', frame('BTC-USD', 60000));
  assert.equal(w.frames(), 1);
  w.flush();
  assert.equal(price(w), '$60,000.00');
  assert.equal(w.px.dataset.tick, 'up');
});

test('a mark that lands after the tape has spoken does not pull the figure back; it is the title', async () => {
  const w = await boot(payload());
  w.emit('candle', frame('BTC-USD', 60050));
  w.flush();
  w.set(payload({ markets: [{ coin: 'BTC', markPx: 60010, szDecimals: 5, maxLeverage: 20, assetId: 0 }] }));
  await w.refresh();
  assert.equal(price(w), '$60,050.00', 'the mark stepped the figure back');
  assert.equal(w.px.title, 'Hyperliquid mark $60,010.00');
  assert.equal(w.px.dataset.tick, 'up', 'a refresh that changes nothing on screen is not a tick');
});

test('the day folds the live bar in: the change against the close a day ago, the high and the low', async () => {
  const w = await boot(payload(), { candles: day() });
  const [change] = withClass(w.host, 'trade-change');
  const [high] = withClass(w.host, 'trade-high');
  const [low] = withClass(w.host, 'trade-low');
  assert.equal(high.childNodes[1].textContent, '$63,500.00');
  assert.equal(low.childNodes[1].textContent, '$58,200.00');
  w.emit('candle', frame('BTC-USD', 64000, { candle: { t: 1_700_000_000, o: 63900, h: 64120, l: 58100, c: 64000, v: 3 } }));
  w.flush();
  assert.equal(price(w), '$64,000.00');
  // 64,000 against 61,700: up 2,300, which is 3.73%.
  assert.equal(change.childNodes[1].textContent, '+2,300.00 / +3.73%');
  assert.equal(change.childNodes[1].dataset.dir, 'up');
  assert.equal(high.childNodes[1].textContent, '$64,120.00', 'a live high above the day\'s must show');
  assert.equal(low.childNodes[1].textContent, '$58,100.00', 'a live low under the day\'s must show');
});

test('a market change drops the old tape: the new market reads its own mark until its tape speaks', async () => {
  const w = await boot(payload());
  w.emit('candle', frame('BTC-USD', 60050));
  w.flush();
  w.set(payload({ symbol: 'ETH' }));
  await w.refresh();
  assert.equal(price(w), '$3,000.00');
  w.emit('candle', frame('BTC-USD', 60100));
  assert.equal(w.frames(), 0, 'the old market\'s tape is nobody\'s business now');
  w.emit('candle', frame('ETH-USD', 3005));
  w.flush();
  assert.equal(price(w), '$3,005.00');
});

test('a frame from a venue the strip does not name is ignored', async () => {
  const w = await boot(payload());
  w.emit('candle', frame('BTC-USD', 60050, { provider: 'coinbase' }));
  assert.equal(w.frames(), 0);
  assert.equal(price(w), '$60,000.00');
});

test('reduced motion paints the tape without the tick', async () => {
  const w = await boot(payload(), { reduced: true });
  w.emit('candle', frame('BTC-USD', 60050));
  w.flush();
  assert.equal(price(w), '$60,050.00');
  assert.equal(w.px.dataset.tick, undefined);
});
