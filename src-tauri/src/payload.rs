// The payload's digest, checked before the backend starts.
//
// The backend runs from Contents/Resources/phosphor, and nothing in macOS stops a process running
// as this person from editing a file there between two launches: the bundle's seal is checked
// when Gatekeeper first assesses the app, not every time it opens. An edited file there runs
// beside the unwrapped key, behind a shell the Secure Enclave service trusts. So the shell carries
// the digest of the payload it was built with (build.rs, from `npm run bundle`), hashes the
// installed tree the same way before every spawn, and starts nothing on a difference.
//
// The rule is scripts/payload-digest.ts's, byte for byte: every regular file under the root
// except those named .DS_Store, by its path from the root, in byte order; one `shasum -a 256`
// line per file; the digest is the SHA-256 of the lines. A link, or anything else that is not a
// file or a folder, is a difference, and so is a path with a newline or a backslash in it.
//
// The digest is a string inside this binary, so the signature over the shell covers it: a copy
// that expects another payload is another shell. What this cannot see is a file changed after
// the check, while the app runs; the next launch refuses that copy.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The digest of the payload this shell was built with.
pub const BUILT_FOR: &str = env!("PHOSPHOR_PAYLOAD_DIGEST");

const SKIPPED: &str = ".DS_Store";
/// More threads stop paying past this: opening eight thousand small files is the cost, and the
/// file system serialises enough of it that twelve or sixteen threads measured no faster.
const MAX_THREADS: usize = 8;

/// What a check found when the tree was the one expected: how many files, how long the hashing
/// took, and how long the start that asked for it was kept waiting.
pub struct Checked {
    pub files: usize,
    pub took: Duration,
    pub waited: Duration,
}

type Hashed = Result<(String, usize, Duration), String>;

/// A check started at launch (start_early), with the payload path it was started on.
static EARLY: Mutex<Option<(PathBuf, JoinHandle<Hashed>)>> = Mutex::new(None);

/// Starts the check of the bundled payload on its own thread as the shell starts, so hashing
/// eight thousand files runs beside Tauri building the menu and the splash rather than in front
/// of the backend. The first check of that same path takes its answer; any other path, and every
/// check after it (a respawn), hashes afresh.
pub fn start_early(root: PathBuf) {
    let at = root.clone();
    let job = std::thread::spawn(move || timed(&at));
    if let Ok(mut early) = EARLY.lock() {
        *early = Some((root, job));
    }
}

fn timed(root: &Path) -> Hashed {
    let started = Instant::now();
    digest_of(root).map(|(digest, files)| (digest, files, started.elapsed()))
}

fn take_early(root: &Path) -> Option<Hashed> {
    let job = {
        let mut early = EARLY.lock().ok()?;
        let wanted = std::fs::canonicalize(root).ok()?;
        let same = early.as_ref().is_some_and(|(path, _)| std::fs::canonicalize(path).ok() == Some(wanted));
        if !same {
            return None;
        }
        early.take()?.1
    };
    job.join().ok()
}

/// Is the tree at `root` the payload `expected` names? The error is the shell's own reason, for
/// the Details of the window that says the app needs a fresh copy.
pub fn check(root: &Path, expected: &str) -> Result<Checked, String> {
    let asked = Instant::now();
    let (found, files, took) = match take_early(root) {
        Some(early) => early?,
        None => timed(root)?,
    };
    if found != expected {
        return Err(format!(
            "The files in {} are not the ones this copy of Phosphor was built with, so the backend was not started. \
             Built for payload {expected}, found {found} over {files} files.",
            root.display()
        ));
    }
    Ok(Checked { files, took, waited: asked.elapsed() })
}

/// The digest of the tree at `root` and the number of files it covers.
pub fn digest_of(root: &Path) -> Result<(String, usize), String> {
    let mut files = Vec::new();
    walk(root, "", &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, MAX_THREADS);
    let share = files.len().div_ceil(threads).max(1);
    let hashed: Vec<Result<String, String>> = std::thread::scope(|scope| {
        let parts: Vec<_> = files
            .chunks(share)
            .map(|part| scope.spawn(move || part.iter().map(|(rel, full)| file_hash(rel, full)).collect::<Vec<_>>()))
            .collect();
        parts
            .into_iter()
            .flat_map(|part| part.join().unwrap_or_else(|_| vec![Err("a thread hashing the payload stopped".to_string())]))
            .collect()
    });
    if hashed.len() != files.len() {
        return Err("the payload could not be hashed whole".to_string());
    }
    let mut lines = String::with_capacity(files.len() * 120);
    for ((rel, _), hash) in files.iter().zip(hashed) {
        lines.push_str(&hash?);
        lines.push_str("  ");
        lines.push_str(rel);
        lines.push('\n');
    }
    Ok((hex(&sha256(lines.as_bytes())?), files.len()))
}

/// Every regular file under `dir`, with its path from the root. The type comes from the entry
/// itself, which does not follow links, so a link is seen as a link and refused.
fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(format!("{} holds a name that is not UTF-8", dir.display()));
        };
        let rel = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
        if rel.contains(['\n', '\\']) {
            return Err(format!("{rel:?} has a newline or a backslash in its path"));
        }
        let kind = entry.file_type().map_err(|e| format!("cannot read the type of {rel}: {e}"))?;
        if kind.is_dir() {
            walk(&entry.path(), &rel, out)?;
        } else if kind.is_file() {
            if name != SKIPPED {
                out.push((rel, entry.path()));
            }
        } else {
            return Err(format!("{rel} is neither a file nor a folder"));
        }
    }
    Ok(())
}

fn file_hash(rel: &str, full: &Path) -> Result<String, String> {
    let body = std::fs::read(full).map_err(|e| format!("cannot read {rel}: {e}"))?;
    Ok(hex(&sha256(&body)?))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

#[cfg(target_os = "macos")]
extern "C" {
    // <CommonCrypto/CommonDigest.h>, part of libSystem on every Mac: the system's own SHA-256,
    // so this check brings no crate into the shell.
    fn CC_SHA256(data: *const std::ffi::c_void, len: u32, md: *mut u8) -> *mut u8;
}

#[cfg(target_os = "macos")]
fn sha256(data: &[u8]) -> Result<[u8; 32], String> {
    let len = u32::try_from(data.len()).map_err(|_| "a payload file is over 4 GB".to_string())?;
    let mut out = [0u8; 32];
    // SAFETY: CC_SHA256 reads `len` bytes from `data`, which is a live slice of exactly that
    // length, and writes 32 bytes into `out`, which has room for exactly that.
    unsafe {
        CC_SHA256(data.as_ptr().cast(), len, out.as_mut_ptr());
    }
    Ok(out)
}

/// The shell ships for macOS only. Anywhere else the check fails, and a payload it cannot check
/// is a payload it does not start.
#[cfg(not(target_os = "macos"))]
fn sha256(_data: &[u8]) -> Result<[u8; 32], String> {
    Err("the payload check needs macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The launch's early check answers the first start of its own path, and only that: a second
    /// start, a respawn, hashes the tree as it is then.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_early_check_answers_the_first_start_of_its_own_path_and_nothing_after() {
        let root = std::env::temp_dir().join(format!("phosphor-early-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("main.ts"), "console.log(1);\n").unwrap();
        std::fs::write(root.join("package.json"), "{}\n").unwrap();
        let (built, files) = digest_of(&root).unwrap();
        assert_eq!(files, 2);

        start_early(root.clone());
        assert!(take_early(&std::env::temp_dir()).is_none(), "another path never takes it");
        assert!(EARLY.lock().unwrap().is_some(), "and leaves it for the start it was made for");
        assert_eq!(check(&root, &built).map(|c| c.files).ok(), Some(2), "the first start of its path takes it");
        assert!(EARLY.lock().unwrap().is_none(), "once");

        std::fs::write(root.join("src").join("main.ts"), "console.log(2);\n").unwrap();
        let again = check(&root, &built).err().expect("a respawn hashes the tree as it is now");
        assert!(again.contains(&built), "{again}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The system's SHA-256 against shasum's, on bytes of every value and on nothing at all.
    #[cfg(target_os = "macos")]
    #[test]
    fn sha256_agrees_with_shasum() {
        let dir = std::env::temp_dir().join(format!("phosphor-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let every: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
        for (name, body) in [("empty", Vec::new()), ("every", every)] {
            let file = dir.join(name);
            std::fs::write(&file, &body).unwrap();
            let out = std::process::Command::new("/usr/bin/shasum").args(["-a", "256"]).arg(&file).output().unwrap();
            let theirs = String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap_or("").to_string();
            assert_eq!(hex(&sha256(&body).unwrap()), theirs, "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
