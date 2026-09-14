// The five theme slots are an MCP contract other agents already call, so the
// interface rebuild is not allowed to quietly change what set_theme accepts.
// This asserts the slot names, the hex-only grammar, and both contrast floors
// against the palette the window now ships with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLOURWAYS,
  COLOURWAY_PALETTE,
  DEFAULT_THEME,
  MIN_MARK_CONTRAST,
  MIN_TEXT_CONTRAST,
  applyPatch,
  colourwayTheme,
  contrastRatio,
  normaliseColour,
  readTheme,
} from '../../src/view/theme.ts';

const SLOTS = ['accent', 'background', 'up', 'down', 'agent'] as const;

test('the five slots are the five slots, and the colourway is the one word beside them', () => {
  // The colourway was added on 2026-09-14 with the official mark. It is a name from a closed
  // list, never a colour, so the hex-only grammar below still covers every colour there is.
  assert.deepEqual(Object.keys(DEFAULT_THEME).sort(), [...SLOTS, 'profile'].sort());
  assert.equal(DEFAULT_THEME.profile, 'green-on-black');
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

/* ---------- the colourways ---------- */

test('there are three colourways and they are the three the mark ships in', () => {
  assert.deepEqual([...COLOURWAYS], ['green-on-black', 'black-on-green', 'black-on-white']);
});

test('every colourway passes every floor on its own ground, the gate red included', () => {
  for (const name of COLOURWAYS) {
    const palette = COLOURWAY_PALETTE[name];
    const ground = palette.slots.background;
    // The five slots, through the same check a patch goes through.
    const result = applyPatch(colourwayTheme(name), {});
    assert.equal(result.ok, true, result.ok ? '' : `${name}: ${result.error}`);
    // The tokens no slot reaches, which the patch check never sees.
    const text: [string, string, number][] = [
      ['text', palette.text, MIN_TEXT_CONTRAST],
      ['text2', palette.text2, MIN_TEXT_CONTRAST],
      ['text3', palette.text3, MIN_MARK_CONTRAST],
      ['warn', palette.warn, MIN_TEXT_CONTRAST],
      ['gate', palette.gate, MIN_TEXT_CONTRAST],
    ];
    for (const [what, colour, floor] of text) {
      const ratio = contrastRatio(colour, ground);
      assert.ok(ratio >= floor, `${name}: ${what} ${colour} on ${ground} is ${ratio.toFixed(2)}:1, under ${floor}:1`);
    }
  }
});

test('no one red clears the text floor on both the black and the green ground', () => {
  // The reason the gate red is per colourway rather than one constant. If this ever passes,
  // the palette can go back to one red and the comment in theme.ts is wrong.
  const black = COLOURWAY_PALETTE['green-on-black'];
  const green = COLOURWAY_PALETTE['black-on-green'];
  assert.ok(contrastRatio(black.gate, green.slots.background) < MIN_TEXT_CONTRAST);
  assert.ok(contrastRatio(green.gate, black.slots.background) < MIN_TEXT_CONTRAST);
});

/* The stylesheet is what the window paints and the table above is what the server checks.
   They are two copies of one decision, so this reads both and refuses to let them drift. */
function cssBlock(source: string, selector: string): Record<string, string> {
  const start = source.indexOf(selector + ' {');
  assert.ok(start >= 0, `${selector} block is missing`);
  const body = source.slice(start, source.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const line of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[line[1]] = line[2].trim().toLowerCase();
  return out;
}

const TOKENS_CSS = readFileSync(new URL('../../ui/design/tokens.css', import.meta.url), 'utf8');

test('tokens.css carries the same values as the colourway table, for all three', () => {
  for (const name of COLOURWAYS) {
    const palette = COLOURWAY_PALETTE[name];
    const block = cssBlock(TOKENS_CSS, name === 'green-on-black' ? ':root' : `:root[data-profile="${name}"]`);
    const expect: Record<string, string> = {
      'bg-0': palette.slots.background,
      ink: palette.slots.accent,
      up: palette.slots.up,
      down: palette.slots.down,
      agent: palette.slots.agent,
      text: palette.text,
      'text-2': palette.text2,
      'text-3': palette.text3,
      warn: palette.warn,
    };
    for (const [token, value] of Object.entries(expect)) {
      assert.equal(block[token], value, `${name}: --${token} is ${block[token]} in tokens.css and ${value} in theme.ts`);
    }
  }
});

test('the splash paints the same ground, text and ink as the window, for all three', () => {
  const splash = readFileSync(new URL('../../src-tauri/frontend/index.html', import.meta.url), 'utf8');
  for (const name of COLOURWAYS) {
    const palette = COLOURWAY_PALETTE[name];
    const block = cssBlock(splash, name === 'green-on-black' ? ':root' : `:root[data-profile="${name}"]`);
    assert.equal(block['bg-0'], palette.slots.background, `${name}: splash ground`);
    assert.equal(block.ink, palette.slots.accent, `${name}: splash ink`);
    assert.equal(block.text, palette.text, `${name}: splash text`);
    assert.equal(block['text-2'], palette.text2, `${name}: splash text-2`);
  }
});

test('picking a colourway repaints every slot to its own colours, and a slot in the same patch lands on top', () => {
  const out = applyPatch(DEFAULT_THEME, { profile: 'black-on-white', accent: '#1a56db' });
  assert.equal(out.ok, true, out.ok ? '' : out.error);
  if (!out.ok) return;
  assert.equal(out.theme.profile, 'black-on-white');
  assert.equal(out.theme.background, '#ffffff');
  assert.equal(out.theme.up, COLOURWAY_PALETTE['black-on-white'].slots.up);
  assert.equal(out.theme.accent, '#1a56db');
});

test('a colourway that is not one of the three is refused by name', () => {
  const out = applyPatch(DEFAULT_THEME, { profile: 'dark' });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /unknown colourway/);
});

test('reset goes back to the colourway that is current, not to green on black', () => {
  const white = applyPatch(DEFAULT_THEME, { profile: 'black-on-white', accent: '#1a56db' });
  assert.equal(white.ok, true);
  if (!white.ok) return;
  const out = applyPatch(white.theme, { reset: true });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.theme, colourwayTheme('black-on-white'));
});

test('the gate check follows the colourway, so a ground its own gate red reads on is allowed', () => {
  // On green on black's gate red, a white ground is under the floor; on white's own it is not.
  const out = applyPatch(DEFAULT_THEME, { profile: 'black-on-white' });
  assert.equal(out.ok, true, out.ok ? '' : out.error);
});

test('a theme file from before the colourways comes back as green on black, and one with a colourway keeps it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'phosphor-theme-'));
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ accent: '#5b8def', background: '#0b0d10', up: '#33ff66', down: '#ff5a6e', agent: '#b79cff' }));
  const old = readTheme(dir);
  assert.equal(old.profile, 'green-on-black');
  assert.equal(old.accent, '#5b8def');

  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ ...colourwayTheme('black-on-green'), agent: '#4b1fa6' }));
  const green = readTheme(dir);
  assert.equal(green.profile, 'black-on-green');
  assert.equal(green.background, '#3fff6c');

  // A colourway nobody has heard of is the default, not a crash and not a half-painted window.
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ ...colourwayTheme('black-on-white'), profile: 'sepia' }));
  assert.equal(readTheme(dir).profile, 'green-on-black');
});
