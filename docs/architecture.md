# Architecture

Two processes, one direction of trust. Everything below follows from the rule that the agent must
never be able to approve its own actions.

## The two-process topology

    Claude Code / Codex / any MCP client
                 |
                 | stdio (MCP)
                 v
    +---------------------------+
    | src/mcp.ts                |   no state, no keys, no files, no approval path
    | stdio MCP server          |   36 tools, every call becomes one POST
    +---------------------------+
                 |
                 | HTTP POST /api/mcp  ->  127.0.0.1:4177
                 v
    +---------------------------+
    | src/main.ts               |   the authoritative state owner
    | app process               |   policy, ledger, proposals, audit, HTTP + UI
    +---------------------------+
                 ^
                 | /api/approve, /api/refuse, /api/kill  (token-gated)
                 |
         the browser window at 127.0.0.1:4177
         a human, clicking

The MCP process is deliberately thin. It has no database, writes no files, holds no keys, and
resolves exactly one thing on startup: which port the app is on. Every tool call is forwarded to
`/api/mcp` and the JSON reply is handed back verbatim. If the app is not running, every tool returns
"The control app is not running. Start it with: npm run app" rather than doing anything clever.

That thinness is the point. The routes that decide things (`/api/approve`, `/api/refuse`,
`/api/kill`, `/api/session`) are on the app process, they require a token minted per boot, and the
string `/api/approve` does not appear anywhere in `src/mcp.ts`. A test asserts that, along with the
absence of any tool named `approve`, `refuse`, `kill`, `dismiss` or `execute`. The agent's *MCP
process* has no route to a decision and no credential to use if it found one.

That last sentence is narrower than it looks and the wording is deliberate. The separation is
between processes, not between the agent and the machine. An agent that can also run a shell can
fetch the token from `/api/session` and post it, which is an open hole at the time of writing and is
documented in full in [the security model](security-model.md#the-honest-v1-boundary).

**One agent at a time.** The first MCP session to speak takes the seat, and every other session is
refused with the reason until it leaves. A session leaves by shutting down, or by going quiet for
longer than two and a half heartbeats. This replaced an earlier design where two agents could both
connect and read: two agents driving one wallet looked exactly like one agent, and neither of them
knew about the other. `src/agents.ts` owns the seat. Proposals still queue, and each is approved
separately.

## Module map

| Module | Responsibility |
|---|---|
| `src/main.ts` | Wires everything and boots. Seeds a default policy only when the file is absent. |
| `src/config.ts` | Merges `config.local.json` over `config.json`, applies the `PHOSPHOR_*` env overrides, resolves `keysPath` and asserts it sits outside the repo, creates the data dir. Throws when `network` is absent. |
| `src/server.ts` | HTTP surface: the UI, the read APIs, `/api/mcp`, and the token-gated decision routes. |
| `src/mcp.ts` | The stdio MCP server. A proxy, nothing else. |
| `src/ledger/` | `evm.ts`, `solana.ts`, `near.ts` readers plus `demo.ts` fixtures, behind one interface in `index.ts`. Read-only by construction. `snapshot()` reads token balances; `positions()` reads pool positions separately, so a venue being down cannot mark a whole chain stale. |
| `src/wallet.ts` | The wallet view: one row per token and per LP position, with chain, quantity, unit price, USD value and share. Natives included. |
| `src/composition.ts` | Classifies holdings against `data/risk-table.json`: issuer, freeze power, shares. Natives excluded, because composition rules are about stablecoin issuer concentration. |
| `src/policy/engine.ts` | Pure. Takes a draft and a context, returns one of three verdicts. No IO, no clock, no network. |
| `src/policy/gate.ts` | The single chokepoint deciding whether a proposal needs a human click. Mainnet forces yes. |
| `src/policy/file.ts` | Load, validate and save `state/policy.json`. Returns null on anything it cannot trust. |
| `src/policy/render.ts` | Policy to plain English. Pure and deterministic. |
| `src/proposals.ts` | Simulate, evaluate, persist, and execute after approval. The only path to execution. |
| `src/intents.ts` | NEAR Intents 1Click quotes, asset id resolution (registry first, then the gas-asset table), the synthetic quoter for demo mode, and the stub Signer. |
| `src/rails/intents-deposit.ts` | Moves wallet funds INTO `intents.near` so the `intents-native` venue has something to swap. The only rail that sends a chain's own gas asset, so the only one that has to reserve gas before it spends. |
| `src/chain/evm.ts` | The one place an EVM transaction is signed and broadcast. Rails hand it calldata; they never broadcast. |
| `src/chain/near.ts` | The one place a NEAR transaction is signed and broadcast: borsh, ed25519, nonce and block hash, receipt-level failure detection. Also NEP-413 message signing. Separate from `evm.ts` because it is a different curve, serialization and transaction shape, not because of taste. |
| `src/hyperliquid.ts` | Hyperliquid candles: native `candleSnapshot`, one minute and above. |
| `src/market/` | The market data layer: the venue catalogue and symbol resolver, the candle cache the render path reads from, the folding that turns a venue-served interval into any timeframe, and the backward paging for deep history. |
| `src/candles.ts` | The candle service: caching, staleness marking, one interface over the source. |
| `src/audit.ts` | Append-only JSONL. One line per event, never rewritten by the app. |
| `src/store.ts` | Proposal persistence with subscribe/notify, re-created from disk on boot. |
| `src/view/mode.ts` | Reads and writes the persisted view mode (`state/view.json`). Every failure path returns `pro`, because pro shows more and a corrupt file must never be why a human sees less. |
| `src/view/basic.ts` | Pure `buildBasic()`. Every word on the basic screen is written here and nowhere else, so the two modes can be asserted to agree rather than assumed to. Refuses to state a balance it cannot back. |
| `src/greeting.ts` | The connect-time greeting and the index of everything an agent can do, carried into the model's context by the MCP handshake's `instructions`. The role arrives without anyone prompting for it. |
| `src/agents.ts` | Who is driving, and the rule that only one thing may: the seat, its heartbeat TTL, eviction and revocation. |
| `src/summon.ts` | Starts a fresh agent in a terminal window, wired to this app. The window could already stop an agent; this is how it starts one. |
| `src/rails/` | The rail registry: the one table that knows every rail exists. `swap` maps to one rail that dispatches on venue, so two venues can share a kind without pushing the pair into every call site. |
| `src/rails/mandate.ts` | The perps rail. Arming a mandate is the only way a position is opened, and it always waits for a human click because it grants standing authority rather than doing one thing. |
| `src/strategy/` | The grammar an agent may write and the runner will execute (`grammar.ts`), what the envelope caps (`envelope.ts`), the evaluator (`evaluate.ts`), the worked examples handed to the agent (`catalog.ts`) and the plain-English renderer. Anything not in the grammar cannot happen. |
| `src/runner/` | The only code in phosphor that places an order. No model runs in this process: it holds an agent-authored program and a human-approved envelope, and does what they say. |
| `src/hl/` | Hyperliquid: action signing, msgpack, the order format the venue accepts rather than rejects, info reads and liquidation maths. |
| `src/trade/` | The trading surface: raw venue state in, one payload out. Everything the browser draws on `/trade` is a view of that function's output. |
| `src/analysis/` | The measurements behind `chart_batch`: pivots, levels, regime, ATR, volume profile, VWAP, range, divergence, trend-line fitting. `index.ts` is a table of one line per op and must stay one. |
| `src/batch.ts` | Many operations, one round trip. The agent's latency is turns, not milliseconds, so a later entry can reference an earlier one by name. |
| `src/drawings.ts` | The objects that make the chart a shared coordinate system: the agent draws one, the human sees it, and a strategy program refers to it by id. |
| `src/history.ts` | Backward paging through candle history. The cursor is a timestamp rather than an offset, because the venue's endpoint is keyed that way. |
| `src/chart.ts` | Chart view state, the agent read model, and the ruler. Server-side, so the number the agent reads and the pixel the human sees come from one implementation. |
| `src/indicators.ts` | Indicator maths. Pure, index-aligned with the candles. |
| `ui/` | Three windows (`index.html` for pro and basic, `trade.html` for the trading surface), no framework, no build step. `approvals.js` renders the approval block identically on all three. |

`wallet.ts` and `composition.ts` look like duplicates and are not. The wallet answers "what do I
hold", so it includes natives and LP positions. Composition answers "what is my money made of, and
does that break a rule", so it counts only the assets the policy engine reasons about. Merging them
would mean one of the two answers is wrong.

The engine being pure is what makes the guarantees testable: every rule has a passing and a failing
case, and none of them need a running app to check.

## Data flow

    agent --MCP--> read tool ---> ledger / wallet / composition / audit ---> agent
                                  (no policy consulted: reads cannot cause harm)

    agent --MCP--> write tool --> build draft --> simulate every leg
                                                        |
                                                        v
                                                  policy engine
                                                        |
                        +-------------------------------+-------------------------------+
                        |                               |                               |
                     refuse                          allow                        needs_approval
                        |                               |                               |
                   log the rule                    execute now                   app window, red
                   that refused                    + log                                |
                        |                               |                        human clicks
                        v                               v                          /        \
                     agent                           agent                   approve       refuse
                   (with reason)                                                |             |
                                                                            execute       log only
                                                                            + log

The agent never appears to the right of the policy engine. It learns what happened by reading the
log or polling `proposal_status`, which is the same way a person would.

## The verdicts

Exactly three, defined in `src/policy/engine.ts`, with no fourth outcome: `refuse`, `needs_approval`,
`allow`. Every refusal carries a machine-readable rule name (`kill_switch`,
`destination_not_allowed`, `max_per_transaction`, `max_issuer_share`, and so on) plus human-readable
reasons, so the log says what stopped a thing rather than only that something was stopped.

The rule chain and the fail-closed positions in it are described in
[the security model](security-model.md).

## Networks

`Network` (`testnet` | `mainnet`) is an axis, not more chain ids. `ChainId` keeps meaning the chain
family (`eth`, `base`, `arb`, `sol`, `near`) and the network selects the RPCs, the token registry
and every contract address behind it.

Adding `arb-sepolia` style ids was the alternative and was rejected. It doubles every `ChainId`
switch in the engine, the ledger, the policy file and the UI, and the wallet's CHAIN column would
read `arb-sepolia` where a wallet should read `ARB`.

The network also decides whether the approval gate is switchable at all. On `mainnet` it is not, and
`src/policy/gate.ts` ignores the config flag rather than trusting it. See
[the security model](security-model.md) for what the switch does and does not turn off.

## Why NEAR Intents is the only rail

One rail, no bridges, 1 basis point, 25+ chains, 125+ assets, and a quote API that works without a
key for dry quotes (which is what makes the whole simulate-before-sign requirement cheap).

The alternative considered was per-chain bridges chosen per route. It was rejected on attack surface
rather than on price: every bridge added is another contract that can be drained, another set of
withdrawal semantics to get right, and another failure mode in the execution path. Supporting N
chains through bridges means trusting O(N) different systems; supporting them through intents means
trusting one. For an app whose entire pitch is that the dangerous path is narrow and auditable,
widening it by a factor of N to save a few basis points is the wrong trade.

The second reason is that it did not need revisiting later, and that has now been tested rather
than assumed. Perps on Hyperliquid were out of scope when this was written and are since built:
they arrived as another rail (`src/rails/mandate.ts`) on the other side of a rail decision already
made, and the execution path was not rebuilt to take them.

Consequence worth naming: intents settle asynchronously (request a quote, send to a deposit address,
poll for status). Execution is therefore a poll, not a return value, and the audit log is the record
of truth rather than the caller's stack.

## Failure modes

Every one of these fails toward showing less and moving nothing, never toward silence.

| Failure | Handling |
|---|---|
| Chain RPC down | Ledger marks that chain stale with a timestamp. Never silently shows zero. |
| Candle source down | Chart shows last good data with an explicit stale marker. Never blank. |
| Intents quote fails | Proposal returns refused with the solver error verbatim. No retry loop. |
| Simulation fails | Treated as refusal. A write that cannot be simulated is never allowed. |
| Agent disconnects mid-proposal | Proposal stays pending. It is the human's to approve or refuse. |
| Two agents connected at once | Both may read. Proposals are queued and each is approved separately. |
| Policy file corrupted | App refuses all writes and says so. Fails closed, never open. |
| Composition data missing for an asset | Asset shows as unclassified and counts toward the freezable cap until classified. Fails pessimistic. |

## Delivery

A local HTTP server plus the system browser, bound to 127.0.0.1 only. No packaging step, no bundler,
no build system on the critical path.

Tauri was weighed and deferred: it produces a real desktop window, but removing an entire build
system from the sprint was worth more than a native frame, and the approval surface is equally
unreachable by the agent either way. Tauri is post-sprint packaging, and it is also what closes the
one boundary the browser version cannot (see the security model).
