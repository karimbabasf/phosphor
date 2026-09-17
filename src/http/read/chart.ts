// The chart reads: the agent's view of what the human is looking at, a batch of analysis ops
// over it, a picture of it, and a scan across timeframes.

import { digestSeries, resolveScanTimeframe, timeframeLabel } from '../../chart.ts';
import { runBatch } from '../../batch.ts';
import { analysisHandlers } from '../../analysis/index.ts';
import { errText, fail, intParam, sendJson } from '../respond.ts';
import { chartDigest, chartRead, customIndicatorsOf, loadCandles, resolveIndicator } from '../chart.ts';
import type { ChartDigest } from '../chart.ts';
import { slotOf } from '../view.ts';
import { SNAPSHOT_TTL_MS } from '../../snapshot.ts';
import { CANDLE_LIMIT_MAX, SCAN_TIMEFRAMES_MAX } from '../context.ts';
import type { ReadTable } from '../context.ts';

export const chartReads: ReadTable = {
  // Compact by default; `full: true` is the old shape. `chart` picks one of the charts a layout
  // put up, and a slot nothing filled is refused by name rather than answered with the primary.
  chart_read: async (ctx, body, args, res) => {
    const found = slotOf(ctx, args.chart);
    if (!found.ok) return fail(res, 400, found.error);
    sendJson(res, 200, await chartRead(ctx, String(body.session ?? '') || null, { slot: found.slot, full: args.full === true }));
  },
  chart_batch: async (ctx, body, args, res) => {
    const ops = Array.isArray(args.ops) ? args.ops : [];
    const view = ctx.chart.state().view;
    const results = await runBatch(
      ops as { op: string; args?: Record<string, unknown>; as?: string }[],
      analysisHandlers({
        // The chart's own product and timeframe are the defaults, so an op that names
        // neither measures what the human is currently looking at.
        candles: async (product, granularitySec, limit) =>
          (
            await loadCandles(
              ctx,
              product || view.product,
              granularitySec,
              limit,
              // Only the chart's own instrument follows the chart's pinned venue. An op
              // that names a different product is a question about that product, and
              // pinning it to a venue the caller never chose would answer a different one.
              product === '' || product === view.product ? view.provider : 'auto',
            )
          ).candles,
        drawings: ctx.drawings,
        // The same resolver the chart draws with, so a custom indicator reads here the way it
        // draws there, and indicator_list can rescan the folder it came from.
        indicator: (type) => resolveIndicator(ctx, type),
        customIndicators: customLoader(ctx),
        // Who is asking, and what they are looking at. Anything this batch draws is stamped
        // with it, which is what lets `chart_clear what:'mine'` and the product sweep reach
        // a zone the same way they reach a level.
        author: {
          by: String(body.session ?? '') || null,
          product: view.product,
          granularitySec: view.granularitySec,
        },
      }),
    );
    // A drawing op changes what the window shows, so the browser is told the same way a
    // chart mutation tells it. Reads alone leave the rev alone and repaint nothing.
    if (results.some((r) => r.ok && r.op.startsWith('draw'))) ctx.sse.broadcastChart();
    sendJson(res, 200, {
      product: view.product,
      timeframe: timeframeLabel(view.granularitySec),
      results,
    });
  },
  /* A picture of one chart, as the human sees it, in one small image. The window renders scene
     and hud to a JPEG at most 1024 px wide and posts it back; the broker hands it to this call.
     The image rides beside a one-line digest, and when there is no picture to be had (no window,
     the window on another screen, or one that did not answer in time) the digest alone comes
     back and says which. Asking a window that is not on the trade screen would wait the whole
     TTL for nothing, so that case is answered without asking. */
  chart_snapshot: async (ctx, _body, args, res) => {
    const found = slotOf(ctx, args.chart);
    if (!found.ok) return fail(res, 400, found.error);
    const { slot } = found;
    const digest = digestLine(await chartDigest(ctx, slot));
    const view = ctx.getView();
    if (view !== 'trade') {
      return sendJson(res, 200, { digest: `${digest}. No picture: the window is not on the trade screen (it is on ${view}); switch puts it there` });
    }
    if (ctx.sse.clientCount() === 0) {
      return sendJson(res, 200, { digest: `${digest}. No picture: no window is open` });
    }
    if (ctx.snapshots.pending(slot.index)) {
      return fail(res, 409, `a snapshot of chart ${slot.index} is already being taken`);
    }
    const got = await ctx.snapshots.request(slot.index, SNAPSHOT_TTL_MS);
    if (got === null) {
      return sendJson(res, 200, { digest: `${digest}. No picture: the window did not answer within ${SNAPSHOT_TTL_MS / 1000} s` });
    }
    sendJson(res, 200, { image: got.jpegBase64, mimeType: 'image/jpeg', digest });
  },
  chart_scan: async (ctx, _body, args, res) => {
    const view = ctx.chart.state().view;
    const product = typeof args.product === 'string' && args.product.trim().length > 0 ? args.product.trim().toUpperCase() : view.product;
    const asked = Array.isArray(args.timeframes) ? args.timeframes : ['5m', '15m', '1h', '4h', '1d'];
    // TIMEFRAMES is the button bar (1m to 1M), not the set of legal timeframes. Matching only
    // against it and then snapping the miss meant `1w` fell to snapTimeframe(Number('1w')),
    // and Number('1w') is NaN, so every comparison in the snap was false and it returned the
    // FIRST entry: 1m. A weekly scan silently answered with a minute chart, labelled as if
    // that was what had been asked for. parseTimeframe is what chart_set_view already uses and
    // it handles 1w, 7d, 90m and bare seconds. An entry it cannot read is now refused by name
    // rather than substituted, because a wrong answer that looks right is the worst outcome
    // here: nothing downstream can tell that the bias timeframe was never read.
    const plan: ({ sec: number } | { bad: string })[] = [];
    for (const entry of asked.slice(0, SCAN_TIMEFRAMES_MAX)) {
      const sec = resolveScanTimeframe(entry as string | number);
      plan.push(sec === null ? { bad: String(entry) } : { sec });
    }
    const bars = intParam(args.bars, 120, CANDLE_LIMIT_MAX);
    const nowSec = Math.floor(Date.now() / 1000);
    // Every timeframe at once. They used to load one after another, so a cold scan of five
    // timeframes was five venue round trips in series; the fills are independent and the cache
    // already collapses two asks for one series into one call.
    const rows: unknown[] = await Promise.all(
      plan.map(async (step) => {
        if ('bad' in step) {
          return {
            timeframe: step.bad,
            error: `${step.bad} is not a timeframe. Use <count><unit> with unit m, h, d or w, from 1m up to 1w.`,
          };
        }
        const sec = step.sec;
        try {
          const load = await loadCandles(ctx, product, sec, bars);
          return { ...digestSeries(load.candles, sec, nowSec), source: load.source, stale: load.stale };
        } catch (err) {
          return { timeframe: timeframeLabel(sec), granularitySec: sec, error: errText(err) };
        }
      }),
    );
    sendJson(res, 200, {
      product,
      scannedAt: new Date(nowSec * 1000).toISOString(),
      barsPerTimeframe: bars,
      // Deliberately does not touch the view: a scan is a question, not a instruction to
      // move the chart the human is looking at.
      chartUnchanged: true,
      timeframes: rows,
    });
  },
};

// One line under the picture, so the image block is never the only thing in the answer.
function digestLine(d: ChartDigest): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [
    `${d.product} ${d.timeframe}`,
    `${d.bars} bars`,
    d.last === null ? 'no last price' : `last ${String(d.last)}`,
    plural(d.indicators.length, 'indicator'),
    plural(d.counts.levels, 'level'),
    plural(d.counts.marks, 'mark'),
    plural(d.counts.lines, 'line'),
    plural(d.counts.zones, 'zone'),
  ];
  if (d.counts.plans > 0) parts.push(plural(d.counts.plans, 'plan'));
  return `chart ${d.chart}: ${parts.join(', ')}`;
}

// The custom indicator loader as the op table wants it: refresh and specs, or nothing. The
// loader is optional on the context (see customIndicatorsOf) and the op table is built without
// it when either half is missing, so a partial loader never reaches indicator_list.
function customLoader(ctx: Parameters<typeof customIndicatorsOf>[0]): { refresh(): unknown; specs(): import('../../indicators.ts').IndicatorSpec[] } | undefined {
  const held = customIndicatorsOf(ctx) as { refresh?: () => unknown; specs?: () => import('../../indicators.ts').IndicatorSpec[] } | null;
  if (held === null || typeof held.refresh !== 'function' || typeof held.specs !== 'function') return undefined;
  return { refresh: () => held.refresh?.(), specs: () => held.specs?.() ?? [] };
}
