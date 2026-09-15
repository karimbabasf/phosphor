# Mac install, signed updates and a safe download path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Download button on phosphor.karimbabasf.com hands a Mac user a DMG that installs Phosphor, and every installed copy learns about new releases and installs them only when the release carries Karim's signature.

**Architecture:** GitHub Actions builds the app on a clean macOS runner from a version tag, signs the updater bundle with a minisign key (and, once the Apple cert exists, Developer ID signs and notarizes the app), and publishes the DMG, the updater tarball, its signature, `latest.json` and checksums as a GitHub Release. The site is static on Vercel: `/download/mac` redirects to the stable DMG asset, `/updates/latest.json` redirects to the manifest, and a `vercel.json` sets the security headers. The Rust shell checks the manifest on launch and every six hours and offers the update in a native dialog; the control window stays without an IPC bridge.

**Tech Stack:** Tauri 2 (tauri-plugin-updater, tauri-plugin-dialog), tauri-bundler DMG (create-dmg), GitHub Actions on macos-15 arm64, Vercel static hosting, Node 24 test runner.

**Spec:** this file, sections "Threat model" and "Decisions" below.

## Global constraints

- One version in three files and they must agree: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`. First public release is `0.4.0`.
- Apple silicon only (`aarch64-apple-darwin`). No universal build: the bundled Node runtime doubles the DMG and macOS 26 is the last Intel release.
- The control window keeps zero Tauri IPC. All update UI is native (dialog, menu), driven from Rust.
- No new crate that a hand-rolled fifty lines would replace (crate rule in `src-tauri/Cargo.toml`). The updater plugin is the one addition: it carries the signature check, which must not be hand-rolled.
- No em or en dashes anywhere. Comments match the repo: prose that explains a decision, not a restatement of the code.
- Never commit a private key. The updater private key lives at `~/.tauri/phosphor.key` (password protected) and in the GitHub secret `TAURI_SIGNING_PRIVATE_KEY`; nowhere else.

## Threat model (scope: distribution, update, site)

Assets: the user's keystore and the funds behind it; the integrity of the binary the user runs; the site as the entry point; Karim's signing material (minisign key, Apple cert, GitHub account).

| # | Threat | Where | Mitigation in this plan |
|---|---|---|---|
| T1 | Trojaned download (site, DNS or CDN compromised, MITM) | site, GitHub | HTTPS + HSTS; download served from GitHub Releases, a second host an attacker must also own; Developer ID signature + notarization once the cert exists (Gatekeeper refuses anything else); SHA-256 of the DMG in the release notes and in `SHA256SUMS`; the signing Team ID documented in the README so `codesign -dv` can be checked by hand. |
| T2 | Fake or downgraded update | update endpoint | minisign signature verified against the public key compiled into the binary; endpoints are HTTPS only; the plugin installs only a strictly greater semver, so a captured endpoint can deny updates but never push one. |
| T3 | Compromised build pipeline or dependency | CI | Build from a tag on a fresh runner; every third-party action pinned to a commit SHA; `npm ci` and `Cargo.lock` only; job token limited to `contents: write`; secrets exposed only to the release workflow; tags `v*` cannot be moved or deleted (ruleset); secret scanning, push protection and Dependabot on both repos. |
| T4 | Stolen or lost signing key | Karim's machine, GitHub | Private key is password protected (two secrets, never one); a lost key means every installed copy must be reinstalled by hand, so the key is backed up outside this Mac (Karim's step). |
| T5 | Script injection on the site rewriting the download link | site | Strict CSP (`script-src 'self'` plus one hash for the `js` class bootstrap), no inline event handlers, vendor scripts self-hosted, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP. |
| T6 | Lookalike domain or fake "Phosphor" app | outside | Cannot be prevented; README and release notes name the only two download hosts and the signing identity. |
| T7 | Interim without notarization trains users to click "Open Anyway" | Gatekeeper | Stated plainly in the README with the exact dialog path and the checksum to compare first; closed the day the Apple cert lands (workflow already wired for it). |
| T8 | Update installs while money is moving | app | Install is a human click and a restart; the shell already locks the wallet on window close and kills the backend on exit; the backend already shuts down gracefully. |

Not applicable and why: rate limiting. The site has no API, no form, no cookie and no session; the only server-side behaviour is two redirects. Downloads are rate limited by GitHub. Vercel's DDoS mitigation is on by default and Attack Challenge Mode is one toggle away if abuse appears.

## Decisions

- Native dialog and a "Check for Updates..." menu item, not an in-window banner. The control window has no IPC bridge on purpose; a banner would need the backend to relay clicks to the shell. Sparkle-style native UI is the Mac convention and adds no trust surface.
- Update endpoints, in order: `https://phosphor.karimbabasf.com/updates/latest.json` (a Vercel redirect, so the host can move without shipping a new app), then `https://github.com/karimbabasf/phosphor/releases/latest/download/latest.json` as fallback.
- Stable asset name `Phosphor-macOS-arm64.dmg` so `/releases/latest/download/` resolves without JavaScript on the site. The updater tarball keeps Tauri's versioned name because `latest.json` is regenerated per release.
- Plain workflow steps, not tauri-action: one platform, fewer third-party actions to trust, and the asset names are under our control.
- Ad-hoc signing stays the default so the pipeline runs today; the Developer ID path activates by setting secrets, no code change.

---

### Task 1: Updater keypair, config and the version guard

**Files:**
- Modify: `src-tauri/tauri.conf.json` (version, targets, createUpdaterArtifacts, dmg, plugins.updater)
- Modify: `src-tauri/Cargo.toml` (version, tauri-plugin-updater)
- Modify: `package.json` (version)
- Create: `tests/unit/version-agrees.test.ts`

**Interfaces:**
- Produces: the public key string in `plugins.updater.pubkey`; the private key at `~/.tauri/phosphor.key`.

- [ ] Generate the keypair: `npx tauri signer generate -w ~/.tauri/phosphor.key` with a password; record nothing but the public key in the repo.
- [ ] Write the failing test: read the three files, assert the three versions are equal and semver-shaped.
- [ ] Bump all three to `0.4.0`; run `node --test tests/unit/version-agrees.test.ts`; expected PASS.
- [ ] Config: `"targets": ["app", "dmg"]`, `"createUpdaterArtifacts": true`, `bundle.macOS.dmg` with `background: "dmg/background.tiff"`, `windowSize {660, 400}`, `appPosition {165, 175}`, `applicationFolderPosition {495, 175}`, `plugins.updater.endpoints` and `pubkey`.
- [ ] `cargo add tauri-plugin-updater` pinned in Cargo.toml; `cargo check` from `src-tauri` passes.
- [ ] Commit.

### Task 2: The shell learns to update itself

**Files:**
- Create: `src-tauri/src/update.rs`
- Modify: `src-tauri/src/main.rs` (plugin init, menu item, schedule the first check after the control window opens)

**Interfaces:**
- Produces: `update::schedule(app: &AppHandle)` (first check 20 s after the window opens, then every 6 h); `update::check_now(app: &AppHandle, announced: bool)` for the menu item; `update::CHECK_ID` menu id.

- [ ] Rust unit tests for the pure parts: `offer_text(version, notes)` trims the notes to 600 chars, and `should_offer(found, dismissed)` is false for a version the person already said Later to in this run.
- [ ] Implement: `check_now` runs `app.updater()?.check().await` on `tauri::async_runtime::spawn`; a found update becomes a two-button `MessageDialog` (`Install and relaunch` / `Later`) shown non-blocking with `show(callback)`, because menu and timer events must never block the main thread (rule already in `on_menu`); `Install` runs `download_and_install` then `app.restart()`; errors from an automatic check are logged, errors from a manual check get a dialog; a manual check that finds nothing says "Phosphor 0.4.0 is up to date".
- [ ] `cargo test` in `src-tauri` passes; `cargo build` compiles.
- [ ] Commit.

### Task 3: The DMG window

**Files:**
- Create: `src-tauri/dmg/background.html` (source of truth for the picture), `src-tauri/dmg/render.ts` (renders 1x and 2x PNGs over CDP and joins them into `background.tiff`), `src-tauri/dmg/background.tiff`

Requirements: 660x400 points; ink ground from the brand; the wordmark PNG at the top; an arrow from the app slot (centre 165,175) to the Applications slot (centre 495,175); one line of Geist under the arrow; Finder draws the two icon labels itself in black (light appearance) or white (dark appearance), so the band the labels land on (y 245 to 275) must read against both.

- [ ] Write the HTML, render with the automation Brave at DPR 1 and 2, `tiffutil -cathidpicheck background.png background@2x.png -out background.tiff`.
- [ ] `npm run app:build` locally; `hdiutil attach` the DMG; screenshot the Finder window; icons sit on their slots and the labels read.
- [ ] Commit the HTML, the renderer and the TIFF.

### Task 4: Release manifest and checksums

**Files:**
- Create: `scripts/release-manifest.ts`, `tests/unit/release-manifest.test.ts`

**Interfaces:**
- Produces: `buildManifest({version, tag, notes, sigPath, tarballName, repo, now}) => LatestJson` and a CLI that writes `latest.json` and `SHA256SUMS` next to the bundle output.

- [ ] Failing test: the manifest has `version`, `notes`, `pub_date` (RFC 3339) and `platforms["darwin-aarch64"].url` equal to `https://github.com/karimbabasf/phosphor/releases/download/v0.4.0/Phosphor_0.4.0_aarch64.app.tar.gz` with `signature` equal to the `.sig` file content, trimmed.
- [ ] Implement; `node --test tests/unit/release-manifest.test.ts` PASS; commit.

### Task 5: The release workflow and the repo settings

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] Workflow on `push: tags: ['v*']`, `permissions: contents: write`, `runs-on: macos-15`, timeout 60 min, concurrency per tag. Steps: checkout, setup-node 24, rustup target, `npm ci`, optional Apple cert import (only when `APPLE_CERTIFICATE` is set), optional API key file, `npm run bundle`, `npx tauri build --target aarch64-apple-darwin`, rename the DMG to `Phosphor-macOS-arm64.dmg`, `node scripts/release-manifest.ts`, `gh release create` with the five assets and notes carrying the SHA-256 and the verify steps. Every action pinned to a SHA.
- [ ] Secrets: `gh secret set TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- [ ] Repo hardening via `gh api` on phosphor and phosphor-site: secret scanning + push protection, Dependabot alerts and security updates, default workflow token read-only, ruleset blocking force push and deletion on `main` and on tags `v*`.
- [ ] Push `main`, tag `v0.4.0`, watch the run, download the DMG, `codesign -dv --verbose=2`, `shasum -a 256` matches `SHA256SUMS`.

### Task 6: The site

**Files:**
- Modify: `~/Developer/Apps/phosphor-site/index.html` (both Download controls become links; the Coming soon swap goes)
- Create: `~/Developer/Apps/phosphor-site/vercel.json` (redirects + headers)
- Modify: `~/Developer/Apps/phosphor-site/README.md` (test steps)

- [ ] `<a class="download" href="/download/mac">Download for Mac</a>` in the nav and the CTA; the button styles apply to the link.
- [ ] `vercel.json`: `/download/mac` 307 to `https://github.com/karimbabasf/phosphor/releases/latest/download/Phosphor-macOS-arm64.dmg`; `/updates/latest.json` 307 to the GitHub manifest; headers on `/(.*)`: HSTS 2 years with subdomains, CSP, nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, COOP.
- [ ] Verify locally with `vercel dev` or after deploy: `curl -sI https://phosphor.karimbabasf.com/download/mac` shows 307 to GitHub; the page loads in the headless Brave with zero console errors (CSP violations show there).
- [ ] Commit, push, confirm the production deployment.

### Task 7: README runbook

**Files:**
- Modify: `README.md` ("Install it as a Mac app" and a new "Cut a release" section)

- [ ] Install: download link, drag to Applications, the Gatekeeper path until notarization, verify with `shasum -a 256` against the release notes and `codesign -dv --verbose=2 /Applications/Phosphor.app`.
- [ ] Release: bump the three versions, `git tag v0.x.y`, push the tag, what the workflow produces, where the keys live, the six Apple secrets to add when the cert lands.
- [ ] Commit.

### Task 8: Prove the updater end to end

- [ ] Install the CI-built 0.4.0 to `/Applications`, launch it, confirm no dialog (up to date).
- [ ] Tag `v0.4.1` (README or notes change only), wait for the release, relaunch 0.4.0: the dialog offers 0.4.1; Install and relaunch; About shows 0.4.1 and `/api/health` reports 0.4.1.

### Task 9: Review and flush

- [ ] Final review at the strongest model through the delegation skill: the Rust module, the workflow, `vercel.json`.
- [ ] Vault: Projects/phosphor.md State and Gotchas, session line, decision note for the update design.
