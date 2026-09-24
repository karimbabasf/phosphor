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
    | stdio MCP server          |   48 tools, every call becomes one POST
    +---------------------------+
                 |
                 | HTTP POST /api/mcp  ->  127.0.0.1:4177   (carries the seat secret)
                 v
    +---------------------------+
    | src/main.ts               |   the authoritative state owner
    | app process               |   policy, ledger, proposals, audit, HTTP + UI
    +---------------------------+
                 ^                         ^
                 | /api/approve, /api/refuse, /api/kill  (token-gated)
                 |                         | spawned, watched, three secrets down its stdin
         the control window        +---------------------------+
         a human, clicking         | src-tauri/ (Rust)          |   the desktop shell: starts the
                                   | Phosphor.app               |   backend, injects the window
                                   +---------------------------+   token, opens the window, watches

Installed, the shell is a third process and deliberately a small one: it mints the window token,
the boot nonce and the seat secret, spawns the bundled Node backend with them on its stdin, waits
for the backend to answer with that nonce, opens one webview onto `http://127.0.0.1:4177` with the
token injected, and supervises the child for as long as the window is open. It holds no key and
makes no decision. `npm run app` runs the backend alone with no shell above it, and the system
browser stands in for the window.

The MCP process is deliberately thin. It has no database, writes no files, holds no keys, and
resolves exactly one thing on startup: which port the app is on. Every tool call is forwarded to
`/api/mcp` and the JSON reply is handed back verbatim. If the app is not running, every tool returns
"The control app is not running. Start it with: npm run app" rather than doing anything clever.

That thinness is the point. The routes that decide things (`/api/approve`, `/api/refuse`,
`/api/kill`, `/api/view`, `/api/unlock`) are on the app process, they require a token minted per
boot, and the string `/api/approve` does not appear anywhere in `src/mcp.ts`. A test asserts that,
along with the absence of any tool named `approve`, `refuse`, `kill`, `dismiss` or `execute`. The
agent's *MCP process* has no route to a decision and no credential to use if it found one.

That last sentence is narrower than it looks and the wording is deliberate. The separation is
between processes, not between the agent and the machine. No route serves the window token any
more (`GET /api/session`, which once did, answers 404), so a shell-capable agent cannot fetch it
either; what a local process running as you can still do is read the seat secret off the data
directory and then read and propose, never approve. The whole boundary is set out in
[the security model](security-model.md#the-honest-v1-boundary).

**A roster, capped at six.** Several MCP sessions drive this app at once, and any operator can ask
the app to spawn workers of its own (`src/crew.ts`). A session leaves by shutting down, or by going
quiet for longer than two and a half heartbeats. `src/agents.ts` owns the roster. Proposals still
queue, and each is approved separately.

This was one seat until 2026-08-21, and the old rule was written for a real failure: two agents
driving one wallet looked exactly like one agent, and neither knew about the other. The roster
fixes that failure from the other side rather than pretending it went away. Every member is named,
every object drawn on the chart carries the session that drew it (`Provenance` in `src/chart.ts`),
and `agent_roster` and the board in `src/board.ts` are how they see each other. Two agents are no
longer indistinguishable from one, so they no longer have to be forbidden.

**Roles, and why the money path did not widen with the door.** A member is an `operator` or an
`analyst`. Everything Phosphor spawns is an analyst, and `src/mcp.ts` does not REGISTER the
propose tools, `agent_spawn` or the window controls when `PHOSPHOR_ROLE` says so. The capability is
absent from that process rather than refused inside it, which is the same property the tool
lockdown in `src/driver.ts` is built on and is stronger than a check: a worker is a model whose
brief was written by another model, and nothing in that chain is a human.
`tests/injection.test.ts` starts a real analyst server and reads its surface back.

## Module map

| Module | Responsibility |
|---|---|
| `src/main.ts` | Wires everything and boots. Seeds a default policy only when the file is absent. |
| `src/config.ts` | Merges `config.local.json` over `config.json`, applies the `PHOSPHOR_*` env overrides, resolves `keysPath` and asserts it sits outside the repo, creates the data dir. |
| `src/server.ts` | The composition root: builds the context and hands it to `src/http/`, which is the surface itself: the UI, the read APIs, `/api/mcp`, the log tail, and the token-gated decision routes. |
| `src/mcp.ts` | The stdio MCP server. A proxy, nothing else. |
| `src/ledger/` | `intents.ts` reads the NEAR Intents verifier, `hyperliquid.ts` reads the trading account, `demo.ts` holds the fixtures, and `index.ts` is the one interface over them. Read-only by construction. Live mode reads TWO places, the verifier and the venue, and nothing on any chain. |
| `src/wallet.ts` | The wallet view: one row per balance inside NEAR Intents and one for the Hyperliquid account, with quantity, unit price, USD value and share. ETH and SOL included. |
| `src/composition.ts` | Classifies the issued coins the two pockets hold against `data/risk-table.json`: issuer, freeze power, shares. ETH, SOL, NEAR and BTC have no issuer and are left out, because composition rules are about stablecoin issuer concentration. |
| `src/policy/engine.ts` | Pure. Takes a draft and a context, returns one of three verdicts. No IO, no clock, no network. |
| `src/policy/file.ts` | Load, validate and save `state/policy.json`. Returns null on anything it cannot trust. |
| `src/policy/render.ts` | Policy to plain English. Pure and deterministic. |
| `src/proposals.ts` | Simulate, evaluate, persist, and execute after approval. The only path to execution. |
| `src/intents.ts` | The NEAR Intents 1Click client (quotes, status, the token list) and asset id resolution (registry first, then the native-asset table). |
| `src/rails/` | The rails: the swap inside `intents.near` (`intents-native.ts`), the send to another intents account (`intents-send.ts`), the Hyperliquid deposit and withdrawal (`hypercore-*.ts`), and the POA deposit address (`intents-address.ts`). Every rail reads its own account from the key, never from a caller. |
| `src/chain/evm.ts` | The EVM chains this app can read and name: a public RPC per chain for read-only lookups and the explorer prefixes a receipt links to. Nothing here signs: the EVM key signs intents and Hyperliquid actions, never a chain transaction. |
| `src/chain/near.ts` | The NEAR RPC the verifier is read through, base58 for the keystore and the 1Click quote signature, and the account id rules a send checks. Nothing here signs. |
| `src/market/` | The market data layer: the venue catalogue and symbol resolver, the candle cache the render path reads from, the folding that turns a venue-served interval into any timeframe, and the one ATR the trade payload reads. |
| `src/audit.ts` | Append-only JSONL. One line per event, never rewritten by the app. |
| `src/store.ts` | Proposal persistence with subscribe/notify, re-created from disk on boot. |
| `src/view/mode.ts` | Reads and writes the persisted view mode (`state/view.json`). Every failure path returns `pro`, because pro shows more and a corrupt file must never be why a human sees less. |
| `src/view/basic.ts` | Pure `buildBasic()`. Every word on the basic screen is written here and nowhere else, so the two modes can be asserted to agree rather than assumed to. Refuses to state a balance it cannot back. |
| `src/greeting.ts` | The connect-time greeting and the index of everything an agent can do, carried into the model's context by the MCP handshake's `instructions`. The role arrives without anyone prompting for it. |
| `src/agents.ts` | Who is driving, plural: the roster, each member's role and heartbeat TTL, the lead, eviction and revocation. |
| `src/board.ts` | The noticeboard agents write one line each to, so a team is not three strangers sharing a screen. Everything on it is data: nothing reads a post as an instruction. |
| `src/duplicates.ts` | The money-path half of removing the one-agent rule: an identical proposal from a second session inside ninety seconds is refused with the id of the one that already exists. Two proposals under the click threshold both execute, and only the pair is wrong. |
| `src/crew.ts` | Workers. The app spawns them through the same locked-down driver path, with the analyst role, one brief, a deadline and a cap of three. Handing the driver's child an `Agent` tool was rejected: a sub-agent spawned inside the child announces nothing back to this app. |
| `src/presets.ts` | Named study packages, and the tidy that runs before one is applied, so a package can never be refused by the pane cap. |
| `src/indicators-kit.ts` | The series maths both indicator catalogues are built from. One EMA in the app, so the number the agent reads and the pixel the human sees cannot disagree. |
| `src/indicators-library.ts` | The second catalogue: the wave family, SuperTrend, Keltner, the squeeze, Ichimoku, ADX and the rest. Written from published formulas; no vendored code and no third-party dependency. |
| `src/analysis/structure.ts` | Structure as boxes and events rather than series: order blocks, fair value gaps, liquidity shelves, and the bar that closed through a swing. Measurements, never a place to trade. |
| `src/rails/` | The rail registry: the one table that knows every rail exists. `swap` maps to one rail that dispatches on venue, so two venues can share a kind without pushing the pair into every call site. |
| `src/trade/rail.ts` | The perps rail behind `propose_trade`: a plan is judged on the collateral it puts at stake, and arming it is the only way a position is opened. |
| `src/runner/` | The only code in phosphor that places an order. No model runs in this process: it holds the plans a human approved, watches their conditions, and does what they say. |
| `src/hl/` | Hyperliquid: action signing, msgpack, the order format the venue accepts rather than rejects, info reads and liquidation maths. |
| `src/trade/` | The trading surface: raw venue state in, one payload out. Everything the trade screen draws is a view of that function's output. |
| `src/analysis/` | The measurements behind `chart_batch`: pivots, levels, regime, ATR, volume profile, VWAP, range, divergence, trend-line fitting. `index.ts` is a table of one line per op and must stay one. |
| `src/batch.ts` | Many operations, one round trip. The agent's latency is turns, not milliseconds, so a later entry can reference an earlier one by name. |
| `src/drawings.ts` | The objects that make the chart a shared coordinate system: the agent draws one, the human sees it, and a strategy program refers to it by id. |
| `src/chart.ts` | Chart view state and the agent read model, compact and full. Server-side, so the number the agent reads and the pixel the human sees come from one implementation. |
| `src/charts.ts` | Up to four charts side by side, each a chart store beside a drawing store. Slot 0 is the primary and keeps its old names on the context. |
| `src/snapshot.ts` | The picture broker behind `chart_snapshot`: one outstanding ask per chart, a TTL, and nothing stored. |
| `src/indicators.ts` | Indicator maths. Pure, index-aligned with the candles. |
| `ui/` | One window (`index.html`) with the basic, pro, trade and vault screens inside it, no framework, no build step. The chat (`screens/agent.js`) sits beside every screen, each move is one card in it (`screens/cards.js`), and `screens/decision.js` draws the part of that card that asks: Cancel and Approve. |

`wallet.ts` and `composition.ts` look like duplicates and are not. The wallet answers "what do I
hold", so it includes natives, the intents balance and the trading account. Composition answers "what is my money made of, and
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
                   log the rule                    execute now                   card in the chat
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

## Where money lives

Two pockets, and nothing on a chain:

- **The NEAR Intents balance.** Entries on the `intents.near` verifier's own ledger, credited to
  the account the EVM key derives (the address, lowercased). Money arrives through the POA bridge
  address the deposit card shows (`src/rails/intents-address.ts`), a swap changes what the
  balance holds without leaving it (`src/rails/intents-native.ts`), and a send moves some of it
  to another intents account (`src/rails/intents-send.ts`).
- **The Hyperliquid collateral.** USDC on the venue's own books, in the account the same EVM
  address signs for, funded from the intents balance (`src/rails/hypercore-deposit.ts`) and
  returned to it (`src/rails/hypercore-withdraw.ts`).

`ChainId` (`eth`, `base`, `arb`, `sol`, `near`) survives as the home chain of an asset, which is
how the 1Click token list names one: "USDC from eth" and "USDC from arb" are two ids. It is never
a place this app holds funds or signs a transaction. The chain wallets, the per-chain balance
reads, the gas floors and the chain signers all went on 2026-09-16; rows they wrote still render
as history. Every RPC endpoint and contract account in the repo names the live network, and no
config field, environment variable or type points them anywhere else.

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
they arrived as another rail (`src/trade/rail.ts`, placed by `src/runner/`) on the other side of a
rail decision already made, and the execution path was not rebuilt to take them.

Consequence worth naming: intents settle asynchronously (request a quote, send to a deposit address,
poll for status). Execution is therefore a poll, not a return value, and the audit log is the record
of truth rather than the caller's stack.

## Failure modes

Every one of these fails toward showing less and moving nothing, never toward silence.

| Failure | Handling |
|---|---|
| Verifier or venue read down | Ledger keeps the last good rows and marks that pocket stale. Never silently shows zero. |
| Candle source down | Chart shows last good data with an explicit stale marker. Never blank. |
| Intents quote fails | Proposal returns refused with the solver error verbatim. No retry loop. |
| Simulation fails | Treated as refusal. A write that cannot be simulated is never allowed. |
| Agent disconnects mid-proposal | Proposal stays pending. It is the human's to approve or refuse. |
| Two agents connected at once | Both may read. Proposals are queued and each is approved separately. |
| Policy file corrupted | App refuses all writes and says so. Fails closed, never open. |
| Composition data missing for an asset | Asset shows as unclassified and counts toward the freezable cap until classified. Fails pessimistic. |
| A move the venue has not credited after eight times its usual length | The row reads "Late, nothing has changed" (`stalled`) and keeps being re-judged; it settles forward on a late credit. Never failed on a timeout alone. |
| The backend dies under an open window | The shell sees the child exit within two seconds, respawns it once after a three second backoff, and says so; a second death stops the app with a sentence rather than a crash loop. The window polls `/api/health` while its event stream is down and says the app is not answering. |

## Delivery

A Tauri 2 shell (`src-tauri/`, Rust) around the same backend `npm run app` runs. The bundle ships
Node inside it, so an installed copy needs nothing else; the backend is not compiled or rewritten,
it runs the same TypeScript from the payload the bundle carries. The shell is what closes the one
boundary a browser window cannot: the window token reaches the control webview by an
initialization script and is served by no route, so the approval surface has no path a local
caller can fetch a credential from (see the security model). The backend still binds `127.0.0.1`
only, and the source checkout still runs with the system browser standing in for the window.

Releases are built by CI from a version tag (`.github/workflows/release.yml`): the DMG, the updater
bundle and its signature, `latest.json` and `SHA256SUMS`. Installed copies check that manifest
and offer a signed update in the app's own window (`src-tauri/frontend/update.html`); the updater
verifies the bundle's signature, and the version it compares is read out of the signed bundle, not
the manifest. The build is ad hoc signed and not notarized yet, so a first open goes through
Gatekeeper's Open Anyway; [Known limits](known-limits.md) lists that beside the rest.
