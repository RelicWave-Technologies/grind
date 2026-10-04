// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = timo_desktop::run() {
        tracing::error!(%error, "Timo failed to start");
        std::process::exit(1);
    }
}
