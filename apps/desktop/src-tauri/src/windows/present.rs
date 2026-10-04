//! Showing and hiding the already-created windows, always on the main thread.
//!
//! Port of the show/hide/position halves of popover.ts, floating.ts,
//! readyToWork.ts and attentionWindow.ts. NOT ported yet (needs services, see
//! README "Gaps"): the 1 Hz keep-on-top loop, saved floating-bar position,
//! prompt resizing, and re-asserting float after sleep or a display change.

use std::time::Duration;

use tauri::{AppHandle, LogicalSize, PhysicalPosition};

use super::spec::{self, WindowSpec};
use super::{log_err, window_of};
use crate::guard::run_on_main_guarded;
use crate::placement::{self, Point, Rect, Size};
use crate::screen::{self, Screen};

const LAUNCH_SETTLE: Duration = Duration::from_millis(700);

/// Where an overlay lands on the display the person is looking at.
#[cfg_attr(
    not(debug_assertions),
    allow(
        dead_code,
        reason = "only the debug-build dev helper and the not-yet-ported services call this"
    )
)]
#[derive(Clone, Copy, Debug)]
pub enum Anchor {
    Center,
    TopRight,
    BottomRight,
    /// Under (or, for a bottom taskbar, above) the tray icon at this physical rect.
    Tray(Rect),
}

/// Logical pixels to physical on this display (gutters are specified in DIPs).
fn physical_px(logical: f64, scale: f64) -> i64 {
    i64::from(
        LogicalSize::new(logical, logical)
            .to_physical::<i32>(scale)
            .width,
    )
}

fn physical_size(spec: &WindowSpec, scale: f64) -> Size {
    let size = LogicalSize::new(spec.width, spec.height).to_physical::<i32>(scale);
    Size {
        width: i64::from(size.width),
        height: i64::from(size.height),
    }
}

fn clamp_i32(n: i64) -> i32 {
    i32::try_from(n).unwrap_or(if n < 0 { i32::MIN } else { i32::MAX })
}

/// Pure: the origin for `spec` under `anchor` on `screen`.
pub fn place(spec: &WindowSpec, anchor: Anchor, screen: &Screen) -> Point {
    let size = physical_size(spec, screen.scale);
    let work = screen.work_area;
    match anchor {
        Anchor::Center => placement::center(work, size),
        Anchor::TopRight => placement::top_right(work, size, physical_px(16.0, screen.scale)),
        Anchor::BottomRight => placement::bottom_right(work, size, physical_px(20.0, screen.scale)),
        Anchor::Tray(tray) => {
            placement::tray_popover_point(tray, work, size, physical_px(6.0, screen.scale))
        }
    }
}

/// Position `spec` and bring it to the front. Hidden windows only move; the
/// panel/window difference is confined to `order_front`.
pub fn show_overlay(app: &AppHandle, spec: WindowSpec, anchor: Anchor) {
    let handle = app.clone();
    let queued = run_on_main_guarded(app, "windows.show_overlay", move || {
        let found = match anchor {
            Anchor::Tray(tray) => screen::at_point(&handle, tray_x(tray), tray_y(tray)),
            _ => screen::active(&handle),
        };
        if let (Some(window), Some(screen)) = (window_of(&handle, &spec), found) {
            let at = place(&spec, anchor, &screen);
            let position = PhysicalPosition::new(clamp_i32(at.x), clamp_i32(at.y));
            log_err("set overlay position", window.set_position(position));
        }
        order_front(&handle, &spec);
    });
    log_err("queue show_overlay", queued);
}

fn tray_x(tray: Rect) -> f64 {
    f64::from(clamp_i32(tray.x))
}

fn tray_y(tray: Rect) -> f64 {
    f64::from(clamp_i32(tray.y))
}

fn order_front(app: &AppHandle, spec: &WindowSpec) {
    let key = spec.label == spec::POPOVER.label;
    #[cfg(target_os = "macos")]
    if super::panel::order_front(app, spec.label, key) {
        return;
    }
    if let Some(window) = window_of(app, spec) {
        log_err("show overlay", window.show());
        if key {
            log_err("focus overlay", window.set_focus());
        }
    }
}

/// Hide an overlay (no-op if it is already hidden or missing).
pub fn hide(app: &AppHandle, spec: WindowSpec) {
    let handle = app.clone();
    let queued = run_on_main_guarded(app, "windows.hide", move || {
        #[cfg(target_os = "macos")]
        if super::panel::order_out(&handle, spec.label) {
            return;
        }
        if let Some(window) = window_of(&handle, &spec) {
            log_err("hide overlay", window.hide());
        }
    });
    log_err("queue hide", queued);
}

/// Tray click: hide the popover if it is up, else show it under the icon.
pub fn toggle_popover(app: &AppHandle, tray: Rect) {
    let visible = window_of(app, &spec::POPOVER)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        hide(app, spec::POPOVER);
    } else {
        show_overlay(app, spec::POPOVER, Anchor::Tray(tray));
    }
}

/// Bring the main window forward (tray "Open Timo", dock click, second launch).
pub fn show_main(app: &AppHandle) {
    let handle = app.clone();
    let queued = run_on_main_guarded(app, "windows.show_main", move || {
        let Some(window) = window_of(&handle, &spec::MAIN) else {
            return;
        };
        log_err("show main", window.show());
        log_err("unminimize main", window.unminimize());
        log_err("focus main", window.set_focus());
    });
    log_err("queue show_main", queued);
}

/// The first show, from `RunEvent::Ready`. Port of legacy `ensureMainWindow` +
/// `ready-to-show`, minus the login-item (`--hidden`) launch.
///
/// Shown once immediately and once more after the app has settled: measured
/// on macOS, a single show at launch left the app inactive and the window
/// parked behind the frontmost app (Stage Manager thumbnailed it) in 3 of 3
/// runs started from a terminal; with the second show it came forward in 6 of
/// 6. A Finder or Dock launch activates the app anyway, so this is belt and braces.
pub fn show_main_at_launch(app: &AppHandle) {
    show_main(app);
    let later = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(LAUNCH_SETTLE);
        show_main(&later);
    });
}

/// The floating bar's home: bottom-right of the display the person is on.
#[cfg_attr(
    not(debug_assertions),
    allow(
        dead_code,
        reason = "only the debug-build dev helper and the not-yet-ported services call this"
    )
)]
pub fn show_floating_bar(app: &AppHandle) {
    show_overlay(app, spec::FLOATING, Anchor::BottomRight);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RETINA: Screen = Screen {
        work_area: Rect {
            x: 0,
            y: 50,
            width: 2880,
            height: 1750,
        },
        scale: 2.0,
    };

    #[test]
    fn gutters_scale_with_the_display() {
        assert_eq!(physical_px(20.0, 2.0), 40);
        assert_eq!(physical_px(6.0, 1.0), 6);
    }

    #[test]
    fn the_floating_bar_lands_bottom_right_in_physical_pixels() {
        // 268x44 logical = 536x88 physical; gutter 20 logical = 40 physical.
        let at = place(&spec::FLOATING, Anchor::BottomRight, &RETINA);
        assert_eq!(
            at,
            Point {
                x: 2880 - 536 - 40,
                y: 50 + 1750 - 88 - 40
            }
        );
    }

    #[test]
    fn the_toast_lands_top_right() {
        let at = place(&spec::READY_TO_WORK, Anchor::TopRight, &RETINA);
        assert_eq!(
            at,
            Point {
                x: 2880 - 640 - 32,
                y: 50 + 32
            }
        );
    }
}
