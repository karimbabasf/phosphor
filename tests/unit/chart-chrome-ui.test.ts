// The chart's chrome: the palette it is drawn in, and the volume pane it now shows by default.
//
// buildLayout is called directly. It is the function that decides what fits, and everything
// visible follows from what it returns, so it is the honest unit to test: a fake 2d context
// only has to answer measureText, which is all the geometry depends on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME } from '../../src/view/theme.ts';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

function loadChartUi(): Sandbox {
  const source = readFileSync(new URL('../../ui/chart/chart.js', import.meta.url), 'utf8');
  const store: Record<string, string> = {};
  const sandbox: Sandbox = {
    window: {
      requestAnimationFrame: () => 1,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      localStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
      },
    },
    document: { getElementById: () => null, addEventListener: () => {} },
    fetch: async () => {
      throw new Error('these tests never reach the network');
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    console,
  };
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'ui/chart/chart.js' });
  // The label column the engine draws its legend through lives in its own file.
  runInContext(readFileSync(new URL('../../ui/chart/labels.js', import.meta.url), 'utf8'), sandbox, { filename: 'ui/chart/labels.js' });
  return sandbox;
}

// Only measureText is read out of the context, and only to size the price axis.
const fakeCtx = { font: '', measureText: (text: string) => ({ width: text.length * 6 }) };

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function bars(count: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const up = i % 2 === 0;
    out.push({
      t: 1_760_000_400 + i * 60,
      o: 100,
      h: 104,
      l: 96,
      c: up ? 102 : 98,
      v: 10 + i,
    });
  }
  return out;
}

function ready(sandbox: Sandbox, over: Record<string, unknown> = {}): void {
  sandbox.CHART.candles = bars(40);
  sandbox.CHART.view = {
    product: 'BTC-USD',
    provider: 'auto',
    granularitySec: 60,
    barCount: 40,
    panOffset: 0,
    priceScale: { mode: 'auto' },
  };
  sandbox.CHART.dataView = { product: 'BTC-USD', granularitySec: 60 };
  Object.assign(sandbox.CHART, over);
}

const paneOf = (layout: any, label: string) =>
  layout.panes.find((p: any) => p.indicator.label === label);

// ---------- the palette ----------

test('the chart is not green any more, and every ink is a design token', () => {
  const s = loadChartUi();
  // The mark's own green since 2026-09-14, the same hex as --ink in tokens.css.
  assert.equal(s.C_UP, '#3FFF6C');
  assert.equal(s.C_DOWN, '#FF5A6E');
  // The window moved its graphite in the v2 rebuild and the canvas follows it: these two
  // are the fallbacks the engine draws with before the stylesheet is in, so a hairline that
  // does not match --line is a seam a person can see for the first frame.
  assert.equal(s.CHART_TOKENS.line, '#262729');
  assert.equal(s.CHART_TOKENS.text2, '#9BA1AB');
  // The four inks the engine mixes from, named for meaning rather than for a colour.
  assert.equal(s.accent(0.5), 'rgba(91, 141, 239, 0.5)');
  assert.equal(s.danger(1), 'rgba(255, 90, 110, 1)');
  assert.equal(s.lineInk(1), 'rgba(38, 39, 41, 1)');
  assert.equal(s.text2(0.7), 'rgba(155, 161, 171, 0.7)');
  assert.equal(typeof s.green, 'undefined', 'a function called green() returning blue is a lie');
});

test('the shipped defaults leave the chart on its tokens, and a chosen colour wins', () => {
  const s = loadChartUi();
  // The transitional guard that used to sit here compared each slot against the
  // old green defaults and refused them. src/view/theme.ts now ships the design
  // tokens, so a default state frame carries the same values the chart already
  // holds and there is nothing left to refuse.
  // Read off DEFAULT_THEME rather than restated, so moving the palette moves
  // this with it instead of failing a test that is not about the palette.
  const triple = [1, 3, 5].map((at) => parseInt(DEFAULT_THEME.up.slice(at, at + 2), 16)).join(', ');
  s.chartTheme(DEFAULT_THEME);
  assert.equal(s.C_UP, `rgb(${triple})`);
  assert.equal(s.RGB_ACCENT, triple);

  // A colour somebody actually picked still wins. That is what the tool is for.
  s.chartTheme({ ...DEFAULT_THEME, up: '#ffaa00' });
  assert.equal(s.C_UP, 'rgb(255, 170, 0)');
});

// ---------- the volume pane ----------

test('volume is a default, not a word you have to know', () => {
  const s = loadChartUi();
  ready(s);
  const layout = s.buildLayout(900, 600, fakeCtx);
  const pane = paneOf(layout, 'volume');
  assert.ok(pane, 'every chart a trader compares this one to shows volume without being asked');
  assert.equal(layout.panes[0].indicator.label, 'volume', 'it sits directly under the price');
  // About 14 percent of the usable height: read as a shape beside the price, not as a series
  // with values to pick off. Capped at the same ceiling every other pane has, so volume cannot
  // eat a tall chart.
  const usable = 600 - 18 - 3;
  const want = Math.min(usable * 0.14, 96);
  assert.ok(Math.abs(pane.height - want) < 1, `expected ~${want}, got ${pane.height}`);
  assert.equal(layout.priceHeight, usable - pane.height);
});

test('the histogram is the candles being drawn, direction beside it rather than folded in', () => {
  const s = loadChartUi();
  ready(s);
  const plot = paneOf(s.buildLayout(900, 600, fakeCtx), 'volume').indicator.plots[0];
  assert.equal(plot.style, 'histogram');
  assert.deepEqual([...plot.values.slice(0, 3)], [10, 11, 12]);
  // Volume is never negative, so folding the direction into the value would put half the bars
  // under an axis that does not exist.
  assert.deepEqual([...plot.signs.slice(0, 3)], [1, -1, 1]);
});

test('a live bar moves the histogram in the same frame it moves the price', () => {
  const s = loadChartUi();
  ready(s);
  s.CHART.meta = { source: 'hyperliquid', stale: false, built: 'candles', error: null };
  const last = s.CHART.candles[s.CHART.candles.length - 1];
  s.candleLive({
    type: 'candle',
    product: 'BTC-USD',
    provider: 'hyperliquid',
    baseSec: 60,
    candle: { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c, v: 999 },
  });
  const plot = paneOf(s.buildLayout(900, 600, fakeCtx), 'volume').indicator.plots[0];
  assert.equal(plot.values[plot.values.length - 1], 999);
});

test('a volume indicator somebody actually added wins, so the histogram is not drawn twice', () => {
  const s = loadChartUi();
  ready(s, {
    indicators: [
      { id: 'volume', label: 'volume', pane: 'volume', source: 'human', plots: [{ style: 'histogram', values: [] }] },
    ],
  });
  const layout = s.buildLayout(900, 600, fakeCtx);
  const volumes = layout.panes.filter((p: any) => p.indicator.label === 'volume');
  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].indicator.source, 'human', 'the real one, computed by src/indicators.ts');
});

test('volume is dropped, silently, before the price pane stops being readable', () => {
  const s = loadChartUi();
  ready(s);
  // A short panel. A chart that quietly squashes everything to fit is worse than one that
  // says what it could not show, and volume is the one pane nobody asked for.
  const layout = s.buildLayout(900, 170, fakeCtx);
  assert.equal(paneOf(layout, 'volume'), undefined);
  assert.deepEqual([...layout.dropped], [], 'dropping the pane nobody asked for is not worth a complaint');
});

test('an indicator pane keeps its room and volume gives up its own first', () => {
  const s = loadChartUi();
  ready(s, {
    indicators: [{ id: 'rsi', label: 'rsi 14', pane: 'rsi', source: 'human', plots: [{ style: 'line', values: [] }] }],
  });
  const tight = s.buildLayout(900, 260, fakeCtx);
  assert.ok(paneOf(tight, 'rsi 14'), 'the pane somebody asked for outranks the default');
  assert.equal(paneOf(tight, 'volume'), undefined);

  const roomy = s.buildLayout(900, 600, fakeCtx);
  assert.ok(paneOf(roomy, 'volume'));
  assert.ok(paneOf(roomy, 'rsi 14'));
});

test('the pane can be put away and offers the way back', () => {
  const s = loadChartUi();
  ready(s);
  assert.ok(paneOf(s.buildLayout(900, 600, fakeCtx), 'volume'));
  s.toggleVolume();
  assert.equal(paneOf(s.buildLayout(900, 600, fakeCtx), 'volume'), undefined);
  // Remembered, so a person who put it away does not put it away again every morning.
  assert.equal(s.window.localStorage.getItem('phosphor.chart.volume'), '0');
  s.toggleVolume();
  assert.ok(paneOf(s.buildLayout(900, 600, fakeCtx), 'volume'));
});

// ---------- the gutter ----------

test('the right gutter is wide enough for the tag and the countdown to stop competing', () => {
  const s = loadChartUi();
  ready(s);
  s.buildLayout(900, 600, fakeCtx);
  // The tag sits in this column and the draining rule sits under it. At the old floor of 48
  // they were fighting for the same pixels.
  assert.ok(s.CHART_AXIS_W >= 66, `expected a floor of 66, got ${s.CHART_AXIS_W}`);
});

// ---------- the time axis ----------

/* Bars of one length from a local wall-clock moment, so the same test reads the same in any
   zone the suite runs in: the axis prints the zone the person is in. */
function barsFrom(local: [number, number, number, number, number], stepSec: number, count: number): Bar[] {
  const start = new Date(local[0], local[1], local[2], local[3], local[4]).getTime() / 1000;
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) out.push({ t: start + i * stepSec, o: 100, h: 104, l: 96, c: 101, v: 1 });
  return out;
}

function utcBars(iso: string, stepSec: number, count: number): Bar[] {
  const start = Date.parse(iso) / 1000;
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) out.push({ t: start + i * stepSec, o: 100, h: 104, l: 96, c: 101, v: 1 });
  return out;
}

/* Every label the time axis printed, left to right. */
function axisLabels(s: Sandbox, candles: Bar[], granularitySec: number): string[] {
  s.CHART.candles = candles;
  s.CHART.view = { product: 'BTC-USD', provider: 'auto', granularitySec, barCount: candles.length, panOffset: 0, priceScale: { mode: 'auto' } };
  s.CHART.dataView = { product: 'BTC-USD', granularitySec };
  const printed: { text: string; x: number }[] = [];
  const ctx = {
    font: '',
    fillStyle: '',
    textAlign: 'left',
    lineWidth: 1,
    strokeStyle: '',
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    fillText: (text: string, x: number) => printed.push({ text: String(text), x }),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
  };
  const L = s.buildLayout(900, 600, fakeCtx);
  s.drawTimeGrid(ctx, L);
  return printed.sort((a, b) => a.x - b.x).map((p) => p.text);
}

test('a 1m window across midnight names the new day once, and the first tick carries the date', () => {
  const s = loadChartUi();
  // 22:00 to 02:00, local, 15 to 16 September.
  const labels = axisLabels(s, barsFrom([2026, 8, 15, 22, 0], 60, 240), 60);
  assert.ok(labels.length >= 4, `ticks: ${labels.join(' | ')}`);
  assert.equal(labels[0], '15 Sep', 'the first visible tick always says what day it is');
  assert.equal(labels.filter((l) => l === '16 Sep').length, 1, `midnight is the one date rung: ${labels.join(' | ')}`);
  for (const label of labels.slice(1)) {
    if (label === '16 Sep') continue;
    assert.match(label, /^\d\d:\d\d$/, `a clock time between the days: ${label}`);
  }
});

test('a 1h window inside one day still shows the date on the first tick', () => {
  const s = loadChartUi();
  const labels = axisLabels(s, barsFrom([2026, 8, 16, 8, 0], 3600, 12), 3600);
  assert.equal(labels[0], '16 Sep');
  assert.ok(labels.length >= 3);
  for (const label of labels.slice(1)) assert.match(label, /^\d\d:\d\d$/, label);
});

test('a 1d window across a year boundary shows the months and the year where it turns', () => {
  const s = loadChartUi();
  // Daily bars are the venue's days, so the calendar here is UTC: 1 Nov 2025 to 28 Feb 2026.
  const labels = axisLabels(s, utcBars('2025-11-01T00:00:00Z', 86400, 120), 86400);
  assert.equal(labels[0], 'Nov 2025', 'the first tick carries the year when the window spans two');
  assert.deepEqual(labels.slice(1), ['Dec', '2026', 'Feb']);
});

test('a 1w window ticks on Mondays and a squeezed one on the first bar of each year', () => {
  const s = loadChartUi();
  // 2026-09-14 is a Monday. Twelve weekly bars at 69 px each: a tick every other week.
  const wide = axisLabels(s, utcBars('2026-09-14T00:00:00Z', 604800, 12), 604800);
  assert.equal(wide[0], '14 Sep');
  assert.ok(wide.every((l) => /^\d+ [A-Z][a-z]{2}$|^[A-Z][a-z]{2}$|^\d{4}$/.test(l)), wide.join(' | '));
  for (const label of wide) {
    const m = /^(\d+) ([A-Z][a-z]{2})$/.exec(label);
    if (!m) continue;
    const day = new Date(Date.UTC(2026, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[2] as string), Number(m[1])));
    assert.equal(day.getUTCDay(), 1, `${label} is a Monday`);
  }
  // Two hundred weeks at 4 px a bar: a month a tick would be 18 px apart, so the axis climbs
  // to the year rung and every tick is the first bar of a year.
  const squeezed = axisLabels(s, utcBars('2026-01-05T00:00:00Z', 604800, 200), 604800);
  assert.deepEqual(squeezed, ['2026', '2027', '2028', '2029']);
});

test('the crosshair stamp carries the date on an intraday chart', () => {
  const s = loadChartUi();
  const at = new Date(2026, 8, 16, 14, 7).getTime() / 1000;
  assert.equal(s.crosshairStamp(at, 60), '16 Sep 14:07');
  assert.equal(s.crosshairStamp(at, 3600), '16 Sep 14:07');
  assert.equal(s.crosshairStamp(Date.parse('2026-09-16T00:00:00Z') / 1000, 86400), '16 Sep 2026');
  assert.equal(s.crosshairStamp(Date.parse('2026-09-01T00:00:00Z') / 1000, s.MONTH_SEC), 'Sep 2026');
});

// ---------- the labels ----------

/* A 2d context that records every string and every dot drawn, with the ink each went down in. */
function recorder(): { ctx: Record<string, unknown>; texts: { text: string; x: number; ink: string }[]; dots: { x: number; ink: string }[]; strokes: string[] } {
  const texts: { text: string; x: number; ink: string }[] = [];
  const dots: { x: number; ink: string }[] = [];
  const strokes: string[] = [];
  const ctx: Record<string, unknown> = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    fillText: (text: string, x: number) => texts.push({ text: String(text), x, ink: String(ctx.fillStyle) }),
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    arc: (x: number) => dots.push({ x, ink: String(ctx.fillStyle) }),
    fill: () => {},
    stroke: () => strokes.push(`${String(ctx.strokeStyle)} w${String(ctx.lineWidth)}`),
    setLineDash: () => {},
    save: () => {},
    restore: () => {},
    clip: () => {},
    rect: () => {},
    translate: () => {},
    rotate: () => {},
  };
  return { ctx, texts, dots, strokes };
}

test('a level the agent drew shows no [agent] word: its dot is drawn in the agent tone before the label', () => {
  const s = loadChartUi();
  ready(s, { levels: [{ id: 'level-1', price: 101, label: '[agent] ceiling', source: 'agent' }] });
  const L = s.buildLayout(900, 600, fakeCtx);
  s.CHART_SCENE_LABELS = [];
  const scene = recorder();
  s.drawLevels(scene.ctx, L);
  const hud = recorder();
  s.drawLegend(hud.ctx, L);
  const printed = hud.texts.map((t) => t.text);
  assert.ok(!printed.some((t) => /\[agent\]/.test(t)), `no bracketed word on the canvas: ${printed.join(' | ')}`);
  const label = hud.texts.find((t) => /^ceiling /.test(t.text));
  assert.ok(label, `the level is labelled by its name and price: ${printed.join(' | ')}`);
  assert.equal(label?.ink, s.chartInk('agent', 0.9), 'in the agent tone');
  assert.equal(hud.dots.length, 1, 'one dot, for the one agent object');
  assert.equal(hud.dots[0]?.ink, s.chartInk('agent', 0.9), 'the dot is in the agent tone');
  assert.ok((hud.dots[0]?.x ?? 0) < (label?.x ?? 0), 'and it sits before the label');
});

test('the four prices of the head line sit in equal columns, so a tick moves nothing beside it', () => {
  const s = loadChartUi();
  ready(s);
  const L = s.buildLayout(900, 600, fakeCtx);
  const hud = recorder();
  s.drawLegend(hud.ctx, L);
  const letters = ['O', 'H', 'L', 'C'].map((k) => hud.texts.find((t) => t.text === k)?.x ?? NaN);
  const gaps = [letters[1]! - letters[0]!, letters[2]! - letters[1]!, letters[3]! - letters[2]!];
  assert.ok(gaps.every((g) => g === gaps[0]), `the columns are one width: ${gaps.join(', ')}`);
  const widest = Math.max(s.priceText(L.high, L.decimals).length, s.priceText(L.low, L.decimals).length) * 6;
  assert.equal(gaps[0], 6 + 6 + widest + 6, 'a letter, a gap, a column as wide as the widest price on the axis, a gap');
  assert.equal(hud.texts[0]?.x, 8, 'the column starts eight pixels in');
});

test('the cross that removes a study shows under the pointer and nowhere else', () => {
  const s = loadChartUi();
  ready(s, {
    indicators: [{ id: 'ema-1', type: 'ema', label: '[agent] ema 21', pane: 'price', source: 'agent', plots: [{ key: 'ema', values: new Array(40).fill(100) }] }],
  });
  const L = s.buildLayout(900, 600, fakeCtx);
  s.CHART_SCENE_LABELS = [];
  s.CHART_HOVER = null;
  const away = recorder();
  s.drawLegend(away.ctx, L);
  assert.ok(!away.strokes.some((st) => /w1\.5/.test(st)), 'no cross while the pointer is away');
  assert.ok(!s.CHART_HITS.some((h: { remove: string }) => h.remove === 'ema-1'), 'and nothing to hit');
  const box = s.CHART_LABEL_BOXES['ema-1'];
  assert.ok(box, 'the row remembers where it was drawn');
  s.CHART_HOVER = { x: box.x + 4, y: box.y + 4, index: 39 };
  const over = recorder();
  s.drawLegend(over.ctx, L);
  assert.ok(over.strokes.some((st) => /w1\.5/.test(st)), 'the cross is drawn under the pointer');
  assert.ok(s.CHART_HITS.some((h: { remove: string }) => h.remove === 'ema-1'), 'and it can be hit');
  assert.ok(!over.texts.some((t) => /\[agent\]/.test(t.text)));
});

// ---------- the face ----------

test('every number on the canvas is set in Geist Mono at 11 px, the face the rail uses', () => {
  // The system monospace it replaces was the one place the window fell back to whatever the OS
  // had, so the axis and the rail could disagree about the shape of a digit.
  const s = loadChartUi();
  assert.ok(s.CHART_FONT.startsWith('11px "Geist Mono"'), s.CHART_FONT);
  assert.ok(s.CHART_FONT_SMALL.startsWith('9px "Geist Mono"'), s.CHART_FONT_SMALL);
});

test('the waiting scene speaks in sentence case, not tracked caps', () => {
  const s = loadChartUi();
  s.CHART.meta = { source: '', stale: false, built: '', error: null };
  assert.equal(s.waitingState().head, 'Connecting');
  s.CHART.view.product = 'BTC-USD';
  assert.ok(s.waitingState().head.startsWith('Acquiring BTC-USD'), s.waitingState().head);
  s.CHART.meta.error = 'no route';
  assert.equal(s.waitingState().head, 'Chart unreachable');
});
