// The timeframe engine, which is the whole reason an agent can ask for 7m and get 7m.
//
// The week test is the one that matters most. Epoch second zero was a Thursday, so the
// obvious implementation opens every weekly bar on a Thursday and disagrees with every
// venue. That bug is invisible on a 1m chart and glaring on a 1w one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '../../src/types.ts';
import {
  aggregate,
  baseBarsNeeded,
  bucketStart,
  chooseBase,
  formatTimeframe,
  parseTimeframe,
} from '../../src/market/aggregate.ts';

// A minute series starting on an hour boundary, which is also a 5m and 1m boundary.
// Starting mid-bucket is a real case and gets its own test rather than muddying these.
function minutes(count: number, startSec = 1_699_999_200): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ t: startSec + i * 60, o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i, v: 2 });
  }
  return out;
}

test('a timeframe is read the way a person writes it', () => {
  assert.equal(parseTimeframe('7m'), 420);
  assert.equal(parseTimeframe('90s'), 90);
  assert.equal(parseTimeframe('2h'), 7200);
  assert.equal(parseTimeframe('1d'), 86_400);
  assert.equal(parseTimeframe('1w'), 604_800);
  assert.equal(parseTimeframe('15 minutes'), 900);
  assert.equal(parseTimeframe('4 hours'), 14_400);
  assert.equal(parseTimeframe('45'), 45);
  assert.equal(parseTimeframe(300), 300);
});

test('a timeframe nobody can serve is refused rather than guessed', () => {
  assert.equal(parseTimeframe('1M'), 60, 'lowercased M is minutes, which is what a person means');
  assert.equal(parseTimeframe('banana'), null);
  assert.equal(parseTimeframe(''), null);
  assert.equal(parseTimeframe('0m'), null);
  assert.equal(parseTimeframe('-5m'), null);
  assert.equal(parseTimeframe('99w'), null, 'past a week there is no venue history to fold');
});

test('a label prefers the largest unit that divides cleanly', () => {
  assert.equal(formatTimeframe(3600), '1h');
  assert.equal(formatTimeframe(420), '7m');
  assert.equal(formatTimeframe(90), '90s');
  assert.equal(formatTimeframe(86_400), '1d');
  assert.equal(formatTimeframe(604_800), '1w');
});

test('folding minutes into 5m keeps open, close and the extremes', () => {
  const folded = aggregate(minutes(10), 60, 300);
  assert.equal(folded.length, 2);

  const first = folded[0] as Candle;
  assert.equal(first.o, 100, 'open comes from the first bar in the bucket');
  assert.equal(first.c, 109, 'close comes from the last bar in the bucket');
  assert.equal(first.h, 114, 'high is the highest high across the bucket');
  assert.equal(first.l, 90, 'low is the lowest low across the bucket');
  assert.equal(first.v, 10, 'volume sums');
});

test('folding is exact for a timeframe no venue serves', () => {
  const folded = aggregate(minutes(21), 60, 420);
  // 21 one-minute bars is exactly three 7m buckets when the start is bucket-aligned.
  assert.ok(folded.length >= 3 && folded.length <= 4);
  for (const bar of folded) {
    assert.equal(bar.t % 420, 0, 'every bucket opens on a multiple of the timeframe');
    assert.ok(bar.h >= bar.o && bar.h >= bar.c, 'high bounds the body');
    assert.ok(bar.l <= bar.o && bar.l <= bar.c, 'low bounds the body');
  }
});

test('a week opens on Monday, not on the epoch Thursday', () => {
  // 2023-11-16 was a Thursday. Its week must open on Monday 2023-11-13.
  const thursday = Math.floor(Date.UTC(2023, 10, 16, 12, 0, 0) / 1000);
  const open = bucketStart(thursday, 604_800);
  const asDate = new Date(open * 1000);
  assert.equal(asDate.getUTCDay(), 1, 'weekly bars open on a Monday');
  assert.equal(asDate.getUTCHours(), 0);
  assert.equal(asDate.toISOString().slice(0, 10), '2023-11-13');
});

test('a day opens at UTC midnight', () => {
  const midday = Math.floor(Date.UTC(2023, 10, 16, 13, 45, 0) / 1000);
  const open = bucketStart(midday, 86_400);
  assert.equal(new Date(open * 1000).toISOString(), '2023-11-16T00:00:00.000Z');
});

test('an empty bucket is left out rather than filled with an invented bar', () => {
  // A gap: minutes 0 and 1, then a jump past a whole 5m bucket.
  const gapped: Candle[] = [
    { t: 1_700_000_000, o: 1, h: 2, l: 1, c: 2, v: 1 },
    { t: 1_700_000_060, o: 2, h: 3, l: 2, c: 3, v: 1 },
    { t: 1_700_000_000 + 600, o: 9, h: 9, l: 9, c: 9, v: 1 },
  ];
  const folded = aggregate(gapped, 60, 300);
  assert.equal(folded.length, 2, 'two buckets have data, the empty one is not fabricated');
});

test('asking for a finer timeframe than the base returns the base untouched', () => {
  const base = minutes(5);
  const folded = aggregate(base, 60, 30);
  assert.equal(folded.length, base.length, 'detail cannot be invented by folding');
});

test('the base to fetch prefers an exact divisor of the ask', () => {
  const natives = [60, 180, 300, 900, 1800, 3600, 14_400, 86_400];
  assert.equal(chooseBase(420, natives), 60, '7m folds exactly from 1m');
  assert.equal(chooseBase(900, natives), 900, 'a native ask needs no folding');
  assert.equal(chooseBase(7200, natives), 3600, '2h folds exactly from 1h');
  assert.equal(chooseBase(2700, natives), 900, '45m folds exactly from 15m');
  assert.equal(chooseBase(30, natives), null, 'nothing native is fine enough to fold down');
});

test('the base bar count covers the partial bucket at each end', () => {
  assert.ok(baseBarsNeeded(100, 60, 300) >= 500, 'a hundred 5m bars need at least five hundred 1m bars');
  assert.equal(baseBarsNeeded(10, 60, 60), 12, 'no folding still leaves a bar of margin each side');
});
