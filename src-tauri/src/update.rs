// Updates: found on a schedule, installed by a click.
//
// The control window has no IPC bridge on purpose (see main.rs), so nothing about updates goes
// through the page. The check runs in this shell, the offer is a window of the shell's own
// (frontend/update.html, served by Tauri like the splash), the manual check is a native menu
// item, and the control page never learns any of it. The update window is the one webview
// with commands, exactly two: install and dismiss. Both refuse a caller that is not that
// window, and a remote page cannot reach app commands at the ACL anyway.
//
// What the plugin does, and why it is the one thing here that is not hand-rolled: it fetches
// latest.json over TLS from the endpoints in tauri.conf.json, takes the entry for this OS and
// architecture, downloads the bundle, verifies its minisign signature against the public key
// compiled in from the same file, and installs only a version greater than the one running. An
// endpoint that is captured can therefore withhold updates, never push one, and never roll one
// back. A homemade version of that check is exactly the bug an attacker wants.
//
// Installing swaps /Applications/Phosphor.app for the new bundle and relaunches. The backend is
// stopped first, through Backend::kill, because AppHandle::restart on the main thread exits the
// process without raising RunEvent::Exit: the run loop's kill would never fire and the old node
// would stay up on the port, and the new shell would refuse to open a window onto a backend it
// did not start. Taking the child out of Backend also tells the supervisor thread that this stop
// was meant, so it does not respawn the backend under the feet of the restart.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::backend::Backend;

pub const CHECK_ID: &str = "check-for-updates";
const WINDOW: &str = "update";

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
/// watched the backend come up; it never runs from the main thread and never blocks it.
pub fn schedule(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            check(handle.clone(), false);
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

/// One check. `asked` is true when the person picked the menu item, and it decides what silence
/// means: an automatic check that finds nothing, or fails, says nothing at all; a manual one
/// always answers, because a menu item that does nothing visible looks broken.
pub fn check(app: AppHandle, asked: bool) {
    if let Some(reason) = cannot_update_from_here() {
        if asked {
            show(&app, failed("Updates need Phosphor in Applications", &reason));
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
                show(
                    &app,
                    failed(
                        "Could not check for updates",
                        &format!("Phosphor could not reach its release feed. Try again later.\n\n{err}"),
                    ),
                );
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

fn failed(title: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "state": "failed", "title": title, "message": message })
}

/// Opens the update window on the given state, replacing one that is already open: a second
/// check while the first offer sits unanswered shows the newer answer, not two windows.
fn show(app: &AppHandle, payload: serde_json::Value) {
    if let Some(open) = app.get_webview_window(WINDOW) {
        let _ = open.close();
    }
    let colourway = crate::data_dir(app)
        .ok()
        .and_then(|data| crate::saved_colourway(&data))
        .unwrap_or("green-on-black");
    let script = format!(
        "window.__PHOSPHOR_PROFILE__ = \"{colourway}\"; window.__PHOSPHOR_UPDATE__ = {};",
        init_literal(&payload)
    );
    // The notes box is the one thing that changes the height: an offer with notes gets room
    // for them, everything else is a title, a line and the buttons.
    let has_notes = payload.get("notes").and_then(|n| n.as_str()).map(|n| !n.is_empty()).unwrap_or(false);
    let height = if has_notes { 300.0 } else { 204.0 };
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
fn init_literal(payload: &serde_json::Value) -> String {
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
        let progress_on = app.clone();
        let mut seen: u64 = 0;
        let installed = update
            .download_and_install(
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
            .await;
        match installed {
            Ok(()) => {
                app.state::<Backend>().kill();
                let restart_on = app.clone();
                let _ = app.run_on_main_thread(move || restart_on.restart());
            }
            Err(err) => {
                eprintln!("phosphor: update install failed: {err}");
                if let Some(win) = app.get_webview_window(WINDOW) {
                    let message = serde_json::json!(format!(
                        "Nothing changed: Phosphor {} keeps running. The download is verified before anything \
                         is replaced, so a failure here means the update was refused or the app folder could \
                         not be written.\n\n{err}",
                        app.package_info().version
                    ));
                    let _ = win.eval(&format!("window.__phosphorFailed({message})"));
                }
            }
        }
    });
    Ok(())
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

/// An app opened straight off the disk image runs from a read-only volume, and the swap would
/// fail with a filesystem error that says nothing a person can act on. Say the fix instead.
fn cannot_update_from_here() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    runs_from_a_volume(&exe).then(|| {
        "Phosphor is running from the disk image or an external disk, where it cannot replace \
         itself. Drag Phosphor into Applications and open it from there."
            .to_string()
    })
}

fn runs_from_a_volume(exe: &Path) -> bool {
    exe.starts_with("/Volumes")
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
    use super::{clip, init_literal, is_dismissed, runs_from_a_volume, NOTES_LIMIT};
    use std::path::Path;

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
}
