# Ready for people: the situation list for the anxiety score

Date 2026-09-20. Term 6 of docs/superpowers/specs/2026-09-20-quality-definitions.md, made concrete.
One row is one screenshot plus the agent's reply (leg a), scored 0 to 10 by the rubric judge, three
votes, median. Pass: median 3 or under and no vote 6 or over; a row marked F (failure or refusal)
may reach median 4. Rows marked FLOW are also leg b: Jev plays the person through `jev-browse`
and is scored on reaching the end state, steps over the minimum (at most 1.5x), wrong clicks (at
most 2), blocked or timeout (zero).

Stage words are the ids in src/proposals/view.ts (STAGE_LABEL is the text on screen; KIND_STAGES
is each kind's path). Every row is produced against the demo backend (PHOSPHOR_MODE=demo, fixed
seed) at 860 px; card rows (groups A and B) get one more shot at 400 px. Three runs per row.

How to read "reach": the tool call or click that produces the state. The harness owns the exact
mechanics; a row whose state the demo rails cannot produce is marked in the run table as
"not reachable in demo" with the reason, never silently skipped.

## A. One card per money kind, five moments each (44 rows)

| id | kind | stage id | reach |
|---|---|---|---|
| A01 | swap, under threshold (relay) | signing | propose_swap 2 USDC to NEAR, policy allows, shot at the signing tick; not reachable in demo: the demo software wallet signs and submits in one step, so there is no distinct signing tick to shoot; the live signing beat needs an enclave |
| A02 | swap, under threshold | waiting_for_touch | same, enclave wallet, before the fingerprint; not reachable in demo: Touch ID is enclave-only and the demo backend runs a software wallet, so it never reaches waiting_for_touch; the boot sweep also rewrites a seeded awaiting_touch row to pending |
| A03 | swap, under threshold | submitting | same, after the signature |
| A04 | swap, under threshold | PENDING | same, relay says PENDING |
| A05 | swap, under threshold | confirmed | same, balance rose |
| A06 | swap, over threshold | waiting_for_you | propose_swap 500 USDC, dock open |
| A07 | swap, over threshold | waiting_for_touch | after Yes; not reachable in demo: Touch ID is enclave-only; the demo software wallet approves straight to signing |
| A08 | swap, over threshold | submitting | after the signature |
| A09 | swap, over threshold | TX_BROADCASTED | relay says TX_BROADCASTED |
| A10 | swap, over threshold | confirmed | balance rose |
| A11 | hl_deposit | waiting_for_you | propose_hl_deposit 150 USDC |
| A12 | hl_deposit | waiting_for_touch | after Yes; not reachable in demo: Touch ID is enclave-only; the demo software wallet approves straight to signing |
| A13 | hl_deposit | submitting | after the signature |
| A14 | hl_deposit | KNOWN_DEPOSIT_TX | 1Click says the deposit is seen |
| A15 | hl_deposit | PROCESSING | 1Click says PROCESSING |
| A16 | hl_deposit | SUCCESS or crediting | 1Click says SUCCESS, venue balance not yet up |
| A17 | hl_deposit | confirmed | venue balance rose |
| A18 | hl_withdraw | waiting_for_you | propose_hl_withdraw 20 USDC (always clicks) |
| A19 | hl_withdraw | waiting_for_touch | after Yes; not reachable in demo: Touch ID is enclave-only; the demo software wallet approves straight to signing |
| A20 | hl_withdraw | submitting | after the signature |
| A21 | hl_withdraw | KNOWN_DEPOSIT_TX | deposit seen |
| A22 | hl_withdraw | PROCESSING | on its way |
| A23 | hl_withdraw | crediting | waiting for NEAR Intents to show it |
| A24 | hl_withdraw | confirmed | balance rose |
| A25 | intents_send | waiting_for_you | propose_send 5 USDC to an intents account, read-back done, confirmed: true |
| A26 | intents_send | waiting_for_touch | after Yes; not reachable in demo: Touch ID is enclave-only; the demo software wallet approves straight to signing |
| A27 | intents_send | submitting | after the signature |
| A28 | intents_send | PROCESSING | on its way |
| A29 | intents_send | confirmed | landed |
| A30 | intents_pay | waiting_for_you | propose_send 5 USDC to an address on base |
| A31 | intents_pay | waiting_for_touch | after Yes; not reachable in demo: Touch ID is enclave-only; the demo software wallet approves straight to signing |
| A32 | intents_pay | submitting | after the signature |
| A33 | intents_pay | PROCESSING | on its way |
| A34 | intents_pay | confirmed | landed, hash on the card |
| A35 | trade | waiting_for_you | propose_trade above the threshold |
| A36 | trade | waiting_for_touch | after Yes; not reachable in demo: no demo rail for trade, and Touch ID is enclave-only; trade cards are seeded at waiting_for_you and confirmed only |
| A37 | trade | signing | the wallet signing; not reachable in demo: no demo rail for trade, so there is no live signing tick; the boot sweep rewrites a seeded approved trade row to needs_reconciliation |
| A38 | trade | submitting | posted to Hyperliquid; not reachable in demo: no demo rail for trade, so there is no live submitting tick; the boot sweep rewrites a seeded executing trade row to needs_reconciliation |
| A39 | trade | confirmed | filled |
| A40 | policy_change | waiting_for_you | propose_policy_change raising the threshold to 200, the changes block drawn |
| A41 | policy_change | confirmed | after Yes |
| A42 | policy_change | declined (F) | after No |
| A43 | policy_change | refused (F) | a patch the schema refuses (invalid_patch) |
| A44 | policy_change | waiting_for_you | lowering a cap, the before and after figures on the card |

## B. Failures, refusals and late moves (26 rows, all F)

| id | situation | reach |
|---|---|---|
| B01 | refused: kill_switch | Freeze everything on, then propose_swap |
| B02 | refused: kill_switch_not_patchable | propose_policy_change touching killSwitch |
| B03 | refused: invalid_patch | propose_policy_change with a field the schema rejects |
| B04 | refused: invalid_amount | propose_swap 0 |
| B05 | refused: destination_not_allowed | propose_hl_deposit to a counterparty off the allowlist (demo seam) |
| B06 | refused: max_per_transaction | propose_swap 20,000 USDC |
| B07 | refused: max_per_session | three swaps that together pass 25,000 |
| B08 | refused: forbidden_issuer | a swap into a coin whose issuer the policy forbids |
| B09 | refused: max_issuer_share | a swap that would put one issuer over its share cap |
| B10 | refused: max_freezable_share | a swap into an unknown asset over the freezable cap |
| B11 | refused: simulation_required | the demo rail's simulate throws |
| B12 | refused: policy_unreadable | policy.json made corrupt on disk, then any propose |
| B13 | preflight hold | hl_deposit where one of the five preflight checks holds; not reachable in demo: the demo rail produces no preflight hold, and the boot sweep expires a seeded held (approved + heldSince) row to failed, so an active hold cannot be shown in demo (that is B14); needs a demo preflight-hold seam from node B |
| B14 | hold expired | the same hold after its 15 minutes |
| B15 | rail failed | the demo rail returns ok: false after the signature |
| B16 | provider FAILED | 1Click word FAILED on an hl_deposit |
| B17 | provider REFUNDED | 1Click word REFUNDED on an hl_deposit |
| B18 | stalled | an hl_deposit past its deadline, "Late, nothing has changed" |
| B19 | declined by the human | No on a swap over the threshold |
| B20 | Touch ID closed without an answer | the sheet dismissed, row back to waiting; not reachable in demo: Touch ID closed without an answer is enclave-only; the software-wallet demo never opens the Touch ID sheet |
| B21 | venue outage mid-move | the demo venue read times out during crediting |
| B22 | empty wallet | propose_swap with nothing to spend |
| B23 | unpriced coin | propose_swap of a coin with no USD price |
| B24 | below the HL floor | propose_hl_deposit 2 USDC (floor named) |
| B25 | unified-account withdraw refusal or the sendAsset path | propose_hl_withdraw on a unified account; not reachable in demo: the unified-account withdraw refusal is a live Hyperliquid seam (hl-user-signed.ts); the demo rail signs nothing, so it cannot produce the refusal. Needs node B to add a demo seam |
| B26 | relay expired (NOT_FOUND_OR_NOT_VALID) | a relay swap whose price expired before settling, nothing moved |

## C. Onboarding (15 rows, FLOW where marked)

| id | screen | reach |
|---|---|---|
| C01 | terms card | fresh data dir, first paint |
| C02 | Gatekeeper page in docs | docs/getting-started.md rendered as the person reads it |
| C03 | welcome | after the terms |
| C04 | create or choose | the wallet choice |
| C05 | password | software flow |
| C06 | words | software flow, the recovery words |
| C07 | prove | software flow, prove the words |
| C08 | addresses | the addresses screen |
| C09 | money | the deposit card, USDC on a named network (FLOW) |
| C10 | agent picker: installed and logged in | Claude Code on this Mac (FLOW) |
| C11 | agent picker: not installed | Codex not on this Mac |
| C12 | agent picker: installed, not logged in | fixture binary that fails the login probe |
| C13 | agent picker: Claude Desktop user | the sixth entry, three sentences |
| C14 | threshold | the click threshold step |
| C15 | done | onboarding complete, enclave flow, stopwatch (FLOW: welcome to done) |

## D. The vault (8 rows)

| id | panel | reach |
|---|---|---|
| D01 | custody | vault open, custody panel |
| D02 | recovery | recovery panel |
| D03 | addresses | addresses panel |
| D04 | agent panel | chosen agent, its state, Change and Check again |
| D05 | agent switch: success | Change to another installed agent (FLOW) |
| D06 | agent switch: missing agent | Change to Codex when it is not on this Mac (F) |
| D07 | window | window panel |
| D08 | danger | danger panel |

## E. The ending notice (3 rows)

| id | situation | reach |
|---|---|---|
| E01 | after a click | Yes on a swap, the agent's one sentence |
| E02 | after a refusal (F) | a policy refusal, the agent's one sentence |
| E03 | after a failure (F) | a rail failure, the agent's one sentence |

## F. Session start (2 rows)

| id | situation | reach |
|---|---|---|
| F01 | greeting | a fresh chat, the agent's first turn |
| F02 | what do I hold | the wallet read, one card |

Total 98 rows. Leg b flows: C09, C10, C15 (welcome to done), D05.
