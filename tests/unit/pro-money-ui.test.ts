// Pro's money line: the balance total the Basic panel prints, and beside it what the trading
// account holds, read off the trade payload trade.js hands over on every `trade` frame.
//
// What is held here: the balance is the server's own figure and words (state.basic), never a
// second sum; the account is one of four answers and never a zero standing in for an unknown
// (collateral.funded true, false for dust or nothing, null before the venue has answered, and
// a venue that is not answering); an empty account offers one action, which asks the assistant
// in the thread and says what to do when no agent is running; nothing here polls; and the
// trading side's late bundle is asked for the first time Pro or Trade is on screen.
//
// Run against the REAL ui/screens/pro.js and ui/core/dom.js over a stand-in DOM, the way the
// other *-ui tests do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const DOM = readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8');
const PRO = readFileSync(new URL('../../ui/screens/pro.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../ui/design/pro.css', import.meta.url), 'utf8');

function makeStyle(): Any {
  const props: Record<string, string> = {};
  return {
    setProperty: (name: string, value: string) => { props[name] = value; },
    removeProperty: (name: string) => { delete props[name]; },
    getPropertyValue: (name: string) => props[name] ?? '',
  };
}

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(ev: Any) => void>> = {};
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
    get children() { return node.childNodes; },
    get firstChild() { return node.childNodes[0] ?? null; },
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
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => { delete attrs[name]; },
    addEventListener: (type: string, fn: (ev: Any) => void) => { (listeners[type] = listeners[type] ?? []).push(fn); },
    removeEventListener: () => {},
    click: () => { for (const fn of listeners.click ?? []) fn({ preventDefault() {} }); },
    querySelectorAll: () => [],
  };
  return node;
}

function withClass(node: Any, name: string, out: Any[] = []): Any[] {
  if (String(node.className).split(' ').includes(name)) out.push(node);
  for (const child of node.childNodes) withClass(child, name, out);
  return out;
}

function one(node: Any, name: string): Any {
  const [found] = withClass(node, name);
  assert.ok(found, `no .${name}`);
  return found;
}

/* Every word on screen, in order: hidden nodes and their children are off the screen. */
function words(node: Any, out: string[] = []): string[] {
  if (node.hidden) return out;
  if (node.childNodes.length === 0 && node.textContent) out.push(node.textContent);
  for (const child of node.childNodes) words(child, out);
  return out;
}

type Rig = {
  host: Any;
  state: (next: Any) => void;
  trade: (data: Any) => void;
  view: (name: string) => void;
  loads: string[];
  sent: string[];
  intervals: number;
  canTalk: (on: boolean) => void;
};

function boot(): Rig {
  const host = makeNode('section');
  host.id = 'view-pro';
  let subscriber: ((state: Any) => void) | null = null;
  let current: Any = {};
  let loaded = false;
  let talking = true;
  const loads: string[] = [];
  const sent: string[] = [];
  const windowListeners: Record<string, Array<(ev: Any) => void>> = {};
  let intervals = 0;
  const document: Any = {
    createElement: (tag: string) => makeNode(tag),
    getElementById: (id: string) => (id === 'view-pro' ? host : null),
  };
  const window: Any = {
    document,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => { intervals += 1; return 0; },
    addEventListener: (type: string, fn: (ev: Any) => void) => { (windowListeners[type] = windowListeners[type] ?? []).push(fn); },
    PhosphorMotion: { reduced: () => true },
    PhosphorState: {
      subscribe: (fn: (state: Any) => void) => { subscriber = fn; },
      get: () => current,
      loaded: () => loaded,
    },
    PhosphorLazy: { load: (name: string) => { loads.push(name); return Promise.resolve(true); } },
    PhosphorAgent: { send: (text: string) => { if (!talking) return false; sent.push(text); return true; } },
  };
  window.window = window;
  const ctx = createContext({ window, document, console, Promise });
  runInContext(DOM, ctx);
  runInContext(PRO, ctx);
  window.PhosphorPro.boot();
  const fire = (type: string, detail: Any) => { for (const fn of windowListeners[type] ?? []) fn({ detail }); };
  return {
    host,
    state: (next: Any) => { current = next; loaded = true; subscriber!(next); },
    trade: (data: Any) => fire('phosphor:trade', { data }),
    view: (name: string) => fire('phosphor:view', { view: name }),
    loads,
    sent,
    get intervals() { return intervals; },
    canTalk: (on: boolean) => { talking = on; },
  };
}

const BASIC = { basic: { totalUsd: 13450.31, totalLine: '$13,450.31', caption: 'in your balance', holdings: [], smallLine: null, emptyLine: null } };

function trade(over: Any = {}): Any {
  return {
    symbol: 'BTC',
    venue: { connected: true, source: 'ws', ageMs: 300, latencyMs: 120, error: null, degraded: false },
    account: { equityUsd: 1046.82, freeUsd: 845.42, healthPct: 0.9, unified: false, accountKnown: true, atRiskUsd: 0, maxLossUsd: 0 },
    collateral: { address: '0x1', perpUsd: 1046.82, spotUsdcUsd: 0, funded: true },
    positions: [],
    ...over,
  };
}

test('the balance is the server\'s figure and words, the same two the Basic panel prints', () => {
  const rig = boot();
  assert.equal(one(rig.host, 'pro-sum-total').hidden, true, 'a figure before the first state frame');
  assert.equal(withClass(rig.host, 'pro-sum-skel').length, 1, 'the first read has no skeleton');
  rig.state(BASIC);
  assert.equal(one(rig.host, 'pro-sum-total').textContent, '$13,450.31');
  assert.equal(one(rig.host, 'pro-sum-total').hidden, false);
  assert.equal(one(rig.host, 'pro-sum-caption').textContent, 'in your balance');
  assert.equal(withClass(rig.host, 'pro-sum-skel').length, 0, 'the skeleton stays after the read');
  // No figure is the caption alone, never $0.00.
  rig.state({ basic: { totalUsd: null, totalLine: '', caption: 'Still checking your balance.', holdings: [] } });
  assert.equal(one(rig.host, 'pro-sum-total').hidden, true);
  assert.equal(one(rig.host, 'pro-sum-caption').getAttribute('data-alone'), 'true');
  assert.ok(!words(rig.host).includes('$0.00'), JSON.stringify(words(rig.host)));
});

test('a funded account is what it holds, what is free, what its plans have in them and the most they can lose', () => {
  const rig = boot();
  rig.state(BASIC);
  rig.trade(trade());
  assert.deepEqual(words(one(rig.host, 'pro-sum-figures')), ['Trading money', '$1,046.82', 'Free', '$845.42']);
  assert.equal(one(rig.host, 'pro-sum-note').hidden, true);
  assert.equal(one(rig.host, 'pro-sum-fund').hidden, true, 'a funded account is offered money');
  // The margin behind the plans is not what can be lost: the stops cap that, and the bigger,
  // wrong number is the one that scares. Each is named for what it is.
  rig.trade(trade({ account: { ...trade().account, atRiskUsd: 250, maxLossUsd: 31.2 } }));
  assert.deepEqual(words(one(rig.host, 'pro-sum-figures')), ['Trading money', '$1,046.82', 'Free', '$845.42', 'In trades', '$250.00', 'Max loss', '$31.20']);
  const loss = withClass(rig.host, 'pro-sum-figure').find((f) => words(f)[0] === 'Max loss');
  assert.ok(/every stop fills/.test(loss!.getAttribute('title') ?? ''), 'the max loss does not say what it assumes');
  for (const value of withClass(rig.host, 'pro-sum-value')) assert.ok(value.className.includes('num'), 'a figure not set as a figure');
});

test('dust is not trading money: collateral.funded false reads "No trading money yet", with one action', () => {
  // The live account held 0.000002 USDC: an equity that is a number is not money a plan can use.
  const rig = boot();
  rig.state(BASIC);
  rig.trade(trade({
    account: { ...trade().account, equityUsd: 0.000002, freeUsd: 0.000002 },
    collateral: { address: '0x1', perpUsd: 0.000002, spotUsdcUsd: 0, funded: false },
  }));
  assert.equal(one(rig.host, 'pro-sum-note').textContent, 'No trading money yet. Once there is some, Pro shows your positions, your orders and what they made.');
  assert.equal(one(rig.host, 'pro-sum-note').hidden, false);
  assert.equal(one(rig.host, 'pro-sum-figures').hidden, true, 'dust drew figures');
  const fund = one(rig.host, 'pro-sum-fund');
  assert.equal(fund.hidden, false);
  assert.equal(words(fund).join(''), 'Add trading money', 'the action says what and where');
  assert.ok(!fund.className.includes('btn-primary'), 'green is for Approve');
});

test('the one action asks the assistant in the thread, and says what to do first when no agent is running', () => {
  const rig = boot();
  rig.state(BASIC);
  rig.trade(trade({ collateral: { address: '0x1', perpUsd: 0, spotUsdcUsd: 0, funded: false } }));
  one(rig.host, 'pro-sum-fund').click();
  assert.deepEqual(rig.sent, ['Help me add money to my trading account.']);
  rig.canTalk(false);
  one(rig.host, 'pro-sum-fund').click();
  assert.equal(rig.sent.length, 1, 'a message went nowhere');
  assert.equal(one(rig.host, 'pro-sum-note').textContent, 'Start your agent, then ask it to add money to your trading account.');
});

test('a venue that has not answered is a wait, and one that is not answering reads unknown, never empty', () => {
  const rig = boot();
  rig.state(BASIC);
  rig.trade(trade({ collateral: { address: null, perpUsd: null, spotUsdcUsd: null, funded: null } }));
  assert.equal(one(rig.host, 'pro-sum-note').textContent, 'Checking your trading account.');
  assert.equal(one(rig.host, 'pro-sum-fund').hidden, true, 'an unanswered venue was offered money');
  rig.trade(trade({ account: { ...trade().account, accountKnown: false, equityUsd: null, freeUsd: null } }));
  assert.equal(one(rig.host, 'pro-sum-note').textContent, 'Checking your trading account.');
  rig.trade(trade({ venue: { connected: false, source: 'none', ageMs: null, latencyMs: null, error: 'no route to host', degraded: true } }));
  assert.deepEqual(words(one(rig.host, 'pro-sum-figures')), ['Trading money', '--', 'Free', '--']);
  assert.equal(one(rig.host, 'pro-sum-note').textContent, 'Hyperliquid is not answering. These come back on their own.', 'unknown figures with no sentence');
  for (const value of withClass(rig.host, 'pro-sum-value')) assert.equal(value.getAttribute('data-dim'), 'true');
  assert.ok(!words(rig.host).some((w) => w.startsWith('No trading money')), 'a silent venue was called empty');
});

test('nothing here polls: the account follows the stream through trade.js, and the late bundle loads on Pro', () => {
  const rig = boot();
  assert.equal(rig.intervals, 0, 'Pro started a timer');
  assert.doesNotMatch(PRO, /setInterval|api\.trade\(/, 'Pro reads the venue on its own clock again');
  rig.view('basic');
  rig.view('vault');
  assert.deepEqual(rig.loads, []);
  rig.view('pro');
  assert.deepEqual(rig.loads, ['trade']);
  rig.view('trade');
  assert.deepEqual(rig.loads, ['trade', 'trade'], 'Trade does not ask for its bundle');
  // Before the bundle has read anything the account side is empty, not a guess.
  assert.equal(one(rig.host, 'pro-sum-figures').hidden, true);
  assert.equal(one(rig.host, 'pro-sum-note').hidden, true);
});

test('Pro is its header over the deck alone, Trade is the market, the chart and the deck, and both share the Vault\'s two track stage', () => {
  assert.match(CSS, /body\[data-view="pro"\] #view-trade,\s*body\[data-view="trade"\] #view-trade\s*\{\s*display:\s*flex;/, 'the deck is not on both');
  assert.match(CSS, /body\[data-view="trade"\] #view-pro\s*\{\s*display:\s*none;/, 'Trade still draws Pro\'s header');
  assert.match(CSS, /body\[data-view="pro"\] \.trade-wrap > \.trade-strip,\s*body\[data-view="pro"\] \.trade-wrap > \.trade-main,\s*body\[data-view="pro"\] \.trade-wrap > \.split-h\s*\{\s*display:\s*none;/, 'Pro draws the market or the chart');
  assert.match(CSS, /body\[data-view="pro"\] \.trade-wrap > \.trade-rail\s*\{\s*display:\s*flex;\s*flex:\s*1 1 auto;/, 'the deck is not the whole of Pro under the line');
  assert.match(CSS, /body\[data-view="pro"\] \.trade-rail > \.trade-tabs\s*\{\s*display:\s*none;/, 'Pro stacks the three panels, it has no tabs');
  // One width on all three, so the conversation holds still when the tab changes.
  assert.match(CSS, /body\[data-view="pro"\] \.stage,\s*body\[data-view="trade"\] \.stage,\s*body\[data-view="vault"\] \.stage\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) clamp\(560px, min\(var\(--trade, 62vw\), calc\(100vw - 400px\)\), 1400px\);/);
  assert.equal((CSS.match(/grid-template-columns:\s*minmax\(0, 1fr\) clamp\(/g) || []).length, 1, 'a second stage width');
  const line = CSS.slice(CSS.indexOf('/* ---------- the header'));
  assert.ok(line.length > 200, 'the header section moved');
  assert.doesNotMatch(line, /--ink|--up|--down/, 'the header wears a state colour');
});
