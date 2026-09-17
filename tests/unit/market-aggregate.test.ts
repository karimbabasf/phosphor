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
  bucketEnd,
  bucketStart,
  chooseBase,
  formatTimeframe,
  MAX_TIMEFRAME_SEC,
  MONTH_SEC,
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
  assert.equal(parseTimeframe('banana'), null);
  assert.equal(parseTimeframe(''), null);
  assert.equal(parseTimeframe('0m'), null);
  assert.equal(parseTimeframe('-5m'), null);
  assert.equal(parseTimeframe('99w'), null, 'past a week the only bucket is the month');
  assert.equal(parseTimeframe('2w'), null);
  assert.equal(parseTimeframe('30d'), null, 'a fixed thirty days is what the month sentinel exists to not be');
  assert.equal(parseTimeframe(2_000_000), null);
  assert.equal(parseTimeframe('2M'), null, 'two months is not a bucket any venue or person keeps');
});

test('1M is a calendar month and 1m is a minute: the one case-sensitive letter', () => {
  // The month is not a fixed number of seconds, so it travels as one sentinel that every
  // bucketing step recognises and answers with the calendar.
  assert.equal(parseTimeframe('1M'), MONTH_SEC);
  assert.equal(parseTimeframe('1mo'), MONTH_SEC);
  assert.equal(parseTimeframe('1 month'), MONTH_SEC);
  assert.equal(parseTimeframe('1m'), 60);
  assert.equal(parseTimeframe('1 minute'), 60);
  assert.equal(parseTimeframe(MONTH_SEC), MONTH_SEC);
  assert.equal(MAX_TIMEFRAME_SEC, MONTH_SEC);
  assert.equal(formatTimeframe(MONTH_SEC), '1M');
});

test('a label prefers the largest unit that divides cleanly', () => {
  assert.equal(formatTimeframe(3600), '1h');
  assert.equal(formatTimeframe(420), '7m');
  assert.equal(formatTimeframe(90), '90s');
  assert.equal(formatTimeframe(86_400), '1d');
  assert.equal(formatTimeframe(604_800), '1w');
});

test('a month opens on the first of the month at UTC midnight and closes on the next first', () => {
  const midFeb = Math.floor(Date.UTC(2026, 1, 15, 12, 0, 0) / 1000);
  assert.equal(new Date(bucketStart(midFeb, MONTH_SEC) * 1000).toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(new Date(bucketEnd(bucketStart(midFeb, MONTH_SEC), MONTH_SEC) * 1000).toISOString(), '2026-03-01T00:00:00.000Z');
  const newYearsEve = Math.floor(Date.UTC(2026, 11, 31, 23, 59, 0) / 1000);
  assert.equal(new Date(bucketStart(newYearsEve, MONTH_SEC) * 1000).toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(new Date(bucketEnd(bucketStart(newYearsEve, MONTH_SEC), MONTH_SEC) * 1000).toISOString(), '2027-01-01T00:00:00.000Z');
  // Every other step is a fixed number of seconds.
  assert.equal(bucketEnd(1_700_000_000, 60), 1_700_000_060);
});

test('daily bars fold into calendar months, February with its twenty eight days', () => {
  const days: Candle[] = [];
  const start = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  for (let i = 0; i < 90; i++) days.push({ t: start + i * 86_400, o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i, v: 1 });
  const months = aggregate(days, 86_400, MONTH_SEC);
  assert.equal(months.length, 3);
  assert.deepEqual(
    months.map((m) => new Date(m.t * 1000).toISOString().slice(0, 10)),
    ['2026-01-01', '2026-02-01', '2026-03-01'],
  );
  const feb = months[1] as Candle;
  assert.equal(feb.o, 100 + 31, 'opens on the first of February');
  assert.equal(feb.c, 105 + 31 + 27, 'closes on the twenty eighth');
  assert.equal(feb.v, 28, 'twenty eight days of volume');
  assert.equal((months[2] as Candle).v, 90 - 31 - 28, 'the forming March bar holds what it has');
});

test('a month is built from days on either venue, never from a base that straddles a month', () => {
  const hyperliquid = [60, 180, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 43_200, 86_400, 259_200];
  const coinbase = [60, 300, 900, 3600, 21_600, 86_400];
  assert.equal(chooseBase(MONTH_SEC, hyperliquid), 86_400);
  assert.equal(chooseBase(MONTH_SEC, coinbase), 86_400);
  assert.equal(chooseBase(604_800, hyperliquid), 86_400, 'a week folds from days, so it opens on Monday everywhere');
  assert.ok(baseBarsNeeded(12, 86_400, MONTH_SEC) >= 12 * 31, 'a year of months needs a year of days');
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
