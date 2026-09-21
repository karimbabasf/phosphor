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
    configured_port, get_root, node_binary, phosphor_is_listening, pid_file_path, pid_is_alive,
    post_lock, read_pid_file, spawn_backend, Backend, Handshake,
};

const READY_TIMEOUT: Duration = Duration::from_secs(45);
const COPY_MCP_ID: &str = "copy-mcp-config";

/// The Help menu: five pages on the site and the repository, each opened in the system browser.
/// The urls are the only ones this menu will ever open, and they live here rather than in any
/// page, so nothing a page renders can change where a menu item goes.
const HELP_LINKS: [(&str, &str, &str); 5] = [
    ("help-docs", "Phosphor Documentation", "https://phosphor.karimbabasf.com/docs/"),
    ("help-report", "Report a Problem", "https://github.com/karimbabasf/phosphor/issues/new/choose"),
    ("help-security", "Report a Security Issue", "https://phosphor.karimbabasf.com/security/"),
    ("help-terms", "Terms of Use", "https://phosphor.karimbabasf.com/terms/"),
    ("help-privacy", "Privacy", "https://phosphor.karimbabasf.com/privacy/"),
];

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
/// during the respawn backoff (see refuse_existing), and a line copied to the clipboard is a
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
    // Documentation and the problem report first, the two legal pages after a rule. macOS
    // adds its own search field to a menu titled Help.
    let help_items = HELP_LINKS
        .iter()
        .map(|(id, label, _)| MenuItem::with_id(app, *id, *label, true, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()?;
    let separator = PredefinedMenuItem::separator(app)?;
    let mut help_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::with_capacity(help_items.len() + 1);
    for (at, item) in help_items.iter().enumerate() {
        if at == 3 {
            help_refs.push(&separator);
        }
        help_refs.push(item);
    }
    let help_menu = Submenu::with_items(app, "Help", true, &help_refs)?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &help_menu])
}

fn on_menu(app: &tauri::AppHandle, event: MenuEvent) {
    if event.id() == update::CHECK_ID {
        update::check(app.clone(), true);
        return;
    }
    if let Some((_, _, url)) = HELP_LINKS.iter().find(|(id, _, _)| event.id() == *id) {
        // Same hand-off as a link the page opens: `open` gets the url as one argument, no shell.
        let _ = std::process::Command::new("open").arg(url).spawn();
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

/// What to do when the port already answers.
///
/// It used to attach: `if phosphor_is_listening(port) { return open_control_window(...) }`. That
/// is how the orphan became permanent. Attaching hands the window a backend this shell does not
/// hold a `Child` for, so every later quit calls kill() on a `None`, returns, and leaves node
/// listening with the wallet loaded until the machine is rebooted.
///
/// So it refuses, and names the process, because "something is on the port" is not an actionable
/// sentence and "quit process 41207" is.
fn refuse_existing(port: u16, data: &Path) -> String {
    let record = read_pid_file(&pid_file_path(data));
    match record {
        Some(pid) if pid_is_alive(pid.shell) => format!(
            "Phosphor is already running as process {} and holding 127.0.0.1:{port}. \
             Use that window rather than opening a second one.",
            pid.shell
        ),
        Some(pid) if pid_is_alive(pid.backend) => format!(
            "A Phosphor control app from an earlier session is still running as process {} and holding \
             127.0.0.1:{port}, with your wallet loaded and no window on it. \
             Quit it (`kill {}`) and start Phosphor again. This app will not attach to a backend it \
             did not start, because it could not shut that backend down afterwards.",
            pid.backend, pid.backend
        ),
        _ => format!(
            "Something is already answering as Phosphor on 127.0.0.1:{port} and this app did not start it. \
             Quit it (`pkill -f 'node src/main.ts'`) and try again, or set a different port in config.local.json."
        ),
    }
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

fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let payload = payload_dir(app)?;
    let data = data_dir(app)?;
    let port = configured_port(&payload, &data);

    // Anything already on the port is refused by name. `None` on purpose: the question here is
    // "is a Phosphor holding this port", which names a process to quit, and an instance from an
    // earlier boot answers with that boot's nonce rather than this one's. See refuse_existing.
    if phosphor_is_listening(port, None) {
        return Err(refuse_existing(port, &data));
    }
    if get_root(port).is_some() {
        return Err(format!(
            "Port {port} is already in use by something that is not Phosphor. Free it, or set a different port in config.local.json."
        ));
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

            if let Err(err) = start(&handle) {
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
    use super::{connection_line_from, probe_interval, FAST_PROBE_INTERVAL, FAST_PROBE_WINDOW, SLOW_PROBE_INTERVAL};
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

    #[test]
    fn the_fast_cadence_cannot_add_more_than_it_saves() {
        // The dead time a probe granularity adds is bounded by the interval itself, and the
        // backend answers in 250 to 450 ms, which is inside the fast window.
        assert!(FAST_PROBE_INTERVAL < SLOW_PROBE_INTERVAL);
        assert!(FAST_PROBE_WINDOW > Duration::from_millis(450));
    }
}
