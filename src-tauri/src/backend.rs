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

/// The three secrets this shell mints per boot and hands to the backend down one pipe.
///
/// `token` is the approval token, injected into the control webview and checked on every write.
/// `nonce` is how this shell recognises its OWN backend: the backend echoes it in the x-phosphor
/// header and nowhere else, so a local process that grabs the port cannot answer with it.
/// `seat` is the roster handshake secret, which the backend passes to the agents it spawns so a
/// seat claimed from outside cannot fill the roster the human's own agent needs.
///
/// All three are separate values. A secret reused for a second purpose is a secret whose exposure
/// in the weaker place costs you the stronger one, and the nonce is deliberately public.
pub struct Handshake {
    pub token: String,
    pub nonce: String,
    pub seat: String,
}

impl Handshake {
    pub fn mint() -> Result<Self, String> {
        Ok(Handshake {
            token: mint_token()?,
            nonce: mint_token()?,
            seat: mint_token()?,
        })
    }
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
///
/// `reason` lands in the audit line. "the window closed" and "the machine slept" are different
/// facts about the same lock, and a log that records only that a lock happened cannot answer the
/// question somebody asks it afterwards, which is why.
pub fn post_lock(port: u16, token: &str, reason: &str) -> bool {
    let body = serde_json::json!({ "token": token, "reason": reason }).to_string();
    let head = format!(
        "POST /api/lock HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    request(port, &head, Some(&body)).is_some_and(|out| out.starts_with("HTTP/1.1 2"))
}

/// The value of one header in a raw HTTP response, lowercased by the caller.
fn header_value<'a>(lowered: &'a str, name: &str) -> Option<&'a str> {
    lowered
        .lines()
        .find_map(|line| line.strip_prefix(name))
        .map(str::trim)
}

/// Does this response come from the backend this shell started?
///
/// TWO QUESTIONS, AND THEY WERE THE SAME FUNCTION UNTIL NOW. "Is a Phosphor on this port" names a
/// process to quit. "Is MY backend on this port" gates the window, which is where the approval
/// token gets injected. Answering the second with the first is what made the check defeatable: the
/// marker used to be the fixed string `x-phosphor: control`, which any server can send, so a local
/// process that took the port during the boot race or the respawn backoff was handed the token and
/// then the keystore passphrase, in a window titled PHOSPHOR.
///
/// So `nonce` decides which question is being asked. `None` accepts any Phosphor-shaped answer and
/// is only used where the next thing that happens is a refusal by name. `Some` requires the header
/// to carry the value this shell minted this boot and gave the backend over its stdin, which is a
/// channel no other process can read and no other process can guess.
///
/// The marker is still a header rather than the page's <title>, and that half has not changed: a
/// retitle of ui/index.html once left this polling a healthy server it could not recognise and the
/// app died on a 45-second timeout with nothing wrong with it. Header names are case-insensitive
/// on the wire, so the match is too, and the value is hex.
pub fn identity_matches(response: &str, nonce: Option<&str>) -> bool {
    let lowered = response.to_ascii_lowercase();
    let Some(value) = header_value(&lowered, "x-phosphor:") else {
        return false;
    };
    match nonce {
        None => true,
        Some(want) => value == want.to_ascii_lowercase(),
    }
}

pub fn phosphor_is_listening(port: u16, nonce: Option<&str>) -> bool {
    get_root(port).is_some_and(|res| identity_matches(&res, nonce))
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

/// Start the control app.
///
/// THE HANDSHAKE GOES OVER STDIN, three lines, and the pipe is closed behind them. It used to be
/// one value over the environment, which is not a channel between two processes at all: `ps eww
/// <pid>` prints the environment of any process this user owns, which is the attacker this app is
/// built against. A local process read the token back and drove the kill switch, the idle beacon
/// and approve on a real pending proposal, which the audit then recorded as a human's click. A
/// signed hardened runtime does not close that either. It is the same channel and the same
/// argument the runner already uses for the Hyperliquid API wallet key.
///
/// Line 1 is the window token, line 2 the boot nonce, line 3 the roster seat secret. Order is the
/// contract; src/main.ts reads them in it. A backend started with no pipe at all is a developer
/// running `npm run app`, and it mints what it needs and says so.
pub fn spawn_backend(payload: &Path, data: &Path, hand: &Handshake) -> Result<Child, String> {
    let node = node_binary()?;
    let mut child = Command::new(&node)
        .arg(payload.join("src").join("main.ts"))
        .current_dir(payload)
        .env("PHOSPHOR_DATA_DIR", data.join("state"))
        .env("PHOSPHOR_CONFIG_DIR", data)
        // This data directory is the app's OWN, not a scratch one somebody pointed at. The
        // backend derives the key file from the data directory now, so that a demo or test
        // instance gets its own empty wallet instead of the owner's; saying so here is what
        // keeps the installed app reading the key file in ~/.phosphor that it always has.
        // It is also how the backend knows a missing token is a failure rather than a developer
        // running it by hand. See defaultKeysPath and readWindowToken.
        .env("PHOSPHOR_APP_DATA", "1")
        // Inherited so a crash on boot is readable in Console.app rather than swallowed.
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the control app with {node:?}: {e}"))?;

    // Taken and dropped, so the pipe closes as soon as the lines are written: the backend reads the
    // handshake and wants nothing else from stdin ever again.
    match child.stdin.take() {
        Some(mut pipe) => writeln!(pipe, "{}\n{}\n{}", hand.token, hand.nonce, hand.seat)
            .map_err(|e| format!("could not hand the handshake to the control app: {e}"))?,
        None => return Err("the control app was started with no stdin to hand the handshake to".into()),
    }
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A server that answers `GET /` with one `x-phosphor` header and the value it was given.
    /// This is the attacker in variant A and B of the finding: any local process can send the
    /// header, and until the nonce existed that was enough to be handed the window token.
    fn stub(value: &'static str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind a loopback port");
        let port = listener.local_addr().expect("read the bound port").port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let Ok(mut sock) = stream else { continue };
                let mut scratch = [0u8; 1024];
                let _ = sock.read(&mut scratch);
                let res = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Phosphor: {value}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = sock.write_all(res.as_bytes());
                let _ = sock.shutdown(Shutdown::Both);
            }
        });
        port
    }

    #[test]
    fn a_squatter_sending_the_old_fixed_marker_is_not_this_shells_backend() {
        let port = stub("control");
        assert!(
            phosphor_is_listening(port, None),
            "it is still Phosphor-shaped, which is what names a process to quit"
        );
        assert!(
            !phosphor_is_listening(port, Some("a1b2c3d4")),
            "but it is not the backend this shell started, so no window may open onto it"
        );
    }

    #[test]
    fn the_backend_that_echoes_this_boots_nonce_is_recognised() {
        let port = stub("a1b2c3d4");
        assert!(phosphor_is_listening(port, Some("a1b2c3d4")));
        assert!(
            phosphor_is_listening(port, Some("A1B2C3D4")),
            "header values are compared case-insensitively, as the names are"
        );
        assert!(!phosphor_is_listening(port, Some("a1b2c3d5")), "one character off is not ours");
    }

    #[test]
    fn nothing_on_the_port_is_never_a_match() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind a loopback port");
        let port = listener.local_addr().expect("read the bound port").port();
        drop(listener);
        assert!(!phosphor_is_listening(port, None));
        assert!(!phosphor_is_listening(port, Some("a1b2c3d4")));
    }

    #[test]
    fn a_response_with_no_marker_at_all_is_never_a_match() {
        let res = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n";
        assert!(!identity_matches(res, None));
        assert!(!identity_matches(res, Some("a1b2c3d4")));
    }
}
