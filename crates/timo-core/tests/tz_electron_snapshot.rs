//! What the real Electron 33.2.0 (ICU 74.2, tzdata 2024a) says about the time zone
//! ids the harness Node disagrees with it on, recorded by
//! `parity/src/electronDrift.mjs` into `tests/data/tz_electron_drift.json`.
//!
//! The golden fixtures cannot hold these: the Node that dumps them (ICU 78,
//! tzdata 2026a) answers differently, and a fixture must come out the same under
//! Electron. The zone data here is tzdata 2024a too, so Rust must equal Electron
//! on every one of them. If `jiff-tzdb` is ever bumped past 2024a, this file is
//! where the difference shows up (see `PARITY.md`).
#![cfg(test)]

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use timo_core::tz::is_valid_time_zone;
use timo_core::tz::zone::resolve;

#[derive(Deserialize)]
struct Runtime {
    electron: String,
    icu: String,
    tz: String,
}

#[derive(Deserialize)]
struct Snapshot {
    runtime: Runtime,
    validity: BTreeMap<String, bool>,
    offsets: BTreeMap<String, Vec<(i64, i64)>>,
}

fn snapshot() -> Snapshot {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("data")
        .join("tz_electron_drift.json");
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

#[test]
fn the_snapshot_is_from_electron_33_2_0_with_tzdata_2024a() {
    let s = snapshot();
    assert_eq!(s.runtime.electron, "33.2.0");
    assert_eq!(s.runtime.icu, "74.2");
    assert_eq!(s.runtime.tz, "2024a");
}

#[test]
fn validity_matches_electron_where_node_22_disagrees() {
    let s = snapshot();
    assert_eq!(s.validity.len(), 2, "{:?}", s.validity);
    for (id, expected) in &s.validity {
        assert_eq!(is_valid_time_zone(id), *expected, "{id}");
    }
}

/// The offset-change table, scanned the way `electronDrift.mjs` scans it: a day
/// at a time, then bisected to the second.
fn table(id: &str) -> Vec<(i64, i64)> {
    let zone = resolve(id).unwrap_or_else(|| panic!("{id} is not valid here"));
    let to = 4_102_444_800;
    let mut previous = zone.offset_at(0);
    let mut list = vec![(0, previous)];
    let mut t = 86_400;
    while t <= to {
        let offset = zone.offset_at(t);
        if offset != previous {
            let (mut low, mut high) = (t - 86_400, t);
            while high - low > 1 {
                let mid = low + (high - low) / 2;
                if zone.offset_at(mid) == previous {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            list.push((high, offset));
            previous = offset;
        }
        t += 86_400;
    }
    list
}

#[test]
fn offsets_match_electron_where_node_22_disagrees() {
    let s = snapshot();
    assert_eq!(s.offsets.len(), 23, "{:?}", s.offsets.keys());
    for (id, expected) in &s.offsets {
        assert_eq!(&table(id), expected, "{id}");
    }
}
