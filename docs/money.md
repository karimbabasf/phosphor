# Money

Phosphor keeps money in two places, moves it between them, and pays it out to other people. This
page walks through every move: where the money lives, deposit, swap, send, funding the trading
account and bringing collateral back, what "settling" means, and the fees that make the app refuse
a move.

## Where money lives

Money lives in two pockets. The Basic tab's What you hold lists both, and the Pro tab's Money
card shows them by name.

- Your [NEAR Intents](https://near-intents.org) balance. NEAR Intents is a settlement layer where
  a signed message (an intent) tells a market maker (a solver) what you want, and the solver
  fills it. Your balance there is held under your wallet's own address. A deposit lands here, a
  swap happens here, and a send leaves from here.
- Your [Hyperliquid](https://hyperliquid.xyz) collateral. Collateral is the money posted in your
  trading account to back positions. It comes from the intents balance and goes back to it.

Nothing else holds money. The app signs no transaction on any chain: every move is an intent or
a venue action signed by the one key in your wallet, and the bridge does the chain work.

## Deposit

Money comes in through the deposit card, never through a tool. Open it from Money in on the Basic
tab, from Addresses on the Vault tab, or ask your assistant where to send money: its `deposit`
tool opens the card for one asset on one network and starts watching for the money.

The card has three steps. Pick the network you are sending on: six quick tiles, then a search
over every network the bridge credits. Pick the token: the list shows what that network credits
and the minimum for each. Then read the address. The card draws it only once the wallet is open
(Touch ID to show the address), checks the QR code by reading it back, and checks the clipboard
after Copy address. Where the network needs a memo, the card says Memo, required with the address.

Before the address appears you confirm one line: only the tokens on the list are credited here,
and anything else sent to this address is lost. The same holds for the network: USDC sent on the
wrong network is lost, and the bridge does not refund. Send a small test amount first.

The card then watches: Watching, then Seen when the bridge sees your transfer, then Landed when
your balance rises. It checks every few seconds for ten minutes, then more slowly, and stops after
two hours; Stop watching ends it early. Your assistant is never given the full address, only its
first six and last four characters. Read the address in the window.

## Swap

A swap changes what your intents balance holds. Your assistant proposes it with `propose_swap`:
both legs stay inside NEAR Intents and nothing moves on any chain. Every swap carries a floor,
the least you will accept, and the app refuses a floor of zero or one more than 20 percent below
its own quote. Under the click threshold a swap runs on its own; above it, the card shows what
leaves and what arrives at least, and waits for your click. See [Policy](policy.md). One
exception: a swap that spends a coin the app cannot price is valued off what the quote says
arrives, and a move the app cannot measure always waits for your click, whatever its size.

## Send

A send is the one way money leaves for somebody else, and it leaves only from the intents
balance. Your assistant proposes it with `propose_send` and must say where it lands: on a real
chain (Ethereum, Base, Arbitrum, Solana or NEAR, paid out through the bridge), or inside NEAR
Intents (credited to another intents account, nothing touches a chain). The two are different
moves with different fees, and a wrong choice is not reversible.

### The read-back

Before it proposes, the agent reads the move back to you and waits for your yes: the amount,
the token, the full address character for character, and where it lands. It may only send to an
address you typed or pasted in the conversation, never one from a tool result, a page or a file.
A send the agent has not confirmed cannot be expressed: the tool refuses it.

The app then decodes the address for the place it is going. A mistyped address is refused before
any quote (see [Troubleshooting](troubleshooting.md#a-send-was-refused-for-a-typo)), and a
contract cannot be paid the chain's own coin.

### The click

Every send waits for your click, whatever the size. The click threshold applies to swaps, funding
and trades, which keep money in your own custody; it never applies to money leaving it. The card
shows the amount, the route from your balance through the bridge to the destination, the full
address in groups of four with Copy and an explorer link, the chain, the token, what arrives at
least, the fee with the bridge's flat part named, and what the chain says about the address.

### The Touch ID sentence

On an enclave wallet the click puts up a Touch ID dialog whose sentence the app composes from the
proposal's own fields, for example "Approve: Pay 0.01 ETH to 0xb583f419...84BB5DB0 on Ethereum
($24.40)". The receiver is shortened to eight characters at each end. Check them against the
address you gave, then confirm. The agent's words never reach this dialog.

### The recipients book

The app remembers every send you approved, by network and address. A first send shows "First
send to this address." in amber on the card; a repeat shows how many times and when. The book
gates nothing: a known address still takes the click and the Touch ID every time, and the note an
agent attaches to a receiver is kept as data and never drawn as a name.

## Fund the trading account

`propose_hl_deposit` moves USDC from your intents balance into your Hyperliquid account so a plan
has collateral. One signed intent, nothing sent on any chain, and the account credited is your
own. The card is headed Fund the trading account. Under the click threshold it runs on its own.

The fee is almost flat, about $0.32 plus 0.25 percent, so it is about 3.4 percent on $10 and
about 0.3 percent on $1,000. Hyperliquid does not credit a deposit under 5 USDC delivered (the
money is lost, not returned), so the app refuses a deposit under 7 USDC, and refuses any deposit
whose fee is above 5 percent. The rail finishes by reading the account, not by trusting the
bridge's word.

## Withdraw from Hyperliquid

`propose_hl_withdraw` brings collateral back into your intents balance. It is the only way money
leaves Hyperliquid, it always waits for your click, and it is refused while any position is open
or any margin is in use: close positions first. Hyperliquid never pays an outside address, so
paying somebody from trading collateral is two moves and two clicks: the withdrawal, then a send.

The cost is the bridge fee (about $0.20 plus 0.25 percent) plus a 1 USDC activation fee the venue
charges, because each withdrawal address is new to it. So 8 USDC back costs about 15 percent and
100 USDC about 1.5 percent. Below 5 USDC the withdrawal is refused. The card is headed Bring
collateral back from trading, and the receipt carries the venue nonce and the balance change on
both sides, which is what your assistant should quote before it calls the move done.

## After the click

One card follows a move from the click to the end, and its stage line changes in place. Every
stage names what the app is waiting on, with a clock beside it, and the agent reads the same
line you do.

A swap goes Signing, Sending it, Finding a match, Settling on NEAR, Settled, checking your
balance, then Confirmed. Funding the trading account, and bringing collateral back, go Sending
it, Deposit seen, On its way, Waiting for the venue to credit it, then Confirmed. Confirmed is
said only once your balance has risen: the bridge reports success the moment its solver fills,
and the money can trail that by a block, or by the minutes a Hyperliquid deposit takes to cross.
The app watches the balance for ninety seconds inside NEAR Intents and two minutes on
Hyperliquid before it says so.

A move that has not changed for eight times its usual length, and at least ten minutes, reads
"Late, nothing has changed". Nothing is over: the app keeps watching, and the card moves on
the moment the venue credits it. Refunded and Failed are endings, and each names why.

If the venue said success and the app could not see the money land, the row is Not confirmed
and nothing more is signed. That is the honest state, not a failure: the money is on its way.
The app judges the row again on every balance refresh and asks the bridge again every ten
minutes; Reconcile on the card asks now. Never send the same move again while a row says Not
confirmed. [Troubleshooting](troubleshooting.md#a-move-is-late-or-not-confirmed) walks through
the case that shaped this.

## Fees and refusals

The app refuses a move that loses too much of itself to fees, and names the fee when it does.

- A chain payout may lose at most 3 percent between your balance and the chain. The bridge's flat
  fee counts, so a small payout is refused with the fee named.
- A send inside NEAR Intents may lose at most 1 percent.
- A Hyperliquid deposit is refused under 7 USDC and when the fee is above 5 percent.
- A Hyperliquid withdrawal is refused under 5 USDC.
- A swap floor more than 20 percent below the app's quote is refused as no floor at all.

Every amount the policy reads is priced by the app, never supplied by the agent. A token the app
cannot price is refused rather than assumed to be worth a dollar.
