// The cards the conversation draws from a tool's answer, and the shell every one of them folds in.
//
// A read used to reach the window as a name and a yes or no, and a person saw the table the
// model typed. Now the driver hands the window the answer (src/driver.ts, tool_data) and
// ui/screens/cards.js draws it: holdings, positions, a move with its status, a deposit
// address. This file drives the real cards.js and the real agent.js over a DOM small enough to
// read, and asserts what a person would see: which card, which figure, in which tone, and that
// every card and every receipt can be closed from its own head line.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM_SOURCE = read('../../ui/core/dom.js');
const MARKDOWN_SOURCE = read('../../ui/core/markdown.js');
const CARDS_SOURCE = read('../../ui/screens/cards.js');
const AGENT_SOURCE = read('../../ui/screens/agent.js');

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
  for (const fn of node.__on[type] ?? []) fn({ preventDefault: () => {}, ...event });
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

function build() {
  const driverHandlers: Array<(frame: unknown) => void> = [];
  const receiptHandlers: Array<(list: unknown[], state: string) => void> = [];
  const busHandlers: Record<string, Array<(payload: unknown) => void>> = {};
  const opened: unknown[] = [];
  const actions: string[] = [];
  const host = make('div');
  const composerHost = make('div');
  const timers: Array<() => void> = [];

  const sandbox: Record<string, unknown> = {
    console,
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
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: () => ({ lineHeight: '21px', paddingTop: '8px', paddingBottom: '8px' }),
    dispatchEvent: () => true,
    PhosphorNet: { readable: (e: Error) => String(e.message) },
    PhosphorShell: { setPending: () => {}, updateField: () => {} },
    PhosphorToast: { show: () => {} },
    PhosphorApi: {
      driver: (body: { action: string }) => { actions.push(body.action); return Promise.resolve({}); },
      driverState: () => Promise.resolve({ data: { state: 'ready', chats: [{ id: 'c1', transcript: [] }] } }),
      connection: () => Promise.resolve({ command: '', connected: [] }),
    },
    PhosphorEvents: {
      on: (type: string, handler: (frame: unknown) => void) => {
        if (type === 'driver') driverHandlers.push(handler);
        else (busHandlers[type] ??= []).push(handler);
      },
    },
    PhosphorReceipts: { onChange: (fn: (list: unknown[], state: string) => void) => { receiptHandlers.push(fn); fn([], 'idle'); }, load: () => {} },
    PhosphorReceipt: {
      chainName: (id: string) => ({ base: 'Base', sol: 'Solana', intents: 'NEAR Intents', hyperliquid: 'Hyperliquid' })[id] ?? id,
      card: (receipt: Any) => {
        const node = make('div');
        node.className = 'receipt-card';
        node.setAttribute('data-inline', 'true');
        node.textContent = String(receipt.headline ?? '');
        return node;
      },
    },
    PhosphorIcons: { svg: (name: string, className: string) => { const n = make('svg'); n.className = 'icon ' + (className || ''); n.setAttribute('data-icon', name); return n; } },
    PhosphorMarks: { logo: (symbol: string) => { const n = make('span'); n.className = 'logo'; n.setAttribute('data-token', String(symbol).toUpperCase()); return n; } },
    PhosphorMotion: { reduced: () => false, spring: () => 'linear' },
    PhosphorState: { select: () => () => {} },
    PhosphorDeposit: { open: (opts: unknown) => { opened.push(opts); return Promise.resolve(null); } },
  };
  sandbox.window = win;
  sandbox.CustomEvent = function CustomEventStub(this: Any, type: string, init: Any) { this.type = type; this.detail = init?.detail; };
  createContext(sandbox);
  runInContext(DOM_SOURCE, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(MARKDOWN_SOURCE, sandbox, { filename: 'ui/core/markdown.js' });
  runInContext(CARDS_SOURCE, sandbox, { filename: 'ui/screens/cards.js' });
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
    emit,
    input,
    composer,
    actions,
    opened,
    cards: win.PhosphorCards as Any,
    ask(text: string) { input.value = text; fire(composer, 'submit'); },
    receipts: (list: unknown[]) => { for (const handler of receiptHandlers) handler(list, 'ready'); },
    bus: (type: string, payload: unknown) => { for (const handler of busHandlers[type] ?? []) handler(payload); },
    blocks: () => all(host, 'transcript')[0].children as Any[],
    cardNodes: (kind?: string) => byAttr(host, 'data-card', kind),
    send: () => all(composerHost, 'composer-send')[0],
  };
}

const BALANCES = {
  totalUsd: 29.6,
  holdings: [
    { chain: 'base', symbol: 'USDC', amount: 25.9, usd: 25.9, native: false },
    { chain: 'sol', symbol: 'SOL', amount: 0.02, usd: 3.7, native: true },
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

function receipt(id: string, at: number): Record<string, unknown> {
  return { id, kind: 'swap', status: 'executed', at: new Date(at).toISOString(), headline: `Swapped for ${id}`, amount: 0.049, symbol: 'SOL', fromChain: 'intents', toChain: 'intents' };
}

test('kindFor names the card by the tool, prefix or not, and falls back to the facts card', () => {
  const world = build();
  const kindFor = world.cards.kindFor as (name: string, data?: unknown) => string;
  assert.equal(kindFor('mcp__phosphor__wallet'), 'balance');
  assert.equal(kindFor('balances'), 'balance');
  assert.equal(kindFor('trade_read'), 'position');
  assert.equal(kindFor('mcp__phosphor__trade_batch'), 'position');
  assert.equal(kindFor('propose_swap'), 'move');
  assert.equal(kindFor('mcp__phosphor__propose_trade'), 'move');
  assert.equal(kindFor('proposal_status'), 'move');
  assert.equal(kindFor('deposit'), 'deposit');
  assert.equal(kindFor('watch', { chain: 'base', asset: 'USDC', watching: 'watching' }), 'deposit');
  assert.equal(kindFor('watch', { ok: true, coins: ['BTC', 'ETH'] }), 'kv');
  assert.equal(kindFor('gas_report'), 'kv');
});

test('a tool_data event draws a card under the steps that produced it, and the next call folds on its own', () => {
  const world = build();
  world.ask('what do I hold');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__balances', input: {} });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__balances', ok: true });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__balances', input: {}, data: BALANCES });
  world.emit({ kind: 'tool', name: 'mcp__phosphor__trade_read', input: {} });
  const kinds = world.blocks().map((b) => b.className);
  assert.deepEqual(kinds, ['chat-row chat-said', 'steps-block', 'chat-card', 'steps-block'], kinds.join(' | '));
  const card = world.cardNodes('balance')[0];
  assert.ok(card, 'no balance card was drawn');
  const text = card.textContent;
  assert.ok(text.includes('USDC') && text.includes('SOL'), text);
  assert.ok(text.includes('$29.60'), 'the total is missing: ' + text);
  assert.equal(byAttr(card, 'data-token', 'USDC').length, 1, 'the USDC row carries no mark');
});

test('an empty wallet says so in words, with the way in', () => {
  const world = build();
  world.ask('balance');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: { rows: [], totalUsd: 0, byChain: {}, stale: [], emptyCount: 12 } });
  const card = world.cardNodes('balance')[0];
  assert.ok(card.textContent.includes('Nothing here yet'), card.textContent);
  assert.ok(card.textContent.includes('deposit address'), card.textContent);
});

test('the position card leads with up or down, tones each side, and lists what closed', () => {
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
  const head = all(card, 'tcard-figure')[0];
  assert.equal(head.textContent, '-$8.00', 'the head figure is not the sum');
  assert.equal(head.getAttribute('data-tone'), 'down');
});

test('a batch read is the same card', () => {
  const world = build();
  world.ask('positions');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__trade_batch', input: {}, data: { results: [{ as: 'p', op: 'positions', positions: BOOK.positions }, { as: 'a', op: 'account', account: BOOK.account }] } });
  const card = world.cardNodes('position')[0];
  assert.equal(all(card, 'tcard-position').length, 2);
});

test('a proposed swap is a pending card that becomes confirmed when read back, and says why when it fails', () => {
  const world = build();
  world.ask('swap 0.05 sol to usdc');
  const input = { chain: 'intents', toChain: 'intents', fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: 0.05, minAmountOut: 4.9 };
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input, data: { id: 'p1', status: 'pending', verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap 0.05 SOL for about 4.98 USDC' } } });
  let card = world.cardNodes('move')[0];
  assert.ok(card, 'no move card');
  let chip = all(card, 'tcard-chip')[0];
  assert.equal(chip.getAttribute('data-state'), 'pending');
  assert.equal(chip.textContent, 'Waiting for you');
  assert.ok(card.textContent.includes('SOL') && card.textContent.includes('USDC'), card.textContent);
  assert.ok(card.textContent.includes('at least 4.9 USDC'), card.textContent);

  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'p1' }, data: {
    id: 'p1', kind: 'swap', status: 'executed', createdAt: '2026-09-15T10:00:00Z', decidedAt: '2026-09-15T10:00:20Z',
    draft: { kind: 'swap', venue: 'intents-native', chain: 'intents', toChain: 'intents', fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: 0.05, amountUsd: 5, minAmountOut: 4.9, quote: { amountOut: 4.98, feeUsd: 0.02, timeEstimateSec: 5 } },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' }, result: { ok: true, detail: 'done', txids: ['abc'] },
  } });
  card = world.cardNodes('move')[1];
  chip = all(card, 'tcard-chip')[0];
  assert.equal(chip.getAttribute('data-state'), 'confirmed');
  assert.equal(chip.textContent, 'Confirmed');
  assert.ok(card.textContent.includes('4.98') && card.textContent.includes('fee $0.02'), card.textContent);

  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input, data: { id: 'p2', status: 'policy_refused', verdict: { outcome: 'refuse', reasons: ['Never more than $50 in one move.'], rule: 'maxPerTransactionUsd' }, simulation: null } });
  card = world.cardNodes('move')[2];
  chip = all(card, 'tcard-chip')[0];
  assert.equal(chip.getAttribute('data-state'), 'failed');
  assert.ok(card.textContent.includes('Never more than $50 in one move.'), 'the reason is not on the card: ' + card.textContent);
});

test('the deposit card names the network, the tail of the address, the watch state, and opens the real card', () => {
  const world = build();
  world.ask('deposit usdc on base');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: { chain: 'base', asset: 'USDC' }, data: {
    ok: true, shownInWindow: true, chain: 'base', network: 'Base', asset: 'USDC', minDeposit: 1, addressFingerprint: '0x12ab...9Xk2', addressVerified: true, memo: null, watching: 'watching',
  } });
  const card = world.cardNodes('deposit')[0];
  assert.ok(card, 'no deposit card');
  assert.ok(card.textContent.includes('Deposit USDC on Base'), card.textContent);
  assert.equal(all(card, 'tcard-tail')[0].textContent, '9Xk2');
  assert.equal(all(card, 'tcard-chip')[0].getAttribute('data-state'), 'watching');
  assert.equal(byAttr(card, 'data-token', 'BASE').length, 1, 'no network mark');
  const button = all(card, 'tcard-open')[0];
  assert.equal(button.textContent, 'Open the deposit card');
  fire(button, 'click');
  assert.equal(JSON.stringify(world.opened), JSON.stringify([{ chain: 'base', symbol: 'USDC' }]));
});

test('a refused deposit says the reason and nothing else', () => {
  const world = build();
  world.ask('deposit');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__deposit', input: {}, data: { ok: false, reason: 'chain must be one of eth, base, arb, sol, near (got nothing).', accepted: [] } });
  const card = world.cardNodes('deposit')[0];
  assert.ok(card.textContent.includes('chain must be one of'), card.textContent);
  assert.equal(all(card, 'tcard-open').length, 0, 'a button to open a card that cannot open');
});

test('any other whitelisted answer is two columns of facts, numbers in mono', () => {
  const world = build();
  world.ask('watch btc');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__watch', input: {}, data: { ok: true, coins: ['BTC', 'ETH'], count: 2, screen: { view: 'basic' } } });
  const card = world.cardNodes('kv')[0];
  assert.ok(card, 'no facts card');
  const keys = all(card, 'tcard-kv-key').map((k) => k.textContent);
  assert.deepEqual(keys, ['coins', 'count'], 'ok and screen are noise, not facts');
  const values = all(card, 'tcard-kv-value');
  assert.equal(values[0].textContent, 'BTC, ETH');
  assert.ok(values[1].className.includes('mono'), 'a number not in mono');
});

test('a receipt folds: the newest opens, the ones before it close, and the head toggles by click and key', () => {
  const world = build();
  world.receipts([receipt('p1', Date.now() + 1000)]);
  let cards = world.cardNodes('receipt');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute('data-open'), 'true', 'the first receipt did not open');
  assert.equal(all(cards[0], 'receipt-card').length, 1, 'the shared card is not inside the shell');

  world.receipts([receipt('p2', Date.now() + 2000), receipt('p1', Date.now() + 1000)]);
  cards = world.cardNodes('receipt');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].getAttribute('data-open'), 'false', 'the older receipt stayed open');
  assert.equal(cards[1].getAttribute('data-open'), 'true', 'the newest receipt is not open');

  const head = all(cards[1], 'tcard-head')[0];
  assert.equal(head.getAttribute('role'), 'button');
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  fire(head, 'click');
  assert.equal(cards[1].getAttribute('data-open'), 'false', 'a click did not close it');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  fire(head, 'keydown', { key: 'Enter' });
  assert.equal(cards[1].getAttribute('data-open'), 'true', 'Enter did not open it');
  fire(head, 'keydown', { key: ' ' });
  assert.equal(cards[1].getAttribute('data-open'), 'false', 'Space did not close it');

  /* A re-render keeps what the person chose. */
  world.emit({ kind: 'text', text: 'Done.' });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  cards = world.cardNodes('receipt');
  assert.equal(cards[1].getAttribute('data-open'), 'false', 'the re-render reopened a card the person closed');
  assert.equal(cards[0].getAttribute('data-open'), 'false');
});

test('a data card opens by default and stays where the person left it', () => {
  const world = build();
  world.ask('balance');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__balances', input: {}, data: BALANCES });
  const card = world.cardNodes('balance')[0];
  assert.equal(card.getAttribute('data-open'), 'true');
  fire(all(card, 'tcard-head')[0], 'click');
  assert.equal(card.getAttribute('data-open'), 'false');
  world.emit({ kind: 'text', text: 'You hold $29.60.' });
  assert.equal(world.cardNodes('balance')[0].getAttribute('data-open'), 'false');
});

test('a folded turn names its calls under the chevron, and lights no dot', () => {
  const world = build();
  world.ask('what do I hold');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__wallet', ok: true });
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: { product: 'BTC-USD' } });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  const fold = all(world.host, 'steps-fold')[0];
  assert.equal(fold.hidden, false);
  assert.ok(all(fold, 'steps-fold-label')[0].textContent.startsWith('2 steps'), fold.textContent);
  assert.equal(all(fold, 'steps-fold-names')[0].textContent, 'reading your wallet, reading the chart');
  assert.equal(all(fold, 'steps-chevron').length, 1, 'no chevron on the fold');
  assert.equal(all(fold, 'step-dot').length, 0, 'a dot on the fold');
});

test('a reply carries the mark and the clock it landed at', () => {
  const world = build();
  world.ask('hi');
  world.emit({ kind: 'text', text: 'Hello.', at: Date.UTC(2026, 8, 15, 14, 2) });
  const reply = all(world.host, 'chat-reply')[0];
  assert.equal(all(reply, 'chat-mark').length, 1, 'no mark on the reply');
  assert.match(all(reply, 'chat-time')[0].textContent, /^\d\d:\d\d$/);
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
  /* Working: the button is Stop and it is live with an empty box. */
  world.emit({ kind: 'tool', name: 'mcp__phosphor__chart_read', input: {} });
  assert.equal(send.disabled, false, 'the stop button is out while an answer runs');
  assert.equal(world.input.placeholder, 'Ask, or tell it what to do');
});

test('cards.js builds nothing that decides anything and writes no markup', () => {
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(CARDS_SOURCE), false, 'cards.js writes markup');
  const buttons = CARDS_SOURCE.match(/dom\.el\('button'[^\n]*/g) ?? [];
  assert.deepEqual(buttons.map((b) => b.trim()), ["dom.el('button', 'btn btn-ghost btn-sm tcard-open');"], 'an unknown button site in cards.js');
});
