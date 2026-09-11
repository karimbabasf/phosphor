// Every candle surface and the chart the human is looking at: the price cache behind the basic
// screen, the two candle loaders, the render payload, the agent's read of the same thing, and
// the window's own pan and zoom coming home.

import type http from 'node:http';

import type { Candle } from '../types.ts';
import type { PriceReading } from '../view/basic.ts';
import { buildCompactRead, buildRead, LIMITS as CHART_LIMITS, TIMEFRAMES, timeframeLabel } from '../chart.ts';
import type { ChartGeometry, ChartIndicator, ChartState, ProviderChoice } from '../chart.ts';
import { PROVIDER_CHOICES } from '../chart.ts';
import type { ChartSlot, ChartStore } from '../charts.ts';
import { indicatorSpec } from '../indicators.ts';
import type { IndicatorResult, IndicatorSpec } from '../indicators.ts';
import { sameOrigin, tokenMatches } from './auth.ts';
import { errText, fail, intParam, readBody, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { CANDLE_LIMIT_MAX } from './context.ts';
import { feedFor, type FeedState } from '../market/push.ts';
import { SNAPSHOT_MAX_BYTES } from '../snapshot.ts';
import type { Ctx } from './context.ts';

// The basic screen's price tracker. Hourly bars over a day: "today" for someone reading
// a price is the last 24 hours, not the span since midnight in a timezone the exchange
// does not share. Polled well below the rate any venue rate-limits.
const PRICE_GRANULARITY_SEC = 3600;
const PRICE_BARS = 24;
const PRICE_POLL_MS = 30000;

async function readPrice(ctx: Ctx, product: string): Promise<PriceReading> {
  try {
    const load = await loadCandles(ctx, product, PRICE_GRANULARITY_SEC, PRICE_BARS);
    const candles = load.candles ?? [];
    const last = candles[candles.length - 1];
    const first = candles[0];
    if (last === undefined || first === undefined || !(first.o > 0)) return null;
    return {
      product,
      priceUsd: last.c,
      changePct: ((last.c - first.o) / first.o) * 100,
      // The window the change is measured over, as a series. The same 24 bars behind
      // both figures, so the line and the percentage can never disagree on screen.
      closes: candles.map((candle) => candle.c),
    };
  } catch (err) {
    /* A venue outage and a bug in this file both used to return null, so the price path was the
       one place a ReferenceError could hide completely: `ctx` is read here from a closure that is
       assembled directly above the first poll, and had that order ever slipped, this catch would
       have swallowed the temporal-dead-zone error and the screen would simply have shown three
       blank prices. A fault in the app is named; a network failure is not, because it is expected
       and a line per poll would bury the log. */
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
      ctx.audit.append(
        'error',
        `reading the price of ${product} hit a fault in Phosphor rather than in the venue: ${err.name}: ${err.message}`,
      );
    }
    return null;
  }
}

export async function pollPrice(ctx: Ctx): Promise<void> {
  // Read into a local first. The list can change under this await when the assistant is
  // asked for a different coin, and assigning a three-coin result into a screen that now
  // shows two would put a price under the wrong name.
  const coins = [...ctx.prices.coins];
  const readings = await Promise.all(coins.map((product) => readPrice(ctx, product)));
  if (coins.join() !== ctx.prices.coins.join()) return;
  ctx.prices.readings = readings;
}

// The poll runs on a timer and once at boot. The timer is handed back rather than held here,
// because the server's own close handler is what clears it.
export function startPricePolling(ctx: Ctx): NodeJS.Timeout {
  const priceTimer = setInterval(() => {
    void pollPrice(ctx);
  }, PRICE_POLL_MS);
  priceTimer.unref();
  void pollPrice(ctx);
  return priceTimer;
}

type CandleLoad = {
  candles: Candle[];
  source: string;
  stale: boolean;
  built: string;
  fetchedAt: string;
  // True while the window behind this read is still being filled, so the chart can say
  // "filling" rather than showing a short series as though it were the whole story.
  filling: boolean;
  // Whether a venue socket is driving this market right now. Three states and no more, because
  // a person reading a chart has one question about the feed. See src/market/push.ts.
  feed: FeedState;
  note: string | null;
};

// One loader behind every candle surface, in two flavours that differ only in who waits.
//
// The render path must never wait. Before this, GET /api/chart awaited a Hyperliquid
// round trip before the browser could draw, and the trade stream asked it to do that
// about 1.4 times a second. Measured on the running app 2026-08-13: four sequential
// chart reads did not finish inside four minutes. Now a render reads memory and any
// refill happens behind it, announced over SSE when it lands.
//
// An agent still waits, because an empty array is a worse answer than a slow one when
// something is about to reason over it.
function readCandles(
  ctx: Ctx,
  product: string,
  granularitySec: number,
  limit: number,
  provider: ProviderChoice = 'auto',
): CandleLoad {
  const held = ctx.market.read(product, granularitySec, limit, provider);
  return {
    candles: held.candles,
    source: held.source,
    stale: held.stale,
    built: 'candles',
    fetchedAt: new Date(Date.now() - held.ageSec * 1000).toISOString(),
    filling: held.filling,
    // Per series, not per venue: a socket carrying BTC says nothing about SOL, and an open
    // socket that has gone silent looks healthy from its readyState and nothing like it here.
    feed: feedFor(held, ctx.market.liveConnected),
    note: held.note,
  };
}

// `provider` pins the venue. It defaults to 'auto' so the surfaces that are not the chart
// (the price line, the coin list, a scan of some other product) keep the catalogue's own
// answer, and only the chart the human is looking at follows the chart's own choice.
export async function loadCandles(
  ctx: Ctx,
  product: string,
  granularitySec: number,
  limit: number,
  provider: ProviderChoice = 'auto',
): Promise<CandleLoad> {
  await ctx.market.warm(product, granularitySec, limit, provider);
  return readCandles(ctx, product, granularitySec, limit, provider);
}

export async function sendCandles(ctx: Ctx, url: URL, res: http.ServerResponse): Promise<void> {
  const product = url.searchParams.get('product') ?? ctx.cfg.candleProducts[0] ?? 'BTC-USD';
  const granularity = intParam(url.searchParams.get('granularity'), 60, 86400);
  const limit = intParam(url.searchParams.get('limit'), 120, CANDLE_LIMIT_MAX);
  try {
    const load = await loadCandles(ctx, product, granularity, limit);
    // Body is Candle[] per the contract; the staleness marker the chart region
    // needs rides in headers so the body shape stays exactly what was specified.
    const body = JSON.stringify(load.candles);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-candle-source': load.source,
      'x-candle-stale': String(load.stale),
      'x-candle-fetched-at': load.fetchedAt,
      'x-candle-built': load.built,
    });
    res.end(body);
  } catch (err) {
    fail(res, 502, errText(err));
  }
}

// ---------- chart ----------

/* The custom indicator loader, when the app has one. It is the custom indicators unit's and
   sits on the context under this name; a server built without it (every chart test, and any
   install with an empty indicators folder) has none, and every `custom:<slug>` is then refused
   by name. Read structurally so this file does not have to know the loader's whole shape. */
type CustomIndicators = { get(slug: string): IndicatorSpec | null; refresh?(): unknown };

export function customIndicatorsOf(ctx: Ctx): CustomIndicators | null {
  const held = (ctx as { customIndicators?: unknown }).customIndicators;
  if (held === null || typeof held !== 'object') return null;
  const c = held as Partial<CustomIndicators>;
  return typeof c.get === 'function' ? (c as CustomIndicators) : null;
}

const CUSTOM_SLUG = /^[a-z0-9-]{1,32}$/;

// One resolver for every indicator type the chart can carry: the catalogue's own, then a
// `custom:<slug>` through the loader's map and nothing else. The slug never joins a path;
// an unknown one is undefined, which every caller turns into "unknown indicator" by name.
export function resolveIndicator(ctx: Ctx, type: string): IndicatorSpec | undefined {
  const key = type.toLowerCase().trim();
  const builtIn = indicatorSpec(key);
  if (builtIn !== undefined) return builtIn;
  if (!key.startsWith('custom:')) return undefined;
  const slug = key.slice('custom:'.length);
  if (!CUSTOM_SLUG.test(slug)) return undefined;
  return customIndicatorsOf(ctx)?.get(slug) ?? undefined;
}

function computeIndicators(
  ctx: Ctx,
  state: ChartState,
  series: Candle[],
): { indicator: ChartIndicator; result: IndicatorResult }[] {
  const out: { indicator: ChartIndicator; result: IndicatorResult }[] = [];
  for (const indicator of state.indicators) {
    const spec = resolveIndicator(ctx, indicator.type);
    if (spec === undefined) continue;
    out.push({ indicator, result: spec.compute(series, indicator.params) });
  }
  return out;
}

function lastOf(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

export type ChartDigest = {
  chart: number;
  product: string;
  timeframe: string;
  bars: number;
  last: number | null;
  indicators: { id: string; type: string; last: Record<string, number | null>; state: string }[];
  counts: { levels: number; marks: number; lines: number; zones: number; plans: number };
  refused: string[];
};

// What a write answers with: the chart in a few hundred bytes. Every write used to answer with
// the whole read, and the read grew to four kilobytes with a preset on the chart, so an agent
// laying out a markup paid for the same chart again on every call. The digest is the part a
// writer actually reads back: what is on the chart now and what was refused.
export async function chartDigest(ctx: Ctx, slot: ChartSlot): Promise<ChartDigest> {
  const chart = slot.store;
  const state = chart.state();
  const view = state.view;
  let candles: Candle[] = [];
  try {
    candles = (await loadCandles(ctx, view.product, view.granularitySec, chart.historyNeeded(), view.provider)).candles;
  } catch {
    // A venue that will not answer leaves the digest without a last price. The counts and the
    // refusals are still the answer to the write that was made.
  }
  const newest = candles.length > 0 ? (candles[candles.length - 1] as Candle) : null;
  const drawings = slot.drawings.list();
  return {
    chart: slot.index,
    product: view.product,
    timeframe: timeframeLabel(view.granularitySec),
    bars: candles.length,
    last: newest === null ? null : newest.c,
    indicators: computeIndicators(ctx, state, candles).map(({ indicator, result }) => ({
      id: indicator.id,
      type: indicator.type,
      last: Object.fromEntries(result.plots.map((plot) => [plot.key, lastOf(plot.values)])),
      state: result.state,
    })),
    counts: {
      levels: state.levels.length,
      marks: state.marks.length,
      lines: drawings.filter((d) => d.kind === 'trendline').length,
      zones: drawings.filter((d) => d.kind === 'zone').length,
      plans: plansOnChart(ctx, view.product),
    },
    refused: [],
  };
}

// How many plans are drawn on this chart, read off the trading payload. Guarded: the plan store
// is the execution unit's and a server built without one has no plans at all.
function plansOnChart(ctx: Ctx, product: string): number {
  const coin = product.split('-')[0]?.toUpperCase() ?? '';
  let payload: unknown;
  try {
    payload = ctx.trade.payload();
  } catch {
    return 0;
  }
  const plans = (payload as { plans?: unknown } | null)?.plans;
  if (!Array.isArray(plans)) return 0;
  return plans.filter((p) => p !== null && typeof p === 'object' && String((p as { symbol?: unknown }).symbol ?? '').toUpperCase() === coin).length;
}

// Everything the renderer needs in one round trip: the view, the candles, and every
// indicator series already computed. The browser draws plots generically and never has to
// know what an RSI is, which is what keeps the two sides from disagreeing.
//
// `slot` picks which of the charts: 0 is the primary and the default, 1 to 3 are the
// comparison charts a layout put up. A slot no layout has filled answers null, and the route
// turns that into a 404 rather than drawing the primary under another chart's name.
export function chartPayload(ctx: Ctx, slot = 0): unknown | null {
  const held = ctx.charts.slot(slot);
  if (held === null) return null;
  const chart = held.store;
  const state = chart.state();
  // Memory only, and it cannot throw: an outage shows the last good candles marked stale
  // rather than an empty chart. This is the render path, so nothing here may await.
  const load = readCandles(ctx, state.view.product, state.view.granularitySec, chart.historyNeeded(), state.view.provider);
  /* This was `const error: string | null = null` and had been since the render path stopped
     awaiting: a field whose only possible value was "nothing is wrong". It now carries the one
     failure this synchronous path CAN see, which is nothing on screen and nothing on the way.
     The field stays rather than going because the browser writes its own fetch failures into it
     (ui/chart/chart.js) and a good payload arriving is what clears them. */
  const error =
    load.candles.length === 0 && !load.filling
      ? `no candles for ${state.view.product} at ${String(state.view.granularitySec)}s, and none are being fetched`
      : null;
  const computed = computeIndicators(ctx, state, load.candles);
  return {
    slot,
    rev: state.rev,
    lastDriver: state.lastDriver,
    view: state.view,
    candles: load.candles,
    meta: {
      source: load.source,
      stale: load.stale,
      built: load.built,
      fetchedAt: load.fetchedAt,
      filling: load.filling,
      feed: load.feed,
      note: load.note,
      error,
    },
    indicators: computed.map(({ indicator, result }) => ({
      id: indicator.id,
      type: indicator.type,
      label: indicator.label,
      pane: indicator.pane,
      source: indicator.source,
      plots: result.plots,
      guides: result.guides,
      range: result.range,
      state: result.state,
    })),
    levels: state.levels,
    marks: state.marks,
    // Trend lines and zones live in their own store beside the chart's levels and marks.
    // They reach the browser on the same payload so the human sees exactly the objects
    // the agent is measuring against, which is the whole point of drawing them there.
    drawings: held.drawings.list(),
    agentObjects: chart.agentObjects() + held.drawings.list().filter((d) => d.source === 'agent').length,
    products: ctx.cfg.candleProducts,
    timeframes: TIMEFRAMES,
    limits: CHART_LIMITS,
  };
}

// The agent's view of the same thing: no arrays of pixels, every number in context.
/* `by` is the session asking, and it is what makes the housekeeping block answer the question
   an agent actually has. "Nine agent objects are on this chart" is not actionable; "three are
   yours, six are somebody else's, clear yours with chart_draw clear:'mine'" is. The browser
   reads this too and passes nothing, which is correct: a human's chart read has no `mine`.

   Compact by default and `full` on request: the compact shape is what a reader acts on, and it
   is a quarter of the size. `slot` picks one of the charts; absent is the primary. */
export async function chartRead(ctx: Ctx, by?: string | null, opts: { slot?: ChartSlot; full?: boolean } = {}): Promise<unknown> {
  const slot = opts.slot ?? ctx.charts.primary;
  const chart = slot.store;
  const state = chart.state();
  try {
    const load = await loadCandles(ctx, state.view.product, state.view.granularitySec, chart.historyNeeded(), state.view.provider);
    const args = {
      state,
      candles: load.candles,
      meta: { source: load.source, stale: load.stale, built: load.built },
      computed: computeIndicators(ctx, state, load.candles),
      nowSec: Math.floor(Date.now() / 1000),
      housekeeping: chart.housekeeping(by, slot.drawings.list()),
      drawings: slot.drawings.list(),
    };
    return opts.full === true ? buildRead(args) : buildCompactRead({ ...args, chart: slot.index });
  } catch (err) {
    return {
      error: errText(err),
      chart: slot.index,
      product: state.view.product,
      timeframe: timeframeLabel(state.view.granularitySec),
      rev: state.rev,
    };
  }
}

// The browser's own pan and zoom coming home. It carries the approval token like every
// other browser write, not because a view change is dangerous, but so there stays exactly
// one door per caller: the window uses this, an agent uses /api/mcp.
export async function handleChartWrite(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await readBody(req);
  if (!parsed.ok) return fail(res, parsed.status, parsed.error);
  const body = parsed.value;
  if (!sameOrigin(req)) return fail(res, 403, 'cross-origin chart write refused');
  if (!tokenMatches(body.token, ctx.token)) return fail(res, 403, 'invalid approval token');

  if (body.geometry !== null && typeof body.geometry === 'object') {
    ctx.chart.setGeometry(body.geometry as ChartGeometry);
  }
  let notes: string[] = [];
  if (body.view !== null && typeof body.view === 'object') {
    const patch = body.view as JsonBody;
    const refusal = resolveViewPatch(ctx, patch, false);
    if (refusal !== null) return fail(res, 400, refusal);
    const outcome = ctx.chart.setView(patch, 'human');
    if (!outcome.ok) return fail(res, 400, outcome.error);
    notes = outcome.notes;
  }
  // The window's own command line. The human gets the same vocabulary as the agent, so
  // the chart is not a surface only an agent can change.
  if (body.addIndicator !== null && typeof body.addIndicator === 'object') {
    const asked = body.addIndicator as Record<string, unknown>;
    const outcome = ctx.chart.addIndicator(asked, 'human', null, resolveIndicator(ctx, String(asked.type ?? '')));
    if (!outcome.ok) return fail(res, 400, outcome.error, { notes: outcome.notes });
    notes = notes.concat(outcome.notes);
  }
  if (typeof body.removeIndicator === 'string') {
    const outcome = ctx.chart.removeIndicator(body.removeIndicator);
    if (!outcome.ok) return fail(res, 400, outcome.error);
  }
  if (typeof body.clear === 'string') {
    const outcome = ctx.chart.clear(body.clear);
    if (!outcome.ok) return fail(res, 400, outcome.error);
  }
  ctx.sse.broadcastChart();
  // The resulting view goes back with the answer. The window applies it from here rather
  // than from a refresh, because a refresh it fired itself can land before this write does
  // and snap the gesture the human just made back to where it started.
  sendJson(res, 200, { ok: true, rev: ctx.chart.rev(), view: ctx.chart.state().view, notes });
}

/* The window's answer to a snapshot frame: { token, reqId, jpeg }, the image as base64.

   The same three gates as every window write (loopback host at the router, same origin, the
   window token), and a cap of its own well under the server's general megabyte, checked on the
   announced length before a byte is read and again on what arrived, because a chunked post
   announces nothing. The bytes go to the broker, which hands them to the one tool call waiting
   on that id and keeps nothing: an answer for a request nobody is waiting on is a 409, not a
   picture kept for the next caller. */
export async function handleSnapshotDelivery(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const announced = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(announced) && announced > SNAPSHOT_MAX_BYTES + 4096) {
    req.resume();
    return fail(res, 413, `a snapshot is at most ${SNAPSHOT_MAX_BYTES} bytes`);
  }
  const parsed = await readBody(req);
  if (!parsed.ok) return fail(res, parsed.status, parsed.error);
  const body = parsed.value;
  if (!sameOrigin(req)) return fail(res, 403, 'cross-origin snapshot refused');
  if (!tokenMatches(body.token, ctx.token)) return fail(res, 403, 'invalid approval token');

  const reqId = typeof body.reqId === 'string' ? body.reqId : '';
  const jpeg = typeof body.jpeg === 'string' ? body.jpeg : '';
  if (jpeg.length > SNAPSHOT_MAX_BYTES) return fail(res, 413, `a snapshot is at most ${SNAPSHOT_MAX_BYTES} bytes`);
  // A JPEG and nothing else: the bytes go straight to a model as an image block, so the route
  // says no to anything that is not the one format the window encodes.
  const head = Buffer.from(jpeg.slice(0, 8), 'base64');
  if (!/^[A-Za-z0-9+/=]+$/.test(jpeg) || head.length < 3 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) {
    return fail(res, 400, 'the snapshot must be a base64 JPEG');
  }
  if (!ctx.snapshots.deliver(reqId, jpeg)) return fail(res, 409, 'no snapshot is waiting for that request id');
  sendJson(res, 200, { ok: true });
}

/* Resolve the product a view patch names against the venue that patch lands on, in place.
   Returns null when the patch is servable and the reason when it is not.

   Both doors call it. An agent's chart_set_view and the window's own click are the same
   change, and a refusal that only one of them got would mean the human can pin a venue
   into a blank chart that the agent is told it cannot pin into.

   The venue moves first because the product is resolved against it: "put SOL on coinbase"
   has to either work or say why, rather than resolving SOL the way the catalogue prefers
   and then charting Hyperliquid's perp under Coinbase's name. */
export function resolveViewPatch(ctx: Ctx, patch: JsonBody, requireListed: boolean, chart: ChartStore = ctx.chart): string | null {
  const asked = typeof patch.product === 'string' ? patch.product.trim() : '';
  const wantRaw =
    patch.provider === undefined ? chart.state().view.provider : String(patch.provider).trim().toLowerCase();
  const want: ProviderChoice = PROVIDER_CHOICES.includes(wantRaw as ProviderChoice)
    ? (wantRaw as ProviderChoice)
    : 'auto';

  if (asked !== '') {
    const ref = want === 'auto' ? ctx.market.resolve(asked) : ctx.market.resolveOn(asked, want);
    if (ref === null) {
      // `requireListed` is the difference between the two doors, and it is not a
      // relaxation of the rule for the window: it is the rule the window already had.
      //
      // An agent NAMES a market, so an unlisted name is a typo to answer. The window
      // pushes the whole view on every pan, so the product on it is the one the window is
      // already drawing, and refusing it because the catalogue is cold or has not heard of
      // an id from config.json would freeze the human's pan and zoom on a chart that is
      // working. A pinned venue is still refused on both, because that IS the new choice
      // being made and it is the one thing that can silently swap markets.
      if (want !== 'auto') return `${want} does not list ${asked}`;
      if (!requireListed) return null;
      const near = ctx.market.search(asked, 5).map((m) => m.product);
      const hint = near.length > 0 ? ` did you mean: ${near.join(', ')}` : '';
      return `no market listed for "${asked}".${hint}`;
    }
    patch.product = ref.product;
    return null;
  }

  // A venue change with no product named still has to be answerable on the product already
  // on screen, and the same refusal applies: pin it anyway and the chart goes blank with
  // nothing saying why.
  if (want !== 'auto') {
    const current = chart.state().view.product;
    if (ctx.market.resolveOn(current, want) === null) {
      return `${want} does not list ${current}. name a product it does list, or set the venue back to auto`;
    }
  }
  return null;
}
