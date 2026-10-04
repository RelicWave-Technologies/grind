//! Direct tests of the pieces under the timezone fixtures. Not a port of any
//! TypeScript test (`packages/types` has none for `timezone.ts`): each expected
//! value below was read from Electron 33.2.0's own `Intl` when it was written,
//! and the golden fixtures are the proof of the whole.
#![cfg(test)]

use timo_core::shift::schedule::{hour_minute, parse_int};
use timo_core::tz::posix::PosixRule;
use timo_core::tz::{
    TzError, ZonedDateTimeParts, date_key_in_time_zone, instant_for_zoned_date_time,
    is_valid_time_zone, js_trim, local_day_window_in_time_zone, median_minute, parse_time_zone,
    possible_instants_for_zoned_date_time, time_clip, zoned_date_time_parts,
};

/// `[year, month, day, hour, minute, second]` as the parts of a wall clock.
fn parts([year, month, day, hour, minute, second]: [i64; 6]) -> ZonedDateTimeParts {
    ZonedDateTimeParts {
        year,
        month,
        day,
        hour,
        minute,
        second,
    }
}

/// Ids Electron 33.2.0's `Intl` accepts.
const VALID_IDS: &[&str] = &[
    "UTC",
    "utc",
    "GMT",
    "Etc/GMT+5",
    "etc/gmt+5",
    "Etc/GMT+12",
    "Etc/GMT-14",
    "US/Eastern",
    "america/new_york",
    "AMERICA/NEW_YORK",
    "EST",
    "EST5EDT",
    "CET",
    "IST",
    "PST",
    "SystemV/EST5",
    "SystemV/PST8PDT",
    "Factory",
    "Asia/Kathmandu",
    "Europe/Kyiv",
    "Pacific/Kanton",
    "+05:30",
    "-05:30",
    "+0530",
    "+05",
    "-00:00",
    "\u{2212}05:30",
    "+23:59",
    "+14:00",
];

/// Ids it rejects.
const INVALID_IDS: &[&str] = &[
    "",
    " ",
    "a",
    "Z",
    "Etc/GMT+13",
    "Etc/GMT-15",
    "Etc/GMT+01",
    "GMT+5",
    "UTC+5",
    "UTC+05:00",
    "+5",
    "+24:00",
    "+2400",
    "+05:60",
    "+05:30:15",
    "Asia/Kolkata ",
    " Asia/Kolkata",
    "Asia/Kolkata\n",
    "America/Coyhaique",
    "Etc/Unknown",
    "localtime",
    "posixrules",
    "\u{130}stanbul",
    "Asia/\u{212A}olkata",
    "America//New_York",
    "America/New_York/",
];

#[test]
fn valid_ids_follow_electron_icu() {
    for id in VALID_IDS {
        assert!(is_valid_time_zone(id), "{id}");
    }
    for id in INVALID_IDS {
        assert!(!is_valid_time_zone(id), "{id:?}");
    }
}

#[test]
fn the_schema_trims_like_javascript_and_limits_utf16_units() {
    assert_eq!(
        parse_time_zone(" Asia/Kolkata\n").as_deref(),
        Some("Asia/Kolkata")
    );
    assert_eq!(parse_time_zone("\u{feff}UTC\u{a0}").as_deref(), Some("UTC"));
    // U+0085 is not JavaScript whitespace (it is in Rust's).
    assert_eq!(js_trim("\u{85}x"), "\u{85}x");
    assert_eq!(parse_time_zone("UTC\u{85}"), None);
    assert_eq!(parse_time_zone(""), None);
    assert_eq!(
        parse_time_zone(&format!("{}UTC", " ".repeat(100))).as_deref(),
        Some("UTC")
    );
}

#[test]
fn a_business_day_is_23_24_or_25_hours() {
    let minutes = |date: &str, zone: &str| {
        let w = local_day_window_in_time_zone(date, zone).unwrap();
        (w.end - w.start) / 60_000
    };
    assert_eq!(minutes("2026-03-08", "America/New_York"), 23 * 60);
    assert_eq!(minutes("2026-03-09", "America/New_York"), 24 * 60);
    assert_eq!(minutes("2026-11-01", "America/New_York"), 25 * 60);
    // Lord Howe moves its clock by 30 minutes.
    assert_eq!(minutes("2026-10-04", "Australia/Lord_Howe"), 23 * 60 + 30);
    assert_eq!(minutes("2026-04-05", "Australia/Lord_Howe"), 24 * 60 + 30);
    let kolkata = local_day_window_in_time_zone("2026-07-15", "Asia/Kolkata").unwrap();
    assert_eq!(
        (kolkata.start, kolkata.end),
        (1_784_053_800_000, 1_784_140_200_000)
    );
}

#[test]
fn a_zone_that_skips_its_midnight_has_no_business_day() {
    // Havana springs forward at 00:00 -> 01:00; Apia skipped 2011-12-30 entirely.
    assert_eq!(
        local_day_window_in_time_zone("2026-03-08", "America/Havana"),
        None
    );
    assert_eq!(
        local_day_window_in_time_zone("2011-12-30", "Pacific/Apia"),
        None
    );
    assert!(local_day_window_in_time_zone("2011-12-29", "Pacific/Apia").is_none());
}

#[test]
fn fall_back_takes_the_first_occurrence_and_a_gap_is_an_error() {
    // 01:30 on 2026-11-01 in New York happens twice (EDT then EST).
    let two =
        possible_instants_for_zoned_date_time(&parts([2026, 11, 1, 1, 30, 0]), "America/New_York")
            .unwrap();
    assert_eq!(two, vec![1_793_511_000_000, 1_793_514_600_000]);
    assert_eq!(
        instant_for_zoned_date_time(&parts([2026, 11, 1, 1, 30, 0]), "America/New_York"),
        Ok(1_793_511_000_000)
    );
    // 02:30 on 2026-03-08 does not exist.
    assert_eq!(
        instant_for_zoned_date_time(&parts([2026, 3, 8, 2, 30, 0]), "America/New_York"),
        Err(TzError::NonexistentLocalTime)
    );
    assert_eq!(
        instant_for_zoned_date_time(&parts([2026, 2, 30, 0, 0, 0]), "UTC"),
        Err(TzError::InvalidLocalTime)
    );
    assert_eq!(
        instant_for_zoned_date_time(&parts([2026, 1, 1, 0, 0, 0]), "Nope"),
        Err(TzError::InvalidTimezone)
    );
}

#[test]
fn date_keys_and_parts_read_the_zone_clock() {
    assert_eq!(
        date_key_in_time_zone(1_784_059_200_000.0, "Asia/Kolkata").unwrap(),
        "2026-07-15"
    );
    assert_eq!(
        date_key_in_time_zone(1_784_059_200_000.0, "America/New_York").unwrap(),
        "2026-07-14"
    );
    assert_eq!(
        date_key_in_time_zone(f64::NAN, "UTC"),
        Err(TzError::InvalidDateOrTimezone)
    );
    assert_eq!(
        date_key_in_time_zone(0.0, "Nope"),
        Err(TzError::InvalidDateOrTimezone)
    );
    // A fractional timer stamp loses its fraction (`new Date(x)` truncates toward zero).
    assert_eq!(time_clip(1.9), Some(1));
    assert_eq!(time_clip(-1.9), Some(-1));
    assert_eq!(time_clip(8.64e15), Some(8_640_000_000_000_000));
    assert_eq!(time_clip(8.64e15 + 1.0), None);
    // Midnight reads as 00, not 24.
    assert_eq!(zoned_date_time_parts(0.0, "UTC").unwrap().hour, 0);
    // Years over 9999 and before 1 print as Intl does: an unpadded era year.
    assert_eq!(
        date_key_in_time_zone(253_402_300_800_000.0, "UTC").unwrap(),
        "10000-01-01"
    );
}

#[test]
fn the_median_of_present_readings() {
    assert_eq!(median_minute(&[]), None);
    assert_eq!(median_minute(&[None]), None);
    assert_eq!(median_minute(&[Some(1.0), Some(2.0)]), Some(2.0)); // Math.round(1.5)
    assert_eq!(
        median_minute(&[Some(-1.0), Some(0.0)]).map(f64::abs),
        Some(0.0)
    ); // Math.round(-0.5) is -0
    assert_eq!(
        median_minute(&[Some(3.0), None, Some(1.0), Some(2.0)]),
        Some(2.0)
    );
}

#[test]
fn posix_rules_cover_the_shapes_in_the_footers() {
    // Europe/Dublin: negative DST (winter time is "daylight").
    let dublin = PosixRule::parse("IST-1GMT0,M10.5.0,M3.5.0/1").unwrap();
    assert_eq!(dublin.offset_at(1_784_059_200), 3_600); // July
    assert_eq!(dublin.offset_at(1_768_478_400), 0); // January
    // Egypt: a transition at 24:00 and a half-hour southern rule (Lord Howe).
    assert!(PosixRule::parse("EET-2EEST,M4.5.5/0,M10.5.4/24").is_some());
    assert!(PosixRule::parse("<+1030>-10:30<+11>-11,M10.1.0,M4.1.0").is_some());
    assert!(PosixRule::parse("<-02>2<-01>,M3.5.0/-1,M10.5.0/0").is_some());
    assert!(PosixRule::parse("EST5EDT,J60/2,300").is_some());
    assert!(PosixRule::parse("").is_none());
    assert!(PosixRule::parse("EST5EDT,M3.2.0").is_none());
}

#[test]
fn parse_int_and_hh_mm_read_like_the_typescript() {
    assert_eq!(parse_int(" 09"), Some(9));
    assert_eq!(parse_int("-0"), Some(0));
    assert_eq!(parse_int("+7x"), Some(7));
    assert_eq!(parse_int("0x10"), Some(0));
    assert_eq!(parse_int("1e3"), Some(1));
    assert_eq!(parse_int(""), None);
    assert_eq!(parse_int("ab"), None);
    assert_eq!(parse_int("\u{0665}"), None);
    assert_eq!(hour_minute("09:30"), Some((9, 30)));
    assert_eq!(hour_minute("9"), Some((9, 0)));
    assert_eq!(hour_minute("09:30:15"), Some((9, 30)));
    assert_eq!(hour_minute(":30"), None);
    assert_eq!(hour_minute("09:x"), None);
}
