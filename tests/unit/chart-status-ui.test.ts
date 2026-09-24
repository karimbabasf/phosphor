// The status cluster above the chart: the words that answer "can I trust this price now".
//
// The delay beside the state word was the one number on the bar that meant nothing to a
// person: a socket's round trip in milliseconds. Live now says Live and nothing else, a slow
// feed says how often it moves, and a paused one says the prices on screen are the last ones.
// The latency slot is still built for the engine and is left empty.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

type FakeEl = {
  id: string;
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  childNodes: FakeEl[];
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: () => FakeEl[];
  appendChild: (child: FakeEl) => FakeEl;
  setAttribute: (name: string, value: string) => void;
  remove: () => void;
};

function el(id: string, tagName = 'span'): FakeEl {
  const node: FakeEl = {
    id,
    tagName,
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    attrs: {},
    childNodes: [],
    querySelector: (sel) => node.childNodes.find((c) => c.tagName === sel) ?? null,
    querySelectorAll: () => [],
    appendChild: (child) => {
      node.childNodes.push(child);
      return child;
    },
    setAttribute: (name, value) => {
      node.attrs[name] = String(value);
    },
    remove: () => {},
  };
  return node;
}

/* The cluster exactly as ui/screens/trade.js builds it: the feed span holding a dot, the state
   word and the latency slot, inside the status cluster. With icons, the window carries the icon
   set's svg() the way ui/design/icons.js lays it on. */
function loadChartUi(opts: { icons?: boolean } = {}): { s: Sandbox; status: FakeEl; feed: FakeEl; word: FakeEl; latency: FakeEl } {
  const feed = el('chart-feed');
  const word = el('', 'b');
  const latency = el('chart-latency');
  feed.appendChild(el('', 'i'));
  feed.appendChild(word);
  feed.appendChild(latency);
  const status = el('chart-status');
  const byId: Record<string, FakeEl> = { 'chart-status': status, 'chart-feed': feed, 'chart-latency': latency };
  const icons = {
    svg: (name: string, className: string) => {
      const node = el('', 'svg');
      node.className = 'icon ' + className;
      node.dataset.icon = name;
      return node;
    },
  };
  const s: Sandbox = {
    window: { requestAnimationFrame: () => 1, matchMedia: () => ({ matches: false }), addEventListener: () => {}, ...(opts.icons ? { PhosphorIcons: icons } : {}) },
    document: {
      getElementById: (id: string) => byId[id] ?? null,
      createElement: (tag: string) => el('', tag),
      addEventListener: () => {},
    },
    fetch: async () => {
      throw new Error('these tests never reach the network');
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    console,
  };
  createContext(s);
  runInContext(readFileSync(new URL('../../ui/chart/chart.js', import.meta.url), 'utf8'), s, { filename: 'ui/chart/chart.js' });
  runInContext(readFileSync(new URL('../../ui/chart/labels.js', import.meta.url), 'utf8'), s, { filename: 'ui/chart/labels.js' });
  return { s, status, feed, word, latency };
}

const MINUTE = 1_760_000_400;

function payload(meta: Record<string, unknown>) {
  return {
    rev: 1,
    lastDriver: 'human',
    view: { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: 120, panOffset: 0, priceScale: { mode: 'auto' } },
    candles: [{ t: MINUTE, o: 100, h: 101, l: 99, c: 100, v: 2 }],
    meta: { source: 'hyperliquid', stale: false, built: 'candles', ...meta },
    indicators: [],
    levels: [],
    marks: [],
    products: ['BTC-USD'],
    timeframes: [{ sec: 60, label: '1m' }],
  };
}

test('a live feed says Live and nothing else: the round trip is an engineer\'s number', () => {
  const { s, feed, word, latency } = loadChartUi();
  s.applyChart(payload({ feed: 'live', latencyMs: 141.4 }));
  s.renderChartStatus();
  assert.equal(feed.dataset.feed, 'live');
  assert.equal(word.textContent, 'Live');
  assert.equal(latency.textContent, '');
});

test('a slow feed says how often it moves, and a paused one that the prices are the last ones', () => {
  const { s, feed, word } = loadChartUi();
  s.applyChart(payload({ feed: 'delayed', latencyMs: null }));
  s.renderChartStatus();
  assert.equal(feed.dataset.feed, 'delayed');
  assert.equal(word.textContent, 'Updates every few seconds');

  s.applyChart(payload({ feed: 'offline' }));
  s.renderChartStatus();
  assert.equal(feed.dataset.feed, 'offline');
  assert.equal(word.textContent, 'Prices paused, showing the last ones');
  // The reason is in words, never the source's own error string.
  assert.ok(!/error|unreachable/i.test(feed.title), feed.title);
});

test('the delay slot stays empty whatever the payload carries', () => {
  const { s, latency } = loadChartUi();
  for (const meta of [{ feed: 'live', latencyMs: 140 }, { feed: 'live', latencyMs: null }, { feed: 'delayed' }, { feed: 'live' }]) {
    s.applyChart(payload(meta));
    s.renderChartStatus();
    assert.equal(latency.textContent, '');
  }
});

/* The finish reviews, 2026-09-24: on the 960 window the person's clear read "Clear 13", with no
   noun, and the field beside it read "Add indica". The clear is built of pieces, the bin, the
   verb, the count and the noun, so the narrowest chart can show the bin and the count alone
   (ui/design/trade.css), and its name is the whole sentence at every width. */
test('the clear is the bin, the verb, the count and the noun, named in full', () => {
  const { s, status } = loadChartUi({ icons: true });
  s.applyChart({ ...payload({ feed: 'live' }), agentObjects: 13 });
  s.renderChartStatus();
  const clear = status.childNodes.find((n) => n.id === 'chart-clear-agent');
  assert.ok(clear, 'no clear on the bar');
  assert.equal(clear.tagName, 'button');
  assert.deepEqual(clear.childNodes.map((n) => [n.className, n.textContent]), [
    ['icon chart-extra-icon', ''],
    ['chart-extra-verb', 'Clear'],
    ['chart-extra-count', '13'],
    ['chart-extra-word', 'drawings'],
  ]);
  assert.equal(clear.childNodes[0].dataset.icon, 'trash');
  assert.equal(clear.attrs['aria-label'], 'Clear 13 drawings');

  // One drawing is one drawing, and without the icon set the words still stand.
  const bare = loadChartUi();
  bare.s.applyChart({ ...payload({ feed: 'live' }), agentObjects: 1 });
  bare.s.renderChartStatus();
  const one = bare.status.childNodes.find((n) => n.id === 'chart-clear-agent');
  assert.ok(one, 'no clear without the icon set');
  assert.deepEqual(one.childNodes.map((n) => n.textContent), ['Clear', '1', 'drawing']);
  assert.equal(one.attrs['aria-label'], 'Clear 1 drawing');

  // The narrowest chart trades the words for the bin, after the rule that hides the bin.
  const css = readFileSync(new URL('../../ui/design/trade.css', import.meta.url), 'utf8');
  const hidden = css.indexOf('.chartstatus .chart-extra-icon {\n  display: none;');
  const narrow = css.search(/\.chartstatus \.chart-extra-verb,\n {2}\.chartstatus \.chart-extra-word \{ display: none; \}\n {2}\.chartstatus \.chart-extra-icon \{ display: block; \}/);
  assert.ok(hidden > 0 && narrow > hidden, 'the bin is not drawn on the narrowest chart');
  // A press on the bin or a word inside the clear is a press on the clear.
  assert.match(readFileSync(new URL('../../ui/chart/chart.js', import.meta.url), 'utf8'), /ev\.target\.closest\('button'\)/);
});
