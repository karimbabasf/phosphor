// Phosphor's desktop shell.
//
// This binary is a launcher, a supervisor and a window, and deliberately nothing else. It starts
// the Node control app that ships inside the bundle, waits for it to bind its loopback port,
// points a webview at it, and watches it for as long as the app is open. Every decision the
// product makes about money, policy and approval happens in that Node process, exactly as it does
// when the repo is run with `npm run app`.
//
// The window is a plain remote page on http://127.0.0.1, not a Tauri-served asset. Two reasons,
// and the second one is the important one:
//
//   1. src/http/auth.ts refuses any request whose Host header is not loopback, and it checks a
//      window token on writes. Serving the UI from tauri://localhost would make every call
//      cross-origin and force that model to be rebuilt. This way it is untouched.
//   2. A remote webview has no Tauri IPC bridge. There is no command surface for a compromised
//      page to reach, so the native side cannot be driven from the page at all. That is why the
//      MCP config lives on a native menu item rather than a button in the UI: the menu is on the
//      side of the trust boundary the agent can never reach.
//
// THE HANDSHAKE. This shell mints three independent 32-byte values per boot and writes them down
// the backend's stdin, one per line, then closes the pipe. The window token is injected into the
// control webview alone with an initialization script, so it is reachable by exactly two processes
// and served over HTTP by neither; that is what replaces `GET /api/session`, which handed the
// approval token to any local caller that asked. The boot nonce is what the backend echoes in its
// x-phosphor header, so this shell can tell its OWN backend from anything else that took the port.
// The seat secret goes on to the agents the backend spawns, so a roster claimed from outside
// cannot lock the human's own agent out. See src-tauri/src/backend.rs.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod enclave;
mod update;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use backend::{
    configured_port, get_root, identity_matches, is_orphaned_backend, node_binary, phosphor_is_listening,
    pid_file_path, post_lock, read_pid_file, request_within, spawn_backend, stop_orphan, write_pid_file, Backend,
    Handshake, PidRecord,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

const READY_TIMEOUT: Duration = Duration::from_secs(45);
const COPY_MCP_ID: &str = "copy-mcp-config";

/// The Help menu: five pages on the site and the repository, each opened in the system browser.
/// The urls are the only ones this menu will ever open, and they live here rather than in any
/// page, so nothing a page renders can change where a menu item goes. The problem report opens
/// the bug form with the app version and the macOS version already filled in (`report_url`),
/// and both of those come from this process, never from a page.
const HELP_LINKS: [(&str, &str, &str); 5] = [
    ("help-docs", "Phosphor Documentation", "https://phosphor.money/docs/"),
    (HELP_REPORT_ID, "Report a Problem", "https://github.com/karimbabasf/phosphor/issues/new?template=bug_report.yml"),
    ("help-security", "Report a Security Issue", "https://phosphor.money/security/"),
    ("help-terms", "Terms of Use", "https://phosphor.money/terms/"),
    ("help-privacy", "Privacy", "https://phosphor.money/privacy/"),
];
const HELP_REPORT_ID: &str = "help-report";

/// The one Help item that is not a link: it puts the newest audit lines on the clipboard, one
/// JSON line each, for pasting into a problem report. The backend redacts the tail on the way
/// out (src/http/log-tail.ts), so a credential of this boot cannot travel in the paste. The
/// item's own title carries the outcome for a few seconds, because a message box is not this
/// app's design and the menu is where the person is already looking.
const HELP_COPY_LOG_ID: &str = "help-copy-log";
const COPY_LOG_LABEL: &str = "Copy Log for a Report";
const LOG_LINES_FOR_A_REPORT: u16 = 200;
const MENU_NOTICE: Duration = Duration::from_secs(4);

/// The menu item handles the Help menu keeps, so an outcome can be written onto one later.
struct HelpMenu {
    copy_log: MenuItem<tauri::Wry>,
}

/// How often the supervisor asks whether the backend is still there. Two seconds is well under
/// the time it takes a person to notice a dead window and long enough that the poll costs
/// nothing.
const WATCH_INTERVAL: Duration = Duration::from_secs(2);
/// A backend that dies after boot is respawned exactly once. Twice would be a crash loop, and a
/// crash loop in front of a wallet is worse than a stopped app with a sentence on it.
const RESPAWN_BACKOFF: Duration = Duration::from_secs(3);

/// How long to wait between asking the port whether the backend is up yet.
///
/// This was a flat 250 ms. The backend answers in 250 to 450 ms, so a 250 ms granularity added a
/// uniform 0 to 250 ms of dead time, a mean of 125 ms, to a boot that is itself under half a
/// second: the app was already up and the splash was waiting for the next look. A refused connect
/// on loopback is sub-millisecond, so looking more often costs nothing worth counting.
///
/// It only stays fast for the first two seconds. Past that the backend is slow or stuck, nobody is
/// helped by forty probes a second, and each one opens a connection and GETs `/`, which serves
/// ui/index.html off the disk.
const FAST_PROBE_WINDOW: Duration = Duration::from_secs(2);
const FAST_PROBE_INTERVAL: Duration = Duration::from_millis(25);
const SLOW_PROBE_INTERVAL: Duration = Duration::from_millis(250);

/// Takes the elapsed time rather than the start instant, so the rule can be read back in a test
/// without waiting two seconds to see the second half of it.
fn probe_interval(elapsed: Duration) -> Duration {
    if elapsed < FAST_PROBE_WINDOW {
        FAST_PROBE_INTERVAL
    } else {
        SLOW_PROBE_INTERVAL
    }
}

/// What this shell minted, held so the window can be given the token, the close handler can lock
/// with it, and the readiness polls can recognise the backend by its nonce. Never written to disk.
/// The token and the seat secret are never served; the nonce is served, on purpose, and is the one
/// of the three that is not a secret from anyone who can already reach the port.
pub(crate) struct Secrets(pub(crate) Handshake);

/// Everything `start` resolved, so the supervisor thread does not have to resolve it again.
#[derive(Clone)]
struct Paths {
    payload: PathBuf,
    data: PathBuf,
}

/// Where the app keeps everything it writes. The bundle is read-only, so state, the audit log,
/// the policy file and config.local.json all live here instead. Keys are not among them: they
/// stay at ~/.phosphor/, outside every working copy and every bundle, as they always have.
pub(crate) fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no application support directory: {e}"))?;
    std::fs::create_dir_all(dir.join("state")).map_err(|e| format!("cannot create {dir:?}: {e}"))?;
    Ok(dir)
}

/// The payload directory: the old repo root, shipped verbatim.
pub(crate) fn payload_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("no resource directory: {e}"))?
        .join("phosphor");
    if !dir.join("src").join("main.ts").is_file() {
        return Err(format!("the Phosphor payload is missing or incomplete at {dir:?}"));
    }
    Ok(dir)
}

/// The connection line for this installation, read off the backend that built it.
///
/// This used to build a second copy of the line here, with the pinned port and data directory
/// the proxy needs, while the window handed out a third without them: two sources of one truth,
/// and they differed. The backend is the one builder now (src/agents-catalog.ts, per agent, with
/// the environment in every mode), and GET /api/connection answers with the line for the agent
/// the person picked. No token on that route and nothing secret in the answer: a path already on
/// this disk, this app's port and data directory. The bundled runtime is still checked first so
/// a broken bundle fails with the same sentence it always did, before the port is asked.
///
/// THE ANSWER IS TRUSTED ONLY FROM THIS BOOT'S BACKEND. The port can be held by something else
/// during the respawn backoff (see watch), and a line copied to the clipboard is a
/// command the person is about to paste into a terminal, so the response has to carry this
/// boot's nonce in its identity header (identity_matches, the same check the readiness poll
/// makes) before a byte of it is read, and the command it carries has to be one printable line.
fn mcp_command(_payload: &Path, _data: &Path, port: u16, nonce: &str) -> Result<String, String> {
    node_binary()?;
    let head = format!("GET /api/connection HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let raw = backend::request_within(port, &head, None, Duration::from_secs(5))
        .ok_or_else(|| format!("Phosphor is not answering on 127.0.0.1:{port}, so there is no line to copy yet."))?;
    connection_line_from(&raw, nonce)
}

/// The command in a GET /api/connection response, or why it is refused. Pure, so the two
/// refusals a person must never paste through (a stranger on the port, a command that is not
/// one line) are held by tests without a socket.
fn connection_line_from(response: &str, nonce: &str) -> Result<String, String> {
    if !backend::identity_matches(response, Some(nonce)) {
        return Err("Something else is answering on Phosphor's port, so nothing was copied. Quit it and try again.".to_string());
    }
    let body = response.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
    let parsed: serde_json::Value =
        serde_json::from_str(body.trim()).map_err(|e| format!("the app's answer could not be read: {e}"))?;
    let command = match parsed.get("command").and_then(|c| c.as_str()) {
        Some(command) => command,
        None => return Err("The agent you picked has no line to paste. Pick an agent in the Vault tab's Agent panel first.".to_string()),
    };
    if command.is_empty() || command.len() > 4096 || command.chars().any(|c| c.is_control()) {
        return Err("The app's answer was not one line, so nothing was copied.".to_string());
    }
    Ok(command.to_string())
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let copy = MenuItem::with_id(app, COPY_MCP_ID, "Copy MCP Config", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, update::CHECK_ID, "Check for Updates...", true, None::<&str>)?;
    let app_menu = Submenu::with_items(
        app,
        "Phosphor",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &updates,
            &copy,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    // Documentation, the problem report and the log it wants first, the two legal pages after a
    // rule. macOS adds its own search field to a menu titled Help.
    let help_items = HELP_LINKS
        .iter()
        .map(|(id, label, _)| MenuItem::with_id(app, *id, *label, true, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()?;
    let copy_log = MenuItem::with_id(app, HELP_COPY_LOG_ID, COPY_LOG_LABEL, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let mut help_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::with_capacity(help_items.len() + 2);
    for (at, item) in help_items.iter().enumerate() {
        if at == 3 {
            help_refs.push(&separator);
        }
        help_refs.push(item);
        if item.id() == HELP_REPORT_ID {
            help_refs.push(&copy_log);
        }
    }
    let help_menu = Submenu::with_items(app, "Help", true, &help_refs)?;
    app.manage(HelpMenu { copy_log });
    Menu::with_items(app, &[&app_menu, &edit_menu, &help_menu])
}

/// The bug form with the two facts every report needs already in it. GitHub fills an issue
/// form's fields from query parameters named after the field ids (`version` and `os` in
/// .github/ISSUE_TEMPLATE/bug_report.yml). Both values are percent-encoded here, so a version
/// string can never change the path or add a parameter of its own.
fn report_url(base: &str, version: &str, os: &str) -> String {
    format!("{base}&version={}&os={}", query_value(version), query_value(os))
}

/// RFC 3986 unreserved characters pass; everything else is percent-encoded, byte by byte.
fn query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The macOS version as `sw_vers` reports it, or "unknown": one fixed command with one fixed
/// argument, no shell, and the answer goes into a query parameter and nowhere else.
fn macos_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// The newest audit lines from this shell's backend, one JSON object per line, or None when
/// the answer is not 200, not a JSON array, or not from the backend this shell started. Read
/// with its own five second deadline: the probe timeout is sized for a liveness check, and a
/// tail is a real read. `for=report` asks for the copy with addresses fingerprinted, since this
/// text is about to land on a public issue.
fn fetch_log_tail(port: u16, limit: u16, nonce: &str) -> Option<String> {
    let head = format!("GET /api/log?limit={limit}&for=report HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let raw = request_within(port, &head, None, Duration::from_secs(5))?;
    log_from_response(&raw, nonce)
}

/// The answer to that GET, judged before a byte of it reaches the clipboard: a 200, the
/// `x-phosphor` header carrying THIS boot's nonce (the same check that gates opening the
/// window, `identity_matches`), and a JSON array. A local process squatting the configured
/// port can answer 200 with a list; it cannot answer with the nonce, which reached the backend
/// over its stdin and nothing else.
fn log_from_response(raw: &str, nonce: &str) -> Option<String> {
    if !raw.starts_with("HTTP/1.1 200") {
        return None;
    }
    if !identity_matches(raw, Some(nonce)) {
        return None;
    }
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b)?;
    log_lines(body)
}

/// A JSON array of audit events as one event per line, the shape a person pastes. Anything
/// that is not an array is refused rather than pasted whole.
fn log_lines(body: &str) -> Option<String> {
    let events: Vec<serde_json::Value> = serde_json::from_str(body.trim()).ok()?;
    let lines = events.iter().filter_map(|e| serde_json::to_string(e).ok()).collect::<Vec<_>>();
    Some(lines.join("\n"))
}

fn copy_log_for_report(app: &tauri::AppHandle) {
    let outcome = payload_dir(app).and_then(|payload| {
        let data = data_dir(app)?;
        let port = configured_port(&payload, &data);
        let nonce = app.state::<Secrets>().0.nonce.clone();
        let text = fetch_log_tail(port, LOG_LINES_FOR_A_REPORT, &nonce).ok_or_else(|| "the control app did not answer as this shell's backend".to_string())?;
        app.clipboard()
            .write_text(text)
            .map_err(|e| format!("could not write to the clipboard: {e}"))
    });
    match outcome {
        Ok(()) => say_on_menu(app, "Log copied. Paste it into the report"),
        Err(err) => {
            eprintln!("phosphor: copy log: {err}");
            say_on_menu(app, "Nothing copied: the app did not answer");
        }
    }
}

/// Writes the outcome onto the Copy Log item's own title and puts the label back a few seconds
/// later. Menu events arrive on the main thread and set_text is safe there; the restore comes
/// back through run_on_main_thread for the same reason.
fn say_on_menu(app: &tauri::AppHandle, text: &str) {
    let Some(help) = app.try_state::<HelpMenu>() else {
        return;
    };
    let item = help.copy_log.clone();
    let _ = item.set_text(text);
    let later = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(MENU_NOTICE);
        let _ = later.run_on_main_thread(move || {
            let _ = item.set_text(COPY_LOG_LABEL);
        });
    });
}

fn on_menu(app: &tauri::AppHandle, event: MenuEvent) {
    if event.id() == update::CHECK_ID {
        update::check(app.clone(), true);
        return;
    }
    if event.id() == HELP_COPY_LOG_ID {
        copy_log_for_report(app);
        return;
    }
    if let Some((id, _, url)) = HELP_LINKS.iter().find(|(id, _, _)| event.id() == *id) {
        let target = if *id == HELP_REPORT_ID {
            report_url(url, &app.package_info().version.to_string(), &macos_version())
        } else {
            url.to_string()
        };
        // Same hand-off as a link the page opens: `open` gets the url as one argument, no shell.
        let _ = std::process::Command::new("open").arg(target).spawn();
        return;
    }
    if event.id() != COPY_MCP_ID {
        return;
    }
    let result = payload_dir(app).and_then(|payload| {
        let data = data_dir(app)?;
        let port = configured_port(&payload, &data);
        let nonce = app.state::<Secrets>().0.nonce.clone();
        let command = mcp_command(&payload, &data, port, &nonce)?;
        app.clipboard()
            .write_text(command)
            .map_err(|e| format!("could not write to the clipboard: {e}"))
    });
    // Never blocking_show here. Menu events arrive on the main thread, and a blocking dialog
    // raised from it deadlocks the event loop that is supposed to be drawing the dialog.
    match result {
        Ok(()) => app
            .dialog()
            .message("The `claude mcp add-json` line for this installation is on the clipboard. Run it in the directory you want the agent to work from.")
            .title("MCP config copied")
            .show(|_| {}),
        Err(err) => app
            .dialog()
            .message(err)
            .kind(MessageDialogKind::Error)
            .title("Could not copy the MCP config")
            .show(|_| {}),
    };
}

/// Reports a startup failure and quits once it has been read. Same main-thread rule as above: the
/// exit is deferred into the dismissal callback rather than taken after a blocking call.
fn fail(app: &tauri::AppHandle, message: String) {
    eprintln!("phosphor: {message}");
    let handle = app.clone();
    app.dialog()
        .message(message)
        .kind(MessageDialogKind::Error)
        .title("Phosphor could not start")
        .show(move |_| handle.exit(1));
}

/// Says something happened and leaves the app running. Used by the supervisor, where the app is
/// still usable and the person needs to know the backend went away and came back.
fn notify(app: &tauri::AppHandle, title: &str, message: String) {
    eprintln!("phosphor: {message}");
    app.dialog()
        .message(message)
        .kind(MessageDialogKind::Warning)
        .title(title)
        .show(|_| {});
}

/// Replaces the splash with the real window. Created rather than navigated, so the page holding
/// the approval surface gets a webview of its own that was never on a Tauri origin.
///
/// The initialization script is the second half of the token contract: it runs before any page
/// script on THIS window only, so the control page can read `window.__PHOSPHOR_TOKEN__` and no
/// other webview, page or local process ever sees it.
fn open_control_window(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("cannot parse the control app URL: {e}"))?;
    let token = app.state::<Secrets>().0.token.clone();
    // The token is hex from mint_token, so it cannot carry a quote or a backslash and the literal
    // below cannot be broken out of. Asserted rather than assumed: a token that is not hex is a
    // bug in mint_token, and injecting it would be worse than refusing to open the window.
    if !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the window token is not hex, so it will not be injected".to_string());
    }
    let script = format!("window.__PHOSPHOR_TOKEN__ = \"{token}\";");

    // Opens maximized: the window fills the screen without going into macOS fullscreen, so the
    // menu bar and the dock stay where they are. The size below is what it falls back to when
    // the person unmaximizes it. The minimum is the stylesheet's own floors summed: a 360 px
    // conversation beside a 560 px world plus the handle for the width, and the topbar over
    // the trade strip, the chart at its 364 px floor and the deck at its 168 px floor for the
    // height, so the window can never be dragged under what the layout can hold.
    //
    // NO `.center()` HERE. On macOS tao queues the maximize (an NSWindow `zoom:`) on the main
    // dispatch queue, and tauri re-applies a centered position right after the build as a
    // `setFrameTopLeftPoint:` on the same queue. The zoom ran first and filled the screen, then
    // the move dragged the screen-sized window to where a 1180 x 780 one would be centered, so
    // it opened hanging off the bottom right (Karim, 2026-09-15: "default it to fill the
    // screen"). tao centers a window that was given no position on its own, so the fallback
    // frame is still centered without the call, and the zoom is the last word.
    let window = WebviewWindowBuilder::new(app, "control", WebviewUrl::External(url))
        .title("Phosphor")
        .inner_size(1180.0, 780.0)
        .min_inner_size(960.0, 700.0)
        .resizable(true)
        .maximized(true)
        .initialization_script(&script)
        .on_new_window(|url, _features| open_in_browser(url))
        .build()
        .map_err(|e| format!("cannot open the control window: {e}"))?;

    /* Closing the window locks the wallet. The window is the only surface that can approve
       anything, so a window that is gone and a wallet that is open is a combination with no
       legitimate use. The route belongs to the custody track and may not exist yet; a 404 is a
       perfectly good outcome and this stays best effort either way. Off the main thread, because
       it is a socket round trip and this handler runs on the event loop. */
    let lock_token = app.state::<Secrets>().0.token.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
            let token = lock_token.clone();
            std::thread::spawn(move || {
                let _ = post_lock(port, &token, "the control window was closed");
            });
        }
    });

    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    Ok(())
}

/// A link the page opens in a new window (target=_blank, window.open) goes to the system
/// browser, and only there. Without this handler the webview silently drops the request, which
/// is what the receipt card's "View on <explorer>" button hit before 2026-09-15. A second
/// webview would be a second window onto the wallet with none of this shell's handshake, so
/// every request is denied here and the https ones are handed to `open` first. Anything else
/// (file:, javascript:, a custom scheme) is dropped: the page only ever opens explorer urls the
/// backend built, and this is the last place that promise is checked.
fn open_in_browser(url: tauri::Url) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    if url.scheme() == "https" {
        // `open` takes the url as one argument with no shell in between, and an https url
        // cannot start with a dash, so it cannot be read as an option.
        let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
    }
    tauri::webview::NewWindowResponse::Deny
}

/// What answers on the port before this launch has started anything.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Occupant {
    Nothing,
    /// Sends the x-phosphor header: a Phosphor backend of some boot, not necessarily ours.
    Phosphor,
    Stranger,
}

/// What this launch does about what it found.
#[derive(Debug, PartialEq)]
enum Launch {
    Start,
    /// Give way to another copy of this app, by the pid of its shell.
    HandOver(i32),
    /// Stop an orphaned backend of this app, by its pid, then start.
    StopOrphan(i32),
    Refuse(String),
}

/// What a launch does about what is already running, decided before it starts anything.
///
/// It used to attach: `if phosphor_is_listening(port) { return open_control_window(...) }`. That
/// is how the orphan became permanent. Attaching hands the window a backend this shell does not
/// hold a `Child` for, so every later quit calls kill() on a `None`, returns, and leaves node
/// listening with the wallet loaded until the machine is rebooted. That rule stands: nothing here
/// opens a window onto a backend this shell did not start, or hands one the token.
///
/// Then it refused whatever it found, by name, and that put the two likeliest first-launch
/// situations behind an error dialog about port 4177, though neither is a stranger. One is a
/// second copy of the app: the copy opened from the disk image, which macOS runs from a hidden
/// path of its own, beside the copy dragged to Applications, or a second open during the Open
/// Anyway steps. The other is a backend left running by a shell that was force-quit, most often
/// during a slow first boot. So:
///
///   1. Another copy of this app is running: bring it forward and leave, with no dialog. It owns
///      its backend and its window, and this launch starts nothing.
///   2. A backend this app started is still running with no shell above it: stop it the way
///      quitting would have, then start as if the port had been free.
///   3. Anything else on the port is refused in plain English, as it always was.
///
/// Pure, so each of those is a test, and none of the tests needs a second copy of the app.
fn launch(port: u16, occupant: Occupant, running_copy: Option<i32>, orphan: Option<i32>) -> Launch {
    if let Some(shell) = running_copy {
        return Launch::HandOver(shell);
    }
    if let Some(backend) = orphan {
        return Launch::StopOrphan(backend);
    }
    match occupant {
        Occupant::Nothing => Launch::Start,
        Occupant::Phosphor => Launch::Refuse(format!(
            "Another Phosphor that this app did not start is already running on 127.0.0.1:{port}, most \
             likely one started from a source checkout with `npm run app`. \
             Stop it (`pkill -f 'node src/main.ts'`) and open Phosphor again. \
             This app will not open a window onto a Phosphor it did not start, because it could not \
             shut that one down afterwards."
        )),
        Occupant::Stranger => Launch::Refuse(format!(
            "Another program is already using 127.0.0.1:{port}, the address Phosphor runs on, so Phosphor \
             did not start. Quit that program and open Phosphor again. If it has to keep that address, set \
             a different port in config.local.json."
        )),
    }
}

/// What answers on the port. `None` on purpose: the question here is only whether it is
/// Phosphor-shaped, an instance from an earlier boot answers with that boot's nonce rather than
/// this one's, and nothing is ever opened onto the answer.
fn occupant(port: u16) -> Occupant {
    if phosphor_is_listening(port, None) {
        Occupant::Phosphor
    } else if get_root(port).is_some() {
        Occupant::Stranger
    } else {
        Occupant::Nothing
    }
}

/// The facts `launch` decides on, read off this Mac.
///
/// The pid file says which shell and which backend the last launch started, and neither number is
/// taken as it stands: the file outlives the processes it names, and macOS hands numbers out
/// again. The shell counts only when macOS itself knows that pid as this app (`is_this_app`), and
/// never when it is this very process, which a recycled number can be. The backend counts only
/// when the process table proves it an orphan of this app (`backend::is_orphaned_backend`).
fn survey(app: &tauri::AppHandle) -> Result<Launch, String> {
    let payload = payload_dir(app)?;
    let data = data_dir(app)?;
    let port = configured_port(&payload, &data);
    let identifier = app.config().identifier.clone();
    let record = read_pid_file(&pid_file_path(&data));
    let copy = running_copy(record.as_ref(), std::process::id() as i32, |pid| is_this_app(pid, &identifier));
    let orphan = record.map(|r| r.backend).filter(|&pid| is_orphaned_backend(pid, &identifier));
    Ok(launch(port, occupant(port), copy, orphan))
}

/// The shell the pid file names, when it is a running copy of this app and not this process.
fn running_copy(record: Option<&PidRecord>, me: i32, is_this_app: impl Fn(i32) -> bool) -> Option<i32> {
    record.map(|r| r.shell).filter(|&shell| shell != me && is_this_app(shell))
}

/// Is that pid a running copy of this app, as macOS itself knows it: an application registered
/// under this app's bundle identifier? The disk image copy and the Applications copy both are,
/// which is the point, and a pid the pid file still names after its shell died and the number
/// went to something else is not.
#[cfg(target_os = "macos")]
fn is_this_app(pid: i32, identifier: &str) -> bool {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .and_then(|running| running.bundleIdentifier())
        .is_some_and(|declared| declared.to_string() == identifier)
}

#[cfg(not(target_os = "macos"))]
fn is_this_app(_pid: i32, _identifier: &str) -> bool {
    false
}

/// Unhides that copy and brings all of its windows forward. `ActivateIgnoringOtherApps` is for
/// macOS 13, which would otherwise leave it behind whatever was in front if this process has not
/// become active yet; macOS 14 ignores the flag and lets the active app pass activation on, which
/// the copy a person just opened is.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn bring_forward(pid: i32) -> bool {
    let Some(running) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
        return false;
    };
    running.unhide();
    running.activateWithOptions(
        NSApplicationActivationOptions::ActivateAllWindows | NSApplicationActivationOptions::ActivateIgnoringOtherApps,
    )
}

#[cfg(not(target_os = "macos"))]
fn bring_forward(_pid: i32) -> bool {
    false
}

/// Gives way to the copy of this app that is already running: brings it forward, then leaves with
/// no dialog and nothing drawn. Sent round the event loop from a thread rather than run in setup,
/// so it lands after this process has finished launching and holds the activation it passes on.
fn hand_over(app: &tauri::AppHandle, shell: i32) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let leaving = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let outcome = if bring_forward(shell) { "brought it forward" } else { "it did not come forward" };
            eprintln!("phosphor: Phosphor is already running as process {shell}; {outcome}, and this copy is leaving");
            leaving.exit(0);
        });
    });
}

/// Watches the backend for as long as the app is open.
///
/// The old readiness thread returned the moment the port answered, and nothing looked at the
/// backend again. Its death showed the person nothing at all: the webview kept its last render,
/// every fetch failed silently, no dialog and no reconnect. Balances that were minutes old looked
/// exactly like balances that were current.
fn watch(app: tauri::AppHandle, paths: Paths, port: u16) {
    let mut respawned = false;
    loop {
        std::thread::sleep(WATCH_INTERVAL);
        // A stop this shell chose (an update relaunching it) is not a crash to recover from.
        if app.state::<Backend>().stopping() {
            return;
        }
        match app.state::<Backend>().exited() {
            Some(false) | None => continue,
            Some(true) => {}
        }

        if respawned {
            let dead = app.clone();
            let _ = dead.clone().run_on_main_thread(move || {
                fail(
                    &dead,
                    "The control app stopped twice, so Phosphor is not restarting it again. \
                     Its error is in Console.app under Phosphor."
                        .to_string(),
                );
            });
            return;
        }
        respawned = true;

        std::thread::sleep(RESPAWN_BACKOFF);
        if app.state::<Backend>().stopping() {
            return;
        }

        /* NOTHING MAY BE ON THE PORT BEFORE THE RESPAWN. This path had no check at all, which made
           it the deterministic half of the finding: the backend dies, this thread sleeps three
           seconds, and a local process that binds the port in that window gets the readiness poll
           below reporting a healthy restart while the real backend dies on EADDRINUSE. The control
           window from the first boot is still open, still holds the token, and goes on posting
           writes and the keystore passphrase to whatever is now answering. `start` has had this
           check since the orphan bug; the respawn is where it was missing. */
        if get_root(port).is_some() {
            let taken = app.clone();
            let _ = taken.clone().run_on_main_thread(move || {
                fail(
                    &taken,
                    format!(
                        "The control app stopped and something else took 127.0.0.1:{port} before it could be \
                         restarted. Phosphor will not open a window onto a process it did not start. Quit \
                         whatever is holding the port and start Phosphor again."
                    ),
                );
            });
            return;
        }

        let hand = app.state::<Secrets>();
        match spawn_backend(&paths.payload, &paths.data, &hand.0) {
            Ok(child) => {
                app.state::<Backend>().adopt(child, pid_file_path(&paths.data));
                // Wait for it to bind before saying it is back. "Restarted" over a process that
                // spawned and then failed to listen is the same lie as the silent death this
                // whole thread exists to end.
                let started = Instant::now();
                let deadline = started + READY_TIMEOUT;
                let mut answered = false;
                let nonce = app.state::<Secrets>().0.nonce.clone();
                while Instant::now() < deadline {
                    /* The dead child is asked about FIRST. Tested the other way round, a backend
                       that failed to bind and a squatter that did are the same observation, and the
                       squatter wins the first iteration. This order means a child that is gone ends
                       the loop whatever is answering on the port. */
                    if app_backend_exited(&app) {
                        break;
                    }
                    if phosphor_is_listening(port, Some(&nonce)) {
                        answered = true;
                        break;
                    }
                    std::thread::sleep(probe_interval(started.elapsed()));
                }
                let back = app.clone();
                let _ = back.clone().run_on_main_thread(move || {
                    if answered {
                        notify(
                            &back,
                            "Phosphor restarted its control app",
                            "The control app stopped and has been started again. Anything that was in \
                             flight when it stopped is on the Activity as an unknown outcome: check it \
                             before acting again."
                                .to_string(),
                        );
                    } else {
                        fail(
                            &back,
                            "The control app stopped and the restarted one never answered. Its error is \
                             in Console.app under Phosphor."
                                .to_string(),
                        );
                    }
                });
                if !answered {
                    return;
                }
            }
            Err(err) => {
                let broken = app.clone();
                let _ = broken.clone().run_on_main_thread(move || {
                    fail(&broken, format!("The control app stopped and could not be restarted: {err}"));
                });
                return;
            }
        }
    }
}

fn start(app: &tauri::AppHandle, found: Launch) -> Result<(), String> {
    let payload = payload_dir(app)?;
    let data = data_dir(app)?;
    let port = configured_port(&payload, &data);

    match found {
        Launch::Start => {}
        Launch::Refuse(why) => return Err(why),
        // setup gives way before anything is drawn and never gets here; starting nothing is the
        // answer either way.
        Launch::HandOver(_) => return Ok(()),
        Launch::StopOrphan(backend) => {
            /* Claimed before it is stopped. From here the pid file names this shell, so a launch
               that lands while the orphan drains finds a running copy and gives way to it, rather
               than stopping the same orphan a second time and racing this one to the port. The
               wait runs on this thread, as kill()'s does at quit: an idle backend is gone in well
               under a second, and only a venue write in flight makes it longer. */
            write_pid_file(&pid_file_path(&data), backend);
            if !stop_orphan(backend, &app.config().identifier) {
                return Err(format!(
                    "A Phosphor control app from an earlier session is still running as process {backend}, \
                     holding 127.0.0.1:{port} with your wallet loaded and no window on it, and it did not \
                     stop when asked. Quit it (`kill {backend}`) and open Phosphor again."
                ));
            }
            // The orphan is gone, so whatever answers now is judged as if it had never been there.
            if let Launch::Refuse(why) = launch(port, occupant(port), None, None) {
                return Err(why);
            }
        }
    }

    let child = {
        let hand = app.state::<Secrets>();
        spawn_backend(&payload, &data, &hand.0)?
    };
    app.state::<Backend>().adopt(child, pid_file_path(&data));

    // Polled on a worker so the event loop keeps running and the splash keeps painting. The same
    // thread goes on to supervise, so there is no gap between "it came up" and "somebody is
    // watching it".
    let handle = app.clone();
    let paths = Paths { payload, data };
    let nonce = app.state::<Secrets>().0.nonce.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let deadline = started + READY_TIMEOUT;
        while Instant::now() < deadline {
            /* The child exiting means the backend refused to boot; its reason is already on
               stderr. Asked BEFORE the port is probed, because a backend that died on EADDRINUSE
               and a local process that took the port during the boot race look identical from the
               port's side, and the old order let that process win the first iteration and be
               handed a window with the token in it. */
            if app_backend_exited(&handle) {
                let dead = handle.clone();
                let _ = dead.clone().run_on_main_thread(move || {
                    fail(
                        &dead,
                        "The control app stopped while starting up. Its error is in Console.app under Phosphor. \
                         The two usual causes are a port already in use and a state file it refused to read."
                            .to_string(),
                    );
                });
                return;
            }
            // Our backend, by the nonce it was given on stdin, and not merely a Phosphor-shaped
            // answer. This is the poll that opens the window and injects the approval token.
            if phosphor_is_listening(port, Some(&nonce)) {
                let ready = handle.clone();
                let _ = ready.clone().run_on_main_thread(move || {
                    if let Err(err) = open_control_window(&ready, port) {
                        fail(&ready, err);
                    }
                });
                update::schedule(&handle);
                start_enclave_relay(&handle, port);
                watch(handle, paths, port);
                return;
            }
            std::thread::sleep(probe_interval(started.elapsed()));
        }
        let late = handle.clone();
        let _ = late.clone().run_on_main_thread(move || {
            fail(&late, format!("The control app did not answer on 127.0.0.1:{port} within {}s.", READY_TIMEOUT.as_secs()));
        });
    });
    Ok(())
}

fn app_backend_exited(app: &tauri::AppHandle) -> bool {
    matches!(app.state::<Backend>().exited(), Some(true))
}

/// The thread that lends the backend this shell's reach into the Secure Enclave, for as long as
/// the backend this shell started is alive. It is started only after the backend answered with
/// this boot's nonce, so it never relays for anything else on the port, and it stops on its own
/// when the child is gone; a respawned backend gets a fresh one from the watch loop's caller.
/// See enclave.rs for why the request comes from the backend and never from the page.
fn start_enclave_relay(app: &tauri::AppHandle, port: u16) {
    let hand = app.state::<Secrets>();
    let relay = enclave::Relay {
        port,
        relay: hand.0.relay.clone(),
        nonce: hand.0.nonce.clone(),
        transport: hand.0.transport.clone(),
    };
    let alive = app.clone();
    std::thread::spawn(move || {
        enclave::run(relay, || !app_backend_exited(&alive));
    });
}

fn main() {
    // Minted before anything else, because the backend cannot be spawned without it and the
    // window cannot be opened without it. A shell that cannot produce one starts nothing: a
    // guessable token would be no token at all, and the same goes for the nonce that decides
    // which process this shell is willing to open a window onto.
    let secrets = match Handshake::mint() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("phosphor: {err}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Backend::new())
        .manage(Secrets(secrets))
        .manage(update::Updates::default())
        // The only commands this shell has, and only the update window can call them: the
        // control window is a remote page, which the ACL keeps away from app commands.
        .invoke_handler(tauri::generate_handler![update::update_install, update::update_dismiss])
        .setup(|app| {
            let handle = app.handle().clone();
            // Surveyed before anything is drawn, so a second copy of this app gives way to the
            // first without a flash of splash, a menu or a dialog. See `launch`.
            let found = survey(&handle);
            if let Ok(Launch::HandOver(shell)) = found {
                hand_over(&handle, shell);
                return Ok(());
            }
            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(on_menu);

            // The splash paints the window's one colourway, green on black, and receives no
            // script: nothing read off the disk reaches it.
            WebviewWindowBuilder::new(&handle, "splash", WebviewUrl::App("index.html".into()))
                .title("Phosphor")
                .inner_size(420.0, 300.0)
                .resizable(false)
                .center()
                .build()?;

            if let Err(err) = found.and_then(|found| start(&handle, found)) {
                fail(&handle, err);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("phosphor: failed to build the desktop shell")
        .run(|app, event| {
            // Covers quit, the last window closing, and a force-quit that still unwinds: the
            // backend must not outlive the window that is the only way to approve anything.
            // `impl Drop for Backend` is the backstop behind this, for the exits that raise
            // neither event.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                app.state::<Backend>().kill();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{connection_line_from, probe_interval, FAST_PROBE_INTERVAL, FAST_PROBE_WINDOW, SLOW_PROBE_INTERVAL, log_from_response, log_lines, query_value, report_url, HELP_LINKS, HELP_REPORT_ID};
    use super::{launch, running_copy, Launch, Occupant, PidRecord};
    use std::time::Duration;

    const NONCE: &str = "abc123";

    fn answer(nonce_header: Option<&str>, body: &str) -> String {
        let header = nonce_header.map(|n| format!("x-phosphor: {n}\r\n")).unwrap_or_default();
        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n{header}\r\n{body}")
    }

    #[test]
    fn the_copied_line_comes_only_from_this_boots_backend() {
        let body = r#"{"agent":"codex","command":"codex mcp add phosphor --env PHOSPHOR_PORT=4177 -- node /x/src/mcp.ts"}"#;
        assert_eq!(
            connection_line_from(&answer(Some(NONCE), body), NONCE).unwrap(),
            "codex mcp add phosphor --env PHOSPHOR_PORT=4177 -- node /x/src/mcp.ts"
        );
        // The header is matched without regard to case, as on the wire.
        assert!(connection_line_from(&answer(Some("ABC123"), body), NONCE).is_ok());
        // Another boot's nonce, the fixed marker any server can send, and no marker at all are
        // all a stranger on the port: refused before the body is read.
        assert!(connection_line_from(&answer(Some("other"), body), NONCE).unwrap_err().contains("Something else is answering"));
        assert!(connection_line_from(&answer(Some("control"), body), NONCE).is_err());
        assert!(connection_line_from(&answer(None, body), NONCE).is_err());
    }

    #[test]
    fn a_command_that_is_not_one_printable_line_is_never_copied() {
        let two_lines = r#"{"command":"codex mcp add phosphor\nrm -rf ~"}"#;
        assert!(connection_line_from(&answer(Some(NONCE), two_lines), NONCE).unwrap_err().contains("not one line"));
        let carriage = r#"{"command":"codex mcp add phosphor\r"}"#;
        assert!(connection_line_from(&answer(Some(NONCE), carriage), NONCE).is_err());
        let escape = "{\"command\":\"codex \\u001b[31m mcp add\"}";
        assert!(connection_line_from(&answer(Some(NONCE), escape), NONCE).is_err());
        assert!(connection_line_from(&answer(Some(NONCE), r#"{"command":""}"#), NONCE).is_err());
        let long = format!(r#"{{"command":"{}"}}"#, "a".repeat(5000));
        assert!(connection_line_from(&answer(Some(NONCE), &long), NONCE).is_err());
        // No line at all (Claude Desktop) and an unreadable body are refused with their own sentence.
        assert!(connection_line_from(&answer(Some(NONCE), r#"{"command":null}"#), NONCE).unwrap_err().contains("has no line to paste"));
        assert!(connection_line_from(&answer(Some(NONCE), "not json"), NONCE).unwrap_err().contains("could not be read"));
    }

    #[test]
    fn the_problem_report_opens_the_bug_form_with_the_version_and_the_os_filled_in() {
        let (_, _, base) = HELP_LINKS.iter().find(|(id, _, _)| *id == HELP_REPORT_ID).expect("the report item is on the Help menu");
        let url = report_url(base, "0.7.0", "26.0.1");
        assert_eq!(url, "https://github.com/karimbabasf/phosphor/issues/new?template=bug_report.yml&version=0.7.0&os=26.0.1");
        assert!(url.starts_with("https://github.com/karimbabasf/phosphor/issues/new?"), "the report goes anywhere but the repository's issue form");
    }

    #[test]
    fn a_query_value_cannot_add_a_parameter_or_leave_the_query() {
        assert_eq!(query_value("0.7.0"), "0.7.0");
        assert_eq!(query_value("26.0 beta&os=x#frag/../"), "26.0%20beta%26os%3Dx%23frag%2F..%2F");
        assert_eq!(query_value("ünïcode"), "%C3%BCn%C3%AFcode");
    }

    #[test]
    fn the_log_copy_takes_only_an_answer_that_carries_this_boots_nonce() {
        let body = r#"[{"ts":"t1","type":"tool_call","msg":"a"}]"#;
        let ours = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Phosphor: ABCDEF0123\r\n\r\n{body}");
        let copied = log_from_response(&ours, "abcdef0123").expect("this boot's nonce, upper-cased on the wire, is this shell's backend");
        assert_eq!(copied.lines().count(), 1);
        assert!(copied.contains(r#""msg":"a""#), "the event came through: {copied}");
        let squatter = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{body}");
        assert_eq!(log_from_response(&squatter, "abcdef0123"), None, "a 200 with a list and no nonce is a stranger's text");
        let old_boot = format!("HTTP/1.1 200 OK\r\nX-Phosphor: 999999\r\n\r\n{body}");
        assert_eq!(log_from_response(&old_boot, "abcdef0123"), None, "another boot's nonce is not this shell's backend");
        let fixed_marker = format!("HTTP/1.1 200 OK\r\nX-Phosphor: control\r\n\r\n{body}");
        assert_eq!(log_from_response(&fixed_marker, "abcdef0123"), None, "the old fixed marker any server can send is refused");
        let refused = format!("HTTP/1.1 401 Unauthorized\r\nX-Phosphor: abcdef0123\r\n\r\n{body}");
        assert_eq!(log_from_response(&refused, "abcdef0123"), None);
    }

    #[test]
    fn the_log_is_pasted_one_event_per_line_and_only_when_it_is_a_list() {
        let body = r#"[{"ts":"t1","type":"tool_call","msg":"a"},{"ts":"t2","type":"executed","msg":"b"}]"#;
        let lines = log_lines(body).expect("a JSON array is the log tail");
        assert_eq!(lines.lines().count(), 2);
        assert!(lines.lines().all(|l| l.starts_with('{') && l.ends_with('}')));
        assert_eq!(log_lines("{\"error\":\"nope\"}"), None, "an object is an error answer, not a tail");
        assert_eq!(log_lines("<html>"), None);
    }

    #[test]
    fn the_first_two_seconds_are_looked_at_forty_times_a_second() {
        assert_eq!(probe_interval(Duration::from_millis(0)), FAST_PROBE_INTERVAL);
        assert_eq!(probe_interval(Duration::from_millis(450)), FAST_PROBE_INTERVAL);
        assert_eq!(probe_interval(FAST_PROBE_WINDOW - Duration::from_millis(1)), FAST_PROBE_INTERVAL);
    }

    #[test]
    fn a_backend_that_is_late_is_asked_less_often() {
        assert_eq!(probe_interval(FAST_PROBE_WINDOW), SLOW_PROBE_INTERVAL);
        assert_eq!(probe_interval(Duration::from_secs(30)), SLOW_PROBE_INTERVAL);
    }

    const EVERY_OCCUPANT: [Occupant; 3] = [Occupant::Nothing, Occupant::Phosphor, Occupant::Stranger];

    #[test]
    fn a_second_copy_gives_way_to_the_first_whatever_answers_on_the_port() {
        // The first copy may still be booting (nothing answers yet), up (its backend answers), or
        // losing its port; in every case it owns the situation and this launch starts nothing.
        for occupant in EVERY_OCCUPANT {
            assert_eq!(launch(4177, occupant, Some(501), None), Launch::HandOver(501));
            assert_eq!(launch(4177, occupant, Some(501), Some(502)), Launch::HandOver(501), "the running copy wins over an orphan");
        }
    }

    #[test]
    fn a_backend_left_without_its_shell_is_stopped_and_replaced_rather_than_refused() {
        // Answering, still booting, or dying on a port something else took: proved an orphan, it goes.
        for occupant in EVERY_OCCUPANT {
            assert_eq!(launch(4177, occupant, None, Some(502)), Launch::StopOrphan(502));
        }
    }

    #[test]
    fn a_free_port_with_nothing_of_ours_around_starts() {
        assert_eq!(launch(4177, Occupant::Nothing, None, None), Launch::Start);
    }

    #[test]
    fn what_this_app_cannot_vouch_for_is_still_refused_in_plain_english() {
        let Launch::Refuse(stranger) = launch(4177, Occupant::Stranger, None, None) else {
            panic!("another program on the port is refused");
        };
        assert!(stranger.starts_with("Another program is already using 127.0.0.1:4177"), "{stranger}");
        let Launch::Refuse(unknown) = launch(4177, Occupant::Phosphor, None, None) else {
            panic!("a Phosphor this app did not start is refused, never attached to");
        };
        assert!(unknown.contains("did not start") && unknown.contains("127.0.0.1:4177"), "{unknown}");
        assert!(!unknown.contains("`kill "), "nothing here was proved an orphan, so no pid is offered to kill");
    }

    #[test]
    fn only_a_live_copy_of_this_app_is_handed_over_to() {
        let record = PidRecord { shell: 501, backend: 502 };
        assert_eq!(running_copy(Some(&record), 700, |pid| pid == 501), Some(501));
        assert_eq!(
            running_copy(Some(&record), 700, |_| false),
            None,
            "a pid macOS does not know as this app, dead or handed to another program, is nobody"
        );
        assert_eq!(running_copy(Some(&record), 501, |_| true), None, "a number handed back to this very process is not a copy of it");
        assert_eq!(running_copy(None, 700, |_| true), None, "no pid file, no copy");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_process_that_is_not_this_app_is_never_taken_for_it() {
        use super::is_this_app;
        assert!(!is_this_app(std::process::id() as i32, "com.karimbabasf.phosphor"), "the test runner is not the app");
        assert!(!is_this_app(i32::MAX, "com.karimbabasf.phosphor"), "no process at all is not the app");
    }

    #[test]
    fn the_fast_cadence_cannot_add_more_than_it_saves() {
        // The dead time a probe granularity adds is bounded by the interval itself, and the
        // backend answers in 250 to 450 ms, which is inside the fast window.
        assert!(FAST_PROBE_INTERVAL < SLOW_PROBE_INTERVAL);
        assert!(FAST_PROBE_WINDOW > Duration::from_millis(450));
    }
}
