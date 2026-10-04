//! `AgentConfigResponse` (`GET /v1/agent/config`): the zod schema, as a validator.
//!
//! Port of `packages/types/src/agent.ts::AgentConfigResponse` with
//! `TodayLedgerMode`, `IdleWarningSecondsSchema` and
//! `teamSettings.ts::ScreenshotIntervalMinSchema`. It is **all or nothing**: one
//! invalid field fails the whole payload (the agent then keeps its previous
//! values). Defaults fill only a field that is *absent*; an explicit `null` is
//! a failure everywhere except `idleWarningSeconds`, which is nullable.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::tz::{DEFAULT_TIME_ZONE, parse_time_zone};

/// `TodayLedgerMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TodayLedgerMode {
    Off,
    Shadow,
    Visible,
}

/// The parsed response, in the key order zod writes (the schema's shape order).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigResponse {
    pub config_version: String,
    pub heartbeat_interval_sec: i64,
    pub screenshot_interval_min: i64,
    pub idle_threshold_min: i64,
    pub idle_warning_seconds: Option<i64>,
    pub capture_apps: bool,
    pub capture_titles: bool,
    pub capture_urls: bool,
    pub today_ledger_mode: TodayLedgerMode,
    pub dashboard_url: String,
    pub workspace_timezone: String,
}

/// `z.number().int().min(lo).max(hi)`: a JSON number that is an integer in range.
fn int_in(value: &Value, low: i64, high: i64) -> Option<i64> {
    let number = value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0)?;
    let int = crate::js::number::f64_to_i64(number).ok()?;
    (low..=high).contains(&int).then_some(int)
}

/// A field with a default: absent gives the default, present must validate.
fn with_default<T>(
    object: &Map<String, Value>,
    key: &str,
    default: T,
    parse: impl FnOnce(&Value) -> Option<T>,
) -> Option<T> {
    object.get(key).map_or(Some(default), parse)
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn mode(value: &Value) -> Option<TodayLedgerMode> {
    match value.as_str()? {
        "OFF" => Some(TodayLedgerMode::Off),
        "SHADOW" => Some(TodayLedgerMode::Shadow),
        "VISIBLE" => Some(TodayLedgerMode::Visible),
        _ => None,
    }
}

/// Port of `AgentConfigResponse.safeParse(raw).data`. `None` is `success: false`.
///
/// `raw` must be a JSON object (arrays, `null` and scalars fail). Unknown keys
/// are ignored. A number the JSON reader cannot represent (`1e400`) fails to
/// parse before it gets here; the TypeScript would read it as `Infinity`, which
/// fails the integer checks as well, except inside an unknown key.
#[must_use]
pub fn parse_agent_config_response(raw: &Value) -> Option<AgentConfigResponse> {
    let o = raw.as_object()?;
    let boolean = |key: &str| with_default(o, key, false, Value::as_bool);
    Some(AgentConfigResponse {
        config_version: with_default(o, "configVersion", String::new(), string)?,
        heartbeat_interval_sec: with_default(o, "heartbeatIntervalSec", 60, |v| {
            int_in(v, 15, 600)
        })?,
        // ScreenshotIntervalMinSchema: an integer, and one of 1, 2, 3.
        screenshot_interval_min: with_default(o, "screenshotIntervalMin", 3, |v| int_in(v, 1, 3))?,
        idle_threshold_min: with_default(o, "idleThresholdMin", 5, |v| int_in(v, 1, 120))?,
        idle_warning_seconds: with_default(o, "idleWarningSeconds", None, |v| {
            if v.is_null() {
                Some(None)
            } else {
                int_in(v, 5, 120).map(Some)
            }
        })?,
        capture_apps: boolean("captureApps")?,
        capture_titles: boolean("captureTitles")?,
        capture_urls: boolean("captureUrls")?,
        today_ledger_mode: with_default(o, "todayLedgerMode", TodayLedgerMode::Off, mode)?,
        dashboard_url: with_default(o, "dashboardUrl", String::new(), string)?,
        workspace_timezone: match o.get("workspaceTimezone") {
            None => parse_time_zone(DEFAULT_TIME_ZONE)?,
            Some(v) => parse_time_zone(v.as_str()?)?,
        },
    })
}
