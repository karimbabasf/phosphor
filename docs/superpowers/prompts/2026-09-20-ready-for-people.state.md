# Ready for people: state

Lead: Claude (Opus 5), session c49886b8. Started 2026-09-20 19:05 PDT. Main at 7e0357f after phase 0.

## Baseline (phosphor-baseline worktree, detached at ab6f8f1)
- typecheck: exit 0
- npm test: 3066 pass, 0 fail
- npm run eval: 29/29 pass
- npm run eval:live: running (started 19:14 PDT), counts to be filled when it finishes
- impeccable detect ui/: 3 findings after the Geist ignore (2 clipped-overflow warnings on html/body, 1 advisory hairline border plus wide shadow); baseline JSON at docs/superpowers/prompts/ready-for-people/impeccable-detect-baseline.json

## Phase 0 (done)
- 7e0357f: stage vocabulary contract in src/proposals/view.ts (relay words, no vendor word in a label, STAGE_COPY, KIND_STAGES, LEGACY_SWAP_PATH), SwapDraft.venue widened, history reader marks relay swaps inside.
- Situation list: docs/superpowers/prompts/2026-09-20-ready-for-people.situations.md (98 rows).
- Lessons file created.

## Nodes (phase 1), worktrees ../phosphor-rfp-<node>, branches rfp/<node>, all off 7e0357f
| node | branch | status |
|---|---|---|
| A relay swap | rfp/a-relay | building |
| B Hyperliquid | rfp/b-hyperliquid | building |
| C agent picker | rfp/c-agent | building |
| D one card, voice | rfp/d-card | building |
| E craft floor | rfp/e-craft | building |
| F anxiety harness | rfp/f-anxiety | building |
| G launch readiness | rfp/g-launch | building |

Ports: A 4201, B 4202, C 4203, D 4204, E 4205, F 4206, G 4207 (PHOSPHOR_PORT), data dirs under each worktree's state/.

## Decisions (criterion number)
- 5.4 / 3.1: vendor words stay as stage IDs (they are what diagnose and reconciliation check); only labels changed. PROCESSING = "On its way", SUCCESS and SETTLED = "Waiting for the venue to credit it" (same sentence through the gap, so the person sees one phrase).
- 3.4: waitingOn says "The transfer" for 1Click phases and "NEAR Intents" for relay phases; "1Click" told nobody what they were waiting for.
- 9.8 (bad-button.jpg): missing from the repo; asked for in the report's You section, E works from the inventory instead.
- 6: judge model probe order per the prompt; env names in ~/.config/jev-browse/env are TEXT_MODEL_* (NEAR AI Cloud) and OPENROUTER_*.

## Open
- eval:live baseline count.
- 19.94 USDC at 1Click (HS 3452114377): not touched.
