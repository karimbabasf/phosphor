// Updates: found on a schedule, installed by a click.
//
// The control window has no IPC bridge on purpose (see main.rs), so nothing about updates goes
// through the page. The check runs in this shell, the offer is a native dialog, the manual check
// is a native menu item, and the page never learns any of it. That keeps the update path on the
// same side of the trust boundary as the menu: a compromised page cannot ask for an install, and
// cannot stop one either.
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

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::backend::Backend;

pub const CHECK_ID: &str = "check-for-updates";

/// The first automatic check waits for the window to be up and the person to be past the
/// splash; the ones after it are far enough apart that a release is seen the same day without
/// the app ever polling like a client that wants attention.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Release notes are for a release page. The dialog gets the opening of them, enough to know
/// what changed, and the rest stays on GitHub.
const NOTES_LIMIT: usize = 600;

/// The version the person answered Later to. The automatic check stays quiet about that version
/// for the rest of this run; the menu item still offers it, because asking is consent.
#[derive(Default)]
pub struct Dismissed(Mutex<Option<String>>);

impl Dismissed {
    fn get(&self) -> Option<String> {
        self.0.lock().ok().and_then(|guard| guard.clone())
    }

    fn set(&self, version: String) {
        if let Ok(mut guard) = self.0.lock() {
            guard.replace(version);
        }
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
            tell(&app, MessageDialogKind::Info, "Updates need Phosphor in Applications", reason);
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

/// Runs on the main thread, so every dialog here is shown non-blocking: a blocking dialog raised
/// from the event loop deadlocks the loop that is supposed to draw it (same rule as on_menu).
fn settle(app: AppHandle, result: Result<Option<Update>, String>, asked: bool) {
    match result {
        Err(err) => {
            eprintln!("phosphor: update check failed: {err}");
            if asked {
                tell(
                    &app,
                    MessageDialogKind::Warning,
                    "Could not check for updates",
                    format!("Phosphor could not reach its release feed. Try again later.\n\n{err}"),
                );
            }
        }
        Ok(None) => {
            if asked {
                tell(
                    &app,
                    MessageDialogKind::Info,
                    "Up to date",
                    format!("Phosphor {} is the current version.", app.package_info().version),
                );
            }
        }
        Ok(Some(update)) => {
            let dismissed = app.state::<Dismissed>().get();
            if !asked && is_dismissed(dismissed.as_deref(), &update.version) {
                return;
            }
            offer(app, update);
        }
    }
}

fn offer(app: AppHandle, update: Update) {
    let version = update.version.clone();
    let after = app.clone();
    app.dialog()
        .message(offer_text(&update.version, update.body.as_deref()))
        .title(format!("Phosphor {version} is available"))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and relaunch".to_string(),
            "Later".to_string(),
        ))
        .show(move |install| {
            if install {
                begin_install(after, update);
            } else {
                after.state::<Dismissed>().set(version);
            }
        });
}

/// Download, verify, swap, stop the backend, relaunch. The download and the swap happen on the
/// async runtime; the restart is handed to the main thread, where AppHandle::restart exits the
/// process directly, so the backend is stopped on this side of that hand-off.
fn begin_install(app: AppHandle, update: Update) {
    tauri::async_runtime::spawn(async move {
        let installed = update.download_and_install(|_, _| {}, || {}).await;
        match installed {
            Ok(()) => {
                app.state::<Backend>().kill();
                let restart_on = app.clone();
                let _ = app.run_on_main_thread(move || restart_on.restart());
            }
            Err(err) => {
                eprintln!("phosphor: update install failed: {err}");
                let failed_on = app.clone();
                let _ = app.run_on_main_thread(move || {
                    tell(
                        &failed_on,
                        MessageDialogKind::Error,
                        "The update was not installed",
                        format!(
                            "Nothing changed: Phosphor {} keeps running. The download is verified before \
                             anything is replaced, so a failure here means the update was refused or the \
                             app folder could not be written.\n\n{err}",
                            failed_on.package_info().version
                        ),
                    );
                });
            }
        }
    });
}

fn tell(app: &AppHandle, kind: MessageDialogKind, title: &str, message: String) {
    app.dialog().message(message).kind(kind).title(title).show(|_| {});
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

fn offer_text(version: &str, notes: Option<&str>) -> String {
    let mut text = format!(
        "Phosphor {version} is ready. Installing takes a few seconds: the wallet locks, the app \
         closes, and it opens again on the new version."
    );
    if let Some(notes) = notes.map(str::trim).filter(|n| !n.is_empty()) {
        text.push_str("\n\n");
        text.push_str(&clip(notes, NOTES_LIMIT));
    }
    text
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
    use super::{clip, is_dismissed, offer_text, runs_from_a_volume, NOTES_LIMIT};
    use std::path::Path;

    #[test]
    fn a_version_answered_later_is_not_offered_again_by_the_clock() {
        assert!(is_dismissed(Some("0.4.1"), "0.4.1"));
        assert!(!is_dismissed(Some("0.4.1"), "0.4.2"));
        assert!(!is_dismissed(None, "0.4.1"));
    }

    #[test]
    fn the_offer_names_the_version_and_carries_the_notes() {
        let text = offer_text("0.4.1", Some("  Fixes the thing.  "));
        assert!(text.starts_with("Phosphor 0.4.1 is ready."));
        assert!(text.ends_with("\n\nFixes the thing."));
    }

    #[test]
    fn empty_notes_add_nothing() {
        assert_eq!(offer_text("0.4.1", Some("   ")), offer_text("0.4.1", None));
        assert!(!offer_text("0.4.1", None).ends_with('\n'));
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
    fn a_disk_image_is_recognised_by_its_mount_point() {
        assert!(runs_from_a_volume(Path::new("/Volumes/Phosphor/Phosphor.app/Contents/MacOS/phosphor-desktop")));
        assert!(!runs_from_a_volume(Path::new("/Applications/Phosphor.app/Contents/MacOS/phosphor-desktop")));
        assert!(!runs_from_a_volume(Path::new("/Users/k/Volumes/Phosphor.app/Contents/MacOS/phosphor-desktop")));
    }
}
