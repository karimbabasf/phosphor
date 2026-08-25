// The objects that make the chart a shared coordinate system: the agent draws one, the
// human sees it, and a strategy program refers to it by id.
//
// Two rules that exist because a live strategy will hold these ids:
//
//   1. An id is never reused, even after the drawing is removed. Reusing `tl_3` would
//      silently repoint a trigger at a different line, which is the worst possible kind of
//      bug on a money surface: nothing errors, the bot just starts watching the wrong price.
//   2. Eviction under the cap takes the oldest AGENT drawing. A human drawing is never
//      evicted to make room for an agent one, because the human did not consent to their
//      own work being dropped by something the agent did.
//
// Levels and marks are deliberately absent: src/chart.ts already owns those, and this file
// exists alongside it rather than replacing it.

import type { Line } from './analysis/trendline.ts';

export type Drawing = {
  id: string;
  kind: 'trendline' | 'zone';
  label: string;
  source: 'human' | 'agent';
  // Which agent drew it, once there could be more than one. Null for a human, and null for an
  // agent that never named itself. `clear('agent', session)` reads it, which is what lets one
  // member of a team tidy up without deleting another's work.
  by?: string | null;
  // The instrument and timeframe it was anchored to. A zone between 63,000 and 64,000 is not a
  // zone on Solana, and before this the store had no way to know which chart it belonged to.
  product?: string;
  granularitySec?: number;
  createdAt: number;
  line?: Line;
  zone?: { low: number; high: number };
};

export type DrawingStore = {
  add(d: Omit<Drawing, 'id' | 'createdAt'>): Drawing;
  get(id: string): Drawing | undefined;
  list(): Drawing[];
  remove(id: string): boolean;
  // `source` alone clears every agent's work. Naming a session as well narrows it to that one
  // agent's, which is the only clear a member of a team may safely make on its own.
  clear(source?: 'human' | 'agent', by?: string | null): number;
  // Drop every AGENT drawing anchored to something other than this product. Called by the
  // chart when the instrument changes: a zone carried onto another market is not stale, it is
  // wrong. The human's drawings are never swept, on the same rule the eviction above holds.
  sweepForeign(product: string): number;
  count(): number;
};

const PREFIX: Record<Drawing['kind'], string> = { trendline: 'tl', zone: 'zn' };
const DEFAULT_MAX = 200;

export function createDrawingStore(opts?: { max?: number; now?: () => number }): DrawingStore {
  const max = opts?.max ?? DEFAULT_MAX;
  const now = opts?.now ?? (() => Date.now());
  const items = new Map<string, Drawing>();
  const counters: Record<string, number> = {};

  function nextId(kind: Drawing['kind']): string {
    const p = PREFIX[kind];
    counters[p] = (counters[p] ?? 0) + 1;
    return `${p}_${counters[p]}`;
  }

  function evictIfNeeded(): void {
    while (items.size > max) {
      const oldestAgent = [...items.values()]
        .filter((d) => d.source === 'agent')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      // With nothing of the agent's left to drop, the cap yields rather than take the
      // human's work. A cap is a guard against agent runaway, not a reason to lose a drawing
      // the human made on purpose.
      if (!oldestAgent) return;
      items.delete(oldestAgent.id);
    }
  }

  return {
    add(d) {
      const full: Drawing = { ...d, id: nextId(d.kind), createdAt: now() };
      items.set(full.id, full);
      evictIfNeeded();
      return full;
    },
    get: (id) => items.get(id),
    list: () => [...items.values()],
    remove: (id) => items.delete(id),
    clear(source, by) {
      let n = 0;
      for (const [id, d] of [...items.entries()]) {
        if (source !== undefined && d.source !== source) continue;
        if (by !== undefined && by !== null && d.by !== by) continue;
        items.delete(id);
        n += 1;
      }
      return n;
    },
    sweepForeign(product) {
      let n = 0;
      for (const [id, d] of [...items.entries()]) {
        // An agent drawing with no product recorded predates this field. It is swept too: it
        // was anchored to whatever was on screen when it was made, and that is the instrument
        // being left.
        if (d.source !== 'agent') continue;
        if (d.product === product) continue;
        items.delete(id);
        n += 1;
      }
      return n;
    },
    count: () => items.size,
  };
}
