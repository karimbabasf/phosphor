# Trading

The Trade tab is the [Hyperliquid](https://hyperliquid.xyz) perpetuals surface: the chart, your
positions, your orders and your plans. A perpetual is a futures contract with no expiry date, so
you can hold a long or a short for as long as your collateral lasts. This page explains what a
proposed trade is, when it needs your click, what an armed plan may do on its own, and what stops
when the wallet locks.

## Trade mode

Switch to the Trade tab in the top bar, or tell your assistant "switch to trading". The strip
above the chart shows the market, the venue, the mark price and the day's change. The chart is
shared: your assistant can draw levels, lines and zones on it, and everything it draws is marked
as the agent's. Which market picks the coin, Timeframe and Add indicator shape the chart, and the
Layout menu in the top bar hides or shows panes.

The deck under the chart has three panels: Open, Waiting and Done. Open is every position, with
how far it sits from liquidation. Waiting is every plan that is drawn or armed. Done is the tape:
fills and ended plans, newest first. Before anything can trade, the account needs collateral: the
deck says "No trading money yet. Ask your assistant to fund it." See [Money](money.md#fund-the-trading-account).

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
Waiting with the pill Idea, nothing is placed, and no policy is consulted. It can redraw or remove
an idea freely. "Go" arms the plan exactly as it is on screen.

## The click

Arming is a proposal, `propose_trade`, and the policy engine judges it like any other move. What
the policy sees is the collateral at stake: the margin the position posts, or the loss at the
stop if that is larger. Under the click threshold the plan arms at once. Above it the card shows
the side, the size, the multiple, Collateral at stake, Max loss at the stop, what happens if the
stop slips 10 percent, Entry, Stop, Target, the conditions in English, Expires, and the totals
across every live plan. Then Yes or No. See [Policy](policy.md#the-click-threshold).

The app refuses a plan by name when the stop is on the wrong side, when the stop sits past the
liquidation price, when the size is under $10 after rounding to the venue's lot, when the margin
is more than the account has free, when the multiple is above the coin's maximum or differs from
another plan on the same coin, or when a plan matching one already armed exists.

The entry, the stop and the target go to the venue as one bracket, so the venue holds the exits
and the app can die with the position still protected. A limit or stop entry rests on the venue
and its exits are placed the moment anything fills. A plan with conditions waits with nothing at
risk until they hold.

## Armed rules

An armed plan is the app watching the market for you. Its pill under Waiting says Armed while it
watches its conditions and Placed once the venue holds the entry. When the entry fills, the plan
moves to Open, and when it ends it moves to Done with the reason: Stopped, Hit target, Cancelled,
Expired, or Failed with a sentence.

Changes to an armed plan go through `propose_trade_change`, one change per call. A new stop or
target that tightens the plan (a max loss at or under the one you approved) lands without a
click. One that widens it is priced like a new plan. Cancel works on a waiting or placed plan;
an open plan is closed, not cancelled, because its exits are its protection. The window has the
same buttons: Cancel on a waiting or placed plan, Close on an open one.

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
you unlock. If the price feed behind the watcher goes stale, the pill says Feed stale and nothing
fires until it is fresh again.

Freeze everything in the top bar ends all of it: every armed plan is finished, every resting
order is cancelled, and the positions those plans opened are closed when the venue can be reached.
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
