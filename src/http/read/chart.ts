// The chart reads: the agent's view of what the human is looking at, a batch of analysis ops
// over it, the indicator grammar, one measurement, and a scan across timeframes.

import {
  digestSeries,
  LIMITS as CHART_LIMITS,
  measure as measureChart,
  resolveScanTimeframe,
  TIMEFRAMES,
  timeframeLabel,
} from '../../chart.ts';
import { indicatorCatalog } from '../../indicators.ts';
import { runBatch } from '../../batch.ts';
import { analysisHandlers } from '../../analysis/index.ts';
import { errText, fail, intParam, sendJson } from '../respond.ts';
import { chartRead, loadCandles, numOrUndefined } from '../chart.ts';
import { CANDLE_LIMIT_MAX, SCAN_TIMEFRAMES_MAX } from '../context.ts';
import type { ReadTable } from '../context.ts';

export const chartReads: ReadTable = {
  chart_read: async (ctx, body, _args, res) => {
    sendJson(res, 200, await chartRead(ctx, String(body.session ?? '') || null));
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
        history: ctx.history,
        drawings: ctx.drawings,
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
  indicator_catalog: (_ctx, _body, _args, res) => {
    sendJson(res, 200, {
      indicators: indicatorCatalog(),
      limits: {
        overlaysOnPrice: CHART_LIMITS.maxOverlays,
        subPanes: CHART_LIMITS.maxPanes,
        note: 'A sub-pane request past the maximum is refused with the reason, never squeezed in.',
      },
      timeframes: TIMEFRAMES.map((tf) => tf.label),
    });
  },
  chart_measure: async (ctx, _body, args, res) => {
    const view = ctx.chart.state().view;
    try {
      const load = await loadCandles(ctx, view.product, view.granularitySec, ctx.chart.historyNeeded(), view.provider);
      sendJson(res, 200, {
        product: view.product,
        timeframe: timeframeLabel(view.granularitySec),
        ...(measureChart({
          candles: load.candles,
          granularitySec: view.granularitySec,
          fromTime: numOrUndefined(args.fromTime),
          toTime: numOrUndefined(args.toTime),
          fromPrice: numOrUndefined(args.fromPrice),
          toPrice: numOrUndefined(args.toPrice),
        }) as Record<string, unknown>),
      });
    } catch (err) {
      fail(res, 502, errText(err));
    }
  },
  chart_scan: async (ctx, _body, args, res) => {
    const view = ctx.chart.state().view;
    const product = typeof args.product === 'string' && args.product.trim().length > 0 ? args.product.trim().toUpperCase() : view.product;
    const asked = Array.isArray(args.timeframes) ? args.timeframes : ['5m', '15m', '1h', '4h', '1d'];
    // TIMEFRAMES is the button bar (1m to 1d), not the set of legal timeframes. Matching only
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
    const rows: unknown[] = [];
    for (const step of plan) {
      if ('bad' in step) {
        rows.push({
          timeframe: step.bad,
          error: `${step.bad} is not a timeframe. Use <count><unit> with unit m, h, d or w, from 1m up to 1w.`,
        });
        continue;
      }
      const sec = step.sec;
      try {
        const load = await loadCandles(ctx, product, sec, bars);
        rows.push({ ...digestSeries(load.candles, sec, nowSec), source: load.source, stale: load.stale });
      } catch (err) {
        rows.push({ timeframe: timeframeLabel(sec), granularitySec: sec, error: errText(err) });
      }
    }
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
