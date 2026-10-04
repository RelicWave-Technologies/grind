//! Golden fixtures for the activity services, dumped from the real TypeScript
//! by `parity/src/gen/activity.ts`. Every recorded step must serialize to the
//! same bytes.
#![cfg(test)]

mod common;

use serde::{Deserialize, Serialize};
use timo_core::activity::{
    ActiveWindowObservation, ActiveWindowTracker, ActivityAggregator, ActivitySample,
    ActivityWindow, DominantWindow, MinuteSealer, SealerHost, activity_percent,
    coefficient_of_variation,
};
use timo_core::js::number::add;
use timo_core::js::ser::to_string;

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct Values {
    values: Vec<f64>,
}

#[test]
fn fixture_coefficient_of_variation() {
    common::run(
        "activity",
        "coefficient_of_variation",
        "coefficientOfVariation",
        |i: Values| json(&coefficient_of_variation(&i.values)),
    );
}

#[test]
fn fixture_activity_percent() {
    common::run(
        "activity",
        "activity_percent",
        "activityPercent",
        |w: ActivityWindow| json(&activity_percent(&w)),
    );
}

// --- ActivityAggregator -----------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum AggEvent {
    Key { ts: f64 },
    Click,
    Scroll,
    Move { ts: f64, x: f64, y: f64 },
    Flush { bucket: f64 },
    IsEmpty,
}

#[derive(Deserialize)]
struct AggIn {
    events: Vec<AggEvent>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum AggOut {
    Nothing(()),
    Flag(bool),
    Sample(ActivitySample),
}

fn run_aggregator(input: AggIn) -> Vec<AggOut> {
    let mut a = ActivityAggregator::new();
    input
        .events
        .into_iter()
        .map(|e| match e {
            AggEvent::Key { ts } => {
                a.on_key(ts);
                AggOut::Nothing(())
            }
            AggEvent::Click => {
                a.on_click();
                AggOut::Nothing(())
            }
            AggEvent::Scroll => {
                a.on_scroll();
                AggOut::Nothing(())
            }
            AggEvent::Move { ts, x, y } => {
                a.on_move(ts, x, y);
                AggOut::Nothing(())
            }
            AggEvent::Flush { bucket } => AggOut::Sample(a.flush(bucket)),
            AggEvent::IsEmpty => AggOut::Flag(a.is_empty()),
        })
        .collect()
}

#[test]
fn fixture_aggregator() {
    common::run("activity", "aggregator", "aggregator", |i: AggIn| {
        json(&run_aggregator(i))
    });
}

// --- MinuteSealer -----------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum SealEvent {
    #[serde(rename_all = "camelCase")]
    SetRecording {
        on: bool,
        entry_id: Option<String>,
    },
    Key {
        ts: f64,
    },
    Click,
    Scroll,
    Move {
        ts: f64,
        x: f64,
        y: f64,
    },
    Advance {
        ms: f64,
    },
    SetNow {
        ms: f64,
    },
    Tick,
    SealPartial,
}

#[derive(Deserialize)]
struct SealIn {
    start: f64,
    events: Vec<SealEvent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    sample: ActivitySample,
    entry_id: Option<String>,
}

#[derive(Serialize)]
struct SealStep {
    ret: Option<f64>,
    persisted: Vec<Persisted>,
}

struct Host {
    now_ms: f64,
    persisted: Vec<Persisted>,
}

impl SealerHost for Host {
    fn now(&mut self) -> f64 {
        self.now_ms
    }
    fn persist(&mut self, sample: &ActivitySample, entry_id: Option<&str>) {
        self.persisted.push(Persisted {
            sample: sample.clone(),
            entry_id: entry_id.map(str::to_owned),
        });
    }
}

fn apply_seal_event(s: &mut MinuteSealer<Host>, event: SealEvent) -> Option<f64> {
    match event {
        SealEvent::SetRecording { on, entry_id } => s.set_recording(on, entry_id.as_deref()),
        SealEvent::Key { ts } => s.on_key(ts),
        SealEvent::Click => s.on_click(),
        SealEvent::Scroll => s.on_scroll(),
        SealEvent::Move { ts, x, y } => s.on_move(ts, x, y),
        SealEvent::Advance { ms } => {
            let host = s.host_mut();
            host.now_ms = add(host.now_ms, ms);
        }
        SealEvent::SetNow { ms } => s.host_mut().now_ms = ms,
        SealEvent::Tick => return s.tick(),
        SealEvent::SealPartial => return s.seal_partial(),
    }
    None
}

fn run_sealer(input: SealIn) -> Vec<SealStep> {
    let mut s = MinuteSealer::new(Host {
        now_ms: input.start,
        persisted: Vec::new(),
    });
    input
        .events
        .into_iter()
        .map(|e| {
            let ret = apply_seal_event(&mut s, e);
            let persisted = std::mem::take(&mut s.host_mut().persisted);
            SealStep { ret, persisted }
        })
        .collect()
}

#[test]
fn fixture_minute_sealer() {
    common::run("activity", "minute_sealer", "minuteSealer", |i: SealIn| {
        json(&run_sealer(i))
    });
}

// --- ActiveWindowTracker ----------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum WinEvent {
    Observe { obs: ActiveWindowObservation },
    DominantFor { start: f64, end: f64 },
    Prune { before: f64 },
    Size,
    Clear,
}

#[derive(Deserialize)]
struct WinIn {
    max: Option<usize>,
    events: Vec<WinEvent>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum WinOut {
    Nothing(()),
    Count(usize),
    Window(DominantWindow),
}

fn run_window(input: WinIn) -> Vec<WinOut> {
    let mut t = input
        .max
        .map_or_else(ActiveWindowTracker::default, ActiveWindowTracker::new);
    input
        .events
        .into_iter()
        .map(|e| match e {
            WinEvent::Observe { obs } => {
                t.observe(obs);
                WinOut::Nothing(())
            }
            WinEvent::DominantFor { start, end } => WinOut::Window(t.dominant_for(start, end)),
            WinEvent::Prune { before } => {
                t.prune(before);
                WinOut::Nothing(())
            }
            WinEvent::Size => WinOut::Count(t.size()),
            WinEvent::Clear => {
                t.clear();
                WinOut::Nothing(())
            }
        })
        .collect()
}

#[test]
fn fixture_active_window() {
    common::run("activity", "active_window", "activeWindow", |i: WinIn| {
        json(&run_window(i))
    });
}
