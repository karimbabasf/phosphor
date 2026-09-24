// Chart slots: up to four charts side by side, each its own store.
//
// Slot 0 is the primary: the full engine, the one the human interacts with, and the one every
// tool means when it names no chart. It is the same store the rest of the server has always
// reached as ctx.chart and ctx.drawings, so nothing that predates slots had to learn about
// them. Slots 1 to 3 are comparison charts: a lightweight read-only renderer in the window,
// fed by /api/chart?slot=n, drawn on by the same tools with `chart: n`.
//
// This is the seam and not the whole feature. The primary engine is not made multi-instance
// here; a later spec may promote a comparison chart to a full one. Keeping every slot a plain
// ChartStore plus a DrawingStore is what keeps that promotion a UI change rather than a
// server one.

import { createChartStore, parseTimeframe, timeframeLabel, MIN_TIMEFRAME_SEC } from './chart.ts';
import type { ChartSnapshot } from './chart.ts';
import { createDrawingStore, SEED_MAX } from './drawings.ts';
import type { Drawing, DrawingStore } from './drawings.ts';
import type { IndicatorSpec } from './indicators.ts';

export type ChartStore = ReturnType<typeof createChartStore>;

export type ChartSlot = { store: ChartStore; drawings: DrawingStore; index: number };

export type ChartLayoutEntry = { product: string; timeframe: string };

export const SLOTS_MAX = 4;

// Every chart as src/markings.ts keeps it, and the id counters the drawing stores share.
export type SlotsSnapshot = {
  counters: Record<string, number>;
  charts: (ChartSnapshot & { index: number; drawings: Drawing[] })[];
};

export type ChartSlots = {
  primary: ChartSlot;
  slot(n: number): ChartSlot | null;
  layout(charts: ChartLayoutEntry[]): { ok: true } | { ok: false; reason: string };
  list(): { index: number; product: string; timeframe: string }[];
  snapshot(): SlotsSnapshot;
  // For a fresh set of slots at boot. Comparison charts come back in order and stop at the first
  // gap, because the layout is always slots 0 to n.
  restore(saved: SlotsSnapshot, report?: (line: string) => void): void;
  /* For the boot too, file or no file: the counters go past every line id named here (every plan
     and trade card's, linesNamed in src/http/chart.ts). The file that keeps them is missing on the
     first boot of the version that keeps it and empty after one set aside, and a line drawn next
     took the id of the one a waiting plan was approved against (audit finding 13). */
  seed(ids: Iterable<string>): void;
  // Told after any chart or drawing changes, and after the layout does.
  onChange(fn: () => void): () => void;
};

export function createChartSlots(
  defaultProduct: string,
  now: () => number = Date.now,
  resolve?: (type: string) => IndicatorSpec | null | undefined,
): ChartSlots {
  // One set of counters for every chart, so `tl_4` is minted once and exists in one place, and a
  // prefix on every comparison chart's ids so none of them is a shape a plan can name. The plan
  // schema accepts `tl_N` only and the watcher reads the primary only (src/main.ts), so a
  // comparison chart minting its own `tl_1` was a line that resolved to a different one.
  const counters: Record<string, number> = {};
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // See the chart store's own listeners: a keeper's failure is never the write's.
      }
    }
  };
  // A line landing in the drawing store moves the chart's revision, so the frame that announces
  // it carries a number the window has not seen. See onChange in src/drawings.ts.
  const slotFor = (index: number, product: string): ChartSlot => {
    const store = createChartStore(product, now, resolve);
    const drawings = createDrawingStore({
      now,
      counters,
      prefix: index === 0 ? '' : `c${index}_`,
      onChange: (source, by) => store.touch(source, by),
    });
    store.onChange(notify);
    return { store, drawings, index };
  };
  const primary: ChartSlot = slotFor(0, defaultProduct);
  const slots: ChartSlot[] = [primary];

  function slot(n: number): ChartSlot | null {
    if (!Number.isInteger(n) || n < 0 || n >= SLOTS_MAX) return null;
    return slots[n] ?? null;
  }

  function layout(charts: ChartLayoutEntry[]): { ok: true } | { ok: false; reason: string } {
    if (!Array.isArray(charts) || charts.length < 1 || charts.length > SLOTS_MAX) {
      return { ok: false, reason: `a layout is 1 to ${SLOTS_MAX} charts, got ${Array.isArray(charts) ? charts.length : 0}` };
    }
    // Every entry is checked before anything moves, so a refusal leaves the primary where the
    // human had it rather than half way into a layout that was never going to apply.
    const resolved: { product: string; granularitySec: number }[] = [];
    for (const entry of charts) {
      const product = String(entry?.product ?? '').trim().toUpperCase();
      if (product === '') return { ok: false, reason: 'every chart needs a product' };
      const sec = parseTimeframe(String(entry?.timeframe ?? ''));
      if (sec === null || sec < MIN_TIMEFRAME_SEC) {
        return { ok: false, reason: `${String(entry?.timeframe ?? '')} is not a timeframe. use a count and a unit, like 15m, 4h or 1d` };
      }
      resolved.push({ product, granularitySec: sec });
    }

    for (let i = 0; i < resolved.length; i++) {
      const want = resolved[i] as { product: string; granularitySec: number };
      let held = slots[i];
      if (held === undefined) {
        held = slotFor(i, want.product);
        slots[i] = held;
      }
      // The store's own setView parks the levels and marks of the market being left, and the
      // drawing store shows each market its own lines and zones, so nothing is swept here.
      held.store.setView({ product: want.product, granularitySec: want.granularitySec }, 'agent');
    }
    const shrank = slots.length > resolved.length;
    slots.length = resolved.length;
    if (shrank) notify();
    return { ok: true };
  }

  function list(): { index: number; product: string; timeframe: string }[] {
    return slots.map((s) => ({
      index: s.index,
      product: s.store.state().view.product,
      timeframe: timeframeLabel(s.store.state().view.granularitySec),
    }));
  }

  function snapshot(): SlotsSnapshot {
    return {
      counters: { ...counters },
      charts: slots.map((s) => ({ ...s.store.snapshot(), index: s.index, drawings: s.drawings.list().map((d) => ({ ...d })) })),
    };
  }

  function restore(saved: SlotsSnapshot, report: (line: string) => void = () => {}): void {
    for (const [k, v] of Object.entries(saved.counters)) {
      if ((k === 'tl' || k === 'zn') && Number.isInteger(v) && v > (counters[k] ?? 0)) counters[k] = v;
    }
    const byIndex = new Map(saved.charts.map((c) => [c.index, c]));
    for (let i = 0; i < SLOTS_MAX; i++) {
      const chart = byIndex.get(i);
      if (chart === undefined) break;
      const held = i === 0 ? primary : slotFor(i, chart.view?.product ?? primary.store.state().view.product);
      if (i > 0) slots[i] = held;
      try {
        held.store.restore(chart, report);
        held.drawings.restore(chart.drawings);
      } catch (err) {
        report(`chart ${i} could not be put back: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // The primary's shape only, the one a plan may name, and no further than SEED_MAX.
  function seed(ids: Iterable<string>): void {
    for (const id of ids) {
      const m = /^(tl|zn)_(\d{1,9})$/.exec(String(id));
      if (m === null) continue;
      const k = m[1] as string;
      const n = Number(m[2]);
      if (n <= SEED_MAX && n > (counters[k] ?? 0)) counters[k] = n;
    }
  }

  return {
    primary,
    slot,
    layout,
    list,
    snapshot,
    restore,
    seed,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
