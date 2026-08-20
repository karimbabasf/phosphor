// Phosphor's desktop shell.
//
// This binary is a launcher and a window, and deliberately nothing else. It starts the Node
// control app that ships inside the bundle, waits for it to bind its loopback port, and points
// a webview at it. Every decision the product makes about money, policy and approval happens in
// that Node process, exactly as it does when the repo is run with `npm run app`.
//
// The window is a plain remote page on http://127.0.0.1, not a Tauri-served asset. Two reasons,
// and the second one is the important one:
//
//   1. src/server.ts refuses any request whose Host header is not loopback, and it checks a
//      session token on writes. Serving the UI from tauri://localhost would make every call
//      cross-origin and force that model to be rebuilt. This way it is untouched.
//   2. A remote webview has no Tauri IPC bridge. There is no command surface for a compromised
//      page to reach, so the native side cannot be driven from the page at all. That is why the
//      MCP config lives on a native menu item rather than a button in the UI: the menu is on the
//      side of the trust boundary the agent can never reach.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const DEFAULT_PORT: u16 = 4177;
const READY_TIMEOUT: Duration = Duration::from_secs(45);
const PROBE_TIMEOUT: Duration = Duration::from_millis(700);
const COPY_MCP_ID: &str = "copy-mcp-config";

/// The backend process, held so it can be killed when the app quits. A Phosphor left running
/// after its window closed would keep a funded wallet's control surface listening on loopback
/// with nothing on screen to show it, which is the one outcome worth writing a Drop-guard for.
struct Backend(Mutex<Option<Child>>);

impl Backend {
    fn kill(&self) {
        if let Ok(mut guard) = self.lock_or_recover() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    // A panic elsewhere must not be able to strand the child process, so a poisoned lock is
    // recovered rather than propagated: shutting the backend down matters more than the lock.
    fn lock_or_recover(&self) -> Result<std::sync::MutexGuard<'_, Option<Child>>, ()> {
        match self.0.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => Ok(poisoned.into_inner()),
        }
    }
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

/// The bundled Node runtime. Tauri puts externalBin next to this executable, so it is found
/// relative to the running binary rather than by searching a PATH that may hold anything.
fn node_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate the running binary: {e}"))?;
    let node = exe
        .parent()
        .ok_or_else(|| "the running binary has no parent directory".to_string())?
        .join("node");
    if !node.is_file() {
        return Err(format!("the bundled Node runtime is missing at {node:?}"));
    }
    Ok(node)
}

/// Reads the port the way src/config.ts does, and only the port.
///
/// This duplicates a few lines of the TypeScript on purpose. The launcher has to know where to
/// probe before it has a process to ask, and the alternative, parsing the child's stdout, cannot
/// answer the question that comes first: is an instance already running there?
fn configured_port(payload: &Path, data: &Path) -> u16 {
    fn port_in(file: PathBuf) -> Option<u16> {
        let raw = std::fs::read_to_string(file).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
        parsed.get("port")?.as_u64()?.try_into().ok()
    }
    if let Ok(env) = std::env::var("PHOSPHOR_PORT") {
        if let Ok(port) = env.parse::<u16>() {
            return port;
        }
    }
    // config.local.json wins over the committed template, matching the merge order in loadConfig.
    port_in(data.join("config.local.json"))
        .or_else(|| port_in(payload.join("config.json")))
        .unwrap_or(DEFAULT_PORT)
}

/// One GET to loopback, hand-rolled. The Host header is set to the address actually dialled,
/// which is what src/server.ts requires: a DNS-rebinding page cannot produce that header, and a
/// client that omits it is refused.
fn get_root(port: u16) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(PROBE_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(PROBE_TIMEOUT)).ok()?;
    let request =
        format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut body = Vec::new();
    let _ = stream.read_to_end(&mut body);
    let _ = stream.shutdown(Shutdown::Both);
    Some(String::from_utf8_lossy(&body).into_owned())
}

/// Whether what answers on this port is Phosphor. The served page titles itself, which is enough
/// to tell "my own instance is already up" apart from "something else owns this port", and those
/// two cases must not be treated the same: the first should show a window, the second must stop.
fn phosphor_is_listening(port: u16) -> bool {
    get_root(port).is_some_and(|body| body.contains("<title>PHOSPHOR</title>"))
}

fn spawn_backend(app: &tauri::AppHandle, payload: &Path, data: &Path) -> Result<Child, String> {
    let node = node_binary()?;
    Command::new(&node)
        .arg(payload.join("src").join("main.ts"))
        .current_dir(payload)
        .env("PHOSPHOR_DATA_DIR", data.join("state"))
        .env("PHOSPHOR_CONFIG_DIR", data)
        // Inherited so a crash on boot is readable in Console.app rather than swallowed.
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| {
            let _ = app;
            format!("could not start the control app with {node:?}: {e}")
        })
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

/// Reports a startup failure and quits once it has been read. Same main-thread rule as above:
/// the exit is deferred into the dismissal callback rather than taken after a blocking call.
fn fail(app: &tauri::AppHandle, message: String) {
    eprintln!("phosphor: {message}");
    let handle = app.clone();
    app.dialog()
        .message(message)
        .kind(MessageDialogKind::Error)
        .title("Phosphor could not start")
        .show(move |_| handle.exit(1));
}

/// Replaces the splash with the real window. Created rather than navigated, so the page holding
/// the approval surface gets a webview of its own that was never on a Tauri origin.
fn open_control_window(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("cannot parse the control app URL: {e}"))?;
    WebviewWindowBuilder::new(app, "control", WebviewUrl::External(url))
        .title("PHOSPHOR")
        .inner_size(1180.0, 780.0)
        .min_inner_size(900.0, 620.0)
        .center()
        .resizable(true)
        .build()
        .map_err(|e| format!("cannot open the control window: {e}"))?;
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    Ok(())
}

fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let payload = payload_dir(app)?;
    let data = data_dir(app)?;
    let port = configured_port(&payload, &data);

    // An instance is already up. Show a window onto it and start nothing: two backends on one
    // state directory would race over the audit log and the policy file.
    if phosphor_is_listening(port) {
        return open_control_window(app, port);
    }
    // Somebody else owns the port. Refuse rather than spawn a backend that will fail to bind and
    // leave the window pointed at a stranger's server.
    if get_root(port).is_some() {
        return Err(format!(
            "Port {port} is already in use by something that is not Phosphor. Free it, or set a different port in config.local.json."
        ));
    }

    let child = spawn_backend(app, &payload, &data)?;
    app.state::<Backend>()
        .lock_or_recover()
        .map_err(|_| "backend lock".to_string())?
        .replace(child);

    // Polled on a worker so the event loop keeps running and the splash keeps painting.
    let handle = app.clone();
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
                return;
            }
            // The child exiting means the backend refused to boot; its reason is already on stderr.
            if let Ok(mut guard) = handle.state::<Backend>().lock_or_recover() {
                if let Some(child) = guard.as_mut() {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        let dead = handle.clone();
                        let _ = dead.clone().run_on_main_thread(move || {
                            fail(&dead, "The control app stopped while starting up. Its error is in Console.app under Phosphor.".to_string());
                        });
                        return;
                    }
                }
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend(Mutex::new(None)))
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
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                app.state::<Backend>().kill();
            }
        });
}
