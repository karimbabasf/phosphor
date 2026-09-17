// The chart's view state and its read model.
//
// This state is on the SERVER, not in the browser, and that is the load-bearing decision of
// the whole feature. An agent has to be able to read what the chart shows and drive it while
// the window may not even be open, so a browser-owned view could not answer a read. The
// browser is a renderer: it draws this state and writes its own pan and zoom back.
//
// Nothing here touches money. Chart writes never reach the proposal path and never need an
// approval, but they are audit-logged like every other op, because an agent that can change
// what the human sees while that human is approving a transfer is a security surface. That
// is also why everything an agent draws carries an [agent] tag it cannot remove.

import type { Candle } from './types.ts';
import type { Provider } from './market/catalog.ts';
import type { Drawing } from './drawings.ts';
import { DRAWINGS_MAX } from './drawings.ts';
import { lineAt } from './analysis/trendline.ts';
import { indicatorSpec, normaliseParams, warmupBars, pctChange } from './indicators.ts';
import { atr as wilderAtr } from './analysis/regime.ts';
import type { IndicatorResult, IndicatorSpec } from './indicators.ts';
import { MAX_TIMEFRAME_SEC, MIN_TIMEFRAME_SEC, parseTimeframe, formatTimeframe } from './market/aggregate.ts';

export type PriceScale = { mode: 'auto' } | { mode: 'manual'; low: number; high: number };

// 'auto' is not a provider, it is the absence of a choice, which is why it lives here rather
// than widening Provider in the market layer. Nothing downstream ever fetches from 'auto'.
export type ProviderChoice = Provider | 'auto';
export const PROVIDER_CHOICES: readonly ProviderChoice[] = ['auto', 'hyperliquid', 'coinbase'];

export type ChartView = {
  product: string;
  // Which venue the candles are pulled from. 'auto' is the catalogue's own answer, which
  // prefers Hyperliquid when it lists the coin because that is where this app executes.
  // Naming a venue overrides that, and it can fail: not every coin is listed on both, so a
  // forced venue that does not list the product is refused rather than quietly falling back.
  // A silent fallback would put the other market's prices under the venue name the human
  // just chose, which is the one thing a provider control must never do.
  provider: ProviderChoice;
  granularitySec: number;
  // Bars across the plot. Fractional so a squeeze tracks the pointer instead of notching.
  barCount: number;
  // Bars back from the newest. Negative pushes the newest bar left of the axis, which is
  // what a trading chart does when you drag past the end.
  panOffset: number;
  priceScale: PriceScale;
};

export type Source = 'human' | 'agent';

// Provenance, carried by every object on the chart.
//
// It exists for two jobs that turned out to be the same job. Phosphor now seats a TEAM rather
// than one agent (src/agents.ts), so "who drew this" stopped being answerable by the source tag
// alone: three agents all write [agent]. And an agent that cannot tell its own work from another
// agent's cannot tidy up after itself without wiping a colleague's, which is why `by` is what
// `chart_clear what:'mine'` reads.
//
// `product` and `granularitySec` are the other half. A level at 63,000 drawn on BTC means
// nothing on SOL, and before this the app had no way to know that, so it kept drawing it. See
// the auto-tidy in setView.
export type Provenance = {
  source: Source;
  // The session id of the agent that made it, or null for a human and for an agent that
  // arrived before the roster existed.
  by: string | null;
  createdAt: number;
  product: string;
  granularitySec: number;
};

export type ChartIndicator = Provenance & {
  id: string;
  type: string;
  params: Record<string, number>;
  label: string;
  pane: 'price' | 'own';
};

export type ChartLevel = Provenance & { id: string; price: number; label: string };
export type ChartMark = Provenance & { id: string; t: number; label: string };

// Sloped objects (trend lines and zones) are deliberately NOT here. They live in
// src/drawings.ts, the one store the browser renders. This file used to keep a second list of
// trend lines with its own id scheme, and nothing ever drew it: the agent read back a line the
// human could not see. One store, one id an armed plan can point at.

// What the browser reports back about its own size, so the agent can tell whether what it
// asked for is actually readable rather than assuming it is.
export type ChartGeometry = {
  width: number;
  height: number;
  plotWidth: number;
  priceHeight: number;
  pxPerBar: number;
  panes: { id: string; label: string; height: number }[];
  dropped: string[];
  reportedAt: string;
};

export type ChartState = {
  view: ChartView;
  indicators: ChartIndicator[];
  levels: ChartLevel[];
  marks: ChartMark[];
  geometry: ChartGeometry | null;
  rev: number;
  lastDriver: Source;
  // Which agent last moved this chart. With a team on it, "an agent changed the view" is no
  // longer an answer: the human watching a product switch they did not ask for wants to know
  // which of the three did it, and so does every other agent.
  lastDriverBy: string | null;
  lastChangeAt: string;
};

/* A discriminated union, not `{ ok: boolean; error?: string }`.
   The old shape let a refusal be built with no sentence in it, and eight sites in src/http then
   passed that undefined straight to `fail()`, where JSON.stringify dropped the key: the refusal
   went out as `{ notes: [...] }` or `{}` and the window had nothing to show. The compiler now
   refuses to build a failure without a reason, which is the only version of this rule that
   cannot rot. */
export type Outcome =
  | { ok: true; notes: string[]; error?: undefined; id?: string; label?: string }
  | { ok: false; notes: string[]; error: string; id?: string; label?: string };

// What is on the chart that probably should not be, counted so the agent does not have to work
// it out from a list. It rides on every chart_read, which is what makes cleaning up automatic
// rather than something a human has to ask for: the numbers are in front of the model on the
// call it makes anyway, beside the sentence that says which tool clears them.
export type Housekeeping = {
  // Objects this agent drew, and objects some OTHER agent drew. Two counts, because the tidy
  // an agent may safely do is only ever the first one.
  mine: number;
  others: number;
  human: number;
  // Agent objects older than STALE_MS.
  stale: number;
  // Agent objects anchored to a product or timeframe the chart is no longer showing. Should be
  // zero in ordinary use: setView tidies the price-anchored ones on a product switch.
  foreign: number;
  // How full the four caps are, so an agent knows it is about to be refused before it is.
  capacity: { overlays: string; panes: string; levels: string; marks: string; drawings: string };
  hint: string;
};

// The timeframe vocabulary lives in the market layer, because that is what has to serve it.
export { MAX_TIMEFRAME_SEC, MIN_TIMEFRAME_SEC, parseTimeframe, formatTimeframe };

export const TIMEFRAMES: readonly { label: string; sec: number }[] = [
  { label: '1m', sec: 60 },
  { label: '5m', sec: 300 },
  { label: '15m', sec: 900 },
  { label: '30m', sec: 1800 },
  { label: '1h', sec: 3600 },
  { label: '4h', sec: 14400 },
  { label: '8h', sec: 28800 },
  { label: '1d', sec: 86400 },
];

// The window squeezes and pans as far as the cache can hold, not to a round number. What the
// window can actually be filled with is a separate question, and the venues answer it: the
// chart draws the history it was given, backfills behind the left edge as the pan reaches it,
// and says where the venue's history begins rather than pretending.
export const LIMITS = {
  barCountMin: 10,
  // Twenty thousand bars across the plot. Past two a pixel the renderer folds bars per pixel
  // column (candleColumns in ui/chart/chart.js), so a squeeze this deep is a column per pixel
  // on any screen there is rather than a smear of wicks.
  barCountMax: 20000,
  barCountDefault: 120,
  // Bars back from the newest the view may sit at. It is the cache's depth (src/market/store.ts
  // maxBars): the window clamps earlier than this, at the venue's own first bar, once the
  // series has said it has nothing older.
  panMax: 50000,
  historyMax: 50000,
  // Bars served beyond the left edge of the window, so a small pan does not run off the data
  // before the backfill behind it lands.
  fetchMargin: 30,
  maxOverlays: 8,
  maxPanes: 3,
  maxLevels: 24,
  maxMarks: 24,
};

export function timeframeLabel(sec: number): string {
  for (const tf of TIMEFRAMES) if (tf.sec === sec) return tf.label;
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/* One entry of a chart_scan timeframe list, resolved to seconds, or null if it is not a
   timeframe at all.
 *
 * The button-bar list stops at 1d, so matching against TIMEFRAMES alone cannot see `1w`. The
 * scan handler used to fall back to snapTimeframe(Number(entry)) for a miss, and Number('1w')
 * is NaN: every comparison inside the snap is then false, so it returned the first entry in the
 * list and a weekly scan silently answered with a MINUTE chart under whatever label was asked
 * for. Nothing downstream could tell that the higher timeframe had never been read.
 *
 * Null rather than a nearest guess, because the caller needs to be able to say "that is not a
 * timeframe" out loud. Snapping is right for a number that is merely unservable (47 seconds);
 * it is wrong for a string that was never understood. */
export function resolveScanTimeframe(entry: string | number): number | null {
  const found = TIMEFRAMES.find((tf) => tf.label === String(entry));
  if (found !== undefined) return found.sec;
  return parseTimeframe(entry);
}

// Snap to a timeframe the data rails can actually serve. An agent that asks for 47 seconds
// gets the nearest real one and is told, rather than a chart of nothing.
export function snapTimeframe(sec: number): number {
  let best = TIMEFRAMES[0] as { label: string; sec: number };
  let bestGap = Infinity;
  for (const tf of TIMEFRAMES) {
    const gap = Math.abs(Math.log(tf.sec) - Math.log(Math.max(1, sec)));
    if (gap < bestGap) {
      bestGap = gap;
      best = tf;
    }
  }
  return best.sec;
}

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// Enough decimals that two neighbouring grid lines never print the same number, capped so a
// stablecoin pair does not show eight zeros. One precision is used everywhere on the chart:
// labels that change digit count between frames read as a bug.
export function priceDecimals(span: number, reference: number): number {
  const step = span > 0 ? span / 6 : Math.abs(reference) / 1000;
  if (!(step > 0)) return 2;
  return clamp(Math.ceil(-Math.log10(step)) + 1, 0, 8);
}

// How many decimals the venue itself quotes in. A span-derived precision alone rounds
// 63,434.5 to 63,434 on a wide window, which is the last price reading a digit short.
function tickDecimals(candles: Candle[]): number {
  let most = 0;
  for (let i = Math.max(0, candles.length - 20); i < candles.length; i++) {
    const text = String((candles[i] as Candle).c);
    const dot = text.indexOf('.');
    // A float that printed in exponent form, or with a long tail, is arithmetic noise
    // rather than the venue's tick, so it does not get a vote.
    if (dot < 0 || text.includes('e')) continue;
    const places = text.length - dot - 1;
    if (places <= 6 && places > most) most = places;
  }
  return most;
}

export function displayDecimals(span: number, candles: Candle[]): number {
  const reference = candles.length > 0 ? (candles[candles.length - 1] as Candle).c : 1;
  return clamp(Math.max(priceDecimals(span, reference), tickDecimals(candles)), 0, 8);
}

// How old an agent's object has to be before `chart_clear what:'stale'` will take it. Twenty
// minutes is long enough that a level drawn at the start of a piece of analysis survives the
// analysis, and short enough that yesterday's marks are not still on the screen. It is a
// default for a deliberate sweep and never an expiry: nothing here removes an object on a
// timer, because a level vanishing while a human is looking at it is worse than a stale one.
export const STALE_MS = 20 * 60 * 1000;

// `resolve` is how 'custom:<slug>' types reach this store. They live in the loader's map in
// src/indicators-custom rather than in the catalogue, and the store takes a function rather
// than the loader so it never imports it. Built-ins are tried first: a file cannot shadow one.
export function createChartStore(
  initialProduct: string,
  now: () => number = Date.now,
  resolve?: (type: string) => IndicatorSpec | null | undefined,
): {
  state(): ChartState;
  rev(): number;
  historyNeeded(): number;
  setView(patch: Record<string, unknown>, source: Source, by?: string | null): Outcome;
  // `spec` is the resolved indicator when the caller already has one (a custom indicator the
  // loader compiled); absent, the type is looked up in the built-in catalogue.
  addIndicator(args: Record<string, unknown>, source: Source, by?: string | null, spec?: IndicatorSpec): Outcome;
  removeIndicator(ref: string): Outcome;
  setLevel(args: Record<string, unknown>, source: Source, by?: string | null): Outcome;
  setMark(args: Record<string, unknown>, source: Source, by?: string | null): Outcome;
  clear(what: string, by?: string | null): Outcome;
  // A change to what the chart shows that was made outside this store: a line or a zone landing
  // in src/drawings.ts. It moves the revision exactly as a level does, because the window watches
  // one number and a frame carrying the old one is dropped as the echo of its own last write.
  touch(source: Source, by?: string | null): void;
  setGeometry(geometry: ChartGeometry): void;
  agentObjects(): number;
  // `drawings` is the drawing store's list, handed in because the sloped objects live there
  // and a tidy count that could not see them reported "nothing to clear" over a chart full
  // of zones.
  housekeeping(by?: string | null, drawings?: readonly Drawing[]): Housekeeping;
} {
  let seq = 0;
  const state: ChartState = {
    view: {
      product: initialProduct,
      provider: 'auto',
      granularitySec: 60,
      barCount: LIMITS.barCountDefault,
      panOffset: 0,
      priceScale: { mode: 'auto' },
    },
    indicators: [],
    levels: [],
    marks: [],
    geometry: null,
    rev: 1,
    lastDriver: 'human',
    lastDriverBy: null,
    lastChangeAt: new Date().toISOString(),
  };

  function bump(source: Source, by?: string | null): void {
    state.rev++;
    state.lastDriver = source;
    state.lastDriverBy = source === 'agent' && typeof by === 'string' && by.length > 0 ? by.slice(0, 64) : null;
    state.lastChangeAt = new Date().toISOString();
  }

  function nextId(prefix: string): string {
    seq++;
    return `${prefix}-${seq}`;
  }

  // The four fields every object on this chart carries, filled in one place so a new writer
  // cannot forget one and quietly produce an object the tidy cannot reason about.
  function stamp(source: Source, by?: string | null): Provenance {
    return {
      source,
      by: source === 'agent' && typeof by === 'string' && by.length > 0 ? by.slice(0, 64) : null,
      createdAt: now(),
      product: state.view.product,
      granularitySec: state.view.granularitySec,
    };
  }

  function tag(label: string, source: Source): string {
    const trimmed = label.trim().slice(0, 48);
    if (source !== 'agent') return trimmed;
    // Attribution the agent cannot write its way out of: the tag is added here, after the
    // label it supplied, and the UI reads it from this string.
    return `[agent] ${trimmed}`;
  }

  function setView(patch: Record<string, unknown>, source: Source, by?: string | null): Outcome {
    const notes: string[] = [];
    const view = state.view;

    // Set when THIS patch changes the instrument. The pan and the price scale carried in the
    // same patch describe the instrument being left, so they are dropped below rather than
    // applied on top of the reset this branch just did.
    let switchedProduct = false;

    // The venue moves before the product does, because the server resolves the product
    // against whichever venue this patch lands on and a view that recorded them in the other
    // order would answer chart_read with a product one venue lists and the other one's name.
    if (patch.provider !== undefined) {
      const asked = String(patch.provider).trim().toLowerCase();
      if (!PROVIDER_CHOICES.includes(asked as ProviderChoice)) {
        return { ok: false, notes, error: `unknown provider: ${String(patch.provider)}. one of ${PROVIDER_CHOICES.join(', ')}` };
      }
      const next = asked as ProviderChoice;
      if (next !== view.provider) {
        view.provider = next;
        // The same argument the product branch makes: two venues price the same coin
        // differently and one of them is a perp against the other's spot, so a manual
        // scale and a pan measured on the venue being left do not describe the new one.
        view.panOffset = 0;
        view.priceScale = { mode: 'auto' };
        switchedProduct = true;
        notes.push(next === 'auto' ? 'provider back to auto' : `provider pinned to ${next}`);
      }
    }

    if (typeof patch.product === 'string' && patch.product.trim().length > 0) {
      const next = patch.product.trim().toUpperCase();
      if (next !== view.product) {
        view.product = next;
        // A different instrument is a different price range: nothing about the old window
        // carries over except how many bars are on screen.
        view.panOffset = 0;
        view.priceScale = { mode: 'auto' };
        switchedProduct = true;
      }
    }

    // Any timeframe from a second to a week, not just the twelve on the button bar.
    // The twelve are what a hand can click; an agent asked for 7m or 90s and used to be
    // refused or silently snapped to something it did not ask for. The market layer folds
    // a base interval the venue does serve into whatever was requested, so the enum is a
    // convenience now and not a constraint. See src/market/aggregate.ts.
    if (typeof patch.granularitySec === 'number' && Number.isFinite(patch.granularitySec)) {
      const asked = Math.floor(patch.granularitySec);
      if (asked < MIN_TIMEFRAME_SEC || asked > MAX_TIMEFRAME_SEC) {
        return { ok: false, notes, error: `timeframe out of range: ${asked}s. between 1m and 1w` };
      }
      if (asked !== view.granularitySec) {
        view.granularitySec = asked;
        view.panOffset = 0;
      }
    } else if (typeof patch.timeframe === 'string') {
      const parsed = parseTimeframe(patch.timeframe);
      if (parsed === null) {
        return {
          ok: false,
          notes,
          error: `unknown timeframe: ${patch.timeframe}. use a count and a unit, like 7m, 4h or 1w`,
        };
      }
      if (parsed < MIN_TIMEFRAME_SEC) {
        return {
          ok: false,
          notes,
          error: `${patch.timeframe} is below the one minute floor. no venue serves a candle under a minute`,
        };
      }
      if (parsed !== view.granularitySec) {
        view.granularitySec = parsed;
        view.panOffset = 0;
      }
    }

    if (typeof patch.barCount === 'number' && Number.isFinite(patch.barCount)) {
      const clamped = clamp(patch.barCount, LIMITS.barCountMin, LIMITS.barCountMax);
      if (clamped !== patch.barCount) notes.push(`barCount clamped to ${clamped}`);
      view.barCount = clamped;
    }

    // The two fields below used to undo the product reset above, in the same call, because the
    // browser pushes the WHOLE view on any change (ui/chart/chart.js pushChart) and not a minimal
    // patch. Switching BTC to SOL therefore arrived as {product:'SOL-USD', panOffset:300,
    // priceLow:63000, priceHigh:64000}: the reset ran, then line-for-line the old instrument's
    // window was written back over it. Two visible failures came out of that, and they are the
    // two complaints about this chart.
    //
    //   Manual scale carried across. SOL trades near 150 and the axis still spanned 63k, so
    //   every candle drew off the pane. This is "off-scale".
    //
    //   Stale pan carried across, which happens even in auto mode. Panned 300 bars back on
    //   BTC and switched to a shorter SOL series, the right edge goes negative, start passes
    //   end, no candle is scanned, and the domain falls through to the degenerate 0..1
    //   fallback in buildLayout. This is "compressed".
    //
    // A patch that changes the instrument cannot also be describing that instrument's window,
    // because the caller wrote it while looking at a different one. Dropped, with a note, so
    // an agent that meant it can see why it did not take and ask again in a second call.
    if (typeof patch.panOffset === 'number' && Number.isFinite(patch.panOffset)) {
      if (switchedProduct) notes.push('panOffset ignored: it described the previous instrument');
      else view.panOffset = clampPan(patch.panOffset, view.barCount);
    }
    if (patch.live === true) view.panOffset = 0;

    if (patch.priceScale === 'auto' || patch.priceAuto === true) {
      view.priceScale = { mode: 'auto' };
    } else if (typeof patch.priceLow === 'number' && typeof patch.priceHigh === 'number') {
      const low = Math.min(patch.priceLow, patch.priceHigh);
      const high = Math.max(patch.priceLow, patch.priceHigh);
      if (!(high > low)) return { ok: false, notes, error: 'priceHigh must be above priceLow' };
      if (switchedProduct) notes.push('price scale ignored: it described the previous instrument');
      else view.priceScale = { mode: 'manual', low, high };
    }

    // THE TIDY. A level or a mark is anchored to a price and a time on ONE instrument.
    // Carried onto another it is not stale, it is WRONG: 63,000 drawn on Bitcoin lands off
    // the bottom of a Solana chart. Before this, every one of them stayed until somebody
    // noticed, and the somebody was the human. The drawing store sweeps its own lines and
    // zones on the same switch (see chart_draw in src/http/view.ts).
    //
    // Indicators are deliberately NOT swept. An EMA 21 is a recipe rather than a place: it
    // recomputes on the new series and means exactly what it meant before. Clearing it would
    // make an agent rebuild its own study package on every product switch.
    //
    // The human's own drawings are never swept either, on the same rule the drawing store
    // already holds: an agent's action must not delete work a person did on purpose. They are
    // counted in the note instead, so the agent can offer to clear them rather than doing it.
    if (switchedProduct) {
      const staleAgent = (o: Provenance): boolean => o.source === 'agent' && o.product !== view.product;
      const swept = state.levels.filter(staleAgent).length + state.marks.filter(staleAgent).length;
      if (swept > 0) {
        state.levels = state.levels.filter((l) => !staleAgent(l));
        state.marks = state.marks.filter((m) => !staleAgent(m));
        notes.push(
          `cleared ${swept} agent ${swept === 1 ? 'drawing' : 'drawings'} anchored to the previous instrument; indicators were kept because they recompute`,
        );
      }
      const humanLeft = [...state.levels, ...state.marks].filter(
        (o) => o.source === 'human' && o.product !== view.product,
      ).length;
      if (humanLeft > 0) {
        notes.push(
          `${humanLeft} human ${humanLeft === 1 ? 'drawing' : 'drawings'} from the previous instrument are still on the chart and were left alone; only a human clears those`,
        );
      }
    }

    bump(source, by);
    return { ok: true, notes };
  }

  function lookup(type: string): IndicatorSpec | undefined {
    return indicatorSpec(type) ?? resolve?.(type) ?? undefined;
  }

  function addIndicator(args: Record<string, unknown>, source: Source, by?: string | null, resolved?: IndicatorSpec): Outcome {
    const type = String(args.type ?? '').toLowerCase().trim();
    const spec = resolved ?? lookup(type);
    if (spec === undefined) {
      return { ok: false, notes: [], error: `unknown indicator: ${type || '(none given)'}. chart_batch op indicator_list has the list.` };
    }
    const given = args.params !== null && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : args;
    const { params, notes } = normaliseParams(spec, given);
    const label = spec.label(params);

    const already = state.indicators.find((ind) => ind.type === type && sameParams(ind.params, params));
    if (already !== undefined) {
      return { ok: true, notes: [`${label} is already on the chart`], id: already.id, label: already.label };
    }

    if (spec.pane === 'own') {
      const panes = state.indicators.filter((ind) => ind.pane === 'own');
      if (panes.length >= LIMITS.maxPanes) {
        // Refuse rather than squash. Four panes in this box would leave the price a strip,
        // and a chart that cannot be read is worse than one that says no.
        return {
          ok: false,
          notes,
          error:
            `the chart already has ${panes.length} sub-panes (${panes.map((p) => p.label).join(', ')}) and ` +
            `${LIMITS.maxPanes} is the maximum that leaves the price pane readable. ` +
            `Remove one with chart_draw indicators.remove first.`,
        };
      }
    } else {
      const overlays = state.indicators.filter((ind) => ind.pane === 'price');
      if (overlays.length >= LIMITS.maxOverlays) {
        return {
          ok: false,
          notes,
          error: `the price pane already carries ${overlays.length} overlays, which is the maximum. Remove one first.`,
        };
      }
    }

    const id = nextId(type);
    state.indicators.push({ id, type, params, label: tag(label, source), pane: spec.pane, ...stamp(source, by) });
    bump(source, by);
    const warmup = warmupBars(spec, params);
    if (warmup > state.view.barCount) {
      notes.push(`${label} needs ${warmup} bars of history and the window shows ${Math.round(state.view.barCount)}; the extra history is fetched behind the left edge`);
    }
    return { ok: true, notes, id, label };
  }

  function removeIndicator(ref: string): Outcome {
    const key = String(ref ?? '').toLowerCase().trim();
    const before = state.indicators.length;
    const kept = state.indicators.filter((ind) => ind.id !== key && ind.type !== key && ind.label.toLowerCase() !== key);
    if (kept.length === before) {
      return { ok: false, notes: [], error: `no indicator matching ${ref}. On the chart: ${state.indicators.map((i) => `${i.id} (${i.label})`).join(', ') || 'none'}` };
    }
    state.indicators = kept;
    bump('agent');
    return { ok: true, notes: [`removed ${before - kept.length}`] };
  }

  function setLevel(args: Record<string, unknown>, source: Source, by?: string | null): Outcome {
    const price = Number(args.price);
    if (!Number.isFinite(price)) return { ok: false, notes: [], error: 'price must be a finite number' };
    if (state.levels.length >= LIMITS.maxLevels) {
      return { ok: false, notes: [], error: `${LIMITS.maxLevels} price levels is the maximum. Clear some with chart_draw clear.` };
    }
    const id = nextId('level');
    state.levels.push({ id, price, label: tag(String(args.label ?? '') || `level ${price}`, source), ...stamp(source, by) });
    bump(source, by);
    return { ok: true, notes: [], id };
  }

  function setMark(args: Record<string, unknown>, source: Source, by?: string | null): Outcome {
    const t = Number(args.t ?? args.time);
    if (!Number.isFinite(t)) return { ok: false, notes: [], error: 't must be a unix timestamp in seconds' };
    if (state.marks.length >= LIMITS.maxMarks) {
      return { ok: false, notes: [], error: `${LIMITS.maxMarks} marks is the maximum. Clear some with chart_draw clear.` };
    }
    const id = nextId('mark');
    state.marks.push({ id, t: Math.round(t), label: tag(String(args.label ?? '') || 'mark', source), ...stamp(source, by) });
    bump(source, by);
    return { ok: true, notes: [], id };
  }

  const CLEAR_TARGETS = ['indicators', 'levels', 'marks', 'agent', 'mine', 'stale', 'all'] as const;

  /* What may be removed, and by whom.
     `agent` and `all` are the human's controls, and an agent holds them too because the human
     may ask it to wipe the board. `mine` and `stale` are the ones written FOR the agent, and
     they are the reason this took a `by` argument: with a team on the chart, an agent tidying
     up must be able to reach its own work and nothing else. An agent that cleared `agent`
     when it meant `mine` would delete a colleague's levels mid-analysis and neither of them
     would ever find out why. */
  function clear(what: string, by?: string | null): Outcome {
    const key = String(what ?? 'all').toLowerCase().trim();
    const before = state.indicators.length + state.levels.length + state.marks.length;

    const keep = (predicate: (o: Provenance) => boolean): void => {
      state.indicators = state.indicators.filter(predicate);
      state.levels = state.levels.filter(predicate);
      state.marks = state.marks.filter(predicate);
    };

    if (key === 'indicators') state.indicators = [];
    else if (key === 'levels') state.levels = [];
    else if (key === 'marks') state.marks = [];
    else if (key === 'agent') {
      // The human's one-click way out of anything ANY agent put on the surface.
      keep((o) => o.source !== 'agent');
    } else if (key === 'mine') {
      // An agent with no session id has no "mine" to speak of, and clearing everything the
      // agents drew would be the wrong answer to a call that asked for one agent's work.
      if (typeof by !== 'string' || by.length === 0) {
        return {
          ok: false,
          notes: [],
          error:
            "clear 'mine' needs to know which agent is asking, and this call carried no session. " +
            "Use 'agent' to clear everything the agents drew, or 'stale' for the old ones.",
        };
      }
      keep((o) => !(o.source === 'agent' && o.by === by));
    } else if (key === 'stale') {
      const cutoff = now() - STALE_MS;
      keep((o) => !(o.source === 'agent' && (o.createdAt < cutoff || o.product !== state.view.product)));
    } else if (key === 'all') {
      state.indicators = [];
      state.levels = [];
      state.marks = [];
    } else {
      return { ok: false, notes: [], error: `unknown target: ${key}. known: ${CLEAR_TARGETS.join(', ')}` };
    }
    const removed = before - (state.indicators.length + state.levels.length + state.marks.length);
    bump('human');
    return { ok: true, notes: [`cleared ${key}: ${removed} ${removed === 1 ? 'object' : 'objects'} removed`] };
  }

  function housekeeping(by?: string | null, drawings: readonly Drawing[] = []): Housekeeping {
    // A drawing with no product recorded predates that field; it was made on whatever was on
    // screen, which for the tidy's purposes is this chart.
    const drawn: Provenance[] = drawings.map((d) => ({
      source: d.source,
      by: d.by ?? null,
      createdAt: d.createdAt,
      product: d.product ?? state.view.product,
      granularitySec: d.granularitySec ?? state.view.granularitySec,
    }));
    const all: Provenance[] = [...state.indicators, ...state.levels, ...state.marks, ...drawn];
    const cutoff = now() - STALE_MS;
    const agentObjs = all.filter((o) => o.source === 'agent');
    const mine = by ? agentObjs.filter((o) => o.by === by).length : 0;
    const stale = agentObjs.filter((o) => o.createdAt < cutoff).length;
    const foreign = agentObjs.filter(
      (o) => o.product !== state.view.product || o.granularitySec !== state.view.granularitySec,
    ).length;
    const overlays = state.indicators.filter((i) => i.pane === 'price').length;
    const panes = state.indicators.filter((i) => i.pane === 'own').length;
    const hints: string[] = [];
    if (stale > 0) hints.push(`${stale} agent ${stale === 1 ? 'object is' : 'objects are'} over 20 minutes old`);
    if (mine > 0) hints.push(`chart_draw clear:'mine' removes only your own ${mine}`);
    if (panes >= LIMITS.maxPanes) hints.push('the sub-panes are full; the next one is refused. indicator_read measures without drawing');
    if (overlays >= LIMITS.maxOverlays) hints.push('the price pane is full; remove an overlay before adding one');
    return {
      mine,
      others: agentObjs.length - mine,
      human: all.length - agentObjs.length,
      stale,
      foreign,
      capacity: {
        overlays: `${overlays}/${LIMITS.maxOverlays}`,
        panes: `${panes}/${LIMITS.maxPanes}`,
        levels: `${state.levels.length}/${LIMITS.maxLevels}`,
        marks: `${state.marks.length}/${LIMITS.maxMarks}`,
        drawings: `${drawings.length}/${DRAWINGS_MAX}`,
      },
      hint: hints.length === 0 ? 'nothing needs clearing' : hints.join('; '),
    };
  }

  // Bars to serve: the window, the pan, a margin, and the longest indicator warmup so an
  // overlay is drawn all the way to the left edge instead of starting mid screen. It follows
  // the view rather than sitting on a floor: the payload carries this many candles and this
  // many values per indicator plot, so a floor of fifteen hundred bars under a 120-bar window
  // was two hundred kilobytes of series on every refresh to draw a screen that used a tenth of
  // it. The depth the window can pan into is a separate question, answered by the paged
  // backfill behind the left edge, not by what one payload carries.
  function historyNeeded(): number {
    let warmup = 0;
    for (const ind of state.indicators) {
      const spec = lookup(ind.type);
      if (spec === undefined) continue;
      const need = warmupBars(spec, ind.params);
      if (need > warmup) warmup = need;
    }
    const want = state.view.barCount + Math.max(0, state.view.panOffset) + LIMITS.fetchMargin + warmup;
    return Math.min(LIMITS.historyMax, Math.max(LIMITS.barCountMin, Math.ceil(want)));
  }

  return {
    state: () => state,
    rev: () => state.rev,
    historyNeeded,
    setView,
    addIndicator,
    removeIndicator,
    setLevel,
    setMark,
    clear,
    touch(source: Source, by?: string | null): void {
      bump(source, by);
    },
    housekeeping,
    setGeometry(geometry: ChartGeometry): void {
      // Geometry is a report about the renderer, not a change to the chart, so it does not
      // bump the revision. Bumping it here would make the browser answer its own echo.
      state.geometry = geometry;
    },
    agentObjects(): number {
      return (
        state.indicators.filter((i) => i.source === 'agent').length +
        state.levels.filter((l) => l.source === 'agent').length +
        state.marks.filter((m) => m.source === 'agent').length
      );
    },
  };
}

function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

export function clampPan(value: number, barCount: number): number {
  // Forward past the newest bar is allowed, up to a quarter of the window, because a chart
  // that walls at the last bar feels stuck. Back is capped by what the rails will serve.
  const forward = -Math.round(barCount * 0.25);
  return clamp(value, forward, LIMITS.panMax);
}

export type VisibleRange = { start: number; end: number; count: number };

// The candles under the plot. `end` is exclusive. Fractional pan and bar counts are rounded
// outward so a partially visible bar at either edge is still included.
export function visibleRange(total: number, view: ChartView): VisibleRange {
  if (total <= 0) return { start: 0, end: 0, count: 0 };
  const end = clamp(Math.ceil(total - view.panOffset), 1, total);
  const start = clamp(Math.floor(end - view.barCount), 0, Math.max(0, end - 1));
  return { start, end, count: end - start };
}

export type SeriesDigest = {
  timeframe: string;
  granularitySec: number;
  bars: number;
  last: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  rangePct: number | null;
  atr: number | null;
  atrPct: number | null;
  trend: string;
  barClosesInSec: number | null;
  newestBarTime: string | null;
};

// One timeframe boiled down to what a trader glances at. Used by chart_scan so the agent can
// hold several timeframes at once without moving the chart the human is looking at.
export function digestSeries(candles: Candle[], granularitySec: number, nowSec: number): SeriesDigest {
  const bars = candles.length;
  if (bars === 0) {
    return {
      timeframe: timeframeLabel(granularitySec),
      granularitySec,
      bars: 0,
      last: null,
      changePct: null,
      high: null,
      low: null,
      rangePct: null,
      atr: null,
      atrPct: null,
      trend: 'no data',
      barClosesInSec: null,
      newestBarTime: null,
    };
  }
  const first = candles[0] as Candle;
  const newest = candles[bars - 1] as Candle;
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
  }
  // The one ATR in the app: Wilder's, the same series chart_batch's atr op and the trade
  // payload read. A plain mean of true ranges sat here and disagreed with both under one name.
  const atrSeries = wilderAtr(candles, Math.min(14, bars));
  const atrLast = atrSeries[atrSeries.length - 1];
  const atr = atrLast === null || atrLast === undefined ? 0 : atrLast;

  // Trend without an indicator on the chart: where the close sits against two averages of
  // the series itself. Cheap, and it answers the only question chart_scan is asked.
  const fastLen = Math.min(21, Math.max(2, Math.floor(bars / 4)));
  const slowLen = Math.min(55, Math.max(fastLen + 1, Math.floor(bars / 2)));
  const avg = (len: number): number => {
    let sum = 0;
    for (let i = bars - len; i < bars; i++) sum += (candles[i] as Candle).c;
    return sum / len;
  };
  const fast = avg(fastLen);
  const slow = avg(slowLen);
  const trend =
    fast > slow && newest.c > fast ? 'up' : fast < slow && newest.c < fast ? 'down' : 'sideways';

  return {
    timeframe: timeframeLabel(granularitySec),
    granularitySec,
    bars,
    last: newest.c,
    changePct: pctChange(first.o, newest.c),
    high,
    low,
    rangePct: low > 0 ? ((high - low) / low) * 100 : null,
    atr,
    atrPct: newest.c > 0 ? (atr / newest.c) * 100 : null,
    trend,
    barClosesInSec: Math.max(0, newest.t + granularitySec - nowSec),
    newestBarTime: isoOf(newest.t),
  };
}

export type ReadArgs = {
  state: ChartState;
  candles: Candle[];
  meta: { source: string; stale: boolean; built: string };
  computed: { indicator: ChartIndicator; result: IndicatorResult }[];
  nowSec: number;
  // What the tidy would find, computed for the agent that is doing the reading. Optional so a
  // caller with no roster (a test, the browser's own read) still gets a chart read.
  housekeeping?: Housekeeping;
  // The sloped objects, from the one store that holds them (src/drawings.ts).
  drawings?: readonly Drawing[];
};

// Everything the agent can ask about what is on the chart, in one object. Written to be
// answered without a follow-up: times in epoch and ISO, prices with the precision actually
// drawn, and every indicator with its own plain sentence.
export function buildRead(args: ReadArgs): unknown {
  const { state, candles, meta, computed, nowSec } = args;
  const view = state.view;
  const range = visibleRange(candles.length, view);
  const window = candles.slice(range.start, range.end);
  const newest = candles.length > 0 ? (candles[candles.length - 1] as Candle) : null;

  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const c of window) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
    volume += c.v;
  }
  const hasWindow = window.length > 0;
  const firstBar = hasWindow ? (window[0] as Candle) : null;
  const lastBar = hasWindow ? (window[window.length - 1] as Candle) : null;

  const shownLow = view.priceScale.mode === 'manual' ? view.priceScale.low : hasWindow ? low : 0;
  const shownHigh = view.priceScale.mode === 'manual' ? view.priceScale.high : hasWindow ? high : 0;
  const decimals = displayDecimals(shownHigh - shownLow, window);

  const highBar = hasWindow ? window.reduce((best, c) => (c.h > best.h ? c : best), window[0] as Candle) : null;
  const lowBar = hasWindow ? window.reduce((best, c) => (c.l < best.l ? c : best), window[0] as Candle) : null;

  return {
    product: view.product,
    timeframe: timeframeLabel(view.granularitySec),
    granularitySec: view.granularitySec,
    barDurationSec: view.granularitySec,
    serverTime: { epochSec: nowSec, iso: isoOf(nowSec), zone: 'UTC' },

    data: {
      source: meta.source,
      stale: meta.stale,
      builtFrom: meta.built === 'trades' ? 'live trade stream (no exchange candle exists below 1m)' : 'exchange candles',
      barsLoaded: candles.length,
      oldestLoaded: candles.length > 0 ? isoOf((candles[0] as Candle).t) : null,
    },

    window: {
      barsShown: range.count,
      barsBackFromNewest: Math.round(view.panOffset),
      live: view.panOffset <= 0,
      from: firstBar === null ? null : { epochSec: firstBar.t, iso: isoOf(firstBar.t) },
      to: lastBar === null ? null : { epochSec: lastBar.t, iso: isoOf(lastBar.t) },
      spansSec: firstBar !== null && lastBar !== null ? lastBar.t + view.granularitySec - firstBar.t : null,
    },

    price: {
      decimals,
      last: newest === null ? null : newest.c,
      changeOverWindowPct: firstBar !== null && newest !== null ? pctChange(firstBar.o, newest.c) : null,
      changeOverWindowAbs: firstBar !== null && newest !== null ? newest.c - firstBar.o : null,
      high: hasWindow ? high : null,
      highAt: highBar === null ? null : isoOf(highBar.t),
      low: hasWindow ? low : null,
      lowAt: lowBar === null ? null : isoOf(lowBar.t),
      rangePct: hasWindow && low > 0 ? ((high - low) / low) * 100 : null,
      volumeOverWindow: volume,
      scale: view.priceScale.mode === 'manual'
        ? { mode: 'manual', low: view.priceScale.low, high: view.priceScale.high }
        : { mode: 'auto', low: hasWindow ? low : null, high: hasWindow ? high : null },
    },

    currentBar:
      newest === null
        ? null
        : {
            openTime: { epochSec: newest.t, iso: isoOf(newest.t) },
            o: newest.o,
            h: newest.h,
            l: newest.l,
            c: newest.c,
            v: newest.v,
            direction: newest.c >= newest.o ? 'up' : 'down',
            closesInSec: Math.max(0, newest.t + view.granularitySec - nowSec),
          },

    indicators: computed.map(({ indicator, result }) => ({
      id: indicator.id,
      type: indicator.type,
      label: indicator.label,
      params: indicator.params,
      pane: indicator.pane === 'price' ? 'price' : 'own',
      source: indicator.source,
      by: indicator.by,
      state: result.state,
      last: result.plots.map((plot) => ({ key: plot.key, value: lastDefined(plot.values) })),
    })),

    levels: state.levels.map((l) => ({
      id: l.id,
      price: l.price,
      label: l.label,
      source: l.source,
      by: l.by,
      ageSec: Math.max(0, Math.round((Date.now() - l.createdAt) / 1000)),
      drawnOn: `${l.product} ${timeframeLabel(l.granularitySec)}`,
      distanceFromLastPct: newest === null ? null : pctChange(newest.c, l.price),
      side: newest === null ? null : l.price > newest.c ? 'above price' : 'below price',
    })),
    marks: state.marks.map((m) => ({
      id: m.id,
      label: m.label,
      source: m.source,
      by: m.by,
      ageSec: Math.max(0, Math.round((Date.now() - m.createdAt) / 1000)),
      drawnOn: `${m.product} ${timeframeLabel(m.granularitySec)}`,
      epochSec: m.t,
      iso: isoOf(m.t),
    })),

    // The sloped objects, from the drawing store. priceNow and distanceFromLastPct are the
    // whole reason to read a line back: its useful value is where it sits at this instant,
    // and recomputing that from two anchors is exactly the arithmetic the reader should not
    // have to repeat. Extended past its second anchor, which is what makes it a trend line
    // rather than a segment.
    drawings: (args.drawings ?? []).map((d) => readDrawing(d, newest)),

    geometry: state.geometry,
    rev: state.rev,
    lastDriver: state.lastDriver,
    lastDriverBy: state.lastDriverBy,
    lastChangeAt: state.lastChangeAt,
    // What is on this chart that probably should not be. It rides on the read the agent makes
    // anyway rather than waiting behind a tool nobody calls, which is the whole mechanism by
    // which cleaning up became automatic: the counts and the exact call that fixes them are in
    // front of the model at the moment it is looking at the chart.
    housekeeping: args.housekeeping ?? null,
  };
}

function lastDefined(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

// Seven significant digits: enough for any price this app charts and any oscillator, and it
// keeps a compact read from carrying fifteen digits of float noise per value.
function short(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(7));
}

// The read as the agent gets it by default: the chart in about a kilobyte. The full read
// above grew to four and a half kilobytes with a preset on the chart, and it was echoed after
// every write, so a session paid for the same chart on every turn. This carries what a reader
// acts on: the last values and state line of each study, where the drawn objects sit against
// the price, the counts, and the tidy block. `chart_read full:true` is the old shape.
export function buildCompactRead(args: ReadArgs & { chart: number }): unknown {
  const { state, candles, nowSec } = args;
  const view = state.view;
  const range = visibleRange(candles.length, view);
  const window = candles.slice(range.start, range.end);
  const newest = candles.length > 0 ? (candles[candles.length - 1] as Candle) : null;
  const firstBar = window.length > 0 ? (window[0] as Candle) : null;
  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
  }
  const hasWindow = window.length > 0;
  const shownLow = view.priceScale.mode === 'manual' ? view.priceScale.low : hasWindow ? low : 0;
  const shownHigh = view.priceScale.mode === 'manual' ? view.priceScale.high : hasWindow ? high : 0;
  const decimals = displayDecimals(shownHigh - shownLow, window);
  const keep = args.housekeeping;

  return {
    chart: args.chart,
    product: view.product,
    timeframe: timeframeLabel(view.granularitySec),
    rev: state.rev,
    data: { source: args.meta.source, stale: args.meta.stale, bars: candles.length },
    window: {
      from: firstBar === null ? null : isoOf(firstBar.t),
      barsShown: range.count,
      live: view.panOffset <= 0,
    },
    price: {
      last: newest === null ? null : short(newest.c),
      changePct: firstBar !== null && newest !== null ? short(pctChange(firstBar.o, newest.c)) : null,
      high: hasWindow ? short(high) : null,
      low: hasWindow ? short(low) : null,
      decimals,
    },
    bar:
      newest === null
        ? null
        : {
            o: short(newest.o),
            h: short(newest.h),
            l: short(newest.l),
            c: short(newest.c),
            v: short(newest.v),
            closesInSec: Math.max(0, newest.t + view.granularitySec - nowSec),
          },
    indicators: args.computed.map(({ indicator, result }) => ({
      id: indicator.id,
      label: indicator.label,
      last: Object.fromEntries(result.plots.map((plot) => [plot.key, short(lastDefined(plot.values))])),
      state: result.state,
    })),
    // Who drew each object is in the full read; here the housekeeping block answers "how much
    // of this is mine" in one number, which is the question the compact read is for.
    levels: state.levels.map((l) => ({
      id: l.id,
      px: l.price,
      label: l.label,
      distPct: newest === null ? null : short(pctChange(newest.c, l.price)),
    })),
    marks: state.marks.map((m) => ({ id: m.id, t: m.t, label: m.label })),
    drawings: (args.drawings ?? []).map((d) => {
      const full = readDrawing(d, newest);
      return d.kind === 'zone'
        ? { id: d.id, kind: 'zone', label: d.label, low: full.low, high: full.high, side: full.side }
        : { id: d.id, kind: 'line', label: d.label, priceNow: short(full.priceNow as number | null), direction: full.direction, side: full.side };
    }),
    geometry:
      state.geometry === null
        ? null
        : {
            width: state.geometry.width,
            height: state.geometry.height,
            pxPerBar: short(state.geometry.pxPerBar),
            panes: state.geometry.panes.length,
            dropped: state.geometry.dropped,
          },
    housekeeping:
      keep === undefined ? null : { mine: keep.mine, others: keep.others, human: keep.human, stale: keep.stale, hint: keep.hint },
  };
}

// One drawn object as the agent reads it. Exported because the compact read builds its own
// smaller row from the same arithmetic.
export function readDrawing(d: Drawing, newest: Candle | null): Record<string, unknown> {
  const base = {
    id: d.id,
    label: d.label,
    source: d.source,
    by: d.by ?? null,
    ageSec: Math.max(0, Math.round((Date.now() - d.createdAt) / 1000)),
    drawnOn: d.product === undefined ? null : `${d.product} ${timeframeLabel(d.granularitySec ?? 60)}`,
  };
  if (d.kind === 'zone' && d.zone !== undefined) {
    const { low, high } = d.zone;
    return {
      ...base,
      kind: 'zone',
      low,
      high,
      side: newest === null ? null : low > newest.c ? 'above price' : high < newest.c ? 'below price' : 'around price',
    };
  }
  if (d.line === undefined) return { ...base, kind: d.kind };
  const { a, b } = d.line;
  const slopePerSec = b.t === a.t ? 0 : (b.price - a.price) / (b.t - a.t);
  const priceNow = newest === null ? null : lineAt(d.line, newest.t);
  return {
    ...base,
    kind: 'line',
    from: { epochSec: a.t, iso: isoOf(a.t), price: a.price },
    to: { epochSec: b.t, iso: isoOf(b.t), price: b.price },
    slopePerHour: slopePerSec * 3600,
    direction: b.price > a.price ? 'rising' : b.price < a.price ? 'falling' : 'flat',
    priceNow,
    distanceFromLastPct: newest === null || priceNow === null ? null : pctChange(newest.c, priceNow),
    side: newest === null || priceNow === null ? null : priceNow > newest.c ? 'above price' : 'below price',
  };
}
