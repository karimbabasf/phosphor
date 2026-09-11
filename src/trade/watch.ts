// The watcher: the only conditions the venue cannot hold, evaluated on closed bars.
//
// Pure on purpose. This is the one piece of the runner that decides WHEN a plan fires, and the
// only honest test of that is bars written by hand. It never places anything: the host reads
// `holds` and sends the child a fire command carrying the plan id and nothing else.
//
// Nothing is at risk while this waits. A plan whose conditions do not hold has placed no order,
// so a feed that goes quiet costs nothing but time, which is why `blind` is a state the payload
// shows rather than an error.

import { renderCondition, TIMEFRAME_SEC } from './plan.ts';
import type { Condition, Plan, Ref, Timeframe } from './plan.ts';

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

export type MarketView = {
  nowMs: number;
  mark: number | null;
  // Age of the newest frame the host has seen for this coin.
  freshMs: number;
  // Closed bars, oldest first. The forming bar is never in here.
  bars: Partial<Record<Timeframe, Bar[]>>;
  // A drawn line's price at a bar's time. Absent means no line can be read.
  lineAt?: (id: string, t: number) => number | null;
};

// Past this the newest frame is old enough that a close could have happened unseen, and a fire
// on stale bars would be a fire on a market that has already moved.
export const STALE_MS = 15_000;
// Volume reads the last closed bar against the mean of the twenty before it, so twenty-one is
// the least a series can hold and mean anything. The close conditions share the floor rather
// than firing on a series too short to say what "closed" means for that timeframe yet.
export const MIN_BARS = 21;

function refAt(ref: Ref, t: number, view: MarketView): number | null {
  if ('px' in ref) return ref.px;
  if (view.lineAt === undefined) return null;
  const v = view.lineAt(ref.line, t);
  return v !== null && Number.isFinite(v) ? v : null;
}

function holdsClose(c: Extract<Condition, { type: 'close' }>, view: MarketView): boolean {
  const series = view.bars[c.tf];
  if (series === undefined || series.length < MIN_BARS) return false;
  const last = series[series.length - 1];
  if (last === undefined) return false;
  const ref = refAt(c.at, last.t, view);
  if (ref === null) return false;
  const closedRight = c.is === 'above' ? last.c > ref : last.c < ref;
  if (!closedRight) return false;
  if (c.wick !== 'through') return true;
  // The reclaim: the bar went to the wrong side of the level and closed back on the right one.
  return c.is === 'above' ? last.l < ref : last.h > ref;
}

function holdsVolume(c: Extract<Condition, { type: 'volume' }>, view: MarketView): boolean {
  const series = view.bars[c.tf];
  if (series === undefined || series.length < MIN_BARS) return false;
  const last = series[series.length - 1];
  if (last === undefined) return false;
  const prior = series.slice(-MIN_BARS, -1);
  const mean = prior.reduce((sum, b) => sum + b.v, 0) / prior.length;
  if (!Number.isFinite(mean) || mean <= 0) return false;
  return last.v >= c.atLeast * mean;
}

function holdsTime(c: Extract<Condition, { type: 'time' }>, view: MarketView): boolean {
  if (c.after !== undefined) {
    const at = Date.parse(c.after);
    if (!Number.isFinite(at) || view.nowMs < at) return false;
  }
  if (c.before !== undefined) {
    const at = Date.parse(c.before);
    if (!Number.isFinite(at) || view.nowMs >= at) return false;
  }
  return true;
}

function holdsOne(c: Condition, view: MarketView): boolean {
  if (c.type === 'close') return holdsClose(c, view);
  if (c.type === 'volume') return holdsVolume(c, view);
  return holdsTime(c, view);
}

export function evaluate(
  plan: Plan,
  view: MarketView,
): { holds: boolean; per: { condition: string; holds: boolean }[]; blind: boolean } {
  const blind = !Number.isFinite(view.freshMs) || view.freshMs > STALE_MS;
  const per = (plan.when ?? []).map((c) => ({ condition: renderCondition(c), holds: holdsOne(c, view) }));
  const holds = !blind && per.every((p) => p.holds);
  return { holds, per, blind };
}

export function timeframeSec(tf: Timeframe): number {
  return TIMEFRAME_SEC[tf];
}
