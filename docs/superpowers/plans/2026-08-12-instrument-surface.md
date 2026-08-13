# Instrument Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an MCP-connected agent everything it needs to analyse a Hyperliquid chart like a professional trader: measure anything, draw persistent objects the human also sees, page unlimited history, and do it all in one round trip.

**Architecture:** A pure maths layer (`src/analysis/*`) over `Candle[]` with no I/O and no shared files, a drawing store for the new object types trend lines and zones, a history pager, and a batch envelope that lets one MCP call carry many operations with later ops referencing ids created by earlier ones. Integration into the chart, MCP and UI is deliberately the last three tasks, because another agent is editing those files right now.

**Tech Stack:** Node 24 type stripping, no build step. Erasable TypeScript only: no enums, no namespaces, no parameter properties. Relative imports carry explicit `.ts` extensions. Tests are `node --test`. Existing deps only (`viem`, `zod`, `@modelcontextprotocol/sdk`); this plan adds none.

**Spec:** `docs/superpowers/specs/2026-08-12-phosphor-trading-design.md`

## Global Constraints

- **Erasable TypeScript only.** No enums, no namespaces, no parameter properties. Node 24 strips types at run time; there is no compile step to catch a non-erasable construct, so `npm run typecheck` is the only guard.
- **Explicit `.ts` extensions on every relative import.** `import { x } from './y.ts'`, never `'./y'`.
- **Measurements, never conclusions.** No function in `src/analysis/` returns a signal, a score, a rating, a suggestion, or a pattern name that implies a direction. It returns numbers and the parameters that produced them. This is a spec requirement, not a style preference.
- **Every parameterised result carries its parameters.** A level that moves when the bin width changes and does not say which bin width produced it is a number pretending to be a fact.
- **No addresses anywhere.** No schema in this plan accepts or returns an address, a recipient, or a contract. `tests/injection.test.ts:239` scans every registered MCP schema for `to/recipient/destination/address/toaddress/dest/payee` and fails the build if one appears.
- **No writes to `src/chart.ts`, `src/indicators.ts`, `src/mcp.ts`, `src/server.ts` or `ui/` before Task 12.** Another agent is editing those files. Tasks 1 to 11 create new files only.
- **Candle type is fixed and comes from `src/types.ts`:** `{ t: number; o: number; h: number; l: number; c: number; v: number }`, `t` in seconds, newest last.
- **Run `npm run typecheck` before every commit.** It is the only thing that catches a non-erasable construct.
- **No em dashes or en dashes in any file, including comments and commit messages.** Use commas, colons, parentheses.

---

### Task 1: Swing points by prominence

The primitive every other structural measurement builds on. A naive rolling maximum keeps every micro-noise peak; topographic prominence is what separates a real swing from a wiggle.

**Files:**
- Create: `src/analysis/pivots.ts`
- Test: `tests/unit/analysis-pivots.test.ts`

**Interfaces:**
- Consumes: `Candle` from `../types.ts`
- Produces:
  - `type Pivot = { index: number; t: number; price: number; kind: 'high' | 'low'; prominence: number }`
  - `function pivots(candles: Candle[], opts: { window: number; minProminence: number }): Pivot[]`
  - `minProminence` is in price units. Callers that want it in average-true-range units multiply before calling; this module knows nothing about volatility.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/analysis-pivots.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pivots } from '../../src/analysis/pivots.ts';
import type { Candle } from '../../src/types.ts';

// Build candles from a list of closes. Highs and lows sit one unit either side,
// which keeps the fixture readable while still exercising high/low separately.
function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: 1000 + i * 60, o: c, h: c + 1, l: c - 1, c, v: 10 }));
}

test('finds a clear peak and trough, ignoring the shoulders', () => {
  //                    0  1  2   3   4   5  6  7   8
  const candles = series([10, 12, 20, 12, 10, 12, 4, 12, 10]);
  const found = pivots(candles, { window: 2, minProminence: 3 });

  const highs = found.filter((p) => p.kind === 'high');
  const lows = found.filter((p) => p.kind === 'low');

  assert.equal(highs.length, 1, 'one prominent high');
  assert.equal(highs[0].index, 2);
  assert.equal(highs[0].price, 21); // high = close + 1

  assert.equal(lows.length, 1, 'one prominent low');
  assert.equal(lows[0].index, 6);
  assert.equal(lows[0].price, 3); // low = close - 1
});

test('prominence filters micro noise a rolling max would keep', () => {
  // Two peaks: index 2 stands 10 above its surroundings, index 6 stands 0.5.
  const candles = series([10, 12, 20, 12, 10, 10.2, 10.5, 10.2, 10]);
  const loose = pivots(candles, { window: 2, minProminence: 0 });
  const strict = pivots(candles, { window: 2, minProminence: 3 });

  const loosePeaks = loose.filter((p) => p.kind === 'high').map((p) => p.index);
  const strictPeaks = strict.filter((p) => p.kind === 'high').map((p) => p.index);

  assert.ok(loosePeaks.includes(6), 'the small bump is a local max');
  assert.ok(!strictPeaks.includes(6), 'and prominence removes it');
  assert.ok(strictPeaks.includes(2), 'while the real peak survives');
});

test('reports prominence as a number the caller can threshold on', () => {
  const candles = series([10, 12, 20, 12, 10]);
  const [peak] = pivots(candles, { window: 2, minProminence: 0 }).filter((p) => p.kind === 'high');
  // Peak high is 21. The deepest low on each side is 9 (close 10 minus 1).
  assert.equal(peak.prominence, 12);
});

test('returns nothing for a series shorter than the window allows', () => {
  assert.deepEqual(pivots(series([1, 2, 3]), { window: 5, minProminence: 0 }), []);
});

test('sorts results by index regardless of kind', () => {
  const candles = series([10, 12, 20, 12, 10, 12, 4, 12, 10]);
  const found = pivots(candles, { window: 2, minProminence: 3 });
  const indexes = found.map((p) => p.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Developer/phosphor-trade && node --test tests/unit/analysis-pivots.test.ts`
Expected: FAIL, cannot find module `src/analysis/pivots.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/analysis/pivots.ts
//
// Swing points by topographic prominence.
//
// A rolling maximum answers "is this bar the highest nearby", which is true of every
// small bump in a quiet stretch. Prominence answers "how far does this stand above the
// ground it rises from", which is the question a trader is actually asking when they
// call something a swing high. Concretely: walk out from the candidate in both
// directions until a higher bar is found or the series ends, take the deepest low seen
// on each side, and measure down to the shallower of those two. That is the standard
// definition and it is what scipy's find_peaks calls prominence.
//
// The window parameter still does useful work: it is the cheap local-max pre-filter that
// keeps the prominence walk from running over every bar in the series.

import type { Candle } from '../types.ts';

export type Pivot = {
  index: number;
  t: number;
  price: number;
  kind: 'high' | 'low';
  prominence: number;
};

function isLocalMax(values: number[], i: number, window: number): boolean {
  const lo = Math.max(0, i - window);
  const hi = Math.min(values.length - 1, i + window);
  for (let j = lo; j <= hi; j++) if (j !== i && values[j] > values[i]) return false;
  return true;
}

// Prominence of a peak in `values`, measured against `floors` (the lows for a high).
// Walking outward until a strictly higher value appears is what makes this a measure of
// standing-above-surroundings rather than of local rank.
function peakProminence(values: number[], floors: number[], i: number): number {
  let leftFloor = floors[i];
  for (let j = i - 1; j >= 0; j--) {
    if (values[j] > values[i]) break;
    if (floors[j] < leftFloor) leftFloor = floors[j];
  }
  let rightFloor = floors[i];
  for (let j = i + 1; j < values.length; j++) {
    if (values[j] > values[i]) break;
    if (floors[j] < rightFloor) rightFloor = floors[j];
  }
  // The shallower side is the one that bounds how far this peak really stands out.
  return values[i] - Math.max(leftFloor, rightFloor);
}

export function pivots(
  candles: Candle[],
  opts: { window: number; minProminence: number },
): Pivot[] {
  const { window, minProminence } = opts;
  if (candles.length < window * 2 + 1) return [];

  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  // Troughs are peaks of the negated series, so one routine covers both directions.
  const negLows = lows.map((v) => -v);
  const negHighs = highs.map((v) => -v);

  const out: Pivot[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (isLocalMax(highs, i, window)) {
      const prominence = peakProminence(highs, lows, i);
      if (prominence >= minProminence) {
        out.push({ index: i, t: candles[i].t, price: highs[i], kind: 'high', prominence });
      }
    }
    if (isLocalMax(negLows, i, window)) {
      const prominence = peakProminence(negLows, negHighs, i);
      if (prominence >= minProminence) {
        out.push({ index: i, t: candles[i].t, price: lows[i], kind: 'low', prominence });
      }
    }
  }

  return out.sort((a, b) => a.index - b.index);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-pivots.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean, no output.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/pivots.ts tests/unit/analysis-pivots.test.ts
git commit -m "Swing points by prominence, not by rolling maximum

A rolling max calls every bump in a quiet stretch a swing high. Prominence
measures how far a bar stands above the ground it rises from, which is the
question a trader is actually asking, and it is what removes the micro noise
that would otherwise reach the agent as structure."
```

---

### Task 2: Trend lines, evaluation and touches

The object that makes the chart a shared coordinate system. A line the agent draws must answer "what are you worth at time T" so the runner can trigger off it later.

**Files:**
- Create: `src/analysis/trendline.ts`
- Test: `tests/unit/analysis-trendline.test.ts`

**Interfaces:**
- Consumes: `Candle` from `../types.ts`, `Pivot` from `./pivots.ts`
- Produces:
  - `type Anchor = { t: number; price: number }`
  - `type Line = { a: Anchor; b: Anchor }`
  - `function lineAt(line: Line, t: number): number` — the line's price at time `t`, extended in both directions
  - `type Touch = { index: number; t: number; distance: number; side: 'above' | 'below' }`
  - `function touches(line: Line, candles: Candle[], tolerance: number): Touch[]`
  - `function fitThroughPivots(pivots: Pivot[], kind: 'high' | 'low'): Line | null` — the line through the two most recent pivots of that kind, or null when there are fewer than two

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/analysis-trendline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineAt, touches, fitThroughPivots } from '../../src/analysis/trendline.ts';
import type { Candle } from '../../src/types.ts';

test('evaluates a rising line at any time, including outside its anchors', () => {
  const line = { a: { t: 100, price: 10 }, b: { t: 200, price: 20 } };
  assert.equal(lineAt(line, 100), 10);
  assert.equal(lineAt(line, 200), 20);
  assert.equal(lineAt(line, 150), 15, 'between the anchors');
  assert.equal(lineAt(line, 300), 30, 'extended forward');
  assert.equal(lineAt(line, 0), 0, 'extended backward');
});

test('a horizontal line is flat everywhere', () => {
  const line = { a: { t: 100, price: 42 }, b: { t: 500, price: 42 } };
  assert.equal(lineAt(line, 1e9), 42);
});

test('a vertical pair does not divide by zero', () => {
  const line = { a: { t: 100, price: 10 }, b: { t: 100, price: 20 } };
  assert.ok(Number.isFinite(lineAt(line, 150)));
});

test('records every bar that came within tolerance, and which side it was', () => {
  const line = { a: { t: 0, price: 10 }, b: { t: 100, price: 10 } };
  const candles: Candle[] = [
    { t: 0, o: 10, h: 10.4, l: 9.6, c: 10, v: 1 },   // straddles, distance 0
    { t: 50, o: 20, h: 20, l: 19, c: 20, v: 1 },     // far above
    { t: 100, o: 10.3, h: 10.5, l: 10.2, c: 10.3, v: 1 }, // just above, within 0.5
  ];
  const found = touches(line, candles, 0.5);
  assert.deepEqual(found.map((x) => x.index), [0, 2]);
  assert.equal(found[0].distance, 0, 'a bar spanning the line touches it exactly');
  assert.equal(found[1].side, 'above');
});

test('fits through the two most recent pivots of the requested kind', () => {
  const ps = [
    { index: 0, t: 0, price: 5, kind: 'high' as const, prominence: 1 },
    { index: 1, t: 100, price: 10, kind: 'low' as const, prominence: 1 },
    { index: 2, t: 200, price: 15, kind: 'high' as const, prominence: 1 },
    { index: 3, t: 300, price: 25, kind: 'high' as const, prominence: 1 },
  ];
  const line = fitThroughPivots(ps, 'high');
  assert.ok(line);
  assert.equal(line.a.t, 200, 'the two most recent highs, oldest first');
  assert.equal(line.b.t, 300);
  assert.equal(lineAt(line, 400), 35);
});

test('returns null when there are not two pivots of that kind', () => {
  const ps = [{ index: 0, t: 0, price: 5, kind: 'high' as const, prominence: 1 }];
  assert.equal(fitThroughPivots(ps, 'high'), null);
  assert.equal(fitThroughPivots(ps, 'low'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/analysis-trendline.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/analysis/trendline.ts
//
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-trendline.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/trendline.ts tests/unit/analysis-trendline.test.ts
git commit -m "Trend lines that can answer what they are worth at any time

Anchors are time and price, never pixels, so a line does not move when the
human pans. Evaluation extends past both anchors because a line only becomes
a trigger once it has a value for a bar that did not exist when it was drawn."
```

---

### Task 3: Volatility regime

The primitive that sets stop distance and position size. It is lookback-relative by construction, so the response says which window produced it.

**Files:**
- Create: `src/analysis/regime.ts`
- Test: `tests/unit/analysis-regime.test.ts`

**Interfaces:**
- Consumes: `Candle` from `../types.ts`
- Produces:
  - `function atr(candles: Candle[], period: number): (number | null)[]` — Wilder smoothing, `null` until the period fills
  - `type Regime = { atr: number; percentile: number; bucket: 'compressed' | 'normal' | 'elevated' | 'extreme'; period: number; lookback: number }`
  - `function regime(candles: Candle[], opts: { period: number; lookback: number }): Regime | null`

Note: `src/indicators.ts` already exports `trueRange`. This module does not import it, because Task 1 to 11 must not touch files the chart agent owns, and a duplicated four-line function is cheaper than a merge conflict in a file being actively edited. Task 12 reconciles them.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/analysis-regime.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atr, regime } from '../../src/analysis/regime.ts';
import type { Candle } from '../../src/types.ts';

function bars(ranges: number[]): Candle[] {
  // Each bar spans `range` around 100, with no gaps, so true range equals `range`.
  return ranges.map((r, i) => ({ t: i * 60, o: 100, h: 100 + r / 2, l: 100 - r / 2, c: 100, v: 1 }));
}

test('atr is null until the period fills, then equals a flat true range', () => {
  const out = atr(bars([2, 2, 2, 2, 2]), 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 2, 'first value is the simple mean of the first `period` true ranges');
  assert.equal(out[4], 2, 'and Wilder smoothing of a constant stays constant');
});

test('atr rises when range expands', () => {
  const out = atr(bars([2, 2, 2, 10, 10]), 3);
  assert.ok((out[4] as number) > (out[2] as number));
});

test('regime buckets by percentile rank over the stated lookback', () => {
  // 40 quiet bars then 10 wild ones: the last bar should rank at the top.
  const quiet = new Array(40).fill(2);
  const wild = new Array(10).fill(20);
  const r = regime(bars([...quiet, ...wild]), { period: 14, lookback: 50 });
  assert.ok(r);
  assert.equal(r.bucket, 'extreme');
  assert.ok(r.percentile > 0.95);
  assert.equal(r.period, 14, 'echoes the parameters that produced it');
  assert.equal(r.lookback, 50);
});

test('a compressed tail ranks low', () => {
  const wild = new Array(40).fill(20);
  const quiet = new Array(20).fill(1);
  const r = regime(bars([...wild, ...quiet]), { period: 14, lookback: 50 });
  assert.ok(r);
  assert.equal(r.bucket, 'compressed');
  assert.ok(r.percentile < 0.2);
});

test('returns null when there is not enough history to rank against', () => {
  assert.equal(regime(bars([2, 2, 2]), { period: 14, lookback: 50 }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/analysis-regime.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/analysis/regime.ts
//
// Average true range, and where the current reading sits in its own recent history.
//
// The percentile is the part that carries the meaning and also the part that lies if you
// let it. It is relative to the lookback window, so a 252-bar window that happens to cover
// a wilder stretch will call an objectively violent market "normal". There is no fix for
// that inside the primitive, so the result carries `lookback` and `period` and the agent
// gets to decide whether the window was fair.
//
// Direction is deliberately absent. Average true range does not know which way price went
// and a regime that implied a direction would be a conclusion, not a measurement.

import type { Candle } from '../types.ts';

function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out.push(c.h - c.l);
      continue;
    }
    const prev = candles[i - 1].c;
    out.push(Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev)));
  }
  return out;
}

export function atr(candles: Candle[], period: number): (number | null)[] {
  const tr = trueRanges(candles);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period || period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let current = sum / period;
  out[period - 1] = current;

  // Wilder smoothing: the conventional average true range, not an exponential moving
  // average with the same period. They differ and the difference shows up in stop distance.
  for (let i = period; i < candles.length; i++) {
    current = (current * (period - 1) + tr[i]) / period;
    out[i] = current;
  }
  return out;
}

export type Regime = {
  atr: number;
  percentile: number;
  bucket: 'compressed' | 'normal' | 'elevated' | 'extreme';
  period: number;
  lookback: number;
};

function bucketFor(p: number): Regime['bucket'] {
  if (p < 0.2) return 'compressed';
  if (p > 0.95) return 'extreme';
  if (p > 0.8) return 'elevated';
  return 'normal';
}

export function regime(
  candles: Candle[],
  opts: { period: number; lookback: number },
): Regime | null {
  const { period, lookback } = opts;
  const series = atr(candles, period);
  const defined = series.filter((v): v is number => v !== null);
  if (defined.length < 2) return null;

  const current = defined[defined.length - 1];
  const window = defined.slice(-lookback);
  if (window.length < 2) return null;

  const below = window.filter((v) => v < current).length;
  const percentile = below / (window.length - 1);

  return { atr: current, percentile, bucket: bucketFor(percentile), period, lookback };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-regime.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/regime.ts tests/unit/analysis-regime.test.ts
git commit -m "Volatility regime as a percentile that admits its own window

Average true range with Wilder smoothing, ranked against its own recent
history. The percentile is lookback-relative and will call a violent market
normal if the window covers a wilder one, so the result carries the window
and lets the agent judge whether it was fair."
```

---

### Task 4: Volume profile

**Files:**
- Create: `src/analysis/volume-profile.ts`
- Test: `tests/unit/analysis-volume-profile.test.ts`

**Interfaces:**
- Consumes: `Candle` from `../types.ts`
- Produces:
  - `type Bin = { low: number; high: number; volume: number }`
  - `type Profile = { bins: Bin[]; poc: number; valueArea: { low: number; high: number }; binWidth: number; valueAreaPct: number; basis: 'volume' }`
  - `function volumeProfile(candles: Candle[], opts: { bins: number; valueAreaPct: number }): Profile | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/analysis-volume-profile.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { volumeProfile } from '../../src/analysis/volume-profile.ts';
import type { Candle } from '../../src/types.ts';

const bar = (l: number, h: number, v: number, i: number): Candle =>
  ({ t: i * 60, o: (l + h) / 2, h, l, c: (l + h) / 2, v });

test('point of control is the price bin holding the most volume', () => {
  const candles = [bar(10, 11, 1, 0), bar(12, 13, 50, 1), bar(14, 15, 1, 2)];
  const p = volumeProfile(candles, { bins: 5, valueAreaPct: 0.7 });
  assert.ok(p);
  assert.ok(p.poc >= 12 && p.poc <= 13, `poc ${p.poc} should sit in the heavy bin`);
});

test('value area encloses the requested share of volume and contains the poc', () => {
  const candles = [bar(10, 11, 5, 0), bar(11, 12, 40, 1), bar(12, 13, 5, 2), bar(13, 14, 1, 3)];
  const p = volumeProfile(candles, { bins: 8, valueAreaPct: 0.7 });
  assert.ok(p);
  assert.ok(p.valueArea.low <= p.poc && p.poc <= p.valueArea.high);
  const total = p.bins.reduce((s, b) => s + b.volume, 0);
  const inside = p.bins
    .filter((b) => b.low >= p.valueArea.low && b.high <= p.valueArea.high)
    .reduce((s, b) => s + b.volume, 0);
  assert.ok(inside / total >= 0.7, `value area holds ${inside / total}`);
});

test('echoes the parameters that produced the levels', () => {
  const p = volumeProfile([bar(10, 11, 1, 0), bar(10, 11, 1, 1)], { bins: 4, valueAreaPct: 0.7 });
  assert.ok(p);
  assert.equal(p.valueAreaPct, 0.7);
  assert.equal(p.basis, 'volume');
  assert.ok(p.binWidth > 0);
});

test('returns null for an empty series or a zero-width range', () => {
  assert.equal(volumeProfile([], { bins: 4, valueAreaPct: 0.7 }), null);
  const flat = [bar(10, 10, 1, 0), bar(10, 10, 1, 1)];
  assert.equal(volumeProfile(flat, { bins: 4, valueAreaPct: 0.7 }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/analysis-volume-profile.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/analysis/volume-profile.ts
//
// Volume by price: the point of control and the value area.
//
// Four things about this primitive are worth knowing before trusting a number it returns,
// and all four are reasons it reports its parameters rather than reasons to skip it:
//
//   1. Bin width dominates the result. Too fine and the point of control jitters between
//      adjacent ticks; too coarse and the value area swallows the whole range.
//   2. This is volume at price, not time at price. They disagree, sometimes sharply, when
//      size trades fast at one level. `basis` says which one you are looking at.
//   3. Crypto has no session, so any daily anchor is arbitrary. This function profiles the
//      candles it is handed and takes no view on where a session starts.
//   4. Perpetual volume reflects positioning, not accepted value. That is a caveat for the
//      agent reading the level, not something the maths can correct.
//
// Volume is spread evenly across the bins a bar's range covers. A bar's true distribution
// within its own range is not knowable from OHLCV, and pretending otherwise (all volume at
// the close, say) puts a sharp fake peak into the profile.

import type { Candle } from '../types.ts';

export type Bin = { low: number; high: number; volume: number };

export type Profile = {
  bins: Bin[];
  poc: number;
  valueArea: { low: number; high: number };
  binWidth: number;
  valueAreaPct: number;
  basis: 'volume';
};

export function volumeProfile(
  candles: Candle[],
  opts: { bins: number; valueAreaPct: number },
): Profile | null {
  const { bins: binCount, valueAreaPct } = opts;
  if (candles.length === 0 || binCount <= 0) return null;

  const low = Math.min(...candles.map((c) => c.l));
  const high = Math.max(...candles.map((c) => c.h));
  if (!(high > low)) return null;

  const binWidth = (high - low) / binCount;
  const bins: Bin[] = Array.from({ length: binCount }, (_, i) => ({
    low: low + i * binWidth,
    high: low + (i + 1) * binWidth,
    volume: 0,
  }));

  for (const c of candles) {
    const first = Math.min(binCount - 1, Math.max(0, Math.floor((c.l - low) / binWidth)));
    const last = Math.min(binCount - 1, Math.max(0, Math.floor((c.h - low) / binWidth)));
    const span = last - first + 1;
    const share = c.v / span;
    for (let i = first; i <= last; i++) bins[i].volume += share;
  }

  let pocIndex = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i].volume > bins[pocIndex].volume) pocIndex = i;
  const poc = (bins[pocIndex].low + bins[pocIndex].high) / 2;

  // Grow out from the point of control, taking the heavier neighbour each step, until the
  // requested share of volume is enclosed. This is the standard market-profile procedure.
  const total = bins.reduce((s, b) => s + b.volume, 0);
  const target = total * valueAreaPct;
  let lo = pocIndex;
  let hi = pocIndex;
  let held = bins[pocIndex].volume;
  while (held < target && (lo > 0 || hi < bins.length - 1)) {
    const below = lo > 0 ? bins[lo - 1].volume : -1;
    const above = hi < bins.length - 1 ? bins[hi + 1].volume : -1;
    if (above >= below) {
      hi += 1;
      held += bins[hi].volume;
    } else {
      lo -= 1;
      held += bins[lo].volume;
    }
  }

  return {
    bins,
    poc,
    valueArea: { low: bins[lo].low, high: bins[hi].high },
    binWidth,
    valueAreaPct,
    basis: 'volume',
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-volume-profile.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/volume-profile.ts tests/unit/analysis-volume-profile.test.ts
git commit -m "Volume profile that reports the parameters behind its levels

Bin width dominates the point of control, volume and time at price disagree
when size trades fast, and perp volume is positioning rather than accepted
value. None of that is fixable in the maths, so the result carries the bin
width and the basis and lets the agent weigh them."
```

---

### Task 5: Level clustering from pivots

**Files:**
- Create: `src/analysis/levels.ts`
- Test: `tests/unit/analysis-levels.test.ts`

**Interfaces:**
- Consumes: `Pivot` from `./pivots.ts`
- Produces:
  - `type Cluster = { price: number; count: number; members: number[]; spread: number; tolerance: number }` where `members` are pivot indexes into the candle series
  - `function clusterLevels(pivots: Pivot[], tolerance: number): Cluster[]` sorted by `count` descending then `price` ascending

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/analysis-levels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterLevels } from '../../src/analysis/levels.ts';
import type { Pivot } from '../../src/analysis/pivots.ts';

const p = (index: number, price: number): Pivot =>
  ({ index, t: index * 60, price, kind: 'high', prominence: 1 });

test('groups pivots that sit within tolerance of each other', () => {
  const out = clusterLevels([p(0, 100), p(1, 100.4), p(2, 120)], 1);
  assert.equal(out.length, 2);
  assert.equal(out[0].count, 2, 'the pair leads because clusters sort by count');
  assert.deepEqual(out[0].members, [0, 1]);
  assert.equal(out[0].price, 100.2, 'the cluster price is the mean of its members');
});

test('reports spread and the tolerance that produced the grouping', () => {
  const out = clusterLevels([p(0, 100), p(1, 100.4)], 1);
  assert.ok(Math.abs(out[0].spread - 0.4) < 1e-9);
  assert.equal(out[0].tolerance, 1);
});

test('a tighter tolerance splits a cluster apart', () => {
  const loose = clusterLevels([p(0, 100), p(1, 100.4)], 1);
  const tight = clusterLevels([p(0, 100), p(1, 100.4)], 0.1);
  assert.equal(loose.length, 1);
  assert.equal(tight.length, 2, 'the same pivots, a different answer, hence tolerance is reported');
});

test('handles an empty list', () => {
  assert.deepEqual(clusterLevels([], 1), []);
});

test('ties on count break by price ascending, so the order is stable', () => {
  const out = clusterLevels([p(0, 50), p(1, 150)], 1);
  assert.deepEqual(out.map((c) => c.price), [50, 150]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/analysis-levels.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/analysis/levels.ts
//
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-levels.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/levels.ts tests/unit/analysis-levels.test.ts
git commit -m "Cluster pivot prices into the levels a trader would draw

Single-link chaining can merge a long run into one wide cluster, so every
cluster reports its spread and the tolerance that grouped it. A chained blob
should be recognisable from the result rather than silent."
```

---

### Task 6: Anchored volume-weighted average price

**Files:**
- Create: `src/analysis/vwap.ts`
- Test: `tests/unit/analysis-vwap.test.ts`

**Interfaces:**
- Consumes: `Candle` from `../types.ts`
- Produces:
  - `function anchoredVwap(candles: Candle[], anchorIndex: number): (number | null)[]` — `null` before the anchor, the running volume-weighted mean from the anchor onward

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/analysis-vwap.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchoredVwap } from '../../src/analysis/vwap.ts';
import type { Candle } from '../../src/types.ts';

const bar = (price: number, v: number, i: number): Candle =>
  ({ t: i * 60, o: price, h: price, l: price, c: price, v });

test('is null before the anchor and starts at the anchor bar price', () => {
  const out = anchoredVwap([bar(10, 1, 0), bar(20, 1, 1), bar(30, 1, 2)], 1);
  assert.equal(out[0], null);
  assert.equal(out[1], 20);
});

test('weights by volume, not by bar count', () => {
  // Typical price is h+l+c over 3, which equals the price for these flat bars.
  const out = anchoredVwap([bar(10, 1, 0), bar(20, 9, 1)], 0);
  assert.equal(out[1], 19, '(10*1 + 20*9) / 10');
});

test('a zero-volume stretch does not divide by zero', () => {
  const out = anchoredVwap([bar(10, 0, 0), bar(20, 0, 1)], 0);
  assert.ok(out.every((v) => v === null || Number.isFinite(v)));
});

test('an out-of-range anchor yields all nulls', () => {
  const out = anchoredVwap([bar(10, 1, 0)], 5);
  assert.deepEqual(out, [null]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/analysis-vwap.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/analysis/vwap.ts
//
// Volume-weighted average price from a bar the agent picks.
//
// The anchor is the whole feature. A session VWAP needs a session, and crypto does not
// have one, so any daily anchor is an arbitrary choice dressed as a convention. Letting
// the agent anchor to a bar it can justify (the swing low, the news candle, the range
// break) is both more honest and more useful.

import type { Candle } from '../types.ts';

export function anchoredVwap(candles: Candle[], anchorIndex: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (anchorIndex < 0 || anchorIndex >= candles.length) return out;

  let volume = 0;
  let notional = 0;
  for (let i = anchorIndex; i < candles.length; i++) {
    const c = candles[i];
    const typical = (c.h + c.l + c.c) / 3;
    volume += c.v;
    notional += typical * c.v;
    // A stretch with no volume has no volume-weighted price. Reporting null beats
    // reporting the unweighted mean under a name that claims weighting.
    out[i] = volume > 0 ? notional / volume : null;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-vwap.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/vwap.ts tests/unit/analysis-vwap.test.ts
git commit -m "Anchored VWAP, because crypto has no session to anchor to

A daily anchor is an arbitrary choice dressed as a convention. Letting the
agent anchor to a bar it can justify is more honest and more useful."
```

---

### Task 7: Range and consolidation detection

**Files:**
- Create: `src/analysis/range.ts`
- Test: `tests/unit/analysis-range.test.ts`

**Interfaces:**
- Consumes: `Candle` from `../types.ts`
- Produces:
  - `type Range = { start: number; end: number; low: number; high: number; bars: number; containment: number; positionInRange: number }`
  - `function detectRange(candles: Candle[], opts: { lookback: number; minContainment: number }): Range | null`
  - `containment` is the fraction of bars in the window whose close sat inside the middle band; `positionInRange` is where the last close sits between `low` (0) and `high` (1).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/analysis-range.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRange } from '../../src/analysis/range.ts';
import type { Candle } from '../../src/types.ts';

const bar = (c: number, i: number): Candle =>
  ({ t: i * 60, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 });

test('finds a range in a series that oscillates inside a band', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const r = detectRange(closes.map(bar), { lookback: 40, minContainment: 0.8 });
  assert.ok(r, 'a tight oscillation is a range');
  assert.equal(r.bars, 40);
  assert.ok(r.high > r.low);
  assert.ok(r.containment >= 0.8);
});

test('reports where the last close sits inside the band', () => {
  const closes = Array.from({ length: 20 }, (_, i) => (i === 19 ? 101 : 99 + (i % 2)));
  const r = detectRange(closes.map(bar), { lookback: 20, minContainment: 0.5 });
  assert.ok(r);
  assert.ok(r.positionInRange > 0.5, 'a close near the top ranks high');
  assert.ok(r.positionInRange <= 1);
});

test('a clean trend is not a range', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 3);
  assert.equal(detectRange(closes.map(bar), { lookback: 40, minContainment: 0.8 }), null);
});

test('returns null without enough bars', () => {
  assert.equal(detectRange([bar(100, 0)], { lookback: 40, minContainment: 0.8 }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/analysis-range.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/analysis/range.ts
//
// Is the recent window a range, and if so where in it are we.
//
// "Range" is defined here as containment: what share of closes sat inside the middle of
// the window's own high-low band. A trending series sweeps through its band and leaves few
// closes in the middle, so containment falls; a chopping series keeps returning, so it
// rises. That makes the test one number with one threshold, which the caller sets and the
// result echoes.
//
// This returns boundaries and a fraction. It does not say "consolidation before a breakout"
// or anything else about what happens next, because that is a conclusion and this file
// only makes measurements.

import type { Candle } from '../types.ts';

export type Range = {
  start: number;
  end: number;
  low: number;
  high: number;
  bars: number;
  containment: number;
  positionInRange: number;
};

export function detectRange(
  candles: Candle[],
  opts: { lookback: number; minContainment: number },
): Range | null {
  const { lookback, minContainment } = opts;
  if (candles.length < Math.min(lookback, 10)) return null;

  const window = candles.slice(-lookback);
  const low = Math.min(...window.map((c) => c.l));
  const high = Math.max(...window.map((c) => c.h));
  if (!(high > low)) return null;

  // The middle 60% of the band. A wider band would call a trend a range; a narrower one
  // would reject an honest chop that leaned.
  const margin = (high - low) * 0.2;
  const inner = window.filter((c) => c.c >= low + margin && c.c <= high - margin).length;
  const containment = inner / window.length;
  if (containment < minContainment) return null;

  const last = window[window.length - 1].c;
  return {
    start: window[0].t,
    end: window[window.length - 1].t,
    low,
    high,
    bars: window.length,
    containment,
    positionInRange: (last - low) / (high - low),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-range.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/range.ts tests/unit/analysis-range.test.ts
git commit -m "Range detection by containment, with no view on what comes next

A trend sweeps its band and leaves few closes in the middle; chop keeps
returning. One number, one caller-set threshold, echoed in the result. It
reports boundaries and position, never a breakout prediction."
```

---

### Task 8: Divergence between price and an oscillator

**Files:**
- Create: `src/analysis/divergence.ts`
- Test: `tests/unit/analysis-divergence.test.ts`

**Interfaces:**
- Consumes: `Pivot` from `./pivots.ts`
- Produces:
  - `type Divergence = { kind: 'bearish' | 'bullish'; priceA: Pivot; priceB: Pivot; oscA: number; oscB: number }`
  - `function divergences(pivots: Pivot[], oscillator: (number | null)[]): Divergence[]`
  - Naming note: `bearish`/`bullish` here are the standard names for the two geometric shapes (price higher high with oscillator lower high, and the mirror). They name a shape, not a recommendation, and the result returns both pivot pairs so the agent can check the claim rather than take it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/analysis-divergence.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { divergences } from '../../src/analysis/divergence.ts';
import type { Pivot } from '../../src/analysis/pivots.ts';

const hi = (index: number, price: number): Pivot =>
  ({ index, t: index * 60, price, kind: 'high', prominence: 1 });
const lo = (index: number, price: number): Pivot =>
  ({ index, t: index * 60, price, kind: 'low', prominence: 1 });

test('price makes a higher high while the oscillator makes a lower high', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[2] = 80;
  osc[8] = 60;
  const out = divergences([hi(2, 100), hi(8, 110)], osc);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'bearish');
  assert.equal(out[0].priceA.index, 2);
  assert.equal(out[0].priceB.index, 8);
  assert.equal(out[0].oscA, 80);
  assert.equal(out[0].oscB, 60);
});

test('price makes a lower low while the oscillator makes a higher low', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[2] = 20;
  osc[8] = 35;
  const out = divergences([lo(2, 100), lo(8, 90)], osc);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'bullish');
});

test('agreement between price and oscillator is not a divergence', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[2] = 60;
  osc[8] = 80;
  assert.deepEqual(divergences([hi(2, 100), hi(8, 110)], osc), []);
});

test('skips pivots where the oscillator has no value', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[8] = 60;
  assert.deepEqual(divergences([hi(2, 100), hi(8, 110)], osc), []);
});

test('compares consecutive pivots of the same kind only', () => {
  const osc = new Array(11).fill(null) as (number | null)[];
  osc[2] = 80;
  osc[5] = 10;
  osc[8] = 60;
  const out = divergences([hi(2, 100), lo(5, 50), hi(8, 110)], osc);
  assert.equal(out.length, 1, 'the low between them does not break the pair');
  assert.equal(out[0].kind, 'bearish');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/analysis-divergence.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/analysis/divergence.ts
//
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-divergence.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/divergence.ts tests/unit/analysis-divergence.test.ts
git commit -m "Divergence returned as evidence, not as a verdict

The two names are the names of two shapes. Both pivot pairs and both
oscillator readings come back so the agent can check the claim, because
divergence fires repeatedly through a strong trend and a verdict here
would usually be a bad one."
```

---

### Task 9: The drawing store

Persistent, id-bearing objects the agent creates, the human sees, and the runner will later trigger off. New object types only: `src/chart.ts` already owns levels and marks, and this task must not touch it.

**Files:**
- Create: `src/drawings.ts`
- Test: `tests/unit/drawings.test.ts`

**Interfaces:**
- Consumes: `Line`, `Anchor` from `./analysis/trendline.ts`
- Produces:
  - `type Drawing = { id: string; kind: 'trendline' | 'zone'; label: string; source: 'human' | 'agent'; createdAt: number; line?: Line; zone?: { low: number; high: number } }`
  - `type DrawingStore = { add(d: Omit<Drawing,'id'|'createdAt'>): Drawing; get(id: string): Drawing | undefined; list(): Drawing[]; remove(id: string): boolean; clear(source?: 'human'|'agent'): number; count(): number }`
  - `function createDrawingStore(opts?: { max?: number; now?: () => number }): DrawingStore`
  - Ids are `tl_1`, `tl_2`, `zn_1` and so on: short, stable, and readable in a strategy program.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/drawings.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawingStore } from '../../src/drawings.ts';

const aLine = { a: { t: 0, price: 10 }, b: { t: 100, price: 20 } };

test('assigns short readable ids per kind', () => {
  const s = createDrawingStore();
  const one = s.add({ kind: 'trendline', label: 'support', source: 'agent', line: aLine });
  const two = s.add({ kind: 'trendline', label: 'resistance', source: 'agent', line: aLine });
  const zone = s.add({ kind: 'zone', label: 'supply', source: 'agent', zone: { low: 1, high: 2 } });
  assert.equal(one.id, 'tl_1');
  assert.equal(two.id, 'tl_2');
  assert.equal(zone.id, 'zn_1');
});

test('round-trips by id and lists in creation order', () => {
  const s = createDrawingStore();
  const d = s.add({ kind: 'trendline', label: 'x', source: 'agent', line: aLine });
  assert.deepEqual(s.get(d.id), d);
  s.add({ kind: 'zone', label: 'y', source: 'human', zone: { low: 1, high: 2 } });
  assert.deepEqual(s.list().map((x) => x.id), ['tl_1', 'zn_1']);
  assert.equal(s.count(), 2);
});

test('removes by id and reports whether anything went', () => {
  const s = createDrawingStore();
  const d = s.add({ kind: 'trendline', label: 'x', source: 'agent', line: aLine });
  assert.equal(s.remove(d.id), true);
  assert.equal(s.remove(d.id), false);
  assert.equal(s.get(d.id), undefined);
});

test('clears by source so a human can drop the agent drawings and keep their own', () => {
  const s = createDrawingStore();
  s.add({ kind: 'trendline', label: 'mine', source: 'human', line: aLine });
  s.add({ kind: 'trendline', label: 'theirs', source: 'agent', line: aLine });
  assert.equal(s.clear('agent'), 1);
  assert.deepEqual(s.list().map((d) => d.label), ['mine']);
  assert.equal(s.clear(), 1, 'no argument clears everything');
  assert.equal(s.count(), 0);
});

test('caps total drawings, dropping the oldest agent drawing first', () => {
  const s = createDrawingStore({ max: 2 });
  s.add({ kind: 'trendline', label: 'human keep', source: 'human', line: aLine });
  s.add({ kind: 'trendline', label: 'agent old', source: 'agent', line: aLine });
  s.add({ kind: 'trendline', label: 'agent new', source: 'agent', line: aLine });
  assert.equal(s.count(), 2);
  const labels = s.list().map((d) => d.label);
  assert.ok(labels.includes('human keep'), 'a human drawing is never evicted for an agent one');
  assert.ok(labels.includes('agent new'));
});

test('ids never repeat even after a removal', () => {
  const s = createDrawingStore();
  const first = s.add({ kind: 'trendline', label: 'a', source: 'agent', line: aLine });
  s.remove(first.id);
  const second = s.add({ kind: 'trendline', label: 'b', source: 'agent', line: aLine });
  assert.notEqual(second.id, first.id, 'a reused id would repoint a live strategy trigger');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/drawings.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/drawings.ts
//
// The objects that make the chart a shared coordinate system: the agent draws one, the
// human sees it, and a strategy program refers to it by id.
//
// Two rules that exist because a live strategy will hold these ids:
//
//   1. An id is never reused, even after the drawing is removed. Reusing `tl_3` would
//      silently repoint a trigger at a different line, which is the worst possible kind of
//      bug on a money surface: nothing errors, the bot just starts watching the wrong price.
//   2. Eviction under the cap takes the oldest AGENT drawing. A human drawing is never
//      evicted to make room for an agent one, because the human did not consent to their
//      own work being dropped by something the agent did.
//
// Levels and marks are deliberately absent: src/chart.ts already owns those, and this file
// exists alongside it rather than replacing it.

import type { Line } from './analysis/trendline.ts';

export type Drawing = {
  id: string;
  kind: 'trendline' | 'zone';
  label: string;
  source: 'human' | 'agent';
  createdAt: number;
  line?: Line;
  zone?: { low: number; high: number };
};

export type DrawingStore = {
  add(d: Omit<Drawing, 'id' | 'createdAt'>): Drawing;
  get(id: string): Drawing | undefined;
  list(): Drawing[];
  remove(id: string): boolean;
  clear(source?: 'human' | 'agent'): number;
  count(): number;
};

const PREFIX: Record<Drawing['kind'], string> = { trendline: 'tl', zone: 'zn' };
const DEFAULT_MAX = 200;

export function createDrawingStore(opts?: { max?: number; now?: () => number }): DrawingStore {
  const max = opts?.max ?? DEFAULT_MAX;
  const now = opts?.now ?? (() => Date.now());
  const items = new Map<string, Drawing>();
  const counters: Record<string, number> = {};

  function nextId(kind: Drawing['kind']): string {
    const p = PREFIX[kind];
    counters[p] = (counters[p] ?? 0) + 1;
    return `${p}_${counters[p]}`;
  }

  function evictIfNeeded(): void {
    while (items.size > max) {
      const oldestAgent = [...items.values()]
        .filter((d) => d.source === 'agent')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      // With nothing of the agent's left to drop, the cap yields rather than take the
      // human's work. A cap is a guard against agent runaway, not a reason to lose a drawing
      // the human made on purpose.
      if (!oldestAgent) return;
      items.delete(oldestAgent.id);
    }
  }

  return {
    add(d) {
      const full: Drawing = { ...d, id: nextId(d.kind), createdAt: now() };
      items.set(full.id, full);
      evictIfNeeded();
      return full;
    },
    get: (id) => items.get(id),
    list: () => [...items.values()],
    remove: (id) => items.delete(id),
    clear(source) {
      let n = 0;
      for (const [id, d] of [...items.entries()]) {
        if (source === undefined || d.source === source) {
          items.delete(id);
          n += 1;
        }
      }
      return n;
    },
    count: () => items.size,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/drawings.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/drawings.ts tests/unit/drawings.test.ts
git commit -m "Drawing store: ids a strategy can hold, and never reuses one

A reused id would silently repoint a live trigger at a different line, which
errors nowhere and just starts watching the wrong price. Eviction under the
cap takes the oldest agent drawing and never a human one."
```

---

### Task 10: History paging

Unlimited history without loading it all. The venue's `candleSnapshot` takes a time range, so the cursor is a timestamp.

**Files:**
- Create: `src/history.ts`
- Test: `tests/unit/history.test.ts`

**Interfaces:**
- Consumes: `Candle` from `./types.ts`
- Produces:
  - `type Page = { candles: Candle[]; cursor: number | null; complete: boolean }`
  - `type Fetcher = (product: string, granularitySec: number, endSec: number, limit: number) => Promise<Candle[]>`
  - `function createHistory(fetch: Fetcher, opts?: { pageSize?: number }): { page(product: string, granularitySec: number, cursor: number | null, limit?: number): Promise<Page> }`
  - `cursor` is the exclusive upper bound in seconds; `null` means "from now". A returned `cursor` of `null` with `complete: true` means the venue has no more history.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/history.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../../src/history.ts';
import type { Candle } from '../../src/types.ts';

function fakeSeries(count: number, granularity: number, endSec: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const t = endSec - (count - i) * granularity;
    return { t, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 };
  });
}

test('returns a page and a cursor pointing before its oldest bar', async () => {
  const h = createHistory(async (_p, g, end, limit) => fakeSeries(limit, g, end));
  const page = await h.page('ETH', 60, null, 10);
  assert.equal(page.candles.length, 10);
  assert.equal(page.complete, false);
  assert.equal(page.cursor, page.candles[0].t, 'cursor is the oldest bar time, exclusive next call');
});

test('a short page means the venue ran out of history', async () => {
  const h = createHistory(async (_p, g, end) => fakeSeries(3, g, end));
  const page = await h.page('ETH', 60, null, 10);
  assert.equal(page.candles.length, 3);
  assert.equal(page.complete, true);
  assert.equal(page.cursor, null);
});

test('an empty page is complete and carries no cursor', async () => {
  const h = createHistory(async () => []);
  const page = await h.page('ETH', 60, 5000, 10);
  assert.deepEqual(page, { candles: [], cursor: null, complete: true });
});

test('passes the cursor through as the end bound', async () => {
  let seenEnd = -1;
  const h = createHistory(async (_p, g, end, limit) => {
    seenEnd = end;
    return fakeSeries(limit, g, end);
  });
  await h.page('ETH', 60, 12345, 5);
  assert.equal(seenEnd, 12345);
});

test('sorts and de-duplicates whatever the venue returns', async () => {
  const h = createHistory(async () => [
    { t: 300, o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: 100, o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: 300, o: 9, h: 9, l: 9, c: 9, v: 9 },
    { t: 200, o: 1, h: 1, l: 1, c: 1, v: 1 },
  ]);
  const page = await h.page('ETH', 60, null, 10);
  assert.deepEqual(page.candles.map((c) => c.t), [100, 200, 300]);
  assert.equal(page.candles[2].o, 9, 'the later duplicate wins, since it is the fresher read');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/history.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/history.ts
//
// Walking backwards through history one page at a time.
//
// The cursor is a timestamp rather than an offset because the venue's candle endpoint is
// addressed by time range. An offset cursor would have to be translated on every call and
// would break the moment a bar was backfilled.
//
// De-duplication is not paranoia: the venue returns a closed range, so consecutive pages
// can repeat a boundary bar, and a repeated bar would be counted twice by anything summing
// volume. The later read wins because it is the fresher one.

import type { Candle } from './types.ts';

export type Page = { candles: Candle[]; cursor: number | null; complete: boolean };

export type Fetcher = (
  product: string,
  granularitySec: number,
  endSec: number,
  limit: number,
) => Promise<Candle[]>;

const DEFAULT_PAGE = 500;

export function createHistory(fetch: Fetcher, opts?: { pageSize?: number }) {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE;

  return {
    async page(
      product: string,
      granularitySec: number,
      cursor: number | null,
      limit?: number,
    ): Promise<Page> {
      const want = limit ?? pageSize;
      const end = cursor ?? Math.floor(Date.now() / 1000);
      const raw = await fetch(product, granularitySec, end, want);

      const byTime = new Map<number, Candle>();
      for (const c of raw) byTime.set(c.t, c);
      const candles = [...byTime.values()].sort((a, b) => a.t - b.t);

      if (candles.length === 0) return { candles: [], cursor: null, complete: true };

      // Fewer bars than asked for is how the venue says it has no more. Using the returned
      // count rather than a separate "hasMore" flag keeps this working against any source
      // that honours a limit.
      const complete = raw.length < want;
      return { candles, cursor: complete ? null : candles[0].t, complete };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/history.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/history.ts tests/unit/history.test.ts
git commit -m "History paging with a timestamp cursor

The venue addresses candles by time range, so an offset cursor would need
translating on every call and would break on a backfill. Consecutive pages
repeat a boundary bar, so pages de-duplicate and the fresher read wins."
```

---

### Task 11: The batch envelope

The thing that makes an analysis turn cost one round trip instead of nine.

**Files:**
- Create: `src/batch.ts`
- Test: `tests/unit/batch.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks directly; it dispatches to handlers supplied by the caller, which is what keeps it testable without a server.
- Produces:
  - `type Op = { op: string; args?: Record<string, unknown>; as?: string }`
  - `type OpResult = { op: string; as?: string; ok: true; value: unknown } | { op: string; as?: string; ok: false; error: string }`
  - `type Handler = (args: Record<string, unknown>, refs: Record<string, unknown>) => Promise<unknown> | unknown`
  - `function runBatch(ops: Op[], handlers: Record<string, Handler>, opts?: { max?: number }): Promise<OpResult[]>`
  - An op may name itself with `as`, and later ops read earlier results through the `refs` object their handler receives. `$ref:name` inside a string argument resolves to a previous result before the handler runs.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/batch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../../src/batch.ts';

const echo = { echo: (args: Record<string, unknown>) => args };

test('runs ops in order and returns one result each', async () => {
  const out = await runBatch(
    [{ op: 'echo', args: { n: 1 } }, { op: 'echo', args: { n: 2 } }],
    echo,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => (r.ok ? r.value : null)), [{ n: 1 }, { n: 2 }]);
});

test('a later op can reference an earlier result by name', async () => {
  const handlers = {
    make: () => ({ id: 'tl_1' }),
    use: (args: Record<string, unknown>) => ({ got: args.target }),
  };
  const out = await runBatch(
    [
      { op: 'make', as: 'line' },
      { op: 'use', args: { target: '$ref:line.id' } },
    ],
    handlers,
  );
  assert.ok(out[1].ok);
  assert.deepEqual(out[1].ok && out[1].value, { got: 'tl_1' });
});

test('one failing op does not abort the batch', async () => {
  const handlers = {
    boom: () => {
      throw new Error('nope');
    },
    echo: (args: Record<string, unknown>) => args,
  };
  const out = await runBatch([{ op: 'boom' }, { op: 'echo', args: { n: 1 } }], handlers);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].ok === false && out[0].error, 'nope');
  assert.equal(out[1].ok, true, 'the batch keeps going');
});

test('an unknown op fails that entry with a listing of what exists', async () => {
  const out = await runBatch([{ op: 'nope' }], echo);
  assert.equal(out[0].ok, false);
  assert.match(out[0].ok === false ? out[0].error : '', /unknown op.*echo/i);
});

test('an unresolvable reference fails only its own op', async () => {
  const out = await runBatch(
    [{ op: 'echo', args: { x: '$ref:missing.id' } }, { op: 'echo', args: { n: 1 } }],
    echo,
  );
  assert.equal(out[0].ok, false);
  assert.match(out[0].ok === false ? out[0].error : '', /missing/);
  assert.equal(out[1].ok, true);
});

test('caps batch size so one call cannot become a denial of service', async () => {
  const ops = Array.from({ length: 5 }, () => ({ op: 'echo', args: {} }));
  const out = await runBatch(ops, echo, { max: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, false);
  assert.match(out[0].ok === false ? out[0].error : '', /at most 3/);
});

test('awaits async handlers', async () => {
  const out = await runBatch([{ op: 'slow' }], { slow: async () => 'done' });
  assert.equal(out[0].ok && out[0].value, 'done');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/batch.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

```ts
// src/batch.ts
//
// Many operations, one round trip.
//
// The agent's latency is round trips, not milliseconds: every MCP call is an LLM turn, so
// an analysis that takes nine calls takes most of a minute. This envelope collapses that
// into one call, and `$ref` is what makes it more than a convenience: drawing a line and
// then measuring against it stays a single turn because the second op can name the first
// op's result.
//
// Ops run sequentially, on purpose. `$ref` implies order, and a nine-op batch is bounded
// work already; running them concurrently would buy microseconds and cost the guarantee.
//
// One failing op does not abort the batch. A partial answer with a named failure is more
// useful to a model than a single error for the whole call, which tells it nothing about
// which of nine things went wrong.

export type Op = { op: string; args?: Record<string, unknown>; as?: string };

export type OpResult =
  | { op: string; as?: string; ok: true; value: unknown }
  | { op: string; as?: string; ok: false; error: string };

export type Handler = (
  args: Record<string, unknown>,
  refs: Record<string, unknown>,
) => Promise<unknown> | unknown;

const DEFAULT_MAX = 32;
const REF = /^\$ref:([A-Za-z0-9_]+)((?:\.[A-Za-z0-9_]+)*)$/;

function resolvePath(root: unknown, path: string): unknown {
  if (path === '') return root;
  let current: unknown = root;
  for (const key of path.slice(1).split('.')) {
    if (current === null || typeof current !== 'object') {
      throw new Error(`cannot read '${key}' of a non-object in reference`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Only strings that are ENTIRELY a reference resolve. Substring interpolation was rejected:
// a price label reading "$ref:..." as part of prose would be silently rewritten, and a
// label is human-visible text on a money surface.
function resolveArgs(
  args: Record<string, unknown>,
  refs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const m = REF.exec(v);
      if (m) {
        const [, name, path] = m;
        if (!(name in refs)) throw new Error(`unknown reference '${name}' in argument '${k}'`);
        out[k] = resolvePath(refs[name], path);
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

export async function runBatch(
  ops: Op[],
  handlers: Record<string, Handler>,
  opts?: { max?: number },
): Promise<OpResult[]> {
  const max = opts?.max ?? DEFAULT_MAX;
  if (ops.length > max) {
    return [{ op: 'batch', ok: false, error: `a batch takes at most ${max} ops, got ${ops.length}` }];
  }

  const results: OpResult[] = [];
  const refs: Record<string, unknown> = {};

  for (const entry of ops) {
    const handler = handlers[entry.op];
    if (!handler) {
      results.push({
        op: entry.op,
        as: entry.as,
        ok: false,
        error: `unknown op '${entry.op}'. known ops: ${Object.keys(handlers).sort().join(', ')}`,
      });
      continue;
    }
    try {
      const args = resolveArgs(entry.args ?? {}, refs);
      const value = await handler(args, refs);
      if (entry.as) refs[entry.as] = value;
      results.push({ op: entry.op, as: entry.as, ok: true, value });
    } catch (err) {
      results.push({
        op: entry.op,
        as: entry.as,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/batch.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/batch.ts tests/unit/batch.test.ts
git commit -m "Batch envelope: many operations, one round trip

The agent's latency is round trips, not milliseconds, because every call is
an LLM turn. \$ref is what makes this more than a convenience: draw a line
and measure against it in the same turn. One failing op does not abort the
batch, since a partial answer with a named failure beats one opaque error."
```

---

### Task 12: Wire the analysis ops into the server and MCP

**Do not start this task until the chart agent's work is committed on `main` and merged into this branch.** Tasks 1 to 11 touched no shared file; this one touches three. Check first:

```bash
cd ~/Developer/phosphor && git log --oneline -3 && git status --short
```

If `src/chart.ts`, `src/mcp.ts` or `src/server.ts` show as modified there, stop and report rather than merging over live edits.

**Files:**
- Modify: `src/server.ts` (add the analysis op handlers and the `chart_batch` route branch)
- Modify: `src/mcp.ts` (register `chart_batch`, extend the read tool list)
- Create: `src/analysis/index.ts` (the op table: name to handler)
- Test: `tests/unit/analysis-ops.test.ts`

**Interfaces:**
- Consumes: every module from Tasks 1 to 11
- Produces: `function analysisHandlers(deps: { candles(product: string, granularitySec: number, limit: number): Promise<Candle[]>; history: ReturnType<typeof createHistory>; drawings: DrawingStore }): Record<string, Handler>`

- [ ] **Step 1: Merge the chart agent's work and confirm the tree is clean**

```bash
cd ~/Developer/phosphor-trade
git fetch . main:main 2>/dev/null || true
git merge main -m "Merge chart v2 before wiring the analysis ops"
npm test && npm run typecheck
```

Expected: merge clean or trivially resolved, existing tests still green. If `src/chart.ts` conflicts, resolve in favour of the chart agent's version and re-run.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/analysis-ops.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisHandlers } from '../../src/analysis/index.ts';
import { createDrawingStore } from '../../src/drawings.ts';
import { createHistory } from '../../src/history.ts';
import { runBatch } from '../../src/batch.ts';
import type { Candle } from '../../src/types.ts';

function fixture(): Candle[] {
  const closes = [10, 12, 20, 12, 10, 12, 4, 12, 10, 11, 13, 9];
  return closes.map((c, i) => ({ t: 1000 + i * 60, o: c, h: c + 1, l: c - 1, c, v: 10 }));
}

function deps() {
  const candles = fixture();
  return {
    candles: async () => candles,
    history: createHistory(async () => candles),
    drawings: createDrawingStore(),
  };
}

test('exposes every primitive as a named op', async () => {
  const h = analysisHandlers(deps());
  for (const name of [
    'pivots', 'trendline_fit', 'trendline_at', 'trendline_touches',
    'levels', 'regime', 'volume_profile', 'vwap', 'range', 'divergence',
    'history_page', 'draw', 'drawings_list', 'drawings_clear',
  ]) {
    assert.ok(name in h, `missing op ${name}`);
  }
});

test('draw then measure against the drawn line in one batch', async () => {
  const h = analysisHandlers(deps());
  const out = await runBatch(
    [
      { op: 'pivots', args: { product: 'ETH', granularitySec: 60, window: 2, minProminence: 3 }, as: 'p' },
      { op: 'draw', args: { kind: 'trendline', label: 'support', a: { t: 1000, price: 9 }, b: { t: 1660, price: 12 } }, as: 'line' },
      { op: 'trendline_at', args: { id: '$ref:line.id', t: 2000 } },
    ],
    h,
  );
  assert.ok(out.every((r) => r.ok), JSON.stringify(out));
  assert.equal(typeof (out[2].ok && out[2].value), 'number');
});

test('every parameterised result echoes its parameters', async () => {
  const h = analysisHandlers(deps());
  const r = await h.regime({ product: 'ETH', granularitySec: 60, period: 3, lookback: 10 }, {});
  assert.equal((r as { period: number }).period, 3);
  assert.equal((r as { lookback: number }).lookback, 10);
});

test('no op returns a signal, score or recommendation field', async () => {
  const h = analysisHandlers(deps());
  const results = await runBatch(
    [
      { op: 'pivots', args: { product: 'ETH', granularitySec: 60, window: 2, minProminence: 1 } },
      { op: 'regime', args: { product: 'ETH', granularitySec: 60, period: 3, lookback: 10 } },
      { op: 'range', args: { product: 'ETH', granularitySec: 60, lookback: 12, minContainment: 0.1 } },
    ],
    h,
  );
  const banned = ['signal', 'score', 'recommendation', 'action', 'confidence', 'rating'];
  const text = JSON.stringify(results).toLowerCase();
  for (const word of banned) {
    assert.ok(!text.includes(`"${word}"`), `analysis returned a ${word} field, which is a conclusion`);
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/unit/analysis-ops.test.ts`
Expected: FAIL, cannot find module `src/analysis/index.ts`.

- [ ] **Step 4: Write `src/analysis/index.ts`**

Build the op table. Each handler loads candles through `deps.candles(product, granularitySec, limit)`, calls one primitive from Tasks 1 to 8, and returns its result unchanged. `draw` writes to `deps.drawings` and returns the created `Drawing` so `$ref:line.id` resolves. `trendline_at` and `trendline_touches` look the line up by id from `deps.drawings` and fail with a clear message when the id is unknown.

Keep every handler under ten lines. The primitives already hold the logic; this file is a table, and a table that starts computing is a table that has drifted from the modules it fronts.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/unit/analysis-ops.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Register `chart_batch` in `src/mcp.ts` and route it in `src/server.ts`**

In `src/mcp.ts`, add one tool beside the existing `registerRead` calls:

```ts
registerRead(
  'chart_batch',
  'Run many chart reads, measurements and drawings in one call. Each entry is { op, args, as }. ' +
    'A later entry can reference an earlier one with "$ref:<as>.<field>". Returns one result per entry. ' +
    'Returns measurements only, never signals or recommendations.',
  { ops: z.array(z.object({ op: z.string(), args: z.record(z.unknown()).optional(), as: z.string().optional() })) },
);
```

In `src/server.ts`, inside `handleRead`, add a branch for `chart_batch` that calls `runBatch(args.ops, analysisHandlers(deps))` and returns the result array.

- [ ] **Step 7: Verify the injection test still passes**

Run: `node --test tests/injection.test.ts`
Expected: PASS. The new schema carries `ops` only, no address-shaped field.

- [ ] **Step 8: Full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: everything green.

- [ ] **Step 9: Commit**

```bash
git add src/analysis/index.ts src/mcp.ts src/server.ts tests/unit/analysis-ops.test.ts
git commit -m "Wire the analysis ops behind one batched MCP tool

chart_batch is the only new tool: fourteen operations behind one call, with
\$ref so drawing a line and measuring against it is a single turn. A test
asserts no op returns a signal, score or recommendation field, because the
line between a measurement and a conclusion is the design and not a habit."
```

---

### Task 13: Render trend lines and zones on the chart

**Files:**
- Modify: `ui/chart.js` (draw the new object kinds on the scene canvas)
- Modify: `src/server.ts` (include drawings in the chart payload and bump `rev` on change)
- Test: manual, through the UI gate in Task 14

**Interfaces:**
- Consumes: `Drawing` from `src/drawings.ts`

- [ ] **Step 1: Include drawings in the chart state the browser receives**

In `src/server.ts`, add `drawings: drawings.list()` to the chart payload, and bump the existing chart `rev` whenever the drawing store changes so the browser's echo control keeps working unchanged.

- [ ] **Step 2: Draw them**

In `ui/chart.js`, on the scene canvas (not the hud, since these change only when data or view changes):
- a `trendline` is a stroked line between its two anchors projected through the current time-to-x and price-to-y transforms, extended to both plot edges
- a `zone` is a filled rectangle at 12% alpha between its two prices, spanning the full plot width
- both carry their label in the existing chart label register, at the right edge, and an `[agent]` suffix when `source === 'agent'`

Use the existing palette variables. No new colour is introduced: red stays reserved for the approval gate per `.design/brief.md`, so an agent drawing uses the same phosphor green at a lower brightness tier.

- [ ] **Step 3: Confirm by eye at 1440x900**

Run the app, use `chart_batch` to draw one trend line and one zone, and confirm both appear, sit at the right prices, and survive a pan and a zoom.

- [ ] **Step 4: Commit**

```bash
git add ui/chart.js src/server.ts
git commit -m "Render trend lines and zones the agent drew

Drawn on the scene canvas, since they change with data and view rather than
with the pointer. No new colour: red stays reserved for the approval gate,
so an agent drawing is phosphor green at a lower brightness tier."
```

---

### Task 14: Update the design brief and pass the UI gate

`.design/brief.md` still says "No indicators, no drawing tools, no crosshair". Chart v2 already contradicts it and this work contradicts it further. `ui-gate.mjs` judges the page against this file, so it fails until the contract matches what was actually asked for.

**Files:**
- Modify: `.design/brief.md`

- [ ] **Step 1: Check whether the chart agent already updated it**

```bash
cd ~/Developer/phosphor-trade && git log --oneline -5 -- .design/brief.md
```

If chart v2 already rewrote the chart bullets, edit around them and do not restate them.

- [ ] **Step 2: Replace the stale chart bullets**

Remove "No indicators, no drawing tools, no crosshair". Add, in the brief's existing voice:

```markdown
- The chart carries indicators, a crosshair, and objects an agent can draw: horizontal levels,
  trend lines and zones. Anything the agent drew is labelled `[agent]` and the chart bar shows a
  count with a one-click clear, so the human can always tell their own marks from the agent's
- Agent drawings use the same phosphor green at a lower brightness tier. No new hue: red stays
  exclusively the approval gate's, so the gate is still the only alarm on the page
```

- [ ] **Step 3: Run the gate**

Run: `node ~/.claude/tools/ui-gate.mjs http://127.0.0.1:4177 --src ui`
Expected: iterate to `UI-GATE: PASS`. Read the screenshot every round; the audit is blind to composition.

- [ ] **Step 4: Commit**

```bash
git add .design/brief.md
git commit -m "Brief: the chart has indicators and drawings now

The brief is the design contract the UI gate judges against, and it still
forbade the things two specs have since asked for. Updating it is part of
the work rather than something to discover as a gate failure."
```

---

## Self-Review

**Spec coverage.** Instrument surface: batch envelope (Task 11), seeing and history paging (Task 10), measuring (Tasks 1 to 8), drawing (Task 9), geometry (Task 2's `lineAt` and `touches`), indicators over a range (Task 12 fronts the existing catalogue). The measurement-versus-conclusion line is enforced by a test in Task 12, not left as prose. The `.design/brief.md` mismatch the spec flags is Task 14. Mandate, grammar, runner, order signing, risk supervision and chart rendering of positions are all Plan 2 and are deliberately absent here.

**Placeholders.** Tasks 1 to 11 carry complete test and implementation code. Task 12 Step 4 and Task 13 Step 2 describe shape rather than showing full source, because both edit files another agent is actively changing and exact line-anchored code would be stale by the time it is read. Both specify the interface, the constraints and the acceptance test precisely enough to implement without a further decision.

**Type consistency.** `Candle` is the existing `src/types.ts` shape everywhere. `Pivot` flows unchanged from Task 1 into Tasks 5 and 8. `Line` and `Anchor` are defined once in Task 2 and consumed by Task 9. `Handler`, `Op` and `OpResult` are defined in Task 11 and are what Task 12's `analysisHandlers` returns. `Drawing` and `DrawingStore` are defined in Task 9 and consumed in Tasks 12 and 13. `createHistory`'s return type is referenced structurally in Task 12 rather than re-declared.

**One risk worth stating.** Task 12 depends on merging the chart agent's work, and Task 13 touches `ui/chart.js`, which that agent also owns. Tasks 1 to 11 are entirely conflict-free by construction and can proceed today regardless.
