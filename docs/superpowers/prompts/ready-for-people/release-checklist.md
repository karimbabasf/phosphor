# Release checklist: the 0.6.0 pattern, prepared for the next version, NOT run

Written 2026-09-20 by node G from the 0.6.0 and 0.7.0 releases (vault State 2026-09-18 and
2026-09-19), `.github/workflows/release.yml`, and the Gotchas that bit on the way. Every step is
marked `ready` (nothing stands in its way once the step before it is done) or names the blocker.
Nothing here has been executed: no push, no tag, no release, no site change. The version below
is the one node G recommends, 0.8.0; the lead owns the bump.

Evidence the pattern still holds today, read only, in `evidence-g/`:
`release-checks.txt`, `release-checks-2.txt`, `dmg-check.txt`, `updater-checks.txt`.

## 0. Before the release branch is cut

| Step | State | Note |
|---|---|---|
| Version is one value in three files: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (`tests/unit/version-agrees.test.ts`) | blocker: the lead bumps to 0.8.0 | package.json is the lead's; the changelog heading is already 0.8.0 (see step 1) |
| `docs/changelog.md` opens on that version (`tests/unit/docs.test.ts`) and its first line says "not tagged" until the tag exists | ready | the "tagged vX on DATE" words are written after the tag lands, by hand, as for 0.6.0 |
| Every docs page describes the build (13.3) | ready for G's pages; connect-an-agent.md is node C's | the lead checks money.md (HL exit, B) and reference.md (relay signing, A) against A and B at merge |
| `npm run typecheck` clean, `npm test` at or above baseline, `npm run e2e` 0, `npm run eval` 29/29 | ready | counts in report-g.md |
| `npm run sweep` PASS and `gitleaks git` read (the generic-api-key hits are NEAR token ids, see report-g.md) | ready | sweep fixed in 9b60bcb |
| `npm run bundle` then `cd src-tauri && cargo test` (the shell's own tests; the build script wants the staged sidecar) | ready | 24 passed on 2026-09-20 |
| Quit the installed app before `npm test` (three seat-capacity injection tests answer 409 with it running) | ready | `pgrep -f Phosphor.app/Contents/MacOS` |

## 1. Push main, and wait

| Step | State | Note |
|---|---|---|
| `git push origin main` with the branch ALONE, no tag in the same push | blocker: pushing is Karim's | a tag pushed in the same push as a branch did not fire the tags workflow, twice (Gotcha 2026-09-15) |
| `ci.yml` green on that push (`gh run list --workflow ci.yml --branch main --limit 1`) | ready | the release does not wait for it, so wait yourself: the README badge points at it |
| No other release run in flight (`gh run list --workflow release.yml --limit 1`) | ready | GitHub picks "latest" by creation time; two overlapping runs point `/releases/latest/download/` at the older one (Gotcha) |

## 2. Tag, annotated, and push the tag alone

| Step | State | Note |
|---|---|---|
| `git tag -a v0.8.0 -m "Phosphor 0.8.0: <one line>" -m "<the notes body>"` | blocker: Karim's finger | an annotated tag's message is the release notes body; a lightweight tag ships the commit subject as the headline and nothing else (0.4.1 shipped with no notes) |
| `git push origin v0.8.0` | blocker: Karim's finger | the tag ALONE |
| `gh run watch` on the release run (macos-15, about 8 minutes) | ready | the run refuses to build without `TAURI_SIGNING_PRIVATE_KEY`; the key content is in the secret, not a path (the bundler ignores the path variable at 2.11.4) |
| The immutable-tags ruleset: a tag, once pushed, cannot be moved | ready | moving one means disabling the ruleset, deleting and re-pushing, re-enabling: prefer a new patch version |

## 3. What the run must produce (the five assets)

| Step | State | Note |
|---|---|---|
| `Phosphor-macOS-arm64.dmg`, `Phosphor_0.8.0_aarch64.app.tar.gz`, `.sig`, `latest.json`, `SHA256SUMS` | ready | v0.7.0 has exactly these five (release-checks-2.txt) |
| Release notes carry the two SHA-256 lines and the Gatekeeper sentence | ready | the workflow writes them; `APPLE_SIGNING_IDENTITY` empty keeps the Gatekeeper sentence in |
| `latest.json` points at the VERSIONED asset url, never `/latest/`, and carries the signature content | ready | `tests/unit/release-manifest.test.ts` |
| The DMG has its Finder layout (`.DS_Store` inside the image) | ready | `TAURI_BUNDLER_DMG_IGNORE_CI=true` in the workflow; v0.7.0's image carries it (dmg-check.txt) |
| The DMG is copied to the site's Blob store so `/download/mac` serves the same bytes | ready | the workflow's last step with `BLOB_READ_WRITE_TOKEN`; verified on v0.7.0: 211b95fc...f48c on both (dmg-check.txt) |

## 4. Verify the release from a clean download

| Step | State | Note |
|---|---|---|
| `curl -sL <release dmg> \| shasum -a 256` equals the SHA256SUMS line | ready | evidence-g/dmg-check.txt is the 0.7.0 run of this |
| `curl -sL https://phosphor.karimbabasf.com/download/mac \| shasum -a 256` equals the same | ready | same file |
| `curl -sL https://github.com/karimbabasf/phosphor/releases/latest/download/latest.json` says the new version | ready | the app's updater endpoint (`src-tauri/tauri.conf.json:52`) |
| `hdiutil attach`, then `codesign --verify --deep --strict` on the app inside | ready | ad hoc until a Developer ID exists (below) |

## 5. Install on this Mac (Karim's word, every time)

| Step | State | Note |
|---|---|---|
| Quit the running app: `pgrep -f Phosphor.app/Contents/MacOS`, then quit it through AppleScript or the menu; never `rm -rf` under a running copy (the backend serves ui files off disk per request) | blocker: Karim's word | the app on 4177 is his; "leave the installed app as you found it" |
| `rm -rf /Applications/Phosphor.app`, `ditto` the app out of the verified DMG | blocker: Karim's word | |
| `lsregister -u` every stale entry (`lsregister -dump \| grep Phosphor.app`), `lsregister -f /Applications/Phosphor.app` | ready | Spotlight shows two Phosphors after any local build or DMG mount |
| Launch, then `curl 127.0.0.1:4177/api/health` returns `ok:true` with the new version and a node child under `Phosphor.app/Contents/MacOS/node` | ready | THE check for the dead-backend class; "does it launch" is not it |
| Wallet file and state untouched: `~/.phosphor/keys.enc.json` and Application Support are never in the DMG | ready | |

## 6. The in-app update from the previous version (13.5), ready and not run

This is the one verification a release cannot skip and this job could not run: it needs a
release to exist above the installed one, and cutting a release is forbidden here. The exact
procedure, for the first release after 0.7.0:

1. Take the previous DMG (`v0.7.0`, sha 211b95fc...f48c) and install it under a throwaway data
   dir rather than over the real app: `PHOSPHOR_DATA_DIR` is set by the shell, so the honest way
   is a second macOS user account on this Mac (new home, no wallet), which is also what 13.2's
   fresh-user run wants. Open it from Applications once, click through the terms and the
   Gatekeeper prompt, quit.
2. Cut and publish 0.8.0 (steps 1 to 4 above).
3. On the second account, open Phosphor 0.7.0. Phosphor, then Check for Updates. Expected: the
   app's own update window (`src-tauri/frontend/update.html`, never an NSAlert) offers 0.8.0 with
   the notes from the tag; Install; the window shows progress; the backend is stopped by the
   updater itself before the relaunch (`AppHandle::restart` on the main thread exits without
   `RunEvent::Exit`, so the updater does its own kill, Gotcha); the app relaunches.
4. Evidence: About Phosphor says 0.8.0; `curl 127.0.0.1:4177/api/health` says `version: 0.8.0`
   with `ok: true`; the audit log carries `app_start` from the new version; the old node child is
   gone (`pgrep -f Phosphor.app/Contents/MacOS/node` shows one backend). Screenshot the update
   window and the About box.
5. The rollback guard: `update.rs::bundled_version` reads the version out of the SIGNED bundle,
   not the manifest, so a manifest rewritten to offer an older bundle is refused. It is unit
   tested (`an_old_signed_bundle_announced_as_new_is_caught_by_the_version_inside`, cargo test)
   and needs no live run.

State: ready, not run. Blockers: a release above 0.7.0 does not exist yet, and installing 0.7.0
on a second account takes Karim's login.

## 7. After the release

| Step | State | Note |
|---|---|---|
| Edit `docs/changelog.md`'s first line to "tagged v0.8.0 on DATE", commit, push | blocker: pushing is Karim's | |
| Rebuild the site's docs from this repo's `docs/` and push the site (build-docs.mjs) | blocker: the site is off limits to this job; TODAY the live docs still say 0.6.0 and "Not tagged" (release-checks-2.txt) while the download is 0.7.0 | 13.3 is not met on the site until this runs |
| Vault note State bullet: version, main hash, run id, five assets, DMG sha, site verified | ready | the 0.6.0 bullet is the template |
| `/releases/latest` is the new release (`gh release view --json isLatest` is not a field; check the page) | ready | |

## Blockers that are not steps

| Blocker | What it takes |
|---|---|
| Notarization and a Developer ID signature | an Apple Developer Program account (individual enrollment is 18+; Karim turns 18 on 2027-01-30). The workflow already signs and notarizes when `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` are set; a set-but-empty one breaks the bundler, so the workflow unsets empties first |
| The lawyer read of the terms | open since 2026-09-17; `src/terms.ts` `TERMS_VERSION` bumps when the text changes |
| `/updates/latest.json` on the site answers 404 | not on the app's path (the updater reads GitHub); a site fix if the README of the site still promises it |
