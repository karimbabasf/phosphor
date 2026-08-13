// "Where has this reacted before", answered by grouping pivot prices that sit close
// together. A price several swings turned at is the thing traders draw a horizontal line
// through, and counting members is what separates it from a price that turned once.
//
// Single-link chaining over sorted prices is the right shape here despite its known
// weakness (a run of pivots each within tolerance of the next merges into one wide
// cluster, even though the ends are far apart) because that weakness is visible: `spread`
// says how wide the cluster actually got, so a chained blob is recognisable rather than
// silent. The alternative, a fixed-width grid, would split a tight pair that happened to
// straddle a bin edge, which fails in a way the caller cannot see.

import type { Pivot } from './pivots.ts';

export type Cluster = {
  price: number;
  count: number;
  members: number[];
  spread: number;
  tolerance: number;
};

export function clusterLevels(list: Pivot[], tolerance: number): Cluster[] {
  if (list.length === 0) return [];

  const sorted = [...list].sort((a, b) => a.price - b.price);
  const groups: Pivot[][] = [];
  let current: Pivot[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].price - sorted[i - 1].price <= tolerance) current.push(sorted[i]);
    else {
      groups.push(current);
      current = [sorted[i]];
    }
  }
  groups.push(current);

  return groups
    .map((g) => {
      const prices = g.map((x) => x.price);
      return {
        price: prices.reduce((s, v) => s + v, 0) / prices.length,
        count: g.length,
        members: g.map((x) => x.index).sort((a, b) => a - b),
        spread: Math.max(...prices) - Math.min(...prices),
        tolerance,
      };
    })
    .sort((a, b) => b.count - a.count || a.price - b.price);
}
