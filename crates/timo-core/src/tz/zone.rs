//! Which zone ids are valid, and the UTC offset of a zone at an instant.
//!
//! The legacy app asks `Intl.DateTimeFormat('en-US', { timeZone })` whether an id
//! is valid, so validity is **Electron 33.2.0's ICU**, not the IANA list. That
//! accepts, case-insensitively: every IANA zone and link in tzdata 2024a, the
//! old three-letter Java ids (`IST`, `PST`...), the legacy `SystemV/*` ids and
//! offset ids (`+05:30`). Rejects: anything with a stray character or space,
//! `Z`, `UTC+5`, `Etc/GMT+13`, zones newer than tzdata 2024a.

use super::civil::{SECONDS_PER_DAY, days_from_civil};
use super::posix::PosixRule;
use super::tzif::TzData;

/// What an ICU-only id stands for.
enum Target {
    /// A zone in tzdata (by name).
    Zone(&'static str),
    /// A fixed offset in hours east of UTC.
    Hours(i64),
    /// The `SystemV/*DT` ids: a POSIX rule plus ICU's 1902-1975 history (see `system_v_dst`).
    Rule(&'static str),
}

/// Ids ICU accepts that tzdata 2024a does not carry, lowercase. Found by asking
/// Electron 33.2.0 itself (`Intl.DateTimeFormat(..).resolvedOptions().timeZone`)
/// and checked against its offsets in the parity fixtures.
const ICU_ONLY: &[(&str, Target)] = &[
    ("act", Target::Zone("Australia/Darwin")),
    ("aet", Target::Zone("Australia/Sydney")),
    ("agt", Target::Zone("America/Buenos_Aires")),
    ("art", Target::Zone("Africa/Cairo")),
    ("ast", Target::Zone("America/Anchorage")),
    ("bet", Target::Zone("America/Sao_Paulo")),
    ("bst", Target::Zone("Asia/Dhaka")),
    ("cat", Target::Zone("Africa/Maputo")),
    ("cnt", Target::Zone("America/St_Johns")),
    ("cst", Target::Zone("America/Chicago")),
    ("ctt", Target::Zone("Asia/Shanghai")),
    ("eat", Target::Zone("Africa/Nairobi")),
    ("ect", Target::Zone("Europe/Paris")),
    ("iet", Target::Zone("America/Indianapolis")),
    ("ist", Target::Zone("Asia/Calcutta")),
    ("jst", Target::Zone("Asia/Tokyo")),
    ("mit", Target::Zone("Pacific/Apia")),
    ("net", Target::Zone("Asia/Yerevan")),
    ("nst", Target::Zone("Pacific/Auckland")),
    ("plt", Target::Zone("Asia/Karachi")),
    ("pnt", Target::Zone("America/Phoenix")),
    ("prt", Target::Zone("America/Puerto_Rico")),
    ("pst", Target::Zone("America/Los_Angeles")),
    ("sst", Target::Zone("Pacific/Guadalcanal")),
    ("vst", Target::Zone("Asia/Saigon")),
    ("canada/east-saskatchewan", Target::Zone("America/Regina")),
    ("us/pacific-new", Target::Zone("America/Los_Angeles")),
    ("systemv/ast4", Target::Hours(-4)),
    ("systemv/cst6", Target::Hours(-6)),
    ("systemv/est5", Target::Hours(-5)),
    ("systemv/hst10", Target::Hours(-10)),
    ("systemv/mst7", Target::Hours(-7)),
    ("systemv/pst8", Target::Hours(-8)),
    ("systemv/yst9", Target::Hours(-9)),
    ("systemv/ast4adt", Target::Rule("AST4ADT,M4.5.0,M10.5.0")),
    ("systemv/cst6cdt", Target::Rule("CST6CDT,M4.5.0,M10.5.0")),
    ("systemv/est5edt", Target::Rule("EST5EDT,M4.5.0,M10.5.0")),
    ("systemv/mst7mdt", Target::Rule("MST7MDT,M4.5.0,M10.5.0")),
    ("systemv/pst8pdt", Target::Rule("PST8PDT,M4.5.0,M10.5.0")),
    ("systemv/yst9ydt", Target::Rule("YST9YDT,M4.5.0,M10.5.0")),
];

/// A resolved zone: something that can say its UTC offset at an instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Zone {
    Rule(PosixRule),
    Data(TzData),
}

impl Zone {
    /// The UTC offset in seconds east of UTC at `unix_seconds`.
    #[must_use]
    pub fn offset_at(&self, unix_seconds: i64) -> i64 {
        match self {
            Self::Rule(rule) => rule.offset_at(unix_seconds),
            Self::Data(data) => data.offset_at(unix_seconds),
        }
    }
}

/// An ASCII digit string of exactly two characters, as a number.
fn two_digits(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() == 2 && bytes.iter().all(u8::is_ascii_digit) {
        text.parse().ok()
    } else {
        None
    }
}

/// V8's offset time zones: `+HH`, `+HHMM` or `+HH:MM` with `+`, `-` or U+2212,
/// hours 00..=23 and minutes 00..=59. `-00:00` is the same zone as `+00:00`.
fn offset_id(id: &str) -> Option<i64> {
    let (sign, rest) = if let Some(rest) = id.strip_prefix('+') {
        (1, rest)
    } else if let Some(rest) = id.strip_prefix('-').or_else(|| id.strip_prefix('\u{2212}')) {
        (-1, rest)
    } else {
        return None;
    };
    let (hours, minutes) = match rest.len() {
        2 => (rest, "00"),
        4 => rest.split_at_checked(2)?,
        5 => {
            let (h, m) = rest.split_at_checked(2)?;
            (h, m.strip_prefix(':')?)
        }
        _ => return None,
    };
    let (hours, minutes) = (two_digits(hours)?, two_digits(minutes)?);
    (hours <= 23 && minutes <= 59).then_some(sign * (hours * 3_600 + minutes * 60))
}

/// ICU's `SystemV/*DT` zones: the US rule of 1967 (last Sunday of April to last
/// Sunday of October) applied in every year from 1902, with the two wartime-
/// style exceptions ICU carries for the 1973 energy crisis: 1974 ran from
/// January 6 to November 24 and 1975 started on February 23. Before 1902 the
/// zone is on standard time. Found by reading Electron 33.2.0's own answers.
fn system_v_dst(text: &str) -> Option<Zone> {
    let rule = PosixRule::parse(text)?;
    let (standard, daylight) = rule.offsets();
    let daylight = daylight?;
    let at = |month, day, local_offset: i64| {
        days_from_civil(1974, month, day) * SECONDS_PER_DAY + 7_200 - local_offset
    };
    let (mut times, mut kinds) = (Vec::new(), Vec::new());
    for year in 1902..=1975 {
        let (mut start, mut end) = rule.dst_bounds(year)?;
        if year == 1974 {
            start = at(1, 6, standard);
            end = at(11, 24, daylight);
        } else if year == 1975 {
            start = days_from_civil(1975, 2, 23) * SECONDS_PER_DAY + 7_200 - standard;
        }
        times.extend([start, end]);
        kinds.extend([1, 0]);
    }
    Some(Zone::Data(TzData::from_transitions(
        times,
        kinds,
        vec![standard, daylight],
        Some(rule),
    )))
}

fn named(name: &str) -> Option<Zone> {
    let (_, bytes) = jiff_tzdb::get(name)?;
    TzData::parse(bytes).map(Zone::Data)
}

/// Resolve an id the way `Intl` does; `None` when `Intl` would throw a `RangeError`.
#[must_use]
pub fn resolve(id: &str) -> Option<Zone> {
    if let Some(seconds) = offset_id(id) {
        return Some(Zone::Rule(PosixRule::fixed(seconds)));
    }
    let lower = id.to_ascii_lowercase();
    let alias = ICU_ONLY.iter().find(|(name, _)| *name == lower);
    match alias {
        Some((_, Target::Zone(name))) => named(name),
        Some((_, Target::Hours(hours))) => Some(Zone::Rule(PosixRule::fixed(hours * 3_600))),
        Some((_, Target::Rule(text))) => system_v_dst(text),
        None => named(id),
    }
}

/// Port of `packages/types/src/timezone.ts::isValidTimeZone`.
///
/// The TypeScript memoises the answer in a 128-entry FIFO map; the answer for a
/// given id never changes, so eviction order cannot change a result and the
/// port has no cache.
#[must_use]
pub fn is_valid_time_zone(value: &str) -> bool {
    resolve(value).is_some()
}
