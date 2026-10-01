// The wallet locks when the person steps away from this Mac: when the screen locks, and when the
// Mac switches to another user. Before this it locked on idle time, sleep, the window closing and
// quit, so a screen locked one minute into the idle time left the key in memory for the rest of
// it with nobody at the desk, and a switch to another user's session left it there for the whole
// idle time behind a session nobody was looking at.
//
// The lock is the backend's when-idle lock, the one every lock this shell sends goes through
// (post_lock_when_idle): a move being sent finishes first, and a move waiting for a click stays
// on its card, which says Unlock to decide when the person is back. The notifications arrive in
// session_watch.m.

use std::ffi::c_int;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::backend::{post_lock_when_idle, LockAnswer};

/// What macOS posts to every app when the screen locks.
pub const SCREEN_LOCKED: &str = "com.apple.screenIsLocked";

/// How long a move being sent may hold the lock off: the backend's own drain cap for a venue write
/// in flight (32 s, src/shutdown.ts), and a little room. Past it the idle lock still stands.
const SENDING_GRACE: Duration = Duration::from_secs(40);
const ASK_AGAIN: Duration = Duration::from_secs(1);

const SCREEN: c_int = 1;
const SESSION: c_int = 2;

/// The port and window token of this boot's backend, from the moment it answered with this
/// boot's nonce. A respawn reuses both, so this is set once.
static BACKEND: Mutex<Option<(u16, String)>> = Mutex::new(None);

pub fn backend_up(port: u16, token: &str) {
    if let Ok(mut held) = BACKEND.lock() {
        *held = Some((port, token.to_string()));
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn phosphor_watch_session(screen_locked: *const std::ffi::c_char, on_event: extern "C" fn(c_int));
}

/// Starts watching, once, for the life of the app.
#[cfg(target_os = "macos")]
pub fn watch() {
    watch_for(SCREEN_LOCKED);
}

#[cfg(not(target_os = "macos"))]
pub fn watch() {}

#[cfg(target_os = "macos")]
fn watch_for(screen_locked: &str) {
    let Ok(name) = std::ffi::CString::new(screen_locked) else {
        return;
    };
    // SAFETY: the name is NUL-terminated and only read during the call; the callback is a plain
    // function that lives as long as the process.
    unsafe { phosphor_watch_session(name.as_ptr(), on_event) };
}

// Called on the watch's own queue, never the main thread. Nothing may unwind into Objective-C.
extern "C" fn on_event(kind: c_int) {
    let _ = std::panic::catch_unwind(|| {
        let reason = match kind {
            SCREEN => "the screen locked",
            SESSION => "this Mac switched to another user",
            _ => return,
        };
        let Some((port, token)) = BACKEND.lock().ok().and_then(|held| held.clone()) else {
            return;
        };
        let answer = lock_when_idle(port, &token, reason, SENDING_GRACE);
        eprintln!("phosphor: {reason}, so the wallet was asked to lock: {answer:?}");
    });
}

/// The when-idle lock, asked again while a move is being sent, so the key goes the moment the
/// move lands rather than at the end of the idle time: the person has walked away and there is
/// nobody left to ask.
fn lock_when_idle(port: u16, token: &str, reason: &str, grace: Duration) -> LockAnswer {
    let deadline = Instant::now() + grace;
    loop {
        match post_lock_when_idle(port, token, reason) {
            LockAnswer::Busy if Instant::now() < deadline => std::thread::sleep(ASK_AGAIN),
            answer => return answer,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{backend_command, get_health, phosphor_is_listening, request_within, Handshake};
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener};
    use std::path::Path;
    use std::process::{Command, Stdio};

    const LOCKED: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":true}";
    const BUSY: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":false,\"code\":\"busy\",\"executing\":1}";

    /// A backend that answers the lock requests it is sent with `replies`, in order.
    fn stub(replies: Vec<&'static str>) -> (u16, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for reply in replies {
                let Some(Ok(mut sock)) = listener.incoming().next() else { return };
                let _ = sock.set_read_timeout(Some(Duration::from_millis(300)));
                let mut seen = Vec::new();
                let mut scratch = [0u8; 4096];
                while let Ok(n) = sock.read(&mut scratch) {
                    if n == 0 {
                        break;
                    }
                    seen.extend_from_slice(&scratch[..n]);
                    if seen.ends_with(b"}") {
                        break;
                    }
                }
                let _ = tx.send(String::from_utf8_lossy(&seen).into_owned());
                let _ = sock.write_all(reply.as_bytes());
                let _ = sock.shutdown(Shutdown::Both);
            }
        });
        (port, rx)
    }

    #[test]
    fn a_move_being_sent_holds_the_lock_off_until_it_lands_and_no_longer_than_the_grace() {
        let (port, sent) = stub(vec![BUSY, BUSY, LOCKED]);
        let started = Instant::now();
        assert_eq!(lock_when_idle(port, "t0k", "the screen locked", SENDING_GRACE), LockAnswer::Locked);
        assert!(started.elapsed() >= ASK_AGAIN * 2, "asked again once a second while the move was sent");
        let asks: Vec<String> = sent.try_iter().collect();
        assert_eq!(asks.len(), 3);
        assert!(asks.iter().all(|ask| ask.contains("\"whenIdle\":true") && ask.contains("\"reason\":\"the screen locked\"")), "{asks:?}");

        let (port, _) = stub(vec![BUSY, BUSY, BUSY, BUSY]);
        assert_eq!(lock_when_idle(port, "t0k", "the screen locked", ASK_AGAIN), LockAnswer::Busy, "past the grace the idle lock stands");
    }

    fn post(port: u16, path: &str, body: serde_json::Value) -> serde_json::Value {
        let text = body.to_string();
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            text.len()
        );
        let raw = request_within(port, &head, Some(&text), Duration::from_secs(30)).expect("the backend answered");
        serde_json::from_str(raw.split_once("\r\n\r\n").map(|(_, b)| b.trim()).unwrap_or("")).expect("a JSON answer")
    }

    fn get(port: u16, path: &str) -> serde_json::Value {
        let head = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        let raw = request_within(port, &head, None, Duration::from_secs(10)).expect("the backend answered");
        serde_json::from_str(raw.split_once("\r\n\r\n").map(|(_, b)| b.trim()).unwrap_or("")).expect("a JSON answer")
    }

    fn locked(port: u16) -> bool {
        get_health(port).and_then(|h| h["locked"].as_bool()).unwrap_or(false)
    }

    fn wait_for(what: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if what() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// The whole chain on the real backend the bundle stages, in demo mode on a throwaway home:
    /// an open wallet with a policy change waiting for a click; a screen lock posted from another
    /// process, as loginwindow posts it, under a name of this test's own; the wallet locks and the
    /// change is still waiting; the person unlocks; a switch to another user locks it again.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_screen_lock_and_a_user_switch_each_lock_the_wallet_and_keep_the_move_waiting_for_a_click() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("binaries").join(format!("node-{}", env!("TARGET_TRIPLE")));
        let payload = manifest.join("payload").join("phosphor");
        let root = std::env::temp_dir().join(format!("phosphor-screen-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home")).unwrap();
        let port = {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.local_addr().unwrap().port()
        };
        let planted: Vec<(&str, std::ffi::OsString)> = vec![
            ("PATH", std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into())),
            ("HOME", root.join("home").into_os_string()),
            ("PHOSPHOR_MODE", "demo".into()),
            ("PHOSPHOR_PORT", port.to_string().into()),
            ("PHOSPHOR_KEYS", root.join("keys.enc.json").into_os_string()),
        ];
        let data = root.join("data");
        let hand = Handshake::mint().unwrap();
        let mut child = backend_command(&node, &payload, &data, |name| planted.iter().find(|(n, _)| *n == name).map(|(_, v)| v.clone()))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the staged backend");
        let mut pipe = child.stdin.take().unwrap();
        writeln!(pipe, "{}\n{}\n{}\n{}\n{}", hand.token, hand.nonce, hand.seat, hand.transport, hand.relay).unwrap();
        drop(pipe);

        let outcome = std::panic::catch_unwind(|| {
            assert!(wait_for(|| phosphor_is_listening(port, Some(&hand.nonce))), "the backend came up");
            let password = hand.relay[..24].to_string();
            assert_eq!(post(port, "/api/wallet/create", serde_json::json!({ "token": hand.token, "password": password }))["ok"], true);
            let secret = std::fs::read_to_string(data.join("state").join("agent.secret")).unwrap();
            let filed = post(
                port,
                "/api/mcp",
                serde_json::json!({
                    "op": "propose", "kind": "policy_change", "client": "screen-lock-test", "secret": secret.trim(),
                    "params": { "patch": { "outbound": { "humanClickAboveUsd": 50 } }, "sentence": "Ask me above $50." }
                }),
            );
            let id = filed["id"].as_str().expect("a proposal id").to_string();
            let waiting = || {
                get(port, "/api/proposals")["proposals"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|p| p["id"] == id.as_str()).map(|p| p["status"].as_str().unwrap_or("").to_string()))
            };
            assert_eq!(waiting().as_deref(), Some("pending"));
            assert!(!locked(port), "the wallet is open before anyone steps away");

            backend_up(port, &hand.token);
            let name = format!("com.karimbabasf.phosphor.test.screenIsLocked.{}", std::process::id());
            watch_for(&name);
            let posted = Command::new("/usr/bin/osascript")
                .args(["-l", "JavaScript", "-e"])
                .arg(format!(
                    "ObjC.import('Foundation'); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('{name}', $(), $(), true)"
                ))
                .output()
                .unwrap();
            assert!(posted.status.success(), "{}", String::from_utf8_lossy(&posted.stderr));
            assert!(wait_for(|| locked(port)), "a screen lock posted from another process locked the wallet");
            assert_eq!(waiting().as_deref(), Some("pending"), "the change waiting for a click is still waiting");

            assert_eq!(post(port, "/api/unlock", serde_json::json!({ "token": hand.token, "password": password }))["ok"], true);
            assert!(!locked(port));
            extern "C" {
                fn phosphor_post_session_resigned();
            }
            // SAFETY: posts one notification in this process and returns.
            unsafe { phosphor_post_session_resigned() };
            assert!(wait_for(|| locked(port)), "a switch to another user locked the wallet");
            assert_eq!(waiting().as_deref(), Some("pending"), "and the change is still waiting after a second lock");
        });
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&root);
        if let Err(failed) = outcome {
            std::panic::resume_unwind(failed);
        }
    }
}
