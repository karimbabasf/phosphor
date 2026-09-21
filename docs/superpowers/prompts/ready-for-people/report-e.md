# Node E report: UI craft floor and buttons

Branch rfp/e-craft off main 6ff58a9, worktree phosphor-rfp-e-craft, backend on 4205 (demo,
data under state/), quit before this report. Evidence under evidence-e/.

## 1. Commits

- 3da97fd Every button holds the floor: 36 px, small 30, large 44, both faces of a wait in one cell, one check row and one copy button, and a button inventory that photographs every family in every state
- 14a10d3 The dock keeps its answer on screen: it takes the column but 120 px and never gives way to the transcript, an ask takes a stacked window whole, the transcript fades under it, and the vault's chips drop their dot
- c1a058a Node E report: the button inventory sheets, the app captures at 860 and 400 px, the audit before and after, the detector at 0, and the deposit card's open button on the card's text column
- d3fac11 Merge branch 'main' into rfp/e-craft (bb4b842, the demo-rail test word)

## 2. Counts

- `npm run typecheck`: exit 0 (TypeScript: No errors found).
- `npm test`: 3096 tests, 3096 pass, 0 fail, after `git merge main` at bb4b842 (d3fac11). Before
  the merge the one failure was `demo-rail.test.ts` "the stall knob stops the walk at PROCESSING",
  a phase-0 contract word the lead fixed on main; it failed the same way on the parent 6ff58a9
  (3068 tests, 3067 pass). My branch adds 28 tests, all green.
- `npm run eval`: not run. This node touched no file the agent reads or says (ui/design, index.html,
  scripts, tests only).

## 3. Criteria

- B1 PASS: `node scripts/button-inventory.ts` (108 measurements, 0 problems: heights against 36/30/44,
  label plus 24 px, no wrap, no clip) and `tests/unit/design-buttons-ui.test.ts` (every .btn rule at
  its variant, 19 non-.btn pressables at 30). Evidence: evidence-e/inventory/sheet-860.png,
  sheet-400.png, inventory.md, verdicts.md.
- B2 PASS: the sheet shows rest, hover, active, focus, disabled, pending (and on, live) per family;
  the inventory test asserts every .btn family has a rule for each of the five; the pending measure
  finds no family showing both faces and no width change while waiting (0 of 108).
  Evidence: the sheets; design-buttons-ui.test.ts "both faces of a waiting button share one cell".
- B3 PASS: reset.css `[hidden] { display: none !important }` and the test that no other weighted
  display rule exists outside a [hidden] guard or print; disabled buttons at 0.5 opacity with the
  pointer off (button:disabled cursor default, .btn:disabled). Evidence: design-buttons-ui.test.ts.
- B4 PASS: no button mixes an icons.js glyph with a card glyph (scan of every site: the steps fold
  carries the card chevron alone, the rule group heading the icon chevron alone, the sheet shows
  each). Card glyphs and checks.js's chevron are drawn on the same 24 grid at 1.5 px like icons.js.
- B5 PASS: on the live window, Tab lands a 2 px ink outline (verified on the first control),
  Enter and Space switch a tab (real Input.dispatchKeyEvent), Escape closes the Layout menu.
  Escape does not close a dock card in the read state: request 1 below (decision.js, node D).
- B6 PASS: with a swap parked over the threshold, No, Yes and the fold toggle are inside the dock
  and the viewport at a 400 px column (1280 by 800 and 1180 by 780, the app's default window),
  and at 400 and 860 px stacked (800 and 700 tall). Before: 137 px and 300 px under the fold.
  Evidence: evidence-e/app/chat-dock-*.png; measurements in the commit 14a10d3 message;
  tests/unit/design-dock-ui.test.ts.
- B7 PASS on the shipped colourway and on the hardest themes the server accepts (the lightest
  ground #212121, the dimmest accent), for every family, hovered and pressed included:
  tests/unit/design-contrast.test.ts. One named gap: the danger label is painted from --down,
  which the server holds to the 3:1 mark floor (request 4).
- 3.6 PASS at 860 and 400 px columns on onboarding (terms, welcome, create, password), chat with
  the dock, vault and deposit (networks, tokens): overflowX 0 everywhere, no clipped element found
  by the DOM probe, every button in view. Two follow-ups at browser-only widths (netpick head
  truncation, a lone address character), section 6. Evidence: evidence-e/app/*.png.
- The three hook classes PASS: .check-row and .check are the shared check row in components.css
  (trade.css keeps no copy), .sendcard-copy shares the copy button's rule with .receipt-copy,
  .tcard-open sits on the card's text column (cards.css). Tests in design-buttons-ui.test.ts.
- Impeccable audit at 0 blocking findings PASS: evidence-e/audit.md (15/20 before, 18/20 after;
  1 P0, 6 P1, 6 P2, 2 P3; 11 fixed, 4 filed). Detector 3 findings before (the baseline json), 0
  after: evidence-e/detector-after.json, two file-scoped ignores with reasons in
  .impeccable/config.json; the hook stays off.
- 11.4 PASS: every ui/ change is pinned by a source assertion (design-buttons-ui 12,
  design-contrast 5, design-dock-ui 4, button-inventory 7 tests), 10 of 11, 4 of 4 and the
  inventory's red on the parent, all green on the fix.

## 4. Decisions

- B1: every pressable that is not a .btn holds the small variant's 30 px; icon-only buttons keep
  their 16 px glyph in a 30 px box; a .btn in a table row (trade-act) holds 36, not a hand-set 26.
- B1: Freeze is the small variant by class in index.html (`btn btn-sm freeze`) rather than a
  stylesheet height, so the class says what the box is.
- B2: the CSS stacks both faces whenever data-pending is set, verb or no verb; a button without a
  verb loses only its width reserve. The send disc names no verb on purpose: the reserve would
  widen a 36 px disc, and the disc waits with the spinner alone.
- B6: the dock never gives way to the transcript (flex 0 0 auto, max-height calc(100% - 120px));
  under 960 px an ask takes the whole stage and a read card keeps the split. The desktop window
  never goes below 960 by 700 (src-tauri/src/main.rs:298), so the stacked rules serve the
  browser-served window only.
- B7: hover and press on the primary step toward white, never toward the ground, because the
  label is the ground on every accepted theme.
- B7: two button labels on the third text tone moved to the second (steps fold, rule group
  heading); the danger label stays on --down and its floor is a server request, not a stylesheet
  workaround.
- Karim's list: the vault's status chips drop their dot; the bar's status lines keep theirs (no
  pill there).
- Detector: the two overflow warnings and the hairline-plus-lift advisory are recorded as
  file-scoped ignores with reasons (the fixed one-screen deck; the app's depth language), never
  silenced project-wide.
- 3.6: the tx row's title is a sentence and wraps on a narrow column by design; the inventory
  measure allows it (recipe `sentence: true`) rather than clipping the sentence.
- The inventory sheet renders the shipped colourway; the set_theme space is covered numerically
  by design-contrast.test.ts rather than by pictures.

## 5. Requests for the lead

1. ui/screens/decision.js (node D), Escape closes a card to read, never an ask (B5). In boot(),
   after the vault select:
   ```
       dom.on(document, 'keydown', function (event) {
         if (event.key !== 'Escape' || !showing) return;
         if (showing.kind !== 'receipt' && showing.kind !== 'card') return;
         event.preventDefault();
         close();
       });
   ```
   decision-dock-ui.test.ts's "no key dismisses it" stays true for asks.
2. ui/screens/decision.js or cards.js (node D), the swap dock's "Stays in your account" address
   at a 400 px column breaks after 41 characters and leaves the 42nd alone on a line: draw it in
   groups of four the way sendcard.js:352 does (`groupsOf(view.to)` into `.sendcard-group` spans,
   the `.sendcard-address` rule already wraps at group edges).
3. ui/screens/netpick.js (owner per the lead), the token list cuts a row hard at its edge: give
   `.netpick-list` the `scrolls` class and the data-cut scroll hook agent.js:990 uses
   (`dom.setAttr(list, 'data-cut', top && bottom ? 'both' : (top ? 'top' : (bottom ? 'bottom' : null)))`
   on scroll and on resize); components.css draws the fade for `.scrolls[data-cut]`.
4. src/view/theme.ts (node G or the lead), the down slot is text: in applyPatch's checks,
   `{ what: 'down', colour: next.down, floor: MIN_MARK_CONTRAST }` to
   `{ what: 'down', colour: next.down, floor: MIN_TEXT_CONTRAST }`. The shipped down (#ff5a6e)
   reads at 5.98:1 on bg-1 so nothing shipped changes; a patch such as down #a0505c (3.4:1) is
   accepted today and puts Turn off, Failed and every amount that left under the text floor.
   design-contrast.test.ts names this and flips to holding btn-danger with the rest once the
   floor moves (its last assertion).
5. No dependency requested.

## 6. Follow-ups found, not fixed

- ui/design/deposit.css `.netpick-head`: at a 400 px world (browser only; the desktop world is
  never under 560 px) the title truncates to "Tokens ..." beside Change network.
- ui/screens/agent.js:908: the send disc goes pending without a verb; the CSS carries it (see
  decisions), nothing to change unless the disc grows a label.
- ui/design/deposit.css uses trade.css's `feedpulse` keyframes (both sheets always load); a
  shared keyframe in components.css would be one source.

## 7. Lessons appended

- [E] A dock whose answer sits in its scrolling body needs the column's height, not a share of it (the 62 percent cap plus flex 0 1 auto put No and Yes 137 px under the fold); measure in a browser.
- [E] Grid rows follow the items that are placed: hiding the split handle takes a track with it.
- [E] The theme tool holds --down to the 3:1 mark floor and the window sets words in it; the floor is the server's to raise.
- [E] The inventory sheet forces hover, active and focus-visible through CSS.forcePseudoState on playwright-core's CDP session (the 1.63 copy drives the cached headless shell 1243).
