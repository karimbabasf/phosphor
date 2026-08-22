// Price structure as boxes and events: order blocks, fair value gaps, liquidity, and the
// break of a swing.
//
// WHY THESE ARE HERE AND NOT IN THE INDICATOR CATALOGUE. Everything in src/indicators.ts is a
// series: one value per bar, drawn as a line or a histogram. None of the four things below is
// a series. An order block is a rectangle covering some bars and some prices; a gap is a
// rectangle with a hole in it; a swing break is one event at one time. Forcing them into a
// plot would flatten out the part that matters, which is the extent.
//
// So they are MEASUREMENTS on the chart_batch surface, and the agent draws the ones worth
// drawing with `draw kind:zone`. That is the same shape the rest of src/analysis has and it
// keeps one rule: this layer measures, the agent decides what is worth putting in front of a
// human.
//
// WHAT THEY ARE NOT. Not signals. A returned order block is a rectangle with a reason and a
// count of how many times price has been back into it; it is not a place to buy. The vocabulary
// here deliberately avoids bullish, bearish, buy and sell: a demand block that formed under
// price is described as `side: 'demand'` and where it is, and the reading is the agent's job.
// tests/unit/analysis-ops.test.ts scans this output for conclusion-shaped field names.
//
// The definitions are the ordinary published ones, written out so nobody has to guess:
//
//   order block     the last opposite-direction candle before a move that broke structure.
//                   Demand: the last down candle before the swing high above it was taken.
//   fair value gap  three candles where the first and third do not overlap, leaving a price
//                   band that traded through in one bar and never traded back in.
//   liquidity       a swing high or low that several bars have come within a tolerance of.
//                   Equal highs are the case everyone means by it.
//   structure break the bar that closed through the previous swing high or low, with which
//                   swing it broke and by how much.

import type { Candle } from '../types.ts';
import { pivots, type Pivot } from './pivots.ts';

export type OrderBlock = {
  id: string;
  // 'demand' formed below a move up, 'supply' above a move down. Named for what the box IS,
  // not for what a trader should do about it.
  side: 'demand' | 'supply';
  index: number;
  t: number;
  low: number;
  high: number;
  // The bar whose close broke the swing this block belongs to, which is what makes it a block
  // rather than just an opposite candle.
  brokeAt: number;
  brokeIndex: number;
  // How many later bars have traded back inside the box. A box price has never returned to is
  // a different object from one it has been through four times, and only the count says which.
  revisits: number;
  // True while no later bar has closed the whole way through the box.
  intact: boolean;
};

export type FairValueGap = {
  id: string;
  direction: 'up' | 'down';
  index: number;
  t: number;
  low: number;
  high: number;
  // What is left of the gap after later bars have traded into it, as a fraction of its
  // original height. 1 is untouched, 0 is completely filled.
  remaining: number;
  filledAt: number | null;
};

export type LiquidityLevel = {
  id: string;
  kind: 'high' | 'low';
  price: number;
  // Every bar that came within the tolerance of this price. Two is an equal high; six is a
  // shelf.
  touches: number;
  firstT: number;
  lastT: number;
  // True once a later bar traded through it, which is the whole reason to have marked it.
  taken: boolean;
  takenAt: number | null;
};

export type StructureBreak = {
  index: number;
  t: number;
  direction: 'up' | 'down';
  // The swing that was broken and where it was.
  swingT: number;
  swingPrice: number;
  closedBy: number;
  closedByPct: number;
  // 'continuation' when the previous break went the same way, 'change' when it did not. The
  // pair of words traders use for this is BOS and CHoCH; these are the same two facts without
  // the initialisms, because an agent reading `change` needs no glossary.
  kind: 'continuation' | 'change';
};

export type StructureOptions = {
  window: number;
  minProminence: number;
  tolerance: number;
  limit: number;
};

const DEFAULTS: StructureOptions = { window: 2, minProminence: 0, tolerance: 0, limit: 12 };

function opts(given: Partial<StructureOptions>): StructureOptions {
  return {
    window: given.window ?? DEFAULTS.window,
    minProminence: given.minProminence ?? DEFAULTS.minProminence,
    // Zero means "work it out from the data", and the data's own answer is a fraction of the
    // window's range. A fixed tolerance in dollars is wrong on every instrument but one.
    tolerance: given.tolerance ?? DEFAULTS.tolerance,
    limit: Math.max(1, Math.min(200, Math.round(given.limit ?? DEFAULTS.limit))),
  };
}

function autoTolerance(candles: Candle[], given: number): number {
  if (given > 0) return given;
  if (candles.length === 0) return 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
  }
  // A tenth of a percent of the window's range. Small enough that two genuinely different
  // levels stay apart, wide enough that two ticks of noise do not split one shelf into two.
  return (hi - lo) * 0.001;
}

// The swing breaks, oldest first. Everything else in this file is derived from these, so they
// are computed once and shared rather than three times with three slightly different windows.
export function structureBreaks(
  candles: Candle[],
  given: Partial<StructureOptions> = {},
): StructureBreak[] {
  const o = opts(given);
  const found = pivots(candles, { window: o.window, minProminence: o.minProminence });
  const raw: Omit<StructureBreak, 'kind'>[] = [];

  for (const pivot of found) {
    // A swing is only breakable by a bar that came after it AND after the bars that confirmed
    // it. Scanning from pivot.index would let the confirming bars break their own swing.
    const from = pivot.index + o.window + 1;
    for (let i = from; i < candles.length; i++) {
      const c = candles[i] as Candle;
      const broke = pivot.kind === 'high' ? c.c > pivot.price : c.c < pivot.price;
      if (!broke) continue;
      const closedBy = Math.abs(c.c - pivot.price);
      raw.push({
        index: i,
        t: c.t,
        direction: pivot.kind === 'high' ? 'up' : 'down',
        swingT: pivot.t,
        swingPrice: pivot.price,
        closedBy,
        closedByPct: pivot.price === 0 ? 0 : (closedBy / pivot.price) * 100,
      });
      break;
    }
  }

  raw.sort((a, b) => a.index - b.index);
  // The same bar can break more than one swing: two pivots a tick apart are taken by one close,
  // and one bar breaking structure is one event.
  const seen = new Set<number>();
  const ordered = raw.filter((b) => (seen.has(b.index) ? false : (seen.add(b.index), true)));

  /* Continuation or change is decided HERE, after the sort, and that ordering is the whole
     correctness of the field. Deciding it inside the loop above compares each break with the
     previous PIVOT's break, and pivots are found in the order their swings formed, not in the
     order the breaks happened: a low swing that formed early can be broken long after a high
     swing that formed later. Read in pivot order, a market that went up and then down could
     report the down break as a continuation of a break that had not happened yet. */
  let previous: 'up' | 'down' | null = null;
  return ordered.map((b) => {
    const kind: StructureBreak['kind'] = previous === null || previous === b.direction ? 'continuation' : 'change';
    previous = b.direction;
    return { ...b, kind };
  });
}

export function orderBlocks(
  candles: Candle[],
  given: Partial<StructureOptions> = {},
): OrderBlock[] {
  const o = opts(given);
  const breaks = structureBreaks(candles, given);
  const out: OrderBlock[] = [];

  for (const brk of breaks) {
    // Walk back from the breaking bar for the last candle that went the other way. That candle
    // is the block; if there is none inside a sane distance, this break has no block and is
    // reported by structureBreaks alone rather than invented here.
    const wantDown = brk.direction === 'up';
    let found = -1;
    for (let i = brk.index - 1; i >= Math.max(0, brk.index - 30); i--) {
      const c = candles[i] as Candle;
      const isDown = c.c < c.o;
      if (wantDown === isDown) {
        found = i;
        break;
      }
    }
    if (found < 0) continue;
    const c = candles[found] as Candle;
    const low = c.l;
    const high = c.h;
    let revisits = 0;
    let intact = true;
    for (let i = brk.index + 1; i < candles.length; i++) {
      const later = candles[i] as Candle;
      if (later.l <= high && later.h >= low) revisits += 1;
      // Closed the whole way through, in the direction that invalidates the box.
      if (wantDown ? later.c < low : later.c > high) intact = false;
    }
    out.push({
      id: `ob_${found}`,
      side: wantDown ? 'demand' : 'supply',
      index: found,
      t: c.t,
      low,
      high,
      brokeAt: brk.t,
      brokeIndex: brk.index,
      revisits,
      intact,
    });
  }

  // Newest first, because a block from four hundred bars ago is history and the newest ones are
  // what price is near.
  return out.reverse().slice(0, o.limit);
}

export function fairValueGaps(
  candles: Candle[],
  given: Partial<StructureOptions> = {},
): FairValueGap[] {
  const o = opts(given);
  const out: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i++) {
    const first = candles[i - 2] as Candle;
    const middle = candles[i - 1] as Candle;
    const third = candles[i] as Candle;
    let direction: 'up' | 'down' | null = null;
    let low = 0;
    let high = 0;
    if (third.l > first.h) {
      direction = 'up';
      low = first.h;
      high = third.l;
    } else if (third.h < first.l) {
      direction = 'down';
      low = third.h;
      high = first.l;
    }
    if (direction === null) continue;
    const height = high - low;
    if (height <= 0) continue;

    /* How much of the band later bars have eaten, measured from the side price left from.
       An up gap sits BELOW price, so it fills from its top downwards as a later bar dips into
       it; a down gap sits above and fills from its bottom upwards. `front` is how far in the
       deepest later bar has reached, clamped to the band so a bar that blew straight through
       counts as one fill rather than as more than a full one. */
    let front = direction === 'up' ? high : low;
    let filledAt: number | null = null;
    for (let k = i + 1; k < candles.length; k++) {
      const later = candles[k] as Candle;
      if (direction === 'up') {
        front = Math.min(front, Math.max(low, later.l));
        if (later.l <= low) {
          filledAt = later.t;
          break;
        }
      } else {
        front = Math.max(front, Math.min(high, later.h));
        if (later.h >= high) {
          filledAt = later.t;
          break;
        }
      }
    }
    const consumed = direction === 'up' ? high - front : front - low;
    const remaining = filledAt !== null ? 0 : Math.max(0, Math.min(1, 1 - consumed / height));
    out.push({
      id: `fvg_${i - 1}`,
      direction,
      index: i - 1,
      t: middle.t,
      low,
      high,
      remaining,
      filledAt,
    });
  }

  return out.reverse().slice(0, o.limit);
}

export function liquiditySwings(
  candles: Candle[],
  given: Partial<StructureOptions> = {},
): LiquidityLevel[] {
  const o = opts(given);
  const tolerance = autoTolerance(candles, o.tolerance);
  const found = pivots(candles, { window: o.window, minProminence: o.minProminence });
  const out: LiquidityLevel[] = [];

  // Group pivots of the same kind that sit within the tolerance of each other. Two swing highs
  // a tick apart are one shelf of resting orders, which is the thing being measured.
  for (const kind of ['high', 'low'] as const) {
    const set = found.filter((p) => p.kind === kind).sort((a, b) => a.price - b.price);
    let group: Pivot[] = [];
    const flush = (): void => {
      if (group.length === 0) return;
      const price =
        kind === 'high'
          ? Math.max(...group.map((p) => p.price))
          : Math.min(...group.map((p) => p.price));
      const firstIndex = Math.min(...group.map((p) => p.index));
      const lastIndex = Math.max(...group.map((p) => p.index));
      let takenAt: number | null = null;
      for (let i = lastIndex + o.window + 1; i < candles.length; i++) {
        const c = candles[i] as Candle;
        if (kind === 'high' ? c.h > price : c.l < price) {
          takenAt = c.t;
          break;
        }
      }
      // Every bar that came within tolerance, not just the pivots. A shelf that eight bars
      // wicked into is a heavier shelf than one two pivots made.
      let touches = 0;
      for (const c of candles) {
        const reach = kind === 'high' ? c.h : c.l;
        if (Math.abs(reach - price) <= tolerance) touches += 1;
      }
      out.push({
        id: `lq_${kind}_${firstIndex}`,
        kind,
        price,
        touches: Math.max(group.length, touches),
        firstT: (candles[firstIndex] as Candle).t,
        lastT: (candles[lastIndex] as Candle).t,
        taken: takenAt !== null,
        takenAt,
      });
      group = [];
    };
    for (const pivot of set) {
      if (group.length === 0 || Math.abs(pivot.price - (group[group.length - 1] as Pivot).price) <= tolerance) {
        group.push(pivot);
        continue;
      }
      flush();
      group.push(pivot);
    }
    flush();
  }

  // Heaviest first: a shelf six bars have hit is more interesting than one two did.
  out.sort((a, b) => b.touches - a.touches || b.lastT - a.lastT);
  return out.slice(0, o.limit);
}
