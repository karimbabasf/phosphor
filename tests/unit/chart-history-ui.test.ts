// The window's side of unlimited history: a pan that never hits an app-side wall, older bars
// asked for behind the left edge and put in front of the ones held without a jump, and a
// squeeze that folds bars per pixel column instead of drawing twenty thousand smears.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

function loadChartUi(): Sandbox {
  const source = readFileSync(new URL('../../ui/chart/chart.js', import.meta.url), 'utf8');
  const sandbox: Sandbox = {
    window: {
      requestAnimationFrame: () => 1,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
    },
    document: { getElementById: () => null, addEventListener: () => {} },
    fetch: async () => {
      throw new Error('these tests never reach the network unless they say so');
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    console,
  };
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'ui/chart/chart.js' });
  runInContext(readFileSync(new URL('../../ui/chart/labels.js', import.meta.url), 'utf8'), sandbox, { filename: 'ui/chart/labels.js' });
  return sandbox;
}

const fakeCtx = { font: '', measureText: (text: string) => ({ width: text.length * 6 }) };
const T0 = 1_760_000_000;

function bars(count: number, startT = T0): { t: number; o: number; h: number; l: number; c: number; v: number }[] {
  const out = [];
  for (let i = 0; i < count; i++) {
    const up = i % 2 === 0;
    out.push({ t: startT + i * 60, o: 100, h: 104, l: 96, c: up ? 102 : 98, v: 10 + (i % 5) });
  }
  return out;
}

function ready(s: Sandbox, count: number, over: Record<string, unknown> = {}): void {
  s.CHART_READY = true;
  s.CHART.candles = bars(count);
  s.CHART.view = { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: count, panOffset: 0, priceScale: { mode: 'auto' } };
  s.CHART.dataView = { product: 'BTC-USD', granularitySec: 60 };
  s.CHART.meta = { source: 'hyperliquid', stale: false, built: 'candles', error: null, exhaustedBack: false, oldest: null };
  Object.assign(s.CHART, over);
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

// ---------- the squeeze ----------

test('twenty thousand bars across an 800 px plot fold into at most 800 columns', () => {
  const s = loadChartUi();
  ready(s, 20000);
  s.CHART_AXIS_W = 72;
  const L = s.buildLayout(872, 600, fakeCtx);
  assert.equal(L.end - L.start + 1, 20000, 'every bar is in view');
  assert.ok(L.slot < s.LOD_SLOT_PX, `a bar is ${L.slot} px wide, under the fold threshold`);
  const columns = s.candleColumns(L);
  assert.ok(columns.length <= 800, `${columns.length} columns for 800 px`);
  assert.ok(columns.length >= 700, `and the plot is filled, not ${columns.length} columns`);
  // Each column is an honest bar of the minutes under it.
  const first = columns[0];
  assert.equal(first.o, s.CHART.candles[first.first].o);
  assert.equal(first.c, s.CHART.candles[first.last].c);
  assert.equal(first.h, 104);
  assert.equal(first.l, 96);
  let volume = 0;
  for (let i = first.first; i <= first.last; i++) volume += s.CHART.candles[i].v;
  assert.equal(first.v, volume);
});

test('the window may squeeze to the server\'s ceiling, not to two thousand', () => {
  const s = loadChartUi();
  ready(s, 100);
  s.setBarCount(15000);
  assert.equal(s.CHART.view.barCount, 15000);
  s.setBarCount(1e9);
  assert.equal(s.CHART.view.barCount, s.CHART_BARS.max);
  assert.equal(s.CHART_BARS.max, 20000);
});

// ---------- the pan ----------

test('a pan back is not clamped at four hundred, and stops only at the venue\'s first bar', () => {
  const s = loadChartUi();
  ready(s, 3000);
  s.setPan(2500);
  assert.equal(s.CHART.view.panOffset, 2500, 'the old wall at 400 is gone');
  s.setPan(1e9);
  assert.equal(s.CHART.view.panOffset, s.CHART_BARS.panMax, 'bounded by the cache depth, which the payload sets');

  // The venue said it has nothing older than the first bar held: the first bar may come as far
  // as the last quarter of the plot and no further.
  s.CHART.view.barCount = 100;
  s.CHART.meta.exhaustedBack = true;
  s.CHART.meta.oldest = s.CHART.candles[0].t;
  s.setPan(1e9);
  assert.equal(s.CHART.view.panOffset, 3000 - 25);
});

test('older bars go in front of the ones held, the pan does not move, and the plots are laid down again', () => {
  const s = loadChartUi();
  ready(s, 200, {
    indicators: [{ id: 'ema-1', type: 'ema', label: 'ema 3', pane: 'price', source: 'human', plots: [{ key: 'ema', values: new Array(200).fill(1) }] }],
  });
  s.CHART.view.panOffset = 150;
  const older = bars(300, T0 - 300 * 60).concat([s.CHART.candles[0]]);
  s.prependCandles(older);
  assert.equal(s.CHART.candles.length, 500, 'three hundred older bars, and the overlapping one was not doubled');
  assert.equal(s.CHART.candles[0].t, T0 - 300 * 60);
  assert.equal(s.CHART.candles[300].t, T0);
  assert.equal(s.CHART.view.panOffset, 150, 'anchored at the newest bar, so a prepend moves nothing on screen');
  const values = s.CHART.indicators[0].plots[0].values;
  assert.equal(values.length, 500);
  assert.equal(values[299], null);
  assert.equal(values[300], 1);
});

test('a live bar landing while the window is panned back appends without trimming the history it is looking at', () => {
  const s = loadChartUi();
  ready(s, 3000);
  s.CHART.view.barCount = 100;
  s.CHART.view.panOffset = 2800;
  const last = s.CHART.candles[s.CHART.candles.length - 1];
  s.candleLive({ type: 'candle', product: 'BTC-USD', provider: 'hyperliquid', baseSec: 60, candle: { t: last.t + 60, o: 1, h: 2, l: 0.5, c: 1, v: 1 } });
  assert.equal(s.CHART.candles.length, 3001, 'nothing was trimmed');
  assert.equal(s.CHART.view.panOffset, 2801, 'the bar under the eye is still the bar under the eye');
});

// ---------- the backfill ----------

test('the left edge nearing the oldest bar held asks for the bars before it, once, and prepends them', async () => {
  const s = loadChartUi();
  ready(s, 200);
  s.CHART.view.barCount = 120;
  s.CHART.view.panOffset = 60;
  const asked: string[] = [];
  s.fetch = async (url: string) => {
    asked.push(url);
    return {
      ok: true,
      headers: { get: (name: string) => (name === 'x-candle-exhausted-back' ? 'false' : name === 'x-candle-oldest' ? '' : null) },
      json: async () => bars(2000, T0 - 2000 * 60),
    };
  };
  const L = s.buildLayout(872, 600, fakeCtx);
  assert.ok(L.start <= s.CHART_FETCH_MARGIN, `the left edge is inside the margin at ${L.start}`);
  s.maybeBackfill(L);
  s.maybeBackfill(L);
  assert.equal(asked.length, 1, 'one request in flight at a time');
  assert.match(asked[0] as string, /^\/api\/candles\?product=BTC-USD&granularity=60&before=1760000000&limit=2000&provider=auto$/);
  await settle();
  assert.equal(s.CHART.candles.length, 2200);
  assert.equal(s.CHART.view.panOffset, 60);
  assert.equal(s.CHART_BACKFILL.inflight, false);

  // Far from the edge now: nothing more is asked for.
  s.maybeBackfill(s.buildLayout(872, 600, fakeCtx));
  assert.equal(asked.length, 1);
});

test('a venue that has no more is not asked again, and the chart says where history begins', async () => {
  const s = loadChartUi();
  ready(s, 200);
  s.CHART.view.barCount = 120;
  s.CHART.view.panOffset = 60;
  const asked: string[] = [];
  s.fetch = async (url: string) => {
    asked.push(url);
    return {
      ok: true,
      headers: { get: (name: string) => (name === 'x-candle-exhausted-back' ? 'true' : name === 'x-candle-oldest' ? String(T0 - 30 * 60) : null) },
      json: async () => bars(30, T0 - 30 * 60),
    };
  };
  s.maybeBackfill(s.buildLayout(872, 600, fakeCtx));
  await settle();
  assert.equal(s.CHART.candles.length, 230);
  assert.equal(s.CHART.meta.exhaustedBack, true);
  assert.equal(s.CHART.meta.oldest, T0 - 30 * 60);
  assert.equal(s.historyBegins(), true);
  s.maybeBackfill(s.buildLayout(872, 600, fakeCtx));
  await settle();
  assert.equal(asked.length, 1, 'history begins here: nothing to ask for');

  // The note is drawn beside the bars once the first bar is on screen.
  s.CHART.view.panOffset = 230;
  const printed: string[] = [];
  const ctx = { fillStyle: '', fillText: (text: string) => printed.push(String(text)), fillRect: () => {}, measureText: (text: string) => ({ width: text.length * 6 }) };
  const L = s.buildLayout(872, 600, fakeCtx);
  s.VOLUME_ON = false;
  s.drawChartNotes(ctx, L);
  assert.ok(printed.some((line) => /history begins here/.test(line)), printed.join(' | '));
});

test('a backfill that lands after the market changed is dropped, not prepended to another chart', async () => {
  const s = loadChartUi();
  ready(s, 200);
  s.CHART.view.panOffset = 60;
  let release: (v: unknown) => void = () => {};
  s.fetch = async () => {
    await new Promise((r) => (release = r));
    return { ok: true, headers: { get: () => 'false' }, json: async () => bars(100, T0 - 100 * 60) };
  };
  s.maybeBackfill(s.buildLayout(872, 600, fakeCtx));
  await settle();
  // The hand picked another market while the request was out.
  s.CHART.candles = bars(50, T0 + 10_000_000);
  s.CHART.dataView = { product: 'SOL-USD', granularitySec: 60 };
  release(null);
  await settle();
  assert.equal(s.CHART.candles.length, 50, 'the older BTC bars never reached the SOL chart');
});
