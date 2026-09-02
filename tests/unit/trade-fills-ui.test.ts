// The What happened list, which is where a person reads what their bot actually did.
//
// It read `fill.sz || fill.size || 0` and `fill.time || fill.at`. The payload carries neither:
// a Fill is { tid, coin, side, px, sizeCoin, atMs, ... } (src/trade/state.ts). So every fill in
// the list said "Bought BTC 0" with no time beside it, whatever had been traded.
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

async function render(sizeCoin: number, szDecimals: number | null): Promise<string[]> {
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
    PhosphorApi: { trade: async () => ({ fresh: true, data: payload(sizeCoin, szDecimals) }) },
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
  return textOf(host);
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
