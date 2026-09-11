// The JSON indicator format: what it accepts and, more to the point, what it refuses.
//
// A custom indicator is a file a human dropped in the data directory, so the schema is the
// first wall. Every limit in src/indicators-custom/schema.ts is pinned here because a limit
// nobody tests is a limit that drifts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { customIndicatorSchema, LIMITS } from '../../src/indicators-custom/schema.ts';
import type { Expr } from '../../src/indicators-custom/schema.ts';

function indicator(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Test',
    overlay: true,
    inputs: { length: { default: 20, min: 2, max: 400, int: true } },
    plots: [{ title: 'line', expr: ['sma', 'close', 'length'] }],
    ...overrides,
  };
}

function refusal(value: unknown): string {
  const out = customIndicatorSchema.safeParse(value);
  assert.equal(out.success, false, 'expected a refusal');
  if (out.success) return '';
  return out.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
}

function accepts(value: unknown): void {
  const out = customIndicatorSchema.safeParse(value);
  assert.ok(out.success, out.success ? '' : out.error.issues.map((i) => i.message).join('\n'));
}

test('a minimal indicator is accepted and defaults are applied', () => {
  const out = customIndicatorSchema.safeParse(indicator());
  assert.ok(out.success);
  if (!out.success) return;
  assert.equal(out.data.plots[0]?.style, undefined);
  assert.equal(out.data.hlines, undefined);
});

test('every op in the list is accepted with its arity', () => {
  const exprs: Expr[] = [
    ['sma', 'close', 14],
    ['ema', 'hl2', 'length'],
    ['rma', 'close', 14],
    ['wma', 'close', 14],
    ['rsi', 'close', 14],
    ['atr', 14],
    ['stdev', 'close', 20],
    ['highest', 'high', 20],
    ['lowest', 'low', 20],
    ['change', 'close'],
    ['change', 'close', 3],
    ['tr'],
    ['crossover', 'close', 'open'],
    ['crossunder', 'close', 'open'],
    ['abs', ['-', 'close', 'open']],
    ['max', 'close', 'open', 'high'],
    ['min', 'close', 'open'],
    ['sqrt', 'volume'],
    ['log', 'volume'],
    ['nz', ['sma', 'close', 5]],
    ['nz', ['sma', 'close', 5], 0],
    ['na', 'close'],
    ['+', 1, 2],
    ['-', 'close'],
    ['*', 'close', 2],
    ['/', 'close', 'open'],
    ['%', 'bar_index', 2],
    ['<', 'close', 'open'],
    ['<=', 'close', 'open'],
    ['>', 'close', 'open'],
    ['>=', 'close', 'open'],
    ['==', 'close', 'open'],
    ['!=', 'close', 'open'],
    ['and', ['>', 'close', 'open'], ['>', 'volume', 0]],
    ['or', ['>', 'close', 'open'], ['>', 'volume', 0]],
    ['not', ['>', 'close', 'open']],
    ['?', ['>', 'close', 'open'], 'high', 'low'],
    ['hist', 'close', 1],
    ['recur', 'na', ['max', ['nz', 'prev'], 'high']],
    'ohlc4',
    'hlc3',
    'na',
    1.5,
  ];
  for (const expr of exprs) {
    accepts(indicator({ plots: [{ title: 'p', expr }] }));
  }
});

test('an unknown op is refused by name', () => {
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['cum', 'close'] }] })), /unknown op 'cum'/);
});

test('a wrong arity is refused', () => {
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['sma', 'close'] }] })), /sma takes 2 arguments/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['tr', 'close'] }] })), /tr takes 0 arguments/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['?', 'close', 'open'] }] })), /\? takes 3 arguments/);
});

test('a name that is neither a series nor an input is refused', () => {
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['sma', 'closes', 5] }] })), /unknown name 'closes'/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: 'time' }] })), /unknown name 'time'/);
});

test('a period must be an integer literal or an input name, inside the bound', () => {
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['sma', 'close', 2.5] }] })), /whole number/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['sma', 'close', 0] }] })), /between 1 and 500/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['sma', 'close', 501] }] })), /between 1 and 500/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['sma', 'close', ['+', 1, 1]] }] })), /number or an input/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['sma', 'close', 'close'] }] })), /number or an input/);
});

test('history is bounded at 500 and refuses the absurd', () => {
  accepts(indicator({ plots: [{ title: 'p', expr: ['hist', 'close', LIMITS.history] }] }));
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['hist', 'close', 1e9] }] })), /between 0 and 500/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['hist', 'close', -1] }] })), /between 0 and 500/);
});

test('depth past 16 is refused', () => {
  let expr: Expr = 'close';
  for (let i = 0; i < LIMITS.depth; i++) expr = ['abs', expr];
  accepts(indicator({ plots: [{ title: 'p', expr }] }));
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['abs', expr] }] })), /deeper than 16/);
});

test('more than 400 nodes across the plots is refused', () => {
  // A balanced tree, so the count trips before the depth does: seven levels of '+' over
  // 'close' is 255 nodes, and two plots of it is 510.
  const wide = (k: number): Expr => (k === 0 ? 'close' : ['+', wide(k - 1), wide(k - 1)]);
  const expr = wide(7);
  accepts(indicator({ plots: [{ title: 'p', expr }] }));
  const two = indicator({ plots: [{ title: 'a', expr }, { title: 'b', expr }] });
  assert.match(refusal(two), /more than 400 nodes/);
});

test('a flat 100k node expression is refused without walking it', () => {
  const args: Expr[] = new Array(100_000).fill(1);
  const started = Date.now();
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['max', ...args] }] })), /max takes/);
  assert.ok(Date.now() - started < 500, 'the walker must exit early');
});

test('seven plots is one too many', () => {
  const plots = Array.from({ length: 7 }, (_, i) => ({ title: `p${i}`, expr: 'close' }));
  assert.match(refusal(indicator({ plots })), /plots/);
  assert.match(refusal(indicator({ plots: [] })), /plots/);
});

test('prototype names and series names cannot be inputs', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'close', 'prev', 'na']) {
    const inputs = JSON.parse(`{"${name}": {"default": 1}}`) as Record<string, unknown>;
    const out = customIndicatorSchema.safeParse(indicator({ inputs, plots: [{ title: 'p', expr: 'close' }] }));
    assert.equal(out.success, false, `${name} must be refused`);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('input names are ascii identifiers and the count is capped', () => {
  assert.match(refusal(indicator({ inputs: { 'bad name': { default: 1 } } })), /inputs/);
  assert.match(refusal(indicator({ inputs: { сlose: { default: 1 } } })), /inputs/);
  const many: Record<string, unknown> = {};
  for (let i = 0; i <= LIMITS.inputs; i++) many[`in${i}`] = { default: 1 };
  assert.match(refusal(indicator({ inputs: many, plots: [{ title: 'p', expr: 'close' }] })), /inputs/);
});

test('input bounds must be finite and must contain the default', () => {
  assert.match(refusal(indicator({ inputs: { length: { default: 1, min: 2 } } })), /default/);
  assert.match(refusal(indicator({ inputs: { length: { default: 1e999 } } })), /finite|Infinity|number/i);
  const bad = JSON.parse('{"length": {"default": 5, "max": 4}}') as Record<string, unknown>;
  assert.match(refusal(indicator({ inputs: bad })), /default/);
});

test('titles are bounded and carry no control or format characters', () => {
  assert.match(refusal(indicator({ title: '' })), /title/);
  assert.match(refusal(indicator({ title: 'x'.repeat(LIMITS.title + 1) })), /title/);
  assert.match(refusal(indicator({ title: 'ok ' })), /title/);
  assert.match(refusal(indicator({ title: 'ok‮' })), /title/);
  assert.match(refusal(indicator({ plots: [{ title: 'a\nb', expr: 'close' }] })), /title/);
});

test('prev only lives inside a recur step, under elementwise ops', () => {
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['+', 'prev', 1] }] })), /prev/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['recur', 'prev', 'close'] }] })), /prev/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['recur', 'na', ['sma', 'prev', 5]] }] })), /prev/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: ['recur', 'na', ['hist', 'prev', 1]] }] })), /prev/);
  assert.match(
    refusal(indicator({ plots: [{ title: 'p', expr: ['recur', 'na', ['recur', 'na', 'prev']] }] })),
    /recur/,
  );
  accepts(indicator({ plots: [{ title: 'p', expr: ['recur', 'na', ['+', ['nz', 'prev'], ['sma', 'close', 3]]] }] }));
});

test('hlines are bounded and finite', () => {
  accepts(indicator({ hlines: [{ value: 70, title: 'top' }, { value: 30 }] }));
  assert.match(refusal(indicator({ hlines: [{ value: 'x' }] })), /hlines/);
  const many = Array.from({ length: LIMITS.hlines + 1 }, (_, i) => ({ value: i }));
  assert.match(refusal(indicator({ hlines: many })), /hlines/);
});

test('unknown keys are refused so a typo cannot pass as a setting', () => {
  assert.match(refusal(indicator({ overlays: true })), /overlays|Unrecognized/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: 'close', colour: 'up' }] })), /colour|Unrecognized/);
});

test('colour is one of the app tones and style is line or histogram', () => {
  accepts(indicator({ plots: [{ title: 'p', expr: 'close', color: 'up', style: 'histogram' }] }));
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: 'close', color: '#ff0000' }] })), /color/);
  assert.match(refusal(indicator({ plots: [{ title: 'p', expr: 'close', style: 'area' }] })), /style/);
});
