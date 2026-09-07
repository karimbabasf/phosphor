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

test('the dock builds four buttons and they are named', () => {
  const labels = SOURCE.match(/'btn-label', '([^']+)'/g) ?? [];
  const allowed = ['No', 'Yes', 'Unlock', 'Reconcile'];
  assert.ok(labels.length > 0, 'the dock builds no buttons at all, so this test is not looking at it');
  for (const raw of labels) {
    const label = raw.replace(/^.*, '/, '').replace(/'$/, '');
    assert.ok(allowed.includes(label), `the dock built a button labelled "${label}"`);
  }
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
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
  };
  return node;
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

/* Boots the dock against a state and returns the card it drew. */
function cardFor(proposal: Record<string, any>, state: Record<string, any> = {}): Node {
  const dock = makeNode('div');
  const card = makeNode('div');
  const payload = Object.assign({ proposals: [proposal] }, state);
  const sandbox: Record<string, any> = {
    window: {
      PhosphorNet: { readable: (e: any) => String(e) },
      PhosphorApi: { approve: () => Promise.resolve(), refuse: () => Promise.resolve() },
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
  createContext(sandbox);
  runInContext(readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8'), sandbox,
    { filename: 'ui/core/dom.js' });
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/decision.js' });
  sandbox.window.PhosphorDecision.boot();
  sandbox.window.PhosphorDecision.render();
  return card;
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
  // The assistant's own sentence is on the card, labelled as the assistant's,
  // never as the venue's report.
  assert.ok(textOf(card).includes('What the assistant asked for'));
});

// B17. The engine writes a draft called mandate_arm. Nothing has ever authored
// one called mandate, so the card headlined an armed trading rule with the enum.
test('arming a trading rule reads as a sentence, not as an enum', () => {
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
