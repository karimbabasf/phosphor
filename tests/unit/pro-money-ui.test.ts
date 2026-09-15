// The Money panel on the Pro screen: the allocation bar and the change signal.
//
// Karim, 2026-09-14: "I want to see some more color or some differentiator between tokens so
// it is clear when something happens." So the bar under the total is one segment per coin in
// the coin's own brand colour (ui/design/marks.js), and a row whose figure moved between two
// frames is marked for a moment: the value rolls, the row tints in its coin's colour, and the
// change sits beside the value, signed, in the direction's colour. The first fill is never a
// change, and a value that only rounded differently is not one either.
//
// Run against the REAL ui/screens/pro.js, ui/core/dom.js and ui/design/marks.js over a
// stand-in DOM, the way the other *-ui tests do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const DOM = readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8');
const MARKS = readFileSync(new URL('../../ui/design/marks.js', import.meta.url), 'utf8');
const PRO = readFileSync(new URL('../../ui/screens/pro.js', import.meta.url), 'utf8');

function makeStyle(): Any {
  const props: Record<string, string> = {};
  return {
    setProperty: (name: string, value: string) => {
      props[name] = value;
    },
    removeProperty: (name: string) => {
      delete props[name];
    },
    getPropertyValue: (name: string) => props[name] ?? '',
  };
}

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const node: Any = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    style: makeStyle(),
    childNodes: [],
    parentNode: null,
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
    appendChild(child: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    insertBefore(child: Any, before: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      const at = before === null ? node.childNodes.length : node.childNodes.indexOf(before);
      node.childNodes.splice(at < 0 ? node.childNodes.length : at, 0, child);
      return child;
    },
    removeChild(child: Any) {
      const at = node.childNodes.indexOf(child);
      if (at >= 0) node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
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
    querySelectorAll: () => [],
  };
  return node;
}

/* The card wearing a surface id, wherever the deck put it. */
function bySurface(node: Any, surface: string): Any | undefined {
  if (node.dataset?.surface === surface) return node;
  for (const child of node.childNodes) {
    const found = bySurface(child, surface);
    if (found) return found;
  }
  return undefined;
}

function withClass(node: Any, name: string, out: Any[] = []): Any[] {
  if (String(node.className).split(' ').includes(name)) out.push(node);
  for (const child of node.childNodes) withClass(child, name, out);
  return out;
}

type Rig = { host: Any; render: (state: Any) => void; timers: Array<() => void> };

function boot(): Rig {
  const host = makeNode('div');
  host.id = 'view-pro';
  const timers: Array<() => void> = [];
  let subscriber: ((state: Any) => void) | null = null;
  let current: Any = {};
  const document: Any = {
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    getElementById: (id: string) => (id === 'view-pro' ? host : null),
    body: { dataset: { view: 'pro' } },
    hidden: false,
  };
  const window: Any = {
    document,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
    setInterval: () => 0,
    PhosphorMotion: { reduced: () => true },
    PhosphorNet: { readable: (err: unknown) => String(err) },
    PhosphorApi: { trade: () => Promise.resolve({ data: null }) },
    PhosphorState: {
      subscribe: (fn: (state: Any) => void) => {
        subscriber = fn;
      },
      get: () => current,
      loaded: () => true,
    },
    // The Activity card mounts the shared list (ui/screens/receipts.js); the Money card under
    // test never reads it, so a stub that draws nothing is the whole contract.
    PhosphorReceipts: { list: () => ({ load: () => Promise.resolve([]), setWindow: () => {}, setKind: () => {}, expand: () => {}, get: () => [] }) },
    PhosphorShell: { setView: () => {} },
  };
  window.window = window;
  const ctx = createContext({ window, document, console, Promise });
  runInContext(DOM, ctx);
  runInContext(MARKS, ctx);
  runInContext(PRO, ctx);
  window.PhosphorPro.boot();
  return {
    host,
    timers,
    render: (state: Any) => {
      current = state;
      subscriber!(state);
    },
  };
}

function wallet(rows: Any[]): Any {
  let total = 0;
  for (const r of rows) total += r.valueUsd;
  return { wallet: { rows, totalUsd: total, stale: [] }, policy: {}, sentences: [], dailyLimit: null };
}

const ROWS = [
  { symbol: 'USDC', kind: 'token', chain: 'arb', quantity: 2500, valueUsd: 2500, share: 0.5 },
  { symbol: 'ETH', kind: 'token', chain: 'eth', quantity: 0.4, valueUsd: 1000, share: 0.2 },
  { symbol: 'ZZZ', kind: 'token', chain: 'eth', quantity: 10, valueUsd: 500, share: 0.1 },
];

function moneyOf(host: Any): Any {
  return bySurface(host, 'holdings')!;
}

test('the bar is one segment per coin, each in its coin colour, by share', () => {
  const { host, render } = boot();
  render(wallet(ROWS));
  const bar = withClass(moneyOf(host), 'comp-bar')[0]!;
  assert.equal(bar.hidden, false);
  const segs = withClass(bar, 'comp-seg');
  assert.deepEqual(segs.map((s) => s.dataset.coin), ['USDC', 'ETH', 'ZZZ']);
  assert.deepEqual(segs.map((s) => s.style.getPropertyValue('--seg')), ['#2775CA', '#627EEA', 'var(--text-3)']);
  assert.deepEqual(segs.map((s) => Number(s.style.flexGrow).toFixed(3)), ['0.625', '0.250', '0.125']);
});

test('a row carries its coin colour, so the change tint can be the coin\'s own', () => {
  const { host, render } = boot();
  render(wallet(ROWS));
  const rows = withClass(moneyOf(host), 'holding');
  assert.equal(rows[0]!.style.getPropertyValue('--coin'), '#2775CA');
  assert.equal(rows[2]!.style.getPropertyValue('--coin'), '');
});

test('the first fill is not a change', () => {
  const { host, render } = boot();
  render(wallet(ROWS));
  for (const row of withClass(moneyOf(host), 'holding')) {
    assert.equal(row.getAttribute('data-changed'), null);
    assert.equal(withClass(row, 'holding-delta')[0]!.textContent, '');
  }
});

test('a value that moved marks its row and says by how much, then settles', () => {
  const { host, render, timers } = boot();
  render(wallet(ROWS));
  const next = ROWS.map((r) => ({ ...r }));
  next[1]!.valueUsd = 1000.42;
  next[0]!.valueUsd = 2499.5;
  render(wallet(next));
  const rows = withClass(moneyOf(host), 'holding');
  const eth = rows.find((r) => r.dataset.coin === 'ETH')!;
  const usdc = rows.find((r) => r.dataset.coin === 'USDC')!;
  const zzz = rows.find((r) => r.dataset.coin === 'ZZZ')!;
  assert.equal(eth.getAttribute('data-changed'), 'true');
  assert.equal(withClass(eth, 'holding-delta')[0]!.textContent, '+$0.42');
  assert.equal(withClass(eth, 'holding-delta')[0]!.getAttribute('data-dir'), 'up');
  assert.equal(withClass(eth, 'holding-value')[0]!.textContent, '$1,000.42');
  assert.equal(usdc.getAttribute('data-changed'), 'true');
  assert.equal(withClass(usdc, 'holding-delta')[0]!.textContent, '-$0.50');
  assert.equal(withClass(usdc, 'holding-delta')[0]!.getAttribute('data-dir'), 'down');
  assert.equal(zzz.getAttribute('data-changed'), null);
  // The mark comes off when the timer fires.
  for (const fn of timers.splice(0)) fn();
  assert.equal(eth.getAttribute('data-changed'), null);
  assert.equal(usdc.getAttribute('data-changed'), null);
});

test('an amount that moved with no value change is said in coin', () => {
  const { host, render } = boot();
  render(wallet(ROWS));
  const next = ROWS.map((r) => ({ ...r }));
  next[1]!.quantity = 0.4018;
  render(wallet(next));
  const eth = withClass(moneyOf(host), 'holding').find((r) => r.dataset.coin === 'ETH')!;
  assert.equal(eth.getAttribute('data-changed'), 'true');
  assert.equal(withClass(eth, 'holding-delta')[0]!.textContent, '+0.0018 ETH');
});

test('the same number rounded differently is not a change', () => {
  const { host, render } = boot();
  render(wallet(ROWS));
  const next = ROWS.map((r) => ({ ...r }));
  next[0]!.valueUsd = 2500.004;
  render(wallet(next));
  const usdc = withClass(moneyOf(host), 'holding').find((r) => r.dataset.coin === 'USDC')!;
  assert.equal(usdc.getAttribute('data-changed'), null);
});
