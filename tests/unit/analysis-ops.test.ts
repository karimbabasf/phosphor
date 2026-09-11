import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisHandlers } from '../../src/analysis/index.ts';
import { createDrawingStore } from '../../src/drawings.ts';
import { createHistory } from '../../src/history.ts';
import { runBatch } from '../../src/batch.ts';
import { indicatorSpec } from '../../src/indicators.ts';
import type { IndicatorSpec } from '../../src/indicators.ts';
import type { Candle } from '../../src/types.ts';

function fixture(): Candle[] {
  // Enough bars for an indicator with a 14 period to produce values.
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 10 + i * 0.1);
  return closes.map((c, i) => ({ t: 1000 + i * 60, o: c, h: c + 1, l: c - 1, c, v: 10 + (i % 5) }));
}

function deps() {
  const candles = fixture();
  return {
    candles: async () => candles,
    history: createHistory(async () => candles),
    drawings: createDrawingStore(),
  };
}

test('exposes every primitive as a named op', () => {
  const h = analysisHandlers(deps());
  for (const name of [
    'candles',
    'history_page',
    'pivots',
    'levels',
    'regime',
    'atr',
    'volume_profile',
    'vwap',
    'range',
    'divergence',
    'indicator_series',
    'trendline_fit',
    'trendline_at',
    'trendline_touches',
    'draw',
    'drawings_list',
    'drawings_remove',
    'drawings_clear',
  ]) {
    assert.ok(name in h, `missing op ${name}`);
  }
});

test('draw then measure against the drawn line in one batch', async () => {
  const h = analysisHandlers(deps());
  const out = await runBatch(
    [
      { op: 'pivots', args: { window: 2, minProminence: 1 }, as: 'p' },
      {
        op: 'draw',
        args: { kind: 'trendline', label: 'support', a: { t: 1000, price: 90 }, b: { t: 1600, price: 95 } },
        as: 'line',
      },
      { op: 'trendline_at', args: { id: '$ref:line.id', t: 2000 } },
      { op: 'trendline_touches', args: { id: '$ref:line.id', tolerance: 5 } },
    ],
    h,
  );
  assert.ok(out.every((r) => r.ok), JSON.stringify(out.filter((r) => !r.ok)));
  assert.equal(typeof (out[2].ok && out[2].value), 'number');
  assert.ok(Array.isArray(out[3].ok && out[3].value));
});

test('an unknown drawing id fails loudly rather than silently', async () => {
  const h = analysisHandlers(deps());
  const out = await runBatch([{ op: 'trendline_at', args: { id: 'tl_99', t: 1 } }], h);
  assert.equal(out[0].ok, false);
  assert.match(out[0].ok === false ? out[0].error : '', /unknown drawing/);
});

test('every parameterised result echoes its parameters', async () => {
  const h = analysisHandlers(deps());
  const r = (await h.regime({ period: 5, lookback: 30 }, {})) as { period: number; lookback: number };
  assert.equal(r.period, 5);
  assert.equal(r.lookback, 30);

  const p = (await h.volume_profile({ bins: 12, valueAreaPct: 0.68 }, {})) as {
    valueAreaPct: number;
    basis: string;
  };
  assert.equal(p.valueAreaPct, 0.68);
  assert.equal(p.basis, 'volume');
});

test('clearing defaults to the agent drawings and leaves the human alone', async () => {
  const d = deps();
  d.drawings.add({
    kind: 'trendline',
    label: 'mine',
    source: 'human',
    line: { a: { t: 0, price: 1 }, b: { t: 1, price: 2 } },
  });
  const h = analysisHandlers(d);
  await h.draw({ kind: 'trendline', a: { t: 0, price: 1 }, b: { t: 1, price: 2 } }, {});
  await h.drawings_clear({}, {});
  assert.deepEqual(d.drawings.list().map((x) => x.label), ['mine']);
});

test('no op returns a signal, score or recommendation field', async () => {
  const h = analysisHandlers(deps());
  const results = await runBatch(
    [
      { op: 'pivots', args: { window: 2, minProminence: 1 } },
      { op: 'regime', args: { period: 5, lookback: 30 } },
      { op: 'range', args: { lookback: 40, maxEfficiency: 0.9 } },
      { op: 'levels', args: { window: 2, minProminence: 1, tolerance: 2 } },
      { op: 'volume_profile', args: { bins: 10, valueAreaPct: 0.7 } },
      { op: 'divergence', args: { indicator: 'rsi', window: 2, minProminence: 1 } },
    ],
    h,
  );
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));

  const banned = ['signal', 'score', 'recommendation', 'action', 'confidence', 'rating', 'advice'];
  const text = JSON.stringify(results).toLowerCase();
  for (const word of banned) {
    assert.ok(
      !text.includes(`"${word}"`),
      `analysis returned a ${word} field, which is a conclusion and not a measurement`,
    );
  }
});

// Series-returning ops carry the tail of the series by default. An ATR over 400 bars was
// 7 KB of numbers where the model wanted one, and the candles op was 29 KB; every turn after
// that paid for them again. Twenty is enough to see the last few bars turn; `full: true` is
// the whole thing for the call that means it.
test('series ops answer with the last twenty values unless told otherwise', async () => {
  const h = analysisHandlers(deps());
  const candles = (await h.candles({}, {})) as unknown[];
  assert.equal(candles.length, 20);
  const five = (await h.candles({ tail: 5 }, {})) as { t: number }[];
  assert.equal(five.length, 5);
  assert.equal(five[4]?.t, 1000 + 79 * 60, 'the tail is the newest bars');
  const all = (await h.candles({ full: true }, {})) as unknown[];
  assert.equal(all.length, 80);

  const atr = (await h.atr({ period: 5 }, {})) as (number | null)[];
  assert.equal(atr.length, 20);
  assert.equal(typeof atr[19], 'number');
  const series = (await h.indicator_series({ indicator: 'rsi', full: true }, {})) as unknown[];
  assert.equal(series.length, 80);
  const pivots = (await h.pivots({ window: 1, minProminence: 0, tail: 3 }, {})) as unknown[];
  assert.ok(pivots.length <= 3);
  const line = (await h.draw({ kind: 'trendline', a: { t: 1000, price: 100 }, b: { t: 2000, price: 100 } }, {})) as { id: string };
  const touches = (await h.trendline_touches({ id: line.id, tolerance: 1000, tail: 4 }, {})) as unknown[];
  assert.equal(touches.length, 4, 'every bar touches a line with a thousand-point tolerance, and four come back');
});

test('an indicator type resolves through the resolver the caller hands in', async () => {
  const d = deps();
  const seen: string[] = [];
  const h = analysisHandlers({
    ...d,
    indicator: (type) => {
      seen.push(type);
      return indicatorSpec(type === 'custom:mine' ? 'rsi' : type);
    },
  });
  const read = (await h.indicator_read({ indicator: 'custom:mine' }, {})) as { indicator: string };
  assert.deepEqual(seen, ['custom:mine']);
  assert.equal(read.indicator, 'rsi', 'the resolver decided what custom:mine is');
});

test('indicator_list refreshes the custom loader and lists its specs beside the catalogue', async () => {
  let refreshed = 0;
  const h = analysisHandlers({
    ...deps(),
    customIndicators: {
      refresh: () => {
        refreshed += 1;
      },
      specs: () => [indicatorSpec('rsi') as IndicatorSpec].map((spec) => ({ ...spec, type: 'custom:mine', summary: 'a copy of rsi' })),
    },
  });
  const rows = (await h.indicator_list({}, {})) as { type: string; summary: string }[];
  assert.equal(refreshed, 1);
  assert.ok(rows.some((r) => r.type === 'rsi'));
  const mine = rows.find((r) => r.type === 'custom:mine');
  assert.equal(mine?.summary, 'a copy of rsi');
});

test('history pages through the op table', async () => {
  const h = analysisHandlers(deps());
  const page = (await h.history_page({ limit: 20 }, {})) as { candles: unknown[]; complete: boolean };
  assert.ok(Array.isArray(page.candles));
  assert.equal(typeof page.complete, 'boolean');
});
