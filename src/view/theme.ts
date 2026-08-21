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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = 'theme.json';

export type ThemeSlot = 'accent' | 'background' | 'up' | 'down' | 'agent';

export type Theme = Record<ThemeSlot, string>;

export const THEME_SLOTS: readonly ThemeSlot[] = ['accent', 'background', 'up', 'down', 'agent'];

// What every slot means, handed to the agent in the tool description so it never has to guess
// which one moves which pixels.
export const SLOT_MEANING: Readonly<Record<ThemeSlot, string>> = {
  accent: 'the one hue the whole terminal is drawn in: text, frames, grids, axes and every ramp derived from them',
  background: 'the ground behind everything',
  up: 'candles that closed up',
  down: 'candles that closed down',
  agent: 'the levels, marks and trend lines the agent itself drew, so its own work can be told from the human’s',
};

export const DEFAULT_THEME: Theme = {
  accent: '#33ff66',
  background: '#0b0d0b',
  up: '#33ff66',
  down: '#cc3a30',
  agent: '#33ff66',
};

// The gate's red. Not a slot, checked like one: whatever the background becomes, the colour the
// app refuses and warns in has to stay readable on it.
const GATE_RED = '#ff3b30';

// Two floors, because two kinds of thing are being checked.
//
// TEXT is 4.5:1, WCAG's floor for normal text, and this whole window is 13px mono. The accent
// is every label, every axis number and every frame; the agent ink is the labels on what it
// drew; the gate red is the word REFUSED. All of them are read.
//
// A MARK is 3:1, WCAG's floor for a non-text graphical object. A candle body is a shape whose
// position carries the meaning, not a glyph. This is not a relaxation invented to fit: the
// shipped down-candle #cc3a30 measures 3.99:1 on #0b0d0b, so a single 4.5 floor would have
// refused Phosphor's own default theme, which is how this split was found.
const MIN_TEXT_CONTRAST = 4.5;
const MIN_MARK_CONTRAST = 3;

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

export function rgbOf(hex: string): { r: number; g: number; b: number } {
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

export type ThemeOutcome =
  | { ok: true; theme: Theme; notes: string[] }
  | { ok: false; error: string };

/* Take a patch of named slots and produce the theme that would result, or the reason it will
   not be written. Pure: it reads and writes nothing, so the same check runs in a test. */
export function applyPatch(current: Theme, patch: Record<string, unknown>): ThemeOutcome {
  const next: Theme = { ...current };
  const notes: string[] = [];

  if (patch.reset === true) {
    for (const slot of THEME_SLOTS) next[slot] = DEFAULT_THEME[slot];
    notes.push('every colour back to the default phosphor green');
  }

  const unknown = Object.keys(patch).filter(
    (key) => key !== 'reset' && !THEME_SLOTS.includes(key as ThemeSlot),
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
      return { ok: false, error: `${slot} must be a hex colour like #33ff66 or #3f6, got ${JSON.stringify(patch[slot])}` };
    }
    if (colour !== next[slot]) notes.push(`${slot} ${next[slot]} to ${colour}`);
    next[slot] = colour;
  }

  // Everything that carries meaning has to stay readable on the ground, including the one
  // colour this tool cannot name.
  const checks: { what: string; colour: string; floor: number }[] = [
    { what: 'accent', colour: next.accent, floor: MIN_TEXT_CONTRAST },
    { what: 'agent', colour: next.agent, floor: MIN_TEXT_CONTRAST },
    { what: "the approval gate's red", colour: GATE_RED, floor: MIN_TEXT_CONTRAST },
    { what: 'up', colour: next.up, floor: MIN_MARK_CONTRAST },
    { what: 'down', colour: next.down, floor: MIN_MARK_CONTRAST },
  ];
  for (const check of checks) {
    const ratio = contrastRatio(check.colour, next.background);
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
    const out: Theme = { ...DEFAULT_THEME };
    for (const slot of THEME_SLOTS) {
      const colour = normaliseColour(parsed[slot]);
      if (colour !== null) out[slot] = colour;
    }
    // A file that was hand-edited past the floor is treated as absent rather than obeyed.
    const check = applyPatch(DEFAULT_THEME, out as unknown as Record<string, unknown>);
    return check.ok ? check.theme : { ...DEFAULT_THEME };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

export function writeTheme(dataDir: string, theme: Theme): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmpPath = path.join(dataDir, `.${FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(theme, null, 2));
  fs.renameSync(tmpPath, filePathFor(dataDir));
}
