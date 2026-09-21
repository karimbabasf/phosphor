# Node D report: one card and the agent's voice

Branch rfp/d-card, worktree /Users/karimbaba/Developer/Apps/phosphor-rfp-d-card, port 4204.
Parent commit 6ff58a9; main merged at 1e8564d (bb4b842). Evidence under evidence-d/.

## 1. Commits

- 4573d18 A held row is Holding, every view carries its one line of copy, and a late row counts in words
- 651b3ae One card per move, one skeleton for every kind, painted in place as its row moves
- de767c5 The agent's words beside a card: three sentences, sixty words, the app's vocabulary, no id
- 575810b The stage line keeps its room, an id on a step row is its two ends, and a browser proves the card
- 4e65b8e On the turn a move is proposed the reply carries no clock and no typical figure
- 6079a6e A hash inside the rail's own line is cut to its ends, and an unknown vendor word is the app's phase
- 779a544 Lessons from node D: the driver block that never lands, painting a card in place, and the stage line's room
- e5c193d The decision sentence has a written shape, with its figures, and the floor is a percent under the quote
- 1e8564d Merge branch 'main' into rfp/d-card
- 2abc89f A swap the network did not accept is still being checked, the relay is named like the native venue, and Escape closes a card being read
- 77e6705 The five things the card carries are named as not for the propose turn
- 965525c The window links the move card's stylesheet
- 8c119a9 The card proof reads the stylesheet the window links, not one it injected
- f3e4af4 A Hyperliquid move draws the quote on its landing leg and the floor in the facts
- (the evidence commit that carries this report)

## 2. Counts

- `npm run typecheck`: exit 0 (evidence-d/typecheck.txt).
- `npm test` on the tip: 3078 tests, 3078 pass, 0 fail (evidence-d/test-run.txt). Baseline 3066; 12 new
  tests on this branch and 11 rewritten. Before main was merged the count was 3072/3071 with the one
  pre-existing failure at demo-rail.test.ts:161 (fixed on main at bb4b842, merged).
- `npm run eval` (scripted): 29 scenarios, 29 pass, four runs on this branch; the last on 77e6705
  (evidence-d/eval-scripted-4.log, the first is eval-scripted.log).
- Live eval, `node scripts/eval.ts --live --only S11,S29`, three runs of three, all with the reply
  length rule added to S11 and S29 (stricter than baseline). Karim's word through the lead: the
  live eval is his to run from here, so these are quoted as they came and nothing more was run.
  - eval-live-1.log, the rule alone in the role: S11 0/3 (74, 81, 75 words, every fact present), S29 0/3
    (floor percent missing, 79, 78, 61 words).
  - eval-live-2.log, the written shape added: S11 1/3 (run 1 the agent sized its floor off the chart
    price, the app refused the swap under its floor and the reply explained it in five sentences; run 2
    66 words with a balance sentence; run 3 PASS), S29 1/3 (run 1 PASS; runs 2 and 3 at 65 and 70
    words).
  - eval-live-3.log, the five things named as the card's: S11 3/3 PASS (about 40 words each, every fact,
    judge f2/r2), S29 1/3 (run 1 PASS; runs 2 and 3 "floor given in tokens only, no floor percent": the
    agent sized its floor off a market price before the quote came back and dropped the percent).
  - Baseline was S11 3/3 and S29 2/3. S11 is at baseline with the stricter rule; S29 is one run under
    it, and the miss is the floor percent, which the role names ("The floor is the percent it sits
    under the quote and not a word on how you picked it") and the agent drops when its floor did not
    come off the quote. The floor itself (30 percent under the quote in two runs) is sized before the
    quote exists, which is the rail's design (node A) and not phrasing.

## 3. Criteria

- 5.1 PASS. One card per proposal for its whole life, redrawn in place by id; a read-back before propose
  updates the same card. Driver run: scripts/card-proof.ts on S29 at 1280 and at 700 against the
  linked stylesheet, `.chat-card` per proposal id = 1 at the end, chat cards 1, receipt cards 0
  (evidence-d/card-proof-1280/card-proof.json `counts`, evidence-d/card-proof-700/card-proof.json).
  Tests: agent-cards-ui "a proposed swap is one card", "the receipt of a move folds into its card".
- 5.2 PASS. At most one read card per turn, and none under the move it was a check for; a move card is
  never dropped. Test: agent-cards-ui "a read on the way to a move leaves no card of its own". The S29
  walk (wallet read, then propose) ends with one chat card (`counts.chatCards` = 1).
- 5.3 PASS. The state word and the stage line change with a 240 ms fade on a sine ease-out
  (ui/design/chatcard.css; measured `chatcard-fade-a/b 0.24s` on every change, card-proof.json `fade`);
  the card's height moved 0 px across five stage changes at both widths (`heightJumps`); both folds
  survive every repaint (tests "a move card follows its proposal", "a read-back of a move keeps the
  fold"); the "last changed" clock resets to 0s at every stage (`stages[].clock`) and reads the
  end-to-end time on Confirmed.
- 5.4 PASS. Only STAGE_LABEL words on the face (`stagesSeen`: Sending it, Deposit seen, Waiting for the
  deposit, On its way, Waiting for the venue to credit it, Confirmed). A vendor word the table has no
  label for reads as the app's phase (proposal-view test). The raw vendor word sits only behind
  Details, in the app's case, on a row that stopped or is late ("The transfer calls this: refunded"),
  never under Confirmed (agent-cards-ui test).
- 5.5 PASS on S11 (3/3 live, about 40 words, three sentences, no id, no tool), one run short on S29
  (see Counts). The role: three sentences and sixty words, the decision on the propose turn in a
  written shape, only the figure that changed after, no id, no tool name (role.test.ts). The step rows
  and the card shorten ids; the rubric rule is in S11.json and S29.json with mustNotSay for a UUID
  and for a tool name.
- 5.6 PASS. src/http/ended.ts asks for one plain sentence with the figure that changed
  (ended-notice test); the role says so and "never twice for one move". Dedupe stays on (id, stage),
  frozen rule 5: see Decisions.
- 5.7 PASS. One skeleton for every kind (title, the two legs with their pockets, at least, fee, the
  stage line, one Details fold for checks and reference): swap, hl_deposit, hl_withdraw, intents_pay
  and a receipt all go through moveCard (tests "a send is the same skeleton", "a Hyperliquid move
  draws the quote on its landing leg", "a floor prints as a quantity"). The receipt of a move on the
  thread folds into its card, a move made elsewhere draws the same card off its row (known failure 4
  closed; test "the receipt of a move folds into its card").
- 3.1 PASS. No nonce, intent hash, verifier, solver, token_diff, bps, EIP, ERC, base units, RPC or
  router in persona, role, greeting, view copy, lifecycle, cards.js or sendcard.js user text
  (`/usr/bin/grep -rniE` over those files finds only comments and the vendor's own identifiers). Ids
  print as two ends of 8 behind a Reference label with a Copy that carries the whole id, on the card,
  in the rail's evidence line and on step rows (tests in agent-cards-ui and agent-transcript-ui).
- 3.2 PASS. An open swap card carries six numbers: spend, receive (about), at least, fee, the clock and
  the typical figure; the head figure repeats the spend only while the card is folded (chatcard.css
  hides it open). An HL card is the same six. Floors cut to 6 significant figures with "at least".
- 3.3 PASS. The card reads its word off the view the reply carries (STATUS_WORD is gone from cards.js),
  proposal_status returns the view, the agent is told to name a stage only in stageLabel and stageCopy
  (persona WORDS). The send card's pill reads the view's word too. The one fallback table left is
  sendcard.js STATUS for a row that reaches it without a view, which the dock never hands it: see
  Follow-ups.
- 3.4 PASS. Every wait prints STAGE_COPY verbatim on the stage line, waitingOn is on the view and the
  clock says "12s of about 45s"; a held row waits on "The checks" (new `held` stage); a swap the
  network did not accept waits on NEAR Intents while the app checks (lead's item).
- 3.5 PASS. A refusal's face carries the rule's own sentence and the stage copy's next step ("Change the
  rule in the window"); a failure's face carries the first sentence of what the rail said with braces,
  brackets and quotes stripped, and the whole line stays behind Details as evidence with every long id
  cut to its ends (test "a move card follows its proposal", the refunded case). The role owes the same
  three sentences.
- 7 PASS. No gate touched: the chat card draws no deciding control (test "cards.js builds nothing that
  decides anything" names the two new buttons, Copy and the fold), Escape on the dock closes only a
  card being read and never an ask (decision-dock-ui test), the injection suite is green inside
  `npm test`. src/policy/render.ts carries no blame word (its sentences are the person's own: "Ask me
  before anything above $100"); the role forbids "you", "invalid", "illegal", "unauthorized" in a
  refusal. The engine's own reason at src/policy/engine.ts:412 says "nothing ever asks you": not mine,
  under Requests.
- 2.3 PASS. Row written to word on screen: 0 to 53 ms over ten stage changes (card-proof.json
  `latencyMs`), no timer between the state frame and the paint.
- 11 PASS. Every fix has its test named in the commit; the changed tests are red on the parent commit
  (evidence-d/parent-red.txt: 8 red in agent-cards-ui, 1 in agent-transcript-ui, 2 in proposal-view,
  1 each in proposal-outcome, ended-notice, send-card-ui, 3 in role) and green here. No second fix on
  one symptom was needed. Every ui/ change has a source-assertion test (11.4). 11.5 (the bundled app)
  was not run here: the proof serves ui/ from the demo backend, the way the dev shell does.

## 4. Decisions

- 5.5 / frozen rule 10: the decision sentence on the propose turn keeps the figures S11 and S29 name
  (spend, expected, floor in tokens and percent, the click or the auto-run), because the rubrics are
  frozen and the six live runs behind FIGURES are why they exist; "no number the card already shows
  except the one that changed" is applied to every turn after the propose. The cap applies to both.
- 5.6 / frozen rule 5: the ending notice stays keyed on (id, stage), so a row told as late is told
  again when it confirms. "Never two notices for one row" is read as never two for one ending; the
  frozen rule and the vault gotcha ("Seen is the stage, never the id") outrank the criterion's letter.
- 5.7: one fold means the Details fold inside the card (checks, who decided, when, reference, hash,
  the vendor's word); the card's own head fold (collapse to one line) is kept as it was, because a
  long chat needs it and the existing tests hold it.
- 5.7 / frozen rule 3: the thread's send card is the common skeleton, the full address on the leg it
  lands on in groups of four with Copy and Explorer, recipient facts and the preflight checks behind
  Details. The dock keeps ui/screens/sendcard.js with its buttons. tests/unit/send-card-ui.test.ts had
  one test pinning the old embed; it asserts the same facts on the skeleton now.
- 3.2: the head figure hides while the card is open so the spend is not printed twice.
- 3.4: a new `held` stage (approved with heldSince) on every kind with a preflight; "Signing" over a
  held row was the wrong wait with the wrong owner.
- 3.5 / 5.4: on a failure the rail's whole line is evidence under Details ("What the app recorded")
  with every long id cut to its ends; the face gets one sentence.
- 3.1: "1Click" stays in one send-card tooltip (a vendor's name, not on the banned list, and
  send-card-ui pins it); "solver" and "router" are gone from every user string I own.
- The role's length ceiling in tests/unit/role.test.ts moved 19,500 to 21,100 (20,700 to 22,300 with a
  profile), following the file's own pattern of dated raises: the words rule (3.1), the cap and the
  written shape of the decision sentence (5.5) and the gate sentences (7) are surface the agent must
  carry; the JSON/error-string line folded into the words rule.
- The live eval was stopped at Karim's word after its third run; the lines are quoted as they came.
- The proof script scripts/card-proof.ts is new (unowned path) and points the app's chat child at the
  scripted agent through HOME, because config.json's driver block never reaches the app (Follow-ups).
- ui/index.html: one line outside my list, at the lead's word (965525c): the link to
  ./design/chatcard.css after cards.css, since tests/unit/ui-links.test.ts forbids a stylesheet
  injected from JS. The lead resolves the index.html merge.
- decision.js and receipt.js (unowned): the minimal changes the lead asked for, each with a
  source-assertion test; the "Through null" line on every native swap's fold was fixed in the same
  line as the relay entry.
- Real money: none moved. Every run was demo mode on 4204 with a data dir under state/, removed after.

## 5. Requests for the lead

1. src/policy/engine.ts:412 (criterion 7, no blame word in a refusal; not mine):
   ```
   -    `Asking above ${money(ask)} and refusing above ${money(cap)} means nothing ever asks you: everything small enough to be allowed is also small enough to run on its own. Put the ask below the cap, both in the same patch.`,
   +    `Asking above ${money(ask)} and refusing above ${money(cap)} means nothing would ever wait for a click: everything small enough to be allowed is also small enough to run on its own. Put the ask below the cap, both in the same patch.`,
   ```
2. No dependency requests. playwright-core for the proof is read from the npx cache
   (~/.npm/_npx/705bc6b22212b352, 1.63.0) the way scripts/window-proof.ts already does.

## 6. Follow-ups found, not fixed

- src/config.ts loadConfig drops the `driver` block, so `driver.claudeBin` in config.json reaches
  nothing: the app's own chat child is always the real `claude` (node G owns config.ts). scripts/eval.ts
  believes its idle-agent config covers the app's chat and it does not: every scripted eval scenario
  starts a real Claude Code session for the window's conversation. Seen when my first proof runs
  answered in a live model's words (two turns, before HOME pointed elsewhere).
- The agent sizes a swap's minAmountOut before the quote exists, off a price it read (the wallet's or
  the chart's), so its floor sits 2 to 30 percent under the quote and once (eval-live-2 run 1) above
  it, which the app refused. A quote-then-propose shape, or a rail that takes a percent instead of a
  figure, is node A's call. It is what costs S29 its floor percent.
- ui/screens/sendcard.js keeps a STATUS fallback table for a row handed to it without a view; the dock
  always passes a row with one. Remove once tests/unit/send-card-ui.test.ts fixtures carry views.
- ui/screens/decision.js:794 builds a stub view with its own "Waiting for you" for a row without one,
  and its "The rest of it" fold prints the rail's own summary line, which for a swap carries "solver
  floor ... base units" (the rail's words, node A's).
- The `receipts` read tool answers a list and the window draws a bare "Move" card for it (KINDS.receipts
  = 'move', pre-existing); it is not a proposal and probably wants the facts card.
- The receipt shell (cards.js wrapReceipt) still draws for a receipt whose row the state frame no
  longer carries (older than the twenty decided rows it keeps); it now prints no stage word.
- The proof's element screenshots are clipped by the viewport and the column's sticky header at 700;
  the counts and the JSON are the evidence, the pictures are for the eye.

## 7. Lessons appended

Five lines in docs/superpowers/prompts/2026-09-20-ready-for-people.lessons.md: the driver block that
never lands, painting a card in place, the stage line's room, flex trimming a leading space, and
Playwright's element screenshot never finding a ticking card stable.
