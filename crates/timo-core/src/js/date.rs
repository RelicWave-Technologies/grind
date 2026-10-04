//! `new Date(string).getTime()` for the ISO 8601 shapes the API sends.
//!
//! V8 parses far more than ISO (`"hello 2020"`, `"Jan 1 2020"`, `"2020/01/02"`)
//! and reads a date-time without an offset in the machine's time zone. None of
//! that is reproduced: a string outside the shapes below is reported as
//! [`DateParse::Unsupported`] instead of guessed at, so the caller can tell
//! "JavaScript would say NaN" from "JavaScript would say something this port
//! cannot compute". See `PARITY.md`.
//!
//! Supported shapes (all verified against V8 by `tests/fixtures/js/date_parse.json`):
//! `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (UTC), and `<date>T<time><offset>` where the
//! date is any of those, the time is `HH:mm[:ss[.f+]]`, and the offset is `Z` or
//! `+HH:mm`/`-HH:mm`. Years are `YYYY` or `+YYYYYY`/`-YYYYYY`.

use super::number::i64_to_f64;

/// What `new Date(s).getTime()` yields, or why this port will not say.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DateParse {
    /// A valid time value in epoch milliseconds (always a whole number).
    Time(f64),
    /// V8 gives `NaN` (Invalid Date) for this ISO-shaped string.
    Invalid,
    /// Not an ISO shape this port supports (legacy format or local time).
    Unsupported,
}

const MS_PER_DAY: i64 = 86_400_000;
/// `TimeClip`: the largest magnitude a time value may have.
const MAX_TIME: i64 = 8_640_000_000_000_000;

/// Port of the V8 `Date.parse` behaviour for ISO strings (ECMA-262 `Date.parse`
/// with V8's day overflow: Feb 30 rolls into March).
#[must_use]
pub fn parse(s: &str) -> DateParse {
    if s.is_empty() {
        return DateParse::Invalid;
    }
    let mut cursor = Cursor {
        bytes: s.as_bytes(),
    };
    match read(&mut cursor) {
        Some(parsed) if cursor.bytes.is_empty() => parsed.resolve(),
        _ => DateParse::Unsupported,
    }
}

struct Cursor<'a> {
    bytes: &'a [u8],
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.first().copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        if found {
            self.bytes = self.bytes.get(1..).unwrap_or_default();
        }
        found
    }

    /// Exactly `n` ASCII digits as a number.
    fn digits(&mut self, n: usize) -> Option<i64> {
        let (head, rest) = self.bytes.split_at_checked(n)?;
        if !head.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.bytes = rest;
        Some(
            head.iter()
                .fold(0, |acc, b| acc * 10 + i64::from(b.wrapping_sub(b'0'))),
        )
    }

    /// One or more ASCII digits, as the raw bytes.
    fn digit_run(&mut self) -> Option<&[u8]> {
        let len = self.bytes.iter().take_while(|b| b.is_ascii_digit()).count();
        let (run, rest) = self.bytes.split_at_checked(len)?;
        if run.is_empty() {
            return None;
        }
        self.bytes = rest;
        Some(run)
    }
}

/// The fields of an ISO string before any range check.
struct Fields {
    year: i64,
    negative_zero_year: bool,
    has_month: bool,
    month: i64,
    day: i64,
    time: Option<TimeFields>,
}

struct TimeFields {
    hour: i64,
    minute: i64,
    second: i64,
    millis: i64,
    fraction_is_zero: bool,
    /// Offset from UTC in minutes, `east` positive. `(hours, minutes, sign)`.
    offset: (i64, i64, i64),
}

fn read(c: &mut Cursor<'_>) -> Option<Fields> {
    let (year, negative_zero_year) = read_year(c)?;
    let mut month = 1;
    let mut day = 1;
    let has_month = c.eat(b'-');
    if has_month {
        month = c.digits(2)?;
        if c.eat(b'-') {
            day = c.digits(2)?;
        }
    }
    let time = if c.eat(b'T') {
        Some(read_time(c)?)
    } else {
        None
    };
    Some(Fields {
        year,
        negative_zero_year,
        has_month,
        month,
        day,
        time,
    })
}

fn read_year(c: &mut Cursor<'_>) -> Option<(i64, bool)> {
    if c.eat(b'+') {
        return Some((c.digits(6)?, false));
    }
    if c.eat(b'-') {
        let year = c.digits(6)?;
        return Some((-year, year == 0));
    }
    Some((c.digits(4)?, false))
}

fn read_time(c: &mut Cursor<'_>) -> Option<TimeFields> {
    let hour = c.digits(2)?;
    if !c.eat(b':') {
        return None;
    }
    let minute = c.digits(2)?;
    let mut second = 0;
    let mut millis = 0;
    let mut fraction_is_zero = true;
    if c.eat(b':') {
        second = c.digits(2)?;
        if c.eat(b'.') {
            let run = c.digit_run()?;
            fraction_is_zero = run.iter().all(|b| *b == b'0');
            millis = leading_millis(run);
        }
    }
    let offset = read_offset(c)?;
    Some(TimeFields {
        hour,
        minute,
        second,
        millis,
        fraction_is_zero,
        offset,
    })
}

/// `.f+` truncated (not rounded) to milliseconds.
fn leading_millis(run: &[u8]) -> i64 {
    (0..3).fold(0, |acc, i| {
        let digit = run.get(i).map_or(0, |b| i64::from(b.wrapping_sub(b'0')));
        acc * 10 + digit
    })
}

fn read_offset(c: &mut Cursor<'_>) -> Option<(i64, i64, i64)> {
    if c.eat(b'Z') {
        return Some((0, 0, 1));
    }
    let sign = if c.eat(b'+') {
        1
    } else if c.eat(b'-') {
        -1
    } else {
        return None;
    };
    let hours = c.digits(2)?;
    if !c.eat(b':') {
        return None;
    }
    Some((hours, c.digits(2)?, sign))
}

impl Fields {
    fn in_range(&self) -> bool {
        (1..=12).contains(&self.month) && (1..=31).contains(&self.day)
    }

    /// Range checks (V8 gives NaN outside them), then the time value.
    fn resolve(&self) -> DateParse {
        if self.negative_zero_year && self.time.is_none() && self.has_month && self.in_range() {
            // V8 sends `-000000-MM[-DD]` through its legacy parser, which reads
            // local time. Not reproduced. (Bare `-000000` and anything with a
            // time part is NaN.)
            return DateParse::Unsupported;
        }
        if self.negative_zero_year || !self.in_range() {
            return DateParse::Invalid;
        }
        let day_ms = (days_from_civil(self.year, self.month) + self.day - 1) * MS_PER_DAY;
        let Some(time) = &self.time else {
            return clip(day_ms);
        };
        match time.ms_of_day_and_offset() {
            Some(ms) => clip(day_ms + ms),
            None => DateParse::Invalid,
        }
    }
}

impl TimeFields {
    /// Milliseconds past midnight, less the offset; `None` if a field is out of range.
    fn ms_of_day_and_offset(&self) -> Option<i64> {
        let (offset_hours, offset_minutes, sign) = self.offset;
        let hour_ok = self.hour < 24 || (self.hour == 24 && self.is_midnight_tail());
        if !hour_ok
            || self.minute > 59
            || self.second > 59
            || offset_hours > 23
            || offset_minutes > 59
        {
            return None;
        }
        let local = ((self.hour * 60 + self.minute) * 60 + self.second) * 1000 + self.millis;
        Some(local - sign * (offset_hours * 60 + offset_minutes) * 60_000)
    }

    /// `24:00:00.000` is the only valid hour-24 time.
    fn is_midnight_tail(&self) -> bool {
        self.minute == 0 && self.second == 0 && self.fraction_is_zero
    }
}

fn clip(ms: i64) -> DateParse {
    if ms.abs() > MAX_TIME {
        return DateParse::Invalid;
    }
    // |ms| <= 8.64e15 < 2^53, so the conversion is always exact.
    i64_to_f64(ms).map_or(DateParse::Invalid, DateParse::Time)
}

/// Days from 1970-01-01 to the first of `month` (1-12) in `year`
/// (proleptic Gregorian; Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y.rem_euclid(400);
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
