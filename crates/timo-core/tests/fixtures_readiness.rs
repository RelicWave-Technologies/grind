//! Golden fixtures for the tracking-readiness service, dumped from the real
//! TypeScript by `parity/src/gen/readiness.ts`.
#![cfg(test)]

mod common;

use serde::{Deserialize, Serialize};
use timo_core::desktop_types::{CaptureHealth, ScreenStatus};
use timo_core::js::ser::to_string;
use timo_core::tracking_readiness::{
    ActivityCaptureStatus, BlockingCapability, Inspect, PendingInspect, ReadinessInspection,
    Readings, SystemIdleState, TrackingBlockedError, TrackingReadiness, TrackingReadinessService,
    VerdictLog, is_inconclusive_screen_capture,
};

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct InconclusiveIn {
    blocking: Vec<BlockingCapability>,
    status: ScreenStatus,
    health: CaptureHealth,
    idle: SystemIdleState,
}

#[test]
fn fixture_is_inconclusive_screen_capture() {
    use timo_core::desktop_types::{
        AccessibilityPermission, DesktopPermissionSnapshot, ScreenPermission, ScreenUiState,
    };
    use timo_core::tracking_readiness::CapabilityState;
    common::run(
        "readiness",
        "is_inconclusive_screen_capture",
        "isInconclusiveScreenCapture",
        |i: InconclusiveIn| {
            // Only `blockingCapabilities` and `permissions.screen` are read.
            let inspection = ReadinessInspection {
                readiness: TrackingReadiness {
                    ready: i.blocking.is_empty(),
                    checked_at: String::new(),
                    screen_recording: CapabilityState::Ready,
                    accessibility: CapabilityState::Ready,
                    blocking_capabilities: i.blocking,
                },
                permissions: DesktopPermissionSnapshot {
                    screen: ScreenPermission {
                        status: i.status,
                        health: i.health,
                        state: ScreenUiState::Ok,
                    },
                    accessibility: AccessibilityPermission {
                        trusted: true,
                        ready: true,
                        recording: false,
                        capturing: false,
                        hook_running: false,
                    },
                },
                accessibility_error: None,
            };
            json(&is_inconclusive_screen_capture(&inspection, i.idle))
        },
    );
}

// --- the service ----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Event {
    #[serde(rename_all = "camelCase")]
    Set {
        platform: Option<String>,
        screen_status: Option<ScreenStatus>,
        screen_health: Option<CaptureHealth>,
        accessibility: Option<ActivityCaptureStatus>,
        now: Option<f64>,
    },
    Inspect {
        verify: bool,
    },
    Assert,
    RequestAccess,
    ResolveProbe {
        probe: usize,
        health: ProbeHealth,
    },
    NoteHealth {
        health: CaptureHealth,
    },
    Invalidate,
}

/// `Health | 'throw'`.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ProbeHealth {
    Ok,
    NoPermission,
    Empty,
    Error,
    Unknown,
    Throw,
}

impl ProbeHealth {
    fn health(self) -> Option<CaptureHealth> {
        match self {
            Self::Ok => Some(CaptureHealth::Ok),
            Self::NoPermission => Some(CaptureHealth::NoPermission),
            Self::Empty => Some(CaptureHealth::Empty),
            Self::Error => Some(CaptureHealth::Error),
            Self::Unknown => Some(CaptureHealth::Unknown),
            Self::Throw => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    platform: String,
    screen_status: ScreenStatus,
    screen_health: CaptureHealth,
    accessibility: ActivityCaptureStatus,
    now: f64,
    events: Vec<Event>,
}

#[derive(Serialize)]
struct Rejected {
    message: String,
    code: Option<&'static str>,
    readiness: Option<TrackingReadiness>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum CallStatus {
    Pending(&'static str),
    Value { value: Option<ReadinessInspection> },
    Rejected { rejected: Rejected },
}

enum Stage {
    Settled(CallStatus),
    /// `inspect` (or `assertCanAccrue` when `assert`) waiting on probe `probe`.
    Inspecting {
        pending: PendingInspect,
        probe: usize,
        assert: bool,
    },
    /// `requestScreenAccess` waiting on its own first probe.
    Requesting {
        probe: usize,
    },
}

#[derive(Serialize)]
struct LogLine {
    level: &'static str,
    message: &'static str,
    fields: VerdictLog,
}

#[derive(Serialize)]
struct Step {
    probes: usize,
    logs: Vec<LogLine>,
    calls: Vec<CallStatus>,
}

struct World {
    platform: String,
    screen_status: ScreenStatus,
    screen_health: CaptureHealth,
    accessibility: ActivityCaptureStatus,
    now: f64,
}

impl World {
    fn readings(&self) -> Readings {
        Readings {
            darwin: self.platform == "darwin",
            screen_status: self.screen_status,
            screen_health: self.screen_health,
            accessibility: self.accessibility.clone(),
        }
    }
}

fn rejected(
    message: &str,
    readiness: Option<TrackingReadiness>,
    code: Option<&'static str>,
) -> CallStatus {
    CallStatus::Rejected {
        rejected: Rejected {
            message: message.to_owned(),
            code,
            readiness,
        },
    }
}

/// How a finished inspection is reported: as the inspection, or (for
/// `assertCanAccrue`) as `undefined` or the blocked error.
fn settle(
    result: Result<ReadinessInspection, timo_core::js::iso::InvalidTimeValue>,
    assert: bool,
) -> CallStatus {
    match result {
        Err(e) => rejected(&e.to_string(), None, None),
        Ok(inspection) if assert => {
            match TrackingReadinessService::assert_can_accrue(&inspection) {
                Ok(()) => CallStatus::Value { value: None },
                Err(blocked) => rejected(
                    &TrackingBlockedError::to_string(&blocked),
                    Some(blocked.readiness),
                    Some(TrackingBlockedError::CODE),
                ),
            }
        }
        Ok(inspection) => CallStatus::Value {
            value: Some(inspection),
        },
    }
}

struct Rig {
    service: TrackingReadinessService,
    world: World,
    probes: Vec<bool>,
    calls: Vec<Stage>,
}

impl Rig {
    fn start_inspect(&mut self, verify: bool, assert: bool) -> Stage {
        let readings = self.world.readings();
        match self.service.begin_inspect(verify, readings, self.world.now) {
            Inspect::Done(result) => Stage::Settled(settle(result, assert)),
            Inspect::NeedsProbe(pending) => {
                self.probes.push(false);
                Stage::Inspecting {
                    pending,
                    probe: self.probes.len() - 1,
                    assert,
                }
            }
        }
    }

    fn resolve(&mut self, probe: usize, health: ProbeHealth) {
        match self.probes.get_mut(probe) {
            Some(settled) if !*settled => *settled = true,
            _ => return,
        }
        let Some(index) = self.calls.iter().position(|c| match c {
            Stage::Inspecting { probe: p, .. } | Stage::Requesting { probe: p } => *p == probe,
            Stage::Settled(_) => false,
        }) else {
            return;
        };
        let stage = std::mem::replace(
            &mut self.calls[index],
            Stage::Settled(CallStatus::Pending("pending")),
        );
        let next = match (stage, health.health()) {
            (_, None) => Stage::Settled(rejected("probe exploded", None, None)),
            (
                Stage::Inspecting {
                    pending, assert, ..
                },
                Some(h),
            ) => Stage::Settled(settle(
                self.service.finish_inspect(&pending, h, self.world.now),
                assert,
            )),
            (Stage::Requesting { .. }, Some(h)) => {
                self.service.note_requested_probe(h);
                self.start_inspect(true, false)
            }
            (settled @ Stage::Settled(_), _) => settled,
        };
        self.calls[index] = next;
    }

    fn statuses(&self) -> Vec<CallStatus> {
        self.calls
            .iter()
            .map(|c| match c {
                Stage::Settled(s) => clone_status(s),
                _ => CallStatus::Pending("pending"),
            })
            .collect()
    }
}

fn clone_status(s: &CallStatus) -> CallStatus {
    match s {
        CallStatus::Pending(p) => CallStatus::Pending(p),
        CallStatus::Value { value } => CallStatus::Value {
            value: value.clone(),
        },
        CallStatus::Rejected { rejected } => CallStatus::Rejected {
            rejected: Rejected {
                message: rejected.message.clone(),
                code: rejected.code,
                readiness: rejected.readiness.clone(),
            },
        },
    }
}

fn apply(rig: &mut Rig, event: Event) {
    match event {
        Event::Set {
            platform,
            screen_status,
            screen_health,
            accessibility,
            now,
        } => {
            if let Some(p) = platform {
                rig.world.platform = p;
            }
            if let Some(s) = screen_status {
                rig.world.screen_status = s;
            }
            if let Some(h) = screen_health {
                rig.world.screen_health = h;
            }
            if let Some(a) = accessibility {
                rig.world.accessibility = a;
            }
            if let Some(n) = now {
                rig.world.now = n;
            }
        }
        Event::Inspect { verify } => {
            let stage = rig.start_inspect(verify, false);
            rig.calls.push(stage);
        }
        Event::Assert => {
            let stage = rig.start_inspect(true, true);
            rig.calls.push(stage);
        }
        Event::RequestAccess => {
            rig.probes.push(false);
            rig.calls.push(Stage::Requesting {
                probe: rig.probes.len() - 1,
            });
        }
        Event::ResolveProbe { probe, health } => rig.resolve(probe, health),
        Event::NoteHealth { health } => rig.service.note_screen_health(health),
        Event::Invalidate => rig.service.invalidate_screen_probe(),
    }
}

fn run(input: Input) -> Vec<Step> {
    let mut rig = Rig {
        service: TrackingReadinessService::new(),
        world: World {
            platform: input.platform,
            screen_status: input.screen_status,
            screen_health: input.screen_health,
            accessibility: input.accessibility,
            now: input.now,
        },
        probes: Vec::new(),
        calls: Vec::new(),
    };
    let mut steps = Vec::new();
    for event in input.events {
        let before = rig.probes.len();
        apply(&mut rig, event);
        steps.push(Step {
            probes: rig.probes.len() - before,
            logs: rig
                .service
                .take_logs()
                .into_iter()
                .map(|fields| LogLine {
                    level: "warn",
                    message: "tracking readiness not ready",
                    fields,
                })
                .collect(),
            calls: rig.statuses(),
        });
    }
    steps
}

#[test]
fn fixture_service() {
    common::run("readiness", "service", "service", |i: Input| json(&run(i)));
}
