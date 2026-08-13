// A trend line is two anchors and the ability to say what it is worth at any time,
// including outside the span it was drawn across. That last part is the whole point:
// a line only becomes a trigger once "where is this line now" has an answer for a bar
// that did not exist when the agent drew it.
//
// Anchors are (time, price), never (x, y). Pixels belong to the browser, and a line
// stored in pixels would move when the human panned the chart.

import type { Candle } from '../types.ts';
import type { Pivot } from './pivots.ts';

export type Anchor = { t: number; price: number };
export type Line = { a: Anchor; b: Anchor };

export function lineAt(line: Line, t: number): number {
  const dt = line.b.t - line.a.t;
  // Two anchors at the same instant have no slope to speak of. Treating that as a
  // horizontal line at the first anchor is arbitrary but finite, and finite is what
  // matters: a NaN here would propagate into a trigger comparison and silently never fire.
  if (dt === 0) return line.a.price;
  const slope = (line.b.price - line.a.price) / dt;
  return line.a.price + slope * (t - line.a.t);
}

export type Touch = { index: number; t: number; distance: number; side: 'above' | 'below' };

export function touches(line: Line, candles: Candle[], tolerance: number): Touch[] {
  const out: Touch[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const value = lineAt(line, c.t);
    // Distance from the bar's range to the line, zero when the bar spans it. Using the
    // range rather than the close is deliberate: a wick that reached a level and rejected
    // is a touch, and closing prices alone would miss exactly the bars traders care about.
    let distance = 0;
    if (c.l > value) distance = c.l - value;
    else if (c.h < value) distance = value - c.h;
    if (distance <= tolerance) {
      out.push({ index: i, t: c.t, distance, side: c.c >= value ? 'above' : 'below' });
    }
  }
  return out;
}

export function fitThroughPivots(list: Pivot[], kind: 'high' | 'low'): Line | null {
  const of = list.filter((p) => p.kind === kind);
  if (of.length < 2) return null;
  const [a, b] = of.slice(-2);
  return { a: { t: a.t, price: a.price }, b: { t: b.t, price: b.price } };
}
