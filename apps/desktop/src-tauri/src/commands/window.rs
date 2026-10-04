#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects `AppHandle` into commands by value; a reference does not extract"
)]

use tauri::AppHandle;

use crate::windows::{present, spec};

/// Port of `window:openMain` (legacy ipc `onOpenMainWindow` -> `showMainWindow`).
#[tauri::command]
pub fn window_open_main(app: AppHandle) {
    present::show_main(&app);
}

/// Port of `window:dismissFloatingBar`. Legacy routes this through
/// `FloatingBarVisibilityPolicy.dismissCurrent()`, which also remembers the
/// dismissal for the current entry; with no timer service yet this only hides.
#[tauri::command]
pub fn window_dismiss_floating_bar(app: AppHandle) {
    present::hide(&app, spec::FLOATING);
}
