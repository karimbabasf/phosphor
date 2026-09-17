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
// And a third, since plans wait on lines: a line a plan HOLDS is not removed by anything in
// this file. The watcher reads a missing line as "does not hold", so a clear, a product sweep or
// the cap taking `tl_3` from under a waiting plan would leave a plan the human approved that can
// never fire, with nothing saying why. The caller names the held ids (src/http/view.ts reads
// them off the plans) and every remover here steps around them.
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
  // A price band, and optionally the span of time it covers. Without t1 and t2 it runs the
  // width of the chart, which is what a supply zone usually means.
  zone?: { low: number; high: number; t1?: number; t2?: number };
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
  // The ids a plan is waiting on. Replaces the previous set; none of them is removed by clear,
  // the sweep, the cap or remove until a later call drops them from the set.
  hold(ids: Iterable<string>): void;
  held(id: string): boolean;
  count(): number;
};

const PREFIX: Record<Drawing['kind'], string> = { trendline: 'tl', zone: 'zn' };
// Exported so the chart's housekeeping block can say how full this store is beside its own caps.
export const DRAWINGS_MAX = 200;

export type DrawingStoreOptions = {
  max?: number;
  now?: () => number;
  /* The two that keep ids unique across several charts. `counters` is shared by reference between
     the stores of one server, so a number is minted once app-wide; `prefix` marks every id a
     comparison chart mints (`c1_tl_4`) so it can never be mistaken for the primary's `tl_4`, which
     is the only shape a plan may name and the only store the watcher reads. Before this every
     chart started at tl_1, and a plan waiting on a comparison chart's line would have fired on the
     primary's line of the same name. */
  counters?: Record<string, number>;
  prefix?: string;
  /* Told after anything here changes, with who did it. This store has no revision of its own:
     the chart's is the one the window watches (src/chart.ts `touch`), and until the chart heard
     about a line landing here, the frame announcing it carried the OLD revision, the window read
     that as the echo of its own last write and dropped it, and the line waited for the next
     unrelated refetch. Removals report as the human's, the same way the chart store's own clear
     does. */
  onChange?: (source: Drawing['source'], by: string | null) => void;
};

export function createDrawingStore(opts?: DrawingStoreOptions): DrawingStore {
  const max = opts?.max ?? DRAWINGS_MAX;
  const now = opts?.now ?? (() => Date.now());
  const prefix = opts?.prefix ?? '';
  const onChange = opts?.onChange ?? (() => {});
  const items = new Map<string, Drawing>();
  const counters: Record<string, number> = opts?.counters ?? {};
  let heldIds = new Set<string>();

  function nextId(kind: Drawing['kind']): string {
    const p = PREFIX[kind];
    counters[p] = (counters[p] ?? 0) + 1;
    return `${prefix}${p}_${counters[p]}`;
  }

  function evictIfNeeded(): void {
    while (items.size > max) {
      const oldestAgent = [...items.values()]
        .filter((d) => d.source === 'agent' && !heldIds.has(d.id))
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
      onChange(full.source, full.by ?? null);
      return full;
    },
    get: (id) => items.get(id),
    list: () => [...items.values()],
    remove(id) {
      const removed = !heldIds.has(id) && items.delete(id);
      if (removed) onChange('human', null);
      return removed;
    },
    clear(source, by) {
      let n = 0;
      for (const [id, d] of [...items.entries()]) {
        if (heldIds.has(id)) continue;
        if (source !== undefined && d.source !== source) continue;
        if (by !== undefined && by !== null && d.by !== by) continue;
        items.delete(id);
        n += 1;
      }
      if (n > 0) onChange('human', null);
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
        if (heldIds.has(id)) continue;
        items.delete(id);
        n += 1;
      }
      if (n > 0) onChange('human', null);
      return n;
    },
    hold(ids) {
      heldIds = new Set(ids);
    },
    held: (id) => heldIds.has(id),
    count: () => items.size,
  };
}
