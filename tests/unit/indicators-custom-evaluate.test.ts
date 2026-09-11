// The custom indicator evaluator against the built-ins it must agree with.
//
// The golden rule of this file: a custom SMA, EMA, RSI and ATR must equal the catalogue's own
// to 1e-9 on the same candles. The agent reads both through the same chart_read, and a human
// comparing a pasted script against the built-in pane must see one line, not two that drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { Candle } from '../../src/types.ts';
import { indicatorSpec, normaliseParams, warmupBars } from '../../src/indicators.ts';
import { compile, WORK_BUDGET } from '../../src/indicators-custom/evaluate.ts';
import { customIndicatorSchema } from '../../src/indicators-custom/schema.ts';
import type { CustomIndicator, Expr } from '../../src/indicators-custom/schema.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'indicators');

// A deterministic random walk with real wicks and volume, so every op has something to chew
// on and the run is the same on every machine.
function walk(n: number, seed = 7): Candle[] {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p + (rnd() - 0.5) * 2;
    const h = Math.max(o, c) + rnd();
    const l = Math.min(o, c) - rnd();
    out.push({ t: 1_700_000_000 + i * 60, o, h, l, c, v: 50 + Math.round(rnd() * 100) });
    p = c;
  }
  return out;
}

function fixture(name: string): CustomIndicator {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown;
  const out = customIndicatorSchema.safeParse(raw);
  assert.ok(out.success, `${name} does not validate`);
  return out.success ? out.data : (undefined as never);
}

function custom(ind: CustomIndicator, slug = 'test', params: Record<string, number> = {}) {
  const spec = compile(ind, slug);
  return { spec, result: spec.compute(walk(300), normaliseParams(spec, params).params) };
}

function series(expr: Expr, inputs: CustomIndicator['inputs'] = {}, candles = walk(60)): (number | null)[] {
  const spec = compile({ title: 'T', overlay: false, inputs, plots: [{ title: 'p', expr }] }, 't');
  const result = spec.compute(candles, normaliseParams(spec, {}).params);
  return result.plots[0]?.values ?? [];
}

function assertSame(a: (number | null)[], b: (number | null)[], what: string): void {
  assert.equal(a.length, b.length, `${what}: length`);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || y === null) {
      assert.equal(x, y, `${what}[${i}]: ${x} vs ${y}`);
      continue;
    }
    assert.ok(Math.abs(x - y) < 1e-9, `${what}[${i}]: ${x} vs ${y}`);
  }
}

function builtin(type: string, params: Record<string, number>, key: string, candles = walk(300)): (number | null)[] {
  const spec = indicatorSpec(type);
  assert.ok(spec, `no built-in ${type}`);
  const plot = spec.compute(candles, normaliseParams(spec, params).params).plots.find((p) => p.key === key);
  assert.ok(plot, `no plot ${key} on ${type}`);
  return plot.values;
}

test('golden: custom sma equals the built-in to 1e-9', () => {
  const { result } = custom(fixture('sma.json'), 'sma');
  assertSame(result.plots[0]?.values ?? [], builtin('sma', { period: 20 }, 'sma'), 'sma');
});

test('golden: custom ema equals the built-in to 1e-9', () => {
  const { result } = custom(fixture('ema.json'), 'ema');
  assertSame(result.plots[0]?.values ?? [], builtin('ema', { period: 21 }, 'ema'), 'ema');
});

test('golden: custom rsi equals the built-in to 1e-9, guides and all', () => {
  const { result } = custom(fixture('rsi.json'), 'rsi');
  assertSame(result.plots[0]?.values ?? [], builtin('rsi', { period: 14 }, 'rsi'), 'rsi');
  assert.deepEqual(
    result.guides.map((g) => g.value),
    [70, 30],
  );
});

test('golden: custom atr equals the built-in to 1e-9', () => {
  const { result } = custom(fixture('atr.json'), 'atr');
  assertSame(result.plots[0]?.values ?? [], builtin('atr', { period: 14 }, 'atr'), 'atr');
});

test('golden: the goldens still hold when the agent changes the period', () => {
  const { result } = custom(fixture('sma.json'), 'sma', { length: 50 });
  assertSame(result.plots[0]?.values ?? [], builtin('sma', { period: 50 }, 'sma'), 'sma 50');
});

test('wma and stdev match the kit on dense input', () => {
  const candles = walk(120);
  assertSame(series(['wma', 'close', 10], {}, candles), builtin('wma', { period: 10 }, 'wma', candles), 'wma');
  const bb = indicatorSpec('bbands');
  assert.ok(bb);
  const upper = bb.compute(candles, { period: 20, mult: 2 }).plots.find((p) => p.key === 'upper')?.values ?? [];
  const mine = series(['+', ['sma', 'close', 20], ['*', 2, ['stdev', 'close', 20]]], {}, candles);
  assertSame(mine, upper, 'bollinger upper');
});

test('a closed set of candles gives the ops their known answers', () => {
  const candles = walk(30);
  const closes = candles.map((c) => c.c);
  const hist = series(['hist', 'close', 2], {}, candles);
  assert.equal(hist[0], null);
  assert.equal(hist[1], null);
  assert.equal(hist[5], closes[3]);

  const change = series(['change', 'close'], {}, candles);
  assert.equal(change[0], null);
  assert.ok(Math.abs((change[4] as number) - ((closes[4] as number) - (closes[3] as number))) < 1e-12);

  const bar = series('bar_index', {}, candles);
  assert.equal(bar[0], 0);
  assert.equal(bar[29], 29);

  const hl2 = series('hl2', {}, candles);
  assert.ok(Math.abs((hl2[3] as number) - ((candles[3] as Candle).h + (candles[3] as Candle).l) / 2) < 1e-12);

  const highest = series(['highest', 'high', 5], {}, candles);
  assert.equal(highest[3], null);
  assert.equal(highest[10], Math.max(...candles.slice(6, 11).map((c) => c.h)));
  const lowest = series(['lowest', 'low', 5], {}, candles);
  assert.equal(lowest[10], Math.min(...candles.slice(6, 11).map((c) => c.l)));
});

test('comparisons, logic and the ternary work elementwise with na propagating', () => {
  const candles = walk(10);
  const up = series(['>', 'close', 'open'], {}, candles);
  for (let i = 0; i < 10; i++) assert.equal(up[i], (candles[i] as Candle).c > (candles[i] as Candle).o ? 1 : 0);
  const pick = series(['?', ['>', 'close', 'open'], 'high', 'low'], {}, candles);
  for (let i = 0; i < 10; i++) {
    const c = candles[i] as Candle;
    assert.equal(pick[i], c.c > c.o ? c.h : c.l);
  }
  const both = series(['and', ['>', 'close', 'open'], ['not', ['<', 'volume', 0]]], {}, candles);
  for (let i = 0; i < 10; i++) assert.equal(both[i], up[i]);
  // na in a comparison is na, and a comparison with na cannot be "true".
  const naCmp = series(['>', ['hist', 'close', 1], 'open'], {}, candles);
  assert.equal(naCmp[0], null);
  assert.equal(series(['na', ['hist', 'close', 1]], {}, candles)[0], 1);
  assert.equal(series(['nz', ['hist', 'close', 1]], {}, candles)[0], 0);
  assert.equal(series(['nz', ['hist', 'close', 1], 7], {}, candles)[0], 7);
});

test('crossover fires on the bar the lines swap and nowhere else', () => {
  const closes = [1, 2, 3, 2, 1, 2, 3];
  const candles: Candle[] = closes.map((c, i) => ({ t: i, o: 2, h: c + 1, l: c - 1, c, v: 1 }));
  const over = series(['crossover', 'close', 'open'], {}, candles);
  const under = series(['crossunder', 'close', 'open'], {}, candles);
  assert.deepEqual(over, [null, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(under, [null, 0, 0, 0, 1, 0, 0]);
});

test('division by zero, log of zero and sqrt of a negative are na, never a throw', () => {
  const candles = walk(5);
  assert.equal(series(['/', 'close', 0], {}, candles)[2], null);
  assert.equal(series(['%', 'close', 0], {}, candles)[2], null);
  assert.equal(series(['log', 0], {}, candles)[2], null);
  assert.equal(series(['sqrt', -1], {}, candles)[2], null);
  assert.equal(series(['*', 1e308, 1e308], {}, candles)[2], null);
});

test('recur builds a running max from a previous value and an init', () => {
  const candles = walk(40);
  const peak = series(['recur', 'na', ['max', ['nz', 'prev'], 'high']], {}, candles);
  let hi = -Infinity;
  for (let i = 0; i < 40; i++) {
    hi = Math.max(hi, (candles[i] as Candle).h);
    assert.equal(peak[i], hi);
  }
  // The init is the value prev takes on the first bar, so a var seeded from close holds it.
  const held = series(['recur', 'close', 'prev'], {}, candles);
  for (let i = 0; i < 40; i++) assert.equal(held[i], (candles[0] as Candle).c);
  // A counter: nz(prev) + 1.
  const count = series(['recur', 'na', ['+', ['nz', 'prev'], 1]], {}, candles);
  assert.equal(count[0], 1);
  assert.equal(count[39], 40);
});

test('an ema over a series with a warmup seeds after the warmup, as the kit does', () => {
  const candles = walk(80);
  // ema(sma(close, 5), 3): the sma is na for four bars, so the ema seeds on bars 4..6.
  const out = series(['ema', ['sma', 'close', 5], 3], {}, candles);
  assert.equal(out[5], null);
  assert.ok(typeof out[6] === 'number');
  const smaVals = builtin('sma', { period: 5 }, 'sma', candles);
  const seed = ((smaVals[4] as number) + (smaVals[5] as number) + (smaVals[6] as number)) / 3;
  assert.ok(Math.abs((out[6] as number) - seed) < 1e-9);
});

test('the compiled spec looks like any other catalogue entry', () => {
  const { spec, result } = custom(fixture('rsi.json'), 'my-rsi');
  assert.equal(spec.type, 'custom:my-rsi');
  assert.equal(spec.pane, 'own');
  assert.deepEqual(
    spec.params.map((p) => p.name),
    ['length'],
  );
  assert.equal(spec.params[0]?.int, true);
  assert.equal(spec.label({ length: 14 }), 'Custom RSI 14');
  assert.equal(result.plots.length, 1);
  assert.equal(result.plots[0]?.style, 'line');
  assert.equal(result.range, null);
  assert.match(result.state, /Custom RSI/);
  assert.equal(result.plots[0]?.values.length, 300);
});

test('overlay indicators say where price sits, the way a moving average does', () => {
  const { spec, result } = custom(fixture('sma.json'), 'sma');
  assert.equal(spec.pane, 'price');
  assert.match(result.state, /price (above|below) by/);
});

test('warmup counts the history the tree needs', () => {
  const spec = compile(
    {
      title: 'W',
      overlay: false,
      inputs: { length: { default: 10, int: true } },
      plots: [{ title: 'p', expr: ['ema', ['sma', 'close', 'length'], 5] }],
    },
    'w',
  );
  assert.equal(warmupBars(spec, { length: 10 }), 14);
  assert.equal(warmupBars(spec, { length: 30 }), 34);
  const rsi = compile(fixture('rsi.json'), 'rsi');
  assert.equal(warmupBars(rsi, { length: 14 }), 15);
});

test('an input without bounds still clamps, and a period from an input is bounded at 500', () => {
  const spec = compile(
    { title: 'B', overlay: false, inputs: { length: { default: 10 } }, plots: [{ title: 'p', expr: ['sma', 'close', 'length'] }] },
    'b',
  );
  const clamped = normaliseParams(spec, { length: 1e12 }).params;
  const result = spec.compute(walk(600), clamped);
  // Whatever the agent passed, the sma ran with a period of at most 500, so bar 599 has a value.
  assert.ok(typeof result.plots[0]?.values[599] === 'number');
  assert.equal(result.plots[0]?.values[498], null);
});

test('the work budget stops a compute and says so instead of throwing', () => {
  // wma is charged n times its period; a few of them at 500 over 2000 bars is past the budget.
  let expr: Expr = 'close';
  for (let i = 0; i < 6; i++) expr = ['wma', expr, 500];
  const spec = compile({ title: 'Heavy', overlay: false, inputs: {}, plots: [{ title: 'p', expr }] }, 'heavy');
  const result = spec.compute(walk(2000), {});
  assert.match(result.state, /budget/);
  assert.equal(result.plots.length, 1);
  assert.equal(result.plots[0]?.values.length, 2000);
  assert.ok(result.plots[0]?.values.every((v) => v === null));
  assert.ok(WORK_BUDGET >= 2_000_000);
});

test('plots carry the tone, the style and a key derived from the title', () => {
  const spec = compile(
    {
      title: 'Tones',
      overlay: false,
      inputs: {},
      plots: [
        { title: 'Up Line', expr: 'close', color: 'up' },
        { title: 'Bars!', expr: ['-', 'close', 'open'], color: 'down', style: 'histogram' },
        { title: 'Bars!', expr: 'volume' },
      ],
      hlines: [{ value: 0, title: 'zero' }],
    },
    'tones',
  );
  const result = spec.compute(walk(20), {});
  assert.deepEqual(
    result.plots.map((p) => p.key),
    ['up-line', 'bars', 'bars-2'],
  );
  assert.equal(result.plots[0]?.tone, 'up');
  assert.equal(result.plots[1]?.style, 'histogram');
  assert.equal(result.plots[1]?.signed, true);
  assert.equal(result.plots[2]?.tone, undefined);
  assert.deepEqual(result.guides, [{ value: 0, label: 'zero' }]);
});

test('a shared subtree is evaluated once', () => {
  // Three plots over the same 400-period wma on 2000 bars: 800k of work each if evaluated
  // three times, which is past the budget, and 800k once if the subtree is shared.
  const heavy: Expr = ['wma', 'close', 400];
  const spec = compile(
    {
      title: 'Shared',
      overlay: true,
      inputs: {},
      plots: [
        { title: 'a', expr: heavy },
        { title: 'b', expr: ['+', heavy, 1] },
        { title: 'c', expr: ['+', heavy, 2] },
      ],
    },
    'shared',
  );
  const result = spec.compute(walk(2000), {});
  assert.doesNotMatch(result.state, /budget/);
  assert.equal((result.plots[1]?.values[1999] as number) - (result.plots[0]?.values[1999] as number), 1);
  assert.equal((result.plots[2]?.values[1999] as number) - (result.plots[0]?.values[1999] as number), 2);
});
