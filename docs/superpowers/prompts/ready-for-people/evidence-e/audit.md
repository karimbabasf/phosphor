# Impeccable audit: onboarding, chat, vault, deposit

Run per `~/.claude/skills/impeccable/reference/audit.md` on 2026-09-21 against the parent
commit 6ff58a9 (before) and rfp/e-craft at its last commit (after). Web target `ui/`, the
`impeccable context` step run once (no PRODUCT.md, no DESIGN.md: the code is the context).
Evidence: the button sheets under `inventory/`, the app captures under `app/` (automation
Brave against a demo backend on 4205, a demo wallet, a swap parked over the threshold), the
detector output in `detector-after.json`, the baseline in `../impeccable-detect-baseline.json`.

## Audit health score

| # | Dimension | Before | After | Key finding |
|---|-----------|--------|-------|-------------|
| 1 | Accessibility | 2 | 3 | 19 pressables under 30 px, no pressed face on a chip, a hovered primary under 4.5:1 on a legal accent; left: Escape on a dock read card, the danger label on an adversarial theme (server floor) |
| 2 | Performance | 4 | 4 | transform and opacity motion only, one targeted will-change, vendored fonts preloaded, svg sprites |
| 3 | Responsive | 2 | 3 | No and Yes under the fold at a 400 px column (P0); left: a lone character at the end of a wrapped address, the token list's hard cut, a truncated head at a browser-only width |
| 4 | Theming | 4 | 4 | every colour a token; the six literals are white lifts and one scrim, on purpose |
| 5 | Implementation integrity | 3 | 4 | three hook classes without a rule, the check row drawn in the wrong sheet with a round box, the pressed chip drawn twice; detector 3 to 0 |
| | **Total** | **15/20** | **18/20** | Good to Excellent |

## Implementation integrity verdict

Pass. The window is one product-specific system: two faces (Sora, Geist Mono), one token
set that set_theme rewrites, one icon sprite plus card glyphs drawn on the same 24 grid with
the same 1.5 px stroke, one button grammar with a named verb for every wait, three tiers of
surface (readout, opens, acts) written down in components.css. What drifted was mechanical:
copies of one rule in two sheets, hooks without rules, heights set by hand under the floor,
and a dock capped for a layout it no longer had. Detector: 3 findings before (two clipped
overflow warnings on html and body, one hairline plus lift advisory), 0 after, both recorded
as file-scoped ignores with the reason (the fixed one-screen deck; the app's depth language).

## Executive summary

- Score 15/20 before, 18/20 after.
- 15 issues found: 1 P0, 6 P1, 6 P2, 2 P3. 11 fixed in ui/design and index.html, 4 filed as
  requests or follow-ups (JS files other nodes own, one server floor).
- The P0: the dock's No and Yes were under the fold at a 400 px column (137 px under at
  800 px of height, 300 px at 860 px stacked). Fixed in layout.css, measured on screen at
  400 by 800, 400 by 780, 860 by 800, 860 by 700.

## Findings

**[P0] The answer under the fold.** Location: ui/design/layout.css `.dock` (max-height 62%,
flex 0 1 auto) with decision.js putting No and Yes in the scrolling body under the facts.
Category: Responsive. Impact: a request with no visible way to answer it, on a 400 px column.
Standard: term 9 B6, term 3 3.6. Fix: the dock takes the column but 120 px and never gives
way to the transcript; under 960 px an ask takes the stacked stage whole. Fixed (14a10d3).

**[P1] Both faces of a wait.** Location: components.css, the grid cell keyed on
`data-pending-label` alone; agent.js:908 sets the send disc pending with no verb. Category:
Implementation integrity. Impact: a spinner beside a blank, and on the 36 px disc the word
Working overflowing the glyph. Fix: the cell is keyed on `data-pending` too; the disc waits
with the spinner alone. Fixed (3da97fd).

**[P1] Nineteen pressables under the floor.** Location: layout.css (.tab 28, .layout 28,
.btn.freeze 28, .dock-close 24, .dock-next 28), trade.css (.pane-hide 24, .pane-show 24,
.layers 26, .trade-more 28, .trade-act 26, .layers-row 28), agent.css (.steps-fold 22),
deposit.css (.netpick-link 21), pro.css (button.rule-group-title 21, .activity-link 29,
.chip-filter 28), components.css (button.chip 26), sendcard.css (.sendcard-info 16),
bar-state as a button 20. Category: Accessibility. Standard: term 9 B1. Fix: every one at
the small variant's 30, every .btn at its variant, Freeze the small variant by class. Fixed.

**[P1] A pressed chip with no face.** Location: components.css `.chip`; vault.js writes
aria-pressed on the frost choices. Impact: the chosen frost time looks unchosen. Fix:
`button.chip[aria-pressed="true"]` in the ink wash, pro.css's copy folded in. Fixed.

**[P1] The hovered primary under the text floor.** Location: components.css, hover mixed
12 percent of the ground into the accent; the label is the ground. Impact: an accent the
server accepts at 4.5:1 read at 3.8:1 the moment the pointer arrived. Standard: term 9 B7.
Fix: hover and press step toward white. Fixed, pinned by design-contrast.test.ts.

**[P1] A button that looks like a readout.** Location: index.html `#chip-backup`, a
button styled as `.status-line.bar-state` with no hover, no pointer, a 20 px box.
Category: Accessibility. Fix: `button.bar-state` at 30 px with a pointer and a hover lift.
Fixed.

**[P1] Labels on the third text tone.** Location: agent.css `.steps-fold`, pro.css
`button.rule-group-title` (text-3, 3.6:1 on the lightest ground set_theme accepts).
Standard: term 9 B7. Fix: the second tone (5.0:1 there). Fixed. The danger label
(`--down`, held by the server to the 3:1 mark floor) is the same class of gap and belongs
to src/view/theme.ts: request filed in the report.

**[P2] Status pills with a dot.** Location: vault.js chip() appends a `.dot`; Custody and
Recovery chips. Category: Implementation integrity (Karim's list, 2026-09-18). Fix:
`.chip > .dot { display: none }`. Fixed.

**[P2] A grey rim on the green fill.** Location: components.css `.btn:hover` set the edge to
text-3 for every family. Fix: `--btn-edge-hover` per family. Fixed.

**[P2] One character alone.** Location: the swap dock's "Stays in your account" address
(decision.js destinations block, `.addr` word-break: break-all) at a 400 px column: 41
characters on one line and the 42nd on the next. Category: Responsive. Fix: the send card's
groups of four (sendcard.js groupsOf) on this block too. Request for node D.

**[P2] A row cut hard.** Location: `.netpick-list` (overflow auto, 30 px of hidden rows at
800 px, no data-cut). Category: Responsive. Fix: the `scrolls` class and the data-cut
scroll hook agent.js:990 and trade.js:454 already use. Request for the owner of netpick.js.

**[P2] Escape leaves a card to read up.** Location: decision.js, the dock in the read state
(the backup prompt, a receipt, the deposit card) with its X; Escape does nothing. An ask
must not close on a key (decision-dock-ui.test.ts), a card to read may. Standard: term 9
B5. Request for node D.

**[P2] "Tokens ..." at 400 px.** Location: deposit.css `.netpick-head` at a 400 px world:
the title truncates beside Change network. Only reachable in a browser (the desktop world
is never under 560 px). Follow-up, not fixed.

**[P3] Toggles with no hover.** Location: checks.css `.checks-toggle`, layout.css
`.dock-report-toggle`. Fix: the summary, count and chevron lift on hover. Fixed.

**[P3] The transcript sliced under the dock.** Location: layout.css `.conversation-body`.
Fix: a 32 px fade at the cut while the dock is up. Fixed.

## Patterns

- Heights set by hand in screen sheets against a floor the component sheet owns: 19 of
  them. The component sheet now states the floor and the tests hold every family to it.
- One rule kept in two sheets (the check row, the pressed chip, the copy button's glyph):
  the shared one lives in components.css now and the screen sheets keep only what is theirs.
- Waits without a named verb: the CSS stacks the faces regardless now; the JS that names no
  verb (agent.js:908) is the one place left, listed as a request.

## Positive findings

- Every colour is a token and set_theme rewrites them all; the contrast floors are checked
  on both sides, and now for every button family at the edges of what the server accepts.
- Every wait names its noun; every scrolling list fades at its cut; the focus ring is one
  rule for the whole window and it is visible (2 px ink, verified on Tab).
- Reduced motion is honoured sheet by sheet, and the one infinite motion on a button is
  the breathing ring on the live Yes, which is the one Karim asked for.
- Enter and Space activate every button (verified through real key events), Escape closes
  the Layout menu.

## Recommended actions

1. **[P2] `/impeccable adapt`** on the swap dock's destinations block once node D lands the
   grouped address, at 400 px.
2. **[P2] `/impeccable harden`** on netpick.js's token list (the data-cut hook) and on the
   dock's read cards (Escape).
3. **[P2] `/impeccable polish`** after the merge of C and D, rerunning
   `node scripts/button-inventory.ts` so their new families get recipes and states.
