//! The display an overlay should appear on: the one under the cursor, because
//! that is where the person is looking. Port of `activeWorkArea()` in
//! legacy/agent/src/main/windows/overlay.ts (cursor display, primary as fallback).

use tauri::{AppHandle, Monitor};

use crate::placement::Rect;

/// A display's usable area (menu bar / taskbar excluded) and pixel density.
#[derive(Clone, Copy, Debug)]
pub struct Screen {
    pub work_area: Rect,
    pub scale: f64,
}

fn describe(monitor: &Monitor) -> Screen {
    let work = monitor.work_area();
    Screen {
        work_area: Rect {
            x: i64::from(work.position.x),
            y: i64::from(work.position.y),
            width: i64::from(work.size.width),
            height: i64::from(work.size.height),
        },
        scale: monitor.scale_factor(),
    }
}

/// The display under the cursor; the primary display if the cursor cannot be
/// resolved (never fail on a show path).
pub fn active(app: &AppHandle) -> Option<Screen> {
    let under_cursor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten());
    under_cursor
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|monitor| describe(&monitor))
}

/// The display containing a physical point (the tray icon).
pub fn at_point(app: &AppHandle, x: f64, y: f64) -> Option<Screen> {
    let found = app.monitor_from_point(x, y).ok().flatten();
    found
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|monitor| describe(&monitor))
}
