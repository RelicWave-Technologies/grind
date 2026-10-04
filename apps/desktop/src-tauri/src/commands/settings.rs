#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects `AppHandle` into commands by value; a reference does not extract"
)]

use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, Manager};

use super::CommandError;
use crate::dto::{Platform, SettingsInfo};
use crate::paths::user_data_dir;

/// The service-free half of `settings:get`: `version` is `app.getVersion()`
/// (package.json, mirrored in Cargo.toml), `platform` is `process.platform`.
#[tauri::command]
#[must_use]
pub fn settings_get() -> SettingsInfo {
    SettingsInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        platform: Platform::current(),
    }
}

/// Port of `settings:openDataFolder` (`shell.openPath(app.getPath('userData'))`).
#[tauri::command]
pub fn settings_open_data_folder(app: AppHandle) -> Result<(), CommandError> {
    let data = app
        .path()
        .data_dir()
        .map_err(|_| CommandError::Path("the app data folder"))?;
    let folder = user_data_dir(&data);
    std::fs::create_dir_all(&folder)?;
    reveal(&folder)
}

/// Open a folder in Finder / Explorer without waiting for it.
fn reveal(folder: &Path) -> Result<(), CommandError> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    Command::new(opener).arg(folder).spawn()?;
    Ok(())
}
