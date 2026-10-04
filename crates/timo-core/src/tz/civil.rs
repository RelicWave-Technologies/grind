//! Proleptic-Gregorian calendar arithmetic on integers.
//!
//! JavaScript's `Date.UTC`, `getUTC*` and `Intl` all use the proleptic Gregorian
//! calendar over a time value of whole milliseconds, so the day maths here is
//! exact integer arithmetic (Howard Hinnant's `days_from_civil`).

use super::error::TzError;
use super::parts::ZonedDateTimeParts;

pub const MS_PER_SECOND: i64 = 1_000;
pub const MS_PER_MINUTE: i64 = 60_000;
pub const MS_PER_HOUR: i64 = 3_600_000;
pub const MS_PER_DAY: i64 = 86_400_000;
pub const SECONDS_PER_DAY: i64 = 86_400;

/// `Date`'s range: a time value beyond ±8.64e15 ms is invalid (`NaN`).
pub const MAX_DATE_MS: i64 = 8_640_000_000_000_000;

/// Days since 1970-01-01 of a proleptic-Gregorian date (month 1..=12).
#[must_use]
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The `(year, month, day)` of a day count since 1970-01-01.
#[must_use]
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[must_use]
pub const fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// Days in a month (1..=12); 0 for anything else.
#[must_use]
pub const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// `getUTCDay()` for a day count: 0 = Sunday. 1970-01-01 was a Thursday.
#[must_use]
pub fn weekday_from_days(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

/// The calendar year of a time value in seconds.
#[must_use]
pub fn year_of_seconds(seconds: i64) -> i64 {
    civil_from_days(seconds.div_euclid(SECONDS_PER_DAY)).0
}

/// Wall-clock fields of a time value in milliseconds, as `getUTC*` reads them.
#[must_use]
pub fn fields_of_millis(ms: i64) -> ZonedDateTimeParts {
    let days = ms.div_euclid(MS_PER_DAY);
    let in_day = ms.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    ZonedDateTimeParts {
        year,
        month,
        day,
        hour: in_day / MS_PER_HOUR,
        minute: in_day % MS_PER_HOUR / MS_PER_MINUTE,
        second: in_day % MS_PER_MINUTE / MS_PER_SECOND,
    }
}

/// Port of `packages/types/src/timezone.ts::utcMillis` (not exported there).
///
/// `Date.UTC(...)` followed by a `getUTC*` round trip that must give the same
/// fields back. So the parts are accepted exactly when they are a canonical
/// calendar date and time (month 1..=12, a day that exists, hour 0..=23,
/// minute and second 0..=59) whose instant is inside `Date`'s range; years
/// 0..=99 fail because `Date.UTC` reads them as 1900..=1999.
pub fn utc_millis(parts: &ZonedDateTimeParts) -> Result<i64, TzError> {
    let canonical = (0..=23).contains(&parts.hour)
        && (0..=59).contains(&parts.minute)
        && (0..=59).contains(&parts.second)
        && (1..=12).contains(&parts.month)
        && parts.day >= 1
        && parts.day <= days_in_month(parts.year, parts.month)
        && !(0..=99).contains(&parts.year);
    // Years far outside Date's range cannot be canonical, and the day maths
    // below stays well inside i64 for anything this guard lets through.
    if !canonical || parts.year.abs() > 1_000_000 {
        return Err(TzError::InvalidLocalTime);
    }
    let days = days_from_civil(parts.year, parts.month, parts.day);
    let ms = days * MS_PER_DAY
        + parts.hour * MS_PER_HOUR
        + parts.minute * MS_PER_MINUTE
        + parts.second * MS_PER_SECOND;
    if ms.abs() > MAX_DATE_MS {
        return Err(TzError::InvalidLocalTime);
    }
    Ok(ms)
}

/// The day count of `Date.UTC(year, month0, date)`'s date part (`MakeDay`):
/// `month0` is zero-based and may be out of range (it carries into the year),
/// `date` is one-based and may overflow the month, and a year in 0..=99 is read
/// as 1900..=1999, exactly as `Date.UTC` does.
#[must_use]
pub fn make_day(year: i64, month0: i64, date: i64) -> i64 {
    let year = if (0..=99).contains(&year) {
        1900 + year
    } else {
        year
    };
    let y = year + month0.div_euclid(12);
    let m = month0.rem_euclid(12);
    days_from_civil(y, m + 1, 1) + date - 1
}

/// `new Date(Date.UTC(year, month - 1, day + offset))` read back with
/// `getUTCFullYear/Month/Date`: the calendar date `offset` days after the one given.
#[must_use]
pub fn add_calendar_days(year: i64, month: i64, day: i64, offset: i64) -> (i64, i64, i64) {
    civil_from_days(make_day(year, month - 1, day + offset))
}
