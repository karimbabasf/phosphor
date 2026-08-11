// Append-only JSONL audit log. One JSON line per event, never rewritten.
// tail() re-reads from disk on every call so a freshly created Audit against
// an existing dataDir sees prior events immediately (no in-memory cache to
// go stale across process restarts).

import fs from 'node:fs';
import path from 'node:path';
import type { LogEvent } from './types.ts';

export type Audit = {
  append(type: LogEvent['type'], msg: string, data?: unknown): LogEvent;
  tail(limit: number): LogEvent[];
  subscribe(fn: (e: LogEvent) => void): () => void;
};

export function createAudit(dataDir: string): Audit {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'audit.jsonl');
  const subscribers = new Set<(e: LogEvent) => void>();

  function append(type: LogEvent['type'], msg: string, data?: unknown): LogEvent {
    const event: LogEvent = {
      ts: new Date().toISOString(),
      type,
      msg,
      ...(data !== undefined ? { data } : {}),
    };
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
    for (const fn of subscribers) fn(event);
    return event;
  }

  function tail(limit: number): LogEvent[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    const selected = lines.slice(-limit).map((line) => JSON.parse(line) as LogEvent);
    selected.reverse();
    return selected;
  }

  function subscribe(fn: (e: LogEvent) => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { append, tail, subscribe };
}
