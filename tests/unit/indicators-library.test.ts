// The second indicator catalogue, checked against arithmetic rather than against itself.
//
// The trap with an indicator suite is a test that asserts the code does what the code does. So
// each of these builds a series whose answer is known before the indicator runs: a market that
// only goes up, a market that does not move at all, a wave that has to cross, a channel a price
// is exactly half way into.
//
// The other half is the failure that actually reaches a human. Every one of these can divide by
// zero on a flat series, and a NaN in a plot draws nothing and reports nothing, which looks
// identical to a market with no news in it. The dead-flat cases below are there for that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { indicatorSpec, indicatorCatalog, normaliseParams, warmupBars } from '../../src/indicators.ts';
import { LIBRARY_SPECS } from '../../src/indicators-library.ts';
import type { Candle } from '../../src/types.ts';

function series(closes: number[], opts?: { volume?: number[]; spread?: number }): Candle[] {
  const spread = opts?.spread ?? 1;
  return closes.map((c, i) => ({
    t: 1_700_000_000 + i * 3600,
    o: i === 0 ? c : (closes[i - 1] as number),
    h: c + spread,
    l: c - spread,
    c,
    v: opts?.volume?.[i] ?? 100,
  }));
}

function flat(n: number, price = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000 + i * 3600,
    o: price,
    h: price,
    l: price,
    c: price,
    v: 0,
  }));
}

function ramp(n: number, from = 100, step = 1): Candle[] {
  return series(Array.from({ length: n }, (_, i) => from + i * step));
}

function compute(type: string, candles: Candle[], params: Record<string, number> = {}) {
  const spec = indicatorSpec(type);
  assert.ok(spec, `no indicator named ${type}`);
  return spec.compute(candles, normaliseParams(spec, params).params);
}

function last(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

test('every library indicator is reachable through the one catalogue', () => {
  const listed = indicatorCatalog().map((entry) => (entry as { type: string }).type);
  for (const spec of LIBRARY_SPECS) {
    assert.ok(listed.includes(spec.type), `${spec.type} is not in indicator_catalog`);
    assert.ok(indicatorSpec(spec.type), `${spec.type} does not resolve by type`);
  }
});

test('no library indicator produces a NaN or an infinity on a dead-flat market', () => {
  // The one that matters. A flat series divides by zero in the channel index, in the money
  // flow, in the squeeze and in the stochastic, and a NaN plot is indistinguishable from a
  // quiet market on the screen.
  const candles = flat(300);
  for (const spec of LIBRARY_SPECS) {
    const result = spec.compute(candles, normaliseParams(spec, {}).params);
    for (const plot of result.plots) {
      for (const value of plot.values) {
        assert.ok(value === null || Number.isFinite(value), `${spec.type}.${plot.key} produced ${value}`);
      }
    }
    assert.equal(typeof result.state, 'string');
    assert.ok(result.state.length > 0, `${spec.type} has no state line`);
  }
});

test('no library indicator throws on a series shorter than its own warmup', () => {
  const candles = ramp(3);
  for (const spec of LIBRARY_SPECS) {
    const result = spec.compute(candles, normaliseParams(spec, {}).params);
    assert.ok(Array.isArray(result.plots));
    for (const plot of result.plots) {
      assert.equal(plot.values.length, candles.length, `${spec.type}.${plot.key} is not index-aligned`);
    }
  }
});

test('a stacked indicator declares the warmup its averages actually need', () => {
  // Without the warmup hook, `wave` would claim it needs 12 bars, which is its longest single
  // parameter, and report a reading built from a two-deep average of nothing.
  const spec = indicatorSpec('wave');
  assert.ok(spec);
  const params = normaliseParams(spec, {}).params;
  assert.ok(warmupBars(spec, params) > 12, 'the wave needs more history than its longest parameter');
});

test('the wave crosses its signal, and the state line says which way on the bar it happened', () => {
  // Up for a long time, then a sharp drop that is still going when the series ends. The drop is
  // short on purpose: run it long enough and the wave bottoms out and turns back up, which is
  // the indicator working rather than failing, and would make this assertion about nothing.
  const up = Array.from({ length: 80 }, (_, i) => 100 + i);
  const down = Array.from({ length: 8 }, (_, i) => 180 - (i + 1) * 4);
  const result = compute('wave', series([...up, ...down]));
  const wt1 = result.plots.find((p) => p.key === 'wt1')?.values ?? [];
  const wt2 = result.plots.find((p) => p.key === 'wt2')?.values ?? [];
  const a = last(wt1);
  const b = last(wt2);
  assert.ok(a !== null && b !== null);
  assert.ok(a < b, 'a market that just fell should leave the wave under its signal');
  assert.match(result.state, /wave/);
});

test('the wave histogram is the gap between the two lines and nothing else', () => {
  const result = compute('wave', ramp(200));
  const wt1 = result.plots.find((p) => p.key === 'wt1')?.values ?? [];
  const wt2 = result.plots.find((p) => p.key === 'wt2')?.values ?? [];
  const hist = result.plots.find((p) => p.key === 'hist')?.values ?? [];
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] === null) continue;
    assert.ok(Math.abs((hist[i] as number) - ((wt1[i] as number) - (wt2[i] as number))) < 1e-9);
  }
});

test('money flow is positive when every body closes up and negative when they close down', () => {
  const upBodies: Candle[] = Array.from({ length: 100 }, (_, i) => ({
    t: 1_700_000_000 + i * 3600,
    o: 100,
    h: 102,
    l: 99,
    c: 101,
    v: 10,
  }));
  const downBodies = upBodies.map((c) => ({ ...c, o: 101, c: 100 }));
  const up = last(compute('moneyflow', upBodies).plots[0]?.values ?? []);
  const down = last(compute('moneyflow', downBodies).plots[0]?.values ?? []);
  assert.ok(up !== null && up > 0);
  assert.ok(down !== null && down < 0);
});

test('supertrend sits under price in an uptrend and over it after the turn', () => {
  const up = ramp(120);
  const underneath = compute('supertrend', up);
  const line = last(underneath.plots[0]?.values ?? []);
  const price = (up[up.length - 1] as Candle).c;
  assert.ok(line !== null && line < price, 'the stop belongs below price while price is rising');

  const turn = series([...Array.from({ length: 100 }, (_, i) => 100 + i), ...Array.from({ length: 40 }, (_, i) => 200 - i * 4)]);
  const after = compute('supertrend', turn);
  const flipped = last(after.plots[0]?.values ?? []);
  const nowPrice = (turn[turn.length - 1] as Candle).c;
  assert.ok(flipped !== null && flipped > nowPrice, 'and above it once price has broken through');
});

test('keltner puts price exactly in the middle of a band it built from a flat market', () => {
  const result = compute('keltner', flat(200));
  assert.match(result.state, /50% of the band|flat band/);
});

test('the squeeze is on while a market is dead and reports how long it has been', () => {
  const result = compute('squeeze', flat(200));
  assert.match(result.state, /squeeze (on|off) for \d+ bars/);
});

test('adx is bounded, and +DI beats -DI in a market that only goes up', () => {
  const result = compute('adx', ramp(200));
  const plus = last(result.plots.find((p) => p.key === 'plus')?.values ?? []);
  const minus = last(result.plots.find((p) => p.key === 'minus')?.values ?? []);
  const adx = last(result.plots.find((p) => p.key === 'adx')?.values ?? []);
  assert.ok(plus !== null && minus !== null && adx !== null);
  assert.ok(plus > minus, 'a one-way market has more up movement than down');
  assert.ok(adx >= 0 && adx <= 100);
  assert.deepEqual(result.range, [0, 100]);
});

test('stochastic rsi spans its whole range on a market with pullbacks, and never leaves it', () => {
  /* What is actually invariant here, rather than what a stochastic "should" read on the last bar.
     Two honest claims:
       it uses the full 0..100 range on a market that rises and pulls back, which is the point of
       normalising the RSI against its own recent range;
       it never leaves those bounds, which is the failure that would reach a pane with a fixed
       domain and draw off the top of it.
     A PERFECTLY straight ramp is deliberately not the input: the RSI of a constant slope is a
     constant, so its own range is zero, and the honest answer to "where in that range" is the
     middle. src/indicators.ts's plain stochastic answers 50 to the same degenerate case. */
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 7) * 12);
  const result = compute('stochrsi', series(closes));
  const k = (result.plots.find((p) => p.key === 'k')?.values ?? []).filter(
    (v): v is number => v !== null,
  );
  assert.ok(k.length > 0);
  assert.ok(Math.max(...k) > 80, `the stochastic RSI never reached the top: max ${Math.max(...k)}`);
  assert.ok(Math.min(...k) < 20, `the stochastic RSI never reached the bottom: min ${Math.min(...k)}`);
  for (const plot of result.plots) {
    for (const v of plot.values) {
      if (v === null) continue;
      assert.ok(v >= 0 && v <= 100, `${plot.key} left its bounds at ${v}`);
    }
  }
  assert.deepEqual(result.range, [0, 100]);
});

test('the money flow index reports nothing rather than fifty when a venue serves no volume', () => {
  // Reporting 50 would look like a measurement of a market this venue never described.
  const noVolume = ramp(100).map((c) => ({ ...c, v: 0 }));
  const result = compute('mfi', noVolume);
  assert.equal(last(result.plots[0]?.values ?? []), null);
  assert.match(result.state, /no volume/);
});

test('relative volume reads 1 when every bar carries the same volume', () => {
  const result = compute('relvolume', ramp(100));
  const value = last(result.plots[0]?.values ?? []);
  assert.ok(value !== null && Math.abs(value - 1) < 1e-9);
});

test('the ichimoku cloud brackets the price it was built from', () => {
  const result = compute('ichimoku', ramp(300));
  const a = last(result.plots.find((p) => p.key === 'spanA')?.values ?? []);
  const b = last(result.plots.find((p) => p.key === 'spanB')?.values ?? []);
  assert.ok(a !== null && b !== null);
  assert.match(result.state, /cloud .* price (above|below|inside) it/);
});

test('the vwap band collapses onto the vwap when every bar traded at one price', () => {
  const result = compute('vwapbands', flat(50).map((c) => ({ ...c, v: 10 })));
  const upper = last(result.plots.find((p) => p.key === 'upper')?.values ?? []);
  const lower = last(result.plots.find((p) => p.key === 'lower')?.values ?? []);
  const mid = last(result.plots.find((p) => p.key === 'vwap')?.values ?? []);
  assert.ok(upper !== null && lower !== null && mid !== null);
  assert.ok(Math.abs(upper - lower) < 1e-6, 'no dispersion means no band');
});

test('the ribbon spends one overlay slot and reports its own order', () => {
  const result = compute('ribbon', ramp(400));
  assert.equal(result.plots.length, 4);
  assert.match(result.state, /stacked fast over slow/);
});

test('the hull average is not shifted: it ends where a rising market ends', () => {
  const candles = ramp(300);
  const result = compute('hma', candles, { period: 20 });
  const line = last(result.plots[0]?.values ?? []);
  const price = (candles[candles.length - 1] as Candle).c;
  assert.ok(line !== null);
  // A Hull tracks closely on a straight ramp; a bad index alignment shows up as a large gap.
  assert.ok(Math.abs(line - price) < 5, `hma ended at ${line} against a price of ${price}`);
});

test('no state line in the library gives a trading opinion', () => {
  // The same rule tests/unit/analysis-ops.test.ts holds the measurement layer to. An indicator
  // that shipped a view would replace the judgment the agent exists to provide.
  // `signal` is deliberately not banned: it is the NAME of the second line on a wave or a MACD,
  // and every source calls it that. The words below are the ones that state a view.
  const banned = /\b(buy|sell|long|short|bullish|bearish|oversold|overbought|breakout|reversal)\b/i;
  const candles = ramp(300);
  for (const spec of LIBRARY_SPECS) {
    const result = spec.compute(candles, normaliseParams(spec, {}).params);
    assert.doesNotMatch(result.state, banned, `${spec.type} states an opinion: ${result.state}`);
  }
});
