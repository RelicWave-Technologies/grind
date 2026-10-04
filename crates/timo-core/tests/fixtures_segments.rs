//! Golden fixtures for `packages/core/src/segments.ts`, dumped from the real
//! TypeScript by `parity/`. Every case must serialize to the same bytes.
#![cfg(test)]

mod common;

use serde::Deserialize;
use timo_core::js::ser::to_string;
use timo_core::{
    CreateArgs, IdleDiscardArgs, OpenSegmentArgs, TimeEntry, apply_idle_discard,
    close_open_segment, close_time_entry, create_time_entry, get_open_segment, open_segment,
    recover_stale_entry, total_idle_trimmed_ms, total_worked_ms, validate_entry,
};

#[derive(Deserialize)]
struct Entry {
    entry: TimeEntry,
}

#[derive(Deserialize)]
struct EntryAt {
    entry: TimeEntry,
    at: f64,
}

#[derive(Deserialize)]
struct EntryOpen {
    entry: TimeEntry,
    args: OpenSegmentArgs,
}

#[derive(Deserialize)]
struct EntryIdle {
    entry: TimeEntry,
    args: IdleDiscardArgs,
}

#[derive(Deserialize)]
struct EntryLastActive {
    entry: TimeEntry,
    #[serde(rename = "lastKnownActiveAt")]
    last_known_active_at: f64,
}

#[derive(Deserialize)]
struct EntryNow {
    entry: TimeEntry,
    now: Option<f64>,
}

fn json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

fn entry_result(r: Result<TimeEntry, timo_core::CoreError>) -> Result<String, String> {
    r.map_err(|e| e.to_string()).and_then(|e| json(&e))
}

#[test]
fn fixture_create_time_entry() {
    common::run(
        "segments",
        "create_time_entry",
        "createTimeEntry",
        |a: CreateArgs| json(&create_time_entry(&a)),
    );
}

#[test]
fn fixture_get_open_segment() {
    common::run(
        "segments",
        "get_open_segment",
        "getOpenSegment",
        |i: Entry| json(&get_open_segment(&i.entry)),
    );
}

#[test]
fn fixture_close_open_segment() {
    common::run(
        "segments",
        "close_open_segment",
        "closeOpenSegment",
        |i: EntryAt| entry_result(close_open_segment(&i.entry, i.at)),
    );
}

#[test]
fn fixture_open_segment() {
    common::run("segments", "open_segment", "openSegment", |i: EntryOpen| {
        entry_result(open_segment(&i.entry, &i.args))
    });
}

#[test]
fn fixture_close_time_entry() {
    common::run(
        "segments",
        "close_time_entry",
        "closeTimeEntry",
        |i: EntryAt| entry_result(close_time_entry(&i.entry, i.at)),
    );
}

#[test]
fn fixture_apply_idle_discard() {
    common::run(
        "segments",
        "apply_idle_discard",
        "applyIdleDiscard",
        |i: EntryIdle| entry_result(apply_idle_discard(&i.entry, &i.args)),
    );
}

#[test]
fn fixture_recover_stale_entry() {
    common::run(
        "segments",
        "recover_stale_entry",
        "recoverStaleEntry",
        |i: EntryLastActive| entry_result(recover_stale_entry(&i.entry, i.last_known_active_at)),
    );
}

#[test]
fn fixture_total_worked_ms() {
    common::run(
        "segments",
        "total_worked_ms",
        "totalWorkedMs",
        |i: EntryNow| {
            total_worked_ms(&i.entry, i.now)
                .map_err(|e| e.to_string())
                .and_then(|ms| json(&ms))
        },
    );
}

#[test]
fn fixture_total_idle_trimmed_ms() {
    common::run(
        "segments",
        "total_idle_trimmed_ms",
        "totalIdleTrimmedMs",
        |i: Entry| json(&total_idle_trimmed_ms(&i.entry)),
    );
}

#[test]
fn fixture_validate_entry() {
    common::run("segments", "validate_entry", "validateEntry", |i: Entry| {
        json(&validate_entry(&i.entry))
    });
}
