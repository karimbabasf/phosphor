// The control app as a supervised child: how it is started, how it is proved to be ours, how it
// is talked to, and how it is guaranteed to die when this shell does.
//
// Everything here exists because of one failure. `Backend` had no Drop guard, so a force-quit or
// an aborting panic left node listening on 4177 with the wallet loaded. The next launch found the
// port answering, opened a window onto that orphan without ever holding its `Child`, and from
// then on every quit called kill() on a `None` and returned. The orphan survived until reboot.
//
// Two changes close it. A pid file written at spawn says which process this shell owns, so a
// launch that finds the port already answering can tell "my own instance" from "an orphan from
// last time" and refuse by name instead of adopting something it cannot stop. And Drop, so the
// only way to leak a backend now is SIGKILL of the shell itself.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 4177;
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(700);

/// What the control app gets to shut itself and its agent down in before it is taken out. It
/// needs one SIGTERM round trip of its own (see TERM_GRACE_MS in src/driver.ts), so this is that
/// plus room, and it is short enough that a quit still feels like a quit.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

const PID_FILE: &str = "backend.pid";

/// The backend process and the pid file that names it.
///
/// Both are behind their own lock so a panic while reporting one cannot strand the other.
pub struct Backend {
    child: Mutex<Option<Child>>,
    pid_file: Mutex<Option<PathBuf>>,
}

/// Who is running, according to the file on disk. `shell` is the desktop app that spawned the
/// backend; `backend` is node. Both are needed: a live backend with a dead shell is the orphan
/// case, and a live shell is another copy of this app.
pub struct PidRecord {
    pub shell: i32,
    pub backend: i32,
}

impl Backend {
    pub fn new() -> Self {
        Backend {
            child: Mutex::new(None),
            pid_file: Mutex::new(None),
        }
    }

    /// Asked to leave, then made to leave.
    ///
    /// This used to be `child.kill()` and nothing else, which on unix is SIGKILL and only
    /// SIGKILL. A process cannot clean up after a signal it never receives, and the control app
    /// has real cleanup to do: the agent it spawns is a DETACHED Claude Code process, kept
    /// detached on purpose so the whole group can be signalled at once. SIGKILL the backend and
    /// that group is orphaned to launchd, still running, still holding several hundred megabytes,
    /// with no window left that could stop it. Every quit leaked one and they accumulated until
    /// the machine was rebooted.
    ///
    /// So SIGTERM first, which src/shutdown.ts handles by draining its writes, awaiting whatever
    /// is in flight and taking its own child down, and SIGKILL only as the backstop.
    pub fn kill(&self) {
        self.clear_pid_file();
        let Ok(mut guard) = lock(&self.child) else {
            return;
        };
        let Some(mut child) = guard.take() else {
            return;
        };
        request_stop(&child);
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    pub fn adopt(&self, child: Child, pid_file: PathBuf) {
        let pid = child.id();
        if let Ok(mut guard) = lock(&self.child) {
            guard.replace(child);
        }
        write_pid_file(&pid_file, pid as i32);
        if let Ok(mut guard) = lock(&self.pid_file) {
            guard.replace(pid_file);
        }
    }

    /// Has the child exited? `None` means there is no child at all, which is a different answer
    /// from "still running" and the caller has to tell them apart.
    pub fn exited(&self) -> Option<bool> {
        let mut guard = lock(&self.child).ok()?;
        let child = guard.as_mut()?;
        Some(matches!(child.try_wait(), Ok(Some(_))))
    }

    fn clear_pid_file(&self) {
        if let Ok(mut guard) = lock(&self.pid_file) {
            if let Some(path) = guard.take() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// The guarantee the comment in the old code asked for and the code never made.
///
/// Tauri's RunEvent::Exit already calls kill() on an ordinary quit; this covers the paths that do
/// not raise it: an aborting panic that still unwinds the state, and any future exit path that
/// forgets. A backend outliving its only approval surface is the one outcome worth a Drop guard.
impl Drop for Backend {
    fn drop(&mut self) {
        self.kill();
    }
}

// A panic elsewhere must not strand the child, so a poisoned lock is recovered rather than
// propagated: shutting the backend down matters more than the lock.
fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, ()> {
    match m.lock() {
        Ok(guard) => Ok(guard),
        Err(poisoned) => Ok(poisoned.into_inner()),
    }
}

/// SIGTERM to the control app, so it can drain and take the agent it spawned down before it goes.
#[cfg(unix)]
fn request_stop(child: &Child) {
    // SAFETY: kill(2) with a pid this process owns and a valid signal. A child that has already
    // exited returns ESRCH, which is the outcome asked for rather than an error.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
}

/// Windows has no SIGTERM. The graceful half of the shutdown is a unix story, and the wait in
/// kill() still gives a child that is leaving on its own the time to finish.
#[cfg(not(unix))]
fn request_stop(_child: &Child) {}

/// Does that process still exist? Signal 0 performs the existence and permission checks and
/// delivers nothing. EPERM counts as alive: it is a running process owned by somebody else.
#[cfg(unix)]
pub fn pid_is_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill(2) with signal 0 delivers nothing and only reports whether the pid exists.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn pid_is_alive(_pid: i32) -> bool {
    // Without a cheap existence check the safe answer is "assume it is there", which makes the
    // launch refuse rather than adopt. Refusing is the recoverable half of the two.
    true
}

pub fn pid_file_path(data: &Path) -> PathBuf {
    data.join(PID_FILE)
}

fn write_pid_file(path: &Path, backend: i32) {
    let body = serde_json::json!({ "shell": std::process::id(), "backend": backend });
    // Best effort. A pid file that cannot be written costs the NEXT launch its ability to name
    // the process holding the port, and that launch refuses either way.
    let _ = std::fs::write(path, body.to_string());
}

pub fn read_pid_file(path: &Path) -> Option<PidRecord> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(PidRecord {
        shell: parsed.get("shell")?.as_i64()? as i32,
        backend: parsed.get("backend")?.as_i64()? as i32,
    })
}

/// 32 random bytes as hex, for the window token.
///
/// /dev/urandom rather than a crate. The tree here is deliberately thin (see Cargo.toml), and
/// this is one read of one file. It is not the clock and not the pid: this value is the only
/// thing standing between a local process and the approval surface, so it has to be unguessable.
#[cfg(unix)]
pub fn mint_token() -> Result<String, String> {
    use std::fs::File;
    let mut file = File::open("/dev/urandom").map_err(|e| format!("no random source: {e}"))?;
    let mut bytes = [0u8; 32];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("could not read a random token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(not(unix))]
pub fn mint_token() -> Result<String, String> {
    Err("Phosphor's desktop shell needs a random source and only supports unix today".to_string())
}

/// One request to loopback, hand-rolled. The Host header is set to the address actually dialled,
/// which is what src/http/auth.ts requires: a DNS-rebinding page cannot produce that header, and
/// a client that omits it is refused.
fn request(port: u16, head: &str, body: Option<&str>) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(PROBE_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(PROBE_TIMEOUT)).ok()?;
    stream.write_all(head.as_bytes()).ok()?;
    if let Some(payload) = body {
        stream.write_all(payload.as_bytes()).ok()?;
    }
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out);
    let _ = stream.shutdown(Shutdown::Both);
    Some(String::from_utf8_lossy(&out).into_owned())
}

pub fn get_root(port: u16) -> Option<String> {
    let head = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    request(port, &head, None)
}

/// Ask the backend to lock the wallet. Best effort by design: the route belongs to the custody
/// track and may not exist yet, so a 404 here is a perfectly good outcome. What matters is that
/// closing the window is not silently a wallet left open.
pub fn post_lock(port: u16, token: &str) -> bool {
    let body = serde_json::json!({ "token": token }).to_string();
    let head = format!(
        "POST /api/lock HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    request(port, &head, Some(&body)).is_some_and(|out| out.starts_with("HTTP/1.1 2"))
}

/// Whether what answers on this port is Phosphor. The served page titles itself, which is enough
/// to tell "a Phosphor is already up" apart from "something else owns this port", and those two
/// cases must not be treated the same: the first names a process to quit, the second a port to
/// free.
pub fn phosphor_is_listening(port: u16) -> bool {
    get_root(port).is_some_and(|body| body.contains("<title>PHOSPHOR</title>"))
}

/// Reads the port the way src/config.ts does, and only the port.
///
/// This duplicates a few lines of the TypeScript on purpose. The launcher has to know where to
/// probe before it has a process to ask, and the alternative, parsing the child's stdout, cannot
/// answer the question that comes first: is an instance already running there?
pub fn configured_port(payload: &Path, data: &Path) -> u16 {
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

/// The bundled Node runtime. Tauri puts externalBin next to this executable, so it is found
/// relative to the running binary rather than by searching a PATH that may hold anything.
pub fn node_binary() -> Result<PathBuf, String> {
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

/// Start the control app. The window token goes over the environment, which is the one channel
/// between these two processes that no other local process can read out of the app afterwards:
/// it is never served over HTTP and never written to disk.
pub fn spawn_backend(payload: &Path, data: &Path, token: &str) -> Result<Child, String> {
    let node = node_binary()?;
    Command::new(&node)
        .arg(payload.join("src").join("main.ts"))
        .current_dir(payload)
        .env("PHOSPHOR_DATA_DIR", data.join("state"))
        .env("PHOSPHOR_CONFIG_DIR", data)
        .env("PHOSPHOR_WINDOW_TOKEN", token)
        // Inherited so a crash on boot is readable in Console.app rather than swallowed.
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start the control app with {node:?}: {e}"))
}
