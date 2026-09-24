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
  textContent: string;
  title: string;
  dataset: Record<string, string>;
  childNodes: FakeEl[];
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: () => FakeEl[];
  appendChild: (child: FakeEl) => FakeEl;
  remove: () => void;
};

function el(id: string, tagName = 'span'): FakeEl {
  const node: FakeEl = {
    id,
    tagName,
    textContent: '',
    title: '',
    dataset: {},
    childNodes: [],
    querySelector: (sel) => node.childNodes.find((c) => c.tagName === sel) ?? null,
    querySelectorAll: () => [],
    appendChild: (child) => {
      node.childNodes.push(child);
      return child;
    },
    remove: () => {},
  };
  return node;
}

/* The cluster exactly as ui/screens/trade.js builds it: the feed span holding a dot, the state
   word and the latency slot, inside the status cluster. */
function loadChartUi(): { s: Sandbox; feed: FakeEl; word: FakeEl; latency: FakeEl } {
  const feed = el('chart-feed');
  const word = el('', 'b');
  const latency = el('chart-latency');
  feed.appendChild(el('', 'i'));
  feed.appendChild(word);
  feed.appendChild(latency);
  const byId: Record<string, FakeEl> = { 'chart-status': el('chart-status'), 'chart-feed': feed, 'chart-latency': latency };
  const s: Sandbox = {
    window: { requestAnimationFrame: () => 1, matchMedia: () => ({ matches: false }), addEventListener: () => {} },
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
  return { s, feed, word, latency };
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
