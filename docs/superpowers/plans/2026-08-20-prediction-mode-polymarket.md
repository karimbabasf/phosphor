# Phosphor prediction mode: Polymarket integration plan

**Repo:** `~/Developer/phosphor` (currently on `feat/in-app-driver`, v0.3.0, 1003 tests)

## Context

Phosphor has two screens today, `pro` and `trade`. This adds a third, `prediction`, on
Polymarket. The app stays what it is: pure code, endpoints and switches, no model inside it,
driven over MCP by an agent that is either connected from outside or spawned by the app itself
(`src/driver.ts`). Prediction mode adds no new architecture. It adds one venue, three rails and
one screen, on top of machinery that already exists.

Two goals set every decision below. **Speed**, because a prediction market moves on a headline
and the trade is worth nothing thirty seconds later. **Capability**, because the agent can only
advertise what the app can actually execute.

The wallet abstraction is the product. A user holds USDC on Base, or SOL, or BTC. They never
open polymarket.com, never hold POL for gas, never learn what pUSD is, and never see a second
wallet. Phosphor moves the money and signs the orders.

### What the research settled

Live checks run 2026-08-20, not read from memory:

| Fact | Value | Why it matters |
|---|---|---|
| Polymarket collateral | **pUSD**, ERC-20 on Polygon, 6dp, USDC-backed | Not USDC.e any more. Wrapped by `CollateralOnramp`. |
| 1Click covers Polygon | yes, `pol`, native USDC `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | assetId `nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L` |
| 1Click Polygon round trip | about 12 bp each way, 37 to 39 seconds | dry quotes both directions returned live |
| Polymarket bridge accepts | native USDC on Polygon, **min $2** | exactly the asset 1Click delivers, so the two chain with no swap |
| Polymarket bridge chain list | 12 chains, **no NEAR** | intents reaches 25+; that gap is the advertising line |
| CLOB rate limit (standard) | **40 orders/s, burst 60**; 80 cancels/s, burst 120 | per signer, separate buckets |
| Order types | market, limit GTC, limit GTD | GTD needs 3 min or more out, and expires 60s early |
| Heartbeat endpoint | stop sending it and **every resting order is cancelled** | a dead-man switch Hyperliquid does not offer |
| Builder program | gasless wallet deploy, approvals, orders, CTF ops | this is what makes the wallet abstraction possible at all |
| Builder fee ceiling | 100 bp taker, 50 bp maker, default 0 | changes need a 7-day cooldown plus 3 days of notice |
| Testnet | **there is none** | same as 1Click; prediction mode is mainnet-only by construction |

### The two decisions you made

1. **Withdraw is intents-only.** Every withdraw goes pUSD, then the Polymarket offramp, then native
   USDC on Polygon, then 1Click out, including to chains Polymarket could reach directly. One rail,
   one mental model, about 12 bp and one extra hop on every withdraw.
   The cost I flagged is real and the plan handles it rather than hides it: Polymarket's offramp
   swaps through a single Uniswap v3 pool (`0xd36ec33c8bed5a9f7b6630855f1533455b98a418`) that they
   warn can run dry. Phase 4 puts a pool-depth precheck in front of every withdraw and, when it
   fails, refuses with the sentence and offers the direct-pUSD escape hatch instead of stalling.

2. **Phosphor deploys the wallet** through the builder relayer. Phosphor's existing EVM key is the
   signer; the Deposit Wallet is deployed gas-free. No polymarket.com visit, no POL. Builder fee
   rate starts at **0 bp**.

## Architecture

**Polygon is not a Phosphor chain.** `ChainId` stays `eth | base | arb | sol | near`. Adding `pol`
would cascade through the engine, the ledger, the policy file and the wallet's CHAIN column for a
chain Phosphor never custodies on. Polymarket is a *venue* with a counterparty string, the way
Hyperliquid already is. The Polygon USDC assetId is a pinned constant checked against the live 1Click
list at boot, matching the existing rule in `src/intents.ts` that a table in the repo decides where
money goes and remote text never does.

**Deposit is two deposit addresses chained.** Polymarket's bridge and 1Click are the same shape:
mint an address, send to it, poll status. So `POST bridge.polymarket.com/deposit` gives a per-wallet
EVM address, and that address becomes the `recipient` of a 1Click quote. Phosphor signs one ERC-20
transfer on the user's own chain. Polymarket does the pUSD wrap. Nothing touches Polygon on our side.

**Everything is an MCP tool.** `src/driver.ts` prefix-matches `mcp__phosphor__` and kills the session
on any tool it did not expect. New tools are allowed automatically; UI-only affordances are invisible
to the in-app agent. So no capability ships as a button alone.

**Speed comes from the mandate, not from the transport.** The approval gate is a human click, which
is seconds when the edge is milliseconds. The existing answer is already in the repo: `src/rails/
mandate.ts` grants standing authority once, and `src/runner/` places orders with no model in the
process. Prediction mode reuses both. Approve the envelope once, and the runner fires inside the
rate limit budget.

## File structure

**New, `src/predict/`** (mirrors `src/hl/` plus `src/trade/`, same split of transport from state):

| File | Responsibility |
|---|---|
| `client.ts` | CLOB and bridge REST transport. Data in, data out, no decisions. |
| `sign.ts` | EIP-712 order signing, L2 API-key headers, builder-code attribution. |
| `wallet.ts` | Deposit Wallet resolution and gasless deployment via the builder relayer. |
| `catalog.ts` | Event and market discovery, slug, condition id and token id resolution. |
| `book.ts` | Book, mid, spread, depth. Pure, so the agent's number and the pixel agree. |
| `state.ts` | Raw venue state in, one `PredictPayload` out. |
| `view.ts` | View state, overlays, highlights. |
| `service.ts` | Wiring. |
| `feed-ws.ts` | Market channel and user channel websockets. |
| `heartbeat.ts` | The dead-man switch. |
| `redeem.ts` | Resolution sweep and redemption. |
| `edge.ts` | The mispricing scanner: YES plus NO under 1.00, negative-risk baskets off 1.00. |

**New rails:** `src/rails/prediction-deposit.ts`, `prediction-withdraw.ts`, `prediction-order.ts`.

**New UI:** `ui/predict.html`, `ui/predict.js`, `ui/predict.css`, modelled on the `trade.*` trio.

**Modified:** `src/types.ts` (`ViewMode` gains `'prediction'`, new draft types) · `src/view/mode.ts`
(`isViewMode`; every failure path still returns `pro`) · `src/rails/kinds.ts` and `index.ts` ·
`src/policy/engine.ts` and `file.ts` · `src/mcp.ts` · `src/greeting.ts` · `src/server.ts` ·
`src/strategy/grammar.ts` · `src/config.ts` · `data/tokens.json`.

## The tool surface

Reads, no approval:

| Tool | Answers |
|---|---|
| `predict_search` | find events and markets by text, tag, closing window, volume, liquidity |
| `predict_market` | one market: outcomes, token ids, prices, spread, resolution date, rules text |
| `predict_book` | book depth for a token |
| `predict_portfolio` | positions, pUSD balance, open orders, unrealised |
| `predict_activity` | fills and history |
| `predict_rewards` | which markets pay maker rewards right now, and at what config |
| `predict_edge` | mispricings: YES plus NO under a dollar, negative-risk baskets that do not sum to one |

Writes, each a proposal a human clicks:

| Tool | Notes |
|---|---|
| `predict_fund` | deposit from any chain 1Click reaches |
| `predict_withdraw` | withdraw to any chain, via the offramp then 1Click |
| `predict_order` | market or limit, GTC or GTD, batched |
| `predict_cancel` | **no approval.** Cancelling only reduces exposure. Matches the safety-verb rule already in `checkEnvelope`. |
| `predict_redeem` | redeem resolved winners |
| `predict_arm` | arm a prediction mandate, standing authority, always a human click |

## What people actually value, and whether Phosphor can execute it

| What a Polymarket trader wants | Phosphor executes it as | Ships in |
|---|---|---|
| Be first on a headline | agent reads the news, `predict_order` market buy, inside a pre-armed mandate so there is no click in the path | 3 and 6 |
| Rest a ladder at a price | GTC limits, one batch request | 3 |
| Never miss a resolution | `predict_redeem` sweep; resolved winners are dead money until redeemed | 5 |
| YES plus NO under $1.00 | `predict_edge` reads both books, sizes the pair, one batch | 7 |
| Get paid to make markets | `predict_rewards` names the paying markets; maker orders rest inside the spread | 7 (the loop is the LP work you parked) |
| Money in and out from anywhere | 1Click plus the offramp | 2 and 4 |
| One screen for forty small positions | `predict_portfolio` and the prediction window | 1 |
| Exit before resolution | sell into the book | 3 |
| "If the Fed cuts, buy this" | a rule in the strategy grammar | 6 |
| Not getting stuck when the app dies | heartbeat dead-man switch cancels everything | 6 |

Out of scope, named so nobody assumes it: Polymarket **perps** (a separate product with its own
websockets; Phosphor already has Hyperliquid perps and a second perps venue is its own decision),
sports live trading, and the combinatorial RFQ quoter gateway.

## Phases

Each phase is shippable on its own and ends with tests passing.

**1. Read-only prediction mode.** `ViewMode` gains `'prediction'`, the window, the seven read
tools, catalog, book, state, view, feed. No money can move. This is most of the UI work and it
carries zero risk.

**2. Money in.** `prediction-deposit` rail: builder registration, gasless Deposit Wallet deploy,
bridge address, 1Click leg, status poll. Ends with a real $5 deposit from Base.

**3. Orders.** `prediction-order` rail, market and limit, GTC and GTD, batch, cancel. Policy limits:
per-order notional, per-session notional, price floor and ceiling so nothing buys a 0.99 tail.

**4. Money out.** `prediction-withdraw` rail, offramp then 1Click, with the Uniswap pool-depth
precheck and the direct-pUSD fallback.

**5. Resolution.** `predict_redeem` and the sweep that finds resolved winners sitting idle.

**6. Standing authority and speed.** Strategy grammar gains a venue discriminant and prediction
verbs; the perps-only fields (margin multiple, liquidation reference, long and short sides) are
refused under it. Prediction mandate, runner integration, heartbeat dead-man switch. This is the
phase that makes the app fast.

**7. Edge.** `predict_edge` scanner and maker-reward targeting.

## Verification

- `npm test` (71 unit files today, 1003 tests) plus new `tests/unit/predict-*.test.ts`
  and `prediction-{deposit,order,withdraw}.test.ts`, following the existing naming.
- `npm run typecheck`.
- Phase 2 gate: a real $5 deposit from Base lands as pUSD, evidenced by the audit line and the
  Polymarket portfolio read agreeing on the number.
- Phase 3 gate: a $1 GTC limit order at 0.10 rests on a real book, is visible in `predict_portfolio`,
  and cancels.
- Phase 6 gate: kill the runner mid-session and confirm Polymarket cancelled every resting order.
- End to end through the in-app driver, not just the CLI, since that is where this now lives.

## Things that will bite

- **Mainnet only.** Polymarket has no testnet and neither does 1Click. Prediction mode needs the same
  `NO_TESTNET_REASON` guard `src/rails/oneclick.ts` already carries. It also lands on the treasury
  (mainnet) side of the config, so the note in the vault stands: the trading half and this half
  cannot both be live in one config.
- **The deposit address is unverifiable.** True of 1Click already, now true twice over. The mitigation
  is unchanged: check the shape, check the echoed amounts, let the policy engine cap what is at stake.
- **Builder registration is an outward-facing account action** on polymarket.com, so it is yours to do,
  not mine. It also sets a public fee rate, and changing it later costs a 7-day cooldown plus 3 days
  of notice.
- **`delayed` order status.** Marketable orders can be held by a matching delay. The UI must show that
  state honestly rather than rendering it as filled.
- **Beacon-proxy wallets.** Deposit Wallets deployed after 2026-06-29 are ERC-1967 beacon proxies that
  Polymarket can upgrade. That is their call, not ours, and it belongs in `SECURITY.md`.
