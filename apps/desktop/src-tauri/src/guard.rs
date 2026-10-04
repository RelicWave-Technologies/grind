//! Panic seatbelt for callbacks that run inside an `AppKit` / Win32 event.
//!
//! Port of the Airnote `guard_panics` / `run_on_main_guarded` pair. A Rust panic
//! that unwinds across the Objective-C boundary (a tray click, a window event, a
//! `run_on_main_thread` closure) aborts the whole process with SIGABRT. Running
//! such a callback inside `catch_unwind` drops the one UI event and keeps the app
//! (and the running timer) alive.

use std::panic::{AssertUnwindSafe, catch_unwind};

use tauri::{AppHandle, Runtime};

/// Run `f`, catching any panic. `None` means it panicked (already logged).
pub fn guard_panics<R>(label: &'static str, f: impl FnOnce() -> R) -> Option<R> {
    if let Ok(value) = catch_unwind(AssertUnwindSafe(f)) {
        Some(value)
    } else {
        tracing::error!(label, "recovered from a panic in a main-thread callback");
        None
    }
}

/// Dispatch `f` to the main thread inside the seatbelt. Use this for anything
/// that touches a window, panel or tray: window calls made off the main thread
/// freeze Windows (tao #381).
pub fn run_on_main_guarded<R: Runtime>(
    app: &AppHandle<R>,
    label: &'static str,
    f: impl FnOnce() + Send + 'static,
) -> tauri::Result<()> {
    app.run_on_main_thread(move || {
        guard_panics(label, f);
    })
}

#[cfg(test)]
mod tests {
    use super::guard_panics;

    #[test]
    fn returns_the_value_when_nothing_panics() {
        assert_eq!(guard_panics("ok", || 7), Some(7));
    }

    #[test]
    fn swallows_a_panic_and_reports_none() {
        assert_eq!(
            guard_panics("boom", || -> u8 { panic!("expected in test") }),
            None
        );
    }
}
