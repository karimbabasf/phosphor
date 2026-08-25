# Automated stablecoin yield

Design doc. 2026-08-20.

What this adds: a stablecoin balance can be parked in a lending venue, a loop keeps it in the
best-paying venue it can reach, and the window shows what it has actually earned with a button
that takes it back out.

Everything below that says VERIFIED was checked by behaviour against a live chain on 2026-08-20,
by `.probe/probe-aave.mjs`. Nothing here was taken from a documentation page alone, because an
address that is only documented is an address that has not been checked.

---

## 1. What is being copied from Aqua, and what is not

Karim named Aqua by 1inch as the reference. Aqua is live on 13 chains and is a real product, and
it is **not a deposit-and-earn vault**. Its central design claim is that there is no deposit and
no withdrawal at all: an LP grants a revocable ERC-20 allowance, tokens never leave their wallet,
and a verified 1inch resolver pulls from the wallet at fill time. Income is market-making spread,
not interest.

So the custody model does not transfer. This app is being asked for "put money in, watch it earn,
take it out", and dressing that in Aqua's "nothing is ever deposited" language would be a lie.

Four things do transfer, and they are the parts worth having:

1. **The ledger comes before the number.** Aqua's primary earnings surface is a list of fills,
   each a row with an amount, cross-checkable on a block explorer. The percentage is derived and
   secondary. If you cannot produce the list, you do not have a yield to show.
2. **The percentage is realized, annualized, and the window is printed next to it.** Aqua's own
   wording: "an observation, not a promise", "a rear-view mirror". No projected rate is ever the
   headline.
3. **A coverage gauge instead of a liquidation.** When backing falls short the position stops
   working and says so. Nothing is seized.
4. **Risk stated against the product, not around it.** Aqua's risk page cites a paper showing
   half of Uniswap v3 positions lost more to impermanent loss than they made in fees.

Point 2 is the one that decides the feature. A percentage this app prints has to be a number it
watched happen.

---

## 2. Venue: Aave v3, and why not concentrated LP

The obvious reading of "liquidity providing" is a Uniswap position, and this repo already has a
working `lp_add` / `lp_remove` rail for exactly that. It is the wrong tool here, for three reasons
that are about provability rather than taste:

- A USDC/WETH range position's value moves with ETH. Over any window short enough to demo, the
  price term swamps the fee term, so "percent earned" would mostly be reporting the ETH move.
  1inch's own risk page cites 49.5 percent of studied v3 positions collecting less in fees than
  impermanent loss cost them.
- It is two-sided. The ask is a stablecoin feature.
- Uncollected fees have to be read out of the position manager and priced. Correct, but it is
  bookkeeping standing between the user and the number.

Aave v3 supply is single-sided, has no impermanent loss, and its receipt token is rebasing: the
aToken balance itself grows. Realized yield is `aTokenBalance - principal`, read from one
`balanceOf`. There is no accounting layer to get wrong, which is the property that makes the
number believable.

### VERIFIED deployments

Probed 2026-08-20 by calling `PoolAddressesProvider.getPool()` and matching it against the
candidate, then walking `getReservesList()` and reading `getReserveData` for the stable reserves.

**Arbitrum Sepolia (chainId 421614), the default.**

    provider   0xB25a5D144626a0D488e52AE717A051a2E9997076   6840 B
    getPool() -> 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff  MATCH
    marketId   "Aave V3 Arbitrum Sepolia Testnet Market"
    USDC       0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d    decimals 6
    aToken     0x460b97BD498E1157530AEb3086301d5225b91216    aArbSepUSDC
    supply APY 4.2687%   borrow APY 5.6232%   aToken total supply 5,496,077 USDC

The USDC address is **the same one `src/rails/uniswap-abi.ts` already lists for arb testnet**.
That is not a coincidence worth ignoring: it means the existing swap rail can produce the exact
token this rail consumes, on the chain the Hyperliquid rail already uses, so the feature adds
zero new funding steps for a human.

**Base Sepolia (chainId 84532), the second venue, which is what gives the loop a job.**

    provider   0xd449FeD49d9C443688d6816fE6872F21402e41de   6840 B
    getPool() -> 0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b  MATCH
    marketId   "Aave V3 BASE Testnet Market"
    USDC       0x036CbD53842c5426634e7929541eC2318f3dCF7e    decimals 6
    aToken     0xf53B60F4006cab2b3C4688ce41fD5362427A2A66    aBasSepUSDC
    supply APY 1.2342%   borrow APY 3.0236%

Two live venues, 4.27 percent against 1.23 percent, is a real allocation decision rather than a
staged one. The allocator has something true to be right about.

**Ethereum Sepolia was probed and is deliberately NOT wired.** Its market reports 57 percent
supply APY on USDC and 71 percent on DAI. Those are artefacts of a testnet nobody arbitrages, and
a demo whose headline number is 57 percent teaches the viewer to distrust every other number in
the window.

Mainnet Base is listed in the deployment table for completeness and is refused by the rail until
someone changes one constant, on the same principle the repo already applies to unproven rails.

---

## 3. Shape

Five pieces, each in its own module, following the rail pattern already in `src/rails/`.

    src/yield/venue.ts       the YieldVenue interface: what any venue must answer
    src/yield/aave.ts        the Aave v3 adapter, address tables VERIFIED above
    src/yield/positions.ts   the derivation: cost basis, credit ledger, the realized figure
    src/yield/allocator.ts   the loop: read rates, decide, propose through the gate
    src/rails/yield.ts       the two rails, yield_deposit and yield_withdraw

### 3.1 Two new rail kinds

`yield_deposit` and `yield_withdraw` join `RAIL_KINDS`. New kinds rather than reusing `lp_add`,
because the policy engine, the approval gate and the audit log all key on kind and a reader of
the log must be able to tell "supplied 100 USDC to Aave" from "minted a Uniswap range".

They ride the existing path with no engine changes: `proposals.ts` builds the draft and prices it,
`policy/engine.ts` sees a `RailDraft` with an `amountUsd` and a `counterparty`, and the approval
gate renders the simulation. The counterparty is the Aave Pool address, which goes on the venue
allowlist next to the Uniswap router and position manager.

`yield_withdraw` is the direction that gets the softer treatment, deliberately. Pulling money out
of a lending pool back to the wallet that owns it reduces exposure. It is allowlisted the same way
and audited the same way, but the UI gives it a button that a human can press without an agent
being involved at all.

### 3.2 There is no position store, and that is the design

The first draft of this spec had a `state/yield.json`. It is gone, and what replaced it is
better for a reason worth writing down.

This repo already derives the whole transaction history from `proposals.json` plus
`audit.jsonl` on every request (`src/transactions.ts`). Cost basis is the same kind of fact,
so it is derived the same way:

    principal = sum(executed yield_deposit) - sum(executed yield_withdraw)   from the store
    value     = aToken.balanceOf(us)                                          from the chain
    earned    = value - principal

No new file, nothing to migrate, nothing to repair. The point is not tidiness: a principal
figure kept in its own file can drift from the chain, and the one number this feature exists
to print is the difference between the two. A number that can drift from its own reference is
not evidence.

Three rules the derivation keeps, each with a test:

- **Only executed proposals count.** A pending or failed one moved no money, and counting it
  would inflate the cost basis, which shows up on screen as a SMALLER earned figure. Wrong in
  the flattering direction is still wrong.
- **The basis clamps at zero.** A full exit withdraws principal AND the interest on top of it,
  so it is larger than anything ever deposited. Without the clamp the basis goes negative and
  the next deposit reports a fortune it never made.
- **The window starts at the current run of exposure**, not at the first deposit ever. A
  position closed in June and reopened today has earned for hours, and a window measured from
  June under-reports the rate by an order of magnitude.

Base units stay strings all the way to the edge, because at 6 decimals a dollar is a million and
the repo already learned this lesson at 18 in `src/rails/uniswap.ts`.

### 3.3 The percentage, stated the way Aqua states it

    realized % (window) = earned over window / average principal over window x 365 / window days

Rendered as, for example:

    +$0.41 earned   4.21% annualised, observed over 7 days

with the window named in the label and this string under it:

    Observed, not promised. This is what it did, not what it will do.

Two rules the renderer keeps:

- A window shorter than one hour prints the dollar amount and no percentage. Annualising twelve
  minutes of interest produces a number that is arithmetically correct and rhetorically a lie.
- The dollar figure is always larger on screen than the percentage. Aqua leads each row with
  earned fees and treats the rate as secondary; the ordering is the honesty.

The venue's own current supply APY is shown too, labelled `venue rate now`, clearly separate from
the realized figure. It is what the allocator decides on, so it has to be visible; it is not what
the user earned, so it does not get to be the headline.

### 3.4 The allocator loop

`src/yield/allocator.ts`, a timer inside the app process, not a child. The mandate runner is a
child process because a perp order must not queue behind an SSE broadcast and a stop must be
absolute. Neither applies here: supply rates move on the scale of hours, and the loop's only
action is to file a proposal that something else executes.

Each tick, default 60 seconds:

1. Read the live supply rate from every wired venue, plus our own aToken balance on each.
2. Write an `accrual` credit row where a balance grew.
3. If idle stablecoin sits in the wallet above the dust floor, propose `yield_deposit` into the
   best-paying venue.
4. If a venue beats the one we are in, decide whether to move. Move only when

       spread x principal x horizon  >  gas out + gas in + bridge cost

   with `horizon` fixed at 30 days. Without this test a loop chases a 20 basis point spread with
   a two dollar gas bill and loses money while reporting that it optimised.
5. Never more than one move per `minRebalanceHours`, default 24, whatever the spread says.

The loop proposes. It never executes. Every action it takes lands in the same approval gate an
agent's proposal does, is subject to the same policy, and appears in the same audit log. That is
the whole architecture of this app and the loop does not get an exception from it.

The cross-chain move in step 4 needs a rail between chains and this app has one: NEAR Intents,
already implemented as `intents_deposit` and `intents_withdraw`. **On testnet it does not exist**
(`src/rails/index.ts` says so, and the oneclick rail is mainnet-only). So on testnet the allocator
runs same-chain only: it will report a better venue elsewhere and refuse to move, with that as the
stated reason. That refusal is correct behaviour and gets a test.

### 3.5 The window

A `panel-yield` section in `ui/index.html`, next to the wallet panel, rendered by
`ui/yield.js` from a `yield` block added to `/api/state`. Existing SSE push, existing conventions.

Per position: venue, chain, principal, current value, earned in dollars, realized percent with
its window, venue rate now, a coverage dot, and `[ WITHDRAW ]`. Under it, the credit ledger, most
recent first, with explorer links on the rows that have a txid.

`[ WITHDRAW ]` posts to `/api/yield/withdraw`, which files a `yield_withdraw` proposal exactly as
the allocator would. With the gate on it appears in the approval strip; with the gate off it
executes and the panel updates on the next push. The button is not a second path to money. It is
the same path with a human at the front of it.

The basic screen gets one sentence and no percentage: "Your $100 is earning. It has made 41
cents." `src/view/basic.ts` already holds the rule that basic may render fewer words and never
fewer facts.

---

## 4. What this deliberately does not do

- **No agent tools in this pass.** `propose_yield_deposit` is not registered in
  `tests/tool-surface.ts`. The repo's rule is that a fund-moving rail reaches the agent surface
  after it has run on a live chain, not before. This spec's job is to earn that, and the tool goes
  on in a separate change once the evidence in section 5 exists.
- **No custodial EVM wallet.** Karim floated spinning one up. The app already holds an EVM key and
  derives its own address from it, which is what lets it prove a destination is its own. A second
  wallet would add a key to protect and a reconciliation problem, and buys nothing: the position is
  already held by an address this app controls.
- **No auto-compounding step.** Aave rebases. There is nothing to claim and nothing to restake.
- **No mainnet.** The rail refuses `mainnet` until a human changes a constant.

---

## 5. What counts as proof, and what actually happened

Not "the tests pass". The claim is that money moved and grew, so the evidence is transaction
hashes and two balance reads separated by real time. Recorded here as it happened on
2026-08-20, all on Arbitrum Sepolia, all openable on sepolia.arbiscan.io.

**Funding, through this app's own swap rail.** The wallet held WETH and no useful USDC, so the
existing rail produced the token the new one consumes, which is the case
`src/rails/uniswap-abi.ts` was already arguing for when it put swap and LP on the same chain.

    0.03 WETH -> 56.174938 USDC   quote taken live, floor 48.815130
    approve   0x862edaf1467c6e608c233b9e4d47bb7ac207329e8586f421e144e682e5d2564a
    swap      0x80fb07e72153761770b00e0b90ad6cbac7605fb4dd80f07ad4b7b405a4d8fd2d

One finding worth keeping: the floor has to be sized off the TESTNET POOL, not off mainnet
spot. Arbitrum Sepolia's USDC/WETH pool prices ETH about 20 percent under the mainnet quote
because nobody arbitrages it, so a mainnet-grade slippage floor refuses every swap and reads
as a broken rail when it is a correct floor pointed at the wrong market.

**The deposit, through the real proposal service and the real policy engine.**

    yield_deposit 50 USDC, verdict allow, decidedBy policy, $50.00 against a $100 click threshold
    approve   0x8c68a76ca6faff874c1c224bf5c1466d5b224ede3aa5c14b56a05f8732fe3127
    supply    0xf4ad8744d03e2a48eb020642b3d4f51833acc326b39fbafdd314d0ac8363d426
    position after: 50.000000 aArbSepUSDC

**It grew, and the growth matches the pool's own stated rate.** Two reads, timestamped:

    18:35:27Z   50.000000 USDC   principal 50.000000   earned 0
    18:38:22Z   50.000012 USDC   principal 50.000000   earned 0.000012

12 base units in 3 minutes on $50 annualises to 4.2 percent, against the 4.2687 percent APR
the reserve reports. The number on the screen is the number the chain is paying.

**The loop ran on its own.** With `yield.autoAllocate` on, the allocator found the swap's
leftover USDC idle, filed its own proposal and it executed:

    DECISION deposited | $6.29 idle on arb, proposed into Aave v3 at 4.36%.
    proposal fe0de872, decidedBy policy

**A defect the window found, which the tests had not.** The wallet total read $294.34 while
$56.29 sat in Aave. Supplying a token removes it from the balance the chain reader sees, so
the money did not move, it vanished from the one number a person checks first. `buildWallet`
now takes the yield positions and the total is $350.61. A total that omits your money is the
same class of lie this app refuses everywhere else.

**A second defect, found by booting it.** `VenueRate.aprRay` was a `bigint`, and
`JSON.stringify` THROWS on a bigint rather than dropping the field, so one wrongly typed
lending rate returned a 500 for `/api/state` and blanked every panel in the window. It is a
string now, and a test asserts the whole rate round-trips through JSON.

**The money came back.** A partial withdrawal rather than a full exit, on purpose: it is the
path that exercises the time-weighted average principal for real, and it leaves the position
open so the window keeps running.

    yield_withdraw 10 USDC, verdict allow, decidedBy policy
    withdraw  0x0363b7e37ab10c3381c84c924c7028bda82a18642b9153aa60dcb7a4b70e5632
    "10 USDC arrived in the wallet on arb"

    before   56.292247 held   principal 56.292032   earned 215 base units
    after    46.292247 held   principal 46.292032   earned 215 base units

The earned figure is UNCHANGED across the withdrawal, which is the cost-basis arithmetic being
right: exactly what left the position also left the basis. Time-weighted average principal fell
to $55.24, not to the $46.29 standing at the end, because the money was $56 for most of the
window and $46 only for the last minute.

**Two findings from the code review, both mine, both fixed:**

- The client built explorer links from the network alone, so every ledger hash on a Base
  position linked to a transaction on Arbiscan that is not there. The prefix now travels on the
  holding, resolved server-side, because the chain is the other half of the question.
- The allocator only considered idle money on the BEST-paying chain, so $500 idle on Base would
  be left earning nothing because Arbitrum paid ten basis points more, and the loop would then
  report that nothing was idle. Depositing where the money already sits needs no bridge, so
  there was never a trade-off to make.

**And one from the security pass:** `PHOSPHOR_YIELD_AUTO` was parsed as `!== 'false'`, so `=0`,
`=off` and `=no` all switched the money-moving loop ON. For a flag whose whole design is "off
unless a human said otherwise", anything but an explicit yes has to mean no.

**The percentage appeared at one hour, and it agrees with the pool.**

    12:35:22  window 1 hour   earned $0.000271   REALIZED 4.2672% annualised
    the reserve's own stated rate at that moment:  4.2687% APR

Those two numbers were arrived at independently. One is the pool reporting what it pays; the
other is this app dividing a balance it watched grow by a cost basis it derived from its own
proposal store. They agree to three decimal places, which is the whole claim of the feature.

Below one hour the panel showed "No rate yet: 47 minutes is too short a window to annualise
honestly" for the entire preceding hour, which is the refusal working rather than a gap.

**The button closed the position, clicked in the real window.** Driven through a real page
holding the real per-boot session token, which is the same path a finger takes:

    12:37:16  yield_withdraw 54246470, verdict allow
              "withdraw all USDC from Aave v3. 56.292312 USDC arrived in the wallet on arb."

    aArbSepUSDC balance after:  0
    wallet USDC after:          56.292312
    principal ever supplied:    56.292033
    kept as interest:            0.000279

**The whole sequence, which is the feature's actual story:**

    11:35  deposit  +50.000000   by hand, through the proposal service
    11:43  deposit   +6.292032   BY THE LOOP: it found the swap's leftover USDC idle
    12:23  withdraw -10.000000   by hand, partial, to leave the window open
    12:23  deposit  +10.000001   BY THE LOOP: it found that 10 idle and put it back
    12:37  withdraw -56.292312   THE BUTTON, whole position, interest included

Two of those five were the bot acting on its own, and every one of them went through the same
policy engine, the same audit log and the same proposal store as an agent's would.
