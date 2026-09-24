# Phosphor reference

The long form of what the README says in short: the tool surface, how a proposal is decided, policy as sentences, the first run, mode and config, keys and signing, the code layout and the operator profile. Everything here describes the code as it is; where it names a count (tools, tests), re-check the number before quoting it.

## The tool surface

Forty-eight tools, in six families. Read tools execute directly and cannot move anything. Write
tools never execute: they return a proposal id and a simulation result, and nothing else. Chart
and trading tools move a view or a marker, never funds. Team tools coordinate several agents.
Display tools move the window. The tables below are the whole surface, and
`tests/tool-surface.ts` is the one list both the injection suite and the e2e run hold it to.

An agent that connects is handed all of this at once. `start` returns the greeting, the live
state and an index of every tool grouped by what a person would actually ask for, so an agent
never has to ask a human how to operate the app. The role rides in the MCP handshake itself, in
the server's `instructions`, so it arrives without anyone prompting for it. The window's own chat
agent is the exception: it is spawned with `PHOSPHOR_SURFACE=chat`, its persona is its system
prompt, and `src/mcp.ts` does not register `start`, `composition`, `log_tail`, `set_theme`,
`profile_learned` or the five team tools for it (`CHAT_WITHHELD` in `src/persona.ts`).

**Which screen the window is on rides on every answer.** The human moves the window with the tabs
and the agent with `switch`, and both are written to the server (`POST /api/view` with the window
token for the tab, the `set_view_mode` op for the tool), so `screen` in `start` and in `switch` is
the record `{ view, since, by }` with `by` naming who moved it. Every other JSON answer carries
`screen: { view }` as its last key, read as the answer is written, and the digest beside a chart
picture carries a `screen: <view>` line, so an agent never has to spend a call to learn where the
human is looking, and never describes a screen the human left.

**A team, not a seat.** Up to six agents drive this app at once, and any of them can spawn
workers of its own. Each is named on a roster, each thing it draws carries its id, and they
coordinate on a shared board they all read. A session leaves by shutting down, or by going quiet
for longer than two and a half heartbeats.

This used to be one agent at a time, and the reason it could change is worth stating: the old
rule existed because two agents driving one wallet looked exactly like one agent, and neither of
them knew about the other. They are told apart now, so they no longer have to be forbidden.
What replaced exclusivity on the money path is narrower and structural. An agent holds a ROLE.
An operator can propose; an ANALYST cannot, and the propose tools are not registered for its
process at all, so there is nothing to talk it into. Every worker Phosphor spawns is an analyst.
It can read every market, measure every chart and draw on it, and it has no path to the wallet.

The other thing the seat used to prevent is prevented directly: an identical proposal from a
second agent inside ninety seconds is refused with the id of the one already in flight. Two
proposals below the click threshold would both execute and each would be individually correct,
so only the pair is wrong and nothing else in the stack would have caught it.

**The chart keeps its markings.** Levels, marks, lines and zones are anchored to one instrument
and kept per market: switching product leaves them where they were, and every study, marking,
chart and layout is written to `<dataDir>/chart-markings.json` (`src/markings.ts`) and comes back
after a quit, until a person or an agent clears it. A human's own drawings are never swept by
anything an agent does. Every `chart_read` carries a `housekeeping` block counting what is the
reading agent's, what is another agent's and what is stale, and `chart_draw clear: 'mine'` takes
only the reading agent's own; `everywhere: true` reaches every market.

**Custom indicators.** Drop a file in `<dataDir>/indicators/` and the chart can draw it as
`custom:<name>`, where the name is the filename without its extension (lower-case letters,
digits and dashes, up to 32). Two formats. A JSON file is `{ title, overlay, inputs, plots,
hlines }`, each plot an expression tree of `[op, ...args]` over `open high low close volume
hl2 hlc3 ohlc4 bar_index`, with the ops `sma ema rma wma rsi atr stdev highest lowest change
tr crossover crossunder hist recur abs max min sqrt log nz na` and the arithmetic, comparison
and logic operators; `["recur", init, step]` is a running value whose step may read `prev`.
A Pine v5 script is translated onto the same tree: `indicator`, `input.*`, assignments, `var`
and `:=`, `if` blocks that assign, the ternary, `[n]` history, the `ta.*` and `math.*`
functions above, `plot` and `hline`. `plotshape`, `fill`, `bgcolor`, `barcolor` and the alerts
are dropped with a note; a loop, `request.*`, `array`, `label`, `line`, `table`, a function
definition or any other call is refused with its line number. The folder is read at boot and
again whenever the agent lists indicators, re-parsing only the files that changed. Every file
is bounded: 256 KB, 400 nodes, 16 levels deep, 6 plots, 500 bars of history or period, and two
million evaluations per compute, past which the indicator draws nothing and says so in its
state line. Nothing in a file runs as code: the tree is data walked by one evaluator, and a
custom SMA, EMA, RSI or ATR equals the built-in to the last digit.

| Read tool | Returns |
|---|---|
| `start` | The greeting, the live state and the index of everything this door opens onto, grouped by intent. `screen` is `{ view, since, by }`: which screen the window is on, since when, and whether a human tab or an agent `switch` put it there. Call it again after a long gap: the network, the wallet and the pending decisions all move |
| `wallet` | Everything held, one row per balance in the two pockets (the NEAR Intents balance and the Hyperliquid collateral): place, quantity, price, value, share. Only what is actually held; how many pockets came back empty is reported as a count |
| `composition` | Shares by issuer and pocket, freezable share, unclassified holdings |
| `policy_show` | Current policy as plain-English sentences, or a notice that the file is unreadable |
| `log_tail` | Most recent audit lines, newest first |
| `proposal_status` | Where one money move is right now, as the one object the card draws (`src/proposals/view.ts`): the stage and its label, what is being waited on, seconds elapsed and since the last change, the typical duration, the amounts and both pockets, every transaction hash with its leg, and an error code with a sentence |
| `proposals` | Recent money moves, newest first, each the same object; `kind` filters, `limit` up to 50. Lead only |
| `diagnose` | One money move in full: its view, its own audit lines, and what the router and the venue say about it. Lead only |
| `research` | Crypto news. The APP fetches headlines and summaries from four fixed crypto newsrooms and hands back text; the agent never gets a URL it can point anywhere. Anything else is the chat agent's own web search and page reading, which are not Phosphor tools and mark its session (`src/web-read.ts`: every move it proposes after one waits for a click) |
| `chain_address` | What an address holds and has done on one network (`ethereum`, `base`, `arbitrum`, `solana`, `near`, `bitcoin`): native balance, transaction count, contract or not (an EIP-7702 delegation reads as an account), last activity where the chain exposes it, up to ten token balances, an explorer link. The address has to pass its network's shape first; a wrong EIP-55 checksum is refused, not repaired. See "Chain lookups" below |
| `chain_transactions` | The most recent transactions of an address on one network, newest first, at most 25: hash, time, from, to, value, status, method name. Raw inputs never come back |
| `chain_transaction` | One transaction by hash: the same fields plus fee, block and confirmations |
| `intents_activity` | What an account has moved inside NEAR Intents, from NearBlocks: `MINT` rows are deposits in, `BURN` rows withdrawals out, `TRANSFER` rows swap legs and sends, each with token, signed amount and hash. No account means this app's own, and `own` says which. When NearBlocks is down it falls back to the verifier's own views and answers balances only, marked `partial: true` |
| `swap_assets` | What can be swapped inside the balance, coins held first: symbol, name, network, `assetId`, decimals, price, the exact amount held, and `liquidity` (yes, no or unknown: whether anyone offers a price now). `query` narrows it. Files nothing (`src/http/read/swap.ts`) |
| `swap_quote` | What a swap would get right now: amount in, expected amount out, the minimum, the fee in dollars and the time it takes. `chain` and `toChain` only when a network was named; otherwise the app picks each coin, the one held first. `sentence` says why when there is no quote, and `candidates` means a name fits several coins. Files nothing |
| `swap_check` | One swap's truth read again: what the swap service says, whether the coin left the balance, whether it came back, and what is held now; `moved` is yes, no or unknown and `summary` is one plain line. Moves nothing. Lead only |

| Write tool | Does |
|---|---|
| `propose_swap` | Swaps one token for another inside `intents.near`, over the balance the app already holds there: one signed intent, nothing moves on any chain. `chain` and `toChain` name each asset's home chain, never a place money goes, and are passed only when a network was named. `amountIn` is `"all"` (the balance to the last base unit) or an exact decimal string; the app asks for one quote per proposal and sets `minAmountOut` one percent under it unless the agent names one |
| `propose_policy_change` | Proposes a patch to the policy rules. Always waits for a human click |
| `propose_trade` | Arms a plan on Hyperliquid perpetuals, whole or by the id of one drawn with `trade_plan`. Priced at the collateral it puts at stake: the click threshold is the only wall |
| `propose_trade_change` | Changes an armed plan: a new stop or target, cancel, or close. A change that only takes risk off lands without the wall; one that widens is priced like a new plan |
| `propose_hl_deposit` | Funds the Hyperliquid perpetuals account from the intents balance: one signed intent, nothing sent on any chain. The account credited is derived from the app's own key |
| `propose_hl_withdraw` | Brings collateral back from Hyperliquid into the intents balance. One field, the amount; the intents account credited is the app's own. Always waits for a human click and is refused while any position is open |
| `propose_send` | Sends a balance held inside `intents.near` to somebody else: the one tool with a destination field. `where` is required and has no default: a network id (`ethereum`, `base`, `arbitrum`, `solana`, `near`) pays it out on that real chain through 1Click's bridge (an `intents_pay` draft); `intents` credits another NEAR Intents account (an `intents_send` draft). `to` is decoded for that place (EIP-55 on an EVM chain, base58 on Solana, an account id on NEAR) and a typo is refused before any quote; the app reads the address's public activity and the card says whether it has ever been used. `confirmed` is the literal `true`, allowed only after the agent read the amount, token, full address and landing place back to the human and got a yes. No allowlist: every send waits for the human click and, on an enclave wallet, a Touch ID that names the receiver, whatever the size. A chain payout pays the bridge's flat fee and is refused with the fee named when the fee eats more than 3 percent |

This door now names exactly the set the app can execute. `propose_lp_add`, `propose_lp_remove`,
`propose_yield_deposit`, `propose_yield_withdraw`, `yield_read` and `yield_auto` were on it or
behind it at various points; the rails under all six were removed when the app cut to two venues.
`propose_consolidate`, `propose_intents_deposit`, `propose_intents_withdraw`, the `oneclick`
swap venue, `balances` and `gas_report` went on 2026-09-16 with the chain wallets: nothing is
held on a chain any more, so there is nothing to gather, deposit from, withdraw to, or pay gas
for. Rows those tools wrote still render as history.

`propose_hl_deposit` was on that list until 2026-08-20 and is back because the rail underneath it
changed shape rather than because it was tested more. It used to transfer USDC to Hyperliquid's
Bridge2 contract on Arbitrum; since 2026-09-11 it spends the balance already held inside
`intents.near` through one signed intent. `propose_hl_withdraw` is the way back: 1Click mints a
fresh HyperCore address for the quote, the app signs one `spotSend` to it with its master key, and
the money lands in the app's own intents balance. That tool has no destination field, always waits
for a click whatever the size, and is refused while any position is open. Money moves wallet to
intents to Hyperliquid and back along that one line, and nothing crosses a bridge.

| Chart tool | Does |
|---|---|
| `chart_read` | The chart as it stands, compact by default: last price and the change over the window, seconds until this bar closes, every indicator's last values and state line, the levels, marks, lines and zones with where each sits against the price, the geometry and the housekeeping block. About a kilobyte. `full: true` is the long form; `chart: n` reads a comparison chart |
| `chart_scan` | Several timeframes at once, fetched together, without moving the chart: last, change, range, ATR, trend, time to close |
| `chart_batch` | The instrument: candles, pivots, levels, regime, ATR, volume profile, VWAP, range, divergence, indicator_read, indicator_list (custom indicators included, after a rescan of their folder), the structure ops, trend-line fit, value at a time and touches, and draw. Many questions in one call, and a later entry can reference an earlier one by name. Ops that return a series answer with their newest twenty entries; `tail` or `full: true` change that |
| `chart_draw` | The one write: the whole markup in one call, applied in order. `clear` (mine, agent, all), `view` (product, timeframe, bars, venue), `indicators` (a preset, or set, add and remove, `custom:<slug>` included), `levels`, `marks`, `lines` (sloped, through two anchors), `zones`. Answers with a digest of the chart and a `refused` list, one line per entry that did not land; one bad entry never fails the rest. Never touches a plan drawn on the chart |
| `chart_snapshot` | A picture of one chart as the human sees it. The window renders scene and hud to a JPEG at most 1024 px wide and posts it back under the same guard as every window write; the image goes to the one call waiting for it and is never stored. If no window is open, it is not on the trade screen, or it does not answer within 3 s, the digest alone comes back and says which |
| `chart_layout` | One to four charts side by side. The first is the primary, the full chart the human interacts with; the rest are comparison charts on their own stores, which `chart_draw`, `chart_read` and `chart_snapshot` reach with `chart: 1`, `2` or `3` |
| `market_search` | Finds a market by name. Takes "btc", "bitcoin", "wif" or "PEPE-USD" and returns the product id to open, plus near matches when the query is ambiguous |

`chart_draw`, `chart_layout` and `chart_snapshot` are the lead's and are not registered for a
worker: a worker measures and reports, it does not redraw the chart the human is looking at.
Sloped objects live in one store, `src/drawings.ts`, and the window draws them; the chart store
holds the view, the indicators, the levels and the marks.

| Trading tool | Does |
|---|---|
| `trade_read` | The book as it stands: account health, positions with liquidation distance, working orders, recent fills, every plan with its state, and for a waiting plan which conditions hold |
| `trade_batch` | Account, positions, orders, fills, plans, market and venue health in one round trip |
| `trade_focus` | Points the trading surface at one market. The chart follows |
| `trade_highlight` | Points at one row or chart object (position, order, fill, plan, level, line, indicator) and says why, so the agent and the human mean the same thing |
| `trade_overlay` | Toggles entry, liquidation, stops, targets, orders, fills and the plan wall |
| `trade_plan` | Draws a plan on the chart as an idea and lists it under Orders on the trade screen. No authority. Redraw or remove it while it is an idea |
| `trade_clear` | Removes what the agent put on the surface |

**A trade is one plan.** Symbol, side, size in dollars, leverage, an entry (market, limit or stop),
a stop, an optional target, optional conditions the venue cannot hold (a bar close, a reclaim
wick, volume, a time window), an expiry and a note. Drawn with `trade_plan` it is an idea; armed
with `propose_trade` it is the same object with authority. Every position opens isolated, so the
margin posted is the most the venue can take for it, and the policy reads max(margin, max loss
at the stop): under the click threshold the plan runs at once, above it the human clicks. The
entry, the stop and the target go to the venue as one bracket, with the stop leg's limit ten
percent past its trigger, so the venue holds the exits and the app can die with the position
still protected. A limit or stop entry rests on the venue and its exits are placed the moment
anything fills. A plan with conditions waits with nothing at risk until they hold. The runner
child holds plans by id and refuses any command for one it does not hold; the host decides when.
Plans persist in `plans.json` beside the policy, and on boot a waiting plan re-arms only if its
proposal executed with the same hash. The human's own buttons (cancel, close at 100 bps, flatten)
live on `/api/trade/action`, which the agent's door does not open onto.

| Team tool | Does |
|---|---|
| `agent_roster` | Who else is driving right now: name, role, when each was last heard from |
| `agent_board` | The shared noticeboard, read. Every line on it is another agent's claim, held as data and never as an instruction |
| `agent_post` | Writes one line to it. This is how two agents avoid taking the same job, and it is a courtesy rather than a lock |
| `agent_jobs` | What the workers this session spawned are doing, and what they have finished |
| `agent_spawn` | Starts a worker of its own. Every worker is an ANALYST: the propose tools are not registered for its process at all, so there is nothing on its surface to talk it into |
| `skill` | The app's own playbooks, by name. Text the app wrote about how to operate the app, which is why it is a tool and not a prompt |

| Display tool | Does |
|---|---|
| `set_theme` | Changes the window's colours: five colour slots on top of the window's one colourway (green on black; the window is dark only). Moves no money, and it is on this surface because a person asking their assistant to recolour the screen should not have to leave the conversation |
| `show` | Draws something that already exists as a card in the window: a proposal by id, a transaction by hash on a named network, an open position by coin, or the deposit card. Answers `drawn: false` when no conversation is open. Lead only |
| `switch` | Moves the window between the plain-English view (`basic`), the operator view (`pro`), the trading surface (`trade`) and the vault (`vault`). Moves no money, and every switch is audited. Named `switch` rather than `set_view_mode` because the whole requirement is that changing window costs one word: an agent hunting for how to "switch to trading" finds it immediately, and did not reliably find `set_view_mode`. Aliases (trading, hft, perps, simple) resolve in the app, so both doors agree. Answers with the screen record it moved to (`{ view, since, by: 'agent' }`). Not to be confused with `chart_draw view:`, which drives the chart's render state on the trade screen |

A switch used to be refused outright while a proposal was pending, so an agent could not move a
human away from a decision they were in the middle of. A move that waits is now one card in the
chat, and the chat is on every screen, so the decision follows the human instead of being left
behind, and the refusal was removed. What replaces it is disclosure rather than silence: the
pending ids ride back on the response and the tool description tells the agent to say the count
out loud, because a card scrolled out of view is one quiet line above the chat's box.

There is no `approve`, no `refuse`, no `kill`, no `dismiss` and no `execute` tool. `switch` changes what a human sees and nothing about what may move; `docs/security-model.md` says exactly what that does and does not buy. There is also no
argument anywhere in the surface that names a recipient or destination, so an agent that has been
talked into sending money to an attacker has no field in which to say where. Both properties are
asserted by tests, not just by convention.

The chart tools do not touch money and do not go near the approval gate, but they are audited like
every other call, because an agent that can change what the human sees while that human decides on
a transfer is a surface. Three things hold it: everything an agent draws is labelled `[agent]` by
the server after the label the agent supplied, agent lines are dotted where a human's are dashed,
and the chart bar carries a count with a one-click clear. An agent can never alter a candle, and a
price line it draws is excluded from the automatic price fit, so one absurd level cannot flatten
the chart into a hairline.

## Chain lookups

`chain_address`, `chain_transactions`, `chain_transaction` and `intents_activity` read public
chain data, and they are the reads besides `research` whose answers come from off this machine.
The module is `src/chainscan/`, and it is the only place the backend builds a chain-explorer
URL. The agent supplies a network from a closed enum and an address or a hash, never a URL.
The address or hash has to pass its network's shape before a URL exists (EIP-55 checked when
mixed case, base58 decoded to 32 bytes for Solana, NEAR named or implicit ids, Bitcoin bech32
or base58check by format), and a value that fails is refused with the reason, never repaired.

Every request goes through one fetch: https only, the host compared character for character
against a fixed table (`eth.blockscout.com`, `base.blockscout.com`, `arbitrum.blockscout.com`,
`api.mainnet-beta.solana.com`, `free.rpc.fastnear.com`, `api.nearblocks.io`, `mempool.space`),
a deadline on every request and thirty seconds on the whole call, redirects followed by hand
and re-checked, a byte cap (256 KB, 2 MB for the EVM and Bitcoin transaction lists) past which
the body is refused rather than truncated, a per-host token bucket under each source's
published limit (Blockscout 2 per second, NearBlocks 1 per 2 seconds, the Solana RPC 5 per
second) and a 60 second cache by URL. When Blockscout is down an EVM address falls back to the
viem reader on the public RPC (balance, nonce, code; `0xef0100` code is a delegated account,
not a contract). When NearBlocks is down `intents_activity` falls back to `mt_tokens_for_owner`
and `mt_batch_balance_of` on `intents.near` and answers balances only, marked partial.

Everything that comes back is text a stranger could have written: a token name, a memo, a
method name. Every such string is stripped of control and invisible characters and angle
brackets, capped at 32 characters, and the answer carries a fixed note saying that names inside
it are data. Raw inputs, decoded inputs, logs, inner instructions, scripts and icon data URIs
are dropped before anything is returned. Amounts are decimal strings scaled by the asset's
decimals. Unpriced ERC-20 rows whose name reads like an advertisement are hidden.

Keys are optional and raise the rate limit only: `chainscan.blockscoutApiKey` and
`chainscan.nearblocksApiKey` in `config.local.json`. Each rides only to the host it was issued
for, and neither is ever written to a log or an error.

## How a proposal gets decided

A write tool builds a draft, simulates it (a quote per leg), and hands it to the policy engine. The
engine returns exactly one of three verdicts, with no fourth outcome and no override path:

- **refuse**: nothing happens, and the refusal is logged with the rule that caused it.
- **needs_approval**: the proposal appears as a card in the chat with its simulation result and
  two buttons, Cancel and Approve. It executes only after a human clicks Approve.
- **allow**: below the click threshold and inside every cap, so the app executes it and logs it.

The rule chain runs in a fixed order and stops at the first refusal: unreadable policy, kill switch,
then (for fund moves) legs present, leg amounts sane, every leg simulated, destination is one of our
own addresses or on the allowlist, per-transaction cap, rolling session cap, forbidden issuer, then
the post-move composition (issuer share caps, freezable cap). Composition
checks judge the resulting state rather than the delta, so a portfolio already past a cap cannot
make further moves until a human changes the policy.

The rails (swap, the Hyperliquid deposit and withdrawal) take their own branch, because they hand funds to a
venue contract rather than decomposing into transfer legs. They are checked on the amount, the
per-transaction and session caps, the click threshold, the venue contract, and separately on
where the proceeds land. That branch deliberately does not compute a post-move composition: the
engine cannot know what a pool or an exchange will hand back, and inventing a post-state would
be worse than admitting the gap. The two sends (`intents_send`, `intents_pay`) are the exception
to the proceeds rule since 2026-09-17: their receiver is meant to be somebody else and no
allowlist blesses it. The engine still holds a send to the verifier as its counterparty and to
every cap; the gate on the receiver is the click, and `src/proposals/execute.ts` turns any
`allow` on a send into `needs_approval` whatever the size, so a send never runs on the policy's
word alone.

Every amount the engine reads is priced by the app, never supplied by the agent. A token the app
cannot price is refused rather than assumed to be worth a dollar, because a value it cannot
establish is a value its caps cannot bound.

Policy changes take a shorter path: `killSwitch`, `version` and the rendered sentences are not
patchable at all; any other patch is schema-checked, held under the ceiling ($1,000,000 per
transaction, $10,000,000 per day or session), refused when it would leave the ask threshold at
or above the transaction cap (`never_asks`), refused when it drops a destination, a forbidden
issuer or an issuer cap, and refused when its sentence does not name every figure it moves
(`sentence_mismatch`); a valid one always lands on `needs_approval` carrying before and after
for every limit it touches. A policy change the human did not click is how every guarantee here
gets removed.

## Policy as sentences

Policy lives on disk as JSON but is read as English. The renderer is pure and deterministic, so
what the app shows is what the engine enforces:

    Refuse any single transaction above $10,000.
    Refuse more than $25,000 in any 24 hours.
    Ask me before anything above $100.
    Ask me once auto-approved moves pass $500 in 24 hours.
    Tether may not exceed 30% of holdings.
    No more than 20% of holdings may be freezable.
    KILL SWITCH ON: all writes refused.

The first four lines are the shipped defaults. The last three appear only once authored.

Limits that are meaningful at their default (transaction cap, session cap, click threshold, the
auto-approved daily ceiling) always render. Opt-in restrictions render only once set, because "no
issuer may exceed 100%" says nothing. The kill switch, when on, always renders last.

## First run

A fresh clone carries no keys and no addresses. Creating those two things is the whole setup.

    git clone <repo> phosphor && cd phosphor
    npm install
    npm run tauri dev

**Every address this app holds is a real address holding real money.** There is no practice mode
and no second world to try it in. Size the first deposit accordingly.

The window opens on the terms of use first, and nothing else opens until they are accepted. The
acceptance is `state/terms.json` (the version accepted and when, mode 0600) and one
`terms_accepted` line in the audit log; the version is the date the terms last changed, so a
change on the site asks once more. The route is `POST /api/terms/accept` with the window token.
Nothing here is a control: the file gates a screen, not a key.

The wallet is made in the window. Set a password, write down the twelve words it shows once, and
it writes `keys.enc.json` beside `keysPath`, file mode 0600, in a directory mode 0700. That path
is outside the working copy on purpose: a key file inside a git working copy is one `git add -f`
from being published, and one outside it cannot be reached by git at all. The `.gitignore` entry
is the second line of defence, not the first. Move the file with `PHOSPHOR_KEYS` or a `keysPath`
config key; the app refuses to start if that path lands inside the repo.

Then the lock, which is the state the app is in every time you open it after that. Locked, every
read still works behind the frosted window; the password is what buys the ability to sign. It
locks itself after fifteen minutes with nobody at the window (the Vault offers 5, 15 or 60
minutes) and when the machine sleeps.

`npm run keygen` still exists and mints one RAW UNENCRYPTED EVM key for development. It is not
the setup path, and running it before the first launch is a mistake rather than a step: a file it
writes reads as `needs_migration` in the app, and the migration screen is what turns it into a
keystore.

It prints the public address only. No branch of it prints a private key. It refuses to overwrite
an existing key file, because silently replacing a funded key loses the funds with it:

    npm run keygen -- --force     # deliberate replacement

A wallet made in the window needs no config at all: the keystore is the address book. An install
that only reads names its one EVM address, which is the NEAR Intents account id and the
Hyperliquid account, in `config.local.json` at the repo root. That file is gitignored and merges
over `config.json` key by key, so the address stays on your machine:

    {
      "addresses": {
        "evm": "0x..."
      }
    }

An older file that lists `evm`, `solana` and `near` arrays still loads: the first `evm` entry is
the address, and the other two are ignored, because nothing here signs with those keys any more.

Money comes in through the deposit card in the window (the NEAR Intents bridge address for the
network you pick), never by sending to this address on a chain. Then:

    npm run tauri dev

### Before any push

    npm run sweep

Six checks over both the tracked tree and the entire git history: key-shaped material (64 character
hex runs, 87 to 88 character base58 runs, `ed25519:` values, PEM blocks, seed-phrase-shaped lines),
every address found in your local config and key file, that `config.local.json`, `keys.json`,
`.env*` and `state/` are neither tracked nor un-ignored, and that `keysPath` resolves outside the
working copy. History matters as much as the working tree: a file deleted today is still published
if any commit holds it.

Exit 0 means nothing secret is reachable from the remote. A finding names the file, the line and
the pattern, and never the matched text, because printing it would put the secret in a terminal, a
scrollback buffer and probably a CI log.

## Mode and config

There is one world. Every RPC endpoint, token address and contract address in this repo names a
live chain, and there is no setting that points them anywhere else. Nothing here is a rehearsal.

`mode` is the only axis:

- `live` reads the two pockets, the NEAR Intents verifier and the Hyperliquid account, and needs
  no key to read: the account is the address in the keystore's plaintext header.
- `demo` serves a fixture (ETH, USDC and SOL inside NEAR Intents, 50 USDC of Hyperliquid
  collateral) and runs no rail, so a proposal there is drafted, priced and ruled on offline with
  nothing at stake, and refuses at the rail step. It is not a practice mode for real money: it
  moves nothing, anywhere, ever.

Shipped `config.json` is `mode: "live"`. Demo is no longer the default anywhere. It stays in the
codebase because the test suite and the e2e proof run against it offline.

`config.json` is a committed template. It carries structure and safe defaults only: port, mode,
an empty address book, candle products. No addresses, ever. `config.local.json` carries yours, is
gitignored, and merges over the template key by key. The environment variables `PHOSPHOR_MODE`,
`PHOSPHOR_PORT`, `PHOSPHOR_DATA_DIR` and `PHOSPHOR_KEYS` override both.

## Keys and signing

Key material never enters the repo tree, and `npm run sweep` is the standing check that this
stayed true. It lives beside `keysPath`, and THE DATA DIRECTORY DECIDES where that is:

    the repo default (state/)      ~/.phosphor/<repo folder>/keys.enc.json, falling back to
                                   ~/.phosphor/keys.enc.json when an older install put it there
    the installed .app             the same rule. The shell says so with PHOSPHOR_APP_DATA=1,
                                   so an upgrade never moves the wallet. Its folder name is
                                   `phosphor`, so a fresh Mac gets
                                   ~/.phosphor/phosphor/keys.enc.json, and a Mac that already
                                   had ~/.phosphor/keys.enc.json keeps using it
    any other data directory       keys.enc.json beside that directory's own state

The installed app keeps everything else it writes under
`~/Library/Application Support/com.karimbabasf.phosphor/`: `state/` (policy.json, proposals.json,
audit.jsonl, terms.json, agent.secret) and `config.local.json` beside it. The shell creates that
folder before the backend starts, and `loadConfig` creates the data directory it is given, so a
first run on an empty Mac makes both without a step from the person; the key folder is made at
mode 0700 the moment the wallet is created. `tests/unit/keys-path.test.ts` holds all three rows.

The last row is the one that matters. A demo run, a test or a second profile is given a data
directory of its own, and it gets an EMPTY wallet rather than the real one: before this the key
file was keyed off the repo folder alone, so every backend started from one checkout opened one
wallet whatever data directory it was handed. `PHOSPHOR_KEYS` or a `keysPath` in config overrides
all three, because a person naming a path has said which wallet they mean.

The file is `keys.enc.json`, at 0600: one AES-256-GCM envelope over the whole key set, with a
plaintext header the app can read without a password. A random 32-byte data key encrypts the
payload and a scrypt key derived from the password (N=2^18, r=8, p=1, 32-byte salt) wraps that
data key, so changing the password rewraps 32 bytes rather than re-encrypting the file. The header
is the additional authenticated data for both, which is what stops anyone editing the addresses in
it: they are what every balance read uses while the wallet is locked.

    {
      "header": {
        "version": 1,
        "createdAt": "<ISO>",
        "kdf": { "name": "scrypt", "N": 262144, "r": 8, "p": 1, "salt": "<64 hex>" },
        "addresses": { "evm": "0x...", "solana": "<base58>", "near": "<64 hex>",
                       "nearPublicKey": "ed25519:<base58>" },
        "hasMnemonic": true
      },
      "wrap":    { "iv": "<24 hex>", "tag": "<32 hex>", "data": "<base64>" },
      "payload": { "iv": "<24 hex>", "tag": "<32 hex>", "data": "<base64>" }
    }

The payload decrypts to the same shape the old plaintext `keys.json` had, so a migration is a copy
rather than a translation:

    {
      "mnemonic": "<twelve words>",
      "evm":    { "address": "0x...",       "privateKey": "0x<32 bytes hex>" },
      "near":   { "accountId": "<64 hex>",  "publicKey": "ed25519:<base58>",
                  "secretKey": "ed25519:<base58 of seed || public>" },
      "solana": { "address": "<base58>",    "secretKey": "<base58 of seed || public>" }
    }

A new wallet derives from twelve BIP39 words: EVM at m/44'/60'/0'/0/0 through viem, Solana at
m/44'/501'/0'/0' and NEAR at m/44'/397'/0' through SLIP-0010 ed25519 written in house with
node:crypto. The published vector "abandon abandon ... about" derives
`0x9858EfFD232B4033E47d90003D41EC34EcaEda94` and `HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk`,
which `tests/unit/keystore.test.ts` asserts: a wallet made here opens in MetaMask and Phantom.

The wallet locks after fifteen minutes with nobody at the window, when the machine sleeps, when
the window closes, and on demand. Locked, every read still works, and every write proposal an
agent makes is drafted, priced and policy-checked and then waits as `pending_unlock` until
somebody unlocks, at which point it is decided again against the policy as it stands then and
lands as something to click. An unlock is not an approval: the click threshold says how much money
ONE action may move without a person, and a queue released all at once is a different question, so
even the small ones wait for the click they would not have needed with the app open. An
armed trading rule is the one exception: it keeps the Hyperliquid API wallet key on a session with
an expiry set when it was armed: the plan's own expiry, a day at most, and eight hours when the
plan names none. That key can place
orders and cannot withdraw, so a bot that outlives a lock holds trading authority, not custody.

An install with an older plaintext `keys.json` reads as `needs_migration` and keeps working.
`POST /api/wallet/migrate` encrypts it, verifies the round trip decrypts byte-identical and the
EVM address is unchanged, and only then overwrites the plaintext with random bytes, fsyncs,
truncates and unlinks it, along with every `keys.json.bak*` beside it. On APFS with snapshots an
overwrite is not an erasure, so the honest answer after migrating is to rotate to a fresh wallet.

EVM address derivation goes through viem, the same library the rails sign with, so the codebase has
one derivation path rather than two that have to agree. The trap this avoids is silent and
expensive: an EVM address is keccak256 of the public key, and `node:crypto` has no keccak256. It
ships `sha3-256`, which is NIST FIPS 202: the same permutation with a different padding byte, so it
returns a different digest and an address nobody holds the key to. Nothing about the wrong address
looks wrong, and funds sent there are gone.

One key signs, and it signs no chain transaction. The EVM key signs ERC-191 intents for the
NEAR Intents rails (`src/rails/intents-native.ts`, `intents-send.ts`, `intents-spend.ts`) and
EIP-712 actions for Hyperliquid (`src/rails/hl-user-signed.ts`). The chain signers that used to
live in `src/chain/evm.ts` and `src/chain/near.ts` went with the chain wallets on 2026-09-16;
those files now hold the EVM readers and explorer prefixes, the NEAR RPC, base58 and the account
id rules. A wallet's mnemonic still derives the Solana and NEAR keys into the sealed file, for
recovery in another wallet, and nothing here reads them.

`keygen` checks itself before it generates anything, on every run: the canonical Ethereum test
key `0x4c0883a6...362318` must derive `0x2c7536E3605D9C16a7a3D7b1898e529396a65c23`. A mismatch
stops the program instead of printing an address that no private key opens.

### Code signing: hardened, ad hoc, not notarized

Encryption at rest with no hardened runtime moves a key from a file anyone can read to a heap
anyone can read: any process running as you can attach to the backend with `task_for_pid` and take
the unlocked key out of memory. `fill(0)` on lock is best effort and says so in the source.

So the bundle carries `src-tauri/entitlements.plist` and a `bundle.macOS` block asking for the
hardened runtime without `get-task-allow`, which is the entitlement that would let a debugger
attach (`tests/unit/code-signing.test.ts` holds the file to that, and to the one entitlement
V8 needs, `allow-jit`). `signingIdentity` is `-` in the config, so every build so far is ad hoc
signed: a local build and the release build alike. The release workflow reads
`APPLE_SIGNING_IDENTITY` and the App Store Connect key from its secrets when they are set, signs
with a Developer ID and submits the app to Apple for notarization; they are not set, because the
Apple Developer Program needs an account this project does not hold yet, so Gatekeeper stops the
first open and the person clicks Open Anyway ([Getting started](getting-started.md#the-gatekeeper-warning)).

    APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)" npm run app:build

Touch ID and the Secure Enclave are built (`src-tauri/src/enclave.rs`, the `se-helper` sidecar,
`src/vault/`): on a Mac with an enclave the key file is sealed with a data key wrapped to a key
the enclave made and cannot export, and every click ends in a Touch ID dialog the app composes.
On an ad hoc build the enclave key is bound to this Mac rather than to Phosphor's signature, which
the Vault tab's Keys row says in one line ("This copy of Phosphor is not signed, so other apps on
this Mac could ask for the key"); a Developer ID build binds it to the app.

**What is still open.** The key is in this process's memory whenever the wallet is unlocked, and
the answer to that is a separate signing process or a hardware device, neither of which ships
here. Treat the balance behind these keys as the amount you are willing to lose to something that
gets code execution as you while the app is unlocked. [Known limits](known-limits.md) lists this
beside the others.

Execution routes through NEAR Intents. One rail, no bridges, 1 basis point, 25+ chains, 125+
assets. The alternative was per-chain bridges, which multiplies the number of things that can steal
from you by the number of chains supported.

Still open, unrelated to keys:

1. Review `data/risk-table.json` rows and sources (curated, human-owned).
2. Optional: a JWT for NEAR Intents 1Click, which buys a lower fee tier.

## Latency

Measured in three places, none of them a guess. `tests/unit/runner-latency.test.ts` fires twenty
plans through the real host and a real fork of the child against a loopback venue
(`tests/fixtures/hl-venue.ts`) and prints two clocks: from the market frame that makes a waiting
plan's conditions hold (`host.onMarket`) to the child's order reaching `/exchange`, and from the
fire command leaving the host to that same POST. Both must be under 50 ms at p95; they run at
about 1.5 ms p50, and the one slow sample is always the first fire after a fork, which pays for
the cold signature path and the first socket. In the app, the child times every POST it makes,
reads and writes alike, and every `placed`, `protected`, `modified`, `cancelled` and `closed`
event carries `venueMs`, which the audit line writes as "the venue took N ms" so the record
separates the venue's time from the app's. `npm run venue-latency` reads the venue itself from
this machine, unsigned and with no key: `/info` meta, clearinghouseState, l2Book and extraAgents,
an `/exchange` POST the venue rejects for its signature, and twenty seconds of the
`activeAssetCtx` and 1m `candle` cadence for BTC, printed as p50, min and max per line.

## Layout

    src/main.ts        app process: state owner, wiring, HTTP + UI on 127.0.0.1:4177
    src/server.ts      the composition root: builds the context and hands it to the router
    src/http/          the surface itself: the router, the routes, auth, SSE, /api/mcp, the log tail
    src/mcp.ts         stdio MCP server, thin proxy to the app, no approval path
    src/greeting.ts    the connect-time greeting and the index of everything an agent can do
    src/agents.ts      who is driving: the roster, roles, heartbeat TTLs, the lead
    src/board.ts       the noticeboard agents write one line each to. Data, never authority
    src/duplicates.ts  two agents cannot double one proposal by accident
    src/crew.ts        workers: the app spawning an analyst on an agent's behalf
    src/driver.ts      the agent the app starts for you, and the orphans it collects
    src/providers/     the two vendors the chat can run, Claude Code and Grok, each locked down
    src/web-read.ts    the mark a web read leaves: every later move in that chat waits for a click
    src/keystore/      the encrypted key file, the lock, the session, the derivation
    src/policy/        engine (pure) + policy file + sentence renderer + the venue gap
    src/proposals.ts   a 92-line door onto src/proposals/
    src/proposals/     the work: lifecycle, execute, draft, rails, trade, reconcile
    src/rails/         the rail registry: intents, hyperliquid
    src/trade/         plan, risk, plans on disk, the watcher, the rail, the surface
    src/runner/        the host (registry, watcher, fills watch) and the child that signs
    src/chain/         the EVM readers and explorer prefixes, the NEAR RPC and account id rules
    src/ledger/        the NEAR Intents verifier read + demo fixtures
    src/transactions.ts  the transaction history, derived from the store and the log
    src/role.ts        what the app tells an agent it is, in the MCP handshake
    src/composition.ts risk classification against data/risk-table.json
    src/intents.ts     1Click quotes, synthetic quoter, stub signer
    src/chart.ts       chart view state, the agent read model, compact and full
    src/charts.ts      up to four charts, each a chart store beside a drawing store
    src/snapshot.ts    the picture broker: one outstanding ask per chart, never stored
    src/indicators.ts  indicator maths, pure, index aligned with the candles
    src/indicators-kit.ts      the series maths both catalogues are built from
    src/indicators-library.ts  the wave family, supertrend, keltner, squeeze, ichimoku, adx
    src/presets.ts     named study packages, and the tidy that runs before one is applied
    src/analysis/      the measurements: pivots, levels, regime, vwap, range, divergence,
                       and structure.ts: order blocks, gaps, liquidity, breaks of structure
    src/drawings.ts    the objects that make the chart a shared coordinate system
    src/batch.ts       many operations, one round trip, because latency is turns not ms
    src/market/        the candle cache and the catalog: why the chart stops being late
    src/hl/            hyperliquid: signing, msgpack, order format, liquidation maths
    src/trade/         the trading surface: raw venue state in, one payload out
    src/runner/        the only code that places an order. No model runs in this process
    src/view/          the basic screen as one pure function, and the mode itself
    scripts/keygen.ts  raw keypairs for developers, written outside the working copy
    scripts/sweep.ts   secret sweep over the tracked tree and the git history
    ui/                one window, four screens, no framework, no build
    ui/chart/          the chart engine: two canvases, one pointer surface
    ui/screens/        one file per screen: basic, pro, trade, vault, lock, first run, decision
    ui/core/           the DOM helpers, the keyed reconciler, the API client, the store
    ui/design/         the tokens, the type scale and the motion the screens are built from
    ui/fonts/          Geist and Geist Mono, self-hosted, with their OFL beside them
    ui/logos/          the token and venue logos as SVG files, with their notices in LICENSE.md
    operator/          the opt-in operator profile: an agent that drives but cannot develop
    state/             policy.json, proposals.json, audit.jsonl (append-only), terms.json,
                       agent.secret; the installed app keeps it under Application Support

## The operator profile

A second agent role, shipped opt-in under [operator/](operator/). The session that drives phosphor
does not also develop it: `operator/settings.json` denies every built-in file writer and command
runner, and the key file, while allowing `Read` and every `mcp__phosphor__*` tool, so the whole
tool surface still works.

    ./operator/phosphor-operator

A denied bare tool name is removed from the model's context, so an operator has no editor to be
talked into using, in any permission mode. It is not installed at `.claude/settings.json`, so your
own development sessions in this directory are untouched. Detail in [operator/README.md](../operator/README.md).
