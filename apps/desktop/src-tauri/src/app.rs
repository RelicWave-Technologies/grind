//! Builds and runs the Tauri app.

use tauri::{AppHandle, Builder, RunEvent};

use crate::commands::{app, settings, window};
use crate::guard::guard_panics;
use crate::plugins;
use crate::windows::{create, present};

/// A second launch (another click on the app, or the OS opening a `timo://`
/// link) lands here instead of starting a new process. Port of legacy
/// `second-instance`: bring the app forward unless it was a login-item launch.
/// (The link itself is forwarded to the deep-link plugin by single-instance.)
pub fn on_second_instance(app: &AppHandle, argv: &[String]) {
    if !plugins::is_hidden_launch(argv) {
        present::show_main(app);
    }
}

/// Start the app. Returns only if startup fails or the app exits.
pub fn run() -> Result<(), tauri::Error> {
    init_logging();
    let builder = plugins::register(Builder::default());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .invoke_handler(tauri::generate_handler![
            window::window_open_main,
            window::window_dismiss_floating_bar,
            app::app_relaunch,
            settings::settings_open_data_folder,
            settings::settings_get,
        ])
        .setup(|app| {
            let handle = app.handle();
            create::create_all(handle)?;
            crate::tray::build(handle)?;
            #[cfg(debug_assertions)]
            crate::dev::show_requested(handle);
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            guard_panics("run_event", || on_run_event(app, &event));
        });
    Ok(())
}

fn on_run_event(app: &AppHandle, event: &RunEvent) {
    if matches!(event, RunEvent::Ready) {
        let argv: Vec<String> = std::env::args().collect();
        if !plugins::is_hidden_launch(&argv) {
            present::show_main_at_launch(app);
        }
    }
    // A Dock click on an already-running app (legacy `app.on('activate')`).
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        present::show_main(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

fn init_logging() {
    // A second init (tests, re-entry) is harmless: keep the first subscriber.
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init()
        .ok();
}
