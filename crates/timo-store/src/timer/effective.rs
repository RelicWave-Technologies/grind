//! Effective ends of server rows and their validation.
//!
//! Port of `toEffectiveCoreEntry`, `fallbackEffectiveEntry`,
//! `parseEffectiveEntry` and `validateEffectiveEntries` of `todayLedgerStore.ts`.
//! Every timestamp is read with `new Date(iso).getTime()`.

use std::collections::{HashMap, HashSet};

use timo_core::js::number::{max, min, strict_eq};
use timo_core::timer::TimerError;
use timo_core::timer::dto::{
    DtoCloseReason, EffectiveEntry, EffectiveSegment, TimeEntryDto, iso_ms,
};
use timo_core::types::{AgentCloseReason, Segment, TimeEntry};

fn err(message: &str) -> TimerError {
    TimerError::Store(message.to_owned())
}

fn ms(text: &str) -> Result<f64, TimerError> {
    Ok(iso_ms(text)?)
}

fn ms_opt(text: Option<&String>) -> Result<Option<f64>, TimerError> {
    text.map(|t| ms(t)).transpose()
}

/// Port of `fallbackEffectiveEntry`.
#[must_use]
pub fn fallback_effective_entry(entry: &TimeEntryDto) -> EffectiveEntry {
    EffectiveEntry {
        entry_id: entry.id.clone(),
        ended_at: entry.ended_at.clone(),
        segments: entry
            .segments
            .iter()
            .map(|s| EffectiveSegment {
                segment_id: s.id.clone(),
                ended_at: s.ended_at.clone(),
            })
            .collect(),
    }
}

/// The `segments` of `toEffectiveCoreEntry`: a stored end wins, then the
/// effective end (tested for truthiness), then the lease-expired end.
fn effective_segments(
    entry: &TimeEntryDto,
    effective: &EffectiveEntry,
    lease_expired_end: Option<f64>,
) -> Result<Vec<Segment>, TimerError> {
    let segment_ends: HashMap<&str, Option<&String>> = effective
        .segments
        .iter()
        .map(|s| (s.segment_id.as_str(), s.ended_at.as_ref()))
        .collect();
    let mut segments = Vec::with_capacity(entry.segments.len());
    for segment in &entry.segments {
        let ended_at = if let Some(end) = &segment.ended_at {
            Some(ms(end)?)
        } else {
            match segment_ends.get(segment.id.as_str()).copied().flatten() {
                Some(end) if !end.is_empty() => Some(ms(end)?),
                _ => lease_expired_end,
            }
        };
        segments.push(Segment {
            id: segment.id.clone(),
            kind: segment.kind,
            started_at: ms(&segment.started_at)?,
            ended_at,
        });
    }
    Ok(segments)
}

/// Port of `toEffectiveCoreEntry`: a server row's effective end is a function of
/// the injected `now` (a lapsed lease closes it at `lastProvenAt`).
pub fn to_effective_core_entry(
    entry: &TimeEntryDto,
    effective: &EffectiveEntry,
    now: f64,
) -> Result<TimeEntry, TimerError> {
    let started_at = ms(&entry.started_at)?;
    let stored_ended_at = ms_opt(entry.ended_at.as_ref())?;
    let effective_ended_at = ms_opt(effective.ended_at.as_ref())?;
    let lease_expires_at = ms_opt(entry.lease_expires_at.as_ref())?;
    let last_proven_at = ms_opt(entry.last_proven_at.as_ref())?;
    let lease_expired_end = match lease_expires_at {
        Some(lease)
            if entry.ended_at.is_none()
                && entry
                    .tracking_protocol_version
                    .is_some_and(|v| strict_eq(v, 2.0))
                && lease <= now =>
        {
            Some(max(
                started_at,
                min(now, last_proven_at.unwrap_or(started_at)),
            ))
        }
        _ => None,
    };
    let ended_at = stored_ended_at.or(effective_ended_at).or(lease_expired_end);
    let segments = effective_segments(entry, effective, lease_expired_end)?;
    Ok(TimeEntry {
        id: entry.id.clone(),
        client_uuid: entry.client_uuid.clone(),
        user_id: entry.user_id.clone(),
        lark_task_guid: Some(entry.lark_task_guid.clone()),
        source: entry.source,
        revision: entry.revision.unwrap_or(0.0),
        started_at,
        ended_at,
        pause_reason: None,
        close_reason: ended_at.map(|_| match entry.close_reason {
            Some(DtoCloseReason::AgentRecovery) => AgentCloseReason::AgentRecovery,
            _ => AgentCloseReason::Agent,
        }),
        segments,
        shape: timo_core::types::EntryShape::default(),
    })
}

/// Port of `validateEffectiveEntries`: one effective entry per entry, with
/// matching segment sets and no negative lengths.
pub fn validate_effective_entries<'a>(
    entries: &[TimeEntryDto],
    effective_entries: &'a [EffectiveEntry],
) -> Result<HashMap<&'a str, &'a EffectiveEntry>, TimerError> {
    if effective_entries.len() != entries.len() {
        return Err(err("incomplete_today_ledger_effective_entries"));
    }
    let mut by_id: HashMap<&str, &EffectiveEntry> = HashMap::new();
    for effective in effective_entries {
        if by_id
            .insert(effective.entry_id.as_str(), effective)
            .is_some()
        {
            return Err(err("duplicate_today_ledger_effective_entry"));
        }
    }
    for entry in entries {
        let effective = by_id
            .get(entry.id.as_str())
            .ok_or_else(|| err("missing_today_ledger_effective_entry"))?;
        check_one(entry, effective)?;
    }
    Ok(by_id)
}

fn check_one(entry: &TimeEntryDto, effective: &EffectiveEntry) -> Result<(), TimerError> {
    let entry_start = ms(&entry.started_at)?;
    if let Some(end) = ms_opt(effective.ended_at.as_ref())?
        && end < entry_start
    {
        return Err(err("invalid_today_ledger_effective_entry_end"));
    }
    let expected: HashSet<&str> = entry.segments.iter().map(|s| s.id.as_str()).collect();
    let actual: HashSet<&str> = effective
        .segments
        .iter()
        .map(|s| s.segment_id.as_str())
        .collect();
    if actual.len() != effective.segments.len() || actual.len() != expected.len() {
        return Err(err("invalid_today_ledger_effective_segments"));
    }
    if actual.iter().any(|id| !expected.contains(id)) {
        return Err(err("foreign_today_ledger_effective_segment"));
    }
    let starts: HashMap<&str, f64> = entry
        .segments
        .iter()
        .map(|s| Ok((s.id.as_str(), ms(&s.started_at)?)))
        .collect::<Result<_, TimerError>>()?;
    for segment in &effective.segments {
        let end = ms_opt(segment.ended_at.as_ref())?;
        let start = starts
            .get(segment.segment_id.as_str())
            .copied()
            .unwrap_or(f64::NAN);
        if end.is_some_and(|end| end < start) {
            return Err(err("invalid_today_ledger_effective_segment_end"));
        }
    }
    Ok(())
}

/// Port of `parseEffectiveEntry`: a cached effective entry must be well formed
/// and pass `validateEffectiveEntries` against its entry.
pub fn parse_effective_entry(
    json: &str,
    entry: &TimeEntryDto,
) -> Result<EffectiveEntry, TimerError> {
    let parsed: EffectiveEntry = serde_json::from_str(json)
        .map_err(|_| err("invalid_cached_today_ledger_effective_entry"))?;
    if parsed.entry_id != entry.id {
        return Err(err("invalid_cached_today_ledger_effective_entry"));
    }
    validate_effective_entries(std::slice::from_ref(entry), std::slice::from_ref(&parsed))?;
    Ok(parsed)
}
