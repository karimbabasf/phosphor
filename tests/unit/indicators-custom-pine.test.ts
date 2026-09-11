// The Pine v5 translator: the subset that covers the scripts people paste, translated onto
// the JSON format, and everything else refused by name with the line number.
//
// The refusals matter as much as the translations. A human adapting a script needs to know
// which line to change and why, and a translator that silently dropped a loop would draw a
// line that looks right and is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { Candle } from '../../src/types.ts';
import { indicatorSpec, normaliseParams } from '../../src/indicators.ts';
import { translatePine } from '../../src/indicators-custom/pine.ts';
import { compile } from '../../src/indicators-custom/evaluate.ts';
import { customIndicatorSchema } from '../../src/indicators-custom/schema.ts';
import type { CustomIndicator } from '../../src/indicators-custom/schema.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'indicators');

function walk(n: number, seed = 11): Candle[] {
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
    out.push({ t: 1_700_000_000 + i * 60, o, h: Math.max(o, c) + rnd(), l: Math.min(o, c) - rnd(), c, v: 50 + Math.round(rnd() * 100) });
    p = c;
  }
  return out;
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function ok(source: string): { indicator: CustomIndicator; ignored: string[] } {
  const out = translatePine(source);
  assert.ok(out.ok, out.ok ? '' : `line ${out.line}: ${out.message}`);
  if (!out.ok) throw new Error('unreachable');
  // Every translation must also pass the schema: one evaluator, one pen test surface.
  const valid = customIndicatorSchema.safeParse(out.indicator);
  assert.ok(valid.success, valid.success ? '' : valid.error.issues.map((i) => i.message).join('\n'));
  return out;
}

function refused(source: string): { line: number; message: string } {
  const out = translatePine(source);
  assert.equal(out.ok, false, 'expected a refusal');
  if (out.ok) throw new Error('unreachable');
  return out;
}

function values(ind: CustomIndicator, plotIndex: number, candles: Candle[], params: Record<string, number> = {}): (number | null)[] {
  const spec = compile(ind, 'pine');
  const result = spec.compute(candles, normaliseParams(spec, params).params);
  return result.plots[plotIndex]?.values ?? [];
}

function builtin(type: string, params: Record<string, number>, key: string, candles: Candle[]): (number | null)[] {
  const spec = indicatorSpec(type);
  assert.ok(spec);
  const plot = spec.compute(candles, normaliseParams(spec, params).params).plots.find((p) => p.key === key);
  assert.ok(plot);
  return plot.values;
}

function same(a: (number | null)[], b: (number | null)[], what: string): void {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || y === null) assert.equal(x, y, `${what}[${i}]`);
    else assert.ok(Math.abs(x - y) < 1e-9, `${what}[${i}]: ${x} vs ${y}`);
  }
}

const HEAD = '//@version=5\nindicator("T")\n';

test('fixture: a two moving average cross with a plotshape ignored', () => {
  const { indicator, ignored } = ok(fixture('ma-cross.pine'));
  assert.equal(indicator.title, 'MA Cross');
  assert.equal(indicator.overlay, true);
  assert.deepEqual(indicator.inputs.fastLen, { default: 9, min: 1, int: true, title: 'Fast' });
  assert.deepEqual(indicator.inputs.slowLen, { default: 21, min: 1, max: 400, int: true, title: 'Slow' });
  assert.deepEqual(indicator.plots[0], { title: 'Fast', color: 'up', expr: ['sma', 'close', 'fastLen'] });
  assert.deepEqual(indicator.plots[1], { title: 'Slow', color: 'down', expr: ['ema', 'close', 'slowLen'] });
  assert.equal(ignored.length, 1);
  assert.match(ignored[0] as string, /plotshape.*line 9/);
  const candles = walk(200);
  same(values(indicator, 0, candles), builtin('sma', { period: 9 }, 'sma', candles), 'fast');
  same(values(indicator, 1, candles), builtin('ema', { period: 21 }, 'ema', candles), 'slow');
});

test('fixture: rsi with bands, an input source and three hlines', () => {
  const { indicator, ignored } = ok(fixture('rsi-bands.pine'));
  assert.equal(indicator.overlay, false);
  assert.deepEqual(indicator.plots[0]?.expr, ['rsi', 'close', 'len']);
  assert.equal(indicator.plots[0]?.color, 'agent');
  assert.deepEqual(indicator.hlines, [
    { value: 70, title: 'Overbought' },
    { value: 30, title: 'Oversold' },
    { value: 50, title: 'Mid' },
  ]);
  assert.deepEqual(ignored, []);
  const candles = walk(200);
  same(values(indicator, 0, candles), builtin('rsi', { period: 14 }, 'rsi', candles), 'rsi');
});

test('fixture: var and := make a running max and a bar counter', () => {
  const { indicator } = ok(fixture('running-max.pine'));
  const candles = walk(50);
  const peak = values(indicator, 0, candles);
  let hi = -Infinity;
  for (let i = 0; i < 50; i++) {
    hi = Math.max(hi, (candles[i] as Candle).h);
    assert.equal(peak[i], hi, `peak[${i}]`);
  }
  const bars = values(indicator, 1, candles);
  assert.equal(bars[0], 1);
  assert.equal(bars[49], 50);
  assert.equal(indicator.plots[1]?.style, 'histogram');
});

test('fixture: a for loop is refused with its line', () => {
  const out = refused(fixture('for-loop.pine'));
  assert.equal(out.line, 4);
  assert.match(out.message, /for/);
});

test('fixture: request.security is refused with its line', () => {
  const out = refused(fixture('security.pine'));
  assert.equal(out.line, 3);
  assert.match(out.message, /request\.security/);
});

test('the version line is required and must be 5', () => {
  assert.match(refused('indicator("T")\nplot(close)\n').message, /@version=5/);
  const v4 = refused('//@version=4\nstudy("T")\nplot(close)\n');
  assert.equal(v4.line, 1);
  assert.match(v4.message, /@version=5/);
});

test('indicator() takes its title and overlay by position or by name', () => {
  assert.equal(ok('//@version=5\nindicator("A", "a", true)\nplot(close)\n').indicator.overlay, true);
  assert.equal(ok('//@version=5\nindicator(title="B", overlay=true)\nplot(close)\n').indicator.title, 'B');
  assert.equal(ok('//@version=5\nindicator("C")\nplot(close)\n').indicator.overlay, false);
  assert.match(refused('//@version=5\nplot(close)\n').message, /indicator\(/);
});

test('if and else blocks that assign become a ternary', () => {
  const { indicator } = ok(`${HEAD}val = 0.0
if close > open
    val := high
else
    val := low
plot(val)
`);
  assert.deepEqual(indicator.plots[0]?.expr, ['?', ['>', 'close', 'open'], 'high', 'low']);
});

test('an else if chain nests, and a branch that does not assign keeps the value', () => {
  const { indicator } = ok(`${HEAD}val = close
if close > open
    val := high
else if close < open
    val := low
plot(val)
`);
  assert.deepEqual(indicator.plots[0]?.expr, ['?', ['>', 'close', 'open'], 'high', ['?', ['<', 'close', 'open'], 'low', 'close']]);
});

test('the ternary, history on a call, and unary minus translate', () => {
  const { indicator } = ok(`${HEAD}plot(close > open ? high : low)
plot(ta.sma(close, 5)[1])
plot(-close)
plot(close[2] - close)
`);
  assert.deepEqual(indicator.plots[0]?.expr, ['?', ['>', 'close', 'open'], 'high', 'low']);
  assert.deepEqual(indicator.plots[1]?.expr, ['hist', ['sma', 'close', 5], 1]);
  assert.deepEqual(indicator.plots[2]?.expr, ['-', 'close']);
  assert.deepEqual(indicator.plots[3]?.expr, ['-', ['hist', 'close', 2], 'close']);
});

test('operator precedence follows Pine', () => {
  const { indicator } = ok(`${HEAD}plot(close + high * 2 > low and not na(close) or volume == 0)
`);
  assert.deepEqual(indicator.plots[0]?.expr, [
    'or',
    ['and', ['>', ['+', 'close', ['*', 'high', 2]], 'low'], ['not', ['na', 'close']]],
    ['==', 'volume', 0],
  ]);
});

test('every input form becomes a parameter, and input.source fixes a series', () => {
  const { indicator } = ok(`${HEAD}a = input.int(14, "A")
b = input.float(2.5, minval=0.1, maxval=10, step=0.1)
c = input.bool(true, "C")
d = input(7)
e = input(1.5, title="E")
src = input.source(hl2)
plot(ta.sma(src, a) * b + c + d + e)
`);
  assert.deepEqual(indicator.inputs.a, { default: 14, int: true, title: 'A' });
  assert.deepEqual(indicator.inputs.b, { default: 2.5, min: 0.1, max: 10, int: false });
  assert.deepEqual(indicator.inputs.c, { default: 1, min: 0, max: 1, int: true, title: 'C' });
  assert.deepEqual(indicator.inputs.d, { default: 7, int: true });
  assert.deepEqual(indicator.inputs.e, { default: 1.5, int: false, title: 'E' });
  assert.equal(indicator.inputs.src, undefined);
  assert.deepEqual(indicator.plots[0]?.expr, ['+', ['+', ['+', ['*', ['sma', 'hl2', 'a'], 'b'], 'c'], 'd'], 'e']);
});

test('a length that is a plain constant folds, and one that is an expression is refused', () => {
  const { indicator } = ok(`${HEAD}len = 20
plot(ta.sma(close, len))
plot(ta.highest(10))
plot(ta.tr)
plot(ta.tr(true))
plot(ta.atr(len))
`);
  assert.deepEqual(indicator.plots[0]?.expr, ['sma', 'close', 20]);
  assert.deepEqual(indicator.plots[1]?.expr, ['highest', 'high', 10]);
  assert.deepEqual(indicator.plots[2]?.expr, ['tr']);
  assert.deepEqual(indicator.plots[3]?.expr, ['tr']);
  assert.deepEqual(indicator.plots[4]?.expr, ['atr', 20]);
  const out = refused(`${HEAD}len = input.int(10)\nplot(ta.sma(close, len * 2))\n`);
  assert.equal(out.line, 4);
  assert.match(out.message, /length of ta\.sma/);
});

test('colours map onto the app tones and a conditional colour is noted', () => {
  const { indicator, ignored } = ok(`${HEAD}plot(close, color=color.new(color.orange, 50))
plot(close, color=color.rgb(0, 200, 0))
plot(close, color=#ff0000)
plot(close, color=color.gray)
plot(close, color=close > open ? color.green : color.red)
plot(close, color=color.blue, style=plot.style_columns)
`);
  assert.deepEqual(
    indicator.plots.map((p) => p.color),
    ['warn', 'up', 'down', 'text', 'up', 'agent'],
  );
  assert.equal(indicator.plots[5]?.style, 'histogram');
  assert.equal(ignored.length, 1);
  assert.match(ignored[0] as string, /conditional colour.*line 7/);
});

test('plot titles default, and a plot id can feed fill but not an expression', () => {
  const { indicator, ignored } = ok(`${HEAD}p1 = plot(close)
p2 = plot(open, "Open")
fill(p1, p2, color=color.red)
bgcolor(close > open ? color.green : na)
alertcondition(close > open, "Up", "Up bar")
barcolor(color.red)
`);
  assert.deepEqual(
    indicator.plots.map((p) => p.title),
    ['Plot 1', 'Open'],
  );
  assert.equal(ignored.length, 4);
  const out = refused(`${HEAD}p1 = plot(close)\nplot(p1 + 1)\n`);
  assert.equal(out.line, 4);
  assert.match(out.message, /p1/);
});

test('a call spread over several lines is one statement', () => {
  const { indicator } = ok(`${HEAD}plot(
    ta.sma(close, 5),
    title="Five",
    color=color.lime
)
`);
  assert.deepEqual(indicator.plots[0], { title: 'Five', color: 'up', expr: ['sma', 'close', 5] });
});

test('hline takes a constant or an input default', () => {
  const { indicator } = ok(`${HEAD}ob = input.int(70)
hline(ob, "OB")
hline(30)
plot(close)
`);
  assert.deepEqual(indicator.hlines, [{ value: 70, title: 'OB' }, { value: 30 }]);
  assert.match(refused(`${HEAD}hline(ta.sma(close, 5))\nplot(close)\n`).message, /hline/);
});

test('a non-var variable that reads its own history is a recurrence', () => {
  const { indicator } = ok(`${HEAD}count = nz(count[1]) + 1
plot(count)
`);
  const candles = walk(10);
  const out = values(indicator, 0, candles);
  assert.deepEqual(out, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('a var read by another statement before its assignment is the carried value', () => {
  const { indicator } = ok(`${HEAD}var float acc = 0.0
before = acc
acc := acc + close
plot(before)
plot(acc)
`);
  const candles = walk(5);
  const after = values(indicator, 1, candles);
  const before = values(indicator, 0, candles);
  assert.equal(before[0], 0);
  assert.equal(after[0], (candles[0] as Candle).c);
  assert.ok(Math.abs((before[3] as number) - (after[2] as number)) < 1e-12);
});

test('two vars that read each other are refused', () => {
  const out = refused(`${HEAD}var a = 0.0
var b = 0.0
a := b[1] + 1
b := a[1] + 1
plot(a)
`);
  assert.match(out.message, /each other|depend/);
});

test('history deeper than one bar reads the committed value that many bars back', () => {
  const { indicator } = ok(`${HEAD}x = close * 2\nplot(x[3])\n`);
  assert.deepEqual(indicator.plots[0]?.expr, ['hist', ['*', 'close', 2], 3]);
  const counter = ok(`${HEAD}var x = 0.0\nx := x + 1\nplot(x[2])\n`);
  const out = values(counter.indicator, 0, walk(6));
  assert.deepEqual(out, [null, null, 1, 2, 3, 4]);
});

test('everything outside the subset is refused by name with its line', () => {
  const cases: [string, RegExp][] = [
    ['while close > 0\n    x = 1\nplot(close)\n', /while/],
    ['x = switch close\n    1 => 2\nplot(close)\n', /switch/],
    ['a = array.new_float(0)\nplot(close)\n', /array\./],
    ['f(x) => x * 2\nplot(f(close))\n', /function/],
    ['label.new(bar_index, close, "x")\nplot(close)\n', /label\./],
    ['line.new(0, 0, 1, 1)\nplot(close)\n', /line\./],
    ['varip float x = 0\nplot(close)\n', /varip/],
    ['plot(ta.hma(close, 9))\n', /ta\.hma/],
    ['plot(math.round(close))\n', /math\.round/],
    ['plot(time)\n', /time/],
    ['plot(syminfo.mintick)\n', /syminfo\.mintick/],
    ['x = if close > open\n    1\nelse\n    2\nplot(x)\n', /if/],
    ['import x/y/1 as z\nplot(close)\n', /import/],
    ['plot(close, title=close)\n', /title/],
    ['plot(str.tostring(close))\n', /str\./],
  ];
  for (const [body, re] of cases) {
    const out = refused(HEAD + body);
    assert.match(out.message, re, body);
    assert.equal(out.line, 3, body);
  }
  const strategy = refused('//@version=5\nstrategy("S")\nplot(close)\n');
  assert.equal(strategy.line, 2);
  assert.match(strategy.message, /strategy/);
});

test('a non-ascii identifier is refused where it stands', () => {
  const out = refused(`${HEAD}plot(сlose)\n`);
  assert.equal(out.line, 3);
  assert.match(out.message, /character/);
});

test('an unknown name is refused, and so is an unbalanced line', () => {
  assert.match(refused(`${HEAD}plot(closee)\n`).message, /closee/);
  assert.match(refused(`${HEAD}plot(close))\n`).message, /\)/);
  assert.match(refused(`${HEAD}plot((close)\n`).message, /\(/);
});

test('the parser is bounded: deep parentheses and long sources refuse rather than overflow', () => {
  const deep = `${HEAD}plot(${'('.repeat(5000)}close${')'.repeat(5000)})\n`;
  assert.match(refused(deep).message, /deep/);
  const long = `${HEAD}${'plot(close)\n'.repeat(60_000)}`;
  assert.match(refused(long).message, /large|plots/);
});
