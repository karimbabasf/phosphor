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
// THE WINDOW TOKEN. This shell mints 32 random bytes, hands them to the backend over the
// environment as PHOSPHOR_WINDOW_TOKEN, and injects them into the control webview alone with an
// initialization script. The token is therefore reachable by exactly two processes and served
// over HTTP by neither. That is what replaces `GET /api/session`, which handed the approval token
// to any local caller that asked and made "an agent cannot approve its own actions" untrue for
// anything with a shell.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use backend::{
    configured_port, get_root, mint_token, node_binary, phosphor_is_listening, pid_file_path,
    pid_is_alive, post_lock, read_pid_file, spawn_backend, Backend,
};

const READY_TIMEOUT: Duration = Duration::from_secs(45);
const COPY_MCP_ID: &str = "copy-mcp-config";

/// How often the supervisor asks whether the backend is still there. Two seconds is well under
/// the time it takes a person to notice a dead window and long enough that the poll costs
/// nothing.
const WATCH_INTERVAL: Duration = Duration::from_secs(2);
/// A backend that dies after boot is respawned exactly once. Twice would be a crash loop, and a
/// crash loop in front of a wallet is worse than a stopped app with a sentence on it.
const RESPAWN_BACKOFF: Duration = Duration::from_secs(3);

/// The token this shell minted, held so the window can be given it and the close handler can use
/// it. Never written to disk and never served.
struct WindowToken(String);

/// Everything `start` resolved, so the supervisor thread does not have to resolve it again.
#[derive(Clone)]
struct Paths {
    payload: PathBuf,
    data: PathBuf,
}

/// Where the app keeps everything it writes. The bundle is read-only, so state, the audit log,
/// the policy file and config.local.json all live here instead. Keys are not among them: they
/// stay at ~/.phosphor/, outside every working copy and every bundle, as they always have.
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no application support directory: {e}"))?;
    std::fs::create_dir_all(dir.join("state")).map_err(|e| format!("cannot create {dir:?}: {e}"))?;
    Ok(dir)
}

/// The payload directory: the old repo root, shipped verbatim.
fn payload_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

/// The `claude mcp add-json` line for this installation, with the real paths filled in.
///
/// src/mcp.ts resolves its port from the committed config.json beside it, which would miss a port
/// changed in the installed config.local.json, so the port is pinned explicitly here instead.
fn mcp_command(payload: &Path, port: u16) -> Result<String, String> {
    let node = node_binary()?;
    let server = serde_json::json!({
        "command": node.to_string_lossy(),
        "args": [payload.join("src").join("mcp.ts").to_string_lossy()],
        "env": { "PHOSPHOR_PORT": port.to_string() },
    });
    Ok(format!(
        "claude mcp add-json phosphor '{}'",
        serde_json::to_string(&server).map_err(|e| e.to_string())?
    ))
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let copy = MenuItem::with_id(app, COPY_MCP_ID, "Copy MCP Config", true, None::<&str>)?;
    let app_menu = Submenu::with_items(
        app,
        "Phosphor",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
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
    Menu::with_items(app, &[&app_menu, &edit_menu])
}

fn on_menu(app: &tauri::AppHandle, event: MenuEvent) {
    if event.id() != COPY_MCP_ID {
        return;
    }
    let result = payload_dir(app).and_then(|payload| {
        let data = data_dir(app)?;
        let port = configured_port(&payload, &data);
        let command = mcp_command(&payload, port)?;
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
    let token = app.state::<WindowToken>().0.clone();
    // The token is hex from mint_token, so it cannot carry a quote or a backslash and the literal
    // below cannot be broken out of. Asserted rather than assumed: a token that is not hex is a
    // bug in mint_token, and injecting it would be worse than refusing to open the window.
    if !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the window token is not hex, so it will not be injected".to_string());
    }
    let script = format!("window.__PHOSPHOR_TOKEN__ = \"{token}\";");

    let window = WebviewWindowBuilder::new(app, "control", WebviewUrl::External(url))
        .title("PHOSPHOR")
        .inner_size(1180.0, 780.0)
        .min_inner_size(900.0, 620.0)
        .center()
        .resizable(true)
        .initialization_script(&script)
        .build()
        .map_err(|e| format!("cannot open the control window: {e}"))?;

    /* Closing the window locks the wallet. The window is the only surface that can approve
       anything, so a window that is gone and a wallet that is open is a combination with no
       legitimate use. The route belongs to the custody track and may not exist yet; a 404 is a
       perfectly good outcome and this stays best effort either way. Off the main thread, because
       it is a socket round trip and this handler runs on the event loop. */
    let lock_token = app.state::<WindowToken>().0.clone();
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
        let token = app.state::<WindowToken>().0.clone();
        match spawn_backend(&paths.payload, &paths.data, &token) {
            Ok(child) => {
                app.state::<Backend>().adopt(child, pid_file_path(&paths.data));
                // Wait for it to bind before saying it is back. "Restarted" over a process that
                // spawned and then failed to listen is the same lie as the silent death this
                // whole thread exists to end.
                let deadline = Instant::now() + READY_TIMEOUT;
                let mut answered = false;
                while Instant::now() < deadline {
                    if phosphor_is_listening(port) {
                        answered = true;
                        break;
                    }
                    if matches!(app.state::<Backend>().exited(), Some(true)) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
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

    // Anything already on the port is refused by name. See refuse_existing.
    if phosphor_is_listening(port) {
        return Err(refuse_existing(port, &data));
    }
    if get_root(port).is_some() {
        return Err(format!(
            "Port {port} is already in use by something that is not Phosphor. Free it, or set a different port in config.local.json."
        ));
    }

    let token = app.state::<WindowToken>().0.clone();
    let child = spawn_backend(&payload, &data, &token)?;
    app.state::<Backend>().adopt(child, pid_file_path(&data));

    // Polled on a worker so the event loop keeps running and the splash keeps painting. The same
    // thread goes on to supervise, so there is no gap between "it came up" and "somebody is
    // watching it".
    let handle = app.clone();
    let paths = Paths { payload, data };
    std::thread::spawn(move || {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if phosphor_is_listening(port) {
                let ready = handle.clone();
                let _ = ready.clone().run_on_main_thread(move || {
                    if let Err(err) = open_control_window(&ready, port) {
                        fail(&ready, err);
                    }
                });
                watch(handle, paths, port);
                return;
            }
            // The child exiting means the backend refused to boot; its reason is already on
            // stderr. It names the two refusals that have a fix the person can act on.
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
            std::thread::sleep(Duration::from_millis(250));
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

fn main() {
    // Minted before anything else, because the backend cannot be spawned without it and the
    // window cannot be opened without it. A shell that cannot produce one starts nothing: a
    // guessable token would be no token at all.
    let token = match mint_token() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("phosphor: {err}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend::new())
        .manage(WindowToken(token))
        .setup(|app| {
            let handle = app.handle().clone();
            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(on_menu);

            WebviewWindowBuilder::new(&handle, "splash", WebviewUrl::App("index.html".into()))
                .title("PHOSPHOR")
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
