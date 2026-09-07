# Phosphor window v2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Phosphor window around the conversation and the beam on the existing backend, and close the verified holes the audits found, without adding a feature.

**Architecture:** One stage (already committed at `7d358c7`): the conversation column on the left in every mode, the world on the right. The column is `ui/screens/agent.js` plus the decision dock in `ui/screens/decision.js`; the beam is `ui/beam/beam.js` driven by `ui/beam/trace.js` from `driver` frames; the world is `basic.js`, `pro.js`, `trade.js` restyled onto surfaces with `data-surface` ids. Backend fixes are separate tracks on disjoint files.

**Tech Stack:** Vanilla JS in `ui/` (no framework, no build step, CSP forbids inline script, every file assigns one `window.Phosphor*` namespace and waits for `app.js`), CSS custom properties, Web Animations API and CSS transitions, one 2D canvas for the beam, the existing WebGL field. Node 24 backend, `node --test`. No new dependency anywhere.

**Spec:** `docs/superpowers/specs/2026-09-07-phosphor-window-v2-beam-design.md`. Contract: `docs/superpowers/specs/2026-09-07-phosphor-ui-contract.md` (facts about every route, frame, store key, and the tests that read `ui/`). Audits: `audit-A-agent-channel.md`, `audit-B-custody-policy.md`, `audit-C-rails-chains.md`, `perf-audit.md` in the session scratchpad, paths given in each track's brief.

## Global constraints

- Branch base: `feat/window-v2-beam` at `7d358c7`. Every track works in its own worktree and branch (`wt/<track>`), commits there, and reports the branch. The lead merges in the order given in the last section.
- No em dashes anywhere (code, comments, commits, docs). No all-caps labels. No dot-joined meta strings. Sentence case. Titles are short noun phrases.
- Copy is the spec's copy table, verbatim.
- Tokens: only `ui/design/tokens.css` names a colour. The five `set_theme` slots keep their names and meanings (`--ink`, `--bg-0`, `--up`, `--down`, `--agent`).
- Only `transform` and `opacity` animate. No `transition: all`. No animated `box-shadow`, `filter`, `backdrop-filter`, `width`, `height`. Reduced motion keeps opacity only.
- A `state` frame never rebuilds a list: keyed `dom.reconcile`, text and attribute writes only. No layout reads on a heartbeat frame (perf audit rules 4 to 9).
- The transcript is text only, never markup; the decision dock renders from `state.proposals` only; nothing from a frame reaches the DOM as HTML. `tests/unit/agent-panel-ui.test.ts` keeps asserting this.
- Tests that read `ui/` (contract section 11) either keep passing or change in the same commit with the reason in the commit message.
- Commit messages in the repo's voice: one sentence that says what changed and why, no prefix, no attribution footer.
- Verification for every UI track: `npm test` green in the worktree, then captures through the recipe in `verify-recipe.md` (scratchpad) at 1440x900, read by eye, and the paths listed in the report.

## File ownership (locked)

| Track | Owns (may edit) | Must not touch |
|---|---|---|
| T2 conversation | `ui/screens/agent.js`, `ui/screens/decision.js`, `ui/screens/receipt.js`, the "conversation column" and "decision dock" sections of `ui/design/screens.css` and `ui/design/layout.css`, `tests/unit/agent-panel-ui.test.ts`, `tests/unit/approvals-diff.test.ts`, new `tests/unit/decision-dock-ui.test.ts` | everything else in `ui/`, any `src/` |
| T3 beam | `ui/beam/beam.js`, `ui/beam/trace.js`, `ui/design/pattern.js`, `ui/design/motion.js`, the "Surfaces" block of `ui/design/components.css`, the "locked" block of `ui/design/screens.css`, new `tests/unit/beam-ui.test.ts`, new `tests/unit/trace-ui.test.ts` | `agent.js`, `decision.js`, the world screens, any `src/` |
| T4 world | `ui/screens/basic.js`, `ui/screens/pro.js`, `ui/screens/trade.js`, `ui/screens/lock.js`, `ui/screens/firstrun.js`, `ui/screens/moneyin.js`, `ui/screens/receipts.js`, `ui/screens/feedback.js`, `ui/chart/chart.js` (palette constants and chrome classes only), `ui/chart/trade-overlay.js` (colours only), the basic, pro, trade, money in, first run, limits, activity sections of `ui/design/screens.css` and `ui/design/layout.css`, `tests/unit/chart-chrome-ui.test.ts`, `tests/unit/basic-view.test.ts`, `tests/unit/trade-fills-ui.test.ts` | `agent.js`, `decision.js`, `beam/*`, `pattern.js`, any `src/` |
| T5 rails | `src/http/propose.ts`, `src/proposals/rails.ts`, `src/rails/oneclick.ts`, `src/rails/intents-native.ts`, `src/rails/hl-deposit.ts` (or wherever the HyperCore deposit floor lives), `src/config.ts`, `src/policy/engine.ts` (Solana case rule only), `src/market/*` (staleness bound), their tests | `ui/`, `src/http/state.ts`, `src/audit.ts`, `src/store.ts` |
| T6 performance | `src/http/state.ts`, `src/http/respond.ts`, `src/http/router.ts` (one new paged route), `src/audit.ts`, `src/store.ts`, `src/proposals/lifecycle.ts` (the read-once change), `src/main.ts` (verify after listen), `src-tauri/src/main.rs` (probe cadence), `ui/core/state.js` (`same()` shallow compare), `ui/core/api.js` (the new route), their tests | everything else in `ui/`, `src/rails/*`, `src/policy/*` |
| T7 agent channel and custody | files named by audits A and B, decided when they land | `ui/` |

## Locked interfaces

### `window.PhosphorAgent` (T2 produces, shell and trace consume)

```js
mount(host, { composerHost })  // builds head, empty state, transcript into host; the composer into composerHost
start()                        // subscribes to driver frames, loads driver state and the connection line
isWorking() -> boolean
phase() -> 'idle' | 'starting' | 'connected' | 'working' | 'error'
toolLabel(name) -> string      // unchanged contract, table extended per the spec
```

Every step row dispatches on `window` a `CustomEvent('phosphor:step', { detail: { id, name, state, node } })` where `state` is `'live'` when the tool call opens, `'done'` or `'error'` when its result lands, and `node` is the row's dot element. T3 listens; T2 never calls the beam.

### `window.PhosphorDecision` (T2)

```js
boot()                         // reads #overlay and #overlay-card, subscribes to the proposals slice
render()
showReceipt(receipt)
diffOf(before, after); refineDiff(diff)   // unchanged, tests read them
```

The dock calls `window.PhosphorTrace.surfaceForProposal(proposal.kind)` and `window.PhosphorBeam.wait(id, true)` when a card appears, `wait(id, false)` when it leaves. Both calls guarded by `typeof`.

### `window.PhosphorBeam` (T3)

```js
fire({ from, to, tone })       // from: element or {x, y}; to: surface id; tone: 'glow' | 'wait' | 'down'
hold(id)                       // scan while a tool is in flight
release(id, ok)                // stop the scan; glow then decay; rose when ok is false
decay(id)                      // glow once and fade, no flight
wait(id, on)                   // amber glow held while on
surface(id) -> Element | null  // the surface in the active view; a surface that only exists in a hidden view resolves to that view's tab (tab-basic, tab-pro, tab-trade); 'window' is #stage, 'assistant' is #conversation
```

Attributes the beam writes, and nothing else: `data-glow="on"` (removed on decay), `data-glow-tone="glow|wait|down"`, a `.surface-scan` child appended on hold and removed on release. The canvas is `#beam`.

### `window.PhosphorTrace` (T3)

```js
start()
surfaceOf(toolName) -> { id, tone }
surfaceForProposal(kind) -> id
```

Tool to surface table: section 6 of the spec. Proposal kinds: `swap`, `consolidate`, `intents_withdraw` to `holdings`; `yield_deposit`, `yield_withdraw` to `earning`; `intents_deposit` to `moneyin`; `hl_deposit` to `account`; `policy_change`, `mandate` to `rules`.

### Surfaces (T4 places them)

`data-surface` values inside the views: Basic `holdings`, `rules` (the strip), `earning`, `moneyin`, `activity`; Pro `holdings`, `earning`, `rules`, `activity`; Trade `chart`, `position`, `account`, `rules`, `fills`. The shell already carries `tab-basic`, `tab-pro`, `tab-trade`, `window`, `assistant`.

---

## Track T2: the conversation column and the decision dock

**Files:** see ownership. Rewrite `ui/screens/agent.js` in place (the test reads it by path). The stub `mount(host, opts)` call from `shell.js` passes `{ composerHost: document.getElementById('composer-host') }`.

- [ ] **Step 1: update `tests/unit/agent-panel-ui.test.ts` first.** The button allowlist becomes exactly `['Start your assistant', 'Stop the answer', 'Stop', 'Connect your own', 'Copy', 'Send']`. Add tests: `toolLabel('gas_report') === 'checking gas'`, `toolLabel('propose_yield_deposit') === 'asking to put money to work'`, `toolLabel('propose_policy_change') === 'asking to change a rule'`, `toolLabel('set_theme') === 'recolouring the window'`; `phase()` is exported and returns `'idle'` before any frame; the source contains `'phosphor:step'` and does not contain `PhosphorBeam` (the column never calls the beam). Run: `node --test tests/unit/agent-panel-ui.test.ts`, expect failures on the new assertions.
- [ ] **Step 2: rewrite `agent.js`.** Head (title, state chip with the spec's six words, Start your assistant / Stop the answer / Stop). Empty state on the field: "Nobody is at the wheel." (`.title`), "Start your assistant, or connect one you already use." (`.meta`), actions Start your assistant (`btn btn-primary`) and Connect your own (`btn btn-ghost`) which reveals the connection block (line plus Copy) below the actions. Transcript rows per the spec: `chat-said` on a raised ground, `chat-text` plain, steps as `.steps > .step[data-state]` with `.step-dot`, `.step-text`, `.step-time`; the live turn open, finished turns folded behind a `.steps-fold` button reading "N steps, S s" (`N` and `S` from the turn); a `.thinking` row inserted 300 ms after `said` when no frame has arrived and removed on the first frame; error rows in `chat-error`. Composer built into `composerHost`: a `textarea.input` (rows 1, `field-sizing: content`, Enter sends, Shift+Enter breaks), Send (`btn btn-primary`), and a `.composer-note` "Start your assistant to talk to it." shown with the textarea disabled while the phase is `idle`, `starting` or `error`. Elapsed time on a live step ticks at 10 Hz from one interval that exists only while a step is live. `phase()` exported. The transcript scrolls to the bottom on push only if it was already within 40 px of the bottom.
- [ ] **Step 3: driver wiring.** On `tool`: open a step (id = a counter), dispatch `phosphor:step` live. On `tool_result`: close the newest live step with that name, dispatch done or error, fix the time. On `text`: close the step block, append the assistant row. On `turn_end`: fold the turn's steps. On `status`: map as today; `error` state shows "Could not start" and the detail. Keep `TRANSCRIPT_CAP`. On boot, `driverState()` restores the transcript and rebuilds steps folded.
- [ ] **Step 4: the dock in `decision.js`.** Render into `#overlay` / `#overlay-card` exactly as the contract's section 6 describes the card (headline, facts, cost line, why line, destinations, policy diff), with the title "Waiting for you", buttons No (`btn btn-ghost`) and Yes (`btn btn-primary`), the `pending_unlock` card titled "Unlock to decide" with Unlock, the receipt state for six seconds after Yes ("Done." then `showReceipt`), "Refused." for two seconds after No, "Checking what happened." with Reconcile for `needs_reconciliation`. Remove the Escape handler and the modal semantics (the dock is a region). Several pending: newest on top, count in the head chip is the shell's job. Call `PhosphorTrace.surfaceForProposal` and `PhosphorBeam.wait` as the interface says.
- [ ] **Step 5: `tests/unit/decision-dock-ui.test.ts`.** Load `decision.js` in the same vm sandbox style as `agent-panel-ui.test.ts`. Assert: the source has no `innerHTML`/`insertAdjacentHTML`/`outerHTML`; the only button labels are `No`, `Yes`, `Unlock`, `Reconcile`; the source does not listen for `keydown` (no Escape); `diffOf` and `refineDiff` still export.
- [ ] **Step 6: styles.** Adjust the conversation and dock sections of `screens.css`/`layout.css` only as needed; the tokens and class names in `7d358c7` are the vocabulary.
- [ ] **Step 7: verify.** `npm test`. Captures: `conv-empty` (fresh demo), `conv-live` (drive a fake turn: the recipe explains how to feed driver frames through the fixture endpoint if one exists, else through `/api/driver` with the demo driver fixture in `tests/fixtures/driver-server.ts`), `dock-pending` (a pending proposal: the recipe's `propose` step). Commit on `wt/conversation`.

## Track T3: the beam, the trace, the field

- [ ] **Step 1: `tests/unit/beam-ui.test.ts`.** vm-load `ui/beam/beam.js` with a stub `document` that records attribute writes and appended children. Assert: `fire` on an unknown surface is a no-op that does not throw; `hold('x')` appends a child with class `surface-scan` and sets `data-glow="on"`; `release('x', false)` sets `data-glow-tone="down"` and removes the scan; `wait('x', true)` sets tone `wait` and glow on, `wait('x', false)` clears; `surface('holdings')` prefers `.view[data-active="true"] [data-surface="holdings"]` and falls back to the tab of the view that holds it; the source never assigns `.style.` on a surface (attributes only) and never calls `getBoundingClientRect` outside `fire`.
- [ ] **Step 2: `beam.js`.** The canvas `#beam` sized to the window at DPR capped 2 on resize (ResizeObserver on `document.body`). `fire`: read the origin and target rects once, compute a quadratic curve (control point offset 80 px toward the top of the window), animate `t` 0 to 1 over `--dur-beam` with the in-out curve, draw a 3 px head and twelve trailing samples with falling alpha in the tone colour read from the computed style of `:root` (`--agent`, `--warn`, `--down`) once per fire; on arrival call `hold` or `decay` as the caller asked (fire takes `then: 'hold' | 'decay'`, default `decay`). The rAF registers through `PhosphorMotion.register` and unregisters when no flight is in the air; the canvas is cleared and left empty. Reduced motion: no flight, the arrival effect only. Glow and scan are attributes and a child element; the CSS in `components.css` does the rest. The scan child gets `--scan-h` set to the surface's height once on hold.
- [ ] **Step 3: `tests/unit/trace-ui.test.ts`.** Assert `surfaceOf('balances')` is `{ id: 'holdings', tone: 'glow' }`, `surfaceOf('propose_swap')` is `{ id: 'holdings', tone: 'wait' }`, `surfaceOf('chart_mark')` is `chart`, `surfaceOf('switch')` is `tabs`... (the spec's table, one assertion per row), `surfaceOf('research')` carries `leaves: true`, `surfaceForProposal('yield_deposit') === 'earning'`, unknown tools resolve to `assistant`.
- [ ] **Step 4: `trace.js`.** Listen to `phosphor:step`: on live, `fire({ from: node, to: id, tone, then: 'hold' })`; on done, `release(id, true)`; on error, `release(id, false)`. A `research` step fires toward `{ x: window.innerWidth / 2, y: -20 }` and back to the node (leaves the machine). Listen to `transactions` frames: `decay('activity')`. Subscribe to the store's `ledger` slice: on change, `decay('holdings')`. `switch` and tools whose surface is in another mode land on the tab; nothing else.
- [ ] **Step 5: the field and the loop.** In `pattern.js`: render to a half-resolution backing store and upscale (perf finding 7), keep 30 fps and the visibility rules, expose `stop()`/`resume()` on the handle and stop while `body[data-locked="true"]` or a `dialog[open]` exists (perf 6). In `motion.js`: when the soonest handle is more than one display frame away, schedule with `setTimeout` for the gap (perf 11). In `screens.css` locked block: replace `filter: blur(2px)` on `.stage` with an opaque scrim (`opacity: 0.55` on the stage plus the screen's own ground), no filter.
- [ ] **Step 6: verify.** `npm test`. Captures with a fake turn: `beam-flight` (mid-flight, use a 4 s `--dur-beam` override through a query flag the recipe describes, or capture with `settle` at 200 ms), `beam-glow`, `beam-wait`. Commit on `wt/beam`.

## Track T4: the world and the screens

- [ ] **Step 1: Basic (`basic.js`).** Hero unboxed with the spec's four state sentences chosen from `lock.state`, pending count and `PhosphorAgent.isWorking()` (call `window.PhosphorShell.renderStatus` chain: subscribe to the store and to `phosphor:agent-phase`, a `CustomEvent` T2 dispatches on phase change; if it is absent, poll `isWorking()` on each state frame). The rules strip (`.strip[data-surface="rules"]`) with the sentence built from `state.policy.outbound` (`humanClickAboveUsd`, `maxPerTransactionUsd`, `maxPerSessionUsd`) using `dom.usd` with no decimals. Holdings panel `data-surface="holdings"`, Earning `earning`, Money in fold `moneyin`, Activity fold `activity`. Remove the foot Freeze block (the topbar carries it). Changed rows get `data-changed="true"` for 2.4 s when their value text changes.
- [ ] **Step 2: Pro (`pro.js`).** Money table `holdings`, Earning `earning`, Limits `rules`, Activity `activity`. Density: rows 36 px, labels 13 px (scoped classes in the pro section of `screens.css`).
- [ ] **Step 3: Trade (`trade.js`, `chart.js` constants).** Chart panel wrapper `data-surface="chart"`, rail panels `position`, `account`, `rules`, `fills`. Rail width token is 320 (already). In `chart.js`, `CHART_TOKENS.line` becomes `#232830`, `text2` `#9BA1AB`, `bg` values to the new ground, and `chart-chrome-ui.test.ts` updates the two literal asserts in the same commit; `C_UP`/`C_DOWN` unchanged. Restyle the chart bar controls (`.chart-select`, `.timeframe`, `.chart-cmd`) onto the tokens; remove the "invalid approval token" text from the chart bar when the token is missing in dev (render nothing, not a lie).
- [ ] **Step 4: screens.** `lock.js`, `firstrun.js`, `moneyin.js`, `receipts.js`, `feedback.js`: tokens and radii only, flows untouched, copy untouched except em dashes if any. `dialog.confirm::backdrop` loses `backdrop-filter` (perf rule 18) and uses an opaque scrim.
- [ ] **Step 5: tests.** `basic-view.test.ts` and `trade-fills-ui.test.ts` keep passing; add to `basic-view.test.ts`: the source contains `data-surface` values `holdings`, `rules`, `earning`, `moneyin`, `activity`, and does not contain `Freeze everything`.
- [ ] **Step 6: verify.** `npm test`. Captures `basic`, `pro`, `trade` at 1440x900 and 1920x1200, `lock`, `firstrun-1`, `moneyin`. Commit on `wt/world`.

## Track T5: rails (audit C)

Fix, with a regression test each that fails on the old code: C1 (`minAmountOut` must be positive on every venue, `floorTooLow` on both Intents rails, the signed-payload and read-back floors), C2 (strict config schema: unknown keys refuse boot; a NEAR address must be a valid mainnet account id, implicit 64-hex or a named account, never `*.testnet` when `mode` is live; destination-family validation in `oneclick.plan()`), C3 (the HyperCore deposit checks the guaranteed floor), C5 and C6 (the `quoteRequest` echo check on every Intents rail, simulate included), C7 (Solana destinations compared exactly). C4 (price staleness): add a staleness bound that refuses a cap decision on a price older than 120 s rather than guessing, and a test. Lows 8 to 11: fix 8 and 9 if under an hour each; report the rest as left. `npm test` and `npm run typecheck` green. Commit on `wt/rails`, one commit per finding.

## Track T6: performance (perf audit)

P1: `/api/state.proposals` carries pending, `pending_unlock`, `needs_reconciliation` and the last 20 decided; a new `GET /api/proposals?limit=&before=` pages the history; `ui/core/api.js` gains `proposals(query)`; a test asserts the state payload for 1000 decided proposals is under 20 KB. P2: the audit tip is written on a 1 s debounce and on shutdown, crash and kill switch; a test asserts the tip is durable after `shutdown()` and that `verify()` still passes with a lagging tip. P3: the state body and ETag are cached behind a revision counter bumped by the store, keystore, policy, ledger and roster; a test asserts two builds without a change return the same object. P4: one `store.list()` per build. P5: the store holds the array in memory and serialises once per put. P13: `verify()` runs after `listen`, reported through `/api/health.auditChain`. P12: the Rust probe at 25 ms for two seconds then 250 ms. `ui/core/state.js`: `same()` compares by reference first, then shallow keys, never `JSON.stringify` above 4 KB. Each with a measurement in the commit message. Commit on `wt/perf`.

## Track T7: the agent channel and custody (audits A and B)

Defined when the reports land; the lead appends the tasks here before dispatch.

## Merge order and the final pass (lead)

1. `wt/beam`, then `wt/conversation`, then `wt/world`, then `wt/rails`, then `wt/perf`, then `wt/channel`. After each merge: `npm test`.
2. Integration: the `phosphor:agent-phase` event, the dock and the trace wired together against a live driver turn; captures of the full set at 1440x900 and 1920x1200; `npm run e2e`; `npm run typecheck`.
3. `npm run bundle`, `npm run tauri dev`, one screenshot of the real window.
4. README and `docs/screenshots` refresh, the animated SVG hero, the vault flush, merge to `main`, push.
