# The yield surface an agent holds, and where the gas went

Design doc and build contract. 2026-08-20.

Two changes on one branch, because they share a tree and nothing else:

1. **The agent door opens onto the yield feature.** `feat/stablecoin-lp` shipped automated
   stablecoin yield with no agent tools, deliberately: section 4 of
   `2026-08-20-stablecoin-yield.md` says the tool goes on "in a separate change once the
   evidence in section 5 exists". Section 5 now exists, on Arbitrum Sepolia, with hashes.
   This is that change.
2. **A GAS button on the deck bar**, next to LOG, POLICY and HISTORY. Every money movement
   this app makes burns gas somewhere, the per-transaction figure is already recorded, and
   nothing adds it up. What was spent, on what kind of action, on which chain.

---

## Part 1: the yield tools

### 1.1 The four tools

    yield_read               read-only. positions, ledger, venue rates, what the loop decided
    propose_yield_deposit    supply a stablecoin to the best venue it can reach
    propose_yield_withdraw   take it back, all of it or part
    yield_auto               start or stop the allocator loop

Registered in `src/mcp.ts` and added to `tests/tool-surface.ts`, which is the one list both
`tests/injection.test.ts` and `scripts/e2e.ts` assert the door against.

### 1.2 Why these earn the door, stated against the repo's own bar

The rule in `tests/tool-surface.ts` is explicit: a fund-moving rail reaches the agent surface
after it has run on a live chain, not before. `propose_lp_add`, `propose_lp_remove` and, until
2026-08-20, `propose_hl_deposit` are off the door for failing it.

`yield_deposit` and `yield_withdraw` pass it, and the evidence is section 5 of the yield spec:
five real movements on Arbitrum Sepolia on 2026-08-20, three by hand, two by the loop, every
one of them through the real proposal service and the real policy engine, ending in a full exit
that returned 56.292312 USDC to the wallet. The realized percentage the app derived (4.2672%)
and the rate the reserve reports (4.2687% APR) were arrived at independently and agree.

The second half of the old refusal was about the wallet read after `lp_add` serving pre-trade
balances. It does not apply here: this rail's position is read by one `balanceOf` on a rebasing
receipt token, and `buildWallet` already takes the yield holdings so the total includes them.

### 1.3 `yield_auto`, and why the agent is allowed to start a loop

This is the call worth arguing, because it looks like standing authority and the repo reserves
standing authority for `propose_mandate`, which never auto-approves on any network.

It is not the same thing. What the allocator can do is file a `yield_deposit` proposal. That is
a capability the agent already holds outright, one tool up this list. Every proposal the loop
files goes through the identical policy engine, the identical click threshold, the identical
session spend cap and the identical audit log. Starting the loop grants no authority over money
that the agent did not already have; it grants a schedule.

What it does add is time: the loop keeps looking after the agent has disconnected. Three limits
already in `src/yield/allocator.ts` bound that, and they were written before this change:
`PROPOSE_COOLDOWN_MS` is fifteen minutes whatever the tick rate, consecutive failures back off
by doubling to a four hour ceiling, and the policy engine's own 24-hour session cap sits under
all of it. A human has the same switch in the window and the kill switch above it.

Compare `propose_mandate`, which is genuinely different: an armed bot sends orders to a venue
directly, at machine speed, with no proposal per order and no gate in the loop. That is why it
is gated and this is not.

`yield_auto` moves no money itself, gets no policy verdict, and is written to the audit log,
which puts it in the same class as `switch` and `watch`. Its description says so.

### 1.4 Exact tool shapes

**`yield_read`** takes no arguments. Proxies `{ op: 'read', tool: 'yield_read' }`.

Returns the `YieldView` from `Allocator.view()` plus the venue table, unchanged, with one
addition the agent needs and the window does not: `caveat`, the `OBSERVATION_CAVEAT` string
from `src/yield/positions.ts`, so an agent quoting the percentage out loud carries the same
sentence the screen does.

When no allocator is configured, return `{ available: false, reason: <one sentence> }` rather
than an empty view. An empty view reads as "you have no position", which is a different claim
from "this app is not wired for this".

**`propose_yield_deposit`** proxies `{ op: 'propose', kind: 'yield_deposit', ... }`.

    chain    optional, z.enum(['eth','base','arb']).  Omit and the app picks the best-paying
             venue that is healthy and reachable, which is what the loop does.
    symbol   optional string, defaults USDC
    amount   number, the token amount, not USD

No address, ever. The destination is the venue's Pool contract, resolved from the verified
table in `src/yield/aave.ts`, which is already on the counterparty allowlist via
`aaveCounterparties()`.

**`propose_yield_withdraw`** proxies `{ op: 'propose', kind: 'yield_withdraw', ... }`.

    chain    optional. Omit and the app uses the chain the position is on; refuse with the
             list when positions sit on more than one.
    symbol   optional string, defaults USDC
    amount   optional number. OMIT IT to take the whole position out, interest included.

The description must say plainly that omitting `amount` is the correct way to close a position,
and that a number computed a block ago leaves dust behind on a rebasing receipt. That comment
is already in `src/types.ts` on `YieldWithdrawParams` and the agent cannot read comments.

**`yield_auto`** proxies `{ op: 'yield_auto', enabled: boolean }`.

    enabled  boolean, required. No default: a switch whose default is one of its two states
             is a switch that gets flipped by an agent that meant to read it.

Returns the new state and the loop's next look time.

### 1.5 What is NOT on the door

No venue argument. One venue is wired (`aave-v3`) and naming it in a signature would make the
second one a breaking change to the surface rather than an entry in a table.

No `yield_tick`. Forcing a look is a debugging affordance, and the loop already looks every
sixty seconds.

No allocator configuration. Tick rate, dust floor, cooldown and rebalance horizon are
constants with reasons written next to them in `src/yield/allocator.ts`. An agent that can
set the dust floor to zero can drain a wallet in approval clicks.

---

## Part 2: the GAS button

### 2.1 What it answers

One question in three parts: what has this app spent on gas, which kinds of action spent it,
and on which chain. A donut for each of the last two, a total above them, and the honest
remainder underneath.

### 2.2 The data already exists

`src/transactions.ts` derives every movement from `proposals.json` plus `audit.jsonl` and
enriches each EVM hash with a receipt. `TxGas` carries `gasUsed`, `gasPriceWei`, `feeNative`,
`feeSymbol`, `feeUsd`, `status` and `place`, and `place` is the chain whose RPC actually
returned the receipt, so it is the authority on where the gas was burned, over any guess made
from the draft. `TxEntry` carries `action`, `kind`, `venue`, `valueUsd` and `status`.

So the report is an aggregation, not a new read. **No new RPC calls, no new store, no new
cache.** The same derivation the HISTORY overlay already runs, grouped.

### 2.3 The four honest remainders

An aggregate that silently drops what it cannot count reports a smaller number than the truth
and calls it the truth. Four categories are counted separately and printed:

- **pending**: the receipt is still being read. Not zero gas. `gasPending` is true.
- **unknown**: no chain this app can reach has this hash. Not zero gas either.
- **intent-settled**: signed, not broadcast, settled by a solver. This burned no gas of ours,
  which is a fact, not a gap. `TxHash.kind === 'intent'`.
- **unpriced**: a receipt with `feeUsd === null`, so the gas is known in native units and no
  price was available. Its `gasUsed` counts, its dollars do not.

And one that is not a remainder but a callout: **reverted**. `status === 'reverted'` burned
real gas and moved nothing. It gets its own line, in red, because it is the only number here
that is pure loss.

### 2.4 The module contract

New file `src/gas/report.ts`. Pure: it takes `TxEntry[]` and returns a report. No I/O, no
config reads, no clock except the one passed in. That is what makes it testable against
fixtures and what keeps it out of the request path's error budget.

```ts
export type GasWindow = '24h' | '7d' | '30d' | 'all';

export type GasSlice = {
  key: string;          // stable grouping key: 'swap', 'arb', 'yield_deposit', 'aave-v3'
  label: string;        // what the legend prints
  feeUsd: number;       // summed, priced receipts only
  feeNative: number;    // summed; meaningful only when `symbol` is non-null
  symbol: string | null;// the native symbol, null when the slice spans chains with different ones
  gasUsed: string;      // summed gas units, decimal string: base units never become floats
  txCount: number;      // receipts that burned gas
  moveCount: number;    // distinct TxEntry rows contributing
  share: number;        // 0..1 of totalUsd; 0 when totalUsd is 0
};

export type GasReport = {
  window: GasWindow;
  fromTs: string | null;      // null for 'all'
  toTs: string;
  totalUsd: number;
  totalGasUsed: string;
  txCount: number;            // receipts that burned gas
  moveCount: number;          // movements that burned gas
  byAction: GasSlice[];       // TxEntry.action: swap, deposit, withdraw, transfer, ...
  byChain: GasSlice[];        // TxGas.place: eth, base, arb
  byKind: GasSlice[];         // WriteDraft kind: yield_deposit vs intents_deposit vs hl_deposit
  byVenue: GasSlice[];        // TxEntry.venue, with 'none' for a move that named no venue
  reverted: { feeUsd: number; txCount: number };
  unpriced: { txCount: number; gasUsed: string };
  pending: { moveCount: number };
  unknown: { moveCount: number };
  intentOnly: { moveCount: number };   // moves whose every hash was an intent
  movedUsd: number;           // summed TxEntry.valueUsd over executed moves in the window
  gasBps: number | null;      // totalUsd / movedUsd * 10000, null when movedUsd is 0
  venueFeeUsd: number;        // summed TxEntry.venueFeeUsd: NOT gas, shown beside it
};

export function buildGasReport(args: {
  entries: TxEntry[];
  window: GasWindow;
  nowMs: number;
}): GasReport;
```

Rules the aggregation keeps, each with a test:

- **Slices are sorted by `feeUsd` descending**, and a slice with zero dollars but non-zero
  `gasUsed` still appears, last. It spent gas; only its price is missing.
- **`byAction` and `byKind` group the MOVE, `byChain` groups the RECEIPT.** One movement can
  burn gas on more than one chain, since a cross-chain rail records origin and destination
  hashes, so `sum(byChain.feeUsd)` equals `totalUsd` while `sum(byAction.moveCount)` may
  exceed `moveCount`. Assert the first; the second is documented, not enforced.
- **`gasUsed` stays a decimal string end to end.** Gas units on a busy chain exceed 2^53 when
  summed over a long history. `BigInt` inside, string at the edge, exactly as the rails do.
- **Only `status === 'executed'` or `'executing'` moves count toward `movedUsd`.** A failed
  move still burned gas (counted) and moved nothing (not counted). That asymmetry is the
  point of `gasBps`.
- **The window filters on `TxEntry.ts`,** the settle time, not on block time. It is the
  timestamp every other surface in this app orders by.

### 2.5 The endpoint

`GET /api/gas?window=24h` returns a `GasReport`. Same session-token guard, same origin check,
same shape as `/api/transactions`. It reuses whatever `/api/transactions` already does to get
`TxEntry[]`, including the gas cache, so opening GAS after HISTORY costs nothing.

`{ op: 'read', tool: 'gas_report', args: { window } }` on `/api/mcp` returns the same object.

### 2.6 The MCP tool

    gas_report    read-only. What this app has spent on gas, by action and by chain.

    window   optional, z.enum(['24h','7d','30d','all']), defaults '7d'

Added to `tests/tool-surface.ts`. A read that moves nothing and reaches no rail.

The description has to state the remainders, because an agent that reports "$1.42 spent on gas"
while four transactions are still being read has told its human a wrong number confidently.

### 2.7 The window

A `[ GAS ]` button on the deck bar in `ui/index.html` and `ui/trade.html`, fourth after LOG,
POLICY and HISTORY, opening the same `PhosphorOverlay` those three use. Rendered by a new
`gas` view in `ui/deck-views.js`, so the pro deck and the trading deck cannot drift, which is
the reason that file exists.

**The donut is a canvas.** Every other drawn thing in this app is a canvas (`ui/chart.js`,
`ui/agent-globe.js`) and `ui/deck-views.js` has a hard rule that it assigns no markup at all,
ever, as a security property. A canvas assigns none: it draws pixels and carries an
`aria-label` plus a DOM table beside it that holds the same numbers as text. The table is the
accessible view and the authority; the donut is the shape of it.

Drawing rules, from the law at the top of `ui/style.css`:

- No gradients, no shadows, no border radius on any box. The donut is an arc, which is a
  shape, not a rounded rectangle.
- Slice colours come from the existing CSS custom properties, read off the computed style at
  draw time so a theme change is not a second palette to maintain. Never hardcoded hex.
- A slice under 2 percent gets no label on the ring; it is in the table. A ring crowded with
  overlapping text is less legible than a ring with none.
- The centre of the ring holds the total, which is the number a person came for.
- One donut for actions, one for chains, side by side, each with its own legend table.

Under them: the window selector (24h / 7d / 30d / all), the reverted line when it is non-zero,
and the remainder lines when they are non-zero. A remainder that is zero prints nothing:
"0 pending" is chrome.

### 2.8 Motion

The ring sweeps in once on open, over roughly 300ms, ease-out, and never again. Slices do not
animate on data change; the overlay is opened, read and closed. `prefers-reduced-motion`
draws the final state directly. This matches `ui/transition.js`'s existing behaviour of
respecting that query.

---

## 3. What proves this, and what it found

Not "the tests pass". Recorded as it happened on 2026-08-20.

**The door opens onto all five tools.** `npm run e2e` boots a real app, attaches a real MCP
client over stdio and asserts the tool list against `tests/tool-surface.ts`:

    [PASS] MCP surface is exactly the 45 expected tools
           ... gas_report ... propose_yield_deposit, propose_yield_withdraw ...
           yield_auto, yield_read
    PHOSPHOR E2E: 35 checks, 35 passed, 0 failed

`tests/injection.test.ts` walks every schema property and confirms none of the five takes an
address, and cross-checks the five against the `start` capability index, so a tool registered
and never indexed cannot exist.

**The gas report agrees with the receipts it is made of.** Run against the real proposal store
holding the five yield movements, with every figure re-derived by hand off the raw receipts
rather than through the module under test:

    total matches a hand sum of the raw receipts   report=0.075423555 hand=0.075423555
    byChain sums to the total                      [["arb", 0.07542356]]
    every action slice matches the hand sum        deposit 0.0459, withdraw 0.0184, swap 0.0112
    gasUsed round-trips as a decimal string        1612494

`byKind` separates `yield_deposit` from `yield_withdraw` where `byAction` folds both into the
verbs a reader uses, which is the reason both groupings exist. `gasBps` came out at 2.92: the
whole feature cost under three basis points of the $258.61 it moved.

**The window shows the same numbers.** The GAS overlay opened on both decks against that store,
and every cell in its tables equals the endpoint's field. Zero console errors, and with every
remainder at zero the panel printed no remainder lines at all, which is the "0 pending is
chrome" rule working rather than a gap.

### Three defects this pass found, all of them older than it

The first two came from running `scripts/e2e.ts`, which boots in demo mode on a throwaway data
dir. That combination is what made them visible, and neither was reachable from the tests.

**Demo mode was running the allocator against a real chain.** `main.ts` built it
unconditionally, so a demo install called `balanceOf` with the real signing key's address and
drew a real lending position on top of a fixture wallet. The rail registry already states the
rule this broke: demo mode holds no rails, "which is better than a rail reaching for an RPC and
a private key that the demo user never meant to involve."

**A balance with no deposit behind it reported as pure profit.** The cost basis is derived from
this app's executed proposals, so on a fresh data dir `principalFrom([])` correctly returns
zero, and `balance - 0` then reported all 56.29 USDC of a live position as interest earned. Zero
is not a synonym for unknown. `basisFrom()` now returns them apart, every derived figure goes
null together, and three tests hold the three states apart: no history, some history, and a
history that says the position is closed. This one mattered most because `yield_read` is on the
agent door now: an agent would have said "you have earned $56.29" out loud to a human.

**Every yield movement in the history was recorded as happening on Ethereum.** `shapeOf` in
`src/transactions.ts` had no case for the two yield kinds, so both fell through to a `default`
that returns place `eth` with no venue, no amount and no counterparty. The gas column beside it
was right the whole time, because `TxGas.place` is the chain whose RPC answered and overrides
the draft's guess, so the money column and the fee column on one row disagreed about which
chain it was. Found by noticing `byVenue` reported `none` for a rail whose draft names
`aave-v3`.
