// Pro, the statement (Karim's pick, 2026-09-23): the NEAR money in detail. The total with its
// split and the two things to do with it, the trading account in one line to Trade, the coins as
// a ledger with the day's line and change, the Policies as three dials, and the recent moves.
//
// What is held here: the total is the NEAR Intents balance alone and never the trading account;
// a figure the app does not have is left out rather than written as zero (a coin with no price,
// a coin with no day, a trading account nobody has read); a coin's day comes off the day feed
// (/api/day) wherever the feed has one, VVV among them (2026-09-25), and off the candles only for
// a listed market it has none for, and neither is read on a timer; the dials are the policy's own
// fields and the engine's own totals; the moves say what they are in a few words and where they
// stand in the card's words; and nothing Hyperliquid but the one line shows on Pro.
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
const SHELL = readFileSync(new URL('../../ui/screens/shell.js', import.meta.url), 'utf8');
const VAULT = readFileSync(new URL('../../ui/screens/vault.js', import.meta.url), 'utf8');

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(ev: Any) => void>> = {};
  const style: Any = {
    setProperty: (name: string, value: string) => { style[name] = value; },
    removeProperty: (name: string) => { delete style[name]; },
    getPropertyValue: (name: string) => style[name] ?? '',
  };
  const node: Any = {
    tagName,
    id: '',
    className: '',
    hidden: false,
    dataset: {},
    style,
    childNodes: [],
    parentNode: null,
    focused: false,
    get children() { return node.childNodes; },
    get firstChild() { return node.childNodes[0] ?? null; },
    get lastChild() { return node.childNodes[node.childNodes.length - 1] ?? null; },
    get nextSibling() {
      const siblings = node.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    get textContent(): string {
      if (node.childNodes.length === 0) return node.__text ?? '';
      return node.childNodes.map((c: Any) => c.textContent).join('');
    },
    set textContent(value: string) {
      for (const child of node.childNodes) child.parentNode = null;
      node.childNodes = [];
      node.__text = String(value);
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
    setAttribute: (name: string, value: string) => { attrs[name] = String(value); },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => { delete attrs[name]; },
    addEventListener: (type: string, fn: (ev: Any) => void) => { (listeners[type] = listeners[type] ?? []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (ev: Any) => { for (const fn of listeners[ev.type] ?? []) fn(ev); return true; },
    click: () => { for (const fn of listeners.click ?? []) fn({ target: node, preventDefault() {} }); },
    focus: () => { node.focused = true; },
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

const tick = () => new Promise((resolve) => setImmediate(resolve));

type Rig = {
  host: Any;
  put: (next: Any) => void;
  view: (name: string) => void;
  asked: string[];
  shell: Any;
  events: Any[];
  opened: Any[];
  composer: Any;
  timers: number;
  clock: { now: number };
  candles: Record<string, Any>;
  // What GET /api/day answers: the entries by asset id, or a failed read.
  day: { entries: Record<string, Any>; fails: boolean };
};

function boot(options: { view?: string; candles?: Record<string, Any>; day?: Record<string, Any>; receipts?: Any[]; svg?: boolean } = {}): Rig {
  const host = makeNode('section');
  host.id = 'view-pro';
  let subscriber: ((state: Any) => void) | null = null;
  let current: Any = {};
  let loaded = false;
  const asked: string[] = [];
  const events: Any[] = [];
  const opened: Any[] = [];
  const windowListeners: Record<string, Array<(ev: Any) => void>> = {};
  const clock = { now: Date.parse('2026-09-23T20:00:00Z') };
  let timers = 0;
  const candles: Record<string, Any> = options.candles ?? {};
  // No days unless a test names some: the backend in demo mode, and every test written before the feed.
  const day = { entries: options.day ?? {}, fails: false };
  const composer = makeNode('textarea');
  composer.className = 'input composer-input';
  composer.value = '';
  composer.disabled = false;
  composer.getClientRects = () => [{}];
  const shell: Any = { current: options.view ?? 'pro', set: [] as Any[] };
  shell.view = () => shell.current;
  shell.setView = (name: string, opts: Any) => { shell.set.push({ name, opts }); };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  class FakeEvent {
    type: string;
    bubbles: boolean;
    constructor(type: string, init: Any = {}) { this.type = type; this.bubbles = !!init.bubbles; }
  }
  const document: Any = {
    createElement: (tag: string) => makeNode(tag),
    getElementById: (id: string) => (id === 'view-pro' ? host : null),
    querySelector: (sel: string) => (sel === '.composer-input' ? composer : null),
  };
  // The ring and the dials' arcs are built only where there is an svg namespace to build in.
  if (options.svg) document.createElementNS = (_ns: string, tag: string) => makeNode(tag);
  const window: Any = {
    document,
    setTimeout: () => { timers += 1; return 0; },
    clearTimeout: () => {},
    setInterval: () => { timers += 1; return 0; },
    addEventListener: (type: string, fn: (ev: Any) => void) => { (windowListeners[type] = windowListeners[type] ?? []).push(fn); },
    PhosphorMotion: { reduced: () => true, morph: (_el: Any, change: () => void) => change() },
    PhosphorShell: shell,
    PhosphorIcons: { svg: (name: string, cls?: string) => { const n = makeNode('svg'); n.className = 'icon' + (cls ? ' ' + cls : ''); n.dataset.icon = name; return n; } },
    PhosphorEvents: { emit: (type: string, detail: Any) => { events.push({ type, detail }); } },
    PhosphorMoneyIn: { render: (target: Any, opts: Any) => { opened.push({ opts }); target.appendChild(makeNode('div')); return { destroy: () => opened.push({ destroyed: true }) }; } },
    PhosphorCards: { plainState: (row: Any) => (row.view && row.view.state) || 'working' },
    PhosphorState: {
      subscribe: (fn: (state: Any) => void) => { subscriber = fn; },
      get: () => current,
      loaded: () => loaded,
    },
    PhosphorNet: {
      getJson: (path: string) => {
        asked.push(path);
        if (path.startsWith('/api/receipts')) return Promise.resolve({ data: { receipts: options.receipts ?? [] }, fresh: true });
        if (path.startsWith('/api/day')) {
          if (day.fails) return Promise.reject(Object.assign(new Error('no day'), { status: 502 }));
          return Promise.resolve({ data: { at: clock.now, entries: day.entries }, fresh: true });
        }
        const product = decodeURIComponent((/product=([^&]+)/.exec(path) || [])[1] || '');
        const bars = candles[product];
        if (!bars) return Promise.reject(Object.assign(new Error('no candles'), { status: 502 }));
        return Promise.resolve({ data: bars, fresh: true });
      },
    },
  };
  window.window = window;
  const ctx = createContext({ window, document, console, Promise, Date: FakeDate, Event: FakeEvent });
  runInContext(DOM, ctx);
  runInContext(PRO, ctx);
  window.PhosphorPro.boot();
  const fire = (type: string, detail: Any) => { for (const fn of windowListeners[type] ?? []) fn({ detail }); };
  return {
    host,
    put: (next: Any) => { current = next; loaded = true; subscriber!(next); },
    view: (name: string) => { shell.current = name; fire('phosphor:view', { view: name }); },
    asked,
    shell,
    events,
    opened,
    composer,
    get timers() { return timers; },
    clock,
    candles,
    day,
  };
}

/* ---------- fixtures ---------- */

const PRICES: Record<string, number> = { USDC: 1, ETH: 2684.2, NEAR: 4.42, SOL: 148.2 };

function intents(symbol: string, quantity: number, over: Any = {}): Any {
  const price = PRICES[symbol] ?? 0;
  return { kind: 'intents', chain: 'intents', symbol, tokenId: `nep141:${symbol.toLowerCase()}`, quantity, priceUsd: price, valueUsd: quantity * price, share: 0, native: false, ...over };
}

const HL = { kind: 'hyperliquid', chain: 'hyperliquid', symbol: 'USDC', tokenId: 'hyperliquid:perps', quantity: 1046.82, priceUsd: 1, valueUsd: 1046.82, share: 0, native: false, hyperliquid: { account: '0x1', availableUsdc: 845.42, marginUsedUsd: 201.4, openPositions: 2, unified: false } };

const POLICY = {
  version: 1,
  killSwitch: false,
  outbound: { maxPerTransactionUsd: 10000, maxPerSessionUsd: 25000, humanClickAboveUsd: 100, autoApproveDailyUsd: 500, destinationAllowlist: [], simulateBeforeSign: true },
  composition: { maxIssuerShare: {}, maxFreezableShare: 1, forbiddenIssuers: [] },
  sentences: [],
};

function state(over: Any = {}): Any {
  return {
    wallet: {
      rows: [intents('USDC', 6150), intents('ETH', 1.42), HL, intents('NEAR', 310.5), intents('SOL', 8.1)],
      stale: [],
      hyperliquid: { funded: true },
    },
    basic: { totalLine: '$13,581.22', caption: 'in your balance', smallLine: null },
    policy: POLICY,
    dailyLimit: { capUsd: 25000, spentUsd: 114.22, resetsAt: null },
    autoLimit: { capUsd: 500, spentUsd: 14.22, resetsAt: null },
    candleProducts: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'NEAR-USD'],
    proposals: [],
    ...over,
  };
}

/* 25 hourly closes from `first` to `last`. */
function day(first: number, last: number): Any[] {
  return Array.from({ length: 25 }, (_, i) => {
    const c = first + (last - first) * (i / 24);
    return { t: 1_758_600_000 + i * 3600, o: c, h: c, l: c, c, v: 1 };
  });
}

function row(rig: Rig, symbol: string): Any {
  const found = withClass(rig.host, 'l-row').find((r) => r.dataset.key === symbol);
  assert.ok(found, `no ledger row for ${symbol}`);
  return found;
}

/* ---------- the total ---------- */

test('the total is the NEAR money alone: the trading account is its own line, never in the figure', () => {
  const rig = boot();
  assert.equal(one(rig.host, 'stmt-total').hidden, true, 'a figure before the first state frame');
  rig.put(state());
  assert.equal(one(rig.host, 'stmt-total').textContent, '$12,534.39', 'the total counted the trading account');
  assert.equal(one(rig.host, 'stmt-total').hidden, false);
  assert.equal(one(rig.host, 'stmt-caption').textContent, 'in your coins');
  assert.equal(withClass(rig.host, 'stmt-total-skel').length, 0, 'the skeleton stays after the read');
  // The coins are the NEAR Intents rows, largest first, and the trading account's USDC is not
  // folded into the NEAR USDC.
  const rows = withClass(one(rig.host, 'l-rows'), 'l-row').filter((r) => !r.hidden);
  assert.deepEqual(rows.map((r) => r.dataset.key), ['USDC', 'ETH', 'NEAR', 'SOL']);
  assert.equal(one(row(rig, 'USDC'), 'l-val').textContent, '$6,150.00');
});

test('a balance that could not be read is words, never $0.00, and a coin with no price says so', () => {
  const rig = boot();
  rig.put(state({ wallet: { rows: [intents('USDC', 5)], stale: ['intents'], hyperliquid: { funded: true } } }));
  assert.equal(one(rig.host, 'stmt-total').hidden, true);
  assert.equal(one(rig.host, 'stmt-caption').textContent, 'Still reading your coins.');
  assert.ok(!words(rig.host).includes('$0.00'), JSON.stringify(words(rig.host)));

  rig.put(state({ wallet: { rows: [intents('USDC', 100), intents('WIF', 2.5, { priceUsd: 0, valueUsd: 0, priced: false })], stale: [], hyperliquid: { funded: true } } }));
  assert.equal(one(rig.host, 'stmt-caption').textContent, 'in your coins, not counting WIF');
  const wif = row(rig, 'WIF');
  assert.equal(one(wif, 'l-val').textContent, 'No price');
  assert.equal(one(wif, 'l-val').getAttribute('data-unpriced'), 'true');
  assert.equal(one(wif, 'l-price-figure').textContent, '', 'a price with no price behind it');
});

test('each coin: its price, the amount under its name and in its own column, and its value', () => {
  const rig = boot();
  rig.put(state());
  const eth = row(rig, 'ETH');
  assert.equal(one(eth, 'l-sym').textContent, 'ETH');
  assert.equal(one(eth, 'l-price-figure').textContent, '$2,684.20');
  assert.equal(one(eth, 'l-amt').textContent, '1.42');
  assert.equal(one(eth, 'l-amt-under').textContent, '1.42', 'the amount has nowhere to go when its column steps out');
  assert.equal(one(eth, 'l-val').textContent, '$3,811.56');
  assert.equal(one(row(rig, 'NEAR'), 'l-price-figure').textContent, '$4.42');
});

/* The finish review, 2026-09-24: under 860 the legend steps off and the ring was an empty dark
   disc. The disc says the largest coin's share there, as the mockup's ring does. */
test('the ring\'s disc says the largest coin\'s share where the legend steps off', () => {
  const rig = boot();
  const label = one(rig.host, 'stmt-ring-label');
  assert.equal(label.hidden, true, 'a share before the first read');
  rig.put(state());
  assert.equal(label.hidden, false);
  assert.equal(one(label, 'stmt-ring-share').textContent, '49%');
  assert.equal(one(label, 'stmt-ring-coin').textContent, 'USDC');
  assert.equal(withClass(one(rig.host, 'stmt-legend'), 'stmt-legend-item')[0].textContent, 'USDC 49%', 'the disc and the legend disagree');
  // Nothing priced is no share to say.
  rig.put(state({ wallet: { rows: [intents('WIF', 2.5, { priceUsd: 0, valueUsd: 0, priced: false })], stale: [], hyperliquid: { funded: true } } }));
  assert.equal(label.hidden, true);
  // Only where the legend is not: beside the legend it would say the same thing twice.
  assert.match(CSS, /\.stmt-ring-label \{[^}]*display: none;/);
  const at860 = CSS.slice(CSS.indexOf('@container prostmt (max-width: 860px)'));
  assert.match(at860, /\.stmt-ring-label:not\(\[hidden\]\) \{ display: grid; \}/);
});

/* ---------- the day ---------- */

test('the day\'s line and change are read only for markets the app lists, and a coin without one shows neither', async () => {
  const rig = boot({ candles: { 'ETH-USD': day(2636.74, 2684.2), 'SOL-USD': day(143.74, 148.2) } });
  rig.put(state({ candleProducts: ['ETH-USD', 'SOL-USD'] }));
  await tick();
  const days = rig.asked.filter((p) => p.startsWith('/api/candles'));
  assert.deepEqual(days.map((p) => /product=([^&]+)/.exec(p)![1]).sort(), ['ETH-USD', 'SOL-USD'], 'USDC or NEAR was asked for a market the app does not list');
  assert.ok(days.every((p) => p.includes('granularity=3600') && p.includes('limit=25')), 'a day is 25 hourly bars');
  assert.equal(one(row(rig, 'ETH'), 'l-chg').textContent, '+1.8%');
  assert.equal(one(row(rig, 'ETH'), 'l-chg').getAttribute('data-dir'), 'up');
  assert.equal(one(row(rig, 'NEAR'), 'l-chg').textContent, '', 'NEAR has no read day and drew a change');
  assert.equal(one(row(rig, 'USDC'), 'l-chg').textContent, '');
  // The day across the coins needs every coin that is not a dollar: NEAR has none, so no figure.
  assert.equal(one(rig.host, 'stmt-today').hidden, true, 'a day for some of the money was written as if it were all of it');
});

test('the total carries no day figure; each coin says its own 24h change', async () => {
  // Price moves times today's amounts read as profit while ignoring deposits and swaps
  // (lead's call, 2026-09-24), so the head shows no "+$X today" even with every line read.
  const rig = boot({ candles: { 'ETH-USD': day(2636.74, 2684.2), 'SOL-USD': day(143.74, 148.2), 'NEAR-USD': day(4.5287, 4.42) } });
  rig.put(state());
  await tick();
  const today = one(rig.host, 'stmt-today');
  assert.equal(today.hidden, true);
  assert.equal(one(row(rig, 'NEAR'), 'l-chg').textContent, '-2.4%');
  assert.equal(one(row(rig, 'NEAR'), 'l-chg').getAttribute('data-dir'), 'down');
});

test('a day is read once and again only when a frame finds it five minutes old: no timer, no ticker', async () => {
  const rig = boot({ candles: { 'ETH-USD': day(2636.74, 2684.2) } });
  rig.put(state({ candleProducts: ['ETH-USD'] }));
  await tick();
  const count = () => rig.asked.filter((p) => p.startsWith('/api/candles')).length;
  assert.equal(count(), 1);
  rig.put(state({ candleProducts: ['ETH-USD'] }));
  rig.clock.now += 4 * 60 * 1000;
  rig.put(state({ candleProducts: ['ETH-USD'] }));
  await tick();
  assert.equal(count(), 1, 'a line was read again before it was five minutes old');
  rig.clock.now += 2 * 60 * 1000;
  rig.put(state({ candleProducts: ['ETH-USD'] }));
  await tick();
  assert.equal(count(), 2, 'a five minute old line was not read again');
  // A read that fails keeps the last good line rather than blanking the row.
  delete rig.candles['ETH-USD'];
  rig.clock.now += 6 * 60 * 1000;
  rig.put(state({ candleProducts: ['ETH-USD'] }));
  await tick();
  await tick();
  assert.equal(one(row(rig, 'ETH'), 'l-chg').textContent, '+1.8%', 'a failed re-read blanked a good line');
  assert.equal(rig.timers, 0, 'Pro started a timer');
  assert.doesNotMatch(PRO, /setInterval|setTimeout/, 'Pro reads on a clock of its own again');
  // Off Pro, nothing is read.
  rig.view('basic');
  rig.clock.now += 10 * 60 * 1000;
  rig.put(state({ candleProducts: ['ETH-USD'] }));
  assert.equal(count(), 3, 'a day was read while Pro was not on screen');
});

/* The day feed (2026-09-25): a held VVV had no line and no change, because the candles cover only
   the markets config.json lists. The feed covers every coin the NEAR Intents token list names a
   CoinGecko id for, and the window reads it per asset id. */
const VVV_ASSET = 'nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near';
const LTC_ASSET = 'nep141:ltc.omft.near';

/* A day off the feed: 25 hourly prices from `first` to `last`, and their change, which the feed
   serves off the line itself (src/ledger/day.ts parseMarkets). */
function feedDay(first: number, last: number): Any {
  return { change24: ((last - first) / first) * 100, line: Array.from({ length: 25 }, (_, i) => first + (last - first) * (i / 24)), at: Date.parse('2026-09-23T20:00:00Z') };
}

function vvv(quantity = 12): Any {
  return intents('VVV', quantity, { tokenId: VVV_ASSET, priceUsd: 30.26, valueUsd: quantity * 30.26 });
}

function assetsAsked(path: string): string[] {
  return decodeURIComponent((/assets=([^&]*)/.exec(path) || [])[1] || '').split(',').filter(Boolean);
}

test('every coin the feed has a day for draws it, VVV among them, and no candles are asked for it', async () => {
  const rig = boot({
    svg: true,
    candles: { 'ETH-USD': day(2636.74, 2684.2) },
    day: { [VVV_ASSET]: feedDay(31.72, 30.26), 'nep141:eth': feedDay(2674, 2684.2) },
  });
  rig.put(state({ wallet: { rows: [intents('USDC', 6150), intents('ETH', 1.42), vvv()], stale: [], hyperliquid: { funded: true } }, candleProducts: ['ETH-USD'] }));
  await tick();
  const reads = rig.asked.filter((p) => p.startsWith('/api/day'));
  assert.equal(reads.length, 1);
  // The window names the coins it holds to its own backend, which answers from what the feed
  // already has: the call that leaves this Mac names every listed coin (tests/unit/day-feed.test.ts).
  assert.deepEqual(assetsAsked(reads[0]), ['nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near', 'nep141:eth', 'nep141:usdc']);
  const chg = one(row(rig, 'VVV'), 'l-chg');
  assert.equal(chg.textContent, '-4.6%');
  assert.equal(chg.getAttribute('data-dir'), 'down');
  const spark = one(row(rig, 'VVV'), 'l-spark');
  assert.equal(spark.children.length, 1, 'VVV has a change and no line');
  assert.equal(spark.children[0].getAttribute('data-dir'), 'down');
  assert.match(spark.children[0].children[0].getAttribute('d'), /^M0\.00 2\.00(L[\d.]+ [\d.]+){24}$/, 'the line is not the day\'s 25 points, highest first');
  // ETH has a market the app lists and still draws the feed's day: no candles asked for at all.
  assert.equal(one(row(rig, 'ETH'), 'l-chg').textContent, '+0.4%');
  assert.deepEqual(rig.asked.filter((p) => p.startsWith('/api/candles')), [], 'candles were read for a coin the feed covers');
  // USDC has no day here and no listed market: nothing, never a made-up flat line.
  assert.equal(one(row(rig, 'USDC'), 'l-chg').textContent, '');
  assert.equal(one(row(rig, 'USDC'), 'l-spark').children.length, 0);
});

test('a coin the feed has no day for falls back to its candles once the feed has answered, and one with neither shows none', async () => {
  const rig = boot({ candles: { 'ETH-USD': day(2636.74, 2684.2) }, day: { [VVV_ASSET]: feedDay(31.72, 30.26) } });
  rig.put(state({
    wallet: { rows: [intents('ETH', 1.42), vvv(), intents('WIF', 2.5, { priceUsd: 0, valueUsd: 0, priced: false })], stale: [], hyperliquid: { funded: true } },
    candleProducts: ['ETH-USD'],
  }));
  await tick();
  assert.equal(one(row(rig, 'ETH'), 'l-chg').textContent, '+1.8%', 'ETH did not fall back to its candles');
  assert.equal(one(row(rig, 'VVV'), 'l-chg').textContent, '-4.6%');
  assert.equal(one(row(rig, 'WIF'), 'l-chg').textContent, '');
  const candles = rig.asked.filter((p) => p.startsWith('/api/candles'));
  assert.deepEqual(candles.map((p) => /product=([^&]+)/.exec(p)![1]), ['ETH-USD']);
});

test('a day that is not a number or not a line draws nothing, and a listed market still gets its candles', async () => {
  const rig = boot({
    candles: { 'ETH-USD': day(2636.74, 2684.2) },
    day: {
      'nep141:eth': { change24: 'up', line: feedDay(1, 2).line, at: 0 },
      [VVV_ASSET]: { change24: -4.5, line: [31, -1, 30], at: 0 },
      [LTC_ASSET]: { change24: 2.1, line: [88], at: 0 },
    },
  });
  rig.put(state({ wallet: { rows: [intents('ETH', 1.42), vvv(), intents('LTC', 3, { tokenId: LTC_ASSET, priceUsd: 88, valueUsd: 264 })], stale: [], hyperliquid: { funded: true } }, candleProducts: ['ETH-USD'] }));
  await tick();
  assert.equal(one(row(rig, 'ETH'), 'l-chg').textContent, '+1.8%');
  assert.equal(one(row(rig, 'VVV'), 'l-chg').textContent, '', 'a line with a negative price was drawn');
  assert.equal(one(row(rig, 'LTC'), 'l-chg').textContent, '', 'one point was drawn as a day');
});

test('the feed is read with Pro up, again at five minutes or when a coin it never covered arrives, and a failed read keeps the last good day', async () => {
  const rig = boot({ day: { [VVV_ASSET]: feedDay(31.72, 30.26), [LTC_ASSET]: feedDay(86, 88) } });
  const holding = (rows: Any[]) => state({ wallet: { rows, stale: [], hyperliquid: { funded: true } }, candleProducts: [] });
  const reads = () => rig.asked.filter((p) => p.startsWith('/api/day'));
  rig.put(holding([vvv()]));
  await tick();
  assert.equal(reads().length, 1);
  rig.put(holding([vvv()]));
  rig.clock.now += 4 * 60 * 1000;
  rig.put(holding([vvv()]));
  await tick();
  assert.equal(reads().length, 1, 'the day was read again before it was five minutes old');
  // LTC lands: a coin the last read never named is read for at once, not in five minutes.
  const ltc = intents('LTC', 3, { tokenId: LTC_ASSET, priceUsd: 88, valueUsd: 264 });
  rig.put(holding([vvv(), ltc]));
  await tick();
  assert.equal(reads().length, 2);
  assert.deepEqual(assetsAsked(reads()[1]), [VVV_ASSET, LTC_ASSET].sort());
  assert.equal(one(row(rig, 'LTC'), 'l-chg').textContent, '+2.3%');
  // Selling it asks nothing new: everything held was covered by the last read.
  rig.put(holding([vvv()]));
  await tick();
  assert.equal(reads().length, 2);
  // Five minutes on, again; a read that fails keeps the day it had.
  rig.day.fails = true;
  rig.clock.now += 6 * 60 * 1000;
  rig.put(holding([vvv()]));
  await tick();
  assert.equal(reads().length, 3);
  assert.equal(one(row(rig, 'VVV'), 'l-chg').textContent, '-4.6%', 'a failed read blanked a good day');
  // And a failure waits its five minutes too, rather than asking on every frame.
  rig.put(holding([vvv()]));
  await tick();
  assert.equal(reads().length, 3);
  // Off Pro, nothing is read.
  rig.view('basic');
  rig.clock.now += 10 * 60 * 1000;
  rig.put(holding([vvv()]));
  await tick();
  assert.equal(reads().length, 3, 'the day was read while Pro was not on screen');
  assert.equal(rig.timers, 0, 'Pro started a timer');
});

/* ---------- the trading account ---------- */

test('the trading account is one line that leads to Trade, and no line when no account was read', () => {
  const rig = boot();
  rig.put(state());
  const line = one(rig.host, 'stmt-trade');
  assert.equal(line.hidden, false);
  assert.deepEqual(words(line), ['Trading account', '$1,046.82 · 2 positions', 'Open Trade']);
  line.click();
  assert.deepEqual(JSON.parse(JSON.stringify(rig.shell.set)), [{ name: 'trade', opts: { fromClick: true } }]);

  // Nothing about the account read: no line at all, not a name with nothing after it.
  rig.put(state({ wallet: { rows: [intents('USDC', 10)], stale: [], hyperliquid: undefined } }));
  assert.equal(one(rig.host, 'stmt-trade').hidden, true);
  // An account with nothing on it, and one the venue is not answering for, say so.
  rig.put(state({ wallet: { rows: [intents('USDC', 10)], stale: [], hyperliquid: { funded: false } } }));
  assert.deepEqual(words(one(rig.host, 'stmt-trade')), ['Trading account', 'no money in it yet', 'Open Trade']);
  rig.put(state({ wallet: { rows: [intents('USDC', 10)], stale: ['hyperliquid'], hyperliquid: undefined } }));
  assert.deepEqual(words(one(rig.host, 'stmt-trade')), ['Trading account', 'not answering right now', 'Open Trade']);
  // A single open position is one position, and none is none.
  rig.put(state({ wallet: { rows: [intents('USDC', 10), { ...HL, hyperliquid: { ...HL.hyperliquid, openPositions: 0 } }], stale: [], hyperliquid: { funded: true } } }));
  assert.deepEqual(words(one(rig.host, 'stmt-trade'))[1], '$1,046.82 · no positions');
});

test('Pro draws nothing of Hyperliquid but that line, and asks nothing of the trade bundle', () => {
  const rig = boot();
  rig.put(state({ proposals: [{ id: 't1', kind: 'trade', createdAt: '2026-09-23T19:59:00Z', status: 'pending', draft: { kind: 'trade' }, view: { state: 'needs_you', sentence: 'Long ETH, $250 notional, stop 2,590', terminal: false, money: {} } }] }));
  rig.view('pro');
  assert.ok(!words(rig.host).some((w) => /Long ETH/.test(w)), 'a trade is in Pro\'s moves');
  assert.doesNotMatch(PRO, /load\('trade'\)|api\.trade\(|phosphor:trade/, 'Pro reads the trading side again');
  assert.doesNotMatch(CSS, /body\[data-view="pro"\] #view-trade/, 'the deck is back on Pro');
  assert.doesNotMatch(CSS, /trade-rail|trade-panels|trade-strip/, 'Pro styles the deck again');
});

/* ---------- the policies ---------- */

test('Policies: three dials from the policy and the engine\'s own total, the day\'s ceiling under them', () => {
  const rig = boot();
  rig.put(state());
  const card = one(rig.host, 'stmt-policies');
  assert.equal(card.getAttribute('aria-label'), 'Policies');
  assert.deepEqual(withClass(card, 'dial-figure').map((f) => f.textContent), ['$100', '$10,000', '$14.22']);
  assert.deepEqual(withClass(card, 'dial-of').filter((n) => !n.hidden).map((n) => n.textContent), ['of $500']);
  assert.deepEqual(withClass(card, 'dial').map((d) => d.childNodes[1].textContent), ['Asks you above', 'Never more in one move', 'On its own today, then it asks again']);
  assert.equal(one(card, 'stmt-policies-foot').textContent, 'Up to $25,000 a day');
  assert.deepEqual(words(one(card, 'stmt-freeze')), ['Freeze is off']);
  assert.ok(withClass(card, 'dial-figure').every((f) => f.className.includes('num')), 'a figure not set as a figure');

  rig.put(state({ policy: { ...POLICY, killSwitch: true } }));
  assert.deepEqual(words(one(rig.host, 'stmt-freeze')), ['Freeze is on']);
  assert.equal(one(rig.host, 'stmt-freeze').getAttribute('data-on'), 'true');
});

/* The finish reviews, 2026-09-24: $100 of a $10,000 cap is 1 of the dial's 100, and at 1 the
   round caps met in a dot on the top that read as a knob; at 6 with a round cap at both ends the
   arc was still mostly caps, a capsule that read as a knob too. An arc above nothing shows at
   least 8 of the 100 from the top: it leaves the top square and stops a head (1.7) short, and the
   head, a dot the stroke's width, sits on its end. The track is a faint full ring, so the arc
   reads as how far round it has come. */
test('a small share still sweeps from the top over a faint full track, and a full dial is the whole ring', () => {
  const rig = boot({ svg: true });
  rig.put(state());
  const parts = withClass(one(rig.host, 'stmt-policies'), 'dial').map((d) => d.children[0].children[0].children);
  assert.ok(parts.every((p) => p[1] && p[1].getAttribute('class') === 'dial-arc'), 'no arc on a dial');
  assert.ok(parts.every((p) => p[2] && p[2].getAttribute('class') === 'dial-head'), 'no head on a dial');
  const [ask, cap, auto] = parts.map((p) => ({ arc: p[1], head: p[2] }));
  assert.equal(ask.arc.style.strokeDasharray, '6.30 100', 'the $100 dial is a knob again');
  assert.equal(ask.head.style.strokeDashoffset, '-6.30');
  assert.equal(cap.arc.style.strokeDasharray, '100 100');
  assert.equal(cap.head.style.strokeDashoffset, '-99.99', 'a full ring\'s head is not where it closes');
  assert.equal(auto.arc.style.strokeDasharray, '6.30 100', '$14.22 of $500 is under the floor');
  assert.equal(auto.head.style.strokeDashoffset, '-6.30');
  // A share past the floor draws itself: $250 of $500 on its own is half the ring.
  rig.put(state({ autoLimit: { capUsd: 500, spentUsd: 250, resetsAt: null } }));
  assert.equal(auto.arc.style.strokeDasharray, '48.30 100');
  assert.equal(auto.head.style.strokeDashoffset, '-48.30');
  // Nothing spent is an empty track and no arc.
  rig.put(state({ autoLimit: { capUsd: 500, spentUsd: 0, resetsAt: null } }));
  assert.equal(auto.arc.style.strokeDasharray, '0 100');
  assert.equal(withClass(rig.host, 'dial')[2].getAttribute('data-empty'), 'true');
  assert.match(CSS, /\.dial-track \{ stroke: rgba\(var\(--hi-rgb\), 0\.07\); \}/, 'the track is a dark groove again');
  // Only the head is round: a round cap on the arc's tail puts the capsule back.
  assert.doesNotMatch(CSS, /\.dial-arc \{[^}]*stroke-linecap: round/, 'the arc wears a round tail again');
  assert.match(CSS, /\.dial-head \{[^}]*stroke-linecap: round;[^}]*stroke-dasharray: 0\.01 100;/);
});

test('policies that cannot be read are one sentence, and no dial draws a number it was not given', () => {
  const rig = boot();
  rig.put(state({ policy: null, dailyLimit: null, autoLimit: null }));
  assert.equal(one(rig.host, 'dials').hidden, true);
  assert.equal(one(rig.host, 'stmt-policies-foot').hidden, true);
  assert.ok(words(one(rig.host, 'stmt-policies')).includes('Your policies could not be read, so nothing moves until they can.'));
  // A backend without the auto total: the third dial is the allowance itself, named as that,
  // never a spent figure it does not have.
  rig.put(state({ autoLimit: undefined }));
  const auto = withClass(rig.host, 'dial')[2];
  assert.equal(one(auto, 'dial-figure').textContent, '$500');
  assert.equal(auto.childNodes[1].textContent, 'On its own each day, then it asks again');
  assert.equal(auto.getAttribute('data-empty'), 'true', 'an arc was drawn for a total nobody read');
});

/* ---------- the recent moves ---------- */

const RECEIPTS = [
  { id: 'p_auto', kind: 'swap', at: '2026-09-23T19:58:00Z', status: 'executed', headline: 'Changed $14.22 of your US dollars (USDC) into Ether (ETH).', summary: '', amount: 14.22, symbol: 'USDC', received: { symbol: 'ETH', amount: 0.0053 } },
  { id: 'p_fund', kind: 'hl_deposit', at: '2026-09-23T17:00:00Z', status: 'executed', headline: 'Moved $100.00 of your US dollars (USDC) to your Hyperliquid trading account.', summary: '', amount: 100, symbol: 'USDC', received: null },
  { id: 'p_trade', kind: 'trade', at: '2026-09-23T16:30:00Z', status: 'executed', headline: 'Closed your ETH long.', summary: '', amount: null, symbol: null, received: null },
  { id: 'p_fail', kind: 'swap', at: '2026-09-23T15:00:00Z', status: 'failed', headline: 'Tried to change $10.00 of your US dollars (USDC) into Solana (SOL).', summary: '', amount: 10, symbol: 'USDC', received: { symbol: 'SOL', amount: 0 } },
];

function waiting(): Any {
  return {
    id: 'p_wait', kind: 'swap', createdAt: '2026-09-23T19:59:40Z', status: 'pending',
    draft: { kind: 'swap', fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: 50 },
    view: { state: 'needs_you', stage: 'waiting_for_you', terminal: false, waitingOn: 'You', sentence: '50 USDC to ETH, inside NEAR Intents', createdAt: '2026-09-23T19:59:40Z', decidedAt: null, money: { symbol: 'USDC', toSymbol: 'ETH', amountIn: '50', amountOut: null } },
  };
}

test('recent moves: newest first, a few words each, the state in the card\'s words, and no trade', async () => {
  const rig = boot({ receipts: RECEIPTS });
  rig.put(state({ proposals: [waiting(), { id: 'p_auto', kind: 'swap', createdAt: '2026-09-23T19:57:50Z', status: 'executed', decidedBy: 'policy', draft: { kind: 'swap' }, view: { terminal: true, state: 'done' } }] }));
  rig.view('pro');
  await tick();
  const moves = withClass(one(rig.host, 'moves'), 'move');
  assert.deepEqual(moves.map((m) => one(m, 'move-title').textContent), [
    'Swap 50 USDC to ETH',
    'Swapped 14.22 USDC to 0.0053 ETH',
    'Moved 100 USDC to trading',
    'Swap 10 USDC to SOL',
  ]);
  assert.deepEqual(moves.map((m) => words(one(m, 'move-state')).join('')), ['Needs your OK', 'Done', 'Done', 'Didn\'t go through']);
  assert.equal(one(moves[0], 'move-state').getAttribute('data-dir'), 'ask', 'the ask does not wear the live light');
  assert.equal(one(moves[1], 'move-meta').textContent, '2 minutes ago, on its own', 'a move the policy ran does not say so');
  assert.equal(one(moves[0], 'move-meta').textContent, 'Just now');
  // An ended move opens its receipt.
  one(rig.host, 'moves').dispatchEvent({ type: 'click', target: one(moves[1], 'move-title') });
  assert.equal(rig.events.at(-1)?.type, 'receipt:open');
  assert.equal(rig.events.at(-1)?.detail.receipt.id, 'p_auto');
});

test('a move under way says what it is doing, and a late one stays in the list as under way', async () => {
  const rig = boot();
  const going = { ...waiting(), id: 'p_go', status: 'executing', view: { ...waiting().view, state: 'working', stage: 'PENDING', waitingOn: '1Click', decidedAt: '2026-09-23T19:59:00Z' } };
  const late = { ...waiting(), id: 'p_late', kind: 'intents_send', status: 'executing', createdAt: '2026-09-23T19:30:00Z', draft: { kind: 'intents_send', symbol: 'NEAR', amount: 25, to: 'maya.near' }, view: { state: 'working', stage: 'stalled', terminal: true, settlesForward: true, createdAt: '2026-09-23T19:30:00Z', decidedAt: '2026-09-23T19:30:00Z', money: { symbol: 'NEAR', toSymbol: 'NEAR', amountIn: '25' } } };
  rig.put(state({ proposals: [going, late] }));
  const moves = withClass(one(rig.host, 'moves'), 'move');
  assert.deepEqual(moves.map((m) => one(m, 'move-title').textContent), ['Swap 50 USDC to ETH', 'Send 25 NEAR to maya.near']);
  assert.deepEqual(moves.map((m) => words(one(m, 'move-state')).join('')), ['Swapping', 'Taking longer']);
  assert.equal(one(moves[0], 'move-meta').textContent, 'Started 1 minute ago');
});

/* ---------- the two things to do ---------- */

test('Swap puts the word in the box for the person to finish, and says what to do first with no agent', () => {
  const rig = boot();
  rig.put(state());
  const [swap, add] = withClass(one(rig.host, 'stmt-actions'), 'stmt-act');
  assert.deepEqual([words(swap), words(add)], [['Swap'], ['Add money']]);
  assert.ok(!swap.className.includes('btn-primary') && !add.className.includes('btn-primary'), 'green is for Approve');
  swap.click();
  assert.equal(rig.composer.value, 'Swap ');
  assert.equal(rig.composer.focused, true);
  assert.equal(one(rig.host, 'stmt-note').hidden, true);
  // Words the person already typed stay: the box is theirs.
  rig.composer.value = 'what is ETH doing';
  swap.click();
  assert.equal(rig.composer.value, 'what is ETH doing');
  rig.composer.disabled = true;
  swap.click();
  assert.equal(one(rig.host, 'stmt-note').textContent, 'Start your agent, then tell it what to swap.');
  assert.equal(one(rig.host, 'stmt-note').hidden, false);
});

test('Add money runs the deposit steps in place of the ledger, and Close puts the page back', () => {
  const rig = boot();
  rig.put(state());
  const add = withClass(one(rig.host, 'stmt-actions'), 'stmt-act')[1];
  add.click();
  assert.equal(one(rig.host, 'stmt-flow').hidden, false);
  assert.equal(one(rig.host, 'stmt-ledger').hidden, true);
  assert.equal(one(rig.host, 'stmt-duo').hidden, true);
  assert.equal(one(rig.host, 'stmt-total').hidden, false, 'the total left the screen while the money lands');
  assert.equal(rig.opened.length, 1, 'the existing deposit steps were not opened');
  const close = withClass(one(rig.host, 'stmt-flow'), 'btn')[0];
  close.click();
  assert.equal(one(rig.host, 'stmt-flow').hidden, true);
  assert.equal(one(rig.host, 'stmt-ledger').hidden, false);
  assert.ok(rig.opened.some((o) => o.destroyed), 'the steps kept their watch after Close');
  assert.equal(add.focused, true, 'focus goes back to Add money');
});

/* ---------- the layout ---------- */

test('the statement reflows the way the mockup does, and keeps the stage every world shares', () => {
  // One width on Pro, Trade and the Vault, so the conversation holds still when the tab changes.
  assert.match(CSS, /body\[data-view="pro"\] \.stage,\s*body\[data-view="trade"\] \.stage,\s*body\[data-view="vault"\] \.stage\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) clamp\(560px, min\(var\(--trade, 66\.667vw\), calc\(100vw - 380px\)\), 1400px\);/);
  assert.equal((CSS.match(/grid-template-columns:\s*minmax\(0, 1fr\) clamp\(/g) || []).length, 1, 'a second stage width');
  // Its own width, not the world's: the world is still on its way while the stage slides.
  assert.match(CSS, /#view-pro\s*\{\s*container-type:\s*inline-size;\s*container-name:\s*prostmt;/);
  // 860: the legend and the amount column step out; 700: the panels stack, the price is its line.
  const at860 = CSS.slice(CSS.indexOf('@container prostmt (max-width: 860px)'));
  assert.match(at860, /\.stmt-legend\s*\{\s*display:\s*none;/);
  assert.match(at860, /\.l-row > :nth-child\(4\)\s*\{\s*display:\s*none;/);
  const at700 = CSS.slice(CSS.indexOf('@container prostmt (max-width: 700px)'));
  assert.match(at700, /\.stmt-duo\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(at700, /\.l-head-short\s*\{\s*display:\s*inline;/, 'the price head wraps on a narrow page');
  // Beside the policies at 1180, a move keeps its whole line and its state steps down beside the
  // time, rather than cutting "Swap 50 USDC to ETH" before where the money goes.
  const narrow = CSS.slice(CSS.indexOf('@container moves (max-width: 360px)'));
  assert.match(narrow, /"icon title title"\s*"icon meta state"/);
  assert.match(narrow, /\.move-words \{ display: contents; \}/);
  // A window up to 920 tall, the app's default 780 and a 900 tall screen among them, lists three
  // moves and tightens the coin rows (never the head row), so at 1440 by 900 the statement stands
  // whole over the notice (the finish review, 2026-09-24).
  assert.match(CSS, /@media \(max-height: 920px\)\s*\{\s*\.stmt-moves \.move:nth-child\(n\+4\)\s*\{\s*display:\s*none;\s*\}\s*\.l-rows > \.l-row \{ min-height: 52px; \}/);
  // The two cards end on one line, a one line caption hangs under its dial, and the day's
  // ceiling sits centred under the dials.
  assert.match(CSS, /\.stmt-duo \{[^}]*align-items: stretch;/);
  assert.match(CSS, /\n\.dial \{[^}]*align-content: start;/);
  assert.match(CSS, /\.stmt-policies-foot \{[^}]*text-align: center;/);
});

/* ---------- Policies, one press from Basic ---------- */

test('the Vault\'s Policies row is the place Basic\'s button lands, brought into view once the tracks have landed', () => {
  assert.match(VAULT, /row\('Policies', 'rules'\)/);
  assert.match(VAULT, /setAttribute\('data-reveal', 'policies'\)/);
  // Measured once the slide is over, not as the view comes up: measured mid-slide it landed the
  // row's head 179 px above the slab at 1180 by 780.
  assert.match(SHELL, /sliding = window\.setTimeout\(function \(\) \{\s*endSlide\(\);\s*if \(pendingReveal\) reveal\(\);\s*\}, slideMs\(\) \+ 60\);/);
  assert.match(SHELL, /function revealSoon\(\) \{[\s\S]*?if \(!sliding\) reveal\(\);/);
  assert.match(SHELL, /world\.scrollTo\(\{ top: top, behavior: 'smooth' \}\)/, 'the world does not glide there');
  assert.doesNotMatch(SHELL.slice(SHELL.indexOf('function lightOnce')), /--ink|--up\b|ink\)/, 'the arrival lights in green, the live move\'s light');
});
