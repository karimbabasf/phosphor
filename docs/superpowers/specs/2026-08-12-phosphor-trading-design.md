# Spec: the trading layer, an agent that analyses and a bot that executes

Date: 2026-08-12. Extends `2026-08-11-phosphor-design.md`. Depends on the chart from
`2026-08-12-phosphor-chart-v2.md`. Venue: Hyperliquid perpetuals only. Swaps are a separate
thing and are not touched by this work.

## The problem this solves

Phosphor v0.2 has one shape for money: the agent writes a proposal, a human clicks, the app
executes once. That shape is right for a swap. It breaks for trading, for two reasons that pull
against each other.

1. **A model is too slow to trade.** A position with borrowed size needs a decision in
   milliseconds. An LLM turn is seconds. Put the model in the execution path and the stop fires
   after the liquidation.
2. **A model is the only good strategist.** The reason to want an agent here at all is the part
   that reads a chart, weighs a setup, and argues with you about it.

Products that tried this picked one side. Either the model holds a key and calls an order endpoint
in a loop, which is slow, injectable, and leaves no artifact anybody can audit. Or it is a plain
bot with no agent, which is a script you have to write yourself.

## The resolution: three clocks, one coordinate system

Split the trader into three layers that run at different speeds and hold different authority.

| Layer | Clock | Authority | What it is |
|---|---|---|---|
| Cognition | seconds to minutes | none | The agent. Reads the chart, forms a thesis, argues with you. |
| Mandate | one human click | total | The envelope you approve. The only thing a human clicks. |
| Execution | milliseconds | bounded by the mandate | A deterministic runner. No model inside it. |

The agent has hands and eyes but no wallet. The runner has a wallet but no judgment. The click
between them is phosphor's existing trust boundary: a physical click in the app window, on a
surface the agent cannot reach.

### The idea underneath

**The chart is not a picture. It is the shared coordinate system between the human, the agent and
the bot.**

The agent draws a trend line. You see that exact line. The bot triggers off that exact line, by id,
and its fills come back as marks on the same chart. One object, three consumers, and no translation
step where meaning can go missing.

That is the part nobody has built. Other tools let an agent describe a chart, or let a bot read a
price. None of them make the drawing itself the executable reference.

### Two different latency problems

Worth naming, because they have opposite answers.

- **The agent's latency is round trips.** Each MCP call is an LLM turn: seconds. An analysis that
  takes twelve calls takes a minute. The answer is batching: one call that answers twelve questions.
- **The bot's latency is milliseconds.** Tick to signed order. The answer is a dedicated process
  with its own socket, no model, and no shared event loop with the web server.

Optimising either one with the other's technique makes it worse.

## The third rule

Phosphor has two rules. This adds a third.

**3. Approval has a shape.** A click can authorise one transaction, or it can authorise a bounded
program. The mandate is the second kind: symbols, size, borrowed multiple, order rate, maximum
loss, expiry, and the exact program that runs inside those bounds. What you approve is not a trade.
It is a region of behaviour with a wall around it.

The wall is checked in the same function as the signature, on every action. There is no moment
where anything can act outside the envelope, because the check is not a service that can be
skipped. It is the last thing the signer does before it signs.

## The strategy artifact: a grammar, not a script

The instinct that the agent writes an execution script is right. The literal form is wrong.

**Option A: the agent writes JavaScript and the app sandboxes it.** Most expressive. Fails three
ways. You cannot read it and know what it does, so the click at the centre of the design becomes
uninformed. You cannot bound its worst case before running it, so "max loss" is a hope. And a
sandbox that holds against an agent which may have been poisoned by a token description is an
ongoing security project, not a feature.

**Option B, chosen: the agent emits a declarative program in a small typed grammar.** Conditions
and actions, both closed sets. Every real discretionary trade expresses cleanly: laddered entries,
stops, partial exits, trailing, time stops, invalidation, session filters, and references to the
chart objects the agent drew. It renders back to plain English, so the approval screen shows what
you are actually arming. Its worst case is computable before you click, because size and the
borrowed multiple are literals in the tree and not the output of a loop.

The property that decides it: **the grammar has no verb for moving money out.** No withdraw, no
transfer, no approve, no address anywhere in the schema. You cannot express theft in the language.
A fully poisoned agent writing a fully malicious program can, at worst, trade badly inside an
envelope you already agreed to.

This is the same move phosphor already made for policy: the agent authors sentences, the app
enforces them forever with no model involved. A program is a policy that trades.

### Conditions

A closed set. Every one is a pure function of market state, position state and time.

- `price` against a reference, with `above`, `below`, `crosses_up`, `crosses_down`
- `bar_close` on a named timeframe, against a reference, above or below
- `indicator` value or cross, by indicator id and plot name
- `position` state: flat, long, short, and unrealised move in percent or dollars
- `time`: after, before, or inside a UTC session window
- `elapsed` since arming or since entry
- `and`, `or`, `not`

A **reference** is the piece that ties the layers together. It is a literal price, or the id of a
chart object the agent drew (`line:<id>`, `level:<id>`, `zone:<id>`), or an indicator handle. A
trend line is therefore a trigger, evaluated at the current bar by the same maths that drew it.

### Actions

A closed set. Note what is absent: nothing moves value off the venue.

- `open` with side, size in dollars or percent of the mandate, borrowed multiple, and an entry of
  market, limit at a reference, or post-only at a reference
- `add` to scale in, `reduce` by percent or size, `close`
- `set_stop` at a reference, hard or trailing by distance
- `set_target` at a reference, with a size fraction
- `cancel` working orders, all or by group
- `stand_down` with a reason: halt the program, keep the position, tell the human
- `notify` with text

`open`, `add`, `reduce` and `close` are the only verbs that place orders, and every one of them
resolves its size and price through the envelope check before signing.

## Layer one: the instrument surface

The agent is the brains. This layer is hands and eyes. It does not detect patterns, because the
agent decides what a pattern is. It answers questions and it draws.

### Why this layer is the whole bet

There is a public experiment that settles the question. nof1.ai's Alpha Arena, from October 2025,
gave six models ten thousand dollars each of real capital and a live Hyperliquid trade API. Most
lost badly: Claude Sonnet 4.5 and Gemini 2.5 Pro both worse than minus forty percent, Grok 4 around
minus fifty-eight. Two finished positive, Qwen3 Max at plus twenty-two and DeepSeek V3.1 at plus
five. Every one of them was handed raw numeric market state and an order endpoint, and none was
given a measurement layer.

The survey of connected trading tools says the same thing from the other side. There are at least
eight community Hyperliquid MCP servers and no official one, all of them thin wrappers over the
venue's endpoints, and **not one exposes an analysis primitive**. The industry built the order API
eight times and the instrument zero times.

So this layer is not a convenience around the execution engine. It is the part that decides whether
any of this works.

### The line between a measurement and a conclusion

The distinction that keeps "the agent is the brains" true while still giving it real tools.

A **measurement** is reproducible, parameterised, and carries no opinion. "These bars are swing
highs at prominence 0.4 ATR." "Average true range sits in the 12th percentile of the last 252
bars." "The volume point of control for this range is 4218.5." The agent decides what any of it
means.

A **conclusion** is the model's job and this layer never returns one. No "bullish reversal", no
"head and shoulders forming", no signal, no score, no suggested trade. A layer that ships opinions
replaces the judgment that is the reason to have an agent at all, and it is also how you get a
product that is confidently wrong.

Every primitive below is a measurement. Where an algorithm has a parameter that changes the answer,
the answer says which parameter produced it, because a level that moves when you change the bin
width and does not say so is a number pretending to be a fact.

### Primitives

Chosen from what a discretionary trader actually measures, with the failure modes that decide the
implementation:

- **Swing points**, by prominence rather than a naive rolling maximum. Prominence measures how far
  a peak stands out from its surrounding baseline, which is what kills the micro-noise pivots a
  plain local-max test keeps.
- **Trend lines fitted from those pivots**, returned with their anchors so the agent can accept,
  move or reject the fit rather than inherit it.
- **Volatility regime**: average true range as a percentile rank over a stated lookback, bucketed.
  This is the primitive that sets stop distance and position size, so it earns its place even
  though the percentile is lookback-relative and will call a wild market normal if the window
  covers a wilder one. The response says the window.
- **Volume profile**: point of control and value area over a stated range. Bin width dominates the
  result, volume and time-at-price disagree when size trades fast at one level, crypto has no
  session so any daily anchor is arbitrary, and perp volume reflects positioning rather than
  accepted value. All four are reasons to return the parameters beside the levels, not reasons to
  skip the primitive.
- **Level clustering** from pivot prices, so "where has this reacted before" is one call.
- **Anchored volume-weighted average price**, anchored to a bar the agent picks.
- **Range and consolidation detection**, returned as boundaries and a duration.
- **Divergence** between price and any oscillator in the catalogue, returned as the two pivot pairs
  that form it so the agent can check the claim.

Built on one principle: **an analysis turn should cost one round trip.**

### The batch envelope

One MCP tool, `chart_batch`, takes an ordered list of operations and returns an answer for each.
Reads and writes mix freely in one call. A whole "look at ETH across five timeframes, mark the
swing points, draw the trend line, measure the distance to it" sequence is one turn instead of
nine. Later operations can reference ids created by earlier ones in the same batch, so drawing a
line and then measuring against it stays a single call.

### Operations

**Seeing.** Candles for any symbol, timeframe and range, including history far behind the visible
window, paged by explicit cursor so the agent can walk back a long way without loading everything.
Multi-timeframe fetch in one op.

**Measuring.** The measurements a trader takes by hand, returned as numbers: distance between two
points in price, percent, ticks, bars and wall-clock time; the value of any drawn object at any
time; a range summary (high, low, mean, standard deviation, volume, average true range); where
price sits inside a range as a fraction; and the touch record of any line or level, meaning every
bar that came within N ticks of it.

**Drawing.** Horizontal levels, trend lines from two anchor points with optional extension, zones
between two prices, and marks on a bar. Every object gets a stable id, renders on the human's
chart, and carries an `[agent]` tag. Anchors can be given as a price and a time, or as "the low of
bar N", so the agent can anchor to structure without doing pixel arithmetic.

**Geometry.** Where price sits relative to object X right now and by how much. Whether price has
crossed X in a window, and on which bars. What X evaluates to at time T. This is what makes a drawn
line usable as a trigger.

**Indicators.** The existing catalogue from `src/indicators.ts`, plus reading any indicator's
series over a range rather than only its last value, so the agent can judge slope, divergence and
regime for itself.

Everything returns the numbers the human's pixels are drawn from. One computation, two consumers,
so the agent and the human can never disagree about what the chart says.

## Layer two: the mandate

A mandate is a `WriteDraft` of a new kind, so it rides phosphor's existing approval machinery
rather than opening a second trust path. The gate, the audit log, the policy engine and the
approval panel all already know how to handle a draft.

Consequences worth stating:

- The existing budget rules govern mandate size for free. `amountUsd` on the draft is the maximum
  notional the mandate can put at risk, so `humanClickAboveUsd` and `maxPerSessionUsd` apply with
  no new rule written, and `sessionSpentUsd` counts it automatically because that filter excludes
  `policy_change` rather than listing what counts.
- `simulate()` renders the program to English and computes the worst case, so the approval screen
  shows behaviour rather than JSON.
- Disarming is not a draft and is never gated. Stopping is always allowed. Safety actions do not
  ask permission.

**Arming never auto-approves, on any network, with the gate on or off.** `land()` already carves
out exactly one kind this way: a `policy_change` stays pending even when the testnet gate is
disabled, because it changes the rules rather than spending inside them. A mandate is the same
class of thing. It grants standing authority, so it joins that carve-out rather than riding the
gate flag. This is one condition added beside the existing one in `src/proposals.ts:333`.

One thing a mandate does not fit cleanly. Every existing rail hands funds to a counterparty
address that must appear in `venueAllowlist(network)`, and `evaluateRail` refuses an unlisted
one. A perp order moves nothing off the account: margin, position and profit all stay inside the
Hyperliquid account the human already funded. The check still has to mean something, so the
mandate rail declares the venue itself as counterparty and a new `hyperliquid-perps` entry is
seeded in the allowlist. Because `src/main.ts` never auto-updates an existing `policy.json`, an
existing install needs a human policy edit before a mandate can arm. That is correct behaviour
and worth saying out loud rather than papering over.

The envelope carries: the program hash, the symbol set, maximum notional, maximum borrowed
multiple, maximum orders per minute, maximum loss from the moment of arming, an expiry, and the
subset of action verbs the program may use. A program whose hash does not match its mandate cannot
run. Editing a program means arming a new mandate, which means another click.

### The key that cannot steal

Hyperliquid splits signing into two paths, and the split is the best security property available
here. Verified in the SDK source, `signing.py` and `exchange.py`:

- `sign_l1_action`, EIP-712 `primaryType: "Agent"` on chain id 1337: orders, cancels, modify,
  `updateLeverage`. These an **API wallet may sign**.
- `sign_user_signed_action`, typed against the real chain id: `HyperliquidTransaction:Withdraw`,
  `UsdSend`, `SpotSend`, `UsdClassTransfer`, `SendAsset`, `ApproveAgent`. These resolve the account
  **from the signature itself**, so an API wallet signing one would be acting on its own empty
  account, not the master's.

So the runner holds an API wallet, and that key can trade and cannot withdraw, cannot transfer,
cannot move funds between perp and spot, and cannot approve another agent. Total compromise of the
runner process loses trading control, not the money.

Two operational rules follow from the venue docs. API wallet addresses are never reused, because
a deregistered agent's nonce state can be pruned and previously signed actions replayed. And the
approval that creates the API wallet is itself a user-signed action, so it needs the master key
and therefore a human click: the runner can never mint its own authority.

### The rule this work bends, and why

`src/chain/evm.ts` says signing is centralised there on purpose, and the integration map calls a
second signing site "the change this codebase is most explicitly built to prevent". The runner
signs. That is a real exception and it deserves an argument rather than a quiet commit.

The rule as written is about one key. The repo already has two signing sites, because
`src/rails/hyperliquid-withdraw.ts` signs EIP-712 user actions with a scheme `evm.ts` does not
know. So the honest form of the rule is **one signing site per key, and every key online only
where it must be**.

Under that form the runner is compliant and, more than that, is the thing that keeps the rule
true. The master key stays where it is and never enters the runner. The API wallet key exists
precisely so the key in the hot path is one that cannot move funds. Refusing the exception would
mean signing orders with the master key, which is strictly worse.

So: three signing sites, one per key class, each stating its own scope in its header.

| Site | Key | Can |
|---|---|---|
| `src/chain/evm.ts` | master EVM | move funds on chain |
| `src/rails/hyperliquid-withdraw.ts` | master, user-signed actions | withdraw; script-only, no rail, no MCP tool |
| `src/trading/sign.ts`, inside the runner | API wallet | trade, and nothing else |

The API wallet key is generated by the app, kept in the existing keys file outside the working
copy, and handed to the runner at spawn. It is never readable through any MCP tool, and the
agent has no operation that returns it.

Note for the build: order actions use the msgpack phantom-agent scheme, which is a different
scheme from the EIP-712 one `hyperliquid-withdraw.ts` already implements and asserts against the
official SDK fixtures. The withdraw module is the pattern to copy for rigour, not for bytes.

## Layer three: the runner

A separate child process, spawned on the first arm and killed when nothing is armed.

Two alternatives were considered. **Inside the main process** is simplest and wrong: an order would
queue behind whatever the HTTP server and the chart's SSE broadcast are doing, and a wedged request
would delay a stop. **A worker thread** fixes the scheduling but shares a process, so a hard kill is
not clean and a crash takes the app down with it. **A child process** costs sub-millisecond IPC and
buys three things that matter: its own event loop, its own socket, and a kill that is absolute.

One process hosts every armed mandate, each as its own state machine, over one multiplexed
websocket. Per-mandate processes were rejected as sprawl for no safety gain, since the envelope
check is per action either way.

Inside it:

- **The feed.** Websocket subscriptions to `activeAssetData` for position and margin per asset,
  `orderUpdates` and `userFills` for order state, and `bbo` for the lightest price feed. Snapshot
  messages arrive tagged `isSnapshot: true` and are folded in once, not replayed.
- **The evaluator.** On every relevant event, walks each armed program's conditions and produces
  intended actions. Pure and deterministic: same inputs, same output, which is what makes it
  replayable against history.
- **The envelope check.** Every intended action is checked against its mandate here, in the same
  function that signs. Anything outside halts the mandate rather than clamping it, because silently
  shrinking an order the human approved is its own kind of lie.
- **The risk supervisor.** Runs on every tick regardless of program logic. Watches drawdown from
  arming, expiry, distance to liquidation, and the kill switch. On a breach it flattens and disarms,
  and it does not consult the program to do it.
- **The reporter.** Streams fills, position state and every decision back to the app over IPC, for
  the chart, the log and the audit trail.

The kill switch is reachable three ways: the button in the window, the existing `policy.killSwitch`,
and a signal to the process. Any one stops everything. It never depends on the agent, the browser,
or the program.

## Execution quality: what the real threats are here

"MEV protection" is the right instinct carried over from swaps, and it does not map onto this venue.
HyperCore is an onchain order book with validator consensus and no public mempool to be sandwiched
in. Building Flashbots-style private orderflow here would be theatre. The threats that are real:

**Liquidation runs on mark price, not the book.** Mark blends external venue prices with
Hyperliquid's own book state, and the docs warn it can diverge sharply from book price exactly when
it matters, during volatility and on positions with a large borrowed multiple. A supervisor watching
last trade is watching the wrong number. We watch mark.

The exact formula, which we implement rather than estimate:

```
liq_price = price - side * margin_available / position_size / (1 - l * side)
l    = 1 / MAINTENANCE_LEVERAGE
side = 1 for long, -1 for short
margin_available (cross)    = account_value - maintenance_margin_required
margin_available (isolated) = isolated_margin - maintenance_margin_required
```

**Backstop liquidation forfeits the maintenance margin.** Below two thirds of maintenance margin the
liquidator vault takes the position and the maintenance margin is not returned. The docs say plainly
that the way to avoid this is to place stops or exit before mark reaches the liquidation price. So a
mandate that permits `open` without a stop is a mandate the approval screen must argue with.

**Order rejection is a correctness bug, not bad luck.** Prices take at most 5 significant figures and
at most `6 - szDecimals` decimals for perps, sizes round to `szDecimals`, and trailing zeroes must be
stripped before signing. A strict formatter with tests against the documented examples, not
`toFixed` and hope.

**Slippage on a book is a price bound, not a percentage.** An aggressive entry is an IOC limit at a
computed worst acceptable price, derived from the book and capped by the mandate. Never a naive
market order.

**Nonces are per signer and pruned.** The 100 highest nonces are kept per signer and must sit inside
`(T - 2 days, T + 1 day)`. One atomic counter per runner, fast-forwarded to unix milliseconds,
matching the venue's own recommendation. Orders and cancels batch on a short timer, with add-liquidity-only
batches kept separate from immediate-or-cancel and good-til-cancelled, because the validators
prioritise them differently.

**Idempotent retry.** Every order carries a client order id, so a retry after an ambiguous network
failure cannot double-fill.

**Rate limits are an address-level budget, not a per-second cap.** One request per USDC of cumulative
volume, starting from a buffer of 10,000, and a batched request counts as one for the IP limit but
n for the address limit. Cancels get a larger allowance than orders on purpose, so a rate-limited
account can still get flat. The runner budgets against this and reserves headroom for exits.

## What renders on the chart

Positions and orders are chart objects, not a separate table: entry as a line carrying size and
direction, liquidation price as a line the eye finds immediately, stops and targets as lines,
working orders at their price, and every fill as a mark on the bar it happened on. Live unrealised
profit and loss reads off the same mark price the supervisor is watching.

The envelope draws too. Maximum loss is a real price, so you can see the wall you approved.

Two facts about the existing surface this has to fit. There are **no named SSE events**: the
browser discriminates on `payload.type`, and there are four today (`state`, `chart`, `log`,
`candles`). Trading adds one more, `trading`, carrying position, working orders and runner
status, on the same channel and with the same debounce discipline so a busy market cannot flood
it.

And `.design/brief.md`, which `ui-gate.mjs` judges the page against, still says "No indicators,
no drawing tools, no crosshair". The chart v2 work already contradicts it and this work
contradicts it further. The brief is the design contract, so it gets updated as part of this
work rather than left to fail the gate. That edit is coordinated with the chart agent, since we
would otherwise both write the same file.

## Security model

The trust boundary is unchanged: a physical click in the app window. What this work adds is that a
click can authorise a shape instead of a single item, and four properties keep that honest.

1. **The grammar cannot express theft.** No verb moves value out, and no schema field anywhere
   accepts an address. This matches the existing rule that the agent cannot name where money goes,
   which `tests/injection.test.ts` already asserts for the rails. The same test gains the mandate
   schemas.
2. **The key cannot withdraw.** Enforced by the venue, not by our code.
3. **The envelope is checked at the signer.** Not in a service, not in the UI, not in the agent.
4. **Halting is unconditional and unauthenticated from inside.** Anything can stop the bot. Only a
   human click can start one.

The injection story worth being explicit about: an agent that reads a poisoned web page and decides
to arm a hostile mandate still has to get a human to click a screen that renders the program in
English, with its worst case computed. That is the same defence phosphor already relies on, applied
to a bigger unit of authority.

## Latency budget

Measured tick to signed order, inside the runner, excluding network:

| Stage | Target |
|---|---|
| Websocket frame parsed to evaluator input | under 1 ms |
| Evaluator pass over one armed program | under 1 ms |
| Envelope check | under 0.1 ms |
| Sign and serialise | under 2 ms |
| Total local decision | under 5 ms |

Network to the venue dominates everything above and is not ours to fix. The point of the budget is
that nothing we own adds a tail. That means no synchronous disk writes in the hot path, no JSON
round trip through the main process before signing, and reporting to the app on a separate channel
from execution, so a slow consumer cannot back-pressure an order.

## Not doing

Backtesting as a product surface, though the evaluator is deterministic so replay is possible later.
Multiple venues. Spot. Cross-symbol strategies, meaning one program covers one symbol in v1.
Automatic strategy generation without a human reading it. Any form of copy trading or vaults.

**A vision channel**, deliberately, and with a note against it. The research recommends pairing
the numbers with a rendered image, because a model reads global shape and layout better from a
picture than from a wall of values, and Karim's answer was that the API is what he wants. The
numeric and primitive layers are the evidence either way; a picture would only help framing. If
analysis quality disappoints in use, rendering the existing canvas server-side and returning it
beside the measurements is the first thing to try, and the spec records that now so the option is
not rediscovered later.

## Verification

- `npm run typecheck` clean, `npm test` green.
- Unit tests for the price and size formatter against every documented tick and lot example, since
  a formatting bug is a rejected order.
- Unit tests for the liquidation formula against hand-worked cases, long and short, cross and
  isolated.
- Property test: no sequence of program actions can produce an intended order that passes the
  envelope check while exceeding notional, borrowed multiple, or order rate.
- `tests/injection.test.ts` extended: the mandate and program schemas carry no address field, and
  no action verb moves value off the venue.
- An empirical check on testnet that an API-wallet-signed withdrawal does not move master funds,
  because a security property this design leans on should be observed and not only read.
- End to end on testnet: arm a mandate, watch it fill, watch a stop fire, hit the kill switch mid
  position and confirm flat.
- `node ~/.claude/tools/ui-gate.mjs` to PASS on the trading surfaces.
