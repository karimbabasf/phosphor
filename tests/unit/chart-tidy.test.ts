// The chart cleaning up after itself.
//
// Three claims, and they are the ones a human would notice failing:
//
//   1. A level, a mark or a trend line drawn on one instrument does not survive onto another.
//      It is not stale there, it is wrong: 63,000 lands off the bottom of a Solana chart.
//   2. An indicator DOES survive, because it is a recipe rather than a place.
//   3. A human's drawings are never swept by anything an agent does.
//
// Plus the tidy an agent runs itself: `mine` reaches one agent's work and nothing else, which
// is what makes a team safe to put on one chart.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChartStore, STALE_MS } from '../../src/chart.ts';

function storeAt(start: number): { chart: ReturnType<typeof createChartStore>; advance: (ms: number) => void } {
  let now = start;
  return {
    chart: createChartStore('BTC-USD', () => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('switching instrument clears the agent drawings anchored to the old one', () => {
  const { chart } = storeAt(1_000_000);
  chart.setLevel({ price: 63000, label: 'range high' }, 'agent', 'a');
  chart.setMark({ t: 1700000000, label: 'entry' }, 'agent', 'a');
  chart.setTrendline({ t1: 1, p1: 62000, t2: 2, p2: 63000 }, 'agent', 'a');

  const out = chart.setView({ product: 'SOL-USD' }, 'agent', 'a');
  assert.equal(out.ok, true);
  assert.equal(chart.state().levels.length, 0);
  assert.equal(chart.state().marks.length, 0);
  assert.equal(chart.state().trendlines.length, 0);
  assert.match(out.notes.join(' '), /cleared 3 agent drawings/);
});

test('indicators survive the switch, because they recompute on the new series', () => {
  const { chart } = storeAt(1_000_000);
  chart.addIndicator({ type: 'ema', params: { period: 21 } }, 'agent', 'a');
  chart.setLevel({ price: 63000 }, 'agent', 'a');

  chart.setView({ product: 'SOL-USD' }, 'agent', 'a');
  assert.equal(chart.state().indicators.length, 1, 'an EMA means the same thing on any market');
  assert.equal(chart.state().levels.length, 0);
});

test('a human drawing is left alone on the switch, and reported rather than removed', () => {
  const { chart } = storeAt(1_000_000);
  chart.setLevel({ price: 63000, label: 'mine' }, 'human');
  chart.setLevel({ price: 64000, label: 'theirs' }, 'agent', 'a');

  const out = chart.setView({ product: 'SOL-USD' }, 'agent', 'a');
  assert.equal(chart.state().levels.length, 1);
  assert.equal(chart.state().levels[0]?.source, 'human');
  assert.match(out.notes.join(' '), /human drawing.*left alone/);
});

test('a timeframe change sweeps nothing: a price level is true on every timeframe', () => {
  const { chart } = storeAt(1_000_000);
  chart.setLevel({ price: 63000 }, 'agent', 'a');
  chart.setView({ timeframe: '4h' }, 'agent', 'a');
  assert.equal(chart.state().levels.length, 1);
});

test("clear 'mine' reaches one agent's work and no other agent's", () => {
  const { chart } = storeAt(1_000_000);
  chart.setLevel({ price: 1, label: 'from a' }, 'agent', 'a');
  chart.setLevel({ price: 2, label: 'from b' }, 'agent', 'b');
  chart.setLevel({ price: 3, label: 'from the human' }, 'human');

  const out = chart.clear('mine', 'a');
  assert.equal(out.ok, true);
  assert.deepEqual(
    chart.state().levels.map((l) => l.by),
    ['b', null],
  );
});

test("clear 'mine' with no session is refused rather than clearing everything", () => {
  // The dangerous failure is the silent one: a call that meant "my work" and wiped the team's.
  const { chart } = storeAt(1_000_000);
  chart.setLevel({ price: 1 }, 'agent', 'a');
  const out = chart.clear('mine', null);
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /which agent is asking/);
  assert.equal(chart.state().levels.length, 1);
});

test("clear 'agent' takes every agent's work and still spares the human's", () => {
  const { chart } = storeAt(1_000_000);
  chart.setLevel({ price: 1 }, 'agent', 'a');
  chart.setLevel({ price: 2 }, 'agent', 'b');
  chart.setLevel({ price: 3 }, 'human');
  chart.clear('agent');
  assert.deepEqual(
    chart.state().levels.map((l) => l.source),
    ['human'],
  );
});

test("clear 'stale' takes the old and leaves the fresh", () => {
  const { chart, advance } = storeAt(1_000_000);
  chart.setLevel({ price: 1, label: 'old' }, 'agent', 'a');
  advance(STALE_MS + 1000);
  chart.setLevel({ price: 2, label: 'new' }, 'agent', 'a');

  chart.clear('stale');
  assert.deepEqual(
    chart.state().levels.map((l) => l.price),
    [2],
  );
});

test('housekeeping separates your work from theirs, and names the call that fixes it', () => {
  const { chart, advance } = storeAt(1_000_000);
  chart.setLevel({ price: 1 }, 'agent', 'a');
  chart.setLevel({ price: 2 }, 'agent', 'b');
  chart.setLevel({ price: 3 }, 'human');
  advance(STALE_MS + 1000);

  const keep = chart.housekeeping('a');
  assert.equal(keep.mine, 1);
  assert.equal(keep.others, 1);
  assert.equal(keep.human, 1);
  assert.equal(keep.stale, 2, 'both agent levels aged past the cutoff');
  assert.match(keep.hint, /chart_clear what:'stale'/);
  assert.match(keep.hint, /chart_clear what:'mine'/);
});

test('housekeeping says nothing needs clearing when nothing does', () => {
  const { chart } = storeAt(1_000_000);
  assert.equal(chart.housekeeping('a').hint, 'nothing needs clearing');
});

test('housekeeping reports how full the caps are before a refusal happens', () => {
  const { chart } = storeAt(1_000_000);
  chart.addIndicator({ type: 'rsi' }, 'agent', 'a');
  chart.addIndicator({ type: 'macd' }, 'agent', 'a');
  chart.addIndicator({ type: 'atr' }, 'agent', 'a');
  const keep = chart.housekeeping('a');
  assert.equal(keep.capacity.panes, '3/3');
  assert.match(keep.hint, /sub-panes are full/);
  assert.match(keep.hint, /indicator_read/);
});

test('every object records who drew it, on what, and when', () => {
  const { chart } = storeAt(1_000_000);
  chart.setView({ timeframe: '1h' }, 'human');
  chart.setLevel({ price: 63000 }, 'agent', 'session-7');
  const level = chart.state().levels[0];
  assert.equal(level?.by, 'session-7');
  assert.equal(level?.product, 'BTC-USD');
  assert.equal(level?.granularitySec, 3600);
  assert.equal(level?.createdAt, 1_000_000);
});

test('a human drawing carries no agent id, whatever is passed for one', () => {
  const { chart } = storeAt(1_000_000);
  chart.setLevel({ price: 1 }, 'human', 'session-7');
  assert.equal(chart.state().levels[0]?.by, null);
});

test('the chart records which agent last moved it', () => {
  const { chart } = storeAt(1_000_000);
  chart.setView({ timeframe: '4h' }, 'agent', 'session-7');
  assert.equal(chart.state().lastDriver, 'agent');
  assert.equal(chart.state().lastDriverBy, 'session-7');
  chart.setView({ timeframe: '1h' }, 'human');
  assert.equal(chart.state().lastDriverBy, null, 'a human is not an agent id');
});

test('an unknown clear target names the ones that exist', () => {
  const { chart } = storeAt(1_000_000);
  const out = chart.clear('everything');
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /mine/);
  assert.match(out.error ?? '', /stale/);
});
