# Phosphor v1: the reliable boat

Date: 2026-09-01. Status: decided, building. Owner's brief, compressed: Phosphor works but feels
like a handmade boat. Make it reliable (backend and frontend), give the keys real custody with
easy access, delete testnet entirely, get rid of the green, make it look like a modern way to use
crypto with smooth geometric motion and feedback on every wait, fix the chart delay and the chart
layout, fix the donut, cut the noise, fix large screens, rework the agent tab with a proper start
button, pick real fonts, and leave clean code. Three modes, each UX friendly: basic, pro, trade.

Six read-only audits fed this document. They live outside the repo (scratchpad, session
8a56ee64) and their file:line detail is referenced by the plan, not repeated here.

## 1. What Phosphor is

Phosphor is a desktop app that lets a person use DeFi through the AI assistant they already pay
for. The app holds the keys, the chain connections and the rules, and it contains no AI. An
assistant connects over MCP and drives it: it can read everything and ask for anything, and it can
execute nothing. Every request that would move money is priced, simulated, checked against limits
the person wrote in their own words, then refused, executed inside the limits, or held for a
physical click in a window the assistant cannot reach. The product is the gap between what an
assistant can ask for and what it can make happen, made narrow enough that a person with no crypto
experience can hand an assistant real money and still be the only one who decides.

What it moves: a wallet across Ethereum, Base, Arbitrum, Solana and NEAR; a cross-chain swap
balance (NEAR Intents, shown as "Ready to move"); a stablecoin lending position (Aave v3, shown as
"Earning"); and collateral on Hyperliquid perps ("Trading money") where a rule the person armed
can open and close a position.

## 2. Decisions

Each one is final for this build. One line of why each.

1. **Mainnet only.** The `Network` type, `network`, `tradingNetwork`, `approvalGate`, every
   per-network table and every testnet constant, data file, script, test and doc line are deleted.
   The approval gate is unconditional: no code path executes with neither a human click nor a
   policy `allow`. `decidedBy: 'gate_disabled'` stays readable for old audit lines and is never
   written again. Why: the axis produced two real holes and the product has run on mainnet since
   2026-08-13.
2. **Aave v3 mainnet markets are added, verified on chain, for Arbitrum USDC and Base USDC.** The
   builder reads `getReserveData(USDC)` from each Pool over a public RPC and records the aToken
   address it returns; if a market cannot be verified it is left out and the yield tools answer
   "not available on this chain" instead of throwing. Why: the mainnet table is empty today, and a
   collapse without this ships a rail whose every call throws.
3. **Uniswap v3 Arbitrum mainnet row is added, verified by reading `factory()` from the position
   manager.** Why: Arbitrum was the exercised chain and the allowlist is built from that table.
4. **Custody: one AES-256-GCM envelope over the whole key set, scrypt KEK (N=2^18, r=8, p=1,
   32-byte salt) wrapping a random 32-byte data key, plaintext header carrying version, KDF
   params, salt, IV and the public addresses.** File: `~/.phosphor/<slug>/keys.enc.json`, 0600.
   Why: one envelope keeps all rails in one file and the address header keeps every read working
   while locked.
5. **Unlock is an HTTP route gated by the window token, and the token is never served over HTTP.**
   The Tauri shell mints the token, passes it to the backend in `PHOSPHOR_WINDOW_TOKEN`, and
   injects it into the control webview with an initialization script. `GET /api/session` is
   deleted. The e2e script gets the token from the same env var. No MCP tool and no `/api/mcp` op
   can unlock. Why: once the token is unreachable by any other process, the unlock route has the
   same protection as approve, and it keeps the lock screen inside the one window instead of a
   second native surface.
6. **Auto-lock after 15 minutes of human idle (window pointer or key activity only), on system
   sleep, on window close, and on demand.** Agent activity never refreshes the timer. While locked
   every read works and every write proposal is authored, policy-checked and queued as
   `pending_unlock`; nothing is refused. Why: a chatty agent must not hold a wallet open, and
   refusing teaches people to turn the lock off.
7. **An armed rule survives auto-lock through a signing session scoped to that rule, holding only
   the Hyperliquid API wallet key, with an expiry set at arm time (default 8h, max 24h).** Why: that
   key can place orders and cannot withdraw, so a bot that outlives a lock holds trading authority,
   not custody.
8. **New wallets derive from a 12-word BIP39 mnemonic** (EVM at m/44'/60'/0'/0/0 through viem;
   Solana at m/44'/501'/0'/0' and NEAR at m/44'/397'/0' through SLIP-0010 ed25519 implemented in
   house with node:crypto HMAC-SHA512). Existing raw-key setups keep working: the keystore holds
   an optional mnemonic plus per-rail keys, and import accepts a mnemonic or raw keys. Why: a
   person cannot back up three random keys; they can write twelve words down.
9. **Migration from plaintext runs once, in the window:** detect `keys.json`, take a password,
   write the envelope tmp-then-rename, verify the round trip decrypts byte-identical and the
   derived EVM address is unchanged, then overwrite the plaintext with random bytes, fsync,
   truncate, unlink. Same for `.bak` files. The window states that APFS snapshots may keep a copy
   and offers "rotate to a fresh wallet later". Why: verify before destroying.
10. **Code signing with hardened runtime is configured, not performed.** The entitlements file and
    the tauri.conf signing hook are added, keyed to `APPLE_SIGNING_IDENTITY`. Touch ID is designed
    but not built until the app is signed. Why: signing needs the owner's Apple identity, which
    only he holds.
11. **Reliability frame before structure.** Order: tolerant readers, crash handlers, durable atomic
    writes with fsync, boot reconciliation, single-instance lock, clean shutdown, never drop a tx
    hash, timeouts on all 27 fetch sites, idempotent Hyperliquid writes, amount bounds, shell
    supervision with a pid file, health endpoint. Then the server split. Why: splitting a file with
    no crash handler only moves the crash.
12. **`src/server.ts` is split into `src/http/*` around a context object**, and `src/proposals.ts`
    into `proposals/{draft,execute,lifecycle}.ts`, every file under 500 lines. For this build the
    split happens FIRST after the testnet collapse, because five tracks would otherwise edit one
    file. Why: parallel work needs separate files with separate owners.
13. **Chart latency: three stacked poll throttles are the cause, not the venue.** Fix the constants
    first (`minGap` 2000 to 250 ms, `CANDLE_PUSH_MS` 1000 to 250 ms, 1m staleness 3 s to 1 s), then
    add a live rail: Hyperliquid `candle` WebSocket channel for Hyperliquid-listed coins, Coinbase
    Exchange `matches` channel for Coinbase-only pairs, one socket per venue, folded into
    `store.put()`, pushed over the existing SSE stream as `{type:'candle', ...}` frames coalesced
    at 120 ms. REST stays as the fallback. One-minute floor stays. Why: measured p50 goes from 4.0 s
    to about 0.3 s, and the seam (`store.put`) is already cut.
14. **The chart leaves pro and lives in trade.** A chart tool called while pro is on screen
    switches the window to trade and says so in its response. Why: the single biggest de-noising
    move, and trade is one word away.
15. **One document, three views, one shell.** `ui/trade.html` is deleted; `ui/index.html` hosts
    basic, pro and trade as views under a 48 px top bar (wordmark, three mode tabs, status cluster).
    `switch` changes the view without navigation. Why: one shell, one SSE stream, no reload flash.
16. **Visual direction: monochrome graphite, white is the action color, blue is up, rose is down,
    amber is waiting, violet is the agent. No green anywhere.** Geist for UI and the balance, Geist
    Mono for numbers, addresses and axes, both vendored as variable woff2. The hiding-squares
    field (Book of Shapes) is the signature and it carries state. Full tokens in section 6.
17. **`set_theme` keeps its five slots** (accent, background, up, down, agent) mapped onto the new
    tokens (`--ink`, `--bg-0`, `--up`, `--down`, `--agent`) with the same hex-only validation and
    WCAG floors. Why: it is an MCP contract other agents already use.
18. **The agent globe is deleted.** The agent panel is one component in all three views with five
    states (not started, starting, connected, working, error), a Start button, Stop the answer,
    Stop the assistant, and an external-connection block with the connection line and a copy
    button. The `TOOL_PHRASES` table is carried over verbatim.
19. **Five new user-facing features, no more:** Locked state, Money in (receive addresses with
    copy and QR), Limit per day (rolling 24h, survives restart, shown under Limits), Receipt (a
    card per executed action), Unknown outcome recovery (a card for `needs_reconciliation`).
20. **Kill switch ("Freeze everything") also cancels working orders and disarms rules. It never
    closes positions.** Why: closing needs a verb this app deliberately does not hold.
21. **Cuts:** basic loses the Market fold and the donut; pro loses the chart, the donut, the
    fragmentation cost block, the LOG and GAS modals (fees go on Activity rows) and per-row
    staleness badges; trade loses the BOOK panel (merged into Position), the MARKET block,
    maintenance margin, net and gross exposure, the shock line, and four of seven overlay toggles.
    The version number and hex ids leave every screen; hex lives behind the receipt. `watch` now
    sets the trade market list; basic shows no prices.
22. **Deferred, named, not built:** base-unit arithmetic end to end (P2, affects only max-send
    dust), Touch ID (needs signing), a bench harness fix (it relied on `approvalGate: false`; it is
    deleted with the axis).

## 3. Threat model summary and the fixes that close it

| Threat | Fix in this build |
|---|---|
| A sandboxed iframe on any web page posts to `/api/mcp` with `Origin: null` and auto-executes up to $100 | `sameOrigin` rejects the literal `null`; `/api/mcp` and every decision route require a present, matching Origin; `readBody` requires `application/json` |
| Any local process reads the approval token from `GET /api/session` and approves | Route deleted; token injected into the webview only; e2e reads it from env |
| Keys plaintext on disk in four copies | Encrypted envelope, migration destroys plaintext and `.bak` files |
| Hand-launched operator profile greps the key file | `operator/settings.json` denies `Grep` and `Glob` |
| Audit log can be edited or reordered | Each line carries `prev` (SHA-256 of the previous line); `verify()` walks the file |
| Unlocked key readable from the Node heap by a same-user process | Signing configured with hardened runtime; performed by the owner (decision 10) |
| Runner child receives the API wallet key over the environment | Key handed over stdin |
| `role` on the wire is a self-claim | Role decided server-side from the seat, never from the body |
| Caret ranges float on `npm install` | Payload built with `npm ci --omit=dev` |

## 4. API contract between tracks

Every route below is loopback only, behind `hostIsLocal`. Decision routes require the window token
in the body as today. Shapes are exact; builders on other tracks code against them.

| Route | Method | Body | Response | Owner |
|---|---|---|---|---|
| `/api/health` | GET | none | `{ ok: true, version, killSwitch, pending, locked, lastError: string \| null, uptimeSec }`, no token, no secrets | reliability |
| `/api/state` | GET | none | existing payload plus `lock: { state: 'unlocked' \| 'locked' \| 'no_wallet' \| 'needs_migration', idleLocksInSec: number \| null }` and `dailyLimit: { capUsd, spentUsd, resetsAt }` | custody, reliability |
| `/api/unlock` | POST | `{ token, password }` | `{ ok: true }` or `{ ok: false, error: 'wrong_password' \| 'no_wallet' \| 'locked_out' }`; 5 failures start a 30 s backoff | custody |
| `/api/lock` | POST | `{ token }` | `{ ok: true }` | custody |
| `/api/wallet/create` | POST | `{ token, password }` | `{ ok: true, mnemonic: string[12], addresses: { evm, sol, near } }`; the mnemonic is returned exactly once | custody |
| `/api/wallet/import` | POST | `{ token, password, mnemonic?: string, keys?: { evm?, sol?, near? } }` | `{ ok: true, addresses }` | custody |
| `/api/wallet/migrate` | POST | `{ token, password }` | `{ ok: true, destroyed: string[] }` | custody |
| `/api/wallet/reveal` | POST | `{ token, password, what: 'mnemonic' \| 'keys' }` | one-shot nonce flow: returns `{ ok: true, nonce }`, then `GET /api/wallet/reveal/<nonce>` returns the material once and invalidates the nonce | custody |
| `/api/wallet/export` | POST | `{ token, password, path }` | writes the envelope with a fresh salt to `path`, `{ ok: true }` | custody |
| `/api/receive` | GET | none | `{ chains: [{ id, name, address, warning }] }` (addresses come from the keystore header, so it works while locked) | custody |
| `/api/receipts` | GET | `?limit=` | `{ receipts: [{ id, kind, at, summary, fromChain, toChain, amount, symbol, feesUsd, txids: [{ chain, hash, url }], balanceBefore, balanceAfter, status: 'executed' \| 'failed' \| 'needs_reconciliation' }] }` | reliability |
| `/api/reconcile` | POST | `{ token, id }` | re-checks a `needs_reconciliation` proposal against the chain or venue: `{ ok: true, status }` | reliability |
| `/api/driver` | POST | existing actions plus `{ action: 'connection' }` | returns `{ command: 'claude mcp add phosphor -- node <abs path>/src/mcp.ts', connected: [{ name, role, calls }] }` | ui (server side small) |
| SSE `/api/events` | | | new frame `{ type: 'candle', product, provider, baseSec, candle: { t, o, h, l, c, v } }`; new frame `{ type: 'lock', state }`; `meta.feed: 'live' \| 'delayed' \| 'offline'` on chart payloads | chart, custody |

Proposal statuses gain `pending_unlock` and `needs_reconciliation`. `sessionSpentUsd` excludes
`needs_reconciliation`. The window token variable is `PHOSPHOR_WINDOW_TOKEN`; when absent (a bare
`npm run app` for development) the backend mints one and prints it to stderr once.

## 5. Information architecture

Shared shell: top bar 48 px with the wordmark left, the three mode tabs centred (Basic, Pro,
Trade), and a status cluster right: lock chip (Locked / Unlocked, locks in N min), agent chip
(state word and a dot), feed dot (trade only), and Freeze everything. The decision strip ("Waiting
for you") is an overlay on all three views, one request at a time, plain English, cost, why it is
being asked, Yes and No. The receipt card and the unknown-outcome card render in the same overlay
slot.

**Basic.** One 720 px column. Balance hero (one number, one sentence of what just happened, one
sentence of what protects the money). Cards: What you own (rows, no chains, no donut), Earning
(amount earning, what it made, Withdraw), Your assistant (the agent component). Folds: Money in
(receive addresses, copy, QR, the wrong-chain warning), Activity (receipts, newest first). Stop
everything at the bottom. Hidden: chains, gas, hex, percentages under an hour, policy, log, chart.

**Pro.** 12-column grid, max 1440 px, 24 px gutters. Panels: Money (one table with chain, amount,
value, share; Ready to move and Trading money as rows), Earning (supplied, earned, rate today,
ledger with hashes behind a receipt, Withdraw, Auto-earn toggle), Your limits (the policy as
sentences with per-line Edit that files a request; daily limit with spent and reset time;
destination allowlist), Activity (receipts with fees per row and a total for the window), Your
assistant. Freeze everything in the status cluster. No chart, no donut, no modals except receipts.

**Trade.** Full bleed. Chart left (70 percent), right rail 360 px: Position (open position, entry,
mark, value, forced close price and distance in one line), Account (trading money, spare, safety
margin), Your rules (armed rules with budget spent), What happened (fills and cancels), Your
assistant. Chart control row: market, timeframes, indicator field, then the status cluster (feed
dot, venue). Volume pane permanent at 14 percent height. Three overlay toggles: position, forced
close, rules.

**First run** (no keystore): the ten screens from the product audit, in order: What this is, Create
or bring a wallet, Set a password, Save your recovery words, Prove it, Your addresses, Add money,
Connect your assistant, Set the ask threshold, Done. Each screen is one card on the pattern field.

**Locked**: the same card style with a password field and Unlock. Reads continue behind it in the
dimmed shell so the person still sees their balance.

**Migration** (plaintext keys found): one card explaining, password twice, Encrypt now; then the
snapshot caveat and Continue.

**Agent component**: five states, Start (white button), Stop the answer, Stop the assistant, the
transcript (text only, never markup, never an approval control), and an External block: the
connection line in a read-only field with Copy, plus the list of connected external clients (name,
role, calls).

**Waiting moments**: every operation over 300 ms shows a noun-bearing state ("Checking your
money", "Working out what this costs", "Sending", "Waiting for the network", "Moving between
chains", "Putting it to work", "Starting your assistant"). Buttons keep their width, swap the label
for the progress verb with an inline spinner and disable. Panels show a skeleton in the row shape
on first load and a thin top bar on refresh. Failures name the cause and whether anything left the
wallet. Success shows the receipt.

**Glossary** (labels the window uses): Ready to move (NEAR Intents balance), Trading money
(HyperCore collateral), Rule (mandate), Your rules, Your limits (policy), Waiting for you (approval
gate), Request (proposal), Everything is running / Everything is frozen (kill switch), Forced close
price (liquidation), The loss you approved (stop-out), Account value (equity), Spare (free), Safety
margin (health), Holding cost (funding), What happened (tape, history), Fees (gas), Can be frozen
by the issuer (FRZ), Could not check (STALE), Earning (yield), Rate today, Auto-earn (allocator),
Gather onto one chain (consolidate), Market (product), Limit per day (session cap), Too small to
be worth moving (economicTransferUsd).

## 6. Design system

Tokens (light theme is not built; the app commits to one dark look and paints every color).

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#09090B` | window ground |
| `--bg-1` | `#0F1013` | panel |
| `--bg-2` | `#16171B` | raised: inputs, hover rows, the pattern's squares |
| `--line` | `#22242A` | 1 px hairlines |
| `--line-strong` | `#2E3138` | focused borders |
| `--text` | `#EDEEF0` | primary text |
| `--text-2` | `#9A9EA8` | secondary |
| `--text-3` | `#5F636C` | tertiary, disabled |
| `--ink` | `#FFFFFF` | primary action fill, dark label on it; the `accent` theme slot |
| `--up` | `#5B8DEF` | price up, positive delta, live dot |
| `--down` | `#FF5A6E` | price down, negative delta, danger, No |
| `--warn` | `#F2B544` | waiting for a human, unconfirmed, delayed |
| `--agent` | `#B79CFF` | agent chip, transcript accent, working state |
| `--radius` | `12px` panels, `8px` inputs and buttons, `999px` chips | |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | enters |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | on-screen moves |
| `--dur-press` | `160ms` | button press |
| `--dur-enter` | `220ms` | cards, panels |
| `--dur-swap` | `180ms` | view crossfade |

Type: Geist variable (`ui/fonts/Geist-Variable.woff2`) for all UI text; Geist Mono variable
(`ui/fonts/GeistMono-Variable.woff2`) for numbers, addresses, hashes, axes, timestamps. Both
preloaded, `font-display: swap`, `font-optical-sizing: auto`, `font-feature-settings: "tnum"` on
every numeric cell. Scale: 12, 13, 14, 16, 20, 28, 56 (balance, weight 500, tracking -0.025em).
Titles are short noun phrases.

Motion: press `scale(0.97)` 160 ms ease-out on every pressable; enter opacity plus 6 px rise
220 ms, stagger 40 ms; view swap crossfade 180 ms with 2 px blur; number changes crossfade 300 ms,
no digit scrolling; reduced motion keeps opacity only. Nothing animates on a keyboard-initiated
action. The chart's last-price tag and line ease 120 ms.

Signature: the hiding-squares field. A 2D canvas draws a grid (about 17 cells across, cells
square) where each cell clips a square; 2D simplex noise (x, y, slow t) sets each square's offset,
scale and rotation. Squares are `--bg-2` on `--bg-0`. Intensity is app state: idle drifts slowly
(40 s period, low amplitude); agent working raises amplitude and speed; waiting for a click holds
still with one row shifted; locked is calm and dimmer. It sits behind the basic hero, behind the
first-run, lock and migration cards, and inside the agent panel's empty state. Performance
budget: DPR capped at 2, 24 fps only while visible and not static, rAF cancelled on
`visibilitychange`, one pre-rendered frame under reduced motion, under 2 ms per frame.

Layout: basic 720 px column; pro 12-column grid max 1440 with the pattern filling the margins
beyond it; trade full bleed. No `max-width` on `#page`, no `100dvh` cap with `overflow: hidden` at
the page level: the page scrolls when content is taller than the window, panels do not scroll
inside themselves except tables over 12 rows. Every panel has a content-driven min height; the
resizer floors are raised so nothing can be squeezed below its content.

## 7. Verification

- `npm run typecheck` clean, `npm test` green (the suite grows: keystore, hash chain, tolerant
  readers, crash handlers, reconciliation, timeouts, idempotency, live market, origin `null`, no
  token route), `npm run e2e` green with the token from env.
- `grep -rIi testnet` over the tree (excluding `.git`, `node_modules`, `target`, `state/`) returns
  nothing. `grep -rn "gate_disabled" src` returns only the read-side type.
- No green: `grep -rniE "#33ff66|#3f6\b|#8cffab|#a3e635|#2dd4a7|rgba\(51, ?255, ?102" ui src/view`
  returns nothing.
- Chart: a script that subscribes to `/api/events` and measures the age of the painted close
  against the venue socket reports under 500 ms p50 while live.
- The app runs in the Tauri window (`npm run tauri dev`): first run creates a wallet, locks and
  unlocks, shows receive addresses, starts the built-in assistant, switches all three modes, and
  every screenshot is reviewed against section 6.
- `curl 127.0.0.1:4177/api/session` returns 404. `curl -H 'Origin: null' -X POST /api/mcp` returns
  403.
