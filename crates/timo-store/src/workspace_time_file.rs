//! `workspace-time.json`: the offline copy of the workspace's time zone.
//!
//! Port of the file-backed part of `legacy/agent/src/main/services/workspaceTime.ts`
//! (`parsePersisted` and the read and write around it). The session logic, the
//! listeners and the business-day maths live elsewhere. The cache is restored
//! only when it belongs to the workspace of the stored session (the caller
//! compares `workspace_id`), so a shared laptop never inherits the previous
//! workspace's business day.

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use timo_core::js::ser::to_string;

use crate::atomic_write::write_atomic;
use crate::file_error::FileStoreError;
use crate::row_value::is_js_whitespace;

/// Port of `PersistedWorkspaceTime`. Declaration order is the key order `JSON.stringify` writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspaceTime {
    pub workspace_id: String,
    pub time_zone: String,
}

/// The longest time-zone string `TimeZoneSchema` accepts, in UTF-16 code units.
const MAX_TIME_ZONE_LEN: usize = 80;

/// `TimeZoneSchema.safeParse(value)`: `z.string().trim().min(1).max(80).refine(isValidTimeZone)`.
/// The refinement is `is_valid_time_zone`, which lives with the time-zone code and runs
/// on the trimmed string. Returns the trimmed string.
fn parse_time_zone(
    value: Option<&Value>,
    is_valid_time_zone: &impl Fn(&str) -> bool,
) -> Option<String> {
    let trimmed = value?.as_str()?.trim_matches(is_js_whitespace);
    let len = trimmed.encode_utf16().count();
    ((1..=MAX_TIME_ZONE_LEN).contains(&len) && is_valid_time_zone(trimmed))
        .then(|| trimmed.to_owned())
}

/// Port of `legacy/agent/src/main/services/workspaceTime.ts::parsePersisted`.
#[must_use]
pub fn parse_persisted(
    raw: &Value,
    is_valid_time_zone: impl Fn(&str) -> bool,
) -> Option<PersistedWorkspaceTime> {
    let candidate = raw.as_object()?;
    let time_zone = parse_time_zone(candidate.get("timeZone"), &is_valid_time_zone)?;
    let workspace_id = candidate
        .get("workspaceId")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    Some(PersistedWorkspaceTime {
        workspace_id: workspace_id.to_owned(),
        time_zone,
    })
}

/// `parsePersisted(JSON.parse(await fs.readFile(cachePath(), 'utf8')))`, with the
/// TypeScript's `throw new Error('invalid_workspace_time_cache')` for a file that parses
/// but is not a cache. A missing file is [`FileStoreError::is_not_found`] (not worth a
/// warning); any other failure is for the caller to log, and means "wait for the server".
pub fn read_persisted(
    path: &Path,
    is_valid_time_zone: impl Fn(&str) -> bool,
) -> Result<PersistedWorkspaceTime, FileStoreError> {
    let bytes = fs::read(path)?;
    let raw: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes))?;
    parse_persisted(&raw, is_valid_time_zone).ok_or(FileStoreError::InvalidWorkspaceTimeCache)
}

/// `JSON.stringify({ workspaceId, timeZone })`.
pub fn serialize_persisted(persisted: &PersistedWorkspaceTime) -> Result<String, FileStoreError> {
    Ok(to_string(persisted)?)
}

/// The atomic write in `applyServerWorkspaceTimeZone`: temp file (mode `0600`) + rename.
pub fn write_persisted(
    path: &Path,
    persisted: &PersistedWorkspaceTime,
) -> Result<(), FileStoreError> {
    write_atomic(path, serialize_persisted(persisted)?.as_bytes())?;
    Ok(())
}
