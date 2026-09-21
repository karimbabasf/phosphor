# Report: node G, launch readiness

Branch `rfp/g-launch`, worktree `/Users/karimbaba/Developer/Apps/phosphor-rfp-g-launch`, parent
commit `6ff58a9`. Evidence under `evidence-g/`. Nothing pushed, tagged, released, or touched on
the site, Vercel or the installed app. Criteria cited as term.number.

## 1. Commits, oldest first

- `9b60bcb` The secret sweep runs again: a lockfile's crate checksums and the bridge token list are named as machine-written public formats, a mnemonic must be seed words, hex compares lowercase, and every fixture value in the tree and the history is excused by exact value with its source. Test: tests/unit/sweep.test.ts.
- `9e130ee` The eval harness's comments read the scenario count from tests/eval instead of stating 28.
- `98579e3` The log tail is redacted on the way out: this boot's seat secret and window token, any value filed under a secret's name, and PEM blocks never leave through GET /api/log or log_tail, while the hashes do. Test: tests/unit/log-tail.test.ts.
- `435c7ec` Help opens the bug form with the version and the macOS version filled in, and Copy Log for a Report puts the redacted audit tail on the clipboard. Tests: three in src-tauri/src/main.rs (cargo test).
- `af35046` The docs describe the build they ship with: the 0.7.0 reads and the 46 tools, the stage words, the policy walls of one click, where a fresh install keeps its state and keys, the shell and its updater, a known limits page, and the release checklist prepared and not run. Test: tests/unit/keys-path.test.ts (the fresh installed app).
- `e69a46a` README: the connect section speaks of the agent picker.
- (next) The sweep excuses the launch evidence's release checksums, the fake PEM block from the log tail test by its whole one-line value (the PEM match now runs to an END marker on the same line, so the header alone still trips), and a peer's made-up hash; the lessons lines, the evidence and this report. Test: tests/unit/sweep.test.ts, "a fake PEM block is excused only as the exact block".
- (final) The 0.8.0 changelog entry alone. See "Counts": the changelog heading makes one docs test red until the lead's version bump.

## 2. Counts

Taken on the tree before the changelog commit, evidence-g/typecheck.txt, test.txt:

- `npm run typecheck`: exit 0.
- `npm test`: 3076 tests, 3075 pass, 1 fail. Baseline on the parent `6ff58a9` was 3068 tests, 3067 pass, 1 fail (evidence-g/baseline-test.txt): the same one failure, `tests/unit/demo-rail.test.ts:152` expecting `1Click` and getting `The transfer`, which the lead's phase-0 stage commit `7e0357f` caused and the lead's later main commit "The demo stall test expects the transfer, not 1Click" fixes. Not in my files. My branch adds 8 tests (5 sweep, 2 log tail, 1 keys path), all green.
- `cargo test` in src-tauri (after `npm run bundle`): 24 passed, 0 failed, including the 3 new ones (evidence-g/cargo-test.txt).
- `npm run sweep`: PASS, 6 checks, 810 tracked files, 5840 history blobs (evidence-g/sweep-after.txt), rerun after the evidence files were staged; it caught the four release checksums in them, my own test's PEM fixture in history, and a hash node D committed on `rfp/d-card` an hour later, each now excused by exact value with a note. Expect the same at merge for any fixture another node adds. Before: FAIL with 8,076 findings (evidence-g/sweep-before.txt).
- `gitleaks git` (8.30.1): 176 findings, every one `generic-api-key`, every one a NEAR token id under a `tokenId` key, an env var name constant, the canonical Ethereum test key the sweep already excuses, or a made-up test string; zero secrets (evidence-g/gitleaks.txt; breakdown under 1.7 in section 3).
- `npm run eval`: 29 scenarios, 29 pass, 0 fail, 0 xfail (evidence-g/eval.txt), on the fourth attempt after another node released the machine lock; the count the harness prints comes from `loadScenarios`.
- After the changelog commit: `npm test` is 3076 with 2 failing, the demo-rail one above plus `tests/unit/docs.test.ts` "the changelog opens on the version in package.json", by design until package.json says 0.8.0.

## 3. Criteria

### 13.1 Fresh install: yes

- DMG sha256 matches SHA256SUMS and the site: the release asset, the site's `/download/mac` and the SHA256SUMS line all read `211b95fc39d380218e835b12a4d6a6feb516353a0103b9acd70a5aa4db79f48c`, 55,373,867 bytes; the image carries its `.DS_Store` layout and the app inside is ad hoc signed (evidence-g/dmg-check.txt, release-checks.txt, release-checks-2.txt). Release v0.7.0: five assets, annotated tag, published 2026-09-19T22:57:56Z.
- Gatekeeper path documented: docs/getting-started.md "The Gatekeeper warning", docs/troubleshooting.md "macOS will not open the app", README.md Install.
- Notarization named as the known gap: docs/getting-started.md (same section), docs/known-limits.md "The app is not notarized by Apple", docs/reference.md "Code signing: hardened, ad hoc, not notarized", release-checklist.md "Blockers that are not steps" (Apple Developer needs 18+, Karim turns 18 on 2027-01-30; the public docs say "an Apple Developer account this project does not hold yet").

### 13.2 Fresh empty data dir reaches done under 10 minutes: yes for the path, the timed run is the lead's

- `src/config.ts` on the installed app's fresh-Mac shape (PHOSPHOR_APP_DATA=1, a data dir under Application Support that does not exist, an empty HOME): creates the data directory (`fs.mkdirSync`, config.ts:343) and resolves the key to `~/.phosphor/<payload folder>/keys.json`, so the keystore lands at `~/.phosphor/phosphor/keys.enc.json` on a fresh Mac and the key folder is made 0700 when the wallet is created. Probed live and pinned by `tests/unit/keys-path.test.ts` "a fresh installed app makes its state directory and keys under the home key folder".
- The docs disagreed and were fixed: docs/security-model.md said `keysPath` defaults to `~/.phosphor/keys.json`; docs/reference.md did not say where the installed app keeps its state. Both now say the resolved paths (reference.md "Keys and signing").
- The stopwatch run on a fresh account is the lead's phase 4 (`<proof>` item 1); not run here.

### 13.3 Every doc matches the build: yes for the pages I own, two blockers named

- getting-started, money, policy, trading, troubleshooting, security, security-model, reference, architecture, tools, the docs index, README: checked against the tree (routes, tool names, npm scripts, file paths, env vars, stage words, versions, by script) and read page by page. What was stale and what changed is in commit `af35046`'s message.
- Changelog: `## 0.8.0` written (final commit), "Not tagged at the time of writing", with the lines for nodes A to F inside an HTML comment for the lead to keep per merged node, and the G lines plain. Recommended bump: 0.8.0 (four features, still alpha; not 1.0).
- Blocker 1: docs/connect-an-agent.md is node C's; my troubleshooting and getting-started lines about the picker follow the definitions file's sentences (10.3) and must be read against C's final copy at merge.
- Blocker 2, outside this repo: the LIVE site docs are one release behind. https://phosphor.karimbabasf.com/docs/ says "version 0.6.0" and the changelog page says "0.6.0 ... Not tagged" while `/download/mac` serves 0.7.0 (evidence-g/release-checks-2.txt). The site is off limits to this job; Karim rebuilds the site's docs from this repo's docs/ and pushes. 13.3's "the live changelog page no longer says Not tagged" is not met until then.

### 13.4 Terms, privacy, security pages; Help menu; lawyer read: yes, lawyer read open

- Site pages resolve, read only: `/terms/`, `/privacy/`, `/security/`, `/docs/`, `/` all 200 (evidence-g/release-checks-2.txt).
- Help menu (src-tauri/src/main.rs HELP_LINKS): Phosphor Documentation, Report a Problem (now prefilled), Copy Log for a Report (new), Report a Security Issue, Terms of Use, Privacy. Verified by reading the block and by `cargo test`.
- src/terms.ts untouched: TERMS_VERSION stays 2026-09-17 because the text did not change.
- The lawyer read of the terms is open (vault 2026-09-17; release-checklist.md "Blockers that are not steps"). Karim's.

### 13.5 Updater: ready, not run

- Endpoint set: `src-tauri/tauri.conf.json:52` `https://github.com/karimbabasf/phosphor/releases/latest/download/latest.json`, pubkey set, `createUpdaterArtifacts: true`. Untouched.
- The manifest resolves: latest.json says 0.7.0, versioned asset url, signature present; the previous release's `v0.6.0/latest.json` also resolves (evidence-g/updater-checks.txt). `tests/unit/release-manifest.test.ts` and `version-agrees.test.ts` green.
- The updater verifies the bundle, not the manifest: `update.rs::bundled_version`, cargo test `an_old_signed_bundle_announced_as_new_is_caught_by_the_version_inside` passes.
- The in-app update from the previous version cannot be verified without cutting a release. The exact procedure is release-checklist.md section 6. State: ready, not run.

### 13.6 No NSAlert as product UI; a dead backend with a live window impossible: partial, requests filed

- No NSAlert in my block: the new Copy Log item reports on its own menu title, never a dialog.
- Three native message boxes remain in src-tauri/src/main.rs outside my block, listed as requests in section 5: Copy MCP Config's outcome (the `match result` in `on_menu`), `fail()` for startup failures, `notify()` for the respawn notice. `grep -rn 'NSAlert\|dialog\|MessageDialog' src-tauri/src` finds these and nothing else (update.rs:421 is a test string).
- A dead backend with a live window is impossible today, by code and by test: the shell opens the control window only after its own child answers `GET /` with this boot's nonce (main.rs `start`; `tests/unit/boot-nonce.test.ts:90` "the window only opens onto a backend that answered with this boot nonce", `:109` "a dead child is asked about before the port is, in both readiness loops"); the same thread supervises the child, respawns once, then stops with a sentence (`tests/unit/window-token.test.ts:137`); the entitlement that once killed every signed build's backend is pinned (`tests/unit/code-signing.test.ts:92`); `/api/health` is the unauthenticated proof of life (`tests/unit/security-hardening.test.ts:438` onward). The window's boot opens the event stream and polls `/api/health` every 10 s whenever that stream is not live (`ui/screens/shell.js:272-300`, `ui/core/api.js:101`), naming `lastError`. No src-side test is missing for this; the window side has no source-assertion test on its health poll, and shell.js is node E's, so the exact test is a request (section 5).
- "Every failure situation passes the score" is node F's harness; not run here.

### 13.7 Support path: yes

- SECURITY.md private reporting text verified, and the repository setting is on: `gh api repos/karimbabasf/phosphor/private-vulnerability-reporting` returns `{"enabled":true}` (evidence-g/release-checks.txt). SECURITY.md now also points at docs/known-limits.md.
- `.github/ISSUE_TEMPLATE/`: bug_report.yml (prefilled version and os fields, a log field, the picker's agents), feature_request.yml, config.yml with the private channel first; pull_request_template.md present.
- Report a Problem opens `https://github.com/karimbabasf/phosphor/issues/new?template=bug_report.yml&version=<app>&os=<sw_vers>`; GitHub fills issue form fields from query parameters named after their ids. cargo test `the_problem_report_opens_the_bug_form_with_the_version_and_the_os_filled_in`.
- The log tail is copyable without the key or the seat secret: `src/http/log-tail.ts` redacts this boot's seat secret and window token by asking the holders (`agents.recognises`, `tokenMatches`), any value under a secret-named field, and PEM blocks; both readers (`/api/log`, `log_tail`) go through it; `tests/unit/log-tail.test.ts` proves both shapes gone and the tx hash kept, on both routes. Help, then Copy Log for a Report puts 200 lines on the clipboard.

### 13.8 Release pattern of 0.6.0: ready, not run

- docs/superpowers/prompts/ready-for-people/release-checklist.md: every step `ready` or its blocker. Nothing executed. CI green on push and the tags workflow green on v0.7.0 verified read only (evidence-g/updater-checks.txt).

### 13.9 Known limits page: yes

- docs/known-limits.md: alpha with real money, the key in memory while open, the sub-threshold exposure to a local process that read the seat secret, no notarization (and the enclave key bound to the Mac on an ad hoc build), the venues, Hyperliquid's withdrawal rules, your own click. Linked from the docs index, security.md, security-model.md, getting-started.md, troubleshooting.md, architecture.md, reference.md and SECURITY.md. The 19.94 USDC ticket is not mentioned; the bridge-holds-a-failed-deposit case is described in general.

### 4.4 MCP surface pinned by test: PASS

- `tests/injection.test.ts:366-374` asserts the live client's tool names as an exact sorted set against `EXPECTED_TOOLS_SORTED` from `tests/tool-surface.ts`; `scripts/e2e.ts` and `scripts/eval.ts` import the same list. The surface is versioned: `src/mcp.ts:319` registers the server with `VERSION` from package.json. The argument sets of `propose_send` and the lookup tools are pinned too. A benign argument added to another tool would not fail a test today; the per-tool argument pin is a request for after A, B and C merge (section 5).

### 4.5 Any MCP client connects and is named in the roster: PASS

- `tests/injection.test.ts:348` connects a real stdio client named `phosphor-injection` and asserts the roster names it, never the proxy; `scripts/e2e.ts:238` uses `phosphor-e2e`; `tests/unit/agents.test.ts:44` seats `codex` beside `claude-code`; `tests/unit/agents.test.ts:209` caps an agent-authored name. No new test: the behaviour is held three ways already.

### Sweep and eval count: PASS

- `npm run sweep` PASS (evidence-g/sweep-after.txt); cause and fix in commit `9b60bcb`.
- `scripts/eval.ts` lines 5 and 47 (the brief's 4 and 41 in this checkout) no longer state 28; the count comes from the scenario directory. `.github/workflows/ci.yml:46` likewise.

### 11 One regression test per fix: PASS

- sweep: tests/unit/sweep.test.ts (red on the parent: importing the script ran the whole sweep and exited 1). Log tail: tests/unit/log-tail.test.ts (red on the parent: both readers handed out the seat secret). Help menu: three cargo tests (red on the parent: the functions did not exist). Fresh install paths: tests/unit/keys-path.test.ts (a verification test: green on the parent, pins what the docs now say).

## 4. Decisions

- Sweep: the Cargo.lock cause is structural (an exact-value allowlist cannot follow a lockfile), so `KNOWN_PUBLIC_FORMATS` names a file and the one whole-line shape its format gives a digest; a value anywhere else in that file still trips. The bridge token list fixture is the second entry of the same class. Test vectors and public hashes are excused by exact value with a note, per the file's own rule and the vault gotcha, never by loosening a pattern.
- Sweep: the probe's `data/claude/.claude.json` (committed and removed on 2026-09-07, both commits on origin) holds two hashed Claude Code telemetry ids; excused as not keys, named in the allowlist, and listed under follow-ups as a history rewrite that is Karim's call.
- Sweep: four signature halves in node B's research doc (on `rfp/b-hyperliquid`, visible to `--all`) are excused now so the sweep is green for every node at merge.
- Sweep: hex compares lowercase against the allowlist (a hash has no case), and the mnemonic check requires BIP39 words (viem's list, the keystore's own).
- 13.7, log tail: a bare 64 hex run is NOT redacted by shape, because a transaction hash is the log's evidence and has the same shape as a key; the key is kept out at the write paths, which the existing tests hold. The redactor asks the holders instead of copying a secret.
- 13.6, Copy Log: the outcome is written onto the menu item's own title for four seconds instead of a message box.
- 13.3, changelog: heading set to 0.8.0 as the brief says, in the last commit, knowing it turns `docs.test.ts` red until the lead's bump; the lead was told before the commit.
- 13.3, picker copy: troubleshooting.md and getting-started.md describe the picker with the definitions file's sentences (10.3), since node C's copy is not final; flagged for the merge.
- 4.4: no argument pin added now; it would collide with A, B and C changing tool schemas in this job. Filed as a request for after their merge.
- 4.5: no new roster test; the existing three cover it.
- 13.2: the fresh-install test went into `tests/unit/keys-path.test.ts` (not in my listed files) because that file is where the repo keeps this exact behaviour; no other node touches it.
- gitleaks: run and reported, not made green: a `.gitleaks.toml` is a root file outside my list, so its content is a request.

## 5. Requests for the lead

1. Version bump to 0.8.0 in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` in the same merge as my changelog commit, or the docs test stays red.

2. Three native message boxes in `src-tauri/src/main.rs`, outside my block (13.6). Suggested shapes:
   - Copy MCP Config (in `on_menu`, the `match result` arms): replace both `.dialog()...show(|_| {})` arms with a title notice on the item, the way `say_on_menu` does for Copy Log. Diff: keep a `MenuItem` handle for `COPY_MCP_ID` in the managed struct (extend `HelpMenu` with `copy_mcp: MenuItem<Wry>` and set it in `build_menu`), generalise `say_on_menu(app, text)` to `say_on_item(app, item, text, resting_label)`, then `Ok(()) => say_on_item(app, &help.copy_mcp, "MCP config copied. Run it where the agent should work", "Copy MCP Config")` and `Err(err) => { eprintln!("phosphor: {err}"); say_on_item(app, &help.copy_mcp, "Nothing copied: see Console.app", "Copy MCP Config") }`.
   - `fail()`: a startup failure before any window exists. Either keep it as the one native box, since there is no app window to draw into and the app quits on dismissal, and say so in the code comment; or open a failure page through `update.rs::show`'s pattern (`src-tauri/frontend/update.html` takes a title and notes) and exit on its close. Lead's call; the second keeps 13.6 literal.
   - `notify()`: the respawn notice while the window is open. The window already has the offline banner (`ui/screens/shell.js sayOffline`) driven by the event stream and the health poll; let the banner say "The control app restarted" when `/api/health`'s `uptimeSec` drops below the previous read (a source change in `ui/screens/shell.js`, node E's), then delete `notify`.

3. A source-assertion test for the window's health poll, after node E merges (13.6). File `tests/unit/shell-health-ui.test.ts`:

        // The window's boot ends in a live event stream or a health poll, never in silence: a
        // dead backend under an open window shows a banner within ten seconds and names lastError.
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { fileURLToPath } from 'node:url';
        const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
        const shell = fs.readFileSync(path.join(ROOT, 'ui/screens/shell.js'), 'utf8');
        const api = fs.readFileSync(path.join(ROOT, 'ui/core/api.js'), 'utf8');
        test('the window polls /api/health while its stream is down, and stops when it is live', () => {
          assert.match(api, /health: function \(\) \{\s*return net\.getJson\('\/api\/health'/);
          assert.match(shell, /function startHealthPoll\(/);
          assert.match(shell, /healthTimer = window\.setInterval\(pollHealth, 10000\)/);
          assert.match(shell, /function stopHealthPoll\(/);
          assert.match(shell, /api\.health\(\)/);
          assert.match(shell, /health\.lastError/, 'the poll names what is wrong, not only that something is');
        });

4. A per-tool argument pin (4.4, "a schema change fails a test before it ships"), after A, B and C merge. In `tests/tool-surface.ts` add `export const EXPECTED_ARGUMENTS: Readonly<Record<string, readonly string[]>>` listing every tool's sorted argument names as they stand after the merge; in `tests/injection.test.ts` inside "the tool surface cannot express an exfiltration target", after `assertNoExfiltrationTarget(tools)`, add:

        for (const tool of tools) {
          assert.deepEqual([...propertyNames(tool.inputSchema)].sort(), [...EXPECTED_ARGUMENTS[tool.name]], `${tool.name} changed its arguments; tests/tool-surface.ts is the one list`);
        }

   The list is written once from `tools.map(t => [t.name, [...propertyNames(t.inputSchema)].sort()])` on the merged tree.

5. `diagnose` (src/http/read/wallet.ts, the `log:` field) formats a row's own audit lines without the redaction the tail routes now have. One change: `const isCredential = credentialCheck(ctx);` above, and `.map((e) => withoutAddresses(...))` becomes `.map((e) => redactEvent(e, isCredential)).map((e) => withoutAddresses(...))`, with `import { credentialCheck, redactEvent } from '../log-tail.ts';`. Left alone because the brief named the tail route; it is the same class.

6. `.gitleaks.toml` at the repo root, so gitleaks' exit code means something (1.7):

        [allowlist]
          description = "NEAR token ids and fixtures the sweep already judges by exact value"
          regexes = [
            '''nep141:[0-9a-f]{64}''',
            '''[a-z0-9-]+\.omft\.near''',
            '''INTENTS_API_KEY_ENV''',
          ]
          paths = [
            '''tests/fixtures/poa-tokens\.json''',
            '''data/tokens(\.testnet)?\.json''',
          ]

   Then `gitleaks git --no-banner --redact` is the check; today it reports 176 generic-api-key hits and no secret.

7. For Karim, not the lead: rebuild the site's docs from this repo's docs/ after the merge and push the site (the live docs say 0.6.0 and "Not tagged" while the download is 0.7.0); and `/updates/latest.json` on the site answers 404 (the app does not use it; the site README's line is stale).

## 6. Follow-ups found, not fixed

- `tests/unit/demo-rail.test.ts:152` fails on the parent commit (`The transfer` vs `1Click`) from the lead's `7e0357f`; the lead's later main commit fixes it.
- `data/claude/.claude.json` sits in history (cf82665, removed in 3e50c07, both on origin) with two hashed Claude Code telemetry ids from a throwaway probe; not keys; removing them is a history rewrite and Karim's call. The sweep names them.
- Karim's real wallet address in `src/persona.ts:30` and twelve test fixtures (vault State 2026-09-18) is not a sweep finding in this worktree because no local config or keys file is present, so check 2 has nothing to match against; the swap for a burn address is still open.
- LaunchServices holds eight stale `/Volumes/dmg.*/Phosphor.app` and one `src-tauri/target/release/bundle` registration on this Mac (Gotcha "Spotlight shows two Phosphors"); my DMG check mounted at a private mountpoint and added none.
- `docs/money.md` "Withdraw from Hyperliquid" and `docs/reference.md`'s spotSend sentence describe the exit before node B's sendAsset change; the lead reads them against B at merge.
- `docs/security-model.md` "What signs, and with what" does not yet name the relay's `token_diff` signing; node A's merge should add one sentence.
- `src/mcp-errors.ts` STILL_WORKING says "read proposal_status (the id is in log_tail)"; `proposals` now exists and is the better pointer (node D's wording).
- `grep --include` is swallowed by the grep shim in this shell; `/usr/bin/grep -rn -e` works.

## 7. Lessons appended

The four `[G]` lines at the end of docs/superpowers/prompts/2026-09-20-ready-for-people.lessons.md: sibling branches are visible to the sweep in a worktree; the docs test pins the changelog heading to package.json; gitleaks' generic rule fires on NEAR token ids; the site's docs are a separate push from the app release.
