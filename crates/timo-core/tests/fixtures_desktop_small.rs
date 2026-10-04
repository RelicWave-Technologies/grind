//! Golden fixtures for the small desktop services, dumped from the real
//! TypeScript by `parity/src/gen/desktopSmall.ts`.
#![cfg(test)]

mod common;

use serde::{Deserialize, Serialize};
use std::task::{Context, Poll, Waker};
use timo_core::desktop_types::{
    DesktopPermissionSnapshot, LaunchAtLoginSnapshot, Platform, TimerStatus,
};
use timo_core::floating_bar_position::{default_corner, is_visible_enough, resolve_position};
use timo_core::floating_bar_visibility::FloatingBarVisibilityPolicy;
use timo_core::heartbeat_payload::{
    HeartbeatArgs, agent_state_from_timer, build_heartbeat_request, current_platform,
};
use timo_core::js::ser::to_string;
use timo_core::move_to_applications::{MoveThrew, MoveToApplicationsDeps, move_to_applications};
use timo_core::placement::{
    BOTTOM_RIGHT_GUTTER, Point, Rect, Size, TOP_RIGHT_GUTTER, TRAY_POPOVER_GUTTER, bottom_right,
    center, top_right, tray_popover_point,
};
use timo_core::tray_presentation::{tray_menu_title_for_elapsed, tray_tooltip_for_elapsed};

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

// --- tray -------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayIn {
    elapsed_text: Option<String>,
    has_icon: Option<bool>,
}

#[derive(Serialize)]
struct Tray {
    title: String,
    tooltip: String,
}

#[test]
fn fixture_tray_presentation() {
    common::run(
        "desktop",
        "tray_presentation",
        "trayPresentation",
        |i: TrayIn| {
            json(&Tray {
                title: tray_menu_title_for_elapsed(i.elapsed_text.as_deref(), i.has_icon),
                tooltip: tray_tooltip_for_elapsed(i.elapsed_text.as_deref()),
            })
        },
    );
}

// --- floating bar visibility ---------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum VisEvent {
    #[serde(rename_all = "camelCase")]
    Sync {
        entry_id: Option<String>,
        pref: bool,
    },
    Dismiss,
    Pref {
        visible: bool,
    },
}

#[derive(Deserialize)]
struct VisIn {
    events: Vec<VisEvent>,
}

#[test]
fn fixture_floating_bar_visibility() {
    common::run(
        "desktop",
        "floating_bar_visibility",
        "floatingBarVisibility",
        |i: VisIn| {
            let mut policy = FloatingBarVisibilityPolicy::new();
            let out: Vec<bool> = i
                .events
                .iter()
                .map(|e| match e {
                    VisEvent::Sync { entry_id, pref } => {
                        policy.sync_timer(entry_id.as_deref(), *pref)
                    }
                    VisEvent::Dismiss => policy.dismiss_current(),
                    VisEvent::Pref { visible } => policy.set_preference_visible(*visible),
                })
                .collect();
            json(&out)
        },
    );
}

// --- heartbeat payload ------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HbIn {
    agent_version: String,
    platform: Platform,
    timer_status: TimerStatus,
    permissions: Option<DesktopPermissionSnapshot>,
    startup: Option<LaunchAtLoginSnapshot>,
    observed_at: Option<f64>,
    device_now: f64,
}

#[test]
fn fixture_build_heartbeat_request() {
    common::run(
        "desktop",
        "build_heartbeat_request",
        "buildHeartbeatRequest",
        |i: HbIn| {
            build_heartbeat_request(&HeartbeatArgs {
                agent_version: &i.agent_version,
                platform: i.platform,
                timer_status: &i.timer_status,
                permissions: i.permissions,
                startup: i.startup,
                observed_at: i.observed_at,
                device_now: i.device_now,
            })
            .map_err(|e| e.to_string())
            .and_then(|r| json(&r))
        },
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusIn {
    timer_status: TimerStatus,
}

#[test]
fn fixture_agent_state_from_timer() {
    common::run(
        "desktop",
        "agent_state_from_timer",
        "agentStateFromTimer",
        |i: StatusIn| json(&agent_state_from_timer(&i.timer_status)),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlatformIn {
    node_platform: String,
}

#[test]
fn fixture_current_platform() {
    common::run(
        "desktop",
        "current_platform",
        "currentPlatform",
        |i: PlatformIn| json(&current_platform(&i.node_platform)),
    );
}

// --- moveToApplications ----------------------------------------------------------------

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MoveHow {
    True,
    False,
    Throws,
}

#[derive(Deserialize)]
struct MoveIn {
    tracking: bool,
    confirm: bool,
    #[serde(rename = "move")]
    how: MoveHow,
}

#[derive(Serialize)]
struct MoveOut {
    result: timo_core::move_to_applications::MoveToApplicationsResult,
    calls: Vec<&'static str>,
}

struct Deps {
    input: MoveIn,
    calls: Vec<&'static str>,
}

impl MoveToApplicationsDeps for Deps {
    fn is_tracking(&mut self) -> bool {
        self.calls.push("isTracking");
        self.input.tracking
    }
    async fn confirm(&mut self) -> bool {
        self.calls.push("confirm");
        self.input.confirm
    }
    async fn cleanup(&mut self) {
        self.calls.push("cleanup");
    }
    fn move_app(&mut self) -> Result<bool, MoveThrew> {
        self.calls.push("move");
        match self.input.how {
            MoveHow::True => Ok(true),
            MoveHow::False => Ok(false),
            MoveHow::Throws => Err(MoveThrew),
        }
    }
    fn invalidate_cleanup(&mut self) {
        self.calls.push("invalidateCleanup");
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
    }
}

#[test]
fn fixture_move_to_applications() {
    common::run(
        "desktop",
        "move_to_applications",
        "moveToApplications",
        |i: MoveIn| {
            let mut deps = Deps {
                input: i,
                calls: Vec::new(),
            };
            let result = block_on(move_to_applications(&mut deps));
            json(&MoveOut {
                result,
                calls: deps.calls,
            })
        },
    );
}

// --- floating bar position --------------------------------------------------------------

#[derive(Deserialize)]
struct CornerIn {
    primary: Rect,
    size: Size,
}

#[test]
fn fixture_default_corner() {
    common::run(
        "desktop",
        "default_corner",
        "defaultCorner",
        |i: CornerIn| json(&default_corner(i.primary, i.size)),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisibleIn {
    pos: Point,
    size: Size,
    work_areas: Vec<Rect>,
}

#[test]
fn fixture_is_visible_enough() {
    common::run(
        "desktop",
        "is_visible_enough",
        "isVisibleEnough",
        |i: VisibleIn| json(&is_visible_enough(i.pos, i.size, &i.work_areas)),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveIn {
    saved: Option<Point>,
    size: Size,
    primary: Rect,
    work_areas: Vec<Rect>,
}

#[test]
fn fixture_resolve_position() {
    common::run(
        "desktop",
        "resolve_position",
        "resolvePosition",
        |i: ResolveIn| json(&resolve_position(i.saved, i.size, i.primary, &i.work_areas)),
    );
}

// --- overlay placement --------------------------------------------------------------------

#[derive(Deserialize)]
struct PlaceIn {
    tray: Rect,
    wa: Rect,
    size: Size,
    gutter: Option<f64>,
}

#[test]
fn fixture_center() {
    common::run("desktop", "center", "center", |i: PlaceIn| {
        json(&center(i.wa, i.size))
    });
}

#[test]
fn fixture_top_right() {
    common::run("desktop", "top_right", "topRight", |i: PlaceIn| {
        json(&top_right(
            i.wa,
            i.size,
            i.gutter.unwrap_or(TOP_RIGHT_GUTTER),
        ))
    });
}

#[test]
fn fixture_bottom_right() {
    common::run("desktop", "bottom_right", "bottomRight", |i: PlaceIn| {
        json(&bottom_right(
            i.wa,
            i.size,
            i.gutter.unwrap_or(BOTTOM_RIGHT_GUTTER),
        ))
    });
}

#[test]
fn fixture_tray_popover_point() {
    common::run(
        "desktop",
        "tray_popover_point",
        "trayPopoverPoint",
        |i: PlaceIn| {
            json(&tray_popover_point(
                i.tray,
                i.wa,
                i.size,
                i.gutter.unwrap_or(TRAY_POPOVER_GUTTER),
            ))
        },
    );
}
