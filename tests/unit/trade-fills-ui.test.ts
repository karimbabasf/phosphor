// The trade rail, which is where a person reads what their bot actually did and what it is
// holding while it does it.
//
// The list read `fill.sz || fill.size || 0` and `fill.time || fill.at`. The payload carries
// neither: a Fill is { tid, coin, side, px, sizeCoin, atMs, ... } (src/trade/state.ts). So every
// fill said "Bought BTC 0" with no time beside it, whatever had been traded.
//
// The three panels beside it had the same bug and no test. Account read equity/free/health,
// Position read valueUsd/size/unrealizedPnl/liquidationPx and Rules read summary/spentUsd/
// budgetUsd. None of those names is in the payload, so a funded account with an open position
// under an armed rule rendered three empty states and a heading. Those are covered here now.
//
// Run against the REAL ui/core/dom.js and ui/screens/trade.js over a small stand-in DOM, so what
// is asserted is the text a person would read rather than the shape of the source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Node = {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  classList: { add: (c: string) => void; remove: (c: string) => void };
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
  addEventListener: () => void;
  removeEventListener: () => void;
  focus: () => void;
};

// Enough of a DOM for the keyed reconciler in ui/core/dom.js, which is what the list is built
// with: it needs insertBefore, removeChild, firstChild, nextSibling and parentNode to be real.
function makeNode(tagName: string): Node {
  const attrs: Record<string, string> = {};
  const node = {
    tagName,
    className: '',
    textContent: '',
    hidden: false,
    dataset: {} as Record<string, string>,
    // The meter fill sets a width through style. Without this the whole rail render throws
    // half way down and the panels below Account come back blank, which reads as a product
    // bug and is a hole in the stand-in.
    style: {} as Record<string, string>,
    classList: { add: () => {}, remove: () => {} },
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
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
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

// One fill of a tenth of a BTC-sized asset, priced. The shape is what buildTradePayload emits.
function payload(sizeCoin: number, szDecimals: number | null) {
  return {
    account: { equityUsd: 0, freeUsd: 0, marginUsedUsd: 0 },
    markets: [{ coin: 'BTC', markPx: 60000, szDecimals, maxLeverage: 20, assetId: 0 }],
    positions: [],
    orders: [],
    mandates: [],
    products: ['BTC-USD'],
    fills: [
      {
        tid: 't1',
        coin: 'BTC',
        side: 'buy',
        px: 60000,
        sizeCoin,
        notionalUsd: sizeCoin * 60000,
        feeUsd: 0.01,
        closedPnlUsd: null,
        atMs: Date.UTC(2026, 8, 1, 14, 30, 0),
        tSec: 0,
        liquidation: false,
        mandateId: null,
      },
    ],
  };
}

// The rail with money in it: a funded account, one open position and one armed rule. Every
// field name below is the one src/trade/state.ts emits.
function funded() {
  return {
    overlays: { position: true, liquidation: false, mandateWall: true },
    account: {
      equityUsd: 4200.5,
      freeUsd: 3100.25,
      marginUsedUsd: 1100.25,
      healthPct: 0.62,
      unified: false,
      accountKnown: true,
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
        liqReachable: true,
        liqDistancePct: 12,
        liqDistanceUsd: 3600,
      },
    ],
    orders: [],
    mandates: [
      {
        id: 'mnd_01',
        english: ['Buy up to $5,000 of BTC while it holds above 58,000.'],
        envelope: { maxNotionalUsd: 5000, maxLossUsd: 400 },
        used: { notionalUsd: 1250, lossUsd: 0 },
      },
    ],
    products: ['BTC-USD'],
    fills: [],
  };
}

function findByDataset(node: Node, key: string): Node | null {
  if (node.dataset[key] !== undefined) return node;
  for (const child of node.childNodes) {
    const hit = findByDataset(child, key);
    if (hit !== null) return hit;
  }
  return null;
}

function allWithDataset(node: Node, key: string, out: Node[] = []): Node[] {
  if (node.dataset[key] !== undefined) out.push(node);
  for (const child of node.childNodes) allWithDataset(child, key, out);
  return out;
}

async function renderPayload(data: unknown): Promise<{ host: Node; lines: string[] }> {
  const host = makeNode('div');
  const sandbox: Record<string, any> = {
    console,
    setTimeout,
    clearTimeout,
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
    setTimeout,
    clearTimeout,
    PhosphorMotion: { reduced: () => true },
    PhosphorEvents: { on: () => {} },
    PhosphorNet: { readable: (e: unknown) => String(e) },
    PhosphorApi: { trade: async () => ({ fresh: true, data }) },
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
  return { host, lines: textOf(host) };
}

async function render(sizeCoin: number, szDecimals: number | null): Promise<string[]> {
  const out = await renderPayload(payload(sizeCoin, szDecimals));
  return out.lines;
}

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
  const fill = lines.find((l) => l.startsWith('Bought BTC '));
  assert.ok(fill !== undefined, JSON.stringify(lines));
  assert.notEqual(fill, 'Bought BTC 0', 'a size rounded away to nothing');
  assert.ok(Number(fill.replace('Bought BTC ', '')) > 0);
});

test('a whole-number asset still shows a fraction rather than rounding it to nothing', async () => {
  // szDecimals 0 means the venue itself trades this in whole units, so a fraction here is
  // unusual. Printing it as 0 would still be a lie about a trade that happened.
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


// ---------- the three panels beside the list ----------

test('a funded account shows the money in it rather than the empty state', async () => {
  const { lines } = await renderPayload(funded());
  assert.ok(
    !lines.includes('No trading money yet'),
    `a funded account was told it had none: ${JSON.stringify(lines)}`,
  );
  assert.ok(lines.includes('$4,200.50'), JSON.stringify(lines));
  assert.ok(lines.includes('$3,100.25'), JSON.stringify(lines));
  assert.ok(lines.includes('62.0%'), JSON.stringify(lines));
});

test('an account the feed has not settled yet says it is waiting, not that it is empty', async () => {
  // accountKnown false means every figure above it is null on purpose. Answering that with
  // "no trading money" is the window inventing a fact the venue has not stated.
  const data = funded();
  data.account = { ...data.account, accountKnown: false, equityUsd: null, freeUsd: null, healthPct: null } as never;
  const { lines } = await renderPayload(data);
  assert.ok(lines.includes('Still reading the account'), JSON.stringify(lines));
  assert.ok(!lines.includes('No trading money yet'), JSON.stringify(lines));
});

test('an open position prints its value, its size and what it is up', async () => {
  const { lines } = await renderPayload(funded());
  assert.ok(lines.includes('Long BTC'), JSON.stringify(lines));
  assert.ok(lines.includes('$30,000.00'), `no notional: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('0.5'), `no size: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('$1,000.00'), `no profit line: ${JSON.stringify(lines)}`);
});

test('the forced close line uses the distance the server sent, at the scale it sent it', async () => {
  // liqDistancePct is already a percentage: the server sends gap * 100 / mark. Running it
  // through dom.pct would report a position 12% from liquidation as 1,200% away, which reads
  // as perfectly safe.
  const { lines } = await renderPayload(funded());
  const line = lines.find((l) => l.startsWith('Forced close at '));
  assert.ok(line !== undefined, `no forced close line: ${JSON.stringify(lines)}`);
  assert.equal(line, 'Forced close at $52,800.00, 12.0% away');
});

test('a position nothing can force closed says so instead of printing a price', async () => {
  const data = funded();
  data.positions[0] = { ...data.positions[0], liqReachable: false, liqDistancePct: null } as never;
  const { lines } = await renderPayload(data);
  assert.ok(lines.includes('Nothing can force this closed at the size it is.'), JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.startsWith('Forced close at ')), JSON.stringify(lines));
});

test('an armed rule prints the sentences it was approved as, and what it has spent', async () => {
  // A mandate is approved as words. Rendering its id instead is showing a person the hash of
  // the thing they agreed to rather than the thing.
  const { lines } = await renderPayload(funded());
  assert.ok(
    lines.includes('Buy up to $5,000 of BTC while it holds above 58,000.'),
    `the rule rendered as something other than its own sentence: ${JSON.stringify(lines)}`,
  );
  assert.ok(!lines.includes('mnd_01'), JSON.stringify(lines));
  assert.ok(lines.includes('$1,250.00 of $5,000'), JSON.stringify(lines));
});

test('the overlay chips follow the payload, because the canvas reads the payload', async () => {
  // ui/chart/trade-overlay.js reads data.overlays. These three used to write a window global
  // nothing has ever read, so a chip could sit pressed while the overlay under it was off.
  const { host } = await renderPayload(funded());
  const chips = allWithDataset(host, 'overlay');
  assert.equal(chips.length, 3);
  const state: Record<string, string | null> = {};
  for (const chip of chips) state[chip.dataset.overlay] = chip.getAttribute('aria-pressed');
  assert.equal(state.position, 'true');
  assert.equal(state.liquidation, 'false');
  assert.equal(state.mandateWall, 'true');
});

test('the toggles no longer write a global nothing reads', async () => {
  const source = readFileSync(new URL('../../ui/screens/trade.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('TRADE_OVERLAYS'));
  assert.ok(source.includes("'/api/trade'"), 'the toggle has to reach the server to reach the canvas');
});
