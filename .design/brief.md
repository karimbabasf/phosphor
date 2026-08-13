# UI brief: phosphor

What was asked for, verbatim from the spec. This page is judged against this file.

One page. No routes, no navigation, no menus, no modals except the approval gate. Everything
visible at once, on one screen, with no page scrolling at all (Karim, 2026-08-11: "move everything
around so it all fits on one page, no scrolling"). This supersedes the original "or within a single
scroll".

Deliberately plain. The interface exists to show what the backend is doing, not to impress.
Success: a person who has never seen this understands within ten seconds what they hold, what is
governing it, and whether anything is waiting for their click. The page looks like a terminal, not
like a dashboard product.

Superseded on 2026-08-11 by `docs/superpowers/specs/2026-08-11-phosphor-testnet-v2.md`:
- **The COST region is gone.** Cost is not a vital feature (spec 4). Any earlier bullet asking for
  "what it costs them" or for cost in the left column no longer applies. The freed space goes to
  the wallet.
- **The old COMPOSITION columns are gone.** ISSUER / CHAIN / SYMBOL / AMOUNT / USD / SHARE / FRZ is
  replaced by the wallet columns below (spec 3.2). ISSUER and FRZ leave the table; the policy panel
  and the red SHARE cell are where a composition breach stays visible (spec 3.4).

## Asked for
- One page, no routes, no navigation, no menus, no modals except the approval gate
- Six regions on screen together: status bar full width, then two columns. Left is what is held
  (chart, then the wallet), right is what governs it (approval gate, policy, log). Revised
  2026-08-11: the seventh region, cost, is deleted
- The page never scrolls. A region whose content outgrows its box scrolls inside itself. Falls back
  to a stacked scrolling column under 1100px wide or 620px tall
- "the composition thing should just show what a normal crypto wallet would show": the wallet owns
  the whole bottom left, columns exactly TOKEN CHAIN QTY PRICE VALUE SHARE, sorted by value
  descending, natives included, and a stale marker on any chain whose read failed
- The wallet must show liquidity pool positions on any chain: an LP row reads as one ordinary row
  with the pair as its token, for example "USDC/WETH 0.05%"
- A breach still marks the offending row's SHARE cell red, driven by the policy caps on issuer share
  and freezable share exactly as before
- An interactive donut left of the table, inside the same panel: canvas, no library, no SVG, one hue
  with brightness tiers per slice. Hovering a slice highlights it and writes that row into a readout
  line under the donut; hovering a table row highlights its slice. No click behaviour. If it cannot
  fit at 1440x900 without pushing the table under the fold, the donut is cut, not the table
- Policy and log are clearly collapsible. The control lives in the frame title in the box-drawing
  register, `[-]` expanded and `[+]` collapsed, and clicking the frame title toggles. Collapsed
  state persists per panel in localStorage. A collapsed panel releases its flex space to its
  siblings. The approval gate never collapses
- While the approval gate is disabled, a permanent unmissable line in the gate's own red
  (#ff3b30): GATE DISABLED - TESTNET - EVERY PROPOSAL AUTO-APPROVES
- System monospace stack only, no webfont
- Homebrew terminal: near-black ground, phosphor green, one hue, hierarchy by brightness/opacity only
- Red in the UI chrome is exclusively for pending approvals, refusals, breached share cells and the
  gate-disabled banner. The chart is the one exception (candle red, a darker #cc3a30), so the gate
  stays the only alarm
- No rounded corners, shadows, gradients, icons, illustration; box-drawing characters for separation
- No animation except cursor blink and appending log lines
- Canvas candlesticks, green up and red down, asset selectable, stale marker
- Charts come from Hyperliquid, because that is the venue the execution targets. Timeframes down to
  1s. Chart sits top left; the wallet sits under it

### Chart, revised 2026-08-12 (Karim: "it has to feel like I am using TradingView")

This section replaces the earlier chart handles bullet and its "no indicators, no crosshair" line.
Spec: `docs/superpowers/specs/2026-08-12-phosphor-chart-v2.md`.

- Reads as a professional trading chart, not as a sparkline in a wallet app. Price grid and time
  grid on round values and round clock times, one decimal precision everywhere on the surface,
  a legend carrying OHLC and the change for the bar under the pointer
- The price is the one thing on the chart that must be readable without looking for it: a filled
  tag on the price axis at the last close, coloured by direction, with the countdown to the bar
  closing under it, and a dashed line across the plot at that price
- A crosshair, with its price on the right axis and its time under the plot, snapped to the bar on
  x and free on y. This reverses the earlier "no crosshair"
- Handles like TradingView and at pointer latency: drag the plot to pan in fractional bars, wheel
  to zoom about the cursor so the bar under the pointer stays under it, drag the right axis to
  scale price about the price under the pointer, drag the bottom axis to squeeze or spread bars,
  drag the plot vertically to take the price scale off auto, double click to reset the axis under
  the pointer, arrow keys and +/- and 0 from the keyboard
- Indicators, on a chart that never looks compressed: overlays on the price pane, and RSI, MACD,
  ATR, Stochastic, OBV and volume in their own panes under it. Three sub-panes and eight overlays
  are the maximum, the price pane has a 150px floor, and a pane that does not fit is refused or
  dropped **with the reason said on screen**, never squeezed in
- The control surface is a command line, not a toolbar: `ema 21`, `bbands 20 2.5`, `remove rsi`,
  `clear`. The same words the agent uses over MCP
- An agent connected over MCP can read the chart, measure it, scan several timeframes, and drive
  the view, the indicators, the price levels and the time marks. Everything it draws is tagged
  `[agent]`, drawn dotted rather than solid, counted in the chart bar, and clearable in one click

### Drawn objects, added 2026-08-12
Spec: `docs/superpowers/specs/2026-08-12-phosphor-trading-design.md`.

The chart stops being a picture and becomes the shared coordinate system between the human, the
agent and the bot. The agent draws a trend line, Karim sees that exact line, and a strategy later
triggers off that same line by its id. One object, three consumers.

- Trend lines from two anchors and zones between two prices, alongside the levels and marks that
  already exist. Anchored in time and price, never in pixels, so they hold their place through a
  pan and a zoom
- A trend line extends to both plot edges rather than stopping at its anchors, because the reason
  to draw one is where it goes next. A zone is a filled band at low alpha across the full plot
- Labels sit at the right edge, where the line is heading, and carry `[agent]` when the agent drew
  them. Left-aligned labels collided with the OHLC legend, which a wide zone triggers every time
- No new hue and no new weight. An agent drawing is the same phosphor green at a lower brightness
  tier, dotted like the agent levels already are, so red stays exclusively the approval gate's and
  the gate remains the only alarm on the page
- Policy as plain sentences, never JSON
- Terminal-dense character grid, not app-airy

## Goal behind the ask
The owner sees the whole machine at once, with no scrolling: what the wallet holds, what governs
it, and whether anything is waiting for a click. On testnet with the gate off he must also be
unable to miss that nothing is waiting for a click, because everything is auto-approving.

## Who is looking
Karim, the owner of the funds, supervising what a connected AI agent is allowed to do with them.
He knows what a wallet, a chain and an LP position are, and he is suspicious of software that
claims a human approved something when no human did. Desktop, 1440x900 and wider.

## States that must work
resting, pending, refusal, kill switch on, policy unreadable, agent connected, gate disabled,
collapsed

---

# Second surface: /trade (added 2026-08-12)

The "one page, no routes" rule above still governs `/`, and it is unchanged. Karim asked for the
Hyperliquid work to be packaged as its own interface (2026-08-12: "this trading with hyperliquid
should introduce a trading interface... of course this has to keep the same design as the main pro
page"). So the app now has two surfaces, each of them still one page that never scrolls.

`/` is a custody screen: what you hold and what governs it. `/trade` is a position screen: what you
are exposed to and what happens if price moves against it. Neither borrows the other's furniture.

## Asked for
- A professional trading interface, judged against what real perps desks actually carry, not
  against a retail app
- The same design language as the pro page: same tokens, same panel frame, same terminal density,
  no new hue, no radius, no shadow, no transition
- Everything on it manipulable by the agent as well as by the human
- Components must not collide: one locked DOM contract, written before any markup existed
- Manual controls for cancel, close and flatten, and positions drawn on the chart

## The one idea it is built around
Every position on borrowed size has two prices that end it. The **liquidation**, drawn by the
venue. And the **mandate stop-out**, drawn by the human, where the loss they approved is reached
and the bot stands down. No other trading interface can draw the second, because in no other
interface does it exist: there is nothing to draw when authority was never bounded. Ours is always
nearer than the venue's. Two lines on a chart, and they are the whole architecture.

## Layout
Status bar full width, then two columns. Left is the market and what this account did in it:
CHART (grows), then BOOK, then FILLS. Right is what governs the account: RISK, MARKET, MANDATE,
then LOG (grows). Working orders are child rows of the position they belong to, never a table of
their own, because a stop at 3200 is a property of the ETH long and not an independent object.

There is deliberately **no order ticket**. Where every other trading interface puts buy and sell,
this one puts the mandate console. Every manual control on the page STOPS something.

## What it must show that retail omits
- Liquidation distance in three units at once: percent, dollars, and ATR multiples. The third is
  the only one that answers "is that far?"
- Profit split three ways: price, funding, fees. A carry trade green on price can be red once it
  has paid for itself
- Net and gross exposure, and what a five percent adverse move leaves. Cross margin makes every
  position a term in every other position's liquidation price
- Mark against oracle as a basis figure. Different prices with different jobs, and the gap is the
  one number that says the venue is under strain
- The arm receipt: the account's next state if the program opens its maximum position
- Feed health beside the price, because a screen behind the market must say so where price is read

## Colour law, one extension only
Red reaches the liquidation surface: the liquidation line, its band, and a liquidation fill. Being
taken by the venue is the same class of event as a refused write, so it wears the same colour. The
mandate wall is bright phosphor and never red, because painting the guard rail the same colour as
the cliff stops a person reading either.

## Rules with teeth
- `null` means unknown and renders as `--`. Never as 0, never blank. The venue reports an account
  value of 0.0 on a funded unified account, and a screen that prints that zero as a fact tells a
  person they hold nothing while they carry a position
- Every dynamic string reaches the DOM through textContent. Never innerHTML, anywhere
- Digits that tick must not change width: `font-variant-numeric: tabular-nums` on every number
- KILL SWITCH is reachable within two tab stops from a cold load, in every state

## States that must work
waiting for the venue, venue degraded, offline, flat, nothing armed, armed and filling, halted,
kill switch on, position near liquidation, stale account, unified account (health not computable)
