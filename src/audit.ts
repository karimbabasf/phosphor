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

export type ChainBreak = {
  // Line number in the file, 1-based, so it reads the way an editor numbers it.
  line: number;
  reason: 'unparseable' | 'broken_link' | 'missing_link';
  detail: string;
};

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
  verify(): { ok: true; lines: number } | { ok: false; lines: number; break: ChainBreak };
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
};

export function hashLine(line: string): string {
  return crypto.createHash('sha256').update(line, 'utf8').digest('hex');
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
}

export function verifyChain(lines: string[]): { ok: true; lines: number } | { ok: false; lines: number; break: ChainBreak } {
  let expected: string | null = null;
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
      // A line written before the chain existed. It is not a break in itself, and the file it
      // sits in has no link to check, so the walk restarts from it rather than reporting every
      // pre-chain line as damage.
      expected = hashLine(line);
      continue;
    }
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
  return { ok: true, lines: lines.length };
}

export function createAudit(dataDir: string): Audit {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'audit.jsonl');
  const subscribers = new Set<(e: LogEvent) => void>();
  let torn = 0;
  let latestError: { at: string; msg: string } | null = null;

  /* The hash of the last line written, held in memory so an append is one write rather than a
     re-read of the file. Seeded from disk once, because a restart has to link onto whatever the
     previous process left, and a chain that restarted from null on every boot would report
     every boot as a break. */
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

  function append(type: LogEvent['type'], msg: string, data?: unknown): LogEvent {
    const event: LogEvent = {
      ts: new Date().toISOString(),
      type,
      msg,
      ...(data !== undefined ? { data } : {}),
      prev: previous,
    };
    const line = JSON.stringify(event);
    fs.appendFileSync(filePath, line + '\n');
    previous = hashLine(line);
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
    // The one reader that must see every line: a chain cannot be verified through a window.
    verify: () => verifyChain(readLines(filePath)),
    tornLines: () => torn,
    lastError: () => latestError,
  };
}
