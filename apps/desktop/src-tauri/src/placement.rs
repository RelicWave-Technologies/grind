//! Where an overlay window goes. Pure geometry on whole physical pixels, so it
//! tests on any host.
//!
//! Port of the placement helpers in legacy/agent/src/main/windows/overlay.ts
//! (`center`, `topRight`, `bottomRight`, `trayPopoverPoint`). Electron works in
//! DIPs with `Math.round`; here everything is whole pixels, and the one place a
//! half pixel can appear (centring) is rounded the way `Math.round` does
//! (half toward +infinity) by doubling instead of using floats.

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

/// `Math.round(doubled / 2)` for an integer `doubled`: halves go up, as in JS.
fn round_half(doubled: i64) -> i64 {
    (doubled + 1).div_euclid(2)
}

/// JS `Math.max(min, Math.min(n, max))`.
fn clamp(n: i64, min: i64, max: i64) -> i64 {
    min.max(n.min(max))
}

/// Centred in the work area: blocking attention prompts.
#[must_use]
pub fn center(work: Rect, size: Size) -> Point {
    Point {
        x: round_half(2 * work.x + work.width - size.width),
        y: round_half(2 * work.y + work.height - size.height),
    }
}

/// Top-right with a gutter: the "ready to work?" toast.
#[must_use]
pub fn top_right(work: Rect, size: Size, gutter: i64) -> Point {
    Point {
        x: work.x + work.width - size.width - gutter,
        y: work.y + gutter,
    }
}

/// Bottom-right with a gutter: the floating bar's default home.
#[must_use]
pub fn bottom_right(work: Rect, size: Size, gutter: i64) -> Point {
    Point {
        x: work.x + work.width - size.width - gutter,
        y: work.y + work.height - size.height - gutter,
    }
}

/// Tray popover: centred under the icon, below a top menu bar or above a bottom
/// taskbar, clamped inside the work area.
#[must_use]
pub fn tray_popover_point(tray: Rect, work: Rect, size: Size, gutter: i64) -> Point {
    let min_x = work.x + gutter;
    let max_x = work.x + work.width - size.width - gutter;
    // Doubled so a half-pixel centre stays exact until the final rounding.
    let centred_x2 = 2 * tray.x + tray.width - size.width;
    let x = round_half(clamp(centred_x2, 2 * min_x, 2 * min_x.max(max_x)));

    let min_y = work.y + gutter;
    let max_y = work.y + work.height - size.height - gutter;
    let below_y = tray.y + tray.height + gutter;
    let above_y = tray.y - size.height - gutter;
    let fits_below = below_y + size.height <= work.y + work.height - gutter;
    let preferred_y = if fits_below { below_y } else { above_y };
    let y = clamp(preferred_y, min_y, min_y.max(max_y));

    Point { x, y }
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
        assert_eq!(round_half(-67), -33);
        assert_eq!(round_half(67), 34);
        assert_eq!(round_half(-1), 0);
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
