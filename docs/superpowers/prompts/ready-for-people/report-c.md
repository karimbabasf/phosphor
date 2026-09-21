# Node C report: the agent picker and the connection

Branch rfp/c-agent, worktree /Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent, off 6ff58a9. Evidence under
docs/superpowers/prompts/ready-for-people/evidence-c/.

## 1. Commits

- 7fcdf7b The agent catalog: six entries, a four-state check per agent by a version call and an offline login probe inside three seconds, one sentence per state, the connection line and the registration built per agent, and the driver finds claude through the same places the check does. Test: tests/unit/agents-catalog.test.ts over tests/fixtures/fake-<agent>-<state>.sh
- 63b50f4 The backend is the only builder of the connection line: per agent, with the port and data directory in every mode, read by the window through the driver door and by the menu item through GET /api/connection, and the picker's scan, check and pick sit on the same token-checked door. Test: tests/unit/connection-route.test.ts
- 408006f The policy file gains a checked writer for a value typed at the window, and the onboarding threshold route lands it in policy.json or refuses it with the figures. Test: tests/unit/policy-threshold-route.test.ts
- a9e7bc4 The first run's connect step is the agent picker (six tiles, one sentence, Details, Start it only for the agent the app can lock down, the threshold lands in policy.json); the Vault tab's Agent panel shows the picked agent, its state, Change and Check again, and names an agent that has gone. Tests: tests/unit/firstrun-ui.test.ts, tests/unit/vault-agent-ui.test.ts
- 1f2f29a A probe runs with its stdin closed; Hermes is registered by removing the old entry and answering its Enable-all-tools question down stdin. Test: tests/unit/agents-catalog.test.ts over tests/fixtures/fake-agent-asks.sh
- 7d03ad8 The picker's fill says picked and keyboard focus is the ring alone, an empty sentence draws no light, two columns under 420 px, the panel's rules fact is called the threshold
- 7d37427 Node C report, evidence and four lessons; 291fc9a and 52ac8ad merges of main; a9771b1 counts line
- (review round, the last commit on the branch, git log -1) the security reviewer's four items: the
  menu item's line is refused unless the answer carries this boot's nonce and is one printable line
  (cargo tests), the user-scope sentence with the daily auto ceiling behind Details and in the doc, the
  done screen reads its two sentences off the pick and the money step, registration evidence re-captured

## 2. Counts

- `npm run typecheck`: exit 0 (state/typecheck.log).
- `npm test`: 3125 tests, 3125 pass, 0 fail, on the tree with main eb28109 merged in (merge commit
  52ac8ad) plus the review round. Main alone is 3068; this branch adds 57 (agents-catalog 22,
  connection-route 8, policy-threshold-route 4, firstrun-ui 14, vault-agent-ui 9). Before the merge the tree showed one
  failure, `tests/unit/demo-rail.test.ts` "the stall knob stops the walk at PROCESSING", which failed the
  same way on the branch base 6ff58a9 with none of my commits and which main's bb4b842 fixed.
- `npm run eval`: not run. Nothing the agent reads or says changed: src/persona.ts, src/role.ts, skills/,
  operator/, the tool descriptions in src/mcp.ts and every view.ts consumer are untouched
  (`git diff 6ff58a9 --stat` names none of them).
- `cargo check` in src-tauri: clean, 0 warnings, after `npm run bundle` staged the payload;
  `cargo test --bin phosphor-desktop`: 23 passed, 0 failed (two new).
- Regression tests red on the parent (11.1): the four new test files copied onto a worktree at 6ff58a9
  fail there (policy-threshold-route 0/1, firstrun-ui 0/1, connection-route 0/1, vault-agent-ui 0/9) and
  pass here (4, 13, 7, 9).

## 3. Criteria

- 10.1 PASS. Six entries in the catalog's order (Claude Code, Codex, Hermes, Grok, Another agent, Claude
  Desktop or a chat app), one screen, tiles in the network picker's grammar: `node --test
  tests/unit/agents-catalog.test.ts` ("the catalog holds the six entries"), `tests/unit/firstrun-ui.test.ts`
  ("six tiles in the catalog's order"); evidence-c/shots-1280/picker-1-open.png.
- 10.2 PASS. `checkAgent` answers one of the four states by `--version` plus an offline login probe, each
  capped at 2.5 s and run side by side; a hung binary still answers inside 3 s: agents-catalog.test.ts
  ("a binary that never answers still gets a state inside three seconds", "the scan checks every agent
  ... inside three seconds"). Live on this Mac with the real vendor homes: 251 ms for all four
  (evidence-c/scan-and-lines.md). No vendor network call: the probes are `claude auth status`, `codex
  login status`, `hermes config get model`, and for grok the file ~/.grok/auth.json, which is parsed
  for its key count only: no value in it is kept, printed or sent, and nothing leaves the Mac.
- 10.3 PASS. One sentence per state from `stateSentence`, the definitions file's three sentences word for
  word, the path and version only in `details` (behind Details on both screens):
  agents-catalog.test.ts ("the sentence for every state ... names no path"), firstrun-ui.test.ts ("the
  path waits behind Details"); shots-1280/picker-3-codex.png against picker-3b-codex-details.png.
- 10.4 PASS. Registration written by the app through each vendor's own `mcp add` (claude, codex, hermes,
  grok), the one line to paste for another agent, built once in src/agents-catalog.ts and read by the
  window (POST /api/driver connection) and the menu item (GET /api/connection, src-tauri/src/main.rs
  mcp_command) alike, with PHOSPHOR_PORT and PHOSPHOR_DATA_DIR in every mode and the bundled node when
  packaged: connection-route.test.ts (per-agent lines, GET equals POST, packaged branch),
  agents-catalog.test.ts (argv per vendor, remove-then-add). Live: the four real binaries registered into
  empty isolated homes from the running backend, and every vendor file carries both keys
  (evidence-c/registration-live.md, re-captured after the review). The menu item copies the line only
  from an answer that carries this boot's nonce (identity_matches) and only when it is one printable
  line: `cargo test --bin phosphor-desktop` 23 passed, two of them new (the_copied_line_comes_only_from_this_boots_backend,
  a_command_that_is_not_one_printable_line_is_never_copied). The registration is user or global scope
  on purpose, said in one sentence behind Details for the four agents with the daily auto ceiling as
  the cap (connection-route.test.ts "an agent the app registers is told, behind Details") and in
  docs/connect-an-agent.md.
- 10.5 PASS. In-app start only for Claude Code (`inApp: true` for one entry, asserted); the others get
  "is signed in: start it in your terminal and it will appear here", and the light plus the sentence
  "X is connected." follow the roster's client name: firstrun-ui.test.ts ("the light turns on when a
  client of the picked agent is on the door"), vault-agent-ui.test.ts ("the light follows the roster").
- 10.6 PASS. The Vault Agent panel shows the picked agent (chip), its state from the same
  `agent-check`, Change (the same picker, drawn in the panel) and Check again; a pick while an agent the
  app started is running is refused by the backend with "Your assistant is running. Turn it off in the
  chat, then change it here." and nothing is written: connection-route.test.ts ("a pick is refused ...
  while an agent this app started is running"), vault-agent-ui.test.ts ("Change draws the same six
  tiles", "a switch the app refuses"); shots-1280/vault-1-panel.png to vault-4-after-change.png.
- 10.7 PASS. One sentence node per screen, the fold behind Details, no toast on either screen, no
  `net.readable` in the picker or the panel (source assertions in both ui tests, "prints nothing the
  network said"); a dead app reads "Phosphor could not check right now. Try again." / "... Press Check
  again."
- 10.8 PASS. A picked agent that is gone reads "Codex is no longer on this Mac." (stateSentence with
  wasPicked), the light is off, nothing throws, no boot dependency (readPick returns null on a bad file):
  agents-catalog.test.ts ("the picked one that vanished says so"), vault-agent-ui.test.ts ("an agent
  that has since gone").
- Known failure 6 PASS. The threshold step posts `/api/policy/threshold` with the window token; the route
  loads through loadPolicy, refuses through the engine's ceiling and the never-asks rule, merges through
  mergePatch, re-renders the sentences and writes through the new `savePolicyChecked` (schema first):
  policy-threshold-route.test.ts (lands, string figure lands, 8 bad values refused with the file
  untouched, unreadable file refuses, no token 403); live: policy.json read 25 after the walk
  (evidence-c/shots-1280/shots.log "policy after threshold: 25").
- 1.11 PASS. No new in-app agent: only Claude Code starts in-app, under operator/driver.settings.json
  as before; the catalog's `inApp` flag is the one place that says so. No new lockdown file needed.
- 9.1 PASS. Enclave flow still welcome plus 3, software flow welcome plus 9: the existing
  firstrun-welcome-ui and vault-lock-ui step-count tests pass unchanged except for the step's title
  ("Connect your assistant" became "Your assistant" in three assertions).
- 9.2 PASS. One primary per state (quiet Continue before a pick, Start it, Check again, Continue), "Do
  this later" as the one secondary, a failed action shows one sentence and the same button:
  firstrun-ui.test.ts ("a start that fails is one sentence over the same Start it"). The done screen
  reads its sentences off what the steps saw: a connection only when the agent is on the door or the
  app started it, "Start Codex in your terminal", "Install Claude Code or Codex, then pick it in the
  Vault tab" for a chat app, and "Add money any time from the Basic tab" when nothing landed
  (firstrun-ui.test.ts "the done screen says what the assistant step actually found").
- 9.3 PASS. Nothing slower than today: a pick is one round trip (18 ms for Claude Desktop, 119 to 750 ms
  for an installed agent including the vendor's `mcp add`, 3.3 s for Hermes because its add connects to
  the proxy first); the check on the vault opens in 251 ms with real homes.
- 9.4 PASS. src/terms.ts untouched; the terms card still comes first (evidence-c/shots-1280/terms.png,
  taken before the first run opened).
- 3.5 PASS on my two screens: every failure is one app-authored sentence with the next step (install,
  sign in then Check again, turn it off in the chat, try again), never a trace or JSON; the two ui tests
  assert no raw text reaches the screen.
- 11 PASS. One regression test per fix, named in each commit, red on 6ff58a9 (section 2).

## 4. Decisions

- 10.1 Tile labels are "Grok" (not "Grok bot") and "Another agent" (not "another MCP agent"): the
  shipped binary is `grok` and MCP is vendor jargon on the visible face; Details says "Any agent that
  connects to MCP servers".
- 10.2 Grok's login probe is the presence of a non-empty JSON object at <GROK_HOME or ~/.grok>/auth.json:
  grok 1.0.34 has `login` and `logout` and no offline status command (`grok models` asks the API). Its
  README names that file as where `grok login` stores credentials. No value is read.
- 10.2 Hermes counts as signed in when `hermes config get model` prints a provider and a default model:
  Hermes has no single login, and `hermes auth status <provider>` said "logged out" for a provider whose
  key was set through the environment. `hermes model` is its sign-in line.
- 10.4 Registration is user or global scope for all four agents (Claude Code `--scope user`, grok
  `--scope user`, Codex and Hermes have one global file), decided with the lead at review: a person
  who is not a developer connects once and expects the agent to drive Phosphor from any terminal. No
  local-scope option. The sentence behind Details and in the doc says so, with the daily auto ceiling
  named as the cap on what runs without a click.
- 10.4 The connection line carries PHOSPHOR_PORT and PHOSPHOR_DATA_DIR in dev too, not only packaged:
  a checkout on any port other than 4177 was handing out a line whose proxy talked to 4177.
- 10.4 Hermes: the old entry is removed and the "Enable all N tools? [Y/n/select]" question is
  answered with Y down stdin; measured on 0.21.3, end of file cancels the add.
- 10.6 A pick while an in-app agent is running is refused by the backend (200, ok:false, one
  sentence), never stops or restarts it; picking the already picked agent is not a switch and passes.
- 10.6 Registration runs on pick only (not on Check again), for an installed agent only.
- 10.8 The pick lives in <dataDir>/agent.json; a missing or broken file is "no pick", never an error.
- 9.2 Before a pick the primary is a quiet Continue with "Do this later", so the step has no dead end
  for a person with no agent yet.
- 6 Threshold: only humanClickAboveUsd moves; autoApproveDailyUsd is left as the policy has it
  (an independent wall), the ceiling is the engine's AXIS_CEILING_USD and the never-asks rule is
  checked against the cap in force.
- Menu item (review item 1): mcp_command takes this boot's nonce and refuses any answer whose identity
  header does not carry it, before the body is read, and refuses a command that is empty, over 4096
  bytes or holds a control character; the call site at the menu handler passes the nonce from Secrets
  (one line outside my 139-152 range, asked for by the reviewer).
- Done screen (review item 3): the picker reports its state (agent, check, on the door, started) to the
  step, which keeps it in `draft.agent`; the money step keeps `draft.moneyIn`; both halves of the done
  sentence read from those.
- The stylesheet is linked from ui/index.html (one added line, node E's file): injecting the link from
  firstrun.js was refused by tests/unit/ui-links.test.ts, which allows href writes in links.js only.
  Also src/http/router.ts (unowned) gained the two route table lines. Both diffs are in section 5.

## 5. Requests for the lead

- ui/index.html (node E), already applied on this branch, keep or reapply after E's merge:
  `+<link rel="stylesheet" href="./design/agentpick.css">` after the deposit.css line.
- src/http/router.ts (unowned), already applied on this branch: the import of handleConnectionRead and the
  two table entries `'/api/connection'` (GET) and `'/api/policy/threshold'` (POST), see `git show 63b50f4 -- src/http/router.ts`.
- docs/security-model.md (node G): add `POST /api/policy/threshold` to the token-checked human writes and
  `GET /api/connection` to the reads that answer on loopback without a token (nothing secret: a path on
  this disk, the port, the data directory).
- src-tauri/src/main.rs outside my lines (node G): the Copy MCP Config dialog text at the menu handler
  still says "The `claude mcp add-json` line for this installation is on the clipboard. Run it in the
  directory you want the agent to work from." The line is now the picked agent's own `mcp add`, user
  scoped. Suggested: "The connection line for your assistant is on the clipboard. Paste it into a terminal."
- No dependencies added.

## 6. Follow-ups found, not fixed

- tests/unit/demo-rail.test.ts "the stall knob stops the walk at PROCESSING" failed on 6ff58a9 without my
  commits; fixed on main at bb4b842, green here after the merge.
- ui/screens/firstrun.js: on the software flow, "I already have one" goes password, then `go(5)`
  (addresses), so the "Bring your wallet in" screen (screenImport, drawn at the prove step) is never
  reached and walletImport is never posted. Pre-existing, no criterion of mine names it; the screenshot
  walk used the create path instead.
- The `.chip` head elements in vault.js carry the existing `.dot`; Karim's taste memo names status pills
  with a dot as slop, but the Custody and Recovery chips already use them, so the Agent chip matches
  rather than differs (node E's call).
- Hermes with an empty HERMES_HOME takes the whole 2.5 s cap on `--version` (a first-run setup); with the
  real home it answers in 120 ms. Bounded, not fixed.

## 7. Lessons appended

- `hermes mcp add` (0.21.3) stops at "Enable all N tools? [Y/n/select]" and answers end of file with
  Cancelled; a second add asks "overwrite?" first. Remove, then add with `Y\n` on stdin.
- A probe child must get stdin `ignore`, not a pipe: an agent CLI with an empty config home stops to
  ask a first-run question and sits on the pipe until the cap kills it.
- tests/unit/ui-links.test.ts refuses any href write in ui/ outside core/links.js; a new stylesheet
  goes in index.html.
- PHOSPHOR_DATA_DIR under the worktree's state/ is refused in demo mode (the key file would sit inside
  the working copy); a demo backend's data dir has to sit outside the checkout.
