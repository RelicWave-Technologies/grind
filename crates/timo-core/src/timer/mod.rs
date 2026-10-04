//! The timer engine: the local entry journal, sync and the today ledger.
//!
//! Port of `legacy/agent/src/main/services/timer/` (types, `timerService`,
//! `syncDrain`, `todayLedgerHydrator`, the request bodies of `syncClient`) and
//! `legacy/agent/src/main/services/serverClock.ts`. The TypeScript's yield
//! points are explicit: see `CONCURRENCY.md`.

pub mod boundary;
pub mod defaults;
pub mod drain;
pub mod dto;
pub mod error;
pub mod exec;
pub mod executor;
pub mod hash;
pub mod hydrator;
mod hydrator_types;
mod ledger_memo;
pub mod runtime;
mod runtime_sync;
pub mod server_clock;
pub mod service;
mod service_commands;
mod service_recovery;
mod service_status;
mod service_sync;
pub mod sync_payload;
pub mod traits;
pub mod types;

pub use defaults::{EmptyServerCache, UtcDayProvider};
pub use error::{GuardError, SyncError, TimerError};
pub use runtime::{FLUSH_BATCH_LIMIT, TimerRuntime};
pub use service::{SyncJob, TimerService, TodayLedgerDiagnostics};
