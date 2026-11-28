use std::{path::Path, process::Command};

fn main() {
    // The camera presence helper is a small Swift program (Apple Vision). Tauri bundles it next to the app
    // binary from `binaries/clawddesk-presence-<target triple>` (see `bundle.externalBin`).
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rerun-if-changed=presence/main.swift");
    if target.contains("apple-darwin") {
        std::fs::create_dir_all("binaries").expect("create binaries/");
        let out = format!("binaries/clawddesk-presence-{target}");
        let swift_target = if target.starts_with("aarch64") {
            "arm64-apple-macos13.0"
        } else {
            "x86_64-apple-macos13.0"
        };
        let status = Command::new("swiftc")
            .args([
                "-O",
                "-target",
                swift_target,
                "presence/main.swift",
                "-o",
                &out,
            ])
            .status()
            .expect("swiftc not found (install the Xcode Command Line Tools)");
        assert!(status.success(), "building the presence helper failed");
        assert!(Path::new(&out).exists());
    }
    tauri_build::build()
}
