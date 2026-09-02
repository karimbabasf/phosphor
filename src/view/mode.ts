// Which screen the app window is showing, persisted across restarts.
//
// Written atomically (tmp file + rename) the same way store.ts writes proposals, so a
// crash mid-write cannot leave a half-file that reads as neither mode.
//
// Every failure path returns 'pro'. That direction is deliberate: pro shows strictly
// more than basic, so a missing, corrupt or unrecognised file must never be the reason
// a human sees less than they would have. Failing toward the simplified screen would
// be a silent downgrade of what someone is shown before they approve money movement.
// 'trade' does not change that: it shows a different subject rather than more or less of
// this one, so pro remains the only safe answer to "we could not tell".

import fs from 'node:fs';
import path from 'node:path';
import type { ViewMode } from '../types.ts';
import { atomicWriteJson } from '../fsatomic.ts';

const FILE = 'view.json';

function filePathFor(dataDir: string): string {
  return path.join(dataDir, FILE);
}

function isViewMode(value: unknown): value is ViewMode {
  return value === 'basic' || value === 'pro' || value === 'trade';
}

export function readViewMode(dataDir: string): ViewMode {
  try {
    const raw = fs.readFileSync(filePathFor(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const view = (parsed as { view?: unknown } | null)?.view;
    return isViewMode(view) ? view : 'pro';
  } catch {
    // absent, unreadable, or not JSON: all of them mean pro
    return 'pro';
  }
}

export function writeViewMode(dataDir: string, mode: ViewMode): void {
  atomicWriteJson(filePathFor(dataDir), { view: mode });
}
