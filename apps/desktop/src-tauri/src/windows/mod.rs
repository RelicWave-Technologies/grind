//! The app's windows: what they are (`spec`), how they are born hidden
//! (`create`), and how they are shown and hidden (`present`). macOS overlays are
//! `NSPanel`s (`panel`); everywhere else they are plain always-on-top windows.

pub mod create;
#[cfg(target_os = "macos")]
mod panel;
pub mod present;
pub mod spec;

use tauri::{Manager, WebviewWindow, Wry};

/// Log a failed window call instead of dropping it: window calls are best-effort
/// UI, but silence made the Electron overlay bugs hard to find.
pub fn log_err<T>(what: &str, result: tauri::Result<T>) {
    if let Err(error) = result {
        tracing::warn!(what, %error, "window call failed");
    }
}

/// The webview window for a spec, if it exists.
pub fn window_of(app: &impl Manager<Wry>, spec: &spec::WindowSpec) -> Option<WebviewWindow> {
    app.get_webview_window(spec.label)
}
