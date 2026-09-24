// The colours of the window, and the two things an agent may never repaint.
//
// Persisted the same way view.json is, and for the same reason: a colour the agent set is
// part of what the human is looking at, so it has to survive a restart or the app comes back
// disagreeing with the conversation that set it.
//
// WHAT IS DELIBERATELY NOT A SLOT. The safety gate's red is not here. Pending approvals, the
// refusal lines and the gate-disabled banner are the one alarm on this page, and an agent that
// could paint them the same colour as the ground could hide the ask it is waiting on. It is not
// guarded, it is absent: the slot does not exist, so no argument reaches it. Same argument
// src/mcp.ts makes about the tools it never registers.
//
// WHAT THE CONTRAST FLOOR IS FOR. The background IS a slot, and a background near the accent
// makes the same text invisible without ever naming the gate. So every slot, plus the gate red
// the agent cannot name, is checked against the background before a theme is written, and a
// theme that would make anything unreadable is refused with the pair and the ratio. This is the
// only rule in this file that is about safety rather than taste, which is why it is the only one
// that returns an error.
//
// Values are hex and nothing else. A colour reaching the browser becomes a CSS custom property,
// so anything that is not provably a colour is a string an agent chose landing in a stylesheet.
// `#rgb` and `#rrggbb` are the whole grammar. Named colours would be safe too and are still
// refused: one shape is one thing to prove.
//
// THE COLOURWAY. The window ships in one of the mark's colourways, green on black
// (brand/README.md). The mark's black on green was cut from the window on 2026-09-14 (Karim:
// "remove the neon green") and black on white on 2026-09-15 (dark only). The colourway is a
// whole palette, not five slots: the text, the warning amber and the gate's red belong to the
// ground, and the agent cannot name any of them. The palette was checked against every floor
// before it was written down (tests/unit/theme-slots.test.ts), and the five slots sit on top of
// it. The `profile` field stays in the theme and the tool so an agent or a theme.json that names
// green-on-black keeps working; any other name is refused or read as the default.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../fsatomic.ts';

const FILE = 'theme.json';

export type ThemeSlot = 'accent' | 'background' | 'up' | 'down' | 'agent';

export type Colourway = 'green-on-black';

export type Theme = Record<ThemeSlot, string> & { profile: Colourway };

export const THEME_SLOTS: readonly ThemeSlot[] = ['accent', 'background', 'up', 'down', 'agent'];

export const COLOURWAYS: readonly Colourway[] = ['green-on-black'];

// What every slot means, handed to the agent in the tool description so it never has to guess
// which one moves which pixels.
export const SLOT_MEANING: Readonly<Record<ThemeSlot, string>> = {
  accent: 'the action colour: the fill on every primary button and the label on it',
  background: 'the ground behind everything, and the panels and hairlines derived from it',
  up: 'candles that closed up',
  down: 'candles that closed down',
  agent: 'the levels, marks and trend lines the agent itself drew, so its own work can be told from the human’s',
};

export type Palette = {
  // The five slots as the colourway ships them.
  slots: Record<ThemeSlot, string>;
  // The tokens no slot reaches. The window paints them from ui/design/tokens.css, which carries
  // the same values on :root; the test that pins the two together reads both.
  text: string;
  text2: string;
  text3: string;
  warn: string;
  // The gate's red for this ground. Checked like a slot, never settable like one.
  gate: string;
};

// Soft depth since 2026-09-23 (Karim picked it from three looks): the mark's green, softened, on
// a warm charcoal ground. The name stays green-on-black: it is the key a theme.json and an agent
// already use, and it is still the mark's green on the darkest ground the window has.
export const COLOURWAY_PALETTE: Readonly<Record<Colourway, Palette>> = {
  'green-on-black': {
    slots: { accent: '#52e893', background: '#161210', up: '#52e893', down: '#ff6b5b', agent: '#b79cff' },
    text: '#f8f0e8',
    text2: '#bcaea1',
    text3: '#9a8c7f',
    warn: '#f5b942',
    gate: '#ff4d40',
  },
};

// The colourway's own slots before soft depth. A theme.json written by a reset, or by a
// set_theme that changed one slot, carries the rest as they shipped then; read back, they mean
// the colourway, so they come back as today's colours rather than repainting the old ground.
const RETIRED: Readonly<Partial<Record<ThemeSlot, readonly string[]>>> = {
  accent: ['#3fff6c'],
  background: ['#0e0f13'],
  up: ['#3fff6c'],
  down: ['#ff5a6e'],
};

// How a colourway is described to the agent and labelled for the human, one line each.
export const COLOURWAY_LABEL: Readonly<Record<Colourway, string>> = {
  'green-on-black': 'Green on black',
};

export const DEFAULT_COLOURWAY: Colourway = 'green-on-black';

/* The theme a colourway starts as: its own five slots and its name. */
export function colourwayTheme(profile: Colourway): Theme {
  return { ...COLOURWAY_PALETTE[profile].slots, profile };
}

export const DEFAULT_THEME: Theme = colourwayTheme(DEFAULT_COLOURWAY);

export function isColourway(raw: unknown): raw is Colourway {
  return typeof raw === 'string' && (COLOURWAYS as readonly string[]).includes(raw);
}

// Two floors, because two kinds of thing are being checked.
//
// TEXT is 4.5:1, WCAG's floor for normal text. The accent is the label on every primary
// button; the agent ink is the labels on what it drew; the gate red is the word REFUSED. All
// of them are read.
//
// A MARK is 3:1, WCAG's floor for a non-text graphical object. A candle body is a shape whose
// position carries the meaning, not a glyph. The split was found when a single 4.5 floor
// refused a down-candle the window had shipped with for months. Down went back to the text
// floor on 2026-09-21: the window sets words in it (Turn off, Failed, the amount that left,
// No), and a down colour the tool accepted at 3.5:1 put every one of them under the floor.
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_MARK_CONTRAST = 3;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/* A colour, or null. Nothing here trusts the caller: the string is matched whole, lowercased,
   and expanded to six digits so everything downstream sees one shape. */
export function normaliseColour(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!HEX.test(trimmed)) return null;
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed;
    return `#${r as string}${r as string}${g as string}${g as string}${b as string}${b as string}`;
  }
  return trimmed;
}

function rgbOf(hex: string): { r: number; g: number; b: number } {
  const full = normaliseColour(hex) ?? DEFAULT_THEME.accent;
  return {
    r: parseInt(full.slice(1, 3), 16),
    g: parseInt(full.slice(3, 5), 16),
    b: parseInt(full.slice(5, 7), 16),
  };
}

/* WCAG relative luminance, then the ratio between two of them. Plain arithmetic rather than a
   dependency: this is eleven lines and it decides whether a human can read an approval. */
function luminance(hex: string): number {
  const { r, g, b } = rgbOf(hex);
  const channel = (raw: number): number => {
    const v = raw / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* The surface a word sits on most: ui/theme.js lifts --bg-2 eight percent from the ground toward
   a light of the ground's own hue (the ground scaled to full brightness, halfway to white) on a
   dark ground, and toward black on a light one. The same arithmetic, so a slot is held to the
   surface a word in it can actually sit on, not only to the ground. */
export function raisedSurface(background: string): string {
  const ground = rgbOf(background);
  const channels = [ground.r, ground.g, ground.b];
  const top = Math.max(...channels) || 1;
  const lift = luminance(background) > 0.5
    ? [0, 0, 0]
    : channels.map((c) => Math.round(255 + (c * 255 / top - 255) * 0.5));
  const step = (from: number, to: number): number => Math.round(from + (to - from) * 0.08);
  return '#' + channels.map((c, i) => step(c, lift[i] as number).toString(16).padStart(2, '0')).join('');
}

type ThemeOutcome =
  | { ok: true; theme: Theme; notes: string[] }
  | { ok: false; error: string };

/* Take a patch of named slots and produce the theme that would result, or the reason it will
   not be written. Pure: it reads and writes nothing, so the same check runs in a test.

   Order inside one patch: the colourway first, then reset, then the slots. So
   { profile: 'green-on-black', accent: '#5b8def' } is the colourway with a blue action colour,
   and reset:true puts the slots back to the colourway's own. */
export function applyPatch(current: Theme, patch: Record<string, unknown>): ThemeOutcome {
  const next: Theme = { ...current };
  const notes: string[] = [];

  if (patch.profile !== undefined) {
    if (!isColourway(patch.profile)) {
      return {
        ok: false,
        error: `unknown colourway: ${JSON.stringify(patch.profile)}. the colourways are ${COLOURWAYS.join(', ')}`,
      };
    }
    if (patch.profile !== next.profile) notes.push(`colourway ${next.profile} to ${patch.profile}`);
    Object.assign(next, colourwayTheme(patch.profile));
  }

  if (patch.reset === true) {
    for (const slot of THEME_SLOTS) next[slot] = COLOURWAY_PALETTE[next.profile].slots[slot];
    notes.push(`every colour back to ${COLOURWAY_LABEL[next.profile].toLowerCase()}`);
  }

  const unknown = Object.keys(patch).filter(
    (key) => key !== 'reset' && key !== 'profile' && !THEME_SLOTS.includes(key as ThemeSlot),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown colour: ${unknown.join(', ')}. the slots are ${THEME_SLOTS.join(', ')}. the approval gate's red is not one of them and cannot be changed`,
    };
  }

  for (const slot of THEME_SLOTS) {
    if (patch[slot] === undefined) continue;
    const colour = normaliseColour(patch[slot]);
    if (colour === null) {
      return { ok: false, error: `${slot} must be a hex colour like #5b8def or #fff, got ${JSON.stringify(patch[slot])}` };
    }
    if (colour !== next[slot]) notes.push(`${slot} ${next[slot]} to ${colour}`);
    next[slot] = colour;
  }

  // Everything that carries meaning has to stay readable on every surface, including the one
  // colour this tool cannot name. The raised surface (--bg-2, the lightest the window paints)
  // is the one that decides: a colour that clears the floor on the ground alone was 4.2:1 on a
  // card once the ground was as light as the gate red allows.
  const surface = raisedSurface(next.background);
  const checks: { what: string; colour: string; floor: number }[] = [
    { what: 'accent', colour: next.accent, floor: MIN_TEXT_CONTRAST },
    { what: 'agent', colour: next.agent, floor: MIN_TEXT_CONTRAST },
    { what: "the approval gate's red", colour: COLOURWAY_PALETTE[next.profile].gate, floor: MIN_TEXT_CONTRAST },
    { what: 'up', colour: next.up, floor: MIN_MARK_CONTRAST },
    // Down is text as much as it is a candle: Turn off, Failed, the amount that left, No. A
    // down colour the window sets words in holds the text floor (the shipped #ff6b5b reads
    // at 5.54:1 on the raised ground); the candle shares it.
    { what: 'down', colour: next.down, floor: MIN_TEXT_CONTRAST },
  ];
  for (const check of checks) {
    const ratio = Math.min(contrastRatio(check.colour, next.background), contrastRatio(check.colour, surface));
    if (ratio < check.floor) {
      return {
        ok: false,
        error: `${check.what} ${check.colour} on ${next.background} is ${ratio.toFixed(2)}:1, under the ${check.floor}:1 it needs to stay readable. nothing was changed`,
      };
    }
  }

  if (notes.length === 0) notes.push('nothing changed');
  return { ok: true, theme: next, notes };
}

function filePathFor(dataDir: string): string {
  return path.join(dataDir, FILE);
}

/* Every failure path returns the default theme, the same direction src/view/mode.ts fails in:
   an unreadable file must never be the reason a human is shown something they cannot read. */
export function readTheme(dataDir: string): Theme {
  try {
    const raw = fs.readFileSync(filePathFor(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_THEME };
    // A file from before the colourways has no profile line and means green on black, which
    // is what every window painted then. An unknown name, and the two colourways that were
    // cut, are treated the same way.
    const profile = isColourway(parsed.profile) ? parsed.profile : DEFAULT_COLOURWAY;
    const out: Theme = colourwayTheme(profile);
    for (const slot of THEME_SLOTS) {
      const colour = normaliseColour(parsed[slot]);
      if (colour !== null && !(RETIRED[slot] ?? []).includes(colour)) out[slot] = colour;
    }
    // A file that was hand-edited past the floor is treated as absent rather than obeyed.
    const check = applyPatch(colourwayTheme(profile), out as unknown as Record<string, unknown>);
    return check.ok ? check.theme : { ...DEFAULT_THEME };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

export function writeTheme(dataDir: string, theme: Theme): void {
  atomicWriteJson(filePathFor(dataDir), theme);
}
