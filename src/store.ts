// Proposal persistence. Whole list lives in proposals.json, rewritten
// atomically (tmp file + rename) on every put. list()/get() re-read from
// disk so a freshly created Store against an existing dataDir sees prior
// proposals immediately (no in-memory cache to go stale across restarts).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Proposal } from './types.ts';

export type Store = {
  list(): Proposal[];
  get(id: string): Proposal | undefined;
  put(p: Proposal): void;
  subscribe(fn: () => void): () => void;
};

// Thrown when proposals.json exists and cannot be read as a list of proposals. It carries the
// path the bad bytes were moved to, because the only useful next step is to go and look at them.
export class CorruptStateError extends Error {
  readonly savedAs: string;
  constructor(savedAs: string, why: string) {
    super(
      `proposals.json could not be read (${why}). ` +
        `The unreadable file has been kept as ${path.basename(savedAs)} and Phosphor will not start on it. ` +
        `Every proposal, pending and executed, is in that file: read it before starting again, because the next start begins with an empty history.`,
    );
    this.name = 'CorruptStateError';
    this.savedAs = savedAs;
  }
}

export function createStore(dataDir: string): Store {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'proposals.json');
  const subscribers = new Set<() => void>();

  // Move the unreadable file aside and name what was wrong with it. Renaming rather than
  // deleting keeps the evidence, and it means the SECOND boot comes up on an empty store
  // instead of looping forever on the same bytes.
  function quarantine(why: string): CorruptStateError {
    const savedAs = path.join(dataDir, `proposals.json.corrupt.${Date.now()}`);
    try {
      fs.renameSync(filePath, savedAs);
    } catch {
      // Nothing more to do: the read already failed and now the rename has too. The error
      // still names the intended path so the operator knows what to look for.
    }
    return new CorruptStateError(savedAs, why);
  }

  /* An empty-but-existing file is corruption, never "no proposals yet".
     Before this, `if (raw.trim().length === 0) return []` erased history in silence: with no
     fsync behind the rename, a crash can land the new directory entry without the body, and
     the result is a zero-byte proposals.json indistinguishable from a fresh install. A parse
     failure had the opposite fault, throwing out of every caller including the one at boot. */
  function readAll(): Proposal[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.trim().length === 0) throw quarantine('the file is empty');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw quarantine(err instanceof Error ? err.message : String(err));
    }
    if (!Array.isArray(parsed)) throw quarantine(`the file holds ${parsed === null ? 'null' : typeof parsed}, not a list`);
    return parsed as Proposal[];
  }

  function writeAll(list: Proposal[]): void {
    const tmpPath = path.join(dataDir, `.proposals.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  function list(): Proposal[] {
    return readAll();
  }

  function get(id: string): Proposal | undefined {
    return readAll().find((p) => p.id === id);
  }

  function put(p: Proposal): void {
    const all = readAll();
    const idx = all.findIndex((x) => x.id === p.id);
    if (idx === -1) all.push(p);
    else all[idx] = p;
    writeAll(all);
    for (const fn of subscribers) fn();
  }

  function subscribe(fn: () => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { list, get, put, subscribe };
}
