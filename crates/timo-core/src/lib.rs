//! Pure tracking logic: no I/O, no clocks, no OS. Every function here is a
//! port of a named TypeScript function in `legacy/agent` or `packages/core`
//! and is held to it by golden fixtures dumped from the TypeScript itself.
//!
//! `packages/core` maps one TypeScript file to one module (`types`, `segments`
//! plus `segments_report`, `clamp`, `timer_ledger`, `today_ledger` plus
//! `today_ledger_intervals`); `js` holds the JavaScript semantics they lean on.
#![forbid(unsafe_code)]

pub mod activity;
pub mod agent_config;
pub mod agent_config_response;
pub mod capture;
pub mod clamp;
pub mod desktop_types;
pub mod error;
pub mod floating_bar_position;
pub mod floating_bar_visibility;
pub mod heartbeat_payload;
pub mod idle;
pub mod js;
pub mod launch_at_login;
pub mod move_to_applications;
pub mod placement;
pub mod prompt_reachability;
pub mod quit_cleanup;
pub mod segments;
pub mod segments_report;
pub mod shift;
pub mod timer;
pub mod timer_ledger;
pub mod today_ledger;
pub mod today_ledger_intervals;
pub mod tracking_attention;
pub mod tracking_readiness;
pub mod tray_presentation;
pub mod types;
pub mod tz;
pub mod updates_state;
pub mod workspace_time;

pub use clamp::{ClampResult, DEFAULT_CLOCK_SKEW_MS, clamp_entry_to_server_clock};
pub use error::CoreError;
pub use segments::{
    CreateArgs, IdleDiscardArgs, OpenSegmentArgs, apply_idle_discard, close_open_segment,
    close_time_entry, create_time_entry, get_open_segment, open_segment, recover_stale_entry,
};
pub use segments_report::{total_idle_trimmed_ms, total_worked_ms, validate_entry};
pub use timer_ledger::{
    CanonicalSegmentLike, CanonicalTimerEntryLike, Timestamp, canonical_timer_entry_payload,
    canonical_timer_entry_payload_with,
};
pub use today_ledger::{
    LedgerConflict, LedgerOrigin, LedgerProjectionEntry, LedgerSyncState, LocalLedgerEntry,
    ReconcileInput, ServerLedgerEntry, TodayLedgerProjection, reconcile_today_ledger,
};
pub use types::{
    AgentCloseReason, COUNTED_KINDS, Segment, SegmentKind, TimeEntry, TimeEntryCloseReason,
    TimeEntryPauseReason, TimeEntrySource,
};
