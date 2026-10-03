// Updates: found on a schedule, installed by a click.
//
// The control window has no IPC bridge on purpose (see main.rs), so nothing about updates goes
// through the page. The check runs in this shell, the offer is a window of the shell's own
// (frontend/update.html, served by Tauri like the splash), the manual check is a native menu
// item, and the control page never learns any of it. The update window's commands are four:
// install, dismiss, retry (a failed check or install asked again), and the download page after a
// refusal (its one fixed address, crate::DOWNLOAD_URL, as the splash opens it). Each refuses a caller
// that is not that window, and a remote page cannot reach app commands at the ACL anyway.
//
// What the plugin does, and why it is the one thing here that is not hand-rolled: it fetches
// latest.json over TLS from the endpoint in tauri.conf.json, takes the entry for this OS and
// architecture, downloads the bundle, verifies its minisign signature against the public key
// compiled in from the same file, and installs only when the manifest's version is greater
// than the one running. A homemade version of that signature check is exactly the bug an
// attacker wants.
//
// What the plugin does NOT do, and this file does: the manifest is not signed, only the bundle
// is. So whoever can serve a manifest (the release host, or anyone with write access to the
// repository) could name an old, validly signed bundle as "0.9.0" and roll a machine back to a
// build with a hole that was since fixed. Two checks close that, both before install: the
// download URL must be the versioned GitHub asset for the version the manifest names, and the
// version inside the downloaded, signature-checked tarball (Contents/Info.plist) must be that
// same version and newer than what is running. The signature covers the plist, so the version
// is bound to the key after all. What a captured feed can still do is withhold updates.
//
// What a minisign signature does not prove is who built the bundle: the key signs whatever it
// is handed, wherever releases are made. So before anything is replaced, the bundle is unpacked
// into a private folder and Apple's Security framework checks its code signature against a
// requirement compiled in here (`requirement`): Apple's anchor, a Developer ID Application
// certificate, this app's identifier and a team from TEAMS, nested code included, strictly. An
// ad-hoc, unsigned or other team's bundle is refused, the installed app stays as it was, and the
// window says the update did not pass its check. The plugin unpacks the same bytes again for the
// swap, with no guard of its own, so an archive that could unpack differently the second time,
// or anywhere outside its folder, is refused too (`unpack`).
//
// Installing swaps /Applications/Phosphor.app for the new bundle and relaunches. The backend is
// stopped first, through Backend::kill, because AppHandle::restart on the main thread exits the
// process without raising RunEvent::Exit: the run loop's kill would never fire and the old node
// would stay up on the port, and the new shell would refuse to open a window onto a backend it
// did not start. Taking the child out of Backend also tells the supervisor thread that this stop
// was meant, so it does not respawn the backend under the feet of the restart.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, Once};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::backend::{configured_port, get_health, Backend};

pub const CHECK_ID: &str = "check-for-updates";
const WINDOW: &str = "update";

/// Where a release lives. The only host the updater will download from; a manifest naming any
/// other URL is refused before a byte is read.
const RELEASES: &str = "https://github.com/karimbabasf/phosphor/releases/download";

/// The Apple teams an update may be signed by. A team change is one more line here, shipped in
/// a release signed by the old team, before anything signed by the new one.
const TEAMS: &[&str] = &["35Z6P26CBD"];

/// The bundle identifier an update must carry. Its code signature seals it.
const IDENTIFIER: &str = "com.karimbabasf.phosphor";

/// The first automatic check waits for the window to be up and the person to be past the
/// splash; the ones after it are far enough apart that a release is seen the same day without
/// the app ever polling like a client that wants attention.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Release notes are for a release page. The window gets the opening of them, enough to know
/// what changed, and the rest stays on GitHub.
const NOTES_LIMIT: usize = 600;

/// What the shell knows between the check and the click: the update the window is showing,
/// and the version the person answered Later to. The automatic check stays quiet about that
/// version for the rest of this run; the menu item still offers it, because asking is consent.
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
    dismissed: Mutex<Option<String>>,
}

impl Updates {
    fn dismissed(&self) -> Option<String> {
        self.dismissed.lock().ok().and_then(|guard| guard.clone())
    }

    fn dismiss(&self, version: String) {
        if let Ok(mut guard) = self.dismissed.lock() {
            guard.replace(version);
        }
    }

    fn offer(&self, update: Update) {
        if let Ok(mut guard) = self.pending.lock() {
            guard.replace(update);
        }
    }

    fn take(&self) -> Option<Update> {
        self.pending.lock().ok().and_then(|mut guard| guard.take())
    }

    fn pending_version(&self) -> Option<String> {
        self.pending.lock().ok().and_then(|guard| guard.as_ref().map(|u| u.version.clone()))
    }
}

/// Starts the automatic checks. Called once the control window is open, from the worker that
/// watched the backend come up; it never runs from the main thread and never blocks it. Once per
/// process: a start that is tried again after a failure comes back through here.
pub fn schedule(app: &AppHandle) {
    static SCHEDULED: Once = Once::new();
    SCHEDULED.call_once(|| {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FIRST_CHECK_DELAY);
            loop {
                check(handle.clone(), false);
                std::thread::sleep(CHECK_INTERVAL);
            }
        });
    });
}

/// One check. `asked` is true when the person picked the menu item, and it decides what silence
/// means: an automatic check that finds nothing, or fails, says nothing at all; a manual one
/// always answers, because a menu item that does nothing visible looks broken.
pub fn check(app: AppHandle, asked: bool) {
    if let Some(reason) = cannot_update_from_here() {
        // Trying again changes nothing until the app has moved, so the window offers no retry.
        if asked {
            show(&app, failed("Updates need Phosphor in Applications", &reason, false));
        }
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = match app.updater() {
            Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
            Err(err) => Err(err.to_string()),
        };
        let settle_on = app.clone();
        let _ = app.run_on_main_thread(move || settle(settle_on, result, asked));
    });
}

/// Runs on the main thread, where windows are made.
fn settle(app: AppHandle, result: Result<Option<Update>, String>, asked: bool) {
    match result {
        Err(err) => {
            eprintln!("phosphor: update check failed: {err}");
            if asked {
                show(&app, check_failed(&err));
            }
        }
        Ok(None) => {
            if asked {
                show(&app, serde_json::json!({ "state": "current", "version": app.package_info().version.to_string() }));
            }
        }
        Ok(Some(update)) => {
            let updates = app.state::<Updates>();
            if !asked && is_dismissed(updates.dismissed().as_deref(), &update.version) {
                return;
            }
            let payload = serde_json::json!({
                "state": "offer",
                "version": update.version,
                "current": update.current_version,
                "notes": update.body.as_deref().map(|n| clip(n.trim(), NOTES_LIMIT)).unwrap_or_default(),
            });
            updates.offer(update);
            show(&app, payload);
        }
    }
}

/// A failed state. The message is one plain sentence, a blank line, then the raw error, which
/// update.html splits so the sentence is what the window says and the error sits behind Details.
/// `retry` shows Try again, which asks update_retry.
fn failed(title: &str, message: &str, retry: bool) -> serde_json::Value {
    serde_json::json!({ "state": "failed", "title": title, "message": message, "retry": retry })
}

fn check_failed(err: &str) -> serde_json::Value {
    failed(
        "Could not check for updates",
        &format!("Phosphor could not reach its release feed. Check the connection, then try again.\n\n{err}"),
        true,
    )
}

/// Opens the update window on the given state, replacing one that is already open: a second
/// check while the first offer sits unanswered shows the newer answer, not two windows.
fn show(app: &AppHandle, payload: serde_json::Value) {
    if let Some(open) = app.get_webview_window(WINDOW) {
        let _ = open.close();
    }
    let script = format!("window.__PHOSPHOR_UPDATE__ = {};", init_literal(&payload));
    // The notes box is the one thing that changes the height: an offer with notes gets room
    // for them, everything else is a title, a line and the buttons.
    let has_notes = payload.get("notes").and_then(|n| n.as_str()).map(|n| !n.is_empty()).unwrap_or(false);
    let height = if has_notes { 340.0 } else { 204.0 };
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("update.html".into()))
        .title("Phosphor")
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .inner_size(480.0, height)
        .resizable(false)
        .minimizable(false)
        .center()
        .initialization_script(&script)
        .build();
    if let Err(err) = built {
        eprintln!("phosphor: cannot open the update window: {err}");
    }
}

/// The payload as a JavaScript literal. serde_json escapes every quote, backslash and line
/// break, so the notes, the one part that came from the network, arrive as string data. The
/// angle bracket is escaped on top of that: an initialization script is not parsed as HTML,
/// so a `</script>` in a note could not end anything, but the literal should not carry one
/// at all, and the cost is nothing.
pub(crate) fn init_literal(payload: &serde_json::Value) -> String {
    payload.to_string().replace('<', "\\u003c")
}

/// Install and relaunch, from the window's green button. Runs off the main thread; the window
/// is told how far the download is through eval, and the restart is handed back to the main
/// thread once the backend is down.
#[tauri::command]
pub fn update_install(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("not the update window".to_string());
    }
    let Some(update) = app.state::<Updates>().take() else {
        return Err("no update is pending".to_string());
    };
    tauri::async_runtime::spawn(async move {
        let outcome = install(&app, &update).await;
        let running = app.package_info().version.to_string();
        match outcome {
            Ok(()) => {
                let restart_on = app.clone();
                let _ = app.run_on_main_thread(move || restart_on.restart());
            }
            Err(Stop::Failed(err)) => {
                eprintln!("phosphor: update install failed: {err}");
                if let Some(win) = app.get_webview_window(WINDOW) {
                    let message = init_literal(&serde_json::json!(format!("Nothing changed: Phosphor {running} keeps running.\n\n{err}")));
                    // The second argument is Try again: it checks again, which offers the update
                    // afresh once whatever stopped it (a move still executing) has cleared.
                    let _ = win.eval(&format!("window.__phosphorFailed({message}, true)"));
                }
            }
            Err(Stop::Refused(err)) => {
                eprintln!("phosphor: update {} refused: {err}", update.version);
                // The same bytes would be refused again, so there is no Try again, and the clock
                // stops offering this version for the rest of the run, as if it was answered Later.
                app.state::<Updates>().dismiss(update.version.clone());
                if let Some(win) = app.get_webview_window(WINDOW) {
                    let (message, title) = refused(&running, &update.version, &err);
                    // No Try again (false); the fourth argument shows Open phosphor.money.
                    let _ = win.eval(&format!("window.__phosphorFailed({}, false, {}, true)", init_literal(&message), init_literal(&title)));
                }
            }
        }
    });
    Ok(())
}

/// The download page, from a refused update, in the system browser: the same fixed address and the
/// same way of opening it as the splash's altered state. Nothing the page sends picks the address.
#[tauri::command]
pub fn update_get_phosphor(window: tauri::Window) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("not the update window".to_string());
    }
    crate::open_download_page()
}

/// Why an install stopped. Either way nothing on disk changed.
#[derive(Debug)]
enum Stop {
    /// The update itself failed a check: its address, its minisign signature, its version, its
    /// archive or its code signature. The same bytes would fail the same way.
    Refused(String),
    /// Something on this Mac got in the way (a move executing, a folder that could not be
    /// written). Trying again can work.
    Failed(String),
}

/// What the window says about a refused update: calm, because nothing changed, where the offered
/// version can still be had, and the reason behind Details.
fn refused(running: &str, offered: &str, err: &str) -> (serde_json::Value, serde_json::Value) {
    (
        serde_json::json!(format!("Nothing changed: Phosphor {running} keeps running. You can get {offered} from phosphor.money.\n\n{err}")),
        serde_json::json!("The update did not pass its check"),
    )
}

/// The whole install, in the order the checks have to run. Anything that returns Err here has
/// changed nothing on disk: the swap is the last step and the plugin's own install is atomic
/// per bundle (rename out, rename in).
async fn install(app: &AppHandle, update: &Update) -> Result<(), Stop> {
    let running = app.package_info().version.to_string();
    let wanted = expected_url(&update.version);
    if update.download_url.as_str() != wanted {
        return Err(Stop::Refused(format!(
            "the update feed pointed somewhere other than the release for {}, so it was refused. Expected {wanted}, got {}.",
            update.version, update.download_url
        )));
    }

    let port = port_for(app).map_err(Stop::Failed)?;
    let token = app.state::<Backend>().handshake().map(|h| h.token.clone()).unwrap_or_default();
    executing_gate(get_health(port, &token).as_ref()).map_err(Stop::Failed)?;

    let progress_on = app.clone();
    let mut seen: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                seen += chunk as u64;
                if let (Some(total), Some(win)) = (total, progress_on.get_webview_window(WINDOW)) {
                    if total > 0 {
                        let _ = win.eval(&format!("window.__phosphorProgress({})", seen as f64 / total as f64));
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| match e {
            tauri_plugin_updater::Error::Minisign(_) | tauri_plugin_updater::Error::Base64(_) | tauri_plugin_updater::Error::SignatureUtf8(_) => {
                Stop::Refused(format!("the download did not verify: {e}"))
            }
            _ => Stop::Failed(format!("the download did not finish: {e}")),
        })?;

    // The bytes are minisign-checked by now. Everything else is checked before the swap. The code
    // signature check takes seconds, so the window says so instead of sitting on a full bar.
    tell(app, CHECKING);
    vet(&bytes, &update.version, &running, TEAMS)?;

    tell(app, INSTALLING);
    update.install(bytes).map_err(|e| Stop::Failed(format!("the app folder could not be replaced: {e}")))?;

    // The new bundle is on disk. Lock the wallet with a reason the audit log keeps, unless a move
    // started during the download (the check above is long past), then stop the backend the
    // graceful way (Backend::kill drains a write in flight before SIGKILL). The same stop a quit
    // takes: Backend::lock_and_stop.
    // Read again: a backend that restarted during the download has its own token.
    let token = app.state::<Backend>().handshake().map(|h| h.token.clone()).unwrap_or_default();
    app.state::<Backend>().lock_and_stop(Some(port), &token, "installing an update", |_| {});
    Ok(())
}

/// Whether installing may end the backend now, off its health. No answer is a backend that is not
/// running, so nothing of it can be cut mid-flight. An answer with no `executing` count is one
/// whose wallet half this shell could not read (health keeps it for a caller with the token), and
/// that waits rather than reading as zero.
fn executing_gate(health: Option<&serde_json::Value>) -> Result<(), String> {
    let Some(health) = health else { return Ok(()) };
    match health.get("executing").and_then(|e| e.as_u64()) {
        Some(0) => Ok(()),
        Some(executing) => Err(format!(
            "{executing} proposal(s) are executing right now. Installing ends the process, and a venue write cut mid-flight is the one thing an update must never do. Let them finish, then try again from Phosphor > Check for Updates."
        )),
        None => Err("Phosphor did not say whether a move is running, so the update waits. Try again from Phosphor > Check for Updates.".to_string()),
    }
}

/// What the update window shows while the install runs, past the download: the check, then the
/// swap. Each is one eval into the window, sent without waiting for the page.
const CHECKING: &str = "window.__phosphorChecking && window.__phosphorChecking()";
const INSTALLING: &str = "window.__phosphorInstalling && window.__phosphorInstalling()";

fn tell(app: &AppHandle, script: &str) {
    if let Some(win) = app.get_webview_window(WINDOW) {
        let _ = win.eval(script);
    }
}

pub(crate) fn port_for(app: &AppHandle) -> Result<u16, String> {
    let payload = crate::payload_dir(app)?;
    let data = crate::data_dir(app)?;
    Ok(configured_port(&payload, &data))
}

fn expected_url(version: &str) -> String {
    format!("{RELEASES}/v{version}/Phosphor_{version}_aarch64.app.tar.gz")
}

/// CFBundleShortVersionString out of the tarball the plugin verified: `Phosphor.app/Contents/
/// Info.plist`, and only at that depth, so a plist buried in a resource cannot answer for the
/// bundle. flate2, tar and plist are the crates the updater plugin and tauri already use to
/// read the same archive; nothing new enters the tree for this.
fn bundled_version(bytes: &[u8]) -> Result<String, String> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().map_err(|e| format!("the update is not a tar archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("the update archive is damaged: {e}"))?;
        let path = entry.path().map_err(|e| format!("the update archive is damaged: {e}"))?.into_owned();
        let parts: Vec<String> = path.iter().map(|c| c.to_string_lossy().into_owned()).collect();
        if parts.len() == 3 && parts[0].ends_with(".app") && parts[1] == "Contents" && parts[2] == "Info.plist" {
            let mut raw = Vec::new();
            entry.read_to_end(&mut raw).map_err(|e| format!("the update's Info.plist could not be read: {e}"))?;
            let value: plist::Value = plist::from_bytes(&raw).map_err(|e| format!("the update's Info.plist is not a plist: {e}"))?;
            return value
                .as_dictionary()
                .and_then(|d| d.get("CFBundleShortVersionString"))
                .and_then(|v| v.as_string())
                .map(str::to_string)
                .ok_or_else(|| "the update's Info.plist carries no version".to_string());
        }
    }
    Err("the update carries no app bundle".to_string())
}

/// Everything the install checks in the downloaded bytes, after the plugin's minisign check and
/// before anything on disk is replaced: the version the bundle carries, then its archive and its
/// code signature. `teams` is TEAMS everywhere but the tests.
fn vet(bytes: &[u8], announced: &str, running: &str, teams: &[&str]) -> Result<(), Stop> {
    let inside = bundled_version(bytes).map_err(Stop::Refused)?;
    if inside != announced || !newer(&inside, running) {
        return Err(Stop::Refused(format!(
            "the feed called this update {announced} but the signed bundle inside is {inside}, and Phosphor is on {running}. A bundle that is not exactly the version it was announced as, or not newer than what is running, is never installed."
        )));
    }
    let scratch = Scratch::new().map_err(Stop::Failed)?;
    let app = unpack(bytes, scratch.path())?;
    check_signature(&app, teams).map_err(Stop::Refused)
}

/// The code requirement an update must pass: Apple's own designated requirement for a Developer
/// ID app (Apple's anchor, the Developer ID intermediate, a Developer ID Application leaf), this
/// app's identifier, and a team from `teams`. Ad-hoc, unsigned, Apple Development, App Store and
/// other teams' signatures all fail it.
fn requirement(teams: &[&str]) -> String {
    let teams: Vec<String> = teams.iter().map(|team| format!("certificate leaf[subject.OU] = \"{team}\"")).collect();
    format!(
        "identifier \"{IDENTIFIER}\" and anchor apple generic \
         and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ \
         and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ \
         and ({})",
        teams.join(" or ")
    )
}

/// The unpacked bundle's code signature, checked the way `codesign --verify --deep --strict`
/// checks it, against `requirement(teams)`: every architecture, nested code (the node sidecar,
/// the Secure Enclave service) validated in full, no link pointing out of the bundle.
#[cfg(target_os = "macos")]
fn check_signature(app: &Path, teams: &[&str]) -> Result<(), String> {
    use core_foundation::url::CFURL;
    use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};

    let requirement: SecRequirement = requirement(teams).parse().map_err(|e| format!("the update requirement does not compile: {e}"))?;
    let url = CFURL::from_path(app, true).ok_or_else(|| format!("{} cannot be opened as a bundle", app.display()))?;
    let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|e| format!("the update's code signature cannot be read: {e}"))?;
    let flags = Flags::CHECK_ALL_ARCHITECTURES | Flags::CHECK_NESTED_CODE | Flags::STRICT_VALIDATE | Flags::RESTRICT_SYMLINKS;
    code.check_validity(flags, &requirement)
        .map_err(|e| format!("the update is not signed as Phosphor ({e}), so it was refused"))
}

#[cfg(not(target_os = "macos"))]
fn check_signature(_app: &Path, _teams: &[&str]) -> Result<(), String> {
    Err("updates are checked and installed on macOS only".to_string())
}

/// Unpacks the minisign-checked tarball into `into`, an empty private folder, and returns the
/// app bundle in it. The plugin unpacks the same bytes again for the swap with tar's plain
/// `unpack`, which follows a `..` or a link wherever it points, so an archive is refused here
/// unless both unpacks land the same files in the same places: one top folder named *.app,
/// plain relative paths, only files, folders and links, nothing written through a link, and no
/// path twice. A refusal comes before the entry it is about is written.
fn unpack(bytes: &[u8], into: &Path) -> Result<PathBuf, Stop> {
    let bad = |what: String| Stop::Refused(format!("the update archive {what}, so it was refused"));
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut top: Option<String> = None;
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut links: Vec<PathBuf> = Vec::new();
    for entry in archive.entries().map_err(|e| bad(format!("cannot be read ({e})")))? {
        let mut entry = entry.map_err(|e| bad(format!("is damaged ({e})")))?;
        let path = entry.path().map_err(|e| bad(format!("is damaged ({e})")))?.into_owned();
        if !path.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(bad(format!("holds a path that leaves its folder: {}", path.display())));
        }
        let first = path.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
        match &top {
            None if first.ends_with(".app") => top = Some(first),
            None => return Err(bad(format!("starts with {first}, not an app bundle"))),
            Some(app) if *app != first => return Err(bad(format!("holds {first} beside {app}"))),
            Some(_) => {}
        }
        // Compared without case, because the volume Applications sits on usually ignores it.
        let key = PathBuf::from(path.to_string_lossy().to_ascii_lowercase());
        if links.iter().any(|link| key.starts_with(link)) {
            return Err(bad(format!("writes {} through a link", path.display())));
        }
        if !seen.insert(key.clone()) {
            return Err(bad(format!("holds {} twice", path.display())));
        }
        match entry.header().entry_type() {
            tar::EntryType::Regular | tar::EntryType::Directory => {}
            tar::EntryType::Symlink => links.push(key),
            other => return Err(bad(format!("holds a {other:?} entry at {}", path.display()))),
        }
        match entry.unpack_in(into) {
            Ok(true) => {}
            Ok(false) => return Err(bad(format!("holds a path that leaves its folder: {}", path.display()))),
            Err(e) => return Err(Stop::Failed(format!("the update could not be unpacked to be checked: {e}"))),
        }
    }
    let app = top.ok_or_else(|| bad("is empty".to_string()))?;
    Ok(into.join(app))
}

/// A private folder in the user's temporary directory, gone when this is dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        use std::os::unix::fs::DirBuilderExt;
        use std::sync::atomic::{AtomicU64, Ordering};
        static MADE: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
        let made = MADE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("phosphor-update-{}-{nanos}-{made}", std::process::id()));
        // `create`, not `create_all`: a path that already exists is not ours to use.
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|e| format!("could not make a folder to check the update in: {e}"))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if std::fs::remove_dir_all(&self.0).is_err() {
            // An archive can unpack a folder with no write permission, which keeps what is in it.
            open_up(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn open_up(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            open_up(&entry.path());
        }
    }
}

/// Plain MAJOR.MINOR.PATCH, the only shape the release tags take (tests/unit/version-agrees
/// .test.ts refuses anything else), compared numerically. Anything unparseable is not newer.
fn newer(candidate: &str, running: &str) -> bool {
    match (parse_version(candidate), parse_version(running)) {
        (Some(c), Some(r)) => c > r,
        _ => false,
    }
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.trim().trim_start_matches('v').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Later, Close, or Escape. An offer answered Later is remembered for this run.
#[tauri::command]
pub fn update_dismiss(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("not the update window".to_string());
    }
    let updates = app.state::<Updates>();
    if let Some(version) = updates.pending_version() {
        updates.dismiss(version);
    }
    let _ = updates.take();
    let _ = window.close();
    Ok(())
}

/// Try again, from a failed check or a failed install: the check runs again as if the menu item
/// had been picked, so it always answers, and its answer replaces this window.
#[tauri::command]
pub fn update_retry(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("not the update window".to_string());
    }
    check(app, true);
    Ok(())
}

/// An app opened straight off the disk image runs from a read-only volume, and the swap would
/// fail with a filesystem error that says nothing a person can act on. Say the fix instead.
fn cannot_update_from_here() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    if runs_from_a_volume(&exe) {
        return Some(
            "Phosphor is running from the disk image or an external disk, where it cannot replace \
             itself. Drag Phosphor into Applications and open it from there."
                .to_string(),
        );
    }
    path_breaks_quoting(&exe).then(|| {
        "Phosphor is in a folder whose name holds a quote mark or a backslash, where the update \
         cannot replace it safely. Drag Phosphor into Applications and open it from there."
            .to_string()
    })
}

fn runs_from_a_volume(exe: &Path) -> bool {
    exe.starts_with("/Volumes")
}

/// The updater plugin's admin fallback (tauri-plugin-updater 2.11.0, install_inner) writes the
/// app's path into a shell line run as root, and a quote mark or a backslash in that path breaks
/// out of it (re-audit R-L12). Such a path is never offered an update.
fn path_breaks_quoting(exe: &Path) -> bool {
    exe.to_string_lossy().chars().any(|c| matches!(c, '\'' | '"' | '\\'))
}

fn is_dismissed(dismissed: Option<&str>, version: &str) -> bool {
    dismissed == Some(version)
}

/// Cuts on a character boundary, never inside a multibyte character, and says that it cut.
fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut kept: String = text.chars().take(limit).collect();
    kept.push_str("...");
    kept
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_version, check_failed, clip, executing_gate, expected_url, failed, init_literal, is_dismissed, newer, path_breaks_quoting, refused, requirement, runs_from_a_volume, unpack, vet,
        Scratch, Stop, IDENTIFIER, NOTES_LIMIT, TEAMS,
    };
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    #[test]
    fn an_install_waits_unless_health_says_nothing_is_executing() {
        assert!(executing_gate(None).is_ok(), "no backend running, nothing to cut");
        assert!(executing_gate(Some(&serde_json::json!({ "ok": true, "executing": 0 }))).is_ok());
        let busy = executing_gate(Some(&serde_json::json!({ "ok": true, "executing": 2 }))).unwrap_err();
        assert!(busy.starts_with("2 proposal(s) are executing right now."), "{busy}");
        // Health without a credential says only that the app is alive. That is not zero.
        let unread = executing_gate(Some(&serde_json::json!({ "ok": true, "version": "0.10.13", "uptimeSec": 9 }))).unwrap_err();
        assert!(unread.contains("did not say whether a move is running"), "{unread}");
    }

    #[test]
    fn a_failed_check_keeps_its_sentence_apart_from_the_raw_error_and_offers_try_again() {
        let payload = check_failed("error sending request for url (https://github.com/...): dns error");
        assert_eq!(payload["state"], "failed");
        assert_eq!(payload["retry"], true);
        let message = payload["message"].as_str().unwrap();
        let (sentence, raw) = message.split_once("\n\n").expect("a sentence, a blank line, then the error");
        assert_eq!(sentence, "Phosphor could not reach its release feed. Check the connection, then try again.");
        assert!(raw.starts_with("error sending request"));
        assert!(!sentence.contains("later"), "Try again is right there, so the sentence does not send the person away");
        // A failure that trying again cannot fix offers no Try again.
        assert_eq!(failed("Updates need Phosphor in Applications", "Drag it in.", false)["retry"], false);
    }

    #[test]
    fn a_version_answered_later_is_not_offered_again_by_the_clock() {
        assert!(is_dismissed(Some("0.4.1"), "0.4.1"));
        assert!(!is_dismissed(Some("0.4.1"), "0.4.2"));
        assert!(!is_dismissed(None, "0.4.1"));
    }

    #[test]
    fn long_notes_are_clipped_on_a_character_boundary() {
        let notes = "é".repeat(NOTES_LIMIT + 50);
        let clipped = clip(&notes, NOTES_LIMIT);
        assert_eq!(clipped.chars().count(), NOTES_LIMIT + 3);
        assert!(clipped.ends_with("..."));
        assert_eq!(clip("short", NOTES_LIMIT), "short");
    }

    #[test]
    fn notes_from_the_network_cannot_break_out_of_the_init_script() {
        // The payload is serialised with serde_json, so a note carrying a quote, a script tag
        // or a line break arrives as string data, never as script.
        let notes = "</script><script>alert(1)</script>\n\"; window.x = 1; //";
        let payload = serde_json::json!({ "state": "offer", "notes": notes });
        let literal = init_literal(&payload);
        assert!(!literal.contains('<'));
        assert!(!literal.contains('\n'));
        let back: serde_json::Value = serde_json::from_str(&literal).unwrap();
        assert_eq!(back["notes"], notes);
    }

    #[test]
    fn a_disk_image_is_recognised_by_its_mount_point() {
        assert!(runs_from_a_volume(Path::new("/Volumes/Phosphor/Phosphor.app/Contents/MacOS/phosphor-desktop")));
        assert!(!runs_from_a_volume(Path::new("/Applications/Phosphor.app/Contents/MacOS/phosphor-desktop")));
        assert!(!runs_from_a_volume(Path::new("/Users/k/Volumes/Phosphor.app/Contents/MacOS/phosphor-desktop")));
    }

    #[test]
    fn a_path_that_would_break_the_admin_install_line_is_never_offered_an_update() {
        for path in [
            "/Applications/x'; touch \"/tmp/owned\"; '/Phosphor.app/Contents/MacOS/phosphor-desktop",
            "/Users/k/Karim's Apps/Phosphor.app/Contents/MacOS/phosphor-desktop",
            "/Users/k/a\"b/Phosphor.app/Contents/MacOS/phosphor-desktop",
            "/Users/k/a\\b/Phosphor.app/Contents/MacOS/phosphor-desktop",
        ] {
            assert!(path_breaks_quoting(Path::new(path)), "{path}");
        }
        assert!(!path_breaks_quoting(Path::new("/Applications/Phosphor.app/Contents/MacOS/phosphor-desktop")));
        assert!(!path_breaks_quoting(Path::new("/Users/k/My Apps (old)/Phosphor.app/Contents/MacOS/phosphor-desktop")));
    }

    #[test]
    fn only_the_versioned_github_asset_is_a_download() {
        assert_eq!(
            expected_url("0.4.2"),
            "https://github.com/karimbabasf/phosphor/releases/download/v0.4.2/Phosphor_0.4.2_aarch64.app.tar.gz"
        );
    }

    #[test]
    fn newer_means_numerically_greater_plain_semver_and_nothing_else() {
        assert!(newer("0.4.2", "0.4.1"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("1.0.0", "0.99.99"));
        assert!(!newer("0.4.1", "0.4.1"));
        assert!(!newer("0.4.0", "0.4.1"));
        assert!(!newer("0.4.2-beta", "0.4.1"));
        assert!(!newer("garbage", "0.4.1"));
        assert!(!newer("0.4.2", "garbage"));
    }

    fn tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *data).unwrap();
        }
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    fn info_plist(version: &str) -> Vec<u8> {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>\n"
        )
        .into_bytes()
    }

    #[test]
    fn the_version_is_read_from_the_bundle_inside_the_verified_tarball() {
        let bytes = tarball(&[
            ("Phosphor.app/Contents/Resources/phosphor/Info.plist", &info_plist("9.9.9")),
            ("Phosphor.app/Contents/Info.plist", &info_plist("0.4.2")),
        ]);
        assert_eq!(bundled_version(&bytes).unwrap(), "0.4.2");
    }

    #[test]
    fn a_bundle_with_no_info_plist_at_the_top_is_refused() {
        let bytes = tarball(&[("Phosphor.app/Contents/Resources/phosphor/Info.plist", &info_plist("0.4.2"))]);
        assert!(bundled_version(&bytes).unwrap_err().contains("no app bundle"));
        assert!(bundled_version(b"not a tarball at all").is_err());
    }

    #[test]
    fn an_old_signed_bundle_announced_as_new_is_caught_by_the_version_inside() {
        // The rollback: the feed says 0.9.0, the download URL is forged to match, but the bytes
        // are the 0.4.0 bundle, still validly signed. The plist inside says 0.4.0, and that is
        // what the install compares.
        let bytes = tarball(&[("Phosphor.app/Contents/Info.plist", &info_plist("0.4.0"))]);
        let inside = bundled_version(&bytes).unwrap();
        let announced = "0.9.0";
        let running = "0.4.1";
        assert!(inside != announced || !newer(&inside, running));
        assert!(matches!(vet(&bytes, announced, running, TEAMS), Err(Stop::Refused(_))));
    }

    // The code signature check. The bundles here are built in a temporary folder: a tiny app
    // whose executable is a copy of /usr/bin/true, signed ad-hoc or not at all. The one bundle
    // that passes is a real release, which lives outside the repo (see `sample`).

    fn run(program: impl AsRef<std::ffi::OsStr>, args: &[&std::ffi::OsStr], env: &[(&str, &str)]) -> Vec<u8> {
        let out = Command::new(program.as_ref()).args(args).envs(env.iter().copied()).output().expect("the tool runs");
        assert!(out.status.success(), "{:?} {:?} failed: {}", program.as_ref(), args, String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    fn os(text: &str) -> &std::ffi::OsStr {
        std::ffi::OsStr::new(text)
    }

    fn unbase64(text: &[u8]) -> String {
        let mut child = Command::new("base64").arg("-d").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(text).unwrap();
        let out = child.wait_with_output().unwrap();
        String::from_utf8(out.stdout).unwrap()
    }

    fn app_plist(version: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\
             <key>CFBundleIdentifier</key><string>{IDENTIFIER}</string><key>CFBundleExecutable</key><string>Phosphor</string>\
             <key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>{version}</string>\
             <key>CFBundleVersion</key><string>{version}</string></dict></plist>\n"
        )
    }

    /// Phosphor.app in `dir`, unsigned: the copied executable has its Apple signature removed.
    fn tiny_app(dir: &Path, version: &str) -> PathBuf {
        let app = dir.join("Phosphor.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/Info.plist"), app_plist(version)).unwrap();
        let exe = app.join("Contents/MacOS/Phosphor");
        std::fs::copy("/usr/bin/true", &exe).unwrap();
        run("codesign", &[os("--remove-signature"), exe.as_os_str()], &[]);
        app
    }

    /// The bundle as a gzipped tar whose one top entry is Phosphor.app, the release's shape.
    fn tar_app(app: &Path) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        builder.follow_symlinks(false);
        builder.append_dir_all("Phosphor.app", app).unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&builder.into_inner().unwrap()).unwrap();
        gz.finish().unwrap()
    }

    /// Signs `bytes` with a throwaway key from Tauri's own CLI (the repo's devDependency, what
    /// releases were signed with until 0.10.13) and checks the signature with the verifier the
    /// updater plugin runs, the way `Update::download` runs it. Past this, the bytes are what an
    /// attacker holding the minisign key could serve.
    fn assert_minisign_valid(bytes: &[u8], dir: &Path) {
        let (cli, key, public) = throwaway_key(dir);
        let file = dir.join("update.app.tar.gz");
        std::fs::write(&file, bytes).unwrap();
        run(&cli, &[os("signer"), os("sign"), os("-f"), key.as_os_str(), file.as_os_str()], &[("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")]);
        let signature = minisign_verify::Signature::decode(&unbase64(&std::fs::read(dir.join("update.app.tar.gz.sig")).unwrap())).unwrap();
        public.verify(bytes, &signature, true).expect("the plugin's verifier accepts the signature");
    }

    /// A key with no password from `tauri signer generate`, and its public half as the plugin
    /// reads one.
    fn throwaway_key(dir: &Path) -> (PathBuf, PathBuf, minisign_verify::PublicKey) {
        let cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules/.bin/tauri");
        assert!(cli.exists(), "{} is missing: run npm ci at the repo root first", cli.display());
        let key = dir.join("throwaway.key");
        run(&cli, &[os("signer"), os("generate"), os("--ci"), os("-p"), os(""), os("-w"), key.as_os_str()], &[]);
        let public = minisign_verify::PublicKey::decode(&unbase64(&std::fs::read(dir.join("throwaway.key.pub")).unwrap())).unwrap();
        (cli, key, public)
    }

    #[test]
    fn the_release_signer_makes_signatures_the_plugin_accepts() {
        // scripts/updater-sign.ts signs releases with Node alone; this is the plugin's own check
        // of what it writes.
        let dir = Scratch::new().unwrap();
        let (_, key, public) = throwaway_key(dir.path());
        let file = dir.path().join("Phosphor.app.tar.gz");
        let bytes = tar_app(&tiny_app(dir.path(), "0.10.13"));
        std::fs::write(&file, &bytes).unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/updater-sign.ts");
        let public_path = dir.path().join("throwaway.key.pub");
        run(
            "node",
            &[script.as_os_str(), file.as_os_str(), os("--public-key"), public_path.as_os_str()],
            &[("TAURI_SIGNING_PRIVATE_KEY", key.to_str().unwrap()), ("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")],
        );
        let signature = minisign_verify::Signature::decode(&unbase64(&std::fs::read(dir.path().join("Phosphor.app.tar.gz.sig")).unwrap())).unwrap();
        public.verify(&bytes, &signature, true).expect("the plugin's verifier accepts the release signer");
        let mut changed = bytes.clone();
        changed.push(0);
        assert!(public.verify(&changed, &signature, true).is_err());
    }

    fn refusal(outcome: Result<(), Stop>) -> String {
        match outcome {
            Err(Stop::Refused(why)) => why,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn the_requirement_is_apples_developer_id_requirement_for_this_app_and_the_team_set() {
        let one = requirement(&["35Z6P26CBD"]);
        // Byte for byte what codesign prints as the designated requirement of the 0.10.12
        // release, but for the brackets around the team clause.
        assert_eq!(
            one,
            "identifier \"com.karimbabasf.phosphor\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ \
             and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and (certificate leaf[subject.OU] = \"35Z6P26CBD\")"
        );
        let two = requirement(&["35Z6P26CBD", "ABCDE12345"]);
        assert!(two.ends_with("(certificate leaf[subject.OU] = \"35Z6P26CBD\" or certificate leaf[subject.OU] = \"ABCDE12345\")"));
        for text in [one, two, requirement(TEAMS)] {
            text.parse::<security_framework::os::macos::code_signing::SecRequirement>().expect("Security compiles the requirement");
        }
        assert!(TEAMS.contains(&"35Z6P26CBD"));
        assert!(TEAMS.iter().all(|team| team.len() == 10 && team.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())));
    }

    #[test]
    fn the_release_gate_holds_each_release_to_this_requirement() {
        // The release workflow checks the updater bundle with codesign against the same text,
        // so a release this check would refuse never ships.
        let workflow = include_str!("../../.github/workflows/release.yml");
        let (_, rest) = workflow.split_once("--test-requirement='=").expect("the release gate tests the update requirement");
        let (gate, _) = rest.split_once('\'').unwrap();
        assert_eq!(gate, requirement(TEAMS));
    }

    #[test]
    fn an_ad_hoc_signed_bundle_that_passes_minisign_is_refused() {
        let dir = Scratch::new().unwrap();
        let app = tiny_app(dir.path(), "0.10.13");
        run("codesign", &[os("-s"), os("-"), os("-f"), app.as_os_str()], &[]);
        run("codesign", &[os("--verify"), os("--strict"), app.as_os_str()], &[]);
        let bytes = tar_app(&app);
        assert_minisign_valid(&bytes, dir.path());
        let why = refusal(vet(&bytes, "0.10.13", "0.10.12", TEAMS));
        assert!(why.contains("not signed as Phosphor"), "{why}");
    }

    #[test]
    fn an_unsigned_bundle_is_refused() {
        let dir = Scratch::new().unwrap();
        let app = tiny_app(dir.path(), "0.10.13");
        let why = refusal(vet(&tar_app(&app), "0.10.13", "0.10.12", TEAMS));
        assert!(why.contains("not signed as Phosphor"), "{why}");
    }

    #[test]
    fn a_refusal_says_nothing_changed_and_keeps_the_reason_behind_details() {
        let (message, title) = refused("0.10.12", "0.10.13", "the update is not signed as Phosphor");
        assert_eq!(title, "The update did not pass its check");
        let (sentence, raw) = message.as_str().unwrap().split_once("\n\n").unwrap();
        assert_eq!(sentence, "Nothing changed: Phosphor 0.10.12 keeps running. You can get 0.10.13 from phosphor.money.");
        assert_eq!(raw, "the update is not signed as Phosphor");
    }

    /// A tar written header by header, names and links exactly as given: tar's own builder
    /// refuses `..`, which is the point of some of these.
    fn raw_tar(entries: &[(&str, tar::EntryType, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, kind, link) in entries {
            let mut header = tar::Header::new_old();
            header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
            header.as_old_mut().linkname[..link.len()].copy_from_slice(link.as_bytes());
            header.set_entry_type(*kind);
            header.set_mode(0o755);
            let data: &[u8] = if *kind == tar::EntryType::Regular { b"x" } else { b"" };
            header.set_size(data.len() as u64);
            header.set_cksum();
            builder.append(&header, data).unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&builder.into_inner().unwrap()).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn an_archive_that_could_unpack_two_ways_is_refused_before_it_writes_outside_its_folder() {
        use tar::EntryType::{Directory, Link, Regular, Symlink};
        let file = "Phosphor.app/Contents/Info.plist";
        let cases: Vec<(&str, Vec<(&str, tar::EntryType, &str)>, &str)> = vec![
            ("a parent step", vec![(file, Regular, ""), ("Phosphor.app/../../escaped-parent", Regular, "")], "leaves its folder"),
            ("an absolute path", vec![("/tmp/phosphor-escaped-absolute", Regular, "")], "leaves its folder"),
            ("a second top folder", vec![(file, Regular, ""), ("Other.app/Contents/Info.plist", Regular, "")], "beside Phosphor.app"),
            ("no app at the top", vec![("Phosphor/Contents/Info.plist", Regular, "")], "not an app bundle"),
            ("a write through a link", vec![("Phosphor.app/Contents/L", Symlink, "/tmp"), ("Phosphor.app/Contents/L/escaped-link", Regular, "")], "through a link"),
            ("a link by another case", vec![("Phosphor.app/Contents/L", Symlink, "/tmp"), ("Phosphor.app/contents/l/escaped-case", Regular, "")], "through a link"),
            ("a hard link", vec![(file, Regular, ""), ("Phosphor.app/Contents/hard", Link, "/etc/hosts")], "Link"),
            ("a path twice", vec![(file, Regular, ""), (file, Regular, "")], "twice"),
            ("a folder entry twice by case", vec![("Phosphor.app/Contents/", Directory, ""), ("Phosphor.app/CONTENTS/", Directory, "")], "twice"),
        ];
        for (what, entries, expected) in cases {
            let scratch = Scratch::new().unwrap();
            let into = scratch.path().join("in");
            std::fs::create_dir(&into).unwrap();
            let why = match unpack(&raw_tar(&entries), &into) {
                Err(Stop::Refused(why)) => why,
                other => panic!("{what}: expected a refusal, got {other:?}"),
            };
            assert!(why.contains(expected), "{what}: {why}");
            assert!(!scratch.path().join("escaped-parent").exists(), "{what}");
            assert!(!Path::new("/tmp/phosphor-escaped-absolute").exists(), "{what}");
            assert!(!Path::new("/tmp/escaped-link").exists() && !Path::new("/tmp/escaped-case").exists(), "{what}");
        }

        // The control: the release's own shape unpacks, and the bundle is where it says.
        let scratch = Scratch::new().unwrap();
        let app = tiny_app(scratch.path(), "0.10.13");
        let into = scratch.path().join("in");
        std::fs::create_dir(&into).unwrap();
        let unpacked = unpack(&tar_app(&app), &into).unwrap();
        assert_eq!(unpacked, into.join("Phosphor.app"));
        assert!(unpacked.join("Contents/Info.plist").is_file());
    }

    #[test]
    fn the_folder_an_update_is_checked_in_is_private_and_goes_away() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new().unwrap();
        let path = scratch.path().to_path_buf();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::write(path.join("inside"), b"x").unwrap();
        // A folder an archive left with no write permission still goes.
        std::fs::create_dir_all(path.join("Phosphor.app/Contents")).unwrap();
        std::fs::write(path.join("Phosphor.app/Contents/kept"), b"x").unwrap();
        std::fs::set_permissions(path.join("Phosphor.app/Contents"), std::fs::Permissions::from_mode(0o555)).unwrap();
        drop(scratch);
        assert!(!path.exists());
    }

    /// Published updater bundles, the one sample of a correct Developer ID signature, which the
    /// repo cannot hold. Fetch one or more and point PHOSPHOR_UPDATE_SAMPLE at them, separated by
    /// colons, each with its .sig beside it:
    ///
    ///   gh release download v0.10.12 --repo karimbabasf/phosphor --pattern 'Phosphor_0.10.12_aarch64.app.tar.gz*'
    ///   gh release download v0.10.13 --repo karimbabasf/phosphor --pattern 'Phosphor_0.10.13_aarch64.app.tar.gz*'
    ///   PHOSPHOR_UPDATE_SAMPLE=$PWD/Phosphor_0.10.12_aarch64.app.tar.gz:$PWD/Phosphor_0.10.13_aarch64.app.tar.gz \
    ///     cargo test sample -- --ignored --nocapture
    fn samples() -> Vec<(String, Vec<u8>, String)> {
        let paths = std::env::var("PHOSPHOR_UPDATE_SAMPLE").expect("PHOSPHOR_UPDATE_SAMPLE names published .app.tar.gz files");
        paths
            .split(':')
            .filter(|path| !path.is_empty())
            .map(|path| {
                let bytes = std::fs::read(path).expect("the sample is readable");
                let signature = std::fs::read(format!("{path}.sig")).expect("the sample's .sig sits beside it");
                (path.to_string(), bytes, unbase64(&signature))
            })
            .collect()
    }

    #[test]
    #[ignore = "needs PHOSPHOR_UPDATE_SAMPLE, a published release (see `samples`)"]
    fn sample_a_published_release_passes_minisign_with_the_shipped_key_and_its_code_signature() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let shipped = unbase64(conf["plugins"]["updater"]["pubkey"].as_str().unwrap().as_bytes());
        let public = minisign_verify::PublicKey::decode(&shipped).unwrap();
        let samples = samples();
        for (path, bytes, signature) in &samples {
            let signature = minisign_verify::Signature::decode(signature).unwrap();
            public.verify(bytes, &signature, true).expect("signed by the release key");
            let mut changed = bytes.clone();
            changed[bytes.len() / 2] ^= 1;
            assert!(public.verify(&changed, &signature, true).is_err(), "{path}: one changed byte fails");
            let inside = bundled_version(bytes).unwrap();
            let started = std::time::Instant::now();
            vet(bytes, &inside, "0.0.1", TEAMS).expect("Phosphor's own release passes");
            eprintln!("{path}: minisign ok, vet: {inside}, {} MB, {} ms", bytes.len() / 1_000_000, started.elapsed().as_millis());
        }
        // A release's signature is its own: it never passes another release's bytes.
        for (signed, (_, _, signature)) in samples.iter().enumerate() {
            let signature = minisign_verify::Signature::decode(signature).unwrap();
            for (other, (path, bytes, _)) in samples.iter().enumerate() {
                if other != signed {
                    assert!(public.verify(bytes, &signature, true).is_err(), "{path} passed another release's signature");
                }
            }
        }
    }

    #[test]
    #[ignore = "needs PHOSPHOR_UPDATE_SAMPLE, a published release (see `samples`)"]
    fn sample_the_same_release_is_refused_when_its_team_is_not_in_the_set() {
        for (_, bytes, _) in samples() {
            let inside = bundled_version(&bytes).unwrap();
            let why = refusal(vet(&bytes, &inside, "0.0.1", &["ABCDE12345"]));
            assert!(why.contains("not signed as Phosphor"), "{why}");
        }
    }
}
