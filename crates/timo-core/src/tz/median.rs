//! `medianMinute`: the one pure helper in `timezone.ts` that is not about zones.

use crate::js::number::{add, round, sort_cmp};

/// Port of `packages/types/src/timezone.ts::medianMinute`.
///
/// The median of the present readings, `None` when there are none. `null`s are
/// skipped, not counted as midnight. An even count averages the middle pair and
/// rounds with `Math.round` (halves toward +Infinity).
#[must_use]
#[allow(
    clippy::float_arithmetic,
    reason = "(a + b) / 2 is the TypeScript's own arithmetic; the sum goes through js::number::add"
)]
pub fn median_minute(minutes: &[Option<f64>]) -> Option<f64> {
    let mut present: Vec<f64> = minutes.iter().flatten().copied().collect();
    // Array.prototype.sort is stable; (a, b) => a - b treats a NaN difference as equal.
    present.sort_by(|a, b| sort_cmp(*a, *b));
    let mid = present.len() / 2;
    if present.is_empty() {
        None
    } else if present.len() % 2 == 1 {
        present.get(mid).copied()
    } else {
        let (low, high) = (present.get(mid.checked_sub(1)?)?, present.get(mid)?);
        Some(round(add(*low, *high) / 2.0))
    }
}
