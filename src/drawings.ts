// The objects that make the chart a shared coordinate system: the agent draws one, the
// human sees it, and a strategy program refers to it by id.
//
// Two rules that exist because a live strategy will hold these ids:
//
//   1. An id is never reused, even after the drawing is removed. Reusing `tl_3` would
//      silently repoint a trigger at a different line, which is the worst possible kind of
//      bug on a money surface: nothing errors, the bot just starts watching the wrong price.
//      The counters are kept with the drawings across a restart (src/markings.ts) for the same
//      reason: a plan in plans.json can outlive the process that minted its line. A boot can find
//      no file, so they are also raised past every line id a plan or a card names (seed in
//      src/charts.ts), and an id a waiting plan holds is never minted at all (nextId below).
//   2. Eviction under the cap takes the oldest AGENT drawing. A human drawing is never
//      evicted to make room for an agent one, because the human did not consent to their
//      own work being dropped by something the agent did.
//
// And a third, since plans wait on lines: a line a plan HOLDS is not removed by anything in
// this file. The watcher reads a missing line as "does not hold", so a clear or the cap taking
// `tl_3` from under a waiting plan would leave a plan the human approved that can never fire,
// with nothing saying why. The caller names the held ids (src/http/view.ts reads them off the
// plans) and every remover here steps around them.
//
// A drawing belongs to the market it was drawn on. The store keeps every market's, and the chart
// draws and reads only the ones on the market on screen (on); a market switch hides a zone
// rather than deleting it, and it is back when the chart returns. Only a clear removes one.
//
// Levels and marks are deliberately absent: src/chart.ts already owns those, and this file
// exists alongside it rather than replacing it.

import type { Line } from './analysis/trendline.ts';
import { markingLabel } from './chart-label.ts';
import { webReadStamp } from './web-read.ts';

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
  // The agent that wrote the label had read a web page in that chat (src/web-read.ts).
  webRead?: true;
};

export type DrawingStore = {
  // Refuses, by throwing a sentence, a shape the chart cannot draw: a line through one instant,
  // a zone of no height, a number that is not finite. The web-read stamp is the store's to take.
  add(d: Omit<Drawing, 'id' | 'createdAt' | 'webRead'>): Drawing;
  get(id: string): Drawing | undefined;
  // Every market's.
  list(): Drawing[];
  // The ones on one market, which is what a chart shows and what a read of it lists.
  on(product: string): Drawing[];
  remove(id: string): boolean;
  // `source` alone clears every agent's work. Naming a session as well narrows it to that one
  // agent's, which is the only clear a member of a team may safely make on its own. `product`
  // narrows it to one market; absent, it reaches every market the store keeps.
  clear(source?: 'human' | 'agent', by?: string | null, product?: string): number;
  // The ids a plan is waiting on. Replaces the previous set; none of them is removed by clear,
  // the cap or remove, or minted for a new line, until a later call drops them from the set.
  hold(ids: Iterable<string>): void;
  held(id: string): boolean;
  count(): number;
  // Drawings kept across a restart, put back with their ids. Anything that is not a shape add()
  // would take, or whose id is taken or is not one this store mints, is left out.
  restore(list: readonly Drawing[]): number;
};

const PREFIX: Record<Drawing['kind'], string> = { trendline: 'tl', zone: 'zn' };
// Exported so the chart's housekeeping block can say how full this store is beside its own caps.
export const DRAWINGS_MAX = 200;
export const DRAWINGS_PER_MARKET = 60;
// The largest number an id carries: nine digits, the longest the markings file keeps.
export const ID_MAX = 999_999_999;
/* The most a plan's line id raises the counters at boot. An agent can write an idea naming any
   tl_N without a click, and a counter pushed near ID_MAX would leave every later line with an id
   too long to keep. From here there are still nine hundred million to mint. */
export const SEED_MAX = 100_000_000;

// Whether a drawing belongs on the chart of this market. One with no product predates the field;
// it was made on whatever was on screen, so it is read as being on the market on screen.
export function drawnOn(d: Drawing, product: string): boolean {
  return d.product === undefined || d.product === product;
}

export type DrawingStoreOptions = {
  max?: number;
  perMarket?: number;
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

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/* The shape a drawing must have, whichever door it came through. Returns the drawing as it is
   stored, or the sentence that says why it cannot be. */
function shaped(d: Omit<Drawing, 'id' | 'createdAt'>): Omit<Drawing, 'id' | 'createdAt'> | string {
  const source = d.source === 'agent' ? 'agent' : 'human';
  const by = source === 'agent' && typeof d.by === 'string' && d.by.length > 0 ? d.by.slice(0, 64) : null;
  const base = {
    source,
    by,
    ...(typeof d.product === 'string' && d.product.length > 0 ? { product: d.product } : {}),
    ...(finite(d.granularitySec) ? { granularitySec: d.granularitySec } : {}),
  } as const;
  if (d.kind === 'zone') {
    const z = d.zone;
    if (z === undefined || !finite(z.low) || !finite(z.high)) return 'a zone needs two prices as finite numbers';
    if (z.low === z.high) return 'a zone needs two different prices; for one price use levels';
    const hasTime = z.t1 !== undefined || z.t2 !== undefined;
    if (hasTime && !(finite(z.t1) && finite(z.t2))) return 'a zone takes both t1 and t2, or neither';
    return {
      kind: 'zone',
      label: markingLabel(d.label, source, 'zone'),
      ...base,
      zone: {
        low: Math.min(z.low, z.high),
        high: Math.max(z.low, z.high),
        ...(hasTime ? { t1: Math.min(z.t1 as number, z.t2 as number), t2: Math.max(z.t1 as number, z.t2 as number) } : {}),
      },
    };
  }
  if (d.kind !== 'trendline') return `unknown drawing kind: ${String(d.kind)}`;
  const l = d.line;
  if (l === undefined || !finite(l.a?.t) || !finite(l.a?.price) || !finite(l.b?.t) || !finite(l.b?.price)) {
    return 'a line needs two anchors, each a finite time and price';
  }
  // Two anchors at the same instant describe a vertical line, which is a mark, and the slope
  // through them divides by zero.
  if (l.a.t === l.b.t) return 'a line needs two different times; for a vertical line at one moment use marks';
  const flip = l.b.t < l.a.t;
  return {
    kind: 'trendline',
    label: markingLabel(d.label, source, 'line'),
    ...base,
    line: flip ? { a: { t: l.b.t, price: l.b.price }, b: { t: l.a.t, price: l.a.price } } : { a: { t: l.a.t, price: l.a.price }, b: { t: l.b.t, price: l.b.price } },
  };
}

export function createDrawingStore(opts?: DrawingStoreOptions): DrawingStore {
  const max = opts?.max ?? DRAWINGS_MAX;
  const perMarket = opts?.perMarket ?? DRAWINGS_PER_MARKET;
  const now = opts?.now ?? (() => Date.now());
  const prefix = opts?.prefix ?? '';
  const onChange = opts?.onChange ?? (() => {});
  const items = new Map<string, Drawing>();
  const counters: Record<string, number> = opts?.counters ?? {};
  let heldIds = new Set<string>();
  const idShape = new RegExp(`^${prefix.replace(/[^a-z0-9_]/gi, '')}(tl|zn)_(\\d{1,9})$`);

  // Past any id a waiting plan holds, too. A plan can name a line that is not drawn (its own went
  // with a markings file that was set aside, or the plan named one ahead of the counter), and the
  // watcher would fire it on whichever line took that id next.
  function nextId(kind: Drawing['kind']): string {
    const p = PREFIX[kind];
    let id: string;
    do {
      counters[p] = (counters[p] ?? 0) + 1;
      id = `${prefix}${p}_${counters[p]}`;
    } while (heldIds.has(id));
    return id;
  }

  // The oldest agent drawing among these that no plan holds, or undefined when there is none.
  function oldestAgent(among: Drawing[]): Drawing | undefined {
    return among.filter((d) => d.source === 'agent' && !heldIds.has(d.id)).sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  function evictIfNeeded(product: string | undefined): void {
    if (product !== undefined) {
      for (;;) {
        const here = [...items.values()].filter((d) => d.product === product);
        if (here.length <= perMarket) break;
        const out = oldestAgent(here);
        // With nothing of the agent's left to drop, the cap yields rather than take the
        // human's work. A cap is a guard against agent runaway, not a reason to lose a drawing
        // the human made on purpose.
        if (out === undefined) break;
        items.delete(out.id);
      }
    }
    while (items.size > max) {
      const out = oldestAgent([...items.values()]);
      if (out === undefined) return;
      items.delete(out.id);
    }
  }

  return {
    add(d) {
      const shape = shaped(d);
      if (typeof shape === 'string') throw new Error(shape);
      const full: Drawing = { ...shape, ...webReadStamp(shape.source, d.by), id: nextId(shape.kind), createdAt: now() };
      items.set(full.id, full);
      evictIfNeeded(full.product);
      onChange(full.source, full.by ?? null);
      return full;
    },
    get: (id) => items.get(id),
    list: () => [...items.values()],
    on: (product) => [...items.values()].filter((d) => drawnOn(d, product)),
    remove(id) {
      const removed = !heldIds.has(id) && items.delete(id);
      if (removed) onChange('human', null);
      return removed;
    },
    clear(source, by, product) {
      let n = 0;
      for (const [id, d] of [...items.entries()]) {
        if (heldIds.has(id)) continue;
        if (source !== undefined && d.source !== source) continue;
        if (by !== undefined && by !== null && d.by !== by) continue;
        if (product !== undefined && !drawnOn(d, product)) continue;
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
    restore(list) {
      let n = 0;
      for (const d of list) {
        const m = idShape.exec(String(d.id));
        if (m === null || items.has(d.id)) continue;
        const shape = shaped(d);
        if (typeof shape === 'string') continue;
        // The id's kind is the drawing's kind, or a trigger naming it would read the wrong shape.
        if (PREFIX[shape.kind] !== m[1]) continue;
        items.set(d.id, { ...shape, ...(d.webRead === true ? { webRead: true } : {}), id: d.id, createdAt: finite(d.createdAt) ? d.createdAt : now() });
        const k = m[1] as string;
        counters[k] = Math.max(counters[k] ?? 0, Number(m[2]));
        n += 1;
      }
      // The caps hold after a restore as they do after an add, market by market.
      for (const product of new Set([...items.values()].map((d) => d.product))) evictIfNeeded(product);
      return n;
    },
  };
}
