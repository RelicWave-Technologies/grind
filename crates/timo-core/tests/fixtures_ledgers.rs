//! Golden fixtures for `clamp.ts`, `timerLedger.ts` and `todayLedger.ts`.
#![cfg(test)]

mod common;

use serde::Deserialize;
use timo_core::js::ser::to_string;
use timo_core::{
    CanonicalTimerEntryLike, ReconcileInput, TimeEntry, canonical_timer_entry_payload,
    clamp_entry_to_server_clock, reconcile_today_ledger,
};

#[derive(Deserialize)]
struct Clamp {
    entry: TimeEntry,
    #[serde(rename = "nowMs")]
    now_ms: f64,
    #[serde(rename = "skewMs")]
    skew_ms: Option<f64>,
}

#[derive(Deserialize)]
struct Canonical {
    entry: CanonicalTimerEntryLike,
}

fn json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[test]
fn fixture_clamp_entry_to_server_clock() {
    common::run(
        "clamp",
        "clamp_entry_to_server_clock",
        "clampEntryToServerClock",
        |i: Clamp| json(&clamp_entry_to_server_clock(&i.entry, i.now_ms, i.skew_ms)),
    );
}

#[test]
fn fixture_canonical_timer_entry_payload() {
    common::run(
        "timerLedger",
        "canonical_timer_entry_payload",
        "canonicalTimerEntryPayload",
        |i: Canonical| {
            canonical_timer_entry_payload(&i.entry)
                .map_err(|e| e.to_string())
                .and_then(|p| json(&p))
        },
    );
}

#[test]
fn fixture_reconcile_today_ledger() {
    common::run(
        "todayLedger",
        "reconcile_today_ledger",
        "reconcileTodayLedger",
        |i: ReconcileInput| {
            reconcile_today_ledger(&i)
                .map_err(|e| e.to_string())
                .and_then(|p| json(&p))
        },
    );
}
