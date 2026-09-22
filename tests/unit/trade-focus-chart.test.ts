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
