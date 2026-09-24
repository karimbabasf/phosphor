# Trading

The Trade tab is the [Hyperliquid](https://hyperliquid.xyz) perpetuals surface: the chart, your
positions, your orders and your plans. A perpetual is a futures contract with no expiry date, so
you can hold a long or a short for as long as your collateral lasts. This page explains what a
proposed trade is, when it needs your click, what an armed plan may do on its own, and what stops
when the wallet locks.

## Trade mode

Switch to the Trade tab in the top bar, or tell your assistant "switch to trading". Everything
about Hyperliquid lives here, and it is the one tab with a chart. The market line above the
chart shows the coin with its logo, the price, the day's change, and the day's high and low;
click the coin to pick another market. The chart is shared: your assistant can draw levels, lines
and zones on it, and everything it draws is marked as the agent's. The timeframes and the Add
indicator field shape the chart, and the Layout menu in the top bar hides or shows panes.

Markings, studies and layouts are kept per market, across a quit, until you or your assistant
clear them. A stop or a liquidation level always has its own label on the price axis.

The panel under the chart has three tabs, Positions, Orders and History, each with its count,
and what the trading account holds (Trading money and Free) at the right. Positions shows each
open position as a small card: its size, its profit, and its entry, mark, liquidation, stop and
target. Orders lists every plan that is drawn or armed. History is the last 24 hours of fills and
ended plans, newest first; Show more adds older ones, and a fill opens its receipt. Before
anything can trade, the account needs collateral, see [Money](money.md#fund-the-trading-account).

Every position opens isolated. Isolated margin means the collateral posted for one position is
the most the venue can take for it; a loss on one plan cannot drain the whole account.

## A proposed trade

A trade is one plan, whole. It has a symbol, a side (long or short), a size in dollars, the
multiple (the venue calls it leverage, from 1 up to the coin's maximum), an entry, a stop, an
optional target, optional conditions, an expiry and a note.

- The entry is market, limit or stop. "Buy when it comes down to X" is a limit entry and "buy
  when it breaks X" is a stop entry; the venue holds both.
- The stop is required and must sit on the losing side of the entry and the current price.
- Conditions are things the venue cannot hold: a bar close above or below a level, a reclaim
  wick, a volume multiple, a time window. Up to six, and all must hold before anything fires.
- The expiry defaults to 24 hours and can be at most seven days ahead.

Your assistant can draw the plan first with `trade_plan`. That is an idea: it appears under
Orders marked Idea, nothing is placed, and no policy is consulted. It can redraw or remove an idea
freely. "Go" arms the plan exactly as it is on screen.

## The click

Arming is a proposal, `propose_trade`, and the policy engine judges it like any other move. What
the policy sees is the collateral at stake: the margin the position posts, or the loss at the
stop if that is larger. Under the click threshold the plan arms at once. Above it the card in the
chat shows Collateral at stake (isolated, at the multiple), Max loss at the stop, If the stop
slips 10%, Entry, Stop, Target, Liquidation near and Expires. Its Details hold the plan in
English, with its conditions and the totals across every live plan. Then Cancel or Approve. See
[Policy](policy.md#the-click-threshold).

The app refuses a plan by name when the stop is on the wrong side, when the stop sits past the
liquidation price, when the size is under $11 (the venue's floor is $10 after rounding to its
lot, and rounding only makes a size smaller), when the margin
is more than the account has free, when the multiple is above the coin's maximum or differs from
another plan on the same coin, or when a plan matching one already armed exists.

The entry, the stop and the target go to the venue as one bracket, so the venue holds the exits
and the app can die with the position still protected. A limit or stop entry rests on the venue
and its exits are placed the moment anything fills. A plan with conditions waits with nothing at
risk until they hold.

## Armed rules

An armed plan is the app watching the market for you. Under Orders it says Watching while it
watches its conditions and Placed once the venue holds the entry. When the entry fills, the
position shows under Positions, and when the plan ends it moves to History with the reason:
Stopped, Hit target, Closed, Cancelled, Expired, or Failed with the reason.

Changes to an armed plan go through `propose_trade_change`, one change per call. A new stop or
target that tightens the plan (a max loss at or under the one you approved) lands without a
click. One that widens it is priced like a new plan. Cancel works on a waiting or placed plan;
an open plan is closed, not cancelled, because its exits are its protection. A close never takes
more than its own plan, and a plan that ends cancels whatever is left of its entry.

The window has two buttons of its own: Cancel on a plan under Orders, and Close on a position
Phosphor opened. Each turns its card into a question that says what will happen in figures,
answered in place, with no agent involved. A position opened somewhere else has no Close here.

To watch the market between your unlocks, an armed plan holds a session key. This is a separate
Hyperliquid API wallet the app keeps for trading: by the venue's own signing split it can place
and cancel orders, and it cannot withdraw, cannot transfer, and cannot approve another agent. The
session lasts as long as the plan's expiry, and never more than 24 hours. When it runs out, a
waiting plan shows Needs unlock and re-arms on your next unlock; a placed plan renews its session,
because a fill needs the key to be protected; an open plan needs no key at all.

## After the wallet locks

The lock wipes the wallet key from memory, so nothing can be signed with it: no swap, no send, no
funding, no withdrawal, and no new plan can arm. A plan that was already armed keeps its session
key until that session ends, so a bot that outlives a lock holds trading authority, not custody.
It can place the entry it was armed for and its exits; it cannot move money out.

A plan whose session has ended while the wallet is locked waits as Needs unlock and re-arms when
you unlock. If the prices behind the watcher stop coming in, the plan says Waiting for prices and
nothing fires until they are back.

Freeze everything in the top bar ends all of it: every plan is finished, resting orders are
cancelled, and every open position on the account is closed at the market price when the venue
can be reached. A position that does not close keeps its stop and target resting.
See [Getting started](getting-started.md#freeze-everything).

## Reading the account

Ask your assistant for the whole situation and it reads `trade_read`: account health, every open
position with its distance to liquidation, working orders including stops and targets, recent
fills, and every plan with its state. Liquidation distance comes in three units, because "twelve
percent" sounds far and is not on a coin that moves eight percent a day; the multiple of the
average true range is the number that means something. An unknown value is reported as unknown,
never as zero.

On a unified Hyperliquid account the venue reports an account value that is not the account's
money, so the health figures derived from it come back empty on purpose. A wrong risk number is
worse than a missing one.
