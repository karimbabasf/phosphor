# Node E report: UI craft floor and buttons

Branch rfp/e-craft off main 6ff58a9, worktree phosphor-rfp-e-craft, backend on 4205 (demo,
data under state/), quit before this report. Evidence under evidence-e/.

## 1. Commits

- 3da97fd Every button holds the floor: 36 px, small 30, large 44, both faces of a wait in one cell, one check row and one copy button, and a button inventory that photographs every family in every state
- 14a10d3 The dock keeps its answer on screen: it takes the column but 120 px and never gives way to the transcript, an ask takes a stacked window whole, the transcript fades under it, and the vault's chips drop their dot
- c1a058a Node E report: the button inventory sheets, the app captures at 860 and 400 px, the audit before and after, the detector at 0, and the deposit card's open button on the card's text column
- d3fac11 Merge branch 'main' into rfp/e-craft (bb4b842, the demo-rail test word)
- ed0f0e4 Node E report: counts after the merge of main
- 6f34d66 The dock's answer row sticks to the bottom of the scrolling body: a send card at the app's default window had No and Approve 156 px under the fold (the secure review's finding); the Explorer glyph back at 14 px; the inventory removes its temp pages
- (next) The correctness review's four: quiet buttons keep the floor's 24 px, every pressable has a press, the down slot and every slot hold their floor on the raised surface, a card to read pins its row and the idle block leaves for the dock's stay; netpick steps back on Escape

## 2. Counts

- `npm run typecheck`: exit 0 (TypeScript: No errors found).
- `npm test`: 3104 tests, 3104 pass, 0 fail (after `git merge main` at bb4b842, d3fac11; before
  it the one failure was `demo-rail.test.ts`, a phase-0 contract word the lead fixed on main).
  My branch adds 36 tests, all green.
- The reviewer's gitignored scratch script (scripts/scratch/review-e-secure/dock-check.ts) has
  its own type errors and sits under tsconfig's scripts glob: the typecheck line above is the
  tracked tree (the script set aside for the run and put back).
- `npm run eval`: not run. This node touched no file the agent reads or says (ui/design, index.html,
  scripts, tests only).

## 3. Criteria

- B1 PASS: `node scripts/button-inventory.ts` (108 measurements, 0 problems: heights against 36/30/44,
  label plus 24 px on every family, quiet buttons included, no wrap, no clip) and
  `tests/unit/design-buttons-ui.test.ts` (every .btn rule at its variant, 19 non-.btn pressables
  at 30, quiet padding at 12 px a side). Evidence: evidence-e/inventory/sheet-860.png,
  sheet-400.png, inventory.md, verdicts.md.
- B2 PASS: the sheet shows rest, hover, active, focus, disabled, pending (and on, live) per family;
  the inventory test asserts every family has a rule for hover, active and focus, and every .btn
  family for disabled and pending too; the 20 families that had no press take one shared press
  (a wash of the text at 12 percent one shade past any hover, the compact ones giving 3 percent,
  components.css); the pending measure finds no family showing both faces and no width change
  while waiting (0 of 108). Evidence: the sheets; design-buttons-ui.test.ts "both faces of a
  waiting button share one cell" and "every pressable that is not a .btn has a press".
- B3 PASS: reset.css `[hidden] { display: none !important }` and the test that no other weighted
  display rule exists outside a [hidden] guard or print; disabled buttons at 0.5 opacity with the
  pointer off (button:disabled cursor default, .btn:disabled). Evidence: design-buttons-ui.test.ts.
- B4 PASS: no button mixes an icons.js glyph with a card glyph (scan of every site: the steps fold
  carries the card chevron alone, the rule group heading the icon chevron alone, the sheet shows
  each). Card glyphs and checks.js's chevron are drawn on the same 24 grid at 1.5 px like icons.js.
- B5 PASS: on the live window, Tab lands a 2 px ink outline (verified on the first control),
  Enter and Space switch a tab (real Input.dispatchKeyEvent), Escape closes the Layout menu and
  the deposit card, and steps the network picker back to its tiles from the tokens and the
  address (netpick.js, netpick-ui.test.ts). Escape does not close a dock card in the read state:
  request 1 below (decision.js, node D).
- B6 PASS: the answer row (No and Yes, No and Approve, a read card's Back up now) sticks to the
  bottom of the scrolling body on the dock's ground, in its reading order (under the facts,
  before the fold), so it is on screen whatever the card's height. Send card, bottom of No and
  Approve against the viewport: 749 of 780 at 1180 by 780, 669 of 700 at 960 by 700, 669 of 700
  at 860 by 700, 763 of 800 at 400 by 800. The backup read card at 400 by 800 stacked: 769 of
  800, the split kept. Measured with a parked send (250 USDC to 0x8ba1...BA72,
  the address whole in groups of four) and a parked swap: visible at 1180 by 780 (the default
  window and column), 960 by 700 (default column and a 400 px one), 1280 by 800 at a 400 px
  column, 400 by 700, 400 by 800 and 860 by 700; scrolled to the end the row sits in flow with
  the fold under it and the hairline off. Before: the swap card's No and Yes 137 px under the
  fold at a 400 px column, the send card's No and Approve 156 px under at the default window.
  Evidence: evidence-e/app/chat-dock-*.png, chat-send-*.png, chat-swap-960x700-scrolled-end.png;
  tests/unit/design-dock-ui.test.ts.
- B7 PASS on the shipped colourway and on the hardest themes the server accepts (the lightest
  ground, the dimmest accent, the dimmest down), for every family including danger, hovered and
  pressed included: tests/unit/design-contrast.test.ts. src/view/theme.ts now holds the down
  slot to the text floor and every slot to the raised surface (--bg-2, the lightest the window
  paints) as well as the ground: a red it accepted at 3.5:1 is refused (#a0505c, 2.94:1 on the
  surface) and the shipped #ff5a6e passes (theme-slots.test.ts).
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
- B6: a card taller than the dock keeps its answer on screen by sticking the row to the bottom
  of the scrolling body (CSS alone, decision.js untouched: the DOM order the dock test holds is
  the order the row sticks in). The body's bottom mask went, since it faded the pinned row too;
  the fade is drawn over the row while data-more is true, with a hairline, and both go at the
  end of the card. A card to read (the backup prompt's .screen-actions) pins the same way, so the
  stacked split stays for it. The idle block (mark, Nobody is at the wheel, Start) leaves for the
  dock's stay: the 120 px the transcript keeps reached its mark, a sliver of logo over the dock.
- B2: the press for a pressable that is not a .btn is one shared wash (--press in tokens.css)
  listed by family in components.css; a new family joins the list, and the inventory test holds
  every family to having one.
- B7: hover and press on the primary step toward white, never toward the ground, because the
  label is the ground on every accepted theme.
- B7: two button labels on the third text tone moved to the second (steps fold, rule group
  heading). The danger label stays on --down; the server's floor moved instead (down to the text
  floor, every slot checked on the raised surface), because a floor checked on the ground alone
  left the dimmest accepted down at 4.23:1 on a card. The accepted grounds narrow with it: the
  lightest grey ground is #101010 now (was #212121), which is what the gate red's 4.5:1 on a
  card allows.
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
4. Done on this branch on the lead's word (theme.ts unowned): the down slot's floor, plus every
   slot checked on the raised surface. The up slot is still a mark floor (3:1) and the window
   sets words in it too (the amount that arrived): the same one-line change if wanted.
5. No dependency requested.

## 6. Follow-ups found, not fixed

- ui/design/deposit.css `.netpick-head`: at a 400 px world (browser only; the desktop world is
  never under 560 px) the title truncates to "Tokens ..." beside Change network.
- ui/screens/agent.js:908: the send disc goes pending without a verb; the CSS carries it (see
  decisions), nothing to change unless the disc grows a label.
- src/view/theme.ts: the up slot stays at the 3:1 mark floor and is also text (the amount that
  arrived); the same change as down if the lead wants it.
- The pending ask hidden behind the backup card after a refusal (node D, per the lead).
- ui/design/deposit.css uses trade.css's `feedpulse` keyframes (both sheets always load); a
  shared keyframe in components.css would be one source.
- The secure review's two small ones are done: the send card's Explorer link has its 14 px glyph
  back (`.sendcard-explorer > .icon`, sendcard.css) and the inventory removes its temp pages at
  exit (button-inventory.ts, both pinned by tests).

## 7. Lessons appended

- [E] A dock whose answer sits in its scrolling body needs the column's height, not a share of it (the 62 percent cap plus flex 0 1 auto put No and Yes 137 px under the fold); measure in a browser.
- [E] Grid rows follow the items that are placed: hiding the split handle takes a track with it.
- [E] The theme tool holds --down to the 3:1 mark floor and the window sets words in it; the floor is the server's to raise.
- [E] The inventory sheet forces hover, active and focus-visible through CSS.forcePseudoState on playwright-core's CDP session (the 1.63 copy drives the cached headless shell 1243).

## E2 review fixes

Fresh builder (node E2) on the two holes the re-check left at a21f7da: B6 on the send card
(the sticky answer row covers the address at scroll 0) and B2 (the shared press loses the
cascade for 10 of 20 families). Second failed fix on B6, so 11.2 applies: the hypotheses below
were ranked and the top one tested by measurement before any edit.

### B6: hypotheses, ranked

1. TOP, tested first. `position: sticky; bottom: 0` on a row inside the scroll container cannot
   satisfy "the row never covers a fact": a stuck element paints over the in-flow content that
   fills the scrollport's last rows, and the facts that do not fit are exactly the ones it
   covers. Fix 2 (6f34d66) could never pass the address clause on a card taller than the body.
   Prediction: put the row outside the scroll container (the foot, `flex: 0 0 auto`, after the
   body in DOM order) and the body's scrollport ends above the row, so no visible fact line can
   sit under it (row.top >= body.bottom), the address is either whole in the scrollport or
   clipped with data-more true and a fade, and No/Approve stay on screen because the dock's
   max-height bounds body plus foot.
2. The dock's cap (calc(100% - 120px)) is too small; a taller dock would fit the card at
   scroll 0. Rejected as the cause: at 960x700 the send card scrolls 796 px in a 652 px column,
   no cap fits it, and the address's place inside the card is node D's file. A contributing
   factor at 1180x780 only.
3. The fade signal (data-more) is wrong, so a person is not told there is more. Rejected: at
   scroll 0 data-more is "true" at every size where the card overflows; the covered lines sit
   under an opaque row, and no fade makes a covered line readable.
4. The "1 more waiting, next" line and the kicker take the room. Contributing, not the cause:
   the overflow at 960x700 is 266 px.

### B6: measurements before, at a21f7da (own backend 4228, demo, send 250 USDC to
0x8ba1f109551bD432803012645Ac136ddd64DBA72 on ethereum and swap 500 USDC to ETH parked through
/api/mcp, both needs_approval; browser daemon e2; every size measured after a forced frame,
scroll 0 then scrolled to the end; hit = elementFromPoint at the address line's centre)

Send, scroll 0 (row sticky in the body):
- 1180x780 (col 360): row 694-755, No/Approve bottom 743; address lines 682-700 (hit address at
  the centre, ROW at its bottom edge) and 702-720 (hit ROW): the second line wholly under the row.
- 960x700 (col 400): row 614-675, bottom 663; body clip ends at 691; address lines 682-700 (part,
  cut by the clip) and 702-720 (clipped); the row covers the lines above the address.
- 860x700: row 614-675, bottom 663; address lines 585-603 (address), 605-623 (ROW), 625-643 (ROW),
  645-663 (ROW): three of four lines under the row.
- 400x800: row 714-775, bottom 763; address lines 746-764 (ROW) and 766-784 (half under the row).
- Scrolled to the end every line hits the address at all four sizes; the row stays put.
Swap: No/Yes bottom at scroll 0: 694, 661, 655, 727; scrolled to the end 694, 614, 614, 714;
both address lines hit the address at every size and state.
