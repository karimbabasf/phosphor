fn main() {
    // The sidecar keeps its target-triple suffix in a source checkout; enclave.rs looks for it
    // by that name when the plain one is absent.
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=TARGET_TRIPLE={target}");
    }
    tauri_build::build()
}
