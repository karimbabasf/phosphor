// The shell's side of the Secure Enclave: it runs the sidecar and relays between the backend
// and the enclave, and it holds nothing.
//
// WHY THE SHELL AND NOT THE BACKEND. The enclave is reached through CryptoKit, which is Swift
// only, so the operation lives in a sidecar (src-tauri/se-helper/main.swift). Somebody has to
// run that sidecar, and the choice is the backend or this shell. The backend is the process
// that talks to the network, parses what venues send back and hosts the agent's MCP server; it
// is the process most likely to be holding untrusted bytes at any moment. The shell is the
// process that draws the window and nothing else. So the shell runs the sidecar, the backend
// never learns where it is, and the one thing that crosses back is a 32-byte data key, encrypted
// under a per-boot transport key on its way over loopback.
//
// HOW THE BACKEND ASKS. The window has no IPC bridge into this process on purpose (see main.rs),
// so the request cannot come from the page. It comes from the backend, by long poll: a thread
// here asks `POST /api/vault/pending` with the relay secret, the backend holds the request open
// until it has something (an approval that needs a Touch ID, a wallet to create, a lock to
// lift), and this thread runs the sidecar and posts the answer to `/api/vault/answer`. The page
// only ever moves a proposal into the state that makes the backend ask. That keeps the boundary
// main.rs describes: the native side is driven by the backend it started and verified by nonce,
// never by the page.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

/// A sidecar call must answer inside this, and the unwrap is the one that waits on a person.
/// Touch ID gives up on its own well before two minutes; this is the backstop for a hung helper.
const HELPER_TIMEOUT: Duration = Duration::from_secs(120);

pub fn helper_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate the running binary: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "the running binary has no parent directory".to_string())?;
    // The bundle puts externalBin beside the executable under its plain name. `tauri dev` runs
    // the debug binary from target/, where the sidecar keeps its target-triple suffix, so both
    // spellings are tried and the dev one is only reachable from a source checkout.
    let candidates = [
        dir.join("se-helper"),
        dir.join(format!("se-helper-{}", env!("TARGET_TRIPLE"))),
    ];
    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| format!("the Secure Enclave helper is missing beside {exe:?}"))
}

/// One request to the sidecar: one JSON line in, one JSON line out, then the process is gone.
/// The helper has no state between calls, which is what makes every call auditable from here.
pub fn call(request: &serde_json::Value) -> serde_json::Value {
    let helper = match helper_binary() {
        Ok(path) => path,
        Err(e) => return failure("helper_missing", &e),
    };
    let mut child = match Command::new(&helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return failure("helper_spawn", &format!("could not start {helper:?}: {e}")),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let line = request.to_string();
        if writeln!(stdin, "{line}").is_err() {
            let _ = child.kill();
            return failure("helper_io", "could not write the request");
        }
    }
    let output = std::thread::scope(|scope| {
        let handle = scope.spawn(|| child.wait_with_output());
        // wait_with_output has no timeout; the thread scope joins it either way, and a helper
        // that hangs past the backstop is reported rather than waited on forever.
        let start = std::time::Instant::now();
        loop {
            if handle.is_finished() {
                break handle.join().ok().and_then(Result::ok);
            }
            if start.elapsed() > HELPER_TIMEOUT {
                break None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    });
    let Some(output) = output else {
        return failure("helper_timeout", "the Secure Enclave helper did not answer");
    };
    let text = String::from_utf8_lossy(&output.stdout);
    match serde_json::from_str::<serde_json::Value>(text.trim()) {
        Ok(v) if v.is_object() => v,
        _ => failure("helper_garbled", "the Secure Enclave helper answered with something that is not JSON"),
    }
}

fn failure(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": code, "message": message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_helper_is_a_failure_answer_not_a_panic() {
        // The test binary has no sidecar beside it, so this exercises the miss path.
        let v = call(&serde_json::json!({ "op": "probe" }));
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "helper_missing");
    }
}

// ---------- the relay ----------

/// How long the backend may hold a poll open before answering "nothing yet". Under the socket's
/// read deadline below, so a held poll is never mistaken for a dead backend.
const POLL_HOLD_MS: u64 = 25_000;
const POLL_READ_TIMEOUT: Duration = Duration::from_secs(40);
/// After a failed hop (backend restarting, port busy) the relay waits this long before asking
/// again, so a dead backend is not hammered and a restarting one is picked up within a second.
const RETRY_PAUSE: Duration = Duration::from_secs(1);

/// What the relay needs and nothing more: no handle on the window, no path to the key file, and
/// not the window token either: the two relay routes take the relay secret, which the page
/// never receives, so a page cannot play the shell and the shell never sends the token anywhere.
pub struct Relay {
    pub port: u16,
    pub relay: String,
    pub nonce: String,
    pub transport: String,
}

/// The JSON body of a 2xx response whose x-phosphor header carries this boot's nonce. Anything
/// else, including a squatter answering with a different nonce, is `None`.
fn body_of_ours(response: &str, nonce: &str) -> Option<serde_json::Value> {
    if !response.starts_with("HTTP/1.1 2") || !crate::backend::identity_matches(response, Some(nonce)) {
        return None;
    }
    let (_, body) = response.split_once("\r\n\r\n")?;
    serde_json::from_str(body).ok()
}

fn post(relay: &Relay, path: &str, body: &serde_json::Value, read_timeout: Duration) -> Option<serde_json::Value> {
    let payload = body.to_string();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
        port = relay.port,
        len = payload.len()
    );
    let response = crate::backend::request_within(relay.port, &head, Some(&payload), read_timeout)?;
    body_of_ours(&response, &relay.nonce)
}

/// One turn of the relay: ask, run, answer. Returns false when the hop failed and the caller
/// should pause before trying again.
fn turn(relay: &Relay) -> bool {
    let ask = serde_json::json!({ "relay": relay.relay, "waitMs": POLL_HOLD_MS });
    let Some(pending) = post(relay, "/api/vault/pending", &ask, POLL_READ_TIMEOUT) else {
        return false;
    };
    let Some(request) = pending.get("request").filter(|r| r.is_object()) else {
        return true;
    };
    // The request is relayed to the sidecar as the backend wrote it, plus the transport key the
    // backend cannot know and the sidecar needs. The shell adds nothing else and reads nothing
    // out of it: the reason string, the blobs and the AAD are the backend's to compose.
    let mut forwarded = request.clone();
    if let Some(map) = forwarded.as_object_mut() {
        map.insert("transportKey".to_string(), serde_json::Value::String(hex_to_base64(&relay.transport)));
    }
    let mut answer = call(&forwarded);
    if let Some(map) = answer.as_object_mut() {
        map.insert("relay".to_string(), serde_json::Value::String(relay.relay.clone()));
        if let Some(id) = request.get("id") {
            map.insert("id".to_string(), id.clone());
        }
    }
    post(relay, "/api/vault/answer", &answer, POLL_READ_TIMEOUT).is_some()
}

/// Runs until `alive` says the backend is gone. One request at a time, in order, and never the
/// same request twice: the backend hands each out once and the sidecar is stateless, so a relay
/// that crashed mid-request leaves that request to time out on the backend's side rather than
/// be re-run against a second Touch ID dialog.
pub fn run(relay: Relay, alive: impl Fn() -> bool) {
    while alive() {
        if !turn(&relay) {
            std::thread::sleep(RETRY_PAUSE);
        }
    }
}

/// mint_token gives hex; the sidecar and the backend both take the transport key as base64.
fn hex_to_base64(hex: &str) -> String {
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect();
    base64_encode(&bytes)
}

/// Standard base64 with padding, written out because the tree is kept free of a crate for it.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod relay_tests {
    use super::*;

    #[test]
    fn the_transport_key_crosses_as_base64_of_its_bytes() {
        assert_eq!(hex_to_base64("00ff10"), "AP8Q");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(&[0u8; 32]).len(), 44);
    }

    #[test]
    fn only_a_2xx_carrying_this_boots_nonce_is_read() {
        let ok = "HTTP/1.1 200 OK\r\nX-Phosphor: abc\r\n\r\n{\"request\":null}";
        assert_eq!(body_of_ours(ok, "abc"), Some(serde_json::json!({ "request": null })));
        assert_eq!(body_of_ours(ok, "def"), None, "a squatter's answer is not read");
        let forbidden = "HTTP/1.1 403 Forbidden\r\nX-Phosphor: abc\r\n\r\n{}";
        assert_eq!(body_of_ours(forbidden, "abc"), None);
        let bare = "HTTP/1.1 200 OK\r\n\r\n{}";
        assert_eq!(body_of_ours(bare, "abc"), None, "no identity header, no read");
    }
}
