// The watcher: what the venue cannot hold, evaluated on closed bars and nothing else.
//
// Pure, because it is the one piece of the runner that decides WHEN money moves and the only
// honest way to test that is with bars written by hand. Nothing is at risk while it waits: a
// plan whose conditions do not hold has placed no order.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, MIN_BARS, STALE_MS } from '../../src/trade/watch.ts';
import type { Bar, MarketView } from '../../src/trade/watch.ts';
import type { Plan, Condition } from '../../src/trade/plan.ts';

const NOW = 1_786_492_800_000;

function bars(n: number, last: Partial<Bar> = {}, v = 100): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ t: 1_000 + i * 900, o: 100, h: 101, l: 99, c: 100, v });
  }
  const tail = out[out.length - 1];
  if (tail !== undefined) Object.assign(tail, last);
  return out;
}

function plan(when: Condition[]): Plan {
  return {
    id: 'pl_1',
    symbol: 'BTC',
    side: 'long',
    sizeUsd: 100,
    leverage: 5,
    entry: { type: 'market', maxSlippageBps: 30 },
    stop: 90,
    expiresAt: '2026-09-12T00:00:00.000Z',
    when,
  };
}

function view(over: Partial<MarketView> = {}): MarketView {
  return { nowMs: NOW, mark: 100, freshMs: 500, bars: { '15m': bars(30) }, ...over };
}

test('no conditions holds at once', () => {
  const out = evaluate(plan([]), view());
  assert.equal(out.holds, true);
  assert.deepEqual(out.per, []);
  assert.equal(out.blind, false);
});

test('a close above or below reads the last CLOSED bar', () => {
  const above: Condition = { type: 'close', tf: '15m', is: 'above', at: { px: 100.5 } };
  assert.equal(evaluate(plan([above]), view({ bars: { '15m': bars(30, { c: 101 }) } })).holds, true);
  assert.equal(evaluate(plan([above]), view({ bars: { '15m': bars(30, { c: 100 }) } })).holds, false);
  const below: Condition = { type: 'close', tf: '15m', is: 'below', at: { px: 99.5 } };
  assert.equal(evaluate(plan([below]), view({ bars: { '15m': bars(30, { c: 99 }) } })).holds, true);
  assert.equal(evaluate(plan([below]), view({ bars: { '15m': bars(30, { c: 100 }) } })).holds, false);
});

test('a wick through is a reclaim: the bar went past the level and closed back on the right side', () => {
  const reclaim: Condition = { type: 'close', tf: '15m', is: 'above', at: { px: 99.5 }, wick: 'through' };
  // Low went under 99.5, close came back above it.
  assert.equal(evaluate(plan([reclaim]), view({ bars: { '15m': bars(30, { l: 99, c: 100 }) } })).holds, true);
  // Closed above but never went under: no reclaim happened.
  assert.equal(evaluate(plan([reclaim]), view({ bars: { '15m': bars(30, { l: 99.8, c: 100 }) } })).holds, false);
  // Went under and stayed under.
  assert.equal(evaluate(plan([reclaim]), view({ bars: { '15m': bars(30, { l: 99, c: 99.2 }) } })).holds, false);

  const rejection: Condition = { type: 'close', tf: '15m', is: 'below', at: { px: 100.5 }, wick: 'through' };
  assert.equal(evaluate(plan([rejection]), view({ bars: { '15m': bars(30, { h: 101, c: 100 }) } })).holds, true);
  assert.equal(evaluate(plan([rejection]), view({ bars: { '15m': bars(30, { h: 100.2, c: 100 }) } })).holds, false);
});

test('volume compares the last closed bar with the mean of the twenty before it', () => {
  const heavy: Condition = { type: 'volume', tf: '15m', atLeast: 1.5 };
  assert.equal(evaluate(plan([heavy]), view({ bars: { '15m': bars(30, { v: 150 }) } })).holds, true);
  assert.equal(evaluate(plan([heavy]), view({ bars: { '15m': bars(30, { v: 149 }) } })).holds, false);
});

test('a time window holds between after and before', () => {
  const window: Condition = { type: 'time', after: new Date(NOW - 1000).toISOString(), before: new Date(NOW + 1000).toISOString() };
  assert.equal(evaluate(plan([window]), view()).holds, true);
  assert.equal(evaluate(plan([window]), view({ nowMs: NOW + 2000 })).holds, false);
  assert.equal(evaluate(plan([window]), view({ nowMs: NOW - 2000 })).holds, false);
  const bad: Condition = { type: 'time', after: 'soon' };
  assert.equal(evaluate(plan([bad]), view()).holds, false, 'an unreadable time never holds');
});

test('a drawn line is read at the bar time through lineAt, and an unknown line never holds', () => {
  const line: Condition = { type: 'close', tf: '15m', is: 'above', at: { line: 'tl_3' } };
  const v = view({ bars: { '15m': bars(30, { c: 101 }) }, lineAt: (id, t) => (id === 'tl_3' ? 100 + (t > 0 ? 0.5 : 0) : null) });
  assert.equal(evaluate(plan([line]), v).holds, true);
  assert.equal(evaluate(plan([line]), view({ bars: { '15m': bars(30, { c: 101 }) }, lineAt: () => null })).holds, false);
  assert.equal(evaluate(plan([line]), view({ bars: { '15m': bars(30, { c: 101 }) } })).holds, false, 'no lineAt at all');
});

test('every condition must hold, and each is reported by name', () => {
  const both: Condition[] = [
    { type: 'close', tf: '15m', is: 'above', at: { px: 100.5 } },
    { type: 'volume', tf: '15m', atLeast: 1.5 },
  ];
  const out = evaluate(plan(both), view({ bars: { '15m': bars(30, { c: 101, v: 100 }) } }));
  assert.equal(out.holds, false);
  assert.equal(out.per.length, 2);
  assert.equal(out.per[0].holds, true);
  assert.equal(out.per[1].holds, false);
  assert.match(out.per[0].condition, /closes above/);
  assert.match(out.per[1].condition, /volume/);
});

test('a stale feed is blind: nothing holds and the reason is named', () => {
  const out = evaluate(plan([]), view({ freshMs: STALE_MS + 1 }));
  assert.equal(out.blind, true);
  assert.equal(out.holds, false);
  assert.equal(evaluate(plan([]), view({ freshMs: STALE_MS })).blind, false);
});

test('too few closed bars means the condition does not hold, and that is not blindness', () => {
  const above: Condition = { type: 'close', tf: '1h', is: 'above', at: { px: 1 } };
  const out = evaluate(plan([above]), view({ bars: { '1h': bars(MIN_BARS - 1, { c: 200 }) } }));
  assert.equal(out.holds, false);
  assert.equal(out.blind, false);
  const missing = evaluate(plan([above]), view({ bars: {} }));
  assert.equal(missing.holds, false);
  assert.equal(missing.blind, false);
});
