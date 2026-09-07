// Proposal persistence. Whole list lives in proposals.json, rewritten durably on every put
// through src/fsatomic.ts. list()/get() re-read from disk so a freshly created Store against an
// existing dataDir sees prior proposals immediately (no in-memory cache to go stale across
// restarts).
//
// EVERY CALLER HAS TO KNOW ONE THING: these throw. A proposals.json that exists and cannot be
// read as a list of proposals is corruption, never an empty history, so readAll quarantines the
// bytes and raises CorruptStateError. Once that has happened this store refuses every read and
// every write for the life of the process: reading as empty would restore a spent 24 hour cap and
// the next put would write a one-row list over the history. main.ts is what turns the first of
// those throws into a refusal to boot with a sentence.

import fs from 'node:fs';
import path from 'node:path';
import type { Proposal } from './types.ts';
import { atomicWriteJson } from './fsatomic.ts';

export type Store = {
  list(): Proposal[];
  get(id: string): Proposal | undefined;
  put(p: Proposal): void;
  subscribe(fn: () => void): () => void;
  /* How many writes this process has made, and nothing else. A caller holding a derivation of
     the proposal list (the state payload does) compares this to decide whether the derivation is
     still current, which is a number rather than a subscription and so cannot leak a listener or
     be forgotten by a caller that closes. It never goes backwards and it means nothing across
     processes: a restart begins at zero, which is correct, because a restart has no derivation
     to keep. */
  revision(): number;
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
  let revision = 0;

  /* ONCE THIS PROCESS HAS SEEN THE FILE CORRUPT, IT NEVER READS AGAIN.
     Quarantine renames the bad bytes aside and throws once, and every later read then found no
     file and returned []. main.ts refuses to boot on that; nothing refused mid-run. So a file
     damaged while the app was up cost one 500 and after that the spend history was empty:
     sessionSpentUsd and the daily limit both read zero, the 24 hour cap was fully restored, and
     the next put wrote a fresh one-row list over what used to be the history.
     The latch belongs to this store instance, which is this process. The NEXT boot builds a new
     one, finds no file, and comes up clean with the evidence kept beside it, which is what
     renaming rather than deleting was for. */
  let corrupt: CorruptStateError | null = null;

  // Move the unreadable file aside and name what was wrong with it.
  function quarantine(why: string): CorruptStateError {
    const savedAs = path.join(dataDir, `proposals.json.corrupt.${Date.now()}`);
    try {
      fs.renameSync(filePath, savedAs);
    } catch {
      // Nothing more to do: the read already failed and now the rename has too. The error
      // still names the intended path so the operator knows what to look for.
    }
    corrupt = new CorruptStateError(savedAs, why);
    return corrupt;
  }

  /* THE PARSE IS CACHED, THE LOOK IS NOT, and the distinction is the whole design.

     list() and get() each did a readFileSync plus a JSON.parse of the whole list, and buildState
     reaches list() twice: once for the payload and once through dailyLimit. Measured: 0.021 ms at
     10 proposals, 0.549 at 500, 2.46 at 2000, 10.6 at 10000. Two calls per build is 4.9 ms at 2000
     rows and 21.3 ms at 10000, half of it re-parsing bytes read a microsecond earlier.

     The header above promises that a freshly created Store against an existing dataDir sees prior
     proposals immediately, with no in-memory cache to go stale. That promise is kept: every read
     still stats the file and re-parses the moment its identity moves. A stat is a couple of
     microseconds against a parse that is milliseconds, and a stale proposal list is the one thing
     this file may never hand back.

     The key is device, inode, size and both timestamps in nanoseconds. The inode is what makes it
     exact for this app's own writes: fsatomic renames a fresh file into place, so every put lands
     a new inode. The rest covers an edit made in place by something that is not this app. */
  let held: { rows: Proposal[]; key: string } | null = null;

  function fileKey(): string | null {
    try {
      const st = fs.statSync(filePath, { bigint: true });
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    } catch {
      // No file. A fresh data directory looks exactly like this and it is not damage.
      return null;
    }
  }

  /* An empty-but-existing file is corruption, never "no proposals yet".
     Before this, `if (raw.trim().length === 0) return []` erased history in silence: with no
     flush behind the rename, a crash can land the new directory entry without the body, and the
     result is a zero-byte proposals.json indistinguishable from a fresh install. src/fsatomic.ts
     closes the writing half; this closes the reading half. A parse failure had the opposite
     fault, throwing out of every caller including the one at boot. */
  function readAll(): Proposal[] {
    if (corrupt !== null) throw corrupt;
    const key = fileKey();
    if (key === null) {
      held = null;
      return [];
    }
    if (held !== null && held.key === key) return held.rows;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.trim().length === 0) throw quarantine('the file is empty');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw quarantine(err instanceof Error ? err.message : String(err));
    }
    if (!Array.isArray(parsed)) throw quarantine(`the file holds ${parsed === null ? 'null' : typeof parsed}, not a list`);
    const rows = parsed as Proposal[];
    // Keyed on what the file looked like BEFORE the read, so a write that landed during it is
    // seen by the next call rather than hidden behind a key that already names the new bytes.
    held = { rows, key };
    return rows;
  }

  /* What a caller is handed. The array is its own, because put() below pushes into one and
     reconcileOnBoot filters one, and a caller that splices what it was given must not be splicing
     the store. The ROWS are shared, and that is safe because nothing in this app mutates a
     proposal: every writer builds a new object with a spread and puts it back (see persist in
     src/proposals/lifecycle.ts). Copying the pointers is microseconds; copying the objects would
     put back most of the parse this cache exists to remove. */
  function handOut(rows: Proposal[]): Proposal[] {
    return rows.slice();
  }

  function writeAll(list: Proposal[]): void {
    atomicWriteJson(filePath, list);
  }

  function list(): Proposal[] {
    return handOut(readAll());
  }

  function get(id: string): Proposal | undefined {
    return readAll().find((p) => p.id === id);
  }

  function put(p: Proposal): void {
    // A copy, because the array readAll hands back is the cached one and a write that throws must
    // not leave this process holding a row that never reached the disk.
    const all = handOut(readAll());
    const idx = all.findIndex((x) => x.id === p.id);
    if (idx === -1) all.push(p);
    else all[idx] = p;
    writeAll(all);
    revision += 1;
    for (const fn of subscribers) fn();
  }

  function subscribe(fn: () => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { list, get, put, subscribe, revision: () => revision };
}
