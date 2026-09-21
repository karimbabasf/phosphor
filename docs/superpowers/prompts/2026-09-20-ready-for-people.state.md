# Ready for people: state

Lead: Claude (Opus 5), session c49886b8. Started 2026-09-20 19:05 PDT. Main at 7e0357f after phase 0.

## Baseline (phosphor-baseline worktree, detached at ab6f8f1)
- typecheck: exit 0
- npm test: 3066 pass, 0 fail
- npm run eval: 29/29 pass
- npm run eval:live (full, at ab6f8f1, 3 runs, 1h50m): run 1 17 pass 8 fail 4 xfail; run 2 20/5/4; run 3 17/8/4; 17 scenarios green every run. Per scenario x/3: S1 2, S2 2, S3 3, S4 1, S5 2, S6 1, S7 3, S8 3, S9 1, S10 1, S11 3, S12 0, S15 3, S16 0, S17 3, S18 3, S19 3, S20 2, S21 3, S22 3, S24 3, S25 2, S26 3, S27 1, S29 3; xfail every run: S13 S14 S23 S28. Log: scratchpad/baseline/eval-live.log. The floor is per scenario over 3 runs: a merge may not lower any scenario's count.
- impeccable detect ui/: 3 findings after the Geist ignore (2 clipped-overflow warnings on html/body, 1 advisory hairline border plus wide shadow); baseline JSON at docs/superpowers/prompts/ready-for-people/impeccable-detect-baseline.json

## Phase 0 (done)
- 7e0357f: stage vocabulary contract in src/proposals/view.ts (relay words, no vendor word in a label, STAGE_COPY, KIND_STAGES, LEGACY_SWAP_PATH), SwapDraft.venue widened, history reader marks relay swaps inside.
- Situation list: docs/superpowers/prompts/2026-09-20-ready-for-people.situations.md (98 rows).
- Lessons file created.

## Nodes (phase 1), worktrees ../phosphor-rfp-<node>, branches rfp/<node>, all off 7e0357f
| node | branch | status |
|---|---|---|
| A relay swap | rfp/a-relay | reported (c0232de, 3143/3143, eval 29/29, +75 tests, security 0 High/Med); correct + secure reviews running; NOTE: relay quotes no solver for USDC to wNEAR today, USDC to USDT does; nonce is V1 (current_salt) not the spec's 32 random bytes |
| B Hyperliquid | rfp/b-hyperliquid | reported (dd7bf2b, 3098/3098, eval 29/29, live S12 2/3 from 0/3, +32 tests, security 0 High/Med); correct + secure reviews running |
| C agent picker | rfp/c-agent | reported (291fc9a after merging main, 3123/3123, +57 tests); correct + secure reviews running; touched ui/index.html (one link line) and src/http/router.ts (two routes) outside its list, resolve at merge |
| D one card, voice | rfp/d-card | building |
| E craft floor | rfp/e-craft | reported (ed0f0e4, 3096/3096, detector 0, audit 0 blocking); correct + secure reviews running; overwhelmed review waits for F |
| F anxiety harness | rfp/f-anxiety | building |
| G launch readiness | rfp/g-launch | reported (4240cd0, sweep PASS, 13.x 6 of 9 yes; needs the 0.8.0 version bump at merge); correct + secure reviews running |

Ports: A 4201, B 4202, C 4203, D 4204, E 4205, F 4206, G 4207 (PHOSPHOR_PORT), data dirs under each worktree's state/.

## Decisions (criterion number)
- 5.4 / 3.1: vendor words stay as stage IDs (they are what diagnose and reconciliation check); only labels changed. PROCESSING = "On its way", SUCCESS and SETTLED = "Waiting for the venue to credit it" (same sentence through the gap, so the person sees one phrase).
- 3.4: waitingOn says "The transfer" for 1Click phases and "NEAR Intents" for relay phases; "1Click" told nobody what they were waiting for.
- 9.8 (bad-button.jpg): missing from the repo; asked for in the report's You section, E works from the inventory instead.
- 6: judge model probe order per the prompt; env names in ~/.config/jev-browse/env are TEXT_MODEL_* (NEAR AI Cloud) and OPENROUTER_*.

## Open
- 19.94 USDC at 1Click (HS 3452114377): not touched.

## Requests filed by nodes (for the lead to route)
- E to D: decision.js Escape closes a dock read card never an ask; swap dock address grouped in fours (decision.js/cards.js); netpick.js token list gets the scrolls class and data-cut hook (C's file); src/view/theme.ts down slot floor MIN_MARK_CONTRAST to MIN_TEXT_CONTRAST (lead).
- G to lead: 0.8.0 bump in package.json, Cargo.toml, tauri.conf.json at merge; three native message boxes in main.rs (Copy MCP Config outcome, fail(), notify()) to in-app windows; shell-health source-assertion test after E merges; per-tool argument pin after A, B, C merge; diagnose through the log redaction; a .gitleaks.toml; site docs rebuild (Karim, live site says 0.6.0).
- C to G/lead: docs/security-model.md must list POST /api/policy/threshold (token-checked) and GET /api/connection (no-token loopback read); main.rs Copy MCP Config dialog text still says claude mcp add-json (wording in report-c section 5).
- Flaky: tests/unit/lock-frame.test.ts timing miss once under load (3.1 s), passes alone; watch it at merge, never loosen it.
- A to D/lead: ui/screens/decision.js VENUE_WORDS and ui/screens/receipt.js VENUE_NAMES need an 'intents-relay' entry; the card draws simulation.swap.priceGoodForSec as "Price good for about a minute, re-quoted at your click"; execute.ts judgeSettling must never write the short-fill failed on a relay row (atomic diff). A added three type fields in src/types.ts and one pickEvidence line in execute.ts (on its branch).
- Proof decision pending (4.7, proof 3): if `node scripts/relay-probe.ts --from USDC --to NEAR --amount 2` exits 2 at proof time, the swap proof runs USDC to USDT (the spec's pair) and the report says why.
- B to D/lead: cards.js hl branches draw "at least" from sim.send.arrivesAtLeast; main.ts wires held: demoHeldTiming(cfg) so the harness can expire a hold in seconds; reconcile.ts demo sentence over a handled row; role.ts withdraw phrasing for S12 3/3.
- PROOF FACTS (B's probe): the HL deposit floor is 7 USDC in (5 lands), so "5 each way" is 7 in and 5 out; the HL account holds 0.000775 USDC and the intents balance holds NO USDC today. The live proof needs about 10 USDC in intents first: check the wallet read at proof time; if still empty, this is a You item (money) or a swap from what he holds, decided then.
- Review G correct: ACCEPT (docs/superpowers/prompts/ready-for-people/review-g-correct.md). Fixes sent to G: sweep Cargo.lock line skip hole, log-tail shapes (b58 sig fields, sk-, JWT, apiKey/authorization) and diagnose through redaction, exact-value excuses for B's demo hashes. Open for E (post-merge): shell.js:230 health poll only on offline/reconnecting/stale, a boot whose stream connects never calls /api/health (13.6 literal). Karim: live site docs say 0.6.0, /updates/latest.json 404.
- Review G secure: ACCEPT (review-g-secure.md). Three more fixes sent to G: /api/events streams raw audit events (redactEvent at sse.ts:168), Report copy through withoutAddresses plus the form text, Copy Log must check the boot nonce. Follow-ups for Karim: tests/unit/diagnose.test.ts:104 carries his real EVM address in full (public address).
- Review E secure: ACCEPT (review-e-secure.md). Fix sent to E: B6 on the SEND card (No/Approve under the fold at 1180x780, 960x700 and 400 wide; swap card fine), plus the explorer glyph size and the inventory temp dir. Noted: button-inventory.ts requires playwright-core from an unpinned npx cache path (same as checks-proof.ts), fails on another Mac; the index.html clipped-overflow ignore is value "*" (mutes future document-level clips).
- Review A secure: ACCEPT (review-a-secure.md), 0 High/Med, 2 Low sent to A: toBaseUnits rounds half-up (truncate for signed figures), reconcile's failed verdict must check is_valid_salt before trusting is_nonce_used false; plus the hold sentence must carry both numbers. Pre-existing notes: semgrep 3 hits in transactions.ts:517-519 (non-literal RegExp, no ReDoS), osv fast-uri/hono/qs transitive via the MCP SDK.
- Review A correct: ACCEPT (review-a-correct.md). Sent to A: execute.ts short-fill rule must not judge a relay settling row; bound the propose-time dry quote to 2.5 s (2.2); an unread input balance refuses before the signature (fail closed). Sent to D: NOT_FOUND_OR_NOT_VALID is not terminal (label "Not accepted, checking nothing moved"), 'intents-relay' in decision.js VENUE_WORDS and receipt.js VENUE_NAMES, priceGoodForSec line on the card, Escape on a read card, grouped swap address. Reproduced: USDC to NEAR quotes no solver (exit 2), USDC to USDT does (1.961996 USDT for 2).
