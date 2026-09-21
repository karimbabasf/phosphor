# Node A report: the relay swap rail

Branch rfp/a-relay, worktree /Users/karimbaba/Developer/Apps/phosphor-rfp-a-relay, based on main bb4b842.
Evidence under docs/superpowers/prompts/ready-for-people/evidence-a/.

## 1. Commits

- d5f76c0 The intents signer moves to src/intents-sign.ts so two swap rails can share it without importing each other
- 17cdcbf The solver relay client, the verifier reads and the token_diff payload, all pure, with the nonce the contract reads today
- 9dd863e swap.rail is a config switch, relay by default, with the 1Click rail one line away
- e764841 The relay swap rail: one atomic token_diff, signed once, published once, settled by the balance
- 1b59484 A relay swap is reconciled by the relay's word and the verifier's nonce, one test per stage a crash can land on
- 85a1e62 The demo swap walks the relay's words, and the history reads a relay row's intent hash first
- 12f2ab6 scripts/relay-probe.ts reads the relay and the verifier for the live proof and can sign nothing
- 225c38d The relay's SETTLED is checked against the chain before a row is called executed, and a nonce is never called dead past its own life
- 2e8c194 A hash off the relay is base58 or no hash, and a verifier read after the signature can never throw
- c0232de docs: node A report, evidence and two lessons for the relay swap rail
- f2a5907 Merge main into rfp/a-relay
- (next) The relay signs figures cut toward zero, an unspent nonce is no verdict once its salt is retired, and a hold names every answer it passed over (the secure review's two Lows and one Info)

## 2. Counts

- `npm run typecheck`: exit 0 (evidence-a/npm-test.txt, first line).
- `npm test`: 3147 tests, 3147 pass, 0 fail (evidence-a/npm-test.txt). One earlier full run saw tests/unit/preflight.test.ts:385 (the Arbitrum sampler, real timers) fail once under machine load and pass 3 of 3 alone; not a file this node touches. Baseline on main bb4b842: 3068 tests, 3068 pass. The branch adds 79 tests: relay-payload 22, relay-client 8, intents-relay 25, reconcile-relay 17, relay-demo 3, rail-wiring 4.
- `npm run eval`: 29 scenarios, 29 pass, 0 fail (evidence-a/eval-scripted.log). Run because the demo swap walk changed, which is what the eval's agent reads. `npm run eval:live` not run: it costs tokens and the lead runs it at merge.

## 3. Criteria

- 1.8 PASS. Every amount at the signature is a bigint in base units: amountIn to the unit, amountOut equal to the chosen quote and at or above the floor, checked on the string that is signed (checkTokenDiffPayload, one test per row of the spec's table in tests/unit/relay-payload.test.ts; tests/unit/intents-relay.test.ts "the string signed is the string sent"). The venue-signature half of 1.8 is 1Click's; the relay signs nothing, and the spec's binding is the diff itself.
- 1.9 PASS. amount_in to the unit (relay-payload "refuses a negative side that is another asset or another amount", intents-relay "picks the largest amount_out"); expiration at least 15 s ahead (pickQuote, "ignores one expiring inside 15 s"); deadline at most 120 s ("the deadline is at most 120 s out and never past the quote expiration"); minAmountOut off the draft, zero refused ("the counterparty is the verifier ... or the draft is refused"); asset ids pinned at plan time and compared before signing (payload rows "does not spend", "does not deliver"); unknown relay status never terminal ("an unknown status word is never terminal"). `node --test tests/unit/intents-relay.test.ts tests/unit/relay-payload.test.ts`.
- 2.2 PASS by construction, measured by the lead: simulate is one relay quote (the relay answers inside 3 s; 2.7 s and 3.6 s in evidence-a/relay-probe.txt) plus the cached token list; execute returns the executing row at the reservation as before (src/proposals/execute.ts unchanged there). A swap valued off a quote still waits for a click (144ebbd untouched).
- 4.1 PASS. One test per stage a crash can land on: signed not published (nonce unspent inside deadline, past deadline, spent, verifier silent), published PENDING (relay PENDING, SETTLED with hash, NOT_FOUND, relay unreachable), TX_BROADCASTED (hash and link survive the sweep), SETTLED before the balance read (spent nonce settles, unspent stays), settling with a pocket (balance first). Nothing is signed twice: the reconcile path holds no signer. `node --test tests/unit/reconcile-relay.test.ts` (16 tests).
- 4.2 PASS. A terminal relay row carries the intent hash and, once the relay reports it, the NEAR tx with its nearblocks link (intents-relay "SETTLED with a balance rise equal to the diff is ok, with the NEAR hash, its explorer link"; reconcile-relay "SETTLED with the NEAR hash settles the row with the link"; relay-demo checks the history reads the two hashes). The intent hash itself carries no link: no explorer resolves a relay intent hash (src/transactions.ts).
- 4.3 PASS. `swap.rail` in config.json, relay by default, oneclick one line away; both rails built, the draft's venue picks; proposeSwap stamps the venue. tests/unit/rail-wiring.test.ts, four tests ("the config switch selects the swap rail", "both swap rails are constructed", "proposeSwap stamps the venue", "the config file accepts swap.rail"). The 1Click rail stays in the tree untouched except for the signer re-exports.
- 4.7 DELIVERED, the proof is the lead's: scripts/relay-probe.ts and the procedure below. Run 2026-09-20 read-only: evidence-a/relay-probe.txt.
- 11.1 PASS. Every fix commit names its test and the test was red on the parent: 225c38d (reconcile-relay, intents-relay), 2e8c194 (relay-client, intents-relay). The feature commits carry their tests beside them.
- 11.2 n/a: no symptom needed a second fix.
- 11.3 PASS. No stage word, label or sentence was added anywhere but the rail's own detail strings; the stage vocabulary is view.ts's, untouched (intents-relay "the swap path in the stage contract is the relay words this rail stamps").
- 11.4 n/a: no ui/ edit.
- 11.5 not run here: the bundled app is the lead's proof run.
- Frozen rules: 1 (the click path untouched; refusals and holds sign nothing), 2 (floor off the draft, never zero, truncated when printed; the diff signed IS the price), 4 (no key material in any string; evidence-a/security-audit.md), 5 (no second stage table), 9 (Hyperliquid untouched; no app fee on the relay; the rail adds no fee), 10 (no test-only branch, no eval edit).
- Security: /security-review over the branch diff (one fresh-context reviewer) and the security-audit skill over src/relay/*, src/rails/intents-relay.ts and src/intents-sign.ts: 0 Critical, 0 High, 0 Medium, 3 Low, all fixed in 225c38d; two hardening changes in 2e8c194. semgrep 0, trufflehog 0, gitleaks 1 false positive (an env var name). evidence-a/security-audit.md. The lead's secure reviewer then ACCEPTED with two Lows and one Info, closed in the last commit: (1) frozen rule 2, the figures the relay signs are cut toward zero through truncateToBaseUnits (src/intents.ts), tests "truncateToBaseUnits cuts toward zero" and "the amount signed and the floor held are cut toward zero"; (2) an unspent nonce past its deadline is called dead only when the verifier still accepts the nonce's salt (is_valid_salt, answered live), since a spent nonce with a retired salt is pruned too, test "a nonce whose salt the verifier has retired gets no verdict"; (3) a hold carries every answer the relay gave and why it was passed over, test "a hold names why every answer the relay gave was passed over".

## The live proof procedure (one paragraph, for the lead)

Quit the installed app on 4177. In the main checkout with the real config, run `node scripts/relay-probe.ts --from USDC --to USDT --amount 2` and read four lines: SALT ok, BALANCE at least 2 USDC held, QUOTE with a best price and a quote hash, "Nothing was signed". On 2026-09-20 USDC to USDT quoted in under three seconds and USDC to NEAR returned no solver at all on the public relay (evidence-a/relay-probe.txt), so prove on USDC to USDT unless `--to NEAR` quotes on the day (the spec's own proof pair is USDC to USDT). With `swap.rail` absent or `relay` in config, bundle, boot, and ask the agent for the 2 USDC swap; the card walks Waiting for you (a swap valued off a quote clicks whatever its size), Touch ID, Signing, Sending it, Finding a match (PENDING), Settling on NEAR (TX_BROADCASTED), Settled checking your balance (SETTLED), Confirmed; one card, redrawn in place. Then read the row with `proposals`: `txids[0]` is the intent hash, `txids[1]` the NEAR tx, `evidence.explorerUrl` the nearblocks link, `evidence.nonce` and `evidence.deadline` the signed facts, `evidence.relayQuote.quoteHash` the quote it answered, `evidence.settledAmountOut` the measured credit, and the detail sentence says "matching the signed diff ... to the unit". Check the verifier by hand: `node scripts/relay-probe.ts --status <intent hash>` reads SETTLED with the same NEAR tx, `node scripts/relay-probe.ts --nonce <nonce>` reads "spent: yes", and the wallet read shows USDC down by exactly 2 and USDT up by exactly `relayQuote.amountOut` base units (the contract applies the signed deltas in full; the protocol fee is taken on the input side at the supply level). For the kill test, `kill -9` the backend between Sending it and Confirmed, boot again, and read the same row: needs_reconciliation with the nonce and hash kept, and inside ten minutes the sweep writes executed off the verifier's nonce.

## 4. Decisions

- 1.9 The nonce is the verifier's versioned V1 shape (magic || 0 || salt || deadline ns || 15 random bytes), not the spec's 32 random bytes: the contract's README calls the random shape legacy and announces its end, every vendor example is V1, and `current_salt` answered live. Built to the README's worked example byte for byte (relay-payload test). Cost: one `current_salt` read before each signature; a failed read refuses, nothing signed.
- 4.1 The nonce's own life is the intent deadline plus seven days (NONCE_LIFE_AFTER_DEADLINE_MS), the sweep's own window, so `is_nonce_used` stays an answer for every row the sweep can still ask about; past it no verdict is written.
- 4.1 The relay's SETTLED never settles a row by itself: a measured balance rise or the verifier showing the nonce spent does (review finding, 225c38d).
- 4.1 A publish the relay answers FAILED lands with providerStage NOT_FOUND_OR_NOT_VALID (the swap kind's own ending word in the stage contract, and the relay's own word for an intent it did not take) and the reason in the sentence; the nonce stays on the row from the pre-publish hook, so the executor lands it unconfirmed underneath and the sweep proves it dead once the deadline passes. The alternative, a `failed` row on the relay's word alone, needed an executor rule change in a file I do not own.
- 1.9 A quote under the floor holds at execute with "best price is X, your floor is Y" and refuses at simulate; no price at all holds with "no solver offered a price"; the existing hold loop (30 s retries, 15 minutes) is used unchanged. The spec's "five minutes" is the loop's older number; I did not change the executor.
- 1.9 Timeouts follow src/net.ts, not the spec's flat 10 s: quote and status are reads (10 s), publish is a venue write (30 s) because the relay simulates the intent against the verifier before answering and a deadline that fires mid-simulation leaves an intent that may be live.
- 4.3 `swapRailOf` lives in src/config.ts beside the schema entry as the one reader of the switch; the registry and proposeSwap both call it.
- 4.3 The relay lookup for reconciliation (`status`, `nonceUsed`) hangs off the RailRegistry (`registry.relay`), built in src/rails/index.ts, rather than off the proposal service like `oneClickStatus`: it kept every edit inside files I own (lifecycle.ts, proposals.ts and main.ts would each have needed a line). Demo mode and a bare test registry carry none, and a relay row there is judged by its balance alone.
- 1.8 The input balance read refuses only where certain: a balance the verifier reports short refuses before signing; a read that did not answer lets the contract answer (its simulation fails with nothing executed). The output balance and the salt are read in the same breath; a missing salt refuses.
- 1.9 The fee on the card is the draft's USD less the quote's output priced off the 1Click token list, clamped at zero; `priceGoodForSec` is the quote's real remaining seconds; `etaSeconds` is null (the relay gives no estimate; the card's typical 45 s stands).
- 1.9 The settle tolerance is one pip cut toward zero, per the spec; the contract source shows our credit lands in full, so it should never fire (evidence-a/security-audit.md).
- 11 Three additive fields in src/types.ts (AppConfig.swap, RailEvidence.relayQuote, SwapSimulation.priceGoodForSec) and one line in src/proposals/execute.ts pickEvidence: the config switch and the spec's evidence field cannot exist without them. Listed under requests so the lead can veto.
- 11 The two swap rails share the signer through src/intents-sign.ts; the 1Click rail re-exports the old names so no importer or test moved.
- 1.9 Base units: the relay converts through a new truncateToBaseUnits beside the shared toBaseUnits (src/intents.ts) rather than changing the shared helper's rounding: the other rails keep the behaviour their tests pin (node B's files untouched), and the two only differ past the asset's own precision. The lead may fold the other rails onto the truncating one later.
- 4.1 The salt check (RelayLookup.saltValid, VerifierPort.isValidSalt) is optional the safe way round: absent reads as no answer and no failed verdict is written; the live registry always carries it. Optional so the lead's reviewer scratch fixtures and any registry a test builds by hand keep compiling.
- 11 The branch was fast-forwarded to main bb4b842 before the first commit, so the demo-rail test the lead fixed there is green under it.

## 5. Requests for the lead

- src/types.ts (additive, already in 9dd863e, veto if wanted): `swap?: { rail: SwapRail }` on AppConfig plus `export type SwapRail = 'relay' | 'oneclick'`; `relayQuote?: { quoteHash: string; amountIn: string; amountOut: string; expiration: string }` on RailEvidence; `priceGoodForSec?: number | null` on SwapSimulation.
- src/proposals/execute.ts pickEvidence (already in e764841): `if (e.relayQuote !== undefined) out.relayQuote = e.relayQuote;` so the pre-publish hook's quote hash survives onto the row.
- ui/screens/decision.js:63 (node D or E): `var VENUE_WORDS = { 'intents-native': null, 'intents-relay': null, 'oneclick': '1Click, on NEAR Intents', 'uniswap-v3': 'Uniswap v3' };` so the fold does not print "Through intents relay" under a headline that already says inside NEAR Intents.
- ui/screens/receipt.js:47: add `'intents-relay': 'NEAR Intents',` to VENUE_NAMES, else the receipt prints "Intents-relay".
- ui/screens/decision.js:488 and ui/screens/cards.js:733 (node D): draw `simulation.swap.priceGoodForSec` when it is a number as one line, "Price good for about a minute, re-quoted at your click"; the field carries the quote's real seconds. Null means the price is held to the click (1Click).
- src/proposals/execute.ts judgeSettling (the "short fill" branch): a relay row (draft.venue 'intents-relay') should never take the short-fill `failed` verdict; the diff is atomic, so a rise below the floor is another credit in the window. Route it to stay, or to reconcileRelaySwap's nonce check. Exact diff on request; not made because it is outside my region.
- No dependencies added.

## 6. Follow-ups found, not fixed

- src/relay/verifier.ts carries a copy of the private `view()` helper in src/ledger/intents.ts; export the ledger's and drop mine.
- src/rails/intents-native.ts still carries its own base58Encode and base58Decode beside src/chain/near.ts's (pre-existing; the signer now uses the chain one).
- src/rails/intents-relay.ts resolveAsset takes the asset id from the 1Click token list matched by contract address; a hostile list could rename the bought asset under the approved symbol. Inherited from the 1Click rail (evidence-a/security-audit.md).
- The public relay quotes no solver for USDC to wNEAR or wNEAR to USDC on 2026-09-20 (2, 10 and 50 USDC tried; USDC to USDT, ETH and arb USDC quote), while 1Click quotes the pair. Either the wNEAR solvers sit behind the partner key or they are 1Click-only; the lead's "2 USDC to NEAR" proof may need USDC to USDT instead, or a partner key (spec, Not in scope).
- A FAILED publish sits as needs_reconciliation (charged against the day) until the sweep proves it dead; at most fifteen minutes, while the card already reads Failed.

## 7. Lessons appended

- The nonce the verifier reads today is versioned (magic, salt, expiry, 15 random bytes) and the spec's 32 random bytes are the legacy shape announced as ending: check the vendor's contract README for the nonce layout before building any intent, and read `current_salt` before signing.
- The public solver relay quotes a narrower asset set than 1Click (no wNEAR on 2026-09-20): probe the pair read-only before a live proof, never assume a 1Click pair is a relay pair.
