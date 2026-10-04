//! The business day: a calendar date in a zone, and the real instants it spans.

use serde::Serialize;

use super::civil::add_calendar_days;
use super::error::TzError;
use super::instants::instant_for_zoned_date_time;
use super::parts::{ZonedDateTimeParts, time_clip, zoned_date_time_parts};
use super::zone::is_valid_time_zone;

/// The `{ start: Date, end: Date }` of a local day, as millisecond time values.
/// `end` is exclusive: a day is 23, 24 or 25 hours long.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DayWindow {
    pub start: i64,
    pub end: i64,
}

/// `/^\d{4}-\d{2}-\d{2}$/` (ASCII digits, no trailing newline allowed by `$`)
/// followed by `Number.parseInt` of each part. `None` when it does not match.
fn date_fields(date: &str) -> Option<(i64, i64, i64)> {
    let b = date.as_bytes();
    let shape = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    if !shape {
        return None;
    }
    Some((
        date.get(0..4)?.parse().ok()?,
        date.get(5..7)?.parse().ok()?,
        date.get(8..10)?.parse().ok()?,
    ))
}

fn midnight(year: i64, month: i64, day: i64) -> ZonedDateTimeParts {
    ZonedDateTimeParts {
        year,
        month,
        day,
        hour: 0,
        minute: 0,
        second: 0,
    }
}

fn window_of(year: i64, month: i64, day: i64, tz: &str) -> Result<DayWindow, TzError> {
    let start = instant_for_zoned_date_time(&midnight(year, month, day), tz)?;
    let (ny, nm, nd) = add_calendar_days(year, month, day, 1);
    let end = instant_for_zoned_date_time(&midnight(ny, nm, nd), tz)?;
    Ok(DayWindow { start, end })
}

/// Port of `packages/types/src/timezone.ts::localDayWindowInTimeZone`.
///
/// `None` for a malformed date, an invalid zone, a zero year/month/day, or a
/// day whose midnight (start or next day's) does not exist in the zone: that
/// last case is a zone that skips midnight at a DST change, and the app treats
/// it as "business day unavailable".
///
/// The TypeScript caches results (512-entry FIFO, keyed by zone and date). The
/// function is pure, so eviction cannot change an answer; the port has no cache.
#[must_use]
pub fn local_day_window_in_time_zone(date: &str, time_zone: &str) -> Option<DayWindow> {
    let (year, month, day) = date_fields(date)?;
    if !is_valid_time_zone(time_zone) {
        return None;
    }
    if year == 0 || month == 0 || day == 0 {
        return None;
    }
    window_of(year, month, day, time_zone).ok()
}

/// Port of `packages/types/src/timezone.ts::dateKeyInTimeZone`: the zone's
/// calendar date of an instant, `YYYY-MM-DD` with the year unpadded (a year over
/// 9999 has five digits, one under 1000 has fewer than four).
pub fn date_key_in_time_zone(value: f64, time_zone: &str) -> Result<String, TzError> {
    time_clip(value)
        .filter(|_| is_valid_time_zone(time_zone))
        .ok_or(TzError::InvalidDateOrTimezone)?;
    let p = zoned_date_time_parts(value, time_zone)?;
    Ok(format!("{}-{:02}-{:02}", p.year, p.month, p.day))
}
