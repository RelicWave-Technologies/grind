// Every IPC command the shell registers, as Tauri command names. Read by
// `build.rs` (via `include!`) to generate one `allow-<command>` permission per
// entry, so each window's capability grants exactly the commands it may call.
// Keep in step with `generate_handler!` in `app.rs`; the test in `mod.rs`
// checks that every name here is granted to at least one window.

/// Channel `window:openMain` is command `window_open_main` (see apps/desktop/README.md).
pub const COMMANDS: &[&str] = &[
    "window_open_main",
    "window_dismiss_floating_bar",
    "app_relaunch",
    "settings_open_data_folder",
    "settings_get",
];
