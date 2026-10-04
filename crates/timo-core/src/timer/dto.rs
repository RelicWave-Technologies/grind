//! The server DTOs the timer engine reads, with the checks zod makes.
//!
//! Port of the parts of `packages/types/src/timeEntries.ts` the timer uses:
//! `TimeEntryDto`, `SegmentDto`, `TimerSyncReceipt` and `TodayLedgerResponse`.
//! Field order is the zod schema's, because `JSON.stringify` of a parsed object
//! follows it and the result is stored (`server_entry_cache.canonical_json`).
//! zod strips unknown keys; so does serde here.

use serde::{Deserialize, Deserializer, Serialize};

use crate::js::date::{DateParse, parse};
use crate::types::{SegmentKind, TimeEntrySource};

/// A `nullable()` zod field: the key must be present, its value may be `null`.
fn required<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// Port of `timeEntries.ts::SegmentDto`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentDto {
    pub id: String,
    pub kind: SegmentKind,
    pub started_at: String,
    #[serde(deserialize_with = "required")]
    pub ended_at: Option<String>,
}

/// The `closeReason` enum of `TimeEntryDto` (all five server reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DtoCloseReason {
    Agent,
    AgentRecovery,
    LeaseExpired,
    Superseded,
    LegacyReconciled,
}

/// Port of `timeEntries.ts::TimeEntryDto`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntryDto {
    pub id: String,
    pub client_uuid: String,
    pub user_id: String,
    #[serde(deserialize_with = "required")]
    pub lark_task_guid: Option<String>,
    pub source: TimeEntrySource,
    #[serde(deserialize_with = "required")]
    pub tracking_protocol_version: Option<f64>,
    #[serde(deserialize_with = "required")]
    pub revision: Option<f64>,
    #[serde(deserialize_with = "required")]
    pub last_proven_at: Option<String>,
    #[serde(deserialize_with = "required")]
    pub lease_expires_at: Option<String>,
    #[serde(deserialize_with = "required")]
    pub close_reason: Option<DtoCloseReason>,
    #[serde(deserialize_with = "required")]
    pub server_finalized_at: Option<String>,
    pub started_at: String,
    #[serde(deserialize_with = "required")]
    pub ended_at: Option<String>,
    #[serde(deserialize_with = "required")]
    pub notes: Option<String>,
    pub segments: Vec<SegmentDto>,
}

/// Port of `timeEntries.ts::TimerSyncDisposition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimerSyncDisposition {
    Applied,
    AlreadyApplied,
    Stale,
    Finalized,
    Conflict,
}

/// Port of `timeEntries.ts::TimerSyncCorrection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimerSyncCorrection {
    ClockClamp,
    LeaseFinalized,
    Superseded,
}

/// Port of `timeEntries.ts::TimerSyncReceipt`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerSyncReceipt {
    pub disposition: TimerSyncDisposition,
    pub accepted_revision: f64,
    pub canonical_hash: String,
    pub canonical_entry: TimeEntryDto,
    pub server_time: String,
    #[serde(deserialize_with = "required")]
    pub correction: Option<TimerSyncCorrection>,
}

/// One entry of `TodayLedgerResponse.effectiveEntries[].segments`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSegment {
    pub segment_id: String,
    #[serde(deserialize_with = "required")]
    pub ended_at: Option<String>,
}

/// One entry of `TodayLedgerResponse.effectiveEntries`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveEntry {
    pub entry_id: String,
    #[serde(deserialize_with = "required")]
    pub ended_at: Option<String>,
    pub segments: Vec<EffectiveSegment>,
}

/// Port of `timeEntries.ts::TodayLedgerResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayLedgerResponse {
    pub complete: bool,
    pub server_time: String,
    pub workspace_timezone: String,
    pub entries: Vec<TimeEntryDto>,
    #[serde(default)]
    pub approved_manual_entries: Option<Vec<TimeEntryDto>>,
    pub effective_entries: Vec<EffectiveEntry>,
}

/// Why a value is not a valid DTO (the zod message is not reproduced).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct DtoError(pub String);

fn invalid<T>(what: &str) -> Result<T, DtoError> {
    Err(DtoError(format!("invalid {what}")))
}

/// A cursor over the bytes of a string being matched against zod's regex.
struct Scan<'a>(&'a [u8]);

impl Scan<'_> {
    /// Exactly `n` ASCII digits, as a number.
    fn digits(&mut self, n: usize) -> Option<u32> {
        let (head, tail) = (self.0.get(..n)?, self.0.get(n..)?);
        if !head.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.0 = tail;
        Some(
            head.iter()
                .fold(0_u32, |acc, d| acc * 10 + u32::from(d - b'0')),
        )
    }

    fn eat(&mut self, byte: u8) -> Option<()> {
        self.0 = self.0.strip_prefix(&[byte])?;
        Some(())
    }

    fn peek_is(&self, byte: u8) -> bool {
        self.0.first() == Some(&byte)
    }
}

/// zod's `dateRegexSource`: `YYYY-MM-DD` with the month's length and leap years.
fn date_ok(year: u32, month: u32, day: u32) -> bool {
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let last = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    (1..=last).contains(&day)
}

/// The seconds part of zod's time regex: `:SS` with an optional `.f+`.
fn seconds_ok(scan: &mut Scan<'_>) -> Option<bool> {
    let seconds = scan.digits(2)?;
    if scan.peek_is(b'.') {
        scan.eat(b'.')?;
        let fraction = scan.0.iter().take_while(|c| c.is_ascii_digit()).count();
        if fraction == 0 {
            return Some(false);
        }
        scan.0 = scan.0.get(fraction..)?;
    }
    Some(seconds <= 59)
}

/// `Z` or `[+-]\d{2}:?\d{2}`.
fn offset_ok(rest: &[u8]) -> bool {
    match rest {
        b"Z" => true,
        [b'+' | b'-', tail @ ..] => match tail {
            [h1, h2, b':', m1, m2] | [h1, h2, m1, m2] => {
                [h1, h2, m1, m2].iter().all(|c| c.is_ascii_digit())
            }
            _ => false,
        },
        _ => false,
    }
}

/// `z.string().datetime({ offset: true })`.
#[must_use]
pub fn is_iso_datetime(text: &str) -> bool {
    fn go(text: &str) -> Option<bool> {
        let mut scan = Scan(text.as_bytes());
        let year = scan.digits(4)?;
        scan.eat(b'-')?;
        let month = scan.digits(2)?;
        scan.eat(b'-')?;
        let day = scan.digits(2)?;
        scan.eat(b'T')?;
        let hour = scan.digits(2)?;
        scan.eat(b':')?;
        let minute = scan.digits(2)?;
        let mut ok = hour <= 23 && minute <= 59 && date_ok(year, month, day);
        if scan.peek_is(b':') {
            scan.eat(b':')?;
            ok &= seconds_ok(&mut scan)?;
        }
        Some(ok && offset_ok(scan.0))
    }
    go(text).unwrap_or(false)
}

fn iso(value: &str, what: &str) -> Result<(), DtoError> {
    if is_iso_datetime(value) {
        Ok(())
    } else {
        invalid(what)
    }
}

fn iso_opt(value: Option<&String>, what: &str) -> Result<(), DtoError> {
    value.map_or(Ok(()), |v| iso(v, what))
}

fn whole(value: Option<f64>, min: f64, what: &str) -> Result<(), DtoError> {
    match value {
        Some(n) if !(n.is_finite() && n.fract() == 0.0 && n >= min) => invalid(what),
        _ => Ok(()),
    }
}

impl SegmentDto {
    /// The zod checks of `SegmentDto`.
    pub fn validate(&self) -> Result<(), DtoError> {
        if self.id.is_empty() {
            return invalid("segment id");
        }
        iso(&self.started_at, "segment startedAt")?;
        iso_opt(self.ended_at.as_ref(), "segment endedAt")
    }
}

impl TimeEntryDto {
    /// The zod checks of `TimeEntryDto` (`TimeEntryDto.parse`).
    pub fn validate(&self) -> Result<(), DtoError> {
        whole(
            self.tracking_protocol_version,
            f64::MIN,
            "trackingProtocolVersion",
        )?;
        whole(self.revision, 0.0, "revision")?;
        iso_opt(self.last_proven_at.as_ref(), "lastProvenAt")?;
        iso_opt(self.lease_expires_at.as_ref(), "leaseExpiresAt")?;
        iso_opt(self.server_finalized_at.as_ref(), "serverFinalizedAt")?;
        iso(&self.started_at, "startedAt")?;
        iso_opt(self.ended_at.as_ref(), "endedAt")?;
        self.segments.iter().try_for_each(SegmentDto::validate)
    }
}

impl TimerSyncReceipt {
    /// `TimerSyncReceipt.parse`'s checks.
    pub fn validate(&self) -> Result<(), DtoError> {
        whole(Some(self.accepted_revision), 0.0, "acceptedRevision")?;
        if self.canonical_hash.chars().count() != 64 {
            return invalid("canonicalHash");
        }
        iso(&self.server_time, "serverTime")?;
        self.canonical_entry.validate()
    }
}

impl TodayLedgerResponse {
    /// The zod checks of `TodayLedgerResponse`.
    pub fn validate(&self) -> Result<(), DtoError> {
        if !self.complete {
            return invalid("complete");
        }
        iso(&self.server_time, "serverTime")?;
        if self.workspace_timezone.is_empty() {
            return invalid("workspaceTimezone");
        }
        let manual = self.approved_manual_entries.as_deref().unwrap_or_default();
        if self.entries.len() > 2000 || manual.len() > 2000 || self.effective_entries.len() > 2000 {
            return invalid("list length");
        }
        self.entries
            .iter()
            .chain(manual)
            .try_for_each(TimeEntryDto::validate)?;
        for effective in &self.effective_entries {
            if effective.entry_id.is_empty() {
                return invalid("effective entryId");
            }
            iso_opt(effective.ended_at.as_ref(), "effective endedAt")?;
            for segment in &effective.segments {
                if segment.segment_id.is_empty() {
                    return invalid("effective segmentId");
                }
                iso_opt(segment.ended_at.as_ref(), "effective segment endedAt")?;
            }
        }
        Ok(())
    }
}

/// `new Date(iso).getTime()`: `NaN` for an Invalid Date; an error for a string
/// this port declines to parse (see `PARITY.md`).
pub fn iso_ms(text: &str) -> Result<f64, crate::error::CoreError> {
    match parse(text) {
        DateParse::Time(t) => Ok(t),
        DateParse::Invalid => Ok(f64::NAN),
        DateParse::Unsupported => Err(crate::error::CoreError::UnsupportedTimerTimestamp(
            text.to_owned(),
        )),
    }
}
