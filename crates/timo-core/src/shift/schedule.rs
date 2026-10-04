//! The weekly shift schedule, as `packages/types/src/shifts.ts` types it.

use serde::Deserialize;

use crate::tz::js_trim_start;

/// `DaySchedule` (non-null arm): `HH:MM` start and end. The wire schema
/// guarantees the shape; the reducers still read it the way the TypeScript does
/// (`parseInt` of each side of the colon), so a malformed string behaves alike.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DaySchedule {
    pub start: String,
    pub end: String,
}

/// `ShiftSchedule`: one optional day per weekday key. A missing key and `null`
/// are both "day off" (`if (!day)` in the TypeScript).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ShiftSchedule {
    #[serde(default)]
    pub sun: Option<DaySchedule>,
    #[serde(default)]
    pub mon: Option<DaySchedule>,
    #[serde(default)]
    pub tue: Option<DaySchedule>,
    #[serde(default)]
    pub wed: Option<DaySchedule>,
    #[serde(default)]
    pub thu: Option<DaySchedule>,
    #[serde(default)]
    pub fri: Option<DaySchedule>,
    #[serde(default)]
    pub sat: Option<DaySchedule>,
}

impl ShiftSchedule {
    /// `schedule[WEEKDAYS[weekday]]` with `WEEKDAYS = ['sun', 'mon', ...]`.
    #[must_use]
    pub fn day(&self, weekday: i64) -> Option<&DaySchedule> {
        match weekday {
            0 => self.sun.as_ref(),
            1 => self.mon.as_ref(),
            2 => self.tue.as_ref(),
            3 => self.wed.as_ref(),
            4 => self.thu.as_ref(),
            5 => self.fri.as_ref(),
            6 => self.sat.as_ref(),
            _ => None,
        }
    }
}

/// `Number.parseInt(text, 10)`: leading whitespace, an optional sign, then ASCII
/// digits (anything after is ignored). `None` is `NaN`. Digit runs too long for
/// an `i64` saturate: they are far outside any clock field either way.
#[must_use]
pub fn parse_int(text: &str) -> Option<i64> {
    let text = js_trim_start(text);
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, text.get(1..)?),
        Some(b'+') => (false, text.get(1..)?),
        _ => (false, text),
    };
    let mut value: i64 = 0;
    let mut any = false;
    for byte in digits.bytes().take_while(u8::is_ascii_digit) {
        any = true;
        value = value
            .saturating_mul(10)
            .saturating_add(i64::from(byte - b'0'));
    }
    any.then_some(if negative { -value } else { value })
}

/// `hhmm.split(':').map(parseInt)` read as `[h ?? 0, m ?? 0]`: `None` when
/// either number is `NaN` (the clock fields are then not a valid time).
#[must_use]
pub fn hour_minute(hhmm: &str) -> Option<(i64, i64)> {
    let mut pieces = hhmm.split(':');
    let hour = parse_int(pieces.next().unwrap_or(""))?;
    let minute = match pieces.next() {
        Some(piece) => parse_int(piece)?,
        None => 0,
    };
    Some((hour, minute))
}
