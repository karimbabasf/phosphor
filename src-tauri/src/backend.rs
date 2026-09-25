// The control app as a supervised child: how it is started, how it is proved to be ours, how it
// is talked to, and how it is guaranteed to die when this shell does.
//
// Everything here exists because of one failure. `Backend` had no Drop guard, so a force-quit or
// an aborting panic left node listening on 4177 with the wallet loaded. The next launch found the
// port answering, opened a window onto that orphan without ever holding its `Child`, and from
// then on every quit called kill() on a `None` and returned. The orphan survived until reboot.
//
// Two changes close it. A pid file written at spawn says which process this shell owns, so a
// launch that finds the port already answering can tell "another copy of this app" from "an
// orphan from last time" and deal with each (bring the copy forward, stop the orphan it can prove
// is one) instead of adopting something it cannot stop. And Drop, so the only way to leak a
// backend now is SIGKILL of the shell itself, and the next launch cleans that one up.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 4177;
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(700);

/// What the control app gets to shut itself and its agent down in before it is taken out.
///
/// This was three seconds, sized to the driver's own SIGTERM round trip, and it was wrong by an
/// order of magnitude: src/shutdown.ts waits for a venue write in flight for up to SETTLE_CAP_MS
/// (a 30 s venue timeout plus 2 s), and a SIGKILL at 3 s cut that write at an arbitrary point,
/// left the proposal `executing` with nothing in the audit log saying why, and orphaned the agent
/// group the close step takes down. So this is that cap plus room. It costs nothing on an idle
/// quit: `serialise.idle()` resolves at once and the process exits in the same second it always
/// did. The wait is only ever paid when money is moving, which is exactly when it must be.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(35);
/// The number above must clear, kept here so the test reads it beside the constant.
#[cfg(test)]
const SETTLE_CAP_MS_IN_SHUTDOWN_TS: u64 = 32_000;

const PID_FILE: &str = "backend.pid";

/// The backend process and the pid file that names it.
///
/// Both are behind their own lock so a panic while reporting one cannot strand the other.
pub struct Backend {
    child: Mutex<Option<Child>>,
    pid_file: Mutex<Option<PathBuf>>,
    /// Set the moment kill() begins and never cleared: this shell has decided to stop its
    /// backend, so a respawn that lands afterwards (the supervisor was mid-respawn when an
    /// update finished installing) must not be kept. See adopt().
    stopping: AtomicBool,
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
            stopping: AtomicBool::new(false),
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
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_child();
    }

    /// Takes down a backend that failed, before Try again spawns the next one: the same stop as
    /// kill(), without deciding to stop for good, so adopt() and the supervisor go on as before.
    /// A child that already exited returns at once.
    pub fn stop_for_retry(&self) {
        self.stop_child();
    }

    // The lock is held for the whole stop, so a second caller waits for it to finish rather than
    // finding no child and returning while this one is still draining.
    fn stop_child(&self) {
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

    /// Has kill() been called? The supervisor asks before it respawns and stops when it has.
    pub fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    pub fn adopt(&self, child: Child, pid_file: PathBuf) {
        // A child spawned after the decision to stop is taken down here, not kept: the shell is
        // about to exit (an update relaunch), and a backend adopted now would outlive it with
        // the wallet loaded and no window, the orphan this whole file exists to prevent.
        if self.stopping() {
            let mut late = child;
            request_stop(&late);
            let _ = late.kill();
            let _ = late.wait();
            return;
        }
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

pub fn write_pid_file(path: &Path, backend: i32) {
    let body = serde_json::json!({ "shell": std::process::id(), "backend": backend });
    // Best effort. A pid file that cannot be written costs the NEXT launch its ability to
    // recognise the process holding the port, and that launch refuses rather than guess.
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

/// The command line spawn_backend gives the control app is these two paths, each behind the path
/// of the app bundle it runs from: the bundled runtime, then the payload's entry point. Nothing
/// else on this Mac has a reason to run exactly that.
const RUNTIME_IN_BUNDLE: &str = "/Contents/MacOS/node ";
const PAYLOAD_IN_BUNDLE: &str = "/Contents/Resources/phosphor/src/main.ts";

/// Is `pid` a control app that some copy of this app started and then lost, still running with
/// no shell above it?
///
/// Three facts, all of them, and never the port: its parent is launchd (pid 1), which is where
/// macOS puts a process whose parent died, so a backend a live shell still watches never
/// qualifies; its command line is spawn_backend's, the runtime and the payload of one app bundle;
/// and that bundle declares this app's identifier. A checkout's `node src/main.ts`, the MCP proxy,
/// an agent, and whatever a recycled pid now belongs to each fail at least one of them. Any copy
/// of this app counts, not only this one: the copy macOS runs from the disk image lives at a
/// random path of its choosing, and the copy in Applications is another bundle again.
pub fn is_orphaned_backend(pid: i32, identifier: &str) -> bool {
    if pid <= 1 || !pid_is_alive(pid) {
        return false;
    }
    let Some((parent, command)) = parent_and_command(pid) else {
        return false;
    };
    parent == 1
        && backend_bundles(&command)
            .and_then(|(runtime, payload)| one_bundle(&runtime, &payload))
            .and_then(|bundle| bundle_identifier(&bundle))
            .is_some_and(|declared| declared == identifier)
}

/// Stops an orphaned backend the way kill() stops this shell's own: SIGTERM first, so
/// src/shutdown.ts drains a write in flight and takes its agent down with it, and SIGKILL only
/// once the same grace is spent. The pid is proved to be the orphan again before each signal,
/// because the survey that found it and a thirty-five second grace are both long enough for a pid
/// to change hands. True when no orphan of this app is left at that pid, which is also the answer
/// for a pid that was never one: it is left alone.
#[cfg(unix)]
pub fn stop_orphan(pid: i32, identifier: &str) -> bool {
    for (signal, grace) in [(libc::SIGTERM, SHUTDOWN_GRACE), (libc::SIGKILL, Duration::from_secs(2))] {
        if !is_orphaned_backend(pid, identifier) {
            return true;
        }
        // SAFETY: kill(2) with a valid signal and a pid proved on the line above to be this app's
        // orphaned backend.
        if unsafe { libc::kill(pid as libc::pid_t, signal) } != 0 {
            // ESRCH, it went on its own; EPERM, it belongs to another account on this Mac, so it
            // is not this person's to stop, and waiting out a grace on it would only stall the
            // launch.
            return !pid_is_alive(pid);
        }
        let deadline = Instant::now() + grace;
        while pid_is_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    !is_orphaned_backend(pid, identifier)
}

#[cfg(not(unix))]
pub fn stop_orphan(_pid: i32, _identifier: &str) -> bool {
    // Never proved an orphan off unix (see parent_and_command), so there is nothing to stop.
    true
}

/// A process's parent and its whole command line, read with `ps` for the reason
/// src/instancelock.ts reads a start time with it: it is on every Mac and needs no unsafe. The
/// pid is the only argument that varies and it is a number.
#[cfg(unix)]
fn parent_and_command(pid: i32) -> Option<(i32, String)> {
    let out = Command::new("/bin/ps")
        .args(["-ww", "-o", "ppid=,args=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parent_and_command_from(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(unix))]
fn parent_and_command(_pid: i32) -> Option<(i32, String)> {
    None
}

/// `ps -o ppid=,args=` prints the parent right-aligned, a space, then the command line.
fn parent_and_command_from(out: &str) -> Option<(i32, String)> {
    let (parent, command) = out.lines().next()?.trim().split_once(' ')?;
    Some((parent.parse().ok()?, command.trim_start().to_string()))
}

/// The two bundle paths in a backend's command line, when it has exactly the shape spawn_backend
/// gives it and nothing after: `<bundle>/Contents/MacOS/node <bundle>/Contents/Resources/phosphor/src/main.ts`.
/// The caller proves the two are one bundle, and this app's. The line is cut at the runtime's own
/// path rather than at a space, because a bundle path may hold one ("/Volumes/Phosphor 0.9.2").
fn backend_bundles(command: &str) -> Option<(PathBuf, PathBuf)> {
    let (runtime, rest) = command.split_once(RUNTIME_IN_BUNDLE)?;
    let payload = rest.strip_suffix(PAYLOAD_IN_BUNDLE)?;
    if !runtime.starts_with('/') || !payload.starts_with('/') {
        return None;
    }
    Some((PathBuf::from(runtime), PathBuf::from(payload)))
}

/// One app bundle, however its path was spelled. Resolved rather than compared as text: the
/// runtime's path is the one macOS launched the shell by and the payload's is tauri's resolved
/// resource directory, and the two may spell one directory differently.
fn one_bundle(runtime: &Path, payload: &Path) -> Option<PathBuf> {
    let bundle = std::fs::canonicalize(runtime).ok()?;
    let same = std::fs::canonicalize(payload).ok()? == bundle;
    (same && bundle.extension().and_then(|e| e.to_str()) == Some("app")).then_some(bundle)
}

/// The identifier an app bundle declares in its Contents/Info.plist.
fn bundle_identifier(bundle: &Path) -> Option<String> {
    let info = plist::Value::from_file(bundle.join("Contents").join("Info.plist")).ok()?;
    info.as_dictionary()?.get("CFBundleIdentifier")?.as_string().map(str::to_string)
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

/// The four secrets this shell mints per boot and hands to the backend down one pipe.
///
/// `token` is the approval token, injected into the control webview and checked on every write.
/// `nonce` is how this shell recognises its OWN backend: the backend echoes it in the x-phosphor
/// header and nowhere else, so a local process that grabs the port cannot answer with it.
/// `seat` is the roster handshake secret, which the backend passes to the agents it spawns so a
/// seat claimed from outside cannot fill the roster the human's own agent needs.
/// `transport` is the key the Secure Enclave sidecar seals the wallet's data key under on its way
/// back to the backend over loopback, so a capture of that hop shows ciphertext. This shell hands
/// it to the sidecar and never uses it itself; see enclave.rs.
/// `relay` is what the enclave relay's two routes take instead of the window token. The window
/// holds the token and must not be able to play the shell: with the token alone a compromised
/// page could answer a presence check for a forget, or steal every handed-out request and fail
/// it. The page never sees this value; only this thread and the backend do.
///
/// All five are separate values. A secret reused for a second purpose is a secret whose exposure
/// in the weaker place costs you the stronger one, and the nonce is deliberately public.
pub struct Handshake {
    pub token: String,
    pub nonce: String,
    pub seat: String,
    pub transport: String,
    pub relay: String,
}

impl Handshake {
    pub fn mint() -> Result<Self, String> {
        Ok(Handshake {
            token: mint_token()?,
            nonce: mint_token()?,
            seat: mint_token()?,
            transport: mint_token()?,
            relay: mint_token()?,
        })
    }
}

/// One request to loopback, hand-rolled. The Host header is set to the address actually dialled,
/// which is what src/http/auth.ts requires: a DNS-rebinding page cannot produce that header, and
/// a client that omits it is refused.
fn request(port: u16, head: &str, body: Option<&str>) -> Option<String> {
    request_within(port, head, body, PROBE_TIMEOUT)
}

/// The same request with its own read deadline, for the one caller that waits on purpose: the
/// enclave relay's long poll, which the backend holds open until it has something to ask.
pub fn request_within(port: u16, head: &str, body: Option<&str>, read_timeout: Duration) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(read_timeout)).ok()?;
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

/// The backend's health answer, parsed. No token: /api/health is the one route that answers
/// anyone on loopback, and it says nothing a local caller could not already see.
pub fn get_health(port: u16) -> Option<serde_json::Value> {
    let head = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let raw = request(port, &head, None)?;
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b)?;
    serde_json::from_str(body.trim()).ok()
}

pub fn get_root(port: u16) -> Option<String> {
    let head = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    request(port, &head, None)
}

/// What the backend said to a lock asked for when idle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LockAnswer {
    Locked,
    /// A move is being sent. The wallet stays open for it, and the stop takes the key.
    Busy,
    /// No answer, or one this shell does not read (the drain's 503, a timeout, nothing on the
    /// port). Nothing is known to be locked.
    Unanswered,
}

/// Ask the backend to lock the wallet, unless a move is being sent. The backend decides in one
/// step (POST /api/lock with whenIdle, src/http/wallet.ts), because every signer reads the key
/// through keystore.keys(), which throws once it is locked: a lock landing under a move cuts it
/// partway. Every lock this shell sends is this one. It used to read /api/health first and then
/// lock, and a move could start between the two requests.
///
/// `reason` lands in the audit line. "the window closed" and "installing an update" are different
/// facts about the same lock, and a log that records only that a lock happened cannot answer the
/// question somebody asks it afterwards, which is why.
pub fn post_lock_when_idle(port: u16, token: &str, reason: &str) -> LockAnswer {
    let body = serde_json::json!({ "token": token, "reason": reason, "whenIdle": true }).to_string();
    let head = format!(
        "POST /api/lock HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    request(port, &head, Some(&body)).map_or(LockAnswer::Unanswered, |raw| lock_answer(&raw))
}

/// A refusal is a 200 with `ok: false` (the custody routes answer rather than error), so the
/// status line alone cannot say locked; the body does.
fn lock_answer(raw: &str) -> LockAnswer {
    if !raw.starts_with("HTTP/1.1 200") {
        return LockAnswer::Unanswered;
    }
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b.trim()).unwrap_or("");
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return LockAnswer::Unanswered;
    };
    match (parsed.get("ok").and_then(|v| v.as_bool()), parsed.get("code").and_then(|v| v.as_str())) {
        (Some(true), _) => LockAnswer::Locked,
        (Some(false), Some("busy")) => LockAnswer::Busy,
        _ => LockAnswer::Unanswered,
    }
}

/// The parts of a stop on purpose, each reported as it happens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StopStep {
    Locked,
    /// The lock was refused: a move is being sent, and the drain lets it finish.
    Sending,
    Stopping,
    Stopped,
}

impl Backend {
    /// The one way this shell stops its backend on purpose, for a quit from the sheet and an
    /// update's relaunch alike: the wallet locked when nothing is being sent, then the kill and
    /// its drain. A lock refused or unanswered is left to the stop, which takes the only unlocked
    /// copy of the key with the process. `step` hears each part as it happens.
    pub fn lock_and_stop(&self, port: Option<u16>, token: &str, reason: &str, mut step: impl FnMut(StopStep)) {
        match port.map(|port| post_lock_when_idle(port, token, reason)) {
            Some(LockAnswer::Locked) => step(StopStep::Locked),
            Some(LockAnswer::Busy) => step(StopStep::Sending),
            _ => {}
        }
        step(StopStep::Stopping);
        self.kill();
        step(StopStep::Stopped);
    }
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
/// is only used where nothing is opened onto what answered: the launch survey, which gives way to
/// a running copy, stops a proven orphan or refuses. `Some` requires the header
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
/// Line 1 is the window token, line 2 the boot nonce, line 3 the roster seat secret, line 4 the
/// enclave transport key, line 5 the relay secret. Order is the contract; src/main.ts reads them
/// in it. A backend started with no pipe at all is a developer
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
        Some(mut pipe) => writeln!(pipe, "{}\n{}\n{}\n{}\n{}", hand.token, hand.nonce, hand.seat, hand.transport, hand.relay)
            .map_err(|e| format!("could not hand the handshake to the control app: {e}"))?,
        None => return Err("the control app was started with no stdin to hand the handshake to".into()),
    }
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn the_shutdown_grace_outlasts_a_venue_write_in_flight() {
        assert!(SHUTDOWN_GRACE > Duration::from_millis(SETTLE_CAP_MS_IN_SHUTDOWN_TS));
    }

    #[test]
    fn a_child_adopted_after_kill_began_is_reaped_not_kept() {
        let backend = Backend::new();
        backend.kill();
        assert!(backend.stopping());
        let child = Command::new("sleep").arg("30").stdin(Stdio::null()).spawn().unwrap();
        let pid = child.id();
        backend.adopt(child, std::env::temp_dir().join(format!("phosphor-adopt-test-{pid}.pid")));
        assert!(matches!(backend.exited(), None), "nothing is kept after stopping");
        assert!(!pid_is_alive(pid as i32), "the late child was taken down");
    }

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

    #[test]
    fn a_backend_command_line_names_one_bundle_twice_and_nothing_after() {
        let installed = "/Applications/Phosphor.app/Contents/MacOS/node /Applications/Phosphor.app/Contents/Resources/phosphor/src/main.ts";
        let app = PathBuf::from("/Applications/Phosphor.app");
        assert_eq!(backend_bundles(installed), Some((app.clone(), app)));
        // The copy macOS runs from the disk image, at a path of its own choosing.
        let translocated = "/private/var/folders/xy/T/AppTranslocation/0A1B/d/Phosphor.app/Contents/MacOS/node \
                            /private/var/folders/xy/T/AppTranslocation/0A1B/d/Phosphor.app/Contents/Resources/phosphor/src/main.ts";
        assert!(backend_bundles(translocated).is_some());
        // A space in the bundle path is not where the line is cut.
        let spaced = "/Volumes/Phosphor 0.9.2/Phosphor.app/Contents/MacOS/node /Volumes/Phosphor 0.9.2/Phosphor.app/Contents/Resources/phosphor/src/main.ts";
        let volume = PathBuf::from("/Volumes/Phosphor 0.9.2/Phosphor.app");
        assert_eq!(backend_bundles(spaced), Some((volume.clone(), volume)));
        // Two bundles come back as two, for one_bundle to refuse.
        let crossed = "/A.app/Contents/MacOS/node /B.app/Contents/Resources/phosphor/src/main.ts";
        assert_eq!(backend_bundles(crossed), Some((PathBuf::from("/A.app"), PathBuf::from("/B.app"))));
    }

    #[test]
    fn a_checkout_the_mcp_proxy_or_an_extra_argument_is_never_a_backend_of_this_app() {
        for line in [
            "node src/main.ts",
            "/opt/homebrew/bin/node /Users/k/phosphor/src/main.ts",
            "/Applications/Phosphor.app/Contents/MacOS/node /Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts",
            "/Applications/Phosphor.app/Contents/MacOS/node --inspect /Applications/Phosphor.app/Contents/Resources/phosphor/src/main.ts",
            "/Applications/Phosphor.app/Contents/MacOS/node /Applications/Phosphor.app/Contents/Resources/phosphor/src/main.ts --flag",
            "Phosphor.app/Contents/MacOS/node Phosphor.app/Contents/Resources/phosphor/src/main.ts",
            "",
        ] {
            assert_eq!(backend_bundles(line), None, "{line}");
        }
    }

    #[test]
    fn the_parent_and_the_command_come_off_one_ps_line() {
        let line = "    1 /A.app/Contents/MacOS/node /A.app/Contents/Resources/phosphor/src/main.ts\n";
        assert_eq!(
            parent_and_command_from(line),
            Some((1, "/A.app/Contents/MacOS/node /A.app/Contents/Resources/phosphor/src/main.ts".to_string()))
        );
        assert_eq!(parent_and_command_from("41207 node src/main.ts"), Some((41207, "node src/main.ts".to_string())));
        assert_eq!(parent_and_command_from(""), None, "ps printed nothing: the pid is gone");
        assert_eq!(parent_and_command_from("   \n"), None);
        assert_eq!(parent_and_command_from("abc /bin/x"), None);
    }

    #[cfg(unix)]
    #[test]
    fn two_spellings_of_one_bundle_are_one_bundle_and_two_bundles_are_not() {
        let root = std::env::temp_dir().join(format!("phosphor-bundles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (a, b, plain) = (root.join("A.app"), root.join("B.app"), root.join("NotABundle"));
        for dir in [&a, &b, &plain] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let alias = root.join("Alias.app");
        std::os::unix::fs::symlink(&a, &alias).unwrap();
        let resolved = std::fs::canonicalize(&a).unwrap();

        assert_eq!(one_bundle(&a, &a), Some(resolved.clone()));
        assert_eq!(one_bundle(&alias, &a), Some(resolved), "a second spelling of the bundle is the bundle");
        assert_eq!(one_bundle(&a, &b), None, "one copy's runtime running another copy's payload is not spawn_backend's");
        assert_eq!(one_bundle(&plain, &plain), None, "not an app bundle");
        assert_eq!(one_bundle(&root.join("Gone.app"), &root.join("Gone.app")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A stand-in for an installed copy of the app, in a temp directory of its own: a bundle that
    /// declares `identifier`, whose `node` is /bin/cat and whose payload entry point is a FIFO. A
    /// process started with spawn_backend's exact command line then blocks in open() and waits,
    /// which is all a lost backend does as far as these checks can see.
    #[cfg(target_os = "macos")]
    fn fake_install(tag: &str, identifier: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("phosphor-orphan-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundle = root.join("Phosphor Test.app");
        let runtime = bundle.join("Contents").join("MacOS").join("node");
        let entry = bundle.join("Contents").join("Resources").join("phosphor").join("src").join("main.ts");
        std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink("/bin/cat", &runtime).unwrap();
        assert!(Command::new("/usr/bin/mkfifo").arg(&entry).status().unwrap().success());
        let info = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
             <key>CFBundleIdentifier</key><string>{identifier}</string></dict></plist>\n"
        );
        std::fs::write(bundle.join("Contents").join("Info.plist"), info).unwrap();
        (root, runtime, entry)
    }

    /// Starts spawn_backend's command line through a shell that exits at once, so the process
    /// loses its parent and macOS hands it to launchd: what a force-quit shell leaves behind.
    #[cfg(target_os = "macos")]
    fn lose(runtime: &Path, entry: &Path) -> i32 {
        let line = format!("'{}' '{}' </dev/null >/dev/null 2>&1 & echo $!", runtime.display(), entry.display());
        let out = Command::new("/bin/sh").arg("-c").arg(line).output().unwrap();
        let pid: i32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while parent_and_command(pid).map(|(parent, _)| parent) != Some(1) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        pid
    }

    /// Takes down a process a test started if it is still there when the test ends, and removes
    /// the test's directory. The process is proved to be the test's own by its command line
    /// naming that directory, so a failing test can never signal anything it did not start.
    #[cfg(target_os = "macos")]
    struct Reap(i32, PathBuf);

    #[cfg(target_os = "macos")]
    impl Drop for Reap {
        fn drop(&mut self) {
            let root = self.1.to_string_lossy().into_owned();
            if parent_and_command(self.0).is_some_and(|(_, command)| command.contains(&root)) {
                // SAFETY: kill(2) on the process this test started, identified on the line above.
                unsafe {
                    libc::kill(self.0, libc::SIGKILL);
                }
            }
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_lost_backend_of_this_app_is_proved_an_orphan_and_stopped() {
        let id = "com.example.phosphor-orphan-test";
        let (root, runtime, entry) = fake_install("lost", id);
        let lost = lose(&runtime, &entry);
        let _reap = Reap(lost, root);
        assert!(is_orphaned_backend(lost, id), "no parent, spawn_backend's command line, this app's bundle");
        assert!(
            !is_orphaned_backend(lost, "com.example.another-app"),
            "the same command line in another app's bundle is not this app's"
        );
        assert!(stop_orphan(lost, id));
        assert!(!pid_is_alive(lost), "gone, which is what frees the port for the next backend");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_backend_whose_shell_is_alive_is_never_an_orphan_and_never_signalled() {
        let id = "com.example.phosphor-watched-test";
        let (root, runtime, entry) = fake_install("watched", id);
        let mut watched = Command::new(&runtime).arg(&entry).stdin(Stdio::null()).spawn().unwrap();
        let pid = watched.id() as i32;
        let _reap = Reap(pid, root);
        let seen = is_orphaned_backend(pid, id);
        let left_alone = stop_orphan(pid, id) && matches!(watched.try_wait(), Ok(None));
        let _ = watched.kill();
        let _ = watched.wait();
        assert!(!seen, "its parent is this test and alive, so it is watched, not lost");
        assert!(left_alone, "stop_orphan proves before it signals, and this one is never proved");
    }

    /// A backend that answers one request with `reply` and hands back what it was sent.
    fn lock_stub(reply: &'static str) -> (u16, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind a loopback port");
        let port = listener.local_addr().expect("read the bound port").port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Some(Ok(mut sock)) = listener.incoming().next() else { return };
            let _ = sock.set_read_timeout(Some(Duration::from_millis(300)));
            let mut seen = Vec::new();
            let mut scratch = [0u8; 4096];
            while let Ok(n) = sock.read(&mut scratch) {
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&scratch[..n]);
                if String::from_utf8_lossy(&seen).contains("}") {
                    break;
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&seen).into_owned());
            let _ = sock.write_all(reply.as_bytes());
            let _ = sock.shutdown(Shutdown::Both);
        });
        (port, rx)
    }

    const LOCKED: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":true}";
    const BUSY: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":false,\"error\":\"A move is being sent.\",\"code\":\"busy\",\"executing\":1}";
    const DRAINING: &str = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"Phosphor is shutting down\"}";

    #[test]
    fn every_lock_asks_the_backend_to_decide_and_only_its_yes_is_locked() {
        let (port, sent) = lock_stub(LOCKED);
        assert_eq!(post_lock_when_idle(port, "t0k", "quitting"), LockAnswer::Locked);
        let request = sent.recv_timeout(Duration::from_secs(2)).expect("the lock reached the backend");
        assert!(request.starts_with("POST /api/lock HTTP/1.1\r\n"), "{request}");
        assert!(request.contains(&format!("Origin: http://127.0.0.1:{port}")), "the custody guard checks the origin");
        assert!(request.contains("\"whenIdle\":true"), "the backend decides, in one step: {request}");
        assert!(request.contains("\"reason\":\"quitting\"") && request.contains("\"token\":\"t0k\""), "{request}");

        let (port, _) = lock_stub(BUSY);
        assert_eq!(post_lock_when_idle(port, "t0k", "quitting"), LockAnswer::Busy, "a 200 that refuses is not a lock");
        let (port, _) = lock_stub(DRAINING);
        assert_eq!(post_lock_when_idle(port, "t0k", "quitting"), LockAnswer::Unanswered, "the drain takes no writes");
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind a loopback port");
        let empty = listener.local_addr().expect("read the bound port").port();
        drop(listener);
        assert_eq!(post_lock_when_idle(empty, "t0k", "quitting"), LockAnswer::Unanswered);
        assert_eq!(lock_answer("HTTP/1.1 200 OK\r\n\r\n{\"ok\":false,\"code\":\"wrong_password\"}"), LockAnswer::Unanswered);
        assert_eq!(lock_answer("HTTP/1.1 200 OK\r\n\r\nnot json"), LockAnswer::Unanswered);
    }

    #[test]
    fn a_stop_on_purpose_reports_each_part_as_it_happens() {
        let heard = |port: Option<u16>| {
            let backend = Backend::new();
            let mut steps = Vec::new();
            backend.lock_and_stop(port, "t0k", "quitting", |step| steps.push(step));
            steps
        };
        let (locked, _) = lock_stub(LOCKED);
        assert_eq!(heard(Some(locked)), vec![StopStep::Locked, StopStep::Stopping, StopStep::Stopped]);
        let (busy, _) = lock_stub(BUSY);
        assert_eq!(
            heard(Some(busy)),
            vec![StopStep::Sending, StopStep::Stopping, StopStep::Stopped],
            "a move being sent keeps the key until the stop"
        );
        assert_eq!(heard(None), vec![StopStep::Stopping, StopStep::Stopped], "no port, no lock asked for, and still a stop");
    }
}
