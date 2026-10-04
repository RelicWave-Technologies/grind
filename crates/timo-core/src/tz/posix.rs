//! POSIX `TZ` rules (the footer of a `TZif` file, and the `SystemV/*` ids).
//!
//! `std offset [dst [offset] [,start[/time],end[/time]]]`, with `Mm.w.d`, `Jn`
//! and `n` day rules. These drive every instant after a zone's last explicit
//! transition, so they are what makes 2038 and 2100 work.

use super::civil::{
    SECONDS_PER_DAY, days_from_civil, days_in_month, is_leap_year, weekday_from_days,
    year_of_seconds,
};

/// How a transition names its day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Day {
    /// `Mm.w.d`: weekday `d` (0 = Sunday) of week `w` (5 = last) of month `m`.
    #[allow(
        clippy::enum_variant_names,
        reason = "named after the POSIX `Mm.w.d` form"
    )]
    MonthWeekDay { month: i64, week: i64, weekday: i64 },
    /// `Jn`: day 1..=365, February 29 never counted.
    Julian1(i64),
    /// `n`: day 0..=365, February 29 counted.
    Julian0(i64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Transition {
    day: Day,
    /// Local wall-clock seconds after midnight; may be negative or over 24 h.
    time: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Dst {
    offset: i64,
    start: Transition,
    end: Transition,
}

/// A parsed rule: standard offset and optional daylight saving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PosixRule {
    /// Seconds east of UTC (POSIX writes the opposite sign).
    std_offset: i64,
    dst: Option<Dst>,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let hit = self.peek() == Some(byte);
        if hit {
            self.pos += 1;
        }
        hit
    }

    /// A zone abbreviation: `<...>` or three or more letters.
    fn name(&mut self) -> Option<()> {
        if self.eat(b'<') {
            while self.peek()? != b'>' {
                self.pos += 1;
            }
            self.pos += 1;
            return Some(());
        }
        let start = self.pos;
        while self.peek().is_some_and(|b| b.is_ascii_alphabetic()) {
            self.pos += 1;
        }
        (self.pos - start >= 3).then_some(())
    }

    fn number(&mut self) -> Option<i64> {
        let start = self.pos;
        let mut value: i64 = 0;
        while let Some(d) = self.peek().filter(u8::is_ascii_digit) {
            value = value.checked_mul(10)?.checked_add(i64::from(d - b'0'))?;
            self.pos += 1;
        }
        (self.pos > start).then_some(value)
    }

    /// `[+-]hh[:mm[:ss]]` as seconds.
    fn clock(&mut self) -> Option<i64> {
        let sign = if self.eat(b'-') {
            -1
        } else {
            self.eat(b'+');
            1
        };
        let mut seconds = self.number()? * 3_600;
        if self.eat(b':') {
            seconds += self.number()? * 60;
            if self.eat(b':') {
                seconds += self.number()?;
            }
        }
        Some(sign * seconds)
    }

    fn day(&mut self) -> Option<Day> {
        if self.eat(b'M') {
            let month = self.number()?;
            self.eat(b'.').then_some(())?;
            let week = self.number()?;
            self.eat(b'.').then_some(())?;
            let weekday = self.number()?;
            Some(Day::MonthWeekDay {
                month,
                week,
                weekday,
            })
        } else if self.eat(b'J') {
            Some(Day::Julian1(self.number()?))
        } else {
            Some(Day::Julian0(self.number()?))
        }
    }

    fn transition(&mut self) -> Option<Transition> {
        let day = self.day()?;
        let time = if self.eat(b'/') { self.clock()? } else { 7_200 };
        Some(Transition { day, time })
    }
}

impl PosixRule {
    /// Parse a POSIX `TZ` string; `None` if it is malformed.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let mut c = Cursor {
            bytes: text.as_bytes(),
            pos: 0,
        };
        c.name()?;
        let std_offset = -c.clock()?;
        if c.peek().is_none() {
            return Some(Self {
                std_offset,
                dst: None,
            });
        }
        c.name()?;
        let offset = if matches!(c.peek(), Some(b',') | None) {
            std_offset + 3_600
        } else {
            -c.clock()?
        };
        let (start, end) = if c.eat(b',') {
            let start = c.transition()?;
            c.eat(b',').then_some(())?;
            (start, c.transition()?)
        } else {
            let day = |month, week| Transition {
                day: Day::MonthWeekDay {
                    month,
                    week,
                    weekday: 0,
                },
                time: 7_200,
            };
            (day(3, 2), day(11, 1))
        };
        (c.peek().is_none()).then_some(())?;
        Some(Self {
            std_offset,
            dst: Some(Dst { offset, start, end }),
        })
    }

    /// The UTC instants (seconds) daylight saving starts and ends in `year`,
    /// `None` for a rule without daylight saving.
    #[must_use]
    pub fn dst_bounds(&self, year: i64) -> Option<(i64, i64)> {
        let dst = self.dst.as_ref()?;
        Some((
            local_seconds(year, &dst.start) - self.std_offset,
            local_seconds(year, &dst.end) - dst.offset,
        ))
    }

    /// The `(standard, daylight)` offsets in seconds east, if there is daylight saving.
    #[must_use]
    pub fn offsets(&self) -> (i64, Option<i64>) {
        (self.std_offset, self.dst.as_ref().map(|d| d.offset))
    }

    /// A fixed zone with no daylight saving (seconds east of UTC).
    #[must_use]
    pub const fn fixed(seconds_east: i64) -> Self {
        Self {
            std_offset: seconds_east,
            dst: None,
        }
    }

    /// The UTC offset in seconds east of UTC at `unix_seconds`.
    #[must_use]
    pub fn offset_at(&self, unix_seconds: i64) -> i64 {
        let Some(dst) = &self.dst else {
            return self.std_offset;
        };
        let year = year_of_seconds(unix_seconds + self.std_offset);
        // The start is read on the standard clock, the end on the daylight one.
        let start = local_seconds(year, &dst.start) - self.std_offset;
        let end = local_seconds(year, &dst.end) - dst.offset;
        let in_dst = if start < end {
            unix_seconds >= start && unix_seconds < end
        } else {
            unix_seconds >= start || unix_seconds < end
        };
        if in_dst { dst.offset } else { self.std_offset }
    }
}

/// Local seconds since 1970-01-01T00:00 (as if UTC) of a transition in `year`.
fn local_seconds(year: i64, t: &Transition) -> i64 {
    let days = match t.day {
        Day::MonthWeekDay {
            month,
            week,
            weekday,
        } => {
            let first = days_from_civil(year, month, 1);
            let ahead = (weekday - weekday_from_days(first)).rem_euclid(7);
            let mut day = 1 + ahead + (week - 1) * 7;
            if day > days_in_month(year, month) {
                day -= 7;
            }
            first + day - 1
        }
        Day::Julian1(n) => {
            let leap = i64::from(is_leap_year(year) && n >= 60);
            days_from_civil(year, 1, 1) + n - 1 + leap
        }
        Day::Julian0(n) => days_from_civil(year, 1, 1) + n,
    };
    days * SECONDS_PER_DAY + t.time
}
