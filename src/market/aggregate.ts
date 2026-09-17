// The timeframe engine: what makes "any timeframe" true rather than "one of twelve".
//
// No venue serves every interval a person might ask for. Hyperliquid stops at its own
// enum, Coinbase serves six granularities and refuses the rest with a 400. Asking a venue
// for 7m has never worked and never will. So the request is split in two: fetch a base
// interval the venue does serve, then fold that base into whatever bucket was asked for.
// A 7m chart is 1m bars folded seven at a time, and it is exact, because folding OHLCV is
// lossless in the direction that matters (down to up).
//
// Two subtleties worth writing down. The week: epoch second zero was a Thursday, so bucketing
// weeks straight off the epoch opens every week on a Thursday and disagrees with every venue
// on earth (Hyperliquid's own native week does exactly that, which is why it is not fetched).
// Weeks carry an offset so they open on Monday. The month: it is not a fixed number of seconds,
// and the whole engine keys on seconds, so a calendar month travels as one sentinel value that
// every bucketing step recognises and answers with the calendar. Folding days into it is exact,
// the way every fold here is, and a venue's "1M" is not a month at all (Hyperliquid's is a
// thirty day bucket, measured 2026-09-16), so it is always built from days.

import type { Candle } from '../types.ts';

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

// Thursday 1970-01-01 to the following Monday.
const WEEK_OFFSET_SEC = 345_600;

/* The calendar month's sentinel: the mean Gregorian month in seconds. Nothing is ever fetched
   or folded in these seconds; bucketStart and bucketEnd read the calendar for it, and the
   number only has to be a timeframe no fixed bucket could be. The window holds the same value
   (ui/chart/chart.js MONTH_SEC). */
export const MONTH_SEC = 2_629_746;

export function isMonthStep(stepSec: number): boolean {
  return stepSec === MONTH_SEC;
}

// The widest fixed bucket: a week. Between it and the month there is no bucket anyone charts,
// and a fixed thirty days is the thing the month sentinel exists to not be.
export const MAX_FIXED_SEC = 604_800;
export const MAX_TIMEFRAME_SEC = MONTH_SEC;

/* A timeframe the engine can serve: a fixed bucket from a minute to a week, or the month. */
export function servable(sec: number): boolean {
  return Number.isFinite(sec) && ((sec > 0 && sec <= MAX_FIXED_SEC) || isMonthStep(sec));
}

// The floor. No venue serves a candle under a minute, so anything faster had to be built
// here from a trade tape, and the tape and the live stream were different venues, which
// spliced two markets into one line. Removed 2026-08-13.
export const MIN_TIMEFRAME_SEC = 60;

/* "7m" -> 420, "90s" -> 90, "2h" -> 7200, "1w" -> 604800, "1M" -> the month sentinel, "45" -> 45.
   Returns null rather than guessing, so the caller can say what it knows instead of
   charting something the human did not ask for. The month is the one case-sensitive unit:
   "1M" is a month and "1m" a minute, as on every venue and chart there is, and "1mo" or
   "1 month" say it without the capital. Only one month: two is a bucket nobody keeps. */
export function parseTimeframe(text: string | number): number | null {
  if (typeof text === 'number') {
    return Number.isFinite(text) && text > 0 && servable(Math.floor(text)) ? Math.floor(text) : null;
  }
  const exact = String(text).trim();
  const month = /^(\d+)\s*M$/.exec(exact) ?? /^(\d+)\s*(mo|mon|month|months)$/i.exec(exact);
  if (month !== null) return Number(month[1]) === 1 ? MONTH_SEC : null;
  const raw = exact.toLowerCase();
  if (raw === '') return null;

  const bare = /^\d+$/.exec(raw);
  if (bare) {
    const secs = Number(raw);
    return servable(secs) ? secs : null;
  }

  const match = /^(\d+)\s*(s|m|h|d|w|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks)$/.exec(
    raw,
  );
  if (!match) return null;

  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;

  const suffix = match[2] as string;
  const unit = suffix.startsWith('sec')
    ? 's'
    : suffix.startsWith('min')
      ? 'm'
      : suffix.startsWith('h')
        ? 'h'
        : suffix.startsWith('d')
          ? 'd'
          : suffix.startsWith('w')
            ? 'w'
            : suffix;

  const unitSec = UNIT_SECONDS[unit];
  if (unitSec === undefined) return null;

  const secs = count * unitSec;
  return servable(secs) ? secs : null;
}

/* The inverse, for labels. Prefers the largest unit that divides cleanly, so 3600 reads
   as 1h and not 60m. */
export function formatTimeframe(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return `${sec}s`;
  if (isMonthStep(sec)) return '1M';
  if (sec % UNIT_SECONDS.w === 0) return `${sec / UNIT_SECONDS.w}w`;
  if (sec % UNIT_SECONDS.d === 0) return `${sec / UNIT_SECONDS.d}d`;
  if (sec % UNIT_SECONDS.h === 0) return `${sec / UNIT_SECONDS.h}h`;
  if (sec % UNIT_SECONDS.m === 0) return `${sec / UNIT_SECONDS.m}m`;
  return `${sec}s`;
}

/* Which bucket a moment belongs to. A month opens on the first at UTC midnight, weeks open
   on Monday, everything else divides the epoch evenly and needs no help. */
export function bucketStart(tSec: number, stepSec: number): number {
  if (isMonthStep(stepSec)) {
    const d = new Date(tSec * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  if (stepSec >= UNIT_SECONDS.w && stepSec % UNIT_SECONDS.w === 0) {
    return Math.floor((tSec - WEEK_OFFSET_SEC) / stepSec) * stepSec + WEEK_OFFSET_SEC;
  }
  return Math.floor(tSec / stepSec) * stepSec;
}

/* When the bucket opening at `openSec` closes: the next first of the month for a month, and
   one step on for everything else. The countdown under the price tag and the agent's
   `closesInSec` both read this, because `open + MONTH_SEC` is a moment in no calendar. */
export function bucketEnd(openSec: number, stepSec: number): number {
  if (isMonthStep(stepSec)) {
    const d = new Date(openSec * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  }
  return openSec + stepSec;
}

/* Whether bars of `baseSec` fold exactly into buckets of `targetSec`. A month is whole days,
   so any base that divides a day folds into it; everything else has to divide the target. */
export function foldsInto(baseSec: number, targetSec: number): boolean {
  if (isMonthStep(targetSec)) return UNIT_SECONDS.d % baseSec === 0;
  return targetSec % baseSec === 0;
}

/* Fold an oldest-first series into larger buckets.
   Open is the first bar in the bucket, close the last, high and low the extremes, volume
   the sum. Empty buckets are left out rather than filled with a flat doji: a gap in the
   venue's own data is a fact about the venue, and inventing a bar hides it. */
export function aggregate(candles: readonly Candle[], baseSec: number, targetSec: number): Candle[] {
  if (targetSec <= baseSec) return candles.slice();
  if (candles.length === 0) return [];

  const out: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketAt = -1;

  for (const candle of candles) {
    const slot = bucketStart(candle.t, targetSec);
    if (bucket === null || slot !== bucketAt) {
      if (bucket !== null) out.push(bucket);
      bucketAt = slot;
      bucket = { t: slot, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v };
      continue;
    }
    if (candle.h > bucket.h) bucket.h = candle.h;
    if (candle.l < bucket.l) bucket.l = candle.l;
    bucket.c = candle.c;
    bucket.v += candle.v;
  }
  if (bucket !== null) out.push(bucket);
  return out;
}

/* Given what a venue serves natively, the base to fetch for a requested timeframe.
   Prefers the largest native that divides the target exactly, because an exact divisor
   folds without straddling a boundary. Failing that, the largest native below the target,
   which still folds correctly and only costs extra rows. */
export function chooseBase(targetSec: number, natives: readonly number[]): number | null {
  if (natives.length === 0) return null;

  // A month folds exactly only from bars that divide a day: the largest of those, which is the
  // day itself wherever a venue serves one. A week or a three day bar straddles the month.
  if (isMonthStep(targetSec)) {
    const daily = natives.filter((n) => n <= UNIT_SECONDS.d && UNIT_SECONDS.d % n === 0).sort((a, b) => b - a);
    return daily[0] ?? null;
  }

  const usable = natives.filter((n) => n <= targetSec).sort((a, b) => b - a);
  if (usable.length === 0) {
    // Every native is coarser than the ask, so nothing can fold down to it.
    return null;
  }
  const exact = usable.find((n) => targetSec % n === 0);
  return exact ?? (usable[0] as number);
}

/* How many base bars are needed to build `bars` bars of the target. The margin covers the
   partial bucket at each end, which otherwise costs the newest and oldest bar. */
export function baseBarsNeeded(bars: number, baseSec: number, targetSec: number): number {
  const perBucket = Math.max(1, Math.ceil(targetSec / baseSec));
  return bars * perBucket + perBucket * 2;
}
