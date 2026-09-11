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
import { createDrawingStore } from './drawings.ts';
import type { DrawingStore } from './drawings.ts';

export type ChartStore = ReturnType<typeof createChartStore>;

export type ChartSlot = { store: ChartStore; drawings: DrawingStore; index: number };

export type ChartLayoutEntry = { product: string; timeframe: string };

export const SLOTS_MAX = 4;

export type ChartSlots = {
  primary: ChartSlot;
  slot(n: number): ChartSlot | null;
  layout(charts: ChartLayoutEntry[]): { ok: true } | { ok: false; reason: string };
  list(): { index: number; product: string; timeframe: string }[];
};

export function createChartSlots(defaultProduct: string, now: () => number = Date.now): ChartSlots {
  const primary: ChartSlot = {
    store: createChartStore(defaultProduct, now),
    drawings: createDrawingStore({ now }),
    index: 0,
  };
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
        held = { store: createChartStore(want.product, now), drawings: createDrawingStore({ now }), index: i };
        slots[i] = held;
      }
      const before = held.store.state().view.product;
      // The store's own setView does the product sweep on its levels and marks; the drawing
      // store is swept here for the same reason chart_draw sweeps it on the primary: a zone
      // carried onto another instrument is wrong, not stale.
      held.store.setView({ product: want.product, granularitySec: want.granularitySec }, 'agent');
      if (held.store.state().view.product !== before) held.drawings.sweepForeign(held.store.state().view.product);
    }
    slots.length = resolved.length;
    return { ok: true };
  }

  function list(): { index: number; product: string; timeframe: string }[] {
    return slots.map((s) => ({
      index: s.index,
      product: s.store.state().view.product,
      timeframe: timeframeLabel(s.store.state().view.granularitySec),
    }));
  }

  return { primary, slot, layout, list };
}
