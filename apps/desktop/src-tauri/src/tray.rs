//! The menu-bar / system-tray item. Port of legacy/agent/src/main/tray.ts:
//! left-click toggles the popover under the icon, right-click shows
//! "Open Timo" / "Quit Timo". NOT ported yet: the live elapsed-time title and
//! the "Restart to update" item (both need the timer / update services).

use tauri::AppHandle;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::guard::guard_panics;
use crate::placement::Rect;
use crate::windows::present;

const TRAY_ID: &str = "timo";
const OPEN: &str = "open";
const QUIT: &str = "quit";

/// macOS tints a template image to match the menu bar; Windows gets colour.
#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../icons/tray/trayTemplate@2x.png");
#[cfg(not(target_os = "macos"))]
const ICON: &[u8] = include_bytes!("../icons/tray/tray.png");

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, OPEN, "Open Timo", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, "Quit Timo", true, None::<&str>)?,
        ],
    )?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON)?)
        .tooltip("Timo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_icon);
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    builder.build(app)?;
    Ok(())
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "tray callback signature takes the event by value"
)]
fn on_menu(app: &AppHandle, event: MenuEvent) {
    guard_panics("tray.menu", || match event.id().as_ref() {
        OPEN => present::show_main(app),
        QUIT => app.exit(0),
        other => tracing::warn!(id = other, "unhandled tray menu id"),
    });
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "tray callback signature takes the event by value"
)]
fn on_icon(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    guard_panics("tray.click", || {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            rect,
            ..
        } = event
        {
            present::toggle_popover(tray.app_handle(), physical(rect));
        }
    });
}

/// The tray rect in physical pixels (macOS and Windows both report physical).
pub fn physical(rect: tauri::Rect) -> Rect {
    let position = rect.position.to_physical::<i32>(1.0);
    let size = rect.size.to_physical::<u32>(1.0);
    Rect {
        x: i64::from(position.x),
        y: i64::from(position.y),
        width: i64::from(size.width),
        height: i64::from(size.height),
    }
}

/// The icon's current screen rect, for showing the popover without a click.
#[cfg_attr(
    not(debug_assertions),
    allow(
        dead_code,
        reason = "only the debug-build dev helper and the not-yet-ported services call this"
    )
)]
pub fn icon_rect(app: &AppHandle) -> Option<Rect> {
    app.tray_by_id(TRAY_ID)?.rect().ok().flatten().map(physical)
}
