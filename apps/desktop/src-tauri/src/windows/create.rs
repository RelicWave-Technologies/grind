//! Creates every window HIDDEN, once, during `setup`.
//!
//! Creating a WebView2 window from inside an IPC handler deadlocks Windows IPC
//! (wry #583), and the legacy app built these lazily; so the shell builds all
//! five up front and only ever shows and hides them afterwards.

use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};

#[cfg(target_os = "macos")]
use super::panel;
use super::spec::{self, Kind, WindowSpec};
use super::{log_err, window_of};
use crate::guard::guard_panics;

/// Build all windows. Overlays first so the one-time macOS app unhide that
/// follows panel creation (see `panel.rs`) happens before the main window shows.
pub fn create_all(app: &AppHandle) -> tauri::Result<()> {
    for overlay in [
        spec::POPOVER,
        spec::FLOATING,
        spec::ATTENTION,
        spec::READY_TO_WORK,
    ] {
        create_overlay(app, overlay)?;
    }
    create_main(app, spec::MAIN)?;
    #[cfg(target_os = "macos")]
    panel::restore_after_no_activate(app);
    Ok(())
}

/// Shared by the macOS panel path and the plain window path, so the two cannot
/// drift: frameless, transparent, never in the taskbar, born floating on every
/// workspace. Legacy `createOverlayWindow`.
pub fn configure_overlay<'a, M: Manager<Wry>>(
    builder: WebviewWindowBuilder<'a, Wry, M>,
    spec: &WindowSpec,
) -> WebviewWindowBuilder<'a, Wry, M> {
    builder
        .title("Timo")
        .inner_size(spec.width, spec.height)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .shadow(spec.has_shadow())
        .focused(false)
        .visible(false)
}

fn create_overlay(app: &AppHandle, spec: WindowSpec) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    panel::build(app, spec)?;
    #[cfg(not(target_os = "macos"))]
    {
        let url = WebviewUrl::App(spec.url().into());
        configure_overlay(WebviewWindowBuilder::new(app, spec.label, url), &spec).build()?;
    }
    if spec.label == spec::POPOVER.label {
        hide_popover_on_blur(app, spec);
    }
    Ok(())
}

/// The popover is transient: it dismisses when the user clicks away.
fn hide_popover_on_blur(app: &AppHandle, spec: WindowSpec) {
    let Some(window) = window_of(app, &spec) else {
        return;
    };
    let app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(false)) {
            guard_panics("popover.blur", || super::present::hide(&app, spec));
        }
    });
}

fn create_main(app: &AppHandle, spec: WindowSpec) -> tauri::Result<()> {
    let url = WebviewUrl::App(spec.url().into());
    let mut builder = WebviewWindowBuilder::new(app, spec.label, url)
        .title("Timo")
        .inner_size(spec.width, spec.height)
        .visible(false)
        // Solid light background, no vibrancy (legacy window.ts).
        .background_color(tauri::window::Color(0xF2, 0xF2, 0xF7, 0xFF));
    if let Some((width, height)) = spec.min {
        builder = builder.min_inner_size(width, height);
    }
    #[cfg(target_os = "macos")]
    {
        // hiddenInset: native traffic lights over our own toolbar. Electron's
        // trafficLightPosition (16, 18) is the top-left of the lights; tao's y is
        // not, so y = 27 is what lands the lights' centres at (23, 25) as
        // Electron's do (measured from a screenshot: 22.8, 24.8).
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 27.0));
    }
    debug_assert!(matches!(spec.kind, Kind::Main));
    keep_running_when_closed(&builder.build()?);
    Ok(())
}

/// Closing the main window hides it; the app lives in the tray (legacy
/// `attachMainWindowHandlers`). Quitting is explicit: tray menu or Cmd+Q.
fn keep_running_when_closed(window: &WebviewWindow) {
    let target = window.clone();
    window.on_window_event(move |event| {
        guard_panics("main.close", || {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                log_err("hide main on close", target.hide());
            }
        });
    });
}
