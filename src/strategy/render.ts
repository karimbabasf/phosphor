// The program in English, and the worst it can do.
//
// This is the approval screen's only source of truth. The human never reads the JSON, so a
// rule that renders differently from how it runs is a rule that got approved by accident. Two
// consequences shape everything below.
//
// First, a Ref renders as its drawing id and not as a price. `tl_1` is what the human sees on
// the chart, so `tl_1` is what they can check. Resolving it to 3421.50 here would show a number
// that is already stale by the time they read it, and would hide which line the strategy is
// actually watching.
//
// Second, agent-authored text (a stand_down reason, a notify message) is quoted and collapsed
// before it lands in a line. The grammar already refuses control characters; this is the second
// of the two locks, because a string that can draw what looks like another rule is a string
// that can get a rule approved that nobody wrote.
//
// worstCaseUsd has exactly one defect available to it: returning a number smaller than the real
// exposure. A worst case that flatters the program is worse than no worst case at all, because
// the human stops looking. Every branch below resolves ties upward.

import type { Mandate } from './envelope.ts';
import type { Action, Condition, Entry, Program, Ref, Rule } from './grammar.ts';

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// Prices carry more precision than money does: a perp can quote 0.00001234, and rounding that
// to two places on the approval screen would show the human a stop at $0.
function priceUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
}

function pct(f: number): string {
  return `${(f * 100).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`;
}

function duration(sec: number): string {
  if (sec === 0) return '0s';
  if (sec % 86_400 === 0) return `${sec / 86_400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

// The quotes are the delimiter that keeps agent text visibly one field, so an inner quote is
// doubled rather than dropped: the reader can still see exactly what was written, and the
// wrapper cannot be closed early by the text inside it. Whitespace collapses for the same
// reason, on top of the grammar already refusing control characters.
function quoted(s: string): string {
  return `"${s.replace(/\s+/g, ' ').trim().replace(/"/g, '""')}"`;
}

function renderRef(r: Ref): string {
  if (r.kind === 'price') return priceUsd(r.value);
  if (r.kind === 'drawing') return r.id;
  return r.plot === undefined ? r.id : `${r.id}.${r.plot}`;
}

function renderEntry(e: Entry): string {
  if (e.type === 'market') return `market (max ${e.maxSlippageBps} bps slippage)`;
  return e.postOnly === true ? `limit at ${renderRef(e.ref)}, post only` : `limit at ${renderRef(e.ref)}`;
}

export function renderCondition(c: Condition): string {
  switch (c.op) {
    case 'price_above':
      return `price above ${renderRef(c.ref)}`;
    case 'price_below':
      return `price below ${renderRef(c.ref)}`;
    case 'price_cross_up':
      return `price crosses up ${renderRef(c.ref)}`;
    case 'price_cross_down':
      return `price crosses down ${renderRef(c.ref)}`;
    case 'bar_close':
      return `the ${duration(c.timeframeSec)} bar closes ${c.side} ${renderRef(c.ref)}`;
    case 'position':
      return `position is ${c.state}`;
    case 'pnl_pct':
      return `pnl is ${c.cmp === 'gt' ? 'above' : 'below'} ${c.value}%`;
    case 'elapsed':
      return `${c.cmp === 'gt' ? 'more' : 'less'} than ${duration(c.seconds)} since ${c.since}`;
    case 'and':
    case 'or':
      // A nested and/or gets brackets so the reader never has to guess at precedence. The one
      // place a rendered rule may differ from the JSON is where it is clearer, never where it
      // is looser.
      return c.of.map((x) => (x.op === 'and' || x.op === 'or' ? `(${renderCondition(x)})` : renderCondition(x))).join(
        c.op === 'and' ? ' and ' : ' or ',
      );
    case 'not':
      return `not (${renderCondition(c.of)})`;
  }
}

export function renderAction(a: Action): string {
  switch (a.do) {
    case 'open':
      return `open ${a.side} ${usd(a.sizeUsd)} at ${a.leverage}x, ${renderEntry(a.entry)}`;
    case 'add':
      return `add ${usd(a.sizeUsd)}, ${renderEntry(a.entry)}`;
    case 'reduce':
      return `reduce ${pct(a.fraction)}, ${renderEntry(a.exit)}`;
    case 'close':
      return `close, ${renderEntry(a.exit)}`;
    case 'set_stop':
      return a.trailPct === undefined
        ? `set stop at ${renderRef(a.ref)}`
        : `set stop at ${renderRef(a.ref)}, trailing ${a.trailPct}%`;
    case 'set_target':
      return `set target at ${renderRef(a.ref)} for ${pct(a.fraction)}`;
    case 'cancel':
      return a.which === 'all' ? 'cancel all orders' : `cancel ${a.which === 'entries' ? 'entry' : 'exit'} orders`;
    case 'stand_down':
      return `stand down: ${quoted(a.reason)}`;
    case 'notify':
      return `notify: ${quoted(a.text)}`;
  }
}

function renderRule(r: Rule): string {
  // Actions join on a semicolon because an action already spends its comma internally, and
  // `open long $500 at 3x, limit at tl_1, set stop at tl_2` reads as three things when it is
  // two.
  const line = `when ${renderCondition(r.when)}: ${r.then.map(renderAction).join('; ')}`;
  const notes: string[] = [];
  if (r.once === true) notes.push('once');
  if (r.cooldownSec !== undefined && r.cooldownSec > 0) notes.push(`then wait ${duration(r.cooldownSec)}`);
  return notes.length > 0 ? `${line} (${notes.join(', ')})` : line;
}

export function renderProgram(p: Program): string[] {
  const lines = p.rules.map(renderRule);
  // The invalidation gets its own line rather than being left out. It is the condition under
  // which the whole program stops, which is the single thing a reviewer most needs to see, and
  // a render that omits it is a render of a different program.
  if (p.invalidate !== undefined) lines.push(`invalidate when ${renderCondition(p.invalidate)}: stand down`);
  return lines;
}

// The price a fill is known to happen at, or null when it is not knowable now. A market order
// has no such price: maxSlippageBps bounds the slip from a price nobody has seen yet, so the
// distance from that fill to a fixed stop cannot be worked out at approval time.
function knownEntryPrice(e: Entry): number | null {
  return e.type === 'limit' && e.ref.kind === 'price' ? e.ref.value : null;
}

// The fraction of notional a stop gives up, or null when it cannot be pinned down.
//
// A stop at a drawing id is null on purpose: the line moves, so the distance is whatever it
// happens to be when the trigger fires. Guessing a number there is precisely the flattering
// answer this function must not produce.
//
// With a trailPct present the larger of the two distances wins. A trailing stop starts at its
// ref and only tightens as price moves the right way, so the initial ref distance is the real
// exposure; taking the max also covers the reading where the trail is the wider of the two.
function stopFraction(entryPx: number, stop: { ref: Ref; trailPct?: number }): number | null {
  if (stop.ref.kind !== 'price') return null;
  const refFraction = Math.abs(entryPx - stop.ref.value) / entryPx;
  const trailFraction = stop.trailPct === undefined ? 0 : stop.trailPct / 100;
  return Math.max(refFraction, trailFraction);
}

export function worstCaseUsd(p: Program, m: Mandate): number {
  let sum = 0;

  for (const rule of p.rules) {
    // Pairing is per rule, not per program. A stop that lives in another rule only exists once
    // that rule's condition fires, and a stop that might not exist yet is not a stop. This is
    // stricter than "a stop somewhere in the program", and stricter is the correct direction
    // for a number whose only failure mode is being too small.
    const stops = rule.then.filter((a): a is Extract<Action, { do: 'set_stop' }> => a.do === 'set_stop');

    for (const action of rule.then) {
      if (action.do !== 'open' && action.do !== 'add') continue;

      const entryPx = knownEntryPrice(action.entry);
      if (entryPx === null || stops.length === 0) return m.maxNotionalUsd;

      // Several stops in one rule means the loss is bounded by the loosest of them, since any
      // one of them could be the one still resting when price runs.
      let worst = 0;
      for (const stop of stops) {
        const f = stopFraction(entryPx, stop);
        if (f === null) return m.maxNotionalUsd;
        worst = Math.max(worst, f);
      }
      sum += action.sizeUsd * worst;
    }
  }

  // Capped at the mandate's own ceiling, which is the same number the unstopped case reports,
  // so the two branches stay comparable. Note what this is NOT capped by: maxLossUsd. That
  // limit is enforced by a supervisor watching a feed, and a gap through a stop does not wait
  // for a supervisor. Reporting maxLossUsd here would promise a wall that only holds when the
  // market is orderly.
  return Math.min(sum, m.maxNotionalUsd);
}
