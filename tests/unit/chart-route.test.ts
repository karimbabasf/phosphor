// GET /api/chart with a slot: the window's render payload for each of the charts a layout put
// up. No slot is the primary, which is what every window built before slots asks for; a slot
// nothing has filled is a 404, never the primary served under another chart's name.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';

test('the primary answers with no slot and as slot 0, with the same revision', async () => {
  const h = await bootChartServer();
  try {
    const bare = await h.get('/api/chart');
    assert.equal(bare.status, 200);
    assert.equal(bare.json.slot, 0);
    assert.equal(bare.json.view.product, 'BTC-USD');
    assert.ok(Array.isArray(bare.json.candles));
    const zero = await h.get('/api/chart?slot=0');
    assert.equal(zero.status, 200);
    assert.equal(zero.json.rev, bare.json.rev);
  } finally {
    await h.close();
  }
});

test('a slot no layout has filled is a 404 that names the tool', async () => {
  const h = await bootChartServer();
  try {
    const out = await h.get('/api/chart?slot=2');
    assert.equal(out.status, 404);
    assert.match(String(out.json.error), /chart_layout/);
  } finally {
    await h.close();
  }
});

test('slot=-1, abc, 7, 1.5, 0x1 and an empty slot are refused by name rather than answered with the primary', async () => {
  const h = await bootChartServer();
  try {
    for (const bad of ['-1', 'abc', '7', '1.5', '0x1', '']) {
      const out = await h.get(`/api/chart?slot=${bad}`);
      assert.equal(out.status, 400, `slot=${bad} answered ${out.status}: ${JSON.stringify(out.json).slice(0, 80)}`);
      assert.match(String(out.json.error), /0 to 3/);
    }
    assert.equal((await h.get('/api/chart?slot=0')).json.slot, 0);
    const empty = await h.get('/api/chart?slot=3');
    assert.equal(empty.status, 404, 'a slot inside the four that no layout filled stays a 404');
  } finally {
    await h.close();
  }
});
