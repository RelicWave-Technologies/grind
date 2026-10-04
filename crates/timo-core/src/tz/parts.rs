//! Wall-clock fields of an instant in a zone, as `Intl` reports them.

use serde::{Deserialize, Serialize};

use super::civil::{MAX_DATE_MS, MS_PER_SECOND, fields_of_millis};
use super::error::TzError;
use super::zone::{Zone, resolve};

/// Port of `packages/types/src/timezone.ts::ZonedDateTimeParts`: a wall clock
/// with no zone attached. Field order is the TypeScript object's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZonedDateTimeParts {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
}

/// `new Date(value).getTime()` for a number: `TimeClip`. `None` is an invalid
/// date (`NaN`): not finite or beyond ±8.64e15 ms. Otherwise the value is
/// truncated toward zero, so a fractional timer stamp loses its fraction.
#[must_use]
pub fn time_clip(value: f64) -> Option<i64> {
    if !value.is_finite() || value.abs() > 8.64e15 {
        return None;
    }
    // The guard above puts the value inside i64; truncation is the spec's
    // ToIntegerOrInfinity.
    crate::js::number::f64_to_i64(value.trunc()).ok()
}

/// What `Intl` prints for a year: the era-year, so 0 is "1" and -1 is "2".
const fn era_year(year: i64) -> i64 {
    if year > 0 { year } else { 1 - year }
}

/// The fields of `ms` in an already-resolved zone.
pub(crate) fn parts_in_zone(ms: i64, zone: &Zone) -> ZonedDateTimeParts {
    let seconds = ms.div_euclid(MS_PER_SECOND);
    let wall = (seconds + zone.offset_at(seconds)) * MS_PER_SECOND;
    let mut parts = fields_of_millis(wall);
    parts.year = era_year(parts.year);
    parts
}

/// Port of `packages/types/src/timezone.ts::zonedDateTimeParts`.
///
/// The TypeScript memoises `Intl.DateTimeFormat` objects per zone (128-entry
/// FIFO); a formatter has no state a result depends on, so the port keeps none.
pub fn zoned_date_time_parts(value: f64, time_zone: &str) -> Result<ZonedDateTimeParts, TzError> {
    let ms = time_clip(value).ok_or(TzError::InvalidDateOrTimezone)?;
    let zone = resolve(time_zone).ok_or(TzError::InvalidDateOrTimezone)?;
    Ok(parts_in_zone(ms, &zone))
}

/// Same, from a time value already known to be inside `Date`'s range.
pub(crate) fn parts_at(ms: i64, zone: &Zone) -> Result<ZonedDateTimeParts, TzError> {
    if ms.abs() > MAX_DATE_MS {
        return Err(TzError::InvalidDateOrTimezone);
    }
    Ok(parts_in_zone(ms, zone))
}
