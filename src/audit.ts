// Append-only JSONL audit log. One JSON line per event, never rewritten.
// tail() re-reads from disk on every call so a freshly created Audit against
// an existing dataDir sees prior events immediately (no in-memory cache to
// go stale across process restarts).
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

export type Audit = {
  append(type: LogEvent['type'], msg: string, data?: unknown): LogEvent;
  tail(limit: number): LogEvent[];
  subscribe(fn: (e: LogEvent) => void): () => void;
  // Walks the whole file and reports the first line whose link does not hold. `ok` on an
  // absent or empty file: no lines is a chain nobody has broken.
  verify(): { ok: true; lines: number } | { ok: false; lines: number; break: ChainBreak };
  // How many lines tail() has had to skip since boot. A torn line is normal after a power
  // loss mid-append and abnormal any other time, so the number is reported (health) rather
  // than logged: logging it would append a line per poll to the file that is torn.
  //
  // Distinct from verify() above, and the two answer different questions. verify() asks whether
  // the chain HOLDS, and a torn line breaks it; this asks whether rendering the log had to skip
  // anything. A file can have a torn last line, which is what a power loss during an append
  // leaves, and still be a chain nobody tampered with up to that point.
  tornLines(): number;
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

  /* The hash of the last line written, held in memory so an append is one write rather than a
     re-read of the file. Seeded from disk once, because a restart has to link onto whatever the
     previous process left, and a chain that restarted from null on every boot would report
     every boot as a break. */
  let previous: string | null = (() => {
    const lines = readLines(filePath);
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
    for (const fn of subscribers) fn(event);
    return event;
  }

  // Newest first, and a line that will not parse is skipped rather than thrown.
  //
  // A half-written last line is what a power loss during appendFileSync leaves behind, and
  // JSON.parse on it used to throw out of every caller. createServer reads the tail at
  // construction, main.ts constructs the server at module scope, so one torn byte made the
  // app permanently unbootable and recovery meant a human editing audit.jsonl by hand.
  //
  // The walk is backwards and counts what it keeps, so `limit` lines are still returned when
  // some of the candidates are torn. Reading forwards and slicing would return fewer.
  function tail(limit: number): LogEvent[] {
    const lines = readLines(filePath);
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

  return { append, tail, subscribe, verify: () => verifyChain(readLines(filePath)), tornLines: () => torn };
}
