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

test('no slot is green', () => {
  // The build has one rule about colour that is absolute: no green anywhere.
  // Hue is checked rather than a hex list, so a new green cannot slip past by
  // being a shade nobody wrote down.
  for (const slot of SLOTS) {
    const hex = DEFAULT_THEME[slot];
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < 0.08) continue; // a grey has no hue to be green
    let hue = 0;
    if (max === r) hue = 60 * (((g - b) / chroma) % 6);
    else if (max === g) hue = 60 * ((b - r) / chroma + 2);
    else hue = 60 * ((r - g) / chroma + 4);
    if (hue < 0) hue += 360;
    assert.ok(hue < 70 || hue > 175, `${slot} ${hex} sits at hue ${hue.toFixed(0)}, which reads as green`);
  }
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
