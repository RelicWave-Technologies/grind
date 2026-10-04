//! Server-authoritative clock clamp (the "never trust the client clock" guard).
//!
//! The agent stamps timestamps with the LAPTOP's wall clock. A clock that runs
//! fast, is set forward, or is tampered with would otherwise inflate billed
//! hours. So before persisting any uploaded entry, the server clamps every
//! timestamp to its OWN clock: nothing may sit beyond `now + skew`.
//!
//! Why a ceiling (not a floor): a forward clock OVER-credits (the dangerous
//! direction), so we cap the future. A backward/slow client clock only
//! UNDER-credits, which is safe (we never invent time), so the past is left alone.
//!
//! `skew_ms` absorbs benign clock drift between the laptop and the server
//! (default 2 min) so honest users near the "now" boundary aren't trimmed.
//!
//! Pure + deterministic: `now_ms` is injected, no clock, no I/O.
//!
//! Port of `packages/core/src/clamp.ts`.

use serde::Serialize;

use crate::js::number::{add, max, number_to_string as fmt};
use crate::types::{Segment, TimeEntry};

/// Port of `packages/core/src/clamp.ts::ClampResult`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClampResult {
    pub entry: TimeEntry,
    /// True if any timestamp was pulled back to the ceiling.
    pub adjusted: bool,
    /// Per-field notes, for telemetry / abuse detection. Empty when clean.
    pub notes: Vec<String>,
}

/// Port of `packages/core/src/clamp.ts::DEFAULT_CLOCK_SKEW_MS`.
pub const DEFAULT_CLOCK_SKEW_MS: f64 = 120_000.0;

/// The `clampTs` closure of `clampEntryToServerClock`, with its `notes` list.
struct Clamper {
    ceiling: f64,
    notes: Vec<String>,
}

impl Clamper {
    fn clamp(&mut self, ts: f64, label: &str) -> f64 {
        if ts > self.ceiling {
            self.notes.push(format!(
                "{label} {} > ceiling {} (clamped)",
                fmt(ts),
                fmt(self.ceiling)
            ));
            return self.ceiling;
        }
        ts
    }

    fn clamp_segment(&mut self, s: &Segment) -> Option<Segment> {
        let started_at = self.clamp(s.started_at, &format!("seg[{}].startedAt", s.id));
        let ended_at = s
            .ended_at
            .map(|end| self.clamp(end, &format!("seg[{}].endedAt", s.id)));
        // A segment whose end clamped back to/under its start carries no real
        // worked time: drop it rather than persist a zero/negative span.
        if ended_at.is_some_and(|end| end <= started_at) {
            self.notes
                .push(format!("seg[{}] dropped (zero-length after clamp)", s.id));
            return None;
        }
        Some(Segment {
            started_at,
            ended_at,
            ..s.clone()
        })
    }
}

/// Clamp every timestamp of `entry` to `now_ms + max(0, skew_ms)`. `skew_ms`
/// `None` means [`DEFAULT_CLOCK_SKEW_MS`].
///
/// Port of `packages/core/src/clamp.ts::clampEntryToServerClock`. Quirks,
/// copied: a segment with `ended_at <= started_at` is dropped even when nothing
/// was clamped (and noted as "after clamp"); the entry's own `started_at` is not
/// moved to the first surviving segment.
#[must_use]
pub fn clamp_entry_to_server_clock(
    entry: &TimeEntry,
    now_ms: f64,
    skew_ms: Option<f64>,
) -> ClampResult {
    let skew_ms = skew_ms.unwrap_or(DEFAULT_CLOCK_SKEW_MS);
    let mut clamper = Clamper {
        ceiling: add(now_ms, max(0.0, skew_ms)),
        notes: Vec::new(),
    };
    let started_at = clamper.clamp(entry.started_at, "entry.startedAt");
    let ended_at = entry
        .ended_at
        .map(|end| clamper.clamp(end, "entry.endedAt"));
    let segments = entry
        .segments
        .iter()
        .filter_map(|s| clamper.clamp_segment(s))
        .collect();
    ClampResult {
        entry: TimeEntry {
            started_at,
            ended_at,
            segments,
            ..entry.clone()
        },
        adjusted: !clamper.notes.is_empty(),
        notes: clamper.notes,
    }
}
