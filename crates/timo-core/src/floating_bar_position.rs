//! Port of `legacy/agent/src/main/windows/floatingBarPosition.ts`: pure geometry
//! for the floating bar's on-screen position.

use crate::js::number::{add, max, min, sub};
use crate::placement::{Point, Rect, Size};

/// Gap between the bar and the screen edge for the default corner.
pub const EDGE_MARGIN: f64 = 20.0;

/// Minimum on-screen overlap (px, per axis) for a saved position to count as
/// "still visible".
const MIN_VISIBLE: f64 = 48.0;

/// Port of `defaultCorner`: bottom-right of the primary work area.
#[must_use]
pub fn default_corner(primary_work_area: Rect, size: Size) -> Point {
    Point {
        x: sub(
            sub(
                add(primary_work_area.x, primary_work_area.width),
                size.width,
            ),
            EDGE_MARGIN,
        ),
        y: sub(
            sub(
                add(primary_work_area.y, primary_work_area.height),
                size.height,
            ),
            EDGE_MARGIN,
        ),
    }
}

/// Overlap length of two 1-D segments `[aStart, aEnd)` and `[bStart, bEnd)`.
fn overlap_1d(a_start: f64, a_len: f64, b_start: f64, b_len: f64) -> f64 {
    let start = max(a_start, b_start);
    let end = min(add(a_start, a_len), add(b_start, b_len));
    max(0.0, sub(end, start))
}

/// Port of `isVisibleEnough`: a window of `size` at `pos` shows at least
/// `MIN_VISIBLE` px on both axes within at least one work area.
#[must_use]
pub fn is_visible_enough(pos: Point, size: Size, work_areas: &[Rect]) -> bool {
    work_areas.iter().any(|wa| {
        let ox = overlap_1d(pos.x, size.width, wa.x, wa.width);
        let oy = overlap_1d(pos.y, size.height, wa.y, wa.height);
        let need_x = min(MIN_VISIBLE, size.width);
        let need_y = min(MIN_VISIBLE, size.height);
        ox >= need_x && oy >= need_y
    })
}

/// Port of `resolvePosition`: the saved position when it is still visible,
/// otherwise the default corner.
#[must_use]
pub fn resolve_position(
    saved: Option<Point>,
    size: Size,
    primary_work_area: Rect,
    work_areas: &[Rect],
) -> Point {
    match saved {
        Some(pos) if is_visible_enough(pos, size, work_areas) => pos,
        _ => default_corner(primary_work_area, size),
    }
}
