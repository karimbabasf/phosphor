// A focus moves the chart with it, for any coin the venue lists.
//
// trade_focus used to move the candles only when the coin was in config.json's candleProducts,
// so "show me GRAM on the chart" moved the header and the position panel to GRAM while the
// candles stayed on BTC-USD (Karim's screenshot, 2026-09-21): the one disagreement on that
// surface a person cannot catch, because both halves look right alone. The fixture lists SOL
// in the catalogue and not in candleProducts, which is GRAM's shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';

test('trade_focus on a coin the venue lists but the config does not still moves the chart to it', async () => {
  const h = await bootChartServer();
  try {
    const before = await h.get('/api/chart');
    assert.equal(before.json.view.product, 'BTC-USD');
    const focused = await h.mcp({ op: 'view', tool: 'trade_focus', args: { symbol: 'SOL' }, session: 'lead', client: 'phosphor-mcp' });
    assert.equal(focused.status, 200, JSON.stringify(focused.json).slice(0, 200));
    const after = await h.get('/api/chart');
    assert.equal(after.json.view.product, 'SOL-USD', 'the candles follow the focus');
    // A coin nobody lists moves nothing on the chart, whatever the trade surface says to it.
    await h.mcp({ op: 'view', tool: 'trade_focus', args: { symbol: 'NOPE' }, session: 'lead', client: 'phosphor-mcp' });
    assert.equal((await h.get('/api/chart')).json.view.product, 'SOL-USD');
  } finally {
    await h.close();
  }
});

// The other direction. chart_draw with a view.product, a layout, or the window's own chart write
// moved the candles and left the header, the price strip and the position panel on the old
// market (Karim's screenshot, 2026-09-22: GRAM-USD candles under a BTC header).
test('a primary chart moved to another market moves the header with it, from every door', async () => {
  const h = await bootChartServer();
  try {
    const header = async (): Promise<string> => String((await h.get('/api/trade')).json.view.symbol);
    assert.equal(await header(), 'BTC');

    const drawn = await h.mcp({ op: 'view', tool: 'chart_draw', args: { view: { product: 'SOL', timeframe: '1d' } }, session: 'lead', client: 'phosphor-mcp' });
    assert.equal(drawn.status, 200, JSON.stringify(drawn.json).slice(0, 200));
    assert.equal((await h.get('/api/chart')).json.view.product, 'SOL-USD');
    assert.equal(await header(), 'SOL', 'chart_draw moves the header with the candles');

    const laid = await h.mcp({ op: 'view', tool: 'chart_layout', args: { charts: [{ product: 'ETH-USD', timeframe: '1d' }, { product: 'BTC-USD', timeframe: '1d' }] }, session: 'lead', client: 'phosphor-mcp' });
    assert.equal(laid.status, 200, JSON.stringify(laid.json).slice(0, 200));
    assert.equal(await header(), 'ETH', 'a layout moves the header with its primary');

    // A comparison chart is not the one the header names.
    const side = await h.mcp({ op: 'view', tool: 'chart_draw', args: { chart: 1, view: { product: 'SOL' } }, session: 'lead', client: 'phosphor-mcp' });
    assert.equal(side.status, 200, JSON.stringify(side.json).slice(0, 200));
    assert.equal(await header(), 'ETH', 'a comparison chart leaves the header alone');

    const moved = await h.post('/api/chart', { token: h.token, view: { product: 'BTC-USD' } });
    assert.equal(moved.status, 200, JSON.stringify(moved.json).slice(0, 200));
    assert.equal(await header(), 'BTC', "the window's own chart write moves the header too");
  } finally {
    await h.close();
  }
});
