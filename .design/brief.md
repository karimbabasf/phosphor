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

- v0.3: the page has two modes, switchable ONLY by the connected agent through the set_view_mode MCP tool. data-view on #page selects which renders. pro is everything above, unchanged
- Karim 2026-08-12: "basic has to be super super simple, like as if it is made for a senior to be able to look at this and understand what exactly this is". One balance, one question, two buttons, nothing else competing
- basic type is large: base around 21px, balance 64px at rest, buttons at least 56px tall, readable from normal sitting distance without leaning in
- basic keeps the identity (phosphor green on near-black, same monospace, one hue) but drops the box-drawing frames and all panel chrome. Frames are pro's language, not basic's
- basic is plain English throughout: no chain names as jargon, no contract address without a plain-words label, no bare symbols
- basic may scroll vertically. Single narrow column, max 640px, centred. The "no page scrolling" rule above applies to pro only
- basic keeps red reserved for the safety gate: the warning line, a destination that is not the user's own wallet, and the stop confirmation. Nothing else
- STOP EVERYTHING sits last in basic, visually separated from YES and NO, and takes two presses
- basic must never state a balance it cannot back, shorten an address, or omit a destination the approval rests on
- BASIC, NO TERMINAL VIBE. The basic screen shares no visual identity with pro: not the
  monospace, not the green, not the black ground. Pro keeps all of it. Karim, 2026-08-12:
  "no terminal vibe or anything".
- BASIC, A PRICE TRACKER RATHER THAN A CHART. One coin, its price, and whether it is up or
  down today. "just with a simple price tracker of a coin instead of the chart".
- BASIC, THE WALLET SHOWS. What they own, listed by thing owned rather than by chain.
  "wallet showing".
- BASIC, A LOG OF HEADLINES. One short sentence per finished action and a clock time.
  No developer message text, no tool calls. "super simpel log, just headlines I guess".
- BASIC, NO EXTRA INFO. Anything the app says about itself while nothing is wrong comes off
  the screen. "just super basic without any extra info".
- BASIC MAY SCROLL, and the no-scrolling rule above is pro's alone. Compressing basic to fit
  one screen is what produced the terminal density that was rejected.
- Karim 2026-08-12: "make a loading animation for anything that is loading or not showing yet and especially if like candlesticks havent loaded in". Every panel that has no answer yet says so while it waits, the chart most of all, and every one of them stops the moment its own answer lands
- Karim 2026-08-12: "on the x axis the controls for squeezing are reversed and I want to be able to squeeze as much as I want". Dragging the time axis follows the hand, and the window squeezes until the renderer runs out, not until a round number does
- Karim 2026-08-12: "I want this tiny timer to not look like a price tag". The bar countdown under the last-price tag reads as a duration, not as a second label in the price column
- Karim 2026-08-13: "the actual list should only show us tokens we are holding. clearly". An empty token is not a row. How many were empty is still stated, and a place whose read failed gets a line of its own rather than leaving with the zeroes
- Karim 2026-08-13: "the donut thing should have a little more diverse color scheme". Rank-coloured from a fixed palette, largest slice keeping the app's own green, with a chip per table row as the key to it. This lifts the one-hue rule for the ring only
- Karim 2026-08-13: "the actual non rounded number to the hundreth and maybe the total value in eth with the ether logo next to it". The donut's centre reads the exact total to the cent and the same total in ETH beside the Ethereum mark, drawn on the canvas
- Karim 2026-08-13: "we also need a transaction history tab that allows us to simply view actual transactions. like swaps, deposits, transfers. clickable from and too addresses that take us to the exploreers. gas, value... interacctvi e". A TRANSACTIONS tab in the wallet panel: time, action, movement, value, from, to, gas, tx, every address and hash a link to the explorer that owns it, filters, and rows that expand in place. No modal and no route
- Nothing on the surface may state a number it cannot back. A fee not yet read, a hash no reachable chain knows, and a move that burned no gas at all are three different words, never a blank or a zero
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
collapsed, basic resting, basic asking, basic frozen, waiting, squeezed,
basic resting (redesign), basic asking (redesign), basic gate disabled (redesign),
basic empty wallet, basic at 390

## Added 2026-08-12: BASIC view (v0.3)

The page now has two modes, switchable ONLY by the connected agent through the `set_view_mode`
MCP tool. `data-view` on `#page` selects which one renders.

  once" DO NOT apply to it. Karim, 2026-08-12: "basic has to be super super simple, like as if it
  is made for a senior to be able to look at this and understand what exactly this is".

What basic is judged on:
  who is not leaning into the monitor has to be able to read it from normal sitting distance.
  no ASCII rules, no panel chrome. The frames are pro's language, not basic's.
  plain-words label, no symbols standing alone.
  own wallet, and the stop confirmation. Nothing else may use it.

What basic must never do: state a balance it cannot back, shorten an address, or omit a
destination the approval rests on.

## Added 2026-08-12 (second pass): BASIC redesigned

The first basic screen kept pro's monospace-green identity and was rejected for it. Karim,
verbatim: "all I wanted was a super simple interface, no terminal vibe or anything, just with
a simple price tracker of a coin instead of the chart, wallet showing, just super basic
without any extra info. super simpel log, just headlines I guess".

What that means, as requirements this page is judged against:
- NO TERMINAL VIBE. Basic shares no visual identity with pro: not the monospace, not the green,
  not the black ground. Pro keeps all of it. This is the whole point of the pass.
- A PRICE TRACKER, NOT A CHART. One coin, its price, and whether it is up or down. The
  candlestick chart is pro's answer to a question this reader did not ask.
- THE WALLET SHOWS. What they own, by thing owned rather than by chain.
- A LOG OF HEADLINES. One short sentence per finished action and nothing else. No developer
  message text, no tool calls, no timestamps beyond a clock time.
- NO EXTRA INFO. Anything the app says about itself while nothing is wrong comes off the screen.
  "spread across 4 places, all normal" is the app talking about itself and is now silent unless
  a chain actually failed.

What basic still must never do, unchanged and not negotiable against "simple": state a balance
it cannot back, shorten an address, or omit a destination the approval rests on. Simple means
fewer words, never fewer facts about where the money goes. The approval question is therefore
allowed to be the one dense thing on the page.

Scrolling: basic MAY scroll. The no-scrolling rule at the top of this file is pro's, and it is
what forced the first version to compress into a terminal in the first place.

## Added 2026-08-12 (third pass): BASIC goes dark and stops scrolling

Karim, verbatim: "inside phosphor basic mode, can you make it a dark color scheme please, and
make it all fit on one screen like pro mode".

Two lines above are reversed by this, and only these two:
- **Dark, not light.** The second pass shipped warm paper because a dark screen full of numbers
  was what read as somebody else's software. The ground is now a warm near-black at hue 68 with
  the same ink ramp turned over. Every earlier line asking for a light ground no longer applies.
- **Basic no longer scrolls.** "basic MAY scroll" and "compressing basic to fit one screen is
  what produced the terminal density that was rejected" are both superseded. Basic is a
  non-scrolling deck like pro: two columns, and a list that outgrows its box scrolls inside
  itself. It falls back to the single scrolling column under 1000px wide or 640px tall.

What did NOT change, and is what "like pro mode" does not mean:
- NO TERMINAL VIBE still holds and is still the whole point of the second pass. Dark means a warm
  brown-grey near-black, never pro's #0b0d0b with phosphor green on it. Basic keeps Amulya, the
  round geometry, the calm bar, and one state-driven signal colour. It takes pro's LAYOUT rule,
  not pro's identity.
- Type stays large enough to read from normal sitting distance. Fitting one screen is done with
  two columns and internal scrolling, never by shrinking the balance to a terminal figure.
- Every contrast pair is measured against the new ground, not eyeballed: body ink 15.9:1,
  secondary 9.1:1, the faint tier 5.5:1, and the red 5.6:1 on the ground and 4.9:1 on its own
  washed field.
- What basic must never do is unchanged: state a balance it cannot back, shorten an address, or
  omit a destination the approval rests on. The left column scrolls as a column rather than the
  question box scrolling inside itself, so YES and NO always sit below the facts they rest on.

States to check on this pass: basic resting (dark), basic asking (dark), basic at 1440x900,
basic at 390.

## Added 2026-08-13 (fourth pass): the wallet gets a history, and the donut gets colour

Karim, verbatim: "fix the 'wallet tab. The donut thing should have a little more diverse color
scheme and the actual list should only show us tokens we are holding. clearly. the policy look
sgood for now and Ilike the log too but we also need a transaction history tab that allows us to
simply view actual transactions. like swaps, deposits, transfers. clickable from and too
addresses that take us to the exploreers. gas, value. IA mean everythign you wwould expect to see
in a top of the level wallets transaction shistory tab. interacctvi e". Then: "i also want the
number inside of the donut to not just be a boring numebr, but like the actual non rounded number
to the hundreth and maybe the total value in eth with the ether logo next to it".

PRO ONLY. Basic is untouched by this pass: it is written for someone who does not want a
transaction history, and nothing here appears on that screen.

Three lines above are reversed by this, and only these three:
- **The donut is no longer one hue.** "one hue" and the rank-brightness ramp are superseded for
  the ring only. It now carries a fixed palette of CRT phosphor colours, biggest slice first, and
  the biggest slice keeps the app's own green. Everything ELSE on the pro screen is still one
  hue: the rule is lifted for the chart that needed categorical colour, nowhere else.
- **The wallet table has a colour chip per row.** It is the key to the ring, which is what makes
  a multi-colour donut readable without a legend.
- **"No click behaviour" in the wallet region is superseded.** Hover still links the ring and the
  table both ways. What is new is a tab strip over the same panel and a history whose rows expand.

Asked for, on top of what already stands:
- The wallet list shows only what is actually held. An empty token is not a row. How many were
  empty is still stated, because a short list and a shallow read are different facts. A place
  whose read failed gets a line of its own rather than disappearing with the zeroes.
- The donut's centre reads the exact total to the cent, never rounded, with the same total in ETH
  under it beside the Ethereum mark. The mark is drawn on the canvas: this page loads no images.
- A TRANSACTIONS tab beside HOLDINGS in the same panel, listing what this app actually did:
  swaps, deposits, withdrawals, transfers. Time, action, movement, value, from, to, gas, tx.
- Every address and every transaction hash is a link to the explorer that owns it. An intent hash
  is not a chain transaction and gets no link, because no explorer resolves one.
- Gas is the real receipt figure (gas used, gas price, fee in ETH and in USD), read back off the
  chain. Not yet read, could not be read, and none was burned are three different words on the
  surface, never a blank.
- Interactive means three things and no more: the filters narrow the list, a row expands in place
  to its full detail, and links go out. No modal, no route: the one-page rule still stands.

States to check on this pass: pro holdings (donut with colour, chips, empty count), pro
transactions (rows, one expanded, a failed row), pro at 1440x900, pro stacked under 1100px.
