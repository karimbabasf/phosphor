// What ui/theme.js writes onto the document for a theme, run rather than read.
//
// Three things are asserted. The colourway lands as one attribute on the root, before the slots
// are written, so the stylesheet's [data-profile] block is what the chart reads its text colour
// from. The label on the action fill is the ground whenever the ground reads on the accent, which
// is what puts green letters on the black button of the green colourway. And a colourway that is
// not one of the two leaves the attribute alone: the server never sends one, and the root falling
// back to green on black is the right answer to a name it has never heard.

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

/* A root element honest about the two things theme.js touches on it: its inline style and its
   attributes. getComputedStyle answers --text from the attribute, the way the stylesheet would. */
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
      getPropertyValue: (name: string) => {
        if (name !== '--text') return '';
        const profile = attrs['data-profile'] ?? 'green-on-black';
        return COLOURWAY_PALETTE[profile as keyof typeof COLOURWAY_PALETTE].text;
      },
    }),
    console,
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/theme.js' });
  return { apply: sandbox.window.PhosphorTheme.apply, props, attrs, chartCalls, miniRethemes: () => rethemes };
}

test('a colourway is written as data-profile on the root, and the chart reads its text colour', () => {
  const ui = load();
  ui.apply(colourwayTheme('black-on-white'));
  assert.equal(ui.attrs['data-profile'], 'black-on-white');
  assert.equal(ui.props['--bg-0'], 'rgb(255, 255, 255)');
  assert.equal(ui.chartCalls.length, 1);
  assert.equal(ui.chartCalls[0].text, '#111111');
  assert.equal(ui.miniRethemes(), 1);
});

test('the label on the action fill is the ground, in both colourways', () => {
  const ui = load();
  ui.apply(colourwayTheme('green-on-black'));
  assert.equal(ui.props['--on-ink'], 'rgb(14, 15, 19)');
  ui.apply(colourwayTheme('black-on-white'));
  assert.equal(ui.props['--on-ink'], 'rgb(255, 255, 255)');
});

test('a surface is lifted toward black on a light ground and toward white on a dark one', () => {
  const ui = load();
  ui.apply(colourwayTheme('black-on-white'));
  assert.equal(ui.props['--bg-1'], 'rgb(246, 246, 246)');
  ui.apply(colourwayTheme('green-on-black'));
  assert.equal(ui.props['--bg-1'], 'rgb(22, 23, 27)');
});

test('a colourway that is not one of the two leaves the attribute alone', () => {
  const ui = load();
  ui.apply({ ...colourwayTheme('green-on-black'), profile: 'sepia' });
  assert.equal('data-profile' in ui.attrs, false);
  assert.equal(ui.props['--ink'], 'rgb(63, 255, 108)');
});

test('the same theme twice is applied once', () => {
  const ui = load();
  ui.apply(colourwayTheme('black-on-white'));
  ui.apply(colourwayTheme('black-on-white'));
  assert.equal(ui.chartCalls.length, 1);
});
