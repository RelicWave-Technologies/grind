//! macOS overlays are `NSPanel`s, built like Airnote's status-bar panel.
//!
//! A non-activating panel floats over other apps' fullscreen Spaces and takes
//! clicks without activating the app. Activating a regular app from another
//! app's fullscreen Space makes macOS switch Spaces and yank the user to the
//! desktop; that is the whole reason legacy used `type: 'panel'`.

use tauri::{AppHandle, WebviewUrl};
use tauri_nspanel::{CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

use super::create::configure_overlay;
use super::spec::WindowSpec;

#[allow(
    unsafe_code,
    clippy::undocumented_unsafe_blocks,
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::needless_pass_by_value,
    clippy::used_underscore_binding,
    missing_debug_implementations,
    reason = "tauri_panel! expands to an NSPanel subclass with objc2 `unsafe` code; this module holds only that expansion"
)]
mod class {
    use tauri::Manager as _;
    use tauri_nspanel::tauri_panel;

    tauri_panel! {
        // Can become key (the bar's buttons and the popover's blur need it) but
        // never main, and never hides when the app deactivates.
        panel!(OverlayPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true,
                hides_on_deactivate: false,
                works_when_modal: true
            }
        })
    }
}

/// Pin to every Space and allow over fullscreen apps. Never `stationary`: it
/// conflicts with `can_join_all_spaces` and macOS silently drops the behaviour
/// after Space transitions (Tauri #5566).
fn collection_behavior() -> CollectionBehavior {
    CollectionBehavior::new()
        .can_join_all_spaces()
        .full_screen_auxiliary()
}

/// Build one overlay as a hidden NSPanel. Must run on the main thread (setup).
pub fn build(app: &AppHandle, spec: WindowSpec) -> tauri::Result<()> {
    PanelBuilder::<_, class::OverlayPanel>::new(app, spec.label)
        .url(WebviewUrl::App(spec.url().into()))
        .title("Timo")
        .size(tauri::Size::Logical(tauri::LogicalSize::new(
            spec.width,
            spec.height,
        )))
        .level(PanelLevel::Custom(spec.panel_level()))
        .floating(true)
        .hides_on_deactivate(false)
        .works_when_modal(true)
        .has_shadow(spec.has_shadow())
        .transparent(true)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .collection_behavior(collection_behavior())
        .no_activate(true)
        .with_window(move |window| configure_overlay(window, &spec))
        .build()?;
    Ok(())
}

/// `no_activate(true)` flips the activation policy to `Prohibited` while the
/// panel is built, which hides the whole app; restoring `Regular` does not
/// unhide it. Undo that side effect once, after the last panel exists.
pub fn restore_after_no_activate(app: &AppHandle) {
    if let Err(error) = app.show() {
        tracing::warn!(%error, "app unhide after panel creation failed");
    }
}

/// Order a panel front without activating the app; `key` also makes it the key
/// window so it receives focus and blur events.
pub fn order_front(app: &AppHandle, label: &str, key: bool) -> bool {
    use tauri_nspanel::ManagerExt as _;
    match app.get_webview_panel(label) {
        Ok(panel) => {
            if key {
                panel.show_and_make_key();
            } else {
                panel.show();
            }
            true
        }
        Err(_) => false,
    }
}

/// Hide a panel; `false` if there is no panel by that label.
pub fn order_out(app: &AppHandle, label: &str) -> bool {
    use tauri_nspanel::ManagerExt as _;
    match app.get_webview_panel(label) {
        Ok(panel) => {
            panel.hide();
            true
        }
        Err(_) => false,
    }
}
