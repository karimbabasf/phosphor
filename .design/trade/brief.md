# UI brief: the phosphor trading surface

What was asked for, verbatim. The page at `/trade` is judged against this file. The pro page at
`/` has its own brief at `.design/brief.md` and nothing here governs it.

Karim, 2026-08-12: "whatever you have built right now is perfect. but it has to be packaged into
a different interface. meaning the main pro interface we have right now is the main interface
for swapping lp providing and all that stuff. This trading with hyperliquid should introduce a
trading interface. research what a professional trading interface needs and make it in the most
professional manner. of course this has to keep the same design as the main pro page... Also of
course everything has to be able to be manipulated and easily usable by the agent."

`/` is a custody screen: what you hold, and what governs it. `/trade` is a position screen: what
you are exposed to, and what happens if price moves against it. Neither borrows the other's
furniture, and each is still one page that never scrolls.

## Asked for
- A separate interface from the pro page, at its own route, leaving `/` untouched
- Judged as a professional trading surface against what real perps desks carry, not against a
  retail app
- The same design language as the pro page: same tokens, same panel frame, same terminal
  density, no new hue, no radius, no shadow, no transition
- Everything on it readable and manipulable by the agent over MCP, not only by the human
- Components must not collide or conflict, at any width
- Manual controls for cancel, close and flatten, reachable from the page
- Positions and working orders drawn on the chart itself
- Liquidation distance shown in ATR multiples as well as percent and dollars, because percent
  alone does not answer whether a distance is far
- Profit split into price, funding and fees, since a carry trade green on price can be red once
  it has paid for itself
- Net and gross exposure with a plain sentence for a five percent adverse move, because cross
  margin makes every position a term in every other position's liquidation price
- Mark and oracle shown separately with the basis between them, as they are different prices
  with different jobs
- The arm receipt: the account's next state if the program opens its maximum position
- Feed health beside the price, so a screen behind the market says so where price is read
- `null` renders as a dash and never as zero, because the venue reports an account value of 0.0
  on a funded unified account
- Every dynamic string reaches the DOM through textContent, never innerHTML
- Digits that tick must not change width
- The kill switch reachable within two tab stops from a cold load, in every state
- No order ticket: where other interfaces put buy and sell, this puts the mandate console, and
  every manual control on the page stops something
- Working orders rendered as child rows of the position they belong to, not a table of their own

## The one idea
A position on borrowed size has two prices that end it: the liquidation the venue draws, and the
mandate stop-out the human approved. No other trading interface can draw the second, because in
no other interface does it exist. The page draws both and asserts no ordering between them:
corrected 2026-08-13 after live numbers put a stop-out at $1,133 against a liquidation at
$1,422, since the two are computed against different quantities.

## Colour law, one extension only
Red reaches the liquidation surface: the liquidation line, its band, and a liquidation fill.
Being taken by the venue is the same class of event as a refused write. The mandate wall is
bright phosphor and never red, because painting the guard rail the colour of the cliff stops a
person reading either.

## Who is looking
Karim, trading one Hyperliquid perpetuals account with borrowed size, with an AI agent connected
to it. He knows what a liquidation and a funding rate are. Desktop, 1440x900 and wider, with a
stacked fallback that must stay readable rather than pretty.

## Goal behind the ask
Someone who has left a bot running can answer three questions at a glance and without
arithmetic: how far am I from being liquidated, how much of what I approved has been spent, and
is this screen still telling me the truth.

## States that must work
flat, armed, position open, nothing armed, unified account, kill switch on, stacked
