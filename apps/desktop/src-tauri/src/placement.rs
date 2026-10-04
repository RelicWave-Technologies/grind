//! Where an overlay window goes. The geometry lives in `timo_core::placement`
//! (a port of the placement helpers in legacy/agent/src/main/windows/overlay.ts,
//! fixture-checked against the TypeScript); this module only converts the shell's
//! whole physical pixels to the JavaScript numbers that port works on and back.
//! Screen coordinates are far below 2^53, so the conversions are exact.

use timo_core::js::number::{f64_to_i64, i64_to_f64};
use timo_core::placement as core;

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// A window size in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub width: i64,
    pub height: i64,
}

/// A window origin (top-left) in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: i64,
    pub y: i64,
}

/// An exact `i64` pixel count as a JavaScript number. A screen never exceeds
/// 2^53 pixels; `NaN` (which `to_px` maps to `0`) is only a fallback.
fn num(n: i64) -> f64 {
    i64_to_f64(n).unwrap_or(f64::NAN)
}

/// A JavaScript pixel result back to whole pixels (`0` for a non-integer).
fn to_px(x: f64) -> i64 {
    f64_to_i64(x).unwrap_or(0)
}

fn rect(r: Rect) -> core::Rect {
    core::Rect {
        x: num(r.x),
        y: num(r.y),
        width: num(r.width),
        height: num(r.height),
    }
}

fn size(s: Size) -> core::Size {
    core::Size {
        width: num(s.width),
        height: num(s.height),
    }
}

fn point(p: core::Point) -> Point {
    Point {
        x: to_px(p.x),
        y: to_px(p.y),
    }
}

/// Centred in the work area: blocking attention prompts.
#[must_use]
pub fn center(work: Rect, window: Size) -> Point {
    point(core::center(rect(work), size(window)))
}

/// Top-right with a gutter: the "ready to work?" toast.
#[must_use]
pub fn top_right(work: Rect, window: Size, gutter: i64) -> Point {
    point(core::top_right(rect(work), size(window), num(gutter)))
}

/// Bottom-right with a gutter: the floating bar's default home.
#[must_use]
pub fn bottom_right(work: Rect, window: Size, gutter: i64) -> Point {
    point(core::bottom_right(rect(work), size(window), num(gutter)))
}

/// Tray popover: centred under the icon, below a top menu bar or above a bottom
/// taskbar, clamped inside the work area.
#[must_use]
pub fn tray_popover_point(tray: Rect, work: Rect, window: Size, gutter: i64) -> Point {
    point(core::tray_popover_point(
        rect(tray),
        rect(work),
        size(window),
        num(gutter),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect {
        x: 0,
        y: 25,
        width: 1440,
        height: 875,
    };

    #[test]
    fn math_round_halves_go_up_even_when_negative() {
        // JS: Math.round(-33.5) === -33, Math.round(33.5) === 34, Math.round(-0.5) === 0
        let work = |x| Rect {
            x,
            y: 0,
            width: 0,
            height: 0,
        };
        let one = Size {
            width: 1,
            height: 0,
        };
        // x = round(work.x + (0 - 1) / 2) = round(work.x - 0.5)
        assert_eq!(center(work(-33), one).x, -33);
        assert_eq!(center(work(34), one).x, 34);
        assert_eq!(center(work(0), one).x, 0);
    }

    #[test]
    fn center_matches_the_formula_with_a_half_pixel() {
        let size = Size {
            width: 481,
            height: 332,
        };
        // x = round(0 + (1440 - 481) / 2) = round(479.5) = 480
        assert_eq!(center(WORK, size), Point { x: 480, y: 297 });
    }

    #[test]
    fn center_on_a_display_left_of_the_origin() {
        let work = Rect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        // round(-1920 + (1920 - 481) / 2) = round(-1200.5) = -1200
        assert_eq!(
            center(
                work,
                Size {
                    width: 481,
                    height: 332
                }
            )
            .x,
            -1200
        );
    }

    #[test]
    fn ready_to_work_sits_top_right_with_a_16_gutter() {
        let size = Size {
            width: 320,
            height: 168,
        };
        assert_eq!(top_right(WORK, size, 16), Point { x: 1104, y: 41 });
    }

    #[test]
    fn floating_bar_defaults_to_bottom_right_with_a_20_gutter() {
        let size = Size {
            width: 268,
            height: 44,
        };
        assert_eq!(bottom_right(WORK, size, 20), Point { x: 1152, y: 836 });
    }

    #[test]
    fn popover_hangs_below_a_menu_bar_icon() {
        let tray = Rect {
            x: 1200,
            y: 0,
            width: 24,
            height: 24,
        };
        let size = Size {
            width: 300,
            height: 340,
        };
        // centred_x = 1200 + 12 - 150 = 1062; below_y = 24 + 6 = 30, but the work
        // area starts at y = 25 so the top clamp (25 + 6) wins: 31.
        assert_eq!(
            tray_popover_point(tray, WORK, size, 6),
            Point { x: 1062, y: 31 }
        );
    }

    #[test]
    fn popover_is_clamped_at_the_right_edge() {
        let tray = Rect {
            x: 1430,
            y: 0,
            width: 24,
            height: 24,
        };
        let size = Size {
            width: 300,
            height: 340,
        };
        // max_x = 0 + 1440 - 300 - 6 = 1134
        assert_eq!(tray_popover_point(tray, WORK, size, 6).x, 1134);
    }

    #[test]
    fn popover_goes_above_a_bottom_taskbar() {
        let work = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let tray = Rect {
            x: 1800,
            y: 1040,
            width: 24,
            height: 40,
        };
        let size = Size {
            width: 300,
            height: 340,
        };
        // below_y = 1086 does not fit; above_y = 1040 - 340 - 6 = 694
        assert_eq!(tray_popover_point(tray, work, size, 6).y, 694);
    }

    #[test]
    fn popover_rounds_a_half_pixel_centre_up() {
        let tray = Rect {
            x: 1000,
            y: 0,
            width: 25,
            height: 24,
        };
        let size = Size {
            width: 300,
            height: 340,
        };
        // centred_x = 1000 + 12.5 - 150 = 862.5 -> 863
        assert_eq!(tray_popover_point(tray, WORK, size, 6).x, 863);
    }
}
