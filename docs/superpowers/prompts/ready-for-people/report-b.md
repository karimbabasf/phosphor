# Node B report: Hyperliquid deposit and withdraw

Branch rfp/b-hyperliquid off 7e0357f (the two docs commits acd4286 and 6ff58a9 are the lead's, carried
in the worktree). Evidence under docs/superpowers/prompts/ready-for-people/evidence-b/.

## 1. Commits (oldest first)

- 2224ab7 docs: the sendAsset research for the Hyperliquid exit, with the SDK vectors and the live probe
- 26a606d The Hyperliquid exit signs a sendAsset, the one transfer a unified account accepts, and confirms only once the verifier shows the credit
- 7e4ad33 The demo Hyperliquid walk speaks the card's own path and seams every failure the harness screenshots
- d1a7cd2 One crash test per Hyperliquid stage: boot and the sweep lose nothing and sign nothing twice
- ef475f8 The HyperCore probe runs against any address without a wallet, names the exit's action and the most that can come back, and prices both directions with the fee split the card prints
- 4752918 Security review fixes on the exit: no before-read never confirms, a nonce-less ledger delta still names the send, and a short-balance sum is money
- a79a305 docs: the security review and audit of the sendAsset diff, tools clean, three Low closed
- 1f207f5 The withdraw summary names where the money lands: this app's own NEAR Intents balance, no other destination can be named
- 23a7b85 The HL arrival figure is the whole move off the card's own table, and the router's leg is named for what it is
- a8d67ca The HL card facts carry the floor in both slots, so the landing leg never prints a promise above the one the rail holds the venue to
- 71a593f docs: five lessons from node B appended

## 2. Counts (final build a8d67ca; 71a593f changes docs only)

- `npx tsc --noEmit`: exit 0.
- `npm test`: 3098 pass, 0 fail (baseline 3066; 32 new tests).
- `npm run eval`: 29 pass, 0 fail, 0 xfail, 0 error.
- `node scripts/eval.ts --live --only S12` (once, three runs of the build at 1f207f5): PPF, 2 of 3
  pass. Baseline was 0 of 3. The one miss is agent phrasing, judged "Landing named only as NEAR
  Intents, not this app's own intents balance" (evidence-b/eval-live-S12.txt). The summary now
  carries the exact phrase (1f207f5); the role text is node D's, see request 4.
- semgrep (auto plus p/secrets) over the six changed files: 0 findings. gitleaks over the branch: 0.

## 3. Criteria

- 8.1 PASS. `simulation.send.arrives` and `arrivesAtLeast` both carry the draft floor
  (draft.minReceived, draft.minCredited); the view's amountOut before settlement equals it
  (demo-withdraw-walk-4202.txt: amountOut 19.67 over a 20 USDC withdraw); checkQuote holds the live
  quote's minAmountOut to that floor in base units before signing. Tests: hypercore-withdraw.test.ts
  "the simulation carries the fee facts the card draws", hypercore-deposit.test.ts same title. Venue
  credit at or above the floor is the lead's live proof (procedure below).
- 8.2 PASS on the rail; the live figure is the lead's proof. The withdraw facts carry feeUsd =
  routing plus the 25 bp app fee (both inside the quote, read off quoteRequest.appFees) plus the
  1 USDC activation fee on top; the summary names each part as a number ("routing 0.1998 USDC",
  "app fee 0.0200 USDC, 25 bp", "activation 1 USDC on top"). Every 1Click address is fresh, so the
  fee is always priced; sendAsset re-reads userRole for the minted address at execute. Live figures
  today (hypercore-probe-2026-09-20.txt): 7 in, 6.782542 expected, total 1.217458 USDC, 17.39 percent.
- 8.3 PASS. "Deposit seen": the first status poll follows the submit with no sleep
  (hypercore-deposit.test.ts "the first status read follows the submit with no sleep in between";
  live poll interval 3 s). SUCCESS reads "Waiting for the venue to credit it" (KIND_STAGES, view.ts).
  Confirmed only after the balance rose: the withdraw rail watches the verifier (watchRise,
  INTENTS_SETTLE) and lands settling with an intents pocket otherwise (hypercore-withdraw.test.ts "a
  success the intents balance has not shown yet is settling with the intents pocket, never confirmed
  and never a loss"; "the verifier showing the floor on the third read after SUCCESS is a confirmed
  withdrawal"); the deposit rail already did (settleToPerp, tests kept).
- 8.4 PASS. One card, stages submitting, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, crediting, confirmed,
  each stamped in stageAt (demo-withdraw-walk-4202.txt, a real demo backend on 4202; demo-rail.test.ts
  "a demo withdrawal walks the same words as a deposit"). The agent's silence is node D's role text;
  nothing here prompts it.
- 8.5 PASS. A watch that runs out returns handle, nonce, ledger hash and the pocket, so the row lands
  needs_reconciliation and never failed (hypercore-withdraw.test.ts "a watch that runs out is
  unconfirmed and keeps the ledger hash"); the boot sweep keeps all three and the deadline sweep
  writes "Late, nothing has changed" (hl-crash-recovery.test.ts, 12 tests; manual run in
  demo-kill9-4202.txt: killed at On its way, booted, row kept hash, handle and nonce, read Late at the
  demo deadline with settlesForward true).
- 8.6 PASS on the docs and the fixture; live is the lead's proof. sendAsset is implemented under the
  user-signed path (HyperliquidTransaction:SendAsset, sourceDex and destinationDex "spot",
  fromSubAccount "", nonce inside the message), pinned to hyperliquid-python-sdk 0.24.0 vectors
  (hl-user-signed.test.ts "the sendAsset payload signs to the SDK vector on Mainnet" and "on Testnet").
  Research with URLs: evidence-b/sendasset-research.md. A balance short of amount plus the activation
  fee is refused before any quote with the most that can come back in the sentence
  (hypercore-withdraw.test.ts "a short balance refusal names the most that can come back";
  demo-rail.test.ts the same on the demo).
- 8.7 PASS. Below-floor deposits refused before any quote with the floor named (existing test kept);
  a quote asking for a deposit memo is refused on the dry and the live quote before the key is touched,
  floor named (hypercore-deposit.test.ts "a quote that asks for a deposit memo is refused before
  anything is signed"); the demo refuses 2 USDC the same way (demo-rail.test.ts).
- 1.10 PASS. Every HL fee is on the simulation the card draws before the click: the total as
  `send.feeUsd` (the chat card's "fee" fact), each part in the summary lines and in `send.activity`,
  the activation fee included. The demo carries the same facts.
- 2.7 PASS. The arrival figure is TYPICAL_SEC off view.ts (180 s), the router's leg named beside it;
  a late move reads "Late, nothing has changed" (demo-kill9-4202.txt).
- 4.1 PASS for the HL stages. tests/unit/hl-crash-recovery.test.ts: one test per stage (Signing,
  Sending it, Deposit seen, On its way, Waiting for the venue to credit it, Late) for hl_deposit and
  hl_withdraw; each asserts the row survives with every hash, handle and nonce, the rail is never run
  again, and confirmation waits for the venue ledger or the verifier. Plus the manual run above.
- 11 PASS. Every fix carries a test named in its commit; the rail tests were run on the parent
  (evidence-b/red-on-parent-7e0357f-rails.txt: 17 fail there, green here).

## 4. Decisions

- 8.6: sendAsset with sourceDex "spot" on every account shape. A unified account reports its whole
  balance under spotClearinghouseState (tokenToAvailableAfterMaintenance is the free figure), so
  "spot" is the side that funds it; a classic account keeps the existing perp-to-spot move first.
  destinationDex "spot": 1Click accepts either, and spot is the side the three live spotSend moves of
  2026-09-11 proved it credits. Unproven live for sendAsset: the lead's 5 USDC withdraw is the proof.
- 8.1 / 1.10: the fee facts ride on `SimulationResult.send` (the SendSimulation shape every surface
  already reads: view.ts amountOutOf and feeUsdOf, cards.js, basic.ts) rather than a new HL field on
  types.ts, which I do not own. Both `arrives` and `arrivesAtLeast` carry the FLOOR: cards.js draws
  amountOut as the landing leg and has an "at least" line for swaps only, so the expected figure there
  would read as a promise above the guarantee. The quote's expected figure stays in the summary.
- 8.3: a withdrawal whose verifier before-read failed never confirms on an after-read (no comparison);
  it lands settling without a pocket and the sweep confirms it on 1Click's terminal word later. Its
  sentence avoids "has not shown" because reconcile.ts routes that phrase to the deposit's venue read.
- 8.5: the timeout result carries the intents pocket, so a later SUCCESS from the sweep still waits
  for the verifier instead of confirming on the router's word.
- Demo seams keep the env-knob pattern of demo.ts: PHOSPHOR_DEMO_PROVIDER_END=FAILED|REFUNDED,
  PHOSPHOR_DEMO_HOLD=1, the existing PHOSPHOR_DEMO_STALL, and PHOSPHOR_DEMO_HELD_RETRY_SEC /
  PHOSPHOR_DEMO_HELD_MAX_SEC through demoHeldTiming (needs the main.ts line in request 2). The
  below-floor and short-balance refusals need no knob: the demo simulations apply the live floors.
- spotSend is deleted, not kept beside sendAsset: one write path per key. The scheme's vectors moved
  to sendAsset (the SDK reproduced the old spotSend vector first, so the venv is the real SDK).
- 8.4 stage words: the demo HL walk drops PENDING_DEPOSIT (not in KIND_STAGES.hl_deposit; the money
  starts inside the verifier). The demo test at 7e0357f already expected 'The transfer' after the
  lead's relabel and was red there; fixed in the same test file (main has the same fix in bb4b842).
- 2.7: `etaSeconds` on the facts is TYPICAL_SEC (the whole move), never the router's 20 to 35 s leg,
  so the card's live line and the facts name one figure (3.3).
- S12's rubric was not touched (frozen rule 10). Its facts hold for the product as built.

## 5. Requests for the lead

1. ui/screens/cards.js (node D), moveOf, the two HL branches: draw the floor as the "at least" line
   the way the swap branch does, so `arrives` can carry the quote's expected figure afterwards.
   Exact diff:
   ```
   } else if (kind === 'hl_deposit') {
     move.from = { symbol: d.symbol || args.symbol || 'USDC', place: 'intents', amount: num(d.amount !== undefined ? d.amount : args.amount) };
     move.to = { symbol: 'USDC', place: 'hyperliquid', amount: num(d.minCredited), floor: true };
   +  var depFloor = sim && isObject(sim.send) && num(sim.send.arrivesAtLeast) !== null ? floorText(num(sim.send.arrivesAtLeast)) : (num(d.minCredited) !== null ? floorText(num(d.minCredited)) : null);
   +  if (depFloor !== null) move.quote = 'at least ' + depFloor + ' USDC';
   } else if (kind === 'hl_withdraw') {
     move.from = { symbol: 'USDC', place: 'hyperliquid', amount: num(d.amount !== undefined ? d.amount : args.amount) };
     move.to = { symbol: 'USDC', place: 'intents', amount: num(d.minReceived), floor: true };
   +  var wdFloor = sim && isObject(sim.send) && num(sim.send.arrivesAtLeast) !== null ? floorText(num(sim.send.arrivesAtLeast)) : (num(d.minReceived) !== null ? floorText(num(d.minReceived)) : null);
   +  if (wdFloor !== null) move.quote = 'at least ' + wdFloor + ' USDC';
   ```
   Once that lands, in src/rails/hypercore-withdraw.ts priceLines set
   `arrives: oneLine(quote.amountOutFormatted, 40)`, in hypercore-deposit.ts priceLines
   `arrives: oneLine(quote.amountOutFormatted, 40)`, and in demo.ts `arrives: units(credited, 6)` /
   `units(received, 6)`; the four tests that assert arrives equals the floor flip to the quote.
2. src/main.ts, createProposalService call: `held: demoHeldTiming(cfg) ?? undefined,` with
   `import { demoHeldTiming, demoStallSweep } from './rails/demo.ts';` so the harness's B14 (hold
   expired) row can be produced in seconds (PHOSPHOR_DEMO_HOLD=1 PHOSPHOR_DEMO_HELD_RETRY_SEC=5
   PHOSPHOR_DEMO_HELD_MAX_SEC=20). Without it a held demo row retries every 30 s for 15 minutes.
3. src/proposals/reconcile.ts reconcileProposal, demo mode: the sentence "No venue handle was recorded
   for <hash>, so there is nothing this app can re-check" is written over a row that carries a handle
   when no 1Click lookup is wired (demo). Suggested: when `ctx.oneClickStatus === undefined` and the
   row has a handle, say "No venue lookup is wired in this mode, so the handle <handle> cannot be
   re-checked here." Low priority; a demo-only sentence.
4. src/role.ts (node D), for live S12 3/3: the withdraw sentence should name the two fee parts
   ("routing about 0.20 USDC plus a 25 bp app fee, and Hyperliquid's 1 USDC activation fee") and where
   it lands ("this app's own NEAR Intents balance; no other destination can be named"). Both phrases
   are now in the rail's summary and in `send.activity`, so the agent only has to repeat them.
5. No dependency added.

## 6. Follow-ups found, not fixed

- src/proposals/reconcile.ts: a pocketless needs_reconciliation withdraw whose detail carried "has
  not shown" would route to hlDepositCredited, which answers false for hl_withdraw, and stay open for
  ever. No rail writes that shape now (4752918), but reconcileByHandle could guard on kind.
- src/rails/hypercore-withdraw.ts ledgerHash: the delta type of a live sendAsset on the venue ledger
  is assumed 'send' (usdcCreditedSince already counts it); confirm on the first live withdrawal and
  add the type if it differs.
- src/rails/hypercore-withdraw.ts plan(): accountSummary(draft.from) runs before requireOwner, one
  public read for a draft the owner check refuses. Pre-existing.
- src/proposals/execute.ts judgeSettling can attribute an unrelated USDC credit to a settling row.
  Pre-existing design trade-off, both rails.
- scripts/deposit-proof.ts is the Money-in card's screenshot script (the bridge deposit screen), not a
  Hyperliquid proof; left as is. The Hyperliquid probe is scripts/hypercore-probe.ts.
- The live account today: unified, 0.000775 USDC on Hyperliquid, no USDC inside the verifier
  (hypercore-probe-2026-09-20.txt). Nothing to withdraw and nothing to deposit from until funded.

## 7. Lessons appended

The five "[B]" lines in docs/superpowers/prompts/2026-09-20-ready-for-people.lessons.md (71a593f):
PHOSPHOR_KEYS beside a state/ data dir; driving a demo backend by hand (propose body, approve route,
unlock after reboot); toAmountString on a float sum; the first poll is immediate and the demo clock
is the scale knob; 1Click's own list of accepted transfer methods and the activation fee's scope.

## The lead's live proof: deposit then withdraw, one paragraph

Prerequisites first, because the account is empty today: the verifier must hold at least 7 USDC for
0xd7b2...5050 (the deposit floor is 7 USDC in so that 5 lands after the flat fee; a 5 USDC deposit
is refused by the rail, so "5 USDC each way" means 7 in and 5 out), funded through the deposit card
(USDC, network named) or the 19.94 USDC if 1Click releases it. Then, with the app on 4177 and Karim on
Touch ID: run `node scripts/hypercore-probe.ts --amount 7` and keep the output (account unified, the
most that can come back, both dry prices). Ask the agent to put 7 USDC on Hyperliquid: under the 100
USD threshold the policy allows it, the card shows fee about 0.33 USDC (routing about 0.32 plus 25 bp)
and "at least 6.52 USDC"; expect about 6.67 credited; the card walks Deposit seen, On its way, Waiting
for the venue to credit it, and reads Confirmed only once the account's ledger shows the credit (the
app reads userNonFundingLedgerUpdates). Capture the three views at each stage: proposal_status (the
row), 1Click status by the handle plus the Hyperliquid account summary (venue), the card (user). Then
ask for 5 USDC back: it always waits for the click and Touch ID; the card shows fee about 1.21 USDC
(0.20 routing plus 25 bp inside the quote, 1 USDC activation on top), "at least 4.783 USDC"; the send
is one sendAsset (spot to spot) to the address 1Click mints, the account falls by 6 USDC, about 4.79
USDC lands inside the verifier, and the card reads Confirmed only once the verifier balance rose.
If Hyperliquid answers the sendAsset with status "err", the rail reports the venue's sentence and
nothing moved: that is the one fact this branch could not prove read-only, and it decides whether
8.6's first clause holds live. Record the 1Click hashes, the ledger hash under the nonce, the
delta type of that ledger row (expected "send"), and the balances before and after on both sides.

## B2 review fixes

Fresh builder B2 on the secure review's rejection (review-b-secure.md: one Medium, two Lows, one
Info), built on 96ef9f7 in this worktree. Evidence: evidence-b/b2-eval.log; the reviewer's scratch
tests under scripts/scratch/review-b-secure/ (gitignored) all go green, their output is quoted below.

### Commits (oldest first)

- 8915b46 The withdraw row hears the nonce before the ledger read, and a retry that cannot run is
  unconfirmed rather than a throw (M1)
- a7ee237 The withdraw row carries its intents pocket from the first word, and a withdrawal is
  confirmed by the balance rising or not at all (L1)
- b8d7d79 The HL card floor is cut from the base-unit floor the guarantee is checked against, never
  rounded from the draft's double (L2)
- b8be1e7 The classic account's move to spot is computed in base units, so the transfer never refuses
  a float tail after the quote was minted (I2)
- 1e360d7 The sweep judges a withdrawal before the venue read, so a settling sentence never routes it
  to the deposit's account check (L1, second part; closes follow-up 1 of section 6)

### The four items

- M1 (hypercore-withdraw.ts execute). `tell(hooks, { handle, nonce, quote, pocket })` fires the moment
  the first sendAsset is answered or unanswered, before the ledger read and the retry; the retry is
  in try/catch and a throw there is unconfirmed with the same nonce. Nothing throws after the
  signature. Test: hypercore-withdraw.test.ts "a send with no reply whose retry cannot read the
  account is unconfirmed with its nonce, told to the row before the ledger read, and never a throw"
  (red on 96ef9f7: `Error: hyperliquid clearinghouseState failed: 429 rate limited`). Reviewer's
  retry-throw.test.ts: `rail threw: null`, `nonce or handle reached the row before the throw: true`,
  1 pass 0 fail. hl-crash-recovery stays green.
- L1 (types.ts, execute.ts, reconcile.ts, hypercore-withdraw.ts). The pocket (intentsBefore and the
  floor) rides with the first tell and the executor persists it on the executing row, so a
  crash-recovered row is settled by the verifier rise the way a live one is; the sweep never writes
  executed on a pocketless hl_withdraw, it stays needs_reconciliation with the nonce and its own
  sentence, ahead of the deposit's venue read; and a verifier that gives no before-read refuses
  before any quote (mirror of the deposit rail's own before-read refusal), so no row this rail
  writes is without its pocket. Tests: hypercore-withdraw.test.ts "the first word to the row carries
  the intents pocket beside the nonce and the signed quote, and an unconfirmed send keeps it" and
  "a verifier that would not answer before the send refuses before any quote: nothing is minted,
  nothing is signed"; execute-evidence.test.ts "a pocket a rail hands back mid-flight is on the row
  while it is still executing, and the boot sweep keeps it"; hl-crash-recovery.test.ts "withdraw,
  killed while polling on a row with no pocket: SUCCESS alone never confirms it, and it stays
  unconfirmed with its nonce" (two rows, the second with the settling sentence). The "killed at
  Sending it" test now seeds the row the executor itself writes from the rail's first tell
  (withdrawRowAtSendingIt, a live harness plus slowRail), not a pocket typed by hand (frozen rule
  10). Reviewer's crash-no-pocket.test.ts: `after SUCCESS sweep: needs_reconciliation ok: false`,
  `verifier balance still: 0 | rail executions: 0`, 1 pass 0 fail.
- L2 (hypercore-deposit.ts, hypercore-withdraw.ts priceLines). The deposit card prints floorUsdc
  (the check's base-unit floor cut to six places) in arrives, arrivesAtLeast, activity and the
  summary; the withdraw card prints formatUnits(minReceivedBase). Tests: hypercore-deposit.test.ts
  "the card floor is cut to six places from the base-unit floor the guarantee is checked against,
  and never sits above it" (95,286-amount grid plus the 7.041874 simulation, 6.563706 where toFixed
  said 6.563707); hypercore-withdraw.test.ts "the card floor is the base-unit floor the guarantee is
  checked against, formatted from that integer" (5.124625 in: 4.854127 where toFixed said 4.854126).
  Reviewer's rounding.ts, pointed at the rail's own formatter: `deposit (card 6dp vs check 8dp): card
  above check 0, below 94142, equal 1144` (was above 47,044); `withdraw (6dp vs 6dp): card above
  check 0, below 0, equal 95286` (was below 145).
- I2 (hypercore-withdraw.ts plan). moveToSpotUsdc computes needed minus spot in six-decimal base
  units, the spot balance cut toward zero, formatted once. Tests: hypercore-withdraw.test.ts "the
  classic account move to spot is exact at six places for every amount and spot balance, never a
  float tail the transfer refuses" (the reviewer's 219,344-pair grid) and "a standard account with a
  spot balance that made the old subtraction carry a tail still moves the exact shortfall and sends"
  (red on b8d7d79 with the reviewer's own sentence, "amount 4.901002999999999 needs more than 6
  decimals"). Reviewer's movetospot.ts: `0 of 219344 combinations refused` (was 69,722).

### Counts (tip 1e360d7)

- `npm run typecheck`: exit 0.
- `npm test`: 3106 pass, 0 fail (was 3098 at 96ef9f7; 9 tests added, 1 replaced: the unmeasured
  settling test, whose path no longer exists).
- `npm run eval`: 29 pass, 0 fail, 0 xfail, 0 error (evidence-b/b2-eval.log; run because two
  refusal sentences and the floor's formatting rule changed).
- gitleaks over 96ef9f7..HEAD: 4 commits scanned, no leaks (the fifth commit holds no new strings).
  semgrep p/typescript, p/nodejs, p/secrets over the five changed source files: 0 findings.

### Files outside the named list, by line

- src/types.ts:423-429: RailHooks.onEvidence takes `pocket?: PocketRead` (one field, plus its
  comment). The hook's type lives there and nowhere else; without it the rail cannot hand the pocket
  over. The lead may prefer this as a request; it is one line to revert.
- src/proposals/execute.ts:309-311 (comment) and :319: runRail's onEvidence persists `e.pocket` when
  present. Nothing else in the executor changed; the final persist still takes the rail's own pocket
  from the result, so the REFUNDED and FAILED answers, which carry none, are as they were.
- src/proposals/reconcile.ts:265-278: the hl_withdraw branch of reconcileByHandle's SUCCESS, and
  only that.

### Decisions

- L1, 8.3 and 8.5: a verifier that will not give the before-read refuses before the quote rather
  than sending unmeasured. The brief asked that a row with no pocket never confirm on SUCCESS; a
  send made with no before-read would then be a row the app could never close on its own, which
  8.5 forbids, and the deposit rail already refuses on its own before-read, so the withdraw rail
  now does the same. SETTLING_WITHDRAW_UNMEASURED and the unmeasured branch of proveBothSides are
  gone; the sweep's no-pocket sentence covers rows written before this build.
- L2, 8.1: the withdraw card is formatted from the check's integer as well, so both rails print the
  one number the guarantee is held to. The brief asked only that the withdraw stay at 0 above; it
  was 145 below, and 8.1 asks for equality.
- 11.1: every fix carries a test red on its parent commit and green on the fix; the red runs were
  done by stashing the source and running the new test file against the parent (the 429 throw, the
  missing pocket, the missing export, the deposit sentence, the float tail).

### Follow-ups found, not fixed

- src/proposals/reconcile.ts reconcileByHandle: a sweep that hears SUCCESS never writes
  providerStage, so a crash-recovered row the sweep holds at needs_reconciliation keeps its last
  provider word (PROCESSING) and the card reads "On its way" where "Waiting for the venue to credit
  it" is the truth (3.3, 8.4). Seen in the reviewer's crash-no-pocket output (`stage: PROCESSING`
  after SUCCESS). Outside my slice of reconcile.ts; the fix is in `write()`'s evidence merge.
- src/proposals/execute.ts judgeSettling: with the pocket on the row from "Sending it", a
  crash-recovered withdrawal is judged by the intents balance from boot, so an unrelated USDC credit
  inside the window can settle it, or call it a short fill. Same trade-off section 6 already
  records for settling rows; the window is now the whole move rather than the crediting leg.
- scripts/scratch/review-b-secure/rounding.ts and movetospot.ts were edited (gitignored) to call
  floorUsdc and moveToSpotUsdc; the numbers above come from those edited copies.
