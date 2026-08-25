// Structure as boxes and events, checked against series built so the answer is known first.
//
// These are the measurements a trader means by order block, fair value gap, liquidity and a
// break of structure. Each one has a definition (see the header of src/analysis/structure.ts)
// and the tests below are that definition, not a description of what the code happens to do.
//
// The last test is the one that guards the design: none of this returns a conclusion.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  orderBlocks,
  fairValueGaps,
  liquiditySwings,
  structureBreaks,
} from '../../src/analysis/structure.ts';
import type { Candle } from '../../src/types.ts';

let clock = 1_700_000_000;

function bar(o: number, h: number, l: number, c: number, v = 100): Candle {
  clock += 3600;
  return { t: clock, o, h, l, c, v };
}

// A market that rises to a swing high, pulls back, and then closes through that high. The
// pullback's last down candle is the demand block; the bar that closes through is the break.
function breakoutSeries(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 6; i++) out.push(bar(100 + i, 101 + i, 99 + i, 100.5 + i));
  out.push(bar(106, 110, 105, 109)); // the swing high, at 110
  for (let i = 0; i < 4; i++) out.push(bar(108 - i, 108.5 - i, 104 - i, 105 - i)); // down candles
  out.push(bar(101, 103, 100, 102));
  out.push(bar(102, 112, 101, 111)); // closes through 110
  for (let i = 0; i < 4; i++) out.push(bar(111 + i, 113 + i, 110 + i, 112 + i));
  return out;
}

test('a bar that closes through a swing high is a break, with the swing it broke', () => {
  const found = structureBreaks(breakoutSeries(), { window: 2 });
  assert.ok(found.length > 0, 'nothing broke, in a series built to break');
  const up = found.find((b) => b.direction === 'up');
  assert.ok(up, 'the close through the high was not seen');
  assert.ok(up.swingPrice > 0);
  assert.ok(up.closedBy > 0);
  assert.equal(up.kind, 'continuation', 'the first break has nothing to have changed from');
});

test('a break the other way from the last one is a change, not a continuation', () => {
  const series = [
    ...breakoutSeries(),
    // Then it gives all of it back and closes under the pullback low.
    ...Array.from({ length: 12 }, (_, i) => bar(115 - i * 2, 116 - i * 2, 112 - i * 2, 113 - i * 2)),
  ];
  const found = structureBreaks(series, { window: 2 });
  const down = found.filter((b) => b.direction === 'down');
  assert.ok(down.length > 0, 'the market fell through its lows and nothing recorded it');
  assert.equal(down[0]?.kind, 'change', 'the first break the other way is a change of direction');
});

test('an order block is the last opposite candle before the break, with its revisits counted', () => {
  const blocks = orderBlocks(breakoutSeries(), { window: 2 });
  assert.ok(blocks.length > 0);
  const demand = blocks.find((b) => b.side === 'demand');
  assert.ok(demand, 'a break upwards leaves a demand block behind it');
  assert.ok(demand.high > demand.low, 'a block is a box, so it has height');
  assert.ok(demand.brokeIndex > demand.index, 'the block comes before the bar that broke');
  assert.equal(typeof demand.revisits, 'number');
  assert.equal(typeof demand.intact, 'boolean');
});

test('a block price has closed the whole way through is not intact any more', () => {
  const series = [
    ...breakoutSeries(),
    ...Array.from({ length: 14 }, (_, i) => bar(114 - i * 3, 115 - i * 3, 110 - i * 3, 111 - i * 3)),
  ];
  const blocks = orderBlocks(series, { window: 2 });
  assert.ok(blocks.some((b) => !b.intact), 'a collapse through every block left them all intact');
});

test('a three-candle gap is found, and its height is the gap and not the candles', () => {
  const gapped = [
    bar(100, 101, 99, 100),
    bar(101, 108, 100, 107), // the wide middle bar
    bar(107, 110, 105, 109), // low 105 is above the first bar's high 101
    bar(109, 111, 108, 110),
  ];
  const gaps = fairValueGaps(gapped);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.direction, 'up');
  assert.equal(gaps[0]?.low, 101);
  assert.equal(gaps[0]?.high, 105);
  assert.equal(gaps[0]?.remaining, 1, 'nothing has traded back into it');
  assert.equal(gaps[0]?.filledAt, null);
});

test('a gap price has traded all the way back through reports as filled', () => {
  const gapped = [
    bar(100, 101, 99, 100),
    bar(101, 108, 100, 107),
    bar(107, 110, 105, 109),
    bar(109, 110, 100, 101), // back down through 101
  ];
  const gaps = fairValueGaps(gapped);
  assert.equal(gaps[0]?.remaining, 0);
  assert.ok(gaps[0]?.filledAt !== null);
});

test('overlapping candles are not a gap, however big the move is', () => {
  const trending = Array.from({ length: 20 }, (_, i) => bar(100 + i, 104 + i, 99 + i, 103 + i));
  assert.deepEqual(fairValueGaps(trending), []);
});

test('two swing highs at the same price are one shelf, and taking it is recorded', () => {
  const equalHighs = [
    ...Array.from({ length: 4 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 100 + i)),
    bar(103, 110, 102, 104), // first high at 110
    ...Array.from({ length: 4 }, (_, i) => bar(104 - i, 105 - i, 101 - i, 102 - i)),
    bar(101, 110, 100, 103), // second high at the same 110
    ...Array.from({ length: 4 }, (_, i) => bar(103 - i, 104 - i, 100 - i, 101 - i)),
    bar(100, 115, 99, 114), // through it
    ...Array.from({ length: 3 }, (_, i) => bar(114 + i, 116 + i, 113 + i, 115 + i)),
  ];
  const levels = liquiditySwings(equalHighs, { window: 2 });
  const shelf = levels.find((l) => l.kind === 'high' && Math.abs(l.price - 110) < 0.001);
  assert.ok(shelf, 'two highs at one price did not group into a shelf');
  assert.ok(shelf.touches >= 2);
  assert.equal(shelf.taken, true);
  assert.ok(shelf.takenAt !== null);
});

test('a shelf nothing has traded through is reported as still standing', () => {
  const untaken = [
    ...Array.from({ length: 4 }, (_, i) => bar(100 + i, 101 + i, 99 + i, 100 + i)),
    bar(103, 120, 102, 104),
    ...Array.from({ length: 8 }, (_, i) => bar(104 - i, 105 - i, 100 - i, 101 - i)),
  ];
  const levels = liquiditySwings(untaken, { window: 2 });
  const top = levels.find((l) => l.kind === 'high' && l.price === 120);
  assert.ok(top);
  assert.equal(top.taken, false);
  assert.equal(top.takenAt, null);
});

test('an empty or tiny series returns nothing rather than throwing', () => {
  for (const candles of [[], [bar(1, 2, 0, 1)], [bar(1, 2, 0, 1), bar(1, 2, 0, 1)]]) {
    assert.deepEqual(orderBlocks(candles), []);
    assert.deepEqual(structureBreaks(candles), []);
    assert.ok(Array.isArray(fairValueGaps(candles)));
    assert.ok(Array.isArray(liquiditySwings(candles)));
  }
});

test('a limit is respected, so a long history cannot flood one answer', () => {
  const long = Array.from({ length: 400 }, (_, i) =>
    bar(100 + Math.sin(i / 4) * 10, 106 + Math.sin(i / 4) * 10, 94 + Math.sin(i / 4) * 10, 101 + Math.sin(i / 4) * 10),
  );
  assert.ok(orderBlocks(long, { limit: 5 }).length <= 5);
  assert.ok(fairValueGaps(long, { limit: 5 }).length <= 5);
  assert.ok(liquiditySwings(long, { limit: 5 }).length <= 5);
});

test('none of it returns a conclusion, only extents and counts', () => {
  // The same rule tests/unit/analysis-ops.test.ts holds the rest of src/analysis to.
  const banned = ['signal', 'score', 'recommendation', 'action', 'confidence', 'rating', 'advice', 'bullish', 'bearish'];
  const series = breakoutSeries();
  const text = JSON.stringify({
    orderBlocks: orderBlocks(series),
    gaps: fairValueGaps(series),
    liquidity: liquiditySwings(series),
    structure: structureBreaks(series),
  }).toLowerCase();
  for (const word of banned) {
    assert.ok(!text.includes(word), `structure returned a ${word}, which is a conclusion`);
  }
});
