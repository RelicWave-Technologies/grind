//! Where an overlay window goes: pure geometry, in the numbers Electron works in.
//!
//! Port of the placement helpers of `legacy/agent/src/main/windows/overlay.ts`
//! (`center`, `topRight`, `bottomRight`, `trayPopoverPoint`). The arithmetic is
//! the TypeScript's, in the TypeScript's order, on `f64`.

use serde::{Deserialize, Serialize};

use crate::js::math::div;
use crate::js::number::{add, max, min, round, sub};

/// Port of `Rect`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Port of `Size`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// Port of `Point`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Default gutter of [`top_right`].
pub const TOP_RIGHT_GUTTER: f64 = 16.0;
/// Default gutter of [`bottom_right`].
pub const BOTTOM_RIGHT_GUTTER: f64 = 20.0;
/// Default gutter of [`tray_popover_point`].
pub const TRAY_POPOVER_GUTTER: f64 = 6.0;

/// `Math.max(min, Math.min(n, max))`.
fn clamp(n: f64, lo: f64, hi: f64) -> f64 {
    max(lo, min(n, hi))
}

/// Port of `center`: centred in the usable desktop area.
#[must_use]
pub fn center(wa: Rect, size: Size) -> Point {
    Point {
        x: round(add(wa.x, div(sub(wa.width, size.width), 2.0))),
        y: round(add(wa.y, div(sub(wa.height, size.height), 2.0))),
    }
}

/// Port of `topRight`: top-right with a gutter.
#[must_use]
pub fn top_right(wa: Rect, size: Size, gutter: f64) -> Point {
    Point {
        x: round(sub(sub(add(wa.x, wa.width), size.width), gutter)),
        y: round(add(wa.y, gutter)),
    }
}

/// Port of `bottomRight`: bottom-right with a gutter.
#[must_use]
pub fn bottom_right(wa: Rect, size: Size, gutter: f64) -> Point {
    Point {
        x: round(sub(sub(add(wa.x, wa.width), size.width), gutter)),
        y: round(sub(sub(add(wa.y, wa.height), size.height), gutter)),
    }
}

/// Port of `trayPopoverPoint`: below top menu bars, above bottom taskbars.
#[must_use]
pub fn tray_popover_point(tray: Rect, wa: Rect, size: Size, gutter: f64) -> Point {
    let min_x = add(wa.x, gutter);
    let max_x = sub(sub(add(wa.x, wa.width), size.width), gutter);
    let centered_x = sub(add(tray.x, div(tray.width, 2.0)), div(size.width, 2.0));
    let x = round(clamp(centered_x, min_x, max(min_x, max_x)));

    let min_y = add(wa.y, gutter);
    let max_y = sub(sub(add(wa.y, wa.height), size.height), gutter);
    let below_y = add(add(tray.y, tray.height), gutter);
    let above_y = sub(sub(tray.y, size.height), gutter);
    let fits_below = add(below_y, size.height) <= sub(add(wa.y, wa.height), gutter);
    let preferred_y = if fits_below { below_y } else { above_y };
    let y = round(clamp(preferred_y, min_y, max(min_y, max_y)));

    Point { x, y }
}
