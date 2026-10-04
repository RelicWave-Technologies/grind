//! Golden fixtures for `packages/types/src/timezone.ts`, dumped from the real
//! TypeScript by `parity/` (`src/gen/tz.ts`). Every case must serialize to the
//! same bytes. Zones are resolved by `jiff-tzdb` 0.1.0 (tzdata 2024a, what
//! Electron 33.2.0's ICU carries); see `PARITY.md` for the versions and the ids
//! left out because the generating Node's ICU disagrees with Electron's.
#![cfg(test)]

mod common;

use common::run;
use serde::Deserialize;
use timo_core::js::json::quote;
use timo_core::js::ser::to_string;
use timo_core::tz::civil::{SECONDS_PER_DAY, days_from_civil};
use timo_core::tz::{
    TzError, ZonedDateTimeParts, date_key_in_time_zone, instant_for_zoned_date_time,
    is_valid_time_zone, local_day_window_in_time_zone, median_minute, parse_time_zone,
    possible_instants_for_zoned_date_time, zoned_date_time_parts,
};

fn json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

fn tz_err(e: TzError) -> String {
    e.to_string()
}

#[derive(Deserialize)]
struct IdIn {
    id: String,
}

#[derive(Deserialize)]
struct ValueOnly {
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValueIn {
    value: f64,
    time_zone: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartsIn {
    parts: ZonedDateTimeParts,
    time_zone: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DateIn {
    date: String,
    time_zone: String,
}

#[derive(Deserialize)]
struct MedianIn {
    minutes: Vec<Option<f64>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableIn {
    time_zone: String,
    from_year: i64,
    to_year: i64,
    step_days: i64,
}

#[test]
fn fixture_is_valid_time_zone() {
    let n = run("tz", "is_valid_time_zone", "isValidTimeZone", |i: IdIn| {
        json(&is_valid_time_zone(&i.id))
    });
    assert!(n > 2000, "{n}");
}

#[test]
fn fixture_time_zone_schema() {
    run(
        "tz",
        "time_zone_schema",
        "timeZoneSchema",
        |i: ValueOnly| {
            Ok(parse_time_zone(&i.value).map_or_else(
                || "{\"ok\":false}".to_owned(),
                |data| format!("{{\"ok\":true,\"data\":{}}}", quote(&data)),
            ))
        },
    );
}

#[test]
fn fixture_zoned_date_time_parts() {
    run(
        "tz",
        "zoned_date_time_parts",
        "zonedDateTimeParts",
        |i: ValueIn| {
            zoned_date_time_parts(i.value, &i.time_zone)
                .map_err(tz_err)
                .and_then(|p| json(&p))
        },
    );
}

/// Instants far from today: before 1900, after year 9999, at `Date`'s limits.
#[test]
fn fixture_zoned_date_time_parts_wide() {
    run(
        "tz",
        "zoned_date_time_parts_wide",
        "zonedDateTimePartsWide",
        |i: ValueIn| {
            zoned_date_time_parts(i.value, &i.time_zone)
                .map_err(tz_err)
                .and_then(|p| json(&p))
        },
    );
}

#[test]
fn fixture_date_key_in_time_zone() {
    run(
        "tz",
        "date_key_in_time_zone",
        "dateKeyInTimeZone",
        |i: ValueIn| {
            date_key_in_time_zone(i.value, &i.time_zone)
                .map_err(tz_err)
                .and_then(|k| json(&k))
        },
    );
}

#[test]
fn fixture_possible_instants_for_zoned_date_time() {
    run(
        "tz",
        "possible_instants_for_zoned_date_time",
        "possibleInstantsForZonedDateTime",
        |i: PartsIn| {
            possible_instants_for_zoned_date_time(&i.parts, &i.time_zone)
                .map_err(tz_err)
                .and_then(|v| json(&v))
        },
    );
}

#[test]
fn fixture_instant_for_zoned_date_time() {
    run(
        "tz",
        "instant_for_zoned_date_time",
        "instantForZonedDateTime",
        |i: PartsIn| {
            instant_for_zoned_date_time(&i.parts, &i.time_zone)
                .map_err(tz_err)
                .and_then(|v| json(&v))
        },
    );
}

#[test]
fn fixture_local_day_window_in_time_zone() {
    run(
        "tz",
        "local_day_window_in_time_zone",
        "localDayWindowInTimeZone",
        |i: DateIn| json(&local_day_window_in_time_zone(&i.date, &i.time_zone)),
    );
}

#[test]
fn fixture_median_minute() {
    run("tz", "median_minute", "medianMinute", |i: MedianIn| {
        json(&median_minute(&i.minutes))
    });
}

/// The UTC offset in seconds at an instant in seconds, read through the same
/// public function the TypeScript table reads (`zonedDateTimeParts`).
fn offset_at(time_zone: &str, seconds: i64) -> Result<i64, TzError> {
    let ms = timo_core::js::number::i64_to_f64(seconds * 1000).unwrap_or(f64::NAN);
    let p = zoned_date_time_parts(ms, time_zone)?;
    let wall = days_from_civil(p.year, p.month, p.day) * SECONDS_PER_DAY
        + p.hour * 3600
        + p.minute * 60
        + p.second;
    Ok(wall - seconds)
}

/// `parity/src/gen/tzZones.ts::offsetTransitions`, step for step.
fn offset_transitions(i: &TableIn) -> Result<Vec<(i64, i64)>, TzError> {
    let from = days_from_civil(i.from_year, 1, 1) * SECONDS_PER_DAY;
    let to = days_from_civil(i.to_year, 1, 1) * SECONDS_PER_DAY;
    let step = i.step_days * SECONDS_PER_DAY;
    let mut previous = offset_at(&i.time_zone, from)?;
    let mut list = vec![(from, previous)];
    let mut t = from + step;
    while t <= to {
        let offset = offset_at(&i.time_zone, t)?;
        if offset != previous {
            let (mut low, mut high) = (t - step, t);
            while high - low > 1 {
                let mid = low + (high - low) / 2;
                if offset_at(&i.time_zone, mid)? == previous {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            list.push((high, offset));
            previous = offset;
        }
        t += step;
    }
    Ok(list)
}

#[test]
fn fixture_offset_transitions() {
    run(
        "tz",
        "offset_transitions",
        "offsetTransitions",
        |i: TableIn| {
            offset_transitions(&i)
                .map_err(tz_err)
                .and_then(|v| json(&v))
        },
    );
}
