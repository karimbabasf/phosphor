# NEAR-funded perps: killing the bespoke Hyperliquid mechanism

Date: 2026-08-20
Status: spec, agreed direction, details pending the live checks marked OPEN below
Supersedes the deposit half of `2026-08-11-phosphor-testnet-v2.md`. Extends
`2026-08-12-phosphor-trading-design.md`, `2026-08-12-trading-surface-design.md` and `ux/flow.md`.

## What changed in the world

near.com shipped perps: deposit any asset from 35+ chains, 50+ markets, up to 40x. The venue
behind it is Hyperliquid, not a new NEAR-native perps DEX. The thing that is new is the RAIL,
not the exchange.

Checked live on 2026-08-20, not recalled:

- 1Click `/v0/tokens` now lists a `hypercore` blockchain with exactly one asset, USDC,
  assetId `1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f`, 6 decimals.
  Note the `1cs_v1:` prefix: this is not a `nep141:` omni-bridge asset like every other entry
  the repo pins today, so `assetIdFor` cannot find it by the existing token-registry lookup.
- `arb.USDC -> hypercore.USDC` dry quote: 201, 50.0 in, 49.6347 out, ETA 35s.
  `near.USDC -> hypercore.USDC`: 201, 49.630524 out, ETA 30s.
- `hypercore.* -> anything` is refused: 400 `"Hypercore deposits not supported yet"`.
  **The rail is one-way in.** Money cannot leave Hyperliquid through NEAR Intents.
- `recipient` must be an EVM address (the Hyperliquid account). A NEAR account id is refused
  with `"recipient is not valid"`.
- Minimum is between 1 and 2 USDC: 1 USDC returns `"Failed to get quote"`, 2 USDC quotes.
- The fee is close to flat, which matters more than the headline rate:

  | in | out | fee |
  |---|---|---|
  | 2 | 1.6827 | 0.3173 |
  | 5 | 4.6797 | 0.3203 |
  | 10 | 9.6747 | 0.3253 |
  | 50 | 49.6347 | 0.3653 |
  | 100 | 99.5847 | 0.4153 |

  Fitting those: **fee is about $0.315 flat plus 10 bp.** A $1000 deposit costs about $1.32,
  or 13 bp, which is good. A $2 deposit costs 16 percent, which is a trap. The floor and the
  effective-rate display in the UI both exist because of this table.

## The decision

**Hyperliquid stays the venue. The bespoke Hyperliquid MECHANISM goes.**

Karim's words were "we don't need that hyperliquid mechanism anymore, everything is on near
now". Read against what actually shipped, that is true of the plumbing and not of the
exchange: near.com's own perps are Hyperliquid perps. So the cut is:

| Today | After |
|---|---|
| `src/rails/hyperliquid-deposit.ts`: hold USDC on Arbitrum, ERC-20 transfer to the HL Bridge2 contract, credited by sender address | 1Click quote to `hypercore` USDC with `recipient` set to the HL account, one signature on whatever chain the money already sits on |
| Funding requires the user to already hold USDC on Arbitrum | Funding works from any of the 35+ origin chains 1Click reaches |
| Two mental models: Intents for treasury, a bespoke bridge for trading | One rail. Intents for both. |

Deliberately NOT changed:

- **The `hl_deposit` rail kind stays.** `src/rails/kinds.ts` exports it, the policy engine
  branches on it, the ledger counts it and the UI renders it. The kind means "money entering
  the perps account", which is still exactly what happens. Only the implementation behind it
  changes. Keeping the kind keeps the approval, audit and policy surface untouched, which
  turns a sprawling change into a contained one.
- **Order signing.** `src/hl/msgpack.ts`, `sign.ts` and `exchange.ts` are how orders reach
  Hyperliquid and there is no NEAR path to that. They stay.
- **`src/hl/info.ts` and the market catalog.** Prices, funding, positions and the asset
  universe still come from Hyperliquid.

## Withdraw: the part of the ask that cannot be delivered as stated

1Click refuses `hypercore` as an origin, so there is no Intents path out. Money leaves
Hyperliquid the only way it can: HL's own `withdraw3` to Arbitrum USDC, which costs $1 and
takes about five minutes. `src/rails/hyperliquid-withdraw.ts` therefore STAYS.

What improves is the presentation, not the mechanism: withdraw becomes a two-leg flow the
human approves once, `withdraw3` to Arbitrum, then optionally a 1Click leg from Arbitrum to
wherever they actually want the money. One button, two legs, both named before the click.

This is the one place the brief cannot be honoured literally, and the reason is a limit at
NEAR's end, not a choice here. When 1Click enables hypercore as an origin, the second leg
collapses into the first and the rail gets simpler.

## Perps margin, not spot: the completion condition

OPEN, resolves at build time by observation: a HyperCore delivery may land in the account's
SPOT USDC balance rather than as PERPS margin. The two are separate ledgers on Hyperliquid.

The rail is specified so that either answer works. `hl_deposit` is not complete when 1Click
reports SUCCESS. It is complete when the collateral is spendable as margin:

1. Poll 1Click `/v0/status` to SUCCESS.
2. Read `spotClearinghouseState` and `clearinghouseState` for the account.
3. If the USDC arrived in spot, sign a `usdClassTransfer` to move it to perps.
4. Report done only when `clearinghouseState.withdrawable` has risen by the expected amount.

Step 3 is a no-op when the delivery already credits perps. Writing it this way means the rail
is correct before the question is answered, and the answer only decides whether one extra
signature fires.

## Mainnet

`config.local.json` already reads `network: "mainnet"`, and trading has been on Hyperliquid
testnet regardless. Karim's instruction is explicit: use mainnet.

State of the accounts on 2026-08-20:

- Hyperliquid MAINNET `0xd7b2de...5050`: accountValue 0.0, withdrawable 0.0, 0 positions,
  spot USDC 0.000002. The account exists and is empty.
- Hyperliquid TESTNET, same address: 887.81 USDC spot, 0.077 perps equity, 1 open position.
- Mainnet carries 232 perp markets against testnet's 210, and 40x is the real maximum
  (BTC), which is where near.com's "40x" comes from.

**Verification strategy, and its one honest limit.** Everything that can be proven without
spending Karim's money is proven: the full order lifecycle runs against testnet with its 887
USDC, mainnet is exercised read-only across info, catalog and account, and every 1Click call
in test is `dry:true`. The first real mainnet deposit and the first live order move real money
and are Karim's to trigger. They are reduced to one named command each and reported, not
performed. `config.local.json` also lists `near: ["phosphor.testnet"]` under a mainnet config,
which is wrong and gets flagged with it.

## The trading environment for an agent

`ux/flow.md` already settles the human half and it is not reopened:

> Not for: anyone who wants to click buy and sell by hand at speed. This is not a scalping
> ladder and it has no order ticket. Every manual control on this page STOPS something.
> Starting is what a mandate is for, and a mandate needs a program and a click.

Karim's new ask, "high frequency or low frequency trading env with speed and capabilities like
bots or workflows or limit orders", is answered inside that law rather than against it, because
the law already contains the answer to the frequency question.

**An LLM round trip is 1 to 5 seconds. Nothing traded at that cadence is high frequency.** So
the agent never ticks the loop. The split is:

- The agent DECIDES: which market, which direction, what size, what invalidation, what the
  program is, when to stop. Seconds-to-minutes cadence, one MCP call each.
- The app EXECUTES: resting limit orders, TP and SL brackets, TWAP slices, cancels on a
  dead-man timer. Millisecond cadence, no agent in the loop.

`src/rails/mandate.ts` already is this idea. Its own header says what the human approves is
"not a trade, it is a region of behaviour with a wall around it", bounded by symbol, notional
cap, borrowed multiple, order rate, max loss, expiry and an allowed-verb list. A bot in
Phosphor is therefore not a new object: **a bot IS an armed mandate**, and the work is widening
the verb list the strategy grammar can express, not building a second system beside it.

The capability gap to close is in the verbs, not the architecture. Hyperliquid natively
supports resting limits (Gtc, Ioc, Alo), trigger orders for take-profit and stop-loss,
reduce-only, client order ids, cancel, modify, batchModify, updateLeverage, TWAP and
`scheduleCancel`. Today's exchange module reaches only a fraction of that (exact inventory
pending). Widening it gives both frequencies at once: a weekly swing trade is a mandate with
one entry and a bracket, and a tight market-making loop is a mandate with a high order rate
and a short expiry. Same object, different bounds.

## Trade mode showcases the funding

`ux/flow.md` scoped `/trade` to the venue and left custody on the pro page. That is now wrong:
the headline capability is that this account funds itself from any chain in about 35 seconds,
and a trading surface that hides its own funding buries the thing worth showing.

So trade mode gains funding, under the existing law. A deposit is not a manual control that
starts a trade, so it does not violate "every manual control STOPS something": it moves
collateral, the way the pro page's custody already does.

What it must show, because the fee table above demands it: the origin chain and asset, the
amount out, the effective rate as a percentage, the ETA, and a floor that refuses the amounts
where the flat fee eats the deposit.

## Out of scope

- Adding `hypercore` to `ChainId`. Same argument the Polygon decision made on 2026-08-20 and
  for the same reason: Phosphor never holds a balance on a chain it only passes through.
  Hyperliquid is a venue with a counterparty string, which it already is.
- Touching the pro page at `/`.
- Any NEAR-native perps venue. None exists that is credible; near.com's perps are Hyperliquid.

## Verification

- `npm test` stays green. Baseline on this branch before any edit: 1100 tests, 1100 pass,
  0 fail, `tsc --noEmit` clean.
- `npm run typecheck` clean.
- Live dry quotes for every origin chain the deposit rail claims, asserted in a test that is
  allowed to skip when offline but never allowed to pass on a stub.
- Testnet: a real order placed, modified, cancelled, and a real position opened and closed.
- Mainnet: read paths only, plus the two commands handed to Karim.
- Trade page: driven in a browser at 390, 768 and 1440 CSS pixels, screenshot each, no
  horizontal scroll, every empty state rendering its own line from the COPY table.
  `ux/flow.md` names `~/.claude/tools/ui-gate.mjs` for this and that file no longer exists,
  so the checks it describes are run directly instead.
