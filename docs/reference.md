# Phosphor reference

The long form of what the README says in short: the tool surface, gas, how a proposal is decided, policy as sentences, the first run, mode and config, keys and signing, the code layout and the operator profile. Everything here describes the code as it is; where it names a count (tools, tests), re-check the number before quoting it.

## The tool surface

Fifty-two tools, in six families. Read tools execute directly and cannot move anything. Write
tools never execute: they return a proposal id and a simulation result, and nothing else. Chart
and trading tools move a view or a marker, never funds. Team tools coordinate several agents.
Display tools move the window. The tables below are the whole surface, and
`tests/tool-surface.ts` is the one list both the injection suite and the e2e run hold it to.

An agent that connects is handed all of this at once. `start` returns the greeting, the live
state and an index of every tool grouped by what a person would actually ask for, so an agent
never has to ask a human how to operate the app. The role rides in the MCP handshake itself, in
the server's `instructions`, so it arrives without anyone prompting for it.

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

**The chart cleans itself up.** Levels, marks and trend lines are anchored to one instrument, so
switching product clears the agent-drawn ones automatically and says how many it took. Indicators
are kept, because an EMA means the same thing on any market. A human's own drawings are never
swept by anything an agent does. Every `chart_read` carries a `housekeeping` block counting what
is the reading agent's, what is another agent's and what is stale, beside the exact call that
clears each.

| Read tool | Returns |
|---|---|
| `start` | The greeting, the live state and the index of everything this door opens onto, grouped by intent. Call it again after a long gap: the network, the wallet and the pending decisions all move |
| `wallet` | Everything held, one row per balance: place, quantity, price, value, share. Only what is actually held; how many configured tokens came back empty is reported as a count |
| `balances` | The raw snapshot behind the wallet, with staleness |
| `composition` | Shares by issuer and chain, freezable share, unclassified holdings |
| `policy_show` | Current policy as plain-English sentences, or a notice that the file is unreadable |
| `log_tail` | Most recent audit lines, newest first |
| `candles` | Recent OHLC candles for a product, with a staleness marker |
| `proposal_status` | Status, verdict and simulation result for a proposal id |
| `research` | The one read that leaves this machine. The APP fetches from a fixed allowlist of documentation hosts and hands back text; the agent never gets a URL it can point anywhere, which is the whole reason this is a Phosphor tool and not a general web fetch |
| `gas_report` | What the app has spent on gas over a window, split by action, chain, rail kind and venue, plus gas as basis points of the value moved. An aggregation of receipts the history surface already read, so it makes no chain call. The four remainders (pending, unknown, unpriced, intent-settled) and the reverted line are counted separately and named in the tool description, because a total that drops what it could not count is a wrong number said confidently |

| Write tool | Does |
|---|---|
| `propose_swap` | Swaps one token for another. Venue `oneclick` across chains from the wallet, or `intents-native` inside `intents.near` over an already-deposited balance. Omitting the venue means `oneclick` |
| `propose_intents_deposit` | Moves funds from this wallet into NEAR Intents, where they become a balance `intents.near` holds under this app's own account. Funds the `intents-native` swap venue. Deposits the chain's gas asset (native ETH) unless a symbol is given |
| `propose_intents_withdraw` | Brings a balance back out of `intents.near` into one of this app's own wallets on `eth`, `base`, `arb` or `sol`. The way out of the `intents-native` venue. Withdraws the chain's gas asset unless a symbol is given. Which wallet is ours comes from `config.local.json`, never from the call |
| `propose_consolidate` | Gathers a token's scattered balances onto one chain. Unproven: this path has never run on a live chain, and the tool description says so, so a clean simulation is not evidence it works |
| `propose_policy_change` | Proposes a patch to the policy rules. Always waits for a human click |
| `propose_mandate` | Arms a rule-driven bot on Hyperliquid perpetuals: a rule program plus the envelope it may never leave. The only tool that grants standing authority, so it always waits for a human click |
| `propose_hl_deposit` | Funds the Hyperliquid perpetuals account. Routes through NEAR Intents into HyperCore; there is no tool that takes money back out, and the paragraph below says why |

This door now names exactly the set the app can execute. `propose_lp_add`, `propose_lp_remove`,
`propose_yield_deposit`, `propose_yield_withdraw`, `yield_read` and `yield_auto` were on it or
behind it at various points; the rails under all six were removed when the app cut to two venues,
so there is nothing left to register. What went with them: an on-chain DEX swap venue, both
liquidity-pool moves and the whole lending loop.

`propose_hl_deposit` was on that list until 2026-08-20 and is back, because the rail underneath it
changed shape rather than because it was tested more. It used to transfer USDC to Hyperliquid's
Bridge2 contract on Arbitrum; it now routes through NEAR Intents into HyperCore, and 1Click
refuses `hypercore` as an origin, so the direction is a property of the venue rather than a check
of ours. An agent holding it can add collateral to the trading account and has no path on its
surface to remove any. Getting money off the venue is a signed `withdraw3` a human runs at a
terminal, and that is deliberately not a tool.

| Chart tool | Does |
|---|---|
| `chart_read` | The whole chart in one object: visible time range in epoch and ISO, seconds until this bar closes, current bar OHLCV, change and range over the window, the price scale and decimal precision in use, every indicator with its last values and a plain sentence, the levels and marks, and the pixel geometry |
| `chart_batch` | The instrument, and the one to reach for when the question is analytical: pivots, levels, regime, ATR, volume profile, VWAP, range, divergence, trend-line fit, trend-line value at a time, trend-line touches, history paging. Many questions in one call, and a later entry can reference an earlier one by name, so a fitted trend line can be measured against without a round trip |
| `chart_measure` | Between two times, two prices, or one of each: change, bars, elapsed, the high and low the path took, worst drawdown |
| `chart_scan` | Several timeframes at once without moving the chart: last, change, range, ATR, trend, time to close |
| `indicator_catalog` | Every indicator it can draw, with parameters, defaults and ranges |
| `market_search` | Finds a market by name. Takes "btc", "bitcoin", "wif" or "PEPE-USD" and returns the product id to open, plus near matches when the query is ambiguous |
| `chart_set_view` | Product, timeframe, bars on screen, how far back, price scale. The product is anything either venue lists, and the timeframe is anything from `1m` to `1w`, including ones no venue serves natively like `7m`. A minute is the floor: no venue serves a candle under one, and building them here meant assembling a line out of two different markets |
| `chart_add_indicator` | SMA, EMA, WMA, VWAP, Bollinger, Donchian on the price; volume, RSI, MACD, ATR, Stochastic, OBV in their own pane |
| `chart_remove_indicator` | Takes one off |
| `chart_level` | A horizontal price line with a label, for when the level is flat |
| `chart_trendline` | A sloped line through two time-and-price anchors, for when it is not. Zones are drawn through `chart_batch` |
| `chart_mark` | A labelled moment on the time axis |
| `chart_clear` | Clears indicators, levels, marks, everything the agent drew, or all of it |
| `chart_preset` | Applies a named study package in one call, with the tidy that runs before one is applied, so a chart does not accumulate two answers to the same question |

| Trading tool | Does |
|---|---|
| `trade_read` | The book as it stands: account health, positions with liquidation distance, working orders, recent fills, armed mandates |
| `trade_batch` | Account, positions, orders, fills, mandates, market and venue health in one round trip |
| `trade_focus` | Points the trading surface at one market. The chart follows |
| `trade_highlight` | Highlights one row and says why, so the agent and the human are looking at the same object |
| `trade_overlay` | Toggles entry, liquidation, stops, targets, orders, fills and the mandate wall |
| `trade_note` | Pins one line of the agent's reasoning where the human can see it |
| `trade_clear` | Removes what the agent put on the surface |
| `mandate_catalog` | The whole mandate grammar with worked, validated examples: conditions, actions, how to reference a trend line already drawn, what each envelope field caps, and the traps. There is no discretionary order in this app, so this is how a position gets opened at all |

There is no tool that closes a position and no tool that places a discretionary order. A position
is opened and exited by a mandate a human armed, which is the same argument the write surface
makes: the way to stop an agent doing something with real money is to never hand it the verb.

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
| `watch` | Points the app at a market and leaves it there, so the window keeps showing what the conversation is about after the conversation has moved on |
| `set_theme` | Changes the window's colours. Moves no money, and it is on this surface because a person asking their assistant to darken the screen should not have to leave the conversation |
| `switch` | Moves the window between the plain-English view (`basic`), the operator view (`pro`) and the trading surface (`trade`). Moves no money, and every switch is audited. Named `switch` rather than `set_view_mode` because the whole requirement is that changing window costs one word: an agent hunting for how to "switch to trading" finds it immediately, and did not reliably find `set_view_mode`. Aliases (trading, hft, perps, simple) resolve in the app, so both doors agree. Not to be confused with `chart_set_view`, which drives the chart's render state inside pro |

A switch used to be refused outright while a proposal was pending, so an agent could not move a
human away from a decision they were in the middle of. The approval block now renders on all three
windows, so the decision follows the human instead of being left behind, and the refusal was
removed. What replaces it is disclosure rather than silence: the pending ids ride back on the
response and the tool description tells the agent to say the count out loud, because the basic
screen shows one ask at a time and switching there with three waiting would otherwise hide two.

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

## Where the gas went

Every movement this app makes burns gas somewhere, the per-transaction figure has always been on
the row in HISTORY, and nothing added it up. `GET /api/gas` does: a total for the window, what each
kind of action spent, the same split by chain, and gas as basis points of the value actually moved.
Agents ask the same question with `gas_report`, and both doors run the same derivation, so the
human and the agent cannot be told different numbers about the same money.

The `[ GAS ]` deck-bar modal that used to draw this, with a donut and a table on both decks, went
with the window rebuild: per-transaction fees ride on the Activity rows now, with a total for the
window. The derivation and both doors onto it are unchanged.

It is an aggregation, not a new read. The receipts come from the same cache the history surface
fills, so opening GAS after HISTORY costs nothing and opening it first warms the cache for HISTORY.
No new RPC call, no new store.

The part worth reading is the remainders. An aggregate that silently drops what it cannot count
reports a smaller number than the truth and calls it the truth, so four categories are counted
apart and reported, and none of them means zero gas:

    still reading     the receipt has not landed yet
    unknown           no chain this app can reach has that hash
    intent-settled    signed, not broadcast, so a solver paid the gas and we paid none
    unpriced          gas known in native units, no price available to convert it

And one that is not a remainder: **reverted**, in red, because gas spent on a transaction that
moved nothing is the only figure here that is pure loss. A remainder that is zero prints nothing at
all: "0 pending" is chrome.

The numbers are the authority. The rings that used to draw their shape, and the labelled canvas
that read them out, went with the composition donut in the window rebuild: the figures survived the
drawing of them, because the derivation was never in the canvas.

## How a proposal gets decided

A write tool builds a draft, simulates it (a quote per leg), and hands it to the policy engine. The
engine returns exactly one of three verdicts, with no fourth outcome and no override path:

- **refuse**: nothing happens, and the refusal is logged with the rule that caused it.
- **needs_approval**: the proposal appears in the approval gate in the app window with its
  simulation result and two buttons. It executes only after a human clicks approve.
- **allow**: below the click threshold and inside every cap, so the app executes it and logs it.

The rule chain runs in a fixed order and stops at the first refusal: unreadable policy, kill switch,
then (for fund moves) legs present, leg amounts sane, every leg simulated, destination is one of our
own addresses or on the allowlist, per-transaction cap, rolling session cap, forbidden issuer, then
the post-move composition (issuer share caps, freezable cap, per-chain gas floors). Composition
checks judge the resulting state rather than the delta, so a portfolio already past a cap cannot
make further moves until a human changes the policy.

The rails (swap, LP, Hyperliquid deposit) take their own branch, because they hand funds to a
venue contract rather than decomposing into transfer legs. They are checked on the amount, the
per-transaction and session caps, the click threshold, the venue contract, and separately on
where the proceeds land. That branch deliberately does not compute a post-move composition: the
engine cannot know what a pool or an exchange will hand back, and inventing a post-state would
be worse than admitting the gap.

Every amount the engine reads is priced by the app, never supplied by the agent. A token the app
cannot price is refused rather than assumed to be worth a dollar, because a value it cannot
establish is a value its caps cannot bound.

Policy changes take a shorter path: `killSwitch`, `version` and the rendered sentences are not
patchable at all, any other patch is schema-checked, and a valid one always lands on
`needs_approval`. A policy change the human did not click is how every guarantee here gets removed.

## Policy as sentences

Policy lives on disk as JSON but is read as English. The renderer is pure and deterministic, so
what the app shows is what the engine enforces:

    Refuse any single transaction above $10,000.
    Refuse more than $25,000 in any 24 hours.
    Ask me before anything above $100.
    Keep at least $5 of gas on eth.
    Keep at least $1 of gas on base.
    Keep at least $1 of gas on arb.
    Keep at least $2 of gas on sol.
    Keep at least $0.50 of gas on near.
    Tether may not exceed 30% of holdings.
    No more than 20% of holdings may be freezable.
    KILL SWITCH ON: all writes refused.

The first eight lines are the shipped defaults. The last three appear only once authored.

Limits that are meaningful at their default (transaction cap, session cap, click threshold, gas
floors) always render. Opt-in restrictions render only once set, because "no issuer may exceed 100%"
says nothing. The kill switch, when on, always renders last.

## First run

A fresh clone carries no keys and no addresses. Creating those two things is the whole setup.

    git clone <repo> phosphor && cd phosphor
    npm install
    npm run tauri dev

**Every address this app holds is a real address holding real money.** There is no practice mode
and no second world to try it in. Size the first deposit accordingly.

The wallet is made in the window. Set a password, write down the twelve words it shows once, and
it writes `keys.enc.json` beside `keysPath`, file mode 0600, in a directory mode 0700. That path
is outside the working copy on purpose: a key file inside a git working copy is one `git add -f`
from being published, and one outside it cannot be reached by git at all. The `.gitignore` entry
is the second line of defence, not the first. Move the file with `PHOSPHOR_KEYS` or a `keysPath`
config key; the app refuses to start if that path lands inside the repo.

Then the lock, which is the state the app is in every time you open it after that. Locked, every
read still works and the window still shows the balance; the password is what buys the ability to
sign. It locks itself after fifteen minutes with nobody at the window and when the machine sleeps.

`npm run keygen` still exists and mints RAW UNENCRYPTED keys for development. It is not the setup
path, and running it before the first launch is a mistake rather than a step: a file it writes
reads as `needs_migration` in the app, and the migration screen is what turns it into a keystore.

It prints public addresses only. No branch of it prints a private key. It refuses to overwrite an
existing key file, because silently replacing a funded key loses the funds with it:

    npm run keygen -- --force     # deliberate replacement

The window prints the same addresses on the receive screen. Copy them into `config.local.json` at
the repo root. That file is gitignored and
merges over `config.json` key by key, so the addresses stay on your machine:

    {
      "addresses": {
        "evm": ["0x..."],
        "solana": ["..."],
        "near": ["..."]
      }
    }

Fund the addresses. Every rail needs native gas on the chain it runs on, and balances read zero
until funds land. A NEAR implicit account exists the moment it is funded, so the first transfer
to it is what creates it. Then:

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

- `live` reads real balances over public RPCs and needs no keys to read.
- `demo` uses a fixture portfolio and a synthetic quoter, so the whole propose, approve, execute
  loop runs offline with nothing at stake. It is not a practice mode for real money: it moves
  nothing, anywhere, ever.

Shipped `config.json` is `mode: "live"`. Demo is no longer the default anywhere. It stays in the
codebase because the test suite and the e2e proof run against it offline.

`config.json` is a committed template. It carries structure and safe defaults only: port, mode,
empty address arrays, candle products. No addresses, ever. `config.local.json` carries yours, is
gitignored, and merges over the template key by key. The environment variables `PHOSPHOR_MODE`,
`PHOSPHOR_PORT`, `PHOSPHOR_DATA_DIR` and `PHOSPHOR_KEYS` override both.

## Keys and signing

Key material never enters the repo tree, and `npm run sweep` is the standing check that this
stayed true. It lives beside `keysPath`, and THE DATA DIRECTORY DECIDES where that is:

    the repo default (state/)      ~/.phosphor/<repo folder>/keys.enc.json, falling back to
                                   ~/.phosphor/keys.enc.json when an older install put it there
    the installed .app             the same file. The shell says so with PHOSPHOR_APP_DATA=1,
                                   so an upgrade never moves the wallet
    any other data directory       keys.enc.json beside that directory's own state

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
an expiry set when it was armed, eight hours by default and a day at most. That key can place
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

There are two signers, one per chain family, and each is the only place its family is signed for:
`src/chain/evm.ts` and `src/chain/near.ts`. NEAR is a different curve (ed25519), a different
serialization (borsh), and a different transaction shape, so it does not fit behind the EVM one.
It hand-rolls borsh where the EVM signer took a dependency, and the reason the answer differs is
the failure mode rather than the effort: a wrong keccak silently derives an address nobody owns,
while a wrong borsh produces a signature that does not verify against the body, so the RPC rejects
the transaction and nothing moves. `near.ts` self-checks on the same principle as `keygen`, with
RFC 8032 vector 1, two base58 vectors, sha256 of the empty string, and the borsh integer widths.

Two NEAR bugs were found by signing four real transactions rather than by any vector, both the
same root cause: `send_tx` returns at `EXECUTED_OPTIMISTIC`, which is ahead of finality, so a read
at `finality: final` straight afterwards returns the state from before the transaction. It made a
successful wrap look like a silent failure, and it made a second send reuse a nonce the first had
already spent. `src/chain/near.ts` carries both fixes and the comments explaining them.

`keygen` therefore checks itself before it generates anything, on every run: the canonical
Ethereum test key `0x4c0883a6...362318` must derive `0x2c7536E3605D9C16a7a3D7b1898e529396a65c23`,
RFC 8032 ed25519 vector 1 must derive its published public key, and base58 must reproduce two
published vectors. Any mismatch stops the program instead of printing an address that no private
key opens.

### Code signing, which is configured and not performed

Encryption at rest with no hardened runtime moves a key from a file anyone can read to a heap
anyone can read: any process running as you can attach to the backend with `task_for_pid` and take
the unlocked key out of memory. `fill(0)` on lock is best effort and says so in the source.

So the bundle carries `src-tauri/entitlements.plist` and a `bundle.macOS` block asking for the
hardened runtime without `get-task-allow`, which is the entitlement that would let a debugger
attach. `signingIdentity` is `-` in the config so a local build still works; a real build reads
`APPLE_SIGNING_IDENTITY` from the environment, which Tauri honours and which overrides the config:

    APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)" npm run app:build

Only the owner holds that identity, so this repo configures signing and does not perform it. Touch
ID is designed and deliberately not built: a Keychain item is scoped by code signature, so on an
unsigned app anything you run could read it.

**What is still open.** A software keystore on a laptop is not a hardware signer. The key is in
this process's memory whenever the wallet is unlocked, and the answer to that is a separate signing
process or a hardware device, neither of which ships here. Treat the balance behind these keys as
the amount you are willing to lose to something that gets code execution as you while the app is
unlocked.

Execution routes through NEAR Intents. One rail, no bridges, 1 basis point, 25+ chains, 125+
assets. The alternative was per-chain bridges, which multiplies the number of things that can steal
from you by the number of chains supported.

Still open, unrelated to keys:

1. Review `data/risk-table.json` rows and sources (curated, human-owned).
2. Optional: a JWT for NEAR Intents 1Click, which buys a lower fee tier.
3. Optional: an indexer key (Etherscan or similar) for historical gas and spread.

## Layout

    src/main.ts        app process: state owner, wiring, HTTP + UI on 127.0.0.1:4177
    src/server.ts      the composition root: builds the context and hands it to the router
    src/http/          the surface itself, 23 files: the router, the routes, auth, SSE, /api/mcp
    src/mcp.ts         stdio MCP server, thin proxy to the app, no approval path
    src/greeting.ts    the connect-time greeting and the index of everything an agent can do
    src/agents.ts      who is driving: the roster, roles, heartbeat TTLs, the lead
    src/board.ts       the noticeboard agents write one line each to. Data, never authority
    src/duplicates.ts  two agents cannot double one proposal by accident
    src/crew.ts        workers: the app spawning an analyst on an agent's behalf
    src/driver.ts      the agent the app starts for you, and the orphans it collects
    src/keystore/      the encrypted key file, the lock, the session, the derivation
    src/policy/        engine (pure) + policy file + sentence renderer + the venue gap
    src/proposals.ts   a 92-line door onto src/proposals/
    src/proposals/     the work: lifecycle, execute, draft, rails, positions, reconcile
    src/rails/         the rail registry: oneclick, intents, hyperliquid, mandate
    src/gas/           what a movement cost, grouped by action, chain, rail and venue
    src/chain/         the only places phosphor signs: evm.ts and near.ts
    src/ledger/        the NEAR Intents verifier read + demo fixtures
    src/history.ts     the transaction list the window pages through
    src/transactions.ts  receipts and the gas cache both doors read
    src/role.ts        what the app tells an agent it is, in the MCP handshake
    src/composition.ts risk classification against data/risk-table.json
    src/intents.ts     1Click quotes, synthetic quoter, stub signer
    src/chart.ts       chart view state, the agent read model, the ruler
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
    src/strategy/      the grammar an agent may write and the runner will execute
    src/view/          the basic screen as one pure function, and the mode itself
    scripts/keygen.ts  raw keypairs for developers, written outside the working copy
    scripts/sweep.ts   secret sweep over the tracked tree and the git history
    ui/                three windows, no framework, no build
    ui/chart/          the chart engine: two canvases, one pointer surface
    ui/screens/        one file per screen: basic, pro, trade, lock, first run, decision
    ui/core/           the DOM helpers, the keyed reconciler, the API client, the store
    ui/design/         the tokens, the type scale and the motion the screens are built from
    operator/          the opt-in operator profile: an agent that drives but cannot develop
    state/             policy.json, proposals.json, audit.jsonl (append-only)

## The operator profile

A second agent role, shipped opt-in under [operator/](operator/). The session that drives phosphor
does not also develop it: `operator/settings.json` denies every built-in file writer and command
runner, and the key file, while allowing `Read` and every `mcp__phosphor__*` tool, so the whole
tool surface still works.

    ./operator/phosphor-operator

A denied bare tool name is removed from the model's context, so an operator has no editor to be
talked into using, in any permission mode. It is not installed at `.claude/settings.json`, so your
own development sessions in this directory are untouched. Detail in [operator/README.md](operator/README.md).
