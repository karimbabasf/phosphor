// The decision on the move card, and its trust boundary.
//
// There is no dock any more. A move that needs the person is one card in the thread
// (ui/screens/cards.js), and ui/screens/decision.js draws the part of it that decides: the
// figures a rule change or a trade is judged on, the lock and Touch ID lines, and Cancel and
// Approve. Four properties keep it safe and none of them is a tidiness preference:
//
//   1. Nothing reaches the DOM as markup, so a draft field carrying a tag cannot draw over the
//      card that is asking about it.
//   2. The deciding buttons are built in decision.js and they are named here. A new one is
//      either a control somebody added to a card the assistant can influence, or a second way
//      out of a decision, and both are the thing being prevented.
//   3. The buttons are the server's. A card offers them only on the state frame's own row and
//      only while that frame lists it as waiting: a reply that came through the conversation
//      can draw the move and never the question.
//   4. No key dismisses a decision. The only ways out of a pending ask are Cancel and Approve.
//
// These run the real ui/core/dom.js, ui/screens/cards.js and ui/screens/decision.js over a
// small stand-in DOM and assert the text a person reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fillChains } from '../fixtures/chains.ts';

const SOURCE = readFileSync(new URL('../../ui/screens/decision.js', import.meta.url), 'utf8');
const CARDS = readFileSync(new URL('../../ui/screens/cards.js', import.meta.url), 'utf8');

type Node = Record<string, any>;

function makeNode(tagName: string): Node {
  const attrs: Record<string, string> = {};
  const node: Node = {
    tagName,
    className: '',
    hidden: false,
    type: '',
    disabled: false,
    isConnected: true,
    dataset: {} as Record<string, string>,
    style: { setProperty: () => {} },
    childNodes: [] as Node[],
    parentNode: null as Node | null,
    ownText: '',
    get textContent(): string {
      return node.childNodes.length ? node.childNodes.map((c: Node) => c.textContent).join('') : node.ownText;
    },
    set textContent(value: string) {
      node.childNodes.length = 0;
      node.ownText = String(value);
    },
    get children() { return node.childNodes; },
    get firstChild() { return node.childNodes[0] ?? null; },
    get lastElementChild() { return node.childNodes[node.childNodes.length - 1] ?? null; },
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
    setAttribute: (name: string, value: string) => { attrs[name] = String(value); if (name === 'class') node.className = String(value); },
    setAttributeNS: (_ns: string, name: string, value: string) => { attrs[name] = String(value); },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => { delete attrs[name]; },
    listeners: {} as Record<string, Array<(event?: unknown) => void>>,
    addEventListener(type: string, fn: (event?: unknown) => void) {
      (node.listeners[type] ??= []).push(fn);
    },
    removeEventListener: () => {},
    focus: () => {},
  };
  return node;
}

function fire(node: Node, type: string, event: Record<string, unknown> = {}): void {
  for (const fn of node.listeners[type] ?? []) fn({ preventDefault: () => {}, stopPropagation: () => {}, ...event });
}

/* Every leaf string under a node that is on screen: a hidden node and what it holds is not
   something a person reads. */
function textOf(node: Node, all = false): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (!all && n.hidden === true) return;
    if (n.childNodes.length === 0) {
      if (n.ownText !== '') out.push(n.ownText as string);
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

function visible(node: Node): boolean {
  for (let n: Node | null = node; n; n = n.parentNode) if (n.hidden === true) return false;
  return true;
}

function buttons(card: Node): Node[] {
  return find(card, 'btn').filter((b) => b.tagName === 'button' && visible(b) && !String(b.className).includes('tcard-copy'));
}

function labelsOf(card: Node): string[] {
  return buttons(card).map((b) => find(b, 'btn-label').map((l) => l.textContent).join(''));
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type World = { sandbox: Record<string, any>; state: Record<string, any>; timers: Array<() => void>; calls: string[]; sent: string[] };

/* The window with the card's files loaded. `api` stands in for the routes a click takes. */
function world(state: Record<string, any> = {}, api: Record<string, any> = {}): World {
  const timers: Array<() => void> = [];
  const calls: string[] = [];
  const sent: string[] = [];
  const sandbox: Record<string, any> = {
    window: {
      PhosphorNet: { readable: (e: any) => String(e && e.message ? e.message : e) },
      PhosphorApi: Object.assign({
        approve: (id: string) => { calls.push('approve:' + id); return Promise.resolve({}); },
        refuse: (id: string) => { calls.push('refuse:' + id); return Promise.resolve({}); },
      }, api),
      PhosphorState: { select: () => () => {}, get: () => state },
      PhosphorShell: { setPending: (b: Node, on: boolean) => { if (b) { b.dataset.pending = on ? 'true' : ''; b.disabled = on; } }, refresh: () => Promise.resolve() },
      PhosphorIcons: { svg: (name: string, className: string) => { const n = makeNode('svg'); n.className = 'icon ' + (className || ''); n.setAttribute('data-icon', name); return n; } },
      PhosphorMarks: { logo: (symbol: string) => { const n = makeNode('span'); n.className = 'logo'; n.setAttribute('data-token', String(symbol)); return n; } },
      PhosphorMotion: { reduced: () => false },
      PhosphorAgent: { send: (text: string) => { sent.push(text); return true; } },
      PhosphorLock: { focus: () => { calls.push('unlock'); } },
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
    document: { createElement: makeNode, createElementNS: (_ns: string, tag: string) => makeNode(tag), addEventListener: () => {} },
    navigator: {},
    console,
    URL,
  };
  createContext(sandbox);
  fillChains(sandbox, (src, name) => runInContext(src, sandbox, { filename: name }));
  for (const file of ['../../ui/core/links.js', '../../ui/core/dom.js', '../../ui/screens/checks.js', '../../ui/screens/sendcard.js']) {
    runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), sandbox, { filename: file.slice(6) });
  }
  runInContext(CARDS, sandbox, { filename: 'ui/screens/cards.js' });
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/decision.js' });
  return { sandbox, state, timers, calls, sent };
}

/* A move card for a row, as the thread draws it once the state frame has confirmed the row
   waits (`waiting` and `live`), unless the test says otherwise. */
function cardIn(w: World, row: Record<string, any>, extra: Record<string, any> = {}): Node {
  return w.sandbox.window.PhosphorCards.render('move', row, Object.assign({ name: 'proposal_status', input: { id: row.id }, waiting: true, live: true }, extra));
}

function cardFor(row: Record<string, any>, state: Record<string, any> = {}, extra: Record<string, any> = {}): Node {
  return cardIn(world(Object.assign({ proposals: [row] }, state)), row, extra);
}

/* What the card says before anything is opened: its visible text without the Details fold,
   joined the way a person reads it. */
function faceOf(card: Node): string {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.hidden === true || String(n.className).split(' ').includes('tcard-details')) return;
    if (n.childNodes.length === 0) {
      if (n.ownText !== '') out.push(n.ownText as string);
      return;
    }
    for (const child of n.childNodes) walk(child);
  };
  walk(card);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/* The Details lines, whether or not the fold is open: they are on the card, one click away. */
function detailsOf(card: Node): string[] {
  return textOf(find(card, 'tcard-details-body')[0] ?? makeNode('div'), true);
}

/* The swap the window showed on 2026-09-18: the rail's numbers arrive as `simulation.swap`,
   and its summary is the same figures as prose. */
const ADDR = '0xb583f41992Cd21b2F2345e194a36D33684BB5DB0';

function swapProposal(over: Record<string, any> = {}): Record<string, any> {
  return Object.assign({
    id: 's1',
    kind: 'swap',
    status: 'pending',
    createdAt: '2026-09-18T17:35:00.000Z',
    draft: { kind: 'swap', venue: 'intents-native', chain: 'eth', toChain: 'sol', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, amountUsd: 2, minAmountOut: 0.0172, from: ADDR, to: ADDR, counterparty: 'intents.near', quote: null },
    simulation: {
      ok: true,
      summary: 'intents-native: 2 USDC -> 0.017783069 SOL, entirely inside intents.near\nfee $0.0071, eta ~12s, solver floor 17605238 base units, draft floor 0.0172 SOL',
      swap: { receives: '0.017783069', receivesAtLeast: '0.017605238', feeUsd: 0.0071, etaSeconds: 12 },
    },
    verdict: { outcome: 'needs_approval', reasons: ['swap of $2.00 to intents.near.', '$2.00 is above the $1.00 click threshold.'] },
  }, over);
}

test('no string reaches the DOM as markup', () => {
  for (const [name, source] of [['decision.js', SOURCE], ['cards.js', CARDS]] as const) {
    assert.equal(/\.innerHTML\s*=/.test(source), false, name + ' assigns innerHTML');
    assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(source), false, name);
  }
});

test('the deciding buttons are built in decision.js and every one is named', () => {
  const labels = [...SOURCE.matchAll(/'btn-label', '([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length > 0, 'decision.js builds no buttons at all, so this test is not looking at it');
  const allowed = ['Cancel', 'Approve', 'Unlock', 'Confirm on your Mac', 'Try again'];
  for (const label of labels) assert.ok(allowed.includes(label as string), `decision.js built a button labelled "${label}"`);
  /* Nothing else in the window approves or refuses: the card's skeleton, the thread and the
     send card only place what decision.js built. */
  for (const file of ['ui/screens/cards.js', 'ui/screens/agent.js', 'ui/screens/sendcard.js']) {
    const text = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    assert.equal(/api\.approve|api\.refuse|\/api\/approve|\/api\/refuse/.test(text), false, file + ' decides a move');
  }
});

test('no key dismisses a decision', () => {
  // The card is a place in the thread, not a modal. A key that closed an ask would be a way out
  // of a pending decision that is neither Cancel nor Approve.
  assert.equal(/keydown|keyup|'Escape'/.test(SOURCE), false, 'decision.js listens to the keyboard');
  assert.equal(/aria-modal/.test(SOURCE + CARDS), false);
  const card = cardFor(swapProposal());
  fire(card, 'keydown', { key: 'Escape' });
  assert.deepEqual(labelsOf(card), ['Cancel', 'Approve']);
});

/* THE BUTTONS ARE THE SERVER'S. A propose reply reaches the window through the conversation,
   and a card drawn from it alone could show one move while its id pointed at another. So the
   reply draws the move, and the question waits for the state frame's own row. */
test('a card asks only on the live frame\'s own row, and only while that row waits', () => {
  const row = swapProposal();
  assert.deepEqual(labelsOf(cardFor(row, {}, { waiting: true, live: true })), ['Cancel', 'Approve']);
  assert.deepEqual(labelsOf(cardFor(row, {}, { waiting: true, live: false })), [], 'a reply drew the question');
  assert.deepEqual(labelsOf(cardFor(row, {}, { waiting: undefined, live: true })), [], 'a row no frame has listed yet drew the question');
  const stale = cardFor(row, {}, { waiting: false, live: false });
  assert.deepEqual(labelsOf(stale), [], 'a stored reply from last week still asks');
  assert.ok(textOf(stale).includes('No longer waiting'), textOf(stale).join(' | '));
});

test('the policy diff still exports', () => {
  const decision = world().sandbox.window.PhosphorDecision;
  assert.equal(typeof decision.diffOf, 'function');
  assert.equal(typeof decision.refineDiff, 'function');
  const diff = decision.diffOf(['a: one, two.'], ['a: one, two, three.']);
  assert.equal(diff.added.length, 1);
  assert.equal(decision.refineDiff(diff).length, 1);
});

/* The face says the move in the reference's words: what you pay, the floor you get, the fee.
   The rule that asked, where the money goes and the rail's own lines are one click away under
   Details, never the engine's restatement and never a venue id. */
test('a swap card asks with its figures on one line and keeps the rest one click away', () => {
  const card = cardFor(swapProposal());
  const face = faceOf(card);
  assert.ok(face.includes('Needs your OK'), face);
  assert.match(face, /You pay 2 USDC/);
  assert.match(face, /You get at least 0\.0176052 SOL/);
  assert.match(face, /Fee \$0\.0071/);
  assert.equal(face.includes('swap of $2.00 to intents.near'), false, 'the engine\'s restatement is on the card');
  assert.equal(face.includes('intents-native'), false, 'the venue id is on the card');
  const details = detailsOf(card);
  assert.ok(details.some((t) => t.includes('$2.00 is above the $1.00 click threshold.')), 'the rule that asked is not in Details');
  assert.ok(details.includes('Stays in'), 'the money that stays put is not said so');
  const addr = find(card, 'sendcard-address');
  assert.equal(addr.length, 1, 'no address line');
  assert.equal(textOf(addr[0], true).join(''), ADDR, 'the address is not whole');
  assert.equal(find(addr[0], 'sendcard-group').length, 11, 'the address is not in groups of four');
  assert.ok(details.some((t) => t.includes('your balance, where it already is')), details.join(' | '));
  assert.ok(details.some((t) => t.includes('solver floor 17605238 base units')), 'the rail\'s lines are not in Details');
  assert.equal(details.some((t) => /No fee was quoted/.test(t)), false);
});

test('a swap on the relay or the native rail names no venue line; a retired venue keeps its words', () => {
  for (const venue of ['intents-relay', 'intents-native']) {
    const card = cardFor(swapProposal({ draft: Object.assign({}, swapProposal().draft, { venue }) }));
    const text = textOf(card, true).join(' | ');
    assert.equal(text.includes('Through'), false, `a venue line is drawn for ${venue}: ${text}`);
    assert.equal(text.includes('intents-relay') || text.includes('intents relay'), false, 'the rail id is on the card');
  }
  const legacy = cardFor(swapProposal({ draft: Object.assign({}, swapProposal().draft, { venue: 'oneclick' }) }));
  assert.ok(detailsOf(legacy).includes('1Click, on NEAR Intents'), 'a retired venue lost its words');
});

/* A swap to somebody else's address is never described as staying put. */
test('only the account the swap spends from stays in; anything else keeps its full disclosure', () => {
  const OTHER = '0x1111111111111111111111111111111111111111';
  const elsewhere = cardFor(swapProposal({ draft: Object.assign({}, swapProposal().draft, { to: OTHER }) }));
  const details = detailsOf(elsewhere);
  assert.ok(details.includes('Goes to'));
  assert.ok(find(elsewhere, 'sendcard-address').some((line) => textOf(line, true).join('') === OTHER));
  assert.ok(details.includes('the destination this app chose'));
});

// B4. 1Click mints a deposit address per quote, so it can never sit on an allowlist, and it is
// the address the funds are actually signed over to. Showing the allowlisted leg while hiding
// that one is the shape of F2: an amount that was correct while the screen named the wrong
// destination.
test('an address the venue chose is on the card, in full, and says who chose it', () => {
  const MINTED = '0x7d4e1f0a2c9b8e6d3f5a1c7b9e0d2f4a6c8b0e1d3f5a7c9b1e3d5f7a9c1b3e5d';
  const card = cardFor({
    id: 'p1',
    kind: 'swap',
    status: 'pending',
    createdAt: '2026-09-07T10:00:00.000Z',
    draft: { kind: 'swap', chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountUsd: 500 },
    simulation: { ok: true, summary: 'leg 1 funds go to ' + MINTED + ' (chosen by 1click, not by us)', depositAddresses: [{ leg: 'arb->near', address: MINTED }] },
    verdict: { outcome: 'needs_approval', reasons: ['It is above the $100.00 you said to ask about.'] },
  });
  const details = detailsOf(card);
  const rows = find(card, 'destination');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].getAttribute('data-chosen'), 'venue');
  assert.equal(textOf(find(rows[0], 'sendcard-address')[0], true).join(''), MINTED, 'the minted address is not whole');
  assert.ok(details.includes('an address the swap service chose, not your wallet'), 'the address is on the card without saying who chose it');
  assert.ok(details.some((t) => t.includes('chosen by 1click')), 'the rail report is not on the card');
});

/* A rail that hands the card no numbers still never claims no fee was quoted, and its own
   lines are the disclosure, one click away. */
test('a card with no structured figures never claims no fee was quoted', () => {
  const card = cardFor({
    id: 'd1',
    kind: 'hl_deposit',
    status: 'pending',
    createdAt: '2026-09-18T17:36:00.000Z',
    draft: { kind: 'hl_deposit', amount: 10, symbol: 'USDC', amountUsd: 10, hlAccount: ADDR, counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, summary: 'Fund Hyperliquid perps from the intents balance.\n  cost      0.0388 USDC, 0.39 percent of the deposit' },
    verdict: { outcome: 'needs_approval', reasons: ['hl_deposit of $10.00 to hyperliquid-perps.', '$10.00 is above the $1.00 click threshold.'] },
  });
  assert.equal(textOf(card, true).some((t) => /No fee was quoted/.test(t)), false);
  assert.ok(detailsOf(card).some((t) => t.includes('0.0388 USDC')));
  assert.match(faceOf(card), /You move 10 USDC/);
});

// B2. The one card whose whole job is to show what a rule change does lists what it adds and
// what it takes away, on its face, in the engine's words and never the assistant's.
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
  assert.ok(text.includes('- intents.near'), 'a removed destination is not shown as lost');
  assert.ok(text.some((t) => t.includes('$10,000')), 'the line being removed is not shown');
  assert.ok(text.some((t) => t.includes('$20,000')), 'the line being added is not shown');
  assert.equal(textOf(card, true).some((t) => t.includes('the agent asked for')), false, 'the assistant wrote a line on the card deciding its own request');
  assert.ok(textOf(card).includes('Change your limits'));
});

const OPEN = {
  kind: 'trade',
  op: 'open',
  plan: { id: 'pl_1', symbol: 'BTC', side: 'long', sizeUsd: 4000, leverage: 20, entry: { type: 'market', maxSlippageBps: 30 }, stop: 63000, target: 66000, expiresAt: '2026-09-12T10:00:00.000Z' },
  hash: 'abc',
  risk: { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 },
  amountUsd: 200,
  counterparty: 'hyperliquid-perps',
};

function gridOf(card: Node): Record<string, string> {
  const grid = find(card, 'mcard-grid')[0];
  assert.ok(grid, 'no risk facts on the card');
  const cells = textOf(grid);
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < cells.length; i += 2) out[cells[i] as string] = cells[i + 1] as string;
  return out;
}

test('a trade reads as a sentence with its risk facts, and a change shows old and new', () => {
  const decision = world().sandbox.window.PhosphorDecision;
  assert.equal(decision.headlineOf({ kind: 'trade', draft: OPEN }), 'Open a long on BTC');
  assert.equal(decision.headlineOf({ kind: 'trade', draft: { kind: 'trade', op: 'change', id: 'pl_1', stop: 1, before: {}, after: {} } }), 'Change the stop on pl_1');
  assert.equal(decision.headlineOf({ kind: 'trade', draft: { kind: 'trade', op: 'change', id: 'pl_1', target: 1, before: {}, after: {} } }), 'Change the target on pl_1');
  assert.equal(decision.headlineOf({ kind: 'trade', draft: { kind: 'trade', op: 'change', id: 'pl_1', cancel: true, before: {}, after: {} } }), 'Cancel pl_1');
  assert.equal(decision.headlineOf({ kind: 'trade', draft: { kind: 'trade', op: 'change', id: 'pl_1', close: true, before: {}, after: {} } }), 'Close pl_1');

  const card = cardFor({ id: 'p4', kind: 'trade', status: 'pending', createdAt: '2026-09-11T10:00:00.000Z', draft: OPEN, simulation: { ok: true, summary: 'Long BTC: $4,000.00 notional at 20x.' }, verdict: { outcome: 'needs_approval', reasons: ['$200.00 is above the $100.00 click threshold.'] } });
  const facts = gridOf(card);
  assert.equal(facts['Collateral at stake'], '$200.00 isolated, at 20x');
  assert.equal(facts['Max loss at the stop'], '$66.10 with fees');
  assert.equal(facts['If the stop slips 10%'], 'up to $400.00 more');
  assert.equal(facts['Entry'], 'market, up to 30 bps slippage');
  assert.equal(facts['Stop'], '63000');
  assert.equal(facts['Target'], '66000');
  assert.equal(facts['Liquidation near'], '61570.12');
  assert.equal(facts['Expires'], '2026-09-12T10:00:00.000Z');
  const face = faceOf(card);
  assert.ok(face.includes('Long BTC'), face);
  assert.ok(face.includes('$200.00'), 'the governed amount leads the card');
  assert.equal(face.includes('No fee was quoted'), false);
});

test('a change card shows old and new, a close shows what is at stake, a cancel shows what is left', () => {
  const before = { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 };
  const base = { id: 'p7', kind: 'trade', status: 'pending', createdAt: '2026-09-11T10:00:00.000Z', verdict: { outcome: 'needs_approval', reasons: ['wider'] } };
  const exits = cardFor({ ...base, draft: { kind: 'trade', op: 'change', id: 'pl_1', stop: 62000, target: 68000, before, after: { ...before, maxLossUsd: 128.6 }, amountUsd: 200, counterparty: 'hyperliquid-perps' }, simulation: { ok: true, summary: 'Stop 63000 becomes 62000.' } });
  const exitFacts = gridOf(exits);
  assert.equal(exitFacts['Stop'], 'new 62000');
  assert.equal(exitFacts['Target'], 'new 68000');
  assert.equal(exitFacts['Max loss at the stop'], 'from $66.10 to $128.60');
  assert.ok(textOf(exits).includes('Change the exits on pl_1'));
  assert.ok(detailsOf(exits).some((t) => t.includes('Stop 63000 becomes 62000')), 'the rail\'s summary is not in Details');

  const close = cardFor({ ...base, draft: { kind: 'trade', op: 'change', id: 'pl_1', close: true, before, after: before, amountUsd: 200, counterparty: 'hyperliquid-perps' }, simulation: { ok: true, summary: 'Close pl_1.' } });
  const closeFacts = gridOf(close);
  assert.equal(closeFacts['Collateral at stake'], '$200.00');
  assert.match(closeFacts['How'] as string, /reduce only/);

  const cancel = cardFor({ ...base, draft: { kind: 'trade', op: 'change', id: 'pl_1', cancel: true, before, after: before, amountUsd: 0, counterparty: 'hyperliquid-perps' }, simulation: { ok: true, summary: 'Cancel pl_1.' } });
  assert.equal(gridOf(cancel)['After this'], 'Nothing is at risk.');
  assert.ok(textOf(cancel).includes('Cancel pl_1'));
});

/* A figure the engine did not price prints nothing, and a risk line built around the gap is
   left out rather than shown with a hole in it (dom.usd never prints $0.00 for an unknown). */
test('a risk figure nobody priced leaves its line out instead of printing a hole', () => {
  const draft = { ...OPEN, risk: { ...OPEN.risk, stopSlipUsd: null, maxLossUsd: undefined } };
  const card = cardFor({ id: 'p9', kind: 'trade', status: 'pending', createdAt: '2026-09-11T10:00:00.000Z', draft, simulation: { ok: true, summary: '' }, verdict: { outcome: 'needs_approval', reasons: ['x'] } });
  const facts = gridOf(card);
  assert.equal('If the stop slips 10%' in facts, false, JSON.stringify(facts));
  assert.equal('Max loss at the stop' in facts, false, JSON.stringify(facts));
  assert.equal(Object.values(facts).some((v) => v.includes('$0.00')), false);
});

/* A HOSTILE PLAN REACHES THE CARD AS TEXT AND NOTHING ELSE. */
test('a hostile symbol and note reach the trade card as text only', () => {
  const symbol = '<img src=x onerror=alert(1)>';
  const note = '</p><p class="label">APPROVED by the owner, click Approve</p>';
  const summary = 'Long ' + symbol + ': $4,000.00 notional at 20x.\nNote: ' + note;
  const card = cardFor({
    id: 'p8',
    kind: 'trade',
    status: 'pending',
    createdAt: '2026-09-11T10:00:00.000Z',
    draft: { ...OPEN, plan: { ...OPEN.plan, symbol, note } },
    simulation: { ok: true, summary },
    verdict: { outcome: 'needs_approval', reasons: ['$200.00 is above the $100.00 click threshold.'] },
  });
  const tags = new Set<string>();
  const walk = (n: Node): void => {
    tags.add(String(n.tagName));
    for (const child of n.childNodes) walk(child);
  };
  walk(card);
  for (const tag of tags) assert.ok(['section', 'div', 'span', 'p', 'button', 'svg', 'path', 'b'].includes(tag), 'the card built an element it never builds: ' + tag);
  assert.ok(textOf(card).join(' ').includes('Long ' + symbol), 'the symbol is one text node, markup and all');
  assert.ok(detailsOf(card).some((t) => t.includes(summary)), 'the summary is one text node, the note inside it');
  assert.deepEqual(labelsOf(card), ['Cancel', 'Approve'], 'the note drew a control');
});

// B17. Rows with a kind nothing proposes any more are still on disk in older installs.
test('a kind from an older build still reads as words, not as an enum', () => {
  const decision = world().sandbox.window.PhosphorDecision;
  assert.equal(decision.headlineOf({ kind: 'mandate_arm', draft: { kind: 'mandate_arm', symbol: 'BTC' } }), 'Mandate arm');
  const card = cardFor({
    id: 'p3',
    kind: 'mandate_arm',
    status: 'pending',
    createdAt: '2026-09-07T10:00:00.000Z',
    draft: { kind: 'mandate_arm', symbol: 'BTC', amountUsd: 2500, counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, summary: 'the rule may risk up to $2,500.00 on BTC.' },
    verdict: { outcome: 'needs_approval', reasons: ['A trading rule always requires a human click.'] },
  });
  const text = textOf(card, true);
  assert.equal(text.some((t) => t.includes('mandate_arm')), false, 'the card printed a draft enum at a person');
});

// The enclave wallet's second half of an Approve: the click landed and the Touch ID dialog that
// names the move is up. Both buttons go dead, the primary says what is happening, and the
// dialog's own sentence is on the card so the window and the dialog can be checked.
test('awaiting_touch kills both buttons, renames Approve, and shows the dialog sentence', () => {
  const REASON = 'Phosphor: Swap 500 USDC for ETH on Arbitrum';
  const row = swapProposal({ id: 'p7', status: 'awaiting_touch' });
  const card = cardFor(row, { vault: { waiting: { id: 'approve:p7', op: 'unwrap', reason: REASON, since: 1 } } });
  const [cancel, yes] = buttons(card);
  assert.ok(cancel && yes, 'the waiting card does not carry two buttons');
  assert.equal(yes!.disabled, true, 'Approve still takes a click while the dialog is up');
  assert.equal(cancel!.disabled, true, 'Cancel still takes a click while the dialog is up');
  assert.deepEqual(labelsOf(card), ['Cancel', 'Confirm on your Mac']);
  assert.ok(textOf(card).includes('Confirm on your Mac'));
  assert.ok(textOf(card).includes(REASON), 'the dialog sentence is not on the card');
  assert.equal(find(card, 'mcard-touch').length, 1);

  const back = cardFor(swapProposal({ id: 'p7' }), { vault: { waiting: null } });
  assert.equal(textOf(back).includes(REASON), false);
  assert.deepEqual(labelsOf(back), ['Cancel', 'Approve']);
});

/* THE CLICK AND NOTHING AFTER IT. No "Approved." flash and no receipt to close: the frame that
   answers the click repaints the card, and until it lands both buttons stay dead, so a second
   click cannot ride on a stale render. */
test('an Approve that lands keeps both buttons off and claims nothing the frame has not said', async () => {
  const w = world({ proposals: [swapProposal()] });
  const card = cardIn(w, swapProposal());
  w.timers.splice(0).forEach((fn) => fn());
  const [cancel, yes] = buttons(card);
  fire(yes!, 'click');
  assert.deepEqual(w.calls, ['approve:s1']);
  await tick();
  await tick();
  assert.equal(yes!.disabled, true, 'Approve came back on before the frame answered');
  assert.equal(cancel!.disabled, true);
  assert.equal(/'Approved\.'|'Done\.'|'Refused\.'/.test(SOURCE), false, 'the card flashes an answer the rail has not given');
  assert.ok(textOf(card).includes('Needs your OK'), 'the card moved on before the frame did');

  // The frame: approved and running. The same card, in place, working.
  card.__paint(swapProposal({ status: 'executing', decidedAt: new Date().toISOString() }), { name: 'proposal_status', waiting: false, live: true });
  assert.equal(card.getAttribute('data-state'), 'working');
  assert.deepEqual(labelsOf(card), [], 'buttons are left on a working card');
  assert.ok(textOf(card).includes('Swapping'), textOf(card).join(' | '));
});

/* A CLICK THAT DOES NOT LAND SAYS SO WHERE THE BUTTONS ARE, and hands them back. */
test('an Approve that fails puts the problem under the buttons and hands them back', async () => {
  const w = world({ proposals: [swapProposal()] }, { approve: () => Promise.reject(new Error('The app is not answering. It may have stopped.')) });
  const card = cardIn(w, swapProposal());
  w.timers.splice(0).forEach((fn) => fn());
  const [cancel, yes] = buttons(card);
  assert.equal(find(card, 'mcard-note')[0].hidden, true, 'a note is up before anything went wrong');
  fire(yes!, 'click');
  assert.equal(yes!.disabled, true, 'Approve takes a second click while the first is in flight');
  await tick();
  await tick();
  const note = find(card, 'mcard-note')[0];
  assert.equal(note.hidden, false);
  assert.deepEqual(textOf(note), ['The app is not answering. It may have stopped.']);
  assert.equal(yes!.disabled, false, 'Approve stays dead after a click that did not land');
  assert.equal(cancel!.disabled, false);
});

/* A TOUCH ID DIALOG THAT CLOSES WITHOUT AN ANSWER puts the row back to pending and writes
   nothing on it. The card remembers the row it drew on the sensor and says so. */
test('a row back from Touch ID with no answer says so, over live buttons, until the next click', () => {
  const w = world({ vault: { waiting: { id: 'approve:s1', op: 'unwrap', reason: 'Phosphor: Swap 2 USDC for SOL', since: 1 } } });
  const card = cardIn(w, swapProposal({ status: 'awaiting_touch' }));
  assert.equal(textOf(card).some((t) => t.includes('Touch ID closed')), false);
  w.state.vault = { waiting: null };
  card.__paint(swapProposal(), { name: 'proposal_status', waiting: true, live: true });
  w.timers.splice(0).forEach((fn) => fn());
  assert.ok(textOf(card).includes('Touch ID closed without an answer. Nothing moved. Approve asks again.'), textOf(card).join(' | '));
  const live = buttons(card);
  assert.ok(live.every((b) => b.disabled === false), 'the buttons are dead on a row that is pending');
  // A heartbeat that changes nothing keeps the note.
  card.__paint(swapProposal(), { name: 'proposal_status', waiting: true, live: true });
  assert.ok(textOf(card).some((t) => t.includes('Touch ID closed')));
  // The next click goes back to the sensor, and the note goes with it.
  fire(live[1]!, 'click');
  card.__paint(swapProposal({ status: 'awaiting_touch' }), { name: 'proposal_status', waiting: true, live: true });
  assert.equal(textOf(card).some((t) => t.includes('Touch ID closed')), false);
});

test('a plain pending row carries no Touch ID note', () => {
  const card = cardFor(swapProposal());
  assert.equal(textOf(card).some((t) => t.includes('Touch ID')), false);
});

/* A request that arrived while the wallet was shut asks for the lock first and offers no
   Approve it could not act on. */
test('a locked wallet\'s ask says so and offers Unlock instead of Approve', () => {
  const w = world();
  const card = cardIn(w, swapProposal({ status: 'pending_unlock' }));
  w.timers.splice(0).forEach((fn) => fn());
  assert.ok(textOf(card).includes('Unlock to decide'));
  assert.ok(textOf(card).some((t) => t.includes('The app is locked')));
  assert.deepEqual(labelsOf(card), ['Cancel', 'Unlock']);
  fire(buttons(card)[1]!, 'click');
  assert.deepEqual(w.calls, ['unlock'], 'Unlock approved something');
});

/* A card that appears under a pointer holds its buttons for a beat, and the button is the gate:
   a click dispatched at a dead one decides nothing. */
test('a click dispatched at a dead Approve decides nothing', () => {
  const w = world({ proposals: [swapProposal()] });
  const card = cardIn(w, swapProposal({ id: 'fresh' }));
  const yes = buttons(card)[1]!;
  assert.equal(yes.disabled, true, 'a card that just appeared came up live');
  fire(yes, 'click');
  assert.deepEqual(w.calls, [], 'a dead Approve approved');
  w.timers.splice(0).forEach((fn) => fn());
  assert.equal(yes.disabled, false);
  fire(yes, 'click');
  assert.deepEqual(w.calls, ['approve:fresh']);
});

// The held row: approved with heldSince and nothing signed; the executor retries on its own.
// The card says what it is waiting for, the checks are in its Details, and nothing is pressable.
test('a held deposit says what it is waiting for, keeps the checks in Details, and offers nothing to press', () => {
  const card = cardFor({
    id: 'p-held',
    kind: 'hl_deposit',
    status: 'approved',
    createdAt: '2026-09-17T10:00:00.000Z',
    decidedBy: 'human',
    decidedAt: new Date(Date.now() - 60_000).toISOString(),
    heldSince: new Date(Date.now() - 60_000).toISOString(),
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
      ],
    }],
  }, {}, { waiting: false });
  const text = textOf(card);
  assert.ok(text.includes('Waiting to start'), text.join(' | '));
  assert.ok(text.some((t) => /^Waiting for Arbitrum gas to settle/.test(t) && t.endsWith('Nothing is signed until it clears.')), text.join(' | '));
  assert.equal(find(card, 'checks').length, 1, 'the checks are not in Details');
  assert.deepEqual(labelsOf(card), [], 'a held move offers a button');
});

// 2026-09-15 and 2026-09-23: a swap 1Click reported FAILED, the card printed the rail's whole
// sentence with the 64 character handle in it, and said the input was "held by 1Click" when
// nothing had left the balance. The face gets the app's plain words; the venue's line and the
// handle, cut to two ends, are evidence under Details.
const HANDLE = '86abbc463f08f6244071c17f4cd3471285b24179a4f029fe54a1979d2de7f806';

test('a move that did not go through says so in plain words and keeps the venue\'s line in Details', () => {
  const said = `1click reported FAILED and refunded 0 USDC so far; the input is held by 1Click under handle ${HANDLE}; reason not given.`;
  const card = cardFor(swapProposal({
    status: 'failed',
    settledAt: '2026-09-15T19:16:00.000Z',
    result: { ok: false, detail: said, evidence: { handle: HANDLE, providerStage: 'FAILED' } },
    view: { id: 's1', kind: 'swap', stage: 'failed', stageLabel: 'Failed', stageCopy: 'It did not go through.', terminal: true, error: { code: 'venue_failed', message: said }, money: {}, txs: [], correlationId: HANDLE },
  }), {}, { waiting: false });
  const face = faceOf(card);
  assert.ok(face.includes("Didn't go through"), face);
  assert.equal(face.includes('held by 1Click'), false, 'the venue\'s sentence is on the face');
  assert.equal(face.includes(HANDLE.slice(0, 20)), false, 'the handle is on the face');
  const details = detailsOf(card).join(' ');
  assert.ok(details.includes('1click reported FAILED'), 'the venue\'s line is not in Details');
  assert.equal(details.includes(HANDLE), false, 'the whole handle is printed');
  assert.match(details, /86abbc46\.\.\.2de7f806/);
});

/* The refusal names its real cause. "A rule you set stopped it" over a swap nobody would price
   sent a person to their limits for a problem that was the market's. */
test('a swap nobody would price says that, not that a rule stopped it', () => {
  const card = cardFor(swapProposal({
    status: 'policy_refused',
    simulation: { ok: false, summary: '', error: 'no quote' },
    verdict: { outcome: 'refuse', reasons: ['swap of $4.00 to intents.near.', 'Nobody offered a price for this swap right now. Nothing moved.'] },
  }), {}, { waiting: false });
  const face = faceOf(card);
  assert.ok(face.includes('Nobody offered a price for this swap right now. Nothing moved.'), face);
  assert.equal(face.includes('A rule you set'), false);
  assert.deepEqual(labelsOf(card), []);
});

/* Try again is offered only where the view offers it, and it asks the assistant, in the
   person's own words in the thread, rather than re-proposing on its own. */
test('Try again appears only when the view offers it, and asks the assistant rather than moving money', () => {
  const failed = swapProposal({ status: 'failed', view: { id: 's1', kind: 'swap', stage: 'failed', state: 'didnt_go_through', terminal: true, money: {}, txs: [] } });
  assert.deepEqual(labelsOf(cardFor(failed, {}, { waiting: false })), []);
  const stuck = { code: 'stuck_unknown', sentence: "We can't confirm yet whether this went through.", details: null, retry: false };
  assert.deepEqual(labelsOf(cardFor({ ...failed, view: { ...failed.view, reason: stuck } }, {}, { waiting: false })), [], 'a move that may still be live offers a second try');
  const w = world();
  const nothingLeft = { code: 'venue_failed_nothing_moved', sentence: "The swap didn't go through. Nothing left your balance.", details: null, retry: true };
  const offered = cardIn(w, { ...failed, view: { ...failed.view, reason: nothingLeft } }, { waiting: false });
  assert.deepEqual(labelsOf(offered), ['Try again']);
  fire(buttons(offered)[0]!, 'click');
  assert.deepEqual(w.calls, [], 'Try again decided something');
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0] as string, /^Try that again/);
});

/* The view names the cause (src/proposals/view.ts `reason`): its sentence is the face, and the
   engineer's line behind it, ids already cut, is the Details. Nothing else is guessed. */
test('the view\'s reason is the face and its details are behind Details', () => {
  const card = cardFor(swapProposal({
    status: 'failed',
    result: { ok: false, detail: `1click reported FAILED (reason not given) and the intents ledger shows no transfer to handle ${HANDLE} since this move was approved, so nothing left the balance.` },
    view: {
      id: 's1', kind: 'swap', stage: 'failed', state: 'didnt_go_through', terminal: true, money: {}, txs: [],
      reason: { code: 'venue_failed_nothing_moved', sentence: "The swap didn't go through. Nothing left your balance.", details: '1click reported FAILED (reason not given) and the intents ledger shows no transfer to handle 86abbc46...2de7f806 since this move was approved, so nothing left the balance.', retry: true },
    },
  }), {}, { waiting: false });
  const face = faceOf(card);
  assert.ok(face.includes("The swap didn't go through. Nothing left your balance."), face);
  assert.equal(face.includes('1click'), false, 'the venue\'s line is on the face');
  const details = detailsOf(card).join(' ');
  assert.ok(details.includes('the intents ledger shows no transfer'), details);
  assert.equal(details.includes(HANDLE), false, 'the whole handle is printed');
});

/* The view's late object: the card says it is late and counts from the click, never a stopwatch. */
test('a working move the view calls late says so on its own card', () => {
  const at = new Date(Date.now() - 200_000).toISOString();
  const card = cardFor(swapProposal({
    status: 'executing',
    decidedAt: at,
    view: { id: 's1', kind: 'swap', stage: 'submitting', state: 'working', terminal: false, decidedAt: at, money: {}, txs: [], late: { elapsedSec: 200, typicalSec: 45 }, reason: null },
  }), {}, { waiting: false });
  assert.match(faceOf(card), /Taking longer · 3m/);
});

/* A refund on its way (src/proposals/view.ts coming_back, 2026-09-23): money that left and is
   coming back is not over, and never "Didn't go through", which reads as nothing moved. The card
   says so calmly, prints the reason's sentence, draws no amount that will not arrive, and offers
   no second try while the first one's money is still out. */
test('a refund on its way says so calmly, with its sentence, no amount to come and no second try', () => {
  const sentence = "The swap didn't go through. Your USDC is with the swap service until it comes back to your balance; the app keeps checking.";
  const card = cardFor(swapProposal({
    status: 'failed',
    view: { id: 's1', kind: 'swap', stage: 'FAILED', state: 'coming_back', terminal: false, money: {}, txs: [], reason: { code: 'venue_failed_refund_pending', sentence, details: null, retry: true } },
  }), {}, { waiting: false });
  assert.equal(card.getAttribute('data-state'), 'coming_back');
  const face = faceOf(card);
  assert.match(face, /Refund on its way/);
  assert.ok(face.includes(sentence), face);
  assert.equal(face.includes("Didn't go through"), false, 'the state word says nothing moved');
  assert.equal(face.includes('0.0177'), false, 'the card promises the SOL that will not arrive');
  assert.deepEqual(labelsOf(card), [], 'a second try while the first one\'s money is out');
});

/* A finished move with a catch (view.note): less arrived than was approved. It is done, and the
   one sentence about the shortfall sits under the head where it is read. */
test('a done move that brought less than approved says so under its head', () => {
  const note = 'The swap went through, but only 0.00034 WBTC arrived, less than the 0.00035 you approved.';
  const card = cardFor(swapProposal({
    status: 'executed',
    view: { id: 's1', kind: 'swap', stage: 'confirmed', state: 'done', terminal: true, money: {}, txs: [], reason: { code: 'short_fill', sentence: note, details: null, retry: false }, note, tookSec: 9 },
  }), {}, { waiting: false });
  assert.equal(card.getAttribute('data-state'), 'done');
  assert.match(faceOf(card), /Done · 9s/);
  assert.ok(faceOf(card).includes(note), faceOf(card));
  assert.equal(card.getAttribute('data-note'), 'true');

  const clean = cardFor(swapProposal({
    status: 'executed',
    view: { id: 's1', kind: 'swap', stage: 'confirmed', state: 'done', terminal: true, money: {}, txs: [], reason: null, note: null, tookSec: 9 },
  }), {}, { waiting: false });
  assert.equal(clean.getAttribute('data-note'), null);
  assert.equal(find(clean, 'mcard-body')[0]?.hidden, true, 'a clean done card grew a body');
});

/* Still checking (stuck_unknown, venue_failed_watching) arrives as working and late: the card
   keeps its track, says it is taking longer, and prints the reason, never "Didn't go through". */
test('a move the app is still checking stays working and late, with the reason as its line', () => {
  const at = new Date(Date.now() - 400_000).toISOString();
  const sentence = "Still checking whether this went through. I'll update it here.";
  const card = cardFor(swapProposal({
    status: 'failed',
    decidedAt: at,
    view: { id: 's1', kind: 'swap', stage: 'FAILED', state: 'working', terminal: false, decidedAt: at, money: {}, txs: [], late: { elapsedSec: 400, typicalSec: 45 }, reason: { code: 'stuck_unknown', sentence, details: null, retry: false } },
  }), {}, { waiting: false });
  assert.equal(card.getAttribute('data-state'), 'working');
  const face = faceOf(card);
  assert.match(face, /Taking longer · 6m/);
  assert.ok(face.includes(sentence), face);
  assert.equal(face.includes("Didn't go through"), false);
  assert.deepEqual(labelsOf(card), []);
});

test('a rule change with no state frame yet says its headline once', () => {
  const card = cardFor({
    id: 'p1',
    kind: 'policy_change',
    status: 'pending',
    createdAt: '2026-09-19T11:00:00.000Z',
    draft: { kind: 'policy_change', patch: { perTxUsd: 5000 }, sentence: 'Change your limits' },
    simulation: { ok: true, policyDiff: { before: [], after: [] } },
    verdict: { outcome: 'needs_approval', reasons: ['A rule change always asks.'], changes: [] },
  });
  const said = textOf(card).filter((t) => t === 'Change your limits');
  assert.equal(said.length, 1, 'the headline is on the card ' + said.length + ' times');
  assert.equal(textOf(card).includes('The assistant said'), false, 'the card quotes a sentence it wrote itself');
});

/* The cards other screens build (the backup nudge, the recovery words, Turn off) go to the
   thread through the conversation: there is no second surface they could cover it from. */
test('a card another screen shows goes to the thread', () => {
  const w = world();
  const shown: unknown[] = [];
  w.sandbox.window.PhosphorAgent.showCard = (build: unknown) => { shown.push(build); };
  const build = (): void => {};
  w.sandbox.window.PhosphorDecision.showCard(build);
  assert.deepEqual(shown, [build]);
  assert.equal(/getElementById\('overlay/.test(SOURCE), false, 'decision.js still reaches for the dock');
});

/* A SEND IS DECIDED ON ITS CARD, with the receiver whole on its face. On a Touch ID wallet the
   click's wait says so, and while the dialog is up both buttons are dead and the dialog's own
   sentence is on the card. Approve answers that proposal and nothing else. */
test('a send asks on its card with the receiver whole, and Touch ID is said where the click is', async () => {
  const FRIEND = '0xb583f41992Cd21b2F2345e194a36D33684BB5DB0';
  const pay = (over: Record<string, any> = {}): Record<string, any> => ({
    id: 'p-pay',
    kind: 'intents_pay',
    status: 'pending',
    createdAt: '2026-09-17T10:00:00.000Z',
    draft: { kind: 'intents_pay', symbol: 'ETH', network: 'ethereum', amount: 0.01, amountUsd: 24.4, minReceived: 0.0097, from: '0x1111111111111111111111111111111111111111', to: FRIEND, counterparty: 'intents.near', recipient: { known: false, count: 0, lastAt: null, ownAddress: false } },
    simulation: { ok: true, summary: 'intents pay', send: { arrives: '0.00994', arrivesAtLeast: '0.0098406', feeUsd: 0.15, etaSeconds: 17, explorer: `https://etherscan.io/address/${FRIEND}` } },
    verdict: { outcome: 'needs_approval', reasons: ['Money leaving for another address always needs a human click, whatever the size.'] },
    ...over,
  });
  const w = world({ proposals: [pay()], vault: { custody: 'secure-enclave' } });
  const card = cardIn(w, pay());
  w.timers.splice(0).forEach((fn) => fn());
  const face = faceOf(card);
  assert.match(face, /You send 0\.01 ETH They get at least 0\.0098406 ETH Fee \$0\.15/);
  assert.ok(face.includes('First send to this address.'), face);
  const address = find(card, 'mcard-address-line')[0];
  assert.equal(address.getAttribute('data-address'), FRIEND);
  assert.equal(find(address, 'tcard-leg-group').map((g) => g.textContent).join(''), FRIEND);
  assert.deepEqual(labelsOf(card), ['Cancel', 'Approve']);
  const yes = buttons(card)[1]!;
  assert.equal(yes.getAttribute('data-pending-label'), 'Waiting for Touch ID', 'the click\'s wait does not name the sensor');
  fire(yes, 'click');
  assert.deepEqual(w.calls, ['approve:p-pay']);
  await tick();

  const t = world({ vault: { custody: 'secure-enclave', waiting: { reason: 'Approve: Pay 0.01 ETH to 0xb583...5DB0 on Ethereum ($24.40)' } } });
  const touching = cardIn(t, pay({ status: 'awaiting_touch' }));
  assert.deepEqual(labelsOf(touching), ['Cancel', 'Confirm on your Mac']);
  assert.ok(buttons(touching).every((b) => b.disabled === true));
  assert.ok(textOf(touching).includes('Approve: Pay 0.01 ETH to 0xb583...5DB0 on Ethereum ($24.40)'));

  const known = cardFor(pay({ draft: { ...pay().draft, recipient: { known: true, count: 3, lastAt: '2026-09-12T10:00:00.000Z', ownAddress: false } } }));
  assert.ok(faceOf(known).includes('Sent here 3 times before.'), faceOf(known));
});

/* Criterion 5.3: a card that changes state eases to its new height. After a yes the facts and
   the buttons leave, and a working card's two lines become the done card's one; the card used
   to cut from one height to the other (card-proof, a 16 px jump at a 440 px column). */
test('a card that changes state eases to its new height instead of jumping, and not under reduced motion', () => {
  const heights = (card: Node, before: number, after: number): void => {
    let reads = 0;
    card.getBoundingClientRect = () => ({ height: reads++ === 0 ? before : after });
  };
  const running = { status: 'executing', decidedAt: '2026-09-18T17:35:05.000Z', decidedBy: 'human', view: { id: 's1', kind: 'swap', stage: 'submitting', state: 'working', terminal: false, money: {}, txs: [] } };
  const landed = { status: 'executed', settledAt: '2026-09-18T17:35:26.000Z', view: { ...running.view, stage: 'confirmed', state: 'done', terminal: true, tookSec: 21 } };

  const w = world();
  const card = cardIn(w, swapProposal(running), { waiting: false });
  heights(card, 68, 52);
  card.__paint(swapProposal({ ...running, ...landed }), { name: 'proposal_status', input: { id: 's1' }, waiting: false, live: true });
  assert.equal(card.getAttribute('data-state'), 'done');
  assert.equal(card.style.height, '52px', 'the card cut to its new height');
  assert.match(String(card.style.transition), /^height 240ms/);
  for (const fn of w.timers.splice(0)) fn();
  assert.equal(card.style.height, '', 'the held height outlived the ease');

  /* A repaint that changes nothing reads no layout at all. */
  let reads = 0;
  card.getBoundingClientRect = () => { reads += 1; return { height: 52 }; };
  card.__paint(swapProposal({ ...running, ...landed }), { name: 'proposal_status', input: { id: 's1' }, waiting: false, live: true });
  assert.equal(reads, 0, 'a repaint with no change of state forced a layout');

  const still = world();
  still.sandbox.window.PhosphorMotion = { reduced: () => true };
  const calm = cardIn(still, swapProposal(running), { waiting: false });
  heights(calm, 68, 52);
  calm.__paint(swapProposal({ ...running, ...landed }), { name: 'proposal_status', input: { id: 's1' }, waiting: false, live: true });
  assert.equal(calm.style.height ?? '', '', 'reduced motion eased the height');
});
