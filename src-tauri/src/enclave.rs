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
// here asks `GET /api/vault/pending` with the window token, the backend holds the request open
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
