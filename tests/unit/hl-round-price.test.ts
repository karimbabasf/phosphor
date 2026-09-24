import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggressiveLimitPrice, stopLimitPx } from '../../src/hl/exchange.ts';
import { formatPrice, roundToValidPrice } from '../../src/hl/format.ts';

// The exact number that killed the first live order this code ever attempted.
const LIVE_FAILURE = 63980.30999999999;

test('the price that broke the first live order now formats', () => {
  const px = roundToValidPrice(LIVE_FAILURE, 5, true, true);
  assert.equal(px, 63980, 'five figures leaves no room for decimals, and integers are always valid');
  assert.doesNotThrow(() => formatPrice(px, 5, true));
});

test('a buy rounds down and a sell rounds up, so neither breaches its bound', () => {
  // A buy limit is the MOST it may pay; a sell limit the LEAST it may accept. Rounding the
  // other way would push the fill past the bound the human approved.
  assert.ok(roundToValidPrice(LIVE_FAILURE, 5, true, true) <= LIVE_FAILURE);
  assert.ok(roundToValidPrice(LIVE_FAILURE, 5, true, false) >= LIVE_FAILURE);
  assert.equal(roundToValidPrice(LIVE_FAILURE, 5, true, false), 63981);
});

test('a low-priced asset keeps the decimals it is allowed', () => {
  // ETH at szDecimals 4 allows 2 decimals, and 4 figures before the point leaves 1 by the
  // significant-figure rule, so the tighter one wins.
  const px = roundToValidPrice(1901.02999, 4, true, true);
  assert.doesNotThrow(() => formatPrice(px, 4, true));
  assert.ok(px <= 1901.02999);
});

test('every rounded price survives the formatter across a range of assets', () => {
  const cases = [
    { px: 63980.30999999999, szDecimals: 5 },
    { px: 1901.0299999, szDecimals: 4 },
    { px: 0.0012345678, szDecimals: 1 },
    { px: 12.3456789, szDecimals: 2 },
    { px: 99999.999, szDecimals: 5 },
  ];
  for (const c of cases) {
    for (const isBuy of [true, false]) {
      const px = roundToValidPrice(c.px, c.szDecimals, true, isBuy);
      assert.doesNotThrow(
        () => formatPrice(px, c.szDecimals, true),
        `${c.px} @ szDecimals ${c.szDecimals} isBuy=${isBuy} produced ${px}`,
      );
    }
  }
});

test('an already-valid price is left alone', () => {
  assert.equal(roundToValidPrice(63980, 5, true, true), 63980);
});

// ---------- under a dollar ----------
//
// The venue allows 5 significant figures and at most 6 - szDecimals decimals on a perp. Under a
// dollar the leading zeros are places, not figures: 0.000585 at szDecimals 0 has six decimals
// to spend and uses three figures of them. Counting the leading 0 as a whole digit allowed four
// decimals, one or two figures, and moved sub-cent prices by whole percents.

test('a price under a dollar keeps its significant figures, within the decimals the coin allows', () => {
  // MEME at szDecimals 0: six decimals.
  assert.equal(roundToValidPrice(0.00058575, 0, true, true), 0.000585);
  assert.equal(roundToValidPrice(0.00058575, 0, true, false), 0.000586);
  // BLUR at szDecimals 0: five figures fit inside six decimals.
  assert.equal(roundToValidPrice(0.0193288, 0, true, true), 0.019328);
  // szDecimals 1: five decimals, so the figures run out first at 0.12345.
  assert.equal(roundToValidPrice(0.1234567, 1, true, true), 0.12345);
  assert.equal(roundToValidPrice(0.1234567, 1, true, false), 0.12346);
  // Spot allows eight less szDecimals.
  assert.equal(roundToValidPrice(0.000123456, 0, false, true), 0.00012345);
});

test('a price already on the grid comes back exactly as approved, whichever way it would round', () => {
  const onGrid: Array<[number, number]> = [
    [0.000555, 0],
    [0.00335, 0],
    [0.02018, 0],
    [0.1, 1],
    [1.2345, 2],
    [12.345, 1],
    [1901.3, 4],
    [63980, 5],
    [123456, 0],
  ];
  for (const [px, sz] of onGrid) {
    assert.doesNotThrow(() => formatPrice(px, sz, true), `${px} is on the grid at szDecimals ${sz}`);
    assert.equal(roundToValidPrice(px, sz, true, true), px, `${px} buy`);
    assert.equal(roundToValidPrice(px, sz, true, false), px, `${px} sell`);
  }
});

// The perps as the venue listed them, marks included, read over the public info API on
// 2026-09-23. Replayed offline: nothing here reaches the network.
const LIVE = JSON.parse(readFileSync(new URL('../fixtures/hl-perp-marks-2026-09-23.json', import.meta.url), 'utf8')) as {
  readAt: string;
  perps: { name: string; szDecimals: number; markPx: string }[];
};

// One step of the grid at this price: the finest price change the venue accepts there.
function tickAt(px: number, szDecimals: number): number {
  const up = roundToValidPrice(px * 1.0000001, szDecimals, true, false);
  const down = roundToValidPrice(px, szDecimals, true, true);
  return up > down ? up - down : roundToValidPrice(up * 1.0000001, szDecimals, true, false) - down;
}

test('live marks: every perp gets a 30 bp market bound on the grid, inside the bound, and past the mark wherever the grid is finer than the bound', () => {
  assert.ok(LIVE.perps.length > 150, 'the whole list was read');
  const pinned: string[] = [];
  for (const p of LIVE.perps) {
    const mark = Number(p.markPx);
    const buy = roundToValidPrice(aggressiveLimitPrice(mark, true, 30), p.szDecimals, true, true);
    const sell = roundToValidPrice(aggressiveLimitPrice(mark, false, 30), p.szDecimals, true, false);
    assert.doesNotThrow(() => formatPrice(buy, p.szDecimals, true), `${p.name} buy bound ${buy}`);
    assert.doesNotThrow(() => formatPrice(sell, p.szDecimals, true), `${p.name} sell bound ${sell}`);
    assert.ok(buy <= mark * 1.003 * (1 + 1e-12), `${p.name}: the buy bound ${buy} pays more than 30 bp over ${mark}`);
    assert.ok(sell >= mark * 0.997 * (1 - 1e-12), `${p.name}: the sell bound ${sell} accepts less than 30 bp under ${mark}`);
    if (tickAt(mark, p.szDecimals) < mark * 0.003) {
      assert.ok(buy > mark, `${p.name}: buy bound ${buy} at or under the mark ${mark}`);
      assert.ok(sell < mark, `${p.name}: sell bound ${sell} at or over the mark ${mark}`);
    } else {
      pinned.push(p.name);
    }
  }
  // A grid step wider than 30 bp is the venue's own limit, not a rounding fault: the bound sits
  // on the mark and the IOC fills only what rests there. Named so a change in the list is seen.
  assert.ok(pinned.length <= 10, `the grid is coarser than 30 bp on ${pinned.length} perps: ${pinned.join(', ')}`);
});

test('live marks: a long stop placed under the mark stays under it, and its ten percent limit rounds toward the bound (MEME, 0.000555 under 0.000585)', () => {
  const meme = LIVE.perps.find((p) => p.name === 'MEME');
  assert.ok(meme !== undefined);
  const mark = Number(meme.markPx);
  const stop = 0.000555;
  assert.doesNotThrow(() => formatPrice(stop, meme.szDecimals, true), 'the approved stop is on the grid');
  const trigger = roundToValidPrice(stop, meme.szDecimals, true, false);
  assert.equal(trigger, stop, 'placed as approved');
  assert.ok(trigger < mark, `a long's stop ${trigger} must stay under the mark ${mark}`);
  const limit = stopLimitPx(trigger, false, meme.szDecimals);
  assert.equal(limit, 0.0005, 'ten percent under 0.000555 is 0.0004995, and a sell limit rounds up to the grid');
  assert.ok(limit < trigger);
  // Every sub-dollar perp: a stop 5% under the mark, on the grid, is placed where it was approved.
  for (const p of LIVE.perps) {
    const m = Number(p.markPx);
    if (!(m < 1)) continue;
    const approved = roundToValidPrice(m * 0.95, p.szDecimals, true, false);
    assert.equal(roundToValidPrice(approved, p.szDecimals, true, false), approved, `${p.name} stop ${approved}`);
    assert.ok(approved < m, `${p.name}: stop ${approved} under mark ${m}`);
  }
});
