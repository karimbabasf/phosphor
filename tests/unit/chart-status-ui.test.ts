// The status cluster above the chart: the state word and the delay beside it.
//
// The delay is the one number on the bar that used to be about the wrong thing. It came off the
// trading payload as the age of the account snapshot, which Hyperliquid pushes every 5 s, so it
// climbed from 0 to 5000 ms and reset while the price moved every half second. It is the venue's
// delay on the socket serving the bars now, carried on the chart payload's meta, and it is the
// engine that writes it.

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

test('a live feed prints the venue delay beside the state word, rounded to the millisecond', () => {
  const { s, feed, word, latency } = loadChartUi();
  s.applyChart(payload({ feed: 'live', latencyMs: 141.4 }));
  s.renderChartStatus();
  assert.equal(feed.dataset.feed, 'live');
  assert.equal(word.textContent, 'live');
  assert.equal(latency.textContent, '141 ms');
});

test('the delay is a measurement, not a clock: a repaint without a new payload prints the same number', () => {
  const { s, latency } = loadChartUi();
  s.applyChart(payload({ feed: 'live', latencyMs: 140 }));
  s.renderChartStatus();
  s.renderChartStatus();
  s.renderChartStatus();
  assert.equal(latency.textContent, '140 ms');
});

test('no delay prints nothing, never a zero, and a delayed feed carries none', () => {
  const { s, feed, latency } = loadChartUi();
  s.applyChart(payload({ feed: 'live', latencyMs: null }));
  s.renderChartStatus();
  assert.equal(latency.textContent, '');

  s.applyChart(payload({ feed: 'delayed', latencyMs: null }));
  s.renderChartStatus();
  assert.equal(feed.dataset.feed, 'delayed');
  assert.equal(latency.textContent, '');

  // A payload from before the field existed.
  s.applyChart(payload({ feed: 'live' }));
  s.renderChartStatus();
  assert.equal(latency.textContent, '');
});
