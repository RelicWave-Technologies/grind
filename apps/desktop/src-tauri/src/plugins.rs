//! Plugin registration. Single-instance goes first (its docs require it).
//! Deep-link, autostart and the updater are registered only: no `timo://`
//! handler, no login item, no update endpoints exist until their services are
//! ported.

use tauri::{Builder, Wry};

/// Passed on the autostart command line so a login launch can stay in the tray
/// (legacy `--hidden`).
pub const HIDDEN_ARG: &str = "--hidden";

pub fn register(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            crate::app::on_second_instance(app, &argv);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
}

/// True when the process was started by the login item and should not show a window.
#[must_use]
pub fn is_hidden_launch(argv: &[String]) -> bool {
    argv.iter().any(|arg| arg == HIDDEN_ARG)
}

#[cfg(test)]
mod tests {
    use super::is_hidden_launch;

    #[test]
    fn detects_the_login_item_flag() {
        assert!(is_hidden_launch(&["Timo".into(), "--hidden".into()]));
        assert!(!is_hidden_launch(&["Timo".into()]));
    }
}
