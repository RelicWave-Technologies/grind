//! The workspace business day: which zone, and what "today" is in it.
//!
//! Port of the pure part of `legacy/agent/src/main/services/workspaceTime.ts`
//! (SC-57). That file also reads and writes `workspace-time.json`, loads the
//! token and notifies listeners; those stay in the app crate. What is here is
//! the state and its decisions: [`WorkspaceTime::context_at`] (`contextAt`),
//! which cache may be restored, what a server value does, and what a session
//! change clears.

use serde::Serialize;
use thiserror::Error;

use crate::js::number::i64_to_f64;
use crate::tz::{TzError, date_key_in_time_zone, local_day_window_in_time_zone, parse_time_zone};

/// `WorkspaceTimeContext['source']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeSource {
    Server,
    Cache,
    Unavailable,
}

/// Port of `legacy/agent/src/shared/workspaceTime.ts::WorkspaceTimeContext`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTimeContext {
    pub ready: bool,
    pub time_zone: Option<String>,
    pub source: TimeSource,
    pub date: Option<String>,
    pub day_start: Option<f64>,
    pub day_end: Option<f64>,
}

/// Port of `PersistedWorkspaceTime`, the content of `workspace-time.json`.
/// Serializes as `JSON.stringify({ workspaceId, timeZone })`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspaceTime {
    pub workspace_id: String,
    pub time_zone: String,
}

/// What `applyServerWorkspaceTimeZone` throws for a value the schema rejects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ApplyError {
    #[error("invalid_timezone")]
    InvalidTimeZone,
}

/// The module-level state of `workspaceTime.ts`: `timeZone`, `source`, `workspaceId`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceTime {
    time_zone: Option<String>,
    source: TimeSource,
    workspace_id: Option<String>,
}

impl Default for WorkspaceTime {
    fn default() -> Self {
        Self::new()
    }
}

/// Port of `unavailableContext`.
#[must_use]
pub const fn unavailable_context() -> WorkspaceTimeContext {
    WorkspaceTimeContext {
        ready: false,
        time_zone: None,
        source: TimeSource::Unavailable,
        date: None,
        day_start: None,
        day_end: None,
    }
}

/// Port of `parsePersisted`. The caller extracts the two fields from the JSON
/// file and passes `None` for anything that is not a string (the TypeScript
/// treats a non-string `timeZone` as a schema failure and a non-string or empty
/// `workspaceId` as invalid). The zone is validated and trimmed by the schema.
#[must_use]
pub fn parse_persisted(
    workspace_id: Option<&str>,
    time_zone: Option<&str>,
) -> Option<PersistedWorkspaceTime> {
    let time_zone = parse_time_zone(time_zone?)?;
    let workspace_id = workspace_id.filter(|id| !id.is_empty())?;
    Some(PersistedWorkspaceTime {
        workspace_id: workspace_id.to_owned(),
        time_zone,
    })
}

impl WorkspaceTime {
    /// Boot state: nothing known (`timeZone = null`, `source = 'unavailable'`).
    #[must_use]
    pub const fn new() -> Self {
        Self {
            time_zone: None,
            source: TimeSource::Unavailable,
            workspace_id: None,
        }
    }

    /// Port of `getWorkspaceTimeZone`.
    #[must_use]
    pub fn time_zone(&self) -> Option<&str> {
        self.time_zone.as_deref()
    }

    /// Port of `contextAt`. Not ready without a zone, and not ready when the
    /// zone has no window that day (a midnight that does not exist). Throws,
    /// as the TypeScript does, when `now` is not a valid time.
    pub fn context_at(&self, now: f64) -> Result<WorkspaceTimeContext, TzError> {
        let Some(zone) = self.time_zone.as_deref() else {
            return Ok(unavailable_context());
        };
        let date = date_key_in_time_zone(now, zone)?;
        let Some(window) = local_day_window_in_time_zone(&date, zone) else {
            return Ok(unavailable_context());
        };
        Ok(WorkspaceTimeContext {
            ready: true,
            time_zone: Some(zone.to_owned()),
            source: self.source,
            date: Some(date),
            day_start: i64_to_f64(window.start).ok(),
            day_end: i64_to_f64(window.end).ok(),
        })
    }

    /// The memory half of `initializeWorkspaceTime`: remember the session's
    /// workspace, and restore the offline zone **only** if the cache belongs
    /// to that same workspace (a shared laptop must not inherit another
    /// workspace's business day).
    pub fn restore_from_cache(
        &mut self,
        token_workspace_id: &str,
        persisted: Option<&PersistedWorkspaceTime>,
    ) {
        self.workspace_id = Some(token_workspace_id.to_owned());
        if let Some(cached) = persisted.filter(|p| p.workspace_id == token_workspace_id) {
            self.time_zone = Some(cached.time_zone.clone());
            self.source = TimeSource::Cache;
        }
    }

    /// The memory half of `applyServerWorkspaceTimeZone`. Returns whether anything
    /// changed (the caller then notifies listeners).
    pub fn apply_server(
        &mut self,
        value: &str,
        expected_workspace_id: &str,
    ) -> Result<bool, ApplyError> {
        let parsed = parse_time_zone(value).ok_or(ApplyError::InvalidTimeZone)?;
        let changed = self.time_zone.as_deref() != Some(parsed.as_str())
            || self.source != TimeSource::Server
            || self.workspace_id.as_deref() != Some(expected_workspace_id);
        self.workspace_id = Some(expected_workspace_id.to_owned());
        self.time_zone = Some(parsed);
        self.source = TimeSource::Server;
        Ok(changed)
    }

    /// Port of `clearWorkspaceTimeSession`: drop the in-memory day at an auth
    /// boundary. Returns whether anything changed.
    pub fn clear(&mut self) -> bool {
        let changed = self.time_zone.is_some()
            || self.workspace_id.is_some()
            || self.source != TimeSource::Unavailable;
        *self = Self::new();
        changed
    }
}
