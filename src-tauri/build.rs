fn main() {
    // A debug shell outside a bundle spawns the development helper, which keeps its
    // target-triple suffix; enclave.rs names it with this.
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=TARGET_TRIPLE={target}");
    }
    // The digest of the payload this shell will run, which `npm run bundle` writes beside the
    // payload it staged. Compiled in, so the shell's own signature covers it; see payload.rs.
    // The bundle step comes first, always: a shell compiled before it would carry the digest of
    // whatever payload was staged before, and refuse the one it ships with.
    println!("cargo:rerun-if-changed=payload/phosphor.sha256");
    let digest = std::fs::read_to_string("payload/phosphor.sha256")
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        panic!("src-tauri/payload/phosphor.sha256 is missing or is not a digest: run `npm run bundle` before building the shell");
    }
    println!("cargo:rustc-env=PHOSPHOR_PAYLOAD_DIGEST={digest}");
    // The XPC hop to the Secure Enclave service, see src/xpc_bridge.c, and the signature checks
    // in src/codesign.c it shares with the backend's launch.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/xpc_bridge.c");
        println!("cargo:rerun-if-changed=src/codesign.c");
        cc::Build::new()
            .file("src/xpc_bridge.c")
            .file("src/codesign.c")
            .flag("-fblocks")
            .compile("phosphor_xpc_bridge");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }
    tauri_build::build()
}
