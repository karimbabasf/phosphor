# Trading

The Trade tab is the [Hyperliquid](https://hyperliquid.xyz) perpetuals surface: the chart, your
positions, your orders and your plans. A perpetual is a futures contract with no expiry date, so
you can hold a long or a short for as long as your collateral lasts. This page explains what a
proposed trade is, when it needs your click, what an armed plan may do on its own, what stops
when the wallet locks, and what Touch ID asks for once your vault has moved to it.

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
eight hours at a time until the plan itself expires (at most seven days after it was made),
because a fill needs the key to be protected; an open plan needs no key at all.

## After the wallet locks

The lock overwrites the wallet key the app holds, so nothing can be signed with it: no swap, no
send, no funding, no withdrawal, and no new plan can arm. (Copies a signature left as text can
stay in memory until it is reused; see [Known limits](known-limits.md).) A plan that was already armed keeps its session
key until that session ends, so a bot that outlives a lock holds trading authority, not custody.
It can place the entry it was armed for and its exits; it cannot move money out.

Once your vault has moved to Touch ID, a withdrawal is the one exception: it never used the key the
lock wipes, and it asks for a Touch ID of its own whether the app is locked or not (see
[below](#the-owner-key-after-the-move-to-touch-id)).

A plan whose session has ended while the wallet is locked waits as Needs unlock and re-arms when
you unlock. Only Unlock re-arms it: showing an address, revealing the phrase or approving a move
with Touch ID does not, not even while the app is starting. If the prices behind the watcher stop coming in, the plan says Waiting for prices and
nothing fires until they are back.

Freeze everything in the top bar ends all of it: the orders your plans have resting are
cancelled, every open position on the account is closed at the market price when the venue can be
reached, and every plan whose position closed is finished. A plan whose position does not close
stays live with its stop and target resting. Orders you placed on Hyperliquid yourself are not
cancelled. Closing takes
the trading key, which a running plan holds and an open wallet hands over: with neither (the
wallet locked and no plan running, or no trading key for the account) nothing on Hyperliquid can
be closed, the freeze still stops everything else, and the window says the positions are still
open.
See [Getting started](getting-started.md#freeze-everything).

## The owner key after the move to Touch ID

Moving your vault to this Mac's Touch ID key takes the wallet's original key, the owner key, out of
memory for good. On Hyperliquid that key still owns the trading account, so each thing only it can
sign asks for a Touch ID of its own:

- sending USDC out of the account, which is what a withdrawal does;
- moving USDC between the account's spot and perp sides (a standard account only; a unified account
  has one balance);
- approving a new trading key for the account (Allow trading, [below](#the-trading-key-after-the-move-to-touch-id)).

The dialog names the action, the amount and where the money goes, for example "Send 25.00 USDC from
your Hyperliquid account to 0xaf4fda38...3184d954". The app writes that sentence from the exact
action it is about to sign, and it never asks for an action it cannot name in full. The touch opens
the owner key for that one signature, and the key is wiped as soon as the signature is made. Nothing
stays open: the next action asks again.

A withdrawal asks once. Your click on the card approves it, and the Touch ID comes when the send is
signed, after 1Click has made the address the money goes to: that is the address in the dialog. A
standard account that first has to move collateral from perp to spot asks twice, once per step, and
the card says so. If Hyperliquid does not answer a send, the app posts the same signed send again,
so one send never asks twice. Cancel the Touch ID and nothing is signed; the card says you said no.

Funding the account works like any other move from your allowance: it follows your rules, and the
owner key plays no part. On a standard account, moving what lands from spot to perp asks for a Touch
ID of its own.

One touch gives one owner action. Read the dialog before you touch it: an app that has been taken
over could ask for a touch that looks right and use the key for something else, and one touch is
then enough to move everything on Hyperliquid. Your vault is out of its reach, because after the move
this key no longer signs for the vault. Keep only your trading margin on Hyperliquid.

## The trading key after the move to Touch ID

Plans trade with a trading key: a Hyperliquid API wallet that can place and cancel orders and cannot
withdraw, transfer or approve another key. Before the move, the trading key is the one
`scripts/hl-agent.ts` wrote into your wallet file, and that does not change for a wallet that has not
moved. After the move, your wallet file takes no new key, so Phosphor makes the trading key from the
owner key instead, every time the wallet opens, beside your allowance and gas keys. It is never
written anywhere, and the lock wipes it. A key made this way reaches nothing new: the owner key
already owns the trading account.

Allow trading on Hyperliquid approves that key with one Touch ID. The dialog names the key and how
long it may trade, for example "Let 0xca9aad7b...c52f1e04 trade on your Hyperliquid account for 90
days", and the app writes that sentence from the exact approval it signs. The owner key opens for that
one signature and is wiped once it is made. Your plans trade with the new key from that moment, with
no second touch. Until you approve one, the key your wallet file already held keeps trading.

- **90 days.** Hyperliquid retires the key on its own after that. Allow trading again before then to
  renew it: the same one Touch ID, for a new key.
- **One key at a time.** The new key takes the name Phosphor's trading keys have on Hyperliquid, so
  the key it replaces stops working the same moment. A plan that holds the old key has to finish or
  be cancelled first, and the window says so.
- **Never the same key twice.** Each approval is a new key, numbered in `state/vault.json`. Hyperliquid
  forgets the history of a retired key, and approving it again would let its old orders be replayed,
  so the number only goes up. An approval that never reached Hyperliquid (a cancel, a refusal) is
  tried again with the same key, since that key never signed anything.
- **Open first.** The next key is made when the wallet opens, so a locked wallet is asked to open
  before it can allow trading. If you approved a key and want another in the same session, lock and
  open the wallet once more.
- If Hyperliquid does not answer, Phosphor reads its list of keys for your account before saying
  anything, and never signs the approval twice. If the list cannot say either, allow trading again.

The trading key is HKDF-SHA256 of the owner key's 32 bytes, salt `phosphor`, info
`phosphor/hl-agent/v<n>` for key number n, read as a secp256k1 key (redrawn under `/1`, `/2` in the
rare case it is not one). Anyone rebuilding it by hand can check against this: the public test key
`4c0883a6...f362318` gives key 1 `9bd79f61...b541cdcc`, address
`0xCa9AAd7B7e6D078718298039b40ef289C52F1E04`, and key 2 `b0193927...b30aa966`, address
`0x4b1495fD164fE42D80718ece02b34019fbc3aF0d` (the full vectors are in
`tests/fixtures/hl-agent-keys.ts`). Whoever holds the owner key, or its backup, can make this key too,
which reaches nothing the owner key does not.

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
