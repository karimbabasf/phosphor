// The chart's one label column.
//
// Three writers used to put text down the left edge of the plot with three ideas of where the
// next line goes, and two of them printing on one y is a number nobody can read. The column is
// one pass with four promises: a 13 px pitch from y 16, order kept, lifted back on screen when
// the stack runs off the bottom, and cut at eight with a line that says how many more.
//
// ui/chart/labels.js is a browser script: running it in a context makes its functions the test
// surface, the same harness the engine's own tests use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

function load(): Any {
  const source = readFileSync(new URL('../../ui/chart/labels.js', import.meta.url), 'utf8');
  const sandbox: Any = { console };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'ui/chart/labels.js' });
  return sandbox;
}

const item = (y: number, text = 'x') => ({ y, text, tone: 'text' });

test('labels sit on a 13 px pitch from y 16 and keep their order', () => {
  const s = load();
  const out = s.labelLayout([item(16, 'a'), item(18, 'b'), item(20, 'c')], 0, 400);
  assert.deepEqual(out.placed.map((p: Any) => [p.text, p.labelY]), [['a', 16], ['b', 29], ['c', 42]]);
  assert.equal(out.more, 0);
});

test('a label above the top of the column is brought down to it, never lost', () => {
  const s = load();
  const out = s.labelLayout([item(2, 'a')], 0, 400);
  assert.equal(out.placed[0].labelY, 16);
});

test('a label is pushed down by the one above it and never up past it', () => {
  const s = load();
  // The level at 100 and the entry at 104 collide; the entry moves, the level does not.
  const out = s.labelLayout([item(104, 'entry'), item(100, 'level'), item(300, 'far')], 0, 400);
  assert.deepEqual(out.placed.map((p: Any) => [p.text, p.labelY]), [['level', 100], ['entry', 113], ['far', 300]]);
});

test('a stack that runs off the bottom is lifted back on screen as one run', () => {
  const s = load();
  const out = s.labelLayout([item(390, 'a'), item(392, 'b'), item(394, 'c')], 0, 400);
  const ys = out.placed.map((p: Any) => p.labelY);
  assert.ok(ys[2] <= 396, `the last label sits off the pane at ${ys[2]}`);
  assert.equal(ys[1] - ys[0], 13);
  assert.equal(ys[2] - ys[1], 13);
});

test('past eight labels the column says how many more rather than printing a wall', () => {
  const s = load();
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push(item(20 + i * 4, 'l' + i));
  const out = s.labelLayout(many, 0, 600);
  assert.equal(out.more, 4);
  assert.equal(out.placed.length, 9);
  const last = out.placed[out.placed.length - 1];
  assert.equal(last.text, '+4 more');
  assert.equal(last.overflow, true);
  assert.equal(out.placed[0].text, 'l0', 'the first labels by y are the ones kept');
});

test('drawing a column pads, paints in the tone asked for, and rings the spotlighted one', () => {
  const s = load();
  const calls: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${ctx.fillStyle} ${x},${y},${w},${h}`),
    fillText: (t: string, x: number, y: number) => calls.push(`text ${ctx.fillStyle} ${t} ${x},${y}`),
    strokeRect: (x: number, y: number, w: number, h: number) => calls.push(`ring ${ctx.strokeStyle} ${x},${y},${w},${h}`),
  };
  const inkOf = (tone: string, alpha: number) => `${tone}@${alpha}`;
  const placed = s.labelLayout([{ y: 20, text: 'Stop 63,200', tone: 'down', ring: true }], 0, 400).placed;
  const boxes = s.labelDraw(ctx, placed, inkOf, 'pad');
  assert.ok(calls[0].startsWith('rect pad '), 'the ground goes down before the text');
  assert.ok(calls.some((c) => c.startsWith('text down@0.9 Stop 63,200 5,20')), calls.join('\n'));
  assert.ok(calls.some((c) => c.startsWith('ring warn@0.95')), 'no ring on the spotlighted label');
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].item.text, 'Stop 63,200');
});

test('a line in more than one ink is one item with parts', () => {
  const s = load();
  const calls: string[] = [];
  const ctx = {
    fillStyle: '',
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillRect: () => {},
    fillText: (t: string) => calls.push(`${ctx.fillStyle}:${t}`),
    strokeRect: () => {},
  };
  const placed = s.labelLayout([{ y: 16, parts: [{ text: 'BTC-USD', tone: 'hi' }, { text: '1h', tone: 'text2' }] }], 0, 400).placed;
  s.labelDraw(ctx, placed, (tone: string) => tone, null);
  assert.deepEqual(calls, ['hi:BTC-USD', 'text2:1h']);
});
