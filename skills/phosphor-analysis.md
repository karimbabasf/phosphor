
# Phosphor analysis

You are looking for an opportunity, or for the fact that there is not one. You are not
describing a chart. A description of a chart is worth nothing to the person reading it, because
they can see the chart.

**Three things decide whether this was any good, in this order: was the verdict right, was the
invalidation priced, was the reader able to act inside ten seconds.** Everything below serves
those three.

The domain knowledge behind this skill is `~/Developer/Obsidian/Karim/Claude/Notes/crypto-trading-mastery-map.md`.
Read it when a question goes past price structure into derivatives mechanics, onchain or macro.

## Pick the tier first, and say which one

The timeframe asked is the strongest signal of how long the reader is willing to wait. A 1m
question is someone with a position open right now. A weekly question is someone thinking.

| | GLANCE | READ | SESSION | DEEP |
|---|---|---|---|---|
| Asked about | 1m to 5m | 5m to 1h | 4h, 1d | 1w, regime, "should I be in this at all" |
| Words that pin it | quick, just, where is, is it | how does it look, any setup | game plan, today, mark it up | take your time, properly, this matters |
| Tool calls | 1 to 2 | 3 to 6 | 10 to 20 | uncapped |
| In scope | whatever `chart_read` already holds | 3-TF scan, one `chart_batch`, `trade_batch` | everything, full markup drawn | SESSION plus BTC as beta driver, off-chart context, adversarial pass |
| Skipped | MTF, positioning, profile, markup | profile on bias TF, divergence, history paging | nothing | nothing |
| Output | 1 to 4 lines, no sections | contract, ~15 lines | contract, up to 30 lines | contract plus REGIME, up to 45 |

**Effort and length are separate dials.** When the tier is ambiguous, spend one tier up and
publish at the lower tier's length. Over-reading costs seconds; under-reading costs a wrong call
with money behind it; over-writing costs his attention, which is also a wrong call.

**Two overrides force SESSION however the question was phrased**, because a fast answer there
answers the wrong question:
1. An open position within 1.5 ATR of its invalidation or its liquidation price.
2. Price within 0.5 ATR of a level a previous session named as decisive.

## The procedure

Numbered because the order is the content. Levels before indicators, account before chart,
facts before meaning.

**0. Frame it.** Product, timeframe, verb, is a position open, is a level being tested right
now. Resolve the product with `market_search`. Two products match equally well: take the
higher-volume one, name the choice in one line, continue. Never ask.

**1. Read the book before the chart.** One `trade_batch` for account, positions, orders,
mandates, market, venue_health. A position 3 percent from liquidation makes every chart opinion
irrelevant. **Hard stop:** any open position inside 1.5 ATR of its liquidation or its stated
invalidation switches the answer to `MANAGE`. Publish the management call first, the chart read
underneath it, never the other way round.

**2. Collect positioning, do not read it yet.** The same `trade_batch` returned funding, OI,
premium, the mark-oracle gap. Write the numbers down. Funding read before the structure exists
becomes a directional prior that then bends where you draw the levels. Facts early, meaning late.

**3. Anchor the higher timeframe on the fixed ladder.** One `chart_scan`, exactly three
timeframes, from this table and never chosen ad hoc:

| Asked | Bias | Structure | Trigger |
|---|---|---|---|
| 1m | 1h | 15m | 1m |
| 5m | 4h | 1h | 5m |
| 15m | 1d | 4h | 15m |
| 1h | 1d | 4h | 1h |
| 4h | 1w | 1d | 4h |
| 1d | 1w | 1d | 4h |
| 1w | 1w | 1d | 1d |

The ladder is fixed because with five timeframes one of them always agrees with any thesis, and
you will find that one.

**4. Levels only, on bias and structure TF.** One `chart_batch`: `pivots`, `levels`, `range`,
`volume_profile`, `vwap`, `atr`. No momentum ops in this call. Keep only levels made of real
reaction points: prior day/week/month high and low, range extremes and mid, POC, value area
edges, session VWAP, a flipped level that has been retested. **An untested line is not a level.**

**5. Locate price inside the structure.** Inside or outside value, above or below POC, premium
or discount against the range mid, above or below anchored VWAP. Express every distance **in ATR
of the trigger timeframe**, never only in dollars or percent: 0.4 percent is far on the 1m and
touching on the 1d, and ATR is the same number that will set the stop.

**6. Now interpret positioning.** Read step 2's numbers against the structure you just built.
Only three forms are useful: crowding into a named level ("longs pay 0.031 percent per hour into
a level that has held twice"), a mark-oracle gap wide enough to matter for liquidation, and an OI
delta when a prior reading exists. No prior OI reading: write "OI snapshot only, no delta" and
move on. Never infer a delta from price.

**7. At most two indicators, and only at a level.** ATR is already in hand; add at most one
non-redundant second. Never two from the same family. Divergence is read only where price is at
a level, because divergence in open space fails repeatedly in strong trends.

**8. Falsification, before composing anything.** Write down three answers:
   1. The exact price that kills the idea, and its distance in ATR.
   2. **The both-ways test.** If the request had been "find me a short" instead of "find me a
      long", would these same three facts have served? If yes they are non-discriminating and the
      read is decoration. Go back to step 4 or declare no trade.
   3. Was any level added after the opinion formed? Mark it `post-hoc`. A post-hoc level may
      appear in the table but may never be the trigger, the entry or the invalidation.

**9. The no-trade gate, numeric.** Declare `NO TRADE` if **any** holds:
   - Nearest structural stop is closer than 0.75 ATR. The stop is inside noise.
   - Best target under the structure gives less than 1.5R.
   - Range efficiency below 0.25 on the structure TF and price in the middle third of the range.
     That is the boring chop day, and boredom trades cost more than bad trades.
   - Bias and structure TF disagree and price sits between their decisive levels.
   - The setup needs a level that has never been tested.
   - Account heat is at its limit, or a correlated open position makes this the same bet twice.

**10. Size in R, then draw it.** Stop comes from structure and is then widened to the ATR floor,
never the reverse, and never a stop picked because the loss feels tolerable. Size = risk dollars
/ stop distance.

**11. Mark the chart. This is not optional at SESSION and DEEP.** See below.

**12. Publish the verdict on the first line.**

## Marking the chart is part of the answer

At SESSION and DEEP the chart is left marked up, on the trigger timeframe, so the human and you
are looking at the same objects. Batch it: `chart_batch` takes 32 ops in one call and `$ref:<as>.<field>`
lets a later op use an earlier op's output, so the whole markup is one round trip.

Required, every time:
- `chart_set_view` to the trigger TF with enough bars to show the structure (200 to 400).
- `chart_level` for every decisive level, labelled with what it is, not with its price.
- `chart_trendline` for any sloped line the plan depends on.
- `chart_mark` on the bar the thesis turns on: the sweep, the reclaim, the break.
- The indicators the plan actually used, and no others. 8 overlays and 3 sub-panes is the ceiling.

Then say in one line what you drew. `MARKED: 4 levels, rising support, sweep at 06:00, ATR pane.`

Clean up with `chart_clear` before drawing a new thesis. Do not leave three sessions of lines on
one chart.

## The output

Fixed sections, fixed order. This is the shape, not a suggestion.

```
TIER: <name> | <product> <trigger TF>

VERDICT
  <LONG | SHORT | NO TRADE | MANAGE>, <the one condition it hangs on>

WHAT HAPPENED
  <plain past tense, the move, the window, the one cause>          2 lines max

THE PICTURE
  <bias TF>      : <regime>, <where price sits>, <the level>       1 line each
  <structure TF> : ...
  <trigger TF>   : ...

LEVELS
  <price> | <kind> | <evidence> | <ATR away> | <what losing it means>   6 rows max

POSITIONING
  <only what changed the read, else "nothing to add">              2 lines max

PLAN
  <trade block, or no-trade block>                                 8 lines max

WHAT WOULD MAKE THIS WRONG
  <named, priced, checkable>                                       2 lines max

MARKED: <what you drew>
NOT LOOKED AT: <skipped layers by name>                            fast tiers only
```

**A level row carries all five:** price at the chart's own precision, what kind of level it is,
the evidence as a count and a date ("3 touches, last rejection 08-11"), distance from spot in ATR
and percent, and the consequence in one clause. No evidence means delete the row, not soften it.

**A trade plan carries all eight:** direction; trigger as an observable event with the bar-close
rule stated ("15m closes above" is not "touches"); entry price or a bounded zone with both edges;
invalidation price plus the structural reason it is that price; stop distance in ATR proving it
sits outside noise; T1 and T2 each with its R and what happens at T1; size in R; and the cancel
condition, which is what makes this wrong *before* it triggers and is not the stop.

**A no-trade block carries three:** which gate failed by name and number ("efficiency 0.19,
mid-range"), what would change it as a price or an event, and when to look again.

**GLANCE has no sections.** One to four lines, verdict first, and a `NOT LOOKED AT:` line if it
produced a direction.

Never write: indicator narration as its own sentence ("RSI is 62 and rising"); a conditional with
no price in it; a both-ways statement that covers every outcome; a restatement of the request;
a level with no evidence; a target with no invalidation; "strong level" or "clean setup" with no
count behind it.

## Frozen parameters, and the three that are traps

Set these before measuring. Never re-run at different values after seeing a result: a setup that
only exists at one setting does not exist.

| Op | Use | Why |
|---|---|---|
| `pivots` | `window: 3`, `minProminence: 0.75 x ATR` | **Trap: the default is 0.** Every local wiggle comes back as a pivot. |
| `levels` | `tolerance: 0.5 x ATR`, same prominence | **Trap: the default is 0.** With 0 the clusters chain into one blob. |
| `volume_profile` | `bins: 40`, `valueAreaPct: 0.7` | **Trap: it is a fraction, not a percent.** 70 is not 70 percent. |
| `regime` | `period: 14`, `lookback: 252` | percentile of ATR against its own year |
| `range` | `lookback: 60`, `maxEfficiency: 0.3` | Kaufman efficiency; below 0.25 is chop |
| `atr` | `period: 14` | the unit every distance is quoted in |

**Confirm every level at two tolerances.** Run `levels` twice in the same `chart_batch`, at
0.4 x ATR and 0.8 x ATR, and keep only clusters that survive both. A level that exists at one
tolerance and not the other is an artefact of the parameter, not a place price reacted.

Full parameter and return reference, plus what phosphor cannot measure at all, is in the
appendix below.

## Speed

Latency here is round trips, not milliseconds. Three calls answer almost every question:
`trade_batch` for the book and positioning, `chart_scan` for the three timeframes, one
`chart_batch` carrying every measurement and then the whole markup with `$ref`. An agent that
issues one call per measurement is not being thorough, it is being slow.

## The trap this skill exists to stop

**Being asked "what is the trade here" makes NO TRADE feel like a failed answer, so the evidence
bar drops until something clears it.** Phosphor makes this worse: `trendline_fit` fits a line
through any set of pivots and `levels` at a loose tolerance finds a level anywhere. The tool never
refuses. Most days have no setup, and boredom trades cost more than bad trades.

| The thought | What is actually true |
|---|---|
| "He asked for a setup, so there must be one" | He asked what is there. "Nothing" is an answer that saves money. |
| "The 4h disagrees but the 1h is clean" | You picked the timeframe that agreed. That is why the ladder is fixed. |
| "It is close enough to the level" | Quote it in ATR. Under 0.75 ATR the stop is inside noise and there is no trade. |
| "Funding is extreme, so it goes down" | Funding marks crowding, not direction. It is only actionable against a level. |
| "I will widen the tolerance and see" | You are tuning until a level appears. Two fixed tolerances, keep the survivors. |
| "The trendline fits" | It fits anything. Count the touches, and a line with two touches is a line through two points. |
| "I will give both scenarios" | A read that covers every outcome has said nothing. Pick one and price the other. |
| "It is only a 1m question, skip the higher timeframe" | GLANCE skips MTF and then *declares* it. Skipping silently is the failure. |

**Red flags. Stop and go back to step 4:**
- You know the direction before you have drawn the levels.
- The both-ways test passes with the same facts.
- You re-ran a measurement at a new setting because the first one gave nothing.
- A level exists at one tolerance only.
- You are about to write "watch for" or "keep an eye on" with no price attached.
- The verdict is not on the first line.

---

# Appendix: the measurements

## What exists, and the parameters that are traps

Everything here is reachable through one `chart_batch`. Shared defaults for every candle-loading
op: `product` = the chart's current product, `granularitySec` = 3600, `bars` = 300.

| Op | Set it to | Default | Why the default hurts |
|---|---|---|---|
| `pivots` | `window: 3`, `minProminence: 0.75 x ATR` | `2`, `0` | With prominence 0 every local wiggle is a pivot. |
| `levels` | `tolerance: 0.5 x ATR` | `0` | With tolerance 0 single-link chaining merges everything into one blob. Check `spread` on the returned cluster: a wide spread means it chained. |
| `volume_profile` | `bins: 40`, `valueAreaPct: 0.7` | `40`, `0.7` | `valueAreaPct` is a **fraction**. Passing `70` asks for 7000 percent and returns the whole range. |
| `range` | `lookback: 60`, `maxEfficiency: 0.3` | same | Kaufman efficiency. Below 0.25 with price mid-range is the chop day. |
| `regime` | `period: 14`, `lookback: 252` | same | ATR percentile against its own year. `compressed` under 0.2, `extreme` over 0.95. |
| `atr` | `period: 14` | same | The unit every distance gets quoted in. |
| `divergence` | `window: 3`, `minProminence: 0.75 x ATR` | `2`, `0` | Same pivot noise, then compounded against the oscillator. |
| `vwap` | `anchorIndex` = the bar of the event | `0` | Anchor 0 is the left edge of the window, which is meaningless. Anchor to the capitulation low, the blow-off high, the unlock, the listing. |

Returns you should read carefully:
- `levels` returns `{price, count, members, spread, tolerance}`. `count` is the number of pivots
  in the cluster, `members` their bar indices. **There is no `touches` field and no `kind`.**
- `range` returns `{start, end, low, high, bars, efficiency, positionInRange}`.
- `volume_profile` returns `{bins, poc, valueArea:{low,high}, binWidth}`. **There is no `vah`,
  `val`, `hvn` or `lvn` field.** Value area edges are `valueArea.high` and `valueArea.low`, and
  low-volume nodes have to be picked out of `bins` yourself (below about a third of the mean bin
  volume, ignoring the empty edges).
- `pivots` returns `{index, t, price, kind, prominence}`.

### The right-edge repaint

`pivots` clamps its right-hand window at the end of the series, so **the newest bar is reported
as a pivot whenever it is the highest of the last `window+1` bars, and is revoked on the next
bar.** Its prominence collapses to its own high minus low, so `minProminence` only partly filters
it. Never build a structure call on the newest pivot. Require `window` bars to the right of a
pivot before it counts as confirmed.

### Warmup nulls

Indicator series are index-aligned with the candles and lead with nulls through the warmup.
`vwap` can also return null in the middle of a series, not only at the front. Read the last
*non-null* value, never `series.at(-1)` blind.

## Missing, and worth computing yourself from `candles`

`chart_batch` has a `candles` op. When you need one of these, pull the bars and compute it. Do
not claim phosphor produced it.

**Failed breakout and reclaim.** The mastery map calls this the single highest quality pattern in
crypto, and nothing in the repo touches it. Given a level L and a side:

```
tol = 0.25 x ATR[i]
sweep at i    if  high[i] > L + tol  AND  close[i] < L      (for a high sweep)
reclaim at j  = first j in (i, i+k] with close[j] < L held for `hold` bars
penetrationAtr = (high[i] - L) / ATR[i]
volumeMult     = v[i] / sma(v,20)[i]
return barsToReclaim = j - i, as a number, not a boolean
```

Tolerance in ATR, never in ticks, or the same rule is unusable across BTC and a $0.02 alt. Run it
on the base granularity: on a folded timeframe the wick survives but the wick-then-close
*sequence* is lost inside the bucket.

**Break of structure and change of character.** Collapse consecutive same-kind pivots keeping the
extreme so the sequence alternates H, L, H, L. Trend is up while highs and lows both rise. BOS is
a close beyond the last confirmed high while trend is up. CHoCH is the first close beyond the last
confirmed pivot *against* the trend. Use close-through, not wick-through: the choice changes the
event count by about 2x.

**Prior day, week and month high and low.** Fetch a separate 1d series; do not fold the chart's
own bars. On a 1m chart the 2000-bar history ceiling covers 33 hours, so "prior week" is
unanswerable from the visible series. Months need `Date.UTC(y, m, 1)` boundaries, not modulo
arithmetic. Crypto has no session, so UTC is the only defensible boundary and the answer should
say so.

**Session opens are DST-dependent.** NY open is 13:30 or 14:30 UTC, London 07:00 or 08:00, and
they shift twice a year. Do not hardcode a UTC hour.

Also trivial to compute and genuinely useful: Fibonacci retracement and extension between two
swings, fair value gaps (a three-bar imbalance where bar 1's high is below bar 3's low), Keltner
channels and the Bollinger squeeze, ADX for the trend-versus-range switch, realised volatility,
and low-volume nodes out of the profile bins.

**Supertrend: skip it or fix the warmup.** It is stateful and path-dependent all the way back to
the first bar, so two calls with different `bars` can disagree about the current trend. Every
other indicator here is a pure function of the last N bars. This one is not.

## Impossible from OHLCV, and the proxies that lie

**True CVD.** Cumulative volume delta needs the aggressor side of every print. OHLCV does not
carry it and cannot imply it. The standard proxy is:

```
delta = v * (2c - h - l) / (h - l)
```

By construction that has the sign of `(2c - h - l)`, so it is a restatement of price action, not
of flow. **It can never show the one thing CVD is used for**: price making a higher high while
delta makes a lower high. The proxy fails precisely in the case that carries the edge. Never
present this under the name CVD. OBV is the same class of proxy with a cruder weight and is at
least honest about being volume signed by close direction.

Hyperliquid's websocket `trades` channel does carry a side per print and phosphor already runs a
WS client, so a **forward-only** CVD from now is buildable. There is no public historical trades
endpoint, so historical CVD is not recoverable at all.

Also impossible from bars alone: delta by price and footprint charts, absorption (heavy volume
with no price move is only visible with the tape), anything derived from the order book, and the
CME gap, which needs a CME futures series phosphor does not carry.

Derivatives data is **not** impossible: funding, open interest, premium and the mark-oracle gap
all come back from `trade_batch` on the Hyperliquid venue. See `context.md` for what else is
reachable without a key.

