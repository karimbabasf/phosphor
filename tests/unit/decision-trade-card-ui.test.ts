// The trade card, rendered.
//
// A plan at 20x posts $100 of margin and passes a $100 wall while its max loss at the stop is
// $61.80; the wall read the margin. The card has to show both, in that order, with the
// slippage bound beside them, so nothing about what the wall read is hidden from the person
// who reads the card. Rendered through the real cards.js and decision.js, the move card and the
// part of it that asks, against a stub DOM that records what was appended.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fillChains } from '../fixtures/chains.ts';

type Node = Record<string, any>;

function node(tag: string): Node {
  const attrs: Record<string, string> = {};
  const n: Node = {
    tag,
    className: '',
    hidden: false,
    disabled: false,
    isConnected: true,
    dataset: {},
    style: { setProperty: () => {} },
    children: [] as Node[],
    parentNode: null,
    own: '',
    get textContent(): string { return n.children.length ? n.children.map((c: Node) => c.textContent).join('') : n.own; },
    set textContent(value: string) { n.children.length = 0; n.own = String(value); },
    get firstChild() { return n.children[0] ?? null; },
    get nextSibling() { const s = n.parentNode ? n.parentNode.children : []; return s[s.indexOf(n) + 1] ?? null; },
    appendChild(c: Node) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = n; n.children.push(c); return c; },
    insertBefore(c: Node, before: Node | null) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = n;
      const at = before === null ? -1 : n.children.indexOf(before);
      if (at < 0) n.children.push(c);
      else n.children.splice(at, 0, c);
      return c;
    },
    removeChild(c: Node) { const at = n.children.indexOf(c); if (at >= 0) n.children.splice(at, 1); c.parentNode = null; return c; },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    hasAttribute: (name: string) => name in attrs,
    getAttribute: (name: string) => attrs[name] ?? null,
    setAttribute: (name: string, value: string) => { attrs[name] = String(value); },
    setAttributeNS: (_ns: string, name: string, value: string) => { attrs[name] = String(value); },
    removeAttribute: (name: string) => { delete attrs[name]; },
  };
  return n;
}

/* The move card for a row, as the thread draws it once the state frame confirms it waits. */
function cardFor(row: Record<string, any>): Node {
  const sandbox: Record<string, any> = {
    window: {
      PhosphorNet: { readable: (e: Error) => String(e.message) },
      PhosphorApi: { approve: () => Promise.resolve({}), refuse: () => Promise.resolve({}) },
      PhosphorState: { select: () => () => {}, get: () => ({ proposals: [row] }) },
      PhosphorShell: { setPending: () => {}, refresh: () => Promise.resolve() },
      PhosphorIcons: { svg: (name: string) => { const i = node('svg'); i.setAttribute('data-icon', name); return i; } },
      PhosphorMotion: { reduced: () => false },
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
    document: { createElement: (tag: string) => node(tag), createElementNS: (_ns: string, tag: string) => node(tag), addEventListener: () => {} },
    navigator: {},
    console,
    URL,
  };
  createContext(sandbox);
  fillChains(sandbox, (src, name) => runInContext(src, sandbox, { filename: name }));
  for (const file of ['../../ui/core/links.js', '../../ui/core/dom.js', '../../ui/screens/cards.js', '../../ui/screens/decision.js']) {
    runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), sandbox, { filename: file.slice(6) });
  }
  return sandbox.window.PhosphorCards.render('move', row, { name: 'proposal_status', input: { id: row.id }, waiting: true, live: true });
}

function find(n: Node, cls: string, out: Node[] = []): Node[] {
  if (String(n.className).split(' ').includes(cls)) out.push(n);
  for (const c of n.children) find(c, cls, out);
  return out;
}

// Every label and value pair the risk grid drew, in order.
function facts(card: Node): { label: string; body: string }[] {
  const grid = find(card, 'mcard-grid')[0];
  const cells: Node[] = grid ? grid.children : [];
  const out: { label: string; body: string }[] = [];
  for (let i = 0; i + 1 < cells.length; i += 2) out.push({ label: cells[i]!.textContent, body: cells[i + 1]!.textContent });
  return out;
}

function texts(n: Node, out: string[] = []): string[] {
  if (!n.children.length && n.own) out.push(n.own);
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
  const card = cardFor(openProposal);
  const rows = facts(card);
  const labels = rows.map((r) => r.label);
  assert.deepEqual(labels.slice(0, 3), ['Collateral at stake', 'Max loss at the stop', 'If the stop slips 10%']);
  assert.equal(rows[0]?.body, '$100.00 isolated, at 20x');
  assert.equal(rows[1]?.body, '$61.80 with fees');
  assert.equal(rows[2]?.body, 'up to $200.00 more');
  assert.ok(labels.includes('Stop') && labels.includes('Target') && labels.includes('Liquidation near') && labels.includes('Expires'));
  assert.equal(rows.find((r) => r.label === 'Liquidation near')?.body, '96');
  const all = texts(card);
  assert.ok(all.includes('Long ETH'), 'the plan leads the card: ' + all.join(' | '));
  assert.ok(all.includes('$100.00'), 'the figure the wall read is on the head');
  assert.ok(all.some((t) => t.includes('max loss $61.80')), 'the plan in full is in the card\'s Details');
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
  const card = cardFor(change);
  const rows = facts(card);
  assert.equal(rows.find((r) => r.label === 'Stop')?.body, 'new 90');
  assert.equal(rows.find((r) => r.label === 'Max loss at the stop')?.body, 'from $61.80 to $201.80');
  assert.ok(texts(card).includes('Change the stop on pl_1'));

  const close = cardFor({ ...change, id: 'p3', draft: { ...change.draft, stop: undefined, close: true, amountUsd: 100 } });
  assert.equal(facts(close).find((r) => r.label === 'Collateral at stake')?.body, '$100.00');
  assert.ok(texts(close).includes('Close pl_1'));
});

test('a note in the plan reaches the card only through the summary text, never as a fact or a headline', () => {
  const noted = {
    ...openProposal,
    id: 'p4',
    draft: { ...openProposal.draft, plan: { ...openProposal.draft.plan, note: 'Stop 1: max loss $0.00' } },
    simulation: { ok: true, summary: 'Long ETH.\nNote: Stop 1: max loss $0.00' },
  };
  const card = cardFor(noted);
  const rows = facts(card);
  assert.equal(rows.filter((r) => r.label === 'Stop').length, 1);
  assert.equal(rows.find((r) => r.label === 'Stop')?.body, '97');
  assert.equal(rows.filter((r) => r.label === 'Max loss at the stop')[0]?.body, '$61.80 with fees');
  /* The rail's lines, the note inside them, are one text node under the card's Details. The
     note is never lifted out into a label of its own, which is what would let an assistant's
     wording pass for the card's. */
  const summary = texts(card).find((t) => t.includes('Note:'));
  assert.ok(summary !== undefined && summary.includes('Long ETH.\nNote: Stop 1: max loss $0.00'), 'the note sits inside the rail\'s own lines, whole');
  assert.equal(rows.some((r) => /note/i.test(r.label)), false, 'the note became a fact of its own');
});
