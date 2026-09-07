// Append-only JSONL audit log. One JSON line per event, never rewritten.
//
// EVERY LINE NAMES THE ONE BEFORE IT. `prev` is the SHA-256 of the previous line exactly as it
// was written, so the file is a chain rather than a pile: editing a line, deleting one, or
// swapping two changes the hash the next line already committed to, and verify() says which
// index broke. The first line carries prev: null, which is the only line that legitimately has
// no ancestor.
//
// What this is and is not. It is tamper EVIDENCE, not tamper prevention: anything that can
// write the file can rewrite the whole chain from the edit onwards, because the hash needs no
// key. What it costs an attacker is the difference between changing one line with sed and
// rewriting every line after it, and what it buys the owner is that the cheap edit is
// detectable. A keyed chain would need a key this app has nowhere to keep that the same
// attacker could not read, so it would be a longer way of proving the same thing.
//
// tail() re-reads from disk on every call so a freshly created Audit against an existing dataDir
// sees prior events immediately (no in-memory cache to go stale across process restarts). It
// reads the END of the file rather than the whole of it: the window polls /api/log, and reading
// the entire append-only history on every poll is a cost that grows without bound over the life
// of a data directory. verify() is the one reader that still walks the whole file, because a
// chain cannot be checked from a window into the middle of it.
//
// Two events are mirrored to stderr as well as written here: `error` and `app_start`. Logging in
// this app is a JSONL file and nothing else, which is unusually disciplined and has one hole in
// it: a crash before the file opens is completely silent, and the Tauri shell inherits stdio, so
// its Console.app entry was empty in exactly the case somebody needed it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LogEvent } from './types.ts';
import { atomicWriteJson, syncFile } from './fsatomic.ts';

export type ChainBreak = {
  // Line number in the file, 1-based, so it reads the way an editor numbers it.
  line: number;
  reason: 'unparseable' | 'broken_link' | 'missing_link' | 'truncated';
  detail: string;
};

/* THE ANCHOR, and it is what makes truncation a break.
   The walk below compares each line's `prev` to the hash of the line above it and nothing held
   either END, so dropping a prefix or a suffix of the file left a chain that is perfectly
   self-consistent: an attacker with write access removed the newest and most incriminating lines
   and the record still passed its own check. The tip is a count and the hash of the line at that
   count, written durably beside the log, so a file shorter than the count or one whose line at
   that count hashes differently is a file that lost something.

   IT MAY LAG, and that is deliberate. A SIGKILL between the append and the tip write leaves
   exactly that, so lines AFTER the anchor are accepted and lines missing before it are not.
   Appending is what this file is for; removing is not.

   The lag used to be one line, because the tip was written durably on every append. Measured in
   situ, append() cost 8.15 ms and the tip was 8.02 ms of it: 99.7% of the price of writing an
   audit line was the anchor beside it. Every agent tool call appends at least one line, so twenty
   calls blocked the event loop for about 160 ms and the window stuttered whenever an agent was
   working. It is written on a timer now, TIP_FLUSH_MS apart, and flushed on the way out: the
   shutdown path, the crash handler and the kill switch all call flushTip(). The lag is therefore
   a second's worth of lines where the process was killed outright, and nothing anywhere else.
   That is the same property with a bigger constant, and the asymmetry it exists for is
   untouched. */
export const TIP_FILENAME = 'audit.tip.json';

/* One second. Long enough that a burst of tool calls costs one write instead of one per line,
   short enough that the window somebody would go looking in is never more than a second stale.
   The timer is unref'd: a pending anchor may never be a reason this process stays up. */
export const TIP_FLUSH_MS = 1_000;

export type ChainTip = { count: number; hash: string };

export function readTip(dataDir: string): ChainTip | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, TIP_FILENAME), 'utf8')) as Partial<ChainTip>;
    if (typeof parsed.count !== 'number' || !Number.isInteger(parsed.count) || parsed.count < 0) return null;
    if (typeof parsed.hash !== 'string' || parsed.hash.length === 0) return null;
    return { count: parsed.count, hash: parsed.hash };
  } catch {
    // Absent, unreadable or not a tip. A data directory written by an older version has none, and
    // that reads as "no anchor" rather than as damage: the walk is still the walk.
    return null;
  }
}

/* How much of the tail to read. 256 KB is about two thousand lines of this log, comfortably more
   than any caller asks for (the window's cap is a few hundred) and small enough that a 10 MB
   history costs the same as a fresh one. A limit larger than fits in the window simply returns
   what the window held: fewer lines than asked for, never a wrong answer. */
export const TAIL_BYTES = 256 * 1024;

export type Audit = {
  append(type: LogEvent['type'], msg: string, data?: unknown): LogEvent;
  tail(limit: number): LogEvent[];
  subscribe(fn: (e: LogEvent) => void): () => void;
  // Walks the whole file and reports the first line whose link does not hold. `ok` on an
  // absent or empty file: no lines is a chain nobody has broken.
  verify(): { ok: true; lines: number; anchored: boolean; interleaved: number } | { ok: false; lines: number; break: ChainBreak };
  // How many lines tail() has had to skip since boot. A torn line is normal after a power loss
  // mid-append and abnormal any other time, so the number is reported (health) rather than
  // logged: logging it would append a line per poll to the file that is torn.
  //
  // Distinct from verify() above, and the two answer different questions. verify() asks whether
  // the chain HOLDS, and a torn line breaks it; this asks whether rendering the log had to skip
  // anything. A file can have a torn last line, which is what a power loss during an append
  // leaves, and still be a chain nobody tampered with up to that point.
  tornLines(): number;
  // The most recent `error` event, in memory. What /api/health reports and what the window shows
  // when it needs to say something went wrong without making a person open a log file.
  lastError(): { at: string; msg: string } | null;
  /* Write the anchor now rather than on the next tick of the timer. Called on every way out this
     process gets to run code on: the shutdown path, the crash handler and the kill switch, all
     wired in src/main.ts. Never throws, and does nothing when nothing has been appended since
     the last write. */
  flushTip(): void;
  /* How many lines this process has appended. Same contract as the store's revision(): a caller
     holding a derivation of what the log carries (the state payload carries the agent roster, the
     recent-events list and the last activity time, all of which move on an audit line) compares
     this to decide whether the derivation is still current. A count rather than a subscription,
     for the same reason: nothing to leak and nothing to forget. */
  lineCount(): number;
};

export function hashLine(line: string): string {
  return crypto.createHash('sha256').update(line, 'utf8').digest('hex');
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
}

/* How many complete lines the file holds, and one named line out of it, in a single pass.
   The anchor needs a count and one line, and readLines pulls the whole history into one string and
   splits it into one string per line to get them: 154 ms and a 54 MB allocation on a 200k-line log.
   This walks the bytes in 64 KB chunks, counting newlines and keeping only the line it was asked
   for, so it costs a read and one small string. `wantIndex` is 0-based; pass -1 to count only. A
   torn last line with no newline after it is neither counted nor returned, which is the
   conservative answer: an anchor that claims fewer lines than are there still verifies. */
function scanLines(filePath: string, wantIndex: number): { count: number; line: string | null } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0;
    let capturing = wantIndex === 0;
    let parts: Buffer[] = [];
    let line: string | null = null;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      let start = 0;
      for (let i = 0; i < read; i += 1) {
        if (buffer[i] !== 0x0a) continue;
        if (capturing) {
          parts.push(Buffer.from(buffer.subarray(start, i)));
          line = Buffer.concat(parts).toString('utf8');
          parts = [];
          capturing = false;
        }
        count += 1;
        start = i + 1;
        if (count === wantIndex) capturing = true;
      }
      if (capturing) parts.push(Buffer.from(buffer.subarray(start, read)));
    }
    return { count, line };
  } catch {
    // No file is no lines, which is what a fresh data directory looks like.
    return { count: 0, line: null };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/* Where the anchored line actually sits. The HASH is the anchor; the count says where to look
   first. Builds before 2026-09-07 wrote the tip on every line from an in-process counter, and a
   second process appending to the same log (a peer session, a driver child) left that counter
   behind the file: a real install here carried count 4336 with the hash of line 4747. Reading
   that as truncation cried wolf on an intact log. So a count that does not hash to the anchor
   is looked past, from the end of the file backwards, and only a hash that appears nowhere is
   damage. Nothing weakens: a rewrite below the anchored line changes every prev after it and
   so the anchored line's own text; a truncation below it removes it; a deletion above it breaks
   the walk at the gap. */
export function anchorLine(lines: string[], tip: ChainTip): number {
  if (tip.count > 0 && tip.count <= lines.length && hashLine(lines[tip.count - 1]) === tip.hash) return tip.count;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (hashLine(lines[i]) === tip.hash) return i + 1;
  }
  return -1;
}

export function verifyChain(
  lines: string[],
  tip: ChainTip | null = null,
): { ok: true; lines: number; anchored: boolean; interleaved: number } | { ok: false; lines: number; break: ChainBreak } {
  /* The anchor first, because it is the cheap check and because a truncated file's REMAINING
     lines chain perfectly: walking them would answer ok before anything noticed the file is
     shorter than the record of it. */
  if (tip !== null && tip.count > 0) {
    if (lines.length < tip.count) {
      return {
        ok: false,
        lines: lines.length,
        break: {
          line: lines.length,
          reason: 'truncated',
          detail: `the log holds ${lines.length} lines and this app recorded ${tip.count} lines. Something removed ${tip.count - lines.length} of them.`,
        },
      };
    }
    const anchored = hashLine(lines[tip.count - 1]);
    if (anchored !== tip.hash && anchorLine(lines, tip) === -1) {
      return {
        ok: false,
        lines: lines.length,
        break: {
          line: tip.count,
          reason: 'truncated',
          detail: `line ${tip.count} hashes to ${anchored.slice(0, 12)} and this app recorded ${tip.hash.slice(0, 12)} there, and no line in the file hashes to it. The lines that were written are not the ones in the file.`,
        },
      };
    }
  }

  let expected: string | null = null;
  // Set by the first line that carries a prev field at all. Before it, lines without one are the
  // pre-chain prefix an upgraded install has; after it, a line without one is either a stripped
  // link or an older build that ran against this log after the upgrade.
  let chainStarted = false;
  /* Islands: runs of pre-chain lines in the middle of a chained log. A real install carried one,
     written by a build from before the chain that was started against the same data directory
     later. It is not the attack, because the attack (edit line k, strip prev from k onward) has
     no chained line after it that links back correctly, and a run that is stripped only up to
     line m changes line m's hash, so the first chained line after it breaks. An island is
     accepted only when the chain resumes after it with a link that holds, which is what a newer
     build does on its own: it seeds prev from the last line in the file. */
  let interleaved = 0;
  let islandOpen = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let parsed: { prev?: unknown };
    try {
      parsed = JSON.parse(line) as { prev?: unknown };
    } catch {
      return { ok: false, lines: lines.length, break: { line: i + 1, reason: 'unparseable', detail: 'the line is not JSON' } };
    }
    const claimed = parsed.prev === null || typeof parsed.prev === 'string' ? parsed.prev : undefined;
    if (claimed === undefined) {
      /* A line with no prev field is a pre-chain line, and pre-chain lines can only be a prefix:
         the chain started once and never stopped. Accepting one anywhere later let a single
         regex defeat the whole record: edit line k, strip prev from k onward, re-anchor the tip,
         and the walk restarted at every stripped line and answered ok. */
      if (!chainStarted) {
        expected = hashLine(line);
        continue;
      }
      if (!islandOpen) {
        // The island is only acceptable if a chained line follows it somewhere.
        let resumes = false;
        for (let j = i + 1; j < lines.length; j += 1) {
          if (/"prev":/.test(lines[j])) {
            resumes = true;
            break;
          }
        }
        if (!resumes) {
          return {
            ok: false,
            lines: lines.length,
            break: {
              line: i + 1,
              reason: 'missing_link',
              detail: 'this line carries no prev field, the chain had already started above it, and nothing after it is chained',
            },
          };
        }
        islandOpen = true;
        interleaved += 1;
      }
      expected = hashLine(line);
      continue;
    }
    chainStarted = true;
    islandOpen = false;
    if (expected !== null && claimed !== expected) {
      return {
        ok: false,
        lines: lines.length,
        break: {
          line: i + 1,
          reason: claimed === null ? 'missing_link' : 'broken_link',
          detail: `this line names ${claimed === null ? 'no previous line' : `prev ${claimed.slice(0, 12)}`}, but the line above hashes to ${expected.slice(0, 12)}`,
        },
      };
    }
    expected = hashLine(line);
  }
  return { ok: true, lines: lines.length, anchored: tip !== null && tip.count > 0, interleaved };
}

export function createAudit(dataDir: string): Audit {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'audit.jsonl');
  const subscribers = new Set<(e: LogEvent) => void>();
  let torn = 0;
  let appended = 0;
  let latestError: { at: string; msg: string } | null = null;

  /* The hash of the last line written, held in memory so an append is one write rather than a
     re-read of the file. Seeded from disk once, because a restart has to link onto whatever the
     previous process left, and a chain that restarted from null on every boot would report
     every boot as a break. */
  /* How many lines this app believes are in the file, which is the count half of the anchor.
     Null until the first flush counts them, and that is the fix as much as it is the deferral.

     It used to be seeded from the tip on disk, and a tip is allowed to lag: a data directory left
     by a process that died in the gap has an anchor one line short, and seeding from it made this
     process believe the file was one line shorter than it is. The next anchor then named a count
     that pointed at the wrong line, and the boot after THAT reported a break in a chain nobody
     had touched. Debouncing would have widened that from one line to a second's worth of them.
     Counting the file at the first flush costs one read, off the boot path and off the request
     path, and it is right rather than inherited. */
  let written: number | null = null;
  let tipDirty = false;
  let tipTimer: ReturnType<typeof setTimeout> | null = null;

  /* THE ANCHOR THIS PROCESS INHERITED, and the rule that it may not be moved over a file that has
     lost lines.

     The chain walk used to run before this process wrote anything at all, so a boot on a truncated
     log read the old anchor, found the file short of it, and said so. It runs after the port opens
     now, which means this process has appended its own app_start lines and flushed its own anchor
     first, and an anchor recounted from a truncated file is a true statement about a forgery: the
     count matches, the walk passes, and the only record that lines were removed has been written
     over by the app itself.

     So the first flush of a process checks the anchor it inherited before it moves it, and leaves
     it exactly where it is when the file no longer matches. Appending onto a broken log is fine
     and is what an append-only log does; overwriting the evidence is not. */
  /* A log this app wrote before 2026-09-07 landed 0644. Holdings, addresses and the whole
     decision history are in it, so it is pulled back to the owner alone on the next boot. */
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch {
    // A file system that refuses the mode change is not one this app can do anything about here.
  }
  const bootTip = readTip(dataDir);
  let anchorHeld = false;
  /* Whether this process inherited an anchor at all, decided once at boot. verify() runs after the
     port opens, by which time this process has appended its own lines and flushed a fresh anchor
     at the new end of the file, so a log truncated and stripped of its anchor before boot would
     verify clean against the anchor this process just wrote. What the boot inherited is the fact
     that matters, and it does not change for the life of the process. A file with no lines at
     boot is a fresh install and has nothing to launder. */
  const inheritedAnchor = (bootTip !== null && bootTip.count > 0) || readLines(filePath).length === 0;

  let previous: string | null = (() => {
    /* Seeded from the tail window rather than from the whole file. The seed needs exactly one
       line, the last, and the window is the END of the file, so the last line is always inside
       it: reading a 10 MB history to hash its final line would be the same unbounded cost the
       positioned tail exists to remove. A torn last line is hashed as it stands, which is what
       the previous whole-file read did too, and verify() is what reports it. */
    const { text } = readTail();
    const lines = text.split('\n').filter((line) => line.length > 0);
    return lines.length === 0 ? null : hashLine(lines[lines.length - 1]);
  })();

  function flushTip(): void {
    if (tipTimer !== null) {
      clearTimeout(tipTimer);
      tipTimer = null;
    }
    if (!tipDirty || previous === null) return;
    // Cleared before the write, not after: a write that throws must not leave the timer armed to
    // try the same failing write once a second for the life of the process.
    tipDirty = false;
    try {
      if (anchorHeld) return;
      if (written === null) {
        const scan = scanLines(filePath, bootTip === null ? -1 : bootTip.count - 1);
        if (
          bootTip !== null &&
          bootTip.count > 0 &&
          (scan.count < bootTip.count || scan.line === null || hashLine(scan.line) !== bootTip.hash) &&
          anchorLine(readLines(filePath), bootTip) === -1
        ) {
          // The log no longer matches what this app recorded about it. verify() is what reports
          // that; this refuses to write over the anchor that proves it, for the life of the
          // process.
          anchorHeld = true;
          return;
        }
        written = scan.count;
      }
      /* The lines go to disk before the anchor that names them. appendFileSync does not fsync,
         the anchor's writer does, and a power cut between the two left the anchor ahead of the
         log: a false tamper alarm that reads exactly like a real one. */
      syncFile(filePath);
      atomicWriteJson(path.join(dataDir, TIP_FILENAME), { count: written, hash: previous } satisfies ChainTip, undefined);
    } catch {
      // The log lines are already on disk and they are the record. A tip that could not be
      // written makes the next verify() read an older anchor, which is a weaker check and not a
      // wrong one; throwing here would turn a full disk into a backend that cannot log.
    }
  }

  function markTip(): void {
    tipDirty = true;
    if (tipTimer !== null) return;
    tipTimer = setTimeout(flushTip, TIP_FLUSH_MS);
    // Never a reason on its own for this process to stay up, and the ways out all flush.
    tipTimer.unref?.();
  }

  function append(type: LogEvent['type'], msg: string, data?: unknown): LogEvent {
    const event: LogEvent = {
      ts: new Date().toISOString(),
      type,
      msg,
      ...(data !== undefined ? { data } : {}),
      prev: previous,
    };
    const line = JSON.stringify(event);
    fs.appendFileSync(filePath, line + '\n', { mode: 0o600 });
    previous = hashLine(line);
    appended += 1;
    if (written !== null) written += 1;
    /* The anchor is marked, not written. See TIP_FLUSH_MS: writing it here cost 8.02 ms of an
       8.15 ms append, and every agent tool call comes through this line. */
    markTip();
    if (type === 'error') latestError = { at: event.ts, msg };
    // Mirrored, not moved: the file is still the record. This is the copy a human reading
    // Console.app or a terminal can see without opening anything.
    if (type === 'error' || type === 'app_start') {
      process.stderr.write(`phosphor ${type}: ${msg}\n`);
    }
    for (const fn of subscribers) fn(event);
    return event;
  }

  /* The last TAIL_BYTES of the file, as text, plus whether the read started mid-line.
     A positioned read rather than readFileSync, because /api/log is polled and the file only
     grows. The first line of a windowed read is almost always a fragment, so it is dropped: a
     partial JSON line would parse as torn and inflate the torn count on every single call. */
  function readTail(): { text: string; partialFirstLine: boolean } {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const size = fs.fstatSync(fd).size;
      const from = Math.max(0, size - TAIL_BYTES);
      const length = size - from;
      if (length === 0) return { text: '', partialFirstLine: false };
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, from);
      return { text: buffer.toString('utf8'), partialFirstLine: from > 0 };
    } catch {
      return { text: '', partialFirstLine: false };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // nothing to do
        }
      }
    }
  }

  // Newest first, and a line that will not parse is skipped rather than thrown.
  //
  // A half-written last line is what a power loss during appendFileSync leaves behind, and
  // JSON.parse on it used to throw out of every caller. createServer reads the tail at
  // construction, main.ts constructs the server at module scope, so one torn byte made the app
  // permanently unbootable and recovery meant a human editing audit.jsonl by hand.
  //
  // The walk is backwards and counts what it keeps, so `limit` lines are still returned when
  // some of the candidates are torn. Reading forwards and slicing would return fewer.
  function tail(limit: number): LogEvent[] {
    if (!fs.existsSync(filePath)) return [];
    const { text, partialFirstLine } = readTail();
    const lines = text.split('\n').filter((line) => line.length > 0);
    // The window cut this one in half, which is not the same as the file being damaged.
    if (partialFirstLine) lines.shift();
    const selected: LogEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && selected.length < limit; i -= 1) {
      try {
        selected.push(JSON.parse(lines[i]) as LogEvent);
      } catch {
        torn += 1;
      }
    }
    return selected;
  }

  function subscribe(fn: (e: LogEvent) => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return {
    append,
    tail,
    subscribe,
    // The one reader that must see every line: a chain cannot be verified through a window, and
    // the anchor beside it is what turns truncation from invisible into named.
    verify: () => {
      const result = verifyChain(readLines(filePath), readTip(dataDir));
      return result.ok ? { ...result, anchored: result.anchored && inheritedAnchor } : result;
    },
    tornLines: () => torn,
    lastError: () => latestError,
    flushTip,
    lineCount: () => appended,
  };
}
