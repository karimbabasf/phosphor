// Which screen the app window is showing, persisted across restarts, with who put it there and
// when (Screen in src/types.ts). The mode is the durable fact; `by` and `since` ride beside it so
// a restart reports the same screen record the last boot did rather than a fresh one.
//
// Written atomically (tmp file + rename) the same way store.ts writes proposals, so a
// crash mid-write cannot leave a half-file that reads as neither mode.
//
// TWO DIFFERENT ANSWERS, because "nobody has chosen yet" and "we cannot tell what was
// chosen" are not the same question.
//
// NO FILE AT ALL is a fresh install, and a fresh install opens on 'basic'. Nothing has
// been downgraded, because nothing was ever set: the first screen somebody sees is the
// simple one, and the pro and trade screens are one click away from it.
//
// A file that is there and unreadable, or holds a mode this version does not know, is the
// other question, and every one of those paths returns 'pro'. Pro shows strictly more than
// basic, so a corrupt file must never be the reason a human sees LESS than they had. Failing
// toward the simplified screen would be a silent downgrade of what someone is shown before
// they approve money movement. 'trade' does not change that: it shows a different subject
// rather than more or less of this one, so pro remains the only safe answer to "we could not
// tell what this used to say".

import fs from 'node:fs';
import path from 'node:path';
import type { Screen, ScreenBy, ViewMode } from '../types.ts';
import { atomicWriteJson } from '../fsatomic.ts';

const FILE = 'view.json';

function filePathFor(dataDir: string): string {
  return path.join(dataDir, FILE);
}

function isViewMode(value: unknown): value is ViewMode {
  return value === 'basic' || value === 'pro' || value === 'trade' || value === 'vault';
}

function isScreenBy(value: unknown): value is ScreenBy {
  return value === 'human' || value === 'agent';
}

/* The whole record. `by` and `since` fall back rather than fail: a file from before they were
   written holds a mode somebody chose, and the mode is the fact the fallbacks above are about.
   A missing or unreadable `by` reads as the human, because the default screen is theirs and
   an agent's switch is the one that is always recorded; a missing `since` is this read. */
export function readScreen(dataDir: string, now: () => string = () => new Date().toISOString()): Screen {
  let raw: string;
  try {
    raw = fs.readFileSync(filePathFor(dataDir), 'utf8');
  } catch {
    // Absent, or a data directory that does not exist yet. Nobody has chosen, so this is a
    // fresh install and it opens simple.
    return { view: 'basic', since: now(), by: 'human' };
  }
  try {
    const parsed = JSON.parse(raw) as { view?: unknown; since?: unknown; by?: unknown } | null;
    const view = parsed?.view;
    if (!isViewMode(view)) return { view: 'pro', since: now(), by: 'human' };
    const since = typeof parsed?.since === 'string' && Number.isFinite(Date.parse(parsed.since)) ? parsed.since : now();
    return { view, since, by: isScreenBy(parsed?.by) ? parsed.by : 'human' };
  } catch {
    // The file is there and cannot be read. Something was chosen and we cannot tell what, so
    // never show less than it might have been.
    return { view: 'pro', since: now(), by: 'human' };
  }
}

export function readViewMode(dataDir: string): ViewMode {
  return readScreen(dataDir).view;
}

export function writeScreen(dataDir: string, screen: Screen): void {
  atomicWriteJson(filePathFor(dataDir), screen);
}

export function writeViewMode(dataDir: string, mode: ViewMode): void {
  atomicWriteJson(filePathFor(dataDir), { view: mode });
}
