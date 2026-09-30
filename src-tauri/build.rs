fn main() {
    // A debug shell outside a bundle spawns the development helper, which keeps its
    // target-triple suffix; enclave.rs names it with this.
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=TARGET_TRIPLE={target}");
    }
    // The XPC hop to the Secure Enclave service, see src/xpc_bridge.c.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/xpc_bridge.c");
        cc::Build::new().file("src/xpc_bridge.c").flag("-fblocks").compile("phosphor_xpc_bridge");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }
    tauri_build::build()
}
