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
import { proposalView } from '../../src/proposals/view.ts';

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
  const sliceHandlers: Record<string, Array<(value: unknown, whole: unknown) => void>> = {};

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
      chainName: (id: string) => ({ eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', sol: 'Solana', intents: 'NEAR Intents', hyperliquid: 'Hyperliquid' })[id] ?? id,
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
    PhosphorState: { select: (key: string, handler: (value: unknown, whole: unknown) => void) => { (sliceHandlers[key] ??= []).push(handler); return () => {}; } },
    PhosphorDeposit: { open: (opts: unknown) => { opened.push(opts); return Promise.resolve(null); } },
    /* The window's one link gate (ui/core/links.js): here every https url passes, so a test
       can see which line became a link. */
    PhosphorLinks: {
      explorerUrl: (url: unknown) => (typeof url === 'string' && url.startsWith('https://') ? url : null),
      setHref: (anchor: Any, url: unknown) => { if (typeof url !== 'string' || !url.startsWith('https://')) return false; anchor.href = url; return true; },
    },
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
    /* A state frame's proposals slice, as ui/core/state.js hands it to whoever selected it. */
    proposals: (list: unknown[]) => { for (const handler of sliceHandlers.proposals ?? []) handler(list, { proposals: list }); },
    blocks: () => all(host, 'transcript')[0].children as Any[],
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

function receipt(id: string, at: number): Record<string, unknown> {
  return { id, kind: 'swap', status: 'executed', at: new Date(at).toISOString(), headline: `Swapped for ${id}`, amount: 0.049, symbol: 'SOL', fromChain: 'intents', toChain: 'intents' };
}

/* A row as the app hands it to the window: with its view beside it, built by the one builder
   (src/proposals/view.ts). A propose reply, a state frame row and `show` all carry it, and the
   card reads its stage word from nowhere else. */
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
  assert.equal(kindFor('watch', { chain: 'base', asset: 'USDC', watching: 'watching' }), 'deposit');
  assert.equal(kindFor('watch', { ok: true, coins: ['BTC', 'ETH'] }), 'kv');
  assert.equal(kindFor('policy_show'), 'kv');
});

test('a tool_data event draws a card under the steps that produced it, and the next call folds on its own', () => {
  const world = build();
  world.ask('what do I hold');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__wallet', ok: true });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
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

test('a wallet holding something the app cannot price never reads as $0.00', () => {
  // Karim's window, 2026-09-20: "What you hold $0.00 ... wNEAR 2.0097 not priced ... Total
  // $0.00" over seven dollars. The row said so; the head and the total did not.
  const world = build();
  world.ask('balance');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: {
    totalUsd: 0, byChain: {}, stale: [], emptyCount: 0, unpriced: ['wNEAR'],
    rows: [{ kind: 'intents', chain: 'intents', symbol: 'wNEAR', quantity: 2.0097, valueUsd: 0, priced: false, native: false }],
  } });
  let card = world.cardNodes('balance')[0];
  assert.equal(all(card, 'tcard-figure')[0].textContent, 'not priced');
  assert.equal(all(card, 'tcard-total-value')[0].textContent, 'not priced');
  assert.ok(card.textContent.includes('wNEAR not priced'), card.textContent);

  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: {
    totalUsd: 7.01, byChain: { intents: 7.01 }, stale: [], emptyCount: 0, unpriced: ['wNEAR'],
    rows: [
      { kind: 'intents', chain: 'intents', symbol: 'USDC', quantity: 7.01, valueUsd: 7.01, priced: true, native: false },
      { kind: 'intents', chain: 'intents', symbol: 'wNEAR', quantity: 2.0097, valueUsd: 0, priced: false, native: false },
    ],
  } });
  /* Two reads in one turn draw one card, the later read's (5.2). */
  assert.equal(world.cardNodes('balance').length, 1, 'a second wallet read in one turn drew a second card');
  card = world.cardNodes('balance')[0];
  assert.equal(all(card, 'tcard-figure')[0].textContent, 'at least $7.01');
  assert.equal(all(card, 'tcard-total-value')[0].textContent, 'at least $7.01');
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

test('a proposed swap is one card, which the read-back updates in place, and a refusal says why', () => {
  // Every move drew twice in the transcript of 2026-09-20: once for the propose, once for the
  // proposal_status the agent read straight after, the same card under "checking the
  // approval". The read updates the card that is already there.
  const world = build();
  world.ask('swap 0.05 sol to usdc');
  const input = { chain: 'intents', toChain: 'intents', fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: 0.05, minAmountOut: 4.9 };
  const filed = { id: 'p1', kind: 'swap', status: 'pending', createdAt: '2026-09-15T10:00:00Z', draft: SWAP_DRAFT, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap 0.05 SOL for about 4.98 USDC', swap: { receives: '4.98', receivesAtLeast: '4.9', feeUsd: 0.02, etaSeconds: 5 } } };
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input, data: withView(filed) });
  let card = world.cardNodes('move')[0];
  assert.ok(card, 'no move card');
  let chip = all(card, 'tcard-state')[0];
  assert.equal(chip.getAttribute('data-state'), 'waiting');
  assert.equal(chip.textContent, 'Waiting for you');
  assert.ok(card.textContent.includes('SOL') && card.textContent.includes('USDC'), card.textContent);
  assert.ok(card.textContent.includes('at least 4.9 USDC'), card.textContent);
  /* The stage line is the table's one sentence for the stage, verbatim, off the view. */
  assert.equal(all(card, 'tcard-stage-copy')[0].textContent, 'Nothing moves until you answer Yes or No in the window.');

  /* proposal_status answers with the view itself, which the card reads as such. */
  const done = withView({ ...filed, status: 'executed', decidedAt: '2026-09-15T10:00:20Z', decidedBy: 'human', settledAt: '2026-09-15T10:00:40Z',
    draft: { ...SWAP_DRAFT, quote: { amountOut: 4.98, feeUsd: 0.02, timeEstimateSec: 5 } }, result: { ok: true, detail: 'done', txids: ['abc'] } });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'p1' }, data: done.view });
  assert.equal(world.cardNodes('move').length, 1, 'the read-back drew a second card for the same move');
  card = world.cardNodes('move')[0];
  chip = all(card, 'tcard-state')[0];
  assert.equal(chip.getAttribute('data-state'), 'confirmed');
  assert.equal(chip.textContent, 'Confirmed');
  assert.ok(card.textContent.includes('4.98') && card.textContent.includes('fee $0.02'), card.textContent);

  const refused = withView({ id: 'p2', kind: 'swap', status: 'policy_refused', createdAt: '2026-09-15T10:01:00Z', decidedAt: '2026-09-15T10:01:00Z', decidedBy: 'policy', draft: SWAP_DRAFT, verdict: { outcome: 'refuse', reasons: ['Never more than $50 in one move.'], rule: 'maxPerTransactionUsd' }, simulation: null });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input, data: refused });
  assert.equal(world.cardNodes('move').length, 2, 'a different move is its own card');
  card = world.cardNodes('move')[1];
  chip = all(card, 'tcard-state')[0];
  assert.equal(chip.getAttribute('data-state'), 'failed');
  assert.equal(chip.textContent, 'Refused');
  assert.ok(card.textContent.includes('Never more than $50 in one move.'), 'the reason is not on the card: ' + card.textContent);
  /* And the next step, from the table: change the rule, in the window. */
  assert.ok(all(card, 'tcard-stage-copy')[0].textContent.includes('Change the rule in the window'), all(card, 'tcard-stage-copy')[0].textContent);
});

test('a move card follows its proposal: the chip moves with the state frame, in place, and a folded card stays folded', () => {
  // Karim, 2026-09-18, with a swap card still reading "Waiting for you" after he had clicked
  // approve and the swap had landed: "i already approved the swap and after approval it shows me
  // this". The card was a snapshot of the propose reply. Now it reads the proposals slice every
  // state frame and redraws itself when its row's status moves.
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
  world.emit({ kind: 'text', text: 'Proposed. It is waiting for your click in the window.' });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.equal(world.cardNodes('move').length, 1);
  const first = world.cardNodes('move')[0];
  assert.equal(all(first, 'tcard-state')[0].textContent, 'Waiting for you');
  assert.equal(all(first, 'tcard-state')[0].getAttribute('data-fade'), null, 'the first paint fades nothing');
  const before = world.blocks().map((b) => b.className);

  // Somebody else's row moves nothing here.
  world.proposals([{ ...row('executed'), id: 'other' }]);
  assert.equal(all(world.cardNodes('move')[0], 'tcard-state')[0].textContent, 'Waiting for you');

  world.proposals([row('awaiting_touch')]);
  let card = world.cardNodes('move')[0];
  assert.equal(card, first, 'the card was rebuilt rather than painted in place');
  assert.equal(all(card, 'tcard-state')[0].textContent, 'Touch ID');
  /* The change is a fade, not a cut: the word and the stage line carry the fade attribute
     the stylesheet animates (ui/design/chatcard.css), alternating so each change restarts it. */
  assert.equal(all(card, 'tcard-state')[0].getAttribute('data-fade'), 'a');
  assert.equal(all(card, 'tcard-stage-copy')[0].getAttribute('data-fade'), 'a');
  assert.equal(all(card, 'tcard-stage-copy')[0].textContent, 'Touch ID is asking for your fingerprint. Nothing moves until you answer it.');
  world.proposals([row('approved')]);
  assert.equal(all(card, 'tcard-state')[0].getAttribute('data-fade'), 'b');
  assert.equal(all(card, 'tcard-state')[0].textContent, 'Signing');
  assert.equal(world.cardNodes('move').length, 1, 'the card was appended rather than redrawn');

  // The settled row carries its view, which is the only place a settle time comes
  // from. The card used to print the decision time under the word "Confirmed at",
  // which is the two-clocks bug this build exists to end.
  const evidence = { providerStage: 'SUCCESS', handle: 'h1', quote: { correlationId: 'corr-9-0123456789abcdef' }, explorerUrl: 'https://nearblocks.io/txns/abc' };
  const settled = row('executed', {
    decidedAt: '2026-09-18T10:36:00Z', decidedBy: 'human', result: { ok: true, detail: 'done', txids: ['abc'], evidence },
    settledAt: '2026-09-18T10:38:10Z', lastChangeAt: '2026-09-18T10:38:10Z',
  });
  world.proposals([settled]);
  card = world.cardNodes('move')[0];
  const chip = all(card, 'tcard-state')[0];
  assert.equal(chip.getAttribute('data-state'), 'confirmed');
  assert.equal(chip.textContent, 'Confirmed');
  assert.ok(card.textContent.includes('0.0178') && card.textContent.includes('fee $0.01'), 'the live draft did not reach the card: ' + card.textContent);
  /* The out leg is the coin bought, inside the pocket it sits in. It read "0.0178 USDC" and
     "to NEAR Intents" off the view's one symbol and its pocket label (Karim, 2026-09-20). */
  const legs = byAttr(card, 'data-leg');
  const out = legs.find((n: Any) => n.getAttribute('data-leg') === 'to');
  assert.ok(out, 'no out leg');
  assert.ok(out.textContent.includes('0.0178 SOL'), out.textContent);
  assert.ok(!out.textContent.includes('about'), 'a confirmed figure is a fact, not an expectation: ' + out.textContent);
  assert.ok(out.textContent.includes('inside NEAR Intents'), out.textContent);
  const lines = all(card, 'tcard-line').map((n: Any) => n.textContent);
  assert.ok(lines.some((t: string) => t.startsWith('Confirmed at')), lines.join(' | '));
  assert.ok(lines.some((t: string) => t.startsWith('You clicked at')), lines.join(' | '));
  assert.equal(lines.filter((t: string) => t.startsWith('Confirmed at')).length, 1);
  /* The vendor's own word never sits on the face of the card, and not even in the fold under
     a word that already says Confirmed (5.4). The reference stays, shortened to its two ends
     with a Copy that carries the whole id (3.1), and the hash is a link where it is now. */
  assert.ok(!card.textContent.includes('SUCCESS'), 'the vendor word is on a confirmed card: ' + card.textContent);
  assert.ok(lines.some((t: string) => t.startsWith('Reference') && t.includes('corr-9-0...89abcdef')), lines.join(' | '));
  assert.ok(!card.textContent.includes('corr-9-0123456789abcdef'), 'the whole id is printed: ' + card.textContent);
  const copies = all(card, 'tcard-copy');
  assert.ok(copies.some((b: Any) => b.getAttribute('aria-label') === 'Copy corr-9-0...89abcdef'), 'no Copy beside the reference');
  assert.ok(all(card, 'tcard-link').some((a: Any) => a.textContent.includes('abc')), 'the hash is not a link: ' + lines.join(' | '));
  assert.ok(!lines.some((t: string) => t.startsWith('Trace')), lines.join(' | '));
  assert.deepEqual(world.blocks().map((b) => b.className), before, 'the redraw moved rows around');
  /* Every line under the facts is inside the one fold, closed until a person opens it. */
  const details = all(card, 'tcard-details')[0];
  assert.ok(details, 'no details fold');
  assert.equal(details.getAttribute('data-open'), 'false');
  assert.ok(all(details, 'tcard-line').length >= 4, 'the checks and the reference are not in the fold');
  assert.equal(all(card, 'tcard-line').length, all(details, 'tcard-line').length, 'a line sits outside the fold');

  const refunded = row('failed', {
    decidedAt: '2026-09-18T10:36:00Z', decidedBy: 'human', result: { ok: false, detail: 'The transfer sent the money back: the quote expired before the deposit landed. {"code":422} intent 0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0', txids: ['abc'], evidence: { ...evidence, providerStage: 'REFUNDED' } },
    settledAt: '2026-09-18T10:40:00Z',
  });
  world.proposals([refunded]);
  const failed = world.cardNodes('move')[0];
  assert.equal(all(failed, 'tcard-state')[0].textContent, 'Failed');
  /* The face carries one plain sentence of why and no code, no brace, no vendor capitals;
     the vendor's word sits in the fold in the app's case, as evidence (3.5, 5.4). */
  const note = all(failed, 'tcard-note-down')[0];
  assert.equal(note.textContent, 'The transfer sent the money back: the quote expired before the deposit landed.');
  assert.ok(!failed.textContent.includes('REFUNDED'), 'the vendor word in capitals: ' + failed.textContent);
  const failedLines = all(failed, 'tcard-details')[0] ? all(all(failed, 'tcard-details')[0], 'tcard-line').map((n: Any) => n.textContent) : [];
  assert.ok(failedLines.some((t: string) => t === 'The transfer calls thisrefunded'), 'the vendor word is not in the fold as evidence: ' + failedLines.join(' | '));
  assert.ok(failedLines.some((t: string) => t.startsWith('What the app recorded') && t.includes('422')), 'the rail line is not kept as evidence: ' + failedLines.join(' | '));
  assert.ok(failedLines.some((t: string) => t.includes('0x9f8e7d...d3c2b1a0')), 'the hash in the rail line is not cut to its ends: ' + failedLines.join(' | '));
  assert.ok(!failed.textContent.includes('0x9f8e7d6c5b4a3928'), 'a whole hash reached the card: ' + failed.textContent);
  /* An address is not a hash: 40 hex characters stay whole in the same line (frozen rule 3), and
     so does a NEAR account name; only a 64-hex hash or a base58 signature is cut. */
  const address = '0xDeAdBeEf00112233445566778899AaBbCcDdEeFf';
  world.proposals([row('failed', {
    decidedAt: '2026-09-18T10:36:00Z', decidedBy: 'human', settledAt: '2026-09-18T10:40:00Z',
    result: { ok: false, detail: `The venue refused the payout to ${address} (alice.near) after intent 0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0 was signed. {"code":422}`, txids: ['abc'], evidence: { ...evidence, providerStage: 'FAILED' } },
  })]);
  const refusedLines = all(all(world.cardNodes('move')[0], 'tcard-details')[0], 'tcard-line').map((n: Any) => n.textContent);
  const recorded = refusedLines.find((t: string) => t.startsWith('What the app recorded')) as string;
  assert.ok(recorded.includes(address), 'the receiver was cut in the evidence line: ' + recorded);
  assert.ok(recorded.includes('alice.near'), recorded);
  assert.ok(recorded.includes('0x9f8e7d...d3c2b1a0') && !recorded.includes('0x9f8e7d6c5b4a3928'), 'the hash was left whole: ' + recorded);

  // The same frame again is nothing new, and a card the person closed stays closed across a redraw.
  const fold = world.cards.foldOf(card);
  fold.setOpen(false);
  world.proposals([settled]);
  assert.equal(world.cards.foldOf(world.cardNodes('move')[0]).isOpen(), false);
  assert.equal(world.cardNodes('move').length, 1);
});

test('a card says who decided: a click is the human\'s, an auto-run is the rules\', a refusal by a rule is nobody\'s click', () => {
  // The transcript of 2026-09-20: three policy refusals and one $7 swap that ran on its own
  // under the ask line all read "You clicked at", on the product whose claim is that the
  // human decides.
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
    view: view({ stage: 'confirmed', stageLabel: 'Confirmed', outcome: 'confirmed', decidedAt: '2026-09-20T22:41:00Z', decidedBy: 'policy', settledAt: '2026-09-20T22:41:15Z' }) })]);
  let lines = all(world.cardNodes('move')[0], 'tcard-line').map((n: Any) => n.textContent);
  assert.ok(lines.some((t: string) => t.startsWith('Your rules allowed it at')), lines.join(' | '));
  assert.ok(!lines.some((t: string) => t.startsWith('You clicked at')), lines.join(' | '));

  world.proposals([row('policy_refused', 'policy', { verdict: { outcome: 'refuse', reasons: ['This swap cannot be valued in dollars.'], rule: 'invalid_amount' },
    view: view({ stage: 'refused', stageLabel: 'Refused', outcome: 'refused', decidedAt: '2026-09-20T22:41:00Z', decidedBy: 'policy', settledAt: '2026-09-20T22:41:00Z', error: { code: 'invalid_amount', message: 'This swap cannot be valued in dollars.' } }) })]);
  lines = all(world.cardNodes('move')[0], 'tcard-line').map((n: Any) => n.textContent);
  assert.ok(!lines.some((t: string) => t.startsWith('You clicked at') || t.startsWith('Your rules allowed')), lines.join(' | '));
  assert.ok(lines.some((t: string) => t.startsWith('Ended at')), lines.join(' | '));
});

test('a floor prints as a quantity, and the out leg of a move that only has a floor says so', () => {
  // Two cards from 2026-09-20: a swap floor of 1.988851425812084254220825 wNEAR printed with
  // all 24 places, and a withdrawal whose out leg was the floor with nothing saying so, while
  // the agent quoted the expected amount, so the person saw two numbers and no reason.
  const world = build();
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 7.0069, minAmountOut: 1.988851425812084254220825 },
    data: { id: 's1', status: 'executing', verdict: { outcome: 'allow', reasons: [] }, simulation: { ok: true, summary: 'swap', swap: { receives: '2.0089', receivesAtLeast: '1.988851425812084254220825', feeUsd: 0.03, etaSeconds: 45 } } } });
  let card = world.cardNodes('move')[0];
  assert.ok(card.textContent.includes('at least 1.98885 wNEAR'), card.textContent);
  assert.ok(!card.textContent.includes('1.988851425812'), card.textContent);

  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_hl_withdraw', input: { amount: 6.209399 },
    data: { id: 'w1', status: 'pending', verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'withdraw' } } });
  world.proposals([{ id: 'w1', kind: 'hl_withdraw', status: 'pending', createdAt: '2026-09-20T22:31:00Z',
    draft: { kind: 'hl_withdraw', symbol: 'USDC', amount: 6.209399, amountUsd: 6.209399, minReceived: 5.934633, from: '0x1', to: '0x1', counterparty: 'hypercore-withdraw' },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'withdraw' } }]);
  card = world.cardNodes('move')[1];
  const out = byAttr(card, 'data-leg').find((n: Any) => n.getAttribute('data-leg') === 'to');
  assert.ok(out, 'no out leg');
  assert.ok(out.textContent.includes('at least 5.93463 USDC'), out.textContent);
  assert.ok(out.textContent.includes('inside NEAR Intents'), out.textContent);
});

test('an "at least" figure never prints above the floor it promises', () => {
  // Review, 2026-09-20: six significant figures rounded half-up, so 5.934637 printed as
  // 5.93464 and the card promised more than the rail holds the venue to.
  const world = build();
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { chain: 'arb', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 7, minAmountOut: 5.934637 },
    data: { id: 'f1', status: 'pending', verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap', swap: { receives: '6', receivesAtLeast: '5.934637', feeUsd: 0.03, etaSeconds: 45 } } } });
  const card = world.cardNodes('move')[0];
  assert.ok(card.textContent.includes('at least 5.93463 wNEAR'), card.textContent);
  assert.ok(!card.textContent.includes('5.93464'), card.textContent);
  assert.equal(world.cards.floorText(1234567), '1,234,560');
  assert.equal(world.cards.floorText(0.000123456789), '0.000123456');
});

test('a read-back of a move keeps the fold where the person left it', () => {
  const world = build();
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { chain: 'arb', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.017 },
    data: { id: 'k1', status: 'pending', verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' } } });
  world.cards.foldOf(world.cardNodes('move')[0]).setOpen(false);
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'k1' }, data: { id: 'k1', kind: 'swap', stage: 'waiting_for_you', stageLabel: 'Waiting for you' } });
  assert.equal(world.cardNodes('move').length, 1);
  assert.equal(world.cards.foldOf(world.cardNodes('move')[0]).isOpen(), false, 'the read-back re-opened a card the person closed');
});

test('a move card that was refused by the human says so once the frame says so', () => {
  const world = build();
  world.ask('swap 2 usdc to sol');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { chain: 'intents', fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 }, data: { id: 'p3', status: 'pending', verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' } } });
  world.proposals([withView({ id: 'p3', kind: 'swap', status: 'refused', createdAt: '2026-09-18T10:35:00Z', decidedAt: '2026-09-18T10:35:30Z', decidedBy: 'human', draft: { ...SWAP_DRAFT, fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 }, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: null })]);
  const card = world.cardNodes('move')[0];
  assert.equal(all(card, 'tcard-state')[0].textContent, 'Declined');
  assert.ok(card.textContent.includes('You said no.'), card.textContent);
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
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
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
  assert.deepEqual(buttons.map((b) => b.trim()), [
    "dom.el('button', 'btn btn-quiet btn-sm tcard-copy');",
    "dom.el('button', 'tcard-details-head');",
    "dom.el('button', 'btn btn-ghost btn-sm tcard-open');",
  ], 'an unknown button site in cards.js');
});

test('a chain_address answer is a small data block through the facts card, and its step row says the call left the machine', () => {
  // src/chainscan (feat/chainscan) puts chain_address on TOOL_DATA_TOOLS. No card of its own:
  // the generic facts card takes the payload, the long address wraps, the counts are mono, the
  // nested balance flattens to two facts, and the token list is counted rather than dumped.
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
      network: 'ethereum',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      ok: true,
      txCount: 1842,
      balance: { amount: '0.51', symbol: 'ETH' },
      isContract: false,
      lastSeen: '2026-09-12T10:00:00Z',
      source: 'eth.blockscout.com',
      tokens: [{ symbol: 'USDC', amount: '12.5' }, { symbol: 'DAI', amount: '3' }],
    },
  });
  const card = world.cardNodes('kv')[0];
  assert.ok(card, 'no facts card was drawn for chain_address');
  const keys = all(card, 'tcard-kv-key').map((n) => n.textContent);
  const values = all(card, 'tcard-kv-value');
  const value = (key: string): Any => values[keys.indexOf(key)];
  assert.ok(keys.includes('address'), keys.join(' | '));
  assert.equal(value('address').textContent, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  assert.equal(value('tx count').textContent, '1842');
  assert.ok(value('tx count').className.includes('mono'), 'the count is not in the mono face');
  assert.equal(value('balance amount').textContent, '0.51');
  assert.equal(value('balance symbol').textContent, 'ETH');
  assert.equal(value('is contract').textContent, 'no');
  assert.equal(value('tokens').textContent, '2 items');
});

/* The head's own layout, asserted on the stylesheet because a jsdom-free DOM has no widths.
   2026-09-19, photographing the stalled card at 1100: the card read "Fund trad..." because the
   state word and the chevron shared the last column, so a long state ("Late, nothing has
   changed") set the width of the title's cell on the row above it. The title spans to the
   chevron now. */
test('a state word never takes the title\'s room: the two-row head gives the title both middle columns', () => {
  const css = readFileSync(new URL('../../ui/design/cards.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.tcard-head:has(.tcard-state) {'));
  const areas = block.slice(block.indexOf('grid-template-areas'), block.indexOf(';', block.indexOf('grid-template-areas')));
  assert.match(areas, /"glyph title\s+title\s+chevron"/, 'the title does not span to the chevron');
  assert.match(areas, /"glyph figure\s+state\s+state"/, 'the state does not take the width left beside the figure');
  const columns = block.slice(block.indexOf('grid-template-columns'), block.indexOf(';', block.indexOf('grid-template-columns')));
  assert.match(columns, /20px auto minmax\(0, 1fr\) auto/, 'the head is not four columns');
  /* And the sentence wraps in its cell. Held to one line and anchored right, a state longer
     than the room beside the figure slid over it: "250 USDaiting for the venue to credit it". */
  const state = block.slice(block.indexOf('.tcard-state {', block.indexOf('grid-area: state') - 200));
  assert.match(state.slice(0, 220), /white-space: normal/, 'the state word is still held to one line');
});

test('a read on the way to a move leaves no card of its own, and one turn draws at most one read card', () => {
  /* The agent reads the wallet before every swap and the account before every trade, and each
     read drew its card: three cards per move, and a long chat full of balances nobody asked
     for (known failure 4, criterion 5.2). A read card under a move in the same turn goes; a
     second read card in one turn replaces the first; a move card is never dropped. */
  const world = build();
  world.ask('swap 2 usdc to sol');
  world.emit({ kind: 'tool', name: 'mcp__phosphor__wallet', input: {} });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__wallet', ok: true });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
  assert.equal(world.cardNodes('balance').length, 1, 'the read drew its card before the move');
  const filed = withView({ id: 'r1', kind: 'swap', status: 'pending', createdAt: '2026-09-20T10:00:00Z', draft: { ...SWAP_DRAFT, fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 }, verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' } });
  world.emit({ kind: 'tool', name: 'mcp__phosphor__propose_swap', input: {} });
  world.emit({ kind: 'tool_result', name: 'mcp__phosphor__propose_swap', ok: true });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: { fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: 2, minAmountOut: 0.0172 }, data: filed });
  assert.equal(world.cardNodes('balance').length, 0, 'the wallet card stayed under the move it was a check for');
  assert.equal(world.cardNodes('move').length, 1);
  /* The steps that produced the read stay: what the agent did is still the record. */
  assert.ok(world.blocks().some((b) => b.className === 'steps-block'), 'the step rows went with the card');
  world.emit({ kind: 'text', text: 'Proposed.' });
  world.emit({ kind: 'turn_end', error: false, turns: 1 });

  world.ask('what do I hold and how is the account');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__trade_read', input: {}, data: BOOK });
  assert.equal(world.cardNodes('balance').length, 0, 'two read cards in one turn');
  assert.equal(world.cardNodes('position').length, 1);
  assert.equal(world.cardNodes('move').length, 1, 'the move card from the turn before was touched');
  world.emit({ kind: 'turn_end', error: false, turns: 1 });

  /* A new turn starts its own count. */
  world.ask('and the wallet again');
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__wallet', input: {}, data: WALLET });
  assert.equal(world.cardNodes('position').length, 1, 'the turn before lost its card');
  assert.equal(world.cardNodes('balance').length, 1);
});

test('the receipt of a move folds into its card, and a move made elsewhere gets the same card off its row', () => {
  /* Two cards per swap by design, the move card plus a receipt card, was known failure 4.
     The move card follows its row to Confirmed with the hash on it, so the receipt adds
     nothing. A receipt for a move this conversation never proposed draws the same skeleton
     from the row the state frame carries, and only a row the frame has let go falls back to
     the receipt's own card. */
  const world = build();
  world.receipts([]);
  const soon = Date.now() + 1000;
  const row = (id: string, status: string, extra: Record<string, unknown> = {}) => withView({
    id, kind: 'swap', status, createdAt: '2026-09-20T10:00:00Z', draft: { ...SWAP_DRAFT, quote: { amountOut: 4.98, feeUsd: 0.02, timeEstimateSec: 5 } },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'swap' }, ...extra,
  });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: {}, data: row('p9', 'pending') });
  const settled = row('p9', 'executed', { decidedAt: '2026-09-20T10:00:20Z', decidedBy: 'human', settledAt: '2026-09-20T10:00:50Z', result: { ok: true, detail: 'done', txids: ['EafozJ2XkQ9mRtb7n16c'], evidence: { explorerUrl: 'https://nearblocks.io/txns/EafozJ2XkQ9mRtb7n16c' } } });
  const other = row('p10', 'executed', { decidedAt: '2026-09-20T10:01:20Z', decidedBy: 'policy', settledAt: '2026-09-20T10:01:50Z', result: { ok: true, detail: 'done', txids: ['zzz'] } });
  world.proposals([settled, other]);
  assert.equal(all(world.cardNodes('move')[0], 'tcard-state')[0].textContent, 'Confirmed');

  world.receipts([receipt('p9', soon)]);
  assert.equal(world.cardNodes('move').length, 1, 'the receipt drew a second card for the move');
  assert.equal(world.cardNodes('receipt').length, 0);
  assert.ok(all(world.cardNodes('move')[0], 'tcard-link').some((a: Any) => a.textContent.includes('EafozJ2X')), 'the hash is not on the move card');

  world.receipts([receipt('p10', soon), receipt('p9', soon)]);
  assert.equal(world.cardNodes('move').length, 2, 'a move made elsewhere got no card');
  assert.equal(world.cardNodes('receipt').length, 0, 'a row the frame carries drew the receipt shell instead of the move card');
  const drawn = world.cardNodes('move')[1];
  assert.equal(all(drawn, 'tcard-state')[0].textContent, 'Confirmed');
  assert.equal(drawn.id, 'card-proposal-p10');
  /* The card before it folds to its line, the way a receipt used to. */
  assert.equal(world.cards.foldOf(world.cardNodes('move')[0]).isOpen(), false);

  world.receipts([receipt('gone', soon), receipt('p10', soon), receipt('p9', soon)]);
  assert.equal(world.cardNodes('move').length, 2);
  assert.equal(world.cardNodes('receipt').length, 1, 'a row the frame has let go still gets the receipt card');
  /* Opening the receipt of a move already on the thread opens that card where it stands. */
  world.bus('receipt:open', { receipt: receipt('p9', soon) });
  assert.equal(world.cardNodes('move').length, 2);
  assert.equal(world.cards.foldOf(world.cardNodes('move')[0]).isOpen(), true);
  assert.equal(all(world.cardNodes('move')[0], 'tcard-details')[0].getAttribute('data-open'), 'true');
});

test('a send is the same skeleton, with the whole address on the leg it lands on', () => {
  /* Every kind is one shape: title, the two legs, at least and fee, the stage line, one fold.
     A send differs in one fact, the receiver, and that fact is the whole address, every
     character in groups of four with a Copy, never shortened (frozen rule 3). */
  const world = build();
  const to = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
  const draft = { kind: 'intents_pay', symbol: 'USDC', originAsset: 'nep141:eth-usdc', network: 'eth', amount: 25, amountUsd: 25, minReceived: 24.6, from: '0x1', to, toChecksum: 'valid', counterparty: 'intents.near', recipient: { known: false, count: 0, lastAt: null, ownAddress: false } };
  const filed = withView({ id: 's1', kind: 'intents_pay', status: 'pending', createdAt: '2026-09-20T10:00:00Z', draft, verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: { ok: true, summary: 'pay', send: { arrives: '24.7', arrivesAtLeast: '24.6', feeUsd: 0.3, etaSeconds: 60, explorer: 'https://etherscan.io/address/' + to, activity: 'This address has never been used on Ethereum.' } } });
  const reply = { id: 's1', status: 'pending', verdict: filed.verdict, simulation: filed.simulation, view: filed.view,
    send: { kind: 'intents_pay', where: 'eth', to, symbol: 'USDC', amount: 25, amountUsd: 25, recipient: { known: false, count: 0, lastAt: null, ownAddress: false } } };
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_send', input: { amount: 25, symbol: 'USDC', to, where: 'eth', confirmed: true }, data: reply });
  const card = world.cardNodes('move')[0];
  assert.ok(card, 'no card');
  assert.equal(all(card, 'tcard-title')[0].textContent, 'Pay');
  assert.equal(all(card, 'tcard-state')[0].textContent, 'Waiting for you');
  const legs = byAttr(card, 'data-leg');
  assert.equal(legs.length, 2, 'a send is two legs like every move');
  const from = legs.find((n: Any) => n.getAttribute('data-leg') === 'from') as Any;
  const out = legs.find((n: Any) => n.getAttribute('data-leg') === 'to') as Any;
  assert.ok(from.textContent.includes('25 USDC') && from.textContent.includes('inside NEAR Intents'), from.textContent);
  assert.ok(out.textContent.includes('at least 24.6 USDC') && out.textContent.includes('to Ethereum'), out.textContent);
  const address = all(out, 'tcard-leg-address')[0];
  assert.ok(address, 'no address on the out leg');
  assert.equal(address.getAttribute('data-address'), to);
  assert.equal(all(address, 'tcard-leg-group').map((g: Any) => g.textContent).join(''), to, 'the address is not whole');
  assert.equal(all(address, 'tcard-leg-group')[1].textContent, 'CdEf');
  assert.ok(all(out, 'tcard-copy').length === 1, 'no Copy on the address');
  assert.ok(all(out, 'tcard-leg-explorer').length === 1, 'no explorer link on the address');
  assert.equal(all(card, 'tcard-facts')[0].textContent, 'fee $0.30');
  assert.equal(all(card, 'tcard-stage-copy')[0].textContent, 'Nothing moves until you answer Yes or No in the window.');
  const details = all(card, 'tcard-details')[0];
  const lines = all(details, 'tcard-line').map((n: Any) => n.textContent);
  assert.ok(lines.some((t: string) => t === 'This addressfirst send'), lines.join(' | '));
  assert.ok(details.textContent.includes('never been used on Ethereum'), details.textContent);
  /* No sentence about the move under two legs that already say it, and no old send card. */
  assert.equal(all(card, 'sendcard').length, 0);
});

test('a late move reads its clock in words, and a held one names the checks', () => {
  const world = build();
  const late = withView({ id: 'l1', kind: 'hl_deposit', status: 'needs_reconciliation', createdAt: '2026-09-20T10:00:00Z', decidedAt: '2026-09-20T10:00:10Z', decidedBy: 'human', lastChangeAt: '2026-09-20T10:01:00Z', stalledAt: '2026-09-20T10:21:00Z',
    draft: { kind: 'hl_deposit', symbol: 'USDC', originAsset: 'nep141:eth-usdc', amount: 7.5425, amountUsd: 7.5425, minCredited: 5, from: '0x1', hlAccount: '0x1', counterparty: 'hypercore' },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: null, pocket: { venue: 'hyperliquid', symbol: 'USDC', assetId: 'hl-usdc', account: '0x1', decimals: 6, before: '0', after: null, floor: '5000000' },
    result: { ok: false, detail: 'polling', txids: ['0xintent'], evidence: { providerStage: 'PROCESSING', handle: 'h1' } } }, Date.parse('2026-09-20T10:23:00Z'));
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'l1' }, data: late.view });
  const card = world.cardNodes('move')[0];
  assert.equal(all(card, 'tcard-state')[0].textContent, 'Late, nothing has changed');
  assert.equal(late.view.error.message, 'Nothing has changed for 22 minutes. Hyperliquid has not answered.');
  assert.ok(!card.textContent.includes('PROCESSING'), 'the vendor word in capitals: ' + card.textContent);
  assert.ok(!card.textContent.includes('2026-09-20T'), 'an ISO stamp on the card: ' + card.textContent);
  /* Late is still counting: the stage line keeps its clock. */
  assert.equal(all(card, 'tcard-stage-clock')[0].getAttribute('data-empty'), null);

  const held = withView({ id: 'h1', kind: 'hl_deposit', status: 'approved', heldSince: '2026-09-20T10:00:30Z', createdAt: '2026-09-20T10:00:00Z', decidedAt: '2026-09-20T10:00:10Z', decidedBy: 'human',
    draft: { kind: 'hl_deposit', symbol: 'USDC', originAsset: 'nep141:eth-usdc', amount: 7.5425, amountUsd: 7.5425, minCredited: 5, from: '0x1', hlAccount: '0x1', counterparty: 'hypercore' },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: null });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__proposal_status', input: { id: 'h1' }, data: held.view });
  const holding = world.cardNodes('move')[1];
  assert.equal(all(holding, 'tcard-state')[0].textContent, 'Holding');
  assert.ok(all(holding, 'tcard-stage-copy')[0].textContent.startsWith('The checks before signing have not cleared.'));
});

test('an over-the-line relay swap says how long its price holds and that the click re-quotes it', () => {
  /* The relay quote holds for about a minute and a person clicks when they click: the rail
     re-quotes at the click (A's rail hands simulation.swap.priceGoodForSec), and the card says
     so while the row waits on the person and at no other stage. */
  const world = build();
  const row = (status: string) => withView({
    id: 'q1', kind: 'swap', status, createdAt: '2026-09-20T10:00:00Z',
    draft: { ...SWAP_DRAFT, venue: 'intents-relay', fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 500, amountUsd: 500, minAmountOut: 0.1085 },
    verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: { ok: true, summary: 'swap', swap: { receives: '0.1106', receivesAtLeast: '0.1085', feeUsd: 0.5, etaSeconds: 45, priceGoodForSec: 60 } },
  });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_swap', input: {}, data: row('pending') });
  const card = world.cardNodes('move')[0];
  const price = all(card, 'tcard-price')[0];
  assert.equal(price.textContent, 'Price good for about a minute, re-quoted at your click');
  assert.equal(price.hidden, false);
  world.proposals([row('approved')]);
  assert.equal(all(card, 'tcard-price')[0].hidden, true, 'the price line outlived the wait for the click');
});

test('a Hyperliquid move draws the quote on its landing leg and the floor in the facts, then the settled figure alone', () => {
  /* The landing leg printed the floor (19.67) while the summary said about 19.75: two numbers
     for one fact (node B's review, 2026-09-20). The same skeleton as the swap card now: "about"
     off the quote on the leg, "at least" off arrivesAtLeast in the facts, one settled figure
     after the venue credits it. A row whose quote named no expected figure keeps the floor. */
  const world = build();
  const draft = { kind: 'hl_withdraw', symbol: 'USDC', amount: 20, amountUsd: 20, minReceived: 19.67, from: '0x1', to: '0x1', counterparty: 'hypercore-withdraw' };
  const row = (status: string, extra: Record<string, unknown> = {}) => withView({
    id: 'w2', kind: 'hl_withdraw', status, createdAt: '2026-09-20T10:00:00Z', draft, verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: { ok: true, summary: 'withdraw', send: { arrives: '19.75', arrivesAtLeast: '19.67', feeUsd: 0.25, etaSeconds: 180 } }, ...extra,
  });
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_hl_withdraw', input: { amount: 20 }, data: row('pending') });
  const card = world.cardNodes('move')[0];
  const out = byAttr(card, 'data-leg').find((n: Any) => n.getAttribute('data-leg') === 'to') as Any;
  assert.ok(out.textContent.includes('about 19.75 USDC') && out.textContent.includes('inside NEAR Intents'), out.textContent);
  assert.ok(!out.textContent.includes('19.67'), 'the floor is on the leg: ' + out.textContent);
  assert.equal(all(card, 'tcard-facts')[0].textContent, 'at least 19.67 USDC, fee $0.25');
  assert.equal((card.textContent.match(/19\.67/g) || []).length, 1, 'the floor is printed twice');
  assert.equal((card.textContent.match(/19\.75/g) || []).length, 1, 'the quote is printed twice');

  world.proposals([row('executed', { decidedAt: '2026-09-20T10:00:20Z', decidedBy: 'human', settledAt: '2026-09-20T10:03:00Z',
    result: { ok: true, detail: 'done', txids: ['abc'], evidence: { settledAmountOut: '19.72' } } })]);
  const landed = byAttr(card, 'data-leg').find((n: Any) => n.getAttribute('data-leg') === 'to') as Any;
  assert.ok(landed.textContent.includes('19.72 USDC'), landed.textContent);
  assert.ok(!landed.textContent.includes('about') && !landed.textContent.includes('at least'), 'a settled figure is a fact: ' + landed.textContent);
  assert.ok(!card.textContent.includes('19.75'), 'the quote outlived the settlement: ' + card.textContent);

  /* The deposit side, and a quote with no expected figure keeps the floor on the leg. */
  world.emit({ kind: 'tool_data', name: 'mcp__phosphor__propose_hl_deposit', input: { amount: 7 }, data: withView({
    id: 'd2', kind: 'hl_deposit', status: 'pending', createdAt: '2026-09-20T10:05:00Z',
    draft: { kind: 'hl_deposit', symbol: 'USDC', originAsset: 'nep141:eth-usdc', amount: 7, amountUsd: 7, minCredited: 5, from: '0x1', hlAccount: '0x1', counterparty: 'hypercore' },
    verdict: { outcome: 'needs_approval', reasons: [] }, simulation: { ok: true, summary: 'deposit' },
  }) });
  const deposit = world.cardNodes('move')[1];
  const credited = byAttr(deposit, 'data-leg').find((n: Any) => n.getAttribute('data-leg') === 'to') as Any;
  assert.ok(credited.textContent.includes('at least 5 USDC') && credited.textContent.includes('to Hyperliquid'), credited.textContent);
});

