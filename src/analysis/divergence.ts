// Price and an oscillator disagreeing at consecutive swing points.
//
// The two names below are the standard names for two geometric shapes, and that is all
// they are here. This returns both pivot pairs and both oscillator readings so the agent
// can look at the evidence and decide, which is the difference between a measurement and
// a signal. Divergence is well known for firing repeatedly through a strong trend, so
// handing over a verdict would be handing over a bad one.

import type { Pivot } from './pivots.ts';

export type Divergence = {
  kind: 'bearish' | 'bullish';
  priceA: Pivot;
  priceB: Pivot;
  oscA: number;
  oscB: number;
};

export function divergences(list: Pivot[], oscillator: (number | null)[]): Divergence[] {
  const out: Divergence[] = [];

  for (const kind of ['high', 'low'] as const) {
    const of = list.filter((p) => p.kind === kind);
    for (let i = 1; i < of.length; i++) {
      const a = of[i - 1];
      const b = of[i];
      const oscA = oscillator[a.index];
      const oscB = oscillator[b.index];
      if (oscA === null || oscA === undefined) continue;
      if (oscB === null || oscB === undefined) continue;

      if (kind === 'high' && b.price > a.price && oscB < oscA) {
        out.push({ kind: 'bearish', priceA: a, priceB: b, oscA, oscB });
      }
      if (kind === 'low' && b.price < a.price && oscB > oscA) {
        out.push({ kind: 'bullish', priceA: a, priceB: b, oscA, oscB });
      }
    }
  }

  return out.sort((x, y) => x.priceB.index - y.priceB.index);
}
