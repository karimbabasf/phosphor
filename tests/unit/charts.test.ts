// Chart slots: up to four charts side by side, each its own store.
//
// Slot 0 is the primary, the full engine the human interacts with and the one every tool means
// by default. Slots 1 to 3 are comparison charts. The seam this pins is that the primary is the
// same object whether it is reached as `primary` or as `slot(0)`, because ctx.chart and
// ctx.drawings keep pointing at it and every old call site goes through those.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChartSlots } from '../../src/charts.ts';

test('the primary is slot 0 and the only slot until a layout asks for more', () => {
  const charts = createChartSlots('BTC-USD');
  assert.equal(charts.primary.index, 0);
  assert.equal(charts.primary, charts.slot(0), 'one object, reached two ways');
  assert.equal(charts.primary.store.state().view.product, 'BTC-USD');
  assert.equal(charts.slot(1), null);
  assert.equal(charts.slot(3), null);
  assert.deepEqual(charts.list(), [{ index: 0, product: 'BTC-USD', timeframe: '1m' }]);
});

test('a layout of two puts a comparison chart beside the primary, on its own store', () => {
  const charts = createChartSlots('BTC-USD');
  const out = charts.layout([
    { product: 'BTC-USD', timeframe: '1h' },
    { product: 'ETH-USD', timeframe: '4h' },
  ]);
  assert.equal(out.ok, true);
  assert.equal(charts.primary.store.state().view.granularitySec, 3600, 'the primary follows the first entry');
  const second = charts.slot(1);
  assert.ok(second !== null);
  assert.equal(second.index, 1);
  assert.equal(second.store.state().view.product, 'ETH-USD');
  assert.equal(second.store.state().view.granularitySec, 14400);
  assert.notEqual(second.store, charts.primary.store);
  assert.notEqual(second.drawings, charts.primary.drawings);
  assert.deepEqual(charts.list(), [
    { index: 0, product: 'BTC-USD', timeframe: '1h' },
    { index: 1, product: 'ETH-USD', timeframe: '4h' },
  ]);
});

test('one to four charts, and the refusal names the bound', () => {
  const charts = createChartSlots('BTC-USD');
  const none = charts.layout([]);
  assert.equal(none.ok, false);
  assert.match(none.ok ? '' : none.reason, /1 to 4/);
  const five = charts.layout(Array.from({ length: 5 }, () => ({ product: 'BTC-USD', timeframe: '1h' })));
  assert.equal(five.ok, false);
  assert.match(five.ok ? '' : five.reason, /1 to 4/);
  assert.equal(charts.list().length, 1, 'a refused layout changes nothing');
});

test('a timeframe that is not one is refused by name, and nothing is changed', () => {
  const charts = createChartSlots('BTC-USD');
  const out = charts.layout([
    { product: 'BTC-USD', timeframe: '1h' },
    { product: 'ETH-USD', timeframe: 'banana' },
  ]);
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.reason, /banana/);
  assert.equal(charts.slot(1), null);
  assert.equal(charts.primary.store.state().view.granularitySec, 60, 'the primary was not moved either');
});

test('a smaller layout drops the charts past it, and a repeat keeps a comparison chart\'s drawings', () => {
  const charts = createChartSlots('BTC-USD');
  charts.layout([
    { product: 'BTC-USD', timeframe: '1h' },
    { product: 'ETH-USD', timeframe: '4h' },
    { product: 'SOL-USD', timeframe: '1d' },
  ]);
  assert.equal(charts.list().length, 3);
  const second = charts.slot(1);
  assert.ok(second !== null);
  second.drawings.add({ kind: 'zone', label: 'supply', source: 'agent', zone: { low: 1, high: 2 } });

  charts.layout([
    { product: 'BTC-USD', timeframe: '1h' },
    { product: 'ETH-USD', timeframe: '1h' },
  ]);
  assert.equal(charts.slot(2), null, 'the third chart is gone');
  assert.equal(charts.slot(1), second, 'the same instrument keeps the same store');
  assert.equal(second.drawings.count(), 1, 'and what was drawn on it');
  assert.equal(second.store.state().view.granularitySec, 3600);
});

test('a layout of one keeps the primary and clears the comparison charts', () => {
  const charts = createChartSlots('BTC-USD');
  charts.layout([
    { product: 'BTC-USD', timeframe: '1h' },
    { product: 'ETH-USD', timeframe: '4h' },
  ]);
  const out = charts.layout([{ product: 'SOL-USD', timeframe: '15m' }]);
  assert.equal(out.ok, true);
  assert.equal(charts.slot(1), null);
  assert.equal(charts.primary.store.state().view.product, 'SOL-USD');
});

test('the slot index is bounded to 0..3 and anything else is null', () => {
  const charts = createChartSlots('BTC-USD');
  assert.equal(charts.slot(-1), null);
  assert.equal(charts.slot(4), null);
  assert.equal(charts.slot(Number.NaN), null);
});
