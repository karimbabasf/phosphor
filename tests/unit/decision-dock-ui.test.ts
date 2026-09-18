// The decision dock's trust boundary.
//
// The dock is the one place in the window where a click moves money, and it is
// drawn from the server's pending list and from nothing else. Three properties
// keep that true and none of them is a tidiness preference:
//
//   1. Nothing reaches the DOM as markup, so a draft field carrying a tag
//      cannot draw over the card that is asking about it.
//   2. The dock builds four buttons and they are named here. A fifth is either
//      a control somebody added to a card the assistant can influence, or a
//      second way out of a decision, and both are the thing being prevented.
//   3. No key dismisses it. The overlay had an Escape handler back when it was a
//      modal; the dock is a region inside the conversation, and the only ways
//      out of a pending ask are No and Yes.
//
// The policy diff logic lives in the same file and is asserted separately in
// tests/unit/approvals-diff.test.ts, so this file only checks it still exports.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/screens/decision.js', import.meta.url), 'utf8');

type Sandbox = Record<string, any>;

/* The dock is a browser script that assigns one global. Running it against a
   stub window makes that global the test surface, the same way
   tests/unit/agent-panel-ui.test.ts reaches the conversation column. */
function load(): Sandbox {
  const sandbox: Sandbox = {
    window: {
      PhosphorDom: { on: () => {}, el: () => ({}), clear: () => {}, setHidden: () => {} },
      PhosphorNet: {},
      PhosphorApi: {},
      PhosphorState: { select: () => {}, get: () => ({}) },
    },
    document: { createElement: () => ({}), getElementById: () => null, addEventListener: () => {} },
    console,
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/decision.js' });
  return sandbox.window.PhosphorDecision;
}

test('no string reaches the DOM as markup', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'decision.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
});

test('the dock builds its buttons here and every one is named', () => {
  const labels = SOURCE.match(/'btn-label', '([^']+)'/g) ?? [];
  // Got it files an unconfirmed row without deciding anything; it is the one button that
  // neither approves, refuses, unlocks nor re-checks. A send's primary says what the click
  // starts (the Touch ID dialog that names the receiver) and, while that dialog is up, that it
  // is waiting on it; the send card itself (ui/screens/sendcard.js) builds no deciding button.
  const allowed = ['No', 'Yes', 'Unlock', 'Reconcile', 'Got it', 'Approve, then Touch ID', 'Approve', 'Waiting for Touch ID'];
  assert.ok(labels.length > 0, 'the dock builds no buttons at all, so this test is not looking at it');
  for (const raw of labels) {
    const label = raw.replace(/^.*, '/, '').replace(/'$/, '');
    assert.ok(allowed.includes(label), `the dock built a button labelled "${label}"`);
  }
  // The send primary is picked between two labels, so the literal walk above cannot see it.
  assert.ok(SOURCE.includes("'Approve, then Touch ID' : 'Approve'"), 'the send primary is not named as this test expects');
  const SENDCARD = readFileSync(new URL('../../ui/screens/sendcard.js', import.meta.url), 'utf8');
  assert.equal(/'btn-label', 'Approve|api\.approve|\/api\/approve/.test(SENDCARD), false, 'the send card builds a deciding button');
});

test('no key dismisses a decision', () => {
  // The dock is a region, not a modal. Escape closing it would be a way out of a
  // pending ask that is neither No nor Yes, and the person would not know which
  // one the server recorded.
  assert.equal(/'keydown'|"keydown"/.test(SOURCE), false, 'the dock listens for a key');
  assert.equal(/aria-modal/.test(SOURCE), false, 'the dock still calls itself a modal');
});

test('the card is drawn from the server and never from a frame', () => {
  // Every field on the card comes off the proposal the server sent. A dock that
  // read a driver frame would let the thing being approved write its own ask.
  assert.equal(/PhosphorEvents/.test(SOURCE), false, 'the dock subscribes to driver frames');
  assert.ok(SOURCE.includes("select('proposals'"), 'the dock does not read the proposals slice');
});

test('the policy diff still exports', () => {
  const decision = load();
  assert.equal(typeof decision.diffOf, 'function');
  assert.equal(typeof decision.refineDiff, 'function');
  const diff = decision.diffOf(['a: one, two.'], ['a: one, two, three.']);
  assert.equal(diff.added.length, 1);
  assert.equal(decision.refineDiff(diff).length, 1);
});

/* The three findings below are about fields the card READS, so asserting on the
   source is not enough: a card that reads the right field and renders it into
   nothing is the same blank card. These run the real ui/core/dom.js and the real
   ui/screens/decision.js over a small stand-in DOM, the way
   tests/unit/trade-fills-ui.test.ts does, and assert the text a person reads. */

type Node = Record<string, any>;

function makeNode(tagName: string): Node {
  const attrs: Record<string, string> = {};
  const node: Node = {
    tagName,
    className: '',
    textContent: '',
    hidden: false,
    type: '',
    disabled: false,
    dataset: {} as Record<string, string>,
    classList: { add: () => {}, remove: () => {} },
    childNodes: [] as Node[],
    parentNode: null as Node | null,
    get children() { return node.childNodes; },
    get firstChild() { return node.childNodes[0] ?? null; },
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
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => { delete attrs[name]; },
    listeners: {} as Record<string, Array<() => void>>,
    addEventListener(type: string, fn: () => void) {
      (node.listeners[type] ??= []).push(fn);
    },
    removeEventListener: () => {},
    focus: () => {},
  };
  return node;
}

function fire(node: Node, type: string): void {
  for (const fn of node.listeners[type] ?? []) fn();
}

/* Every leaf string under a node, which is what the card is: labels, facts,
   addresses and diff lines, each in its own element. */
function textOf(node: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.childNodes.length === 0) {
      if (n.textContent !== '') out.push(n.textContent as string);
      return;
    }
    for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return out;
}

function find(node: Node, className: string): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    if (String(n.className).split(' ').includes(className)) out.push(n);
    for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return out;
}

/* Boots the dock against a state and returns the card it drew, with the state
   it reads (mutable, for a test that moves a row on) and the render the store
   would call on a frame. `api` stands in for the routes a click takes. */
function dockFor(proposal: Record<string, any>, state: Record<string, any> = {}, api: Record<string, any> = {}): { card: Node; payload: Record<string, any>; render: () => void } {
  const dock = makeNode('div');
  const card = makeNode('div');
  const payload = Object.assign({ proposals: [proposal] }, state);
  const sandbox: Record<string, any> = {
    window: {
      PhosphorNet: { readable: (e: any) => String(e && e.message ? e.message : e) },
      PhosphorApi: Object.assign({ approve: () => Promise.resolve(), refuse: () => Promise.resolve() }, api),
      PhosphorState: { select: () => {}, get: () => payload },
      PhosphorShell: { updateField: () => {}, setPending: () => {}, refresh: () => Promise.resolve() },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    document: {
      createElement: makeNode,
      getElementById: (id: string) => (id === 'overlay' ? dock : id === 'overlay-card' ? card : null),
      addEventListener: () => {},
    },
    console,
  };
  sandbox.document.createElementNS = (_ns: string, tag: string) => makeNode(tag);
  createContext(sandbox);
  runInContext(readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8'), sandbox,
    { filename: 'ui/core/dom.js' });
  runInContext(readFileSync(new URL('../../ui/screens/checks.js', import.meta.url), 'utf8'), sandbox,
    { filename: 'ui/screens/checks.js' });
  runInContext(readFileSync(new URL('../../ui/screens/sendcard.js', import.meta.url), 'utf8'), sandbox,
    { filename: 'ui/screens/sendcard.js' });
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/decision.js' });
  sandbox.window.PhosphorDecision.boot();
  sandbox.window.PhosphorDecision.render();
  return { card, payload, render: () => sandbox.window.PhosphorDecision.render() };
}

function cardFor(proposal: Record<string, any>, state: Record<string, any> = {}): Node {
  return dockFor(proposal, state).card;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/* The swap the window showed on 2026-09-18: the rail's numbers arrive as
   `simulation.swap`, and its summary is the same figures as prose. */
function swapProposal(over: Record<string, any> = {}): Record<string, any> {
  const ADDR = '0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050';
  return Object.assign({
    id: 's1',
    kind: 'swap',
    status: 'pending',
    createdAt: '2026-09-18T17:35:00.000Z',
    draft: { kind: 'swap', venue: 'intents-native', chain: 'eth', toChain: 'sol', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, amountUsd: 2, minAmountOut: 0.0172, from: ADDR, to: ADDR, counterparty: 'intents.near', quote: null },
    simulation: {
      ok: true,
      summary: 'intents-native: 2 USDC -> 0.017783069 SOL, entirely inside intents.near\nfee $0.0071, eta ~12s, solver floor 17605238 base units, draft floor 0.0172 SOL\nexecution signs one intent with the EVM key and transfers nothing; the balance must already be inside intents.near',
      swap: { receives: '0.017783069', receivesAtLeast: '0.017605238', feeUsd: 0.0071, etaSeconds: 12 },
    },
    verdict: { outcome: 'needs_approval', reasons: ['swap of $2.00 to intents.near.', '$2.00 is above the $1.00 click threshold.'] },
  }, over);
}

// B4. 1Click mints a deposit address per quote, so it can never sit on an
// allowlist, and it is the address the funds are actually signed over to. The
// card read simulation.destinations, which no simulation has ever carried, so
// the only address on screen was the allowlisted leg. That is the shape of F2:
// an amount that was correct while the screen named the wrong destination.
test('an address the venue chose is on the card, in full, and says who chose it', () => {
  const MINTED = '0x7d4e1f0a2c9b8e6d3f5a1c7b9e0d2f4a6c8b0e1d3f5a7c9b1e3d5f7a9c1b3e5d';
  const card = cardFor({
    id: 'p1',
    kind: 'swap',
    status: 'pending',
    createdAt: '2026-09-07T10:00:00.000Z',
    draft: { kind: 'swap', chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountUsd: 500 },
    simulation: {
      ok: true,
      summary: 'leg 1 funds go to ' + MINTED + ' (chosen by 1click, not by us)',
      depositAddresses: [{ leg: 'arb->near', address: MINTED }],
    },
    verdict: { outcome: 'needs_approval', reasons: ['It is above the $100.00 you said to ask about.'] },
  });

  const text = textOf(card);
  assert.ok(text.includes(MINTED), 'the address the funds are signed over to is not on the card');
  assert.ok(text.includes('an address the swap service chose, not your wallet'),
    'the address is on the card without saying who chose it');
  // The backend writes the deposit lines into the summary for this card and says
  // so in a comment. The gate never rendered it.
  assert.ok(text.some((t) => t.includes('chosen by 1click')), 'the rail report is not rendered');
  const rows = find(card, 'destination');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].getAttribute('data-chosen'), 'venue');
});

// B2. buildPolicyDiff read draft.sentences, a field a policy_change draft has
// never carried, so the one card whose whole job is to show what a rule change
// does listed nothing and the change was approved blind.
test('a rule change lists every line it adds and every line it takes away', () => {
  const before = [
    'Refuse any single transaction above $10,000.',
    'Additional allowed destinations: oneclick:1click.chaindefuser.com, intents.near, hyperliquid-perps.',
  ];
  const after = [
    'Refuse any single transaction above $20,000.',
    'Additional allowed destinations: oneclick:1click.chaindefuser.com, hyperliquid-perps.',
  ];
  const card = cardFor({
    id: 'p2',
    kind: 'policy_change',
    status: 'pending',
    createdAt: '2026-09-07T10:00:00.000Z',
    draft: { kind: 'policy_change', patch: {}, sentence: 'Loosen the limits.' },
    simulation: { ok: true, summary: 'the agent asked for: Loosen the limits.', policyDiff: { before, after } },
    verdict: { outcome: 'needs_approval', reasons: ['Policy changes always require a human click.'] },
  });

  const diff = find(card, 'policy-diff');
  assert.equal(diff.length, 1, 'the card drew no policy diff');
  const text = textOf(diff[0]);
  // A destination taken off the allowlist is a loss, named on its own line.
  assert.ok(text.includes('- intents.near'), 'a removed destination is not shown as lost');
  assert.ok(text.some((t) => t.includes('$10,000')), 'the line being removed is not shown');
  assert.ok(text.some((t) => t.includes('$20,000')), 'the line being added is not shown');
  // The assistant's own wording is kept off this card. Its summary is
  // "the agent asked for: <sentence>", and putting that at the top of the card
  // that decides whether to trust the assistant would let it write its own ask
  // above the engine's diff, which is the disclosure here.
  const all = textOf(card);
  assert.equal(all.some((t) => t.includes('the agent asked for')), false,
    'the assistant wrote a line on the card deciding its own request');
  assert.equal(all.includes('What the venue reports'), false);
});

// The trade card: the verb in the headline, the risk facts under it, the plan in
// full below, and never a fee line that says nothing was quoted.
test('a trade reads as a sentence with its risk facts, and a change shows old and new', () => {
  const decision = load();
  const open = {
    kind: 'trade',
    op: 'open',
    plan: { id: 'pl_1', symbol: 'BTC', side: 'long', sizeUsd: 4000, leverage: 20, entry: { type: 'market', maxSlippageBps: 30 }, stop: 63000, target: 66000, expiresAt: '2026-09-12T10:00:00.000Z' },
    hash: 'abc',
    risk: { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 },
    amountUsd: 200,
    counterparty: 'hyperliquid-perps',
  };
  assert.equal(decision.headlineOf({ kind: 'trade', draft: open }), 'Open a long on BTC');
  assert.equal(decision.headlineOf({ kind: 'trade', draft: { kind: 'trade', op: 'change', id: 'pl_1', stop: 1, before: {}, after: {} } }), 'Change the stop on pl_1');
  assert.equal(decision.headlineOf({ kind: 'trade', draft: { kind: 'trade', op: 'change', id: 'pl_1', target: 1, before: {}, after: {} } }), 'Change the target on pl_1');
  assert.equal(decision.headlineOf({ kind: 'trade', draft: { kind: 'trade', op: 'change', id: 'pl_1', cancel: true, before: {}, after: {} } }), 'Cancel pl_1');
  assert.equal(decision.headlineOf({ kind: 'trade', draft: { kind: 'trade', op: 'change', id: 'pl_1', close: true, before: {}, after: {} } }), 'Close pl_1');

  const card = cardFor({
    id: 'p4',
    kind: 'trade',
    status: 'pending',
    createdAt: '2026-09-11T10:00:00.000Z',
    draft: open,
    simulation: { ok: true, summary: 'Long BTC: $4,000.00 notional at 20x, $200.00 of collateral at stake, isolated.\nWhen: now.' },
    verdict: { outcome: 'needs_approval', reasons: ['$200.00 is above the $100.00 click threshold.'] },
  });
  const text = textOf(card);
  assert.ok(text.includes('Open a long on BTC'));
  assert.ok(text.includes('Collateral at stake'));
  assert.ok(text.includes('Max loss at the stop'));
  assert.ok(text.some((t) => t.includes('$66.10')), 'the max loss is on the card');
  assert.ok(text.some((t) => t.includes('$400.00')), 'the stop slippage bound is on the card');
  assert.ok(text.includes('63000'), 'the stop');
  assert.ok(text.includes('66000'), 'the target');
  assert.ok(text.some((t) => t.includes('61570.12')), 'the liquidation');
  assert.equal(text.some((t) => t.includes('No fee was quoted')), false, 'a trade card carries no empty fee line');
  assert.ok(text.includes('The plan, in full'));

  const change = cardFor({
    id: 'p5',
    kind: 'trade',
    status: 'pending',
    createdAt: '2026-09-11T10:00:00.000Z',
    draft: {
      kind: 'trade',
      op: 'change',
      id: 'pl_1',
      stop: 62000,
      before: { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 },
      after: { marginUsd: 200, maxLossUsd: 128.6, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 },
      amountUsd: 200,
      counterparty: 'hyperliquid-perps',
    },
    simulation: { ok: true, summary: 'Stop 63000 becomes 62000.' },
    verdict: { outcome: 'needs_approval', reasons: ['wider'] },
  });
  const ctext = textOf(change);
  assert.ok(ctext.includes('Change the stop on pl_1'));
  assert.ok(ctext.some((t) => t.includes('$66.10') && t.includes('$128.60')), 'old and new max loss, side by side');
});

/* The trade card, held to the spec line by line: side, size and leverage in the headline and
   the plan, then margin, max loss, the 10% stop slippage bound, entry, stop, target,
   liquidation and expiry as facts a person can read without the summary. Every one of these
   is a label the card has to draw, so a renamed label is a red test rather than a blank row. */
test('an open trade card carries every risk fact the spec names, each under its own label', () => {
  const open = {
    kind: 'trade',
    op: 'open',
    plan: { id: 'pl_9', symbol: 'ETH', side: 'short', sizeUsd: 300, leverage: 5, entry: { type: 'limit', px: 3200 }, stop: 3300, target: 3000, expiresAt: '2026-09-12T10:00:00.000Z', when: [{ type: 'close', tf: '1h', is: 'below', at: { px: 3150 } }] },
    hash: 'abc',
    risk: { marginUsd: 60, maxLossUsd: 9.64, stopSlipUsd: 30, entryRef: 3200, liquidationPx: 3789.47, notionalUsd: 300, amountUsd: 60 },
    amountUsd: 60,
    counterparty: 'hyperliquid-perps',
  };
  const card = cardFor({
    id: 'p6',
    kind: 'trade',
    status: 'pending',
    createdAt: '2026-09-11T10:00:00.000Z',
    draft: open,
    simulation: { ok: true, summary: 'Short ETH: $300.00 notional at 5x, $60.00 of collateral at stake, isolated.\nWhen: a 1h bar closes below 3150.' },
    verdict: { outcome: 'needs_approval', reasons: ['$60.00 is above the $10.00 click threshold.'] },
  });
  const facts = find(card, 'fact').map((row) => textOf(row));
  const byLabel = Object.fromEntries(facts.map(([label, value]) => [label, value]));
  assert.equal(byLabel['Collateral at stake'], '$60.00 isolated, at 5x');
  assert.equal(byLabel['Max loss at the stop'], '$9.64 with fees');
  assert.equal(byLabel['If the stop slips 10%'], 'up to $30.00 more');
  assert.equal(byLabel['Entry'], 'limit at 3200, held by the exchange');
  assert.equal(byLabel['Stop'], '3300');
  assert.equal(byLabel['Target'], '3000');
  assert.equal(byLabel['Liquidation near'], '3789.47');
  assert.equal(byLabel['Expires'], '2026-09-12T10:00:00.000Z');
  assert.ok('Why you are being asked' in byLabel);
  assert.equal('What it costs' in byLabel, false, 'a trade card carries no fee line');
  const text = textOf(card);
  assert.ok(text.includes('Open a short on ETH'));
  assert.ok(text.includes('$60.00'), 'the governed amount is the headline figure');
  assert.ok(text.some((t) => t.includes('a 1h bar closes below 3150')), 'the conditions reach the card in English');
});

/* The three changes. A cancel says nothing is at risk after it; a close names the collateral
   at stake and the bound; an exit change shows the old and the new figure side by side, and
   the old and new price ride in the rail's own summary, which the card draws in full. */
test('a change card shows old and new, a close shows what is at stake, a cancel shows what is left', () => {
  const before = { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 };
  const base = { id: 'p7', kind: 'trade', status: 'pending', createdAt: '2026-09-11T10:00:00.000Z', verdict: { outcome: 'needs_approval', reasons: ['wider'] } };

  const exits = cardFor({
    ...base,
    draft: { kind: 'trade', op: 'change', id: 'pl_1', stop: 62000, target: 68000, before, after: { ...before, maxLossUsd: 128.6, liquidationPx: 61570.12 }, amountUsd: 200, counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, summary: 'Stop 63000 becomes 62000.\nMax loss $66.10 becomes $128.60 (wider, so the wall applies to the new figure).\nTarget 66000 becomes 68000.' },
  });
  const exitFacts = Object.fromEntries(find(exits, 'fact').map((row) => textOf(row)));
  assert.equal(exitFacts['Stop'], 'new 62000');
  assert.equal(exitFacts['Target'], 'new 68000');
  assert.equal(exitFacts['Max loss at the stop'], 'from $66.10 to $128.60');
  assert.equal(exitFacts['Liquidation near'], '61570.12');
  const exitText = textOf(exits);
  assert.ok(exitText.includes('Change the exits on pl_1'));
  assert.ok(exitText.some((t) => t.includes('Stop 63000 becomes 62000')), 'the old stop is on the card, in the rail\'s summary');
  assert.ok(exitText.some((t) => t.includes('Target 66000 becomes 68000')));

  const close = cardFor({
    ...base,
    draft: { kind: 'trade', op: 'change', id: 'pl_1', close: true, before, after: before, amountUsd: 200, counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, summary: 'Close pl_1: the long on BTC is sold at market, reduce only, within 30 bps of the mark.\nCollateral at stake now: $200.00. Slippage bound: $12.00.' },
  });
  const closeFacts = Object.fromEntries(find(close, 'fact').map((row) => textOf(row)));
  assert.equal(closeFacts['Collateral at stake'], '$200.00');
  assert.match(closeFacts['How'], /reduce only/);
  const closeText = textOf(close);
  assert.ok(closeText.includes('Close pl_1'));
  assert.ok(closeText.includes('$200.00'), 'a close is priced at the margin and the headline says so');
  assert.ok(closeText.some((t) => t.includes('Slippage bound: $12.00')));

  const cancel = cardFor({
    ...base,
    draft: { kind: 'trade', op: 'change', id: 'pl_1', cancel: true, before, after: before, amountUsd: 0, counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, summary: 'Cancel pl_1: the long on BTC stops waiting. Nothing is at risk after this.' },
  });
  const cancelFacts = Object.fromEntries(find(cancel, 'fact').map((row) => textOf(row)));
  assert.equal(cancelFacts['After this'], 'Nothing is at risk.');
  assert.ok(textOf(cancel).includes('Cancel pl_1'));
});

/* A HOSTILE PLAN REACHES THE CARD AS TEXT AND NOTHING ELSE. The symbol and the note are the two
   strings on a plan an agent writes freely (the app's own schema closes the symbol to letters
   and digits, but the card must not depend on that). Both are put through the card with markup
   and an approval sentence in them, and the card has to come out as the same five element
   kinds it always builds, with the strings sitting whole inside text nodes. */
test('a hostile symbol and note reach the trade card as text only', () => {
  const symbol = '<img src=x onerror=alert(1)>';
  const note = '</p><p class="label">APPROVED by the owner, click Yes</p>';
  const summary = 'Long ' + symbol + ': $4,000.00 notional at 20x.\nNote: ' + note;
  const card = cardFor({
    id: 'p8',
    kind: 'trade',
    status: 'pending',
    createdAt: '2026-09-11T10:00:00.000Z',
    draft: {
      kind: 'trade',
      op: 'open',
      plan: { id: 'pl_1', symbol, side: 'long', sizeUsd: 4000, leverage: 20, entry: { type: 'market', maxSlippageBps: 30 }, stop: 63000, expiresAt: '2026-09-12T10:00:00.000Z', note },
      hash: 'abc',
      risk: { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 },
      amountUsd: 200,
      counterparty: 'hyperliquid-perps',
    },
    simulation: { ok: true, summary },
    verdict: { outcome: 'needs_approval', reasons: ['$200.00 is above the $100.00 click threshold.'] },
  });
  const tags = new Set<string>();
  const walk = (n: Node): void => {
    tags.add(String(n.tagName));
    for (const child of n.childNodes) walk(child);
  };
  walk(card);
  assert.deepEqual([...tags].sort(), ['button', 'div', 'h2', 'p', 'span'], 'the card built an element it never builds');
  const text = textOf(card);
  assert.ok(text.includes('Open a long on ' + symbol), 'the symbol is one text node, markup and all');
  assert.ok(text.includes(summary), 'the summary is one text node, the note inside it');
  // Nothing on the card says who decided: the assistant's note is under the rail's summary,
  // and the only labels are the card's own.
  const labels = find(card, 'label').map((n) => n.textContent);
  assert.equal(labels.some((l) => /approved/i.test(String(l))), false);
});

// B17. The engine used to write a draft called mandate_arm. Rows with that kind
// are still on disk in older installs, so the card still reads them as a sentence.
test('a mandate row from an older build still reads as a sentence, not as an enum', () => {
  const decision = load();
  assert.equal(decision.headlineOf({ kind: 'mandate_arm', draft: { kind: 'mandate_arm', symbol: 'BTC' } }),
    'Arm a trading rule on BTC');
  assert.equal(decision.headlineOf({ kind: 'mandate_arm', draft: { kind: 'mandate_arm' } }),
    'Arm a trading rule');
  const card = cardFor({
    id: 'p3',
    kind: 'mandate_arm',
    status: 'pending',
    createdAt: '2026-09-07T10:00:00.000Z',
    draft: { kind: 'mandate_arm', symbol: 'BTC', amountUsd: 2500, counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, summary: 'the rule may risk up to $2,500.00 on BTC.' },
    verdict: { outcome: 'needs_approval', reasons: ['A trading rule always requires a human click.'] },
  });
  const text = textOf(card);
  assert.ok(text.includes('Arm a trading rule on BTC'));
  assert.equal(text.includes('mandate_arm'), false, 'the card printed a draft enum at a person');
});

// The enclave wallet's second half of a Yes. The click landed and the Touch ID
// dialog that names the move is up: the row is awaiting_touch. Both buttons go
// dead (a second Yes would be a second ask, and the backend takes a No only on
// a pending row), the Yes says what is happening, and the dialog's own sentence
// sits under it so the window and the dialog can be checked against each other.
test('awaiting_touch kills both buttons, renames Yes, and shows the dialog sentence', () => {
  const REASON = 'Phosphor: Swap 500 USDC for ETH on Arbitrum';
  const proposal = {
    id: 'p7',
    kind: 'swap',
    status: 'awaiting_touch',
    createdAt: '2026-09-14T10:00:00.000Z',
    draft: { kind: 'swap', chain: 'arb', toChain: 'arb', fromSymbol: 'USDC', toSymbol: 'ETH', amountUsd: 500 },
    simulation: { ok: true, summary: 'swap 500 USDC for ETH' },
    verdict: { outcome: 'needs_approval', reasons: ['It is above the $100.00 you said to ask about.'] },
  };
  const card = cardFor(proposal, { vault: { waiting: { id: 'approve:p7', op: 'unwrap', reason: REASON, since: 1 } } });
  const buttons = find(card, 'btn');
  assert.equal(buttons.length, 2, 'the waiting card does not carry exactly No and Yes');
  const yes = buttons.find((b) => String(b.className).includes('btn-primary'));
  const no = buttons.find((b) => String(b.className).includes('btn-ghost'));
  assert.ok(yes && no);
  assert.equal(yes.disabled, true, 'Yes still takes a click while the dialog is up');
  assert.equal(no.disabled, true, 'No still takes a click while the dialog is up');
  assert.deepEqual(textOf(yes), ['Touch ID: confirm on your Mac']);
  const text = textOf(card);
  assert.ok(text.includes('Confirm on your Mac'), 'the label still says the person is being waited on');
  assert.ok(text.includes(REASON), 'the dialog sentence is not under the button');
  assert.equal(find(card, 'touch-reason').length, 1);

  // The same row back at pending: the buttons are live again and the sentence is gone.
  const back = cardFor(Object.assign({}, proposal, { status: 'pending' }), { vault: { waiting: null } });
  const live = find(back, 'btn');
  assert.ok(live.every((b) => b.disabled === false));
  assert.equal(textOf(back).includes(REASON), false);
  assert.ok(textOf(back).includes('Yes'));
});

test('a Yes the enclave answers with awaiting_touch is not flashed as done', () => {
  // decide() reads the answer /api/approve gives back. On an enclave wallet that
  // answer is the row itself, awaiting_touch, and the card has to redraw in that
  // state rather than say Done over a decision that has not been made.
  assert.ok(/answer\.status === 'awaiting_touch'/.test(SOURCE), 'decide() does not branch on awaiting_touch');
  assert.ok(SOURCE.includes("p.status === 'awaiting_touch'"), 'awaiting_touch is not a waiting status for the dock');
});

// 2026-09-15: two deposits sat FAILED at 1Click with the input held under their handles, and
// the dock card said "we cannot read what happened to it" over a row that already carried the
// whole sentence. A card that knows less than its row is nagging, not information.
test('the unconfirmed card speaks the row\'s own sentence, names the handle, and offers Got it beside Reconcile', () => {
  const said = '1click reported FAILED and refunded 0 USDC so far; the input is held by 1Click under handle 86abbc463f08f6244071c17f4cd3471285b24179a4f029fe54a1979d2de7f806; reason not given.';
  const card = cardFor({
    id: 'c2a15f9f',
    kind: 'hl_deposit',
    status: 'needs_reconciliation',
    createdAt: '2026-09-15T19:15:23.048Z',
    draft: { kind: 'hl_deposit', symbol: 'USDC', amount: 10, amountUsd: 10 },
    simulation: { ok: true, summary: 'Fund Hyperliquid perps from the intents balance.' },
    verdict: { outcome: 'allow', reasons: ['Within every limit.'] },
    result: { ok: false, detail: said, txids: ['FgmrtfiDwgDn87qqcTsRna2h8v3W7pUz3DADjshsXonY'], evidence: { handle: '86abbc463f08f6244071c17f4cd3471285b24179a4f029fe54a1979d2de7f806', refundedAmount: '0' } },
  });
  const text = textOf(card);
  assert.ok(text.some((t) => t.includes('held by 1Click under handle')), 'the rail sentence is on the card');
  assert.ok(!text.some((t) => t.includes('cannot read what happened')), 'the stock sentence is gone when the row knows better');
  assert.ok(text.some((t) => t.startsWith('Not confirmed')), 'the label says what this is');
  const labels = find(card, 'btn-label').map((n) => textOf(n).join(''));
  assert.deepEqual(labels, ['Reconcile', 'Got it']);
});

test('a filed unconfirmed row is not drawn by the dock', () => {
  const card = cardFor({
    id: 'c2a15f9f',
    kind: 'hl_deposit',
    status: 'needs_reconciliation',
    acknowledgedAt: '2026-09-15T23:50:00.000Z',
    createdAt: '2026-09-15T19:15:23.048Z',
    draft: { kind: 'hl_deposit', symbol: 'USDC', amount: 10, amountUsd: 10 },
    simulation: { ok: true, summary: 'Fund Hyperliquid perps from the intents balance.' },
    verdict: { outcome: 'allow', reasons: ['Within every limit.'] },
    result: { ok: false, detail: 'held by 1Click', txids: ['h'], evidence: { handle: 'dep-1' } },
  });
  assert.equal(find(card, 'btn-label').length, 0, 'no card, no buttons');
});

test('a row with no sentence still gets the stock line rather than an empty banner', () => {
  const card = cardFor({
    id: 'p9',
    kind: 'hl_deposit',
    status: 'needs_reconciliation',
    createdAt: '2026-09-15T19:15:23.048Z',
    draft: { kind: 'hl_deposit', symbol: 'USDC', amount: 10, amountUsd: 10 },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
  });
  assert.ok(textOf(card).some((t) => t.includes('cannot read what happened')));
});

// The held row. A HyperCore deposit whose preflight said hold is approved with heldSince and
// nothing signed; the executor retries on its own. The dock shows it so the person who just
// clicked can see what it is waiting for: the headline, the hold line in amber, the checks
// folded, and no button, because there is nothing to decide.
test('a held deposit shows what it is waiting for and the checks, and offers nothing to press', () => {
  const card = cardFor({
    id: 'p-held',
    kind: 'hl_deposit',
    status: 'approved',
    createdAt: '2026-09-17T10:00:00.000Z',
    decidedBy: 'human',
    decidedAt: '2026-09-17T10:05:00.000Z',
    heldSince: '2026-09-17T10:05:00.000Z',
    draft: { kind: 'hl_deposit', symbol: 'USDC', amount: 10, amountUsd: 10, minCredited: 9.5, from: '0x1111111111111111111111111111111111111111', hlAccount: '0x1111111111111111111111111111111111111111', counterparty: 'intents.near' },
    simulation: { ok: true, summary: 'hypercore deposit: 10 USDC' },
    verdict: { outcome: 'needs_approval', reasons: ['above the click threshold'] },
    preflight: [{
      at: '2026-09-17T10:05:00.000Z',
      verdict: 'hold',
      holdReason: 'Waiting for Arbitrum gas to settle',
      checks: [
        { id: 'gas', label: 'Arbitrum gas', state: 'fail', value: '300,024 / 300,000', detail: 'the sweep would run out of gas', series: [145392, 300024], limit: 300000 },
        { id: 'coverage', label: 'Fee covers the payout', state: 'ok', value: '4.6x', detail: 'fine' },
        { id: 'venue', label: 'Venue answering', state: 'ok', value: '212 ms', detail: 'fine' },
        { id: 'balance', label: 'Balance', state: 'ok', value: '50 USDC', detail: 'fine' },
        { id: 'deadline', label: 'Quote still valid', state: 'ok', value: '10 min', detail: 'fine' },
      ],
    }],
  });
  const words = textOf(card);
  assert.equal(words[0], 'Holding');
  const hold = find(card, 'dock-hold')[0];
  assert.ok(hold, 'the hold line is on the card');
  assert.match(hold.textContent, /^Waiting for Arbitrum gas to settle \((\d+ min|under a minute)\)\. Nothing is signed until it clears\.$/);
  assert.equal(hold.getAttribute('data-tone'), 'warn');
  assert.equal(find(card, 'checks').length, 1, 'the checks are folded on the card');
  assert.equal(find(card, 'checks-node').length, 5);
  assert.equal(find(card, 'dock-actions').length, 0, 'no Yes, no No');
  assert.ok(!words.includes('Yes') && !words.includes('No'));
});

/* THE BUTTONS ARE ALWAYS ON SCREEN. The card is two parts: a body that scrolls
   and a foot that does not, and the foot is where the answer lives. On
   2026-09-18 a swap card ran past the dock's share of the column and Yes and No
   sat below the fold, behind a scrollbar macOS hides: a request with no visible
   way to answer it. */
test('the answer lives in the foot, under a body that scrolls', () => {
  const card = cardFor(swapProposal());
  const body = find(card, 'dock-body');
  const foot = find(card, 'dock-foot');
  assert.equal(body.length, 1, 'no body');
  assert.equal(foot.length, 1, 'no foot');
  assert.equal(card.childNodes.length, 2, 'the card holds the body and the foot and nothing beside them');
  assert.ok(find(body[0], 'title').length === 1, 'the headline is in the body');
  assert.equal(find(body[0], 'btn').length, 0, 'a button is in the scrolling body');
  assert.equal(find(foot[0], 'btn').length, 2, 'No and Yes are not both in the foot');
  assert.deepEqual(find(foot[0], 'btn-label').map((l) => l.textContent), ['No', 'Yes']);
});

/* The swap card says what the rail checked, as numbers under labels, and the
   rule that fired, not the engine's restatement of the move. It used to read
   "No fee was quoted." over a summary line naming the fee, "Through:
   intents-native", the engine's whole trail as the reason, and a full 0x
   address under "Where it goes" for money that never leaves the account. */
test('a swap card draws the rail\'s numbers as facts, the deciding rule as the reason, and says the money stays put', () => {
  const card = cardFor(swapProposal());
  const facts = Object.fromEntries(find(card, 'fact').map((row) => textOf(row)));
  assert.equal(facts['You get about'], '0.017783069 SOL');
  assert.equal(facts['At least'], '0.017605238 SOL, or it does not fill');
  assert.equal(facts['What it costs'], '$0.0071 in fees');
  assert.equal(facts['Takes about'], '12 seconds');
  assert.equal('Through' in facts, false, 'the venue enum is on the card');
  assert.equal(facts['Why you are being asked'], '$2.00 is above the $1.00 click threshold.');
  const text = textOf(card);
  assert.equal(text.some((t) => t.includes('No fee was quoted')), false);
  assert.equal(text.some((t) => t.includes('swap of $2.00 to intents.near')), false, 'the engine\'s restatement is on the card');
  assert.equal(text.includes('intents-native'), false, 'the venue id is on the card as its own text');
  // The account is on the card in full, under words that say nothing leaves it.
  assert.ok(text.includes('0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050'));
  assert.ok(text.includes('Stays in your account'));
  assert.equal(text.includes('Where it goes'), false);
  assert.ok(text.some((t) => t.includes('your NEAR Intents account, the one it spends from')));
  // The rail's own lines are still on the card, whole, behind a closed fold.
  const report = find(card, 'dock-report');
  assert.equal(report.length, 1);
  assert.equal(report[0].getAttribute('data-open'), 'false', 'the report is open on a card that already carries the numbers');
  assert.ok(textOf(report[0]).some((t) => t.includes('solver floor 17605238 base units')));
  assert.equal(find(card, 'dock-summary').length, 1);
});

/* A swap to somebody else's address, or an address the venue minted, is never
   described as staying put. */
test('only the account the swap spends from is "your account"; anything else keeps its full disclosure', () => {
  const OTHER = '0x1111111111111111111111111111111111111111';
  const elsewhere = cardFor(swapProposal({ draft: Object.assign({}, swapProposal().draft, { to: OTHER }) }));
  const text = textOf(elsewhere);
  assert.ok(text.includes('Where it goes'));
  assert.ok(text.includes(OTHER));
  assert.ok(text.includes('the destination this app chose'));
  assert.equal(text.includes('Stays in your account'), false);
});

/* A rail that hands the card no numbers still gets an honest fee row and its
   lines open, because those lines are the only disclosure there is. */
test('a card with no structured facts opens the rail\'s report and never claims no fee was quoted', () => {
  const card = cardFor({
    id: 'd1',
    kind: 'hl_deposit',
    status: 'pending',
    createdAt: '2026-09-18T17:36:00.000Z',
    draft: { kind: 'hl_deposit', amount: 10, symbol: 'USDC', amountUsd: 10, hlAccount: '0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050', counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, summary: 'Fund Hyperliquid perps from the intents balance.\n  cost      0.0388 USDC, 0.39 percent of the deposit' },
    verdict: { outcome: 'needs_approval', reasons: ['hl_deposit of $10.00 to hyperliquid-perps.', '$10.00 is above the $1.00 click threshold.'] },
  });
  const facts = Object.fromEntries(find(card, 'fact').map((row) => textOf(row)));
  assert.equal(facts['What it costs'], 'See what the venue reports, below.');
  const report = find(card, 'dock-report');
  assert.equal(report[0]?.getAttribute('data-open'), 'true');
  assert.ok(textOf(card).some((t) => t.includes('0.0388 USDC')));
});

/* A CLICK THAT DOES NOT LAND SAYS SO WHERE THE BUTTONS ARE. The error used to
   be a red line inside the scrolling part of the card, above buttons that
   were themselves below the fold. Now it is the first thing in the foot, and
   the buttons come back live under it. */
test('a Yes that fails puts the problem in the foot and hands the buttons back', async () => {
  const ui = dockFor(swapProposal(), {}, { approve: () => Promise.reject(new Error('The app is not answering. It may have stopped.')) });
  const foot = find(ui.card, 'dock-foot')[0];
  const yes = find(foot, 'btn').find((b) => String(b.className).includes('btn-primary'))!;
  const no = find(foot, 'btn').find((b) => String(b.className).includes('btn-ghost'))!;
  assert.equal(find(foot, 'dock-note').length, 0, 'a note is up before anything went wrong');
  fire(yes, 'click');
  assert.equal(yes.disabled, true, 'Yes still takes a click while the first one is in flight');
  assert.equal(no.disabled, true);
  await tick();
  await tick();
  const note = find(foot, 'dock-note');
  assert.equal(note.length, 1, 'no note in the foot');
  assert.equal(note[0].hidden, false);
  assert.equal(note[0].getAttribute('data-tone'), 'down');
  assert.deepEqual(textOf(note[0]), ['The app is not answering. It may have stopped.']);
  assert.equal(foot.firstChild, note[0], 'the note is not the first thing in the foot');
  assert.equal(yes.disabled, false, 'Yes stays dead after a click that did not land');
  assert.equal(no.disabled, false);
  assert.equal(find(find(ui.card, 'dock-body')[0], 'dock-note').length, 0, 'the error is in the scrolling body');
});

/* A TOUCH ID DIALOG THAT CLOSES WITHOUT AN ANSWER puts the row back to pending
   and writes nothing on it. The person who reached for the sensor came back
   to a card that looked as if nothing had happened. The dock remembers the row
   it drew waiting on the sensor and says so on that row's next pending card. */
test('a row back from Touch ID with no answer says so, over live buttons, until the next click', async () => {
  const waiting = swapProposal({ status: 'awaiting_touch' });
  const ui = dockFor(waiting, { vault: { waiting: { id: 'approve:s1', op: 'unwrap', reason: 'Phosphor: Swap 2 USDC for SOL', since: 1 } } });
  assert.equal(find(ui.card, 'dock-note').length, 0);
  // The next frame: the same row, pending again, the dialog gone.
  ui.payload.proposals = [swapProposal()];
  ui.payload.vault = { waiting: null };
  ui.render();
  const foot = find(ui.card, 'dock-foot')[0];
  const note = find(foot, 'dock-note');
  assert.equal(note.length, 1, 'the card came back blank');
  assert.equal(note[0].getAttribute('data-tone'), 'warn');
  assert.deepEqual(textOf(note[0]), ['Touch ID closed without an answer. Nothing moved. Yes asks again.']);
  const buttons = find(foot, 'btn');
  assert.ok(buttons.every((b) => b.disabled === false), 'the buttons are dead on a row that is pending');
  // A heartbeat that changes nothing keeps the note; the next click clears it.
  ui.render();
  assert.equal(find(ui.card, 'dock-note').length, 1);
  const yes = buttons.find((b) => String(b.className).includes('btn-primary'))!;
  fire(yes, 'click');
  assert.equal(find(foot, 'dock-note')[0].hidden, true, 'the note outlived the click');
  await tick();
  await tick();
});

/* A row that was never on the sensor gets no such note. */
test('a plain pending row carries no Touch ID note', () => {
  const ui = dockFor(swapProposal());
  ui.render();
  assert.equal(find(ui.card, 'dock-note').length, 0);
});

/* The lock banner sits under the amount, where it is read first, and the
   queue line sits in the foot with the buttons. */
test('the lock banner is at the top of the body and the queue line is in the foot', () => {
  const locked = cardFor(swapProposal({ status: 'pending_unlock' }));
  const body = find(locked, 'dock-body')[0];
  const banner = find(body, 'banner')[0];
  assert.ok(banner, 'no lock banner');
  const kids = body.childNodes;
  const amountAt = kids.findIndex((n: Node) => String(n.className).includes('headline'));
  assert.equal(kids.indexOf(banner), amountAt + 1, 'the banner is not right under the amount');
  assert.deepEqual(find(find(locked, 'dock-foot')[0], 'btn-label').map((l) => l.textContent), ['No', 'Unlock']);

  const ui = dockFor(swapProposal(), { proposals: [swapProposal(), swapProposal({ id: 's0', createdAt: '2026-09-18T17:00:00.000Z' })] });
  const foot = find(ui.card, 'dock-foot')[0];
  assert.deepEqual(find(foot, 'dock-queue').map((q) => q.textContent), ['One more request after this one.']);
});

test('the dock never claims a click is done; it says approved and lets the receipt say the rest', () => {
  assert.equal(/'Done\.'/.test(SOURCE), false, 'a Yes is flashed as Done. before the rail has run');
  assert.ok(SOURCE.includes("'Approving', 'Approved.'"));
});

