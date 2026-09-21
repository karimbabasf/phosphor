# Node F: the anxiety harness. Report (written by the lead)

Node F built the harness (commits 1921f10 and 848639d, merged at ac4f0e0) and died at the
session limit before its baseline run finished, so the lead ran the harness on the merged main
and wrote this report from the runs.

## 1. What the harness is

`scripts/anxiety-eval.ts` plus `scripts/anxiety/*` (agent, app, capture, flows, judge, rows,
scenes, table), unit tests in `tests/unit/anxiety-eval.test.ts` (17), README section
"Anxiety score". Leg a: a demo backend per scene on a free port with a scratch HOME, the
scripted agent at `$HOME/.local/bin/claude`, every situation produced and shot at 860 px (card
rows once more at 400 px), three runs, three votes per shot, the rubric copied verbatim from the
definitions file (a unit test holds the copy byte for byte), the persona verbatim. Leg b: Jev
through `jev-browse` on the four flow rows. Runs land under `scripts/scratch/anxiety/<name>/`.

Two lead fixes after the merge: the scratch bin goes first on the backend's PATH (node C's
catalog walks PATH before `$HOME/.local/bin`, so every chat walk had spawned the real Claude
Code and proposed nothing), and the vault's Change button is read by `textContent` (innerText is
empty in a tab that is not laid out).

## 2. Judge

Probe order as briefed: NEAR AI Cloud (`anthropic/claude-sonnet-5` at TEXT_MODEL_BASE_URL did
not answer the image probe with valid JSON), then OpenRouter `anthropic/claude-sonnet-5`, which
ran. The third run lost the judge halfway: OpenRouter answered HTTP 402 (credits exhausted), so
31 rows have no valid vote in that run and `claude -p` was not reached (the probe happens once
at the start). Leg b failed the same way: Jev's provider returned HTTP 402 on C09, and C15 was
blocked; C10 and D05 were skipped by the harness's own detection (the picker detection reads
innerText, fixed after the run).

## 3. The table (run 2, the last complete judged run, main at 597fe3b before the calm-refusal fix)

98 rows: 39 pass, 46 fail, 13 not reachable in demo. 80 rows judged; max median 9, mean 3.99.
Full table: `evidence-f/summary-run2-before-calm-refusal.md`. By group: A (cards) 25 pass 19
fail; B (failures) 4 pass 22 fail; C (onboarding) 6 pass 9 fail; D (vault) 3 pass 5 fail;
E (ending) 0 pass 3 fail; F (session start) 1 pass 1 fail.

Worst three: B17 provider REFUNDED (median 9), B16 provider FAILED (median 9), E03 the ending
notice after a failure (median 7). Screenshots: `evidence-f/worst-*.png`.

Not reachable in demo (13): the Touch ID and signing ticks (a software-wallet demo signs in one
step), the trade transients, an active preflight hold, the unified-account refusal, and the
picker rows the detection missed.

## 4. What the judge's reasons cluster on (2-point parts across failing rows)

- Jargon (228 votes): "USDC, wNEAR, NEAR Intents, Hyperliquid" counted as unglossed crypto
  terms on every card that names a coin or a pocket. The rubric as written scores the product's
  own vocabulary. Glossing the pockets on the card ("in your balance", "to your trading
  account") is a product decision for Karim; the coin names stay.
- Density (90): the decision dock mirrors the transcript card, so every ask and stage row shows
  two cards; the judge counts both. Collapsing the transcript's card while the dock holds the
  same proposal is a UX change for a later pass.
- Alarm (50): a red Refused or Failed chip beside a red reason line, and on refusals the
  schema's own words as the reason. Fixed on main after the run (e6341c2, a343ae1): the reason
  line is body text, the invalid-patch refusal is written in the policy's words, the
  unconfirmed card says Check again with the handle shortened, the demo sweep sentence is plain.
- Money certainty (57): setup screens with no amounts score 2 by the rubric's letter (terms,
  words, addresses, done). A rubric matter, not a product one; left as it is (frozen rule 10).
- Next step (23): the reply said "answer Yes or No" while a send card's button says Approve;
  the FAILED and REFUNDED copy said "try again" while the card said do not send it again. Both
  fixed (e6341c2).

## 5. Run 3 (after the copy fix, before the credits ran out): 33 rows judged

Flipped to pass: A04, A13, A30, B10, B18, E01. Flipped to fail: B22 (4 to 5). Unchanged: the
rest. B16 and B17 stayed at 9 and 7: the unconfirmed dock card and the sweep sentence, fixed in
a343ae1 after that run. Table: `evidence-f/summary-run3-partial-402.md`.

## 6. What is left

A full judged run on the final main needs judge credits (OpenRouter) or `--judge claude-p`.
Leg b needs Jev's provider credits. The harness itself is ready: `node scripts/anxiety-eval.ts`.
