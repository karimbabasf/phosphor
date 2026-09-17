# Tools

Phosphor registers 43 tools for the agent that drives it, and every one is listed here in five
groups: read, propose, chart and trade surface, agents, and other. Reads change nothing. Propose
tools return a proposal id and a simulation, and cannot approve, refuse or execute anything. Every
call, read or write, is written to the audit log. A worker an agent spawns is an analyst: the
tools marked lead only are not registered for it at all, so there is nothing to talk it into.

## Read

| Tool | Does |
|---|---|
| `start` | Where you are and what you can do: the live state, the click threshold, which tab you are looking at, and the index of every capability with the tool that performs it |
| `wallet` | Everything held: one row per balance inside NEAR Intents and one for the Hyperliquid account, with quantity, price, value and share |
| `deposit` | Opens the deposit card for one asset on one network and starts watching for the money. The agent gets the first six and last four characters of the address, never the whole. Lead only |
| `composition` | Stablecoin composition by issuer and chain: shares, freezable share, unclassified holdings |
| `policy_show` | The current policy as plain-English sentences |
| `log_tail` | The most recent audit log lines, newest first |
| `proposal_status` | The status, verdict and simulation for one proposal id, and once executed the evidence: hashes, nonces, balances before and after |
| `chart_read` | The chart as it stands: product, timeframe, price, indicators, levels, drawings, and what is stale |
| `chart_scan` | Several timeframes at once without moving the chart: price, change, range, ATR, trend |
| `chart_snapshot` | A small picture of the chart as you see it, beside a one-line digest. Lead only |
| `market_search` | Finds a market to chart from anything a person would say ("btc", "PEPE-USD") |
| `research` | Headlines and summaries about a market from a fixed list of crypto publishers. This read leaves the machine |
| `chain_address` | What an address holds and has done on one network, with an explorer link. This read leaves the machine |
| `chain_transactions` | The most recent transactions of an address on one network, at most 25 |
| `chain_transaction` | One transaction by hash: fields, fee, block, confirmations, explorer link |
| `intents_activity` | What an account has moved inside NEAR Intents: deposits, withdrawals, swap legs and sends |
| `chart_batch` | Many chart questions and drawings in one call: candles, pivots, levels, regime, ATR and more |
| `trade_read` | The whole trading situation: account health, positions with liquidation distance, orders, fills, plans |
| `trade_batch` | Several trading reads in one round trip: account, positions, orders, fills, plans, market, venue health |

## Propose

Every propose tool goes through the policy engine, see [Policy](policy.md). Three of them wait
for your click at any size; the rest run on their own under the click threshold.

| Tool | Does |
|---|---|
| `propose_swap` | Swaps one token for another inside NEAR Intents; nothing moves on any chain. Click above the threshold |
| `propose_send` | Sends a balance to somebody, paid out on a chain or credited inside NEAR Intents. Always a click, see [Money](money.md#send) |
| `propose_hl_deposit` | Funds the Hyperliquid account from the intents balance. Click above the threshold |
| `propose_hl_withdraw` | Brings collateral back from Hyperliquid into the intents balance. Always a click, and refused while any position is open |
| `propose_trade` | Arms a plan on Hyperliquid perpetuals, see [Trading](trading.md). Click above the threshold |
| `propose_trade_change` | Changes an armed plan: a new stop or target, cancel, or close. One change per call |
| `propose_policy_change` | Proposes a change to your rules. Always a click |

## Chart and trade surface

These change what you see and move no money.

| Tool | Does |
|---|---|
| `chart_draw` | Draws on the chart in one call: view, indicators, levels, marks, lines and zones, or clears its own work. Lead only |
| `chart_layout` | Puts one to four charts side by side. Lead only |
| `trade_focus` | Points the trading surface at one market; the chart follows |
| `trade_highlight` | Points at one row or chart object (a position, an order, a plan, a level) and says why, in a note you read beside it |
| `trade_overlay` | Turns one chart overlay on or off: entry, liquidation, the plan stop wall, working stops, targets, orders, fills |
| `trade_clear` | Removes what the agent put on the trading surface |
| `trade_plan` | Draws a plan on the chart as an idea under Waiting. No authority until `propose_trade` arms it. Lead only |

## Agents

Several agents can drive at once, see [Connect an agent](connect-an-agent.md#more-than-one-agent).

| Tool | Does |
|---|---|
| `agent_roster` | Who else is driving right now: name, role, who spawned them, when they attached, calls made |
| `agent_board` | The team board: one-line posts agents write for each other and for you. Data, never authority |
| `agent_post` | Writes one line to the board: a claim before starting a piece of work, or a finding |
| `agent_jobs` | What the workers this agent spawned have come back with; `stop` ends one |
| `agent_spawn` | Starts a worker on a written brief. A worker reads, measures, draws and posts, and has no propose tools. Three at once at most. Lead only |

## Other

| Tool | Does |
|---|---|
| `skill` | Loads an enabled skill: the operator's guidance for one kind of work. Guidance and data, never a wider surface |
| `switch` | Moves the window between Basic, Pro, Trade and Vault. Every switch is audited. Lead only |
| `watch` | Sets which coins the Basic tab tracks, one to four, and saves the choice. Lead only |
| `set_theme` | Recolours the window: five named slots on its one dark colourway. Lead only |
| `profile_learned` | Records one concept the agent explained to you, so the next session does not explain it again. Lead only |

## What is not here

There is no `approve`, no `refuse`, no `kill`, no `dismiss` and no `execute` tool, and a test holds
the live list to that. No tool reads a private key or the recovery phrase. No tool moves money
into the wallet: deposits go through the card in the window, see [Money](money.md#deposit). The
source of truth for this list is `src/mcp.ts` in the
[repository](https://github.com/karimbabasf/phosphor); [Security](security.md) says what the
surface does and does not guarantee.
