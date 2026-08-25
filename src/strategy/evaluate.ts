// The evaluator: program plus market state in, intended actions out.
//
// Pure, and deliberately so. Same inputs, same output, no clock read, no store lookup, no
// network. Three things fall out of that:
//
//   1. It can be replayed against history, which is the only honest way to check what a
//      program would have done before arming it with money.
//   2. Every input it needs is visible in its signature, so nothing it depends on can drift
//      without the type changing.
//   3. It is testable without a venue, which matters because the alternative is discovering
//      an entry condition was inverted while it is holding a position.
//
// The actions it returns are INTENDED, not permitted. Everything here still has to clear
// checkEnvelope before anything is signed. This module knows what the program asked for; it
// has no opinion about whether the human allowed it.
//
// Reference resolution is injected rather than imported. A trend line's price at this instant
// comes from the drawing store, and reaching into that store from here would make the function
// impure and would couple the strategy layer to the chart layer in the wrong direction.

import type { Action, Condition, Program, Ref } from './grammar.ts';
import type { RunState } from './envelope.ts';

export type MarketState = {
  nowMs: number;
  markPx: number;
  // The previous tick's mark, or null when there has not been one yet. Cross conditions are
  // about a transition, and a transition needs two samples; holding the previous one here rather
  // than inside the evaluator is what keeps this function pure.
  //
  // NULL RATHER THAN A SEED NUMBER, and the difference cost real money on 2026-08-21. The runner
  // seeded this at 0, so `prevMarkPx <= v` was true of every level in existence and the FIRST
  // evaluation after arming counted as a cross up whenever the mark already sat above the level.
  // A mandate written to buy a dip opened at the market instead, on its very first tick, and the
  // trade that reached the venue was not the one on the approval screen: the entry landed on the
  // wrong side of its own stop, so the reward-to-risk a human read was inverted before the
  // position existed. Nobody saw a wrong condition, because the condition was right.
  //
  // There is no seed value that is safe, which is why this is a type change and not a better
  // constant: 0 is below every level and Infinity is above every level, so one direction always
  // starts armed. The absence of a sample is a fact about the market state, so it is what the
  // market state carries.
  prevMarkPx: number | null;
  // A Ref to a price at this instant, or null when it cannot be resolved (a deleted drawing,
  // an indicator with no value yet). Null makes the condition false rather than throwing:
  // a strategy whose line was deleted should stop triggering, not crash the runner.
  resolveRef(ref: Ref): number | null;
  // The most recently CLOSED bar on a timeframe, for bar_close conditions.
  lastClose(timeframeSec: number): { t: number; close: number } | null;
};

// Per-rule firing memory. Carried in and out rather than held, for the same purity reason.
export type RuleMemory = { firedAtMs: Record<string, number>; firedEver: Record<string, boolean> };

export function emptyMemory(): RuleMemory {
  return { firedAtMs: {}, firedEver: {} };
}

function condition(c: Condition, m: MarketState, s: RunState): boolean {
  switch (c.op) {
    case 'price_above': {
      const v = m.resolveRef(c.ref);
      return v !== null && m.markPx > v;
    }
    case 'price_below': {
      const v = m.resolveRef(c.ref);
      return v !== null && m.markPx < v;
    }
    case 'price_cross_up': {
      const v = m.resolveRef(c.ref);
      if (v === null || m.prevMarkPx === null) return false;
      return m.prevMarkPx <= v && m.markPx > v;
    }
    case 'price_cross_down': {
      const v = m.resolveRef(c.ref);
      if (v === null || m.prevMarkPx === null) return false;
      return m.prevMarkPx >= v && m.markPx < v;
    }
    case 'bar_close': {
      const bar = m.lastClose(c.timeframeSec);
      const v = m.resolveRef(c.ref);
      if (bar === null || v === null) return false;
      // True for as long as that bar remains the newest closed one. Repeat firing is the
      // rule's business, through `once` and `cooldownSec`, not this predicate's.
      return c.side === 'above' ? bar.close > v : bar.close < v;
    }
    case 'position':
      return s.positionSide === c.state;
    case 'pnl_pct': {
      // Undefined while flat rather than zero: "down more than 2%" should not be true of a
      // position that does not exist.
      if (s.positionUsd === 0) return false;
      const pct = (s.unrealisedUsd / s.positionUsd) * 100;
      return c.cmp === 'gt' ? pct > c.value : pct < c.value;
    }
    case 'elapsed': {
      const from = c.since === 'entry' ? s.entryAtMs : s.armedAtMs;
      if (from === null) return false; // no entry to measure from
      const secs = (m.nowMs - from) / 1000;
      return c.cmp === 'gt' ? secs > c.seconds : secs < c.seconds;
    }
    case 'and':
      return c.of.every((x) => condition(x, m, s));
    case 'or':
      return c.of.some((x) => condition(x, m, s));
    case 'not':
      return !condition(c.of, m, s);
    default:
      // The grammar is a closed set validated at arm time, so this is unreachable in practice.
      // It returns false rather than throwing because a runner holding a position should not
      // die on an unknown condition; the supervisor is what handles a program gone wrong.
      return false;
  }
}

export function evaluate(
  p: Program,
  m: MarketState,
  s: RunState,
  mem: RuleMemory,
): { actions: Action[]; memory: RuleMemory; invalidated: boolean } {
  const memory: RuleMemory = {
    firedAtMs: { ...mem.firedAtMs },
    firedEver: { ...mem.firedEver },
  };

  // Invalidation is checked before any rule. A program whose thesis is dead should stand down
  // rather than get one more entry in first.
  if (p.invalidate !== undefined && condition(p.invalidate, m, s)) {
    return {
      actions: [{ do: 'stand_down', reason: 'invalidation condition met' }],
      memory,
      invalidated: true,
    };
  }

  const actions: Action[] = [];

  for (const rule of p.rules) {
    if (rule.once === true && memory.firedEver[rule.id] === true) continue;

    if (rule.cooldownSec !== undefined) {
      const last = memory.firedAtMs[rule.id];
      if (last !== undefined && (m.nowMs - last) / 1000 < rule.cooldownSec) continue;
    }

    if (!condition(rule.when, m, s)) continue;

    actions.push(...rule.then);
    memory.firedAtMs[rule.id] = m.nowMs;
    memory.firedEver[rule.id] = true;
  }

  return { actions, memory, invalidated: false };
}
