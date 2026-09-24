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

test('the chart draws in the window\'s own inks before the stylesheet is in', () => {
  const s = loadChartUi();
  // The fallbacks the engine draws with before the stylesheet is read are the tokens'
  // shipped values (ui/design/tokens.css), so the first frame has no seam against the slab:
  // a hairline or a candle in last season's colours is a flash a person can see.
  const tokens = readFileSync(new URL('../../ui/design/tokens.css', import.meta.url), 'utf8');
  const token = (name: string): string => {
    const m = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(tokens);
    assert.ok(m, 'tokens.css ships --' + name);
    return m![1].toLowerCase();
  };
  const triple = (hex: string): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
  assert.equal(s.C_UP.toLowerCase(), token('up'));
  assert.equal(s.C_DOWN.toLowerCase(), token('down'));
  assert.equal(s.CHART_TOKENS.line.toLowerCase(), token('line'));
  assert.equal(s.CHART_TOKENS.text2.toLowerCase(), token('text-2'));
  assert.equal(s.CHART_TOKENS.bg1.toLowerCase(), token('bg-1'));
  // The four inks the engine mixes from, named for meaning rather than for a colour.
  assert.equal(s.accent(0.5), 'rgba(' + triple(token('up')) + ', 0.5)');
  assert.equal(s.danger(1), 'rgba(' + triple(token('down')) + ', 1)');
  assert.equal(s.lineInk(1), 'rgba(' + triple(token('line')) + ', 1)');
  assert.equal(s.text2(0.7), 'rgba(' + triple(token('text-2')) + ', 0.7)');
  assert.ok(s.CHART_FONT.startsWith('11px "Geist"'), s.CHART_FONT);
  assert.ok(s.CHART_FONT_SMALL.startsWith('9px "Geist"'), s.CHART_FONT_SMALL);
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
  // The legend's strip (PAD_TOP) sits above the pane and is not part of the budget.
  const usable = 600 - 18 - s.PAD_TOP;
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

test('a pane figure is written the way every other figure is: grouped by thousands, whole from a thousand up', () => {
  const s = loadChartUi();
  // The volume axis read "6221.0" in the review's 1440 frame.
  assert.equal(s.paneText(6221.04), '6,221');
  assert.equal(s.paneText(1000), '1,000');
  assert.equal(s.paneText(-12_345.6), '-12,346');
  assert.equal(s.paneText(359.31), '359.3');
  assert.equal(s.paneText(27.97), '27.97');
  assert.equal(s.paneText(0.5), '0.5000');
  assert.equal(s.paneText(0), '0');
  assert.equal(s.paneText(1_234_567), '1.23M');
  assert.equal(s.paneText(2_500_000_000), '2.50B');
  assert.equal(s.paneText(null), '--');
  // The pane's own scale prints through it.
  ready(s);
  s.CHART.candles = s.CHART.candles.map((c: Bar, i: number) => ({ ...c, v: i === 20 ? 6221.04 : 12.5 }));
  const L = s.buildLayout(900, 600, fakeCtx);
  const drawn: string[] = [];
  const ctx = { ...fakeCtx, fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', fillText: (t: string) => drawn.push(String(t)), fillRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {}, rect: () => {}, fill: () => {} };
  s.drawPanes(ctx, L);
  assert.ok(drawn.some((t) => /^\d{1,3}(,\d{3})+$/.test(t)), `the volume axis prints its top grouped: ${JSON.stringify(drawn)}`);
  assert.ok(!drawn.some((t) => /^\d{4,}\.\d$/.test(t)), `a figure over a thousand kept a tenth and no comma: ${JSON.stringify(drawn)}`);
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
  assert.equal(labels[0], '1 Nov 2025', 'the first tick carries the year when the window spans two');
  // Fortnightly Monday ticks at this width: the month where it turns, the year where it does.
  assert.equal(labels.filter((l) => l === '2026').length, 1, labels.join(' | '));
  assert.ok(labels.includes('Dec') && labels.includes('Feb'), labels.join(' | '));
  assert.ok(!labels.includes('Jan'), 'January is named by its year, not twice');
  for (const label of labels.slice(1)) assert.match(label, /^(\d+ [A-Z][a-z]{2}|[A-Z][a-z]{2}|\d{4})$/, label);

  // Squeezed to a bar a pixel, two years of days climb to the quarter rung.
  const tight = axisLabels(s, utcBars('2025-11-01T00:00:00Z', 86400, 700), 86400);
  assert.equal(tight[0], 'Nov 2025');
  assert.deepEqual(tight.slice(1, 5), ['2026', 'Apr', 'Jul', 'Oct']);
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

test('a level names itself in a chip on the price axis, in its owner\'s ink, with no [agent] word and nothing over the candles', () => {
  const s = loadChartUi();
  ready(s, {
    levels: [
      { id: 'level-1', price: 101, label: '[agent] ceiling', source: 'agent' },
      { id: 'level-2', price: 99, label: 'my floor', source: 'human' },
    ],
  });
  s.CHART_CHIP_W = s.CHIP_AXIS_MAX;
  s.buildLayout(900, 600, fakeCtx);
  const L = s.buildLayout(900, 600, fakeCtx);
  s.CHART_AXIS_CHIPS = [];
  const scene = recorder();
  s.drawLevels(scene.ctx, L);
  // Solid, one device pixel in the owner's ink: the agent's violet, the person's text.
  assert.deepEqual(scene.strokes, [`${s.chartInk('agent', 0.72)} w1`, `${s.chartInk('text', 0.72)} w1`]);
  L.chips = s.chipLayout(L);
  const legend = recorder();
  s.drawLegend(legend.ctx, L);
  assert.ok(!legend.texts.some((t) => /ceiling|floor/.test(t.text)), 'no level is written in the column over the candles');
  const axis = recorder();
  s.drawAxisChips(axis.ctx, L);
  const printed = axis.texts.map((t) => t.text);
  assert.ok(!printed.some((t) => /\[agent\]/.test(t)), `no bracketed word on the canvas: ${printed.join(' | ')}`);
  const word = axis.texts.find((t) => t.text === 'ceiling');
  const price = axis.texts.find((t) => t.text === '101.0');
  assert.ok(word && price, printed.join(' | '));
  assert.equal(word?.ink, s.chartInk('agent', 0.82), 'the name in the agent tone');
  assert.ok((price?.x ?? 0) >= L.plotWidth && (price?.x ?? 0) < (word?.x ?? 0), 'the price in the axis column, the name after it');
  assert.equal(axis.texts.find((t) => t.text === 'my floor')?.ink, s.chartInk('text', 0.82), "the person's in the text ink");
  assert.equal(axis.dots.length, 0, 'the ink says who drew it: no dot to read');
});

test('studies take the study hues in order, none of them a state colour, the first two a cool and a warm', () => {
  const s = loadChartUi();
  const tokens = readFileSync(new URL('../../ui/design/tokens.css', import.meta.url), 'utf8');
  for (let i = 1; i <= 5; i += 1) {
    const m = new RegExp('--study-' + i + ':\\s*(#[0-9a-fA-F]{6})').exec(tokens);
    assert.ok(m, `tokens.css ships --study-${i}`);
    assert.equal(s.CHART_TOKENS.studies[i - 1].toLowerCase(), m![1].toLowerCase(), 'the engine draws before the stylesheet in the shipped value');
  }
  const flat = (v: number) => new Array(40).fill(v);
  ready(s, {
    indicators: [
      { id: 'ema-1', type: 'ema', label: '[agent] EMA 21', pane: 'price', source: 'agent', plots: [{ key: 'ema', style: 'line', emphasis: 0.9, values: flat(100) }] },
      { id: 'ema-2', type: 'ema', label: 'EMA 55', pane: 'price', source: 'human', plots: [{ key: 'ema', style: 'line', emphasis: 0.9, values: flat(101) }] },
      { id: 'bb-3', type: 'bbands', label: 'BB 20/2', pane: 'price', source: 'human', plots: [{ key: 'upper', style: 'band', emphasis: 0.5, fillTo: 'lower', values: flat(103) }, { key: 'mid', style: 'line', emphasis: 0.7, values: flat(100) }, { key: 'lower', style: 'line', emphasis: 0.5, values: flat(97) }] },
    ],
  });
  const L = s.buildLayout(900, 600, fakeCtx);
  const scene = recorder();
  s.drawOverlayLines(scene.ctx, L);
  const [first, second, ...band] = scene.strokes;
  assert.equal(first, `${s.studyInk(0, 0.95)} w1.5`, 'the study itself at 1.5 px in the first hue');
  assert.equal(second, `${s.studyInk(1, 0.95)} w1.5`, 'the next study in the next hue');
  assert.ok(band.every((st) => st.startsWith(s.studyInk(2, 0.72).slice(0, -6)) && st.endsWith('w1')), `a band is one study in one hue, its edges at 1 px: ${band.join(' | ')}`);
  for (const st of scene.strokes) {
    for (const state of [s.RGB_ACCENT, s.RGB_DOWN, s.RGB_AGENT]) assert.ok(!st.startsWith(`rgba(${state},`), `a study drawn in a state colour: ${st}`);
  }
  // The legend matches name to line: a swatch in the line's own hue, the value in it too.
  const hud = recorder();
  s.drawLegend(hud.ctx, L);
  const named = hud.texts.findIndex((t) => t.text === 'EMA 21');
  assert.equal(hud.texts[named + 1]?.text, '100.0');
  assert.equal(hud.texts[named + 1]?.ink, s.studyInk(0, 1));
  assert.equal(hud.texts.find((t) => t.text === 'EMA 21')?.ink, s.chartInk('agent', 0.95), "the agent's study is named in its violet");
});

test('a horizontal line lands on whole device pixels at 2x: two device pixels on a pixel edge', () => {
  const s = loadChartUi();
  s.DPR = 2;
  assert.equal(s.crispWidth(1), 1, 'one css pixel is two device pixels');
  assert.equal(s.crisp(100.3, 1), 100.5, 'on the device pixel edge nearest');
  assert.equal(s.crisp(100.3, 1.5), 100.25, 'three device pixels sit on the nearest device pixel centre');
  s.DPR = 1;
  assert.equal(s.crisp(100.3, 1), 100.5, 'at 1x one pixel sits on the pixel centre');
});

test('a mark names itself in a chip on the time axis, and the clock under the chip steps aside', () => {
  const s = loadChartUi();
  const candles = barsFrom([2026, 8, 16, 8, 0], 60, 240);
  ready(s, { marks: [{ id: 'mark-1', t: candles[120]!.t, label: '[agent] CPI', source: 'agent' }] });
  s.CHART.candles = candles;
  s.CHART.view = { product: 'BTC-USD', provider: 'auto', granularitySec: 60, barCount: 240, panOffset: 0, priceScale: { mode: 'auto' } };
  const L = s.buildLayout(900, 600, fakeCtx);
  const scene = recorder();
  L.markChips = s.markChipLayout(scene.ctx, L);
  assert.equal(L.markChips.length, 1);
  assert.equal(L.markChips[0].word, 'CPI');
  s.drawTimeGrid(scene.ctx, L);
  const chip = L.markChips[0];
  const covered = scene.texts.filter((t) => t.x > chip.left - 4 && t.x < chip.left + chip.w + 4);
  assert.deepEqual(covered, [], 'no clock label under the chip');
  s.drawMarkChips(scene.ctx, L);
  const word = scene.texts.find((t) => t.text === 'CPI');
  assert.ok(word && word.ink === s.chartInk('agent', 0.9), JSON.stringify(scene.texts.slice(-3)));
});

test('a marking that lands docks in and one that is cleared fades out, and neither moves under reduced motion', () => {
  const s = loadChartUi();
  let now = 1000;
  s.performance = { now: () => now };
  s.window.performance = s.performance;
  ready(s);
  s.noteMarkings(false);
  s.CHART.levels = [{ id: 'level-1', price: 101, label: 'a', source: 'agent' }];
  s.noteMarkings(true);
  assert.ok(s.markIn('level:level-1').alpha < 0.05, 'a new level starts at the edge of seeing');
  now += 120;
  const mid = s.markIn('level:level-1');
  assert.ok(mid.alpha > 0.5 && mid.alpha < 1 && mid.draw < 1, JSON.stringify(mid));
  now += 400;
  assert.equal(JSON.stringify(s.markIn('level:level-1')), JSON.stringify({ alpha: 1, draw: 1 }));
  s.CHART.levels = [];
  s.noteMarkings(true);
  assert.equal(s.ghostsOf('level').length, 1, 'the cleared level is still drawn, fading');
  now += 250;
  assert.equal(s.ghostsOf('level').length, 0, 'and gone within the window close time');
  // Reduced motion: it is simply there, and simply gone.
  s.window.matchMedia = () => ({ matches: true });
  s.CHART.levels = [{ id: 'level-2', price: 101, label: 'b', source: 'agent' }];
  s.noteMarkings(true);
  assert.equal(JSON.stringify(s.markIn('level:level-2')), JSON.stringify({ alpha: 1, draw: 1 }));
});

test('the study legend sits on one plate in the slab\'s shade, so no value is read against the candles or a line under it', () => {
  const s = loadChartUi();
  const flat = (v: number) => new Array(40).fill(v);
  ready(s, {
    indicators: [
      { id: 'ema-1', type: 'ema', label: '[agent] EMA 21', pane: 'price', source: 'agent', plots: [{ key: 'ema', style: 'line', emphasis: 0.9, values: flat(100) }] },
      { id: 'bb-2', type: 'bbands', label: 'BB 20/2', pane: 'price', source: 'human', plots: [{ key: 'upper', style: 'band', emphasis: 0.5, fillTo: 'lower', values: flat(103) }, { key: 'mid', style: 'line', emphasis: 0.7, values: flat(100) }, { key: 'lower', style: 'line', emphasis: 0.5, values: flat(97) }] },
      { id: 'vwap-3', type: 'vwap', label: 'VWAP', pane: 'price', source: 'human', plots: [{ key: 'vwap', style: 'line', emphasis: 0.9, values: flat(99) }] },
    ],
  });
  const L = s.buildLayout(900, 600, fakeCtx);
  const rects: Array<{ fill: string; x: number; y: number; w: number; h: number }> = [];
  const texts: Array<{ text: string; y: number }> = [];
  const ctx: Record<string, unknown> = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    fillText: (text: string, _x: number, y: number) => texts.push({ text: String(text), y }),
    fillRect: (x: number, y: number, w: number, h: number) => rects.push({ fill: String(ctx.fillStyle), x, y, w, h }),
    strokeRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    arc: () => {},
    rect: () => {},
    fill: () => {},
    stroke: () => {},
  };
  s.CHART_HOVER = null;
  s.drawLegend(ctx, L);
  const ground = s.groundInk(0.92);
  // The price pane's column; the volume pane's own line sits on a plate of its own in its pane.
  const plates = rects.filter((r) => r.fill === ground && r.y < L.priceTop + L.priceHeight);
  assert.equal(plates.length, 1, `one plate behind the column, not a pad per line: ${JSON.stringify(rects)}`);
  const plate = plates[0]!;
  const column = texts.filter((t) => /EMA 21|BB 20\/2|VWAP/.test(t.text));
  assert.equal(column.length, 3);
  for (const t of column) assert.ok(t.y > plate.y && t.y < plate.y + plate.h, `${t.text} is off the plate`);
  assert.equal(plate.x, 0, 'docked to the plot\'s left edge');
  assert.ok(plate.y >= L.priceTop, 'under the market line, which has its own strip');
  assert.ok(!rects.some((r) => r.fill === s.chartLabelPad()), 'no line of the column keeps a pad of its own');
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

test('every number on the canvas is set in Geist at 11 px, the face the text around it uses', () => {
  // Figures in a second face sat on another baseline beside the words; the canvas speaks the
  // window's own face and draws its digits to one width itself.
  const s = loadChartUi();
  assert.ok(s.CHART_FONT.startsWith('11px "Geist"'), s.CHART_FONT);
  assert.ok(s.CHART_FONT_SMALL.startsWith('9px "Geist"'), s.CHART_FONT_SMALL);
});

test('Geist digits are drawn one to a cell, so a price that ticks moves nothing beside it', () => {
  const s = loadChartUi();
  // A face whose 1 is narrower than its 8, as Geist's are.
  const drawn: Array<[string, number]> = [];
  const ctx = {
    font: '11px "Geist" test-proportional',
    textAlign: 'left',
    measureText: (t: string) => ({ width: String(t).split('').reduce((w, ch) => w + (ch === '1' ? 4 : ch === ',' ? 3 : 7), 0) }),
    fillText: (t: string, x: number) => drawn.push([String(t), x]),
  };
  assert.equal(s.textWidth(ctx, '11,111'), s.textWidth(ctx, '88,888'), 'one width for any five digits');
  s.drawText(ctx, '1,8', 10, 0);
  assert.deepEqual(drawn, [['1', 11.5], [',', 17], ['8', 20]], 'each digit centred in a 7 px cell');
});

test('the waiting scene speaks in sentence case, not tracked caps', () => {
  const s = loadChartUi();
  s.CHART.meta = { source: '', stale: false, built: '', error: null };
  assert.equal(s.waitingState().head, 'Connecting');
  s.CHART.view.product = 'BTC-USD';
  // The coin, the way the strip names it, not the chart's product id.
  assert.ok(s.waitingState().head.startsWith('Loading BTC 1m'), s.waitingState().head);
  s.CHART.meta.error = 'no route';
  assert.equal(s.waitingState().head, 'Chart unreachable');
});
