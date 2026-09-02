# Phosphor v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is track-based: each track is executed by one agent in its own git worktree, and file:line detail for a task lives in the audit named in that task (the audits sit in the session scratchpad at `scratchpad/audit/{backend,security,ui,chart,testnet,product}.md`; copies travel with the track briefs).

**Goal:** Turn Phosphor from a hand-fitted hull into a reliable, locked, mainnet-only desktop app with a live chart and a modern monochrome interface across basic, pro and trade.

**Architecture:** Node 24 TypeScript backend (no bundler, node runs .ts directly) behind a Tauri 2 shell that loads http://127.0.0.1:4177; vanilla HTML/CSS/JS UI in `ui/`; MCP server in `src/mcp.ts`. The backend gains a crash frame, durable state, an encrypted keystore with a window-only unlock, a live market rail, and an `src/http/*` split. The UI is rewritten on a token-based design system with one shell and three views.

**Tech Stack:** TypeScript 5.9, viem 2, zod 3, @modelcontextprotocol/sdk 1, Tauri 2 (Rust), node:test, node:crypto (scrypt, AES-256-GCM, HMAC-SHA512), Geist and Geist Mono (vendored woff2).

**Spec:** `docs/superpowers/specs/2026-09-01-phosphor-v1-reliable-boat-design.md`

## Global Constraints

- Mainnet only. After track C, `grep -rIi testnet` over the tree (excluding .git, node_modules, target, state/) returns nothing.
- No green anywhere in `ui/` or `src/view/`: `#33ff66`, `#3f6`, `#8cffab`, `#a3e635`, `#2dd4a7`, `rgba(51,255,102,*)`, oklch greens.
- No em or en dashes in any file. No AI attribution in commits. Commit messages are one descriptive sentence in the repo's existing style ("The chart reads its own venue, and says so").
- No new npm dependencies. The QR encoder for receive addresses is vendored as one MIT file (`ui/vendor/qrcode.js`, from the `qrcode-generator` package after verifying name, downloads and last release) with its licence header kept.
- Every file under 500 lines in `src/http/`, `src/proposals/`, `src/keystore/`, `ui/screens/`, `ui/core/`.
- Every fetch has an AbortSignal: 10 s reads, 30 s venue writes.
- No `window.confirm`, no `alert`. No `transition: all`. No `ease-in` on UI motion. No `scale(0)` entries. Hover styles gated by `@media (hover: hover) and (pointer: fine)`.
- Labels follow the spec glossary. "Loading" is banned as a label; every wait names a noun.
- Never run the app against the real data dir or real keys from a worktree. Development runs use `PHOSPHOR_MODE=demo PHOSPHOR_PORT=<private> PHOSPHOR_DATA_DIR=<scratch>`. Never call `mcp__phosphor__*` tools. Never touch `~/.phosphor` except through the keystore tests, which use a temp dir.
- `npm run typecheck` and `npm test` green before every commit. `npm run e2e` green before a track is declared done.

---

## Phase 0: foundations on main (serial)

### Track C: delete the network axis (branch `feat/mainnet-only`, then merged to main first)

**Audit:** `testnet.md` (file-by-file verdicts, the 44 signatures, the ten tables, the seven answers).

**Files:** `src/types.ts`, `src/config.ts`, the ten `Record<Network, ...>` tables (`ledger/index.ts`, `chain/near.ts`, `chain/evm.ts`, `transactions.ts`, `yield/aave.ts`, `rails/hypercore-deposit.ts`, `rails/uniswap-abi.ts` x2, `rails/hyperliquid-withdraw.ts`, `runner/keys.ts`), the 44 functions listed in the audit, `policy/gate.ts` (deleted), `proposals.ts:384-402`, `server.ts` gate fields, `greeting.ts`, `view/basic.ts`, `strategy/catalog.ts`, `trade/funding.ts`, `trade/service.ts`, `main.ts`, `scripts/*` (delete testnet-only scripts: near-prove, hl-verbs-smoke, and the bench harness's gate line), `data/tokens.testnet.json` (deleted), `config.json`, tests (delete `trading-network.test.ts` and `gate.test.ts`; strip fixtures in the 30 REWRITE-TEST files), docs (`README.md`, `SECURITY.md`, `DISCLAIMER.md`, `docs/architecture.md`, `docs/security-model.md`, the testnet spec deleted, DELETE-LINE in eight specs), `ui/app.js:875`, `ui/trade.js:816-823`, `.design/brief.md:46`, `.probe/*`.

- [ ] Step 1: `src/types.ts`: delete `Network`; delete `network`, `tradingNetwork`, `approvalGate` from `AppConfig`; narrow `decidedBy` on the write side to `'human' | 'policy'`, keep `'gate_disabled'` readable in the type used by `transactions.ts:131`.
- [ ] Step 2: `src/config.ts`: delete `isNetwork`, the `PHOSPHOR_NETWORK` and `PHOSPHOR_TRADING_NETWORK` reads, the `approvalGate` override, and the three fields from the literal. `loadConfig` no longer throws for a missing network.
- [ ] Step 3: collapse the ten tables to their mainnet arm inline. For `yield/aave.ts`, add the verified mainnet markets (decision 2): Arbitrum Pool `0x794a61358D6845594F94dc1DB02A252b5b4814aD` with USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, Base Pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` with USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Verify each by calling `getReserveData(asset)` on the Pool over `https://arbitrum-one-rpc.publicnode.com` and `https://base-rpc.publicnode.com` with a 20-line `node -e` viem script, and record the returned `aTokenAddress` in the table with the block number you read at. If a call fails, leave that chain out and make `marketFor` return `null` with the tools answering "Earning is not available on <chain>" instead of throwing. For `rails/uniswap-abi.ts`, add Arbitrum mainnet: factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`, position manager `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`, quoter v2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`, router `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, ETH/USD feed `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612`, tokens USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`, DAI `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1`; verify `factory()` on the position manager equals the factory before committing.
- [ ] Step 4: remove the 44 network parameters and fix every call site until `npm run typecheck` is clean.
- [ ] Step 5: the gate: delete `policy/gate.ts`; in `proposals.ts` unwrap the pending path and delete the auto-approve else branch and both `gate_disabled` writes; `server.ts` gate fields become `{ required: true, banner: null }`; `greeting.ts` and `view/basic.ts` drop the gate fact. Add a test in `proposals.test.ts` asserting a normal proposal above the threshold lands `pending` and no path writes `gate_disabled`.
- [ ] Step 6: `runner/keys.ts`: read `hyperliquidAgents.mainnet` first, then the flat legacy field; never delete a testnet entry from a user's file. `readApiWallet.source` becomes `'present' | 'absent'`. `runner/host.ts:319` default limits: audit the `deps.limits` call sites and keep the smaller ceiling as the fallback.
- [ ] Step 7: `scripts/keygen.ts`: delete the network field and the testnet banner; header states plainly that this script is superseded by in-app wallet creation (track A) and mints raw keys for developers only.
- [ ] Step 8: tests: delete the two axis tests, strip fixtures in the 30 files, `npm test` green.
- [ ] Step 9: docs: README (delete the Testnet setup section and faucet table, rewrite the Aave table with the verified mainnet rows, fix the config reference), SECURITY.md, DISCLAIMER.md (state truthfully what has run on mainnet: funding through NEAR Intents into HyperCore and a mandate that opened and closed a real SOL position, both on 2026-08-20), architecture.md, security-model.md (delete the gate-off section), delete the testnet spec, DELETE-LINE in the eight specs, `.design/brief.md`, `.probe/`.
- [ ] Step 10: `grep -rIi testnet` excluding .git, node_modules, target, state returns nothing. `npm run e2e` green (remove `approvalGate` from `scripts/e2e.ts`). Commit.

**Flag for the owner (do not edit):** `config.local.json` lists `phosphor.testnet` under `addresses.near`; on mainnet it returns UNKNOWN_ACCOUNT and the NEAR column goes stale. It should become the implicit hex account from `npm run keys:where` or `[]`.

### Track S: split the server (branch `feat/http-split`, merged to main second)

**Audit:** `backend.md` section 4 (the responsibilities map with line ranges and the target layout).

**Files:** `src/server.ts` becomes `src/http/{context,respond,auth,sse,chats,state,chart,mutation,propose,view,trade,mcp,router}.ts` plus `src/http/read/{wallet,market,chart,agents,yield,gas}.ts`; `src/proposals.ts` becomes `src/proposals/{draft,execute,lifecycle}.ts` with `src/proposals.ts` re-exporting the public surface so imports do not change.

**Interfaces:** `export type Ctx = ServerDeps & { token: string; sse: SseHub; chats: ChatRegistry; chart: ChartStore; drawings: DrawingStore; board: Board; crew: () => Crew; recent: RecentEvents }`. Every handler is `(ctx: Ctx, req, res, body: JsonBody) => Promise<void>`. `createServer(deps)` builds the Ctx and wires `router.ts`. `respond.ts` exports one `fail(res, status, message, extra?)` and every error response goes through it (the 66 `{error}` sites and the 26 bare shapes converge here).

- [ ] Step 1: create `context.ts` and move the closure bindings into the Ctx; `server.ts` still works. Typecheck, test, commit.
- [ ] Step 2 to 13: one module per commit in the audit's order (respond, auth, sse, chats, state, chart, mutation, read/*, propose, view, trade, mcp), tests green between each.
- [ ] Step 14: `router.ts` as a route table; `server.ts` is about 120 lines. `wc -l src/http/*.ts src/http/read/*.ts` all under 500.
- [ ] Step 15: split `proposals.ts` into draft, execute, lifecycle. `npm test`, `npm run e2e` green. Commit.

## Phase 1: parallel tracks in worktrees (branched from main after Track S)

### Track B: reliability (branch `feat/reliability`)

**Audit:** `backend.md` sections 2 and 3, tasks 1 to 15 and 17.

**Files:** `src/audit.ts`, `src/store.ts`, new `src/fsatomic.ts`, `src/main.ts`, `src/runner/host.ts`, `src/runner/main.ts`, `src/http/router.ts` and `src/http/respond.ts` (error listener, health route), `src/proposals/lifecycle.ts` (reconciliation, lock split, daily cap), `src/chain/evm.ts`, `src/chain/near.ts`, `src/rails/{oneclick,intents-deposit,yield,hyperliquid-withdraw,intents-native,uniswap}.ts`, `src/hl/exchange.ts`, new `src/net.ts` (`withTimeout`), `src/http/propose.ts` (amount bounds), `src/transactions.ts` (receipts), `src-tauri/src/main.rs` (supervision, Drop, pid file, token env and injection, see Track A interface), tests under `tests/unit/`.

**Interfaces produced:** `GET /api/health`, `GET /api/receipts`, `POST /api/reconcile`, `dailyLimit` on `/api/state`, statuses `needs_reconciliation`; `PHOSPHOR_WINDOW_TOKEN` read by the backend (mint and print to stderr once when absent); `initialization_script` in `main.rs` sets `window.__PHOSPHOR_TOKEN__` on the control webview; `main.rs` refuses to attach to a port it did not spawn and says so in a dialog.

- [ ] Task 1: tolerant readers (`audit.tail` skips torn lines; `store.readAll` treats empty-but-existing as corrupt, renames to `.corrupt`, refuses to boot with a named error). Test with a truncated audit line and a garbage proposals.json.
- [ ] Task 2: crash handlers in `main.ts` (`unhandledRejection`, `uncaughtException`: audit, mirror to stderr, exit nonzero), `child.on('error')` and the `connected` guard in `runner/host.ts`, wrap the runner's message handler and the tick, `base.on('error')` with a readable EADDRINUSE message. Test: flip the kill switch with a dead runner child and the app survives.
- [ ] Task 3: `fsatomic.ts` with fsync of the tmp fd and of the directory after rename; adopt in all seven writers. `grep -rn fsync src/` returns one file.
- [ ] Task 4: boot reconciliation: `executing` rows become `needs_reconciliation` carrying their txids, excluded from the daily cap, rendered as "this may or may not have sent". `POST /api/reconcile` re-checks against the chain or venue.
- [ ] Task 5: single instance lock file with pid; second boot exits with a named error.
- [ ] Task 6: clean shutdown: SIGINT, SIGTERM, SIGHUP registered unconditionally; draining flag returns 503 on mutations; await the proposal chain with a 2 s cap.
- [ ] Task 7: never drop a hash: `chain/evm.ts` and `chain/near.ts` return the hash in the catch; the two "No funds left the wallet" sentences branch on it; `rails/yield.ts` pushes the hash before the ok check. Test with a transport that broadcasts then throws on receipt.
- [ ] Task 8: `src/net.ts` `withTimeout(ms)` at all 27 fetch sites. The count of `fetch(` sites equals the count passing a signal.
- [ ] Task 9: idempotent Hyperliquid writes: reuse `time` and nonce on retry; derive the cloid from (mandate id, leg, nonce window). Test: a retried withdraw is rejected as a duplicate by a fake venue.
- [ ] Task 10: amount bounds at the three propose sites and the four mandate numbers; `chainField` returns null.
- [ ] Task 11: shell supervision in `main.rs`: readiness thread keeps polling `try_wait()`, a post-boot exit shows a banner and respawns once with backoff; `impl Drop for Backend`; pid file at spawn; on launch, a listening port whose pid is not ours is refused with a dialog naming the pid. Token: mint 32 random bytes hex in Rust, pass as `PHOSPHOR_WINDOW_TOKEN` to node, inject `window.__PHOSPHOR_TOKEN__ = "<hex>"` via `initialization_script` on the control window only.
- [ ] Task 12: observability: `GET /api/health`, `error` and `app_start` mirrored to stderr, `audit.tail` as a positioned read of the last 256 KB, `lastError` in memory.
- [ ] Task 13: split the proposal lock (serialise evaluate-and-reserve only).
- [ ] Task 14: quote echo in `intents-native` execute, recipient check in `uniswap` execute, verifier re-read after an intents swap.
- [ ] Task 15: daily limit: make the rolling 24 h cap survive restart (verify how `sessionSpentUsd` reads today; persist what it needs), expose `dailyLimit` on state, exclude `needs_reconciliation`.
- [ ] Task 16: receipts: `GET /api/receipts` built from proposals plus transactions (shape in the spec), including `balanceBefore` and `balanceAfter` from the ledger snapshots the rails already take.
- [ ] Task 17: failure-mode tests: crash and restart, corrupt files, injected fetch hang, two concurrent mutations, malformed EVM, Solana and NEAR RPC shapes.
- [ ] Task 18: `scripts/bundle-payload.ts` uses `npm ci --omit=dev`. Commit per task.

### Track A: security and custody (branch `feat/custody`)

**Audit:** `security.md` sections 2 to 4.

**Files:** `src/http/auth.ts` (origin, token, Content-Type), `src/http/router.ts` (delete `/api/session`; add unlock, lock, wallet/*, receive), new `src/keystore/{envelope,kdf,store,derive,session}.ts`, `src/chain/evm.ts`, `src/chain/near.ts`, `src/rails/intents-native.ts`, `src/rails/hyperliquid-withdraw.ts`, `src/runner/keys.ts`, `src/runner/host.ts` (key over stdin; signing session), `src/proposals/lifecycle.ts` (`pending_unlock`), `src/audit.ts` (hash chain), `operator/settings.json`, `src/agents.ts` (server-side role), `scripts/e2e.ts` (token from env), `src-tauri/` entitlements plist and `tauri.conf.json` signing hook keyed to `APPLE_SIGNING_IDENTITY`, tests.

**Interfaces produced:** the routes in spec section 4 (`unlock`, `lock`, `wallet/create`, `wallet/import`, `wallet/migrate`, `wallet/reveal`, `wallet/export`, `receive`), `lock` on `/api/state`, SSE `{type:'lock', state}`. **Consumes:** `PHOSPHOR_WINDOW_TOKEN` and `window.__PHOSPHOR_TOKEN__` from Track B (coordinate the variable name; Track A owns reading it in `auth.ts`, Track B owns minting and injecting it).

- [ ] Task 1: `sameOrigin` rejects the literal `'null'`; `/api/mcp` and every decision route require a present matching Origin; `readBody` requires `Content-Type: application/json`. Tests: `Origin: null` gets 403, `text/plain` gets 415.
- [ ] Task 2: delete `GET /api/session`; `auth.ts` reads the token from `PHOSPHOR_WINDOW_TOKEN`; `scripts/e2e.ts` passes it in the child env and uses it. Test asserts no route serves a token.
- [ ] Task 3: audit hash chain (`prev` = SHA-256 of the previous line) plus `verify()`; test tampers with a middle line.
- [ ] Task 4: `operator/settings.json` denies `Grep` and `Glob`; a test parses the file.
- [ ] Task 5: `src/keystore/envelope.ts` (AES-256-GCM, header as AAD), `kdf.ts` (scrypt N=2^18 r=8 p=1, 32-byte salt), `store.ts` (load header, unlock into a zeroable `Buffer`, lock zeroes, `isUnlocked`, `addresses()`), `derive.ts` (BIP39 12 words via viem's english wordlist, EVM `mnemonicToAccount`, SLIP-0010 ed25519 for Solana m/44'/501'/0'/0' and NEAR m/44'/397'/0', base58 for both). Tests: wrong password fails, tampered ciphertext fails the GCM tag, lock zeroes the buffer, a known test mnemonic derives the known EVM address and the known Solana address (use the published BIP39 test vector "abandon abandon ... about" and assert the EVM address `0x9858EfFD232B4033E47d90003D41EC34EcaEda94` and the Solana address `HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk`).
- [ ] Task 6: every signer takes the unlocked handle instead of reading keys.json; every reader takes an address from the header (the five sites in the audit). Migration: `wallet/migrate` performs the verify-then-destroy sequence from spec decision 9 and destroys the three `.bak` files too.
- [ ] Task 7: routes: unlock (5 failures start a 30 s backoff), lock, wallet/create (mnemonic returned once), wallet/import, wallet/reveal (one-shot nonce, invalidated on use), wallet/export, receive. `lock` on `/api/state`. SSE lock frame. No unlock op in `/api/mcp`; test asserts the tool surface and op list are unchanged.
- [ ] Task 8: auto-lock: idle timer fed only by a `POST /api/activity` beacon the window sends on pointer and key events at most once per 30 s; lock on `sleep` (Tauri emits an event Track B forwards as `POST /api/lock` with the token) and on window close; a test drives the timer with an injected clock and shows agent calls do not refresh it.
- [ ] Task 9: `pending_unlock`: a write proposal authored while locked is evaluated and queued; on unlock the queue is re-evaluated and lands as pending or executes under policy. Test.
- [ ] Task 10: signing session for armed rules: expiry at arm (default 8 h, max 24 h), only the Hyperliquid API wallet key, handed to the runner child over stdin, killed and wiped on expiry or disarm; expiry shown on the armed row and in the audit line.
- [ ] Task 11: server-side role from the seat, not the body. Signing config: entitlements plist (hardened runtime, no `get-task-allow`), `tauri.conf.json` `bundle.macOS.signingIdentity` from `APPLE_SIGNING_IDENTITY`, documented in README. Commit per task. Ask Track B (SendMessage) before touching `main.rs`.

### Track D: live chart (branch `feat/live-chart`)

**Audit:** `chart.md` (measurements, design, tasks 1 to 8).

**Files:** `src/market/store.ts`, new `src/market/live.ts`, `src/market/index.ts`, `src/main.ts`, `src/http/sse.ts` and `src/http/chart.ts` (after Track S lands; do the socket and store work first), `ui/chart.js` (rendering core kept; `candleLive`, tween, status dot, volume pane, control row), tests.

**Interfaces produced:** SSE frame `{ type: 'candle', product, provider, baseSec, candle }` and `meta.feed: 'live' | 'delayed' | 'offline'`. `store.put()` gains an `onLive` emitter.

- [ ] Task 1: the constants (`minGap` 250, `CANDLE_PUSH_MS` 250, 1m staleness 1 s). Measure with the audit's ablation script; expect about 1.2 s p50.
- [ ] Task 2: `src/market/live.ts`: one socket per venue, subscriptions keyed `provider:product` at 1m, Hyperliquid `candle` mapping, Coinbase `matches` bucketing seeded from the REST bar, backoff to 15 s, a `FeedSocket` test seam like `feed-ws.ts`. Unit tests offline.
- [ ] Task 3: wire `store.put()` and the emitter in `main.ts`.
- [ ] Task 4: the SSE frame coalesced at 120 ms; keep the nudge for the REST fallback.
- [ ] Task 5: `ui/chart.js` `candleLive(frame)`: match view, fold to timeframe, mutate or append, invalidate, buffer during drag.
- [ ] Task 6: states through `meta.feed`, staleness relaxed to 30 s while live; kill the socket and confirm delayed then live again with no gap.
- [ ] Task 7: cold-series bridge from the finest cached base so timeframe switches never blank.
- [ ] Task 8: chart chrome in the new design system's colours (coordinate tokens with Track E: read `ui/design/tokens.css` from the `feat/ui-v2` branch): permanent volume pane at 14 percent, one control row, status cluster, wider right gutter, 120 ms tween on the price tag and line, `chartTheme` reads `--up`, `--down`, `--text-2`, `--line`. Commit per task.

### Track E: interface (branch `feat/ui-v2`)

**Audit:** `ui.md` (keep and rewrite verdicts, defects, performance), `product.md` (modes, first-run screens, waiting moments, glossary), spec sections 5 and 6, and the design direction file in the scratchpad.

**Files:** new `ui/design/{tokens,reset,type,components}.css`, `ui/design/motion.js` (one rAF scheduler with a reduced-motion gate; every canvas registers here), `ui/design/pattern.js` (the hiding-squares field), `ui/core/{net,events,state,dom,api}.js`, `ui/screens/{shell,basic,pro,trade,agent,decision,receipt,firstrun,lock}.js`, `ui/chart/` (chart.js and trade-overlay.js moved, rendering core kept), `ui/vendor/qrcode.js`, `ui/fonts/{Geist-Variable,GeistMono-Variable}.woff2` (copied from `~/Developer/Apps/pakkr-desk/node_modules/geist/dist/fonts/`), `ui/index.html` (rewritten, hosts all three views), `ui/theme.js` (kept, slots remapped), `ui/overlay.js`, `ui/split.js` (kept, floors raised), `ui/approvals.js` (diff logic kept). Deleted: `ui/trade.html`, `ui/agent-globe.js`, `ui/transition.js`, `ui/presence.js`, `ui/deck-views.js`, `ui/style.css`, `ui/basic.css`, `ui/trade.css`, `ui/fonts/amulya-var.woff2`, `ui/fonts/sometype-mono.woff2`, the box-drawing frame system. Server side, small and after Track S: `src/http/chats.ts` gains the `connection` action; `src/view/mode.ts` keeps three modes; `scripts/bundle-payload.ts` copies the new folders.

**Consumes:** every route in spec section 4. Routes that exist today: state, driver, approve, refuse, kill, yield/withdraw, transactions, chart, trade, trade/action, log, gas, events. New routes land on main from Tracks A and B; build against the contract, render the honest empty state until they exist, then integrate after the lead says main has them.

- [ ] Task 1: design system: tokens, reset, type (both faces, optical sizing, tnum), components (button with press and pending states, panel, card, table with sticky header, chip, banner, sheet, dialog, meter, skeleton, toast), motion.js, pattern.js with the four intensity states and the performance budget. A standalone `ui/design/preview.html` renders every component and every state; screenshot it at 1440 and 1920.
- [ ] Task 2: shell: top bar, mode tabs, status cluster, view crossfade, the decision overlay, the SSE client with a visible offline state, the ETag fetch layer with in-flight dedup and one `busy()` contract, the keyed list reconciler (no `textContent = ''` rebuilds).
- [ ] Task 3: basic view per spec section 5, on the pattern field, with Money in (copy, QR, warning) and Activity (receipts).
- [ ] Task 4: pro view: Money table, Earning, Your limits (with daily limit and allowlist), Activity, agent. No chart, no donut, no modals except receipts.
- [ ] Task 5: trade view: chart left, rail right (Position, Account, Your rules, What happened, agent), three overlay toggles, resizer floors raised so no panel drops below its content.
- [ ] Task 6: agent component: five states, Start, Stop the answer, Stop the assistant, transcript, External block with the connection line and connected clients. `TOOL_PHRASES` carried verbatim.
- [ ] Task 7: lock screen, migration screen, first-run flow (ten screens), receipt card, unknown-outcome card. Build after main has Tracks A and B; rebase `feat/ui-v2` on main first.
- [ ] Task 8: performance pass: no rAF loop runs while idle, DPR capped at 2 everywhere, no forced reflow in a loop, resize debounced, `/api/trade` ETag-conditional. Measure with the Performance panel in a headless Brave run against a demo backend: idle CPU under 1 percent.
- [ ] Task 9: `set_theme` mapped to the new slots; `theme.ts` contrast floors unchanged; a test that the five slots still validate.
- [ ] Task 10: screenshots of every view and state at 1440x900 and 1920x1200 saved to `.design/v1/`; a self-review table (before/after) against spec section 6. Commit per task.

## Phase 2: merge and verify (lead, serial)

- [ ] Merge order: `feat/reliability`, `feat/custody`, `feat/live-chart`, then tell Track E to rebase and finish Task 7, then merge `feat/ui-v2`.
- [ ] After each merge: `npm run typecheck`, `npm test`, `npm run e2e`, the grep gates from spec section 7.
- [ ] Run the app in the Tauri window (`npm run tauri dev`), walk the first run in a scratch data dir (`PHOSPHOR_DATA_DIR`, `PHOSPHOR_KEYS` pointed at a temp file), lock, unlock, receive, start the assistant, all three modes; screenshot each.
- [ ] Reviews: a security review (security-audit skill) of the merged custody and auth code; a code review for correctness and simplification; a design review of the screenshots against spec section 6. Fix what they find.
- [ ] README rewrite: what it is, how to run it, how to test it. Nothing else.
- [ ] Vault flush: project note State, Decisions for custody and the chart rail, a Lesson on stacked poll throttles.
