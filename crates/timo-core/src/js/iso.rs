//! `new Date(ms).toISOString()`.
//!
//! The device and server clocks hand the agent fractional milliseconds; the wire
//! format truncates them. `new Date(x)` applies `TimeClip` (NaN or a magnitude
//! above 8.64e15 is invalid) and then truncates towards zero; `toISOString`
//! throws a `RangeError` for an invalid date and writes years outside 0..=9999
//! as a sign and six digits.

use thiserror::Error;

use super::number::{f64_to_i64, trunc};

/// The largest magnitude `TimeClip` accepts.
const MAX_TIME: f64 = 8_640_000_000_000_000.0;
const MS_PER_DAY: i64 = 86_400_000;

/// `RangeError: Invalid time value`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("Invalid time value")]
pub struct InvalidTimeValue;

/// `new Date(ms).toISOString()`.
pub fn to_iso_string(ms: f64) -> Result<String, InvalidTimeValue> {
    if !ms.is_finite() || ms.abs() > MAX_TIME {
        return Err(InvalidTimeValue);
    }
    let t = f64_to_i64(trunc(ms)).map_err(|_| InvalidTimeValue)?;
    let days = t.div_euclid(MS_PER_DAY);
    let in_day = t.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    let (hours, rest) = (in_day / 3_600_000, in_day % 3_600_000);
    let (minutes, rest) = (rest / 60_000, rest % 60_000);
    let (seconds, millis) = (rest / 1000, rest % 1000);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", year.unsigned_abs())
    } else {
        format!("+{year:06}")
    };
    Ok(format!(
        "{year_text}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z"
    ))
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian
/// calendar (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}
