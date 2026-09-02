// Every candle surface and the chart the human is looking at: the price cache behind the basic
// screen, the two candle loaders, the render payload, the agent's read of the same thing, and
// the window's own pan and zoom coming home.

import type http from 'node:http';

import type { Candle } from '../types.ts';
import type { PriceReading } from '../view/basic.ts';
import { buildRead, LIMITS as CHART_LIMITS, TIMEFRAMES, timeframeLabel } from '../chart.ts';
import type { ChartGeometry, ChartIndicator, ChartState, ProviderChoice } from '../chart.ts';
import { PROVIDER_CHOICES } from '../chart.ts';
import { indicatorSpec } from '../indicators.ts';
import type { IndicatorResult } from '../indicators.ts';
import { sameOrigin, tokenMatches } from './auth.ts';
import { errText, fail, intParam, readBody, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { CANDLE_LIMIT_MAX } from './context.ts';
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
  } catch {
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

export type CandleLoad = {
  candles: Candle[];
  source: string;
  stale: boolean;
  built: string;
  fetchedAt: string;
  // True while the window behind this read is still being filled, so the chart can say
  // "filling" rather than showing a short series as though it were the whole story.
  filling: boolean;
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
export function readCandles(
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

export function computeIndicators(
  state: ChartState,
  series: Candle[],
): { indicator: ChartIndicator; result: IndicatorResult }[] {
  const out: { indicator: ChartIndicator; result: IndicatorResult }[] = [];
  for (const indicator of state.indicators) {
    const spec = indicatorSpec(indicator.type);
    if (spec === undefined) continue;
    out.push({ indicator, result: spec.compute(series, indicator.params) });
  }
  return out;
}

// Everything the renderer needs in one round trip: the view, the candles, and every
// indicator series already computed. The browser draws plots generically and never has to
// know what an RSI is, which is what keeps the two sides from disagreeing.
export function chartPayload(ctx: Ctx): unknown {
  const state = ctx.chart.state();
  // Memory only, and it cannot throw: an outage shows the last good candles marked stale
  // rather than an empty chart. This is the render path, so nothing here may await.
  const load = readCandles(ctx, state.view.product, state.view.granularitySec, ctx.chart.historyNeeded(), state.view.provider);
  const error: string | null = null;
  const computed = computeIndicators(state, load.candles);
  return {
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
    drawings: ctx.drawings.list(),
    agentObjects: ctx.chart.agentObjects() + ctx.drawings.list().filter((d) => d.source === 'agent').length,
    products: ctx.cfg.candleProducts,
    timeframes: TIMEFRAMES,
    limits: CHART_LIMITS,
  };
}

// The agent's view of the same thing: no arrays of pixels, every number in context.
/* `by` is the session asking, and it is what makes the housekeeping block answer the question
   an agent actually has. "Nine agent objects are on this chart" is not actionable; "three are
   yours, six are somebody else's, clear yours with chart_clear what:'mine'" is. The browser
   reads this too and passes nothing, which is correct: a human's chart read has no `mine`. */
export async function chartRead(ctx: Ctx, by?: string | null): Promise<unknown> {
  const state = ctx.chart.state();
  try {
    const load = await loadCandles(ctx, state.view.product, state.view.granularitySec, ctx.chart.historyNeeded(), state.view.provider);
    return buildRead({
      state,
      candles: load.candles,
      meta: { source: load.source, stale: load.stale, built: load.built },
      computed: computeIndicators(state, load.candles),
      nowSec: Math.floor(Date.now() / 1000),
      housekeeping: ctx.chart.housekeeping(by),
    });
  } catch (err) {
    return {
      error: errText(err),
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
  if (!parsed.ok) return fail(res, 400, parsed.error);
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
    const outcome = ctx.chart.addIndicator(body.addIndicator as Record<string, unknown>, 'human');
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

export function numOrUndefined(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/* Resolve the product a view patch names against the venue that patch lands on, in place.
   Returns null when the patch is servable and the reason when it is not.

   Both doors call it. An agent's chart_set_view and the window's own click are the same
   change, and a refusal that only one of them got would mean the human can pin a venue
   into a blank chart that the agent is told it cannot pin into.

   The venue moves first because the product is resolved against it: "put SOL on coinbase"
   has to either work or say why, rather than resolving SOL the way the catalogue prefers
   and then charting Hyperliquid's perp under Coinbase's name. */
export function resolveViewPatch(ctx: Ctx, patch: JsonBody, requireListed: boolean): string | null {
  const asked = typeof patch.product === 'string' ? patch.product.trim() : '';
  const wantRaw =
    patch.provider === undefined ? ctx.chart.state().view.provider : String(patch.provider).trim().toLowerCase();
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
    const current = ctx.chart.state().view.product;
    if (ctx.market.resolveOn(current, want) === null) {
      return `${want} does not list ${current}. name a product it does list, or set the venue back to auto`;
    }
  }
  return null;
}
