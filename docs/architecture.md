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
    | stdio MCP server          |   9 tools, every call becomes one POST
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
`/api/kill`, `/api/session`) are on the app process, they require a token minted per boot and handed
only to the browser, and the string `/api/approve` does not appear anywhere in `src/mcp.ts`. A test
asserts that, along with the absence of any tool named `approve`, `refuse`, `kill`, `dismiss` or
`execute`. The agent's process has no route to a decision and no credential to use if it found one.

Two agents can connect at once. Both may read. Proposals queue, and each is approved separately.

## Module map

| Module | Responsibility |
|---|---|
| `src/main.ts` | Wires everything and boots. Seeds a default policy only when the file is absent. |
| `src/config.ts` | Reads `config.json`, applies `ACC_PORT` / `ACC_MODE` / `ACC_DATA_DIR` overrides, creates the data dir. |
| `src/server.ts` | HTTP surface: the UI, the read APIs, `/api/mcp`, and the token-gated decision routes. |
| `src/mcp.ts` | The stdio MCP server. A proxy, nothing else. |
| `src/ledger/` | `evm.ts`, `solana.ts`, `near.ts` readers plus `demo.ts` fixtures, behind one interface in `index.ts`. Read-only by construction. |
| `src/composition.ts` | Classifies holdings against `data/risk-table.json`: issuer, freeze power, shares. |
| `src/cost.ts` | Fragmentation cost: four lines plus a total. |
| `src/policy/engine.ts` | Pure. Takes a draft and a context, returns one of three verdicts. No IO, no clock, no network. |
| `src/policy/file.ts` | Load, validate and save `state/policy.json`. Returns null on anything it cannot trust. |
| `src/policy/render.ts` | Policy to plain English. Pure and deterministic. |
| `src/proposals.ts` | Simulate, evaluate, persist, and execute after approval. The only path to execution. |
| `src/intents.ts` | NEAR Intents 1Click quotes, the synthetic quoter for demo mode, and the stub Signer. |
| `src/candles.ts` | Coinbase and Kraken candle sources behind one interface, with caching. |
| `src/audit.ts` | Append-only JSONL. One line per event, never rewritten by the app. |
| `src/store.ts` | Proposal persistence with subscribe/notify, re-created from disk on boot. |
| `ui/` | One page, seven regions, no framework, no build step. |

The engine being pure is what makes the guarantees testable: every rule has a passing and a failing
case, and none of them need a running app to check.

## Data flow

    agent --MCP--> read tool ---> ledger / composition / cost / audit ---> agent
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

Exactly three, defined in `src/policy/engine.ts`, with no fourth outcome and no override path:
`refuse`, `needs_approval`, `allow`. Every refusal carries a machine-readable rule name
(`kill_switch`, `destination_not_allowed`, `max_per_transaction`, `max_issuer_share`, and so on) plus
human-readable reasons, so the log says what stopped a thing rather than only that something was
stopped.

The rule chain and the fail-closed positions in it are described in
[the security model](security-model.md).

## Why NEAR Intents is the only rail

One rail, no bridges, 1 basis point, 25+ chains, 125+ assets, and a quote API that works without a
key for dry quotes (which is what makes the whole simulate-before-sign requirement cheap).

The alternative considered was per-chain bridges chosen per route. It was rejected on attack surface
rather than on price: every bridge added is another contract that can be drained, another set of
withdrawal semantics to get right, and another failure mode in the execution path. Supporting N
chains through bridges means trusting O(N) different systems; supporting them through intents means
trusting one. For an app whose entire pitch is that the dangerous path is narrow and auditable,
widening it by a factor of N to save a few basis points is the wrong trade.

The second reason is that it does not need revisiting later. Perps through the same rail into
Hyperliquid are out of scope here, but they are on the other side of a rail decision already made,
so scope can grow without the execution path being rebuilt.

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
