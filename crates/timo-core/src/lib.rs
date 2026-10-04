//! Pure tracking logic: no I/O, no clocks, no OS. Every function here is a
//! port of a named TypeScript function in `legacy/agent` or `packages/core`
//! and is held to it by golden fixtures dumped from the TypeScript itself.
//!
//! `packages/core` maps one TypeScript file to one module (`types`, `segments`
//! plus `segments_report`, `clamp`, `timer_ledger`, `today_ledger` plus
//! `today_ledger_intervals`); `js` holds the JavaScript semantics they lean on.
#![forbid(unsafe_code)]

pub mod clamp;
pub mod error;
pub mod js;
pub mod segments;
pub mod segments_report;
pub mod timer_ledger;
pub mod today_ledger;
pub mod today_ledger_intervals;
pub mod types;

pub use clamp::{ClampResult, DEFAULT_CLOCK_SKEW_MS, clamp_entry_to_server_clock};
pub use error::CoreError;
pub use segments::{
    CreateArgs, IdleDiscardArgs, OpenSegmentArgs, apply_idle_discard, close_open_segment,
    close_time_entry, create_time_entry, get_open_segment, open_segment, recover_stale_entry,
};
pub use segments_report::{total_idle_trimmed_ms, total_worked_ms, validate_entry};
pub use timer_ledger::{
    CanonicalSegmentLike, CanonicalTimerEntryLike, Timestamp, canonical_timer_entry_payload,
};
pub use today_ledger::{
    LedgerConflict, LedgerOrigin, LedgerProjectionEntry, LedgerSyncState, LocalLedgerEntry,
    ReconcileInput, ServerLedgerEntry, TodayLedgerProjection, reconcile_today_ledger,
};
pub use types::{
    AgentCloseReason, COUNTED_KINDS, Segment, SegmentKind, TimeEntry, TimeEntryCloseReason,
    TimeEntryPauseReason, TimeEntrySource,
};
