#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects `AppHandle` into commands by value; a reference does not extract"
)]

use tauri::AppHandle;

/// Port of `app:relaunch`. Legacy first runs `runQuitCleanup('quit')` (flushing
/// the timer and queues); that cleanup does not exist in Rust yet, so this must
/// not be the way a running timer is restarted until it does.
#[tauri::command]
pub fn app_relaunch(app: AppHandle) {
    app.restart();
}
