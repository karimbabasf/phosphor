// The timeframe engine: what makes "any timeframe" true rather than "one of twelve".
//
// No venue serves every interval a person might ask for. Hyperliquid stops at its own
// enum, Coinbase serves six granularities and refuses the rest with a 400. Asking a venue
// for 7m has never worked and never will. So the request is split in two: fetch a base
// interval the venue does serve, then fold that base into whatever bucket was asked for.
// A 7m chart is 1m bars folded seven at a time, and it is exact, because folding OHLCV is
// lossless in the direction that matters (down to up).
//
// The one subtlety worth writing down is the week. Epoch second zero was a Thursday, so
// bucketing weeks straight off the epoch opens every week on a Thursday and disagrees with
// every venue on earth. Weeks carry an offset so they open on Monday.

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

export const MAX_TIMEFRAME_SEC = 604_800;

/* "7m" -> 420, "90s" -> 90, "2h" -> 7200, "1w" -> 604800, "45" -> 45.
   Returns null rather than guessing, so the caller can say what it knows instead of
   charting something the human did not ask for. Months are refused on purpose: they are
   not a fixed number of seconds and a chart that pretends otherwise is lying. */
export function parseTimeframe(text: string | number): number | null {
  if (typeof text === 'number') {
    return Number.isFinite(text) && text > 0 ? Math.floor(text) : null;
  }
  const raw = String(text).trim().toLowerCase();
  if (raw === '') return null;

  const bare = /^\d+$/.exec(raw);
  if (bare) {
    const secs = Number(raw);
    return secs > 0 && secs <= MAX_TIMEFRAME_SEC ? secs : null;
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
  return secs > 0 && secs <= MAX_TIMEFRAME_SEC ? secs : null;
}

/* The inverse, for labels. Prefers the largest unit that divides cleanly, so 3600 reads
   as 1h and not 60m. */
export function formatTimeframe(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return `${sec}s`;
  if (sec % UNIT_SECONDS.w === 0) return `${sec / UNIT_SECONDS.w}w`;
  if (sec % UNIT_SECONDS.d === 0) return `${sec / UNIT_SECONDS.d}d`;
  if (sec % UNIT_SECONDS.h === 0) return `${sec / UNIT_SECONDS.h}h`;
  if (sec % UNIT_SECONDS.m === 0) return `${sec / UNIT_SECONDS.m}m`;
  return `${sec}s`;
}

/* Which bucket a moment belongs to. Weeks open on Monday, everything else divides the
   epoch evenly and needs no help. */
export function bucketStart(tSec: number, stepSec: number): number {
  if (stepSec >= UNIT_SECONDS.w && stepSec % UNIT_SECONDS.w === 0) {
    return Math.floor((tSec - WEEK_OFFSET_SEC) / stepSec) * stepSec + WEEK_OFFSET_SEC;
  }
  return Math.floor(tSec / stepSec) * stepSec;
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
