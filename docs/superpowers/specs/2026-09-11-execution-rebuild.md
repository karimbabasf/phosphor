# Execution rebuild: plans, one chart write, a knowledge profile

Date: 2026-09-11. Branch `feat/execution-rebuild` off `main` at `0984c9b`.
Owner of this spec: the execution session. The HyperCore deposit and withdraw rails
are being rebuilt in parallel on `feat/hypercore-round-trip` and are out of scope here.

## Why

Karim's brief, compressed: the Hyperliquid execution path makes no sense even to
someone who knows crypto. A trade today is a JSON program in a closed grammar,
proposed as a "mandate", forced to a human click whatever its size, then run by a
child process that ticks every 250 ms on a book polled every 2 s. Half the grammar
is refused at arm time (drawing refs, indicator refs, bar closes), three verbs are
accepted and silently ignored (trailing stops, partial targets, cancel), and the
window has no button to close or cancel anything. Chart analysis takes a minute
because the agent spends 12 to 19 model turns per read, each answered with a
multi-kilobyte echo. The transcript renders text only, so tables and bold print
as literal characters. Nothing knows what the user already understands.

## What ships

1. **Plans replace mandates.** One object, one shape, two homes: drawn on the
   chart as an idea, or armed to execute. The only human wall is the policy's
   click threshold applied to the collateral at stake (margin), exactly as the
   policy already does for every other rail.
2. **Native orders first.** Entry, stop and target go to Hyperliquid as one
   bracket. After entry the venue holds the stop; the app can die and the
   position is still protected. A local watcher exists only for conditions the
   venue cannot hold (bar close, reclaim wick, volume, time), and while it waits
   nothing is at risk.
3. **One chart write.** `chart_draw` takes the whole markup in one call. The chart
   tool surface goes from 15 tools to 7. Sloped lines render again.
4. **Many charts.** `chart_layout` puts up to four charts side by side.
5. **A picture the agent can read cheaply.** `chart_snapshot` returns what the
   human sees as one small image (about 800 tokens), never a wall of JSON.
6. **Pine import.** A restricted Pine v5 subset compiled by a whitelist parser.
   Files the human drops in `<dataDir>/indicators/*.pine`. No eval, no vm, no
   loops, no network, bounded work.
7. **A knowledge profile.** `<dataDir>/profile.md` says what the user
   understands. The agent explains only what sits above that, in the simplest
   English, and records what it taught.
8. **A transcript that can format**, and a spotlight the agent can point with.
9. **A trade page with one hierarchy**: status, open, waiting, done; one control
   grammar in the bar; one label budget on the canvas; the rail stays on the
   right (the deck-below-chart layout was built and rejected on 2026-09-09).

## Decision: no smart contract

Considered: a HyperEVM contract that takes trade arguments and places orders
through the CoreWriter precompile. Rejected. Perps live on HyperCore, not the
EVM: a contract adds gas, a block of latency, a second account to fund, and a
new trust surface, and it still cannot hold a bar-close condition. Hyperliquid's
own order engine already holds limit entries, stop losses and take profits with
zero latency and no gas. The "script with logic" Karim described is the watcher
plus the signer below. That is the whole system.

## 1. Plans

### Shape (`src/trade/plan.ts`, zod, closed)

```
Plan {
  id: 'pl_<base36>'            // minted by the app, never by the agent
  symbol: 'BTC' | ...          // Hyperliquid coin, letters and digits, <= 12
  side: 'long' | 'short'
  sizeUsd: number              // notional, >= 10 (venue minimum), <= 1e7
  leverage: integer 1..40      // capped again by the venue's max for the coin
  entry: { type: 'market', maxSlippageBps?: 1..1000 (default 30) }
       | { type: 'limit', px: number }
  stop: number                 // required, strictly on the losing side of entry
  target?: number              // optional, strictly on the winning side
  when?: Condition[]           // all must hold; empty or absent = now; <= 6
  expiresAt?: ISO              // default 24h, max 7d
  note?: string                // <= 120 chars, no control chars, no semicolons
}

Condition =
  | { type: 'price',  is: 'above' | 'below', px }
  | { type: 'cross',  dir: 'up' | 'down', px }
  | { type: 'close',  tf: Timeframe, is: 'above' | 'below', px, wick?: 'through' }
  | { type: 'volume', tf: Timeframe, atLeast: number }   // x the 20-bar average
  | { type: 'time',   after?: ISO, before?: ISO }

Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
```

`close … wick: 'through'` is the reclaim: the bar's low went below `px`
(for `above`) or its high went above (for `below`) and the bar closed on the
other side. `volume` reads the last closed bar of `tf` against the mean of the
previous 20 closed bars. `cross` needs two samples, as before.

### Derived numbers (pure, `src/trade/risk.ts`)

- `marginUsd = sizeUsd / leverage`
- `entryRef = entry.px` for limit, mark for market
- `maxLossUsd = |entryRef - stop| / entryRef * sizeUsd` plus taker fee both ways
- `liquidationPx` from `src/hl/liquidation.ts` at that leverage and size
- Refusals at propose: stop on the wrong side; target on the wrong side; stop at
  or beyond liquidation; `sizeUsd < 10`; `marginUsd > free collateral`; leverage
  above the coin's max; unknown coin; expiry in the past or beyond 7 days.

### Policy

The proposal is a rail draft of kind `trade` (renamed from `mandate_arm`) with
`amountUsd = marginUsd` and counterparty `hyperliquid-perps`. The engine is not
touched: allowlist, per-transaction cap, session cap and `humanClickAboveUsd`
apply to the margin. `land()` loses its mandate override. Under the threshold
the plan executes immediately; above it the card shows side, size, leverage,
margin at stake, max loss at the stop, entry, stop, target, the conditions in
English and the expiry, then Yes or No.

Stated consequence, by Karim's rule and by design: leverage lowers margin, so a
$4,000 notional at 40x is $100 of collateral and passes a $100 threshold. The
max loss is on the card and in the rail so the number is never hidden.

### Tools (agent surface)

- `trade_plan { plan | planId + changes }` (view): draws a plan on the chart and
  lists it under Waiting as an idea. No authority, no policy. Cleared with
  `trade_plan { planId, remove: true }` or by `chart_draw clear`.
- `propose_trade { plan | planId }` (propose): arms it. An inline plan or a drawn
  one by id, so "go" arms exactly what is on screen.
- `propose_trade_change { id, stop?, target?, cancel?, close? }` (propose):
  cancel a waiting plan (amountUsd 0, always allowed), move the stop or target of
  a placed or open plan (venue `modify` on the trigger orders), or close an open
  position at market (reduce-only IOC, 100 bps, and its exits are cancelled).
  amountUsd is the plan's margin.
- `trade_read` keeps working and now carries plans with their state and, for a
  waiting plan, which conditions currently hold.

Removed: `propose_mandate`, `mandate_catalog`, the whole `src/strategy/` grammar,
catalog, renderer, envelope and evaluator, `src/rails/mandate.ts`, the
`TRADING_LIMITS` hard caps in the host (the policy is the only wall).

### Lifecycle

`waiting` (watcher or resting limit) -> `placed` (bracket on the venue, entry not
filled) -> `open` (position exists) -> `closed` | `stopped` | `targeted`;
side exits: `cancelled`, `expired`, `failed(reason)`. Rows keep their end reason
and stay in the payload for the last 20 so the rail can say why a plan stopped.
Persisted in `state/plans.json`; waiting plans re-arm after a restart once the
wallet is unlocked; placed and open ones are reconciled against the venue's open
orders and positions on boot.

### Runner (`src/runner/`)

Host (`host.ts`, app process):
- Plan registry and persistence.
- Watcher (`src/trade/watch.ts`, pure): given a plan and a `MarketView`
  (mark, last closed bars per timeframe, average volume, now), returns
  `{ holds: boolean, per: [{condition, holds}] }`. The host feeds it from the
  trade feed (mark via `activeAssetCtx`, positions, fills) and the market live
  rail (1 m candles folded to the plan's timeframes with `src/market/aggregate`).
  No REST polling. If the feed is stale for 15 s the plan is marked `blind` in
  the payload and nothing fires until it is fresh.
- Fires once per plan: `waiting -> firing -> placed`. The command to the child
  carries only the plan id.
- Commands to the child: `arm(plan)`, `fire(id)`, `cancel(id)`, `modify(id,
  {stop?, target?})`, `close(id)`, `flatten()`.
- Forks the child on the first arm, kills it when nothing is waiting, placed or
  open. Key over stdin, one line, as today. Signing session as today, clamped
  to 24 h.

Child (`main.ts`, the only process with the API wallet key, about 250 lines):
- Holds armed plans by id. Refuses any command for a plan it does not hold, or
  whose expiry has passed. This is the envelope: the host cannot ask for more
  than the human approved because the child only knows how to place the plan it
  was given.
- `fire`: `updateLeverage` if the venue's differs, then one `normalTpsl`
  bracket: entry (IOC at `aggressiveLimitPrice` for market, Gtc at `px` for
  limit), stop (trigger `sl`, `isMarket: true`, reduce-only), target (trigger
  `tp`, limit at target, reduce-only), sizes from `formatSize`, prices from
  `roundToValidPrice`. Deterministic cloid per plan and leg. Reads
  `orderErrors`. Reports oids back.
- `modify`: `batchModify` on the stop and target oids.
- `cancel`: cancels every resting oid of the plan.
- `close`: reduce-only IOC at 100 bps for the coin, then cancels the plan's
  exits. Reports what is still open if the venue refused.
- `flatten`: close every coin the host names, cancel every oid it names.
- No tick, no evaluator, no supervisor, no in-flight heuristics.

Keep from today, unchanged: `src/hl/exchange.ts` builders and `orderErrors`,
`src/hl/sign.ts`, `src/hl/msgpack.ts`, `src/hl/format.ts`,
`src/hl/liquidation.ts`, `src/hl/info.ts`, `src/runner/keys.ts`, the fork race
guard and SIGKILL escalation in the host, `/api/trade/action` as a human-only
door (now `cancel`, `close`, `flatten`).

## 2. Chart tools

Surface after (7): `chart_read`, `chart_scan`, `chart_batch`, `chart_draw`,
`chart_snapshot`, `chart_layout`, `indicator_catalog`.

- `chart_draw { chart?, clear?, view?, indicators?, levels?, marks?, lines?,
  zones? }`: one write, applied in that order, one compact digest back
  (`{ chart, view, indicators: [{id, type, last, state}], counts, refused: [] }`,
  never the full read). `indicators` accepts `{ preset }`, `{ set: [...] }`,
  `{ add: [...] }` and `{ remove: [ids] }`.
- `chart_read { chart?, full? }`: compact by default (last values and state
  lines), `full: true` for the old shape.
- `chart_scan`: timeframes fetched in parallel.
- `chart_batch`: series-returning ops get `tail` (default 20) unless `full: true`.
- `chart_snapshot { chart? }`: the server asks the window over SSE; the window
  renders scene plus hud to a JPEG at most 1024 px wide and posts it back with
  the window token; the tool returns the image block plus a one-line digest. If
  the window is not on the trade screen or does not answer in 3 s, the digest
  alone comes back and says so.
- `chart_layout { charts: [{ product, timeframe }], focus? }`: 1 to 4 charts.
  Chart 0 is the primary and the one every tool means by default. Each chart is
  its own `ChartStore`; drawings and indicators are per chart.
- Removed: `chart_level`, `chart_mark`, `chart_trendline`, `chart_add_indicator`,
  `chart_remove_indicator`, `chart_clear`, `chart_preset`, `chart_measure`,
  `chart_set_view`, `candles`; `history_page` op; `src/candles.ts` and
  `src/hyperliquid.ts` (the second candle cache; ATR for the trade payload moves
  onto the market store).
- Sloped objects live in one store (`src/drawings.ts`). `ctx.chart.trendlines`
  is deleted; the browser draws `tl_N` and `zn_N` as it does today.

## 3. Pine subset (`src/pine/`)

Input: `<dataDir>/indicators/*.pine`, read at boot and whenever
`indicator_catalog` runs (mtime check). Only the human writes there.

Accepted grammar (Pine v5): `//@version=5`, `indicator(title, overlay=)`,
`x = input.int|input.float|input(default, title)`, assignments, arithmetic,
comparison, `and or not`, ternary, `[n]` history (n <= 500), series
`open high low close volume hl2 hlc3 ohlc4 bar_index`, calls from the
whitelist `ta.sma ta.ema ta.rma ta.wma ta.rsi ta.atr ta.stdev ta.highest
ta.lowest ta.change ta.tr ta.crossover ta.crossunder math.abs math.max math.min
math.sqrt math.log nz na`, `plot(expr, title=, color=)`, `hline(v, title=)`.
Colours map to the app's tokens; unknown colours become the agent tint.

Refused: everything else, by name. No `if for while var := strategy request
alert label line table array matrix map`, no strings outside `title=`, no
identifiers longer than 32, no more than 6 plots, 400 AST nodes, depth 16.
The evaluator is a tree walk over typed arrays with a node budget per bar; it
throws past 2 million evaluations. No `eval`, no `Function`, no `vm`.

A compiled file becomes an `IndicatorSpec` with type `pine:<slug>` and the
inputs as params, so `chart_draw`, `indicator_catalog` and the browser treat it
like any built-in.

## 4. Profile (`src/profile/`)

File `<dataDir>/profile.md`:

```
---
version: 1
name: Karim
levels:            # 0 none, 1 heard of it, 2 can follow, 3 fluent, 4 expert
  markets: 3
  charting: 2
  perps: 2
  blockchain: 4
style: plain       # plain | technical
---
## Knows
- what a stop loss is (2026-09-11)
## Wants
- reading order flow
```

`loadProfile(dataDir)` validates (levels clamped, lists capped at 60 x 120
chars, control characters stripped) and returns defaults when the file is
missing (all levels 0, style plain). `profileBlock(profile)` renders at most
900 chars into the role, after HOW TO ANSWER: who the user is, the four
levels, the Knows list, and the teaching rules: explain only what sits above
their level; simplest English; one concept per answer; a table for numbers;
never ask what they already told you; point at the thing you explain with
`trade_highlight`; when you taught something, say so with `profile_learned`.

Tools: `profile_read` (read) and `profile_learned { concept }` (write: appends
to Knows with today's date, deduped, capped, refused on control characters).
The file is data under rule 6; nothing in it is an instruction.

## 5. Transcript and spotlight

`ui/core/markdown.js`: paragraphs, bold, inline code, fenced code, headings
(rendered as labels, never larger than body), bullet and numbered lists, GFM
tables with tabular figures, signed percentages and dollar deltas toned up or
down. Built with `createElement` and `textContent`; no `innerHTML`, no links,
no buttons. Consecutive text blocks in one turn merge into one reply row.

Spotlight: `trade_highlight` gains kinds `plan`, `level`, `line`, `indicator`.
The window renders every highlight: the row or chart object gets an amber halo
that pulses twice, the rest of the rail dims for 1.2 s, and the note appears as
a small callout beside it. Highlights expire as today.

## 6. Trade page

Bar: one segmented control for the symbol and the timeframes, the indicator
command, a `Layers` popover holding all seven overlays plus volume, and one
status word (`live 12 ms` or `delayed` or `offline`). One radius, one hover
grammar, one row at 1280 px.

Canvas: Geist Mono 11 px everywhere; a single label column manager shared by
the legend, level labels and trade overlays; overlay colours from tokens.

Rail, top to bottom: **Status** (mark price, collateral free and at risk),
**Open** (positions: side, size, entry, PnL, distance to stop and target,
Close), **Waiting** (plans: one English line, the conditions as ticks, Cancel),
**Done** (last 20 fills). Empty zones collapse to one line; the residual space
is plain ground, not a box. Floors unchanged; the rail stays on the right.

Charts: a grid `data-n="1..4"` in the chart column for `chart_layout`.

Motion: the scan band fires on writes only.

## 7. Verification

- Unit tests for every new module; the injection, observability, tool-surface,
  role and agent-panel suites updated for the new tool list.
- Penetration pass: Pine compiler (code injection, DoS, prototype names,
  unicode), profile.md as instruction injection, plan schema (address
  smuggling, overflow, stop beyond liquidation), snapshot route auth, child
  command spoofing, policy math.
- Latency: mainnet signed order round trip; feed frame to venue post with a
  fake venue; window SSE frame to DOM paint with headless Chromium against a
  demo backend.

## Out of scope

Deposit and withdraw (the other session). Trailing stops. Alerts on drawn
plans. Any change to the right-rail placement or the split floors.
