//! Golden fixtures for the update-state reducer, dumped from the real
//! TypeScript by `parity/src/gen/updates.ts`.
#![cfg(test)]

mod common;

use serde::{Deserialize, Serialize};
use timo_core::js::ser::to_string;
use timo_core::updates_state::{
    TimerInstallState, UpdateChannel, UpdateEvent, apply_update_event, can_install_update,
    compare_versions, initial_update_status, is_version_newer, next_retry_delay_ms,
};

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct Pair {
    a: String,
    b: String,
}

#[test]
fn fixture_compare_versions() {
    common::run(
        "updates",
        "compare_versions",
        "compareVersions",
        |i: Pair| json(&compare_versions(&i.a, &i.b)),
    );
}

#[derive(Deserialize)]
struct Newer {
    current: String,
    candidate: Option<String>,
}

#[test]
fn fixture_is_version_newer() {
    common::run(
        "updates",
        "is_version_newer",
        "isVersionNewer",
        |i: Newer| json(&is_version_newer(&i.current, i.candidate.as_deref())),
    );
}

#[derive(Deserialize)]
struct Count {
    n: f64,
}

#[test]
fn fixture_next_retry_delay_ms() {
    common::run(
        "updates",
        "next_retry_delay_ms",
        "nextRetryDelayMs",
        |i: Count| json(&next_retry_delay_ms(i.n)),
    );
}

#[derive(Deserialize)]
struct Timer {
    timer: TimerInstallState,
}

#[test]
fn fixture_can_install_update() {
    common::run(
        "updates",
        "can_install_update",
        "canInstallUpdate",
        |i: Timer| json(&can_install_update(&i.timer)),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitIn {
    enabled: bool,
    current_version: String,
    channel: UpdateChannel,
    can_install_now: Option<bool>,
}

#[test]
fn fixture_initial_update_status() {
    common::run(
        "updates",
        "initial_update_status",
        "initialUpdateStatus",
        |i: InitIn| {
            json(&initial_update_status(
                i.enabled,
                &i.current_version,
                i.channel,
                i.can_install_now,
            ))
        },
    );
}

#[derive(Deserialize)]
struct ApplyIn {
    init: InitIn,
    events: Vec<UpdateEvent>,
}

#[test]
fn fixture_apply_update_event() {
    common::run(
        "updates",
        "apply_update_event",
        "applyUpdateEvent",
        |i: ApplyIn| {
            let mut status = initial_update_status(
                i.init.enabled,
                &i.init.current_version,
                i.init.channel,
                i.init.can_install_now,
            );
            let out: Vec<_> = i
                .events
                .iter()
                .map(|e| {
                    status = apply_update_event(&status, e);
                    status.clone()
                })
                .collect();
            json(&out)
        },
    );
}
