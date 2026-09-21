# Phosphor: what every quality word in the founder's request means

Date 2026-09-20. Repo main at `f8b08b7`, app version 0.7.0, 260 unit test files (3066 tests on 2026-09-20 per the vault note), e2e 26/26 on 2026-09-17, scripted eval 29/29. Read-only survey. Every threshold marked (proposed) is mine; the rest is cited from code or the vault note.

How to read each term: (a) meaning, (b) criteria with a threshold, (c) verification, (d) current state where cheap to see, (e) frozen rules a builder may never weaken.

## 1. Secure

(a) No money moves without either a human click in the window or a policy `allow` inside limits a human wrote, and nothing the agent, a web page, or a local process can say changes that.

(b) Criteria
1. Every executed row in the audit log has a prior `approved` line (decidedBy human) or a `proposal_created` line whose verdict was `allow`. Zero exceptions.
2. Every send, pay and Hyperliquid withdrawal waits for a click whatever the size (`land()` override, src/proposals/execute.ts). Zero auto-executed sends in any log.
3. The MCP tool set is the exact pinned set. No tool name begins with a decision verb. The agent has no field to name a recipient except the human-read-back `confirmed: true` path.
4. The four decision routes answer 403 without the window token, from any origin, with any seat secret (docs/security-model.md, "The honest v1 boundary").
5. Proposal rows are sealed in memory; a row changed on disk is refused at click, finger and unlock (`requireIntact`, src/proposals/lifecycle.ts). One test proves it.
6. Audit log is a sha256 chain (src/audit.ts:123); a dropped or edited line breaks it and the boot check says so.
7. Key material never appears in a log, a test fixture, the git tree or an agent's context. gitleaks clean on every commit; the injection suite scans for the key shape.
8. Every amount at the signature is a BigInt in base units checked against the approved quote (`checkIntentPayload`); the quote is checked against the venue's signature (src/quote-signature.ts).
9. Swap relay (the new rail): `amount_in` equals ours to the unit; `expiration_time` at least 15 s ahead; our deadline at most 120 s; minAmountOut from the quote never from a guess; asset ids pinned at propose and compared before signing; an unknown relay status is never terminal (spec, "What the relay can and cannot do to us").
10. Hyperliquid moves: every fee the user pays is on the card before the click, including the 1 USDC activation fee the venue charges on a fresh destination (`HL_ACTIVATION_FEE_USDC`, src/rails/hl-user-signed.ts:78).
11. Agent channel: the in-app driver runs under the lockdown settings file (no shell, files, web); tests/lockdown.test.ts holds against the installed Claude Code release. An agent picker must give a non-Claude agent the same lockdown or refuse to start it in-app (see term 10).
12. The click threshold default stays 100 USD (src/policy/file.ts:78), per-transaction cap 10,000, per-session 25,000 (file.ts:76-77), daily auto ceiling 5x threshold (file.ts:49). A UX pass may lower defaults, never raise them.

(c) Verification: `npm test` (unit + tests/injection.test.ts + tests/lockdown.test.ts), all green, count printed. `npm run e2e` exits 0. The curl table in docs/security-model.md replayed against a running build, all 401/403/404 as listed. `gitleaks detect` on the tree, 0 real hits. Audit chain check on boot prints ok. Security-audit skill pass over any diff touching src/policy, src/proposals, src/rails, src/http/auth.ts, src/vault, src/driver.ts, with 0 High open.

(d) Current state: the swap rail signs a 1Click `transfer`, not an atomic `token_diff`, so between input and output the money is the solver's (src/rails/intents-native.ts:584, named as the weak point; the relay spec exists to fix it). The unwrapped private key sits in backend memory for the whole vault-open window (vault Gotchas, "OPEN AND BIG", 2026-09-16). CodeQL has one open alert, js/stack-trace-exposure at src/http/respond.ts:109.

(e) Frozen: the agent can never approve (no tool, no flag, no env, no config); sends always click; three verdicts and no fourth; fail closed (corrupt policy refuses, failed simulation refuses, unknown asset counts as freezable, stale reads never read as zero); the window token never goes on the wire; both windows render the same facts (tests/unit/basic-view.test.ts); no address is ever truncated on a card; the deposit address is asked twice and a mismatch draws no address.

## 2. Fast and efficient

(a) The user never waits on the app for anything the app controls, and the app tells the truth about the waits it does not control.

(b) Criteria
1. Read tools (wallet, proposals, policy_show, show) answer in under 300 ms p95 locally with warm caches, under 2 s p95 with a venue read inside (proposed). Venue reads time out at 10 s (`READ_TIMEOUT_MS`, src/net.ts:26); a venue write at 30 s (src/net.ts:27).
2. A proposal answers at the decision, never after settlement: `propose_*` returns inside 3 s p95 for an under-threshold move and inside 1.5 s for one that waits for a click (proposed). The 20 s hold that once hid the card (vault Gotchas, "propose.ts held 20 s") never comes back.
3. Window state reaches the browser inside one SSE frame: state debounce 120 ms, heartbeat 15 s, candle push 250 ms (src/http/sse.ts:17-19). A stage change is on screen under 500 ms after the row is written (proposed).
4. Runner: frame to venue post and fire to venue post p95 under 50 ms (tests/unit/runner-latency.test.ts:29).
5. Backend idle CPU under 2 percent and RSS under 250 MB after one hour with an agent connected; no audit storm (one deposit once wrote 820 lines in 103 ms, vault Gotchas). Audit lines per proposal lifecycle at most 12 (proposed).
6. Cold start: window drawn and `/api/state` answering inside 2 s of launch on Apple silicon (proposed).
7. Typical durations the card promises stay honest: swap 45 s, send 60 s, HL deposit and withdraw 180 s, trade 10 s; deadline 8x with a 600 s floor (src/proposals/view.ts:133-149). A move past its deadline reads "Late, nothing has changed", never spins.

(c) Verification: `npm run venue-latency` prints p50/min/max per call. A new `scripts/latency-proof.ts` (proposed) posts 20 reads and 5 dry proposes against a demo backend and prints p95 per route with a pass line. `npm test` includes runner-latency (skipped on CI). Activity Monitor or `ps -o rss,%cpu` on the backend pid after 60 min, numbers pasted.

(d) Current: the HL rails poll 1Click every 3 s for up to 180 s (src/rails/hypercore-deposit.ts:179-180, hypercore-withdraw.ts:143-144) then watch the venue balance on a 500 ms to 3 s rise for 120 s (src/ledger/settle.ts:23). Intents settle watch 90 s (settle.ts:21).

## 3. UX friendly, smooth, no dead ends (for someone who does not understand crypto)

(a) A person who has never heard the words nonce, solver, verifier or slippage can fund, swap, and withdraw without reading a doc, and never sees a raw id, a raw error, or two things that disagree.

(b) Criteria
1. Words: the reply and the card use the app's own vocabulary only: pocket, your balance, at least, fee, Waiting for you, Confirmed, Failed, Refunded, Late. Banned in prose: nonce, intent hash, verifier, solver, token_diff, bps, EIP, ERC, base units, RPC. A raw id appears only shortened to two ends of 8 characters, behind a Reference label with a copy button.
2. Numbers: a card carries at most 6 numbers for a swap (spend, receive, at least, fee, time, threshold state) (proposed). Floors print truncated to 6 significant figures with "at least" (vault State, 2026-09-20). No "8.209399000000001".
3. Truth agreement: the card, the agent's sentence and `proposal_status` read from one `stageOf` (src/proposals/view.ts:170). Zero cases of a card and a reply naming different stages in the same second.
4. Every wait names what it waits for (`waitingOn`, view.ts:207). Never a spinner without a sentence.
5. Every failure names the rule or the venue in one sentence, and what the person can do next (retry, change a rule, nothing). Never a stack trace, never JSON, never a code alone.
6. Nothing overlaps or clips at 860 and 400 px column widths (the dock's fixture widths, vault State 2026-09-18). Confirm buttons are always visible without scrolling.
7. The anxiety score (term 6) passes on every situation.

(c) Verification: term 6's eval run; `tests/unit/*-ui.test.ts` (source-assertion tests in a vm sandbox; the UI is not typechecked, vault Gotchas); scratchpad fixtures rendered with chrome-headless-shell at 860 and 400 px, screenshots kept; a live computer-use session with Karim's finger, transcript and screenshots saved.

(d) Current: "The router is working" and "The router is done" are stage labels (view.ts:110-111); "Confirmed chip hides the router's word" was done 2026-09-20 but the label table still carries the word. The provider stage words are 1Click's own (view.ts:154-162).

## 4. Real and true infrastructure

(a) Any MCP agent, any day, gets the same answer from the same rails, every state survives a crash, and every claim the app makes can be checked against the chain or the venue.

(b) Criteria
1. Durability: kill -9 the backend at any stage; on boot the sweep closes held rows, reconciliation re-judges rows and signs nothing (src/proposals/reconcile.ts); no row is lost, none is executed twice (`clientKey` idempotency, src/duplicates.ts). One test per stage.
2. Every terminal row carries external evidence: intent hash or tx hash with an explorer link, or a venue status with its timestamp. Zero "Confirmed" rows without evidence.
3. Two rails per money path where the vendor can refuse us: swap on relay with 1Click behind a config switch `swap.rail` for a month after the flip (spec, Migration). Rail choice is config, never code.
4. The MCP surface is versioned and the tool set is pinned by test; a schema change fails a test before it ships.
5. Any MCP client can connect and be named in the roster (`AgentMember.client`, src/agents.ts:46); the app does not care which model drives.
6. Reads never lie: a stale venue read is marked stale, never shown as zero (security-model, Fail closed).
7. The real-money proof exists for every rail: one live move per rail with hash, both before and after balances read from the verifier or venue.

(c) Verification: `npm run e2e` (boots the app and a real MCP client over stdio); a crash-recovery test per stage under tests/unit (reconcile*.test.ts, release-queued, settling); tx and intent hashes pasted in the Done section; `proposals` tool output showing evidence on every terminal row.

(d) Current: the real-money proof for the relay rail is not done (spec, Proof). The 19.94 USDC at 1Click (ticket HS 3452114377) is still outstanding (vault State 2026-09-16).

## 5. The agent showcases every step, one card that updates smoothly

(a) One move is one card in the chat, drawn once, redrawn in place at every stage change, and the agent's reply around it is one to three short sentences per turn.

(b) Criteria
1. Cards per proposal: exactly 1 in the chat column for the proposal's whole life (`onProposals` redraws in place by id, ui/screens/agent.js:1926-1940). A read-back before propose updates the same card, fold kept. Zero duplicate cards in any transcript.
2. Cards per turn other than the proposal card: at most 1 read card (wallet, positions) (proposed). A turn never draws a card the person did not ask about.
3. Stage change: the stage line changes text with a 200 to 300 ms fade, the card keeps its position and size, the fold state is kept, the "last changed" clock moves. No layout jump over 8 px (proposed).
4. Stage words allowed on the card: the 19 labels in `STAGE_LABEL` (src/proposals/view.ts:103-121) and nothing else. Any provider word not in the table falls back to the app's own phase.
5. The agent's reply per turn: at most 3 sentences, at most 60 words, no numbers the card already shows except the one that changed, no id, no tool name (proposed; matches the role text's "answer on the decision, let the view move live").
6. The ending notice (src/http/ended.ts) becomes at most one sentence from the agent, or nothing if the person already saw it. Never two notices for one row.
7. Every proposal kind has the same card skeleton: title (what moves), from and to pocket, amount, at least, fee, stage line, one fold for checks and reference. Kinds differ in facts, not in shape.

(c) Verification: tests/unit/agent-cards-ui.test.ts and agent-transcript-ui.test.ts assert one card per id and the fold survival; a scripted driver run (tests/fixtures/driver-server.ts) posting a swap through all stages, DOM counted (`.chat-card` per proposal id equals 1); `node scripts/eval.ts --live` for S11 and S29 with the reply length rule in the rubric; screenshots at each stage from the same run.

(d) Current: one card per move landed 2026-09-20 (vault State). Read-tool answers still draw their own cards (ui/screens/cards.js), which is where "a billion cards" can still come from in a long chat.

(e) Frozen: the card is drawn from the server's `ProposalView`, never from the agent's text; the agent cannot change amounts, addresses or the stage on the card; the full address is never truncated on a send card; the fee and the floor are on the card before the click.

## 6. The user-anxiety (overwhelm) score

Lead's amendment (2026-09-20): Jev (typesafe/jev-1.13) is a browser-decisions model reached through `jev-browse` on OpenRouter, not a chat model that can score a screenshot against a rubric (it is absent from OpenRouter's chat model list). The score therefore has two legs: (a) the rubric below, judged by a vision model probed in the order given in the builder prompt (NEAR AI Cloud first, then Claude Sonnet 5 via OpenRouter, then `claude -p`); (b) Jev as the naive user on the flow rows through `jev-browse`, scored on reaching the end state, steps over the minimum, wrong clicks, and blocked or timeout. Where this file says "Judge: Jev via OpenRouter", read leg (a).

(a) A judge model looks at one screenshot plus the agent's reply for one situation, as a person who does not understand crypto, and scores how overwhelmed that person would be.

(b) Rubric, 0 to 10, lower is better, five parts scored 0 to 2 each (proposed):
1. Jargon: 0 = every word is plain or glossed in the sentence; 1 = one crypto term unglossed; 2 = two or more, or any raw id longer than 12 characters unshortened.
2. Density: 0 = one card, at most 6 numbers, at most 3 sentences; 1 = two cards or 7 to 10 numbers or 4 to 6 sentences; 2 = more, or a table in the reply.
3. Next step: 0 = the reader knows in one line whether they must do something and what; 1 = it can be inferred; 2 = unclear, or the card and the reply disagree.
4. Money certainty: 0 = spend, receive at least, and cost are all visible in the reader's terms; 1 = one missing; 2 = two missing, or a figure like 8.209399000000001, or "Infinity", "NaN", "undefined".
5. Alarm: 0 = calm tone, one status colour; 1 = red text or the word failed without a next step; 2 = stack trace, raw JSON, ALL CAPS vendor words, an error toast on top of a card, or two alerts at once.
Levels: 0 to 2 calm; 3 to 4 fine; 5 to 6 uneasy; 7 to 8 overwhelmed; 9 to 10 panic. Pass: median 3 or under across samples AND no single sample 6 or over (proposed). A failure situation may score up to 4 median (a refusal is allowed to feel serious, not confusing).

Judge: Jev via OpenRouter, system prompt "You are a 35 year old who uses Venmo and has never bought crypto", given the screenshot and the reply text, asked for the five part scores and one sentence of why per part, JSON only. 3 votes per sample, median taken (mirrors `JUDGE_VOTES = 3`, scripts/eval.ts:355). Judge timeout 150 s (eval.ts:416).

Situations (each is one row in the run): proposal kinds swap under threshold, swap over threshold, hl_deposit, hl_withdraw, intents_send, intents_pay, trade, policy_change, each at Waiting for you, Touch ID, Sending it, a provider stage, Confirmed (5 shots per kind, 40 rows); failures: refused by policy (each of the 11 rule names), preflight hold, hold expired, rail failed, provider FAILED, REFUNDED, stalled, declined by the human, Touch ID closed without an answer, venue outage mid-move, empty wallet, unpriced coin, below the HL floor, the unified-account withdraw refusal (24 rows); onboarding: terms card, Gatekeeper page in docs, welcome, create or choose, password, words, prove, addresses, money, agent picker (installed, not installed, not logged in, Claude Desktop user), threshold, done (15 rows); the vault: custody, recovery, addresses, agent panel and agent switch (success, missing agent), window, danger (7 rows); the ending notice after a click, after a refusal, after a failure (3 rows); session start greeting and "what do I hold" (2 rows). About 91 rows.

Samples: 3 screenshots per row from 3 separate runs (demo backend, fixed seed) at 860 px, plus 1 at 400 px for the card rows; 3 judge votes per screenshot (proposed). A row passes on the median of its 9 votes.

(c) Verification: a new `scripts/anxiety-eval.ts` (proposed) drives the demo app through the rows, saves `<row>.png` and `<row>.json` (scores, reasons, screenshot path) under a run folder, prints a table with pass or fail per row and the count. The table and three worst screenshots go in the report. The run is repeated after every UI change to a card, a screen, or the role text.

(d) Current: no visual judge exists. The eval judge is `claude -p` with no tools scoring facts and a rule per scenario (scripts/eval.ts:332-351), text only.

## 7. UX versus security: the line

(a) A UX change may reshape how a gate looks and reads; it may never remove, delay, hide, or pre-answer the gate.

(b) Never removed or weakened by a UX change: the click; Touch ID on an enclave wallet; the read-back before a send; the two-answer deposit address check; the full untruncated address on a send card; the fee and floor on the card before the click; the policy rule name in a refusal; the 15 minute lock; the kill switch; the seal check on a row; the `confirmed: true` literal; the 403s on the decision routes; the agent's lockdown file.

What a gate owes the user, every time (criteria): 1. One sentence saying why it stopped (the rule, in the policy's own rendered words, src/policy/render.ts). 2. One sentence saying what changes it (a click, a rule change in the window, waiting, nothing). 3. The exact figures it judged (amount, cap, threshold) in the person's currency. 4. No blame words: never "you", "invalid", "illegal", "unauthorized". 5. Reachable inside 2 clicks from the refusal to the rule that fired (proposed).

(c) Verification: for every rule name in the engine chain (11 rules, docs/security-model.md, "The three verdicts"), one fixture screenshot judged by term 6 with median 4 or under; tests/unit/proposals.test.ts (above threshold parks pending; nothing writes `gate_disabled`); the injection suite unchanged and green after every UX commit.

(e) Frozen: the list in (b). Also: "basic" may use fewer words, never fewer facts (tests/unit/basic-view.test.ts). A confirm button is never enabled before the card has its facts. A pending button never turns into an error inside 300 ms (ui/screens/agent.js:1186 comment).

## 8. Hyperliquid deposits and withdrawals that agree across the app, the chain, and the user

(a) The app's row, the venue's or chain's record, and the card the user reads always name the same amount, the same stage, and the same fee, and a stuck move heals or fails with the money accounted for.

(b) Three views that must agree: the proposal row and its `ProposalView` (app), 1Click status plus the Hyperliquid account summary or the verifier balance (chain and venue), the card and the agent's sentence (user). Criteria:
1. Amount agreement: the card's "arrives at least" equals the draft floor equals what the signed payload guarantees (`guaranteed >= minCreditedBase`, src/rails/hypercore-deposit.ts:358). After settlement the venue's credit is at or above the floor. Zero rows where the three differ.
2. Fee agreement: the withdraw card shows routing plus the 1 USDC activation fee when the destination is fresh (hypercore-withdraw.ts:223-266); the amount that lands equals quote minus those two parts to 4 decimals.
3. Latency bounds: 1Click poll 3 s, poll timeout 180 s, venue settle watch 120 s (cited above). The card reads "Deposit seen" inside 30 s of the intent submit (proposed), "Waiting for the venue to credit it" as soon as 1Click says SUCCESS, "Confirmed" only after the venue balance rose (never on SUCCESS alone: a finality-final read lags SUCCESS, vault Gotchas).
4. Settling looks like: one card, stage line moving through Sending it, Deposit seen, The router is working (rename per term 3), Waiting for the venue to credit it, Confirmed, each with a clock, and the agent silent unless asked.
5. Stuck move: after 180 s of polling the row is unconfirmed with hash and nonce, never failed on a timeout alone (a timeout is a failure to hear back, src/net.ts:23); the boot sweep and reconciliation resume it; the card says "Late, nothing has changed" with the reference; recovery is the app's retry, never a question to the user. Money is never in a state the card cannot name.
6. Withdraw on a unified account: works, using the transfer both account modes accept (`sendAsset`, per the SwapKit HyperCore guide, vault State 2026-09-20), or the app refuses before any quote with the maximum sendable amount in the sentence.
7. Below-floor deposits (S26) and deposits with a memo requirement are refused before signing with the floor named.

(c) Verification: `node scripts/deposit-proof.ts` and `scripts/hypercore-probe.ts` outputs; S1 to S7, S12, S13, S26 in `node scripts/eval.ts --live` all pass; one live deposit and one live withdraw of at least 5 USDC with 1Click hash, HL account summary before and after, verifier balance before and after, pasted; `tests/unit/settling.test.ts`, `reconcile-oneclick.test.ts` green; a kill -9 during polling followed by boot, row resumes (test plus one manual run).

(d) Current: the exit is dead on a unified account: `spotSend` and `usdSend` both refused with "Action disabled when unified account is active" (src/rails/hl-user-signed.ts:332-335 documents it; hypercore-withdraw.ts:520 still signs a spotSend). S12 live fails 3 of 3 on withdraw phrasing. Karim said "hyperliquid I'll deal with later" on 2026-09-20; the founder's request now puts it back in scope.

(e) Frozen: a withdrawal always clicks; the activation fee is on the card before the click; SUCCESS never flips the card to Confirmed; the preflight five checks run before every HyperCore deposit intent (src/preflight/index.ts); a hold signs nothing and retries every 30 s for 15 min (src/proposals/execute.ts:224-225).

## 9. Onboarding simple and well designed; buttons function and look correct

(a) A first-time user reaches a funded wallet with a working agent in under 10 minutes without a terminal unless they choose one, and every control on the way looks like what it does and does what it looks like.

(b) Onboarding criteria
1. Steps: enclave flow 4 screens (welcome, create, addresses, connect), software flow 10 (ui/screens/firstrun.js:28-33). No step may be added; the connect step becomes the agent picker (term 10).
2. Every step has one primary action, one optional secondary ("Do this later"), a step count for screen readers (firstrun.js:328), and no dead end: a failed action shows one sentence and the same button again.
3. Time: welcome to "done" in under 10 minutes on a fresh Mac with Touch ID, measured with a stopwatch in the computer-use session (proposed).
4. The terms card appears once, before anything else, and `TERMS_VERSION` (src/terms.ts:17) bumps when the text changes.

Button and control floor, checkable on every button in ui/ (proposed unless cited):
1. Height at least 36 px, small variant 30, large 44 (ui/design/components.css:15,112,118); width never narrower than its label plus 24 px; the label never wraps or clips.
2. Five states drawn and visibly different: rest, hover, active, disabled, pending. Pending uses the two-face mechanism (`data-pending-label`, components.css:127-170); the pending face never shows beside the rest face.
3. Disabled means visibly disabled and not clickable; hidden means not in the DOM or `display: none`, never the `hidden` attribute alone (it loses to any author `display`; vault Gotchas, the empty approval box with two live YES/NO buttons).
4. One icon family; no button mixes a glyph from icons.js with a card glyph.
5. Focus ring visible on keyboard focus; Enter and Space activate; Escape closes a sheet.
6. Every button in the dock is visible without scrolling at 400 px column width (vault State 2026-09-18).
7. Contrast at least 4.5:1 for the label in every theme the app can set (`set_theme`).

(c) Verification: a button inventory script (proposed) that lists every `.btn` in ui/screens and ui/design with its class, label, and states, and a screenshot sheet of each state rendered by chrome-headless-shell in both column widths; `impeccable audit` on ui/ with 0 blocking findings; `node scripts/firstrun-proof.ts` and `scripts/window-proof.ts` green; a computer-use run of the enclave first run on a fresh data dir, timed, screenshots at each step; term 6 scores on the 15 onboarding rows.

(d) Current: the founder reports some buttons render wrong; nothing in the vault note names which. The two known mechanisms are the `hidden` attribute losing to an author `display` (ui/design/reset.css:91) and the pending double face. The inventory script is how the builder finds the rest instead of guessing.

## 10. Agent setup replaced by an agent picker; accommodate any agent

(a) The user picks the agent they already have from a list, the app checks that agent on this Mac and says in one sentence whether it can drive, and the user can change that choice in the vault later without ever seeing a raw error.

(b) Criteria
1. The list: Claude Code, Codex, Hermes, Grok bot, "another MCP agent" (shows the generic stdio line), and "I use Claude Desktop or a chat app" (no terminal agent). Six entries, one screen, same visual grammar as the network picker in ui/screens/netpick.js.
2. Backend check per agent, inside 3 s (proposed), returning one of exactly four states: `installed_and_logged_in`, `installed_not_logged_in`, `not_installed`, `unknown_client` (a generic MCP agent cannot be probed; the app says so). The check is a `--version` style call plus a login probe, never a network call to the vendor.
3. Message per state, one sentence each, no path unless the person opens "Details": for `not_installed`: "Codex is not on this Mac yet. Install it, then come back to this screen." For `installed_not_logged_in`: "Codex is installed but not signed in. Sign in in your terminal, then press Check again." For Claude Desktop: "Phosphor needs an agent that runs on your Mac. Claude Desktop cannot drive it yet. Install Claude Code or Codex, then pick it here."
4. Registration: on pick, the app writes the MCP registration for that agent itself when the agent has a config file it owns (Claude Code `claude mcp add`, Codex config.toml), or shows the one line to paste when it does not. The line is built per agent, never the Claude line for everyone.
5. In-app start ("Use the one built in") is offered only for agents that have a headless mode the app can lock down (today Claude Code, src/driver.ts). For others the app says "Start it in your terminal and it will appear here", and the roster light turns Ready when the client connects (`AgentMember.client`, src/agents.ts:46; TTL 45 s, agents.ts:110).
6. Vault Agent panel (ui/screens/vault.js:193-207): shows the chosen agent, its state from the same check, a Change button that opens the same picker, and Check again. Switching never restarts a running agent without the "Turn off" card first.
7. Errors: the picker and the panel show at most one sentence at a time; the technical detail is behind Details; no toast stacks on a sentence. Zero raw error strings from `net.readable` on these two screens.
8. A picked agent that later disappears (uninstalled) shows "Codex is no longer on this Mac" in the panel and the Ready light goes off; no error on boot.

(c) Verification: tests/unit for the check function with fixture binaries (tests/fixtures/fake-claude-*.sh pattern, one per agent and state); the connection route test (src/http/mutation.ts:117) asserting the line per agent; a computer-use run picking each of the six entries on a Mac where only Claude Code is installed, screenshot per state; term 6 scores on the picker rows.

(d) Current: the connect step offers "Start it" (spawns only `claude`, src/driver.ts:234-256, error text names Claude Code) and one copy line that is always `claude mcp add phosphor -- node .../src/mcp.ts` (src/http/mutation.ts:119). The vault Agent panel has two facts and a "Your rules" button, no choice. docs/connect-an-agent.md names Codex only as "see the Codex MCP documentation".

(e) Frozen: an in-app agent runs only under a lockdown the app owns (tests/lockdown.test.ts); no agent gets the window token; the roster caps stay (src/agents.ts:234); a picker never stores a vendor login or key; the check never sends anything off the Mac.

## 11. Fix without whack-a-mole

(a) Every fix names the cause, lands with a test that failed before it and passes after, and the second failed fix on one symptom stops the editing and starts a diagnosis.

(b) Criteria
1. One regression test per fix, named for the symptom, red on the parent commit and green on the fix commit. The commit message names the test.
2. Second failed fix on the same symptom: stop, invoke superpowers:systematic-debugging, write the ranked hypotheses in the plan file, test the top one with evidence before the next edit.
3. Generator over output: a fix to a stage label, a card, a fee line, or a sentence goes in the one source (`stageOf`, `STAGE_LABEL`, `pricedAs`, the role text), never in a screen's copy of it. "Two copies of one truth is the bug family" (vault Gotchas, 2026-09-18).
4. No symptom fix in ui/ without a source-assertion test, because tsc never sees ui/ (vault Gotchas).
5. Every fix is checked on the installed app, not only the dev shell: `npm run bundle` before `npm run tauri dev` (the dev app serves the staged payload, vault Gotchas 2026-09-15), and the installed app on 4177 quit first.

(c) Verification: `git log --format=%s` for the branch shows a test per fix; `npm test` count rises by at least the number of fixes; the plan file lists symptom, cause, test name, commit for each item; a reviewer replays three fixes by checking out the parent and running the named test (must fail).

## 12. Proof that it works

(a) Karim can see, without reading code, that every claim in the report has a number, a hash, a screenshot or a session behind it.

(b) The evidence set, all of it in the report's Done section:
1. `npm test` total and failures (0), `npm run typecheck` clean, `npm run e2e` N/N, `node scripts/eval.ts` 29/29, `--live` per scenario with the judge's line, gitleaks 0.
2. Term 6 table: rows, medians, pass count, the three worst screenshots.
3. Tx and intent hashes for one live move per rail (swap on relay, HL deposit, HL withdraw, send), with before and after balances from the verifier and the venue, and the 1Click or relay status line.
4. Screenshots: each onboarding step, the picker in four states, the vault agent panel, one card at each stage for a swap and an HL move, at 860 and 400 px.
5. The computer-use session: Karim's finger on Touch ID, the transcript, the screenshots, started by the builder in Phosphor with a real agent, ending with a swap Confirmed.
6. Latency table from term 2 and the resource line.
7. The button inventory sheet from term 9.

(c) Verification: a reviewer reads only the report and can click every hash into an explorer and open every screenshot path; any claim without an anchor is struck.

## 13. Ready for people to use

(a) A stranger with a Mac, a Claude or Codex login, and 20 USDC can install, fund, swap, withdraw, get help, and update, without talking to Karim.

(b) Checklist, each item yes or no:
1. Fresh install: DMG sha256 matches SHA256SUMS and the site; Gatekeeper path documented (docs/getting-started.md:24); notarization stays a known gap (Apple Developer needs 18+, so a parent's name until 2027-01-30, vault State 2026-09-18) and the docs say so.
2. First run on an empty data dir reaches "done" with the enclave flow, terms card first, in under 10 minutes; the state dir and keystore land where docs/reference.md says.
3. Docs: getting-started, connect-an-agent (rewritten for the picker), money, policy, trading, troubleshooting, security-model, all match the build; changelog says 0.8.0 or whatever ships; the live changelog page no longer says "Not tagged".
4. Terms, privacy, security pages live on the site; in-app Help menu has Documentation, Report a Problem, Report a Security Issue, Terms, Privacy (shipped 2026-09-18). The lawyer read of the terms is still open and named as such.
5. Updater: endpoint set (src-tauri/tauri.conf.json:50-55), a signed release with `latest.json`, one in-app update from the previous version verified on this Mac, and the note that the updater verifies the bundle not the manifest (vault Gotchas).
6. Error states: every failure situation in term 6 passes; the app never shows an NSAlert as product UI; a dead backend with a live window is impossible (vault Gotchas: every signed build once had that) and `/api/health` is checked by the window on boot.
7. Support path: SECURITY.md private reporting ON (done 2026-09-18), issue templates present, Report a Problem opens a prefilled issue with version and OS, and the log tail can be copied from the app without the key or the seat secret in it.
8. Release: CI green on push, tag annotated, five assets, sha256 on the release page, site download serves the same bytes (the 0.6.0 pattern, vault State 2026-09-18).
9. Known limits page lists what is not covered: key in memory while open, sub-threshold exposure to a local process that read the seat secret, no notarization, alpha with real money.

(c) Verification: the checklist filled in the report with a link or path per yes; a fresh-user run on a second macOS user account on this Mac (new home, no claude login) recorded with computer-use; `npm run sweep` fixed or replaced (broken for days on Cargo.lock checksums, vault State 2026-09-18) so the secret scan runs.

## 14. "Ultimate", applied to the builder prompt

(a) A builder prompt is ultimate when the builder never has to ask a question and Karim can verify every claim in the report without reading code.

(b) The prompt must contain:
1. The path to this file and the sentence "every threshold here is the acceptance test; a term with no evidence is not done".
2. The repo state to start from (main `f8b08b7`, the swap relay spec path, the transcript-fixes plan at ~/.claude/plans/2026-09-20-phosphor-transcript-fixes.md), and the rule that several sessions share the checkout so work happens in a worktree (vault Gotchas).
3. The frozen rules from terms 1, 5, 7, 8, 10 copied in, as a numbered list the builder must not touch.
4. The ordered work list: relay rail with migration switch; HL exit on a unified account; the agent picker and vault switch; one-card-per-move audit and the reply length rule; button inventory and fixes; onboarding pass; anxiety eval script and run; latency proof; launch checklist; final review at the strongest model.
5. Per item: the verification command or procedure from this file, and the shape of the evidence line.
6. The no-questions rule with the decision log: every open call goes to a subagent that returns a decision and one line of why, listed under "Assumptions and calls I made".
7. The stop points that need Karim's finger, each stated as "stop here and tell Karim": Touch ID on real money, the live moves, the computer-use session, pushing, tagging, releasing.
8. Boundaries: never touch ~/.phosphor or the installed app's state without the words in the moment; no push, no PR, no artifact, no remote; the installed app on 4177 must be quit before the dev shell; `npm run bundle` before `npm run tauri dev`; browser and Docker cleanup lines; no secrets in chat, vault, or git.
9. The report shape: Done bullets with numbers and hashes, You with blockers only, the term 6 table, the checklist from term 13.
10. The whack-a-mole rule from term 11, with the named skill.
11. Models and effort: builders on Opus, reviewers on Fable, the eval judge on Jev via OpenRouter with the exact system prompt from term 6.
12. A size cap: the report fits on one screen, the evidence lives in files under the scratchpad with paths.

(c) Verification: a dry read by a second model answers "what would you have to ask Karim?" with nothing; every "verify" line in the prompt names a command or a file; the report template is in the prompt.

## Other vague requirements in the request, defined

- "without any confusion": the term 6 next-step part scores 0 on every proposal row.
- "there aren't a billion cards": term 5 criterion 1 and 2, counted in the DOM.
- "fingerprint the way through": every Touch ID prompt names the amount, the receiver's two ends and the chain (src/vault/reason.ts), and the computer-use session pauses on each one for Karim; the builder never bypasses it with a software wallet for the proof.
- "understand the difference between ux and security": term 7's frozen list, checked on every UX commit by re-running the injection suite.
- "fast and efficient backend": term 2, plus the audit-lines-per-lifecycle cap.
- "well designed ui": impeccable audit with 0 blocking findings, type pair named (Geist and Geist Mono are the app's; keep them), one icon family, no display serif.
- "buttons that function and look correct": term 9's floor, proved by the inventory sheet.
- "test it in the backend and give them back a message": term 10 criteria 2 and 3, four states, one sentence each.
- "the user isn't flooded with strings of errors": at most one sentence visible at a time on the picker and the panel; detail behind Details; zero toasts stacked.
- "build end to end": every item in term 14's work list has its evidence line filled, or is named as left out and why.

## The three clearest failures today

1. Any agent: src/driver.ts:234-256 resolves only `claude`, src/http/mutation.ts:119 builds only the Claude Code line, and ui/screens/vault.js:193-207 offers no agent choice.
2. Hyperliquid exit: src/rails/hypercore-withdraw.ts:520 signs a `spotSend` that a unified account refuses (documented at src/rails/hl-user-signed.ts:332-335); S12 live fails 3 of 3.
3. Swap atomicity: src/rails/intents-native.ts:584 hands the input to a solver as a `transfer`; the relay spec's `token_diff` is what "real infrastructure" and "secure" require, and nothing is built yet.
