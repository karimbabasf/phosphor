// The op table: one name per measurement, one line of glue each.
//
// This file is a table and must stay one. The primitives beside it hold the logic, and a
// table that starts computing has drifted from the modules it fronts, which is how the
// number the agent reads stops matching the pixel the human sees.
//
// Every handler here returns a measurement. None returns a signal, a score, a rating or a
// suggested trade, and `tests/unit/analysis-ops.test.ts` asserts that by scanning the
// serialised output for those field names. The line between a measurement and a conclusion
// is the design, not a habit: the agent is the brains, and a layer that ships opinions
// replaces the judgment that is the reason to have an agent at all.

import type { Candle } from '../types.ts';
import type { Handler } from '../batch.ts';
import type { DrawingStore } from '../drawings.ts';
import { markIfCarried } from '../web-read.ts';
import { pivots } from './pivots.ts';
import { lineAt, touches, fitThroughPivots } from './trendline.ts';
import type { Line } from './trendline.ts';
import { clusterLevels } from './levels.ts';
import { atr, regime } from './regime.ts';
import { volumeProfile } from './volume-profile.ts';
import { anchoredVwap } from './vwap.ts';
import { detectRange } from './range.ts';
import { divergences } from './divergence.ts';
import { orderBlocks, fairValueGaps, liquiditySwings, structureBreaks } from './structure.ts';
import { indicatorSpec, normaliseParams, indicatorCatalog } from '../indicators.ts';
import type { IndicatorSpec } from '../indicators.ts';

export type AnalysisDeps = {
  // Mirrors the server's own loader, so the agent measures the same bars the human sees.
  candles(product: string, granularitySec: number, limit: number): Promise<Candle[]>;
  drawings: DrawingStore;
  // Who is drawing and what they are looking at, stamped onto anything this batch creates.
  // Optional, because a test and the browser both build these handlers with no agent behind
  // them; absent, a drawing is anonymous exactly as it was before the roster existed.
  author?: { by: string | null; product: string; granularitySec: number };
  // How an indicator type becomes a spec. Defaults to the built-in catalogue; the server hands
  // in a resolver that also knows the custom indicators, so `custom:<slug>` reads here too.
  indicator?: (type: string) => IndicatorSpec | undefined;
  // The custom indicator loader, when the app has one. indicator_list rescans its folder and
  // lists what it compiled beside the catalogue.
  customIndicators?: { refresh(): unknown; specs(): IndicatorSpec[] };
};

// How many values a series op answers with unless asked otherwise. An ATR over 400 bars was
// seven kilobytes of numbers where the model wanted one, and every turn after that paid for
// them again. Twenty shows the last few bars turning; `full: true` is the whole series.
const TAIL_DEFAULT = 20;

function tailed<T>(a: Record<string, unknown>, values: T[]): T[] {
  if (a.full === true) return values;
  const n = typeof a.tail === 'number' && Number.isFinite(a.tail) && a.tail > 0 ? Math.floor(a.tail) : TAIL_DEFAULT;
  return values.slice(-n);
}

// The newest defined value of a plot, and the one before it. A last value with nothing to
// compare it against cannot answer "is it turning", which is most of what an oscillator is for.
function lastDefined(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

function previousDefined(values: (number | null)[]): number | null {
  let seen = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (seen === 1) return v;
    seen += 1;
  }
  return null;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// A drawn object resolved back to a line, or a clear failure. Failing loudly here matters:
// a trigger silently pointed at nothing would never fire and would look like a quiet market.
function lineOf(drawings: DrawingStore, id: string): Line {
  const d = drawings.get(id);
  if (!d) throw new Error(`unknown drawing '${id}'`);
  if (!d.line) throw new Error(`drawing '${id}' is a ${d.kind}, which has no line to evaluate`);
  return d.line;
}

// The oscillator series behind a divergence question. Reusing the shared catalogue rather
// than recomputing means the agent's divergence and the human's pane come from one array.
function oscillatorSeries(
  resolve: (type: string) => IndicatorSpec | undefined,
  candles: Candle[],
  type: string,
  plotKey: string | undefined,
  params: Record<string, unknown>,
): (number | null)[] {
  const spec = resolve(type);
  if (!spec) throw new Error(`unknown indicator '${type}'`);
  const numeric: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) if (typeof v === 'number') numeric[k] = v;
  // normaliseParams clamps to the spec's ranges and reports what it changed. The notes are
  // dropped here on purpose: this path answers "give me the series", and a caller wanting
  // the clamping story asks indicator_list for the allowed ranges instead.
  const result = spec.compute(candles, normaliseParams(spec, numeric).params);
  const plot = plotKey ? result.plots.find((p) => p.key === plotKey) : result.plots[0];
  if (!plot) {
    const keys = result.plots.map((p) => p.key).join(', ');
    throw new Error(`indicator '${type}' has no plot '${plotKey}'. plots: ${keys}`);
  }
  return plot.values;
}

export function analysisHandlers(deps: AnalysisDeps): Record<string, Handler> {
  const resolve = deps.indicator ?? indicatorSpec;

  // An empty product is passed through deliberately rather than defaulted here: the caller
  // knows which chart the human is looking at, and an op that names no product should
  // measure that one instead of a constant this file invented.
  const load = (a: Record<string, unknown>) =>
    deps.candles(str(a.product, '').toUpperCase(), num(a.granularitySec, 3600), num(a.bars, 300));

  // Pivots are the input to several other ops, so the parameters are resolved in one place.
  const pivotsFor = async (a: Record<string, unknown>) =>
    pivots(await load(a), {
      window: num(a.window, 2),
      minProminence: num(a.minProminence, 0),
    });

  return {
    // ---------- seeing ----------
    candles: async (a) => tailed(a, await load(a)),

    // ---------- measuring ----------
    pivots: async (a) => tailed(a, await pivotsFor(a)),

    levels: async (a) => clusterLevels(await pivotsFor(a), num(a.tolerance, 0)),

    regime: async (a) =>
      regime(await load(a), { period: num(a.period, 14), lookback: num(a.lookback, 252) }),

    atr: async (a) => tailed(a, atr(await load(a), num(a.period, 14))),

    volume_profile: async (a) =>
      volumeProfile(await load(a), {
        bins: num(a.bins, 40),
        valueAreaPct: num(a.valueAreaPct, 0.7),
      }),

    vwap: async (a) => anchoredVwap(await load(a), num(a.anchorIndex, 0)),

    range: async (a) =>
      detectRange(await load(a), {
        lookback: num(a.lookback, 60),
        maxEfficiency: num(a.maxEfficiency, 0.3),
      }),

    divergence: async (a) => {
      const candles = await load(a);
      const series = oscillatorSeries(
        resolve,
        candles,
        str(a.indicator, 'rsi'),
        typeof a.plot === 'string' ? a.plot : undefined,
        (a.params as Record<string, unknown>) ?? {},
      );
      return divergences(
        pivots(candles, { window: num(a.window, 2), minProminence: num(a.minProminence, 0) }),
        series,
      );
    },

    indicator_series: async (a) =>
      tailed(
        a,
        oscillatorSeries(
          resolve,
          await load(a),
          str(a.indicator, 'rsi'),
          typeof a.plot === 'string' ? a.plot : undefined,
          (a.params as Record<string, unknown>) ?? {},
        ),
      ),

    // Read an indicator WITHOUT putting it on the human's chart. Three sub-panes is the cap and
    // it is there so the price stays readable, which used to mean an agent could not look at a
    // fourth oscillator at all: it had to add one, read it, and take it off again, and the human
    // watched their chart flicker. This computes the same arrays from the same catalogue and
    // returns the last value of every plot plus the state line, and draws nothing.
    indicator_read: async (a) => {
      const type = str(a.indicator, 'rsi');
      const spec = resolve(type);
      if (!spec) throw new Error(`unknown indicator '${type}'. indicator_list has the list.`);
      const numeric: Record<string, number> = {};
      for (const [k, v] of Object.entries((a.params as Record<string, unknown>) ?? {})) {
        if (typeof v === 'number') numeric[k] = v;
      }
      const { params, notes } = normaliseParams(spec, numeric);
      const result = spec.compute(await load(a), params);
      return {
        indicator: spec.type,
        label: spec.label(params),
        pane: spec.pane,
        params,
        notes,
        state: result.state,
        guides: result.guides,
        plots: result.plots.map((plot) => ({
          key: plot.key,
          label: plot.label,
          last: lastDefined(plot.values),
          previous: previousDefined(plot.values),
        })),
      };
    },

    // The whole catalogue, so a batch can ask what exists and then read one in the same call.
    // The custom indicators are listed beside it, after a rescan of their folder, so a file the
    // human just dropped in shows up on the next list without a restart.
    indicator_list: () => {
      const custom = deps.customIndicators;
      if (custom === undefined) return indicatorCatalog();
      custom.refresh();
      return [
        ...indicatorCatalog(),
        ...custom.specs().map((s) => ({
          type: s.type,
          pane: s.pane === 'price' ? 'overlays the price' : 'takes its own pane',
          summary: s.summary,
          params: s.params.map((p) => ({ name: p.name, default: p.def, min: p.min, max: p.max, integer: p.int })),
        })),
      ];
    },

    // ---------- structure ----------
    //
    // Boxes and events rather than series. See the header of ./structure.ts for what each one
    // is defined as. Every one of them returns extents and counts, never a place to trade.
    order_blocks: async (a) =>
      orderBlocks(await load(a), {
        window: num(a.window, 2),
        minProminence: num(a.minProminence, 0),
        limit: num(a.limit, 12),
      }),

    fair_value_gaps: async (a) =>
      fairValueGaps(await load(a), { limit: num(a.limit, 12) }),

    liquidity: async (a) =>
      liquiditySwings(await load(a), {
        window: num(a.window, 2),
        minProminence: num(a.minProminence, 0),
        tolerance: num(a.tolerance, 0),
        limit: num(a.limit, 12),
      }),

    structure: async (a) =>
      structureBreaks(await load(a), {
        window: num(a.window, 2),
        minProminence: num(a.minProminence, 0),
      }).slice(-num(a.limit, 12)),

    // ---------- geometry against drawn objects ----------
    trendline_fit: async (a) => {
      const found = await pivotsFor(a);
      return fitThroughPivots(found, str(a.kind, 'high') === 'low' ? 'low' : 'high');
    },

    trendline_at: (a) =>
      lineAt(lineOf(deps.drawings, str(a.id, '')), num(a.t, Math.floor(Date.now() / 1000))),

    trendline_touches: async (a) =>
      tailed(a, touches(lineOf(deps.drawings, str(a.id, '')), await load(a), num(a.tolerance, 0))),

    // ---------- drawing ----------
    draw: (a) => {
      const kind = str(a.kind, 'trendline') === 'zone' ? 'zone' : 'trendline';
      const label = str(a.label, kind);
      // Who drew it and on what. Without the product a zone survives a switch to another
      // instrument, where its two prices describe nothing; without the session no agent on a
      // team can tell its own zones from a colleague's.
      const stamp = {
        by: deps.author?.by ?? null,
        product: deps.author?.product,
        granularitySec: deps.author?.granularitySec,
      };
      if (kind === 'zone') {
        return deps.drawings.add({
          kind,
          label,
          source: 'agent',
          ...stamp,
          zone: { low: num(a.low, 0), high: num(a.high, 0) },
        });
      }
      const a1 = (a.a ?? {}) as Record<string, unknown>;
      const b1 = (a.b ?? {}) as Record<string, unknown>;
      return deps.drawings.add({
        kind,
        label,
        source: 'agent',
        ...stamp,
        line: {
          a: { t: num(a1.t, 0), price: num(a1.price, 0) },
          b: { t: num(b1.t, 0), price: num(b1.price, 0) },
        },
      });
    },

    // Every market's labels, so a label written after a web read marks the seat that lists it.
    drawings_list: () => {
      const list = deps.drawings.list();
      markIfCarried(deps.author?.by, list);
      return list;
    },

    drawings_remove: (a) => ({ removed: deps.drawings.remove(str(a.id, '')) }),

    /* Clearing defaults to the agent's OWN drawings, and on a team "own" got narrower.
       source:'mine' is this session's; 'agent' is every agent's; 'all' includes the human's.
       A bare call still means 'mine', because a tidy that reached a colleague's work by
       default would be the commonest way one agent silently undoes another. On the market on
       screen, the way chart_draw clears: another market keeps its own until somebody clears it
       there. */
    drawings_clear: (a) => {
      const scope = str(a.source, 'mine');
      const market = deps.author?.product;
      if (scope === 'all') return { cleared: deps.drawings.clear(undefined, undefined, market) };
      if (scope === 'agent') return { cleared: deps.drawings.clear('agent', undefined, market) };
      return { cleared: deps.drawings.clear('agent', deps.author?.by ?? null, market) };
    },
  };
}
