// The five theme slots are an MCP contract other agents already call, so the
// interface rebuild is not allowed to quietly change what set_theme accepts.
// This asserts the slot names, the hex-only grammar, and both contrast floors
// against the palette the window now ships with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_THEME, applyPatch, normaliseColour } from '../../src/view/theme.ts';

const SLOTS = ['accent', 'background', 'up', 'down', 'agent'] as const;

test('the five slots are the five slots', () => {
  assert.deepEqual(Object.keys(DEFAULT_THEME).sort(), [...SLOTS].sort());
});

test('every default is a six digit hex colour', () => {
  for (const slot of SLOTS) {
    const value = DEFAULT_THEME[slot];
    assert.match(value, /^#[0-9a-f]{6}$/, `${slot} is ${value}`);
  }
});

test('the shipped defaults pass their own contrast floors', () => {
  const result = applyPatch(DEFAULT_THEME, { ...DEFAULT_THEME });
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

function hueOf(hex: string): number | null {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma < 0.08) return null; // a grey has no hue to read
  let hue = 0;
  if (max === r) hue = 60 * (((g - b) / chroma) % 6);
  else if (max === g) hue = 60 * ((b - r) / chroma + 2);
  else hue = 60 * ((r - g) / chroma + 4);
  return hue < 0 ? hue + 360 : hue;
}

/* This test used to assert the opposite: no slot is green, anywhere. That was
   the v1 direction (monochrome graphite, white acts, blue is up), and the
   reason for it was real: blue against rose is separable by the roughly one
   person in twelve who cannot separate green from red.

   It was reversed on 2026-09-02 by the person who owns the product, looking at
   the built result: a window with no green in it reads as a filter laid over
   the app rather than a design, and it costs Phosphor the one colour it is
   named after. The accessible pairing is a set_theme call away and nothing in
   the code prevents it, which is the right place for that choice to live.

   What is guarded now is the thing that actually has to hold: up and down must
   stay far apart, so the pair never collapses into two shades of one hue. */
test('the identity green is the accent and the up colour', () => {
  assert.equal(DEFAULT_THEME.accent, DEFAULT_THEME.up, 'the action colour and up are one decision');
  const hue = hueOf(DEFAULT_THEME.accent);
  assert.notEqual(hue, null, 'the accent has a hue to read');
  assert.ok(hue !== null && hue > 90 && hue < 165, `accent sits at hue ${hue?.toFixed(0)}, which is not phosphor green`);
});

test('up and down are far enough apart to never read as one hue', () => {
  const up = hueOf(DEFAULT_THEME.up);
  const down = hueOf(DEFAULT_THEME.down);
  assert.ok(up !== null && down !== null, 'both directions carry a hue');
  const raw = Math.abs((up as number) - (down as number));
  const apart = Math.min(raw, 360 - raw);
  assert.ok(apart > 90, `up and down are ${apart.toFixed(0)} degrees apart, close enough to be confused`);
});

test('a slot that is not a hex colour is refused whole', () => {
  const result = applyPatch(DEFAULT_THEME, { accent: 'rebeccapurple' });
  assert.equal(result.ok, false);
});

test('an unknown slot name is refused rather than ignored', () => {
  const result = applyPatch(DEFAULT_THEME, { foreground: '#ffffff' });
  assert.equal(result.ok, false);
});

test('a background nothing can be read on is refused', () => {
  // White text and a white ground: the window would be blank. The floor exists
  // so an agent cannot paint the app into a state a person cannot get out of.
  const result = applyPatch(DEFAULT_THEME, { background: '#ffffff' });
  assert.equal(result.ok, false);
});

test('shorthand hex is expanded rather than rejected', () => {
  assert.equal(normaliseColour('#FFF'), '#ffffff');
  assert.equal(normaliseColour('#5B8DEF'), '#5b8def');
  assert.equal(normaliseColour('not a colour'), null);
});
