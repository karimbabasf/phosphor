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

export function createStore(dataDir: string): Store {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'proposals.json');
  const subscribers = new Set<() => void>();

  function readAll(): Proposal[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.trim().length === 0) return [];
    return JSON.parse(raw) as Proposal[];
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
