// What ui/theme.js writes onto the document for a theme, run rather than read.
//
// Three things are asserted. The five slots land as custom properties on the root and the chart
// is told, reading its text colour off the stylesheet. The label on the action fill is the ground
// whenever the ground reads on the accent, which is what puts black letters on the green button.
// And the colourway name is a name only: since the window went dark only (2026-09-15) nothing is
// written onto the root for it, whatever the theme says, so no attribute can select a stylesheet
// block that no longer exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { COLOURWAY_PALETTE, colourwayTheme } from '../../src/view/theme.ts';

const SOURCE = readFileSync(new URL('../../ui/theme.js', import.meta.url), 'utf8');

type Any = Record<string, any>;

type Loaded = {
  apply: (theme: unknown) => void;
  props: Record<string, string>;
  attrs: Record<string, string>;
  chartCalls: Any[];
  miniRethemes: () => number;
};

/* A root element honest about the two things theme.js could touch on it: its inline style and
   its attributes. getComputedStyle answers --text the way the one stylesheet block would. */
function load(): Loaded {
  const props: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  const chartCalls: Any[] = [];
  let rethemes = 0;
  const root = {
    style: { setProperty: (name: string, value: string) => { props[name] = value; } },
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
  };
  const sandbox: Any = {
    window: {
      chartTheme: (theme: Any) => { chartCalls.push(theme); },
      PhosphorMini: { retheme: () => { rethemes += 1; } },
    },
    document: { documentElement: root },
    getComputedStyle: () => ({
      getPropertyValue: (name: string) => (name === '--text' ? COLOURWAY_PALETTE['green-on-black'].text : ''),
    }),
    console,
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/theme.js' });
  return { apply: sandbox.window.PhosphorTheme.apply, props, attrs, chartCalls, miniRethemes: () => rethemes };
}

test('the slots land on the root and the chart reads the text colour off the stylesheet', () => {
  const ui = load();
  ui.apply(colourwayTheme('green-on-black'));
  assert.equal(ui.props['--bg-0'], 'rgb(14, 15, 19)');
  assert.equal(ui.props['--ink'], 'rgb(63, 255, 108)');
  assert.equal(ui.chartCalls.length, 1);
  assert.equal(ui.chartCalls[0].text, '#eceef1');
  assert.equal(ui.miniRethemes(), 1);
});

test('the label on the action fill is the ground when the ground reads on the accent, else white', () => {
  const ui = load();
  ui.apply(colourwayTheme('green-on-black'));
  assert.equal(ui.props['--on-ink'], 'rgb(14, 15, 19)');
  // A dark accent an agent set: the graphite ground would not read on it, so the label is white.
  ui.apply({ ...colourwayTheme('green-on-black'), accent: '#7a4fd6' });
  assert.equal(ui.props['--on-ink'], '#FFFFFF');
});

test('a surface is lifted toward white on the dark ground', () => {
  const ui = load();
  ui.apply(colourwayTheme('green-on-black'));
  assert.equal(ui.props['--bg-1'], 'rgb(22, 23, 27)');
  assert.equal(ui.props['--bg-2'], 'rgb(31, 32, 36)');
});

test('the colourway is a name only: nothing is written onto the root for it, known or not', () => {
  const ui = load();
  ui.apply(colourwayTheme('green-on-black'));
  assert.deepEqual(Object.keys(ui.attrs), []);
  ui.apply({ ...colourwayTheme('green-on-black'), profile: 'black-on-white' });
  assert.deepEqual(Object.keys(ui.attrs), []);
  ui.apply({ ...colourwayTheme('green-on-black'), profile: 'sepia' });
  assert.deepEqual(Object.keys(ui.attrs), []);
  assert.equal(ui.props['--ink'], 'rgb(63, 255, 108)');
});

test('the same theme twice is applied once', () => {
  const ui = load();
  ui.apply(colourwayTheme('green-on-black'));
  ui.apply(colourwayTheme('green-on-black'));
  assert.equal(ui.chartCalls.length, 1);
});
