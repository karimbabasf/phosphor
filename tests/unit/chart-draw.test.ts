// chart_draw: the whole markup in one call, one compact digest back.
//
// Ten write tools became one, and the reason is turns rather than bytes: every MCP call is a
// model turn of ten to twenty seconds, and the old skill spent four to eight of them on pure
// markup, each answered with a multi-kilobyte chart echo. These pin the shape of the one call:
// applied in a fixed order, a digest rather than the full read, refusals named in a list
// instead of failing the whole call, and `clear` scoped to the caller's own work.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';

const T0 = 1_760_000_000;

// Opens the window's own stream and hands back the next chart frame the server sends.
async function nextChartFrame(url: string): Promise<{ frame: Promise<{ rev: number; slot: number }>; close: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: controller.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const frame = (async () => {
    let buffered = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the stream closed before a chart frame');
      buffered += new TextDecoder().decode(value);
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const parsed = JSON.parse(line.slice(6)) as { type: string; rev?: number; slot?: number };
        if (parsed.type === 'chart') return { rev: parsed.rev as number, slot: parsed.slot as number };
      }
    }
  })();
  frame.catch(() => {});
  return { frame, close: () => controller.abort() };
}

test('a lines-only draw moves the revision, the chart frame carries it, and the payload agrees', async () => {
  // A line or a zone lives in the drawing store, which used to have no revision of its own: the
  // frame went out with the OLD rev, the window read it as its own echo and dropped it, and the
  // trend line waited for the next unrelated refetch. That wait is what "slow" meant.
  const h = await bootChartServer();
  const stream = await nextChartFrame(h.url);
  try {
    const before = (await h.get('/api/chart')).json.rev as number;
    const out = await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { lines: [{ t1: T0, p1: 1, t2: T0 + 60, p2: 2 }] } });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    const frame = await stream.frame;
    const after = (await h.get('/api/chart')).json;
    assert.ok(after.rev > before, `a lines-only draw moved the rev from ${before} to ${after.rev}`);
    assert.equal(frame.rev, after.rev, 'the frame carries the revision the payload now has');
    assert.equal(frame.slot, 0);
    assert.equal(after.lastDriver, 'agent');
  } finally {
    stream.close();
    await h.close();
  }
});

test('the markup part carries the drawing and the indicator series but no candles, and the full part still does', async () => {
  const h = await bootChartServer();
  try {
    await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { indicators: { preset: 'momentum' }, levels: [{ px: 100 }] } });
    const full = await h.get('/api/chart');
    assert.equal(full.status, 200);
    assert.ok(Array.isArray(full.json.candles) && full.json.candles.length > 0, 'the full part carries candles');
    assert.equal(typeof full.json.candlesRev, 'number');
    assert.equal(full.json.series.count, full.json.candles.length);
    assert.equal(full.json.series.first, full.json.candles[0].t);

    const markup = await h.get('/api/chart?part=markup');
    assert.equal(markup.status, 200);
    assert.equal(markup.json.candles, undefined, 'a markup refresh moves no candle bytes');
    assert.equal(markup.json.rev, full.json.rev);
    assert.equal(markup.json.candlesRev, full.json.candlesRev);
    assert.deepEqual(markup.json.series, full.json.series);
    assert.equal(markup.json.levels.length, 1);
    assert.equal(markup.json.indicators.length, 3);
    assert.ok(markup.json.indicators.every((i: { plots: { values: unknown[] }[] }) => i.plots.every((p) => p.values.length === full.json.series.count)));
    const bytes = Buffer.byteLength(JSON.stringify(markup.json));
    assert.ok(bytes < 60_000, `the markup part is ${bytes} bytes`);

    const bad = await h.get('/api/chart?part=nope');
    assert.equal(bad.status, 400);
  } finally {
    await h.close();
  }
});

test('one call sets the view, adds a preset, two levels, a line and a zone, and answers with a digest', async () => {
  const h = await bootChartServer();
  try {
    const out = await h.mcp({
      op: 'view',
      tool: 'chart_draw',
      session: 'a',
      args: {
        view: { product: 'eth', timeframe: '1h', bars: 150 },
        indicators: { preset: 'momentum' },
        levels: [{ px: 170, label: 'range high' }, { px: 150 }],
        lines: [{ t1: T0, p1: 150, t2: T0 + 3600, p2: 151, label: 'support' }],
        zones: [{ p1: 160, p2: 165, label: 'supply' }],
      },
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    const d = out.json;
    assert.equal(d.chart, 0);
    assert.equal(d.product, 'ETH-USD', 'the product resolved against the catalogue');
    assert.equal(d.timeframe, '1h');
    assert.ok(d.bars > 0);
    assert.equal(typeof d.last, 'number');
    assert.deepEqual(d.refused, []);
    assert.deepEqual(d.counts, { levels: 2, marks: 0, lines: 1, zones: 1, plans: 0 });
    assert.equal(d.indicators.length, 3, 'momentum is rsi, macd and stochrsi');
    for (const ind of d.indicators) {
      assert.equal(typeof ind.id, 'string');
      assert.equal(typeof ind.type, 'string');
      assert.equal(typeof ind.state, 'string');
      assert.ok(Object.keys(ind.last).length > 0, `${ind.type} has last values`);
    }
    // A digest, not the read: none of the read's big blocks are here.
    assert.equal(d.levels, undefined);
    assert.equal(d.geometry, undefined);
    assert.equal(d.housekeeping, undefined);
    assert.ok(JSON.stringify(d).length < 1200, `digest is ${JSON.stringify(d).length} bytes`);

    // And the window's payload carries what was drawn, tagged.
    const payload = await h.get('/api/chart');
    assert.equal(payload.json.levels.length, 2);
    assert.equal(payload.json.levels[0].label, '[agent] range high');
    assert.equal(payload.json.drawings.length, 2);
    assert.equal(payload.json.drawings[0].kind, 'trendline');
    assert.equal(payload.json.drawings[1].kind, 'zone');
    assert.deepEqual(payload.json.drawings[1].zone, { low: 160, high: 165 });
  } finally {
    await h.close();
  }
});

test('refused names an unknown indicator and a plan that is not an idea, and the rest still applies', async () => {
  const h = await bootChartServer();
  try {
    h.setPlans([
      { id: 'pl_1', symbol: 'BTC', status: 'open' },
      { id: 'pl_2', symbol: 'BTC', status: 'idea' },
      { id: 'pl_3', symbol: 'SOL', status: 'waiting' },
    ]);
    const out = await h.mcp({
      op: 'view',
      tool: 'chart_draw',
      session: 'a',
      args: {
        clear: 'mine',
        indicators: { add: [{ type: 'nope' }, { type: 'ema', params: { period: 21 } }, { type: 'custom:missing' }] },
        levels: [{ px: 100 }],
      },
    });
    assert.equal(out.status, 200);
    const refused: string[] = out.json.refused;
    assert.ok(refused.some((r) => /unknown indicator: nope/.test(r)), JSON.stringify(refused));
    assert.ok(refused.some((r) => /unknown indicator: custom:missing/.test(r)), 'no custom indicators loaded, so the slug is refused by name');
    assert.ok(refused.some((r) => /pl_1/.test(r) && /open/.test(r)), 'an open plan on this chart is not cleared');
    assert.ok(!refused.some((r) => /pl_2/.test(r)), 'an idea is not reported as refused');
    assert.ok(!refused.some((r) => /pl_3/.test(r)), 'a plan on another market is not this chart\'s business');
    assert.equal(out.json.indicators.length, 1, 'the EMA still went on');
    assert.equal(out.json.counts.levels, 1);
    assert.equal(out.json.counts.plans, 2, 'the two BTC plans are counted, whatever their state');
  } finally {
    await h.close();
  }
});

test("clear 'mine' takes the caller's own work and leaves a colleague's", async () => {
  const h = await bootChartServer();
  try {
    await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { levels: [{ px: 1 }], zones: [{ p1: 1, p2: 2 }] } });
    await h.mcp({ op: 'view', tool: 'chart_draw', session: 'b', args: { levels: [{ px: 2 }], lines: [{ t1: T0, p1: 1, t2: T0 + 60, p2: 2 }] } });
    const out = await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { clear: 'mine' } });
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.counts, { levels: 1, marks: 0, lines: 1, zones: 0, plans: 0 });
    const payload = await h.get('/api/chart');
    assert.deepEqual(payload.json.levels.map((l: { by: string }) => l.by), ['b']);
  } finally {
    await h.close();
  }
});

test("clear 'mine' with no session is refused by name rather than clearing everything", async () => {
  const h = await bootChartServer();
  try {
    await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { levels: [{ px: 1 }] } });
    const out = await h.mcp({ op: 'view', tool: 'chart_draw', args: { clear: 'mine' } });
    assert.equal(out.status, 200);
    assert.ok(out.json.refused.some((r: string) => /which agent is asking/.test(r)));
    assert.equal(out.json.counts.levels, 1);
  } finally {
    await h.close();
  }
});

test('indicators.set replaces the caller\'s own studies and indicators.remove takes one off', async () => {
  const h = await bootChartServer();
  try {
    await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { indicators: { add: [{ type: 'rsi' }, { type: 'macd' }] } } });
    const set = await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { indicators: { set: [{ type: 'ema', params: { period: 55 } }] } } });
    assert.deepEqual(set.json.indicators.map((i: { type: string }) => i.type), ['ema']);
    const removed = await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { indicators: { remove: ['ema', 'nothing'] } } });
    assert.equal(removed.json.indicators.length, 0);
    assert.ok(removed.json.refused.some((r: string) => /no indicator matching nothing/.test(r)));
  } finally {
    await h.close();
  }
});

test('a product no venue lists is refused in the list and the chart stays where it was', async () => {
  const h = await bootChartServer();
  try {
    const out = await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { view: { product: 'NOTACOIN' }, levels: [{ px: 5 }] } });
    assert.equal(out.status, 200);
    assert.ok(out.json.refused.some((r: string) => /no market listed/.test(r)));
    assert.equal(out.json.product, 'BTC-USD');
    assert.equal(out.json.counts.levels, 1, 'the level still landed, on the chart that is there');
  } finally {
    await h.close();
  }
});

test('a line with one time for both ends is refused, not drawn vertical', async () => {
  const h = await bootChartServer();
  try {
    const out = await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { lines: [{ t1: T0, p1: 1, t2: T0, p2: 2 }] } });
    assert.ok(out.json.refused.some((r: string) => /two different times/.test(r)));
    assert.equal(out.json.counts.lines, 0);
  } finally {
    await h.close();
  }
});

test('chart_layout puts a comparison chart up and chart_draw reaches it by slot', async () => {
  const h = await bootChartServer();
  try {
    const layout = await h.mcp({
      op: 'view',
      tool: 'chart_layout',
      session: 'a',
      args: { charts: [{ product: 'BTC-USD', timeframe: '15m' }, { product: 'ETH-USD', timeframe: '4h' }] },
    });
    assert.equal(layout.status, 200, JSON.stringify(layout.json));
    assert.deepEqual(layout.json.charts, [
      { index: 0, product: 'BTC-USD', timeframe: '15m' },
      { index: 1, product: 'ETH-USD', timeframe: '4h' },
    ]);

    const drawn = await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { chart: 1, levels: [{ px: 170 }] } });
    assert.equal(drawn.status, 200);
    assert.equal(drawn.json.chart, 1);
    assert.equal(drawn.json.product, 'ETH-USD');
    assert.equal(drawn.json.counts.levels, 1);

    const second = await h.get('/api/chart?slot=1');
    assert.equal(second.status, 200);
    assert.equal(second.json.levels.length, 1);
    const primary = await h.get('/api/chart');
    assert.equal(primary.json.levels.length, 0, 'the primary was not drawn on');

    const empty = await h.mcp({ op: 'view', tool: 'chart_draw', session: 'a', args: { chart: 3, levels: [{ px: 1 }] } });
    assert.equal(empty.status, 400);
    assert.match(String(empty.json.error), /chart_layout/);

    const bad = await h.mcp({ op: 'view', tool: 'chart_layout', session: 'a', args: { charts: [{ product: 'NOTACOIN', timeframe: '1h' }] } });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error), /NOTACOIN/);
  } finally {
    await h.close();
  }
});

test('the ten write tools are gone from the view door', async () => {
  const h = await bootChartServer();
  try {
    for (const tool of ['chart_set_view', 'chart_add_indicator', 'chart_remove_indicator', 'chart_level', 'chart_mark', 'chart_trendline', 'chart_clear', 'chart_preset']) {
      const out = await h.mcp({ op: 'view', tool, session: 'a', args: {} });
      assert.equal(out.status, 400, tool);
      assert.match(String(out.json.error), /unknown view tool/);
    }
  } finally {
    await h.close();
  }
});
