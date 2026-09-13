// The trade card, rendered.
//
// A plan at 20x posts $100 of margin and passes a $100 wall while its max loss at the stop is
// $61.80; the wall read the margin. The card has to show both, in that order, with the
// slippage bound beside them, so nothing about what the wall read is hidden from the person
// who reads the card. Rendered through the real decision.js against a stub DOM that records
// what was appended, the way decision-dock-ui.test.ts reaches the same script.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/screens/decision.js', import.meta.url), 'utf8');

type Node = {
  tag: string;
  className: string;
  textContent: string;
  hidden: boolean;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  children: Node[];
  appendChild(c: Node): Node;
  insertBefore(c: Node, before: Node | null): Node;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  firstChild: Node | null;
  removeChild(c: Node): void;
};

function node(tag: string): Node {
  const n: Node = {
    tag,
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    attrs: {},
    children: [],
    appendChild(c) {
      n.children.push(c);
      return c;
    },
    insertBefore(c, before) {
      const at = before === null ? -1 : n.children.indexOf(before);
      if (at < 0) n.children.push(c);
      else n.children.splice(at, 0, c);
      return c;
    },
    hasAttribute: (name) => name in n.attrs,
    getAttribute: (name) => n.attrs[name] ?? null,
    setAttribute(name, value) {
      n.attrs[name] = value;
    },
    removeAttribute(name) {
      delete n.attrs[name];
    },
    get firstChild() {
      return n.children[0] ?? null;
    },
    removeChild(c) {
      n.children = n.children.filter((x) => x !== c);
    },
  };
  return n;
}

function load(proposals: unknown[]): { card: Node; render: () => void } {
  const dock = node('div');
  const card = node('div');
  const dom = {
    el(tag: string, className?: string, text?: unknown) {
      const n = node(tag);
      if (className) n.className = className;
      if (text !== undefined && text !== null) n.textContent = String(text);
      return n;
    },
    setText(n: Node, text: unknown) {
      n.textContent = text === undefined || text === null ? '' : String(text);
    },
    setAttr(n: Node, name: string, value: unknown) {
      if (value === null || value === false || value === undefined) delete n.attrs[name];
      else n.attrs[name] = value === true ? '' : String(value);
    },
    setHidden(n: Node, hidden: boolean) {
      n.hidden = !!hidden;
    },
    clear(n: Node) {
      n.children = [];
    },
    on: () => {},
    usd: (v: number, d?: number) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 }),
    qty: (v: number) => String(v),
    pct: (v: number) => `${(v * 100).toFixed(1)}%`,
  };
  let listener: (() => void) | null = null;
  const sandbox: Record<string, unknown> = {
    window: {
      PhosphorDom: dom,
      PhosphorNet: {},
      PhosphorApi: {},
      PhosphorState: {
        select: (_name: string, fn: () => void) => {
          listener = fn;
        },
        get: () => ({ proposals, policy: { outbound: { humanClickAboveUsd: 100 } } }),
      },
      PhosphorShell: { updateField: () => {} },
    },
    document: {
      createElement: (tag: string) => node(tag),
      getElementById: (id: string) => (id === 'overlay' ? dock : id === 'overlay-card' ? card : null),
      addEventListener: () => {},
    },
    console,
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/decision.js' });
  const decision = (sandbox.window as { PhosphorDecision: { boot: () => void; render: () => void } }).PhosphorDecision;
  decision.boot();
  return {
    card,
    render: () => {
      if (listener !== null) listener();
      else decision.render();
    },
  };
}

// Every label and body pair the card drew, in order, flattened.
function facts(n: Node, out: { label: string; body: string }[] = []): { label: string; body: string }[] {
  if (n.className === 'fact') {
    out.push({ label: n.children[0]?.textContent ?? '', body: n.children[1]?.textContent ?? '' });
    return out;
  }
  for (const c of n.children) facts(c, out);
  return out;
}

function texts(n: Node, out: string[] = []): string[] {
  if (n.textContent) out.push(n.textContent);
  for (const c of n.children) texts(c, out);
  return out;
}

const openProposal = {
  id: 'p1',
  kind: 'trade',
  status: 'pending',
  createdAt: '2026-09-11T00:00:00.000Z',
  draft: {
    kind: 'trade',
    op: 'open',
    plan: { id: 'pl_1', symbol: 'ETH', side: 'long', sizeUsd: 2000, leverage: 20, entry: { type: 'market', maxSlippageBps: 30 }, stop: 97, target: 110, expiresAt: '2026-09-12T00:00:00.000Z' },
    hash: 'h',
    risk: { marginUsd: 100, maxLossUsd: 61.8, stopSlipUsd: 200, entryRef: 100, liquidationPx: 96.0025, notionalUsd: 2000, amountUsd: 100 },
    amountUsd: 100,
    counterparty: 'hyperliquid-perps',
  },
  simulation: { ok: true, summary: 'Long ETH: $2,000.00 notional at 20x, $100.00 of collateral at stake, isolated.\nStop 97: max loss $61.80 with fees.' },
  verdict: { outcome: 'needs_approval', reasons: ['$100.00 is above the $99.00 click threshold.'] },
};

test('an open card shows the margin the wall read and the max loss beside it, with the slippage bound', () => {
  const ui = load([openProposal]);
  ui.render();
  const rows = facts(ui.card);
  const labels = rows.map((r) => r.label);
  assert.deepEqual(labels.slice(0, 3), ['Collateral at stake', 'Max loss at the stop', 'If the stop slips 10%']);
  assert.equal(rows[0]?.body, '$100.00 isolated, at 20x');
  assert.equal(rows[1]?.body, '$61.80 with fees');
  assert.equal(rows[2]?.body, 'up to $200.00 more');
  assert.ok(labels.includes('Stop') && labels.includes('Target') && labels.includes('Liquidation near') && labels.includes('Expires'));
  assert.equal(rows.find((r) => r.label === 'Liquidation near')?.body, '96');
  const all = texts(ui.card);
  assert.ok(all.includes('Open a long on ETH'), 'the headline is the verb');
  assert.ok(all.includes('$100.00'), 'the figure the wall read is the big number');
  assert.ok(all.some((t) => t.includes('max loss $61.80')), 'the plan in full is on the card');
  assert.ok(!all.some((t) => /No fee was quoted/.test(t)));
});

test('a change card shows the old max loss and the new one, and a close shows the margin at stake', () => {
  const change = {
    ...openProposal,
    id: 'p2',
    draft: {
      kind: 'trade',
      op: 'change',
      id: 'pl_1',
      stop: 90,
      before: { marginUsd: 100, maxLossUsd: 61.8, stopSlipUsd: 200, entryRef: 100, liquidationPx: 96, notionalUsd: 2000, amountUsd: 100 },
      after: { marginUsd: 100, maxLossUsd: 201.8, stopSlipUsd: 200, entryRef: 100, liquidationPx: 96, notionalUsd: 2000, amountUsd: 201.8 },
      amountUsd: 201.8,
      counterparty: 'hyperliquid-perps',
    },
    simulation: { ok: true, summary: 'Stop 97 becomes 90.' },
  };
  const ui = load([change]);
  ui.render();
  const rows = facts(ui.card);
  assert.equal(rows.find((r) => r.label === 'Stop')?.body, 'new 90');
  assert.equal(rows.find((r) => r.label === 'Max loss at the stop')?.body, 'from $61.80 to $201.80');
  assert.ok(texts(ui.card).includes('Change the stop on pl_1'));

  const close = { ...change, id: 'p3', draft: { ...change.draft, stop: undefined, close: true, amountUsd: 100 } };
  const closeUi = load([close]);
  closeUi.render();
  const closeRows = facts(closeUi.card);
  assert.equal(closeRows.find((r) => r.label === 'Collateral at stake')?.body, '$100.00');
  assert.ok(texts(closeUi.card).includes('Close pl_1'));
});

test('a note in the plan reaches the card only through the summary text, never as a fact or a headline', () => {
  const noted = {
    ...openProposal,
    id: 'p4',
    draft: { ...openProposal.draft, plan: { ...openProposal.draft.plan, note: 'Stop 1: max loss $0.00' } },
    simulation: { ok: true, summary: 'Long ETH.\nNote: Stop 1: max loss $0.00' },
  };
  const ui = load([noted]);
  ui.render();
  const rows = facts(ui.card);
  assert.equal(rows.filter((r) => r.label === 'Stop').length, 1);
  assert.equal(rows.find((r) => r.label === 'Stop')?.body, '97');
  assert.equal(rows.filter((r) => r.label === 'Max loss at the stop')[0]?.body, '$61.80 with fees');
  const summary = texts(ui.card).find((t) => t.includes('Note:'));
  assert.ok(summary !== undefined && summary.startsWith('Long ETH.'), 'the note sits inside the plan-in-full block under its own label');
});
