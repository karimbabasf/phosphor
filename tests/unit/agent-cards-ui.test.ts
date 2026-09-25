// The cards the conversation draws, and the one card every move gets.
//
// A read used to reach the window as a name and a yes or no, and a person saw the table the
// model typed. Now the driver hands the window the answer (src/driver.ts, tool_data) and
// ui/screens/cards.js draws it. A move is one card from the moment it is asked for to the moment
// it ends, changed in place by every state frame: working, needs you, done, or did not go
// through. This file drives the real cards.js, decision.js and agent.js over a DOM small enough
// to read, and asserts what a person would see.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { proposalView } from '../../src/proposals/view.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM_SOURCE = read('../../ui/core/dom.js');
const MARKDOWN_SOURCE = read('../../ui/core/markdown.js');
const CARDS_SOURCE = read('../../ui/screens/cards.js');
const DECISION_SOURCE = read('../../ui/screens/decision.js');
const AGENT_SOURCE = read('../../ui/screens/agent.js');
import { fillChains } from '../fixtures/chains.ts';

type Any = Record<string, any>;

function make(tag: string): Any {
  const attrs: Record<string, string> = {};
  const on: Record<string, Array<(event?: Any) => void>> = {};
  let ownText = '';
  const node: Any = {
    tag,
    className: '',
    children: [] as Any[],
    parentNode: null as unknown as Any,
    hidden: false,
    disabled: false,
    isConnected: true,
    rows: 1,
    value: '',
    offsetHeight: 40,
    clientHeight: 38,
    scrollHeight: 38,
    scrollTop: 0,
    focused: false,
    style: { setProperty() {} } as Any,
    dataset: {} as Record<string, string>,
    __on: on,
    get textContent(): string {
      return node.children.length ? node.children.map((c: Any) => c.textContent).join('') : ownText;
    },
    set textContent(value: string) {
      node.children.length = 0;
      ownText = String(value);
    },
    get ownText(): string { return ownText; },
    get firstChild() { return node.children[0] ?? null; },
    get lastChild() { return node.children[node.children.length - 1] ?? null; },
    get nextSibling() {
      const parent = node.parentNode;
      if (!parent) return null;
      const at = parent.children.indexOf(node);
      return at === -1 ? null : parent.children[at + 1] ?? null;
    },
    appendChild: (child: Any) => node.insertBefore(child, null),
    insertBefore(child: Any, before: Any | null) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const at = before === null ? node.children.length : node.children.indexOf(before);
      node.children.splice(at === -1 ? node.children.length : at, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: Any) {
      const at = node.children.indexOf(child);
      if (at !== -1) node.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name: string, value: string) { attrs[name] = String(value); if (name === 'class') node.className = String(value); },
    setAttributeNS(_ns: string, name: string, value: string) { attrs[name] = String(value); },
    getAttribute(name: string) { return name in attrs ? attrs[name] : null; },
    hasAttribute(name: string) { return name in attrs; },
    removeAttribute(name: string) { delete attrs[name]; },
    addEventListener(type: string, fn: (event?: Any) => void) { (on[type] ??= []).push(fn); },
    removeEventListener() {},
    querySelector: () => null,
    focus() { node.focused = true; },
    blur() { node.focused = false; },
  };
  return node;
}

function fire(node: Any, type: string, event: Record<string, unknown> = {}): void {
  for (const fn of node.__on[type] ?? []) fn({ preventDefault: () => {}, stopPropagation: () => {}, ...event });
}

function all(node: Any, className: string, found: Any[] = []): Any[] {
  if (String(node.className).split(' ').includes(className)) found.push(node);
  for (const child of node.children) all(child, className, found);
  return found;
}

function byAttr(node: Any, name: string, value?: string, found: Any[] = []): Any[] {
  const got = node.getAttribute ? node.getAttribute(name) : null;
  if (got !== null && (value === undefined || got === value)) found.push(node);
  for (const child of node.children) byAttr(child, name, value, found);
  return found;
}

/* What a card says before anything is opened: its visible text without the Details fold, joined
   the way a person reads it. */
function faceOf(card: Any): string {
  const out: string[] = [];
  const walk = (n: Any): void => {
    if (n.hidden === true || String(n.className).split(' ').includes('tcard-details')) return;
    if (n.children.length === 0) {
      if (n.ownText !== '') out.push(n.ownText as string);
      return;
    }
    for (const child of n.children) walk(child);
  };
  walk(card);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/* The Details lines, each line's words joined, whether the fold is open or not. */
function detailsOf(card: Any): string[] {
  const fold = all(card, 'tcard-details-body')[0];
  if (!fold) return [];
  const words = (n: Any): string[] => (n.children.length ? n.children.flatMap(words) : (n.ownText ? [n.ownText] : []));
  return fold.children.map((line: Any) => words(line).join(' ').replace(/\s+/g, ' ').trim());
}

function stateWord(card: Any): string {
  return all(card, 'mcard-state-word')[0].textContent;
}

function build() {
  const driverHandlers: Array<(frame: unknown) => void> = [];
  const busHandlers: Record<string, Array<(payload: unknown) => void>> = {};
  const opened: unknown[] = [];
  const actions: string[] = [];
  const host = make('div');
  const composerHost = make('div');
  const timers: Array<() => void> = [];
  const sliceHandlers: Record<string, Array<(value: unknown, whole: unknown) => void>> = {};
  let state: Any = {};

  const sandbox: Record<string, unknown> = {
    console,
    URL,
    navigator: {},
    document: {
      createElement: (tag: string) => make(tag),
      createElementNS: (_ns: string, tag: string) => make(tag),
      addEventListener: () => {},
    },
  };
  const win: Record<string, unknown> = {
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    addEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: () => ({ lineHeight: '21px', paddingTop: '8px', paddingBottom: '8px' }),
    dispatchEvent: () => true,
    PhosphorNet: { readable: (e: Error) => String(e.message) },
    PhosphorShell: { setPending: () => {}, refresh: () => Promise.resolve() },
    PhosphorToast: { show: () => {} },
    PhosphorApi: {
      driver: (body: { action: string }) => { actions.push(body.action); return Promise.resolve({}); },
      driverState: () => Promise.resolve({ data: { state: 'ready', chats: [{ id: 'c1', transcript: [] }] } }),
      connection: () => Promise.resolve({ command: '', connected: [] }),
      approve: () => Promise.resolve({}),
      refuse: () => Promise.resolve({}),
    },
    PhosphorEvents: {
      on: (type: string, handler: (frame: unknown) => void) => {
        if (type === 'driver') driverHandlers.push(handler);
        else (busHandlers[type] ??= []).push(handler);
      },
    },
    PhosphorReceipt: {
      chainName: (id: string) => ({ eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', sol: 'Solana', intents: 'NEAR Intents', hyperliquid: 'Hyperliquid' })[id] ?? id,
    },
    PhosphorIcons: { svg: (name: string, className: string) => { const n = make('svg'); n.className = 'icon ' + (className || ''); n.setAttribute('data-icon', name); return n; } },
    PhosphorMarks: { logo: (symbol: string) => { const n = make('span'); n.className = 'logo'; n.setAttribute('data-token', String(symbol).toUpperCase()); return n; } },
    PhosphorMotion: { reduced: () => false },
    PhosphorState: {
      select: (key: string, handler: (value: unknown, whole: unknown) => void) => { (sliceHandlers[key] ??= []).push(handler); return () => {}; },
      get: () => state,
    },
    PhosphorDeposit: { open: (opts: unknown) => { opened.push(opts); return Promise.resolve(null); } },
    PhosphorLinks: {
      explorerUrl: (url: unknown) => (typeof url === 'string' && url.startsWith('https://') ? url : null),
      setHref: (anchor: Any, url: unknown) => { if (typeof url !== 'string' || !url.startsWith('https://')) return false; anchor.href = url; return true; },
    },
  };
  sandbox.window = win;
  sandbox.CustomEvent = function CustomEventStub(this: Any, type: string, init: Any) { this.type = type; this.detail = init?.detail; };
  createContext(sandbox);
  fillChains(sandbox, (src, name) => runInContext(src, sandbox, { filename: name }));
  runInContext(DOM_SOURCE, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(MARKDOWN_SOURCE, sandbox, { filename: 'ui/core/markdown.js' });
  runInContext(CARDS_SOURCE, sandbox, { filename: 'ui/screens/cards.js' });
  runInContext(DECISION_SOURCE, sandbox, { filename: 'ui/screens/decision.js' });
  runInContext(AGENT_SOURCE, sandbox, { filename: 'ui/screens/agent.js' });

  const agent = win.PhosphorAgent as { mount: (h: unknown, o: unknown) => void; start: () => void };
  agent.mount(host, { composerHost });
  agent.start();
  const emit = (event: Record<string, unknown>, chat = 'c1') => { for (const handler of driverHandlers) handler({ chat, event }); };
  emit({ kind: 'status', state: 'ready' });

  const input = all(composerHost, 'input')[0];
  const composer = all(composerHost, 'agent-composer')[0];
  return {
    host,
    composerHost,
    emit,
    input,
    composer,
    actions,
    opened,
    timers,
    cards: win.PhosphorCards as Any,
    ask(text: string) { input.value = text; fire(composer, 'submit'); },
    bus: (type: string, payload: unknown) => { for (const handler of busHandlers[type] ?? []) handler(payload); },
    /* A state frame's proposals slice, as ui/core/state.js hands it to whoever selected it. */
    proposals: (list: unknown[]) => { state = { ...state, proposals: list }; for (const handler of sliceHandlers.proposals ?? []) handler(list, state); },
    /* The deposit watch's frame (src/vault/watch.ts), the same way. */
    deposit: (frame: unknown) => { state = { ...state, deposit: frame }; for (const handler of sliceHandlers.deposit ?? []) handler(frame, state); },
    win,
    blocks: () => all(host, 'transcript-rows')[0].children as Any[],
    cardNodes: (kind?: string) => byAttr(host, 'data-card', kind),
    send: () => all(composerHost, 'composer-send')[0],
  };
}

const WALLET = {
  totalUsd: 29.6,
  rows: [
    { kind: 'intents', chain: 'intents', symbol: 'USDC', quantity: 25.9, valueUsd: 25.9, native: false },
    { kind: 'intents', chain: 'intents', symbol: 'SOL', quantity: 0.02, valueUsd: 3.7, native: true },
  ],
};

const BOOK = {
  symbol: 'BTC',
  account: { equityUsd: 1000, freeUsd: 700 },
  positions: [
    { coin: 'BTC', side: 'long', sizeCoin: 0.01, notionalUsd: 612, entryPx: 60000, markPx: 61200, unrealisedUsd: 12, roePct: 4.0, leverage: 3 },
    { coin: 'ETH', side: 'short', sizeCoin: 0.2, notionalUsd: 480, entryPx: 2500, markPx: 2400, unrealisedUsd: -20, roePct: -8.3, leverage: 5 },
  ],
  fills: { count: 1, inLastMin: 0, recent: [{ tid: 't1', coin: 'SOL', side: 'sell', px: 150, sizeCoin: 1, closedPnlUsd: 7.5, atMs: 1, liquidation: false }] },
};

/* A row as the app hands it to the window: with its view beside it, built by the one builder
   (src/proposals/view.ts). */
function withView(row: Record<string, unknown>, now?: number): Any {
  return { ...row, view: proposalView({ settle: (r) => r }, row as never, now) };
}

const SWAP_DRAFT = { kind: 'swap', venue: 'intents-native', chain: 'intents', toChain: 'intents', fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: 0.05, amountUsd: 5, minAmountOut: 4.9, from: '0x1', to: '0x1', counterparty: 'intents.near', quote: null };

test('kindFor names the card by the tool, prefix or not, and falls back to the facts card', () => {
  const world = build();
  const kindFor = world.cards.kindFor as (name: string, data?: unknown) => string;
  assert.equal(kindFor('mcp__phosphor__wallet'), 'balance');
  assert.equal(kindFor('wallet'), 'balance');
  assert.equal(kindFor('trade_read'), 'position');
  assert.equal(kindFor('mcp__phosphor__trade_batch'), 'position');
  assert.equal(kindFor('propose_swap'), 'move');
  assert.equal(kindFor('mcp__phosphor__propose_trade'), 'move');
  assert.equal(kindFor('proposal_status'), 'move');
  assert.equal(kindFor('deposit'), 'deposit');
  /* `watch` is gone from the tools (pg/agent), and its deposit-shaped answer with it. */
  assert.equal(kindFor('watch', { chain: 'base', asset: 'USDC', watching: 'watching' }), 'kv');
  assert.equal(kindFor('policy_show'), 'kv');
});

/* THE BALANCES ARE BESIDE THE CHAT. A wallet read draws its card only in a turn that asked about
   the money; the agent reads the wallet on the way to most things, and every one of those reads
   was a card nobody asked for. The card's total is its head figure, once. */
test('a wallet read draws its card only when the person asked about their money, with one total', () => {
  const world = build();
  world.ask('what is ETH doing today');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__wallet', ok: true });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
  assert.equal(world.cardNodes('balance').length, 0, 'a read on the way drew a wallet card');
  world.emit({ kind: 'turn_end', error: false, turns: 1 });

  world.ask('what do I hold');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
  const card = world.cardNodes('balance')[0];
  assert.ok(card, 'the answer to "what do I hold" drew no card');
  const text = card.textContent;
  assert.ok(text.includes('USDC') && text.includes('SOL'), text);
  assert.equal((text.match(/\$29\.60/g) ?? []).length, 1, 'the total is printed more than once: ' + text);
  assert.equal(all(card, 'tcard-total').length, 0, 'a Total row is back under the list');
  assert.equal(byAttr(card, 'data-token', 'USDC').length, 1, 'the USDC row carries no mark');
});

/* The card says a holding the way the panel beside it does (hunt A, 2026-09-23): the panel's
   quantity, no "NEAR Intents" under money that is simply in the balance, and "under $0.01"
   rather than a $0.00 that reads as worthless. */
test('the wallet card words a holding the way the panel does', () => {
  const world = build();
  world.ask('what do I hold');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: {
    totalUsd: 6200.004, byChain: { intents: 6200.004 }, stale: [], emptyCount: 0,
    rows: [
      { kind: 'intents', chain: 'intents', symbol: 'USDC', quantity: 6200, valueUsd: 6200, priced: true, native: false },
      { kind: 'intents', chain: 'intents', symbol: 'NEAR', quantity: 310.5, valueUsd: 0.004, priced: true, native: false },
      { kind: 'wallet', chain: 'base', symbol: 'ETH', quantity: 0.0000012, valueUsd: 0.0001, priced: true, native: true },
    ],
  } });
  const card = world.cardNodes('balance')[0];
  const qty = all(card, 'tcard-qty').map((n: Any) => n.textContent);
  assert.deepEqual(qty, ['6,200.00', '310.50', '0.000001']);
  assert.equal(card.textContent.includes('NEAR Intents'), false, card.textContent);
  assert.equal(all(card, 'tcard-place').length, 1, 'money outside the balance lost its place');
  assert.equal(card.textContent.includes('$0.00'), false, card.textContent);
  assert.ok(card.textContent.includes('under $0.01'), card.textContent);
});

test('an empty wallet says so in words, with the way in', () => {
  const world = build();
  world.ask('balance');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: { rows: [], totalUsd: 0, byChain: {}, stale: [], emptyCount: 12 } });
  const card = world.cardNodes('balance')[0];
  assert.ok(card.textContent.includes('Nothing here yet'), card.textContent);
  assert.ok(card.textContent.includes('deposit address'), card.textContent);
});

test('a wallet holding something the app cannot price never reads as $0.00', () => {
  // Karim's window, 2026-09-20: "What you hold $0.00 ... wNEAR 2.0097 not priced" over seven
  // dollars.
  const world = build();
  world.ask('balance');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: {
    totalUsd: 0, byChain: {}, stale: [], emptyCount: 0, unpriced: ['wNEAR'],
    rows: [{ kind: 'intents', chain: 'intents', symbol: 'wNEAR', quantity: 2.0097, valueUsd: 0, priced: false, native: false }],
  } });
  let card = world.cardNodes('balance')[0];
  assert.equal(all(card, 'tcard-figure')[0].textContent, 'not priced');
  assert.ok(card.textContent.includes('wNEAR not priced'), card.textContent);
  assert.equal(card.textContent.includes('$0.00'), false, card.textContent);

  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: {
    totalUsd: 7.01, byChain: { intents: 7.01 }, stale: [], emptyCount: 0, unpriced: ['wNEAR'],
    rows: [
      { kind: 'intents', chain: 'intents', symbol: 'USDC', quantity: 7.01, valueUsd: 7.01, priced: true, native: false },
      { kind: 'intents', chain: 'intents', symbol: 'wNEAR', quantity: 2.0097, valueUsd: 0, priced: false, native: false },
    ],
  } });
  assert.equal(world.cardNodes('balance').length, 1, 'a second wallet read in one turn drew a second card');
  card = world.cardNodes('balance')[0];
  assert.equal(all(card, 'tcard-figure')[0].textContent, 'at least $7.01');
});

test('dom.usd never prints $0.00 for a value nobody knows, and a real zero is still $0.00', () => {
  const box: Record<string, unknown> = { window: {}, document: { createElement: () => ({}) } };
  createContext(box);
  runInContext(DOM_SOURCE, box, { filename: 'ui/core/dom.js' });
  const d = (box.window as Any).PhosphorDom;
  for (const unknown of [null, undefined, '', 'n/a', NaN, Infinity, true]) {
    assert.equal(d.usd(unknown), '', `dom.usd(${String(unknown)}) printed a figure`);
    assert.equal(d.fee(unknown), '', `dom.fee(${String(unknown)}) printed a figure`);
  }
  assert.equal(d.usd(0), '$0.00');
  assert.equal(d.usd('12.5'), '$12.50');
  assert.equal(d.usd(-3), '-$3.00');
  assert.equal(d.fee(0.0071), '$0.0071');
});

test('the position card leads with up or down, and marks each side by its word', () => {
  const world = build();
  world.ask('how am I doing');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__trade_read', input: {}, data: BOOK });
  const card = world.cardNodes('position')[0];
  assert.ok(card, 'no position card');
  const summary = all(card, 'tcard-summary')[0];
  assert.equal(summary.getAttribute('data-tone'), 'down', 'twelve up and twenty down is down');
  assert.ok(summary.textContent.includes('Down') && summary.textContent.includes('$8.00') && summary.textContent.includes('2 open positions'), summary.textContent);
  const pnls = all(card, 'tcard-pnl');
  assert.deepEqual(pnls.map((p) => p.getAttribute('data-tone')), ['up', 'down', 'up']);
  assert.ok(pnls[0].textContent.includes('+$12.00'), pnls[0].textContent);
  assert.ok(pnls[1].textContent.includes('-$20.00'), pnls[1].textContent);
  assert.deepEqual(byAttr(card, 'data-side').map((s) => s.textContent), ['long', 'short']);
  assert.ok(card.textContent.includes('Closed'), 'the closed fill is not listed');
  assert.equal(all(card, 'tcard-figure')[0].textContent, '-$8.00', 'the head figure is not the sum');
});

test('a batch read is the same card', () => {
  const world = build();
  world.ask('positions');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__trade_batch', input: {}, data: { results: [{ as: 'p', op: 'positions', positions: BOOK.positions }, { as: 'a', op: 'account', account: BOOK.account }] } });
  const card = world.cardNodes('position')[0];
  assert.equal(all(card, 'tcard-position').length, 2);
});

/* SOMETHING ON SCREEN THE MOMENT A MOVE IS ASKED FOR, AND ONE CARD FOR ITS LIFE. The propose call
   draws the card (the pair and the amount are in its arguments), the reply fills it, the read
   the agent makes straight after updates it where it stands, and a second move is its own card. */
test('a proposed swap is one card from the ask to the end, and a refusal says why', () => {
  const world = build();
  world.ask('swap 0.05 sol to usdc');
  const input = { chain: 'intents', toChain: 'intents', fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: 0.05, minAmountOut: 4.9 };
  world.emit({ kind: 'tool', name: 'mcp__phosphor__propose_swap', input });
  let card = world.cardNodes('move')[0];
  assert.ok(card, 'nothing drew when the move was asked for');
  assert.equal(card.getAttribute('data-state'), 'working');
  assert.equal(stateWord(card), 'Checking prices');
  assert.match(faceOf(card), /^Swap 0\.05 SOL to USDC/);
  assert.equal(all(world.host, 'chat-working').length, 0, 'the working line repeats what the card already says');

  const filed = withView({ id: 'p1', kind: 'swap', status: 'pending', createdAt: '2026-09-15T10:00:00Z', draft: SWAP_DRAFT, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap 0.05 SOL for about 4.98 USDC', swap: { receives: '4.98', receivesAtLeast: '4.9', feeUsd: 0.02, etaSeconds: 5 } } });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__propose_swap', ok: true });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input, data: filed });
  assert.equal(world.cardNodes('move').length, 1, 'the reply drew a second card');
  card = world.cardNodes('move')[0];
  assert.equal(card.getAttribute('data-state'), 'needs_you');
  assert.equal(stateWord(card), 'Needs your OK');
  /* The line is words until the swap lands; what comes back is a figure, in the facts only
     (finish review, 2026-09-23: "about 0.1862 ETH" over "You get at least 0.1843 ETH"). */
  assert.match(faceOf(card), /^Swap 0\.05 SOL to USDC/);
  assert.equal(faceOf(card).includes('about 4.98'), false, 'a guessed figure in the line: ' + faceOf(card));
  assert.match(faceOf(card), /You pay 0\.05 SOL You get at least 4\.9 USDC Fee \$0\.02/);
  assert.deepEqual(all(card, 'mcard-fact-label').map((n) => n.textContent), ['You pay', 'You get at least', 'Fee'], 'each figure is not under its own label');
  assert.equal(all(card, 'mcard-approve').length, 0, 'the reply alone drew the question');

  world.proposals([filed]);
  assert.equal(all(card, 'mcard-approve').length, 1, 'the frame\'s own row drew no Approve');

  const done = withView({ ...filed, status: 'executed', decidedAt: '2026-09-15T10:00:20Z', decidedBy: 'human', settledAt: '2026-09-15T10:00:40Z',
    draft: { ...SWAP_DRAFT, quote: { amountOut: 4.98, feeUsd: 0.02, timeEstimateSec: 5 } }, result: { ok: true, detail: 'done', txids: ['abc'] } });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'p1' }, data: done.view });
  assert.equal(world.cardNodes('move').length, 1, 'the read-back drew a second card for the same move');
  world.proposals([done]);
  card = world.cardNodes('move')[0];
  assert.equal(card.getAttribute('data-state'), 'done');
  assert.match(stateWord(card), /^Done/);
  assert.equal(all(card, 'mcard-approve').length, 0);

  const refused = withView({ id: 'p2', kind: 'swap', status: 'policy_refused', createdAt: '2026-09-15T10:01:00Z', decidedAt: '2026-09-15T10:01:00Z', decidedBy: 'policy', draft: SWAP_DRAFT, verdict: { outcome: 'refuse', reasons: ['swap of $5.00 to intents.near.', 'Never more than $50 in one move.'], rule: 'max_per_transaction' }, simulation: null });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input, data: refused });
  assert.equal(world.cardNodes('move').length, 2, 'a different move is its own card');
  const second = world.cardNodes('move')[1];
  assert.equal(second.getAttribute('data-state'), 'didnt_go_through');
  assert.equal(stateWord(second), "Didn't go through");
  /* The rule's own figure is on the card: on its face, or behind Details where the view gives
     the face a plainer sentence for the cause. Never the stock "a rule you set". */
  const said = faceOf(second) + ' | ' + detailsOf(second).join(' | ');
  assert.ok(said.includes('Never more than $50 in one move.'), said);
  assert.equal(faceOf(second).includes('A rule you set'), false, faceOf(second));
});

/* THE MOVE CARD FOLLOWS ITS PROPOSAL, IN PLACE. Karim, 2026-09-18: "i already approved the swap
   and after approval it shows me this". Every state frame repaints the one card: the word fades
   to the new one, the card keeps its place and nothing is appended. */
test('a move card follows its proposal through every state, in place', () => {
  const world = build();
  world.ask('swap 2 usdc to sol');
  const input = { chain: 'intents', toChain: 'intents', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 };
  const row = (status: string, extra: Record<string, unknown> = {}) => withView({
    id: 'p9', kind: 'swap', status, createdAt: '2026-09-18T10:35:00Z',
    draft: { kind: 'swap', venue: 'intents-native', chain: 'intents', toChain: 'intents', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, amountUsd: 2, minAmountOut: 0.0172, quote: { amountOut: 0.0178, feeUsd: 0.01, timeEstimateSec: 5 } },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap', swap: { receives: '0.0178', receivesAtLeast: '0.0172', feeUsd: 0.01, etaSeconds: 5 } },
    ...extra,
  });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input, data: row('pending') });
  world.proposals([row('pending')]);
  world.emit({ kind: 'text', text: 'It needs your OK.' });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  const first = world.cardNodes('move')[0];
  assert.equal(stateWord(first), 'Needs your OK');
  assert.equal(all(first, 'mcard-state-word')[0].getAttribute('data-fade'), null, 'the first paint fades nothing');
  const before = world.blocks().map((b) => b.className);

  // Somebody else's row moves nothing here.
  world.proposals([row('pending'), { ...row('executed'), id: 'other', createdAt: '2026-09-18T10:00:00Z' }]);
  assert.equal(stateWord(world.cardNodes('move')[0]), 'Needs your OK');

  world.proposals([row('awaiting_touch')]);
  let card = world.cardNodes('move')[0];
  assert.equal(card, first, 'the card was rebuilt rather than painted in place');
  assert.equal(stateWord(card), 'Confirm on your Mac');
  assert.equal(all(card, 'mcard-state-word')[0].getAttribute('data-fade'), 'a');
  world.proposals([row('approved', { decidedAt: new Date().toISOString(), decidedBy: 'human' })]);
  assert.equal(all(card, 'mcard-state-word')[0].getAttribute('data-fade'), 'b');
  assert.equal(card.getAttribute('data-state'), 'working');
  assert.equal(stateWord(card), 'Swapping');
  assert.equal(all(card, 'mcard-approve').length, 0, 'a working card still asks');
  assert.equal(world.cardNodes('move').length, 1, 'the card was appended rather than redrawn');

  const evidence = { providerStage: 'SUCCESS', handle: 'h1', quote: { correlationId: 'corr-9-0123456789abcdef' }, explorerUrl: 'https://nearblocks.io/txns/abc' };
  const settled = row('executed', {
    decidedAt: '2026-09-18T10:36:00Z', decidedBy: 'human', result: { ok: true, detail: 'done', txids: ['abc'], evidence },
    settledAt: '2026-09-18T10:38:10Z', lastChangeAt: '2026-09-18T10:38:10Z',
  });
  world.proposals([settled]);
  card = world.cardNodes('move')[0];
  assert.equal(card.getAttribute('data-state'), 'done');
  assert.equal(card.getAttribute('data-lit'), 'true', 'the card did not light as it landed');
  assert.match(stateWord(card), /^Done · /);
  /* Done is one line: the move and its word. The out leg is the coin bought, as a fact. */
  assert.match(faceOf(card), /^2 USDC 0\.0178 SOL Done · /);
  assert.ok(!faceOf(card).includes('about'), 'a landed figure is a fact, not an expectation: ' + faceOf(card));
  assert.equal(all(card, 'mcard-body')[0].hidden, true, 'a done card is more than one line');
  /* The vendor's word never sits on the face. The reference is two ends and a Copy that carries
     the whole id, and the hash is a link where it is now; all of it is one click away. */
  assert.ok(!faceOf(card).includes('SUCCESS'));
  const lines = detailsOf(card);
  assert.ok(lines.some((t) => t.startsWith('Landed at')), lines.join(' | '));
  assert.ok(lines.some((t) => t.startsWith('You approved it at')), lines.join(' | '));
  assert.ok(lines.some((t) => t.startsWith('Reference') && t.includes('corr-9-0...89abcdef')), lines.join(' | '));
  assert.ok(!card.textContent.includes('corr-9-0123456789abcdef'), 'the whole id is printed');
  assert.ok(all(card, 'tcard-copy').some((b: Any) => b.getAttribute('aria-label') === 'Copy corr-9-0...89abcdef'), 'no Copy beside the reference');
  assert.ok(all(card, 'tcard-link').some((a: Any) => a.textContent.includes('abc')), 'the hash is not a link');
  assert.deepEqual(world.blocks().map((b) => b.className), before, 'the redraw moved rows around');
  /* The head opens the Details of a card that folds to one line. */
  const head = all(card, 'mcard-head')[0];
  assert.equal(head.getAttribute('role'), 'button');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  fire(head, 'click');
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(all(card, 'mcard-body')[0].hidden, false, 'the head opened nothing');

  const refunded = row('failed', {
    decidedAt: '2026-09-18T10:36:00Z', decidedBy: 'human', result: { ok: false, detail: 'The transfer sent the money back: the quote expired before the deposit landed. {"code":422} intent 0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0', txids: ['abc'], evidence: { ...evidence, providerStage: 'REFUNDED' } },
    settledAt: '2026-09-18T10:40:00Z',
  });
  world.proposals([refunded]);
  const failed = world.cardNodes('move')[0];
  assert.equal(stateWord(failed), "Didn't go through");
  assert.ok(!faceOf(failed).includes('REFUNDED') && !faceOf(failed).includes('422'), 'the venue\'s words are on the face: ' + faceOf(failed));
  const failedLines = detailsOf(failed);
  assert.ok(failedLines.some((t) => t.startsWith('The full record') && t.includes('422')), 'the rail line is not kept as evidence: ' + failedLines.join(' | '));
  /* The service's word is for developers; a person reads who turned it down, in words. */
  assert.ok(failedLines.includes('The swap service turned it down.'), failedLines.join(' | '));
  const stageLine = all(failed, 'tcard-line').find((n: Any) => all(n, 'tcard-line-label')[0]?.textContent === 'The swap service said');
  assert.ok(stageLine, 'the service\'s word left the evidence');
  assert.equal(stageLine.getAttribute('data-dev-only'), '', 'the service\'s word shows outside developer mode');
  assert.ok(failedLines.some((t) => t.includes('0x9f8e7d...d3c2b1a0')), 'the hash in the rail line is not cut to its ends');
  assert.ok(!failed.textContent.includes('0x9f8e7d6c5b4a3928'), 'a whole hash reached the card');
  /* An address is not a hash: 40 hex characters stay whole in the same line (frozen rule 3). */
  const address = '0xDeAdBeEf00112233445566778899AaBbCcDdEeFf';
  const refused = `The venue refused the payout to ${address} (alice.near) after intent 0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0 was signed.`;
  /* The venue still holds a handle, so the app is still checking: nothing of the rail's line yet. */
  world.proposals([row('failed', {
    decidedAt: '2026-09-18T10:36:00Z', decidedBy: 'human', settledAt: '2026-09-18T10:40:00Z',
    result: { ok: false, detail: refused, txids: ['abc'], evidence: { ...evidence, providerStage: 'FAILED' } },
  })]);
  assert.equal(detailsOf(world.cardNodes('move')[0]).some((t) => t.startsWith('The full record')), false, 'the rail line printed while the move is still being checked');
  world.proposals([row('failed', {
    decidedAt: '2026-09-18T10:36:00Z', decidedBy: 'human', settledAt: '2026-09-18T10:40:00Z',
    result: { ok: false, detail: refused, evidence: { providerStage: 'FAILED' } },
  })]);
  assert.equal(stateWord(world.cardNodes('move')[0]), "Didn't go through");
  const recorded = detailsOf(world.cardNodes('move')[0]).find((t) => t.startsWith('The full record')) as string;
  assert.ok(recorded.includes(address), 'the receiver was cut in the evidence line: ' + recorded);
  assert.ok(recorded.includes('0x9f8e7d...d3c2b1a0') && !recorded.includes('0x9f8e7d6c5b4a3928'));
  assert.equal(world.cardNodes('move').length, 1);
});

test('a card says who decided: a click is the person\'s, an auto-run is the rules\', a refusal by a rule is nobody\'s click', () => {
  const world = build();
  const view = (over: Record<string, unknown>) => ({
    id: 'p5', kind: 'swap', waitingOn: null, terminal: true, createdAt: '2026-09-20T22:41:00Z',
    lastChangeAt: '2026-09-20T22:41:15Z', elapsedSec: 15, sinceChangeSec: 0, typicalSec: 45, deadlineAt: null,
    correlationId: null, error: null, txs: [],
    money: { symbol: 'USDC', toSymbol: 'wNEAR', amountIn: '7.0069', feeUsd: '0.03', amountOut: '2.0097', fromPocket: 'NEAR Intents', toPocket: 'NEAR Intents', beforeUsd: null, afterUsd: null },
    ...over,
  });
  const row = (status: string, decidedBy: string, extra: Record<string, unknown>) => ({
    id: 'p5', kind: 'swap', status, createdAt: '2026-09-20T22:41:00Z', decidedAt: '2026-09-20T22:41:00Z', decidedBy,
    draft: { kind: 'swap', venue: 'intents-native', chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 7.0069, amountUsd: 7, minAmountOut: 1.9889 },
    verdict: { outcome: 'allow', reasons: [] }, simulation: { ok: true, summary: 'swap' },
    ...extra,
  });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 7.0069, minAmountOut: 1.9889 }, data: { id: 'p5', status: 'executing', verdict: { outcome: 'allow', reasons: [] }, simulation: { ok: true, summary: 'swap' } } });

  world.proposals([row('executed', 'policy', { settledAt: '2026-09-20T22:41:15Z', result: { ok: true, detail: 'done' },
    view: view({ stage: 'confirmed', stageLabel: 'Confirmed', outcome: 'confirmed', decidedAt: '2026-09-20T22:41:00Z', decidedBy: 'policy', settledAt: '2026-09-20T22:41:15Z', tookSec: 15 }) })]);
  let lines = detailsOf(world.cardNodes('move')[0]);
  assert.ok(lines.some((t) => t.startsWith('Your rules allowed it at')), lines.join(' | '));
  assert.ok(!lines.some((t) => t.startsWith('You approved it at')), lines.join(' | '));
  assert.equal(stateWord(world.cardNodes('move')[0]), 'Done · 15s');

  world.proposals([row('policy_refused', 'policy', { verdict: { outcome: 'refuse', reasons: ['This swap cannot be valued in dollars.'], rule: 'invalid_amount' },
    view: view({ stage: 'refused', stageLabel: 'Refused', outcome: 'refused', decidedAt: '2026-09-20T22:41:00Z', decidedBy: 'policy', settledAt: '2026-09-20T22:41:00Z', error: { code: 'invalid_amount', message: 'This swap cannot be valued in dollars.' } }) })]);
  lines = detailsOf(world.cardNodes('move')[0]);
  assert.ok(!lines.some((t) => t.startsWith('You approved it at') || t.startsWith('Your rules allowed')), lines.join(' | '));
  assert.ok(lines.some((t) => t.startsWith('Ended at')), lines.join(' | '));
  assert.ok(faceOf(world.cardNodes('move')[0]).includes('This swap cannot be valued in dollars.'));
});

test('a floor prints as a quantity, cut and never rounded up', () => {
  // A swap floor of 1.988851425812084254220825 wNEAR printed with all 24 places (2026-09-20),
  // and six significant figures rounded half-up printed 5.934637 as 5.93464, a floor above the
  // one the rail holds the venue to.
  const world = build();
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 7.0069, minAmountOut: 1.988851425812084254220825 },
    data: { id: 's1', status: 'pending', verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap', swap: { receives: '2.0089', receivesAtLeast: '1.988851425812084254220825', feeUsd: 0.03, etaSeconds: 45 } } } });
  const card = world.cardNodes('move')[0];
  /* wNEAR is the stored name of NEAR inside NEAR Intents; the card says NEAR. */
  assert.ok(faceOf(card).includes('You get at least 1.98885 NEAR'), faceOf(card));
  assert.ok(!faceOf(card).includes('wNEAR'), faceOf(card));
  assert.ok(!card.textContent.includes('1.988851425812'), card.textContent);

  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 7, minAmountOut: 5.934637 },
    data: { id: 'f1', status: 'pending', verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap', swap: { receives: '6', receivesAtLeast: '5.934637', feeUsd: 0.03, etaSeconds: 45 } } } });
  const second = world.cardNodes('move')[1];
  assert.ok(faceOf(second).includes('at least 5.93463 NEAR'), faceOf(second));
  assert.ok(!second.textContent.includes('5.93464'));
  assert.equal(world.cards.floorText(1234567), '1,234,560');
  assert.equal(world.cards.floorText(0.000123456789), '0.000123456');
});

test('a small amount keeps its figures: 0.00149 ETH reads as 0.00149, not 0.0015', () => {
  const world = build();
  const row = withView({ id: 'e1', kind: 'swap', status: 'executed', createdAt: '2026-09-23T10:00:00Z', decidedAt: '2026-09-23T10:00:01Z', decidedBy: 'policy', settledAt: '2026-09-23T10:00:07Z',
    draft: { ...SWAP_DRAFT, fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 4, amountUsd: 4, minAmountOut: 0.00147 }, verdict: { outcome: 'allow', reasons: [] }, simulation: { ok: true, summary: 'swap' },
    result: { ok: true, detail: 'done' } });
  row.view.money.amountOut = '0.00149';
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'e1' }, data: row });
  assert.match(faceOf(world.cardNodes('move')[0]), /^4 USDC 0\.00149 ETH Done/);
});

test('a read-back of a move keeps its Details where the person left them', () => {
  const world = build();
  const input = { chain: 'arb', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.017 };
  const row = withView({ id: 'k1', kind: 'swap', status: 'pending', createdAt: '2026-09-18T10:35:00Z', draft: { ...SWAP_DRAFT, fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2 }, verdict: { outcome: 'needs_approval', reasons: ['above the line'] }, simulation: { ok: true, summary: 'swap' } });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input, data: row });
  world.proposals([row]);
  const toggle = all(world.cardNodes('move')[0], 'mcard-details-toggle')[0];
  fire(toggle, 'click');
  assert.equal(all(world.cardNodes('move')[0], 'tcard-details')[0].getAttribute('data-open'), 'true');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'k1' }, data: row.view });
  world.proposals([{ ...row, verdict: { outcome: 'needs_approval', reasons: ['above the line', 'again'] } }]);
  assert.equal(world.cardNodes('move').length, 1);
  assert.equal(all(world.cardNodes('move')[0], 'tcard-details')[0].getAttribute('data-open'), 'true', 'a repaint closed Details the person opened');
});

test('a move the person said no to says so once the frame says so', () => {
  const world = build();
  world.ask('swap 2 usdc to sol');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { chain: 'intents', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 }, data: { id: 'p3', status: 'pending', verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' } } });
  world.proposals([withView({ id: 'p3', kind: 'swap', status: 'refused', createdAt: '2026-09-18T10:35:00Z', decidedAt: '2026-09-18T10:35:30Z', decidedBy: 'human', draft: { ...SWAP_DRAFT, fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 }, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: null })]);
  const card = world.cardNodes('move')[0];
  assert.equal(stateWord(card), 'Cancelled');
  assert.ok(faceOf(card).includes('You said no. Nothing moved.'), faceOf(card));
});

/* A propose that never became a row (the call failed) does not leave a card saying "Checking
   prices" forever: it says the request did not reach the wallet and nothing moved. */
test('a move asked for and never filed says so rather than working forever', () => {
  const world = build();
  world.ask('swap 1 usdc to btc');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__propose_swap', input: { fromSymbol: 'USDC', toSymbol: 'BTC', amountIn: 1 } });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__propose_swap', ok: false });
  const card = world.cardNodes('move')[0];
  assert.equal(card.getAttribute('data-state'), 'didnt_go_through');
  assert.ok(faceOf(card).includes('This did not reach your wallet. Nothing moved.'), faceOf(card));

  world.emit({ kind: 'tool', name: 'mcp__phosphor__propose_swap', input: { fromSymbol: 'USDC', toSymbol: 'BTC', amountIn: 1 } });
  assert.equal(world.cardNodes('move')[1].getAttribute('data-state'), 'working');
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.equal(world.cardNodes('move')[1].getAttribute('data-state'), 'didnt_go_through', 'a card still works after its turn ended');
});

/* The deposit card, answered with the address itself (hunt B, 2026-09-23). The agent is told the
   address's ends only; the card reads the whole one through the window's own route, the way Add
   money does, and draws it only when the wallet is open and the ends are the ones the agent was
   given. */
const DEPOSIT_ADDRESS = '0x12ab5c7d9e0f1a2b3c4d5e6f708192a3b4c59fe2';
const DEPOSIT_DATA = { ok: true, shownInWindow: true, chain: 'base', network: 'Base', asset: 'USDC', minDeposit: 1, addressFingerprint: '0x12ab...9fe2', addressVerified: true, memo: null, watching: 'watching' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function depositWorld(report: Any) {
  const world = build();
  const copied: string[] = [];
  const drawn: unknown[] = [];
  const picked: Any[] = [];
  let destroyed = 0;
  world.win.PhosphorMoneyIn = { load: () => Promise.resolve(report) };
  world.win.PhosphorLazy = { load: () => Promise.resolve(true) };
  world.win.PhosphorNetPick = {
    kindOf: (id: string) => (id === 'base' ? 'evm' : null),
    addressBlock: (address: string, kind: string) => { const n = make('div'); n.className = 'deposit-address addr'; n.textContent = address; n.setAttribute('data-kind', kind); return n; },
    copyChecked: (address: string, say: (text: string) => void) => { copied.push(address); say('Address copied, ends in ...' + address.slice(-4)); return Promise.resolve(true); },
    drawChecked: (_canvas: unknown, address: string, px: number) => { drawn.push([address, px]); return { ok: true }; },
    /* The token list and its acknowledgement, as netpick.js keeps them (netpick-ui.test.ts drives
       the real one): Show the address waits for the tick, then hands the address back. */
    render: (host: Any, opts: Any) => {
      picked.push(opts);
      const root = make('div');
      root.className = 'netpick';
      root.dataset.stage = opts.stage;
      const box = make('input');
      box.className = 'ack-input';
      box.checked = false;
      const go = make('button');
      go.className = 'btn';
      go.dataset.role = 'show-address';
      go.disabled = true;
      go.textContent = 'Show the address';
      box.addEventListener('change', () => { go.disabled = !box.checked; });
      go.addEventListener('click', () => { if (box.checked) opts.onAddress(opts.network, opts.symbol, {}); });
      root.appendChild(box);
      root.appendChild(go);
      host.appendChild(root);
      const view = { destroy: () => { destroyed += 1; if (root.parentNode === host) host.removeChild(root); } };
      host.__netpick = view;
      return view;
    },
  };
  return { world, copied, drawn, picked, destroyed: () => destroyed };
}

/* Tick the box under the token list, then press Show the address. */
function acknowledge(card: Any): void {
  const box = all(card, 'ack-input')[0];
  assert.ok(box, 'no acknowledgement on the card');
  box.checked = true;
  fire(box, 'change');
  const go = all(card, 'btn').find((b: Any) => b.dataset.role === 'show-address');
  assert.ok(go, 'no Show the address on the card');
  fire(go, 'click');
}

test('the deposit card answers with the whole address, Copy and a QR code, read by the window itself', async () => {
  const { world, copied, drawn } = depositWorld({ verified: true, networks: [{ id: 'base', words: 'Base', address: DEPOSIT_ADDRESS, memo: null, accepts: [] }] });
  world.ask('deposit usdc on base');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: { chain: 'base', asset: 'USDC' }, data: DEPOSIT_DATA });
  const card = world.cardNodes('deposit')[0];
  assert.ok(card, 'no deposit card');
  assert.ok(card.textContent.includes('Deposit USDC on Base'), card.textContent);
  assert.equal(all(card, 'tcard-tail')[0].textContent, '9fe2', 'the ends are not said while the address is read');
  /* The state is a word, not a pill with a dot, and the check is not a tag. */
  assert.equal(all(card, 'tcard-state')[0].textContent, 'Watching');
  assert.equal(/verified|Address checked/.test(card.textContent), false, card.textContent);
  assert.ok(card.textContent.includes('At least 1 USDC.'), card.textContent);
  assert.equal(all(card, 'tcard-chip').length, 0, 'a status pill is back');
  assert.equal(byAttr(card, 'data-token', 'BASE').length, 1, 'no network mark');

  await settle();
  assert.equal(all(card, 'deposit-address').length, 0, 'the address is on the card before the tick');
  acknowledge(card);
  const block = all(card, 'deposit-address')[0];
  assert.ok(block, 'the whole address is not on the card');
  assert.equal(block.textContent, DEPOSIT_ADDRESS);
  assert.equal(block.getAttribute('data-kind'), 'evm');
  assert.equal(all(card, 'tcard-place')[0].hidden, true, 'the ends are said twice once the address is there');

  fire(all(card, 'tcard-copy')[0], 'click');
  assert.deepEqual(copied, [DEPOSIT_ADDRESS]);
  const said = all(card, 'tcard-deposit-said')[0];
  assert.equal(said.hidden, false);
  assert.equal(said.textContent, 'Address copied, ends in ...9fe2');

  assert.equal(all(card, 'mcard-address-row')[0]?.children.at(-1)?.className.includes('tcard-copy'), true, 'Copy is not at the end of the address row');
  const show = all(card, 'tcard-show-qr')[0];
  assert.equal(show.textContent, 'Show QR code');
  assert.equal(all(card, 'tcard-qr')[0].hidden, true, 'the QR code is out before it is asked for');
  fire(show, 'click');
  await settle();
  assert.deepEqual(drawn, [[DEPOSIT_ADDRESS, 128]]);
  assert.equal(all(card, 'tcard-qr')[0].hidden, false);
  assert.equal(show.textContent, 'Hide QR code');
  assert.deepEqual(world.opened, [], 'the card opened the deposit dialog as well');
});

/* The agent's card waits for the same tick Add money asks for, every time (Karim, 2026-09-25):
   the token list and the acknowledgement first, the address only after Show the address. */
test('the deposit card shows no address until the tick and Show the address, then the address well', async () => {
  const { world, picked, destroyed } = depositWorld({ verified: true, networks: [{ id: 'base', words: 'Base', address: DEPOSIT_ADDRESS, memo: null, accepts: [] }] });
  world.ask('deposit usdc on base');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: { chain: 'base', asset: 'USDC' }, data: DEPOSIT_DATA });
  const card = world.cardNodes('deposit')[0];
  await settle();
  assert.equal(picked.length, 1, 'the card did not draw the token list');
  assert.equal(picked[0].context, 'chat');
  assert.equal(picked[0].stage, 'tokens', 'the card did not open on the token list');
  assert.equal(picked[0].network, 'base');
  assert.equal(picked[0].symbol, 'USDC');
  assert.equal(typeof picked[0].onAddress, 'function', 'the list does not hand the address back to the card');
  assert.equal(all(card, 'netpick').length, 1);
  assert.equal(all(card, 'deposit-address').length, 0, 'the address is on the card before the tick');
  assert.equal(all(card, 'tcard-copy').length, 0, 'a Copy before the tick');
  assert.equal(all(card, 'tcard-place')[0].hidden, false, 'the ends went before the address came');

  // Show the address without the tick does nothing.
  const go = all(card, 'btn').find((b: Any) => b.dataset.role === 'show-address');
  assert.equal(go.disabled, true);
  fire(go, 'click');
  assert.equal(all(card, 'deposit-address').length, 0, 'the address came without the tick');

  acknowledge(card);
  assert.equal(destroyed(), 1, 'the token list was left running under the address');
  assert.equal(all(card, 'netpick').length, 0, 'the token list stayed on the card');
  const well = all(card, 'deposit-address')[0];
  assert.ok(well, 'no address well after the tick');
  assert.equal(well.textContent, DEPOSIT_ADDRESS);
  assert.equal(all(card, 'tcard-copy').length, 1);
  assert.equal(all(card, 'tcard-place')[0].hidden, true);
  assert.deepEqual(world.opened, [], 'the card opened the deposit dialog as well');
});

test('the deposit card\'s word follows its own watch and goes quiet when another one runs', async () => {
  const { world } = depositWorld({ verified: true, networks: [{ id: 'base', address: DEPOSIT_ADDRESS }] });
  world.ask('deposit usdc on base');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: {}, data: DEPOSIT_DATA });
  const card = world.cardNodes('deposit')[0];
  const word = () => all(card, 'tcard-state')[0];
  const frame = (over: Any) => ({ phase: 'watching', chain: 'base', symbol: 'USDC', address: DEPOSIT_ADDRESS, startedAt: new Date().toISOString(), ...over });
  world.deposit(frame({ phase: 'seen' }));
  assert.equal(word().textContent, 'Arriving');
  world.deposit(frame({ phase: 'credited' }));
  assert.equal(word().textContent, 'In your balance');
  world.deposit(frame({ chain: 'arb' }));
  assert.equal(word().hidden, true, 'a watch on another network speaks for this card');

  // A card drawn again from a stored conversation is older than any watch running now.
  const old = build();
  old.ask('deposit usdc on base');
  old.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: {}, data: DEPOSIT_DATA, at: Date.parse('2026-09-01T10:00:00Z') });
  old.deposit(frame({}));
  assert.equal(all(old.cardNodes('deposit')[0], 'tcard-state')[0].hidden, true, 'an old card says Watching');
  await settle();
});

test('the deposit card draws no address it cannot vouch for, and says why', async () => {
  // The wallet is not open: the address shows in Add money, one press away.
  const locked = depositWorld({ verified: false, networks: [{ id: 'base', address: DEPOSIT_ADDRESS }] });
  locked.world.ask('deposit usdc on base');
  locked.world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: {}, data: DEPOSIT_DATA });
  await settle();
  let card = locked.world.cardNodes('deposit')[0];
  assert.equal(all(card, 'deposit-address').length, 0);
  assert.ok(card.textContent.includes('The whole address shows once the wallet is open.'), card.textContent);
  const open = all(card, 'tcard-open')[0];
  assert.equal(open.textContent, 'Open in Add money');
  fire(open, 'click');
  assert.equal(JSON.stringify(locked.world.opened), JSON.stringify([{ chain: 'base', symbol: 'USDC' }]));

  // The wallet reports another address than the one the agent was told: nothing, and no way on.
  const other = depositWorld({ verified: true, networks: [{ id: 'base', address: '0x99ab5c7d9e0f1a2b3c4d5e6f708192a3b4c59fe2' }] });
  other.world.ask('deposit usdc on base');
  other.world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: {}, data: DEPOSIT_DATA });
  await settle();
  card = other.world.cardNodes('deposit')[0];
  assert.equal(all(card, 'deposit-address').length, 0, 'an address with other ends was drawn');
  assert.ok(card.textContent.includes('This address is not the one your agent was given, so nothing is shown.'), card.textContent);
  assert.equal(all(card, 'tcard-open').length + all(card, 'tcard-copy').length + all(card, 'tcard-show-qr').length, 0);

  // The wallet file was edited.
  const edited = depositWorld({ verified: true, tampered: true, networks: [{ id: 'base', address: DEPOSIT_ADDRESS }] });
  edited.world.ask('deposit usdc on base');
  edited.world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: {}, data: DEPOSIT_DATA });
  await settle();
  card = edited.world.cardNodes('deposit')[0];
  assert.equal(all(card, 'deposit-address').length, 0);
  assert.ok(card.textContent.includes('has been edited'), card.textContent);
});

test('a refused deposit says the reason and nothing else', () => {
  const world = build();
  world.ask('deposit');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: {}, data: { ok: false, reason: 'chain must be one of eth, base, arb, sol, near (got nothing).', accepted: [] } });
  const card = world.cardNodes('deposit')[0];
  assert.ok(card.textContent.includes('chain must be one of'), card.textContent);
  assert.equal(all(card, 'tcard-open').length, 0, 'a button to open a card that cannot open');
});

test('any other whitelisted answer is two columns of facts, numbers set as figures', () => {
  const world = build();
  world.ask('can I swap btc?');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__swap_check', input: {}, data: { ok: true, coins: ['BTC', 'ETH'], count: 2, screen: { view: 'basic' } } });
  const card = world.cardNodes('kv')[0];
  assert.ok(card, 'no facts card');
  const keys = all(card, 'tcard-kv-key').map((k) => k.textContent);
  assert.deepEqual(keys, ['coins', 'count'], 'ok and screen are noise, not facts');
  const values = all(card, 'tcard-kv-value');
  assert.equal(values[0].textContent, 'BTC, ETH');
  assert.ok(values[1].className.split(' ').includes('num'), 'a number not set as a figure');
});

test('a data card opens by default and stays where the person left it', () => {
  const world = build();
  world.ask('balance');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
  const card = world.cardNodes('balance')[0];
  assert.equal(card.getAttribute('data-open'), 'true');
  fire(all(card, 'tcard-head')[0], 'click');
  assert.equal(card.getAttribute('data-open'), 'false');
  world.emit({ kind: 'text', text: 'You hold $29.60.' });
  assert.equal(world.cardNodes('balance')[0].getAttribute('data-open'), 'false');
});

/* TOOL STEPS LEAVE THE THREAD. They are kept for developer mode (ui/design/devmode.css shows
   [data-dev-only]), fold to their names when the turn ends, and count no seconds: the figure was
   the gap between frames arriving, noise and sometimes false. */
test('a turn\'s calls are developer mode\'s alone, and they name themselves without a clock', () => {
  const world = build();
  world.ask('what do I hold');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__wallet', ok: true });
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: { product: 'BTC-USD' } });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  const steps = all(world.host, 'steps-block');
  assert.ok(steps.length >= 1);
  for (const block of steps) assert.equal(block.getAttribute('data-dev-only'), '', 'a step row shows outside developer mode');
  const fold = all(world.host, 'steps-fold')[0];
  assert.equal(all(fold, 'steps-fold-label')[0].textContent, '2 steps');
  assert.equal(all(fold, 'steps-fold-names')[0].textContent, 'reading your wallet, reading the chart');
  assert.doesNotMatch(world.host.textContent, /\d+\.\d s|\b\d+ s\b/, 'a stopwatch is left in the thread');
});

test('the assistant\'s reply is bare words: no mark, no clock, no bubble', () => {
  const world = build();
  world.ask('hi');
  world.emit({ kind: 'text', text: 'Hello.', at: Date.UTC(2026, 8, 15, 14, 2) });
  const reply = all(world.host, 'chat-reply')[0];
  assert.equal(all(reply, 'chat-mark').length, 0, 'the reply wears the mark');
  assert.equal(all(reply, 'chat-time').length, 0, 'the reply carries a clock');
  assert.equal(all(reply, 'chat-text')[0].textContent, 'Hello.');
});

test('the composer: Enter sends, Shift+Enter does not, Escape lets go, and the arrow is out while the box is empty', () => {
  const world = build();
  const send = world.send();
  assert.equal(send.disabled, true, 'an empty box has a live send button');
  world.input.value = 'read the chart';
  fire(world.input, 'input');
  assert.equal(send.disabled, false, 'words in the box and the button is still out');
  fire(world.input, 'keydown', { key: 'Enter', shiftKey: true });
  assert.equal(world.actions.includes('prompt'), false, 'Shift+Enter sent the message');
  world.input.focused = true;
  fire(world.input, 'keydown', { key: 'Escape' });
  assert.equal(world.input.focused, false, 'Escape did not let go of the box');
  assert.equal(world.input.value, 'read the chart', 'Escape threw the draft away');
  fire(world.input, 'keydown', { key: 'Enter' });
  assert.equal(world.actions.includes('prompt'), true, 'Enter did not send');
  assert.equal(world.input.value, '');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: {} });
  assert.equal(send.disabled, false, 'the stop button is out while an answer runs');
  assert.equal(world.input.placeholder, 'Ask, or tell it what to do');
});

test('cards.js builds nothing that decides anything and writes no markup', () => {
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(CARDS_SOURCE), false, 'cards.js writes markup');
  const buttons = CARDS_SOURCE.match(/dom\.el\('button'[^\n]*/g) ?? [];
  assert.deepEqual(buttons.map((b) => b.trim()), [
    "dom.el('button', 'btn btn-quiet btn-sm tcard-copy');",
    "dom.el('button', 'tcard-details-head');",
    "dom.el('button', 'mcard-details-toggle');",
    "dom.el('button', 'btn btn-quiet btn-sm tcard-show-qr');",
    "dom.el('button', 'btn btn-quiet btn-sm tcard-copy');",
    "dom.el('button', 'btn btn-ghost btn-sm tcard-open');",
  ], 'an unknown button site in cards.js');
  /* Every money figure the move card draws goes through the roll. */
  assert.ok((CARDS_SOURCE.match(/dom\.setNumber\(/g) ?? []).length >= 2, 'the card sets its figures without the roll');
});

test('a chain_address answer is a small data block through the facts card, and its developer row says the call left the machine', () => {
  const world = build();
  world.ask('who is this address');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chain_address', input: { network: 'ethereum', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' } });
  const step = all(world.host, 'step')[0];
  assert.ok(step, 'no step row');
  assert.equal(all(step, 'step-leaves')[0].textContent, 'leaves this computer', 'a chain read did not say it left the machine');
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__chain_address', ok: true });
  world.emit({
    kind: 'tool_data',
    name: 'mcp__phosphor__chain_address',
    input: { network: 'ethereum', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
    data: {
      network: 'ethereum', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', ok: true, txCount: 1842,
      balance: { amount: '0.51', symbol: 'ETH' }, isContract: false, lastSeen: '2026-09-12T10:00:00Z', source: 'eth.blockscout.com',
      tokens: [{ symbol: 'USDC', amount: '12.5' }, { symbol: 'DAI', amount: '3' }],
    },
  });
  const card = world.cardNodes('kv')[0];
  assert.ok(card, 'no facts card was drawn for chain_address');
  const keys = all(card, 'tcard-kv-key').map((n) => n.textContent);
  const values = all(card, 'tcard-kv-value');
  const value = (key: string): Any => values[keys.indexOf(key)];
  assert.equal(value('address').textContent, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  assert.equal(value('tx count').textContent, '1842');
  assert.ok(value('tx count').className.split(' ').includes('num'), 'the count is not set as a figure');
  assert.equal(value('tokens').textContent, '2 items');
});

test('a read on the way to a move leaves no card of its own, and one turn draws at most one read card', () => {
  const world = build();
  world.ask('how is the account, then swap 2 usdc to sol');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__trade_read', input: {}, data: BOOK });
  assert.equal(world.cardNodes('position').length, 1, 'the read drew its card before the move');
  const filed = withView({ id: 'r1', kind: 'swap', status: 'pending', createdAt: '2026-09-20T10:00:00Z', draft: { ...SWAP_DRAFT, fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 }, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' } });
  world.emit({ kind: 'tool', name: 'mcp__phosphor__propose_swap', input: { fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2 } });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__propose_swap', ok: true });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 }, data: filed });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__trade_read', input: {}, data: BOOK });
  assert.equal(world.cardNodes('position').length, 1, 'a read under the move drew a second card');
  assert.equal(world.cardNodes('move').length, 1);
  world.emit({ kind: 'turn_end', error: false, turns: 1 });

  world.ask('what do I hold and how is the account');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__trade_read', input: {}, data: BOOK });
  assert.equal(world.cardNodes('balance').length, 0, 'two read cards in one turn');
  assert.equal(world.cardNodes('position').length, 2);
  assert.equal(world.cardNodes('move').length, 1, 'the move card from the turn before was touched');
});

/* THE MOVE LIVES IN THE THREAD, WHOEVER MADE IT. There is no dock, so a row this conversation
   never proposed (another client over MCP, a helper) gets its card at the thread's end from the
   state frame, and a row waiting on the person always has one: its card is the only place its
   Approve lives. A decided row from before this window opened is Activity's, not the thread's. */
test('a move made elsewhere gets its card from the state frame, and a waiting one always has one', async () => {
  const world = build();
  /* Rows get cards once the stored chat has been read back, after whatever it already drew; and
     a row made "now" has to be later than the window's own start (agent.js bootAt), which one
     immediate could leave in the same millisecond. */
  await new Promise((resolve) => setTimeout(resolve, 2));
  const now = new Date().toISOString();
  const older = new Date(Date.now() - 3_600_000).toISOString();
  const row = (id: string, status: string, createdAt: string, extra: Record<string, unknown> = {}) => withView({
    id, kind: 'swap', status, createdAt, draft: { ...SWAP_DRAFT, quote: { amountOut: 4.98, feeUsd: 0.02, timeEstimateSec: 5 } },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' }, ...extra,
  });
  world.proposals([
    row('old-done', 'executed', older, { decidedAt: older, settledAt: older, result: { ok: true, detail: 'done' } }),
    row('old-wait', 'pending', older),
    row('new-run', 'executing', now, { decidedAt: now, decidedBy: 'policy' }),
  ]);
  const ids = world.cardNodes('move').map((c: Any) => c.id);
  assert.deepEqual(ids, ['card-proposal-old-wait', 'card-proposal-new-run'], ids.join(' | '));
  assert.equal(all(world.cardNodes('move')[0], 'mcard-approve').length, 1, 'the waiting row\'s card cannot be answered');
  /* The same frame again draws nothing new. */
  world.proposals([row('old-wait', 'pending', older), row('new-run', 'executing', now, { decidedAt: now, decidedBy: 'policy' })]);
  assert.equal(world.cardNodes('move').length, 2);
});

/* A card read back from the stored chat says pending forever; until a frame lists its row as
   waiting it asks nothing, and a frame that lists it decided says it is no longer waiting. */
test('a stored card asks nothing until the live frame says its row still waits', async () => {
  const world = build();
  const row = withView({ id: 'st1', kind: 'swap', status: 'pending', createdAt: '2026-09-20T10:00:00Z', draft: SWAP_DRAFT, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' } });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: {}, data: row });
  world.proposals([]);
  const card = world.cardNodes('move')[0];
  assert.equal(all(card, 'mcard-approve').length, 0, 'a reply no frame has confirmed asks');
  world.proposals([row]);
  assert.equal(all(card, 'mcard-approve').length, 1, 'the frame\'s row did not ask');
  world.proposals([withView({ ...row, status: 'refused', decidedBy: 'human' })]);
  assert.equal(all(card, 'mcard-approve').length, 0);
  assert.equal(stateWord(card), 'Cancelled');
});

test('a send names its receiver whole on the face while the person decides', () => {
  const world = build();
  const to = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
  const draft = { kind: 'intents_pay', symbol: 'USDC', originAsset: 'nep141:eth-usdc', network: 'eth', amount: 25, amountUsd: 25, minReceived: 24.6, from: '0x1', to, toChecksum: 'valid', counterparty: 'intents.near', recipient: { known: false, count: 0, lastAt: null, ownAddress: false } };
  const filed = withView({ id: 's1', kind: 'intents_pay', status: 'pending', createdAt: '2026-09-20T10:00:00Z', draft, verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: { ok: true, summary: 'pay', send: { arrives: '24.7', arrivesAtLeast: '24.6', feeUsd: 0.3, etaSeconds: 60, explorer: 'https://etherscan.io/address/' + to, activity: 'This address has never been used on Ethereum.' } } });
  const reply = { id: 's1', status: 'pending', verdict: filed.verdict, simulation: filed.simulation, view: filed.view,
    send: { kind: 'intents_pay', where: 'eth', to, symbol: 'USDC', amount: 25, amountUsd: 25, recipient: { known: false, count: 0, lastAt: null, ownAddress: false } } };
  /* The argument spells the address in lowercase; the card shows the reply's own spelling. */
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_send', input: { amount: 25, symbol: 'USDC', to: to.toLowerCase(), where: 'eth', confirmed: true }, data: reply });
  world.proposals([filed]);
  const card = world.cardNodes('move')[0];
  assert.equal(stateWord(card), 'Needs your OK');
  /* A payout names the chain it lands on (hunt A, 2026-09-23): the same address on another
     chain is somebody else's money. */
  assert.match(faceOf(card), /^25 USDC 0xAbCdEf...ABCDEF01 on Ethereum/, faceOf(card));
  const address = all(card, 'mcard-address-line')[0];
  assert.ok(address, 'no address on the face');
  assert.equal(address.getAttribute('data-address'), to);
  assert.equal(all(address, 'tcard-leg-group').map((g: Any) => g.textContent).join(''), to, 'the address is not whole');
  /* "0x" and then ten groups of four, so the groups start where the address does; the first
     and the last, the ones a person checks, are in the text colour and the rest a step quieter,
     as Add money prints an address. */
  const groups = all(address, 'tcard-leg-group');
  assert.deepEqual(groups.slice(0, 3).map((g: Any) => g.textContent), ['0x', 'AbCd', 'Ef01']);
  assert.equal(groups.length, 11);
  assert.deepEqual(all(address, 'addr-end').map((g: Any) => g.textContent), ['AbCd', 'EF01']);
  assert.deepEqual(all(address, 'addr-prefix').map((g: Any) => g.textContent), ['0x']);
  assert.equal(all(address, 'addr-mid').length, 8);
  assert.ok(faceOf(card).includes('An Ethereum address. First send to this address.'), faceOf(card));
  assert.equal(all(card, 'tcard-copy').filter((b: Any) => all(b, 'btn-label')[0]).length >= 1, true, 'no Copy on the address');
  assert.equal(all(card, 'tcard-leg-explorer').length, 1, 'no explorer link on the address');
  assert.match(faceOf(card), /You send 25 USDC They get at least 24\.6 USDC Fee \$0\.30/);
  assert.ok(faceOf(card).includes('First send to this address.'), faceOf(card));
  const lines = detailsOf(card);
  assert.ok(lines.some((t) => t === 'This address first send'), lines.join(' | '));
  assert.ok(lines.some((t) => t.includes('never been used on Ethereum')), lines.join(' | '));
});

/* A named account is its own check: alice.near is whole in the card's head, so the face does not
   print it a second time as a block of groups; the first-send line stays. */
test('a send to a named account is not printed twice, and still says it is the first send', () => {
  const world = build();
  const to = 'alice.near';
  const draft = { kind: 'intents_send', symbol: 'USDC', amount: 5, amountUsd: 5, from: 'you.near', to, counterparty: 'intents.near', recipient: { known: false, count: 0, lastAt: null, ownAddress: false } };
  const filed = withView({ id: 'n1', kind: 'intents_send', status: 'pending', createdAt: '2026-09-20T10:00:00Z', draft, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'send', send: { arrives: '5', arrivesAtLeast: '5', feeUsd: 0, etaSeconds: 5 } } });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_send', input: { amount: 5, symbol: 'USDC', to }, data: { id: 'n1', status: 'pending', verdict: filed.verdict, simulation: filed.simulation, view: filed.view } });
  world.proposals([filed]);
  const card = world.cardNodes('move')[0];
  assert.match(faceOf(card), /^5 USDC alice\.near/, faceOf(card));
  assert.equal(all(card, 'mcard-address-line').length, 0, 'the named account is printed twice');
  assert.ok(faceOf(card).includes('First send to this address.'), faceOf(card));
  assert.equal(faceOf(card).includes(' on '), false, 'a send inside NEAR Intents names a chain');
});

test('a late move says it is late with the minutes, and a held one says what it waits on', () => {
  const world = build();
  const late = withView({ id: 'l1', kind: 'hl_deposit', status: 'needs_reconciliation', createdAt: '2026-09-20T10:00:00Z', decidedAt: '2026-09-20T10:00:10Z', decidedBy: 'human', lastChangeAt: '2026-09-20T10:01:00Z', stalledAt: '2026-09-20T10:21:00Z',
    draft: { kind: 'hl_deposit', symbol: 'USDC', originAsset: 'nep141:eth-usdc', amount: 7.5425, amountUsd: 7.5425, minCredited: 5, from: '0x1', hlAccount: '0x1', counterparty: 'hypercore' },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: null,
    result: { ok: false, detail: 'polling', txids: ['0xintent'], evidence: { providerStage: 'PROCESSING', handle: 'h1' } } }, Date.parse('2026-09-20T10:23:00Z'));
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'l1' }, data: late.view });
  const card = world.cardNodes('move')[0];
  assert.equal(card.getAttribute('data-state'), 'working');
  assert.equal(card.getAttribute('data-late'), 'true');
  assert.match(stateWord(card), /^Taking longer · \d+(m|h \d\dm)$/);
  assert.ok(!faceOf(card).includes('PROCESSING'), 'the vendor word in capitals: ' + faceOf(card));
  assert.ok(!faceOf(card).includes('2026-09-20T'), 'an ISO stamp on the card');

  const held = withView({ id: 'h1', kind: 'hl_deposit', status: 'approved', heldSince: new Date(Date.now() - 30_000).toISOString(), createdAt: '2026-09-20T10:00:00Z', decidedAt: new Date(Date.now() - 30_000).toISOString(), decidedBy: 'human',
    draft: { kind: 'hl_deposit', symbol: 'USDC', originAsset: 'nep141:eth-usdc', amount: 7.5425, amountUsd: 7.5425, minCredited: 5, from: '0x1', hlAccount: '0x1', counterparty: 'hypercore' },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: null });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'h1' }, data: held });
  const holding = world.cardNodes('move')[1];
  assert.equal(stateWord(holding), 'Waiting to start');
  assert.ok(faceOf(holding).includes('Nothing is signed until'), faceOf(holding));
});

/* A working move shows no clock at all until it is late: its only sign of time is the track. */
test('a working move shows no elapsed time until it runs past its usual time', () => {
  const world = build();
  const row = withView({ id: 'w9', kind: 'swap', status: 'executing', createdAt: new Date(Date.now() - 5_000).toISOString(), decidedAt: new Date(Date.now() - 5_000).toISOString(), decidedBy: 'policy',
    draft: SWAP_DRAFT, verdict: { outcome: 'allow', reasons: [] }, simulation: { ok: true, summary: 'swap' }, result: { ok: true, detail: 'sent', evidence: { providerStage: 'PENDING' } } });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'w9' }, data: row });
  const card = world.cardNodes('move')[0];
  assert.equal(stateWord(card), 'Swapping');
  assert.equal(card.getAttribute('data-late'), null);
  assert.doesNotMatch(faceOf(card), /\d+s\b|of about/, 'a clock on a move that is on time: ' + faceOf(card));
  assert.equal(all(card, 'mcard-track').length, 1, 'no track under a working move');
  /* While it runs, nothing of the rail's own line is printed, even for a developer. */
  assert.equal(detailsOf(card).some((t) => t.startsWith('The full record')), false, detailsOf(card).join(' | '));
  assert.equal(detailsOf(card).some((t) => t.includes('turned it down')), false);
});

test('a fee of nothing says No fee, quietly, never a bold $0.00', () => {
  const world = build();
  const row = withView({ id: 'f0', kind: 'swap', status: 'pending', createdAt: '2026-09-20T10:00:00Z', draft: SWAP_DRAFT, verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: { ok: true, summary: 'swap', swap: { receives: '4.98', receivesAtLeast: '4.9', feeUsd: 0, etaSeconds: 5 } } });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: {}, data: row });
  const card = world.cardNodes('move')[0];
  const fee = all(card, 'mcard-fact').find((n: Any) => all(n, 'mcard-fact-label')[0].textContent === 'Fee');
  assert.ok(fee, 'the fee is not on the card: ' + faceOf(card));
  assert.equal(all(fee, 'mcard-fact-value')[0].textContent, 'No fee');
  assert.equal(all(fee, 'mcard-fact-value')[0].getAttribute('data-quiet'), 'true');
  assert.equal(faceOf(card).includes('$0.00'), false, faceOf(card));
});

test('an over-the-line relay swap keeps how long its price holds in its Details while it waits', () => {
  const world = build();
  const row = (status: string) => withView({
    id: 'q1', kind: 'swap', status, createdAt: '2026-09-20T10:00:00Z',
    draft: { ...SWAP_DRAFT, venue: 'intents-relay', fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 500, amountUsd: 500, minAmountOut: 0.1085 },
    verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: { ok: true, summary: 'swap', swap: { receives: '0.1106', receivesAtLeast: '0.1085', feeUsd: 0.5, etaSeconds: 45, priceGoodForSec: 60 } },
  });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: {}, data: row('pending') });
  const card = world.cardNodes('move')[0];
  assert.ok(detailsOf(card).includes('Price good for about a minute, checked again when you approve.'), detailsOf(card).join(' | '));
  world.proposals([row('approved')]);
  assert.equal(detailsOf(card).some((t) => t.startsWith('Price good for')), false, 'the price line outlived the wait for the click');
});

test('a Hyperliquid move asks with its floor once, and lands with what arrived', () => {
  const world = build();
  const draft = { kind: 'hl_withdraw', symbol: 'USDC', amount: 20, amountUsd: 20, minReceived: 19.67, from: '0x1', to: '0x1', counterparty: 'hypercore-withdraw' };
  const row = (status: string, extra: Record<string, unknown> = {}) => withView({
    id: 'w2', kind: 'hl_withdraw', status, createdAt: '2026-09-20T10:00:00Z', draft, verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: { ok: true, summary: 'withdraw', send: { arrives: '19.75', arrivesAtLeast: '19.67', feeUsd: 0.25, etaSeconds: 180 } }, ...extra,
  });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_hl_withdraw', input: { amount: 20 }, data: row('pending') });
  const card = world.cardNodes('move')[0];
  assert.match(faceOf(card), /^20 USDC your balance Needs your OK/);
  assert.match(faceOf(card), /You move 20 USDC Arrives at least 19\.67 USDC Fee \$0\.25/);
  assert.equal((faceOf(card).match(/19\.67/g) || []).length, 1, 'the floor is printed twice');

  world.proposals([row('executed', { decidedAt: '2026-09-20T10:00:20Z', decidedBy: 'human', settledAt: '2026-09-20T10:03:00Z',
    result: { ok: true, detail: 'done', txids: ['abc'], evidence: { settledAmountOut: '19.72' } } })]);
  assert.equal(card.getAttribute('data-state'), 'done');
  assert.ok(!faceOf(card).includes('19.75'), 'the quote outlived the settlement: ' + faceOf(card));
});

/* THE ONE THING WAITING. A card that needs the person, scrolled out of view, is one quiet line
   above the box, and the line takes them to it: the card in the middle of the column, the focus
   on the card and never on a button. Latest steps aside while it is up. */
test('a waiting card out of view is one soft key above the box that names the move, and it takes the person to it', () => {
  const world = build();
  const row = withView({ id: 'wt1', kind: 'swap', status: 'pending', createdAt: new Date().toISOString(), draft: SWAP_DRAFT, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' } });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: {}, data: row });
  world.proposals([row]);
  const list = all(world.host, 'transcript')[0];
  list.clientHeight = 400;
  list.scrollHeight = 2000;
  list.scrollTop = 1600;
  list.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400 });
  const card = world.cardNodes('move')[0];
  const rowNode = card.parentNode;
  /* The card sits 600 px above the top of the scroller's box. */
  rowNode.getBoundingClientRect = () => ({ top: -500, bottom: -380, height: 120 });
  fire(list, 'scroll');
  const waitLine = all(world.composerHost, 'agent-waiting')[0];
  assert.ok(waitLine, 'no waiting line');
  assert.equal(waitLine.hidden, false, 'the line is not up for a card out of view');
  assert.equal(all(world.host, 'jump-latest')[0].getAttribute('data-on'), null, 'Latest is up beside the waiting line');
  /* The line names the move that waits (hunt A, 2026-09-23: a grey "Waiting for your OK" was
     the only sign money waited on the person). */
  assert.equal(all(waitLine, 'agent-waiting-words')[0].textContent, 'Your swap waits for your OK');
  fire(waitLine, 'click');
  assert.equal(list.scrollTop, 1600 - 600 - 140, 'the card is not brought to the middle of the column');
  assert.equal(card.focused, true, 'the focus is not on the card');
  /* In view, the line goes. */
  rowNode.getBoundingClientRect = () => ({ top: 240, bottom: 360, height: 120 });
  fire(list, 'scroll');
  assert.equal(waitLine.hidden, true);
});
