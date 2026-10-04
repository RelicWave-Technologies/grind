//! Generates the per-command `allow-*` permissions from `src/commands/names.rs`
//! so capabilities can scope custom commands per window, not only plugins.

include!("src/commands/names.rs");

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("cargo:rerun-if-changed=src/commands/names.rs");
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))?;
    Ok(())
}
