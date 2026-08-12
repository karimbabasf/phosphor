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
- Canvas candlesticks, green up and red down, tick-only axes, asset selectable, stale marker
- Charts come from Hyperliquid, because that is the venue the execution targets. Timeframes down to
  1s. Chart sits top left; the wallet sits under it
- Chart handles like TradingView: drag the plot to pan through history, drag the right axis to
  compress or expand the price scale, drag the bottom axis to compress or expand the time scale,
  wheel to zoom time, double click either axis to reset it. No indicators, no drawing tools, no
  crosshair
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
