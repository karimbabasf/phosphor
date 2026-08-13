# Spec: chart v2, a trading chart an agent can drive

Date: 2026-08-12. Supersedes the chart bullets in `2026-08-11-phosphor-design.md` and the
chart lines in `.design/brief.md`.

Two asks, one build.

1. The chart must feel like a professional trading terminal: smooth panning and squeezing,
   the price readable at a glance, no lag between the hand and the pixels.
2. An agent connected over MCP must be able to read the chart, measure it, and drive it:
   view, indicators, levels, marks, several timeframes at once.

## The decision that shapes everything

**Chart state lives on the server, not in the browser.** The agent must be able to read what
the chart shows and change it while the window may not even be open. A browser-owned view
cannot answer a read. So the server holds `product, granularity, barCount, panOffset,
priceScale, indicators, levels, marks`, and the browser is a renderer that writes its own
pan and zoom back.

Consequences:
- Indicator maths runs once, on the server, in `src/indicators.ts`. The number the agent
  reads and the pixel the human sees come from the same array. A browser-side indicator
  would let those two disagree, which on a money surface is a defect, not a nuance.
- The browser POSTs its settled view (150ms after the hand stops) to `/api/chart`. Mid-drag
  reads return the last settled view. Documented, not hidden.
- Echo control: the server keeps `rev`, bumped on every change. The browser records the rev
  its own POST returned and ignores any SSE `chart` push at or below it, so an agent's change
  repaints and its own change does not fight the hand that made it.

## Rendering

Two canvases, stacked, one pointer surface:
- **scene**: volume, candles, grid, axes. Redrawn only when data or view changes.
- **hud**: crosshair, axis tags, the OHLC legend, the last-price line and tag, the countdown.
  Redrawn on pointer move and once a second.

The split is the latency answer: moving the mouse repaints an almost empty canvas instead of
500 candles. Every redraw is coalesced into one `requestAnimationFrame`, the backing store is
only reallocated when the element actually changes size, and candles draw as four batched
paths (up wicks, down wicks, up bodies, down bodies) instead of two calls per candle.

Interaction, TradingView semantics:
- plot drag pans, in fractional bars, so it tracks the pointer instead of notching
- wheel zooms about the cursor: the bar under the pointer stays under the pointer
- right axis drag scales price about the price under the pointer
- bottom axis drag squeezes or spreads bars, anchored at the newest bar
- vertical plot drag past 3px unlocks the price scale and shifts it
- double click resets the axis under the pointer, or returns to live on the plot
- arrow keys pan, `+`/`-` zoom, `0` returns to live

## Panes and the "nothing looks compressed" rule

Overlay indicators draw on the price pane. RSI, MACD, ATR, Stochastic, OBV and volume get
their own pane under it. Minimums are enforced, never squeezed:

- price pane floor 150px, sub-pane 56px to 96px, three sub-panes maximum, eight overlays
- a pane that does not fit is **refused with a reason**, and the refusal names what to remove
- panes that were dropped for space are reported in `chart_read`, so the agent is never told
  that something is on screen when it is not

## Agent surface

Reads (op `read`): `chart_read`, `chart_measure`, `chart_scan`, `indicator_catalog`.
Writes (op `view`): `chart_set_view`, `chart_add_indicator`, `chart_remove_indicator`,
`chart_level`, `chart_mark`, `chart_clear`.

`chart_read` answers everything a trader would ask: visible time range in epoch and ISO,
bar duration, seconds until this bar closes, OHLCV of the current and hovered bar, the change
and the range across the view, the price scale actually shown, the decimal precision in use,
every indicator's last values with a one-line state, the levels and marks, the pixel geometry
so the agent can tell whether its own request is readable, and the data source with staleness.

Chart writes move no money, so they do not go through the approval gate. They are still
audit-logged like every other op, because an agent that can change what the human sees while
the human approves a transfer is a security surface. Everything the agent draws carries an
`[agent]` tag in its label, and the chart bar shows a count with a one-click clear.

## Not doing

Drawing tools, trend lines, fibs, replay, multiple products on one pane, saved layouts.
The chart is a read surface for a wallet app, not a trading platform.

## Verification

- `npm test` covers indicator maths against hand-checked series and the view model against
  its own clamps
- `npm run typecheck` clean
- `node ~/.claude/tools/ui-gate.mjs http://127.0.0.1:4177 --src ui` to PASS
