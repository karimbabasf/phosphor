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
    src/yield/positions.ts   the position store: principal, cost basis, credit ledger
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

### 3.2 The position store, and the one number that matters

`state/yield.json`, append-mostly, written through the same store discipline as `proposals.json`.

    type YieldPosition = {
      id: string;
      venue: 'aave-v3';
      chain: ChainId;
      symbol: string;              // 'USDC'
      aToken: string;
      principalBase: string;       // base units, as a decimal string; never a JS number
      openedAt: string;
      credits: YieldCredit[];      // the ledger Aqua puts before the number
      closedAt?: string;
    }

    type YieldCredit = {
      at: string;
      kind: 'deposit' | 'withdraw' | 'accrual';
      amountBase: string;          // signed for deposit/withdraw, positive for accrual
      txid?: string;               // deposits and withdraws carry a hash; accruals do not
      note: string;
    }

`principalBase` is the cost basis: it goes up on a deposit, down on a withdraw, and is never
touched by accrual. Earned is then

    earnedBase = aTokenBalanceNow - principalBase

read live from the chain at render time, never accumulated in the file. A number stored in a file
can drift from the chain; a number read from the chain cannot. Accrual rows are snapshots for the
ledger, written by the allocator each poll, and they are for a human's eye only. Nothing computes
from them.

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

## 5. What counts as proof

Not "the tests pass". The claim is that money moved and grew, so the evidence is transaction
hashes and two balance reads separated by time.

1. `npm test` green, including new unit tests for the adapter maths, the position store, the
   allocator's rebalance test and its testnet cross-chain refusal.
2. A real `yield_deposit` on Arbitrum Sepolia: approve tx hash, supply tx hash, both on
   sepolia.arbiscan.io, and an `aArbSepUSDC` balance that was zero before and is not after.
3. The same position read again later, showing an aToken balance strictly greater than principal,
   with both readings timestamped. This is the number the UI prints.
4. A real `yield_withdraw` returning the funds: tx hash, and a USDC balance back up.
5. A screenshot of the panel showing the dollar amount, the percentage, its window and the
   observation caveat.
