// Every button label reads at 4.5:1 in every theme the window can be set to (term 9, B7).
//
// The stylesheets paint a label from one token onto a ground from another, and ui/theme.js
// rewrites both when set_theme lands. So the pairs are listed here per family, theme.js is run
// for the shipped colourway and for the hardest themes the server still accepts (the lightest
// ground, an accent at the text floor), and the contrast is computed the way src/view/theme.ts
// computes it. The one family whose label is a slot the server holds only to the 3:1 mark floor
// (danger, painted from --down) is checked on the shipped colourway and the gap is named.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { COLOURWAY_PALETTE, DEFAULT_THEME, MIN_TEXT_CONTRAST, applyPatch, contrastRatio } from '../../src/view/theme.ts';

const SOURCE = readFileSync(new URL('../../ui/theme.js', import.meta.url), 'utf8');
const PALETTE = COLOURWAY_PALETTE['green-on-black'];
const COMPONENTS = readFileSync(new URL('../../ui/design/components.css', import.meta.url), 'utf8');

type Props = Record<string, string>;

/* theme.js against a root that records what it writes; the tokens no slot reaches come from the
   palette, which tokens.css carries verbatim (theme-slots.test.ts pins the two together). */
function tokensFor(theme: Record<string, string>): Props {
  const props: Props = {
    '--text': PALETTE.text,
    '--text-2': PALETTE.text2,
    '--text-3': PALETTE.text3,
    '--warn': PALETTE.warn,
  };
  const sandbox: Record<string, any> = {
    window: {},
    document: {
      documentElement: {
        style: { setProperty: (name: string, value: string) => { props[name] = value; } },
        getAttribute: () => null,
        setAttribute: () => {},
      },
    },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => (name === '--text' ? PALETTE.text : '') }),
    console,
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/theme.js' });
  sandbox.window.PhosphorTheme.apply(theme);
  return props;
}

/* rgb(r, g, b) or #hex to #hex, the shape contrastRatio reads. */
function hex(value: string): string {
  const rgb = value.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  if (!rgb) return value;
  return '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

function ratio(props: Props, fg: string, bg: string): number {
  return contrastRatio(hex(props[fg] ?? ''), hex(props[bg] ?? ''));
}

/* The lightest grey ground the server accepts: the theme tool's own floor decides it, so a
   change to the floor moves this test with it. */
function lightestGround(): string {
  let best = DEFAULT_THEME.background;
  for (let v = 0; v < 256; v++) {
    const grey = '#' + v.toString(16).padStart(2, '0').repeat(3);
    if (applyPatch(DEFAULT_THEME, { background: grey }).ok) best = grey;
  }
  return best;
}

/* An accent that only just clears the text floor on the shipped ground: the dimmest green the
   server accepts, so the label on the primary is checked where it is weakest. */
function dimmestAccent(): string {
  let best = DEFAULT_THEME.accent;
  for (let v = 255; v >= 0; v--) {
    const green = '#00' + v.toString(16).padStart(2, '0') + '00';
    const out = applyPatch(DEFAULT_THEME, { accent: green });
    if (out.ok) best = green;
    else break;
  }
  return best;
}

const THEMES: Array<[name: string, theme: Record<string, string>]> = [
  ['green on black', { ...DEFAULT_THEME }],
  ['the lightest ground the server accepts', { ...DEFAULT_THEME, background: lightestGround() }],
  ['the dimmest accent the server accepts', { ...DEFAULT_THEME, accent: dimmestAccent() }],
];

/* Family, the token its label is painted from, the tokens it can sit on. The pairs are read off
   ui/design: .btn is --text on --bg-2 (its own fill); the primary is --on-ink on --ink; ghost,
   quiet, the chips, the tabs and the rows are text tones on the grounds the window has. */
const PAIRS: Array<[family: string, label: string, grounds: string[]]> = [
  ['btn', '--text', ['--bg-2']],
  ['btn-primary', '--on-ink', ['--ink']],
  ['btn-ghost', '--text', ['--bg-0', '--bg-1', '--bg-2']],
  ['btn-quiet', '--text-2', ['--bg-0', '--bg-1', '--bg-2']],
  ['chip (pressed or not)', '--text-2', ['--bg-2']],
  ['tab', '--text-2', ['--bg-1']],
  ['check-row', '--text-2', ['--bg-2']],
  ['netpick-link, dock-next, steps-fold, rule-group-title', '--text-2', ['--bg-0', '--bg-1', '--bg-2']],
  ['choice, net-tile, holding-head, fold-head', '--text', ['--bg-0', '--bg-1', '--bg-2']],
];

for (const [name, theme] of THEMES) {
  test(`every button label reads at ${MIN_TEXT_CONTRAST}:1 on ${name}`, () => {
    assert.ok(applyPatch(DEFAULT_THEME, theme).ok, `the server refuses this theme, so it is not one the window can be set to`);
    const props = tokensFor(theme);
    for (const [family, label, grounds] of PAIRS) {
      for (const ground of grounds) {
        const r = ratio(props, label, ground);
        assert.ok(r >= MIN_TEXT_CONTRAST, `${family}: ${label} ${props[label]} on ${ground} ${props[ground]} is ${r.toFixed(2)}:1`);
      }
    }
  });
}

test('the primary keeps its label readable while hovered and while pressed', () => {
  // components.css: hover mixes 12 percent of white into the accent, the press 22. The label
  // is --on-ink, which is the ground on every theme the server accepts, so a step toward the
  // ground is a step under the floor: the dimmest legal accent went to 3.8:1 that way.
  assert.match(COMPONENTS, /\.btn-primary:hover:not\(:disabled\)\s*\{\s*background:\s*color-mix\(in srgb, var\(--ink\) 88%, #FFFFFF\);/);
  assert.match(COMPONENTS, /\.btn-primary\s*\{[^}]*--btn-bg-active:\s*color-mix\(in srgb, var\(--ink\) 78%, #FFFFFF\);/);
  const mix = (a: string, b: string, share: number): string =>
    '#' + [0, 1, 2].map((i) => Math.round(parseInt(a.slice(1 + i * 2, 3 + i * 2), 16) * share + parseInt(b.slice(1 + i * 2, 3 + i * 2), 16) * (1 - share)).toString(16).padStart(2, '0')).join('');
  for (const [name, theme] of THEMES) {
    const props = tokensFor(theme);
    const ink = hex(props['--ink'] ?? '');
    for (const [state, share] of [['hovered', 0.88], ['pressed', 0.78]] as const) {
      const r = contrastRatio(hex(props['--on-ink'] ?? ''), mix(ink, '#ffffff', share));
      assert.ok(r >= MIN_TEXT_CONTRAST, `${name}: the ${state} primary's label is ${r.toFixed(2)}:1`);
    }
  }
});

/* The danger label is painted from --down, and the server holds --down to the 3:1 mark floor
   (src/view/theme.ts, MIN_MARK_CONTRAST) although the window sets words in it: Turn off, Forget
   this wallet, Failed, the amount that left. On the shipped colourway it reads at 5.98:1; a theme
   with a down colour between 3:1 and 4.5:1 is accepted by the server and puts every one of those
   words under the text floor. That is the server's floor to raise, not a stylesheet's to hide. */
test('the danger label reads on the shipped colourway, and names the floor it depends on', () => {
  const props = tokensFor({ ...DEFAULT_THEME });
  for (const ground of ['--bg-0', '--bg-1', '--bg-2']) {
    const r = ratio(props, '--down', ground);
    assert.ok(r >= MIN_TEXT_CONTRAST, `btn-danger: --down on ${ground} is ${r.toFixed(2)}:1`);
  }
  const weakest = applyPatch(DEFAULT_THEME, { down: '#a0505c' });
  assert.ok(weakest.ok, 'the server now refuses a down colour under the text floor: retire this note and hold btn-danger with the rest');
});
