//! Golden fixtures for the capture logic, dumped from the real TypeScript by
//! `parity/src/gen/capture.ts`.
#![cfg(test)]

mod common;

use std::cell::Cell;

use serde::{Deserialize, Serialize};
use timo_core::capture::{
    AsyncLru, LoadOutcome, Lookup, RetentionInput, UploadError, activity_window_for_shot,
    next_delay_ms, plan_screenshot_retention, screenshot_retry_delay_ms,
    screenshot_upload_failure_decision, should_defer_capture,
};
use timo_core::js::ser::to_string;

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct Ms {
    ms: f64,
}

#[test]
fn fixture_next_delay_ms() {
    common::run("capture", "next_delay_ms", "nextDelayMs", |i: Ms| {
        json(&next_delay_ms(i.ms))
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Defer {
    idle_seconds: f64,
    deferrals: f64,
}

#[test]
fn fixture_should_defer_capture() {
    common::run(
        "capture",
        "should_defer_capture",
        "shouldDeferCapture",
        |i: Defer| json(&should_defer_capture(i.idle_seconds, i.deferrals)),
    );
}

#[test]
fn fixture_plan_screenshot_retention() {
    common::run(
        "capture",
        "plan_screenshot_retention",
        "planScreenshotRetention",
        |i: RetentionInput| json(&plan_screenshot_retention(&i)),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shot {
    captured_at: f64,
    older_captured_at: Option<f64>,
    default_window_ms: f64,
}

#[test]
fn fixture_activity_window_for_shot() {
    common::run(
        "capture",
        "activity_window_for_shot",
        "activityWindowForShot",
        |i: Shot| {
            json(&activity_window_for_shot(
                i.captured_at,
                i.older_captured_at,
                i.default_window_ms,
            ))
        },
    );
}

#[derive(Deserialize)]
struct RetryDelay {
    attempts: f64,
    r: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Delay {
    value: f64,
    rng_calls: u32,
}

#[test]
fn fixture_screenshot_retry_delay_ms() {
    common::run(
        "capture",
        "screenshot_retry_delay_ms",
        "screenshotRetryDelayMs",
        |i: RetryDelay| {
            let calls = Cell::new(0_u32);
            let value = screenshot_retry_delay_ms(i.attempts, || {
                calls.set(calls.get() + 1);
                i.r
            });
            json(&Delay {
                value,
                rng_calls: calls.get(),
            })
        },
    );
}

#[derive(Deserialize)]
struct Decision {
    attempts: f64,
    err: UploadError,
    now: f64,
    r: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Decided {
    decision: timo_core::capture::ScreenshotUploadFailureDecision,
    rng_calls: u32,
}

#[test]
fn fixture_screenshot_upload_failure_decision() {
    common::run(
        "capture",
        "screenshot_upload_failure_decision",
        "screenshotUploadFailureDecision",
        |i: Decision| {
            let calls = Cell::new(0_u32);
            let decision = screenshot_upload_failure_decision(i.attempts, &i.err, i.now, || {
                calls.set(calls.get() + 1);
                i.r
            });
            json(&Decided {
                decision,
                rng_calls: calls.get(),
            })
        },
    );
}

// --- AsyncLru ---------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum LruEvent {
    Get {
        key: String,
    },
    Settle {
        load: usize,
        how: How,
        value: String,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum How {
    Value,
    Null,
    Reject,
}

#[derive(Deserialize)]
struct LruIn {
    max: f64,
    events: Vec<LruEvent>,
}

/// What a `get` promise is bound to.
enum Bound {
    Load(usize),
    Value(String),
}

struct Load {
    key: String,
    token: u64,
    outcome: Option<LoadOutcome<String>>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Status {
    Word(&'static str),
    Value { value: String },
}

#[derive(Serialize)]
struct LruStep {
    started: Option<usize>,
    keys: Vec<String>,
    statuses: Vec<Status>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum LruOut {
    CtorError {
        #[serde(rename = "ctorError")]
        ctor_error: String,
    },
    Steps {
        steps: Vec<LruStep>,
    },
}

fn status_of(bound: &Bound, loads: &[Load]) -> Status {
    match bound {
        Bound::Value(v) => Status::Value { value: v.clone() },
        Bound::Load(i) => match loads.get(*i).and_then(|l| l.outcome.as_ref()) {
            None => Status::Word("pending"),
            Some(LoadOutcome::Loaded(v)) => Status::Value { value: v.clone() },
            Some(LoadOutcome::Missing) => Status::Word("null"),
            Some(LoadOutcome::Failed) => Status::Word("error"),
        },
    }
}

fn settle(
    cache: &mut AsyncLru<String>,
    loads: &mut [Load],
    load: usize,
    outcome: LoadOutcome<String>,
) {
    if let Some(l) = loads.get_mut(load).filter(|l| l.outcome.is_none()) {
        l.outcome = Some(outcome.clone());
        cache.settle(&l.key.clone(), l.token, outcome);
    }
}

fn run_lru(input: LruIn) -> LruOut {
    let mut cache = match AsyncLru::<String>::new(input.max) {
        Ok(c) => c,
        Err(e) => {
            return LruOut::CtorError {
                ctor_error: e.to_string(),
            };
        }
    };
    let mut loads: Vec<Load> = Vec::new();
    let mut gets: Vec<Bound> = Vec::new();
    let mut steps = Vec::new();
    for event in input.events {
        let mut started = None;
        match event {
            LruEvent::Get { key } => match cache.get(&key) {
                Lookup::Hit(v) => gets.push(Bound::Value(v)),
                Lookup::Pending => {
                    let index = loads
                        .iter()
                        .rposition(|l| l.key == key && l.outcome.is_none())
                        .unwrap_or(0);
                    gets.push(Bound::Load(index));
                }
                Lookup::Miss(token) => {
                    started = Some(loads.len());
                    gets.push(Bound::Load(loads.len()));
                    loads.push(Load {
                        key,
                        token,
                        outcome: None,
                    });
                }
            },
            LruEvent::Settle { load, how, value } => {
                let outcome = match how {
                    How::Value => LoadOutcome::Loaded(value),
                    How::Null => LoadOutcome::Missing,
                    How::Reject => LoadOutcome::Failed,
                };
                settle(&mut cache, &mut loads, load, outcome);
            }
        }
        steps.push(LruStep {
            started,
            keys: cache.keys().into_iter().map(str::to_owned).collect(),
            statuses: gets.iter().map(|b| status_of(b, &loads)).collect(),
        });
    }
    LruOut::Steps { steps }
}

#[test]
fn fixture_async_lru() {
    common::run("capture", "async_lru", "asyncLru", |i: LruIn| {
        json(&run_lru(i))
    });
}
