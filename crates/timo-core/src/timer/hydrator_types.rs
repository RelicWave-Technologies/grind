//! The reasons, dependencies and seams of the today-ledger hydrator.
//!
//! Port of the types at the top of
//! `legacy/agent/src/main/services/timer/todayLedgerHydrator.ts`.

use std::sync::Arc;

use futures_util::future::BoxFuture;

use super::dto::TodayLedgerResponse;
use super::error::TimerError;
use super::exec::{EngineLogger, Spawn, Timers};
use super::service::TodayLedgerDiagnostics;
use super::types::{DayWindow, EntryMatch, TimerOwner, TodayLedgerMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodayLedgerRefreshReason {
    Boot,
    Interval,
    Mutation,
    Wake,
    Manual,
    Auth,
    Config,
}

impl TodayLedgerRefreshReason {
    /// The TypeScript string literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Boot => "boot",
            Self::Interval => "interval",
            Self::Mutation => "mutation",
            Self::Wake => "wake",
            Self::Manual => "manual",
            Self::Auth => "auth",
            Self::Config => "config",
        }
    }
}

/// The two fields of `StoredTokens` the hydrator reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTokens {
    pub user_id: String,
    pub workspace_id: String,
}

/// The `TimerService` methods the hydrator calls.
pub trait HydratorTimer: Send + Sync {
    fn current_owner(&self) -> Option<TimerOwner>;
    fn flush_unsynced(&self) -> BoxFuture<'static, Result<bool, TimerError>>;
    fn claim_server_matched_entries(&self, matches: &[EntryMatch]) -> Result<usize, TimerError>;
    fn today_ledger_diagnostics(&self) -> Result<Option<TodayLedgerDiagnostics>, TimerError>;
}

/// `SqliteTodayLedgerStore.replaceSnapshot`, as the hydrator calls it.
pub trait HydratorCache: Send + Sync {
    fn replace_snapshot(
        &self,
        owner: &TimerOwner,
        window: DayWindow,
        response: &TodayLedgerResponse,
    ) -> Result<(), String>;
}

/// `HydratorDeps`.
#[allow(
    clippy::module_name_repetitions,
    reason = "mirrors the TypeScript interface name"
)]
pub struct HydratorDeps {
    pub timer: Arc<dyn HydratorTimer>,
    pub cache: Arc<dyn HydratorCache>,
    pub get_mode: Box<dyn Fn() -> TodayLedgerMode + Send + Sync>,
    pub load_tokens: Box<dyn Fn() -> BoxFuture<'static, Option<StoredTokens>> + Send + Sync>,
    pub get_window: Box<dyn Fn() -> Option<DayWindow> + Send + Sync>,
    pub fetch_snapshot:
        Box<dyn Fn(String) -> BoxFuture<'static, Result<serde_json::Value, String>> + Send + Sync>,
    pub on_updated: Box<dyn Fn() + Send + Sync>,
    pub log: Arc<dyn EngineLogger>,
    pub timers: Arc<dyn Timers>,
    pub spawner: Arc<dyn Spawn>,
}

impl std::fmt::Debug for HydratorDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HydratorDeps").finish_non_exhaustive()
    }
}
