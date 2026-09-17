// Where custom indicators meet the rest of the app: the catalogue takes extra specs, and the
// chart store resolves 'custom:<slug>' through a resolver it is handed. Built-ins are tried
// first, so a file can never shadow a catalogue type, and a store built without a resolver
// behaves exactly as it always has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createChartStore, LIMITS } from '../../src/chart.ts';
import { indicatorCatalog, indicatorSpec, normaliseParams, warmupBars } from '../../src/indicators.ts';
import type { IndicatorSpec } from '../../src/indicators.ts';
import { createCustomIndicators } from '../../src/indicators-custom/loader.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'indicators');

function loaderWith(...names: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-hook-'));
  for (const name of names) fs.copyFileSync(path.join(FIXTURES, name), path.join(dir, name));
  return createCustomIndicators(dir);
}

test('the catalogue lists custom specs after the built-ins, and only when handed them', () => {
  const loader = loaderWith('sma.json', 'rsi-bands.pine');
  const builtins = indicatorCatalog() as { type: string }[];
  const withCustom = indicatorCatalog(loader.specs()) as { type: string; pane: string; params: { name: string }[] }[];
  assert.equal(withCustom.length, builtins.length + 2);
  assert.deepEqual(
    withCustom.slice(builtins.length).map((e) => e.type),
    ['custom:rsi-bands', 'custom:sma'],
  );
  assert.equal(withCustom[builtins.length]?.pane, 'takes its own pane');
  assert.deepEqual(
    withCustom[builtins.length + 1]?.params.map((p) => p.name),
    ['length'],
  );
  assert.ok(!builtins.some((e) => e.type.startsWith('custom:')));
});

test('indicatorSpec resolves a custom type through extra and never lets it shadow a built-in', () => {
  const loader = loaderWith('sma.json');
  assert.equal(indicatorSpec('custom:sma'), undefined);
  assert.equal(indicatorSpec('custom:sma', loader.specs())?.type, 'custom:sma');
  const shadow: IndicatorSpec = { ...(indicatorSpec('sma') as IndicatorSpec), summary: 'an impostor' };
  assert.notEqual(indicatorSpec('sma', [shadow])?.summary, 'an impostor');
});

test('the chart store draws custom:<slug> through its resolver like any built-in', () => {
  const loader = loaderWith('sma.json', 'rsi.json');
  const chart = createChartStore('BTC-USD', Date.now, (type) => loader.get(type));
  const sma = chart.addIndicator({ type: 'custom:sma', params: { length: 50 } }, 'agent', 'a1');
  assert.equal(sma.ok, true);
  assert.equal(sma.id, 'custom:sma-1');
  assert.equal(sma.label, 'Custom SMA 50');
  const row = chart.state().indicators[0];
  assert.equal(row?.pane, 'price');
  assert.equal(row?.type, 'custom:sma');
  assert.deepEqual(row?.params, { length: 50 });

  const rsi = chart.addIndicator({ type: 'custom:rsi' }, 'agent', 'a1');
  assert.equal(rsi.ok, true);
  assert.equal(chart.state().indicators[1]?.pane, 'own');

  // The same custom with the same params is the same study, as for a built-in.
  const again = chart.addIndicator({ type: 'custom:sma', params: { length: 50 } }, 'agent', 'a1');
  assert.equal(again.ok, true);
  assert.equal(again.id, 'custom:sma-1');
  assert.equal(chart.state().indicators.length, 2);

  // historyNeeded reads the custom spec's warmup through the same resolver.
  const spec = loader.get('sma') as IndicatorSpec;
  const warmup = warmupBars(spec, normaliseParams(spec, { length: 50 }).params);
  assert.equal(warmup, 50);
  const view = chart.state().view;
  const expected = Math.min(LIMITS.historyMax, Math.ceil(view.barCount + Math.max(0, view.panOffset) + LIMITS.fetchMargin + warmup));
  assert.equal(chart.historyNeeded(), expected);

  assert.equal(chart.removeIndicator('custom:rsi').ok, true);
  assert.equal(chart.removeIndicator('custom:sma-1').ok, true);
  assert.equal(chart.state().indicators.length, 0);
});

test('an unknown slug is refused by the store, and a store without a resolver knows no custom types', () => {
  const loader = loaderWith('sma.json');
  const chart = createChartStore('BTC-USD', Date.now, (type) => loader.get(type));
  const nope = chart.addIndicator({ type: 'custom:nope' }, 'agent');
  assert.equal(nope.ok, false);
  assert.match(String(nope.error), /unknown indicator: custom:nope/);
  const traversal = chart.addIndicator({ type: 'custom:../sma' }, 'agent');
  assert.equal(traversal.ok, false);

  const bare = createChartStore('BTC-USD');
  assert.equal(bare.addIndicator({ type: 'custom:sma' }, 'agent').ok, false);
  assert.equal(bare.addIndicator({ type: 'sma' }, 'agent').ok, true);
});

test('a custom overlay counts against the overlay cap and a custom pane against the pane cap', () => {
  const loader = loaderWith('sma.json', 'ema.json', 'rsi.json', 'atr.json');
  const chart = createChartStore('BTC-USD', Date.now, (type) => loader.get(type));
  let panes = 0;
  for (const type of ['custom:rsi', 'custom:atr', 'rsi', 'macd', 'atr', 'stoch']) {
    if (chart.addIndicator({ type }, 'agent').ok) panes += 1;
  }
  assert.equal(panes, LIMITS.maxPanes);
  assert.equal(chart.state().indicators.filter((i) => i.pane === 'own').length, LIMITS.maxPanes);
});
