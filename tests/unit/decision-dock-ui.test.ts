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
