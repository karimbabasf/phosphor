// The shell's side of the Secure Enclave: it calls the XPC service and relays between the
// backend and the enclave, and it holds nothing.
//
// WHY THE SHELL AND NOT THE BACKEND. The enclave is reached through CryptoKit, which is Swift
// only, so the operation lives in its own process (src-tauri/se-helper/main.swift). Somebody has
// to talk to that process, and the choice is the backend or this shell. The backend is the
// process that talks to the network, parses what venues send back and hosts the agent's MCP
// server; it is the process most likely to be holding untrusted bytes at any moment. The shell
// is the process that draws the window and nothing else. So the shell calls the service, the
// backend never learns where it is, and the one secret that crosses back is a 32-byte data key,
// encrypted under a per-boot transport key on its way over loopback. The chip key's signatures
// cross back too, in the clear: each is public the moment its bundle is sent.
//
// WHY XPC. The service sits in Contents/XPCServices and answers only a peer whose signature
// passes its requirement, which is this shell and nothing else (main.swift, WHO MAY CONNECT).
// The sidecar it replaced was an executable any local process could run with its own request.
// A release shell has no other way to the enclave: the spawn path below is compiled into debug
// builds only, for `tauri dev`, which runs outside a bundle where XPC cannot find the service.
//
// HOW THE BACKEND ASKS. The window has no IPC bridge into this process on purpose (see main.rs),
// so the request cannot come from the page. It comes from the backend, by long poll: a thread
// here asks `POST /api/vault/pending` with the relay secret, the backend holds the request open
// until it has something (an approval that needs a Touch ID, a wallet to create, a lock to
// lift), and this thread calls the service and posts the answer to `/api/vault/answer`. The page
// only ever moves a proposal into the state that makes the backend ask. That keeps the boundary
// main.rs describes: the native side is driven by the backend it started and verified by nonce,
// never by the page.

use std::time::Duration;

use crate::backend::Challenge;

/// A helper call must answer inside this, and the unwrap is the one that waits on a person.
/// Touch ID gives up on its own well before two minutes; this is the backstop for a hung helper.
const HELPER_TIMEOUT: Duration = Duration::from_secs(120);

/// The XPC service's name, which is its bundle identifier: Contents/XPCServices/<this>.xpc.
pub const SERVICE: &str = "com.karimbabasf.phosphor.vault";

/// One request to the enclave helper: one JSON object in, one JSON object out. The service keeps
/// nothing between calls and each call is its own connection, which is what makes every call
/// auditable from here.
pub fn call(request: &serde_json::Value) -> serde_json::Value {
    #[cfg(debug_assertions)]
    if !in_bundle() {
        return dev::call(request);
    }
    let text = match xpc::call(SERVICE, &request.to_string(), HELPER_TIMEOUT) {
        Ok(text) => text,
        Err(code) => return failure(code, "the Secure Enclave helper did not answer"),
    };
    match serde_json::from_str::<serde_json::Value>(text.trim()) {
        Ok(v) if v.is_object() => v,
        _ => failure("helper_garbled", "the Secure Enclave helper answered with something that is not JSON"),
    }
}

#[cfg(target_os = "macos")]
mod xpc {
    use std::ffi::{c_char, CStr, CString};
    use std::time::Duration;

    extern "C" {
        fn phosphor_xpc_call(service: *const c_char, request: *const c_char, timeout_secs: f64, error: *mut *const c_char) -> *mut c_char;
    }

    pub fn call(service: &str, request: &str, timeout: Duration) -> Result<String, &'static str> {
        let (Ok(service), Ok(request)) = (CString::new(service), CString::new(request)) else {
            return Err("helper_io");
        };
        let mut error: *const c_char = std::ptr::null();
        // SAFETY: both strings are NUL-terminated and outlive the call; the bridge returns either
        // a malloc'd string, freed below, or NULL with `error` pointing at a static string.
        let answer = unsafe { phosphor_xpc_call(service.as_ptr(), request.as_ptr(), timeout.as_secs_f64(), &mut error) };
        if answer.is_null() {
            return Err(match unsafe { CStr::from_ptr(error) }.to_str() {
                Ok("helper_unverified") => "helper_unverified",
                Ok("helper_timeout") => "helper_timeout",
                Ok("helper_garbled") => "helper_garbled",
                _ => "helper_unreachable",
            });
        }
        let text = unsafe { CStr::from_ptr(answer) }.to_string_lossy().into_owned();
        unsafe { libc::free(answer.cast()) };
        Ok(text)
    }
}

#[cfg(not(target_os = "macos"))]
mod xpc {
    pub fn call(_: &str, _: &str, _: std::time::Duration) -> Result<String, &'static str> {
        Err("helper_unreachable")
    }
}

/// True when this executable sits in an app bundle's Contents/MacOS, the only place XPC can look
/// the service up from.
#[cfg(debug_assertions)]
fn in_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.ends_with("Contents/MacOS")))
        .unwrap_or(false)
}

/// `tauri dev` only: the development build of the helper, which reads stdin, spawned from the
/// source checkout. Compiled out of every release build.
#[cfg(debug_assertions)]
mod dev {
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub fn call(request: &serde_json::Value) -> serde_json::Value {
        let helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("se-helper-dev-{}", env!("TARGET_TRIPLE")));
        if !helper.is_file() {
            return super::failure("helper_missing", &format!("no development helper at {helper:?}; run npm run se:build"));
        }
        let mut child = match Command::new(&helper).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
            Ok(child) => child,
            Err(e) => return super::failure("helper_spawn", &format!("could not start {helper:?}: {e}")),
        };
        if let Some(mut stdin) = child.stdin.take() {
            if writeln!(stdin, "{request}").is_err() {
                let _ = child.kill();
                return super::failure("helper_io", "could not write the request");
            }
        }
        // No timeout here, unlike the XPC hop: a development helper that hangs is a developer
        // looking at it.
        match child.wait_with_output() {
            Ok(out) => match serde_json::from_str::<serde_json::Value>(String::from_utf8_lossy(&out.stdout).trim()) {
                Ok(v) if v.is_object() => v,
                _ => super::failure("helper_garbled", "the Secure Enclave helper answered with something that is not JSON"),
            },
            Err(e) => super::failure("helper_io", &format!("{e}")),
        }
    }
}

fn failure(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": code, "message": message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreachable_service_is_a_failure_answer_not_a_panic() {
        // The test binary is in no bundle, so XPC has no service by that name to find.
        let v = match xpc::call(SERVICE, r#"{"op":"probe"}"#, Duration::from_secs(5)) {
            Ok(text) => serde_json::json!({ "ok": true, "text": text }),
            Err(code) => failure(code, "unreachable"),
        };
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "helper_unreachable");
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

/// The JSON body of a 2xx response whose x-phosphor header proves this boot's nonce for this
/// request's challenge. Anything else, including a squatter replaying an answer it saw, is `None`.
fn body_of_ours(response: &str, challenge: &Challenge) -> Option<serde_json::Value> {
    if !response.starts_with("HTTP/1.1 2") || !crate::backend::identity_matches(response, Some(challenge)) {
        return None;
    }
    let (_, body) = response.split_once("\r\n\r\n")?;
    serde_json::from_str(body).ok()
}

fn post(relay: &Relay, path: &str, body: &serde_json::Value, read_timeout: Duration) -> Option<serde_json::Value> {
    let challenge = Challenge::new(&relay.nonce).ok()?;
    let payload = body.to_string();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n{asked}\
         Content-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
        port = relay.port,
        asked = challenge.header(),
        len = payload.len()
    );
    let response = crate::backend::request_within(relay.port, &head, Some(&payload), read_timeout)?;
    body_of_ours(&response, &challenge)
}

/// The ops the service answers (src-tauri/se-helper/main.swift, THE PROTOCOL), and the only ones
/// the relay carries. Any other op is answered here and never reaches the service, so the
/// protocol is this list and a new op is a change to it. The last five are the chip key's
/// (ChipOps.swift); signIntent, like unwrap, waits on a person, and is carried as written: the
/// service writes its dialog's sentence itself, so there is nothing for the shell to add.
const OPS: [&str; 12] = [
    "probe", "create", "unwrap", "presence", "commit", "sweep", "status", "chipCreate", "chipCommit", "chipStatus", "chipSweep", "signIntent",
];

/// What the service receives for a request, or the refusal the relay answers in its place. The
/// request goes as the backend wrote it, plus, on an unwrap, the transport key the data key is
/// sealed under. The shell adds nothing else and reads nothing out of it: the reason string, the
/// blobs, the AAD and the addresses are the backend's to compose.
fn forwarded(request: &serde_json::Value, transport: &str) -> Result<serde_json::Value, serde_json::Value> {
    let op = request.get("op").and_then(|op| op.as_str()).unwrap_or("");
    if !OPS.contains(&op) {
        return Err(failure("bad_input", "the relay carries no such op"));
    }
    let mut out = request.clone();
    if op == "unwrap" {
        if let Some(map) = out.as_object_mut() {
            map.insert("transportKey".to_string(), serde_json::Value::String(hex_to_base64(transport)));
        }
    }
    Ok(out)
}

/// One turn of the relay: ask, call, answer. Returns false when the hop failed and the caller
/// should pause before trying again.
fn turn(relay: &Relay) -> bool {
    let ask = serde_json::json!({ "relay": relay.relay, "waitMs": POLL_HOLD_MS });
    let Some(pending) = post(relay, "/api/vault/pending", &ask, POLL_READ_TIMEOUT) else {
        return false;
    };
    let Some(request) = pending.get("request").filter(|r| r.is_object()) else {
        return true;
    };
    let mut answer = match forwarded(request, &relay.transport) {
        Ok(request) => call(&request),
        Err(refused) => refused,
    };
    if let Some(map) = answer.as_object_mut() {
        map.insert("relay".to_string(), serde_json::Value::String(relay.relay.clone()));
        if let Some(id) = request.get("id") {
            map.insert("id".to_string(), id.clone());
        }
    }
    post(relay, "/api/vault/answer", &answer, POLL_READ_TIMEOUT).is_some()
}

/// Runs until `alive` says the backend is gone. One request at a time, in order, and never the
/// same request twice: the backend hands each out once and the service is stateless, so a relay
/// that crashed mid-request leaves that request to time out on the backend's side rather than
/// be re-run against a second Touch ID dialog.
pub fn run(relay: Relay, alive: impl Fn() -> bool) {
    while alive() {
        if !turn(&relay) {
            std::thread::sleep(RETRY_PAUSE);
        }
    }
}

/// mint_token gives hex; the service and the backend both take the transport key as base64.
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
    use crate::backend::test_nonce;

    #[test]
    fn the_transport_key_crosses_as_base64_of_its_bytes() {
        assert_eq!(hex_to_base64("00ff10"), "AP8Q");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(&[0u8; 32]).len(), 44);
    }

    #[test]
    fn the_relay_carries_the_twelve_ops_and_the_transport_key_only_to_an_unwrap() {
        assert_eq!(OPS.len(), 12);
        let transport = "00".repeat(32);
        for op in OPS {
            let out = forwarded(&serde_json::json!({ "op": op, "id": "r1" }), &transport).expect(op);
            assert_eq!(out["op"], op);
            assert_eq!(out["id"], "r1", "the request goes as the backend wrote it");
            assert_eq!(out.get("transportKey").is_some(), op == "unwrap", "{op}");
        }
        let unwrap = forwarded(&serde_json::json!({ "op": "unwrap", "transportKey": "mine" }), &transport).unwrap();
        assert_eq!(unwrap["transportKey"], base64_encode(&[0u8; 32]), "the shell's key, never one the backend put there");
        // A signature request reaches the service byte for byte: the payload is what the service
        // reads and signs, and the shell adds no sentence of its own.
        let sign = serde_json::json!({ "op": "signIntent", "id": "r2", "keyRef": "chip:com.karimbabasf.phosphor.chip.0", "payload": "{\"signer_id\":\"vault.near\"}" });
        assert_eq!(forwarded(&sign, &transport).unwrap(), sign);
        for request in [
            serde_json::json!({ "op": "delete" }),
            serde_json::json!({ "op": "" }),
            serde_json::json!({}),
            serde_json::json!({ "op": 7 }),
            serde_json::json!({ "op": "signintent" }),
            serde_json::json!({ "op": "chipDelete" }),
            serde_json::json!({ "op": "signIntent " }),
        ] {
            let refused = forwarded(&request, &transport).unwrap_err();
            assert_eq!(refused["ok"], false);
            assert_eq!(refused["error"], "bad_input", "{request}");
        }
    }

    #[test]
    fn only_a_2xx_carrying_this_boots_nonce_is_read() {
        let nonce = test_nonce();
        let challenge = Challenge::new(&nonce).unwrap();
        let ok = format!("HTTP/1.1 200 OK\r\nX-Phosphor: {}\r\n\r\n{{\"request\":null}}", challenge.expected());
        assert_eq!(body_of_ours(&ok, &challenge), Some(serde_json::json!({ "request": null })));
        let other = Challenge::new(&test_nonce()).unwrap();
        assert_eq!(body_of_ours(&ok, &other), None, "an answer under another nonce is not read");
        let replayed = format!("HTTP/1.1 200 OK\r\nX-Phosphor: {nonce}\r\n\r\n{{\"request\":{{\"op\":\"unwrap\"}}}}");
        assert_eq!(body_of_ours(&replayed, &challenge), None, "the nonce itself is no answer to a challenge");
        let forbidden = format!("HTTP/1.1 403 Forbidden\r\nX-Phosphor: {}\r\n\r\n{{}}", challenge.expected());
        assert_eq!(body_of_ours(&forbidden, &challenge), None);
        let bare = "HTTP/1.1 200 OK\r\n\r\n{}";
        assert_eq!(body_of_ours(bare, &challenge), None, "no identity header, no read");
    }
}
