fn main() {
    println!("cargo:rustc-check-cfg=cfg(speech_native)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if matches!(os.as_str(), "macos" | "windows" | "linux")
        && matches!(arch.as_str(), "x86_64" | "aarch64")
    {
        println!("cargo:rustc-cfg=speech_native");
    }
    tauri_build::build();
}
